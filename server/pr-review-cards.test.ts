import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { PrReviewCards, prReviewWindowMs, type PrReviewAgent } from "./pr-review-cards";
import { isPrReviewCard, parsePrReviewLabel, prReviewOperationId, prReviewStatus } from "../shared/pr-review";
import { statuses } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const now = Date.parse("2026-11-05T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60000).toISOString();

async function fixture(project: { linearTicket?: boolean; inReview?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-pr-review-")));
  roots.push(root);
  const repo = join(root, "zenlytic"),
    scratch = join(root, "scratch");
  await mkdir(join(repo, "sub"), { recursive: true });
  await mkdir(scratch);
  const store = new BoardStore(join(root, "data"), { storage: { checkVersion: false } });
  const stamp = new Date(now).toISOString();
  await store.mutate((board) => {
    board.projects.push({
      id: "p",
      paseoProjectId: "native",
      title: "Zenlytic",
      description: "",
      primaryPath: repo,
      repos: [repo],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
      ...(project.linearTicket ? { linearTicket: true } : {}),
      ...(project.inReview === false ? { lanes: statuses.map((status) => ({ status, enabled: status !== "in_review" })) } : {}),
    });
  });
  const workspaces: Record<string, { id: string; projectId: string; workspaceDirectory: string; workspaceKind: string; archivingAt: string | null; projectDisplayName: string }> = {
    wks: { id: "wks", projectId: "native", workspaceDirectory: join(repo, "sub"), workspaceKind: "worktree", archivingAt: null, projectDisplayName: "Zenlytic" },
    wks2: { id: "wks2", projectId: "native", workspaceDirectory: join(repo, "sub"), workspaceKind: "worktree", archivingAt: null, projectDisplayName: "Zenlytic" },
    wks3: { id: "wks3", projectId: "native", workspaceDirectory: join(repo, "sub"), workspaceKind: "worktree", archivingAt: null, projectDisplayName: "Zenlytic" },
    scratch: { id: "scratch", projectId: "other", workspaceDirectory: scratch, workspaceKind: "directory", archivingAt: null, projectDisplayName: "Scratch" },
  };
  const agents: Record<string, PrReviewAgent> = {};
  let refreshes = 0;
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          refreshes++;
          return agents[id] ? { agent: agents[id] } : null;
        },
      }),
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => workspaces[id] ?? null }) },
  } as unknown as PaseoApi;
  const service = new BoardService(store);
  const logs: string[] = [];
  let on = true;
  const watcher = new PrReviewCards(service, () => now, (line) => logs.push(line));
  watcher.enabled = async () => on;
  const review = (id: string, extra: Partial<PrReviewAgent> = {}): PrReviewAgent => ({
    id,
    workspaceId: "wks",
    title: "PR review: Zenlytic/zenlytic#9164 Fix the thing",
    labels: { "pr-review-watch": "Zenlytic/zenlytic#9164" },
    createdAt: minutesAgo(1),
    archivedAt: null,
    ...extra,
  });
  return {
    store,
    service,
    watcher,
    paseo,
    agents,
    logs,
    review,
    refreshes: () => refreshes,
    setOn: (value: boolean) => (on = value),
  };
}

test("label parsing: owner/repo#n is split, other text is kept, empty is no review", () => {
  expect(parsePrReviewLabel("Zenlytic/zenlytic#9164")).toEqual({ text: "Zenlytic/zenlytic#9164", owner: "Zenlytic", repo: "zenlytic", number: 9164 });
  expect(parsePrReviewLabel("  some review ")).toEqual({ text: "some review" });
  expect(parsePrReviewLabel("")).toBeNull();
  expect(parsePrReviewLabel("   ")).toBeNull();
  expect(parsePrReviewLabel(undefined)).toBeNull();
});

test("a new review agent gets a card in In review, tagged pr-review, bound to its own workspace", async () => {
  const x = await fixture();
  const outcome = await x.watcher.consider(x.review("agent-1"), x.paseo);
  expect(outcome.kind).toBe("created");
  const board = await x.store.read();
  expect(board.tasks).toHaveLength(1);
  const [task] = board.tasks;
  expect(task).toMatchObject({
    projectId: "p",
    workspaceId: "wks",
    status: "in_review",
    title: "PR review: Zenlytic/zenlytic#9164 Fix the thing",
    operationId: prReviewOperationId("agent-1"),
    ownsWorkspace: false,
  });
  expect(task.tags?.map((t) => t.tag)).toEqual(["pr-review"]);
  expect(task.description).toContain("Zenlytic/zenlytic#9164 (https://github.com/Zenlytic/zenlytic/pull/9164)");
  expect(task.description).toContain("Created automatically from a PR review agent.");
  expect(isPrReviewCard(task)).toBe(true);
});

test("without an agent title the card is named after the label", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1", { title: null }), x.paseo);
  expect((await x.store.read()).tasks[0].title).toBe("PR review: Zenlytic/zenlytic#9164");
});

test("a workspace outside every project's repository makes no card and logs once", async () => {
  const x = await fixture();
  expect(await x.watcher.consider(x.review("a", { workspaceId: "scratch" }), x.paseo)).toEqual({ kind: "skipped", reason: "no-project" });
  expect(await x.watcher.consider(x.review("b", { workspaceId: "scratch" }), x.paseo)).toEqual({ kind: "skipped", reason: "no-project" });
  expect((await x.store.read()).tasks).toHaveLength(0);
  expect(x.logs).toHaveLength(1);
});

test("a workspace already bound to a card is skipped", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  // A second review agent in the same workspace: still one card.
  expect(await x.watcher.consider(x.review("agent-2"), x.paseo)).toEqual({ kind: "skipped", reason: "bound" });
  expect((await x.store.read()).tasks).toHaveLength(1);
});

test("the operation id is the agent's: a second pass (as after a reload) makes no duplicate", async () => {
  const x = await fixture();
  expect(prReviewOperationId("agent-1")).toBe(prReviewOperationId("agent-1"));
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  // A fresh watcher has an empty memory of seen agents, as after a plugin reload.
  const again = new PrReviewCards(x.service, () => now);
  expect(await again.consider(x.review("agent-1"), x.paseo)).toEqual({ kind: "skipped", reason: "bound" });
  // Even if the bound check were passed, createTask returns the existing card for the same operation id.
  const replay = await x.service.createTask(
    { projectId: "p", operationId: prReviewOperationId("agent-1"), title: "x", description: "", status: "in_review", priority: "normal", mode: "existing", workspaceId: "wks", baseRef: "" },
    x.paseo,
  );
  expect((await x.store.read()).tasks).toHaveLength(1);
  expect(replay.id).toBe((await x.store.read()).tasks[0].id);
});

test("observe reads each agent once per run and handles the created and first-turn hooks together", async () => {
  const x = await fixture();
  x.agents["agent-1"] = x.review("agent-1");
  const [first, second] = await Promise.all([x.watcher.observe("agent-1", x.paseo), x.watcher.observe("agent-1", x.paseo)]);
  expect(first?.kind).toBe("created");
  expect(second).toBeNull();
  expect(x.refreshes()).toBe(1);
  expect((await x.store.read()).tasks).toHaveLength(1);
});

test("with the setting off no card is made and the agent is not read", async () => {
  const x = await fixture();
  x.setOn(false);
  x.agents["agent-1"] = x.review("agent-1");
  expect(await x.watcher.observe("agent-1", x.paseo)).toEqual({ kind: "skipped", reason: "off" });
  expect(await x.watcher.consider(x.review("agent-1"), x.paseo)).toEqual({ kind: "skipped", reason: "off" });
  expect(x.refreshes()).toBe(0);
  expect((await x.store.read()).tasks).toHaveLength(0);
});

test("no backfill: agents without the label, archived, or older than the window make no card", async () => {
  const x = await fixture();
  expect(await x.watcher.consider(x.review("a", { labels: { other: "x" } }), x.paseo)).toEqual({ kind: "skipped", reason: "not-review" });
  expect(await x.watcher.consider(x.review("b", { archivedAt: minutesAgo(0) }), x.paseo)).toEqual({ kind: "skipped", reason: "archived" });
  expect(await x.watcher.consider(x.review("c", { createdAt: new Date(now - prReviewWindowMs - 1).toISOString() }), x.paseo)).toEqual({ kind: "skipped", reason: "old" });
  expect(await x.watcher.consider(x.review("d", { createdAt: null }), x.paseo)).toEqual({ kind: "skipped", reason: "old" });
  expect((await x.store.read()).tasks).toHaveLength(0);
});

test("a project without an In review lane gets the card in To do", async () => {
  const x = await fixture({ inReview: false });
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  expect((await x.store.read()).tasks[0].status).toBe("todo");
  expect(prReviewStatus({ lanes: statuses.map((status) => ({ status, enabled: status === "design" || status === "done" })) })).toBe("design");
});

test("the project's Linear ticket requirement is not applied to a PR review card", async () => {
  const x = await fixture({ linearTicket: true });
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  const review = (await x.store.read()).tasks[0];
  expect((await x.service.context(review.id, x.paseo)).context).not.toContain("Linear ticket:");
  // An ordinary card in the same project still gets it.
  await x.service.createTask(
    { projectId: "p", operationId: "ordinary", title: "Ordinary", description: "", status: "todo", priority: "normal", mode: "directory", baseRef: "" },
    { ...x.paseo, workspaces: { ...x.paseo.workspaces, create: async () => ({ id: "w2" }) } } as unknown as PaseoApi,
  );
  const ordinary = (await x.store.read()).tasks.find((t) => t.operationId === "ordinary")!;
  expect(ordinary.workspaceId).toBe("w2");
  const paseo = { ...x.paseo, workspaces: { ref: (id: string) => ({ refresh: async () => (id === "w2" ? { id: "w2", projectId: "native", workspaceDirectory: review.sourcePath, workspaceKind: "directory", archivingAt: null } : null) }) } } as unknown as PaseoApi;
  expect((await x.service.context(ordinary.id, paseo)).context).toContain("Linear ticket:");
});

const label = (n: number) => ({ "pr-review-watch": `Zenlytic/zenlytic#${n}` });

test("a new review of a PR that has a card reuses it: rebound to the new workspace, old one kept as history", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  const first = (await x.store.read()).tasks[0];
  const outcome = await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  expect(outcome.kind).toBe("reused");
  const board = await x.store.read();
  expect(board.tasks).toHaveLength(1);
  const [task] = board.tasks;
  expect(task.id).toBe(first.id);
  expect(outcome.kind === "reused" && outcome.task.id).toBe(first.id);
  expect(task.workspaceId).toBe("wks2");
  expect(task.previousWorkspaces?.map((w) => w.id)).toEqual(["wks"]);
  expect(task.ownsWorkspace).toBe(false);
  expect(task.operationId).toBe(prReviewOperationId("agent-1"));
  expect(task.revision).toBeGreaterThan(first.revision);
  expect(board.events.some((e) => e.taskId === task.id && e.action === "workspace_switched" && e.agentId === "agent-2")).toBe(true);
});

test("reuse moves the card back to In review and refreshes a changed title", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate((b) => {
    b.tasks[0].status = "done";
  });
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", title: "PR review: Zenlytic/zenlytic#9164 Second pass" }), x.paseo);
  const [task] = (await x.store.read()).tasks;
  expect(task.status).toBe("in_review");
  expect(task.title).toBe("PR review: Zenlytic/zenlytic#9164 Second pass");
});

test("reuse in a project without an In review lane moves the card to To do", async () => {
  const x = await fixture({ inReview: false });
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate((b) => {
    b.tasks[0].status = "done";
  });
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  expect((await x.store.read()).tasks[0].status).toBe("todo");
});

test("a card already in the lane and with the same title is not re-moved or retitled", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  const events = (await x.store.read()).events.filter((e) => e.action === "status_changed" || e.action === "edited");
  expect(events).toHaveLength(0);
});

test("a third review keeps the whole workspace history", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  await x.watcher.consider(x.review("agent-3", { workspaceId: "wks3" }), x.paseo);
  const board = await x.store.read();
  expect(board.tasks).toHaveLength(1);
  expect(board.tasks[0].workspaceId).toBe("wks3");
  expect(board.tasks[0].previousWorkspaces?.map((w) => w.id)).toEqual(["wks", "wks2"]);
});

test("re-running an earlier agent after reuse makes no card and does not rebind back", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  const again = new PrReviewCards(x.service, () => now);
  expect(await again.consider(x.review("agent-1"), x.paseo)).toEqual({ kind: "skipped", reason: "bound" });
  expect(await again.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).toEqual({ kind: "skipped", reason: "bound" });
  const board = await x.store.read();
  expect(board.tasks).toHaveLength(1);
  expect(board.tasks[0].workspaceId).toBe("wks2");
});

test("an archived card is never reused: a new card is made", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate((b) => {
    b.tasks[0].archivedAt = new Date(now).toISOString();
  });
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("created");
  const board = await x.store.read();
  expect(board.tasks).toHaveLength(2);
  expect(board.tasks[0].workspaceId).toBe("wks");
});

test("a different PR number gets its own card", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: label(9165) }), x.paseo)).kind).toBe("created");
  expect((await x.store.read()).tasks).toHaveLength(2);
});

test("with several cards for the PR the newest is reused", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: label(1) }), x.paseo);
  // Make a legacy duplicate for #9164 by hand, newer than the first.
  await x.store.mutate((b) => {
    const copy = structuredClone(b.tasks[0]);
    copy.id = "dup";
    copy.operationId = prReviewOperationId("legacy");
    copy.workspaceId = "legacy-ws";
    copy.createdAt = "2999-01-01T00:00:00.000Z";
    b.tasks.push(copy);
  });
  const outcome = await x.watcher.consider(x.review("agent-3", { workspaceId: "wks3" }), x.paseo);
  expect(outcome.kind === "reused" && outcome.task.id).toBe("dup");
  const board = await x.store.read();
  expect(board.tasks.find((t) => t.id === "dup")?.workspaceId).toBe("wks3");
  expect(board.tasks.find((t) => t.workspaceId === "wks")).toBeTruthy();
});

test("a label without owner/repo#n keeps one card per agent", async () => {
  const x = await fixture();
  const loose = { "pr-review-watch": "some review" };
  await x.watcher.consider(x.review("agent-1", { labels: loose }), x.paseo);
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: loose }), x.paseo)).kind).toBe("created");
  expect((await x.store.read()).tasks).toHaveLength(2);
});

// --- review fixes ---

test("a card made for a PR stores a normalised PR ref; a loose label stores none", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1", { labels: label(9164) }), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: { "pr-review-watch": "some review" } }), x.paseo);
  const [pr, loose] = (await x.store.read()).tasks;
  expect(pr.prRef).toBe("zenlytic/zenlytic#9164");
  expect(loose.prRef).toBeUndefined();
});

test("matching ignores case in owner and repo", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  const outcome = await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: { "pr-review-watch": "ZENLYTIC/Zenlytic#9164" } }), x.paseo);
  expect(outcome.kind).toBe("reused");
});

test("#91 and #9164 are different PRs, as are different repos", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2", labels: label(91) }), x.paseo)).kind).toBe("created");
  expect((await x.watcher.consider(x.review("agent-3", { workspaceId: "wks3", labels: { "pr-review-watch": "Zenlytic/other#9164" } }), x.paseo)).kind).toBe("created");
  expect((await x.store.read()).tasks).toHaveLength(3);
});

test("another project's card for the same PR is not reused", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate(async (b) => {
    const base = b.projects[0];
    const other = join(base.primaryPath, "..", "other-repo");
    await mkdir(other, { recursive: true });
    b.projects.push({ ...base, id: "q", paseoProjectId: "q-native", title: "Other", primaryPath: other, repos: [other] });
    Object.assign(b.tasks[0], { projectId: "q", sourcePath: other, repoPaths: [other] });
  });
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("created");
});

test("an edited description does not break the match when the ref is stored", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate((b) => {
    b.tasks[0].description = "my own notes";
  });
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("reused");
});

test("a card without a stored ref falls back to its PR line, searched line by line and parsed exactly", async () => {
  const mk = async (description: string) => {
    const x = await fixture();
    await x.watcher.consider(x.review("agent-1"), x.paseo);
    await x.store.mutate((b) => {
      delete b.tasks[0].prRef;
      b.tasks[0].description = description;
    });
    return (await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind;
  };
  expect(await mk("PR: Zenlytic/zenlytic#9164 (https://github.com/Zenlytic/zenlytic/pull/9164)\n\nCreated automatically from a PR review agent.")).toBe("reused");
  expect(await mk("Notes first\nPR: Zenlytic/zenlytic#9164")).toBe("reused");
  expect(await mk("PR: Zenlytic/zenlytic#9164 is the follow-up of the other one")).toBe("created");
  expect(await mk("PR: some review")).toBe("created");
  expect(await mk("mentions PR: Zenlytic/zenlytic#9164 mid-line")).toBe("created");
});

test("a workspace in an ordinary card's history does not block a new review card", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.store.mutate((b) => {
    const t = b.tasks[0];
    t.operationId = "ordinary";
    t.workspaceId = "ordinary-ws";
    t.tags = [];
    t.description = "plain";
    delete t.prRef;
    t.previousWorkspaces = [{ id: "wks2", kind: "worktree", directory: "/x", switchedAt: new Date(now).toISOString() }];
  });
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("created");
});

test("a workspace in the history of a PR review card for another PR does not block either", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1", { labels: label(1) }), x.paseo);
  await x.store.mutate((b) => {
    b.tasks[0].previousWorkspaces = [{ id: "wks2", kind: "worktree", directory: "/x", switchedAt: new Date(now).toISOString() }];
  });
  expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("created");
});

test("a skip because the card exists is logged", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  expect(await x.watcher.consider(x.review("agent-2"), x.paseo)).toEqual({ kind: "skipped", reason: "bound" });
  expect(x.logs.some((l) => l.includes("agent-2") && l.includes("already"))).toBe(true);
});

test("two reviews of one PR arriving together make one card", async () => {
  const x = await fixture();
  const [a, b] = await Promise.all([
    x.watcher.consider(x.review("agent-1"), x.paseo),
    x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo),
  ]);
  expect([a.kind, b.kind].sort()).toEqual(["created", "reused"]);
  expect((await x.store.read()).tasks).toHaveLength(1);
});

test("the history entry records the old workspace's real kind and directory", async () => {
  const x = await fixture();
  await x.watcher.consider(x.review("agent-1"), x.paseo);
  await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo);
  const [entry] = (await x.store.read()).tasks[0].previousWorkspaces!;
  expect(entry).toMatchObject({ id: "wks", kind: "worktree" });
  expect(entry.directory).toMatch(/zenlytic\/sub$/);
});

test("a card that owns its workspace or has a workspace switch is not reused: a new card is made and it is logged", async () => {
  for (const patch of [
    (t: { ownsWorkspace?: boolean }) => (t.ownsWorkspace = true),
    (t: { switch?: unknown }) => (t.switch = { id: "s", at: new Date(now).toISOString(), direction: "to_worktree", release: "pending" }),
  ]) {
    const x = await fixture();
    await x.watcher.consider(x.review("agent-1"), x.paseo);
    await x.store.mutate((b) => patch(b.tasks[0] as never));
    expect((await x.watcher.consider(x.review("agent-2", { workspaceId: "wks2" }), x.paseo)).kind).toBe("created");
    const board = await x.store.read();
    expect(board.tasks).toHaveLength(2);
    expect(board.tasks[0].workspaceId).toBe("wks");
    expect(x.logs.some((l) => l.includes("agent-2"))).toBe(true);
  }
});
