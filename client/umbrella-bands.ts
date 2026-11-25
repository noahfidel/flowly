import type { UmbrellaSummary } from "../shared/umbrella";
import type { LaneRow } from "./lane-rows";

/** One umbrella band inside a lane (UMBRELLA-SPEC §7, group by umbrella); `id` null is "No umbrella", whose title is "" (translated where drawn). */
export type UmbrellaBand<T> = { id: string | null; title: string; tasks: T[] };

type Member = { umbrella?: { id: string } };

/** A band's key for its collapsed state and row keys: the umbrella id, "" for No umbrella. */
export const bandKey = (id: string | null): string => id ?? "";

/**
 * A lane's cards in bands: one per umbrella with a card among `tasks`, by umbrella title (then id), then "No umbrella"
 * last. Each band keeps the order of `tasks` (the board's sort). A card whose umbrella is not listed goes to No umbrella.
 */
export function umbrellaBands<T extends Member>(tasks: readonly T[], umbrellas: readonly Pick<UmbrellaSummary, "id" | "title">[]): UmbrellaBand<T>[] {
  const titles = new Map(umbrellas.map((u) => [u.id, u.title]));
  const byId = new Map<string, T[]>();
  const none: T[] = [];
  for (const task of tasks) {
    const id = task.umbrella?.id;
    if (id === undefined || !titles.has(id)) {
      none.push(task);
      continue;
    }
    const list = byId.get(id);
    if (list) list.push(task);
    else byId.set(id, [task]);
  }
  const bands: UmbrellaBand<T>[] = [...byId.entries()]
    .map(([id, list]) => ({ id, title: titles.get(id) ?? "", tasks: list }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (none.length) bands.push({ id: null, title: "", tasks: none });
  return bands;
}

/** The lane's cards in band order (the order the board draws them with bands on), for keyboard moves and drop slots. */
export function bandedOrder<T extends Member>(tasks: readonly T[], umbrellas: readonly Pick<UmbrellaSummary, "id" | "title">[]): T[] {
  return umbrellaBands(tasks, umbrellas).flatMap((b) => b.tasks);
}

/**
 * Move up / Move down with bands on (phone card menu): the `tasks.place` anchor that steps the card past its band-mate
 * above (before it) or below (after it) among the lane's drawn rows. Null at the band's edge (a header or the older
 * toggle is next), and for a card not drawn (a folded band): then nothing moves.
 */
export function bandStep<T extends { id: string }>(rows: readonly LaneRow<T>[], taskId: string, direction: "up" | "down"): { beforeId: string | null; afterId: string | null } | null {
  const at = rows.findIndex((r) => r.kind === "task" && r.task.id === taskId);
  if (at < 0) return null;
  const next = rows[direction === "up" ? at - 1 : at + 1];
  if (!next || next.kind !== "task") return null;
  return direction === "up" ? { beforeId: next.task.id, afterId: null } : { beforeId: null, afterId: next.task.id };
}

/** The phone lane's rows for its bands: a header per band, then its cards unless the band is collapsed. */
export function bandRows<T extends { id: string }>(bands: readonly UmbrellaBand<T>[], collapsed: ReadonlySet<string>): LaneRow<T>[] {
  return bands.flatMap((band) => {
    const key = bandKey(band.id);
    const folded = collapsed.has(key);
    const header: LaneRow<T> = { key: `band:${key}`, kind: "band", id: band.id, title: band.title, count: band.tasks.length, collapsed: folded };
    return folded ? [header] : [header, ...band.tasks.map((task): LaneRow<T> => ({ key: task.id, kind: "task", task }))];
  });
}
