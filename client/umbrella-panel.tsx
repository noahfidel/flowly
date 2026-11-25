import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import * as rpc from "../shared/rpc";
import { umbrellaEntryKinds, type Actor, type Umbrella, type UmbrellaEntry } from "../shared/model";
import { msg, t, tn } from "../shared/i18n";
import { umbrellaLimits, umbrellaRefetchKey, type UmbrellaMember, type UmbrellaSummary } from "../shared/umbrella";
import { Modal } from "./modal";
import { Disclosure } from "./disclosure";
import { Enter } from "./motion";
import { SessionMarkdown } from "./session-content";
import { openQuickLink } from "./quick-links-row";
import { useStableCallback } from "./stable";
import {
  acceptanceInput, editAfterSave, editBase, errorCode, feedRows, listedUmbrellas, openQuestions, pipelineRows, revisionToSend, umbrellaWritable, type AcceptanceDraft, type EditBase, type SaveOutcome,
} from "./umbrella-panel-logic";
import {
  Actions, Button, Choices, Field, IconButton, Label, Notice, Row, Theme, font, message, noFocusRing, pageBarHeight, radius, relativeTime, space, touch, useTheme, verticalContent, verticalScroll,
} from "./ui";

type Detail = z.infer<typeof rpc.getUmbrella.output>;
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

/** What the panel needs from the board around it. */
type PanelProps = {
  hostId: string;
  groupId: string;
  /** Every umbrella summary of the board overview; the list and the counts come from these, never from a separate read. */
  umbrellas: readonly UmbrellaSummary[];
  /** The umbrella shown, or null for the list. */
  selected: string | null;
  onSelect(id: string | null): void;
  onOpenCard(taskId: string): void;
  /** A card's current title when it is still on the board (a feed entry from a card that left shows "moved out"). */
  cardTitle(taskId: string): string | undefined;
  /** After a write: refresh the board overview, whose summary then carries the new revisions. */
  onChanged(): void;
};

/**
 * The umbrella panel (UMBRELLA-SPEC §7): the shown group's umbrellas, and one umbrella's brief, contract, pipeline,
 * feed, open questions and acceptance. One `umbrellas.get` when an umbrella opens and again when its summary's
 * refetch key changes (an edit or a feed write); never polled.
 */
function UmbrellaPanelBody(props: PanelProps) {
  const summary = props.selected ? props.umbrellas.find((u) => u.id === props.selected) : undefined;
  return (
    <Enter key={props.selected ?? "list"} distance={6}>
      {props.selected ? <UmbrellaDetail {...props} id={props.selected} summary={summary} /> : <UmbrellaList {...props} />}
    </Enter>
  );
}

/** Desktop: a page in place of the board columns, beside the card drawer, like Guardrails. */
export const UmbrellaPage = memo(function UmbrellaPage({ onBack, ...props }: PanelProps & { onBack(): void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: pageBarHeight, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}
        </Button>
        <View style={{ flex: 1 }} />
        <Icon name="Umbrella" size={15} color={colors.foregroundMuted} />
        <Label bold size={font.md} selectable={false}>
          {t("Umbrellas")}
        </Label>
        <View style={{ flex: 1 }} />
        <View style={{ width: 72 }} />
      </View>
      <ScrollView {...verticalScroll} keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: 760 }}>
          <UmbrellaPanelBody {...props} />
        </View>
      </ScrollView>
    </View>
  );
});

/** Phones and narrow windows: the same panel in a host Modal. */
export function UmbrellaModal({ open, theme, onClose, ...props }: PanelProps & { open: boolean; theme: PluginTheme; onClose(): void }) {
  return (
    <Modal
      open={open}
      title={t("Umbrellas")}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[2] }}>
        <Theme.Provider value={theme}>{open && <UmbrellaPanelBody {...props} />}</Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function UmbrellaList({ groupId, umbrellas, onSelect, onChanged }: PanelProps) {
  const { open, closed } = useMemo(() => listedUmbrellas(umbrellas, groupId), [umbrellas, groupId]);
  const [closedOpen, setClosedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const select = useStableCallback((id: string) => onSelect(id));
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: "row" }}>
        {!creating && (
          <Button small quiet icon="Plus" onPress={() => setCreating(true)}>
            {t("New umbrella")}
          </Button>
        )}
      </View>
      {creating && (
        <NewUmbrella
          groupId={groupId}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onChanged();
            onSelect(id);
          }}
        />
      )}
      {open.length === 0 && !creating && (
        <View style={{ alignItems: "center", paddingVertical: space[6] }}>
          <Label muted size={font.md}>
            {t("No open umbrellas in this group.")}
          </Label>
        </View>
      )}
      <View style={{ gap: space[1] }}>
        {open.map((u) => (
          <UmbrellaRow key={u.id} umbrella={u} onOpen={select} />
        ))}
      </View>
      {closed.length > 0 && (
        <Disclosure title={t("Closed · {n}", { n: closed.length })} open={closedOpen} onChange={setClosedOpen} flush>
          <View style={{ gap: space[1] }}>
            {closed.map((u) => (
              <UmbrellaRow key={u.id} umbrella={u} onOpen={select} />
            ))}
          </View>
        </Disclosure>
      )}
    </View>
  );
}

const UmbrellaRow = memo(function UmbrellaRow({ umbrella, onOpen }: { umbrella: UmbrellaSummary; onOpen(id: string): void }) {
  const parts = [tn(umbrella.members, "{n} card", "{n} cards")];
  if (umbrella.openQuestions) parts.push(tn(umbrella.openQuestions, "{n} open question", "{n} open questions"));
  if (umbrella.pendingChanges) parts.push(tn(umbrella.pendingChanges, "{n} pending change", "{n} pending changes"));
  return <Row icon="Umbrella" title={umbrella.title} detail={parts.join(" · ")} label={t("Open umbrella {title}", { title: umbrella.title })} onPress={() => onOpen(umbrella.id)} />;
});

function NewUmbrella({ groupId, onCancel, onCreated }: { groupId: string; onCancel(): void; onCreated(id: string): void }) {
  const create = useRpc(rpc.createUmbrella);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const made = await create({ groupId, title: title.trim(), ...(brief.trim() ? { brief } : {}) });
      onCreated(made.id);
    } catch (e) {
      setError(errorCode(e) === "UMBRELLA_LIMIT" ? t("This group already has 50 open umbrellas. Close one first.") : message(e));
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space[3] }}>
      <Field title={t("Title")} value={title} onChange={setTitle} maxLength={umbrellaLimits.title} autoFocus onSubmit={title.trim() ? () => void submit() : undefined} />
      <Field title={t("Brief (optional)")} value={brief} onChange={setBrief} multiline maxLength={umbrellaLimits.brief} />
      {!!error && <Notice>{error}</Notice>}
      <Actions>
        <Button quiet disabled={busy} onPress={onCancel}>
          {t("Cancel")}
        </Button>
        <Button primary disabled={busy || !title.trim()} onPress={() => void submit()}>
          {t("Create")}
        </Button>
      </Actions>
    </View>
  );
}

/**
 * An editor's draft and the revision it was opened on (`EditBase`): Save sends that revision, so an edit made meanwhile
 * (the dispatcher, another window) is refused instead of overwritten; after the refusal the editor is based on the
 * reloaded revision and Save becomes Replace.
 */
function useDraft<T>(onSave: (value: T, revision: number) => Promise<SaveOutcome>) {
  const [draft, setDraft] = useState<{ value: T; base: EditBase } | null>(null);
  const start = (value: T, revision: number) => setDraft({ value, base: editBase(revision) });
  const change = (fn: (value: T) => T) => setDraft((d) => d && { ...d, value: fn(d.value) });
  const save = async () => {
    if (!draft) return;
    const base = editAfterSave(draft.base, await onSave(draft.value, revisionToSend(draft.base)));
    // Keep the text typed since Save was pressed; only the base moves.
    setDraft((d) => (base && d ? { ...d, base } : null));
  };
  return { draft, start, change, save, cancel: () => setDraft(null) };
}

function UmbrellaDetail({ hostId, id, summary, onSelect, onOpenCard, cardTitle, onChanged }: PanelProps & { id: string; summary?: UmbrellaSummary }) {
  const { colors } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const get = useRpc(rpc.getUmbrella);
  const update = useRpc(rpc.updateUmbrella);
  const updateEntry = useRpc(rpc.updateUmbrellaEntry);
  const close = useRpc(rpc.closeUmbrella);
  const reopen = useRpc(rpc.reopenUmbrella);
  const archive = useRpc(rpc.archiveUmbrella);
  // The drawer section reads the same key, so the two share one cached read.
  const refetchKey = summary ? umbrellaRefetchKey(summary) : "";
  const key = ["flowly", "umbrella", hostId, id, refetchKey];
  const detail = useQuery({ queryKey: key, queryFn: () => get({ id }), staleTime: Infinity, retry: false, placeholderData: keepPreviousData });
  const data = detail.data?.umbrella.id === id ? detail.data : undefined;
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"close" | "reopen" | "archive" | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (fn: (old: Detail) => Detail) => queryClient.setQueryData<Detail>(key, (old) => (old ? fn(old) : old));
  const reload = () => void queryClient.invalidateQueries({ queryKey: ["flowly", "umbrella", hostId, id] });
  // One write at a time. `base`: an editor's revision (never the current one, so a concurrent edit is refused); without
  // it, the revision shown (ticks, close). A refusal reloads the umbrella and leaves the caller's typed text where it is.
  const write = useStableCallback(async (run: (revision: number) => Promise<Umbrella>, base?: number): Promise<SaveOutcome> => {
    if (!data || busy) return { status: "failed" };
    setBusy(true);
    setError("");
    try {
      const umbrella = await run(base ?? data.umbrella.revision);
      patch((old) => ({ ...old, umbrella }));
      onChanged();
      return { status: "saved" };
    } catch (e) {
      const code = errorCode(e);
      if (code === "REVISION_CONFLICT") {
        try {
          const fresh = await get({ id });
          patch(() => fresh);
          onChanged();
          setError(t("This umbrella changed since you opened it. It has been reloaded; your text is kept, so save again to replace it."));
          return { status: "conflict", revision: fresh.umbrella.revision };
        } catch (reloadError) {
          setError(message(reloadError));
          return { status: "failed" };
        }
      }
      setError(code === "UMBRELLA_CLOSED" ? t("This umbrella is closed. Reopen it to change it.") : message(e));
      if (code === "UMBRELLA_CLOSED") reload();
      return { status: "failed" };
    } finally {
      setBusy(false);
    }
  });
  const writeEntry = useStableCallback(async (input: { id: string; status: "answered" | "superseded"; answer?: string }): Promise<boolean> => {
    setError("");
    try {
      const entry = await updateEntry(input);
      patch((old) => ({ ...old, entries: old.entries.map((e) => (e.id === entry.id ? entry : e)) }));
      onChanged();
      return true;
    } catch (e) {
      setError(errorCode(e) === "UMBRELLA_CLOSED" ? t("This umbrella is closed. Reopen it to change it.") : message(e));
      return false;
    }
  });
  const memberIds = useMemo(() => new Map((data?.members ?? []).map((m) => [m.taskId, m.title])), [data?.members]);
  const sourceOf = useStableCallback((taskId: string | undefined) => {
    if (!taskId) return "";
    return memberIds.get(taskId) ?? (cardTitle(taskId) !== undefined ? t("moved out") : t("deleted card"));
  });
  const openCard = useStableCallback((taskId: string) => onOpenCard(taskId));
  const answer = useStableCallback((entryId: string, text: string) => writeEntry({ id: entryId, status: "answered", answer: text }));
  const supersede = useStableCallback((entryId: string) => writeEntry({ id: entryId, status: "superseded" }));
  const back = (
    <View style={{ flexDirection: "row" }}>
      <Button small quiet icon="ChevronLeft" onPress={() => onSelect(null)}>
        {t("All umbrellas")}
      </Button>
    </View>
  );
  if (!data)
    return (
      <View style={{ gap: space[3] }}>
        {back}
        {detail.isError ? <Notice>{message(detail.error)}</Notice> : <Label muted>{t("Loading…")}</Label>}
      </View>
    );
  const u = data.umbrella;
  const writable = umbrellaWritable(u);
  const linear = u.linearProject;
  return (
    <View style={{ gap: space[4] }}>
      {back}
      <View style={{ gap: space[1.5] }}>
        <Label bold size={font.lg}>
          {u.title}
        </Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[2] }}>
          {u.archivedAt ? (
            <Label muted size={font.sm}>{t("Archived")}</Label>
          ) : u.status === "closed" ? (
            <Label muted size={font.sm}>{t("Closed")}</Label>
          ) : null}
          {linear && (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t("Open the Linear project")}
              onPress={() => openQuickLink(linear.url, toast)}
              style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1], paddingHorizontal: space[2], paddingVertical: 2, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.7 : 1 })}
            >
              <Icon name="Link" size={12} color={colors.foregroundMuted} />
              <Label size={font.sm} lines={1} selectable={false}>
                {linear.name || linear.key || linear.url}
              </Label>
            </Pressable>
          )}
        </View>
      </View>
      {!!error && <Notice tone="warning">{error}</Notice>}
      <TextPart
        title={t("Brief")}
        text={u.brief.text}
        empty={t("No brief yet.")}
        changed={u.brief.revision > 0 ? u.brief.updatedAt : ""}
        source={u.brief.source}
        max={umbrellaLimits.brief}
        writable={writable}
        busy={busy}
        revision={u.revision}
        onSave={(text, base) => write((revision) => update({ id, revision, brief: text }), base)}
      />
      <TextPart
        title={t("Contract")}
        text={u.contract.text}
        empty={t("No contract yet.")}
        changed={u.contract.revision > 0 ? u.contract.updatedAt : ""}
        max={umbrellaLimits.contract}
        writable={writable}
        busy={busy}
        revision={u.revision}
        onSave={(text, base) => write((revision) => update({ id, revision, contract: text }), base)}
      />
      <Pipeline members={data.members} onOpen={openCard} />
      <Questions entries={data.entries} writable={writable} sourceOf={sourceOf} onAnswer={answer} />
      <Feed entries={data.entries} writable={writable} sourceOf={sourceOf} onSupersede={supersede} />
      <Acceptance
        items={u.acceptance}
        writable={writable}
        busy={busy}
        revision={u.revision}
        onTick={(items) => write((revision) => update({ id, revision, acceptance: acceptanceInput(items) }))}
        onSave={(items, base) => write((revision) => update({ id, revision, acceptance: acceptanceInput(items) }), base)}
      />
      {!u.archivedAt && (
        <View style={{ gap: space[2] }}>
          {confirm ? (
            <View style={{ gap: space[3] }}>
              <Notice tone="warning">
                {confirm === "close"
                  ? t("Close {title}? Its cards stay as they are; it stops taking new cards and feed entries until you reopen it.", { title: u.title })
                  : confirm === "reopen"
                    ? t("Reopen {title}?", { title: u.title })
                    : t("Archive {title}? Its cards stay as they are; it stays readable but leaves the lists and takes no more changes.", { title: u.title })}
              </Notice>
              <Actions>
                <Button quiet disabled={busy} onPress={() => setConfirm(null)}>
                  {t("Cancel")}
                </Button>
                <Button
                  danger={confirm !== "reopen"}
                  primary={confirm === "reopen"}
                  disabled={busy}
                  onPress={() => {
                    const action = confirm;
                    setConfirm(null);
                    void write((revision) => (action === "close" ? close : action === "reopen" ? reopen : archive)({ id, revision })).then((result) => {
                      if (result.status === "saved" && action === "archive") {
                        toast.show(t("Umbrella archived"), { variant: "success" });
                        onSelect(null);
                      }
                    });
                  }}
                >
                  {confirm === "close" ? t("Close umbrella") : confirm === "reopen" ? t("Reopen") : t("Archive")}
                </Button>
              </Actions>
            </View>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              {u.status === "open" ? (
                <Button small disabled={busy} onPress={() => setConfirm("close")}>
                  {t("Close umbrella")}
                </Button>
              ) : (
                <Button small disabled={busy} onPress={() => setConfirm("reopen")}>
                  {t("Reopen")}
                </Button>
              )}
              <Button small quiet danger disabled={busy} onPress={() => setConfirm("archive")}>
                {t("Archive")}
              </Button>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function PartTitle({ title, count, trailing }: { title: string; count?: number; trailing?: ReactNode }) {
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

/** The brief or the contract: markdown, and while editing a multiline Field whose text survives a conflict. */
function TextPart({ title, text, empty, changed, source, max, writable, busy, revision, onSave }: {
  title: string;
  text: string;
  empty: string;
  /** When it last changed; "" before its first text. */
  changed: string;
  source?: string;
  max: number;
  writable: boolean;
  busy: boolean;
  /** The umbrella's revision now; Edit records it as the draft's base. */
  revision: number;
  onSave(text: string, base: number): Promise<SaveOutcome>;
}) {
  const editor = useDraft(onSave);
  const draft = editor.draft?.value ?? null;
  return (
    <View style={{ gap: space[1.5] }}>
      <PartTitle
        title={title}
        trailing={
          writable && draft === null ? (
            <Button small quiet icon="Pencil" label={t("Edit {part}", { part: title })} onPress={() => editor.start(text, revision)}>
              {t("Edit")}
            </Button>
          ) : undefined
        }
      />
      {draft !== null ? (
        <View style={{ gap: space[2] }}>
          <Field title={title} value={draft} onChange={(next) => editor.change(() => next)} multiline maxLength={max} autoFocus />
          <Actions>
            <Button quiet disabled={busy} onPress={editor.cancel}>
              {t("Cancel")}
            </Button>
            <Button primary disabled={busy} onPress={() => void editor.save()}>
              {editor.draft?.base.replace ? t("Replace") : t("Save")}
            </Button>
          </Actions>
        </View>
      ) : text.trim() ? (
        <SessionMarkdown text={text} />
      ) : (
        <Label muted size={font.sm}>
          {empty}
        </Label>
      )}
      {(!!changed || !!source) && draft === null && (
        <Label muted size={font.xs}>
          {[changed ? t("Changed {time}", { time: relativeTime(changed) }) : "", source ? t("Source: {source}", { source }) : ""].filter(Boolean).join(" · ")}
        </Label>
      )}
    </View>
  );
}

function Pipeline({ members, onOpen }: { members: readonly UmbrellaMember[]; onOpen(taskId: string): void }) {
  const rows = useMemo(() => pipelineRows(members), [members]);
  return (
    <View style={{ gap: space[1] }}>
      <PartTitle title={t("Pipeline")} count={rows.length} />
      {rows.length === 0 ? (
        <Label muted size={font.sm}>
          {t("No cards yet. Ask the dispatcher, or a card's agent, to add cards to it.")}
        </Label>
      ) : (
        rows.map((m) => <PipelineRow key={m.taskId} member={m} onOpen={onOpen} />)
      )}
    </View>
  );
}

const PipelineRow = memo(function PipelineRow({ member, onOpen }: { member: UmbrellaMember; onOpen(taskId: string): void }) {
  const detail = [member.role, member.laneName, member.projectTitle, member.archived ? t("Archived") : ""].filter(Boolean).join(" · ");
  return <Row title={member.title} detail={detail} label={t("Open card {card}", { card: member.title })} onPress={() => onOpen(member.taskId)} />;
});

const actorName = (by: Actor, source: string) => (by.kind === "human" ? t("you") : by.kind === "dispatcher" ? t("dispatcher") : source || t("an agent"));

function Questions({ entries, writable, sourceOf, onAnswer }: {
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

function Feed({ entries, writable, sourceOf, onSupersede }: {
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

type DraftItem = AcceptanceDraft & { key: string };

/** The acceptance list (§11): ticks save at once; Edit list changes, adds and removes items (at most 20) in one save. */
function Acceptance({ items, writable, busy, revision, onTick, onSave }: {
  items: Umbrella["acceptance"];
  writable: boolean;
  busy: boolean;
  revision: number;
  /** A tick: the list as shown, against the revision shown. */
  onTick(items: AcceptanceDraft[]): Promise<SaveOutcome>;
  /** Edit list: against the revision it was opened on. */
  onSave(items: AcceptanceDraft[], base: number): Promise<SaveOutcome>;
}) {
  const next = useRef(0);
  const plain = (list: readonly { id?: string; text: string; done: boolean }[]): AcceptanceDraft[] => list.map((a) => ({ ...(a.id ? { id: a.id } : {}), text: a.text, done: a.done }));
  const toggle = useStableCallback((itemId: string) => {
    if (busy) return;
    void onTick(plain(items).map((a) => (a.id === itemId ? { ...a, done: !a.done } : a)));
  });
  const editor = useDraft((list: DraftItem[], base: number) => onSave(plain(list), base));
  const draft = editor.draft?.value ?? null;
  const startEdit = () => editor.start(items.map((a) => ({ key: a.id, id: a.id, text: a.text, done: a.done })), revision);
  const change = (key: string, text: string) => editor.change((d) => d.map((a) => (a.key === key ? { ...a, text } : a)));
  const remove = (key: string) => editor.change((d) => d.filter((a) => a.key !== key));
  const add = () => editor.change((d) => (d.length >= umbrellaLimits.acceptance ? d : [...d, { key: `new-${next.current++}`, text: "", done: false }]));
  const done = items.filter((a) => a.done).length;
  return (
    <View style={{ gap: space[1.5] }}>
      <PartTitle
        title={t("Acceptance")}
        trailing={
          writable && !draft ? (
            <Button small quiet icon="Pencil" label={t("Edit the acceptance list")} onPress={startEdit}>
              {t("Edit list")}
            </Button>
          ) : undefined
        }
      />
      {!!items.length && !draft && (
        <Label muted size={font.sm}>
          {t("{done} of {total} met", { done, total: items.length })}
        </Label>
      )}
      {draft ? (
        <View style={{ gap: space[2] }}>
          {draft.map((a, index) => (
            <View key={a.key} style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Field title={t("Item {n}", { n: index + 1 })} value={a.text} onChange={(text) => change(a.key, text)} maxLength={umbrellaLimits.acceptanceText} />
              </View>
              <IconButton icon="Trash2" label={t("Remove item {n}", { n: index + 1 })} onPress={() => remove(a.key)} />
            </View>
          ))}
          <View style={{ flexDirection: "row" }}>
            <Button small quiet icon="Plus" disabled={draft.length >= umbrellaLimits.acceptance} onPress={add}>
              {t("Add item")}
            </Button>
          </View>
          <Actions>
            <Button quiet disabled={busy} onPress={editor.cancel}>
              {t("Cancel")}
            </Button>
            <Button primary disabled={busy} onPress={() => void editor.save()}>
              {editor.draft?.base.replace ? t("Replace") : t("Save")}
            </Button>
          </Actions>
        </View>
      ) : items.length ? (
        items.map((a) => <AcceptanceRow key={a.id} id={a.id} text={a.text} done={a.done} disabled={!writable || busy} onToggle={toggle} />)
      ) : (
        <Label muted size={font.sm}>
          {t("No acceptance items yet. They say when the whole umbrella is done.")}
        </Label>
      )}
    </View>
  );
}

const AcceptanceRow = memo(function AcceptanceRow({ id, text, done, disabled, onToggle }: { id: string; text: string; done: boolean; disabled: boolean; onToggle(id: string): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={text}
      accessibilityState={{ checked: done, disabled }}
      disabled={disabled}
      onPress={() => onToggle(id)}
      style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "flex-start", gap: space[2], minHeight: touch ? 36 : undefined, paddingVertical: 2, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 16, height: 16, marginTop: 1, borderRadius: radius.sm, borderWidth: 1.5,
          borderColor: done ? colors.accent : colors.foregroundMuted, backgroundColor: done ? colors.accent : "transparent",
          alignItems: "center", justifyContent: "center",
        }}
      >
        {done && <Icon name="Check" size={12} color={colors.accentForeground} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.md}>{text}</Label>
      </View>
    </Pressable>
  );
});
