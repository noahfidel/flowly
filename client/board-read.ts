import type { z } from "zod";
import type { boardSchema } from "../shared/model";
import type { boardPatchSchema } from "../shared/rpc";
import { perfEnd, perfStart } from "./perf";

export type Board = z.infer<typeof boardSchema>;
export type BoardPatch = z.infer<typeof boardPatchSchema>;
export type BoardRead = (input: { etag?: string; since?: { count: number; lastId: string } }) => Promise<{ etag: string; value?: Board; delta?: boolean; patch?: BoardPatch }>;

const patchKeys = {
  projects: (x: { id: string }) => x.id,
  tasks: (x: { id: string }) => x.id,
  ideas: (x: { id: string }) => x.id,
  links: (x: { id: string }) => x.id,
  artifacts: (x: { id: string }) => x.id,
  workpads: (x: { taskId: string }) => x.taskId,
  attentionDismissals: (x: { taskId: string }) => x.taskId,
  groups: (x: { id: string }) => x.id,
} as const;

/** Replaced and added items, removed ids, and (only when it differs) the final order; unchanged items keep their objects. */
export function patchItems<T>(items: readonly T[], patch: { set: T[]; remove: string[]; order?: string[] } | undefined, key: (item: T) => string): readonly T[] {
  if (!patch) return items;
  const removed = new Set(patch.remove),
    replacement = new Map(patch.set.map((item) => [key(item), item] as const)),
    seen = new Set<string>(),
    next: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (removed.has(id)) continue;
    seen.add(id);
    next.push(replacement.get(id) ?? item);
  }
  for (const [id, item] of replacement) if (!seen.has(id)) next.push(item);
  if (!patch.order) return next;
  const byId = new Map(next.map((item) => [key(item), item] as const));
  return patch.order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** The board a patch leads to, from the board it was computed against. */
export function applyBoardPatch(board: Board, patch: BoardPatch): Board {
  const dropped = patch.removeEvents?.length ? new Set(patch.removeEvents) : null;
  const held = dropped ? board.events.filter((e) => !dropped.has(e.id)) : board.events;
  const next = { ...board, revision: patch.revision, events: patch.events.length ? [...held, ...patch.events] : held, plans: patch.plans ?? board.plans } as Record<string, unknown>;
  for (const name of Object.keys(patchKeys) as (keyof typeof patchKeys)[])
    next[name] = patchItems(board[name] as never[], patch[name] as never, patchKeys[name] as never);
  return next as Board;
}

/**
 * One board read. The daemon answers an etag it remembers with a patch (changed
 * items, removed ids, new events); otherwise, when the cache holds the board this
 * read replaces, only the events after the cached ones are requested and
 * appended. Anything else is the full board (PERFORMANCE-SPEC §3).
 */
export async function readBoardDelta(read: BoardRead, cached: Board | undefined, etag: string | undefined, why?: string) {
  const last = etag ? cached?.events?.at(-1) : undefined;
  const since = cached && last ? { count: cached.events.length, lastId: last.id } : undefined;
  const asked = perfStart();
  const response = await read({ ...(etag ? { etag } : {}), ...(since ? { since } : {}) });
  // The round trip as the phone sees it: network, decryption and parsing included.
  // A full read is named by why no etag was sent (`why`), or "server" when the daemon chose to send everything.
  const kind = response.patch ? "patch" : response.delta ? "events" : response.value ? "full" : "same";
  perfEnd(`board.read.${kind}`, asked);
  if (kind === "full") perfEnd(`board.read.full.${etag ? "server" : why ?? "unknown"}`, asked);
  if (response.patch) {
    if (!cached) {
      perfEnd("board.read.full.patch-without-cache", asked);
      return read({});
    }
    const applying = perfStart();
    const value = applyBoardPatch(cached, response.patch);
    perfEnd("board.apply", applying);
    return { etag: response.etag, value };
  }
  if (!response.delta || !response.value || !cached) return response;
  const applying = perfStart();
  const value = { ...response.value, events: [...cached.events, ...response.value.events] };
  perfEnd("board.apply", applying);
  return { etag: response.etag, value };
}
