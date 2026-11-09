import { expect, test } from "vitest";
import { chatRows, displayRows, mergeTimeline } from "./dispatcher-panel-logic";
import type { ChatItem } from "../shared/dispatcher";
import { lastOutputRow } from "./session-state";
import type { TailEntry } from "../shared/session-tail";

const at = (s: number) => new Date(Date.parse("2026-11-08T10:00:00.000Z") + s * 1000).toISOString();
const entry = (seq: number, type: string, text: string, s?: number): TailEntry => ({ seqStart: seq, seqEnd: seq, item: { type, text }, ...(s === undefined ? {} : { timestamp: at(s) }) });
const note = (id: string, s: number): ChatItem => ({ id, at: at(s), kind: "note", note: { taskId: id, projectId: "p", title: `Card ${id}`, kind: "question", detail: "Which DB?", at: at(s) } });

test("transcript entries and chat items interleave by time", () => {
  const transcript = [
    entry(1, "user_message", "Flowly board summary. Pass the projectId to every tool.\n\nProjects…", 0),
    entry(2, "assistant_message", "Ready.", 2),
    entry(3, "user_message", "Make a card for X", 10),
    // No timestamp: it stays right after the entry before it.
    entry(4, "assistant_message", "Done: card t9.", undefined),
    entry(5, "user_message", "Flowly board update (1 card):\n- \"Card n2\" [n2] …", 30),
    entry(6, "assistant_message", "n2 needs you.", 31),
  ];
  const items = [note("n2", 30), note("n1", 5), { id: "change", at: at(40), kind: "change", revision: 1, ids: [], cards: [] } as ChatItem];
  const rows = mergeTimeline(transcript, items);
  expect(rows.map((r) => (r.kind === "item" ? r.item.id : r.kind === "summary" ? "summary" : r.entry.item.text))).toEqual([
    "summary",
    "Ready.",
    "n1",
    "Make a card for X",
    "Done: card t9.",
    // The note batch message is left out: its note rows stand for it.
    "n2",
    "n2 needs you.",
    "change",
  ]);
  // Stable: the same input gives the same keys in the same order.
  expect(mergeTimeline(transcript, items).map((r) => r.key)).toEqual(rows.map((r) => r.key));
  // Ties keep the transcript first, and items with equal times keep their order.
  const tie = mergeTimeline([entry(1, "assistant_message", "a", 5)], [note("x", 5), note("y", 5)]);
  expect(tie.map((r) => r.key)).toEqual(["entry-1-assistant_message", "item-x", "item-y"]);
});

test("the change line stays at the end of the timeline, whatever its newest event time", () => {
  const change = { id: "change", at: at(1), kind: "change", revision: 1, ids: [], cards: [] } as ChatItem;
  const rows = mergeTimeline([entry(1, "assistant_message", "a", 0), entry(2, "assistant_message", "b", 20)], [change, note("n1", 10)]);
  expect(rows.map((r) => r.key)).toEqual(["entry-1-assistant_message", "item-n1", "entry-2-assistant_message", "item-change"]);
});

test("transcript runs between items are grouped like the session pane", () => {
  const rows = mergeTimeline(
    [entry(1, "reasoning", "think", 1), { seqStart: 2, seqEnd: 2, timestamp: at(2), item: { type: "tool_call", name: "flowly_list_cards", status: "completed" } }, entry(3, "assistant_message", "Hi", 3), entry(4, "reasoning", "more", 9)],
    [note("n1", 5)],
  );
  // The shared session transcript's rows: its own blocks, and the dispatcher's items as rows of their own.
  const shown = displayRows(rows);
  expect(shown.map((r) => r.kind)).toEqual(["activity", "entry", "extra", "activity"]);
  expect(shown[2].kind === "extra" && shown[2].item).toMatchObject({ kind: "item", item: { id: "n1" } });
  expect(new Set(shown.map((r) => r.key)).size).toBe(shown.length);
});

test("the board summary is one row of its own, and chatRows keeps item keys for the bell's jump", () => {
  const summary = entry(1, "user_message", "Flowly board summary. Pass the projectId to every tool.\n\nProjects…", 0);
  const shown = chatRows([summary, entry(2, "assistant_message", "Ready.", 2)], [note("n1", 5)]);
  expect(shown.map((r) => r.kind)).toEqual(["extra", "entry", "extra"]);
  expect(shown[0].kind === "extra" && shown[0].item).toEqual({ kind: "summary" });
  expect(shown[2].key).toBe("item-n1");
});

test("the live activity is the newest output row, not a note or the change line after it (DISPATCHER-SPEC §9.3)", () => {
  const change = { id: "change", at: at(1), kind: "change", revision: 1, ids: [], cards: [] } as ChatItem;
  const shown = chatRows([entry(1, "assistant_message", "Hi", 1), entry(2, "reasoning", "think", 3)], [note("n1", 5), change]);
  expect(shown.map((r) => r.kind)).toEqual(["entry", "activity", "extra", "extra"]);
  // While the agent runs, that activity block shows "Working" and no separate running line is added.
  expect(lastOutputRow(shown)).toBe(shown[1]);
  expect(lastOutputRow(shown.slice(0, 1))?.kind).toBe("entry");
  expect(lastOutputRow(shown.slice(2))).toBeUndefined();
});
