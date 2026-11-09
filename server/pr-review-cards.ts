import type { PaseoApi } from "@getpaseo/client";
import type { Board, Project, Task } from "../shared/model";
import {
  PR_REVIEW_LABEL,
  PR_REVIEW_TAG,
  parsePrReviewLabel,
  prReviewCard,
  prReviewCardRef,
  isPrReviewCard,
  samePr,
  prReviewOperationId,
  prReviewStatus,
  type PrRef,
} from "../shared/pr-review";
import { cardWorkspaceIds } from "../shared/workspace-switch";
import { switchLimits } from "../shared/model";
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

  async consider(agent: PrReviewAgent, paseo: PaseoApi): Promise<PrReviewOutcome> {
    if (!(await this.enabled())) return { kind: "skipped", reason: "off" };
    const ref = parsePrReviewLabel(agent.labels?.[PR_REVIEW_LABEL]);
    if (!ref) return { kind: "skipped", reason: "not-review" };
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return { kind: "skipped", reason: "no-workspace" };
    if (agent.archivedAt) return { kind: "skipped", reason: "archived" };
    const created = Date.parse(agent.createdAt ?? "");
    if (!Number.isFinite(created) || this.clock() - created > prReviewWindowMs) return { kind: "skipped", reason: "old" };
    const operationId = prReviewOperationId(agent.id);
    const board = await this.service.store.read();
    // Current or earlier workspace of any card: a reused card keeps its old review workspaces as history, so a re-run of an old agent is "bound" too.
    if (board.tasks.some((t) => cardWorkspaceIds(t).includes(workspaceId) || t.operationId === operationId))
      return { kind: "skipped", reason: "bound" };
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
    const card = prReviewCard(ref, agent.title);
    if (ref.owner) {
      const reused = await this.reuse(project, ref, agent, card.title, workspaceId, workspace, paseo);
      if (reused) return { kind: "reused", task: reused };
    }
    const task = await this.service.createTask(
      {
        projectId: project.id,
        operationId,
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
    return { kind: "created", task };
  }

  /** The newest unarchived PR review card of this PR in the project takes the new review (PR-REVIEW-CARDS-SPEC §8). */
  private async reuse(
    project: Project,
    ref: PrRef,
    agent: PrReviewAgent,
    title: string,
    workspaceId: string,
    workspace: { workspaceKind?: string | null; workspaceDirectory?: string | null },
    paseo: PaseoApi,
  ): Promise<Task | null> {
    if (await this.service.reservedWorkspace(workspaceId)) return null;
    const lane = prReviewStatus(project);
    return this.service.store.transaction<Task | null>((board) => {
      const found = board.tasks
        .filter((t) => t.projectId === project.id && !t.archivedAt && isPrReviewCard(t) && samePr(prReviewCardRef(t) ?? { text: "" }, ref))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.position - a.position)[0];
      if (!found) return { value: null, changed: false };
      // The workspace must still be free (a card made meanwhile may hold it).
      if (board.tasks.some((t) => cardWorkspaceIds(t).includes(workspaceId))) return { value: null, changed: false };
      const now = new Date().toISOString();
      const old = found.workspaceId;
      found.previousWorkspaces = [
        ...(found.previousWorkspaces || []),
        { id: old, kind: "directory", directory: found.sourcePath, switchedAt: now },
      ].slice(-switchLimits.previousWorkspaces);
      found.workspaceId = workspaceId;
      found.ownsWorkspace = false;
      const actor = { actor: "agent" as const, agentId: agent.id };
      this.service.store.event(board, {
        taskId: found.id,
        ...actor,
        action: "workspace_switched",
        note: `new PR review ${ref.text}`,
      });
      if (found.title !== title) {
        found.title = title;
        this.service.store.event(board, { taskId: found.id, ...actor, action: "edited" });
      }
      if (found.status !== lane) {
        const from = found.status;
        found.status = lane;
        found.position =
          Math.max(-1, ...board.tasks.filter((t) => t.projectId === project.id && t.status === lane).map((t) => t.position)) + 1;
        this.service.store.event(board, { taskId: found.id, ...actor, action: "status_changed", from, to: lane });
      }
      found.revision++;
      found.updatedAt = now;
      return { value: found, changed: true };
    });
  }
}
