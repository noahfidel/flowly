import { z } from "zod";
import { groupOfProject } from "./groups";
import { umbrellaLimits, umbrellaSchema, umbrellaStatuses, type Board, type Status, type Task, type Umbrella, type UmbrellaEntry } from "./model";

/** Umbrella rules shared by the daemon and the client (UMBRELLA-SPEC). */
export { umbrellaLimits };

/** Entries that count toward the 300 per umbrella: `active` and `open`; `proposed` counts only against the pending changes. */
export const countsTowardLimit = (e: UmbrellaEntry) => e.status === "active" || e.status === "open";

/** The umbrella's member cards (archived ones included), by `order` then title; a card without `order` comes after those with one. */
export function membersOf(board: Pick<Board, "tasks">, umbrellaId: string): Task[] {
  const rank = (t: Task) => t.umbrella?.order ?? Number.POSITIVE_INFINITY;
  return board.tasks
    .filter((t) => t.umbrella?.id === umbrellaId)
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** The board group a card's project is in, or null when it has none. */
export function umbrellaGroupOf(board: Pick<Board, "projects">, task: Pick<Task, "projectId">): string | null {
  return board.projects.find((p) => p.id === task.projectId)?.groupId ?? null;
}

/**
 * Takes a card out of its umbrella: clears the membership and, when it was the umbrella's integration card, that role
 * too (§11: the integration card is a member), as an edit of the umbrella (`revision` +1). Records no event; the
 * caller does, with its own actor and words. Returns the umbrella it left, or undefined when it was in none (or in one
 * no longer on the board).
 */
export function leaveUmbrella(board: Pick<Board, "umbrellas">, task: Task, now: string): Umbrella | undefined {
  const id = task.umbrella?.id;
  if (!id) return undefined;
  delete task.umbrella;
  const umbrella = board.umbrellas.find((u) => u.id === id);
  if (umbrella?.integrationTaskId === task.id) {
    delete umbrella.integrationTaskId;
    umbrella.revision++;
    umbrella.updatedAt = now;
  }
  return umbrella;
}

type GroupMovesBoard = Pick<Board, "groups" | "projects" | "tasks" | "umbrellas">;

/**
 * The group-change rule (§9) for the umbrellas with a member in one of `projectIds`, given each project's group
 * (`groupIdOf`): `follow` is the one group all members are in when it differs from the umbrella's; otherwise
 * `leaving` are the members whose project is no longer in the umbrella's group.
 */
function groupMovePlan(board: GroupMovesBoard, projectIds: readonly string[], groupIdOf: (projectId: string) => string | null) {
  const plan: { umbrella: Umbrella; follow?: string; leaving: Task[] }[] = [];
  for (const umbrella of board.umbrellas) {
    const members = membersOf(board, umbrella.id);
    if (!members.some((t) => projectIds.includes(t.projectId))) continue;
    const groups = new Set(members.map((t) => groupIdOf(t.projectId)));
    if (groups.size === 1) {
      const [only] = [...groups];
      if (only && only !== umbrella.groupId) plan.push({ umbrella, follow: only, leaving: [] });
      continue;
    }
    const leaving = members.filter((t) => groupIdOf(t.projectId) !== umbrella.groupId);
    if (leaving.length) plan.push({ umbrella, leaving });
  }
  return plan;
}

/**
 * Runs the group-change rule (§9) inside the write that moved `movedProjectIds` (already in their new groups): an
 * umbrella whose members all end up in one group moves with them; otherwise the members that left its group leave it
 * (with the integration card role), and its entries stay as they are. Only umbrellas with a member in a moved project
 * are checked. It never throws and never checks the open-umbrella limit, so a group may end above 50 (§2.4).
 */
export function applyGroupMoves(
  board: GroupMovesBoard,
  movedProjectIds: readonly string[],
  now: string,
  emit: (taskId: string, note: string) => void,
): { moved: string[]; lostMembers: { umbrellaId: string; title: string; taskIds: string[] }[] } {
  const groupIdOf = (projectId: string) => groupOfProject(board, board.projects.find((p) => p.id === projectId))?.id ?? null;
  const moved: string[] = [],
    lostMembers: { umbrellaId: string; title: string; taskIds: string[] }[] = [];
  for (const { umbrella, follow, leaving } of groupMovePlan(board, movedProjectIds, groupIdOf)) {
    if (follow) {
      umbrella.groupId = follow;
      umbrella.updatedAt = now;
      moved.push(umbrella.id);
      continue;
    }
    for (const task of leaving) {
      leaveUmbrella(board, task, now);
      emit(task.id, `Left umbrella ${umbrella.title} (project moved to another group)`);
    }
    lostMembers.push({ umbrellaId: umbrella.id, title: umbrella.title, taskIds: leaving.map((t) => t.id) });
  }
  return { moved, lostMembers };
}

/** What `moves` would do, without changing anything: the umbrellas that would lose members, for a confirm (§9). */
export function umbrellasLosingMembers(
  board: GroupMovesBoard,
  moves: readonly { projectId: string; groupId: string }[],
): { umbrellaId: string; title: string; cards: number }[] {
  const target = new Map(moves.map((m) => [m.projectId, m.groupId]));
  const groupIdOf = (projectId: string) =>
    target.get(projectId) ?? groupOfProject(board, board.projects.find((p) => p.id === projectId))?.id ?? null;
  return groupMovePlan(board, [...target.keys()], groupIdOf)
    .filter((p) => p.leaving.length)
    .map((p) => ({ umbrellaId: p.umbrella.id, title: p.umbrella.title, cards: p.leaving.length }));
}

/**
 * An umbrella whose `groupId` names no group (its group was deleted with no members left, or bad data) moves to its
 * members' group when they share one, else to the default group (§9, as for projects). Returns the repaired ids.
 */
export function repairUmbrellaGroups(board: GroupMovesBoard, defaultGroupId: string): string[] {
  const repaired: string[] = [];
  for (const umbrella of board.umbrellas) {
    if (board.groups.some((g) => g.id === umbrella.groupId)) continue;
    const groups = new Set(membersOf(board, umbrella.id).map((t) => groupOfProject(board, board.projects.find((p) => p.id === t.projectId))?.id));
    const [only] = [...groups];
    umbrella.groupId = groups.size === 1 && only ? only : defaultGroupId;
    repaired.push(umbrella.id);
  }
  return repaired;
}

/** One member as the panel and `umbrellas.get` show it (Task 7's pipeline reads it). */
export type UmbrellaMember = {
  taskId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  status: Status;
  laneName: string;
  role?: string;
  order?: number;
  archived: boolean;
};

/** What the board overview carries per umbrella: never the brief, contract or entries (§4.4). */
export const umbrellaSummarySchema = z.strictObject({
  id: z.string(),
  groupId: z.string(),
  title: z.string(),
  status: z.enum(umbrellaStatuses),
  members: z.number().int().nonnegative(),
  openQuestions: z.number().int().nonnegative(),
  pendingChanges: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  feedRevision: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  linearProject: umbrellaSchema.shape.linearProject,
});
export type UmbrellaSummary = z.infer<typeof umbrellaSummarySchema>;

/** Counts come from the full board's entries: pass `store.read()`, never `view()` (which holds no entries). */
export function umbrellaSummary(u: Umbrella, board: Pick<Board, "tasks" | "umbrellaEntries">): UmbrellaSummary {
  let openQuestions = 0,
    pendingChanges = 0;
  for (const e of board.umbrellaEntries) {
    if (e.umbrellaId !== u.id) continue;
    if (e.kind === "question" && e.status === "open") openQuestions++;
    else if (e.kind === "contract_change" && e.status === "proposed") pendingChanges++;
  }
  return {
    id: u.id,
    groupId: u.groupId,
    title: u.title,
    status: u.status,
    members: board.tasks.filter((t) => t.umbrella?.id === u.id).length,
    openQuestions,
    pendingChanges,
    revision: u.revision,
    feedRevision: u.feedRevision,
    archivedAt: u.archivedAt,
    ...(u.linearProject ? { linearProject: u.linearProject } : {}),
  };
}

/** The umbrella as `store.view()` readers get it: brief and contract text emptied (their revisions stay). */
export const umbrellaViewOf = (u: Umbrella): Umbrella => ({ ...u, brief: { ...u.brief, text: "" }, contract: { ...u.contract, text: "" } });

/** RPC inputs (UMBRELLA-SPEC §4.4); the user's edits from the panel. */
const titleInput = z.string().trim().min(1).max(umbrellaLimits.title);
const linearProjectInput = z.strictObject({
  url: z.string().trim().min(1).max(2000),
  key: z.string().trim().max(100).optional(),
  name: z.string().trim().max(200).optional(),
});
/** The link or path the user keeps the brief in (D4). */
const briefSourceInput = z.string().trim().min(1).max(500);
export const umbrellaCreateInput = z.strictObject({
  groupId: z.string().min(1).max(200),
  title: titleInput,
  brief: z.string().max(umbrellaLimits.brief).optional(),
  briefSource: briefSourceInput.nullable().optional(),
  linearProject: linearProjectInput.optional(),
});
export type UmbrellaCreateInput = z.infer<typeof umbrellaCreateInput>;
export const umbrellaUpdateInput = z.strictObject({
  id: z.string().min(1).max(200),
  revision: z.number().int(),
  title: titleInput.optional(),
  brief: z.string().max(umbrellaLimits.brief).optional(),
  /** null clears it; changing it bumps `revision`, not the brief's revision. */
  briefSource: briefSourceInput.nullable().optional(),
  contract: z.string().max(umbrellaLimits.contract).optional(),
  /** The whole list; an item without `id` is new, an unchanged one keeps its author. */
  acceptance: z
    .array(z.strictObject({ id: z.string().min(1).max(200).optional(), text: z.string().trim().min(1).max(umbrellaLimits.acceptanceText), done: z.boolean() }))
    .max(umbrellaLimits.acceptance)
    .optional(),
  /** null clears it. */
  integrationTaskId: z.string().min(1).max(200).nullable().optional(),
  /** null clears it. */
  linearProject: linearProjectInput.nullable().optional(),
});
export type UmbrellaUpdateInput = z.infer<typeof umbrellaUpdateInput>;
export const umbrellaMemberInput = z.strictObject({
  taskId: z.string().min(1).max(200),
  /** null: leave the umbrella. */
  umbrellaId: z.string().min(1).max(200).nullable(),
  role: z.string().trim().max(umbrellaLimits.role).optional(),
  order: z.number().finite().optional(),
});
export type UmbrellaMemberInput = z.infer<typeof umbrellaMemberInput>;
/** Answer a question or supersede an entry; accept/reject of a contract change comes with contract changes. */
export const umbrellaEntryUpdateInput = z.strictObject({
  id: z.string().min(1).max(200),
  status: z.enum(["answered", "superseded"]),
  answer: z.string().trim().min(1).max(umbrellaLimits.entryBody).optional(),
});
export type UmbrellaEntryUpdateInput = z.infer<typeof umbrellaEntryUpdateInput>;
export const umbrellaRevisionInput = z.strictObject({ id: z.string().min(1).max(200), revision: z.number().int() });
export type UmbrellaRevisionInput = z.infer<typeof umbrellaRevisionInput>;
