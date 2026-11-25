import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import {
  archiveUmbrella, closeUmbrella, createUmbrella, getUmbrella, listUmbrellas, reopenUmbrella, setMembership, updateEntry, updateUmbrella,
} from "./umbrellas";
import { createUmbrella as createRpc, updateUmbrella as updateRpc } from "../shared/rpc";
import { umbrellaLimits } from "../shared/umbrella";
import { codedError } from "./tool-error";
import type { Actor, Task, UmbrellaEntry } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const now = "2026-11-25T00:00:00.000Z";
const human: Actor = { kind: "human" };
const card = (id: string, projectId = "p", extra: Partial<Task> = {}): Task => ({
  id, projectId, workspaceId: `w-${id}`, sourcePath: `/${projectId}`, repoPaths: [`/${projectId}`], title: id.toUpperCase(),
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: now, updatedAt: now, archivedAt: null, ...extra,
});
/** Group A holds projects p and r; group B holds q. */
async function setup(ids = ["a", "b", "c"]) {
  const root = await mkdtemp(join(tmpdir(), "flowly-umbrellas-test-"));
  roots.push(root);
  const store = new BoardStore(root);
  await store.mutate((board) => {
    board.groups.push(
      { id: "A", name: "A", position: 0, isDefault: true, revision: 1, createdAt: now, updatedAt: now },
      { id: "B", name: "B", position: 1, revision: 1, createdAt: now, updatedAt: now },
    );
    for (const [p, groupId] of [["p", "A"], ["q", "B"], ["r", "A"]])
      board.projects.push({
        id: p, title: `Project ${p}`, description: "", paseoProjectId: `n-${p}`, primaryPath: `/${p}`, repos: [`/${p}`],
        revision: 1, createdAt: now, updatedAt: now, archivedAt: null, groupId,
      });
    board.tasks.push(...ids.map((id) => card(id)), card("other", "q"), card("far", "r"));
  });
  return store;
}
const entry = (id: string, kind: UmbrellaEntry["kind"], status: UmbrellaEntry["status"], umbrellaId: string): UmbrellaEntry => ({
  id, umbrellaId, kind, title: id, body: "", status, by: human, createdAt: now, updatedAt: now,
});

test("create puts the umbrella in the group and refuses the 51st open one", async () => {
  const store = await setup();
  const created = [];
  for (let i = 0; i < umbrellaLimits.openPerGroup; i++) created.push(await createUmbrella(store, { groupId: "A", title: `U${i}` }, human));
  expect(created[0]).toMatchObject({ groupId: "A", status: "open", revision: 1, feedRevision: 0, archivedAt: null, createdBy: human });
  const refused = await createUmbrella(store, { groupId: "A", title: "One too many" }, human).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "UMBRELLA_LIMIT" });
  // Across the RPC the code rides as a prefix (`coded()` in index.server.ts).
  expect((codedError(refused) as Error).message).toMatch(/^UMBRELLA_LIMIT: /);
  // Another group has its own count.
  await createUmbrella(store, { groupId: "B", title: "Elsewhere" }, human);
  await closeUmbrella(store, { id: created[0].id, revision: 1 }, human);
  await expect(createUmbrella(store, { groupId: "A", title: "Fits again" }, human)).resolves.toMatchObject({ title: "Fits again" });
  expect(listUmbrellas(await store.read(), "A")).toHaveLength(umbrellaLimits.openPerGroup);
});

test("reopen refuses the 51st open umbrella", async () => {
  const store = await setup();
  const first = await createUmbrella(store, { groupId: "A", title: "First" }, human);
  await closeUmbrella(store, { id: first.id, revision: 1 }, human);
  for (let i = 0; i < umbrellaLimits.openPerGroup; i++) await createUmbrella(store, { groupId: "A", title: `U${i}` }, human);
  await expect(reopenUmbrella(store, { id: first.id, revision: 2 }, human)).rejects.toMatchObject({ code: "UMBRELLA_LIMIT" });
});

test("create in a group that does not exist is refused", async () => {
  const store = await setup();
  await expect(createUmbrella(store, { groupId: "nope", title: "X" }, human)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await store.read()).umbrellas).toEqual([]);
});

test("create with an operationId replays the same umbrella", async () => {
  const store = await setup();
  const first = await createUmbrella(store, { groupId: "A", title: "Once", brief: "Goal", operationId: "op-1" }, human);
  const again = await createUmbrella(store, { groupId: "A", title: "Once", brief: "Goal", operationId: "op-1" }, human);
  expect(again.id).toBe(first.id);
  expect(again).toMatchObject({ replayed: true });
  expect(first).not.toHaveProperty("replayed");
  const board = await store.read();
  expect(board.umbrellas).toHaveLength(1);
  expect(board.umbrellas[0]).not.toHaveProperty("replayed");
  expect(board.umbrellas[0].brief).toMatchObject({ text: "Goal", revision: 1, updatedBy: human });
});

test("a card in another group is refused", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await expect(setMembership(store, { taskId: "other", umbrellaId: u.id }, human)).rejects.toMatchObject({ code: "UMBRELLA_OUT_OF_GROUP" });
  expect((await store.read()).tasks.find((t) => t.id === "other")!.umbrella).toBeUndefined();
  // A card of another project of the same group joins.
  await setMembership(store, { taskId: "far", umbrellaId: u.id, role: "verify", order: 2 }, human);
  const { members } = getUmbrella(await store.read(), u.id);
  expect(members).toEqual([
    { taskId: "far", projectId: "r", projectTitle: "Project r", title: "FAR", status: "todo", laneName: "Todo", role: "verify", order: 2, archived: false },
  ]);
});

test("a card is in at most one umbrella", async () => {
  const store = await setup();
  const u1 = await createUmbrella(store, { groupId: "A", title: "U1" }, human);
  const u2 = await createUmbrella(store, { groupId: "A", title: "U2" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u1.id }, human);
  const before = await store.read();
  await setMembership(store, { taskId: "a", umbrellaId: u2.id }, human);
  const board = await store.read();
  expect(getUmbrella(board, u1.id).members).toHaveLength(0);
  expect(getUmbrella(board, u2.id).members.map((m) => m.taskId)).toEqual(["a"]);
  const task = board.tasks.find((t) => t.id === "a")!;
  expect(task.umbrella).toMatchObject({ id: u2.id, by: human });
  expect(task.revision).toBe(before.tasks.find((t) => t.id === "a")!.revision);
  expect(board.events.filter((e) => e.taskId === "a").map((e) => [e.action, e.note])).toEqual([
    ["umbrella_joined", "U1"],
    ["umbrella_left", "U1"],
    ["umbrella_joined", "U2"],
  ]);
  // Leaving clears the membership.
  await setMembership(store, { taskId: "a", umbrellaId: null }, human);
  expect((await store.read()).tasks.find((t) => t.id === "a")!.umbrella).toBeUndefined();
});

test("the 31st member is refused", async () => {
  const ids = Array.from({ length: umbrellaLimits.members + 1 }, (_, i) => `m${i}`);
  const store = await setup(ids);
  const u = await createUmbrella(store, { groupId: "A", title: "Big" }, human);
  await store.mutate((board) => {
    for (const t of board.tasks) if (ids.slice(0, umbrellaLimits.members).includes(t.id)) t.umbrella = { id: u.id, joinedAt: now, by: human };
  });
  await expect(setMembership(store, { taskId: ids.at(-1)!, umbrellaId: u.id }, human)).rejects.toMatchObject({ code: "UMBRELLA_LIMIT" });
  // A member changing its role is not a new member.
  await expect(setMembership(store, { taskId: "m0", umbrellaId: u.id, role: "map" }, human)).resolves.toMatchObject({ umbrella: { role: "map" } });
});

test("archived cards cannot join", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.archivedAt = now;
  });
  await expect(setMembership(store, { taskId: "a", umbrellaId: u.id }, human)).rejects.toThrow("Archived cards");
});

test("a closed umbrella refuses members and stays readable", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U", brief: "The brief" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id }, human);
  await store.mutate((board) => {
    board.umbrellaEntries.push(entry("d1", "decision", "active", u.id));
  });
  const closed = await closeUmbrella(store, { id: u.id, revision: 1 }, human);
  expect(closed).toMatchObject({ status: "closed", revision: 2 });
  await expect(setMembership(store, { taskId: "b", umbrellaId: u.id }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
  const read = getUmbrella(await store.read(), u.id);
  expect(read.umbrella.brief.text).toBe("The brief");
  expect(read.entries.map((e) => e.id)).toEqual(["d1"]);
  expect(read.members.map((m) => m.taskId)).toEqual(["a"]);
  expect(listUmbrellas(await store.read(), "A")).toEqual([]);
  await expect(updateEntry(store, { id: "d1", status: "superseded" }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
  await expect(updateUmbrella(store, { id: u.id, revision: 2, title: "Renamed" }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
  await expect(reopenUmbrella(store, { id: u.id, revision: 2 }, human)).resolves.toMatchObject({ status: "open", revision: 3 });
});

test("archiving closes the umbrella, keeps its members and hides it from the list", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id }, human);
  const archived = await archiveUmbrella(store, { id: u.id, revision: 1 }, human);
  expect(archived).toMatchObject({ status: "closed", revision: 2, archivedAt: expect.any(String) });
  const board = await store.read();
  expect(board.tasks.find((t) => t.id === "a")!.umbrella?.id).toBe(u.id);
  expect(listUmbrellas(board, "A")).toEqual([]);
  await expect(setMembership(store, { taskId: "b", umbrellaId: u.id }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
  await expect(reopenUmbrella(store, { id: u.id, revision: 2 }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
});

test("update checks the umbrella revision and bumps brief and contract revisions", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  expect(u.brief.revision).toBe(0);
  const edited = await updateUmbrella(store, { id: u.id, revision: 1, brief: "New goal", contract: "type A = {}" }, human);
  expect(edited).toMatchObject({ revision: 2, brief: { text: "New goal", revision: 1, updatedBy: { kind: "human" } }, contract: { text: "type A = {}", revision: 1 } });
  await expect(updateUmbrella(store, { id: u.id, revision: 1, title: "Stale" }, human)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  // An edit that changes only the title leaves the brief's and contract's revisions alone.
  const renamed = await updateUmbrella(store, { id: u.id, revision: 2, title: "Renamed", brief: "New goal" }, human);
  expect(renamed).toMatchObject({ title: "Renamed", revision: 3, brief: { revision: 1 }, contract: { revision: 1 } });
  // Acceptance items keep their author when unchanged.
  const agent: Actor = { kind: "dispatcher", agentId: "d" };
  const listed = await updateUmbrella(store, { id: u.id, revision: 3, acceptance: [{ text: "Works end to end", done: false }] }, agent);
  const itemId = listed.acceptance[0].id;
  const ticked = await updateUmbrella(store, { id: u.id, revision: 4, acceptance: [{ id: itemId, text: "Works end to end", done: true }, { text: "Second", done: false }] }, human);
  expect(ticked.acceptance).toMatchObject([{ id: itemId, done: true, by: human }, { text: "Second", by: human }]);
  const kept = await updateUmbrella(store, { id: u.id, revision: 5, acceptance: [{ id: itemId, text: "Works end to end", done: true }] }, agent);
  expect(kept.acceptance).toEqual([ticked.acceptance[0]]);
  expect(updateRpc.input.safeParse({ id: u.id, revision: 1, brief: "x".repeat(umbrellaLimits.brief + 1) }).success).toBe(false);
  expect(updateRpc.input.safeParse({ id: u.id, revision: 1, contract: "x".repeat(umbrellaLimits.contract + 1) }).success).toBe(false);
  expect(updateRpc.input.safeParse({ id: u.id, revision: 1, brief: "x".repeat(umbrellaLimits.brief) }).success).toBe(true);
  expect(createRpc.input.safeParse({ groupId: "A", title: "" }).success).toBe(false);
});

test("integrationTaskId must name a member", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id }, human);
  await expect(updateUmbrella(store, { id: u.id, revision: 1, integrationTaskId: "b" }, human)).rejects.toMatchObject({ code: "NOT_IN_UMBRELLA" });
  const set = await updateUmbrella(store, { id: u.id, revision: 1, integrationTaskId: "a" }, human);
  expect(set.integrationTaskId).toBe("a");
  const cleared = await updateUmbrella(store, { id: u.id, revision: 2, integrationTaskId: null }, human);
  expect(cleared).not.toHaveProperty("integrationTaskId");
});

test("answering a question sets answered and the answer", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await store.mutate((board) => {
    board.umbrellaEntries.push(entry("q1", "question", "open", u.id), entry("d1", "decision", "active", u.id));
  });
  const answered = await updateEntry(store, { id: "q1", status: "answered", answer: "Drafts first" }, human);
  expect(answered).toMatchObject({ id: "q1", status: "answered", answer: "Drafts first" });
  await expect(updateEntry(store, { id: "d1", status: "answered", answer: "x" }, human)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(updateEntry(store, { id: "missing", status: "superseded" }, human)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await updateEntry(store, { id: "d1", status: "superseded" }, human)).toMatchObject({ status: "superseded" });
});

test("answering a question bumps feedRevision and not revision", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await store.mutate((board) => {
    board.umbrellaEntries.push(entry("q1", "question", "open", u.id));
  });
  await updateEntry(store, { id: "q1", status: "answered", answer: "Yes" }, human);
  const after = (await store.read()).umbrellas[0];
  expect(after).toMatchObject({ revision: 1, feedRevision: 1 });
  // The panel's edit with the revision it opened with still passes.
  await expect(updateUmbrella(store, { id: u.id, revision: 1, title: "Still mine" }, human)).resolves.toMatchObject({ revision: 2 });
});

test("board view strips brief, contract and entries", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U", brief: "Secret brief" }, human);
  await updateUmbrella(store, { id: u.id, revision: 1, contract: "Contract text" }, human);
  await store.mutate((board) => {
    board.umbrellaEntries.push(entry("q1", "question", "open", u.id));
  });
  const view = await store.view();
  expect(view.umbrellas).toHaveLength(1);
  expect(view.umbrellas[0].brief.text).toBe("");
  expect(view.umbrellas[0].contract.text).toBe("");
  expect(view.umbrellaEntries).toEqual([]);
  expect((await store.read()).umbrellas[0].brief.text).toBe("Secret brief");
});
