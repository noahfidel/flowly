import { expect, test } from "vitest";
import { allAttentionFromSources, asksFrom, attentionFromSources, attentionItems, openAskCount, openInList, snoozeMenu } from "./attention";
import { attentionDismissalSchema, isKeySnoozed, listSnoozed, sessionSignalKeys, signalList, snoozedKeys, type AttentionDismissal } from "../shared/attention-dismiss";
import { needsCount, needsQueue, updatedQueue } from "./step-through";

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
const question = (id: string, at: string, agentId = "s1") => ({
  id, taskId: "a", actor: "agent" as const, action: "progress_reported", agentId, reportKind: "question" as const, note: "?", at,
});
const board = (extra: object = {}) => ({ projects: [project], tasks: [task("a", "wa"), task("b", "wb")], events: [], ...extra });
/** A record snoozing each list with the given keys (only lists with keys). */
const snooze = (taskId: string, needs: string[], updated: string[] = []): AttentionDismissal => ({
  taskId,
  ...(needs.length ? { needs: { signals: needs, snoozedAt: now } } : {}),
  ...(updated.length ? { updated: { signals: updated, snoozedAt: now } } : {}),
});
const byList = (keys: readonly string[]) => ({ needs: keys.filter((k) => signalList(k) === "needs"), updated: keys.filter((k) => signalList(k) === "updated") });
const all = () => true;
const none: ReadonlySet<string> = new Set();

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

test("a key's list: unread turns in Updates, everything else in Needs you", () => {
  expect(["q:e", "b:e", "p:s:r", "e:s:status", "review:failed:t"].map(signalList)).toEqual(["needs", "needs", "needs", "needs", "needs"]);
  expect(signalList("u:tok")).toBe("updated");
});

test("a list is snoozed while it has current keys and every one is stored in that list", () => {
  const record = snooze("a", ["q:1", "p:s:r"], ["u:1"]);
  expect(listSnoozed(["q:1"], undefined, "needs")).toBe(false);
  expect(listSnoozed(["u:2"], record, "needs")).toBe(false); // no current need-you key
  expect(listSnoozed(["q:1", "u:2"], record, "needs")).toBe(true); // the other list does not count
  expect(listSnoozed(["q:1", "q:2"], record, "needs")).toBe(false);
  expect(listSnoozed(["q:1", "u:1"], record, "updated")).toBe(true);
  expect(listSnoozed(["u:2"], record, "updated")).toBe(false);
  expect(isKeySnoozed("u:1", record)).toBe(true);
  expect(isKeySnoozed("q:1", snooze("a", [], ["u:1"]))).toBe(false);
  expect([...snoozedKeys(record)].sort()).toEqual(["p:s:r", "q:1", "u:1"]);
});

test("a legacy record migrates to both lists with its time", () => {
  const legacy = attentionDismissalSchema.parse({ taskId: "a", signals: ["u:1", "q:1", "p:s:r"], dismissedAt: now });
  expect(legacy).toEqual({ taskId: "a", needs: { signals: ["q:1", "p:s:r"], snoozedAt: now }, updated: { signals: ["u:1"], snoozedAt: now } });
  expect(attentionDismissalSchema.parse({ taskId: "a", signals: ["q:1"], dismissedAt: now })).toEqual({ taskId: "a", needs: { signals: ["q:1"], snoozedAt: now } });
  expect(attentionDismissalSchema.parse({ taskId: "a", signals: ["u:1"], dismissedAt: now })).toEqual({ taskId: "a", updated: { signals: ["u:1"], snoozedAt: now } });
  // A broken legacy record stays invalid rather than turning into an empty one.
  expect(attentionDismissalSchema.safeParse({ taskId: "a", signals: [], dismissedAt: now }).success).toBe(false);
  expect(attentionDismissalSchema.safeParse({ taskId: "a", signals: ["q:1"], dismissedAt: "yesterday" }).success).toBe(false);
});

test("a legacy record hides the same signals as before, in both lists", () => {
  const agents = [agent("s1", "wa", finished())];
  const events = [question("e1", now)];
  const signals = attentionItems(board({ events }), agents, [], false)[0].signals;
  expect(signals.map(signalList).sort()).toEqual(["needs", "updated"]);
  const migrated = [attentionDismissalSchema.parse({ taskId: "a", signals, dismissedAt: now })];
  const b = board({ events, attentionDismissals: migrated });
  const [item] = allAttentionFromSources({ board: b, agents, receipts: [], readUnavailable: false })!;
  expect(item.snoozed).toEqual({ needs: true, updated: true });
  expect(attentionFromSources({ board: b, agents, receipts: [], readUnavailable: false })).toEqual([]);
  expect(asksFrom(b, agents, []).map((a) => a.state)).toEqual(["dismissed", "dismissed"]);
});

test("snoozing Needs you leaves the card's unread turn in Updates", () => {
  // Card a: a question and a finished turn on one session.
  const agents = [agent("s1", "wa", finished())];
  const events = [question("e1", now)];
  const keys = byList(attentionItems(board({ events }), agents, [], false)[0].signals);
  const b = board({ events, attentionDismissals: [snooze("a", keys.needs)] });
  const items = attentionFromSources({ board: b, agents, receipts: [], readUnavailable: false })!;
  expect(items.map((i) => i.task.id)).toEqual(["a"]);
  const [item] = items;
  expect(item.snoozed).toEqual({ needs: true, updated: false });
  expect(openAskCount(items)).toBe(0);
  expect(needsCount(items, none, all)).toBe(0);
  expect(needsQueue(items, none, all)).toEqual([]);
  expect(updatedQueue(null, items, none, all)).toEqual(["a"]);
  expect(openInList(item, "needs")).toBe(false);
  expect(openInList(item, "updated")).toBe(true);
  expect(snoozeMenu(item)).toEqual({ needs: false, updated: true, snoozed: true });
});

test("snoozing Updates leaves the card's need-you signals", () => {
  const agents = [agent("s1", "wa", finished())];
  const events = [question("e1", now)];
  const keys = byList(attentionItems(board({ events }), agents, [], false)[0].signals);
  const b = board({ events, attentionDismissals: [snooze("a", [], keys.updated)] });
  const items = attentionFromSources({ board: b, agents, receipts: [], readUnavailable: false })!;
  const [item] = items;
  expect(item.snoozed).toEqual({ needs: false, updated: true });
  expect(openAskCount(items)).toBe(1);
  expect(needsQueue(items, none, all)).toEqual(["a"]);
  expect(updatedQueue(null, items, none, all)).toEqual([]);
  expect(snoozeMenu(item)).toEqual({ needs: true, updated: false, snoozed: true });
  expect(asksFrom(b, agents, []).map((a) => [a.kind, a.state])).toEqual([["question_report", "open"], ["unread", "dismissed"]]);
});

test("a new key brings back only its own list", () => {
  const agents = [agent("s1", "wa", finished())];
  const events = [question("e1", now)];
  const keys = byList(attentionItems(board({ events }), agents, [], false)[0].signals);
  const both = [snooze("a", keys.needs, keys.updated)];
  const item = (b: object, list = agents) => allAttentionFromSources({ board: board(b), agents: list, receipts: [], readUnavailable: false })![0];
  expect(item({ events, attentionDismissals: both }).snoozed).toEqual({ needs: true, updated: true });
  // A new question: Needs you comes back, Updates stays snoozed.
  const asked = item({ events: [...events, question("e9", later, "s2")], attentionDismissals: both }, [...agents, agent("s2", "wa")]);
  expect(asked.snoozed).toEqual({ needs: false, updated: true });
  expect(openAskCount([asked])).toBe(1);
  expect(updatedQueue(null, [asked], none, all)).toEqual([]);
  // Another finished turn: Updates comes back, Needs you stays snoozed.
  const turned = item({ events, attentionDismissals: both }, [agent("s1", "wa", finished(later))]);
  expect(turned.snoozed).toEqual({ needs: true, updated: false });
  expect(openAskCount([turned])).toBe(0);
  expect(updatedQueue(null, [turned], none, all)).toEqual(["a"]);
});

test("a new turn, question, request or error brings the card back; fewer signals keep it hidden", () => {
  const agents = [agent("s1", "wa", finished())];
  const signals = attentionItems(board(), agents, [], false)[0].signals;
  const k = byList(signals);
  const snoozed = board({ attentionDismissals: [snooze("a", k.needs, k.updated)] });
  const active = (b: ReturnType<typeof board>, list: ReturnType<typeof agent>[], receipts = [] as never[]) =>
    attentionFromSources({ board: b, agents: list, receipts, readUnavailable: false })!.map((i) => i.task.id);
  expect(active(snoozed, agents)).toEqual([]);
  // Another finished turn: new attention timestamp.
  expect(active(snoozed, [agent("s1", "wa", finished(later))])).toEqual(["a"]);
  // A Kanban question.
  expect(active({ ...snoozed, events: [question("e9", later)] as never[] }, agents)).toEqual(["a"]);
  // A pending request on another session.
  expect(active(snoozed, [...agents, agent("s3", "wa", { pendingPermissions: [{ id: "r", kind: "tool" }] })])).toEqual(["a"]);
  // An error.
  expect(active(snoozed, [...agents, agent("s4", "wa", { status: "error" })])).toEqual(["a"]);
  // Read state unavailable drops the unread signal; nothing left, nothing listed.
  expect(attentionFromSources({ board: snoozed, agents, receipts: [], readUnavailable: true })).toEqual([]);
  // Two signals snoozed, one resolved: still hidden.
  const two = [agent("s1", "wa", finished()), agent("s5", "wa", { pendingPermissions: [{ id: "r5", kind: "tool" }] })];
  const k2 = byList(attentionItems(board(), two, [], false)[0].signals);
  const b2 = board({ attentionDismissals: [snooze("a", k2.needs, k2.updated)] });
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

test("the count is the open asks that wait on you: a card's snoozed signals stay out of it when a new one comes", () => {
  const agents = [agent("s1", "wa", { ...finished(), status: "error" } as never)];
  const signals = attentionItems(board({ events: [question("e1", now)] }), agents, [], false)[0].signals;
  expect(openAskCount(attentionFromSources({ board: board({ events: [question("e1", now)] }), agents, receipts: [], readUnavailable: false })!)).toBe(2);
  // One of the two snoozed (a single ask): the card stays, the count drops by one.
  const one = { ...board({ events: [question("e1", now)] }), attentionDismissals: [snooze("a", [signals[0]])] };
  const listed = attentionFromSources({ board: one, agents, receipts: [], readUnavailable: false })!;
  expect(listed.map((i) => i.task.id)).toEqual(["a"]);
  expect(openAskCount(listed)).toBe(1);
  expect(listed[0].snoozed.needs).toBe(false);
  expect(asksFrom(one, agents, [], one.attentionDismissals).map((a) => a.state).sort()).toEqual(["dismissed", "open"]);
});

test("a review waiting for a person counts for Needs you snooze and comes back with a new run", () => {
  const review = (startedAt: string) => ({
    trigger: { eventId: "e", agentId: "s1", from: "development" },
    round: 1, maxRounds: 2, state: "failed", startedAt, finishedAt: startedAt, items: [],
    fingerprint: { taskRevision: 1, workpadRevision: 0, dirty: false }, shared: false,
  });
  const withReview = (startedAt: string, dismissals: AttentionDismissal[] = []) =>
    ({ ...board({ attentionDismissals: dismissals }), tasks: [{ ...task("a", "wa"), status: "in_review", review: review(startedAt) }, task("b", "wb")] }) as never;
  const [item] = attentionItems(withReview(now), [], [], false);
  expect(item.review).toBe("failed");
  const key = item.signals[0];
  expect(signalList(key)).toBe("needs");
  expect(openInList(item, "needs")).toBe(true);
  expect(snoozeMenu(item)).toEqual({ needs: true, updated: false, snoozed: false });
  const [hidden] = attentionItems(withReview(now, [snooze("a", [key])]), [], [], false);
  expect(hidden.snoozed).toEqual({ needs: true, updated: false });
  expect(openInList(hidden, "needs")).toBe(false);
  expect(attentionFromSources({ board: withReview(now, [snooze("a", [key])]), agents: [], receipts: [], readUnavailable: false })).toEqual([]);
  const [back] = attentionItems(withReview(later, [snooze("a", [key])]), [], [], false);
  expect(back.snoozed.needs).toBe(false);
  expect(openInList(back, "needs")).toBe(true);
});
