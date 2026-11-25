import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { mergeNotes, type DispatcherNote } from "../shared/dispatcher";
import type { Board, BoardEvent, Status } from "../shared/model";
import { contractNews } from "../shared/dispatcher-relay";
import { membersOf, rolesMentioned } from "../shared/umbrella";
import { logFailure } from "./error-report";

/** Event bus and dispatcher note batching (EVENT-BUS-SPEC). */

export type BusFact =
  | {
      kind: "board";
      event: BoardEvent;
      projectId: string;
      /** The card's title when the commit was made (the event itself carries none). */
      title?: string;
      /**
       * The project's board group when the commit was made: the note goes to that group's batcher (DISPATCHER-SPEC §0,
       * §7). Absent before the board has groups.
       */
      groupId?: string;
      /** umbrella_contract_proposed: the proposal as the commit left it (UMBRELLA-SPEC §5 step 3). */
      proposal?: { umbrellaId: string; conflict: boolean; mentions: string[] };
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
  const groups = new Map(board.projects.map((p) => [p.id, p.groupId]));
  const facts: BusFact[] = [];
  for (const event of events) {
    const task = tasks.get(event.taskId);
    if (!task) continue;
    const groupId = groups.get(task.projectId);
    const proposal = event.action === contractProposed ? proposalOf(board, event.taskId) : undefined;
    facts.push({ kind: "board", event, projectId: task.projectId, title: task.title, ...(groupId ? { groupId } : {}), ...(proposal ? { proposal } : {}) });
  }
  return facts;
}

/** The event a member's flowly_propose_contract_change records on its card (UMBRELLA-SPEC §5). */
const contractProposed = "umbrella_contract_proposed";

/**
 * The card's newest contract change as its commit left it: the one that commit proposed (one proposal per write). Its
 * conflict flag is Flowly's (`markConflicts`); `mentions` are the members whose role the change names.
 */
function proposalOf(board: Board, taskId: string): { umbrellaId: string; conflict: boolean; mentions: string[] } | undefined {
  let newest: Board["umbrellaEntries"][number] | undefined;
  for (const e of board.umbrellaEntries)
    if (e.kind === "contract_change" && e.sourceTaskId === taskId && e.change && (!newest || e.createdAt >= newest.createdAt)) newest = e;
  if (!newest?.change) return undefined;
  const members = membersOf(board, newest.umbrellaId).map((t) => ({ taskId: t.id, role: t.umbrella?.role }));
  return { umbrellaId: newest.umbrellaId, conflict: !!newest.change.conflict, mentions: rolesMentioned(newest.change, members) };
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

/**
 * Whether a fact is a moment the dispatcher should hear about (EVENT-BUS-SPEC §2). The user's own moves are not news
 * to them, and an A1r restore ("No work was reported in that turn; restored") is not news either.
 */
export function isStop(fact: BusFact): boolean {
  if (fact.kind === "permission") return true;
  if (fact.kind !== "board") return false;
  const { event } = fact;
  if (event.actor === "human") return false;
  if (event.action === "status_changed" && event.rule === "A1r") return false;
  // A member's proposed contract change waits on the user's accept or reject (UMBRELLA-SPEC §5 step 3).
  if (event.action === contractProposed) return true;
  return isStopEvent(event) || contractNews(event) !== null;
}

/** Whether a board event is a stop: a delivery or block, a question, blocker or result, or a failed turn. */
export function isStopEvent(event: Pick<BoardEvent, "action" | "to" | "reportKind" | "outcome">): boolean {
  const { action, to, reportKind, outcome } = event;
  if (action === "status_changed" && to && (stopStatuses as readonly string[]).includes(to)) return true;
  if ((action === "status_changed" || action === "progress_reported") && reportKind && stopReports.includes(reportKind)) return true;
  return action === "agent.turn_ended" && outcome === "failed";
}

function noteOf(fact: Extract<BusFact, { kind: "board" }>): DispatcherNote {
  const { event } = fact;
  const proposal = event.action === contractProposed ? fact.proposal : undefined;
  const kind =
    event.action === "agent.turn_ended" && event.outcome === "failed"
      ? "turn_failed"
      : proposal
        ? "contract_proposed"
        : event.reportKind && event.reportKind !== "progress"
          ? event.reportKind
          : event.action;
  const move = event.action === "status_changed" && event.to ? `${event.from ?? ""} → ${event.to}`.trim() : "";
  // The conflict and the mentioned members ride in the line the dispatcher reads, too.
  const flags = proposal
    ? [proposal.conflict ? "conflicts with another pending proposal or an older contract" : "", proposal.mentions.length ? `roles mentioned: ${proposal.mentions.map((id) => `[${id}]`).join(", ")}` : ""]
    : [];
  const detail = [[move, event.note].filter(Boolean).join(": "), ...flags].filter(Boolean).join("; ");
  const news = contractNews(event);
  return {
    taskId: event.taskId,
    projectId: fact.projectId,
    title: fact.title ?? event.taskId,
    kind,
    detail,
    ...(news !== null ? { contract: { eventId: event.id, text: news } } : {}),
    ...(proposal ? { proposal: { eventId: event.id, ...proposal } } : {}),
    at: event.at,
  };
}

/** Collects board facts for a window, then hands them over as one note per card (EVENT-BUS-SPEC §3). */
export class NoteBatcher {
  private readonly pending = new Map<string, DispatcherNote>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the pending batch's first fact arrived; null while nothing is pending. */
  private firstAt: number | null = null;
  constructor(
    private readonly opts: {
      windowMs: number;
      maxWaitMs: number;
      /** The dispatchers' own sessions: what they cause is not news to them. */
      exclude: () => string | readonly string[] | null;
    },
    private readonly flush: (notes: DispatcherNote[]) => void,
  ) {}

  push(facts: BusFact[]) {
    const excluded = this.opts.exclude();
    const own = new Set(typeof excluded === "string" ? [excluded] : (excluded ?? []));
    const notes: DispatcherNote[] = [];
    for (const fact of facts) {
      if (fact.kind !== "board") continue;
      if (fact.event.agentId && own.has(fact.event.agentId)) continue;
      notes.push(noteOf(fact));
    }
    this.pushNotes(notes);
  }

  /** Adds notes made elsewhere (a project's notes moved from another group's batcher, DISPATCHER-SPEC §0), merged per card. */
  pushNotes(notes: readonly DispatcherNote[]) {
    if (!notes.length) return;
    for (const note of notes) {
      const prev = this.pending.get(note.taskId);
      this.pending.set(note.taskId, prev ? mergeNotes(prev, note) : note);
    }
    const now = Date.now();
    if (this.firstAt === null) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.opts.windowMs, this.firstAt + this.opts.maxWaitMs - now));
    this.timer = setTimeout(() => this.release(), wait);
  }

  /** Removes and returns the pending notes of one project's cards (the project changed group, DISPATCHER-SPEC §0). */
  takeProject(projectId: string): DispatcherNote[] {
    const taken: DispatcherNote[] = [];
    for (const [key, note] of this.pending)
      if (note.projectId === projectId) {
        taken.push(note);
        this.pending.delete(key);
      }
    if (taken.length && !this.pending.size) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.firstAt = null;
    }
    return taken;
  }

  /** Stops the timer and forgets pending notes (plugin unload). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.firstAt = null;
  }

  private release() {
    const notes = [...this.pending.values()];
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
