import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { dispatcherItemsKey } from "./queries";
import { readSessionReceipts, markSessionRead, markSessionUnread } from "../shared/rpc";
import type { MarkSessionReadInput, MarkSessionUnreadInput } from "../shared/session-attention";

const noReceipts: never[] = [];

export function useSessionReads(enabled = true) {
  const read = useRpc(readSessionReceipts),
    mark = useRpc(markSessionRead),
    unmark = useRpc(markSessionUnread),
    queryClient = useQueryClient();
  /** The sidebar badge polls the same rule; refresh it now instead of waiting for its next round. */
  const refreshBadge = () => queryClient.invalidateQueries({ queryKey: ["flowly", "attention-count"] });
  const query = useQuery({
    queryKey: ["flowly", "sessionReads"],
    queryFn: () => read({}),
    refetchInterval: 5000,
    enabled,
  });
  return {
    query,
    receipts: query.data?.receipts || noReceipts,
    async markRead(input: MarkSessionReadInput) {
      const receipt = await mark(input);
      await query.refetch();
      void refreshBadge();
      // The card leaves the change line too: refresh "N updated" now instead of on the next poll.
      void queryClient.invalidateQueries({ queryKey: dispatcherItemsKey });
      return receipt;
    },
    /** Keeps the session unread until it is read again. */
    async markUnread(input: MarkSessionUnreadInput) {
      const mark = await unmark(input);
      await query.refetch();
      void refreshBadge();
      return mark;
    },
  };
}
