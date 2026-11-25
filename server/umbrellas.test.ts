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
import type { ProjectSnapshot } from "./project-folder";

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

test("an integration card that leaves its umbrella is no longer its integration card", async () => {
  const store = await setup();
  const u1 = await createUmbrella(store, { groupId: "A", title: "U1" }, human);
  const u2 = await createUmbrella(store, { groupId: "A", title: "U2" }, human);
  for (const taskId of ["a", "b"]) await setMembership(store, { taskId, umbrellaId: u1.id }, human);
  await updateUmbrella(store, { id: u1.id, revision: 1, integrationTaskId: "a" }, human);
  // Leaving to no umbrella clears it and bumps the umbrella's revision.
  await setMembership(store, { taskId: "a", umbrellaId: null }, human);
  let board = await store.read();
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.umbrellas[0].revision).toBe(3);
  // Moving to another umbrella clears it too; a member that was not the integration card changes nothing.
  await updateUmbrella(store, { id: u1.id, revision: 3, integrationTaskId: "b" }, human);
  await setMembership(store, { taskId: "b", umbrellaId: u2.id }, human);
  board = await store.read();
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.umbrellas[0].revision).toBe(5);
  await setMembership(store, { taskId: "b", umbrellaId: null }, human);
  expect((await store.read()).umbrellas[1].revision).toBe(1);
});

test("briefSource sets, keeps and clears the brief's source link without a brief revision", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U", brief: "Goal", briefSource: "https://example.com/pitch" }, human);
  expect(u.brief).toMatchObject({ text: "Goal", revision: 1, source: "https://example.com/pitch" });
  const moved = await updateUmbrella(store, { id: u.id, revision: 1, briefSource: "~/notes/pitch.md" }, human);
  expect(moved).toMatchObject({ revision: 2, brief: { revision: 1, source: "~/notes/pitch.md" } });
  // Undefined leaves it; the same value is no edit.
  expect(await updateUmbrella(store, { id: u.id, revision: 2, title: "Renamed" }, human)).toMatchObject({ revision: 3, brief: { source: "~/notes/pitch.md" } });
  expect(await updateUmbrella(store, { id: u.id, revision: 3, briefSource: "~/notes/pitch.md" }, human)).toMatchObject({ revision: 3 });
  const cleared = await updateUmbrella(store, { id: u.id, revision: 3, briefSource: null }, human);
  expect(cleared.revision).toBe(4);
  expect(cleared.brief).not.toHaveProperty("source");
  expect(cleared.brief.revision).toBe(1);
  expect(updateRpc.input.safeParse({ id: u.id, revision: 4, briefSource: "x".repeat(501) }).success).toBe(false);
  expect(createRpc.input.safeParse({ groupId: "A", title: "T", briefSource: "x".repeat(500) }).success).toBe(true);
  expect(createRpc.input.safeParse({ groupId: "A", title: "T", briefSource: "x".repeat(501) }).success).toBe(false);
});

// ---- Lifecycle (UMBRELLA-SPEC §9) ----

test("deleting a card clears its membership and the integration card", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  for (const taskId of ["a", "b"]) await setMembership(store, { taskId, umbrellaId: u.id }, human);
  await updateUmbrella(store, { id: u.id, revision: 1, integrationTaskId: "a" }, human);
  await store.mutate((board) => void board.umbrellaEntries.push({ ...entry("d1", "decision", "active", u.id), sourceTaskId: "a" }));
  await store.deleteTask({ id: "a", revision: 1 });
  const board = await store.read();
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.umbrellas[0].revision).toBe(3);
  expect(board.tasks.filter((t) => t.umbrella?.id === u.id).map((t) => t.id)).toEqual(["b"]);
  expect(board.umbrellaEntries).toEqual([expect.objectContaining({ id: "d1", sourceTaskId: "a", status: "active" })]);
  // The panel's read of the umbrella holds up with a source card that is gone.
  expect(getUmbrella(board, u.id).members.map((m) => m.taskId)).toEqual(["b"]);
  // A member that was not the integration card leaves the umbrella untouched.
  await store.deleteTask({ id: "b", revision: 1 });
  expect((await store.read()).umbrellas[0].revision).toBe(3);
});

test("archiving a card keeps its membership", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id }, human);
  await updateUmbrella(store, { id: u.id, revision: 1, integrationTaskId: "a" }, human);
  await store.editTask({ id: "a", revision: 1, archived: true, actor: "human" });
  const board = await store.read();
  expect(board.tasks.find((t) => t.id === "a")!.umbrella).toMatchObject({ id: u.id });
  expect(board.umbrellas[0].integrationTaskId).toBe("a");
  expect(getUmbrella(board, u.id).members).toEqual([expect.objectContaining({ taskId: "a", archived: true })]);
});

test("a restored project's cards drop memberships to missing or other-group umbrellas", async () => {
  const store = await setup();
  const inA = await createUmbrella(store, { groupId: "A", title: "In A" }, human);
  const inB = await createUmbrella(store, { groupId: "B", title: "In B" }, human);
  const joined = (id: string) => ({ id, joinedAt: now, by: human });
  const snapshot: ProjectSnapshot = {
    savedAt: now,
    autoReviewInherits: true,
    project: {
      id: "back", title: "Back", description: "", paseoProjectId: "n-back", primaryPath: "/back", repos: ["/back"],
      revision: 1, createdAt: now, updatedAt: now, archivedAt: null, groupId: "B",
    },
    tasks: [
      card("r1", "back", { umbrella: joined(inA.id) }),
      card("r2", "back", { umbrella: joined(inB.id) }),
      card("r3", "back", { umbrella: joined("gone") }),
      card("r4", "back"),
    ],
    events: [], ideas: [], links: [], artifacts: [], workpads: [], plans: [], summaries: [],
  };
  // The restored project joins the default group A (its folder copy carries no group).
  await store.restoreProject(snapshot, { primaryPath: "/back", paseoProjectId: "n-back" });
  const board = await store.read();
  const membership = (id: string) => board.tasks.find((t) => t.id === id)!.umbrella?.id ?? null;
  expect(["r1", "r2", "r3", "r4"].map(membership)).toEqual([inA.id, null, null, null]);
  const left = board.events.filter((e) => e.action === "umbrella_left");
  expect(left.map((e) => [e.taskId, e.note])).toEqual([
    ["r2", "Left umbrella In B (it is in another board group)"],
    ["r3", "Left umbrella (it is no longer on the board)"],
  ]);
});

/** A folder copy of project "back" with the given cards and ideas. */
const backSnapshot = (tasks: Task[], ideas: ProjectSnapshot["ideas"] = []): ProjectSnapshot => ({
  savedAt: now,
  autoReviewInherits: true,
  project: {
    id: "back", title: "Back", description: "", paseoProjectId: "n-back", primaryPath: "/back", repos: ["/back"],
    revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
  },
  tasks, events: [], ideas, links: [], artifacts: [], workpads: [], plans: [], summaries: [],
});
const restoredIdea = (id: string, umbrellaId: string): ProjectSnapshot["ideas"][number] => ({
  id, projectId: "back", title: id, detail: "", rationale: "", context: "", status: "open", createdAt: now, updatedAt: now, umbrellaId,
});

test("a restored card drops its membership to a closed or archived umbrella, and so does an idea", async () => {
  const store = await setup();
  const open = await createUmbrella(store, { groupId: "A", title: "Open" }, human);
  const closed = await createUmbrella(store, { groupId: "A", title: "Done work" }, human);
  const archived = await createUmbrella(store, { groupId: "A", title: "Old work" }, human);
  await closeUmbrella(store, { id: closed.id, revision: 1 }, human);
  await archiveUmbrella(store, { id: archived.id, revision: 1 }, human);
  const joined = (id: string) => ({ umbrella: { id, joinedAt: now, by: human } });
  await store.restoreProject(
    backSnapshot(
      [card("r1", "back", joined(open.id)), card("r2", "back", joined(closed.id)), card("r3", "back", joined(archived.id))],
      [restoredIdea("i1", open.id), restoredIdea("i2", closed.id), restoredIdea("i3", archived.id)],
    ),
    { primaryPath: "/back", paseoProjectId: "n-back" },
  );
  const board = await store.read();
  expect(["r1", "r2", "r3"].map((id) => board.tasks.find((t) => t.id === id)!.umbrella?.id ?? null)).toEqual([open.id, null, null]);
  expect(board.events.filter((e) => e.action === "umbrella_left").map((e) => [e.taskId, e.note])).toEqual([
    ["r2", "Left umbrella Done work (it is closed)"],
    ["r3", "Left umbrella Old work (it is archived)"],
  ]);
  expect(["i1", "i2", "i3"].map((id) => board.ideas.find((i) => i.id === id)!.umbrellaId ?? null)).toEqual([open.id, null, null]);
});

test("restored cards rejoin an umbrella only up to 30 members; the first ones keep their place", async () => {
  const ids = Array.from({ length: umbrellaLimits.members - 1 }, (_, i) => `m${i}`);
  const store = await setup(ids);
  const u = await createUmbrella(store, { groupId: "A", title: "Busy" }, human);
  for (const taskId of ids) await setMembership(store, { taskId, umbrellaId: u.id }, human);
  const joined = { umbrella: { id: u.id, joinedAt: now, by: human } };
  await store.restoreProject(
    backSnapshot([card("r1", "back", joined), card("r2", "back", joined), card("r3", "back", joined)]),
    { primaryPath: "/back", paseoProjectId: "n-back" },
  );
  const board = await store.read();
  expect(board.tasks.filter((t) => t.umbrella?.id === u.id)).toHaveLength(umbrellaLimits.members);
  expect(["r1", "r2", "r3"].map((id) => board.tasks.find((t) => t.id === id)!.umbrella?.id ?? null)).toEqual([u.id, null, null]);
  expect(board.events.filter((e) => e.action === "umbrella_left").map((e) => [e.taskId, e.note])).toEqual([
    ["r2", "Left umbrella Busy (it is full)"],
    ["r3", "Left umbrella Busy (it is full)"],
  ]);
});
