import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { openKanbanSession } from "./session-open";

const paseo = {} as PaseoApi,
  mcp = { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } };
function request(overrides: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return {
    agentId: "a",
    workspaceId: "w",
    provider: "claude",
    cwd: "/tmp",
    reason: "resume",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [],
    env: { KEEP: "1" },
    mcpServers: { other: { type: "http", url: "http://other" } },
    ...overrides,
  };
}
function tools(launch: () => Promise<{ contextFile: string; mcp: typeof mcp | null } | null>) {
  return { attach: vi.fn(), sessionLaunch: vi.fn(launch) };
}
afterEach(() => vi.restoreAllMocks());

test("a managed session gets its environment and, at launch, the flowly server beside other plugins' servers", async () => {
  const opened = await openKanbanSession(request(), tools(async () => ({ contextFile: "/d/sessions/a.json", mcp })), "/d", paseo);
  expect(opened?.env).toEqual({
    KEEP: "1",
    FLOWLY_CONTEXT_FILE: "/d/sessions/a.json",
    FLOWLY_CLI: "/d/flowly.mjs",
    FLOWLY_SKILL: "/d/SKILL.md",
  });
  expect(opened?.mcpServers).toEqual({ other: { type: "http", url: "http://other" }, flowly: mcp });
});
test("no MCP server when the launch withholds it; unmanaged and history opens pass through", async () => {
  const cliOnly = await openKanbanSession(request(), tools(async () => ({ contextFile: "/d/s.json", mcp: null })), "/d", paseo);
  expect(cliOnly?.mcpServers).toEqual({ other: { type: "http", url: "http://other" } });
  expect(await openKanbanSession(request(), tools(async () => null), "/d", paseo)).toBeUndefined();
  const history = tools(async () => ({ contextFile: "/d/s.json", mcp }));
  expect(await openKanbanSession(request({ purpose: "history" }), history, "/d", paseo)).toBeUndefined();
  expect(history.sessionLaunch).not.toHaveBeenCalled();
});
test("a failure is logged and never thrown, so the session still opens", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(
    openKanbanSession(request(), tools(async () => { throw new Error("disk"); }), "/d", paseo),
  ).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith("Kanban session tools unavailable:", "a", "disk");
});
