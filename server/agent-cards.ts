import type { PaseoApi } from "@getpaseo/client";
import { laneEnabled, laneName, projectLanes } from "../shared/lanes";
import { linksOf } from "../shared/links";
import { changeTags, normalizeTags, tagChangeNote } from "../shared/tags";
import { tagLimits, type Board, type Project, type Task } from "../shared/model";
import { isSummarizer } from "../shared/summary";
import {
  agentCardLimits,
  createCardInputSchema,
  getCardInputSchema,
  listCardsInputSchema,
  updateCardInputSchema,
  type BoardIdentity,
  type CardView,
} from "../shared/tools";
import { BoardService } from "./service";
import { BoardStore, columnOrder, setTags } from "./store";
import { digest } from "./tool-context";
import { ToolError } from "./tool-error";

/** Who calls a card tool: a card session (its card is `taskId`) or a session outside cards (AGENT-CARDS-SPEC §2). */
export type CardCaller = { agentId: string; projectId: string; taskId?: string };

const hour = 3600000;

/**
 * flowly_list_cards, flowly_get_card, flowly_create_card and flowly_update_card (AGENT-CARDS-SPEC §3):
 * any card of the caller's project, created through the New card path and edited under its revision.
 */
export class AgentCards {
  private paseo?: PaseoApi;
  /** Per session, when it created cards in the last hour; a plugin reload resets it (§3.3). */
  private created = new Map<string, number[]>();
  /** The Agents create and edit cards setting (§2.3); set by the plugin entry. */
  on: () => Promise<boolean> = async () => true;
  /** The board service the New card form uses; set by the plugin entry so creations share its queue. */
  board: BoardService;
  constructor(
    readonly store: BoardStore,
    readonly clock = () => Date.now(),
  ) {
    this.board = new BoardService(store);
  }
  attach(paseo: PaseoApi) {
    this.paseo = paseo;
  }
  /** The attached Paseo API, or PASEO_UNAVAILABLE. */
  api() {
    if (!this.paseo)
      throw new ToolError(
        "PASEO_UNAVAILABLE",
        "Paseo context is not ready after startup/reload. Try again after the next session turn starts.",
        true,
      );
    return this.paseo;
  }
  /** AGENT_CARDS_DISABLED when the setting is off; flowly_start_card shares it (START-CARD-SPEC §1). */
  async enabled() {
    if (!(await this.on()))
      throw new ToolError(
        "AGENT_CARDS_DISABLED",
        "Agents creating and editing cards is turned off in Flowly settings. Tell the user what you would have changed instead.",
      );
  }
  /**
   * CARD_LIMIT when this session already made `agentCardLimits.perHour` creations in the last hour;
   * card creations and flowly_start_card sessions count together (START-CARD-SPEC §3).
   */
  checkLimit(agentId: string) {
    const now = this.clock(),
      recent = (this.created.get(agentId) || []).filter((at) => now - at < hour);
    if (recent.length >= agentCardLimits.perHour)
      throw new ToolError(
        "CARD_LIMIT",
        `This session already created or started ${agentCardLimits.perHour} cards in the last hour. Stop and ask the user before creating more.`,
      );
    return recent;
  }
  /** Counts one creation for the hourly limit. */
  countCreation(agentId: string) {
    const now = this.clock();
    this.created.set(agentId, [...(this.created.get(agentId) || []).filter((at) => now - at < hour), now]);
  }
  /** A session outside cards, checked again on every call (§2.2). */
  async boardCaller(identity: BoardIdentity): Promise<CardCaller> {
    await this.enabled();
    return this.liveBoardCaller(identity);
  }
  /** The same session checks without the card switch, for tools with their own switch (flowly_propose_idea, PROJECT-IDEAS-SPEC §4). */
  async liveBoardCaller(identity: BoardIdentity): Promise<CardCaller> {
    const paseo = this.api();
    const actor = await paseo.agents.ref(identity.agentId).refresh();
    if (!actor?.agent || actor.agent.archivedAt || actor.agent.workspaceId !== identity.workspaceId)
      throw new ToolError("SESSION_MISMATCH", "Session is unavailable, archived, or belongs to another workspace.");
    const workspace = await paseo.workspaces.ref(identity.workspaceId).refresh();
    if (!workspace || workspace.archivingAt)
      throw new ToolError("RESOURCE_UNAVAILABLE", "Workspace is unavailable or being archived.");
    const project = (await this.store.read()).projects.find((p) => p.id === identity.projectId);
    if (!project || project.archivedAt) throw new ToolError("ARCHIVED", "The Flowly project is archived or was removed.");
    if (workspace.projectId !== project.paseoProjectId)
      throw new ToolError("SESSION_MISMATCH", "This workspace no longer belongs to the Flowly project.");
    return { agentId: identity.agentId, projectId: project.id };
  }
  /**
   * Whether a session opening in `workspaceId` gets the project's card tools, and for which project
   * (§2.2). `managed`: it is a card session, which has them already.
   */
  async boardSession(request: { agentId: string; workspaceId: string | null; labels?: Record<string, string> }, managed: boolean) {
    if (!request.workspaceId || managed || isSummarizer({ labels: request.labels ?? null })) return null;
    if (!(await this.on())) return null;
    const workspace = await this.api().workspaces.ref(request.workspaceId).refresh();
    if (!workspace || workspace.archivingAt || !workspace.projectId) return null;
    const project = (await this.store.read()).projects.find((p) => !p.archivedAt && p.paseoProjectId === workspace.projectId);
    return project ? { agentId: request.agentId, workspaceId: request.workspaceId, projectId: project.id } : null;
  }
  private project(board: Board, caller: CardCaller) {
    const project = board.projects.find((p) => p.id === caller.projectId);
    if (!project) throw new ToolError("ARCHIVED", "The Flowly project was removed.");
    return project;
  }
  async list(caller: CardCaller, raw: unknown) {
    const input = listCardsInputSchema.parse(raw);
    const board = await this.store.read(),
      project = this.project(board, caller);
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const lanes = projectLanes(project).map((l) => l.status);
    const found = board.tasks
      .filter(
        (t) =>
          t.projectId === project.id &&
          (input.includeArchived || !t.archivedAt) &&
          (!input.status || input.status.includes(t.status)) &&
          words.every((w) => [t.title, t.description, ...(t.tags || []).map((x) => x.tag)].join("\n").toLowerCase().includes(w)),
      )
      .sort((a, b) => lanes.indexOf(a.status) - lanes.indexOf(b.status) || columnOrder(a, b));
    return {
      project: { id: project.id, title: project.title },
      lanes: projectLanes(project)
        .filter((l) => l.enabled)
        .map((l) => ({ status: l.status, name: laneName(project, l.status) })),
      cards: found.slice(0, input.limit).map((t) => {
        const cut = t.description.length > agentCardLimits.preview;
        return {
          taskId: t.id,
          title: t.title,
          status: t.status,
          laneName: laneName(project, t.status),
          priority: t.priority,
          ...(t.type ? { type: t.type } : {}),
          tags: (t.tags || []).map((x) => x.tag),
          revision: t.revision,
          updatedAt: t.updatedAt,
          archived: !!t.archivedAt,
          description: cut ? t.description.slice(0, agentCardLimits.preview) : t.description,
          ...(cut ? { descriptionTruncated: true } : {}),
        };
      }),
      truncated: found.length > input.limit,
    };
  }
  async get(caller: CardCaller, raw: unknown) {
    const { taskId } = getCardInputSchema.parse(raw);
    const board = await this.store.read(),
      project = this.project(board, caller),
      task = board.tasks.find((t) => t.id === taskId && t.projectId === project.id);
    if (!task) throw new ToolError("CARD_NOT_FOUND", "No card with that id in this project. Use an id from flowly_list_cards.");
    const reason = task.archivedAt
      ? "The card is archived."
      : ["done", "cancelled"].includes(task.status)
        ? "The card is finished; only the user reopens or changes it."
        : "";
    return { card: cardView(board, project, task), editable: !reason, reason };
  }
  async create(caller: CardCaller, raw: unknown) {
    const input = createCardInputSchema.parse(raw);
    await this.enabled();
    const board = await this.store.read(),
      project = this.project(board, caller);
    if (project.archivedAt) throw new ToolError("ARCHIVED", "The Flowly project is archived.");
    const operationId = `agent-card:${digest(JSON.stringify([caller.taskId ?? caller.projectId, caller.agentId, input.idempotencyKey]))}`;
    const previous = board.tasks.find((t) => t.operationId === operationId);
    if (previous) {
      if (previous.projectId !== project.id || previous.title !== input.title)
        throw new ToolError("REQUEST_REUSED", "This idempotencyKey already created a different card. Use a new key for a new card.");
      return { card: cardView(board, project, previous), replayed: true };
    }
    const status = input.status ?? (laneEnabled(project, "backlog") ? "backlog" : "todo");
    if (!laneEnabled(project, status))
      throw new ToolError("STATUS_UNAVAILABLE", `${laneName(project, status)} is not a lane in this project.`);
    let tags: string[];
    try {
      tags = normalizeTags(input.tags || []);
    } catch (e) {
      throw new ToolError("TAG_INVALID", e instanceof Error ? e.message : String(e));
    }
    if (tags.length > tagLimits.perTask) throw new ToolError("TAG_INVALID", `A card can have at most ${tagLimits.perTask} tags.`);
    // A linked-root project has no worktree option (START-CARD-SPEC §7).
    if (input.workspace === "worktree" && project.links?.length)
      throw new ToolError("WORKTREE_UNAVAILABLE", "This project links several repositories and has no worktree option. Create the card without workspace=worktree.");
    this.checkLimit(caller.agentId);
    let task: Task;
    try {
      task = await this.board.createTask(
        {
          projectId: project.id,
          operationId,
          title: input.title,
          description: input.description,
          status,
          priority: input.priority,
          ...(input.type ? { type: input.type } : {}),
          ...(tags.length ? { tags } : {}),
          mode: input.workspace,
          baseRef: "",
          ...(caller.taskId ? { followUpOf: caller.taskId } : {}),
        },
        this.api(),
        { agentId: caller.agentId },
      );
    } catch (e) {
      throw new ToolError("CARD_CREATE_FAILED", e instanceof Error ? e.message : String(e));
    }
    this.countCreation(caller.agentId);
    const after = await this.store.read();
    return { card: cardView(after, this.project(after, caller), after.tasks.find((t) => t.id === task.id) ?? task), replayed: false };
  }
  async update(caller: CardCaller, raw: unknown) {
    const input = updateCardInputSchema.parse(raw);
    await this.enabled();
    const fields = ["title", "description", "priority", "type", "status", "addTags", "removeTags"] as const;
    if (!fields.some((k) => input[k] !== undefined))
      throw new ToolError("INVALID_INPUT", "Give at least one field to change.");
    return this.store.transaction((board) => {
      const project = this.project(board, caller),
        task = board.tasks.find((t) => t.id === input.taskId && t.projectId === project.id);
      if (!task) throw new ToolError("CARD_NOT_FOUND", "No card with that id in this project. Use an id from flowly_list_cards.");
      if (task.archivedAt || project.archivedAt) throw new ToolError("ARCHIVED", "The card or its project is archived.");
      if (["done", "cancelled"].includes(task.status))
        throw new ToolError("TASK_FINISHED", "Only a human can reopen or change a finished card.");
      if (task.revision !== input.revision)
        throw new ToolError(
          "REVISION_CONFLICT",
          `The card changed (current revision=${task.revision}). Read it again with flowly_get_card and keep the other changes.`,
        );
      if (input.status !== undefined && input.status !== task.status) {
        if (!(["backlog", "todo"] as string[]).includes(task.status))
          throw new ToolError(
            "STATUS_FORBIDDEN",
            "Agents move cards only between Backlog and Todo. Work stages belong to the card's own session (flowly_update_status); Done and Cancelled to the user.",
          );
        if (!laneEnabled(project, input.status))
          throw new ToolError("STATUS_UNAVAILABLE", `${laneName(project, input.status)} is not a lane in this project.`);
      }
      const at = new Date(this.clock()).toISOString();
      let tagChange;
      if (input.addTags !== undefined || input.removeTags !== undefined)
        try {
          tagChange = changeTags(
            task.tags || [],
            { add: normalizeTags(input.addTags || []), remove: normalizeTags(input.removeTags || []) },
            { actor: "agent", agentId: caller.agentId, at },
          );
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          throw new ToolError(text.startsWith("Only the user") ? "TAG_FORBIDDEN" : "TAG_INVALID", text);
        }
      const changed: string[] = [];
      for (const k of ["title", "description", "priority", "type", "status"] as const)
        if (input[k] !== undefined && input[k] !== task[k]) changed.push(k);
      const tagsChanged = !!tagChange && (tagChange.added.length > 0 || tagChange.removed.length > 0);
      if (tagsChanged) changed.push("tags");
      if (!changed.length) return { value: { card: cardView(board, project, task), changed }, changed: false };
      const previous = task.status;
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.priority !== undefined) task.priority = input.priority;
      if (input.type !== undefined) task.type = input.type;
      if (input.status !== undefined) task.status = input.status;
      if (tagsChanged) setTags(task, tagChange!.tags);
      task.revision++;
      task.updatedAt = at;
      const fieldsChanged = changed.filter((k) => k !== "tags" && k !== "status");
      if (fieldsChanged.length || previous !== task.status)
        this.store.event(board, {
          taskId: task.id,
          actor: "agent",
          agentId: caller.agentId,
          action: previous !== task.status ? "status_changed" : "edited",
          ...(previous !== task.status ? { from: previous, to: task.status } : {}),
          ...(fieldsChanged.length ? { note: `Changed ${fieldsChanged.join(", ")}` } : {}),
        });
      if (tagsChanged)
        this.store.event(board, { taskId: task.id, actor: "agent", agentId: caller.agentId, action: "tags_changed", note: tagChangeNote(tagChange!) });
      return { value: { card: cardView(board, project, task), changed }, changed: true };
    });
  }
}

/** The card as the card tools return it (AGENT-CARDS-SPEC §3). */
export function cardView(board: Board, project: Project, task: Task): CardView {
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    laneName: laneName(project, task.status),
    priority: task.priority,
    ...(task.type ? { type: task.type } : {}),
    tags: (task.tags || []).map((t) => ({ tag: t.tag, by: t.by })),
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    archived: !!task.archivedAt,
    workspaceId: task.workspaceId,
    links: linksOf(board, task.id)
      .filter((v) => v.other)
      .map(({ relation, other }) => ({ relation, taskId: other!.id, title: other!.title, status: other!.status })),
  };
}
