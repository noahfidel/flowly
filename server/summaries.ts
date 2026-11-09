import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import type { BoardStore } from "./store";
import { laneName } from "../shared/lanes";
import {
  SUMMARIZER_LABELS,
  SUMMARY_VERSIONS,
  emptySummaries,
  lastTurn,
  outputJsonSchema,
  parseModelOutput,
  summaryModelsOf,
  summaryPrompt,
  summaryStateSchema,
  truncateTranscript,
  turnText,
  type SummaryEntry,
  type SummaryOverview,
  type SummarySettings,
  type SummaryState,
} from "../shared/summary";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { runSummaryModels } from "./summary-models";
import { logFailure } from "./error-report";
export { availableModels } from "./summary-models";
import { summaryRow } from "../shared/native-session";

/** `summaries.json`: serialized writes, backup, atomic replacement; invalid data is preserved. */
export class SummaryStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "summaries.json");
  }
  private async load(): Promise<SummaryState> {
    try {
      return summaryStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySummaries();
      throw new Error(`Summary data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`);
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  update<T>(operation: (state: SummaryState) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean }): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      summaryStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        try {
          await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  /** Appends a version (keeping the newest SUMMARY_VERSIONS per card) and clears the card's error. */
  add(entry: Omit<SummaryEntry, "id" | "at">, now = new Date()) {
    return this.update((state) => {
      const created: SummaryEntry = { ...entry, id: randomUUID(), at: now.toISOString() };
      state.entries.push(created);
      const mine = state.entries.filter((e) => e.taskId === entry.taskId);
      if (mine.length > SUMMARY_VERSIONS) {
        const drop = new Set(mine.slice(0, mine.length - SUMMARY_VERSIONS).map((e) => e.id));
        state.entries = state.entries.filter((e) => !drop.has(e.id));
      }
      state.errors = state.errors.filter((e) => e.taskId !== entry.taskId);
      return { value: created, changed: true };
    });
  }
  setError(taskId: string, message: string, now = new Date()) {
    return this.update((state) => {
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      state.errors.push({ taskId, at: now.toISOString(), message: message.slice(0, 500) });
      return { value: undefined, changed: true };
    });
  }
  clearError(taskId: string) {
    return this.update((state) => {
      const before = state.errors.length;
      state.errors = state.errors.filter((e) => e.taskId !== taskId);
      return { value: undefined, changed: state.errors.length !== before };
    });
  }
  async history(taskId: string) {
    return (await this.read()).entries.filter((e) => e.taskId === taskId).reverse();
  }
  async latest(taskId: string) {
    const mine = (await this.read()).entries.filter((e) => e.taskId === taskId);
    return mine[mine.length - 1] || null;
  }
  /** Project folder restore: adds saved entries the store does not have (PROJECT-FOLDER-SPEC §3). */
  restoreEntries(entries: readonly SummaryEntry[]) {
    return this.update((state) => {
      const known = new Set(state.entries.map((e) => e.id));
      const fresh = entries.filter((e) => !known.has(e.id));
      state.entries.push(...fresh);
      return { value: fresh.length, changed: fresh.length > 0 };
    });
  }
  /** Project Remove: back up then drop the removed cards' summaries. */
  removeTasks(projectId: string, taskIds: ReadonlySet<string>, now = new Date()) {
    return this.update(async (state) => {
      const entries = state.entries.filter((e) => taskIds.has(e.taskId));
      const errors = state.errors.filter((e) => taskIds.has(e.taskId));
      if (!entries.length && !errors.length) return { value: null, changed: false };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `${projectId}-summaries-${now.toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(backup, JSON.stringify({ removedAt: now.toISOString(), entries, errors }, null, 2), { mode: 0o600, flag: "wx" });
      state.entries = state.entries.filter((e) => !taskIds.has(e.taskId));
      state.errors = state.errors.filter((e) => !taskIds.has(e.taskId));
      return { value: backup, changed: true };
    });
  }
}

/** `endedAt`: when the (last merged) turn ended; a later turn of that session skips the timeline row (NATIVE-SESSION-SPEC §5.1). */
type Batch = { text: string; agentIds: string[]; endedAt: string };
type TimelineEntry = { item: { type: string }; timestamp?: string };

export const SUMMARY_TIMEOUT_MS = 120_000;
/** The timeline row is best effort: a hung refresh or append must not hold up the card's next summary. */
export const SUMMARY_ROW_TIMEOUT_MS = 10_000;
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs the cheap summarizer after a turn of one of the card's chats. One run per card at a
 * time; turns that end meanwhile are merged into a single follow-up run.
 */
export class SummaryService {
  private queues = new Map<string, Batch[]>();
  private drains = new Map<string, Promise<void>>();
  constructor(
    readonly board: BoardStore,
    readonly store: SummaryStore,
    readonly settings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    private timeoutMs = SUMMARY_TIMEOUT_MS,
    private rowTimeoutMs = SUMMARY_ROW_TIMEOUT_MS,
    private remove: RemoveAgent = daemonRemoveAgent(),
  ) {}

  running() {
    return [...this.queues.keys()];
  }

  async overview(): Promise<SummaryOverview> {
    const [state, settings] = await Promise.all([this.store.read(), this.settings()]);
    const latest = new Map<string, SummaryEntry>();
    for (const e of state.entries) latest.set(e.taskId, e);
    return { latest: [...latest.values()], running: this.running(), errors: state.errors, enabled: settings.summaryEnabled };
  }

  /** Queues a turn for summarizing. Resolves when this card's queue is drained. */
  enqueue(
    taskId: string,
    agentId: string,
    timeline: readonly { type: string }[],
    paseo: PaseoApi,
    endedAt = new Date().toISOString(),
  ): Promise<void> {
    const text = turnText(timeline);
    if (!text.trim()) return Promise.resolve();
    const batch = { text, agentIds: [agentId], endedAt };
    const queue = this.queues.get(taskId);
    if (queue) {
      queue.push(batch);
      return Promise.resolve();
    }
    this.queues.set(taskId, [batch]);
    const drain: Promise<void> = this.drain(taskId, paseo).finally(() => {
      if (this.drains.get(taskId) === drain) this.drains.delete(taskId);
    });
    this.drains.set(taskId, drain);
    return drain;
  }

  /** Resolves when the card has no summary run in flight (wrap-up waits for it). */
  settled(taskId: string): Promise<void> {
    return this.drains.get(taskId) ?? Promise.resolve();
  }

  private async drain(taskId: string, paseo: PaseoApi) {
    try {
      for (;;) {
        const queue = this.queues.get(taskId)!;
        if (!queue.length) return;
        const merged = queue.splice(0, queue.length);
        const batch = {
          text: merged.map((b) => b.text).join("\n\n---\n\n"),
          agentIds: [...new Set(merged.flatMap((b) => b.agentIds))],
          endedAt: merged[merged.length - 1].endedAt,
        };
        const entry = await this.run(taskId, batch, paseo).catch((e) =>
          this.store
            .setError(taskId, e instanceof Error ? e.message : String(e))
            .catch(() => undefined)
            .then(() => null),
        );
        // In the background: the native row never holds up or changes Flowly's own summaries.
        if (entry) void this.appendRow(taskId, merged[merged.length - 1].agentIds[0], batch.endedAt, entry, paseo);
      }
    } finally {
      this.queues.delete(taskId);
    }
  }

  /** The new version, or null when nothing was written. */
  private async run(taskId: string, batch: Batch, paseo: PaseoApi): Promise<SummaryEntry | null> {
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt) return null;
    const settings = await this.settings();
    const previous = await this.store.latest(taskId);
    const prompt = summaryPrompt({
      title: task.title,
      description: task.description,
      lane: laneName(project, task.status),
      previous,
      transcript: truncateTranscript(batch.text),
      language: await this.language(),
    });
    const { model, output } = await runSummaryModels(paseo, summaryModelsOf(settings), {
      create: (model) => paseo.workspaces.ref(task.workspaceId).agents.create({
        parent: batch.agentIds[batch.agentIds.length - 1],
        config: { provider: model },
        title: `Kanban summary · ${task.title}`.slice(0, 120),
        labels: { ...SUMMARIZER_LABELS, "flowly-task": taskId },
        prompt,
        outputSchema: outputJsonSchema as unknown as Record<string, unknown>,
      }),
      parse: parseModelOutput,
      remove: this.remove,
      timeoutMs: this.timeoutMs,
    });
    if (!output.update && previous) {
      await this.store.clearError(taskId);
      return null;
    }
    return this.store.add({ taskId, model, agentIds: batch.agentIds, state: output.state, target: output.target, recap: output.recap, next: output.next });
  }

  /**
   * The version as a row in the session's native timeline (NATIVE-SESSION-SPEC §5.1). Best effort: Paseo keeps
   * these rows in memory only. Skipped when that session started a newer turn (the row would read as a summary of
   * the new message) or is archived; a failure is only logged and never touches the stored version.
   */
  private async appendRow(taskId: string, agentId: string, endedAt: string, entry: SummaryEntry, paseo: PaseoApi) {
    try {
      const board = await this.board.read();
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const newer = board.events.some(
        (e) => e.agentId === agentId && e.action === "agent.turn_started" && Date.parse(e.at) > Date.parse(endedAt),
      );
      if (newer) return;
      const session = paseo.agents.ref(agentId);
      const snapshot = await within(session.refresh(), this.rowTimeoutMs);
      if (!snapshot?.agent || snapshot.agent.archivedAt) return;
      await within(session.timeline.append(summaryRow(entry, task.workspaceId)), this.rowTimeoutMs);
    } catch (e) {
      logFailure("Flowly summary row not added:", e);
    }
  }

  /** Manual refresh: the last turn of the card's most recently active chat (`resolveCardChats`, §2.1). */
  async refresh(taskId: string, chatIds: readonly string[], paseo: PaseoApi) {
    if (this.queues.has(taskId)) return { queued: true };
    if (!chatIds.length) throw new Error("This card has no chats to summarize yet.");
    let best: { agentId: string; at: string; items: { type: string }[] } | null = null;
    for (const agentId of chatIds) {
      const response = await paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit: 200, projection: "projected" })
        .catch(() => null);
      const entries = ((response?.entries || []) as TimelineEntry[]).filter((e) => e.item);
      if (!entries.length) continue;
      const at = entries[entries.length - 1].timestamp || "";
      if (!best || at > best.at) best = { agentId, at, items: lastTurn(entries.map((e) => e.item)) };
    }
    if (!best) throw new Error("No conversation to summarize yet.");
    void this.enqueue(taskId, best.agentId, best.items, paseo, best.at || undefined);
    return { queued: true };
  }
}
