import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SessionTailService } from "./session-tail";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(agentWorkspace: string | null, refreshed = "w") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-tail-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const calls: unknown[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "a", workspaceId: refreshed } }),
        timeline: {
          refetch: async (options: unknown) => {
            calls.push(options);
            return {
              agent: agentWorkspace ? { id: "a", workspaceId: agentWorkspace } : null,
              entries: [{ seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed", detail: { content: "big" } } }],
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  return { service: new SessionTailService(store), paseo, calls };
}

test("returns the slim projected tail of a card session", async () => {
  const x = await setup("w");
  const result = await x.service.tail({ taskId: "t", agentId: "a", limit: 35 }, x.paseo);
  expect(result.entries).toEqual([{ seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed" } }]);
  expect(x.calls).toEqual([{ direction: "tail", limit: 35, projection: "projected" }]);
});

test("refuses sessions of another workspace and unknown cards", async () => {
  const x = await setup("other");
  await expect(x.service.tail({ taskId: "t", agentId: "a", limit: 5 }, x.paseo)).rejects.toThrow(/different workspace/);
  // Without an agent in the timeline response, the refreshed snapshot decides.
  const y = await setup(null, "other");
  await expect(y.service.tail({ taskId: "t", agentId: "a", limit: 5 }, y.paseo)).rejects.toThrow(/different workspace/);
  const z = await setup(null, "w");
  await expect(z.service.tail({ taskId: "t", agentId: "a", limit: 5 }, z.paseo)).resolves.toBeTruthy();
  await expect(z.service.tail({ taskId: "missing", agentId: "a", limit: 5 }, z.paseo)).rejects.toThrow(/Task not found/);
});

test("sessions.tail still refuses non-card agents other than the dispatcher", async () => {
  // The card path: a session outside the card's workspace (here the dispatcher's) is refused.
  const card = await setup("dw");
  await expect(card.service.tail({ taskId: "t", agentId: "a", limit: 5 }, card.paseo)).rejects.toThrow(/different workspace/);
  // The dispatcher path: only the stored dispatcher in its stored workspace.
  const x = await setup("dw");
  // Per group: the group's own stored session only.
  x.service.dispatcher = async (groupId) => (groupId === "g1" ? { agentId: "a", workspaceId: "dw" } : { agentId: "b", workspaceId: "dw" });
  await expect(x.service.dispatcherTail({ groupId: "g1", agentId: "a", limit: 5 }, x.paseo)).resolves.toMatchObject({ entries: [expect.anything()] });
  await expect(x.service.dispatcherTail({ groupId: "g1", agentId: "other", limit: 5 }, x.paseo)).rejects.toThrow(/not the dispatcher/i);
  await expect(x.service.dispatcherTail({ groupId: "g2", agentId: "a", limit: 5 }, x.paseo)).rejects.toThrow(/not the dispatcher/i);
  // The stored id in another workspace (a moved or replaced session) is refused too.
  x.service.dispatcher = async () => ({ agentId: "a", workspaceId: "elsewhere" });
  await expect(x.service.dispatcherTail({ groupId: "g1", agentId: "a", limit: 5 }, x.paseo)).rejects.toThrow(/different workspace/);
  // No dispatcher yet.
  x.service.dispatcher = async () => null;
  await expect(x.service.dispatcherTail({ groupId: "g1", agentId: "a", limit: 5 }, x.paseo)).rejects.toThrow(/not the dispatcher/i);
});

/** A fake projected timeline of `count` one-seq entries; `users` are the seqs of user messages. */
function timeline(count: number, users: number[], epoch = "e1") {
  const all = Array.from({ length: count }, (_, i) => {
    const seq = i + 1;
    return { seqStart: seq, seqEnd: seq, item: users.includes(seq) ? { type: "user_message", text: `u${seq}` } : { type: "tool_call", name: "run", status: "completed", detail: { output: "x".repeat(50) } } };
  });
  const window = (entries: typeof all, hasOlder: boolean, hasNewer: boolean) => ({
    agent: { id: "a", workspaceId: "w" },
    epoch,
    entries,
    startCursor: entries.length ? { epoch, seq: entries[0].seqStart } : null,
    endCursor: entries.length ? { epoch, seq: entries.at(-1)!.seqEnd } : null,
    hasOlder,
    hasNewer,
    reset: false,
    staleCursor: false,
  });
  return async (options: { direction: string; limit: number; cursor?: { seq: number } }) => {
    if (options.direction === "tail") {
      const entries = all.slice(-options.limit);
      return window(entries, all.length > entries.length, false);
    }
    if (options.direction === "before") {
      const older = all.filter((e) => e.seqStart < options.cursor!.seq);
      const entries = older.slice(-options.limit);
      return window(entries, older.length > entries.length, true);
    }
    const newer = all.filter((e) => e.seqEnd > options.cursor!.seq);
    const entries = newer.slice(0, options.limit);
    return window(entries, true, newer.length > entries.length);
  };
}

async function pagingSetup(read: (options: never) => Promise<unknown>) {
  const x = await setup("w");
  const calls: unknown[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "a", workspaceId: "w" } }),
        timeline: {
          refetch: async (options: never) => {
            calls.push(options);
            return read(options);
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  return { service: x.service, paseo, calls };
}

test("turn mode pages back to the latest user message and stops there", async () => {
  const x = await pagingSetup(timeline(450, [40, 200]) as never);
  const result = await x.service.tail({ taskId: "t", agentId: "a", limit: 100, mode: "turn" }, x.paseo);
  expect(result.entries[0]).toMatchObject({ seqStart: 200, item: { type: "user_message" } });
  expect(result.entries).toHaveLength(251);
  expect(result.entries[1].item).toEqual({ type: "tool_call", name: "run", status: "completed" });
  expect(result).toMatchObject({ epoch: "e1", hasOlder: true, startCursor: { epoch: "e1", seq: 200 } });
  expect(x.calls).toEqual([
    { direction: "tail", limit: 100, projection: "projected" },
    { direction: "before", cursor: { epoch: "e1", seq: 351 }, limit: 100, projection: "projected" },
    { direction: "before", cursor: { epoch: "e1", seq: 251 }, limit: 100, projection: "projected" },
  ]);
});

test("turn mode is capped when no user message is near", async () => {
  const x = await pagingSetup(timeline(1000, [5]) as never);
  const result = await x.service.tail({ taskId: "t", agentId: "a", limit: 100, mode: "turn", maxEntries: 250 }, x.paseo);
  expect(result.entries).toHaveLength(250);
  expect(result.entries[0].seqStart).toBe(751);
  expect(result).toMatchObject({ hasOlder: true, startCursor: { seq: 751 } });
  // A short session: everything, nothing older.
  const y = await pagingSetup(timeline(30, []) as never);
  const short = await y.service.tail({ taskId: "t", agentId: "a", limit: 100, mode: "turn" }, y.paseo);
  expect(short.entries).toHaveLength(30);
  expect(short.hasOlder).toBe(false);
});

test("before and after read one page next to the cursor; a stale cursor asks for a reload", async () => {
  const x = await pagingSetup(timeline(300, []) as never);
  const older = await x.service.tail({ taskId: "t", agentId: "a", limit: 100, mode: "before", cursor: { epoch: "e1", seq: 201 } }, x.paseo);
  expect(older.entries.map((e) => e.seqStart)).toEqual(Array.from({ length: 100 }, (_, i) => 101 + i));
  expect(older.hasOlder).toBe(true);
  const newer = await x.service.tail({ taskId: "t", agentId: "a", limit: 100, mode: "after", cursor: { epoch: "e1", seq: 295 } }, x.paseo);
  expect(newer.entries.map((e) => e.seqStart)).toEqual([296, 297, 298, 299, 300]);
  await expect(x.service.tail({ taskId: "t", agentId: "a", limit: 5, mode: "after" }, x.paseo)).rejects.toThrow(/cursor is required/);
  const stale = await pagingSetup((async () => ({ agent: { id: "a", workspaceId: "w" }, epoch: "e2", entries: [], staleCursor: true })) as never);
  await expect(stale.service.tail({ taskId: "t", agentId: "a", limit: 5, mode: "after", cursor: { epoch: "e1", seq: 3 } }, stale.paseo)).resolves.toEqual({ entries: [], epoch: "e2", reset: true });
});
