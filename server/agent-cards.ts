import { access, constants, stat } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { laneEnabled, laneName, projectLanes } from "../shared/lanes";
import { linksOf } from "../shared/links";
import { changeTags, normalizeTags, tagChangeNote } from "../shared/tags";
import { tagLimits, type Board, type Project, type Task } from "../shared/model";
import { isSummarizer } from "../shared/summary";
import { absoluteTarget } from "../shared/artifacts";
import { planApproved, planOf } from "../shared/plans";
import { linearIssueOf, linearIssuesOf } from "../shared/linear-ticket";
import {
  agentCardLimits,
  clearLinearInputSchema,
  clearPlanInputSchema,
  createCardInputSchema,
  setLinearInputSchema,
  setPlanInputSchema,
  getCardInputSchema,
  listCardsInputSchema,
  updateCardInputSchema,
  type BoardIdentity,
  type CardLinear,
  type CardView,
} from "../shared/tools";
import { ArtifactService, dropArtifact, normalizeTarget, putArtifact, type ArtifactRoots } from "./artifacts";
import type { ConnectorService } from "./connectors/service";
import { ExternalError } from "./connectors/http";
import { logFailure } from "./error-report";
import { cardPlanView, clearPlan, planMissing, planTarget, setPlan } from "./plans";
import { BoardService } from "./service";
import { BoardStore, columnOrder, setTags } from "./store";
import { digest } from "./tool-context";
import { checkGroup, ToolError } from "./tool-error";

/**
 * Who calls a card tool: a card session (its card is `taskId`), a session outside cards (AGENT-CARDS-SPEC §2), the
 * dispatcher (`dispatcher`, its own hourly limit, DISPATCHER-SPEC §5), or the user's own Start again (`human`, §9.4).
 */
/** `groupId`: a dispatcher's board group, checked again inside each write (`checkGroup`). */
export type CardCaller = { agentId: string; projectId: string; taskId?: string; human?: true; dispatcher?: true; groupId?: string };

const hour = 3600000;
/** The New card path's refusal of an idea that is no longer open (`openIdea` in service.ts). */
const ideaGone = "This idea is no longer open.";

/**
 * flowly_list_cards, flowly_get_card, flowly_create_card and flowly_update_card (AGENT-CARDS-SPEC §3):
 * any card of the caller's project, created through the New card path and edited under its revision.
 */
export class AgentCards {
  private paseo?: PaseoApi;
  /** Per session, when it created cards in the last hour; a plugin reload resets it (§3.3). */
  private created = new Map<string, number[]>();
  /** The same for the dispatcher, apart from the card agents' (DISPATCHER-SPEC §5). */
  private dispatched = new Map<string, number[]>();
  /** The Agents create and edit cards setting (§2.3); set by the plugin entry. */
  on: () => Promise<boolean> = async () => true;
  /** The extra artifact folders from Settings, read at each use (CARD-PLAN-SPEC §3.1); set by the plugin entry. */
  extraArtifactFolders: () => Promise<readonly string[]> = async () => [];
  /** Linear issues (LINEAR-LINK-SPEC): read to check a link, and the last known state; set by the plugin entry. */
  connectors?: Pick<ConnectorService, "recognizeLinear" | "cached">;
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
   * Takes one of this session's `agentCardLimits.perHour` hourly slots, or CARD_LIMIT; card creations
   * and flowly_start_card sessions count together (START-CARD-SPEC §3). The slot is taken before any
   * await, so concurrent calls cannot pass the limit together; the returned function gives it back
   * when the creation or start failed. The dispatcher (`dispatcher`) has its own bucket and limit,
   * `agentCardLimits.dispatcherPerHour`, apart from the card agents'.
   */
  reserve(agentId: string, dispatcher = false) {
    const slots = dispatcher ? this.dispatched : this.created,
      limit = dispatcher ? agentCardLimits.dispatcherPerHour : agentCardLimits.perHour;
    const now = this.clock(),
      recent = (slots.get(agentId) || []).filter((at) => now - at < hour);
    if (recent.length >= limit)
      throw new ToolError(
        "CARD_LIMIT",
        `This ${dispatcher ? "dispatcher" : "session"} already created or started ${limit} cards in the last hour. Stop and ask the user before creating more.`,
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
   * The dispatcher acting on `projectId` (DISPATCHER-SPEC §4): the project must exist and be live. A write also
   * needs the Agents create and edit cards setting on and a readable root; a missing root still allows reads.
   * The dispatcher session itself is checked by the caller first.
   */
  async dispatcherCaller(projectId: string, agentId: string, write = false): Promise<CardCaller> {
    if (write) await this.enabled();
    const project = (await this.store.read()).projects.find((p) => p.id === projectId);
    if (!project) throw new ToolError("NOT_FOUND", "No Flowly project with that projectId. Use one from flowly_list_projects.");
    if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The Flowly project is archived. Tell the user instead of changing it.");
    if (write && !(await rootAvailable(project.primaryPath)))
      throw new ToolError("ROOT_UNAVAILABLE", "The project's folder is missing or unreadable. Tell the user instead of changing this project.");
    return { agentId, projectId: project.id, dispatcher: true };
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
    checkGroup(project, caller.groupId);
    return project;
  }
  /** The card's Linear issue with its last known state, or null (LINEAR-LINK-SPEC §4). */
  private async linearView(board: Board, taskId: string): Promise<CardLinear | null> {
    const artifact = linearIssueOf(board.artifacts, taskId);
    if (!artifact?.external) return null;
    const summary = await this.connectors?.cached(artifact.external).catch(() => undefined);
    return { key: artifact.external.key, url: artifact.target, title: summary?.summary || artifact.title, state: summary?.status || "" };
  }
  async list(caller: CardCaller, raw: unknown) {
    const input = listCardsInputSchema.parse(raw);
    const board = await this.store.read(),
      project = this.project(board, caller);
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const lanes = projectLanes(project).map((l) => l.status);
    // The Linear key is searchable, like the tags (LINEAR-LINK-SPEC §4).
    const issues = new Map<string, Board["artifacts"][number]>();
    for (const a of board.artifacts)
      if (a.projectId === project.id && !issues.has(a.taskId) && linearIssueOf([a], a.taskId)) issues.set(a.taskId, a);
    const found = board.tasks
      .filter(
        (t) =>
          t.projectId === project.id &&
          (input.includeArchived || !t.archivedAt) &&
          (!input.status || input.status.includes(t.status)) &&
          words.every((w) => [t.title, t.description, ...(t.tags || []).map((x) => x.tag), issues.get(t.id)?.external?.key ?? ""].join("\n").toLowerCase().includes(w)),
      )
      .sort((a, b) => lanes.indexOf(a.status) - lanes.indexOf(b.status) || columnOrder(a, b));
    return {
      project: { id: project.id, title: project.title },
      lanes: projectLanes(project)
        .filter((l) => l.enabled)
        .map((l) => ({ status: l.status, name: laneName(project, l.status) })),
      cards: await Promise.all(found.slice(0, input.limit).map(async (t) => {
        const cut = t.description.length > agentCardLimits.preview;
        const linear = await this.linearView(board, t.id);
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
          ...(t.prRef ? { prRef: t.prRef } : {}),
          ...(linear ? { linear } : {}),
          description: cut ? t.description.slice(0, agentCardLimits.preview) : t.description,
          ...(cut ? { descriptionTruncated: true } : {}),
        };
      })),
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
    return { card: cardView(board, project, task, await this.linearView(board, task.id)), editable: !reason, reason };
  }
  /**
   * `fromIdea`: the dispatcher creating the card from an idea of the project (DISPATCHER-SPEC §5.1). A replay
   * returns the card first; otherwise the idea is checked before a slot is taken or anything is made, and the
   * New card path marks it accepted.
   */
  async create(caller: CardCaller, raw: unknown, fromIdea?: { ideaId: string; ideasOn: () => Promise<boolean> }) {
    const input = createCardInputSchema.parse(raw);
    await this.enabled();
    const board = await this.store.read(),
      project = this.project(board, caller);
    if (project.archivedAt) throw new ToolError("ARCHIVED", "The Flowly project is archived.");
    const operationId = `agent-card:${digest(JSON.stringify([caller.taskId ?? caller.projectId, caller.agentId, input.idempotencyKey]))}`;
    const previous = board.tasks.find((t) => t.operationId === operationId);
    if (previous) {
      // The same key from another idea, or with or without one, is another request (DISPATCHER-SPEC §5.1).
      if (previous.projectId !== project.id || previous.title !== input.title || previous.origin?.ideaId !== fromIdea?.ideaId)
        throw new ToolError("REQUEST_REUSED", "This idempotencyKey already created a different card. Use a new key for a new card.");
      return { card: cardView(board, project, previous, await this.linearView(board, previous.id)), replayed: true };
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
    if (fromIdea) {
      if (!(await fromIdea.ideasOn()))
        throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Create the card without ideaId, or tell the user.");
      const idea = board.ideas.find((i) => i.id === fromIdea.ideaId && i.projectId === project.id);
      if (!idea) throw new ToolError("IDEA_NOT_FOUND", `No idea ${fromIdea.ideaId} in this project. Use an id from flowly_list_ideas.`);
      if (idea.status !== "open")
        throw new ToolError("IDEA_CLOSED", `This idea is ${idea.status}, not open; only an open idea becomes a card.`);
    }
    // The plan's target is checked before anything is made (CARD-PLAN-SPEC §5.2); a file is kept absolute until
    // the card's workspace exists, then stored relative to it when inside it.
    const plan = input.plan ? { ...input.plan, ...(await this.projectPlanTarget(project, input.plan.target)) } : undefined;
    // An issue Linear can't show is refused before anything is made, like the plan (LINEAR-LINK-SPEC §2).
    const linear = input.linear ? await this.readLinear(input.linear) : undefined;
    const release = this.reserve(caller.agentId, caller.dispatcher);
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
          ...(fromIdea ? { ideaId: fromIdea.ideaId } : {}),
        },
        this.api(),
        { agentId: caller.agentId, ...(caller.groupId !== undefined ? { groupId: caller.groupId } : {}) },
      );
    } catch (e) {
      release();
      if (e instanceof ToolError) throw e;
      const text = e instanceof Error ? e.message : String(e);
      // Taken up or dismissed after the check above, e.g. by a create from the same idea at the same time.
      if (fromIdea && text.includes(ideaGone))
        throw new ToolError("IDEA_CLOSED", "This idea is no longer open; another card took it up or it was dismissed meanwhile.");
      throw new ToolError("CARD_CREATE_FAILED", text);
    }
    if (plan) await this.planOnCreate(caller, task.id, plan);
    if (linear) await this.linearOnCreate(caller, task.id, linear);
    const after = await this.store.read();
    return { card: cardView(after, this.project(after, caller), after.tasks.find((t) => t.id === task.id) ?? task, await this.linearView(after, task.id)), replayed: false };
  }
  /** A new card's plan target, checked against the project's directories and the extra folders (PLAN_INVALID). */
  private async projectPlanTarget(project: Project, raw: string) {
    const where: ArtifactRoots = {
      workspace: project.primaryPath,
      roots: [...new Set([project.primaryPath, ...project.repos, ...(project.links || []).map((l) => l.target)])],
      resolved: await this.artifacts().extraRoots(),
    };
    try {
      const found = await normalizeTarget(raw, where);
      return found.kind === "file" ? { kind: found.kind, target: absoluteTarget(found.target, where.workspace) } : found;
    } catch (e) {
      throw new ToolError("PLAN_INVALID", e instanceof Error ? e.message : String(e));
    }
  }
  /** Sets the plan of a card just created; the card stays when it fails (logged). */
  private async planOnCreate(caller: CardCaller, taskId: string, plan: { kind: "file" | "url"; target: string; title?: string; approved: boolean }) {
    try {
      const where = await this.artifacts().where(taskId, this.api());
      const { kind, target } = plan.kind === "url" ? plan : planTarget(await normalizeTarget(plan.target, where), where);
      await this.store.transaction((board) => {
        const result = setPlan(this.store, board, { taskId, kind, target, workspace: where.workspace, title: plan.title, approved: plan.approved, by: { kind: "agent", agentId: caller.agentId }, source: "tool" });
        return { value: undefined, changed: result.changed };
      });
    } catch (e) {
      logFailure("Flowly new card plan not set:", e, `card ${taskId}`);
    }
  }
  /** Links the checked Linear issue to a card just created; the card stays when it fails (logged). */
  private async linearOnCreate(caller: CardCaller, taskId: string, found: LinearFound) {
    try {
      await this.store.transaction((board) => {
        const result = putArtifact(this.store, board, linearArtifact(taskId, found, caller.agentId));
        return { value: undefined, changed: result.changed };
      });
    } catch (e) {
      logFailure("Flowly new card Linear issue not linked:", e, `card ${taskId}`);
    }
  }
  /** An issue or link read through the Linear connection (LINEAR_INVALID; LINEAR_UNAVAILABLE when Linear can't be reached). */
  private async readLinear(raw: string): Promise<LinearFound> {
    if (!this.connectors) throw new ToolError("LINEAR_UNAVAILABLE", "Linear is not available in this Flowly process.", true);
    try {
      return await this.connectors.recognizeLinear(raw);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (e instanceof ExternalError && e.code === "EXTERNAL_UNAVAILABLE") throw new ToolError("LINEAR_UNAVAILABLE", text, true);
      throw new ToolError("LINEAR_INVALID", text);
    }
  }
  /**
   * flowly_set_linear (LINEAR-LINK-SPEC §3): the card's Linear issue, saved as its Linear input. An issue this agent
   * linked before is replaced; one the user linked stays and refuses the change. It never renames a branch.
   */
  async setLinear(caller: CardCaller, raw: unknown) {
    const input = setLinearInputSchema.parse(raw);
    await this.enabled();
    this.planCard(await this.store.read(), caller, input.taskId);
    const found = await this.readLinear(input.issue);
    await this.store.transaction((board) => {
      const task = this.planCard(board, caller, input.taskId);
      const others = linearIssuesOf(board.artifacts, task.id).filter((a) => !sameIssue(a.external, found.external));
      const theirs = others.find((a) => a.createdBy === "human");
      if (theirs)
        throw new ToolError("LINEAR_ALREADY_SET", `The user linked ${theirs.external?.key} to this card; agents don't replace it. Tell the user instead.`);
      for (const a of others) dropArtifact(this.store, board, a.id, { createdBy: "agent", agentId: caller.agentId });
      let changed;
      try {
        changed = putArtifact(this.store, board, linearArtifact(task.id, found, caller.agentId));
      } catch (e) {
        throw new ToolError("LINEAR_REFUSED", e instanceof Error ? e.message : String(e));
      }
      // The user's entry for this issue may sit as an output, which an agent doesn't change.
      if (!linearIssueOf(board.artifacts, task.id))
        throw new ToolError("LINEAR_REFUSED", changed.notice ?? "The issue could not be linked as an input.");
      return { value: undefined, changed: others.length > 0 || changed.changed };
    });
    return { linear: (await this.linearView(await this.store.read(), input.taskId))! };
  }
  /** flowly_clear_linear (LINEAR-LINK-SPEC §3): removes the Linear links agents added; the user's stays. */
  async clearLinear(caller: CardCaller, raw: unknown) {
    const input = clearLinearInputSchema.parse(raw);
    await this.enabled();
    return this.store.transaction((board) => {
      const task = this.planCard(board, caller, input.taskId);
      const issues = linearIssuesOf(board.artifacts, task.id);
      const mine = issues.filter((a) => a.createdBy === "agent");
      for (const a of mine) dropArtifact(this.store, board, a.id, { createdBy: "agent", agentId: caller.agentId });
      const kept = issues.find((a) => a.createdBy === "human");
      return {
        value: { cleared: mine.length > 0, ...(kept ? { notice: `The user linked ${kept.external?.key} to this card; only they can remove it.` } : {}) },
        changed: mine.length > 0,
      };
    });
  }
  private artifacts() {
    return new ArtifactService(this.store, undefined, () => this.extraArtifactFolders());
  }
  /** A live card of the caller's project for the plan tools: CARD_NOT_FOUND, ARCHIVED. */
  private planCard(board: Board, caller: CardCaller, taskId: string) {
    const project = this.project(board, caller),
      task = board.tasks.find((t) => t.id === taskId && t.projectId === project.id);
    if (!task) throw new ToolError("CARD_NOT_FOUND", "No card with that id in this project. Use an id from flowly_list_cards.");
    if (task.archivedAt || project.archivedAt) throw new ToolError("ARCHIVED", "The card or its project is archived.");
    return task;
  }
  /** flowly_set_plan (CARD-PLAN-SPEC §5.2): the card's plan, set by this agent. */
  async setPlan(caller: CardCaller, raw: unknown) {
    const input = setPlanInputSchema.parse(raw);
    await this.enabled();
    const board = await this.store.read();
    const task = this.planCard(board, caller, input.taskId);
    let where: ArtifactRoots, found: Awaited<ReturnType<typeof normalizeTarget>>;
    try {
      where = await this.artifacts().where(task.id, this.api(), board);
      found = planTarget(await normalizeTarget(input.target, where), where);
    } catch (e) {
      throw new ToolError("PLAN_INVALID", e instanceof Error ? e.message : String(e));
    }
    const artifact = await this.store.transaction((board) => {
      this.planCard(board, caller, input.taskId);
      let result;
      try {
        result = setPlan(this.store, board, {
          taskId: input.taskId,
          kind: found.kind,
          target: found.target,
          workspace: where.workspace,
          title: input.title,
          approved: input.approved,
          by: { kind: "agent", agentId: caller.agentId },
          source: "tool",
        });
      } catch (e) {
        throw new ToolError("PLAN_INVALID", e instanceof Error ? e.message : String(e));
      }
      return { value: { ...result.artifact }, changed: result.changed };
    });
    return { plan: cardPlanView(artifact, where.workspace, await planMissing(artifact, where)) };
  }
  /** flowly_clear_plan (CARD-PLAN-SPEC §5.2): empties the slot; the file stays an ordinary input. */
  async clearPlan(caller: CardCaller, raw: unknown) {
    const input = clearPlanInputSchema.parse(raw);
    await this.enabled();
    return this.store.transaction((board) => {
      this.planCard(board, caller, input.taskId);
      const result = clearPlan(this.store, board, input.taskId, { kind: "agent", agentId: caller.agentId });
      return { value: { cleared: result.changed }, changed: result.changed };
    });
  }
  async update(caller: CardCaller, raw: unknown) {
    const input = updateCardInputSchema.parse(raw);
    await this.enabled();
    const linear = await this.linearView(await this.store.read(), input.taskId);
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
      if (!changed.length) return { value: { card: cardView(board, project, task, linear), changed }, changed: false };
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
      return { value: { card: cardView(board, project, task, linear), changed }, changed: true };
    });
  }
}

/** Whether a project root is a readable directory. */
export async function rootAvailable(path: string) {
  try {
    if (!(await stat(path)).isDirectory()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The card as the card tools return it (AGENT-CARDS-SPEC §3). */
export function cardView(board: Board, project: Project, task: Task, linear: CardLinear | null = null): CardView {
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
    plan: (() => {
      const plan = planOf(board.artifacts, task.id);
      return plan ? { title: plan.title, approved: planApproved(plan) } : null;
    })(),
    linear,
  };
}

type LinearFound = Awaited<ReturnType<ConnectorService["recognizeLinear"]>>;
const sameIssue = (a: { connectionId: string; key: string } | undefined, b: { connectionId: string; key: string }) => !!a && a.connectionId === b.connectionId && a.key === b.key;
/** The input artifact of a Linear issue an agent links: the same record a card session's flowly_add_artifact makes. */
const linearArtifact = (taskId: string, found: LinearFound, agentId: string) => ({
  taskId,
  role: "input" as const,
  kind: "url" as const,
  target: found.url,
  title: found.title,
  createdBy: "agent" as const,
  agentId,
  external: found.external,
});
