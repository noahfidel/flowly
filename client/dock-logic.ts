import type { ChatItem } from "../shared/dispatcher";
import type { DockTab } from "../shared/settings";

export type { DockTab } from "../shared/settings";

/**
 * Pure parts of the left dock (DISPATCHER-SPEC §9.3, §9.4; Ruling, Noah 2026-11-09): its two tabs, the bell's
 * toggle and the Attention tab's sections. No React.
 */

/** What the dock shows: its tab, and whether it is open (desktop: not minimized; phone: the page is up). */
export type Dock = { tab: DockTab; open: boolean };
type Step = { next: Dock; back: Dock | null };

/**
 * The bell: shows the dock on Attention and remembers what it showed before; pressed again while Attention shows,
 * it returns there (the earlier tab, or minimized). With nothing to return to it goes to the Dispatcher tab.
 */
export function bellPress(now: Dock, back: Dock | null): Step {
  if (now.open && now.tab === "attention") return { next: back ?? { tab: "dispatcher", open: true }, back: null };
  return { next: { tab: "attention", open: true }, back: now };
}

/** Attention opened from elsewhere (the overview's chip, a notification): shown, never toggled away. */
export function showAttention(now: Dock, back: Dock | null): Step {
  if (now.open && now.tab === "attention") return { next: now, back };
  return bellPress(now, back);
}

export type AskItem = Extract<ChatItem, { kind: "ask" }>;
export type ChangeItem = Extract<ChatItem, { kind: "change" }>;

const time = (value: string) => Date.parse(value) || 0;

/**
 * The Attention tab's sections from the chat items (the asks the daemon lists from `asksFrom`, §9.4):
 * Needs you is every open ask, newest first, then the asks whose session ended (Start again, Dismiss);
 * `answered` drops what this client just answered before the list catches up. Updates is the change line when
 * cards changed; it is never an ask, so it never counts toward the bell. `open` is the open asks listed.
 */
export function attentionSections(items: readonly ChatItem[] | undefined, answered: ReadonlySet<string> = new Set()): { needs: AskItem[]; updates: ChangeItem | null; open: number } {
  const asks = (items ?? []).filter((item): item is AskItem => item.kind === "ask" && !answered.has(item.signal));
  const newest = (a: AskItem, b: AskItem) => time(b.at) - time(a.at);
  const open = asks.filter((a) => a.state === "open").sort(newest);
  const ended = asks.filter((a) => a.state === "session_ended").sort(newest);
  const change = (items ?? []).find((item): item is ChangeItem => item.kind === "change");
  return { needs: [...open, ...ended], updates: change && change.cards.length ? change : null, open: open.length };
}
