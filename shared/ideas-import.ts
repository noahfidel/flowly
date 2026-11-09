import { z } from "zod";
import { ideaLimits } from "./model";

/** A title is at most this many characters; a longer one is cut at a word (IDEAS-IMPORT-EXPORT-SPEC §2). */
export const importTitleLimit = ideaLimits.title;

/** Largest paste and largest import (IDEAS-IMPORT-EXPORT-SPEC §3). */
export const importMarkdownLimit = 500_000;
export const importRowLimit = 1000;

/** One backlog item as the review step shows it. */
export const importRowSchema = z.strictObject({
  /** 1-based line of the item in the pasted text. */
  line: z.number().int().positive(),
  title: z.string().trim().min(1).max(ideaLimits.title),
  detail: z.string().max(ideaLimits.detail),
  /** The "(added …)" style note taken off the title, or null. Never read as a branch. */
  source: z.string().max(ideaLimits.source).nullable(),
  /** The item was `- [x]`. */
  done: z.boolean(),
  /** Whether the review step imports it. */
  keep: z.boolean(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

/** The reason an import row is skipped when its title is already an open idea; the client reads it to say "Already imported". */
export const importDuplicateReason = "Already an open idea in this project.";

/** What an import result means to the user: ideas created, all rows already open (a retry), or some skipped. */
export function importOutcome(result: { created: number; skipped: { reason: string }[] }): "created" | "already" | "skipped" {
  if (result.created > 0) return "created";
  return result.skipped.length > 0 && result.skipped.every((s) => s.reason === importDuplicateReason) ? "already" : "skipped";
}

const ITEM = /^- \[([ x])\] (.*)$/;
const NOTE = /^ {2}- (.*)$/;
const SOURCE_START = /^(added|started|pre-existing)\b/;

/** Top-level `( … )` groups of a line, skipping code spans and ignoring an unclosed `(`. */
function parentheticals(text: string): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let depth = 0;
  let start = 0;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "`") inCode = !inCode;
    else if (inCode) continue;
    else if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      if (depth === 0) groups.push({ start, end: i + 1 });
    }
  }
  return groups;
}

const isSourceNote = (inner: string) => SOURCE_START.test(inner) || inner.includes("added ");

/** Splits the item text into title text and the last added-style parenthetical (the source). */
function splitSource(text: string): { title: string; source: string | null } {
  const note = parentheticals(text)
    .filter((g) => isSourceNote(text.slice(g.start + 1, g.end - 1).trim()))
    .at(-1);
  if (!note) return { title: text.trim(), source: null };
  const before = text.slice(0, note.start).trimEnd();
  const after = text.slice(note.end).trimStart();
  const title = before && after ? `${before}${/^[:;,.]/.test(after) ? "" : " "}${after}` : before || after;
  if (!title) return { title: text.trim(), source: null };
  return { title, source: text.slice(note.start + 1, note.end - 1).trim() };
}

/** Text cut to `limit` characters with a trailing ellipsis; text within the limit is returned as is. */
const fit = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/** The title cut to the limit at the last space, with an ellipsis; text within the limit is returned as is. */
function cutTitle(text: string): string {
  if (text.length <= importTitleLimit) return text;
  const head = text.slice(0, importTitleLimit - 1);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:]+$/, "")}…`;
}

/**
 * Reads a markdown backlog (`- [ ] title (added …)` items with optional `  - ` notes) into review rows.
 * Headers and prose are skipped; `[x]` items are listed but not kept (IDEAS-IMPORT-EXPORT-SPEC §2).
 */
export function parseBacklog(markdown: string): ImportRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: ImportRow[] = [];
  // The detail parts of each row; joined and fitted at the end so a long original line or many notes never fail the row schema.
  const parts: string[][] = [];
  /** True right after an item, while its indented notes may follow. */
  let inItem = false;
  for (let i = 0; i < lines.length; i++) {
    const item = ITEM.exec(lines[i]!);
    if (item) {
      const original = item[2]!.trim();
      const { title, source } = splitSource(original);
      const short = cutTitle(title);
      inItem = true;
      rows.push({
        line: i + 1,
        title: short,
        detail: "",
        source: source === null ? null : fit(source, ideaLimits.source),
        done: item[1] === "x",
        keep: item[1] !== "x",
      });
      // The whole original line leads the detail when the title was cut, so nothing is lost.
      parts.push(short === title ? [] : [original]);
      continue;
    }
    const note = inItem && NOTE.exec(lines[i]!);
    if (note) {
      parts[parts.length - 1]!.push(`- ${note[1]!.trim()}`);
      continue;
    }
    inItem = false;
  }
  rows.forEach((row, i) => {
    row.detail = fit(parts[i]!.join("\n"), ideaLimits.detail);
  });
  return rows;
}
