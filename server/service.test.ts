import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { BoardService, resolveWorktreeBaseRef } from "./service";
import { deliveryLine } from "../shared/delivery-mode";
import {
  projectInput,
  taskInput,
  taskEdit,
  projectEdit,
} from "../shared/model";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const git = promisify(execFile),
  roots: string[] = [];
async function setup() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ultra-single-root-")),
  );
  roots.push(root);
  const a = join(root, "project-root"),
    b = join(root, "old-second-repo");
  await mkdir(a);
  await mkdir(b);
  const store = new BoardStore(join(root, "data")),
    service = new BoardService(store),
    now = new Date().toISOString();
  await store.mutate((board) =>
    board.projects.push({
      id: "p",
      paseoProjectId: "native",
      title: "Legacy project",
      description: "",
      primaryPath: a,
      repos: [a, b],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }),
  );
  const create = vi.fn(async (_options: unknown) => ({ id: "workspace" }));
  const refresh = vi.fn(async () => ({
    id: "workspace",
    projectId: "foreign-native",
    workspaceDirectory: a,
    workspaceKind: "directory",
    status: "done",
  }));
  const paseo = {
    workspaces: { create, ref: () => ({ refresh }) },
  } as unknown as PaseoApi;
  const input = {
    projectId: "p",
    operationId: "op",
    title: "New card",
    description: "",
    status: "todo" as const,
    priority: "normal" as const,
    mode: "directory" as const,
    baseRef: "",
  };
  return { root, a, b, store, service, paseo, create, refresh, input };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

test("new card uses only native root even in a previously multi-repo project", async () => {
  const x = await setup(),
    card = await x.service.createTask(x.input, x.paseo);
  expect(card).toMatchObject({ sourcePath: x.a, repoPaths: [x.a] });
  expect(x.create.mock.calls[0][0]).toMatchObject({
    source: { kind: "directory", path: x.a, projectId: "native" },
  });
  expect((await x.service.context(card.id, x.paseo)).directories).toEqual([
    { repo: x.a, directory: x.a },
  ]);
  expect((await x.service.createTask(x.input, x.paseo)).id).toBe(card.id);
  expect(x.create).toHaveBeenCalledTimes(1);
});
test("a common parent directory contains two repositories without registering each separately", async () => {
  const x = await setup();
  await mkdir(join(x.a, "repo-one"));
  await mkdir(join(x.a, "repo-two"));
  const card = await x.service.createTask(x.input, x.paseo);
  expect(card.sourcePath).toBe(x.a);
  expect((await x.service.context(card.id, x.paseo)).context).toContain(
    "Native Paseo project root: " + x.a,
  );
  expect(x.create.mock.calls[0][0]).toMatchObject({ source: { path: x.a } });
});
test("new board project links the exact native Paseo root and persists only that directory", async () => {
  const x = await setup(),
    nativeRoot = join(x.root, "common-root");
  await mkdir(nativeRoot);
  await mkdir(join(nativeRoot, "repo-one"));
  await mkdir(join(nativeRoot, "repo-two"));
  const native = {
    projectId: "new-native",
    projectRootPath: nativeRoot,
    projectDisplayName: "Common root",
  };
  const paseo = {
    projects: { list: async () => ({ projects: [native] }) },
  } as unknown as PaseoApi;
  const created = await x.service.createProject(
    {
      title: "Combined",
      description: "",
      primaryPath: nativeRoot,
      paseoProjectId: "new-native",
    },
    paseo,
  );
  expect(created).toMatchObject({
    paseoProjectId: "new-native",
    primaryPath: nativeRoot,
    repos: [nativeRoot],
  });
  await expect(
    x.service.createProject(
      {
        title: "Again",
        description: "",
        primaryPath: nativeRoot,
        paseoProjectId: "new-native",
      },
      paseo,
    ),
  ).rejects.toThrow("already linked");
  await expect(
    x.service.createProject(
      {
        title: "Wrong root",
        description: "",
        primaryPath: x.a,
        paseoProjectId: "new-native",
      },
      paseo,
    ),
  ).rejects.toThrow("root does not match");
});
test("existing workspace inside a child repo is eligible through common project root", async () => {
  const x = await setup(),
    child = join(x.a, "repo-one");
  await mkdir(child);
  x.refresh.mockResolvedValue({
    ...(await x.refresh()),
    workspaceDirectory: child,
  });
  const card = await x.service.createTask(
    { ...x.input, mode: "existing", workspaceId: "workspace" },
    x.paseo,
  );
  expect(card).toMatchObject({ sourcePath: x.a, repoPaths: [x.a] });
  expect(
    (await x.service.context(card.id, x.paseo)).workspaceRepoPaths,
  ).toEqual([x.a]);
});
test("worktree originates from native root and default base resolves its named branch", async () => {
  const x = await setup();
  await git("git", ["-C", x.a, "init", "-b", "root-main"]);
  await git("git", ["-C", x.b, "init", "-b", "secondary-release"]);
  const card = await x.service.createTask(
    { ...x.input, mode: "worktree", branchName: "single-root", baseRef: "" },
    x.paseo,
  );
  expect(card.sourcePath).toBe(x.a);
  expect(x.create.mock.calls[0][0]).toMatchObject({
    source: {
      kind: "worktree",
      cwd: x.a,
      projectId: "native",
      refName: "refs/heads/root-main",
    },
  });
  expect(await resolveWorktreeBaseRef(x.a, "HEAD")).toBe(
    "refs/heads/root-main",
  );
});
test("non-Git common root requires a directory workspace", async () => {
  const x = await setup();
  await expect(
    x.service.createTask(
      { ...x.input, mode: "worktree", branchName: "feature" },
      x.paseo,
    ),
  ).rejects.toThrow("Enter a valid base ref");
  expect(x.create).not.toHaveBeenCalled();
  await x.service.createTask(x.input, x.paseo);
  expect(x.create).toHaveBeenCalledTimes(1);
});
test("corrected base ref uses a new native request key in the same card operation", async () => {
  const x = await setup(),
    input = {
      ...x.input,
      mode: "worktree" as const,
      branchName: "feature",
      baseRef: "invalid",
    };
  x.create.mockRejectedValueOnce(new Error("Invalid base ref"));
  await expect(x.service.createTask(input, x.paseo)).rejects.toThrow(
    "Invalid base ref",
  );
  await x.service.createTask({ ...input, baseRef: "main" }, x.paseo);
  const first = x.create.mock.calls[0][0] as { idempotencyKey: string },
    second = x.create.mock.calls[1][0] as { idempotencyKey: string };
  expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  expect((await x.store.read()).tasks).toHaveLength(1);
});
test("existing root workspace retains foreign native owner and cannot bind twice", async () => {
  const x = await setup(),
    input = { ...x.input, mode: "existing" as const, workspaceId: "workspace" };
  const card = await x.service.createTask(input, x.paseo);
  expect(card).toMatchObject({
    sourcePath: x.a,
    repoPaths: [x.a],
    workspaceId: "workspace",
  });
  await expect(
    x.service.createTask({ ...input, operationId: "other" }, x.paseo),
  ).rejects.toThrow("already bound");
  expect(x.create).not.toHaveBeenCalled();
  expect((await x.refresh()).projectId).toBe("foreign-native");
});
test("new card cannot link workspace in secondary legacy repo or outside root", async () => {
  const x = await setup(),
    input = { ...x.input, mode: "existing" as const, workspaceId: "workspace" };
  x.refresh.mockResolvedValue({
    ...(await x.refresh()),
    workspaceDirectory: x.b,
  });
  await expect(x.service.createTask(input, x.paseo)).rejects.toThrow("outside");
  x.refresh.mockResolvedValue({
    ...(await x.refresh()),
    workspaceDirectory: x.store.directory,
  });
  await expect(x.service.createTask(input, x.paseo)).rejects.toThrow("outside");
  x.refresh.mockResolvedValue(null as never);
  await expect(x.service.createTask(input, x.paseo)).rejects.toThrow(
    "unavailable",
  );
  expect((await x.store.read()).tasks).toHaveLength(0);
});
test("legacy card retains saved two-directory context and workspace", async () => {
  const x = await setup(),
    now = new Date().toISOString();
  x.refresh.mockResolvedValue({
    ...(await x.refresh()),
    workspaceDirectory: x.b,
    workspaceKind: "directory",
  });
  await x.store.mutate((board) =>
    board.tasks.push({
      id: "old",
      projectId: "p",
      workspaceId: "workspace",
      sourcePath: x.b,
      repoPaths: [],
      title: "Old",
      description: "",
      status: "todo",
      priority: "normal",
      position: 0,
      revision: 1,
      operationId: "old-op",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }),
  );
  const context = await x.service.context("old", x.paseo);
  expect(context.available).toBe(true);
  expect(context.directories).toEqual([
    { repo: x.a, directory: x.a },
    { repo: x.b, directory: x.b },
  ]);
  expect(context.context).toContain("Legacy card scope retained");
  await x.store.editTask({
    id: "old",
    revision: 1,
    title: "Edited",
    actor: "human",
  });
  expect((await x.store.read()).tasks[0]).toMatchObject({
    sourcePath: x.b,
    repoPaths: [],
    workspaceId: "workspace",
  });
});
test("new write contracts reject old repo/source fields", () => {
  expect(() =>
    projectInput.parse({
      title: "P",
      primaryPath: "/root",
      repos: ["/root", "/other"],
    }),
  ).toThrow();
  expect(() =>
    projectEdit.parse({ id: "p", revision: 1, repos: ["/root", "/other"] }),
  ).toThrow();
  expect(() =>
    taskInput.parse({
      projectId: "p",
      operationId: "o",
      title: "T",
      mode: "directory",
      repoPaths: ["/other"],
      sourcePath: "/other",
    }),
  ).toThrow();
  expect(() =>
    taskEdit.parse({ id: "t", revision: 1, repoPaths: ["/other"] }),
  ).toThrow();
});

test("worktree branch is optional: generated name is stable per operation", async () => {
  const { generatedBranchName } = await import("./service");
  expect(generatedBranchName("Fix Login Bug!", "op-1")).toMatch(/^kanban\/fix-login-bug-[0-9a-f]{6}$/);
  expect(generatedBranchName("F1 卡片显示摘要", "op-1")).toMatch(/^kanban\/f1-[0-9a-f]{6}$/);
  expect(generatedBranchName("卡片显示摘要", "op-1")).toMatch(/^kanban\/task-[0-9a-f]{6}$/);
  expect(generatedBranchName("x", "op-1")).toBe(generatedBranchName("x", "op-1"));
  expect(generatedBranchName("x", "op-1")).not.toBe(generatedBranchName("x", "op-2"));
  expect(generatedBranchName("a".repeat(80), "op").length).toBeLessThanOrEqual(7 + 40 + 7);
});

test("worktree card without a branch name uses the generated branch", async () => {
  const x = await setup();
  await git("git", ["-C", x.a, "init", "-b", "main"]);
  await x.service.createTask({ ...x.input, mode: "worktree", branchName: "  " }, x.paseo);
  expect(x.create.mock.calls[0][0]).toMatchObject({
    source: { kind: "worktree", branchName: expect.stringMatching(/^kanban\/new-card-[0-9a-f]{6}$/) },
  });
});
test("a new card is appended after fractional or reordered positions in its column", async () => {
  const x = await setup();
  let n = 0;
  x.create.mockImplementation(async () => ({ id: `workspace-${++n}` }));
  const first = await x.service.createTask({ ...x.input, operationId: "o1" }, x.paseo);
  const second = await x.service.createTask({ ...x.input, operationId: "o2" }, x.paseo);
  await x.store.placeTask({ id: first.id, revision: first.revision, status: "todo", beforeId: null, afterId: second.id });
  const third = await x.service.createTask({ ...x.input, operationId: "o3" }, x.paseo);
  const column = (await x.store.read()).tasks.sort((a, b) => a.position - b.position).map((t) => t.id);
  expect(column).toEqual([second.id, first.id, third.id]);
  expect(third.position).toBeGreaterThan(first.position);
});

test("a new card stores the delivery mode it was created with; none stored when omitted (DELIVERY-MODE-SPEC §2)", async () => {
  const x = await setup();
  const plain = await x.service.createTask(x.input, x.paseo);
  expect(plain.deliveryMode).toBeUndefined();
  x.create.mockResolvedValueOnce({ id: "workspace-2" });
  const chosen = await x.service.createTask({ ...x.input, operationId: "op-2", deliveryMode: "draft_pr" }, x.paseo);
  expect(chosen.deliveryMode).toBe("draft_pr");
  expect((await x.store.read()).tasks.find((t) => t.id === chosen.id)?.deliveryMode).toBe("draft_pr");
});

test("session context carries the delivery line of the card, or the default when it has none", async () => {
  const x = await setup();
  const none = await x.service.createTask(x.input, x.paseo);
  x.create.mockResolvedValueOnce({ id: "workspace-2" });
  const ready = await x.service.createTask({ ...x.input, operationId: "op-2", deliveryMode: "ready_pr" }, x.paseo);
  const line = (mode: "branch" | "draft_pr" | "ready_pr") => deliveryLine(mode);
  expect((await x.service.context(none.id, x.paseo)).context).toContain(line("branch"));
  expect((await x.service.context(none.id, x.paseo, undefined, { deliveryDefault: "draft_pr" })).context).toContain(line("draft_pr"));
  expect((await x.service.context(ready.id, x.paseo, undefined, { deliveryDefault: "draft_pr" })).context).toContain(line("ready_pr"));
});

test("an unknown stored mode is preserved and treated as the default", async () => {
  const x = await setup();
  const card = await x.service.createTask(x.input, x.paseo);
  await x.store.mutate((board) => {
    (board.tasks.find((t) => t.id === card.id) as { deliveryMode?: string }).deliveryMode = "from_the_future";
  });
  const text = (await x.service.context(card.id, x.paseo, undefined, { deliveryDefault: "draft_pr" })).context;
  expect(text).toContain(deliveryLine("draft_pr"));
  expect((await x.store.read()).tasks.find((t) => t.id === card.id)?.deliveryMode).toBe("from_the_future");
  // A later edit of the card does not drop it.
  await x.store.editTask({ id: card.id, revision: card.revision, title: "Renamed", actor: "human" });
  expect((await x.store.read()).tasks.find((t) => t.id === card.id)?.deliveryMode).toBe("from_the_future");
});
test("the dispatcher's own Paseo project is hidden from Add project and refused as a project (DISPATCHER-SPEC §2)", async () => {
  const x = await setup(),
    dispatcherRoot = join(x.root, "data", "dispatcher");
  await mkdir(dispatcherRoot, { recursive: true });
  const natives = [
    { projectId: "native", projectRootPath: x.a, projectDisplayName: "Mine" },
    { projectId: "disp-native", projectRootPath: dispatcherRoot, projectDisplayName: "dispatcher" },
  ];
  const paseo = {
    projects: { list: async () => ({ projects: natives }) },
    workspaces: {
      list: async () => ({
        entries: [
          { id: "w1", projectId: "native", name: "One", workspaceDirectory: x.a, status: "done", workspaceKind: "directory" },
          { id: "dw", projectId: "disp-native", name: "Flowly dispatcher", workspaceDirectory: dispatcherRoot, status: "done", workspaceKind: "directory" },
        ],
        pageInfo: { nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  x.service.reservedRoot = async (path) => (await realpath(path).catch(() => path)) === dispatcherRoot;
  x.service.reservedWorkspace = (id) => id === "dw";
  const resources = await x.service.resources(paseo);
  expect(resources.projects.map((p) => p.id)).toEqual(["native"]);
  expect(resources.workspaces.map((w) => w.id)).toEqual(["w1"]);
  await expect(
    x.service.createProject({ title: "Dispatcher", description: "", primaryPath: dispatcherRoot, paseoProjectId: "disp-native" }, paseo),
  ).rejects.toThrow("Flowly dispatcher");
  await expect(x.service.createProject({ title: "Dispatcher", description: "", primaryPath: dispatcherRoot }, paseo)).rejects.toThrow("Flowly dispatcher");
  expect((await x.store.read()).projects.map((p) => p.id)).toEqual(["p"]);
});

test("background workspaces are listed and flagged, so a card bound to one is not 'unavailable'", async () => {
  const x = await setup(),
    dispatcherRoot = join(x.root, "data", "dispatcher");
  const natives = [
    { projectId: "native", projectRootPath: x.a, projectDisplayName: "Mine" },
    { projectId: "disp-native", projectRootPath: dispatcherRoot, projectDisplayName: "dispatcher" },
  ];
  const asked: unknown[] = [];
  const all = [
    { id: "w1", projectId: "native", name: "One", workspaceDirectory: x.a, status: "done", workspaceKind: "directory" },
    { id: "bg", projectId: "native", name: "PR review", workspaceDirectory: x.a, status: "done", workspaceKind: "worktree", background: true },
    { id: "bg-reserved", projectId: "native", name: "Reserved", workspaceDirectory: x.a, status: "done", workspaceKind: "worktree", background: true },
    { id: "bg-hidden", projectId: "disp-native", name: "Hidden project", workspaceDirectory: dispatcherRoot, status: "done", workspaceKind: "worktree", background: true },
  ];
  const paseo = {
    projects: { list: async () => ({ projects: natives }) },
    workspaces: {
      list: async (options: { filter?: { includeBackground?: boolean } }) => {
        asked.push(options.filter);
        return { entries: all.filter((w) => !w.background || options.filter?.includeBackground), pageInfo: { nextCursor: null } };
      },
    },
  } as unknown as PaseoApi;
  x.service.reservedRoot = async (path) => (await realpath(path).catch(() => path)) === dispatcherRoot;
  x.service.reservedWorkspace = (id) => id === "bg-reserved";
  const resources = await x.service.resources(paseo);
  expect(resources.workspaces.map((w) => w.id)).toEqual(["w1", "bg"]);
  expect(resources.workspaces.map((w) => w.background)).toEqual([undefined, true]);
});
