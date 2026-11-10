import { afterEach, describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { readDatabaseFile, type StorageOptions } from "./sqlite-storage";
import { projectRecords } from "./project-folder";
import { v1DispatcherGuard } from "./group-delete-guard";
import { emptyBoard, groupInput, groupLimits, type Board, type Group, type Project, type Task } from "../shared/model";
import { groupOrder, type LegacyGroup } from "../shared/groups";

/** Board groups in the store (BOARD-GROUPS-SPEC §1, §2, §7, §8), on both backends. */

const directories: string[] = [];
const stores: BoardStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "flowly-groups-test-")));
  directories.push(path);
  return path;
}
type Backend = "json" | "sqlite";
function open(backend: Backend, path: string, storage: StorageOptions = {}) {
  const store = new BoardStore(path, backend === "sqlite" ? { backend, storage: { checkVersion: false, ...storage } } : {});
  stores.push(store);
  return store;
}
async function reopen(backend: Backend, store: BoardStore, storage: StorageOptions = {}) {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  return open(backend, store.directory, storage);
}
/** The stored board, read past the store (no repair). */
async function onDisk(backend: Backend, path: string): Promise<Board> {
  if (backend === "sqlite") return readDatabaseFile(sqlite, join(path, "flowly.sqlite"));
  return JSON.parse(await readFile(join(path, "board.json"), "utf8"));
}
const at = "2026-11-10T10:00:00.000Z";
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `native-${id}`,
  primaryPath: `/${id}`,
  repos: [`/${id}`],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...extra,
});
const task = (id: string, projectId: string, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: `/${projectId}`,
  repoPaths: [],
  title: id,
  description: "",
  status: "todo",
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...extra,
});
/** A board as an install from before groups stored it. */
async function seed(path: string, projects: Project[], tasks: Task[] = []) {
  const board = emptyBoard() as Record<string, unknown>;
  delete board.groups;
  board.revision = 4;
  board.projects = projects;
  board.tasks = tasks;
  await writeFile(join(path, "board.json"), JSON.stringify(board));
}
const legacy = (groups: LegacyGroup[]) => async () => groups;
/** Group name → its projects, in group order; the default is marked with "*". */
function layout(board: Board) {
  return Object.fromEntries(
    [...board.groups].sort(groupOrder).map((g) => [`${g.name}${g.isDefault ? "*" : ""}`, board.projects.filter((p) => p.groupId === g.id).map((p) => p.id)]),
  );
}
const byName = (board: Board, name: string) => board.groups.find((g) => g.name === name)!;
const errors = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

describe.each(["json", "sqlite"] as const)("board groups in the store (%s)", (backend) => {
  /** A migrated store: Zen holds a and the archived old one; b and c are in Projects (the default). */
  async function ready() {
    const d = await directory();
    await seed(d, [project("a"), project("b"), project("c"), project("old", { archivedAt: at })]);
    const s = open(backend, d);
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a", "old", "deleted"] }]))).toBe(true);
    return s;
  }

  test("the migration places the host's groups and ungrouped projects, archived and deleted members per §7", async () => {
    const s = await ready();
    const board = await onDisk(backend, s.directory);
    expect(layout(board)).toEqual({ Zen: ["a", "old"], "Projects*": ["b", "c"] });
    expect(board.revision).toBe(5);
    expect(s.groupsAvailable).toBe(true);
  });

  test("a second start writes nothing; the stored groups win over the setting from then on", async () => {
    const s = await ready();
    const before = JSON.stringify(await onDisk(backend, s.directory));
    const again = await reopen(backend, s);
    expect(await again.migrateGroups(legacy([{ id: "x", name: "Other", projectIds: ["a", "b", "c"] }]))).toBe(true);
    expect(JSON.stringify(await onDisk(backend, s.directory))).toBe(before);
  });

  test("an empty board stays empty; its first project gets the default group Projects", async () => {
    const d = await directory();
    const s = open(backend, d);
    await s.mutate(() => undefined);
    const revision = (await s.read()).revision;
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: [] }]))).toBe(true);
    expect((await s.read()).revision).toBe(revision);
    expect((await s.read()).groups).toEqual([]);
    await s.mutate((board) => void board.projects.push(project("first")));
    expect(layout(await onDisk(backend, d))).toEqual({ "Projects*": ["first"] });
  });

  test("the migration runs before every write queued after it, so the repair never hides the stored groups", async () => {
    const d = await directory();
    await seed(d, [project("a"), project("b")]);
    const s = open(backend, d);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const migrated = s.migrateGroups(async () => {
      await slow;
      return [{ id: "z", name: "Zen", projectIds: ["b"] }];
    });
    const write = s.mutate((board) => void board.projects.push(project("new")));
    release();
    await Promise.all([migrated, write]);
    expect(layout(await onDisk(backend, d))).toEqual({ Zen: ["b"], "Projects*": ["a", "new"] });
  });

  test("before the migration, writes add no groups and group writes are refused", async () => {
    const d = await directory();
    await seed(d, [project("a")]);
    const s = open(backend, d);
    await expect(s.createGroup({ name: "Early" })).rejects.toMatchObject({ code: "GROUPS_UNAVAILABLE" });
    await s.mutate((board) => void board.projects.push(project("b")));
    expect((await onDisk(backend, d)).groups ?? []).toEqual([]);
    expect((await s.read()).groups).toEqual([]);
  });

  test("a failed migration writes nothing, is logged, keeps groups off, and the next start migrates", async () => {
    const d = await directory();
    await seed(d, [project("a"), project("b")]);
    const s = open(backend, d);
    const before = JSON.stringify(await s.read());
    const log = errors();
    expect(await s.migrateGroups(async () => Promise.reject(new Error("EACCES board-view.json")))).toBe(false);
    expect(log).toHaveBeenCalledWith("Flowly board groups migration failed:", "EACCES board-view.json");
    expect(JSON.stringify(await s.read())).toBe(before);
    await expect(s.createGroup({ name: "Later" })).rejects.toMatchObject({ code: "GROUPS_UNAVAILABLE" });
    const next = await reopen(backend, s);
    expect(await next.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a"] }]))).toBe(true);
    expect(layout(await next.read())).toEqual({ Zen: ["a"], "Projects*": ["b"] });
  });

  test("every live project is grouped after create, unarchive and restore; folder copies carry no group", async () => {
    const s = await ready();
    await s.mutate((board) => void board.projects.push(project("fresh")));
    let board = await onDisk(backend, s.directory);
    const fallback = byName(board, "Projects");
    expect(board.projects.find((p) => p.id === "fresh")!.groupId).toBe(fallback.id);
    const old = board.projects.find((p) => p.id === "old")!;
    await s.updateProject({ id: "old", revision: old.revision, archived: false });
    board = await onDisk(backend, s.directory);
    expect(board.projects.find((p) => p.id === "old")!.groupId).toBe(byName(board, "Zen").id);
    // The folder copy of a project has no group; a restore lands in the default group.
    const records = projectRecords(board, "a")!;
    expect(records.project).not.toHaveProperty("groupId");
    const snapshot = { ...records, savedAt: at, project: { ...records.project, id: "restored", groupId: "from-another-board" } };
    await s.restoreProject(snapshot, { primaryPath: "/a", paseoProjectId: "native-restored" });
    board = await onDisk(backend, s.directory);
    expect(board.projects.find((p) => p.id === "restored")!.groupId).toBe(fallback.id);
    for (const p of board.projects) expect(board.groups.some((g) => g.id === p.groupId)).toBe(true);
    expect(board.groups.filter((g) => g.isDefault)).toHaveLength(1);
  });

  test("create: appended with no members; duplicate names (ignoring case), long names and the 51st group are refused", async () => {
    const s = await ready();
    const made = await s.createGroup({ name: "  Loadout ", defaults: { deliveryMode: "draft_pr", agentModel: null } });
    expect(made).toMatchObject({ name: "Loadout", position: 2, revision: 1, defaults: { deliveryMode: "draft_pr" } });
    expect(made.isDefault).toBeUndefined();
    await expect(s.createGroup({ name: "loadout" })).rejects.toMatchObject({ code: "NAME_TAKEN" });
    await expect(s.createGroup({ name: "PROJECTS" })).rejects.toMatchObject({ code: "NAME_TAKEN" });
    expect(groupInput.safeParse({ name: "x".repeat(groupLimits.name + 1) }).success).toBe(false);
    expect(groupInput.safeParse({ name: "   " }).success).toBe(false);
    for (let i = 3; i < groupLimits.groups; i++) await s.createGroup({ name: `G${i}` });
    expect((await s.read()).groups).toHaveLength(groupLimits.groups);
    await expect(s.createGroup({ name: "One too many" })).rejects.toMatchObject({ code: "GROUPS_FULL" });
  });

  test("update: rename, defaults set and cleared, the default flag moves but cannot be cleared, stale revisions refused", async () => {
    const s = await ready();
    let board = await s.read();
    const zen = byName(board, "Zen"),
      fallback = byName(board, "Projects");
    await expect(s.updateGroup({ id: zen.id, revision: zen.revision + 1, name: "Late" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(s.updateGroup({ id: "nope", revision: 1, name: "Late" })).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    await expect(s.updateGroup({ id: zen.id, revision: zen.revision, name: "projects" })).rejects.toMatchObject({ code: "NAME_TAKEN" });
    await expect(s.updateGroup({ id: fallback.id, revision: fallback.revision, isDefault: false })).rejects.toMatchObject({ code: "DEFAULT_REQUIRED" });
    const model = { provider: "claude", model: "claude-opus-5-5" };
    const renamed = await s.updateGroup({ id: zen.id, revision: zen.revision, name: "Zenlytic", defaults: { agentModel: model, deliveryMode: "ready_pr" } });
    expect(renamed).toMatchObject({ name: "Zenlytic", revision: 2, defaults: { agentModel: model, deliveryMode: "ready_pr" } });
    const cleared = await s.updateGroup({ id: zen.id, revision: 2, defaults: { agentModel: null, deliveryMode: null } });
    expect(cleared.defaults).toBeUndefined();
    // A case-only rename of itself is allowed.
    await s.updateGroup({ id: zen.id, revision: 3, name: "ZENLYTIC" });
    await s.updateGroup({ id: zen.id, revision: 4, isDefault: true });
    board = await onDisk(backend, s.directory);
    expect(layout(board)).toEqual({ "ZENLYTIC*": ["a", "old"], Projects: ["b", "c"] });
  });

  test("move renumbers positions without bumping revisions", async () => {
    const s = await ready();
    const c = await s.createGroup({ name: "Third" });
    const before = await s.read();
    expect(await s.moveGroup({ id: c.id, direction: "top" })).toEqual([c.id, byName(before, "Zen").id, byName(before, "Projects").id]);
    const after = await onDisk(backend, s.directory);
    expect([...after.groups].sort(groupOrder).map((g) => [g.name, g.position, g.revision])).toEqual([
      ["Third", 0, 1],
      ["Zen", 1, 1],
      ["Projects", 2, 1],
    ]);
    await expect(s.moveGroup({ id: "nope", direction: "up" })).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  test("delete: projects (archived too) move to the default group; the default and stale revisions are refused", async () => {
    const s = await ready();
    const board = await s.read();
    const zen = byName(board, "Zen"),
      fallback = byName(board, "Projects");
    await expect(s.deleteGroup({ id: fallback.id, revision: fallback.revision })).rejects.toMatchObject({ code: "DEFAULT_REQUIRED" });
    await expect(s.deleteGroup({ id: zen.id, revision: zen.revision + 1 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(s.deleteGroup({ id: "nope", revision: 1 })).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    const a = board.projects.find((p) => p.id === "a")!;
    expect(await s.deleteGroup({ id: zen.id, revision: zen.revision })).toEqual({ id: zen.id, movedTo: fallback.id, projectIds: ["a", "old"] });
    const after = await onDisk(backend, s.directory);
    expect(layout(after)).toEqual({ "Projects*": ["a", "b", "c", "old"] });
    expect(after.projects.find((p) => p.id === "a")!.revision).toBe(a.revision + 1);
  });

  test("delete refuses the group the v1 dispatcher session moves to, while one is stored", async () => {
    const d = await directory();
    // Zen has two open cards, Projects one: the session would move to Zen.
    await seed(d, [project("a"), project("b")], [task("a1", "a"), task("a2", "a"), task("b1", "b")]);
    const s = open(backend, d);
    await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a"] }]));
    const extra = await s.createGroup({ name: "Extra" });
    const zen = byName(await s.read(), "Zen");
    const running = v1DispatcherGuard({ record: async () => ({ agentId: "dispatcher-1" }) });
    await expect(s.deleteGroup({ id: zen.id, revision: zen.revision }, running)).rejects.toMatchObject({ code: "GROUP_BUSY" });
    expect(byName(await onDisk(backend, d), "Zen")).toBeDefined();
    await s.deleteGroup({ id: extra.id, revision: extra.revision }, running);
    const none = v1DispatcherGuard({ record: async () => ({ agentId: null }) });
    await s.deleteGroup({ id: zen.id, revision: zen.revision }, none);
    expect(layout(await onDisk(backend, d))).toEqual({ "Projects*": ["a", "b"] });
  });

  test("set-group: moves a project and bumps its revision; stale revisions and unknown groups are refused", async () => {
    const s = await ready();
    const board = await s.read();
    const zen = byName(board, "Zen");
    const b = board.projects.find((p) => p.id === "b")!;
    await expect(s.setProjectGroup({ projectId: "b", revision: b.revision + 1, groupId: zen.id })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(s.setProjectGroup({ projectId: "b", revision: b.revision, groupId: "nope" })).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    await expect(s.setProjectGroup({ projectId: "nope", revision: 1, groupId: zen.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const moved = await s.setProjectGroup({ projectId: "b", revision: b.revision, groupId: zen.id });
    expect(moved).toMatchObject({ groupId: zen.id, revision: b.revision + 1 });
    expect(layout(await onDisk(backend, s.directory))).toEqual({ Zen: ["a", "b", "old"], "Projects*": ["c"] });
  });

  test("a project's delivery mode override is set and cleared by projects.update", async () => {
    const s = await ready();
    const p = await s.updateProject({ id: "a", revision: 1, deliveryMode: "draft_pr" });
    expect(p.deliveryMode).toBe("draft_pr");
    const cleared = await s.updateProject({ id: "a", revision: p.revision, deliveryMode: null });
    expect(cleared).not.toHaveProperty("deliveryMode");
  });

  test("a board stored with a dangling group and two defaults is repaired by the start, and logged", async () => {
    const d = await directory();
    const g = (id: string, position: number): Group => ({ id, name: id, position, isDefault: true, revision: 1, createdAt: at, updatedAt: at });
    const board = emptyBoard();
    board.projects = [project("a", { groupId: "one" }), project("b", { groupId: "gone" })];
    board.groups = [g("one", 0), g("two", 1)];
    await writeFile(join(d, "board.json"), JSON.stringify(board));
    const s = open(backend, d);
    const log = errors();
    expect(await s.migrateGroups(legacy([{ id: "x", name: "Ignored", projectIds: ["a", "b"] }]))).toBe(true);
    expect(log).toHaveBeenCalledWith("Flowly board groups repaired:", "b", "1 projects had no valid group");
    expect(layout(await onDisk(backend, d))).toEqual({ "one*": ["a", "b"], two: [] });
  });
});

describe("sqlite only", () => {
  test("a failed migration write (at save:written) leaves the database and the cache unchanged", async () => {
    const d = await directory();
    await seed(d, [project("a"), project("b")]);
    let fail = true;
    const s = open("sqlite", d, {
      step: (name) => {
        if (fail && name === "save:written") throw new Error("injected");
      },
    });
    const before = JSON.stringify(await s.read());
    const log = errors();
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a"] }]))).toBe(false);
    expect(log).toHaveBeenCalledWith("Flowly board groups migration failed:", "injected");
    expect(JSON.stringify(await s.read())).toBe(before);
    expect(JSON.stringify(await onDisk("sqlite", d))).toBe(before);
    // Groups stay off: an ordinary write does not fill them in, so the next start still migrates the stored ones.
    fail = false;
    await s.mutate((board) => void board.projects.push(project("c")));
    expect((await onDisk("sqlite", d)).groups).toEqual([]);
    const next = await reopen("sqlite", s);
    await next.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a"] }]));
    expect(layout(await onDisk("sqlite", d))).toEqual({ Zen: ["a"], "Projects*": ["b", "c"] });
  });

  test("restoring a backup from before groups migrates it again", async () => {
    const d = await directory();
    await seed(d, [project("a"), project("b")]);
    const s = open("sqlite", d);
    await s.read();
    await s.backupStorage();
    const [backup] = (await s.storageStatus()).backups;
    await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a"] }]));
    await s.restoreStorage(backup.name);
    expect(layout(await s.read())).toEqual({ Zen: ["a"], "Projects*": ["b"] });
    expect(layout(await onDisk("sqlite", d))).toEqual({ Zen: ["a"], "Projects*": ["b"] });
  });
});

describe("json only", () => {
  test("a read repairs its copy without writing, and logs a dangling group once", async () => {
    const d = await directory();
    await seed(d, [project("a")]);
    const s = open("json", d);
    await s.migrateGroups(legacy([]));
    const stored = await onDisk("json", d);
    stored.projects.push(project("b", { groupId: "gone" }));
    await writeFile(join(d, "board.json"), JSON.stringify(stored));
    const text = await readFile(join(d, "board.json"), "utf8");
    const log = errors();
    expect(layout(await s.read())).toEqual({ "Projects*": ["a", "b"] });
    await s.read();
    expect(log).toHaveBeenCalledTimes(1);
    expect(await readFile(join(d, "board.json"), "utf8")).toBe(text);
  });
});

describe("projects.create with a group (BOARD-GROUPS-SPEC §2)", () => {
  test("joins the chosen group, else the default; an unknown group is refused before Paseo registers anything", async () => {
    const root = await directory();
    const store = open("json", join(root, "data"));
    await store.migrateGroups(legacy([]));
    const service = new BoardService(store);
    const natives = ["one", "two", "three"].map((name) => ({ projectId: `native-${name}`, projectRootPath: join(root, name), projectDisplayName: name }));
    for (const n of natives) await mkdir(n.projectRootPath);
    const paseo = { projects: { list: async () => ({ projects: natives }) } } as unknown as PaseoApi;
    const first = await service.createProject({ title: "One", description: "", primaryPath: natives[0].projectRootPath, paseoProjectId: "native-one" }, paseo);
    const other = await store.createGroup({ name: "Other" });
    const second = await service.createProject({ title: "Two", description: "", primaryPath: natives[1].projectRootPath, paseoProjectId: "native-two", groupId: other.id }, paseo);
    await expect(
      service.createProject({ title: "Three", description: "", primaryPath: natives[2].projectRootPath, paseoProjectId: "native-three", groupId: "nope" }, paseo),
    ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    const board = await store.read();
    expect(layout(board)).toEqual({ "Projects*": [first.id], Other: [second.id] });
    expect(board.projects).toHaveLength(2);
  });
});
