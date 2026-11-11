import type { PaseoApi } from "@getpaseo/client";
import type { Board, Project, Task } from "../shared/model";
import {
  PR_REVIEW_LABEL,
  PR_REVIEW_TAG,
  parsePrReviewLabel,
  prReviewCard,
  prReviewCardKey,
  isPrReviewCard,
  prKey,
  prReviewOperationId,
  prReviewStatus,
  type PrRef,
} from "../shared/pr-review";
import { cardWorkspaceIds } from "../shared/workspace-switch";
import { switchLimits } from "../shared/model";
import { columnEnd } from "../shared/group-order";
import type { BoardService } from "./service";
import { repoMatcher } from "./repos";

/** Only agents this young become cards, so nothing older is backfilled (PR-REVIEW-CARDS-SPEC §3). */
export const prReviewWindowMs = 30 * 60 * 1000;

/** What the watcher needs of a Paseo agent record. */
export type PrReviewAgent = {
  id: string;
  workspaceId?: string | null;
  title: string | null;
  labels?: Readonly<Record<string, string>> | null;
  createdAt?: string | null;
  archivedAt?: string | null;
};

export type PrReviewOutcome =
  | { kind: "created"; task: Task }
  | { kind: "reused"; task: Task }
  | { kind: "skipped"; reason: "off" | "not-review" | "no-workspace" | "archived" | "old" | "bound" | "workspace-gone" | "no-project" };

/** The live project whose repository holds the workspace: the Paseo project's own first, then the deepest root (§2). */
export async function prReviewProject(board: Board, directory: string, paseoProjectId: string | null): Promise<Project | null> {
  const live = board.projects.filter((p) => !p.archivedAt);
  const matched = await repoMatcher(live.map((p) => p.primaryPath))(directory);
  if (!matched.length) return null;
  const candidates = live.filter((p) => matched.includes(p.primaryPath));
  return (
    candidates.find((p) => p.paseoProjectId === paseoProjectId) ??
    candidates.sort((a, b) => b.primaryPath.length - a.primaryPath.length)[0] ??
    null
  );
}

/**
 * Makes a Flowly card for each new PR review agent (PR-REVIEW-CARDS-SPEC): the card is bound to the agent's own
 * workspace through the New card "existing workspace" path, so no workspace is created and the agent is its session.
 */
export class PrReviewCards {
  /** Agents already read in this plugin run; a reload starts empty, the operation id keeps it idempotent. */
  private seen = new Set<string>();
  private loggedNoProject = false;
  /** The Make cards for PR review agents setting; set by the plugin entry. */
  enabled: () => Promise<boolean> = async () => true;
  constructor(
    readonly service: BoardService,
    readonly clock = () => Date.now(),
    readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  /** From a lifecycle hook: reads the agent (labels are not on the hook event) at most once per plugin run. */
  async observe(agentId: string, paseo: PaseoApi): Promise<PrReviewOutcome | null> {
    if (!(await this.enabled())) return { kind: "skipped", reason: "off" };
    if (this.seen.has(agentId)) return null;
    this.seen.add(agentId);
    const found = await paseo.agents
      .ref(agentId)
      .refresh()
      .catch((e) => {
        this.seen.delete(agentId);
        throw e;
      });
    if (!found?.agent) {
      this.seen.delete(agentId);
      return null;
    }
    return this.consider(found.agent, paseo);
  }

  /** One review at a time per project and PR, so two agents for the same PR arriving together make one card (§8). */
  private chains = new Map<string, Promise<unknown>>();
  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  /** Whether a card already stands for this agent: its operation id, a card on the workspace, or an earlier review workspace of a card for the same PR. */
  private bound(board: Board, agentId: string, workspaceId: string, key: string | null): Task | undefined {
    const operationId = prReviewOperationId(agentId);
    return board.tasks.find(
      (t) =>
        t.operationId === operationId ||
        t.workspaceId === workspaceId ||
        (key !== null && isPrReviewCard(t) && prReviewCardKey(t) === key && cardWorkspaceIds(t).includes(workspaceId)),
    );
  }

  private skipBound(agentId: string, card: Task): PrReviewOutcome {
    this.log(`Flowly: PR review agent ${agentId} skipped: card ${card.id} already has this agent or its workspace.`);
    return { kind: "skipped", reason: "bound" };
  }

  async consider(agent: PrReviewAgent, paseo: PaseoApi): Promise<PrReviewOutcome> {
    if (!(await this.enabled())) return { kind: "skipped", reason: "off" };
    const ref = parsePrReviewLabel(agent.labels?.[PR_REVIEW_LABEL]);
    if (!ref) return { kind: "skipped", reason: "not-review" };
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return { kind: "skipped", reason: "no-workspace" };
    if (agent.archivedAt) return { kind: "skipped", reason: "archived" };
    const created = Date.parse(agent.createdAt ?? "");
    if (!Number.isFinite(created) || this.clock() - created > prReviewWindowMs) return { kind: "skipped", reason: "old" };
    const key = prKey(ref);
    const board = await this.service.store.read();
    const early = this.bound(board, agent.id, workspaceId, key);
    if (early) return this.skipBound(agent.id, early);
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace || workspace.archivingAt) return { kind: "skipped", reason: "workspace-gone" };
    const project = await prReviewProject(board, workspace.workspaceDirectory, workspace.projectId ?? null);
    if (!project) {
      if (!this.loggedNoProject) {
        this.loggedNoProject = true;
        this.log(`Flowly: no project holds the workspace of PR review agent ${agent.id}; no card made (logged once per run).`);
      }
      return { kind: "skipped", reason: "no-project" };
    }
    return this.serial(`${project.id}|${key ?? `agent:${agent.id}`}`, async () => {
      // Read again: an agent ahead of this one in the chain may have made the card.
      const latest = await this.service.store.read();
      const again = this.bound(latest, agent.id, workspaceId, key);
      if (again) return this.skipBound(agent.id, again);
      const card = prReviewCard(ref, agent.title);
      if (key) {
        const reused = await this.reuse(project, key, ref, agent, card.title, workspaceId, paseo);
        if (reused) return { kind: "reused" as const, task: reused };
      }
      const task = await this.service.createTask(
        {
          projectId: project.id,
          operationId: prReviewOperationId(agent.id),
          title: card.title,
          description: card.description,
          status: prReviewStatus(project),
          priority: "normal",
          tags: [PR_REVIEW_TAG],
          mode: "existing",
          workspaceId,
          baseRef: "",
        },
        paseo,
        // The review agent made it: the card's activity and tag say so.
        { agentId: agent.id },
      );
      if (key)
        await this.service.store.mutate((b) => {
          const t = b.tasks.find((x) => x.id === task.id);
          if (t && !t.prRef) t.prRef = key;
        });
      return { kind: "created" as const, task: { ...task, ...(key ? { prRef: key } : {}) } };
    });
  }

  /** The newest unarchived PR review card of this PR in the project takes the new review (PR-REVIEW-CARDS-SPEC §8). */
  private async reuse(project: Project, key: string, ref: PrRef, agent: PrReviewAgent, title: string, workspaceId: string, paseo: PaseoApi): Promise<Task | null> {
    if (await this.service.reservedWorkspace(workspaceId)) return null;
    const board = await this.service.store.read();
    const found = board.tasks
      .filter((t) => t.projectId === project.id && !t.archivedAt && isPrReviewCard(t) && prReviewCardKey(t) === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.position - a.position)[0];
    if (!found) return null;
    // A card that owns its workspace or switched it holds work a review must not take over: make a new card.
    if (found.ownsWorkspace === true || found.switch) {
      this.log(`Flowly: PR review agent ${agent.id} makes a new card: card ${found.id} for ${ref.text} owns its workspace or switched it, so it is not reused.`);
      return null;
    }
    const old = found.workspaceId;
    const oldWorkspace = await paseo.workspaces.ref(old).refresh().catch(() => null);
    const lane = prReviewStatus(project);
    return this.service.store.transaction<Task | null>((current) => {
      const t = current.tasks.find((x) => x.id === found.id);
      // Changed since it was read, or the new workspace was taken meanwhile: leave it, a new card is made.
      if (!t || t.archivedAt || t.workspaceId !== old || t.ownsWorkspace === true || t.switch) return { value: null, changed: false };
      if (current.tasks.some((x) => x.workspaceId === workspaceId)) return { value: null, changed: false };
      const now = new Date().toISOString();
      t.previousWorkspaces = [
        ...(t.previousWorkspaces || []),
        { id: old, kind: oldWorkspace?.workspaceKind || "directory", directory: oldWorkspace?.workspaceDirectory || project.primaryPath, switchedAt: now },
      ].slice(-switchLimits.previousWorkspaces);
      t.workspaceId = workspaceId;
      t.ownsWorkspace = false;
      if (!t.prRef) t.prRef = key;
      const actor = { actor: "agent" as const, agentId: agent.id };
      this.service.store.event(current, { taskId: t.id, ...actor, action: "workspace_switched", note: `new PR review ${ref.text}` });
      if (t.title !== title) {
        t.title = title;
        this.service.store.event(current, { taskId: t.id, ...actor, action: "edited" });
      }
      if (t.status !== lane) {
        const from = t.status;
        t.status = lane;
        t.position = columnEnd(current, project.id, lane);
        this.service.store.event(current, { taskId: t.id, ...actor, action: "status_changed", from, to: lane });
      }
      t.revision++;
      t.updatedAt = now;
      return { value: t, changed: true };
    });
  }
}
