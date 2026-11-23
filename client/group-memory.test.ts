import { beforeEach, describe, expect, test } from "vitest";
import { groupArrival, historyOf, placeOf, pruneGroups, rememberHistory, rememberPlace, rememberScroll, scrollOf } from "./group-memory";
import { emptyNavHistory, navAlive, recordLocation, type NavEntry } from "./nav-history";

/** Each board group remembers its own view for the app run (BOARD-GROUPS-SPEC §3, Per-group view state, ruling 2026-11-23). */

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("flowly.groupMemory")];
});

const card = (taskId: string, sessionId?: string): NavEntry => (sessionId === undefined ? { kind: "card", taskId } : { kind: "card", taskId, sessionId });
const board: NavEntry = { kind: "board" };

const tasks = [
  { id: "A", projectId: "p1", status: "development", archivedAt: null as string | null },
  { id: "B", projectId: "p2", status: "todo", archivedAt: null as string | null },
];
const projects = [{ id: "p1", archivedAt: null as string | null }, { id: "p2", archivedAt: null as string | null }];
const groups = [{ id: "g1" }, { id: "g2" }];
const aliveIn = (group: string, projectIds: string[], t = tasks, p = projects) => navAlive({ tasks: t, projects: p, groups, group: { id: group, projectIds } });

describe("the place each group was left on", () => {
  test("A open in group 1, B in group 2: each group returns to its own card, both ways", () => {
    rememberPlace("board", "h", "g1", card("A", "s1"));
    rememberPlace("board", "h", "g2", card("B"));
    expect(groupArrival(placeOf("h", "g1"), aliveIn("g1", ["p1"]), false, null)).toEqual({ kind: "restore", entry: card("A", "s1") });
    expect(groupArrival(placeOf("h", "g2"), aliveIn("g2", ["p2"]), false, null)).toEqual({ kind: "restore", entry: card("B") });
    // Leaving g2 on its bare board: returning shows the bare board.
    rememberPlace("board", "h", "g2", board);
    expect(groupArrival(placeOf("h", "g2"), aliveIn("g2", ["p2"]), false, null)).toEqual({ kind: "board" });
    expect(placeOf("h", "g1")).toEqual(card("A", "s1"));
  });

  test("hosts do not share places", () => {
    rememberPlace("board", "h1", "g1", card("A"));
    expect(placeOf("h2", "g1")).toBeUndefined();
  });

  test("a card that is gone, archived, finished, moved to another group, or in an archived project gives the normal board", () => {
    rememberPlace("board", "h", "g1", card("A"));
    const place = placeOf("h", "g1");
    const variants = [
      tasks.filter((t) => t.id !== "A"),
      tasks.map((t) => (t.id === "A" ? { ...t, archivedAt: "2026-11-20" } : t)),
      tasks.map((t) => (t.id === "A" ? { ...t, status: "done" } : t)),
      tasks.map((t) => (t.id === "A" ? { ...t, status: "cancelled" } : t)),
      tasks.map((t) => (t.id === "A" ? { ...t, projectId: "p2" } : t)),
    ];
    for (const t of variants) expect(groupArrival(place, aliveIn("g1", ["p1"], t), false, null)).toEqual({ kind: "board" });
    // The project moved to group 2: no longer a member of group 1.
    expect(groupArrival(place, aliveIn("g1", []), false, null)).toEqual({ kind: "board" });
    const archivedProject = projects.map((p) => (p.id === "p1" ? { ...p, archivedAt: "2026-11-20" } : p));
    expect(groupArrival(place, aliveIn("g1", ["p1"], tasks, archivedProject), false, null)).toEqual({ kind: "board" });
  });

  test("the chat page is a place on phones only; the desktop dock follows its own setting", () => {
    const chat: NavEntry = { kind: "dispatcher", groupId: "g1" };
    expect(groupArrival(chat, aliveIn("g1", ["p1"]), true, null)).toEqual({ kind: "restore", entry: chat });
    expect(groupArrival(chat, aliveIn("g1", ["p1"]), false, null)).toEqual({ kind: "board" });
  });

  test("the workspace panel never writes", () => {
    rememberPlace("panel", "h", "g1", card("A"));
    rememberHistory("panel", "h", "g1", recordLocation(emptyNavHistory, card("A")));
    rememberScroll("panel", "h", "g1", { x: 40 });
    expect(placeOf("h", "g1")).toBeUndefined();
    expect(historyOf("h", "g1")).toBeUndefined();
    expect(scrollOf("h", "g1")).toBeUndefined();
  });
});

describe("arrival order: remembered card, else the need-you open, else the bare board", () => {
  const isAlive = aliveIn("g2", ["p2"]);
  test("a remembered card wins over the need-you open", () => {
    expect(groupArrival(card("B", "s"), isAlive, false, { kind: "card", taskId: "X" })).toEqual({ kind: "restore", entry: card("B", "s") });
    expect(groupArrival(card("B"), isAlive, true, { kind: "dispatcher" })).toEqual({ kind: "restore", entry: card("B") });
  });
  test("with no remembered card (first visit, the bare board, or a dropped card) the need-you open runs", () => {
    expect(groupArrival(undefined, isAlive, false, { kind: "card", taskId: "X" })).toEqual({ kind: "auto", open: { kind: "card", taskId: "X" } });
    expect(groupArrival(board, isAlive, false, { kind: "dispatcher" })).toEqual({ kind: "auto", open: { kind: "dispatcher" } });
    expect(groupArrival(card("A"), isAlive, false, { kind: "dispatcher" })).toEqual({ kind: "auto", open: { kind: "dispatcher" } });
  });
  test("nothing remembered and nothing waiting: the bare board", () => {
    expect(groupArrival(undefined, isAlive, false, null)).toEqual({ kind: "board" });
  });
});

describe("history and scroll per group", () => {
  test("each group's history is kept as left", () => {
    const h1 = recordLocation(recordLocation(emptyNavHistory, board), card("A"));
    const h2 = recordLocation(emptyNavHistory, card("B"));
    rememberHistory("board", "h", "g1", h1);
    rememberHistory("board", "h", "g2", h2);
    expect(historyOf("h", "g1")).toBe(h1);
    expect(historyOf("h", "g2")).toBe(h2);
  });

  test("scroll round-trips per group and merges partial changes", () => {
    rememberScroll("board", "h", "g1", { x: 120, y: { todo: 300 } });
    rememberScroll("board", "h", "g1", { lane: "in_review" });
    rememberScroll("board", "h", "g2", { x: 0, y: {} });
    expect(scrollOf("h", "g1")).toEqual({ x: 120, y: { todo: 300 }, lane: "in_review" });
    expect(scrollOf("h", "g2")).toEqual({ x: 0, y: {} });
    expect(scrollOf("h", "g3")).toBeUndefined();
  });

  test("entries of deleted groups are dropped once the groups are known; other hosts' stay", () => {
    rememberPlace("board", "h", "g1", card("A"));
    rememberPlace("board", "h", "gone", card("B"));
    rememberHistory("board", "h", "gone", recordLocation(emptyNavHistory, card("B")));
    rememberScroll("board", "h", "gone", { x: 5 });
    rememberPlace("board", "other", "gone", card("B"));
    // Not known yet (no groups listed): nothing is dropped; the panel never prunes.
    pruneGroups("board", "h", []);
    pruneGroups("panel", "h", ["g1"]);
    expect(placeOf("h", "gone")).toEqual(card("B"));
    pruneGroups("board", "h", ["g1", "g2"]);
    expect(placeOf("h", "gone")).toBeUndefined();
    expect(historyOf("h", "gone")).toBeUndefined();
    expect(scrollOf("h", "gone")).toBeUndefined();
    expect(placeOf("h", "g1")).toEqual(card("A"));
    expect(placeOf("other", "gone")).toEqual(card("B"));
  });
});
