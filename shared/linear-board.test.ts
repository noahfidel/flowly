import { describe, expect, test } from "vitest";
import { buildLanes, issueMatches, linearCardsByKey, linearSearchKey, searchLanes, visibleGroups, type LinearIssueRow, type LinearState } from "./linear-board";

const row = (key: string, stateType: string, extra: Partial<LinearIssueRow> = {}): LinearIssueRow => ({
  key,
  remoteId: `uuid-${key}`,
  title: key,
  url: `https://linear.app/acme/issue/${key}`,
  updated: "2026-11-01T00:00:00.000Z",
  priority: 0,
  priorityLabel: "",
  stateName: stateType,
  stateType,
  stateId: `s-${stateType}`,
  teamId: "zen",
  statePosition: 0,
  assignee: "",
  teamKey: key.split("-")[0]!,
  teamName: "Engineering",
  ...extra,
});

const state = (name: string, type: string, position: number, teamId = "zen"): LinearState => ({ id: `${teamId}-${name}`, name, type, position, teamId });
const zen = [
  state("Done", "completed", 1),
  state("Deployed", "started", 4),
  state("Triage", "triage", 0),
  state("In Review", "started", 2),
  state("Backlog", "backlog", 1),
  state("Duplicate", "duplicate", 0),
  state("To Do", "unstarted", 0),
  state("Awaiting Deploy", "started", 3),
  state("In Progress", "started", 1),
  state("Canceled", "canceled", 0),
];

describe("Linear board lanes (LINEAR-BOARD-SPEC §4)", () => {
  test("one lane per workflow state in Linear's order, empty ones included", () => {
    const lanes = buildLanes(zen, []);
    expect(lanes.map((l) => l.title)).toEqual(["Triage", "Backlog", "To Do", "In Progress", "In Review", "Awaiting Deploy", "Deployed", "Done", "Canceled", "Duplicate"]);
    expect(lanes.map((l) => l.key)).toEqual(["triage", "backlog", "to do", "in progress", "in review", "awaiting deploy", "deployed", "done", "canceled", "duplicate"]);
    expect(lanes.every((l) => l.issues.length === 0)).toBe(true);
  });

  test("issues land in the lane of their state name, ordered by priority then update", () => {
    const lanes = buildLanes(zen, [
      row("ZEN-1", "started", { stateName: "In Review", priority: 3 }),
      row("ZEN-2", "started", { stateName: "In Review", priority: 1 }),
      row("ZEN-3", "started", { stateName: "Deployed", updated: "2026-11-03T00:00:00.000Z" }),
      row("ZEN-4", "started", { stateName: "Deployed", priority: 3, updated: "2026-11-02T00:00:00.000Z" }),
      row("ZEN-5", "duplicate", { stateName: "Duplicate" }),
      row("ZEN-6", "triage", { stateName: "Triage" }),
    ]);
    const by = Object.fromEntries(lanes.map((l) => [l.title, l.issues.map((i) => i.key)]));
    expect(by["In Review"]).toEqual(["ZEN-2", "ZEN-1"]);
    expect(by["Deployed"]).toEqual(["ZEN-4", "ZEN-3"]);
    expect(by["Duplicate"]).toEqual(["ZEN-5"]);
    expect(by["Triage"]).toEqual(["ZEN-6"]);
    expect(by["Backlog"]).toEqual([]);
  });

  test("Assigned to me merges the states of several teams by name, case-insensitively", () => {
    const cho = [state("backlog ", "backlog", 0, "cho"), state("To Do", "unstarted", 0, "cho"), state("In Progress", "started", 1, "cho"), state("In Review", "started", 2, "cho"), state("Blocked", "started", 3, "cho"), state("Done", "completed", 1, "cho"), state("Canceled", "canceled", 0, "cho"), state("Duplicate", "duplicate", 0, "cho")];
    const lanes = buildLanes([...zen, ...cho], [row("CHO-1", "started", { stateName: "BLOCKED", statePosition: 3 }), row("ZEN-1", "backlog", { stateName: "Backlog", statePosition: 1 })]);
    expect(lanes.map((l) => l.title)).toEqual(["Triage", "Backlog", "To Do", "In Progress", "In Review", "Awaiting Deploy", "Blocked", "Deployed", "Done", "Canceled", "Duplicate"]);
    expect(lanes.find((l) => l.key === "blocked")!.issues.map((i) => i.key)).toEqual(["CHO-1"]);
    expect(lanes.find((l) => l.key === "backlog")!.issues.map((i) => i.key)).toEqual(["ZEN-1"]);
  });

  test("an issue in a state the list lacks gets a lane from its own fields and is never dropped", () => {
    const lanes = buildLanes(zen, [
      row("ZEN-1", "started", { stateName: "QA", statePosition: 2.5 }),
      row("ZEN-2", "weird", { stateName: "Odd" }),
    ]);
    expect(lanes.map((l) => l.title)).toEqual(["Triage", "Backlog", "To Do", "In Progress", "In Review", "QA", "Awaiting Deploy", "Deployed", "Done", "Canceled", "Duplicate", "Odd"]);
    expect(lanes.find((l) => l.key === "qa")!.issues.map((i) => i.key)).toEqual(["ZEN-1"]);
    expect(lanes.at(-1)!.issues.map((i) => i.key)).toEqual(["ZEN-2"]);
    // With no states at all, the issues alone make the lanes.
    expect(buildLanes([], [row("ZEN-3", "completed", { stateName: "Done" })]).map((l) => [l.key, l.issues.length])).toEqual([["done", 1]]);
  });

  test("an empty state name goes to a lane with the empty key", () => {
    const lanes = buildLanes([], [row("ZEN-1", "started", { stateName: "" })]);
    expect(lanes.map((l) => [l.key, l.title, l.issues.length])).toEqual([["", "", 1]]);
  });
});

describe("status filter (LINEAR-BOARD-SPEC §4)", () => {
  test("hidden lanes drop out by key, in order; the rest keep their issues", () => {
    const lanes = buildLanes(zen, [row("ZEN-1", "started", { stateName: "In Progress" })]);
    expect(visibleGroups(lanes, ["done", "canceled", "duplicate", "triage"]).map((l) => l.title)).toEqual(["Backlog", "To Do", "In Progress", "In Review", "Awaiting Deploy", "Deployed"]);
    expect(visibleGroups(lanes, [])).toHaveLength(10);
  });
});

describe("already has a card (LINEAR-BOARD-SPEC §3.3)", () => {
  const task = (id: string, updatedAt: string, archivedAt: string | null = null) => ({ id, projectId: `p-${id}`, workspaceId: `w-${id}`, title: `Card ${id}`, archivedAt, updatedAt });
  test("a live card with a Linear input of that key, through any connection; the most recently updated wins", () => {
    const cards = linearCardsByKey(
      [task("a", "2026-11-01T00:00:00.000Z"), task("b", "2026-11-03T00:00:00.000Z"), task("old", "2026-11-04T00:00:00.000Z", "2026-11-04T00:00:00.000Z"), task("c", "2026-11-02T00:00:00.000Z")],
      [
        { taskId: "a", external: { provider: "linear", key: "ENG-1" } },
        { taskId: "b", external: { provider: "linear", key: "eng-1" } },
        // Archived cards don't count.
        { taskId: "old", external: { provider: "linear", key: "ENG-2" } },
        // A Jira ticket with the same key is another item.
        { taskId: "c", external: { provider: "jira-cloud", key: "ENG-3" } },
        // Plain links and deleted cards don't count.
        { taskId: "c" },
        { taskId: "gone", external: { provider: "linear", key: "ENG-4" } },
      ],
    );
    expect([...cards]).toEqual([["ENG-1", { taskId: "b", projectId: "p-b", workspaceId: "w-b", title: "Card b" }]]);
  });
});

describe("search (LINEAR-BOARD-SPEC §4)", () => {
  const a = row("ZEN-9132", "started", { title: "Fix deploy", assignee: "Ada Lovelace", stateName: "In Progress", teamKey: "ZEN", teamName: "Zenlytic", priorityLabel: "Urgent" });
  const b = row("ZEN-1", "started", { title: "Fix build", stateName: "In Progress", teamKey: "ZEN", teamName: "Zenlytic" });
  test("matches key (case-insensitive), title, assignee, state, team and priority", () => {
    for (const q of ["zen-9132", "ZEN-9132", "deploy", "lovelace", "in progress", "zenlytic", "urgent"]) expect(issueMatches(a, q), q).toBe(true);
    expect(issueMatches(a, "nothing")).toBe(false);
  });
  test("words are AND-ed; a blank query matches everything", () => {
    expect(issueMatches(a, "zen deploy")).toBe(true);
    expect(issueMatches(b, "zen deploy")).toBe(false);
    expect(issueMatches(b, "")).toBe(true);
    expect(issueMatches(b, "   ")).toBe(true);
  });
  const lanes = buildLanes(zen, [a, b, row("ZEN-2", "unstarted", { title: "Other", stateName: "To Do" })]);
  test("a blank query returns the lanes unchanged, empty lanes kept", () => {
    expect(searchLanes(lanes, "  ")).toBe(lanes);
  });
  test("a query filters each lane in order and drops lanes left empty", () => {
    const found = searchLanes(lanes, "fix");
    expect(found.map((l) => l.title)).toEqual(["In Progress"]);
    expect(found[0].issues.map((i) => i.key)).toEqual(lanes.find((l) => l.title === "In Progress")!.issues.filter((i) => i.title.includes("Fix")).map((i) => i.key));
    expect(searchLanes(lanes, "zzz")).toEqual([]);
  });
  test("search key", () => {
    expect(linearSearchKey("c1", "me")).toBe("c1:me");
  });
});
