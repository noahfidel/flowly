import { describe, expect, test } from "vitest";
import { columnEnd, neighborCard, orderScope, syncGroupOrder } from "./group-order";
import type { Group, Project, Status, Task } from "./model";

/** One manual order per column over a group's projects (BOARD-GROUPS-SPEC §0 manual order ruling, §1, §7 step 8). */

const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, n)).toISOString();
const project = (id: string, groupId: string | undefined, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `native-${id}`,
  primaryPath: `/${id}`,
  repos: [`/${id}`],
  revision: 1,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  ...(groupId ? { groupId } : {}),
  ...extra,
});
const task = (id: string, projectId: string, status: Status, position: number, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: "/",
  repoPaths: [],
  title: id,
  description: "",
  status,
  priority: "normal",
  position,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at(1),
  updatedAt: at(1),
  archivedAt: null,
  ...extra,
});
const group = (id: string): Group => ({ id, name: id, position: 0, revision: 1, createdAt: at(0), updatedAt: at(0) });
type OrderBoard = { groups: Group[]; projects: Project[]; tasks: Task[] };
/** A column in the group's manual order (position, then creation), as the group board shows it with Manual. */
const column = (board: OrderBoard, status: Status, projectIds?: string[]) =>
  board.tasks
    .filter((t) => t.status === status && (!projectIds || projectIds.includes(t.projectId)))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.id);

describe("syncGroupOrder: the migration to one order per group column", () => {
  test("the first order is today's Manual display: projects in chooser order, each keeping its own order", () => {
    const board: OrderBoard = {
      groups: [group("g")],
      projects: [project("b", "g", { position: 1 }), project("a", "g", { position: 0 })],
      tasks: [
        task("b1", "b", "todo", 0),
        task("b2", "b", "todo", 7),
        task("a2", "a", "todo", 5),
        task("a1", "a", "todo", -3),
        task("a3", "a", "todo", 5.5, { archivedAt: at(2) }),
        task("bd", "b", "done", 0),
        task("ad", "a", "done", 9),
      ],
    };
    const result = syncGroupOrder(board);
    expect(result.changed).toBe(true);
    expect(column(board, "todo")).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(column(board, "done")).toEqual(["ad", "bd"]);
    // Each project's own order (what a filtered board and agents read) is unchanged.
    expect(column(board, "todo", ["a"])).toEqual(["a1", "a2", "a3"]);
    expect(board.projects.map((p) => p.orderGroupId)).toEqual(["g", "g"]);
    // No revision moves: positions are presentation (DRAG-REORDER-SPEC amendment).
    expect(board.tasks.every((t) => t.revision === 1)).toBe(true);
    expect(board.projects.every((p) => p.revision === 1)).toBe(true);
  });
  test("archived projects follow the live ones, so the live display order is unchanged", () => {
    const board: OrderBoard = {
      groups: [group("g")],
      projects: [project("old", "g", { position: 0, archivedAt: at(1) }), project("a", "g", { position: 1 })],
      tasks: [task("o1", "old", "todo", 0), task("a1", "a", "todo", 4)],
    };
    syncGroupOrder(board);
    expect(column(board, "todo")).toEqual(["a1", "o1"]);
  });
  test("a second run changes nothing; a project with no group is left alone", () => {
    const board: OrderBoard = {
      groups: [group("g")],
      projects: [project("a", "g"), project("loose", undefined)],
      tasks: [task("a1", "a", "todo", 3), task("l1", "loose", "todo", 9)],
    };
    syncGroupOrder(board);
    const snapshot = JSON.stringify(board);
    expect(syncGroupOrder(board).changed).toBe(false);
    expect(JSON.stringify(board)).toBe(snapshot);
    expect(board.projects[1].orderGroupId).toBeUndefined();
    expect(board.tasks[1].position).toBe(9);
  });
  test("a project that moves to another group joins the end of each of that group's columns", () => {
    const board: OrderBoard = {
      groups: [group("g"), group("h")],
      projects: [project("a", "g", { orderGroupId: "g" }), project("b", "g", { orderGroupId: "g" }), project("c", "h", { orderGroupId: "h" })],
      tasks: [
        task("a1", "a", "todo", 0),
        task("b1", "b", "todo", 0.5),
        task("a2", "a", "todo", 1),
        task("c1", "c", "todo", 0),
        task("c2", "c", "todo", 1),
      ],
    };
    board.projects[2].groupId = "g";
    const before = new Map(board.tasks.map((t) => [t.id, t.position]));
    expect(syncGroupOrder(board)).toEqual({ changed: true, projectIds: ["c"] });
    expect(column(board, "todo", ["a", "b", "c"])).toEqual(["a1", "b1", "a2", "c1", "c2"]);
    // Only the moved project's cards change position.
    for (const id of ["a1", "b1", "a2"]) expect(board.tasks.find((t) => t.id === id)!.position).toBe(before.get(id));
    expect(board.projects[2].orderGroupId).toBe("g");
  });
  test("a new project (no cards yet) is marked without moving anything", () => {
    const board: OrderBoard = { groups: [group("g")], projects: [project("a", "g", { orderGroupId: "g" }), project("n", "g")], tasks: [task("a1", "a", "todo", 2)] };
    expect(syncGroupOrder(board).changed).toBe(true);
    expect(board.projects[1].orderGroupId).toBe("g");
    expect(board.tasks[0].position).toBe(2);
  });
  test("a project whose group is not on the board is left for the group repair", () => {
    const board: OrderBoard = { groups: [group("g")], projects: [project("a", "gone")], tasks: [task("a1", "a", "todo", 2)] };
    expect(syncGroupOrder(board).changed).toBe(false);
    expect(board.projects[0].orderGroupId).toBeUndefined();
  });
});

describe("orderScope and columnEnd", () => {
  const board: OrderBoard = {
    groups: [group("g"), group("h")],
    projects: [
      project("a", "g", { orderGroupId: "g" }),
      project("b", "g", { orderGroupId: "g" }),
      project("x", "g", { orderGroupId: "g", archivedAt: at(1) }),
      project("c", "h", { orderGroupId: "h" }),
      project("loose", undefined),
    ],
    tasks: [task("a1", "a", "todo", 2), task("b1", "b", "todo", 8), task("x1", "x", "todo", 11), task("c1", "c", "todo", 30), task("l1", "loose", "todo", 4)],
  };
  test("a grouped project shares its group's order (archived members too); one with no group has its own", () => {
    expect([...orderScope(board, "a")].sort()).toEqual(["a", "b", "x"]);
    expect([...orderScope(board, "loose")]).toEqual(["loose"]);
    expect([...orderScope(board, "missing")]).toEqual(["missing"]);
  });
  test("a project not yet merged into its group's order keeps its own", () => {
    const unmerged: OrderBoard = { ...board, projects: [project("a", "g"), project("b", "g", { orderGroupId: "g" })] };
    expect([...orderScope(unmerged, "a")]).toEqual(["a"]);
  });
  test("the end of a column is after the group's last card there, so a new card is last in both views", () => {
    expect(columnEnd(board, "a", "todo")).toBe(12);
    expect(columnEnd(board, "c", "todo")).toBe(31);
    expect(columnEnd(board, "loose", "todo")).toBe(5);
    expect(columnEnd(board, "a", "done")).toBe(0);
  });
});

describe("neighborCard (menu Move up / Move down)", () => {
  const board: OrderBoard = {
    groups: [group("g")],
    projects: [project("a", "g", { orderGroupId: "g" }), project("b", "g", { orderGroupId: "g" }), project("x", "g", { orderGroupId: "g", archivedAt: at(1) })],
    tasks: [
      task("a1", "a", "todo", 0),
      task("x1", "x", "todo", 0.5),
      task("b1", "b", "todo", 1),
      task("gone", "a", "todo", 1.5, { archivedAt: at(1) }),
      task("a2", "a", "todo", 2),
    ],
  };
  const of = (id: string) => board.tasks.find((t) => t.id === id)!;
  test("project scope steps over other projects' cards (the filtered board)", () => {
    expect(neighborCard(board, of("a2"), "up", "project")?.id).toBe("a1");
    expect(neighborCard(board, of("a1"), "down", "project")?.id).toBe("a2");
    expect(neighborCard(board, of("a1"), "up", "project")).toBeUndefined();
  });
  test("group scope steps through the group order, skipping archived cards and archived projects", () => {
    expect(neighborCard(board, of("a2"), "up", "group")?.id).toBe("b1");
    expect(neighborCard(board, of("a1"), "down", "group")?.id).toBe("b1");
    expect(neighborCard(board, of("b1"), "up", "group")?.id).toBe("a1");
  });
});
