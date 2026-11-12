import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { BoardStore } from "./store";
import { EventBus, NoteBatcher, commitHandler, factsFromCommit, isStop, RestoreRepeats, type BusFact } from "./event-bus";
import type { DispatcherNote } from "../shared/dispatcher";
import { emptyBoard, type Board, type BoardEvent } from "../shared/model";

const now = "2026-11-08T10:00:00.000Z";
function board(): Board {
  const b = emptyBoard();
  b.projects.push({
    id: "p1",
    paseoProjectId: "native1",
    title: "Fixture",
    description: "",
    primaryPath: "/repo1",
    repos: ["/repo1"],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  b.tasks.push({
    id: "t1",
    projectId: "p1",
    workspaceId: "w1",
    sourcePath: "/repo1",
    repoPaths: [],
    title: "Task one",
    description: "",
    status: "todo",
    priority: "normal",
    position: 0,
    revision: 1,
    operationId: "op1",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return b;
}
let seq = 0;
function event(patch: Partial<BoardEvent>): BoardEvent {
  return { id: `e${++seq}`, taskId: "t1", actor: "agent", action: "status_changed", at: now, ...patch };
}
function fact(patch: Partial<BoardEvent>, extra: { projectId?: string; title?: string } = {}): BusFact {
  return { kind: "board", event: event(patch), projectId: extra.projectId ?? "p1", title: extra.title ?? "Task one" };
}
const request = { id: "r1", provider: "claude", name: "Bash", kind: "tool" } as AgentPermissionRequest;

describe("a commit's facts", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), "flowly-bus-"));
    directories.push(directory);
    const s = new BoardStore(directory);
    await writeFile(s.path, JSON.stringify({ ...board(), agentReceipts: [] }));
    return s;
  }

  test("a commit publishes its events once", async () => {
    const s = await store();
    const bus = new EventBus();
    const seen: BusFact[][] = [];
    bus.subscribe((facts) => seen.push(facts));
    s.onCommit = commitHandler(bus, () => undefined);
    await s.editTask({ id: "t1", revision: 1, title: "Renamed", actor: "human" });
    const stored = (await s.read()).events;
    expect(stored.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((f) => (f.kind === "board" ? f.event.id : ""))).toEqual(stored.map((e) => e.id));
    expect(seen[0][0]).toMatchObject({ kind: "board", projectId: "p1", title: "Renamed" });
    // A read-only transaction commits nothing and publishes nothing.
    await s.transaction(() => ({ value: 1, changed: false }));
    expect(seen).toHaveLength(1);
  });

  test("onCommit still schedules folder writes", async () => {
    const s = await store();
    const schedule = vi.fn();
    s.onCommit = commitHandler(new EventBus(), schedule);
    await s.editTask({ id: "t1", revision: 1, title: "Renamed", actor: "human" });
    expect(schedule).toHaveBeenCalledTimes(1);
    // The restore and export paths pass no events and no board; folders still refresh.
    s.onCommit?.([], null);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  test("an event of a card deleted in the same commit is skipped", () => {
    const b = board();
    const kept = event({ taskId: "t1" });
    const gone = event({ taskId: "missing" });
    expect(factsFromCommit([kept, gone], b)).toEqual([{ kind: "board", event: kept, projectId: "p1", title: "Task one" }]);
  });

  test("a fact carries its project's group as the commit had it (DISPATCHER-SPEC §0, §7)", () => {
    const b = board();
    b.projects[0].groupId = "g1";
    const e = event({ taskId: "t1" });
    expect(factsFromCommit([e], b)).toEqual([{ kind: "board", event: e, projectId: "p1", title: "Task one", groupId: "g1" }]);
  });

  test("a throwing subscriber is logged and does not stop the others or the commit", () => {
    const bus = new EventBus();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(second);
    expect(() => bus.publish([fact({})])).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("unsubscribe stops delivery and an empty publish calls nobody", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish([]);
    expect(fn).not.toHaveBeenCalled();
    off();
    bus.publish([fact({})]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("with no subscriber a commit builds no facts", () => {
    const bus = new EventBus();
    const schedule = vi.fn();
    const handler = commitHandler(bus, schedule);
    // Reading the board's cards would throw: facts are not built while nobody listens.
    const untouchable = new Proxy(board(), {
      get(target, key) {
        if (key === "tasks") throw new Error("facts were built");
        return Reflect.get(target, key);
      },
    });
    expect(bus.hasSubscribers()).toBe(false);
    expect(() => handler([event({})], untouchable)).not.toThrow();
    expect(schedule).toHaveBeenCalledTimes(1);
    const fn = vi.fn();
    bus.subscribe(fn);
    expect(bus.hasSubscribers()).toBe(true);
    handler([event({})], board());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("what counts as a stop", () => {
  test("turn starts and auto-status into development are not stops", () => {
    expect(isStop(fact({ action: "agent.turn_started" }))).toBe(false);
    for (const to of ["design", "development", "test"] as const)
      expect(isStop(fact({ action: "status_changed", from: "todo", to, rule: "A1" }))).toBe(false);
    expect(isStop(fact({ action: "progress_reported", reportKind: "progress" }))).toBe(false);
    expect(isStop(fact({ action: "agent.permission_requested", tool: "Bash" }))).toBe(false);
    expect(isStop(fact({ action: "agent.turn_ended", outcome: "completed" }))).toBe(false);
    expect(isStop(fact({ action: "agent.turn_ended", outcome: "canceled" }))).toBe(false);
    expect(isStop({ kind: "permission_resolved", agentId: "a", requestId: "r1" })).toBe(false);
  });

  test("moves into a resting or finished status, reports, failed turns and permission requests are stops", () => {
    for (const to of ["blocked", "in_review", "committed", "integrated", "done", "cancelled"] as const)
      expect(isStop(fact({ action: "status_changed", from: "development", to }))).toBe(true);
    for (const reportKind of ["question", "blocker", "result"] as const) {
      expect(isStop(fact({ action: "progress_reported", reportKind }))).toBe(true);
      // A report that also moved the card carries its kind on the status event.
      expect(isStop(fact({ action: "status_changed", from: "development", to: "development", reportKind }))).toBe(true);
    }
    expect(isStop(fact({ action: "agent.turn_ended", outcome: "failed" }))).toBe(true);
    expect(isStop({ kind: "permission", agentId: "a", taskId: null, request })).toBe(true);
  });
});

describe("note batching", () => {
  let flushed: DispatcherNote[][];
  let dispatcher: string | null;
  const batcher = () =>
    new NoteBatcher({ windowMs: 10_000, maxWaitMs: 60_000, exclude: () => dispatcher }, (notes) => flushed.push(notes));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    flushed = [];
    dispatcher = null;
  });
  afterEach(() => vi.useRealTimers());

  test("facts caused by the dispatcher are dropped", () => {
    dispatcher = "dispatcher-1";
    const b = batcher();
    b.push([fact({ agentId: "dispatcher-1", action: "status_changed", to: "blocked" })]);
    vi.advanceTimersByTime(120_000);
    expect(flushed).toEqual([]);
    // The same card's fact from another session still notes; the exclusion follows exclude() live.
    b.push([fact({ agentId: "card-agent", action: "status_changed", to: "blocked" })]);
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
  });

  test("facts within the window become one batch, coalesced per card with the count kept", () => {
    const b = batcher();
    b.push([fact({ action: "status_changed", from: "todo", to: "blocked", note: "first" })]);
    vi.advanceTimersByTime(4_000);
    b.push([
      fact({ action: "status_changed", from: "blocked", to: "in_review", note: "second", at: "2026-11-08T10:00:04.000Z" }),
      fact({ taskId: "t2", action: "progress_reported", reportKind: "question", note: "Which one?" }, { title: "Task two" }),
    ]);
    vi.advanceTimersByTime(9_999);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([
      { taskId: "t1", projectId: "p1", title: "Task one", kind: "status_changed", detail: "blocked → in_review: second", earlier: 1, at: "2026-11-08T10:00:04.000Z" },
      { taskId: "t2", projectId: "p1", title: "Task two", kind: "question", detail: "Which one?", at: now },
    ]);
    vi.advanceTimersByTime(120_000);
    expect(flushed).toHaveLength(1);
  });

  test("a question or blocker is kept over a later plain status change on the same card", () => {
    const b = batcher();
    b.push([
      fact({ action: "progress_reported", reportKind: "blocker", note: "Needs a key" }),
      fact({ action: "status_changed", from: "development", to: "blocked" }),
      fact({ action: "status_changed", from: "blocked", to: "in_review" }),
      fact({ taskId: "t2", action: "progress_reported", reportKind: "question", note: "Which?" }),
      fact({ taskId: "t2", action: "progress_reported", reportKind: "result", note: "Done" }),
    ]);
    vi.advanceTimersByTime(10_000);
    expect(flushed[0]).toEqual([
      { taskId: "t1", projectId: "p1", title: "Task one", kind: "blocker", detail: "Needs a key", later: "blocked → in_review", earlier: 1, at: now },
      // A later report (not a plain status change) still wins.
      { taskId: "t2", projectId: "p1", title: "Task one", kind: "result", detail: "Done", earlier: 1, at: now },
    ]);
  });

  test("a steady stream flushes by maxWait", () => {
    const b = batcher();
    // One fact every 5 s keeps resetting the 10 s window; the 60 s cap flushes anyway.
    for (let i = 0; i < 12; i++) {
      b.push([fact({ action: "status_changed", to: "blocked", note: `n${i}` })]);
      vi.advanceTimersByTime(5_000);
    }
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(1);
    expect(flushed[0][0].detail).toContain("n11");
    // A fact after the flush starts a new batch.
    b.push([fact({ action: "status_changed", to: "done" })]);
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(2);
  });

  test("a failed turn is a turn_failed note and permission facts are not notes", () => {
    const b = batcher();
    b.push([
      fact({ action: "agent.turn_ended", outcome: "failed", note: "model error" }),
      { kind: "permission", agentId: "a", taskId: "t1", request },
      { kind: "permission_resolved", agentId: "a", requestId: "r1" },
    ]);
    vi.advanceTimersByTime(10_000);
    expect(flushed[0]).toEqual([{ taskId: "t1", projectId: "p1", title: "Task one", kind: "turn_failed", detail: "model error", at: now }]);
  });

  test("maxWait counts from a first fact at time zero", () => {
    vi.setSystemTime(0);
    const b = batcher();
    for (let at = 0; at <= 70_000; at += 5_000) {
      if (at > 0) vi.advanceTimersByTime(5_000);
      if (flushed.length) break;
      b.push([fact({ action: "status_changed", to: "blocked", note: `at ${at}` })]);
    }
    expect(flushed).toHaveLength(1);
    // The batch that began at 0 went out at 60 s, not later.
    expect(Date.now()).toBe(60_000);
  });

  test("dispose clears the timer and the pending notes", () => {
    const b = batcher();
    b.push([fact({ action: "status_changed", to: "blocked" })]);
    b.dispose();
    vi.advanceTimersByTime(120_000);
    expect(flushed).toEqual([]);
    // A disposed batcher can still be pushed to without leaking a timer into a later flush of old notes.
    b.push([fact({ action: "status_changed", to: "done" })]);
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0][0].detail).toBe("→ done");
  });

  test("takeProject removes and returns one project's pending notes; the rest still go out (DISPATCHER-SPEC §0)", () => {
    const b = batcher();
    b.push([fact({ to: "blocked" }), fact({ taskId: "t2", to: "blocked" }, { projectId: "p2" })]);
    expect(b.takeProject("p2").map((n) => n.taskId)).toEqual(["t2"]);
    expect(b.takeProject("p2")).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(flushed.map((batch) => batch.map((n) => n.taskId))).toEqual([["t1"]]);
    // Taking the last pending note stops the timer: nothing empty is flushed later.
    b.push([fact({ to: "done" })]);
    expect(b.takeProject("p1")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("pushNotes merges moved notes per card and batches them like facts", () => {
    const b = batcher();
    b.push([fact({ action: "progress_reported", reportKind: "question", note: "Which?" })]);
    const moved: DispatcherNote = { taskId: "t1", projectId: "p1", title: "Task one", kind: "status_changed", detail: "todo → blocked", at: now };
    b.pushNotes([moved, { ...moved, taskId: "t9" }]);
    b.pushNotes([]);
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([
      { taskId: "t1", projectId: "p1", title: "Task one", kind: "question", detail: "Which?", later: "todo → blocked", at: now },
      { ...moved, taskId: "t9" },
    ]);
  });

  test("a flush that throws is logged and the next batch still goes out", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let first = true;
    const b = new NoteBatcher({ windowMs: 10_000, maxWaitMs: 60_000, exclude: () => null }, (notes) => {
      if (first) {
        first = false;
        throw new Error("down");
      }
      flushed.push(notes);
    });
    b.push([fact({ action: "status_changed", to: "done" })]);
    vi.advanceTimersByTime(10_000);
    b.push([fact({ action: "status_changed", to: "cancelled" })]);
    vi.advanceTimersByTime(10_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0][0].detail).toBe("→ cancelled");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("RestoreRepeats", () => {
  const restore = (patch: Partial<BoardEvent> = {}, taskId = "t1") =>
    fact({ taskId, actor: "system", rule: "A1r", from: "development", to: "in_review", note: "No work was reported in that turn; restored", ...patch });
  const passes = (r: RestoreRepeats, ...facts: BusFact[]) => r.filter(facts).length;

  test("an identical restore right after another is dropped", () => {
    const r = new RestoreRepeats();
    const first = restore();
    expect(r.filter([first])).toEqual([first]);
    expect(passes(r, restore())).toBe(0);
  });
  test("real work between two restores lets the second through", () => {
    const r = new RestoreRepeats();
    expect(passes(r, restore())).toBe(1);
    expect(passes(r, fact({ action: "progress_reported", reportKind: "progress" }))).toBe(1);
    expect(passes(r, restore())).toBe(1);
  });
  test("a restore with a different move passes", () => {
    const r = new RestoreRepeats();
    expect(passes(r, restore())).toBe(1);
    expect(passes(r, restore({ from: "test" }))).toBe(1);
  });
  test("neutral facts do not clear the entry", () => {
    for (const neutral of [
      fact({ action: "next_moves_suggested" }),
      fact({ actor: "system", rule: "A1", from: "in_review", to: "development" }),
      fact({ action: "agent.turn_started" }),
      fact({ action: "agent.turn_ended", outcome: "completed" }),
      fact({ action: "agent.turn_ended", outcome: "canceled" }),
      fact({ action: "agent.permission_requested" }),
      fact({ actor: "system", action: "task_edited" }),
    ]) {
      const r = new RestoreRepeats();
      r.filter([restore()]);
      expect(passes(r, neutral, restore())).toBe(1);
    }
  });
  test("a human change, a failed turn or another rule clears the entry", () => {
    for (const clearing of [
      fact({ actor: "human", action: "task_edited" }),
      fact({ action: "agent.turn_ended", outcome: "failed" }),
      fact({ actor: "system", rule: "A5", from: "development", to: "test" }),
    ]) {
      const r = new RestoreRepeats();
      r.filter([restore()]);
      expect(passes(r, clearing, restore())).toBe(2);
    }
  });
  test("cards are independent and non-board facts pass", () => {
    const r = new RestoreRepeats();
    expect(passes(r, restore({}, "t1"), restore({}, "t2"))).toBe(2);
    expect(passes(r, restore({}, "t2"))).toBe(0);
    expect(passes(r, restore({}, "t1"), restore({}, "t2"))).toBe(0);
    expect(passes(r, { kind: "permission_resolved", agentId: "a", requestId: "r" })).toBe(1);
  });
});
