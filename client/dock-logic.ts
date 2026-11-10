import type { ChatItem } from "../shared/dispatcher";
import type { DockLayout, DockTab } from "../shared/settings";
import { minChatWidth } from "./geometry";

export type { DockLayout, DockTab } from "../shared/settings";

/**
 * Pure parts of the left dock (DISPATCHER-SPEC §9.3, §9.4; Ruling, Noah 2026-11-09): its two panes and layouts, the
 * bell's toggle and the Attention pane's sections. No React.
 */

/** What the dock shows: its tab, and whether it is open (desktop: not minimized; phone: the page is up). */
export type Dock = { tab: DockTab; open: boolean };
type Step = { next: Dock; back: Dock | null };

const split = (layout: DockLayout) => layout !== "single";

/**
 * The bell: shows the dock on Attention and remembers what it showed before; pressed again while Attention shows,
 * it returns there (the earlier tab, or minimized). With nothing to return to it goes to the Dispatcher tab.
 * In a split both panes show, so it only shows Attention: it opens a minimized dock and never removes the chat.
 */
export function bellPress(now: Dock, back: Dock | null, layout: DockLayout = "single"): Step {
  if (split(layout)) return { next: { tab: "attention", open: true }, back: null };
  if (now.open && now.tab === "attention") return { next: back ?? { tab: "dispatcher", open: true }, back: null };
  return { next: { tab: "attention", open: true }, back: now };
}

/** Attention opened from elsewhere (the overview's chip, a notification): shown, never toggled away. */
export function showAttention(now: Dock, back: Dock | null, layout: DockLayout = "single"): Step {
  if (!split(layout) && now.open && now.tab === "attention") return { next: now, back };
  return bellPress(now, back, layout);
}

/** The toolbar's Dispatcher button: Single shows the chat pane or minimizes it; a split shows or minimizes the dock. */
export function dispatcherPress(now: Dock, layout: DockLayout): Dock {
  if (split(layout)) return now.open ? { ...now, open: false } : { tab: "dispatcher", open: true };
  return now.open && now.tab === "dispatcher" ? { ...now, open: false } : { tab: "dispatcher", open: true };
}

/** The dock's divider is 8 points, like the grip on its right edge. */
export const dockDivider = 8;
/** Side by side: two chat-wide panes and the divider. */
export const sideDockMinWidth = 2 * minChatWidth + dockDivider;
/** Stack: the shortest a pane gets. */
export const minStackPane = 160;

/** Room for Side by side: the two panes, the dock's grip and the board's 300 points beside `reserved` (a card sidebar). */
export function sideFits(surfaceWidth: number, reserved = 0): boolean {
  return surfaceWidth - reserved - 8 - 300 >= sideDockMinWidth;
}

/** The layout drawn: phones show Single; Side by side shows as Stack when the window has no room (the stored one stays). */
export function dockLayoutShown(stored: DockLayout, { compact, surfaceWidth, reserved = 0 }: { compact: boolean; surfaceWidth: number; reserved?: number }): DockLayout {
  if (compact) return "single";
  return stored === "side" && !sideFits(surfaceWidth, reserved) ? "stack" : stored;
}

/** Whether a pane shows: both in a split, the dock's tab in Single. */
export function paneShown(layout: DockLayout, tab: DockTab, pane: DockTab): boolean {
  return split(layout) || tab === pane;
}

/**
 * A header button pressed (`toggleSplit`: with Cmd or Ctrl). Single: picks the pane, or splits into Stack on the other
 * pane. A split: focuses the pane (`focus`), or returns to Single on it. `tab` is the pane last used.
 */
export function dockButtonPress(now: { layout: DockLayout; tab: DockTab }, pane: DockTab, toggleSplit: boolean): { layout: DockLayout; tab: DockTab; focus: boolean } {
  if (split(now.layout)) return toggleSplit ? { layout: "single", tab: pane, focus: false } : { layout: now.layout, tab: pane, focus: true };
  if (toggleSplit && pane !== now.tab) return { layout: "stack", tab: pane, focus: false };
  return { layout: "single", tab: pane, focus: false };
}

/**
 * The first pane's size along the divider: `share` of `total` (unset or bad: half), kept so each pane has `min`.
 * With no room for both minimums the panes split evenly.
 */
export function splitSize(share: number, total: number, min: number): number {
  if (!(total > 0)) return 0;
  const wanted = share > 0 && share < 1 ? share : 0.5;
  if (total < 2 * min) return Math.round(total / 2);
  return Math.max(min, Math.min(total - min, Math.round(wanted * total)));
}

/** Attention's sections that fold (§9.4): Needs you and Updates, both open until folded. */
export type AttentionSection = "needs" | "updates";
const sectionDefaults: Record<AttentionSection, boolean> = { needs: true, updates: true };
/** A section's open state from the stored overrides; anything but a boolean keeps the default. */
export function attentionSectionOpen(stored: Readonly<Record<string, unknown>> | null | undefined, id: AttentionSection): boolean {
  const value = stored && typeof stored === "object" && !Array.isArray(stored) ? stored[id] : undefined;
  return typeof value === "boolean" ? value : sectionDefaults[id];
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
