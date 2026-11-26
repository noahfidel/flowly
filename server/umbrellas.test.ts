import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import {
  addEntry, addUserEntry, archiveUmbrella, closeUmbrella, createUmbrella, getUmbrella, listUmbrellas, newCardUmbrella, proposeChange, reopenUmbrella, resolveChange, setMembership,
  setAcceptanceDone, tickAcceptance, umbrellaWriteLimiter, updateEntry, updateUmbrella, withdrawEntry,
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
  const listed = await updateUmbrella(store, { id: u.id, revision: 3, acceptance: [{ text: "Works end to end" }] }, agent);
  const itemId = listed.acceptance[0].id;
  const ticked = await updateUmbrella(store, { id: u.id, revision: 4, acceptance: [{ id: itemId, text: "Works end to end" }, { text: "Second" }] }, human);
  // A list save never ticks: the first item keeps its author, the new one starts not done.
  expect(ticked.acceptance).toMatchObject([{ id: itemId, done: false, by: agent }, { text: "Second", done: false, by: human }]);
  const kept = await updateUmbrella(store, { id: u.id, revision: 5, acceptance: [{ id: itemId, text: "Works end to end" }] }, agent);
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

const agent = (taskId: string): Actor => ({ kind: "agent", agentId: `s-${taskId}`, taskId });
/** Cards a and b in umbrella "Feed" (group A); c outside. Returns the board as read, for the pure feed writes. */
async function feedSetup() {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "Feed" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id }, human);
  await setMembership(store, { taskId: "b", umbrellaId: u.id }, human);
  const board = await store.read();
  const task = (id: string) => board.tasks.find((t) => t.id === id)!;
  return { store, board, task, u: board.umbrellas[0]! };
}

test("addEntry appends to the card's umbrella: a question starts open, the others active; feedRevision moves, revision stays", async () => {
  const { board, task, u } = await feedSetup();
  const q = addEntry(board, task("a"), { kind: "question", title: "PRs or drafts?", body: "" }, agent("a"), now);
  const d = addEntry(board, task("a"), { kind: "decision", title: "Drafts", body: "Why" }, agent("a"), now);
  const r = addEntry(board, task("b"), { kind: "ruling", title: "No PRs", body: "", quote: "never open PRs" }, agent("b"), now);
  expect([q.status, d.status, r.status]).toEqual(["open", "active", "active"]);
  expect(d).toMatchObject({ umbrellaId: u.id, sourceTaskId: "a", by: agent("a"), createdAt: now, updatedAt: now });
  expect(r.quote).toBe("never open PRs");
  expect(board.umbrellaEntries).toHaveLength(3);
  expect(u).toMatchObject({ feedRevision: 3, revision: 1 });
});

test("addEntry refuses a non-member, a closed umbrella, a ruling without a quote and the 301st counted entry", async () => {
  const { board, task, u } = await feedSetup();
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "none";
  };
  expect(code(() => addEntry(board, task("c"), { kind: "decision", title: "X", body: "" }, agent("c"), now))).toBe("NOT_IN_UMBRELLA");
  expect(code(() => addEntry(board, task("a"), { kind: "ruling", title: "X", body: "" }, agent("a"), now))).toBe("INVALID_INPUT");
  // Superseded, answered and withdrawn entries are kept but do not count.
  for (let i = 0; i < umbrellaLimits.activeEntries; i++) board.umbrellaEntries.push(entry(`e${i}`, "finding", "active", u.id));
  board.umbrellaEntries.push(entry("old", "decision", "superseded", u.id), entry("gone", "question", "answered", u.id));
  expect(code(() => addEntry(board, task("a"), { kind: "decision", title: "X", body: "" }, agent("a"), now))).toBe("UMBRELLA_LIMIT");
  // Superseding a counted entry frees its place.
  expect(addEntry(board, task("a"), { kind: "decision", title: "X", body: "", supersedes: "e0" }, agent("a"), now).status).toBe("active");
  u.status = "closed";
  expect(code(() => addEntry(board, task("a"), { kind: "decision", title: "Y", body: "" }, agent("a"), now))).toBe("UMBRELLA_CLOSED");
  u.status = "open";
  u.archivedAt = now;
  expect(code(() => addEntry(board, task("a"), { kind: "decision", title: "Y", body: "" }, agent("a"), now))).toBe("UMBRELLA_CLOSED");
});

test("supersedes must name an entry of the same umbrella and marks it superseded", async () => {
  const { store, board, task, u } = await feedSetup();
  const other = await createUmbrella(store, { groupId: "A", title: "Other" }, human);
  board.umbrellaEntries.push(entry("there", "decision", "active", other.id), entry("here", "pitfall", "active", u.id));
  expect(() => addEntry(board, task("a"), { kind: "decision", title: "X", body: "", supersedes: "there" }, agent("a"), now)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() => addEntry(board, task("a"), { kind: "decision", title: "X", body: "", supersedes: "nope" }, agent("a"), now)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  const made = addEntry(board, task("b"), { kind: "pitfall", title: "Better", body: "", supersedes: "here" }, agent("b"), now);
  expect(made.supersedes).toBe("here");
  expect(board.umbrellaEntries.find((e) => e.id === "here")).toMatchObject({ status: "superseded", updatedAt: now });
});

test("withdrawEntry touches only this card's own entries: proposed becomes withdrawn, the others superseded", async () => {
  const { board, task, u } = await feedSetup();
  const mine = addEntry(board, task("a"), { kind: "finding", title: "Mine", body: "" }, agent("a"), now);
  const asked = addEntry(board, task("a"), { kind: "question", title: "Asked", body: "" }, agent("a"), now);
  const theirs = addEntry(board, task("b"), { kind: "finding", title: "Theirs", body: "" }, agent("b"), now);
  board.umbrellaEntries.push({ ...entry("proposal", "contract_change", "proposed", u.id), sourceTaskId: "a" });
  const before = u.feedRevision;
  expect(withdrawEntry(board, task("a"), mine.id, agent("a"), now).status).toBe("superseded");
  expect(withdrawEntry(board, task("a"), asked.id, agent("a"), now).status).toBe("superseded");
  expect(withdrawEntry(board, task("a"), "proposal", agent("a"), now).status).toBe("withdrawn");
  expect(u.feedRevision).toBe(before + 3);
  expect(() => withdrawEntry(board, task("a"), theirs.id, agent("a"), now)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(theirs.status).toBe("active");
  // Once closed it can't be withdrawn again.
  expect(() => withdrawEntry(board, task("a"), mine.id, agent("a"), now)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() => withdrawEntry(board, task("c"), mine.id, agent("c"), now)).toThrow(expect.objectContaining({ code: "NOT_IN_UMBRELLA" }));
});

test("umbrellaWriteLimiter allows 20 feed writes per session in a rolling hour and gives a refused slot back", async () => {
  let clock = 0;
  const limiter = umbrellaWriteLimiter(() => clock);
  const releases = Array.from({ length: umbrellaLimits.writesPerHour }, () => limiter.take("s1"));
  expect(() => limiter.take("s1")).toThrow(expect.objectContaining({ code: "UMBRELLA_RATE_LIMIT" }));
  // Another session has its own budget.
  expect(() => limiter.take("s2")).not.toThrow();
  releases[0]!();
  releases[0]!();
  expect(() => limiter.take("s1")).not.toThrow();
  expect(() => limiter.take("s1")).toThrow(expect.objectContaining({ code: "UMBRELLA_RATE_LIMIT" }));
  clock += 3600000;
  expect(() => limiter.take("s1")).not.toThrow();
});

test("newCardUmbrella: follow-ups and member ideas inherit; none opts out; a full, closed or other-group umbrella is skipped with a reason", async () => {
  const { board, u } = await feedSetup();
  expect(newCardUmbrella(board, { projectId: "p", followUpOf: "a" })).toEqual({ umbrella: u });
  expect(newCardUmbrella(board, { projectId: "p", followUpOf: "a", umbrellaId: null })).toEqual({});
  expect(newCardUmbrella(board, { projectId: "p", followUpOf: "c" })).toEqual({});
  board.ideas.push(
    { id: "flagged", projectId: "p", title: "Flagged", detail: "", rationale: "", context: "", status: "open", createdAt: now, updatedAt: now, umbrellaId: u.id },
    { id: "fromMember", projectId: "p", taskId: "b", title: "From member", detail: "", rationale: "", context: "", status: "open", createdAt: now, updatedAt: now },
    { id: "plain", projectId: "p", taskId: "c", title: "Plain", detail: "", rationale: "", context: "", status: "open", createdAt: now, updatedAt: now },
  );
  expect(newCardUmbrella(board, { projectId: "p", ideaId: "flagged" }).umbrella?.id).toBe(u.id);
  expect(newCardUmbrella(board, { projectId: "p", ideaId: "fromMember" }).umbrella?.id).toBe(u.id);
  expect(newCardUmbrella(board, { projectId: "p", ideaId: "plain" })).toEqual({});
  // Inherit never refuses: it says why the card stays out.
  expect(newCardUmbrella(board, { projectId: "q", ideaId: "flagged" }).skipped).toMatch(/Feed.*another board group/);
  u.status = "closed";
  expect(newCardUmbrella(board, { projectId: "p", followUpOf: "a" }).skipped).toMatch(/Feed.*closed/);
  // An explicit umbrella (the New task form) is refused instead.
  expect(() => newCardUmbrella(board, { projectId: "p", umbrellaId: u.id })).toThrow(expect.objectContaining({ code: "UMBRELLA_CLOSED" }));
  u.status = "open";
  expect(() => newCardUmbrella(board, { projectId: "q", umbrellaId: u.id })).toThrow(expect.objectContaining({ code: "UMBRELLA_OUT_OF_GROUP" }));
  expect(() => newCardUmbrella(board, { projectId: "p", umbrellaId: "nope" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(newCardUmbrella(board, { projectId: "p", umbrellaId: u.id })).toEqual({ umbrella: u });
  for (let i = 0; i < umbrellaLimits.members - 2; i++) board.tasks.push(card(`x${i}`, "p", { umbrella: { id: u.id, joinedAt: now, by: human } }));
  expect(newCardUmbrella(board, { projectId: "p", followUpOf: "a" }).skipped).toMatch(/Feed.*30/);
  expect(() => newCardUmbrella(board, { projectId: "p", umbrellaId: u.id })).toThrow(expect.objectContaining({ code: "UMBRELLA_LIMIT" }));
});

test("D22: a ruling is superseded only by a ruling, an open question only by the card that asked it", async () => {
  const { board, task, u } = await feedSetup();
  const ruling = addEntry(board, task("a"), { kind: "ruling", title: "No PRs", body: "", quote: "never open PRs" }, agent("a"), now);
  const asked = addEntry(board, task("a"), { kind: "question", title: "Drafts?", body: "" }, agent("a"), now);
  const pitfall = addEntry(board, task("a"), { kind: "pitfall", title: "Slow fixture", body: "" }, agent("a"), now);
  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "none";
  };
  // (1) A decision can't replace a ruling; a ruling with the user's quote can.
  expect(refused(() => addEntry(board, task("b"), { kind: "decision", title: "PRs ok", body: "", supersedes: ruling.id }, agent("b"), now))).toBe("UMBRELLA_KIND");
  expect(ruling.status).toBe("active");
  expect(addEntry(board, task("b"), { kind: "ruling", title: "Drafts only", body: "", quote: "drafts, not PRs", supersedes: ruling.id }, agent("b"), now).supersedes).toBe(ruling.id);
  expect(ruling.status).toBe("superseded");
  // (2) Another card can't close the open question; the card that asked it can.
  expect(refused(() => addEntry(board, task("b"), { kind: "decision", title: "Drafts", body: "", supersedes: asked.id }, agent("b"), now))).toBe("INVALID_INPUT");
  expect(asked.status).toBe("open");
  addEntry(board, task("a"), { kind: "question", title: "Drafts or PRs?", body: "", supersedes: asked.id }, agent("a"), now);
  expect(asked.status).toBe("superseded");
  // (3) Any member supersedes the other kinds.
  addEntry(board, task("b"), { kind: "pitfall", title: "Slow fixture, use the cache", body: "", supersedes: pitfall.id }, agent("b"), now);
  expect(pitfall.status).toBe("superseded");
  expect(u.feedRevision).toBe(6);
});

test("D22 does not limit the user's own supersede", async () => {
  const { store, board, task } = await feedSetup();
  const ruling = addEntry(board, task("a"), { kind: "ruling", title: "No PRs", body: "", quote: "never open PRs" }, agent("a"), now);
  const asked = addEntry(board, task("a"), { kind: "question", title: "Drafts?", body: "" }, agent("a"), now);
  await store.mutate((b) => {
    b.umbrellaEntries = board.umbrellaEntries;
    b.umbrellas = board.umbrellas;
  });
  await updateEntry(store, { id: ruling.id, status: "superseded" }, human);
  await updateEntry(store, { id: asked.id, status: "superseded" }, human);
  expect((await store.read()).umbrellaEntries.map((e) => e.status)).toEqual(["superseded", "superseded"]);
});

/** feedSetup with a contract at revision 1; `propose` runs proposeChange in a store transaction, as the agent tool does. */
async function contractSetup() {
  const x = await feedSetup();
  await updateUmbrella(x.store, { id: x.u.id, revision: x.u.revision, contract: "shape: {a}" }, human);
  const propose = (taskId: string, after: string, baseRevision: number, reason = `${taskId} needs it`) =>
    x.store.transaction((board) => {
      const task = board.tasks.find((t) => t.id === taskId)!;
      return { value: proposeChange(board, task, { after, reason, baseRevision }, agent(taskId), now), changed: true };
    });
  const read = async () => {
    const board = await x.store.read();
    return { board, u: board.umbrellas.find((u) => u.id === x.u.id)!, entry: (id: string) => board.umbrellaEntries.find((e) => e.id === id)! };
  };
  return { ...x, propose, read };
}

test("a proposal never changes the contract", async () => {
  const x = await contractSetup();
  const before = (await x.read()).u;
  const made = await x.propose("a", "shape: {a, b}", 1, "b is needed for the gallery");
  expect(made).toMatchObject({
    kind: "contract_change", status: "proposed", sourceTaskId: "a", by: agent("a"), body: "b is needed for the gallery",
    change: { before: "shape: {a}", after: "shape: {a, b}", reason: "b is needed for the gallery", baseRevision: 1 },
  });
  expect(made.change!.conflict).toBeUndefined();
  const { u } = await x.read();
  expect(u.contract).toEqual(before.contract);
  expect(u.revision).toBe(before.revision);
  expect(u.feedRevision).toBe(before.feedRevision + 1);
});

test("two proposals on the same base are both flagged as a conflict", async () => {
  const x = await contractSetup();
  const first = await x.propose("a", "shape: {a, b}", 1);
  const second = await x.propose("b", "shape: {a, c}", 1);
  const { entry } = await x.read();
  expect(entry(first.id).change!.conflict).toBe(true);
  expect(entry(second.id).change!.conflict).toBe(true);
});

test("a direct contract edit flags the proposals it leaves behind as conflicts", async () => {
  const x = await contractSetup();
  const lone = await x.propose("a", "shape: {a, b}", 1);
  expect((await x.read()).entry(lone.id).change!.conflict).toBeUndefined();
  // A title-only edit leaves the contract, and the flag, as they are.
  await updateUmbrella(x.store, { id: x.u.id, revision: (await x.read()).u.revision, title: "Renamed" }, human);
  expect((await x.read()).entry(lone.id).change!.conflict).toBeUndefined();
  const before = (await x.read()).u;
  await updateUmbrella(x.store, { id: x.u.id, revision: before.revision, contract: "shape: {a, z}" }, human);
  const { u, entry } = await x.read();
  expect(entry(lone.id).change!.conflict).toBe(true);
  expect(u.feedRevision).toBe(before.feedRevision + 1);
});

test("a proposal on an old base is refused as stale", async () => {
  const x = await contractSetup();
  const refused = await x.propose("a", "shape: {a, b}", 0).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "CONTRACT_STALE" });
  expect((codedError(refused) as Error).message).toMatch(/CONTRACT_STALE/);
  expect((await x.read()).board.umbrellaEntries).toEqual([]);
});

test("the 11th pending change is refused", async () => {
  const x = await contractSetup();
  for (let i = 0; i < umbrellaLimits.pendingChanges; i++) await x.propose("a", `shape ${i}`, 1);
  await expect(x.propose("b", "shape 11", 1)).rejects.toMatchObject({ code: "UMBRELLA_LIMIT" });
  // A resolved one frees its place.
  const pending = (await x.read()).board.umbrellaEntries.filter((e) => e.status === "proposed");
  await resolveChange(x.store, { id: pending[0]!.id, decision: "rejected" }, human);
  await expect(x.propose("b", "shape 11", 1)).resolves.toMatchObject({ status: "proposed" });
});

test("accepting one marks the others behind as conflicts and bumps the revision", async () => {
  const x = await contractSetup();
  const first = await x.propose("a", "shape: {a, b}", 1);
  const second = await x.propose("b", "shape: {a, c}", 1);
  const before = (await x.read()).u;
  const accepted = await resolveChange(x.store, { id: first.id, decision: "accepted" }, human);
  expect(accepted.status).toBe("accepted");
  const { u, entry } = await x.read();
  expect(u.contract).toMatchObject({ text: "shape: {a, b}", revision: 2, updatedBy: human });
  expect(u.revision).toBe(before.revision + 1);
  expect(u.feedRevision).toBe(before.feedRevision + 1);
  expect(entry(second.id)).toMatchObject({ status: "proposed", change: { conflict: true } });
});

test("accepting a proposal behind the current contract is refused as stale", async () => {
  const x = await contractSetup();
  const first = await x.propose("a", "shape: {a, b}", 1);
  const second = await x.propose("b", "shape: {a, c}", 1);
  // Through the panel's RPC (umbrellas.entry.update).
  await updateEntry(x.store, { id: first.id, status: "accepted" }, human);
  const refused = await updateEntry(x.store, { id: second.id, status: "accepted" }, human).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "CONTRACT_STALE" });
  expect((await x.read()).u.contract).toMatchObject({ text: "shape: {a, b}", revision: 2 });
  // Rejecting it still works, with the note in answer.
  await expect(updateEntry(x.store, { id: second.id, status: "rejected", answer: "Propose again on r2" }, human)).resolves.toMatchObject({
    status: "rejected",
    answer: "Propose again on r2",
  });
});

test("only a pending proposal can be resolved, and a closed umbrella refuses it", async () => {
  const x = await contractSetup();
  const first = await x.propose("a", "shape: {a, b}", 1);
  const question = addEntry(x.board, x.task("a"), { kind: "question", title: "Q", body: "" }, agent("a"), now);
  await x.store.mutate((b) => void b.umbrellaEntries.push(question));
  await expect(resolveChange(x.store, { id: question.id, decision: "accepted" }, human)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(resolveChange(x.store, { id: "nope", decision: "accepted" }, human)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await closeUmbrella(x.store, { id: x.u.id, revision: (await x.read()).u.revision }, human);
  await expect(resolveChange(x.store, { id: first.id, decision: "accepted" }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
});

test("the accepted event is on the proposing card with the resolver as actor", async () => {
  const x = await contractSetup();
  const first = await x.propose("a", "shape: {a, b}", 1, "the gallery needs b");
  const second = await x.propose("b", "shape: {a, c}", 1);
  const third = await x.propose("b", "shape: {a, d}", 1);
  const dispatcher: Actor = { kind: "dispatcher", agentId: "disp" };
  await resolveChange(x.store, { id: first.id, decision: "accepted" }, dispatcher);
  await resolveChange(x.store, { id: second.id, decision: "rejected", answer: "Not now" }, human);
  const events = (await x.read()).board.events.filter((e) => e.action.startsWith("umbrella_contract_"));
  expect(events).toEqual([
    expect.objectContaining({ taskId: "a", action: "umbrella_contract_accepted", actor: "agent", agentId: "disp", note: expect.stringContaining("the gallery needs b") }),
    expect.objectContaining({ taskId: "b", action: "umbrella_contract_rejected", actor: "human" }),
  ]);
  // A proposal whose card is gone resolves with no event and no error.
  await x.store.mutate((b) => {
    b.tasks = b.tasks.filter((t) => t.id !== "b");
  });
  await expect(resolveChange(x.store, { id: third.id, decision: "rejected" }, human)).resolves.toMatchObject({ status: "rejected" });
  expect((await x.read()).board.events.filter((e) => e.action.startsWith("umbrella_contract_"))).toHaveLength(2);
});

/** feedSetup plus a two-item acceptance list and card "a" as the integration card. */
async function acceptanceSetup() {
  const x = await feedSetup();
  await updateUmbrella(
    x.store,
    { id: x.u.id, revision: x.u.revision, acceptance: [{ text: "Corrections reach the next session" }, { text: "No duplicate notes" }], integrationTaskId: "a" },
    human,
  );
  const board = await x.store.read();
  const u = board.umbrellas[0]!;
  return { ...x, board, u, task: (id: string) => board.tasks.find((t) => t.id === id)! };
}

test("only the integration card ticks acceptance", async () => {
  const { board, task, u } = await acceptanceSetup();
  const first = u.acceptance[0]!.id;
  expect(() => tickAcceptance(board, task("b"), { acceptance: [{ id: first, done: true }], note: "ran it" }, agent("b"), now)).toThrow(
    expect.objectContaining({ code: "NOT_INTEGRATION_CARD" }),
  );
  expect(() => tickAcceptance(board, task("c"), { acceptance: [{ id: first, done: true }], note: "ran it" }, agent("c"), now)).toThrow(
    expect.objectContaining({ code: "NOT_IN_UMBRELLA" }),
  );
  expect(u.acceptance[0]!.done).toBe(false);
});

test("a tick needs a note and records who and when", async () => {
  const { board, task, u } = await acceptanceSetup();
  const [first, second] = u.acceptance.map((a) => a.id);
  expect(() => tickAcceptance(board, task("a"), { acceptance: [{ id: first!, done: true }], note: "  " }, agent("a"), now)).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
  // An unknown id refuses the whole call: nothing is ticked.
  expect(() => tickAcceptance(board, task("a"), { acceptance: [{ id: first!, done: true }, { id: "nope", done: true }], note: "ran it" }, agent("a"), now)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(u.acceptance.every((a) => !a.done)).toBe(true);
  const later = "2026-11-26T09:00:00.000Z";
  const ticked = tickAcceptance(board, task("a"), { acceptance: [{ id: first!, done: true }], note: "Ran the chat flow; the note showed up in 4 minutes." }, agent("a"), later);
  expect(ticked.map((a) => a.id)).toEqual([first]);
  expect(u.acceptance[0]).toMatchObject({ done: true, by: agent("a"), at: later });
  expect(u.acceptance[1]).toMatchObject({ id: second, done: false });
  // Unticking is allowed too, with its own note; the list's text and length never change.
  tickAcceptance(board, task("a"), { acceptance: [{ id: first!, done: false }], note: "Regressed after the rebase." }, agent("a"), later);
  expect(u.acceptance.map((a) => [a.text, a.done])).toEqual([["Corrections reach the next session", false], ["No duplicate notes", false]]);
});

test("a tick bumps feedRevision and leaves revision alone; a closed umbrella refuses it", async () => {
  const { store, board, task, u } = await acceptanceSetup();
  const before = { revision: u.revision, feed: u.feedRevision };
  tickAcceptance(board, task("a"), { acceptance: [{ id: u.acceptance[0]!.id, done: true }], note: "ok" }, agent("a"), now);
  expect(u).toMatchObject({ revision: before.revision, feedRevision: before.feed + 1 });
  await closeUmbrella(store, { id: u.id, revision: u.revision }, human);
  const closed = await store.read();
  expect(() =>
    tickAcceptance(closed, closed.tasks.find((t) => t.id === "a")!, { acceptance: [{ id: u.acceptance[1]!.id, done: true }], note: "ok" }, agent("a"), now),
  ).toThrow(expect.objectContaining({ code: "UMBRELLA_CLOSED" }));
});

test("a stale Edit-list save never undoes an agent's tick, and a quick toggle leaves it intact", async () => {
  const { store, u } = await acceptanceSetup();
  const [first, second] = u.acceptance.map((a) => a.id);
  // The panel opened Edit list on this revision; then the integration card ticks item 1 (feedRevision only).
  const opened = u.revision;
  await store.transaction((board) => {
    tickAcceptance(board, board.tasks.find((t) => t.id === "a")!, { acceptance: [{ id: first!, done: true }], note: "ok" }, agent("a"), now);
    return { value: undefined, changed: true };
  });
  expect((await store.read()).umbrellas[0]!.revision).toBe(opened);
  // The save fixes a typo in item 2 against the same revision: no conflict, and the tick survives.
  const saved = await updateUmbrella(store, { id: u.id, revision: opened, acceptance: [{ id: first!, text: "Corrections reach the next session" }, { id: second!, text: "No duplicate notes!" }] }, human);
  expect(saved.acceptance).toMatchObject([{ id: first, done: true, by: agent("a") }, { id: second, text: "No duplicate notes!", done: false }]);
  // A quick toggle of item 2 sends only that item and leaves item 1's agent tick alone; the revision stays.
  const toggled = await setAcceptanceDone(store, { id: u.id, itemId: second!, done: true }, human);
  expect(toggled.acceptance).toMatchObject([{ id: first, done: true, by: agent("a") }, { id: second, done: true, by: human }]);
  expect(toggled.revision).toBe(saved.revision);
  expect(toggled.feedRevision).toBe(saved.feedRevision + 1);
  await expect(setAcceptanceDone(store, { id: u.id, itemId: "nope", done: true }, human)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await closeUmbrella(store, { id: u.id, revision: saved.revision }, human);
  await expect(setAcceptanceDone(store, { id: u.id, itemId: first!, done: false }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
});

test("the user can add a feed entry; a closed umbrella refuses it", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  const made = await addUserEntry(store, { umbrellaId: u.id, kind: "decision", title: "Use SSE", body: "Because" }, human);
  expect(made).toMatchObject({ kind: "decision", status: "active", by: human, umbrellaId: u.id });
  expect(made.sourceTaskId).toBeUndefined();
  const board = await store.read();
  expect(board.umbrellas[0]).toMatchObject({ revision: 1, feedRevision: 1 });
  expect(board.umbrellaEntries).toHaveLength(1);
  await closeUmbrella(store, { id: u.id, revision: 1 }, human);
  await expect(addUserEntry(store, { umbrellaId: u.id, kind: "finding", title: "t", body: "" }, human)).rejects.toMatchObject({ code: "UMBRELLA_CLOSED" });
  await expect(addUserEntry(store, { umbrellaId: "missing", kind: "finding", title: "t", body: "" }, human)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("the user's entry counts toward the 300 limit", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  await store.mutate((board) => {
    for (let i = 0; i < umbrellaLimits.activeEntries; i++) board.umbrellaEntries.push(entry(`e${i}`, "finding", "active", u.id));
  });
  await expect(addUserEntry(store, { umbrellaId: u.id, kind: "finding", title: "t", body: "" }, human)).rejects.toMatchObject({ code: "UMBRELLA_LIMIT" });
});

test("set-member with onlyIfFree refuses a card that is in another umbrella and leaves it there", async () => {
  const store = await setup();
  const x = await createUmbrella(store, { groupId: "A", title: "X" }, human);
  const y = await createUmbrella(store, { groupId: "A", title: "Y" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: x.id }, human);
  const refused = await setMembership(store, { taskId: "a", umbrellaId: y.id, onlyIfFree: true }, human).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "REVISION_CONFLICT", message: "The card is already in an umbrella." });
  expect((await store.read()).tasks.find((t) => t.id === "a")?.umbrella?.id).toBe(x.id);
  // Already in the target umbrella: a no-op success; a free card joins.
  await expect(setMembership(store, { taskId: "a", umbrellaId: x.id, onlyIfFree: true }, human)).resolves.toMatchObject({ umbrella: { id: x.id } });
  await expect(setMembership(store, { taskId: "b", umbrellaId: y.id, onlyIfFree: true }, human)).resolves.toMatchObject({ umbrella: { id: y.id } });
});

test("set-member in the same umbrella: an omitted role or order keeps it, null clears it; joining another starts fresh", async () => {
  const store = await setup();
  const u = await createUmbrella(store, { groupId: "A", title: "U" }, human);
  const v = await createUmbrella(store, { groupId: "A", title: "V" }, human);
  await setMembership(store, { taskId: "a", umbrellaId: u.id, role: "feature map", order: 2 }, human);
  const agent: Actor = { kind: "agent", agentId: "s1" };
  // An agent's call that names only the umbrella changes nothing.
  const kept = await setMembership(store, { taskId: "a", umbrellaId: u.id }, agent);
  expect(kept.umbrella).toMatchObject({ id: u.id, role: "feature map", order: 2 });
  // One field at a time.
  await setMembership(store, { taskId: "a", umbrellaId: u.id, order: 5 }, human);
  expect((await store.read()).tasks.find((t) => t.id === "a")!.umbrella).toMatchObject({ role: "feature map", order: 5 });
  // An explicit null clears it.
  const cleared = await setMembership(store, { taskId: "a", umbrellaId: u.id, role: null }, human);
  expect(cleared.umbrella?.role).toBeUndefined();
  expect(cleared.umbrella?.order).toBe(5);
  const noOrder = await setMembership(store, { taskId: "a", umbrellaId: u.id, order: null }, human);
  expect(noOrder.umbrella).not.toHaveProperty("order");
  // Joining another umbrella starts fresh: nothing carries over.
  await setMembership(store, { taskId: "b", umbrellaId: u.id, role: "api", order: 1 }, human);
  const moved = await setMembership(store, { taskId: "b", umbrellaId: v.id }, human);
  expect(moved.umbrella).toMatchObject({ id: v.id });
  expect(moved.umbrella).not.toHaveProperty("role");
  expect(moved.umbrella).not.toHaveProperty("order");
});
