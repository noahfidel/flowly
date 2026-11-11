import { afterEach, describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { readDatabaseFile } from "./sqlite-storage";
import { projectLanes } from "../shared/lanes";
import { emptyBoard, statuses, type Board, type Lane, type Project, type Status, type Task } from "../shared/model";
import type { LegacyGroup } from "../shared/groups";

/** Group-level lanes in the store (BOARD-GROUPS-SPEC §0 lanes ruling, §1, §2, §7 step 7, §8). */

const directories: string[] = [];
const stores: BoardStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "flowly-group-lanes-")));
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
const at = "2026-11-10T10:00:00.000Z";
const lanes = (on: (s: Status) => boolean, names: Partial<Record<Status, string>> = {}): Lane[] =>
  statuses.map((status) => ({ status, enabled: on(status), ...(names[status] ? { name: names[status] } : {}) }));
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
const task = (id: string, projectId: string, status: Status, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: `/${projectId}`,
  repoPaths: [],
  title: id,
  description: "",
  status,
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...extra,
});
async function seed(path: string, projects: Project[], tasks: Task[] = [], groups?: unknown[]) {
  const board = emptyBoard() as Record<string, unknown>;
  if (groups) board.groups = groups;
  else delete board.groups;
  board.revision = 4;
  board.projects = projects;
  board.tasks = tasks;
  await writeFile(join(path, "board.json"), JSON.stringify(board));
}
const legacy = (groups: LegacyGroup[]) => async () => groups;
const on = (l: { lanes?: Lane[] } | undefined) => projectLanes(l ?? null).filter((x) => x.enabled).map((x) => x.status);
const byName = (board: Board, name: string) => board.groups.find((g) => g.name === name)!;
/** The invariant: every member's lanes equal its group's, and every group has lanes. */
function expectInSync(board: Board) {
  for (const g of board.groups) expect(g.lanes).toBeDefined();
  for (const p of board.projects) expect(p.lanes, p.id).toEqual(board.groups.find((g) => g.id === p.groupId)!.lanes);
}

describe.each(["json", "sqlite"] as const)("group lanes in the store (%s)", (backend) => {
  /**
   * Zen: a (todo "Ready", in review "QA", done) and b (todo "Ready", in review "Review", development, a live card in
   * blocked); Projects: c (no stored lanes) and an empty archived project.
   */
  async function ready() {
    const d = await directory();
    await seed(
      d,
      [
        project("a", { lanes: lanes((s) => ["todo", "in_review", "done"].includes(s), { todo: "Ready", in_review: "QA" }) }),
        project("b", { lanes: lanes((s) => ["todo", "in_review", "development"].includes(s), { todo: "Ready", in_review: "Review" }) }),
        project("c"),
      ],
      [task("t1", "b", "blocked"), task("t2", "a", "test", { archivedAt: at })],
    );
    const s = open(backend, d);
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Zen", projectIds: ["a", "b"] }]))).toBe(true);
    return s;
  }

  test("migration: union of live members' lanes plus live cards' statuses, names kept only when all agree", async () => {
    const s = await ready();
    const board = await onDisk(backend, s.directory);
    const zen = byName(board, "Zen");
    expect(on(zen)).toEqual(["todo", "development", "in_review", "blocked", "done"]);
    expect(zen.lanes!.find((l) => l.status === "todo")!.name).toBe("Ready");
    expect(zen.lanes!.find((l) => l.status === "in_review")!.name).toBeUndefined();
    expect(on(byName(board, "Projects"))).toEqual([...statuses]);
    expectInSync(board);
  });

  test("migration of a board that already has groups but no group lanes, then a second start writes nothing", async () => {
    const d = await directory();
    const group = { id: "g", name: "Zen", position: 0, isDefault: true, revision: 3, createdAt: at, updatedAt: at };
    await seed(d, [project("a", { groupId: "g", lanes: lanes((s) => s === "todo" || s === "done") })], [task("t1", "a", "blocked")], [group]);
    const s = open(backend, d);
    expect(await s.migrateGroups(legacy([]))).toBe(true);
    const board = await onDisk(backend, d);
    expect(on(board.groups[0])).toEqual(["todo", "blocked", "done"]);
    expect(board.groups[0].revision).toBe(3);
    expectInSync(board);
    const before = JSON.stringify(await onDisk(backend, d));
    await s.close();
    stores.splice(stores.indexOf(s), 1);
    const again = open(backend, d);
    expect(await again.migrateGroups(legacy([]))).toBe(true);
    expect(JSON.stringify(await onDisk(backend, d))).toBe(before);
  });

  if (backend === "json")
    test("a read never bumps a revision: a live card in a group-off lane shows the lane on, and an edit at the stored revision succeeds", async () => {
      const s = await ready();
      const zen = byName(await s.read(), "Zen");
      await s.updateGroup({ id: zen.id, revision: zen.revision, lanes: lanes((x) => x !== "test") });
      // Stored data written past the store: a live card in Test, which the group has off.
      const raw = JSON.parse(await readFile(join(s.directory, "board.json"), "utf8")) as Board;
      raw.tasks.push(task("t3", "a", "test"));
      await writeFile(join(s.directory, "board.json"), JSON.stringify(raw));
      const stored = raw.groups.find((g) => g.name === "Zen")!;
      const read = byName(await s.read(), "Zen");
      expect(read.revision).toBe(stored.revision);
      expect(read.updatedAt).toBe(stored.updatedAt);
      expect(on(read)).toContain("test");
      await expect(s.updateGroup({ id: read.id, revision: read.revision, name: "Zen 2" })).resolves.toMatchObject({ name: "Zen 2" });
      const after = await onDisk(backend, s.directory);
      expect(on(byName(after, "Zen 2"))).toContain("test");
      expectInSync(after);
    });

  test("a group lane edit is mirrored to every member; names are trimmed", async () => {
    const s = await ready();
    const zen = byName(await s.read(), "Zen");
    const next = lanes((s) => s !== "backlog", { todo: "  Up next  " });
    const saved = await s.updateGroup({ id: zen.id, revision: zen.revision, lanes: next });
    expect(saved.revision).toBe(zen.revision + 1);
    expect(saved.lanes!.find((l) => l.status === "todo")!.name).toBe("Up next");
    const board = await onDisk(backend, s.directory);
    expect(on(board.projects.find((p) => p.id === "a"))).not.toContain("backlog");
    expectInSync(board);
    // The same lanes again change nothing.
    const same = await s.updateGroup({ id: zen.id, revision: saved.revision, lanes: saved.lanes });
    expect(same.revision).toBe(saved.revision);
  });

  test("a group lane holding a live card of any member can't be turned off", async () => {
    const s = await ready();
    const zen = byName(await s.read(), "Zen");
    await expect(s.updateGroup({ id: zen.id, revision: zen.revision, lanes: lanes((s) => s !== "blocked") })).rejects.toMatchObject({
      code: "LANE_NOT_EMPTY",
      message: expect.stringMatching(/Move the cards out of Blocked \(1\) before turning it off\./),
    });
    // The archived card in Test does not hold its lane.
    await expect(s.updateGroup({ id: zen.id, revision: zen.revision, lanes: lanes((s) => s !== "test") })).resolves.toBeDefined();
  });

  test("projects.update refuses a lanes edit", async () => {
    const s = await ready();
    const a = (await s.read()).projects.find((p) => p.id === "a")!;
    await expect(s.updateProject({ id: "a", revision: a.revision, lanes: lanes(() => true) })).rejects.toMatchObject({ code: "LANES_IN_GROUP" });
  });

  test("a project's lanes resolve through its group: card moves and creates are checked against the group's lanes", async () => {
    const s = await ready();
    const board = await s.read();
    const zen = byName(board, "Zen");
    await s.updateGroup({ id: zen.id, revision: zen.revision, lanes: lanes((s) => s !== "backlog") });
    const t1 = (await s.read()).tasks.find((t) => t.id === "t1")!;
    await expect(s.editTask({ id: "t1", revision: t1.revision, status: "backlog", actor: "human" })).rejects.toThrow(/Backlog is not a lane/);
    await expect(s.placeTask({ id: "t1", revision: t1.revision, status: "backlog", beforeId: null, afterId: null })).rejects.toThrow(/Backlog is not a lane/);
    // Development was off in a's own old lanes; the group has it on now.
    const service = new BoardService(s);
    await expect(
      service.createTask({ projectId: "a", title: "x", description: "", status: "backlog", priority: "normal", operationId: "op-new" } as never, {} as PaseoApi),
    ).rejects.toThrow(/Backlog is not a lane in this project/);
    await expect(s.editTask({ id: "t1", revision: t1.revision, status: "development", actor: "human" })).resolves.toMatchObject({ status: "development" });
  });

  test("set-group: the project adopts the target's lanes after the target turns on its cards' statuses", async () => {
    const s = await ready();
    let board = await s.read();
    const projects = byName(board, "Projects");
    await s.updateGroup({ id: projects.id, revision: projects.revision, lanes: lanes((s) => s === "todo" || s === "done") });
    board = await s.read();
    const target = byName(board, "Projects");
    const b = board.projects.find((p) => p.id === "b")!;
    await s.setProjectGroup({ projectId: "b", revision: b.revision, groupId: target.id });
    board = await onDisk(backend, s.directory);
    const after = byName(board, "Projects");
    expect(on(after)).toEqual(["todo", "blocked", "done"]);
    expect(after.revision).toBeGreaterThan(target.revision);
    expectInSync(board);
  });

  test("set_members and group delete: moved projects adopt the target's lanes", async () => {
    const s = await ready();
    let board = await s.read();
    const other = await s.createGroup({ name: "Other" });
    expect(on(other)).toEqual([...statuses]);
    await s.updateGroup({ id: other.id, revision: other.revision, lanes: lanes((s) => s === "todo") });
    board = await s.read();
    const o = board.groups.find((g) => g.id === other.id)!;
    await s.setGroupMembers({ groupId: o.id, revision: o.revision, projectIds: ["b"] });
    board = await onDisk(backend, s.directory);
    expect(on(board.groups.find((g) => g.id === o.id))).toEqual(["todo", "blocked"]);
    expectInSync(board);
    const projects = byName(board, "Projects");
    await s.updateGroup({ id: projects.id, revision: projects.revision, lanes: lanes((s) => s === "done") });
    const o2 = (await s.read()).groups.find((g) => g.id === o.id)!;
    await s.deleteGroup({ id: o2.id, revision: o2.revision });
    board = await onDisk(backend, s.directory);
    expect(on(byName(board, "Projects"))).toEqual(["blocked", "done"]);
    expectInSync(board);
  });

  test("a created project gets its group's lanes", async () => {
    const root = await directory();
    const s = open(backend, join(root, "data"));
    await s.migrateGroups(legacy([]));
    const service = new BoardService(s);
    const natives = ["one", "two"].map((name) => ({ projectId: `native-${name}`, projectRootPath: join(root, name), projectDisplayName: name }));
    for (const n of natives) await mkdir(n.projectRootPath);
    const paseo = { projects: { list: async () => ({ projects: natives }) } } as unknown as PaseoApi;
    const first = await service.createProject({ title: "One", description: "", primaryPath: natives[0].projectRootPath, paseoProjectId: "native-one" }, paseo);
    const other = await s.createGroup({ name: "Other" });
    await s.updateGroup({ id: other.id, revision: other.revision, lanes: lanes((x) => x === "todo") });
    let board = await s.read();
    const g = board.groups.find((x) => x.isDefault)!;
    await s.updateGroup({ id: g.id, revision: g.revision, lanes: lanes((x) => x !== "backlog", { todo: "Ready" }) });
    const second = await service.createProject({ title: "Two", description: "", primaryPath: natives[1].projectRootPath, paseoProjectId: "native-two", groupId: other.id }, paseo);
    board = await onDisk(backend, s.directory);
    expect(board.projects.find((p) => p.id === first.id)!.lanes!.find((l) => l.status === "todo")!.name).toBe("Ready");
    expect(on(board.projects.find((p) => p.id === second.id))).toEqual(["todo"]);
    expectInSync(board);
  });
});

describe("group lanes: follow-ups", () => {
  test("groups not ready (migration failed): projects.update still takes lanes, with the card check; once ready it refuses", async () => {
    const d = await directory();
    await seed(d, [project("a")], [task("t1", "a", "blocked")]);
    const s = open("json", d);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await s.migrateGroups(async () => Promise.reject(new Error("host settings unreadable")))).toBe(false);
    const a = (await s.read()).projects[0];
    await expect(s.updateProject({ id: "a", revision: a.revision, lanes: lanes((x) => x !== "blocked") })).rejects.toThrow(/Move the cards out of Blocked \(1\)/);
    const saved = await s.updateProject({ id: "a", revision: a.revision, lanes: lanes((x) => x !== "backlog", { todo: " Up " }) });
    expect(on(saved)).not.toContain("backlog");
    expect(saved.lanes!.find((l) => l.status === "todo")!.name).toBe("Up");
    expect(await s.migrateGroups(legacy([]))).toBe(true);
    const again = (await s.read()).projects[0];
    await expect(s.updateProject({ id: "a", revision: again.revision, lanes: lanes(() => true) })).rejects.toMatchObject({ code: "LANES_IN_GROUP" });
  });
  test("migration: a group whose members are all archived takes its lanes from them", async () => {
    const d = await directory();
    await seed(d, [project("a", { archivedAt: at, lanes: lanes((x) => x === "todo" || x === "done", { todo: "Ready" }) }), project("b")]);
    const s = open("json", d);
    expect(await s.migrateGroups(legacy([{ id: "z", name: "Old", projectIds: ["a"] }]))).toBe(true);
    const board = await onDisk("json", d);
    const old = byName(board, "Old");
    expect(on(old)).toEqual(["todo", "done"]);
    expect(old.lanes!.find((l) => l.status === "todo")!.name).toBe("Ready");
    expectInSync(board);
  });
  test("a lane turned back on by a write outside the migration is logged with the group, lane and reason", async () => {
    const d = await directory();
    await seed(d, [project("a")]);
    const s = open("json", d);
    expect(await s.migrateGroups(legacy([]))).toBe(true);
    const zen = (await s.read()).groups[0];
    await s.updateGroup({ id: zen.id, revision: zen.revision, lanes: lanes((x) => x !== "test") });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await s.mutate((board) => void board.tasks.push(task("t9", "a", "test")));
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("re-enabled"))).toEqual([expect.stringContaining(`group ${zen.id}`)]);
    expect(lines.join("\n")).toMatch(/test/);
    expect(on((await onDisk("json", d)).groups[0])).toContain("test");
    log.mockRestore();
  });
  test("the migration bumps no group or project revision, even when it turns a lane on for a live card", async () => {
    const d = await directory();
    const group = { id: "g", name: "Zen", position: 0, isDefault: true, revision: 3, createdAt: at, updatedAt: at, lanes: lanes((x) => x !== "blocked") };
    await seed(d, [project("a", { groupId: "g", revision: 7, lanes: lanes((x) => x !== "blocked") })], [task("t1", "a", "blocked")], [group]);
    const s = open("json", d);
    expect(await s.migrateGroups(legacy([]))).toBe(true);
    const board = await onDisk("json", d);
    expect(on(board.groups[0])).toContain("blocked");
    expect(board.groups[0]).toMatchObject({ revision: 3, updatedAt: at });
    expect(board.projects[0].revision).toBe(7);
    expectInSync(board);
  });
});
