import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { BoardStore } from "./store";
import { agentFixture } from "./agent-fixture";
import { attentionDismissInput } from "../shared/attention-dismiss";

const roots: string[] = [];
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("dismiss records the card's signals without touching revisions or Activity; repeats are idempotent", async () => {
  const { store } = await setup();
  const before = await store.read();
  const record = await store.dismissAttention({ taskId: "t", signals: ["u:a", "q:e1"] });
  expect(record).toMatchObject({ taskId: "t", signals: ["u:a", "q:e1"] });
  const after = await store.read();
  expect(after.tasks[0].revision).toBe(before.tasks[0].revision);
  expect(after.projects[0].revision).toBe(before.projects[0].revision);
  expect(after.events).toHaveLength(before.events.length);
  expect(after.attentionDismissals).toEqual([record]);
  const bytes = await readFile(store.path, "utf8");
  expect(await store.dismissAttention({ taskId: "t", signals: ["q:e1", "u:a"] })).toEqual(record);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
  // A new set replaces the card's record.
  await store.dismissAttention({ taskId: "t", signals: ["u:b"] });
  expect((await store.read()).attentionDismissals.map((d) => d.signals)).toEqual([["u:b"]]);
});

test("restore removes the record and is idempotent", async () => {
  const { store } = await setup();
  await store.dismissAttention({ taskId: "t", signals: ["u:a"] });
  await store.restoreAttention({ taskId: "t" });
  expect((await store.read()).attentionDismissals).toEqual([]);
  const bytes = await readFile(store.path, "utf8");
  await store.restoreAttention({ taskId: "t" });
  expect(await readFile(store.path, "utf8")).toBe(bytes);
});

test("unknown or archived cards and invalid input are rejected", async () => {
  const { store } = await setup();
  await expect(store.dismissAttention({ taskId: "missing", signals: ["u:a"] })).rejects.toThrow("Task not found");
  await expect(store.restoreAttention({ taskId: "missing" })).rejects.toThrow("Task not found");
  await store.mutate((board) => {
    board.tasks[0].archivedAt = new Date().toISOString();
  });
  await expect(store.dismissAttention({ taskId: "t", signals: ["u:a"] })).rejects.toThrow("archived");
  expect(attentionDismissInput.safeParse({ taskId: "t", signals: [] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", signals: ["a", "a"] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", signals: ["a"], extra: 1 }).success).toBe(false);
});

test("deleting the card drops its dismissal", async () => {
  const { store } = await setup();
  await store.dismissAttention({ taskId: "t", signals: ["u:a"] });
  const task = (await store.read()).tasks[0];
  await store.deleteTask({ id: task.id, revision: task.revision });
  expect((await store.read()).attentionDismissals).toEqual([]);
});

test("boards written before dismissals read as none", async () => {
  const { store } = await setup();
  const raw = JSON.parse(await readFile(store.path, "utf8"));
  delete raw.attentionDismissals;
  await writeFile(store.path, JSON.stringify(raw));
  const fresh = new BoardStore(store.directory);
  expect((await fresh.read()).attentionDismissals).toEqual([]);
});

test("dismissing one signal adds it to the card's set and keeps every key already there", async () => {
  const { store } = await setup();
  // A set written before single-signal dismissal still loads and is extended, not replaced.
  await store.dismissAttention({ taskId: "t", signals: ["u:a", "q:e1"] });
  const record = await store.dismissAttentionSignal({ taskId: "t", signal: "p:s:r1", current: ["q:e1", "p:s:r1"] });
  expect(record.signals).toEqual(["u:a", "q:e1", "p:s:r1"]);
  const after = await store.read();
  expect(after.attentionDismissals).toEqual([record]);
  // Again: unchanged, nothing written.
  const bytes = await readFile(store.path, "utf8");
  expect(await store.dismissAttentionSignal({ taskId: "t", signal: "p:s:r1", current: [] })).toEqual(record);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
  // No record yet: a new one with that one key.
  await store.restoreAttention({ taskId: "t" });
  expect((await store.dismissAttentionSignal({ taskId: "t", signal: "b:e2", current: ["b:e2"] })).signals).toEqual(["b:e2"]);
  await expect(store.dismissAttentionSignal({ taskId: "missing", signal: "b:e2", current: [] })).rejects.toThrow("Task not found");
});

test("a full set drops only its oldest keys that are no longer current", async () => {
  const { store } = await setup();
  const old = Array.from({ length: 100 }, (_, i) => `u:old${i}`);
  await store.dismissAttention({ taskId: "t", signals: old });
  const record = await store.dismissAttentionSignal({ taskId: "t", signal: "q:new", current: ["u:old0", "q:new"] });
  expect(record.signals).toHaveLength(100);
  expect(record.signals).toContain("u:old0");
  expect(record.signals).not.toContain("u:old1");
  expect(record.signals.at(-1)).toBe("q:new");
  // Every key still current and no room: refused rather than losing one.
  await store.dismissAttention({ taskId: "t", signals: old });
  await expect(store.dismissAttentionSignal({ taskId: "t", signal: "q:new", current: [...old, "q:new"] })).rejects.toThrow();
  expect((await store.read()).attentionDismissals[0].signals).toEqual(old);
});
