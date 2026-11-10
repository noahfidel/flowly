import { useCardDetailQuery, useTaskDetail } from "./card-detail-query";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isNoMoves, nextMovesAction } from "../shared/next-moves";
import { workpadCheckedAction, workpadUpdatedAction } from "../shared/workpad";
import type { PaseoAgent } from "@getpaseo/client";
import { Linking, Pressable, View } from "react-native";
import { drawerNeedsBoard } from "./query-activity";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, Project, BoardEvent, Idea } from "../shared/model";
import { historyStatusLabel, legacyStatus, priorities, taskTypeLabels, taskTypes, type Status } from "../shared/model";
import { enabledStatuses, laneName } from "../shared/lanes";
import * as rpc from "../shared/rpc";
import {
  Badge,
  Button,
  Divider,
  IconButton,
  Label,
  Notice,
  SectionHeader,
  font,
  radius,
  relativeTime,
  tint,
  space,
  touch,
  useTheme,
  message,
  verticalScroll,
  verticalContent, noFocusRing } from "./ui";
import { PriorityIcon, StatusIcon, TypeIcon, WorkspaceIcon, priorityLabels, workspaceLabel, workspaceLabels } from "./status";
import { cardWorkspace } from "../shared/card-display";
import { useLiveAgents } from "./queries";
import { shallowEqual, useStableCallback } from "./stable";
import { isLegacyScope } from "../shared/scope";
import { SessionCard } from "./session-card";
import { subagentSummary } from "./subagents";
import { RunningDots } from "./running-motion";
import { sessionTree, subagentBucket, type SessionNode } from "../shared/subagents";
import { SessionCreate } from "./session-create";
import { SessionPreview } from "./session-preview";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import type { SessionEntry } from "./session-link";
import { Enter, MotionReveal, useReducedMotion, useSettled } from "./motion";
import { DrawerFocusProvider, FOCUS_FALLBACK_MS, FOCUS_RING_MS, FocusTarget, Marked, activityStart, useMark, type DrawerFocus } from "./drawer-focus";
import { perfLap, perfStart, perfEnd, usePerfRender } from "./perf";
import { TaskMetadata } from "./task-metadata";
import { Chevron, Collapse, Disclosure, Section, useSectionStates } from "./disclosure";
import { WrapupModal } from "./wrapup";
import { currentWrapup } from "../shared/wrapup-state";
import { useComposer } from "./composer";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry, type Point } from "./context-menu";
import { openNativeSession, openNativeWorkspace } from "./session-state";
import { cardQuestions } from "../shared/progress";
import { PendingRequests } from "./session-question";
import { pendingRequests, type PendingRequest, type PermissionReply } from "../shared/permission-question";
import { workspaceSession } from "./session";
import { TaskProgress } from "./task-progress";
import { TaskUsage } from "./task-usage";
import { SessionMarkdown } from "./session-content";
import { TaskIdeas, type IdeaOther } from "./task-ideas";
import { LinkOrigin, TaskLinks } from "./task-links";
import { TaskArtifacts } from "./task-artifacts";
import { TaskWorkpad } from "./task-workpad";
import { TaskTags } from "./task-tags";
import { ReleaseModal, ReleaseNotice, SwitchModal, type SwitchDirection } from "./workspace-switch";
import { drawerSectionOrder, drawerSectionsOpen, type AnyDrawerSection, type DrawerSection } from "../shared/drawer-sections";
import { ideaInstruction } from "../shared/ideas";
import { prReviewCardUrl } from "../shared/pr-review";
import { getLocale, localizedLabels, msg, t, tn } from "../shared/i18n";

type TaskDrawerProps = Parameters<typeof TaskDrawerView>[0];

export const TaskDrawer = memo(TaskDrawerView, (a, b) => sameDrawerProps(a, b));

function TaskDrawerView({
  task,
  project,
  events,
  compact,
  width = 440,
  hostId,
  navigation,
  onClose,
  onEdit,
  onDelete,
  onCreateFromIdea,
  onDiscussIdea,
  quickTask = true,
  onLink,
  onFollowUp,
  onOpenTask,
  onStatusChanged,
  refresh,
  sessionEntry,
  onSessionEntryConsumed,
  active = true,
  sessionDefaults,
  startRequest,
  startIdea,
  onAllIdeas,
  guardrails = false,
  onFilterTag,
  escapeRequest,
  attention,
  onAttention,
  sectionOrder,
  sectionOpen,
  focus,
}: {
  task: Task;
  project: Project;
  events: BoardEvent[];
  compact: boolean;
  width?: number;
  hostId: string;
  navigation: PluginSurfaceProps["navigation"];
  onClose(): void;
  onEdit(): void;
  /** Opens the permanent-delete confirmation (archived cards only). */
  onDelete?(): void;
  /** Opens the new-task form prefilled from an idea (IDEAS-SPEC §6). */
  onCreateFromIdea?(idea: Idea, other?: IdeaOther): void;
  /** Puts a draft about an idea in the dispatcher chat (DISPATCHER-SPEC §9.5); absent: no Discuss. */
  onDiscussIdea?(idea: Idea): void;
  /** *Quick task for New task* is on (default on): a scope-new idea opens Quick task directly. */
  quickTask?: boolean;
  /** Opens "Link to a card…" for this card (CARD-LINKS-SPEC §5.4). */
  onLink?(task: Task): void;
  /** Opens the new-task form as a follow-up of this card (CARD-LINKS-SPEC §5.5). */
  onFollowUp?(task: Task): void;
  /** Opens another card's drawer (idea source or result). */
  onOpenTask?(id: string): void;
  /** After this drawer changed the card's status (the board may ask to wrap up). */
  onStatusChanged?(from: Status, to: Status): void;
  refresh(): void;
  sessionEntry?: SessionEntry;
  onSessionEntryConsumed?(requestId: string): void;
  active?: boolean;
  sessionDefaults?: { provider: string; model: string; mode: string } | null;
  /** Changes when the card's action menu asks to start a session. */
  startRequest?: string;
  /** With startRequest: prefill Start session from this idea (the Ideas page's "Do it in a new session"). */
  startIdea?: Idea;
  /** Opens the project Ideas page showing only this card (IDEAS-INBOX-SPEC §5). */
  onAllIdeas?(taskId: string): void;
  /** Guardrails on (Settings and the project switch): the Workpad shows what this card was sent back for (GUARDRAILS-SPEC §7.1). */
  guardrails?: boolean;
  /** Adds a tag to the board filter (CARD-TAGS-SPEC §6.3). */
  onFilterTag?(tag: string): void;
  /** Changes on each board Esc shortcut: leave the session preview, else close. */
  escapeRequest?: string;
  /** The card's Attention state when it has any (ATTENTION-DISMISS-SPEC §3.3). */
  attention?: "active" | "dismissed";
  /** Dismisses the card from Attention, or restores it when dismissed. */
  onAttention?(): void;
  /** The stored section order, comma-joined so the memo compares it by value (DRAWER-SPEC, Section order). */
  sectionOrder?: string;
  /** The stored open/closed choices as JSON, compared by value (DRAWER-SPEC, Section order). */
  sectionOpen?: string;
  /** A search hit to land on (DRAWER-SPEC "Focus from search"); each key is handled once. */
  focus?: DrawerFocus;
}) {
  usePerfRender("switch.drawer.commit");
  const switchStart = perfStart();
  const toast = useToast();
  const theme = useTheme();
  const { colors } = theme;
  const paseo = usePaseo(),
    update = useRpc(rpc.updateTask),
    undoRelease = useRpc(rpc.releaseUndo),
    adoptIdea = useRpc(rpc.adoptIdea),
    contextRead = useRpc(rpc.taskContext),
    configure = useRpc(rpc.configureSession);
  const { query: readState, receipts, markRead, markUnread } = useSessionReads();
  const [selected, setSelected] = useState(sessionEntry?.sessionId || ""),
    [highlighted, setHighlighted] = useState(""),
    [showNew, setShowNew] = useState(false),
    // A session started from an idea (IDEAS-SPEC §6.3): prefills the form, recorded on the idea once created.
    [ideaSession, setIdeaSession] = useState<Idea | null>(null),
    [showWrapup, setShowWrapup] = useState(false),
    // Workspace switch and release from main (WORKSPACE-SWITCH-SPEC §3.1, §5).
    [switching, setSwitching] = useState<SwitchDirection | null>(null),
    [showRelease, setShowRelease] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    // Subagent rows the user opened or closed, by main session; otherwise they follow `urgent`.
    [subagentsOpen, setSubagentsOpen] = useState<Record<string, boolean>>({}),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>(
      {},
    );
  // The retained compact root is paused; visible card props still need remote edits/deletions.
  const pollBoard = drawerNeedsBoard(compact, active, selected);
  // Only keep the shared poll alive. The root/data readers deliver changed props;
  // fetching flags must not re-render this entire retained detail tree.
  const detailState = useTaskDetail();
  useCardDetailQuery(hostId, task.id, task.workspaceId, pollBoard, pollBoard ? 3000 : undefined, true);
  const lock = useRef(false);
  const order = useMemo(() => drawerSectionOrder(sectionOrder ? sectionOrder.split(",") : []), [sectionOrder]);
  // Which sections are open: the user's defaults each time the sidebar opens, then their own toggles.
  // Activity and Usage are history, not status: closed by default (USAGE-STATS-SPEC §5).
  const openDefaults = useMemo(() => drawerSectionsOpen(sectionOpen ? (JSON.parse(sectionOpen) as Record<string, boolean>) : {}), [sectionOpen]);
  const [opened, setOpened] = useState(openDefaults);
  useEffect(() => {
    if (active) setOpened(openDefaults);
  }, [active, openDefaults]);
  const sectionStates = useSectionStates(opened, setOpened);
  // Focus from search: open the section for this opening only (never the stored choice), let it render the
  // target, scroll there and ring it; without a rendered target in time, the section itself is the target.
  const reduced = useReducedMotion();
  const scroller = useRef<{ scrollTo(to: { y: number; animated?: boolean }): void } | null>(null);
  const content = useRef<View>(null);
  const [focusTarget, setFocusTarget] = useState<{ key: string; target: string } | null>(null);
  // An older event a hit pointed at stays listed until the sidebar closes, after its ring is gone.
  const [keptEvent, setKeptEvent] = useState("");
  useEffect(() => {
    if (!active) setKeptEvent("");
  }, [active]);
  const handledFocus = useRef("");
  const foundFocus = useRef("");
  const focusTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => focusTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!active || !focus || handledFocus.current === focus.key) return;
    handledFocus.current = focus.key;
    foundFocus.current = "";
    focusTimers.current.forEach(clearTimeout);
    setOpened((current) => ({ ...current, [focus.section]: true }));
    setFocusTarget({ key: focus.key, target: focus.target || `section:${focus.section}` });
    setKeptEvent(focus.target?.startsWith("event:") ? focus.target : "");
    focusTimers.current = [
      setTimeout(() => {
        if (foundFocus.current !== focus.key) setFocusTarget({ key: focus.key, target: `section:${focus.section}` });
      }, FOCUS_FALLBACK_MS),
      // Once shown, the request is over: reopening or toggling a section later never applies it again.
      setTimeout(() => setFocusTarget((current) => (current?.key === focus.key ? null : current)), FOCUS_FALLBACK_MS + FOCUS_RING_MS + 600),
    ];
  }, [active, focus]);
  const focusFound = useStableCallback((key: string, node: View) => {
    if (!focusTarget || key !== focusTarget.key || !content.current) return;
    foundFocus.current = key;
    node.measureLayout(
      content.current as never,
      (_x: number, y: number) => scroller.current?.scrollTo({ y: Math.max(0, y - space[3]), animated: !reduced }),
      () => undefined,
    );
  });
  // The highlight follows the focus prop itself: the board clears it when the sidebar closes or another card opens,
  // and a new hit replaces it (DRAWER-SPEC "Focus from search" 6).
  const mark = useMemo(
    () => (focus?.terms?.length ? { target: focus.target || `section:${focus.section}`, terms: focus.terms, field: focus.field } : null),
    [focus],
  );
  const focusState = useMemo(
    () => (focusTarget || mark ? { key: focusTarget?.key ?? "", target: focusTarget?.target ?? "", found: focusFound, mark } : null),
    [focusTarget, focusFound, mark],
  );
  // Heavy sections and their reads start once the open transition is over.
  const settled = useSettled(task.id);
  const ready = active && settled;
  // Tap to first frame, and tap to the heavy sections starting (timing log).
  useEffect(() => perfLap("drawer.open", "drawer.open.mount"), []);
  useEffect(() => {
    if (settled) perfLap("drawer.open", "drawer.open.settled", true);
  }, [settled]);
  // Restore unsent drafts saved on the daemon (once per session, local edits win).
  const composer = useComposer(ready);
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    const sessions = composer.state?.sessions;
    if (!sessions) return;
    const restore: Record<string, string> = {};
    for (const [agentId, entry] of Object.entries(sessions)) {
      if (seeded.current.has(agentId) || entry.taskId !== task.id) continue;
      seeded.current.add(agentId);
      if (entry.draft) restore[agentId] = entry.draft;
    }
    if (Object.keys(restore).length)
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, text] of Object.entries(restore)) if (!next[id]) next[id] = text;
        return next;
      });
  }, [composer.state, task.id]);
  const detailActive = useRef(active && !selected);
  detailActive.current = active && !selected;
  const sessionLocks = useRef(new Set<string>());
  const consumedEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || !sessionEntry) return;
    const key = JSON.stringify([
      task.id,
      sessionEntry.sessionId,
      sessionEntry.requestId,
    ]);
    if (consumedEntry.current === key) return;
    consumedEntry.current = key;
    setSelected(sessionEntry.sessionId);
    setShowNew(false);
    setError("");
    onSessionEntryConsumed?.(sessionEntry.requestId);
  }, [
    sessionEntry?.requestId,
    sessionEntry?.sessionId,
    task.id,
    onSessionEntryConsumed,
    active,
  ]);
  const consumedStart = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || !startRequest || consumedStart.current === startRequest) return;
    consumedStart.current = startRequest;
    setSelected("");
    setIdeaSession(startIdea || null);
    setShowNew(true);
  }, [active, startRequest, startIdea]);
  const consumedEscape = useRef(escapeRequest);
  useEffect(() => {
    if (!active || !escapeRequest || consumedEscape.current === escapeRequest) return;
    consumedEscape.current = escapeRequest;
    if (selected) setSelected("");
    else onClose();
  }, [active, escapeRequest]);
  const workspace = useQuery({
    queryKey: ["flowly", "workspace", task.workspaceId],
    queryFn: () => paseo.workspaces.ref(task.workspaceId).refresh(),
    enabled: ready,
    // Availability rarely changes; sends re-check it fresh anyway.
    refetchInterval: 10000,
  });
  const scope = useQuery({
    queryKey: ["flowly", "context", task.id, task.revision, project.revision],
    queryFn: () => contextRead({ id: task.id }),
    enabled: ready,
    refetchInterval: 10000,
    // A revision bump (e.g. an automatic status move) must not blank the
    // context and briefly mark the workspace unavailable.
    placeholderData: (previous) => previous,
  });
  // Live sessions come from the board's streamed agent list, so the cards show
  // at once; archived ones (a full host scan) are read slowly (PERFORMANCE-SPEC §3).
  const workspaceId = task.workspaceId;
  const liveAgents = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => agents.filter((a) => a.workspaceId === workspaceId), [workspaceId]),
  });
  // Archived ones come from the daemon (it pages every agent on the host).
  const archivedRead = useRpc(rpc.archivedSessions);
  const workspaceSessions = useQuery({
    queryKey: ["flowly", "sessions", "archived", task.id],
    queryFn: async () => (await archivedRead({ taskId: task.id })) as unknown as PaseoAgent[],
    enabled: ready,
    refetchInterval: 30000,
  });
  const liveHere = liveAgents.data;
  const sessionsData = useMemo(() => {
    if (!liveHere && !workspaceSessions.data) return undefined;
    const live = liveHere ?? (workspaceSessions.data || []).filter((a) => !a.archivedAt);
    const ids = new Set(live.map((a) => a.id));
    return [...live, ...(workspaceSessions.data || []).filter((a) => a.archivedAt && !ids.has(a.id))];
  }, [liveHere, workspaceSessions.data]);
  // A session that left the live list was probably archived: show it there now.
  const liveIds = (liveHere || []).map((a) => a.id).sort().join(",");
  const previousLive = useRef(liveIds);
  useEffect(() => {
    const before = previousLive.current.split(",").filter(Boolean);
    previousLive.current = liveIds;
    if (active && before.some((id) => !liveIds.split(",").includes(id))) void workspaceSessions.refetch();
  }, [liveIds]);
  const sessions = {
    data: sessionsData,
    error: liveAgents.error ?? workspaceSessions.error,
    isPending: sessionsData === undefined && (liveAgents.isPending || workspaceSessions.isPending),
    refetch: () => Promise.all([liveAgents.refetch(), workspaceSessions.refetch()]),
  };
  // Worktree or local, from the workspace read above (CARD-DISPLAY-SPEC §8, DRAWER-SPEC Workspace kind).
  const place = cardWorkspace(workspace.data?.workspaceKind);
  const unavailable =
    !workspace.data ||
    workspace.isError ||
    scope.isError ||
    !scope.data?.available;
  const legacy = isLegacyScope(task, project);
  const resourceIssue = workspace.error
    ? message(workspace.error)
    : scope.error
      ? message(scope.error)
      : scope.data?.reason || (!workspace.isPending && !workspace.data ? t("Workspace unavailable.") : "");
  const statusDisabled = !active || sending || !!task.archivedAt || !!project.archivedAt;
  // Stable, so a board refresh (e.g. the card changing lane) does not re-render
  // the memoized session view and its composer (SessionPreview is memoized).
  const beginOperation = useStableCallback((id: string) => {
    if (sessionLocks.current.has(id)) return false;
    sessionLocks.current.add(id);
    setPendingSessions((current) => ({ ...current, [id]: true }));
    return true;
  });
  const endOperation = useStableCallback((id: string) => {
    sessionLocks.current.delete(id);
    setPendingSessions((current) => ({ ...current, [id]: false }));
  });
  const composerFocus = useStableCallback((id: string) => {
    // A late daemon restore must not replace (remount) an input the user is in.
    seeded.current.add(id);
  });
  const draftChange = useStableCallback((id: string, text: string, expected?: string) => {
    seeded.current.add(id);
    setDrafts((current) =>
      expected !== undefined && current[id] !== expected
        ? current
        : { ...current, [id]: text },
    );
    // Persist on the daemon (debounced; immediate when a send clears it).
    composer.saveDraft(task.id, id, text, expected !== undefined);
  });
  const backToTask = useStableCallback(() => setSelected(""));
  // A subagent picked from the session view's chip opens here when it is one of this card's sessions.
  const openCardSession = useStableCallback((sessionId: string) => {
    if (!sessions.data?.some((a) => a.id === sessionId)) return false;
    setSelected(sessionId);
    setError("");
    return true;
  });
  const stableRefreshAll = useStableCallback(() => refreshAll());
  // An action next move (NEXT-MOVES-SPEC §7): same path as picking Done in the status menu.
  const moveToDone = useStableCallback(() => changeStatus("done", true));
  const refreshAll = () => {
    refresh();
    void sessions.refetch();
  };
  const questions = cardQuestions(task, events);
  const ordered = [...(sessions.data || [])].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const liveSessions = ordered.filter((a) => !a.archivedAt);
  // Main sessions with their Paseo subagents nested under them (DRAWER-SPEC, Main and sub sessions).
  const liveTree = sessionTree(liveSessions);
  const runningSessions = liveSessions.filter((a) => a.status === "running" || a.status === "initializing").length;
  const sessionSummary = runningSessions ? t("{n} running", { n: runningSessions }) : undefined;
  // Agent questions and approvals waiting in this card's sessions, answered
  // right in the Needs-you area (SESSION-QUESTION-SPEC §2.1). Keyed by content
  // so a board refresh does not re-render the forms (or reset their drafts).
  const askingKey = JSON.stringify(
    liveSessions
      .filter((a) => a.pendingPermissions?.length)
      .map((a) => [a.id, a.title || "", !!a.providerUnavailable, a.pendingPermissions]),
  );
  const asking = useMemo(
    () =>
      liveSessions
        .map((a) => ({ id: a.id, title: a.title || "", providerUnavailable: !!a.providerUnavailable, requests: pendingRequests(a) }))
        .filter((a) => a.requests.length),
    [askingKey],
  );
  const respondInCard = useStableCallback((agentId: string, request: PendingRequest, reply: PermissionReply) => {
    if (!detailActive.current || lock.current || !beginOperation(agentId)) return;
    void perform(
      async () => {
        try {
          const latest = await workspaceSession(paseo, agentId, task.workspaceId, true);
          if (!pendingRequests(latest).some((r) => r.id === request.id))
            throw new Error(t("This request was already answered or withdrawn."));
          await paseo.agents.ref(agentId).respondToPermission({ requestId: request.id, response: reply });
        } finally {
          endOperation(agentId);
        }
      },
      reply.behavior === "allow" && request.kind === "question" ? t("Answer sent") : t("Response sent"),
    );
  });
  const openSession = useStableCallback((agentId: string) => {
    setSelected(agentId);
    setError("");
  });
  const archivedSessions = ordered.filter((a) => !!a.archivedAt);
  const openMenu = useMenuOpener();
  const finished = task.status === "done" || task.status === "cancelled";
  // Wrapped up while kept on the board: its workspace/sessions are archived on
  // purpose, so neither offer Wrap up again nor warn that they are unavailable.
  const wrapped = finished ? currentWrapup(events, task.id) : null;
  // Switch between the main checkout and a worktree (WORKSPACE-SWITCH-SPEC §3.1, §9).
  const switchTo: SwitchDirection | null =
    !place || finished || task.archivedAt || project.archivedAt ? null : place === "worktree" ? "to_local" : project.links?.length ? null : "to_worktree";
  const releasePending = task.switch?.release === "pending" && !task.archivedAt;
  const prUrl = prReviewCardUrl(task);
  const taskActions = (): MenuEntry[] => [
    {
      id: "start",
      label: t("Start session"),
      icon: "Play",
      disabled: unavailable || !!task.archivedAt,
      onPress: () => setShowNew(true),
    },
    ...(attention && onAttention
      ? [
          attention === "dismissed"
            ? { id: "attention-restore", label: t("Restore to Attention"), icon: "Bell", onPress: onAttention }
            : { id: "attention-dismiss", label: t("Dismiss from Attention"), icon: "BellOff", onPress: onAttention },
        ]
      : []),
    ...(finished && !wrapped && !task.archivedAt && !project.archivedAt
      ? [{ id: "wrap", label: t("Wrap up…"), icon: "PackageCheck", onPress: () => setShowWrapup(true) }]
      : []),
    ...(switchTo
      ? [
          {
            id: "switch",
            label: switchTo === "to_local" ? t("Switch to local…") : t("Switch to worktree…"),
            icon: switchTo === "to_local" ? "Folder" : "GitBranch",
            disabled: sending,
            onPress: () => setSwitching(switchTo),
          },
        ]
      : []),
    ...(releasePending ? [{ id: "release", label: t("Release from main…"), icon: "GitPullRequestArrow", onPress: () => setShowRelease(true) }] : []),
    ...(task.switch?.release === "released" && !task.switch.integratedAt && !task.archivedAt
      ? [
          {
            id: "release-undo",
            label: t("Undo release"),
            icon: "Undo2",
            disabled: sending,
            onPress: () => void perform(() => undoRelease({ id: task.id, revision: task.revision, operationId: `undo-${task.id}-${task.revision}` }), t("Release undone")),
          },
        ]
      : []),
    { kind: "separator" as const, id: "s" },
    {
      id: "archive",
      label: task.archivedAt ? t("Restore card") : t("Archive card"),
      icon: task.archivedAt ? "ArchiveRestore" : "Archive",
      danger: !task.archivedAt,
      disabled: sending,
      onPress: () =>
        void perform(
          () => update({ id: task.id, revision: task.revision, archived: !task.archivedAt }),
          task.archivedAt ? t("Card restored") : t("Card archived"),
        ),
    },
    ...(onDelete
      ? [{ id: "delete", label: t("Delete permanently…"), icon: "Trash2", danger: true, disabled: sending || !!project.archivedAt, onPress: onDelete }]
      : []),
  ];
  const sessionMenu = (a: (typeof ordered)[number]): MenuEntry[] => {
    const running = a.status === "running" || a.status === "initializing";
    return [
      { id: "open", label: a.archivedAt ? t("Open to restore") : t("Open"), icon: "MessageSquare", onPress: () => setSelected(a.id) },
      ...(typeof navigation?.openAgent === "function"
        ? [{ id: "native", label: t("Open in Paseo"), icon: "ArrowUpRight", onPress: () => openNativeSession(navigation, a.id, hostId) }]
        : []),
      ...(!a.archivedAt && active
        ? (() => {
            const attention = sessionAttention(a, task.id, receipts, events);
            const unavailable = readState.isPending || readState.isError;
            return [
              attention.unread
                ? {
                    id: "read",
                    label: t("Mark as read"),
                    icon: "MailCheck",
                    disabled: unavailable,
                    onPress: () =>
                      void perform(
                        () => markRead({ taskId: task.id, agentId: a.id, ...(attention.token ? { token: attention.token } : {}) }),
                        t("Marked as read"),
                      ),
                  }
                : {
                    id: "unread",
                    label: t("Mark as unread"),
                    icon: "Mail",
                    disabled: unavailable,
                    onPress: () => void perform(() => markUnread({ taskId: task.id, agentId: a.id }), t("Marked as unread")),
                  },
            ];
          })()
        : []),
      ...(running
        ? [{
            id: "stop",
            label: t("Stop"),
            icon: "Square",
            onPress: () =>
              void perform(() => configure({ taskId: task.id, agentId: a.id, stop: true }), t("Session stopped")),
          }]
        : []),
      ...(!a.archivedAt
        ? [
            { kind: "separator" as const, id: "s1" },
            {
              id: "archive",
              label: running ? t("Archive (stop it first)") : t("Archive session"),
              icon: "Archive",
              danger: true,
              disabled: running || !active,
              onPress: () =>
                void perform(async () => {
                  await paseo.agents.ref(a.id).archive();
                }, t("Session archived")),
            },
          ]
        : []),
    ];
  };
  const renderSession = (a: (typeof ordered)[number], index: number, nested = false) => (
    <SessionCard
      key={a.id}
      agent={a}
      events={events}
      first={index === 0}
      nested={nested}
      highlighted={highlighted === a.id}
      attention={sessionAttention(a, task.id, receipts, events)}
      readStateUnavailable={readState.isPending || readState.isError}
      onPress={() => {
        setSelected(a.id);
        setError("");
      }}
      menu={menuHandlers(openMenu, a.title || t("Session"), () => sessionMenu(a))}
    />
  );
  // A main session, then its subagents behind one row: folded unless one needs you or is selected.
  const renderNode = (node: SessionNode<(typeof ordered)[number]>, index: number) => {
    const kids = node.children;
    const urgent = kids.some((c) => { const b = subagentBucket(c); return b === "needs_input" || b === "failed"; }) || kids.some((c) => c.id === highlighted);
    const open = subagentsOpen[node.agent.id] ?? urgent;
    return (
      <Fragment key={node.agent.id}>
        {renderSession(node.agent, index)}
        {kids.length > 0 && (
          <SubagentToggle
            id={node.agent.id}
            summary={subagentSummary(kids)}
            // Folded only: once open, the running subagent rows sweep themselves.
            running={!open && kids.some((c) => !c.archivedAt && subagentBucket(c) === "running")}
            open={open}
            onPress={() => setSubagentsOpen((current) => ({ ...current, [node.agent.id]: !open }))}
          />
        )}
        {kids.length > 0 && (
          // Same measured-height reveal as the sections (DRAWER-SPEC, Motion).
          <Collapse open={open} id={node.agent.id}>
            {kids.map((child) => renderSession(child, 1, true))}
          </Collapse>
        )}
      </Fragment>
    );
  };
  // Routine turn start/end records drive rules and markers, and next-move
  // suggestions live above the session composer; the timeline shows what
  // changed or needs a person (failed turns, permission requests stay). An
  // agent's explicit "no next moves" is a choice worth seeing (NEXT-MOVES-SPEC §8.5).
  const meaningful = events.filter(
    (e) =>
      e.action !== "agent.turn_started" &&
      (e.action !== nextMovesAction || isNoMoves(e)) &&
      // The Workpad section shows the workpad itself (WORKPAD-SPEC §2.3).
      e.action !== workpadUpdatedAction &&
      e.action !== workpadCheckedAction &&
      !(e.action === "agent.turn_ended" && e.outcome !== "failed"),
  );
  // `fromSession`: started from the session view (an action next move), where the
  // detail guard is false and an error shows as a toast, not in the detail area.
  async function perform(action: () => Promise<unknown>, success = "", fromSession = false) {
    if ((!fromSession && !detailActive.current) || lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
      if (success) toast.show(success, { variant: "success" });
      refreshAll();
    } catch (e) {
      if (fromSession) toast.show(message(e), { variant: "error" });
      else setError(message(e));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  function changeStatus(status: Status, fromSession = false) {
    if (statusDisabled || (!fromSession && !detailActive.current) || status === task.status) return;
    const from = task.status;
    void perform(
      async () => {
        await update({ id: task.id, revision: task.revision, status });
        onStatusChanged?.(from, status);
      },
      t("Moved to {lane}", { lane: laneName(project, status) }),
      fromSession,
    );
  }
  // Status, type and priority open a dropdown next to their button (a sheet on phones).
  const statusEntries = (): MenuEntry[] =>
    enabledStatuses(project).map((status) => ({
      id: status,
      label: laneName(project, status),
      leading: <StatusIcon status={status} />,
      checked: status === task.status,
      onPress: () => changeStatus(status),
    }));
  const editField = (edit: { type: Task["type"] | null } | { priority: Task["priority"] }, success: string) => {
    if (!active || sending || !detailActive.current) return;
    void perform(() => update({ id: task.id, revision: task.revision, ...edit }), success);
  };
  const typeEntries = (): MenuEntry[] => [
    {
      id: "none",
      label: t("No type"),
      leading: <TypeIcon always />,
      checked: !task.type,
      onPress: () => task.type && editField({ type: null }, t("Type cleared")),
    },
    ...taskTypes.map((type) => ({
      id: type,
      label: taskTypeLabels[type],
      leading: <TypeIcon type={type} />,
      checked: type === task.type,
      onPress: () => type !== task.type && editField({ type }, t("Type set to {type}", { type: taskTypeLabels[type] })),
    })),
  ];
  const priorityEntries = (): MenuEntry[] =>
    [...priorities].reverse().map((priority) => ({
      id: priority,
      label: priorityLabels[priority],
      leading: <PriorityIcon priority={priority} always />,
      checked: priority === task.priority,
      onPress: () => priority !== task.priority && editField({ priority }, t("Priority set to {priority}", { priority: priorityLabels[priority] })),
    }));
  // Title, properties and tags: fixed on desktop; on phones they scroll away with the content, so the sections get the screen.
  const heading = (
    <>
      <Label bold size={font.xl} lines={3}>{task.title}</Label>
      <View testID="task-actions" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[2] }}>
        {place && (
          // Read-only, so no chip border: the properties beside it are pickers.
          <View
            accessibilityLabel={workspaceLabel(place)}
            style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], height: touch ? 40 : 28, paddingRight: space[1] }}
          >
            <WorkspaceIcon workspace={place} />
            <Label muted size={font.md} selectable={false}>
              {workspaceLabels[place]}
            </Label>
          </View>
        )}
        <Property
          icon={<StatusIcon status={task.status} />}
          text={laneName(project, task.status)}
          label={t("Status: {lane}", { lane: laneName(project, task.status) })}
          disabled={statusDisabled || !openMenu}
          onPress={(at) => openMenu?.(at, t("Status"), statusEntries())}
        />
        <Property
          icon={<PriorityIcon priority={task.priority} always />}
          text={priorityLabels[task.priority]}
          label={t("Priority: {priority}", { priority: priorityLabels[task.priority] })}
          disabled={!active || sending || !openMenu}
          onPress={(at) => openMenu?.(at, t("Priority"), priorityEntries())}
        />
        <Property
          icon={<TypeIcon type={task.type} always />}
          text={task.type ? taskTypeLabels[task.type] : t("No type")}
          label={t("Type: {type}", { type: task.type ? taskTypeLabels[task.type] : t("none") })}
          disabled={!active || sending || !openMenu}
          onPress={(at) => openMenu?.(at, t("Type"), typeEntries())}
        />
      </View>
      <TaskTags task={task} active={active} readOnly={!!project.archivedAt} onFilterTag={onFilterTag} />
      {!!error && <Notice>{error}</Notice>}
    </>
  );
  // The movable sections, in the user's order (DRAWER-SPEC, Section order).
  const section = (id: DrawerSection): ReactNode => {
    switch (id) {
      case "progress":
        return (
          <TaskProgress taskId={task.id} active={active} section={sectionStates.progress} chatsKey={liveIds} />
        );
      case "workpad":
        return (
          <TaskWorkpad task={task} project={project} guardrails={guardrails} active={active} disabled={!active || !!task.archivedAt || !!project.archivedAt} section={sectionStates.workpad} />
        );
      case "artifacts":
        return (
          <TaskArtifacts task={task} active={active} disabled={!active || !!task.archivedAt || !!project.archivedAt} section={sectionStates.artifacts} />
        );
      case "sessions":
        return (
          <Section
            id={task.id}
            title={t("Sessions")}
            count={liveTree.length}
            open={sectionStates.sessions.open}
            onToggle={sectionStates.sessions.onToggle}
            summary={sessionSummary}
            actions={
              <Button quiet icon="Plus" disabled={!active || unavailable} onPress={() => setShowNew(true)}>
                {t("Start session")}
              </Button>
            }
          >
            {sessions.error && (
              <View style={{ gap: space[2] }}>
                <Notice>
                  {message(sessions.error)}
                  {sessions.data?.length ? ` ${t("Showing the last known session state.")}` : ""}
                </Notice>
                <View style={{ flexDirection: "row" }}>
                  <Button quiet icon="RefreshCw" onPress={() => void sessions.refetch()}>
                    {t("Retry sessions")}</Button>
                </View>
              </View>
            )}
            {readState.error && (
              <Notice tone="warning">
                {t("Read state unavailable: {error}", { error: message(readState.error) })}
              </Notice>
            )}
            {sessions.isPending ? (
              <Label muted>{t("Loading sessions…")}</Label>
            ) : !liveSessions.length && !sessions.error ? (
              <View
                style={{
                  paddingVertical: space[5],
                  paddingHorizontal: space[4],
                  alignItems: "center",
                  gap: space[1],
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: colors.border,
                }}
              >
                <Label muted size={font.md}>{t("No sessions yet")}</Label>
                <View style={{ paddingTop: space[2] }}>
                  <Button primary icon="Play" disabled={!active || unavailable} onPress={() => setShowNew(true)}>
                    {t("Start session")}</Button>
                </View>
              </View>
            ) : (
              <SessionGroup list={liveTree} render={renderNode} />
            )}
            {archivedSessions.length > 0 && (
              <Disclosure
                title={t("Archived · {n}", { n: archivedSessions.length })}
                open={showArchived}
                onChange={setShowArchived}
              >
                <Label muted size={font.sm}>
                  {t("Open one and send a message to restore it.")}</Label>
                <SessionGroup list={sessionTree(archivedSessions)} render={renderNode} />
              </Disclosure>
            )}
          </Section>
        );
      case "ideas":
        return (
          <>
          {onCreateFromIdea && onOpenTask && (
            <TaskIdeas
              taskId={task.id}
              sessions={ordered}
              // Ideas outlive the card: only an archived project makes them read-only (IDEAS-INBOX-SPEC §2.2).
              disabled={!active || !!project.archivedAt}
              onCreate={onCreateFromIdea}
              onDiscuss={onDiscussIdea}
              quick={quickTask}
              onAllIdeas={onAllIdeas && (() => onAllIdeas(task.id))}
              onNewSession={(idea) => {
                setIdeaSession(idea);
                setShowNew(true);
              }}
              onOpenTask={onOpenTask}
              section={sectionStates.ideas}
            />
          )}
          </>
        );
      case "links":
        return (
          onOpenTask && onLink && onFollowUp && (
            <TaskLinks
              task={task}
              project={project}
              disabled={!active || !!task.archivedAt || !!project.archivedAt}
              onOpenTask={onOpenTask}
              onLink={onLink}
              onFollowUp={onFollowUp}
              section={sectionStates.links}
            />
          )
        );
    }
  };
  perfEnd("switch.drawer.own", switchStart);
  return (
    <View
      style={{
        width: compact ? "100%" : width,
        flex: compact ? 1 : undefined,
        minHeight: 0,
        flexShrink: 0,
        maxWidth: "100%",
        backgroundColor: colors.surface0,
      }}
    >
      <MotionReveal
        testID="task-session-motion"
        transitionKey={`${task.id}|${selected || "details"}`}
        direction={selected ? 1 : -1}
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      >
      {selected ? (
        <SessionPreview
          key={selected}
          task={task}
          sessionId={selected}
          compact={compact}
          visible={active}
          hostId={hostId}
          events={events}
          unavailable={!active || unavailable}
          unavailableReason={
            workspace.error
              ? message(workspace.error)
              : scope.error
                ? message(scope.error)
                : scope.data?.reason ||
                  t("Checking task and workspace availability…")
          }
          navigation={navigation}
          draft={drafts[selected] || ""}
          pending={!!pendingSessions[selected]}
          beginOperation={beginOperation}
          endOperation={endOperation}
          onComposerFocus={composerFocus}
          onDraftChange={draftChange}
          onBack={backToTask}
          onOpenSession={openCardSession}
          onClose={onClose}
          refresh={stableRefreshAll}
          cardFinished={task.status === "done" || task.status === "cancelled" || !!task.archivedAt || !!project.archivedAt}
          onMoveToDone={moveToDone}
        />
      ) : (
        <>
          <View style={{ paddingHorizontal: space[4], paddingTop: space[2], paddingBottom: space[3], gap: space[2] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], marginLeft: compact ? -space[2] : 0 }}>
              {compact && (
                <IconButton icon="ArrowLeft" label={t("Back to board")} onPress={onClose} />
              )}
              <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                <Icon name="Folder" size={13} color={colors.foregroundMuted} />
                <View style={{ flexShrink: 1, minWidth: 0 }}>
                  <Label muted size={font.sm} lines={1} selectable={false}>
                    {project.title}
                  </Label>
                </View>
                {!!task.archivedAt && <Badge>{t("Archived")}</Badge>}
                {legacy && <Badge>{t("Legacy")}</Badge>}
              </View>
              {typeof navigation?.openWorkspace === "function" && (
                // DRAWER-SPEC, Open workspace: disabled, not hidden, while the workspace is checked or unavailable.
                <IconButton
                  icon="ArrowUpRight"
                  label={t("Open workspace")}
                  disabled={!active || unavailable}
                  onPress={() => openNativeWorkspace(navigation, task.workspaceId, hostId)}
                />
              )}
              {!!prUrl && (
                <IconButton
                  icon="GitPullRequest"
                  label={t("Open PR")}
                  onPress={() => void Linking.openURL(prUrl).catch(() => toast.show(t("Could not open the link."), { variant: "error" }))}
                />
              )}
              <IconButton icon="Pencil" label={t("Edit task")} disabled={!active || sending} onPress={onEdit} />
              <IconButton
                icon="Ellipsis"
                label={t("More task actions")}
                disabled={!active}
                onPress={(event) => openMenu?.(eventPoint(event), task.title, taskActions())}
              />
              {!compact && <IconButton icon="X" label={t("Close side bar")} onPress={onClose} />}
            </View>
            {!compact && heading}
          </View>
          <Divider />
          <DrawerFocusProvider value={focusState}>
          <ScrollView
            ref={scroller as never}
            {...verticalScroll}
            // Avoid recording offscreen section views on compact surfaces.
            removeClippedSubviews={compact}
            style={{ flex: 1, minHeight: 0 }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ ...verticalContent, padding: space[4], paddingBottom: space[6] + space[2] }}
          >
            {/* One measured node for search focus (DRAWER-SPEC "Focus from search"). */}
            <View ref={content} collapsable={false} style={{ gap: space[5] }}>
            {compact && <View style={{ gap: space[2] }}>{heading}</View>}
            {!!resourceIssue && !wrapped && (
              <View style={{ gap: space[2] }}>
                <Notice tone="warning">{resourceIssue}</Notice>
                <View style={{ flexDirection: "row" }}>
                  <Button quiet icon="RefreshCw" disabled={!active} onPress={() => {
                    refreshAll();
                    void workspace.refetch();
                    void scope.refetch();
                  }}>{t("Refresh details")}</Button>
                </View>
              </View>
            )}
            {attention === "dismissed" && onAttention && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                <Icon name="BellOff" size={14} color={colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label muted size={font.sm}>
                    {t("Dismissed from Attention. It comes back when something new happens.")}
                  </Label>
                </View>
                <Button small quiet icon="Bell" disabled={!active} onPress={onAttention}>
                  {t("Restore")}
                </Button>
              </View>
            )}
            {questions.map((q) => (
              <Enter key={q.id}>
              <View
                accessibilityLabel={t("Question from {agent}: {note}", { agent: sessions.data?.find((a) => a.id === q.agentId)?.title || t("agent"), note: q.note || "" })}
                style={{
                  gap: space[2],
                  padding: space[3],
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderColor: tint(colors.statusWarning, 0.4),
                  backgroundColor: tint(colors.statusWarning, 0.07),
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <Icon name="MessageCircleQuestion" size={15} color={colors.statusWarning} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label medium size={font.sm} lines={1} selectable={false}>
                      {t("{agent} needs you", { agent: sessions.data?.find((a) => a.id === q.agentId)?.title || t("Agent") })}
                    </Label>
                  </View>
                  <Label muted size={font.xs} selectable={false}>{relativeTime(q.at)}</Label>
                </View>
                <Label size={font.base} selectable>{q.note || t("The agent asked a question.")}</Label>
                <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                  <Button
                    primary
                    icon="Reply"
                    disabled={!active || !q.agentId}
                    onPress={() => {
                      if (q.agentId) setSelected(q.agentId);
                      setError("");
                    }}
                  >
                    {t("Reply")}</Button>
                </View>
              </View>
              </Enter>
            ))}
            {asking.map((a) => (
              <CardRequests
                key={a.id}
                agentId={a.id}
                title={a.title}
                requests={a.requests}
                compact={compact}
                disabled={!active || sending || !!pendingSessions[a.id] || a.providerUnavailable || !!task.archivedAt}
                onRespond={respondInCard}
                onOpen={openSession}
              />
            ))}
            {releasePending && <ReleaseNotice disabled={!active} onRelease={() => setShowRelease(true)} />}
            {(task.status === "done" || task.status === "cancelled") && !task.archivedAt && !project.archivedAt && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[3],
                  padding: space[3],
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon
                  name={wrapped ? "CircleCheck" : "PackageCheck"}
                  size={16}
                  color={wrapped ? colors.statusSuccess : colors.foregroundMuted}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label medium size={font.md}>
                    {wrapped ? t("Wrapped up") : task.status === "done" ? t("Finished") : t("Cancelled")}
                  </Label>
                  <Label muted size={font.sm}>
                    {wrapped
                      ? t(
                          /(^|; )workspace kept(;|$)/.test(wrapped.note || "")
                            ? task.status === "done"
                              ? "Sessions archived {time}. Move the card out of Done to bring them back."
                              : "Sessions archived {time}. Move the card out of Cancelled to bring them back."
                            : task.status === "done"
                              ? "Workspace and sessions archived {time}. Move the card out of Done to bring them back."
                              : "Workspace and sessions archived {time}. Move the card out of Cancelled to bring them back.",
                          { time: relativeTime(wrapped.at) },
                        )
                      : t("Wrap up to archive its sessions, worktree and the card.")}
                  </Label>
                </View>
                {!wrapped && (
                  <Button icon="Archive" disabled={!active || sending} onPress={() => setShowWrapup(true)}>
                    {t("Wrap up")}</Button>
                )}
              </View>
            )}
            {onOpenTask && <LinkOrigin taskId={task.id} onOpenTask={onOpenTask} />}
            {!!task.description && (
              <SessionMarkdown text={task.description} />
            )}
            {!!detailState.error && <Notice>{message(detailState.error)}</Notice>}
            {!detailState.detail ? <Button quiet onPress={detailState.retry}>{detailState.error ? t("Retry") : t("Loading cards…")}</Button> : order.map((id) => <Fragment key={id}>{section(id)}</Fragment>)}
            {settled && (
            // Below the sessions, so mounting them after the transition moves nothing above.
            <Enter distance={4} style={{ gap: space[5] }}>
            <TaskMetadata
              task={task}
              project={project}
              open={sectionStates.details.open}
              onToggle={sectionStates.details.onToggle}
              summary={workspace.isPending || scope.isPending ? t("Checking…") : unavailable ? t("Unavailable") : legacy ? t("Legacy") : workspace.data?.name}
              legacy={legacy}
              workspaceName={workspace.data?.name}
              workspaceDirectory={workspace.data?.workspaceDirectory}
              workspaceStatus={workspace.isPending ? t("Checking…") : workspace.data?.status || t("Unavailable")}
              owner={scope.data?.owner}
              directories={scope.data?.directories || []}
              place={place}
              onSwitch={switchTo ? () => setSwitching(switchTo) : undefined}
            />
            <TaskUsage taskId={task.id} active={ready} section={sectionStates.usage} />
            {meaningful.length > 0 && (
              <Section
                id={task.id}
                focusId="activity"
                title={t("Activity")}
                count={meaningful.length}
                open={sectionStates.activity.open}
                onToggle={sectionStates.activity.onToggle}
              >
                <View>
                  {/* The last 12, widened back to an older event a search hit points at. */}
                  {meaningful
                    .slice(activityStart(meaningful.map((e) => e.id), keptEvent))
                    .reverse()
                    .map((e, index, list) => (
                      <FocusTarget key={e.id} id={`event:${e.id}`}>
                      <ActivityItem
                        event={e}
                        nameOf={(status) => laneName(project, status)}
                        last={index === list.length - 1}
                        actor={
                          e.agentId
                            ? sessions.data?.find((a) => a.id === e.agentId)?.title || t("Agent")
                            : e.actor === "human"
                              ? t("You")
                              : e.actor === "system"
                                ? t("Kanban")
                                : t("Agent")
                        }
                      />
                      </FocusTarget>
                    ))}
                </View>
              </Section>
            )}
            </Enter>
            )}
            </View>
          </ScrollView>
          </DrawerFocusProvider>
        </>
      )}
      </MotionReveal>
      <SessionCreate
        task={task}
        open={active && showNew}
        workspaceDirectory={workspace.data?.workspaceDirectory}
        unavailable={!active || unavailable}
        onClose={() => {
          setShowNew(false);
          setIdeaSession(null);
        }}
        onCreated={(id, text) => {
          setHighlighted(id);
          toast.show(text, { variant: "success" });
          setSelected("");
          if (ideaSession)
            void adoptIdea({ id: ideaSession.id, agentId: id, send: false })
              .then(() => refresh())
              .catch((e) => toast.show(t("Session started, but the idea was not marked: {message}", { message: message(e) }), { variant: "error" }));
        }}
        refresh={refreshAll}
        defaults={sessionDefaults}
        seed={ideaSession ? { title: ideaSession.title, prompt: ideaInstruction(ideaSession) } : null}
      />
      <WrapupModal
        task={task}
        open={active && showWrapup}
        onClose={() => setShowWrapup(false)}
        onDone={(summary) => {
          setShowWrapup(false);
          toast.show(summary, { variant: "success" });
          refreshAll();
        }}
      />
      <SwitchModal
        task={task}
        direction={switching || "to_worktree"}
        open={active && !!switching}
        onClose={() => setSwitching(null)}
        onDone={(result) => {
          setSwitching(null);
          toast.show(result.text, { variant: "success" });
          for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
          refreshAll();
        }}
      />
      <ReleaseModal
        task={task}
        open={active && showRelease}
        onClose={() => setShowRelease(false)}
        onDone={(text) => {
          setShowRelease(false);
          toast.show(text, { variant: "success" });
          refreshAll();
        }}
      />
    </View>
  );
}

/**
 * Re-render only for its own data: the board passes stable callbacks and
 * re-renders often (live agents, polls); its session defaults are a fresh
 * object each time (PERFORMANCE-SPEC §3).
 */
/** One session's pending questions/approvals in the drawer's Needs-you area. */
const CardRequests = memo(function CardRequests({
  agentId,
  title,
  requests,
  compact,
  disabled,
  onRespond,
  onOpen,
}: {
  agentId: string;
  title: string;
  requests: readonly PendingRequest[];
  compact: boolean;
  disabled: boolean;
  onRespond(agentId: string, request: PendingRequest, reply: PermissionReply): void;
  onOpen(agentId: string): void;
}) {
  const { colors } = useTheme();
  const respond = useCallback(
    (request: PendingRequest, reply: PermissionReply) => onRespond(agentId, request, reply),
    [agentId, onRespond],
  );
  const name = title || t("Agent");
  return (
    <View style={{ gap: space[2] }} testID="drawer-pending-requests">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Icon name="MessageCircleQuestion" size={15} color={colors.statusWarning} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label medium size={font.sm} lines={1} selectable={false}>
            {t("{agent} needs you", { agent: name })}
          </Label>
        </View>
        <Button quiet icon="MessageSquare" onPress={() => onOpen(agentId)}>{t("Open")}</Button>
      </View>
      <PendingRequests requests={requests} disabled={disabled} onRespond={respond} />
    </View>
  );
});

/** The row under a main session that shows or hides its subagents, lined up with the subagent rows. */
function SubagentToggle({ id, summary, running, open, onPress }: { id: string; summary: string; running: boolean; open: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Subagents: {summary}", { summary })}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={(state) => ({ ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1.5],
        minHeight: touch ? 40 : 32,
        paddingLeft: space[3] + 22,
        paddingRight: space[3],
        borderTopWidth: 1,
        borderColor: colors.border,
        // Focus shows as the row's background, not a browser outline the bordered list would clip into a line.
        backgroundColor: state.pressed || (state as typeof state & { hovered?: boolean; focused?: boolean }).hovered ? colors.surface1 : colors.surface0,
      })}
    >
      {/* Folded with a subagent running: the row carries the running sessions' dot sweep, on its own beat (MOTION-SPEC, running state). */}
      {running && <RunningDots color={colors.accent} seed={`${id}/subagents`} />}
      <Icon name="CornerDownRight" size={13} color={colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label muted size={font.sm} lines={1} selectable={false}>{summary}</Label>
      </View>
      <Chevron open={open} title={id} color={colors.foregroundMuted} size={14} />
    </Pressable>
  );
}

function sameDrawerProps(a: TaskDrawerProps, b: TaskDrawerProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TaskDrawerProps>;
  for (const key of keys)
    if (!Object.is(a[key], b[key]) && !(key === "sessionDefaults" && shallowEqual(a[key], b[key]))) return false;
  return true;
}

function Property({
  icon,
  text,
  label,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  text: string;
  label: string;
  disabled?: boolean;
  /** Receives the point just below the button's left edge, where its dropdown opens. */
  onPress(at: Point): void;
}) {
  const { colors } = useTheme();
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={(event) => {
        const fallback = eventPoint(event);
        const node = ref.current;
        if (!node) return onPress(fallback);
        node.measureInWindow((x, y, _width, height) =>
          onPress(Number.isFinite(x) && height ? { x, y: y + height + 4 } : fallback),
        );
      }}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 40 : 28,
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : colors.surface0,
          opacity: disabled ? 0.5 : 1,
        };
      }}
    >
      {icon}
      <Label medium size={font.md} selectable={false}>
        {text}
      </Label>
    </Pressable>
  );
}

const activityText: Record<string, string> = localizedLabels({
  created: msg("Created the task"),
  edited: msg("Edited the task"),
  status_changed: msg("Changed status"),
  archive_changed: msg("Changed archive state"),
  type_set: msg("Set the task type"),
  workspace_auto_archived: msg("Archived the workspace"),
  workspace_auto_archive_skipped: msg("Kept the workspace"),
  workspace_restored: msg("Restored the workspace"),
  workspace_restore_skipped: msg("Workspace not restored"),
  sessions_restored: msg("Restored the sessions"),
  workspace_switched: msg("Switched the workspace"),
  handover_written: msg("Wrote the handover"),
  changes_released: msg("Released changes from main"),
  release_undone: msg("Undid the release"),
  branch_integrated: msg("Integrated the branch"),
  progress_reported: msg("Reported progress"),
  idea_edited: msg("Edited the idea"),
  idea_removed: msg("Removed the idea"),
  card_created: msg("Created a card"),
  review_started: msg("Started the auto review"),
  review_finished: msg("Finished the auto review"),
  "agent.turn_started": msg("Started a turn"),
  "agent.turn_ended": msg("Finished a turn"),
});

function ActivityItem({
  event,
  actor,
  last,
  nameOf,
}: {
  event: BoardEvent;
  nameOf(status: Status): string;
  actor: string;
  last: boolean;
}) {
  const { colors } = useTheme();
  const mark = useMark(`event:${event.id}`);
  const question = event.reportKind === "question";
  const verb = question
    ? t("Asked")
    : isNoMoves(event)
      ? t("Suggested no next moves")
      : event.action === "agent.turn_ended" && event.outcome === "failed"
        ? t("Turn failed")
        : activityText[event.action] ||
          event.action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <View style={{ flexDirection: "row", gap: space[3] }}>
      <View style={{ width: 14, alignItems: "center" }}>
        <View style={{ height: 6 }} />
        {event.to ? (
          <StatusIcon status={event.to} size={13} />
        ) : (
          <View style={{ width: 7, height: 7, borderRadius: 4, marginVertical: 3, backgroundColor: colors.border }} />
        )}
        {!last && <View style={{ flex: 1, width: 1, marginTop: 4, backgroundColor: colors.border }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : space[3], gap: 2 }}>
        <Label size={font.md}>
          <Label medium size={font.md}>{actor}</Label>
          {` ${getLocale() === "en" ? verb.charAt(0).toLowerCase() + verb.slice(1) : verb}`}
          {event.to ? ` → ${event.to === legacyStatus ? historyStatusLabel(event.to) : nameOf(event.to)}` : ""}
          {event.reportKind && !question && event.reportKind !== "progress" ? ` · ${event.reportKind}` : ""}
        </Label>
        {!!event.rule && (
          <View style={{ flexDirection: "row" }}>
            <Badge>{event.rule === "R1" || event.rule === "R2" ? t("Auto review") : t("Auto")}</Badge>
          </View>
        )}
        {!!event.note && !isNoMoves(event) && (
          <Label muted={!question} size={font.sm} lines={mark ? undefined : question ? 8 : 4}>
            {event.action === "type_set" && (taskTypes as readonly string[]).includes(event.note) ? taskTypeLabels[event.note as Task["type"] & string] : <Marked text={event.note} terms={mark?.terms} />}
          </Label>
        )}
        <Label muted size={font.xs}>
          {relativeTime(event.at)}
        </Label>
      </View>
    </View>
  );
}

function SessionGroup<T>({ list, render }: { list: T[]; render(item: T, index: number): ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: "hidden",
      }}
    >
      {list.map(render)}
    </View>
  );
}
