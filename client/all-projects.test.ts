import { describe, expect, test } from "vitest";
import {
  allProjectsAvailable,
  allQuickProject,
  allStatuses,
  dropAllowed,
  includedProjects,
  matchesFilters,
  newTaskOpen,
  reorderAllowed,
  scopeTasks,
  sortAllColumn,
} from "./all-projects";
import { statuses, type Project, type Status, type Task } from "../shared/model";

const project = (id: string, over: Partial<Project> = {}): Project =>
  ({
    id,
    paseoProjectId: `native-${id}`,
    title: id,
    description: "",
    primaryPath: `/tmp/${id}`,
    repos: [],
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    ...over,
  }) as Project;

const card = (id: string, projectId: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    projectId,
    workspaceId: `ws-${id}`,
    title: id,
    description: "",
    status: "todo",
    priority: "normal",
    position: 0,
    revision: 1,
    tags: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    ...over,
  }) as Task;

/** Lanes with only `on` enabled. */
const onlyLanes = (on: Status[]) => statuses.map((status) => ({ status, enabled: on.includes(status) }));

const a = project("a", { position: 1 }),
  b = project("b", { position: 0 }),
  gone = project("gone", { position: 2, archivedAt: "2026-11-02T00:00:00.000Z" });

describe("availability (ALL-PROJECTS-SPEC §1)", () => {
  test("needs the setting and two or more live projects", () => {
    expect(allProjectsAvailable([a, b], true)).toBe(true);
    expect(allProjectsAvailable([a, b], false)).toBe(false);
    expect(allProjectsAvailable([a, gone], true)).toBe(false);
    expect(allProjectsAvailable([], true)).toBe(false);
  });
  test("included projects are the live ones in chooser order", () => {
    expect(includedProjects([a, gone, b]).map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("columns (§2)", () => {
  test("a status shows when enabled in at least one included project, in built-in order", () => {
    const x = project("x", { lanes: onlyLanes(["todo", "done"]) });
    const y = project("y", { lanes: onlyLanes(["backlog", "in_review", "done"]) });
    expect(allStatuses([x, y])).toEqual(["backlog", "todo", "in_review", "done"]);
  });
  test("an archived project adds no column", () => {
    const x = project("x", { lanes: onlyLanes(["todo"]) });
    const old = project("old", { lanes: onlyLanes(["blocked"]), archivedAt: "2026-11-02T00:00:00.000Z" });
    expect(allStatuses([x, old])).toEqual(["todo"]);
  });
  test("a lane order a project configured does not change All's order", () => {
    const reordered = project("r", { lanes: [...onlyLanes(["todo", "backlog"])].reverse() });
    expect(allStatuses([reordered])).toEqual(["backlog", "todo"]);
  });
});

describe("card list (§3, §6)", () => {
  const tasks = [
    card("a1", "a", { tags: [{ tag: "ui", by: "human", at: "2026-11-01T00:00:00.000Z" }] }),
    card("a2", "a", { archivedAt: "2026-11-03T00:00:00.000Z" }),
    card("b1", "b", { priority: "urgent", title: "Fix login" }),
    card("g1", "gone"),
  ];
  const all = { all: true as const, projectIds: new Set(includedProjects([a, b, gone]).map((p) => p.id)) };
  test("archived projects are excluded, also with Show archived on", () => {
    expect(scopeTasks(tasks, all, false).map((t) => t.id)).toEqual(["a1", "b1"]);
    expect(scopeTasks(tasks, all, true).map((t) => t.id)).toEqual(["a1", "a2", "b1"]);
  });
  test("a project board still shows only its project", () => {
    expect(scopeTasks(tasks, { all: false, projectId: "b" }, true).map((t) => t.id)).toEqual(["b1"]);
  });
  test("filters apply across projects", () => {
    const none = { search: "", priority: "all", taskType: "all", tags: [] };
    const shown = scopeTasks(tasks, all, false);
    expect(shown.filter((t) => matchesFilters(t, { ...none, priority: "urgent" })).map((t) => t.id)).toEqual(["b1"]);
    expect(shown.filter((t) => matchesFilters(t, { ...none, search: "login" })).map((t) => t.id)).toEqual(["b1"]);
    expect(shown.filter((t) => matchesFilters(t, { ...none, tags: ["ui"] })).map((t) => t.id)).toEqual(["a1"]);
  });
});

describe("order within a column (§4)", () => {
  const rank = new Map([["b", 0], ["a", 1]]);
  const column = [
    card("a-second", "a", { position: 2 }),
    card("b-second", "b", { position: 5, priority: "urgent" }),
    card("a-first", "a", { position: 1 }),
    card("b-first", "b", { position: 3 }),
  ];
  test("Manual groups by project in chooser order and keeps each project's order", () => {
    expect(sortAllColumn(column, "manual", new Map(), rank).map((t) => t.id)).toEqual(["b-first", "b-second", "a-first", "a-second"]);
  });
  test("another sort applies across projects", () => {
    expect(sortAllColumn(column, "priority", new Map(), rank)[0].id).toBe("b-second");
    const activity = new Map([["a-second", "2026-11-04T00:00:00.000Z"]]);
    expect(sortAllColumn(column, "activity", activity, rank)[0].id).toBe("a-second");
  });
});

describe("drag (§4)", () => {
  test("reordering within a column is never allowed in All", () => {
    for (const sort of ["manual", "activity", "priority", "created", "title"] as const) expect(reorderAllowed(true, sort)).toBe(false);
  });
  test("a project board reorders only with Manual", () => {
    expect(reorderAllowed(false, "manual")).toBe(true);
    expect(reorderAllowed(false, "priority")).toBe(false);
  });
  test("a drop on a status the card's project has no lane for is refused", () => {
    const x = project("x", { lanes: onlyLanes(["todo", "done"]) });
    expect(dropAllowed(x, "done")).toBe(true);
    expect(dropAllowed(x, "in_review")).toBe(false);
    expect(dropAllowed(undefined, "todo")).toBe(false);
  });
});

describe("new task (§5)", () => {
  test("All always opens Quick task with the last quick-task project, keeping the lane", () => {
    expect(newTaskOpen({ all: true, quickDefault: false, status: "backlog", pinned: "a", current: "a" })).toEqual({ kind: "quick", status: "backlog", recent: true });
  });
  test("a project board keeps its rules", () => {
    expect(newTaskOpen({ all: false, quickDefault: true, status: "todo", current: "a" })).toEqual({ kind: "quick", status: "todo", projectId: "a" });
    expect(newTaskOpen({ all: false, quickDefault: true, status: "todo", pinned: "b", current: "a" })).toEqual({ kind: "quick", status: "todo", projectId: "b" });
    expect(newTaskOpen({ all: false, quickDefault: false, status: "todo", current: "a" })).toEqual({ kind: "form", status: "todo" });
  });
  test("the project is the last quick-task one when live, else the first live one in chooser order", () => {
    expect(allQuickProject([a, b], "a")?.id).toBe("a");
    expect(allQuickProject([a, b, gone], "gone")?.id).toBe("b");
    expect(allQuickProject([a, b], "")?.id).toBe("b");
  });
});
