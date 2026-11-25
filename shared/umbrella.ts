import { z } from "zod";
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
export const umbrellaCreateInput = z.strictObject({
  groupId: z.string().min(1).max(200),
  title: titleInput,
  brief: z.string().max(umbrellaLimits.brief).optional(),
  linearProject: linearProjectInput.optional(),
});
export type UmbrellaCreateInput = z.infer<typeof umbrellaCreateInput>;
export const umbrellaUpdateInput = z.strictObject({
  id: z.string().min(1).max(200),
  revision: z.number().int(),
  title: titleInput.optional(),
  brief: z.string().max(umbrellaLimits.brief).optional(),
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
