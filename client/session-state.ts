import type { PaseoAgent } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { BoardEvent, Task } from "../shared/model";
import { msg, t, tn } from "../shared/i18n";
import { asksQuestion } from "../shared/permission-question";
import { nextMovesAction } from "../shared/next-moves";

/**
 * The dispatcher's session state: as any session's, except that `closed` reads as asleep. Paseo stopped its idle
 * process (or restarted), and the next note or message resumes it; it has not ended (DISPATCHER-SPEC §3).
 */
export function dispatcherSessionState(agent: Parameters<typeof sessionState>[0], events: readonly BoardEvent[] = []) {
  if (agent.status === "closed" && !agent.archivedAt) return { label: msg("Asleep"), icon: "CircleStop", active: false };
  return sessionState(agent, events);
}

export function sessionState(
  agent: Pick<
    PaseoAgent,
    | "id"
    | "status"
    | "archivedAt"
    | "pendingPermissions"
    | "attentionReason"
    | "lastUserMessageAt"
  >,
  events: readonly BoardEvent[] = [],
) {
  if (agent.archivedAt)
    return { label: msg("Archived"), icon: "Archive", active: false };
  if (
    agent.pendingPermissions?.length ||
    agent.attentionReason === "permission"
  )
    return asksQuestion(agent)
      ? { label: msg("Waiting for your answer"), icon: "MessageCircleQuestion", active: false, waiting: true }
      : { label: msg("Waiting for approval"), icon: "CircleHelp", active: false, waiting: true };
  if (agent.status === "error" || agent.attentionReason === "error")
    return { label: msg("Error"), icon: "CircleAlert", active: false };
  if (agent.status === "initializing")
    return { label: msg("Starting"), icon: "Loader", active: true };
  if (agent.status === "running")
    return { label: msg("Running"), icon: "Loader", active: true };
  if (agent.status === "closed")
    return { label: msg("Closed"), icon: "CircleStop", active: false };
  if (agent.attentionReason === "finished")
    return { label: msg("Finished turn"), icon: "CircleCheck", active: false };
  const last = events
    .filter(
      (e) =>
        e.agentId === agent.id &&
        (e.action === "agent.turn_started" || e.action === "agent.turn_ended"),
    )
    .at(-1);
  if (
    last?.action === "agent.turn_ended" &&
    (!agent.lastUserMessageAt ||
      Date.parse(last.at) >= Date.parse(agent.lastUserMessageAt))
  )
    return { label: msg("Turn ended"), icon: "CircleCheck", active: false };
  return {
    label: agent.lastUserMessageAt ? msg("Idle") : msg("Ready"),
    icon: "CirclePause",
    active: false,
  };
}

export function openNativeSession(
  navigation: PluginSurfaceProps["navigation"],
  agentId: string,
  hostId: string,
): boolean {
  if (typeof navigation?.openAgent !== "function") return false;
  navigation.openAgent({ agentId, serverId: hostId });
  return true;
}

/** Opens a card's workspace in Paseo (CARD-DISPLAY-SPEC §7); false when the host cannot. */
export function openNativeWorkspace(
  navigation: PluginSurfaceProps["navigation"],
  workspaceId: string,
  hostId: string,
): boolean {
  if (typeof navigation?.openWorkspace !== "function" || !workspaceId) return false;
  navigation.openWorkspace({ workspaceId, serverId: hostId });
  return true;
}

/** Readable entries of a loaded timeline window (SESSION-PANE-SPEC §1: no display cap). */
export function recentSessionOutput(
  entries: readonly {
    /** Projected entries carry a sequence range; its start identifies the entry as the window slides. */
    seqStart?: number;
    item: {
      type: string;
      text?: unknown;
      name?: unknown;
      status?: unknown;
      messageId?: unknown;
      clientMessageId?: unknown;
      callId?: unknown;
    };
  }[],
) {
  const keys = new Set<string>();
  return entries
    .flatMap((entry, index) => {
      const { item } = entry;
      const tool = item.type === "tool_call" && typeof item.name === "string";
      const text = tool
        ? `${item.name} · ${typeof item.status === "string" ? item.status : "activity"}`
        : item.text;
      const messageId =
        typeof item.messageId === "string"
          ? item.messageId
          : typeof item.clientMessageId === "string"
            ? item.clientMessageId
            : undefined;
      // An image-only message from this client has empty text but a known ID.
      const imageOnly = item.type.includes("user") && !!messageId && typeof text === "string";
      if (typeof text !== "string" || (!text.trim() && !imageOnly)) return [];
      const author = item.type.includes("user")
        ? msg("You")
        : item.type.includes("assistant")
          ? msg("Agent")
          : item.type === "reasoning"
            ? msg("Thinking")
            : tool
              ? msg("Tool")
              : msg("Session");
      // A message this client sent keeps its key from the local echo to the session's own record (SESSION-UX-SPEC).
      const sent = item.type.includes("user") && messageId ? `${messageId}-user` : "";
      const key = sent && !keys.has(sent) ? sent : `${entry.seqStart ?? item.messageId ?? item.callId ?? index}-${item.type}`;
      keys.add(key);
      return [
        {
          key,
          author,
          text,
          kind: tool ? "tool" : item.type,
          messageId,
        },
      ];
    });
}

/** A message this client just sent, shown at once until the session's timeline holds it. */
export type SentEcho = { messageId: string; text: string };

/** The echoes the timeline does not hold yet (matched by the message ID the send carried). */
export function pendingEchoes(
  entries: readonly { item: { type: string; messageId?: unknown; clientMessageId?: unknown } }[],
  echoes: readonly SentEcho[],
) {
  if (!echoes.length) return echoes;
  const seen = new Set<unknown>();
  for (const { item } of entries) if (item.type.includes("user")) seen.add(item.messageId).add(item.clientMessageId);
  return echoes.filter((e) => !seen.has(e.messageId));
}

type OutputEntry = ReturnType<typeof recentSessionOutput>[number];
export type TranscriptBlock =
  | { kind: "entry"; key: string; entry: OutputEntry }
  | { kind: "activity"; key: string; items: OutputEntry[]; thoughts: number; tools: number };

/**
 * Consecutive thinking and tool-call entries become one collapsible activity
 * block. The block key is its first entry's key, so it stays stable (and keeps
 * its expanded state) while a running turn appends steps to it.
 */
/**
 * The newest row of the session's own output: rows a caller adds (`extra`, the dispatcher's notes and change line)
 * are not output, so the live activity stays live and no second running line is added under them (DISPATCHER-SPEC §9.3).
 */
export function lastOutputRow<Row extends { kind: string }>(rows: readonly Row[]): Row | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind !== "extra") return rows[i];
  return undefined;
}

export function groupTranscript(entries: readonly OutputEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const entry of entries) {
    const step = entry.author === "Thinking" || entry.author === "Tool";
    const last = blocks.at(-1);
    if (!step) blocks.push({ kind: "entry", key: entry.key, entry });
    else if (last?.kind === "activity") {
      last.items.push(entry);
      if (entry.author === "Tool") last.tools++;
      else last.thoughts++;
    } else
      blocks.push({
        kind: "activity",
        key: `activity-${entry.key}`,
        items: [entry],
        thoughts: entry.author === "Thinking" ? 1 : 0,
        tools: entry.author === "Tool" ? 1 : 0,
      });
  }
  return blocks;
}

export function activitySummary(block: { thoughts: number; tools: number }) {
  const parts = [];
  if (block.thoughts) parts.push(t("Thought"));
  if (block.tools) parts.push(tn(block.tools, "{n} tool call", "{n} tool calls"));
  return parts.join(" · ");
}

/** The card fields the session view reads; a lane/revision change alone leaves it as is. */
export function samePreviewTask(
  a: Pick<Task, "id" | "workspaceId" | "archivedAt" | "title">,
  b: Pick<Task, "id" | "workspaceId" | "archivedAt" | "title">,
) {
  return a.id === b.id && a.workspaceId === b.workspaceId && a.archivedAt === b.archivedAt && a.title === b.title;
}

/**
 * The only events the session view uses: this session's latest turn start/end
 * (sessionState, sessionAttention) or next-move suggestion (NEXT-MOVES-SPEC §3).
 */
export function turnEventKey(events: readonly BoardEvent[], agentId: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agentId === agentId && (e.action === "agent.turn_started" || e.action === "agent.turn_ended" || e.action === nextMovesAction))
      return `${e.id}|${e.taskId}`;
  }
  return "";
}
