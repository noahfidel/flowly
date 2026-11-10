import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { isSummarizer } from "../shared/summary";
import { cardWorkspaceIds } from "../shared/workspace-switch";
import { TOKEN_SLOT_MS, addUsage, zeroUsage, type SessionUsage, type TaskUsage, type TokenUsage } from "../shared/usage";

/**
 * Token usage read from provider session logs on this machine (USAGE-STATS-SPEC).
 * Read-only; parse results are cached by path, size and mtime.
 */
export type LogUsage = { tokens: TokenUsage; turns: number; activeMs: number; buckets: TokenBuckets };
/** Tokens by 15-minute slot (`floor(ms / SLOT_MS)`): every time zone offset is a multiple of 15 minutes. */
export type TokenBuckets = Map<number, TokenUsage>;
export const SLOT_MS = TOKEN_SLOT_MS;
function addTo(buckets: TokenBuckets, at: number, tokens: TokenUsage) {
  if (!Number.isFinite(at)) return;
  const slot = Math.floor(at / SLOT_MS);
  buckets.set(slot, addUsage(buckets.get(slot) || zeroUsage(), tokens));
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const time = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

async function* lines(path: string) {
  const reader = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line) continue;
      try {
        yield JSON.parse(line) as Record<string, any>;
      } catch {
        // A partially written last line or a corrupt entry: skip it.
      }
    }
  } finally {
    reader.close();
  }
}

const injected = /^\s*<(task-notification|system-reminder|command-|local-command)/;
/** A person's prompt, as opposed to a tool result or a system-injected entry. */
function claudePrompt(entry: Record<string, any>): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !injected.test(content);
  if (!Array.isArray(content)) return false;
  if (content.some((c) => c?.type === "tool_result")) return false;
  const text = content.find((c) => c?.type === "text")?.text;
  return typeof text === "string" && !injected.test(text);
}

/** Sums one Claude Code log: assistant messages deduplicated by id; turns start at prompts. */
export async function readClaudeLog(path: string, seen = new Set<string>()): Promise<LogUsage> {
  const tokens = zeroUsage();
  const buckets: TokenBuckets = new Map();
  let turns = 0,
    activeMs = 0,
    turnStart = NaN,
    turnEnd = NaN;
  const close = () => {
    if (Number.isFinite(turnStart) && Number.isFinite(turnEnd) && turnEnd > turnStart) activeMs += turnEnd - turnStart;
  };
  for await (const entry of lines(path)) {
    if (claudePrompt(entry)) {
      close();
      turns++;
      turnStart = time(entry.timestamp);
      turnEnd = NaN;
      continue;
    }
    const message = entry.message;
    if (entry.type !== "assistant" || !message?.usage) continue;
    if (!entry.isSidechain) turnEnd = time(entry.timestamp);
    const id = typeof message.id === "string" ? message.id : `${path}:${entry.uuid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = message.usage;
    const one = {
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
      reasoning: num(u.output_tokens_details?.thinking_tokens),
    };
    Object.assign(tokens, addUsage(tokens, one));
    addTo(buckets, time(entry.timestamp), one);
  }
  close();
  return { tokens, turns, activeMs, buckets };
}

/** One Codex rollout: the last cumulative token_count; turns are task_started → task_complete. */
/** Codex cumulative totals as unified token types. */
function codexUsage(total: Record<string, unknown>): TokenUsage {
  const cacheRead = num(total.cached_input_tokens),
    cacheWrite = num(total.cache_write_input_tokens);
  return {
    input: Math.max(0, num(total.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: num(total.output_tokens),
    reasoning: num(total.reasoning_output_tokens),
  };
}

export async function readCodexLog(path: string): Promise<LogUsage> {
  let total: Record<string, unknown> | null = null;
  // Cumulative counts: each token_count adds its difference from the previous one to its slot.
  const buckets: TokenBuckets = new Map();
  let previous = zeroUsage();
  let turns = 0,
    activeMs = 0,
    started = NaN;
  for await (const entry of lines(path)) {
    const payload = entry.payload;
    if (entry.type !== "event_msg" || !payload) continue;
    if (payload.type === "task_started") {
      turns++;
      started = time(entry.timestamp);
    } else if (payload.type === "task_complete") {
      const end = time(entry.timestamp);
      if (Number.isFinite(started) && end > started) activeMs += end - started;
      started = NaN;
    } else if (payload.type === "token_count" && payload.info?.total_token_usage) {
      total = payload.info.total_token_usage;
      const now = codexUsage(total!);
      const keys = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;
      // A counter that went down was reset: count the new total from zero.
      const reset = keys.some((k) => now[k] < previous[k]);
      const delta = zeroUsage();
      for (const k of keys) delta[k] = reset ? now[k] : now[k] - previous[k];
      if (keys.some((k) => delta[k] > 0)) addTo(buckets, time(entry.timestamp), delta);
      previous = now;
    }
  }
  return { tokens: total ? codexUsage(total) : zeroUsage(), turns, activeMs, buckets };
}

const exists = (path: string) =>
  stat(path).then(
    (s) => s,
    () => null,
  );

/**
 * One row of the dsh-web provider's per-session usage log
 * (`<PASEO_HOME>/plugin-data/dsh-web-provider/usage/<sessionId>.jsonl`): the
 * provider appends one row per finished turn (USAGE-STATS-SPEC §dsh-web).
 */
interface DshUsageRow {
  time?: unknown;
  turnId?: unknown;
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  outputTokens?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

/**
 * The session id the dsh-web provider keys its usage log by: the DSH session
 * id, which for a plugin provider arrives inside the persistence handle Paseo
 * exposes as runtimeInfo.sessionId — `plugin:{"version":1,"data":{"sessionId":
 * "session-…"}}`. Anything else (a bare UUID-shaped id from older records) is
 * used as-is; path-unsafe shapes are refused.
 */
export function dshLookupId(sessionId: string): string | null {
  if (sessionId.startsWith("plugin:")) {
    try {
      const handle = JSON.parse(sessionId.slice("plugin:".length)) as {
        data?: { sessionId?: unknown };
      };
      const inner = handle.data?.sessionId;
      return typeof inner === "string" && /^[A-Za-z0-9_-]+$/.test(inner) ? inner : null;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null;
}

/**
 * Aggregates the dsh-web provider's per-session usage log (one JSON row per
 * finished turn). Only provider-authored rows — those carrying a non-empty
 * `turnId` — count as turns, so stray JSON lines in the log cannot inflate the
 * count; tokenless turn rows still count (a failed turn is a turn) but enter
 * no bucket, so zero-token rows never pollute the 15-minute buckets.
 */
export async function readDshLog(path: string): Promise<LogUsage> {
  const tokens = zeroUsage();
  let turns = 0;
  let activeMs = 0;
  const buckets: TokenBuckets = new Map();
  for await (const row of lines(path) as AsyncGenerator<DshUsageRow>) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.turnId !== "string" || row.turnId === "") continue;
    turns += 1;
    const rowTokens = {
      input: Math.max(0, num(row.inputTokens)),
      cacheRead: Math.max(0, num(row.cachedInputTokens)),
      cacheWrite: 0,
      output: Math.max(0, num(row.outputTokens)),
      reasoning: 0,
    };
    tokens.input += rowTokens.input;
    tokens.cacheRead += rowTokens.cacheRead;
    tokens.output += rowTokens.output;
    const carriesTokens = rowTokens.input + rowTokens.cacheRead + rowTokens.output > 0;
    const rowTime = time(row.time);
    const at = Number.isFinite(rowTime) ? rowTime : time(row.endedAt);
    if (carriesTokens && Number.isFinite(at)) addTo(buckets, at, rowTokens);
    const started = time(row.startedAt);
    const ended = time(row.endedAt);
    if (Number.isFinite(started) && Number.isFinite(ended) && ended > started) {
      activeMs += ended - started;
    }
  }
  return { tokens, turns, activeMs, buckets };
}

/** Finds provider logs by session ID, independent of the Paseo provider name. */
export class LogLocator {
  private codexIndex = new Map<string, string>();
  private codexIndexedAt = 0;
  constructor(
    readonly claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    readonly codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
    private now = () => Date.now(),
    readonly dshUsageHome = process.env.PASEO_HOME || join(homedir(), ".paseo"),
  ) {}

  /** The dsh-web provider's per-session usage log, when one exists. */
  async dsh(sessionId: string): Promise<string | null> {
    const id = dshLookupId(sessionId);
    if (id === null) return null;
    const path = join(this.dshUsageHome, "plugin-data", "dsh-web-provider", "usage", `${id}.jsonl`);
    return (await exists(path))?.isFile() ? path : null;
  }

  async claude(sessionId: string): Promise<{ path: string; subagents: string[] } | null> {
    const projects = join(this.claudeHome, "projects");
    const dirs = await readdir(projects).catch(() => [] as string[]);
    for (const dir of dirs) {
      const path = join(projects, dir, `${sessionId}.jsonl`);
      if (!(await exists(path))?.isFile()) continue;
      const folder = join(projects, dir, sessionId, "subagents");
      const subagents = (await readdir(folder).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(folder, f));
      return { path, subagents };
    }
    return null;
  }

  async codex(sessionId: string): Promise<string | null> {
    const hit = this.codexIndex.get(sessionId);
    if (hit && (await exists(hit))) return hit;
    if (this.now() - this.codexIndexedAt < 30_000 && this.codexIndexedAt) return null;
    this.codexIndexedAt = this.now();
    const index = new Map<string, string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const path = join(dir, e.name);
        if (e.isDirectory() && depth > 0) await walk(path, depth - 1);
        else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
          const id = e.name.slice(0, -".jsonl".length).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
          if (id) index.set(id.toLowerCase(), path);
        }
      }
    };
    await walk(join(this.codexHome, "sessions"), 3);
    await walk(join(this.codexHome, "archived_sessions"), 0);
    this.codexIndex = index;
    return index.get(sessionId.toLowerCase()) || null;
  }
}

export type AgentLike = {
  id: string;
  title?: string | null;
  provider: string;
  workspaceId?: string | null;
  labels?: Record<string, string> | null;
  runtimeInfo?: { sessionId?: string | null; model?: string | null } | null;
  model?: string | null;
};

export class UsageService {
  private cache = new Map<string, { key: string; value: LogUsage }>();
  constructor(
    readonly store: BoardStore,
    readonly locator = new LogLocator(),
  ) {}

  private async cached(paths: string[], read: () => Promise<LogUsage>) {
    const stamps = await Promise.all(paths.map(async (p) => {
      const s = await exists(p);
      return s ? `${p}:${s.size}:${s.mtimeMs}` : `${p}:missing`;
    }));
    const key = stamps.join("|");
    const hit = this.cache.get(paths[0]);
    if (hit?.key === key) return hit.value;
    const value = await read();
    this.cache.set(paths[0], { key, value });
    return value;
  }

  async session(agent: AgentLike): Promise<SessionUsage> {
    const base = {
      agentId: agent.id,
      title: agent.title || agent.id,
      provider: agent.provider,
      model: agent.runtimeInfo?.model || agent.model || "",
      summarizer: isSummarizer(agent),
      source: null,
      tokens: null,
      turns: 0,
      activeMs: 0,
      note: "",
    } satisfies SessionUsage;
    const sessionId = agent.runtimeInfo?.sessionId;
    if (!sessionId) return { ...base, note: "Not started yet." };
    try {
      const claude = await this.locator.claude(sessionId);
      if (claude) {
        const files = [claude.path, ...claude.subagents];
        const usage = await this.cached(files, async () => {
          const seen = new Set<string>();
          const main = await readClaudeLog(claude.path, seen);
          for (const file of claude.subagents) {
            const sub = await readClaudeLog(file, seen);
            main.tokens = addUsage(main.tokens, sub.tokens);
            for (const [slot, tokens] of sub.buckets) main.buckets.set(slot, addUsage(main.buckets.get(slot) || zeroUsage(), tokens));
          }
          return main;
        });
        return { ...base, source: "claude", tokens: usage.tokens, turns: usage.turns, activeMs: usage.activeMs };
      }
      const codex = await this.locator.codex(sessionId);
      if (codex) {
        const usage = await this.cached([codex], () => readCodexLog(codex));
        return { ...base, source: "codex", tokens: usage.tokens, turns: usage.turns, activeMs: usage.activeMs };
      }
      const dsh = await this.locator.dsh(sessionId);
      if (dsh) {
        const usage = await this.cached([dsh], () => readDshLog(dsh));
        return { ...base, source: "dsh-web", tokens: usage.tokens, turns: usage.turns, activeMs: usage.activeMs };
      }
      return { ...base, note: "No local Claude Code, Codex or dsh-web log for this session." };
    } catch (e) {
      return { ...base, note: `Could not read its log: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** A session's tokens by 15-minute slot, or null when it has no local log (PROJECT-INSIGHTS-SPEC §11). */
  async buckets(agent: AgentLike): Promise<TokenBuckets | null> {
    const sessionId = agent.runtimeInfo?.sessionId;
    if (!sessionId) return null;
    const claude = await this.locator.claude(sessionId);
    if (claude) {
      await this.session(agent);
      return this.cache.get(claude.path)?.value.buckets || null;
    }
    const codex = await this.locator.codex(sessionId);
    if (codex) return (await this.cached([codex], () => readCodexLog(codex))).buckets;
    const dsh = await this.locator.dsh(sessionId);
    if (!dsh) return null;
    return (await this.cached([dsh], () => readDshLog(dsh))).buckets;
  }

  async task(taskId: string, paseo: PaseoApi): Promise<TaskUsage> {
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    const agents: AgentLike[] = [];
    // Sessions of the card's earlier workspaces count too (WORKSPACE-SWITCH-SPEC §8).
    const workspaces = new Set(cardWorkspaceIds(task));
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries) if (agent.workspaceId && workspaces.has(agent.workspaceId)) agents.push(agent as AgentLike);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    const sessions = await Promise.all(agents.map((a) => this.session(a)));
    return summarize(sessions);
  }
}

export function summarize(sessions: SessionUsage[]): TaskUsage {
  let work = zeroUsage(),
    summarizer = zeroUsage(),
    turns = 0,
    activeMs = 0;
  for (const s of sessions) {
    if (!s.tokens) continue;
    if (s.summarizer) summarizer = addUsage(summarizer, s.tokens);
    else {
      work = addUsage(work, s.tokens);
      turns += s.turns;
      activeMs += s.activeMs;
    }
  }
  const ordered = [...sessions].sort(
    (a, b) => Number(a.summarizer) - Number(b.summarizer) || (b.tokens ? 1 : 0) - (a.tokens ? 1 : 0) || a.title.localeCompare(b.title),
  );
  return { sessions: ordered, total: addUsage(work, summarizer), work, summarizer, turns, activeMs };
}
