import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropUpstream, projectWorktreeBase } from "./base-ref";

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

test("a branch made from a remote base with tracking gets its upstream removed; one without is left alone", async () => {
  const x = await setup();
  const tracked = join(x.root, "tracked");
  // Simulates a git that sets up tracking for every new branch.
  git(x.a, "-c", "branch.autoSetupMerge=always", "worktree", "add", "-q", "-b", "card", tracked, "refs/remotes/origin/dev");
  expect(git(tracked, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toBe("origin/dev");
  await dropUpstream(tracked);
  expect(() => git(tracked, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).toThrow();
  const plain = join(x.root, "plain");
  git(x.a, "worktree", "add", "-q", "-b", "plain", "--no-track", plain, "refs/remotes/origin/dev");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await dropUpstream(plain);
  await dropUpstream(join(x.root, "gone"));
  await dropUpstream(undefined);
  expect(logged).not.toHaveBeenCalled();
});
