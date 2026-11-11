import { expect, test } from "vitest";
import { boardSchema } from "../shared/model";
import { readCardBoard } from "../shared/rpc";
import { cardBoard } from "./card-board";

const at = "2026-10-23T00:00:00.000Z";
function fixture() {
  const project = { id: "p", title: "P", description: "project", paseoProjectId: "n", primaryPath: "/fixture", repos: ["/fixture"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null };
  const task = { id: "t", projectId: "p", workspaceId: "w", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "T", description: "keep details", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: at, updatedAt: at, archivedAt: null };
  return boardSchema.parse({ version: 5, revision: 4, projects: [project], tasks: [task, { ...task, id: "related", workspaceId: "w2" }, { ...task, id: "unrelated", workspaceId: "w3", description: "irrelevant".repeat(2000) }],
    links: [{ id: "l", projectId: "p", kind: "related", from: "t", to: "related", createdBy: "human", createdAt: at }],
    events: [{ id: "e", taskId: "t", actor: "human", action: "created", at, note: "keep history" }, { id: "other", taskId: "unrelated", actor: "human", action: "created", at }],
    attentionDismissals: [{ taskId: "t", updated: { signals: ["u:read"], snoozedAt: at } }, { taskId: "unrelated", updated: { signals: ["u:read"], snoozedAt: at } }],
  });
}

test("fresh card view preserves details, history and direct links without unrelated card content or mutations", () => {
  const board = fixture(), original = structuredClone(board);
  const card = readCardBoard.output.parse(cardBoard(board, { taskId: "t", workspaceId: "w" }));
  expect(card.tasks.map(t => t.id)).toEqual(["t", "related"]);
  expect(card.tasks[0]).toEqual(board.tasks[0]);
  expect(card.links).toEqual(board.links);
  expect(card.events).toEqual([board.events[0]]);
  expect(card.attentionDismissals).toEqual([board.attentionDismissals[0]]);
  expect(card.revision).toBe(board.revision);
  expect(board).toEqual(original);
  expect(JSON.stringify(card).length).toBeLessThan(JSON.stringify(board).length / 10);
});

test("card read fails closed on missing card/project or changed workspace; archived cards stay reachable", () => {
  const board = fixture(), input = { taskId: "t", workspaceId: "w" };
  for (const current of [{ ...board, tasks: [] }, { ...board, projects: [] }, { ...board, tasks: board.tasks.map(t => ({ ...t, workspaceId: "moved" })) }])
    expect(() => cardBoard(current, input)).toThrow("linked card is unavailable");
  expect(cardBoard({ ...board, tasks: board.tasks.map(t => ({ ...t, archivedAt: at })) }, input).tasks[0].archivedAt).toBe(at);
});
