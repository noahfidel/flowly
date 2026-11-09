import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import {
  handoverInputSchema,
  integrateInputSchema,
  integrateResultSchema,
  ideaInputSchema,
  projectIdeaInputSchema,
  projectIdeaResultSchema,
  ideaRemovalSchema,
  ideaUpdateInputSchema,
  rememberInputSchema,
  recallInputSchema,
  recallResultSchema,
  agentSearchInputSchema,
  agentSearchResultSchema,
  artifactInputSchema,
  artifactRemovalSchema,
  readExternalInputSchema,
  externalReadSchema,
  tagsInputSchema,
  typeInputSchema,
  nextMovesInputSchema,
  listCardsInputSchema,
  listCardsResultSchema,
  getCardInputSchema,
  getCardResultSchema,
  createCardInputSchema,
  createCardResultSchema,
  updateCardInputSchema,
  updateCardResultSchema,
  workpadInputSchema,
  progressInputSchema,
  statusInputSchema,
  toolContextSchema,
  toolResultSchema,
  type ToolIdentity,
  type ToolPreparation,
} from "../shared/tools";
import { AgentService } from "./agent-service";
import { AgentCards, type CardCaller } from "./agent-cards";
import { ProjectIdeas } from "./project-ideas";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ToolSecrets, writePrivate } from "./tool-context";
import { ToolError, toolFailure } from "./tool-error";
import { cliSource } from "./cli-source";
import { skillText, workingInstructions } from "./skill-source";
import { logFailure } from "./error-report";

const maxBody = 262144;

/** A tool's value, or its failure as an MCP tool error. */
const wrap = async (operation: () => Promise<object>) => {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        { type: "text" as const, text: JSON.stringify(toolFailure(e)) },
      ],
      structuredContent: { error: toolFailure(e) },
    };
  }
};

export class ToolServer {
  readonly secrets: ToolSecrets;
  readonly agents: AgentService;
  readonly cards: AgentCards;
  readonly projectIdeas: ProjectIdeas;
  private server?: Server;
  private handler?: McpHttpHandler;
  private starting?: Promise<void>;
  private preparation = Promise.resolve<unknown>(undefined);
  private url = "";
  private reason = "Starting Kanban tool service…";
  private stopped = false;
  constructor(readonly store: BoardStore) {
    this.secrets = new ToolSecrets(store.directory);
    this.agents = new AgentService(store, this.secrets);
    this.cards = new AgentCards(store);
    this.projectIdeas = new ProjectIdeas(store);
  }
  attach(paseo: PaseoApi) {
    this.agents.attach(paseo);
    this.cards.attach(paseo);
  }
  private async taskIds() {
    return new Set((await this.store.read()).tasks.map((t) => t.id));
  }
  /** Managed sessions of cards that still exist (a deleted card's binding is not listed). */
  async managedSessions() {
    return this.secrets.managedSessions(await this.taskIds());
  }
  /** Removes the bindings and credentials of deleted cards; never throws into its caller's flow. */
  async pruneContexts() {
    return this.secrets.pruneContexts(await this.taskIds());
  }
  health() {
    const listening = !!this.server?.listening;
    return {
      listening,
      sdkReady: this.agents.sdkReady,
      ready: listening && this.agents.sdkReady,
      reason:
        this.reason ||
        (!this.agents.sdkReady
          ? "Waiting for Paseo context. Refresh the drawer or start a session turn."
          : ""),
      version: 1 as const,
    };
  }
  async start() {
    if (this.stopped)
      throw new ToolError(
        "TOOLS_UNAVAILABLE",
        "Tool service is stopping.",
        true,
      );
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    const job = this.initialize();
    this.starting = job;
    try {
      await job;
      this.reason = "";
    } catch (e) {
      this.reason = toolFailure(e).message;
      await this.closeListener();
      throw new ToolError("TOOLS_UNAVAILABLE", this.reason, true);
    } finally {
      this.starting = undefined;
    }
  }
  private token(value: string | undefined) {
    if (!value?.startsWith("Bearer "))
      throw new ToolError("UNAUTHORIZED", "Missing Kanban session credential.");
    return this.secrets.authenticateAny(value.slice(7));
  }
  /** The four card tools (AGENT-CARDS-SPEC §3), for card sessions and sessions outside cards alike. */
  private registerCardTools(mcp: McpServer, caller: () => Promise<CardCaller>) {
    const run = (operation: (c: CardCaller) => Promise<object>) => wrap(async () => operation(await caller()));
    mcp.registerTool(
      "flowly_list_cards",
      {
        description:
          "List the cards of this Flowly project with their lane, priority, type, tags and revision (descriptions cut to 300 characters; read one in full with flowly_get_card). Filter by words (query) and lanes (status). Read-only.",
        inputSchema: listCardsInputSchema,
        outputSchema: listCardsResultSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (input) => run((c) => this.cards.list(c, input)),
    );
    mcp.registerTool(
      "flowly_get_card",
      {
        description:
          "Read one card of this Flowly project in full: title, description, lane, priority, type, tags, links and revision. Pass its revision to flowly_update_card. editable=false for archived and finished cards. Read-only.",
        inputSchema: getCardInputSchema,
        outputSchema: getCardResultSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (input) => run((c) => this.cards.get(c, input)),
    );
    mcp.registerTool(
      "flowly_create_card",
      {
        description:
          'Create a card in this Flowly project, only when the user asked you to create cards (for example "split this into cards" or "make a card for X"). Follow-up work the user did not ask for is an idea (flowly_propose_idea in a card session), not a card. The card gets its own new workspace in the project folder and lands in Backlog (default) or Todo; no session starts, the user starts it. Its agent cannot see this conversation: write the description with the goal, context, files and acceptance criteria. From a card session the new card follows up your card. Pass a unique idempotencyKey; retrying with the same key returns the same card (replayed=true). At most 20 cards per session per hour (CARD_LIMIT). AGENT_CARDS_DISABLED: the user turned this off; tell them instead.',
        inputSchema: createCardInputSchema,
        outputSchema: createCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (input) => run((c) => this.cards.create(c, input)),
    );
    mcp.registerTool(
      "flowly_update_card",
      {
        description:
          "Edit a card of this Flowly project, only when the user asked you to: title, description (replaces it), priority, type, tags (addTags; removeTags only for tags an agent added) or its lane between Backlog and Todo. Read it first with flowly_get_card and pass its revision; on REVISION_CONFLICT read it again and keep the other changes. Work stages, In review, Done and Cancelled are not set here (STATUS_FORBIDDEN): a card's own session uses flowly_update_status, and finishing a card is the user's decision. Archived and finished cards are refused. Each edit increments the card's revision and shows in its activity. For your own card's setup keep using flowly_set_type and flowly_set_tags.",
        inputSchema: updateCardInputSchema,
        outputSchema: updateCardResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      (input) => run((c) => this.cards.update(c, input)),
    );
  }
  private async initialize() {
    await this.secrets.initialize();
    // Bindings of cards deleted earlier (or before this cleanup existed). An empty board is never trusted for this.
    if ((await this.store.read()).tasks.length)
      await this.pruneContexts().catch((e) =>
        logFailure("Kanban session bindings not cleaned:", e),
      );
    await writePrivate(
      join(this.store.directory, "flowly.mjs"),
      cliSource,
      0o700,
    );
    // Refresh an existing session's old CLI entry on upgrade. Fresh installs
    // create only flowly.mjs; new instructions never advertise the old path.
    const legacyCli = join(this.store.directory, "ultra-kanban.mjs");
    try {
      await access(legacyCli);
      await writePrivate(legacyCli, cliSource, 0o700);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await writePrivate(join(this.store.directory, "SKILL.md"), skillText);
    let port = 0;
    const discoveryFile = join(this.store.directory, "tool-endpoint.json");
    try {
      port = z
        .object({
          version: z.literal(1),
          port: z.number().int().min(1).max(65535),
          url: z.string(),
        })
        .parse(JSON.parse(await readFile(discoveryFile, "utf8"))).port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError(
          "TOOLS_UNAVAILABLE",
          `Tool discovery is invalid; preserved at ${discoveryFile}.`,
        );
    }
    this.handler = createMcpHandler(
      ({ requestInfo }) => {
        const auth = this.token(
          requestInfo?.headers.get("authorization") || undefined,
        );
        const mcp = new McpServer({
          name: "flowly",
          version: "0.2.0",
        });
        // A session outside cards gets only the project's card tools (AGENT-CARDS-SPEC §2.2).
        if (auth.kind === "board") {
          const board = auth.identity;
          this.registerCardTools(mcp, () => this.cards.boardCaller(board));
          mcp.registerTool(
            "flowly_propose_idea",
            {
              description:
                "Propose a next step for this Flowly project that does not belong to any card: a backlog item the user did not ask for. The user sees it on the project's Ideas page and may turn it into a card. Its agent cannot see this conversation, so put the files, branches and findings the card would need in context. Check for duplicates first: an open idea with the same title is refused (DUPLICATE_IDEA). Never start the idea yourself or create a card for it unless the user asked. IDEAS_DISABLED: the user turned Ideas off; mention the next step in your reply instead and do not retry.",
              inputSchema: projectIdeaInputSchema,
              outputSchema: projectIdeaResultSchema,
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            },
            (input) =>
              wrap(async () => {
                if (!(await this.agents.ideasOn()))
                  throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Mention the next step in your reply instead.");
                const caller = await this.cards.liveBoardCaller(board);
                return { idea: await this.projectIdeas.propose(caller.projectId, input, { actor: "agent", agentId: caller.agentId }) };
              }),
          );
          return mcp;
        }
        const identity = auth.identity;
        mcp.registerTool(
          "flowly_get_task",
          {
            description:
              "Read this session's current Kanban card, latest turnChecklist, effective repo/worktree directories, both revisions and signed request. Read at the start of every turn, including commit/merge-only follow-ups, and before any write. Handle unread inputs and fix setup.missing (flowly_set_type, flowly_set_tags, flowly_update_workpad) before work.",
            inputSchema: z.strictObject({}),
            outputSchema: toolContextSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          () => wrap(() => this.agents.get(identity)),
        );
        mcp.registerTool(
          "flowly_update_status",
          {
            description:
              "Move this card to one of allowedStatuses from get_task (design, development, test, blocked, in_review, committed or integrated when they are lanes of this project; lanes lists the names the user sees). Use the work stage that matches what you are doing now: design for plans/specs/research, development for implementation, test for verification; you decide where to start and may skip or go back. Keep it current: switch when the work changes, and at the start of each turn correct the stage the card was automatically resumed in if it does not match the work. Copy revisions and request from get_task, include a note. Done/cancelled are human decisions. Set committed only once all of this card's changes are committed (say in the note whether you pushed); it is a delivery like in_review. Set integrated only once all of this card's commits are in the branch checked out in the main checkout (the repository's own directory, not a worktree; normally main), without needing a push; also a delivery, and the furthest true status wins (committing directly on that branch goes straight to integrated). Delivering to in_review, committed or integrated with open workpad items returns WORKPAD_OPEN, and with missing card setup (no type, no tags or no workpad) SETUP_INCOMPLETE; both change nothing. The first attempt is always refused, even with acknowledgeOpen=true. Review that refusal, finish what you can, then retry with acknowledgeOpen=true and a note explaining every remaining item. Changed card/workpad/HEAD or a new turn requires a new refusal. When you deliver (in_review, committed or integrated), pass outputs=[{target,title,note}] for the PR/MR links, reports and evidence from this call, or outputs=[] if none; omission returns a reminder. Outputs are registered atomically with this write. Also pass nextMoves: the 1-3 messages the user is most likely to send you next (same items as flowly_suggest_next_moves, recommended first; a moveTo=\"done\" move is only accepted together with in_review, committed or integrated), or [] when nothing needs the user. Leave it out on mid-work stage changes. A delivery (in_review, committed, integrated or blocked) that leaves this turn without next moves, or without any idea on the card, gets a reminders list in its result, and so does any write while the card setup is missing: text only, the write succeeded. A refused call records nothing: resend it with the same nextMoves. Retry identical uncertain requests only.",
            inputSchema: statusInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => wrap(() => this.agents.write(identity, "status", input)),
        );
        mcp.registerTool(
          "flowly_report_progress",
          {
            description:
              "Append this session's checkpoint/blocker/result/question without changing card status or task revision. kind=question asks the user something and marks the card Needs you until they reply; it is the fallback when you have no question tool of your own (such as AskUserQuestion) or the question is open-ended. Never report a question you already asked through that tool. Copy revisions/request from get_task. Partial contribution does not complete the card. When you ask (kind=question; the moves are the likely answers), report a blocker or give a result, pass nextMoves (same items as flowly_suggest_next_moves, 1-3 recommended first, or [] when nothing needs the user). For kind=result, pass outputs=[{target,title,note}] for the PR/MR links, reports and evidence from this call, or outputs=[] if none; omission returns a reminder. Outputs are registered atomically with this write and are invalid for other kinds. A question or result that leaves this turn without next moves gets a reminders list in its result: text only, the write succeeded.",
            inputSchema: progressInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => wrap(() => this.agents.write(identity, "progress", input)),
        );
        mcp.registerTool(
          "flowly_propose_idea",
          {
            description:
              "Propose a next step the user did not ask for. scope=here: an extension of this card's goal; the user may send it back to this card's session as an instruction. scope=new: divergent work (a bug found on the way, a refactor, a separate feature); the user may turn it into a new card that starts from your detail, rationale and context, whose agent cannot see this conversation, so put files, branches and findings in context. Do not propose work this card already requires, propose at most 3 per delivery, check ideas from get_task for duplicates, and never start the idea yourself. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaInputSchema,
            outputSchema: toolResultSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          (input) => wrap(() => this.agents.write(identity, "idea", input)),
        );
        mcp.registerTool(
          "flowly_update_idea",
          {
            description:
              "Edit or dismiss an idea on this card (id from get_task ideas). Pass only the fields to change: title, detail, rationale, context, type, priority, scope or tags (tags replace the suggested ones). status=dismissed closes it: use it when the user rejected the idea in conversation or it no longer applies (for example this card already did it), instead of leaving it open. A dismissed idea stays under Closed, where only the user can restore it. Only open ideas can be edited; an accepted idea is final (IDEA_CLOSED). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaUpdateInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "idea_update", input)),
        );
        mcp.registerTool(
          "flowly_remove_idea",
          {
            description:
              "Delete an idea on this card that should never have been proposed: a duplicate, a mistake, or work this card already requires. For an idea the user rejected, prefer flowly_update_idea status=dismissed, which keeps it visible. An accepted idea cannot be removed (IDEA_CLOSED). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: ideaRemovalSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "idea_remove", input)),
        );
        mcp.registerTool(
          "flowly_remember",
          {
            description:
              "Propose something for the project's memory that would make a later, different card's agent re-ask the user, retry a dead end or hit the same problem: a decision the user made with its reason, including a rejected option (decision); a dead end, or the general lesson behind a bug you fixed, not the fix (pitfall); how the user wants work done here that the repository does not say (convention); people, external systems and environments (contact). It is a candidate: the user confirms it before any session sees it. Not this card's progress (that is the summary), not open or deferred items (those are ideas), not what code, git or docs already say, and never a secret (say where it is kept). Only what holds beyond this card: if every later card that would need it works on the same feature, file or bug, leave it to the code and the summary. At most 3 per delivery, usually none; check memory.candidates in get_task first. To correct an entry, propose a new one with supersedes=<its id>; you cannot edit or delete entries. Returns MEMORY_DISABLED, MEMORY_DUPLICATE, MEMORY_LIMIT or MEMORY_SECRET when refused. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: rememberInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "remember", input)),
        );
        mcp.registerTool(
          "flowly_recall",
          {
            description:
              "Search the project's memory: decisions, conventions, pitfalls and contacts the user confirmed on earlier cards. get_task memory already lists the entries chosen for this card; use this when you start on an area they do not cover. Read-only; no request needed.",
            inputSchema: recallInputSchema,
            outputSchema: recallResultSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.recall(identity, input)),
        );
        mcp.registerTool(
          "flowly_search",
          {
            description:
              "Search earlier cards in this project: their titles, descriptions, summaries, progress notes, workpads, ideas and deliverables (PR links, Jira keys, file paths). Use it when you start on an area to find related or duplicate work and how it was verified. Project memory is not included; use flowly_recall for it. Read-only; no request needed.",
            inputSchema: agentSearchInputSchema,
            outputSchema: agentSearchResultSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.searchCards(identity, input)),
        );
        mcp.registerTool(
          "flowly_add_artifact",
          {
            description:
              "Register a file or link that is an input this card worked from or an output it delivered, so the user and later sessions can find it. role=input|output; target is an http(s) link or a path (absolute, or relative to the workspace directory) inside this card's directories. Add deliverables when you produce them (specs, reports, exported files, PRs, verification evidence), not every file you touched: source code changes are already visible through the workspace diff. Use a short title and a one-line note on what it is for. Adding a recorded target again updates the one you or another agent added; one the user added stays as is. Check artifacts in get_task first. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: artifactInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "artifact", input)),
        );
        mcp.registerTool(
          "flowly_remove_artifact",
          {
            description:
              "Remove an artifact an agent added to this card (id from get_task artifacts), e.g. a wrong or replaced entry. Artifacts the user added can only be removed by the user. Never deletes the file. Copy revisions/request from get_task.",
            inputSchema: artifactRemovalSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "artifact_remove", input)),
        );
        const readExternal = {
          description:
            "Read an external input of this card (an artifact with an external field in get_task): a Jira ticket, Confluence page, GitHub/GitLab issue, pull or merge request, or Azure DevOps work item. Returns Markdown: metadata, the description or page content and the latest comments; for pull/merge requests also the branches, head commit and changed file names (no diff: fetch the branch with git to see the code). The item is part of the task: read it before you start and again when get_task marks it unread. Read-only: Flowly never changes the item, and its status is for reference only (do not set the card stage from it). Only this card's external inputs can be read; to read a linked item, first add its link with flowly_add_artifact role=input.",
          inputSchema: readExternalInputSchema,
          outputSchema: externalReadSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        };
        mcp.registerTool("flowly_read_external", readExternal, (input) => wrap(() => this.agents.readExternal(identity, input)));
        // Older sessions' skill names the tool flowly_read_ticket (CONNECTORS-SPEC §3.3).
        mcp.registerTool(
          "flowly_read_ticket",
          { ...readExternal, description: `Deprecated alias of flowly_read_external; use that instead. ${readExternal.description}` },
          (input) => wrap(() => this.agents.readExternal(identity, input)),
        );
        mcp.registerTool(
          "flowly_set_tags",
          {
            description:
              'Tag this card with the functional areas it touches and the improvement directions it serves (for example a module like "drawer" or "session-composer", or a direction like "performance", "a11y", "mobile"), so the user can filter and search cards later. Tags are not the task type, status or priority; do not repeat those. Reuse a tag from projectTags in get_task when one fits instead of inventing a synonym. Do this at the start of the work, before you change code (get_task setup.tagsMissing). Use 1-4 short lowercase tags and adjust them if the scope changes. You can only remove tags an agent added. Does not change card status or task revision. Copy revisions/request from get_task.',
            inputSchema: tagsInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "tags", input)),
        );
        mcp.registerTool(
          "flowly_set_type",
          {
            description:
              "Set this card's type (feature, bugfix, research, refactor, docs, chore) when it has none (get_task setup.typeMissing). Do this at the start of the work, before you change code. A type the user or an agent already set is kept: the call returns TYPE_ALREADY_SET and changes nothing, so do not retry with another type. Increments the task revision. Copy revisions/request from get_task.",
            inputSchema: typeInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "type", input)),
        );
        mcp.registerTool(
          "flowly_suggest_next_moves",
          {
            description:
              "For updates in the middle of a turn, or when your delivery call had no nextMoves; when you deliver or ask, pass nextMoves on flowly_update_status / flowly_report_progress instead. Offer the 1-3 next messages the user is most likely to send you (e.g. verify the change, commit and push, continue to the next stage), recommended first, or [] when nothing needs the user. Flowly shows them above the user's message box; picking one only fills the box, the user edits or sends it. Valid until the user's next message starts a new turn; calling again in the same turn replaces them. Still mention the options in your reply. Not for questions (use flowly_report_progress kind=question; its nextMoves are the likely answers) or for divergent work (use flowly_propose_idea). Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: nextMovesInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "next_moves", input)),
        );
        mcp.registerTool(
          "flowly_update_workpad",
          {
            description:
              "Do this at the start of the work, before you change code (get_task setup.workpadMissing), and after each milestone. Replace this card's workpad: acceptance criteria (done or not), validation checks (pass, fail or unrun, with the command and the commit they ran on) and confusions (what in the card was unclear). The plan comes from your own todo list; do not repeat it here. Send all three lists every time; items you leave out are removed. Copy workpad.revision from get_task as workpadRevision (0 when there is none). On WORKPAD_CONFLICT the user changed it: re-read, keep their checks, retry. WORKPAD_DISABLED (workpadEnabled=false in get_task): the user turned it off for this project; report criteria and checks in your notes instead and do not retry. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: workpadInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "workpad", input)),
        );
        mcp.registerTool(
          "flowly_handover",
          {
            description:
              "Write this card's handover for a switch to a worktree (WORKSPACE-SWITCH-SPEC §2): every repo-relative file this card changed in the main checkout, including files changed by scripts or generated, and in notes which hunks in files shared with other cards are this card's and what is unfinished. Call it when the user asks for a handover or before they switch the card. Replaces the card's previous handover. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: handoverInputSchema,
            outputSchema: toolResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.write(identity, "handover", input)),
        );
        mcp.registerTool(
          "flowly_integrate",
          {
            description:
              "Integrate this worktree card's branch (or ref) into the branch checked out in the main checkout, only when the user asks (WORKSPACE-SWITCH-SPEC §6). Flowly applies it to the main checkout's index and working tree and moves its branch with a compare-and-swap, so other uncommitted work there stays; it never merges, stashes or resets. Refusals: RELEASE_PENDING (ask the user to press Release from main on the card first), REBASE_NEEDED (rebase your branch onto the main branch in your worktree, rerun the checks, call again), CONFLICT (uncommitted changes in the main checkout touch the same lines; files listed), NOT_WORKTREE, DETACHED_HEAD, CHECKOUT_BUSY, GIT_BUSY. Afterwards set integrated with flowly_update_status as usual. Does not change card status or task revision. Copy revisions/request from get_task.",
            inputSchema: integrateInputSchema,
            outputSchema: integrateResultSchema,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
          (input) => wrap(() => this.agents.integrate(identity, input)),
        );
        this.registerCardTools(mcp, () => this.agents.cardCaller(identity));
        return mcp;
      },
      // A full workpad with multi-byte text can exceed 64 KiB (WORKPAD-SPEC §3).
      { responseMode: "json", maxRequestBodySize: maxBody },
    );
    const nodeHandler = toNodeHandler(this.handler, {
      maxRequestBodySize: maxBody,
    });
    const host = localhostHostValidation(),
      origin = localhostOriginValidation();
    this.server = createServer((req, res) => {
      if (!host(req, res) || !origin(req, res)) return;
      void (async () => {
        if (this.stopped)
          throw new ToolError(
            "TOOLS_UNAVAILABLE",
            "Tool service is stopping.",
            true,
          );
        const auth = this.token(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        );
        const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
        if (pathname === "/mcp") {
          await nodeHandler(req, res);
          return;
        }
        if (pathname !== "/api" || req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        // The CLI is for card sessions; sessions outside cards use MCP only (AGENT-CARDS-SPEC §1).
        if (auth.kind !== "card")
          throw new ToolError("UNAUTHORIZED", "This credential is for MCP only.");
        await this.apiRequest(req, res, auth.identity);
      })().catch((e) =>
        this.json(
          res,
          { ok: false, error: toolFailure(e) },
          e instanceof ToolError && e.code === "UNAUTHORIZED" ? 401 : 400,
        ),
      );
    });
    this.server.requestTimeout = 25000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Kanban listener has no port.");
    this.url = `http://127.0.0.1:${address.port}/`;
    await writePrivate(
      discoveryFile,
      JSON.stringify({ version: 1, port: address.port, url: this.url }),
    );
  }
  private json(res: ServerResponse, value: unknown, status = 200) {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
  }
  private async apiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    identity: ToolIdentity,
  ) {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const data = Buffer.from(chunk);
      length += data.length;
      if (length > maxBody) {
        req.resume();
        throw new ToolError("INVALID_INPUT", "Request body is too large.");
      }
      chunks.push(data);
    }
    const body = z
      .strictObject({
        action: z.enum(["get", "status", "progress", "idea", "idea_update", "idea_remove", "remember", "recall", "search", "artifact", "artifact_remove", "tags", "type", "next_moves", "workpad", "handover", "integrate", "external", "ticket", "list_cards", "get_card", "create_card", "update_card"]),
        input: z.unknown(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const value =
      body.action === "get"
        ? (z.strictObject({}).parse(body.input),
          await this.agents.get(identity))
        : body.action === "external" || body.action === "ticket"
          ? await this.agents.readExternal(identity, readExternalInputSchema.parse(body.input))
          : body.action === "recall"
            ? await this.agents.recall(identity, recallInputSchema.parse(body.input))
            : body.action === "search"
              ? await this.agents.searchCards(identity, agentSearchInputSchema.parse(body.input))
            : body.action === "list_cards" || body.action === "get_card" || body.action === "create_card" || body.action === "update_card"
              ? await this.cardAction(identity, body.action, body.input)
            : body.action === "integrate"
              ? await this.agents.integrate(identity, integrateInputSchema.parse(body.input))
            : await this.agents.write(identity, body.action, body.input);
    this.json(res, { ok: true, result: value });
  }
  /** A card tool over the CLI (AGENT-CARDS-SPEC §5). */
  private async cardAction(identity: ToolIdentity, action: "list_cards" | "get_card" | "create_card" | "update_card", input: unknown) {
    const caller = await this.agents.cardCaller(identity);
    if (action === "list_cards") return this.cards.list(caller, input);
    if (action === "get_card") return this.cards.get(caller, input);
    if (action === "create_card") return this.cards.create(caller, input);
    return this.cards.update(caller, input);
  }
  /** The project's card tools for a session outside cards, or null (AGENT-CARDS-SPEC §2.2). */
  async boardServer(request: { agentId: string; workspaceId: string | null; labels?: Record<string, string> }, paseo: PaseoApi) {
    this.attach(paseo);
    const identity = await this.cards.boardSession(request, await this.secrets.hasContext(request.agentId));
    if (!identity) return null;
    await this.start();
    return {
      type: "http" as const,
      url: `${this.url}mcp`,
      headers: { Authorization: `Bearer ${this.secrets.boardCredential(identity)}` },
    };
  }
  private async prepare(
    identity: ToolIdentity,
    context: string,
    method: "mcp" | "cli",
  ): Promise<ToolPreparation> {
    await this.start();
    const contextFile = await this.secrets.writeContext(identity, method),
      cliPath = join(this.store.directory, "flowly.mjs"),
      skillPath = join(this.store.directory, "SKILL.md");
    return {
      agentId: identity.agentId,
      contextFile,
      cliPath,
      skillPath,
      instructions: workingInstructions(
        context,
        cliPath,
        contextFile,
        skillPath,
      ),
      mcp: {
        type: "http",
        url: `${this.url}mcp`,
        headers: {
          Authorization: `Bearer ${this.secrets.credential(identity)}`,
        },
      },
    };
  }
  async prepareSession(taskId: string, operationId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const job = this.preparation.then(async () => {
      await this.start();
      const board = await this.store.read(),
        task = board.tasks.find((t) => t.id === taskId);
      if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
      const ctx = await new BoardService(this.store).context(taskId, paseo, undefined, { artifactsOn: await this.agents.artifactsOn() });
      if (!ctx.available)
        throw new ToolError("RESOURCE_UNAVAILABLE", ctx.reason);
      const identity = await this.secrets.prepared(
        taskId,
        task.workspaceId,
        operationId,
      );
      // The injected memory counts as used by this card (PROJECT-MEMORY-SPEC §3.2).
      void this.agents.memory?.markUsed(ctx.memoryIds, taskId).catch(() => undefined);
      const existing = await paseo.agents.ref(identity.agentId).refresh();
      if (
        existing?.agent &&
        (existing.agent.workspaceId !== task.workspaceId ||
          existing.agent.archivedAt)
      )
        throw new ToolError(
          "SESSION_MISMATCH",
          "Prepared agent ID now belongs to an unavailable/different session.",
        );
      return this.prepare(identity, ctx.context, "mcp");
    });
    this.preparation = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  async prepareExisting(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    await this.start();
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId);
    if (!task) throw new ToolError("RESOURCE_UNAVAILABLE", "Task not found.");
    const identity = { taskId, agentId, workspaceId: task.workspaceId };
    const current = await this.agents.get(identity, false);
    if (current.task.archivedAt || current.project.archivedAt)
      throw new ToolError("ARCHIVED", "Task/project is archived.");
    const ctx = await new BoardService(this.store).context(taskId, paseo, undefined, { artifactsOn: await this.agents.artifactsOn() });
    void this.agents.memory?.markUsed(ctx.memoryIds, taskId).catch(() => undefined);
    return this.prepare(identity, ctx.context, "cli");
  }
  async sessionContext(
    agentId: string,
    workspaceId: string | null,
    paseo: PaseoApi,
  ) {
    this.attach(paseo);
    if (!workspaceId) return null;
    const board = await this.store.read(),
      task = board.tasks.find((t) => t.workspaceId === workspaceId),
      project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || task.archivedAt || project?.archivedAt) return null;
    // Only Kanban-managed sessions get tools: launched from the card (prepared
    // with credentials) or explicitly opted in via "Send Kanban work
    // instructions". Other sessions in a card's workspace stay untouched.
    if (!(await this.secrets.hasContext(agentId))) return null;
    await this.start();
    return this.secrets.writeContext(
      { agentId, workspaceId, taskId: task.id },
      "cli",
    );
  }
  async accessState(taskId: string, agentId: string, paseo: PaseoApi) {
    this.attach(paseo);
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId),
      actor = await paseo.agents.ref(agentId).refresh();
    if (!task || !actor?.agent || actor.agent.workspaceId !== task.workspaceId)
      throw new ToolError(
        "SESSION_MISMATCH",
        "Session does not belong to this card.",
      );
    let methods: string[] = [];
    try {
      const data = JSON.parse(
        await readFile(this.secrets.contextFile(agentId), "utf8"),
      );
      if (data.identity.taskId === taskId)
        methods = z.array(z.string()).parse(data.methods || []);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const durable = (await this.store.read()).agentReceipts
        .filter((r) => r.agentId === agentId && r.taskId === taskId)
        .at(-1),
      recent = this.agents.accesses.get(agentId);
    return {
      methods,
      lastSuccessAt: recent?.at || durable?.at || null,
      lastAction: recent?.action || durable?.action || null,
      ...this.health(),
    };
  }
  async stop() {
    this.stopped = true;
    if (this.starting) await this.starting.catch(() => undefined);
    await this.closeListener();
    await this.store.read().catch(() => undefined);
  }
  private async closeListener() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
    await this.handler?.close();
    this.server = undefined;
    this.handler = undefined;
  }
}
