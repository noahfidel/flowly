import type { BoardOverview, OverviewPatch } from "../shared/overview";
import { overviewCollections, overviewKeys } from "../shared/overview";
import { patchItems } from "./board-read";
import { perfEnd, perfStart } from "./perf";

export const overviewKey = (hostId: string) => ["flowly", "overview", hostId, 1] as const;
export type OverviewRead = (input: { etag?: string }) => Promise<{ etag: string; value?: BoardOverview; patch?: OverviewPatch }>;

export function applyOverviewPatch(view: BoardOverview, patch: OverviewPatch): BoardOverview {
  const next = { ...view, revision: patch.revision };
  for (const name of overviewCollections) {
    const change = patch[name];
    if (!change) continue;
    const key = overviewKeys[name] as (item: never) => string;
    const items = patchItems(view[name] as never[], change as never, key);
    const ids = items.map(key);
    const expected = new Set((view[name] as never[]).map(key).filter(id => !change.remove.includes(id)).concat((change.set as never[]).map(key)));
    if (ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) throw new Error("Invalid overview patch order.");
    next[name] = items as never;
  }
  return next;
}

/** Missing/mismatched baselines only reread overview, never the complete Board. */
export async function readOverviewDelta(read: OverviewRead, cached: BoardOverview | undefined, etag?: string) {
  const started = perfStart();
  const response = await read(etag ? { etag } : {});
  perfEnd(`overview.read.${response.patch ? "patch" : response.value ? "full" : "same"}`, started);
  if (!response.patch) return response;
  if (cached && etag && response.patch.baseEtag === etag) {
    try { return { etag: response.etag, value: applyOverviewPatch(cached, response.patch) }; } catch { /* one scoped full reread */ }
  }
  const full = await read({});
  if (!full.value || full.patch) throw new Error("Missing overview in a full read.");
  return full;
}

/** Open ideas of a project: on its cards (the overview's per-card counts) plus the project's own. */
/** Open ideas over several projects: an unfiltered group board's Ideas chip (BOARD-GROUPS-SPEC §4). */
export function groupOpenIdeaCount(board: BoardOverview | undefined, projectIds: readonly string[]) {
  return projectIds.reduce((count, id) => count + projectOpenIdeaCount(board, id), 0);
}
export function projectOpenIdeaCount(board: BoardOverview | undefined, projectId: string | undefined) {
  if (!board || !projectId) return 0;
  const tasks = new Set(board.tasks.filter(task => task.projectId === projectId).map(task => task.id));
  const own = board.projectIdeas.find(facts => facts.projectId === projectId)?.open ?? 0;
  return board.cards.reduce((count, card) => count + (tasks.has(card.taskId) ? card.openIdeas : 0), own);
}
