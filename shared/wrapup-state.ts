import type { BoardEvent } from "./model";

const wrapActions = new Set(["wrapped_up", "workspace_auto_archived"]);

/**
 * The card's latest wrap-up, while it still applies: not followed by a
 * workspace restore or a move back to an unfinished status. Null otherwise.
 */
export function currentWrapup(events: readonly BoardEvent[], taskId: string): BoardEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (wrapActions.has(e.action)) return e;
    if (e.action === "workspace_restored") return null;
    if (e.action === "status_changed" && e.to && e.to !== "done" && e.to !== "cancelled") return null;
  }
  return null;
}

/**
 * Every task whose latest wrap-up still applies: the same answer as `currentWrapup(events, id) !== null` for each
 * task, in one forward pass.
 */
export function wrappedUpTaskIds(events: readonly BoardEvent[]): Set<string> {
  const wrapped = new Set<string>();
  for (const e of events) {
    if (wrapActions.has(e.action)) wrapped.add(e.taskId);
    else if (e.action === "workspace_restored") wrapped.delete(e.taskId);
    else if (e.action === "status_changed" && e.to && e.to !== "done" && e.to !== "cancelled") wrapped.delete(e.taskId);
  }
  return wrapped;
}
