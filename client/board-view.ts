import { useEffect, useRef, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { boardViewSettings, boardViewValues, type BoardView } from "../shared/settings";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Settings = {
  status: string;
  values?: unknown;
  revision?: string;
  save(values: BoardView, revision: string): Promise<boolean>;
  reload(): Promise<void>;
};

/**
 * Saves `patch` on top of the latest stored values; on a revision conflict
 * reloads and merges again (a few attempts). Returns whether it was stored.
 */
export async function saveMerged(read: () => Settings, patch: Partial<BoardView>, pause = wait) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = read();
    if (current.status !== "ready" || current.revision === undefined) {
      await pause(150);
      continue;
    }
    // Keys the schema does not know (the v1 `boardGroups` the migration reads, BOARD-GROUPS-SPEC §7 step 1) are kept:
    // the host hands over the stored values unparsed, and the save replaces the whole document.
    const raw = typeof current.values === "object" && current.values !== null && !Array.isArray(current.values) ? current.values : {};
    const base = { ...raw, ...boardViewValues(current.values) };
    const next = { ...base, ...patch };
    if (JSON.stringify(next) === JSON.stringify(base)) return true;
    if (await current.save(next, current.revision)) return true;
    // Someone else saved first: pick up their revision and merge again.
    await current.reload();
    await pause(50 * (attempt + 1));
  }
  return false;
}

/**
 * The host-scoped board view preferences with safe writes. Several parts of the
 * plugin save different fields of the same document, so a save against a
 * stale revision is merged into the latest values and retried instead of being
 * dropped. Changes show immediately (optimistic) until the stored values agree.
 */
export function useBoardView() {
  const settings = useSettings(boardViewSettings);
  const latest = useRef(settings);
  latest.current = settings;
  const stored = settings.status === "ready" ? boardViewValues(settings.values) : null;
  const [overlay, setOverlay] = useState<Partial<BoardView>>({});
  // Drop optimistic fields once the stored document shows them.
  useEffect(() => {
    if (!stored) return;
    setOverlay((current) => {
      const left = Object.fromEntries(
        Object.entries(current).filter(([key, value]) => JSON.stringify(stored[key as keyof BoardView]) !== JSON.stringify(value)),
      );
      return Object.keys(left).length === Object.keys(current).length ? current : left;
    });
  }, [settings.status === "ready" ? settings.revision : ""]);
  const values: BoardView | null = stored ? { ...stored, ...overlay } : null;
  async function update(patch: Partial<BoardView>) {
    setOverlay((current) => ({ ...current, ...patch }));
    if (await saveMerged(() => latest.current, patch)) return true;
    // Give up visibly rather than show a value that was not stored.
    setOverlay((current) => {
      const copy = { ...current };
      for (const key of Object.keys(patch)) delete copy[key as keyof BoardView];
      return copy;
    });
    return false;
  }
  return { ready: !!values, values, update };
}
