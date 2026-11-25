import { z } from "zod";
import { groupOfProject } from "./groups";
import { laneName } from "./lanes";
import {
  actorSchema,
  ideaStatuses,
  statusSchema,
  umbrellaEntryKinds,
  umbrellaEntryStatuses,
  umbrellaLimits,
  umbrellaSchema,
  umbrellaStatuses,
  type Actor,
  type Board,
  type Status,
  type Task,
  type Umbrella,
  type UmbrellaEntry,
} from "./model";

/** Umbrella rules shared by the daemon and the client (UMBRELLA-SPEC). */
export { umbrellaLimits };

/** Entries that count toward the 300 per umbrella: `active` and `open`; `proposed` counts only against the pending changes. */
export const countsTowardLimit = (e: UmbrellaEntry) => e.status === "active" || e.status === "open";

/** The card face's umbrella chip text (§7): the title cut to 20 characters (an ellipsis counts), ` · role` when the card has one. */
export function umbrellaChipText(title: string, role?: string): string {
  const chars = [...title];
  const cut = chars.length > 20 ? `${chars.slice(0, 19).join("")}…` : title;
  return role ? `${cut} · ${role}` : cut;
}

/** Changes when the umbrella is edited (`revision`) or its feed is written (`feedRevision`); the drawer refetches the feed on it. */
export const umbrellaRefetchKey = (s: Pick<UmbrellaSummary, "revision" | "feedRevision">): string => `${s.revision}:${s.feedRevision}`;

/** The newest `limit` feed entries, newest first; withdrawn ones are left out (the drawer section's list, §7). */
export function recentEntries<E extends Pick<UmbrellaEntry, "status" | "createdAt" | "id">>(entries: readonly E[], limit = 5): E[] {
  return entries
    .filter((e) => e.status !== "withdrawn")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

/** The umbrella's member cards (archived ones included), by `order` then title; a card without `order` comes after those with one. */
export function membersOf(board: { tasks: readonly Task[] }, umbrellaId: string): Task[] {
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

/** What the move rule reads of an umbrella: a summary from the board overview has it too (the confirm's preview). */
type UmbrellaIdentity = Pick<Umbrella, "id" | "groupId" | "title">;
type MoveReadBoard<U extends UmbrellaIdentity> = {
  groups: readonly Board["groups"][number][];
  projects: readonly Board["projects"][number][];
  tasks: readonly Task[];
  umbrellas: readonly U[];
};
type GroupMovesBoard = Pick<Board, "groups" | "projects" | "tasks" | "umbrellas">;

/**
 * The group-change rule (§9) for the umbrellas with a member in one of `projectIds`, given each project's group
 * (`groupIdOf`): `follow` is the one group all members are in when it differs from the umbrella's; otherwise
 * `leaving` are the members whose project is no longer in the umbrella's group.
 */
function groupMovePlan<U extends UmbrellaIdentity>(board: MoveReadBoard<U>, projectIds: readonly string[], groupIdOf: (projectId: string) => string | null) {
  const plan: { umbrella: U; follow?: string; leaving: Task[] }[] = [];
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
  board: MoveReadBoard<UmbrellaIdentity>,
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

/** `flowly_get_task.umbrella` (UMBRELLA-SPEC §3): what a member's agent reads; null when the card has no umbrella. */
export const umbrellaContextSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(umbrellaStatuses),
  /** This card's role in the umbrella. */
  role: z.string().nullable(),
  /** True when this card is the umbrella's integration card (§11). */
  integration: z.boolean(),
  /** Up to 8,000 characters; `truncated`: the full text is in flowly_get_umbrella. */
  brief: z.object({ text: z.string(), revision: z.number(), updatedAt: z.string(), unread: z.boolean(), truncated: z.boolean() }),
  contract: z.object({ text: z.string(), revision: z.number(), updatedAt: z.string(), unread: z.boolean() }),
  /** Unread first, then active rulings, then open questions and proposed contract changes, then the rest newest first, up to 6,000 characters. */
  feed: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(umbrellaEntryKinds),
      title: z.string(),
      /** A contract change's body is its reason; its new text is in flowly_get_umbrella. */
      body: z.string(),
      status: z.enum(umbrellaEntryStatuses),
      sourceTaskId: z.string().nullable(),
      /** The source card's title, "deleted card" or "moved out"; null when no card wrote it. */
      sourceTitle: z.string().nullable(),
      /** kind=ruling: the user's words. */
      quote: z.string().optional(),
      by: actorSchema,
      at: z.string(),
      unread: z.boolean(),
      /** Only on an answered question or rejected contract change returned once to the card it came from (D19). */
      answer: z.string().optional(),
    }),
  ),
  openQuestions: z.number(),
  pendingContractChanges: z.number(),
  /** The other members, at most 30; `laneName` from each sibling's own project. */
  siblings: z.array(
    z.object({
      taskId: z.string(),
      projectId: z.string(),
      projectTitle: z.string(),
      title: z.string(),
      laneName: z.string(),
      status: statusSchema,
      role: z.string().nullable(),
      order: z.number().nullable(),
      archived: z.boolean(),
    }),
  ),
  acceptance: z.array(z.object({ text: z.string(), done: z.boolean() })),
  /** The umbrella's open ideas. */
  ideas: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(ideaStatuses), sourceTaskId: z.string().nullable() })),
  linearProject: z.object({ url: z.string(), name: z.string().optional() }).optional(),
  /** Feed entries left out by the budget. */
  truncatedFeed: z.number(),
  /** Unread entries left out by the budget; they stay unread. */
  unreadLeftOut: z.number(),
});
export type UmbrellaContext = z.infer<typeof umbrellaContextSchema>;

/** What a session last got of one umbrella: the brief and contract revisions it read in full and the entries it was shown. */
export type UmbrellaSeen = { brief: number; contract: number; entries: string[] };
/** What one get_task showed; `brief` is null when it was truncated (its revision is not read). */
export type UmbrellaShown = { brief: number | null; contract: number; entries: string[] };

/**
 * The read key of an answered or rejected entry returned to its source card (D19). It is apart from the entry's own
 * id, so an asker that saw its question while it was open still gets the answer once.
 */
export const returnedKey = (e: Pick<UmbrellaEntry, "id" | "status">) => `${e.id}:${e.status}`;
const byAgent = (actor: Actor, agentId: string) => actor.kind !== "human" && actor.agentId === agentId;
const leftOut: readonly UmbrellaEntry["status"][] = ["superseded", "answered", "rejected", "withdrawn"];
const lessons: readonly UmbrellaEntry["kind"][] = ["decision", "convention", "pitfall", "finding"];
const entryBody = (e: UmbrellaEntry) => (e.kind === "contract_change" ? (e.change?.reason ?? e.body) : e.body);

/**
 * Builds `flowly_get_task.umbrella` for `task` as session `agentId` reads it (§3), and what it showed, for the
 * caller to record with UmbrellaReadStore.mark. Null when the card is in no umbrella (or one no longer on the board).
 */
export function umbrellaContext(input: {
  board: Pick<Board, "projects" | "tasks" | "umbrellas" | "umbrellaEntries" | "ideas">;
  task: Task;
  agentId: string;
  seen: UmbrellaSeen | null;
}): { value: UmbrellaContext; shown: UmbrellaShown } | null {
  const { board, task, agentId, seen } = input;
  const umbrella = task.umbrella && board.umbrellas.find((u) => u.id === task.umbrella!.id);
  if (!umbrella) return null;
  const read = new Set(seen?.entries ?? []);
  const newest = (a: UmbrellaEntry, b: UmbrellaEntry) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const entries = board.umbrellaEntries.filter((e) => e.umbrellaId === umbrella.id).sort(newest);
  // D19: an answered question or a rejected proposal goes back once to the card it came from, with `answer`.
  const returned = (e: UmbrellaEntry) =>
    (e.status === "answered" || e.status === "rejected") && e.sourceTaskId === task.id && !read.has(returnedKey(e));
  const live = entries.filter((e) => !leftOut.includes(e.status) || returned(e));
  const unread = (e: UmbrellaEntry) => returned(e) || (!byAgent(e.by, agentId) && !read.has(e.id));
  const tiers = [
    live.filter(unread),
    live.filter((e) => e.kind === "ruling" && e.status === "active"),
    live.filter((e) => (e.kind === "question" && e.status === "open") || (e.kind === "contract_change" && e.status === "proposed")),
    live.filter((e) => lessons.includes(e.kind) && e.status === "active"),
  ];
  const ordered = [...new Set(tiers.flat())];
  const shown: UmbrellaEntry[] = [];
  let size = 0;
  for (const e of ordered) {
    // A D19 answer is sent with the entry, so it counts too (coordinator ruling 2026-11-25).
    const next = size + e.title.length + entryBody(e).length + (e.quote?.length ?? 0) + (returned(e) ? (e.answer?.length ?? 0) : 0);
    if (next > umbrellaLimits.feedBudget) break;
    size = next;
    shown.push(e);
  }
  const titleOf = (id: string) => {
    const source = board.tasks.find((t) => t.id === id);
    return !source ? "deleted card" : source.umbrella?.id === umbrella.id ? source.title : "moved out";
  };
  const fresh = (part: { revision: number; updatedBy: Actor }, readRevision: number | undefined) =>
    part.revision > 0 && part.revision > (readRevision ?? 0) && !byAgent(part.updatedBy, agentId);
  const truncated = umbrella.brief.text.length > umbrellaLimits.briefBudget;
  const projectOf = (projectId: string) => board.projects.find((p) => p.id === projectId);
  let openQuestions = 0,
    pendingContractChanges = 0;
  for (const e of entries) {
    if (e.kind === "question" && e.status === "open") openQuestions++;
    else if (e.kind === "contract_change" && e.status === "proposed") pendingContractChanges++;
  }
  const value: UmbrellaContext = {
    id: umbrella.id,
    title: umbrella.title,
    status: umbrella.status,
    role: task.umbrella!.role ?? null,
    integration: umbrella.integrationTaskId === task.id,
    brief: {
      text: umbrella.brief.text.slice(0, umbrellaLimits.briefBudget),
      revision: umbrella.brief.revision,
      updatedAt: umbrella.brief.updatedAt,
      unread: fresh(umbrella.brief, seen?.brief),
      truncated,
    },
    contract: {
      text: umbrella.contract.text,
      revision: umbrella.contract.revision,
      updatedAt: umbrella.contract.updatedAt,
      unread: fresh(umbrella.contract, seen?.contract),
    },
    feed: shown.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      body: entryBody(e),
      status: e.status,
      sourceTaskId: e.sourceTaskId ?? null,
      sourceTitle: e.sourceTaskId ? titleOf(e.sourceTaskId) : null,
      ...(e.quote ? { quote: e.quote } : {}),
      by: e.by,
      at: e.createdAt,
      unread: unread(e),
      ...(returned(e) && e.answer !== undefined ? { answer: e.answer } : {}),
    })),
    openQuestions,
    pendingContractChanges,
    siblings: membersOf(board, umbrella.id)
      .filter((t) => t.id !== task.id)
      .slice(0, umbrellaLimits.siblings)
      .map((t) => {
        const project = projectOf(t.projectId);
        return {
          taskId: t.id,
          projectId: t.projectId,
          projectTitle: project?.title ?? "unknown project",
          title: t.title,
          laneName: project ? laneName(project, t.status) : t.status,
          status: t.status,
          role: t.umbrella?.role ?? null,
          order: t.umbrella?.order ?? null,
          archived: !!t.archivedAt,
        };
      }),
    acceptance: umbrella.acceptance.map((a) => ({ text: a.text, done: a.done })),
    ideas: board.ideas
      .filter((i) => i.umbrellaId === umbrella.id && i.status === "open")
      .map((i) => ({ id: i.id, title: i.title, status: i.status, sourceTaskId: i.taskId ?? null })),
    ...(umbrella.linearProject
      ? { linearProject: { url: umbrella.linearProject.url, ...(umbrella.linearProject.name ? { name: umbrella.linearProject.name } : {}) } }
      : {}),
    truncatedFeed: ordered.length - shown.length,
    unreadLeftOut: ordered.filter((e) => unread(e) && !shown.includes(e)).length,
  };
  return {
    value,
    shown: {
      brief: truncated ? null : umbrella.brief.revision,
      contract: umbrella.contract.revision,
      entries: shown.flatMap((e) => (returned(e) ? [e.id, returnedKey(e)] : [e.id])),
    },
  };
}

/** The line a member session's first instructions carry (§3), or null when the card has no umbrella. */
export function umbrellaStartLine(board: Pick<Board, "umbrellas">, task: Task): string | null {
  const umbrella = task.umbrella && board.umbrellas.find((u) => u.id === task.umbrella!.id);
  if (!umbrella) return null;
  const role = task.umbrella!.role ? ` (your role: ${task.umbrella!.role})` : "";
  return `Umbrella "${umbrella.title}"${role}: the brief, contract and feed are in flowly_get_task.umbrella. Start a report's note with [contract] only when it changes a handoff shape or decision your siblings depend on.`;
}
