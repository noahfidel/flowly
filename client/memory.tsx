import { usePerfRender } from "./perf";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Project, Status, Task } from "../shared/model";
import { agentsRule, memoryKinds, type MemoryKind } from "../shared/memory";
import type { GuardrailEntry, GuardrailState } from "../shared/guardrails";
import type { BoardView, MemorySort } from "../shared/settings";
import { cardFrameStyle, SourceLine } from "./content-card";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { Chevron, Collapse } from "./disclosure";
import { ConfirmDialog, Editor, reasonText, useGuardrailActions, type NoteDraft } from "./guardrails";
import { estimateHeight, gridColumns, placeMasonry, sortNotes } from "./memory-layout";
import { Modal } from "./modal";
import { Enter, useMotionValue } from "./motion";
import { keepPageRows, usePageRows } from "./page-rows";
import { useGuardrailsQuery } from "./queries";
import { useStableCallback } from "./stable";
import { IdeaRow, useExitList } from "./task-ideas";
import { Actions, Button, Choices, Dot, Field, IconButton, Label, Notice, Theme, Toggle, font, message, noFocusRing, pageBarHeight, radius, space, tint, touch, useTheme, verticalContent, verticalScroll } from "./ui";
import { t, msg, tn } from "../shared/i18n";

/** The Memory page (GUARDRAILS-SPEC §7.4, D10): the project's `note` entries, kept apart from the Guardrails page. */

export const kindLabels: Record<MemoryKind, string> = { decision: msg("Decision"), convention: msg("Convention"), pitfall: msg("Pitfall"), contact: msg("Contact") };
export const kindIcons: Record<MemoryKind, string> = { decision: "Gavel", convention: "ListChecks", pitfall: "TriangleAlert", contact: "Contact" };
/** The filter chips' order. */
const kindOrder: readonly MemoryKind[] = ["decision", "pitfall", "convention", "contact"];
/** One host theme color per kind, for the card's left edge and its kind label. */
export const kindColor = (colors: PluginTheme["colors"], kind: MemoryKind) =>
  ({ decision: colors.accent, pitfall: colors.statusWarning, convention: colors.statusSuccess, contact: colors.foregroundMuted })[kind];
const sortLabels: Record<MemorySort, string> = { newest: msg("Newest"), used: msg("Most used"), recent: msg("Recently used") };
const sortOrder: readonly MemorySort[] = ["newest", "used", "recent"];

export type MemoryPrefs = Pick<BoardView, "memoryKind" | "memorySort" | "memoryLayout">;

/** What a card can do; identities stay the same across renders so cards stay memoized. */
type Ops = {
  save(e: GuardrailEntry, d: NoteDraft): Promise<boolean>;
  pin(e: GuardrailEntry, pinned: boolean): Promise<boolean>;
  setState(e: GuardrailEntry, state: GuardrailState, reason?: string): Promise<boolean>;
  remove(e: GuardrailEntry): Promise<boolean>;
  copyRule(e: GuardrailEntry): Promise<void>;
  openTask(id: string): void;
  keep(id: string): void;
};

const draftOf = (e?: GuardrailEntry): NoteDraft => ({
  kind: e?.noteKind ?? "decision",
  title: e?.text ?? "",
  body: e?.body ?? "",
  tags: (e?.tags ?? []).join(", "),
  keywords: (e?.keywords ?? []).join(", "),
  pinned: !!e?.pinned,
});

const MemoryCard = memo(function MemoryCard({ entry, ops, busy, compact, source, nameOf }: { entry: GuardrailEntry; ops: Ops; busy: boolean; compact: boolean; source: Task | undefined; nameOf(status: Status): string }) {
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const [editing, setEditing] = useState(false);
  // Once edited, the card rises back in when the editor closes; on first render it just sits there.
  const [edited, setEdited] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Kept only while the page is open.
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Desktop shows the menu button on hover or keyboard focus; touch and compact layouts always show it.
  const actionOpacity = useMotionValue(touch || compact || hovered || focused ? 1 : 0);
  const closeEditor = () => {
    setEdited(true);
    setEditing(false);
  };
  if (editing)
    return (
      <Enter key="editor">
        <NoteEditor title={t("Edit memory")} submit={t("Save")} initial={draftOf(entry)} onCancel={closeEditor} onSubmit={async (d) => (await ops.save(entry, d)) && closeEditor()} />
      </Enter>
    );
  const archived = entry.state === "archived";
  const kind = entry.noteKind ?? "decision";
  const color = kindColor(colors, kind);
  const items = (): MenuEntry[] => [
    ...(archived
      ? [{ id: "restore", label: t("Restore"), icon: "ArchiveRestore", onPress: () => void ops.setState(entry, "active") }]
      : [
          { id: "edit", label: t("Edit"), icon: "Pencil", onPress: () => { ops.keep(entry.id); setEditing(true); } },
          entry.pinned
            ? { id: "unpin", label: t("Unpin"), icon: "PinOff", onPress: () => void ops.pin(entry, false) }
            : { id: "pin", label: t("Pin: every new session sees it"), icon: "Pin", onPress: () => void ops.pin(entry, true) },
          { id: "agents", label: t("Copy as AGENTS.md rule"), icon: "Copy", onPress: () => setPromoting(true) },
          { id: "archive", label: t("Archive"), icon: "Archive", onPress: () => void ops.setState(entry, "archived") },
        ]),
    { kind: "separator", id: "s" },
    { id: "delete", label: t("Delete…"), icon: "Trash2", danger: true, onPress: () => setDeleting(true) },
  ];
  const sourceId = entry.source?.taskId ?? entry.sources[0]?.taskId;
  const reason = entry.state !== "active" ? reasonText(entry.stateReason) : "";
  const cards = new Set(entry.counts.usedBy.map((u) => u.taskId)).size;
  const facts = [entry.tags?.length ? entry.tags.map((tag) => `#${tag}`).join(" ") : "", entry.counts.usedAt ? tn(cards, "Used by {n} card", "Used by {n} cards") : ""].filter(Boolean).join(" · ");
  const content = (
    <Pressable
      accessibilityRole={entry.body ? "button" : undefined}
      accessibilityState={entry.body ? { expanded } : undefined}
      accessibilityHint={entry.body ? (expanded ? t("Show less") : t("Show more")) : undefined}
      onPress={entry.body ? () => setExpanded(!expanded) : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      {...menuHandlers(busy ? null : openMenu, entry.text, items)}
      style={[cardFrameStyle(colors), noFocusRing, { borderLeftWidth: 2, borderLeftColor: color, padding: space[4], gap: space[2] }]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 24 }}>
        <Dot size={6} color={color} />
        <Label muted size={font.xs} selectable={false}>{t(kindLabels[kind])}</Label>
        {!!reason && <Label muted size={font.xs} selectable={false}>· {reason}</Label>}
        <View style={{ flex: 1 }} />
        {entry.pinned && <Icon name="Pin" size={13} color={colors.foregroundMuted} />}
        {openMenu && (
          <Animated.View style={{ opacity: actionOpacity, marginRight: -space[1.5] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Actions for {title}", { title: entry.text })}
              disabled={busy}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onPress={(event) => openMenu(eventPoint(event), entry.text, items())}
              hitSlop={touch ? 8 : 4}
              style={(state) => {
                const { pressed, hovered: over } = state as typeof state & { hovered?: boolean };
                return { ...noFocusRing, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: pressed || over || focused ? colors.surface2 : "transparent", opacity: busy ? 0.4 : 1 };
              }}
            >
              <Icon name="Ellipsis" size={15} color={colors.foregroundMuted} />
            </Pressable>
          </Animated.View>
        )}
      </View>
      <Label bold size={font.md}>{entry.text}</Label>
      {!!entry.body && <BodyText text={entry.body} lines={expanded ? undefined : 6} />}
      {!!sourceId && (
        <View style={{ marginHorizontal: -space[3], marginBottom: -space[1.5] }}>
          <SourceLine task={source} nameOf={nameOf} onOpenTask={ops.openTask} />
        </View>
      )}
      {!!facts && <Label muted size={font.xs} selectable={false}>{facts}</Label>}
    </Pressable>
  );
  return (
    <>
      {edited ? <Enter key="card">{content}</Enter> : content}
      {promoting && <PromoteDialog entry={entry} ops={ops} onClose={() => setPromoting(false)} />}
      {deleting && (
        <ConfirmDialog
          title={t("Delete this memory?")}
          text={t("New sessions will no longer see it. A copy is kept in the plugin's data folder.")}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await ops.remove(entry);
            setDeleting(false);
          }}
        />
      )}
    </>
  );
});

/** The card body: 12 pt at 1.5 line height, clamped to `lines` while folded. */
function BodyText({ text, lines }: { text: string; lines?: number }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={lines} style={{ color: colors.foreground, fontSize: font.sm, lineHeight: Math.round(font.sm * 1.5) }}>
      {text}
    </Text>
  );
}

/** Copy the memory as an AGENTS.md rule, paste it there, then stop injecting it (archived as promoted). */
function PromoteDialog({ entry, ops, onClose }: { entry: GuardrailEntry; ops: Ops; onClose(): void }) {
  const theme = useTheme();
  return (
    <Modal open title={t("Move to AGENTS.md")} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Theme.Provider value={theme}>
          <View style={{ gap: space[3] }}>
            <Label>{t("Every session of this repository reads AGENTS.md, inside Flowly or not. Flowly does not edit repository files: copy the rule, paste it where it belongs, then stop injecting it here so it is not said twice.")}</Label>
            <View style={{ padding: space[2], borderRadius: radius.md, backgroundColor: theme.colors.surface2 }}>
              <Label mono size={font.sm} selectable>{agentsRule({ title: entry.text, body: entry.body || "" })}</Label>
            </View>
            <Actions>
              <Button quiet onPress={onClose}>{t("Cancel")}</Button>
              <Button quiet icon="Copy" onPress={() => void ops.copyRule(entry)}>{t("Copy rule")}</Button>
              <Button
                primary
                icon="Check"
                onPress={async () => {
                  await ops.setState(entry, "archived", "promoted");
                  onClose();
                }}
              >
                {t("Done, stop injecting")}</Button>
            </Actions>
          </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

function NoteEditor({ title, submit, initial, adding = false, onCancel, onSubmit }: { title: string; submit: string; initial: NoteDraft; adding?: boolean; onCancel(): void; onSubmit(d: NoteDraft): Promise<unknown> }) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<NoteDraft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Editor title={title} submit={submit} valid={!!draft.title.trim()} onCancel={onCancel} onSubmit={() => onSubmit(draft)}>
      {/* The kind is set when the memory is added; guardrails.update does not change it. */}
      {adding && <Choices title={t("Kind")} value={draft.kind} options={memoryKinds.map((k) => ({ value: k, label: t(kindLabels[k]) }))} onChange={(kind) => set({ kind })} />}
      <Field title={t("Title")} value={draft.title} onChange={(value) => set({ title: value })} placeholder={t("The rule or fact itself")} autoFocus />
      <Field title={t("Details")} value={draft.body} onChange={(value) => set({ body: value })} multiline placeholder={t("What and why, or the symptom and how to avoid it. Never a secret.")} />
      <Field title={t("Tags")} value={draft.tags} onChange={(value) => set({ tags: value })} placeholder={t("Comma-separated, e.g. drawer, mobile")} />
      <Field title={t("Search words")} value={draft.keywords} onChange={(value) => set({ keywords: value })} placeholder={t("Comma-separated")} />
      <Toggle title={t("Pin")} value={draft.pinned} onChange={(pinned) => set({ pinned })} />
    </Editor>
  );
}

/** The project's Memory page. Replaces the board area while open, like Ideas and Guardrails. */
export const MemoryPage = memo(function MemoryPage({
  project,
  tasks,
  compact,
  prefs,
  nameOf,
  onPrefs,
  onOpenTask,
  onBack,
}: {
  project: Project;
  /** The project's cards, archived included. */
  tasks: readonly Task[];
  compact: boolean;
  /** Kind filter, sort and layout, remembered per host (board-view settings). */
  prefs: MemoryPrefs;
  nameOf(status: Status): string;
  onPrefs(patch: Partial<MemoryPrefs>): void;
  onOpenTask(id: string): void;
  onBack(): void;
}) {
  usePerfRender("project.memory.render");
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const query = useGuardrailsQuery(project.id, true);
  const view = query.data;
  const actions = useGuardrailActions(project.id);
  const [adding, setAdding] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const disabled = !!project.archivedAt || !view?.enabled;
  const grid = !compact && prefs.memoryLayout === "grid";
  const cards = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks]);
  const entries = view?.entries ?? noEntries;
  const { live, archived } = useMemo(() => {
    const notes = entries.filter((e) => e.kind === "note" && (prefs.memoryKind === "all" || e.noteKind === prefs.memoryKind));
    return { live: sortNotes(notes.filter((e) => e.state !== "archived"), prefs.memorySort), archived: sortNotes(notes.filter((e) => e.state === "archived"), "newest") };
  }, [entries, prefs.memoryKind, prefs.memorySort]);
  const anyNotes = entries.some((e) => e.kind === "note");
  const listed = [...live, ...(archivedOpen ? archived : [])];
  const pageRows = usePageRows(JSON.stringify([project.id, prefs.memoryKind, prefs.memorySort, archivedOpen]), listed.length, compact);
  const [keptRows, setKeptRows] = useState<ReadonlySet<string>>(() => new Set());
  const windowed = new Set(keepPageRows(listed, pageRows.limit, keptRows).map((e) => e.id));
  const inWindow = (rows: readonly GuardrailEntry[]) => rows.filter((e) => windowed.has(e.id));
  const remaining = listed.length - windowed.size;
  const keep = useStableCallback((id: string) => setKeptRows((previous) => (previous.has(id) ? previous : new Set([...previous, id]))));
  const save = useStableCallback((e: GuardrailEntry, d: NoteDraft) => actions.saveNote(e, d));
  const pin = useStableCallback((e: GuardrailEntry, pinned: boolean) => actions.pin(e, pinned));
  const setState = useStableCallback((e: GuardrailEntry, state: GuardrailState, reason?: string) => actions.setState(e, state, reason));
  const remove = useStableCallback((e: GuardrailEntry) => actions.remove(e));
  const copyRule = useStableCallback((e: GuardrailEntry) => actions.copyRule(e));
  const openTask = useStableCallback((id: string) => onOpenTask(id));
  const ops = useMemo<Ops>(() => ({ save, pin, setState, remove, copyRule, openTask, keep }), []);
  const card = (e: GuardrailEntry, leaving: boolean) => {
    const sourceId = e.source?.taskId ?? e.sources[0]?.taskId;
    return <MemoryCard entry={e} ops={ops} busy={disabled || leaving || actions.busy === e.id} compact={compact} source={sourceId ? cards.get(sourceId) : undefined} nameOf={nameOf} />;
  };
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: pageBarHeight, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}</Button>
        <View style={{ flex: 1 }} />
        <Icon name="BookMarked" size={15} color={colors.foregroundMuted} />
        <Label bold size={font.md} selectable={false}>
          {t("Memory")}</Label>
        <View style={{ flex: 1 }} />
        <View style={{ width: compact ? 56 : 72 }} />
      </View>
      <ScrollView {...verticalScroll} keyboardShouldPersistTaps="handled" onScroll={pageRows.onScroll} scrollEventThrottle={100} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}>
        <View onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ width: "100%", maxWidth: grid ? 1120 : 760, gap: space[3] }}>
          {query.error && <Notice>{message(query.error)}</Notice>}
          {view && !view.enabled && <Notice tone="info">{t("Guardrails are off for this project. Turn them on in the project's settings; what is here is kept.")}</Notice>}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
              <FilterChip on={prefs.memoryKind === "all"} label={t("All")} onPress={() => onPrefs({ memoryKind: "all" })} />
              {kindOrder.map((k) => (
                <FilterChip key={k} on={prefs.memoryKind === k} icon={kindIcons[k]} iconColor={kindColor(colors, k)} label={t(kindLabels[k])} onPress={() => onPrefs({ memoryKind: prefs.memoryKind === k ? "all" : k })} />
              ))}
            </View>
            <Button
              small
              quiet
              icon="ArrowDownUp"
              label={t("Sort: {order}", { order: t(sortLabels[prefs.memorySort]) })}
              onPress={(event) =>
                openMenu
                  ? openMenu(
                      eventPoint(event),
                      t("Sort"),
                      sortOrder.map((s) => ({ id: s, label: t(sortLabels[s]), checked: prefs.memorySort === s, onPress: () => onPrefs({ memorySort: s }) })),
                    )
                  : onPrefs({ memorySort: sortOrder[(sortOrder.indexOf(prefs.memorySort) + 1) % sortOrder.length] })
              }
            >
              {t(sortLabels[prefs.memorySort])}</Button>
            {!compact && (
              <View style={{ flexDirection: "row" }}>
                <IconButton icon="List" label={t("List")} active={!grid} onPress={() => onPrefs({ memoryLayout: "list" })} />
                <IconButton icon="LayoutGrid" label={t("Grid")} active={grid} onPress={() => onPrefs({ memoryLayout: "grid" })} />
              </View>
            )}
          </View>
          {!disabled && !adding && (
            <View style={{ flexDirection: "row" }}>
              <Button small quiet icon="Plus" onPress={() => setAdding(true)}>
                {t("Add memory")}</Button>
            </View>
          )}
          <Collapse open={adding} id="add-memory">
            <NoteEditor
              title={t("Add memory")}
              submit={t("Add")}
              adding
              initial={{ ...draftOf(), kind: prefs.memoryKind === "all" ? "decision" : prefs.memoryKind }}
              onCancel={() => setAdding(false)}
              onSubmit={async (d) => (await actions.addNote(d)) && setAdding(false)}
            />
          </Collapse>
          <Enter key={`${prefs.memoryKind}-${prefs.memorySort}-${grid}`} distance={0}>
            <View style={{ gap: space[1] }}>
              {!live.length ? (
                <View style={{ alignItems: "center", gap: space[2], paddingVertical: space[6] }}>
                  <Icon name="BookMarked" size={22} color={colors.foregroundMuted} />
                  <Label muted size={font.md}>
                    {anyNotes ? t("No matching memories.") : t("No memory yet. Agents remember decisions, pitfalls and conventions as they work; you can add one too.")}</Label>
                </View>
              ) : grid && width ? (
                <MemoryGrid entries={inWindow(live)} width={width} layoutKey={`${prefs.memoryKind}-${prefs.memorySort}`} render={card} />
              ) : (
                <MemoryRows entries={inWindow(live)} render={card} />
              )}
              {!!archived.length && (
                <View style={{ gap: space[2] }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: archivedOpen }}
                    onPress={() => setArchivedOpen(!archivedOpen)}
                    style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1], minHeight: touch ? 36 : 24 }}
                  >
                    <Chevron open={archivedOpen} title="archived" color={colors.foregroundMuted} size={14} />
                    <Label bold size={font.md} selectable={false}>{t("Archived · {n}", { n: archived.length })}</Label>
                  </Pressable>
                  <Collapse open={archivedOpen} id="archived-memory">
                    {grid && width ? <MemoryGrid entries={inWindow(archived)} width={width} layoutKey="archived" render={card} /> : <MemoryRows entries={inWindow(archived)} render={card} />}
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

/** A list of memory cards like the Ideas list: a card that leaves collapses away in place, one that arrives rises in. */
function MemoryRows({ entries, spacing, render }: { entries: readonly GuardrailEntry[]; spacing?: number; render(entry: GuardrailEntry, leaving: boolean): ReactNode }) {
  const rows = useExitList(entries);
  return (
    <View>
      {rows.map((row) => (
        <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} spacing={spacing}>
          {render(row.item, row.leaving)}
        </IdeaRow>
      ))}
    </View>
  );
}

/**
 * Keep-style masonry: columns by width, each card into the shortest column by its estimated height.
 * Cards keep their column across refreshes; a new filter or sort (`layoutKey`) or column count lays them out again.
 */
const gutter = space[4];

function MemoryGrid({ entries, width, layoutKey, render }: { entries: readonly GuardrailEntry[]; width: number; layoutKey: string; render(entry: GuardrailEntry, leaving: boolean): ReactNode }) {
  const columns = gridColumns(width);
  const columnWidth = (width - gutter * (columns - 1)) / columns;
  const placed = useRef<{ key: string; at: Map<string, number> }>({ key: "", at: new Map() });
  const key = `${layoutKey}|${columns}`;
  const previous = placed.current.key === key ? placed.current.at : undefined;
  const laid = placeMasonry(entries, columns, (e) => estimateHeight(e, columnWidth), previous);
  placed.current = { key, at: new Map(laid.flatMap((column, index) => column.map((e) => [e.id, index] as const))) };
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: gutter }}>
      {laid.map((column, index) => (
        <View key={index} style={{ flex: 1, minWidth: 0 }}>
          <MemoryRows entries={column} spacing={gutter} render={render} />
        </View>
      ))}
    </View>
  );
}

function FilterChip({ on, icon, iconColor, label, onPress }: { on: boolean; icon?: string; iconColor?: string; label: string; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={touch ? 6 : 0}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1],
        height: touch ? 32 : 26,
        paddingHorizontal: space[2],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: on ? colors.accent : colors.border,
        backgroundColor: on ? tint(colors.accent, 0.12) : pressed || hovered ? colors.surface2 : "transparent",
      })}
    >
      {!!icon && <Icon name={icon} size={12} color={iconColor ?? colors.foregroundMuted} />}
      <Label size={font.sm} color={on ? colors.accent : undefined} muted={!on} selectable={false}>
        {label}
      </Label>
    </Pressable>
  );
}
