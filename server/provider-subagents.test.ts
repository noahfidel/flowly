import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { UNSUPPORTED_MS } from "./provider-subagents";
import { LocalDaemonUnavailable } from "./local-daemon";
import { ProviderSubagentService, ProviderSubagentsUnsupported, type ProviderSubagentClient } from "./provider-subagents";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const descriptor = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  parentAgentId: "a",
  parentSubagentId: null,
  provider: "claude",
  title: "sonnet-coder",
  description: "Fix the chip",
  status: "running",
  createdAt: "2026-11-16T10:00:00.000Z",
  updatedAt: "2026-11-16T10:01:00.000Z",
  toolCallId: id,
  cwd: "/secret/path",
  subtitle: "sonnet-coder · Sonnet 5.5 · Medium · 29.8k tokens",
  ...over,
});

type Fake = ProviderSubagentClient & { closed: number; calls: unknown[]; connected: boolean; features: Record<string, boolean> };

function fakeClient(over: Partial<ProviderSubagentClient> = {}): Fake {
  const fake: Fake = {
    closed: 0,
    calls: [],
    connected: true,
    features: { providerSubagents: true, projectedSubagentTimeline: true },
    getLastServerInfoMessage: () => ({ features: fake.features }),
    get isConnected() {
      return fake.connected;
    },
    listProviderSubagents: async (parent: string) => {
      fake.calls.push(["list", parent]);
      return { subagents: [descriptor("late", { createdAt: "2026-11-16T10:05:00.000Z" }), descriptor("early")], error: null };
    },
    fetchProviderSubagentTimeline: async (parent: string, subagent: string, options: unknown) => {
      fake.calls.push(["timeline", parent, subagent, options]);
      return {
        epoch: "e1",
        startCursor: { epoch: "e1", seq: 3 },
        endCursor: { epoch: "e1", seq: 4 },
        reset: false,
        staleCursor: false,
        gap: false,
        hasOlder: true,
        hasNewer: false,
        rows: [
          { seq: 3, timestamp: "2026-11-16T10:00:00.000Z", item: { type: "tool_call", name: "Bash", status: "completed", detail: { output: "big" } } },
          { seq: 5, seqStart: 4, seqEnd: 5, timestamp: "2026-11-16T10:00:01.000Z", item: { type: "assistant_message", text: "Done." } },
        ],
        error: null,
      };
    },
    close: async () => {
      fake.closed++;
      fake.connected = false;
    },
    ...over,
  };
  return fake;
}

async function setup(agentWorkspace = "w", connect?: () => Promise<ProviderSubagentClient>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-provider-subagents-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const paseo = {
    agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, workspaceId: agentWorkspace } }) }) },
  } as unknown as PaseoApi;
  const clients: Fake[] = [];
  let opens = 0;
  const open =
    connect ??
    (async () => {
      opens++;
      const client = fakeClient();
      clients.push(client);
      return client;
    });
  const service = new ProviderSubagentService(store, open);
  return { service, paseo, clients, opens: () => opens };
}

test("lists a card session's provider subagents, oldest first, with only the spec's fields", async () => {
  const x = await setup();
  const result = await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(result.unavailable).toBe(false);
  expect(result.subagents.map((s) => s.id)).toEqual(["early", "late"]);
  expect(result.subagents[0]).toEqual({
    id: "early",
    parentSubagentId: null,
    provider: "claude",
    title: "sonnet-coder",
    description: "Fix the chip",
    status: "running",
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:01:00.000Z",
    subtitle: "sonnet-coder · Sonnet 5.5 · Medium · 29.8k tokens",
  });
  await x.service.stop();
});

test("caps long descriptor strings", async () => {
  const x = await setup("w", async () =>
    fakeClient({ listProviderSubagents: async () => ({ subagents: [descriptor("s", { description: "d".repeat(5000), subtitle: "s".repeat(5000) })], error: null }) }),
  );
  const [s] = (await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).subagents;
  expect(s.description!.length).toBeLessThanOrEqual(500);
  expect(s.subtitle!.length).toBeLessThanOrEqual(300);
  await x.service.stop();
});

test("both reads refuse a session outside the card's workspace and unknown cards, without connecting", async () => {
  const x = await setup("other");
  await expect(x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).rejects.toThrow(/different workspace/);
  await expect(x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "tail" }, x.paseo)).rejects.toThrow(/different workspace/);
  await expect(x.service.list({ taskId: "missing", agentId: "a" }, x.paseo)).rejects.toThrow(/Task not found/);
  expect(x.opens()).toBe(0);
});

test("an unreachable daemon or an older Paseo: the list is empty and unavailable, the tail fails plainly, nothing is logged", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const error of [new LocalDaemonUnavailable("restarting"), new ProviderSubagentsUnsupported()]) {
    const x = await setup("w", async () => {
      throw error;
    });
    expect(await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).toEqual({ subagents: [], unavailable: true });
    const failure = await x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "tail" }, x.paseo).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).constructor).toBe(Error);
  }
  expect(log).not.toHaveBeenCalled();
});

test("an unexpected failure is logged and the chip still gets an empty list", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup("w", async () =>
    fakeClient({
      listProviderSubagents: async () => {
        throw new TypeError("boom");
      },
    }),
  );
  expect(await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).toEqual({ subagents: [], unavailable: true });
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0][0])).not.toMatch(/boom/);
  await x.service.stop();
});

test("tail returns a slim page with paging fields; rows without seqStart use their seq", async () => {
  const x = await setup();
  const page = await x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 50, mode: "tail" }, x.paseo);
  expect(page).toEqual({
    entries: [
      { seqStart: 3, seqEnd: 3, timestamp: "2026-11-16T10:00:00.000Z", item: { type: "tool_call", name: "Bash", status: "completed" } },
      { seqStart: 4, seqEnd: 5, timestamp: "2026-11-16T10:00:01.000Z", item: { type: "assistant_message", text: "Done." } },
    ],
    epoch: "e1",
    startCursor: { epoch: "e1", seq: 3 },
    hasOlder: true,
    hasNewer: false,
  });
  expect(x.clients[0].calls.at(-1)).toEqual(["timeline", "a", "s", expect.objectContaining({ direction: "tail", limit: 50 })]);
  await x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 20, mode: "before", cursor: { epoch: "e1", seq: 3 } }, x.paseo);
  expect(x.clients[0].calls.at(-1)).toEqual(["timeline", "a", "s", expect.objectContaining({ direction: "before", limit: 20, cursor: { epoch: "e1", seq: 3 } })]);
  await expect(x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 20, mode: "after" }, x.paseo)).rejects.toThrow(/cursor is required/);
  await x.service.stop();
});

test("a reset, stale cursor or gap asks the client to read the tail again", async () => {
  for (const flags of [{ reset: true }, { staleCursor: true }, { gap: true }]) {
    const base = fakeClient();
    const x = await setup("w", async () =>
      fakeClient({ fetchProviderSubagentTimeline: async (...args) => ({ ...(await base.fetchProviderSubagentTimeline(...args)), ...flags }) }),
    );
    const page = await x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "after", cursor: { epoch: "e1", seq: 1 } }, x.paseo);
    expect(page).toEqual({ entries: [], epoch: "e1", reset: true });
    await x.service.stop();
  }
});

test("a daemon error answer fails the tail with its plain message", async () => {
  const x = await setup("w", async () =>
    fakeClient({
      fetchProviderSubagentTimeline: async () => {
        throw new Error("Provider subagent not found");
      },
    }),
  );
  await expect(x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "tail" }, x.paseo)).rejects.toThrow("Provider subagent not found");
  await x.service.stop();
});

test("one connection: concurrent first calls share it, it is reused, closed after 30 s idle and on stop", async () => {
  vi.useFakeTimers();
  const x = await setup();
  await Promise.all([
    x.service.list({ taskId: "t", agentId: "a" }, x.paseo),
    x.service.list({ taskId: "t", agentId: "a" }, x.paseo),
    x.service.tail({ taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "tail" }, x.paseo),
  ]);
  expect(x.opens()).toBe(1);
  await vi.advanceTimersByTimeAsync(20_000);
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  // The idle timer restarts with every call.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(x.clients[0].closed).toBe(0);
  expect(x.opens()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(x.clients[0].closed).toBe(1);
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(x.opens()).toBe(2);
  await x.service.stop();
  expect(x.clients[1].closed).toBe(1);
});

test("a dropped connection is opened again on the next call", async () => {
  const x = await setup();
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  x.clients[0].connected = false;
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(x.opens()).toBe(2);
  expect(x.clients[0].closed).toBe(1);
  await x.service.stop();
});

test("a failed open is not cached", async () => {
  let attempts = 0;
  const x = await setup("w", async () => {
    attempts++;
    if (attempts === 1) throw new LocalDaemonUnavailable("restarting");
    return fakeClient();
  });
  expect((await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).unavailable).toBe(true);
  expect((await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).unavailable).toBe(false);
  await x.service.stop();
});

const tailInput = { taskId: "t", agentId: "a", subagentId: "s", limit: 10, mode: "tail" as const };

test("a daemon without the provider subagent features is not asked: the list is unavailable, nothing is logged", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup("w", async () => fakeClient({ getLastServerInfoMessage: () => ({ features: { projectedSubagentTimeline: true } }) }));
  expect(await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).toEqual({ subagents: [], unavailable: true });
  expect(log).not.toHaveBeenCalled();
  await x.service.stop();
  const none = await setup("w", async () => fakeClient({ getLastServerInfoMessage: () => null }));
  expect((await none.service.list({ taskId: "t", agentId: "a" }, none.paseo)).unavailable).toBe(true);
  await none.service.stop();
});

test("the list does not call the daemon without providerSubagents; the tail needs projectedSubagentTimeline", async () => {
  const client = fakeClient();
  client.features = { providerSubagents: false, projectedSubagentTimeline: false };
  const x = await setup("w", async () => client);
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  await expect(x.service.tail(tailInput, x.paseo)).rejects.toThrow(/cannot show provider subagents/);
  expect(client.calls).toEqual([]);
  await x.service.stop();
  const onlyList = fakeClient();
  onlyList.features = { providerSubagents: true };
  const y = await setup("w", async () => onlyList);
  expect((await y.service.list({ taskId: "t", agentId: "a" }, y.paseo)).unavailable).toBe(false);
  await expect(y.service.tail(tailInput, y.paseo)).rejects.toThrow(/cannot show provider subagents/);
  expect(onlyList.calls.map((c) => (c as unknown[])[0])).toEqual(["list"]);
  await y.service.stop();
});

test("an unsupported daemon is remembered for 5 minutes, then asked again", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup();
  x.clients.length = 0;
  let opens = 0;
  const service = new ProviderSubagentService(x.service.store, async () => {
    opens++;
    const c = fakeClient();
    c.features = {};
    return c;
  });
  await service.list({ taskId: "t", agentId: "a" }, x.paseo);
  await service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(opens).toBe(1);
  await vi.advanceTimersByTimeAsync(UNSUPPORTED_MS - 1000);
  await service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(opens).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  await service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(opens).toBe(2);
  expect(log).not.toHaveBeenCalled();
  await service.stop();
});

class DaemonRpcError extends Error {
  override name = "DaemonRpcError";
  userMessage = "Unknown request";
  constructor() {
    super("Unknown request requestType=agent.provider_subagents.list.request code=unknown");
  }
}

test("a daemon rpc error is expected: not logged, the tail shows its user message", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fail = async () => {
    throw new DaemonRpcError();
  };
  const x = await setup("w", async () => fakeClient({ listProviderSubagents: fail, fetchProviderSubagentTimeline: fail }));
  expect(await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).toEqual({ subagents: [], unavailable: true });
  const failure = await x.service.tail(tailInput, x.paseo).catch((e: unknown) => e);
  expect((failure as Error).message).toBe("Unknown request");
  expect(log).not.toHaveBeenCalled();
  await x.service.stop();
});

class DaemonConnectionError extends Error {
  override name = "DaemonConnectionError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

test("a request timeout keeps the shared connection; a lost connection drops it", async () => {
  let fail: Error | null = new DaemonConnectionError("Timeout", "DAEMON_REQUEST_TIMEOUT");
  const x = await setup("w", async () => {
    const c = fakeClient({
      listProviderSubagents: async () => {
        if (fail) throw fail;
        return { subagents: [] };
      },
    });
    x.clients.push(c);
    return c;
  });
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(x.clients).toHaveLength(1);
  expect(x.clients[0].closed).toBe(0);
  fail = new DaemonConnectionError("Transport not connected", "DAEMON_CONNECTION_LOST");
  await x.service.list({ taskId: "t", agentId: "a" }, x.paseo);
  expect(x.clients[0].closed).toBe(1);
  fail = null;
  expect((await x.service.list({ taskId: "t", agentId: "a" }, x.paseo)).unavailable).toBe(false);
  expect(x.clients).toHaveLength(2);
  await x.service.stop();
});
