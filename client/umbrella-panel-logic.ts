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

/** The umbrella's pending contract changes (§5), oldest first (the order they were proposed in). */
export function pendingChanges(entries: readonly UmbrellaEntry[]): UmbrellaEntry[] {
  return entries.filter((e) => e.kind === "contract_change" && e.status === "proposed" && e.change).sort((a, b) => -newest(a, b));
}

/** A contract change's before/after view: the lines only `before` has (removed) and only `after` has (added), in order. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const lines = (text: string) => (text ? text.split("\n").map((l) => l.trimEnd()) : []);
  const old = lines(before),
    next = lines(after);
  const oldSet = new Set(old),
    nextSet = new Set(next);
  return { removed: old.filter((l) => l && !nextSet.has(l)), added: next.filter((l) => l && !oldSet.has(l)) };
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

/**
 * `umbrellas.update`'s acceptance: the list's text and order, trimmed, empty items left out; an item without `id` is new.
 * Never `done`: ticks go through `umbrellas.tick-acceptance`, so a save cannot undo an agent's tick.
 */
export function acceptanceInput(items: readonly Pick<AcceptanceDraft, "id" | "text">[]): { id?: string; text: string }[] {
  return items.flatMap((item) => {
    const text = item.text.trim();
    if (!text) return [];
    return [{ ...(item.id ? { id: item.id } : {}), text }];
  });
}

/**
 * What an editor (title, brief, contract, acceptance list) saves against: the umbrella revision it was opened on, so a
 * concurrent edit (the dispatcher, another window) is refused `REVISION_CONFLICT` instead of silently overwritten.
 * `replace`: the editor was refused once and is now based on the reloaded revision, so the next Save replaces on purpose.
 */
export type EditBase = { revision: number; replace: boolean };
export const editBase = (revision: number): EditBase => ({ revision, replace: false });
export type SaveOutcome = { status: "saved" } | { status: "conflict"; revision: number } | { status: "failed" };

/** The revision a save sends: always the editor's base, never the umbrella's current revision. */
export const revisionToSend = (base: EditBase) => base.revision;

/** The editor after a save: null (closed) when saved; rebased on the reloaded revision after a conflict; unchanged otherwise. */
export function editAfterSave(base: EditBase, outcome: SaveOutcome): EditBase | null {
  if (outcome.status === "saved") return null;
  if (outcome.status === "conflict") return { revision: outcome.revision, replace: true };
  return base;
}

/**
 * `umbrellas.set-member` for a card already in the umbrella. The server replaces both role and order with what it is
 * sent, so the ones not being changed are sent as they are; an empty role clears it.
 */
export function memberInput(
  umbrellaId: string,
  member: Pick<UmbrellaMember, "taskId" | "role" | "order">,
  change: { role?: string; order?: number },
): { taskId: string; umbrellaId: string; role?: string; order?: number } {
  const role = (change.role ?? member.role ?? "").trim();
  const order = change.order ?? member.order;
  return { taskId: member.taskId, umbrellaId, ...(role ? { role } : {}), ...(order !== undefined ? { order } : {}) };
}

/**
 * The `set-member` calls for role or order changes, built from members read just before (`fresh`): only rows whose role
 * or order really changes, and never a card that is no longer a member, neither in that read nor on the board
 * (`inUmbrella`: cards whose `umbrella.id` is this umbrella). A stale panel can then never pull a departed card back in
 * or reset a role changed elsewhere.
 */
export function memberWrites(
  umbrellaId: string,
  fresh: readonly Pick<UmbrellaMember, "taskId" | "role" | "order">[],
  changes: readonly { taskId: string; role?: string; order?: number }[],
  inUmbrella: ReadonlySet<string>,
): ReturnType<typeof memberInput>[] {
  return changes.flatMap(({ taskId, ...change }) => {
    const member = fresh.find((m) => m.taskId === taskId);
    if (!member || !inUmbrella.has(taskId)) return [];
    const input = memberInput(umbrellaId, member, change);
    const same = (input.role ?? "") === (member.role ?? "").trim() && input.order === member.order;
    return same ? [] : [input];
  });
}

/** Moving one pipeline row up (-1) or down (1): the rows renumbered 1..n after the swap, only those whose order changes. */
export function moveMember(rows: readonly Pick<UmbrellaMember, "taskId" | "order">[], taskId: string, delta: -1 | 1): { taskId: string; order: number }[] {
  const from = rows.findIndex((r) => r.taskId === taskId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= rows.length) return [];
  const next = [...rows];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next.flatMap((r, index) => (r.order === index + 1 ? [] : [{ taskId: r.taskId, order: index + 1 }]));
}

export type PickableCard = { taskId: string; title: string; projectTitle: string; moveFrom?: string };

/**
 * Cards the member picker offers (D11, the user's own add): live cards of the group's live projects that are not in this
 * umbrella, whose title contains `query`, by title. `moveFrom` names the umbrella a card would leave ("" when that
 * umbrella is not in the summaries).
 */
export function pickableCards(
  tasks: readonly { id: string; title: string; projectId: string; archivedAt: string | null; umbrella?: { id: string } }[],
  projects: readonly { id: string; title: string; groupId?: string; archivedAt: string | null }[],
  umbrellas: readonly Pick<UmbrellaSummary, "id" | "title">[],
  groupId: string,
  umbrellaId: string,
  query: string,
): PickableCard[] {
  const live = new Map(projects.filter((p) => p.groupId === groupId && !p.archivedAt).map((p) => [p.id, p.title]));
  const needle = query.trim().toLowerCase();
  return tasks
    .filter((t) => !t.archivedAt && live.has(t.projectId) && t.umbrella?.id !== umbrellaId && (!needle || t.title.toLowerCase().includes(needle)))
    .map((t): PickableCard => ({
      taskId: t.id,
      title: t.title,
      projectTitle: live.get(t.projectId)!,
      ...(t.umbrella ? { moveFrom: umbrellas.find((u) => u.id === t.umbrella!.id)?.title ?? "" } : {}),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Ready to close (§11): there is at least one member (archived ones are ignored), every member is Done or Cancelled and every acceptance item is
 * ticked (an empty list is met). Close stays the user's action; an umbrella with no member has nothing to finish.
 */
export function readyToClose(members: readonly { status: string; archived?: boolean }[], acceptance: readonly { done: boolean }[]): boolean {
  const live = members.filter((m) => !m.archived);
  return live.length > 0 && live.every((m) => m.status === "done" || m.status === "cancelled") && acceptance.every((a) => a.done);
}

const offered: readonly UmbrellaEntry["kind"][] = ["decision", "convention", "pitfall"];

/** What a closed umbrella offers the user as project memory (§6): its active decisions, conventions and pitfalls, in feed order. */
export function closeOffer(entries: readonly UmbrellaEntry[]): UmbrellaEntry[] {
  return entries.filter((e) => e.status === "active" && offered.includes(e.kind));
}

/**
 * The project an offered entry is kept in (§6): the project of the card that wrote it when that card is still on the
 * board, else the first member's project. null when the umbrella has neither.
 */
export function offerProject(
  entry: Pick<UmbrellaEntry, "sourceTaskId">,
  tasks: readonly { id: string; projectId: string }[],
  members: readonly Pick<UmbrellaMember, "projectId">[],
): string | null {
  return (entry.sourceTaskId ? tasks.find((t) => t.id === entry.sourceTaskId)?.projectId : undefined) ?? members[0]?.projectId ?? null;
}

/** True when the project already holds a live note of this kind with this title (case-insensitive), so Keep need not save it again. */
export function alreadyKept(
  existing: readonly { kind: string; state: string; text: string; noteKind?: string }[],
  entry: Pick<UmbrellaEntry, "kind" | "title">,
  titleLimit: number,
): boolean {
  const key = (text: string) => text.trim().toLowerCase();
  const title = key(entry.title.slice(0, titleLimit));
  return existing.some((e) => e.kind === "note" && e.state === "active" && e.noteKind === entry.kind && key(e.text) === title);
}
