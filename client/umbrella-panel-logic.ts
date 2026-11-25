/** Pure rules of the umbrella panel (UMBRELLA-SPEC §7). No React, no RPC. */
import type { Umbrella, UmbrellaEntry } from "../shared/model";
import type { UmbrellaMember, UmbrellaSummary } from "../shared/umbrella";

/** The pipeline: members by `order`, then title; a member without `order` comes after those with one. */
export function pipelineRows(members: readonly UmbrellaMember[]): UmbrellaMember[] {
  const rank = (m: UmbrellaMember) => m.order ?? Number.POSITIVE_INFINITY;
  return [...members].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

const newest = (a: UmbrellaEntry, b: UmbrellaEntry) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
/** Statuses the feed hides unless asked: replaced or taken back. */
const closedStatuses: readonly UmbrellaEntry["status"][] = ["superseded", "withdrawn"];

/** The feed, newest first, of one kind or all; superseded and withdrawn entries only with `closed`. */
export function feedRows(entries: readonly UmbrellaEntry[], kind: UmbrellaEntry["kind"] | "all", options: { closed?: boolean } = {}): UmbrellaEntry[] {
  return entries
    .filter((e) => (kind === "all" || e.kind === kind) && (options.closed || !closedStatuses.includes(e.status)))
    .sort(newest);
}

/** The umbrella's open questions, oldest first (the order they were asked in). */
export function openQuestions(entries: readonly UmbrellaEntry[]): UmbrellaEntry[] {
  return entries.filter((e) => e.kind === "question" && e.status === "open").sort((a, b) => -newest(a, b));
}

/** The panel's list for one group: open umbrellas, and apart the closed ones; archived ones leave it (D18). By title. */
export function listedUmbrellas(all: readonly UmbrellaSummary[], groupId: string): { open: UmbrellaSummary[]; closed: UmbrellaSummary[] } {
  const mine = all.filter((u) => u.groupId === groupId && !u.archivedAt).sort((a, b) => a.title.localeCompare(b.title));
  return { open: mine.filter((u) => u.status === "open"), closed: mine.filter((u) => u.status === "closed") };
}

/** A closed or archived umbrella refuses edits and feed writes (`UMBRELLA_CLOSED`); it stays readable. */
export const umbrellaWritable = (u: Pick<Umbrella, "status" | "archivedAt">) => u.status === "open" && !u.archivedAt;

/** The code of a daemon refusal (`CODE: message`), or null for any other error. */
export function errorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : "";
  // Not anchored: the RPC layer may put its own words before the daemon's message.
  return /(?:^|\s)([A-Z][A-Z_]{2,}):\s/.exec(text)?.[1] ?? null;
}

export type AcceptanceDraft = { id?: string; text: string; done: boolean };

/** `umbrellas.update`'s acceptance: the whole list, trimmed, empty items left out; an item without `id` is new. */
export function acceptanceInput(items: readonly AcceptanceDraft[]): AcceptanceDraft[] {
  return items.flatMap((item) => {
    const text = item.text.trim();
    if (!text) return [];
    return [{ ...(item.id ? { id: item.id } : {}), text, done: item.done }];
  });
}
