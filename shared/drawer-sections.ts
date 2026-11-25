/** Layout of the card sidebar: section order and which sections start open (DRAWER-SPEC, Section order). Pure; the values live in the host-scoped board-view settings. */

/** Sections the user can move. Description stays first; Details, Usage and Activity stay last. */
export const drawerSections = ["progress", "sessions", "workpad", "artifacts", "gallery", "ideas", "links", "umbrella"] as const;
export type DrawerSection = (typeof drawerSections)[number];

/** Sections that always sit at the bottom, in this order; they can only start open or closed. */
export const fixedDrawerSections = ["details", "usage", "activity"] as const;
export type FixedDrawerSection = (typeof fixedDrawerSections)[number];
export type AnyDrawerSection = DrawerSection | FixedDrawerSection;

/** Whether a section starts open when the sidebar opens, before the user's choice. */
export const defaultSectionOpen: Record<AnyDrawerSection, boolean> = {
  progress: true,
  workpad: true,
  artifacts: true,
  gallery: true,
  sessions: true,
  ideas: true,
  links: false,
  umbrella: false,
  details: false,
  usage: false,
  activity: false,
};

const known = new Set<string>(drawerSections);
const anyKnown = new Set<string>([...drawerSections, ...fixedDrawerSections]);

/** Which sections start open: the stored choices over the defaults; unknown ids are ignored. */
export function drawerSectionsOpen(stored: Readonly<Record<string, boolean>> | null | undefined): Record<AnyDrawerSection, boolean> {
  const open = { ...defaultSectionOpen };
  for (const [id, value] of Object.entries(stored || {})) if (anyKnown.has(id) && typeof value === "boolean") open[id as AnyDrawerSection] = value;
  return open;
}

/** The stored choices after setting one section; a choice equal to the default is dropped, unknown ids are kept. */
export function withSectionOpen(stored: Readonly<Record<string, boolean>>, id: AnyDrawerSection, open: boolean): Record<string, boolean> {
  const next = { ...stored };
  delete next[id];
  if (open !== defaultSectionOpen[id]) next[id] = open;
  return next;
}

/**
 * The effective order from the stored list: known ids in their stored order
 * (duplicates dropped), then any section the list lacks (a newer section, or
 * an older client's value) inserted after the section that precedes it by
 * default. Unknown ids are ignored, so a newer client's value never breaks an older one.
 */
export function drawerSectionOrder(stored: readonly string[] | null | undefined): DrawerSection[] {
  const order = [...new Set((stored || []).filter((id) => known.has(id)))] as DrawerSection[];
  drawerSections.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = drawerSections.slice(0, index).reverse().find((previous) => order.includes(previous));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return order;
}

/** The stored list after moving `id` to position `to` of the effective order; unknown stored ids are kept at the end. */
export function withDrawerSectionMoved(stored: readonly string[], id: DrawerSection, to: number): string[] {
  const order = drawerSectionOrder(stored).filter((x) => x !== id);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
  return [...order, ...stored.filter((x) => !known.has(x))];
}

/** Whether the effective order is the default one. */
export function isDefaultDrawerOrder(stored: readonly string[]): boolean {
  return drawerSectionOrder(stored).every((id, index) => id === drawerSections[index]);
}

/** Whether every section starts open or closed as by default. */
export function isDefaultDrawerOpen(stored: Readonly<Record<string, boolean>>): boolean {
  const open = drawerSectionsOpen(stored);
  return (Object.keys(defaultSectionOpen) as AnyDrawerSection[]).every((id) => open[id] === defaultSectionOpen[id]);
}

/** Stored values for the default layout; unknown ids (from newer clients) are kept. */
export function defaultDrawerLayout(order: readonly string[], open: Readonly<Record<string, boolean>>) {
  return {
    drawerOrder: order.filter((id) => !known.has(id)),
    drawerOpen: Object.fromEntries(Object.entries(open).filter(([id]) => !anyKnown.has(id))),
  };
}
