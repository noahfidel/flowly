import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Board } from "../shared/model";
import { asksFrom, openAskCount, attentionFromSources } from "../shared/attention";
import { askAnswerInputSchema } from "../shared/dispatcher";
import { AttentionAgents, readAttentionCount } from "./attention-count";
import { DispatcherAsks } from "./dispatcher-asks";
import { DispatcherItems } from "./dispatcher-items";

const at = "2026-11-08T10:00:00.000Z";
const later = "2026-11-08T10:05:00.000Z";
const project = { id: "p", title: "P", archivedAt: null };
const task = (id: string) => ({ id, projectId: "p", workspaceId: `w-${id}`, title: `Card ${id}`, status: "development", archivedAt: null });
const report = (id: string, taskId: string, agentId: string, kind: "question" | "blocker", note: string, when = at) => ({
  id, taskId, agentId, actor: "agent", action: "progress_reported", reportKind: kind, note, at: when,
});
const askUser = {
  id: "r1",
  kind: "question",
  input: { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false }] },
};
const tool = { id: "r2", kind: "tool", name: "Bash", title: "git push origin feat", actions: [{ id: "deny", label: "Deny", behavior: "deny" }, { id: "allow-once", label: "Allow once", behavior: "allow" }] };
type Agent = { id: string; workspaceId: string; status: "idle" | "running" | "closed"; archivedAt: string | null; pendingPermissions?: unknown[]; [k: string]: unknown };
const agent = (id: string, workspaceId: string, extra: Partial<Agent> = {}): Agent => ({ id, workspaceId, status: "idle", archivedAt: null, updatedAt: at, ...extra });

let dir = "";
let fixtures = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowly-asks-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(boardValue: Board, agentList: Agent[], cache = new AttentionAgents({ ttlMs: 0 })) {
  let board = boardValue;
  let agents = agentList;
  const respond = vi.fn(async (_agentId: string, _options: unknown) => undefined);
  const send = vi.fn(async (_agentId: string, _text: string, _options?: unknown) => undefined);
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((a) => ({ agent: a })), pageInfo: {} })),
      ref: (id: string) => ({
        refresh: async () => {
          const found = agents.find((a) => a.id === id);
          return found ? { agent: found } : null;
        },
        respondToPermission: (options: unknown) => respond(id, options),
        send: (text: string, options?: unknown) => send(id, text, options),
      }),
    },
  } as unknown as PaseoApi;
  const dismissals: { taskId: string; signals: string[]; current: string[] }[] = [];
  const store = {
    read: vi.fn(async () => board),
    dismissAttentionSignal: vi.fn(async (input: { taskId: string; signal: string; current: readonly string[] }) => {
      const record = board.attentionDismissals.find((d) => d.taskId === input.taskId);
      const signals = [...new Set([...(record?.signals ?? []), input.signal])];
      dismissals.push({ taskId: input.taskId, signals, current: [...input.current] });
      board = { ...board, attentionDismissals: [...board.attentionDismissals.filter((d) => d.taskId !== input.taskId), { taskId: input.taskId, signals, dismissedAt: at }] };
      return board.attentionDismissals.at(-1)!;
    }),
  };
  const reads = { read: vi.fn(async () => ({ version: 1 as const, receipts: [] })) };
  // Each fixture its own chat file, even several in one test.
  const items = new DispatcherItems(join(dir, `f${++fixtures}`), { now: () => Date.parse(later) });
  const asks = new DispatcherAsks({ store, reads, items, agents: cache, now: () => new Date(later) });
  return {
    paseo, respond, send, store, reads, items, asks, dismissals,
    get board() {
      return board;
    },
    setBoard(next: Board) {
      board = next;
    },
    setAgents(next: Agent[]) {
      agents = next;
    },
  };
}

const baseBoard = (extra: Partial<Board> = {}) =>
  ({
    projects: [project],
    tasks: [task("a"), task("b"), task("c")],
    events: [report("e1", "a", "s1", "question", "Postgres or SQLite?"), report("e2", "c", "s3", "blocker", "CI is red on main")],
    attentionDismissals: [],
    ...extra,
  }) as unknown as Board;
const baseAgents = () => [
  agent("s1", "w-a", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: at }),
  agent("s2", "w-b", { pendingPermissions: [askUser, tool], requiresAttention: true, attentionReason: "permission", attentionTimestamp: at }),
  agent("s3", "w-c"),
];

const answer = (f: ReturnType<typeof fixture>, signal: string, value: { optionIds?: string[]; text?: string; texts?: string[]; allow?: boolean }) =>
  f.asks.answer({ signal, answer: value }, f.paseo);
const openInChat = async (f: ReturnType<typeof fixture>) =>
  (await f.asks.chatItems(await f.items.list(), f.paseo)).filter((i) => i.kind === "ask" && i.state === "open").length;

test("bell and chat read the same asks", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const asks = asksFrom(f.board, baseAgents(), [], f.board.attentionDismissals);
  // A question report, an unread turn, an AskUserQuestion, a tool permission, a blocker report (plan Q5).
  expect(asks.map((a) => [a.signal, a.kind]).sort()).toEqual(
    [
      ["b:e2", "blocker_report"],
      ["p:s2:r1", "ask_user"],
      ["p:s2:r2", "permission"],
      ["q:e1", "question_report"],
      [`u:${JSON.stringify(["s1", "finished", at])}`, "unread"],
    ].sort(),
  );
  const open = asks.filter((a) => a.state === "open").length;
  const bell = await readAttentionCount(f.store, f.reads, f.paseo);
  const chat = (await f.asks.chatItems([], f.paseo)).filter((i) => i.kind === "ask" && i.state === "open");
  expect(bell.count).toBe(open);
  expect(chat).toHaveLength(open);
  expect(openAskCount(attentionFromSources({ board: f.board, agents: baseAgents(), receipts: [], readUnavailable: false })!)).toBe(open);
  // The chat row carries what its buttons need.
  const ask = (await f.asks.chatItems([], f.paseo)).find((i) => i.kind === "ask" && i.signal === "p:s2:r1");
  expect(ask).toMatchObject({ askKind: "ask_user", agentId: "s2", detail: "Which database?", options: [{ id: "q0o0", label: "Postgres" }, { id: "q0o1", label: "SQLite" }] });
});

test("answering an AskUserQuestion responds through the permission API", async () => {
  const f = fixture(baseBoard(), baseAgents());
  expect(await answer(f, "p:s2:r1", { optionIds: ["q0o1"] })).toEqual({ delivered: true, state: "answered" });
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(f.respond).toHaveBeenCalledWith("s2", {
    requestId: "r1",
    response: { behavior: "allow", updatedInput: { ...askUser.input, answers: { DB: "SQLite" } } },
  });
  expect(f.send).not.toHaveBeenCalled();
  const stored = await f.items.list();
  expect(stored.find((i) => i.kind === "ask")).toMatchObject({ signal: "p:s2:r1", state: "answered", taskId: "b" });
  expect(stored.find((i) => i.kind === "answer")).toMatchObject({ signal: "p:s2:r1", taskId: "b", text: "SQLite", delivered: true });
});

test("a permission is answered only with the user's explicit choice, never auto-allowed", async () => {
  const f = fixture(baseBoard(), baseAgents());
  // No choice: refused, nothing sent.
  await expect(answer(f, "p:s2:r2", {})).rejects.toThrow();
  // A bare allow cannot pick one of the provider's actions.
  await expect(answer(f, "p:s2:r2", { allow: true })).rejects.toThrow();
  // A client claiming allow for the deny action is refused: the behavior comes from the request.
  await expect(answer(f, "p:s2:r2", { optionIds: ["a0"], allow: true })).rejects.toThrow();
  expect(f.respond).not.toHaveBeenCalled();
  expect(await answer(f, "p:s2:r2", { optionIds: ["a1"] })).toEqual({ delivered: true, state: "answered" });
  expect(f.respond).toHaveBeenCalledWith("s2", { requestId: "r2", response: { behavior: "allow", selectedActionId: "allow-once" } });
  expect((await f.items.list()).find((i) => i.kind === "answer")).toMatchObject({ choice: "allow", text: "Allow once", delivered: true });
});

test("answering a question report sends exactly the user's text", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const text = "  Postgres.\n\nKeep the migration small.  ";
  expect(await answer(f, "q:e1", { text })).toEqual({ delivered: true, state: "answered" });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0]).toBe("s1");
  expect(f.send.mock.calls[0][1]).toBe(text);
  expect(f.send.mock.calls[0][2]).toEqual({ activeTurnBehavior: "steer" });
  expect(f.respond).not.toHaveBeenCalled();
  // A blocker report answers the same way.
  expect(await answer(f, "b:e2", { text: "Rebased; try again." })).toEqual({ delivered: true, state: "answered" });
  expect(f.send).toHaveBeenLastCalledWith("s3", "Rebased; try again.", { activeTurnBehavior: "steer" });
  // Blank text is refused.
  const g = fixture(baseBoard(), baseAgents());
  await expect(answer(g, "q:e1", { text: "   " })).rejects.toThrow();
  expect(g.send).not.toHaveBeenCalled();
});

test("an ask already resolved in the session is not answered twice", async () => {
  const f = fixture(baseBoard(), baseAgents());
  // Seen by the chat, then answered in the session pane: the request is no longer pending.
  await f.asks.chatItems([], f.paseo);
  f.setAgents([baseAgents()[0], agent("s2", "w-b", { pendingPermissions: [tool] }), baseAgents()[2]]);
  expect(await answer(f, "p:s2:r1", { optionIds: ["q0o0"] })).toEqual({ delivered: false, state: "answered" });
  expect(f.respond).not.toHaveBeenCalled();
  expect((await f.items.list()).find((i) => i.kind === "ask")).toMatchObject({ signal: "p:s2:r1", state: "answered", elsewhere: true });
  // Answered from the chat, then replayed: no second call, even while the request still looks pending.
  const g = fixture(baseBoard(), baseAgents());
  await answer(g, "p:s2:r2", { optionIds: ["a1"] });
  expect(await answer(g, "p:s2:r2", { optionIds: ["a1"] })).toEqual({ delivered: false, state: "answered" });
  await answer(g, "q:e1", { text: "Postgres" });
  expect(await answer(g, "q:e1", { text: "Postgres" })).toEqual({ delivered: false, state: "answered" });
  expect(g.respond).toHaveBeenCalledTimes(1);
  expect(g.send).toHaveBeenCalledTimes(1);
  // Two answers at once: one call.
  const h = fixture(baseBoard(), baseAgents());
  const both = await Promise.all([answer(h, "q:e1", { text: "a" }), answer(h, "q:e1", { text: "b" })]);
  expect(both.map((r) => r.delivered).sort()).toEqual([false, true]);
  expect(h.send).toHaveBeenCalledTimes(1);
});

test("a request of a session outside the card's workspace is never answered", async () => {
  const f = fixture(baseBoard(), baseAgents());
  await f.asks.chatItems([], f.paseo);
  // Listed in the card's workspace, but the fresh read shows it moved elsewhere.
  const moved = agent("s2", "w-other", { pendingPermissions: [askUser, tool] });
  const listed = baseAgents();
  const paseo = {
    agents: {
      list: async () => ({ entries: listed.map((a) => ({ agent: a })), pageInfo: {} }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: id === "s2" ? moved : listed.find((a) => a.id === id) }),
        respondToPermission: (o: unknown) => f.respond(id, o),
        send: (t: string, o?: unknown) => f.send(id, t, o),
      }),
    },
  } as unknown as PaseoApi;
  await expect(f.asks.answer({ signal: "p:s2:r2", answer: { optionIds: ["a1"] } }, paseo)).rejects.toThrow();
  expect(f.respond).not.toHaveBeenCalled();
  expect((await f.items.list()).filter((i) => i.kind === "answer")).toEqual([]);
});

test("an archived session shows session ended and no tick", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const live = baseAgents();
  // Listed while it still waited; the fresh read finds it archived.
  const paseo = {
    agents: {
      list: async () => ({ entries: live.map((a) => ({ agent: a })), pageInfo: {} }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: id === "s1" ? { ...live[0], archivedAt: later } : live.find((a) => a.id === id) }),
        respondToPermission: (o: unknown) => f.respond(id, o),
        send: (t: string, o?: unknown) => f.send(id, t, o),
      }),
    },
  } as unknown as PaseoApi;
  expect(await f.asks.answer({ signal: "q:e1", answer: { text: "Postgres" } }, paseo)).toEqual({ delivered: false, state: "session_ended" });
  expect(f.send).not.toHaveBeenCalled();
  const stored = await f.items.list();
  expect(stored.find((i) => i.kind === "ask")).toMatchObject({ signal: "q:e1", state: "session_ended" });
  expect(stored.some((i) => i.kind === "answer")).toBe(false);
  // The stored state wins over the live ask in the chat, and a retry stays ended (the list now shows it archived).
  f.setAgents([{ ...live[0], archivedAt: later }, ...live.slice(1)]);
  const items = await f.asks.chatItems(stored, f.paseo);
  expect(items.filter((i) => i.kind === "ask" && i.signal === "q:e1").map((i) => i.kind === "ask" && i.state)).toEqual(["session_ended"]);
  expect(await answer(f, "q:e1", { text: "Postgres" })).toEqual({ delivered: false, state: "session_ended" });
  expect(f.send).not.toHaveBeenCalled();
  // An archived session ends the ask too, and a failed call records nothing.
  const g = fixture(baseBoard(), baseAgents());
  g.send.mockRejectedValueOnce(new Error("socket closed"));
  await expect(answer(g, "q:e1", { text: "Postgres" })).rejects.toThrow("socket closed");
  expect(await g.items.list()).toEqual([]);
});

test("a deleted card's asks disappear", async () => {
  const f = fixture(baseBoard(), baseAgents());
  await answer(f, "p:s2:r2", { optionIds: ["a1"] });
  await f.asks.chatItems([], f.paseo);
  f.setBoard(baseBoard({ tasks: [task("a"), task("c")] as never, events: [report("e1", "a", "s1", "question", "?"), report("e2", "c", "s3", "blocker", "x")] as never }));
  const stored = await f.items.list();
  expect(stored.some((i) => i.kind !== "note" && i.taskId === "b")).toBe(true);
  const items = await f.asks.chatItems(stored, f.paseo);
  expect(items.filter((i) => (i.kind === "ask" || i.kind === "answer") && i.taskId === "b")).toEqual([]);
  // Its live asks went with it, and answering one fails instead of reaching the session.
  await expect(answer(f, "p:s2:r1", { optionIds: ["q0o0"] })).rejects.toThrow("The card was deleted.");
  expect(f.respond).toHaveBeenCalledTimes(1);
});

test("dismissing one ask in the chat clears it from the bell", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const before = (await readAttentionCount(f.store, f.reads, f.paseo)).count!;
  expect(await f.asks.dismiss({ signal: "p:s2:r2" }, f.paseo)).toEqual({ taskId: "b" });
  expect(f.dismissals.at(-1)).toMatchObject({ taskId: "b", current: ["p:s2:r1", "p:s2:r2"] });
  expect((await readAttentionCount(f.store, f.reads, f.paseo)).count).toBe(before - 1);
  const items = await f.asks.chatItems([], f.paseo);
  expect(items.find((i) => i.kind === "ask" && i.signal === "p:s2:r2")).toMatchObject({ state: "dismissed" });
  expect(items.find((i) => i.kind === "ask" && i.signal === "p:s2:r1")).toMatchObject({ state: "open" });
  // The card stays in the bell for its other ask; dismissing that too hides the card.
  expect(attentionFromSources({ board: f.board, agents: baseAgents(), receipts: [], readUnavailable: false })!.map((i) => i.task.id)).toContain("b");
  await f.asks.dismiss({ signal: "p:s2:r1" }, f.paseo);
  expect(attentionFromSources({ board: f.board, agents: baseAgents(), receipts: [], readUnavailable: false })!.map((i) => i.task.id)).not.toContain("b");
  await expect(f.asks.dismiss({ signal: "p:nobody:x" }, f.paseo)).rejects.toThrow();
});

test("asks.answer input is validated", () => {
  expect(() => askAnswerInputSchema.parse({ signal: "", answer: {} })).toThrow();
  expect(() => askAnswerInputSchema.parse({ signal: "q:e1", answer: { text: 1 } })).toThrow();
  expect(() => askAnswerInputSchema.parse({ signal: "q:e1", answer: {}, extra: true })).toThrow();
  expect(() => askAnswerInputSchema.parse({ signal: "q:e1", answer: { optionIds: Array(101).fill("a0") } })).toThrow();
  expect(() => askAnswerInputSchema.parse({ signal: "x".repeat(601), answer: {} })).toThrow();
  expect(askAnswerInputSchema.parse({ signal: "q:e1", answer: { text: "ok" } })).toEqual({ signal: "q:e1", answer: { text: "ok" } });
  expect(() => askAnswerInputSchema.parse({ signal: "q:e1", answer: { texts: Array(51).fill("") } })).toThrow();
});

test("after an answer the bell counts what the chat lists open, while the session still shows the request", async () => {
  // The fake session keeps the request pending after the reply, as Paseo does until its next update.
  const f = fixture(baseBoard(), baseAgents());
  const before = (await f.asks.count(f.paseo)).count;
  expect(before).toBe(await openInChat(f));
  await answer(f, "p:s2:r2", { optionIds: ["a1"] });
  await answer(f, "q:e1", { text: "Postgres" });
  const after = (await f.asks.count(f.paseo)).count;
  expect(after).toBe(before - 2);
  expect(after).toBe(await openInChat(f));
  // An ended session's ask leaves both too.
  f.setAgents(baseAgents().filter((a) => a.id !== "s3"));
  const paseo = {
    agents: {
      list: async () => ({ entries: baseAgents().map((a) => ({ agent: a })), pageInfo: {} }),
      ref: (id: string) => ({ refresh: async () => (id === "s3" ? null : { agent: baseAgents().find((a) => a.id === id) }) }),
    },
  } as unknown as PaseoApi;
  expect(await f.asks.answer({ signal: "b:e2", answer: { text: "Rebased" } }, paseo)).toEqual({ delivered: false, state: "session_ended" });
  expect((await f.asks.count(f.paseo)).count).toBe(before - 3);
  expect((await f.asks.count(f.paseo)).count).toBe(await openInChat(f));
});

test("an ask whose session was archived or went away since the chat saw it is session ended, not answered", async () => {
  const f = fixture(baseBoard(), baseAgents());
  await f.asks.chatItems([], f.paseo);
  f.setAgents(baseAgents().filter((a) => a.id !== "s2"));
  expect(await answer(f, "p:s2:r2", { optionIds: ["a1"] })).toEqual({ delivered: false, state: "session_ended" });
  expect((await f.items.list()).find((i) => i.kind === "ask" && i.signal === "p:s2:r2")).toMatchObject({ state: "session_ended", askKind: "permission", taskId: "b" });
  expect((await f.items.list()).find((i) => i.kind === "ask" && i.signal === "p:s2:r2")).not.toHaveProperty("elsewhere");
  const g = fixture(baseBoard(), baseAgents());
  await g.asks.chatItems([], g.paseo);
  g.setAgents([baseAgents()[0], agent("s2", "w-b", { archivedAt: later }), baseAgents()[2]]);
  expect(await answer(g, "p:s2:r1", { optionIds: ["q0o0"] })).toEqual({ delivered: false, state: "session_ended" });
  expect(g.respond).not.toHaveBeenCalled();
});

test("a session-ended ask can be dismissed from the chat", async () => {
  const f = fixture(baseBoard(), baseAgents());
  await f.asks.chatItems([], f.paseo);
  f.setAgents(baseAgents().filter((a) => a.id !== "s2"));
  await answer(f, "p:s2:r2", { optionIds: ["a1"] });
  expect(await f.asks.dismiss({ signal: "p:s2:r2" }, f.paseo)).toEqual({ taskId: "b" });
  expect((await f.items.list()).find((i) => i.kind === "ask" && i.signal === "p:s2:r2")).toMatchObject({ state: "dismissed" });
  // An open ask nobody stored stays refused once gone.
  await expect(f.asks.dismiss({ signal: "p:s2:r1" }, f.paseo)).rejects.toThrow("no longer open");
});

test("declining an AskUserQuestion records what the reply did", async () => {
  // Free-text questions that accept empty answers submit empty on Decline: an allow, never shown as Denied.
  const empty = { id: "r9", kind: "question", input: { questions: [{ question: "Anything else?", header: "Notes", options: [], allowEmpty: true }] } };
  const f = fixture(baseBoard(), [baseAgents()[0], agent("s2", "w-b", { pendingPermissions: [empty] }), baseAgents()[2]]);
  await answer(f, "p:s2:r9", { allow: false });
  expect(f.respond.mock.calls[0][1]).toMatchObject({ response: { behavior: "allow" } });
  expect((await f.items.list()).find((i) => i.kind === "answer")).toMatchObject({ choice: "allow" });
  // With options, Decline denies.
  const g = fixture(baseBoard(), baseAgents());
  await answer(g, "p:s2:r1", { allow: false });
  expect(g.respond.mock.calls[0][1]).toMatchObject({ response: { behavior: "deny" } });
  expect((await g.items.list()).find((i) => i.kind === "answer")).toMatchObject({ choice: "deny" });
});

test("a form with several text questions takes one text per question and never drops typed text", async () => {
  const form = {
    id: "r5",
    kind: "question",
    input: {
      questions: [
        { question: "Branch name?", header: "Branch", options: [] },
        { question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], allowOther: true, multiSelect: false },
        { question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false },
      ],
    },
  };
  const agents = () => [baseAgents()[0], agent("s2", "w-b", { pendingPermissions: [form] }), baseAgents()[2]];
  const f = fixture(baseBoard(), agents());
  // One text for two text questions: refused.
  await expect(answer(f, "p:s2:r5", { text: "feat/x", optionIds: ["q2o0"] })).rejects.toThrow("its own box");
  // A typed text and an option on the same single-choice question: refused, not silently dropped.
  await expect(answer(f, "p:s2:r5", { texts: ["feat/x", "Green"], optionIds: ["q1o0", "q2o0"] })).rejects.toThrow("not both");
  // Text for a question that takes none: refused.
  await expect(answer(f, "p:s2:r5", { texts: ["feat/x", "", "MySQL"], optionIds: ["q1o0", "q2o0"] })).rejects.toThrow();
  expect(f.respond).not.toHaveBeenCalled();
  expect(await answer(f, "p:s2:r5", { texts: ["feat/x", "Green"], optionIds: ["q2o1"] })).toEqual({ delivered: true, state: "answered" });
  expect(f.respond.mock.calls[0][1]).toMatchObject({ response: { behavior: "allow", updatedInput: { answers: { Branch: "feat/x", Colour: "Green", DB: "SQLite" } } } });
});

test("after a reload with the chat closed, the bell (daemon's resolved signals, empty client set) equals the badge", async () => {
  const f = fixture(baseBoard(), baseAgents());
  await answer(f, "p:s2:r2", { optionIds: ["a1"] });
  // The session was archived after the list was read: the ask is recorded ended, and the board still shows the signal.
  const archived = { ...baseAgents()[0], archivedAt: later };
  // The next listing (after the answer invalidated the shared one) sees it archived too.
  let listed = baseAgents();
  const paseo = {
    agents: {
      list: async () => ({ entries: listed.map((a) => ({ agent: a })), pageInfo: {} }),
      ref: (id: string) => ({ refresh: async () => ({ agent: id === "s1" ? archived : baseAgents().find((a) => a.id === id) }) }),
    },
  } as unknown as PaseoApi;
  expect(await f.asks.answer({ signal: "q:e1", answer: { text: "Postgres" } }, paseo)).toEqual({ delivered: false, state: "session_ended" });
  listed = [archived, ...baseAgents().slice(1)];
  // Reload: a fresh client knows nothing; it reads the daemon's resolved signals.
  const resolved = new Set(await f.asks.resolvedSignals(paseo));
  expect([...resolved].sort()).toEqual(["p:s2:r2", "q:e1"]);
  const items = attentionFromSources({ board: f.board, agents: listed, receipts: [], readUnavailable: false })!;
  const badge = (await f.asks.count(paseo)).count;
  expect(openAskCount(items, resolved)).toBe(badge);
  // Without the resolved set the request still counts: the session still lists it.
  expect(openAskCount(items)).toBe(badge + 1);
  // A board that still lists the session unarchived leaves out both resolved signals too.
  const stale = attentionFromSources({ board: f.board, agents: baseAgents(), receipts: [], readUnavailable: false })!;
  expect(openAskCount(stale, resolved)).toBe(openAskCount(stale) - 2);
});

test("errors and unread turns are never answered or resolved, so their reused keys keep counting", async () => {
  const f = fixture(baseBoard(), [...baseAgents().slice(0, 2), agent("s3", "w-c", { status: "error" } as never)]);
  await f.asks.chatItems([], f.paseo);
  // The error cleared meanwhile: the known path must not record it.
  f.setAgents(baseAgents());
  await expect(answer(f, "e:s3:status", { text: "ok" })).rejects.toThrow("no answer");
  const unread = `u:${JSON.stringify(["s1", "finished", at])}`;
  await expect(answer(f, unread, { text: "ok" })).rejects.toThrow("no answer");
  expect(await f.items.list()).toEqual([]);
  expect(await f.asks.resolvedSignals(f.paseo)).toEqual([]);
  // The same key again later counts.
  f.setAgents([...baseAgents().slice(0, 2), agent("s3", "w-c", { status: "error" } as never)]);
  expect((await f.asks.chatItems([], f.paseo)).find((i) => i.kind === "ask" && i.signal === "e:s3:status")).toMatchObject({ state: "open" });
});

test("the shared agent list belongs to the Paseo handle it was read with", async () => {
  const cache = new AttentionAgents({ ttlMs: 60_000, now: () => 1 });
  const handle = () => {
    const list = vi.fn(async () => ({ entries: [], pageInfo: {} }));
    return { list, paseo: { agents: { list } } as unknown as PaseoApi };
  };
  const a = handle();
  const b = handle();
  await cache.list(a.paseo);
  await cache.list(a.paseo);
  await cache.list(b.paseo);
  expect(a.list).toHaveBeenCalledTimes(1);
  expect(b.list).toHaveBeenCalledTimes(1);
});

test("agent lists are shared for a short time: two polls inside it list agents once", async () => {
  let clock = 1_000;
  const cache = new AttentionAgents({ ttlMs: 2_000, now: () => clock });
  const f = fixture(baseBoard(), baseAgents(), cache);
  const list = (f.paseo.agents.list as unknown as ReturnType<typeof vi.fn>);
  await Promise.all([f.asks.count(f.paseo), f.asks.chatItems([], f.paseo)]);
  await f.asks.count(f.paseo);
  expect(list).toHaveBeenCalledTimes(1);
  clock += 2_001;
  await f.asks.count(f.paseo);
  expect(list).toHaveBeenCalledTimes(2);
  // A failed listing is not kept.
  clock += 2_001;
  list.mockRejectedValueOnce(new Error("down"));
  await expect(f.asks.count(f.paseo)).rejects.toThrow("down");
  await f.asks.count(f.paseo);
  expect(list).toHaveBeenCalledTimes(4);
});

test("a closed session's ask stays open, and answering it goes through (Paseo resumes the session; §9.4)", async () => {
  // Paseo 0.15.2 closes an idle session after an hour (and on a daemon restart): its process stops and its pending
  // requests are cleared, but its reports stay, and a message reloads it. Only archived or missing sessions have ended.
  const closed = () => [
    agent("s1", "w-a", { status: "closed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: at }),
    agent("s2", "w-b", { status: "closed", pendingPermissions: [], requiresAttention: true, attentionReason: "permission", attentionTimestamp: at }),
    agent("s3", "w-c"),
  ];
  const f = fixture(baseBoard(), closed());
  const items = await f.asks.chatItems([], f.paseo);
  const state = (signal: string) => items.flatMap((i) => (i.kind === "ask" && i.signal === signal ? [i.state] : []))[0];
  expect(state("q:e1")).toBe("open");
  expect(state("b:e2")).toBe("open");
  expect(items.some((i) => i.kind === "ask" && i.state === "session_ended")).toBe(false);
  // The bell, the badge and the chat's open rows agree, with the closed session's report among them.
  const open = items.filter((i) => i.kind === "ask" && i.state === "open").length;
  expect((await readAttentionCount(f.store, f.reads, f.paseo)).count).toBe(open);
  expect(openAskCount(attentionFromSources({ board: f.board, agents: closed(), receipts: [], readUnavailable: false })!)).toBe(open);
  expect(asksFrom(f.board, closed(), [], []).filter((a) => a.state === "open").map((a) => a.signal)).toContain("q:e1");
  // The answer is sent; Paseo reloads the session for it.
  expect(await answer(f, "q:e1", { text: "Postgres" })).toMatchObject({ delivered: true, state: "answered" });
  expect(f.send).toHaveBeenCalledWith("s1", "Postgres", expect.objectContaining({ activeTurnBehavior: "steer" }));
});

test("a session_ended row stored before closed sessions stayed live yields to the live ask while its session is present (§9.4)", async () => {
  // Rows written by 16c91d9 recorded a closed session's ask as session_ended. Its session is still listed and not
  // archived, and its report is still open: the ask is open in the chat and the bell, and an answer goes through.
  const closed = () => [
    agent("s1", "w-a", { status: "closed", requiresAttention: true, attentionReason: "finished", attentionTimestamp: at }),
    ...baseAgents().slice(1),
  ];
  const f = fixture(baseBoard(), closed());
  const live = asksFrom(f.board, closed(), [], []).find((a) => a.signal === "q:e1")!;
  await f.items.put([{ id: "ask-q:e1", at, kind: "ask", signal: "q:e1", taskId: "a", projectId: "p", title: "Card a", state: "session_ended", askKind: "question_report", agentId: "s1", detail: live.detail, options: [], resolvedAt: at }]);
  const items = await f.asks.chatItems(await f.items.list(), f.paseo);
  expect(items.filter((i) => i.kind === "ask" && i.signal === "q:e1").map((i) => i.kind === "ask" && i.state)).toEqual(["open"]);
  const resolved = new Set(await f.asks.resolvedSignals(f.paseo));
  expect(resolved.has("q:e1")).toBe(false);
  const open = items.filter((i) => i.kind === "ask" && i.state === "open").length;
  expect(openAskCount(attentionFromSources({ board: f.board, agents: closed(), receipts: [], readUnavailable: false })!, resolved)).toBe(open);
  expect((await f.asks.count(f.paseo)).count).toBe(open);
  expect(await answer(f, "q:e1", { text: "Postgres" })).toMatchObject({ delivered: true, state: "answered" });
  // Archived later, the stored row stands again (only archived or missing sessions end asks).
  const g = fixture(baseBoard(), [agent("s1", "w-a", { archivedAt: later }), ...baseAgents().slice(1)]);
  await g.items.put([{ id: "ask-q:e1", at, kind: "ask", signal: "q:e1", taskId: "a", projectId: "p", title: "Card a", state: "session_ended", askKind: "question_report", agentId: "s1", detail: live.detail, options: [], resolvedAt: at }]);
  expect(await g.asks.resolvedSignals(g.paseo)).toContain("q:e1");
  expect((await g.asks.chatItems(await g.items.list(), g.paseo)).find((i) => i.kind === "ask" && i.signal === "q:e1")).toMatchObject({ state: "session_ended" });
});

test("a closed session's permission with no request left takes a typed answer, sent to the session as typed (§9.4)", async () => {
  // Paseo clears pending requests on close; the permission attention stays (`p:<agent>:<time>`), with nothing to approve.
  const agents = () => [baseAgents()[0], agent("s2", "w-b", { status: "closed", pendingPermissions: [], requiresAttention: true, attentionReason: "permission", attentionTimestamp: at }), baseAgents()[2]];
  const f = fixture(baseBoard(), agents());
  const ask = (await f.asks.chatItems([], f.paseo)).find((i) => i.kind === "ask" && i.agentId === "s2");
  expect(ask).toMatchObject({ signal: `p:s2:${at}`, askKind: "permission", options: [], state: "open" });
  await expect(answer(f, `p:s2:${at}`, { text: "  " })).rejects.toThrow("Type an answer.");
  await expect(answer(f, `p:s2:${at}`, { optionIds: ["allow"] })).rejects.toThrow("Type an answer.");
  expect(await answer(f, `p:s2:${at}`, { text: "Go ahead and push" })).toEqual({ delivered: true, state: "answered" });
  expect(f.send).toHaveBeenCalledWith("s2", "Go ahead and push", expect.objectContaining({ activeTurnBehavior: "steer" }));
  expect(f.respond).not.toHaveBeenCalled();
  expect((await f.items.list()).find((i) => i.kind === "answer")).toMatchObject({ signal: `p:s2:${at}`, text: "Go ahead and push", delivered: true });
  expect(await f.asks.resolvedSignals(f.paseo)).toContain(`p:s2:${at}`);
});

test("a chat ask carries its request id, so the panel's text box follows the server's rule (§9.4)", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const asks = (await f.asks.chatItems([], f.paseo)).filter((i) => i.kind === "ask" && i.askKind === "permission");
  expect(asks.length).toBeGreaterThan(0);
  for (const ask of asks) {
    expect(ask.kind === "ask" && ask.requestId).toBe(ask.kind === "ask" && ask.signal.split(":")[2]);
  }
});

test("a deleted card's notes disappear from the chat, as its asks and answers do (ruling, Noah 2026-11-09)", async () => {
  const f = fixture(baseBoard(), baseAgents());
  const note = (id: string, taskId: string) => ({ id, at: "2026-11-09T00:00:00.000Z", kind: "note" as const, note: { taskId, projectId: "p", title: taskId, kind: "status", detail: "", at: "2026-11-09T00:00:00.000Z" } });
  f.setBoard(baseBoard({ tasks: [task("a"), task("c")] as never, events: [report("e1", "a", "s1", "question", "?"), report("e2", "c", "s3", "blocker", "x")] as never }));
  const items = await f.asks.chatItems([note("note-a", "a"), note("note-b", "b")], f.paseo);
  expect(items.filter((i) => i.kind === "note").map((i) => i.id)).toEqual(["note-a"]);
});
