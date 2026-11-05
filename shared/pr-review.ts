import { enabledStatuses, laneEnabled } from "./lanes";
import type { Project, Status, Task } from "./model";

/** PR review cards (docs/PR-REVIEW-CARDS-SPEC.md): a review agent carries this label, valued `<owner>/<repo>#<n>`. */
export const PR_REVIEW_LABEL = "pr-review-watch";
export const PR_REVIEW_TAG = "pr-review";
const operationPrefix = "pr-review:";

/** One card per review agent: the same agent always gives the same operation id (§3). */
export const prReviewOperationId = (agentId: string) => `${operationPrefix}${agentId}`;

/** Whether the card was made from a PR review agent; its operation id never changes (§5). */
export const isPrReviewCard = (task: Pick<Task, "operationId">) => task.operationId.startsWith(operationPrefix);

export type PrRef = { text: string; owner: string; repo: string; number: number } | { text: string; owner?: undefined };

/** The label value, trimmed; `owner/repo#n` is also split so the card can link the PR. Empty → null (§2). */
export function parsePrReviewLabel(value: string | undefined | null): PrRef | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(text);
  return match ? { text, owner: match[1], repo: match[2], number: Number(match[3]) } : { text };
}

/** In review when the project has that lane, else To do, else its first open lane (§4). */
export function prReviewStatus(project: Pick<Project, "lanes">): Status {
  if (laneEnabled(project, "in_review")) return "in_review";
  if (laneEnabled(project, "todo")) return "todo";
  return enabledStatuses(project).find((s) => s !== "done" && s !== "cancelled") ?? "todo";
}

/** The card's title and description (§4). */
export function prReviewCard(ref: PrRef, agentTitle: string | null | undefined) {
  const title = (agentTitle ?? "").replace(/\s+/g, " ").trim() || `PR review: ${ref.text}`;
  const url = ref.owner ? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}` : "";
  return {
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    description: [`PR: ${ref.text}${url ? ` (${url})` : ""}`, "", "Created automatically from a PR review agent."].join("\n"),
  };
}
