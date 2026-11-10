import { expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { PaseoAgent, PaseoAgentUpdate } from "@getpaseo/client";
import { applyAgentUpdates, createChangedReader } from "./queries";
import { applyBoardPatch, readBoardDelta } from "./board-read";
import { BoardDeltas } from "../server/board-delta";
import { SUMMARIZER_LABELS } from "../shared/summary";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => null, useRpc: () => null }));

const key = ["flowly", "fixture"] as const;
/** Runs one fetch the way react-query does: the result becomes the key's next data update. */
async function poll<T>(client: QueryClient, read: ReturnType<typeof createChangedReader>, fetch: (etag?: string) => Promise<{ etag: string; value?: T }>) {
  const value = await read(client, key, fetch);
  client.setQueryData(key, value);
  return value;
}

test("an unchanged read keeps the cached object and sends the etag", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  const board = { tasks: [1, 2] };
  const fetch = vi.fn(async (etag?: string) => (etag === "e1" ? { etag: "e1" } : { etag: "e1", value: board }));
  expect(await poll(client, read, fetch)).toBe(board);
  expect(fetch).toHaveBeenLastCalledWith(undefined, "first-read");
  expect(await poll(client, read, fetch)).toBe(board);
  expect(fetch).toHaveBeenLastCalledWith("e1", undefined);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("a foreign write to the key forces a full read", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  const fetch = vi.fn(async (etag?: string) => (etag === "e1" ? { etag: "e1" } : { etag: "e1", value: { v: "server" } }));
  await poll(client, read, fetch);
  // e.g. an optimistic update that the server never accepted
  client.setQueryData(key, { v: "optimistic" });
  expect(await poll(client, read, fetch)).toEqual({ v: "server" });
  expect(fetch).toHaveBeenLastCalledWith(undefined, "cache-replaced");
});

test("a write while an etag read is in flight is not kept", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  let calls = 0;
  const fetch = vi.fn(async (etag?: string) => {
    calls++;
    if (etag) {
      client.setQueryData(key, { v: "optimistic" });
      return { etag: "e1" };
    }
    return { etag: "e1", value: { v: `server-${calls}` } };
  });
  await poll(client, read, fetch);
  expect(await poll(client, read, fetch)).toEqual({ v: "server-3" });
});

const agent = (id: string, updatedAt: string, extra: Partial<PaseoAgent> = {}) =>
  ({ id, updatedAt, workspaceId: "w", labels: {}, ...extra }) as unknown as PaseoAgent;
const upsert = (a: PaseoAgent) => ({ kind: "upsert", agent: a }) as unknown as PaseoAgentUpdate;

test("live agent updates replace, insert and drop agents", () => {
  const list = [agent("a", "2026-10-15T10:00:00Z"), agent("b", "2026-10-15T10:00:00Z")];
  const next = applyAgentUpdates(list, [
    upsert(agent("a", "2026-10-15T10:00:05Z", { status: "running" } as Partial<PaseoAgent>)),
    upsert(agent("c", "2026-10-15T10:00:01Z")),
    upsert(agent("b", "2026-10-15T10:00:02Z", { archivedAt: "2026-10-15T10:00:02Z" })),
  ]);
  expect(next.map((a) => [a.id, a.updatedAt])).toEqual([
    ["a", "2026-10-15T10:00:05Z"],
    ["c", "2026-10-15T10:00:01Z"],
  ]);
  expect(list).toHaveLength(2); // the cached list is never mutated
  expect(applyAgentUpdates(next, [{ kind: "remove", agentId: "c" } as unknown as PaseoAgentUpdate]).map((a) => a.id)).toEqual(["a"]);
});

test("live agent updates never go back in time and skip summarizers", () => {
  const list = [agent("a", "2026-10-15T10:00:05Z")];
  expect(applyAgentUpdates(list, [upsert(agent("a", "2026-10-15T10:00:01Z"))])[0].updatedAt).toBe("2026-10-15T10:00:05Z");
  const summarizer = agent("s", "2026-10-15T10:00:06Z", { labels: { ...SUMMARIZER_LABELS } } as Partial<PaseoAgent>);
  expect(applyAgentUpdates([], [upsert(summarizer)])).toEqual([]);
  expect(applyAgentUpdates(list, [])).toBe(list);
});

test("a running agent's clock and usage ticks do not replace the cached list", () => {
  const running = (at: string, extra: Record<string, unknown> = {}) =>
    agent("a", at, { status: "running", title: "T", pendingPermissions: [], ...extra } as Partial<PaseoAgent>);
  const list = [running("2026-10-15T10:00:00Z", { lastUsage: { inputTokens: 1 }, activeTurn: { turnId: "1", startedAt: null } })];
  const tick = running("2026-10-15T10:00:01Z", { lastUsage: { inputTokens: 9 }, activeTurn: { turnId: "1", startedAt: "x" } });
  expect(applyAgentUpdates(list, [upsert(tick)])).toBe(list);
  // Anything a view reads still goes through: title, permissions, status.
  expect(applyAgentUpdates(list, [upsert(running("2026-10-15T10:00:02Z", { title: "New" }))])[0].title).toBe("New");
  const asking = running("2026-10-15T10:00:03Z", { pendingPermissions: [{ id: "p" }] });
  expect(applyAgentUpdates(list, [upsert(asking)])[0]).toBe(asking);
  const idle = agent("a", "2026-10-15T10:00:04Z", { status: "idle", title: "T", pendingPermissions: [] } as Partial<PaseoAgent>);
  expect(applyAgentUpdates(list, [upsert(idle)])[0]).toBe(idle);
  // A settled agent is never dropped as noise: its updatedAt is the time it went idle.
  const settled = [idle];
  const later = agent("a", "2026-10-15T10:05:00Z", { status: "idle", title: "T", pendingPermissions: [] } as Partial<PaseoAgent>);
  expect(applyAgentUpdates(settled, [upsert(later)])[0]).toBe(later);
});

test("a board delta read appends the new events to the cached ones", async () => {
  const cached = { revision: 1, events: [{ id: "a" }, { id: "b" }] } as never;
  const read = vi.fn(async () => ({ etag: "e2", delta: true, value: { revision: 2, events: [{ id: "c" }] } }) as never);
  const result = await readBoardDelta(read, cached, "e1");
  expect(read).toHaveBeenCalledWith({ etag: "e1", since: { count: 2, lastId: "b" } });
  expect(result).toEqual({ etag: "e2", value: { revision: 2, events: [{ id: "a" }, { id: "b" }, { id: "c" }] } });
  // The cached events are reused, not copied again.
  expect((result.value as { events: unknown[] }).events[0]).toBe((cached as { events: unknown[] }).events[0]);
});

test("a board read without an etag is always a full read", async () => {
  const cached = { revision: 1, events: [{ id: "a" }] } as never;
  const full = { etag: "e3", value: { revision: 3, events: [{ id: "x" }] } } as never;
  const read = vi.fn(async () => full);
  expect(await readBoardDelta(read, cached, undefined)).toBe(full);
  expect(read).toHaveBeenCalledWith({});
  // An empty cache has nothing to extend.
  await readBoardDelta(read, undefined, "e1");
  expect(read).toHaveBeenLastCalledWith({ etag: "e1" });
});

test("applying the daemon's patch gives back the board it was computed from", () => {
  const item = (id: string, v = 0) => ({ id, v });
  const make = (n: number, over: Record<string, unknown> = {}) =>
    ({
      version: 5,
      revision: n,
      events: [{ id: "e0" }, { id: "e1" }],
      plans: [],
      projects: [item("p")],
      tasks: [item("a"), item("b"), item("c")],
      ideas: [item("i")],
      links: [],
      artifacts: [item("x"), item("y")],
      workpads: [{ taskId: "a", v: 1 }],
      attentionDismissals: [],
      groups: [item("g")],
      ...over,
    }) as unknown as Parameters<typeof applyBoardPatch>[0];
  const before = make(1);
  const cases = [
    make(2, { tasks: [item("a"), item("b", 5), item("c")] }),
    make(2, { tasks: [item("c"), item("a"), item("d"), item("b")] }),
    make(2, { tasks: [item("b")], artifacts: [], ideas: [item("i", 1), item("j")] }),
    // a card at its event cap loses its oldest event from the middle while a new one is appended
    make(2, { events: [{ id: "e1" }, { id: "e2" }] }),
    make(2, { events: [{ id: "e0" }, { id: "e1" }, { id: "e2" }], workpads: [{ taskId: "z", v: 1 }, { taskId: "a", v: 2 }], plans: [{ taskId: "a" }] }),
    // board groups travel by id like projects (BOARD-GROUPS-SPEC §1)
    make(2, { groups: [item("h"), item("g", 1)] }),
  ];
  for (const after of cases) {
    const deltas = new BoardDeltas();
    const first = deltas.read(before as never, {});
    const answer = deltas.read(after as never, { etag: first.etag }) as unknown as { patch: Parameters<typeof applyBoardPatch>[1] };
    expect(applyBoardPatch(before, answer.patch)).toEqual(after);
  }
  // Items the patch does not mention keep their objects.
  const deltas = new BoardDeltas();
  const first = deltas.read(before as never, {});
  const { patch } = deltas.read(make(2, { tasks: [item("a"), item("b", 5), item("c")] }) as never, { etag: first.etag }) as unknown as { patch: Parameters<typeof applyBoardPatch>[1] };
  const merged = applyBoardPatch(before, patch);
  expect(merged.tasks[0]).toBe(before.tasks[0]);
  expect(merged.projects).toBe(before.projects);
});

test("a patch without a cached board is re-read in full", async () => {
  const full = { etag: "e", value: { revision: 1 } } as never;
  const read = vi.fn().mockResolvedValueOnce({ etag: "e", patch: { revision: 1, events: [] } }).mockResolvedValueOnce(full);
  expect(await readBoardDelta(read as never, undefined, "e0")).toBe(full);
  expect(read).toHaveBeenLastCalledWith({});
});

const scopedBoard = (revision: number, tasks: { id: string }[] = [{ id: "target" }]) =>
  ({ revision, tasks } as unknown as Parameters<typeof applyBoardPatch>[0]);

test("a silent poll observer still fetches and updates an independently observed board", async () => {
  const client = new QueryClient();
  const queryKey = ["silent-board-poll"];
  client.setQueryData(queryKey, scopedBoard(1));
  const read = vi.fn(async () => scopedBoard(2, []));
  const options = { queryKey, queryFn: read, enabled: false };
  const root = new QueryObserver(client, options);
  void root.trackResult(root.getCurrentResult()).data;
  const polling = new QueryObserver(client, { ...options, notifyOnChangeProps: [] });
  const rootChanged = vi.fn(), pollChanged = vi.fn();
  const stopRoot = root.subscribe(rootChanged), stopPoll = polling.subscribe(pollChanged);
  try {
    await polling.refetch();
    expect(read).toHaveBeenCalledTimes(1);
    expect(pollChanged).not.toHaveBeenCalled();
    expect(rootChanged).toHaveBeenCalledTimes(1);
    expect(root.getCurrentResult().data?.tasks).toEqual([]);
  } finally { stopRoot(); stopPoll(); client.clear(); }
});
