import { logFailure } from "./error-report";
import type { ProviderSubagent } from "../shared/subagents";

/** What the service needs from `ProviderSubagentService`. */
export interface SubagentLister {
  /** `unsupported`: this Paseo has no provider subagent list (as opposed to a read that failed this time). */
  listFor(agentId: string): Promise<{ subagents: readonly Pick<ProviderSubagent, "status" | "createdAt">[]; unavailable: boolean; unsupported?: boolean }>;
}

export interface SubagentActivityDeps {
  lister: SubagentLister;
  /** Still a live (non-archived) session in a live card's workspace; false drops it. */
  isCardSession(agentId: string): Promise<boolean>;
  /** The idle card sessions to read once when the plugin starts (SUBAGENTS-SPEC §10.3). */
  idleCardSessions(): Promise<readonly string[]>;
}

export type SubagentActivityView = {
  revision: number;
  /** Running provider subagents per card session; sessions with none are left out. */
  running: Record<string, number>;
  /** When the oldest of those running subagents started, per session (when the provider says). */
  since: Record<string, string>;
};

/** A session whose provider subagents run is read again this often. */
export const ACTIVITY_POLL_MS = 5_000;
/** A failed read is tried again after 5 s, then 10, 20, 40, and at most every 60 s. */
export const ACTIVITY_RETRY_MAX_MS = 60_000;

type Entry = {
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  /** A read of it is running now. */
  reading: boolean;
  /** Asked to read again while a read was running: that read may predate a subagent, so read once more after it. */
  dirty: boolean;
  /** Failed reads in a row, for the backoff. */
  failures: number;
};

/**
 * Which idle card sessions have provider subagents running (SUBAGENTS-SPEC §10). A card session's list is read
 * once when its turn ends (and once at plugin start for idle card sessions); while any of its subagents runs it is
 * read again every 5 s, and it stops being read when none runs, when the session starts a turn (its own turn makes
 * the card run) or when it is archived, gone or no longer a card's. Reads go one at a time over the provider
 * subagent service's short-lived connection. An older Paseo gives empty data, quietly; a failed read keeps the
 * session's last count and is tried again with a backoff (5 s doubling to 60 s).
 */
export class SubagentActivity {
  private readonly entries = new Map<string, Entry>();
  private readonly counts = new Map<string, { count: number; since: string }>();
  private readonly queue: string[] = [];
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  private revision = 0;
  private view: SubagentActivityView = { revision: 0, running: {}, since: {} };
  private swept = false;
  private stopped = false;

  constructor(
    private readonly deps: SubagentActivityDeps,
    private readonly pollMs = ACTIVITY_POLL_MS,
  ) {}

  /** A card session's turn ended: read its subagents now (or keep following it). */
  turnEnded(agentId: string) {
    if (this.stopped) return;
    const entry = this.entries.get(agentId);
    if (!entry) {
      const created: Entry = { timer: null, queued: false, reading: false, dirty: false, failures: 0 };
      this.entries.set(agentId, created);
      this.enqueue(agentId, created);
      return;
    }
    // A read running now may have started before this turn's subagents: read once more after it.
    if (entry.reading) {
      entry.dirty = true;
      return;
    }
    // Waiting for its next read (poll or retry): read now. A queued read already covers this turn's end.
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      this.enqueue(agentId, entry);
    }
  }

  /** The session runs a turn again (or is gone): its own state shows; stop reading it. */
  turnStarted(agentId: string) {
    this.forget(agentId);
  }

  /** Once per plugin start (the first board read brings a Paseo handle): read every idle card session once. */
  async sweep() {
    if (this.swept || this.stopped) return;
    this.swept = true;
    let ids: readonly string[];
    try {
      ids = await this.deps.idleCardSessions();
    } catch (e) {
      // The next start tries again; nothing to show meanwhile.
      this.swept = false;
      logFailure("Flowly could not list card sessions for subagent activity:", e);
      return;
    }
    for (const id of ids) if (!this.entries.has(id)) this.turnEnded(id);
  }

  read(): SubagentActivityView {
    return this.view;
  }

  /** Settles once the queued reads are done (tests). */
  async idle() {
    while (this.draining) await this.drained;
  }

  stop() {
    this.stopped = true;
    this.entries.forEach((entry) => {
      if (entry.timer) clearTimeout(entry.timer);
    });
    this.entries.clear();
    this.queue.length = 0;
  }

  private forget(agentId: string) {
    const entry = this.entries.get(agentId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(agentId);
    this.setCount(agentId, null);
  }

  private enqueue(agentId: string, entry: Entry) {
    if (entry.queued || this.stopped) return;
    entry.queued = true;
    this.queue.push(agentId);
    // `draining` is cleared by the loop itself, in the same step that sees the queue empty, so an enqueue right
    // after the last read always finds either a running loop or none.
    if (!this.draining) {
      this.draining = true;
      this.drained = this.drain();
    }
  }

  private async drain() {
    try {
      while (this.queue.length && !this.stopped) await this.readOne(this.queue.shift()!);
    } finally {
      this.draining = false;
    }
  }

  private async readOne(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.queued = false;
    entry.reading = true;
    entry.dirty = false;
    let answer: { running: Pick<ProviderSubagent, "status" | "createdAt">[] } | "gone" | "unsupported" | "failed";
    try {
      if (!(await this.deps.isCardSession(id))) answer = "gone";
      else {
        // Failures are the lister's to report.
        const result = await this.deps.lister.listFor(id);
        answer = result.unsupported ? "unsupported" : result.unavailable ? "failed" : { running: result.subagents.filter((s) => s.status === "running") };
      }
    } catch (e) {
      logFailure("Flowly could not read subagent activity:", e, id);
      answer = "failed";
    } finally {
      entry.reading = false;
    }
    // Dropped (turn started, archived) or stopped while the read ran: the answer is stale.
    if (this.stopped || this.entries.get(id) !== entry) return;
    // Not a card session any more, or this Paseo cannot say: stop, quietly.
    if (answer === "gone" || answer === "unsupported") return this.forget(id);
    if (answer === "failed") {
      // Timeout, lost connection, daemon error: keep the last count and try again, backing off.
      entry.failures++;
      if (entry.dirty) entry.dirty = false;
      return this.schedule(id, entry, Math.min(this.pollMs * 2 ** (entry.failures - 1), ACTIVITY_RETRY_MAX_MS));
    }
    entry.failures = 0;
    const running = answer.running;
    if (entry.dirty) {
      // Asked again while this read ran: its answer may predate a new subagent; read once more now.
      entry.dirty = false;
      if (running.length) this.setCount(id, this.countOf(running));
      return this.enqueue(id, entry);
    }
    if (!running.length) return this.forget(id);
    this.setCount(id, this.countOf(running));
    this.schedule(id, entry, this.pollMs);
  }

  private countOf(running: readonly Pick<ProviderSubagent, "createdAt">[]) {
    const since = running.reduce((min, s) => (s.createdAt && (!min || s.createdAt < min) ? s.createdAt : min), "");
    return { count: running.length, since };
  }

  private schedule(id: string, entry: Entry, ms: number) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(id) === entry) this.enqueue(id, entry);
    }, ms);
    entry.timer.unref?.();
  }

  /** Changes the view, and its revision, only when the content changes. */
  private setCount(agentId: string, value: { count: number; since: string } | null) {
    const known = this.counts.get(agentId);
    if (!value) {
      if (!known) return;
      this.counts.delete(agentId);
    } else {
      if (known && known.count === value.count && known.since === value.since) return;
      this.counts.set(agentId, value);
    }
    this.revision++;
    const running: Record<string, number> = {};
    const since: Record<string, string> = {};
    this.counts.forEach((v, id) => {
      running[id] = v.count;
      if (v.since) since[id] = v.since;
    });
    this.view = { revision: this.revision, running, since };
  }
}
