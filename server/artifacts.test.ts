import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentFixture } from "./agent-fixture";
import { ArtifactService, artifactRoots, editArtifact, extraFolderRoots, missingArtifacts, normalizeTarget, putArtifact, resolveExtraRoots } from "./artifacts";
import { artifactSettingsValues, extraFolderIgnored } from "../shared/settings";
import { homedir } from "node:os";
import type { Artifact } from "../shared/model";
import { artifactContextLines } from "../shared/artifacts";
import { AgentService } from "./agent-service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  await mkdir(join(f.a, "docs"));
  await writeFile(join(f.a, "docs", "spec.md"), "# Spec\n");
  await writeFile(join(f.b, "report.txt"), "report");
  await mkdir(join(f.root, "outside"));
  await writeFile(join(f.root, "outside", "secret.txt"), "secret");
  return { ...f, artifacts: new ArtifactService(f.store) };
}
const input = (ctx: Awaited<ReturnType<AgentService["get"]>>) => ({ expectedRevision: ctx.revision, request: ctx.request });

test("targets: workspace files become ./relative, other scope files stay absolute, links pass, the rest is refused", async () => {
  const x = await setup();
  const where = { workspace: x.a, roots: [x.a, x.b] };
  expect(await normalizeTarget("docs/spec.md", where)).toEqual({ kind: "file", target: "./docs/spec.md" });
  expect(await normalizeTarget(join(x.a, "docs"), where)).toEqual({ kind: "file", target: "./docs" });
  expect(await normalizeTarget(`file://${join(x.b, "report.txt")}`, where)).toEqual({ kind: "file", target: join(x.b, "report.txt") });
  expect(await normalizeTarget("https://example.com/pr/1", where)).toEqual({ kind: "url", target: "https://example.com/pr/1" });
  await expect(normalizeTarget("ftp://example.com/x", where)).rejects.toThrow("Only http and https");
  await expect(normalizeTarget("missing.md", where)).rejects.toThrow("doesn't exist");
  await expect(normalizeTarget("../outside/secret.txt", where)).rejects.toThrow("outside this card's directories");
  // A symlink inside the workspace pointing outside does not escape.
  await symlink(join(x.root, "outside", "secret.txt"), join(x.a, "leak.txt"));
  await expect(normalizeTarget("leak.txt", where)).rejects.toThrow("outside this card's directories");
});

test("human create, dedupe, edit conflict and delete; board revision only, events recorded", async () => {
  const x = await setup();
  const before = await x.store.read();
  const created = await x.artifacts.create({ taskId: "t", role: "input", target: "docs/spec.md" }, x.paseo);
  expect(created).toMatchObject({ kind: "file", target: "./docs/spec.md", title: "spec.md", createdBy: "human", role: "input" });
  let board = await x.store.read();
  expect(board.revision).toBe(before.revision + 1);
  expect(board.tasks[0].revision).toBe(1);
  expect(board.events.at(-1)).toMatchObject({ action: "artifact_added", actor: "human", note: "Input: spec.md" });
  // Same target again: one record, the given fields applied.
  const again = await x.artifacts.create({ taskId: "t", role: "output", target: join(x.a, "docs/spec.md"), note: "the spec" }, x.paseo);
  expect(again.id).toBe(created.id);
  board = await x.store.read();
  expect(board.artifacts).toHaveLength(1);
  expect(board.artifacts[0]).toMatchObject({ role: "output", note: "the spec" });
  await expect(x.artifacts.update({ id: created.id, updatedAt: created.updatedAt, title: "x" })).rejects.toThrow("changed");
  const edited = await x.artifacts.update({ id: created.id, updatedAt: board.artifacts[0].updatedAt, title: "Spec" });
  expect(edited.title).toBe("Spec");
  await x.artifacts.delete({ id: created.id });
  board = await x.store.read();
  expect(board.artifacts).toHaveLength(0);
  expect(board.events.at(-1)).toMatchObject({ action: "artifact_removed", note: "Output: Spec" });
  await expect(x.artifacts.delete({ id: created.id })).rejects.toThrow("no longer exists");
});

test("archived cards refuse changes; missing files are reported; preview reads only registered targets", async () => {
  const x = await setup();
  const spec = await x.artifacts.create({ taskId: "t", role: "output", target: "docs/spec.md" }, x.paseo);
  const dir = await x.artifacts.create({ taskId: "t", role: "input", target: "docs" }, x.paseo);
  expect(await x.artifacts.preview({ id: spec.id }, x.paseo)).toEqual({ type: "text", text: "# Spec\n", markdown: true });
  expect(await x.artifacts.preview({ id: dir.id }, x.paseo)).toMatchObject({ type: "directory", entries: [{ name: "spec.md", directory: false }] });
  await rm(join(x.a, "docs", "spec.md"));
  expect((await x.artifacts.status({ taskId: "t" }, x.paseo)).missing).toEqual([spec.id]);
  await expect(x.artifacts.preview({ id: spec.id }, x.paseo)).rejects.toThrow("no longer exists");
  // Swapped for a symlink to a file outside the card: still refused.
  await symlink(join(x.root, "outside", "secret.txt"), join(x.a, "docs", "spec.md"));
  await expect(x.artifacts.preview({ id: spec.id }, x.paseo)).rejects.toThrow("no longer exists");
  await x.store.mutate((b) => void (b.tasks[0].archivedAt = new Date().toISOString()));
  await expect(x.artifacts.create({ taskId: "t", role: "input", target: "https://a.example" }, x.paseo)).rejects.toThrow("Archived");
  await expect(x.artifacts.delete({ id: dir.id })).rejects.toThrow("Archived");
});

test("agent tools: add, update own, keep human ones, remove only agent ones, setting off, replay", async () => {
  const x = await setup();
  const human = await x.artifacts.create({ taskId: "t", role: "input", target: "https://issue.example/1" }, x.paseo);
  let ctx = await x.service.get(x.identity);
  expect(ctx.artifacts).toEqual([
    expect.objectContaining({ id: human.id, createdBy: "human", missing: false, kind: "url" }),
  ]);
  const added = await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "docs/spec.md", note: "Design" });
  expect(added.artifactId).toBeTruthy();
  expect(added.receipt.taskRevision).toBe(ctx.revision.task);
  const fromAgent = (await x.store.read()).artifacts.find((a) => a.id === added.artifactId)!;
  expect(fromAgent).toMatchObject({ createdBy: "agent", agentId: "actor", target: "./docs/spec.md" });
  expect(added.current?.artifacts.find((a) => a.id === fromAgent.id)?.absolutePath).toBe(join(x.a, "docs/spec.md"));
  // Replay of the same request: same receipt, no second record.
  const replay = await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "docs/spec.md", note: "Design" });
  expect(replay.replayed).toBe(true);
  expect(replay.artifactId).toBe(added.artifactId);
  // An agent re-adding the user's link leaves it unchanged.
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "https://issue.example/1", title: "Mine" });
  expect((await x.store.read()).artifacts.find((a) => a.id === human.id)).toMatchObject({ role: "input", title: human.title });
  ctx = await x.service.get(x.identity);
  await expect(x.service.write(x.identity, "artifact_remove", { ...input(ctx), id: human.id })).rejects.toMatchObject({ code: "ARTIFACT_FORBIDDEN" });
  await expect(
    x.service.write(x.identity, "artifact", { ...input(ctx), role: "input", target: join(x.root, "outside", "secret.txt") }),
  ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  const removed = await x.service.write({ ...x.identity, agentId: "second" }, "artifact_remove", { ...input(await x.service.get({ ...x.identity, agentId: "second" })), id: fromAgent.id });
  expect(removed.artifactId).toBe(fromAgent.id);
  x.service.artifactsOn = async () => false;
  ctx = await x.service.get(x.identity);
  await expect(x.service.write(x.identity, "artifact", { ...input(ctx), role: "input", target: "docs" })).rejects.toMatchObject({ code: "ARTIFACTS_DISABLED" });
});

test("deleting a card drops and backs up its artifacts; session context lists inputs and outputs", async () => {
  const x = await setup();
  await x.artifacts.create({ taskId: "t", role: "input", target: "https://issue.example/1", title: "Issue" }, x.paseo);
  const { backup } = await x.store.deleteTask({ id: "t", revision: 1 });
  expect((await x.store.read()).artifacts).toEqual([]);
  expect(JSON.parse(await readFile(backup, "utf8")).artifacts).toHaveLength(1);
  const lines = artifactContextLines(
    Array.from(
      { length: 12 },
      (_, i) => ({ role: i ? "output" : "input", title: `T${i}`, target: `./f${i}`, note: "", createdBy: i === 11 ? "human" : "agent" }) as never,
    ),
  );
  expect(lines.slice(0, 4)).toEqual(["Inputs:", "- [agent] T0: ./f0", "Outputs so far:", "- [user] T11: ./f11"]);
  expect(lines.at(-1)).toBe("- …and 1 more");
  // The user's inputs come first and carry their note on one line.
  const inputs = artifactContextLines([
    { role: "input", title: "Log", target: "./log.txt", note: "", createdBy: "agent" },
    { role: "input", title: "API", target: "https://api.example/doc", note: "Follow this\nformat", createdBy: "human" },
  ] as never);
  expect(inputs).toEqual(["Inputs:", "- [user] API: https://api.example/doc — Follow this format", "- [agent] Log: ./log.txt"]);
});

test("unread: artifacts added or edited since the session's last get_task, never its own; survives a restart", async () => {
  const x = await setup();
  const human = await x.artifacts.create({ taskId: "t", role: "input", target: "docs/spec.md", note: "Follow it" }, x.paseo);
  // First read: everything the session has not added itself is unread, then it is read.
  expect((await x.service.get(x.identity)).artifacts.map((a) => a.unread)).toEqual([true]);
  let ctx = await x.service.get(x.identity);
  expect(ctx.artifacts.map((a) => a.unread)).toEqual([false]);
  // The session's own addition is never unread; the write's context does not mark anything read.
  const later = await x.artifacts.create({ taskId: "t", role: "input", target: "https://issue.example/2" }, x.paseo);
  const own = await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "docs" });
  expect(own.current?.artifacts.find((a) => a.id === own.artifactId)?.unread).toBe(false);
  expect(own.current?.artifacts.find((a) => a.id === later.id)?.unread).toBe(true);
  // Another session sees all three as unread on its first read.
  expect((await x.service.get({ ...x.identity, agentId: "second" })).artifacts.every((a) => a.unread)).toBe(true);
  // An edit by the user makes it unread again, also for a fresh service reading the same data.
  ctx = await x.service.get(x.identity);
  expect(ctx.artifacts.filter((a) => a.unread).map((a) => a.id)).toEqual([later.id]);
  expect((await x.service.get(x.identity)).artifacts.filter((a) => a.unread)).toEqual([]);
  const stored = (await x.store.read()).artifacts.find((a) => a.id === human.id)!;
  await new Promise((r) => setTimeout(r, 5));
  await x.artifacts.update({ id: human.id, updatedAt: stored.updatedAt, note: "Use section 3" });
  const restarted = new AgentService(x.store, x.secrets);
  restarted.attach(x.paseo);
  expect((await restarted.get(x.identity)).artifacts.filter((a) => a.unread).map((a) => a.id)).toEqual([human.id]);
});

const pull = { connectionId: "c1", provider: "github", key: "o/r#5", remoteId: "5", itemType: "pull" } as const;
const pullUrl = "https://github.com/o/r/pull/5";

test("external items keep the role they are given; editing can change it (CARD-ARTIFACTS-SPEC §2.2)", async () => {
  const x = await setup();
  const pr = { taskId: "t", kind: "url", target: pullUrl, external: pull, createdBy: "agent", agentId: "actor" } as const;
  const out = await x.store.transaction((board) => ({ value: putArtifact(x.store, board, { ...pr, role: "output" }), changed: true }));
  expect(out.artifact).toMatchObject({ role: "output", external: { key: "o/r#5" } });
  expect(out.notice).toBeUndefined();
  // The same agent registers it again as an input: the role follows, nothing is forced back.
  const again = await x.store.transaction((board) => ({ value: putArtifact(x.store, board, { ...pr, role: "input" }), changed: true }));
  expect(again.artifact).toMatchObject({ id: out.artifact.id, role: "input" });
  const edited = await editArtifact(x.store, { id: out.artifact.id, updatedAt: again.artifact.updatedAt, role: "output" });
  expect(edited).toMatchObject({ role: "output", external: { key: "o/r#5" } });
});

test("a person's paste or picker defaults to input; an explicit output stays output", async () => {
  const x = await setup();
  const human = { taskId: "t", kind: "url", target: pullUrl, external: pull, createdBy: "human" } as const;
  const picked = await x.store.transaction((board) => ({ value: putArtifact(x.store, board, { ...human, role: "input" }), changed: true }));
  expect(picked.artifact.role).toBe("input");
  const second = await x.store.transaction((board) => ({
    value: putArtifact(x.store, board, { ...human, target: "https://github.com/o/r/pull/6", external: { ...pull, key: "o/r#6", remoteId: "6" }, role: "output" }),
    changed: true,
  }));
  expect(second.artifact.role).toBe("output");
});

test("an agent re-adding a person's item with another role is told, not silently ignored", async () => {
  const x = await setup();
  const base = { taskId: "t", kind: "url", target: pullUrl, external: pull } as const;
  const mine = await x.store.transaction((board) => ({ value: putArtifact(x.store, board, { ...base, role: "input", createdBy: "human" }), changed: true }));
  const put = await x.store.transaction((board) => ({
    value: putArtifact(x.store, board, { ...base, role: "output", createdBy: "agent", agentId: "actor" }),
    changed: false,
  }));
  expect(put).toMatchObject({ changed: false, artifact: { id: mine.artifact.id, role: "input" } });
  expect(put.notice).toMatch(/added by the user as input/);
  // The same role needs no notice.
  const same = await x.store.transaction((board) => ({
    value: putArtifact(x.store, board, { ...base, role: "input", createdBy: "agent", agentId: "actor" }),
    changed: false,
  }));
  expect(same.notice).toBeUndefined();
});

test("agent tool result carries the notice and keeps it on replay", async () => {
  const x = await setup();
  await x.artifacts.create({ taskId: "t", role: "input", target: "https://issue.example/1" }, x.paseo);
  const ctx = await x.service.get(x.identity);
  const first = await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "https://issue.example/1" });
  expect(first.notice).toMatch(/role not changed/);
  const replay = await x.service.write(x.identity, "artifact", { ...input(ctx), role: "output", target: "https://issue.example/1" });
  expect(replay).toMatchObject({ replayed: true, notice: first.notice });
});

async function extraSetup() {
  const x = await setup();
  const board = await x.store.read();
  const extra = join(x.root, "extra", "plans");
  await mkdir(extra, { recursive: true });
  await writeFile(join(extra, "a.md"), "plan");
  await mkdir(join(x.root, "extra", "plans-old"), { recursive: true });
  await writeFile(join(x.root, "extra", "plans-old", "a.md"), "old");
  const where = (folders: string[]) => artifactRoots(board.tasks[0], board.projects[0], x.a, folders);
  return { ...x, extra, where };
}

test("a file inside an extra folder is accepted and stored absolute", async () => {
  const x = await extraSetup();
  const file = join(x.extra, "a.md");
  await expect(normalizeTarget(file, x.where([]))).rejects.toThrow("outside this card's directories");
  expect(await normalizeTarget(file, x.where([x.extra]))).toEqual({ kind: "file", target: file });
  // A trailing slash on the setting changes nothing.
  expect(await normalizeTarget(file, x.where([`${x.extra}/`]))).toEqual({ kind: "file", target: file });
});

test("a sibling folder whose name starts with the extra folder's name is refused", async () => {
  const x = await extraSetup();
  await expect(normalizeTarget(join(x.root, "extra", "plans-old", "a.md"), x.where([x.extra]))).rejects.toThrow("outside this card's directories");
});

test("a symlink inside an extra folder that points outside it is refused", async () => {
  const x = await extraSetup();
  await symlink(join(x.root, "outside", "secret.txt"), join(x.extra, "leak.txt"));
  await expect(normalizeTarget(join(x.extra, "leak.txt"), x.where([x.extra]))).rejects.toThrow("outside this card's directories");
});

test("missingArtifacts keeps a file in an extra folder and flags it once the folder is removed from the setting", async () => {
  const x = await extraSetup();
  const list = [{ id: "f", kind: "file", target: join(x.extra, "a.md") }] as Artifact[];
  expect([...(await missingArtifacts(list, x.where([x.extra])))]).toEqual([]);
  expect([...(await missingArtifacts(list, x.where([])))]).toEqual(["f"]);
});

test("relative and empty extra folders are ignored", async () => {
  const x = await extraSetup();
  expect(artifactSettingsValues({ extraFolders: ["", "  ", "plans", "./plans", "../x", "/", "//", "~other/x", "/abs/ok/", "~/notes/"] }).extraFolders).toEqual(["/abs/ok", "~/notes"]);
  expect(artifactSettingsValues({}).extraFolders).toEqual([]);
  expect(extraFolderRoots(["", "/", "//", "relative/dir", ".", "~", `${homedir()}/`, `${x.extra}/`, "~/notes/", `${x.extra}/../plans`])).toEqual([x.extra, join(homedir(), "notes")]);
  // Even when a caller passes them raw, they never become roots: "" would resolve to the working directory, "/" to everything.
  const roots = x.where(["", "/", "relative"]).roots;
  expect(roots).not.toContain("");
  expect(roots).not.toContain("/");
  expect(roots).not.toContain("relative");
  await expect(normalizeTarget(join(x.extra, "a.md"), x.where(["", "/"]))).rejects.toThrow("outside this card's directories");
  await expect(normalizeTarget(join(process.cwd(), "package.json"), x.where([""]))).rejects.toThrow("outside this card's directories");
});

test("extra roots are decided on resolved paths: a link to / or to home, a case variant of home, home and its ancestors are dropped", async () => {
  const x = await extraSetup();
  const home = join(x.root, "home", "me");
  await mkdir(join(home, "notes"), { recursive: true });
  const toRoot = join(x.root, "link-root");
  const toHome = join(x.root, "link-home");
  await symlink("/", toRoot);
  await symlink(home, toHome);
  expect(await resolveExtraRoots([toRoot, "/", toHome, home, dirname(home), dirname(dirname(home)), join(home, ".."), join(x.root, "missing")], home)).toEqual([]);
  // The home directory's own subfolders stay usable; the root is the real path.
  expect(await resolveExtraRoots([join(home, "notes"), `${toHome}/notes`], home)).toEqual([await realpath(join(home, "notes"))]);
  // macOS: /USERS/NOAH… names the same directory as /Users/noah…; skipped where the filesystem is case-sensitive.
  const upper = home.toUpperCase();
  if ((await realpath(upper).catch(() => null)) === (await realpath(home))) expect(await resolveExtraRoots([upper, dirname(upper)], home)).toEqual([]);
  expect(await resolveExtraRoots([x.extra], home)).toEqual([await realpath(x.extra)]);
});

test("extra roots are compared as resolved at the settings read: a folder swapped for a link afterwards does not widen them", async () => {
  const x = await extraSetup();
  const where = x.where(await resolveExtraRoots([x.extra]));
  expect(where.roots).not.toContain(x.extra);
  expect(where.resolved).toEqual([x.extra]);
  // After the read, the folder is replaced by a link to a directory outside the card's.
  await rm(x.extra, { recursive: true });
  await symlink(join(x.root, "outside"), x.extra);
  await expect(normalizeTarget(join(x.extra, "secret.txt"), where)).rejects.toThrow("outside this card's directories");
  const list = [{ id: "f", kind: "file", target: join(x.extra, "secret.txt") }] as Artifact[];
  expect([...(await missingArtifacts(list, where))]).toEqual(["f"]);
  // No extra folders: nothing to resolve.
  expect(await resolveExtraRoots([], join(x.root, "no-such-home"))).toEqual([]);
});

test("a symlink to / set as an extra folder does not open the filesystem to attachments", async () => {
  const x = await extraSetup();
  const toRoot = join(x.root, "link-root");
  await symlink("/", toRoot);
  const service = new ArtifactService(x.store, undefined, async () => [toRoot]);
  await expect(service.create({ taskId: "t", role: "input", target: join(x.root, "outside", "secret.txt") }, x.paseo)).rejects.toThrow("outside this card's directories");
  const ok = new ArtifactService(x.store, undefined, async () => [join(x.root, "outside")]);
  expect(await ok.create({ taskId: "t", role: "input", target: join(x.root, "outside", "secret.txt") }, x.paseo)).toMatchObject({ kind: "file" });
});

test("the Settings note flags exactly the entries the server ignores by text", () => {
  for (const bad of ["plans", "./plans", "../x", "~other/x", "/", "//", "~", "~/", "~/..", "~/a/..", "~/../.."]) expect(extraFolderIgnored(bad), bad).toBe(true);
  for (const ok of ["/abs/ok", "/abs/ok/", "~/notes", "~/.claude/plans", "~/a/../b", "C:\\work\\plans", ""]) expect(extraFolderIgnored(ok), ok).toBe(false);
  // The server drops what the note flags.
  expect(extraFolderRoots(["plans", "~other/x", "/", "~", "~/..", "~/a/.."], "/home/me")).toEqual([]);
});
