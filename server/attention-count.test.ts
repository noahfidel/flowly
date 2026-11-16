import { expect, test, vi } from "vitest";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { boardSchema, type Board } from "../shared/model";
import { readAttentionCount } from "./attention-count";
import { attentionFromSources } from "../shared/attention";
import { readAttentionCount as contract } from "../shared/rpc";
import { SUMMARIZER_LABELS } from "../shared/summary";

const at = "2026-10-23T04:00:00.000Z";
const project = { id: "p", archivedAt: null };
const task = (id: string) => ({ id, projectId: "p", workspaceId: id, archivedAt: null });
const agent = (id: string, extra = {}) => ({ id, workspaceId: id, status: "idle", archivedAt: null, ...extra }) as PaseoAgent;
const finished = { requiresAttention: true, attentionReason: "finished", attentionTimestamp: at };
const board = () => ({ projects: [{ ...project }], tasks: [task("a"), task("b"), task("c")], events: [] }) as unknown as Board;

function fixture(value = board(), agents = [agent("a", finished)], failReads = false) {
  const store = { read: vi.fn(async () => value) };
  const reads = { read: vi.fn(async () => {
    if (failReads) throw Error("invalid receipts");
    return { version: 1 as const, receipts: [] };
  }) };
  const list = vi.fn(async (_input: unknown) => ({ entries: agents.map((agent) => ({ agent })), pageInfo: {} }));
  return { store, reads, list, paseo: { agents: { list } } as unknown as PaseoApi };
}

test("count-only contract matches the board rule and never returns board/agent data", async () => {
  const agents = [agent("a", { status: "error" }), agent("b", { pendingPermissions: [{}] }), agent("c", { status: "running" })];
  const f = fixture(board(), agents);
  const result = await readAttentionCount(f.store, f.reads, f.paseo);
  expect(result).toEqual({ count: 2 });
  expect(result.count).toBe(attentionFromSources({ board: board(), agents, receipts: [], readUnavailable: false })!.length);
  expect(contract.output.parse(result)).toEqual(result);
  expect(() => contract.input.parse({ taskId: "a" })).toThrow();
  expect(() => contract.output.parse({ count: -1 })).toThrow();
  expect(() => contract.output.parse({ count: 1, tasks: [] })).toThrow();
});

test("all SDK pages are counted and summarizers/archived scopes are excluded", async () => {
  const f = fixture();
  const b = board();
  b.tasks[2].archivedAt = at;
  f.store.read.mockResolvedValue(b);
  f.list.mockResolvedValueOnce({ entries: [{ agent: agent("a", { status: "error" }) }], pageInfo: { nextCursor: "next" } } as never)
    .mockResolvedValueOnce({ entries: [{ agent: agent("b", { status: "error" }) }, { agent: agent("c", { status: "error" }) },
      { agent: agent("a", { status: "error", labels: SUMMARIZER_LABELS }) }], pageInfo: {} });
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 2 });
  expect(f.list).toHaveBeenNthCalledWith(2, { filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor: "next" } });
  b.projects[0].archivedAt = at;
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 0 });
});

test("receipt failures suppress only unread; errors, questions and permissions remain", async () => {
  const f = fixture(board(), [agent("a", finished), agent("b", { pendingPermissions: [{ id: "ask", kind: "question" }] }),
    agent("c", { status: "error" })], true);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 2 });
  f.list.mockRejectedValueOnce(Error("SDK unavailable"));
  await expect(readAttentionCount(f.store, f.reads, f.paseo)).rejects.toThrow("SDK unavailable");
  f.store.read.mockRejectedValueOnce(Error("board unavailable"));
  await expect(readAttentionCount(f.store, f.reads, f.paseo)).rejects.toThrow("board unavailable");
});

test("dismissal boundaries retain parity; every request reads fresh", async () => {
  const asking = (request: string) => agent("a", { pendingPermissions: [{ id: request, kind: "tool" }] });
  const f = fixture(board(), [asking("r1")]);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 1 });
  const b = board();
  const item = attentionFromSources({ board: b, agents: [asking("r1")], receipts: [], readUnavailable: false })![0];
  b.attentionDismissals = [{ taskId: "a", needs: { signals: item.signals, snoozedAt: at } }];
  f.store.read.mockResolvedValue(b);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 0 });
  f.list.mockResolvedValue({ entries: [{ agent: asking("r2") }], pageInfo: {} });
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 1 });
  expect(f.store.read).toHaveBeenCalledTimes(3);
});

test("the badge follows per-list Snooze: Updates snoozed keeps the count, Needs you snoozed drops it, a legacy record drops it", async () => {
  // Card a waits on a request; card b has a finished turn (Updates) and an error (Needs you) on two sessions.
  const agents = [agent("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] }), agent("b", finished), { ...agent("b2", { status: "error" }), workspaceId: "b" } as PaseoAgent];
  const f = fixture(board(), agents);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 2 });
  const items = attentionFromSources({ board: board(), agents, receipts: [], readUnavailable: false })!;
  const keys = (id: string, prefix: string) => items.find((i) => i.task.id === id)!.signals.filter((s) => s.startsWith(prefix));
  const b = board();
  // Updates snoozed: the badge (need-you only) is unchanged.
  b.attentionDismissals = [{ taskId: "b", updated: { signals: keys("b", "u:"), snoozedAt: at } }];
  f.store.read.mockResolvedValue(b);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 2 });
  // Needs you snoozed on b: its error leaves the count.
  b.attentionDismissals = [{ taskId: "b", needs: { signals: keys("b", "e:"), snoozedAt: at } }];
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 1 });
  // A legacy record (one flat set) is snoozed in both lists.
  b.attentionDismissals = boardSchema.shape.attentionDismissals.parse([{ taskId: "a", signals: keys("a", "p:"), dismissedAt: at }]);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 1 });
});

test("the badge counts what waits on you, not unread turns (need you; Ruling, Noah 2026-11-09)", async () => {
  const f = fixture(board(), [agent("a", finished), agent("b", { pendingPermissions: [{ id: "r", kind: "tool" }] }), agent("c", { status: "error" })]);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 2 });
  f.list.mockResolvedValue({ entries: [{ agent: agent("a", finished) }], pageInfo: {} });
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 0 });
});

// DISPATCHER-SPEC §9.4, Ruling (Noah, 2026-11-16): the badge is global, so every group's dispatcher's requests count.
test("the badge adds each pending request of every group's dispatcher, from the same agent list", async () => {
  const b = { ...board(), groups: [{ id: "g1" }, { id: "g2" }] } as unknown as Board;
  const dispatcher = (id: string, group: string, pending: unknown[], extra = {}) =>
    agent(id, { labels: { "flowly-dispatcher": "1", "flowly-dispatcher-group": group }, pendingPermissions: pending, ...extra });
  const agents = [
    agent("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] }),
    dispatcher("d1", "g1", [{ id: "c1", kind: "tool" }, { id: "c2", kind: "question" }]),
    dispatcher("d2", "g2", [{ id: "c3", kind: "tool" }]),
    dispatcher("d3", "g2", [], { status: "closed" }),
  ];
  const f = fixture(b, agents);
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 4 });
  expect(f.list).toHaveBeenCalledTimes(1);
  // A board without groups (or a dispatcher of a deleted group) adds nothing.
  f.store.read.mockResolvedValue(board());
  expect(await readAttentionCount(f.store, f.reads, f.paseo)).toEqual({ count: 1 });
});
