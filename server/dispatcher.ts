import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  dispatcherCharter,
  dispatcherContextLimit,
  dispatcherDefaultModel,
  dispatcherStartInputSchema,
  mergeNotes,
  noteBatching,
  noteMessagePrefix,
  seenIdLimit,
  summaryMessagePrefix,
  userSendOptions,
  type DispatcherNote,
  type DispatcherState,
  type DispatcherStatus,
} from "../shared/dispatcher";
import { exportMarkdown } from "../shared/board-export";
import type { Board } from "../shared/model";
import type { AgentModel } from "../shared/agent-defaults";
import { createDirectoryWorkspace } from "./background-workspace";
import { logFailure } from "./error-report";
import { EventBus, NoteBatcher, isStop } from "./event-bus";
import type { DispatcherIdentity } from "./tool-context";
import { ToolError } from "./tool-error";

/** The one cross-project dispatcher session: record, workspace, lifecycle and note delivery (DISPATCHER-SPEC). */

export const DISPATCHER_TITLE = "Flowly dispatcher";

const recordSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
  startedAt: z.string().nullable(),
  /** The user's "Changed since you looked" mark, in event milliseconds (§9.2); absent in older files. */
  seenRevision: z.number().int().nonnegative().optional(),
  /** Ids of the seen events at exactly `seenRevision`, so later events in that millisecond still count. */
  seenIds: z.array(z.string().min(1).max(300)).max(seenIdLimit).optional(),
});
export type DispatcherRecord = z.infer<typeof recordSchema>;
const emptyRecord = (): DispatcherRecord => ({ version: 1, workspaceId: null, agentId: null, startedAt: null });

export type DispatcherMcpServer = { type: "http"; url: string; headers: Record<string, string> };
export type DispatcherDeps = {
  /** The `flowly-dispatcher` MCP server entry for this session (the tool service, sealed credential). */
  mcp: (identity: DispatcherIdentity) => Promise<DispatcherMcpServer>;
  /** The first message: projects with their ids, open cards and ideas (§6). */
  summary: () => Promise<string>;
  now?: () => number;
};

type AgentSnapshot = {
  status?: string | null;
  archivedAt?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  pendingPermissions?: readonly unknown[] | null;
} | null | undefined;

/** After a send, Paseo may still report the dispatcher idle for a moment; no second send within this (as the composer's drain). */
export const SEND_COOLDOWN_MS = 8_000;
/** `agent.turn_ended` can arrive before Paseo's snapshot leaves "running": one retry after this. */
export const TURN_END_RETRY_MS = 2_000;

/** The state of the stored dispatcher session as Flowly reads it (§3). */
export function dispatcherState(agent: AgentSnapshot): Exclude<DispatcherState, "none"> {
  if (!agent || agent.archivedAt || agent.status === "error" || agent.status === "closed") return "ended";
  const used = agent.lastUsage?.contextWindowUsedTokens,
    max = agent.lastUsage?.contextWindowMaxTokens;
  if (typeof used === "number" && typeof max === "number" && max > 0 && used / max >= dispatcherContextLimit) return "context_full";
  return agent.status === "running" || agent.status === "initializing" ? "running" : "idle";
}

/** The dispatcher's first message (§6): each live project's id, then the open cards and ideas, without memory. */
export function dispatcherSummary(board: Board): string {
  const live = board.projects.filter((p) => !p.archivedAt);
  const projects = live.map((p) => `- ${p.id}: ${p.title.replace(/\s+/g, " ").trim()}`);
  return [
    `${summaryMessagePrefix} Pass the projectId to every tool.`,
    "",
    "Projects (projectId: title):",
    ...(projects.length ? projects : ["- none yet"]),
    "",
    exportMarkdown({ ...board, projects: live }, {}).trim(),
  ]
    .join("\n")
    .trim();
}

/** One message for a batch of notes (§7). */
export function noteMessage(notes: readonly DispatcherNote[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return [
    `${noteMessagePrefix}${notes.length} ${notes.length === 1 ? "card" : "cards"}):`,
    ...notes.map((n) => {
      const detail = [n.detail, n.later ? `then ${n.later}` : ""].filter(Boolean).map(oneLine).join("; ");
      return `- "${oneLine(n.title)}" [${n.taskId}] in project ${n.projectId}: ${n.kind}${detail ? ` — ${detail}` : ""}${n.earlier ? ` (+${n.earlier} earlier)` : ""}`;
    }),
  ].join("\n");
}

export class Dispatcher {
  private cached: DispatcherRecord | null = null;
  private loading: Promise<DispatcherRecord> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private starts: Promise<unknown> = Promise.resolve();
  private deliveries: Promise<unknown> = Promise.resolve();
  /** Notes waiting for the dispatcher's turn to end, one per card (merged with `mergeNotes`). */
  private held = new Map<string, DispatcherNote>();
  /** When Flowly last sent the dispatcher notes; null before the first send. */
  private lastSent: number | null = null;
  /** The one pending re-check (send cooldown or turn-end retry). */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** The Dispatcher model setting (plan Q6); null uses `dispatcherDefaultModel`. Set by the plugin entry. */
  modelSetting: () => Promise<AgentModel | null> = async () => null;
  /** The notes of a batch the dispatcher received, and when (the chat's note rows, §9.1). Set by the plugin entry. */
  onSent: ((notes: readonly DispatcherNote[], at: string) => void) | null = null;
  constructor(
    readonly directory: string,
    private readonly deps: DispatcherDeps,
  ) {}
  get path() {
    return join(this.directory, "dispatcher.json");
  }
  get workspacePath() {
    return join(this.directory, "dispatcher");
  }

  /** The stored record; a corrupt file is kept as `.invalid-<ms>` and read as empty (§1). */
  async record(): Promise<DispatcherRecord> {
    if (this.cached) return this.cached;
    this.loading ??= this.load().then(
      (record) => {
        this.cached ??= record;
        return this.cached;
      },
      (e) => {
        // Not cached: the next call reads the file again.
        this.loading = null;
        throw e;
      },
    );
    return this.loading;
  }
  /** Whether `path` is the dispatcher's folder, which never becomes a Flowly project (§2). */
  async ownsRoot(path: string) {
    const [own, other] = await Promise.all([realpath(this.workspacePath).catch(() => null), realpath(path).catch(() => null)]);
    return !!own && own === other;
  }
  /** The stored dispatcher session id once the record is loaded (for the note batcher, which cannot wait). */
  agentId() {
    return this.cached?.agentId ?? null;
  }
  /** Whether `workspaceId` is the dispatcher's workspace; such a workspace is never bound to a card (§2). */
  async owns(workspaceId: string) {
    const { workspaceId: own } = await this.record();
    return !!own && own === workspaceId;
  }

  async status(paseo: PaseoApi): Promise<DispatcherStatus> {
    const { agentId } = await this.record();
    if (!agentId) return { state: "none", agentId: null };
    const found = await paseo.agents.ref(agentId).refresh();
    return { state: dispatcherState(found?.agent), agentId };
  }

  /** Starts a new dispatcher session; one at a time, refused while one is up (§3). */
  start(paseo: PaseoApi, raw: { provider?: string; modeId?: string }): Promise<{ agentId: string }> {
    const input = dispatcherStartInputSchema.parse(raw);
    const job = this.starts.then(async () => this.run(paseo, await this.model(input)));
    this.starts = job.catch(() => undefined);
    return job;
  }

  /** The passed `provider/model`, else the Dispatcher model setting, else the server default (§3). */
  private async model(input: { provider?: string; modeId?: string }): Promise<{ provider: string; modeId?: string; thinking?: string }> {
    if (input.provider) return { provider: input.provider, ...(input.modeId ? { modeId: input.modeId } : {}) };
    const stored = await this.modelSetting().catch((e) => {
      logFailure("Flowly dispatcher model setting unreadable; using the default:", e);
      return null;
    });
    const model: AgentModel = stored ?? { ...dispatcherDefaultModel };
    const modeId = input.modeId ?? model.mode;
    return { provider: `${model.provider}/${model.model}`, ...(modeId ? { modeId } : {}), ...(model.thinking ? { thinking: model.thinking } : {}) };
  }

  private async run(paseo: PaseoApi, input: { provider: string; modeId?: string; thinking?: string }) {
    const { state } = await this.status(paseo);
    if (state === "running" || state === "idle")
      throw new ToolError("DISPATCHER_RUNNING", "The dispatcher is already running. Open its chat instead of starting another.");
    const previous = await this.record();
    const workspaceId = await this.workspace(paseo, previous);
    const agentId = randomUUID();
    const [mcp, summary] = await Promise.all([this.deps.mcp({ agentId, workspaceId }), this.deps.summary()]);
    const now = this.deps.now?.() ?? Date.now();
    // Stored first: the session's first tool calls already pass the caller check (§4).
    await this.save((r) => ({ ...r, workspaceId, agentId, startedAt: new Date(now).toISOString() }));
    this.held.clear();
    try {
      await paseo.workspaces.ref(workspaceId).agents.create({
        agentId,
        idempotencyKey: `flowly-dispatcher:${agentId}`,
        config: {
          provider: input.provider,
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinking ? { thinkingOptionId: input.thinking } : {}),
          systemPrompt: dispatcherCharter,
          mcpServers: { "flowly-dispatcher": mcp },
        },
        title: DISPATCHER_TITLE,
        labels: { "flowly-dispatcher": "1" },
        prompt: summary,
      });
    } catch (e) {
      const made = await paseo.agents
        .ref(agentId)
        .refresh()
        .then((found) => !!found?.agent)
        .catch(() => false);
      if (!made) {
        await this.save((r) => ({ ...r, workspaceId, agentId: previous.agentId, startedAt: previous.startedAt }));
        logFailure("Flowly dispatcher not started:", e, `workspace ${workspaceId}`);
        throw new ToolError("START_FAILED", `Paseo did not start the dispatcher: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { agentId };
  }

  /** The stored workspace while Paseo still returns it; else a new background directory workspace (§2). Never archived. */
  private async workspace(paseo: PaseoApi, record: DispatcherRecord) {
    if (record.workspaceId) {
      const found = await paseo.workspaces.ref(record.workspaceId).refresh();
      if (found && !found.archivingAt) return record.workspaceId;
    }
    await mkdir(this.workspacePath, { recursive: true, mode: 0o700 });
    const id = await createDirectoryWorkspace(paseo, {
      title: DISPATCHER_TITLE,
      idempotencyKey: `flowly-dispatcher-workspace:${randomUUID()}`,
      path: this.workspacePath,
      background: true,
    });
    await this.save((r) => ({ ...r, workspaceId: id }));
    return id;
  }

  /** Delivers a batch by state: idle → sent, running → held until its turn ends, down → dropped (§7). */
  deliver(notes: readonly DispatcherNote[], paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      if (this.disposed) return;
      for (const note of notes) {
        const prev = this.held.get(note.taskId);
        this.held.delete(note.taskId);
        this.held.set(note.taskId, prev ? mergeNotes(prev, note) : note);
      }
      await this.flush(paseo, false);
    });
  }

  /** `agent.turn_ended` of any session: the dispatcher's own sends what it held. */
  turnEnded(agentId: string, paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      if (this.disposed || !this.held.size || agentId !== (await this.record()).agentId) return;
      await this.flush(paseo, true);
    });
  }

  /** Plugin unload: no more sends or re-checks; held notes are dropped and logged (§7). */
  dispose() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.disposed && this.held.size) logFailure("Flowly dispatcher held notes dropped on unload:", `${this.held.size} notes`);
    this.held.clear();
    this.disposed = true;
  }

  /**
   * Sends the held notes only when the dispatcher is idle with no pending permission and the send cooldown has
   * passed. A send without `activeTurnBehavior` interrupts a running turn and answers a pending permission
   * (Paseo's daemon defaults it to "interrupt" with `clearPendingPermissions`), so both hold the notes instead.
   */
  private async flush(paseo: PaseoApi, afterTurnEnd: boolean) {
    if (this.disposed || !this.held.size) return;
    let agentId: string | null, agent: AgentSnapshot;
    try {
      agentId = (await this.record()).agentId;
      agent = agentId ? (await paseo.agents.ref(agentId).refresh())?.agent : null;
    } catch (e) {
      logFailure("Flowly dispatcher state unreadable; notes dropped:", e, `${this.held.size} notes`);
      this.held.clear();
      return;
    }
    const state = agentId ? dispatcherState(agent) : "none";
    if (state === "running" || (state === "idle" && agent?.pendingPermissions?.length)) {
      // The hook can fire before Paseo's snapshot leaves "running": look once more shortly after.
      if (afterTurnEnd) this.recheck(paseo, TURN_END_RETRY_MS);
      return;
    }
    if (state !== "idle" || !agentId) {
      this.held.clear();
      return;
    }
    const wait = this.lastSent === null ? 0 : this.lastSent + SEND_COOLDOWN_MS - this.now();
    if (wait > 0) {
      this.recheck(paseo, wait);
      return;
    }
    const notes = [...this.held.values()];
    this.held.clear();
    let sentAt: number;
    try {
      await paseo.agents.ref(agentId).send(noteMessage(notes));
      sentAt = this.lastSent = this.now();
    } catch (e) {
      logFailure("Flowly dispatcher notes not sent:", e, `${notes.length} notes`);
      return;
    }
    try {
      this.onSent?.(notes, new Date(sentAt).toISOString());
    } catch (e) {
      logFailure("Flowly dispatcher chat notes not recorded:", e, `${notes.length} notes`);
    }
  }

  /**
   * Mark seen (§9.2): the mark only moves forward and never past the daemon's clock. At the same millisecond
   * the event ids add up; a clamped mark keeps no ids (they belong to a later millisecond).
   */
  async markSeen(revision: number, ids: readonly string[] = []): Promise<number> {
    const now = this.now();
    const target = Math.min(revision, now);
    const marked = target === revision ? ids : [];
    let seen = 0;
    await this.save((r) => {
      if (r.seenRevision !== undefined && target < r.seenRevision) {
        seen = r.seenRevision;
        return r;
      }
      const kept = target === r.seenRevision ? (r.seenIds ?? []) : [];
      seen = target;
      return { ...r, seenRevision: target, seenIds: [...new Set([...kept, ...marked])].slice(-seenIdLimit) };
    });
    return seen;
  }

  /** "What should I do?" (§9.2): only to a dispatcher that is up; always steered, as by the composer (`userSendOptions`). */
  async whatNext(paseo: PaseoApi, text: string): Promise<void> {
    const { state, agentId } = await this.status(paseo);
    if (!agentId || (state !== "running" && state !== "idle"))
      throw new ToolError("DISPATCHER_DOWN", "The dispatcher is not running. Start it first.");
    await paseo.agents.ref(agentId).send(text, userSendOptions);
  }

  /** One pending re-check at a time; it never schedules another for a turn end (retry once). */
  private recheck(paseo: PaseoApi, ms: number) {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.serial(() => this.flush(paseo, false)).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
    }, ms);
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private serial(job: () => Promise<void>) {
    const run = this.deliveries.then(job, job);
    this.deliveries = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<DispatcherRecord> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRecord();
      throw e;
    }
    try {
      return recordSchema.parse(JSON.parse(text));
    } catch (e) {
      const kept = `${this.path}.invalid-${this.deps.now?.() ?? Date.now()}`;
      await rename(this.path, kept).catch((error) => logFailure("Flowly dispatcher record not preserved:", error));
      logFailure("Flowly dispatcher record is invalid; starting empty:", e, kept);
      return emptyRecord();
    }
  }

  /** Writes `change` of the latest record, so concurrent writes (start, Mark seen) never drop each other's fields. */
  private save(change: (record: DispatcherRecord) => DispatcherRecord) {
    const job = this.writes.then(async () => {
      const value = recordSchema.parse(change(await this.record()));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.cached = value;
    });
    this.writes = job.catch(() => undefined);
    return job;
  }
}

/**
 * Bus → batcher → dispatcher (§7): only stops are batched, the dispatcher's own facts are dropped by the
 * batcher, and each batch is delivered with the Paseo API the plugin last saw. Returns the unload cleanup.
 */
export function wireDispatcher(bus: EventBus, dispatcher: Dispatcher, paseo: () => PaseoApi | undefined) {
  const batcher = new NoteBatcher({ ...noteBatching, exclude: () => dispatcher.agentId() }, (notes) => {
    const api = paseo();
    if (!api) {
      logFailure("Flowly dispatcher notes dropped: no Paseo connection yet:", `${notes.length} notes`);
      return;
    }
    void dispatcher.deliver(notes, api).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
  });
  const off = bus.subscribe((facts) => {
    const stops = facts.filter(isStop);
    if (stops.length) batcher.push(stops);
  });
  return () => {
    off();
    batcher.dispose();
    dispatcher.dispose();
  };
}
