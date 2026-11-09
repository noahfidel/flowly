import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export { startCardInputSchema, startCardResultSchema } from "../shared/tools";

const execute = promisify(execFile);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const finished = (status: string) => status === "done" || status === "cancelled";
/** Worktree requests kept for retries (§4.1); older ones are dropped. */
const KEPT_SOURCES = 200;

type WorktreeSource = { action: "branch-off"; refName: string; branchName: string } | { action: "checkout"; refName: string };
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

async function branchExists(root: string, name: string) {
  try {
    await execute("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${name}`], { timeout: 10000 });
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
};

/**
 * flowly_start_card (START-CARD-SPEC): starts a card's session in its worktree, first moving a
 * session-less directory card Flowly created into a new worktree. One start runs at a time.
 */
export class CardStarter {
  /** Linear inputs name the worktree's branch (§6); set by the plugin entry. */
  connectors?: Pick<ConnectorService, "resolve" | "cached">;
  /** The global default model (Settings → Models); set by the plugin entry. */
  modelDefault: () => Promise<AgentModel | null> = async () => null;
  private chain: Promise<unknown> = Promise.resolve();
  private sources = new Map<string, WorktreeSource>();
  constructor(
    readonly store: BoardStore,
    readonly cards: AgentCards,
    readonly deps: StarterDeps,
  ) {}

  start(caller: CardCaller, raw: StartCardInput | unknown, paseo: PaseoApi): Promise<StartCardResult> {
    const input = startCardInputSchema.parse(raw);
    const job = this.chain.then(() => this.run(caller, input, paseo));
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async run(caller: CardCaller, input: ReturnType<typeof startCardInputSchema.parse>, paseo: PaseoApi): Promise<StartCardResult> {
    await this.cards.enabled();
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
    const live = sessions.filter((s) => !s.archived);
    if (live.length)
      throw new ToolError("CARD_HAS_SESSION", `The card already has a live session (${live[0].id}). Send it instructions instead of starting another.`);
    // Where the session runs (§4).
    const move = workspace.workspaceKind !== "worktree" && !project.links?.length;
    let source: WorktreeSource | null = null;
    if (move) {
      const owned = task.ownsWorkspace === true && !task.previousWorkspaces?.length && !task.switch;
      if (!owned || sessions.length)
        throw new ToolError(
          "NEEDS_WORKTREE",
          "The card works in a directory workspace that already had sessions or that Flowly did not create for it. Ask the user to switch the card to a worktree, then start it.",
        );
      source = await this.worktreeSource(task, project, board, operationId);
    }
    this.cards.checkLimit(caller.agentId);
    const model = await this.model(project, board, paseo);
    let workspaceId = task.workspaceId;
    const warnings: string[] = [];
    if (source) {
      const moved = await this.toWorktree(caller, task, project, workspace, source, operationId, paseo);
      workspaceId = moved.workspaceId;
      warnings.push(...moved.warnings);
    }
    const agentId = await this.createSession(caller, task, workspaceId, model, input.prompt, operationId, paseo);
    this.cards.countCreation(caller.agentId);
    return { taskId: task.id, workspaceId, agentId, replayed: false, ...(warnings.length ? { warnings } : {}) };
  }

  /** The worktree request: the Linear branch, checked out when it exists and is free, else a generated one (§4.1). */
  private async worktreeSource(task: Task, project: Project, board: Board, operationId: string): Promise<WorktreeSource> {
    const kept = this.sources.get(operationId);
    if (kept) return kept;
    const root = project.primaryPath;
    let base: string;
    try {
      base = await resolveWorktreeBaseRef(root, "");
    } catch (e) {
      throw new ToolError("NEEDS_WORKTREE", `Flowly cannot make a worktree for this project: ${errorText(e)}`);
    }
    const generated = generatedBranchName(task.title, operationId);
    const wanted = await linearBranchFor(task, board, this.connectors);
    let source: WorktreeSource = { action: "branch-off", refName: base, branchName: wanted ?? generated };
    if (wanted && (await branchExists(root, wanted))) {
      const taken = await checkedOutBranches(root).catch(() => null);
      source = taken && !taken.has(wanted) ? { action: "checkout", refName: wanted } : { action: "branch-off", refName: base, branchName: generated };
    }
    this.sources.set(operationId, source);
    if (this.sources.size > KEPT_SOURCES) this.sources.delete(this.sources.keys().next().value!);
    return source;
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
  private async toWorktree(caller: CardCaller, task: Task, project: Project, workspace: Workspace, source: WorktreeSource, operationId: string, paseo: PaseoApi) {
    const branch = source.action === "checkout" ? source.refName : source.branchName;
    let created: { id: string };
    try {
      created = await paseo.workspaces.create({
        title: task.title,
        idempotencyKey: `flowly-start:${operationId}`,
        source: { kind: "worktree", cwd: project.primaryPath, projectId: project.paseoProjectId, ...source },
      });
    } catch (e) {
      throw new ToolError("START_FAILED", `Paseo did not create the worktree: ${errorText(e)}`);
    }
    const now = new Date().toISOString();
    await this.store.mutate((board) => {
      const t = board.tasks.find((x) => x.id === task.id);
      if (!t || t.archivedAt || finished(t.status) || t.workspaceId !== task.workspaceId)
        throw new ToolError("START_FAILED", `The card changed while its worktree was made; it was not moved. Worktree workspace ${created.id} remains available.`);
      if (board.tasks.some((x) => x.workspaceId === created.id))
        throw new ToolError("START_FAILED", `Workspace ${created.id} is already bound to another card; the card was not moved.`);
      t.previousWorkspaces = [
        ...(t.previousWorkspaces || []),
        { id: t.workspaceId, kind: workspace.workspaceKind || "directory", directory: workspace.workspaceDirectory || project.primaryPath, switchedAt: now },
      ].slice(-switchLimits.previousWorkspaces);
      t.workspaceId = created.id;
      t.ownsWorkspace = true;
      t.revision++;
      t.updatedAt = now;
      this.store.event(board, { taskId: t.id, actor: "agent", agentId: caller.agentId, action: "workspace_switched", note: `directory → worktree ${branch}` });
    });
    // Archived only while it still never had a session (§4.3).
    const warnings: string[] = [];
    const after = await workspaceSessions(paseo, task.workspaceId, true).catch(() => null);
    if (!after) warnings.push(`The earlier directory workspace ${task.workspaceId} was not archived (its sessions could not be read); archive it in Paseo.`);
    else if (after.length) warnings.push(`The earlier directory workspace ${task.workspaceId} got a session meanwhile and was kept.`);
    else {
      const result = await paseo.workspaces.archive(task.workspaceId).catch((e: unknown) => ({ error: errorText(e), archivedAt: null }));
      if (result.error || !result.archivedAt)
        warnings.push(`The earlier directory workspace ${task.workspaceId} was not archived (${result.error || "no reason given"}); archive it in Paseo.`);
    }
    return { workspaceId: created.id, warnings };
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
