import { z } from "zod";
import { firstObject } from "./summary";
import { outputLanguageRule } from "./ai-language";
import type { LocaleCode } from "./i18n";

/** Project memory (PROJECT-MEMORY-SPEC): user-confirmed knowledge shared across a project's cards. */

export const memoryKinds = ["decision", "convention", "pitfall", "contact"] as const;
export type MemoryKind = (typeof memoryKinds)[number];
export const memoryStatuses = ["candidate", "active", "dismissed", "archived"] as const;
export type MemoryStatus = (typeof memoryStatuses)[number];

/** §3.3. Review and injection budgets, not storage limits (§3.4). */
export const memoryLimits = {
  title: 120,
  body: 1000,
  tags: 4,
  keywords: 12,
  keyword: 40,
  evidence: 300,
  activePerProject: 200,
  /** The Memory page warns from here (§6.5). */
  warnAt: 180,
  candidatesPerProject: 50,
  openPerTask: 5,
  closedPerProject: 200,
  pinnedPerProject: 5,
  clueText: 600,
  clueMin: 15,
  cluesPerTask: 30,
  /** Kept after a successful review, for a manual rerun (§4.0). */
  clueDays: 30,
  /** §6.2: at most this many entries and characters in a session's first instructions. */
  injectEntries: 8,
  injectChars: 2400,
  lineBody: 200,
  recallDefault: 5,
  recallMax: 10,
  /** §6.5 */
  staleDays: 60,
  widelyUsedCards: 5,
  widelyUsedDays: 30,
  usedByKept: 20,
} as const;

const text = (max: number) => z.string().trim().max(max);
export const memoryTagsSchema = z.array(z.string().trim().min(1).max(32)).max(memoryLimits.tags);
export const memoryKeywordsSchema = z.array(z.string().trim().min(1).max(memoryLimits.keyword)).max(memoryLimits.keywords);

export const memoryEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(memoryKinds),
  title: text(memoryLimits.title).min(1),
  body: text(memoryLimits.body),
  tags: memoryTagsSchema,
  keywords: memoryKeywordsSchema,
  pinned: z.boolean(),
  status: z.enum(memoryStatuses),
  archivedReason: z.enum(["retired", "promoted", "superseded"]).optional(),
  /** The active entry a candidate replaces when confirmed. */
  supersedes: z.string().optional(),
  /** The finished-card review's quote of what it based the candidate on (§4.2). */
  evidence: text(memoryLimits.evidence).optional(),
  source: z.object({
    by: z.enum(["agent", "retro", "human"]),
    taskId: z.string().optional(),
    agentId: z.string().optional(),
    /** The card event the agent's proposal wrote; makes the write idempotent (§4.1). */
    eventId: z.string().optional(),
  }),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().optional(),
  usedAt: z.string().optional(),
  /** The latest distinct cards that used it, newest last. */
  usedBy: z.array(z.object({ taskId: z.string(), at: z.string() })).optional(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const memoryClueSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  at: z.string(),
  kind: z.enum(["answer", "feedback", "message"]),
  ask: z.string().max(memoryLimits.clueText).optional(),
  text: z.string().max(memoryLimits.clueText),
});
export type MemoryClue = z.infer<typeof memoryClueSchema>;

export const memoryErrorSchema = z.object({ taskId: z.string(), projectId: z.string(), at: z.string(), message: z.string() });
export const memoryRetroSchema = z.object({ taskId: z.string(), at: z.string(), summaryId: z.string().optional(), clueAt: z.string().optional() });

export const memoryStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(memoryEntrySchema),
  errors: z.array(memoryErrorSchema),
  retros: z.array(memoryRetroSchema),
  recallStats: z.record(z.string(), z.object({ days: z.record(z.string(), z.object({ queries: z.number(), empty: z.number() })) })),
  clues: z.array(memoryClueSchema),
});
export type MemoryState = z.infer<typeof memoryStateSchema>;
export const emptyMemoryState = (): MemoryState => ({ version: 1, revision: 0, entries: [], errors: [], retros: [], recallStats: {}, clues: [] });

export const memoryInputFields = {
  kind: z.enum(memoryKinds),
  title: z.string().trim().min(1).max(memoryLimits.title),
  body: z.string().trim().max(memoryLimits.body),
  tags: memoryTagsSchema.default([]),
  keywords: memoryKeywordsSchema.default([]),
};

export const titleKey = (title: string) => title.trim().toLowerCase();

/**
 * Credentials never belong in memory (§4.1 MEMORY_SECRET). The patterns of the
 * workflow-insights redaction, plus common token prefixes; a long run of
 * characters counts unless it is a hex commit id.
 */
export function containsSecret(value: string): boolean {
  if (/(Authorization:\s*(?:Bearer|Basic|token))\s+\S{8,}/i.test(value)) return true;
  if (/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"'<>]{8,}/i.test(value)) return true;
  if (/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/.test(value))
    return true;
  for (const run of value.match(/[A-Za-z0-9_+=-]{40,}/g) || []) if (!/^[0-9a-f]+$/i.test(run) && /\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  return false;
}

// ---- Relevance (§6.2) -------------------------------------------------------------

const STOP = new Set(
  "the and for with this that from into when then than are was were has have had not but you your our its can will should would could also only more most some any all each one two use used using card cards task tasks make made add added new old via per about after before over under out off flowly".split(" "),
);

/** Lowercase ASCII words of 3+ characters (minus stop words) and CJK character pairs. */
export function terms(value: string): Set<string> {
  const out = new Set<string>();
  const lower = value.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  for (const run of lower.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export type MemoryQuery = { text: string; tags?: readonly string[] };

/** §6.2: +3 per shared tag; +1 per shared word (at most +4); +2 per query word that is one of the entry's keywords. */
export function memoryScore(entry: Pick<MemoryEntry, "title" | "body" | "tags" | "keywords">, query: MemoryQuery, queryTerms = terms(query.text)): number {
  const tags = new Set((query.tags || []).map((t) => t.toLowerCase()));
  let score = entry.tags.filter((t) => tags.has(t.toLowerCase())).length * 3;
  const keywordTerms = terms(entry.keywords.join(" "));
  let shared = 0;
  for (const term of terms(`${entry.title} ${entry.tags.join(" ")} ${entry.body.slice(0, 300)}`)) if (queryTerms.has(term)) shared++;
  score += Math.min(shared, 4);
  for (const term of keywordTerms) if (queryTerms.has(term)) score += 2;
  return score;
}

const kindOrder: Record<MemoryKind, number> = { decision: 0, convention: 1, pitfall: 2, contact: 3 };
const byConfirmed = (a: MemoryEntry, b: MemoryEntry) => (b.confirmedAt || b.createdAt).localeCompare(a.confirmedAt || a.createdAt);

export const memoryKindLabel: Record<MemoryKind, string> = { decision: "Decision", convention: "Convention", pitfall: "Pitfall", contact: "Contact" };

/** One injected line (§6.1). */
export function memoryLine(entry: MemoryEntry, sourceTitle?: string): string {
  const body = entry.body.replace(/\s+/g, " ").trim();
  const short = body.length > memoryLimits.lineBody ? `${body.slice(0, memoryLimits.lineBody - 1)}…` : body;
  return `- [${memoryKindLabel[entry.kind]}] ${entry.title}${short ? `: ${short}` : ""} (memory ${entry.id.slice(0, 8)}${sourceTitle ? `, from "${sourceTitle}"` : ""})`;
}

export type MemorySelection = { entries: MemoryEntry[]; total: number; all: boolean };

/**
 * The entries a card's session sees (§6.2). All of them when they fit the
 * budget; otherwise pinned ones first, then by relevance (score ≥ 2), newest
 * confirmed first on a tie, until the budget is used. Unrelated entries are not
 * added to fill it.
 */
export function memoryForTask(
  entries: readonly MemoryEntry[],
  card: { title: string; description: string; tags?: readonly string[] },
  titleOf: (taskId: string | undefined) => string | undefined = () => undefined,
  budget: { entries: number; chars: number } = { entries: memoryLimits.injectEntries, chars: memoryLimits.injectChars },
): MemorySelection {
  const active = entries.filter((e) => e.status === "active");
  const lineLength = (e: MemoryEntry) => memoryLine(e, titleOf(e.source.taskId)).length + 1;
  const ordered = [...active].sort((a, b) => Number(b.pinned) - Number(a.pinned) || kindOrder[a.kind] - kindOrder[b.kind] || byConfirmed(a, b));
  const allChars = ordered.reduce((n, e) => n + lineLength(e), 0);
  if (ordered.length <= budget.entries && allChars <= budget.chars) return { entries: ordered, total: active.length, all: true };
  const query = { text: `${card.title}\n${card.description.slice(0, 2000)}`, tags: card.tags };
  const queryTerms = terms(query.text);
  const pinned = active.filter((e) => e.pinned).sort(byConfirmed);
  const scored = active
    .filter((e) => !e.pinned)
    .map((e) => ({ e, score: memoryScore(e, query, queryTerms) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || byConfirmed(a.e, b.e))
    .map((x) => x.e);
  const out: MemoryEntry[] = [];
  let chars = 0;
  for (const e of [...pinned, ...scored]) {
    if (out.length >= budget.entries) break;
    const n = lineLength(e);
    if (chars + n > budget.chars) continue;
    out.push(e);
    chars += n;
  }
  return { entries: out, total: active.length, all: false };
}

/** The block in a session's first instructions (§6.1); empty when nothing is selected. */
export function memoryContextLines(selection: MemorySelection, titleOf: (taskId: string | undefined) => string | undefined = () => undefined): string[] {
  if (!selection.entries.length) return [];
  const shown = selection.entries.length;
  const header = selection.all
    ? `Project memory (all ${shown} entries):`
    : `Project memory (${shown} of ${selection.total} shown, flowly_recall finds the others):`;
  return [header, ...selection.entries.map((e) => memoryLine(e, titleOf(e.source.taskId)))];
}

/** flowly_recall (§6.4): by relevance to `query`; an empty query gives the latest confirmed. */
export function recallMemory(entries: readonly MemoryEntry[], input: { query: string; kind?: MemoryKind; limit?: number }): { entries: MemoryEntry[]; total: number } {
  const active = entries.filter((e) => e.status === "active" && (!input.kind || e.kind === input.kind));
  const limit = Math.min(input.limit ?? memoryLimits.recallDefault, memoryLimits.recallMax);
  if (!input.query.trim()) return { entries: [...active].sort(byConfirmed).slice(0, limit), total: active.length };
  const queryTerms = terms(input.query);
  return {
    entries: active
      .map((e) => ({ e, score: memoryScore(e, { text: input.query }, queryTerms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || byConfirmed(a.e, b.e))
      .slice(0, limit)
      .map((x) => x.e),
    total: active.length,
  };
}

// ---- Lifecycle hints (§6.5) --------------------------------------------------------

const DAY = 86_400_000;
/** Active, not pinned, unused for 60 days (counted from confirmation when never used). */
export function isStale(entry: MemoryEntry, now: number): boolean {
  if (entry.status !== "active" || entry.pinned) return false;
  const last = Date.parse(entry.usedAt || entry.confirmedAt || entry.createdAt);
  return now - last >= memoryLimits.staleDays * DAY;
}
/** Distinct cards that used it in the last 30 days. */
export function recentCards(entry: MemoryEntry, now: number): number {
  return new Set((entry.usedBy || []).filter((u) => now - Date.parse(u.at) <= memoryLimits.widelyUsedDays * DAY).map((u) => u.taskId)).size;
}
export const isWidelyUsed = (entry: MemoryEntry, now: number) => entry.status === "active" && !entry.pinned && recentCards(entry, now) >= memoryLimits.widelyUsedCards;
/** Make room (§6.5): the five longest-unused, not pinned, active entries. */
export function leastUsed(entries: readonly MemoryEntry[], projectId: string, n = 5): MemoryEntry[] {
  const last = (e: MemoryEntry) => e.usedAt || e.confirmedAt || e.createdAt;
  return entries
    .filter((e) => e.projectId === projectId && e.status === "active" && !e.pinned)
    .sort((a, b) => last(a).localeCompare(last(b)))
    .slice(0, n);
}
/** Records that a card used these entries; at most 20 distinct cards, the latest kept. */
export function noteUse(entry: { usedAt?: string; usedBy?: { taskId: string; at: string }[] }, taskId: string, at: string) {
  entry.usedAt = at;
  const list = (entry.usedBy || []).filter((u) => u.taskId !== taskId);
  list.push({ taskId, at });
  entry.usedBy = list.slice(-memoryLimits.usedByKept);
}
/** "- Title: body", for pasting into AGENTS.md (§5.4). */
export const agentsRule = (entry: Pick<MemoryEntry, "title" | "body">) => `- ${entry.title.trim()}${entry.body.trim() ? `: ${entry.body.trim().replace(/\s*\n\s*/g, " ")}` : ""}`;

// ---- Clues (§4.0) ------------------------------------------------------------------

/** The user's own words worth keeping for the review, or null (short, a picked suggestion, a secret). */
export function clueText(value: string, picked: readonly string[] = [], min: number = memoryLimits.clueMin): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < min) return null;
  if (picked.some((p) => p.trim() === trimmed)) return null;
  if (containsSecret(trimmed)) return null;
  return trimmed.length > memoryLimits.clueText ? `${trimmed.slice(0, memoryLimits.clueText - 1)}…` : trimmed;
}
/** Keeps the card's first clue (its original request) and the latest others, 30 in all. */
export function trimClues(clues: MemoryClue[], taskId: string): MemoryClue[] {
  const own = clues.filter((c) => c.taskId === taskId);
  if (own.length <= memoryLimits.cluesPerTask) return clues;
  const keep = new Set([own[0], ...own.slice(own.length - (memoryLimits.cluesPerTask - 1))]);
  return clues.filter((c) => c.taskId !== taskId || keep.has(c));
}

/** A turn's timeline item as the `agent.turn_ended` hook passes it; only the fields read here. */
export type TurnItem = { type?: unknown; text?: unknown; name?: unknown; callId?: unknown; status?: unknown; detail?: unknown; metadata?: unknown };
export type QuestionAnswer = { id: string; ask: string; text: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** The text a Codex async question's answers arrive with as the next user message (Paseo's CodexAsyncQuestions). */
export const CODEX_ANSWERS_PREFIX = "Answers to your questions:";

/** `"question"="answer"` pairs of a Claude AskUserQuestion result, whatever sentence wraps them. */
function quotedPairs(output: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const m of output.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) pairs.set(m[1].replace(/\\(.)/g, "$1"), m[2].replace(/\\(.)/g, "$1"));
  return pairs;
}

/**
 * The questions the user answered through a native question tool in this turn (§4.0), as checked on
 * real timelines on 2026-10-22:
 * - Claude `AskUserQuestion`: a completed tool call; questions in `detail.input.questions`, answers in
 *   `detail.output` as `"question"="answer"` pairs (the sentence around them differs by Claude Code version).
 * - Codex `request_user_input` (sync): a completed tool call with `metadata.questions` and `metadata.answers` by question id.
 * - Codex `request_user_input_async`: the turn only asks; the answers come back as a user message starting
 *   with "Answers to your questions:" and one "title\nanswer" block per question. Its own tool call is skipped:
 *   answered and still-open calls render alike.
 * Dismissed or failed questions give nothing.
 */
export function questionAnswers(items: readonly TurnItem[]): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  items.forEach((item, index) => {
    const callId = str(item.callId) || `item-${index}`;
    if (item.type === "tool_call" && item.name === "AskUserQuestion" && item.status === "completed" && isRecord(item.detail)) {
      const input = isRecord(item.detail.input) ? item.detail.input : {};
      const output = item.detail.output;
      const text = typeof output === "string" ? output : isRecord(output) ? str(output.output) || JSON.stringify(output) : "";
      const pairs = quotedPairs(text);
      const byHeader = isRecord(input.answers) ? input.answers : {};
      (Array.isArray(input.questions) ? input.questions : []).forEach((q, i) => {
        if (!isRecord(q)) return;
        const question = str(q.question).trim();
        const answer = (pairs.get(question) ?? str(byHeader[str(q.header)])).trim();
        if (question && answer) out.push({ id: `${callId}:${i}`, ask: question, text: answer });
      });
    } else if (item.type === "tool_call" && item.name === "request_user_input" && item.status === "completed" && isRecord(item.metadata)) {
      const answers = isRecord(item.metadata.answers) ? item.metadata.answers : {};
      (Array.isArray(item.metadata.questions) ? item.metadata.questions : []).forEach((q, i) => {
        if (!isRecord(q)) return;
        const values = answers[str(q.id)];
        const answer = (Array.isArray(values) ? values.filter((v) => typeof v === "string").join(", ") : str(values)).trim();
        const question = (str(q.question) || str(q.header)).trim();
        if (question && answer) out.push({ id: `${callId}:${i}`, ask: question, text: answer });
      });
    } else if (item.type === "user_message" && str(item.text).trimStart().startsWith(CODEX_ANSWERS_PREFIX)) {
      str(item.text)
        .trimStart()
        .slice(CODEX_ANSWERS_PREFIX.length)
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .forEach((block, i) => {
          const lines = block.split("\n");
          const answer = lines.pop()!.trim();
          const question = lines.join("\n").trim();
          if (question && answer) out.push({ id: `${callId}:${i}`, ask: question, text: answer });
        });
    }
  });
  return out;
}

/** An answer clue's text: short is fine (the question gives it context), secrets and empty ones are not. */
export function answerText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || containsSecret(trimmed)) return null;
  return trimmed.length > memoryLimits.clueText ? `${trimmed.slice(0, memoryLimits.clueText - 1)}…` : trimmed;
}

// ---- Finished-card review (§4.2) ---------------------------------------------------

export const RETRO_INPUT_LIMIT = 10000;
export const RETRO_CLUES_LIMIT = 5000;
/** The project root's AGENTS.md / CLAUDE.md, outside RETRO_INPUT_LIMIT so the card material is never cut for them. */
export const RETRO_INSTRUCTIONS_LIMIT = 20000;
export const RETRO_DELAY_MS = 30_000;
export const RETRO_SUMMARY_WAIT_MS = 120_000;
export const RETRO_TIMEOUT_MS = 120_000;
export const RETRO_LABEL = { "flowly-memory": "retro" } as const;
/** One per card at most: the first five reviews on Flowly gave 1.8 each and the user kept 1 of 7 (§4.2). */
export const RETRO_MAX_CANDIDATES = 1;

export const retroJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: RETRO_MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "body", "tags", "keywords", "evidence", "reuse"],
        properties: {
          kind: { type: "string", enum: [...memoryKinds] },
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          reuse: { type: "string" },
          supersedes: { type: "string" },
        },
      },
    },
  },
} as const;

export type RetroMaterial = {
  project: string;
  card: { title: string; type?: string; tags: readonly string[]; description: string };
  clues: readonly MemoryClue[];
  summary?: { target: string; recap: string; next: string };
  /** Recap lines of every summary version, deduplicated, oldest first. */
  recapLines: readonly string[];
  states: readonly string[];
  failedChecks: readonly string[];
  reports: readonly string[];
  existing: readonly { id: string; kind: MemoryKind; title: string }[];
  /** Suggestions still waiting for the user. */
  waiting?: readonly { kind: MemoryKind; title: string }[];
  /** Suggestions the user dismissed, newest first: what this project does not want remembered. */
  dismissed?: readonly { kind: MemoryKind; title: string }[];
  /** The project root's instruction files, so the review does not suggest a rule already written there. */
  instructions?: string;
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Builds the review input, at most RETRO_INPUT_LIMIT characters; answers win when clues must be cut. */
export function retroMaterial(m: RetroMaterial): string {
  const clues = [...m.clues];
  const clueBlock = () => clues.map((c) => (c.kind === "answer" && c.ask ? `[answer] Q: ${clip(c.ask, 200)}\nA: ${c.text}` : `[${c.kind}] ${c.text}`)).join("\n");
  while (clues.length && clueBlock().length > RETRO_CLUES_LIMIT) {
    const drop = clues.findIndex((c) => c.kind !== "answer");
    clues.splice(drop >= 0 ? drop : 0, 1);
  }
  const parts = [
    `# Project\n${m.project}`,
    `# Card\nTitle: ${m.card.title}${m.card.type ? `\nType: ${m.card.type}` : ""}${m.card.tags.length ? `\nTags: ${m.card.tags.join(", ")}` : ""}\nDescription:\n${clip(m.card.description, 2000) || "(none)"}`,
    `# The user's own messages on this card\n${clueBlock() || "(none)"}`,
    `# Latest progress summary\n${m.summary ? `Target: ${m.summary.target}\nRecap:\n${m.summary.recap}\nNext: ${m.summary.next}` : "(none)"}`,
    `# Every recap line the summary ever had\n${m.recapLines.map((l) => `- ${l}`).join("\n") || "(none)"}`,
    `# Earlier states\n${m.states.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `# Checks that failed in the latest auto review\n${m.failedChecks.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `# Agent questions, blockers and results\n${m.reports.map((s) => `- ${clip(s, 500)}`).join("\n") || "(none)"}`,
    `# Existing project memory (do not repeat; use supersedes to replace one)\n${m.existing.map((e) => `- ${e.id} [${e.kind}] ${e.title}`).join("\n") || "(none)"}`,
    `# Suggestions already waiting for the user (do not repeat)\n${(m.waiting || []).map((e) => `- [${e.kind}] ${e.title}`).join("\n") || "(none)"}`,
    `# Suggestions the user dismissed (this project does not want these or anything of the same sort)\n${(m.dismissed || []).map((e) => `- [${e.kind}] ${e.title}`).join("\n") || "(none)"}`,
  ];
  const material = clip(parts.join("\n\n"), RETRO_INPUT_LIMIT);
  const rules = m.instructions?.trim();
  return rules ? `${material}\n\n# The repository's instruction files (rules already written down: do not suggest any of them)\n${clip(rules, RETRO_INSTRUCTIONS_LIMIT)}` : material;
}

export function retroPrompt(material: string, language: LocaleCode): string {
  return `You review a finished task card of a software project and pick out what the project should remember for its OTHER, LATER cards. A person confirms each suggestion before it is used and dismisses most of them, so the default answer is none: {"candidates": []}. Suggest at most one, and only when it clearly passes the test below. Do not use any tools.

The test: project memory is for knowledge that holds across the project, not for this card. Name a later card about a DIFFERENT feature or area whose agent would go wrong without it (write it in reuse, e.g. "any card that opens a dialog from another dialog"). If the only cards you can name work on the same feature, file, bug or design as this one, it fails: that knowledge lives in this card's code and summary. How this card's own feature was designed or built is not project memory, even when the user decided it.

Kinds of knowledge that can pass:
1. decision: will a later card's agent ask the user the same question again? Record the choice the user made and why, including an option the user rejected ("not X, because Y").
2. pitfall: was there a dead end (something tried or looked into that does not work, "checked, there is no better way, do not look again"), or a general lesson behind a bug that was fixed? Write the lesson, not the fix.
3. convention: how does the user want work done in this project, beyond what the repository says?
4. contact: people, external systems and environments (who reviews, which test environment, where a token is kept). Never the secret itself.

Do not suggest:
- this card's own progress or results (that is the card's summary);
- open questions, plans or "later" items (those are ideas or new cards);
- what the code, git history or docs already say, or rules the repository's instruction files (AGENTS.md, CLAUDE.md) already contain;
- anything already in the existing project memory below, unless it replaces an entry: then set supersedes to that entry's id. An entry about the same problem counts as already there, even in other words or with more detail;
- anything like a suggestion the user dismissed before (listed below), or one already waiting for the user.

Fields: kind; title (at most 120 characters, the rule or fact itself); body (at most 1000 characters: what and why, or symptom and how to avoid it); tags (at most 4 short lowercase area words, reuse the card's); keywords (at most 12 search words: synonyms, the English and the user's-language name, file or module names); evidence (at most 300 characters: quote the line of the material it is based on); reuse (the later card on a different feature that needs it). At most ${RETRO_MAX_CANDIDATES} candidate.

${outputLanguageRule(language)}

Answer with JSON only: {"candidates": [...]}.

${material}`;
}

const listOf = z
  .union([z.array(z.string()), z.string()])
  .nullish()
  .transform((v) => (Array.isArray(v) ? v : (v || "").split(/[,\n]/)).map((s) => s.trim()).filter(Boolean));
const retroCandidate = z.object({
  kind: z.enum(memoryKinds),
  title: z.string(),
  body: z.union([z.string(), z.array(z.string()).transform((v) => v.join("\n"))]).nullish().transform((v) => v || ""),
  tags: listOf,
  keywords: listOf,
  evidence: z.string().nullish().transform((v) => v || ""),
  reuse: z.string().nullish().transform((v) => (v || "").trim()),
  supersedes: z.string().nullish(),
});
export type RetroCandidate = z.infer<typeof retroCandidate>;

/** Tolerates fences and prose around the JSON, a bare array, and lists given as strings. */
export function parseRetroOutput(value: string | null | undefined): RetroCandidate[] {
  if (!value) throw new Error("The review model returned nothing.");
  const trimmed = value.trim();
  let raw: unknown;
  try {
    const json = trimmed.startsWith("[") ? trimmed.slice(0, trimmed.lastIndexOf("]") + 1) : firstObject(trimmed);
    if (!json) throw new Error("no json");
    raw = JSON.parse(json);
  } catch {
    throw new Error("The review model returned no JSON.");
  }
  const list = Array.isArray(raw) ? raw : (raw as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) throw new Error("The review model's output did not match the schema.");
  return list.flatMap((item) => {
    const parsed = retroCandidate.safeParse(item);
    // A candidate that names no later card on another feature failed the generality test (§4.2).
    return parsed.success && parsed.data.title.trim() && parsed.data.reuse ? [parsed.data] : [];
  }).slice(0, RETRO_MAX_CANDIDATES);
}

/** A candidate cut to the stored limits. */
export function fitCandidate(c: RetroCandidate) {
  return {
    kind: c.kind,
    title: clip(c.title.trim(), memoryLimits.title),
    body: clip(c.body.trim(), memoryLimits.body),
    tags: [...new Set(c.tags.map((t) => t.toLowerCase().replace(/[^a-z0-9./-]+/g, "-").replace(/^-+|-+$/g, "")).filter(Boolean))].slice(0, memoryLimits.tags),
    keywords: [...new Set(c.keywords.map((k) => clip(k, memoryLimits.keyword)))].slice(0, memoryLimits.keywords),
    evidence: clip(c.evidence.trim(), memoryLimits.evidence),
    ...(c.supersedes ? { supersedes: c.supersedes } : {}),
  };
}
