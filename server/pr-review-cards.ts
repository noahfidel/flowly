import type { PaseoApi } from "@getpaseo/client";
import type { Board, Project, Task } from "../shared/model";
import {
  PR_REVIEW_LABEL,
  PR_REVIEW_TAG,
  parsePrReviewLabel,
  prReviewCard,
  prReviewOperationId,
  prReviewStatus,
} from "../shared/pr-review";
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
    if (board.tasks.some((t) => t.workspaceId === workspaceId || t.operationId === operationId))
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
}
