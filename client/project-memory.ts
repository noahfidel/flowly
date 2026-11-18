/**
 * The project last viewed on the board during this app run (PROJECT-TABS-SPEC).
 * Module state on purpose: it survives leaving and re-entering Flowly,
 * and a cold start (fresh client bundle) begins again at the first project.
 */
let lastViewed = "";
export const lastViewedProject = () => lastViewed;
export function rememberViewedProject(id: string | undefined) {
  if (id) lastViewed = id;
}

/**
 * The group view last viewed on the board during this run (BOARD-GROUPS-SPEC §3): a `*group:<id>` view id. Module
 * state like the above: it survives leaving and re-entering Flowly. A restart (a fresh client bundle) starts again from
 * the board-view settings' `lastGroupId`.
 */
let lastGroupView = "";
export const lastViewedGroupView = () => lastGroupView;
export function rememberViewedGroupView(viewId: string | undefined) {
  if (viewId) lastGroupView = viewId;
}

/**
 * The Project filter last set or cleared per group on a group board during this run (BOARD-GROUPS-SPEC §4, ruling, Noah
 * 2026-11-18: per-group filter). `undefined` for a group not touched in this run, so it starts from the board-view
 * settings' `projectFilters` (`restoredFilters`); `null` cleared. Always read through `validProjectFilter`, since the
 * group or project may be gone.
 */
const lastFilters = new Map<string, string | null>();
export const lastProjectFilter = (groupId: string): string | null | undefined => lastFilters.get(groupId);
export function rememberProjectFilter(groupId: string, projectId: string | null) {
  lastFilters.set(groupId, projectId);
}

/** Every group's filter a board starts with: this run's value for a group, else its stored one. */
export function restoredFilters(stored: Record<string, string>): Record<string, string> {
  const out = { ...stored };
  for (const [groupId, projectId] of lastFilters) {
    if (projectId === null) delete out[groupId];
    else out[groupId] = projectId;
  }
  return out;
}

/**
 * The board screen is mounted twice: as the main screen and as a card's workspace panel. Both share the module state
 * above and the host-stored board-view settings, so only the main board writes them; the panel is a view of its own
 * card and just reads the saved filter and group.
 */
export type BoardInstance = "board" | "panel";

/** Sets or clears one group's filter; the other groups' entries stay. `stored` is the map the board knows. */
export function writeProjectFilter(
  groupId: string,
  projectId: string | null,
  instance: BoardInstance,
  stored: Record<string, string>,
  store: (next: Record<string, string>) => void,
) {
  if (instance === "panel") return;
  rememberProjectFilter(groupId, projectId);
  if ((stored[groupId] ?? null) === projectId) return;
  const next = { ...stored };
  if (projectId === null) delete next[groupId];
  else next[groupId] = projectId;
  store(next);
}

/** `viewId` is the group's `*group:<id>` view id (board-groups `groupViewId`), passed in to keep this file import-free. */
export function writeViewedGroup(groupId: string, viewId: string, instance: BoardInstance, stored: string, store: (groupId: string) => void) {
  if (instance === "panel") return;
  rememberViewedGroupView(viewId);
  if (stored !== groupId) store(groupId);
}

/** Explicit choice, else the project last viewed in this run, else the first one. */
export function pickProject<T extends { id: string }>(projects: readonly T[], chosen: string, viewed: string): T | undefined {
  return projects.find((p) => p.id === chosen) || projects.find((p) => p.id === viewed) || projects[0];
}
