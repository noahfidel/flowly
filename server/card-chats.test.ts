import { expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { cardChatIds, cardOfChat, isFlowlyInternal, resolveCardChats, type ChatAgent, type ChatTask } from "./card-chats";

const card: ChatTask = { id: "t", workspaceId: "w", archivedAt: null };
const agent = (id: string, extra: Partial<ChatAgent> = {}): ChatAgent => ({ id, workspaceId: "w", archivedAt: null, labels: {}, ...extra });

test("managed sessions bound to the card count", () => {
  expect(cardChatIds({ task: card, tasks: [card], managed: [{ agentId: "m", taskId: "t" }], agents: [] })).toEqual(["m"]);
});

test("a workspace session Flowly did not start counts (PR review card)", () => {
  const watcher = agent("pr", { labels: { "pr-review-watch": "o/r#1" } });
  expect(cardChatIds({ task: card, tasks: [card], managed: [], agents: [watcher, agent("elsewhere", { workspaceId: "x" })] })).toEqual(["pr"]);
});

test("a workspace shared with another live card adds no workspace sessions", () => {
  const other: ChatTask = { id: "u", workspaceId: "w", archivedAt: null };
  const managed = [{ agentId: "m", taskId: "t" }];
  expect(cardChatIds({ task: card, tasks: [card, other], managed, agents: [agent("m"), agent("loose")] })).toEqual(["m"]);
  // An archived card on the same workspace does not count as sharing it.
  expect(cardChatIds({ task: card, tasks: [card, { ...other, archivedAt: "2026-01-01" }], managed, agents: [agent("loose")] })).toEqual(["m", "loose"]);
});

test("a session bound to another card is left out", () => {
  expect(cardChatIds({ task: card, tasks: [card], managed: [{ agentId: "o", taskId: "u" }], agents: [agent("o"), agent("mine")] })).toEqual(["mine"]);
});

test("Flowly's own helper sessions are left out", () => {
  const helpers = [
    agent("sum", { labels: { flowly: "summarizer", "flowly-task": "t" } }),
    agent("legacy", { labels: { "ultra-kanban": "summarizer" } }),
    agent("title", { labels: { flowly: "summarizer", "flowly-run": "quick-title" } }),
    agent("dispatch", { labels: { "flowly-dispatcher": "1" } }),
    agent("paseo-internal", { internal: true }),
  ];
  expect(helpers.every(isFlowlyInternal)).toBe(true);
  expect(isFlowlyInternal(agent("user"))).toBe(false);
  expect(cardChatIds({ task: card, tasks: [card], managed: [], agents: [...helpers, agent("user")] })).toEqual(["user"]);
});

test("archived workspace sessions are left out", () => {
  expect(cardChatIds({ task: card, tasks: [card], managed: [], agents: [agent("old", { archivedAt: "2026-01-01" })] })).toEqual([]);
});

test("no chats gives an empty list; a managed session also in the workspace counts once", () => {
  expect(cardChatIds({ task: card, tasks: [card], managed: [], agents: [] })).toEqual([]);
  expect(cardChatIds({ task: card, tasks: [card], managed: [{ agentId: "m", taskId: "t" }], agents: [agent("m")] })).toEqual(["m"]);
});

test("cardOfChat finds the one live card of a session Flowly did not start", () => {
  expect(cardOfChat(agent("pr"), [card], [])).toBe("t");
  expect(cardOfChat(agent("pr", { workspaceId: null }), [card], [])).toBeNull();
  expect(cardOfChat(agent("pr", { workspaceId: "x" }), [card], [])).toBeNull();
  expect(cardOfChat(agent("pr"), [{ ...card, archivedAt: "2026-01-01" }], [])).toBeNull();
  expect(cardOfChat(agent("pr"), [card, { id: "u", workspaceId: "w", archivedAt: null }], [])).toBeNull();
  expect(cardOfChat(agent("o"), [card], [{ agentId: "o", taskId: "u" }])).toBeNull();
  expect(cardOfChat(agent("s", { labels: { flowly: "summarizer" } }), [card], [])).toBeNull();
  expect(cardOfChat(agent("old", { archivedAt: "2026-01-01" }), [card], [])).toBeNull();
});

test("resolveCardChats pages every live agent and skips the listing for a shared workspace", async () => {
  const calls: unknown[] = [];
  const pages = [
    { entries: [{ agent: agent("a") }], pageInfo: { nextCursor: "c" } },
    { entries: [{ agent: agent("b") }], pageInfo: { nextCursor: null } },
  ];
  const paseo = { agents: { list: async (o: unknown) => (calls.push(o), pages[calls.length - 1]) } } as unknown as PaseoApi;
  expect(await resolveCardChats(paseo, "t", [card], [])).toEqual(["a", "b"]);
  expect(calls).toEqual([
    { filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor: undefined } },
    { filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor: "c" } },
  ]);
  expect(await resolveCardChats(paseo, "missing", [card], [])).toBeNull();
  expect(await resolveCardChats(paseo, "t", [card, { id: "u", workspaceId: "w", archivedAt: null }], [{ agentId: "m", taskId: "t" }])).toEqual(["m"]);
  expect(calls).toHaveLength(2);
});
