import type { Status } from "../shared/model";

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type ColumnBounds = { status: Status; x: number; width: number };
export const columnWidth = 280;
export const columnGap = 12;
/** A collapsed lane's width. */
export const collapsedWidth = 44;

/** Points a held mouse press must move before it becomes a card drag or a board pan; a smaller move is still a click. */
export const dragThreshold = 8;

/** How a mouse press started: `onCard` when it began on a card (card drag wins over a board pan). */
export type BoardPress = { mouse: boolean; primary: boolean; onCard: boolean };

/** Records a pointer press from its event; `onCard` when a card's slot saw the same event first. */
export function boardPress(event: { pointerType?: string; button?: number }, onCard: boolean): BoardPress {
  return { mouse: event.pointerType === "mouse", primary: event.button === 0, onCard };
}

/**
 * What a held press means for the board: "pan" once a primary mouse press that began off a card has moved
 * `dragThreshold`, "wait" until then (a plain click still reaches its button), "none" when it can never pan.
 */
export function boardPanDecision(press: BoardPress | null, dx: number, dy: number): "pan" | "wait" | "none" {
  if (!press || !press.mouse || !press.primary || press.onCard) return "none";
  return Math.hypot(dx, dy) >= dragThreshold ? "pan" : "wait";
}

/** A mouse press tracked by the board so a lane toggle fires only on a click in place on itself. `toggle` is the toggle the press began on; `moved` the farthest the pointer got from the start; `upAt` when it was released. */
export type TogglePress = { x: number; y: number; moved: number; toggle: string | null; upAt: number | null };

export function togglePressStart(point: Point, toggle: string | null): TogglePress {
  return { x: point.x, y: point.y, moved: 0, toggle, upAt: null };
}

export function togglePressMove(press: TogglePress, point: Point): TogglePress {
  return { ...press, moved: Math.max(press.moved, Math.hypot(point.x - press.x, point.y - press.y)) };
}

export function togglePressEnd(press: TogglePress, point: Point, now: number): TogglePress {
  return { ...togglePressMove(press, point), upAt: now };
}

/** How long after its release a tracked press still counts as the one behind a click. */
export const togglePressStaleMs = 1000;

/** Whether activating toggle `key` now should toggle. No tracked press, or one released more than togglePressStaleMs ago: keyboard or assistive activation, fires. Otherwise only when the press began on this toggle and never moved dragThreshold. */
export function laneToggleFires(press: TogglePress | null, key: string, now: number): boolean {
  if (!press) return true;
  if (press.upAt !== null && now - press.upAt > togglePressStaleMs) return true;
  return press.toggle === key && press.moved < dragThreshold;
}

/** The board's scroll offset after a pan of `dx` from `start`, clamped to the scrollable range. */
export function panOffset(start: number, dx: number, contentWidth: number, viewportWidth: number): number {
  return Math.max(0, Math.min(Math.max(0, contentWidth - viewportWidth), start - dx));
}

export function columnAtPoint(
  point: Point,
  viewport: Rect,
  scrollX: number,
  columns: ColumnBounds[],
): Status | null {
  if (
    point.x < viewport.x ||
    point.x >= viewport.x + viewport.width ||
    point.y < viewport.y ||
    point.y >= viewport.y + viewport.height
  )
    return null;
  const x = point.x - viewport.x + scrollX;
  return columns.find((c) => x >= c.x && x < c.x + c.width)?.status ?? null;
}

export function edgeScroll(
  point: Point,
  viewport: Rect,
  offset: number,
  contentWidth: number,
): number {
  if (
    point.y < viewport.y ||
    point.y >= viewport.y + viewport.height ||
    point.x < viewport.x ||
    point.x >= viewport.x + viewport.width
  )
    return offset;
  const edge = Math.min(48, viewport.width / 4);
  const localX = point.x - viewport.x;
  const step = localX < edge ? -18 : localX > viewport.width - edge ? 18 : 0;
  return Math.max(
    0,
    Math.min(Math.max(0, contentWidth - viewport.width), offset + step),
  );
}

/**
 * The board's scroll offset that brings a lane (`x`, `width` in content coordinates) into view: its left edge `inset`
 * from the viewport's, or with `center` the lane centred, and then only when it is not already fully visible (null:
 * leave the board where it is). Clamped to the scrollable range.
 */
export function laneRevealOffset(
  lane: { x: number; width: number },
  offset: number,
  viewportWidth: number,
  contentWidth: number,
  { center = false, inset = 0 }: { center?: boolean; inset?: number } = {},
): number | null {
  if (center && lane.x >= offset && lane.x + lane.width <= offset + viewportWidth) return null;
  const target = center ? lane.x + lane.width / 2 - viewportWidth / 2 : lane.x - inset;
  const next = Math.min(Math.max(0, contentWidth - viewportWidth), Math.max(0, target));
  return next === offset ? null : next;
}

/**
 * The lane list's scroll offset that brings a card (`y`, `height` in the list's content) into view, `inset` from the
 * nearest edge; null when it is already fully visible. Never negative.
 */
export function cardRevealOffset(
  card: { y: number; height: number },
  offset: number,
  listHeight: number,
  inset = 0,
): number | null {
  if (card.y >= offset && card.y + card.height <= offset + listHeight) return null;
  const next = Math.max(0, card.y < offset ? card.y - inset : card.y + card.height + inset - listHeight);
  return next === offset ? null : next;
}

/** At least 340 points; no fixed maximum, only the window's: 300 points of board plus the grip stay. */
export function drawerWidth(preferred: number, surfaceWidth: number): number {
  return Math.max(340, Math.min(surfaceWidth - 312, preferred));
}

/**
 * The card sidebar's own frame. Its parent is a column (the step-through bar sits
 * above it), so the sidebar takes the column's remaining height with flex: 1 on
 * every layout; sized to its content instead, a long session transcript pushed the
 * message box below the window.
 */
export function drawerFrame(compact: boolean, width: number) {
  return { width: compact ? ("100%" as const) : width, flex: 1, minHeight: 0, maxWidth: "100%" as const };
}

/** The drawer's share of the Flowly area until it is dragged (UI-UX-SPEC §4). */
export const defaultDrawerShare = 0.5;

/** The share of the Flowly area a dragged drawer keeps, clamped like drawerWidth. */
export function drawerShare(width: number, surfaceWidth: number): number {
  return drawerWidth(width, surfaceWidth) / surfaceWidth;
}

/** The docked dispatcher chat's width until it is dragged, and after a double-click on its grip (DISPATCHER-SPEC §9.3). */
export const defaultChatWidth = 380;
/** The narrowest docked chat: its message box and buttons still fit. */
export const minChatWidth = 300;

/**
 * The docked chat's width: `preferred` (0, negative or not a number = never dragged, the default) kept between the
 * minimum and what leaves the board 300 points beside the chat's 8-point grip and `reserved` (an open card sidebar
 * with its grip). The minimum wins when the window has no room for both; `min` is the dock's own (two panes Side by
 * side, dock-logic.ts).
 */
export function chatWidth(preferred: number, surfaceWidth: number, reserved = 0, min = minChatWidth): number {
  const wanted = preferred > 0 ? preferred : defaultChatWidth;
  return Math.max(min, Math.min(surfaceWidth - reserved - 8 - 300, wanted));
}

export function isCompactLayout(width: number): boolean {
  // Use the same layout everywhere; unmeasured surfaces start compact.
  return width < 760;
}

export type CardBounds = { id: string; y: number; height: number };
export type DropSlot = {
  index: number;
  beforeId: string | null;
  afterId: string | null;
  lineY: number | null;
};

/** Insertion slot for a pointer at `contentY` in a column's scroll content; the dragged card is ignored. */
export function dropSlot(
  contentY: number,
  cards: CardBounds[],
  draggedId: string,
  gap: number,
): DropSlot {
  const others = cards.filter((c) => c.id !== draggedId);
  let index = others.findIndex((c) => contentY < c.y + c.height / 2);
  if (index < 0) index = others.length;
  const next = others[index],
    last = others[others.length - 1];
  return {
    index,
    beforeId: next?.id ?? null,
    afterId: !next && last ? last.id : null,
    lineY: next ? next.y - gap / 2 : last ? last.y + last.height + gap / 2 : null,
  };
}

/** Column content y for a window point, given the list's window top and vertical scroll. */
export function contentY(pointY: number, listTop: number, scrollY: number) {
  return pointY - listTop + scrollY;
}

/** `tasks.place` input for a drop, or null when outside the board, unmeasured in its own column, or staying in place. */
export function placementUpdate(
  task: { id: string; revision: number; status: Status },
  target: Status | null,
  slot: DropSlot | null,
  columnIds: string[],
) {
  if (!target || (!slot && target === task.status)) return null;
  const index = slot?.index ?? columnIds.filter((id) => id !== task.id).length;
  if (target === task.status && columnIds.indexOf(task.id) === index) return null;
  return {
    id: task.id,
    revision: task.revision,
    status: target,
    beforeId: slot?.beforeId ?? null,
    afterId: slot?.afterId ?? null,
  };
}

/**
 * Index a dragged list row lands on: the number of other rows whose centre is
 * above the dragged row's centre after moving it by `dy`.
 */
export function listDropIndex(heights: readonly number[], from: number, dy: number, gap = 0): number {
  let top = 0;
  const centres = heights.map((h) => {
    const centre = top + h / 2;
    top += h + gap;
    return centre;
  });
  const moved = centres[from] + dy;
  return centres.filter((c, i) => i !== from && c < moved).length;
}

/** How far row `index` slides aside while row `from` is held over `to`. */
export function listShift(index: number, from: number, to: number, size: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -size;
  if (to < from && index >= to && index < from) return size;
  return 0;
}

/**
 * How much of a view the on-screen keyboard covers: its bottom edge minus the
 * keyboard's top edge (both in window coordinates). Zero when the host already
 * resized the window (Android adjustResize) or moved the view out of the way.
 */
export function keyboardOverlap(viewBottom: number, keyboardTop: number | null): number {
  if (keyboardTop === null) return 0;
  return Math.max(0, Math.round(viewBottom - keyboardTop));
}
