import { afterEach, expect, test, vi } from "vitest";
import { SubagentActivity, type SubagentLister } from "./subagent-activity";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sub = (status: "running" | "completed", createdAt = "2026-11-22T10:00:00Z") => ({ status, createdAt });

function setup(lists: Record<string, ReturnType<typeof sub>[]>, options: { unavailable?: boolean; cards?: Set<string>; idle?: string[] } = {}) {
  const calls: string[] = [];
  const lister: SubagentLister = {
    listFor: vi.fn(async (agentId: string) => {
      calls.push(agentId);
      return options.unavailable ? { subagents: [], unavailable: true } : { subagents: lists[agentId] ?? [], unavailable: false };
    }),
  };
  const cards = options.cards ?? new Set(Object.keys(lists));
  const activity = new SubagentActivity({
    lister,
    isCardSession: async (id) => cards.has(id),
    idleCardSessions: async () => options.idle ?? [],
  });
  return { activity, calls, lister, cards };
}

test("a turn end reads once; while a subagent runs it reads again every 5 s; it stops once none runs", async () => {
  vi.useFakeTimers();
  const lists = { s: [sub("running"), sub("running", "2026-11-22T09:59:00Z"), sub("completed")] };
  const { activity, calls } = setup(lists);
  activity.turnEnded("s");
  await activity.idle();
  expect(calls).toEqual(["s"]);
  expect(activity.read()).toEqual({ revision: 1, running: { s: 2 }, since: { s: "2026-11-22T09:59:00Z" } });
  await vi.advanceTimersByTimeAsync(5_000);
  await activity.idle();
  expect(calls).toEqual(["s", "s"]);
  // Unchanged content keeps the revision.
  expect(activity.read().revision).toBe(1);
  lists.s = [sub("completed")];
  await vi.advanceTimersByTimeAsync(5_000);
  await activity.idle();
  expect(activity.read()).toEqual({ revision: 2, running: {}, since: {} });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toHaveLength(3);
});

test("nothing running at the turn end: one read, no poll, no revision", async () => {
  vi.useFakeTimers();
  const { activity, calls } = setup({ s: [sub("completed")] });
  activity.turnEnded("s");
  await activity.idle();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toEqual(["s"]);
  expect(activity.read().revision).toBe(0);
});

test("a turn start drops the session at once, also with a read in flight", async () => {
  vi.useFakeTimers();
  const { activity, calls } = setup({ s: [sub("running")] });
  activity.turnEnded("s");
  await activity.idle();
  expect(activity.read().running).toEqual({ s: 1 });
  activity.turnStarted("s");
  expect(activity.read().running).toEqual({});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toEqual(["s"]);
  // In flight: the answer is dropped.
  activity.turnEnded("s");
  activity.turnStarted("s");
  await activity.idle();
  expect(activity.read().running).toEqual({});
});

test("an archived or gone session (no longer a card's) stops being read", async () => {
  vi.useFakeTimers();
  const { activity, calls, cards } = setup({ s: [sub("running")] });
  activity.turnEnded("s");
  await activity.idle();
  cards.delete("s");
  await vi.advanceTimersByTimeAsync(5_000);
  await activity.idle();
  expect(calls).toEqual(["s"]);
  expect(activity.read().running).toEqual({});
});

test("an older Paseo (unsupported) gives empty data, quietly, and is not read again", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const lister: SubagentLister = { listFor: vi.fn(async () => ({ subagents: [], unavailable: true, unsupported: true })) };
  const activity = new SubagentActivity({ lister, isCardSession: async () => true, idleCardSessions: async () => [] });
  activity.turnEnded("s");
  await activity.idle();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(lister.listFor).toHaveBeenCalledTimes(1);
  expect(activity.read()).toEqual({ revision: 0, running: {}, since: {} });
  expect(log).not.toHaveBeenCalled();
});

test("a failed read keeps the last count and retries with a backoff (5, 10, 20, 40, 60, 60 s)", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fail = false;
  const at: number[] = [];
  const start = Date.now();
  const lister: SubagentLister = {
    listFor: async () => {
      at.push(Date.now() - start);
      return fail ? { subagents: [], unavailable: true } : { subagents: [sub("running")], unavailable: false };
    },
  };
  const activity = new SubagentActivity({ lister, isCardSession: async () => true, idleCardSessions: async () => [] });
  activity.turnEnded("s");
  await activity.idle();
  expect(activity.read().running).toEqual({ s: 1 });
  fail = true;
  await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
  await activity.idle();
  // Polled at 5 s (failed), then retried after 5, 10, 20, 40, 60, 60 s.
  expect(at.slice(1).map((t, i, all) => t - (i ? all[i - 1] : 0))).toEqual([5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  expect(activity.read()).toMatchObject({ revision: 1, running: { s: 1 } });
  // Back to good answers: the poll returns to 5 s; then nothing running forgets it.
  fail = false;
  await vi.advanceTimersByTimeAsync(60_000);
  await activity.idle();
  const n = at.length;
  await vi.advanceTimersByTimeAsync(5_000);
  await activity.idle();
  expect(at.length).toBe(n + 1);
  expect(log).not.toHaveBeenCalled();
});

test("a turn end during a read marks it dirty: one more read follows, so a subagent started meanwhile is seen", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const lists: Record<string, ReturnType<typeof sub>[]> = { s: [] };
  const calls: string[] = [];
  const lister: SubagentLister = {
    listFor: async (id) => {
      calls.push(id);
      const answer = { subagents: lists[id], unavailable: false };
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      return answer;
    },
  };
  const activity = new SubagentActivity({ lister, isCardSession: async () => true, idleCardSessions: async () => [] });
  activity.turnEnded("s");
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual(["s"]);
  // The first read already answered "none"; a subagent starts and the session's next turn ends.
  lists.s = [sub("running")];
  activity.turnEnded("s");
  release();
  await activity.idle();
  expect(calls).toEqual(["s", "s"]);
  expect(activity.read().running).toEqual({ s: 1 });
});

test("an enqueue right after a drain ends is still read (no lost wakeup)", async () => {
  for (let depth = 0; depth < 20; depth++) {
    const calls: string[] = [];
    let activity!: SubagentActivity;
    const lister: SubagentLister = {
      listFor: async (id) => {
        calls.push(id);
        if (id === "a") {
          let p: Promise<unknown> = Promise.resolve();
          for (let i = 0; i < depth; i++) p = p.then(() => undefined);
          void p.then(() => activity.turnEnded("b"));
        }
        return { subagents: id === "b" ? [sub("running")] : [], unavailable: false };
      },
    };
    activity = new SubagentActivity({ lister, isCardSession: async () => true, idleCardSessions: async () => [] });
    activity.turnEnded("a");
    await new Promise((r) => setTimeout(r, 5));
    await activity.idle();
    expect(calls, `depth ${depth}`).toContain("b");
    activity.stop();
  }
});

test("the start sweep reads each idle card session once, one at a time, and only once", async () => {
  vi.useFakeTimers();
  let inFlight = 0;
  let most = 0;
  const lister: SubagentLister = {
    listFor: async (id) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight--;
      return { subagents: id === "b" ? [sub("running")] : [], unavailable: false };
    },
  };
  const idle = vi.fn(async () => ["a", "b", "c"]);
  const activity = new SubagentActivity({ lister, isCardSession: async () => true, idleCardSessions: idle });
  await activity.sweep();
  await activity.sweep();
  await activity.idle();
  expect(idle).toHaveBeenCalledTimes(1);
  expect(most).toBe(1);
  expect(activity.read().running).toEqual({ b: 1 });
  activity.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(vi.getTimerCount()).toBe(0);
});
