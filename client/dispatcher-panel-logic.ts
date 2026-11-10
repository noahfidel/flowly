import { nextMoveDraft } from "../shared/next-moves";
import { noteMessagePrefix, summaryMessagePrefix, type ChatItem } from "../shared/dispatcher";
import type { TailEntry } from "../shared/session-tail";
import { groupTranscript, recentSessionOutput } from "./session-state";
import type { TranscriptRow } from "./session-transcript";

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
 * The chat is the conversation only (Ruling, Noah 2026-11-09): asks, answers and the change line live in the
 * dock's Attention tab, so only notes join the transcript here.
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
    .filter((item) => item.kind === "note")
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

/** A dispatcher row on the shared session transcript: the board summary line or one of Flowly's chat items. */
export type ChatExtra = { kind: "summary" } | { kind: "item"; item: ChatItem };

/**
 * The rows the shared session transcript shows (`TranscriptExtra.rows`): each run of transcript entries between
 * items is grouped as a card's session view groups it (activity blocks); items and the summary are rows of their own.
 */
export function displayRows(rows: readonly Row[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  let run: TailEntry[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push(...groupTranscript(recentSessionOutput(run)));
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "entry") {
      run.push(row.entry);
      continue;
    }
    flush();
    const item: ChatExtra = row.kind === "item" ? { kind: "item", item: row.item } : { kind: "summary" };
    out.push({ kind: "extra", key: row.key, item });
  }
  flush();
  return out;
}

/** The dispatcher chat's rows from the loaded transcript and Flowly's chat items (§9.3). */
export function chatRows(transcript: readonly TailEntry[], items: readonly ChatItem[]): TranscriptRow[] {
  return displayRows(mergeTimeline(transcript, items));
}

/** Whether two chat items render the same (the row's memo comparison). */
export function sameItem(a: ChatItem, b: ChatItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether an ask is answered with a text box: a question or blocker report, or a permission with no request
 * left to approve (a closed session's requests were cleared), whose typed answer messages the session (§9.4).
 */
export function answersWithText(item: Pick<Extract<ChatItem, { kind: "ask" }>, "askKind" | "requestId">): boolean {
  return item.askKind === "question_report" || item.askKind === "blocker_report" || (item.askKind === "permission" && !item.requestId);
}

/**
 * Discuss on an idea (DISPATCHER-SPEC §9.5): the draft it puts in the dispatcher's message box. English, since it is a
 * message to the agent; a blank detail is left out, and a title that already ends a sentence gets no extra period.
 */
export function discussIdeaText(idea: { id: string; title: string; detail: string }, projectTitle: string): string {
  const title = idea.title.trim();
  const detail = idea.detail.trim();
  const sentence = /[.!?]$/.test(title) ? title : `${title}.`;
  return `Let's talk about this idea (id ${idea.id}, project ${projectTitle}): ${sentence}${detail ? ` ${detail}` : ""}`;
}

/** The box's text after Discuss: never replaced; the draft goes after what is typed (as a picked next move), and only once (§9.5). */
export function discussDraft(text: string, typed: string): string {
  return typed.includes(text) ? typed : nextMoveDraft(text, typed);
}

/** Discuss shows where the board can open the dispatcher chat: a project board or All projects (the toolbar's rule). */
export const discussAvailable = (where: { project: boolean; allView: boolean }) => where.project || where.allView;

/**
 * What the panel does with a Discuss fill: null when there is none or this mount already applied its key; else the
 * key to report as used (the board then drops the fill, so a remounted panel never applies it again) and the box's
 * new text, or null when the box already holds it (no change, no focus).
 */
export function discussFill(fill: { text: string; key: number } | null | undefined, applied: number, typed: string): { key: number; next: string | null } | null {
  if (!fill || fill.key === applied) return null;
  const next = discussDraft(fill.text, typed);
  return { key: fill.key, next: next === typed ? null : next };
}
