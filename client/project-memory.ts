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
 * The Project filter last set or cleared on a group board during this run (BOARD-GROUPS-SPEC §4); `undefined` until
 * then, so a fresh run starts from the board-view settings' `lastFilter` (`restoredFilter`). Always read through
 * `validProjectFilter`, since the group or project may be gone.
 */
let lastFilter: { groupId: string; projectId: string } | null | undefined = undefined;
export const lastProjectFilter = () => lastFilter;
export function rememberProjectFilter(filter: { groupId: string; projectId: string } | null) {
  lastFilter = filter;
}

/**
 * The board screen is mounted twice: as the main screen and as a card's workspace panel. Both share the module state
 * above and the host-stored board-view settings, so only the main board writes them; the panel is a view of its own
 * card and just reads the saved filter and group.
 */
export type BoardInstance = "board" | "panel";

export function writeProjectFilter(
  next: { groupId: string; projectId: string } | null,
  instance: BoardInstance,
  stored: { groupId: string; projectId: string } | null,
  store: (filter: { groupId: string; projectId: string } | null) => void,
) {
  if (instance === "panel") return;
  rememberProjectFilter(next);
  if (JSON.stringify(stored) !== JSON.stringify(next)) store(next);
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
