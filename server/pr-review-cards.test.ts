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
