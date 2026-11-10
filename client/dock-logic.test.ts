import { expect, test } from "vitest";
import type { ChatItem } from "../shared/dispatcher";
import { openAskCount, type AttentionItem } from "../shared/attention";
import {
  attentionSectionOpen,
  attentionSections,
  bellPress,
  dispatcherPress,
  dockButtonPress,
  dockLayoutShown,
  paneShown,
  showAttention,
  sideDockMinWidth,
  sideFits,
  splitSize,
  type Dock,
} from "./dock-logic";
import { chatWidth, minChatWidth } from "./geometry";

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

/* Dock layouts (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09): Single, Stack and Side by side. */

test("phones show Single whatever is stored; Side by side shows as Stack when the window has no room", () => {
  for (const layout of ["single", "stack", "side"] as const) expect(dockLayoutShown(layout, { compact: true, surfaceWidth: 2000 })).toBe("single");
  expect(dockLayoutShown("stack", { compact: false, surfaceWidth: 900 })).toBe("stack");
  expect(dockLayoutShown("single", { compact: false, surfaceWidth: 900 })).toBe("single");
  // Room: two 300-point panes and the divider, beside the dock's grip and the board's 300 points.
  const fits = sideDockMinWidth + 8 + 300;
  expect(sideDockMinWidth).toBe(2 * minChatWidth + 8);
  expect(sideFits(fits)).toBe(true);
  expect(sideFits(fits - 1)).toBe(false);
  expect(dockLayoutShown("side", { compact: false, surfaceWidth: fits })).toBe("side");
  expect(dockLayoutShown("side", { compact: false, surfaceWidth: fits - 1 })).toBe("stack");
  // An open card sidebar takes room too.
  expect(dockLayoutShown("side", { compact: false, surfaceWidth: 1400, reserved: 600 })).toBe("stack");
  expect(dockLayoutShown("side", { compact: false, surfaceWidth: 1600, reserved: 600 })).toBe("side");
});

test("Side by side widens the dock to two panes; the board keeps its 300 points and the card sidebar", () => {
  // A narrow stored width (or none) opens at the two-pane minimum; a wider one is kept.
  expect(chatWidth(0, 1600, 0, sideDockMinWidth)).toBe(sideDockMinWidth);
  expect(chatWidth(380, 1600, 0, sideDockMinWidth)).toBe(sideDockMinWidth);
  expect(chatWidth(900, 1600, 0, sideDockMinWidth)).toBe(900);
  expect(chatWidth(1500, 1600, 0, sideDockMinWidth)).toBe(1292);
  expect(chatWidth(1000, 1600, 600, sideDockMinWidth)).toBe(692);
  // Single and Stack keep the one-pane minimum.
  expect(chatWidth(120, 1600)).toBe(minChatWidth);
});

test("in Single the header buttons pick the pane; Cmd/Ctrl-click on the other one splits into Stack", () => {
  const single = { layout: "single", tab: "dispatcher" } as const;
  expect(dockButtonPress(single, "attention", false)).toEqual({ layout: "single", tab: "attention", focus: false });
  expect(dockButtonPress(single, "dispatcher", false)).toEqual({ layout: "single", tab: "dispatcher", focus: false });
  expect(dockButtonPress(single, "attention", true)).toEqual({ layout: "stack", tab: "attention", focus: false });
  // Cmd/Ctrl-click on the pane already shown changes nothing.
  expect(dockButtonPress(single, "dispatcher", true)).toEqual({ layout: "single", tab: "dispatcher", focus: false });
});

test("in a split both panes show; a press focuses one, Cmd/Ctrl-click returns to Single on it", () => {
  for (const layout of ["stack", "side"] as const) {
    const split = { layout, tab: "dispatcher" } as const;
    expect(dockButtonPress(split, "attention", false)).toEqual({ layout, tab: "attention", focus: true });
    expect(dockButtonPress(split, "dispatcher", false)).toEqual({ layout, tab: "dispatcher", focus: true });
    expect(dockButtonPress(split, "attention", true)).toEqual({ layout: "single", tab: "attention", focus: false });
    expect(dockButtonPress(split, "dispatcher", true)).toEqual({ layout: "single", tab: "dispatcher", focus: false });
    for (const pane of ["attention", "dispatcher"] as const) {
      expect(paneShown(layout, "dispatcher", pane)).toBe(true);
      expect(paneShown(layout, "attention", pane)).toBe(true);
    }
  }
  expect(paneShown("single", "attention", "attention")).toBe(true);
  expect(paneShown("single", "attention", "dispatcher")).toBe(false);
});

test("in a split the bell only shows Attention: it opens a minimized dock and never removes the chat", () => {
  const shown = { tab: "attention", open: true } as const;
  for (const now of [dispatcherOpen, minimized, shown, { tab: "attention", open: false } as const]) {
    expect(bellPress(now, null, "stack")).toEqual({ next: shown, back: null });
    expect(bellPress(now, dispatcherOpen, "side")).toEqual({ next: shown, back: null });
    expect(showAttention(now, null, "stack")).toEqual({ next: shown, back: null });
  }
  // Single keeps the toggle back to what showed before.
  expect(bellPress(dispatcherOpen, null, "single")).toEqual({ next: shown, back: dispatcherOpen });
  expect(bellPress(shown, dispatcherOpen, "single")).toEqual({ next: dispatcherOpen, back: null });
});

test("the toolbar's Dispatcher button: Single toggles the chat pane, a split toggles the dock", () => {
  expect(dispatcherPress(dispatcherOpen, "single")).toEqual(minimized);
  expect(dispatcherPress({ tab: "attention", open: true }, "single")).toEqual(dispatcherOpen);
  expect(dispatcherPress(minimized, "single")).toEqual(dispatcherOpen);
  expect(dispatcherPress({ tab: "attention", open: true }, "stack")).toEqual({ tab: "attention", open: false });
  expect(dispatcherPress({ tab: "attention", open: false }, "side")).toEqual(dispatcherOpen);
});

test("the divider keeps its share, clamped so each pane keeps its minimum; bad or unset shares split evenly", () => {
  expect(splitSize(0, 600, 160)).toBe(300);
  expect(splitSize(Number.NaN, 600, 160)).toBe(300);
  expect(splitSize(-1, 600, 160)).toBe(300);
  expect(splitSize(1.5, 600, 160)).toBe(300);
  expect(splitSize(0.25, 600, 160)).toBe(160);
  expect(splitSize(0.4, 600, 160)).toBe(240);
  expect(splitSize(0.99, 600, 160)).toBe(440);
  // No room for both minimums: half each; nothing measured yet: nothing.
  expect(splitSize(0.8, 200, 160)).toBe(100);
  expect(splitSize(0.5, 0, 160)).toBe(0);
});

test("Attention's sections: Needs you and Updates start open; bad stored values keep the default", () => {
  expect(attentionSectionOpen({}, "needs")).toBe(true);
  expect(attentionSectionOpen({}, "updates")).toBe(true);
  expect(attentionSectionOpen({ needs: false, updates: false }, "needs")).toBe(false);
  expect(attentionSectionOpen({ needs: false, updates: false }, "updates")).toBe(false);
  // A key left from the dropped Dismissed group is ignored.
  expect(attentionSectionOpen({ dismissed: true }, "needs")).toBe(true);
  for (const bad of [undefined, null, "open", 3, { needs: "no" }, { needs: 0 }, []])
    expect(attentionSectionOpen(bad as never, "needs")).toBe(true);
});
