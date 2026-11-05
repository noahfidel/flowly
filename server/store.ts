import { laneName, laneProblem } from "../shared/lanes";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonBoardFile, StoreInvalidError, assertBoardInvariants, writeFileDurable, type BoardPersistence } from "./board-file";
import { BoardStorage, type StorageOptions } from "./sqlite-storage";
import type { StorageStatus } from "../shared/storage";
import { ideaTitleKey } from "../shared/ideas";
import { otherEnd, relationLabels, relationOf, touches } from "../shared/links";
import { changeTags, mergeTagEdit, normalizeTags, tagChangeNote } from "../shared/tags";
import { attentionDismissLimits, dismissalSignals, type AttentionDismissInput, type AttentionRestoreInput } from "../shared/attention-dismiss";
import type { FlowLog } from "./flow-log";
import { linearTeamValue } from "../shared/linear-ticket";
import type { ProjectSnapshot } from "./project-folder";
import {
  boardSchema,
  storageSchema,
  emptyBoard,
  type Board,
  type BoardEvent,
  type Project,
  type Task,
  type TaskEdit,
  type TaskTagsEdit,
  type TaskPlacement,
  type ProjectEdit,
  type ProjectRemoval,
  type TaskDeletion,
  type IdeaEdit,
  ideaLimits,
  projectOrder,
} from "../shared/model";
import { logFailure } from "./error-report";

export { StoreInvalidError };

export const columnOrder = (a: Task, b: Task) =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt);

/** Position strictly between the neighbors at `index`, or null when equal neighbors leave no room. */
export function slotPosition(
  peers: readonly { position: number }[],
  index: number,
): number | null {
  const previous = peers[index - 1],
    next = peers[index];
  if (!previous) return next ? next.position - 1 : 0;
  if (!next) return previous.position + 1;
  const middle = (previous.position + next.position) / 2;
  return previous.position < middle && middle < next.position ? middle : null;
}

/** Stores a card's tags; an empty list removes the field (cards without tags carry none). */
export function setTags(task: Task, tags: Task["tags"]) {
  if (tags?.length) task.tags = tags;
  else delete task.tags;
}

export class BoardStore {
  private tail: Promise<unknown> = Promise.resolve();
  /** Events created by the running transaction; appended to the flow log once it commits. */
  private pending: BoardEvent[] = [];
  /** Untrimmed event log for insights (PROJECT-INSIGHTS-SPEC §2). */
  flow: FlowLog | null = null;
  /** Runs after each committed write (project folder snapshots, PROJECT-FOLDER-SPEC). */
  onCommit: (() => void) | null = null;
  private readonly json: JsonBoardFile;
  /** SQLite storage with its fallback to board.json (SQLITE-STORAGE-SPEC); null keeps board.json only. */
  readonly storage: BoardStorage | null;
  constructor(
    readonly directory: string,
    options: { backend?: "json" | "sqlite"; storage?: StorageOptions } = {},
  ) {
    this.json = new JsonBoardFile(directory);
    this.storage = options.backend === "sqlite" ? new BoardStorage(directory, this.json, options.storage) : null;
    if (this.storage) this.tail = this.storage.start();
  }
  get path() {
    return this.json.path;
  }
  private persistence(): Promise<BoardPersistence> {
    return this.storage ? this.storage.persistence() : Promise.resolve(this.json);
  }
  async read() {
    if (this.storage) return this.queue(async () => (await this.persistence()).load());
    await this.tail;
    return this.json.load();
  }
  async view() {
    return boardSchema.parse(await this.read());
  }
  mutate<T>(operation: (board: Board) => Promise<T> | T): Promise<T> {
    return this.transaction(async (board) => ({
      value: await operation(board),
      changed: true,
    }));
  }
  transaction<T>(
    operation: (
      board: Board,
    ) =>
      | Promise<{ value: T; changed: boolean }>
      | { value: T; changed: boolean },
  ): Promise<T> {
    return this.queue(async () => {
      this.pending = [];
      const persistence = await this.persistence();
      const board = await persistence.load();
      const result = await operation(board);
      const events = this.pending;
      this.pending = [];
      if (!result.changed) return result.value;
      board.revision++;
      assertBoardInvariants(board);
      await persistence.save(storageSchema.parse(board));
      this.onCommit?.();
      if (this.flow && events.length)
        void this.flow.append(events, board).catch((e) =>
          logFailure("Kanban flow log append failed:", e),
        );
      await this.storage?.afterCommit();
      return result.value;
    });
  }
  /** Runs after every queued read and write, before the next one starts. */
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /** Settings > Storage (SQLITE-STORAGE-SPEC §9); the board may be unreadable meanwhile. */
  async storageStatus(): Promise<StorageStatus> {
    if (!this.storage) return { backend: "json", directory: this.directory, backups: [] };
    await this.tail;
    return this.storage.status();
  }
  backupStorage() {
    return this.queue(() => this.requireStorage().backup());
  }
  restoreStorage(name: string) {
    return this.queue(async () => {
      const result = await this.requireStorage().restore(name);
      this.onCommit?.();
      return result;
    });
  }
  exportStorage() {
    return this.queue(async () => {
      const result = await this.requireStorage().exportJson();
      this.onCommit?.();
      return result;
    });
  }
  useSqliteStorage() {
    return this.queue(() => this.requireStorage().useSqlite());
  }
  /** Plugin shutdown: finishes queued writes and closes the database. */
  close() {
    return this.queue(async () => this.storage?.close());
  }
  private requireStorage() {
    if (!this.storage) throw new Error("This store keeps board.json only.");
    return this.storage;
  }
  async editTask(input: TaskEdit): Promise<Task> {
    return this.mutate((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error(
          "Revision conflict: this card changed. Reload before saving your draft.",
        );
      const previous = task.status;
      if (input.status !== undefined && input.status !== task.status) {
        const laneError = laneProblem(board.projects.find((p) => p.id === task.projectId), input.status);
        if (laneError) throw new Error(laneError);
      }
      if ((input.tags === undefined) !== (input.tagsBase === undefined))
        throw new Error("Tags and the tags the form started from must be sent together.");
      const tagChange =
        input.tags !== undefined
          ? mergeTagEdit(task.tags || [], normalizeTags(input.tagsBase!), normalizeTags(input.tags), new Date().toISOString())
          : undefined;
      if (tagChange) setTags(task, tagChange.tags);
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.priority !== undefined) task.priority = input.priority;
      if (input.type === null) delete task.type;
      else if (input.type !== undefined) task.type = input.type;
      if (input.status !== undefined) task.status = input.status;
      if (input.archived !== undefined)
        task.archivedAt = input.archived ? new Date().toISOString() : null;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      this.event(board, {
        taskId: task.id,
        actor: input.actor,
        agentId: input.agentId,
        action:
          previous !== task.status
            ? "status_changed"
            : input.archived !== undefined
              ? "archive_changed"
              : "edited",
        from: previous !== task.status ? previous : undefined,
        to: previous !== task.status ? task.status : undefined,
        note: input.note,
      });
      if (tagChange && (tagChange.added.length || tagChange.removed.length))
        this.event(board, { taskId: task.id, actor: "human", action: "tags_changed", note: tagChangeNote(tagChange) });
      return task;
    });
  }
  /**
   * Single tag adds/removes from the drawer (CARD-TAGS-SPEC §3). Only the board revision
   * changes, so open forms and agents' signed requests stay valid.
   */
  editTags(input: TaskTagsEdit): Promise<Task> {
    return this.transaction((board) => {
      const task = board.tasks.find((t) => t.id === input.taskId);
      if (!task) throw new Error("Task not found.");
      const project = board.projects.find((p) => p.id === task.projectId);
      if (task.archivedAt || !project || project.archivedAt) throw new Error("Archived cards can't be changed.");
      const change = changeTags(
        task.tags || [],
        { add: normalizeTags(input.add || []), remove: normalizeTags(input.remove || []) },
        { actor: "human", at: new Date().toISOString() },
      );
      if (!change.added.length && !change.removed.length) return { value: task, changed: false };
      setTags(task, change.tags);
      this.event(board, { taskId: task.id, actor: "human", action: "tags_changed", note: tagChangeNote(change) });
      return { value: task, changed: true };
    });
  }
  placeTask(input: TaskPlacement): Promise<Task> {
    return this.transaction((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error(
          "Revision conflict: this card changed. Reload before moving.",
        );
      const project = board.projects.find((p) => p.id === task.projectId);
      if (task.archivedAt || !project || project.archivedAt)
        throw new Error("Archived cards cannot be moved.");
      if (input.status !== task.status) {
        const laneError = laneProblem(project, input.status);
        if (laneError) throw new Error(laneError);
      }
      const column = board.tasks
        .filter((t) => t.projectId === task.projectId && t.status === input.status)
        .sort(columnOrder);
      const peers = column.filter((t) => t !== task);
      const anchorId = input.beforeId ?? input.afterId;
      let index = peers.length;
      if (anchorId) {
        const anchor = peers.findIndex((t) => t.id === anchorId);
        if (anchor < 0)
          throw new Error("Drop position changed. Reload and try again.");
        index = input.beforeId ? anchor : anchor + 1;
      }
      if (task.status === input.status && column.indexOf(task) === index)
        return { value: task, changed: false };
      let position = slotPosition(peers, index);
      if (position === null) {
        peers.forEach((t, i) => {
          t.position = i;
        });
        position = slotPosition(peers, index)!;
      }
      const previous = task.status;
      task.status = input.status;
      task.position = position;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      if (previous !== task.status)
        this.event(board, {
          taskId: task.id,
          actor: "human",
          action: "status_changed",
          from: previous,
          to: task.status,
        });
      return { value: task, changed: true };
    });
  }
  /**
   * Reorders projects for the chooser. Order is presentation, not project
   * data: no revision bump, so agent writes holding a project revision are
   * unaffected. All projects are renumbered 0..n in the resulting order.
   */
  /**
   * Project settings. A lane can only be turned off once it holds no live
   * cards, so no card is ever left outside the project's workflow.
   */
  updateProject(input: ProjectEdit) {
    return this.mutate((board) => {
      const p = board.projects.find((p) => p.id === input.id);
      if (!p) throw new Error("Project not found.");
      if (p.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before saving.");
      if (input.lanes) {
        const blocked = input.lanes
          .filter((l) => !l.enabled)
          .map((l) => ({
            lane: l,
            count: board.tasks.filter((t) => t.projectId === p.id && !t.archivedAt && t.status === l.status).length,
          }))
          .filter((x) => x.count);
        if (blocked.length)
          throw new Error(
            `Move the cards out of ${blocked
              .map((x) => `${laneName(p, x.lane.status)} (${x.count})`)
              .join(", ")} before turning ${blocked.length === 1 ? "it" : "them"} off.`,
          );
        p.lanes = input.lanes.map((l) => ({ status: l.status, enabled: l.enabled, ...(l.name?.trim() ? { name: l.name.trim() } : {}) }));
      }
      if (input.title !== undefined) p.title = input.title;
      if (input.description !== undefined) p.description = input.description;
      if (input.autoStatus !== undefined) p.autoStatus = input.autoStatus;
      if (input.workpad !== undefined) p.workpad = input.workpad;
      if (input.workflowInsights !== undefined) p.workflowInsights = input.workflowInsights;
      if (input.memory !== undefined) p.memory = input.memory;
      if (input.linearTicket !== undefined) p.linearTicket = input.linearTicket;
      if (input.linearTeam !== undefined) {
        const team = linearTeamValue(input.linearTeam);
        if (team) p.linearTeam = team;
        else delete p.linearTeam;
      }
      if (input.agentModel !== undefined) {
        if (input.agentModel) p.agentModel = input.agentModel;
        else delete p.agentModel;
      }
      if (input.archived !== undefined)
        p.archivedAt = input.archived ? new Date().toISOString() : null;
      p.revision++;
      p.updatedAt = new Date().toISOString();
      return p;
    });
  }
  /**
   * Drops a project and its cards (with their events and agent receipts) from
   * the board. Paseo resources are untouched. The removed records are first
   * written to `removed/<project>-<time>.json` so a mistaken removal can be recovered.
   */
  removeProject(input: ProjectRemoval) {
    return this.mutate(async (board) => {
      const project = board.projects.find((p) => p.id === input.id);
      if (!project) throw new Error("Project not found.");
      if (project.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before removing it.");
      const taskIds = new Set(board.tasks.filter((t) => t.projectId === project.id).map((t) => t.id));
      const removed = {
        removedAt: new Date().toISOString(),
        project,
        tasks: board.tasks.filter((t) => taskIds.has(t.id)),
        events: board.events.filter((e) => taskIds.has(e.taskId)),
        agentReceipts: board.agentReceipts.filter((r) => taskIds.has(r.taskId)),
        ideas: board.ideas.filter((i) => taskIds.has(i.taskId)),
        links: board.links.filter((l) => l.projectId === project.id || taskIds.has(l.from) || taskIds.has(l.to)),
        artifacts: board.artifacts.filter((a) => taskIds.has(a.taskId)),
        workpads: board.workpads.filter((w) => taskIds.has(w.taskId)),
        plans: board.plans.filter((p) => taskIds.has(p.taskId)),
      };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `${project.id}-${removed.removedAt.replace(/[:.]/g, "-")}.json`);
      await writeFileDurable(backup, JSON.stringify(removed, null, 2), "wx");
      board.projects = board.projects.filter((p) => p.id !== project.id);
      board.tasks = board.tasks.filter((t) => !taskIds.has(t.id));
      board.events = board.events.filter((e) => !taskIds.has(e.taskId));
      board.agentReceipts = board.agentReceipts.filter((r) => !taskIds.has(r.taskId));
      board.ideas = board.ideas.filter((i) => !taskIds.has(i.taskId));
      board.links = board.links.filter((l) => !removed.links.includes(l));
      board.artifacts = board.artifacts.filter((a) => !taskIds.has(a.taskId));
      board.workpads = board.workpads.filter((w) => !taskIds.has(w.taskId));
      board.plans = board.plans.filter((p) => !taskIds.has(p.taskId));
      board.attentionDismissals = board.attentionDismissals.filter((d) => !taskIds.has(d.taskId));
      return { id: project.id, removedTasks: taskIds.size, backup };
    });
  }
  /**
   * Puts a project saved in its folder back on the board (PROJECT-FOLDER-SPEC §3).
   * Same IDs; cards whose workspace is bound elsewhere keep their record
   * without it. Every restored record gets a new revision so stale tool writes re-read.
   */
  restoreProject(snapshot: ProjectSnapshot, at: { primaryPath: string; paseoProjectId: string }) {
    return this.mutate((board) => {
      const source = snapshot.project;
      if (board.projects.some((p) => p.id === source.id)) throw new Error("This project is already on the board.");
      if (board.projects.some((p) => p.paseoProjectId === at.paseoProjectId))
        throw new Error("Paseo project is already linked; open or restore its board project.");
      const taskIds = new Set(snapshot.tasks.map((t) => t.id));
      if (board.tasks.some((t) => taskIds.has(t.id))) throw new Error("Some of these cards are already on the board.");
      const bound = new Set(board.tasks.map((t) => t.workspaceId)),
        operations = new Set(board.tasks.map((t) => t.operationId));
      const now = new Date().toISOString();
      const project: Project = {
        ...source,
        primaryPath: at.primaryPath,
        paseoProjectId: at.paseoProjectId,
        repos: source.repos.map((r) => (r === source.primaryPath ? at.primaryPath : r)),
        position: board.projects.length,
        revision: source.revision + 1,
        updatedAt: now,
      };
      if (!project.repos.includes(at.primaryPath)) project.repos.unshift(at.primaryPath);
      const move = (path: string) => (path === source.primaryPath ? at.primaryPath : path);
      let unbound = 0;
      const tasks = snapshot.tasks.map((t) => {
        const task: Task = {
          ...t,
          sourcePath: move(t.sourcePath),
          repoPaths: t.repoPaths.map(move),
          revision: t.revision + 1,
          updatedAt: now,
          operationId: operations.has(t.operationId) ? `restored-${t.id}` : t.operationId,
        };
        if (bound.has(t.workspaceId)) {
          // A placeholder that resolves to no workspace: the drawer shows it unavailable.
          task.workspaceId = `unbound-${t.id}`;
          delete task.ownsWorkspace;
          unbound++;
        }
        return task;
      });
      board.projects.push(project);
      board.tasks.push(...tasks);
      board.events.push(...snapshot.events.filter((e) => taskIds.has(e.taskId)));
      board.ideas.push(...snapshot.ideas.filter((i) => taskIds.has(i.taskId)));
      const linkIds = new Set(board.links.map((l) => l.id));
      board.links.push(...snapshot.links.filter((l) => taskIds.has(l.from) && taskIds.has(l.to) && !linkIds.has(l.id)));
      const artifactIds = new Set(board.artifacts.map((a) => a.id));
      board.artifacts.push(...snapshot.artifacts.filter((a) => taskIds.has(a.taskId) && !artifactIds.has(a.id)).map((a) => ({ ...a, projectId: project.id })));
      board.workpads.push(...(snapshot.workpads || []).filter((w) => taskIds.has(w.taskId)).map((w) => ({ ...w, projectId: project.id })));
      board.plans.push(...(snapshot.plans || []).filter((p) => taskIds.has(p.taskId)));
      for (const t of tasks)
        this.event(board, { taskId: t.id, actor: "human", action: "restored", note: "Restored from project folder" });
      return { project, cards: tasks.length, unbound };
    });
  }
  /**
   * Permanently drops one card with its events and agent receipts.
   * Paseo resources are untouched. The removed records are first written to
   * `removed/task-<id>-<time>.json`.
   */
  deleteTask(input: Pick<TaskDeletion, "id" | "revision">) {
    return this.mutate(async (board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error("Revision conflict: reload the card before deleting it.");
      const removed = {
        removedAt: new Date().toISOString(),
        tasks: [task],
        events: board.events.filter((e) => e.taskId === task.id),
        agentReceipts: board.agentReceipts.filter((r) => r.taskId === task.id),
        ideas: board.ideas.filter((i) => i.taskId === task.id),
        links: board.links.filter((l) => touches(l, task.id)),
        artifacts: board.artifacts.filter((a) => a.taskId === task.id),
        workpads: board.workpads.filter((w) => w.taskId === task.id),
        plans: board.plans.filter((p) => p.taskId === task.id),
      };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `task-${task.id}-${removed.removedAt.replace(/[:.]/g, "-")}.json`);
      await writeFileDurable(backup, JSON.stringify(removed, null, 2), "wx");
      board.tasks = board.tasks.filter((t) => t !== task);
      board.events = board.events.filter((e) => e.taskId !== task.id);
      board.agentReceipts = board.agentReceipts.filter((r) => r.taskId !== task.id);
      board.ideas = board.ideas.filter((i) => i.taskId !== task.id);
      // The other card keeps a trace of the link it lost (CARD-LINKS-SPEC §6).
      for (const link of removed.links) {
        const other = otherEnd(link, task.id);
        if (board.tasks.some((t) => t.id === other))
          this.event(board, {
            taskId: other,
            actor: "human",
            action: "unlinked",
            note: `${relationLabels[relationOf(link, other)]}: ${task.title}`,
          });
      }
      board.links = board.links.filter((l) => !touches(l, task.id));
      board.artifacts = board.artifacts.filter((a) => a.taskId !== task.id);
      board.workpads = board.workpads.filter((w) => w.taskId !== task.id);
      board.plans = board.plans.filter((p) => p.taskId !== task.id);
      board.attentionDismissals = board.attentionDismissals.filter((d) => d.taskId !== task.id);
      return { id: task.id, backup };
    });
  }
  /**
   * Hides a card from Attention until a signal not in `signals` appears
   * (ATTENTION-DISMISS-SPEC §5). A display preference: no revision, no Activity.
   */
  dismissAttention(input: AttentionDismissInput) {
    return this.transaction((board) => {
      const task = board.tasks.find((t) => t.id === input.taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (!task) throw new Error("Task not found.");
      if (task.archivedAt || !project || project.archivedAt) throw new Error("The card or its project is archived.");
      const signals = dismissalSignals(input.signals);
      const current = board.attentionDismissals.find((d) => d.taskId === task.id);
      if (current && current.signals.length === signals.length && signals.every((s) => current.signals.includes(s)))
        return { value: current, changed: false };
      const others = board.attentionDismissals.filter((d) => d.taskId !== task.id);
      if (others.length >= attentionDismissLimits.records)
        throw new Error(`Attention already has ${attentionDismissLimits.records} dismissed cards.`);
      const record = { taskId: task.id, signals, dismissedAt: new Date().toISOString() };
      board.attentionDismissals = [...others, record];
      return { value: record, changed: true };
    });
  }
  /** Puts a dismissed card back into Attention; idempotent. */
  restoreAttention(input: AttentionRestoreInput) {
    return this.transaction((board) => {
      if (!board.tasks.some((t) => t.id === input.taskId)) throw new Error("Task not found.");
      const before = board.attentionDismissals.length;
      board.attentionDismissals = board.attentionDismissals.filter((d) => d.taskId !== input.taskId);
      return { value: { taskId: input.taskId }, changed: board.attentionDismissals.length !== before };
    });
  }
  /** Dismisses or restores an idea; accepted ideas are final (IDEAS-SPEC §7, IDEAS-INBOX-SPEC §2.2). */
  updateIdea(input: IdeaEdit) {
    return this.transaction((board) => {
      const idea = board.ideas.find((i) => i.id === input.id);
      if (!idea) throw new Error("Idea not found.");
      if (idea.status === "accepted") throw new Error("This idea already became a card.");
      if (idea.status === input.status) return { value: idea, changed: false };
      const task = board.tasks.find((t) => t.id === idea.taskId),
        project = board.projects.find((p) => p.id === idea.projectId);
      // The card's own status and archive do not matter: ideas outlive it (IDEAS-INBOX-SPEC §2.2).
      if (!task || !project || project.archivedAt) throw new Error("The project is archived.");
      if (input.status === "open") {
        const open = board.ideas.filter((i) => i.taskId === idea.taskId && i.status === "open");
        if (open.some((i) => ideaTitleKey(i.title) === ideaTitleKey(idea.title)))
          throw new Error("This card already has an open idea with that title.");
        if (open.length >= ideaLimits.openPerTask)
          throw new Error(`This card already has ${ideaLimits.openPerTask} open ideas.`);
      }
      idea.status = input.status;
      idea.updatedAt = new Date().toISOString();
      this.event(board, {
        taskId: idea.taskId,
        actor: "human",
        action: input.status === "dismissed" ? "idea_dismissed" : "idea_restored",
        note: idea.title,
      });
      return { value: idea, changed: true };
    });
  }
  moveProject(input: { id: string; direction?: "up" | "down" | "top"; to?: number }) {
    return this.transaction((board) => {
      const ordered = [...board.projects].sort(projectOrder);
      const index = ordered.findIndex((p) => p.id === input.id);
      if (index < 0) throw new Error("Project not found.");
      const target =
        input.to !== undefined
          ? Math.min(ordered.length - 1, input.to)
          : input.direction === "top" ? 0 : input.direction === "up" ? Math.max(0, index - 1) : Math.min(ordered.length - 1, index + 1);
      const changed = target !== index || ordered.some((p, i) => p.position !== i);
      if (!changed) return { value: ordered.map((p) => p.id), changed: false };
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved);
      ordered.forEach((p, i) => (p.position = i));
      return { value: ordered.map((p) => p.id), changed: true };
    });
  }
  event(board: Board, input: Omit<BoardEvent, "id" | "at">) {
    const event = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
    board.events.push(event);
    this.pending.push(event);
    const relevant = board.events.filter((e) => e.taskId === input.taskId);
    if (relevant.length > 100) {
      const remove = new Set(relevant.slice(0, -100).map((e) => e.id));
      board.events = board.events.filter((e) => !remove.has(e.id));
    }
    return event;
  }
}
