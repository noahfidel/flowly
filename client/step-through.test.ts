import { expect, test } from "vitest";
import type { Project, Task } from "../shared/model";
import type { AttentionItem } from "../shared/attention";
import type { ChatItem } from "../shared/dispatcher";
import { cardAsks, needsCount, needsQueue, stepAt, stepPosition, updatedQueue, type ChangeItem } from "./step-through";

/** The need-you and updated step-throughs in the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09). */

const at = (s: number) => new Date(Date.parse("2026-11-09T10:00:00.000Z") + s * 1000).toISOString();
const card = (id: string, projectId = "p", s = 0, parts: Array<{ key: string; dismissed?: boolean }> = [{ key: `q:${id}` }]): AttentionItem =>
  ({
    task: { id, projectId } as Task,
    project: { id: projectId } as Project,
    updatedAt: at(s),
    dismissed: false,
    parts: parts.map((p) => ({ key: p.key, kind: "question_report", agentId: "a", dismissed: !!p.dismissed })),
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

test("the merged need-you count is the bell's: every open ask (questions, blockers, permissions, errors, unread), never dismissed or resolved ones", () => {
  const items = [
    card("a", "p", 1, [{ key: "q:1" }, { key: "b:2" }, { key: "p:a:r" }, { key: "e:a:status" }, { key: "u:a:1" }]),
    card("b", "p", 2, [{ key: "q:3" }, { key: "q:4", dismissed: true }]),
    card("c", "q", 3, [{ key: "q:5" }]),
  ];
  expect(needsCount(items, new Set(["b:2"]), inP)).toBe(5);
  expect(needsCount(items, new Set(), all)).toBe(7);
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
  expect(updatedQueue(changed, inP)).toEqual(["x", "z"]);
  expect(updatedQueue(changed, all)).toEqual(["x", "y", "z"]);
  expect(updatedQueue(null, all)).toEqual([]);
  // A changed card never adds to the need-you count.
  expect(needsCount([], new Set(), all)).toBe(0);
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

const ask = (signal: string, taskId: string, s: number, state: "open" | "answered" | "session_ended" = "open"): ChatItem => ({
  id: `ask-${signal}`,
  at: at(s),
  kind: "ask",
  signal,
  taskId,
  projectId: "p",
  title: taskId,
  state,
  askKind: "question_report",
});

test("the card's pinned asks: its open asks newest first, then ended ones; answered and other cards' asks are not", () => {
  const items = [ask("1", "a", 1), ask("2", "a", 5), ask("3", "a", 3, "answered"), ask("4", "a", 9, "session_ended"), ask("5", "b", 7)];
  expect(cardAsks(items, "a").map((x) => x.signal)).toEqual(["2", "1", "4"]);
  expect(cardAsks(items, "a", new Set(["2"])).map((x) => x.signal)).toEqual(["1", "4"]);
  expect(cardAsks(undefined, "a")).toEqual([]);
});
