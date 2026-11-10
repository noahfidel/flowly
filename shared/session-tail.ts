import { z } from "zod";

/**
 * A session's recent timeline reduced to what the plugin shows (PERFORMANCE-SPEC
 * §3): projected tool calls carry full payloads (diffs, file contents, logs)
 * that the UI never reads, and every byte crosses the relay into the phone's JS
 * thread.
 */
export const tailItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  messageId: z.string().optional(),
  clientMessageId: z.string().optional(),
  callId: z.string().optional(),
  /** A prompt another agent sent to this session (Paseo's `agent_message` provenance). */
  from: z.object({ id: z.string(), title: z.string().optional(), event: z.string() }).optional(),
});
export const tailEntrySchema = z.object({
  seqStart: z.number().optional(),
  seqEnd: z.number().optional(),
  timestamp: z.string().optional(),
  item: tailItemSchema,
});
export type TailEntry = z.infer<typeof tailEntrySchema>;

export const TAIL_TEXT_MAX = 12_000;
export const TAIL_REASONING_MAX = 2_000;

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function slimTimeline(
  entries: readonly { seqStart?: unknown; seqEnd?: unknown; timestamp?: unknown; item?: unknown }[],
): TailEntry[] {
  return entries.flatMap((entry) => {
    const raw = entry.item as Record<string, unknown> | undefined;
    const type = str(raw?.type);
    if (!raw || !type) return [];
    const item: TailEntry["item"] = { type };
    const text = str(raw.text);
    if (text !== undefined) item.text = clip(text, type === "reasoning" ? TAIL_REASONING_MAX : TAIL_TEXT_MAX);
    for (const field of ["name", "status", "messageId", "clientMessageId", "callId"] as const) {
      const value = str(raw[field]);
      if (value !== undefined) item[field] = value;
    }
    const message = raw.agentMessage;
    if (message && typeof message === "object") {
      const { sender, text: said, event } = message as Record<string, unknown>;
      const senderId = sender && typeof sender === "object" ? str((sender as Record<string, unknown>).id) : undefined;
      if (senderId !== undefined && typeof said === "string") {
        const title = str((sender as Record<string, unknown>).title);
        item.from = { id: senderId, ...(title !== undefined ? { title } : {}), event: str(event) ?? "message" };
        item.text = clip(said, TAIL_TEXT_MAX);
      }
    }
    const out: TailEntry = { item };
    if (typeof entry.seqStart === "number") out.seqStart = entry.seqStart;
    if (typeof entry.seqEnd === "number") out.seqEnd = entry.seqEnd;
    const timestamp = str(entry.timestamp);
    if (timestamp) out.timestamp = timestamp;
    return [out];
  });
}

/** A position in a session's timeline (Paseo's `{ epoch, seq }` cursor). */
export const timelineCursorSchema = z.object({ epoch: z.string().min(1).max(200), seq: z.number().int() });
export type TimelineCursor = z.infer<typeof timelineCursorSchema>;

/** One `sessions.tail` read with its paging state (SESSION-PANE-SPEC §1.4). */
export const tailPageSchema = z.object({
  entries: z.array(tailEntrySchema),
  epoch: z.string().optional(),
  startCursor: timelineCursorSchema.nullable().optional(),
  hasOlder: z.boolean().optional(),
  hasNewer: z.boolean().optional(),
  /** The timeline was rewritten (stale cursor, reset): drop what is loaded and read again. */
  reset: z.boolean().optional(),
});
export type TailPage = z.infer<typeof tailPageSchema>;

/** The current turn shown on open, at most this many entries. */
export const TURN_MAX_ENTRIES = 300;
/** One "Load earlier" page. */
export const HISTORY_PAGE = 100;
/** Loaded history per open session; beyond it, Paseo shows the full conversation. */
export const HISTORY_MAX = 1000;
/** A live refresh re-reads this many entries before the newest, so tool calls that finish late are updated. */
export const REFRESH_OVERLAP = 8;

/** The loaded part of a session's timeline, oldest first. */
export type TimelineWindow = {
  epoch: string;
  entries: TailEntry[];
  hasOlder: boolean;
  startCursor: TimelineCursor | null;
};

const identity = (entry: TailEntry) =>
  entry.seqStart ?? entry.item.messageId ?? entry.item.callId ?? entry.item.clientMessageId;

/** Entries by sequence; an entry of `newer` replaces the loaded one with the same identity. */
function combine(older: readonly TailEntry[], newer: readonly TailEntry[]) {
  const replaced = new Set(newer.map(identity).filter((id) => id !== undefined));
  const kept = older.filter((entry) => {
    const id = identity(entry);
    return id === undefined || !replaced.has(id);
  });
  const all = [...kept, ...newer];
  // Stable: entries without a sequence keep their place relative to their neighbours.
  return all
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.seqStart ?? Infinity) - (b.entry.seqStart ?? Infinity) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The window a full read starts; null when the read must be repeated (rewritten while paging). */
export function windowFromPage(page: TailPage): TimelineWindow | null {
  if (!page.epoch || page.reset) return null;
  return { epoch: page.epoch, entries: [...page.entries], hasOlder: !!page.hasOlder, startCursor: page.startCursor ?? null };
}

/** Where a live refresh starts reading (`after`), or null when the window must be read again. */
export function refreshCursor(window: TimelineWindow): TimelineCursor | null {
  const sequenced = window.entries.filter((e) => typeof e.seqStart === "number");
  const from = sequenced.at(-Math.min(REFRESH_OVERLAP, sequenced.length));
  return from ? { epoch: window.epoch, seq: from.seqStart! - 1 } : null;
}

/** Adds an `after` page to the window; null when the window must be read again from the end. */
export function mergeNewer(window: TimelineWindow, page: TailPage): TimelineWindow | null {
  if (page.reset || page.hasNewer || page.epoch !== window.epoch) return null;
  return { ...window, entries: combine(window.entries, page.entries) };
}

/**
 * Adds a `before` page, read at `requested`, in front of the window; null when
 * the window must be read again. A window that was replaced meanwhile (it no
 * longer starts at `requested`) is returned unchanged: gluing the page to it
 * would hide the entries in between.
 */
export function mergeOlder(window: TimelineWindow, page: TailPage, requested: TimelineCursor): TimelineWindow | null {
  if (page.reset || page.epoch !== window.epoch) return null;
  if (window.startCursor?.seq !== requested.seq || window.startCursor.epoch !== requested.epoch) return window;
  const first = window.entries[0]?.seqStart;
  const older = first === undefined ? page.entries : page.entries.filter((e) => (e.seqStart ?? -Infinity) < first);
  return {
    ...window,
    entries: combine(older, window.entries),
    hasOlder: !!page.hasOlder,
    startCursor: page.startCursor ?? window.startCursor,
  };
}

/** Whether "Load earlier" can read more (it stops at HISTORY_MAX entries). */
export function canLoadEarlier(window: TimelineWindow | undefined) {
  return !!window?.hasOlder && !!window.startCursor && window.entries.length < HISTORY_MAX;
}
