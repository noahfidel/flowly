import { expect, test } from "vitest";
import type { Project, Task } from "../shared/model";
import type { AttentionItem } from "../shared/attention";
import type { ChatItem } from "../shared/dispatcher";
import { afterMarkSeen, changeSummary, stableQueue, cardAsks, needsCount, needsQueue, stepAt, stepBarState, stepPosition, stepSession, stepStartTarget, updatedQueue, type ChangeItem } from "./step-through";

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

const change = (cards: Array<[string, string]>): ChangeItem => ({
  id: "change",
  at: at(100),
  kind: "change",
  revision: 3,
  ids: ["e1"],
  cards: cards.map(([taskId, projectId]) => ({ taskId, projectId, title: taskId, status: "todo", events: 1 })),
});

test("the updated queue is the changed cards in scope, kept apart from the need-you queue", () => {
  const changed = change([["x", "p"], ["y", "q"], ["z", "p"], ["x", "p"]]);
  expect(updatedQueue(changed, [], new Set(), inP)).toEqual(["x", "z"]);
  expect(updatedQueue(changed, [], new Set(), all)).toEqual(["x", "y", "z"]);
  expect(updatedQueue(null, [], new Set(), all)).toEqual([]);
  // A changed card never adds to the need-you count.
  expect(needsCount([], new Set(), all)).toBe(0);
});

test("the updated queue also holds the cards with an unread turn: after the changed cards, newest first, once each (Ruling, Noah 2026-11-09)", () => {
  const changed = change([["x", "p"], ["z", "p"]]);
  const items = [
    card("old", "p", 1, [{ key: "u:o:1" }]),
    card("new", "p", 9, [{ key: "u:n:1" }]),
    card("z", "p", 5, [{ key: "u:z:1" }]),
    card("asks", "p", 7, [{ key: "q:1" }]),
    card("read", "p", 8, [{ key: "u:r:1", dismissed: true }]),
    card("done", "p", 6, [{ key: "u:d:1" }]),
    card("away", "q", 3, [{ key: "u:w:1" }]),
  ];
  expect(updatedQueue(changed, items, new Set(["u:d:1"]), inP)).toEqual(["x", "z", "new", "old"]);
  expect(updatedQueue(null, items, new Set(), all)).toEqual(["new", "done", "z", "away", "old"]);
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

const ask = (signal: string, taskId: string, s: number, state: "open" | "answered" | "session_ended" = "open", askKind: "question_report" | "unread" = "question_report"): ChatItem => ({
  id: `ask-${signal}`,
  at: at(s),
  kind: "ask",
  signal,
  taskId,
  projectId: "p",
  title: taskId,
  state,
  askKind,
});

test("the card's pinned asks: its open asks newest first, then ended ones; answered and other cards' asks are not", () => {
  const items = [ask("1", "a", 1), ask("2", "a", 5), ask("3", "a", 3, "answered"), ask("4", "a", 9, "session_ended"), ask("5", "b", 7)];
  expect(cardAsks(items, "a").map((x) => x.signal)).toEqual(["2", "1", "4"]);
  expect(cardAsks(items, "a", new Set(["2"])).map((x) => x.signal)).toEqual(["1", "4"]);
  expect(cardAsks(undefined, "a")).toEqual([]);
});

test("a need-you card pins no unread turns: those are in N updated (Ruling, Noah 2026-11-09)", () => {
  const items = [ask("q", "a", 1), ask("u", "a", 9, "open", "unread"), ask("u2", "a", 5, "session_ended", "unread")];
  expect(cardAsks(items, "a").map((x) => x.signal)).toEqual(["q"]);
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

test("the bar: in the queue it shows i of N with the arrow; a card that left it differs by kind (Ruling, Noah 2026-11-11)", () => {
  const inQueue = { index: 1, total: 3, prev: "a", next: "c" };
  const left = { index: null, total: 2, prev: "a", next: "c" };
  const last = { index: null, total: 1, prev: "a", next: null };
  expect(stepBarState("needs", inQueue)).toEqual({ where: "position", next: "arrow" });
  expect(stepBarState("updated", inQueue)).toEqual({ where: "position", next: "arrow" });
  expect(stepBarState("needs", left)).toEqual({ where: "answered", next: "pill" });
  // Updates has nothing answered: reading a card's unread turn drops it mid-flip, so the plain arrow stays.
  expect(stepBarState("updated", left)).toEqual({ where: "none", next: "arrow" });
  expect(stepBarState("needs", last)).toEqual({ where: "caught-up", next: "done" });
  expect(stepBarState("updated", last)).toEqual({ where: "caught-up", next: "done" });
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

test("after Mark seen the walk goes to the next unseen card, or ends when none is left", () => {
  expect(afterMarkSeen(["a", "b", "c"], "b")).toBe("c");
  expect(afterMarkSeen(["a", "b", "c"], "c")).toBe("a");
  expect(afterMarkSeen(["a"], "a")).toBeNull();
});

test("a changed card's summary reads in plain words", () => {
  const t = (s: string, v?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v?.[k]));
  expect(
    changeSummary(
      [{ kind: "moved", status: "committed" }, { kind: "result" }, { kind: "session_finished" }, { kind: "question" }],
      t,
      (status) => status[0].toUpperCase() + status.slice(1),
    ),
  ).toBe("Moved to Committed · New result note · Session finished · New question");
  expect(changeSummary(undefined, t, (s) => s)).toBe("");
});
