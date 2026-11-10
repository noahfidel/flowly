import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import {
  LedgerFolder,
  ReviewLedgers,
  applyLedger,
  branchLedgerName,
  cardIdentity,
  factsOf,
  gitFacts,
  ledgerFolderState,
  parseLedgerSummary,
  repoFromRemote,
  summaryLine,
  type GitFacts,
} from "./review-ledgers";
import { dropArtifact, editArtifact, putArtifact } from "./artifacts";
import { artifactContextLines } from "../shared/artifacts";
import { reviewLedgerSettingsValues } from "../shared/settings";
import type { Task } from "../shared/model";

// Made-up repositories, PRs and ledgers only; never copies of real review ledgers.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const stamp = "2026-11-10T09:00:00.000Z";

const ledger = (rounds: string) => `# Review ledger: acme/widgets PR 42\n\n${rounds}`;
const round2 = `## Round 1: 2026-11-01, abc1234, whole PR, sonnet
- Finding 1 (Important): Null check missing in parse. Decision: fix. Status: fixed in def5678
- Finding 2 (Minor): Rename helper. Decision: skip. Status: raised, not actioned

Dismissed:
- Style nit about quotes: not a defect

## Round 2: 2026-11-03, def5678, abc1234..def5678, opus
- Finding 3 (Critical): Race when two sweeps run. Decision: fix. Status: open
  Reviewer text: the open handle is never closed.
- Finding 4 (Important): Missing test for rename. Decision: fix. Status: fixed in 0a1b2c3
- Finding 5 (Minor): Log label holds an id. Decision: defer, later card. Status: deferred
- Finding 6 (Minor): Comment typo.
  - Status: fixed in 0a1b2c3

Dismissed:
- Finding-like text in the dismissed list, open: ignored
`;

test("summary: the newest round's findings by status, dismissed list ignored", () => {
  const s = parseLedgerSummary(ledger(round2));
  expect(s).toEqual({ round: 2, counts: { open: 1, fixed: 2, deferred: 1 } });
  expect(summaryLine(s)).toBe("Review: round 2 · 1 open, 2 fixed, 1 deferred");
});

test("summary: table rows, bold labels and status words without a marker", () => {
  const text = `## Round 3: 2026-11-04, uncommitted, whole PR, opus
| Finding | Text | Status |
|---|---|---|
| Finding 7 | Open the file twice | fixed in 9f9f9f9 |
| Finding 8 | Retry loop | deferred |
**Finding 9**: Missing guard — open
`;
  expect(parseLedgerSummary(text)).toEqual({ round: 3, counts: { open: 1, fixed: 1, deferred: 1 } });
});

test("summary: a negated status word is not that status", () => {
  const text = `## Round 2: x
- Finding 1: Leak. Status: not fixed, open
- Finding 2: Typo. Status: fixed in abc
`;
  expect(parseLedgerSummary(text)).toEqual({ round: 2, counts: { open: 1, fixed: 1, deferred: 0 } });
  // "not fixed" alone states no status: only the round is shown.
  expect(parseLedgerSummary("## Round 1: x\n- Finding 1: Leak. Status: not fixed\n")).toEqual({ round: 1, counts: null });
  expect(parseLedgerSummary("## Round 1: x\n- Finding 1: Leak — not yet deferred, fixed in abc\n")).toEqual({ round: 1, counts: { open: 0, fixed: 1, deferred: 0 } });
});

test("summary: only the round when counts can't be read; null without rounds", () => {
  expect(parseLedgerSummary("## Round 4: 2026-11-05, abc, whole PR, opus\nNo findings.\n")).toEqual({ round: 4, counts: null });
  expect(parseLedgerSummary("## Round 1: x\n- Finding 1: something odd with no state\n")).toEqual({ round: 1, counts: null });
  expect(summaryLine({ round: 4, counts: null })).toBe("Review: round 4");
  expect(parseLedgerSummary("# Notes\nnothing here")).toBeNull();
  expect(summaryLine(null)).toBe("");
});

const owned = { ownsWorkspace: true } as const;
const worktree = (over: Partial<Parameters<typeof cardIdentity>[1] & object> = {}) => ({
  directory: "/w",
  kind: "worktree",
  branch: "feat/x",
  remoteUrl: "git@github.com:acme/widgets.git",
  ...over,
});

test("identity: remotes; a prRef matches only its PR, never a branch", () => {
  expect(repoFromRemote("git@github.com:Acme/Widgets.git")).toEqual({ owner: "Acme", repo: "Widgets" });
  expect(repoFromRemote("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  expect(repoFromRemote("ssh://git@github.com:22/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  expect(repoFromRemote("/just-a-folder")).toBeNull();
  expect(repoFromRemote("")).toBeNull();
  // prRef: that repository and PR only, whatever the workspace says.
  expect(cardIdentity({ prRef: "acme/widgets#42", ...owned }, worktree({ remoteUrl: "git@github.com:other/thing.git", pr: { number: 9 } }))).toEqual({
    state: "match",
    id: { owner: "acme", repo: "widgets", pr: 42 },
  });
  expect(cardIdentity({ prRef: "not a pr" }, worktree())).toEqual({ state: "none" });
  expect(branchLedgerName("feat/a/b")).toBe("branch-feat-a-b.md");
});

test("identity: an owned, unshared worktree matches by its PR and branch", () => {
  const facts = factsOf({
    workspaceDirectory: "/w",
    workspaceKind: "worktree",
    gitRuntime: { currentBranch: "fix/y", remoteUrl: "git@github.com:acme/widgets.git" },
    githubRuntime: { pullRequest: { number: 7, repoOwner: "acme", repoName: "widgets" } },
  });
  expect(cardIdentity(owned, facts)).toEqual({ state: "match", id: { owner: "acme", repo: "widgets", pr: 7, branch: "fix/y" } });
  expect(cardIdentity(owned, worktree())).toEqual({ state: "match", id: { owner: "acme", repo: "widgets", branch: "feat/x" } });
});

test("identity: no branch or workspace-PR match on shared or default-branch checkouts", () => {
  const pr = { number: 7, owner: "acme", repo: "widgets" };
  // Not owned by the card (a linked or existing workspace).
  expect(cardIdentity({}, worktree({ pr }))).toEqual({ state: "none" });
  expect(cardIdentity({ ownsWorkspace: false }, worktree({ pr }))).toEqual({ state: "none" });
  // Not a worktree: a directory or the main checkout.
  expect(cardIdentity(owned, worktree({ kind: "directory", pr }))).toEqual({ state: "none" });
  expect(cardIdentity(owned, worktree({ kind: "local_checkout", pr }))).toEqual({ state: "none" });
  // Another live card shares the workspace or folder.
  expect(cardIdentity(owned, worktree({ pr }), true)).toEqual({ state: "none" });
  // The default branch: main, master, or origin HEAD.
  expect(cardIdentity(owned, worktree({ branch: "main" }))).toEqual({ state: "none" });
  expect(cardIdentity(owned, worktree({ branch: "master" }))).toEqual({ state: "none" });
  expect(cardIdentity(owned, worktree({ branch: "develop", defaultBranch: "develop" }))).toEqual({ state: "none" });
  expect(cardIdentity(owned, worktree({ branch: "HEAD" }))).toEqual({ state: "none" });
  // Not a git folder, or no origin.
  expect(cardIdentity(owned, worktree({ remoteUrl: null }))).toEqual({ state: "none" });
  // Nothing read: unknown, not none.
  expect(cardIdentity(owned, null)).toEqual({ state: "unknown" });
});

async function folderFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-ledgers-")));
  roots.push(root);
  const reviews = join(root, "extra", "reviews");
  await mkdir(join(reviews, "Acme-Widgets"), { recursive: true });
  return { root, reviews, dir: join(reviews, "Acme-Widgets") };
}

test("matching: pr, pr-merged, branch, case-insensitive folder, exact names only", async () => {
  const x = await folderFixture();
  await writeFile(join(x.dir, "pr-42.md"), ledger(round2));
  await writeFile(join(x.dir, "pr-43-merged.md"), ledger(round2));
  await writeFile(join(x.dir, "branch-feat-ledger-sync.md"), ledger(round2));
  await writeFile(join(x.dir, "pr-420.md"), ledger(round2));
  const folder = new LedgerFolder(x.reviews);
  expect(await folder.find({ owner: "acme", repo: "widgets", pr: 42 })).toEqual({ path: join(x.dir, "pr-42.md"), via: "pr" });
  expect(await folder.find({ owner: "ACME", repo: "widgets", pr: 43 })).toEqual({ path: join(x.dir, "pr-43-merged.md"), via: "pr" });
  expect(await folder.find({ owner: "acme", repo: "widgets", pr: 44, branch: "feat/ledger-sync" })).toEqual({ path: join(x.dir, "branch-feat-ledger-sync.md"), via: "branch" });
  expect(await folder.find({ owner: "acme", repo: "widgets", pr: 4 })).toBeNull();
  expect(await folder.find({ owner: "acme", repo: "widgets", branch: "feat/ledger" })).toBeNull();
  expect(await folder.find({ owner: "acme", repo: "gadgets", pr: 42 })).toBeNull();
});

test("folder check: must exist and lie inside an extra artifact folder", async () => {
  const x = await folderFixture();
  expect(await ledgerFolderState(x.reviews, [join(x.root, "extra")], x.root + "-home")).toEqual({ usable: true, folder: x.reviews });
  expect(await ledgerFolderState(x.reviews, [x.reviews], x.root + "-home")).toEqual({ usable: true, folder: x.reviews });
  expect(await ledgerFolderState(x.reviews, [], x.root + "-home")).toEqual({ usable: false, reason: "outside" });
  expect(await ledgerFolderState(join(x.root, "nope"), [x.root], x.root + "-home")).toEqual({ usable: false, reason: "missing" });
  expect(reviewLedgerSettingsValues({})).toEqual({ attach: true, folder: "~/.claude/reviews" });
  expect(reviewLedgerSettingsValues({ attach: false, folder: " /tmp/r/ " })).toEqual({ attach: false, folder: "/tmp/r" });
});

test("git facts: a non-git folder gives nothing; a repo gives origin, branch and origin HEAD", async () => {
  const x = await folderFixture();
  expect(await gitFacts()(x.root)).toBeNull();
  const repo = join(x.root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, ...args]);
  await git("init", "-q", "-b", "feat/local");
  await git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  expect(await gitFacts()(repo)).toEqual({ remoteUrl: "git@github.com:acme/widgets.git", branch: "feat/local", defaultBranch: null });
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect((await gitFacts()(repo))?.defaultBranch).toBe("trunk");
});

type CardSpec = { id: string; prRef?: string; workspaceId?: string; archived?: boolean; owns?: boolean };
async function boardFixture(cards: CardSpec[], git: (dir: string) => Promise<GitFacts | null> = async () => null) {
  const x = await folderFixture();
  const store = new BoardStore(join(x.root, "data"), { storage: { checkVersion: false } });
  await store.mutate((board) => {
    board.projects.push({
      id: "p",
      paseoProjectId: "native-p",
      title: "p",
      description: "",
      primaryPath: x.root,
      repos: [x.root],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    } as never);
    cards.forEach((c, i) =>
      board.tasks.push({
        id: c.id,
        projectId: "p",
        workspaceId: c.workspaceId ?? `w-${c.id}`,
        sourcePath: x.root,
        repoPaths: [],
        title: c.id,
        description: "",
        status: "development",
        priority: "normal",
        position: i,
        revision: 1,
        operationId: `op-${c.id}`,
        ownsWorkspace: c.owns ?? true,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: c.archived ? stamp : null,
        ...(c.prRef ? { prRef: c.prRef } : {}),
      } as Task),
    );
  });
  const workspaces = new Map<string, unknown>();
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [...workspaces.entries()].map(([id, w]) => ({ id, ...(w as object) })), pageInfo: { nextCursor: null } }),
      ref: (id: string) => ({ refresh: async () => (workspaces.has(id) ? { id, ...(workspaces.get(id) as object) } : null) }),
    },
  } as unknown as PaseoApi;
  let now = 0;
  const ledgers = new ReviewLedgers(store, git, () => now);
  let attach = true;
  ledgers.settings = async () => ({ attach, folder: x.reviews });
  ledgers.extraFolders = async () => [join(x.root, "extra")];
  ledgers.paseo = () => paseo;
  const own = async (taskId: string) => (await store.read()).artifacts.filter((a) => a.taskId === taskId && a.origin === "review-ledger");
  /** A Paseo worktree descriptor; each card gets its own folder unless `directory` is given. */
  const tree = (branch: string, pr?: number, directory = join(x.root, `wt-${branch}-${pr ?? ""}`), kind = "worktree") => ({
    workspaceDirectory: directory,
    workspaceKind: kind,
    gitRuntime: { currentBranch: branch, remoteUrl: "git@github.com:acme/widgets.git" },
    githubRuntime: pr ? { pullRequest: { number: pr, repoOwner: "acme", repoName: "widgets" } } : null,
  });
  return { ...x, store, ledgers, workspaces, own, tree, later: () => (now += 60_000), setAttach: (v: boolean) => (attach = v) };
}

test("sweep: attaches as a Flowly-owned output with the round summary; a dev card and its review card share a PR", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }, { id: "b" }, { id: "none" }, { id: "gone", prRef: "acme/widgets#42", archived: true }]);
  x.workspaces.set("w-b", x.tree("feat/other", 42));
  await writeFile(join(x.dir, "pr-42.md"), ledger(round2));
  expect(await x.ledgers.tick()).toBe(2);
  for (const id of ["a", "b"])
    expect(await x.own(id)).toEqual([
      expect.objectContaining({
        role: "output",
        kind: "file",
        target: join(x.dir, "pr-42.md"),
        title: "Review ledger (pr-42)",
        note: "Review: round 2 · 1 open, 2 fixed, 1 deferred",
        createdBy: "human",
        origin: "review-ledger",
      }),
    ]);
  const board = await x.store.read();
  expect(board.artifacts.filter((a) => a.taskId === "none" || a.taskId === "gone")).toEqual([]);
  expect(board.events.filter((e) => e.action === "artifact_added")).toEqual([
    expect.objectContaining({ actor: "system", note: "Output: Review ledger (pr-42)" }),
    expect.objectContaining({ actor: "system", note: "Output: Review ledger (pr-42)" }),
  ]);
  // Nothing changed: the next sweep writes nothing.
  const revision = board.revision;
  expect(await x.ledgers.tick()).toBe(0);
  expect((await x.store.read()).revision).toBe(revision);
  // A new round updates the note in place.
  await writeFile(join(x.dir, "pr-42.md"), ledger(`${round2}\n## Round 3: 2026-11-04, 0a1b2c3, whole PR, opus\n- Finding 3: Race. Status: fixed in 0a1b2c3\n`));
  await x.ledgers.tick();
  expect((await x.own("a"))[0].note).toBe("Review: round 3 · 0 open, 1 fixed, 0 deferred");
  expect(artifactContextLines(await x.own("a"))).toEqual(["Outputs so far:", expect.stringMatching(/^- \[flowly\] Review ledger \(pr-42\): /)]);
});

test("no branch match on shared, unowned, non-worktree or default-branch checkouts, nor for a prRef card", async () => {
  const x = await boardFixture([
    { id: "unowned", owns: false },
    { id: "local" },
    { id: "d1" },
    { id: "d2" },
    { id: "main" },
    { id: "trunk" },
    { id: "ref", prRef: "acme/widgets#77" },
  ], async (dir) => (dir.endsWith("trunk") ? { remoteUrl: null, branch: null, defaultBranch: "trunk" } : null));
  for (const b of ["feat-a", "feat-b", "feat-d", "main", "trunk", "feat-ref"]) await writeFile(join(x.dir, `branch-${b}.md`), ledger(round2));
  x.workspaces.set("w-unowned", x.tree("feat-a"));
  x.workspaces.set("w-local", x.tree("feat-b", undefined, join(x.root, "main-checkout"), "local_checkout"));
  // Two workspaces on the same folder (the board never binds one workspace to two cards).
  x.workspaces.set("w-d1", x.tree("feat-d", undefined, join(x.root, "same")));
  x.workspaces.set("w-d2", x.tree("feat-d", undefined, join(x.root, "same")));
  x.workspaces.set("w-main", x.tree("main"));
  x.workspaces.set("w-trunk", x.tree("trunk", undefined, join(x.root, "trunk")));
  // A prRef card never falls back to its branch.
  x.workspaces.set("w-ref", x.tree("feat-ref"));
  expect(await x.ledgers.tick()).toBe(0);
  expect((await x.store.read()).artifacts).toEqual([]);
});

test("two cards matching one branch ledger: neither gets it; a PR ledger still goes to both", async () => {
  const x = await boardFixture([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
  await writeFile(join(x.dir, "branch-feat-dup.md"), ledger(round2));
  await writeFile(join(x.dir, "pr-9.md"), ledger(round2));
  x.workspaces.set("w-a", x.tree("feat/dup", undefined, join(x.root, "clone-a")));
  x.workspaces.set("w-b", x.tree("feat/dup", undefined, join(x.root, "clone-b")));
  x.workspaces.set("w-c", x.tree("feat/c", 9));
  x.workspaces.set("w-d", x.tree("feat/d", 9));
  await x.ledgers.tick();
  expect(await x.own("a")).toEqual([]);
  expect(await x.own("b")).toEqual([]);
  expect((await x.own("c")).map((r) => r.target)).toEqual([join(x.dir, "pr-9.md")]);
  expect((await x.own("d")).map((r) => r.target)).toEqual([join(x.dir, "pr-9.md")]);
  // Card open sees the ambiguity too.
  x.later();
  await x.ledgers.syncCard("a");
  expect(await x.own("a")).toEqual([]);
  // Once b leaves the branch, a gets it.
  x.workspaces.set("w-b", x.tree("feat/other", undefined, join(x.root, "clone-b")));
  await x.ledgers.tick();
  expect((await x.own("a")).map((r) => r.target)).toEqual([join(x.dir, "branch-feat-dup.md")]);
});

test("rename branch- to pr- swaps the record; a deleted ledger goes after two syncs in a row", async () => {
  const x = await boardFixture([{ id: "a" }]);
  x.workspaces.set("w-a", x.tree("feat/ledger-sync", undefined, join(x.root, "wt-a")));
  await writeFile(join(x.dir, "branch-feat-ledger-sync.md"), ledger(round2));
  await x.ledgers.tick();
  const first = await x.own("a");
  expect(first.map((a) => a.target)).toEqual([join(x.dir, "branch-feat-ledger-sync.md")]);
  x.workspaces.set("w-a", x.tree("feat/ledger-sync", 51, join(x.root, "wt-a")));
  await rename(join(x.dir, "branch-feat-ledger-sync.md"), join(x.dir, "pr-51.md"));
  await x.ledgers.tick();
  const second = await x.own("a");
  expect(second.map((a) => a.target)).toEqual([join(x.dir, "pr-51.md")]);
  expect(second[0].id).not.toBe(first[0].id);
  await rename(join(x.dir, "pr-51.md"), join(x.dir, "pr-51-merged.md"));
  await x.ledgers.tick();
  expect((await x.own("a")).map((a) => a.target)).toEqual([join(x.dir, "pr-51-merged.md")]);
  // Deleted: kept at the first sync (maybe a rewrite), gone at the second.
  await rm(join(x.dir, "pr-51-merged.md"));
  await x.ledgers.tick();
  expect(await x.own("a")).toHaveLength(1);
  await x.ledgers.tick();
  expect(await x.own("a")).toEqual([]);
  const actions = (await x.store.read()).events.filter((e) => e.action.startsWith("artifact_")).map((e) => e.action);
  expect(actions).toEqual(["artifact_added", "artifact_removed", "artifact_added", "artifact_removed", "artifact_added", "artifact_removed"]);
});

test("a ledger missing at one sync and back at the next is never churned", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }]);
  const path = join(x.dir, "pr-42.md");
  await writeFile(path, ledger(round2));
  await x.ledgers.tick();
  const [record] = await x.own("a");
  await rm(path);
  await x.ledgers.tick();
  await writeFile(path, ledger(round2));
  await x.ledgers.tick();
  expect((await x.own("a")).map((r) => r.id)).toEqual([record.id]);
  expect((await x.store.read()).events.filter((e) => e.action === "artifact_removed")).toEqual([]);
});

test("a card that no longer matches loses the record at once; unreadable facts keep it", async () => {
  const x = await boardFixture([{ id: "a" }, { id: "b" }]);
  await writeFile(join(x.dir, "branch-feat-a.md"), ledger(round2));
  await writeFile(join(x.dir, "branch-feat-b.md"), ledger(round2));
  x.workspaces.set("w-a", x.tree("feat/a"));
  x.workspaces.set("w-b", x.tree("feat/b"));
  await x.ledgers.tick();
  expect(await x.own("a")).toHaveLength(1);
  expect(await x.own("b")).toHaveLength(1);
  // a's worktree moved to a branch with no ledger: removed now, though the file still exists.
  x.workspaces.set("w-a", x.tree("feat/elsewhere"));
  // b's workspace can't be read this time: kept.
  x.workspaces.delete("w-b");
  await x.ledgers.tick();
  expect(await x.own("a")).toEqual([]);
  expect(await x.own("b")).toHaveLength(1);
});

test("agent and person artifacts are never touched, and the ledger an agent attached is not duplicated", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }, { id: "b", prRef: "acme/widgets#43" }]);
  const path = join(x.dir, "pr-42.md");
  await writeFile(path, ledger(round2));
  await writeFile(join(x.dir, "notes.md"), "made-up notes");
  await x.store.transaction((board) => {
    putArtifact(x.store, board, { taskId: "a", role: "output", kind: "file", target: path, title: "Ledger", note: "mine", createdBy: "agent", agentId: "ag" });
    putArtifact(x.store, board, { taskId: "b", role: "input", kind: "file", target: join(x.dir, "notes.md"), createdBy: "human" });
    return { value: null, changed: true };
  });
  await x.ledgers.tick();
  let board = await x.store.read();
  expect(board.artifacts.filter((a) => a.taskId === "a")).toEqual([expect.objectContaining({ createdBy: "agent", note: "mine", title: "Ledger" })]);
  expect(board.artifacts.filter((a) => a.taskId === "b")).toEqual([expect.objectContaining({ createdBy: "human", role: "input" })]);
  // Flowly's record, then an agent attaches the same file: the write reads the agent's from the store, not a stale snapshot.
  await x.store.transaction((b) => {
    b.artifacts = b.artifacts.filter((a) => a.taskId !== "a");
    return { value: null, changed: true };
  });
  await x.ledgers.tick();
  expect(await x.own("a")).toHaveLength(1);
  const stale = await x.store.read();
  await x.store.transaction((b) => {
    putArtifact(x.store, b, { taskId: "a", role: "output", kind: "file", target: path, title: "Mine", createdBy: "agent", agentId: "ag" });
    return { value: null, changed: true };
  });
  // putArtifact matched Flowly's record by target and left it (it is the user's kind); add a distinct agent copy instead.
  await x.store.transaction((b) => {
    b.artifacts.push({ ...b.artifacts.find((a) => a.taskId === "a")!, id: "agent-copy", origin: undefined, createdBy: "agent" });
    return { value: null, changed: true };
  });
  expect((await applyLedger(x.store, "a", { path, note: "x" }, { snapshot: stale })).changed).toBe(true);
  board = await x.store.read();
  expect(board.artifacts.filter((a) => a.taskId === "a").map((a) => a.id)).toEqual(["agent-copy"]);
  // Deleting the file never removes the agent's record.
  await rm(path);
  await x.ledgers.tick();
  await x.ledgers.tick();
  expect((await x.store.read()).artifacts.filter((a) => a.taskId === "a").map((a) => a.id)).toEqual(["agent-copy"]);
});

test("agents can neither remove nor edit Flowly's record; a person's role or title edit takes it over", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }]);
  const path = join(x.dir, "pr-42.md");
  await writeFile(path, ledger(round2));
  await x.ledgers.tick();
  const [record] = await x.own("a");
  await expect(x.store.transaction((board) => ({ value: dropArtifact(x.store, board, record.id, { createdBy: "agent", agentId: "ag" }), changed: true }))).rejects.toThrow(
    "Only the user can remove",
  );
  const put = await x.store.transaction((board) => {
    const r = putArtifact(x.store, board, { taskId: "a", role: "input", kind: "file", target: path, note: "agent note", createdBy: "agent", agentId: "ag" });
    return { value: r, changed: r.changed };
  });
  expect(put).toMatchObject({ changed: false, notice: expect.stringContaining("role not changed") });
  expect(await x.own("a")).toEqual([expect.objectContaining({ id: record.id, role: "output", note: record.note })]);
  // A person's note edit keeps Flowly managing it (the next sync resets the note).
  const noted = await editArtifact(x.store, { id: record.id, updatedAt: record.updatedAt, note: "my note" });
  expect(noted.origin).toBe("review-ledger");
  // A title edit hands it over: Flowly stops managing it and adds no second one.
  const taken = await editArtifact(x.store, { id: record.id, updatedAt: noted.updatedAt, title: "Our ledger" });
  expect(taken.origin).toBeUndefined();
  x.later();
  await x.ledgers.tick();
  expect(await x.own("a")).toEqual([]);
  expect((await x.store.read()).artifacts.filter((a) => a.taskId === "a")).toEqual([expect.objectContaining({ id: record.id, title: "Our ledger", note: "my note" })]);
});

test("off, or a folder outside the extra folders: nothing attaches", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }]);
  await writeFile(join(x.dir, "pr-42.md"), ledger(round2));
  x.setAttach(false);
  expect(await x.ledgers.tick()).toBe(0);
  expect(await x.ledgers.check()).toEqual({ attach: false, usable: true });
  x.setAttach(true);
  x.ledgers.extraFolders = async () => [];
  expect(await x.ledgers.tick()).toBe(0);
  expect(await x.ledgers.check()).toEqual({ attach: true, usable: false, reason: "outside" });
  expect(await x.own("a")).toEqual([]);
});

test("card open: synced once, then throttled for 30 seconds", async () => {
  const x = await boardFixture([{ id: "a", prRef: "acme/widgets#42" }]);
  await x.ledgers.syncCard("a");
  expect(await x.own("a")).toEqual([]);
  await writeFile(join(x.dir, "pr-42.md"), ledger(round2));
  await x.ledgers.syncCard("a");
  expect(await x.own("a")).toEqual([]);
  x.later();
  await x.ledgers.syncCard("a");
  expect(await x.own("a")).toHaveLength(1);
});

test("card open and get_task wait at most the cap; the sync finishes in the background", async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  const x = await boardFixture([{ id: "a" }], async () => {
    await held;
    return null;
  });
  x.workspaces.set("w-a", x.tree("feat/slow"));
  await writeFile(join(x.dir, "branch-feat-slow.md"), ledger(round2));
  const started = Date.now();
  await x.ledgers.syncCardSoon("a", undefined, 50);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await x.own("a")).toEqual([]);
  release();
  await expect.poll(async () => (await x.own("a")).length).toBe(1);
});
