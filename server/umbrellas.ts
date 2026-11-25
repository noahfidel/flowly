import { randomUUID } from "node:crypto";
import type { Actor, Board, BoardEvent, Task, Umbrella, UmbrellaEntry } from "../shared/model";
import { laneName } from "../shared/lanes";
import {
  countsTowardLimit,
  leaveUmbrella,
  membersOf,
  umbrellaGroupOf,
  umbrellaLimits,
  umbrellaSummary,
  type UmbrellaCreateInput,
  type UmbrellaEntryUpdateInput,
  type UmbrellaMember,
  type UmbrellaMemberInput,
  type UmbrellaRevisionInput,
  type UmbrellaSummary,
  type UmbrellaUpdateInput,
} from "../shared/umbrella";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";

/**
 * Umbrella writes (UMBRELLA-SPEC §2, §4.4): each one is one store transaction. The user's and the dispatcher's edits
 * bump the umbrella's `revision`; feed writes bump `feedRevision` only; membership is on the card and never bumps the
 * card's revision (it records an Activity event instead).
 */

const find = (board: Board, id: string) => {
  const umbrella = board.umbrellas.find((u) => u.id === id);
  if (!umbrella) throw new ToolError("NOT_FOUND", "No umbrella with that id.");
  return umbrella;
};
const isClosed = (u: Umbrella) => u.status === "closed" || u.archivedAt !== null;
const requireOpen = (u: Umbrella) => {
  if (isClosed(u)) throw new ToolError("UMBRELLA_CLOSED", `The umbrella "${u.title}" is ${u.archivedAt ? "archived" : "closed"}.`);
};
const requireRevision = (u: Umbrella, revision: number) => {
  if (u.revision !== revision) throw new ToolError("REVISION_CONFLICT", "The umbrella changed. Read it again.", true);
};
const openInGroup = (board: Board, groupId: string) => board.umbrellas.filter((u) => u.groupId === groupId && !isClosed(u)).length;
const requireRoom = (board: Board, groupId: string) => {
  if (openInGroup(board, groupId) >= umbrellaLimits.openPerGroup)
    throw new ToolError("UMBRELLA_LIMIT", `A board group can have at most ${umbrellaLimits.openPerGroup} open umbrellas. Close or archive one first.`);
};
/** Activity events have no dispatcher actor: the dispatcher is an agent session there. */
const eventActor = (by: Actor): Pick<BoardEvent, "actor" | "agentId"> =>
  by.kind === "human" ? { actor: "human" } : { actor: "agent", agentId: by.agentId };

export function createUmbrella(store: BoardStore, input: UmbrellaCreateInput & { operationId?: string }, by: Actor): Promise<Umbrella & { replayed?: true }> {
  return store.transaction((board) => {
    if (input.operationId) {
      const earlier = board.umbrellas.find((u) => u.operationId === input.operationId);
      if (earlier) return { value: { ...earlier, replayed: true as const }, changed: false };
    }
    if (!board.groups.some((g) => g.id === input.groupId)) throw new ToolError("NOT_FOUND", "No board group with that id.");
    requireRoom(board, input.groupId);
    const now = new Date().toISOString();
    const brief = input.brief ?? "";
    const umbrella: Umbrella = {
      id: randomUUID(),
      groupId: input.groupId,
      title: input.title,
      brief: { text: brief, revision: brief ? 1 : 0, updatedAt: now, updatedBy: by, ...(input.briefSource ? { source: input.briefSource } : {}) },
      contract: { text: "", revision: 0, updatedAt: now, updatedBy: by },
      acceptance: [],
      ...(input.linearProject ? { linearProject: input.linearProject } : {}),
      status: "open",
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      feedRevision: 0,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      archivedAt: null,
    };
    board.umbrellas.push(umbrella);
    return { value: umbrella, changed: true };
  });
}

export function updateUmbrella(store: BoardStore, input: UmbrellaUpdateInput, by: Actor): Promise<Umbrella> {
  return store.transaction((board) => {
    const u = find(board, input.id);
    requireRevision(u, input.revision);
    requireOpen(u);
    const now = new Date().toISOString();
    let changed = false;
    if (input.title !== undefined && input.title !== u.title) {
      u.title = input.title;
      changed = true;
    }
    if (input.brief !== undefined && input.brief !== u.brief.text) {
      u.brief = { ...u.brief, text: input.brief, revision: u.brief.revision + 1, updatedAt: now, updatedBy: by };
      changed = true;
    }
    if (input.briefSource !== undefined && input.briefSource !== (u.brief.source ?? null)) {
      if (input.briefSource === null) delete u.brief.source;
      else u.brief.source = input.briefSource;
      changed = true;
    }
    if (input.contract !== undefined && input.contract !== u.contract.text) {
      u.contract = { text: input.contract, revision: u.contract.revision + 1, updatedAt: now, updatedBy: by };
      changed = true;
    }
    if (input.acceptance !== undefined) {
      const next = input.acceptance.map((item) => {
        const old = item.id ? u.acceptance.find((a) => a.id === item.id) : undefined;
        return old && old.text === item.text && old.done === item.done ? old : { id: old?.id ?? randomUUID(), text: item.text, done: item.done, by, at: now };
      });
      if (JSON.stringify(next) !== JSON.stringify(u.acceptance)) {
        u.acceptance = next;
        changed = true;
      }
    }
    if (input.integrationTaskId !== undefined && input.integrationTaskId !== (u.integrationTaskId ?? null)) {
      if (input.integrationTaskId === null) delete u.integrationTaskId;
      else {
        const member = board.tasks.find((t) => t.id === input.integrationTaskId);
        if (member?.umbrella?.id !== u.id) throw new ToolError("NOT_IN_UMBRELLA", "The integration card must be a member of the umbrella.");
        u.integrationTaskId = member.id;
      }
      changed = true;
    }
    if (input.linearProject !== undefined && JSON.stringify(input.linearProject) !== JSON.stringify(u.linearProject ?? null)) {
      if (input.linearProject === null) delete u.linearProject;
      else u.linearProject = input.linearProject;
      changed = true;
    }
    if (!changed) return { value: u, changed: false };
    u.revision++;
    u.updatedAt = now;
    return { value: u, changed: true };
  });
}

/**
 * Puts a card in an umbrella, moves it from another one, changes its role or order, or (umbrellaId null) takes it out.
 * The card's revision stays; joining and leaving record `umbrella_joined` / `umbrella_left` on the card.
 */
export function setMembership(store: BoardStore, input: UmbrellaMemberInput, by: Actor): Promise<Task> {
  return store.transaction((board) => {
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new ToolError("NOT_FOUND", "No card with that id.");
    const current = task.umbrella;
    const leave = () => {
      // The integration card must be a member (§11): leaving drops the role, as an edit of the umbrella.
      const old = leaveUmbrella(board, task, new Date().toISOString());
      store.event(board, { taskId: task.id, ...eventActor(by), action: "umbrella_left", note: old?.title ?? "a deleted umbrella" });
    };
    if (input.umbrellaId === null) {
      if (!current) return { value: task, changed: false };
      leave();
      return { value: task, changed: true };
    }
    const u = find(board, input.umbrellaId);
    const role = input.role || undefined;
    if (current?.id === u.id) {
      // A role or order change; allowed while the umbrella is closed only if nothing changes.
      if (role === current.role && input.order === current.order) return { value: task, changed: false };
      requireOpen(u);
      task.umbrella = { ...current, role, order: input.order };
      if (role === undefined) delete task.umbrella.role;
      if (input.order === undefined) delete task.umbrella.order;
      return { value: task, changed: true };
    }
    requireOpen(u);
    if (task.archivedAt) throw new Error("Archived cards can't join an umbrella.");
    if (umbrellaGroupOf(board, task) !== u.groupId)
      throw new ToolError("UMBRELLA_OUT_OF_GROUP", "This card's project is in another board group than the umbrella.");
    if (membersOf(board, u.id).length >= umbrellaLimits.members)
      throw new ToolError("UMBRELLA_LIMIT", `An umbrella can have at most ${umbrellaLimits.members} member cards.`);
    if (current) leave();
    task.umbrella = {
      id: u.id,
      ...(role !== undefined ? { role } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      joinedAt: new Date().toISOString(),
      by,
    };
    store.event(board, { taskId: task.id, ...eventActor(by), action: "umbrella_joined", note: u.title });
    return { value: task, changed: true };
  });
}

/** Answers an open question or supersedes an entry; bumps the umbrella's `feedRevision`, never its `revision`. */
export function updateEntry(store: BoardStore, input: UmbrellaEntryUpdateInput, _by: Actor): Promise<UmbrellaEntry> {
  return store.transaction((board) => {
    const entry = board.umbrellaEntries.find((e) => e.id === input.id);
    if (!entry) throw new ToolError("NOT_FOUND", "No umbrella entry with that id.");
    const u = find(board, entry.umbrellaId);
    requireOpen(u);
    if (input.status === "answered") {
      if (entry.kind !== "question" || entry.status !== "open") throw new ToolError("INVALID_INPUT", "Only an open question can be answered.");
      if (!input.answer) throw new ToolError("INVALID_INPUT", "An answer needs its text.");
      entry.answer = input.answer;
    } else if (entry.status !== "active" && entry.status !== "open")
      throw new ToolError("INVALID_INPUT", "Only an active entry or an open question can be superseded.");
    const now = new Date().toISOString();
    entry.status = input.status;
    entry.updatedAt = now;
    u.feedRevision++;
    return { value: entry, changed: true };
  });
}

/** Close and reopen check the revision; reopen counts against the group's open umbrellas. */
export function closeUmbrella(store: BoardStore, input: UmbrellaRevisionInput, _by: Actor): Promise<Umbrella> {
  return store.transaction((board) => {
    const u = find(board, input.id);
    requireRevision(u, input.revision);
    if (u.status === "closed") return { value: u, changed: false };
    u.status = "closed";
    u.revision++;
    u.updatedAt = new Date().toISOString();
    return { value: u, changed: true };
  });
}

export function reopenUmbrella(store: BoardStore, input: UmbrellaRevisionInput, _by: Actor): Promise<Umbrella> {
  return store.transaction((board) => {
    const u = find(board, input.id);
    requireRevision(u, input.revision);
    if (u.archivedAt) throw new ToolError("UMBRELLA_CLOSED", `The umbrella "${u.title}" is archived.`);
    if (u.status === "open") return { value: u, changed: false };
    requireRoom(board, u.groupId);
    u.status = "open";
    u.revision++;
    u.updatedAt = new Date().toISOString();
    return { value: u, changed: true };
  });
}

/** Like closing (D18): members stay, it stays readable, writes are refused and it leaves the lists. */
export function archiveUmbrella(store: BoardStore, input: UmbrellaRevisionInput, _by: Actor): Promise<Umbrella> {
  return store.transaction((board) => {
    const u = find(board, input.id);
    requireRevision(u, input.revision);
    if (u.archivedAt) return { value: u, changed: false };
    const now = new Date().toISOString();
    u.archivedAt = now;
    u.status = "closed";
    u.revision++;
    u.updatedAt = now;
    return { value: u, changed: true };
  });
}

/** The group's open umbrellas (not closed, not archived). */
export function listUmbrellas(board: Board, groupId: string): UmbrellaSummary[] {
  return board.umbrellas.filter((u) => u.groupId === groupId && !isClosed(u)).map((u) => umbrellaSummary(u, board));
}

/** One umbrella in full, readable whatever its status. */
export function getUmbrella(board: Board, id: string): { umbrella: Umbrella; entries: UmbrellaEntry[]; members: UmbrellaMember[] } {
  const umbrella = find(board, id);
  const members = membersOf(board, id).map((t): UmbrellaMember => {
    const project = board.projects.find((p) => p.id === t.projectId);
    return {
      taskId: t.id,
      projectId: t.projectId,
      projectTitle: project?.title ?? "",
      title: t.title,
      status: t.status,
      laneName: laneName(project, t.status),
      ...(t.umbrella?.role !== undefined ? { role: t.umbrella.role } : {}),
      ...(t.umbrella?.order !== undefined ? { order: t.umbrella.order } : {}),
      archived: t.archivedAt !== null,
    };
  });
  return { umbrella, entries: board.umbrellaEntries.filter((e) => e.umbrellaId === id), members };
}

/** What a member's agent appends (UMBRELLA-SPEC §4.1): flowly_add_umbrella_entry, or flowly_remember scope=umbrella. */
export type NewEntry = {
  kind: "decision" | "finding" | "convention" | "pitfall" | "question" | "ruling";
  title: string;
  body: string;
  quote?: string;
  supersedes?: string;
};

/** The umbrella `task` writes to: NOT_IN_UMBRELLA when it is in none, UMBRELLA_CLOSED when that one is closed or archived. */
export function memberUmbrella(board: Board, task: Task): Umbrella {
  const u = task.umbrella ? board.umbrellas.find((x) => x.id === task.umbrella!.id) : undefined;
  if (!u) throw new ToolError("NOT_IN_UMBRELLA", "This card is not in an umbrella; umbrella writes are for member cards only.");
  requireOpen(u);
  return u;
}

/**
 * Appends a member's entry to its card's umbrella feed (pure; the caller's transaction records the card's event). A
 * question starts `open`, every other kind `active`; `supersedes` names an active entry or open question of the same
 * umbrella and marks it superseded. At most 300 counted entries (superseding one frees its place). Bumps the
 * umbrella's `feedRevision`, never its `revision`.
 */
export function addEntry(board: Board, task: Task, input: NewEntry, by: Actor, now: string): UmbrellaEntry {
  const u = memberUmbrella(board, task);
  if (input.kind === "ruling" && !input.quote?.trim())
    throw new ToolError("INVALID_INPUT", "A ruling needs quote: the user's own words from this card's chat.");
  const replaced = input.supersedes ? board.umbrellaEntries.find((e) => e.id === input.supersedes && e.umbrellaId === u.id) : undefined;
  if (input.supersedes && !replaced) throw new ToolError("NOT_FOUND", "No entry with that id in this card's umbrella. Use an id from get_task umbrella.feed.");
  if (replaced && !countsTowardLimit(replaced))
    throw new ToolError("INVALID_INPUT", `That entry is ${replaced.status}; only an active entry or an open question can be superseded.`);
  const counted = board.umbrellaEntries.filter((e) => e.umbrellaId === u.id && countsTowardLimit(e)).length - (replaced ? 1 : 0);
  if (counted >= umbrellaLimits.activeEntries)
    throw new ToolError(
      "UMBRELLA_LIMIT",
      `This umbrella already has ${umbrellaLimits.activeEntries} active entries and open questions. Supersede one, or tell the user.`,
    );
  if (replaced) {
    replaced.status = "superseded";
    replaced.updatedAt = now;
  }
  const entry: UmbrellaEntry = {
    id: randomUUID(),
    umbrellaId: u.id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    status: input.kind === "question" ? "open" : "active",
    sourceTaskId: task.id,
    ...(input.kind === "ruling" ? { quote: input.quote } : {}),
    ...(replaced ? { supersedes: replaced.id } : {}),
    by,
    createdAt: now,
    updatedAt: now,
  };
  board.umbrellaEntries.push(entry);
  u.feedRevision++;
  return entry;
}

/**
 * Withdraws one of `task`'s own entries in its umbrella (pure): a `proposed` contract change becomes `withdrawn`, an
 * active entry or open question `superseded`. Another card's entry is NOT_FOUND; a closed entry INVALID_INPUT.
 * Bumps `feedRevision`, never `revision`.
 */
export function withdrawEntry(board: Board, task: Task, id: string, _by: Actor, now: string): UmbrellaEntry {
  const u = memberUmbrella(board, task);
  const entry = board.umbrellaEntries.find((e) => e.id === id && e.umbrellaId === u.id && e.sourceTaskId === task.id);
  if (!entry) throw new ToolError("NOT_FOUND", "No entry of this card with that id in its umbrella. Use an id from get_task umbrella.feed whose sourceTaskId is this card.");
  if (entry.status === "proposed") entry.status = "withdrawn";
  else if (countsTowardLimit(entry)) entry.status = "superseded";
  else throw new ToolError("INVALID_INPUT", `That entry is already ${entry.status}.`);
  entry.updatedAt = now;
  u.feedRevision++;
  return entry;
}

const hour = 3600000;
/**
 * Feed writes per member session (§2.4): `take` claims one of `umbrellaLimits.writesPerHour` slots in a rolling hour,
 * or throws UMBRELLA_RATE_LIMIT. Taken before the write's transaction; the returned function gives it back when the
 * write was refused or replayed. In memory: a plugin reload resets it, like `agentCardLimits.perHour`.
 */
export function umbrellaWriteLimiter(clock: () => number = () => Date.now()) {
  const slots = new Map<string, number[]>();
  return {
    take(agentId: string): () => void {
      const now = clock(),
        recent = (slots.get(agentId) || []).filter((at) => now - at < hour);
      if (recent.length >= umbrellaLimits.writesPerHour)
        throw new ToolError(
          "UMBRELLA_RATE_LIMIT",
          `This session already wrote ${umbrellaLimits.writesPerHour} umbrella feed entries in the last hour. Keep the rest for your reply or a later turn.`,
        );
      slots.set(agentId, [...recent, now]);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const list = [...(slots.get(agentId) || [])],
          at = list.lastIndexOf(now);
        if (at >= 0) list.splice(at, 1);
        slots.set(agentId, list);
      };
    },
  };
}

/** Why `u` can't take a new card of `projectId`, with the code an explicit join is refused with; undefined when it can. */
function joinProblem(board: Board, u: Umbrella, projectId: string): { code: string; reason: string } | undefined {
  if (isClosed(u)) return { code: "UMBRELLA_CLOSED", reason: `it is ${u.archivedAt ? "archived" : "closed"}` };
  if (umbrellaGroupOf(board, { projectId }) !== u.groupId)
    return { code: "UMBRELLA_OUT_OF_GROUP", reason: "it is in another board group than this card's project" };
  if (membersOf(board, u.id).length >= umbrellaLimits.members)
    return { code: "UMBRELLA_LIMIT", reason: `it already has ${umbrellaLimits.members} member cards` };
  return undefined;
}

/**
 * The umbrella a new card joins (D11, §4.1): an explicit `umbrellaId` (the New task form), refused with its code when
 * that umbrella can't take the card; `null` none; otherwise inherited from `followUpOf`'s umbrella, or the idea's
 * `umbrellaId`, else its source card's umbrella. An inherit the umbrella can't take returns `skipped` (why) and never
 * refuses the card.
 */
export function newCardUmbrella(
  board: Board,
  input: { projectId: string; umbrellaId?: string | null; followUpOf?: string; ideaId?: string },
): { umbrella?: Umbrella; skipped?: string } {
  if (input.umbrellaId === null) return {};
  if (input.umbrellaId !== undefined) {
    const u = find(board, input.umbrellaId);
    const problem = joinProblem(board, u, input.projectId);
    if (problem) throw new ToolError(problem.code, `The card can't join the umbrella "${u.title}": ${problem.reason}.`);
    return { umbrella: u };
  }
  const memberOf = (taskId: string | undefined) => (taskId ? board.tasks.find((t) => t.id === taskId)?.umbrella?.id : undefined);
  const idea = input.ideaId ? board.ideas.find((i) => i.id === input.ideaId) : undefined;
  const id = input.followUpOf ? memberOf(input.followUpOf) : idea ? (idea.umbrellaId ?? memberOf(idea.taskId)) : undefined;
  const u = id ? board.umbrellas.find((x) => x.id === id) : undefined;
  if (!u) return {};
  const problem = joinProblem(board, u, input.projectId);
  return problem ? { skipped: `The card was made without joining the umbrella "${u.title}": ${problem.reason}.` } : { umbrella: u };
}
