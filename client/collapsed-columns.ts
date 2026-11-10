import type { Status } from "../shared/model";

/**
 * The collapsed lanes the board draws before and after its view settings load (Ruling, Noah 2026-11-09). Paseo re-runs
 * the plugin client after navigations, and the settings arrive a moment after the board mounts: drawing "none
 * collapsed" first and animating to the stored set was a visible flash. The last known set is kept per host on
 * `globalThis` (it survives a client re-run); the lanes are drawn only once a set is known, and a lane animates only
 * on the user's own toggle. No React.
 */

const key = Symbol.for("flowly.collapsedColumns");
type Store = Map<string, Status[]>;
const store = (): Store => {
  const holder = globalThis as unknown as Record<symbol, Store | undefined>;
  return (holder[key] ??= new Map());
};

export function rememberCollapsed(hostId: string, collapsed: readonly Status[]): void {
  store().set(hostId, [...collapsed]);
}

export function lastCollapsed(hostId: string): Status[] | undefined {
  return store().get(hostId);
}

/** The set to draw now: the stored one once loaded, else the last known one, else none yet (`ready: false`: draw no lanes). */
export function shownCollapsed(stored: readonly Status[] | undefined | null, remembered: readonly Status[] | undefined): { ready: boolean; collapsed: readonly Status[] } {
  if (stored) return { ready: true, collapsed: stored };
  if (remembered) return { ready: true, collapsed: remembered };
  return { ready: false, collapsed: [] };
}

/** Whether a lane animates when its collapsed state changes: only for a status the user just toggled. */
export function animatesCollapse(toggled: ReadonlySet<Status>, status: Status): boolean {
  return toggled.has(status);
}
