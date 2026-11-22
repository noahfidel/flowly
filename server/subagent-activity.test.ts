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

test("an older or unreachable daemon gives empty data, quietly", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { activity, calls } = setup({ s: [sub("running")] }, { unavailable: true });
  activity.turnEnded("s");
  await activity.idle();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toEqual(["s"]);
  expect(activity.read()).toEqual({ revision: 0, running: {}, since: {} });
  expect(log).not.toHaveBeenCalled();
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
