import type { PaseoApi } from "@getpaseo/client";
import { isSummarizer } from "../shared/summary";

/**
 * A card's chats (TASK-SUMMARY-SPEC §2.1): which sessions belong to a card does not depend on who started them.
 * Flowly-started (managed) sessions bound to the card, plus the live sessions in the card's workspace that Paseo
 * or anyone else started (e.g. a PR review card's watcher session). The Flowly MCP tools stay limited to managed
 * sessions; this set only decides what Progress summarizes.
 */
export type ChatAgent = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  labels?: Readonly<Record<string, string>> | null;
  /** Paseo's hidden system agents (e.g. commit/PR message runs). */
  internal?: boolean;
};
export type ChatBinding = { agentId: string; taskId: string };
export type ChatTask = { id: string; workspaceId: string; archivedAt: string | null };

/**
 * Helper sessions that are nobody's chat: Flowly's summary, insight, title, memory and workflow runs (summarizer
 * label), its dispatcher, and Paseo's own internal agents.
 */
export function isFlowlyInternal(agent: Pick<ChatAgent, "labels" | "internal">) {
  return !!agent.internal || isSummarizer({ labels: agent.labels ? { ...agent.labels } : null }) || !!agent.labels?.["flowly-dispatcher"];
}

/**
 * The card's chat ids: its managed bindings first, then the workspace's live sessions. The workspace part is
 * skipped when another live card shares the workspace (local-mode cards on one checkout), and never takes a
 * session bound to another card, an archived one or a Flowly helper.
 */
export function cardChatIds(input: {
  task: ChatTask;
  tasks: readonly ChatTask[];
  managed: readonly ChatBinding[];
  agents: readonly ChatAgent[];
}): string[] {
  const { task } = input;
  const ids = input.managed.filter((m) => m.taskId === task.id).map((m) => m.agentId);
  const shared = input.tasks.some((t) => t.id !== task.id && !t.archivedAt && t.workspaceId === task.workspaceId);
  if (shared) return [...new Set(ids)];
  const boundElsewhere = new Set(input.managed.filter((m) => m.taskId !== task.id).map((m) => m.agentId));
  for (const agent of input.agents) {
    if (agent.workspaceId !== task.workspaceId || agent.archivedAt || boundElsewhere.has(agent.id) || isFlowlyInternal(agent)) continue;
    ids.push(agent.id);
  }
  return [...new Set(ids)];
}

/**
 * The card whose chats include this session when Flowly did not start it: the one live card on the session's
 * workspace, unless the session is bound to another card, archived, or a Flowly helper. Null otherwise.
 */
export function cardOfChat(agent: ChatAgent, tasks: readonly ChatTask[], managed: readonly ChatBinding[]): string | null {
  if (!agent.workspaceId) return null;
  const here = tasks.filter((t) => !t.archivedAt && t.workspaceId === agent.workspaceId);
  if (here.length !== 1) return null;
  return cardChatIds({ task: here[0], tasks, managed, agents: [agent] }).includes(agent.id) ? here[0].id : null;
}

/** Every live (non-archived) agent on the host; the SDK has no workspace filter. */
export async function liveAgents(paseo: PaseoApi): Promise<ChatAgent[]> {
  const found: ChatAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
    for (const { agent } of page.entries) found.push(agent);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

/** The card's chats, read live: null when the card does not exist. */
export async function resolveCardChats(
  paseo: PaseoApi,
  taskId: string,
  tasks: readonly ChatTask[],
  managed: readonly ChatBinding[],
): Promise<string[] | null> {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const shared = tasks.some((t) => t.id !== task.id && !t.archivedAt && t.workspaceId === task.workspaceId);
  // A shared workspace never adds sessions, so the host-wide listing is skipped.
  const agents = shared ? [] : await liveAgents(paseo);
  return cardChatIds({ task, tasks, managed, agents });
}
