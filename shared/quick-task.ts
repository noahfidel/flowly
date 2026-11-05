import { z } from "zod";
import { firstObject } from "./summary";
import { outputLanguageRule } from "./ai-language";
import type { LocaleCode } from "./i18n";

/** Quick task (docs/QUICK-TASK-SPEC.md): pure parts shared by the client and the daemon. */
export const QUICK_TITLE_MAX = 80;
/** How much of the typed text the AI title run reads. */
export const QUICK_TEXT_MAX = 4000;

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

export type QuickTitle = { title: string };

const output = z.object({ title: z.string().catch("") });

/** JSON Schema handed to the title session; mirrors `output`. */
export const quickTitleJsonSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
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
  return { title: cut(parsed.data.title.replace(/\s+/g, " ").trim(), QUICK_TITLE_MAX) };
}

/** The text the title run reads: at most QUICK_TEXT_MAX characters (the client sends no more, §4). */
export const quickTitleText = (text: string) => [...text].slice(0, QUICK_TEXT_MAX).join("");

export function quickTitlePrompt(input: { text: string; language: LocaleCode }): string {
  return `You name a task card on a software project's board from the request a person typed. Do not use any tools.

Return JSON only: {"title": ...}, a title of at most ${QUICK_TITLE_MAX} characters: imperative, specific, no trailing period.

${outputLanguageRule(input.language)}

The request:
${quickTitleText(input.text)}`;
}

type Card = { title: string; status: string; archivedAt: string | null };

/**
 * §4: the AI title for the card as it is now, or null for no change: only while the title is still the provisional
 * one (a user edit wins), never on a finished or archived card. The AI sets nothing else.
 */
export function mergeQuickTitle(card: Card, provisional: string, suggestion: QuickTitle): { title: string } | null {
  if (card.archivedAt || card.status === "done" || card.status === "cancelled") return null;
  if (!suggestion.title || card.title !== provisional || suggestion.title === card.title) return null;
  return { title: suggestion.title };
}
