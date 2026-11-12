import { expect, test } from "vitest";
import { boardOverview, mergeRunning, overviewRow, runningRows } from "./overview";
import type { Task, Project } from "../shared/model";
import type { AttentionItem } from "./attention";

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}) =>
  ({ id, projectId: "p", workspaceId: `w-${id}`, status, archivedAt: null, ...extra }) as Task;
const project = { id: "p" } as Project;
const item = (t: Task, extra: Partial<AttentionItem>) =>
  ({ task: t, project, permissions: 0, errors: 0, unread: 0, questions: 0, silent: 0, sessionId: null, updatedAt: "" , ...extra }) as AttentionItem;

test("overview counts live cards, working sessions and what needs you", () => {
  const tasks = [
    task("a", "development"),
    task("b", "in_review"),
    task("c", "done"),
    task("d", "blocked"),
    task("e", "todo", { archivedAt: "2026-10-15T00:00:00Z" }),
    task("x", "todo", { projectId: "other" }),
  ];
  const agents = [
    { workspaceId: "w-a", status: "running" },
    { workspaceId: "w-a", status: "initializing" },
    { workspaceId: "w-b", status: "idle" },
    { workspaceId: "w-e", status: "running" }, // archived card
    { workspaceId: "w-a", status: "running", archivedAt: "2026-10-15T00:00:00Z" },
  ];
  const attention = [item(tasks[0], { questions: 1 }), item(tasks[1], { unread: 1 }), item(tasks[3], { errors: 1, unread: 1 })];
  expect(boardOverview([project], tasks, agents, attention)).toEqual({
    total: 4,
    done: 1,
    runningTasks: 1,
    runningSessions: 2,
    needsYou: 1,
    unread: 2,
    errors: 1,
  });
  // A Done lane that is off reports null (hidden), not zero. The In review / Blocked lane chips are gone (Ruling, Noah 2026-11-09).
  const lanes = (["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "done" }));
  expect(boardOverview([{ ...project, lanes }], tasks.filter((t) => t.status !== "done"), [], []).done).toBeNull();
});

test("a group board's overview sums its projects; done counts the projects whose Done lane is on (Ruling, Noah 2026-11-10)", () => {
  const q = { id: "q" } as Project;
  const tasks = [task("a", "done"), task("b", "todo"), task("c", "done", { projectId: "q" }), task("d", "todo", { projectId: "other" })];
  const agents = [{ workspaceId: "w-a", status: "running" }, { workspaceId: "w-c", status: "running" }, { workspaceId: "w-d", status: "running" }];
  const attention = [item(tasks[1], { questions: 1 }), { ...item(tasks[2], { permissions: 1 }), project: q }, { ...item(tasks[3], { questions: 1 }), project: { id: "other" } as Project }];
  const both = boardOverview([project, q], tasks, agents, attention);
  expect(both).toMatchObject({ total: 3, done: 2, runningTasks: 2, needsYou: 2 });
  const lanes = (["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "done" }));
  expect(boardOverview([project, { ...q, lanes }], tasks, agents, attention).done).toBe(1);
  expect(boardOverview([{ ...project, lanes }, { ...q, lanes }], tasks, agents, attention).done).toBeNull();
  expect(boardOverview([], tasks, agents, attention)).toMatchObject({ total: 0, runningTasks: 0, needsYou: 0 });
});

test("the overview row: running only while something runs, one need-you chip, updated apart, dividers only between shown groups", () => {
  const base = { runningTasks: 0, needYou: 0, updated: 0 };
  const none = { ideas: false, memory: false, insights: false };
  expect(overviewRow(base, none)).toEqual({ running: false, needYou: false, updated: false, statusDivider: false, toolsDivider: false });
  expect(overviewRow(base, { ...none, ideas: true })).toEqual({ running: false, needYou: false, updated: false, statusDivider: true, toolsDivider: false });
  expect(overviewRow({ ...base, runningTasks: 2 }, none)).toEqual({ running: true, needYou: false, updated: false, statusDivider: true, toolsDivider: false });
  expect(overviewRow({ ...base, needYou: 3 }, { ...none, insights: true })).toEqual({ running: false, needYou: true, updated: false, statusDivider: true, toolsDivider: true });
  expect(overviewRow({ ...base, updated: 2 }, none)).toEqual({ running: false, needYou: false, updated: true, statusDivider: true, toolsDivider: false });
});

test("running list: running cards, oldest first; none running is empty", () => {
  const tasks = [task("a", "development", { title: "A" }), task("b", "test", { title: "B" }), task("c", "todo"), task("e", "todo", { archivedAt: "2026-10-15T00:00:00Z" })];
  const agents = [
    { workspaceId: "w-a", status: "running", activeTurn: { startedAt: "2026-11-12T10:05:00Z" } },
    { workspaceId: "w-b", status: "initializing", activeTurn: { startedAt: "2026-11-12T10:00:00Z" } },
    { workspaceId: "w-c", status: "idle" },
    { workspaceId: "w-e", status: "running" },
  ];
  expect(runningRows([project], tasks, agents).map((r) => r.taskId)).toEqual(["b", "a"]);
  expect(runningRows([project], tasks, agents.map((a) => ({ ...a, status: "idle" })))).toEqual([]);
});

test("running list: a session that ends while it is open stays, marked ended, and new ones append", () => {
  const tasks = [task("a", "development"), task("b", "test"), task("d", "development")];
  const run = (...ws: string[]) => runningRows([project], tasks, ws.map((w) => ({ workspaceId: `w-${w}`, status: "running", activeTurn: { startedAt: `2026-11-12T10:0${w === "a" ? 1 : w === "b" ? 2 : 3}:00Z` } })));
  const open = mergeRunning([], run("a", "b"));
  expect(open.map((r) => [r.taskId, r.ended])).toEqual([["a", false], ["b", false]]);
  const next = mergeRunning(open, run("b", "d"));
  expect(next.map((r) => [r.taskId, r.ended])).toEqual([["a", true], ["b", false], ["d", false]]);
  expect(mergeRunning(next, run("a", "b", "d")).map((r) => [r.taskId, r.ended])).toEqual([["a", false], ["b", false], ["d", false]]);
});
