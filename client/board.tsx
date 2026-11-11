import type { BoardOverview } from "../shared/overview";
import { CardDetailProvider, detailQueryOptions, detailUnavailable, invalidateCardViews, useCardDetailQuery, useProjectIdeasQuery } from "./card-detail-query";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Platform, Pressable, View, useWindowDimensions, type GestureResponderEvent } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { Modal, useAfterModalClose } from "./modal";
import {
  usePaseo,
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  type PluginScreenParams,
} from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import {
  priorities,
  taskTypes,
  taskTypeLabels,
  type Status,
  type Task,
  type Project,
  type Group,
  type BoardEvent,
  type Idea,
  projectOrder,
} from "../shared/model";
import type { PaseoAgent } from "@getpaseo/client";
import {
  Theme,
  Label,
  Button,
  Field,
  Choices,
  Notice,
  Row,
  Divider,
  Actions,
  IconButton,
  message,
  font,
  radius,
  space,
  touch,
  useTheme,
  verticalScroll,
  verticalContent, noFocusRing } from "./ui";
import { StatusIcon, priorityLabels } from "./status";
import { AttentionButton } from "./attention-button";
import { DispatcherPanel } from "./dispatcher-panel";
import { LeftDock } from "./left-dock";
import { lastCollapsed, rememberCollapsed, shownCollapsed } from "./collapsed-columns";
import { dockShortcut, escAction, toolbarDockButtons } from "./dock-logic";
import { cardAsks, changeItem, needsCount, needsQueue, stepAt, stepPosition, stepSession, stepStartTarget, updatedQueue, type Step, type StepKind } from "./step-through";
import { StepThroughBar } from "./step-through-bar";
import { bellResolved, forgetAnsweredMissing, markAsksAnswered, useAnsweredAsks } from "./answered-asks";
import {
  attentionItemsWithFacts,
  attentionOpen,
  attentionOpenToken,
  listSignals,
  openInList,
  snoozeMenu,
  type AttentionItem,
  type SnoozeList,
} from "./attention";
import { relativeTime } from "./ui";
import { ProjectForm, TaskForm, type TaskSeed } from "./forms";
import { QuickTaskForm } from "./quick-task-form";
import { ideaQuickSeed, quickProject, quickProjects, type QuickTaskSeed } from "./quick-task";
import { ideaLinkOptions, newTaskFromIdea, type OtherOption } from "./idea-choice";
import { discussAvailable, discussIdeaText } from "./dispatcher-panel-logic";
import type { IdeaOther } from "./task-ideas";
import { ideaDescription } from "../shared/ideas";
import { waitingOn } from "../shared/links";
import { LinkPicker } from "./task-links";
import { TaskDrawer } from "./drawer";
import { DeleteTaskDialog } from "./task-delete";
import { asksResolvedKey, dispatcherItemsKey, useDispatcherItemsQuery, useOverviewQuery, useLiveAgents, useGuardrailCountsQuery, useResolvedAsksQuery, useResourcesQuery, useWorkflowInsightsQuery } from "./queries";
import { projectOpenIdeaCount } from "./overview-query";
import { useStableCallback, useStableTheme } from "./stable";
import { isLegacyScope } from "../shared/scope";
import { LaneList } from "./lane-list";
import { perfConfigure, perfMark, usePerfRender } from "./perf";
import { laneRows, sameRows, type LaneRow } from "./lane-rows";
import { LanePager } from "./lane-pager";
import { useAndroidBack } from "./android-back";
import { LiveTaskCard, type CardDrag, type LiveTaskCardProps } from "./card";
import { openNativeWorkspace } from "./session-state";
import { externalError, useConnections } from "./connectors";
import { linearQuickSeed, parseLinearOpen, parseLinearStart } from "./linear-start";
import { cardProgress, useSummaries } from "./task-progress";
import { LocaleRoot } from "./i18n";
import { agentModelFromValues, effectiveAgentModel, startingAgent } from "../shared/agent-defaults";
import { groupOfProject as projectGroup } from "../shared/groups";
import { GroupSettings } from "./group-settings";
import { HintOutline, SettingsHint, SettingsModal, type SettingsSection } from "./summary-settings";
import { NewTaskFab } from "./new-task-fab";
import { SettingsOpenerContext } from "./settings-opener";
import { findingDescription, workflowInsightsSettings, workflowSettingsValues, type Finding } from "../shared/workflow-insights";
import { WrapupModal } from "./wrapup";
import { SwitchModal, type SwitchDirection } from "./workspace-switch";
import { performanceLogOn, performanceSettings, featureSettings, featureSettingsValues, ideasSettings, ideasSettingsValues, modelSettings, modelSettingsValues, wrapupSettings, wrapupSettingsValues } from "../shared/settings";
import { pickOutputSession } from "./card-output";
import { statusChanges } from "./changes";
import { ContextMenuProvider, eventPoint, menuHandlers, suppressNativeMenu, useMenuControl, useMenuOpener, type MenuEntry, type Point } from "./context-menu";
import { boardCardMenu } from "./card-menu";
import { DesktopColumns, OlderToggle, type Placement } from "./columns";
import { olderFinishedFromDates } from "./finished-cards";
import { ResizeGrip } from "./resize";
import { chatWidth, defaultDrawerShare, minChatWidth, drawerShare, drawerWidth, isCompactLayout } from "./geometry";
import { useSessionReads } from "./session-reads";
import { sessionAttentionSummaryFromTurns } from "../shared/session-attention";
import { MotionProvider, MotionReveal, useMotionPresence, lerp } from "./motion";
import { SortableList } from "./sortable-list";
import { useBoardView } from "./board-view";
import { setSweepEnabled } from "./sweep-setting";
import { BoardOutputActive, boardIsActive } from "./query-activity";
import { OverviewBar } from "./overview-bar";
import { InsightsPage } from "./insights";
import { IdeasPage } from "./ideas-page";
import { SearchPage } from "./search-page";
import { focusOfHit, type DrawerFocus } from "./drawer-focus";
import { searchSources as allSearchSources, type SearchCard, type SearchHit, type SearchMemoryHit } from "../shared/search";
import { GuardrailsPage } from "./guardrails";
import { MemoryPage, type MemoryPrefs } from "./memory";
// board-groups 3/7: group-only navigation (BOARD-GROUPS-SPEC §3).
import { lastProjectFilter, lastViewedGroupView, rememberProjectFilter, rememberViewedGroupView } from "./project-memory";
import { boardProject, boardScope, defaultGroup, focusFilter, mobileLane, groupMembers, groupOfProject, groupQuickProject, groupViewId, membersFirst, overviewScope, pickGroupView, staleGroupChoice, validProjectFilter, type ProjectFilter } from "./board-groups";
import { boardLanes, dropAllowed, includedProjects, matchesFilters, newTaskOpen, reorderAllowed, scopeTasks, sortAllColumn } from "./all-projects";
import { GroupTabs } from "./project-tabs";
import { DeleteGroupDialog, GroupNameDialog } from "./group-dialogs";
import { RemoveProjectDialog } from "./project-remove";
import { boardOverview } from "./overview";
import { enabledStatuses, laneName } from "../shared/lanes";
import { groupLaneCounts } from "../shared/group-lanes";
import { boardSortText, boardSorts, sortTasks, turnEndActivity, type BoardSort } from "../shared/sort";
import { projectTagStats, tagPrefixes } from "../shared/tags";
import {
  parseIdeaLink,
  parseSessionLink,
  resolveCardDetailLink,
  sessionLinkKey,
  type SessionEntry,
} from "./session-link";
import {
  navigateGrid,
  parseBoardIntent,
  resolveShortcut,
  shortcutHelp,
  shortcutsBlocked,
  taskGrid,
  adjacentStatus,
  type ShortcutAction,
  type BoardIntent,
} from "./shortcuts";
import { ConceptStrip, GuideBanner, WelcomeTour, useOnboarding } from "./onboarding";
import { noTipFacts, nextTip, settingsHintDue, welcomeDecision, type TipId } from "./onboarding-logic";
import { latestRelease, whatsNew, whatsNewDecision, type WhatsNewItem } from "./whats-new";
import { WhatsNewWindow } from "./whats-new-window";
import { t, tn } from "../shared/i18n";
import { PROJECT_UNAVAILABLE, gone } from "../shared/card-detail";
import { workpadEnabled } from "../shared/workpad";
import { cardDisplay, cardWorkspace } from "../shared/card-display";
import { parentOf } from "../shared/subagents";
import { reviewLabel } from "./task-review";
import { visibleReview } from "../shared/auto-review";
import { planApproved, planOf } from "../shared/plans";

/** One-time tip texts (ONBOARDING-SPEC §5). */
const tipText: Record<TipId, (compact?: boolean) => string> = {
  "first-card": () => t("Your card moves by itself as the agent works. Open it any time to see its sessions, output and summary."),
  "needs-you": () => t("A card is waiting for you. Reply goes straight to the session."),
  "first-idea": () => t("An agent suggested follow-up work. Good idea starts a card or continues here; Dismiss removes it."),
  "idea-discuss": () => t("Not sure about an idea? Discuss puts it in the dispatcher's message box to talk it through. Nothing is sent until you press Enter."),
  "first-done": () => t("Done cards can be wrapped up: their sessions and workspace are archived. Auto wrap up is in settings."),
  "first-artifact": () => t("Cards now collect artifacts: the files and links a task worked from and delivered. Agents add them as they work; you can add your own in the card."),
  "agent-question": () => t("An agent is asking you something. Open the card's session to answer it right there, no need to switch to Paseo."),
  "first-tag": () => t("Agents tag their cards by module and direction. Open a card and tap a tag to filter the board by it, or search #tag."),
  "next-move": () => t("When an agent finishes a turn, its suggested next steps sit above the message box. Tap one to fill it in; nothing is sent until you press Send. Some steps act on the card, like Move to Done."),
  "older-finished": () => t("Cards that finished a while ago fold under “Show older” at the bottom of Done and Cancelled. Settings → Workflow sets how long they stay."),
  "first-ticket": () => t("A card has an item from a connected service as an input. Agents read it every turn and see when it changes. Flowly never changes it there, and its status doesn't move the card."),
  "jira-connect": () => t("Work from Jira, Confluence, GitHub, GitLab, Azure DevOps, Linear or Shortcut: connect them in Settings → Connections, then start a card with From… or add items with the Artifacts +. Flowly only reads them."),
  connectors: () => t("The Artifacts + now adds Confluence pages and GitHub or GitLab issues and pull requests too, besides files, links and Jira tickets. Connect services in Settings → Connections."),
  "board-groups": () => t("Projects sit in boards. Each group has its own tab, dispatcher and defaults; add a group from the project switcher."),
  subagents: () => t("When a session starts subagents, a Subagents chip appears above its message box. Click it to see their status and open one in Paseo."),
  "summary-models": () => t("Choose summary models and their fallback order in Settings → Models. The default is Haiku, then Luna."),
  "ai-language": () => t("AI-written text follows Settings → AI features → AI output language. It starts as your interface language."),
  "first-skill-draft": () => t("Insights drafted a skill from your cards. Open Insights to add it to the project."),
  search: () => t("Find past cards, notes, workpads and deliverables with the search button or S."),
  "quick-task": () => t("New task now opens Quick task: say what you want done and press Enter. More options opens the full form; Settings → Workflow turns it off."),
  "first-workflow-insight": () => t("Workflow insights found repeated work worth keeping. Open Insights to turn a suggestion into a card."),
  "lane-swipe": () => t("Swipe left or right to switch lanes."),
  "card-display": (compact) => compact
    // Compact puts the Sort choices and Card display… in the Filters dialog.
    ? t("Cards too busy? Choose what they show in Settings → Cards, or from Filters → Card display.")
    : t("Cards too busy? Choose what they show in Settings → Cards, or from the Sort menu → Card display."),
  "attention-dismiss": () => t("Not ready to decide? Snooze it. It comes back when something new happens."),
  "sidebar-order": () => t("Arrange an open card your way: reorder its sections and choose which start open in Settings → Cards → Card sidebar."),
  "session-history": () => t("A session's output now starts at the beginning of its current turn. Press Load earlier at the top to read further back."),
  "settings-entry": () => t("Turn features on or off and change settings here."),
  dispatcher: () => t("The dispatcher is one agent for all your projects. Open its chat with the robot button, ask for work, and it makes the cards and starts them."),
  "auto-review": () => t("Auto review checked this card after the agent delivered; open it to see each check's result."),
  "first-guardrail": () => t("Flowly learned a check from a card you sent back. Open Guardrails to see what it checks now."),
  plan: () => t("This card's approved plan. New sessions start from it instead of planning again."),
  "first-workpad": () => t("This card has a workpad: the agent's acceptance list. The card shows how many items are met; open it to tick items yourself and to see the latest review."),
};

/** RN-Web forwards React keyboard events on View; React Native's types omit them. */
type WebKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
};

const noEvents: BoardEvent[] = [];
const noTasks: Task[] = [];
// board-groups 3/7: the overview's groups, empty until it loads.
const noGroups: Group[] = [];
const noProjects: Project[] = [];
const noAgents: PaseoAgent[] = [];
const noTurnFacts: ReadonlyMap<string, { latestTurn?: { action: string; at: string } }> = new Map();

// Module scope: a remounted board must not reopen a modal for a token it already handled.
const appliedAttentionTokens = new Set<string>();
const consumedIntents = new Set<string>();

export function BoardScreen(props: PluginSurfaceProps & { workspaceId?: string; params?: PluginScreenParams }) {
  return (
    <LocaleRoot>
      <BoardSurface {...props} />
    </LocaleRoot>
  );
}

function BoardSurface(props: PluginSurfaceProps & { workspaceId?: string; params?: PluginScreenParams }) {
  // Wide surfaces get anchored menus; compact surfaces keep the bottom sheet.
  const windowWidth = useWindowDimensions().width;
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  // The host may hand over a new theme object on unrelated renders; a new
  // context value would re-render every themed component (PERFORMANCE-SPEC §3).
  const theme = useStableTheme(props.theme);
  return (
    <MotionProvider>
      <Theme.Provider value={theme}>
        <ContextMenuProvider compact={isCompactLayout(surfaceWidth || windowWidth)}>
          <BoardContent {...props} theme={theme} surfaceWidth={surfaceWidth} onSurfaceWidth={setSurfaceWidth} />
        </ContextMenuProvider>
      </Theme.Provider>
    </MotionProvider>
  );
}

function BoardContent(
  props: PluginSurfaceProps & {
    workspaceId?: string;
    params?: PluginScreenParams;
    surfaceWidth: number;
    onSurfaceWidth: (width: number) => void;
  },
) {
  usePerfRender("board.render");
  const toast = useToast();
  const routeWidth = useWindowDimensions().width;
  const { surfaceWidth, onSurfaceWidth: setSurfaceWidth } = props;
  const readCard = useRpc(rpc.readCardDetailChanged),
    readProjectIdeas = useRpc(rpc.readProjectIdeasChanged),
    adoptIdea = useRpc(rpc.adoptIdea);
  const updateTask = useRpc(rpc.updateTask), // board-groups 3/7: project Restore moves to group settings (card 2)
    reorder = useRpc(rpc.moveTask),
    placeTask = useRpc(rpc.placeTask),
    paseo = usePaseo();
  const queryClient = useQueryClient();
  const linkMount = useId();
  const [detailTarget, setDetailTarget] = useState<{ id: string; workspaceId: string; projectId: string } | null>(null);
  const input = useMemo(() => {
    try {
      return { link: parseSessionLink(props.params), error: "" };
    } catch (error) {
      return { link: null, error: message(error) };
    }
  }, [
    props.params?.taskId,
    props.params?.sessionId,
    props.params?.workspaceId,
    props.params?.requestId,
  ]);
  const linkKey = input.link
    ? JSON.stringify([props.host.id, sessionLinkKey(input.link)])
    : "";
  // A session chip opens its card from that card's own detail in every layout, never the whole board (LOADING-R2-SPEC §2).
  const directCard = !!input.link;
  const resolvedLink = useQuery({
    queryKey: ["flowly", "cardLink", linkMount, linkKey],
    queryFn: () => resolveCardDetailLink(paseo, () => queryClient.fetchQuery(detailQueryOptions(queryClient, props.host.id, input.link!.taskId, input.link!.workspaceId, readCard)), input.link!),
    enabled: !!input.link,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const appliedLink = useRef(""), ignoredLink = useRef("");
  // "Start a new task" from the native Ideas chip (NATIVE-SESSION-SPEC §7.3), applied once per request.
  const ideaInput = useMemo(() => {
    try {
      return { link: parseIdeaLink(props.params), error: "" };
    } catch (error) {
      return { link: null, error: message(error) };
    }
  }, [props.params?.ideaId, props.params?.requestId]);
  const appliedIdea = useRef("");
  const [sessionEntry, setSessionEntry] = useState<
    (SessionEntry & { taskId: string }) | null
  >(null);
  const view = useBoardView();
  // Moving a card into Done/Cancelled asks whether to wrap it up, unless the
  const sweepOn = view.values?.runningSweep ?? true;
  useEffect(() => setSweepEnabled(sweepOn), [sweepOn]);
  // daemon does it automatically (Auto wrap up setting).
  const wrapupPrefs = useSettings(wrapupSettings);
  // The Ideas switch (IDEAS-INBOX-SPEC §10); on until the setting has loaded.
  const ideasPrefs = useSettings(ideasSettings);
  const ideasOn = ideasPrefs.status !== "ready" || ideasSettingsValues(ideasPrefs.values).ideas;
  const artifactsOn = ideasPrefs.status !== "ready" || ideasSettingsValues(ideasPrefs.values).artifacts;
  // Project memory and Insights as a whole (Settings → AI features; ONBOARDING-SETUP-SPEC §6).
  const featurePrefs = useSettings(featureSettings);
  const features = featureSettingsValues(featurePrefs.status === "ready" ? featurePrefs.values : {});
  // Developer timing log (off unless the host setting is on; PERFORMANCE-SPEC §3).
  const perfPrefs = useSettings(performanceSettings);
  const sendPerf = useRpc(rpc.perfReport);
  const perfOn = perfPrefs.status === "ready" && performanceLogOn(perfPrefs.values);
  useEffect(() => {
    perfConfigure(perfOn, (report) => void sendPerf(report).catch(() => undefined), Platform.OS);
    return () => perfConfigure(false, null);
  }, [perfOn]);
  const [wrapPrompt, setWrapPrompt] = useState("");
  // Switch a card between the main checkout and a worktree (WORKSPACE-SWITCH-SPEC §3.1).
  const [switchRequest, setSwitchRequest] = useState<{ taskId: string; direction: SwitchDirection } | null>(null);
  const finished = (status?: Status) => status === "done" || status === "cancelled";
  const askWrapup = (id: string, from: Status | undefined, to: Status) => {
    if (!finished(to) || finished(from)) return;
    setMovedToFinished(true);
    if (wrapupPrefs.status !== "ready" || wrapupSettingsValues(wrapupPrefs.values).autoWrapup) return;
    setWrapPrompt(id);
  };
  const [projectId, setProject] = useState(""),
    [taskId, setTaskState] = useState(""),
    [search, setSearchState] = useState(""),
    [priority, setPriorityState] = useState("all"),
    [taskType, setTaskTypeState] = useState("all"),
    [tagFilter, setTagFilterState] = useState<string[]>([]),
    [archived, setArchivedState] = useState(false),
    [menu, setMenu] = useState<"projects" | "filters" | "status" | "attention" | "shortcuts" | "settings" | null>(null),
    // First-run welcome tour (ONBOARDING-SPEC): opened once automatically, or by hand.
    [welcomeOpen, setWelcomeOpen] = useState(false),
    // The tour opened by itself for a new user (ONBOARDING-SETUP-SPEC §4); manual opens are not first runs.
    [welcomeFirstRun, setWelcomeFirstRun] = useState(false),
    // The tour closed during this visit, so the settings callout may show (ONBOARDING-SETUP-SPEC §5).
    [tourClosed, setTourClosed] = useState(false),
    // What's new after an update (WHATS-NEW-SPEC): opened by itself once per release, or from Settings.
    [whatsNewOpen, setWhatsNewOpen] = useState(false),
    // Edit project opened to suggest auto review checks from past cards (AUTO-REVIEW-SPEC §6.2).
    [reviewOn, setReviewOn] = useState(false),
    // The user just moved a card into Done/Cancelled (drives the wrap-up tip).
    [movedToFinished, setMovedToFinished] = useState(false),
    [escapeRequest, setEscapeRequest] = useState<{ taskId: string; key: string } | null>(null),
    // Project-level page over the board area: Insights or Ideas (IDEAS-INBOX-SPEC §3.3).
    [page, setPage] = useState<"insights" | "ideas" | "guardrails" | "memory" | "search" | null>(null),
    // The dispatcher chat (DISPATCHER-SPEC §9.3): mounted on first open, then hidden rather than unmounted.
    [chat, setChat] = useState<{ open: boolean; mounted: boolean }>({ open: false, mounted: false }),
    // Search page (SEARCH-SPEC §5): the text it opens with and a key that remounts it for a new seed.
    [searchSeed, setSearchSeed] = useState({ text: "", key: 0 }),
    // A search hit for the drawer to land on (DRAWER-SPEC "Focus from search"); any other way of opening a card clears it.
    [drawerFocus, setDrawerFocus] = useState<(DrawerFocus & { taskId: string }) | null>(null),
    // Ideas page: only this card's ideas ("All ideas" from a card).
    [ideaCard, setIdeaCard] = useState(""),
    // `idea`: Start session prefilled from an idea on the Ideas page (IDEAS-SPEC §6.3).
    [startRequest, setStartRequest] = useState<{ taskId: string; key: string; idea?: Idea } | null>(null),
    [mobileStatus, setMobileStatus] = useState<Status>("todo"),
    // Phones: a lane chosen from the status chooser fades in; a swiped one is already on screen (UI-UX-SPEC §5).
    [lanePick, setLanePick] = useState(0),
    [reveal, setReveal] = useState<{ status: Status; n: number; at: number; center?: boolean; taskId?: string }>({ status: "todo", n: 0, at: 0 }),
    [projectForm, setProjectForm] = useState<"new" | "edit" | null>(null),
    // Group settings (BOARD-GROUPS-SPEC §5): `groupId` null opens on Add group; `projectId` opens that project's section.
    [groupSettings, setGroupSettings] = useState<{ groupId: string | null; projectId?: string; reviewOn?: boolean } | null>(null),
    [removing, setRemoving] = useState<Project | null>(null),
    [deleting, setDeleting] = useState<Task | null>(null),
    [linking, setLinking] = useState<Task | null>(null),
    // `projectId`: the project a new card goes to when it is not the board's (All projects, ALL-PROJECTS-SPEC §3).
    [taskForm, setTaskFormState] = useState<{ task?: Task; status: Status; seed?: TaskSeed; projectId?: string } | null>(
      null,
    ),
    // Quick task (QUICK-TASK-SPEC): `projectId` when the entry point belongs to one project (a lane, a tab, the empty-board hint).
    // `recent`: Q and the Command Center open in the last quick-task project (QUICK-TASK-SPEC §3).
    // `idea`: from an idea (QUICK-TASK-SPEC §10): the full form's seed and Other options… with the card actions' runner.
    [quickTask, setQuickTask] = useState<{
      status: Status;
      projectId?: string;
      recent?: boolean;
      seed?: QuickTaskSeed;
      idea?: { form: TaskSeed; options: readonly OtherOption[]; run?(option: OtherOption): void };
    } | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [preferredShare, setPreferredShare] = useState(defaultDrawerShare),
    // The docked dispatcher chat's width as dragged; 0 = the default (DISPATCHER-SPEC §9.3).
    [chatPreferred, setChatPreferred] = useState(0),
    [chatResizing, setChatResizing] = useState(false);
  // Manual navigation supersedes the current link; its late success/error may only cache data.
  const setTask = (id: string) => { ignoredLink.current = linkKey; setTaskState(id); };
  const setTaskForm = useStableCallback((next: typeof taskForm) => {
    if (next) perfMark("task-form.open");
    setTaskFormState(next);
  });
  const mutationLock = useRef(false);
  // Filters are remembered (board-view settings): restored once, then written through.
  const filtersRestored = useRef(false);
  useEffect(() => {
    if (filtersRestored.current || !view.values) return;
    filtersRestored.current = true;
    setSearchState(view.values.filterSearch);
    setPriorityState(view.values.filterPriority);
    setTaskTypeState(view.values.filterType);
    setTagFilterState(view.values.filterTags);
    setArchivedState(view.values.showArchived);
    if (view.values.drawerShare) setPreferredShare(view.values.drawerShare);
    if (view.values.chatWidth) setChatPreferred(view.values.chatWidth);
  }, [!!view.values]);
  const searchSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchSave.current) clearTimeout(searchSave.current);
  }, []);
  const setSearch = (next: string) => {
    setSearchState(next);
    if (searchSave.current) clearTimeout(searchSave.current);
    searchSave.current = setTimeout(() => void view.update({ filterSearch: next.slice(0, 200) }), 500);
  };
  const setPriority = (next: string) => {
    setPriorityState(next);
    void view.update({ filterPriority: next as "all" });
  };
  const setTaskType = (next: string) => {
    setTaskTypeState(next);
    void view.update({ filterType: next as "all" });
  };
  const setTagFilter = (next: string[]) => {
    const value = next.slice(0, 20);
    setTagFilterState(value);
    void view.update({ filterTags: value });
  };
  // Clicking a tag in the drawer adds it to the filter (CARD-TAGS-SPEC §6.3).
  const filterByTag = useStableCallback((tag: string) => {
    if (!tagFilter.includes(tag)) setTagFilter([...tagFilter, tag]);
  });
  const setArchived = (next: boolean | ((current: boolean) => boolean)) => {
    setArchivedState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value !== current) void view.update({ showArchived: value });
      return value;
    });
  };
  useEffect(() => {
    ignoredLink.current = "";
    setSessionEntry(null);
    setMenu(null);
    setTaskState("");
  }, [linkKey, input.error]);
  useEffect(() => {
    if (!resolvedLink.error || ignoredLink.current === linkKey) return;
    setSessionEntry(null);
    setMenu(null);
    setTaskState("");
  }, [linkKey, resolvedLink.error]);
  const attentionToken = attentionOpenToken(props.params);

  useEffect(() => {
    if (!attentionToken || appliedAttentionTokens.has(attentionToken)) return;
    appliedAttentionTokens.add(attentionToken);
    startNeeds();
  }, [attentionToken]);
  useEffect(() => {
    const target = resolvedLink.data;
    if (
      !target ||
      !input.link ||
      sessionLinkKey(target.link) !== sessionLinkKey(input.link) ||
      ignoredLink.current === linkKey || resolvedLink.isFetching ||
      appliedLink.current === linkKey
    )
      return;
    // Every layout opens from the card's own scoped detail; the overview cache and its etag stay as they are.
    appliedLink.current = linkKey;
    // Native detail is complete for this card; no background full-board catch-up.
    focusGroupOf(target.project.id, false); // board-groups 3/7: the card's group
    setTaskState(target.task.id);
    setSearch("");
    setPriority("all");
    setTaskType("all");
    setTagFilter([]);
    setArchived(
      (current) =>
        current || !!target.project.archivedAt || !!target.task.archivedAt,
    );
    setMobileStatus(target.task.status);
    setError("");
    // The chip opens the card's overview, not the session it was tapped in:
    // an empty session entry returns an already open card to its details.
    setSessionEntry({
      taskId: target.task.id,
      sessionId: "",
      requestId: target.link.requestId,
    });
  }, [resolvedLink.data, resolvedLink.dataUpdatedAt, resolvedLink.isFetching, linkKey]);
  const { colors } = props.theme;
  const compact = isCompactLayout(surfaceWidth || routeWidth);
  // Keep the compact tree/scroll position, but leave hidden work to the visible detail/page.
  const boardActive = boardIsActive(compact, taskId, page, !!taskForm || !!quickTask);
  // Every layout reads the overview, never the whole board (LOADING-R2-SPEC §2A). A compact board under an
  // open card pauses; a wide one stays visible beside the drawer and keeps polling.
  const overviewLive = compact ? !taskId : boardActive;
  const overviewData = useOverviewQuery(props.host.id, {
    enabled: overviewLive && (!directCard || resolvedLink.isSuccess || ignoredLink.current === linkKey),
    refetchInterval: overviewLive ? 3000 : undefined,
  });
  const data = overviewData;
  // Prioritize compact first-screen data over auxiliary decode/render work.
  // This is scheduling only; imperative fresh ownership reads remain independent.
  const auxiliaryActive = boardActive && (!compact || !!data.data);
  const { query: readState, receipts } = useSessionReads(auxiliaryActive);
  const resources = useResourcesQuery({ refetchInterval: 15000, enabled: auxiliaryActive });
  const agents = useLiveAgents({ enabled: auxiliaryActive });
  const width = drawerWidth(preferredShare * (surfaceWidth || 1000), surfaceWidth || 1000);
  // While the drawer is being dragged the board keeps one width, the widest it can have (the
  // drawer overlays it), so columns neither reflow nor leave a blank gap when the drawer narrows.
  const [resizing, setResizing] = useState(false);
  const resizingFrom = resizing ? Math.max(0, surfaceWidth - 340 - 8 - 16) || null : null;
  // Match the current route and open drawer before exposing any scoped data.
  // Back drops it; a newer full-board deletion must never resurrect the card.
  const directDetail = directCard && input.link && !input.error && !resolvedLink.error &&
    resolvedLink.data && sessionLinkKey(resolvedLink.data.link) === sessionLinkKey(input.link) &&
    taskId === resolvedLink.data.task.id ? resolvedLink.data.detail : undefined;
  const detailTask = overviewData.data?.tasks.find(t => t.id === taskId) ?? (detailTarget?.id === taskId ? detailTarget : undefined) ?? directDetail?.task;
  const detailData = useCardDetailQuery(props.host.id, taskId, detailTask?.workspaceId || "", !!taskId);
  const currentDetail = detailUnavailable(detailData.error) ? undefined : detailData.data ?? directDetail;
  // Cold direct links can display their own metadata without fabricating a complete Board/overview.
  const detailMetadata = currentDetail ? { revision: currentDetail.revision, tasks: [currentDetail.task], projects: [currentDetail.project], links: currentDetail.links, attentionDismissals: currentDetail.attentionDismissal ? [currentDetail.attentionDismissal] : [] } : undefined;
  const board = overviewData.data ?? detailMetadata;
  const projected = board && "cards" in board ? board as BoardOverview : undefined;
  // A project's own group (BOARD-GROUPS-SPEC §5): the defaults chain and Group settings; none until the overview has it.
  const groupOf = (p: { groupId?: string } | null | undefined) => projectGroup({ groups: projected?.groups ?? noGroups }, p);
  // Card facts come from the overview; until it arrives (a cold direct link) cards show no derived facts.
  const factsByTask = useMemo(() => new Map((projected?.cards || []).map(c => [c.taskId, c])), [projected?.cards]);
  const sessionFacts = useMemo(() => new Map((projected?.cards || []).map(c => [c.taskId, new Map(c.sessions.map(s => [s.agentId, s]))])), [projected?.cards]);
  const boardPending = !board && data.isPending;
  const boardError = data.error || (taskId ? detailData.error : null);
  const linked = props.workspaceId
    ? board?.tasks.find((t) => t.workspaceId === props.workspaceId)
    : undefined;
  useEffect(() => {
    if (linked) {
      focusGroupOf(linked.projectId, false); // board-groups 3/7: the card's group
      setTaskState(linked.id);
    }
  }, [linked?.id]);
  // board-groups 3/7: projects are no longer dragged here (groups are), so no drop override.
  const projects = (board?.projects || [])
    .filter((p) => archived || !p.archivedAt)
    .sort(projectOrder);
  const boardSort: BoardSort = view.values?.boardSort || "manual";
  // What cards show (CARD-DISPLAY-SPEC); one object for all cards so memoized cards stay put.
  const cardActivity = view.values?.cardActivity, cardHiddenKey = (view.values?.cardHidden || []).join(",");
  const display = useMemo(() => cardDisplay({ cardActivity, cardHidden: cardHiddenKey.split(",") }), [cardActivity, cardHiddenKey]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  // The lanes are drawn only once the collapsed set is known (stored, or last known for this host), so they never open and then shrink.
  const storedCollapsed = view.values ? view.values.collapsedColumns || [] : undefined;
  const { ready: columnsReady, collapsed: collapsedColumns } = shownCollapsed(storedCollapsed, lastCollapsed(props.host.id));
  useEffect(() => {
    if (storedCollapsed) rememberCollapsed(props.host.id, storedCollapsed);
  }, [props.host.id, JSON.stringify(storedCollapsed)]);
  const toggleCollapse = (status: Status) => {
    if (!view.values) return;
    const next = collapsedColumns.includes(status)
      ? collapsedColumns.filter((s) => s !== status)
      : [...collapsedColumns, status];
    void view.update({ collapsedColumns: next });
  };
  const chooseSort = (next: BoardSort) => {
    if (!view.values || next === boardSort) return;
    void view.update({ boardSort: next });
  };
  // board-groups 3/7: every board is a group board (BOARD-GROUPS-SPEC §3). `projectId` holds only the explicit choice,
  // a group's view id; the board works as All did (ALL-PROJECTS-SPEC §2–§6) over the group's live members.
  const allLiveProjects = useMemo(() => includedProjects(board?.projects || []), [board?.projects]);
  // A group just dragged shows in place until the refreshed board agrees (as projects do).
  const [groupOrderOverride, setGroupOrderOverride] = useState<string[] | null>(null);
  const serverGroups = projected?.groups ?? noGroups;
  const serverGroupIds = serverGroups.map((g) => g.id).join(",");
  useEffect(() => {
    if (!groupOrderOverride) return;
    if (groupOrderOverride.join(",") === serverGroupIds) return setGroupOrderOverride(null);
    const timer = setTimeout(() => setGroupOrderOverride(null), 5000);
    return () => clearTimeout(timer);
  }, [groupOrderOverride, serverGroupIds]);
  const boardGroups = useMemo(
    () => (groupOrderOverride ? serverGroups.slice().sort((a, b) => groupOrderOverride.indexOf(a.id) - groupOrderOverride.indexOf(b.id)) : serverGroups),
    [serverGroups, groupOrderOverride],
  );
  const group = pickGroupView(boardGroups, board?.projects || [], projectId, lastViewedGroupView());
  const groupKey = group ? `${group.id}|${allLiveProjects.filter((p) => p.groupId === group.id).map((p) => p.id).join(",")}` : "";
  // No group known yet (a cold direct link's board holds just the card's project): show the live projects it has.
  const liveProjects = useMemo(
    () => (group ? groupMembers(group, board?.projects || []) : allLiveProjects),
    [board?.projects, groupKey, allLiveProjects],
  );
  // The Project filter (BOARD-GROUPS-SPEC §3): one project of the group shown, remembered for this app run. It is read
  // through validProjectFilter (the group may differ or the project have left) and cleared once the group is known.
  const [projectFilter, setProjectFilterState] = useState<ProjectFilter>(lastProjectFilter);
  const setProjectFilter = useStableCallback((next: ProjectFilter) => {
    rememberProjectFilter(next);
    setProjectFilterState(next);
  });
  const validFilterId = validProjectFilter(projectFilter, group?.id ?? "", liveProjects.map((p) => p.id));
  useEffect(() => {
    if (projectFilter && group && overviewData.data && !validFilterId) setProjectFilter(null);
  }, [groupKey, validFilterId, !!overviewData.data]);
  // `project` is a board's one project: the filtered one, or the only one of a one-project group; none shows every
  // project of the group, each card using its own (projectOf).
  const project = boardProject(validFilterId, liveProjects);
  const allView = !project;
  const viewKey = group ? groupViewId(group.id) : "";
  // Returning to the board in this app run reopens the group seen last; a cold start opens the default group.
  // Only with the full overview: until then no group is known, and the fallback must not replace a remembered group.
  useEffect(() => {
    if (overviewData.data && group) rememberViewedGroupView(groupViewId(group.id));
  }, [viewKey, !!overviewData.data]);
  // A chosen group that was deleted falls back to the default group once the board has loaded.
  const choiceStale = staleGroupChoice(projectId, boardGroups, !!overviewData.data);
  useEffect(() => {
    if (choiceStale) setProject("");
  }, [choiceStale]);
  // A card opened before the groups are known (a cold link) selects its group once they arrive.
  const pendingFocus = useRef("");
  // Add group and Delete group… dialogs; Group settings is its own page (onGroupSettings).
  const [groupDialog, setGroupDialog] = useState<{ kind: "add" } | { kind: "delete"; groupId: string } | null>(null);
  const chooseGroup = (id: string) => {
    ignoredLink.current = linkKey;
    pendingFocus.current = "";
    setProject(groupViewId(id));
    setPage(null);
  };
  const projectById = useMemo(() => new Map((board?.projects || []).map((p) => [p.id, p])), [board?.projects]);
  const projectOf = (card: { projectId: string }) => projectById.get(card.projectId);
  const includedIds = useMemo(() => new Set(liveProjects.map((p) => p.id)), [liveProjects]);
  const projectRank = useMemo(() => new Map(liveProjects.map((p, i) => [p.id, i])), [liveProjects]);
  const inView = (id: string) => includedIds.has(id);
  // Opening a card, a session chip, an idea link or a search result selects the card's project's group, unless shown.
  // `manual`: a user's own navigation, which supersedes the current session link (as setTask does).
  const focusGroupOf = (id: string, manual = true, pin = false) => {
    // A project the board does not hold yet (just created, or a cold link's) waits for the refreshed board.
    if (!boardGroups.length || !projectById.has(id)) return void (pendingFocus.current = id);
    pendingFocus.current = "";
    const target = groupOfProject(boardGroups, board?.projects || [], id);
    if (!target) return;
    // `pin`: the board must act on this project (Memory, Ideas), so a board of several shows only it.
    if (target.id === group?.id) {
      if (pin && !(project && project.id === id)) setProjectFilter({ groupId: target.id, projectId: id });
      return;
    }
    if (manual) ignoredLink.current = linkKey;
    setProjectFilter(focusFilter(projectFilter, group?.id ?? "", target.id, id));
    setProject(groupViewId(target.id));
  };
  useEffect(() => {
    if (pendingFocus.current) focusGroupOf(pendingFocus.current, false);
  }, [boardGroups, projectById]);
  // Project pages (Insights, Ideas, Memory) need one project; Search works across all of them.
  useEffect(() => {
    if (!project) setPage((current) => (current === "search" ? current : null));
  }, [project?.id]);
  const task = currentDetail?.task.id === taskId && inView(currentDetail.task.projectId) ? currentDetail.task : board?.tasks.find(
    (t) => t.id === taskId && inView(t.projectId),
  );
  // The open card's own project (the board's on a project board).
  const taskProject = task ? (currentDetail?.task.id === task.id ? currentDetail.project : projectOf(task)) : undefined;
  // The project of an open task form: a new card's chosen project, an edited card's own, else the board's.
  const formProject = taskForm ? projectById.get(taskForm.projectId ?? taskForm.task?.projectId ?? project?.id ?? "") : undefined;
  // Phone with a card open: the board stays mounted and laid out under the
  // card's opaque overlay, so Back shows it at once with its scroll position
  // and neither direction re-lays it out (PERFORMANCE-SPEC §2).
  const boardHidden = compact && !!task;
  const covered = {
    pointerEvents: boardHidden ? ("none" as const) : ("auto" as const),
    accessibilityElementsHidden: boardHidden,
    importantForAccessibility: boardHidden ? ("no-hide-descendants" as const) : ("auto" as const),
  };
  const drawerTarget = useMemo(() => task && taskProject && !detailUnavailable(detailData.error) ? {
    task, project: taskProject,
    events: currentDetail?.events || noEvents,
  } : undefined, [task, taskProject, currentDetail, detailData.error]);
  const drawer = useMotionPresence(drawerTarget, drawerTarget ? `${drawerTarget.project.id}|${drawerTarget.task.id}` : "");
  // The dispatcher chat: open by default on desktop, minimized when the user says so (remembered per host);
  // phones open it from the toolbar each time (DISPATCHER-SPEC §9.3).
  const chatOpen = compact ? chat.open : !!view.values && !view.values.chatMinimized && (!!project || allView);
  // Desktop: expanded, the open chat takes the whole board area; the board stays mounted, hidden (§9.3).
  const chatExpanded = !compact && chatOpen && !!view.values?.chatExpanded;
  const toggleChatSize = useStableCallback(() => void view.update({ chatExpanded: !chatExpanded }));
  // A page shows in the board area, so opening one brings an expanded chat back to its docked width.
  const restoreChatSize = useStableCallback(() => { if (chatExpanded) void view.update({ chatExpanded: false }); });
  useEffect(() => { if (page) restoreChatSize(); }, [page, restoreChatSize]);
  const chatMounted = useRef(false);
  // Desktop: the open card's lane is centred in the board left of the drawer when the drawer would hide it, on
  // opening, on moving to another lane, and on coming back to the board from a page (DRAWER-SPEC). A lane reveal
  // asked in the same moment keeps its own lane.
  const revealedCard = useRef("");
  useEffect(() => {
    const key = task ? `${task.id}|${task.status}` : "";
    const sameCard = key === revealedCard.current;
    revealedCard.current = key;
    if (compact || page || !task) return;
    setReveal((r) => (sameCard && !r.center && Date.now() - r.at < 300 ? r : { status: task.status, n: r.n + 1, at: Date.now(), center: true, taskId: task.id }));
  }, [compact, page, task?.id, task?.status]);
  const tasks = scopeTasks(
    board?.tasks || [],
    allView ? { all: true, projectIds: includedIds } : { all: false, projectId: project?.id || "" },
    archived,
  );
  const visible = tasks.filter((t) => matchesFilters(t, { search, priority, taskType, tags: tagFilter }));
  // Lanes are the group's (BOARD-GROUPS-SPEC §4): its enabled lanes in its order and names, filtered or not.
  const lanesShown = boardLanes(group, project, liveProjects);
  const shownStatuses = lanesShown.statuses;
  const nameOf = lanesShown.nameOf;
  // A card's own lanes and lane names (its project's), for its menus and toasts.
  const cardStatuses = (card: Task) => enabledStatuses(projectOf(card));
  const cardLaneName = (card: Task, status: Status) => laneName(projectOf(card), status);
  const wrapPromptTask = wrapPrompt
    ? board?.tasks.find((t) => t.id === wrapPrompt && !t.archivedAt)
    : undefined;
  const switchTask = switchRequest ? board?.tasks.find((t) => t.id === switchRequest.taskId && !t.archivedAt) : undefined;
  // Compact: open each project on its first lane that has cards (once per
  // project; a linked card or the user's own tab choice wins afterwards).
  const autoLane = useRef("");
  useEffect(() => {
    if (!board || !viewKey || autoLane.current === viewKey) return;
    autoLane.current = viewKey;
    if (taskId) return;
    const first = shownStatuses.find((s) => visible.some((t) => t.status === s));
    if (first) setMobileStatus(first);
  }, [board, viewKey]);
  useEffect(() => {
    const lane = mobileLane(shownStatuses, mobileStatus);
    if (lane !== mobileStatus) setMobileStatus(lane);
  }, [shownStatuses.join(","), mobileStatus]);
  // Recent activity counts turn ends only (sort.ts turnEndActivity). Sessions that
  // record no turn events contribute the time they last went idle, remembered
  // across their next turn so the card holds its place while it runs.
  const settledAgents = useRef(new Map<string, { workspaceId: string; at: string }>());
  const turnEnds = useMemo(() => projected ? {
    byTask: new Map(projected.cards.flatMap(c => c.turnEndedAt ? [[c.taskId, c.turnEndedAt] as const] : [])),
    agents: new Set(projected.cards.flatMap(c => c.sessions.filter(s => s.hadTurnEnd).map(s => s.agentId))),
  } : { byTask: new Map<string, string>(), agents: new Set<string>() }, [projected?.cards]);
  const taskActivity = useMemo(() => {
    for (const a of agents.data || [])
      if (a.workspaceId && a.updatedAt && !turnEnds.agents.has(a.id) && a.status !== "running" && a.status !== "initializing")
        settledAgents.current.set(a.id, { workspaceId: a.workspaceId, at: a.updatedAt });
    const byWorkspace = new Map<string, string>();
    settledAgents.current.forEach(({ workspaceId, at }, id) => {
      if (!turnEnds.agents.has(id) && (byWorkspace.get(workspaceId) || "") < at) byWorkspace.set(workspaceId, at);
    });
    return turnEndActivity(board?.tasks || [], turnEnds.byTask, byWorkspace);
  }, [agents.data, board?.tasks, turnEnds]);
  // Old Done/Cancelled cards fold to the bottom of their lane (FINISHED-CARDS-SPEC); the open card always shows.
  const hideFinishedDays = view.values?.hideFinishedAfterDays ?? 14;
  const older = useMemo(
    () =>
      olderFinishedFromDates(
        (board?.tasks || []).filter(t => inView(t.projectId)),
        new Map((projected?.cards || []).map(c => [c.taskId, c.finishedAt])),
        hideFinishedDays, Date.now(), taskId,
      ),
    [board?.tasks, projected?.cards, viewKey, includedIds, hideFinishedDays, taskId],
  );
  const [olderShown, setOlderShown] = useState<Status[]>([]);
  useEffect(() => setOlderShown([]), [viewKey]);
  const toggleOlder = (status: Status) =>
    setOlderShown((lanes) => (lanes.includes(status) ? lanes.filter((s) => s !== status) : [...lanes, status]));
  const onScreen = visible.filter((t) => !older.has(t.id) || olderShown.includes(t.status));
  // Within a lane the older cards always come last, under their toggle. All orders across projects (ALL-PROJECTS-SPEC §4).
  const sortColumn = (column: Task[]) => {
    const sorted = allView ? sortAllColumn(column, boardSort, taskActivity, projectRank) : sortTasks(column, boardSort, taskActivity);
    return older.size ? [...sorted.filter((t) => !older.has(t.id)), ...sorted.filter((t) => older.has(t.id))] : sorted;
  };
  // The phone's lanes: the selected one, plus its neighbours in the native lane pager (UI-UX-SPEC §5).
  const laneRowsRef = useRef(new Map<Status, LaneRow<Task>[]>());
  const lanesNow = new Map<Status, { count: number; olderCount: number; rows: LaneRow<Task>[] }>();
  const laneOf = (status: Status) => {
    const known = lanesNow.get(status);
    if (known) return known;
    const all = sortColumn(visible.filter((t) => t.status === status));
    const recent = all.filter((t) => !older.has(t.id));
    const olderCards = all.filter((t) => older.has(t.id));
    const rows = sameRows(laneRowsRef.current.get(status), laneRows(recent, olderCards, olderShown.includes(status)));
    laneRowsRef.current.set(status, rows);
    const lane = { count: all.length, olderCount: olderCards.length, rows };
    lanesNow.set(status, lane);
    return lane;
  };
  // Status-change flash: remember the last snapshot, emphasize cards that moved.
  const statusMemory = useRef<Map<string, string> | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const flashTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!board) return;
    const { next, changed } = statusChanges(statusMemory.current, board.tasks);
    statusMemory.current = next;
    if (!changed.length) return;
    setFlashing((current) => new Set([...current, ...changed]));
    // Each flash owns its timer; a quick refetch must not cancel an earlier one.
    const timer = setTimeout(() => {
      flashTimers.current.delete(timer);
      setFlashing((current) => new Set([...current].filter((id) => !changed.includes(id))));
    }, 1600);
    flashTimers.current.add(timer);
  }, [board]);
  useEffect(
    () => () => {
      flashTimers.current.forEach(clearTimeout);
      flashTimers.current.clear();
    },
    [],
  );
  const managedRead = useRpc(rpc.managedSessions);
  const summaries = useSummaries(auxiliaryActive);
  const managed = useQuery({
    queryKey: ["flowly", "managed"],
    enabled: auxiliaryActive,
    queryFn: () => managedRead({}),
    refetchInterval: 10000,
  });
  const managedIds = useMemo(
    () => new Set((managed.data || []).map((m) => m.agentId)),
    [managed.data],
  );
  const readUnavailable = readState.isPending || readState.isError;
  // Snoozed signals stay out of every count until something new happens in their list (ATTENTION-DISMISS-SPEC).
  const allAttention = useMemo(
    () =>
      projected && agents.data ? attentionItemsWithFacts(projected, agents.data, receipts, readUnavailable, (task, agentId) => sessionFacts.get(task.id)?.get(agentId)) : [],
    [projected, agents.data, receipts, readUnavailable, sessionFacts],
  );
  // Cards with something open in either list; one snoozed in a single list stays for the other.
  const attention = useMemo(() => allAttention.filter(attentionOpen), [allAttention]);
  // Open asks (plan Q1) leave out the ones resolved in the chat until the live list drops them (DISPATCHER-SPEC §9.4):
  // the daemon's list covers a closed chat and a reload, this client's own set the moments before it catches up.
  const answeredAsks = useAnsweredAsks();
  const resolvedAsks = useResolvedAsksQuery(auxiliaryActive);
  const liveSignals = useMemo(
    () => (projected && agents.data ? new Set(allAttention.flatMap((i) => i.parts.map((p) => p.key))) : null),
    [allAttention, projected, agents.data],
  );
  useEffect(() => {
    if (liveSignals) forgetAnsweredMissing(liveSignals);
  }, [liveSignals]);
  // Tip "attention-dismiss": three or more cards with an open need-you signal and none snoozed (ATTENTION-DISMISS-SPEC, Tip).
  const crowdedAttention = useMemo(
    () => allAttention.filter((i) => openInList(i, "needs")).length >= 3 && !allAttention.some((i) => i.snoozed.needs || i.snoozed.updated),
    [allAttention],
  );
  const attentionByTask = useMemo(() => new Map(allAttention.map((i) => [i.task.id, i])), [allAttention]);
  // The project's default model, then its group's, then the global one; with none the picker starts empty (MODEL-DEFAULTS-SPEC §2).
  const modelPrefs = useSettings(modelSettings);
  const globalModel = agentModelFromValues(modelPrefs.status === "ready" ? modelSettingsValues(modelPrefs.values) : null);
  // The open form's or card's own project first: on the All board there is no board project. Then its group's default.
  const modelProject = formProject ?? taskProject ?? project;
  const defaultModel = effectiveAgentModel(modelProject, groupOf(modelProject), globalModel)?.model ?? null;
  const defaultModelKey = JSON.stringify(defaultModel);
  const sessionDefaults = useMemo(() => startingAgent(defaultModel), [defaultModelKey]);
  // Quick task's agent in any project: the same rule as sessionDefaults (QUICK-TASK-SPEC §1).
  const agentDefaultsFor = useStableCallback((p: Project) => startingAgent(effectiveAgentModel(p, groupOf(p), globalModel)?.model ?? null));
  // New task: Quick task unless the user turned that off (QUICK-TASK-SPEC §5), in the board's project unless pinned.
  // All projects: always Quick task, in the last quick-task project (ALL-PROJECTS-SPEC §5). `inAll` is false when
  // the caller switches to a project in the same moment (a project tab's New task).
  const openNewTask = (status: Status, pinned?: string, inAll = allView) => {
    const next = newTaskOpen({ all: inAll, quickDefault: view.values?.quickTaskDefault ?? true, status, pinned, current: project?.id });
    if (next.kind === "form") setTaskForm({ status: next.status });
    else setQuickTask({ status: next.status, ...(next.projectId ? { projectId: next.projectId } : {}), ...(next.recent ? { recent: true } : {}) });
  };
  const rootRef = useRef<View>(null);
  // Phones: menus are Modals; what they open waits until they have closed.
  const afterModalClose = useAfterModalClose();
  // The step-throughs in the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09). "N need you" (the overview
  // chip, A, a notification's link, the phone's bell) walks the cards with asks that wait on you, newest first, each
  // card's asks pinned on top; "N updated" walks what is new to read: the cards the dispatcher saw change, then the cards
  // with an unread turn, each opening its unread chat. The queues follow the board shown (its filtered project, or every
  // live member of the group) and recompute live; closing the card or opening another ends it.
  // The dock shows the dispatcher of the group shown (DISPATCHER-SPEC §9); none until the board's groups are known.
  const dispatcherGroupId = group?.id ?? null;
  const dispatcherGroupName = group?.name;
  const dispatcherItems = useDispatcherItemsQuery(auxiliaryActive && (!!project || allView), dispatcherGroupId);
  // Asks listed as answered, ended or dismissed leave the counts too, until the live list drops them (§9.4).
  useEffect(() => {
    markAsksAnswered((dispatcherItems.data ?? []).flatMap((item) => (item.kind === "ask" && item.state !== "open" ? [item.signal] : [])));
  }, [dispatcherItems.data]);
  const resolvedSignals = useMemo(() => bellResolved(resolvedAsks.data, answeredAsks), [resolvedAsks.data, answeredAsks]);
  // The counts and N/U cover the filtered project, else every live member of the group shown, unfiltered too
  // (BOARD-GROUPS-SPEC §3, §4; Ruling, Noah 2026-11-10); the sidebar badge and Search stay global.
  const overviewCover = useMemo(() => overviewScope(project, liveProjects), [project, liveProjects]);
  const stepScope = useMemo(() => boardScope(overviewCover.projects.map((p) => p.id)), [overviewCover]);
  const needsIds = useMemo(() => needsQueue(attention, resolvedSignals, stepScope), [attention, resolvedSignals, stepScope]);
  const needYouCount = useMemo(() => needsCount(attention, resolvedSignals, stepScope), [attention, resolvedSignals, stepScope]);
  const changed = useMemo(() => changeItem(dispatcherItems.data), [dispatcherItems.data]);
  const updatedIds = useMemo(() => updatedQueue(changed, attention, resolvedSignals, stepScope), [changed, attention, resolvedSignals, stepScope]);
  const [step, setStep] = useState<(Step & { kind: StepKind }) | null>(null);
  const stepQueue = step?.kind === "updated" ? updatedIds : needsIds;
  const stepWhere = step ? stepPosition(stepQueue, step) : null;
  // Remember where the card sits while it is in the queue, to find its neighbours once it drops out.
  useEffect(() => {
    if (step && stepWhere?.index != null && stepWhere.index !== step.index) setStep({ ...step, index: stepWhere.index });
  }, [step, stepWhere?.index]);
  // Closing the card (Esc, its close button) or opening another one ends the step-through.
  useEffect(() => {
    if (step && taskId !== step.taskId) setStep(null);
  }, [taskId]);
  const stepAsks = useMemo(() => (step?.kind === "needs" ? cardAsks(dispatcherItems.data, step.taskId, answeredAsks) : []), [step?.kind, step?.taskId, dispatcherItems.data, answeredAsks]);
  // A card of the step-through: its card, and the session that waits there (need-you: the one asking, when only one
  // does; updated: its unread chat, which opening reads).
  const showStepCard = (kind: StepKind, id: string) => {
    const queue = kind === "updated" ? updatedIds : needsIds;
    setStep({ kind, ...stepAt(queue, id) });
    setMenu(null);
    const item = attentionByTask.get(id);
    const sessionId = stepSession(item, kind, resolvedSignals);
    if (!item || !sessionId) return openTaskById(id);
    setDrawerFocus(null);
    focusGroupOf(item.project.id); // board-groups 3/7
    setTask(item.task.id);
    setMobileStatus(item.task.status);
    setSessionEntry({ taskId: item.task.id, sessionId, requestId: `attention-${Date.now()}` });
  };
  // A start before the board and sessions are read (a notification's link at launch) waits for them.
  const [pendingStep, setPendingStep] = useState<StepKind | null>(null);
  const startStep = useStableCallback((kind: StepKind) => {
    // Both queues read the sessions now (updated holds the unread turns).
    if (!projected || !agents.data) return setPendingStep(kind);
    const queue = kind === "updated" ? updatedIds : needsIds;
    if (!queue.length) return void toast.show(kind === "needs" ? t("Nothing needs your attention.") : t("Nothing new to read."), { variant: "info" });
    // Pressing the open step-through's own chip keeps its card (it would otherwise restart and mark every chat read).
    const target = stepStartTarget(step, step?.kind ?? null, kind, queue);
    if (target) showStepCard(kind, target);
  });
  useEffect(() => {
    if (pendingStep && projected && agents.data) {
      setPendingStep(null);
      startStep(pendingStep);
    }
  }, [pendingStep, !!projected, !!agents.data]);
  const startNeeds = useStableCallback(() => startStep("needs"));
  const startUpdated = useStableCallback(() => startStep("updated"));
  const stepPrev = useStableCallback(() => step && stepWhere?.prev && showStepCard(step.kind, stepWhere.prev));
  const stepNext = useStableCallback(() => step && stepWhere?.next && showStepCard(step.kind, stepWhere.next));
  const endStep = useStableCallback(() => setStep(null));
  const stepChanged = useStableCallback(() => {
    void queryClient.invalidateQueries({ queryKey: dispatcherItemsKey });
    void queryClient.invalidateQueries({ queryKey: ["flowly", "attention-count"] });
    void queryClient.invalidateQueries({ queryKey: asksResolvedKey });
  });
  // The project's tag vocabulary, plus prefix options for hierarchical tags (CARD-TAGS-SPEC §6.4). All: the union.
  const projectTags = useMemo(() => {
    const ids = allView ? liveProjects.map((p) => p.id) : project ? [project.id] : [];
    return [...new Set(ids.flatMap((id) => projectTagStats(board?.tasks || [], id).map((x) => x.tag)))];
  }, [board?.tasks, viewKey, liveProjects]);
  const tagFilterOptions = useMemo(() => {
    const all = [...new Set([...tagPrefixes(projectTags), ...projectTags, ...tagFilter])];
    return all;
  }, [projectTags, tagFilter]);
  const filterCount =
    Number(!!search) +
    Number(priority !== "all") +
    Number(taskType !== "all") +
    Number(tagFilter.length > 0) +
    Number(!!validFilterId);
  const refresh = () => {
    if (taskId) void invalidateCardViews(queryClient);
    else void data.refetch();
    void resources.refetch();
    void agents.refetch();
    void readState.refetch();
  };
  async function doAction(action: () => Promise<unknown>, success = "", after?: () => void) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      if (success) toast.show(success, { variant: "success" });
      after?.();
    } catch (e) {
      setError(message(e));
    } finally {
      mutationLock.current = false;
      setPending(false);
      refresh();
    }
  }
  const dismissRpc = useRpc(rpc.dismissAttention),
    restoreRpc = useRpc(rpc.restoreAttention);
  // Snooze acts on one list with the card's current keys of that list; Unsnooze clears both (ATTENTION-DISMISS-SPEC, Card menu).
  const snoozeList = useStableCallback((item: AttentionItem, list: SnoozeList) => {
    const signals = listSignals(item, list);
    if (!signals.length) return;
    void doAction(() => dismissRpc({ taskId: item.task.id, list, signals }), t("Snoozed. It comes back when something new happens."));
  });
  const unsnooze = useStableCallback((taskId: string) => void doAction(() => restoreRpc({ taskId }), t("Unsnoozed.")));
  const move = (input: { id: string; revision: number; status: Status }) => {
    const card = data.data?.tasks.find((t) => t.id === input.id);
    const from = card?.status;
    void doAction(
      () => updateTask(input),
      t("Moved to {name}", { name: card ? cardLaneName(card, input.status) : nameOf(input.status) }),
      () => askWrapup(input.id, from, input.status),
    );
  };
  const place = (input: Placement) => {
    const card = data.data?.tasks.find((t) => t.id === input.id);
    const from = card?.status;
    // Every group column is a lane of every member (BOARD-GROUPS-SPEC §4); with no group known, a column the card's own
    // project has no lane for refuses the drop (ALL-PROJECTS-SPEC §4).
    if (allView && card && !dropAllowed(projectOf(card), input.status, group)) {
      toast.show(t("{lane} is not a lane in {project}.", { lane: nameOf(input.status), project: projectOf(card)?.title ?? "" }), { variant: "info" });
      return;
    }
    void doAction(
      () => placeTask(input),
      from === input.status ? "" : t("Moved to {name}", { name: card ? cardLaneName(card, input.status) : nameOf(input.status) }),
      () => askWrapup(input.id, from, input.status),
    );
  };
  const openMenu = useMenuOpener();
  const menuControl = useMenuControl();
  // Open the card's workspace in Paseo (CARD-DISPLAY-SPEC §7): only a host that can, only a live workspace.
  const canOpenWorkspace = typeof props.navigation?.openWorkspace === "function";
  const openCardWorkspace = useStableCallback((card: Task) => openNativeWorkspace(props.navigation, card.workspaceId, props.host.id));
  const cardMenu = (card: Task): MenuEntry[] =>
    boardCardMenu({
      card,
      statuses: cardStatuses(card),
      laneName: (status) => cardLaneName(card, status),
      ownArchived: !!projectOf(card)?.archivedAt,
      pending,
      compact,
      allView,
      actions: {
        open: () => setTask(card.id),
        start: () => {
          setTask(card.id);
          setStartRequest({ taskId: card.id, key: `start-${Date.now()}` });
        },
        move: (status) => move({ id: card.id, revision: card.revision, status }),
        reorder: (direction) => void doAction(() => reorder({ id: card.id, revision: card.revision, direction })),
        archive: () =>
          void doAction(
            () => updateTask({ id: card.id, revision: card.revision, archived: !card.archivedAt }),
            card.archivedAt ? t("Card restored") : t("Card archived"),
          ),
        remove: () => setDeleting(card),
      },
    });
  // One pass over events/agents/workspaces per data change; cards only look up
  // (each card used to filter every event and agent on every render).
  const cardIndex = useMemo(() => {
    const agentsByWorkspace = new Map<string, PaseoAgent[]>();
    for (const a of agents.data || []) {
      if (!a.workspaceId) continue;
      const list = agentsByWorkspace.get(a.workspaceId);
      if (list) list.push(a);
      else agentsByWorkspace.set(a.workspaceId, [a]);
    }
    const workspaceIds = new Set((resources.data?.workspaces || []).map((w) => w.id));
    // Worktree or local, for the card's meta row (CARD-DISPLAY-SPEC §8).
    const workspaceKinds = new Map((resources.data?.workspaces || []).map((w) => [w.id, cardWorkspace(w.kind)]));
    return { agentsByWorkspace, workspaceIds, workspaceKinds };
  }, [agents.data, resources.data]);
  const openIdeaCount = useMemo(() => {
    const counts = new Map<string, number>();
    if (ideasOn) for (const c of projected?.cards || []) counts.set(c.taskId, c.openIdeas);
    return counts;
  }, [projected?.cards, ideasOn]);
  // Ticket, issue and PR keys per card for the card face (CONNECTORS-SPEC §2): the oldest first, then "+n"; pages are left out.
  const externalKeys = useMemo(
    () => new Map((projected?.cards || []).flatMap(c => c.external ? [[c.taskId, c.external] as const] : [])),
    [projected?.cards],
  );
  // Unresolved blockers per card, for the "Waiting on" signal (CARD-LINKS-SPEC §5.1).
  const waitingIndex = useMemo(() => {
    const index = new Map<string, { count: number; titles: string }>();
    if (!board?.links.length) return index;
    for (const t of board.tasks) {
      const blockers = waitingOn(board, t.id);
      if (blockers.length) index.set(t.id, { count: blockers.length, titles: blockers.map((b) => b.title).join(", ") });
    }
    return index;
  }, [board?.links, board?.tasks]);
  // Stable for every card (memoized cards; PERFORMANCE-SPEC §3).
  const openCard = useStableCallback((t: Task) => {
    perfMark("drawer.open");
    setDrawerFocus(null);
    setTask(t.id);
  });
  const openCardActions = useStableCallback((t: Task, at: Point) => openMenu?.(at, t.title, cardMenu(t)));
  const cardMenuFor = useStableCallback((t: Task) => cardMenu(t));
  // Stable drawer callbacks (memoized drawer).
  const closeDrawer = useStableCallback(() => {
    setDrawerFocus(null);
    setTask("");
  });
  const editDrawerTask = useStableCallback(() => task && setTaskForm({ task, status: task.status }));
  // IDEAS-SPEC §6: a new task prefilled from the idea and its source card: Quick task locked to the idea's project,
  // else (Quick task for New task off) the full form (QUICK-TASK-SPEC §10). `other`: Other options…' card actions.
  const createFromIdea = useStableCallback((idea: Idea, other?: IdeaOther) => {
    const source = board?.tasks.find((t) => t.id === idea.taskId);
    const progress = idea.taskId ? cardProgress(summaries.data, idea.taskId) : undefined;
    const form: TaskSeed = {
      ideaId: idea.id,
      title: idea.title,
      description: ideaDescription(idea, source, progress),
      type: idea.type,
      priority: idea.priority,
      tags: idea.tags,
    };
    if (newTaskFromIdea(view.values?.quickTaskDefault ?? true) === "form") return setTaskForm({ status: "todo", projectId: idea.projectId, seed: form });
    setQuickTask({
      status: "todo",
      projectId: idea.projectId,
      seed: ideaQuickSeed(idea, source, progress),
      idea: { form, options: other?.options ?? [{ kind: "form" }], ...(other ? { run: other.run } : {}) },
    });
  });
  // An idea link's Other options…: the card's own actions too, as from the drawer (QUICK-TASK-SPEC §10).
  const linkOther = (idea: Idea): IdeaOther => {
    const card = idea.taskId ? board?.tasks.find((t) => t.id === idea.taskId) : undefined;
    return {
      options: ideaLinkOptions(idea, card, idea.taskId ? ideaSessionsOf(idea.taskId) : []),
      run: (option) => {
        if (option.kind === "new-session") return ideaInNewSession(idea);
        if (option.kind !== "continue") return;
        const session = option.session;
        void adoptIdea({ id: idea.id, agentId: session.id })
          .then(() => invalidateCardViews(queryClient))
          .then(
            () => toast.show(t("Sent to {session}", { session: session.title || t("the session") }), { variant: "success" }),
            (e) => toast.show(message(e), { variant: "error" }),
          );
      },
    };
  };
  useEffect(() => {
    if (ideaInput.error) {
      setError(ideaInput.error);
      return;
    }
    const link = ideaInput.link;
    if (!link || !board || appliedIdea.current === link.requestId) return;
    appliedIdea.current = link.requestId;
    // A fresh read of the idea's project (older links name none: each project in turn), never the whole board.
    const projectIds = link.projectId ? [link.projectId] : board.projects.map((p) => p.id);
    void (async () => {
      for (const projectId of projectIds) {
        let ideas;
        try {
          ideas = await readProjectIdeas({ projectId }).then((r) => r.value?.ideas ?? []);
        } catch (e) {
          if (gone(e, PROJECT_UNAVAILABLE)) continue;
          if (appliedIdea.current === link.requestId) setError(e instanceof Error ? e.message : String(e));
          return;
        }
        // A newer link arrived while this one was reading: it owns the board now.
        if (appliedIdea.current !== link.requestId) return;
        const idea = ideas.find((i) => i.id === link.ideaId);
        if (!idea) continue;
        // Never another idea: a gone or closed one is an error on the board. The idea names its project,
        // so a card created moments ago need not be in this overview yet.
        if (idea.status !== "open") break;
        setError("");
        setPage(null);
        focusGroupOf(idea.projectId, false); // board-groups 3/7: the idea's group
        createFromIdea(idea, linkOther(idea));
        return;
      }
      if (appliedIdea.current === link.requestId) setError(t("This idea is no longer open."));
    })();
  }, [ideaInput, board]);
  // WORKFLOW-INSIGHTS-SPEC §5.2: the new-task form, prefilled from a suggestion.
  const createFromFinding = useStableCallback((finding: Finding) =>
    setTaskForm({
      status: "todo",
      seed: {
        insightFindingId: finding.id,
        title: finding.title,
        description: findingDescription(
          finding,
          finding.cards.map((id) => board?.tasks.find((t) => t.id === id)?.title).filter((x): x is string => !!x),
        ),
        type: "chore",
        tags: ["agent-workflow", ...(finding.target === "paseo_script" || finding.target === "worktree_setup" ? ["paseo-json"] : [])],
      },
    }),
  );
  const openAiSettings = useStableCallback(() => {
    setSettingsSection("ai");
    setMenu("settings");
  });
  const openSettingsAt = useStableCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setMenu("settings");
  });
  // CARD-LINKS-SPEC §5.5: the new-task form, linked as a follow-up of `source`.
  const followUp = useStableCallback((source: Task) =>
    setTaskForm({
      status: "todo",
      projectId: source.projectId,
      seed: { followUpOf: source.id, followUpTitle: source.title, title: "", description: "", type: source.type, priority: source.priority },
    }),
  );
  const linkFrom = useStableCallback((source: Task) => setLinking(source));
  const openTaskById = useStableCallback((id: string) => {
    setDrawerFocus(null);
    const target = currentDetail?.relatedTasks.find(t => t.id === id) ?? board?.tasks.find(t => t.id === id);
    // Only the full overview proves a card is gone: a cold direct link holds just its own card.
    if (!target && overviewData.data) return void toast.show(t("This card no longer exists."), { variant: "info" });
    if (target) { setDetailTarget(target); focusGroupOf(target.projectId); } // board-groups 3/7
    setTask(id);
  });
  // Card links in the dispatcher chat (§9.3): a card's current title and state from every project, archived included.
  const resolveCard = useStableCallback((id: string) => {
    const task = board?.tasks.find((x) => x.id === id);
    if (!task) return null;
    const owner = projectById.get(task.projectId);
    return { title: task.title, archived: !!task.archivedAt, openable: !!owner && !owner.archivedAt };
  });
  // The left dock is the dispatcher chat (§9.3; Ruling, Noah 2026-11-09): open or minimized (phones: the page shown).
  const dockAvailable = !!project || allView;
  const setDockOpen = useStableCallback((open: boolean) => {
    const now = compact ? chat.open : chatOpen;
    if (open && !now && onboarding.values && !onboarding.values.tipsSeen.includes("dispatcher")) void onboarding.markTipSeen("dispatcher"); // Opening the chat is acting on its tip.
    if (compact) {
      if (open && task) setTask(""); // Phones: the dock page sits under an open card, so the card closes to show it.
      setChat((c) => (c.open === open && c.mounted ? c : { open, mounted: c.mounted || open }));
    } else if (open !== chatOpen) void view.update({ chatMinimized: !open });
  });
  const openDock = useStableCallback(() => setDockOpen(true));
  // D / the toolbar button opened the dock: the chat focuses its message box (each request is distinct).
  const [chatFocus, setChatFocus] = useState(0);
  // The dock is the active area (Ruling, Noah 2026-11-09): its box gained focus or the user pressed inside it, and nothing
  // else on the board since. Esc acts on it first (escAction).
  const dockActive = useRef(false);
  const markDockActive = useStableCallback(() => {
    dockActive.current = true;
  });
  // The phone header's Dispatcher button: the chat page, or closed when it shows.
  const toggleChat = useStableCallback(() => {
    const open = compact ? chat.open : chatOpen;
    if (!open) {
      setChatFocus((n) => n + 1);
      dockActive.current = true;
    }
    setDockOpen(!open);
  });
  // Discuss on an idea (DISPATCHER-SPEC §9.5): a draft for the chat's message box; the key makes each press distinct.
  const [chatDraft, setChatDraft] = useState<{ text: string; key: number } | null>(null);
  const canDiscuss = discussAvailable({ project: !!project, allView });
  // Each draft is used once: a panel remounted later (phone/desktop layout flip) must not add it again.
  const draftFilled = useStableCallback((key: number) => setChatDraft((d) => (d?.key === key ? null : d)));
  const discussIdea = useStableCallback((idea: Idea) => {
    setChatDraft({ text: discussIdeaText(idea, projectById.get(idea.projectId)?.title ?? ""), key: Date.now() });
    // Opening the chat is acting on its tip, and pressing Discuss on the Discuss tip.
    const seen = onboarding.values?.tipsSeen;
    if (seen && !seen.includes("idea-discuss")) void onboarding.markTipSeen("idea-discuss");
    setDockOpen(true);
  });
  const closeChat = useStableCallback(() => {
    dockActive.current = false;
    setDockOpen(false);
  });
  // The same decision for Esc in the box (composer onEscape) and Esc on the board (runIntent). Modals take Esc themselves,
  // and board shortcuts are off while one is open, so neither path sees one.
  const decideEsc = useStableCallback((boxFocused: boolean, draftEmpty: boolean) =>
    escAction({ modalOpen: false, dockActive: dockActive.current && chatShown, boxFocused, draftEmpty }),
  );
  const dockBoxEscape = useStableCallback((draftEmpty: boolean) => {
    const action = decideEsc(true, draftEmpty);
    if (action === "closeDock") {
      closeChat();
      (rootRef.current as unknown as { focus?: () => void } | null)?.focus?.(); // Back to the board so its shortcuts work.
    }
    return action;
  });
  const chatLaneOf = useStableCallback((projectId: string, status: string) =>
    laneName(board?.projects.find((p) => p.id === projectId) ?? null, status as Status),
  );
  // Desktop: shown in the same frame it opens, hidden (kept mounted) when closed so its draft stays. No motion either way.
  const chatShown = compact ? chat.open : chatOpen;
  if (!compact && chatShown) chatMounted.current = true;
  // Desktop, docked: the dragged width, kept clear of the board's minimum and an open card sidebar, and re-clamped
  // whenever the window changes; the stored width is untouched by that (§9.3). Expanded ignores it.
  const chatReserved = drawer.active ? width + 8 : 0;
  const toolbarButtons = toolbarDockButtons({ compact, dockAvailable });
  const dockMin = minChatWidth;
  const chatDocked = chatWidth(chatPreferred, surfaceWidth || 1000, chatReserved, dockMin);
  const chatGrip = !compact && !chatExpanded && (
    <ResizeGrip
      width={chatDocked}
      grows="right"
      minWidth={dockMin}
      maxWidth={chatWidth(Infinity, surfaceWidth || 1000, chatReserved, dockMin)}
      labels={{ drag: t("Drag to resize the dispatcher chat"), widen: t("Widen the dispatcher chat"), narrow: t("Narrow the dispatcher chat") }}
      onStart={() => setChatResizing(true)}
      onEnd={() => {
        setChatResizing(false);
        // Saved once, on release, never per frame.
        if (chatPreferred !== (view.values?.chatWidth ?? 0)) void view.update({ chatWidth: chatPreferred });
      }}
      onChange={(next) => {
        const clamped = Math.round(chatWidth(next, surfaceWidth || 1000, chatReserved, dockMin));
        if (clamped !== chatDocked) setChatPreferred(clamped);
      }}
      onReset={() => {
        setChatPreferred(0);
        if (view.values?.chatWidth) void view.update({ chatWidth: 0 });
      }}
    />
  );
  const chatPanel = (compact ? chat.mounted : chatMounted.current) && (
    <Animated.View
      {...({ onPointerDownCapture: markDockActive } as {})}
      pointerEvents={compact || chatOpen ? "auto" : "none"}
      style={
        compact
          ? // Phone: a full-screen page under an open card's sidebar, so closing the card comes back to the chat.
            { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 29, display: chat.open ? "flex" : "none" }
          : {
              // Docked, the grip on its right edge is the divider; expanded, a plain border.
              ...(chatExpanded
                ? { flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: colors.border }
                : { width: chatDocked + 8, flexShrink: 0, flexDirection: "row" }),
              minHeight: 0,
              display: chatShown ? "flex" : "none",
            }
      }
    >
      <LeftDock compact={compact} expanded={chatExpanded} onToggleSize={toggleChatSize} onClose={closeChat} groupName={dispatcherGroupName}>
        <DispatcherPanel visible={chatOpen} compact={compact} laneOf={chatLaneOf} fill={chatDraft} onFilled={draftFilled} focusRequest={chatFocus} onEscape={dockBoxEscape} onBoxFocus={markDockActive} onOpenCard={openTaskById} resolveCard={resolveCard} cardsVersion={board?.tasks} groupId={dispatcherGroupId} />
      </LeftDock>
      {chatGrip}
    </Animated.View>
  );
  const togglePage = (next: "insights" | "ideas" | "guardrails" | "memory" | "search") => {
    ignoredLink.current = linkKey;
    // Opening Insights is acting on the skill-draft tip (INSIGHTS-REDESIGN-SPEC §5).
    if (next === "insights" && onboarding.values && !onboarding.values.tipsSeen.includes("first-skill-draft")) void onboarding.markTipSeen("first-skill-draft");
    // Opening Guardrails is acting on the learned-guideline tip (GUARDRAILS-SPEC §10).
    if (next === "guardrails" && onboarding.values && !onboarding.values.tipsSeen.includes("first-guardrail")) void onboarding.markTipSeen("first-guardrail");
    setPage((current) => (current === next ? null : next));
  };
  const closePage = useStableCallback(() => setPage(null));
  // SEARCH-SPEC §5.3: a result opens its card, switching project first; the Search page stays open.
  const openSearchCard = useStableCallback((card: SearchCard, hit?: SearchHit) => {
    ignoredLink.current = linkKey;
    const focus = hit ? focusOfHit(hit) : null;
    setDrawerFocus(focus ? { ...focus, key: `${card.taskId}:${Date.now()}`, taskId: card.taskId } : null);
    setDetailTarget({ id: card.taskId, workspaceId: card.workspaceId, projectId: card.projectId });
    focusGroupOf(card.projectId); // board-groups 3/7
    setTask(card.taskId);
  });
  // LINEAR-BOARD-SPEC §5: Start card (Quick task with the issue attached) and Open card from the Linear board, each applied once.
  const linearInput = useMemo(() => {
    try {
      return { start: parseLinearStart(props.params), open: parseLinearOpen(props.params), error: "" };
    } catch (error) {
      return { start: null, open: null, error: message(error) };
    }
  }, [props.params?.linearIssue, props.params?.openTaskId, props.params?.requestId]);
  const appliedLinear = useRef("");
  const searchLinear = useRpc(rpc.searchExternal);
  useEffect(() => {
    if (linearInput.error) return setError(linearInput.error);
    const open = linearInput.open;
    if (open) {
      if (appliedLinear.current === open.requestId) return;
      appliedLinear.current = open.requestId;
      setError("");
      setPage(null);
      // As a search result opens its card: switch project first.
      ignoredLink.current = linkKey;
      setDrawerFocus(null);
      setDetailTarget({ id: open.taskId, workspaceId: open.workspaceId, projectId: open.projectId });
      focusGroupOf(open.projectId); // board-groups 3/7
      setTask(open.taskId);
      return;
    }
    const start = linearInput.start;
    if (!start || !board || appliedLinear.current === start.requestId) return;
    appliedLinear.current = start.requestId;
    if (!project && !allView) return setError(t("Create a project first, then start the card again."));
    void (async () => {
      try {
        const found = (await searchLinear({ connectionId: start.connectionId, query: start.key })).results.find((r) => r.key === start.key);
        // A newer link arrived meanwhile: it owns the board now.
        if (appliedLinear.current !== start.requestId) return;
        if (!found) return setError(t("{key} could not be found in Linear.", { key: start.key }));
        setError("");
        setPage(null);
        setTask("");
        setTaskForm(null);
        // Quick task in the board's current project, with the issue attached (LINEAR-BOARD-SPEC §5);
        // on the All board in the last quick-task project (ALL-PROJECTS-SPEC §5).
        setQuickTask({ status: "todo", ...(project ? { projectId: project.id } : { recent: true }), seed: linearQuickSeed(found) });
      } catch (e) {
        if (appliedLinear.current === start.requestId) setError(externalError(e, "linear"));
      }
    })();
  }, [linearInput, !!board, !!project, allView]);
  const openSearchMemory = useStableCallback((hit: SearchMemoryHit) => {
    ignoredLink.current = linkKey;
    focusGroupOf(hit.projectId, true, true); // the Memory page acts on that project
    setPage("memory");
  });
  const openSearch = (text: string) => {
    ignoredLink.current = linkKey;
    setSearchSeed((current) => ({ text, key: current.key + 1 }));
    setPage("search");
  };
  const searchSources = useMemo(
    () => allSearchSources.filter((s) => (s !== "idea" || ideasOn) && (s !== "artifact" || artifactsOn) && (s !== "memory" || features.memory)),
    [ideasOn, artifactsOn, features.memory],
  );
  // Turning Ideas off closes its page.
  useEffect(() => {
    if (!ideasOn) setPage((current) => (current === "ideas" ? null : current));
  }, [ideasOn]);
  // So does turning Insights off.
  useEffect(() => {
    if (!features.insights) setPage((current) => (current === "insights" ? null : current));
  }, [features.insights]);
  const showCardIdeas = useStableCallback((id: string) => {
    // Ideas is per project: from the All board, switch to the card's project first.
    const source = board?.tasks.find((x) => x.id === id);
    if (source) focusGroupOf(source.projectId, false, true); // the Ideas page acts on that project
    setIdeaCard(id);
    setPage("ideas");
    setTask("");
  });
  // "Do it in a new session" from the Ideas page: the card's drawer opens its Start session form.
  const ideaInNewSession = useStableCallback((idea: Idea) => {
    if (!idea.taskId) return;
    setTask(idea.taskId);
    setStartRequest({ taskId: idea.taskId, key: `start-${Date.now()}`, idea });
  });
  const ideaSessionsOf = useStableCallback((id: string) => {
    const t = board?.tasks.find((x) => x.id === id);
    const list = (t && cardIndex.agentsByWorkspace.get(t.workspaceId)) || noAgents;
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  });
  const projectIdeasData = useProjectIdeasQuery(props.host.id, project?.id || "", page === "ideas" && (!compact || !taskId));
  const projectIdeaList = useMemo(() => projectIdeasData.data?.ideas || [], [projectIdeasData.data]);
  const projectOpenIdeas = useMemo(() => projectOpenIdeaCount(projected, project?.id), [projected?.cards, projected?.tasks, projected?.projectIdeas, project?.id]);
  // Observing commands and guidelines learned this week (GUARDRAILS-SPEC §7.4); the chip hides when the project turned guardrails off.
  const guardrailCounts = useGuardrailCountsQuery(boardActive && !!project && features.memory);
  const guardrailsOn = features.memory && !!project && project.memory !== false;
  const projectGuardrails = guardrailsOn ? guardrailCounts.data?.[project!.id] : undefined;
  const guardrailCount = guardrailsOn ? (projectGuardrails ? projectGuardrails.observing + projectGuardrails.added : 0) : null;
  const memoryCount = guardrailsOn ? (projectGuardrails?.notes ?? 0) : null;
  // The Memory page's filter, sort and layout (board-view settings, GUARDRAILS-SPEC §7.4).
  const memoryKind = view.values?.memoryKind ?? "all", memorySort = view.values?.memorySort ?? "newest", memoryLayout = view.values?.memoryLayout ?? "list";
  const memoryPrefs = useMemo<MemoryPrefs>(() => ({ memoryKind, memorySort, memoryLayout }), [memoryKind, memorySort, memoryLayout]);
  const saveMemoryPrefs = useStableCallback((patch: Partial<MemoryPrefs>) => void view.update(patch));
  const projectTasks = useMemo(() => (board?.tasks || []).filter((t) => t.projectId === project?.id), [board?.tasks, project?.id]);
  // A session of this project has a live Paseo child agent (SUBAGENTS-SPEC §7).
  const projectHasSubagent = useMemo(() => {
    const workspaces = new Set(projectTasks.filter((x) => !x.archivedAt).map((x) => x.workspaceId).filter(Boolean));
    const list = agents.data || [];
    const sessions = new Set(list.filter((a) => !!a.workspaceId && workspaces.has(a.workspaceId)).map((a) => a.id));
    return list.some((a) => { const parent = parentOf(a); return !!parent && sessions.has(parent); });
  }, [projectTasks, agents.data]);
  // Only to announce connectors to users without a connection (tip "jira-connect").
  const connections = useConnections(auxiliaryActive);
  const projectAttention = useMemo(() => attention.filter((i) => i.project.id === project?.id), [attention, project?.id]);
  // First-run guidance (ONBOARDING-SPEC): the welcome tour, empty-board hint and one-time tips.
  const onboarding = useOnboarding();
  // Tips "first-skill-draft" and "first-workflow-insight": one read per project while either is unseen and the feature on; never polls.
  const workflowPrefs = useSettings(workflowInsightsSettings);
  const workflowOn = workflowPrefs.status === "ready" && workflowSettingsValues(workflowPrefs.values).enabled;
  const workflowTipDue = !!project && workflowOn && !!onboarding.values && !(onboarding.values.tipsSeen.includes("first-workflow-insight") && onboarding.values.tipsSeen.includes("first-skill-draft"));
  const workflowView = useWorkflowInsightsQuery(project?.id || "", boardActive && workflowTipDue, false);
  const inPanel = !!props.workspaceId;
  const dialogOpen = !!menu || !!projectForm || !!groupSettings || !!taskForm || !!quickTask || !!removing || !!deleting || !!wrapPrompt || !!linking || !!switchRequest || !!groupDialog; // board-groups 3/7: group dialogs
  const welcome = welcomeDecision({
    settingsStatus: onboarding.status,
    welcomeSeen: onboarding.values?.welcomeSeen ?? false,
    boardLoaded: !!board,
    projectCount: board?.projects.length ?? 0,
    blocked: dialogOpen || !!taskId,
  });
  const welcomeHandled = useRef("");
  const tourTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tourTimer.current) clearTimeout(tourTimer.current); }, []);
  useEffect(() => {
    if (inPanel || welcomeHandled.current === welcome) return;
    if (welcome === "show") {
      welcomeHandled.current = welcome;
      setWelcomeFirstRun(true);
      setWelcomeOpen(true);
    } else if (welcome === "mark-seen") {
      // Someone who already uses the board is never interrupted, and gets no first-time tips either.
      welcomeHandled.current = welcome;
      void onboarding.markExistingUserSeen();
    }
  }, [welcome, inPanel]);
  const afterTour = useAfterModalClose();
  const closeWelcome = (pointAtSettings = true) => {
    setWelcomeOpen(false);
    setWelcomeFirstRun(false);
    // Only the first-run tour records itself (and this release's What's new) as seen; a manual open changes nothing,
    // also while settings are still loading (ONBOARDING-SPEC §4, WHATS-NEW-SPEC §2).
    if (welcomeFirstRun) void onboarding.markWelcomeSeen();
    // Point at Settings once the tour's modal has gone (two modals never switch in one frame).
    if (pointAtSettings) afterTour(() => setTourClosed(true));
  };
  // Where the toolbar's gear is, for its callout: the toolbar spans the Flowly area from its left edge.
  const [gearBox, setGearBox] = useState<{ x: number; width: number } | null>(null);
  const [toolbarBottom, setToolbarBottom] = useState(0);
  const openSettingsFromToolbar = useStableCallback(() => {
    seeSettingsHint();
    setSettingsSection(undefined);
    setMenu("settings");
  });
  const settingsHint =
    !inPanel &&
    settingsHintDue({
      tipsSeen: onboarding.values?.tipsSeen ?? [],
      tourClosed,
      blocked: !onboarding.values || welcomeOpen || dialogOpen || menu === "settings" || (compact && !!task),
    });
  // What's new (WHATS-NEW-SPEC §2): existing users only, once per release, never over anything else.
  const whatsNewDue = whatsNewDecision({
    settingsStatus: onboarding.status,
    boardLoaded: !!board,
    welcomeSeen: onboarding.values?.welcomeSeen ?? false,
    whatsNewSeen: onboarding.values?.whatsNewSeen ?? "",
    release: latestRelease,
    blocked: dialogOpen || menuControl.isOpen() || !!taskId || welcomeOpen || welcome === "show" || settingsHint,
  });
  const whatsNewShown = useRef(false);
  useEffect(() => {
    if (inPanel || whatsNewDue !== "show" || whatsNewShown.current) return;
    whatsNewShown.current = true;
    setWhatsNewOpen(true);
  }, [whatsNewDue, inPanel]);
  const afterWhatsNew = useAfterModalClose();
  const closeWhatsNew = () => {
    setWhatsNewOpen(false);
    void onboarding.markWhatsNewSeen();
  };
  // What's new "Turn on for this project": the current project's section of Group settings, Auto review first and switched on.
  const turnOnReview = () => {
    if (!project) return;
    openProjectSettings(project, true);
  };
  const whatsNewAction = (action: NonNullable<WhatsNewItem["action"]>) => {
    closeWhatsNew();
    // Settings and the tour are modals too: open them once this one has gone.
    afterWhatsNew(() => (action.to === "settings" ? openSettingsAt(action.section) : action.to === "auto-review" ? turnOnReview() : setWelcomeOpen(true)));
  };
  const seeSettingsHint = () => {
    if (settingsHint) void onboarding.markTipSeen("settings-entry");
  };
  const tipBlocked = !onboarding.values || welcomeOpen || welcome === "show" || dialogOpen || settingsHint || whatsNewOpen || whatsNewDue === "show";
  // A group board with no single project (no filter, several projects) still announces groups (BOARD-GROUPS-SPEC §1).
  const groupBoard = !project && !!group && !task && !compact;
  const tip = inPanel || !board || page
    ? null
    : !project
      ? groupBoard ? nextTip({ tipsSeen: onboarding.values?.tipsSeen ?? [], facts: { ...noTipFacts, groupTabs: allLiveProjects.length > 1 }, blocked: tipBlocked }) : null
      : project.archivedAt
        ? null
        : nextTip({
        tipsSeen: onboarding.values?.tipsSeen ?? [],
        facts: {
          hasCard: !task && projectTasks.some((x) => !x.archivedAt),
          needsYou: projectAttention.length > 0,
          agentQuestion: projectAttention.some((i) => i.asks > 0),
          openIdea: ideasOn && projectOpenIdeas > 0,
          movedToFinished,
          hasArtifact: !task && projectTasks.some(x => factsByTask.get(x.id)?.hasArtifacts),
          hasAgentTag: !task && projectTasks.some((x) => !x.archivedAt && !!x.tags?.some((tag) => tag.by === "agent")),
          nextMove: projectTasks.some((x) => !x.archivedAt && !!factsByTask.get(x.id)?.hasNextMoves),
          olderHidden: older.size > 0 && !(olderShown.includes("done") && olderShown.includes("cancelled")),
          hasTicket: !task && projectTasks.some(x => factsByTask.get(x.id)?.hasExternal),
          cardOpen: !!task,
          noConnection: !task && projectTasks.some((x) => !x.archivedAt) && connections.data?.connections.length === 0,
          groupTabs: !task && !compact && allLiveProjects.length > 1,
          hasWorkpad: !task && workpadEnabled(project) && projectTasks.some(x => factsByTask.get(x.id)?.hasWorkpad),
          busyBoard: !task && projectTasks.filter((x) => !x.archivedAt).length >= 6,
          hasSubagent: projectHasSubagent,
          crowdedAttention,
          cardWithSession: !!task && !!cardIndex.agentsByWorkspace.get(task.workspaceId)?.length,
          fullSidebar: !!task && !!currentDetail && (!!currentDetail.artifacts.length || !!currentDetail.ideas.length),
          hasSummary: !task && !!summaries.data?.latest.some((e) => projectTasks.some((x) => x.id === e.taskId)),
          workflowSuggestion: features.insights && workflowTipDue && !!workflowView.data?.findings.some((f) => f.status === "open" && !(f.target === "skill" && f.skill)),
          skillDraft: features.insights && workflowTipDue && !!workflowView.data?.findings.some((f) => f.status === "open" && f.target === "skill" && !!f.skill),
          searchable: !task && projectTasks.filter((x) => !x.archivedAt).length >= 10,
          dispatcherIntro: !task && !chatOpen && projectTasks.some((x) => !x.archivedAt),
          ideaDiscuss: ideasOn && canDiscuss && projectOpenIdeas > 0,
          reviewShown: !task && projectTasks.some((x) => !!visibleReview(x)),
          learnedGuideline: !task && !!projectGuardrails?.added,
          laneSwipe: touch && !task && !page && shownStatuses.length > 1 && projectTasks.some((x) => !x.archivedAt),
          cardPlan: !!task && !!currentDetail && planApproved(planOf(currentDetail.artifacts, task.id)),
        },
        blocked: tipBlocked,
      });
  // A swipe to another lane shows the lane-swipe tip was not needed.
  const settleLane = (next: Status) => {
    if (next !== mobileStatus && onboarding.values && !onboarding.values.tipsSeen.includes("lane-swipe")) void onboarding.markTipSeen("lane-swipe");
    setMobileStatus(next);
  };
  const dismissTip = (id: TipId) => {
    if (id === "first-done") setMovedToFinished(false);
    void onboarding.markTipSeen(id);
  };
  const emptyProjectHint = !!board && ((allView && allLiveProjects.length > 0) || (!!project && !project.archivedAt)) && !page && !welcomeOpen && !(board.tasks || []).some((x) => inView(x.projectId));
  const deleteDrawerTask = useStableCallback(() => drawer.item && setDeleting(drawer.item.task));
  const drawerStatusChanged = useStableCallback((from: Status | undefined, to: Status) =>
    drawer.item && askWrapup(drawer.item.task.id, from, to),
  );
  const stableRefresh = useStableCallback(() => refresh());
  const drawerAttention = drawer.item ? attentionByTask.get(drawer.item.task.id) : undefined;
  // Content-compared so the memoized drawer does not re-render for an unchanged offer.
  const drawerSnoozeOffer = snoozeMenu(drawerAttention);
  const drawerSnooze = useMemo(
    () => (drawerAttention ? drawerSnoozeOffer : undefined),
    [!!drawerAttention, drawerSnoozeOffer.needs, drawerSnoozeOffer.updated, drawerSnoozeOffer.snoozed],
  );
  const snoozeDrawer = useStableCallback((list: SnoozeList) => drawerAttention && snoozeList(drawerAttention, list));
  const unsnoozeDrawer = useStableCallback(() => drawerAttention && unsnooze(drawerAttention.task.id));
  const sessionEntryConsumed = useStableCallback((requestId: string) =>
    setSessionEntry((current) =>
      current?.requestId === requestId &&
      current.taskId === drawer.item?.task.id &&
      current.sessionId === sessionEntry?.sessionId
        ? null
        : current,
    ),
  );
  const summaryState =
    agents.isPending || readState.isPending
      ? "loading"
      : agents.isError || readState.isError
        ? agents.data && readState.data
          ? "stale"
          : "unavailable"
        : "ready";
  // What a card shows, derived from events, sessions and receipts (each scans a
  // card's whole history). Cached per task object until one of those sources
  // changes, so opening a card, a menu or a filter does not recompute every
  // card of the lane in the same frame as its animation.
  const cardDerived = useMemo(
    () => new WeakMap<Task, Omit<LiveTaskCardProps, "selected" | "flash" | "drag" | "dragging" | "disabled" | "display" | "onOpen" | "onActions" | "menuFor">>(),
    [cardIndex, receipts, summaryState, attentionByTask, managedIds, summaries.data, !!board, openIdeaCount, externalKeys, projectById, allView, waitingIndex, factsByTask, sessionFacts],
  );
  const derivedFor = (t: Task) => {
    let derived = cardDerived.get(t);
    if (derived) return derived;
    const sessions = cardIndex.agentsByWorkspace.get(t.workspaceId) || noAgents;
    const facts = factsByTask.get(t.id);
    // The card's own project, also on the All board (ALL-PROJECTS-SPEC §3).
    const own = projectOf(t);
    derived = {
      task: t,
      legacy: !!own && isLegacyScope(t, own),
      available: cardIndex.workspaceIds.has(t.workspaceId),
      workspace: cardIndex.workspaceKinds.get(t.workspaceId) ?? null,
      wrapped: (t.status === "done" || t.status === "cancelled") && !!facts?.wrapped,
      running: sessions.filter((a) => a.status === "running").length,
      sessions: sessions.length,
      summary: sessionAttentionSummaryFromTurns(sessions, t, receipts, sessionFacts.get(t.id) || noTurnFacts),
      summaryState,
      attentionSnoozed: snoozeMenu(attentionByTask.get(t.id)).snoozed,
      outputSession: pickOutputSession(sessions, t.workspaceId, managedIds),
      progress: cardProgress(summaries.data, t.id),
      questions: facts?.questions ?? 0,
      ideas: openIdeaCount.get(t.id) || 0,
      externalKey: externalKeys.get(t.id)?.text,
      externalFamily: externalKeys.get(t.id)?.family,
      workpad: own && workpadEnabled(own) ? facts?.workpad ?? null : null,
      waiting: waitingIndex.get(t.id)?.count || 0,
      waitingTitles: waitingIndex.get(t.id)?.titles || "",
      projectLabel: allView ? own?.title : undefined,
    };
    cardDerived.set(t, derived);
    return derived;
  };
  const renderCard = (t: Task, drag?: CardDrag, dragging = false) => (
    <LiveTaskCard
      key={t.id}
      {...derivedFor(t)}
      lane={nameOf(t.status)}
      selected={taskId === t.id}
      display={display}
      flash={flashing.has(t.id)}
      drag={drag}
      dragging={dragging}
      disabled={pending || !!projectOf(t)?.archivedAt || !!t.archivedAt}
      onOpen={openCard}
      onActions={openCardActions}
      onOpenWorkspace={canOpenWorkspace ? openCardWorkspace : undefined}
      menuFor={cardMenuFor}
    />
  );
  const renderLane = (status: Status) => (
    <LaneList
      key={status}
      data={laneOf(status).rows}
      keyOf={(row) => row.key}
      renderItem={(row) =>
        row.kind === "task" ? (
          renderCard(row.task)
        ) : row.kind === "older" ? (
          <OlderToggle count={laneOf(status).olderCount} shown={olderShown.includes(status)} onPress={() => toggleOlder(status)} />
        ) : row.hasOlder ? (
          <View style={{ paddingVertical: space[4], alignItems: "center" }}>
            <Label muted selectable={false}>{t("No recent tasks")}</Label>
          </View>
        ) : (
          <View style={{ paddingVertical: space[6], gap: space[3], alignItems: "center" }}>
            <Label muted selectable={false}>
              {filterCount
                ? t("No tasks match these filters.")
                : t("No tasks in {lane}.", { lane: nameOf(status) })}
            </Label>
            <Button
              icon="Plus"
              disabled={!!project?.archivedAt}
              onPress={() => openNewTask(status, allView ? undefined : project?.id)}
            >
              {t("Add task")}</Button>
          </View>
        )
      }
    />
  );
  const projectMenuClose = () => setMenu(null);
  // board-groups 3/7: group order, the group tab menu and the group dialogs (BOARD-GROUPS-SPEC §2–§3).
  const moveGroupRpc = useRpc(rpc.moveGroup),
    createGroupRpc = useRpc(rpc.createGroup),
    deleteGroupRpc = useRpc(rpc.deleteGroup);
  const dialogGroup = groupDialog && groupDialog.kind !== "add" ? boardGroups.find((g) => g.id === groupDialog.groupId) : undefined;
  // board-groups 3/7: a delete dialog whose group vanished (deleted elsewhere) closes instead of lingering invisibly.
  useEffect(() => {
    if (groupDialog && groupDialog.kind !== "add" && boardGroups.length && !dialogGroup) setGroupDialog(null);
  }, [groupDialog, dialogGroup, boardGroups.length]);
  const reorderGroup = (id: string, move: { direction: "up" | "down" } | { to: number }) =>
    void doAction(async () => {
      try {
        await moveGroupRpc({ id, ...move });
      } catch (e) {
        setGroupOrderOverride(null);
        throw e;
      }
    });
  // Drag reorder from the tabs or the switcher: `to` is an index in the group list, which shows every group.
  const dropGroup = (id: string, to: number) => {
    const next = boardGroups.map((g) => g.id).filter((g) => g !== id);
    next.splice(to, 0, id);
    setGroupOrderOverride(next);
    reorderGroup(id, { to });
  };
  // The one way into Group settings (BOARD-GROUPS-SPEC §5): the tab menu, the switcher and the empty-group hint all come
  // here. `groupId` null opens on Add group; `focus` opens a project's section (with Auto review switched on for What's new).
  const onGroupSettings = (groupId: string | null, focus?: { projectId: string; reviewOn?: boolean }) =>
    setGroupSettings({ groupId, ...(focus ? { projectId: focus.projectId, ...(focus.reviewOn ? { reviewOn: true } : {}) } : {}) });
  // A project's settings live in its group's settings page, its section open; a project with no group on this board
  // (a cold link's board, before the overview) keeps Edit project.
  const openProjectSettings = (p: Project, review = false) => {
    const g = groupOf(p);
    if (g) return onGroupSettings(g.id, { projectId: p.id, reviewOn: review });
    setReviewOn(review);
    setProjectForm("edit");
  };
  // A group's settings, with the filtered project's section open when the board shows one project of that group.
  const openGroupSettings = (groupId: string) =>
    onGroupSettings(groupId, project && groupOf(project)?.id === groupId ? { projectId: project.id } : undefined);
  // Live cards per lane over a group's live members, so Group settings can't turn off a lane in use (BOARD-GROUPS-SPEC §5).
  const laneCountsOf = (groupId: string) => groupLaneCounts({ projects: board?.projects || noProjects, tasks: board?.tasks || noTasks }, groupId);
  const groupTabMenu = (g: Group, index: number): MenuEntry[] => [
    { id: "settings", label: t("Group settings"), icon: "SlidersHorizontal", onPress: () => openGroupSettings(g.id) },
    { id: "new-task", label: t("New task"), icon: "Plus", onPress: () => { chooseGroup(g.id); openNewTask("todo"); } },
    { kind: "separator", id: "order" },
    { id: "left", label: t("Move left"), icon: "ChevronLeft", disabled: index === 0 || pending, onPress: () => reorderGroup(g.id, { direction: "up" }) },
    { id: "right", label: t("Move right"), icon: "ChevronRight", disabled: index === boardGroups.length - 1 || pending, onPress: () => reorderGroup(g.id, { direction: "down" }) },
    ...(g.isDefault
      ? []
      : [
          { kind: "separator" as const, id: "danger" },
          { id: "delete", label: t("Delete group…"), icon: "Trash2", danger: true, disabled: pending, onPress: () => setGroupDialog({ kind: "delete", groupId: g.id }) },
        ]),
  ];
  const shortcutsOn = Platform.OS === "web" && !compact;
  const withKey = (text: string, key: string) =>
    shortcutsOn ? `${text} (${key})` : text;
  function runIntent(intent: BoardIntent | Exclude<ShortcutAction, BoardIntent>) {
    // An open menu takes every shortcut but Esc (it steps out or closes).
    if (intent !== "escape" && menuControl.isOpen()) return false;
    switch (intent) {
      case "new-task":
        if (!allView && (!project || project.archivedAt)) return false;
        openNewTask("todo");
        return true;
      case "quick-task":
        if (!board?.projects.some((p) => !p.archivedAt)) return false;
        setPage(null);
        setQuickTask({ status: "todo", recent: true });
        return true;
      case "filters":
        if (!project && !allView) return false;
        setMenu("filters");
        return true;
      case "attention":
        if (!project && !allView) return false;
        startNeeds();
        return true;
      case "updated":
        if (!project && !allView) return false;
        startUpdated();
        return true;
      case "projects":
      case "shortcuts":
        setMenu(intent);
        return true;
      case "welcome":
        setWelcomeOpen(true);
        return true;
      case "insights":
        if (!project || !features.insights) return false;
        togglePage("insights");
        return true;
      case "ideas":
        if (!project || !ideasOn) return false;
        setIdeaCard("");
        togglePage("ideas");
        return true;
      case "guardrails":
        if (!project || !features.memory) return false;
        togglePage("guardrails");
        return true;
      case "memory":
        if (!project || !features.memory) return false;
        togglePage("memory");
        return true;
      case "dispatcher": {
        if (!dockShortcut({ dockAvailable })) return false;
        setChatFocus((n) => n + 1);
        dockActive.current = true;
        setDockOpen(true);
        return true;
      }
      case "search":
        if (!project && !allView) return false;
        if (page === "search") setPage(null);
        else openSearch("");
        return true;
      case "escape":
        if (menuControl.escape()) return true;
        if (decideEsc(false, true) === "closeDock") {
          closeChat();
          return true;
        }
        if (!task && page) {
          setPage(null);
          return true;
        }
        if (!task) return false;
        setEscapeRequest({ taskId: task.id, key: `escape-${Date.now()}` });
        return true;
      case "edit":
        if (!task || task.archivedAt || taskProject?.archivedAt) return false;
        setTaskForm({ task, status: task.status });
        return true;
      case "move-left":
      case "move-right": {
        if (!task || task.archivedAt || taskProject?.archivedAt || pending) return false;
        // The card's own lanes: on the All board they can differ from the columns.
        const target = adjacentStatus(cardStatuses(task), task.status, intent);
        if (!target) return false;
        move({ id: task.id, revision: task.revision, status: target });
        return true;
      }
      default: {
        if (compact || page) return false;
        const expanded = shownStatuses.filter((s) => !collapsedColumns.includes(s));
        const next = navigateGrid(taskGrid(expanded, onScreen, sortColumn), task?.id || "", intent);
        if (!next) return false;
        if (next !== task?.id) setTask(next);
        return true;
      }
    }
  }
  const onKeyDown = (e: WebKeyEvent) => {
    const action = resolveShortcut(
      { ...e, isComposing: e.nativeEvent?.isComposing },
      shortcutsOn && !shortcutsBlocked(),
    );
    if (action && runIntent(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const keyboardProps = shortcutsOn ? { focusable: true, onKeyDown } : {};
  // A press anywhere on the board leaves the dock as the active area; the dock's own capture handler (below the root's in
  // the tree, so it runs after it) takes it back. Web only: other platforms never send these events.
  const pressProps = { onPointerDownCapture: () => { dockActive.current = false; } };
  // Same steps as Esc; on the bare board Back falls through to the host. Open host modals take Back first.
  useAndroidBack(rootRef, () => runIntent("escape"));
  // Opening the board from the sidebar leaves keyboard focus on the host's sidebar row, which draws a
  // focus ring while the board scrolls. Hand focus to the board root (it draws no ring of its own).
  // Once per mount: a later compact -> wide resize must not pull focus out of an active control.
  const focusedRoot = useRef(false);
  useEffect(() => {
    if (!shortcutsOn || focusedRoot.current) return;
    focusedRoot.current = true;
    (rootRef.current as unknown as { focus?: () => void } | null)?.focus?.();
  }, [shortcutsOn]);

  useEffect(() => {
    if (boardPending) return;
    const parsed = parseBoardIntent(props.params);
    if (!parsed || consumedIntents.has(parsed.key)) return;
    consumedIntents.add(parsed.key);
    runIntent(parsed.intent);
  }, [props.params?.intent, props.params?.at, boardPending]);
  const drawerView = drawer.item && (
    <Animated.View
      testID="task-drawer-motion"
      pointerEvents={drawer.active ? "auto" : "none"}
      accessibilityElementsHidden={!drawer.active}
      importantForAccessibility={drawer.active ? "auto" : "no-hide-descendants"}
      style={{
        // Phone: an opaque overlay above the still laid-out board, so opening
        // or closing re-lays out nothing underneath (PERFORMANCE-SPEC §3).
        ...(compact
          ? { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 30, backgroundColor: colors.surface0 }
          : resizingFrom != null
            ? { position: "absolute", top: 0, bottom: 0, right: 0, width: width + 8, minHeight: 0, zIndex: 20, backgroundColor: colors.surface0 }
            : { width: width + 8, minHeight: 0, flexShrink: 0 }),
        flexDirection: "row",
        // Only while opening or closing: at rest no animated props, so a stale native write cannot stay (MotionReveal).
        ...(drawer.settled ? null : { opacity: drawer.progress, transform: [{ translateX: lerp(drawer.progress, [32, 0]) }] }),
      }}
    >
      {!compact && (
        <ResizeGrip
          width={width}
          maxWidth={drawerWidth(Infinity, surfaceWidth || 1000)}
          onStart={() => setResizing(true)}
          onEnd={() => {
            setResizing(false);
            // Saved once, on release, never per frame.
            const share = Math.round(preferredShare * 10000) / 10000;
            if (share !== view.values?.drawerShare) void view.update({ drawerShare: share });
          }}
          onChange={(next) =>
            setPreferredShare(drawerShare(next, surfaceWidth || 1000))
          }
        />
      )}
      <CardDetailProvider hostId={props.host.id} task={drawer.item.task} active={drawer.active} initialRead={false}>
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      {step && stepWhere && step.taskId === drawer.item.task.id && (
        <StepThroughBar
          kind={step.kind}
          position={stepWhere}
          onPrev={stepPrev}
          onNext={stepNext}
          onEnd={endStep}
          asks={stepAsks}
          asksLoading={!dispatcherItems.data}
          onOpenCard={openTaskById}
          onChanged={stepChanged}
          change={changed}
          onAskedDispatcher={openDock}
          groupId={dispatcherGroupId}
        />
      )}
      <TaskDrawer
        key={drawer.item.task.id}
        active={drawer.active}
        task={drawer.item.task}
        project={drawer.item.project}
        events={drawer.item.events}
        compact={compact}
        width={width}
        navigation={props.navigation}
        hostId={props.host.id}
        onClose={closeDrawer}
        onEdit={editDrawerTask}
        onFilterTag={filterByTag}
        onDelete={deleteDrawerTask}
        onCreateFromIdea={ideasOn ? createFromIdea : undefined}
        onDiscussIdea={ideasOn && canDiscuss ? discussIdea : undefined}
        quickTask={view.values?.quickTaskDefault ?? true}
        onLink={linkFrom}
        onFollowUp={followUp}
        onOpenTask={openTaskById}
        onStatusChanged={drawerStatusChanged}
        refresh={stableRefresh}
        sessionDefaults={sessionDefaults}
        escapeRequest={
          escapeRequest?.taskId === drawer.item.task.id ? escapeRequest.key : undefined
        }
        startRequest={
          startRequest?.taskId === drawer.item.task.id ? startRequest.key : undefined
        }
        startIdea={startRequest?.taskId === drawer.item.task.id ? startRequest.idea : undefined}
        onAllIdeas={showCardIdeas}
        guardrails={features.memory && drawer.item.project.memory !== false}
        sessionEntry={
          sessionEntry?.taskId === drawer.item.task.id && drawer.active ? sessionEntry : undefined
        }
        onSessionEntryConsumed={sessionEntryConsumed}
        attention={drawerSnooze}
        onSnooze={snoozeDrawer}
        onUnsnooze={unsnoozeDrawer}
        sectionOrder={(view.values?.drawerOrder || []).join(",")}
        sectionOpen={JSON.stringify(view.values?.drawerOpen || {})}
        focus={drawerFocus?.taskId === drawer.item.task.id ? drawerFocus : undefined}
      />
      </View>
      </CardDetailProvider>
    </Animated.View>
  );
  return (
    <BoardOutputActive.Provider value={boardActive}>
    <SettingsOpenerContext.Provider value={openSettingsAt}>
    <Theme.Provider value={props.theme}>
      <View
        ref={rootRef}
        {...(keyboardProps as {})}
        {...(pressProps as {})}
        {...({ onContextMenu: suppressNativeMenu } as object)}
        onLayout={(e) => setSurfaceWidth(e.nativeEvent.layout.width)}
        // The root only takes focus to receive shortcuts; it must not draw a focus ring.
        style={{ flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surface0, outlineStyle: "none" } as never}
      >
        {(
          <View
            {...covered}
            onLayout={(e) => setToolbarBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
            style={{
              paddingHorizontal: space[3],
              height: touch ? 56 : 48,
              gap: space[2],
              flexDirection: "row",
              alignItems: "center",
              borderBottomWidth: project ? 0 : 1,
              borderColor: colors.border,
            }}
          >
            {/* board-groups 3/7: group tabs; phones (and a board with no group yet) show the shown group's switcher. */}
            {compact || boardGroups.length === 0 ? (
              <ProjectSwitcher
                title={group?.name ?? t("Projects")}
                shortcut={shortcutsOn ? "P" : ""}
                onPress={() => setMenu("projects")}
              />
            ) : (
              <GroupTabs
                groups={boardGroups}
                activeId={group?.id ?? ""}
                shortcut={shortcutsOn ? "P" : ""}
                onSelect={chooseGroup}
                onManage={() => setMenu("projects")}
                onCreate={() => setProjectForm("new")}
                menuFor={groupTabMenu}
                onMove={dropGroup}
                reorderDisabled={pending}
              />
            )}
            {!compact && (!!project || allView) && filterCount > 0 && (
              // The overview counts the whole project; with filters on, say how many are shown.
              <Label muted size={font.sm} selectable={false}>
                {t("{n} shown", { n: visible.length })}
              </Label>
            )}
            {(compact || projects.length === 0) && <View style={{ flex: 1 }} />}
            {!compact && (
              <IconButton icon="CircleHelp" label={t("Welcome tour")} onPress={() => setWelcomeOpen(true)} />
            )}
            {shortcutsOn && (
              <IconButton
                icon="Keyboard"
                label={withKey(t("Keyboard shortcuts"), "?")}
                onPress={() => setMenu("shortcuts")}
              />
            )}
            {/* Opens the dock, or minimizes it when open; a minimized dock leaves nothing else on the board (§9.3; Ruling, Noah 2026-11-09). */}
            {toolbarButtons.dispatcher && <IconButton icon="Bot" label={withKey(t("Dispatcher"), "D")} active={chatShown} onPress={toggleChat} />}
            {toolbarButtons.bell && (
              <AttentionButton count={needYouCount} compact={compact} open={step?.kind === "needs"} shortcut={shortcutsOn ? "N" : ""} onPress={startNeeds} />
            )}
            {/* Settings (the gear); its first-run callout hangs under it (ONBOARDING-SETUP-SPEC §5). */}
            <View onLayout={(e) => setGearBox(e.nativeEvent.layout)}>
              <IconButton icon="Settings" label={t("Flowly settings")} active={menu === "settings"} onPress={openSettingsFromToolbar} />
              {settingsHint && <HintOutline />}
            </View>
            {!compact && <SortButton
              mode={boardSort}
              onPress={(event) =>
                openMenu?.(eventPoint(event), t("Sort cards"), [
                  { kind: "label", id: "label", label: t("Sort cards in each column") },
                  ...boardSorts.map((mode) => ({
                    id: mode,
                    label: t(boardSortText[mode].label),
                    icon: sortIcons[mode],
                    checked: mode === boardSort,
                    onPress: () => chooseSort(mode),
                  })),
                  { kind: "separator", id: "display" },
                  {
                    id: "card-display",
                    label: t("Card display…"),
                    icon: "LayoutList",
                    onPress: () => {
                      setSettingsSection("cards");
                      setMenu("settings");
                    },
                  },
                ])
              }
            />}
            {(!!project || allView) && (
              <IconButton icon="Search" label={withKey(t("Search"), "S")} active={page === "search"} onPress={() => (page === "search" ? setPage(null) : openSearch(""))} />
            )}
            <FilterButton
              count={filterCount}
              // Phones sort from the Filters dialog, so a non-manual sort lights its icon too.
              lit={compact && boardSort !== "manual"}
              compact={compact}
              shortcut={shortcutsOn ? "/" : ""}
              onPress={() => setMenu("filters")}
            />
            {(!!project || allView) && !compact && (
              <Button
                primary
                icon="Plus"
                label={withKey(t("New task"), "T")}
                disabled={!!project?.archivedAt}
                onPress={() => openNewTask("todo")}
              >
                {t("New task")}
              </Button>
            )}
          </View>
        )}
        {board && overviewCover.projects.length > 0 && (
          <View {...covered}>
          <OverviewBar
            overview={boardOverview(overviewCover.projects, board.tasks, agents.data || [], attention)}
            needYou={needYouCount}
            onNeedYou={startNeeds}
            updated={updatedIds.length}
            onUpdated={startUpdated}
            updatedShortcut={shortcutsOn ? "U" : ""}
            // Insights, Ideas, Guardrails and Memory act on one project: hidden unfiltered (§4).
            onInsights={features.insights && overviewCover.perProject ? () => togglePage("insights") : undefined}
            insightsShortcut={shortcutsOn ? "I" : ""}
            openIdeas={ideasOn && overviewCover.perProject ? projectOpenIdeas : null}
            onIdeas={() => {
              setIdeaCard("");
              togglePage("ideas");
            }}
            ideasShortcut={shortcutsOn ? "B" : ""}
            guardrailCount={guardrailCount}
            onGuardrails={() => togglePage("guardrails")}
            guardrailsShortcut={shortcutsOn ? "G" : ""}
            memoryCount={memoryCount}
            onMemory={() => togglePage("memory")}
            memoryShortcut={shortcutsOn ? "M" : ""}
          />
          </View>
        )}
        {emptyProjectHint && group && !liveProjects.length ? (
          // An empty group still opens (BOARD-GROUPS-SPEC §3): say how to fill it. board-groups 3/7: a new project in it.
          <GuideBanner
            text={t("This group has no projects yet.")}
            actionLabel={t("New project")}
            onAction={() => setProjectForm("new")}
            secondaryLabel={t("Group settings")}
            onSecondary={() => openGroupSettings(group.id)}
          />
        ) : emptyProjectHint && (
          <GuideBanner
            text={t("Add your first task. It gets its own workspace and sessions.")}
            actionLabel={t("New task")}
            onAction={() => openNewTask("todo", allView ? undefined : project?.id)}
          />
        )}
        {!emptyProjectHint && !!tip && (
          <GuideBanner
            text={tipText[tip](compact)}
            dismissLabel={t("Got it")}
            onDismiss={() => dismissTip(tip)}
          />
        )}
        {(boardError || error) && (
          <View style={{ paddingHorizontal: space[3], paddingTop: space[3], gap: space[2] }}>
            <Notice>{error || message(boardError)}</Notice>
            <View style={{ flexDirection: "row" }}>
              <Button
                quiet
                icon="RefreshCw"
                onPress={() => {
                  setError("");
                  refresh();
                }}
              >
                {t("Retry")}</Button>
            </View>
          </View>
        )}
        {!!input.link && resolvedLink.isPending && ignoredLink.current !== linkKey && (
          <View style={{ paddingHorizontal: space[4], paddingTop: space[3] }}>
            <Label muted>{t("Opening linked card…")}</Label>
          </View>
        )}
        {!!(input.error || (ignoredLink.current !== linkKey && resolvedLink.error)) && (
          <View style={{ paddingHorizontal: space[3], paddingTop: space[3], gap: space[2] }}>
            <Notice>{input.error || message(resolvedLink.error)}</Notice>
            {!input.error && (
              <View style={{ flexDirection: "row" }}>
                <Button quiet icon="RefreshCw" onPress={() => { ignoredLink.current = ""; appliedLink.current = ""; setTaskState(""); void resolvedLink.refetch(); }}>
                  {t("Retry linked card")}</Button>
              </View>
            )}
          </View>
        )}
        {boardPending ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Label muted>{t("Loading board…")}</Label>
          </View>
        ) : !project && (!allView || !allLiveProjects.length) ? (
          // No live project at all: this first-run screen wins over a chosen group (BOARD-GROUPS-SPEC §6, Ruling 2026-11-10).
          <View
            style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: space[6] }}
          >
            <View style={{ maxWidth: 360, gap: space[3], alignItems: "center" }}>
              <Icon name="PanelsTopLeft" size={28} color={colors.foregroundMuted} />
              <Label bold size={font.lg}>
                {t("No projects yet")}</Label>
              <View style={{ paddingBottom: space[2] }}>
                <Label muted size={font.md}>
                  {t("A project maps to one Paseo project root. Add tasks to it and each task gets its own workspace and sessions.")}</Label>
              </View>
              <Button primary icon="Plus" onPress={() => setProjectForm("new")}>
                {t("Create project")}</Button>
              <View style={{ paddingTop: space[3] }}>
                <ConceptStrip onTour={() => setWelcomeOpen(true)} />
              </View>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, minHeight: 0, flexDirection: "row", ...(resizing || chatResizing ? { userSelect: "none" } : null) } as never}>
            {/* Desktop: the dispatcher chat docks on the left; the board narrows beside it (DISPATCHER-SPEC §9). */}
            {!compact && chatPanel}
            {(
              <MotionReveal
                transitionKey={`${viewKey}|${page || (compact ? (touch ? `pick${lanePick}` : mobileStatus) : "columns")}`}
                direction={-1}
                distance={compact ? 0 : 18}
                {...covered}
                style={
                  chatExpanded
                    ? { display: "none" }
                    : resizingFrom == null
                    ? { flex: 1, minWidth: 0, minHeight: 0 }
                    : { width: resizingFrom, flexGrow: 0, flexShrink: 0, minHeight: 0, overflow: "hidden" }
                }
              >
                {page === "ideas" && project && (!projectIdeasData.data || projectIdeasData.error) ? (
                  <View style={{ padding: space[4] }}>{projectIdeasData.error ? <><Notice>{message(projectIdeasData.error)}</Notice><Button quiet onPress={() => void projectIdeasData.refetch()}>{t("Retry")}</Button></> : <Label muted>{t("Loading cards…")}</Label>}</View>
                ) : page === "insights" && board && project ? (
                  <InsightsPage
                    project={project}
                    tasks={projectTasks}
                    revision={board.revision}
                    compact={compact}
                    active={!(compact && drawer.active)}
                    nameOf={nameOf}
                    onOpenTask={openTaskById}
                    onBack={closePage}
                    onCreateFromFinding={createFromFinding}
                    onOpenSettings={openAiSettings}
                    onOpenGuardrails={guardrailsOn ? () => setPage("guardrails") : undefined}
                  />
                ) : page === "ideas" && ideasOn && board && project ? (
                  <IdeasPage
                    project={project}
                    tasks={projectTasks}
                    ideas={projectIdeaList}
                    compact={compact}
                    cardFilter={ideaCard}
                    nameOf={nameOf}
                    sessionsOf={ideaSessionsOf}
                    onCardFilter={setIdeaCard}
                    onOpenTask={openTaskById}
                    onCreate={createFromIdea}
                    onNewSession={ideaInNewSession}
                    onDiscuss={canDiscuss ? discussIdea : undefined}
                    quick={view.values?.quickTaskDefault ?? true}
                    onBack={closePage}
                  />
                ) : page === "search" && board ? (
                  <SearchPage
                    key={searchSeed.key}
                    projectId={project?.id ?? null}
                    seed={searchSeed.text}
                    compact={compact}
                    sources={searchSources}
                    nameOf={nameOf}
                    onOpenCard={openSearchCard}
                    onOpenMemory={openSearchMemory}
                    onBack={closePage}
                  />
                ) : page === "guardrails" && board && project ? (
                  <GuardrailsPage project={project} tasks={projectTasks} compact={compact} nameOf={nameOf} onOpenTask={openTaskById} onBack={closePage} />
                ) : page === "memory" && board && project ? (
                  <MemoryPage project={project} tasks={projectTasks} compact={compact} prefs={memoryPrefs} nameOf={nameOf} onPrefs={saveMemoryPrefs} onOpenTask={openTaskById} onBack={closePage} />
                ) : compact && !shownStatuses.length ? null : compact ? (
                  // No lanes (an empty group, BOARD-GROUPS-SPEC §3): no lane chooser or pager; the hint above explains.
                  <>
                    <View style={{ paddingHorizontal: space[2], paddingTop: space[2] }}>
                      <Row
                        title={nameOf(mobileStatus)}
                        label={t("Choose task status")}
                        testID="lane-chooser"
                        leading={<StatusIcon status={mobileStatus} size={16} />}
                        trailing={
                          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                            <Label muted size={font.md} selectable={false}>{laneOf(mobileStatus).count}</Label>
                            <Icon name="ChevronsUpDown" size={14} color={colors.foregroundMuted} />
                          </View>
                        }
                        onPress={() => setMenu("status")}
                      />
                    </View>
                    {touch ? (
                      <LanePager<Status>
                        lanes={shownStatuses}
                        index={Math.max(0, shownStatuses.indexOf(mobileStatus))}
                        active={!boardHidden}
                        onSettle={settleLane}
                        renderLane={renderLane}
                      />
                    ) : (
                      renderLane(mobileStatus)
                    )}
                  </>
                ) : !columnsReady ? null : (
                  <DesktopColumns
                    statuses={shownStatuses}
                    tasks={visible}
                    disabled={pending || !!project?.archivedAt}
                    cancelKey={`${viewKey}|${search}|${priority}|${taskType}|${tagFilter.join(",")}|${archived}|${shownStatuses.join(",")}|${taskId}|${menu}|${projectForm}|${!!groupSettings}|${!!taskForm}|${!!quickTask}`}
                    sortColumn={sortColumn}
                    manualOrder={reorderAllowed(allView, boardSort)}
                    collapsed={collapsedColumns}
                    older={older}
                    olderShown={olderShown}
                    onToggleOlder={toggleOlder}
                    reveal={reveal}
                    nameOf={nameOf}
                    onToggleCollapse={toggleCollapse}
                    onReorderBlocked={() =>
                      allView
                        ? toast.show(t("Each project keeps its own order. Open the project to reorder its cards."), { variant: "info" })
                        : toast.show(t("Sorted by {sort}. Drop on another lane to change status; switch to Manual to reorder within a column.", { sort: t(boardSortText[boardSort].label) }), { variant: "info" })
                    }
                    renderCard={renderCard}
                    onAdd={(status) => openNewTask(status, allView ? undefined : project?.id)}
                    onDrop={place}
                  />
                )}
              </MotionReveal>
            )}
            {!compact && drawerView}
          </View>
        )}

        {/* board-groups 3/7: the group switcher (P): group rows in order, Add group, New project in the shown group. */}
        <Modal
          open={menu === "projects"}
          title={t("Groups")}
          onOpenChange={(open) => {
            if (!open) projectMenuClose();
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              <SortableList
                items={boardGroups}
                gap={space[1]}
                disabled={pending || touch}
                onMove={dropGroup}
                renderItem={(g, index, pressable) => (
                  <Row
                    title={g.name}
                    icon="Layers"
                    selected={group?.id === g.id}
                    leading={
                      !touch && boardGroups.length > 1 ? (
                        // Grip on the left, tucked against the group icon.
                        <View
                          accessibilityLabel={t("Drag to reorder")}
                          style={{ width: 14, marginLeft: -space[1.5], marginRight: -space[1.5], alignItems: "center", ...({ cursor: "grab" } as object) }}
                        >
                          <Icon name="GripVertical" size={14} color={colors.foregroundMuted} />
                        </View>
                      ) : undefined
                    }
                    trailing={
                      touch && boardGroups.length > 1 ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                          <IconButton icon="ChevronUp" size={36} label={t("Move {title} up", { title: g.name })} disabled={index === 0 || pending} onPress={() => reorderGroup(g.id, { direction: "up" })} />
                          <IconButton icon="ChevronDown" size={36} label={t("Move {title} down", { title: g.name })} disabled={index === boardGroups.length - 1 || pending} onPress={() => reorderGroup(g.id, { direction: "down" })} />
                        </View>
                      ) : undefined
                    }
                    onPress={() => {
                      if (!pressable()) return;
                      chooseGroup(g.id);
                      setTask("");
                      projectMenuClose();
                    }}
                  />
                )}
              />
              <Divider style={{ marginVertical: space[2] }} />
              {group && (
                // The shown group's settings page (BOARD-GROUPS-SPEC §3, §5): phones have no tab menu.
                <Row
                  title={t("Group settings")}
                  detail={group.name}
                  icon="SlidersHorizontal"
                  onPress={() => {
                    projectMenuClose();
                    afterModalClose(() => openGroupSettings(group.id));
                  }}
                />
              )}
              <Row
                title={t("Add group")}
                icon="Plus"
                onPress={() => {
                  projectMenuClose();
                  afterModalClose(() => setGroupDialog({ kind: "add" }));
                }}
              />
              <Row
                title={t("New project")}
                icon="Folder"
                onPress={() => {
                  projectMenuClose();
                  afterModalClose(() => setProjectForm("new"));
                }}
              />
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "filters"}
          title={t("Filters")}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content>
            <Theme.Provider value={props.theme}>
              {liveProjects.length > 1 && (
                <Choices
                  title={t("Project")}
                  value={validFilterId}
                  options={[
                    { value: "", label: t("All") },
                    ...liveProjects.map((p) => ({ value: p.id, label: p.title })),
                  ]}
                  onChange={(id) => setProjectFilter(id && group ? { groupId: group.id, projectId: id } : null)}
                />
              )}
              <Field
                title={t("Search")}
                value={search}
                onChange={setSearch}
                // Filtering re-renders the whole board: keep it out of the keystroke path.
                commitDelay={150}
                placeholder={t("Title, description or #tag")}
              />
              {!!search.trim() && (
                <View style={{ flexDirection: "row" }}>
                  <Button
                    small
                    quiet
                    icon="Search"
                    onPress={() => {
                      const text = search.trim();
                      setMenu(null);
                      afterModalClose(() => openSearch(text));
                    }}
                  >
                    {t("Search everywhere")}</Button>
                </View>
              )}
              {!!(projectTags.length || tagFilter.length) && (
                <View style={{ gap: space[1.5] }}>
                  <Label medium size={font.sm} muted>
                    {t("Tags")}
                  </Label>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
                    {tagFilterOptions.map((tag) => (
                      <TagToggle
                        key={tag}
                        tag={tag}
                        selected={tagFilter.includes(tag)}
                        onToggle={() =>
                          setTagFilter(tagFilter.includes(tag) ? tagFilter.filter((x) => x !== tag) : [...tagFilter, tag])
                        }
                      />
                    ))}
                  </View>
                </View>
              )}
              <Choices
                title={t("Type")}
                value={taskType}
                options={[
                  { value: "all", label: t("All") },
                  ...taskTypes.map((t) => ({ value: t, label: taskTypeLabels[t] })),
                ]}
                onChange={setTaskType}
              />
              <Choices
                title={t("Priority")}
                value={priority}
                options={[
                  { value: "all", label: t("All") },
                  ...priorities.map((p) => ({ value: p, label: priorityLabels[p] })),
                ]}
                onChange={setPriority}
              />
              {compact && (
                <View style={{ gap: space[1.5] }}>
                  <Choices
                    title={t("Sort cards")}
                    value={boardSort}
                    options={boardSorts.map((mode) => ({ value: mode, label: t(boardSortText[mode].label) }))}
                    onChange={chooseSort}
                  />
                  <View style={{ flexDirection: "row" }}>
                    <Button
                      small
                      quiet
                      icon="LayoutList"
                      onPress={() => {
                        setMenu(null);
                        afterModalClose(() => {
                          setSettingsSection("cards");
                          setMenu("settings");
                        });
                      }}
                    >
                      {t("Card display…")}</Button>
                  </View>
                </View>
              )}
              <Actions>
                <Button
                  quiet
                  disabled={!filterCount}
                  onPress={() => {
                    setProjectFilter(null);
                    setSearch("");
                    setPriority("all");
                    setTaskType("all");
                    setTagFilter([]);
                  }}
                >
                  {t("Reset filters")}</Button>
                <Button icon="RefreshCw" onPress={refresh}>
                  {t("Refresh")}</Button>
                <Button primary onPress={() => setMenu(null)}>
                  {t("Done")}</Button>
              </Actions>
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "shortcuts"}
          title={t("Keyboard shortcuts")}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[4], gap: space[3] }}>
            <Theme.Provider value={props.theme}>
              <Label muted size={font.md}>
                {t("Board shortcuts work on desktop while focus is inside the board: click an empty part of the board or a card first. They pause while typing or while a dialog is open. From anywhere in Paseo, open the Command Center and search “Flowly”.")}</Label>
              <View style={{ gap: space[1] }}>
                {shortcutHelp.map((item) => (
                  <View
                    key={item.title}
                    style={{ flexDirection: "row", alignItems: "center", gap: space[3], minHeight: 32 }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Label size={font.base} selectable={false}>{t(item.title)}</Label>
                    </View>
                    <View style={{ flexDirection: "row", gap: space[1] }}>
                      {item.keys.map((key) => (
                        <KeyHint key={key}>{key}</KeyHint>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "status"}
          title={t("Status")}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              {shownStatuses.map((s) => (
                <Row
                  key={s}
                  title={nameOf(s)}
                  testID={`lane-tab-${s}`}
                  leading={<StatusIcon status={s} size={16} />}
                  selected={s === mobileStatus}
                  trailing={
                    <Label muted size={font.md} selectable={false}>
                      {visible.filter((t) => t.status === s).length}
                    </Label>
                  }
                  onPress={() => {
                    if (s !== mobileStatus) setLanePick((n) => n + 1);
                    setMobileStatus(s);
                    setMenu(null);
                  }}
                />
              ))}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        {removing && (
          <RemoveProjectDialog
            project={removing}
            theme={props.theme}
            onClose={() => setRemoving(null)}
            onRemoved={({ removedTasks, paseo }) => {
              setRemoving(null);
              setTask("");
              // board-groups 3/7: the board stays on its group; the removed project just leaves it.
              const cards = removedTasks ? tn(removedTasks, "{n} card", "{n} cards") : "";
              if (paseo?.error)
                toast.error(cards ? t("{title} removed from the board with {cards}, but Paseo kept the project: {error}", { title: removing.title, cards, error: paseo.error }) : t("{title} removed from the board, but Paseo kept the project: {error}", { title: removing.title, error: paseo.error }));
              else
                toast.show(
                  paseo?.removed
                    ? cards
                      ? t("{title} removed from the board with {cards} and from Paseo; files stay on disk", { title: removing.title, cards })
                      : t("{title} removed from the board and from Paseo; files stay on disk", { title: removing.title })
                    : cards
                      ? t("{title} removed from the board with {cards}; it stays in Paseo", { title: removing.title, cards })
                      : t("{title} removed from the board; it stays in Paseo", { title: removing.title }),
                  { variant: "success" },
                );
              refresh();
            }}
          />
        )}
        {deleting && (
          <DeleteTaskDialog
            task={deleting}
            theme={props.theme}
            onClose={() => setDeleting(null)}
            onDeleted={({ archived }) => {
              setDeleting(null);
              if (taskId === deleting.id) setTask("");
              toast.show(
                !archived
                  ? t("{title} deleted", { title: deleting.title })
                  : archived.workspace
                    ? tn(archived.sessions, "{title} deleted; workspace and {n} session archived", "{title} deleted; workspace and {n} sessions archived", { title: deleting.title })
                    : tn(archived.sessions, "{title} deleted; {n} session archived", "{title} deleted; {n} sessions archived", { title: deleting.title }),
                { variant: "success" },
              );
              refresh();
            }}
          />
        )}
        {projectForm && (
          <ProjectForm
            key={`${projectForm}${reviewOn ? ":review" : ""}`}
            project={projectForm === "edit" ? project : undefined}
            group={projectForm === "edit" ? groupOf(project) : null}
            reviewOn={projectForm === "edit" && reviewOn}
            // board-groups 3/7: a new project goes to the group shown (BOARD-GROUPS-SPEC §3, the + and the empty-group hint).
            groupId={projectForm === "new" ? group?.id : undefined}
            showArchived={archived}
            onShowArchived={setArchived}
            onClose={() => {
              setProjectForm(null);
              setReviewOn(false);
            }}
            onSaved={(id, restored) => {
              focusGroupOf(id); // board-groups 3/7
              setProjectForm(null);
              setReviewOn(false);
              refresh();
              if (restored) toast.show(tn(restored.restored, "Restored {title} with {n} card.", "Restored {title} with {n} cards.", { title: restored.title }), { variant: "success" });
            }}
          />
        )}
        {groupSettings && (
          <GroupSettings
            key={`${groupSettings.groupId}|${groupSettings.projectId ?? ""}|${groupSettings.reviewOn ? "review" : ""}`}
            groupId={groupSettings.groupId}
            groups={boardGroups}
            projects={board?.projects || noProjects}
            laneCounts={laneCountsOf}
            focusProjectId={groupSettings.projectId}
            reviewOn={groupSettings.reviewOn}
            onClose={() => setGroupSettings(null)}
            onChanged={refresh}
            onRemoveProject={(p) => {
              // One dialog at a time: the Remove dialog opens once this page has closed.
              setGroupSettings(null);
              afterModalClose(() => setRemoving(p));
            }}
          />
        )}
        {taskForm && formProject && (
          <TaskForm
            key={taskForm.task?.id || taskForm.seed?.ideaId || taskForm.seed?.insightFindingId || taskForm.seed?.followUpOf || taskForm.seed?.externals?.[0]?.item.key || taskForm.status}
            hostId={props.host.id}
            boardTasks={board?.tasks || noTasks}
            project={formProject}
            task={taskForm.task}
            seed={taskForm.seed}
            defaultStatus={taskForm.status}
            onClose={() => setTaskForm(null)}
            agentDefaults={sessionDefaults}
            group={groupOf(formProject)}
            onSaved={(id, launch, status) => {
              if (taskForm.task && status) askWrapup(id, taskForm.task.status, status);
              setTask(id);
              setTaskForm(null);
              if (launch?.sessionId) toast.show(t("Task created and its agent started"), { variant: "success" });
              else if (launch?.error) toast.error(t("Task created, but the agent did not start: {error}. Start it from the task.", { error: launch.error }));
              // The suggestion now shows "Card created".
              if (taskForm.seed?.insightFindingId) void queryClient.invalidateQueries({ queryKey: ["flowly", "workflow-insights", formProject.id] });
              refresh();
            }}
          />
        )}
        {quickTask && board && (
          <QuickTaskForm
            key={quickTask.seed?.idea?.id || quickTask.seed?.externals[0]?.item.key || "quick"}
            seed={quickTask.seed}
            projects={quickProjects(group ? membersFirst(projects, liveProjects.map((p) => p.id)) : projects, quickTask.seed)}
            initialProjectId={
              // Every board is a group's: the filtered project, else the last quick-task project when a member, else the first
              // (groupQuickProject falls back to All's rule for an empty group).
              (!quickTask.projectId
                ? groupQuickProject(liveProjects, projects, view.values?.lastQuickProjectId ?? "", validFilterId)
                : quickProject(projects, { pinned: quickTask.projectId, last: quickTask.recent ? view.values?.lastQuickProjectId : undefined, current: project?.id || "" })
              )?.id || ""
            }
            defaultStatus={quickTask.status}
            agentDefaultsFor={agentDefaultsFor}
            onClose={() => setQuickTask(null)}
            otherOptions={quickTask.idea?.options}
            onOther={(option) => {
              const idea = quickTask.idea;
              const projectId = quickTask.projectId;
              if (!idea || option.kind === "note") return;
              // What it opens waits for this dialog to close: two Modals in one frame freeze Paseo.
              setQuickTask(null);
              if (option.kind !== "form") return afterModalClose(() => idea.run?.(option));
              if (projectId) focusGroupOf(projectId); // board-groups 3/7
              afterModalClose(() => setTaskForm({ status: "todo", seed: idea.form, ...(projectId ? { projectId } : {}) }));
            }}
            onMore={(more) => {
              // The full form opens once this dialog has closed: two Modals in one frame freeze Paseo.
              setQuickTask(null);
              focusGroupOf(more.projectId); // board-groups 3/7
              // On All the board stays; a drawer for another project's card would sit behind the form and share its
              // session defaults (formProject), so close it.
              if (task && task.projectId !== more.projectId) setTask("");
              afterModalClose(() => setTaskForm({ status: more.status, seed: more.seed, projectId: more.projectId }));
            }}
            onSaved={(projectId, id, launch) => {
              setQuickTask(null);
              focusGroupOf(projectId); // board-groups 3/7
              setTask(id);
              if (launch.sessionId) toast.show(t("Task created and its agent started"), { variant: "success" });
              else if (launch.error) toast.error(t("Task created, but the agent did not start: {error}. Start it from the task.", { error: launch.error }));
              refresh();
            }}
          />
        )}
        {linking && projectOf(linking) && (
          <CardDetailProvider hostId={props.host.id} task={linking} active>
          <LinkPicker
            key={linking.id}
            task={linking}
            project={projectOf(linking)!}
            onClose={() => setLinking(null)}
          />
          </CardDetailProvider>
        )}
        {compact && chatPanel}
        {compact && drawerView}
        {compact && !task && !page && !chat.open && (!!project || allView) && !project?.archivedAt && !!board && (
          <NewTaskFab onPress={() => openNewTask("todo")} />
        )}
        {settingsHint && gearBox && toolbarBottom > 0 && !(compact && (task || chat.open)) && (
          <SettingsHint
            text={tipText["settings-entry"]()}
            top={toolbarBottom + space[1]}
            right={Math.max(space[2], (surfaceWidth || 0) - gearBox.x - gearBox.width)}
            onDismiss={seeSettingsHint}
          />
        )}
        <SettingsModal
          open={menu === "settings"}
          section={settingsSection}
          theme={props.theme}
          onClose={() => setMenu(null)}
          onTour={() => {
            // One dialog at a time: Settings is its own modal, so let it close before the tour opens.
            setMenu(null);
            if (tourTimer.current) clearTimeout(tourTimer.current);
            tourTimer.current = setTimeout(() => setWelcomeOpen(true), 450);
          }}
          onWhatsNew={() => {
            setMenu(null);
            if (tourTimer.current) clearTimeout(tourTimer.current);
            tourTimer.current = setTimeout(() => setWhatsNewOpen(true), 450);
          }}
        />
        <WelcomeTour
          open={welcomeOpen}
          theme={props.theme}
          canCreate={(board?.projects.length ?? 0) === 0}
          firstRun={welcomeFirstRun}
          onClose={() => closeWelcome()}
          onCreate={() => {
            closeWelcome(false);
            // The project form is a Modal too: open it once the tour's has closed (two modals never switch in one frame).
            // The settings callout waits behind the form, so it is set in the same update and never flashes first.
            afterModalClose(() => {
              setProjectForm("new");
              setTourClosed(true);
            });
          }}
        />
        {whatsNew.length > 0 && (
          <WhatsNewWindow open={whatsNewOpen} theme={props.theme} releases={whatsNew} onClose={closeWhatsNew} onAction={whatsNewAction} />
        )}
        {switchTask && switchRequest && (
          <SwitchModal
            key={switchTask.id}
            task={switchTask}
            direction={switchRequest.direction}
            open
            onClose={() => setSwitchRequest(null)}
            onDone={(result) => {
              setSwitchRequest(null);
              toast.show(result.text, { variant: "success" });
              for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
              refresh();
            }}
          />
        )}
        {wrapPromptTask && (
          <WrapupModal
            key={wrapPromptTask.id}
            prompt
            task={wrapPromptTask}
            open
            onClose={() => setWrapPrompt("")}
            onDone={(summary) => {
              setWrapPrompt("");
              toast.show(summary, { variant: "success" });
              refresh();
            }}
          />
        )}
      </View>
    </Theme.Provider>
    </SettingsOpenerContext.Provider>
    </BoardOutputActive.Provider>
  );
}

// board-groups 3/7: the compact switcher names the shown group and opens the group switcher.
function ProjectSwitcher({
  title,
  shortcut,
  onPress,
}: {
  title: string;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={shortcut ? t("Group: {title}. Choose or manage groups ({shortcut})", { title, shortcut }) : t("Group: {title}. Choose or manage groups", { title })}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          height: touch ? 44 : 32,
          paddingHorizontal: space[2],
          marginLeft: -space[1],
          borderRadius: radius.md,
          flexShrink: 1,
          minWidth: 0,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="Layers" size={15} color={colors.foregroundMuted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label bold size={font.base} lines={1} selectable={false}>
          {title}
        </Label>
      </View>
      <Icon name="ChevronsUpDown" size={14} color={colors.foregroundMuted} />
    </Pressable>
  );
}

const sortIcons: Record<BoardSort, string> = {
  manual: "GripVertical",
  activity: "Activity",
  priority: "SignalHigh",
  created: "CalendarPlus",
  title: "ArrowDownAZ",
};

function SortButton({ mode, onPress }: { mode: BoardSort; onPress(event: GestureResponderEvent): void }) {
  const { colors } = useTheme();
  const custom = mode !== "manual";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Sort cards: {label}", { label: t(boardSortText[mode].label) })}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: hover || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="ArrowUpDown" size={15} color={custom ? colors.foreground : colors.foregroundMuted} />
      <Label size={font.md} medium muted={!custom} selectable={false}>
        {custom ? t(boardSortText[mode].label) : t("Sort")}
      </Label>
    </Pressable>
  );
}

function FilterButton({
  count,
  lit = false,
  compact,
  shortcut,
  onPress,
}: {
  count: number;
  lit?: boolean;
  compact: boolean;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count ? t("Task filters, {count} active", { count }) : t("Task filters")}${shortcut ? ` (${shortcut})` : ""}`}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: compact ? 0 : space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="ListFilter" size={15} color={count || lit ? colors.foreground : colors.foregroundMuted} />
      {!compact && (
        <Label size={font.md} medium muted={!count} selectable={false}>
          {t("Filter")}</Label>
      )}
      {!!count && (
        <View
          style={{
            minWidth: 16,
            height: 16,
            paddingHorizontal: 4,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Label size={font.xs} bold color={colors.accentForeground} selectable={false}>
            {String(count)}
          </Label>
        </View>
      )}
    </Pressable>
  );
}

function KeyHint({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: space[1.5],
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Label size={font.sm} medium selectable={false}>{children}</Label>
    </View>
  );
}


export function WorkspaceBoard(props: PluginWorkspacePanelProps) {
  return <BoardScreen {...props} workspaceId={props.workspaceId} />;
}

/** A tag option in the board filter; "module/" options match by prefix. */
function TagToggle({ tag, selected, onToggle }: { tag: string; selected: boolean; onToggle(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tag.endsWith("/") ? t("Tags starting with {prefix}", { prefix: tag }) : t("Tag {tag}", { tag })}
      accessibilityState={{ selected }}
      onPress={onToggle}
      style={(state) => ({
        ...noFocusRing,
        height: touch ? 32 : 26,
        paddingHorizontal: space[2],
        justifyContent: "center",
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: selected ? colors.foregroundMuted : colors.border,
        backgroundColor: selected ? colors.surface2 : (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent",
      })}
    >
      <Label size={font.sm} medium={selected} muted={!selected} selectable={false}>{`#${tag}${tag.endsWith("/") ? "…" : ""}`}</Label>
    </Pressable>
  );
}
