import { describe, expect, test } from "vitest";
import { groupLaneCounts, groupLanesFrom, syncGroupLanes } from "./group-lanes";
import { projectLanes } from "./lanes";
import { statuses, type Board, type Group, type Lane, type Project, type Status, type Task } from "./model";

/** Group lanes (BOARD-GROUPS-SPEC §1, §7 step 7). */

const at = "2026-11-10T10:00:00.000Z";
const lanes = (on: (s: Status) => boolean, names: Partial<Record<Status, string>> = {}): Lane[] =>
  statuses.map((status) => ({ status, enabled: on(status), ...(names[status] ? { name: names[status] } : {}) }));
const project = (id: string, groupId: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `native-${id}`,
  primaryPath: `/${id}`,
  repos: [`/${id}`],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  groupId,
  ...extra,
});
const task = (id: string, projectId: string, status: Status, extra: Partial<Task> = {}): Task => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: "/",
  repoPaths: [],
  title: id,
  description: "",
  status,
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...extra,
});
const group = (id: string, extra: Partial<Group> = {}): Group => ({ id, name: id, position: 0, revision: 1, createdAt: at, updatedAt: at, ...extra });
type Lanes = Pick<Board, "groups" | "projects" | "tasks">;
const on = (l: { lanes?: Lane[] }) => projectLanes(l).filter((x) => x.enabled).map((x) => x.status);

describe("groupLanesFrom (the migration's union)", () => {
  test("a status is on when any live member has it on, in the default order", () => {
    const a = project("a", "g", { lanes: [...lanes((s) => s === "todo" || s === "done")].reverse() });
    const b = project("b", "g", { lanes: lanes((s) => s === "blocked" || s === "todo") });
    const result = groupLanesFrom([a, b], []);
    expect(result.map((l) => l.status)).toEqual([...statuses]);
    expect(on({ lanes: result })).toEqual(["todo", "blocked", "done"]);
  });
  test("a member with no stored lanes has every lane on", () => {
    const result = groupLanesFrom([project("a", "g", { lanes: lanes((s) => s === "todo") }), project("b", "g")], []);
    expect(on({ lanes: result })).toEqual([...statuses]);
  });
  test("archived members do not count", () => {
    const result = groupLanesFrom([project("a", "g", { lanes: lanes((s) => s === "todo") }), project("b", "g", { archivedAt: at })], []);
    expect(on({ lanes: result })).toEqual(["todo"]);
  });
  test("a name is kept only when every member that has the lane on uses it", () => {
    const a = project("a", "g", { lanes: lanes(() => true, { todo: "Ready", in_review: "QA", blocked: "Stuck" }) });
    const b = project("b", "g", { lanes: lanes((s) => s !== "blocked", { todo: "Ready", in_review: "Review" }) });
    const result = groupLanesFrom([a, b], []);
    const name = (s: Status) => result.find((l) => l.status === s)!.name;
    expect(name("todo")).toBe("Ready"); // both agree
    expect(name("in_review")).toBeUndefined(); // they disagree: the default name
    expect(name("blocked")).toBe("Stuck"); // b has it off, so only a counts
  });
  test("a member using the built-in name disagrees with a custom one", () => {
    const result = groupLanesFrom([project("a", "g", { lanes: lanes(() => true, { todo: "Ready" }) }), project("b", "g", { lanes: lanes(() => true) })], []);
    expect(result.find((l) => l.status === "todo")!.name).toBeUndefined();
  });
  test("statuses holding live cards are turned on", () => {
    const result = groupLanesFrom([project("a", "g", { lanes: lanes((s) => s === "todo") })], ["blocked"]);
    expect(on({ lanes: result })).toEqual(["todo", "blocked"]);
  });
  test("one member's custom order is kept", () => {
    const reversed = [...lanes((s) => s !== "backlog")].reverse();
    const result = groupLanesFrom([project("a", "g", { lanes: reversed })], []);
    expect(result.map((l) => l.status)).toEqual(reversed.map((l) => l.status));
  });
  test("members sharing a custom order keep it; members that disagree get the default order", () => {
    const custom = (on: (s: Status) => boolean) => [...lanes(on)].reverse();
    const same = groupLanesFrom([project("a", "g", { lanes: custom((s) => s === "todo") }), project("b", "g", { lanes: custom((s) => s === "done") })], []);
    expect(same.map((l) => l.status)).toEqual([...statuses].reverse());
    expect(on({ lanes: same })).toEqual(["done", "todo"]);
    const mixed = groupLanesFrom([project("a", "g", { lanes: custom(() => true) }), project("b", "g", { lanes: lanes(() => true) })], []);
    expect(mixed.map((l) => l.status)).toEqual([...statuses]);
    // A member with no stored lanes has the default order, so it disagrees with a custom one.
    const withDefault = groupLanesFrom([project("a", "g", { lanes: custom(() => true) }), project("b", "g")], []);
    expect(withDefault.map((l) => l.status)).toEqual([...statuses]);
  });
  test("no live member: every lane on, built-in names", () => {
    expect(groupLanesFrom([], [])).toEqual(statuses.map((status) => ({ status, enabled: true })));
  });
});

describe("syncGroupLanes", () => {
  test("fills in a group's lanes, mirrors them to every member (archived ones too), and is idempotent", () => {
    const board: Lanes = {
      groups: [group("g"), group("h")],
      projects: [
        project("a", "g", { lanes: lanes((s) => s === "todo" || s === "done", { todo: "Ready" }) }),
        project("b", "g", { lanes: lanes((s) => s === "development", { development: "Doing" }) }),
        project("old", "g", { archivedAt: at, lanes: lanes((s) => s === "cancelled") }),
        project("c", "h"),
      ],
      tasks: [task("t1", "a", "blocked"), task("t2", "a", "test", { archivedAt: at }), task("t3", "old", "design")],
    };
    const first = syncGroupLanes(board, at);
    expect(first.changed).toBe(true);
    const g = board.groups[0];
    expect(on(g)).toEqual(["todo", "development", "blocked", "done"]);
    expect(g.lanes!.find((l) => l.status === "todo")!.name).toBe("Ready");
    expect(g.lanes!.find((l) => l.status === "development")!.name).toBe("Doing");
    expect(g.revision).toBe(1); // the migration bumps nothing
    for (const p of board.projects.filter((p) => p.groupId === "g")) expect(p.lanes).toEqual(g.lanes);
    expect(board.projects.find((p) => p.id === "c")!.lanes).toEqual(board.groups[1].lanes);
    const copy = JSON.stringify(board);
    expect(syncGroupLanes(board, at).changed).toBe(false);
    expect(JSON.stringify(board)).toBe(copy);
  });
  test("a group that has lanes is never recomputed; a live card in an off lane turns it on and bumps the group", () => {
    const board: Lanes = {
      groups: [group("g", { lanes: lanes((s) => s === "todo") })],
      projects: [project("a", "g", { lanes: lanes(() => true) })],
      tasks: [task("t1", "a", "todo")],
    };
    expect(syncGroupLanes(board, at).changed).toBe(true);
    expect(on(board.projects[0])).toEqual(["todo"]);
    expect(board.groups[0].revision).toBe(1);
    board.tasks.push(task("t2", "a", "blocked"));
    const later = "2026-11-11T00:00:00.000Z";
    const r = syncGroupLanes(board, later);
    expect(r).toMatchObject({ changed: true, enabled: ["g"] });
    expect(on(board.groups[0])).toEqual(["todo", "blocked"]);
    expect(board.groups[0]).toMatchObject({ revision: 2, updatedAt: later });
    expect(board.projects[0].lanes).toEqual(board.groups[0].lanes);
  });
  test("bumpRevision false (reads): the lane is turned on, the group's revision and updatedAt stay", () => {
    const board: Lanes = {
      groups: [group("g", { lanes: lanes((s) => s === "todo") })],
      projects: [project("a", "g")],
      tasks: [task("t1", "a", "blocked")],
    };
    const r = syncGroupLanes(board, "2026-11-11T00:00:00.000Z", { bumpRevision: false });
    expect(r.changed).toBe(true);
    expect(on(board.groups[0])).toEqual(["todo", "blocked"]);
    expect(board.groups[0]).toMatchObject({ revision: 1, updatedAt: at });
  });
  test("cards of archived members do not turn lanes on", () => {
    const board: Lanes = {
      groups: [group("g", { lanes: lanes((s) => s === "todo") })],
      projects: [project("old", "g", { archivedAt: at })],
      tasks: [task("t1", "old", "blocked")],
    };
    syncGroupLanes(board, at);
    expect(on(board.groups[0])).toEqual(["todo"]);
  });
});

test("groupLaneCounts counts live cards of live members only", () => {
  const board: Lanes = {
    groups: [group("g")],
    projects: [project("a", "g"), project("b", "g"), project("old", "g", { archivedAt: at }), project("x", "other")],
    tasks: [task("1", "a", "todo"), task("2", "b", "todo"), task("3", "b", "blocked"), task("4", "a", "todo", { archivedAt: at }), task("5", "old", "todo"), task("6", "x", "todo")],
  };
  expect(groupLaneCounts(board, "g")).toEqual({ todo: 2, blocked: 1 });
});
