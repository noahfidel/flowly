import { describe, expect, test } from "vitest";
import {
  columnAtPoint,
  listDropIndex,
  listShift,
  contentY,
  defaultDrawerShare,
  drawerShare,
  drawerWidth,
  drawerFrame,
  dropSlot,
  placementUpdate,
  edgeScroll,
  isCompactLayout,
  keyboardOverlap,
  laneRevealOffset,
  cardRevealOffset,
  chatWidth,
  defaultChatWidth,
} from "./geometry";

const viewport = { x: 100, y: 80, width: 600, height: 500 };
const columns = [
  { status: "todo" as const, x: 12, width: 280 },
  { status: "development" as const, x: 304, width: 280 },
];

describe("board interaction geometry", () => {
  test("targets measured columns with viewport origin and horizontal scroll", () => {
    expect(columnAtPoint({ x: 115, y: 100 }, viewport, 0, columns)).toBe(
      "todo",
    );
    expect(columnAtPoint({ x: 420, y: 100 }, viewport, 0, columns)).toBe(
      "development",
    );
    expect(columnAtPoint({ x: 130, y: 100 }, viewport, 292, columns)).toBe(
      "development",
    );
  });
  test("gaps, toolbar, drawer and outside pointers are not drop targets", () => {
    for (const point of [
      { x: 398, y: 100 },
      { x: 130, y: 79 },
      { x: 700, y: 100 },
      { x: 130, y: 580 },
    ]) {
      expect(columnAtPoint(point, viewport, 0, columns)).toBeNull();
    }
  });
  test("edge scroll is bounded and inactive outside the viewport", () => {
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 0, 1200)).toBe(18);
    expect(edgeScroll({ x: 110, y: 100 }, viewport, 10, 1200)).toBe(0);
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 595, 1200)).toBe(600);
    expect(edgeScroll({ x: 690, y: 60 }, viewport, 100, 1200)).toBe(100);
    expect(edgeScroll({ x: 400, y: 100 }, viewport, 100, 1200)).toBe(100);
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 0, 200)).toBe(0);
  });
  test("lane reveal: chips scroll to the lane's left edge, an open card's lane is centred only when not fully visible", () => {
    const lane = { x: 1180, width: 280 };
    // Overview bar chip: left edge with the board padding.
    expect(laneRevealOffset(lane, 0, 600, 2000, { inset: 12 })).toBe(1168);
    // Open card: its lane lies right of a 600-wide board, so it is centred.
    expect(laneRevealOffset(lane, 0, 600, 2000, { center: true })).toBe(1020);
    // Partly hidden behind the drawer's edge counts as not visible.
    expect(laneRevealOffset(lane, 700, 600, 2000, { center: true })).toBe(1020);
    // Already fully visible: the board does not move.
    expect(laneRevealOffset(lane, 1000, 600, 2000, { center: true })).toBeNull();
    // Clamped to the scrollable range at both ends.
    expect(laneRevealOffset({ x: 12, width: 280 }, 400, 600, 2000, { center: true })).toBe(0);
    expect(laneRevealOffset({ x: 1708, width: 280 }, 0, 600, 2000, { center: true })).toBe(1400);
    // A lane wider than the board is centred on its middle.
    expect(laneRevealOffset({ x: 900, width: 400 }, 0, 300, 2000, { center: true })).toBe(950);
    // Nothing to do when the target is the current offset.
    expect(laneRevealOffset(lane, 1168, 600, 2000, { inset: 12 })).toBeNull();
  });
  test("drawer resize keeps a readable drawer and at least 300 points of board", () => {
    expect(drawerWidth(100, 1200)).toBe(340);
    expect(drawerWidth(720, 800)).toBe(488);
    expect(drawerWidth(440, 760)).toBe(440);
    // No fixed maximum: only the window bounds it.
    expect(drawerWidth(1000, 1600)).toBe(1000);
    expect(drawerWidth(2400, 1600)).toBe(1288);
    expect(drawerWidth(Infinity, 1600)).toBe(1288);
    expect(drawerWidth(3000, 5120)).toBe(3000);
  });
  test("the card sidebar fills the height of the column it sits in, under the step-through bar (DRAWER-SPEC)", () => {
    // It sits in a column (step-through bar above it), so only flex: 1 bounds its
    // height; sized to its content, the session chat's message box fell below the window.
    expect(drawerFrame(false, 480)).toMatchObject({ width: 480, flex: 1, minHeight: 0 });
    expect(drawerFrame(true, 480)).toMatchObject({ width: "100%", flex: 1, minHeight: 0 });
  });
  test("the dispatcher chat opens at its default width and keeps a dragged width within bounds (DISPATCHER-SPEC §9.3)", () => {
    // Never dragged (0) or a bad value: the default.
    expect(chatWidth(0, 1600)).toBe(defaultChatWidth);
    expect(chatWidth(Number.NaN, 1600)).toBe(defaultChatWidth);
    expect(chatWidth(-50, 1600)).toBe(defaultChatWidth);
    expect(chatWidth(520, 1600)).toBe(520);
    // Never narrower than the composer needs.
    expect(chatWidth(120, 1600)).toBe(300);
    // The board keeps 300 points beside it and its grip.
    expect(chatWidth(1500, 1600)).toBe(1292);
    expect(chatWidth(Infinity, 1600)).toBe(1292);
    // An open card sidebar (its width plus grip) is left room too.
    expect(chatWidth(1000, 1600, 808)).toBe(484);
    // Re-clamped to a narrower window; the minimum wins when there is no room at all.
    expect(chatWidth(900, 1000)).toBe(692);
    expect(chatWidth(900, 500)).toBe(300);
    expect(chatWidth(0, 500, 400)).toBe(300);
  });
  test("the drawer opens at half the Flowly area and keeps a dragged width as a share of it", () => {
    expect(drawerWidth(defaultDrawerShare * 2080, 2080)).toBe(1040);
    expect(drawerWidth(defaultDrawerShare * 900, 900)).toBe(450);
    // Narrow surfaces still keep the minimum.
    expect(drawerWidth(defaultDrawerShare * 600, 600)).toBe(340);
    expect(drawerShare(1000, 2000)).toBe(0.5);
    // Clamped before it becomes a share: the minimum and the board's 300 points plus grip.
    expect(drawerShare(100, 2000)).toBe(0.17);
    expect(drawerShare(5000, 2000)).toBe(0.844);
    // The same share on a narrower window gives a proportionally narrower drawer.
    expect(drawerWidth(drawerShare(1500, 2000) * 1600, 1600)).toBe(1200);
  });
  test("only available width selects compact layout; unmeasured surfaces start compact", () => {
    expect(isCompactLayout(0)).toBe(true);
    expect(isCompactLayout(390)).toBe(true);
    expect(isCompactLayout(759)).toBe(true);
    expect(isCompactLayout(760)).toBe(false);
    expect(isCompactLayout(1000)).toBe(false);
    expect(isCompactLayout(1600)).toBe(false);
  });
});

const cards = [
  { id: "a", y: 0, height: 60 },
  { id: "b", y: 68, height: 80 },
  { id: "c", y: 156, height: 60 },
];
describe("drop slot hit testing", () => {
  test("compares the pointer with card midlines and anchors to the following card", () => {
    expect(dropSlot(-20, cards, "x", 8)).toEqual({ index: 0, beforeId: "a", afterId: null, lineY: -4 });
    expect(dropSlot(29, cards, "x", 8)).toMatchObject({ index: 0, beforeId: "a" });
    expect(dropSlot(30, cards, "x", 8)).toMatchObject({ index: 1, beforeId: "b", lineY: 64 });
    expect(dropSlot(150, cards, "x", 8)).toMatchObject({ index: 2, beforeId: "c" });
  });
  test("below the last midline appends after the last card; an empty column has no line", () => {
    expect(dropSlot(200, cards, "x", 8)).toEqual({ index: 3, beforeId: null, afterId: "c", lineY: 220 });
    expect(dropSlot(10, [], "x", 8)).toEqual({ index: 0, beforeId: null, afterId: null, lineY: null });
  });
  test("the dragged card is not a slot boundary", () => {
    expect(dropSlot(100, cards, "b", 8)).toMatchObject({ index: 1, beforeId: "c" });
    expect(dropSlot(200, cards, "c", 8)).toEqual({ index: 2, beforeId: null, afterId: "b", lineY: 152 });
  });
  test("window points convert through the list origin and vertical scroll", () => {
    expect(contentY(300, 200, 0)).toBe(100);
    expect(contentY(300, 200, 120)).toBe(220);
  });
});

describe("drop placement", () => {
  const task = { id: "b", revision: 7, status: "todo" as const };
  const column = ["a", "b", "c"];
  test("outside the board or the current slot does not write", () => {
    expect(placementUpdate(task, null, dropSlot(0, cards, "b", 8), column)).toBeNull();
    expect(placementUpdate(task, "todo", dropSlot(100, cards, "b", 8), column)).toBeNull();
    expect(placementUpdate(task, "todo", null, column)).toBeNull();
  });
  test("same-column moves carry the captured revision and one anchor", () => {
    expect(placementUpdate(task, "todo", dropSlot(0, cards, "b", 8), column)).toEqual({
      id: "b", revision: 7, status: "todo", beforeId: "a", afterId: null,
    });
    expect(placementUpdate(task, "todo", dropSlot(400, cards, "b", 8), column)).toEqual({
      id: "b", revision: 7, status: "todo", beforeId: null, afterId: "c",
    });
  });
  test("cross-column drops target the slot, or the end when no slot was measured", () => {
    const other = [{ id: "x", y: 0, height: 60 }];
    expect(placementUpdate(task, "done", dropSlot(10, other, "b", 8), ["x"])).toEqual({
      id: "b", revision: 7, status: "done", beforeId: "x", afterId: null,
    });
    expect(placementUpdate(task, "done", null, [])).toEqual({
      id: "b", revision: 7, status: "done", beforeId: null, afterId: null,
    });
  });
});

test("list drag lands by row centres and shifts the rows it passes", () => {
  const heights = [40, 40, 40, 40];
  expect(listDropIndex(heights, 0, 0, 4)).toBe(0);
  expect(listDropIndex(heights, 0, 30, 4)).toBe(0);
  expect(listDropIndex(heights, 0, 50, 4)).toBe(1);
  expect(listDropIndex(heights, 0, 500, 4)).toBe(3);
  expect(listDropIndex(heights, 3, -90, 4)).toBe(1);
  expect(listDropIndex(heights, 3, -500, 4)).toBe(0);
  expect([0, 1, 2, 3].map((i) => listShift(i, 0, 2, 44))).toEqual([0, -44, -44, 0]);
  expect([0, 1, 2, 3].map((i) => listShift(i, 3, 1, 44))).toEqual([0, 44, 44, 0]);
});

describe("keyboard overlap", () => {
  test("lifts only by the part of the view the keyboard covers", () => {
    expect(keyboardOverlap(800, null)).toBe(0);
    expect(keyboardOverlap(800, 500)).toBe(300);
    // The host already resized the window: nothing left to cover.
    expect(keyboardOverlap(500, 500)).toBe(0);
    expect(keyboardOverlap(480, 500)).toBe(0);
    // A taller IME (candidate bar) raises the inset.
    expect(keyboardOverlap(800, 456.4)).toBe(344);
  });
});

describe("cardRevealOffset", () => {
  test("leaves a visible card alone", () => {
    expect(cardRevealOffset({ y: 100, height: 80 }, 50, 400, 8)).toBeNull();
  });
  test("scrolls a card below the list into view", () => {
    expect(cardRevealOffset({ y: 2000, height: 80 }, 0, 400, 8)).toBe(1688);
  });
  test("scrolls a card above the list into view", () => {
    expect(cardRevealOffset({ y: 100, height: 80 }, 500, 400, 8)).toBe(92);
    expect(cardRevealOffset({ y: 2, height: 80 }, 500, 400, 8)).toBe(0);
  });
});
