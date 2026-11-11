import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, ArtifactPlan, Board } from "../shared/model";
import { absoluteTarget } from "../shared/artifacts";
import { planApproved, planOf, planRequestFacts, planTitle } from "../shared/plans";
import type { CardPlan } from "../shared/tools";
import { liveCard, normalizeTarget, planCopyFolder, putArtifact, type ArtifactService } from "./artifacts";
import { logFailure } from "./error-report";
import type { BoardStore } from "./store";
import { writePrivate } from "./tool-context";

/**
 * A card's plan (CARD-PLAN-SPEC): one artifact of the card marked with `plan`. Every writer goes
 * through `setPlan`, `approvePlan` and `clearPlan`, inside a store transaction (§1.1, §3).
 */

/** The plan as `flowly_get_task` and `flowly_set_plan` return it (§5.3). */
export function cardPlanView(plan: Artifact, workspace: string, missing: boolean): CardPlan {
  return {
    artifactId: plan.id,
    target: plan.target,
    ...(plan.kind === "file" ? { absolutePath: absoluteTarget(plan.target, workspace) } : {}),
    title: plan.title,
    approved: planApproved(plan),
    approvedAt: plan.plan?.approvedAt ?? null,
    ...(plan.plan?.approvedBy ? { approvedBy: { ...plan.plan.approvedBy } } : {}),
    source: plan.plan?.source ?? "manual",
    missing,
  };
}

/** Who sets or approves a plan: a person (plan-mode approvals too: the user approved it) or an agent's tool call (§1.3). */
export type PlanBy = { kind: "human" } | { kind: "agent"; agentId: string };

export type SetPlanInput = {
  taskId: string;
  kind: Artifact["kind"];
  /** Already normalized (`normalizeTarget`). */
  target: string;
  title?: string;
  approved: boolean;
  by: PlanBy;
  source: ArtifactPlan["source"];
};

const actorOf = (by: PlanBy) => (by.kind === "agent" ? { actor: "agent" as const, agentId: by.agentId } : { actor: "human" as const });
const approver = (by: PlanBy): NonNullable<ArtifactPlan["approvedBy"]> => (by.kind === "agent" ? { kind: "agent", agentId: by.agentId } : { kind: "human" });

/**
 * Makes `(kind, target)` the card's plan (§3.2): the card's artifact with that target, else a new input. Any
 * earlier plan keeps everything but `plan` (§3.3). The same target that is already the plan only updates approval;
 * a plan is never un-approved. Board revision only, never the task revision (§1.3).
 */
export function setPlan(store: BoardStore, board: Board, input: SetPlanInput, now = new Date().toISOString()): { artifact: Artifact; changed: boolean } {
  const { task } = liveCard(board, input.taskId);
  const actor = actorOf(input.by);
  const current = planOf(board.artifacts, task.id);
  const existing = board.artifacts.find((a) => a.taskId === task.id && a.kind === input.kind && a.target === input.target);
  if (existing?.origin === "review-ledger") throw new Error("A review ledger can't be the plan.");
  if (existing?.external) throw new Error("An external item can't be the plan.");
  if (existing && existing === current) {
    if (!input.approved || planApproved(existing)) return { artifact: existing, changed: false };
    existing.plan = { ...existing.plan!, approvedAt: now, approvedBy: approver(input.by) };
    existing.updatedAt = now;
    store.event(board, { taskId: task.id, ...actor, action: "plan_approved", note: existing.title });
    return { artifact: existing, changed: true };
  }
  let artifact: Artifact;
  if (existing) {
    artifact = existing;
    // Only a person, or an agent on an agent-added artifact, renames it.
    const title = input.title?.trim();
    if (title && (input.by.kind === "human" || existing.createdBy === "agent")) artifact.title = title;
  } else {
    artifact = putArtifact(
      store,
      board,
      {
        taskId: task.id,
        role: "input",
        kind: input.kind,
        target: input.target,
        ...(input.title ? { title: input.title } : {}),
        createdBy: input.by.kind,
        ...(input.by.kind === "agent" ? { agentId: input.by.agentId } : {}),
      },
      now,
    ).artifact;
  }
  for (const other of board.artifacts)
    if (other.taskId === task.id && other.plan && other !== artifact) {
      delete other.plan;
      other.updatedAt = now;
    }
  artifact.plan = {
    approvedAt: input.approved ? now : null,
    ...(input.approved ? { approvedBy: approver(input.by) } : {}),
    source: input.source,
    setAt: now,
  };
  artifact.updatedAt = now;
  store.event(board, { taskId: task.id, ...actor, action: "plan_set", note: `${input.approved ? "Approved" : "Draft"}: ${artifact.title}` });
  return { artifact, changed: true };
}

/** Approves the card's draft plan (§5.1); an approved plan stays as it is. */
export function approvePlan(store: BoardStore, board: Board, taskId: string, by: PlanBy, now = new Date().toISOString()) {
  const { task } = liveCard(board, taskId);
  const plan = planOf(board.artifacts, task.id);
  if (!plan) throw new Error("This card has no plan.");
  if (planApproved(plan)) return { artifact: plan as Artifact, changed: false };
  plan.plan = { ...plan.plan, approvedAt: now, approvedBy: approver(by) };
  plan.updatedAt = now;
  store.event(board, { taskId: task.id, ...actorOf(by), action: "plan_approved", note: plan.title });
  return { artifact: plan as Artifact, changed: true };
}

/** Empties the slot (§3.3): the artifact stays as an ordinary input or output. No plan: no change. */
export function clearPlan(store: BoardStore, board: Board, taskId: string, by: PlanBy, now = new Date().toISOString()) {
  const { task } = liveCard(board, taskId);
  const plan = planOf(board.artifacts, task.id);
  if (!plan) return { artifact: null, changed: false };
  delete (plan as Artifact).plan;
  plan.updatedAt = now;
  store.event(board, { taskId: task.id, ...actorOf(by), action: "plan_cleared", note: plan.title });
  return { artifact: plan as Artifact, changed: true };
}

/**
 * Writes a plan's text to `<data>/plans/<taskId>/<UTC time>.md` (§1.2): folders 0700, file 0600, atomic.
 * Returns the absolute path. Copies are never deleted with the plan or the card.
 */
export async function writePlanCopy(dataDirectory: string, taskId: string, text: string, at = new Date()) {
  const folder = planCopyFolder(dataDirectory, taskId);
  await mkdir(join(dataDirectory, "plans"), { recursive: true, mode: 0o700 });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let path = join(folder, `${at.toISOString().replace(/:/g, "-")}.md`);
  // Two approvals within the same millisecond keep both copies.
  for (let n = 2; await exists(path); n++) path = join(folder, `${at.toISOString().replace(/:/g, "-")}-${n}.md`);
  await writePrivate(path, text.endsWith("\n") ? text : `${text}\n`);
  return path;
}

function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A plan-mode request seen before its answer (§4 step 1). */
export type PlanRequestEntry = { agentId: string; taskId: string; text: string; path: string | null; at: number };

const maxEntries = 200,
  maxAge = 24 * 3600 * 1000;

/**
 * Plan-mode approvals of card sessions (§4): `before` keeps each plan request by id, `after` applies an allowed one.
 * In memory only: a request raised before a plugin reload is not known after it. Never throws.
 */
export class PlanModeWatcher {
  private entries = new Map<string, PlanRequestEntry>();
  constructor(
    private apply: (entry: PlanRequestEntry) => Promise<void>,
    private clock = () => Date.now(),
  ) {}

  /** `identity`: the managed card session, or null for any other session (never captured). */
  before(identity: { agentId: string; taskId: string } | null, request: { id: string; kind: string; input?: Record<string, unknown> | null; metadata?: Record<string, unknown> | null }) {
    try {
      if (!identity || request.kind !== "plan") return;
      const now = this.clock();
      for (const [id, entry] of this.entries) if (now - entry.at > maxAge) this.entries.delete(id);
      const { text, path } = planRequestFacts(request);
      this.entries.delete(request.id);
      this.entries.set(request.id, { agentId: identity.agentId, taskId: identity.taskId, text, path, at: now });
      // The oldest go first past the cap (a Map keeps insertion order).
      while (this.entries.size > maxEntries) this.entries.delete(this.entries.keys().next().value!);
    } catch (e) {
      logFailure("Flowly plan request not kept:", e, request?.id);
    }
  }

  /** The answer to a request: an allowed plan request of the same session sets the card's plan; either way it is forgotten. */
  async after(agentId: string, requestId: string, resolution: { behavior: string }) {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    this.entries.delete(requestId);
    if (entry.agentId !== agentId || resolution.behavior !== "allow" || this.clock() - entry.at > maxAge) return;
    try {
      await this.apply(entry);
    } catch (e) {
      logFailure("Flowly plan from plan mode not set:", e, `card ${entry.taskId} request ${requestId}`);
    }
  }

  /** For tests: how many requests are kept. */
  get size() {
    return this.entries.size;
  }
}

type Paseo = Parameters<ArtifactService["where"]>[1];

/** The plan as the RPCs return it: the artifact, or null (§5.1). */
const copy = (a: Artifact | null) => (a ? { ...a, ...(a.plan ? { plan: { ...a.plan } } : {}) } : null);

/** Human RPCs `plans.set`, `plans.approve`, `plans.clear` (§5.1) and the plan-mode capture (§4). */
export class PlanService {
  constructor(
    readonly store: BoardStore,
    readonly artifacts: ArtifactService,
  ) {}

  async set(input: { taskId: string; target: string; title?: string }, paseo: Paseo) {
    const { kind, target } = await normalizeTarget(input.target, await this.artifacts.where(input.taskId, paseo));
    return this.store.transaction((board) => {
      const result = setPlan(this.store, board, { taskId: input.taskId, kind, target, title: input.title, approved: true, by: { kind: "human" }, source: "manual" });
      return { value: copy(result.artifact)!, changed: result.changed };
    });
  }

  approve(input: { taskId: string }) {
    return this.store.transaction((board) => {
      const result = approvePlan(this.store, board, input.taskId, { kind: "human" });
      return { value: copy(result.artifact)!, changed: result.changed };
    });
  }

  clear(input: { taskId: string }) {
    return this.store.transaction((board) => {
      const result = clearPlan(this.store, board, input.taskId, { kind: "human" });
      return { value: null, changed: result.changed };
    });
  }

  /**
   * An approved plan-mode request (§4 step 2): its file when it passes the card's target rules, else its text
   * saved as a plan copy; neither sets nothing (logged).
   */
  async fromPlanMode(entry: PlanRequestEntry, paseo: Paseo) {
    const where = await this.artifacts.where(entry.taskId, paseo);
    let found: Awaited<ReturnType<typeof normalizeTarget>> | null = null;
    if (entry.path) found = await normalizeTarget(entry.path, where).catch(() => null);
    if (found?.kind !== "file") found = null;
    if (!found && entry.text.trim()) {
      const path = await writePlanCopy(this.store.directory, entry.taskId, entry.text);
      found = await normalizeTarget(path, where);
    }
    if (!found) {
      logFailure("Flowly plan from plan mode not set:", new Error("no usable plan file and no plan text"), `card ${entry.taskId}`);
      return;
    }
    const title = planTitle(entry.text, entry.path);
    const target = found;
    await this.store.transaction((board) => {
      const result = setPlan(this.store, board, { taskId: entry.taskId, kind: target.kind, target: target.target, title, approved: true, by: { kind: "human" }, source: "plan-mode" });
      return { value: undefined, changed: result.changed };
    });
  }
}
