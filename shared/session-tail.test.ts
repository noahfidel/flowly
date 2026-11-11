import { expect, test } from "vitest";
import {
  HISTORY_MAX,
  REFRESH_OVERLAP,
  TAIL_REASONING_MAX,
  TAIL_TEXT_MAX,
  canLoadEarlier,
  mergeNewer,
  mergeOlder,
  refreshCursor,
  slimTimeline,
  windowFromPage,
  type TailEntry,
  type TimelineWindow,
} from "./session-tail";

test("tail keeps what the UI reads and drops tool payloads", () => {
  const entries = slimTimeline([
    {
      seqStart: 7,
      timestamp: "2026-10-15T10:00:00Z",
      item: {
        type: "tool_call",
        name: "edit",
        status: "completed",
        callId: "c1",
        detail: { unifiedDiff: "x".repeat(100_000), content: "y".repeat(100_000) },
      },
    },
    { seqStart: 8, item: { type: "assistant_message", text: "Done", messageId: "m1" } },
    { item: { type: "user_message", text: "", clientMessageId: "u1" } },
    { item: null },
    { item: { text: "no type" } },
  ]);
  expect(entries).toEqual([
    { seqStart: 7, timestamp: "2026-10-15T10:00:00Z", item: { type: "tool_call", name: "edit", status: "completed", callId: "c1" } },
    { seqStart: 8, item: { type: "assistant_message", text: "Done", messageId: "m1" } },
    { item: { type: "user_message", text: "", clientMessageId: "u1" } },
  ]);
  expect(JSON.stringify(entries).length).toBeLessThan(400);
});

test("tail clips long messages and reasoning", () => {
  const [message, reasoning] = slimTimeline([
    { item: { type: "assistant_message", text: "a".repeat(TAIL_TEXT_MAX + 50) } },
    { item: { type: "reasoning", text: "r".repeat(TAIL_REASONING_MAX + 50) } },
  ]);
  expect(message.item.text).toHaveLength(TAIL_TEXT_MAX);
  expect(message.item.text!.endsWith("…")).toBe(true);
  expect(reasoning.item.text).toHaveLength(TAIL_REASONING_MAX);
});

const entry = (seq: number, text = `m${seq}`): TailEntry => ({ seqStart: seq, item: { type: "assistant_message", text } });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
const win = (entries: TailEntry[], hasOlder = true): TimelineWindow => ({
  epoch: "e",
  entries,
  hasOlder,
  startCursor: entries.length ? { epoch: "e", seq: entries[0].seqStart! } : null,
});

test("slim entries keep the sequence range", () => {
  expect(slimTimeline([{ seqStart: 4, seqEnd: 9, item: { type: "assistant_message", text: "x" } }])[0]).toMatchObject({ seqStart: 4, seqEnd: 9 });
});

test("a refresh re-reads the last few entries and replaces them in place", () => {
  const window = win(range(1, 20));
  const cursor = refreshCursor(window)!;
  expect(cursor).toEqual({ epoch: "e", seq: 20 - REFRESH_OVERLAP });
  // The streaming message 20 grew, and 21 arrived.
  const merged = mergeNewer(window, { epoch: "e", entries: [...range(13, 19), entry(20, "longer"), entry(21)] })!;
  expect(merged.entries.map((e) => e.seqStart)).toEqual(range(1, 21).map((e) => e.seqStart));
  expect(merged.entries.at(-2)!.item.text).toBe("longer");
  expect(merged.hasOlder).toBe(true);
  expect(refreshCursor(win([]))).toBeNull();
});

test("a rewritten or overflowing timeline asks for a full read", () => {
  const window = win(range(1, 5));
  expect(mergeNewer(window, { epoch: "other", entries: [] })).toBeNull();
  expect(mergeNewer(window, { epoch: "e", entries: [], reset: true })).toBeNull();
  expect(mergeNewer(window, { epoch: "e", entries: range(6, 105), hasNewer: true })).toBeNull();
  expect(mergeOlder(window, { epoch: "other", entries: [] }, window.startCursor!)).toBeNull();
  expect(windowFromPage({ entries: [] })).toBeNull();
  expect(windowFromPage({ entries: [], epoch: "e", reset: true })).toBeNull();
});

test("an older page goes in front without duplicates and carries the paging state", () => {
  const window = win(range(101, 150));
  const merged = mergeOlder(window, { epoch: "e", entries: range(1, 101), hasOlder: false, startCursor: { epoch: "e", seq: 1 } }, window.startCursor!)!;
  expect(merged.entries).toHaveLength(150);
  expect(merged.entries[0].seqStart).toBe(1);
  expect(merged).toMatchObject({ hasOlder: false, startCursor: { seq: 1 } });
  expect(canLoadEarlier(merged)).toBe(false);
  expect(canLoadEarlier(window)).toBe(true);
  expect(canLoadEarlier(win(range(1, HISTORY_MAX)))).toBe(false);
  expect(canLoadEarlier(undefined)).toBe(false);
});

test("an older page read for a window that was replaced meanwhile is dropped, not glued on", () => {
  const replaced = win(range(300, 600));
  expect(mergeOlder(replaced, { epoch: "e", entries: range(50, 99), hasOlder: true }, { epoch: "e", seq: 100 })).toBe(replaced);
});

const agentCall = (agentMessage: unknown, extra: Record<string, unknown> = {}) => ({
  seqStart: 3,
  item: { type: "tool_call", name: "agent_message", callId: "paseo-agent-message:1", status: "completed", error: null, agentMessage, detail: { type: "plain_text", text: "secret detail", icon: "bot" }, ...extra },
});

test("a prompt from another agent keeps its sender and text, nothing else from the detail", () => {
  const [entry] = slimTimeline([agentCall({ event: "message", sender: { id: "a1", serverId: "s", title: "Dispatcher" }, text: "Please fix X" })]);
  expect(entry.item).toEqual({ type: "tool_call", name: "agent_message", status: "completed", callId: "paseo-agent-message:1", text: "Please fix X", from: { id: "a1", title: "Dispatcher", event: "message" } });
  expect(JSON.stringify(entry)).not.toContain("secret detail");
  const [bare] = slimTimeline([agentCall({ event: "finished", sender: { id: "a2" }, text: "Done" })]);
  expect(bare.item.from).toEqual({ id: "a2", event: "finished" });
  const [long] = slimTimeline([agentCall({ event: "message", sender: { id: "a3" }, text: "x".repeat(TAIL_TEXT_MAX + 50) })]);
  expect(long.item.text!.length).toBe(TAIL_TEXT_MAX);
});

test("a plain tool call or a malformed agentMessage gets no from", () => {
  const entries = slimTimeline([
    { item: { type: "tool_call", name: "bash", status: "completed" } },
    agentCall("nope"),
    agentCall(null),
    agentCall({ event: "message", sender: {}, text: "hi" }),
    agentCall({ event: "message", sender: { id: "a" }, text: 5 }),
    agentCall({ event: "message", sender: { id: "a", title: 7 }, text: "ok" }),
  ]);
  expect(entries.map((e) => e.item.from)).toEqual([undefined, undefined, undefined, undefined, undefined, { id: "a", event: "message" }]);
  expect(entries.slice(0, 5).every((e) => e.item.text === undefined)).toBe(true);
});
