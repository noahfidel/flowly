import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UmbrellaReadStore } from "./umbrella-reads";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "flowly-umbrella-reads-"));
  roots.push(root);
  return root;
}

test("marks never move backwards and survive a reload", async () => {
  const root = await directory();
  const store = new UmbrellaReadStore(root);
  expect(await store.seen("s1", "u")).toBeNull();
  await store.mark("s1", "u", { brief: 3, contract: 2, entries: ["e1", "e2"] });
  // A truncated brief (null) and an older contract keep what was read; entries only add.
  await store.mark("s1", "u", { brief: null, contract: 1, entries: ["e2", "e3"] });
  await store.mark("s1", "other", { brief: null, contract: 0, entries: [] });
  const reloaded = new UmbrellaReadStore(root);
  expect(await reloaded.seen("s1", "u")).toEqual({ brief: 3, contract: 2, entries: ["e1", "e2", "e3"] });
  expect(await reloaded.seen("s1", "other")).toEqual({ brief: 0, contract: 0, entries: [] });
  expect(await reloaded.seen("s2", "u")).toBeNull();
  expect(JSON.parse(await readFile(join(root, "umbrella-reads.json"), "utf8")).version).toBe(1);
});

test("entry ids per umbrella keep the 1,000 newest", async () => {
  const store = new UmbrellaReadStore(await directory());
  await store.mark("s", "u", { brief: 0, contract: 0, entries: Array.from({ length: 1000 }, (_, i) => `old${i}`) });
  await store.mark("s", "u", { brief: 0, contract: 0, entries: ["new1", "new2"] });
  const seen = (await store.seen("s", "u"))!;
  expect(seen.entries).toHaveLength(1000);
  expect(seen.entries.slice(-2)).toEqual(["new1", "new2"]);
  expect(seen.entries).not.toContain("old0");
  expect(seen.entries).not.toContain("old1");
});

test("sessions past 2,000 drop the oldest", async () => {
  let now = Date.parse("2026-11-25T00:00:00.000Z");
  const root = await directory();
  await mkdir(root, { recursive: true });
  const sessions = Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`s${i}`, { at: new Date(now + i).toISOString(), umbrellas: {} }]),
  );
  await writeFile(join(root, "umbrella-reads.json"), JSON.stringify({ version: 1, sessions }));
  const store = new UmbrellaReadStore(root, () => now + 10_000);
  await store.mark("newest", "u", { brief: 1, contract: 0, entries: [] });
  const state = JSON.parse(await readFile(join(root, "umbrella-reads.json"), "utf8"));
  expect(Object.keys(state.sessions)).toHaveLength(2000);
  expect(state.sessions.s0).toBeUndefined();
  expect(state.sessions.newest).toBeDefined();
  now = 0;
});

test("an invalid file is preserved and reported", async () => {
  const root = await directory();
  const path = join(root, "umbrella-reads.json");
  await writeFile(path, "{not json");
  const store = new UmbrellaReadStore(root);
  await expect(store.seen("s", "u")).rejects.toThrow(/Umbrella read data is invalid; preserved at/);
  await expect(store.mark("s", "u", { brief: 1, contract: 1, entries: [] })).rejects.toThrow(/invalid/);
  expect(await readFile(path, "utf8")).toBe("{not json");
});
