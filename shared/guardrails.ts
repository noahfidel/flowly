import { z } from "zod";
import { changeSizes, taskTypeSchema, type ChangeSize, type Project, type TaskType } from "./model";
import { firstObject } from "./summary";
import { addDays, dayKey, dayStart } from "./insights";
import {
  containsSecret,
  memoryClueSchema,
  memoryContextLines,
  memoryForTask,
  memoryKeywordsSchema,
  memoryKinds,
  memoryLimits,
  memoryRetroSchema,
  memoryTagsSchema,
  recallMemory,
  type MemoryEntry,
  type MemoryKind,
  type MemoryState,
} from "./memory";

/**
 * Project guardrails (GUARDRAILS-SPEC): the project's check commands, the guidelines learned from what
 * the user sent cards back for, and notes (the former project memory), in `guardrails.json`.
 */

export const guardrailKinds = ["command", "guideline", "note"] as const;
export type GuardrailKind = (typeof guardrailKinds)[number];
export const guardrailStates = ["active", "observing", "paused", "archived"] as const;
export type GuardrailState = (typeof guardrailStates)[number];
export const guardrailBy = ["user", "agent", "retro", "detect", "learned"] as const;
export type GuardrailBy = (typeof guardrailBy)[number];
export const cardItemStates = ["open", "promoted", "closed"] as const;

/** §3.2–§3.4, §4.2, §5.1, §6.2, §6.7. */
export const guardrailLimits = {
  commandName: 80,
  guidelineText: 200,
  noteTitle: memoryLimits.title,
  body: memoryLimits.body,
  args: 30,
  arg: 500,
  minTimeout: 10,
  maxTimeout: 3600,
  stateReason: 200,
  usedBy: memoryLimits.usedByKept,
  sources: 10,
  quote: 300,
  itemText: 200,
  /** §3.4 caps. */
  guidelinesActive: 20,
  commandsLive: 10,
  notesActive: 100,
  pinned: memoryLimits.pinnedPerProject,
  openItemsPerTask: 5,
  archivedPerProject: 300,
  /** §4.2: the summarizer's Guardrails section. */
  sectionLines: 60,
  sectionLine: 120,
  sectionArchivedDays: 90,
  sectionOtherItemsDays: 30,
  correctionText: 120,
  /** §5.1 */
  injectGuidelines: 20,
  /** §6.2 */
  smallLines: 50,
  mediumLines: 400,
  /** §6.7 */
  misfireDays: 30,
  misfirePause: 2,
  neverCaughtReviews: 20,
  missedDays: 90,
  unusedDays: 90,
  /** §4.5 */
  observeReviews: 3,
  unavailableRun: 3,
  misfiresKept: 10,
} as const;

const DAY = 86_400_000;
const iso = z.string();

export const sizeSchema = z.enum(changeSizes);
export const guardrailScopeSchema = z.object({
  types: z.union([z.literal("all"), z.array(taskTypeSchema).max(taskTypeSchema.options.length)]),
  sizes: z.union([z.literal("all"), z.array(sizeSchema).max(changeSizes.length)]),
});
export type GuardrailScope = z.infer<typeof guardrailScopeSchema>;
/** A card's shape for scope checks: its type and the size of its latest delivery; either may be unknown. */
export type CardShape = { type?: TaskType; size?: ChangeSize };
export const cardShapeSchema = z.object({ type: taskTypeSchema.optional(), size: sizeSchema.optional() });

export const guardrailCountsSchema = z.object({
  reviews: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative(),
  caught: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
  misfire: z.number().int().nonnegative(),
  lastCaughtAt: iso.optional(),
  lastMissedAt: iso.optional(),
  /** When the latest misfires happened, for "misfired twice in 30 days" (§6.7). */
  misfireAt: z.array(iso).max(guardrailLimits.misfiresKept).optional(),
  /** Commands: consecutive reviews it could not run (§4.5). */
  unavailableRun: z.number().int().nonnegative().optional(),
  /** Notes: the latest distinct cards that used it, newest last (as PROJECT-MEMORY-SPEC §3.2). */
  usedBy: z.array(z.object({ taskId: z.string(), at: iso })).max(guardrailLimits.usedBy),
  usedAt: iso.optional(),
});
export type GuardrailCounts = z.infer<typeof guardrailCountsSchema>;
export const emptyCounts = (): GuardrailCounts => ({ reviews: 0, passes: 0, caught: 0, missed: 0, misfire: 0, usedBy: [] });

export const guardrailSourceSchema = z.object({ taskId: z.string(), at: iso, quote: z.string().max(guardrailLimits.quote).optional() });

export const guardrailEntrySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.enum(guardrailKinds),
    /** Command: its name; guideline: one checkable sentence; note: its title. */
    text: z.string().trim().min(1).max(guardrailLimits.guidelineText),
    body: z.string().trim().max(guardrailLimits.body).optional(),
    argv: z.array(z.string().min(1).max(guardrailLimits.arg)).min(1).max(guardrailLimits.args).optional(),
    timeoutSec: z.number().int().min(guardrailLimits.minTimeout).max(guardrailLimits.maxTimeout).optional(),
    observe: z.object({ reviews: z.number().int().nonnegative(), passed: z.number().int().nonnegative() }).optional(),
    scope: guardrailScopeSchema.optional(),
    noteKind: z.enum(memoryKinds).optional(),
    tags: memoryTagsSchema.optional(),
    keywords: memoryKeywordsSchema.optional(),
    pinned: z.boolean().optional(),
    state: z.enum(guardrailStates),
    stateReason: z.string().max(guardrailLimits.stateReason).optional(),
    stateAt: iso,
    counts: guardrailCountsSchema,
    /** Source cards and the user's words; a note's retro evidence is its source's quote. */
    sources: z.array(guardrailSourceSchema).max(guardrailLimits.sources),
    /** A note's provenance, as the former MemoryEntry.source; `eventId` makes an agent's write idempotent. */
    source: z.object({ taskId: z.string().optional(), agentId: z.string().optional(), eventId: z.string().optional() }).optional(),
    by: z.enum(guardrailBy),
    supersedes: z.string().optional(),
    supersededBy: z.string().optional(),
    revision: z.number().int().positive(),
    createdAt: iso,
    updatedAt: iso,
  })
  .superRefine((e, ctx) => {
    const max = e.kind === "command" ? guardrailLimits.commandName : e.kind === "note" ? guardrailLimits.noteTitle : guardrailLimits.guidelineText;
    if (e.text.length > max) ctx.addIssue({ code: "custom", path: ["text"], message: `At most ${max} characters.` });
    if (e.kind === "command" && !e.argv) ctx.addIssue({ code: "custom", path: ["argv"], message: "A command needs argv." });
    if (e.kind === "note" && !e.noteKind) ctx.addIssue({ code: "custom", path: ["noteKind"], message: "A note needs a kind." });
    if (e.state === "observing" && e.kind !== "command") ctx.addIssue({ code: "custom", path: ["state"], message: "Only commands observe." });
  });
export type GuardrailEntry = z.infer<typeof guardrailEntrySchema>;

export const cardItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  text: z.string().trim().min(1).max(guardrailLimits.itemText),
  quote: z.string().max(guardrailLimits.quote),
  shape: cardShapeSchema,
  count: z.number().int().min(1),
  state: z.enum(cardItemStates),
  promotedTo: z.string().optional(),
  createdAt: iso,
  updatedAt: iso,
});
export type CardItem = z.infer<typeof cardItemSchema>;

export const guardrailErrorSchema = z.object({ projectId: z.string(), taskId: z.string().optional(), at: iso, message: z.string().max(500) });
export type GuardrailError = z.infer<typeof guardrailErrorSchema>;

export const guardrailsStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(guardrailEntrySchema),
  items: z.array(cardItemSchema),
  clues: z.array(memoryClueSchema),
  retros: z.array(memoryRetroSchema),
  errors: z.array(guardrailErrorSchema),
  recallStats: z.record(z.string(), z.object({ days: z.record(z.string(), z.object({ queries: z.number(), empty: z.number() })) })),
  /** Weekly catch-up learning (§7.3): the newest `feedback` clue already learned from, per project. */
  learnedUntil: z.record(z.string(), z.string()).optional(),
});
export type GuardrailsState = z.infer<typeof guardrailsStateSchema>;
export const emptyGuardrailsState = (): GuardrailsState => ({ version: 1, revision: 0, entries: [], items: [], clues: [], retros: [], errors: [], recallStats: {} });

/** What the Guardrails page reads (guardrails.read, §7.5). */
export const guardrailsViewSchema = z.object({
  entries: z.array(guardrailEntrySchema),
  items: z.array(cardItemSchema),
  errors: z.array(guardrailErrorSchema),
  /** Cards whose finished-card review is running. */
  running: z.array(z.string()),
  /** Guardrails on for this project (host and project switch, B4). */
  enabled: z.boolean(),
});
export type GuardrailsView = z.infer<typeof guardrailsViewSchema>;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
export const textKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
export const shortId = (id: string) => id.slice(0, 8);

// ---- Shape and scope (§6.2) ----------------------------------------------------------

/** s ≤ 50 changed lines, m ≤ 400, l above. */
export function sizeOf(lines: number): ChangeSize {
  return lines <= guardrailLimits.smallLines ? "s" : lines <= guardrailLimits.mediumLines ? "m" : "l";
}

/** In scope: its types are "all" or hold the card's type (a card without a type counts as held), and likewise its sizes. */
export function inScope(entry: { scope?: GuardrailScope }, shape: CardShape): boolean {
  const scope = entry.scope;
  if (!scope) return true;
  const typeOk = scope.types === "all" || !shape.type || scope.types.includes(shape.type);
  const sizeOk = scope.sizes === "all" || !shape.size || scope.sizes.includes(shape.size);
  return typeOk && sizeOk;
}
/** In scope by type alone: session start does not know the size yet (§5.1). */
export const inTypeScope = (entry: { scope?: GuardrailScope }, type: TaskType | undefined) => inScope(entry, { type });

/** The scope of a guideline learned from these cards: the union of their known types and sizes; nothing known means "all". */
export function scopeOf(shapes: readonly CardShape[]): GuardrailScope {
  const types = [...new Set(shapes.flatMap((s) => (s.type ? [s.type] : [])))];
  const sizes = [...new Set(shapes.flatMap((s) => (s.size ? [s.size] : [])))];
  return { types: types.length ? types : "all", sizes: sizes.length ? sizes : "all" };
}

/** Widens a scope to hold this card's shape; it never narrows (§4.3). Returns the scope and whether it changed. */
export function widenScope(scope: GuardrailScope | undefined, shape: CardShape): { scope: GuardrailScope; changed: boolean } {
  const current: GuardrailScope = scope ? { types: scope.types === "all" ? "all" : [...scope.types], sizes: scope.sizes === "all" ? "all" : [...scope.sizes] } : { types: "all", sizes: "all" };
  let changed = false;
  if (current.types !== "all" && shape.type && !current.types.includes(shape.type)) {
    current.types.push(shape.type);
    changed = true;
  }
  if (current.sizes !== "all" && shape.size && !current.sizes.includes(shape.size)) {
    current.sizes.push(shape.size);
    changed = true;
  }
  return { scope: current, changed };
}

// ---- Counters (§6.6) -----------------------------------------------------------------

/** One review that checked it: `passed` and `na` count as passes. */
export function countReview(counts: GuardrailCounts, result: string) {
  counts.reviews++;
  if (result === "passed" || result === "na") counts.passes++;
}
/** It failed in an earlier round and passed now on the same card, with no dispute. */
export function countCaught(counts: GuardrailCounts, at: string) {
  counts.caught++;
  counts.lastCaughtAt = at;
}
/** The review let it through and the user caught it in a rework turn (§4.3). */
export function countMissed(counts: GuardrailCounts, at: string) {
  counts.missed++;
  counts.lastMissedAt = at;
}
/** Its finding was disputed and the card finished without the user sending it back for it. */
export function countMisfire(counts: GuardrailCounts, at: string) {
  counts.misfire++;
  counts.misfireAt = [...(counts.misfireAt || []), at].slice(-guardrailLimits.misfiresKept);
}

type ItemResult = { id: string; state: string };
/**
 * Caught (§6.6): items that failed in the previous review of a card and passed in this one, leaving out
 * disputed ones. Pure; the caller counts them.
 */
export function caughtIds(previous: readonly ItemResult[] | undefined, current: readonly ItemResult[], disputed: readonly string[] = []): string[] {
  const failed = new Set((previous || []).filter((r) => r.state === "failed").map((r) => r.id));
  const skip = new Set(disputed);
  return current.filter((r) => r.state === "passed" && failed.has(r.id) && !skip.has(r.id)).map((r) => r.id);
}

// ---- Automatic retirement (§6.7, §4.5) ------------------------------------------------

export type Retirement = { state: GuardrailState; reason: string };

/**
 * What an entry should become now, or null to leave it. Guidelines: two misfires in 30 days pause it; 20 reviews
 * that never caught anything (and nothing missed in 90 days) archive it. Commands: three unavailable runs in a row
 * pause it; an observing command with 3 reviews and a pass becomes active. Notes: 90 days without use archive
 * them (counted from creation when never used); pinned notes stay.
 */
export function retirement(entry: GuardrailEntry, now: number): Retirement | null {
  const within = (at: string | undefined, days: number) => !!at && now - Date.parse(at) <= days * DAY;
  if (entry.kind === "guideline" && entry.state === "active") {
    const recent = (entry.counts.misfireAt || []).filter((at) => within(at, guardrailLimits.misfireDays)).length;
    if (recent >= guardrailLimits.misfirePause) return { state: "paused", reason: "misfired twice in 30 days" };
    if (entry.counts.reviews >= guardrailLimits.neverCaughtReviews && entry.counts.caught === 0 && !within(entry.counts.lastMissedAt, guardrailLimits.missedDays))
      return { state: "archived", reason: "never caught anything" };
    return null;
  }
  if (entry.kind === "command" && (entry.state === "active" || entry.state === "observing")) {
    if ((entry.counts.unavailableRun || 0) >= guardrailLimits.unavailableRun) return { state: "paused", reason: "cannot run" };
    if (entry.state === "observing" && (entry.observe?.reviews || 0) >= guardrailLimits.observeReviews && (entry.observe?.passed || 0) >= 1)
      return { state: "active", reason: "observed" };
    return null;
  }
  if (entry.kind === "note" && entry.state === "active" && !entry.pinned) {
    if (!within(entry.counts.usedAt || entry.createdAt, guardrailLimits.unusedDays)) return { state: "archived", reason: "unused for 90 days" };
  }
  return null;
}

// ---- Caps and displacement (§3.4) ------------------------------------------------------

const caughtRate = (e: GuardrailEntry) => e.counts.caught / Math.max(e.counts.reviews, 1);
/**
 * The active guideline a full project gives up for a newly promoted or revived one: the lowest caught rate,
 * then the longest since it last caught something (never counts as oldest). `keep` is never chosen.
 */
export function guidelineToDisplace(entries: readonly GuardrailEntry[], projectId: string, keep: string): GuardrailEntry | null {
  const active = entries.filter((e) => e.projectId === projectId && e.kind === "guideline" && e.state === "active");
  if (active.length <= guardrailLimits.guidelinesActive) return null;
  const last = (e: GuardrailEntry) => e.counts.lastCaughtAt || "";
  return [...active].filter((e) => e.id !== keep).sort((a, b) => caughtRate(a) - caughtRate(b) || last(a).localeCompare(last(b)) || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}
/** The active note a full project gives up: the longest unused, never a pinned one or `keep`. */
export function noteToDisplace(entries: readonly GuardrailEntry[], projectId: string, keep: string): GuardrailEntry | null {
  const active = entries.filter((e) => e.projectId === projectId && e.kind === "note" && e.state === "active");
  if (active.length <= guardrailLimits.notesActive) return null;
  const last = (e: GuardrailEntry) => e.counts.usedAt || e.createdAt;
  return [...active].filter((e) => e.id !== keep && !e.pinned).sort((a, b) => last(a).localeCompare(last(b)))[0] ?? null;
}
/** Commands that run (active and observing) are capped; a new one past the cap is not added. */
export const commandRoom = (entries: readonly GuardrailEntry[], projectId: string) =>
  guardrailLimits.commandsLive - entries.filter((e) => e.projectId === projectId && e.kind === "command" && (e.state === "active" || e.state === "observing")).length;
/** Archived entries past 300 per project, oldest first: they are deleted (after a backup). */
export function archivedOverflow(entries: readonly GuardrailEntry[], projectId: string): GuardrailEntry[] {
  const archived = entries.filter((e) => e.projectId === projectId && e.state === "archived");
  const excess = archived.length - guardrailLimits.archivedPerProject;
  return excess > 0 ? [...archived].sort((a, b) => a.stateAt.localeCompare(b.stateAt)).slice(0, excess) : [];
}
/** Open items past five on a card, oldest first: they are closed. */
export function openItemOverflow(items: readonly CardItem[], taskId: string): CardItem[] {
  const open = items.filter((i) => i.taskId === taskId && i.state === "open");
  const excess = open.length - guardrailLimits.openItemsPerTask;
  return excess > 0 ? [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, excess) : [];
}

/** Moves an entry to a new state with its reason (and clears `pinned` when it leaves active). */
export function setState(entry: GuardrailEntry, state: GuardrailState, reason: string | undefined, at: string) {
  entry.state = state;
  if (reason) entry.stateReason = clip(reason, guardrailLimits.stateReason);
  else delete entry.stateReason;
  entry.stateAt = at;
  if (state !== "active" && entry.pinned) entry.pinned = false;
}

// ---- Learning (§4.2, §4.3) --------------------------------------------------------------

export type Correction = { kind: "none" } | { kind: "new"; text: string } | { kind: "same"; matches: string; text?: string };

/** JSON Schema of the summarizer's extra field on a rework turn. */
export const correctionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["none", "new", "same"] },
    text: { type: "string" },
    matches: { type: "string" },
  },
} as const;

/** The `correction` field of a summarizer's raw output; anything missing or malformed reads as none (§4.2). */
export function parseCorrection(raw: unknown): Correction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "none" };
  const value = raw as Record<string, unknown>;
  const text = typeof value.text === "string" ? clip(value.text.replace(/\s+/g, " ").trim(), guardrailLimits.correctionText) : "";
  const matches = typeof value.matches === "string" ? value.matches.trim().replace(/^#/, "") : "";
  if (value.kind === "same" && matches) return { kind: "same", matches, ...(text ? { text } : {}) };
  // A "same" that names nothing is a new correction if it says what is wrong.
  if ((value.kind === "new" || value.kind === "same") && text) return { kind: "new", text };
  return { kind: "none" };
}
/** The `correction` field of a summarizer's text output (fences and prose tolerated). */
export function correctionOf(output: string | null | undefined): Correction {
  const json = output ? firstObject(output) : null;
  if (!json) return { kind: "none" };
  try {
    return parseCorrection((JSON.parse(json) as { correction?: unknown }).correction);
  } catch {
    return { kind: "none" };
  }
}

/** A `#id` prefix of at least 6 characters matched against these ids; the unique match or null. */
export function resolveShortId<T extends { id: string }>(ref: string, candidates: readonly T[]): T | null {
  const key = ref.trim().replace(/^#/, "").toLowerCase();
  if (key.length < 6) return null;
  const found = candidates.filter((c) => c.id.toLowerCase().startsWith(key));
  return found.length === 1 ? found[0] : null;
}

/** The entry at the end of a `supersededBy` chain (a merged or replaced entry stands for its successor); cycles stop. */
export function liveEntry(entries: readonly GuardrailEntry[], entry: GuardrailEntry): GuardrailEntry {
  const seen = new Set([entry.id]);
  let current = entry;
  for (let next = current.supersededBy; next && !seen.has(next); next = current.supersededBy) {
    const found = entries.find((e) => e.id === next);
    if (!found) break;
    seen.add(found.id);
    current = found;
  }
  return current;
}

/**
 * The `Guardrails` section of a rework turn's summarizer input (§4.2, B2): at most 60 lines of at most 120
 * characters, in this order until full: active guidelines in this card's scope; this card's open items; active
 * guidelines out of scope; other cards' open items from the last 30 days; paused guidelines and those archived
 * in the last 90 days.
 */
export function guardrailsSection(input: { entries: readonly GuardrailEntry[]; items: readonly CardItem[]; projectId: string; taskId: string; shape: CardShape; now: number }): string[] {
  const guidelines = input.entries.filter((e) => e.projectId === input.projectId && e.kind === "guideline");
  const items = input.items.filter((i) => i.projectId === input.projectId && i.state === "open");
  const recent = (at: string, days: number) => input.now - Date.parse(at) <= days * DAY;
  const line = (id: string, label: string, text: string) => clip(`#${shortId(id)} ${label}: ${text.replace(/\s+/g, " ").trim()}`, guardrailLimits.sectionLine);
  const active = guidelines.filter((e) => e.state === "active");
  const lines = [
    ...active.filter((e) => inScope(e, input.shape)).map((e) => line(e.id, "guideline", e.text)),
    ...items.filter((i) => i.taskId === input.taskId).map((i) => line(i.id, "this card", i.text)),
    ...active.filter((e) => !inScope(e, input.shape)).map((e) => line(e.id, "guideline, out of scope", e.text)),
    ...items.filter((i) => i.taskId !== input.taskId && recent(i.updatedAt, guardrailLimits.sectionOtherItemsDays)).map((i) => line(i.id, "other card", i.text)),
    ...guidelines
      .filter((e) => e.state === "paused" || (e.state === "archived" && recent(e.stateAt, guardrailLimits.sectionArchivedDays)))
      .map((e) => line(e.id, `guideline, ${e.state}`, e.text)),
  ];
  return lines.slice(0, guardrailLimits.sectionLines);
}

/** A new guideline promoted from two cards' items (§4.3): their text, both cards and quotes, the union of their shapes. */
export function promotedGuideline(input: { id: string; projectId: string; text: string; at: string; from: readonly { taskId: string; quote: string; shape: CardShape; at: string }[] }): GuardrailEntry {
  return {
    id: input.id,
    projectId: input.projectId,
    kind: "guideline",
    text: clip(input.text.trim(), guardrailLimits.guidelineText),
    scope: scopeOf(input.from.map((f) => f.shape)),
    state: "active",
    stateAt: input.at,
    counts: emptyCounts(),
    sources: input.from.map((f) => ({ taskId: f.taskId, at: f.at, ...(f.quote ? { quote: clip(f.quote, guardrailLimits.quote) } : {}) })).slice(0, guardrailLimits.sources),
    by: "learned",
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** Text the bookkeeping must not keep (§4.6). */
export const hasSecret = (...values: readonly (string | undefined)[]) => containsSecret(values.filter(Boolean).join("\n"));

// ---- Prevention (§5) --------------------------------------------------------------------

/** The guidelines a new session of this card is told about: active, in scope by its type, at most 20, most caught first. */
export function guidelinesForTask(entries: readonly GuardrailEntry[], projectId: string, type: TaskType | undefined): GuardrailEntry[] {
  return entries
    .filter((e) => e.projectId === projectId && e.kind === "guideline" && e.state === "active" && inTypeScope(e, type))
    .sort((a, b) => b.counts.caught - a.counts.caught || a.createdAt.localeCompare(b.createdAt))
    .slice(0, guardrailLimits.injectGuidelines);
}
/** The guidelines block of a session's first instructions (§5.1); empty when none applies. */
export function guidelineContextLines(guidelines: readonly GuardrailEntry[]): string[] {
  if (!guidelines.length) return [];
  const caught = (n: number) => (n ? ` (caught ${n} time${n === 1 ? "" : "s"})` : "");
  return [
    `Project guardrails (checked when you deliver; ${guidelines.length} of them apply to this card's type):`,
    ...guidelines.map((g) => `- ${g.text.replace(/\s+/g, " ").trim()}${caught(g.counts.caught)}`),
  ];
}
/** Both blocks of §5.1: guidelines in scope by type, then notes with the PROJECT-MEMORY-SPEC §6.2 selection and budget. */
export function guardrailContext(
  state: Pick<GuardrailsState, "entries">,
  task: { id: string; projectId: string; title: string; description: string; type?: TaskType; tags?: readonly { tag: string }[] },
  titleOf: (taskId: string | undefined) => string | undefined = () => undefined,
): { lines: string[]; noteIds: string[] } {
  const guidelines = guidelinesForTask(state.entries, task.projectId, task.type);
  const notes = state.entries.filter((e) => e.projectId === task.projectId && e.kind === "note").map(toMemoryEntry);
  const selection = memoryForTask(notes, { title: task.title, description: task.description, tags: (task.tags || []).map((t) => t.tag) }, titleOf);
  return { lines: [...guidelineContextLines(guidelines), ...memoryContextLines(selection, titleOf)], noteIds: selection.entries.map((e) => e.id) };
}

/**
 * flowly_recall over guidelines (§5.3): the project's active guidelines ranked like notes against the query (their
 * sentence, note and the user's words); an empty query lists the newest. A note-kind filter leaves guidelines out.
 */
export function recallGuidelines(entries: readonly GuardrailEntry[], projectId: string, input: { query: string; kind?: MemoryKind; limit?: number }) {
  if (input.kind) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const asNotes: MemoryEntry[] = entries
    .filter((e) => e.projectId === projectId && e.kind === "guideline" && e.state === "active")
    .map((e) => ({
      id: e.id,
      projectId: e.projectId,
      kind: "convention",
      title: e.text,
      body: [e.body, ...e.sources.map((s) => s.quote)].filter(Boolean).join("\n"),
      tags: [],
      keywords: [],
      pinned: false,
      status: "active",
      source: { by: "agent" },
      revision: e.revision,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      confirmedAt: e.stateAt,
    }));
  return recallMemory(asNotes, input).entries.map((m) => {
    const e = byId.get(m.id)!;
    const quote = [...e.sources].reverse().find((s) => s.quote)?.quote;
    return { id: e.id, text: e.text, scope: e.scope || { types: "all" as const, sizes: "all" as const }, ...(quote ? { quote } : {}), caught: e.counts.caught };
  });
}

// ---- Weekly run (§7.3) ------------------------------------------------------------------

/** §7.3: the weekly catch-up learns from at most 30 `feedback` clues of the last 7 days. */
export const catchUpLimits = { clues: 30, days: 7, clue: 600 } as const;

/** One Summary-model call over the week's rework words when card summaries are off (§7.3 step 1). Agent-facing English. */
export function catchUpPrompt(clues: readonly { taskId: string; text: string }[], section: readonly string[]): string {
  return [
    "Each numbered message below is what the owner of a software project wrote to a coding agent while a card was waiting in review. For each one decide whether the owner is correcting work the agent delivered (not a new request, not a follow-up, not chat such as \"commit and push\" or \"thanks\").",
    'If it is a correction, summarize it as one checkable sentence (kind "new", at most 120 characters, in the message\'s language); if it is the same thing as an entry of the list, give that entry\'s #id (kind "same"). Otherwise kind "none".',
    "",
    "## Guardrails",
    ...(section.length ? section : ["(none yet)"]),
    "",
    "## Messages",
    ...clues.map((c, i) => `${i + 1}. (card ${shortId(c.taskId)}) ${clip(c.text.replace(/\s+/g, " ").trim(), catchUpLimits.clue)}`),
    "",
    'Do not use any tools. Answer with only one JSON object: {"corrections":[{"n":1,"kind":"none|new|same","text":"…","matches":"#id"}]}, one entry per message.',
  ].join("\n");
}
export const catchUpJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["corrections"],
  properties: {
    corrections: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["n", "kind"], properties: { n: { type: "integer" }, kind: { type: "string", enum: ["none", "new", "same"] }, text: { type: "string" }, matches: { type: "string" } } },
    },
  },
} as const;
/** The catch-up's answer by message number (1-based); missing or malformed entries read as none. */
export function parseCatchUp(output: string | null | undefined, count: number): Correction[] {
  const out: Correction[] = Array.from({ length: count }, () => ({ kind: "none" }));
  const json = output ? firstObject(output) : null;
  if (!json) throw new Error("The catch-up output is not JSON.");
  let list: unknown;
  try {
    list = (JSON.parse(json) as { corrections?: unknown }).corrections;
  } catch {
    throw new Error("The catch-up output is not valid JSON.");
  }
  if (!Array.isArray(list)) throw new Error("The catch-up output has no corrections list.");
  for (const raw of list) {
    const n = raw && typeof raw === "object" ? (raw as { n?: unknown }).n : undefined;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= count) out[n - 1] = parseCorrection(raw);
  }
  return out;
}

/**
 * A merge the model proposed (§7.3), checked against the project: both ids resolve to distinct active entries of the
 * project of the same kind (two guidelines or two notes). Returns the pair, or null to drop it.
 */
export function mergePair(entries: readonly GuardrailEntry[], projectId: string, merge: { keep: string; drop: string }): { keep: GuardrailEntry; drop: GuardrailEntry } | null {
  const active = entries.filter((e) => e.projectId === projectId && e.state === "active" && (e.kind === "guideline" || e.kind === "note"));
  const keep = resolveShortId(merge.keep, active);
  const drop = resolveShortId(merge.drop, active);
  if (!keep || !drop || keep.id === drop.id || keep.kind !== drop.kind) return null;
  return { keep, drop };
}
const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);
/**
 * Applies a merge (§7.3): `drop` is archived as merged and points at `keep`; `keep` gets the sum of both counts, both
 * sources and the union of both scopes. Pure; the caller bumps revisions.
 */
export function mergeInto(keep: GuardrailEntry, drop: GuardrailEntry, at: string) {
  const a = keep.counts,
    b = drop.counts;
  const usedBy = [...a.usedBy, ...b.usedBy.filter((u) => !a.usedBy.some((x) => x.taskId === u.taskId))].sort((x, y) => x.at.localeCompare(y.at)).slice(-guardrailLimits.usedBy);
  keep.counts = {
    reviews: a.reviews + b.reviews,
    passes: a.passes + b.passes,
    caught: a.caught + b.caught,
    missed: a.missed + b.missed,
    misfire: a.misfire + b.misfire,
    ...(later(a.lastCaughtAt, b.lastCaughtAt) ? { lastCaughtAt: later(a.lastCaughtAt, b.lastCaughtAt) } : {}),
    ...(later(a.lastMissedAt, b.lastMissedAt) ? { lastMissedAt: later(a.lastMissedAt, b.lastMissedAt) } : {}),
    ...(a.misfireAt || b.misfireAt ? { misfireAt: [...(a.misfireAt || []), ...(b.misfireAt || [])].sort().slice(-guardrailLimits.misfiresKept) } : {}),
    usedBy,
    ...(later(a.usedAt, b.usedAt) ? { usedAt: later(a.usedAt, b.usedAt) } : {}),
  };
  keep.sources = [...keep.sources, ...drop.sources.filter((s) => !keep.sources.some((k) => k.taskId === s.taskId))].slice(-guardrailLimits.sources);
  if (keep.kind === "guideline") {
    const other = drop.scope || { types: "all", sizes: "all" };
    const mine = keep.scope || { types: "all", sizes: "all" };
    keep.scope = {
      types: mine.types === "all" || other.types === "all" ? "all" : [...new Set([...mine.types, ...other.types])],
      sizes: mine.sizes === "all" || other.sizes === "all" ? "all" : [...new Set([...mine.sizes, ...other.sizes])],
    };
  }
  setState(drop, "archived", "merged", at);
  drop.supersededBy = keep.id;
}

/** How many times each item was caught in the window (§7.3): failed in one review of a card and passed in its next one. */
export function caughtInWindow(entries: readonly { at: string; taskId: string; action: string; results?: readonly { id: string; state: string }[] }[], from: number): Map<string, number> {
  const out = new Map<string, number>();
  const last = new Map<string, readonly { id: string; state: string }[]>();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.action !== "review_finished" || !e.results?.length) continue;
    const before = last.get(e.taskId);
    last.set(e.taskId, e.results);
    if (Date.parse(e.at) < from) continue;
    for (const id of caughtIds(before, e.results)) out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

/**
 * The `# Guardrails` section of the weekly material (§7.3 step 2): each active guideline with its scope, counts and
 * source cards (and "caught 5+ in 30 days" when it applies), each active note's title, the last 30 days' review
 * results per card and the open card items. Ids are 8-character `#` prefixes, as merges cite them.
 */
export function guardrailsMaterial(input: {
  entries: readonly GuardrailEntry[];
  items: readonly CardItem[];
  projectId: string;
  reviews: readonly { taskId: string; at: string; results: readonly { id: string; state: string; kind?: string }[] }[];
  caught30: ReadonlyMap<string, number>;
  cardTitle: (taskId: string) => string | undefined;
}): string {
  const own = input.entries.filter((e) => e.projectId === input.projectId && e.state === "active");
  const guidelines = own.filter((e) => e.kind === "guideline");
  const notes = own.filter((e) => e.kind === "note").slice(0, 60);
  const scopeText = (s: GuardrailScope | undefined) => (!s ? "all" : `${s.types === "all" ? "all types" : s.types.join("/")}, ${s.sizes === "all" ? "all sizes" : s.sizes.join("/")}`);
  const lines = ["# Guardrails", "", "## Guidelines (checked on deliveries in their scope)"];
  if (!guidelines.length) lines.push("(none)");
  for (const g of guidelines) {
    const hot = (input.caught30.get(g.id) || 0) >= 5 ? " · caught 5+ in 30 days" : "";
    lines.push(
      `- #${shortId(g.id)} ${clip(g.text, 200)} [${scopeText(g.scope)}] caught ${g.counts.caught} · missed ${g.counts.missed} · misfire ${g.counts.misfire} · reviews ${g.counts.reviews}${hot}; cards ${g.sources.map((x) => shortId(x.taskId)).join(", ") || "-"}`,
    );
  }
  lines.push("", "## Memory");
  if (!notes.length) lines.push("(none)");
  for (const n of notes) lines.push(`- #${shortId(n.id)} [${n.noteKind || "note"}] ${clip(n.text, 120)}`);
  const items = input.items.filter((i) => i.projectId === input.projectId && i.state === "open");
  lines.push("", "## Open card items (sent back once, not yet a guideline)");
  if (!items.length) lines.push("(none)");
  for (const i of items.slice(0, 40)) lines.push(`- card ${shortId(i.taskId)}: ${clip(i.text, 160)} (×${i.count})`);
  lines.push("", "## Reviews in the last 30 days");
  if (!input.reviews.length) lines.push("(none)");
  for (const r of input.reviews.slice(-40)) {
    const failed = r.results.filter((x) => x.state === "failed").map((x) => (x.kind === "goal" ? "goal" : `#${shortId(x.id)}`));
    lines.push(`- card ${shortId(r.taskId)} ${clip(input.cardTitle(r.taskId) || "", 60)}: ${failed.length ? `failed ${failed.join(", ")}` : "passed"}`);
  }
  return lines.join("\n");
}

// ---- The project's ledger in Insights (§7.2, §7.5) --------------------------------------

export const guardrailsLedgerSchema = z.object({
  /** Agent deliveries to In review in the last 14 days. */
  deliveries: z.number().int().nonnegative(),
  /** Of those, the ones a review finished for (not cancelled). */
  reviewed: z.number().int().nonnegative(),
  /** Of those, the ones whose first review passed. */
  firstPass: z.number().int().nonnegative(),
  /** Failed judgement items (the built-in check, guidelines, card items) in the last 30 days. */
  judged: z.number().int().nonnegative(),
  /** Misfires counted on the project's entries in the last 30 days. */
  misfires: z.number().int().nonnegative(),
  /** This week (the last 7 days): what was learned and retired, and the commands observing now. */
  changes: z.object({
    learned: z.number().int().nonnegative(),
    widened: z.number().int().nonnegative(),
    revived: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
    observing: z.number().int().nonnegative(),
  }),
});
export type GuardrailsLedger = z.infer<typeof guardrailsLedgerSchema>;

type LedgerEntry = {
  at: string;
  taskId: string;
  action: string;
  actor: string;
  to?: string;
  results?: readonly { id: string; state: string; kind?: string; gating?: false }[];
  guardrail?: { change: string; kind: string; id: string };
};
/** A finished review's verdict from its results (gating items only); null for one that judged nothing (cancelled). */
function resultsVerdict(results: LedgerEntry["results"]): "passed" | "failed" | "unavailable" | null {
  if (!results?.length) return null;
  const gating = results.filter((r) => r.gating !== false);
  if (gating.some((r) => r.state === "failed")) return "failed";
  if (gating.some((r) => r.state === "unavailable" || r.state === "queued" || r.state === "running")) return "unavailable";
  return "passed";
}

/**
 * The closed loop's numbers for Insights (§7.2): from the project's flow log (never the board's truncated events), the
 * `review_finished` results and the `guardrail_*` entries, plus the entries' misfire times and observing commands.
 * Days are the viewer's (`tz`): the 14 days and the week end today.
 */
export function guardrailsLedger(input: { flow: readonly LedgerEntry[]; entries: readonly GuardrailEntry[]; projectId: string; now: number; tz?: string }): GuardrailsLedger {
  const today = dayKey(input.now, input.tz);
  const from14 = dayStart(addDays(today, -13), input.tz);
  const from7 = dayStart(addDays(today, -6), input.tz);
  const from30 = input.now - 30 * DAY;
  const sorted = [...input.flow].sort((a, b) => a.at.localeCompare(b.at));
  const at = (e: LedgerEntry) => Date.parse(e.at);
  let deliveries = 0,
    reviewed = 0,
    firstPass = 0,
    judged = 0;
  sorted.forEach((e, i) => {
    if (e.action === "status_changed" && e.actor === "agent" && e.to === "in_review" && at(e) >= from14) {
      deliveries++;
      // The first review that finished for this delivery, before the card's next delivery.
      for (let j = i + 1; j < sorted.length; j++) {
        const n = sorted[j]!;
        if (n.taskId !== e.taskId) continue;
        if (n.action === "status_changed" && n.actor === "agent" && n.to === "in_review") break;
        if (n.action !== "review_finished") continue;
        const verdict = resultsVerdict(n.results);
        if (!verdict) continue;
        reviewed++;
        if (verdict === "passed") firstPass++;
        break;
      }
    }
    if (e.action === "review_finished" && at(e) >= from30)
      judged += (e.results || []).filter((r) => r.state === "failed" && (r.kind === "goal" || r.kind === "guideline" || r.kind === "item")).length;
  });
  const own = input.entries.filter((e) => e.projectId === input.projectId);
  const misfires = own.reduce((n, e) => n + (e.counts.misfireAt || []).filter((m) => Date.parse(m) >= from30).length, 0);
  const week = sorted.filter((e) => at(e) >= from7 && e.guardrail);
  const learned = (change: string) => week.filter((e) => e.action === "guardrail_learned" && e.guardrail!.change === change).length;
  return {
    deliveries,
    reviewed,
    firstPass,
    judged,
    misfires,
    changes: {
      learned: learned("guideline"),
      widened: learned("widened"),
      revived: learned("revived"),
      retired: week.filter((e) => e.action === "guardrail_retired").length,
      observing: own.filter((e) => e.kind === "command" && e.state === "observing").length,
    },
  };
}

// ---- Notes as the former project memory (compatibility for memory.* until the Guardrails page) ----

const archivedReasons = ["retired", "promoted", "superseded"] as const;
/** A note as a MemoryEntry, so `memory.*`, search and the skill material keep working on the new store. */
export function toMemoryEntry(e: GuardrailEntry): MemoryEntry {
  const status = e.state === "active" ? "active" : e.stateReason === "dismissed" ? "dismissed" : "archived";
  const reason = (archivedReasons as readonly string[]).includes(e.stateReason || "") ? (e.stateReason as (typeof archivedReasons)[number]) : "retired";
  const evidence = e.sources.find((s) => s.quote)?.quote;
  const taskId = e.source?.taskId ?? e.sources[0]?.taskId;
  return {
    id: e.id,
    projectId: e.projectId,
    kind: e.noteKind || "convention",
    title: e.text,
    body: e.body || "",
    tags: e.tags || [],
    keywords: e.keywords || [],
    pinned: !!e.pinned,
    status,
    ...(status === "archived" ? { archivedReason: reason } : {}),
    ...(e.supersedes ? { supersedes: e.supersedes } : {}),
    ...(evidence ? { evidence } : {}),
    source: {
      by: e.by === "user" ? "human" : e.by === "retro" ? "retro" : "agent",
      ...(taskId ? { taskId } : {}),
      ...(e.source?.agentId ? { agentId: e.source.agentId } : {}),
      ...(e.source?.eventId ? { eventId: e.source.eventId } : {}),
    },
    revision: e.revision,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(e.state === "active" ? { confirmedAt: e.stateAt } : {}),
    ...(e.counts.usedAt ? { usedAt: e.counts.usedAt } : {}),
    ...(e.counts.usedBy.length ? { usedBy: e.counts.usedBy } : {}),
  };
}
/** The store as the former MemoryState: notes only. */
export function memoryStateOf(state: GuardrailsState): MemoryState {
  return {
    version: 1,
    revision: state.revision,
    entries: state.entries.filter((e) => e.kind === "note").map(toMemoryEntry),
    errors: state.errors.flatMap((e) => (e.taskId ? [{ taskId: e.taskId, projectId: e.projectId, at: e.at, message: e.message }] : [])),
    retros: state.retros,
    recallStats: state.recallStats,
    clues: state.clues,
  };
}

// ---- Migration (§3.6) ------------------------------------------------------------------

const byOf = (by: MemoryEntry["source"]["by"]): GuardrailBy => (by === "human" ? "user" : by);

/** A former memory entry as a note: active and candidate become active (D2), dismissed and archived stay archived. */
export function noteFromMemory(m: MemoryEntry): GuardrailEntry {
  const archived = m.status === "dismissed" || m.status === "archived";
  return {
    id: m.id,
    projectId: m.projectId,
    kind: "note",
    text: clip(m.title, guardrailLimits.noteTitle),
    ...(m.body ? { body: m.body } : {}),
    noteKind: m.kind,
    tags: m.tags,
    keywords: m.keywords,
    ...(m.pinned && !archived ? { pinned: true } : {}),
    state: archived ? "archived" : "active",
    ...(archived ? { stateReason: m.status === "dismissed" ? "dismissed" : m.archivedReason || "dismissed" } : {}),
    stateAt: m.confirmedAt || m.updatedAt,
    counts: { ...emptyCounts(), usedBy: m.usedBy || [], ...(m.usedAt ? { usedAt: m.usedAt } : {}) },
    sources: m.source.taskId ? [{ taskId: m.source.taskId, at: m.createdAt, ...(m.evidence ? { quote: clip(m.evidence, guardrailLimits.quote) } : {}) }] : [],
    ...(m.source.taskId || m.source.agentId || m.source.eventId
      ? { source: { ...(m.source.taskId ? { taskId: m.source.taskId } : {}), ...(m.source.agentId ? { agentId: m.source.agentId } : {}), ...(m.source.eventId ? { eventId: m.source.eventId } : {}) } }
      : {}),
    by: byOf(m.source.by),
    ...(m.supersedes ? { supersedes: m.supersedes } : {}),
    revision: m.revision,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** The review rules projects stored before guardrails (AUTO-REVIEW-SPEC §12.1), read only by the migration. */
const legacyCommand = z.object({
  name: z.string().trim().min(1),
  argv: z.array(z.string().min(1).max(guardrailLimits.arg)).min(1).max(guardrailLimits.args),
  timeoutSec: z.number().int().min(guardrailLimits.minTimeout).max(guardrailLimits.maxTimeout).optional(),
});
const legacyRule = z.union([
  legacyCommand.extend({ kind: z.literal("command"), off: z.literal(true).optional() }),
  z.object({ kind: z.literal("llm"), name: z.string(), prompt: z.string().trim().min(1), types: z.array(taskTypeSchema).optional(), off: z.literal(true).optional() }),
]);
type LegacyRule = z.infer<typeof legacyRule>;
/** A project's stored rules, or its first-version `checks` as command rules; anything unreadable is skipped. */
export function legacyRules(autoReview: unknown): LegacyRule[] {
  if (!autoReview || typeof autoReview !== "object") return [];
  const stored = autoReview as { rules?: unknown; checks?: unknown };
  const list = Array.isArray(stored.rules) ? stored.rules : Array.isArray(stored.checks) ? stored.checks.map((c) => ({ ...(c as object), kind: "command" })) : [];
  return list.flatMap((raw) => {
    const parsed = legacyRule.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * A project's auto review rules as entries: command rules become active commands (the user already chose them),
 * LLM rules active guidelines scoped by their types; paused rules are paused. Goal, guidance and drafts are dropped.
 */
export function entriesFromRules(project: Pick<Project, "id" | "autoReview">, at: string, newId: () => string): GuardrailEntry[] {
  return legacyRules(project.autoReview).map((rule): GuardrailEntry => {
    const base = {
      id: newId(),
      projectId: project.id,
      state: rule.off ? ("paused" as const) : ("active" as const),
      ...(rule.off ? { stateReason: "paused before guardrails" } : {}),
      stateAt: at,
      counts: emptyCounts(),
      sources: [],
      by: "user" as const,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (rule.kind === "command")
      return { ...base, kind: "command", text: clip(rule.name, guardrailLimits.commandName), argv: [...rule.argv], ...(rule.timeoutSec ? { timeoutSec: rule.timeoutSec } : {}) };
    const prompt = rule.prompt.replace(/\s+/g, " ").trim();
    return {
      ...base,
      kind: "guideline",
      text: clip(prompt, guardrailLimits.guidelineText),
      ...(prompt.length > guardrailLimits.guidelineText ? { body: clip(rule.prompt.trim(), guardrailLimits.body) } : {}),
      scope: { types: rule.types?.length ? [...rule.types] : "all", sizes: "all" },
    };
  });
}

/** The first guardrails.json: the former memory.json (if any) and every project's review rules (§3.6). */
export function migrateToGuardrails(memory: MemoryState | null, projects: readonly Pick<Project, "id" | "autoReview">[], at: string, newId: () => string): GuardrailsState {
  return {
    version: 1,
    revision: 1,
    entries: [...(memory?.entries || []).map(noteFromMemory), ...projects.flatMap((p) => entriesFromRules(p, at, newId))],
    items: [],
    clues: memory?.clues || [],
    retros: memory?.retros || [],
    errors: memory?.errors || [],
    recallStats: memory?.recallStats || {},
  };
}

export type { MemoryKind };
