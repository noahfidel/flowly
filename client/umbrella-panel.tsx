import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import * as rpc from "../shared/rpc";
import type { Project, Task, Umbrella } from "../shared/model";
import { t, tn } from "../shared/i18n";
import { umbrellaLimits, umbrellaRefetchKey, type UmbrellaSummary } from "../shared/umbrella";
import { Modal } from "./modal";
import { Disclosure } from "./disclosure";
import { Enter } from "./motion";
import { SessionMarkdown } from "./session-content";
import { openQuickLink } from "./quick-links-row";
import { useStableCallback } from "./stable";
import {
  acceptanceInput, editAfterSave, editBase, errorCode, listedUmbrellas, memberWrites, moveMember, pipelineRows, revisionToSend, umbrellaWritable,
  type AcceptanceDraft, type EditBase, type SaveOutcome,
} from "./umbrella-panel-logic";
import { Feed, PartTitle, Questions } from "./umbrella-feed";
import { IntegrationCard, Pipeline } from "./umbrella-members";
import {
  Actions, Button, Field, IconButton, Label, Notice, Row, Theme, font, message, noFocusRing, pageBarHeight, radius, relativeTime, space, touch, useTheme, verticalContent, verticalScroll,
} from "./ui";

type Detail = z.infer<typeof rpc.getUmbrella.output>;

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
  /** The board's cards and projects: the member picker offers the group's live cards from these. */
  tasks: readonly Task[];
  projects: readonly Project[];
};

/** A daemon refusal in the user's words; `what` says which limit UMBRELLA_LIMIT hit. */
function refusalText(error: unknown, what: "group" | "members" = "group"): string {
  switch (errorCode(error)) {
    case "UMBRELLA_LIMIT":
      return what === "members"
        ? t("This umbrella has {n} cards, the most it can hold. Remove one first.", { n: umbrellaLimits.members })
        : t("This group already has 50 open umbrellas. Close one first.");
    case "UMBRELLA_CLOSED":
      return t("This umbrella is closed. Reopen it to change it.");
    case "UMBRELLA_OUT_OF_GROUP":
      return t("That card's project is in another board group than this umbrella.");
    case "NOT_IN_UMBRELLA":
      return t("The integration card must be in this umbrella.");
    default:
      return message(error);
  }
}

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
      setError(refusalText(e));
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
 * reloaded revision and Save becomes Replace. An umbrella that stops taking edits (closed, archived) closes the editor.
 */
function useDraft<T>(writable: boolean, onSave: (value: T, revision: number) => Promise<SaveOutcome>) {
  const [draft, setDraft] = useState<{ value: T; base: EditBase } | null>(null);
  useEffect(() => {
    if (!writable) setDraft(null);
  }, [writable]);
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

function UmbrellaDetail({ hostId, groupId, id, summary, umbrellas, tasks, projects, onSelect, onOpenCard, cardTitle, onChanged }: PanelProps & { id: string; summary?: UmbrellaSummary }) {
  const { colors } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const get = useRpc(rpc.getUmbrella);
  const update = useRpc(rpc.updateUmbrella);
  const updateEntry = useRpc(rpc.updateUmbrellaEntry);
  const setMember = useRpc(rpc.setUmbrellaMember);
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
      setError(refusalText(e));
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
      setError(refusalText(e));
      return false;
    }
  });
  // Membership writes (`umbrellas.set-member`) change the card, not the umbrella's revision: the umbrella is read again after.
  const writeMembers = useStableCallback(async (build: () => Promise<z.infer<typeof rpc.setUmbrellaMember.input>[]>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const inputs = await build();
      for (const input of inputs) await setMember(input);
      return true;
    } catch (e) {
      setError(refusalText(e, "members"));
      return false;
    } finally {
      setBusy(false);
      reload();
      onChanged();
    }
  });
  /**
   * Role and order changes: the members are read again just before (the panel's copy can be stale, because membership
   * writes elsewhere do not change the refetch key), and only rows that really change and whose card is still in this
   * umbrella on the board are sent, so a card that left is never pulled back and a role set elsewhere is never reset.
   */
  const changeMembers = (plan: (members: Detail["members"]) => { taskId: string; role?: string; order?: number }[]) =>
    writeMembers(async () => {
      const fresh = await get({ id });
      patch(() => fresh);
      const inUmbrella = new Set(tasks.filter((task) => task.umbrella?.id === id).map((task) => task.id));
      return memberWrites(id, fresh.members, plan(fresh.members), inUmbrella);
    });
  const addMember = useStableCallback((taskId: string, role: string) => writeMembers(async () => [{ taskId, umbrellaId: id, ...(role.trim() ? { role: role.trim() } : {}) }]));
  const removeMember = useStableCallback((taskId: string) => writeMembers(async () => [{ taskId, umbrellaId: null }]));
  const setRole = useStableCallback((taskId: string, role: string) => changeMembers(() => [{ taskId, role }]));
  const move = useStableCallback((taskId: string, delta: -1 | 1) => void changeMembers((members) => moveMember(pipelineRows(members), taskId, delta)));
  const title = useDraft(!!data && umbrellaWritable(data.umbrella), (text: string, base: number) => write((revision) => update({ id, revision, title: text.trim() }), base));
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
        {title.draft ? (
          <View style={{ gap: space[2] }}>
            <Field
              title={t("Title")}
              value={title.draft.value}
              onChange={(next) => title.change(() => next)}
              maxLength={umbrellaLimits.title}
              autoFocus
              onSubmit={title.draft.value.trim() ? () => void title.save() : undefined}
            />
            <Actions>
              <Button quiet disabled={busy} onPress={title.cancel}>
                {t("Cancel")}
              </Button>
              <Button primary disabled={busy || !title.draft.value.trim()} onPress={() => void title.save()}>
                {title.draft.base.replace ? t("Replace") : t("Save")}
              </Button>
            </Actions>
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
            <View style={{ flexShrink: 1, minWidth: 0 }}>
              <Label bold size={font.lg}>
                {u.title}
              </Label>
            </View>
            {writable && <IconButton icon="Pencil" size={28} label={t("Rename {title}", { title: u.title })} disabled={busy} onPress={() => title.start(u.title, u.revision)} />}
          </View>
        )}
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
      <Pipeline
        umbrellaId={id}
        groupId={groupId}
        members={data.members}
        umbrellas={umbrellas}
        tasks={tasks}
        projects={projects}
        writable={writable}
        busy={busy}
        onOpen={openCard}
        onAdd={addMember}
        onMove={move}
        onRole={setRole}
        onRemove={removeMember}
      />
      <IntegrationCard
        members={data.members}
        value={u.integrationTaskId ?? ""}
        writable={writable}
        busy={busy}
        onChange={(taskId) => void write((revision) => update({ id, revision, integrationTaskId: taskId }))}
      />
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
  const editor = useDraft(writable, onSave);
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
  const editor = useDraft(writable, (list: DraftItem[], base: number) => onSave(plain(list), base));
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
