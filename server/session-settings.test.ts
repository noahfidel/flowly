import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SessionSettingsService } from "./session-settings";
import { configureSession, dispatcherConfigure } from "../shared/rpc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(agent: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-settings-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const calls: string[][] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } as unknown as PaseoApi;
  const service = new SessionSettingsService(store, async (_bin, args) => {
    calls.push(args);
    return "";
  }, async () => "/bin/paseo");
  return { service, paseo, calls };
}
const live = { id: "a1", workspaceId: "w", archivedAt: null, availableModes: [{ id: "plan" }, { id: "bypassPermissions" }] };

test("reasoning, permissions and stop go to the CLI as argument arrays", async () => {
  const x = await setup(live);
  const result = await x.service.apply({ taskId: "t", agentId: "a1", thinkingOptionId: "high", modeId: "plan", stop: true }, x.paseo);
  expect(result.applied).toEqual(["stopped", "reasoning", "permissions"]);
  expect(x.calls.map((c) => c.slice(0, 4))).toEqual([
    ["agent", "stop", "a1", "--home"],
    ["agent", "update", "a1", "--thinking"],
    ["agent", "mode", "a1", "plan"],
  ]);
  expect(x.calls[1][4]).toBe("high");
});

test("rejects other workspaces, archived sessions and unknown modes without running the CLI", async () => {
  for (const [agent, pattern] of [
    [{ ...live, workspaceId: "other" }, /different workspace/],
    [{ ...live, archivedAt: "2026-10-15T00:00:00Z" }, /Restore/],
  ] as const) {
    const x = await setup(agent);
    await expect(x.service.apply({ taskId: "t", agentId: "a1", modeId: "plan" }, x.paseo)).rejects.toThrow(pattern);
    expect(x.calls).toEqual([]);
  }
  const x = await setup(live);
  await expect(x.service.apply({ taskId: "t", agentId: "a1", modeId: "yolo" }, x.paseo)).rejects.toThrow(/not available/);
  expect(x.calls).toEqual([]);
});

test("RPC input refuses option-like IDs and empty changes", () => {
  const parse = (i: unknown) => configureSession.input.safeParse(i).success;
  expect(parse({ taskId: "t", agentId: "a1", thinkingOptionId: "high" })).toBe(true);
  expect(parse({ taskId: "t", agentId: "a1", thinkingOptionId: "--home" })).toBe(false);
  expect(parse({ taskId: "t", agentId: "-a", stop: true })).toBe(false);
  expect(parse({ taskId: "t", agentId: "a1" })).toBe(false);
});

test("renaming passes one --name= argument, so a dash-leading title is never an option", async () => {
  const x = await setup(live);
  const result = await x.service.apply({ taskId: "t", agentId: "a1", title: "--stop me" }, x.paseo);
  expect(result.applied).toEqual(["title"]);
  expect(x.calls[0].slice(0, 4)).toEqual(["agent", "update", "a1", "--name=--stop me"]);
  const parse = (title: unknown) => configureSession.input.safeParse({ taskId: "t", agentId: "a1", title }).success;
  expect(parse("  Fix login  ")).toBe(true);
  expect(parse("   ")).toBe(false);
  expect(parse("two\nlines")).toBe(false);
  expect(configureSession.input.parse({ taskId: "t", agentId: "a1", title: "  Fix login  " }).title).toBe("Fix login");
});

// dispatcher.configure (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-11): the same changes, only for the group's stored dispatcher.
test("dispatcher.configure changes only the group's stored dispatcher session, in its workspace", async () => {
  const dispatcherAgent = { id: "d1", workspaceId: "dw", archivedAt: null, availableModes: [{ id: "default" }, { id: "bypassPermissions" }] };
  const x = await setup(dispatcherAgent);
  x.service.dispatcher = async (groupId) => (groupId === "g1" ? { agentId: "d1", workspaceId: "dw" } : null);
  const result = await x.service.dispatcherApply({ groupId: "g1", agentId: "d1", modeId: "bypassPermissions", thinkingOptionId: "high", stop: true }, x.paseo);
  expect(result.applied).toEqual(["stopped", "reasoning", "permissions"]);
  expect(x.calls.map((c) => c.slice(0, 4))).toEqual([
    ["agent", "stop", "d1", "--home"],
    ["agent", "update", "d1", "--thinking"],
    ["agent", "mode", "d1", "bypassPermissions"],
  ]);
});

test("dispatcher.configure refuses any other session, another group, a moved session and unknown modes without running the CLI", async () => {
  const refused = async (agent: Record<string, unknown>, input: { groupId: string; agentId: string; modeId?: string }, pattern: RegExp) => {
    const x = await setup(agent);
    x.service.dispatcher = async (groupId) => (groupId === "g1" ? { agentId: "d1", workspaceId: "dw" } : null);
    await expect(x.service.dispatcherApply(input, x.paseo)).rejects.toThrow(pattern);
    expect(x.calls).toEqual([]);
  };
  const d1 = { id: "d1", workspaceId: "dw", archivedAt: null, availableModes: [{ id: "default" }] };
  // A card's session (or any other id) through the dispatcher route.
  await refused({ ...live }, { groupId: "g1", agentId: "a1", modeId: "plan" }, /not the dispatcher/);
  // A group with no dispatcher.
  await refused(d1, { groupId: "g2", agentId: "d1", modeId: "default" }, /not the dispatcher/);
  // The stored id, but Paseo has it in another workspace.
  await refused({ ...d1, workspaceId: "w" }, { groupId: "g1", agentId: "d1", modeId: "default" }, /different workspace/);
  await refused(d1, { groupId: "g1", agentId: "d1", modeId: "yolo" }, /not available/);
});

test("dispatcher.configure input: no taskId or title, option-like IDs and empty changes refused", () => {
  const parse = (i: unknown) => dispatcherConfigure.input.safeParse(i).success;
  expect(parse({ groupId: "g1", agentId: "d1", modeId: "bypassPermissions" })).toBe(true);
  expect(parse({ groupId: "g1", agentId: "d1", stop: true })).toBe(true);
  expect(parse({ groupId: "g1", agentId: "d1" })).toBe(false);
  expect(parse({ groupId: "g1", agentId: "-d1", stop: true })).toBe(false);
  expect(parse({ groupId: "g1", agentId: "d1", thinkingOptionId: "--home" })).toBe(false);
  expect(parse({ groupId: "g1", agentId: "d1", taskId: "t", stop: true })).toBe(false);
  expect(parse({ groupId: "g1", agentId: "d1", title: "x" })).toBe(false);
});
