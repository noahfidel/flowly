import { describe, expect, test } from "vitest";
import type { Project, Task } from "../shared/model";
import type { AttentionItem } from "../shared/attention";
import { walkQueue, stableQueue, needsCount, needsQueue, stepAt, stepPosition, stepSession, stepStartTarget, needsStartAction, groupSwitchOpen, dispatcherInView, updatedQueue } from "./step-through";
import { dispatcherWaits } from "../shared/attention";
import { otherGroupNeeds } from "./board-groups";

/** The need-you and updated step-throughs in the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09). */

const at = (s: number) => new Date(Date.parse("2026-11-09T10:00:00.000Z") + s * 1000).toISOString();
const kinds: Record<string, string> = { q: "question_report", b: "blocker_report", p: "permission", e: "error", u: "unread" };
const card = (id: string, projectId = "p", s = 0, parts: Array<{ key: string; dismissed?: boolean; agentId?: string }> = [{ key: `q:${id}` }]): AttentionItem =>
  ({
    task: { id, projectId } as Task,
    project: { id: projectId } as Project,
    updatedAt: at(s),
    snoozed: { needs: false, updated: false },
    parts: parts.map((p) => ({ key: p.key, kind: kinds[p.key[0]], agentId: p.agentId ?? "a", dismissed: !!p.dismissed })),
  }) as unknown as AttentionItem;
const all = () => true;
const inP = (id: string) => id === "p";

test("the need-you queue lists the cards with open asks, newest first, in the board's scope", () => {
  const items = [card("old", "p", 1), card("new", "p", 9), card("mid", "p", 5), card("other", "q", 20)];
  expect(needsQueue(items, new Set(), inP)).toEqual(["new", "mid", "old"]);
  expect(needsQueue(items, new Set(), all)).toEqual(["other", "new", "mid", "old"]);
});

test("a card whose asks are all resolved or dismissed leaves the queue (answered elsewhere drops out live)", () => {
  const items = [card("a", "p", 1, [{ key: "q:a" }, { key: "p:a", dismissed: true }]), card("b", "p", 2, [{ key: "q:b" }])];
  expect(needsQueue(items, new Set(["q:b"]), all)).toEqual(["a"]);
  expect(needsQueue(items, new Set(["q:a", "q:b"]), all)).toEqual([]);
});

test("the need-you count is what waits on you (questions, blockers, permissions, errors), never unread turns, dismissed or resolved asks", () => {
  const items = [
    card("a", "p", 1, [{ key: "q:1" }, { key: "b:2" }, { key: "p:a:r" }, { key: "e:a:status" }, { key: "u:a:1" }]),
    card("b", "p", 2, [{ key: "q:3" }, { key: "q:4", dismissed: true }]),
    card("c", "q", 3, [{ key: "q:5" }]),
    card("d", "p", 4, [{ key: "u:d:1" }]),
  ];
  expect(needsCount(items, new Set(["b:2"]), inP)).toBe(4);
  expect(needsCount(items, new Set(), all)).toBe(6);
});

test("a card whose only open signal is an unread turn is not in the need-you queue (Ruling, Noah 2026-11-09)", () => {
  const items = [card("read-me", "p", 9, [{ key: "u:r:1" }]), card("ask", "p", 1, [{ key: "q:1" }, { key: "u:a:1" }])];
  expect(needsQueue(items, new Set(), all)).toEqual(["ask"]);
  // Its question answered, a card with an unread turn left drops out of need-you.
  expect(needsQueue(items, new Set(["q:1"]), all)).toEqual([]);
});

test("the updated queue holds only cards with an open unread turn: a change-line-only card is not in it (Ruling, Noah 2026-11-16)", () => {
  const items = [
    card("old", "p", 1, [{ key: "u:o:1" }]),
    card("new", "p", 9, [{ key: "u:n:1" }]),
    card("moved", "p", 5, []),
    card("asks", "p", 7, [{ key: "q:1" }]),
    card("read", "p", 8, [{ key: "u:r:1", dismissed: true }]),
    card("done", "p", 6, [{ key: "u:d:1" }]),
    card("away", "q", 3, [{ key: "u:w:1" }]),
  ];
  expect(updatedQueue(items, new Set(["u:d:1"]), inP)).toEqual(["new", "old"]);
  expect(updatedQueue(items, new Set(), all)).toEqual(["new", "done", "away", "old"]);
  expect(updatedQueue([], new Set(), all)).toEqual([]);
  // Unread turns never add to the need-you side, and a card with only an ask is not unread.
  expect(needsQueue(items, new Set(), inP)).toEqual(["asks"]);
  expect(needsCount(items, new Set(), inP)).toBe(1);
});

test("a step opens the session that waits: for updated the unread one, for need-you the one asking", () => {
  const item = card("a", "p", 1, [{ key: "q:1", agentId: "asker" }, { key: "u:x", agentId: "finished" }]);
  expect(stepSession(item, "updated", new Set())).toBe("finished");
  expect(stepSession(item, "needs", new Set())).toBe("asker");
  // Read meanwhile: nothing to open for updated (the card opens).
  expect(stepSession(item, "updated", new Set(["u:x"]))).toBeNull();
  // Two sessions waiting: need-you leaves the choice to the card, updated opens the first unread one.
  const two = card("b", "p", 1, [{ key: "q:1", agentId: "s1" }, { key: "p:s2:r", agentId: "s2" }, { key: "u:1", agentId: "s3" }, { key: "u:2", agentId: "s4" }]);
  expect(stepSession(two, "needs", new Set())).toBeNull();
  expect(stepSession(two, "updated", new Set())).toBe("s3");
  expect(stepSession(undefined, "updated", new Set())).toBeNull();
});

test("prev and next stop at the ends of the queue", () => {
  const queue = ["a", "b", "c"];
  expect(stepPosition(queue, stepAt(queue, "a"))).toEqual({ index: 0, total: 3, prev: null, next: "b" });
  expect(stepPosition(queue, stepAt(queue, "b"))).toEqual({ index: 1, total: 3, prev: "a", next: "c" });
  expect(stepPosition(queue, stepAt(queue, "c"))).toEqual({ index: 2, total: 3, prev: "b", next: null });
});

test("when the shown card drops out (answered), it stays shown and next is the card that took its place", () => {
  const before = ["a", "b", "c"];
  const step = stepAt(before, "b");
  expect(stepPosition(["a", "c"], step)).toEqual({ index: null, total: 2, prev: "a", next: "c" });
  expect(stepPosition(["a"], stepAt(["a", "b"], "b"))).toEqual({ index: null, total: 1, prev: "a", next: null });
  expect(stepPosition([], step)).toEqual({ index: null, total: 0, prev: null, next: null });
  // A card that moved up keeps its place by id.
  expect(stepPosition(["new", "a", "b", "c"], step)).toEqual({ index: 2, total: 4, prev: "a", next: "c" });
});

test("pressing the chip of the open step-through keeps the current card and place; the other kind starts at its first card", () => {
  const queue = ["a", "b", "c"];
  const open = stepAt(queue, "b");
  expect(stepStartTarget(open, "needs", "needs", queue, "b")).toEqual({ taskId: "b", keep: true });
  // Still the same card once it dropped out of the queue.
  expect(stepStartTarget(open, "needs", "needs", ["a", "c"], "b")).toEqual({ taskId: "b", keep: true });
  expect(stepStartTarget(open, "needs", "updated", ["x", "y"], "b")).toEqual({ taskId: "x", keep: false });
  expect(stepStartTarget(null, null, "needs", queue, null)).toEqual({ taskId: "a", keep: false });
  expect(stepStartTarget(null, null, "needs", [], null)).toBeNull();
  expect(stepStartTarget(open, "needs", "updated", [], "b")).toBeNull();
});

test("starting Updates on a card it counts starts there; on any other card it opens the queue's first (Ruling, Noah 2026-11-11)", () => {
  const queue = ["a", "b", "c"];
  expect(stepStartTarget(null, null, "updated", queue, "b")).toEqual({ taskId: "b", keep: false });
  expect(stepStartTarget(null, null, "updated", queue, "zzz")).toEqual({ taskId: "a", keep: false });
  expect(stepStartTarget(null, null, "updated", queue, null)).toEqual({ taskId: "a", keep: false });
  expect(stepStartTarget(stepAt(["b"], "b"), "needs", "updated", queue, "b")).toEqual({ taskId: "b", keep: false });
  expect(stepStartTarget(null, null, "updated", [], "b")).toBeNull();
  // Need you is unchanged: always its first card.
  expect(stepStartTarget(null, null, "needs", queue, "b")).toEqual({ taskId: "a", keep: false });
});

test("the walk keeps its order: marking or reading cards and new updates never move the current card's neighbours", () => {
  // live queue is recomputed on every poll: newest change first
  const walk = ["a", "b", "c", "d"];
  // On b; b is read (drops out of the live queue) and d changes again (moves to the front).
  const live = ["d", "a", "c"];
  expect(stepPosition(live, { taskId: "b", index: 1 }).next).toBe("a"); // the jump (this was the bug)
  const stable = stableQueue(walk, live, "b");
  expect(stable).toEqual(["a", "b", "c", "d"]);
  expect(stepPosition(stable, { taskId: "b", index: 1 })).toMatchObject({ prev: "a", next: "c" });
  // A card that changed meanwhile joins at the end; a card seen elsewhere leaves, unless it is the one shown.
  expect(stableQueue(["a", "b", "c"], ["c", "e", "a"], "b")).toEqual(["a", "b", "c", "e"]);
  expect(stableQueue(["a", "b", "c"], ["c"], "a")).toEqual(["a", "c"]);
});

test("the walk keeps the cards it visited, though visiting them reads them", () => {
  const visited = new Set<string>();
  // live [a,b,c]; start on a
  visited.add("a");
  let walk = stableQueue([], ["a", "b", "c"], "a", visited);
  expect(walk).toEqual(["a", "b", "c"]);
  // a is read (leaves the live queue); Next to b
  visited.add("b");
  walk = stableQueue(walk, ["b", "c"], "b", visited);
  expect(walk).toEqual(["a", "b", "c"]);
  expect(stepPosition(walk, { taskId: "b", index: 1 })).toMatchObject({ index: 1, total: 3, prev: "a", next: "c" });
  // Previous back to a: b is read meanwhile, a is not live any more
  walk = stableQueue(walk, ["c"], "a", visited);
  expect(walk).toEqual(["a", "b", "c"]);
  expect(stepPosition(walk, { taskId: "a", index: 0 })).toMatchObject({ prev: null, next: "b" });
  // a card read elsewhere (never visited) still leaves
  expect(stableQueue(["a", "b", "c"], ["c"], "a", new Set(["a"]))).toEqual(["a", "c"]);
});

// DISPATCHER-SPEC §9.4, Ruling (Noah, 2026-11-16): the shown group's dispatcher's own asks.
test("the need-you count adds the dispatcher's pending requests; the card queue is unchanged", () => {
  const items = [card("a", "p", 1), card("b", "p", 2, [{ key: "p:x:r1" }])];
  expect(needsCount(items, new Set(), inP, 2)).toBe(4);
  expect(needsCount(items, new Set(), inP)).toBe(2);
  expect(needsCount([], new Set(), inP, 1)).toBe(1);
  expect(needsQueue(items, new Set(), inP)).toEqual(["b", "a"]);
});

test("N need you opens the waiting dispatcher before any card, also while a card walk is open; otherwise it walks the cards", () => {
  const queue = ["a", "b"];
  const open = stepAt(queue, "b");
  expect(needsStartAction(1, null, null, queue, null)).toEqual({ kind: "dispatcher", shown: false });
  expect(needsStartAction(2, open, "needs", queue, "b")).toEqual({ kind: "dispatcher", shown: false });
  expect(needsStartAction(1, null, null, [], null)).toEqual({ kind: "dispatcher", shown: false });
  // The dock already shows the waiting dispatcher (a request it cannot answer, e.g. unguarded): the press walks the cards.
  expect(needsStartAction(1, null, null, queue, null, true)).toEqual({ kind: "card", taskId: "a", keep: false });
  expect(needsStartAction(1, open, "needs", queue, "b", true)).toEqual({ kind: "card", taskId: "b", keep: true });
  expect(needsStartAction(1, null, null, [], null, true)).toEqual({ kind: "dispatcher", shown: true });
  // Answered: the next press walks the cards as before.
  expect(needsStartAction(0, null, null, queue, null)).toEqual({ kind: "card", taskId: "a", keep: false });
  expect(needsStartAction(0, open, "needs", queue, "b")).toEqual({ kind: "card", taskId: "b", keep: true });
  expect(needsStartAction(0, null, null, [], null)).toBeNull();
  // The bar's position stays over the cards only.
  expect(stepPosition(queue, open)).toMatchObject({ index: 1, total: 2 });
});

test("dispatcherInView: the docked chat shows beside an open card on desktop; on a phone the chat page sits under an open card", () => {
  expect(dispatcherInView(false, true, false)).toBe(true);
  expect(dispatcherInView(false, true, true)).toBe(true);
  expect(dispatcherInView(false, false, true)).toBe(false);
  expect(dispatcherInView(true, true, false)).toBe(true);
  expect(dispatcherInView(true, true, true)).toBe(false);
  expect(dispatcherInView(true, false, false)).toBe(false);
});

// Ruling (Noah, 2026-11-16): N never claims nothing needs you while the shown group's dispatcher waits.
describe("N need you from the agent list", () => {
  const groups = [{ id: "g1" }, { id: "g2" }];
  const dispatcher = (id: string, group: string) => ({
    id,
    archivedAt: null,
    status: "idle",
    labels: { "flowly-dispatcher": "1", "flowly-dispatcher-group": group },
    pendingPermissions: [{ id: `r-${id}`, kind: "tool" }],
  });
  const none = new Set<string>();
  const waitsOf = (agents: ReturnType<typeof dispatcher>[], group: string) => dispatcherWaits(agents, groups).get(group) ?? 0;

  test("only the shown group's dispatcher waits, no card", () => {
    const waits = waitsOf([dispatcher("d1", "g1")], "g1");
    expect(needsCount([], none, all, waits)).toBe(1);
    const press = (compact: boolean, chatOpen: boolean, cardOpen: boolean) =>
      needsStartAction(waits, null, null, [], null, dispatcherInView(compact, chatOpen, cardOpen));
    expect(press(false, true, false)).toEqual({ kind: "dispatcher", shown: true });
    expect(press(false, false, false)).toEqual({ kind: "dispatcher", shown: false });
    expect(press(true, false, false)).toEqual({ kind: "dispatcher", shown: false });
    expect(press(true, true, false)).toEqual({ kind: "dispatcher", shown: true });
    expect(press(true, true, true)).toEqual({ kind: "dispatcher", shown: false });
  });

  test("only another group's dispatcher waits: the shown group has nothing, its own tab counts it", () => {
    const agents = [dispatcher("d2", "g2")];
    const waits = waitsOf(agents, "g1");
    expect(needsCount([], none, all, waits)).toBe(0);
    expect(needsStartAction(waits, null, null, [], null, true)).toBeNull();
    const all2 = dispatcherWaits(agents, groups);
    const projects = [{ id: "a", groupId: "g1", position: 0, createdAt: "x", archivedAt: null }, { id: "b", groupId: "g2", position: 0, createdAt: "x", archivedAt: null }];
    const count = (scope: (id: string) => boolean, gid: string) => needsCount([], none, scope, all2.get(gid) ?? 0);
    expect(otherGroupNeeds(groups, projects, "g1", count)).toEqual(new Map([["g2", 1]]));
  });

  test("the dispatcher and a card both wait", () => {
    const waits = waitsOf([dispatcher("d1", "g1")], "g1");
    const items = [card("a", "p", 1)];
    expect(needsCount(items, none, all, waits)).toBe(2);
    const queue = needsQueue(items, none, all);
    expect(needsStartAction(waits, null, null, queue, null, false)).toEqual({ kind: "dispatcher", shown: false });
    expect(needsStartAction(waits, null, null, queue, null, true)).toEqual({ kind: "card", taskId: "a", keep: false });
  });

  test("the dock shows the dispatcher while a walk is open on a card still queued: keep that card", () => {
    const waits = waitsOf([dispatcher("d1", "g1")], "g1");
    const queue = ["a", "b"];
    expect(needsStartAction(waits, stepAt(queue, "b"), "needs", queue, "b", true)).toEqual({ kind: "card", taskId: "b", keep: true });
  });
});

test("after a card's session is read, it leaves the updated count", () => {
  const unreadCard = (id: string) => card(id, "p", 1, [{ key: `u:${id}:1` }]);
  expect(updatedQueue([unreadCard("a"), unreadCard("b")], new Set(), all)).toEqual(["a", "b"]);
  expect(updatedQueue([unreadCard("b")], new Set(["u:a:1"]), all)).toEqual(["b"]);
});

describe("walkQueue", () => {
  test("the need-you walk holds its order when a new ask lands on another card", () => {
    const first = walkQueue(null, "needs", ["a", "b", "c"], "b");
    expect(first.ids).toEqual(["a", "b", "c"]);
    const next = walkQueue(first, "needs", ["d", "a", "b", "c"], "b");
    expect(next.ids).toEqual(["a", "b", "c", "d"]);
    expect(stepPosition(next.ids, { taskId: "b", index: 1 })).toMatchObject({ index: 1, total: 4, prev: "a", next: "c" });
  });

  test("an answered card drops out of the need-you walk: the card that took its place is next", () => {
    const walk = walkQueue(null, "needs", ["a", "b", "c", "d"], "b");
    const after = walkQueue(walk, "needs", ["d", "a", "c"], "b");
    expect(after.ids).toEqual(["a", "c", "d"]);
    expect(after.visited.size).toBe(0);
    const where = stepPosition(after.ids, { taskId: "b", index: 1 });
    expect(where.index).toBeNull();
    expect(where.next).toBe("c");
  });

  test("the updated walk keeps the shown and visited cards", () => {
    const first = walkQueue(null, "updated", ["a", "b", "c"], "a");
    const second = walkQueue(first, "updated", ["b", "c"], "b");
    expect(second.ids).toEqual(["a", "b", "c"]);
    const third = walkQueue(second, "updated", ["c", "e"], "c");
    expect(third.ids).toEqual(["a", "b", "c", "e"]);
  });

  test("a walk of the other kind starts fresh from the live order", () => {
    const upd = walkQueue(null, "updated", ["a", "b"], "a");
    expect(walkQueue(upd, "needs", ["z", "a"], "a").ids).toEqual(["z", "a"]);
  });
});

describe("switching the board to a group", () => {
  test("the group already shown opens nothing", () => {
    expect(groupSwitchOpen("a", "a", 2, ["x"])).toBeNull();
  });
  test("a group with nothing waiting opens nothing", () => {
    expect(groupSwitchOpen("a", "b", 0, [])).toBeNull();
  });
  test("opens the first card of its need-you queue", () => {
    expect(groupSwitchOpen("a", "b", 0, ["x", "y"])).toEqual({ kind: "card", taskId: "x" });
  });
  test("a waiting dispatcher opens first, even with cards queued", () => {
    expect(groupSwitchOpen("a", "b", 1, ["x"])).toEqual({ kind: "dispatcher" });
  });
  test("a waiting dispatcher with no cards queued opens its chat", () => {
    expect(groupSwitchOpen("a", "b", 3, [])).toEqual({ kind: "dispatcher" });
  });
});
