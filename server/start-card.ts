import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { branchedFromSchema, switchLimits, type Board, type Project, type Task } from "../shared/model";
import { groupOfProject } from "../shared/groups";
import { effectiveAgentModel, providerBase, startingAgent, suggestedMode, type AgentModel } from "../shared/agent-defaults";
import { linearIssueOf } from "../shared/linear-ticket";
import { absoluteTarget } from "../shared/artifacts";
import { planApproved, planOf, suggestPlanAwareMode } from "../shared/plans";
import { startCardInputSchema, type StartCardInput, type StartCardResult, type ToolPreparation, type WorktreeBase } from "../shared/tools";
import type { AgentCards, CardCaller } from "./agent-cards";
import type { ConnectorService } from "./connectors/service";
import { logFailure } from "./error-report";
import { generatedBranchName } from "./service";
import { actualBranchedFrom, dropUpstream, projectWorktreeBase, remoteBase } from "./base-ref";
import type { BoardStore } from "./store";
import { digest } from "./tool-context";
import { checkGroup, ToolError } from "./tool-error";
import { moveStartedCard } from "./start-stage";
import { workspaceSessions } from "./workspace-switch";
import { cardWorkspaceIds } from "../shared/workspace-switch";
import { baseChoiceProblem, chooseBase, openParents, rebaseLine } from "./follow-up-base";
import { addLink } from "./links";
import { archivedWorkspaceStart } from "../shared/archived-start";
import type { WorkspaceRecovery } from "./workspace-restore";

export { startCardInputSchema, startCardResultSchema } from "../shared/tools";
export { archivedWorkspaceStart };

const execute = promisify(execFile);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const finished = (status: string) => status === "done" || status === "cancelled";

/**
 * The first message when the caller gives none: the card's title and description, then its approved plan
 * (CARD-PLAN-SPEC §6.1).
 */
export function defaultPrompt(task: Pick<Task, "title" | "description">, approvedPlan: string | null) {
  return [task.title, task.description.trim(), approvedPlan ? `Approved plan: ${approvedPlan}. Execute this plan; do not plan again.` : ""].filter(Boolean).join("\n\n");
}

/** The `workspaces.create` request a start sends; kept per operation so retries send it unchanged (§4.1). */
const worktreeRequestSchema = z.object({
  title: z.string(),
  idempotencyKey: z.string(),
  source: z.union([
    z.object({ kind: z.literal("worktree"), cwd: z.string(), projectId: z.string(), action: z.literal("branch-off"), refName: z.string(), branchName: z.string() }),
    z.object({ kind: z.literal("worktree"), cwd: z.string(), projectId: z.string(), action: z.literal("checkout"), refName: z.string() }),
  ]),
});
/**
 * The request as kept per operation: the request itself plus where it branched from (START-CARD-SPEC §11.3), so a
 * retry with the same key makes the same branch and records the same base. Requests kept before §11 have no `base`.
 */
const keptRequestSchema = worktreeRequestSchema.extend({
  base: z
    .object({
      taskBaseRef: z.string(),
      from: z.enum(["explicit", "parent", "project"]),
      branchedFrom: branchedFromSchema.optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
});
type WorktreeRequest = z.infer<typeof keptRequestSchema>;
/** What the result says about a worktree a start made (§11.5). */
const worktreeBaseOf = (request: WorktreeRequest): WorktreeBase =>
  request.source.action === "checkout"
    ? { ref: request.source.refName, from: "checkout" }
    : {
        ref: request.source.refName,
        from: request.base?.from ?? "project",
        ...(request.base?.branchedFrom ? { parentTaskId: request.base.branchedFrom.taskId, ahead: request.base.branchedFrom.ahead } : {}),
      };
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
  const input = linearIssueOf(board.artifacts, task.id);
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
  /** Brings a card's own workspace back when it was archived outside Flowly (START-CARD-SPEC "Archived own workspace at start"). */
  recovery: WorkspaceRecovery;
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
    const baseProblem = baseChoiceProblem(input.baseRef);
    if (baseProblem) throw new ToolError("BASE_INVALID", baseProblem);
    const board = await this.store.read();
    const project = board.projects.find((p) => p.id === caller.projectId);
    if (!project) throw new ToolError("NOT_FOUND", "The Flowly project was removed.");
    if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The Flowly project is archived.");
    // A dispatcher's start (`caller.groupId`): checked here, again when the card moves to its worktree, and before
    // the session is made (DISPATCHER-SPEC §4).
    checkGroup(project, caller.groupId);
    const task = board.tasks.find((t) => t.id === input.taskId && t.projectId === project.id);
    if (!task || task.archivedAt) throw new ToolError("NOT_FOUND", "No live card with that id in this project. Use an id from flowly_list_cards.");
    if (finished(task.status)) throw new ToolError("CARD_FINISHED", "The card is Done or Cancelled; only the user reopens it.");
    const operationId = `start-card:${digest(JSON.stringify([task.id, caller.agentId, input.idempotencyKey]))}`;
    // A retry after a lost response: the session this operation prepared, still in the card's workspace (§3 step 4).
    const prior = await this.deps.preparedFor(operationId);
    if (prior && prior.taskId === task.id && prior.workspaceId === task.workspaceId) {
      const found = await paseo.agents.ref(prior.agentId).refresh().catch(() => null);
      if (found?.agent && found.agent.workspaceId === task.workspaceId && !found.agent.archivedAt) {
        // The worktree this operation made, when it made one, is reported again (§11.5).
        const kept = keptRequestSchema.safeParse(await this.deps.keptWorktree(operationId).catch(() => null));
        const base = kept.success ? worktreeBaseOf(kept.data) : undefined;
        return { taskId: task.id, workspaceId: task.workspaceId, agentId: prior.agentId, replayed: true, ...(base ? { base } : {}) };
      }
    }
    let workspace = await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null);
    if (workspace?.archivingAt) throw new ToolError("RESOURCE_UNAVAILABLE", "The card's workspace is being archived.");
    if (!workspace) {
      await this.restoreOwn(caller, task, paseo);
      workspace = await paseo.workspaces.ref(task.workspaceId).refresh().catch(() => null);
      if (!workspace || workspace.archivingAt) throw new ToolError("RESOURCE_UNAVAILABLE", "The card's workspace is unavailable or being archived.");
    }
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
      const defaults = await this.model(project, board);
      // A card's plan (CARD-PLAN-SPEC §6.1), apart from how the defaults are chosen: an explicit mode is checked,
      // otherwise an approved plan keeps the session out of plan mode.
      const plan = planOf(board.artifacts, task.id);
      const approvedPlan = planApproved(plan) ? plan : null;
      const model = { ...defaults, mode: await this.planAwareMode(defaults, input.mode, !!approvedPlan, workspace.workspaceDirectory || project.primaryPath, paseo) };
      // The plan file as it exists now; a worktree made below may not have an untracked plan.
      const planTarget = approvedPlan ? (approvedPlan.kind === "file" ? absoluteTarget(approvedPlan.target, workspace.workspaceDirectory || task.sourcePath) : approvedPlan.target) : null;
      let workspaceId = task.workspaceId;
      const warnings: string[] = [];
      let base: WorktreeBase | undefined;
      // After the limit and the model, so a refused start makes no branch and keeps no request.
      if (move) {
        const request = await this.worktreeRequest(caller, task, project, board, operationId, input.baseRef, paseo);
        const moved = await this.toWorktree(caller, task, project, workspace, request, operationId, paseo);
        workspaceId = moved.workspaceId;
        warnings.push(...(request.base?.warnings ?? []), ...moved.warnings);
        base = worktreeBaseOf(request);
        if (request.source.action === "checkout" && input.baseRef !== undefined)
          warnings.push(`baseRef was ignored: the card's Linear branch ${request.source.refName} was checked out.`);
      } else {
        // A retry after the session failed to start: the card already moved to the worktree this operation made.
        const kept = keptRequestSchema.safeParse(await this.deps.keptWorktree(operationId).catch(() => null));
        if (kept.success && workspace.workspaceKind === "worktree") base = worktreeBaseOf(kept.data);
        else if (input.baseRef !== undefined) warnings.push("baseRef was ignored: the card already has its workspace, so no worktree was made.");
      }
      const after = await this.store.read();
      checkGroup(after.projects.find((p) => p.id === project.id), caller.groupId);
      const own = input.prompt?.trim() ? input.prompt : defaultPrompt(task, planTarget);
      const started = after.tasks.find((t) => t.id === task.id);
      // A card branched from its parent's branch is told how to land (§11.4), also after a caller's own prompt: at its
      // first session, whether the worktree was made now, by flowly_create_card, or by an earlier try of this start.
      const firstSession = move || !sessions.length;
      const branched = firstSession && started?.branchedFrom && started.workspaceId === workspaceId ? started.branchedFrom : null;
      const prompt = branched
        ? `${own}\n\n${rebaseLine(branched, after.tasks.find((t) => t.id === branched.taskId)?.title ?? branched.taskId, started?.baseRef ?? "")}`
        : own;
      const agentId = await this.createSession(caller, task, workspaceId, model, prompt, operationId, paseo);
      // Only once the session exists, so a failed start leaves the card where it was.
      await moveStartedCard(this.store, task.id).catch((e) => logFailure("Flowly start_card card not moved out of Backlog:", e, `card ${task.id}`));
      return { taskId: task.id, workspaceId, agentId, replayed: false, ...(warnings.length ? { warnings } : {}), ...(base ? { base } : {}) };
    } catch (e) {
      release();
      throw e;
    }
  }

  /**
   * The card's workspace is gone from Paseo: bring a workspace Flowly made for the card back (same workspace id),
   * or refuse with WORKSPACE_ARCHIVED.
   */
  private async restoreOwn(caller: CardCaller, task: Task, paseo: PaseoApi) {
    const rule = archivedWorkspaceStart(task);
    if (!rule.restorable)
      throw new ToolError(
        "WORKSPACE_ARCHIVED",
        `${rule.reason} ${caller.human ? "Use Switch to worktree on the card, then start again." : "Ask the user to switch the card to a worktree, then start it."}`,
      );
    let conn: Awaited<ReturnType<WorkspaceRecovery["connect"]>>;
    try {
      conn = await this.deps.recovery.connect();
    } catch (e) {
      logFailure("Flowly start_card workspace recovery not reached:", e, `card ${task.id}`);
      throw new ToolError("WORKSPACE_ARCHIVED", `The card's workspace is archived and Paseo could not be asked to restore it: ${errorText(e)}`);
    }
    try {
      const state = await conn.inspect(task.workspaceId);
      if (state.kind !== "recoverable")
        throw new ToolError("WORKSPACE_ARCHIVED", `The card's workspace is archived and Paseo cannot restore it: ${state.message || state.reason}`);
      await conn.restore(task.workspaceId);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      logFailure("Flowly start_card workspace not restored:", e, `card ${task.id} workspace ${task.workspaceId}`);
      throw new ToolError("WORKSPACE_ARCHIVED", `Paseo did not restore the card's archived workspace: ${errorText(e)}`);
    } finally {
      await conn.close();
    }
    await this.store
      .mutate((board) => {
        if (board.tasks.some((t) => t.id === task.id))
          this.store.event(board, { taskId: task.id, actor: "system", action: "workspace_restored", note: "Archived outside Flowly; restored to start the card." });
      })
      .catch((e) => logFailure("Flowly start_card restore event not recorded:", e, `card ${task.id}`));
  }

  /**
   * The worktree request (§4.1): the one this operation already sent, else the Linear branch (checked
   * out when it exists locally or only on origin and no worktree has it), else a generated one.
   */
  private async worktreeRequest(
    caller: CardCaller,
    task: Task,
    project: Project,
    board: Board,
    operationId: string,
    explicit: string | undefined,
    paseo: PaseoApi,
  ): Promise<WorktreeRequest> {
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
      const parsed = keptRequestSchema.safeParse(kept);
      if (!parsed.success) throw unreadable(parsed.error);
      return parsed.data;
    }
    const root = project.primaryPath;
    // Resolved once, and only when needed: an explicit branch that is not a parent's does not depend on it.
    let resolved: Promise<string> | null = null;
    const projectBase = () =>
      (resolved ??= projectWorktreeBase(root, project.baseRef, "").catch((e: unknown) => {
        throw new ToolError("NEEDS_WORKTREE", `Flowly cannot make a worktree for this project: ${errorText(e)}`);
      }));
    // The root must be able to make a worktree before a Linear branch is tracked (§4.1); an explicit branch that is
    // not a parent's does not need the project's base.
    if (!explicit || explicit.trim() === "parent") await projectBase();
    const generated = generatedBranchName(task.title, operationId);
    const wanted = await linearBranchFor(task, board, this.connectors);
    // Where a new branch starts (§11.3), decided once and only for a branch-off; a Linear checkout wins.
    let choice: Awaited<ReturnType<typeof chooseBase>> | null = null;
    const decide = async () =>
      (choice ??= await chooseBase({ project, root, parents: openParents(board, task.id), explicit, human: caller.human, projectBase, paseo }));
    const branchOff = async (branchName: string): Promise<BranchSource> => ({ action: "branch-off", refName: (await decide()).refName, branchName });
    let source: BranchSource | null = null;
    if (wanted) {
      const local = await refExists(root, `refs/heads/${wanted}`);
      if (local) {
        const taken = await checkedOutBranches(root).catch(() => null);
        source = taken && !taken.has(wanted) ? { action: "checkout", refName: wanted } : await branchOff(generated);
      } else if (await refExists(root, `refs/remotes/origin/${wanted}`)) {
        // Only on the remote: a local branch tracking it, which nothing has checked out yet.
        try {
          await execute("git", ["-C", root, "branch", "--track", wanted, `origin/${wanted}`], { timeout: 10000 });
          source = { action: "checkout", refName: wanted };
        } catch (e) {
          logFailure("Flowly start_card tracking branch not made:", e, `card ${task.id}`);
          source = await branchOff(generated);
        }
      }
    }
    source ??= await branchOff(wanted ?? generated);
    const decided = choice as Awaited<ReturnType<typeof chooseBase>> | null;
    const request: WorktreeRequest = {
      title: task.title,
      idempotencyKey: `flowly-start:${operationId}`,
      source: { kind: "worktree", cwd: root, projectId: project.paseoProjectId, ...source },
      ...(source.action === "branch-off" && decided
        ? {
            base: {
              taskBaseRef: decided.taskBaseRef,
              from: decided.from,
              ...(decided.branchedFrom ? { branchedFrom: decided.branchedFrom } : {}),
              ...(decided.warnings.length ? { warnings: decided.warnings } : {}),
            },
          }
        : {}),
    };
    await this.deps.keepWorktree(operationId, request);
    return request;
  }

  /** The New task defaults: the project's model, else its group's, else the global one; never an earlier session (§5). */
  private async model(project: Project, board: Board) {
    const start = startingAgent(effectiveAgentModel(project, groupOfProject(board, project), await this.modelDefault().catch(() => null))?.model ?? null);
    if (!start)
      throw new ToolError("MODEL_UNAVAILABLE", "No model to start with: no default model is set for this project, its group or globally. Ask the user to set one in Settings → Models (or the project's Default model).");
    return { provider: start.provider, model: start.model, mode: start.mode || suggestedMode(providerBase(start.provider)), thinking: start.thinking };
  }

  /**
   * The session's mode after the defaults (CARD-PLAN-SPEC §6, §6.1): an explicit `mode` must be one of the provider's
   * modes for the card's directory when Paseo lists them (MODE_UNAVAILABLE), and is passed as given when the list
   * can't be read; otherwise `suggestPlanAwareMode`.
   */
  private async planAwareMode(defaults: { provider: string; mode: string }, explicit: string | undefined, approvedPlan: boolean, cwd: string, paseo: PaseoApi) {
    if (explicit !== undefined) {
      let ids: string[] | null = null;
      try {
        const listed = await paseo.providers.listModes(defaults.provider as Parameters<PaseoApi["providers"]["listModes"]>[0], { cwd });
        if (!listed.error && listed.modes?.length) ids = listed.modes.map((m) => m.id);
      } catch {
        ids = null;
      }
      if (ids && !ids.includes(explicit))
        throw new ToolError("MODE_UNAVAILABLE", `${explicit} is not a mode of ${defaults.provider} here. Use one of: ${ids.join(", ")}.`);
    }
    return suggestPlanAwareMode({ resolved: defaults.mode, explicit, approvedPlan, suggested: suggestedMode(providerBase(defaults.provider)) });
  }

  /** Creates the worktree, moves the card to it, then archives the empty directory workspace (§4.1–4.3). */
  private async toWorktree(caller: CardCaller, task: Task, project: Project, workspace: Workspace, request: WorktreeRequest, operationId: string, paseo: PaseoApi) {
    const old = task.workspaceId;
    const branch = request.source.action === "checkout" ? request.source.refName : request.source.branchName;
    let created: { id: string };
    try {
      // Paseo gets the request only; the kept base stays Flowly's (§11.3).
      created = await paseo.workspaces.create({ title: request.title, idempotencyKey: request.idempotencyKey, source: request.source });
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
    // A branch made from a remote base never tracks it (§4.1).
    if (request.source.action === "branch-off" && remoteBase(request.source.refName)) await dropUpstream(made.workspaceDirectory, request.source.refName);
    // The commit the worktree really branched from: the parent may have moved since the decision (§11.4).
    const measured = request.source.action === "branch-off" ? request.base?.branchedFrom : undefined;
    const branchedFrom = measured && request.base ? await actualBranchedFrom(made.workspaceDirectory, request.base.taskBaseRef, measured) : undefined;
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
    type Rebind = { shared: boolean } | { refused: string; referenced: boolean; code?: string };
    let rebind: Rebind;
    try {
      rebind = await this.store.transaction<Rebind>((board) => {
        const t = board.tasks.find((x) => x.id === task.id);
        const referenced = () => board.tasks.some((x) => cardWorkspaceIds(x).includes(created.id));
        if (!t || t.archivedAt || finished(t.status) || t.workspaceId !== old)
          return { value: { refused: "The card changed while its worktree was made; it was not moved.", referenced: referenced() }, changed: false };
        if (caller.groupId !== undefined && board.projects.find((p) => p.id === t.projectId)?.groupId !== caller.groupId)
          return {
            value: { refused: "The card's project moved to another board group while its worktree was made; it was not moved.", referenced: referenced(), code: "PROJECT_OUT_OF_GROUP" },
            changed: false,
          };
        if (board.tasks.some((x) => x.workspaceId === created.id))
          return { value: { refused: `Workspace ${created.id} is already bound to another card; the card was not moved.`, referenced: true }, changed: false };
        t.previousWorkspaces = [
          ...(t.previousWorkspaces || []),
          { id: old, kind: workspace.workspaceKind || "directory", directory: workspace.workspaceDirectory || project.primaryPath, switchedAt: now },
        ].slice(-switchLimits.previousWorkspaces);
        t.workspaceId = created.id;
        t.ownsWorkspace = true;
        // Where the card lands and its own change starts, as for a card created in a worktree (GUARDRAILS-SPEC §6.2):
        // the project base, also when it branched from its parent's branch (§11.4).
        if (request.source.action === "branch-off") t.baseRef = request.base?.taskBaseRef ?? request.source.refName;
        else delete t.baseRef;
        if (branchedFrom) {
          t.branchedFrom = branchedFrom;
          // The parent lands first (§11.4); an existing link stays, a cycle adds nothing.
          try {
            addLink(this.store, board, { kind: "blocks", from: branchedFrom.taskId, to: t.id, createdBy: "system" }, { events: false });
          } catch (e) {
            logFailure("Flowly start_card blocks link not added:", e, `card ${t.id} parent ${branchedFrom.taskId}`);
          }
        } else delete t.branchedFrom;
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
      throw new ToolError(rebind.code ?? "START_FAILED", `${rebind.refused} ${kept ? `Worktree workspace ${created.id} was kept (${kept}).` : `The unused worktree workspace ${created.id} was archived.`}`);
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
    prompt: string,
    operationId: string,
    paseo: PaseoApi,
  ) {
    const preparation = await this.deps.prepare(task.id, operationId, paseo);
    const existing = async () => {
      const found = await paseo.agents.ref(preparation.agentId).refresh();
      return found?.agent && found.agent.workspaceId === workspaceId && !found.agent.archivedAt ? found.agent.id : null;
    };
    const first = prompt.trim();
    try {
      const created = await paseo.workspaces.ref(workspaceId).agents.create({
        agentId: preparation.agentId,
        idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
        config: {
          provider: `${model.provider}/${model.model}`,
          systemPrompt: preparation.instructions,
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
