import { describe, expect, test } from "vitest";
import {
  addGroup,
  boardScope,
  deleteGroup,
  groupMembers,
  groupOfView,
  groupQuickProject,
  groupViewId,
  isGroupView,
  membersFirst,
  mobileLane,
  renameGroup,
  staleGroupChoice,
  toggleMember,
  type BoardGroup,
} from "./board-groups";
import { ALL_PROJECTS, allStatuses } from "./all-projects";
import { pickView } from "./project-memory";
import { needsCount, needsQueue, updatedQueue } from "./step-through";
import { MAX_BOARD_GROUPS, MAX_GROUP_NAME, boardViewValues } from "../shared/settings";
import type { AttentionItem } from "../shared/attention";
import type { Project } from "../shared/model";

const project = (id: string, over: Partial<Project> = {}): Project =>
  ({
    id,
    paseoProjectId: `native-${id}`,
    title: id,
    description: "",
    primaryPath: `/tmp/${id}`,
    repos: [],
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    ...over,
  }) as Project;

const a = project("a", { position: 2 }),
  b = project("b", { position: 0 }),
  c = project("c", { position: 1 }),
  old = project("old", { position: 3, archivedAt: "2026-11-02T00:00:00.000Z" });
const projects = [a, b, c, old];
const loadout: BoardGroup = { id: "g1", name: "Loadout", projectIds: ["a", "b", "deleted", "old"] };
const zen: BoardGroup = { id: "g2", name: "Zenlytic", projectIds: ["c", "a"] };
const empty: BoardGroup = { id: "g3", name: "Empty", projectIds: [] };

describe("group view ids", () => {
  test("a group's view id never collides with All or a project id and maps back to the group", () => {
    const id = groupViewId("g1");
    expect(id).not.toBe(ALL_PROJECTS);
    expect(isGroupView(id)).toBe(true);
    expect(isGroupView("a")).toBe(false);
    expect(isGroupView(ALL_PROJECTS)).toBe(false);
    expect(groupOfView([loadout, zen], id)).toBe(loadout);
    expect(groupOfView([loadout, zen], groupViewId("nope"))).toBeUndefined();
    expect(groupOfView([loadout], "a")).toBeUndefined();
  });
});

describe("members", () => {
  test("live members in chooser order; deleted and archived projects drop out silently", () => {
    expect(groupMembers(loadout, projects).map((p) => p.id)).toEqual(["b", "a"]);
    expect(groupMembers(zen, projects).map((p) => p.id)).toEqual(["c", "a"]);
    expect(groupMembers(empty, projects)).toEqual([]);
  });
  test("a group's columns are its members' enabled lanes", () => {
    expect(allStatuses(groupMembers(empty, projects))).toEqual([]);
  });
});

describe("scope predicate", () => {
  test("All covers every project, a group only its members, a project only itself", () => {
    const all = boardScope({ kind: "all" });
    const group = boardScope({ kind: "group", projectIds: groupMembers(loadout, projects).map((p) => p.id) });
    const one = boardScope({ kind: "project", projectId: "c" });
    expect(["a", "b", "c", "x"].map(all)).toEqual([true, true, true, true]);
    expect(["a", "b", "c", "deleted", "old"].map(group)).toEqual([true, true, false, false, false]);
    expect(["a", "c"].map(one)).toEqual([false, true]);
    expect(boardScope({ kind: "group", projectIds: [] })("a")).toBe(false);
  });

  const item = (taskId: string, projectId: string, kind: string, updatedAt: string) =>
    ({
      task: { id: taskId, projectId, title: taskId },
      updatedAt,
      parts: [{ key: `${taskId}:${kind}`, kind, agentId: `ag-${taskId}`, dismissed: false }],
    }) as unknown as AttentionItem;
  const items = [
    item("a1", "a", "permission", "2026-11-10T01:00:00.000Z"),
    item("c1", "c", "permission", "2026-11-10T02:00:00.000Z"),
    item("b1", "b", "unread", "2026-11-10T03:00:00.000Z"),
  ];
  test("need-you and updated queues and counts cover only the group", () => {
    const loadoutScope = boardScope({ kind: "group", projectIds: groupMembers(loadout, projects).map((p) => p.id) });
    const zenScope = boardScope({ kind: "group", projectIds: groupMembers(zen, projects).map((p) => p.id) });
    const none = new Set<string>();
    expect(needsQueue(items, none, loadoutScope)).toEqual(["a1"]);
    expect(needsCount(items, none, loadoutScope)).toBe(1);
    expect(needsQueue(items, none, zenScope)).toEqual(["c1", "a1"]);
    expect(needsCount(items, none, zenScope)).toBe(2);
    expect(updatedQueue(null, items, none, loadoutScope)).toEqual(["b1"]);
    expect(updatedQueue(null, items, none, zenScope)).toEqual([]);
    const emptyScope = boardScope({ kind: "group", projectIds: [] });
    expect(needsCount(items, none, emptyScope)).toBe(0);
  });
});

describe("which view opens", () => {
  const list = [{ id: "p" }, { id: "q" }];
  const all = { id: ALL_PROJECTS, ok: true };
  test("a group is remembered and restored like All", () => {
    expect(pickView(list, "", groupViewId("g1"), all, [groupViewId("g1")])).toEqual({ all: true, view: groupViewId("g1") });
    expect(pickView(list, groupViewId("g1"), "q", all, [groupViewId("g1")])).toEqual({ all: true, view: groupViewId("g1") });
  });
  test("a deleted group falls back like an unavailable All", () => {
    expect(pickView(list, groupViewId("g1"), "q", all, [])).toEqual({ all: false, project: { id: "q" } });
    expect(staleGroupChoice(groupViewId("g1"), [], true)).toBe(true);
    expect(staleGroupChoice(groupViewId("g1"), [groupViewId("g1")], true)).toBe(false);
    expect(staleGroupChoice(groupViewId("g1"), [], false)).toBe(false);
    expect(staleGroupChoice("p", [], true)).toBe(false);
  });
  test("a group shows even when All is unavailable", () => {
    expect(pickView(list, groupViewId("g1"), "", { id: ALL_PROJECTS, ok: false }, [groupViewId("g1")])).toEqual({ all: true, view: groupViewId("g1") });
  });
});

describe("new task in a group", () => {
  test("starts in the last quick-task project when it is a member, else the first member", () => {
    const members = groupMembers(loadout, projects);
    expect(groupQuickProject(members, projects, "a")?.id).toBe("a");
    expect(groupQuickProject(members, projects, "c")?.id).toBe("b");
    expect(groupQuickProject(members, projects, "")?.id).toBe("b");
  });
  test("an empty group falls back to All's rule", () => {
    expect(groupQuickProject([], projects, "c")?.id).toBe("c");
  });
  test("the project picker lists the group's projects first, then the others in their order", () => {
    expect(membersFirst([b, c, a], ["a", "b"]).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});

describe("editing groups", () => {
  test("add trims the name and refuses an empty one", () => {
    expect(addGroup([], "  Loadout ", "id1")).toEqual([{ id: "id1", name: "Loadout", projectIds: [] }]);
    expect(addGroup([loadout], "   ", "id1")).toEqual([loadout]);
  });
  test("rename keeps members; an empty name is refused", () => {
    expect(renameGroup([loadout, zen], "g2", " Zen ")).toEqual([loadout, { ...zen, name: "Zen" }]);
    expect(renameGroup([loadout], "g1", "")).toEqual([loadout]);
  });
  test("delete removes only that group", () => {
    expect(deleteGroup([loadout, zen], "g1")).toEqual([zen]);
  });
  test("a project can be in several groups; ticking twice removes it", () => {
    const once = toggleMember([loadout, zen], "g2", "b");
    expect(once[1].projectIds).toEqual(["c", "a", "b"]);
    expect(once[0]).toBe(loadout);
    expect(toggleMember(once, "g2", "b")[1].projectIds).toEqual(["c", "a"]);
  });
});

describe("stored groups (board-view settings)", () => {
  test("defaults to no groups", () => {
    expect(boardViewValues({}).boardGroups).toEqual([]);
    expect(boardViewValues(undefined).boardGroups).toEqual([]);
  });
  test("valid groups round-trip; a bad value falls back to none without resetting other settings", () => {
    expect(boardViewValues({ boardGroups: [loadout] }).boardGroups).toEqual([loadout]);
    expect(boardViewValues({ boardGroups: "nope", lastProjectId: "p" })).toMatchObject({ boardGroups: [], lastProjectId: "p" });
    expect(boardViewValues({ boardGroups: [{ id: "g", name: 5, projectIds: "x" }] }).boardGroups).toEqual([{ id: "g", name: "", projectIds: [] }]);
  });
});

describe("review fixes (2026-11-10)", () => {
  test("the phone's lane keeps its last value when the board has no lanes (empty group)", () => {
    expect(mobileLane([], "in_review")).toBe("in_review");
    expect(mobileLane(["todo", "done"], "in_review")).toBe("todo");
    expect(mobileLane(["backlog", "done"], "in_review")).toBe("backlog");
    expect(mobileLane(["backlog", "done"], "done")).toBe("done");
  });
  test("more than the cap keeps the first groups instead of dropping them all", () => {
    const many = Array.from({ length: MAX_BOARD_GROUPS + 1 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, projectIds: [] }));
    const kept = boardViewValues({ boardGroups: many }).boardGroups;
    expect(kept).toHaveLength(MAX_BOARD_GROUPS);
    expect(kept[0].id).toBe("g0");
  });
  test("one invalid group is dropped; the others stay", () => {
    expect(boardViewValues({ boardGroups: [{ id: "", name: "x", projectIds: [] }, loadout, 7, null] }).boardGroups).toEqual([loadout]);
  });
  test("a long name is cut to the limit, on save and on read", () => {
    const long = "x".repeat(MAX_GROUP_NAME + 20);
    expect(addGroup([], long, "id")[0].name).toHaveLength(MAX_GROUP_NAME);
    expect(renameGroup([loadout], "g1", long)[0].name).toHaveLength(MAX_GROUP_NAME);
    expect(boardViewValues({ boardGroups: [{ id: "g", name: long, projectIds: [] }] }).boardGroups[0].name).toHaveLength(MAX_GROUP_NAME);
  });
  test("add refuses past the cap", () => {
    const full = Array.from({ length: MAX_BOARD_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}`, projectIds: [] }));
    expect(addGroup(full, "One more", "x")).toHaveLength(MAX_BOARD_GROUPS);
  });
});
