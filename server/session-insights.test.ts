import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { NextMoveRows } from "./next-move-rows";
import { SessionInsightService, SessionInsightStore, type InsightSettings, type OutsideAgent } from "./session-insights";

vi.mock("./service", () => ({
  resolveWorktreeBaseRef: async (dir: string) => {
    if (dir.includes("nogit")) throw new Error("no git");
    return "refs/heads/main";
  },
  generatedBranchName: (title: string, id: string) => `kanban/${title.toLowerCase()}-${id.slice(0, 4)}`,
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
// A reply held at waitForFinish until release(); reached resolves once the run is waiting there.
const gated = () => {
  let release!: () => void, arrive!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  return { gate, arrive, reached, release: () => release() };
};
const turn = (text: string) => [{ type: "user_message", text }, { type: "assistant_message", text: "ok " + text }];

async function setup(options: { settings?: Partial<InsightSettings>; agentStatus?: string; directory?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-insights-")));
  roots.push(root);
  const store = new SessionInsightStore(join(root, "data"));
  const rows = new NextMoveRows(new BoardStore(join(root, "data")));
  const replies: { text?: string; status?: string; gate?: Promise<void>; arrive?: () => void; createError?: string }[] = [];
  const created: { workspaceId: string; parent?: string; prompt: string; labels?: Record<string, string>; config: { provider: string } }[] = [];
  const appended: { agentId: string; row: { kind: string; id: string; data: Record<string, unknown> } }[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const workspacesCreated: unknown[] = [];
  let archived = 0;
  const paseo = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }], error: null }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({ id: workspaceId, projectId: "prj", workspaceDirectory: options.directory ?? "/repo" }),
        agents: {
          create: async (o: { parent?: string; prompt: string; labels?: Record<string, string>; config: { provider: string } }) => {
            const reply = replies.shift() || {};
            if (reply.createError) throw new Error(reply.createError);
            created.push({ workspaceId, ...o });
            if (!o.parent) return { id: `new-${created.length}` };
            return {
              waitForFinish: async () => {
                reply.arrive?.();
                await reply.gate;
                return { status: reply.status || "idle", error: null, lastMessage: reply.text ?? null };
              },
              archive: async () => void archived++,
            };
          },
        },
      }),
      create: async (o: unknown) => {
        workspacesCreated.push(o);
        return { id: "wks-new" };
      },
    },
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => ({ agent: { id: agentId, archivedAt: null, workspaceId: "w1", provider: "codex", model: "gpt-6-luna", currentModeId: "full-access", thinkingOptionId: null, status: options.agentStatus ?? "idle", cwd: "/repo" } }),
        send: async (text: string) => void sent.push({ agentId, text }),
        timeline: { append: async (row: { kind: string; id: string; data: Record<string, unknown> }) => void appended.push({ agentId, row }) },
      }),
    },
  } as unknown as PaseoApi;
  let settings: InsightSettings = { enabled: true, parts: { progress: true, nextMoves: true, ideas: true }, model: "", ...options.settings };
  const service = new SessionInsightService(store, rows, async () => settings, async () => "en", 1000, 1000, async (a) => { await a.archive(); });
  const agent: OutsideAgent = { id: "a1", workspaceId: "w1", parentAgentId: null, title: "Fix login", cwd: "/repo" };
  const json = (o: object) => JSON.stringify({ update: true, state: "S", target: "T", recap: "- r", next: "N", moves: [], ideas: [], ...o });
  return { store, service, paseo, replies, created, appended, sent, workspacesCreated, archived: () => archived, agent, json, set: (s: Partial<InsightSettings>) => (settings = { ...settings, ...s }) };
}

test("a completed turn of an outside session runs one archived child insight session and stores progress, moves and ideas", async () => {
  const x = await setup();
  x.replies.push({ text: x.json({ moves: [{ label: "Verify", prompt: "Verify it" }], ideas: [{ title: "Add rate limit", detail: "d", rationale: "r", scope: "new" }] }) });
  await x.service.enqueue(x.agent, turn("fix login"), x.paseo);
  expect(x.created[0]).toMatchObject({ workspaceId: "w1", parent: "a1", labels: { flowly: "summarizer", "flowly-session": "a1" }, config: { provider: "claude/claude-haiku-5-5" } });
  expect(x.created[0].prompt).toContain("User: fix login");
  expect(x.archived()).toBe(1);
  const [s] = (await x.store.read()).sessions;
  expect(s).toMatchObject({ agentId: "a1", workspaceId: "w1", title: "Fix login", summary: { state: "S", model: "claude/claude-haiku-5-5" }, suggestion: { current: true, moves: [{ label: "Verify", prompt: "Verify it" }] }, error: null });
  expect(s.ideas.map((i) => [i.title, i.status])).toEqual([["Add rate limit", "open"]]);
  await x.service.idle();
  // Rows: Progress (no card fields) and the Next moves card for this suggestion.
  expect(x.appended.map((a) => a.row.kind)).toEqual(["flowly-summary", "flowly-next-moves"]);
  expect(x.appended[0].row.data.taskId).toBeUndefined();
  expect(x.appended[1].row).toMatchObject({ id: `flowly-next-moves-${s.suggestion!.id}`, data: { status: "ready", eventId: s.suggestion!.id } });
  expect((await x.service.view())[0]).toMatchObject({ agentId: "a1", suggestion: { id: s.suggestion!.id }, ideas: [{ title: "Add rate limit" }] });
});

test("off by default switch, no parts, subagents, sessions without a workspace, Flowly's own sessions and empty turns do nothing", async () => {
  const x = await setup({ settings: { enabled: false } });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  x.set({ enabled: true, parts: { progress: false, nextMoves: false, ideas: false } });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  x.set({ parts: { progress: true, nextMoves: true, ideas: true } });
  await x.service.enqueue({ ...x.agent, parentAgentId: "p" }, turn("x"), x.paseo);
  await x.service.enqueue({ ...x.agent, workspaceId: null }, turn("x"), x.paseo);
  await x.service.enqueue(x.agent, [{ type: "reasoning" }], x.paseo);
  // Flowly's own temporary sessions (memory review, digest, workflow insights): no insight, no stored entry.
  await x.service.enqueue({ ...x.agent, labels: { flowly: "summarizer", "flowly-memory": "retro" } }, turn("x"), x.paseo);
  expect(x.created).toEqual([]);
  expect((await x.service.view()).length).toBe(0);
});

test("each switch only asks for and stores its own part", async () => {
  const x = await setup({ settings: { parts: { progress: false, nextMoves: true, ideas: false } } });
  x.replies.push({ text: x.json({ moves: [{ label: "Go", prompt: "Go on" }], ideas: [{ title: "I", detail: "", rationale: "", scope: "new" }] }) });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  expect(x.created[0].prompt).not.toContain('"ideas"');
  const [s] = (await x.store.read()).sessions;
  expect(s.summary).toBeNull();
  expect(s.ideas).toEqual([]);
  expect(s.suggestion?.moves).toEqual([{ label: "Go", prompt: "Go on" }]);
});

test("one run per session; turns ending meanwhile merge into one follow-up run", async () => {
  const x = await setup();
  const g = gated();
  x.replies.push({ text: x.json({}), gate: g.gate, arrive: g.arrive }, { text: x.json({}) });
  const first = x.service.enqueue(x.agent, turn("first"), x.paseo);
  await g.reached;
  await x.service.enqueue(x.agent, turn("second"), x.paseo);
  await x.service.enqueue(x.agent, turn("third"), x.paseo);
  g.release();
  await first;
  expect(x.created).toHaveLength(2);
  expect(x.created[1].prompt).toContain("User: second");
  expect(x.created[1].prompt).toContain("User: third");
});

test("the next turn ends the suggestion; a run that finishes after a newer turn started stores progress but no suggestion and adds no rows", async () => {
  const x = await setup();
  x.replies.push({ text: x.json({ moves: [{ label: "A", prompt: "a" }] }) });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  await x.service.idle();
  await x.service.turnStarted("a1", x.paseo);
  expect((await x.store.read()).sessions[0].suggestion?.current).toBe(false);
  expect(await x.service.view()).toEqual([]);
  expect(x.appended.at(-1)?.row.data).toMatchObject({ status: "past", moves: [{ label: "A", prompt: "a" }] });
  const rowsBefore = x.appended.length;
  x.replies.push({ text: x.json({ state: "Later", moves: [{ label: "B", prompt: "b" }] }) });
  await x.service.enqueue(x.agent, turn("y"), x.paseo, new Date(Date.now() - 60_000).toISOString());
  await x.service.idle();
  const [s] = (await x.store.read()).sessions;
  expect(s.summary?.state).toBe("Later");
  expect(s.suggestion?.current).toBe(false);
  expect(x.appended).toHaveLength(rowsBefore);
});

test("ideas: no duplicate open titles, at most 5 open; a failed run is recorded, not thrown", async () => {
  const x = await setup();
  const idea = (title: string) => ({ title, detail: "", rationale: "", scope: "new" });
  for (const batch of [["A", "a"], ["B", "C"], ["D", "E"], ["F", "G"]])
    x.replies.push({ text: x.json({ ideas: batch.map(idea) }) });
  for (let i = 0; i < 4; i++) await x.service.enqueue(x.agent, turn(`t${i}`), x.paseo);
  const titles = (await x.store.read()).sessions[0].ideas.map((i) => i.title);
  expect(titles).toEqual(["A", "B", "C", "D", "E"]);
  expect(x.created.at(-1)?.prompt).toContain('"ideas": always an empty list');
  x.replies.push({ status: "timeout" });
  await x.service.enqueue(x.agent, turn("t9"), x.paseo);
  expect((await x.store.read()).sessions[0].error?.message).toMatch(/timed out/);
});

test("a workspace whose directory Paseo removed (merged/archived) skips the run: no error row, no stored insight", async () => {
  const x = await setup();
  x.replies.push({ createError: "Workspace wks_x has no available directory" });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  expect((await x.store.read()).sessions).toEqual([]);
  expect(await x.service.view()).toEqual([]);
});

test("only a workspace-gone failure skips; a real failure mixed in is still recorded", async () => {
  const x = await setup({ settings: { model: ["claude/claude-haiku-5-5", "claude/claude-sonnet-5-5"] } });
  x.replies.push({ createError: "Workspace wks_x has no available directory" }, { createError: "The provider rate limited the request." });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  const [s] = (await x.store.read()).sessions;
  expect(s.error?.message).toContain("rate limited");
});

test("idea actions: here sends the instruction, session starts one in the workspace, workspace branches off; each marks it adopted once", async () => {
  const x = await setup();
  const idea = (title: string) => ({ title, detail: "Do it", rationale: "Because", scope: "new" });
  x.replies.push({ text: x.json({ ideas: [idea("Here"), idea("Session")] }) }, { text: x.json({ ideas: [idea("Workspace")] }) });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  await x.service.enqueue(x.agent, turn("y"), x.paseo);
  const ids = Object.fromEntries((await x.store.read()).sessions[0].ideas.map((i) => [i.title, i.id]));
  expect(await x.service.runIdea({ agentId: "a1", ideaId: ids.Here, target: "here" }, x.paseo)).toEqual({ target: "here", agentId: "a1" });
  expect(x.sent).toEqual([{ agentId: "a1", text: "Good idea — go ahead with it in this task: Here\n\nDo it\n\nWhy: Because" }]);
  await expect(x.service.runIdea({ agentId: "a1", ideaId: ids.Here, target: "here" }, x.paseo)).rejects.toThrow(/no longer open/);
  const session = await x.service.runIdea({ agentId: "a1", ideaId: ids.Session, target: "session" }, x.paseo);
  expect(session).toMatchObject({ target: "session", workspaceId: "w1" });
  expect(x.created.at(-1)).toMatchObject({ workspaceId: "w1", config: { provider: "codex/gpt-6-luna", modeId: "full-access" }, prompt: expect.stringContaining("Session") });
  const ws = await x.service.runIdea({ agentId: "a1", ideaId: ids.Workspace, target: "workspace" }, x.paseo);
  expect(ws).toMatchObject({ target: "workspace", workspaceId: "wks-new" });
  expect(x.workspacesCreated[0]).toMatchObject({ source: { kind: "worktree", cwd: "/repo", projectId: "prj", action: "branch-off", refName: "refs/heads/main" } });
  expect((await x.store.read()).sessions[0].ideas.every((i) => i.status === "adopted")).toBe(true);
});

test("idea actions refuse a busy session (here) and a folder that is not a Git repo (workspace); dismiss closes an idea", async () => {
  const x = await setup({ agentStatus: "running", directory: "/nogit" });
  x.replies.push({ text: x.json({ ideas: [{ title: "I", detail: "", rationale: "", scope: "new" }] }) });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  const id = (await x.store.read()).sessions[0].ideas[0].id;
  await expect(x.service.runIdea({ agentId: "a1", ideaId: id, target: "here" }, x.paseo)).rejects.toThrow(/working/);
  await expect(x.service.runIdea({ agentId: "a1", ideaId: id, target: "workspace" }, x.paseo)).rejects.toThrow(/not a Git repository/);
  await x.service.dismissIdea({ agentId: "a1", ideaId: id });
  expect((await x.store.read()).sessions[0].ideas[0].status).toBe("dismissed");
  expect(await x.service.view()).toEqual([]);
});

test("outside-session insights follows the ordered summary list and retries invalid output", async () => {
  const x = await setup({ settings: { model: ["claude/claude-sonnet-5-5", "claude/claude-haiku-5-5"] } });
  x.replies.push({ text: "limit reached" }, { text: x.json({}) });
  await x.service.enqueue(x.agent, turn("x"), x.paseo);
  expect(x.created.map((a) => a.config.provider)).toEqual(["claude/claude-sonnet-5-5", "claude/claude-haiku-5-5"]);
  expect(x.archived()).toBe(2);
  expect((await x.store.read()).sessions[0].summary?.model).toBe("claude/claude-haiku-5-5");
});
