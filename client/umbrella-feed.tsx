import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { umbrellaEntryKinds, type Actor, type UmbrellaEntry } from "../shared/model";
import { msg, t } from "../shared/i18n";
import { umbrellaLimits } from "../shared/umbrella";
import { changedLines, feedRows, openQuestions, pendingChanges } from "./umbrella-panel-logic";
import { Disclosure } from "./disclosure";
import { SessionMarkdown } from "./session-content";
import { Actions, Button, Choices, Field, Label, Notice, font, radius, relativeTime, space, touch, useTheme } from "./ui";

/** The umbrella panel's feed and open questions (UMBRELLA-SPEC §7), and the part titles the panel shares. */
type Kind = UmbrellaEntry["kind"];

const kindText: Record<Kind, string> = {
  decision: msg("Decision"),
  ruling: msg("Ruling"),
  finding: msg("Finding"),
  convention: msg("Convention"),
  pitfall: msg("Pitfall"),
  question: msg("Question"),
  contract_change: msg("Contract change"),
};
const statusText: Partial<Record<UmbrellaEntry["status"], string>> = {
  superseded: msg("Superseded"),
  answered: msg("Answered"),
  proposed: msg("Proposed"),
  accepted: msg("Accepted"),
  rejected: msg("Rejected"),
  withdrawn: msg("Withdrawn"),
};

export function PartTitle({ title, count, trailing }: { title: string; count?: number; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minHeight: touch ? 36 : 28 }}>
      <Label bold size={font.md} selectable={false}>
        {title}
      </Label>
      {count !== undefined && (
        <Label muted size={font.md} selectable={false}>
          {count}
        </Label>
      )}
      <View style={{ flex: 1 }} />
      {trailing}
    </View>
  );
}

const actorName = (by: Actor, source: string) => (by.kind === "human" ? t("you") : by.kind === "dispatcher" ? t("dispatcher") : source || t("an agent"));

export function Questions({ entries, writable, sourceOf, onAnswer }: {
  entries: readonly UmbrellaEntry[];
  writable: boolean;
  sourceOf(taskId: string | undefined): string;
  onAnswer(id: string, text: string): Promise<boolean>;
}) {
  const open = useMemo(() => openQuestions(entries), [entries]);
  if (!open.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <PartTitle title={t("Open questions")} count={open.length} />
      {open.map((e) => (
        <QuestionRow key={e.id} entry={e} source={sourceOf(e.sourceTaskId)} writable={writable} onAnswer={onAnswer} />
      ))}
    </View>
  );
}

const QuestionRow = memo(function QuestionRow({ entry, source, writable, onAnswer }: { entry: UmbrellaEntry; source: string; writable: boolean; onAnswer(id: string, text: string): Promise<boolean> }) {
  const { colors } = useTheme();
  // Cleared after a sent answer: TextBox shows an outside change of its value.
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const answer = text.trim();
    if (!answer || sending) return;
    setSending(true);
    const ok = await onAnswer(entry.id, answer);
    setSending(false);
    if (ok) setText("");
  };
  return (
    <View style={{ gap: space[1.5], padding: space[2], borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg }}>
      <Label medium size={font.md}>
        {entry.title}
      </Label>
      {!!entry.body && <Label size={font.sm}>{entry.body}</Label>}
      <Label muted size={font.xs}>
        {t("Asked by {who} {time}", { who: actorName(entry.by, source), time: relativeTime(entry.createdAt) })}
      </Label>
      {writable && (
        <>
          <Field title={t("Answer")} value={text} onChange={setText} multiline maxLength={umbrellaLimits.entryBody} />
          <Actions>
            <Button small primary disabled={sending || !text.trim()} onPress={() => void send()}>
              {t("Answer")}
            </Button>
          </Actions>
        </>
      )}
    </View>
  );
});

/** What accepting or rejecting a contract change came to; `stale`: the accept was refused CONTRACT_STALE (D20). */
export type ResolveOutcome = { ok: true } | { ok: false; message: string; stale: boolean };

/**
 * Pending contract changes (UMBRELLA-SPEC §5): each with its reason, a conflict mark, the lines it changes and the full
 * before and after texts, and Accept / Reject (with an optional note that goes back to the proposing card, D19). An
 * accept refused as stale shows why and opens Reject.
 */
export function ContractChanges({ entries, writable, sourceOf, onResolve }: {
  entries: readonly UmbrellaEntry[];
  writable: boolean;
  sourceOf(taskId: string | undefined): string;
  onResolve(id: string, decision: "accepted" | "rejected", note?: string): Promise<ResolveOutcome>;
}) {
  const pending = useMemo(() => pendingChanges(entries), [entries]);
  if (!pending.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <PartTitle title={t("Contract changes")} count={pending.length} />
      {pending.map((e) => (
        <ChangeRow key={e.id} entry={e} source={sourceOf(e.sourceTaskId)} writable={writable} onResolve={onResolve} />
      ))}
    </View>
  );
}

const ChangeRow = memo(function ChangeRow({ entry, source, writable, onResolve }: {
  entry: UmbrellaEntry;
  source: string;
  writable: boolean;
  onResolve(id: string, decision: "accepted" | "rejected", note?: string): Promise<ResolveOutcome>;
}) {
  const { colors } = useTheme();
  const change = entry.change!;
  const lines = useMemo(() => changedLines(change.before, change.after), [change.before, change.after]);
  const [full, setFull] = useState(false);
  // null: the buttons; a string: the reject form with its note.
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const resolve = async (decision: "accepted" | "rejected") => {
    if (sending) return;
    setSending(true);
    setError("");
    const outcome = await onResolve(entry.id, decision, decision === "rejected" ? note?.trim() || undefined : undefined);
    setSending(false);
    if (outcome.ok) return;
    setError(outcome.message);
    if (outcome.stale) setNote((n) => n ?? "");
  };
  return (
    <View style={{ gap: space[1.5], padding: space[2], borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg }}>
      <Label medium size={font.md}>
        {entry.title}
      </Label>
      {entry.body.trim() !== entry.title.trim() && <Label size={font.sm}>{entry.body}</Label>}
      <Label muted size={font.xs}>
        {t("Proposed by {who} {time} · on revision {n}", { who: actorName(entry.by, source), time: relativeTime(entry.createdAt), n: change.baseRevision })}
      </Label>
      {!!change.conflict && (
        <Label size={font.sm} color={colors.statusWarning}>
          {t("Conflicts with another pending change or a newer contract.")}
        </Label>
      )}
      {(lines.removed.length > 0 || lines.added.length > 0) && (
        <View style={{ gap: 2 }}>
          {lines.removed.map((line, i) => (
            <Label key={`r${i}`} mono size={font.sm} color={colors.statusDanger}>
              {`− ${line}`}
            </Label>
          ))}
          {lines.added.map((line, i) => (
            <Label key={`a${i}`} mono size={font.sm} color={colors.statusSuccess}>
              {`+ ${line}`}
            </Label>
          ))}
        </View>
      )}
      <Disclosure title={t("Before and after")} open={full} onChange={setFull} flush>
        <View style={{ gap: space[2] }}>
          <View style={{ gap: space[1] }}>
            <Label muted size={font.xs}>{t("Before")}</Label>
            {change.before.trim() ? <SessionMarkdown text={change.before} /> : <Label muted size={font.sm}>{t("No contract yet.")}</Label>}
          </View>
          <View style={{ gap: space[1] }}>
            <Label muted size={font.xs}>{t("After")}</Label>
            <SessionMarkdown text={change.after} />
          </View>
        </View>
      </Disclosure>
      {!!error && <Notice tone="warning">{error}</Notice>}
      {writable &&
        (note === null ? (
          <Actions>
            <Button small quiet disabled={sending} label={t("Reject the change {title}", { title: entry.title })} onPress={() => setNote("")}>
              {t("Reject")}
            </Button>
            <Button small primary disabled={sending} label={t("Accept the change {title}", { title: entry.title })} onPress={() => void resolve("accepted")}>
              {t("Accept")}
            </Button>
          </Actions>
        ) : (
          <>
            <Field title={t("Note (optional)")} value={note} onChange={setNote} multiline maxLength={umbrellaLimits.entryBody} />
            <Actions>
              <Button small quiet disabled={sending} onPress={() => setNote(null)}>
                {t("Cancel")}
              </Button>
              <Button small danger disabled={sending} onPress={() => void resolve("rejected")}>
                {t("Reject")}
              </Button>
            </Actions>
          </>
        ))}
    </View>
  );
});

const kindOptions = ():{ value: Kind | "all"; label: string }[] => [{ value: "all", label: t("All") }, ...umbrellaEntryKinds.map((k) => ({ value: k, label: t(kindText[k]) }))];

export function Feed({ entries, writable, sourceOf, onSupersede }: {
  entries: readonly UmbrellaEntry[];
  writable: boolean;
  sourceOf(taskId: string | undefined): string;
  onSupersede(id: string): Promise<boolean>;
}) {
  const [kind, setKind] = useState<Kind | "all">("all");
  const [closed, setClosed] = useState(false);
  const rows = useMemo(() => feedRows(entries, kind, { closed }), [entries, kind, closed]);
  const hidden = useMemo(() => feedRows(entries, kind, { closed: true }).length - feedRows(entries, kind).length, [entries, kind]);
  return (
    <View style={{ gap: space[2] }}>
      <PartTitle title={t("Feed")} count={feedRows(entries, "all").length} />
      <Choices title={t("Kind")} hideTitle value={kind} options={kindOptions()} onChange={setKind} />
      {rows.length === 0 ? (
        <Label muted size={font.sm}>
          {t("Nothing in the feed yet.")}
        </Label>
      ) : (
        rows.map((e) => <FeedRow key={e.id} entry={e} source={sourceOf(e.sourceTaskId)} writable={writable} onSupersede={onSupersede} />)
      )}
      {(hidden > 0 || closed) && (
        <View style={{ flexDirection: "row" }}>
          <Button small quiet onPress={() => setClosed(!closed)}>
            {closed ? t("Hide superseded and withdrawn") : t("Show superseded and withdrawn ({n})", { n: hidden })}
          </Button>
        </View>
      )}
    </View>
  );
}

const FeedRow = memo(function FeedRow({ entry, source, writable, onSupersede }: { entry: UmbrellaEntry; source: string; writable: boolean; onSupersede(id: string): Promise<boolean> }) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const busy = useRef(false);
  const status = statusText[entry.status];
  const live = entry.status === "active" || entry.status === "open";
  const head = [t(kindText[entry.kind]), status ? t(status) : "", actorName(entry.by, source), relativeTime(entry.createdAt)].filter(Boolean).join(" · ");
  return (
    <View style={{ gap: space[1], paddingVertical: space[1.5], borderBottomWidth: 1, borderColor: colors.border, opacity: live || entry.status === "answered" ? 1 : 0.7 }}>
      <Label muted size={font.xs}>
        {head}
      </Label>
      <Label medium size={font.md}>
        {entry.title}
      </Label>
      {!!entry.quote && (
        <Label italic size={font.sm}>
          {`“${entry.quote}”`}
        </Label>
      )}
      {!!entry.body && <Label size={font.sm}>{entry.body}</Label>}
      {!!entry.answer && (
        <Label size={font.sm}>
          <Label muted size={font.sm}>{`${t("Answer")}: `}</Label>
          {entry.answer}
        </Label>
      )}
      {writable && live && entry.kind !== "contract_change" && (
        <View style={{ flexDirection: "row", gap: space[2], alignItems: "center" }}>
          {confirming ? (
            <>
              <Label muted size={font.sm}>{t("Mark as superseded?")}</Label>
              <Button small quiet onPress={() => setConfirming(false)}>
                {t("Cancel")}
              </Button>
              <Button
                small
                danger
                onPress={() => {
                  if (busy.current) return;
                  busy.current = true;
                  void onSupersede(entry.id).finally(() => {
                    busy.current = false;
                    setConfirming(false);
                  });
                }}
              >
                {t("Supersede")}
              </Button>
            </>
          ) : (
            <Button small quiet label={t("Mark {title} as superseded", { title: entry.title })} onPress={() => setConfirming(true)}>
              {t("Supersede")}
            </Button>
          )}
        </View>
      )}
    </View>
  );
});
