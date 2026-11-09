import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import type { SessionReadReceipt } from "../shared/session-attention";
import { asksFrom, openAsks } from "../shared/attention";
import { isSummarizer } from "../shared/summary";

/** Every live session except Flowly's own summarizer runs, across all SDK pages. */
export async function listAttentionAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor } });
    for (const { agent } of page.entries) if (!isSummarizer(agent)) agents.push(agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

export type AgentLister = { list(paseo: PaseoApi): Promise<PaseoAgent[]> };

/**
 * The agent list, shared for a short time (PERFORMANCE-SPEC): the sidebar badge and the open dispatcher chat
 * poll every few seconds, so one listing serves both. One listing at a time; a failed one is not kept.
 * A listing belongs to the Paseo handle it was read with: the plugin process has one handle for every client,
 * replaced when it reconnects to the daemon, and a new handle lists again.
 */
export class AttentionAgents implements AgentLister {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: { paseo: PaseoApi; at: number; agents: Promise<PaseoAgent[]> } | null = null;
  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }
  list(paseo: PaseoApi): Promise<PaseoAgent[]> {
    const now = this.now();
    if (this.cached?.paseo === paseo && (this.cached.at === -1 || now - this.cached.at < this.ttlMs)) return this.cached.agents;
    const entry = { paseo, at: -1, agents: listAttentionAgents(paseo) };
    this.cached = entry;
    entry.agents.then(
      () => {
        if (this.cached === entry) entry.at = this.now();
      },
      () => {
        if (this.cached === entry) this.cached = null;
      },
    );
    return entry.agents;
  }
  /** After an answer or a dismissal, the next read lists again. */
  invalidate() {
    this.cached = null;
  }
}

/**
 * Keep all board/history/agent decoding on the daemon for the native sidebar. The count is the open asks
 * (plan Q1): the asks `asksFrom` lists, less those the chat recorded as answered, ended or dismissed
 * (`resolved`), the same number the dispatcher chat lists open (DISPATCHER-SPEC §9.4).
 */
export async function readAttentionCount(
  store: Pick<BoardStore, "read">,
  reads: { read(): Promise<{ receipts: readonly SessionReadReceipt[] }> },
  paseo: PaseoApi,
  options: { agents?: AgentLister; resolved?: ReadonlySet<string> } = {},
) {
  const [board, agents, receipts] = await Promise.all([store.read(), options.agents ? options.agents.list(paseo) : listAttentionAgents(paseo), reads.read().catch(() => null)]);
  return { count: openAsks(asksFrom(board, agents, receipts?.receipts || [], board.attentionDismissals, !receipts), options.resolved).length };
}
