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
 * The group view last viewed on the board during this run (BOARD-GROUPS-SPEC §6): a `*group:<id>` view id.
 * Module state like the above: it survives leaving and re-entering Flowly; a cold start opens the default group.
 */
let lastGroupView = "";
export const lastViewedGroupView = () => lastGroupView;
export function rememberViewedGroupView(viewId: string | undefined) {
  if (viewId) lastGroupView = viewId;
}

/** Explicit choice, else the project last viewed in this run, else the first one. */
export function pickProject<T extends { id: string }>(projects: readonly T[], chosen: string, viewed: string): T | undefined {
  return projects.find((p) => p.id === chosen) || projects.find((p) => p.id === viewed) || projects[0];
}
