import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baseRefValue } from "../shared/worktree-base";
import { logFailure } from "./error-report";

const execute = promisify(execFile);
/** How long the base branch fetch may take before Flowly branches off the last fetched ref. */
export const BASE_FETCH_TIMEOUT_MS = 30_000;

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
export async function projectWorktreeBase(root: string, projectBaseRef: string | undefined, requested: string): Promise<string> {
  const explicit = requested.trim() === "HEAD" ? "" : requested.trim();
  const chosen = explicit || baseRefValue(projectBaseRef ?? "");
  if (!chosen) return resolveWorktreeBaseRef(root, "");
  if (chosen.startsWith("-")) throw new Error(`Base branch ${chosen} is not a valid branch name.`);
  const remote = await remoteBranchOf(root, chosen);
  if (!remote) {
    // As before for an explicit ref: Paseo resolves it. The project's own setting is checked here, for a clear error.
    if (explicit) return explicit;
    const found = await git(root, ["rev-parse", "--verify", "--quiet", `${chosen}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!found) throw new Error(`The project's base branch ${chosen} was not found. Fix it in the project's settings, or leave it empty to use the main checkout's current branch.`);
    return chosen;
  }
  try {
    await git(root, ["fetch", "--quiet", remote.remote, `+refs/heads/${remote.branch}:${remote.qualified}`], BASE_FETCH_TIMEOUT_MS);
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
 * Removes the upstream of the branch checked out in `directory`, if it has one (START-CARD-SPEC §4.1): a branch made
 * from a remote base must not push to it. Paseo already passes `--no-track`; this guards against other versions and
 * `branch.autoSetupMerge=always`. Never throws.
 */
export async function dropUpstream(directory: string | null | undefined) {
  if (!directory) return;
  const upstream = await git(directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
    (out) => out.trim(),
    () => "",
  );
  if (!upstream) return;
  try {
    await git(directory, ["branch", "--unset-upstream"]);
  } catch (e) {
    logFailure("Flowly worktree upstream not removed:", e, `${directory} ${upstream}`);
  }
}
