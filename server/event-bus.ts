import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { DispatcherNote } from "../shared/dispatcher";
import type { Board, BoardEvent, Status } from "../shared/model";
import { logFailure } from "./error-report";

/** Event bus and dispatcher note batching (EVENT-BUS-SPEC). */

export type BusFact =
  | {
      kind: "board";
      event: BoardEvent;
      projectId: string;
      /** The card's title when the commit was made (the event itself carries none). */
      title?: string;
    }
  | { kind: "permission"; agentId: string; taskId: string | null; request: AgentPermissionRequest }
  | { kind: "permission_resolved"; agentId: string; requestId: string };

export class EventBus {
  private readonly subscribers = new Set<(facts: BusFact[]) => void>();
  /** Calls every subscriber in order; one that throws is logged and never fails the publisher. */
  publish(facts: BusFact[]) {
    if (!facts.length) return;
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(facts);
      } catch (e) {
        logFailure("Flowly event bus subscriber failed:", e);
      }
    }
  }
  subscribe(fn: (facts: BusFact[]) => void) {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }
  /** Whether anyone listens; publishers skip building facts otherwise. */
  hasSubscribers() {
    return this.subscribers.size > 0;
  }
}

/** One fact per event a commit created; an event whose card is gone by the end of the commit is skipped. */
export function factsFromCommit(events: readonly BoardEvent[], board: Board): BusFact[] {
  if (!events.length) return [];
  const tasks = new Map(board.tasks.map((t) => [t.id, t]));
  const facts: BusFact[] = [];
  for (const event of events) {
    const task = tasks.get(event.taskId);
    if (task) facts.push({ kind: "board", event, projectId: task.projectId, title: task.title });
  }
  return facts;
}

/**
 * The store's `onCommit`: refreshes the project folder copies (as before), then publishes the commit's events.
 * The restore and export paths pass no events and no board. No facts are built while nothing subscribes.
 */
export function commitHandler(bus: EventBus, schedule: () => void) {
  return (events: BoardEvent[], board: Board | null) => {
    schedule();
    if (board && events.length && bus.hasSubscribers()) bus.publish(factsFromCommit(events, board));
  };
}

const stopStatuses: readonly Status[] = ["blocked", "in_review", "committed", "integrated", "done", "cancelled"];
const stopReports: readonly (BoardEvent["reportKind"] & string)[] = ["question", "blocker", "result"];

/** Whether a fact is a moment the dispatcher should hear about (EVENT-BUS-SPEC §2). */
export function isStop(fact: BusFact): boolean {
  if (fact.kind === "permission") return true;
  if (fact.kind !== "board") return false;
  const { action, to, reportKind, outcome } = fact.event;
  if (action === "status_changed" && to && (stopStatuses as readonly string[]).includes(to)) return true;
  if ((action === "status_changed" || action === "progress_reported") && reportKind && stopReports.includes(reportKind)) return true;
  return action === "agent.turn_ended" && outcome === "failed";
}

function noteOf(fact: Extract<BusFact, { kind: "board" }>, count: number): DispatcherNote {
  const { event } = fact;
  const kind =
    event.action === "agent.turn_ended" && event.outcome === "failed"
      ? "turn_failed"
      : event.reportKind && event.reportKind !== "progress"
        ? event.reportKind
        : event.action;
  const move = event.action === "status_changed" && event.to ? `${event.from ?? ""} → ${event.to}`.trim() : "";
  const detail = [move, event.note].filter(Boolean).join(": ");
  return {
    taskId: event.taskId,
    projectId: fact.projectId,
    title: fact.title ?? event.taskId,
    kind,
    detail: count > 1 ? `${detail} (+${count - 1} earlier)`.trim() : detail,
    at: event.at,
  };
}

/** Collects board facts for a window, then hands them over as one note per card (EVENT-BUS-SPEC §3). */
export class NoteBatcher {
  private readonly pending = new Map<string, { fact: Extract<BusFact, { kind: "board" }>; count: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the pending batch's first fact arrived; null while nothing is pending. */
  private firstAt: number | null = null;
  constructor(
    private readonly opts: {
      windowMs: number;
      maxWaitMs: number;
      /** The dispatcher's own session: what it causes is not news to it. */
      exclude: () => string | null;
    },
    private readonly flush: (notes: DispatcherNote[]) => void,
  ) {}

  push(facts: BusFact[]) {
    const own = this.opts.exclude();
    let added = false;
    for (const fact of facts) {
      if (fact.kind !== "board") continue;
      if (own && fact.event.agentId === own) continue;
      const key = fact.event.taskId;
      this.pending.set(key, { fact, count: (this.pending.get(key)?.count ?? 0) + 1 });
      added = true;
    }
    if (!added) return;
    const now = Date.now();
    if (this.firstAt === null) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.opts.windowMs, this.firstAt + this.opts.maxWaitMs - now));
    this.timer = setTimeout(() => this.release(), wait);
  }

  /** Stops the timer and forgets pending notes (plugin unload). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.firstAt = null;
  }

  private release() {
    const notes = [...this.pending.values()].map(({ fact, count }) => noteOf(fact, count));
    this.pending.clear();
    this.timer = null;
    this.firstAt = null;
    if (!notes.length) return;
    try {
      this.flush(notes);
    } catch (e) {
      logFailure("Flowly dispatcher notes not delivered:", e);
    }
  }
}
