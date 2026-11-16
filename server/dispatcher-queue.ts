import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import {
  cancelQuestionInputSchema,
  dispatcherMessageDroppedAction,
  dispatcherMessagePrefix,
  queuedMessageLimits,
  storedQueueSchema,
  userSendOptions,
  type QueuedMessage,
  type QueuedMessageView,
} from "../shared/dispatcher";
import type { Board, Task } from "../shared/model";
import { pendingRequests } from "../shared/permission-question";
import { openReport } from "../shared/progress";
import type { BusFact } from "./event-bus";
import { logFailure } from "./error-report";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";

/**
 * Dispatcher messages queued while their card's session waits on the user (DISPATCHER-SPEC §5.3; ruling, Noah
 * 2026-11-16). The dispatcher never answers or dismisses an ask: its message waits until the user resolves the ask
 * (or it ends otherwise), then goes out steered and marked, several merged into one. Only the user's "Cancel question
 * and re-read card" withdraws an ask early.
 */

export { dispatcherMessageDroppedAction };

/** What a cancelled request tells the card's agent (the deny message of `asks.cancel-question`). Agent-facing English. */
export const cancelledAskMessage =
  "The user cancelled this request: the card changed while it waited. Read the dispatcher's message that follows, re-read the card with flowly_get_task, and go on from there; ask again only if it still applies.";

/** How long a sweep waits while anything is queued: it catches ask ends no hook reported, and dropped sessions. */
const sweepMs = 60_000;

/** "2026-11-16 09:05 UTC" for an ISO time. */
const shownTime = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

/** The one message a session gets for its queued messages: one marker, then each in order with its time (§5.3). */
export function queuedDelivery(messages: readonly Pick<QueuedMessage, "text" | "at">[]): string {
  const head =
    messages.length === 1
      ? "this message was queued for you while you waited on the user."
      : `these ${messages.length} messages were queued for you, in order, while you waited on the user.`;
  return [
    `${dispatcherMessagePrefix}${head} The card may have changed since you asked; re-read it with flowly_get_task before you go on.`,
    ...messages.map((m, i) => `${messages.length === 1 ? "" : `${i + 1}. `}(${shownTime(m.at)}) ${m.text}`),
  ].join("\n\n");
}

/** Why the card can no longer take a queued message, or null while it can (§5.3). */
function cardEnded(task: Task | undefined): string | null {
  if (!task) return "the card was deleted";
  if (task.archivedAt) return "the card was archived";
  if (task.status === "done") return "the card moved to Done";
  if (task.status === "cancelled") return "the card moved to Cancelled";
  return null;
}

/** Why a queued message can no longer be delivered, or null while it still can (§5.3). */
function dropReason(task: Task | undefined, agent: PaseoAgent | null): string | null {
  const ended = cardEnded(task);
  if (ended) return ended;
  if (!agent || agent.archivedAt || agent.workspaceId !== task!.workspaceId) return "its session was archived or is gone";
  return null;
}

/** What the session waits on, or null when it waits on nothing (§5.3, §9.4). */
export function waitingOn(
  board: Pick<Board, "events">,
  taskId: string,
  agent: PaseoAgent,
  hint: { resolvedRequestId?: string; turnStarted?: boolean } = {},
): "permission" | "question" | "blocker" | null {
  const requests = pendingRequests(agent).filter((r) => r.id !== hint.resolvedRequestId);
  if (requests.length) return requests.some((r) => r.kind === "question") ? "question" : "permission";
  // A turn that starts closes the session's report, before the board records the start.
  if (hint.turnStarted) return null;
  const events = board.events.filter((e) => e.taskId === taskId);
  if (openReport(events, agent.id, "question")) return "question";
  if (openReport(events, agent.id, "blocker")) return "blocker";
  return null;
}

/** `<dataDir>/dispatcher-queue.json`: atomic, serialized; a corrupt file is kept aside and the queue starts empty. */
export class DispatcherQueueFile {
  private cached: QueuedMessage[] | null = null;
  private loading: Promise<QueuedMessage[]> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "dispatcher-queue.json");
  }

  async list(): Promise<QueuedMessage[]> {
    await this.writes;
    return [...(await this.load())];
  }

  /** Applies `change` to the stored list and writes it; returns what `change` returned. */
  update<T>(change: (messages: QueuedMessage[]) => { messages: QueuedMessage[]; value: T }): Promise<T> {
    const job = this.writes.then(async () => {
      const { messages, value } = change([...(await this.load())]);
      const stored = storedQueueSchema.parse({ version: 1, messages });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.cached = stored.messages;
      return value;
    });
    this.writes = job.catch(() => undefined);
    return job;
  }

  private load(): Promise<QueuedMessage[]> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.readFile().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readFile(): Promise<QueuedMessage[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return (this.cached = []);
      throw e;
    }
    try {
      return (this.cached = storedQueueSchema.parse(JSON.parse(text)).messages);
    } catch (e) {
      const kept = `${this.path}.invalid-${Date.now()}`;
      try {
        await rename(this.path, kept);
      } catch (error) {
        // Not kept aside: refuse reads and writes rather than overwrite it (AGENTS.md, preserve invalid data). Retried on
        // the next read.
        logFailure("Flowly dispatcher queue is invalid and could not be kept aside:", error, this.path);
        throw new Error("The dispatcher queue file is invalid and could not be kept aside; Flowly leaves it unchanged.");
      }
      logFailure("Flowly dispatcher queue is invalid; starting empty:", e, kept);
      return (this.cached = []);
    }
  }
}

export class DispatcherQueue {
  now = () => new Date();
  /** The Paseo handle for sweeps and board-driven drops, which come without one. */
  api: () => PaseoApi | undefined = () => undefined;
  /** One check, delivery or cancel at a time, so a message is never sent twice. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Ids sent in this daemon run whose removal from the file failed: never sent again. */
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(
    private readonly store: BoardStore,
    private readonly file: DispatcherQueueFile,
  ) {}

  /** What is waiting, oldest first; delivered ones not yet removed are left out. */
  async list(): Promise<QueuedMessage[]> {
    return (await this.file.list()).filter((m) => !this.sent.has(m.id));
  }

  /** `asks.queued`: what the asks' banners show. */
  async views(): Promise<QueuedMessageView[]> {
    return (await this.list()).map(({ id, taskId, agentId, text, at }) => ({ id, taskId, agentId, text, at }));
  }

  /**
   * Queues one message for `agentId` (flowly_message_card, §5.3); QUEUE_FULL past the per-session cap. With `paseo`,
   * the session is checked right after (serialized), so an ask that ended between the tool's read and this write
   * delivers at once.
   */
  async enqueue(input: Pick<QueuedMessage, "taskId" | "projectId" | "agentId" | "from" | "text">, paseo?: PaseoApi): Promise<QueuedMessage> {
    const message: QueuedMessage = { id: randomUUID(), ...input, at: this.now().toISOString() };
    await this.file.update((messages) => {
      const live = messages.filter((m) => !this.sent.has(m.id));
      if (live.filter((m) => m.agentId === input.agentId).length >= queuedMessageLimits.perSession)
        throw new ToolError(
          "QUEUE_FULL",
          `${queuedMessageLimits.perSession} messages already wait for this session to be free. Don't queue more; tell the user which card waits on them.`,
        );
      if (live.length >= queuedMessageLimits.total)
        throw new ToolError("QUEUE_FULL", "Too many dispatcher messages are queued. Don't queue more; tell the user which cards wait on them.");
      return { messages: [...live, message], value: undefined };
    });
    this.schedule();
    if (paseo) void this.check(input.agentId, paseo).catch((e) => logFailure("Flowly queued dispatcher message not checked:", e, input.agentId));
    return message;
  }

  /**
   * Delivers `agentId`'s queue when its ask has ended, or drops it when it can't be delivered any more (§5.3). Hooks
   * pass what they know before Paseo's snapshot or the board shows it: the request just resolved, or a turn start.
   */
  check(agentId: string, paseo: PaseoApi, hint: { resolvedRequestId?: string; turnStarted?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      const queued = (await this.list()).filter((m) => m.agentId === agentId);
      if (!queued.length) return;
      await this.settle(queued, paseo, hint);
    });
  }

  /** Every queued session checked again: ask ends no hook reported, archived or gone sessions, ended cards. */
  sweep(paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      const all = await this.list();
      for (const agentId of new Set(all.map((m) => m.agentId)))
        await this.settle(
          all.filter((m) => m.agentId === agentId),
          paseo,
        ).catch((e) => logFailure("Flowly queued dispatcher message not checked:", e, agentId));
    });
  }

  /** A card changed on the board: its queue is dropped at once when the card was archived, deleted, or moved to Done or Cancelled. */
  taskChanged(taskId: string): Promise<void> {
    return this.serial(async () => {
      const queued = (await this.list()).filter((m) => m.taskId === taskId);
      if (!queued.length) return;
      const task = (await this.store.read()).tasks.find((t) => t.id === taskId);
      const reason = cardEnded(task);
      if (reason) await this.drop(queued, reason);
    });
  }

  /** The event bus's subscriber: board facts of cards with queued messages. */
  boardFacts(facts: readonly BusFact[]) {
    const cards = new Set(facts.flatMap((f) => (f.kind === "board" && f.event.action !== dispatcherMessageDroppedAction ? [f.event.taskId] : [])));
    if (!cards.size) return;
    void this.file
      .list()
      .then((messages) => {
        for (const taskId of cards)
          if (messages.some((m) => m.taskId === taskId)) void this.taskChanged(taskId).catch((e) => logFailure("Flowly dispatcher queue not updated:", e, taskId));
      })
      .catch((e) => logFailure("Flowly dispatcher queue not read:", e));
  }

  /**
   * `asks.cancel-question`, the user's "Cancel question and re-read card" (§5.3, §9.4): denies the session's pending
   * requests with `cancelledAskMessage`, then delivers its queue. An open report has no request: the delivery starts
   * the session's next turn, which closes it. Never called by the dispatcher.
   */
  async cancelQuestion(raw: unknown, paseo: PaseoApi): Promise<{ denied: number; delivered: number }> {
    const input = cancelQuestionInputSchema.parse(raw);
    return this.serial(async () => {
      const queued = (await this.list()).filter((m) => m.agentId === input.agentId && m.taskId === input.taskId);
      if (!queued.length) throw new Error("Nothing is queued for this session.");
      const board = await this.store.read();
      const task = board.tasks.find((t) => t.id === input.taskId);
      const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent ?? null;
      const reason = dropReason(task, agent);
      if (reason) {
        await this.drop(queued, reason);
        throw new Error("This session can no longer take the message; it was dropped.");
      }
      let denied = 0;
      for (const request of pendingRequests(agent)) {
        await paseo.agents.ref(input.agentId).respondToPermission({ requestId: request.id, response: { behavior: "deny", message: cancelledAskMessage } });
        denied++;
      }
      await this.deliver(queued, paseo);
      return { denied, delivered: queued.length };
    });
  }

  /** Resolves once every check, delivery or cancel started so far has finished. */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** Runs sweeps while anything is queued (unref'd); stopped by `stop`. */
  start() {
    this.stopped = false;
    this.schedule();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const paseo = this.api();
      void (async () => {
        if (paseo) await this.sweep(paseo).catch((e) => logFailure("Flowly dispatcher queue sweep failed:", e));
        if ((await this.list().catch(() => [])).length) this.schedule();
      })();
    }, sweepMs);
    this.timer.unref?.();
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One session's queue: dropped, kept while it waits, or delivered (inside the chain). */
  private async settle(queued: QueuedMessage[], paseo: PaseoApi, hint: { resolvedRequestId?: string; turnStarted?: boolean } = {}) {
    const agentId = queued[0].agentId;
    const board = await this.store.read();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    // Messages for another card of the same session (a moved session) are checked on their own card.
    for (const taskId of new Set(queued.map((m) => m.taskId))) {
      const own = queued.filter((m) => m.taskId === taskId);
      const reason = dropReason(
        board.tasks.find((t) => t.id === taskId),
        agent,
      );
      if (reason) {
        await this.drop(own, reason);
        continue;
      }
      if (waitingOn(board, taskId, agent!, hint)) continue;
      try {
        await this.deliver(own, paseo);
      } catch (e) {
        // Kept queued: the next hook or sweep tries again.
        logFailure("Flowly queued dispatcher message not delivered:", e, agentId);
      }
    }
  }

  /** Sends the merged message, steered, then removes what it delivered. */
  private async deliver(queued: QueuedMessage[], paseo: PaseoApi) {
    await paseo.agents.ref(queued[0].agentId).send(queuedDelivery(queued), userSendOptions);
    for (const m of queued) this.sent.add(m.id);
    await this.remove(queued).catch((e) => logFailure("Flowly delivered dispatcher message not removed:", e, queued[0].agentId));
  }

  private async remove(queued: readonly QueuedMessage[]) {
    const ids = new Set(queued.map((m) => m.id));
    await this.file.update((messages) => ({ messages: messages.filter((m) => !ids.has(m.id)), value: undefined }));
    for (const id of ids) this.sent.delete(id);
  }

  /** Removes undeliverable messages, recording them in their card's activity first (a deleted card has none). */
  private async drop(queued: QueuedMessage[], reason: string) {
    const taskId = queued[0].taskId;
    const note = `Not delivered, ${reason}:\n\n${queued.map((m) => `(${shownTime(m.at)}) ${m.text}`).join("\n\n")}`;
    if ((await this.store.read()).tasks.some((t) => t.id === taskId))
      await this.store.mutate((board) => {
        if (board.tasks.some((t) => t.id === taskId))
          this.store.event(board, {
            taskId,
            actor: "system",
            action: dispatcherMessageDroppedAction,
            note: note.length > 10000 ? `${note.slice(0, 9999)}…` : note,
          });
      });
    await this.remove(queued);
  }
}
