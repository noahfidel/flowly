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

/** Explicit choice, else the project last viewed in this run, else the first one. */
export function pickProject<T extends { id: string }>(projects: readonly T[], chosen: string, viewed: string): T | undefined {
  return projects.find((p) => p.id === chosen) || projects.find((p) => p.id === viewed) || projects[0];
}

/**
 * The board's view (ALL-PROJECTS-SPEC §8, BOARD-GROUPS-SPEC §6): `allId` ("All projects") counts as one more choice
 * while `allOk`, and so does each group's view id in `groupViews`; explicit choice, else the view last viewed in this
 * run, else the first project. A multi-project view returns its id in `view`.
 */
export function pickView<T extends { id: string }>(
  projects: readonly T[],
  chosen: string,
  viewed: string,
  all: { id: string; ok: boolean },
  groupViews: readonly string[] = [],
): { all: true; view: string; project?: undefined } | { all: false; project: T | undefined } {
  const multi = (id: string) => (all.ok && id === all.id) || (!!id && groupViews.includes(id));
  const choice = (id: string) => (multi(id) ? id : projects.find((p) => p.id === id));
  const picked = choice(chosen) || choice(viewed);
  if (typeof picked === "string") return { all: true, view: picked };
  return { all: false, project: picked || projects[0] };
}

/**
 * An explicit All choice the board had to fall back from (setting off, fewer than two live projects) is
 * dropped, so the board does not jump back to All when it becomes available again (ALL-PROJECTS-SPEC §8).
 * Only decide once the projects and settings are loaded (`ready`): an empty list while loading is not a fallback.
 */
export function staleAllChoice(chosen: string, all: { id: string; ok: boolean }, ready: boolean): boolean {
  return ready && chosen === all.id && !all.ok;
}
