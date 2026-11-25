import { expect, test } from "vitest";
import { boardSchema, emptyBoard, type Board, type Group, type Project, type Task, type Umbrella, type UmbrellaEntry } from "./model";
import {
  applyGroupMoves, countsTowardLimit, leaveUmbrella, membersOf, repairUmbrellaGroups, umbrellaLimits, umbrellaSummary, umbrellasLosingMembers, umbrellaViewOf,
} from "./umbrella";

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

/** Groups A and B; projects p1, p2 in A and q in B; cards a (p1, the integration card), b (p2), c (q, outside). */
function moveBoard(): Board {
  const group = (id: string, isDefault = false): Group => ({ id, name: id, position: 0, ...(isDefault ? { isDefault: true as const } : {}), revision: 1, createdAt: at, updatedAt: at });
  const project = (id: string, groupId: string): Project => ({
    id, title: `Project ${id}`, description: "", paseoProjectId: `n-${id}`, primaryPath: `/${id}`, repos: [`/${id}`],
    revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId,
  });
  const member = { id: "u", joinedAt: at, by: human };
  return {
    ...emptyBoard(),
    groups: [group("A", true), group("B")],
    projects: [project("p1", "A"), project("p2", "A"), project("q", "B")],
    tasks: [task("a", { projectId: "p1", umbrella: member }), task("b", { projectId: "p2", umbrella: member }), task("c", { projectId: "q" })],
    umbrellas: [umbrella({ groupId: "A", integrationTaskId: "a" })],
    umbrellaEntries: [{ ...entry("d1", "decision", "active"), sourceTaskId: "a" }],
  };
}
const moveTo = (board: Board, projectId: string, groupId: string) => (board.projects.find((p) => p.id === projectId)!.groupId = groupId);

test("umbrellasLosingMembers names the umbrellas a move would split", () => {
  const board = moveBoard();
  expect(umbrellasLosingMembers(board, [{ projectId: "p1", groupId: "B" }])).toEqual([{ umbrellaId: "u", title: "Fresh context", cards: 1 }]);
  // All member projects move together: the umbrella follows, nobody is lost.
  expect(umbrellasLosingMembers(board, [{ projectId: "p1", groupId: "B" }, { projectId: "p2", groupId: "B" }])).toEqual([]);
  // A move that touches no member project.
  expect(umbrellasLosingMembers(board, [{ projectId: "q", groupId: "A" }])).toEqual([]);
  // The preview changes nothing.
  expect(board.projects.map((p) => p.groupId)).toEqual(["A", "A", "B"]);
});

test("applyGroupMoves: the umbrella follows when all member projects land in one group", () => {
  const board = moveBoard();
  moveTo(board, "p1", "B");
  moveTo(board, "p2", "B");
  const notes: string[] = [];
  const result = applyGroupMoves(board, ["p1", "p2"], "2026-11-26T00:00:00.000Z", (taskId, note) => notes.push(`${taskId}: ${note}`));
  expect(result).toEqual({ moved: ["u"], lostMembers: [] });
  expect(board.umbrellas[0]).toMatchObject({ groupId: "B", updatedAt: "2026-11-26T00:00:00.000Z", integrationTaskId: "a", revision: 1 });
  expect(board.tasks.filter((t) => t.umbrella).map((t) => t.id)).toEqual(["a", "b"]);
  expect(notes).toEqual([]);
});

test("applyGroupMoves: a split drops only the cards that left, with the integration card role", () => {
  const board = moveBoard();
  moveTo(board, "p1", "B");
  const notes: string[] = [];
  const result = applyGroupMoves(board, ["p1"], "2026-11-26T00:00:00.000Z", (taskId, note) => notes.push(`${taskId}: ${note}`));
  expect(result).toEqual({ moved: [], lostMembers: [{ umbrellaId: "u", title: "Fresh context", taskIds: ["a"] }] });
  expect(board.tasks.find((t) => t.id === "a")!.umbrella).toBeUndefined();
  expect(board.tasks.find((t) => t.id === "b")!.umbrella).toMatchObject({ id: "u" });
  expect(board.umbrellas[0].groupId).toBe("A");
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  expect(board.umbrellaEntries[0]).toMatchObject({ sourceTaskId: "a", status: "active" });
  expect(notes).toEqual(["a: Left umbrella Fresh context (project moved to another group)"]);
});

test("applyGroupMoves only checks umbrellas with a member in a moved project", () => {
  const board = moveBoard();
  // A member already out of its group (bad data) is left alone when its project did not move.
  moveTo(board, "p1", "B");
  expect(applyGroupMoves(board, ["q"], at, () => undefined)).toEqual({ moved: [], lostMembers: [] });
  expect(board.tasks.find((t) => t.id === "a")!.umbrella).toMatchObject({ id: "u" });
});

test("a dangling groupId is repaired to the default group", () => {
  const board = moveBoard();
  board.umbrellas.push(umbrella({ id: "empty", groupId: "gone" }), umbrella({ id: "kept", groupId: "B" }));
  expect(repairUmbrellaGroups(board, "A")).toEqual(["empty"]);
  expect(board.umbrellas.map((u) => u.groupId)).toEqual(["A", "A", "B"]);
  expect(repairUmbrellaGroups(board, "A")).toEqual([]);
});

test("a card that leaves its umbrella drops the integration card role", () => {
  const board = moveBoard();
  const a = board.tasks.find((t) => t.id === "a")!;
  expect(leaveUmbrella(board, a, "2026-11-26T00:00:00.000Z")?.id).toBe("u");
  expect(a.umbrella).toBeUndefined();
  expect(board.umbrellas[0]).toMatchObject({ revision: 2, updatedAt: "2026-11-26T00:00:00.000Z" });
  expect(board.umbrellas[0]).not.toHaveProperty("integrationTaskId");
  // Another member leaving changes nothing on the umbrella.
  expect(leaveUmbrella(board, board.tasks.find((t) => t.id === "b")!, at)?.id).toBe("u");
  expect(board.umbrellas[0].revision).toBe(2);
  expect(leaveUmbrella(board, board.tasks.find((t) => t.id === "c")!, at)).toBeUndefined();
});
