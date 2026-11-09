import { noteMessagePrefix, summaryMessagePrefix, type ChatItem } from "../shared/dispatcher";
import type { TailEntry } from "../shared/session-tail";
import { groupTranscript, recentSessionOutput, type TranscriptBlock } from "./session-state";

/** Pure parts of the dispatcher chat (DISPATCHER-SPEC §9.3). No React. */

export type Row =
  | { kind: "entry"; key: string; at: number; entry: TailEntry }
  /** The dispatcher's first message (the board summary), shown as one line. */
  | { kind: "summary"; key: string; at: number }
  | { kind: "item"; key: string; at: number; item: ChatItem };

const time = (value: string | undefined) => (value ? Date.parse(value) : NaN);

/**
 * The dispatcher's transcript and Flowly's chat items in one list, ordered by time and stable (§9.3).
 * Note-batch messages are left out (their note rows stand for them); the board summary becomes one row.
 * An entry without a timestamp keeps its place right after the entry before it; ties keep the transcript first.
 */
export function mergeTimeline(transcript: readonly TailEntry[], items: readonly ChatItem[]): Row[] {
  const firstKnown = transcript.map((e) => time(e.timestamp)).find((t) => Number.isFinite(t));
  let carried = firstKnown ?? -Infinity;
  const entries: Row[] = [];
  transcript.forEach((entry, index) => {
    const at = time(entry.timestamp);
    if (Number.isFinite(at)) carried = at;
    const key = `entry-${entry.seqStart ?? index}-${entry.item.type}`;
    const text = entry.item.text ?? "";
    if (entry.item.type.includes("user") && text.startsWith(noteMessagePrefix)) return;
    if (entry.item.type.includes("user") && text.startsWith(summaryMessagePrefix)) entries.push({ kind: "summary", key, at: carried });
    else entries.push({ kind: "entry", key, at: carried, entry });
  });
  const rows: Row[] = items
    .map((item, index) => ({ item, index, at: time(item.at) }))
    .sort((a, b) => (a.at || 0) - (b.at || 0) || a.index - b.index)
    .map(({ item, at }) => ({ kind: "item", key: `item-${item.id}`, at, item }));
  const merged: Row[] = [];
  let i = 0,
    j = 0;
  while (i < entries.length || j < rows.length) {
    if (j >= rows.length || (i < entries.length && !(rows[j].at < entries[i].at))) merged.push(entries[i++]);
    else merged.push(rows[j++]);
  }
  return merged;
}

export type DisplayRow =
  | { kind: "block"; key: string; block: TranscriptBlock }
  | { kind: "summary"; key: string }
  | { kind: "item"; key: string; item: ChatItem };

/** Each run of transcript entries between items is grouped as the session pane groups it (activity blocks). */
export function displayRows(rows: readonly Row[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  let run: TailEntry[] = [];
  const flush = () => {
    if (!run.length) return;
    for (const block of groupTranscript(recentSessionOutput(run))) out.push({ kind: "block", key: block.key, block });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "entry") {
      run.push(row.entry);
      continue;
    }
    flush();
    out.push(row.kind === "item" ? { kind: "item", key: row.key, item: row.item } : { kind: "summary", key: row.key });
  }
  flush();
  return out;
}

/** Whether two chat items render the same (the row's memo comparison). */
export function sameItem(a: ChatItem, b: ChatItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
