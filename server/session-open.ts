import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { ToolServer } from "./tool-server";
import { logFailure } from "./error-report";
import { dispatcherServerName } from "../shared/dispatcher";

/**
 * The `addHook("agent.open.before")` hook. Never throws: a failure here would keep the session from opening, so each
 * step is logged and the request passes on.
 *
 * 1. The stored dispatcher: one started before its tools were saved gets its `flowly-dispatcher` server at each open,
 *    one saved with them gets nothing; never card context or board tools. No other session gets them
 *    (DISPATCHER-SPEC §3).
 * 2. A Kanban-managed interactive session gets its CLI environment and, at launch only, the `flowly` MCP server
 *    (PASEO-SESSION-TOOLS-SPEC §4).
 * 3. Sessions outside cards get the project's card tools as `flowly-board` (AGENT-CARDS-SPEC §2.2).
 */
export async function openKanbanSession(
  request: PluginSessionOpenRequest,
  tools: Pick<ToolServer, "attach" | "sessionLaunch"> & Partial<Pick<ToolServer, "dispatcherSession" | "boardServer">>,
  directory: string,
  paseo: PaseoApi,
): Promise<PluginSessionOpenRequest | void> {
  try {
    tools.attach(paseo);
  } catch (e) {
    logFailure("Kanban session tools unavailable:", e, request.agentId);
    return;
  }
  if (request.purpose !== "interactive") return;
  if (tools.dispatcherSession) {
    try {
      const own = await tools.dispatcherSession(request.agentId, paseo);
      if (own) return own.mcp ? { ...request, mcpServers: { ...request.mcpServers, [dispatcherServerName]: own.mcp } } : undefined;
    } catch (e) {
      logFailure("Flowly dispatcher tools not added to its session:", e, request.agentId);
    }
  }
  try {
    const launch = await tools.sessionLaunch(request.agentId, request.workspaceId, paseo);
    if (launch)
      return {
        ...request,
        env: {
          ...request.env,
          FLOWLY_CONTEXT_FILE: launch.contextFile,
          FLOWLY_CLI: directory + "/flowly.mjs",
          FLOWLY_SKILL: directory + "/SKILL.md",
        },
        // Launch only: Paseo never saves it in the agent config.
        ...(launch.mcp ? { mcpServers: { ...request.mcpServers, flowly: launch.mcp } } : {}),
      };
  } catch (e) {
    logFailure("Kanban session tools unavailable:", e, request.agentId);
  }
  if (!tools.boardServer) return;
  try {
    const mcp = await tools.boardServer(request, paseo);
    if (mcp) return { ...request, mcpServers: { ...request.mcpServers, "flowly-board": mcp } };
  } catch (e) {
    logFailure("Flowly card tools not added to a session:", e, request.agentId);
  }
}
