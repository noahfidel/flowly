import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { switchLimits, type Board, type Project, type Task } from "../shared/model";
import { effectiveAgentModel, providerBase, startingAgent, suggestedMode, type AgentModel } from "../shared/agent-defaults";
import { lastSessionSettings } from "../shared/attention";
import { itemTypeOf } from "../shared/connectors";
import { startCardInputSchema, type StartCardInput, type StartCardResult, type ToolPreparation } from "../shared/tools";
import type { AgentCards, CardCaller } from "./agent-cards";
import type { ConnectorService } from "./connectors/service";
import { logFailure } from "./error-report";
import { generatedBranchName, resolveWorktreeBaseRef } from "./service";
import type { BoardStore } from "./store";
import { digest } from "./tool-context";
import { ToolError } from "./tool-error";
import { workspaceSessions } from "./workspace-switch";
import { cardWorkspaceIds } from "../shared/workspace-switch";

export { startCardInputSchema, startCardResultSchema } from "../shared/tools";

const execute = promisify(execFile);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const finished = (status: string) => status === "done" || status === "cancelled";

/** The `workspaces.create` request a start sends; kept per operation so retries send it unchanged (§4.1). */
const worktreeRequestSchema = z.object({
  title: z.string(),
  idempotencyKey: z.string(),
  source: z.union([
    z.object({ kind: z.literal("worktree"), cwd: z.string(), projectId: z.string(), action: z.literal("branch-off"), refName: z.string(), branchName: z.string() }),
    z.object({ kind: z.literal("worktree"), cwd: z.string(), projectId: z.string(), action: z.literal("checkout"), refName: z.string() }),
  ]),
});
type WorktreeRequest = z.infer<typeof worktreeRequestSchema>;
type BranchSource = { action: "branch-off"; refName: string; branchName: string } | { action: "checkout"; refName: string };
type Workspace = { workspaceKind?: string | null; workspaceDirectory?: string | null };

/** Whether git accepts `name` as a branch name. */
async function validBranchName(name: string) {
  if (!name || name.startsWith("-")) return false;
  try {
    const { stdout } = await execute("git", ["check-ref-format", "--branch", name], { timeout: 10000 });
    return stdout.trim() === name;
  } catch {
    return false;
  }
}

async function refExists(root: string, ref: string) {
  try {
    await execute("git", ["-C", root, "show-ref", "--verify", "--quiet", ref], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Branches checked out in any worktree of the repository, the main checkout included. */
async function checkedOutBranches(root: string) {
  const { stdout } = await execute("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 10000 });
  return new Set(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length).trim()),
  );
}

/**
 * The `branchName` of the card's first Linear issue input, fetched fresh through its connection
 * (START-CARD-SPEC §6); null when there is none, it can't be read, or git rejects it.
 */
export async function linearBranchFor(task: Task, board: Board, connectors: Pick<ConnectorService, "resolve" | "cached"> | undefined): Promise<string | null> {
  const input = board.artifacts.find(
    (a) => a.taskId === task.id && a.role === "input" && a.external?.provider === "linear" && itemTypeOf(a.external) === "issue",
  );
  if (!input?.external || !connectors) return null;
  const ref = input.external;
  try {
    await connectors.resolve(ref.connectionId, ref.key, "issue");
    const name = (await connectors.cached(ref))?.branchName?.trim();
    return name && (await validBranchName(name)) ? name : null;
  } catch (e) {
    logFailure("Flowly Linear branch name not read:", e, task.id);
    return null;
  }
}

export type StarterDeps = {
  /** `ToolServer.prepareSession`: card context, MCP credential and the prepared session id for this operation. */
  prepare: (taskId: string, operationId: string, paseo: PaseoApi) => Promise<ToolPreparation>;
  /** The identity an earlier `prepare` stored for this operation, or null. */
  preparedFor: (operationId: string) => Promise<{ agentId: string; taskId: string; workspaceId: string } | null>;
  /** The worktree request kept for this operation (`ToolSecrets.keptStart`), or null. */
  keptWorktree: (operationId: string) => Promise<unknown>;
  /** Keeps it on disk, so a retry after a plugin reload sends the identical request. */
  keepWorktree: (operationId: string, request: WorktreeRequest) => Promise<void>;
};

/**
 * flowly_start_card (START-CARD-SPEC): starts a card's session in its worktree, first moving a
 * session-less directory card Flowly created into a new worktree. Starts in one project root run one at a time.
 */
export class CardStarter {
  /** Linear inputs name the worktree's branch (§6); set by the plugin entry. */
  connectors?: Pick<ConnectorService, "resolve" | "cached">;
  /** The global default model (Settings → Models); set by the plugin entry. */
  modelDefault: () => Promise<AgentModel | null> = async () => null;
  /** One queue per project root: starts in one root run one at a time; other roots do not wait. */
  private chains = new Map<string, Promise<unknown>>();
  /** Root lookups run in call order, so two starts join their root's queue in the order they were asked. */
  private routing: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: BoardStore,
    readonly cards: AgentCards,
    readonly deps: StarterDeps,
  ) {}

  start(caller: CardCaller, raw: StartCardInput | unknown, paseo: PaseoApi): Promise<StartCardResult> {
    const input = startCardInputSchema.parse(raw);
    const queued = this.routing.then(async () => {
      const project = (await this.store.read()).projects.find((p) => p.id === caller.projectId);
      const key = project?.primaryPath ?? `project:${caller.projectId}`;
      const job = (this.chains.get(key) ?? Promise.resolve()).then(() => this.run(caller, input, paseo));
      const tail = job.catch(() => undefined);
      this.chains.set(key, tail);
      void tail.then(() => {
        if (this.chains.get(key) === tail) this.chains.delete(key);
      });
      return { job };
    });
    this.routing = queued.catch(() => undefined);
    return queued.then(({ job }) => job);
  }

  private async run(caller: CardCaller, input: ReturnType<typeof startCardInputSchema.parse>, paseo: PaseoApi): Promise<StartCardResult> {
    // The user's own Start again is not an agent creating work: no agent-cards switch, no hourly limit.
    if (!caller.human) await this.cards.enabled();
    const board = await this.store.read();
    const project = board.projects.find((p) => p.id === caller.projectId);
    if (!project) throw new ToolError("NOT_FOUND", "The Flowly project was removed.");
    if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The Flowly project is archived.");
    const task = board.tasks.find((t) => t.id === input.taskId && t.projectId === project.id);
    if (!task || task.archivedAt) throw new ToolError("NOT_FOUND", "No live card with that id in this project. Use an id from flowly_list_cards.");
    if (finished(task.status)) throw new ToolError("CARD_FINISHED", "The card is Done or Cancelled; only the user reopens it.");
    const operationId = `start-card:${digest(JSON.stringify([task.id, caller.agentId, input.idempotencyKey]))}`;
    // A retry after a lost response: the session this operation prepared, still in the card's workspace (§3 step 4).
    const prior = await this.deps.preparedFor(operationId);
    if (prior && prior.taskId === task.id && prior.workspaceId === task.workspaceId) {
      const found = await paseo.agents.ref(prior.agentId).refresh().catch(() => null);
      if (found?.agent && found.agent.workspaceId === task.workspaceId && !found.agent.archivedAt)
        return { taskId: task.id, workspaceId: task.workspaceId, agentId: prior.agentId, replayed: true };
    }
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null);
    if (!workspace || workspace.archivingAt) throw new ToolError("RESOURCE_UNAVAILABLE", "The card's workspace is unavailable or being archived.");
    const sessions = await workspaceSessions(paseo, task.workspaceId, true);
    // Any session not archived is the card's, for the user's Start again too: a closed one is a stopped process that
    // a message resumes (ruling, Noah 2026-11-09). Nothing is archived.
    const live = sessions.filter((s) => !s.archived);
    if (live.length)
      throw new ToolError("CARD_HAS_SESSION", `The card already has a live session (${live[0].id}). Send it instructions instead of starting another.`);
    // Where the session runs (§4).
    const move = workspace.workspaceKind !== "worktree" && !project.links?.length;
    if (move) {
      const owned = task.ownsWorkspace === true && !task.previousWorkspaces?.length && !task.switch;
      if (!owned || sessions.length)
        throw new ToolError(
          "NEEDS_WORKTREE",
          caller.human
            ? "This card's folder already had sessions, or Flowly did not create it for the card. Use Switch to worktree on the card, then start again."
            : "The card works in a directory workspace that already had sessions or that Flowly did not create for it. Ask the user to switch the card to a worktree, then start it.",
        );
    }
    const release = caller.human ? () => undefined : this.cards.reserve(caller.agentId, caller.dispatcher);
    try {
      const model = await this.model(project, board, paseo);
      let workspaceId = task.workspaceId;
      const warnings: string[] = [];
      // After the limit and the model, so a refused start makes no branch and keeps no request.
      if (move) {
        const request = await this.worktreeRequest(task, project, board, operationId);
        const moved = await this.toWorktree(caller, task, project, workspace, request, operationId, paseo);
        workspaceId = moved.workspaceId;
        warnings.push(...moved.warnings);
      }
      const agentId = await this.createSession(caller, task, workspaceId, model, input.prompt, operationId, paseo);
      return { taskId: task.id, workspaceId, agentId, replayed: false, ...(warnings.length ? { warnings } : {}) };
    } catch (e) {
      release();
      throw e;
    }
  }

  /**
   * The worktree request (§4.1): the one this operation already sent, else the Linear branch (checked
   * out when it exists locally or only on origin and no worktree has it), else a generated one.
   */
  private async worktreeRequest(task: Task, project: Project, board: Board, operationId: string): Promise<WorktreeRequest> {
    // An unreadable kept request is left on disk and refuses this key; it never becomes a new request.
    const unreadable = (e: unknown) => {
      logFailure("Flowly start_card kept worktree request unreadable:", e, `card ${task.id} operation ${operationId}`);
      return new ToolError("START_FAILED", "The worktree request kept for this idempotencyKey is unreadable. Use a new idempotencyKey.");
    };
    let kept: unknown;
    try {
      kept = await this.deps.keptWorktree(operationId);
    } catch (e) {
      throw unreadable(e);
    }
    if (kept !== null) {
      const parsed = worktreeRequestSchema.safeParse(kept);
      if (!parsed.success) throw unreadable(parsed.error);
      return parsed.data;
    }
    const root = project.primaryPath;
    let base: string;
    try {
      base = await resolveWorktreeBaseRef(root, "");
    } catch (e) {
      throw new ToolError("NEEDS_WORKTREE", `Flowly cannot make a worktree for this project: ${errorText(e)}`);
    }
    const generated = generatedBranchName(task.title, operationId);
    const wanted = await linearBranchFor(task, board, this.connectors);
    const branchOff = (branchName: string): BranchSource => ({ action: "branch-off", refName: base, branchName });
    let source = branchOff(wanted ?? generated);
    if (wanted) {
      const local = await refExists(root, `refs/heads/${wanted}`);
      if (local) {
        const taken = await checkedOutBranches(root).catch(() => null);
        source = taken && !taken.has(wanted) ? { action: "checkout", refName: wanted } : branchOff(generated);
      } else if (await refExists(root, `refs/remotes/origin/${wanted}`)) {
        // Only on the remote: a local branch tracking it, which nothing has checked out yet.
        try {
          await execute("git", ["-C", root, "branch", "--track", wanted, `origin/${wanted}`], { timeout: 10000 });
          source = { action: "checkout", refName: wanted };
        } catch (e) {
          logFailure("Flowly start_card tracking branch not made:", e, `card ${task.id}`);
          source = branchOff(generated);
        }
      }
    }
    const request: WorktreeRequest = {
      title: task.title,
      idempotencyKey: `flowly-start:${operationId}`,
      source: { kind: "worktree", cwd: root, projectId: project.paseoProjectId, ...source },
    };
    await this.deps.keepWorktree(operationId, request);
    return request;
  }

  /** The New task defaults: project model, else global, else the project's latest session (§5). */
  private async model(project: Project, board: Board, paseo: PaseoApi) {
    const chosen = effectiveAgentModel(project, await this.modelDefault().catch(() => null))?.model ?? null;
    let last: ReturnType<typeof lastSessionSettings> = null;
    if (!chosen?.mode) {
      const agents: Parameters<typeof lastSessionSettings>[0][number][] = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries)
          agents.push({
            workspaceId: agent.workspaceId,
            archivedAt: agent.archivedAt,
            createdAt: agent.createdAt,
            provider: agent.provider,
            model: agent.model,
            currentModeId: agent.currentModeId,
            thinkingOptionId: agent.thinkingOptionId,
            features: agent.features,
          });
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      last = lastSessionSettings(agents, new Set(board.tasks.filter((t) => t.projectId === project.id).map((t) => t.workspaceId)));
    }
    const start = startingAgent(last, chosen);
    if (!start?.provider || !start.model)
      throw new ToolError("MODEL_UNAVAILABLE", "No model to start with: the user has no default model in Flowly settings and the project has no earlier session. Ask the user to choose one.");
    return { provider: start.provider, model: start.model, mode: start.mode || suggestedMode(providerBase(start.provider)), thinking: start.thinking || "" };
  }

  /** Creates the worktree, moves the card to it, then archives the empty directory workspace (§4.1–4.3). */
  private async toWorktree(caller: CardCaller, task: Task, project: Project, workspace: Workspace, request: WorktreeRequest, operationId: string, paseo: PaseoApi) {
    const old = task.workspaceId;
    const branch = request.source.action === "checkout" ? request.source.refName : request.source.branchName;
    let created: { id: string };
    try {
      created = await paseo.workspaces.create(request);
    } catch (e) {
      // Paseo may have made it anyway; the same idempotencyKey sends the same request again.
      logFailure("Flowly start_card worktree not created:", e, `card ${task.id} operation ${operationId}`);
      throw new ToolError("START_FAILED", `Paseo did not create the worktree: ${errorText(e)}. Retry with the same idempotencyKey.`);
    }
    // The same key may give back a worktree an earlier refusal archived (or one since removed): never bind it.
    let made: Awaited<ReturnType<ReturnType<PaseoApi["workspaces"]["ref"]>["refresh"]>>;
    try {
      made = await paseo.workspaces.ref(created.id).refresh();
    } catch (e) {
      logFailure("Flowly start_card worktree not checked:", e, `card ${task.id} worktree ${created.id}`);
      throw new ToolError("START_FAILED", `Flowly could not check worktree workspace ${created.id}; the card was not moved. Retry with the same idempotencyKey.`);
    }
    if (!made || made.archivingAt)
      throw new ToolError("START_FAILED", `Paseo returned worktree workspace ${created.id} for this idempotencyKey, but it is archived or gone; the card was not moved. Use a new idempotencyKey.`);
    // A session started in the directory workspace meanwhile (the drawer's Start session) keeps the card there (§4.2).
    const meanwhile = await workspaceSessions(paseo, old, true).catch((e: unknown) => e);
    if (!Array.isArray(meanwhile)) {
      logFailure("Flowly start_card card not moved:", meanwhile, `card ${task.id} worktree ${created.id}`);
      throw new ToolError("START_FAILED", `Flowly could not check the card's directory workspace for sessions; the card was not moved. Retry with the same idempotencyKey.`);
    }
    if (meanwhile.length) {
      const problem = await this.archive(paseo, created.id);
      logFailure("Flowly start_card worktree not used:", new Error(`a session started in the directory workspace${problem ? `; not archived: ${problem}` : ""}`), `card ${task.id} worktree ${created.id}`);
      throw new ToolError("CARD_HAS_SESSION", `A session started on the card meanwhile (${meanwhile[0].id}); the card stays where it is. Send that session instructions instead.`);
    }
    const now = new Date().toISOString();
    type Rebind = { shared: boolean } | { refused: string; referenced: boolean };
    let rebind: Rebind;
    try {
      rebind = await this.store.transaction<Rebind>((board) => {
        const t = board.tasks.find((x) => x.id === task.id);
        const referenced = () => board.tasks.some((x) => cardWorkspaceIds(x).includes(created.id));
        if (!t || t.archivedAt || finished(t.status) || t.workspaceId !== old)
          return { value: { refused: "The card changed while its worktree was made; it was not moved.", referenced: referenced() }, changed: false };
        if (board.tasks.some((x) => x.workspaceId === created.id))
          return { value: { refused: `Workspace ${created.id} is already bound to another card; the card was not moved.`, referenced: true }, changed: false };
        t.previousWorkspaces = [
          ...(t.previousWorkspaces || []),
          { id: old, kind: workspace.workspaceKind || "directory", directory: workspace.workspaceDirectory || project.primaryPath, switchedAt: now },
        ].slice(-switchLimits.previousWorkspaces);
        t.workspaceId = created.id;
        t.ownsWorkspace = true;
        t.revision++;
        t.updatedAt = now;
        this.store.event(board, {
          taskId: t.id,
          ...(caller.human ? { actor: "human" as const } : { actor: "agent" as const, agentId: caller.agentId }),
          action: "workspace_switched",
          note: `directory → worktree ${branch}`,
        });
        // Live or archived, current or earlier: a workspace another card refers to is never archived (§4.3).
        return { value: { shared: board.tasks.some((x) => x.id !== t.id && cardWorkspaceIds(x).includes(old)) }, changed: true };
      });
    } catch (e) {
      logFailure("Flowly start_card card not moved:", e, `card ${task.id} worktree ${created.id}`);
      throw e;
    }
    if ("refused" in rebind) {
      // The unused worktree is archived as when a session started meanwhile, unless a card refers to it or it has a session (§4.2).
      let kept = rebind.referenced ? "a card refers to it" : "";
      if (!kept) {
        const used = await workspaceSessions(paseo, created.id, true).catch(() => null);
        kept = !used ? "its sessions could not be read" : used.length ? "it has a session" : await this.archive(paseo, created.id);
      }
      logFailure("Flowly start_card card not moved:", new Error(`${rebind.refused}${kept ? ` Worktree kept: ${kept}.` : " Worktree archived."}`), `card ${task.id} worktree ${created.id}`);
      throw new ToolError("START_FAILED", `${rebind.refused} ${kept ? `Worktree workspace ${created.id} was kept (${kept}).` : `The unused worktree workspace ${created.id} was archived.`}`);
    }
    const shared = rebind.shared;
    // Archived only while it still never had a session and no other card refers to it (§4.3).
    const warnings: string[] = [];
    const after = shared ? null : await workspaceSessions(paseo, old, true).catch(() => null);
    let problem = "";
    if (shared) warnings.push(`The earlier directory workspace ${old} was kept: another card refers to it.`);
    else if (!after) problem = "its sessions could not be read";
    else if (after.length) warnings.push(`The earlier directory workspace ${old} got a session meanwhile and was kept.`);
    else problem = await this.archive(paseo, old);
    if (problem) {
      logFailure("Flowly start_card directory workspace not archived:", new Error(problem), `card ${task.id} workspace ${old}`);
      warnings.push(`The earlier directory workspace ${old} was not archived (${problem}); archive it in Paseo.`);
    }
    return { workspaceId: created.id, warnings };
  }

  /** Archives a workspace; "" when Paseo archived it, else the reason. */
  private async archive(paseo: PaseoApi, workspaceId: string) {
    try {
      const result = await paseo.workspaces.archive(workspaceId);
      return result.error || (result.archivedAt ? "" : "no reason given");
    } catch (e) {
      return errorText(e);
    }
  }

  /** The drawer's Start session from the daemon (`launchKanbanSession`); a lost response never creates a second session. */
  private async createSession(
    caller: CardCaller,
    task: Task,
    workspaceId: string,
    model: { provider: string; model: string; mode: string; thinking: string },
    prompt: string | undefined,
    operationId: string,
    paseo: PaseoApi,
  ) {
    const preparation = await this.deps.prepare(task.id, operationId, paseo);
    const existing = async () => {
      const found = await paseo.agents.ref(preparation.agentId).refresh();
      return found?.agent && found.agent.workspaceId === workspaceId && !found.agent.archivedAt ? found.agent.id : null;
    };
    const first = (prompt?.trim() || [task.title, task.description.trim()].filter(Boolean).join("\n\n")).trim();
    try {
      const created = await paseo.workspaces.ref(workspaceId).agents.create({
        agentId: preparation.agentId,
        idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
        config: {
          provider: `${model.provider}/${model.model}`,
          systemPrompt: preparation.instructions,
          mcpServers: { flowly: preparation.mcp },
          ...(model.mode ? { modeId: model.mode } : {}),
          ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
        },
        env: { FLOWLY_CONTEXT_FILE: preparation.contextFile, FLOWLY_CLI: preparation.cliPath, FLOWLY_SKILL: preparation.skillPath },
        title: task.title,
        labels: { "flowly-task": task.id, "flowly-started-by": caller.agentId },
        prompt: first,
      });
      return created.id;
    } catch (e) {
      const found = await existing().catch(() => null);
      if (found) return found;
      throw new ToolError("START_FAILED", `Paseo did not start the session: ${errorText(e)}`);
    }
  }
}
