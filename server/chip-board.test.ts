import { expect, test } from "vitest";
import { boardSchema, type BoardEvent } from "../shared/model";
import { chipMoves, nextMovesAction } from "../shared/next-moves";
import { readChipBoardChanged } from "../shared/rpc";
import { applyBoardPatch } from "../client/board-read";
import { chipBoard } from "./chip-board";
import { BoardDeltas } from "./board-delta";

const at = "2026-10-23T00:00:00.000Z";
const event = (id: string, agentId: string, action: string, moves?: BoardEvent["moves"]): BoardEvent =>
  ({ id, taskId: "t", actor: "agent", agentId, action, at, note: "unneeded history ".repeat(100), ...(moves ? { moves } : {}) });
const suggestion = (id: string, agentId = "a") => event(id, agentId, nextMovesAction, [{ label: "Inspect", prompt: "Inspect it" }, { label: "Done", moveTo: "done" }]);
function board(events: BoardEvent[] = []) {
  return boardSchema.parse({
    version: 5, revision: 1,
    projects: [{ id: "p", title: "P", description: "long project description", paseoProjectId: "n", primaryPath: "/fixture", repos: ["/fixture"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null }],
    tasks: [{ id: "t", projectId: "p", workspaceId: "w", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "T", description: "long task description", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: at, updatedAt: at, archivedAt: null }],
    events, ideas: [], links: [], artifacts: [], workpads: [], plans: [], attentionDismissals: [],
    hiddenPrs: [{ taskId: "t", url: "https://github.com/o/r/pull/1", hiddenAt: at }],
  });
}

test("the chip projection is schema-valid, read-only, and excludes history/descriptions", () => {
  const source = board([suggestion("old"), event("noise", "a", "status_changed"), suggestion("latest"), event("started-b", "b", "agent.turn_started")]);
  const original = structuredClone(source);
  const view = chipBoard(source);
  expect(readChipBoardChanged.output.parse({ etag: "e", value: view }).value).toEqual(view);
  expect(view.events.map(e => e.id)).toEqual(["latest", "started-b"]);
  expect(view.events.every(e => !e.note)).toBe(true);
  expect(view.hiddenPrs).toEqual([]);
  expect(view.tasks[0]).toEqual({ ...source.tasks[0], description: "" });
  expect(view.projects[0]).toEqual({ ...source.projects[0], description: "" });
  expect(source).toEqual(original);
  expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(source).length / 2);
});

test("chipMoves is identical after projection: starts, none, several sessions, permissions, hidden and newer user text", () => {
  for (const events of [
    [suggestion("a"), suggestion("b", "b")],
    [suggestion("a"), event("new-turn", "a", "agent.turn_started")],
    [suggestion("a"), event("none", "a", nextMovesAction, [])],
    [event("new-turn", "a", "agent.turn_started"), suggestion("a")],
  ]) {
    const source = board(events), view = chipBoard(source);
    for (const id of ["a", "b", "absent"]) for (const cardFinished of [true, false]) for (const overrides of [
      {}, { status: "running" }, { pendingPermissions: [{}] }, { lastUserMessageAt: "2026-10-23T01:00:00Z" }, { attentionReason: "permission" },
    ]) for (const hide of [false, true]) {
      const options = { agent: { id, status: "idle", ...overrides }, cardFinished, hidden: () => hide };
      expect(chipMoves({ ...options, events: view.events })).toEqual(chipMoves({ ...options, events: source.events }));
    }
  }
});

test("the projected reader handles unchanged, latest-boundary removal and title updates by etag patch", () => {
  const deltas = new BoardDeltas();
  const source = board([suggestion("old")]);
  const first = chipBoard(source);
  const full = deltas.read(first, {});
  expect(deltas.read(first, { etag: full.etag })).toEqual({ etag: full.etag });
  const next = chipBoard({ ...source, revision: 2, tasks: [{ ...source.tasks[0], title: "New" }], events: [...source.events, event("start", "a", "agent.turn_started")] });
  const answer = readChipBoardChanged.output.parse(deltas.read(next, { etag: full.etag }));
  expect(answer.patch?.removeEvents).toEqual(["old"]);
  expect(applyBoardPatch(first, answer.patch!)).toEqual(next);
  expect(chipMoves({ events: next.events, agent: { id: "a", status: "idle" }, cardFinished: false, hidden: () => false })).toBeNull();
});
