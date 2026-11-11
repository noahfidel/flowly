import { useEffect, useRef, useState, type ReactNode } from "react";
import { sortTasks } from "../shared/sort";
import { animatesCollapse } from "./collapsed-columns";
import { Animated, PanResponder, Pressable, View, type ScrollView as NativeScrollView } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Status, Task } from "../shared/model";
import { statusLabels } from "../shared/model";
import { IconButton, Label, font, noFocusRing, radius, space, touch, useTheme, verticalScroll, verticalContent } from "./ui";
import { menuHandlers, useMenuOpener, useOnMenuChange } from "./context-menu";
import { StatusIcon } from "./status";
import type { CardDrag } from "./card";
import { Enter, motionDuration, useMotionPresence, useMotionValue, lerp } from "./motion";
import {
  boardPanDecision,
  columnAtPoint,
  columnGap,
  columnWidth,
  contentY,
  dropSlot,
  edgeScroll,
  laneRevealOffset,
  cardRevealOffset,
  panOffset,
  placementUpdate,
  type BoardPress,
  type ColumnBounds,
  type DropSlot,
  type Point,
  type Rect,
  collapsedWidth,
} from "./geometry";
import { t, tn } from "../shared/i18n";

type DragState = { task: Task; point: Point; target: Status | null; slot: DropSlot | null; sequence: number };
export type Placement = NonNullable<ReturnType<typeof placementUpdate>>;

/**
 * A lane's outer frame. Collapsing/expanding animates its width (JS-driven;
 * width is layout) and fades the new content in; the frame owns the layout
 * measurement used for drop targeting.
 */
function LaneFrame({ status, collapsed, animate, onLayout, frameRef, children }: { status: Status; collapsed: boolean; animate: boolean; onLayout(x: number, width: number): void; frameRef(node: View | null): void; children: ReactNode }) {
  const { colors } = useTheme();
  const open = useMotionValue(collapsed ? 0 : 1, !animate ? 0 : collapsed ? motionDuration.reverse : motionDuration.forward, collapsed ? 0 : 1, true);
  return (
    <Animated.View
      ref={frameRef}
      testID={`lane-${status}`}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={{
        width: lerp(open, [collapsedWidth, columnWidth]),
        minHeight: 0,
        overflow: "hidden",
        borderRadius: radius.xl,
        backgroundColor: colors.surface1,
      }}
    >
      <Enter key={collapsed ? "collapsed" : "expanded"} distance={0} style={{ flex: 1, minHeight: 0 }}>
        {children}
      </Enter>
    </Animated.View>
  );
}

const noOlder: ReadonlySet<string> = new Set();

/** "Show N older" / "Hide older" row closing a Done/Cancelled lane (also used by the phone list). */
export function OlderToggle({ count, shown, onPress }: { count: number; shown: boolean; onPress(): void }) {
  const { colors } = useTheme();
  const text = shown ? t("Hide older tasks") : tn(count, "Show {n} older task", "Show {n} older tasks");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ expanded: shown }}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space[1.5],
          minHeight: touch ? 40 : 30,
          borderRadius: radius.md,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="Clock" size={13} color={colors.foregroundMuted} />
      <Label muted size={font.sm} selectable={false}>{text}</Label>
    </Pressable>
  );
}

/** Insertion line positioned absolutely in the column content, so showing it never shifts cards. */
function InsertLine({ y }: { y: number | null }) {
  const { colors } = useTheme();
  const last = useRef(0);
  if (y !== null) last.current = Math.max(0, y - 1);
  const opacity = useMotionValue(y === null ? 0 : 1);
  return <Animated.View testID="card-insert-line" pointerEvents="none" style={{
    position: "absolute", left: space[2], right: space[2], top: last.current, height: 2,
    borderRadius: 1, backgroundColor: colors.accent, opacity,
  }} />;
}

function LaneAccent({ active }: { active: boolean }) {
  const { colors } = useTheme();
  const opacity = useMotionValue(active ? 1 : 0);
  return <Animated.View pointerEvents="none" style={{
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    borderWidth: 1.5, borderRadius: radius.xl, borderColor: colors.accent, opacity,
  }} />;
}
export function DesktopColumns({
  statuses,
  tasks,
  disabled,
  cancelKey,
  sortColumn = (column) => sortTasks(column, "manual"),
  manualOrder = true,
  onReorderBlocked = () => undefined,
  collapsed = [],
  onToggleCollapse: toggleCollapseProp,
  nameOf = (status) => statusLabels[status],
  older = noOlder,
  olderShown = [],
  onToggleOlder,
  reveal,
  renderCard,
  onAdd,
  onDrop,
}: {
  statuses: Status[];
  tasks: Task[];
  disabled: boolean;
  /** Orders one column for display. */
  sortColumn?(tasks: Task[]): Task[];
  /** Manual sort: drops pick a slot. Otherwise cards only change column (appended in manual order). */
  manualOrder?: boolean;
  /** A within-column drop while a non-manual sort is active. */
  onReorderBlocked?(): void;
  /** Columns shown as a narrow strip (still a drop target). */
  collapsed?: readonly Status[];
  onToggleCollapse?(status: Status): void;
  /** The project's lane name for a status. */
  nameOf?(status: Status): string;
  cancelKey: string;
  /** Old Done/Cancelled cards: tucked under a "Show older" row at the bottom of their lane. */
  older?: ReadonlySet<string>;
  /** Lanes whose older cards are shown. */
  olderShown?: readonly Status[];
  onToggleOlder?(status: Status): void;
  /**
   * Scrolls this lane into view each time `n` changes: to the left edge (a lane jump),
   * or with `center` centred, only when not fully visible (the open card's lane beside the drawer). A request older
   * than a second (`at`) is not replayed when the board mounts again, e.g. on leaving Insights.
   */
  reveal?: { status: Status; n: number; at: number; center?: boolean; taskId?: string };
  renderCard(task: Task, drag: CardDrag, dragging: boolean): ReactNode;
  onAdd(status: Status): void;
  onDrop(input: Placement): void;
}) {
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const [hoverHeader, setHoverHeader] = useState<Status | null>(null);
  // RN-web ends a Pressable's hover while a nested Pressable is hovered, so the header buttons report their own.
  const [hoverHeaderButton, setHoverHeaderButton] = useState<string | null>(null);
  const trackHeaderButton = (key: string) => (hovered: boolean) => setHoverHeaderButton((h) => (hovered ? key : h === key ? null : h));
  const cardGap = space[2];
  const viewportRef = useRef<View>(null),
    scrollRef = useRef<NativeScrollView>(null);
  const viewport = useRef<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const columns = useRef<ColumnBounds[]>([]),
    offset = useRef(0),
    contentWidth = useRef(0);
  const cards = useRef<Record<string, { y: number; height: number }>>({}),
    order = useRef<Partial<Record<Status, string[]>>>({}),
    lists = useRef<Partial<Record<Status, View | null>>>({}),
    frames = useRef<Partial<Record<Status, View | null>>>({}),
    toggled = useRef(new Set<Status>()),
    listTops = useRef<Partial<Record<Status, number>>>({}),
    scrollY = useRef<Partial<Record<Status, number>>>({}),
    listScrolls = useRef<Partial<Record<Status, NativeScrollView | null>>>({});
  // A lane animates its collapse only for the user's own toggle, never when the stored settings arrive or on mount.
  const onToggleCollapse = toggleCollapseProp
    ? (status: Status) => {
        toggled.current.add(status);
        toggleCollapseProp(status);
      }
    : undefined;
  const live = useRef<DragState | null>(null);
  const sequence = useRef(0);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const ghost = useMotionPresence(dragging, dragging ? `${dragging.task.id}|${dragging.sequence}` : "");
  const cancel = () => {
    live.current = null;
    setDragging(null);
  };
  // Board pan (desktop mouse only): a press on empty space moves the board sideways, immediately, no animation.
  const press = useRef<BoardPress | null>(null);
  const panStart = useRef<number | null>(null);
  const [panning, setPanning] = useState(false);
  const endPan = () => {
    press.current = null;
    panStart.current = null;
    setPanning(false);
  };
  const [panResponder] = useState(() =>
    PanResponder.create({
      // Capture: asked before the cards' own responders; a press that began on a card never pans.
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        !touch && !live.current && boardPanDecision(press.current, g.dx, g.dy) === "pan",
      onPanResponderGrant: () => {
        panStart.current = offset.current;
        setPanning(true);
      },
      onPanResponderMove: (_e, g) => {
        if (panStart.current === null) return;
        const x = panOffset(panStart.current, g.dx, contentWidth.current, viewport.current.width);
        if (x === offset.current) return;
        offset.current = x;
        scrollRef.current?.scrollTo({ x, animated: false });
      },
      onPanResponderRelease: endPan,
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: endPan,
    }),
  );
  const current = useRef({ disabled, onDrop, manualOrder, onReorderBlocked });
  current.current = { disabled, onDrop, manualOrder, onReorderBlocked };
  const target = (point: Point) =>
    columnAtPoint(
      point,
      viewport.current,
      offset.current,
      columns.current.filter((c) => statuses.includes(c.status)),
    );
  const slot = (task: Task, status: Status | null, point: Point) => {
    const top = status ? listTops.current[status] : undefined;
    if (!status || top === undefined || !current.current.manualOrder) return null;
    const bounds = (order.current[status] || []).flatMap((id) =>
      cards.current[id] ? [{ id, ...cards.current[id] }] : [],
    );
    return dropSlot(contentY(point.y, top, scrollY.current[status] || 0), bounds, task.id, cardGap);
  };
  const move = (point: Point) => {
    if (!live.current) return;
    const status = target(point);
    const next = { ...live.current, point, target: status, slot: slot(live.current.task, status, point) };
    live.current = next;
    setDragging(next);
  };
  const drag: CardDrag = {
    start(task, point) {
      if (current.current.disabled || task.archivedAt) return;
      live.current = { task: { ...task }, point, target: target(point), slot: null, sequence: ++sequence.current };
      setDragging(live.current);
      listTops.current = {};
      viewportRef.current?.measureInWindow((x, y, width, height) => {
        viewport.current = { x, y, width, height };
        // Web onLayout only reports size changes, so lanes shifted by a sibling
        // collapsing/expanding keep a stale x: re-measure them for this drag.
        // forEach, not a for loop: each callback must keep its own lane on Hermes (one binding per loop `const`).
        (Object.entries(frames.current) as [Status, View | null][]).forEach(([status, frame]) =>
          frame?.measureInWindow((laneX, _laneY, laneWidth) => {
            columns.current = [
              ...columns.current.filter((c) => c.status !== status),
              { status, x: laneX - viewport.current.x + offset.current, width: laneWidth },
            ];
            if (live.current) move(live.current.point);
          }),
        );
        if (live.current) move(live.current.point);
      });
      (Object.entries(lists.current) as [Status, View | null][]).forEach(([status, list]) =>
        list?.measureInWindow((_x, y) => {
          listTops.current[status] = y;
          if (live.current) move(live.current.point);
        }),
      );
    },
    move,
    end(point) {
      const snapshot = live.current;
      cancel();
      if (!snapshot || current.current.disabled) return;
      const status = target(point);
      if (!current.current.manualOrder && status === snapshot.task.status) {
        current.current.onReorderBlocked();
        return;
      }
      const input = placementUpdate(
        snapshot.task,
        status,
        slot(snapshot.task, status, point),
        status ? order.current[status] || [] : [],
      );
      if (input) current.current.onDrop(input);
    },
    cancel,
  };
  // Cards are memoized: hand them one drag object that always runs this
  // render's handlers (PERFORMANCE-SPEC §3).
  const latestDrag = useRef(drag);
  latestDrag.current = drag;
  const [stableDrag] = useState<CardDrag>(() => ({
    start: (task, point) => latestDrag.current.start(task, point),
    move: (point) => latestDrag.current.move(point),
    end: (point) => latestDrag.current.end(point),
    cancel: () => latestDrag.current.cancel(),
  }));
  useEffect(() => {
    cancel();
    endPan();
  }, [cancelKey, disabled]);
  // A menu opening ends a drag in progress, without re-rendering the columns.
  useOnMenuChange((open) => {
    if (open) latestDrag.current.cancel();
  });
  useEffect(() => {
    if (!reveal?.n || Date.now() - reveal.at > 1000) return;
    // After the lane has expanded and the drawer has narrowed the board. Both are measured now: web onLayout
    // misses a lane shifted by a sibling, and the viewport may not have reported its new width yet.
    const timer = setTimeout(() => {
      const frame = frames.current[reveal.status];
      viewportRef.current?.measureInWindow((vx, vy, width, height) => {
        viewport.current = { x: vx, y: vy, width, height };
        frame?.measureInWindow((laneX, _laneY, laneWidth) => {
          const x = laneRevealOffset(
            { x: laneX - vx + offset.current, width: laneWidth },
            offset.current,
            width,
            contentWidth.current,
            { center: reveal.center, inset: space[3] },
          );
          if (x === null) return;
          offset.current = x;
          scrollRef.current?.scrollTo({ x, animated: true });
        });
        // Then the card inside its lane's list, when opening a card (not for the overview chips).
        const card = reveal.center && reveal.taskId ? cards.current[reveal.taskId] : undefined;
        lists.current[reveal.status]?.measureInWindow((_lx, _ly, _lw, listHeight) => {
          if (!card) return;
          const y = cardRevealOffset(card, scrollY.current[reveal.status] || 0, listHeight, space[2]);
          if (y === null) return;
          scrollY.current[reveal.status] = y;
          listScrolls.current[reveal.status]?.scrollTo({ y, animated: true });
        });
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [reveal?.n]);
  useEffect(() => {
    if (!dragging) return;
    const timer = setInterval(() => {
      const active = live.current;
      if (!active) return;
      const next = edgeScroll(
        active.point,
        viewport.current,
        offset.current,
        contentWidth.current,
      );
      if (next !== offset.current) {
        offset.current = next;
        scrollRef.current?.scrollTo({ x: next, animated: false });
        move(active.point);
      }
    }, 40);
    return () => clearInterval(timer);
  }, [!!dragging]);
  useEffect(
    () => () => {
      live.current = null;
    },
    [],
  );
  return (
    <View
      ref={viewportRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        ...(touch ? null : ({ cursor: panning ? "grabbing" : "grab", ...(panning ? { userSelect: "none" } : null) } as object)),
      }}
      {...(touch ? {} : panResponder.panHandlers)}
      onPointerDownCapture={
        touch
          ? undefined
          : (e) => {
              press.current = { mouse: e.nativeEvent.pointerType === "mouse", primary: e.nativeEvent.button === 0, onCard: false };
            }
      }
      onPointerUp={touch ? undefined : () => (press.current = null)}
      onPointerCancel={touch ? undefined : () => (press.current = null)}
      onLayout={() => {
        cancel();
        viewportRef.current?.measureInWindow((x, y, width, height) => {
          viewport.current = { x, y, width, height };
        });
      }}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        style={{ flex: 1, minHeight: 0 }}
        scrollEnabled={!dragging}
        scrollEventThrottle={16}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.x;
          if (live.current) move(live.current.point);
        }}
        onContentSizeChange={(width) => {
          contentWidth.current = width;
        }}
        contentContainerStyle={{
          padding: space[3],
          paddingTop: space[2],
          gap: columnGap,
          alignItems: "stretch",
        }}
      >
        {statuses.map((status) => {
          const column = sortColumn(tasks.filter((t) => t.status === status));
          const recent = column.filter((t) => !older.has(t.id)),
            past = column.filter((t) => older.has(t.id)),
            pastShown = olderShown.includes(status);
          const shown = pastShown ? [...recent, ...past] : recent;
          // Drop slots follow the cards actually on screen.
          order.current[status] = shown.map((t) => t.id);
          const highlighted =
            dragging?.target === status && dragging.task.status !== status;
          const line =
            dragging?.target === status &&
            placementUpdate(dragging.task, status, dragging.slot, order.current[status])
              ? (dragging.slot?.lineY ?? null)
              : null;
          const headerMenu = menuHandlers(openMenu, nameOf(status), () => [
            { id: "add", label: t("Add task"), icon: "Plus", disabled, onPress: () => onAdd(status) },
            ...(onToggleCollapse
              ? [{ id: "collapse", label: collapsed.includes(status) ? t("Expand column") : t("Collapse column"), icon: collapsed.includes(status) ? "ChevronsLeftRight" : "ChevronsRightLeft", onPress: () => onToggleCollapse(status) }]
              : []),
          ]);
          const cardSlot = (t: Task) => (
            <View
              key={t.id}
              onPointerDown={() => {
                if (press.current) press.current.onCard = true;
              }}
              onLayout={(e) => {
                const { y, height } = e.nativeEvent.layout;
                cards.current[t.id] = { y, height };
              }}
            >
              {renderCard(t, stableDrag, dragging?.task.id === t.id)}
            </View>
          );
          const frameRef = (node: View | null) => {
            frames.current[status] = node;
          };
          const measure = (x: number, width: number) => {
            columns.current = [...columns.current.filter((c) => c.status !== status), { status, x, width }];
          };
          if (collapsed.includes(status))
            return (
              <LaneFrame key={status} status={status} collapsed animate={animatesCollapse(toggled.current, status)} onLayout={measure} frameRef={frameRef}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tn(column.length, "Expand {lane}, {n} task", "Expand {lane}, {n} tasks", { lane: nameOf(status) })}
                onPress={() => onToggleCollapse?.(status)}
                {...headerMenu}
                style={(state) => {
                  const { hovered } = state as typeof state & { hovered?: boolean };
                  return {
                    ...noFocusRing,
                    flex: 1,
                    minHeight: 0,
                    alignItems: "center",
                    paddingTop: space[3],
                    gap: space[2],
                    borderRadius: radius.xl,
                    backgroundColor: highlighted ? colors.surface2 : hovered ? colors.surface2 : colors.surface1,
                    overflow: "hidden",
                  };
                }}
              >
                <StatusIcon status={status} />
                <Label muted size={font.sm} selectable={false}>{column.length}</Label>
                {/* Vertical title: a rotated label in a box as tall as the text is wide. */}
                <View style={{ width: 20, height: 140, alignItems: "center", justifyContent: "center" }}>
                  <View style={{ width: 140, alignItems: "center", transform: [{ rotate: "90deg" }] }}>
                    <Label medium size={font.md} lines={1} selectable={false}>{nameOf(status)}</Label>
                  </View>
                </View>
                <LaneAccent active={!!highlighted} />
              </Pressable>
              </LaneFrame>
            );
          return (
            <LaneFrame key={status} status={status} collapsed={false} animate={animatesCollapse(toggled.current, status)} onLayout={measure} frameRef={frameRef}>
            <View
              style={{
                width: columnWidth,
                flex: 1,
                minHeight: 0,
                borderRadius: radius.xl,
                backgroundColor: highlighted ? colors.surface2 : colors.surface1,
                overflow: "hidden",
              }}
            >
              <Pressable
                accessible={false}
                {...headerMenu}
                onHoverIn={() => setHoverHeader(status)}
                onHoverOut={() => setHoverHeader((h) => (h === status ? null : h))}
                style={{
                  ...noFocusRing,
                  paddingLeft: space[3],
                  paddingRight: space[1.5],
                  height: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  ...({ cursor: touch ? "default" : "grab" } as object),
                }}
              >
                <StatusIcon status={status} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                  <Label medium size={font.md} lines={1} selectable={false}>
                    {nameOf(status)}
                  </Label>
                  <Label muted size={font.md} selectable={false}>
                    {column.length}
                  </Label>
                </View>
                {onToggleCollapse && (
                  // Always mounted (RN-web clears hover on press); revealed on header hover, always shown on touch.
                  <View style={{ opacity: touch || hoverHeader === status || hoverHeaderButton?.startsWith(`${status}:`) ? 1 : 0 }}>
                    <IconButton
                      icon="ChevronsRightLeft"
                      size={28}
                      label={t("Collapse {name}", { name: nameOf(status) })}
                      onHoverChange={trackHeaderButton(`${status}:collapse`)}
                      onPress={() => onToggleCollapse(status)}
                    />
                  </View>
                )}
                <IconButton
                  icon="Plus"
                  size={28}
                  label={t("Add task to {name}", { name: nameOf(status) })}
                  disabled={disabled}
                  onHoverChange={trackHeaderButton(`${status}:add`)}
                  onPress={() => onAdd(status)}
                />
              </Pressable>
              <View
                ref={(list) => {
                  lists.current[status] = list;
                }}
                style={{ flex: 1, minHeight: 0 }}
              >
              <ScrollView
                {...verticalScroll}
                ref={(node) => {
                  listScrolls.current[status] = node;
                }}
                style={{ flex: 1, minHeight: 0 }}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                scrollEventThrottle={16}
                onScroll={(e) => {
                  scrollY.current[status] = e.nativeEvent.contentOffset.y;
                  if (live.current) move(live.current.point);
                }}
                contentContainerStyle={{
                  ...verticalContent,
                  paddingHorizontal: space[2],
                  paddingBottom: space[4],
                  gap: cardGap,
                }}
              >
                {recent.map(cardSlot)}
                {!recent.length && (
                  // Same box idle and while dragging, so starting a drag never shifts the lane.
                  <View
                    style={{
                      height: 72,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderStyle: "dashed",
                      borderColor: highlighted ? colors.accent : dragging ? colors.border : "transparent",
                    }}
                  >
                    <Label muted size={font.sm} selectable={false}>
                      {highlighted ? t("Drop to move here") : past.length ? t("No recent tasks") : t("No tasks")}
                    </Label>
                  </View>
                )}
                {past.length > 0 && (
                  <OlderToggle count={past.length} shown={pastShown} onPress={() => onToggleOlder?.(status)} />
                )}
                {pastShown && past.map(cardSlot)}
                <InsertLine y={line} />
              </ScrollView>
              </View>
              <LaneAccent active={!!highlighted} />
            </View>
            </LaneFrame>
          );
        })}
      </ScrollView>
      {ghost.item && (
        <Animated.View
          testID="card-drag-motion"
          pointerEvents="none"
          style={{
            position: "absolute",
            zIndex: 20,
            opacity: ghost.progress,
            transform: [{ scale: lerp(ghost.progress, [0.96, 1.02]) }],
            left: Math.max(
              4,
              Math.min(
                Math.max(4, viewport.current.width - 224),
                ghost.item.point.x - viewport.current.x + 12,
              ),
            ),
            top: Math.max(
              4,
              Math.min(
                Math.max(4, viewport.current.height - 80),
                ghost.item.point.y - viewport.current.y + 12,
              ),
            ),
            width: 220,
            paddingHorizontal: space[3],
            paddingVertical: space[2] + 2,
            gap: space[1],
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: colors.surface0,
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          <Label medium size={font.base} lines={2} selectable={false}>
            {ghost.item.task.title}
          </Label>
          <Label muted size={font.sm} selectable={false}>
            {ghost.item.target && ghost.item.target !== ghost.item.task.status
              ? t("Move to {name}", { name: nameOf(ghost.item.target) })
              : ghost.item.target &&
                  placementUpdate(ghost.item.task, ghost.item.target, ghost.item.slot, order.current[ghost.item.target] || [])
                ? t("Reorder in {name}", { name: nameOf(ghost.item.target) })
                : t("Drag to reorder or move")}
          </Label>
        </Animated.View>
      )}
    </View>
  );
}
