import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { PrReviewArchiver, archiveLookupsPerTick, type PrState, type PrTarget } from "./pr-review-archive";
import { ancestorLanded, baseBranch, cardPrOutputs, ghHeadPrMerged, runGit, type GitRun, type RunIn } from "./landed-done";
import type { Artifact, Status, Task } from "../shared/model";

// Moving a card to Done when its work lands (LANDED-DONE-SPEC). Made-up repositories and PRs only; the git
// repositories are local temporary ones (a bare "origin" next to each clone), never the network.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const stamp = "2026-11-16T09:00:00.000Z";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_TERMINAL_PROMPT: "0" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

type Output = { url?: string; external?: string; role?: "input" | "output" };
type CardSpec = {
  id: string;
  status?: Status;
  review?: boolean;
  prRef?: string;
  outputs?: Output[];
  baseRef?: string;
  workspaceId?: string;
  archived?: boolean;
};

let uid = 0;
function artifact(taskId: string, o: Output): Artifact {
  const n = ++uid;
  return {
    id: `a${n}`,
    taskId,
    projectId: "p",
    role: o.role ?? "output",
    kind: "url",
    target: o.url ?? `https://github.com/${o.external!.replace("#", "/pull/")}`,
    title: `PR ${n}`,
    note: "",
    createdBy: "agent",
    createdAt: stamp,
    updatedAt: stamp,
    ...(o.external ? { external: { connectionId: "gh1", provider: "github", key: o.external, remoteId: "", itemType: "pull" } } : {}),
  } as Artifact;
}

type Where = { directory: string; worktree: boolean } | null;

async function fixture(
  cards: CardSpec[],
  options: { states?: Record<string, PrState | null | "throw">; where?: Record<string, Where>; gh?: Record<string, string | Error> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "flowly-landed-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"), { storage: { checkVersion: false } });
  await store.mutate((board) => {
    board.projects.push({
      id: "p",
      paseoProjectId: "native-p",
      title: "p",
      description: "",
      primaryPath: root,
      repos: [root],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    } as never);
    cards.forEach((c, i) => {
      board.tasks.push({
        id: c.id,
        projectId: "p",
        workspaceId: c.workspaceId ?? `w-${c.id}`,
        sourcePath: root,
        repoPaths: [],
        title: `Card ${c.id}`,
        description: "",
        status: c.status ?? "in_review",
        priority: "normal",
        position: i,
        revision: 1,
        operationId: c.review ? `pr-review:agent-${c.id}` : `op-${c.id}`,
        ownsWorkspace: true,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: c.archived ? stamp : null,
        ...(c.prRef ? { prRef: c.prRef } : {}),
        ...(c.baseRef ? { baseRef: c.baseRef } : {}),
      } as Task);
      for (const o of c.outputs ?? []) board.artifacts.push(artifact(c.id, o));
    });
  });
  const running = new Set<string>();
  const paseo = {
    agents: {
      list: async () => ({
        entries: [...running].map((workspaceId, i) => ({ agent: { id: `a${i}`, workspaceId, status: "running", archivedAt: null } })),
        pageInfo: { nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  const looked: string[] = [];
  const states = options.states ?? {};
  const lookup = async (pr: PrTarget) => {
    looked.push(pr.key);
    const state = states[pr.key];
    if (state === "throw") throw new Error("offline");
    return state ?? null;
  };
  const ghCalls: { args: readonly string[]; cwd: string }[] = [];
  const gh: RunIn = async (file, args, cwd) => {
    ghCalls.push({ args: [file, ...args], cwd });
    const branch = args[args.indexOf("--head") + 1];
    const out = options.gh?.[branch];
    if (out === undefined || out instanceof Error) throw out ?? new Error("gh: no such PR list");
    return out;
  };
  const logs: string[] = [];
  const switches = { review: true, done: true };
  const archiver = new PrReviewArchiver(store, lookup, () => Date.now(), (line) => logs.push(line));
  archiver.enabled = async () => switches.review;
  archiver.doneOnLand = async () => switches.done;
  archiver.paseo = () => paseo;
  archiver.workspace = async (task) => options.where?.[task.workspaceId] ?? null;
  archiver.gh = gh;
  const afterDone: { taskId: string; previous: Status }[] = [];
  archiver.afterDone = (taskId, previous) => afterDone.push({ taskId, previous });
  const card = async (id: string) => (await store.read()).tasks.find((t) => t.id === id)!;
  const events = async (id: string) => (await store.read()).events.filter((e) => e.taskId === id);
  return { store, archiver, running, looked, logs, switches, ghCalls, afterDone, card, events, paseo, lookup };
}

/**
 * A clone with a bare origin and `main` pushed; the card's workspace is a git worktree of it on branch `feature`
 * (`git worktree add -b feature`, as Paseo makes one), so its HEAD reflog starts at its creation.
 */
async function repo(shape: { commits: number; pushed?: boolean; dirty?: boolean; detached?: boolean; noOrigin?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "flowly-landed-git-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  await mkdir(work);
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(work, "init", "-b", "main");
  await writeFile(join(work, "a.txt"), "a\n");
  sh(work, "add", "a.txt");
  sh(work, "commit", "-m", "base");
  if (!shape.noOrigin) {
    sh(work, "remote", "add", "origin", origin);
    sh(work, "push", "origin", "main");
  }
  const wt = join(root, "wt");
  sh(work, "worktree", "add", "-q", "-b", "feature", wt, "main");
  for (let i = 0; i < shape.commits; i++) {
    await writeFile(join(wt, `f${i}.txt`), `${i}\n`);
    sh(wt, "add", `f${i}.txt`);
    sh(wt, "commit", "-m", `feature ${i}`);
  }
  // Landed: the branch's commits reached origin/main (a merge or fast-forward elsewhere); the local main is not moved.
  if (shape.pushed) sh(wt, "push", "-q", "origin", "feature:main");
  if (shape.dirty) await writeFile(join(wt, "wip.txt"), "wip\n");
  if (shape.detached) sh(wt, "checkout", "-q", "--detach", "HEAD");
  return wt;
}

const merged = (n: number, headRefOid: string, isCrossRepository = false) =>
  JSON.stringify([{ number: n, state: "MERGED", url: `https://github.com/acme/widgets/pull/${n}`, mergedAt: stamp, headRefOid, isCrossRepository }]);

/** Moves origin/main on by one commit from another clone, as a teammate's merge would. */
async function advanceOrigin(work: string) {
  const origin = sh(work, "remote", "get-url", "origin");
  const other = await mkdtemp(join(tmpdir(), "flowly-landed-other-"));
  roots.push(other);
  sh(other, "clone", "-q", origin, "c");
  const c = join(other, "c");
  await writeFile(join(c, "other.txt"), "other\n");
  sh(c, "add", "other.txt");
  sh(c, "commit", "-m", "someone else");
  sh(c, "push", "-q", "origin", "HEAD:main");
}

test("a card whose single PR output is merged moves to Done with a system note; an open PR changes nothing", async () => {
  const x = await fixture(
    [
      { id: "m", outputs: [{ url: "https://github.com/Acme/Widgets/pull/1" }] },
      { id: "c", status: "committed", outputs: [{ external: "acme/widgets#2" }] },
      { id: "i", status: "integrated", outputs: [{ url: "https://github.com/acme/widgets/pull/3" }, { external: "acme/widgets#3" }] },
      { id: "o", outputs: [{ url: "https://github.com/acme/widgets/pull/4" }] },
    ],
    { states: { "acme/widgets#1": "merged", "acme/widgets#2": "merged", "acme/widgets#3": "merged", "acme/widgets#4": "open" } },
  );
  const out = await x.archiver.tick();
  expect(out).toEqual(
    expect.arrayContaining([
      { taskId: "m", done: "pr", pr: "acme/widgets#1" },
      { taskId: "c", done: "pr", pr: "acme/widgets#2" },
      { taskId: "i", done: "pr", pr: "acme/widgets#3" },
    ]),
  );
  expect(out).toHaveLength(3);
  const m = await x.card("m");
  expect(m.status).toBe("done");
  expect(m.revision).toBe(2);
  expect(m.archivedAt).toBeNull();
  expect((await x.events("m")).at(-1)).toMatchObject({ action: "status_changed", actor: "system", from: "in_review", to: "done", note: "Moved to Done: PR merged (acme/widgets#1)" });
  expect((await x.events("c")).at(-1)).toMatchObject({ from: "committed", to: "done" });
  // Everything that follows a person's move into Done follows here too.
  expect(x.afterDone).toEqual(expect.arrayContaining([{ taskId: "m", previous: "in_review" }, { taskId: "c", previous: "committed" }, { taskId: "i", previous: "integrated" }]));
  expect(x.afterDone).toHaveLength(3);
  const o = await x.card("o");
  expect(o.status).toBe("in_review");
  expect(o.revision).toBe(1);
  expect(await x.events("o")).toEqual([]);
});

test("a closed PR adds one note, never twice, even after a restart; the card stays in its lane", async () => {
  const x = await fixture([{ id: "c", outputs: [{ url: "https://github.com/acme/widgets/pull/9" }] }], { states: { "acme/widgets#9": "closed" } });
  expect(await x.archiver.tick()).toEqual([{ taskId: "c", note: "closed", pr: "acme/widgets#9" }]);
  expect(await x.archiver.tick()).toEqual([]);
  // A restart: a new archiver over the same store.
  const again = new PrReviewArchiver(x.store, x.lookup, () => Date.now(), () => undefined);
  again.paseo = () => x.paseo;
  expect(await again.tick()).toEqual([]);
  const notes = (await x.events("c")).filter((e) => e.action === "note");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ actor: "system", note: "PR closed without merging: acme/widgets#9" });
  const c = await x.card("c");
  expect(c.status).toBe("in_review");
  expect(c.archivedAt).toBeNull();
  expect(x.afterDone).toEqual([]);
});

test("a worktree card whose branch has landed on origin/<base> moves to Done; fresh, dirty and unpushed ones stay", async () => {
  const [landed, fresh, dirty, unpushed, detached] = await Promise.all([
    repo({ commits: 2, pushed: true }),
    repo({ commits: 0 }),
    repo({ commits: 1, pushed: true, dirty: true }),
    repo({ commits: 1 }),
    repo({ commits: 1, pushed: true, detached: true }),
  ]);
  const x = await fixture(
    [
      { id: "landed", baseRef: "refs/heads/main" },
      { id: "fresh", baseRef: "refs/heads/main" },
      { id: "dirty", baseRef: "refs/heads/main" },
      { id: "unpushed", baseRef: "refs/heads/main" },
      { id: "detached", baseRef: "refs/heads/main" },
    ],
    {
      where: {
        "w-landed": { directory: landed, worktree: true },
        "w-fresh": { directory: fresh, worktree: true },
        "w-dirty": { directory: dirty, worktree: true },
        "w-unpushed": { directory: unpushed, worktree: true },
        "w-detached": { directory: detached, worktree: true },
      },
      // No PR is headed by these branches.
      gh: { feature: "[]" },
    },
  );
  expect(await x.archiver.tick()).toEqual([{ taskId: "landed", done: "landed", base: "main" }]);
  expect((await x.card("landed")).status).toBe("done");
  expect((await x.events("landed")).at(-1)).toMatchObject({ action: "status_changed", actor: "system", to: "done", note: "Moved to Done: work landed on main" });
  for (const id of ["fresh", "dirty", "unpushed", "detached"]) {
    expect((await x.card(id)).status).toBe("in_review");
    expect(await x.events(id)).toEqual([]);
  }
  // The head-PR lookup runs in the card's own directory, as an argument array; a detached HEAD skips it.
  expect(x.ghCalls.map((c) => c.args)).toContainEqual(["gh", "pr", "list", "--head", "feature", "--state", "all", "--json", "number,state,url,mergedAt,headRefOid,isCrossRepository", "--limit", "5"]);
  expect(x.ghCalls.map((c) => c.cwd)).not.toContain(detached);
  expect(x.ghCalls.map((c) => c.cwd)).toContain(landed);
});

test("a worktree card whose branch heads a merged PR moves to Done without the ancestor check", async () => {
  const work = await repo({ commits: 1 }); // not on origin/main: only the PR can move it
  const x = await fixture([{ id: "h", status: "integrated", baseRef: "refs/heads/main" }], {
    where: { "w-h": { directory: work, worktree: true } },
    gh: { feature: merged(12, sh(work, "rev-parse", "HEAD")) },
  });
  expect(await x.archiver.tick()).toEqual([{ taskId: "h", done: "branch-pr", pr: "acme/widgets#12" }]);
  expect((await x.events("h")).at(-1)).toMatchObject({ actor: "system", from: "integrated", to: "done", note: "Moved to Done: PR merged (acme/widgets#12)" });
});

test("a closed PR found by the branch gets no note, and the ancestor check still decides", async () => {
  const work = await repo({ commits: 1, pushed: true });
  const x = await fixture([{ id: "h", baseRef: "refs/heads/main" }], {
    where: { "w-h": { directory: work, worktree: true } },
    gh: { feature: JSON.stringify([{ number: 5, state: "CLOSED", url: "https://github.com/acme/widgets/pull/5", mergedAt: null }]) },
  });
  expect(await x.archiver.tick()).toEqual([{ taskId: "h", done: "landed", base: "main" }]);
  expect((await x.events("h")).some((e) => e.action === "note")).toBe(false);
});

test("cards out of the lanes, busy, with two PRs, without a worktree, or unreadable stay", async () => {
  const noOrigin = await repo({ commits: 1, noOrigin: true });
  const lanes: Status[] = ["todo", "design", "development", "test", "blocked", "backlog", "done", "cancelled"];
  const x = await fixture(
    [
      ...lanes.map((status) => ({ id: `lane-${status}`, status, outputs: [{ url: `https://github.com/acme/widgets/pull/${lanes.indexOf(status) + 100}` }] })),
      { id: "busy", workspaceId: "w-run", outputs: [{ url: "https://github.com/acme/widgets/pull/1" }] },
      { id: "two", outputs: [{ url: "https://github.com/acme/widgets/pull/2" }, { external: "acme/widgets#3" }] },
      { id: "input-only", outputs: [{ url: "https://github.com/acme/widgets/pull/4", role: "input" }] },
      { id: "dir", baseRef: "refs/heads/main" },
      { id: "nobase" },
      { id: "unknown-pr", outputs: [{ url: "https://github.com/acme/widgets/pull/6" }] },
      { id: "unknown-git", baseRef: "refs/heads/main" },
      { id: "gone", archived: true, outputs: [{ url: "https://github.com/acme/widgets/pull/7" }] },
    ],
    {
      states: Object.fromEntries([...lanes.map((_, i) => [`acme/widgets#${i + 100}`, "merged"]), ["acme/widgets#1", "merged"], ["acme/widgets#2", "merged"], ["acme/widgets#3", "merged"], ["acme/widgets#4", "merged"], ["acme/widgets#6", "throw"], ["acme/widgets#7", "merged"]]),
      where: { "w-dir": { directory: noOrigin, worktree: false }, "w-unknown-git": { directory: noOrigin, worktree: true } },
    },
  );
  x.running.add("w-run");
  expect(await x.archiver.tick()).toEqual([]);
  // Only the one-PR card that is not busy is looked up; two PRs, input-only and lanes outside R2 never are.
  expect(x.looked).toEqual(["acme/widgets#6"]);
  // The directory card gets no git check.
  expect(x.ghCalls.map((c) => c.cwd)).toEqual([noOrigin]);
  const board = await x.store.read();
  expect(board.tasks.filter((t) => t.revision !== 1).map((t) => t.id)).toEqual([]);
  expect(board.events).toEqual([]);
});

test("with the switch off no ordinary card moves but review cards still archive, and the reverse", async () => {
  const cards: CardSpec[] = [
    { id: "rev", review: true, prRef: "acme/widgets#1" },
    { id: "card", outputs: [{ url: "https://github.com/acme/widgets/pull/2" }] },
  ];
  const states = { "acme/widgets#1": "merged", "acme/widgets#2": "merged" } as const;
  const off = await fixture(cards, { states });
  off.switches.done = false;
  expect(await off.archiver.tick()).toEqual([{ taskId: "rev", state: "merged" }]);
  expect(off.looked).toEqual(["acme/widgets#1"]);
  expect((await off.card("card")).status).toBe("in_review");

  const reviewOff = await fixture(cards, { states });
  reviewOff.switches.review = false;
  expect(await reviewOff.archiver.tick()).toEqual([{ taskId: "card", done: "pr", pr: "acme/widgets#2" }]);
  expect((await reviewOff.card("rev")).archivedAt).toBeNull();

  const both = await fixture(cards, { states });
  both.switches.review = both.switches.done = false;
  expect(await both.archiver.tick()).toEqual([]);
  expect(both.looked).toEqual([]);
});

test("review cards and ordinary cards share one check and one lookup cap, least recently checked first", async () => {
  const review = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, review: true, prRef: `acme/widgets#${200 + i}` }));
  const plain = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, outputs: [{ url: `https://github.com/acme/widgets/pull/${300 + i}` }] }));
  const x = await fixture([...review, ...plain]);
  await x.archiver.tick();
  expect(x.looked).toHaveLength(archiveLookupsPerTick);
  const first = new Set(x.looked);
  x.looked.length = 0;
  await x.archiver.tick();
  const all = [...review.map((c) => c.prRef), ...plain.map((c) => `acme/widgets#${c.outputs[0].url!.split("/").at(-1)}`)];
  const missed = all.filter((k) => !first.has(k));
  expect(missed).toHaveLength(5);
  expect(x.looked.slice(0, 5).sort()).toEqual(missed.sort());
});

test("a card that left the lanes, or whose PR changed, while it was looked up is left alone", async () => {
  const x = await fixture([
    { id: "moved", outputs: [{ url: "https://github.com/acme/widgets/pull/1" }] },
    { id: "swapped", outputs: [{ url: "https://github.com/acme/widgets/pull/2" }] },
  ]);
  const archiver = new PrReviewArchiver(x.store, async (pr) => {
    await x.store.mutate((b) => {
      if (pr.key === "acme/widgets#1") b.tasks.find((t) => t.id === "moved")!.status = "development";
      else b.artifacts.find((a) => a.taskId === "swapped")!.target = "https://github.com/acme/widgets/pull/22";
    });
    return "merged";
  });
  archiver.paseo = () => x.paseo;
  expect(await archiver.tick()).toEqual([]);
  expect((await x.card("moved")).status).toBe("development");
  expect((await x.card("swapped")).status).toBe("in_review");
});

test("an unreadable state for every card is logged once for both kinds", async () => {
  const x = await fixture([
    { id: "rev", review: true, prRef: "acme/widgets#1" },
    { id: "card", outputs: [{ url: "https://github.com/acme/widgets/pull/2" }] },
  ]);
  await x.archiver.tick();
  await x.archiver.tick();
  expect(x.logs).toHaveLength(1);
  expect(x.logs[0]).toMatch(/could not be read/);
});

test("PR outputs: GitHub pull URLs and pull refs, outputs only, one per distinct PR", () => {
  const a = (taskId: string, o: Output) => artifact(taskId, o);
  const list = [
    a("t", { url: "https://github.com/Acme/Widgets/pull/7" }),
    a("t", { external: "acme/widgets#7" }),
    a("t", { url: "https://github.com/acme/widgets/pull/8/files" }),
    a("t", { url: "https://github.com/acme/widgets/issues/9" }),
    a("t", { url: "https://github.com/acme/widgets/pull/10", role: "input" }),
    a("other", { url: "https://github.com/acme/widgets/pull/11" }),
  ];
  expect(cardPrOutputs(list, "t").map((p) => p.key)).toEqual(["acme/widgets#7", "acme/widgets#8"]);
});

test("the head-PR lookup: merged when any listed PR merged, false for none, null when unreadable", async () => {
  const run = (out: string | Error): RunIn => async () => {
    if (out instanceof Error) throw out;
    return out;
  };
  expect(await ghHeadPrMerged(run(merged(3, "abc")))("/w", "feature", "abc")).toEqual({ merged: true, pr: "acme/widgets#3" });
  // Same branch name, another head commit (a reused name), or a PR from a fork: not this card's PR.
  expect(await ghHeadPrMerged(run(merged(3, "old")))("/w", "feature", "abc")).toEqual({ merged: false });
  expect(await ghHeadPrMerged(run(merged(3, "abc", true)))("/w", "feature", "abc")).toEqual({ merged: false });
  expect(await ghHeadPrMerged(run(JSON.stringify([{ number: 4, state: "OPEN", mergedAt: null, headRefOid: "abc", isCrossRepository: false }])))("/w", "feature", "abc")).toEqual({ merged: false });
  expect(await ghHeadPrMerged(run("[]"))("/w", "feature", "abc")).toEqual({ merged: false });
  expect(await ghHeadPrMerged(run(new Error("gh missing")))("/w", "feature", "abc")).toBeNull();
  expect(await ghHeadPrMerged(run("not json"))("/w", "feature", "abc")).toBeNull();
});

test("a fresh branch fast-forwarded or reset to a newer origin/<base> made no commit of its own and stays", async () => {
  const [pulled, reset, own] = await Promise.all([repo({ commits: 0 }), repo({ commits: 0 }), repo({ commits: 1, pushed: true })]);
  await Promise.all([advanceOrigin(pulled), advanceOrigin(reset)]);
  sh(pulled, "pull", "-q", "--ff-only", "origin", "main");
  sh(reset, "fetch", "-q", "origin");
  sh(reset, "reset", "-q", "--hard", "origin/main");
  const x = await fixture(
    [
      { id: "pulled", baseRef: "refs/heads/main" },
      { id: "reset", baseRef: "refs/heads/main" },
      { id: "own", baseRef: "refs/heads/main" },
    ],
    {
      where: { "w-pulled": { directory: pulled, worktree: true }, "w-reset": { directory: reset, worktree: true }, "w-own": { directory: own, worktree: true } },
      gh: { feature: "[]" },
    },
  );
  expect(await x.archiver.tick()).toEqual([{ taskId: "own", done: "landed", base: "main" }]);
  expect((await x.card("pulled")).status).toBe("in_review");
  expect((await x.card("reset")).status).toBe("in_review");
});

test("a merged PR with the branch's name but another head commit, or from a fork, does not move the card", async () => {
  const [reused, fork] = await Promise.all([repo({ commits: 1 }), repo({ commits: 1 })]);
  const x = await fixture(
    [
      { id: "reused", baseRef: "refs/heads/main", workspaceId: "w-reused" },
      { id: "fork", baseRef: "refs/heads/main", workspaceId: "w-fork" },
    ],
    { where: { "w-reused": { directory: reused, worktree: true }, "w-fork": { directory: fork, worktree: true } } },
  );
  // Both branches are named "feature"; the fake answers per call by the directory it runs in.
  x.archiver.gh = async (_file, _args, cwd) => (cwd === reused ? merged(30, "0".repeat(40)) : merged(31, sh(fork, "rev-parse", "HEAD"), true));
  expect(await x.archiver.tick()).toEqual([]);
  expect((await x.card("reused")).status).toBe("in_review");
  expect((await x.card("fork")).status).toBe("in_review");
});

test("a session that starts during the check, or a card edited during its lookup, keeps the card where it is", async () => {
  const x = await fixture([
    { id: "started", outputs: [{ url: "https://github.com/acme/widgets/pull/1" }] },
    { id: "edited", outputs: [{ url: "https://github.com/acme/widgets/pull/2" }] },
  ]);
  const archiver = new PrReviewArchiver(x.store, async (pr) => {
    if (pr.key === "acme/widgets#1") x.running.add("w-started");
    else
      await x.store.mutate((b) => {
        const t = b.tasks.find((t) => t.id === "edited")!;
        t.title = "Renamed";
        t.revision++;
      });
    return "merged";
  });
  archiver.paseo = () => x.paseo;
  expect(await archiver.tick()).toEqual([]);
  expect((await x.card("started")).status).toBe("in_review");
  expect((await x.card("edited")).status).toBe("in_review");
});

test("the fetch names its refspec and runs without prompts, auto-gc or maintenance; tag bases get no check", async () => {
  const work = await repo({ commits: 1, pushed: true });
  const x = await fixture([{ id: "c", baseRef: "refs/heads/main" }], { where: { "w-c": { directory: work, worktree: true } }, gh: { feature: "[]" } });
  const calls: (readonly string[])[] = [];
  const recording: GitRun = (cwd, args) => {
    calls.push(args);
    return runGit(cwd, args);
  };
  x.archiver.git = recording;
  expect(await x.archiver.tick()).toEqual([{ taskId: "c", done: "landed", base: "main" }]);
  expect(calls).toContainEqual(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-auto-gc", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  expect(calls).toContainEqual(["--no-optional-locks", "status", "--porcelain"]);
  expect(calls).toContainEqual(["reflog", "show", "--format=%H%x09%gs", "HEAD", "--"]);
  expect(baseBranch("refs/heads/dev")).toBe("dev");
  expect(baseBranch("refs/tags/v1.0")).toBeNull();
  expect(baseBranch("main")).toBe("main");
});

test("own commits dropped by a reset, or a reused branch's earlier commits, do not count as the card's work", async () => {
  // Committed, then reset to a newer origin/main: the commit is in the reflogs but not in HEAD.
  const dropped = await repo({ commits: 1 });
  await advanceOrigin(dropped);
  sh(dropped, "fetch", "-q", "origin");
  sh(dropped, "reset", "-q", "--hard", "origin/main");
  // A branch name reused by a later card: the earlier card's commit landed, and a new worktree checks the branch out again.
  const first = await repo({ commits: 1, pushed: true });
  const clone = sh(first, "rev-parse", "--path-format=absolute", "--git-common-dir").replace(/\/\.git$/, "");
  sh(clone, "worktree", "remove", "--force", first);
  const reused = `${first}-again`;
  roots.push(reused);
  sh(clone, "worktree", "add", "-q", reused, "feature");
  const x = await fixture(
    [
      { id: "dropped", baseRef: "refs/heads/main" },
      { id: "reused", baseRef: "refs/heads/main" },
    ],
    { where: { "w-dropped": { directory: dropped, worktree: true }, "w-reused": { directory: reused, worktree: true } }, gh: { feature: "[]" } },
  );
  expect(await x.archiver.tick()).toEqual([]);
  expect((await x.card("dropped")).status).toBe("in_review");
  expect((await x.card("reused")).status).toBe("in_review");
});

test("the fetch keeps a configured SSH command and adds batch-mode SSH only when none is set", async () => {
  const work = await repo({ commits: 1, pushed: true });
  const fetchEnv = async (sshCommand: string | null) => {
    let seen: Record<string, string> | undefined;
    const git: GitRun = (cwd, args, env) => {
      if (args.includes("config") && args.includes("core.sshCommand")) return Promise.resolve(sshCommand ? { code: 0, stdout: `${sshCommand}\n` } : { code: 1, stdout: "" });
      if (args.includes("fetch")) seen = env;
      return runGit(cwd, args, env);
    };
    expect(await ancestorLanded(git, work, "feature", "main")).toBe("landed");
    return seen ?? {};
  };
  const saved = process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH_COMMAND;
  try {
    expect(await fetchEnv("ssh -i ~/.ssh/work_key")).not.toHaveProperty("GIT_SSH_COMMAND");
    expect(await fetchEnv(null)).toMatchObject({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    process.env.GIT_SSH_COMMAND = "ssh -i ~/.ssh/env_key";
    expect(await fetchEnv(null)).not.toHaveProperty("GIT_SSH_COMMAND");
  } finally {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved;
  }
});
