import { useEffect, useMemo, useRef, useState } from "react";
import { historyOf, rememberHistory, rememberPlace } from "./group-memory";
import { canNavStep, emptyNavHistory, navStep, recordLocation, samePlace, type NavDirection, type NavEntry, type NavHistory } from "./nav-history";
import type { BoardInstance } from "./project-memory";
import { useStableCallback } from "./stable";

/** How long the places shown on the way to an entry Back/Forward opened are not recorded (the dock's open is async). */
const applyWindowMs = 1500;

function placeKey(entry: NavEntry | null) {
  if (!entry) return "";
  return entry.kind === "card" ? `card|${entry.taskId}` : entry.kind === "dispatcher" ? `dispatcher|${entry.groupId}` : "board";
}

/**
 * Back/Forward history of the group shown (UI-REFRESH-SPEC §7ae; one history per group, ruling 2026-11-23). `location`
 * is the place shown (null until the board can say: the overview and settings are read); every change is recorded in
 * the shown group's stack, so every open path (cards, links, search, the step-through) adds its entry without being
 * touched. A group change records nothing in the group left; the place a group shows on arrival is recorded in its own
 * stack, which leaves a stack as it was when the group returns to its remembered place. Histories and places are kept
 * for the app run in `group-memory`; the workspace panel (`instance`) reads them and keeps its own changes local.
 * `reportSession` records the session the open card shows. `apply` opens an entry through the board's normal open paths.
 */
export function useNavHistory({
  hostId,
  groupId,
  instance,
  location,
  isAlive,
  apply,
}: {
  hostId: string;
  /** The group shown; "" while none is known. */
  groupId: string;
  instance: BoardInstance;
  location: NavEntry | null;
  isAlive(entry: NavEntry): boolean;
  apply(entry: NavEntry): void;
}) {
  // This board's view of every group's history: the module store's, then this board's own changes (the source of truth
  // between renders, so two quick presses step twice).
  const own = useRef(new Map<string, NavHistory>());
  const read = (group: string) => own.current.get(group) ?? historyOf(hostId, group) ?? emptyNavHistory;
  const [, bump] = useState(0);
  const pending = useRef<{ entry: NavEntry; until: number } | null>(null);
  const commit = (group: string, next: NavHistory) => {
    if (next === read(group)) return;
    own.current.set(group, next);
    rememberHistory(instance, hostId, group, next);
    bump((n) => n + 1);
  };
  const accept = useStableCallback((place: NavEntry) => {
    rememberPlace(instance, hostId, groupId, place);
    const applying = pending.current;
    if (applying) {
      if (samePlace(applying.entry, place)) pending.current = null;
      else if (Date.now() < applying.until) return;
      else pending.current = null;
    }
    commit(groupId, recordLocation(read(groupId), place));
  });
  // A step in the group left never holds back recording in the group shown (runs before the record below).
  useEffect(() => {
    pending.current = null;
  }, [groupId]);
  const key = `${groupId}#${placeKey(location)}`;
  useEffect(() => {
    if (location) accept(location);
  }, [key]);
  const reportSession = useStableCallback((taskId: string, sessionId: string) => accept({ kind: "card", taskId, sessionId }));
  const go = useStableCallback((direction: NavDirection) => {
    const step = navStep(read(groupId), direction, isAlive);
    if (!step) return false;
    pending.current = { entry: step.entry, until: Date.now() + applyWindowMs };
    commit(groupId, step.history);
    apply(step.entry);
    return true;
  });
  const back = useStableCallback(() => go("back"));
  const forward = useStableCallback(() => go("forward"));
  const history = read(groupId);
  const canBack = useMemo(() => canNavStep(history, "back", isAlive), [history, isAlive]);
  const canForward = useMemo(() => canNavStep(history, "forward", isAlive), [history, isAlive]);
  return { canBack, canForward, back, forward, reportSession };
}
