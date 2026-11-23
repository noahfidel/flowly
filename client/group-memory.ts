import type { Status } from "../shared/model";
import type { NavEntry, NavHistory } from "./nav-history";
import type { BoardInstance } from "./project-memory";

/**
 * What each board group remembers for the app run (BOARD-GROUPS-SPEC §3, *Per-group view state*, ruling 2026-11-23):
 * the place last shown in it (its open card and session; on phones also the dispatcher chat page), its Back/Forward
 * history (UI-REFRESH-SPEC §7ae) and its scroll. Kept on `globalThis` per host and group, so it survives leaving
 * Flowly and a re-run of the plugin client; nothing here is stored. Only the main board writes (`instance`); the
 * card's workspace panel reads. The filters and collapsed lanes are saved in `board-view` instead (`shared/settings`).
 * No React.
 */

/** The desktop board's sideways offset, each lane's vertical offset, and the phone's current lane. */
export type GroupScroll = { x: number; y: Partial<Record<Status, number>>; lane?: Status };

type Store = {
  places: Map<string, NavEntry>;
  histories: Map<string, NavHistory>;
  scrolls: Map<string, GroupScroll>;
};

const storeKey = Symbol.for("flowly.groupMemory");
const store = (): Store => {
  const holder = globalThis as unknown as Record<symbol, Store | undefined>;
  return (holder[storeKey] ??= { places: new Map(), histories: new Map(), scrolls: new Map() });
};

const keyOf = (hostId: string, groupId: string) => `${hostId}|${groupId}`;

/** The place last shown in a group, or undefined when it was never shown in this run. */
export function placeOf(hostId: string, groupId: string): NavEntry | undefined {
  return store().places.get(keyOf(hostId, groupId));
}

/** Records the place now shown in the group shown (any change of it, by any path). */
export function rememberPlace(instance: BoardInstance, hostId: string, groupId: string, place: NavEntry): void {
  if (instance === "panel" || !groupId) return;
  store().places.set(keyOf(hostId, groupId), place);
}

/** A group's Back/Forward history as left; undefined when it has none yet. */
export function historyOf(hostId: string, groupId: string): NavHistory | undefined {
  return store().histories.get(keyOf(hostId, groupId));
}

export function rememberHistory(instance: BoardInstance, hostId: string, groupId: string, history: NavHistory): void {
  if (instance === "panel" || !groupId) return;
  store().histories.set(keyOf(hostId, groupId), history);
}

export function scrollOf(hostId: string, groupId: string): GroupScroll | undefined {
  return store().scrolls.get(keyOf(hostId, groupId));
}

/** Merges a scroll change into the group's entry. Cheap: called from scroll events, nothing re-renders. */
export function rememberScroll(instance: BoardInstance, hostId: string, groupId: string, patch: Partial<GroupScroll>): void {
  if (instance === "panel" || !groupId) return;
  const key = keyOf(hostId, groupId);
  const current = store().scrolls.get(key) ?? { x: 0, y: {} };
  store().scrolls.set(key, { ...current, ...patch });
}

/** Drops the entries of this host's groups that no longer exist (called once the groups are loaded). */
export function pruneGroups(instance: BoardInstance, hostId: string, liveGroupIds: readonly string[]): void {
  if (instance === "panel" || !liveGroupIds.length) return;
  const live = new Set(liveGroupIds.map((id) => keyOf(hostId, id)));
  const prefix = `${hostId}|`;
  const s = store();
  [s.places, s.histories, s.scrolls].forEach((map: Map<string, unknown>) => {
    for (const key of [...map.keys()]) if (key.startsWith(prefix) && !live.has(key)) map.delete(key);
  });
}

/** What the auto-open of a group that needs you would open (`groupSwitchOpen`). */
export type AutoOpen = { kind: "dispatcher" } | { kind: "card"; taskId: string };

export type GroupArrival =
  | { kind: "restore"; entry: NavEntry }
  | { kind: "auto"; open: AutoOpen }
  | { kind: "board" };

/**
 * What a group shows on arrival (BOARD-GROUPS-SPEC §3): its remembered open card (with its session), on phones also its
 * remembered dispatcher chat page; else what its "N need you" opens (`auto`, only for a tab or switcher switch); else
 * the bare group board. `isAlive` judges the place in the target group (`navAlive` with its members): a card that was
 * deleted, archived, finished or moved to a project of another group is dropped.
 */
export function groupArrival(place: NavEntry | undefined, isAlive: (entry: NavEntry) => boolean, compact: boolean, auto: AutoOpen | null): GroupArrival {
  if (place && (place.kind === "card" || (place.kind === "dispatcher" && compact)) && isAlive(place)) return { kind: "restore", entry: place };
  if (auto) return { kind: "auto", open: auto };
  return { kind: "board" };
}
