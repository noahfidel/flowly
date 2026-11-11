import { describe, expect, test } from "vitest";
import {
  boardProject,
  boardScope,
  defaultGroup,
  focusFilter,
  groupMembers,
  groupOfProject,
  groupOfView,
  groupQuickProject,
  groupViewId,
  isGroupView,
  membersFirst,
  mobileLane,
  overviewScope,
  pageScope,
  addProject,
  pickGroupView,
  restoredFilter,
  staleGroupChoice,
  validProjectFilter,
} from "./board-groups";
import { allStatuses } from "./all-projects";
import { needsCount, needsQueue, updatedQueue } from "./step-through";
import type { AttentionItem } from "../shared/attention";
import type { Group, Project } from "../shared/model";

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

const group = (id: string, position: number, over: Partial<Group> = {}): Group =>
  ({ id, name: id, position, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over }) as Group;
const loadout = group("g1", 0, { isDefault: true }), zen = group("g2", 1), empty = group("g3", 2);
const groups = [loadout, zen, empty];

const a = project("a", { position: 2, groupId: "g1" }),
  b = project("b", { position: 0, groupId: "g1" }),
  c = project("c", { position: 1, groupId: "g2" }),
  old = project("old", { position: 3, groupId: "g1", archivedAt: "2026-11-02T00:00:00.000Z" }),
  loose = project("loose", { position: 4 });
const projects = [a, b, c, old, loose];

describe("group view ids", () => {
  test("a group's view id never collides with a project id and maps back to the group", () => {
    const id = groupViewId("g1");
    expect(isGroupView(id)).toBe(true);
    expect(isGroupView("a")).toBe(false);
    expect(isGroupView("*all")).toBe(false);
    expect(groupOfView([loadout, zen], id)).toBe(loadout);
    expect(groupOfView([loadout, zen], groupViewId("nope"))).toBeUndefined();
    expect(groupOfView([loadout], "a")).toBeUndefined();
  });
});

describe("members", () => {
  test("live members by groupId in chooser order; archived projects drop out", () => {
    expect(groupMembers(loadout, projects).map((p) => p.id)).toEqual(["b", "a"]);
    expect(groupMembers(zen, projects).map((p) => p.id)).toEqual(["c"]);
    expect(groupMembers(empty, projects)).toEqual([]);
  });
  test("a project with no group is in none until it is assigned", () => {
    expect(groupMembers(loadout, [loose])).toEqual([]);
  });
  test("an empty group has no columns", () => {
    expect(allStatuses(groupMembers(empty, projects))).toEqual([]);
  });
});

describe("group of a project", () => {
  test("its own group, archived projects included", () => {
    expect(groupOfProject(groups, projects, "c")).toBe(zen);
    expect(groupOfProject(groups, projects, "old")).toBe(loadout);
  });
  test("an ungrouped, unknown-group or unknown project falls to the default group", () => {
    expect(groupOfProject(groups, projects, "loose")).toBe(loadout);
    expect(groupOfProject(groups, [project("x", { groupId: "gone" })], "x")).toBe(loadout);
    expect(groupOfProject(groups, projects, "nope")).toBe(loadout);
  });
  test("the default group is the flagged one, else the first by position", () => {
    expect(defaultGroup([zen, loadout])).toBe(loadout);
    expect(defaultGroup([group("y", 5), group("x", 2)])?.id).toBe("x");
    expect(defaultGroup([])).toBeUndefined();
  });
});

describe("scope predicate", () => {
  test("a group covers only its members; an empty group covers nothing", () => {
    const scope = boardScope(groupMembers(loadout, projects).map((p) => p.id));
    expect(["a", "b", "c", "old", "x"].map(scope)).toEqual([true, true, false, false, false]);
    expect(boardScope([])("a")).toBe(false);
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
    const loadoutScope = boardScope(groupMembers(loadout, projects).map((p) => p.id));
    const zenScope = boardScope(groupMembers(zen, projects).map((p) => p.id));
    const none = new Set<string>();
    expect(needsQueue(items, none, loadoutScope)).toEqual(["a1"]);
    expect(needsCount(items, none, loadoutScope)).toBe(1);
    expect(needsQueue(items, none, zenScope)).toEqual(["c1"]);
    expect(needsCount(items, none, zenScope)).toBe(1);
    expect(updatedQueue(null, items, none, loadoutScope)).toEqual(["b1"]);
    expect(updatedQueue(null, items, none, zenScope)).toEqual([]);
    const emptyScope = boardScope([]);
    expect(needsCount(items, none, emptyScope)).toBe(0);
  });

  // Ruling (Noah, 2026-11-10): the counts and step-throughs show on an unfiltered group board too, over every live
  // member; filtered, over that project. Only the per-project entries need a filter.
  test("unfiltered, the overview covers every live member and shows no per-project entries", () => {
    const members = groupMembers(loadout, projects);
    const scope = overviewScope(boardProject("", members), members);
    expect(scope.projects.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(scope.perProject).toBe(false);
    const inScope = boardScope(scope.projects.map((p) => p.id));
    const none = new Set<string>();
    const more = [...items, item("b2", "b", "permission", "2026-11-10T04:00:00.000Z")];
    expect(needsQueue(more, none, inScope)).toEqual(["b2", "a1"]);
    expect(needsCount(more, none, inScope)).toBe(2);
    expect(updatedQueue(null, more, none, inScope)).toEqual(["b1"]);
  });
  test("filtered, the overview covers only that project and shows its per-project entries", () => {
    const members = groupMembers(loadout, projects);
    const scope = overviewScope(boardProject("b", members), members);
    expect(scope.projects.map((p) => p.id)).toEqual(["b"]);
    expect(scope.perProject).toBe(true);
    const inScope = boardScope(scope.projects.map((p) => p.id));
    const none = new Set<string>();
    const more = [...items, item("b2", "b", "permission", "2026-11-10T04:00:00.000Z")];
    expect(needsQueue(more, none, inScope)).toEqual(["b2"]);
    expect(needsCount(more, none, inScope)).toBe(1);
    expect(updatedQueue(null, more, none, inScope)).toEqual(["b1"]);
  });
  test("an empty group has no overview", () => {
    expect(overviewScope(undefined, [])).toEqual({ projects: [], perProject: false });
  });
});

describe("which view opens", () => {
  const pick = (chosen: string, viewed: string) => pickGroupView(groups, projects, chosen, viewed)?.id;
  test("an explicit choice wins over the last viewed", () => {
    expect(pick(groupViewId("g2"), groupViewId("g3"))).toBe("g2");
  });
  test("else the last viewed in this run", () => {
    expect(pick("", groupViewId("g2"))).toBe("g2");
  });
  test("cold start opens the default group", () => {
    expect(pick("", "")).toBe("g1");
    expect(pickGroupView([zen, group("g0", 0)], projects, "", "")?.id).toBe("g0");
  });
  test("no groups, nothing to open", () => {
    expect(pickGroupView([], projects, groupViewId("g1"), "")).toBeUndefined();
  });
  test("the legacy All choice maps to the default group", () => {
    expect(pick("*all", groupViewId("g2"))).toBe("g1");
    expect(pick("", "*all")).toBe("g1");
  });
  test("a legacy project id maps to that project's group, archived too", () => {
    expect(pick("c", "")).toBe("g2");
    expect(pick("", "c")).toBe("g2");
    expect(pick("old", "")).toBe("g1");
  });
  test("a stale explicit choice falls to the last viewed, then the default", () => {
    expect(pick(groupViewId("gone"), groupViewId("g2"))).toBe("g2");
    expect(pick(groupViewId("gone"), groupViewId("gone2"))).toBe("g1");
    expect(pick("unknown-project", "c")).toBe("g2");
    expect(pick(groupViewId("gone"), "")).toBe("g1");
  });
});

// BOARD-GROUPS-SPEC §3: the group last viewed is kept in the board-view settings, so it survives a restart (a fresh
// client bundle wipes module state); a stored group that no longer exists falls back to the default group.
describe("stored last group", () => {
  const pick = (chosen: string, viewed: string, stored: string) => pickGroupView(groups, projects, chosen, viewed, stored)?.id;
  test("a fresh run opens the stored group", () => {
    expect(pick("", "", "g2")).toBe("g2");
  });
  test("this run's last viewed and an explicit choice win over the stored group", () => {
    expect(pick("", groupViewId("g3"), "g2")).toBe("g3");
    expect(pick(groupViewId("g3"), "", "g2")).toBe("g3");
  });
  test("a stored group that was deleted opens the default group", () => {
    expect(pick("", "", "gone")).toBe("g1");
    expect(pick("", groupViewId("gone"), "g2")).toBe("g2");
  });
});

describe("stale choices", () => {
  test("a deleted group's choice is dropped, only once everything is loaded", () => {
    expect(staleGroupChoice(groupViewId("gone"), groups, true)).toBe(true);
    expect(staleGroupChoice(groupViewId("gone"), groups, false)).toBe(false);
    expect(staleGroupChoice(groupViewId("g1"), groups, true)).toBe(false);
  });
  test("legacy choices are not stale; they just map", () => {
    expect(staleGroupChoice("*all", groups, true)).toBe(false);
    expect(staleGroupChoice("p", groups, true)).toBe(false);
    expect(staleGroupChoice("", groups, true)).toBe(false);
  });
});

describe("new task in a group", () => {
  test("starts in the last quick-task project when it is a member, else the first member", () => {
    const members = groupMembers(loadout, projects);
    expect(groupQuickProject(members, projects, "a")?.id).toBe("a");
    expect(groupQuickProject(members, projects, "c")?.id).toBe("b");
    expect(groupQuickProject(members, projects, "")?.id).toBe("b");
  });
  test("the project filter wins, then the last member, then the first; a non-member filter or last is ignored", () => {
    const members = groupMembers(loadout, projects);
    expect(groupQuickProject(members, projects, "a", "b")?.id).toBe("b");
    expect(groupQuickProject(members, projects, "", "a")?.id).toBe("a");
    expect(groupQuickProject(members, projects, "a", "c")?.id).toBe("a");
    expect(groupQuickProject(members, projects, "c", "old")?.id).toBe("b");
    expect(groupQuickProject(members, projects, "a", "")?.id).toBe("a");
  });
  test("the picker keeps members first with a filter set", () => {
    expect(membersFirst([c, b, a], ["b", "a"]).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
  test("an empty group falls back to All's rule", () => {
    expect(groupQuickProject([], projects, "c")?.id).toBe("c");
  });
  test("the project picker lists the group's projects first, then the others in their order", () => {
    expect(membersFirst([b, c, a], ["a", "b"]).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });
});

describe("review fixes (2026-11-10)", () => {
  test("the phone's lane keeps its last value when the board has no lanes (empty group)", () => {
    expect(mobileLane([], "in_review")).toBe("in_review");
    expect(mobileLane(["todo", "done"], "in_review")).toBe("todo");
    expect(mobileLane(["backlog", "done"], "in_review")).toBe("backlog");
    expect(mobileLane(["backlog", "done"], "done")).toBe("done");
  });
});

describe("project filter", () => {
  // §4: the filter is kept in the board-view settings too; this run's own choice (even "none") wins once made.
  test("a fresh board takes the stored filter; a filter already set or cleared in this run wins", () => {
    const stored = { groupId: "g1", projectId: "a" };
    expect(restoredFilter(undefined, stored)).toEqual(stored);
    expect(restoredFilter(undefined, null)).toBeNull();
    expect(restoredFilter({ groupId: "g2", projectId: "b" }, stored)).toEqual({ groupId: "g2", projectId: "b" });
    expect(restoredFilter(null, stored)).toBeNull();
  });
  const f = { groupId: "g1", projectId: "a" };
  test("valid while the group is shown and the project is a member", () => {
    expect(validProjectFilter(f, "g1", ["a", "b"])).toBe("a");
  });
  test("cleared by no filter, another group or a project that left the group", () => {
    expect(validProjectFilter(null, "g1", ["a", "b"])).toBe("");
    expect(validProjectFilter(f, "g2", ["a", "b"])).toBe("");
    expect(validProjectFilter(f, "g1", ["b"])).toBe("");
    expect(validProjectFilter(f, "g1", [])).toBe("");
  });
  test("the filtered project is the board's project; a one-project group's only member is too", () => {
    const members = groupMembers(loadout, projects);
    expect(boardProject("a", members)?.id).toBe("a");
    expect(boardProject("", members)).toBeUndefined();
    expect(boardProject("zzz", members)).toBeUndefined();
    expect(boardProject("", groupMembers(zen, projects))?.id).toBe("c");
    expect(boardProject("", [])).toBeUndefined();
  });
  test("focusing a project in another group filters to it; in the shown group it leaves the filter alone", () => {
    expect(focusFilter(null, "g1", "g2", "c")).toEqual({ groupId: "g2", projectId: "c" });
    expect(focusFilter(f, "g1", "g1", "b")).toBe(f);
    expect(focusFilter(null, "g1", "g1", "b")).toBeNull();
  });
});

// Ruling (Noah, 2026-11-10): Insights, Ideas and Memory work on an unfiltered group board, over every live member;
// filtered (or a group of one), over that project. Guardrails stays single-project.
describe("what Insights, Ideas and Memory cover", () => {
  const members = [project("a"), project("b")];
  test("filtered: the one project, no group read", () => {
    expect(pageScope(members[1], members, "g")).toEqual({ projects: [members[1]], groupId: null });
  });
  test("unfiltered: every live member, read as the group", () => {
    expect(pageScope(undefined, members, "g")).toEqual({ projects: members, groupId: "g" });
  });
  test("nothing for an empty group or a board whose group is not known yet", () => {
    expect(pageScope(undefined, [], "g")).toBeNull();
    expect(pageScope(undefined, members, undefined)).toBeNull();
  });
  test("adding while unfiltered defaults to the member last added to, else the first", () => {
    expect(addProject(members, "b")?.id).toBe("b");
    expect(addProject(members, "")?.id).toBe("a");
    // A project that left the group (or was archived) is not offered, so the first member is used.
    expect(addProject(members, "gone")?.id).toBe("a");
    expect(addProject([], "b")).toBeUndefined();
  });
});
