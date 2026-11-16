import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { SessionReadService, SessionReadStore, unsyncedReads, type NativeAttention } from "./session-reads";
import { manualUnreadToken, nativeAttentionToken, type AttentionAgent } from "../shared/session-attention";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const at = "2026-10-17T10:00:00.000Z";
const unread = (id: string, workspaceId = "w"): AttentionAgent =>
  ({ id, workspaceId, status: "idle", archivedAt: null, requiresAttention: true, attentionReason: "finished", attentionTimestamp: at }) as AttentionAgent;
const receipt = (agent: AttentionAgent, token = nativeAttentionToken(agent)!) =>
  ({ taskId: "t", workspaceId: agent.workspaceId!, agentId: agent.id, token, readAt: at });

test("only sessions read in Flowly for their current attention are cleared in Paseo", () => {
  const current = unread("a1");
  const newer = { ...unread("a2"), attentionTimestamp: "2026-10-17T11:00:00.000Z" } as AttentionAgent;
  const manual = unread("a3");
  const moved = unread("a4", "other");
  const archived = { ...unread("a5"), archivedAt: at } as AttentionAgent;
  const alreadyRead = { ...unread("a6"), requiresAttention: false } as AttentionAgent;
  const receipts = [
    receipt(current),
    receipt(unread("a2")), // read an older finish; the newer one stays unread
    receipt(manual, manualUnreadToken),
    { ...receipt(unread("a4")), workspaceId: "w" },
    receipt(archived),
    receipt(unread("a6")),
  ];
  expect(unsyncedReads(receipts, [current, newer, manual, moved, archived, alreadyRead])).toEqual(["a1"]);
});

async function fixture(agent: AttentionAgent, native: NativeAttention) {
  const root = await mkdtemp(join(tmpdir(), "flowly-reads-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((board) => {
    board.projects.push({
      id: "p", paseoProjectId: "native", title: "P", description: "",
      primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
    });
    board.tasks.push({
      id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root],
      title: "Card", description: "", status: "development", priority: "normal",
      position: 0, revision: 1, operationId: "op", createdAt: now, updatedAt: now, archivedAt: null,
    });
  });
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent }) }) },
    workspaces: { ref: () => ({ refresh: async () => ({ id: "w", archivingAt: null }) }) },
  } as unknown as PaseoApi;
  const reads = new SessionReadStore(store.directory);
  return { reads, paseo, service: new SessionReadService(store, reads, native) };
}

function fakeNative(agents: AttentionAgent[], fail = false) {
  const clear = vi.fn(async (_ids: string[]) => {
    if (fail) throw new Error("daemon down");
  });
  const close = vi.fn(async () => undefined);
  const native: NativeAttention = { connect: async () => ({ agents: async () => agents, clear, close }) };
  return { native, clear, close };
}

test("marking read clears Paseo's unread flag; a failure keeps the receipt for the startup sync", async () => {
  const agent = unread("a1");
  const ok = fakeNative([agent]);
  const done = await fixture(agent, ok.native);
  await done.service.mark({ taskId: "t", agentId: "a1", token: nativeAttentionToken(agent)! }, done.paseo);
  expect(ok.clear).toHaveBeenCalledWith(["a1"]);
  expect(ok.close).toHaveBeenCalled();

  const down = fakeNative([agent], true);
  const failed = await fixture(agent, down.native);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const kept = await failed.service.mark({ taskId: "t", agentId: "a1", token: nativeAttentionToken(agent)! }, failed.paseo);
  error.mockRestore();
  expect(kept?.token).toBe(nativeAttentionToken(agent));
  expect((await failed.reads.read()).receipts).toHaveLength(1);

  const retry = fakeNative([agent]);
  await expect(new SessionReadService(failed.service.board, failed.reads, retry.native).syncNative()).resolves.toBe(1);
  expect(retry.clear).toHaveBeenCalledWith(["a1"]);
});

test("mark as unread never touches Paseo; the sync skips it", async () => {
  const agent = unread("a1");
  const fake = fakeNative([agent]);
  const { service, paseo } = await fixture(agent, fake.native);
  await service.markUnread({ taskId: "t", agentId: "a1" }, paseo);
  await expect(service.syncNative()).resolves.toBe(0);
  expect(fake.clear).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalled();
});

test("a read that changes state reports the card once; reading again or an unmarked session does not", async () => {
  const agent = unread("a1");
  const { service, paseo } = await fixture(agent, fakeNative([agent]).native);
  const onRead = vi.fn(async () => undefined);
  service.onRead = onRead;
  const input = { taskId: "t", agentId: "a1", token: nativeAttentionToken(agent)! };
  await service.mark(input, paseo);
  expect(onRead).toHaveBeenCalledTimes(1);
  expect(onRead).toHaveBeenCalledWith("t", "p");
  await service.mark(input, paseo);
  expect(onRead).toHaveBeenCalledTimes(1);
});

test("a failing onRead hook never fails the read", async () => {
  const agent = unread("a1");
  const { service, paseo, reads } = await fixture(agent, fakeNative([agent]).native);
  service.onRead = async () => {
    throw new Error("boom");
  };
  await expect(service.mark({ taskId: "t", agentId: "a1", token: nativeAttentionToken(agent)! }, paseo)).resolves.toBeTruthy();
  expect((await reads.read()).receipts).toHaveLength(1);
});
