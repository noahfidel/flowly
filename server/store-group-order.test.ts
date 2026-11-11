import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { BoardStore } from "./store";
import { readDatabaseFile } from "./sqlite-storage";
import { emptyBoard, type Board, type Project, type Status, type Task } from "../shared/model";
import type { LegacyGroup } from "../shared/groups";

/** One manual order per group column in the store (BOARD-GROUPS-SPEC §0 manual order ruling, §1, §2, §7 step 8). */

const directories: string[] = [];
const stores: BoardStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "flowly-group-order-")));
  directories.push(path);
  return path;
}
type Backend = "json" | "sqlite";
function open(backend: Backend, path: string) {
  const store = new BoardStore(path, backend === "sqlite" ? { backend, storage: { checkVersion: false } } : {});
  stores.push(store);
  return store;
}
async function onDisk(backend: Backend, path: string): Promise<Board> {
  if (backend === "sqlite") return readDatabaseFile(sqlite, join(path, "flowly.sqlite"));
  return JSON.parse(await readFile(join(path, "board.json"), "utf8"));
}
const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, n)).toISOString();
const project = (id: string, extra: Partial<Project> = {}): Project => ({
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
  ...extra,
});
const task = (id: string, projectId: string, status: Status, position: number, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: `/${projectId}`,
  repoPaths: [],
  title: id,
  description: "",
  status,
  priority: "normal",
  position,
  revision: 3,
  operationId: `op-${id}`,
  createdAt: at(1),
  updatedAt: at(1),
  archivedAt: null,
  ...extra,
});
async function seed(path: string, projects: Project[], tasks: Task[], groups?: unknown[]) {
  const board = emptyBoard() as Record<string, unknown>;
  if (groups) board.groups = groups;
  else delete board.groups;
  board.revision = 4;
  board.projects = projects;
  board.tasks = tasks;
  await writeFile(join(path, "board.json"), JSON.stringify(board));
}
const legacy = (groups: LegacyGroup[]) => async () => groups;
const column = (board: Board, status: Status, projectIds?: string[]) =>
  board.tasks
    .filter((t) => t.status === status && (!projectIds || projectIds.includes(t.projectId)))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .map((t) => t.id);
const place = (id: string, revision: number, status: Status, anchor: { beforeId?: string; afterId?: string } = {}) => ({
  id, revision, status, beforeId: anchor.beforeId ?? null, afterId: anchor.afterId ?? null,
});

describe.each(["json", "sqlite"] as const)("group manual order in the store (%s)", (backend) => {
  /** Zen: a (chooser 0) and b (chooser 1); Other: c. Each project's own order differs from its card creation order. */
  async function ready() {
    const d = await directory();
    await seed(
      d,
      [project("b", { position: 1 }), project("a", { position: 0 }), project("c", { position: 2 })],
      [
        task("b1", "b", "todo", 0),
        task("b2", "b", "todo", 1),
        task("a1", "a", "todo", 4),
        task("a2", "a", "todo", 9),
        task("c1", "c", "todo", 0),
        task("ad", "a", "done", 0),
      ],
    );
    const s = open(backend, d);
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a", "b"] }, { id: "o", name: "Other", projectIds: ["c"] }]))).toBe(true);
    return s;
  }

  test("the start migration stores today's Manual display order and bumps no revision; a second start writes nothing", async () => {
    const s = await ready();
    const board = await onDisk(backend, s.directory);
    expect(column(board, "todo", ["a", "b"])).toEqual(["a1", "a2", "b1", "b2"]);
    expect(board.projects.every((p) => p.orderGroupId === p.groupId)).toBe(true);
    expect(board.tasks.every((t) => t.revision === 3)).toBe(true);
    expect(board.projects.every((p) => p.revision === 1)).toBe(true);
    expect(board.groups.every((g) => g.revision === 1)).toBe(true);
    const before = JSON.stringify(board);
    await s.close();
    stores.splice(stores.indexOf(s), 1);
    const again = open(backend, s.directory);
    expect(await again.migrateGroups(legacy([]))).toBe(true);
    expect(JSON.stringify(await onDisk(backend, s.directory))).toBe(before);
  });

  test("a board that already has groups gets its group order at the next start, from the projects' chooser order", async () => {
    const d = await directory();
    const group = { id: "g", name: "Zen", position: 0, isDefault: true, revision: 2, createdAt: at(0), updatedAt: at(0) };
    await seed(
      d,
      [project("b", { position: 1, groupId: "g" }), project("a", { position: 0, groupId: "g" })],
      [task("b1", "b", "todo", 0), task("a1", "a", "todo", 7)],
      [group],
    );
    const s = open(backend, d);
    expect(await s.migrateGroups(legacy([]))).toBe(true);
    const board = await onDisk(backend, d);
    expect(column(board, "todo")).toEqual(["a1", "b1"]);
    expect(board.groups[0].revision).toBe(2);
  });

  test("a drop between two cards of another project of the group interleaves the projects", async () => {
    const s = await ready();
    const before = await s.read();
    const b2 = before.tasks.find((t) => t.id === "b2")!;
    await s.placeTask(place("b2", b2.revision, "todo", { beforeId: "a2" }));
    const after = await s.read();
    expect(column(after, "todo", ["a", "b"])).toEqual(["a1", "b2", "a2", "b1"]);
    // The filtered board shows the group order restricted to that project.
    expect(column(after, "todo", ["b"])).toEqual(["b2", "b1"]);
    // Only the moved card's revision changes.
    expect(after.tasks.filter((t) => t.id !== "b2").map((t) => t.revision)).toEqual(before.tasks.filter((t) => t.id !== "b2").map((t) => t.revision));
    expect(after.tasks.find((t) => t.id === "b2")!.revision).toBe(b2.revision + 1);
  });

  test("a cross-column drop may anchor on another project's card of the group", async () => {
    const s = await ready();
    const a1 = (await s.read()).tasks.find((t) => t.id === "a1")!;
    await s.placeTask(place("a1", a1.revision, "todo", { afterId: "b1" }));
    const b1 = (await s.read()).tasks.find((t) => t.id === "b1")!;
    await s.placeTask(place("b1", b1.revision, "done", { beforeId: "ad" }));
    const after = await s.read();
    expect(column(after, "todo", ["a", "b"])).toEqual(["a2", "a1", "b2"]);
    expect(column(after, "done", ["a", "b"])).toEqual(["b1", "ad"]);
  });

  test("an anchor in another group, or a stale revision, is refused and nothing is written", async () => {
    const s = await ready();
    const a1 = (await s.read()).tasks.find((t) => t.id === "a1")!;
    const source = JSON.stringify(await onDisk(backend, s.directory));
    await expect(s.placeTask(place("a1", a1.revision, "todo", { beforeId: "c1" }))).rejects.toThrow("Drop position changed");
    await expect(s.placeTask(place("a1", a1.revision - 1, "todo", { beforeId: "b1" }))).rejects.toThrow("Revision conflict");
    expect(JSON.stringify(await onDisk(backend, s.directory))).toBe(source);
  });

  test("a project moved to another group joins the end of its columns, keeping its own order; nobody else's position moves", async () => {
    const s = await ready();
    let board = await s.read();
    const b2 = board.tasks.find((t) => t.id === "b2")!;
    await s.placeTask(place("b2", b2.revision, "todo", { beforeId: "a1" }));
    board = await s.read();
    const before = new Map(board.tasks.map((t) => [t.id, t.position]));
    const other = board.groups.find((g) => g.name === "Other")!;
    const b = board.projects.find((p) => p.id === "b")!;
    await s.setProjectGroup({ projectId: "b", revision: b.revision, groupId: other.id });
    const after = await onDisk(backend, s.directory);
    expect(column(after, "todo", ["c", "b"])).toEqual(["c1", "b2", "b1"]);
    expect(column(after, "todo", ["a"])).toEqual(["a1", "a2"]);
    for (const id of ["a1", "a2", "c1", "ad"]) expect(after.tasks.find((t) => t.id === id)!.position).toBe(before.get(id));
    expect(after.projects.find((p) => p.id === "b")!.orderGroupId).toBe(other.id);
    expect(after.tasks.filter((t) => t.projectId === "b").every((t) => t.revision === board.tasks.find((x) => x.id === t.id)!.revision)).toBe(true);
  });

  test("deleting a group appends its projects' cards to the default group's columns", async () => {
    const s = await ready();
    const board = await s.read();
    const zen = board.groups.find((g) => g.name === "Zen")!;
    const other = board.groups.find((g) => g.name === "Other")!;
    await s.updateGroup({ id: other.id, revision: other.revision, isDefault: true });
    await s.deleteGroup({ id: zen.id, revision: (await s.read()).groups.find((g) => g.id === zen.id)!.revision });
    const after = await onDisk(backend, s.directory);
    expect(column(after, "todo")).toEqual(["c1", "a1", "a2", "b1", "b2"]);
  });
});

describe("before groups are ready, the order stays per project", () => {
  test("a store whose migration never ran refuses an anchor in another project", async () => {
    const d = await directory();
    await seed(d, [project("a", { groupId: "g", orderGroupId: "g" }), project("b", { groupId: "g", orderGroupId: "g" })], [task("a1", "a", "todo", 0), task("b1", "b", "todo", 1)], [
      { id: "g", name: "Zen", position: 0, isDefault: true, revision: 1, createdAt: at(0), updatedAt: at(0) },
    ]);
    const s = open("json", d);
    // groupsReady is false: no migration in this process.
    await expect(s.placeTask(place("a1", 3, "todo", { afterId: "b1" }))).rejects.toThrow("Drop position changed");
  });
});
