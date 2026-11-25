import { expect, test } from "vitest";
import { boardSchema, type Task, type Umbrella, type UmbrellaEntry } from "./model";
import { countsTowardLimit, membersOf, umbrellaLimits, umbrellaSummary, umbrellaViewOf } from "./umbrella";

const at = "2026-11-25T00:00:00.000Z";
const human = { kind: "human" as const };
const umbrella = (over: Partial<Umbrella> = {}): Umbrella => ({
  id: "u", groupId: "g", title: "Fresh context",
  brief: { text: "The goal", revision: 1, updatedAt: at, updatedBy: human },
  contract: { text: "Shapes", revision: 0, updatedAt: at, updatedBy: human },
  acceptance: [], status: "open", createdBy: human, createdAt: at, updatedAt: at,
  revision: 1, feedRevision: 0, archivedAt: null, ...over,
});
const entry = (id: string, kind: UmbrellaEntry["kind"], status: UmbrellaEntry["status"], umbrellaId = "u"): UmbrellaEntry => ({
  id, umbrellaId, kind, title: id, body: "", status, by: human, createdAt: at, updatedAt: at,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: ["/p"], title: id.toUpperCase(),
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: at, updatedAt: at, archivedAt: null, ...extra,
});

test("an old board without umbrellas parses with empty collections", () => {
  const board = boardSchema.parse({ version: 5, revision: 3, projects: [], tasks: [], events: [] });
  expect(board.umbrellas).toEqual([]);
  expect(board.umbrellaEntries).toEqual([]);
  expect(board.version).toBe(5);
});

test("limits match the spec", () => {
  expect(umbrellaLimits).toEqual({
    openPerGroup: 50, members: 30, activeEntries: 300, writesPerHour: 20, relaysPerHour: 60,
    brief: 20000, contract: 10000, pendingChanges: 10,
    title: 120, role: 40, acceptance: 20, acceptanceText: 300, entryTitle: 120, entryBody: 2000, quote: 500,
    briefBudget: 8000, feedBudget: 6000, siblings: 30,
  });
});

test("proposed entries do not count toward the 300 limit", () => {
  const counted = (["active", "open"] as const).map((s) => countsTowardLimit(entry(s, "decision", s)));
  const ignored = (["proposed", "superseded", "answered", "accepted", "rejected", "withdrawn"] as const).map((s) =>
    countsTowardLimit(entry(s, "contract_change", s)),
  );
  expect(counted).toEqual([true, true]);
  expect(ignored.every((x) => !x)).toBe(true);
});

test("a summary counts members, open questions and pending changes from the full board", () => {
  const board = {
    tasks: [task("a", { umbrella: { id: "u", joinedAt: at, by: human } }), task("b", { umbrella: { id: "u", joinedAt: at, by: human } }), task("c"), task("d", { umbrella: { id: "other", joinedAt: at, by: human } })],
    umbrellaEntries: [
      entry("q1", "question", "open"), entry("q2", "question", "answered"), entry("q3", "question", "open", "other"),
      entry("c1", "contract_change", "proposed"), entry("c2", "contract_change", "rejected"), entry("d1", "decision", "active"),
    ],
  };
  const summary = umbrellaSummary(umbrella({ feedRevision: 4, linearProject: { url: "https://linear.app/x/project/y", name: "Y" } }), board);
  expect(summary).toEqual({
    id: "u", groupId: "g", title: "Fresh context", status: "open", members: 2, openQuestions: 1, pendingChanges: 1,
    revision: 1, feedRevision: 4, archivedAt: null, linearProject: { url: "https://linear.app/x/project/y", name: "Y" },
  });
  expect(JSON.stringify(summary)).not.toContain("The goal");
});

test("members sort by order, then title; the view of an umbrella drops brief and contract text", () => {
  const board = {
    tasks: [
      task("z", { umbrella: { id: "u", joinedAt: at, by: human } }),
      task("b", { umbrella: { id: "u", order: 2, joinedAt: at, by: human } }),
      task("a", { umbrella: { id: "u", joinedAt: at, by: human } }),
      task("c", { umbrella: { id: "u", order: 1, joinedAt: at, by: human } }),
    ],
  };
  expect(membersOf(board, "u").map((t) => t.id)).toEqual(["c", "b", "a", "z"]);
  const view = umbrellaViewOf(umbrella());
  expect(view.brief).toMatchObject({ text: "", revision: 1 });
  expect(view.contract.text).toBe("");
});
