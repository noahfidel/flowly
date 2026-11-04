import { describe, expect, test } from "vitest";
import { columnOf, groupIssues, linearCardsByKey, visibleGroups, type LinearIssueRow } from "./linear-board";

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
  statePosition: 0,
  assignee: "",
  teamKey: key.split("-")[0]!,
  teamName: "Engineering",
  ...extra,
});

describe("Linear board columns (LINEAR-BOARD-SPEC §4)", () => {
  test("state types map to the five columns; triage and unknown types count as Backlog", () => {
    expect(["triage", "backlog", "unstarted", "started", "completed", "canceled", "cancelled", "Started", "weird", ""].map(columnOf)).toEqual([
      "backlog",
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
      "canceled",
      "started",
      "backlog",
      "backlog",
    ]);
  });

  test("custom state names land in the column of their type, every column is present, ordered by priority then update", () => {
    const groups = groupIssues([
      row("ENG-1", "started", { stateName: "In Review", priority: 3 }),
      row("ENG-2", "started", { stateName: "QA", priority: 1 }),
      row("ENG-3", "started", { stateName: "In Progress", priority: 0, updated: "2026-11-03T00:00:00.000Z" }),
      row("ENG-4", "started", { stateName: "In Progress", priority: 3, updated: "2026-11-02T00:00:00.000Z" }),
      row("ENG-5", "completed", { stateName: "Shipped" }),
      row("ENG-6", "triage", { stateName: "Triage" }),
    ]);
    expect(groups.map((g) => [g.column, g.issues.map((i) => i.key)])).toEqual([
      ["backlog", ["ENG-6"]],
      ["unstarted", []],
      ["started", ["ENG-2", "ENG-4", "ENG-1", "ENG-3"]],
      ["completed", ["ENG-5"]],
      ["canceled", []],
    ]);
  });
});

describe("status filter (LINEAR-BOARD-SPEC §4)", () => {
  test("hidden columns drop out in order; the rest keep their issues", () => {
    const groups = groupIssues([row("ENG-1", "started"), row("ENG-2", "completed"), row("ENG-3", "canceled")]);
    expect(visibleGroups(groups, ["completed", "canceled"]).map((g) => [g.column, g.issues.length])).toEqual([
      ["backlog", 0],
      ["unstarted", 0],
      ["started", 1],
    ]);
    expect(visibleGroups(groups, [])).toHaveLength(5);
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
