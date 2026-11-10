import { describe, expect, test } from "vitest";
import {
  assertGroupInvariants,
  dispatcherTarget,
  ensureGroups,
  groupOrder,
  migrateLegacyGroups,
  nameTaken,
  type LegacyGroup,
} from "./groups";
import { emptyBoard, groupSchema, type Board, type Group, type Project, type Task } from "./model";

const now = "2026-11-10T10:00:00.000Z";
function ids() {
  let n = 0;
  return () => `g${++n}`;
}
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `native-${id}`,
  primaryPath: `/${id}`,
  repos: [`/${id}`],
  revision: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  ...extra,
});
const task = (id: string, projectId: string, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: `/${projectId}`,
  repoPaths: [],
  title: id,
  description: "",
  status: "todo",
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  ...extra,
});
const group = (id: string, position: number, extra: Partial<Group> = {}): Group => ({ id, name: id, position, revision: 1, createdAt: now, updatedAt: now, ...extra });
function boardWith(projects: Project[], groups: Group[] = []): Board {
  const b = emptyBoard();
  b.projects = projects;
  b.groups = groups;
  return b;
}
const legacy = (name: string, projectIds: string[], id = name): LegacyGroup => ({ id, name, projectIds });
/** Group name → its projects' ids, in group order; the default group is marked with "*". */
function layout(board: Board) {
  return Object.fromEntries(
    [...board.groups].sort(groupOrder).map((g) => [`${g.name}${g.isDefault ? "*" : ""}`, board.projects.filter((p) => p.groupId === g.id).map((p) => p.id)]),
  );
}

describe("migration of the host's v1 groups (BOARD-GROUPS-SPEC §7 steps 1–2)", () => {
  test("no stored groups and several projects: one default Projects holds every project", () => {
    const b = boardWith([project("a"), project("b"), project("c")]);
    expect(migrateLegacyGroups(b, [], now, ids())).toBe(true);
    expect(layout(b)).toEqual({ "Projects*": ["a", "b", "c"] });
    assertGroupInvariants(b);
  });
  test("one group with some projects: the rest go to Projects, created last and made default", () => {
    const b = boardWith([project("a"), project("b"), project("c")]);
    migrateLegacyGroups(b, [legacy("Loadout", ["b"])], now, ids());
    expect(layout(b)).toEqual({ Loadout: ["b"], "Projects*": ["a", "c"] });
    expect(b.groups.map((g) => g.position)).toEqual([0, 1]);
    assertGroupInvariants(b);
  });
  test("a project in two groups goes to the first in stored order", () => {
    const b = boardWith([project("a"), project("b")]);
    migrateLegacyGroups(b, [legacy("One", ["a"]), legacy("Two", ["a", "b"])], now, ids());
    expect(layout(b)).toEqual({ "One*": ["a"], Two: ["b"] });
  });
  test("a project in no group goes to Projects", () => {
    const b = boardWith([project("a"), project("lonely")]);
    migrateLegacyGroups(b, [legacy("One", ["a"])], now, ids());
    expect(layout(b)).toEqual({ One: ["a"], "Projects*": ["lonely"] });
  });
  test("archived members keep their group; ids of projects no longer on the board are ignored", () => {
    const b = boardWith([project("a"), project("old", { archivedAt: now })]);
    migrateLegacyGroups(b, [legacy("One", ["gone", "old", "a"])], now, ids());
    expect(layout(b)).toEqual({ "One*": ["a", "old"] });
    expect(JSON.stringify(b)).not.toContain("gone");
  });
  test("every project already grouped: the first group becomes the default and no Projects is made", () => {
    const b = boardWith([project("a"), project("b")]);
    migrateLegacyGroups(b, [legacy("Zen", ["b"]), legacy("Load", ["a"])], now, ids());
    expect(layout(b)).toEqual({ "Zen*": ["b"], Load: ["a"] });
  });
  test("a stored group with no member on the board is kept, empty", () => {
    const b = boardWith([project("a")]);
    migrateLegacyGroups(b, [legacy("Empty", ["gone"]), legacy("Full", ["a"])], now, ids());
    expect(layout(b)).toEqual({ "Empty*": [], Full: ["a"] });
  });
  test("blank names are dropped, long names cut to 80, duplicates (ignoring case) renamed with 2, 3", () => {
    const b = boardWith([project("a"), project("b"), project("c"), project("d"), project("e")]);
    const long = "x".repeat(80);
    migrateLegacyGroups(
      b,
      [legacy("   ", ["a"], "blank"), legacy("Work", ["b"], "w1"), legacy(" work ", ["c"], "w2"), legacy("WORK", ["d"], "w3"), legacy(`${long}`, ["e"], "l1"), legacy(long.toUpperCase(), [], "l2")],
      now,
      ids(),
    );
    expect(layout(b)).toEqual({ Work: ["b"], "work 2": ["c"], "WORK 3": ["d"], [long]: ["e"], [`${"X".repeat(78)} 2`]: [], "Projects*": ["a"] });
    for (const g of b.groups) expect(groupSchema.safeParse(g).success).toBe(true);
    assertGroupInvariants(b);
  });
  test("a stored group named Projects keeps its members; the default made for ungrouped projects is Projects 2", () => {
    const b = boardWith([project("a"), project("b")]);
    migrateLegacyGroups(b, [legacy("projects", ["a"])], now, ids());
    expect(layout(b)).toEqual({ projects: ["a"], "Projects 2*": ["b"] });
  });
  test("51 stored groups: the first 50 are kept; projects of the 51st go to Projects only if they need it", () => {
    const stored = Array.from({ length: 51 }, (_, i) => legacy(`G${i}`, [`p${i}`]));
    const allGrouped = boardWith(Array.from({ length: 50 }, (_, i) => project(`p${i}`)));
    migrateLegacyGroups(allGrouped, stored, now, ids());
    expect(allGrouped.groups).toHaveLength(50);
    expect(allGrouped.groups.at(-1)!.name).toBe("G49");
    expect(allGrouped.groups[0].isDefault).toBe(true);
    assertGroupInvariants(allGrouped);
    // p50 sits in the dropped 51st group: Projects is needed and still fits the cap, so the 50th stored group gives way.
    const overflow = boardWith(Array.from({ length: 51 }, (_, i) => project(`p${i}`)));
    migrateLegacyGroups(overflow, stored, now, ids());
    expect(overflow.groups).toHaveLength(50);
    expect(layout(overflow)["Projects*"]).toEqual(["p49", "p50"]);
    expect(overflow.groups.some((g) => g.name === "G49")).toBe(false);
    assertGroupInvariants(overflow);
  });
  test("an empty board is left alone; its first project gets Projects lazily", () => {
    const b = emptyBoard();
    expect(migrateLegacyGroups(b, [legacy("One", [])], now, ids())).toBe(false);
    expect(b.groups).toEqual([]);
    expect(ensureGroups(b, now, ids())).toEqual({ changed: false, projectIds: [] });
    b.projects.push(project("first"));
    ensureGroups(b, now, ids());
    expect(layout(b)).toEqual({ "Projects*": ["first"] });
  });
  test("running twice changes nothing the second time", () => {
    const b = boardWith([project("a"), project("b")]);
    migrateLegacyGroups(b, [legacy("One", ["a"])], now, ids());
    const once = JSON.stringify(b);
    expect(migrateLegacyGroups(b, [legacy("Other", ["a", "b"])], now, ids())).toBe(false);
    expect(ensureGroups(b, now, ids()).changed).toBe(false);
    expect(JSON.stringify(b)).toBe(once);
  });
});

describe("read-time repair (BOARD-GROUPS-SPEC §1)", () => {
  test("a missing or dangling groupId joins the default group, archived projects too", () => {
    const b = boardWith(
      [project("a", { groupId: "one" }), project("b"), project("c", { groupId: "deleted" }), project("d", { groupId: "deleted", archivedAt: now })],
      [group("one", 0), group("two", 1, { isDefault: true })],
    );
    expect(ensureGroups(b, now, ids())).toEqual({ changed: true, projectIds: ["b", "c", "d"] });
    expect(layout(b)).toEqual({ one: ["a"], "two*": ["b", "c", "d"] });
  });
  test("no default: the first group by position takes the flag", () => {
    const b = boardWith([project("a", { groupId: "one" })], [group("one", 1), group("zero", 0)]);
    ensureGroups(b, now, ids());
    expect(b.groups.find((g) => g.isDefault)!.id).toBe("zero");
  });
  test("two defaults: the first by position keeps the flag", () => {
    const b = boardWith([project("a", { groupId: "one" })], [group("one", 1, { isDefault: true }), group("zero", 0, { isDefault: true })]);
    ensureGroups(b, now, ids());
    expect(b.groups.filter((g) => g.isDefault).map((g) => g.id)).toEqual(["zero"]);
    assertGroupInvariants(b);
  });
  test("a board that is in order is not changed", () => {
    const b = boardWith([project("a", { groupId: "one" })], [group("one", 0, { isDefault: true })]);
    const before = JSON.stringify(b);
    expect(ensureGroups(b, now, ids())).toEqual({ changed: false, projectIds: [] });
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe("invariants checked on commit", () => {
  const ok = () => boardWith([project("a", { groupId: "one" })], [group("one", 0, { isDefault: true }), group("two", 1)]);
  test("a valid board passes", () => expect(() => assertGroupInvariants(ok())).not.toThrow());
  test.each([
    ["no default", (b: Board) => delete b.groups[0].isDefault, "Exactly one group"],
    ["two defaults", (b: Board) => (b.groups[1].isDefault = true), "Exactly one group"],
    ["duplicate name ignoring case", (b: Board) => (b.groups[1].name = "ONE"), "Duplicate group name"],
    ["duplicate id", (b: Board) => (b.groups[1].id = "one"), "Duplicate group id"],
    ["ungrouped project", (b: Board) => delete b.projects[0].groupId, "belong to a group"],
    ["dangling project", (b: Board) => (b.projects[0].groupId = "gone"), "belong to a group"],
    ["51 groups", (b: Board) => b.groups.push(...Array.from({ length: 49 }, (_, i) => group(`x${i}`, i + 2))), "at most 50"],
  ])("refuses %s", (_, change, message) => {
    const b = ok();
    change(b);
    expect(() => assertGroupInvariants(b)).toThrow(message);
  });
  test("names: 1–80 characters after trimming", () => {
    expect(groupSchema.safeParse(group("x", 0, { name: "  " })).success).toBe(false);
    expect(groupSchema.safeParse(group("x", 0, { name: "y".repeat(81) })).success).toBe(false);
    expect(groupSchema.safeParse(group("x", 0, { name: "y".repeat(80) })).success).toBe(true);
  });
  test("nameTaken ignores case and the group being renamed", () => {
    const groups = [group("one", 0, { name: "Zenlytic" })];
    expect(nameTaken(groups, " zenlytic ")).toBe(true);
    expect(nameTaken(groups, "zenlytic", "one")).toBe(false);
  });
});

describe("dispatcherTarget (BOARD-GROUPS-SPEC §7 step 4)", () => {
  const b = () => {
    const board = boardWith(
      [project("a", { groupId: "one" }), project("b", { groupId: "two" }), project("old", { groupId: "two", archivedAt: now })],
      [group("one", 0, { isDefault: true }), group("two", 1)],
    );
    board.tasks = [
      task("a1", "a"),
      task("b1", "b"),
      task("b2", "b", { status: "done" }),
      task("b3", "b", { status: "cancelled" }),
      task("b4", "b", { archivedAt: now }),
      task("o1", "old"),
      task("o2", "old"),
    ];
    return board;
  };
  test("a tie (only open cards of live projects count) goes to the first group in order", () => expect(dispatcherTarget(b())).toBe("one"));
  test("the group with most open cards wins", () => {
    const board = b();
    board.tasks.push(task("b5", "b", { status: "development" }));
    expect(dispatcherTarget(board)).toBe("two");
  });
  test("order is by position, not by storage", () => {
    const board = b();
    board.groups[0].position = 5;
    expect(dispatcherTarget(board)).toBe("two");
  });
  test("no groups: none", () => expect(dispatcherTarget(emptyBoard())).toBeNull());
});
