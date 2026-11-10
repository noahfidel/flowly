import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { ideaNewestFirst } from "../shared/ideas";
import { linkFor } from "../shared/links";
import { linkSchema, projectInput, tagLimits, type Idea, type Project, type ProjectInput } from "../shared/model";
import { normalizeTag, normalizeTags } from "../shared/tags";
import {
  agentCardLimits,
  createCardInputSchema,
  createCardResultSchema,
  dispatcherIdeaUpdateSchema,
  getCardInputSchema,
  getCardResultSchema,
  ideaListLimits,
  listCardsInputSchema,
  listCardsResultSchema,
  listIdeasInputSchema,
  listIdeasResultSchema,
  projectIdeaInputSchema,
  projectIdeaResultSchema,
  startCardInputSchema,
  startCardResultSchema,
  updateCardInputSchema,
  updateCardResultSchema,
  updateIdeaResultSchema,
  type IdeaView,
} from "../shared/tools";
import { rootAvailable, type AgentCards, type CardCaller } from "./agent-cards";
import { changeIdea } from "./agent-service";
import type { Dispatcher } from "./dispatcher";
import { addLink, linkNote } from "./links";
import type { ProjectIdeas } from "./project-ideas";
import { directory } from "./service";
import type { CardStarter } from "./start-card";
import type { BoardStore } from "./store";
import type { DispatcherIdentity } from "./tool-context";
import { ToolError, toolResult } from "./tool-error";

/** The dispatcher's cross-project tools and their caller check (DISPATCHER-SPEC §4–5). */

const projectId = z.string().min(1).max(200).describe("The project's id from flowly_list_projects.");
const withProject = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.extend({ projectId });

export const dispatcherInputs = {
  listCards: withProject(listCardsInputSchema),
  getCard: withProject(getCardInputSchema),
  createCard: withProject(createCardInputSchema).extend({
    ideaId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Create the card from this open idea of the project (from flowly_list_ideas); the idea is marked taken up."),
  }),
  updateCard: withProject(updateCardInputSchema),
  startCard: withProject(startCardInputSchema),
  proposeIdea: withProject(projectIdeaInputSchema),
  listIdeas: withProject(listIdeasInputSchema),
  updateIdea: withProject(dispatcherIdeaUpdateSchema),
  linkCards: z.strictObject({
    projectId,
    taskId: z.string().min(1).max(200).describe("Card id from flowly_list_cards."),
    relation: z
      .enum(["blocks", "follow_up"])
      .describe("blocks: taskId must land before otherTaskId. follow_up: otherTaskId continues taskId."),
    otherTaskId: z.string().min(1).max(200).describe("The other card's id, in the same project."),
  }),
  createProject: z.strictObject({
    path: z
      .string()
      // Not trimmed, as in projects.create: spaces can be part of a folder's name.
      .min(1)
      .max(4096)
      // Never relative: the daemon's working folder is not the user's (§5.2). `~` alone is the home folder.
      .refine((p) => isAbsolute(p) || p === "~" || p.startsWith("~/"), "Pass an absolute path (or one starting with ~/).")
      .describe("Absolute path of an existing folder (or one starting with ~/), usually a Git repository."),
    title: z.string().trim().min(1).max(120).optional().describe("The project's name. Default: the folder's name."),
    description: z.string().max(10000).optional().describe("Optional project description."),
  }),
};
/** Project creations per dispatcher session and hour, apart from its card bucket (ruling, Noah 2026-11-10; §5.2). */
export const dispatcherProjectsPerHour = 5;
/**
 * Claude modes in which a tool that is not preapproved runs, or is turned away, without asking the user: the
 * confirmation `flowly_create_project` relies on could not happen there (ruling, Noah 2026-11-10; §5.2).
 */
export const unpromptedModes: readonly string[] = ["bypassPermissions", "auto", "dontAsk"];
const hour = 3_600_000;
/** Whether `path` is `parent` or inside it (canonical paths). */
const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const createProjectResultSchema = z.object({ projectId: z.string(), title: z.string(), path: z.string() });
const listProjectsResultSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), title: z.string(), rootAvailable: z.boolean(), openCards: z.number().int() })),
});
const linkCardsResultSchema = z.object({ link: linkSchema, created: z.boolean() });

const finished = (status: string) => status === "done" || status === "cancelled";
/** The tool's input without `projectId`, for the card services' own strict schemas. */
const rest = <T extends { projectId: string }>({ projectId: _, ...input }: T) => input;

/** The idea as flowly_list_ideas and flowly_update_idea return it (§5.1). */
function ideaView(i: Idea): IdeaView {
  return {
    id: i.id,
    title: i.title,
    detail: i.detail,
    rationale: i.rationale,
    context: i.context,
    ...(i.type ? { type: i.type } : {}),
    ...(i.priority ? { priority: i.priority } : {}),
    tags: i.tags ?? [],
    status: i.status,
    ...(i.taskId ? { scope: i.scope ?? "new", taskId: i.taskId } : {}),
    ...(i.acceptedTaskId ? { acceptedTaskId: i.acceptedTaskId } : {}),
    createdAt: i.createdAt,
  };
}

/** `addTags`/`removeTags` on an idea's tags, as the card CLI's tags --add/--remove: a present tag added or a missing one removed does nothing. */
function editedTags(current: readonly string[], add: readonly string[], remove: readonly string[]) {
  const kept = current.filter((t) => !remove.includes(t));
  for (const t of add) if (!kept.includes(t)) kept.push(t);
  return kept;
}

export class DispatcherTools {
  /**
   * The `projects.create` RPC's own path (the board service's create plus its follow-ups), set by the plugin entry
   * (DISPATCHER-SPEC §5.2): the dispatcher's projects get the same checks, native registration and board write.
   */
  createProjectWith?: (input: ProjectInput, paseo: PaseoApi) => Promise<Project>;
  /** Folders a dispatcher-made project root may not be in, equal to or hold: the plugin data folder and the dispatcher's parent (§5.2). */
  reservedFolders: () => string[] = () => [this.store.directory, dirname(this.dispatcher.workspacePath)];
  clock = () => Date.now();
  /** The dispatcher's project creations in the last hour, per session (§5.2). */
  private projectSlots = new Map<string, number[]>();
  constructor(
    private readonly store: BoardStore,
    private readonly cards: AgentCards,
    private readonly starter: CardStarter,
    private readonly ideas: ProjectIdeas,
    private readonly ideasOn: () => Promise<boolean>,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** The stored dispatcher, live in its workspace; checked again on every call (§4). */
  async caller(identity: DispatcherIdentity): Promise<{ agentId: string }> {
    const record = await this.dispatcher.record();
    if (!record.agentId || record.agentId !== identity.agentId || record.workspaceId !== identity.workspaceId)
      throw new ToolError("DISPATCHER_REPLACED", "This dispatcher session was replaced by a newer one; its Flowly tools no longer work. Tell the user.");
    const found = await this.cards.api().agents.ref(identity.agentId).refresh();
    if (!found?.agent || found.agent.archivedAt || found.agent.workspaceId !== identity.workspaceId)
      throw new ToolError("SESSION_MISMATCH", "The dispatcher session is unavailable, archived, or in another workspace.");
    return { agentId: identity.agentId };
  }

  /** The dispatcher acting on one live project (§4). */
  async projectCaller(identity: DispatcherIdentity, projectId: string, write = false): Promise<CardCaller> {
    const { agentId } = await this.caller(identity);
    return this.cards.dispatcherCaller(projectId, agentId, write);
  }

  async listProjects(identity: DispatcherIdentity) {
    await this.caller(identity);
    const board = await this.store.read();
    const projects = await Promise.all(
      board.projects
        .filter((p) => !p.archivedAt)
        .map(async (p) => ({
          projectId: p.id,
          title: p.title,
          rootAvailable: await rootAvailable(p.primaryPath),
          openCards: board.tasks.filter((t) => t.projectId === p.id && !t.archivedAt && !finished(t.status)).length,
        })),
    );
    return { projects };
  }

  async proposeIdea(identity: DispatcherIdentity, raw: unknown) {
    const input = dispatcherInputs.proposeIdea.parse(raw);
    // A write: the agent-cards switch and a readable root apply, then the Ideas switch.
    const caller = await this.projectCaller(identity, input.projectId, true);
    if (!(await this.ideasOn()))
      throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Mention the idea to the user instead.");
    return { idea: await this.ideas.propose(caller.projectId, rest(input), { actor: "agent", agentId: caller.agentId }) };
  }

  /** One project's ideas, card and project ideas together, newest first (§5.1). A read. */
  async listIdeas(identity: DispatcherIdentity, raw: unknown) {
    const input = dispatcherInputs.listIdeas.parse(raw);
    const caller = await this.projectCaller(identity, input.projectId);
    let tag: string | undefined;
    try {
      tag = input.tag === undefined ? undefined : normalizeTag(input.tag);
    } catch (e) {
      throw new ToolError("TAG_INVALID", e instanceof Error ? e.message : String(e));
    }
    const needle = input.query.trim().toLowerCase();
    const found = (await this.store.read()).ideas
      .filter(
        (i) =>
          i.projectId === caller.projectId &&
          (input.status === "all" || i.status === input.status) &&
          (!tag || (i.tags ?? []).includes(tag)) &&
          (!input.type || i.type === input.type) &&
          (!needle || i.title.toLowerCase().includes(needle) || i.detail.toLowerCase().includes(needle)),
      )
      .sort(ideaNewestFirst);
    return { ideas: found.slice(0, input.limit).map(ideaView), truncated: found.length > input.limit };
  }

  /**
   * Edits or dismisses any idea of the project, card ideas included, through the card sessions' edit rules (§5.1).
   * A card idea's changes are events on its card; a project idea writes none.
   */
  async updateIdea(identity: DispatcherIdentity, raw: unknown) {
    const { projectId, ideaId, addTags, removeTags, ...input } = dispatcherInputs.updateIdea.parse(raw);
    const caller = await this.projectCaller(identity, projectId, true);
    if (!(await this.ideasOn()))
      throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Tell the user what you would have changed instead.");
    if (input.tags !== undefined && (addTags !== undefined || removeTags !== undefined))
      throw new ToolError("INVALID_INPUT", "Pass either tags (the full set) or addTags/removeTags, not both.");
    let full: string[] | undefined, add: string[] | undefined, remove: string[] | undefined;
    try {
      if (input.tags !== undefined) full = normalizeTags(input.tags);
      if (addTags !== undefined || removeTags !== undefined) {
        add = normalizeTags(addTags ?? []);
        remove = normalizeTags(removeTags ?? []);
        if (add.some((t) => remove!.includes(t))) throw new Error("A tag can't be both added and removed.");
        // Empty lists are not a tag change; with nothing else given there is nothing to do.
        if (!add.length && !remove.length) add = remove = undefined;
      }
    } catch (e) {
      throw new ToolError("TAG_INVALID", e instanceof Error ? e.message : String(e));
    }
    return this.store.transaction((board) => {
      const idea = board.ideas.find((i) => i.id === ideaId && i.projectId === caller.projectId);
      if (!idea) throw new ToolError("IDEA_NOT_FOUND", `No idea ${ideaId} in this project. Use an id from flowly_list_ideas.`);
      const tags = full ?? (add && remove ? editedTags(idea.tags ?? [], add, remove) : undefined);
      if (tags && tags.length > tagLimits.perTask) throw new ToolError("TAG_INVALID", `An idea can have at most ${tagLimits.perTask} tags.`);
      let changed = false;
      changeIdea(board, idea, "idea_update", { ...input, ...(tags ? { tags } : {}) }, tags, new Date().toISOString(), (e) => {
        changed = true;
        return idea.taskId ? this.store.event(board, { taskId: idea.taskId, actor: "agent", agentId: caller.agentId, ...e }) : { id: "", at: "" };
      });
      return { value: { idea: ideaView(idea), changed }, changed };
    });
  }

  async linkCards(identity: DispatcherIdentity, raw: unknown) {
    const input = dispatcherInputs.linkCards.parse(raw);
    const caller = await this.projectCaller(identity, input.projectId, true);
    return this.store.transaction((board) => {
      const project = board.projects.find((p) => p.id === caller.projectId);
      if (!project) throw new ToolError("NOT_FOUND", "The Flowly project was removed.");
      if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The Flowly project is archived.");
      for (const id of [input.taskId, input.otherTaskId])
        if (!board.tasks.some((t) => t.id === id && t.projectId === project.id))
          throw new ToolError("CARD_NOT_FOUND", `No card ${id} in this project. Use ids from flowly_list_cards.`);
      let result;
      try {
        result = addLink(this.store, board, { ...linkFor(input.relation, input.taskId, input.otherTaskId), createdBy: "system" }, { events: false });
      } catch (e) {
        throw new ToolError("LINK_REFUSED", e instanceof Error ? e.message : String(e));
      }
      if (result.created)
        for (const id of [result.link.from, result.link.to])
          this.store.event(board, { taskId: id, actor: "agent", agentId: caller.agentId, action: "linked", note: linkNote(board, result.link, id) });
      return { value: { link: result.link, created: result.created }, changed: result.created };
    });
  }

  /**
   * A single-directory project from an existing folder, as the project form's Create project (DISPATCHER-SPEC §5.2).
   * A write: the agent-cards switch applies. Never preapproved, so the user confirms each call (ruling, Noah 2026-11-10).
   */
  async createProject(identity: DispatcherIdentity, raw: unknown) {
    const input = dispatcherInputs.createProject.parse(raw);
    const { agentId } = await this.caller(identity);
    await this.cards.enabled();
    const create = this.createProjectWith;
    if (!create) throw new ToolError("PASEO_UNAVAILABLE", "Flowly is still starting; try again in a moment.", true);
    const paseo = this.cards.api();
    // The user's confirmation is the provider's permission prompt: refuse in a mode that never shows it (ruling A).
    const mode = (await paseo.agents.ref(agentId).refresh())?.agent?.currentModeId ?? null;
    if (mode && unpromptedModes.includes(mode))
      throw new ToolError(
        "CONFIRMATION_UNAVAILABLE",
        `The dispatcher runs in the "${mode}" permission mode, where the user is not asked to confirm a project. Tell the user to switch the dispatcher to a mode that asks (for example Default) and try again.`,
      );
    const release = this.reserveProject(agentId);
    try {
      const path = input.path === "~" ? homedir() : input.path;
      let project: Project;
      try {
        const root = await directory(path);
        await this.checkReserved(root);
        // The folder's name is the default title; a name with nothing but spaces (or "/") falls back to "Project".
        const title = input.title ?? (basename(root).trim().slice(0, 120).trim() || "Project");
        project = await create(projectInput.parse({ title, description: input.description ?? "", primaryPath: root }), paseo);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        const message = e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : e instanceof Error ? e.message : String(e);
        throw new ToolError("PROJECT_REFUSED", message);
      }
      return { projectId: project.id, title: project.title, path: project.primaryPath };
    } catch (e) {
      // A refused creation gives its slot back: only projects made count.
      release();
      throw e;
    }
  }

  /** A project root inside, equal to or holding the plugin data folder or the dispatcher's parent is refused (ruling B). */
  private async checkReserved(root: string) {
    for (const folder of this.reservedFolders()) {
      const canonical = await realpath(folder).catch(() => null);
      if (canonical && (within(root, canonical) || within(canonical, root)))
        throw new ToolError(
          "PROJECT_REFUSED",
          "This folder is, holds or is inside Flowly's own data or the dispatcher's folder; the dispatcher can't make it a project. The user can add it from Create project if they mean it.",
        );
    }
  }

  /** Takes one of the dispatcher session's hourly project slots, or PROJECT_LIMIT (§5.2). */
  private reserveProject(agentId: string) {
    const now = this.clock();
    const recent = (this.projectSlots.get(agentId) ?? []).filter((at) => now - at < hour);
    if (recent.length >= dispatcherProjectsPerHour)
      throw new ToolError(
        "PROJECT_LIMIT",
        `This dispatcher already created ${dispatcherProjectsPerHour} projects in the last hour. Stop and ask the user before creating more.`,
      );
    this.projectSlots.set(agentId, [...recent, now]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const list = [...(this.projectSlots.get(agentId) ?? [])];
      const at = list.lastIndexOf(now);
      if (at >= 0) list.splice(at, 1);
      this.projectSlots.set(agentId, list);
    };
  }

  /** Registers the dispatcher tools on a dispatcher credential's MCP server; nothing else is registered there. */
  register(mcp: McpServer, identity: DispatcherIdentity) {
    const inProject = <T extends { projectId: string }>(
      schema: z.ZodType<T>,
      raw: unknown,
      operation: (caller: CardCaller, input: Omit<T, "projectId">) => Promise<object>,
      write = false,
    ) =>
      toolResult(async () => {
        const input = schema.parse(raw);
        return operation(await this.projectCaller(identity, input.projectId, write), rest(input));
      });
    const read = { readOnlyHint: true, openWorldHint: false } as const;
    mcp.registerTool(
      "flowly_list_projects",
      {
        description: "List the live Flowly projects with their projectId, whether their folder is available, and how many open cards they have. Read-only.",
        inputSchema: z.strictObject({}),
        outputSchema: listProjectsResultSchema,
        annotations: read,
      },
      () => toolResult(() => this.listProjects(identity)),
    );
    mcp.registerTool(
      "flowly_list_cards",
      {
        description: "List one project's cards with lane, priority, type, tags and revision (descriptions cut to 300 characters). Filter by words (query) and lanes (status). Read-only.",
        inputSchema: dispatcherInputs.listCards,
        outputSchema: listCardsResultSchema,
        annotations: read,
      },
      (raw) => inProject(dispatcherInputs.listCards, raw, (c, input) => this.cards.list(c, input)),
    );
    mcp.registerTool(
      "flowly_get_card",
      {
        description: "Read one card of a project in full: title, description, lane, priority, type, tags, links and revision. Read-only.",
        inputSchema: dispatcherInputs.getCard,
        outputSchema: getCardResultSchema,
        annotations: read,
      },
      (raw) => inProject(dispatcherInputs.getCard, raw, (c, input) => this.cards.get(c, input)),
    );
    mcp.registerTool(
      "flowly_create_card",
      {
        description:
          `Create a card in a project: one deliverable, one branch or PR. Use workspace="worktree" for repo work, then start it with flowly_start_card. Write the description for an agent that cannot see this conversation (goal, context, files, acceptance). Lands in Backlog (default) or Todo. Pass a unique idempotencyKey; retrying with the same key returns the same card. Pass ideaId to make it from an open idea of the project, which is then marked taken up (IDEA_NOT_FOUND, IDEA_CLOSED: not open). At most ${agentCardLimits.dispatcherPerHour} cards or starts per hour (CARD_LIMIT). AGENT_CARDS_DISABLED: the user turned this off.`,
        inputSchema: dispatcherInputs.createCard,
        outputSchema: createCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (raw) =>
        inProject(
          dispatcherInputs.createCard,
          raw,
          (c, { ideaId, ...input }) => this.cards.create(c, input, ideaId ? { ideaId, ideasOn: this.ideasOn } : undefined),
          true,
        ),
    );
    mcp.registerTool(
      "flowly_update_card",
      {
        description:
          "Edit a live card of a project: title, description (replaces it), priority, type, tags or its lane between Backlog and Todo. Pass its revision from flowly_get_card; on REVISION_CONFLICT read it again. Work stages, Done and Cancelled are not set here.",
        inputSchema: dispatcherInputs.updateCard,
        outputSchema: updateCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      (raw) => inProject(dispatcherInputs.updateCard, raw, (c, input) => this.cards.update(c, input), true),
    );
    mcp.registerTool(
      "flowly_start_card",
      {
        description:
          "Start a session on a card of a project, in the card's own worktree (a session-less directory card Flowly made moves to a new worktree first). The session uses the project's New task model and starts with prompt (default: the card's title and description). CARD_HAS_SESSION: the card already has a session. NEEDS_WORKTREE: ask the user to switch the card to a worktree. Pass a unique idempotencyKey; retrying returns the same session.",
        inputSchema: dispatcherInputs.startCard,
        outputSchema: startCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (raw) => inProject(dispatcherInputs.startCard, raw, (c, input) => this.starter.start(c, input, this.cards.api()), true),
    );
    mcp.registerTool(
      "flowly_propose_idea",
      {
        description:
          "Park an ask as a project-level idea instead of a card: the user sees it on the project's Ideas page and may turn it into a card. Put the context a later card would need. An open idea with the same title is refused (DUPLICATE_IDEA). IDEAS_DISABLED: the user turned Ideas off.",
        inputSchema: dispatcherInputs.proposeIdea,
        outputSchema: projectIdeaResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      (raw) => toolResult(() => this.proposeIdea(identity, raw)),
    );
    mcp.registerTool(
      "flowly_link_cards",
      {
        description:
          "Tie two cards of the same project: relation=blocks when taskId must land before otherTaskId, relation=follow_up when otherTaskId continues taskId. An identical link is returned with created=false. LINK_REFUSED: the link rules refused it (cycle, already linked, archived card, link limit).",
        inputSchema: dispatcherInputs.linkCards,
        outputSchema: linkCardsResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (raw) => toolResult(() => this.linkCards(identity, raw)),
    );
    mcp.registerTool(
      "flowly_list_ideas",
      {
        description: `List one project's ideas, those proposed on its cards and its project ideas, newest first, with their full text, type, priority, tags, status and source card (taskId). Default only open ones; status accepted, dismissed or all for the others. Filter by tag, type, and query (text in the title or detail, any case). At most ${ideaListLimits.max} per call (limit, default ${ideaListLimits.default}); truncated says more matched. Read-only.`,
        inputSchema: dispatcherInputs.listIdeas,
        outputSchema: listIdeasResultSchema,
        annotations: read,
      },
      (raw) => toolResult(() => this.listIdeas(identity, raw)),
    );
    mcp.registerTool(
      "flowly_update_idea",
      {
        description:
          "Edit an open idea of a project (card ideas included): title, detail, rationale, context, type, priority, and tags (tags replaces the set; or addTags/removeTags, not both), or dismiss it with status=dismissed (the user can restore it). Pass only what changes. IDEA_CLOSED: it was accepted, or it is dismissed and cannot be edited. IDEAS_DISABLED: the user turned Ideas off.",
        inputSchema: dispatcherInputs.updateIdea,
        outputSchema: updateIdeaResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      (raw) => toolResult(() => this.updateIdea(identity, raw)),
    );
    // Not preapproved (dispatcherConfirmedToolNames): every call shows a permission prompt the user answers.
    mcp.registerTool(
      "flowly_create_project",
      {
        description:
          `Create a Flowly project from an existing folder on this computer (usually a Git repository), as the user's Create project does: Flowly registers the folder with Paseo and adds the project to the board. Use only when the user asks for a project. Each call asks the user to confirm it. Returns the new projectId. PROJECT_REFUSED: the folder is missing or not a folder, it is already a Flowly project, it is or holds Flowly's own folders, or Paseo refused it (the message says which). CONFIRMATION_UNAVAILABLE: your permission mode would not ask the user; tell them to switch it. PROJECT_LIMIT: at most ${dispatcherProjectsPerHour} per hour. AGENT_CARDS_DISABLED: the user turned this off.`,
        inputSchema: dispatcherInputs.createProject,
        outputSchema: createProjectResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      (raw) => toolResult(() => this.createProject(identity, raw)),
    );
  }
}
