import type { Artifact, Task } from "./model";
import { hiddenPrKeys, prHiddenKey } from "./hidden-prs";
import { prReviewCardUrl } from "./pr-review";

/**
 * Pull request recognition (DRAWER-SPEC "Quick links") and the pull requests menu's rows (PR-MENU-SPEC §3.1).
 * Pure and shared: the Quick links chips, the board overview's per-card count and `prs.list` use the same rules.
 */

export type PrState = "draft" | "open" | "merged" | "closed" | "";

// Plain links: github.com and gitlab.com only; self-hosted PRs are recognized through their connector ref.
const githubPull = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})(?:[/?#]|$)/i;
const gitlabMerge = /^https?:\/\/(?:www\.)?gitlab\.com\/(.+?)\/-\/merge_requests\/(\d{1,9})(?:[/?#]|$)/i;
const isPullRef = (ext: Artifact["external"]) => !!ext && (ext.itemType === "pull" || ext.itemType === "merge_request");

/** "#42" for a GitHub pull request, "!7" for a GitLab merge request; null for anything else. */
export function prNumberOf(artifact: Pick<Artifact, "kind" | "target" | "external">): string | null {
  const ext = artifact.external;
  if (ext && isPullRef(ext)) {
    const m = /([#!])(\d+)$/.exec(ext.key);
    if (m) return `${ext.itemType === "merge_request" ? "!" : "#"}${m[2]}`;
  }
  if (artifact.kind !== "url") return null;
  const pull = githubPull.exec(artifact.target);
  if (pull) return `#${pull[3]}`;
  const merge = gitlabMerge.exec(artifact.target);
  return merge ? `!${merge[2]}` : null;
}

/** The connector's status word (GitHub/GitLab summaries: Draft, Open, Merged, Closed) as a chip state. */
export function prStateOf(status: string | undefined): PrState {
  switch (status) {
    case "Draft":
      return "draft";
    case "Open":
      return "open";
    case "Merged":
      return "merged";
    case "Closed":
      return "closed";
    default:
      return "";
  }
}

/** `owner/repo` (GitHub) or the project path (GitLab) of a PR artifact, from its connector key or its URL; "" when unknown. */
export function prRepoOf(artifact: Pick<Artifact, "kind" | "target" | "external">): string {
  const ext = artifact.external;
  if (ext && isPullRef(ext)) {
    const m = /^(.+)[#!]\d+$/.exec(ext.key.trim());
    if (m) return m[1];
  }
  if (artifact.kind !== "url") return "";
  const pull = githubPull.exec(artifact.target.trim());
  if (pull) return `${pull[1]}/${pull[2]}`;
  const merge = gitlabMerge.exec(artifact.target.trim());
  return merge ? merge[1] : "";
}

/** `owner/repo#n` (original case) of a github.com pull request URL, the key a GitHub connection reads it by; else null. */
export function githubPrKey(url: string): string | null {
  const m = githubPull.exec(url.trim());
  return m ? `${m[1]}/${m[2]}#${Number(m[3])}` : null;
}

/** Same PR, compared as `repo<sep>n` in lower case; null when the artifact names none. */
function samePrKey(artifact: Pick<Artifact, "kind" | "target" | "external">): string | null {
  const number = prNumberOf(artifact);
  const repo = prRepoOf(artifact);
  return number && repo ? `${repo}${number}`.toLowerCase() : null;
}

/** Whether a card's PRs are listed (PR-MENU-SPEC D2): live, and not in Done or Cancelled. */
export const prMenuCard = (task: Pick<Task, "archivedAt" | "status">) => !task.archivedAt && task.status !== "done" && task.status !== "cancelled";

/** One PR a card contributes: an output artifact (`pr`), or a PR review card's own PR (`review`). */
export type CardPr = {
  kind: "pr" | "review";
  artifactId?: string;
  url: string;
  number: string;
  repo: string;
  title: string;
  createdAt: string;
};

/**
 * The card's PRs (§3.1), newest first: every output artifact (not a plan) that names a PR, one per URL, then, for a
 * PR review card, its own PR unless an output already names it. `artifacts` may hold other cards' artifacts too.
 * The D2 card rule is the caller's (`prMenuCard`).
 */
export function cardPrs(task: Pick<Task, "id" | "title" | "description" | "prRef" | "operationId" | "createdAt">, artifacts: readonly Artifact[]): CardPr[] {
  const outputs = artifacts
    .filter((a) => a.taskId === task.id && a.role === "output" && !a.plan)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const rows: CardPr[] = [];
  const urls = new Set<string>();
  const keys = new Set<string>();
  for (const a of outputs) {
    const number = prNumberOf(a);
    if (!number) continue;
    const url = a.target.trim();
    if (urls.has(url)) continue;
    urls.add(url);
    const key = samePrKey(a);
    if (key) keys.add(key);
    rows.push({ kind: "pr", artifactId: a.id, url, number, repo: prRepoOf(a), title: a.title, createdAt: a.createdAt });
  }
  const reviewUrl = prReviewCardUrl(task);
  if (reviewUrl) {
    const asArtifact = { kind: "url" as const, target: reviewUrl, external: undefined };
    const key = samePrKey(asArtifact);
    const number = prNumberOf(asArtifact);
    if (number && !(key && keys.has(key))) rows.push({ kind: "review", url: reviewUrl, number, repo: prRepoOf(asArtifact), title: task.title, createdAt: task.createdAt });
  }
  return rows;
}

export type BoardPr = CardPr & { taskId: string; projectId: string; hidden: boolean };

/** Whether the user hid this PR of this card from the menu (PR-MENU-SPEC D11). */
export const prIsHidden = (hidden: ReadonlySet<string>, taskId: string, url: string) => hidden.has(prHiddenKey(taskId, url));

/** Splits rows into the ones the menu shows and the hidden ones, order kept. */
export function splitHiddenPrs<T extends { hidden: boolean }>(rows: readonly T[]): { visible: T[]; hidden: T[] } {
  return { visible: rows.filter((r) => !r.hidden), hidden: rows.filter((r) => r.hidden) };
}

/** Every PR row of the D2 cards in the given projects, in board card order. */
export function boardPrs(board: { tasks: readonly Task[]; artifacts: readonly Artifact[]; hiddenPrs?: readonly { taskId: string; url: string }[] }, projectIds: Iterable<string>): BoardPr[] {
  const ids = new Set(projectIds);
  const hidden = hiddenPrKeys(board.hiddenPrs);
  const byTask = new Map<string, Artifact[]>();
  for (const a of board.artifacts) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }
  return board.tasks.flatMap((task) =>
    ids.has(task.projectId) && prMenuCard(task)
      ? cardPrs(task, byTask.get(task.id) ?? []).map((row) => ({ ...row, taskId: task.id, projectId: task.projectId, hidden: prIsHidden(hidden, task.id, row.url) }))
      : [],
  );
}
