import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, View, type GestureResponderEvent } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { taskTypeLabels, type Review, type Task } from "../shared/model";
import { AiMark, Badge, Dot, IconButton, Label, font, radius, relativeTime, space, tint, touch, useTheme, noFocusRing } from "./ui";
import { PriorityIcon, TypeIcon, WorkspaceIcon, priorityAccent, priorityLabels, workspaceLabel, workspaceLabels } from "./status";
import { dragThreshold, type Point } from "./geometry";
import type { SessionAttentionSummary } from "../shared/session-attention";
import { PulseDot, motionDuration, useMotionValue, useReducedMotion } from "./motion";
import { RunningDots } from "./running-motion";
import { useCardOutput, type CardOutput, type OutputSession } from "./card-output";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { shallowEqual } from "./stable";
import { t, tn } from "../shared/i18n";
import type { WorkpadSignal } from "../shared/workpad";
import { activityLines, defaultCardDisplay, type CardDisplay, type CardWorkspace } from "../shared/card-display";
import { taskCardLabel, workpadText } from "./card-label";
import { BrandIcon } from "./brand-icons";
import { reviewing, visibleReview } from "../shared/auto-review";
import { Collapse } from "./disclosure";
import { reviewIcon, reviewLabel } from "./task-review";
import { reviewProgress } from "../shared/auto-review";
import type { ConnectorFamily } from "../shared/connectors";

export type CardDrag = {
  start(task: Task, point: Point): void;
  move(point: Point): void;
  end(point: Point): void;
  cancel(): void;
};

type TaskCardProps = Parameters<typeof TaskCard>[0];

export type LiveTaskCardProps = Omit<TaskCardProps, "output" | "menu" | "onOpen" | "onActions" | "onOpenWorkspace"> & {
  outputSession?: OutputSession | null;
  /** Stable handlers shared by all cards; they receive the card's task (PERFORMANCE-SPEC §3). */
  onOpen(task: Task): void;
  onActions(task: Task, at: Point): void;
  /** Absent when the host cannot open workspaces; used only while the card's workspace is available. */
  onOpenWorkspace?(task: Task): void;
  menuFor?(task: Task): MenuEntry[];
};

/** Derived props arrive as fresh objects each board render; compare their content. */
const contentProps = new Set(["summary", "progress", "outputSession", "workpad", "display"]);
function sameLiveCard(a: LiveTaskCardProps, b: LiveTaskCardProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LiveTaskCardProps>;
  for (const key of keys) {
    if (Object.is(a[key], b[key])) continue;
    if (contentProps.has(key) && shallowEqual(a[key], b[key])) continue;
    return false;
  }
  return true;
}

/**
 * TaskCard that loads its latest agent output while mounted. Memoized: a board
 * re-render (live agent updates, polls) only re-renders cards whose own data
 * changed.
 */
export const LiveTaskCard = memo(function LiveTaskCard({
  outputSession,
  onOpen: openTask,
  onActions: taskActions,
  onOpenWorkspace: openTaskWorkspace,
  menuFor,
  ...props
}: LiveTaskCardProps) {
  const { task } = props;
  // Only fetch the output when the activity line can show it (CARD-DISPLAY-SPEC §3).
  const wantsOutput = activityLines(props.display?.activity ?? "auto", !!props.progress?.state, true).output;
  const output = useCardOutput(props.available && wantsOutput ? outputSession : null, task.id);
  const openMenu = useMenuOpener();
  const menu = useMemo(
    () => (menuFor ? menuHandlers(openMenu, task.title, () => menuFor(task)) : undefined),
    [openMenu, menuFor, task],
  );
  const onOpen = useCallback(() => openTask(task), [openTask, task]);
  const onActions = useCallback((event: GestureResponderEvent) => taskActions(task, eventPoint(event)), [taskActions, task]);
  const onOpenWorkspace = useCallback(() => openTaskWorkspace?.(task), [openTaskWorkspace, task]);
  return (
    <TaskCard
      {...props}
      output={output}
      menu={menu}
      onOpen={onOpen}
      onActions={onActions}
      onOpenWorkspace={openTaskWorkspace && props.available ? onOpenWorkspace : undefined}
    />
  );
}, sameLiveCard);

export function TaskCard({
  task,
  selected,
  legacy,
  available,
  workspace = null,
  lane,
  wrapped = false,
  running,
  sessions,
  summary,
  summaryState = "ready",
  output,
  progress,
  questions = 0,
  ideas = 0,
  externalKey = "",
  externalFamily,
  workpad = null,
  waiting = 0,
  waitingTitles = "",
  attentionSnoozed = false,
  projectLabel = "",
  display = defaultCardDisplay,
  flash = false,
  dragging,
  disabled,
  drag,
  onOpen,
  onActions,
  onOpenWorkspace,
  menu,
}: {
  task: Task;
  selected: boolean;
  legacy: boolean;
  available: boolean;
  /** Worktree or local, while the workspace is live (CARD-DISPLAY-SPEC §8). */
  workspace?: CardWorkspace | null;
  /** The lane's display name for the accessible name (UI-UX-SPEC §2, automation names). */
  lane?: string;
  /** Done/Cancelled and wrapped up: its workspace is archived on purpose, not missing. */
  wrapped?: boolean;
  running: number;
  sessions: number;
  summary?: SessionAttentionSummary;
  summaryState?: "ready" | "loading" | "stale" | "unavailable";
  output?: CardOutput | null;
  /** Latest progress summary state (TASK-SUMMARY-SPEC). */
  progress?: { state: string; at: string } | null;
  /** Open agent questions awaiting the user's reply. */
  questions?: number;
  /** Open ideas proposed on this card (IDEAS-SPEC §5.1). */
  ideas?: number;
  /** Ticket, issue or PR inputs, e.g. "SHOPSR-123", "repo!34 +2" (CONNECTORS-SPEC §2); key only, never the status. */
  externalKey?: string;
  /** The first item's service, for its logo (CONNECTORS-SPEC §8.3). */
  externalFamily?: ConnectorFamily;
  /** The workpad's checks or delivery state (WORKPAD-SPEC §6.1). */
  workpad?: WorkpadSignal | null;
  /** Unresolved cards this one is blocked by, and their titles (CARD-LINKS-SPEC §5.1). */
  waiting?: number;
  waitingTitles?: string;
  /** Snoozed in either Attention list; its signals still show (ATTENTION-DISMISS-SPEC, Card and sidebar). */
  attentionSnoozed?: boolean;
  /** The card's project name, shown only on the All projects board (ALL-PROJECTS-SPEC §3). */
  projectLabel?: string;
  /** Which fields show (CARD-DISPLAY-SPEC); the accessibility label always lists everything. */
  display?: CardDisplay;
  /** Briefly emphasize a card whose status just changed (often an automatic move). */
  flash?: boolean;
  dragging?: boolean;
  disabled?: boolean;
  drag?: CardDrag;
  onOpen(): void;
  /** The press opens the card's menu at the press point. */
  onActions(event: GestureResponderEvent): void;
  /** Shows the Open workspace button under the actions button (CARD-DISPLAY-SPEC §7). */
  onOpenWorkspace?(): void;
  /** Context-menu handlers (right-click / long-press) for the card body. */
  menu?: object;
}) {
  const { colors } = useTheme();
  const outputTime = output ? relativeTime(output.at) : "";
  // No fade on mount: the list's own reveal covers navigation, and N mount
  // animations per lane switch competed with it.
  const opacity = useMotionValue(dragging ? 0.45 : 1);
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  // Quick in, slow out: noticeable without holding attention.
  const flashOpacity = useMotionValue(flash ? 1 : 0, flash ? motionDuration.forward : 900);
  // The overlay exists only while it shows (and during its fade-out).
  const [flashShown, setFlashShown] = useState(flash);
  useEffect(() => {
    if (flash) return setFlashShown(true);
    const timer = setTimeout(() => setFlashShown(false), 1000);
    return () => clearTimeout(timer);
  }, [flash]);
  const current = useRef({ task, drag, disabled });
  current.current = { task, drag, disabled };
  const suppressUntil = useRef(0);
  const activeDrag = useRef(false);
  const mousePress = useRef(false);
  useEffect(
    () => () => {
      if (activeDrag.current) current.current.drag?.cancel();
    },
    [],
  );
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        !!current.current.drag &&
        !current.current.disabled &&
        mousePress.current &&
        Math.hypot(g.dx, g.dy) >= dragThreshold,
      onPanResponderGrant: (e) => {
        if (!mousePress.current || current.current.disabled) return;
        activeDrag.current = true;
        suppressUntil.current = Date.now() + 500;
        current.current.drag?.start(current.current.task, {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderMove: (_e, g) => {
        if (activeDrag.current)
          current.current.drag?.move({ x: g.moveX, y: g.moveY });
      },
      onPanResponderRelease: (e) => {
        mousePress.current = false;
        if (!activeDrag.current) return;
        activeDrag.current = false;
        suppressUntil.current = Date.now() + 250;
        current.current.drag?.end({
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        mousePress.current = false;
        if (!activeDrag.current) return;
        activeDrag.current = false;
        current.current.drag?.cancel();
      },
    }),
  );
  const signals = summaryState === "ready" || summaryState === "stale" ? summary : undefined;
  const showActions = !drag || touch || hovered || selected;
  const actionSize = touch ? 40 : 26;
  const accent = display.priority ? priorityAccent(colors, task.priority) : null;
  const lines = activityLines(display.activity, !!progress?.state, !!output);
  // A session is working: the card edge carries a slow marquee (MOTION-SPEC, running state).
  const live = running > 0 || !!(signals?.running || signals?.starting);
  return (
    <Animated.View
      {...(drag && !disabled ? pan.panHandlers : {})}
      onPointerEnter={drag ? () => setHovered(true) : undefined}
      onPointerLeave={drag ? () => setHovered(false) : undefined}
      onPointerDown={
        drag
          ? (e) => {
              mousePress.current =
                e.nativeEvent.pointerType === "mouse" &&
                e.nativeEvent.button === 0;
            }
          : undefined
      }
      onPointerUp={
        drag
          ? () => {
              mousePress.current = false;
            }
          : undefined
      }
      onPointerCancel={
        drag
          ? () => {
              mousePress.current = false;
              if (activeDrag.current) {
                activeDrag.current = false;
                current.current.drag?.cancel();
              }
            }
          : undefined
      }
      style={{
        borderWidth: 1,
        borderColor: selected
          ? colors.accent
          : hovered
            ? tint(colors.foregroundMuted, 0.45)
            : colors.border,
        borderRadius: radius.lg,
        backgroundColor: colors.surface0,
        opacity,
      }}
    >
      {live && <RunningDots radius={radius.lg - 1} color={colors.accent} seed={task.id} />}
      <Pressable
        accessibilityRole="button"
        testID={`card-${task.id}`}
        accessibilityLabel={taskCardLabel({
          title: task.title,
          lane,
          questions,
          ideas,
          waiting,
          waitingTitles,
          progress: progress ?? null,
          workpad: workpad ?? null,
          review: task.review && visibleReview(task) ? reviewLabel(task.review) : "",
          attentionSnoozed,
          priority: task.priority,
          type: task.type,
          workspace: workspace ? workspaceLabel(workspace) : "",
          archivedAt: task.archivedAt,
          legacy,
          summaryState,
          summary,
          output: output ?? null,
          outputTime,
        })}
        {...(menu || {})}
        accessibilityHint={
          drag
            ? t("Drag this card with the mouse or open task actions to change status.")
            : t("Open details and agent sessions.")
        }
        onPress={() => {
          if (Date.now() >= suppressUntil.current) onOpen();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => ({ ...noFocusRing,
          paddingHorizontal: space[3],
          paddingTop: space[2] + 2,
          paddingBottom: space[2] + 2,
          paddingRight: space[3] + 24,
          // The action column (actions, then Open workspace) never hangs below the card.
          minHeight: onOpenWorkspace ? 2 * actionSize + 8 : undefined,
          gap: space[2],
          opacity: pressed ? 0.8 : 1,
          // No browser focus ring; focus is shown with the card's own accent border.
          outlineStyle: "none",
        }) as never}
      >
        <CardMeta task={task} project={projectLabel} externalKey={externalKey} externalFamily={externalFamily} workspace={workspace} display={display} />
        <Label medium size={font.base} lines={3} selectable={false}>
          {task.title}
        </Label>
        {lines.progress && !!progress && <ProgressLine state={progress.state} time={relativeTime(progress.at)} />}
        {lines.output && output && <OutputLine output={output} time={outputTime} />}
        <CardSignals
          task={task}
          legacy={legacy}
          available={available}
          wrapped={wrapped}
          summary={signals}
          summaryState={summaryState}
          running={running}
          sessions={sessions}
          questions={questions}
          ideas={ideas}
          workpad={workpad}
          waiting={waiting}
          attentionSnoozed={attentionSnoozed}
          display={display}
        />
      </Pressable>
      <ReviewStrip taskId={task.id} review={task.review} running={reviewing(task)} />
      {accent && (
        // Urgent/High: a stripe down the left edge, readable from across the board.
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -1,
            bottom: -1,
            left: -1,
            width: 4,
            borderTopLeftRadius: radius.lg,
            borderBottomLeftRadius: radius.lg,
            backgroundColor: accent,
          }}
        />
      )}
      {flashShown && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -1,
            left: -1,
            right: -1,
            bottom: -1,
            borderRadius: radius.lg + 1,
            borderWidth: 1.5,
            borderColor: colors.accent,
            backgroundColor: tint(colors.accent, 0.06),
            opacity: flashOpacity,
          }}
        />
      )}
      <View
        style={{ position: "absolute", top: 4, right: 4, opacity: showActions ? 1 : 0 }}
        onPointerDown={
          drag
            ? (e) => {
                mousePress.current = false;
                e.stopPropagation();
              }
            : undefined
        }
      >
        <IconButton
          icon="Ellipsis"
          size={actionSize}
          label={t("Actions for {title}", { title: task.title })}
          onPress={onActions}
        />
        {onOpenWorkspace && (
          <IconButton
            icon="ArrowUpRight"
            size={actionSize}
            label={t("Open workspace for {title}", { title: task.title })}
            onPress={onOpenWorkspace}
          />
        )}
      </View>
    </Animated.View>
  );
}

function ProgressLine({ state, time }: { state: string; time: string }) {
  return (
    // One line on the board; the drawer's Progress section shows it in full. The AI mark: a model wrote it.
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
      <AiMark size={12} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>
          {state}
        </Label>
      </View>
      {!!time && (
        <View style={{ flexShrink: 0 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {time}
          </Label>
        </View>
      )}
    </View>
  );
}

function OutputLine({ output, time }: { output: CardOutput; time: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minWidth: 0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label muted size={font.sm} lines={1} selectable={false}>
          {output.text}
        </Label>
      </View>
      {!!time && (
        <View style={{ flexShrink: 0 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {time}
          </Label>
        </View>
      )}
    </View>
  );
}

function Signal({ color, icon, text, pulse = false }: { color?: string; icon?: string; text: string; pulse?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {icon ? (
        <Icon name={icon} size={13} color={color || colors.foregroundMuted} />
      ) : (
        <PulseDot color={color || colors.foregroundMuted} size={7} active={pulse} />
      )}
      <Label size={font.sm} muted={!color} selectable={false}>
        {text}
      </Label>
    </View>
  );
}

/**
 * While an automatic review runs, a strip opens under the card with the dot sweep (GUARDRAILS-SPEC §7.1.1): one line,
 * "Reviewing · 3/7 passed · running npm test". `Collapse` expands it when the review starts; when it ends the last
 * frame stays 600 ms (none under Reduce Motion) before it folds. A card mounted mid-review shows it at once.
 */
function ReviewStrip({ taskId, review, running }: { taskId: string; review: Review | undefined; running: boolean }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [held, setHeld] = useState(false);
  const was = useRef(running);
  useEffect(() => {
    const ended = was.current && !running;
    was.current = running;
    if (!ended || reduced) {
      setHeld(false);
      return;
    }
    setHeld(true);
    const timer = setTimeout(() => setHeld(false), 600);
    return () => clearTimeout(timer);
  }, [running, reduced]);
  const open = running || held;
  const progress = review ? reviewProgress(review) : null;
  const passed = progress && progress.total ? t("{passed}/{total} passed", { passed: progress.passed, total: progress.total }) : "";
  const failed = progress?.failed ? tn(progress.failed, "{n} failed", "{n} failed") : "";
  const now =
    progress?.phase === "running" && progress.current
      ? t("running {name}", { name: progress.current })
      : progress?.phase === "judging"
        ? tn(progress.judging ?? 0, "judging {n} check", "judging {n} checks")
        : progress?.phase === "starting"
          ? t("starting…")
          : "";
  const label = [
    t("Auto review running"),
    progress?.total ? t("{passed} of {total} passed", { passed: progress.passed, total: progress.total }) : "",
    failed,
    now,
  ].filter(Boolean).join(", ");
  return (
    <Collapse open={open} id={`${taskId}:review`}>
      <View
        pointerEvents="none"
        accessible
        accessibilityLabel={label}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: space[3],
          paddingVertical: space[1.5],
          borderTopWidth: 1,
          borderTopColor: colors.border,
          borderBottomLeftRadius: radius.lg - 1,
          borderBottomRightRadius: radius.lg - 1,
          backgroundColor: tint(colors.accent, 0.06),
          overflow: "hidden",
        }}
      >
        <RunningDots color={colors.accent} seed={`${taskId}:review`} />
        <Icon name="Loader" size={13} color={colors.accent} />
        <Label size={font.sm} color={colors.accent} selectable={false}>
          {t("Reviewing")}
        </Label>
        {!!passed && <StripPart text={passed} color={colors.accent} />}
        {!!failed && <StripPart text={failed} color={colors.statusDanger} />}
        {!!now && (
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <StripPart text={now} />
          </View>
        )}
      </View>
    </Collapse>
  );
}

/** "· text" after the strip's lead word; muted unless coloured. */
function StripPart({ text, color }: { text: string; color?: string }) {
  return (
    <Label size={font.sm} color={color} muted={!color} lines={1} selectable={false}>
      {`· ${text}`}
    </Label>
  );
}

function CardSignals({
  task,
  legacy,
  available,
  wrapped,
  summary,
  summaryState,
  running,
  sessions,
  questions,
  ideas,
  workpad,
  waiting,
  attentionSnoozed,
  display,
}: {
  task: Task;
  legacy: boolean;
  available: boolean;
  wrapped: boolean;
  summary?: SessionAttentionSummary;
  summaryState: "ready" | "loading" | "stale" | "unavailable";
  running: number;
  sessions: number;
  questions: number;
  ideas: number;
  workpad: WorkpadSignal | null;
  waiting: number;
  attentionSnoozed: boolean;
  display: CardDisplay;
}) {
  const { colors } = useTheme();
  // Asks for the user first, then what is happening (CARD-DISPLAY-SPEC §2).
  const items: ReactNode[] = [];
  if (questions || (available && summary?.questions))
    items.push(<Signal key="question" icon="MessageCircleQuestion" color={colors.statusWarning} text={t("Needs you")} />);
  if (waiting) items.push(<Signal key="waiting" icon="Hourglass" text={t("Waiting on {waiting}", { waiting })} />);
  if (!available && wrapped)
    items.push(<Signal key="wrapped" icon="CircleCheck" text={t("Wrapped up")} />);
  else if (!available)
    items.push(<Signal key="ws" icon="TriangleAlert" color={colors.statusWarning} text={t("Workspace unavailable")} />);
  else if (summaryState === "loading") {
    if (display.sessions) items.push(<Signal key="load" icon="Loader" text={t("Loading…")} />);
  } else if (summaryState === "unavailable") {
    if (display.sessions) items.push(<Signal key="na" icon="CircleHelp" text={t("Session state unavailable")} />);
  } else if (summary) {
    // Approvals and errors ask for the user, so they show whatever the session switch says.
    if (summary.permissions)
      items.push(<Signal key="perm" color={colors.statusWarning} text={tn(summary.permissions, "{n} approval", "{n} approvals")} />);
    if (summary.errors)
      items.push(<Signal key="err" color={colors.statusDanger} text={tn(summary.errors, "{n} error", "{n} errors")} />);
    if (display.sessions) {
      if (summary.running || summary.starting)
        items.push(
          <Signal
            key="run"
            pulse
            color={colors.accent}
            text={summary.starting && !summary.running ? t("{n} starting", { n: summary.starting }) : t("{n} running", { n: summary.running + summary.starting })}
          />,
        );
      // A session with an open question is already shown as "Needs you".
      const unread = Math.max(0, summary.unread - questions - summary.questions);
      if (unread)
        items.push(<Signal key="unread" color={colors.statusSuccess} text={t("{n} unread", { n: unread })} />);
      if (!items.length && summary.total)
        items.push(<Signal key="total" icon="MessageSquare" text={`${summary.total}`} />);
      if (summaryState === "stale")
        items.push(<Signal key="stale" icon="Clock" text={t("Last known")} />);
    }
  } else if (sessions && display.sessions)
    items.push(<Signal key="fallback" icon="MessageSquare" text={running ? t("{running}/{sessions} running", { running, sessions }) : `${sessions}`} />);
  const review = visibleReview(task);
  // A running review has its own strip under the card.
  if (review && review.state !== "running")
    items.push(
      <Signal
        key="review"
        icon={reviewIcon(review)}
        color={review.state === "failed" || review.state === "rework" ? colors.statusDanger : review.state === "passed" ? colors.statusSuccess : review.state === "unavailable" || review.state === "cancelled" ? colors.statusWarning : undefined}
        text={reviewLabel(review)}
      />,
    );
  if (attentionSnoozed) items.push(<Signal key="snoozed" icon="BellOff" text={t("Snoozed")} />);
  if (workpad && display.workpad && workpadText(workpad)) items.push(<Signal key="workpad" icon="ListChecks" text={workpadText(workpad)} />);
  if (ideas && display.ideas) items.push(<Signal key="ideas" icon="Lightbulb" color={colors.statusWarning} text={`${ideas}`} />);
  if (task.archivedAt) items.push(<Badge key="archived">{t("Archived")}</Badge>);
  if (legacy) items.push(<Badge key="legacy">{t("Legacy")}</Badge>);
  if (!items.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[3], rowGap: space[1] }}>{items}</View>;
}

/**
 * What the card is: workspace, priority, type, ticket and tags as one quiet row above the
 * title (CARD-DISPLAY-SPEC §2). Plain text with icons; only Urgent/High keep colour.
 */
function CardMeta({ task, project, externalKey, externalFamily, workspace, display }: { task: Task; project: string; externalKey: string; externalFamily?: ConnectorFamily; workspace: CardWorkspace | null; display: CardDisplay }) {
  const { colors } = useTheme();
  const priority = display.priority && task.priority !== "normal";
  const accent = priorityAccent(colors, task.priority);
  const type = display.type && !!task.type;
  const ticket = display.external && !!externalKey;
  const place = display.workspace ? workspace : null;
  const tags = display.tags ? task.tags || [] : [];
  if (!project && !priority && !type && !ticket && !place && !tags.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[2]+2, rowGap: 2, minWidth: 0 }}>
      {!!project && (
        // All projects board only (ALL-PROJECTS-SPEC §3): the card's project, truncated so it never crowds the row.
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0, maxWidth: 140 }}>
          <Icon name="Folder" size={12} color={colors.foregroundMuted} />
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <Label size={font.xs} muted lines={1} selectable={false}>{project}</Label>
          </View>
        </View>
      )}
      {place && <Meta label={workspaceLabel(place)} icon={<WorkspaceIcon workspace={place} size={12} />} text={workspaceLabels[place]} />}
      {priority && (
        <Meta label={t("{priority} priority", { priority: priorityLabels[task.priority] })} icon={<PriorityIcon priority={task.priority} size={12} />} text={priorityLabels[task.priority]} color={accent} />
      )}
      {type && <Meta label={t("Type: {type}", { type: taskTypeLabels[task.type!] })} icon={<TypeIcon type={task.type!} size={12} />} text={taskTypeLabels[task.type!]} />}
      {ticket && <Meta label={externalKey} icon={externalFamily ? <BrandIcon family={externalFamily} size={12} /> : <Icon name="Ticket" size={12} color={colors.foregroundMuted} />} text={externalKey} />}
      {!!tags.length && (
        // Custom tags (CARD-TAGS-SPEC §6.2): the first two, then a count.
        <View
          accessibilityLabel={t("Tags: {tags}", { tags: tags.map((x) => x.tag).join(", ") })}
          style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], flexShrink: 1, minWidth: 0 }}
        >
          {tags.slice(0, 2).map((x) => (
            <View key={x.tag} style={{ flexShrink: 1, minWidth: 0 }}>
              <Label size={font.xs} muted lines={1} selectable={false}>{`#${x.tag}`}</Label>
            </View>
          ))}
          {tags.length > 2 && <Label size={font.xs} muted selectable={false}>{`+${tags.length - 2}`}</Label>}
        </View>
      )}
    </View>
  );
}

function Meta({ label, icon, text, color }: { label: string; icon: ReactNode; text: string; color?: string | null }) {
  return (
    <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}>
      {icon}
      <Label size={font.xs} medium={!!color} muted={!color} color={color || undefined} lines={1} selectable={false}>
        {text}
      </Label>
    </View>
  );
}
