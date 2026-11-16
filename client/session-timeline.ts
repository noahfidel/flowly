import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { dispatcherTail, providerSubagentTail, sessionTail } from "../shared/rpc";
import { t } from "../shared/i18n";
import {
  HISTORY_PAGE,
  TURN_MAX_ENTRIES,
  canLoadEarlier,
  mergeNewer,
  mergeOlder,
  refreshCursor,
  windowFromPage,
  type TimelineWindow,
} from "../shared/session-tail";

export const transcriptKey = (taskId: string, agentId: string) => ["flowly", "transcript", taskId, agentId] as const;
const subagentKey = (taskId: string, agentId: string, subagentId: string) => [...transcriptKey(taskId, agentId), "subagent", subagentId] as const;

/**
 * A session's loaded timeline (SESSION-PANE-SPEC §1): the current turn on
 * first read, then only what changed at its end (`after`, a few entries of
 * overlap), with older pages added by "Load earlier". Both merge into the
 * latest cached window when their read completes, so a refresh and a Load
 * earlier running at the same time do not undo each other. A rewritten
 * timeline (new epoch, stale cursor, more new entries than one page) is read
 * again as the current turn.
 *
 * A provider subagent of the session (`subagent`, SUBAGENTS-SPEC §9.4) is read with
 * `subagents.provider-tail`: its newest page first, the same merges, and no stream, so it is
 * polled every 3 s only while `poll` is on.
 */
export function useSessionTimeline({
  taskId,
  agentId,
  enabled,
  streamReady,
  dispatcher = false,
  subagent = false,
  poll = false,
}: {
  taskId: string;
  agentId: string;
  enabled: boolean;
  streamReady: boolean;
  /** A group's dispatcher session, by the group's id: read with `dispatcher.tail` (DISPATCHER-SPEC §9.3); `taskId` then only names the cache. */
  dispatcher?: string | false;
  /** A provider subagent of `agentId`, by its id: read it instead of the session. */
  subagent?: string | false;
  /** A subagent's view polls while it runs (it has no stream). */
  poll?: boolean;
}) {
  const readCard = useRpc(sessionTail);
  const readDispatcher = useRpc(dispatcherTail);
  const readSubagent = useRpc(providerSubagentTail);
  const read = useCallback(
    (input: Parameters<typeof readCard>[0]) => {
      if (subagent) {
        const { maxEntries: _, mode = "tail", ...rest } = input;
        // A subagent has no turns: its newest page stands in for the current turn.
        return readSubagent({ ...rest, subagentId: subagent, mode: mode === "turn" ? "tail" : mode });
      }
      if (!dispatcher) return readCard(input);
      const { taskId: _, ...rest } = input;
      return readDispatcher({ ...rest, groupId: dispatcher });
    },
    [dispatcher, subagent, readCard, readDispatcher, readSubagent],
  );
  const client = useQueryClient();
  const key = subagent ? subagentKey(taskId, agentId, subagent) : transcriptKey(taskId, agentId);
  const cached = () => client.getQueryData<TimelineWindow>(key);
  const readTurn = async () => {
    const page = await read({ taskId, agentId, limit: HISTORY_PAGE, mode: "turn", maxEntries: TURN_MAX_ENTRIES });
    const window = windowFromPage(page);
    if (window) return window;
    // Rewritten while paging (compaction, reload): one more try; otherwise keep what is shown and retry on the next poll.
    const again = windowFromPage(await read({ taskId, agentId, limit: HISTORY_PAGE, mode: "turn", maxEntries: TURN_MAX_ENTRIES }));
    if (again) return again;
    throw new Error(t("The session's timeline changed while loading. Retrying shortly."));
  };
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<TimelineWindow> => {
      const before = cached();
      const cursor = before?.epoch ? refreshCursor(before) : null;
      if (before && cursor) {
        const page = await read({ taskId, agentId, limit: HISTORY_PAGE, mode: "after", cursor });
        const merged = mergeNewer(cached() ?? before, page);
        if (merged) return merged;
      }
      return readTurn();
    },
    enabled,
    refetchInterval: subagent ? (poll ? 3000 : false) : streamReady ? 15000 : 3000,
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<unknown>(null);
  /** `beforeCommit` runs right before older output is added (web keeps the reading position with it). */
  const loadEarlier = useCallback(async (beforeCommit?: () => void) => {
    const window = cached();
    if (!window || !canLoadEarlier(window) || loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const requested = window.startCursor!;
      const page = await read({ taskId, agentId, limit: HISTORY_PAGE, mode: "before", cursor: requested });
      const latest = cached() ?? window;
      const merged = mergeOlder(latest, page, requested);
      if (!merged) void client.invalidateQueries({ queryKey: key, exact: true });
      else if (merged !== latest) {
        beforeCommit?.();
        client.setQueryData(key, merged);
      }
    } catch (e) {
      setEarlierError(e);
    } finally {
      setLoadingEarlier(false);
    }
  }, [client, read, taskId, agentId, loadingEarlier]);
  return { query, loadEarlier, loadingEarlier, earlierError, canLoadEarlier: canLoadEarlier(query.data) };
}
