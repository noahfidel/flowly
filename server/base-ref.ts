import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { baseRefValue } from "../shared/worktree-base";
import { logFailure } from "./error-report";

const execute = promisify(execFile);
/** How long the base branch fetch may take before Flowly branches off the last fetched ref. */
export const BASE_FETCH_TIMEOUT_MS = 15_000;

const git = async (cwd: string, args: string[], timeout = 10_000) =>
  (await execute("git", ["-C", cwd, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;

/** `requested` when it names a ref, else the source checkout's current named branch (`refs/heads/...`). */
export async function resolveWorktreeBaseRef(sourcePath: string, requested: string): Promise<string> {
  const explicit = requested.trim();
  if (explicit && explicit !== "HEAD") return explicit;
  try {
    const branch = (await git(sourcePath, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    if (!branch.startsWith("refs/heads/")) throw new Error("No named branch");
    return branch;
  } catch {
    throw new Error(
      "Cannot determine the selected repository's current named branch. Enter a valid base ref (such as main or origin/main); detached HEAD and non-Git directories have no automatic branch.",
    );
  }
}

/**
 * The remote and branch of a remote-tracking ref (`origin/dev` or `refs/remotes/origin/dev`), else null. Remote
 * names may contain slashes, so the remote is matched against `git remote` (longest name first), not parsed.
 */
async function remoteBranchOf(root: string, ref: string) {
  const path = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref.startsWith("refs/") ? null : ref;
  if (!path) return null;
  const remotes = await git(root, ["remote"]).then(
    (out) => out.split("\n").map((r) => r.trim()).filter(Boolean),
    () => [] as string[],
  );
  const remote = remotes.filter((r) => path.startsWith(`${r}/`) && path.length > r.length + 1).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: path.slice(remote.length + 1), qualified: `refs/remotes/${path}` } : null;
}

/**
 * The base a new branch-off worktree starts from (START-CARD-SPEC §4.1): an explicit `requested` ref wins (passed on
 * as given unless it is remote-tracking), then the project's base branch, then the main checkout's current branch.
 * A remote-tracking base is fetched first; when the fetch fails the last fetched ref is used and the failure logged.
 * Throws only when the chosen base does not exist (never fetched and the fetch failed, or a wrong name).
 */
export async function projectWorktreeBase(root: string, projectBaseRef: string | undefined, requested: string, fetchTimeoutMs = BASE_FETCH_TIMEOUT_MS): Promise<string> {
  const explicit = requested.trim() === "HEAD" ? "" : requested.trim();
  const chosen = explicit || baseRefValue(projectBaseRef ?? "");
  if (!chosen) return resolveWorktreeBaseRef(root, "");
  if (chosen.startsWith("-")) throw new Error(`Base branch ${chosen} is not a valid branch name.`);
  const remote = await remoteBranchOf(root, chosen);
  if (remote) return fetchedRemoteBase(root, remote, chosen, fetchTimeoutMs);
  // As before for an explicit ref: Paseo resolves it. The project's own setting is checked here, for a clear error.
  if (explicit) return explicit;
  const found = await git(root, ["rev-parse", "--verify", "--quiet", `${chosen}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (found) return chosen;
  // A short name (`dev`) that is not local but exists on origin counts as `origin/dev`.
  const short = chosen.startsWith("refs/") ? null : await remoteBranchOf(root, `origin/${chosen}`);
  if (short) {
    const qualified = await fetchedRemoteBase(root, short, chosen, fetchTimeoutMs).catch(() => null);
    if (qualified) return qualified;
  }
  throw new Error(`The project's base branch ${chosen} was not found. Fix it in the project's settings, or leave it empty to use the main checkout's current branch.`);
}

async function fetchedRemoteBase(root: string, remote: { remote: string; branch: string; qualified: string }, chosen: string, timeoutMs: number) {
  try {
    await git(root, ["fetch", "--quiet", remote.remote, `+refs/heads/${remote.branch}:${remote.qualified}`], timeoutMs);
  } catch (e) {
    logFailure("Flowly worktree base fetch failed; branching off the last fetched ref:", e, `${root} ${remote.qualified}`);
  }
  const found = await git(root, ["rev-parse", "--verify", "--quiet", `${remote.qualified}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!found)
    throw new Error(`Base branch ${chosen} was not found: it was never fetched from ${remote.remote} and fetching it failed. Check the branch name and the network.`);
  return remote.qualified;
}

/** Whether a branch-off base is a remote-tracking ref, so the new branch must not track it. */
export const remoteBase = (ref: string) => ref.startsWith("refs/remotes/");

/**
 * Removes the upstream of the branch checked out in `directory` when it is `baseRef` (START-CARD-SPEC §4.1): a branch
 * made from a remote base must not push to it. Paseo already passes `--no-track`; this guards against other versions
 * and `branch.autoSetupMerge=always`. Any other upstream (the branch's own pushed remote) is left alone. Never throws.
 */
export async function dropUpstream(directory: string | null | undefined, baseRef: string) {
  if (!directory) return;
  const upstream = await git(directory, ["rev-parse", "--symbolic-full-name", "@{u}"]).then(
    (out) => out.trim(),
    () => "",
  );
  if (!upstream || upstream !== baseRef) return;
  try {
    await git(directory, ["branch", "--unset-upstream"]);
  } catch (e) {
    logFailure("Flowly worktree upstream not removed:", e, `${directory} ${upstream}`);
  }
}

/** The repository's shared git folder, as an absolute real path. */
async function commonDir(directory: string) {
  const dir = (await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return realpath(dir);
}

/**
 * The branch checked out in `directory` when it is a checkout of the repository at `root` (START-CARD-SPEC §11.2):
 * null on a detached HEAD or in another repository. Throws when git cannot read `directory`.
 */
export async function worktreeBranch(directory: string, root: string): Promise<string | null> {
  const [own, project] = await Promise.all([commonDir(directory), commonDir(root).catch(() => null)]);
  if (!project || own !== project) return null;
  // The full name: `--short` prints `heads/x` when a tag `x` exists too.
  const ref = await git(directory, ["symbolic-ref", "--quiet", "HEAD"]).then(
    (out) => out.trim(),
    () => "",
  );
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length ? ref.slice("refs/heads/".length) : null;
}

/** The tip of `refs/heads/<branch>` in `root` and how many of its commits `base` lacks (`git rev-list --count`, §11.2). */
export async function branchAhead(root: string, base: string, branch: string): Promise<{ ahead: number; commit: string }> {
  const commit = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).trim();
  const ahead = Number((await git(root, ["rev-list", "--count", `${base}..${commit}`])).trim());
  if (!Number.isInteger(ahead)) throw new Error(`git rev-list gave no count for ${branch}`);
  return { ahead, commit };
}

/** Whether `ref` resolves to a commit in `root`. */
export const refResolves = (root: string, ref: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    () => true,
    () => false,
  );

/**
 * What a new worktree really branched from (START-CARD-SPEC §11.4): its HEAD and how many of its commits `base` lacks,
 * read once the worktree exists. Throws when git cannot read it.
 */
export async function worktreeHead(directory: string, base: string): Promise<{ commit: string; ahead: number }> {
  const commit = (await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const ahead = Number((await git(directory, ["rev-list", "--count", `${base}..${commit}`])).trim());
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !Number.isInteger(ahead)) throw new Error(`git gave no commit or count in ${directory}`);
  return { commit, ahead };
}

/**
 * `branchedFrom` with the commit the worktree in `directory` actually branched from (§11.4): the parent may have moved
 * between the decision and the create. Keeps the measured values, logged, when the worktree can't be read.
 */
export async function actualBranchedFrom<T extends { commit: string; ahead: number }>(directory: string | null | undefined, base: string, measured: T): Promise<T> {
  try {
    if (!directory) throw new Error("no worktree directory");
    return { ...measured, ...(await worktreeHead(directory, base)) };
  } catch (e) {
    logFailure("Flowly follow-up worktree head not read; keeping the measured parent commit:", e, `${directory ?? ""} ${measured.commit}`);
    return measured;
  }
}
