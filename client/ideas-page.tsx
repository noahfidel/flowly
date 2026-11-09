import { usePerfRender } from "./perf";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { enabledStatuses } from "../shared/lanes";
import type { Idea, Project, Status, Task } from "../shared/model";
import { eventPoint, useMenuOpener } from "./context-menu";
import { groupByCard, ideaTabCounts, visibleIdeas, type IdeaQuery, type IdeaSort, type IdeaTab } from "./idea-rows";
import { SourceLine } from "./content-card";
import { IdeasImportModal } from "./ideas-import";
import { Enter } from "./motion";
import { usePageRows } from "./page-rows";
import { StatusIcon } from "./status";
import { ClosedIdea, IdeaCard, IdeaRow, sessionName, useExitList, useIdeaActions, type IdeaOther, type IdeaSession } from "./task-ideas";
import { AiMark, Button, Choices, Label, TextBox, font, radius, space, tint, touch, useTheme, verticalContent, verticalScroll, noFocusRing, pageBarHeight } from "./ui";
import { t, msg, tn } from "../shared/i18n";

const sortLabels: Record<IdeaSort, string> = { newest: msg("Newest"), priority: msg("Priority"), card: msg("Card") };
/** Closed segments grow by this many rows at a time. */
const PAGE = 50;

/**
 * Project Ideas page (IDEAS-INBOX-SPEC §4): every card's ideas, including
 * those of finished and archived cards. Replaces the board area while open,
 * like Insights. Actions are the drawer's (useIdeaActions).
 */
export const IdeasPage = memo(function IdeasPage({
  project,
  tasks,
  ideas,
  compact,
  cardFilter,
  nameOf,
  sessionsOf,
  onCardFilter,
  onOpenTask,
  onCreate,
  onNewSession,
  onDiscuss,
  onBack,
}: {
  project: Project;
  /** The project's cards, archived included. */
  tasks: readonly Task[];
  /** The project's ideas. */
  ideas: readonly Idea[];
  compact: boolean;
  /** Only this card's ideas ("All ideas" from a card); blank for all. */
  cardFilter: string;
  nameOf(status: Status): string;
  sessionsOf(taskId: string): readonly IdeaSession[];
  onCardFilter(taskId: string): void;
  onOpenTask(id: string): void;
  onCreate(idea: Idea, other?: IdeaOther): void;
  onNewSession(idea: Idea): void;
  /** Puts a draft about the idea in the dispatcher chat (DISPATCHER-SPEC §9.5); absent: no Discuss. */
  onDiscuss?(idea: Idea): void;
  onBack(): void;
}) {
  usePerfRender("project.ideas.render");
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const [tab, setTab] = useState<IdeaTab>("open");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<IdeaSort>("newest");
  const [grouped, setGrouped] = useState(false);
  const [scopes, setScopes] = useState<ReadonlySet<"here" | "new">>(() => new Set());
  const [finishedOnly, setFinishedOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [importing, setImporting] = useState(false);
  const actions = useIdeaActions({ sessionsOf, onCreate, onNewSession, ideas, tasks });
  const { hidden } = actions;
  const lanes = useMemo(() => enabledStatuses(project), [project]);
  const cards = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Ideas closed here but not yet on the board read as closed (optimistic).
  const effective = useMemo(
    () => (hidden.size ? ideas.map((i) => (hidden.has(i.id) && i.status === "open" ? { ...i, status: "dismissed" as const } : i)) : ideas),
    [ideas, hidden],
  );
  const scoped = useMemo(() => (cardFilter ? effective.filter((i) => i.taskId === cardFilter) : effective), [effective, cardFilter]);
  const counts = ideaTabCounts(scoped);
  const query: IdeaQuery = { tab, search: search.toLowerCase(), scopes, finishedOnly, taskId: cardFilter, sort };
  const list = useMemo(
    () => visibleIdeas(effective, tasks, lanes, query),
    // `query` is rebuilt every render; its parts are the dependencies.
    [effective, tasks, lanes, tab, search, scopes, finishedOnly, cardFilter, sort],
  );
  const pageRows = usePageRows(JSON.stringify([project.id, tab, search, [...scopes], finishedOnly, cardFilter, sort, grouped]), list.length, compact);
  const filtered = !!(search.trim() || scopes.size || finishedOnly || cardFilter);
  const clearFilters = () => {
    setSearch("");
    setScopes(new Set());
    setFinishedOnly(false);
    onCardFilter("");
  };
  const toggleScope = (scope: "here" | "new") =>
    setScopes((current) => {
      const next = new Set(current);
      if (!next.delete(scope)) next.add(scope);
      return next;
    });
  const source = (taskId: string | undefined) => taskId && cards.has(taskId) ? <SourceLine task={cards.get(taskId)} nameOf={nameOf} onOpenTask={onOpenTask} /> : undefined;
  const cardTitle = (id: string) => cards.get(id)?.title;
  const renderOpen = (rows: ExitRows) =>
    rows.map((row) => (
      <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} restored={actions.restored.has(row.item.id)} spacing={space[3]}>
        <IdeaCard
          idea={row.item}
          disabled={!!project.archivedAt || row.leaving}
          source={grouped ? undefined : source(row.item.taskId)}
          onGood={actions.choose}
          onDismiss={actions.dismiss}
          onDiscuss={onDiscuss}
        />
      </IdeaRow>
    ));
  // A restored idea collapses out of the closed list; rows never rise in here, so "Show more" does not animate dozens at once.
  const renderClosed = (rows: ExitRows) =>
    rows.map((row) => (
      <IdeaRow key={row.item.id} leaving={row.leaving} entering={false} spacing={space[2]}>
        <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, paddingHorizontal: space[3] }}>
          <ClosedIdea
            idea={row.item}
            acceptedTitle={row.item.acceptedTaskId ? cardTitle(row.item.acceptedTaskId) : undefined}
            sentTo={row.item.acceptedAgentId && row.item.taskId ? sessionName(sessionsOf(row.item.taskId), row.item.acceptedAgentId) : undefined}
            disabled={!!project.archivedAt || !!actions.restoring || row.leaving}
            onOpenTask={onOpenTask}
            onRestore={actions.restore}
          />
          {!grouped && <View style={{ marginHorizontal: -space[3] }}>{source(row.item.taskId)}</View>}
        </View>
      </IdeaRow>
    ));
  const closedRows = tab === "open" ? noIdeas : list.slice(0, compact ? pageRows.limit : shown);
  const renderGroups = <T extends { taskId?: string }>(rows: readonly T[], render: (rows: T[]) => ReactNode) =>
    groupByCard(rows).map((group) => (
      <View key={group.taskId ?? "project"} style={{ gap: space[1.5], marginBottom: space[2] }}>
        <GroupHeader task={group.taskId ? cards.get(group.taskId) : undefined} project={group.taskId === null} count={compact ? list.filter((idea) => (idea.taskId ?? null) === group.taskId).length : group.ideas.length} nameOf={nameOf} onOpenTask={onOpenTask} />
        {render(group.ideas)}
      </View>
    ));
  const emptyState = (
    <View style={{ alignItems: "center", gap: space[2], paddingVertical: space[6] }}>
      <Icon name="Lightbulb" size={22} color={colors.foregroundMuted} />
      <Label muted size={font.md}>
        {!ideas.length ? t("No ideas yet. Agents propose next steps here as they work.") : t("No matching ideas.")}
      </Label>
      {!!ideas.length && filtered && (
        <Button small quiet onPress={clearFilters}>
          {t("Clear filters")}</Button>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          paddingHorizontal: space[3],
          height: pageBarHeight,
          borderBottomWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}</Button>
        <View style={{ flex: 1 }} />
        <Icon name="Lightbulb" size={15} color={colors.foregroundMuted} />
        <Label bold size={font.md} selectable={false}>
          {t("Ideas")}</Label>
        <AiMark label={t("AI generated")} />
        <View style={{ flex: 1 }} />
        {/* Import also balances the Back button so the title stays centred. */}
        <View style={{ minWidth: compact ? 56 : 72, alignItems: "flex-end" }}>
          {!project.archivedAt && (
            <Button quiet icon="Plus" label={t("Import ideas")} onPress={() => setImporting(true)}>
              {compact ? "" : t("Import")}
            </Button>
          )}
        </View>
      </View>
      <IdeasImportModal projectId={project.id} open={importing} onClose={() => setImporting(false)} />
      <ScrollView
        {...verticalScroll}
        keyboardShouldPersistTaps="handled"
        onScroll={pageRows.onScroll}
        scrollEventThrottle={100}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ ...verticalContent, padding: space[3], paddingBottom: space[6] * 2, alignItems: "center" }}
      >
        <View style={{ width: "100%", maxWidth: 760, gap: space[3] }}>
          <Choices
            title={t("Ideas")}
            hideTitle
            value={tab}
            options={[
              { value: "open", label: t("Open {open}", { open: counts.open }) },
              { value: "accepted", label: t("Accepted {accepted}", { accepted: counts.accepted }) },
              { value: "dismissed", label: t("Dismissed {dismissed}", { dismissed: counts.dismissed }) },
            ]}
            onChange={(next) => {
              setTab(next);
              setShown(PAGE);
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <TextBox
                value={search}
                onChangeText={setSearch}
                commitDelay={200}
                // Shortcuts are blocked while typing, so Esc is handled here to leave the page.
                onKeyPress={(event) => {
                  if (event.nativeEvent.key === "Escape") onBack();
                }}
                placeholder={t("Search ideas and cards")}
                accessibilityLabel={t("Search ideas")}
                style={{
                  height: touch ? 40 : 32,
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  color: colors.foreground,
                  fontSize: font.base,
                }}
              />
            </View>
            <Button
              small
              quiet
              icon="ArrowUpDown"
              label={t("Sort: {sort}", { sort: t(sortLabels[sort]) })}
              onPress={(event) =>
                openMenu
                  ? openMenu(
                      eventPoint(event),
                      t("Sort ideas"),
                      (Object.keys(sortLabels) as IdeaSort[]).map((value) => ({
                        id: value,
                        label: t(sortLabels[value]),
                        checked: value === sort,
                        onPress: () => setSort(value),
                      })),
                    )
                  : setSort(sort === "newest" ? "priority" : sort === "priority" ? "card" : "newest")
              }
            >
              {compact ? "" : t(sortLabels[sort])}
            </Button>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5] }}>
            {!!cardFilter && (
              <FilterChip
                on
                icon="X"
                label={t("Card: {title}", { title: cardTitle(cardFilter) || t("removed card") })}
                onPress={() => onCardFilter("")}
              />
            )}
            <FilterChip on={grouped} icon="Rows3" label={t("Group by card")} onPress={() => setGrouped(!grouped)} />
            <FilterChip on={scopes.has("here")} icon="CornerDownRight" label={t("Continues a task")} onPress={() => toggleScope("here")} />
            <FilterChip on={scopes.has("new")} icon="SquarePlus" label={t("New task")} onPress={() => toggleScope("new")} />
            <FilterChip on={finishedOnly} icon="CircleCheck" label={t("From finished cards")} onPress={() => setFinishedOnly(!finishedOnly)} />
          </View>
          <Enter key={tab} distance={0}>
            <View>
              {tab === "open" ? (
                // Mounted per visit, so rows already open do not rise in again.
                <OpenList
                  list={compact ? list.slice(0, pageRows.limit) : list}
                  empty={emptyState}
                  render={(rows) =>
                    grouped ? renderGroups(rows.map((r) => ({ ...r, taskId: r.item.taskId })), renderOpen) : renderOpen(rows)
                  }
                />
              ) : (
                // Changing a filter starts a fresh list instead of collapsing every row that stops matching.
                <OpenList
                  key={`${search}|${[...scopes].join()}|${finishedOnly}|${cardFilter}|${sort}|${grouped}`}
                  list={closedRows}
                  empty={emptyState}
                  render={(rows) =>
                    grouped ? renderGroups(rows.map((r) => ({ ...r, taskId: r.item.taskId })), renderClosed) : renderClosed(rows)
                  }
                />
              )}
              {(compact ? pageRows.remaining > 0 : tab !== "open" && list.length > shown) && (
                <View style={{ alignItems: "center" }}>
                  <Button small quiet onPress={compact ? pageRows.more : () => setShown(shown + PAGE)}>
                    {t("Show more ({n})", { n: compact ? pageRows.remaining : list.length - shown })}
                  </Button>
                </View>
              )}
            </View>
          </Enter>
        </View>
      </ScrollView>
    </View>
  );
});

const noIdeas: Idea[] = [];
type ExitRows = ReturnType<typeof useExitList<Idea>>;

/** The open segment: rows that leave collapse in place; new arrivals rise in. */
function OpenList({ list, empty, render }: { list: readonly Idea[]; empty: ReactNode; render(rows: ExitRows): ReactNode }) {
  const rows = useExitList(list);
  return <>{rows.length ? render(rows) : empty}</>;
}

function GroupHeader({ task, project, count, nameOf, onOpenTask }: { task: Task | undefined; /** The project's own ideas, no card. */ project: boolean; count: number; nameOf(status: Status): string; onOpenTask(id: string): void }) {
  const { colors } = useTheme();
  if (project)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: touch ? 40 : 30 }}>
        <Icon name="Lightbulb" size={14} color={colors.foregroundMuted} />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Label bold size={font.md} lines={1} selectable={false}>{t("Project")}</Label>
        </View>
        <Label muted size={font.sm} selectable={false}>{count}</Label>
      </View>
    );
  if (!task) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tn(count, "{title}, {state}, {n} idea. Open the card", "{title}, {state}, {n} ideas. Open the card", { title: task.title, state: task.archivedAt ? t("archived") : nameOf(task.status) })}
      onPress={() => onOpenTask(task.id)}
      style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[2], minHeight: touch ? 40 : 30, opacity: pressed ? 0.7 : 1 })}
    >
      <StatusIcon status={task.status} size={14} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label bold size={font.md} lines={1} selectable={false}>{task.title}</Label>
      </View>
      <Label muted size={font.sm} selectable={false}>
        {task.archivedAt ? `${t("Archived")} · ` : ""}
        {count}
      </Label>
      <Icon name="ChevronRight" size={13} color={colors.foregroundMuted} />
    </Pressable>
  );
}

export function FilterChip({ on, icon, label, hint, onPress }: { on: boolean; icon: string; label: string; hint?: string; onPress(): void }): ReactNode {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={touch ? 6 : 0}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ ...noFocusRing,
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
      <Icon name={icon} size={12} color={on ? colors.accent : colors.foregroundMuted} />
      <Label size={font.sm} color={on ? colors.accent : undefined} muted={!on} selectable={false}>
        {label}
      </Label>
    </Pressable>
  );
}
