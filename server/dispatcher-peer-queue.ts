import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import {
  peerMessagePrefix,
  queuedPeerMessageLimits,
  storedPeerQueueSchema,
  userSendOptions,
  type QueuedPeerMessage,
} from "../shared/dispatcher";
import { pendingRequests } from "../shared/permission-question";
import type { Board } from "../shared/model";
import { isDeadDispatcher, type DispatcherRecord } from "./dispatcher";
import { JsonQueueFile } from "./dispatcher-queue";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

/**
 * Messages for another board group's dispatcher held while it waits on its user (DISPATCHER-SPEC §5.5; ruling, Noah
 * 2026-11-16). Addressed to the group, not a session: delivery goes to whichever live session the group's record holds
 * then. One sender group's messages go out merged, under its prefix. Dropped (logged, counts only) when the group is
 * deleted or has no live dispatcher. A file of its own, so the card queue (§5.3) is unchanged.
 */

/** What happened to one queued message this run: delivered, or dropped. Still queued: no entry. */
export type PeerOutcome = { kind: "delivered" } | { kind: "dropped" };

const sweepMs = 60_000;
/** The fixed label of every drop's log line (counts only, never the text). */
const droppedLabel = "Flowly dispatcher peer messages dropped:";

/** "2026-11-16 09:05 UTC" for an ISO time. */
const shownTime = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

/** The one message a target gets for one sender group's queued messages: its prefix once, then each in order with its time. */
export function queuedPeerDelivery(group: { id: string; name: string }, messages: readonly Pick<QueuedPeerMessage, "text" | "at">[]): string {
  const head =
    messages.length === 1
      ? "this message was held for you until you were free."
      : `these ${messages.length} messages were held for you until you were free; here they are, in order.`;
  return [
    `${peerMessagePrefix(group)}${head}`,
    ...messages.map((m, i) => `${messages.length === 1 ? "" : `${i + 1}. `}(${shownTime(m.at)}) ${m.text}`),
  ].join("\n\n");
}

/** `<dataDir>/dispatcher-peer-queue.json` (§5.5). */
export class DispatcherPeerQueueFile extends JsonQueueFile<QueuedPeerMessage> {
  constructor(directory: string) {
    super(directory, "dispatcher-peer-queue.json", storedPeerQueueSchema, {
      notKept: "Flowly dispatcher peer queue is invalid and could not be kept aside:",
      reset: "Flowly dispatcher peer queue is invalid; starting empty:",
      refused: "The dispatcher peer queue file is invalid and could not be kept aside; Flowly leaves it unchanged.",
    });
  }
}

/** What the peer queue reads: the board's groups, the dispatcher record, and which group a session is. */
export type PeerQueueDeps = {
  board(): Promise<Pick<Board, "groups">>;
  record(): Promise<DispatcherRecord>;
  sessionOf(agentId: string): Promise<{ groupId: string } | null>;
  /** One check at a time, shared with the card queue's checks (§5.5). */
  serial<T>(job: () => Promise<T>): Promise<T>;
};

export class DispatcherPeerQueue {
  now = () => new Date();
  /** The Paseo handle for sweeps, which come without one. */
  api: () => PaseoApi | undefined = () => undefined;
  /** Ids sent in this daemon run whose removal from the file failed: never sent again. */
  private readonly sent = new Set<string>();
  private readonly outcomes = new Map<string, PeerOutcome>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(
    private readonly file: DispatcherPeerQueueFile,
    private readonly deps: PeerQueueDeps,
  ) {}

  /** What is waiting, oldest first; delivered ones not yet removed are left out. */
  async list(): Promise<QueuedPeerMessage[]> {
    return (await this.file.list()).filter((m) => !this.sent.has(m.id));
  }

  /** Whether older messages from `fromGroupId` wait for `groupId`; an unreadable queue counts as empty (nothing to deliver). */
  async waiting(groupId: string, fromGroupId: string): Promise<boolean> {
    try {
      return (await this.list()).some((m) => m.groupId === groupId && m.fromGroupId === fromGroupId);
    } catch (e) {
      logFailure("Flowly dispatcher peer queue not read:", e, groupId);
      return false;
    }
  }

  /** Queues one message for group `groupId`; QUEUE_FULL past the caps (`targetName` names it in the refusal). */
  async enqueue(input: Omit<QueuedPeerMessage, "id" | "at">, targetName: string): Promise<QueuedPeerMessage> {
    const message: QueuedPeerMessage = { id: randomUUID(), ...input, at: this.now().toISOString() };
    await this.file.update((messages) => {
      const live = messages.filter((m) => !this.sent.has(m.id));
      if (live.filter((m) => m.groupId === input.groupId).length >= queuedPeerMessageLimits.perGroup)
        throw new ToolError(
          "QUEUE_FULL",
          `${queuedPeerMessageLimits.perGroup} messages already wait for that dispatcher. Don't queue more; tell the user the ${targetName} dispatcher is waiting on them.`,
        );
      if (live.length >= queuedPeerMessageLimits.total)
        throw new ToolError("QUEUE_FULL", `Too many dispatcher messages are queued. Don't queue more; tell the user the ${targetName} dispatcher is waiting on them.`);
      return { messages: [...live, message], value: undefined };
    });
    this.schedule();
    return message;
  }

  /** A session's turn ended or its permission was resolved: when it is a group's dispatcher with messages waiting, that group is checked. */
  async agentChanged(agentId: string, paseo: PaseoApi, hint: { resolvedRequestId?: string } = {}): Promise<void> {
    if (!(await this.list()).length) return;
    const own = await this.deps.sessionOf(agentId);
    if (own) await this.check(own.groupId, paseo, hint);
  }

  /** Delivers group `groupId`'s queue when its dispatcher is free, or drops it when the group or its dispatcher is gone. */
  check(groupId: string, paseo: PaseoApi, hint: { resolvedRequestId?: string } = {}): Promise<void> {
    return this.deps.serial(async () => {
      const queued = (await this.list()).filter((m) => m.groupId === groupId);
      if (queued.length) await this.settle(groupId, queued, paseo, hint);
    });
  }

  /** Every target group checked again: ends no hook reported, dead dispatchers, deleted groups. */
  sweep(paseo: PaseoApi): Promise<void> {
    return this.deps.serial(async () => {
      const all = await this.list();
      for (const groupId of new Set(all.map((m) => m.groupId)))
        await this.settle(
          groupId,
          all.filter((m) => m.groupId === groupId),
          paseo,
          {},
        ).catch((e) => logFailure("Flowly dispatcher peer queue not checked:", e, groupId));
    });
  }

  /** A group was deleted: its queue is dropped at once. */
  groupDeleted(groupId: string): Promise<void> {
    return this.deps.serial(async () => {
      const queued = (await this.list()).filter((m) => m.groupId === groupId);
      if (queued.length) await this.drop(queued, "the group was deleted");
    });
  }

  /** What became of a message this run (taken once), or undefined while it is still queued. */
  outcome(id: string): PeerOutcome | undefined {
    const found = this.outcomes.get(id);
    this.outcomes.delete(id);
    return found;
  }

  /** Resolves once every check started so far (of this queue and the card queue) has finished. */
  idle(): Promise<void> {
    return this.deps.serial(async () => undefined);
  }

  /** Runs sweeps while anything is queued, and once 60 seconds after start (unref'd); stopped by `stop`. */
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
        if (paseo) await this.sweep(paseo).catch((e) => logFailure("Flowly dispatcher peer queue sweep failed:", e));
        if ((await this.list().catch(() => [])).length) this.schedule();
      })();
    }, sweepMs);
    this.timer.unref?.();
  }

  /** One target group's queue: dropped, kept while its dispatcher waits on the user, or delivered per sender group (inside the chain). */
  private async settle(groupId: string, queued: QueuedPeerMessage[], paseo: PaseoApi, hint: { resolvedRequestId?: string }) {
    if (!(await this.deps.board()).groups.some((g) => g.id === groupId)) return this.drop(queued, "the group was deleted");
    const agentId = (await this.deps.record()).groups[groupId]?.agentId;
    const agent = agentId ? ((await paseo.agents.ref(agentId).refresh())?.agent ?? null) : null;
    if (!agentId || isDeadDispatcher(agent)) return this.drop(queued, "the group has no live dispatcher");
    if (pendingRequests(agent).some((r) => r.id !== hint.resolvedRequestId)) return;
    // Sender groups one after another, oldest first; each one's messages merged in queue order.
    for (const fromGroupId of new Set(queued.map((m) => m.fromGroupId))) {
      const own = queued.filter((m) => m.fromGroupId === fromGroupId);
      try {
        await this.deliver(agentId, own, paseo);
      } catch (e) {
        // Kept queued: the next hook or sweep tries again.
        logFailure("Flowly queued dispatcher peer message not delivered:", e, groupId);
        return;
      }
    }
  }

  private async deliver(agentId: string, queued: QueuedPeerMessage[], paseo: PaseoApi) {
    const sender = { id: queued[0].fromGroupId, name: queued[0].fromGroupName };
    await paseo.agents.ref(agentId).send(queuedPeerDelivery(sender, queued), userSendOptions);
    for (const m of queued) this.sent.add(m.id);
    this.record(queued, { kind: "delivered" });
    await this.remove(queued).catch((e) => logFailure("Flowly delivered dispatcher peer message not removed:", e, queued[0].groupId));
  }

  private async remove(queued: readonly QueuedPeerMessage[]) {
    const ids = new Set(queued.map((m) => m.id));
    await this.file.update((messages) => ({ messages: messages.filter((m) => !ids.has(m.id)), value: undefined }));
    for (const id of ids) this.sent.delete(id);
  }

  /** Removes undeliverable messages: nothing is sent and no card event is recorded; one log line with counts only. */
  private async drop(queued: QueuedPeerMessage[], reason: string) {
    await this.remove(queued);
    this.record(queued, { kind: "dropped" });
    const senders = new Set(queued.map((m) => m.fromGroupId)).size;
    logFailure(droppedLabel, new Error(reason), `${queued.length} messages, ${senders} sender groups`);
  }

  private record(queued: readonly QueuedPeerMessage[], outcome: PeerOutcome) {
    for (const m of queued) this.outcomes.set(m.id, outcome);
    for (const id of this.outcomes.keys()) {
      if (this.outcomes.size <= 1000) break;
      this.outcomes.delete(id);
    }
  }
}
