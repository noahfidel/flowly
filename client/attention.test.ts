import { expect, test } from "vitest";
import {
  attentionBadgeText,
  attentionFromSources,
  attentionItems,
  attentionOpenToken,
  attentionScreenParams,
} from "./attention";

const now = "2026-10-14T10:00:00.000Z";
const project = (id: string, archivedAt: string | null = null) => ({
  id, paseoProjectId: id, title: id, description: "", primaryPath: "/p", repos: ["/p"],
  revision: 1, createdAt: now, updatedAt: now, archivedAt,
});
const task = (id: string, workspaceId: string, projectId = "p", archivedAt: string | null = null) => ({
  id, projectId, workspaceId, sourcePath: "/p", repoPaths: ["/p"], title: id, description: "",
  status: "development" as const, priority: "normal" as const, position: 0, revision: 1,
  operationId: id, createdAt: now, updatedAt: now, archivedAt,
});
const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId, status: "idle" as const, archivedAt: null, updatedAt: now, ...extra,
});
const finished = { requiresAttention: true, attentionReason: "finished", attentionTimestamp: now };

test("lists cards across projects needing a human; running alone and archived scopes are excluded", () => {
  const board = {
    projects: [project("p"), project("q"), project("old", now)],
    tasks: [task("a", "wa"), task("b", "wb", "q"), task("c", "wc"), task("d", "wd", "old"), task("e", "we", "p", now)],
    events: [],
  };
  const items = attentionItems(board, [
    agent("s1", "wa", finished),
    agent("s2", "wb", { status: "error", updatedAt: "2026-10-14T09:00:00.000Z" }),
    agent("s3", "wc", { status: "running" }),
    agent("s4", "wd", finished),
    agent("s5", "we", finished),
  ], [], false);
  expect(items.map((i) => i.task.id)).toEqual(["b", "a"]);
  expect(items[0]).toMatchObject({ errors: 1, sessionId: "s2" });
  expect(items[1]).toMatchObject({ unread: 1, sessionId: "s1" });
});

test("several flagged sessions open the card; read receipts and unavailable read state suppress unread", () => {
  const board = { projects: [project("p")], tasks: [task("a", "wa")], events: [] };
  const two = attentionItems(board, [agent("s1", "wa", finished), agent("s2", "wa", finished)], [], false);
  expect(two[0]).toMatchObject({ unread: 2, sessionId: null });
  const token = JSON.stringify(["s1", "finished", now]);
  const read = attentionItems(board, [agent("s1", "wa", finished)], [
    { taskId: "a", workspaceId: "wa", agentId: "s1", token, readAt: now },
  ], false);
  expect(read).toEqual([]);
  expect(attentionItems(board, [agent("s1", "wa", finished)], [], true)).toEqual([]);
  expect(attentionItems(board, [agent("s1", "wa", { pendingPermissions: [{}] })], [], true)[0]).toMatchObject({ permissions: 1 });
});

test("an agent question counts as a question you can answer, not an approval", () => {
  const board = { projects: [project("p")], tasks: [task("a", "wa")], events: [] };
  const ask = { id: "permission-1", kind: "question", input: { questions: [] } };
  expect(attentionItems(board, [agent("s1", "wa", { pendingPermissions: [ask] })], [], false)[0]).toMatchObject({
    permissions: 0,
    questions: 1,
    asks: 1,
  });
  expect(attentionItems(board, [agent("s1", "wa", { pendingPermissions: [{ id: "p", kind: "tool" }] })], [], false)[0]).toMatchObject({
    permissions: 1,
    questions: 0,
    asks: 0,
  });
});

test("board button and sidebar badge share one count; unavailable sources hide the badge", () => {
  const board = { projects: [project("p")], tasks: [task("a", "wa"), task("b", "wb"), task("c", "wc")], events: [] };
  const agents = [
    agent("s1", "wa", finished),
    agent("s2", "wb", { pendingPermissions: [{}] }),
    agent("s3", "wc", { status: "running" }),
  ];
  const sources = { board, agents, receipts: [], readUnavailable: false };
  const items = attentionFromSources(sources);
  expect(items).toEqual(attentionItems(board, agents, [], false));
  expect(attentionBadgeText(items?.length)).toBe("2");
  // Read state unavailable: same rule as the board, approvals/errors only.
  expect(attentionBadgeText(attentionFromSources({ ...sources, readUnavailable: true })?.length)).toBe("1");
  expect(attentionFromSources({ ...sources, board: undefined })).toBeNull();
  expect(attentionFromSources({ ...sources, agents: null })).toBeNull();
  expect(attentionBadgeText(attentionFromSources({ ...sources, agents: [] })?.length)).toBeNull();
  expect(attentionBadgeText(null)).toBeNull();
  expect(attentionBadgeText(99)).toBe("99");
  expect(attentionBadgeText(100)).toBe("99+");
});

test("sidebar badge params open the attention modal once per token without touching session links", () => {
  expect(attentionOpenToken(attentionScreenParams("t1"))).toBe("t1");
  expect(attentionOpenToken(attentionScreenParams("t2"))).not.toBe(attentionOpenToken(attentionScreenParams("t1")));
  expect(attentionOpenToken({ view: "attention" })).toBeNull();
  expect(attentionOpenToken({ view: "other", open: "t1" })).toBeNull();
  expect(attentionOpenToken({ taskId: "a", sessionId: "s", workspaceId: "w", requestId: "r" })).toBeNull();
  expect(attentionOpenToken(undefined)).toBeNull();
});

test("agent questions flag a card even when read; silent unread turns are annotated", () => {
  const at = (s: number) => new Date(Date.parse(now) + s * 1000).toISOString();
  const events = [
    { id: "1", taskId: "a", actor: "system" as const, action: "agent.turn_started", agentId: "s1", at: at(1) },
    { id: "2", taskId: "a", actor: "agent" as const, action: "progress_reported", agentId: "s1", reportKind: "question" as const, note: "?", at: at(2) },
    { id: "3", taskId: "b", actor: "system" as const, action: "agent.turn_started", agentId: "s2", at: at(1) },
    { id: "4", taskId: "b", actor: "system" as const, action: "agent.turn_ended", agentId: "s2", outcome: "completed" as const, at: at(2) },
  ];
  const board = {
    projects: [project("p")],
    tasks: [task("a", "wa"), { ...task("b", "wb"), status: "development" as const }],
    events,
  };
  const items = attentionItems(board, [agent("s1", "wa"), agent("s2", "wb", finished)], [], false);
  expect(items.find((i) => i.task.id === "a")).toMatchObject({ questions: 1, unread: 0, sessionId: "s1" });
  expect(items.find((i) => i.task.id === "b")).toMatchObject({ unread: 1, silent: 1 });
  expect(items[0].task.id).toBe("a");
});
