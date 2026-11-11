import type { MenuEntry } from "./context-menu";

export type Submenu = Extract<MenuEntry, { kind: "submenu" }>;
export const BACK = "__back";

/** Entries on screen for a trail of opened submenus: the last one's children behind a Back row. */
export function visibleEntries(root: MenuEntry[], trail: Submenu[]): MenuEntry[] {
  const last = trail[trail.length - 1];
  if (!last) return root;
  return [{ id: BACK, label: last.label, icon: "ChevronLeft", onPress: () => {} }, { kind: "separator", id: `${BACK}-s` }, ...last.entries];
}

/** The trail on every open: back at the root. */
export function freshTrail(): Submenu[] {
  return [];
}

/** Drilling into a submenu. */
export function drillIn(trail: Submenu[], entry: Submenu): Submenu[] {
  return [...trail, entry];
}

/** The Back row. */
export function stepBack(trail: Submenu[]): Submenu[] {
  return trail.slice(0, -1);
}

/** Esc / system Back: steps out of a submenu, else closes the menu. */
export function escapeStep(trail: Submenu[]): { trail: Submenu[]; close: boolean } {
  return trail.length ? { trail: stepBack(trail), close: false } : { trail, close: true };
}
