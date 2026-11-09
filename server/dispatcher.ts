import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  dispatcherCharter,
  dispatcherContextLimit,
  dispatcherStartInputSchema,
  noteBatching,
  type DispatcherNote,
  type DispatcherState,
  type DispatcherStatus,
} from "../shared/dispatcher";
import { exportMarkdown } from "../shared/board-export";
import type { Board } from "../shared/model";
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
} | null | undefined;

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
    "Flowly board summary. Pass the projectId to every tool.",
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
    `Flowly board update (${notes.length} ${notes.length === 1 ? "card" : "cards"}):`,
    ...notes.map((n) => `- "${oneLine(n.title)}" [${n.taskId}] in project ${n.projectId}: ${n.kind}${n.detail ? ` — ${oneLine(n.detail)}` : ""}`),
  ].join("\n");
}

export class Dispatcher {
  private cached: DispatcherRecord | null = null;
  private loading: Promise<DispatcherRecord> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private starts: Promise<unknown> = Promise.resolve();
  private deliveries: Promise<unknown> = Promise.resolve();
  /** Notes waiting for the dispatcher's turn to end, one per card (latest wins). */
  private held = new Map<string, DispatcherNote>();
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
    this.loading ??= this.load().then((record) => {
      this.cached ??= record;
      return this.cached;
    });
    return this.loading;
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
  start(paseo: PaseoApi, raw: { provider: string; modeId?: string }): Promise<{ agentId: string }> {
    const input = dispatcherStartInputSchema.parse(raw);
    const job = this.starts.then(() => this.run(paseo, input));
    this.starts = job.catch(() => undefined);
    return job;
  }

  private async run(paseo: PaseoApi, input: { provider: string; modeId?: string }) {
    const { state } = await this.status(paseo);
    if (state === "running" || state === "idle")
      throw new ToolError("DISPATCHER_RUNNING", "The dispatcher is already running. Open its chat instead of starting another.");
    const previous = await this.record();
    const workspaceId = await this.workspace(paseo, previous);
    const agentId = randomUUID();
    const [mcp, summary] = await Promise.all([this.deps.mcp({ agentId, workspaceId }), this.deps.summary()]);
    const now = this.deps.now?.() ?? Date.now();
    // Stored first: the session's first tool calls already pass the caller check (§4).
    await this.save({ version: 1, workspaceId, agentId, startedAt: new Date(now).toISOString() });
    this.held.clear();
    try {
      await paseo.workspaces.ref(workspaceId).agents.create({
        agentId,
        idempotencyKey: `flowly-dispatcher:${agentId}`,
        config: {
          provider: input.provider,
          ...(input.modeId ? { modeId: input.modeId } : {}),
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
        await this.save({ ...previous, workspaceId });
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
    await this.save({ ...record, workspaceId: id });
    return id;
  }

  /** Delivers a batch by state: idle → sent, running → held until its turn ends, down → dropped (§7). */
  deliver(notes: readonly DispatcherNote[], paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      for (const note of notes) {
        this.held.delete(note.taskId);
        this.held.set(note.taskId, note);
      }
      await this.flush(paseo);
    });
  }

  /** `agent.turn_ended` of any session: the dispatcher's own sends what it held. */
  turnEnded(agentId: string, paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      if (!this.held.size || agentId !== (await this.record()).agentId) return;
      await this.flush(paseo);
    });
  }

  private async flush(paseo: PaseoApi) {
    if (!this.held.size) return;
    let status: DispatcherStatus;
    try {
      // Read just before sending: a send while a turn runs would interrupt it.
      status = await this.status(paseo);
    } catch (e) {
      logFailure("Flowly dispatcher state unreadable; notes dropped:", e);
      this.held.clear();
      return;
    }
    if (status.state === "running") return;
    const notes = [...this.held.values()];
    this.held.clear();
    if (status.state !== "idle" || !status.agentId) return;
    try {
      await paseo.agents.ref(status.agentId).send(noteMessage(notes));
    } catch (e) {
      logFailure("Flowly dispatcher notes not sent:", e, `${notes.length} notes`);
    }
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

  private save(record: DispatcherRecord) {
    const value = recordSchema.parse(record);
    const job = this.writes.then(async () => {
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
    if (!api) return;
    void dispatcher.deliver(notes, api).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
  });
  const off = bus.subscribe((facts) => {
    const stops = facts.filter(isStop);
    if (stops.length) batcher.push(stops);
  });
  return () => {
    off();
    batcher.dispose();
  };
}
