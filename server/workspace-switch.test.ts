import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BoardStore } from "./store";
import { WorkspaceSwitchService, workspaceSessions } from "./workspace-switch";
import { handoverPrompt } from "../shared/workspace-switch";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const write = (dir: string, path: string, body: string) => writeFileSync(join(dir, path), body);
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const status = (dir: string) => sh(dir, "status", "--porcelain").trimEnd().split("\n").filter(Boolean).sort();

type Ws = { id: string; workspaceKind: string; workspaceDirectory: string; name: string; title: string };
type Agent = { id: string; workspaceId: string; status: string; title: string; updatedAt: string; archivedAt: string | null; labels: Record<string, string>; cwd: string };

/**
 * A main checkout with card A's and card B's uncommitted changes (one shared
 * file), card C's untracked file, a local card A bound to "w-local", and a fake
 * Paseo whose workspace creation makes a real git worktree.
 */
async function fixture(options: { agentStatus?: string } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "flowly-switch-svc-")));
  dirs.push(top);
  const root = join(top, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  write(root, "shared.txt", "a1\na2\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n");
  write(root, "onlyB.txt", "x\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  write(root, "shared.txt", "a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  write(root, "onlyB.txt", "x\ny\n");
  write(root, "newA.txt", "new A\n");
  write(root, "untrackedC.txt", "scratch C\n");
  const data = join(top, "data");
  const store = new BoardStore(data);
  const now = new Date().toISOString();
  await store.mutate((board) => {
    board.projects.push({ id: "p", paseoProjectId: "native", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    board.tasks.push({
      id: "t", projectId: "p", workspaceId: "w-local", sourcePath: root, repoPaths: [root], title: "Card A", description: "", status: "development",
      priority: "normal", position: 0, revision: 3, operationId: "op", createdAt: now, updatedAt: now, archivedAt: null, ownsWorkspace: true,
    });
  });
  const workspaces = new Map<string, Ws>([["w-local", { id: "w-local", workspaceKind: "directory", workspaceDirectory: root, name: "Card A", title: "Card A" }]]);
  const byKey = new Map<string, string>();
  let n = 0;
  const agents: Agent[] = [
    { id: "a1", workspaceId: "w-local", status: options.agentStatus || "idle", title: "Explore", updatedAt: now, archivedAt: null, labels: {}, cwd: root },
  ];
  const create = vi.fn(async (opts: { idempotencyKey: string; source: { kind: string; path?: string; branchName?: string; refName?: string } }) => {
    const known = byKey.get(opts.idempotencyKey);
    if (known) return { id: known };
    const id = `w-${++n}`;
    if (opts.source.kind === "worktree") {
      const dir = join(top, `wt-${n}`);
      sh(root, "worktree", "add", "-q", "-b", opts.source.branchName!, dir, opts.source.refName!);
      workspaces.set(id, { id, workspaceKind: "worktree", workspaceDirectory: dir, name: "Card A", title: "Card A" });
    } else workspaces.set(id, { id, workspaceKind: "directory", workspaceDirectory: opts.source.path!, name: "Card A", title: "Card A" });
    byKey.set(opts.idempotencyKey, id);
    return { id };
  });
  const archive = vi.fn(async (id: string) => ({ requestId: "r", workspaceId: id, archivedAt: new Date().toISOString(), error: null }));
  const send = vi.fn(async (_id: string, _text: string) => undefined);
  const listCalls: unknown[] = [];
  const paseo = {
    workspaces: { ref: (id: string) => ({ refresh: async () => workspaces.get(id) ?? null }), create, archive },
    agents: {
      list: async (o: unknown) => (listCalls.push(o), { entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((a) => a.id === id) ?? null }),
        send: (text: string) => send(id, text),
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "user_message", text: "Explore feature A" } },
              { item: { type: "tool_call", name: "Edit", detail: { type: "edit", filePath: join(root, "shared.txt") } } },
              { item: { type: "assistant_message", text: "A is in shared.txt and newA.txt" } },
            ],
          }),
        },
      }),
    },
  } as unknown as PaseoApi;
  const service = new WorkspaceSwitchService(store, data);
  return { top, root, data, store, paseo, service, create, archive, send, agents, workspaces, listCalls };
}

const card = async (store: BoardStore) => (await store.read()).tasks[0];

/** The new session keeps only card A's changes in the worktree. */
function trim(wt: string) {
  sh(wt, "checkout", "-q", "--", "onlyB.txt");
  rmSync(join(wt, "untrackedC.txt"));
  write(wt, "shared.txt", "a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n");
}

test("switch to worktree copies everything, moves the card, writes the handoff and archives the old workspace", async () => {
  const x = await fixture();
  const check = await x.service.check({ id: "t", direction: "to_worktree" }, x.paseo);
  expect(check.blockers).toEqual([]);
  expect(check.warnings.join(" ")).toMatch(/No handover yet/);
  expect(check.copy).toMatchObject({ tracked: 2, untracked: 2 });
  expect(check.idleSessions).toEqual([{ id: "a1", title: "Explore" }]);
  const result = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  expect(result.copied).toBe(4);
  const wt = x.workspaces.get(result.workspaceId)!.workspaceDirectory;
  expect(read(wt, "newA.txt")).toBe("new A\n");
  expect(read(wt, "untrackedC.txt")).toBe("scratch C\n");
  expect(status(x.root)).toEqual([" M onlyB.txt", " M shared.txt", "?? newA.txt", "?? untrackedC.txt"]);
  const task = await card(x.store);
  expect(task).toMatchObject({ workspaceId: result.workspaceId, ownsWorkspace: true, revision: 4 });
  expect(task.previousWorkspaces).toEqual([expect.objectContaining({ id: "w-local", kind: "directory", directory: x.root })]);
  expect(task.switch).toMatchObject({ id: "op1", direction: "to_worktree", branch: "kanban/a", mainBranch: "main", release: "pending", base: sh(x.root, "rev-parse", "HEAD").trim() });
  const board = await x.store.read();
  expect(board.artifacts).toEqual([expect.objectContaining({ role: "input", kind: "file", target: "./.flowly/handoff/op1/handoff.md", createdBy: "human" })]);
  const handoff = read(wt, ".flowly/handoff/op1/handoff.md");
  expect(handoff).toMatch(/ALL uncommitted changes/);
  expect(handoff).toMatch(/- shared\.txt/);
  expect(read(wt, ".flowly/handoff/op1/sessions/a1.md")).toMatch(/Explore feature A/);
  expect(read(wt, ".flowly/.gitignore")).toBe("*\n");
  expect(x.archive).toHaveBeenCalledWith("w-local");
  expect(board.events.find((e) => e.action === "workspace_switched")).toMatchObject({ actor: "human", note: expect.stringMatching(/4 files copied/) });
  // A retry of the same operation creates no second workspace.
  await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("release, undo and integrate move exactly the card's changes and keep the other cards' work", async () => {
  const x = await fixture();
  const result = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  const wt = x.workspaces.get(result.workspaceId)!.workspaceDirectory;
  await expect(x.service.integrateCard({ taskId: "t", agentId: "a2", workspaceDirectory: wt, workspaceKind: "worktree" })).rejects.toMatchObject({ code: "RELEASE_PENDING" });
  trim(wt);
  let check = await x.service.releaseCheck("t", x.paseo);
  expect(check.blockers).toEqual([]);
  expect(check.files.map((f) => f.path).sort()).toEqual(["newA.txt", "shared.txt"]);
  let task = await card(x.store);
  await expect(x.service.release({ id: "t", revision: task.revision, operationId: "r1", patchHash: "stale", acknowledgeWarnings: true }, x.paseo)).rejects.toThrow(/changed since/);
  await x.service.release({ id: "t", revision: task.revision, operationId: "r1", patchHash: check.patchHash, acknowledgeWarnings: true }, x.paseo);
  expect(status(x.root)).toEqual([" M onlyB.txt", " M shared.txt", "?? untrackedC.txt"]);
  expect(read(x.root, "shared.txt")).toContain("b2-B");
  expect(existsSync(join(wt, ".flowly/handoff/op1/released.patch"))).toBe(true);
  task = await card(x.store);
  expect(task.switch).toMatchObject({ release: "released" });
  await x.service.releaseUndo({ id: "t", revision: task.revision, operationId: "u1" });
  expect(read(x.root, "newA.txt")).toBe("new A\n");
  task = await card(x.store);
  expect(task.switch?.release).toBe("pending");
  check = await x.service.releaseCheck("t", x.paseo);
  await x.service.release({ id: "t", revision: task.revision, operationId: "r2", patchHash: check.patchHash, acknowledgeWarnings: true }, x.paseo);
  write(wt, "newA.txt", "new A (fixed)\n");
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "feat: A");
  const integrated = await x.service.integrateCard({ taskId: "t", agentId: "a2", workspaceDirectory: wt, workspaceKind: "worktree" });
  expect(integrated).toMatchObject({ commits: 1, ref: "kanban/a", uncommitted: 0 });
  expect(sh(x.root, "log", "--format=%s", "-1").trim()).toBe("feat: A");
  expect(status(x.root)).toEqual([" M onlyB.txt", " M shared.txt", "?? untrackedC.txt"]);
  expect(read(x.root, "newA.txt")).toBe("new A (fixed)\n");
  task = await card(x.store);
  expect(task.switch?.integratedAt).toBeTruthy();
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "branch_integrated", actor: "agent", agentId: "a2" });
  await expect(x.service.releaseUndo({ id: "t", revision: task.revision, operationId: "u2" })).rejects.toThrow(/already integrated/);
  expect((await x.service.integrateCard({ taskId: "t", agentId: "a2", workspaceDirectory: wt, workspaceKind: "worktree" })).commits).toBe(0);
});

test("release is refused once the card's lines were edited in the worktree", async () => {
  const x = await fixture();
  const result = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree" }, x.paseo);
  const wt = x.workspaces.get(result.workspaceId)!.workspaceDirectory;
  trim(wt);
  write(wt, "newA.txt", "new A\nedited first\n");
  const check = await x.service.releaseCheck("t", x.paseo);
  expect(check.blockers.join(" ")).toMatch(/newA\.txt/);
});

test("blockers refuse a switch: a running session, an existing worktree, a non-Git root", async () => {
  const x = await fixture({ agentStatus: "running" });
  const check = await x.service.check({ id: "t", direction: "to_worktree" }, x.paseo);
  expect(check.blockers.join(" ")).toMatch(/still running/);
  await expect(x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree" }, x.paseo)).rejects.toThrow(/Cannot switch/);
  expect(x.create).not.toHaveBeenCalled();
  expect((await x.service.check({ id: "t", direction: "to_local" }, x.paseo)).blockers.join(" ")).toMatch(/already works in the main checkout/);
  rmSync(join(x.root, ".git"), { recursive: true, force: true });
  expect((await x.service.check({ id: "t", direction: "to_worktree" }, x.paseo)).blockers.join(" ")).toMatch(/not a Git repository/);
});

test("switch to local binds a directory workspace and archives the worktree; a clean worktree saves no patch", async () => {
  const x = await fixture();
  const first = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  const wt = x.workspaces.get(first.workspaceId)!.workspaceDirectory;
  x.agents.length = 0;
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "wip");
  const check = await x.service.check({ id: "t", direction: "to_local" }, x.paseo);
  expect(check.blockers).toEqual([]);
  expect(check.warnings.join(" ")).toMatch(/not in main/);
  expect(check.warnings.join(" ")).not.toMatch(/uncommitted/);
  const task = await card(x.store);
  const result = await x.service.run({ id: "t", revision: task.revision, operationId: "op2", direction: "to_local" }, x.paseo);
  const moved = await card(x.store);
  expect(moved.workspaceId).toBe(result.workspaceId);
  expect(x.workspaces.get(result.workspaceId)!.workspaceKind).toBe("directory");
  expect(moved.previousWorkspaces?.map((w) => w.id)).toEqual(["w-local", first.workspaceId]);
  expect(moved.previousWorkspaces?.[1]).toMatchObject({ kind: "worktree", branch: "kanban/a" });
  expect(moved.switch).toMatchObject({ direction: "to_local", branch: "kanban/a", release: "none" });
  expect(x.archive).toHaveBeenLastCalledWith(first.workspaceId);
  expect(read(x.root, `.flowly/handoff/t/op2/handoff.md`)).toMatch(/not in main/);
  expect(existsSync(join(x.root, ".flowly/handoff/t/op2/worktree-uncommitted.patch"))).toBe(false);
});

/**
 * A worktree card with a commit the main checkout lacks and uncommitted
 * changes on top: onlyB.txt staged and untrackedC.txt untouched (both still in
 * the main checkout from the switch), shared.txt rewritten (conflicts there),
 * late.txt new.
 */
async function dirtyWorktree() {
  const x = await fixture();
  const first = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  const wt = x.workspaces.get(first.workspaceId)!.workspaceDirectory;
  x.agents.length = 0;
  sh(wt, "add", "newA.txt");
  sh(wt, "commit", "-qm", "wip");
  sh(wt, "add", "onlyB.txt");
  write(wt, "shared.txt", "edited in the worktree\n");
  write(wt, "late.txt", "untracked\n");
  const task = await card(x.store);
  return { ...x, wt, head: sh(wt, "rev-parse", "HEAD").trim(), input: { id: "t", revision: task.revision, operationId: "op2", direction: "to_local" as const } };
}

test("Switch to local compares both sides: branches with their last commits and the changes per folder (two levels), conflicts first", async () => {
  const x = await dirtyWorktree();
  const put = (dir: string, path: string, body: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    write(dir, path, body);
  };
  put(x.wt, "vendor/acme/lib/a.php", "a\n");
  put(x.wt, "vendor/acme/b.php", "b\n");
  put(x.wt, "vendor/other/c.php", "c\n");
  put(x.wt, "docs/guide.md", "guide\n");
  put(x.root, "vendor/acme/x.php", "x\n");
  const check = await x.service.check({ id: "t", direction: "to_local" }, x.paseo);
  expect(check.blockers).toEqual([]);
  expect(check.warnings.join(" ")).not.toMatch(/uncommitted/);
  expect(check.worktree).toMatchObject({ branch: "kanban/a", uncommitted: 8, notIntegrated: 1, copyBack: { files: 5, present: 2, conflicts: ["shared.txt"], busy: null } });
  const compare = check.compare!;
  expect(compare.worktree).toMatchObject({ branch: "kanban/a", notInOther: 1 });
  expect(compare.worktree.commits.map((c) => c.subject)).toEqual(["wip", "base"]);
  expect(compare.main).toMatchObject({ branch: "main", notInOther: 0 });
  expect(compare.main.commits.map((c) => c.subject)).toEqual(["base"]);
  expect(compare.totals).toEqual({ worktree: 8, main: 5, both: 3, files: 10, folders: 8 });
  expect(compare.folders).toEqual([
    { path: "shared.txt", worktree: 1, main: 1, apply: 0, present: 0, conflicts: 1 },
    { path: "onlyB.txt", worktree: 1, main: 1, apply: 0, present: 1, conflicts: 0 },
    { path: "untrackedC.txt", worktree: 1, main: 1, apply: 0, present: 1, conflicts: 0 },
    { path: "vendor/acme/", worktree: 2, main: 1, apply: 2, present: 0, conflicts: 0 },
    { path: "docs/", worktree: 1, main: 0, apply: 1, present: 0, conflicts: 0 },
    { path: "late.txt", worktree: 1, main: 0, apply: 1, present: 0, conflicts: 0 },
    { path: "vendor/other/", worktree: 1, main: 0, apply: 1, present: 0, conflicts: 0 },
    { path: "newA.txt", worktree: 0, main: 1, apply: 0, present: 0, conflicts: 0 },
  ]);
});

test("uncommitted worktree changes need a choice; Discard leaves the main checkout alone and keeps a patch that restores them on the branch", async () => {
  const x = await dirtyWorktree();
  const before = status(x.root);
  await expect(x.service.run(x.input, x.paseo)).rejects.toThrow(/choose whether to copy, overwrite or discard/);
  await expect(x.service.run({ ...x.input, uncommitted: "copy" }, x.paseo)).rejects.toThrow(/Cannot copy.*shared\.txt/);
  expect(x.create).toHaveBeenCalledTimes(1);
  await x.service.run({ ...x.input, uncommitted: "discard" }, x.paseo);
  expect(status(x.root)).toEqual(before);
  const kept = join(x.root, ".flowly/handoff/t/op2/worktree-uncommitted.patch");
  expect(readFileSync(join(x.data, "releases", "t-op2-uncommitted.patch"))).toEqual(readFileSync(kept));
  const handoff = read(x.root, ".flowly/handoff/t/op2/handoff.md");
  expect(handoff).toContain(`4 uncommitted change(s) (staged, unstaged and untracked) on top of ${x.head}. The user chose to discard them`);
  expect(handoff).toContain("git apply worktree-uncommitted.patch");
  expect((await x.store.read()).events.find((e) => e.action === "workspace_switched" && /main checkout/.test(e.note || ""))?.note).toMatch(/4 uncommitted changes discarded \(saved as a patch\)/);
  const restore = join(x.top, "restore");
  sh(x.root, "worktree", "add", "-q", "--detach", restore, x.head);
  sh(restore, "apply", kept);
  for (const file of ["shared.txt", "onlyB.txt", "untrackedC.txt", "late.txt"]) expect(read(restore, file)).toBe(read(x.wt, file));
});

test("Overwrite copies what applies and replaces the conflicting files with the worktree's, after saving the main checkout's versions", async () => {
  const x = await dirtyWorktree();
  const mainShared = read(x.root, "shared.txt");
  const result = await x.service.run({ ...x.input, uncommitted: "overwrite" }, x.paseo);
  expect(result.copied).toBe(2);
  expect(read(x.root, "shared.txt")).toBe("edited in the worktree\n");
  expect(read(x.root, "late.txt")).toBe("untracked\n");
  // Already there: untouched; the index is not changed.
  expect(read(x.root, "onlyB.txt")).toBe("x\ny\n");
  expect(read(x.root, "untrackedC.txt")).toBe("scratch C\n");
  expect(sh(x.root, "diff", "--cached", "--name-only").trim()).toBe("");
  expect(read(x.root, ".flowly/handoff/t/op2/main-before/shared.txt")).toBe(mainShared);
  expect(read(x.data, "releases/t-op2-main-before/shared.txt")).toBe(mainShared);
  const handoff = read(x.root, ".flowly/handoff/t/op2/handoff.md");
  expect(handoff).toMatch(/The user chose to overwrite: 1 file\(s\) were applied .*1 file\(s\) the main checkout had changed too were replaced/);
  expect(handoff).toContain("Overwritten:\n- shared.txt");
  expect((await x.store.read()).events.find((e) => e.action === "workspace_switched" && /main checkout/.test(e.note || ""))?.note).toMatch(
    /1 file copied and 1 overwritten in the main checkout/,
  );
});

test("Copy to the main checkout applies the worktree's uncommitted changes there as unstaged changes and keeps other cards' work", async () => {
  const x = await fixture();
  const first = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree", branchName: "kanban/a" }, x.paseo);
  const wt = x.workspaces.get(first.workspaceId)!.workspaceDirectory;
  x.agents.length = 0;
  trim(wt);
  let task = await card(x.store);
  const release = await x.service.releaseCheck("t", x.paseo);
  await x.service.release({ id: "t", revision: task.revision, operationId: "r1", patchHash: release.patchHash, acknowledgeWarnings: true }, x.paseo);
  write(wt, "newA.txt", "new A\nmore\n");
  sh(wt, "add", "newA.txt");
  write(wt, "late.txt", "late\n");
  const check = await x.service.check({ id: "t", direction: "to_local" }, x.paseo);
  expect(check.worktree?.copyBack).toEqual({ files: 3, present: 0, conflicts: [], busy: null });
  task = await card(x.store);
  const result = await x.service.run({ id: "t", revision: task.revision, operationId: "op2", direction: "to_local", uncommitted: "copy" }, x.paseo);
  expect(result.copied).toBe(3);
  expect(read(x.root, "shared.txt")).toBe("a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  expect(read(x.root, "newA.txt")).toBe("new A\nmore\n");
  expect(read(x.root, "late.txt")).toBe("late\n");
  expect(status(x.root)).toEqual([" M onlyB.txt", " M shared.txt", "?? late.txt", "?? newA.txt", "?? untrackedC.txt"]);
  expect(sh(x.root, "diff", "--cached", "--name-only").trim()).toBe("");
  expect(existsSync(join(x.root, ".flowly/handoff/t/op2/worktree-uncommitted.patch"))).toBe(true);
  expect(read(x.root, ".flowly/handoff/t/op2/handoff.md")).toMatch(/chose to copy them to the main checkout: 3 file\(s\) were applied/);
  expect((await card(x.store)).switch).toMatchObject({ direction: "to_local", release: "none" });
  expect((await x.store.read()).events.find((e) => e.action === "workspace_switched" && /main checkout/.test(e.note || ""))?.note).toMatch(/3 files with uncommitted changes copied/);
});

test("a handover is asked only from an idle session of the card", async () => {
  const x = await fixture();
  await x.service.askHandover({ id: "t", agentId: "a1" }, x.paseo);
  expect(x.send).toHaveBeenCalledWith("a1", handoverPrompt);
  x.agents[0].status = "running";
  await expect(x.service.askHandover({ id: "t", agentId: "a1" }, x.paseo)).rejects.toThrow(/busy/);
  x.agents[0].workspaceId = "other";
  await expect(x.service.askHandover({ id: "t", agentId: "a1" }, x.paseo)).rejects.toThrow(/does not belong/);
});

test("more blockers: a finished card, a linked project, a detached HEAD, a merge in progress", async () => {
  const x = await fixture();
  const block = async () => (await x.service.check({ id: "t", direction: "to_worktree" }, x.paseo)).blockers.join(" ");
  await x.store.mutate((b) => void (b.tasks[0].status = "done"));
  expect(await block()).toMatch(/finished/);
  await x.store.mutate((b) => {
    b.tasks[0].status = "development";
    b.projects[0].links = [{ name: "repo", target: x.root }];
  });
  expect(await block()).toMatch(/linked multi-repo/);
  await x.store.mutate((b) => void delete b.projects[0].links);
  sh(x.root, "checkout", "-q", "--detach");
  expect(await block()).toMatch(/detached HEAD/);
  sh(x.root, "checkout", "-q", "main");
  writeFileSync(join(x.root, ".git", "MERGE_HEAD"), sh(x.root, "rev-parse", "HEAD"));
  expect(await block()).toMatch(/middle of a merge/);
});

test("the handover goes into the handoff; release waits while a card session runs", async () => {
  const x = await fixture();
  await x.store.mutate((b) => {
    b.tasks[0].handover = { agentId: "a1", at: new Date().toISOString(), files: ["newA.txt", "shared.txt"], notes: "Line a2 of shared.txt is this card's." };
  });
  const result = await x.service.run({ id: "t", revision: 3, operationId: "op1", direction: "to_worktree" }, x.paseo);
  const wt = x.workspaces.get(result.workspaceId)!.workspaceDirectory;
  const handoff = read(wt, ".flowly/handoff/op1/handoff.md");
  expect(handoff).toMatch(/- newA\.txt/);
  expect(handoff).toMatch(/Line a2 of shared\.txt is this card's\./);
  trim(wt);
  x.agents.push({ id: "a3", workspaceId: result.workspaceId, status: "running", title: "Verify", updatedAt: new Date().toISOString(), archivedAt: null, labels: {}, cwd: wt });
  expect((await x.service.releaseCheck("t", x.paseo)).blockers.join(" ")).toMatch(/still running/);
  x.agents[x.agents.length - 1].status = "idle";
  const check = await x.service.releaseCheck("t", x.paseo);
  expect(check.blockers).toEqual([]);
  expect(check.warnings).toEqual([]);
});

test("every session listing of a switch includes agents in background workspaces", async () => {
  const x = await fixture();
  await x.service.check({ id: "t", direction: "to_worktree" }, x.paseo);
  await x.service.run({ id: "t", revision: 3, operationId: "op-bg", direction: "to_worktree", branchName: "kanban/bg" }, x.paseo);
  expect(x.listCalls.length).toBeGreaterThan(1);
  for (const call of x.listCalls) expect(call).toMatchObject({ filter: { includeBackground: true } });
  expect(await workspaceSessions(x.paseo, "w-local", true)).toHaveLength(1);
  expect(x.listCalls.at(-1)).toMatchObject({ filter: { includeArchived: true, includeBackground: true } });
});
