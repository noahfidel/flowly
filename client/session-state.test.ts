import { describe, expect, test, vi } from "vitest";
import {
  sessionState,
  samePreviewTask,
  turnEventKey,
  openNativeSession,
  openNativeWorkspace,
  recentSessionOutput,
  pendingEchoes,
  groupTranscript,
  activitySummary,
} from "./session-state";
import type { BoardEvent } from "../shared/model";

const actor = {
  id: "a",
  status: "idle",
  pendingPermissions: [],
  lastUserMessageAt: null,
} as Parameters<typeof sessionState>[0];
const event = (action: string, at: string): BoardEvent => ({
  id: at,
  taskId: "t",
  actor: "system",
  agentId: "a",
  action,
  at,
});
test("session state distinguishes actual work, permission, error and archive", () => {
  expect(sessionState(actor).label).toBe("Ready");
  expect(sessionState({ ...actor, status: "initializing" }).label).toBe(
    "Starting",
  );
  expect(sessionState({ ...actor, status: "running" }).label).toBe("Running");
  expect(
    sessionState({ ...actor, status: "running", attentionReason: "permission" })
      .label,
  ).toBe("Waiting for approval");
  expect(sessionState({ ...actor, status: "error" }).label).toBe("Error");
  expect(sessionState({ ...actor, status: "closed" }).label).toBe("Closed");
  expect(sessionState({ ...actor, archivedAt: "now" }).label).toBe("Archived");
});

test("finished and ended signals never replace a newer turn or user message", () => {
  expect(sessionState({ ...actor, attentionReason: "finished" }).label).toBe(
    "Finished turn",
  );
  const ended = event("agent.turn_ended", "2026-10-14T00:10:00Z");
  expect(sessionState(actor, [ended]).label).toBe("Turn ended");
  expect(
    sessionState({ ...actor, lastUserMessageAt: "2026-10-14T00:11:00Z" }, [
      ended,
    ]).label,
  ).toBe("Idle");
  expect(
    sessionState(actor, [
      ended,
      event("agent.turn_started", "2026-10-14T00:12:00Z"),
    ]).label,
  ).toBe("Ready");
  expect(
    sessionState({ ...actor, status: "running", attentionReason: "finished" }, [
      ended,
    ]).label,
  ).toBe("Running");
});
test("native opening targets the exact session and host, and tolerates absent navigation", () => {
  const openAgent = vi.fn();
  expect(
    openNativeSession({ openAgent, openWorkspace: vi.fn() }, "a", "host"),
  ).toBe(true);
  expect(openAgent).toHaveBeenCalledWith({ agentId: "a", serverId: "host" });
  expect(openNativeSession(undefined, "a", "host")).toBe(false);
});
test("workspace opening targets the card's workspace and host, and tolerates absent navigation", () => {
  const openWorkspace = vi.fn();
  expect(
    openNativeWorkspace({ openAgent: vi.fn(), openWorkspace }, "ws", "host"),
  ).toBe(true);
  expect(openWorkspace).toHaveBeenCalledWith({ workspaceId: "ws", serverId: "host" });
  expect(openNativeWorkspace(undefined, "ws", "host")).toBe(false);
  // An older host without openWorkspace, or a card without a workspace id.
  expect(openNativeWorkspace({ openAgent: vi.fn() } as never, "ws", "host")).toBe(false);
  expect(openNativeWorkspace({ openAgent: vi.fn(), openWorkspace }, "", "host")).toBe(false);
  expect(openWorkspace).toHaveBeenCalledTimes(1);
});
test("preview extracts readable text with reader-facing author labels, without a display cap", () => {
  const output = recentSessionOutput([
    { item: { type: "tool_call" } },
    { item: { type: "assistant_message", text: "Done" } },
    { item: { type: "user_message", text: "Next" } },
  ]);
  expect(output.map((x) => [x.author, x.text])).toEqual([
    ["Agent", "Done"],
    ["You", "Next"],
  ]);
  expect(
    recentSessionOutput(
      Array.from({ length: 30 }, (_, n) => ({
        item: { type: "assistant_message", text: String(n) },
      })),
    ),
  ).toHaveLength(30);
});

test("a sent message keeps its row key from the local echo to the session's own record", () => {
  const echo = { messageId: "m-1", text: "Next" };
  const recorded = [{ seqStart: 41, item: { type: "user_message", text: "Next", clientMessageId: "m-1" } }];
  // Not recorded yet: the echo stays; recorded (as messageId or clientMessageId): it goes.
  expect(pendingEchoes([], [echo])).toEqual([echo]);
  expect(pendingEchoes(recorded, [echo])).toEqual([]);
  expect(pendingEchoes([{ item: { type: "user_message", messageId: "m-1" } }], [echo])).toEqual([]);
  // An agent message with the same ID does not count.
  expect(pendingEchoes([{ item: { type: "assistant_message", messageId: "m-1" } }], [echo])).toEqual([echo]);
  const before = recentSessionOutput([{ item: { type: "user_message", text: "Next", messageId: "m-1" } }]);
  const after = recentSessionOutput(recorded);
  expect(before[0].key).toBe(after[0].key);
  // Other entries keep their sequence key, and a repeated message ID cannot produce a duplicate key.
  const keys = recentSessionOutput([
    { seqStart: 1, item: { type: "assistant_message", text: "Hi" } },
    { seqStart: 2, item: { type: "user_message", text: "A", messageId: "x" } },
    { seqStart: 3, item: { type: "user_message", text: "B", messageId: "x" } },
  ]).map((e) => e.key);
  expect(keys).toEqual(["1-assistant_message", "x-user", "3-user_message"]);
});

test("consecutive thinking and tool calls merge into one activity block", () => {
  const entry = (key: string, author: string) => ({ key, author, text: key, kind: author, messageId: undefined, sender: undefined });
  const blocks = groupTranscript([
    entry("u", "You"),
    entry("t1", "Thinking"),
    entry("c1", "Tool"),
    entry("c2", "Tool"),
    entry("a", "Agent"),
    entry("c3", "Tool"),
  ]);
  expect(blocks.map((b) => b.kind)).toEqual(["entry", "activity", "entry", "activity"]);
  const first = blocks[1] as Extract<(typeof blocks)[number], { kind: "activity" }>;
  expect(first.key).toBe("activity-t1");
  expect(first.items.map((i) => i.key)).toEqual(["t1", "c1", "c2"]);
  expect(activitySummary(first)).toBe("Thought · 2 tool calls");
  expect(activitySummary({ thoughts: 0, tools: 1 })).toBe("1 tool call");
});

describe("session view memo keys", () => {
  const ev = (id: string, agentId: string, action: string) => ({ id, taskId: "t", actor: "system" as const, agentId, action, at: `2026-10-18T00:00:0${id.length}.000Z` });
  test("a lane change by the agent does not change the turn key; a new turn does", () => {
    const base = [ev("1", "a", "agent.turn_started")];
    const moved = [...base, { ...ev("22", "a", "status_changed"), from: "design" as const, to: "development" as const }];
    expect(turnEventKey(moved, "a")).toBe(turnEventKey(base, "a"));
    expect(turnEventKey([...moved, ev("333", "a", "agent.turn_ended")], "a")).not.toBe(turnEventKey(base, "a"));
    // Another session's turn is not this view's business.
    expect(turnEventKey([...base, ev("4444", "b", "agent.turn_ended")], "a")).toBe(turnEventKey(base, "a"));
  });
  test("only the card fields the view reads count", () => {
    const card = { id: "t", workspaceId: "w", archivedAt: null, title: "x" };
    expect(samePreviewTask(card, { ...card })).toBe(true);
    expect(samePreviewTask(card, { ...card, title: "y" })).toBe(false);
    expect(samePreviewTask(card, { ...card, archivedAt: "2026-10-18T00:00:00.000Z" })).toBe(false);
  });
});

test("a prompt from another agent is its own entry between two activity blocks", () => {
  const call = (seq: number) => ({ seqStart: seq, item: { type: "tool_call", name: "bash", status: "completed" } });
  const from = (seq: number, from: { id: string; title?: string; event: string }) => ({
    seqStart: seq,
    item: { type: "tool_call", name: "agent_message", status: "completed", text: "Hello\nthere", from },
  });
  const blocks = groupTranscript(
    recentSessionOutput([call(1), from(2, { id: "a1", title: " Dispatcher ", event: "message" }), call(3), from(4, { id: "a2", event: "finished" })]),
  );
  expect(blocks.map((b) => b.kind)).toEqual(["activity", "entry", "activity", "entry"]);
  const entries = blocks.flatMap((b) => (b.kind === "entry" ? [b.entry] : []));
  expect(entries[0]).toMatchObject({ kind: "agent-message", sender: "Dispatcher", text: "Hello\nthere" });
  expect(entries[1]).toMatchObject({ kind: "agent-message", sender: "a2" });
  expect(entries[0].author).not.toBe("Tool");
});
