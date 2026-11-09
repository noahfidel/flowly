import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  dispatcherCharter,
  dispatcherDefaultModel,
  dispatcherServerName,
  dispatcherToolNames,
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
/**
 * The dispatcher's working folder (§2): `<Paseo home>/flowly-dispatcher/dispatcher`. It sits outside the plugin data
 * folder, in a parent of its own that holds nothing else, so a provider that auto-allows access inside the cwd does not
 * cover the board, the token-sealing key, the database, plugin settings or Paseo's own files. Not a sandbox: the
 * boundary is the sealed credential and the provider's permission prompts. The `dispatcher` name keeps the Paseo
 * project's name as before.
 */
export function dispatcherFolder(paseoHome: string) {
  return join(resolve(paseoHome), "flowly-dispatcher", "dispatcher");
}

/** Whether `path` is `parent` or inside it (lexically, on resolved paths). */
function within(path: string, parent: string) {
  const r = relative(parent, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Why `folder` cannot be the dispatcher's folder next to the data folder `data`, or null (§2). */
export function dispatcherFolderProblem(folder: string, data: string): string | null {
  if (within(folder, data) || within(data, folder)) return "it is inside the plugin data folder, or holds it";
  if (within(data, dirname(folder))) return "its parent folder holds the plugin data folder";
  return null;
}

/**
 * Where `path` resolves to before it exists: the real path of its deepest existing ancestor plus the rest. Null when
 * an entry on the way is a link that points nowhere (it cannot be judged).
 */
async function projectedPath(path: string): Promise<string | null> {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    const real = await realpath(at).catch(() => null);
    if (real) return join(real, ...rest);
    if (await lstat(at).then(() => true, () => false)) return null;
    const up = dirname(at);
    if (up === at) return null;
    rest.unshift(basename(at));
    at = up;
  }
}

/** How many earlier dispatcher session ids the record keeps. */
const previousAgentIdLimit = 20;

const recordSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
  startedAt: z.string().nullable(),
  /** The user's "Changed since you looked" mark, in event milliseconds (§9.2); absent in older files. */
  seenRevision: z.number().int().nonnegative().optional(),
  /** Ids of the seen events at exactly `seenRevision`, so later events in that millisecond still count. */
  seenIds: z.array(z.string().min(1).max(300)).max(seenIdLimit).optional(),
  /** The earlier dispatcher sessions of this install, oldest first (their actions are not news either, §9.2). */
  previousAgentIds: z.array(z.string().min(1).max(300)).max(previousAgentIdLimit).optional(),
  /** Its session was saved with the `flowly-dispatcher` server and every tool preapproved (§3); absent for older ones. */
  savedTools: z.literal(true).optional(),
});
export type DispatcherRecord = z.infer<typeof recordSchema>;
/**
 * Providers whose dispatcher session is saved with its tools, every one preapproved (§3). Paseo's daemon preapproves
 * exact MCP tools only for claude, codex and opencode (provider-registry.js PROVIDER_CONTRACTS; providers derived from
 * them, which a plugin cannot tell apart, are left out), and any tool policy turns OpenCode's auto-accept off
 * (opencode-agent.js). Every other provider gets the tools from the open hook, unapproved.
 */
const preapprovingProviders: readonly string[] = ["claude", "codex"];
export const savesTools = (provider: string) => preapprovingProviders.includes(provider.split("/")[0]);

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
  pendingPermissions?: readonly unknown[] | null;
} | null | undefined;

/** After a send, Paseo may still report the dispatcher idle for a moment; no second send within this (as the composer's drain). */
export const SEND_COOLDOWN_MS = 8_000;
/** `agent.turn_ended` can arrive before Paseo's snapshot leaves "running": the first re-check after this. */
export const TURN_END_RETRY_MS = 2_000;
/** While notes stay held after a turn end, the re-checks slow down to at most one per this long (§7). */
export const RECHECK_MAX_MS = 60_000;
const recheckDelays = [TURN_END_RETRY_MS, 5_000, 15_000, 30_000, RECHECK_MAX_MS];

/**
 * The one test for a dead dispatcher (§3): Paseo no longer returns it, it is archived, or it is closed. Only a
 * dead dispatcher is replaced (and then archived); every other status, `error` included, is the live one.
 */
export function isDeadDispatcher(agent: AgentSnapshot): boolean {
  return !agent || !!agent.archivedAt || agent.status === "closed";
}

/** The state of the stored dispatcher session as Flowly reads it (§3). */
export function dispatcherState(agent: AgentSnapshot): Exclude<DispatcherState, "none"> {
  if (isDeadDispatcher(agent)) return "ended";
  return agent?.status === "running" || agent?.status === "initializing" ? "running" : "idle";
}

const dispatcherRunning = () => new ToolError("DISPATCHER_RUNNING", "The dispatcher is already running. Open its chat instead of starting another.");

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
  /** The one pending re-check (send cooldown or turn-end retry) and when it fires. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  /** After a turn end, held notes are re-checked with a growing delay (`recheckDelays`) until they go out. */
  private chasing = false;
  private chaseStep = 0;
  /** The session id a start has stored but Paseo may not have created yet: notes for it are held, not dropped. */
  private starting: string | null = null;
  private disposed = false;
  /** The Dispatcher model setting (plan Q6); null uses `dispatcherDefaultModel`. Set by the plugin entry. */
  modelSetting: () => Promise<AgentModel | null> = async () => null;
  /** The notes of a batch the dispatcher received, and when (the chat's note rows, §9.1). Set by the plugin entry. */
  onSent: ((notes: readonly DispatcherNote[], at: string) => void) | null = null;
  constructor(
    readonly directory: string,
    private readonly deps: DispatcherDeps,
    /** The working folder (§2), from `dispatcherFolder`; never inside or next to `directory`. */
    readonly workspacePath: string,
  ) {}
  get path() {
    return join(this.directory, "dispatcher.json");
  }
  /** Where the dispatcher worked before it moved out of the data folder (§2); recognized, never reused, moved or deleted. */
  get legacyWorkspacePath() {
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
    const [own, legacy, other] = await Promise.all([this.workspacePath, this.legacyWorkspacePath, path].map((p) => realpath(p).catch(() => null)));
    return !!other && (other === own || other === legacy);
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
    const state = dispatcherState(found?.agent);
    // A read that sees it idle is a chance to deliver what is held (§7).
    if (state === "idle" && this.held.size && !this.disposed)
      void this.serial(() => this.flush(paseo, false)).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
    return { state, agentId };
  }

  /** Starts a new dispatcher session; one at a time, refused unless the stored one is dead (§3). */
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
    const stored = await this.record();
    if (stored.agentId && !isDeadDispatcher((await paseo.agents.ref(stored.agentId).refresh())?.agent)) throw dispatcherRunning();
    const workspaceId = await this.workspace(paseo, stored);
    const previous = await this.record();
    const agentId = randomUUID();
    // Held from before the board summary is taken: a note that arrives while it is written, or before the new id
    // is stored, waits for the new session instead of reaching (and being dropped for) the dead one (§7).
    this.starting = agentId;
    // What is held now is on the board the summary reads; later notes are kept (one may repeat the summary).
    const covered = [...this.held];
    try {
      const saved = savesTools(input.provider);
      const [mcp, summary] = await Promise.all([saved ? this.deps.mcp({ agentId, workspaceId }) : null, this.deps.summary()]);
      if (previous.agentId) await this.retire(paseo, previous.agentId);
      const now = this.deps.now?.() ?? Date.now();
      const earlier = previous.agentId
        ? [...(previous.previousAgentIds ?? []).filter((id) => id !== previous.agentId), previous.agentId].slice(-previousAgentIdLimit)
        : previous.previousAgentIds;
      for (const [taskId, held] of covered) if (this.held.get(taskId) === held) this.held.delete(taskId);
      // Stored first: the session's first tool calls already pass the caller check (§4).
      // Only a session saved with its tools is marked; any other gets them from the open hook (§3).
      await this.save(({ savedTools: _, ...r }) => ({
        ...r,
        workspaceId,
        agentId,
        startedAt: new Date(now).toISOString(),
        ...(saved ? { savedTools: true as const } : {}),
        ...(earlier ? { previousAgentIds: earlier } : {}),
      }));
      await this.create(paseo, { workspaceId, agentId, mcp, summary, input, previous });
    } finally {
      this.starting = null;
      // Notes held meanwhile go out by the dispatcher's state now (the new one, or the one a refused start kept).
      void this.serial(() => this.flush(paseo, false)).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
    }
    return { agentId };
  }

  /**
   * The stored dispatcher is being replaced: read it again and archive it only while it is still dead and not
   * archived yet (that id only, never its workspace). A session that came back meanwhile refuses the start.
   */
  private async retire(paseo: PaseoApi, agentId: string) {
    const again = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!isDeadDispatcher(again)) throw dispatcherRunning();
    if (!again || again.archivedAt) return;
    try {
      await paseo.agents.ref(agentId).archive();
    } catch (e) {
      logFailure("Flowly dispatcher: dead session not archived:", e, `agent ${agentId}`);
    }
  }

  private async create(
    paseo: PaseoApi,
    { workspaceId, agentId, mcp, summary, input, previous }: {
      workspaceId: string;
      agentId: string;
      mcp: DispatcherMcpServer | null;
      summary: string;
      input: { provider: string; modeId?: string; thinking?: string };
      previous: DispatcherRecord;
    },
  ) {
    try {
      await paseo.workspaces.ref(workspaceId).agents.create({
        agentId,
        idempotencyKey: `flowly-dispatcher:${agentId}`,
        config: {
          provider: input.provider,
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinking ? { thinkingOptionId: input.thinking } : {}),
          systemPrompt: dispatcherCharter,
          // Saved with the session and every tool preapproved, so its own tools never prompt (they are gated by the
          // "Agents create and edit cards" switch); Paseo checks each grant's server is in this same request (§3).
          ...(mcp
            ? {
                mcpServers: { [dispatcherServerName]: mcp },
                toolPolicy: { preapproved: dispatcherToolNames.map((tool) => ({ kind: "mcp" as const, server: dispatcherServerName, tool })) },
              }
            : {}),
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
        await this.save((r) => {
          const { previousAgentIds: _, savedTools: __, ...rest } = r;
          return {
            ...rest,
            ...(previous.savedTools ? { savedTools: true as const } : {}),
            workspaceId,
            agentId: previous.agentId,
            startedAt: previous.startedAt,
            ...(previous.previousAgentIds ? { previousAgentIds: previous.previousAgentIds } : {}),
          };
        });
        logFailure("Flowly dispatcher not started:", e, `workspace ${workspaceId}`);
        throw new ToolError("START_FAILED", `Paseo did not start the dispatcher: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The stored workspace while Paseo still returns it; else a new background directory workspace (§2). Never archived. */
  private async workspace(paseo: PaseoApi, record: DispatcherRecord) {
    await this.prepareFolder();
    if (record.workspaceId) {
      const found = await paseo.workspaces.ref(record.workspaceId).refresh();
      // Reused only while it is in the dispatcher folder: one in the old in-data folder (or anywhere else) is left as it is.
      if (found && !found.archivingAt && (await this.inFolder(found.workspaceDirectory))) return record.workspaceId;
    }
    const id = await createDirectoryWorkspace(paseo, {
      title: DISPATCHER_TITLE,
      idempotencyKey: `flowly-dispatcher-workspace:${randomUUID()}`,
      path: this.workspacePath,
      background: true,
    });
    await this.save((r) => ({ ...r, workspaceId: id }));
    return id;
  }

  /**
   * Checks the folder before any use (reuse included) and makes it (§2): as given, then where its existing part really
   * leads (so a link creates nothing in the data folder), then again on real paths once it exists. The folder and its
   * parent end up mode 0700, also when they existed before.
   */
  private async prepareFolder() {
    const problem = dispatcherFolderProblem(this.workspacePath, this.directory);
    if (problem) throw this.folderRefused(problem);
    const data = await realpath(this.directory).catch(() => resolve(this.directory));
    const projected = await projectedPath(this.workspacePath);
    if (!projected) throw this.folderRefused("a link on its path points nowhere");
    const ahead = dispatcherFolderProblem(projected, data);
    if (ahead) throw this.folderRefused(ahead);
    await mkdir(this.workspacePath, { recursive: true, mode: 0o700 });
    const linked = dispatcherFolderProblem(await realpath(this.workspacePath), data);
    if (linked) throw this.folderRefused(linked);
    await chmod(dirname(this.workspacePath), 0o700);
    await chmod(this.workspacePath, 0o700);
  }
  private async inFolder(directory: string | undefined) {
    if (!directory) return false;
    const [own, other] = await Promise.all([realpath(this.workspacePath).catch(() => null), realpath(directory).catch(() => null)]);
    return !!own && own === other;
  }
  private folderRefused(problem: string) {
    logFailure("Flowly dispatcher folder refused:", new Error(problem), this.workspacePath);
    return new ToolError("START_FAILED", `The dispatcher folder can't be used: ${problem}.`);
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
    if (!this.disposed && this.held.size)
      logFailure("Flowly dispatcher held notes dropped on unload:", new Error("plugin unloaded"), `${this.held.size} notes`);
    this.held.clear();
    this.disposed = true;
  }

  /**
   * Sends the held notes only when the dispatcher is idle with no pending permission and the send cooldown has
   * passed. A send without `activeTurnBehavior` interrupts a running turn and answers a pending permission
   * (Paseo's daemon defaults it to "interrupt" with `clearPendingPermissions`), so both hold the notes instead.
   */
  private async flush(paseo: PaseoApi, afterTurnEnd: boolean) {
    if (afterTurnEnd) {
      this.chasing = true;
      this.chaseStep = 0;
    }
    if (this.disposed || !this.held.size) return this.stopChase();
    let agentId: string | null, agent: AgentSnapshot;
    try {
      agentId = (await this.record()).agentId;
      agent = agentId ? (await paseo.agents.ref(agentId).refresh())?.agent : null;
    } catch (e) {
      logFailure("Flowly dispatcher state unreadable; notes dropped:", e, `${this.held.size} notes`);
      this.held.clear();
      return this.stopChase();
    }
    // A start is under way (summary, store, create): hold; the start delivers when it ends.
    if (this.starting) return;
    const state = agentId ? dispatcherState(agent) : "none";
    if (state === "running" || (state === "idle" && agent?.pendingPermissions?.length)) {
      // The hook can fire before Paseo's snapshot leaves "running", and a later turn end may never come:
      // after a turn end, keep looking with a growing delay until the notes go out; without one (a batch that
      // arrived while the snapshot said running), look again slowly.
      this.recheck(paseo, this.chasing ? recheckDelays[Math.min(this.chaseStep++, recheckDelays.length - 1)] : RECHECK_MAX_MS);
      return;
    }
    if (state !== "idle" || !agentId) {
      // Only a dead dispatcher (or none) drops notes; the next one's board summary covers them.
      this.held.clear();
      return this.stopChase();
    }
    const wait = this.lastSent === null ? 0 : this.lastSent + SEND_COOLDOWN_MS - this.now();
    if (wait > 0) {
      this.recheck(paseo, wait);
      return;
    }
    const notes = [...this.held.values()];
    this.held.clear();
    this.stopChase();
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

  /** One pending re-check at a time: an earlier one wins, a later one is replaced by a sooner request. */
  private recheck(paseo: PaseoApi, ms: number) {
    if (this.disposed) return;
    const at = this.now() + ms;
    if (this.retryTimer && this.retryAt <= at) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.serial(() => this.flush(paseo, false)).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
    }, ms);
  }

  private stopChase() {
    this.chasing = false;
    this.chaseStep = 0;
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
      logFailure("Flowly dispatcher notes dropped: no Paseo connection yet:", new Error("no Paseo connection"), `${notes.length} notes`);
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
