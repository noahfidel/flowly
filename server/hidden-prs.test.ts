import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { BoardStore } from "./store";
import { agentFixture } from "./agent-fixture";
import { hidePrInput, hiddenPrLimits } from "../shared/hidden-prs";

/** Hiding a PR from the board's pull requests menu (PR-MENU-SPEC D11): stored per card and trimmed URL. */

const roots: string[] = [];
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const url = "https://github.com/o/r/pull/1";

test("hide persists across a reopened store, trims the URL, and repeats change nothing", async () => {
  const { store } = await setup();
  const before = await store.read();
  const entry = await store.hidePr({ taskId: "t", url: `  ${url} ` });
  expect(entry).toMatchObject({ taskId: "t", url });
  const after = await store.read();
  expect(after.hiddenPrs).toEqual([entry]);
  expect(after.tasks[0].revision).toBe(before.tasks[0].revision);
  expect(after.events).toHaveLength(before.events.length);
  const bytes = await readFile(store.path, "utf8");
  expect(await store.hidePr({ taskId: "t", url })).toEqual(entry);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
  expect((await store.read()).hiddenPrs).toEqual([entry]);
  const fresh = new BoardStore(store.directory);
  expect((await fresh.read()).hiddenPrs).toEqual([entry]);
});

test("restore shows it again; restoring one that is not hidden is harmless", async () => {
  const { store } = await setup();
  await store.hidePr({ taskId: "t", url });
  await store.hidePr({ taskId: "t", url: "https://github.com/o/r/pull/2" });
  await store.restorePr({ taskId: "t", url });
  expect((await store.read()).hiddenPrs.map((h) => h.url)).toEqual(["https://github.com/o/r/pull/2"]);
  await store.restorePr({ taskId: "t", url });
  expect((await store.read()).hiddenPrs).toHaveLength(1);
  expect((await new BoardStore(store.directory).read()).hiddenPrs).toHaveLength(1);
});

test("a missing or archived card is rejected; restore of a missing card too", async () => {
  const { store } = await setup();
  await expect(store.hidePr({ taskId: "missing", url })).rejects.toThrow("Task not found");
  await expect(store.restorePr({ taskId: "missing", url })).rejects.toThrow("Task not found");
  await store.mutate((board) => {
    board.tasks[0].archivedAt = new Date().toISOString();
  });
  await expect(store.hidePr({ taskId: "t", url })).rejects.toThrow("archived");
  expect((await store.read()).hiddenPrs).toEqual([]);
});

test("a full list drops its oldest entry", async () => {
  const { store } = await setup();
  await store.mutate((board) => {
    board.hiddenPrs = Array.from({ length: hiddenPrLimits.records }, (_, i) => ({ taskId: "t", url: `https://github.com/o/r/pull/${i + 10}`, hiddenAt: "2026-11-01T00:00:00.000Z" }));
  });
  await store.hidePr({ taskId: "t", url });
  const { hiddenPrs } = await store.read();
  expect(hiddenPrs).toHaveLength(hiddenPrLimits.records);
  expect(hiddenPrs.at(-1)?.url).toBe(url);
  expect(hiddenPrs.some((h) => h.url.endsWith("/pull/10"))).toBe(false);
});

test("deleting the card and removing the project drop their hidden PRs", async () => {
  const { store } = await setup();
  await store.hidePr({ taskId: "t", url });
  const task = (await store.read()).tasks[0];
  await store.deleteTask({ id: task.id, revision: task.revision });
  expect((await store.read()).hiddenPrs).toEqual([]);
});

test("the inputs are strict and bounded", () => {
  expect(hidePrInput.safeParse({ taskId: "t", url }).success).toBe(true);
  expect(hidePrInput.safeParse({ taskId: "t", url: "  " }).success).toBe(false);
  expect(hidePrInput.safeParse({ taskId: "", url }).success).toBe(false);
  expect(hidePrInput.safeParse({ taskId: "t", url, extra: 1 }).success).toBe(false);
});

test("removing the project drops its hidden PRs", async () => {
  const { store } = await setup();
  await store.hidePr({ taskId: "t", url });
  const project = (await store.read()).projects[0];
  await store.removeProject({ id: project.id, revision: project.revision } as never);
  expect((await store.read()).hiddenPrs).toEqual([]);
});
