import { expect, test } from "vitest";
import type { ChatItem } from "../shared/dispatcher";
import { openAskCount, type AttentionItem } from "../shared/attention";
import { attentionSections, bellPress, showAttention, type Dock } from "./dock-logic";

/** The left dock's two tabs and the bell (DISPATCHER-SPEC §9.3, §9.4; Ruling, Noah 2026-11-09). */

const dispatcherOpen: Dock = { tab: "dispatcher", open: true };
const minimized: Dock = { tab: "dispatcher", open: false };

test("the bell opens the dock on Attention and a second press returns to the tab shown before", () => {
  const first = bellPress(dispatcherOpen, null);
  expect(first).toEqual({ next: { tab: "attention", open: true }, back: dispatcherOpen });
  expect(bellPress(first.next, first.back)).toEqual({ next: dispatcherOpen, back: null });
});

test("the bell un-minimizes the dock; pressed again it minimizes it again", () => {
  const first = bellPress(minimized, null);
  expect(first.next).toEqual({ tab: "attention", open: true });
  expect(bellPress(first.next, first.back)).toEqual({ next: minimized, back: null });
  // Minimized while on the Attention tab: the second press minimizes it on that tab.
  const onAttention = bellPress({ tab: "attention", open: false }, null);
  expect(onAttention.next).toEqual({ tab: "attention", open: true });
  expect(bellPress(onAttention.next, onAttention.back).next).toEqual({ tab: "attention", open: false });
});

test("with Attention picked by hand (nothing to return to), the bell goes to the Dispatcher tab", () => {
  expect(bellPress({ tab: "attention", open: true }, null)).toEqual({ next: dispatcherOpen, back: null });
});

test("opening Attention from elsewhere (overview, shortcut target, notification) never toggles it closed", () => {
  const shown = { tab: "attention", open: true } as const;
  expect(showAttention(shown, dispatcherOpen)).toEqual({ next: shown, back: dispatcherOpen });
  expect(showAttention(minimized, null)).toEqual({ next: shown, back: minimized });
});

const at = (s: number) => new Date(Date.parse("2026-11-09T10:00:00.000Z") + s * 1000).toISOString();
const ask = (signal: string, s: number, state: "open" | "answered" | "dismissed" | "session_ended" = "open"): ChatItem => ({
  id: `ask-${signal}`,
  at: at(s),
  kind: "ask",
  signal,
  taskId: `t-${signal}`,
  projectId: "p",
  title: `Card ${signal}`,
  state,
  askKind: "question_report",
});
const change = (cards: number): ChatItem => ({
  id: "change",
  at: at(100),
  kind: "change",
  revision: 1,
  ids: [],
  cards: Array.from({ length: cards }, (_, i) => ({ taskId: `c${i}`, projectId: "p", title: `Changed ${i}`, status: "todo", events: 1 })),
});
const note: ChatItem = { id: "n1", at: at(1), kind: "note", note: { taskId: "t", projectId: "p", title: "Card", kind: "result", detail: "", at: at(1) } };

test("Needs you lists the open asks newest first, then the ended ones; answered and dismissed asks are not in it", () => {
  const items = [note, ask("a", 1), ask("b", 5), ask("c", 3, "answered"), ask("d", 4, "dismissed"), ask("e", 9, "session_ended")];
  const sections = attentionSections(items);
  expect(sections.needs.map((x) => x.signal)).toEqual(["b", "a", "e"]);
  expect(sections.open).toBe(2);
  expect(sections.updates).toBeNull();
});

test("an ask answered from this client leaves Needs you before the list catches up", () => {
  expect(attentionSections([ask("a", 1), ask("b", 2)], new Set(["a"])).needs.map((x) => x.signal)).toEqual(["b"]);
});

test("Updates holds the changed cards, is hidden when nothing changed, and never counts toward the bell", () => {
  const withChanges = attentionSections([ask("a", 1), change(3)]);
  expect(withChanges.updates?.cards).toHaveLength(3);
  expect(withChanges.open).toBe(1);
  expect(attentionSections([ask("a", 1), change(0)]).updates).toBeNull();
  expect(attentionSections(undefined)).toEqual({ needs: [], updates: null, open: 0 });
  // The bell's count is per open signal of the cards in Attention; changed cards are not attention items at all.
  const item = { parts: [{ key: "a", dismissed: false }] } as unknown as AttentionItem;
  expect(openAskCount([item])).toBe(1);
});
