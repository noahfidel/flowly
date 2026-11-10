import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { outputLanguageRule } from "./ai-language";
import type { LocaleCode } from "./i18n";

/** Task progress summaries written after each agent turn (TASK-SUMMARY-SPEC). */
export const SUMMARY_VERSIONS = 50;
export const TRANSCRIPT_LIMIT = 12000;
export const TRANSCRIPT_HEAD = 3000;
export const DESCRIPTION_LIMIT = 2000;
/**
 * Brevity comes from the prompt; text is never cut. This is only a storage
 * safety bound: longer output is rejected as an error, not trimmed.
 */
export const FIELD_LIMIT = 4000;
/** Summarizer sessions run as children of the card's session and carry this label; board views hide them. */
export const SUMMARIZER_LABELS = { flowly: "summarizer" } as const;
export const isSummarizer = (agent: { labels?: Record<string, string> | null }) =>
  agent.labels?.flowly === "summarizer" ||
  agent.labels?.["ultra-kanban"] === "summarizer"; // Existing helper sessions.
export const AUTO_MODELS = ["claude/claude-haiku-5-5", "codex/gpt-6-luna"] as const;

export const summaryFields = z.object({
  state: z.string().max(FIELD_LIMIT),
  /** Goal and feature points of the task; versions written before it existed read as "". */
  target: z.string().max(FIELD_LIMIT).default(""),
  recap: z.string().max(FIELD_LIMIT),
  next: z.string().max(FIELD_LIMIT),
});
export const summaryEntrySchema = summaryFields.extend({
  id: z.string(),
  taskId: z.string(),
  at: z.string(),
  model: z.string(),
  agentIds: z.array(z.string()),
});
export const summaryErrorSchema = z.object({
  taskId: z.string(),
  at: z.string(),
  message: z.string().max(500),
});
export const summaryStateSchema = z.object({
  version: z.literal(1),
  entries: z.array(summaryEntrySchema),
  errors: z.array(summaryErrorSchema),
});
export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type SummaryError = z.infer<typeof summaryErrorSchema>;
export type SummaryState = z.infer<typeof summaryStateSchema>;
export const emptySummaries = (): SummaryState => ({ version: 1, entries: [], errors: [] });

/** What the board needs: the latest version per card, runs in flight, last error per card. */
export const summaryOverviewSchema = z.object({
  latest: z.array(summaryEntrySchema),
  running: z.array(z.string()),
  errors: z.array(summaryErrorSchema),
  enabled: z.boolean(),
});
export type SummaryOverview = z.infer<typeof summaryOverviewSchema>;

export const summaryModelsSchema = z.array(z.string().trim().regex(/^[^/\s]+\/[^\s]+$/, "Expected provider/model")).min(1)
  .refine((models) => new Set(models).size === models.length, "Summary models must be unique.");
export type SummaryModelChoice = string | readonly string[];

export const summarySettings = defineSettings({
  id: "task-summary",
  scope: "host",
  version: 1,
  schema: z.object({
    summaryEnabled: z.boolean().default(true),
    /** `provider/model`; empty tries available AUTO_MODELS in order. */
    summaryModel: z.string().max(200).default(""),
    /** Ordered fallback list; absent preserves legacy Auto/single-model settings. */
    summaryModels: summaryModelsSchema.optional(),
    /** Generate a past day's project digest when Insights opens it (PROJECT-INSIGHTS-SPEC §7). */
    digestEnabled: z.boolean().default(true),
    /** Review cards moved into Done for project memory candidates (PROJECT-MEMORY-SPEC §4.2, §9). */
    retroEnabled: z.boolean().default(true),
    /** `provider/model` of the auto review session (AUTO-REVIEW-SPEC §12.4); empty: the project's default model, then the summary models. */
    reviewModel: z.string().max(200).optional(),
  }),
});
export type SummarySettings = z.infer<typeof summarySettings.schema>;
/** Effective list, with no write-on-read migration of legacy settings. */
export function summaryModelsOf(settings?: Pick<SummarySettings, "summaryModel" | "summaryModels"> | null): string[] {
  return settings?.summaryModels ? [...settings.summaryModels] : settings?.summaryModel ? [settings.summaryModel] : [...AUTO_MODELS];
}

/**
 * A mode in which a temporary session (summarizer, reviewer, memory review, digest, workflow insights) cannot run tools
 * or edit, so it never stops on a permission prompt: Claude's Plan Mode. That covers `claude` and the Claude Code profiles
 * named `claude-*` (for example `claude-compass-smith-sqp`), which carry the same modes. Other providers have no read-only
 * mode and keep their default (never full access in the card's workspace).
 */
export function readOnlyMode(model: string): string | undefined {
  const provider = model.split("/")[0];
  return provider === "claude" || provider.startsWith("claude-") ? "plan" : undefined;
}
/** `config` for a temporary session on `provider/model`, in its read-only mode when the provider has one. */
export function readOnlyConfig(model: string): { provider: string; modeId?: string } {
  const modeId = readOnlyMode(model);
  return modeId ? { provider: model, modeId } : { provider: model };
}

/** Stored values may predate fields; the host does not apply schema defaults. */
export function summarySettingsValues(values: unknown): SummarySettings {
  const parsed = summarySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : summarySettings.schema.parse({});
}

/** JSON Schema handed to the summarizer session; mirrors `modelOutput`. */
export const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["update", "state", "target", "recap", "next"],
  properties: {
    update: { type: "boolean" },
    state: { type: "string" },
    target: { type: "string" },
    recap: { type: "string" },
    next: { type: "string" },
  },
} as const;

/** On a rework turn the summarizer also says whether the user corrected the delivered work (GUARDRAILS-SPEC §4.2). */
export const reworkOutputJsonSchema = {
  ...outputJsonSchema,
  required: [...outputJsonSchema.required, "correction"],
  properties: {
    ...outputJsonSchema.properties,
    correction: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["none", "new", "same"] }, text: { type: "string" }, matches: { type: "string" } },
    },
  },
} as const;

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
// Lenient: small models sometimes omit fields when not updating, or quote the boolean.
// Claude does not enforce outputSchema: lists come back as arrays of bullet strings.
const text = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .transform((s) => (Array.isArray(s) ? s.map((line) => `- ${line.trim().replace(/^[-*•]\s*/, "")}`).join("\n") : s || "").trim())
  .refine((s) => s.length <= FIELD_LIMIT, "too long");
const modelOutput = z.object({
  update: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]),
  state: text,
  target: text.transform(targetText),
  recap: text,
  next: text,
});
export type ModelOutput = z.infer<typeof modelOutput>;

/** The Target heading already says it: drop a leading "Goal:" / "目标：" label (also on older versions). */
export function targetText(text: string): string {
  return text.replace(/^\s*(?:-\s*)?(?:goal|目标)\s*[:：]\s*/i, "");
}

/** First balanced JSON object in `text` (tolerates fences and surrounding prose). */
export function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseModelOutput(text: string | null | undefined): ModelOutput {
  const json = text ? firstObject(text) : null;
  if (!json) throw new Error("The summary model returned no JSON.");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The summary model returned invalid JSON.");
  }
  const parsed = modelOutput.safeParse(raw);
  if (!parsed.success) throw new Error("The summary model's output did not match the schema.");
  if (parsed.data.update && !parsed.data.state) throw new Error("The summary model returned an empty state.");
  return parsed.data;
}

type TimelineItem = { type: string; text?: unknown; name?: unknown; message?: unknown };

/** A turn's timeline as plain dialogue: messages kept, tool calls reduced to names. */
export function turnText(items: readonly TimelineItem[]): string {
  const lines: string[] = [];
  let tools: string[] = [];
  const flush = () => {
    if (!tools.length) return;
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    lines.push("Tools: " + [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", "));
    tools = [];
  };
  for (const item of items) {
    if (item.type === "tool_call") {
      tools.push(typeof item.name === "string" && item.name ? item.name : "tool");
      continue;
    }
    flush();
    if (item.type === "user_message" && typeof item.text === "string" && item.text.trim())
      lines.push("User: " + item.text.trim());
    else if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim())
      lines.push("Assistant: " + item.text.trim());
    else if (item.type === "error" && typeof item.message === "string")
      lines.push("Error: " + item.message.trim());
  }
  flush();
  return lines.join("\n\n");
}

/** Keeps the head (the request) and the tail (the outcome) of an over-long transcript. */
export function truncateTranscript(text: string, limit = TRANSCRIPT_LIMIT, head = TRANSCRIPT_HEAD): string {
  if (text.length <= limit) return text;
  const marker = "\n\n[… earlier part of the conversation omitted …]\n\n";
  return text.slice(0, head) + marker + text.slice(text.length - (limit - head - marker.length));
}

/**
 * The last turn in a fetched timeline tail: from the last user message on.
 * Used by manual refresh, which has no hook-provided turn.
 */
export function lastTurn<T extends TimelineItem>(items: readonly T[]): T[] {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === "user_message") return items.slice(i);
  return [...items];
}

export function summaryPrompt(input: {
  title: string;
  description: string;
  lane: string;
  previous: Pick<SummaryEntry, "state" | "target" | "recap" | "next"> | null;
  transcript: string;
  language: LocaleCode;
  /** A rework turn's `Guardrails` lines (GUARDRAILS-SPEC §4.2); absent on every other turn. */
  guardrails?: readonly string[];
}): string {
  return [
    "You keep a short progress summary for a task on a Kanban board. An AI coding agent works on the task in conversation with a person.",
    "Read the latest conversation and decide whether the summary needs updating. Do not use any tools; answer only with the JSON object.",
    "",
    "Rules:",
    '- "update": false when the conversation adds no real progress, decision or change of plan (greetings, thanks, idle questions). Otherwise true.',
    previous(input.previous),
    '- "state": where the task stands now, in one short phrase of at most 15 words (or 30 Chinese characters), e.g. "Implementation done, waiting for tests".',
    '- "target": what the task is for and what it must deliver: first line the goal as a plain sentence with no label (no "Goal:" prefix), then at most 4 "- " lines with the agreed feature points, each at most 15 words (or 30 Chinese characters). Base it on the task description and what the person asked for or approved. Keep it stable; change it only when the scope changes (added, dropped or redefined features). If unchanged, repeat the current target.',
    '- "recap": the outcomes that matter for judging progress across the whole task, not only this turn: at most 4 "- " lines, each at most 15 words (or 30 Chinese characters). Merge or drop older points to stay within 4; keep decisions and results, skip routine steps (reading files, running commands, retries).',
    '- Every value except "update" is a single string, never an array.',
    '- "next": the single next step, or who is being waited on, in one sentence of at most 20 words (or 40 Chinese characters).',
    `- ${outputLanguageRule(input.language)}`,
    "- Be concrete and terse; no filler, no file paths or IDs unless they are the point.",
    ...(input.guardrails ? correctionRules : []),
    "",
    `Task: ${input.title}`,
    input.description ? `Description:\n${clip(input.description, DESCRIPTION_LIMIT)}` : "",
    `Board column: ${input.lane}`,
    "",
    input.previous
      ? `Current summary:\nState: ${input.previous.state}\nTarget: ${input.previous.target || "(not set yet)"}\nRecap: ${input.previous.recap}\nNext: ${input.previous.next}`
      : "Current summary: (none yet)",
    "",
    "Latest conversation:",
    input.transcript || "(empty)",
    ...(input.guardrails ? ["", "Guardrails (what this project already checks; each line: #id, what it is, its text):", ...(input.guardrails.length ? input.guardrails : ["(none)"])] : []),
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
const correctionRules = [
  '- "correction": the user wrote the first message of this conversation after the agent had delivered the task for review. Decide whether the user is correcting the delivered work: something it does wrong, breaks or left out.',
  '  A message saying the delivered change should also, still or should have done something that could have been part of that change is a correction, even when it is short, has no subject or no negation (e.g. "the new endpoint also goes into the README", "new copy also goes into every language catalog").',
  '  Not a correction: work unrelated to the delivered change (another feature, another page), a question, chatting, thanking, or asking to commit, push or merge.',
  '  Not a correction: {"kind": "none"}. The same problem as a line of the Guardrails list below: {"kind": "same", "matches": "<that line\'s #id>", "text": "<that line\'s text, unchanged>"}. Otherwise: {"kind": "new", "text": "<one sentence of at most 120 characters that a reviewer can check on a later delivery, e.g. Every new UI string is in all language catalogs>"}.',
];
const previous = (p: unknown) =>
  p ? "- When updating, revise the current summary rather than starting over." : '- There is no summary yet, so "update" must be true.';

type ModelList = { provider: string; available: boolean; models: { id: string; isSelectable?: boolean }[] }[];

/** The configured model only, or every available Auto candidate in preference order. */
export function resolveModels(configured: SummaryModelChoice, providers: ModelList): string[] {
  const offered = (id: string) => {
    const slash = id.indexOf("/");
    if (slash < 1) return false;
    const provider = providers.find((p) => p.provider === id.slice(0, slash) && p.available);
    return !!provider?.models.some((m) => m.id === id.slice(slash + 1) && m.isSelectable !== false);
  };
  if (Array.isArray(configured)) {
    const found = [...new Set(configured)].filter(offered);
    if (!found.length) throw new Error(`No configured summary model is available: ${configured.join(", ")}.`);
    return found;
  }
  if (typeof configured === "string" && configured) {
    if (!offered(configured)) throw new Error(`Summary model ${configured} is not available.`);
    return [configured];
  }
  const found = AUTO_MODELS.filter(offered);
  if (!found.length) throw new Error("No summary model available: install Claude (Haiku 5.5) or Codex (GPT-6-Luna), or choose a model in settings.");
  return found;
}

/** The configured `provider/model`, or the first available Auto model. */
export function resolveModel(configured: SummaryModelChoice, providers: ModelList): string {
  return resolveModels(configured, providers)[0];
}

/** "claude/claude-haiku-5-5" → "Haiku 5.5"-style short label for footers. */
export function modelLabel(id: string): string {
  const model = id.slice(id.indexOf("/") + 1);
  const known: Record<string, string> = { "gpt-6-luna": "GPT-6-Luna" };
  // "claude-sonnet-5-5" → "Sonnet 5.5"; dated or unknown ids stay as they are.
  const claude = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d))?$/.exec(model);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return known[model] || model;
}
