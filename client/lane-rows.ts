/** What the phone's lane list shows, top to bottom (PERFORMANCE-SPEC §3, virtualized lane list). */
export type LaneRow<T> =
  | { key: string; kind: "task"; task: T }
  /** No recent cards: the lane is empty, or only older finished cards remain. */
  | { key: "empty"; kind: "empty"; hasOlder: boolean }
  | { key: "older"; kind: "older" };

export function laneRows<T extends { id: string }>(recent: readonly T[], older: readonly T[], showOlder: boolean): LaneRow<T>[] {
  const rows: LaneRow<T>[] = recent.map((task) => ({ key: task.id, kind: "task", task }));
  if (!recent.length) rows.push({ key: "empty", kind: "empty", hasOlder: older.length > 0 });
  if (older.length) rows.push({ key: "older", kind: "older" });
  if (older.length && showOlder) for (const task of older) rows.push({ key: task.id, kind: "task", task });
  return rows;
}

/** The previous rows when nothing in them changed, so the list is not handed new data on every board render. */
export function sameRows<T>(prev: readonly LaneRow<T>[] | undefined, next: LaneRow<T>[]): LaneRow<T>[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i],
      b = next[i];
    if (a.key !== b.key || a.kind !== b.kind) return next;
    if (a.kind === "task" && b.kind === "task" && a.task !== b.task) return next;
    if (a.kind === "empty" && b.kind === "empty" && a.hasOlder !== b.hasOlder) return next;
  }
  return prev as LaneRow<T>[];
}

/** The lane a phone lane pager released at `x` rests on, clamped to its pages (UI-UX-SPEC §5, lane swipe). */
export function settledPage(x: number, width: number, count: number): number {
  if (!(width > 0) || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(x / width)));
}
