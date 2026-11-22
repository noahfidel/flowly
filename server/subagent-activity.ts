import { logFailure } from "./error-report";
import type { ProviderSubagent } from "../shared/subagents";

/** What the service needs from `ProviderSubagentService`. */
export interface SubagentLister {
  listFor(agentId: string): Promise<{ subagents: readonly Pick<ProviderSubagent, "status" | "createdAt">[]; unavailable: boolean }>;
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

type Entry = { timer: ReturnType<typeof setTimeout> | null; queued: boolean };

/**
 * Which idle card sessions have provider subagents running (SUBAGENTS-SPEC §10). A card session's list is read
 * once when its turn ends (and once at plugin start for idle card sessions); while any of its subagents runs it is
 * read again every 5 s, and it stops being read when none runs, when the session starts a turn (its own turn makes
 * the card run) or when it is archived, gone or no longer a card's. Reads go one at a time over the provider
 * subagent service's short-lived connection; an older or unreachable daemon gives empty data, quietly.
 */
export class SubagentActivity {
  private readonly entries = new Map<string, Entry>();
  private readonly counts = new Map<string, { count: number; since: string }>();
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
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
      const created: Entry = { timer: null, queued: false };
      this.entries.set(agentId, created);
      this.enqueue(agentId, created);
      return;
    }
    // Waiting for its next read: read now. A read in flight or queued already covers this turn's end.
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
    while (this.draining) await this.draining;
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
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  private async drain() {
    while (this.queue.length && !this.stopped) {
      const id = this.queue.shift()!;
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.queued = false;
      let running: Pick<ProviderSubagent, "status" | "createdAt">[] = [];
      try {
        if (!(await this.deps.isCardSession(id))) {
          if (this.entries.get(id) === entry) this.forget(id);
          continue;
        }
        // Failures are the lister's to report; `unavailable` reads as nothing running.
        const result = await this.deps.lister.listFor(id);
        if (!result.unavailable) running = result.subagents.filter((s) => s.status === "running");
      } catch (e) {
        logFailure("Flowly could not read subagent activity:", e, id);
      }
      // Dropped (turn started, archived) or stopped while the read ran: the answer is stale.
      if (this.stopped || this.entries.get(id) !== entry) continue;
      if (!running.length) {
        this.forget(id);
        continue;
      }
      const since = running.reduce((min, s) => (s.createdAt && (!min || s.createdAt < min) ? s.createdAt : min), "");
      this.setCount(id, { count: running.length, since });
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (this.entries.get(id) === entry) this.enqueue(id, entry);
      }, this.pollMs);
      entry.timer.unref?.();
    }
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
