import { afterEach, expect, test } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { projectOrder } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-order-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  await store.mutate((b) => {
    for (const [i, id] of ["a", "b", "c"].entries())
      b.projects.push({ id, paseoProjectId: `n${id}`, title: id, description: "", primaryPath: `/${id}`, repos: [`/${id}`], revision: 5, createdAt: `2026-10-0${i + 1}T00:00:00Z`, updatedAt: "x", archivedAt: null });
  });
  return store;
}
const order = async (store: BoardStore) => (await store.read()).projects.sort(projectOrder).map((p) => p.id);

test("projects move up, down and to top without touching their revisions", async () => {
  const store = await setup();
  expect(await order(store)).toEqual(["a", "b", "c"]);
  await store.moveProject({ id: "c", direction: "up" });
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await store.moveProject({ id: "b", direction: "top" });
  expect(await order(store)).toEqual(["b", "a", "c"]);
  await store.moveProject({ id: "c", direction: "down" }); // already last: no change
  expect(await order(store)).toEqual(["b", "a", "c"]);
  expect((await store.read()).projects.every((p) => p.revision === 5)).toBe(true);
  await store.moveProject({ id: "b", to: 2 });
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await store.moveProject({ id: "b", to: 99 }); // clamped, already last
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await expect(store.moveProject({ id: "missing", direction: "up" })).rejects.toThrow(/not found/);
});

test("unpositioned (new) projects sort after ordered ones by creation", () => {
  const p = (id: string, createdAt: string, position?: number) => ({ id, createdAt, position });
  expect([p("new", "2026-10-09"), p("x", "2026-10-01", 1), p("y", "2026-10-02", 0)].sort(projectOrder).map((q) => q.id)).toEqual(["y", "x", "new"]);
});

test("project lanes are not edited per project: projects.update refuses lanes (BOARD-GROUPS-SPEC §2)", async () => {
  // Turning a lane off with cards in it and disabled lanes refusing cards moved to the group: server/store-group-lanes.test.ts.
  const store = await setup();
  const rev = async () => (await store.read()).projects.find((p) => p.id === "a")!.revision;
  const lanes = (["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: true }));
  await expect(store.updateProject({ id: "a", revision: await rev(), lanes })).rejects.toMatchObject({ code: "LANES_IN_GROUP" });
});

test("a project's default model is set, replaced and cleared with the revision check", async () => {
  const store = await setup();
  const rev = async () => (await store.read()).projects.find((p) => p.id === "a")!.revision;
  const saved = await store.updateProject({ id: "a", revision: await rev(), agentModel: { provider: "claude", model: "claude-sonnet-5-5", thinking: "high" } });
  expect(saved.agentModel).toEqual({ provider: "claude", model: "claude-sonnet-5-5", thinking: "high" });
  const replaced = await store.updateProject({ id: "a", revision: saved.revision, agentModel: { provider: "codex", model: "gpt-6-luna" } });
  expect(replaced.agentModel).toEqual({ provider: "codex", model: "gpt-6-luna" });
  await expect(store.updateProject({ id: "a", revision: saved.revision, agentModel: null })).rejects.toThrow(/Revision conflict/);
  const cleared = await store.updateProject({ id: "a", revision: replaced.revision, agentModel: null });
  expect("agentModel" in cleared).toBe(false);
  const untouched = await store.updateProject({ id: "a", revision: cleared.revision, title: "renamed" });
  expect(untouched.agentModel).toBeUndefined();
});
