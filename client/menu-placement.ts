export type MenuPoint = { x: number; y: number };
export type MenuSize = { width: number; height: number };
/** Entry kinds that matter for height (kept structural so this module stays free of React). */
export type SizedEntry = { kind?: string };

/** Estimated height of a menu: item 30 (40 on touch), separator 9, label 22, plus 10 (padding and border). */
export function menuHeight(entries: SizedEntry[], touch: boolean): number {
  let height = 10;
  for (const entry of entries) height += entry.kind === "separator" ? 9 : entry.kind === "label" ? 22 : touch ? 40 : 30;
  return height;
}

/**
 * Where a popover goes, in coordinates of `origin` (the board's own box). It opens below the point when it fits,
 * else above it when that fits, else it is pinned to the top margin and scrolls within `maxHeight`.
 */
export function placeMenu({
  at,
  origin,
  width,
  height,
  margin = 4,
}: {
  at: MenuPoint;
  origin: MenuSize & MenuPoint;
  width: number;
  height: number;
  margin?: number;
}): { left: number; top: number; maxHeight: number } {
  const maxHeight = Math.max(0, origin.height - 2 * margin);
  const x = at.x - origin.x;
  const y = Math.max(margin, Math.min(at.y - origin.y, origin.height - margin));
  const left = Math.max(margin, Math.min(x, origin.width - width - margin));
  const shown = Math.min(height, maxHeight);
  if (y + shown <= origin.height - margin) return { left, top: Math.max(margin, y), maxHeight };
  if (y - shown >= margin) return { left, top: y - shown, maxHeight };
  return { left, top: margin, maxHeight };
}
