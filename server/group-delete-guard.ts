import { dispatcherTarget } from "../shared/groups";
import type { Board } from "../shared/model";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

type GuardRecord = { groups: Record<string, { agentId: string | null }>; unassigned?: { agentId: string | null } };

/**
 * Until the group delete archives its dispatcher first (BOARD-GROUPS-SPEC §6, DISPATCHER-SPEC §0), `groups.delete`
 * refuses a group that holds a dispatcher session, and the group the not yet migrated v1 session would move to (§7
 * step 4: most open cards, ties to the first group; ruling, Noah 2026-11-10). Never reads the board itself: it runs
 * inside the board's write.
 */
export function v1DispatcherGuard(dispatcher: { record(): Promise<GuardRecord> }) {
  return async (board: Board, groupId: string) => {
    // An unparsable record already reads as empty; anything thrown here is the file itself failing to read.
    const record = await dispatcher.record().catch((e: unknown) => {
      logFailure("Flowly dispatcher record not read for a group delete:", e);
      throw new ToolError("DISPATCHER_UNAVAILABLE", "The dispatcher record could not be read, so the group was not deleted. Try again.");
    });
    if (record.groups[groupId]?.agentId || (record.unassigned?.agentId && dispatcherTarget(board) === groupId))
      throw new ToolError("GROUP_BUSY", "This group holds a dispatcher session; it can't be deleted yet.");
  };
}
