import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { BoardStore } from "./store";
import { agentFixture } from "./agent-fixture";
import { attentionDismissInput, attentionDismissalSchema } from "../shared/attention-dismiss";

const roots: string[] = [];
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("snooze records one list's signals without touching revisions or Activity; repeats are idempotent", async () => {
  const { store } = await setup();
  const before = await store.read();
  const record = await store.dismissAttention({ taskId: "t", list: "needs", signals: ["q:e1", "p:s:r1"] });
  expect(record).toMatchObject({ taskId: "t", needs: { signals: ["q:e1", "p:s:r1"] } });
  expect(record.updated).toBeUndefined();
  const after = await store.read();
  expect(after.tasks[0].revision).toBe(before.tasks[0].revision);
  expect(after.projects[0].revision).toBe(before.projects[0].revision);
  expect(after.events).toHaveLength(before.events.length);
  expect(after.attentionDismissals).toEqual([record]);
  // The same set again (any order): no change, snoozedAt kept, nothing written.
  const bytes = await readFile(store.path, "utf8");
  expect(await store.dismissAttention({ taskId: "t", list: "needs", signals: ["p:s:r1", "q:e1"] })).toEqual(record);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
  // A new set replaces only that list's set.
  await store.dismissAttention({ taskId: "t", list: "needs", signals: ["b:e2"] });
  expect((await store.read()).attentionDismissals.map((d) => d.needs?.signals)).toEqual([["b:e2"]]);
});

test("snoozing one list keeps the other list's set", async () => {
  const { store } = await setup();
  const needs = await store.dismissAttention({ taskId: "t", list: "needs", signals: ["q:e1"] });
  const both = await store.dismissAttention({ taskId: "t", list: "updated", signals: ["u:a"] });
  expect(both).toEqual({ taskId: "t", needs: needs.needs, updated: { signals: ["u:a"], snoozedAt: expect.any(String) } });
  await store.dismissAttention({ taskId: "t", list: "needs", signals: ["q:e2"] });
  const [record] = (await store.read()).attentionDismissals;
  expect(record.needs?.signals).toEqual(["q:e2"]);
  expect(record.updated).toEqual(both.updated);
});

test("keys of the other list are rejected", async () => {
  const { store } = await setup();
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "needs", signals: ["u:a"] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "updated", signals: ["q:e1"] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "updated", signals: ["u:a", "e:s:status"] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "updated", signals: ["u:a"] }).success).toBe(true);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "other", signals: ["u:a"] }).success).toBe(false);
  await expect(store.dismissAttention({ taskId: "t", list: "needs", signals: ["u:a"] })).rejects.toThrow();
  expect((await store.read()).attentionDismissals).toEqual([]);
  // A stored record with a key in the wrong list is invalid too.
  expect(attentionDismissalSchema.safeParse({ taskId: "t", needs: { signals: ["u:a"], snoozedAt: new Date().toISOString() } }).success).toBe(false);
  expect(attentionDismissalSchema.safeParse({ taskId: "t" }).success).toBe(false);
});

test("unsnooze removes the record, both lists, and is idempotent", async () => {
  const { store } = await setup();
  await store.dismissAttention({ taskId: "t", list: "needs", signals: ["q:e1"] });
  await store.dismissAttention({ taskId: "t", list: "updated", signals: ["u:a"] });
  await store.restoreAttention({ taskId: "t" });
  expect((await store.read()).attentionDismissals).toEqual([]);
  const bytes = await readFile(store.path, "utf8");
  await store.restoreAttention({ taskId: "t" });
  expect(await readFile(store.path, "utf8")).toBe(bytes);
});

test("unknown or archived cards and invalid input are rejected", async () => {
  const { store } = await setup();
  await expect(store.dismissAttention({ taskId: "missing", list: "updated", signals: ["u:a"] })).rejects.toThrow("Task not found");
  await expect(store.restoreAttention({ taskId: "missing" })).rejects.toThrow("Task not found");
  await store.mutate((board) => {
    board.tasks[0].archivedAt = new Date().toISOString();
  });
  await expect(store.dismissAttention({ taskId: "t", list: "updated", signals: ["u:a"] })).rejects.toThrow("archived");
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "needs", signals: [] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "needs", signals: ["q:a", "q:a"] }).success).toBe(false);
  expect(attentionDismissInput.safeParse({ taskId: "t", list: "needs", signals: ["q:a"], extra: 1 }).success).toBe(false);
});

test("deleting the card drops its snooze", async () => {
  const { store } = await setup();
  await store.dismissAttention({ taskId: "t", list: "updated", signals: ["u:a"] });
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

test("a legacy record reads as snoozed in both lists and is written in the new shape on the next write", async () => {
  const { store } = await setup();
  const raw = JSON.parse(await readFile(store.path, "utf8"));
  const at = "2026-11-01T10:00:00.000Z";
  raw.attentionDismissals = [{ taskId: "t", signals: ["u:a", "q:e1", "p:s:r1"], dismissedAt: at }];
  await writeFile(store.path, JSON.stringify(raw));
  const fresh = new BoardStore(store.directory);
  const migrated = { taskId: "t", needs: { signals: ["q:e1", "p:s:r1"], snoozedAt: at }, updated: { signals: ["u:a"], snoozedAt: at } };
  expect((await fresh.read()).attentionDismissals).toEqual([migrated]);
  // Any write stores the board in the new shape.
  await fresh.mutate((board) => {
    board.tasks[0].title = "Renamed";
  });
  expect(JSON.parse(await readFile(store.path, "utf8")).attentionDismissals).toEqual([migrated]);
  // Unsnooze clears both migrated lists.
  await fresh.restoreAttention({ taskId: "t" });
  expect((await fresh.read()).attentionDismissals).toEqual([]);
});

test("snoozing one signal adds it to its own list's set and keeps every key already there", async () => {
  const { store } = await setup();
  await store.dismissAttention({ taskId: "t", list: "needs", signals: ["q:e1"] });
  await store.dismissAttention({ taskId: "t", list: "updated", signals: ["u:a"] });
  const record = await store.dismissAttentionSignal({ taskId: "t", signal: "p:s:r1", current: ["q:e1", "p:s:r1", "u:b"] });
  expect(record.needs?.signals).toEqual(["q:e1", "p:s:r1"]);
  expect(record.updated?.signals).toEqual(["u:a"]);
  const after = await store.read();
  expect(after.attentionDismissals).toEqual([record]);
  // Again: unchanged, nothing written.
  const bytes = await readFile(store.path, "utf8");
  expect(await store.dismissAttentionSignal({ taskId: "t", signal: "p:s:r1", current: [] })).toEqual(record);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
  // An unread turn joins Updates and never touches Needs you.
  const unread = await store.dismissAttentionSignal({ taskId: "t", signal: "u:b", current: ["q:e1", "u:b"] });
  expect(unread.updated?.signals).toEqual(["u:a", "u:b"]);
  expect(unread.needs?.signals).toEqual(["q:e1", "p:s:r1"]);
  // No record yet: a new one with that one key in its list.
  await store.restoreAttention({ taskId: "t" });
  const fresh = await store.dismissAttentionSignal({ taskId: "t", signal: "b:e2", current: ["b:e2"] });
  expect(fresh).toEqual({ taskId: "t", needs: { signals: ["b:e2"], snoozedAt: expect.any(String) } });
  await expect(store.dismissAttentionSignal({ taskId: "missing", signal: "b:e2", current: [] })).rejects.toThrow("Task not found");
});

test("a full list drops only its oldest keys that are no longer current", async () => {
  const { store } = await setup();
  const old = Array.from({ length: 100 }, (_, i) => `q:old${i}`);
  await store.dismissAttention({ taskId: "t", list: "needs", signals: old });
  // `current` of the other list does not keep needs keys alive.
  const record = await store.dismissAttentionSignal({ taskId: "t", signal: "q:new", current: ["q:old0", "q:new", "u:old1"] });
  expect(record.needs?.signals).toHaveLength(100);
  expect(record.needs?.signals).toContain("q:old0");
  expect(record.needs?.signals).not.toContain("q:old1");
  expect(record.needs?.signals.at(-1)).toBe("q:new");
  // Every key still current and no room: refused rather than losing one.
  await store.dismissAttention({ taskId: "t", list: "needs", signals: old });
  await expect(store.dismissAttentionSignal({ taskId: "t", signal: "q:new", current: [...old, "q:new"] })).rejects.toThrow();
  expect((await store.read()).attentionDismissals[0].needs?.signals).toEqual(old);
});
