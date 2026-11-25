import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const now = new Date().toISOString();
const project = (id: string, native: string) => ({
  id, paseoProjectId: native, title: id, description: "", primaryPath: `/r/${id}`, repos: [`/r/${id}`],
  revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
});
const task = (id: string, projectId: string) => ({
  id, projectId, workspaceId: `w-${id}`, sourcePath: `/r/${projectId}`, repoPaths: [`/r/${projectId}`],
  title: id, description: "", status: "todo" as const, priority: "normal" as const, position: 0, revision: 1,
  operationId: `op-${id}`, createdAt: now, updatedAt: now, archivedAt: null,
});
const event = (id: string, taskId: string) => ({ id, taskId, actor: "human" as const, action: "created", at: now });
const receipt = (key: string, taskId: string) => ({
  key, agentId: "a", taskId, payloadHash: "h", action: "progress" as const, eventId: "e", taskRevision: 1,
  projectRevision: 1, status: "todo" as const, at: now, expiresAt: now,
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ultra-remove-"));
  roots.push(dir);
  const store = new BoardStore(join(dir, "data"));
  await store.mutate((b) => {
    b.projects.push(project("p1", "n1"), project("p2", "n2"));
    b.tasks.push(task("t1", "p1"), { ...task("t2", "p1"), archivedAt: now }, task("t3", "p2"));
    b.events.push(event("e1", "t1"), event("e2", "t2"), event("e3", "t3"));
    b.agentReceipts.push(receipt("k1", "t1"), receipt("k3", "t3"));
  });
  return { store, dir };
}

test("removing a project drops it and all its cards, events and receipts, keeping a backup", async () => {
  const { store, dir } = await setup();
  const result = await store.removeProject({ id: "p1", revision: 1 });
  expect(result.removedTasks).toBe(2);
  const board = await store.read();
  expect(board.projects.map((p) => p.id)).toEqual(["p2"]);
  expect(board.tasks.map((t) => t.id)).toEqual(["t3"]);
  expect(board.events.map((e) => e.id)).toEqual(["e3"]);
  expect(board.agentReceipts.map((r) => r.key)).toEqual(["k3"]);
  const files = await readdir(join(dir, "data", "removed"));
  expect(files).toHaveLength(1);
  const backup = JSON.parse(await readFile(result.backup, "utf8"));
  expect(backup.project.id).toBe("p1");
  expect(backup.tasks.map((t: { id: string }) => t.id)).toEqual(["t1", "t2"]);
  expect(backup.events).toHaveLength(2);
  expect(backup.agentReceipts).toHaveLength(1);
});

test("project remove clears memberships and lists the umbrellas in the backup", async () => {
  const { store } = await setup();
  const human = { kind: "human" as const };
  const umbrella = (id: string, title: string, integrationTaskId?: string) => ({
    id, groupId: "g", title, brief: { text: "", revision: 0, updatedAt: now, updatedBy: human },
    contract: { text: "", revision: 0, updatedAt: now, updatedBy: human }, acceptance: [], status: "open" as const,
    createdBy: human, createdAt: now, updatedAt: now, revision: 1, feedRevision: 0, archivedAt: null,
    ...(integrationTaskId ? { integrationTaskId } : {}),
  });
  const joined = (id: string) => ({ id, joinedAt: now, by: human });
  await store.mutate((b) => {
    b.umbrellas.push(umbrella("u1", "Only p1", "t1"), umbrella("u2", "Shared"), umbrella("u3", "Untouched"));
    b.tasks.find((t) => t.id === "t1")!.umbrella = joined("u1");
    b.tasks.find((t) => t.id === "t2")!.umbrella = joined("u2");
    b.tasks.find((t) => t.id === "t3")!.umbrella = joined("u2");
  });
  const result = await store.removeProject({ id: "p1", revision: 1 });
  const backup = JSON.parse(await readFile(result.backup, "utf8"));
  expect(backup.umbrellas).toEqual([{ id: "u1", title: "Only p1" }, { id: "u2", title: "Shared" }]);
  for (const t of backup.tasks) expect(t).not.toHaveProperty("umbrella");
  const board = await store.read();
  // Every umbrella stays, the one with no members left too; its integration card is cleared.
  expect(board.umbrellas.map((u) => u.id)).toEqual(["u1", "u2", "u3"]);
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.tasks.map((t) => [t.id, t.umbrella?.id])).toEqual([["t3", "u2"]]);
});

test("the native project can be linked again after removal; stale revision is rejected", async () => {
  const { store } = await setup();
  await expect(store.removeProject({ id: "p1", revision: 2 })).rejects.toThrow("Revision conflict");
  await expect(store.removeProject({ id: "missing", revision: 1 })).rejects.toThrow("not found");
  await store.removeProject({ id: "p1", revision: 1 });
  // Same native ID and workspace IDs are free again.
  await store.mutate((b) => {
    b.projects.push(project("p1-again", "n1"));
    b.tasks.push({ ...task("t1-again", "p1-again"), workspaceId: "w-t1", operationId: "op-new" });
  });
  expect((await store.read()).projects.map((p) => p.paseoProjectId)).toEqual(["n2", "n1"]);
});

test("deleting an archived card drops only it, its events and receipts, keeping a backup", async () => {
  const { store } = await setup();
  await store.mutate((b) => void b.agentReceipts.push(receipt("k2", "t2")));
  const result = await store.deleteTask({ id: "t2", revision: 1 });
  const board = await store.read();
  expect(board.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(board.tasks.map((t) => t.id)).toEqual(["t1", "t3"]);
  expect(board.events.map((e) => e.id)).toEqual(["e1", "e3"]);
  expect(board.agentReceipts.map((r) => r.key)).toEqual(["k1", "k3"]);
  const backup = JSON.parse(await readFile(result.backup, "utf8"));
  expect(backup.tasks.map((t: { id: string }) => t.id)).toEqual(["t2"]);
  expect(backup.events.map((e: { id: string }) => e.id)).toEqual(["e2"]);
  expect(backup.agentReceipts.map((r: { key: string }) => r.key)).toEqual(["k2"]);
  // Its workspace can be bound to a new card again.
  await store.mutate((b) => void b.tasks.push({ ...task("t2-again", "p1"), workspaceId: "w-t2", operationId: "op-t2-again" }));
});

test("a live card can be deleted too", async () => {
  const { store } = await setup();
  await store.deleteTask({ id: "t1", revision: 1 });
  expect((await store.read()).tasks.map((t) => t.id)).toEqual(["t2", "t3"]);
});

test("a stale revision or unknown card deletes nothing", async () => {
  const { store, dir } = await setup();
  await expect(store.deleteTask({ id: "t2", revision: 2 })).rejects.toThrow("Revision conflict");
  await expect(store.deleteTask({ id: "missing", revision: 1 })).rejects.toThrow("not found");
  expect((await store.read()).tasks).toHaveLength(3);
  await expect(readdir(join(dir, "data", "removed"))).rejects.toThrow();
});
