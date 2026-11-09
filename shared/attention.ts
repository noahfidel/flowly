import type { Project, Task, BoardEvent } from "./model";
import { openReport, silentTurn } from "./progress";
import { parseQuestions, pendingRequests, showsTextInput, type PendingRequest } from "./permission-question";
import { sessionSpeed, type ProviderFeature } from "./agent-speed";
import { isDismissed, sessionSignalParts, type AskKind, type AskState, type AttentionDismissal, type SignalPart } from "./attention-dismiss";

export { askStates, type AskKind, type AskState } from "./attention-dismiss";
import {
  sessionAttentionFromTurn,
  type AttentionAgent,
  type SessionReadReceipt,
} from "./session-attention";

type Agent = AttentionAgent & { updatedAt?: string; createdAt?: string };

export type AttentionItem = {
  task: Task;
  project: Project;
  permissions: number;
  errors: number;
  unread: number;
  /** Open agent questions awaiting your reply (AUTO-STATUS M1). */
  questions: number;
  /** Sessions waiting on an agent question (AskUserQuestion), answerable in the session. */
  asks: number;
  /** Unread sessions whose last turn ended without any Kanban report (M2). */
  silent: number;
  /** Set when exactly one session needs attention, so it can be opened directly. */
  sessionId: string | null;
  updatedAt: string;
  /** Sessions whose latest Flowly report is an open blocker (plan Q5). */
  blockers: number;
  /** What the card is waiting on now, one key per concrete thing (ATTENTION-DISMISS-SPEC §2.2). */
  signals: string[];
  /** The same signals with their session and kind; each is one ask (DISPATCHER-SPEC §9.4). */
  parts: AttentionPart[];
  /** Dismissed from Attention and nothing new since: not counted, listed under Dismissed. */
  dismissed: boolean;
};

/** One signal of a card: its session, and whether it is in the card's dismissal set. */
export type AttentionPart = SignalPart & { agentId: string; dismissed: boolean };

/** Session facts the attention rule needs; the board read and the overview give the same ones. */
type SessionFactsLike = {
  latestTurn?: { action: string; at: string };
  questionEventId?: string | null;
  blockerEventId?: string | null;
  silent?: boolean;
};

type FullBoard = { projects: Project[]; tasks: Task[]; events: BoardEvent[]; attentionDismissals?: readonly AttentionDismissal[] };

/** The attention facts of one session, from the full event history. */
function eventFacts(board: Pick<FullBoard, "events">) {
  return (task: Task, agentId: string): SessionFactsLike => {
    const own = board.events.filter((e) => e.taskId === task.id);
    const latestTurn = own.filter((e) => e.agentId === agentId && (e.action === "agent.turn_started" || e.action === "agent.turn_ended")).at(-1);
    return {
      latestTurn,
      questionEventId: openReport(own, agentId, "question")?.id ?? null,
      blockerEventId: openReport(own, agentId, "blocker")?.id ?? null,
      silent: silentTurn(task, own, agentId),
    };
  };
}

/** Cards across all active projects whose sessions need a human. Running alone does not count. */
export function attentionItems(board: FullBoard, agents: readonly Agent[], receipts: readonly SessionReadReceipt[], readUnavailable: boolean): AttentionItem[] {
  return attentionItemsWithFacts(board, agents, receipts, readUnavailable, eventFacts(board));
}

/** Share the state-combination engine; overview facts are never fabricated events. */
export function attentionItemsWithFacts(
  board: { projects: Project[]; tasks: Task[]; attentionDismissals?: readonly AttentionDismissal[] },
  agents: readonly Agent[],
  receipts: readonly SessionReadReceipt[],
  readUnavailable: boolean,
  factsOf: (task: Task, agentId: string) => SessionFactsLike | undefined,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of board.tasks) {
    if (task.archivedAt) continue;
    const project = board.projects.find((p) => p.id === task.projectId);
    if (!project || project.archivedAt) continue;
    const record = board.attentionDismissals?.find((d) => d.taskId === task.id);
    const flagged = agents
      .filter((a) => a.workspaceId === task.workspaceId && !a.archivedAt)
      .map((agent) => ({
        agent,
        facts: factsOf(task, agent.id),
      }))
      .map(({ agent, facts }) => {
        const state = sessionAttentionFromTurn(agent, task.id, receipts, facts?.latestTurn);
        const unread = !readUnavailable && state.unread && !state.permission && !state.error;
        const requests = state.permission ? pendingRequests(agent) : [];
        const parts = sessionSignalParts({
          agent,
          questionEventId: facts?.questionEventId || null,
          blockerEventId: facts?.blockerEventId || null,
          requestIds: requests.map((r) => r.id),
          questionRequestIds: requests.filter((r) => r.kind === "question").map((r) => r.id),
          permission: state.permission,
          error: state.error,
          unread,
          token: state.token,
          manualUnread: state.manualUnread,
        });
        return {
          agent,
          parts,
          permission: state.permission && !state.question,
          error: state.error,
          question: state.question || facts?.questionEventId != null,
          blocker: !!facts?.blockerEventId,
          asks: state.question,
          unread,
          silent: unread && !!facts?.silent,
        };
      })
      .filter((s) => s.permission || s.error || s.question || s.blocker || s.unread);
    if (!flagged.length) continue;
    const parts: AttentionPart[] = flagged.flatMap((s) =>
      s.parts.map((p) => ({ ...p, agentId: s.agent.id, dismissed: !!record?.signals.includes(p.key) })),
    );
    const signals = parts.map((p) => p.key);
    items.push({
      task,
      project,
      permissions: flagged.filter((s) => s.permission).length,
      errors: flagged.filter((s) => s.error).length,
      unread: flagged.filter((s) => s.unread && !s.question && !s.blocker).length,
      questions: flagged.filter((s) => s.question).length,
      asks: flagged.filter((s) => s.asks).length,
      blockers: flagged.filter((s) => s.blocker).length,
      silent: flagged.filter((s) => s.silent && !s.question && !s.blocker).length,
      sessionId: flagged.length === 1 ? flagged[0].agent.id : null,
      updatedAt: flagged
        .map((s) => s.agent.updatedAt || "")
        .sort()
        .at(-1) || "",
      signals,
      parts,
      dismissed: isDismissed(signals, record),
    });
  }
  return items.sort(
    (a, b) =>
      Number(!!(b.permissions || b.errors || b.questions || b.blockers)) -
        Number(!!(a.permissions || a.errors || a.questions || a.blockers)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** The bell's count (plan Q1): open asks, each signal not in its card's dismissal set. */
export function openAskCount(items: readonly AttentionItem[], resolved: ReadonlySet<string> = noSignals): number {
  return items.reduce((n, item) => n + item.parts.filter((p) => !p.dismissed && !resolved.has(p.key)).length, 0);
}

const noSignals: ReadonlySet<string> = new Set();

/**
 * The open asks: not dismissed, and not answered, ended or dismissed in the chat (`resolved`, the signals the
 * chat recorded so). The bell, the sidebar badge and the chat's open rows all come from this (§9.4).
 */
export function openAsks(asks: readonly Ask[], resolved: ReadonlySet<string> = noSignals): Ask[] {
  return asks.filter((a) => a.state === "open" && !resolved.has(a.signal));
}

/** One question of an AskUserQuestion form, as the chat shows it; its options are in `Ask.options` by id. */
export type AskQuestion = { header: string; text: string; multiSelect: boolean; allowText: boolean; optionIds: string[] };
/** One signal as an ask in the dispatcher chat (DISPATCHER-SPEC §9.4). */
export type Ask = {
  signal: string;
  taskId: string;
  projectId: string;
  agentId: string | null;
  kind: AskKind;
  /** The card's title. */
  title: string;
  /** The question or blocker text, the request's title, or empty. */
  detail: string;
  at: string;
  options: { id: string; label: string }[];
  questions?: AskQuestion[];
  requestId?: string;
  eventId?: string;
  state: AskState;
  answer?: string;
  delivered?: boolean;
};

/** An AskUserQuestion request's option ids: `q<question>o<option>`. */
export const questionOptionId = (question: number, option: number) => `q${question}o${option}`;
/** A permission request's action ids: `a<index>`, or `allow` / `deny` when it has no actions. */
export const actionOptionId = (index: number) => `a${index}`;

function requestOptions(request: PendingRequest | undefined, kind: AskKind): Pick<Ask, "options" | "questions" | "detail"> {
  if (!request) return { options: [], detail: "" };
  if (kind === "ask_user") {
    const questions = parseQuestions(request);
    if (!questions) return { options: [], detail: request.title || "" };
    const several = questions.length > 1;
    const options: Ask["options"] = [];
    const shaped: AskQuestion[] = questions.map((q, i) => {
      const ids = q.options.map((o, j) => {
        const id = questionOptionId(i, j);
        options.push({ id, label: several ? `${q.header}: ${o.label}` : o.label });
        return id;
      });
      return { header: q.header, text: q.question, multiSelect: q.multiSelect, allowText: showsTextInput(q), optionIds: ids };
    });
    return { options, questions: shaped, detail: questions.map((q) => q.question).join("\n") };
  }
  const options = request.actions?.length
    ? request.actions.map((a, i) => ({ id: actionOptionId(i), label: a.label }))
    : [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ];
  return { options, detail: request.title || request.name || "" };
}

/**
 * The one source of asks for the bell and the dispatcher chat (plan Q1, DISPATCHER-SPEC §9.4): every signal
 * of every card in Attention, `open` or `dismissed` by the card's dismissal set.
 */
export function asksFrom(
  board: FullBoard,
  agents: readonly Agent[],
  receipts: readonly SessionReadReceipt[],
  dismissals: readonly AttentionDismissal[] | undefined = board.attentionDismissals,
  readUnavailable = false,
): Ask[] {
  const items = attentionItems({ ...board, attentionDismissals: dismissals }, agents, receipts, readUnavailable);
  const events = new Map(board.events.map((e) => [e.id, e]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  return items.flatMap((item) =>
    item.parts.map((part): Ask => {
      const agent = byId.get(part.agentId);
      const event = part.eventId ? events.get(part.eventId) : undefined;
      const request = part.requestId ? pendingRequests(agent).find((r) => r.id === part.requestId) : undefined;
      const shaped = part.kind === "ask_user" || part.kind === "permission" ? requestOptions(request, part.kind) : { options: [], detail: event?.note ?? "" };
      return {
        signal: part.key,
        taskId: item.task.id,
        projectId: item.project.id,
        agentId: part.agentId,
        kind: part.kind,
        title: item.task.title,
        at: event?.at || agent?.attentionTimestamp || agent?.updatedAt || agent?.createdAt || "",
        ...shaped,
        ...(part.requestId ? { requestId: part.requestId } : {}),
        ...(part.eventId ? { eventId: part.eventId } : {}),
        state: part.dismissed ? "dismissed" : "open",
      };
    }),
  );
}

type AttentionBoard = Parameters<typeof attentionItems>[0];

type AttentionSources = {
  board: AttentionBoard | null | undefined;
  agents: readonly Agent[] | null | undefined;
  receipts: readonly SessionReadReceipt[];
  readUnavailable: boolean;
};

/** Every card needing a human, dismissed ones included; null while unavailable. */
export function allAttentionFromSources(sources: AttentionSources): AttentionItem[] | null {
  if (!sources.board || !sources.agents) return null;
  return attentionItems(sources.board, sources.agents, sources.receipts, sources.readUnavailable);
}

/**
 * The one counting rule shared by the board Attention button and the sidebar badge:
 * cards needing a human that were not dismissed (ATTENTION-DISMISS-SPEC §3.2).
 * Returns null while the board or agent list is unavailable (loading or failed).
 * Read receipts that are pending or failed only drop finished-but-unread sessions.
 */
export function attentionFromSources(sources: AttentionSources): AttentionItem[] | null {
  return allAttentionFromSources(sources)?.filter((i) => !i.dismissed) ?? null;
}

/** Badge text for a count; null hides the badge. */
export function attentionBadgeText(count: number | null | undefined): string | null {
  if (!count || count < 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** Board screen params that open the Needs attention modal; the token makes each press distinct. */
export function attentionScreenParams(token: string) {
  return { view: "attention", open: token };
}

/** The open token when params ask for the Needs attention modal, else null. */
export function attentionOpenToken(params: Record<string, string> | undefined): string | null {
  return params?.view === "attention" && params.open ? params.open : null;
}

/** Provider/model/mode/reasoning/speed of the most recently created session in any card workspace. */
export function lastSessionSettings(
  agents: readonly {
    workspaceId?: string | null;
    archivedAt?: string | null;
    createdAt: string;
    provider: string;
    model: string | null;
    currentModeId?: string | null;
    thinkingOptionId?: string | null;
    features?: readonly ProviderFeature[] | null;
  }[],
  workspaceIds: ReadonlySet<string>,
) {
  const latest = agents
    .filter((a) => !a.archivedAt && !!a.workspaceId && workspaceIds.has(a.workspaceId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest
    ? {
        provider: latest.provider,
        model: latest.model || "",
        mode: latest.currentModeId || "",
        thinking: latest.thinkingOptionId || "",
        speed: sessionSpeed(latest.features),
      }
    : null;
}
