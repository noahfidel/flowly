import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { legacyBoardGroups, legacyBoardViewPath, readLegacyBoardGroups } from "./legacy-board-groups";

/** The raw v1 parse the migration reads (BOARD-GROUPS-SPEC §7 step 1). */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "flowly-legacy-groups-"));
  directories.push(path);
  return path;
}
async function stored(text: string) {
  const file = legacyBoardViewPath(await home());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

test("the settings file sits in the host's plugin settings for flowly", () => {
  expect(legacyBoardViewPath("/h")).toBe("/h/plugin-settings/flowly/board-view.json");
});

test("a missing file, bad JSON, an envelope without values or a corrupt boardGroups read as no groups", async () => {
  expect(await readLegacyBoardGroups(legacyBoardViewPath(await home()))).toEqual([]);
  expect(await readLegacyBoardGroups(await stored("{not json"))).toEqual([]);
  expect(await readLegacyBoardGroups(await stored(JSON.stringify({ version: 1 })))).toEqual([]);
  expect(await readLegacyBoardGroups(await stored(JSON.stringify({ version: 1, values: { boardGroups: "oops" } })))).toEqual([]);
  expect(await readLegacyBoardGroups(await stored("null"))).toEqual([]);
});

test("a valid file gives its groups in stored order and is never written", async () => {
  const text = JSON.stringify({
    version: 1,
    values: {
      allProjectsTab: false,
      boardGroups: [
        { id: "z", name: "Zenlytic", projectIds: ["p1", "p2"] },
        { id: "t", name: "Tooling", projectIds: ["p3"] },
      ],
    },
  });
  const file = await stored(text);
  expect(await readLegacyBoardGroups(file)).toEqual([
    { id: "z", name: "Zenlytic", projectIds: ["p1", "p2"] },
    { id: "t", name: "Tooling", projectIds: ["p3"] },
  ]);
  expect(await readFile(file, "utf8")).toBe(text);
});

test("the v1 rules: invalid entries dropped, names cut to 80, bad member lists read as none; no cap here", () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, projectIds: [] }));
  expect(legacyBoardGroups({ boardGroups: many })).toHaveLength(51);
  expect(
    legacyBoardGroups({
      boardGroups: [
        null,
        { id: "", name: "No id", projectIds: [] },
        { id: "x".repeat(101), name: "Long id", projectIds: [] },
        { id: "ok", name: "n".repeat(90), projectIds: "oops" },
        { id: "num", name: 7, projectIds: ["a"] },
      ],
    }),
  ).toEqual([
    { id: "ok", name: "n".repeat(80), projectIds: [] },
    { id: "num", name: "", projectIds: ["a"] },
  ]);
});

test("a file that exists but cannot be read fails, so the migration is retried instead of losing the groups", async () => {
  if (process.getuid?.() === 0) return;
  const file = await stored(JSON.stringify({ version: 1, values: { boardGroups: [] } }));
  await chmod(file, 0o000);
  await expect(readLegacyBoardGroups(file)).rejects.toThrow();
  await chmod(file, 0o600);
});
