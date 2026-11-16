import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { isPrReviewCard } from "../shared/pr-review";
import type { Artifact, Status, Task } from "../shared/model";
import type { PrState, PrTarget } from "./pr-review-archive";

/**
 * Moving a card to Done when its work lands on its base branch (LANDED-DONE-SPEC). The evidence sources, in order
 * (§3): the card's single PR output, a PR headed by its worktree branch, then the ancestor check against
 * `origin/<base>`. Every git and gh call is an argument array, never a shell, and injectable for tests.
 */

/**
 * The lanes a card is checked in (R2, ruling 2026-11-16, reversing the first R2 that checked only In review,
 * Committed and Integrated): every open lane. Todo and Backlog have no work to land; Done and Cancelled are finished.
 */
export const landStatuses: readonly Status[] = ["design", "development", "test", "blocked", "in_review", "committed", "integrated"];

const pullUrl = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const pullKey = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;

/** The PR an output artifact names (§3.1): a GitHub pull URL as its target, or an `external` ref of a pull. */
function artifactPr(a: Artifact): PrTarget | null {
  const url = pullUrl.exec(a.target.trim());
  if (url) {
    const host = url[1].toLowerCase();
    const repo = `${url[2]}/${url[3]}`.toLowerCase();
    return { key: `${repo}#${Number(url[4])}`, repo, number: Number(url[4]), ...(host === "github.com" ? {} : { host }) };
  }
  const key = a.external?.itemType === "pull" ? pullKey.exec(a.external.key.trim()) : null;
  if (!key) return null;
  const repo = `${key[1]}/${key[2]}`.toLowerCase();
  return { key: `${repo}#${Number(key[3])}`, repo, number: Number(key[3]) };
}

/** The distinct PRs among a card's output artifacts, compared as `owner/repo#n` in lower case (§3.1). */
export function cardPrOutputs(artifacts: readonly Artifact[], taskId: string): PrTarget[] {
  const found = new Map<string, PrTarget>();
  for (const a of artifacts) {
    if (a.taskId !== taskId || a.role !== "output") continue;
    const pr = artifactPr(a);
    if (pr && !found.has(pr.key)) found.set(pr.key, pr);
  }
  return [...found.values()];
}

/**
 * Whether the check looks at this card at all (§2): a live ordinary card in a land lane with
 * evidence to check, exactly one PR output or (no PR output) a `baseRef`. Two or more PRs: a person should look.
 * The live project and the running-session rules are the caller's.
 */
export function landCandidate(task: Task, artifacts: readonly Artifact[]): boolean {
  if (task.archivedAt || isPrReviewCard(task) || !landStatuses.includes(task.status)) return false;
  const prs = cardPrOutputs(artifacts, task.id);
  return prs.length === 1 || (prs.length === 0 && !!task.baseRef?.trim());
}

/** The base branch's name on the remote: `baseRef` without `refs/heads/` (R5). */
export function baseBranch(baseRef: string | undefined): string | null {
  const ref = baseRef?.trim() ?? "";
  const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
  // A base that is still a full ref (a tag, for example) gets no check (§3.3).
  return name && !name.startsWith("-") && !name.startsWith("refs/") && name !== "HEAD" ? name : null;
}

/** A command run in a directory; rejects on a non-zero exit or when it cannot start. */
export type RunIn = (file: string, args: readonly string[], cwd: string) => Promise<string>;
export const runFileIn: RunIn = (file, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], { cwd, timeout: 20_000, maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))),
  );

/**
 * A git command in a directory: its exit code and output; rejects only when git cannot run at all. `env` adds to the
 * daemon's environment (which always gets `GIT_TERMINAL_PROMPT=0`).
 */
export type GitRun = (cwd: string, args: readonly string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string }>;
export const runGit: GitRun = (cwd, args, env) =>
  new Promise((resolve, reject) =>
    execFile(
      "git",
      [...args],
      { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout: String(stdout) });
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") resolve({ code, stdout: String(stdout ?? "") });
        else reject(error);
      },
    ),
  );

/**
 * §3.2: whether a merged PR carries exactly this worktree's head commit, through `gh pr list` in the card's directory;
 * null when unreadable. Branch names are reused, so the name alone never counts: the PR must not be cross-repository
 * and its `headRefOid` must be `head`.
 */
export function ghHeadPrMerged(run: RunIn = runFileIn) {
  return async (directory: string, branch: string, head: string): Promise<{ merged: true; pr: string } | { merged: false } | null> => {
    try {
      const out = await run(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url,mergedAt,headRefOid,isCrossRepository", "--limit", "5"],
        directory,
      );
      const list = JSON.parse(out) as unknown;
      if (!Array.isArray(list)) return null;
      for (const item of list as { number?: unknown; state?: unknown; url?: unknown; mergedAt?: unknown; headRefOid?: unknown; isCrossRepository?: unknown }[]) {
        if (item?.state !== "MERGED" && !(typeof item?.mergedAt === "string" && item.mergedAt)) continue;
        if (item.isCrossRepository !== false || typeof item.headRefOid !== "string" || item.headRefOid !== head) continue;
        const url = typeof item.url === "string" ? pullUrl.exec(item.url) : null;
        return { merged: true, pr: url ? `${url[2]}/${url[3]}#${Number(url[4])}`.toLowerCase() : `#${String(item.number)}` };
      }
      return { merged: false };
    } catch {
      return null;
    }
  };
}

/** The branch checked out in the directory, or null on a detached HEAD (§3.2). Rejects when git fails. */
export async function checkedOutBranch(git: GitRun, directory: string): Promise<string | null> {
  const r = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code === 1) return null;
  if (r.code !== 0) throw new Error(`git symbolic-ref exited ${r.code}`);
  return r.stdout.trim() || null;
}

/** The worktree's HEAD commit. Rejects when git fails. */
export async function headCommit(git: GitRun, directory: string): Promise<string> {
  const r = await git(directory, ["rev-parse", "--verify", "HEAD"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`git rev-parse exited ${r.code}`);
  return r.stdout.trim();
}

/** At most this many of the worktree's own commits are tried, newest first (§3.3 step 2). */
const ownCommitsChecked = 20;

/**
 * §3.3 step 2: the card made a commit of its own that HEAD still contains. The worktree's own HEAD reflog starts when
 * the worktree was created, so a reused branch name brings no earlier card's commits; a commit dropped by a reset is
 * no longer an ancestor of HEAD. An empty or failing reflog counts as no commit.
 */
async function ownCommitInHead(git: GitRun, directory: string): Promise<boolean> {
  const reflog = await git(directory, ["reflog", "show", "--format=%H%x09%gs", "HEAD", "--"]);
  if (reflog.code !== 0) return false;
  const shas = [
    ...new Set(
      reflog.stdout
        .split("\n")
        .map((line) => line.split("\t"))
        .filter(([sha, subject]) => /^[0-9a-f]{7,64}$/i.test(sha ?? "") && (subject ?? "").startsWith("commit"))
        .map(([sha]) => sha),
    ),
  ].slice(0, ownCommitsChecked);
  for (const sha of shas) if ((await git(directory, ["merge-base", "--is-ancestor", sha, "HEAD"])).code === 0) return true;
  return false;
}

/** Batch-mode SSH for the fetch, only when neither `GIT_SSH_COMMAND` nor `core.sshCommand` is set (§3.3 step 3). */
async function sshBatchEnv(git: GitRun, directory: string): Promise<Record<string, string> | undefined> {
  if (process.env.GIT_SSH_COMMAND) return undefined;
  const configured = await git(directory, ["config", "--get", "core.sshCommand"]).catch(() => ({ code: 1, stdout: "" }));
  return configured.code === 0 && configured.stdout.trim() ? undefined : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
}

/**
 * §3.3, the ancestor check: "landed" when the workspace is clean, the card made a commit of its own that HEAD still
 * contains (a fast-forward pull or a reset to the base is not one), the fetch of `origin/<base>`
 * works and HEAD is an ancestor of it. "stays" when one of those is plainly not so (or there is no reflog);
 * "unknown" when git failed.
 */
export async function ancestorLanded(git: GitRun, directory: string, _branch: string, base: string): Promise<"landed" | "stays" | "unknown"> {
  try {
    const status = await git(directory, ["--no-optional-locks", "status", "--porcelain"]);
    if (status.code !== 0) return "unknown";
    if (status.stdout.trim()) return "stays";
    if (!(await ownCommitInHead(git, directory))) return "stays";
    const fetch = await git(
      directory,
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-auto-gc", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
      await sshBatchEnv(git, directory),
    );
    if (fetch.code !== 0) return "unknown";
    const ancestor = await git(directory, ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${base}`]);
    return ancestor.code === 0 ? "landed" : ancestor.code === 1 ? "stays" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Where a card's workspace lives, through the Paseo API; null when unknown. */
export type WorkspaceWhere = (task: Task, paseo: PaseoApi) => Promise<{ directory: string; worktree: boolean } | null>;
export const paseoWorkspace: WorkspaceWhere = async (task, paseo) => {
  const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
  return workspace?.workspaceDirectory ? { directory: workspace.workspaceDirectory, worktree: workspace.workspaceKind === "worktree" } : null;
};

/** What one card's check found (§3). */
export type Landing =
  | { kind: "pr"; state: PrState | null; pr: PrTarget }
  | { kind: "branch-pr"; pr: string }
  | { kind: "landed"; base: string }
  | { kind: "stays" }
  | { kind: "unknown" };

export type LandingDeps = {
  lookup: (pr: PrTarget) => Promise<PrState | null>;
  workspace: WorkspaceWhere;
  gh: RunIn;
  git: GitRun;
};

/** One card's evidence, the first source that applies deciding (§3). */
export async function landing(task: Task, artifacts: readonly Artifact[], paseo: PaseoApi, deps: LandingDeps): Promise<Landing> {
  const prs = cardPrOutputs(artifacts, task.id);
  if (prs.length > 1) return { kind: "stays" };
  if (prs.length === 1) return { kind: "pr", state: await deps.lookup(prs[0]).catch(() => null), pr: prs[0] };
  const base = baseBranch(task.baseRef);
  if (!base) return { kind: "stays" };
  const where = await deps.workspace(task, paseo).catch(() => undefined);
  if (where === undefined) return { kind: "unknown" };
  if (!where?.worktree) return { kind: "stays" };
  let branch: string | null;
  try {
    branch = await checkedOutBranch(deps.git, where.directory);
  } catch {
    return { kind: "unknown" };
  }
  if (!branch) return { kind: "stays" };
  let head: string;
  try {
    head = await headCommit(deps.git, where.directory);
  } catch {
    return { kind: "unknown" };
  }
  const headPr = await ghHeadPrMerged(deps.gh)(where.directory, branch, head);
  if (headPr?.merged) return { kind: "branch-pr", pr: headPr.pr };
  const result = await ancestorLanded(deps.git, where.directory, branch, base);
  return result === "landed" ? { kind: "landed", base } : { kind: result };
}
