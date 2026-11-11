import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerSessionChips } from "./session-link";

const project = { id: "p" };
const task = (title: string) => ({ id: "t1", projectId: "p", workspaceId: "w1", title });
const agent = (id: string, archivedAt: string | null = null) => ({ id, workspaceId: "w1", archivedAt, title: id, labels: {} });

/** A fake plugin client: the board changes only when `boardEtag` does. */
function fakeClient() {
  const state = { boardEtag: "e1", title: "Card", live: [agent("a1")], all: [agent("a1"), agent("old", "2026-10-01T00:00:00.000Z")] };
  const calls = { board: [] as unknown[], archivedScans: 0, updates: 0, pills: 0 };
  const client = {
    rpc: vi.fn(async (def: { name?: string }, input: { etag?: string }) => {
      if (def.name === "sessions.archived-refs") {
        calls.archivedScans++;
        return state.all.filter((a) => a.archivedAt).map((a) => ({ id: a.id, workspaceId: a.workspaceId }));
      }
      calls.board.push(input);
      if (input.etag === state.boardEtag) return { etag: state.boardEtag };
      return { etag: state.boardEtag, value: { projects: [project], tasks: [task(state.title)] } };
    }),
    paseo: {
      agents: {
        list: vi.fn(async ({ filter }: { filter: { includeArchived: boolean } }) => {
          const list = filter.includeArchived ? state.all : state.live;
          return { entries: list.map((a) => ({ agent: a })), pageInfo: { nextCursor: null } };
        }),
      },
    },
    addComposerPill: vi.fn(() => {
      calls.pills++;
      return { update: () => void calls.updates++, remove: () => undefined };
    }),
    openScreen: vi.fn(),
  };
  return { client, state, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("an unchanged board is not re-downloaded, chips are not re-pushed, archived is not rescanned", async () => {
  const { client, state, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 1000, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.pills).toBe(2); // live a1 and archived "old" share the card
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  // Later rounds send the etag; nothing changed, so no pill update and no host-wide scan.
  expect(calls.board.slice(1).every((input) => (input as { etag?: string }).etag === "e1")).toBe(true);
  expect(calls.updates).toBe(0);
  expect(calls.archivedScans).toBe(1);
  // A renamed card: the board changes, both chips (the live and the archived session) update once, from what is
  // held: a board change alone does not download every agent on the host again (NATIVE-SESSION-SPEC §8).
  state.boardEtag = "e2";
  state.title = "Renamed";
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.updates).toBe(2);
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls.updates).toBe(2);
  stop();
});

test("archived sessions are rescanned at most once a minute without board changes", async () => {
  const { client, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 5000, 0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(55_000);
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls.archivedScans).toBe(2);
  stop();
});

test("a board change that arrives as a patch updates the chips (the daemon answers a known etag with a patch)", async () => {
  const { client, state, calls } = fakeClient();
  const full = (title: string) => ({ revision: 1, events: [], plans: [], projects: [project], tasks: [task(title)], ideas: [], links: [], artifacts: [], workpads: [], attentionDismissals: [] });
  client.rpc.mockImplementation(async (def: { name?: string }, input: { etag?: string }) => {
    if (def.name === "sessions.archived-refs") return state.all.filter((a) => a.archivedAt).map((a) => ({ id: a.id, workspaceId: a.workspaceId }));
    calls.board.push(input);
    if (input.etag === state.boardEtag) return { etag: state.boardEtag };
    // A caller that holds the previous etag gets only the changed task.
    if (input.etag) return { etag: state.boardEtag, patch: { revision: 2, events: [], tasks: { set: [task(state.title)], remove: [] } } };
    return { etag: state.boardEtag, value: full(state.title) };
  });
  const stop = registerSessionChips(client as never, 1000, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.pills).toBe(2);
  state.boardEtag = "e2";
  state.title = "Renamed";
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.updates).toBe(2);
  stop();
});

test("the first chip round waits for the start delay, so it stays off the plugin's first paint", async () => {
  const { client, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 1000, 2500);
  await vi.advanceTimersByTimeAsync(2499);
  expect(calls.board).toHaveLength(0);
  expect(client.paseo.agents.list).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.board).toHaveLength(1);
  expect(calls.pills).toBe(2);
  stop();
  // Stopped before the first round: nothing is ever read.
  const idle = fakeClient();
  registerSessionChips(idle.client as never, 1000, 2500)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(idle.calls.board).toHaveLength(0);
});

describe("Next and Ideas pills (NATIVE-SESSION-SPEC §6-8)", () => {
  const popovers = { ideas: () => null };
  const at = (s: number) => `2026-10-20T00:00:${String(s).padStart(2, "0")}.000Z`;
  function fakeNative() {
    const state = {
      etag: "e1",
      managed: ["a1"],
      ideasOn: true,
      progressCollapsed: undefined as boolean | undefined,
      events: [
        { id: "ev1", taskId: "t1", actor: "agent", action: "next_moves_suggested", agentId: "a1", at: at(1), moves: [{ label: "Verify", prompt: "Verify it" }, { label: "Commit", prompt: "Commit it" }] },
        { id: "ev2", taskId: "t1", actor: "agent", action: "next_moves_suggested", agentId: "a2", at: at(1), moves: [{ label: "X", prompt: "x" }] },
      ] as unknown[],
      ideas: [{ id: "i1", taskId: "t1", status: "open", createdAt: at(1), updatedAt: at(1), title: "Idea" }],
      live: [
        { id: "a1", workspaceId: "w1", archivedAt: null, title: "a1", labels: {}, status: "idle", pendingPermissions: [], lastUserMessageAt: at(0) },
        { id: "a2", workspaceId: "w1", archivedAt: null, title: "a2", labels: {}, status: "idle", pendingPermissions: [], lastUserMessageAt: at(0) },
      ],
    };
    const pills: { id: string; agentId: string; label: string; removed: boolean; updates: number }[] = [];
    let gate: Promise<void> | null = null;
    const client = {
      rpc: vi.fn(async (def: { name: string }, input: { etag?: string }) => {
        if (def.name === "sessions.archived-refs") return [];
        if (def.name === "sessions.native-chips") {
          await gate;
          return { managed: state.managed.map((agentId) => ({ agentId, taskId: "t1", workspaceId: "w1" })), ideas: state.ideasOn, autoWrapup: false, nextMoveTap: "fill", progressCollapsed: state.progressCollapsed };
        }
        if (input.etag === state.etag) return { etag: state.etag };
        return { etag: state.etag, value: { projects: [project], tasks: [{ ...task("Card"), status: "development", archivedAt: null }], events: state.events, ideas: state.ideas } };
      }),
      paseo: {
        agents: {
          list: vi.fn(async ({ filter }: { filter: { includeArchived: boolean } }) => ({
            entries: (filter.includeArchived ? state.live : state.live).map((a) => ({ agent: a })),
            pageInfo: { nextCursor: null },
          })),
        },
      },
      addComposerPill: vi.fn((c: { id: string; agentId: string; button: { label: string } }) => {
        const pill = { id: c.id, agentId: c.agentId, label: c.button.label, removed: false, updates: 0 };
        pills.push(pill);
        return {
          update: (b: { label: string }) => {
            pill.label = b.label;
            pill.updates++;
          },
          remove: () => void (pill.removed = true),
        };
      }),
      openScreen: vi.fn(),
    };
    const active = (id: string) => pills.filter((p) => p.id === id && !p.removed);
    return { client, state, pills, active, hold: (p: Promise<void>) => (gate = p) };
  }

  test("no Next pill: a managed session's current moves go to the timeline card's store; an unmanaged one gets none", async () => {
    const { client, active } = fakeNative();
    const { chipState } = await import("./native-chips");
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(active("flowly-next")).toEqual([]);
    expect(chipState("a1")?.moves).toEqual({ eventId: "ev1", moves: [{ label: "Verify", prompt: "Verify it" }, { label: "Commit", prompt: "Commit it" }] });
    expect(chipState("a1")?.nextMoveTap).toBe("fill");
    expect(chipState("a2")).toBeNull();
    // The Task chip still shows on both sessions.
    expect(active("kanban-task").map((p) => p.agentId).sort()).toEqual(["a1", "a2"]);
    stop();
  });

  test("the Progress row's start-collapsed setting reaches its store; collapsed until known and when the daemon omits it", async () => {
    const { client, state } = fakeNative();
    const { progressRowsCollapsed, setProgressRowsCollapsed } = await import("./native-chips");
    setProgressRowsCollapsed(true);
    state.progressCollapsed = false;
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    expect(progressRowsCollapsed()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(progressRowsCollapsed()).toBe(false);
    stop();
    // An older daemon without the field: rows start collapsed (the default).
    const older = fakeNative();
    const stopOlder = registerSessionChips(older.client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(progressRowsCollapsed()).toBe(true);
    stopOlder();
  });

  test("the Ideas pill shows the open idea count, follows the Ideas switch and goes at 0", async () => {
    const { client, state, active } = fakeNative();
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(active("flowly-ideas").map((p) => p.label)).toEqual(["Ideas · 1"]);
    state.ideas = [{ ...state.ideas[0], status: "dismissed", updatedAt: at(5) }];
    state.etag = "e2";
    await vi.advanceTimersByTimeAsync(1000);
    expect(active("flowly-ideas")).toEqual([]);
    state.ideas = [{ ...state.ideas[0], status: "open", updatedAt: at(6) }];
    state.ideasOn = false;
    state.etag = "e3";
    await vi.advanceTimersByTimeAsync(1000);
    expect(active("flowly-ideas")).toEqual([]);
    stop();
  });

  test("the Ideas pill updates only when what it shows changes; a new turn clears the card's moves", async () => {
    const { client, state, pills, active } = fakeNative();
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    state.etag = "e2"; // board changed, same suggestion
    await vi.advanceTimersByTimeAsync(3000);
    expect(pills.filter((p) => p.id !== "kanban-task").every((p) => p.updates === 0)).toBe(true);
    state.events = [...state.events, { id: "ev3", taskId: "t1", actor: "system", action: "agent.turn_started", agentId: "a1", at: at(9) }];
    state.etag = "e3";
    await vi.advanceTimersByTimeAsync(1000);
    const { chipState } = await import("./native-chips");
    expect(chipState("a1")?.moves).toBeNull();
    stop();
  });

  test("hiding a set takes the card's moves away without waiting for the next round", async () => {
    const { client } = fakeNative();
    const { hideMoves } = await import("./hidden-moves");
    const { chipState } = await import("./native-chips");
    const stop = registerSessionChips(client as never, 60_000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(chipState("a1")?.moves?.eventId).toBe("ev1");
    hideMoves("ev1");
    expect(chipState("a1")?.moves).toBeNull();
    stop();
    expect(chipState("a1")).toBeNull();
  });

  test("stop() during an in-flight round registers nothing afterwards and removes every pill", async () => {
    const { client, active, hold } = fakeNative();
    let release!: () => void;
    hold(new Promise<void>((r) => (release = r)));
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(active("flowly-ideas")).toEqual([]);
    expect(active("kanban-task")).toEqual([]);
  });
});

test("idea links: absent is null, valid parses, partial or malformed fails closed (NATIVE-SESSION-SPEC §7.3)", async () => {
  const { parseIdeaLink } = await import("./session-link");
  expect(parseIdeaLink(undefined)).toBeNull();
  expect(parseIdeaLink({ taskId: "t" })).toBeNull();
  expect(parseIdeaLink({ ideaId: "i1", requestId: "r1" })).toEqual({ ideaId: "i1", requestId: "r1" });
  expect(() => parseIdeaLink({ ideaId: "i1" })).toThrow(/Invalid idea link/);
  expect(() => parseIdeaLink({ ideaId: "", requestId: "r" })).toThrow(/Invalid idea link/);
});

test("an idea link is not read as a malformed session link", async () => {
  const { parseSessionLink } = await import("./session-link");
  expect(parseSessionLink({ ideaId: "i1", requestId: "r1" })).toBeNull();
  expect(() => parseSessionLink({ taskId: "t", requestId: "r1" })).toThrow();
});

test("an action asks for a refresh now: the Ideas pill goes without waiting for the next round, and rounds never overlap", async () => {
  const { refreshChipsNow } = await import("./native-chips");
  const state = { etag: "e1", ideas: [{ id: "i1", taskId: "t1", status: "open", createdAt: "x", updatedAt: "1", title: "Idea" }] };
  let inFlight = 0,
    maxInFlight = 0;
  const pills: { id: string; removed: boolean }[] = [];
  const client = {
    rpc: vi.fn(async (def: { name: string }, input: { etag?: string }) => {
        if (def.name === "sessions.archived-refs") return [];
      if (def.name === "sessions.native-chips") return { managed: [{ agentId: "a1", taskId: "t1", workspaceId: "w1" }], ideas: true, autoWrapup: false, nextMoveTap: "fill" };
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      if (input.etag === state.etag) return { etag: state.etag };
      return { etag: state.etag, value: { projects: [project], tasks: [{ ...task("Card"), status: "development", archivedAt: null }], events: [], ideas: state.ideas } };
    }),
    paseo: { agents: { list: vi.fn(async () => ({ entries: [{ agent: { id: "a1", workspaceId: "w1", archivedAt: null, title: "a1", labels: {}, status: "idle", pendingPermissions: [] } }], pageInfo: { nextCursor: null } })) } },
    addComposerPill: vi.fn((c: { id: string }) => {
      const pill = { id: c.id, removed: false };
      pills.push(pill);
      return { update: () => undefined, remove: () => void (pill.removed = true) };
    }),
    openScreen: vi.fn(),
  };
  const stop = registerSessionChips(client as never, 60_000, 0, { ideas: () => null });
  await vi.advanceTimersByTimeAsync(100);
  expect(pills.filter((p) => p.id === "flowly-ideas" && !p.removed)).toHaveLength(1);
  state.ideas = [{ ...state.ideas[0], status: "dismissed", updatedAt: "2" }];
  state.etag = "e2";
  refreshChipsNow();
  refreshChipsNow(); // a second request while one runs only queues one more round
  await vi.advanceTimersByTimeAsync(200);
  expect(pills.filter((p) => p.id === "flowly-ideas" && !p.removed)).toEqual([]);
  expect(maxInFlight).toBe(1);
  stop();
  refreshChipsNow(); // after teardown: nothing
});

test("the Next moves card keeps an open wrap-up question after its moves stop being current (NATIVE-SESSION-SPEC §6.4)", async () => {
  const { cardView, setWrapPending } = await import("./native-chips");
  const ready = { status: "ready" as const, taskId: "t1", workspaceId: "w1", eventId: "ev1", moves: [{ label: "Done", moveTo: "done" as const }] };
  const state = { moves: { eventId: "ev1", moves: ready.moves } } as never;
  expect(cardView(ready, state, "a1")).toBe("moves");
  expect(cardView(ready, { moves: null } as never, "a1")).toBe("hidden");
  expect(cardView({ status: "dismissed" }, state, "a1")).toBe("hidden");
  // Once the next turn started the row keeps its moves, disabled; a set the user hid stays hidden.
  const past = { status: "past" as const, eventId: "ev-past", moves: ready.moves };
  expect(cardView(past, null, "a1")).toBe("past");
  expect(cardView(past, { moves: null } as never, "a1")).toBe("past");
  const { hideMoves } = await import("./hidden-moves");
  hideMoves("ev-past");
  expect(cardView(past, null, "a1")).toBe("hidden");
  setWrapPending("a1", "ev1", { need: "ask", state: {} as never });
  expect(cardView(ready, { moves: null } as never, "a1")).toBe("wrap");
  expect(cardView(ready, null, "a1")).toBe("wrap");
  setWrapPending("a1", "ev1", null);
  expect(cardView(ready, null, "a1")).toBe("hidden");
});

describe("sessions Flowly does not manage (NATIVE-SESSION-SPEC §12)", () => {
  const popovers = { ideas: () => null, outsideIdeas: () => null };
  const live = (id: string, workspaceId: string, labels: Record<string, string> = {}) => ({
    id, workspaceId, archivedAt: null, title: id, labels, status: "idle", pendingPermissions: [], lastUserMessageAt: "2026-10-21T00:00:00Z",
  });
  function fakeOutside(enabled: boolean) {
    const calls: string[] = [];
    const pills: { id: string; agentId: string; label: string; removed: boolean }[] = [];
    const view = [
      { agentId: "o1", workspaceId: "wx", suggestion: { id: "s1", at: "2026-10-21T00:00:05Z", moves: [{ label: "Go", prompt: "Go on" }], current: true }, ideas: [{ id: "i1", title: "Idea", detail: "", rationale: "", scope: "new", status: "open", createdAt: "x", updatedAt: "1" }] },
      { agentId: "m1", workspaceId: "w1", suggestion: { id: "s2", at: "2026-10-21T00:00:05Z", moves: [{ label: "X", prompt: "x" }], current: true }, ideas: [] },
    ];
    const client = {
      rpc: vi.fn(async (def: { name: string }, input: { etag?: string }) => {
        if (def.name === "sessions.archived-refs") return [];
        calls.push(def.name);
        if (def.name === "sessions.native-chips")
          return { managed: [{ agentId: "m1", taskId: "t1", workspaceId: "w1" }], ideas: true, autoWrapup: false, nextMoveTap: "copy", outside: { enabled, progress: true, nextMoves: true, ideas: true } };
        if (def.name === "sessions.insights") return input.etag === "x1" ? { etag: "x1" } : { etag: "x1", value: view };
        if (input.etag === "e1") return { etag: "e1" };
        return { etag: "e1", value: { projects: [project], tasks: [{ ...task("Card"), status: "development", archivedAt: null }], events: [], ideas: [] } };
      }),
      paseo: {
        agents: {
          list: vi.fn(async () => ({
            entries: [live("o1", "wx"), live("m1", "w1"), live("sub", "wx", { "paseo.parent-agent-id": "o1" }), live("sum", "wx", { flowly: "summarizer" })].map((agent) => ({ agent })),
            pageInfo: { nextCursor: null },
          })),
        },
      },
      addComposerPill: vi.fn((c: { id: string; agentId: string; button: { label: string } }) => {
        const pill = { id: c.id, agentId: c.agentId, label: c.button.label, removed: false };
        pills.push(pill);
        return { update: () => undefined, remove: () => void (pill.removed = true) };
      }),
      openScreen: vi.fn(),
    };
    return { client, calls, pills };
  }

  test("off (the default): insights are never read and no outside session gets a card or chip", async () => {
    const { outsideState } = await import("./native-chips");
    const { client, calls, pills } = fakeOutside(false);
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).not.toContain("sessions.insights");
    expect(outsideState("o1")).toBeNull();
    expect(pills.filter((p) => p.agentId === "o1")).toEqual([]);
    stop();
  });

  test("on: the outside session's current moves and its Ideas chip; managed sessions, subagents and summarizers are not outside", async () => {
    const { outsideState } = await import("./native-chips");
    const { client, calls, pills } = fakeOutside(true);
    const stop = registerSessionChips(client as never, 1000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(outsideState("o1")).toMatchObject({ agentId: "o1", workspaceId: "wx", moves: { eventId: "s1", moves: [{ label: "Go", prompt: "Go on" }] }, nextMoveTap: "copy", ideas: [{ id: "i1" }] });
    expect(pills.filter((p) => p.id === "flowly-ideas" && !p.removed).map((p) => [p.agentId, p.label])).toEqual([["o1", "Ideas · 1"]]);
    for (const id of ["m1", "sub", "sum"]) expect(outsideState(id)).toBeNull();
    // Later rounds send the etag.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c === "sessions.insights").length).toBeGreaterThanOrEqual(2);
    stop();
    expect(outsideState("o1")).toBeNull();
  });
});

describe("chip state notifications and row-triggered refresh (NATIVE-SESSION-SPEC §8)", () => {
  const card = (extra: object = {}) =>
    ({ task: { id: "t1", workspaceId: "w1", status: "development", revision: 3 }, project: { id: "p", revision: 1 }, agentId: "a1", moves: { eventId: "e1", moves: [{ label: "Go", prompt: "Go" }] }, ideas: [], autoWrapup: false, nextMoveTap: "fill", ...extra }) as never;

  test("a round that recomputes identical state wakes no subscriber; a real change does", async () => {
    const { setChipState, chipState } = await import("./native-chips");
    const seen: unknown[] = [];
    const store = await import("./native-chips");
    // Subscribe through the store's own hook surface: setChipState notifies the same listeners as useChipState.
    let notified = 0;
    const unsubscribe = (store as unknown as { subscribeForTest(l: () => void): () => void }).subscribeForTest(() => void notified++);
    setChipState("a-perf", card());
    expect(notified).toBe(1);
    setChipState("a-perf", card());
    setChipState("a-perf", card({ ideas: [] }));
    expect(notified).toBe(1);
    setChipState("a-perf", card({ moves: null }));
    expect(notified).toBe(2);
    expect(chipState("a-perf")?.moves).toBeNull();
    setChipState("a-perf", null);
    expect(notified).toBe(3);
    unsubscribe();
    expect(seen).toEqual([]);
  });

  test("a row that arrives before its state asks for one round, once per row", async () => {
    const { setChipRefresher, requestRowRefresh } = await import("./native-chips");
    const refresh = vi.fn();
    setChipRefresher(refresh);
    requestRowRefresh("a1", "ev-1");
    requestRowRefresh("a1", "ev-1");
    requestRowRefresh("a1", "ev-2");
    expect(refresh).toHaveBeenCalledTimes(2);
    setChipRefresher(null);
    requestRowRefresh("a1", "ev-3");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("round order and the agent stream (NATIVE-SESSION-SPEC §8)", () => {
  const popovers = { ideas: () => null };
  const live = (id: string, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: "w1", archivedAt: null, title: id, labels: {}, status: "idle", updatedAt: "2026-10-21T00:00:01.000Z", pendingPermissions: [], attentionReason: null, lastUserMessageAt: "2026-10-21T00:00:00Z", ...extra,
  });
  function fake(options: { stream: boolean; scanGate?: Promise<void> }) {
    const calls = { live: 0, archived: 0, board: 0, native: 0 };
    const state = {
      etag: "e1",
      agents: [live("a1")] as ReturnType<typeof live>[],
      events: [{ id: "evp1", taskId: "t1", actor: "agent", action: "next_moves_suggested", agentId: "a1", at: "2026-10-21T00:00:05Z", moves: [{ label: "Verify", prompt: "Verify it" }] }] as unknown[],
    };
    let push: ((u: unknown) => void) | null = null;
    let released = 0;
    const client = {
      rpc: vi.fn(async (def: { name: string }, input: { etag?: string }) => {
        if (def.name === "sessions.archived-refs") {
          calls.archived++;
          await options.scanGate;
          return [{ id: "old", workspaceId: "w1" }];
        }
        if (def.name === "sessions.native-chips") {
          calls.native++;
          return { managed: [{ agentId: "a1", taskId: "t1", workspaceId: "w1" }], ideas: true, autoWrapup: false, nextMoveTap: "fill", outside: { enabled: false, progress: false, nextMoves: false, ideas: false } };
        }
        calls.board++;
        if (input.etag === state.etag) return { etag: state.etag };
        return { etag: state.etag, value: { projects: [project], tasks: [{ ...task("Card"), status: "development", archivedAt: null }], events: state.events, ideas: [] } };
      }),
      paseo: {
        agents: {
          list: vi.fn(async (o: { filter: { includeArchived: boolean }; subscribe?: object }) => {
            if (o.subscribe) return { subscription: { release: async () => void released++ } };
            calls.live++;
            return { entries: state.agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } };
          }),
          ...(options.stream ? { subscribe: (h: (u: unknown) => void) => ((push = h), () => void (push = null)) } : {}),
        },
      },
      addComposerPill: vi.fn(() => ({ update: () => undefined, remove: () => undefined })),
      openScreen: vi.fn(),
    };
    return { client, calls, state, push: (u: unknown) => push?.(u), released: () => released };
  }

  test("the card's state is ready while the archived scan is still running", async () => {
    const { chipState } = await import("./native-chips");
    let release!: () => void;
    const x = fake({ stream: false, scanGate: new Promise<void>((r) => (release = r)) });
    const stop = registerSessionChips(x.client as never, 5000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(x.calls.archived).toBe(1);
    expect(chipState("a1")?.moves?.eventId).toBe("evp1");
    release();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  test("with the stream, live sessions are listed once more after it starts and then not every round", async () => {
    const x = fake({ stream: true });
    const stop = registerSessionChips(x.client as never, 5000, 0, popovers);
    await vi.advanceTimersByTimeAsync(0);
    expect(x.calls.live).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(x.calls.live).toBe(2); // the one reconcile after the subscription started
    await vi.advanceTimersByTimeAsync(40_000);
    expect(x.calls.live).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.calls.live).toBe(3); // the minute's reconcile
    stop();
    expect(x.released()).toBe(1);
  });

  test("a session going idle (pushed) brings its card state within a moment, not at the next tick", async () => {
    const { chipState } = await import("./native-chips");
    const x = fake({ stream: true });
    x.state.agents = [live("a1", { status: "running" })];
    const stop = registerSessionChips(x.client as never, 5000, 0, popovers);
    await vi.advanceTimersByTimeAsync(100);
    expect(chipState("a1")?.moves).toBeNull(); // working: no card yet
    const boardCallsBefore = x.calls.board;
    x.push({ kind: "upsert", agent: live("a1", { status: "idle", updatedAt: "2026-10-21T00:00:09.000Z" }) });
    await vi.advanceTimersByTimeAsync(400); // far less than the 5 s tick
    expect(chipState("a1")?.moves?.eventId).toBe("evp1");
    expect(x.calls.board).toBeGreaterThan(boardCallsBefore);
    stop();
  });

  test("pushed churn that cannot change a card (a title) causes no round", async () => {
    const x = fake({ stream: true });
    const stop = registerSessionChips(x.client as never, 60_000, 0, popovers);
    await vi.advanceTimersByTimeAsync(100);
    const before = x.calls.board;
    x.push({ kind: "upsert", agent: live("a1", { title: "renamed", updatedAt: "2026-10-21T00:00:09.000Z" }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(x.calls.board).toBe(before);
    stop();
  });

  test("a row request runs one round now, and none once the chips are torn down", async () => {
    const { requestRowRefresh, chipState } = await import("./native-chips");
    const x = fake({ stream: false });
    const stop = registerSessionChips(x.client as never, 60_000, 0, popovers);
    await vi.advanceTimersByTimeAsync(100);
    const before = x.calls.board;
    requestRowRefresh("a1", "ev-row-now");
    await vi.advanceTimersByTimeAsync(50);
    expect(x.calls.board).toBeGreaterThan(before);
    stop();
    const after = x.calls.board;
    requestRowRefresh("a1", "ev-row-later");
    await vi.advanceTimersByTimeAsync(50);
    expect(x.calls.board).toBe(after);
    expect(chipState("a1")).toBeNull();
  });
});


test("native startup requests the private slim board, never the full board endpoint", async () => {
  const x = fakeClient();
  const stop = registerSessionChips(x.client as never, 5000, 0);
  await vi.advanceTimersByTimeAsync(100);
  const names = x.client.rpc.mock.calls.map(([definition]) => definition.name);
  expect(names).toContain("sessions.chip-board-changed");
  expect(names).not.toContain("board.read-changed");
  expect(names).not.toContain("board.read");
  expect(x.calls.pills).toBe(2);
  stop();
});
