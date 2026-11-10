import { expect, test } from "vitest";
import { boardSchema, type BoardEvent } from "./model";
import { boardOverviewSchema } from "./overview";
import { boardOverview } from "../server/board-overview";
import { attentionItems, attentionItemsWithFacts } from "./attention";
import { sessionAttentionSummary, sessionAttentionSummaryFromTurns, type AttentionAgent } from "./session-attention";
import { latestTurnEnds } from "./sort";
import { olderFinished, olderFinishedFromDates } from "../client/finished-cards";
import { taskMatchesSearch } from "./tags";

const at = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
function fixture() {
  const project = { id: "p", title: "P", description: "", paseoProjectId: "n", primaryPath: "/fixture", repos: ["/fixture"], revision: 1, createdAt: at(1), updatedAt: at(20), archivedAt: null };
  const task = { id: "t", projectId: "p", workspaceId: "w", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "Title", description: "description-only-keyword", status: "development", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: at(1), updatedAt: at(20), archivedAt: null };
  const event = (id: string, agentId: string, action: string, n: number, extra = {}) => ({ id, agentId, taskId: "t", actor: "agent", action, at: at(n), ...extra });
  return boardSchema.parse({ version: 5, revision: 9, projects: [project], tasks: [task], events: [
    event("start-a", "a", "agent.turn_started", 2), event("question-a", "a", "progress_reported", 3, { reportKind: "question", note: "private question body" }),
    event("start-b", "b", "agent.turn_started", 2), event("end-b", "b", "agent.turn_ended", 4),
    event("start-c", "c", "agent.turn_started", 5), event("workpad-c", "c", "workpad_updated", 6), event("end-c", "c", "agent.turn_ended", 7),
    event("old-end-d", "d", "agent.turn_ended", 10), event("last-start-d", "d", "agent.turn_started", 8),
    event("move", "a", "status_changed", 9, { to: "development" }),
  ], ideas: [{ id: "i", taskId: "t", projectId: "p", agentId: "a", eventId: "question-a", title: "I", detail: "private idea body", rationale: "", context: "", status: "open", createdAt: at(3), updatedAt: at(3) }] });
}

test("overview is an explicit body-free DTO and preserves description search and storage bytes", () => {
  const board = fixture(), before = JSON.stringify(board);
  const view = boardOverviewSchema.parse(boardOverview(board));
  expect(view.tasks[0].description).toBe("description-only-keyword");
  expect(taskMatchesSearch(view.tasks[0], "description-only-keyword")).toBe(true);
  for (const field of ["events", "workpads", "ideas", "artifacts", "plans"]) expect(view).not.toHaveProperty(field);
  expect(JSON.stringify(view)).not.toContain("private question body");
  expect(JSON.stringify(view)).not.toContain("private idea body");
  expect(boardSchema.safeParse(view).success).toBe(false);
  expect(boardOverviewSchema.safeParse({ ...view, events: [] }).success).toBe(false);
  expect(JSON.stringify(board)).toBe(before);
});

test("named session facts preserve array-last turn, max end, questions, silent and workpad report boundaries", () => {
  const view = boardOverview(fixture()), facts = view.cards[0];
  expect(facts.questions).toBe(0); // a's later agent status report answers its question
  expect(facts.sessions.find(s => s.agentId === "b")).toMatchObject({ silent: true, hadTurnEnd: true });
  expect(facts.sessions.find(s => s.agentId === "c")).toMatchObject({ silent: false });
  expect(facts.sessions.find(s => s.agentId === "d")?.latestTurn).toEqual({ action: "agent.turn_started", at: at(8) });
  expect(facts.turnEndedAt).toBe(at(10));
  expect(facts.finishedAt).toBe(at(20)); // work lane uses updatedAt, not old transition
});

test("event facts and live Attention combine equivalently across errors, permissions, receipts, subagents and archives", () => {
  const board = fixture();
  board.events = board.events.filter(e => e.id !== "move"); // a still has an open question
  const view = boardOverview(board), facts = new Map(view.cards[0].sessions.map(s => [s.agentId, s]));
  const base = { workspaceId: "w", status: "idle" as const, requiresAttention: true, attentionReason: "finished" as const, attentionTimestamp: at(10) };
  const agents: AttentionAgent[] = [
    { ...base, id: "a" }, { ...base, id: "b" }, { ...base, id: "c" },
    { ...base, id: "d", lastUserMessageAt: at(11) },
    { id: "permission", workspaceId: "w", status: "running", pendingPermissions: [{ id: "r", kind: "tool" }] },
    { id: "ask", workspaceId: "w", status: "idle", pendingPermissions: [{ id: "q", kind: "question", input: { questions: [] } }] },
    { id: "error", workspaceId: "w", status: "error" },
    { ...base, id: "sub", labels: { parentAgentId: "parent" } },
    { ...base, id: "old", archivedAt: at(12) }, { ...base, id: "wrong", workspaceId: "other" },
  ];
  const receipts = [{ taskId: "t", workspaceId: "w", agentId: "c", token: JSON.stringify(["c", "finished", at(10)]), readAt: at(12) }];
  for (const unavailable of [false, true]) {
    const projected = attentionItemsWithFacts(view, agents, receipts, unavailable, (_t, id) => facts.get(id));
    expect(projected).toEqual(attentionItems(board, agents, receipts, unavailable));
    expect(projected[0].permissions).toBe(1);
    expect(projected[0].errors).toBe(1);
    expect(projected[0].asks).toBe(1);
    expect(projected[0].questions).toBe(2);
  }
  expect(sessionAttentionSummaryFromTurns(agents, board.tasks[0], receipts, facts)).toEqual(sessionAttentionSummary(agents, board.tasks[0], receipts, board.events));
  const readFailure = attentionItemsWithFacts(view, agents, receipts, true, (_t, id) => facts.get(id))[0];
  expect(readFailure.unread).toBe(0);
  expect(readFailure.questions).toBe(2);
});

test("new live permission/error and manual unread are immediate without another overview response", () => {
  const view = boardOverview(fixture());
  const compute = (agent: AttentionAgent, receipts: Parameters<typeof attentionItemsWithFacts>[2] = []) => attentionItemsWithFacts(view, [agent], receipts, false, () => undefined);
  const agent = { id: "new", workspaceId: "w", status: "idle" as const };
  expect(compute(agent)).toEqual([]);
  expect(compute({ ...agent, status: "error" })[0].errors).toBe(1);
  expect(compute({ ...agent, pendingPermissions: [{}] })[0].permissions).toBe(1);
  expect(compute(agent, [{ taskId: "t", workspaceId: "w", agentId: "new", token: "manual-unread", readAt: at(12) }])[0].unread).toBe(1);
});

test("finished fold dates, wrap restore and event eviction use the original rules", () => {
  const board = fixture();
  board.tasks[0].status = "done";
  board.events.push({ id: "done", taskId: "t", actor: "human", action: "status_changed", to: "done", at: at(11) }, { id: "wrap", taskId: "t", actor: "human", action: "wrapped_up", at: at(12) });
  let view = boardOverview(board);
  expect(view.cards[0]).toMatchObject({ finishedAt: at(11), wrapped: true });
  const entered = new Map(view.cards.map(c => [c.taskId, c.finishedAt]));
  expect(olderFinishedFromDates(view.tasks, entered, 3, Date.parse(at(20)))).toEqual(olderFinished(board.tasks, board.events, 3, Date.parse(at(20))));
  expect(new Map(view.cards.map(c => [c.taskId, c.turnEndedAt])).get("t")).toBe(latestTurnEnds(board.events).byTask.get("t"));
  board.events = [{ id: "restore", taskId: "t", actor: "human", action: "workspace_restored", at: at(14) }];
  view = boardOverview(board);
  expect(view.cards[0]).toMatchObject({ wrapped: false, sessions: [], finishedAt: at(20) });
  expect(view.cards[0].turnEndedAt).toBeUndefined();
});

test("explicit empty next moves and later start do not resurrect suggestions", () => {
  const board = fixture();
  const suggest = { id: "moves", taskId: "t", actor: "agent", agentId: "a", action: "next_moves_suggested", at: at(15), moves: [{ label: "Continue", prompt: "Continue" }] } as BoardEvent;
  board.events.push(suggest);
  expect(boardOverview(board).cards[0].hasNextMoves).toBe(true);
  board.events.push({ ...suggest, id: "empty", moves: [] });
  expect(boardOverview(board).cards[0].hasNextMoves).toBe(false);
  board.events.push(suggest, { ...suggest, id: "start", action: "agent.turn_started", moves: undefined });
  expect(boardOverview(board).cards[0].hasNextMoves).toBe(false);
});

test("workpad summary is Acceptance n/m without the criteria's text (GUARDRAILS-SPEC §7.1)", () => {
  const board = fixture();
  board.workpads = [{ taskId: "t", projectId: "p", revision: 1, updatedAt: at(6), updatedBy: "agent",
    acceptance: [{ id: "a", text: "private criterion", done: true, by: "agent", at: at(5) }, { id: "b", text: "other", done: false, by: "agent", at: at(5) }] }];
  const view = boardOverview(board);
  expect(view.cards[0].workpad).toEqual({ kind: "acceptance", done: 1, total: 2 });
  expect(JSON.stringify(view.cards)).not.toContain("private criterion");
});
