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

/** The key two reviews share when they name the same pull request: `owner/repo#n`, lower case (GitHub names ignore case). Null for a loose label (§8). */
export const prKey = (ref: PrRef): string | null => (ref.owner ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : null);

// `PR: [label](url)` (current), `PR: label (url)` (older) or `PR: label` (§8).
const prLine = /^PR: (?:\[(\S+)\]\((https:\/\/github\.com\/\S+)\)|(\S+)(?: \((https:\/\/github\.com\/\S+)\))?)$/;
const pullUrl = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

/** The first `PR:` line of a description that names a pull request: its key and the URL it carries, if any. */
function descriptionPr(description: string): { key: string; url: string | null } | null {
  for (const line of description.split(/\r?\n/)) {
    const m = prLine.exec(line.trimEnd());
    const ref = m ? parsePrReviewLabel(m[1] ?? m[3]) : null;
    const key = ref ? prKey(ref) : null;
    if (key) return { key, url: m![2] ?? m![4] ?? null };
  }
  return null;
}

/** The PR a PR review card is for: its stored ref, else (older cards) a whole `PR:` line of the description, searched line by line (§8). */
export function prReviewCardKey(task: Pick<Task, "description" | "prRef">): string | null {
  return task.prRef || descriptionPr(task.description)?.key || null;
}

/** The GitHub URL of a PR review card's pull request, or null when it is not one or names no `owner/repo#n` (§9). The description's own URL (original case) wins when it is the same PR. */
export function prReviewCardUrl(task: Pick<Task, "description" | "prRef" | "operationId">): string | null {
  if (!isPrReviewCard(task)) return null;
  const key = prReviewCardKey(task);
  if (!key) return null;
  const fromDescription = descriptionPr(task.description);
  const m = fromDescription?.url ? pullUrl.exec(fromDescription.url) : null;
  if (m && `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() === key) return fromDescription!.url;
  const k = /^(.+)\/(.+)#(\d+)$/.exec(key);
  return k ? `https://github.com/${k[1]}/${k[2]}/pull/${k[3]}` : null;
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
    description: [`PR: ${url ? `[${ref.text}](${url})` : ref.text}`, "", "Created automatically from a PR review agent."].join("\n"),
  };
}
