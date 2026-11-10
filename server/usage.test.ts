import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogLocator, UsageService, readClaudeLog, readCodexLog, readDshLog, summarize } from "./usage";
import { BoardStore } from "./store";
import { cacheHitRate, compactDuration, compactNumber, percent, totalTokens } from "../shared/usage";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const r = await realpath(await mkdtemp(join(tmpdir(), "ultra-usage-")));
  roots.push(r);
  return r;
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const SID = "11111111-2222-3333-4444-555555555555";

const assistant = (id: string, at: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: at,
  message: { id, usage },
  ...extra,
});

test("Claude log: dedupes streamed messages, sums types, splits turns at real prompts", async () => {
  const r = await root();
  const path = join(r, "c.jsonl");
  const u1 = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 30, output_tokens_details: { thinking_tokens: 10 } };
  await writeFile(
    path,
    jsonl([
      { type: "user", timestamp: "2026-10-15T00:00:00Z", message: { content: "do it" } },
      assistant("m1", "2026-10-15T00:00:05Z", u1),
      assistant("m1", "2026-10-15T00:00:06Z", u1), // same message, second content block
      { type: "user", timestamp: "2026-10-15T00:00:07Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
      assistant("m2", "2026-10-15T00:00:10Z", { input_tokens: 1, output_tokens: 5 }),
      { type: "user", timestamp: "2026-10-15T00:01:00Z", isMeta: true, message: { content: "meta" } },
      { type: "user", timestamp: "2026-10-15T00:01:00Z", message: { content: "<task-notification>done</task-notification>" } },
      { type: "user", timestamp: "2026-10-15T00:02:00Z", message: { content: [{ type: "text", text: "next" }] } },
      assistant("m3", "2026-10-15T00:02:30Z", { input_tokens: 3, output_tokens: 7 }),
    ]) + "{broken",
  );
  const usage = await readClaudeLog(path);
  expect(usage.tokens).toEqual({ input: 6, cacheRead: 100, cacheWrite: 50, output: 42, reasoning: 10 });
  expect(usage.turns).toBe(2);
  expect(usage.activeMs).toBe(10_000 + 30_000);
});

test("Codex log: last cumulative count, cached split out of input, task turns", async () => {
  const r = await root();
  const path = join(r, `rollout-2026-10-15T15-19-28-${SID}.jsonl`);
  const count = (input: number, cached: number, out: number, reasoning: number) => ({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: reasoning } } },
  });
  await writeFile(
    path,
    jsonl([
      { type: "event_msg", timestamp: "2026-10-15T00:00:00Z", payload: { type: "task_started" } },
      count(100, 60, 10, 2),
      { type: "event_msg", timestamp: "2026-10-15T00:00:20Z", payload: { type: "task_complete" } },
      { type: "event_msg", timestamp: "2026-10-15T00:01:00Z", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "token_count", info: null } },
      count(300, 200, 25, 6),
      { type: "event_msg", timestamp: "2026-10-15T00:01:05Z", payload: { type: "task_complete" } },
    ]),
  );
  const usage = await readCodexLog(path);
  expect(usage.tokens).toEqual({ input: 100, cacheRead: 200, cacheWrite: 0, output: 25, reasoning: 6 });
  expect(usage).toMatchObject({ turns: 2, activeMs: 25_000 });
  expect(totalTokens(usage.tokens)).toBe(325);
});

test("locator finds Claude logs with subagents and Codex logs in sessions or archive", async () => {
  const r = await root();
  const claudeHome = join(r, "claude"),
    codexHome = join(r, "codex");
  await mkdir(join(claudeHome, "projects", "-x", SID, "subagents"), { recursive: true });
  await writeFile(join(claudeHome, "projects", "-x", `${SID}.jsonl`), "");
  await writeFile(join(claudeHome, "projects", "-x", SID, "subagents", "agent-a.jsonl"), "");
  await mkdir(join(codexHome, "sessions", "2026", "10", "15"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const other = "99999999-2222-3333-4444-555555555555";
  await writeFile(join(codexHome, "sessions", "2026", "10", "15", `rollout-2026-10-15T01-00-00-${SID}.jsonl`), "");
  let now = 1_000_000;
  const locator = new LogLocator(claudeHome, codexHome, () => now);
  expect(await locator.claude(SID)).toEqual({
    path: join(claudeHome, "projects", "-x", `${SID}.jsonl`),
    subagents: [join(claudeHome, "projects", "-x", SID, "subagents", "agent-a.jsonl")],
  });
  expect(await locator.claude(other)).toBeNull();
  expect(await locator.codex(SID)).toMatch(/sessions\/2026\/10\/15\/rollout-.*\.jsonl$/);
  await writeFile(join(codexHome, "archived_sessions", `rollout-2026-10-15T02-00-00-${other}.jsonl`), "");
  // Index rebuilds at most every 30 s.
  expect(await locator.codex(other)).toBeNull();
  now += 31_000;
  expect(await locator.codex(other)).toMatch(/archived_sessions/);
});

test("task usage lists every workspace session; summarizers are a separate subtotal", async () => {
  const r = await root();
  const claudeHome = join(r, "claude");
  await mkdir(join(claudeHome, "projects", "-x"), { recursive: true });
  const work = "aaaaaaaa-2222-3333-4444-555555555555",
    summary = "bbbbbbbb-2222-3333-4444-555555555555";
  await writeFile(join(claudeHome, "projects", "-x", `${work}.jsonl`), jsonl([{ type: "user", timestamp: "2026-10-15T00:00:00Z", message: { content: "go" } }, assistant("w", "2026-10-15T00:00:30Z", { input_tokens: 10, output_tokens: 20 })]));
  await writeFile(join(claudeHome, "projects", "-x", `${summary}.jsonl`), jsonl([assistant("s", "2026-10-15T00:00:30Z", { input_tokens: 1, output_tokens: 2 })]));
  const store = new BoardStore(join(r, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: r, repos: [r], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: r, repoPaths: [r], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const agents = [
    { id: "a1", title: "Worker", provider: "claude", workspaceId: "w", labels: {}, runtimeInfo: { sessionId: work, model: "opus" } },
    { id: "a2", title: "Kanban summary", provider: "claude", workspaceId: "w", labels: { "ultra-kanban": "summarizer" }, runtimeInfo: { sessionId: summary } },
    { id: "a3", title: "Hermes", provider: "hermes", workspaceId: "w", labels: {}, runtimeInfo: { sessionId: "zzz" } },
    { id: "a4", title: "Fresh", provider: "codex", workspaceId: "w", labels: {}, runtimeInfo: null },
    { id: "a5", title: "Elsewhere", provider: "claude", workspaceId: "other", labels: {}, runtimeInfo: { sessionId: work } },
  ];
  const paseo = { agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } }) } };
  const service = new UsageService(store, new LogLocator(claudeHome, join(r, "codex")));
  const usage = await service.task("t", paseo as never);
  // Sessions with tokens first, summarizers last.
  expect(usage.sessions[0].agentId).toBe("a1");
  expect(usage.sessions).toHaveLength(4);
  expect(usage.work).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 });
  expect(usage.summarizer).toEqual({ input: 1, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 });
  expect(totalTokens(usage.total)).toBe(33);
  expect(usage).toMatchObject({ turns: 1, activeMs: 30_000 });
  expect(usage.sessions.find((s) => s.agentId === "a3")?.note).toMatch(/No local/);
  expect(usage.sessions.find((s) => s.agentId === "a4")?.note).toMatch(/Not started/);
  expect(usage.sessions[usage.sessions.length - 1].summarizer).toBe(true);
  await expect(service.task("missing", paseo as never)).rejects.toThrow(/not found/);
});

test("summary ordering and number formatting", () => {
  expect(summarize([]).total).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  expect(compactNumber(999)).toBe("999");
  expect(compactNumber(1234)).toBe("1.2K");
  expect(compactNumber(3085304)).toBe("3.1M");
  expect(compactNumber(24_429_024)).toBe("24.4M");
  expect(compactNumber(150_000)).toBe("150K");
  expect(compactDuration(42_000)).toBe("42s");
  expect(compactDuration(5_025_000)).toBe("1h 23m");
});

test("cache hit rate is cache reads over all input", () => {
  expect(cacheHitRate({ input: 10, cacheRead: 180, cacheWrite: 10, output: 999, reasoning: 0 })).toBe(0.9);
  expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 })).toBeNull();
  expect(percent(0.9472)).toBe("94.7%");
  expect(percent(1)).toBe("100%");
});

test("token buckets: Claude messages by timestamp slot (deduped); Codex count differences, resets counted from zero", async () => {
  const r = await root();
  const claude = join(r, "c.jsonl");
  await writeFile(
    claude,
    jsonl([
      assistant("m1", "2026-10-15T23:50:00Z", { input_tokens: 1, output_tokens: 2 }),
      assistant("m1", "2026-10-15T23:50:01Z", { input_tokens: 1, output_tokens: 2 }),
      assistant("m2", "2026-10-16T00:10:00Z", { input_tokens: 4, cache_read_input_tokens: 10, output_tokens: 1 }),
    ]),
  );
  const slot = (iso: string) => Math.floor(Date.parse(iso) / (15 * 60_000));
  const c = await readClaudeLog(claude);
  expect([...c.buckets]).toEqual([
    [slot("2026-10-15T23:50:00Z"), { input: 1, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 }],
    [slot("2026-10-16T00:10:00Z"), { input: 4, cacheRead: 10, cacheWrite: 0, output: 1, reasoning: 0 }],
  ]);
  const codex = join(r, `rollout-x-${SID}.jsonl`);
  const count = (at: string, input: number, cached: number, out: number) => ({
    type: "event_msg",
    timestamp: at,
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0 } } },
  });
  await writeFile(
    codex,
    jsonl([
      count("2026-10-15T10:00:00Z", 100, 80, 10),
      count("2026-10-15T10:01:00Z", 100, 80, 10), // repeated count adds nothing
      count("2026-10-16T09:00:00Z", 300, 250, 30),
      count("2026-10-16T09:30:00Z", 50, 40, 5), // counter reset
    ]),
  );
  const x = await readCodexLog(codex);
  expect([...x.buckets]).toEqual([
    [slot("2026-10-15T10:00:00Z"), { input: 20, cacheRead: 80, cacheWrite: 0, output: 10, reasoning: 0 }],
    [slot("2026-10-16T09:00:00Z"), { input: 30, cacheRead: 170, cacheWrite: 0, output: 20, reasoning: 0 }],
    [slot("2026-10-16T09:30:00Z"), { input: 10, cacheRead: 40, cacheWrite: 0, output: 5, reasoning: 0 }],
  ]);
});

test("dsh-web log: sums per-turn rows, counts turns, buckets by row time", async () => {
  const slot = (iso: string) => Math.floor(Date.parse(iso) / (15 * 60_000));
  const r = await root();
  const dir = join(r, "plugin-data", "dsh-web-provider", "usage");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SID}.jsonl`);
  await writeFile(
    path,
    jsonl([
      {
        time: "2026-11-11T10:05:00Z",
        turnId: "t1",
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 10,
        startedAt: "2026-11-11T10:04:50Z",
        endedAt: "2026-11-11T10:05:00Z",
      },
      { time: "2026-11-11T10:40:00Z", turnId: "t2", inputTokens: 30, cachedInputTokens: 0, outputTokens: 5 },
      { time: "2026-11-11T11:20:00Z", turnId: "t3", inputTokens: 10, cachedInputTokens: 40, outputTokens: 5 },
      // A parseable non-object row (a literal null, a number) is skipped, not a turn.
      null,
      42,
      // An unusable time falls back to endedAt for the bucket slot.
      { time: "not-a-date", turnId: "t4", inputTokens: 7, cachedInputTokens: 0, outputTokens: 1, endedAt: "2026-11-11T12:00:00Z" },
    ]),
  );
  const locator = new LogLocator(undefined, undefined, () => Date.now(), r);
  const found = await locator.dsh(SID);
  expect(found).toBe(path);
  const usage = await readDshLog(path);
  expect(usage.tokens).toEqual({ input: 147, cacheRead: 120, cacheWrite: 0, output: 21, reasoning: 0 });
  expect(usage.turns).toBe(4);
  expect(usage.activeMs).toBe(10_000); // only row t1 carries both timestamps
  expect([...usage.buckets]).toEqual([
    [slot("2026-11-11T10:05:00Z"), { input: 100, cacheRead: 80, cacheWrite: 0, output: 10, reasoning: 0 }],
    [slot("2026-11-11T10:40:00Z"), { input: 30, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 }],
    [slot("2026-11-11T11:20:00Z"), { input: 10, cacheRead: 40, cacheWrite: 0, output: 5, reasoning: 0 }],
    [slot("2026-11-11T12:00:00Z"), { input: 7, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }],
  ]);
  // Path safety: an id that could escape the directory never resolves.
  expect(await locator.dsh("../escape")).toBeNull();
});

test("dsh-web log: stray JSON lines are not turns; tokenless turns stay out of buckets", async () => {
  const slot = (iso: string) => Math.floor(Date.parse(iso) / (15 * 60_000));
  const r = await root();
  const dir = join(r, "plugin-data", "dsh-web-provider", "usage");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SID}.jsonl`);
  await writeFile(
    path,
    jsonl([
      { time: "2026-11-11T10:05:00Z", turnId: "t1", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
      { note: "some other JSON the log happens to carry" }, // no turnId: not a turn
      { time: "2026-11-11T10:30:00Z", turnId: "t2" }, // tokenless turn: counts, no bucket
      { time: "2026-11-11T10:40:00Z", turnId: "t3", inputTokens: 30, cachedInputTokens: 0, outputTokens: 5 },
      { time: "2026-11-11T10:50:00Z", turnId: "t4", inputTokens: -50, cachedInputTokens: -1, outputTokens: -9 }, // negative counts clamp to 0
    ]),
  );
  const usage = await readDshLog(path);
  expect(usage.turns).toBe(4); // t1–t4 — the stray line is not a turn
  expect(usage.tokens).toEqual({ input: 130, cacheRead: 0, cacheWrite: 0, output: 15, reasoning: 0 });
  expect([...usage.buckets]).toEqual([
    [slot("2026-11-11T10:05:00Z"), { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 }],
    [slot("2026-11-11T10:40:00Z"), { input: 30, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 }],
  ]); // the tokenless t2 enters no bucket
});

test("dsh-web lookup resolves the plugin persistence handle to the DSH session id", async () => {
  const r = await root();
  const dir = join(r, "plugin-data", "dsh-web-provider", "usage");
  await mkdir(dir, { recursive: true });
  const dshId = "session-7b235f16-0bc4-4229-919a-fd03c00bcbae";
  await writeFile(join(dir, `${dshId}.jsonl`), jsonl([{ time: "2026-11-11T10:05:00Z", turnId: "t1", inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 }]));
  const locator = new LogLocator(undefined, undefined, () => Date.now(), r);
  const handle = `plugin:${JSON.stringify({ version: 1, data: { sessionId: dshId } })}`;
  expect(await locator.dsh(handle)).toBe(join(dir, `${dshId}.jsonl`));
  // A malformed or path-unsafe handle resolves to nothing.
  expect(await locator.dsh("plugin:not-json")).toBeNull();
  expect(await locator.dsh(`plugin:${JSON.stringify({ version: 1, data: { sessionId: "../x" } })}`)).toBeNull();
});
