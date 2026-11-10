import type { AttentionItem } from "../shared/attention";
import { openAskCount } from "../shared/attention";
import type { ChatItem } from "../shared/dispatcher";

/**
 * Pure parts of the step-throughs in the card sidebar (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09): "N need you"
 * walks the cards with open asks, newest first, with each card's asks pinned on top; "N updated" walks the cards the
 * dispatcher saw change since you looked. No React.
 */

export type AskItem = Extract<ChatItem, { kind: "ask" }>;
export type ChangeItem = Extract<ChatItem, { kind: "change" }>;
export type StepKind = "needs" | "updated";
/** The card shown and where it was in the queue when last seen there (to find its neighbours once it drops out). */
export type Step = { taskId: string; index: number };

const time = (value: string) => Date.parse(value) || 0;
const open = (item: AttentionItem, resolved: ReadonlySet<string>) => item.parts.some((p) => !p.dismissed && !resolved.has(p.key));

/** The cards in scope with at least one open ask (not dismissed, not resolved), newest first. */
export function needsQueue(items: readonly AttentionItem[], resolved: ReadonlySet<string>, inScope: (projectId: string) => boolean): string[] {
  return items
    .filter((item) => inScope(item.task.projectId) && open(item, resolved))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
    .map((item) => item.task.id);
}

/** The merged "N need you": the bell's count (every open ask of every kind), over the cards in scope. */
export function needsCount(items: readonly AttentionItem[], resolved: ReadonlySet<string>, inScope: (projectId: string) => boolean): number {
  return openAskCount(items.filter((item) => inScope(item.task.projectId)), resolved);
}

/** The cards the dispatcher saw change since you looked, in scope, once each, in its order. Never asks. */
export function updatedQueue(change: ChangeItem | null, inScope: (projectId: string) => boolean): string[] {
  return [...new Set((change?.cards ?? []).filter((c) => inScope(c.projectId)).map((c) => c.taskId))];
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

/** A card's asks to pin in its sidebar: open ones newest first, then those whose session ended; not ones just answered here. */
export function cardAsks(items: readonly ChatItem[] | undefined, taskId: string, answered: ReadonlySet<string> = new Set()): AskItem[] {
  const asks = (items ?? []).filter((item): item is AskItem => item.kind === "ask" && item.taskId === taskId && !answered.has(item.signal));
  const newest = (a: AskItem, b: AskItem) => time(b.at) - time(a.at);
  return [...asks.filter((a) => a.state === "open").sort(newest), ...asks.filter((a) => a.state === "session_ended").sort(newest)];
}
