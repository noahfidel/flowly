import { expect, test } from "vitest";
import type { Board, BoardEvent, Status } from "../shared/model";
import { applyTurnStarted, recordLifecycle } from "./progress-rules";
import { cardQuestions, openQuestion, silentTurn } from "../shared/progress";

const now = "2026-10-15T00:00:00.000Z";
function board(status: Status, extra: { autoStatus?: boolean; archived?: boolean } = {}): Board {
  return {
    version: 5,
    revision: 1,
    projects: [{
      id: "p", title: "P", description: "", paseoProjectId: "n", primaryPath: "/p", repos: ["/p"],
      revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
      ...(extra.autoStatus !== undefined ? { autoStatus: extra.autoStatus } : {}),
    }],
    tasks: [{
      id: "t", projectId: "p", workspaceId: "w", sourcePath: "/p", repoPaths: ["/p"], title: "T",
      description: "", status, priority: "normal", position: 0, revision: 1, operationId: "o",
      createdAt: now, updatedAt: now, archivedAt: extra.archived ? now : null,
    }],
    events: [],
    ideas: [],
    links: [],
    artifacts: [],
    workpads: [],
    attentionDismissals: [],
    plans: [],
    groups: [],
    agentReceipts: [],
  } as Board;
}
const store = {
  event(b: Board, input: Omit<BoardEvent, "id" | "at">) {
    const e = { ...input, id: String(b.events.length), at: new Date(Date.parse(now) + b.events.length * 1000).toISOString() };
    b.events.push(e as BoardEvent);
    return e as BoardEvent;
  },
};
const id = { agentId: "a", taskId: "t", workspaceId: "w" };

test("A1 leaves backlog/todo alone: the agent picks the first work stage", () => {
  for (const status of ["backlog", "todo"] as const) {
    const b = board(status);
    expect(applyTurnStarted(store, b, id, "S")).toBe(false);
    expect(b.tasks[0]).toMatchObject({ status, revision: 1 });
    expect(b.events).toHaveLength(0);
  }
});

test("A1 resumes review in Development and blocked in the previous work stage", () => {
  // Review feedback is rework: Development, whatever stage the card was in before.
  for (const stage of ["design", "test"] as const) {
    const b = board("in_review");
    store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "todo", to: stage });
    store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: stage, to: "in_review" });
    expect(applyTurnStarted(store, b, id, "S")).toBe(true);
    expect(b.tasks[0]).toMatchObject({ status: "development", revision: 2 });
    expect(b.events.at(-1)).toMatchObject({ action: "status_changed", actor: "system", rule: "A1", from: "in_review", to: "development" });
  }
  for (const [stage, expected] of [["test", "test"], ["design", "design"], ["in_progress", "development"]] as const) {
    const b = board("blocked");
    store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "todo", to: stage });
    store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: stage, to: "blocked" });
    expect(applyTurnStarted(store, b, id, "S")).toBe(true);
    expect(b.tasks[0]).toMatchObject({ status: expected, revision: 2 });
  }
  // No earlier stage: the first enabled one.
  const fresh = board("blocked");
  expect(applyTurnStarted(store, fresh, id, "S")).toBe(true);
  expect(fresh.tasks[0].status).toBe("design");
});

test("A1 resume skips disabled stages and leaves the card when no stage is enabled", () => {
  const lanes = (on: (s: Status) => boolean) =>
    (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: on(status) }));
  const b = board("blocked");
  b.projects[0].lanes = lanes((s) => s !== "test");
  store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "development", to: "test" });
  store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "development", to: "development" });
  b.events.reverse();
  // Latest stage (test) is off: falls back to the latest enabled one.
  expect(applyTurnStarted(store, b, id, "S")).toBe(true);
  expect(b.tasks[0].status).toBe("development");
  // Review with Development off: the latest enabled stage, else the first enabled one.
  const noDev = board("in_review");
  noDev.projects[0].lanes = lanes((s) => s !== "development");
  expect(applyTurnStarted(store, noDev, id, "S")).toBe(true);
  expect(noDev.tasks[0].status).toBe("design");
  const none = board("in_review");
  none.projects[0].lanes = lanes((s) => !["design", "development", "test"].includes(s));
  expect(applyTurnStarted(store, none, id, "S")).toBe(false);
  expect(none.tasks[0].status).toBe("in_review");
});

test("A1 never touches finished, already active, archived, opted-out or unbound cards", () => {
  for (const status of ["done", "cancelled", "design", "development", "test"] as const) {
    const b = board(status);
    expect(applyTurnStarted(store, b, id, "S")).toBe(false);
    expect(b.tasks[0].status).toBe(status);
  }
  expect(applyTurnStarted(store, board("in_review", { archived: true }), id, "S")).toBe(false);
  expect(applyTurnStarted(store, board("in_review", { autoStatus: false }), id, "S")).toBe(false);
  expect(applyTurnStarted(store, board("in_review"), { ...id, workspaceId: "other" }, "S")).toBe(false);
  expect(applyTurnStarted(store, board("in_review"), { ...id, taskId: "missing" }, "S")).toBe(false);
});

test("lifecycle records carry the outcome; failures keep a short reason", () => {
  const b = board("development");
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "failed", error: { message: "x".repeat(900) } });
  expect(b.events[0]).toMatchObject({ action: "agent.turn_ended", outcome: "failed", agentId: "a" });
  expect(b.events[0].note).toHaveLength(500);
  recordLifecycle(store, b, { ...id, workspaceId: "other" }, "agent.turn_started");
  expect(b.events).toHaveLength(1);
});

test("turn_ended can carry the session's model and the pick; nothing is written for a missing value", () => {
  const b = board("development");
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, { model: "codex/gpt-6-luna", pick: 0 });
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, { model: "", pick: -1 });
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, {});
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" });
  expect(b.events[0]).toMatchObject({ model: "codex/gpt-6-luna", pick: 0 });
  expect(b.events[1]).toMatchObject({ pick: -1 });
  expect(b.events[1]).not.toHaveProperty("model");
  for (const e of b.events.slice(2)) {
    expect(e).not.toHaveProperty("model");
    expect(e).not.toHaveProperty("pick");
  }
});

test("turn_ended records byUser (false included); permission requests record only the tool name", () => {
  const b = board("development");
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, { byUser: true });
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, { byUser: false });
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "completed" }, {});
  recordLifecycle(store, b, id, "agent.permission_requested", undefined, { tool: "Bash".padEnd(120, "x") });
  expect(b.events[0].byUser).toBe(true);
  expect(b.events[1].byUser).toBe(false);
  expect(b.events[2]).not.toHaveProperty("byUser");
  expect(b.events[3].tool).toHaveLength(80);
  expect(b.events[3].tool!.startsWith("Bash")).toBe(true);
});

const ev = (action: string, at: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({
  id: `${action}-${at}`, taskId: "t", actor: action.startsWith("agent.") ? "system" : "agent",
  action, agentId: "a", at: new Date(Date.parse(now) + at * 1000).toISOString(), ...extra,
} as BoardEvent);

test("a question stays open until the session starts its next turn or reports again", () => {
  const asked = [ev("agent.turn_started", 1), ev("progress_reported", 2, { reportKind: "question", note: "Which DB?" }), ev("agent.turn_ended", 3)];
  expect(openQuestion(asked, "a")?.note).toBe("Which DB?");
  expect(cardQuestions({ id: "t" }, asked)).toHaveLength(1);
  expect(openQuestion([...asked, ev("agent.turn_started", 4)], "a")).toBeNull();
  expect(openQuestion([...asked.slice(0, 2), ev("progress_reported", 3, { reportKind: "progress" })], "a")).toBeNull();
  expect(openQuestion(asked, "other")).toBeNull();
});

test("silent turn: ended without any report while the card is in a work stage", () => {
  const silent = [ev("agent.turn_started", 1), ev("agent.turn_ended", 2, { outcome: "completed" })];
  expect(silentTurn({ status: "development" }, silent, "a")).toBe(true);
  expect(silentTurn({ status: "design" }, silent, "a")).toBe(true);
  expect(silentTurn({ status: "test" }, silent, "a")).toBe(true);
  expect(silentTurn({ status: "in_review" }, silent, "a")).toBe(false);
  const reported = [ev("agent.turn_started", 1), ev("progress_reported", 2), ev("agent.turn_ended", 3)];
  expect(silentTurn({ status: "development" }, reported, "a")).toBe(false);
  expect(silentTurn({ status: "development" }, [...silent, ev("agent.turn_started", 3)], "a")).toBe(false);
  expect(silentTurn({ status: "development" }, [ev("agent.turn_started", 1), ev("agent.turn_ended", 2, { outcome: "failed" })], "a")).toBe(false);
  // Updating the workpad is a report of work (WORKPAD-SPEC §2.3), but does not answer a question.
  const padded = [ev("agent.turn_started", 1), ev("workpad_updated", 2), ev("agent.turn_ended", 3, { outcome: "completed" })];
  expect(silentTurn({ status: "development" }, padded, "a")).toBe(false);
  const asked = [ev("agent.turn_started", 1), ev("progress_reported", 2, { reportKind: "question" }), ev("workpad_updated", 3), ev("agent.turn_ended", 4)];
  expect(openQuestion(asked, "a")).not.toBeNull();
});

test("A1r restores review/blocked when a resumed turn ends without any report", async () => {
  const { applyTurnEnded } = await import("./progress-rules");
  const done = { kind: "completed" } as const;
  // casual message: resumed from review, nothing reported -> back to review
  const b = board("in_review");
  recordLifecycle(store, b, id, "agent.turn_started");
  applyTurnStarted(store, b, id, "S");
  expect(applyTurnEnded(store, b, id, done)).toBe(true);
  expect(b.tasks[0]).toMatchObject({ status: "in_review", revision: 3 });
  expect(b.events.at(-1)).toMatchObject({ rule: "A1r", from: "development", to: "in_review" });
  // suggested next moves alone are not work (NEXT-MOVES-SPEC §3)
  const n = board("in_review");
  recordLifecycle(store, n, id, "agent.turn_started");
  applyTurnStarted(store, n, id, "S");
  store.event(n, { taskId: "t", actor: "agent", action: "next_moves_suggested", agentId: "a", moves: [{ label: "Commit", prompt: "Commit it" }] });
  expect(applyTurnEnded(store, n, id, done)).toBe(true);
  expect(n.tasks[0].status).toBe("in_review");
  // a report that carries its suggestion in the same write is still a report (NEXT-MOVES-SPEC §8.7)
  for (const moves of [[{ label: "Commit", prompt: "Commit it" }], []]) {
    const r = board("in_review");
    recordLifecycle(store, r, id, "agent.turn_started");
    applyTurnStarted(store, r, id, "S");
    store.event(r, { taskId: "t", actor: "agent", action: "progress_reported", agentId: "a", note: "done", reportKind: "result" });
    store.event(r, { taskId: "t", actor: "agent", action: "next_moves_suggested", agentId: "a", moves });
    expect(applyTurnEnded(store, r, id, done)).toBe(false);
    expect(r.tasks[0].status).toBe("development");
  }
  // real work reported -> stays in progress
  const w = board("blocked");
  recordLifecycle(store, w, id, "agent.turn_started");
  applyTurnStarted(store, w, id, "S");
  store.event(w, { taskId: "t", actor: "agent", action: "progress_reported", agentId: "a", note: "fixing" });
  expect(applyTurnEnded(store, w, id, done)).toBe(false);
  expect(w.tasks[0].status).toBe("design");
  // started from todo (not a resume), failed turns, or a later human move -> untouched
  const t = board("todo");
  recordLifecycle(store, t, id, "agent.turn_started");
  applyTurnStarted(store, t, id, "S");
  expect(applyTurnEnded(store, t, id, done)).toBe(false);
  const f = board("in_review");
  recordLifecycle(store, f, id, "agent.turn_started");
  applyTurnStarted(store, f, id, "S");
  expect(applyTurnEnded(store, f, id, { kind: "failed", error: { message: "x" } })).toBe(false);
  const h = board("in_review");
  recordLifecycle(store, h, id, "agent.turn_started");
  applyTurnStarted(store, h, id, "S");
  store.event(h, { taskId: "t", actor: "human", action: "status_changed", from: "development", to: "development" });
  expect(applyTurnEnded(store, h, id, done)).toBe(false);
});

test("A1 resumes a committed card in Development; A1r restores Committed when nothing was reported", async () => {
  const { applyTurnEnded } = await import("./progress-rules");
  const done = { kind: "completed" } as const;
  const b = board("committed");
  store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "in_review", to: "committed" });
  recordLifecycle(store, b, id, "agent.turn_started");
  expect(applyTurnStarted(store, b, id, "S")).toBe(true);
  expect(b.tasks[0]).toMatchObject({ status: "development", revision: 2 });
  expect(b.events.at(-1)).toMatchObject({ rule: "A1", from: "committed", to: "development" });
  expect(applyTurnEnded(store, b, id, done)).toBe(true);
  expect(b.tasks[0]).toMatchObject({ status: "committed", revision: 3 });
  expect(b.events.at(-1)).toMatchObject({ rule: "A1r", from: "development", to: "committed" });
  // Work reported: stays in Development.
  const w = board("committed");
  recordLifecycle(store, w, id, "agent.turn_started");
  applyTurnStarted(store, w, id, "S");
  store.event(w, { taskId: "t", actor: "agent", action: "progress_reported", agentId: "a", note: "fixing" });
  expect(applyTurnEnded(store, w, id, done)).toBe(false);
  expect(w.tasks[0].status).toBe("development");
  // Development off: the first enabled work stage, like In review.
  const noDev = board("committed");
  noDev.projects[0].lanes = (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "development" }));
  expect(applyTurnStarted(store, noDev, id, "S")).toBe(true);
  expect(noDev.tasks[0].status).toBe("design");
});

test("A1 resumes an integrated card in Development; A1r restores Integrated when nothing was reported (INTEGRATED-STAGE-SPEC §4)", async () => {
  const { applyTurnEnded } = await import("./progress-rules");
  const done = { kind: "completed" } as const;
  const b = board("integrated");
  store.event(b, { taskId: "t", actor: "agent", action: "status_changed", from: "committed", to: "integrated" });
  recordLifecycle(store, b, id, "agent.turn_started");
  expect(applyTurnStarted(store, b, id, "S")).toBe(true);
  expect(b.tasks[0]).toMatchObject({ status: "development", revision: 2 });
  expect(b.events.at(-1)).toMatchObject({ rule: "A1", from: "integrated", to: "development" });
  expect(applyTurnEnded(store, b, id, done)).toBe(true);
  expect(b.tasks[0]).toMatchObject({ status: "integrated", revision: 3 });
  expect(b.events.at(-1)).toMatchObject({ rule: "A1r", from: "development", to: "integrated" });
  // Work reported: stays in Development.
  const w = board("integrated");
  recordLifecycle(store, w, id, "agent.turn_started");
  applyTurnStarted(store, w, id, "S");
  store.event(w, { taskId: "t", actor: "agent", action: "progress_reported", agentId: "a", note: "fixing" });
  expect(applyTurnEnded(store, w, id, done)).toBe(false);
  expect(w.tasks[0].status).toBe("development");
  // Development off: the first enabled work stage.
  const noDev = board("integrated");
  noDev.projects[0].lanes = (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "development" }));
  expect(applyTurnStarted(store, noDev, id, "S")).toBe(true);
  expect(noDev.tasks[0].status).toBe("design");
});
