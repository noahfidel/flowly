import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { umbrellaEntryKinds, type Actor, type UmbrellaEntry } from "../shared/model";
import { msg, t } from "../shared/i18n";
import { umbrellaLimits } from "../shared/umbrella";
import { feedRows, openQuestions } from "./umbrella-panel-logic";
import { Actions, Button, Choices, Field, Label, font, radius, relativeTime, space, touch, useTheme } from "./ui";

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

const kindOptions = (): { value: Kind | "all"; label: string }[] => [{ value: "all", label: t("All") }, ...umbrellaEntryKinds.map((k) => ({ value: k, label: t(kindText[k]) }))];

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
