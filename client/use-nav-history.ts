import { useEffect, useMemo, useRef, useState } from "react";
import { canNavStep, emptyNavHistory, navStep, recordLocation, samePlace, type NavDirection, type NavEntry, type NavHistory } from "./nav-history";
import { useStableCallback } from "./stable";

/** How long the places shown on the way to an entry Back/Forward opened are not recorded (the dock's open is async). */
const applyWindowMs = 1500;

function placeKey(entry: NavEntry | null) {
  if (!entry) return "";
  return entry.kind === "card" ? `card|${entry.taskId}` : entry.kind === "dispatcher" ? `dispatcher|${entry.groupId}` : "board";
}

/**
 * Back/Forward history for one board (one window), in memory only (UI-REFRESH-SPEC §7ae). `location` is the place
 * shown (null until the board can say: the overview and settings are read); every change is recorded, so every open
 * path (cards, links, search, the step-through) adds its entry without being touched. `reportSession` records the
 * session the open card shows. `apply` opens an entry through the board's normal open paths.
 */
export function useNavHistory({
  location,
  isAlive,
  apply,
}: {
  location: NavEntry | null;
  isAlive(entry: NavEntry): boolean;
  apply(entry: NavEntry): void;
}) {
  const [history, setHistory] = useState<NavHistory>(emptyNavHistory);
  // The source of truth between renders, so two quick presses step twice.
  const latest = useRef(history);
  const pending = useRef<{ entry: NavEntry; until: number } | null>(null);
  const commit = (next: NavHistory) => {
    if (next === latest.current) return;
    latest.current = next;
    setHistory(next);
  };
  const accept = useStableCallback((place: NavEntry) => {
    const applying = pending.current;
    if (applying) {
      if (samePlace(applying.entry, place)) pending.current = null;
      else if (Date.now() < applying.until) return;
      else pending.current = null;
    }
    commit(recordLocation(latest.current, place));
  });
  const key = placeKey(location);
  useEffect(() => {
    if (location) accept(location);
  }, [key]);
  const reportSession = useStableCallback((taskId: string, sessionId: string) => accept({ kind: "card", taskId, sessionId }));
  const go = useStableCallback((direction: NavDirection) => {
    const step = navStep(latest.current, direction, isAlive);
    if (!step) return false;
    pending.current = { entry: step.entry, until: Date.now() + applyWindowMs };
    commit(step.history);
    apply(step.entry);
    return true;
  });
  const back = useStableCallback(() => go("back"));
  const forward = useStableCallback(() => go("forward"));
  const canBack = useMemo(() => canNavStep(history, "back", isAlive), [history, isAlive]);
  const canForward = useMemo(() => canNavStep(history, "forward", isAlive), [history, isAlive]);
  return { canBack, canForward, back, forward, reportSession };
}
