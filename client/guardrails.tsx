import { usePerfRender } from "./perf";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type ChangeSize, type Project, type Status, type Task } from "../shared/model";
import { agentsRule, memoryLimits, type MemoryKind } from "../shared/memory";
import { guardrailLimits, type GuardrailEntry, type GuardrailKind, type GuardrailState } from "../shared/guardrails";
import { joinCommand, splitCommand } from "../shared/auto-review";
import { ContentCard, CardBody, CardHeadline, CardMeta, CardMetaRow, CardText, SourceLine } from "./content-card";
import { eventPoint, useMenuOpener, type MenuEntry } from "./context-menu";
import { Chevron, Collapse } from "./disclosure";
import { Modal } from "./modal";
import { Enter } from "./motion";
import { keepPageRows, usePageRows } from "./page-rows";
import { guardrailCountsKey, guardrailsKey, useGuardrailsQuery } from "./queries";
import { IdeaRow, useExitList } from "./task-ideas";
import { Actions, Button, Choices, Field, IconButton, Label, Notice, Theme, font, message, noFocusRing, pageBarHeight, radius, space, tint, touch, useTheme, verticalContent, verticalScroll } from "./ui";
import { t, msg } from "../shared/i18n";

/** The Guardrails page (GUARDRAILS-SPEC §7.4): the project's commands and learned guidelines. Notes have the Memory page. */

const sizeLabels: Record<ChangeSize, string> = { s: msg("Small changes"), m: msg("Medium changes"), l: msg("Large changes") };
/** Why an entry stopped (§6.7, §3.4, §7.3); the daemon writes these English reasons, translated at render. */
const reasonLabels: Record<string, string> = {
  "misfired twice in 30 days": msg("Misfired twice in 30 days"),
  "never caught anything": msg("Caught nothing in 20 reviews"),
  "unused for 90 days": msg("Unused for 90 days"),
  "cannot run": msg("Could not run 3 times"),
  "script missing": msg("The script is gone"),
  displaced: msg("Pushed out by a newer one"),
  merged: msg("Merged into another"),
  superseded: msg("Replaced"),
  promoted: msg("Moved to AGENTS.md"),
  dismissed: msg("Dismissed"),
};
export const reasonText = (reason: string | undefined) => (reason ? (reasonLabels[reason] ? t(reasonLabels[reason]) : reason) : "");

type Segment = "command" | "guideline";
const live = (e: GuardrailEntry) => e.state === "active" || e.state === "observing";
const list = (value: string) => [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];

type CommandDraft = { name: string; command: string; timeout: string };
type GuidelineDraft = { text: string; body: string };
export type NoteDraft = { kind: MemoryKind; title: string; body: string; tags: string; keywords: string; pinned: boolean };

/** Every guardrail write, refreshing the page and the overview chip afterwards; failures (GUARDRAIL_CONFLICT included) toast. */
export function useGuardrailActions(projectId: string) {
  const client = useQueryClient();
  const toast = useToast();
  const createRpc = useRpc(rpc.createGuardrail),
    updateRpc = useRpc(rpc.updateGuardrail),
    deleteRpc = useRpc(rpc.deleteGuardrail);
  const [busy, setBusy] = useState("");
  const refresh = () => {
    void client.invalidateQueries({ queryKey: guardrailsKey(projectId) });
    void client.invalidateQueries({ queryKey: guardrailCountsKey });
  };
  const run = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await work();
      if (done) toast.show(done, { variant: "success" });
      return true;
    } catch (e) {
      toast.show(message(e), { variant: "error" });
      return false;
    } finally {
      setBusy("");
      refresh();
    }
  };
  const update = (e: GuardrailEntry, patch: Omit<Parameters<typeof updateRpc>[0], "id" | "revision">) => run(e.id, () => updateRpc({ id: e.id, revision: e.revision, ...patch }));
  return {
    busy,
    addCommand: (d: CommandDraft) =>
      run("new", () => createRpc({ projectId, kind: "command", text: d.name.trim(), argv: splitCommand(d.command), ...(d.timeout ? { timeoutSec: Number(d.timeout) } : {}) })),
    addNote: (d: NoteDraft) =>
      run("new", () =>
        createRpc({ projectId, kind: "note", noteKind: d.kind, text: d.title.trim(), body: d.body.trim(), tags: list(d.tags).map((s) => s.toLowerCase()).slice(0, memoryLimits.tags), keywords: list(d.keywords).slice(0, memoryLimits.keywords), pinned: d.pinned }),
      ),
    saveCommand: (e: GuardrailEntry, d: CommandDraft) => update(e, { text: d.name.trim(), argv: splitCommand(d.command), ...(d.timeout ? { timeoutSec: Number(d.timeout) } : {}) }),
    saveGuideline: (e: GuardrailEntry, d: GuidelineDraft) => update(e, { text: d.text.trim(), body: d.body.trim() }),
    saveNote: (e: GuardrailEntry, d: NoteDraft) =>
      update(e, { text: d.title.trim(), body: d.body.trim(), tags: list(d.tags).map((s) => s.toLowerCase()).slice(0, memoryLimits.tags), keywords: list(d.keywords).slice(0, memoryLimits.keywords), pinned: d.pinned }),
    pin: (e: GuardrailEntry, pinned: boolean) => update(e, { pinned }),
    setState: (e: GuardrailEntry, state: GuardrailState, stateReason?: string) => update(e, { state, ...(stateReason ? { stateReason } : {}) }),
    remove: (e: GuardrailEntry) => run(e.id, () => deleteRpc({ id: e.id, revision: e.revision }), t("Deleted.")),
    copyRule: async (e: GuardrailEntry) => {
      try {
        await copyText(agentsRule({ title: e.text, body: e.body || "" }));
        toast.show(t("Copied. Paste it into the repository's AGENTS.md, then choose Done, stop injecting."), { variant: "success" });
      } catch (err) {
        toast.show(message(err), { variant: "error" });
      }
    },
  };
}
export type GuardrailActions = ReturnType<typeof useGuardrailActions>;

/** Back into use: a command that has not finished observing goes back to observing (§4.5). */
const resumed = (e: GuardrailEntry): GuardrailState => (e.kind === "command" && e.observe && e.observe.reviews < guardrailLimits.observeReviews ? "observing" : "active");

/** One guardrail as a content card, with its kind's facts and menu (§7.4). */
const GuardrailCard = memo(function GuardrailCard({
  entry,
  actions,
  disabled,
  cards,
  nameOf,
  onOpenTask,
  onEditorOpen,
}: {
  entry: GuardrailEntry;
  actions: GuardrailActions;
  disabled: boolean;
  cards: ReadonlyMap<string, Task>;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
  /** Keep this row mounted while background results are reordered. */
  onEditorOpen(id: string): void;
}) {
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const [editing, setEditing] = useState(false);
  // Once edited, the card rises back in when the editor closes; on first render it just sits there.
  const [edited, setEdited] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const busy = disabled || actions.busy === entry.id;
  const edit = () => {
    onEditorOpen(entry.id);
    setEditing(true);
  };
  const closeEditor = () => {
    setEdited(true);
    setEditing(false);
  };
  const saved = (ok: boolean) => ok && closeEditor();
  if (editing)
    return (
      <Enter key="editor">
        {entry.kind === "command" ? (
          <CommandEditor title={t("Edit command")} submit={t("Save")} initial={{ name: entry.text, command: joinCommand(entry.argv || []), timeout: entry.timeoutSec ? String(entry.timeoutSec) : "" }} onCancel={closeEditor} onSubmit={async (d) => saved(await actions.saveCommand(entry, d))} />
        ) : (
          <GuidelineEditor initial={{ text: entry.text, body: entry.body || "" }} onCancel={closeEditor} onSubmit={async (d) => saved(await actions.saveGuideline(entry, d))} />
        )}
      </Enter>
    );
  const archived = entry.state === "archived";
  const paused = entry.state === "paused";
  const items: MenuEntry[] = [];
  if (!archived) items.push({ id: "edit", label: t("Edit"), icon: "Pencil", onPress: edit });
  if (live(entry)) items.push({ id: "pause", label: t("Pause"), icon: "Pause", onPress: () => void actions.setState(entry, "paused") });
  if (paused || archived) items.push({ id: "resume", label: archived ? t("Restore") : t("Resume"), icon: archived ? "ArchiveRestore" : "Play", onPress: () => void actions.setState(entry, resumed(entry)) });
  if (entry.kind === "guideline" && !archived) items.push({ id: "archive", label: t("Archive"), icon: "Archive", onPress: () => void actions.setState(entry, "archived") });
  items.push({ kind: "separator", id: "s" }, { id: "delete", label: t("Delete…"), icon: "Trash2", danger: true, onPress: () => setDeleting(true) });
  const footer = openMenu ? (
    <IconButton icon="Ellipsis" disabled={busy} label={t("Actions for {title}", { title: entry.text })} onPress={(event) => openMenu(eventPoint(event), entry.text, items)} />
  ) : (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
      {items.flatMap((item) =>
        item.kind !== "separator" && item.kind !== "label" ? [
          <Button key={item.id} small quiet danger={!!item.danger} icon={item.icon} disabled={busy} onPress={item.onPress}>
            {item.label}
          </Button>,
        ] : [],
      )}
    </View>
  );
  const sourceIds = [...new Set([entry.source?.taskId, ...entry.sources.map((s) => s.taskId)].filter((id): id is string => !!id))].slice(0, entry.kind === "guideline" ? 3 : 1);
  const after = sourceIds.length ? <>{sourceIds.map((id) => <SourceLine key={id} task={cards.get(id)} nameOf={nameOf} onOpenTask={onOpenTask} />)}</> : undefined;
  const reason = paused || archived ? reasonText(entry.stateReason) : "";
  const quote = entry.kind === "guideline" ? entry.sources.find((s) => s.quote)?.quote : undefined;
  const c = entry.counts;
  const content = (
    <ContentCard footer={footer} after={after}>
      <CardBody>
        <CardMetaRow>
          {entry.state === "observing" && (
            <CardMeta icon={<Icon name="Eye" size={12} color={colors.foregroundMuted} />} text={t("observing {done}/{total}", { done: Math.min(entry.observe?.reviews ?? 0, guardrailLimits.observeReviews), total: guardrailLimits.observeReviews })} />
          )}
          {entry.kind === "guideline" && entry.scope && entry.scope.types !== "all" && <CardMeta text={entry.scope.types.map((type) => taskTypeLabels[type]).join(", ")} />}
          {entry.kind === "guideline" && entry.scope && entry.scope.sizes !== "all" && <CardMeta text={entry.scope.sizes.map((size) => t(sizeLabels[size])).join(", ")} />}
          {!!reason && <CardMeta text={reason} />}
        </CardMetaRow>
        {!!quote && (
          <View style={{ paddingLeft: space[2], borderLeftWidth: 2, borderColor: tint(colors.accent, 0.4) }}>
            <Label italic size={font.base}>“{quote}”</Label>
          </View>
        )}
        {quote ? <Label muted size={font.sm}>{entry.text}</Label> : <CardHeadline>{entry.text}</CardHeadline>}
        {entry.kind === "command" && !!entry.argv && <Label muted mono size={font.sm} selectable>{joinCommand(entry.argv)}</Label>}
        {!!entry.body && <CardText>{entry.body}</CardText>}
        {entry.kind === "guideline" && (
          <Label muted size={font.xs}>{t("caught {caught} · missed {missed} · misfire {misfire}", { caught: c.caught, missed: c.missed, misfire: c.misfire })}</Label>
        )}
        {entry.kind === "command" && c.reviews > 0 && <Label muted size={font.xs}>{t("passed {passed} of {reviews} reviews", { passed: c.passes, reviews: c.reviews })}</Label>}
      </CardBody>
    </ContentCard>
  );
  return (
    <>
      {edited ? <Enter key="card">{content}</Enter> : content}
      {deleting && (
        <ConfirmDialog
          title={entry.kind === "command" ? t("Delete this command?") : t("Delete this guideline?")}
          text={entry.kind === "guideline" ? t("Its counts are lost; if the problem comes back, Flowly learns it again. Pause or Archive keeps them. A copy is kept in the plugin's data folder.") : t("A copy is kept in the plugin's data folder.")}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await actions.remove(entry);
            setDeleting(false);
          }}
        />
      )}
    </>
  );
});

export function ConfirmDialog({ title, text, onClose, onConfirm }: { title: string; text: string; onClose(): void; onConfirm(): Promise<void> }) {
  const theme = useTheme();
  const [pending, setPending] = useState(false);
  return (
    <Modal open title={title} onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Label>{text}</Label>
            <Actions>
              <Button quiet disabled={pending} onPress={onClose}>{t("Cancel")}</Button>
              <Button
                danger
                icon="Trash2"
                disabled={pending}
                onPress={async () => {
                  setPending(true);
                  await onConfirm();
                  setPending(false);
                }}
              >
                {t("Delete")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** The inline editor frame shared by commands, guidelines and the Memory page. */
export function Editor({ title, submit, valid, onCancel, onSubmit, children }: { title: string; submit: string; valid: boolean; onCancel(): void; onSubmit(): Promise<unknown>; children: ReactNode }) {
  const { colors } = useTheme();
  const [pending, setPending] = useState(false);
  const go = async () => {
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSubmit();
    } finally {
      setPending(false);
    }
  };
  return (
    <View style={{ gap: space[3], padding: space[3], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.surface1 }}>
      <Label bold size={font.md}>{title}</Label>
      {children}
      <Actions>
        <Button quiet disabled={pending} onPress={onCancel}>{t("Cancel")}</Button>
        <Button primary icon="Check" disabled={!valid || pending} onPress={() => void go()}>{submit}</Button>
      </Actions>
    </View>
  );
}

function CommandEditor({ title, submit, initial, onCancel, onSubmit }: { title: string; submit: string; initial: CommandDraft; onCancel(): void; onSubmit(d: CommandDraft): Promise<unknown> }) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<CommandDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const timeout = Number(draft.timeout);
  const valid = !!draft.name.trim() && splitCommand(draft.command).length > 0 && (!draft.timeout || (Number.isInteger(timeout) && timeout >= guardrailLimits.minTimeout && timeout <= guardrailLimits.maxTimeout));
  return (
    <Editor title={title} submit={submit} valid={valid} onCancel={onCancel} onSubmit={() => onSubmit(draft)}>
      <Field title={t("Name")} value={draft.name} onChange={(name) => set({ name })} placeholder="typecheck" autoFocus />
      <Field title={t("Command")} value={draft.command} onChange={(command) => set({ command })} placeholder="npm run typecheck" />
      <Field title={t("Timeout (seconds)")} value={draft.timeout} onChange={(value) => set({ timeout: value.replace(/\D/g, "") })} placeholder="600" />
    </Editor>
  );
}

function GuidelineEditor({ initial, onCancel, onSubmit }: { initial: GuidelineDraft; onCancel(): void; onSubmit(d: GuidelineDraft): Promise<unknown> }) {
  const [draft, setDraft] = useState(initial);
  return (
    <Editor title={t("Edit guideline")} submit={t("Save")} valid={!!draft.text.trim()} onCancel={onCancel} onSubmit={() => onSubmit(draft)}>
      <Field title={t("Guideline")} value={draft.text} onChange={(text) => setDraft((d) => ({ ...d, text }))} multiline autoFocus />
      <Field title={t("Details")} value={draft.body} onChange={(body) => setDraft((d) => ({ ...d, body }))} multiline />
    </Editor>
  );
}

const stateRank: Record<GuardrailState, number> = { active: 0, observing: 0, paused: 1, archived: 2 };

/** The project's Guardrails page (§7.4). Replaces the board area while open, like Ideas and Insights. */
export const GuardrailsPage = memo(function GuardrailsPage({
  project,
  tasks,
  compact,
  nameOf,
  onOpenTask,
  onBack,
}: {
  project: Project;
  /** The project's cards, archived included. */
  tasks: readonly Task[];
  compact: boolean;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
  onBack(): void;
}) {
  usePerfRender("project.guardrails.render");
  const { colors } = useTheme();
  const query = useGuardrailsQuery(project.id, true);
  const view = query.data;
  const actions = useGuardrailActions(project.id);
  const [segment, setSegment] = useState<Segment>("guideline");
  const [adding, setAdding] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const entries = view?.entries ?? noEntries;
  const cards = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks]);
  const disabled = !!project.archivedAt || !view?.enabled;
  const ofKind = (kind: GuardrailKind) => entries.filter((e) => e.kind === kind);
  const liveCount = (kind: GuardrailKind) => ofKind(kind).filter(live).length;
  const shown = ofKind(segment)
    .sort((a, b) => stateRank[a.state] - stateRank[b.state] || Number(!!b.pinned) - Number(!!a.pinned) || b.stateAt.localeCompare(a.stateAt));
  const groups = { active: shown.filter(live), paused: shown.filter((e) => e.state === "paused"), archived: shown.filter((e) => e.state === "archived") };
  const listed = [...groups.active, ...groups.paused, ...(archivedOpen ? groups.archived : [])];
  const pageRows = usePageRows(JSON.stringify([project.id, segment, archivedOpen]), listed.length, compact);
  const [keptRows, setKeptRows] = useState<ReadonlySet<string>>(() => new Set());
  const keepRow = (id: string) => setKeptRows((previous) => (previous.has(id) ? previous : new Set([...previous, id])));
  const windowed = new Set(keepPageRows(listed, pageRows.limit, keptRows).map((e) => e.id));
  const inWindow = (rows: readonly GuardrailEntry[]) => rows.filter((e) => windowed.has(e.id));
  const remaining = listed.length - windowed.size;
  const card = (e: GuardrailEntry, leaving: boolean) => (
    <GuardrailCard entry={e} actions={actions} disabled={disabled || leaving} cards={cards} nameOf={nameOf} onOpenTask={onOpenTask} onEditorOpen={keepRow} />
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: pageBarHeight, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}</Button>
        <View style={{ flex: 1 }} />
        <Icon name="ShieldCheck" size={15} color={colors.foregroundMuted} />
        <Label bold size={font.md} selectable={false}>
          {t("Guardrails")}</Label>
        <View style={{ flex: 1 }} />
        <View style={{ width: compact ? 56 : 72 }} />
      </View>
      <ScrollView {...verticalScroll} keyboardShouldPersistTaps="handled" onScroll={pageRows.onScroll} scrollEventThrottle={100} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: 760, gap: space[3] }}>
          {query.error && <Notice>{message(query.error)}</Notice>}
          {view && !view.enabled && <Notice tone="info">{t("Guardrails are off for this project. Turn them on in the project's settings; what is here is kept.")}</Notice>}
          <Choices
            title={t("Guardrails")}
            hideTitle
            value={segment}
            options={[
              { value: "command", label: t("Commands {n}", { n: liveCount("command") }) },
              { value: "guideline", label: t("Guidelines {n}", { n: liveCount("guideline") }) },
            ]}
            onChange={(next) => {
              setSegment(next);
              setAdding(false);
            }}
          />
          {segment === "command" && !disabled && !adding && (
            <View style={{ flexDirection: "row" }}>
              <Button small quiet icon="Plus" onPress={() => setAdding(true)}>
                {t("Add command")}</Button>
            </View>
          )}
          <Collapse open={adding && segment === "command"} id="add-command">
            <CommandEditor title={t("Add command")} submit={t("Add")} initial={{ name: "", command: "", timeout: "" }} onCancel={() => setAdding(false)} onSubmit={async (d) => (await actions.addCommand(d)) && setAdding(false)} />
          </Collapse>
          <Enter key={segment} distance={0}>
            <View style={{ gap: space[1] }}>
              <GuardrailRows
                entries={inWindow(groups.active)}
                render={card}
                empty={
                  <View style={{ alignItems: "center", gap: space[2], paddingVertical: space[6] }}>
                    <Icon name="ShieldCheck" size={22} color={colors.foregroundMuted} />
                    <Label muted size={font.md}>
                      {segment === "guideline" ? t("Nothing learned yet. Send a card back with what is wrong; Flowly checks the next cards for it.") : t("No commands yet.")}
                    </Label>
                  </View>
                }
              />
              <GuardrailRows entries={inWindow(groups.paused)} render={card} before={<GroupTitle title={t("Paused · {n}", { n: groups.paused.length })} />} />
              {!!groups.archived.length && (
                <View style={{ gap: space[2] }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: archivedOpen }}
                    onPress={() => setArchivedOpen(!archivedOpen)}
                    style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 36 : 24 }}
                  >
                    <Chevron open={archivedOpen} title="archived" color={colors.foregroundMuted} size={14} />
                    <Label bold size={font.md} selectable={false}>{t("Archived · {n}", { n: groups.archived.length })}</Label>
                  </Pressable>
                  <Collapse open={archivedOpen} id={`archived-${segment}`}>
                    <GuardrailRows entries={inWindow(groups.archived)} render={card} />
                  </Collapse>
                </View>
              )}
            </View>
          </Enter>
          {remaining > 0 && <Button small quiet onPress={pageRows.more}>{t("Show more ({n})", { n: remaining })}</Button>}
        </View>
      </ScrollView>
    </View>
  );
});
const noEntries: GuardrailEntry[] = [];

function GroupTitle({ title }: { title: string }) {
  return <Label bold size={font.md} selectable={false}>{title}</Label>;
}

/**
 * A list of guardrail cards that behaves like the Ideas list: a card that leaves it (paused, archived, restored,
 * deleted) collapses away in place, and one that arrives rises in. `before` (a title) shows while any row is on screen.
 */
function GuardrailRows({ entries, render, before, empty }: { entries: readonly GuardrailEntry[]; render(entry: GuardrailEntry, leaving: boolean): ReactNode; before?: ReactNode; empty?: ReactNode }) {
  const rows = useExitList(entries);
  if (!rows.length) return <>{empty}</>;
  const body = rows.map((row) => (
    <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering}>
      {render(row.item, row.leaving)}
    </IdeaRow>
  ));
  return before ? <View style={{ gap: space[2] }}>{before}<View>{body}</View></View> : <View>{body}</View>;
}
