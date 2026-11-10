import { createHash } from "node:crypto";
import { boardIfChanged, etagOf } from "./etag";

/**
 * Board reads that send only what changed since the caller's last read
 * (PERFORMANCE-SPEC §3). The daemon remembers a compact fingerprint of the last
 * few boards it served (one short hash per item, by etag). A caller that names
 * an etag it still holds gets the items that differ from that board, the ids
 * that disappeared, and the events after the ones it holds. Anything else (an
 * etag that was never served or has been forgotten, events that no longer
 * continue the caller's) falls back to the events-only delta, then to the full
 * board.
 */

/** The id each keyed collection is matched by. */
const keys = {
  projects: (x: { id: string }) => x.id,
  tasks: (x: { id: string }) => x.id,
  ideas: (x: { id: string }) => x.id,
  links: (x: { id: string }) => x.id,
  artifacts: (x: { id: string }) => x.id,
  workpads: (x: { taskId: string }) => x.taskId,
  attentionDismissals: (x: { taskId: string }) => x.taskId,
  groups: (x: { id: string }) => x.id,
} as const;
export type KeyedName = keyof typeof keys;
export const keyedNames = Object.keys(keys) as KeyedName[];

export type View = { revision: number; events: readonly { id: string }[]; plans: readonly unknown[] } & Record<KeyedName, readonly object[]>;
type Fingerprint = {
  events: { count: number; lastId: string };
  /** Event ids: events are matched by id, not position, because a card's oldest events are dropped from the middle of the list. */
  eventIds: Set<string>;
  plans: string;
  collections: Record<KeyedName, { ids: string[]; hashes: Map<string, string> }>;
};

const short = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("base64url").slice(0, 16);

export function fingerprint(view: View): Fingerprint {
  const collections = {} as Fingerprint["collections"];
  for (const name of keyedNames) {
    const ids: string[] = [],
      hashes = new Map<string, string>();
    for (const item of view[name] as readonly Record<string, string>[]) {
      const id = (keys[name] as (x: never) => string)(item as never);
      ids.push(id);
      hashes.set(id, short(item));
    }
    collections[name] = { ids, hashes };
  }
  const last = view.events[view.events.length - 1];
  return { events: { count: view.events.length, lastId: last?.id ?? "" }, eventIds: new Set(view.events.map((e) => e.id)), plans: short(view.plans), collections };
}

export type CollectionPatch = { set: object[]; remove: string[]; order?: string[] };
export type BoardPatch = { revision: number; events: object[]; removeEvents?: string[]; plans?: unknown[] } & { [K in KeyedName]?: CollectionPatch };

/**
 * What differs between the board behind `base` and `view`; null when the new
 * events are not all at the end (the caller could not append them). Events are
 * matched by id: appending an event to a card that holds its maximum drops that
 * card's oldest one from the middle of the list (`store.event`), which shifts
 * every position after it but is a plain removal here.
 */
export function diffBoard(base: Fingerprint, now: Fingerprint, view: View): BoardPatch | null {
  const added = view.events.filter((e) => !base.eventIds.has((e as { id: string }).id));
  const kept = view.events.length - added.length;
  for (let i = 0; i < kept; i++) if (!base.eventIds.has(view.events[i].id)) return null;
  const patch: Record<string, unknown> = { revision: view.revision, events: added };
  const removeEvents = [...base.eventIds].filter((id) => !now.eventIds.has(id));
  if (removeEvents.length) patch.removeEvents = removeEvents;
  if (base.plans !== now.plans) patch.plans = view.plans;
  for (const name of keyedNames) {
    const before = base.collections[name],
      after = now.collections[name];
    const items = view[name];
    const set: object[] = [];
    const added: string[] = [];
    after.ids.forEach((id, i) => {
      const was = before.hashes.get(id);
      if (was === after.hashes.get(id)) return;
      set.push(items[i]);
      if (was === undefined) added.push(id);
    });
    const remove = before.ids.filter((id) => !after.hashes.has(id));
    if (!set.length && !remove.length && before.ids.join() === after.ids.join()) continue;
    // The caller appends new items after the kept ones; say so only when that is not the real order.
    const gone = new Set(remove);
    const applied = before.ids.filter((id) => !gone.has(id)).concat(added);
    const entry: CollectionPatch = { set, remove };
    if (applied.join() !== after.ids.join()) entry.order = after.ids;
    patch[name] = entry;
  }
  return patch as BoardPatch;
}

/** Why a board read had to send the whole board (diagnostic only; see PERFORMANCE-SPEC, "Why a read is full"). */
export type FullReadReason = "no-etag" | "etag-unknown" | "events-discontinuous" | "since-mismatch" | "no-since";

export class BoardDeltas {
  private readonly seen = new Map<string, Fingerprint>();
  constructor(
    private readonly capacity = 32,
    /** Called when a read answers with the whole board. */
    private readonly onFull?: (reason: FullReadReason, info: { events: number; remembered: number; heldEvents?: number; heldLastAt?: number }) => void,
  ) {}

  read<B extends View>(view: B, input: { etag?: string; since?: { count: number; lastId: string } }) {
    const tag = etagOf(view);
    if (tag === input.etag) return { etag: tag };
    const now = fingerprint(view);
    // Find the caller's board before remembering this one: remembering may forget the oldest, which can be that very board.
    const base = input.etag ? this.seen.get(input.etag) : undefined;
    this.seen.delete(tag);
    this.seen.set(tag, now);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value as string);
    const patch = base ? diffBoard(base, now, view) : null;
    // The RPC output schema checks the shape; the patch only carries items of the view.
    if (patch) return { etag: tag, patch: patch as never };
    const answer = boardIfChanged(view, { since: input.since });
    if (answer.value && !answer.delta)
      this.onFull?.(!input.etag ? "no-etag" : !base ? "etag-unknown" : patch === null ? "events-discontinuous" : !input.since ? "no-since" : "since-mismatch", { events: view.events.length, remembered: this.seen.size, ...(base ? { heldEvents: base.events.count, heldLastAt: view.events.findIndex((e) => e.id === base.events.lastId) } : {}) });
    return answer;
  }
}
