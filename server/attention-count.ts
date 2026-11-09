import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import type { SessionReadStore } from "./session-reads";
import { attentionFromSources, openAskCount } from "../shared/attention";
import { isSummarizer } from "../shared/summary";

/** Every live session except Flowly's own summarizer runs, across all SDK pages. */
export async function listAttentionAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
    for (const { agent } of page.entries) if (!isSummarizer(agent)) agents.push(agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

/**
 * Keep all board/history/agent decoding on the daemon for the native sidebar. The count is the open asks
 * (plan Q1), the same number the bell shows and the dispatcher chat lists (DISPATCHER-SPEC §9.4).
 */
export async function readAttentionCount(store: Pick<BoardStore, "read">, reads: Pick<SessionReadStore, "read">, paseo: PaseoApi) {
  const [board, agents, receipts] = await Promise.all([store.read(), listAttentionAgents(paseo), reads.read().catch(() => null)]);
  const items = attentionFromSources({ board, agents, receipts: receipts?.receipts || [], readUnavailable: !receipts });
  return { count: openAskCount(items!) };
}
