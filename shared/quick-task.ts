import { z } from "zod";
import { tagLimits, taskTypes, type TaskTag, type TaskType } from "./model";
import { normalizeTag } from "./tags";
import { firstObject } from "./summary";
import { outputLanguageRule } from "./ai-language";
import type { LocaleCode } from "./i18n";

/** Quick task (docs/QUICK-TASK-SPEC.md): pure parts shared by the client and the daemon. */
export const QUICK_TITLE_MAX = 80;
/** How much of the typed text the AI title run reads. */
export const QUICK_TEXT_MAX = 4000;
export const QUICK_TAGS_MAX = 3;

/** Cuts at the last word boundary within `max` when that keeps at least half; adds "…" when cut. */
function cut(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max).join("");
  const space = head.lastIndexOf(" ");
  return `${space >= max / 2 ? head.slice(0, space) : head}…`;
}

/** §2: the card's title until the AI title arrives. */
export function provisionalTitle(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const bare = line.replace(/^(?:(?:#{1,6}|[-*+>]|\d+[.)])\s+)+/, "").trim();
  return cut(bare || line, QUICK_TITLE_MAX);
}

export type QuickTitle = { title: string; type: TaskType | null; tags: string[] };

const output = z.object({
  title: z.string().catch(""),
  type: z.string().nullish().catch(null),
  tags: z.array(z.string()).catch([]).default([]),
});

/** JSON Schema handed to the title session; mirrors `output`. */
export const quickTitleJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    type: { type: ["string", "null"], enum: [...taskTypes, null] },
    tags: { type: "array", items: { type: "string" }, maxItems: QUICK_TAGS_MAX },
  },
  required: ["title", "type", "tags"],
  additionalProperties: false,
} as const;

export function parseQuickTitle(text: string | null | undefined): QuickTitle {
  const json = text ? firstObject(text) : null;
  if (!json) throw new Error("The title model returned no JSON.");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The title model returned invalid JSON.");
  }
  const parsed = output.safeParse(raw);
  if (!parsed.success) throw new Error("The title model's output did not match the schema.");
  const type = (taskTypes as readonly string[]).includes(parsed.data.type || "") ? (parsed.data.type as TaskType) : null;
  return {
    title: cut(parsed.data.title.replace(/\s+/g, " ").trim(), QUICK_TITLE_MAX),
    type,
    tags: parsed.data.tags.map((t) => t.trim()).filter(Boolean).slice(0, QUICK_TAGS_MAX),
  };
}

export function quickTitlePrompt(input: { text: string; tags: readonly string[]; language: LocaleCode }): string {
  const tags = input.tags.slice(0, tagLimits.suggestions);
  return `You name a task card on a software project's board from the request a person typed. Do not use any tools.

Return JSON only: {"title": ..., "type": ..., "tags": [...]}.
- title: at most ${QUICK_TITLE_MAX} characters, imperative, specific, no trailing period.
- type: one of ${taskTypes.join(", ")}, or null when none fits.
- tags: at most ${QUICK_TAGS_MAX} short lowercase area words. Prefer the project's existing tags${tags.length ? ` (${tags.join(", ")})` : ""}; add a new one only when none fits. An empty list is fine.

${outputLanguageRule(input.language)}

The request:
${[...input.text].slice(0, QUICK_TEXT_MAX).join("")}`;
}

type Card = { title: string; type?: TaskType; tags?: readonly TaskTag[]; status: string; archivedAt: string | null };
export type QuickTitleMerge = { title?: string; type?: TaskType; tags?: TaskTag[]; addedTags?: string[] };

/**
 * §4: what the AI result changes on the card as it is now, or null for nothing. The title only while it is still the
 * provisional one, the type only while unset, tags only added (as agent tags) up to the card's limit.
 */
export function mergeQuickTitle(card: Card, provisional: string, suggestion: QuickTitle, at: string): QuickTitleMerge | null {
  if (card.archivedAt || card.status === "done" || card.status === "cancelled") return null;
  const merge: QuickTitleMerge = {};
  if (suggestion.title && card.title === provisional && suggestion.title !== card.title) merge.title = suggestion.title;
  if (suggestion.type && !card.type) merge.type = suggestion.type;
  const current = [...(card.tags || [])];
  const have = new Set(current.map((t) => t.tag));
  const added: string[] = [];
  for (const raw of suggestion.tags) {
    if (current.length >= tagLimits.perTask) break;
    let tag: string;
    try {
      tag = normalizeTag(raw);
    } catch {
      continue;
    }
    if (have.has(tag)) continue;
    have.add(tag);
    added.push(tag);
    current.push({ tag, by: "agent", at });
  }
  if (added.length) {
    merge.tags = current;
    merge.addedTags = added;
  }
  return Object.keys(merge).length ? merge : null;
}
