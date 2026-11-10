import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { ComposerService, ComposerStore } from "./composer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(status = "running") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-composer-")));
  roots.push(root);
  const board = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const agent = { id: "a", workspaceId: "w", status, archivedAt: null, pendingPermissions: [] as unknown[] };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } as unknown as PaseoApi;
  const sent: { text: string; steer: boolean }[] = [];
  const images: unknown[] = [];
  let fail = false;
  let now_ = 1_000_000;
  const service = new ComposerService(
    new ComposerStore(board.directory),
    board,
    async (_p, _id, text, steer, attached) => {
      if (fail) throw new Error("offline");
      sent.push({ text, steer });
      if (attached?.length) images.push(...attached);
    },
    () => now_,
  );
  return { service, paseo, agent, sent, images, setFail: (v: boolean) => (fail = v), tick: (ms: number) => (now_ += ms), board };
}

test("drafts and queued messages persist across a new service instance (plugin reload)", async () => {
  const x = await setup();
  await x.service.saveDraft({ taskId: "t", agentId: "a", text: "half typed" });
  await x.service.push({ taskId: "t", agentId: "a", text: "after this turn" }, x.paseo);
  await x.service.idle();
  const reloaded = new ComposerService(new ComposerStore(x.board.directory), x.board);
  const state = await reloaded.read();
  expect(state.sessions.a).toMatchObject({ draft: "half typed", queue: [{ text: "after this turn" }] });
});

test("queue drains one message per idle turn; running sessions wait", async () => {
  const x = await setup("running");
  await x.service.push({ taskId: "t", agentId: "a", text: "one" }, x.paseo);
  await x.service.push({ taskId: "t", agentId: "a", text: "two" }, x.paseo);
  await x.service.idle(); // pushes trigger a background drain check
  expect(await x.service.drain("a", x.paseo)).toBe(false);
  x.agent.status = "idle";
  expect(await x.service.drain("a", x.paseo)).toBe(true);
  expect(await x.service.drain("a", x.paseo)).toBe(false); // cooldown: next turn
  x.tick(10_000);
  expect(await x.service.drain("a", x.paseo)).toBe(true);
  expect(x.sent).toEqual([{ text: "one", steer: false }, { text: "two", steer: false }]);
  expect((await x.service.read()).sessions.a).toBeUndefined();
});

test("send now steers the running turn; failures go back to the front with an error", async () => {
  const x = await setup("running");
  const a = await x.service.push({ taskId: "t", agentId: "a", text: "first" }, x.paseo);
  await x.service.push({ taskId: "t", agentId: "a", text: "second" }, x.paseo);
  await x.service.idle();
  await x.service.sendNow({ taskId: "t", agentId: "a", id: a.id }, x.paseo);
  expect(x.sent).toEqual([{ text: "first", steer: true }]);
  x.agent.status = "idle";
  x.setFail(true);
  expect(await x.service.drain("a", x.paseo)).toBe(false);
  const entry = (await x.service.read()).sessions.a;
  expect(entry.queue.map((m) => m.text)).toEqual(["second"]);
  expect(entry.lastError).toBe("offline");
  await expect(x.service.sendNow({ taskId: "t", agentId: "a", id: "missing" }, x.paseo)).rejects.toThrow(/already sent/);
});

test("pushes are checked against the card workspace; corrupt files are preserved", async () => {
  const x = await setup();
  x.agent.workspaceId = "other";
  await expect(x.service.push({ taskId: "t", agentId: "a", text: "x" }, x.paseo)).rejects.toThrow(/different workspace/);
  await x.service.idle();
  const store = new ComposerStore(x.board.directory);
  await writeFile(store.path, "{broken");
  await expect(store.read()).rejects.toThrow(/preserved/);
  expect(await readFile(store.path, "utf8")).toBe("{broken");
});

test("entries of archived cards are pruned", async () => {
  const x = await setup("idle");
  await x.service.saveDraft({ taskId: "t", agentId: "a", text: "left over" });
  await x.board.mutate((b) => {
    b.tasks[0].archivedAt = new Date().toISOString();
  });
  await x.service.drainAll(x.paseo);
  expect((await x.service.read()).sessions).toEqual({});
});

test("queued images are kept as daemon files, sent with their message, then deleted", async () => {
  const x = await setup("running");
  const png = { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" as const };
  const item = await x.service.push({ taskId: "t", agentId: "a", text: "", images: [png] }, x.paseo);
  const dir = join(x.board.directory, "composer-images");
  expect(item.images).toEqual([{ file: `${item.id}-0.png`, mimeType: "image/png" }]);
  expect((await readFile(join(dir, `${item.id}-0.png`))).toString()).toBe("png-bytes");
  await x.service.idle();
  x.agent.status = "idle";
  expect(await x.service.drain("a", x.paseo)).toBe(true);
  expect(x.images).toEqual([png]);
  await expect(readFile(join(dir, `${item.id}-0.png`))).rejects.toThrow();
  // Removing a queued message deletes its image too.
  x.agent.status = "running";
  const other = await x.service.push({ taskId: "t", agentId: "a", text: "x", images: [png] }, x.paseo);
  await x.service.remove({ agentId: "a", id: other.id });
  await expect(readFile(join(dir, `${other.id}-0.png`))).rejects.toThrow();
});
