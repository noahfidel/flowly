import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { linkFor } from "../shared/links";
import { linkSchema } from "../shared/model";
import {
  createCardInputSchema,
  createCardResultSchema,
  getCardInputSchema,
  getCardResultSchema,
  listCardsInputSchema,
  listCardsResultSchema,
  projectIdeaInputSchema,
  projectIdeaResultSchema,
  startCardInputSchema,
  startCardResultSchema,
  updateCardInputSchema,
  updateCardResultSchema,
} from "../shared/tools";
import { assertNotLegacy, rootAvailable, type AgentCards, type CardCaller } from "./agent-cards";
import type { Dispatcher } from "./dispatcher";
import { addLink, linkNote } from "./links";
import type { ProjectIdeas } from "./project-ideas";
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
  createCard: withProject(createCardInputSchema),
  updateCard: withProject(updateCardInputSchema),
  startCard: withProject(startCardInputSchema),
  proposeIdea: withProject(projectIdeaInputSchema),
  linkCards: z.strictObject({
    projectId,
    taskId: z.string().min(1).max(200).describe("Card id from flowly_list_cards."),
    relation: z
      .enum(["blocks", "follow_up"])
      .describe("blocks: taskId must land before otherTaskId. follow_up: otherTaskId continues taskId."),
    otherTaskId: z.string().min(1).max(200).describe("The other card's id, in the same project."),
  }),
};
const listProjectsResultSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), title: z.string(), rootAvailable: z.boolean(), openCards: z.number().int() })),
});
const linkCardsResultSchema = z.object({ link: linkSchema, created: z.boolean() });

const finished = (status: string) => status === "done" || status === "cancelled";
/** The tool's input without `projectId`, for the card services' own strict schemas. */
const rest = <T extends { projectId: string }>({ projectId: _, ...input }: T) => input;

export class DispatcherTools {
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
    const caller = await this.projectCaller(identity, input.projectId);
    if (!(await this.ideasOn()))
      throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Mention the idea to the user instead.");
    return { idea: await this.ideas.propose(caller.projectId, rest(input), { actor: "agent", agentId: caller.agentId }) };
  }

  async linkCards(identity: DispatcherIdentity, raw: unknown) {
    const input = dispatcherInputs.linkCards.parse(raw);
    const caller = await this.projectCaller(identity, input.projectId, true);
    return this.store.transaction((board) => {
      const project = board.projects.find((p) => p.id === caller.projectId);
      if (!project) throw new ToolError("NOT_FOUND", "The Flowly project was removed.");
      if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The Flowly project is archived.");
      assertNotLegacy(project);
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
          'Create a card in a project: one deliverable, one branch or PR. Use workspace="worktree" for repo work, then start it with flowly_start_card. Write the description for an agent that cannot see this conversation (goal, context, files, acceptance). Lands in Backlog (default) or Todo. Pass a unique idempotencyKey; retrying with the same key returns the same card. At most 20 cards or starts per hour (CARD_LIMIT). AGENT_CARDS_DISABLED: the user turned this off.',
        inputSchema: dispatcherInputs.createCard,
        outputSchema: createCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (raw) => inProject(dispatcherInputs.createCard, raw, (c, input) => this.cards.create(c, input), true),
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
  }
}
