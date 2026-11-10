import type { AttentionItem } from "../shared/attention";
import { openAskCount } from "../shared/attention";
import { waitsOnYou } from "../shared/attention-dismiss";
import type { ChatItem } from "../shared/dispatcher";

/**
 * Pure parts of the step-throughs in the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09): "N need you"
 * walks the cards with open asks that wait on you, newest first, with each card's asks pinned on top; "N updated" walks
 * what is new to read: the cards the dispatcher saw change since you looked, then the cards with an unread turn. No React.
 */

export type AskItem = Extract<ChatItem, { kind: "ask" }>;
export type ChangeItem = Extract<ChatItem, { kind: "change" }>;
export type StepKind = "needs" | "updated";
/** The card shown and where it was in the queue when last seen there (to find its neighbours once it drops out). */
export type Step = { taskId: string; index: number };

const time = (value: string) => Date.parse(value) || 0;
/** A card's open signals (not dismissed, not resolved) of one side: what waits on you, or its unread turns. */
const openParts = (item: AttentionItem, resolved: ReadonlySet<string>, kind: StepKind) =>
  item.parts.filter((p) => !p.dismissed && !resolved.has(p.key) && waitsOnYou(p.kind) === (kind === "needs"));
const newestFirst = (items: readonly AttentionItem[]) => [...items].sort((a, b) => time(b.updatedAt) - time(a.updatedAt));

/** The cards in scope with at least one open ask that waits on you (not an unread turn), newest first. */
export function needsQueue(items: readonly AttentionItem[], resolved: ReadonlySet<string>, inScope: (projectId: string) => boolean): string[] {
  return newestFirst(items.filter((item) => inScope(item.task.projectId) && openParts(item, resolved, "needs").length)).map((item) => item.task.id);
}

/** "N need you": the bell's count (every open ask that waits on you, never unread turns), over the cards in scope. */
export function needsCount(items: readonly AttentionItem[], resolved: ReadonlySet<string>, inScope: (projectId: string) => boolean): number {
  return openAskCount(items.filter((item) => inScope(item.task.projectId)), resolved);
}

/**
 * "N updated", what is new to read, in scope, once each: the cards the dispatcher saw change since you looked, in its
 * order, then the cards with an open unread turn (a finished turn you have not opened), newest first.
 */
export function updatedQueue(
  change: ChangeItem | null,
  items: readonly AttentionItem[],
  resolved: ReadonlySet<string>,
  inScope: (projectId: string) => boolean,
): string[] {
  const changed = (change?.cards ?? []).filter((c) => inScope(c.projectId)).map((c) => c.taskId);
  const unread = newestFirst(items.filter((item) => inScope(item.task.projectId) && openParts(item, resolved, "updated").length));
  return [...new Set([...changed, ...unread.map((item) => item.task.id)])];
}

/**
 * The session a step opens in the card's sidebar: for "updated" its first unread one (opening it reads it); for
 * "need you" the one asking, when only one session waits. Null opens the card itself.
 */
export function stepSession(item: AttentionItem | undefined, kind: StepKind, resolved: ReadonlySet<string>): string | null {
  const agents = [...new Set((item ? openParts(item, resolved, kind) : []).map((p) => p.agentId))];
  return kind === "updated" ? (agents[0] ?? null) : agents.length === 1 ? agents[0] : null;
}

/** The change line among the chat items, when cards changed. */
export function changeItem(items: readonly ChatItem[] | undefined): ChangeItem | null {
  const change = (items ?? []).find((item): item is ChangeItem => item.kind === "change");
  return change && change.cards.length ? change : null;
}

/** A step on `taskId`, at its place in `queue`. */
export function stepAt(queue: readonly string[], taskId: string): Step {
  return { taskId, index: Math.max(0, queue.indexOf(taskId)) };
}

/**
 * Where the step is: "index + 1 of total" while its card is in the queue, with its neighbours. When the card dropped
 * out (its asks answered, here or elsewhere) it stays shown with `index: null`; next is the card that took its place.
 */
export function stepPosition(queue: readonly string[], step: Step): { index: number | null; total: number; prev: string | null; next: string | null } {
  const i = queue.indexOf(step.taskId);
  if (i >= 0) return { index: i, total: queue.length, prev: queue[i - 1] ?? null, next: queue[i + 1] ?? null };
  const at = Math.min(step.index, queue.length);
  return { index: null, total: queue.length, prev: queue[at - 1] ?? null, next: queue[at] ?? null };
}

/**
 * A need-you card's asks to pin in its sidebar: open ones newest first, then those whose session ended; not ones just
 * answered here, and no unread turns (they are in "N updated"; Ruling, Noah 2026-11-09).
 */
export function cardAsks(items: readonly ChatItem[] | undefined, taskId: string, answered: ReadonlySet<string> = new Set()): AskItem[] {
  const asks = (items ?? []).filter(
    (item): item is AskItem => item.kind === "ask" && item.taskId === taskId && !answered.has(item.signal) && waitsOnYou(item.askKind ?? "unread"),
  );
  const newest = (a: AskItem, b: AskItem) => time(b.at) - time(a.at);
  return [...asks.filter((a) => a.state === "open").sort(newest), ...asks.filter((a) => a.state === "session_ended").sort(newest)];
}

/**
 * What a press on a step-through chip (N need you / N updated, the N shortcut, the phone bell) does (Ruling, Noah
 * 2026-11-09): with that kind already open it keeps the current card (restarting at the first one would silently mark
 * every unread chat read, as each card's chat preview opens); otherwise it starts at the kind's first card.
 */
export function stepStartTarget(current: Step | null, currentKind: StepKind | null, kind: StepKind, queue: readonly string[]): string | null {
  if (current && currentKind === kind) return current.taskId;
  return queue[0] ?? null;
}
