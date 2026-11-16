import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchAhead, dropUpstream, projectWorktreeBase, worktreeBranch } from "./base-ref";
import { changeBase } from "./auto-review";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" }).toString().trim();

/** A project root on `main` with a bare remote `origin` that has `dev`, fetched once; `other` is a second clone that advances it. */
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-base-ref-")));
  roots.push(root);
  const remote = join(root, "remote.git"),
    a = join(root, "project"),
    other = join(root, "other");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", a]);
  git(a, "commit", "-q", "--allow-empty", "-m", "init");
  git(a, "remote", "add", "origin", remote);
  git(a, "push", "-q", "origin", "main", "main:dev");
  git(a, "fetch", "-q", "origin");
  execFileSync("git", ["clone", "-q", remote, other]);
  const advance = (branch: string) => {
    git(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
    git(other, "commit", "-q", "--allow-empty", "-m", `more on ${branch}`);
    git(other, "push", "-q", "origin", branch);
    return git(other, "rev-parse", "HEAD");
  };
  return { root, remote, a, advance };
}

test("a remote base branch is fetched first and returned qualified, at the remote's new tip", async () => {
  const x = await setup();
  const tip = x.advance("dev");
  expect(git(x.a, "rev-parse", "refs/remotes/origin/dev")).not.toBe(tip);
  const base = await projectWorktreeBase(x.a, "origin/dev", "");
  expect(base).toBe("refs/remotes/origin/dev");
  expect(git(x.a, "rev-parse", base)).toBe(tip);
  // The qualified form works the same, and nothing is added to the remote's fetch refspecs.
  expect(await projectWorktreeBase(x.a, "refs/remotes/origin/dev", "")).toBe("refs/remotes/origin/dev");
  expect(git(x.a, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
});

test("an empty setting keeps the main checkout's current branch; an explicit ref wins over the setting", async () => {
  const x = await setup();
  expect(await projectWorktreeBase(x.a, undefined, "")).toBe("refs/heads/main");
  expect(await projectWorktreeBase(x.a, "", "HEAD")).toBe("refs/heads/main");
  expect(await projectWorktreeBase(x.a, "  ", "")).toBe("refs/heads/main");
  // Per card > per project: a local explicit ref is passed on as given (Paseo resolves it, as before).
  expect(await projectWorktreeBase(x.a, "origin/dev", "main")).toBe("main");
  expect(await projectWorktreeBase(x.a, "origin/dev", "not-checked")).toBe("not-checked");
  // An explicit remote ref is fetched and qualified like the setting.
  const tip = x.advance("main");
  expect(await projectWorktreeBase(x.a, "", "origin/main")).toBe("refs/remotes/origin/main");
  expect(git(x.a, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
});

test("a local base branch in the setting is checked; a wrong name is refused with a clear error", async () => {
  const x = await setup();
  git(x.a, "branch", "release");
  expect(await projectWorktreeBase(x.a, "release", "")).toBe("release");
  await expect(projectWorktreeBase(x.a, "no-such-branch", "")).rejects.toThrow(/base branch no-such-branch was not found/);
});

test("a failed fetch is logged and the last fetched ref is used; a never-fetched ref then fails", async () => {
  const x = await setup();
  const before = git(x.a, "rev-parse", "refs/remotes/origin/dev");
  git(x.a, "remote", "set-url", "origin", join(x.root, "missing.git"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await projectWorktreeBase(x.a, "origin/dev", "")).toBe("refs/remotes/origin/dev");
  expect(git(x.a, "rev-parse", "refs/remotes/origin/dev")).toBe(before);
  expect(logged).toHaveBeenCalledWith("Flowly worktree base fetch failed; branching off the last fetched ref:", expect.stringContaining("refs/remotes/origin/dev"), expect.any(String));
  await expect(projectWorktreeBase(x.a, "origin/never", "")).rejects.toThrow(/never fetched from origin/);
});

test("a remote whose name has a slash is matched by name, not by the first slash", async () => {
  const x = await setup();
  git(x.a, "remote", "add", "team/up", x.remote);
  const tip = x.advance("dev");
  expect(await projectWorktreeBase(x.a, "team/up/dev", "")).toBe("refs/remotes/team/up/dev");
  expect(git(x.a, "rev-parse", "refs/remotes/team/up/dev")).toBe(tip);
});

test("a branch made from a remote base with tracking gets that upstream removed; other upstreams and none are left alone", async () => {
  const x = await setup();
  const base = "refs/remotes/origin/dev";
  const tracked = join(x.root, "tracked");
  // Simulates a git that sets up tracking for every new branch.
  git(x.a, "-c", "branch.autoSetupMerge=always", "worktree", "add", "-q", "-b", "card", tracked, base);
  expect(git(tracked, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toBe("origin/dev");
  await dropUpstream(tracked, base);
  expect(() => git(tracked, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toThrow();
  // The branch's own pushed remote is a different upstream and stays.
  const pushed = join(x.root, "pushed");
  git(x.a, "worktree", "add", "-q", "-b", "mine", "--no-track", pushed, base);
  git(pushed, "push", "-q", "-u", "origin", "mine");
  expect(git(pushed, "rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/remotes/origin/mine");
  await dropUpstream(pushed, base);
  expect(git(pushed, "rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/remotes/origin/mine");
  const plain = join(x.root, "plain");
  git(x.a, "worktree", "add", "-q", "-b", "plain", "--no-track", plain, base);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await dropUpstream(plain, base);
  await dropUpstream(join(x.root, "gone"), base);
  await dropUpstream(undefined, base);
  expect(logged).not.toHaveBeenCalled();
});

test("a fetch that times out is logged and the last fetched ref is used", async () => {
  const x = await setup();
  const before = git(x.a, "rev-parse", "refs/remotes/origin/dev");
  x.advance("dev");
  // A remote whose upload-pack hangs.
  git(x.a, "config", "remote.origin.uploadpack", "sleep 5 #");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = Date.now();
  expect(await projectWorktreeBase(x.a, "origin/dev", "", 300)).toBe("refs/remotes/origin/dev");
  expect(Date.now() - started).toBeLessThan(4000);
  expect(git(x.a, "rev-parse", "refs/remotes/origin/dev")).toBe(before);
  expect(logged).toHaveBeenCalledWith("Flowly worktree base fetch failed; branching off the last fetched ref:", expect.anything(), expect.any(String));
});

test("a short name in the setting that is not a local branch is taken as origin/<name>", async () => {
  const x = await setup();
  const tip = x.advance("dev");
  expect(await projectWorktreeBase(x.a, "dev", "")).toBe("refs/remotes/origin/dev");
  expect(git(x.a, "rev-parse", "refs/remotes/origin/dev")).toBe(tip);
  // Not fetched yet locally: fetched on demand.
  git(x.a, "push", "-q", "origin", "main:fresh");
  git(x.a, "update-ref", "-d", "refs/remotes/origin/fresh");
  expect(await projectWorktreeBase(x.a, "fresh", "")).toBe("refs/remotes/origin/fresh");
  expect(git(x.a, "rev-parse", "--verify", "refs/remotes/origin/fresh")).toBe(git(x.a, "rev-parse", "main"));
  await expect(projectWorktreeBase(x.a, "nowhere", "")).rejects.toThrow(/base branch nowhere was not found/);
});

test("a parent's branch is the one checked out in its worktree of the same repository; ahead counts its commits not in the base (START-CARD-SPEC §11.2)", async () => {
  const x = await setup();
  const parent = join(x.root, "parent");
  git(x.a, "worktree", "add", "-q", "-b", "feature/parent", parent);
  expect(await worktreeBranch(parent, x.a)).toBe("feature/parent");
  // Not ahead yet, then two commits ahead of main.
  expect(await branchAhead(x.a, "refs/heads/main", "feature/parent")).toEqual({ ahead: 0, commit: git(x.a, "rev-parse", "main") });
  git(parent, "commit", "-q", "--allow-empty", "-m", "one");
  git(parent, "commit", "-q", "--allow-empty", "-m", "two");
  expect(await branchAhead(x.a, "refs/heads/main", "feature/parent")).toEqual({ ahead: 2, commit: git(parent, "rev-parse", "HEAD") });
  // Merged into the base: no longer ahead.
  git(x.a, "merge", "-q", "--ff-only", "feature/parent");
  expect((await branchAhead(x.a, "refs/heads/main", "feature/parent")).ahead).toBe(0);
  // A detached HEAD has no branch; the main checkout itself is the same repository.
  git(parent, "checkout", "-q", "--detach");
  expect(await worktreeBranch(parent, x.a)).toBeNull();
  expect(await worktreeBranch(x.a, x.a)).toBe("main");
  // Another repository has no branch here; a folder git can't read throws.
  expect(await worktreeBranch(join(x.root, "other"), x.a)).toBeNull();
  await expect(worktreeBranch(join(x.root, "gone"), x.a)).rejects.toThrow();
});

test("a follow-up's own change starts at the parent's commit until the parent lands, then at the merge base (START-CARD-SPEC §11.4)", async () => {
  const x = await setup();
  const parent = join(x.root, "parent"),
    child = join(x.root, "child");
  git(x.a, "worktree", "add", "-q", "-b", "parent", parent);
  git(parent, "commit", "-q", "--allow-empty", "-m", "parent work");
  const branchedAt = git(parent, "rev-parse", "HEAD");
  git(x.a, "worktree", "add", "-q", "-b", "child", child, "parent");
  git(child, "commit", "-q", "--allow-empty", "-m", "child work");
  const main = git(x.a, "rev-parse", "main");
  // Parent not landed: the merge base with main is main's tip, which would count the parent's commit too.
  expect(await changeBase(child, "refs/heads/main")).toBe(main);
  expect(await changeBase(child, "refs/heads/main", undefined, branchedAt)).toBe(branchedAt);
  // A commit the card's HEAD does not contain is ignored: the merge base as before.
  git(x.a, "commit", "-q", "--allow-empty", "-m", "elsewhere");
  const foreign = git(x.a, "rev-parse", "HEAD");
  expect(await changeBase(child, "refs/heads/main", undefined, foreign)).toBe(main);
  // The parent lands by a merge, then the card merges main in: the merge base again.
  git(x.a, "merge", "-q", "--no-edit", "parent");
  git(child, "merge", "-q", "--no-edit", "main");
  const landed = git(x.a, "rev-parse", "main");
  expect(await changeBase(child, "refs/heads/main", undefined, branchedAt)).toBe(landed);
  // A squash-merged parent: its commit never reaches main, so the card's change still starts at it.
  const parent2 = join(x.root, "parent2"),
    child2 = join(x.root, "child2");
  git(x.a, "worktree", "add", "-q", "-b", "parent2", parent2);
  git(parent2, "commit", "-q", "--allow-empty", "-m", "parent2 work");
  const branchedAt2 = git(parent2, "rev-parse", "HEAD");
  git(x.a, "worktree", "add", "-q", "-b", "child2", child2, "parent2");
  git(child2, "commit", "-q", "--allow-empty", "-m", "child2 work");
  git(x.a, "merge", "-q", "--squash", "parent2");
  git(x.a, "commit", "-q", "--allow-empty", "-m", "squashed parent2");
  git(x.a, "worktree", "remove", "--force", parent2);
  git(x.a, "branch", "-q", "-D", "parent2");
  expect(await changeBase(child2, "refs/heads/main", undefined, branchedAt2)).toBe(branchedAt2);
});
