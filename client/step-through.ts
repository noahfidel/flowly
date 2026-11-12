import type { AttentionItem } from "../shared/attention";
import { openAskCount } from "../shared/attention";
import { waitsOnYou } from "../shared/attention-dismiss";
import type { CardChange, ChatItem } from "../shared/dispatcher";

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
 * What a press on a step-through chip (N need you / N updated, the N and U shortcuts, the phone bell) does (Ruling,
 * Noah 2026-11-09): with that kind already open it keeps the current card and place (`keep`: nothing is reopened;
 * restarting at the first one would silently mark every unread chat read, as each card's chat preview opens).
 * Otherwise it opens the kind's first card, except that Updates starts on the open card when it is in its queue, so its
 * bar never sits over a card it does not count (Ruling, Noah 2026-11-11). Null: the queue is empty.
 */
export function stepStartTarget(
  current: Step | null,
  currentKind: StepKind | null,
  kind: StepKind,
  queue: readonly string[],
  openTaskId: string | null,
): { taskId: string; keep: boolean } | null {
  if (current && currentKind === kind) return { taskId: current.taskId, keep: true };
  if (kind === "updated" && openTaskId && queue.includes(openTaskId)) return { taskId: openTaskId, keep: false };
  return queue[0] ? { taskId: queue[0], keep: false } : null;
}

/**
 * The bar's label and next control. In the queue: "i of N" and the › arrow. A card that left the queue stays shown:
 * Need you labels it "Answered" and offers Next card as the primary button; Updates has nothing answered (opening a
 * card reads its unread turn, which drops it mid-flip), so it keeps the plain arrow (Ruling, Noah 2026-11-11). With no
 * card left: "All caught up" and Done.
 */
export function stepBarState(
  kind: StepKind,
  position: { index: number | null; next: string | null },
): { where: "position" | "answered" | "none" | "caught-up"; next: "arrow" | "pill" | "done" } {
  if (position.index !== null) return { where: "position", next: "arrow" };
  if (!position.next) return { where: "caught-up", next: "done" };
  return kind === "needs" ? { where: "answered", next: "pill" } : { where: "none", next: "arrow" };
}

/**
 * The order of one updated walk (§9.4). The live queue is recomputed on every poll (newest change first, reads drop
 * cards, a new event moves a card to the front), so walking it directly made the neighbours of the card shown jump.
 * The walk keeps its own order instead: cards still in the live queue stay where they were, a card that changed
 * meanwhile joins at the end, and the card shown stays until the user leaves it.
 */
export function stableQueue(prev: readonly string[], live: readonly string[], shown: string | null): string[] {
  const liveSet = new Set(live);
  const kept = prev.filter((id) => liveSet.has(id) || id === shown);
  const known = new Set(kept);
  return [...kept, ...live.filter((id) => !known.has(id))];
}

/** The card the walk goes to once `taskId` was marked seen: the next one, else the first one before it; null when it was the only one. */
export function afterMarkSeen(queue: readonly string[], taskId: string): string | null {
  const rest = queue.filter((id) => id !== taskId);
  if (!rest.length) return null;
  const at = queue.indexOf(taskId);
  return at >= 0 && at < queue.length - 1 ? queue[at + 1] : rest[0];
}

/** What changed on a card, in plain words, for the picker (§9.2): "Moved to Committed · New result note". Empty when unknown. */
export function changeSummary(
  changes: readonly CardChange[] | undefined,
  t: (text: string, values?: Record<string, string | number>) => string,
  lane: (status: string) => string,
): string {
  const words = (c: CardChange) => {
    switch (c.kind) {
      case "moved":
        return c.status ? t("Moved to {lane}", { lane: lane(c.status) }) : t("Card updated");
      case "result":
        return t("New result note");
      case "question":
        return t("New question");
      case "blocker":
        return t("New blocker");
      case "session_finished":
        return t("Session finished");
      case "session_failed":
        return t("Session failed");
      case "note":
        return t("New progress note");
      default:
        return t("Card updated");
    }
  };
  const parts = (changes ?? []).map(words);
  // "Card updated" is only the fallback for bookkeeping, shown when nothing plainer happened.
  const plain = parts.filter((p) => p !== t("Card updated"));
  return [...new Set(plain.length ? plain : parts)].join(" · ");
}
