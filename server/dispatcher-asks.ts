import type { PaseoApi } from "@getpaseo/client";
import { asksFrom, type Ask, type AskState } from "../shared/attention";
import {
  askAnswerInputSchema,
  askDismissInputSchema,
  userSendOptions,
  type AskAnswerInput,
  type ChatItem,
  type StoredChatItem,
} from "../shared/dispatcher";
import type { Board } from "../shared/model";
import {
  allAnswered,
  answerReply,
  buildAnswers,
  dismissReply,
  emptyDraft,
  parseQuestions,
  pendingRequests,
  showsTextInput,
  type FormQuestion,
  type PermissionReply,
  type QuestionDraft,
} from "../shared/permission-question";
import { openReport } from "../shared/progress";
import type { SessionReadReceipt } from "../shared/session-attention";
import { listAttentionAgents } from "./attention-count";
import { logFailure } from "./error-report";

/** Asks in the dispatcher chat (DISPATCHER-SPEC §9.4): one source with the bell, answered on the daemon. */

type AskItem = Extract<StoredChatItem, { kind: "ask" }>;
type Outcome = { delivered: boolean; state: AskState };
type Known = { taskId: string; projectId: string; title: string };

export type AsksDeps = {
  store: {
    read(): Promise<Board>;
    dismissAttentionSignal(input: { taskId: string; signal: string; current: readonly string[] }): Promise<unknown>;
  };
  reads: { read(): Promise<{ receipts: readonly SessionReadReceipt[] }> };
  items: { list(): Promise<StoredChatItem[]>; put(items: readonly StoredChatItem[]): Promise<void> };
  now?: () => Date;
};

/** The chat row of an ask; its id is the same whether it is live or stored, so a stored state replaces it. */
export function askItem(ask: Ask, state: AskState = ask.state, extra: Partial<AskItem> = {}): AskItem {
  return {
    id: `ask-${ask.signal}`,
    at: ask.at || extra.resolvedAt || new Date(0).toISOString(),
    kind: "ask",
    signal: ask.signal,
    taskId: ask.taskId,
    projectId: ask.projectId,
    title: ask.title,
    state,
    askKind: ask.kind,
    agentId: ask.agentId,
    detail: ask.detail,
    options: ask.options,
    ...(ask.questions ? { questions: ask.questions } : {}),
    ...extra,
  };
}

/** Kept to bound the in-memory card lookup for asks that left the live list. */
const knownLimit = 5000;

export class DispatcherAsks {
  /** One answer at a time, so a double press or a replay sees the first one's stored result. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Signals answered from the chat in this daemon run, in case recording the answer failed. */
  private readonly done = new Set<string>();
  /** The card of each ask seen live, so an ask the session resolved meanwhile can still be recorded. */
  private readonly known = new Map<string, Known>();
  constructor(private readonly deps: AsksDeps) {}

  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The live asks, from a fresh board, agent list and read state. */
  async live(paseo: PaseoApi): Promise<{ board: Board; asks: Ask[] }> {
    const [board, agents, receipts] = await Promise.all([
      this.deps.store.read(),
      listAttentionAgents(paseo),
      this.deps.reads.read().catch(() => null),
    ]);
    const asks = asksFrom(board, agents, receipts?.receipts ?? [], board.attentionDismissals, !receipts);
    if (this.known.size > knownLimit) this.known.clear();
    for (const ask of asks) this.known.set(ask.signal, { taskId: ask.taskId, projectId: ask.projectId, title: ask.title });
    return { board, asks };
  }

  /**
   * The chat's items: the stored ones, without the asks and answers of cards that no longer exist, and the
   * live asks a stored one with the same signal does not already stand for (§9.4).
   */
  async chatItems(stored: readonly StoredChatItem[], paseo: PaseoApi): Promise<ChatItem[]> {
    const { board, asks } = await this.live(paseo);
    const cards = new Set(board.tasks.map((t) => t.id));
    const kept = stored.filter((item) => (item.kind !== "ask" && item.kind !== "answer") || cards.has(item.taskId));
    const storedAsks = new Set(kept.flatMap((item) => (item.kind === "ask" ? [item.signal] : [])));
    return [...kept, ...asks.filter((ask) => !storedAsks.has(ask.signal)).map((ask) => askItem(ask))];
  }

  /** `asks.answer`: re-checked against the session now; delivered only when the Paseo call resolved. */
  answer(raw: unknown, paseo: PaseoApi): Promise<Outcome> {
    const input = askAnswerInputSchema.parse(raw);
    const job = this.chain.then(() => this.run(input, paseo));
    this.chain = job.catch(() => undefined);
    return job;
  }

  /** `asks.dismiss`: that one signal joins its card's dismissal set (ATTENTION-DISMISS-SPEC §7a). */
  async dismiss(raw: unknown, paseo: PaseoApi): Promise<{ taskId: string }> {
    const { signal } = askDismissInputSchema.parse(raw);
    const { asks } = await this.live(paseo);
    const ask = asks.find((a) => a.signal === signal);
    if (!ask) throw new Error("This ask is no longer open.");
    const current = asks.filter((a) => a.taskId === ask.taskId).map((a) => a.signal);
    await this.deps.store.dismissAttentionSignal({ taskId: ask.taskId, signal, current });
    return { taskId: ask.taskId };
  }

  private async record(items: StoredChatItem[]) {
    try {
      await this.deps.items.put(items);
    } catch (e) {
      logFailure("Flowly dispatcher ask not recorded:", e, items[0]?.kind === "ask" ? items[0].signal : "");
    }
  }

  private async run(input: AskAnswerInput, paseo: PaseoApi): Promise<Outcome> {
    // 1. Answered or ended before: never again (a stale or replayed answer).
    if (this.done.has(input.signal)) return { delivered: false, state: "answered" };
    const prior = (await this.deps.items.list()).find((item): item is AskItem => item.kind === "ask" && item.signal === input.signal);
    if (prior && (prior.state === "answered" || prior.state === "session_ended")) return { delivered: false, state: prior.state };

    // 2. No longer a live ask: the session resolved it, or the card went away.
    const { board, asks } = await this.live(paseo);
    const ask = asks.find((a) => a.signal === input.signal);
    if (!ask) {
      const known = this.known.get(input.signal);
      if (!known) return { delivered: false, state: "answered" };
      const task = board.tasks.find((t) => t.id === known.taskId);
      if (!task) throw new Error("The card was deleted.");
      const project = board.projects.find((p) => p.id === task.projectId);
      if (task.archivedAt || !project || project.archivedAt) throw new Error("The card or its project is archived.");
      const at = this.now();
      await this.record([{ id: `ask-${input.signal}`, at, kind: "ask", signal: input.signal, ...known, state: "answered", resolvedAt: at, elsewhere: true }]);
      return { delivered: false, state: "answered" };
    }
    if (ask.kind === "error" || ask.kind === "unread") throw new Error("This ask has no answer; open the card.");
    const task = board.tasks.find((t) => t.id === ask.taskId)!;

    // 3. The session, read again: ended sessions are never restored; another workspace is never answered.
    const agentId = ask.agentId!;
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    if (!agent || agent.archivedAt || agent.status === "closed") {
      await this.record([askItem(ask, "session_ended")]);
      return { delivered: false, state: "session_ended" };
    }
    if (agent.id !== agentId || agent.workspaceId !== task.workspaceId)
      throw new Error("The session no longer belongs to this card's workspace; nothing was sent.");
    if (agent.providerUnavailable) throw new Error("The session's provider is unavailable.");
    const elsewhere = async (): Promise<Outcome> => {
      const at = this.now();
      await this.record([askItem(ask, "answered", { resolvedAt: at, elsewhere: true })]);
      return { delivered: false, state: "answered" };
    };

    // 4. Deliver, by kind.
    let text = "";
    let choice: "allow" | "deny" | undefined;
    if (ask.kind === "ask_user" || ask.kind === "permission") {
      if (!ask.requestId) throw new Error("Open the card to answer this request.");
      const request = pendingRequests(agent).find((r) => r.id === ask.requestId);
      if (!request) return elsewhere();
      let reply: PermissionReply;
      if (ask.kind === "ask_user") {
        const questions = request.kind === "question" ? parseQuestions(request) : null;
        if (!questions) throw new Error("Open the card to answer this question.");
        if (input.answer.allow === false) {
          reply = dismissReply(request, questions, emptyDraft(questions));
          choice = "deny";
        } else {
          const draft = draftFrom(questions, input.answer.optionIds ?? [], input.answer.text ?? "");
          reply = answerReply(request, questions, draft);
          const answers = buildAnswers(questions, draft);
          text = questions.length > 1 ? Object.entries(answers).map(([header, value]) => `${header}: ${value}`).join("\n") : Object.values(answers)[0] ?? "";
        }
      } else {
        const picked = permissionChoice(request.actions ?? [], input.answer);
        reply = picked.reply;
        text = picked.label;
        choice = picked.reply.behavior;
      }
      await paseo.agents.ref(agentId).respondToPermission({ requestId: request.id, response: reply });
    } else {
      const kind = ask.kind === "question_report" ? "question" : "blocker";
      const open = openReport(board.events.filter((e) => e.taskId === task.id), agentId, kind);
      if (!open || open.id !== ask.eventId) return elsewhere();
      text = input.answer.text ?? "";
      if (!text.trim()) throw new Error("Type an answer.");
      // Exactly the user's text, no task header (product invariant); steer, so a turn is never interrupted.
      await paseo.agents.ref(agentId).send(text, userSendOptions);
    }

    // 5. Delivered: only now is the answer recorded with its tick.
    this.done.add(ask.signal);
    const at = this.now();
    await this.record([
      askItem(ask, "answered", { resolvedAt: at }),
      { id: `answer-${ask.signal}`, at, kind: "answer", signal: ask.signal, taskId: ask.taskId, projectId: ask.projectId, text, ...(choice ? { choice } : {}), delivered: true },
    ]);
    return { delivered: true, state: "answered" };
  }
}

/**
 * The form's draft from the chat's answer: option ids `q<i>o<j>` pick options, the typed text fills each
 * question that takes text and has no option picked. Every question must end up answered.
 */
function draftFrom(questions: readonly FormQuestion[], optionIds: readonly string[], text: string): QuestionDraft {
  const draft = emptyDraft(questions);
  for (const id of new Set(optionIds)) {
    const match = /^q(\d+)o(\d+)$/.exec(id);
    const q = match ? Number(match[1]) : -1;
    const o = match ? Number(match[2]) : -1;
    if (!questions[q]?.options[o]) throw new Error("Unknown option.");
    draft.selected[q] = [...draft.selected[q], o].sort((a, b) => a - b);
    if (!questions[q].multiSelect && draft.selected[q].length > 1) throw new Error("Choose one option per question.");
  }
  if (text.trim()) questions.forEach((q, i) => {
    if (showsTextInput(q) && !draft.selected[i].length) draft.other[i] = text;
  });
  if (!allAnswered(questions, draft)) throw new Error("Answer every question.");
  return draft;
}

/**
 * A permission's reply from exactly one choice: a provider action by id (its behavior comes from the
 * request), or Allow / Deny when the request has no actions. Nothing is allowed without that choice.
 */
function permissionChoice(
  actions: NonNullable<ReturnType<typeof pendingRequests>[number]["actions"]>,
  answer: AskAnswerInput["answer"],
): { reply: PermissionReply; label: string } {
  const ids = answer.optionIds ?? [];
  if (ids.length > 1) throw new Error("Choose one action.");
  if (actions.length) {
    const match = /^a(\d+)$/.exec(ids[0] ?? "");
    const action = match ? actions[Number(match[1])] : undefined;
    if (!action) throw new Error("Choose one of the request's actions.");
    if (answer.allow !== undefined && answer.allow !== (action.behavior === "allow")) throw new Error("The chosen action does not match Allow or Deny.");
    const selected = action.id ? { selectedActionId: action.id } : {};
    return {
      reply: action.behavior === "allow" ? { behavior: "allow", ...selected } : { behavior: "deny", ...selected, message: "Denied by user" },
      label: action.label,
    };
  }
  const allow = ids[0] === "allow" ? true : ids[0] === "deny" ? false : ids.length ? undefined : answer.allow;
  if (ids.length && allow === undefined) throw new Error("Choose Allow or Deny.");
  if (allow === undefined) throw new Error("Choose Allow or Deny.");
  if (answer.allow !== undefined && answer.allow !== allow) throw new Error("The chosen action does not match Allow or Deny.");
  return { reply: allow ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user" }, label: "" };
}
