import type { GuardrailEntry } from "../shared/guardrails";
import type { MemorySort } from "../shared/settings";

/** The Memory page's ordering and grid (GUARDRAILS-SPEC §7.4). Pure: no React. */

/** Grid columns for the page's width: columns at least 340 pt wide, two or three. */
export const gridColumns = (width: number) => Math.max(2, Math.min(3, Math.floor(width / 340)));

const usedCards = (e: GuardrailEntry) => new Set(e.counts.usedBy.map((u) => u.taskId)).size;

/** Pinned first, then by the chosen order; ties go to the newer entry. */
export function sortNotes(entries: readonly GuardrailEntry[], sort: MemorySort): GuardrailEntry[] {
  const key = (e: GuardrailEntry) => (sort === "used" ? usedCards(e) : 0);
  const at = (e: GuardrailEntry) => (sort === "recent" ? e.counts.usedAt || "" : "");
  return [...entries].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || key(b) - key(a) || at(b).localeCompare(at(a)) || b.createdAt.localeCompare(a.createdAt),
  );
}

/**
 * About how tall a card renders in a column this wide: padding and stripe, the kind row, the full title,
 * the body folded to six lines, the source line and the tags/usage line.
 */
export function estimateHeight(e: GuardrailEntry, width: number) {
  const inner = width - 34;
  const lines = (text: string, charWidth: number) => {
    const chars = Math.max(20, Math.floor(inner / charWidth));
    return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / chars)), 0);
  };
  const gap = 8;
  const title = gap + lines(e.text, 7.5) * 19;
  const body = e.body ? gap + Math.min(6, lines(e.body, 6.5)) * 18 : 0;
  const source = e.source?.taskId || e.sources.length ? gap + 28 : 0;
  const facts = e.tags?.length || e.counts.usedAt ? gap + 16 : 0;
  return 34 + 24 + title + body + source + facts;
}

/**
 * Puts each entry, in order, into the currently shortest column. An entry placed before keeps its column
 * (`previous`) so a background refresh does not reshuffle the grid or remount a card being edited.
 */
export function placeMasonry<T extends { id: string }>(items: readonly T[], columns: number, height: (item: T) => number, previous?: ReadonlyMap<string, number>): T[][] {
  const out: T[][] = Array.from({ length: columns }, () => []);
  const sums = new Array<number>(columns).fill(0);
  for (const item of items) {
    const kept = previous?.get(item.id);
    const column = kept !== undefined && kept < columns ? kept : sums.indexOf(Math.min(...sums));
    out[column].push(item);
    sums[column] += height(item);
  }
  return out;
}
