import { dispatcherTarget } from "../shared/groups";
import type { Board } from "../shared/model";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

/**
 * Until per-group dispatchers ship (BOARD-GROUPS-SPEC §6, the dispatcher card), `groups.delete` refuses the group the
 * one v1 dispatcher session would move to (§7 step 4: most open cards, ties to the first group) while a session is
 * stored (ruling, Noah 2026-11-10). That card replaces this guard with the archive-then-delete order.
 */
export function v1DispatcherGuard(dispatcher: { record(): Promise<{ agentId: string | null }> }) {
  return async (board: Board, groupId: string) => {
    // An unparsable record already reads as empty; anything thrown here is the file itself failing to read.
    const { agentId } = await dispatcher.record().catch((e: unknown) => {
      logFailure("Flowly dispatcher record not read for a group delete:", e);
      throw new ToolError("DISPATCHER_UNAVAILABLE", "The dispatcher record could not be read, so the group was not deleted. Try again.");
    });
    if (agentId && dispatcherTarget(board) === groupId)
      throw new ToolError("GROUP_BUSY", "This group will hold the dispatcher session; delete it after per-group dispatchers ship.");
  };
}
