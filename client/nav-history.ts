/**
 * Back and Forward through what the user opened (UI-REFRESH-SPEC §7ae): a stack of places with a pointer, per window,
 * in memory. Separate from the unread step-through (`step-through.ts`), which is a queue of what needs attention and
 * keeps its own Next/Previous; a walk's opens are recorded here like any other open. Pure: nothing here reads or marks
 * read state; applying an entry is only ever an open (`navOpenAction`).
 */

/** A place: a card (and the session shown in it, "" = its details), a group's dispatcher chat, or nothing open. */
export type NavEntry =
  | { kind: "board"; groupId?: string }
  | { kind: "card"; taskId: string; sessionId?: string }
  | { kind: "dispatcher"; groupId: string };

export interface NavHistory {
  readonly entries: readonly NavEntry[];
  /** The entry shown; -1 only when nothing is recorded (or every entry up to it disappeared). */
  readonly index: number;
}

export type NavDirection = "back" | "forward";

export const navHistoryCap = 50;
export const emptyNavHistory: NavHistory = { entries: [], index: -1 };

/** Same place: the same card (whatever its session), the same group's dispatcher, or both nothing open (boards of two known groups differ). */
export function samePlace(a: NavEntry, b: NavEntry): boolean {
  if (a.kind === "card") return b.kind === "card" && a.taskId === b.taskId;
  if (a.kind === "dispatcher") return b.kind === "dispatcher" && a.groupId === b.groupId;
  return b.kind === "board" && (a.groupId === undefined || b.groupId === undefined || a.groupId === b.groupId);
}

function copy(entry: NavEntry): NavEntry {
  if (entry.kind === "card") return entry.sessionId === undefined ? { kind: "card", taskId: entry.taskId } : { kind: "card", taskId: entry.taskId, sessionId: entry.sessionId };
  return entry.kind === "dispatcher" ? { kind: "dispatcher", groupId: entry.groupId } : entry.groupId === undefined ? { kind: "board" } : { kind: "board", groupId: entry.groupId };
}

function replaceAt(history: NavHistory, entry: NavEntry): NavHistory {
  const entries = history.entries.slice();
  entries[history.index] = copy(entry);
  return { entries, index: history.index };
}

/**
 * The place now shown. Returns the same object when nothing changes, so a caller's state update is a no-op.
 * - The same place as the current entry records nothing, except that a card's known session replaces the one stored
 *   (switching sessions inside a card never adds an entry; `sessionId` undefined means not known yet).
 * - Another group's dispatcher replaces a dispatcher entry: the dock follows the group shown.
 * - Anything else truncates the forward part, then is pushed; the oldest entries beyond the cap are dropped.
 */
export function recordLocation(history: NavHistory, location: NavEntry): NavHistory {
  const current = history.entries[history.index];
  if (!current) return { entries: [...history.entries.slice(0, Math.max(0, history.index + 1)), copy(location)].slice(-navHistoryCap), index: Math.min(history.index + 1, navHistoryCap - 1) };
  if (samePlace(current, location)) {
    if (current.kind === "card" && location.kind === "card" && location.sessionId !== undefined && location.sessionId !== current.sessionId)
      return replaceAt(history, location);
    return history;
  }
  if (current.kind === "dispatcher" && location.kind === "dispatcher") return replaceAt(history, location);
  const entries = [...history.entries.slice(0, history.index + 1), copy(location)].slice(-navHistoryCap);
  return { entries, index: entries.length - 1 };
}

/** Drops dead entries and folds a place that pruning brings next to itself; `map[i]` is entry i's new index, -1 when dropped. */
function pruned(history: NavHistory, isAlive: (entry: NavEntry) => boolean) {
  const entries: NavEntry[] = [];
  const map: number[] = [];
  history.entries.forEach((entry) => {
    if (!isAlive(entry)) return void map.push(-1);
    const last = entries[entries.length - 1];
    if (last && samePlace(last, entry)) {
      entries[entries.length - 1] = entry; // the later entry holds the session shown last
      return void map.push(entries.length - 1);
    }
    entries.push(entry);
    map.push(entries.length - 1);
  });
  return { entries, map };
}

/** The history without dead entries; the pointer stays on the place shown, else the nearest older one left. */
export function pruneNavHistory(history: NavHistory, isAlive: (entry: NavEntry) => boolean): NavHistory {
  const { entries, map } = pruned(history, isAlive);
  if (entries.length === history.entries.length) return history;
  let index = -1;
  for (let i = history.index; i >= 0 && index < 0; i--) index = map[i];
  return { entries, index };
}

/** The index of the next entry a step reaches: alive, and not the place already shown. */
function target(history: NavHistory, direction: NavDirection, isAlive: (entry: NavEntry) => boolean): number {
  const current = history.entries[history.index];
  const delta = direction === "back" ? -1 : 1;
  for (let i = history.index + delta; i >= 0 && i < history.entries.length; i += delta) {
    const entry = history.entries[i];
    if (isAlive(entry) && !(current && samePlace(current, entry))) return i;
  }
  return -1;
}

/** Whether Back (or Forward) has a reachable entry; drives the buttons' disabled state. */
export function canNavStep(history: NavHistory, direction: NavDirection, isAlive: (entry: NavEntry) => boolean): boolean {
  return target(history, direction, isAlive) >= 0;
}

/** One step: the entry to open and the pruned history pointing at it; null when nothing is reachable that way. */
export function navStep(
  history: NavHistory,
  direction: NavDirection,
  isAlive: (entry: NavEntry) => boolean,
): { history: NavHistory; entry: NavEntry } | null {
  const at = target(history, direction, isAlive);
  if (at < 0) return null;
  const { entries, map } = pruned(history, isAlive);
  const index = map[at];
  return { history: { entries, index }, entry: entries[index] };
}

/**
 * Whether an entry can still be opened (§7ae skip rules). A card: it exists, is not archived, is not in Done or
 * Cancelled, and its project exists and is live. A dispatcher: its group exists. The bare board always. `tasks` null
 * (no full overview yet: a cold link's board holds only its own card) or no groups known: nothing counts as gone.
 */
export function navAlive(index: {
  tasks: readonly { id: string; projectId: string; status: string; archivedAt?: string | null }[] | null;
  projects: readonly { id: string; archivedAt?: string | null }[] | null;
  groups: readonly { id: string }[];
}): (entry: NavEntry) => boolean {
  const tasks = index.tasks ? new Map(index.tasks.map((t) => [t.id, t])) : null;
  const projects = new Map((index.projects ?? []).map((p) => [p.id, p]));
  const groups = new Set(index.groups.map((g) => g.id));
  return (entry) => {
    if (entry.kind === "board") return true;
    if (entry.kind === "dispatcher") return !groups.size || groups.has(entry.groupId);
    if (!tasks) return true;
    const task = tasks.get(entry.taskId);
    if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") return false;
    const project = projects.get(task.projectId);
    return !!project && !project.archivedAt;
  };
}

/** What applying an entry does: an open through the board's normal paths, never a read-state change. */
export type NavOpenAction =
  | { kind: "open-card"; taskId: string; sessionId: string }
  | { kind: "open-dispatcher"; groupId: string }
  | { kind: "show-board"; groupId?: string };

export function navOpenAction(entry: NavEntry): NavOpenAction {
  if (entry.kind === "card") return { kind: "open-card", taskId: entry.taskId, sessionId: entry.sessionId ?? "" };
  if (entry.kind === "dispatcher") return { kind: "open-dispatcher", groupId: entry.groupId };
  return entry.groupId === undefined ? { kind: "show-board" } : { kind: "show-board", groupId: entry.groupId };
}
