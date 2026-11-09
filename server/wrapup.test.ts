import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import { WrapupService } from "./wrapup";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(options: {
  kind?: string;
  status?: "done" | "cancelled" | "development";
  agents?: { id: string; status: string; labels?: Record<string, string> }[];
  directory?: string;
  git?: (cwd: string, args: string[]) => Promise<string>;
  ownsWorkspace?: boolean;
  workspaceTitle?: string;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-wrapup-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((board) => {
    board.projects.push({
      id: "p", paseoProjectId: "native", title: "P", description: "",
      primaryPath: root, repos: [root], revision: 1,
      createdAt: now, updatedAt: now, archivedAt: null,
    });
    board.tasks.push({
      id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root],
      title: "Card", description: "", status: options.status || "done", priority: "normal",
      position: 0, revision: 3, operationId: "op",
      createdAt: now, updatedAt: now, archivedAt: null,
      ...(options.ownsWorkspace === undefined ? {} : { ownsWorkspace: options.ownsWorkspace }),
    });
  });
  let agents = (options.agents || [{ id: "a1", status: "idle" }]).map((a) => ({
    ...a, workspaceId: "w", archivedAt: null as string | null,
  }));
  const agentArchive = vi.fn(async (id: string) => {
    agents = agents.map((a) => (a.id === id ? { ...a, archivedAt: now } : a));
    return { archivedAt: now };
  });
  const workspaceArchive = vi.fn(async () => ({ requestId: "r", workspaceId: "w", archivedAt: now, error: null }));
  const listCalls: unknown[] = [];
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({
          id: "w",
          workspaceKind: options.kind || "worktree",
          workspaceDirectory: options.directory || root,
          name: options.workspaceTitle || "main",
        }),
      }),
      archive: workspaceArchive,
    },
    agents: {
      list: async (o: unknown) => (listCalls.push(o), {
        entries: agents.map((agent) => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
      ref: (id: string) => ({ archive: () => agentArchive(id) }),
    },
  } as unknown as PaseoApi;
  const git = options.git || (async (_cwd: string, args: string[]) =>
    args[0] === "rev-parse" ? "feature/x\n" : args[0] === "status" ? "" : "0\n");
  return { store, paseo, git, service: new WrapupService(store, git), agentArchive, workspaceArchive, root, listCalls };
}

test("clean worktree wraps up by archiving the workspace, then the card", async () => {
  const x = await setup({});
  const check = await x.service.check("t", x.paseo);
  expect(check).toMatchObject({ archiveWorkspace: true, blockers: [], warnings: [], sessions: 1 });
  const result = await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, x.paseo);
  expect(result).toMatchObject({ archivedWorkspace: true, archivedSessions: 1 });
  expect(x.workspaceArchive).toHaveBeenCalledWith("w");
  expect(x.agentArchive).not.toHaveBeenCalled();
  const board = await x.store.read();
  expect(board.tasks[0]).toMatchObject({ revision: 4 });
  expect(board.tasks[0].archivedAt).toBeTruthy();
  expect(board.events.at(-1)).toMatchObject({ action: "wrapped_up", actor: "human" });
});

test("directory workspace keeps the workspace and archives only its sessions", async () => {
  const x = await setup({ kind: "directory", agents: [{ id: "a1", status: "idle" }, { id: "a2", status: "closed" }] });
  const result = await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, x.paseo);
  expect(result).toMatchObject({ archivedWorkspace: false, archivedSessions: 2 });
  expect(x.workspaceArchive).not.toHaveBeenCalled();
  expect(x.agentArchive.mock.calls.map((c) => c[0])).toEqual(["a1", "a2"]);
});

test("running sessions and unfinished cards block; nothing is archived", async () => {
  const running = await setup({ agents: [{ id: "a1", status: "running" }] });
  expect((await running.service.check("t", running.paseo)).blockers[0]).toMatch(/still running/);
  await expect(running.service.run({ id: "t", revision: 3, acknowledgeWarnings: true }, running.paseo)).rejects.toThrow(/Cannot wrap up/);
  expect(running.workspaceArchive).not.toHaveBeenCalled();
  const open = await setup({ status: "development" });
  expect((await open.service.check("t", open.paseo)).blockers).toContain("Only Done or Cancelled cards can be wrapped up.");
});

test("warnings require acknowledgement; stale revision is rejected", async () => {
  const x = await setup({
    git: async (_cwd, args) => (args[0] === "rev-parse" ? "feature/x\n" : args[0] === "status" ? " M a.ts\n?? b.ts\n" : "2\n"),
  });
  const check = await x.service.check("t", x.paseo);
  expect(check.git).toEqual({ branch: "feature/x", uncommitted: 2, unpushed: 2 });
  expect(check.warnings).toHaveLength(2);
  await expect(x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, x.paseo)).rejects.toThrow(/Confirm the warnings/);
  await expect(x.service.run({ id: "t", revision: 2, acknowledgeWarnings: true }, x.paseo)).rejects.toThrow(/Revision conflict/);
  expect(x.workspaceArchive).not.toHaveBeenCalled();
  await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: true }, x.paseo);
  expect((await x.store.read()).events.at(-1)?.note).toMatch(/acknowledged/);
});

test("partial failure leaves the card unarchived and a retry continues", async () => {
  const x = await setup({ kind: "directory", agents: [{ id: "a1", status: "idle" }, { id: "a2", status: "idle" }] });
  x.agentArchive.mockImplementationOnce(async () => {
    throw new Error("boom");
  });
  await expect(x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, x.paseo)).rejects.toThrow(/card was not archived/);
  expect((await x.store.read()).tasks[0].archivedAt).toBeNull();
  const result = await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, x.paseo);
  expect(result.archivedSessions).toBe(1);
  expect((await x.store.read()).tasks[0].archivedAt).toBeTruthy();
});

test("real git: uncommitted and local-only commits are detected", async () => {
  const x = await setup({ git: undefined });
  const service = new WrapupService(x.store);
  await run("git", ["init", "-q", "-b", "main", x.root]);
  await run("git", ["-C", x.root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"]);
  await writeFile(join(x.root, "dirty.txt"), "x");
  const check = await service.check("t", x.paseo);
  expect(check.git).toMatchObject({ branch: "main", unpushed: 1 });
  expect(check.git!.uncommitted).toBeGreaterThanOrEqual(1);
  // Once another branch contains the commit (merged), it is no longer reported.
  await run("git", ["-C", x.root, "branch", "integration"]);
  expect((await service.check("t", x.paseo)).git).toMatchObject({ unpushed: 0 });
});

test("a directory workspace the plugin created for the card is archived; a linked one is kept", async () => {
  const owned = await setup({ kind: "directory", ownsWorkspace: true });
  expect(await owned.service.check("t", owned.paseo)).toMatchObject({ archiveWorkspace: true });
  await owned.service.run({ id: "t", revision: 3, acknowledgeWarnings: false }, owned.paseo);
  expect(owned.workspaceArchive).toHaveBeenCalledWith("w");
  // Older cards have no flag: the workspace titled after the card was created for it.
  const legacy = await setup({ kind: "directory", workspaceTitle: "Card" });
  expect(await legacy.service.check("t", legacy.paseo)).toMatchObject({ archiveWorkspace: true });
  const linked = await setup({ kind: "directory", ownsWorkspace: false, workspaceTitle: "Card" });
  expect(await linked.service.check("t", linked.paseo)).toMatchObject({ archiveWorkspace: false });
});

test("auto-archive on Done archives a clean workspace and keeps the card on the board", async () => {
  const x = await setup({ kind: "directory", ownsWorkspace: true });
  await x.service.autoArchive("t", x.paseo);
  expect(x.workspaceArchive).toHaveBeenCalledWith("w");
  const board = await x.store.read();
  expect(board.tasks[0]).toMatchObject({ archivedAt: null, revision: 3 });
  expect(board.events.at(-1)).toMatchObject({ action: "workspace_auto_archived", actor: "system" });
});

test("auto-archive skips and records why: running session, git warnings, linked workspace, not Done", async () => {
  const cases = [
    await setup({ agents: [{ id: "a1", status: "running" }] }),
    await setup({ git: async (_cwd, args) => (args[0] === "rev-parse" ? "x\n" : args[0] === "status" ? " M a.ts\n" : "0\n") }),
    await setup({ kind: "directory", ownsWorkspace: false }),
  ];
  for (const x of cases) {
    await x.service.autoArchive("t", x.paseo);
    expect(x.workspaceArchive).not.toHaveBeenCalled();
    expect(x.agentArchive).not.toHaveBeenCalled();
    expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "workspace_auto_archive_skipped" });
  }
  const open = await setup({ status: "development" });
  await open.service.autoArchive("t", open.paseo);
  expect(open.workspaceArchive).not.toHaveBeenCalled();
});

test("auto wrap-up waits for the card's summary run and does not count summarizer sessions", async () => {
  const x = await setup({
    kind: "directory",
    ownsWorkspace: true,
    agents: [
      { id: "a1", status: "idle" },
      { id: "s1", status: "running", labels: { "ultra-kanban": "summarizer", "ultra-kanban-task": "t" } },
    ],
  });
  let finish!: () => void;
  const summary = new Promise<void>((resolve) => (finish = resolve));
  const service = new WrapupService(x.store, x.git, (id) => (id === "t" ? summary : Promise.resolve()));
  const done = service.autoArchive("t", x.paseo);
  await new Promise((r) => setTimeout(r, 20));
  expect(x.workspaceArchive).not.toHaveBeenCalled();
  finish();
  await done;
  expect(x.workspaceArchive).toHaveBeenCalledWith("w");
  const event = (await x.store.read()).events.at(-1);
  expect(event).toMatchObject({ action: "workspace_auto_archived" });
  expect(event?.note).toMatch(/1 session\(s\)/);
});

test("auto wrap-up also covers Cancelled", async () => {
  const x = await setup({ status: "cancelled" });
  await x.service.autoArchive("t", x.paseo);
  expect(x.workspaceArchive).toHaveBeenCalledWith("w");
});

test("the prompt's wrap-up (keepCard) archives resources and leaves the card on the board", async () => {
  const x = await setup({ kind: "directory", ownsWorkspace: true });
  const result = await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false, keepCard: true }, x.paseo);
  expect(result.archivedWorkspace).toBe(true);
  const board = await x.store.read();
  expect(board.tasks[0]).toMatchObject({ archivedAt: null, revision: 3 });
  expect(board.events.at(-1)).toMatchObject({ action: "wrapped_up", actor: "human" });
  expect(board.events.at(-1)?.note).toMatch(/card kept/);
});

test("delete preflight allows any lane but still blocks on running sessions", async () => {
  const x = await setup({ status: "development" });
  expect((await x.service.check("t", x.paseo)).blockers).toContain("Only Done or Cancelled cards can be wrapped up.");
  expect(await x.service.check("t", x.paseo, "delete")).toMatchObject({ archiveWorkspace: true, blockers: [] });
  await x.service.run({ id: "t", revision: 3, acknowledgeWarnings: false, keepCard: true, purpose: "delete" }, x.paseo);
  expect(x.workspaceArchive).toHaveBeenCalledTimes(1);
  expect((await x.store.read()).tasks[0]).toMatchObject({ archivedAt: null, revision: 3 });
  const busy = await setup({ status: "development", agents: [{ id: "a1", status: "running" }] });
  await expect(
    busy.service.run({ id: "t", revision: 3, acknowledgeWarnings: true, keepCard: true, purpose: "delete" }, busy.paseo),
  ).rejects.toThrow("Cannot archive");
  expect(busy.workspaceArchive).not.toHaveBeenCalled();
});

test("the session preflight lists agents in background workspaces too", async () => {
  const x = await setup({});
  await x.service.check("t", x.paseo);
  expect(x.listCalls.length).toBeGreaterThan(0);
  for (const call of x.listCalls) expect(call).toMatchObject({ filter: { includeArchived: false, includeBackground: true } });
});
