import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SummaryService, SummaryStore } from "./summaries";
import type { SummarySettings } from "../shared/summary";
import { summaryRow } from "../shared/native-session";

const roots: string[] = [];
const settle = () => new Promise((r) => setTimeout(r, 30));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

type Reply = { status?: "idle" | "error" | "permission" | "timeout"; text?: string; error?: string; gate?: Promise<void>; createError?: string; waitError?: string };

async function setup(options: { claude?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-summary-")));
  roots.push(root);
  const board = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const replies: Reply[] = [];
  const created: { workspaceId: string; parent: string; provider: string; prompt: string; labels: Record<string, string> }[] = [];
  let archived = 0;
  const appended: { agentId: string; row: unknown }[] = [];
  const archivedIds = new Set<string>(), gone = new Set<string>();
  let appendFails = false,
    appendHangs = false;
  const paseo = {
    providers: {
      listAvailable: async () => ({
        providers: [
          { provider: "claude", available: options.claude ?? true },
          { provider: "codex", available: true },
        ],
      }),
      listModels: async (p: string) => ({ models: p === "claude" ? [{ id: "claude-haiku-5-5" }] : [{ id: "gpt-6-luna" }, { id: "gpt-6-sol" }], error: null }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
      create: async (o: { parent: string; config: { provider: string }; prompt: string; labels: Record<string, string> }) => {
        created.push({ workspaceId, parent: o.parent, provider: o.config.provider, prompt: o.prompt, labels: o.labels });
        const reply = replies.shift() || {};
        if (reply.createError) throw new Error(reply.createError);
        return {
          waitForFinish: async () => {
            await reply.gate;
            if (reply.waitError) throw new Error(reply.waitError);
            return { status: reply.status || "idle", final: null, error: reply.error || null, lastMessage: reply.text ?? null };
          },
          archive: async () => {
            archived++;
            return { archivedAt: now };
          },
        };
      },
        },
      }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => (gone.has(id) ? null : { agent: { id, archivedAt: archivedIds.has(id) ? now : null } }),
        timeline: {
          append: async (row: unknown) => {
            if (appendFails) throw new Error("append failed");
            if (appendHangs) return new Promise(() => undefined);
            appended.push({ agentId: id, row });
            return { seq: appended.length, epoch: "e" };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  let settings: SummarySettings = { summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true };
  const store = new SummaryStore(board.directory);
  const service = new SummaryService(board, store, async () => settings, async () => "en", undefined, 50, async (a) => { await a.archive(); });
  const turn = (text: string) => [{ type: "user_message", text }, { type: "assistant_message", text: "ok " + text }];
  const json = (state: string, update = true) => JSON.stringify({ update, state, target: "Goal: g", recap: "r", next: "n" });
  return {
    root,
    board,
    store,
    service,
    paseo,
    replies,
    created,
    archived: () => archived,
    appended,
    archivedIds,
    gone,
    failAppend: () => (appendFails = true),
    hangAppend: () => (appendHangs = true),
    turn,
    json,
    setSettings: (s: Partial<SummarySettings>) => (settings = { ...settings, ...s }),
  };
}

test("a turn writes a version without touching board or task revisions; the session is archived", async () => {
  const x = await setup();
  const before = await x.board.read();
  x.replies.push({ text: x.json("实现完成") });
  await x.service.enqueue("t", "a1", x.turn("做登录"), x.paseo);
  const latest = await x.store.latest("t");
  expect(latest).toMatchObject({ state: "实现完成", target: "g", model: "claude/claude-haiku-5-5", agentIds: ["a1"] });
  // Child of the finishing session in the card's own workspace: no new native project/workspace.
  expect(x.created[0]).toMatchObject({ workspaceId: "w", parent: "a1", labels: { flowly: "summarizer", "flowly-task": "t" } });
  expect(x.created[0].prompt).toContain("User: 做登录");
  expect(x.archived()).toBe(1);
  const after = await x.board.read();
  expect(after.revision).toBe(before.revision);
  expect(after.tasks[0].revision).toBe(1);
});

test("falls back to GPT-6-Luna when Claude is unavailable", async () => {
  const x = await setup({ claude: false });
  x.replies.push({ text: x.json("s") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  expect(x.created[0].provider).toBe("codex/gpt-6-luna");
});

test.each<Reply>([
  { status: "error", error: "You've hit your limit" },
  { status: "idle", error: "Rate limit exceeded", text: JSON.stringify({ update: true, state: "stale" }) },
  { status: "idle", text: "You've hit your limit" },
  { status: "timeout" },
  { status: "permission" },
  { text: '{"update":true,"state":""}' },
  { createError: "Quota exhausted during create" },
  { waitError: "Provider connection failed" },
])("Auto falls back after a model failure: %j", async (failure) => {
  const x = await setup();
  await x.store.setError("t", "old error");
  x.replies.push(failure, { text: x.json("Luna succeeded") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  expect(x.created.map((a) => a.provider)).toEqual(["claude/claude-haiku-5-5", "codex/gpt-6-luna"]);
  expect(x.created[1]).toMatchObject({ workspaceId: "w", parent: "a1", prompt: x.created[0].prompt, labels: x.created[0].labels });
  expect(await x.store.history("t")).toHaveLength(1);
  expect(await x.store.latest("t")).toMatchObject({ model: "codex/gpt-6-luna", state: "Luna succeeded" });
  expect((await x.store.read()).errors).toEqual([]);
  expect(x.archived()).toBe(failure.createError ? 1 : 2);
  expect(x.service.running()).toEqual([]);
});

test("Auto exhausts both models once, keeps the old summary, and records both failures", async () => {
  const x = await setup();
  await x.store.add({ taskId: "t", model: "old", agentIds: [], state: "previous", target: "", recap: "", next: "" });
  x.replies.push({ status: "error", error: "Haiku limit reached" }, { status: "error", error: "Luna unavailable" });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  expect(x.created).toHaveLength(2);
  expect(x.archived()).toBe(2);
  expect(await x.store.history("t")).toHaveLength(1);
  expect((await x.store.latest("t"))?.state).toBe("previous");
  expect((await x.store.read()).errors[0].message).toBe("claude/claude-haiku-5-5: Haiku limit reached; codex/gpt-6-luna: Luna unavailable");
});

test("a valid update=false stops Auto without a fallback and clears old errors", async () => {
  const x = await setup();
  await x.store.add({ taskId: "t", model: "old", agentIds: [], state: "previous", target: "", recap: "", next: "" });
  await x.store.setError("t", "old error");
  x.replies.push({ text: x.json("ignored", false) });
  await x.service.enqueue("t", "a1", x.turn("thanks"), x.paseo);
  expect(x.created).toHaveLength(1);
  expect(await x.store.history("t")).toHaveLength(1);
  expect((await x.store.read()).errors).toEqual([]);
});

test("update=false keeps the previous version; the first summary is always written", async () => {
  const x = await setup();
  x.replies.push({ text: x.json("first", false) });
  await x.service.enqueue("t", "a1", x.turn("hi"), x.paseo);
  expect(await x.store.history("t")).toHaveLength(1);
  x.replies.push({ text: x.json("ignored", false) });
  await x.service.enqueue("t", "a1", x.turn("thanks"), x.paseo);
  const history = await x.store.history("t");
  expect(history).toHaveLength(1);
  expect(history[0].state).toBe("first");
  expect(x.created[1].prompt).toContain("State: first");
});

test("one run per card; turns ending meanwhile merge into a single follow-up", async () => {
  const x = await setup();
  let release!: () => void;
  x.replies.push({ text: x.json("one"), gate: new Promise<void>((r) => (release = r)) }, { text: x.json("two") });
  const first = x.service.enqueue("t", "a1", x.turn("first"), x.paseo);
  await settle();
  expect(x.service.running()).toEqual(["t"]);
  await x.service.enqueue("t", "a2", x.turn("second"), x.paseo);
  await x.service.enqueue("t", "a1", x.turn("third"), x.paseo);
  expect(x.created).toHaveLength(1);
  release();
  await first;
  expect(x.created).toHaveLength(2);
  expect(x.created[1].prompt).toContain("User: second");
  expect(x.created[1].prompt).toContain("User: third");
  expect((await x.store.latest("t"))?.agentIds.sort()).toEqual(["a1", "a2"]);
  expect(x.service.running()).toEqual([]);
});

test("settled() resolves only after the card's queued runs have finished and archived", async () => {
  const x = await setup();
  await x.service.settled("t");
  let release!: () => void;
  x.replies.push({ text: x.json("one"), gate: new Promise<void>((r) => (release = r)) });
  void x.service.enqueue("t", "a1", x.turn("first"), x.paseo);
  let settledYet = false;
  const waiting = x.service.settled("t").then(() => (settledYet = true));
  await settle();
  expect(settledYet).toBe(false);
  release();
  await waiting;
  expect(x.archived()).toBe(1);
  expect(x.service.running()).toEqual([]);
});

test("failures are recorded, the old summary kept, and the session still archived", async () => {
  const x = await setup();
  x.setSettings({ summaryModel: "claude/claude-haiku-5-5" });
  x.replies.push({ text: x.json("good") });
  await x.service.enqueue("t", "a1", x.turn("a"), x.paseo);
  for (const reply of [{ status: "timeout" as const }, { status: "permission" as const }, { text: "not json" }]) {
    x.replies.push(reply);
    await x.service.enqueue("t", "a1", x.turn("b"), x.paseo);
  }
  const state = await x.store.read();
  expect(state.errors).toEqual([expect.objectContaining({ taskId: "t", message: expect.stringMatching(/no JSON/) })]);
  expect((await x.store.latest("t"))?.state).toBe("good");
  expect(x.archived()).toBe(4);
  x.replies.push({ text: x.json("again") });
  await x.service.enqueue("t", "a1", x.turn("c"), x.paseo);
  expect((await x.store.read()).errors).toEqual([]);
});

test("an unavailable configured model is an error without creating a session", async () => {
  const x = await setup();
  x.setSettings({ summaryModel: "codex/missing" });
  await x.service.enqueue("t", "a1", x.turn("a"), x.paseo);
  expect(x.created).toHaveLength(0);
  expect((await x.store.read()).errors[0].message).toMatch(/No configured summary model/);
});

test("archived cards and empty turns are skipped", async () => {
  const x = await setup();
  await x.service.enqueue("t", "a1", [{ type: "reasoning" }], x.paseo);
  await x.board.mutate((b) => (b.tasks[0].archivedAt = new Date().toISOString()));
  await x.service.enqueue("t", "a1", x.turn("a"), x.paseo);
  expect(x.created).toHaveLength(0);
});

test("keeps the newest 50 versions per card", async () => {
  const x = await setup();
  for (let i = 0; i < 53; i++)
    await x.store.add({ taskId: "t", model: "m", agentIds: [], state: `s${i}`, target: "", recap: "", next: "" });
  await x.store.add({ taskId: "other", model: "m", agentIds: [], state: "o", target: "", recap: "", next: "" });
  const history = await x.store.history("t");
  expect(history).toHaveLength(50);
  expect(history[0].state).toBe("s52");
  expect(history[49].state).toBe("s3");
});

test("project removal backs up then drops the cards' summaries", async () => {
  const x = await setup();
  await x.store.add({ taskId: "t", model: "m", agentIds: [], state: "s", target: "", recap: "", next: "" });
  await x.store.add({ taskId: "keep", model: "m", agentIds: [], state: "k", target: "", recap: "", next: "" });
  await x.store.setError("t", "bad");
  const backup = await x.store.removeTasks("p", new Set(["t"]));
  expect(backup).toBeTruthy();
  const saved = JSON.parse(await readFile(backup!, "utf8"));
  expect(saved.entries).toHaveLength(1);
  expect(saved.errors).toHaveLength(1);
  const state = await x.store.read();
  expect(state.entries.map((e) => e.taskId)).toEqual(["keep"]);
  expect(state.errors).toEqual([]);
  expect(await x.store.removeTasks("p", new Set(["none"]))).toBeNull();
  expect(await readdir(join(x.board.directory, "removed"))).toHaveLength(1);
});

test("invalid summary data is preserved, not reset", async () => {
  const x = await setup();
  await x.store.add({ taskId: "t", model: "m", agentIds: [], state: "s", target: "", recap: "", next: "" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(x.store.path, "{broken");
  await expect(x.store.read()).rejects.toThrow(/preserved/);
  await expect(x.store.add({ taskId: "t", model: "m", agentIds: [], state: "s", target: "", recap: "", next: "" })).rejects.toThrow();
  expect(await readFile(x.store.path, "utf8")).toBe("{broken");
});

test("manual refresh summarizes the latest turn of the most recent managed session", async () => {
  const x = await setup();
  const timelines: Record<string, unknown[]> = {
    old: [{ item: { type: "user_message", text: "old" }, timestamp: "2026-01-01" }],
    new: [
      { item: { type: "user_message", text: "earlier" }, timestamp: "2026-02-01" },
      { item: { type: "user_message", text: "latest ask" }, timestamp: "2026-02-02" },
      { item: { type: "assistant_message", text: "answer" }, timestamp: "2026-02-03" },
    ],
  };
  (x.paseo.agents as unknown as { ref: unknown }).ref = (id: string) => ({
    refresh: async () => ({ agent: { id, archivedAt: null } }),
    timeline: {
      refetch: async () => ({ entries: timelines[id] }),
      append: async (row: unknown) => void x.appended.push({ agentId: id, row }),
    },
  });
  await expect(x.service.refresh("t", [], x.paseo)).rejects.toThrow("This card has no chats to summarize yet.");
  x.replies.push({ text: x.json("refreshed") });
  expect(await x.service.refresh("t", ["old", "new"], x.paseo)).toEqual({ queued: true });
  await settle();
  expect(x.created[0].prompt).toContain("User: latest ask");
  expect(x.created[0].prompt).not.toContain("User: earlier");
  expect((await x.store.latest("t"))?.agentIds).toEqual(["new"]);
  // The row goes to the refreshed session (NATIVE-SESSION-SPEC §5.1).
  expect(x.appended.map((a) => a.agentId)).toEqual(["new"]);
});

test("manual refresh summarizes a workspace chat Flowly did not start (PR review card)", async () => {
  const x = await setup();
  const { resolveCardChats } = await import("./card-chats");
  const watcher = { id: "pr", workspaceId: "w", archivedAt: null, labels: { "pr-review-watch": "o/r#1" } };
  const helper = { id: "sum", workspaceId: "w", archivedAt: null, labels: { flowly: "summarizer" } };
  const api = x.paseo as unknown as { agents: Record<string, unknown> };
  api.agents.list = async () => ({ entries: [{ agent: watcher }, { agent: helper }], pageInfo: { nextCursor: null } });
  api.agents.ref = (id: string) => ({
    refresh: async () => ({ agent: { id, archivedAt: null } }),
    timeline: {
      refetch: async () => ({
        entries:
          id === "pr"
            ? [
                { item: { type: "user_message", text: "review PR 1" }, timestamp: "2026-02-02" },
                { item: { type: "assistant_message", text: "two findings" }, timestamp: "2026-02-03" },
              ]
            : [],
      }),
      append: async (row: unknown) => void x.appended.push({ agentId: id, row }),
    },
  });
  const chats = await resolveCardChats(x.paseo, "t", (await x.board.read()).tasks, []);
  expect(chats).toEqual(["pr"]);
  x.replies.push({ text: x.json("reviewed") });
  expect(await x.service.refresh("t", chats!, x.paseo)).toEqual({ queued: true });
  await settle();
  expect(x.created[0].prompt).toContain("User: review PR 1");
  expect((await x.store.latest("t"))?.agentIds).toEqual(["pr"]);
});

test("overview lists latest per card, running cards, errors and the setting", async () => {
  const x = await setup();
  await x.store.add({ taskId: "t", model: "m", agentIds: [], state: "a", target: "", recap: "", next: "" });
  await x.store.add({ taskId: "t", model: "m", agentIds: [], state: "b", target: "", recap: "", next: "" });
  x.setSettings({ summaryEnabled: false });
  const o = await x.service.overview();
  expect(o.latest.map((e) => e.state)).toEqual(["b"]);
  expect(o).toMatchObject({ running: [], errors: [], enabled: false });
});

test("versions written before target existed read with an empty target", async () => {
  const x = await setup();
  const { writeFile } = await import("node:fs/promises");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(x.board.directory, { recursive: true });
  await writeFile(
    x.store.path,
    JSON.stringify({ version: 1, entries: [{ id: "e", taskId: "t", at: "2026-10-15T00:00:00Z", model: "m", agentIds: [], state: "old", recap: "", next: "" }], errors: [] }),
  );
  expect((await x.store.latest("t"))?.target).toBe("");
  x.replies.push({ text: x.json("new") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  expect(x.created[0].prompt).toContain("Target: (not set yet)");
  expect((await x.store.latest("t"))?.target).toBe("g");
});

test("a new version is appended as one flowly-summary row to the session whose turn produced it (NATIVE-SESSION-SPEC §5.1)", async () => {
  const x = await setup();
  x.replies.push({ text: x.json("实现完成") });
  await x.service.enqueue("t", "a1", x.turn("做登录"), x.paseo, new Date().toISOString());
  await settle();
  const latest = (await x.store.latest("t"))!;
  expect(x.appended).toEqual([{ agentId: "a1", row: summaryRow(latest, "w") }]);
  expect(x.appended[0].row).toMatchObject({ type: "plugin", id: `flowly-summary-${latest.id}`, kind: "flowly-summary", version: 1 });
});

test("merged turns append to the last session of the batch", async () => {
  const x = await setup();
  let release!: () => void;
  x.replies.push({ text: x.json("one"), gate: new Promise<void>((r) => (release = r)) }, { text: x.json("two") });
  const first = x.service.enqueue("t", "a1", x.turn("first"), x.paseo);
  await settle();
  await x.service.enqueue("t", "a2", x.turn("second"), x.paseo);
  release();
  await first;
  await settle();
  expect(x.appended.map((a) => a.agentId)).toEqual(["a1", "a2"]);
});

test("no row for update=false or a failed run", async () => {
  const x = await setup();
  x.replies.push({ text: x.json("first") });
  await x.service.enqueue("t", "a1", x.turn("hi"), x.paseo);
  x.replies.push({ text: x.json("same", false) }, { status: "error", error: "boom" });
  await x.service.enqueue("t", "a1", x.turn("thanks"), x.paseo);
  await x.service.enqueue("t", "a1", x.turn("again"), x.paseo);
  await settle();
  expect(x.appended).toHaveLength(1);
});

test("skips the row when that session started a newer turn, but keeps the version", async () => {
  const x = await setup();
  const endedAt = new Date(Date.now() - 60_000).toISOString();
  await x.board.mutate((b) => {
    b.events.push({ id: "ev", taskId: "t", actor: "system", action: "agent.turn_started", agentId: "a1", at: new Date().toISOString() } as never);
  });
  x.replies.push({ text: x.json("s") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo, endedAt);
  await settle();
  expect(await x.store.latest("t")).toMatchObject({ state: "s" });
  expect(x.appended).toEqual([]);
});

test("skips the row for an archived or missing session; an append failure keeps the version and records no error", async () => {
  const x = await setup();
  x.archivedIds.add("a1");
  x.gone.add("a2");
  x.replies.push({ text: x.json("one") }, { text: x.json("two") }, { text: x.json("three") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  await x.service.enqueue("t", "a2", x.turn("y"), x.paseo);
  await settle();
  expect(x.appended).toEqual([]);
  x.failAppend();
  await x.service.enqueue("t", "a3", x.turn("z"), x.paseo);
  await settle();
  expect(await x.store.latest("t")).toMatchObject({ state: "three" });
  expect((await x.store.read()).errors).toEqual([]);
});

test("a hung append never holds up the card's next summary", async () => {
  const x = await setup();
  x.hangAppend();
  x.replies.push({ text: x.json("one") }, { text: x.json("two") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  await x.service.enqueue("t", "a1", x.turn("y"), x.paseo);
  expect((await x.store.latest("t"))?.state).toBe("two");
});

test("custom priority retries three models and saves only the successful model", async () => {
  const x = await setup();
  x.setSettings({ summaryModels: ["codex/gpt-6-sol", "claude/claude-haiku-5-5", "codex/gpt-6-luna"] });
  x.replies.push({ status: "error", error: "limit 1" }, { status: "error", error: "limit 2" }, { text: x.json("third") });
  await x.service.enqueue("t", "a1", x.turn("x"), x.paseo);
  expect(x.created.map((a) => a.provider)).toEqual(["codex/gpt-6-sol", "claude/claude-haiku-5-5", "codex/gpt-6-luna"]);
  expect(x.archived()).toBe(3);
  expect(await x.store.history("t")).toHaveLength(1);
  expect(await x.store.latest("t")).toMatchObject({ state: "third", model: "codex/gpt-6-luna" });
});
