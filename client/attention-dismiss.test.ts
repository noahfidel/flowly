import { expect, test } from "vitest";
import { allAttentionFromSources, asksFrom, attentionFromSources, attentionItems, openAskCount } from "./attention";
import { isDismissed, sessionSignalKeys } from "../shared/attention-dismiss";

const now = "2026-10-19T10:00:00.000Z";
const later = "2026-10-19T11:00:00.000Z";
const project = { id: "p", paseoProjectId: "p", title: "p", description: "", primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
const task = (id: string, workspaceId: string) => ({
  id, projectId: "p", workspaceId, sourcePath: "/p", repoPaths: ["/p"], title: id, description: "",
  status: "development" as const, priority: "normal" as const, position: 0, revision: 1,
  operationId: id, createdAt: now, updatedAt: now, archivedAt: null,
});
const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId, status: "idle" as const, archivedAt: null, updatedAt: now, ...extra,
});
const finished = (at = now) => ({ requiresAttention: true, attentionReason: "finished", attentionTimestamp: at });
const question = (id: string, at: string) => ({
  id, taskId: "a", actor: "agent" as const, action: "progress_reported", agentId: "s1", reportKind: "question" as const, note: "?", at,
});
const board = (extra: object = {}) => ({ projects: [project], tasks: [task("a", "wa"), task("b", "wb")], events: [], ...extra });

test("signal keys name the concrete thing waited on, so a new one gets a new key", () => {
  const base = { agent: { id: "s" }, questionEventId: null, requestIds: [], permission: false, error: false, unread: false, token: null, manualUnread: false };
  expect(sessionSignalKeys(base)).toEqual([]);
  expect(sessionSignalKeys({ ...base, questionEventId: "e1" })).toEqual(["q:e1"]);
  expect(sessionSignalKeys({ ...base, permission: true, requestIds: ["r1", "r2"] })).toEqual(["p:s:r1", "p:s:r2"]);
  expect(sessionSignalKeys({ ...base, permission: true, agent: { id: "s", attentionTimestamp: now } })).toEqual([`p:s:${now}`]);
  expect(sessionSignalKeys({ ...base, error: true })).toEqual(["e:s:status"]);
  expect(sessionSignalKeys({ ...base, unread: true, token: "tok" })).toEqual(["u:tok"]);
  expect(sessionSignalKeys({ ...base, unread: true, token: "tok", manualUnread: true })).toEqual(["u:s:manual"]);
});

test("dismissed while every current signal was already there", () => {
  expect(isDismissed(["a"], undefined)).toBe(false);
  expect(isDismissed([], { signals: ["a"] })).toBe(false);
  expect(isDismissed(["a"], { signals: ["a", "b"] })).toBe(true);
  expect(isDismissed(["a", "c"], { signals: ["a", "b"] })).toBe(false);
});

test("a dismissed card leaves the count and the list, and is listed as dismissed", () => {
  const agents = [agent("s1", "wa", finished()), agent("s2", "wb", { pendingPermissions: [{ id: "r1", kind: "tool" }] })];
  const [a] = attentionItems(board(), agents, [], false).filter((i) => i.task.id === "a");
  const dismissals = [{ taskId: "a", signals: a.signals, dismissedAt: now }];
  const sources = { board: board({ attentionDismissals: dismissals }), agents, receipts: [], readUnavailable: false };
  expect(attentionFromSources(sources)?.map((i) => i.task.id)).toEqual(["b"]);
  const all = allAttentionFromSources(sources)!;
  expect(all.find((i) => i.task.id === "a")).toMatchObject({ dismissed: true, unread: 1 });
  expect(all.find((i) => i.task.id === "b")).toMatchObject({ dismissed: false });
});

test("a new turn, question, request or error brings the card back; fewer signals keep it hidden", () => {
  const agents = [agent("s1", "wa", finished())];
  const signals = attentionItems(board(), agents, [], false)[0].signals;
  const dismissed = board({ attentionDismissals: [{ taskId: "a", signals, dismissedAt: now }] });
  const active = (b: ReturnType<typeof board>, list: ReturnType<typeof agent>[], receipts = [] as never[]) =>
    attentionFromSources({ board: b, agents: list, receipts, readUnavailable: false })!.map((i) => i.task.id);
  expect(active(dismissed, agents)).toEqual([]);
  // Another finished turn: new attention timestamp.
  expect(active(dismissed, [agent("s1", "wa", finished(later))])).toEqual(["a"]);
  // A Kanban question.
  expect(active({ ...dismissed, events: [question("e9", later)] as never[] }, agents)).toEqual(["a"]);
  // A pending request on another session.
  expect(active(dismissed, [...agents, agent("s3", "wa", { pendingPermissions: [{ id: "r", kind: "tool" }] })])).toEqual(["a"]);
  // An error.
  expect(active(dismissed, [...agents, agent("s4", "wa", { status: "error" })])).toEqual(["a"]);
  // Read state unavailable drops the unread signal; nothing left, nothing listed.
  expect(attentionFromSources({ board: dismissed, agents, receipts: [], readUnavailable: true })).toEqual([]);
  // Two signals dismissed, one resolved: still hidden.
  const two = [agent("s1", "wa", finished()), agent("s5", "wa", { pendingPermissions: [{ id: "r5", kind: "tool" }] })];
  const both = attentionItems(board(), two, [], false)[0].signals;
  const b2 = board({ attentionDismissals: [{ taskId: "a", signals: both, dismissedAt: now }] });
  expect(active(b2, two)).toEqual([]);
  expect(active(b2, [two[1]])).toEqual([]);
});

test("an open blocker report is a signal until the session's next turn starts (plan Q5)", () => {
  const blocker = { ...question("b1", now), reportKind: "blocker" as const };
  const items = attentionItems(board({ events: [blocker] }), [agent("s1", "wa")], [], false);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ blockers: 1, questions: 0, signals: ["b:b1"] });
  const started = { id: "t1", taskId: "a", actor: "system" as const, action: "agent.turn_started", agentId: "s1", at: later };
  expect(attentionItems(board({ events: [blocker, started] }), [agent("s1", "wa")], [], false)).toEqual([]);
});

test("the count is the open asks: a card's dismissed signals stay out of it when a new one comes", () => {
  const agents = [agent("s1", "wa", finished())];
  const signals = attentionItems(board({ events: [question("e1", now)] }), agents, [], false)[0].signals;
  expect(openAskCount(attentionFromSources({ board: board({ events: [question("e1", now)] }), agents, receipts: [], readUnavailable: false })!)).toBe(2);
  // One of the two dismissed (single-signal dismissal): the card stays, the count drops by one.
  const dismissals = [{ taskId: "a", signals: [signals[0]], dismissedAt: now }];
  const one = { ...board({ events: [question("e1", now)] }), attentionDismissals: dismissals };
  const listed = attentionFromSources({ board: one, agents, receipts: [], readUnavailable: false })!;
  expect(listed.map((i) => i.task.id)).toEqual(["a"]);
  expect(openAskCount(listed)).toBe(1);
  expect(asksFrom(one, agents, [], one.attentionDismissals).map((a) => a.state).sort()).toEqual(["dismissed", "open"]);
});
