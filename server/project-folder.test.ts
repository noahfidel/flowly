import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { ProjectFolders, readSnapshot, snapshotPath, SnapshotInvalidError } from "./project-folder";
import { detectWhenOn } from "./project-create";
import { projectAutoReview } from "../shared/auto-review";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const now = new Date().toISOString();
const project = (id: string, native: string, root: string) => ({
  id, paseoProjectId: native, title: id, description: "", primaryPath: root, repos: [root],
  revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
});
const task = (id: string, projectId: string, root: string) => ({
  id, projectId, workspaceId: `w-${id}`, sourcePath: root, repoPaths: [root],
  title: id, description: "", status: "todo" as const, priority: "normal" as const, position: 0, revision: 1,
  operationId: `op-${id}`, createdAt: now, updatedAt: now, archivedAt: null,
});
const event = (id: string, taskId: string) => ({ id, taskId, actor: "human" as const, action: "created", at: now });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "flowly-folder-"));
  roots.push(dir);
  const r1 = join(dir, "repo1"), r2 = join(dir, "repo2");
  await mkdir(r1);
  await mkdir(r2);
  const store = new BoardStore(join(dir, "data"));
  await store.mutate((b) => {
    b.projects.push(project("p1", "n1", r1), project("p2", "n2", r2));
    b.tasks.push(task("t1", "p1", r1), { ...task("t2", "p1", r1), archivedAt: now }, task("t3", "p2", r2));
    b.events.push(event("e1", "t1"), event("e2", "t2"), event("e3", "t3"));
    b.links.push({ id: "l1", projectId: "p1", from: "t1", to: "t2", kind: "related" as const, createdBy: "human" as const, createdAt: now });
  });
  const folders = new ProjectFolders(() => store.read(), async () => [], 0);
  return { store, folders, dir, r1, r2 };
}

test("each project's snapshot holds exactly its records and an ignore-all .gitignore", async () => {
  const { folders, r1, r2 } = await setup();
  await folders.flush();
  const s1 = (await readSnapshot(r1))!;
  expect(s1.project.id).toBe("p1");
  expect(s1.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(s1.events.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(s1.links.map((l) => l.id)).toEqual(["l1"]);
  expect((await readSnapshot(r2))!.tasks.map((t) => t.id)).toEqual(["t3"]);
  expect(await readFile(join(r1, ".flowly", ".gitignore"), "utf8")).toBe("*\n");
  expect(JSON.parse(await readFile(snapshotPath(r1), "utf8")).agentReceipts).toBeUndefined();
});

test("unchanged projects are not rewritten; an edited .gitignore is kept", async () => {
  const { store, folders, r1, r2 } = await setup();
  await folders.flush();
  await writeFile(join(r1, ".flowly", ".gitignore"), "", "utf8");
  const before = (await readSnapshot(r2))!.savedAt;
  await new Promise((r) => setTimeout(r, 5));
  await store.mutate((b) => void (b.tasks.find((t) => t.id === "t1")!.title = "changed"));
  await store.moveProject({ id: "p2", direction: "top" });
  await folders.flush();
  expect((await readSnapshot(r1))!.tasks[0].title).toBe("changed");
  expect((await readSnapshot(r2))!.savedAt).toBe(before);
  expect(await readFile(join(r1, ".flowly", ".gitignore"), "utf8")).toBe("");
});

test("a failed snapshot write never fails the board and is reported", async () => {
  const { store, folders, r1 } = await setup();
  await chmod(r1, 0o500);
  try {
    await folders.flush();
    expect(folders.state("p1")!.error).not.toBe("");
    expect(folders.state("p2")!.error).toBe("");
    await expect(store.mutate((b) => void (b.tasks[0].title = "ok"))).resolves.toBeUndefined();
  } finally {
    await chmod(r1, 0o700);
  }
});

test("removing a project keeps its snapshot; restore brings the same records back", async () => {
  const { store, folders, r1 } = await setup();
  await folders.flush();
  await store.removeProject({ id: "p1", revision: 1 });
  await folders.flush();
  const snapshot = (await readSnapshot(r1))!;
  expect(snapshot.tasks).toHaveLength(2);
  const restored = await store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n1b" });
  expect(restored).toMatchObject({ cards: 2, unbound: 0 });
  const board = await store.read();
  const p1 = board.projects.find((p) => p.id === "p1")!;
  expect(p1).toMatchObject({ paseoProjectId: "n1b", revision: 2 });
  const tasks = board.tasks.filter((t) => t.projectId === "p1");
  expect(tasks.map((t) => [t.id, t.workspaceId, t.revision])).toEqual([["t1", "w-t1", 2], ["t2", "w-t2", 2]]);
  expect(board.events.filter((e) => e.taskId === "t1").map((e) => e.action)).toEqual(["created", "restored"]);
  expect(board.links.map((l) => l.id)).toEqual(["l1"]);
});

describe("Auto review on restore (PROJECT-FOLDER-SPEC; ruling, Noah 2026-11-18)", () => {
  async function onGroup(store: BoardStore) {
    await store.migrateGroups(async () => []);
    const fallback = (await store.read()).groups[0]!;
    await store.updateGroup({ id: fallback.id, revision: fallback.revision, defaults: { autoReview: { enabled: true, maxRounds: 2 } } });
  }

  test("this version's copy says the project follows its group; it restores with no value and inherits", async () => {
    const { store, folders, r1 } = await setup();
    await onGroup(store);
    await folders.flush();
    expect(JSON.parse(await readFile(snapshotPath(r1), "utf8")).autoReviewInherits).toBe(true);
    const snapshot = (await readSnapshot(r1))!;
    expect(snapshot.autoReviewInherits).toBe(true);
    await store.removeProject({ id: "p1", revision: (await store.read()).projects.find((p) => p.id === "p1")!.revision });
    await store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n1b" });
    const board = await store.read();
    const p1 = board.projects.find((p) => p.id === "p1")!;
    expect(p1).not.toHaveProperty("autoReview");
    expect(projectAutoReview(board, p1).enabled).toBe(true);
    // Detection runs for a restored project whose effective value is on.
    const detected: string[] = [];
    await detectWhenOn(store, "p1", (id) => detected.push(id));
    await detectWhenOn(store, "p2", (id) => detected.push(id));
    expect(detected).toEqual(["p1", "p2"]);
  });

  test("an older copy with no value restores as an explicit Off override", async () => {
    const { store, folders, r1 } = await setup();
    await onGroup(store);
    await folders.flush();
    const raw = JSON.parse(await readFile(snapshotPath(r1), "utf8"));
    delete raw.autoReviewInherits;
    await writeFile(snapshotPath(r1), JSON.stringify(raw), "utf8");
    const snapshot = (await readSnapshot(r1))!;
    expect(snapshot.autoReviewInherits).toBe(false);
    await store.removeProject({ id: "p1", revision: (await store.read()).projects.find((p) => p.id === "p1")!.revision });
    await store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n1b" });
    const board = await store.read();
    const p1 = board.projects.find((p) => p.id === "p1")!;
    expect(p1.autoReview).toEqual({ enabled: false, maxRounds: 2 });
    const detected: string[] = [];
    await detectWhenOn(store, "p1", (id) => detected.push(id));
    expect(detected).toEqual([]);
  });

  test("an older copy with a value restores it as saved", async () => {
    const { store, folders, r1 } = await setup();
    await store.updateProject({ id: "p1", revision: 1, autoReview: { enabled: true, maxRounds: 3 } });
    await folders.flush();
    const raw = JSON.parse(await readFile(snapshotPath(r1), "utf8"));
    delete raw.autoReviewInherits;
    await writeFile(snapshotPath(r1), JSON.stringify(raw), "utf8");
    const snapshot = (await readSnapshot(r1))!;
    await store.removeProject({ id: "p1", revision: 2 });
    await store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n1b" });
    expect((await store.read()).projects.find((p) => p.id === "p1")!.autoReview).toEqual({ enabled: true, maxRounds: 3 });
  });

  test("the upgrade migration rewrites a current copy that lacks the marker", async () => {
    const { store, dir, folders, r1 } = await setup();
    await folders.flush();
    const raw = JSON.parse(await readFile(snapshotPath(r1), "utf8"));
    delete raw.autoReviewInherits;
    await writeFile(snapshotPath(r1), JSON.stringify(raw), "utf8");
    const record = await new ProjectFolders(() => store.read(), async () => [], 0).migrate(join(dir, "data"));
    expect(record.projects.p1.result).toBe("written");
    expect((await readSnapshot(r1))!.autoReviewInherits).toBe(true);
  });
});

test("restore refuses a project or native project already on the board, writing nothing", async () => {
  const { store, folders, r1 } = await setup();
  await folders.flush();
  const snapshot = (await readSnapshot(r1))!;
  const revision = (await store.read()).revision;
  await expect(store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n9" })).rejects.toThrow("already on the board");
  await store.removeProject({ id: "p1", revision: 1 });
  await expect(store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n2" })).rejects.toThrow("already linked");
  expect((await store.read()).revision).toBe(revision + 1);
});

test("a card whose workspace is bound elsewhere is restored without it", async () => {
  const { store, folders, r1, r2 } = await setup();
  await folders.flush();
  const snapshot = (await readSnapshot(r1))!;
  await store.removeProject({ id: "p1", revision: 1 });
  await store.mutate((b) => void b.tasks.push({ ...task("t9", "p2", r2), workspaceId: "w-t1", operationId: "op-t1" }));
  const restored = await store.restoreProject(snapshot, { primaryPath: r1, paseoProjectId: "n1" });
  expect(restored.unbound).toBe(1);
  const t1 = (await store.read()).tasks.find((t) => t.id === "t1")!;
  expect(t1.workspaceId).toBe("unbound-t1");
  expect(t1.operationId).toBe("restored-t1");
});

test("an invalid snapshot is rejected and left unchanged; another project's file is kept as a copy", async () => {
  const { store, folders, r1 } = await setup();
  await mkdir(join(r1, ".flowly"));
  await writeFile(snapshotPath(r1), "{oops", "utf8");
  await expect(readSnapshot(r1)).rejects.toBeInstanceOf(SnapshotInvalidError);
  expect(await readFile(snapshotPath(r1), "utf8")).toBe("{oops");
  await folders.flush();
  const files = await readdir(join(r1, ".flowly"));
  expect(files.some((f) => f.startsWith("project.invalid-"))).toBe(true);
  // A different project now using the folder keeps the earlier snapshot as a dated copy.
  await store.removeProject({ id: "p1", revision: 1 });
  await store.mutate((b) => void b.projects.push(project("p5", "n5", r1)));
  await folders.flush();
  expect((await readSnapshot(r1))!.project.id).toBe("p5");
  expect((await readdir(join(r1, ".flowly"))).filter((f) => /^project\.\d/.test(f))).toHaveLength(1);
});

test("upgrade migration gives every existing project its folder copy and records the result", async () => {
  const { store, dir, r1, r2 } = await setup();
  await store.updateProject({ id: "p2", revision: 1, archived: true });
  // A board written before this version: no folder copies yet.
  const first = new ProjectFolders(() => store.read(), async () => [], 0);
  const record = await first.migrate(join(dir, "data"));
  expect(Object.values(record.projects).map((p) => p.result)).toEqual(["written", "written"]);
  expect((await readSnapshot(r1))!.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect((await readSnapshot(r2))!.project.archivedAt).not.toBeNull();
  const saved = JSON.parse(await readFile(join(dir, "data", "folder-migration.json"), "utf8"));
  expect(saved.projects.p1.result).toBe("written");
  // The next start finds both current and rewrites nothing.
  const before = (await readSnapshot(r1))!.savedAt;
  const again = await new ProjectFolders(() => store.read(), async () => [], 0).migrate(join(dir, "data"));
  expect(Object.values(again.projects).map((p) => p.result)).toEqual(["current", "current"]);
  expect((await readSnapshot(r1))!.savedAt).toBe(before);
  // Board data is never changed by the migration.
  expect((await store.read()).tasks).toHaveLength(3);
});

test("a project whose folder can't be written is marked failed and retried at the next start", async () => {
  const { store, dir, r1 } = await setup();
  await chmod(r1, 0o500);
  try {
    const record = await new ProjectFolders(() => store.read(), async () => [], 0).migrate(join(dir, "data"));
    expect(record.projects.p1.result).toBe("failed");
    expect(record.projects.p2.result).toBe("written");
  } finally {
    await chmod(r1, 0o700);
  }
  const retry = await new ProjectFolders(() => store.read(), async () => [], 0).migrate(join(dir, "data"));
  expect(retry.projects.p1.result).toBe("written");
  expect(retry.projects.p2.result).toBe("current");
});
