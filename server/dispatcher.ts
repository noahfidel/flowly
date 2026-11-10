import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  dispatcherCharter,
  dispatcherWithheldTools,
  dispatcherBuiltinTools,
  dispatcherGuardVersion,
  dispatcherProviderReason,
  dispatcherProviderSupported,
  dispatcherServerName,
  dispatcherToolNames,
  dispatcherStartInputSchema,
  dispatcherReplaceInputSchema,
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
import { dispatcherTarget } from "../shared/groups";
import type { Board, Group } from "../shared/model";
import { effectiveDispatcherModel, type AgentModel } from "../shared/agent-defaults";
import type { OutgoingImage } from "../shared/composer";
import { createDirectoryWorkspace } from "./background-workspace";
import { logFailure } from "./error-report";
import { EventBus, NoteBatcher, isStop } from "./event-bus";
import type { DispatcherIdentity } from "./tool-context";
import { ToolError } from "./tool-error";

/**
 * One dispatcher session per board group (DISPATCHER-SPEC §0): the shared record, workspace and start queue
 * (`Dispatcher`), and each group's note delivery (`GroupDispatcher`).
 */

export const DISPATCHER_TITLE = "Flowly dispatcher";
/** A group's dispatcher session title (§0): the workspace keeps `DISPATCHER_TITLE`. A rename shows at the next start. */
export const dispatcherSessionTitle = (group: { name: string }) => `${DISPATCHER_TITLE} · ${group.name.replace(/\s+/g, " ").trim()}`;
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

/** How many earlier dispatcher session ids a group's entry keeps; older ones move to the record's global list. */
export const previousAgentIdLimit = 20;
/** How many earlier dispatcher session ids the record's global list keeps (§0: overflow and deleted groups' ids). */
export const globalPreviousAgentIdLimit = 100;

const sessionId = z.string().min(1).max(300);
/** One group's dispatcher session and marks; also the v1 record's fields. */
const entryShape = {
  agentId: z.string().min(1).nullable(),
  startedAt: z.string().nullable(),
  /** The user's "Changed since you looked" mark, in event milliseconds (§9.2); absent in older files. */
  seenRevision: z.number().int().nonnegative().optional(),
  /** Ids of the seen events at exactly `seenRevision`, so later events in that millisecond still count. */
  seenIds: z.array(z.string().min(1).max(300)).max(seenIdLimit).optional(),
  /** The group's earlier dispatcher sessions, oldest first (their actions are not news either, §9.2). */
  previousAgentIds: z.array(sessionId).max(previousAgentIdLimit).optional(),
  /**
   * Its session was saved with the `flowly-dispatcher` server and these tools preapproved (§3); `true` (the first
   * saved sessions) stands for `firstSavedTools`; absent when the open hook adds the server.
   */
  savedTools: z.union([z.literal(true), z.array(z.string().min(1).max(100)).max(100)]).optional(),
  /** The guard its session was started with (§3): `dispatcherGuardVersion` and the provider part of its model; absent before. */
  guard: z.object({ version: z.number().int().nonnegative(), provider: z.string().min(1).max(100) }).optional(),
};
const entrySchema = z.strictObject(entryShape);
export type DispatcherEntry = z.infer<typeof entrySchema>;
/** The single-dispatcher record (v1); still read, never written again. */
const recordV1Schema = z.strictObject({ version: z.literal(1), workspaceId: z.string().min(1).nullable(), ...entryShape });
/** Record v2 (§0, §1): one workspace, one entry per board group. */
const recordSchema = z.strictObject({
  version: z.literal(2),
  workspaceId: z.string().min(1).nullable(),
  groups: z.record(z.string().min(1).max(200), entrySchema),
  /** Earlier sessions no group keeps: a group's overflow and a deleted group's ids, oldest first (§0). */
  previousAgentIds: z.array(sessionId).max(globalPreviousAgentIdLimit).optional(),
  /** The v1 session until a group exists to hold it (BOARD-GROUPS-SPEC §7 step 4). */
  unassigned: entrySchema.optional(),
});
export type DispatcherRecord = z.infer<typeof recordSchema>;
/** The tools a record marked `savedTools: true` was saved with. */
const firstSavedTools: readonly string[] = [
  "flowly_list_projects",
  "flowly_list_cards",
  "flowly_get_card",
  "flowly_create_card",
  "flowly_update_card",
  "flowly_start_card",
  "flowly_propose_idea",
  "flowly_link_cards",
];
type ToolMarks = Pick<DispatcherEntry, "savedTools" | "guard">;
/** Whether a live dispatcher's saved tools miss one this build lists: only a new session gets it (§3). */
export function missesTools(entry: ToolMarks) {
  const saved = entry.savedTools === true ? firstSavedTools : entry.savedTools;
  return !!saved && dispatcherToolNames.some((tool) => !saved.includes(tool));
}
/** Whether a dispatcher's session was started with this build's guard on a provider that keeps it (§3). */
export function guarded(entry: ToolMarks) {
  return entry.guard?.version === dispatcherGuardVersion && dispatcherProviderSupported(entry.guard.provider);
}

const emptyRecord = (): DispatcherRecord => ({ version: 2, workspaceId: null, groups: {} });

/** A v1 record as v2: its session waits in `unassigned` until the migration picks its group (BOARD-GROUPS-SPEC §7). */
function fromV1({ version: _, workspaceId, ...entry }: z.infer<typeof recordV1Schema>): DispatcherRecord {
  const kept = !!entry.agentId || !!entry.previousAgentIds?.length || entry.seenRevision !== undefined;
  return { version: 2, workspaceId, groups: {}, ...(kept ? { unassigned: entry } : {}) };
}

/** Appends `ids` to the global list (dropping earlier copies), keeping the newest `globalPreviousAgentIdLimit`. */
function appendGlobal(list: readonly string[] | undefined, ids: readonly string[]) {
  return [...(list ?? []).filter((id) => !ids.includes(id)), ...ids].slice(-globalPreviousAgentIdLimit);
}

/** Every dispatcher session id the record names: global, then each group's earlier and current ones (§0). */
export function recordAgentIds(record: DispatcherRecord): string[] {
  const ids = [...(record.previousAgentIds ?? [])];
  const add = (entry: DispatcherEntry | undefined) => {
    if (!entry) return;
    ids.push(...(entry.previousAgentIds ?? []));
    if (entry.agentId) ids.push(entry.agentId);
  };
  for (const entry of Object.values(record.groups)) add(entry);
  add(record.unassigned);
  return [...new Set(ids)];
}

/** The record with `groupId`'s entry gone; its session ids join the global list (§0: a deleted group's ids are kept). */
export function withoutGroup(record: DispatcherRecord, groupId: string): DispatcherRecord {
  const entry = record.groups[groupId];
  if (!entry) return record;
  const { [groupId]: _, ...groups } = record.groups;
  const ids = [...(entry.previousAgentIds ?? []), ...(entry.agentId ? [entry.agentId] : [])];
  return { ...record, groups, ...(ids.length ? { previousAgentIds: appendGlobal(record.previousAgentIds, ids) } : {}) };
}

/** The unassigned v1 session moved to `groupId` (BOARD-GROUPS-SPEC §7 step 4); every field travels with it. */
function assigned(record: DispatcherRecord, groupId: string): DispatcherRecord {
  const { unassigned, ...rest } = record;
  if (!unassigned) return record;
  const existing = rest.groups[groupId];
  // Never happens in practice (a group gets an entry only after the migration ran); its session id is kept anyway.
  const displaced = existing?.agentId && existing.agentId !== unassigned.agentId ? [existing.agentId] : [];
  return {
    ...rest,
    ...(displaced.length ? { previousAgentIds: appendGlobal(rest.previousAgentIds, displaced) } : {}),
    groups: { ...rest.groups, [groupId]: existing ? { ...existing, ...unassigned } : unassigned },
  };
}

export type DispatcherMcpServer = { type: "http"; url: string; headers: Record<string, string> };
export type DispatcherDeps = {
  /** The `flowly-dispatcher` MCP server entry for this session (the tool service, sealed credential). */
  mcp: (identity: DispatcherIdentity) => Promise<DispatcherMcpServer>;
  /** The first message: the group's projects with their ids, open cards and ideas (§6). */
  summary: (groupId: string) => Promise<string>;
  /** The board: its groups (each dispatcher's group, the v1 migration) and the projects' groups (note routing). */
  board: () => Promise<Pick<Board, "groups" | "projects" | "tasks">>;
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
 * The one test for a dead dispatcher (§3, ruling, Noah 2026-11-09): Paseo no longer returns it, or it is archived.
 * Every other status is the live one: `error`, and `closed` (Paseo stopped an idle process, or restarted; the next
 * message resumes it). Only a dead dispatcher is replaced.
 */
export function isDeadDispatcher(agent: AgentSnapshot): boolean {
  return !agent || !!agent.archivedAt;
}

/** The state of the stored dispatcher session as Flowly reads it (§3). */
export function dispatcherState(agent: AgentSnapshot): Exclude<DispatcherState, "none"> {
  if (isDeadDispatcher(agent)) return "ended";
  return agent?.status === "running" || agent?.status === "initializing" ? "running" : "idle";
}

const dispatcherRunning = () => new ToolError("DISPATCHER_RUNNING", "This group's dispatcher is already running. Open its chat instead of starting another.");
const groupNotFound = () => new ToolError("GROUP_NOT_FOUND", "No board group with that id.");

/** A group's dispatcher's first message (§0, §6): each live member project's id, then their open cards and ideas, without memory. */
export function dispatcherSummary(board: Board, groupId: string): string {
  const live = board.projects.filter((p) => !p.archivedAt && p.groupId === groupId);
  const projects = live.map((p) => `- ${p.id}: ${p.title.replace(/\s+/g, " ").trim()}`);
  return [
    `${summaryMessagePrefix} Pass the projectId to every tool.`,
    "",
    "Projects of this group (projectId: title):",
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

/** What a group's note delivery needs from the shared dispatcher. */
type GroupHub = {
  /** The group's stored entry (after the v1 migration); undefined when it has none. */
  entry(groupId: string): Promise<DispatcherEntry | undefined>;
  now(): number;
  /** The batch the group's session received (the chat's note rows, §9.1). */
  sent(groupId: string, agentId: string, notes: readonly DispatcherNote[], at: string): void;
};

/**
 * One group's note delivery (§7): notes held for its session, the send cooldown, the turn-end chase and the start
 * window. Created lazily by `Dispatcher`, disposed on unload (and, later, on the group's delete).
 */
class GroupDispatcher {
  /** Notes waiting for the dispatcher's turn to end, one per card (merged with `mergeNotes`). */
  readonly held = new Map<string, DispatcherNote>();
  /** When Flowly last sent this dispatcher notes; null before the first send. */
  private lastSent: number | null = null;
  /** The one pending re-check (send cooldown or turn-end retry) and when it fires. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  /** After a turn end, held notes are re-checked with a growing delay (`recheckDelays`) until they go out. */
  private chasing = false;
  private chaseStep = 0;
  /** The session id a start has stored but Paseo may not have created yet: notes for it are held, not dropped. */
  starting: string | null = null;
  private deliveries: Promise<unknown> = Promise.resolve();
  disposed = false;
  constructor(
    readonly groupId: string,
    private readonly hub: GroupHub,
  ) {}

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

  /** `agent.turn_ended` of this group's session: it sends what it held. */
  turnEnded(agentId: string, paseo: PaseoApi): Promise<void> {
    return this.serial(async () => {
      if (this.disposed || !this.held.size || agentId !== (await this.hub.entry(this.groupId))?.agentId) return;
      await this.flush(paseo, true);
    });
  }

  /** Delivers what is held, by the dispatcher's state now (a status read that sees idle, the end of a start). */
  kick(paseo: PaseoApi) {
    if (this.disposed) return;
    void this.serial(() => this.flush(paseo, false)).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
  }

  /** No more sends or re-checks; held notes are dropped and logged (§7). */
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
    let agentId: string | null, agent: AgentSnapshot, entry: DispatcherEntry | undefined;
    try {
      entry = await this.hub.entry(this.groupId);
      agentId = entry?.agentId ?? null;
      agent = agentId ? (await paseo.agents.ref(agentId).refresh())?.agent : null;
    } catch (e) {
      logFailure("Flowly dispatcher state unreadable; notes dropped:", e, `${this.held.size} notes`);
      this.held.clear();
      return this.stopChase();
    }
    // A start is under way (summary, store, create): hold; the start delivers when it ends.
    if (this.starting) return;
    const state = agentId ? dispatcherState(agent) : "none";
    // One started without this build's guard gets no notes, and is never woken: they stay held, and a fresh dispatcher's
    // board summary covers them (ruling, Noah 2026-11-09; §3).
    if ((state === "running" || state === "idle") && !guarded(entry ?? {})) return this.stopChase();
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
    const wait = this.lastSent === null ? 0 : this.lastSent + SEND_COOLDOWN_MS - this.hub.now();
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
      sentAt = this.lastSent = this.hub.now();
    } catch (e) {
      logFailure("Flowly dispatcher notes not sent:", e, `${notes.length} notes`);
      return;
    }
    try {
      this.hub.sent(this.groupId, agentId, notes, new Date(sentAt).toISOString());
    } catch (e) {
      logFailure("Flowly dispatcher chat notes not recorded:", e, `${notes.length} notes`);
    }
  }

  /** One pending re-check at a time: an earlier one wins, a later one is replaced by a sooner request. */
  private recheck(paseo: PaseoApi, ms: number) {
    if (this.disposed) return;
    const at = this.hub.now() + ms;
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

  private serial(job: () => Promise<void>) {
    const run = this.deliveries.then(job, job);
    this.deliveries = run.catch(() => undefined);
    return run;
  }
}

export class Dispatcher {
  private cached: DispatcherRecord | null = null;
  private loading: Promise<DispatcherRecord> | null = null;
  /** The file on disk is still v1: the next migration writes it as v2, even with no group to hold its session yet. */
  private legacyFile = false;
  private writes: Promise<unknown> = Promise.resolve();
  /** The one queue for starts and replaces of every group (§0), so the shared workspace is made once. */
  private starts: Promise<unknown> = Promise.resolve();
  private readonly perGroup = new Map<string, GroupDispatcher>();
  private disposed = false;
  /** The host's Dispatcher model setting (plan Q6); null falls back to `dispatcherDefaultModel`. Set by the plugin entry. */
  modelSetting: () => Promise<AgentModel | null> = async () => null;
  /** The notes of a batch a group's dispatcher received, and when (the chat's note rows, §9.1). Set by the plugin entry. */
  onSent: ((notes: readonly DispatcherNote[], at: string, to: { groupId: string; agentId: string }) => void) | null = null;
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

  /**
   * The stored record as v2; a v1 file reads with its session `unassigned` (not written until `migrate`). A corrupt file
   * is kept as `.invalid-<ms>` and read as empty (§1). Never reads the board, so a board write may call it.
   */
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

  /**
   * The v1 → v2 migration (BOARD-GROUPS-SPEC §7 step 4): the unassigned session moves to the group with the most open
   * cards (ties: the first group), every field with it; with no group yet it stays unassigned, and a v1 file is still
   * written as v2. Idempotent. The plugin entry runs it after the board's group migration and after a storage
   * restore; every lifecycle call runs it too (`resolvedRecord`), so a crash between the two writes is repaired.
   */
  async migrate(board?: Pick<Board, "groups" | "projects" | "tasks">): Promise<void> {
    const record = await this.record();
    if (!record.unassigned && !this.legacyFile) return;
    const target = record.unassigned ? dispatcherTarget(board ?? (await this.deps.board())) : null;
    if (!target && !this.legacyFile) return;
    await this.save((r) => (target && r.unassigned ? assigned(r, target) : r));
    this.legacyFile = false;
  }

  /** The record after the v1 migration where it can run now; a migration that fails is logged and the record read as it is. */
  async resolvedRecord(): Promise<DispatcherRecord> {
    const record = await this.record();
    if (!record.unassigned && !this.legacyFile) return record;
    await this.migrate().catch((e) => logFailure("Flowly dispatcher record not migrated:", e));
    return this.record();
  }

  /** The group whose stored session is `agentId` (§4), with its entry and the shared workspace; null for every other session. */
  async sessionOf(agentId: string): Promise<{ groupId: string; entry: DispatcherEntry; workspaceId: string | null } | null> {
    const record = await this.resolvedRecord();
    for (const [groupId, entry] of Object.entries(record.groups)) if (entry.agentId === agentId) return { groupId, entry, workspaceId: record.workspaceId };
    return null;
  }

  /** Whether `path` is the dispatcher's folder, which never becomes a Flowly project (§2). */
  async ownsRoot(path: string) {
    const [own, legacy, other] = await Promise.all([this.workspacePath, this.legacyWorkspacePath, path].map((p) => realpath(p).catch(() => null)));
    return !!other && (other === own || other === legacy);
  }
  /** Every dispatcher session id ever recorded, once the record is loaded (for the note batcher, which cannot wait; §0). */
  allAgentIds(): string[] {
    return this.cached ? recordAgentIds(this.cached) : [];
  }
  /** The recorded session ids that are no group's current session (§0). */
  pastIds(): string[] {
    const current = new Set(Object.values(this.cached?.groups ?? {}).flatMap((e) => (e.agentId ? [e.agentId] : [])));
    return this.allAgentIds().filter((id) => !current.has(id));
  }
  /** Whether `workspaceId` is the dispatcher's workspace; such a workspace is never bound to a card (§2). */
  async owns(workspaceId: string) {
    const { workspaceId: own } = await this.record();
    return !!own && own === workspaceId;
  }

  async status(paseo: PaseoApi, groupId: string): Promise<DispatcherStatus> {
    await this.boardGroup(groupId);
    const entry = (await this.resolvedRecord()).groups[groupId];
    const agentId = entry?.agentId;
    if (!entry || !agentId) return { state: "none", agentId: null };
    const found = await paseo.agents.ref(agentId).refresh();
    const state = dispatcherState(found?.agent);
    // Saved tools are fixed at create: say so when this build lists more, never restart it (§3).
    const live = state === "running" || state === "idle";
    const newTools = live && missesTools(entry);
    // Its tools are fixed at create too: one started without this build's guard keeps every route (§3).
    const unguarded = live && !guarded(entry);
    // A read that sees it idle is a chance to deliver what is held (§7).
    const group = this.perGroup.get(groupId);
    if (state === "idle" && group?.held.size && !this.disposed) group.kick(paseo);
    return { state, agentId, ...(newTools ? { newTools: true as const } : {}), ...(unguarded ? { unguarded: true as const } : {}) };
  }

  /** Starts a group's dispatcher session; one at a time for all groups, refused unless its stored one is dead (§0, §3). */
  start(paseo: PaseoApi, raw: { groupId: string; provider?: string; modeId?: string }): Promise<{ agentId: string }> {
    const input = dispatcherStartInputSchema.parse(raw);
    return this.queued(async () => {
      const group = await this.boardGroup(input.groupId);
      const model = await this.model(group, input);
      // Only a provider that can withhold the routes to a card's asks (ruling, Noah 2026-11-09; §3).
      if (!dispatcherProviderSupported(model.provider)) throw new ToolError("DISPATCHER_PROVIDER_UNSUPPORTED", dispatcherProviderReason);
      return this.run(paseo, group, model);
    });
  }

  /**
   * Replace dispatcher (§3, ruling Noah 2026-11-09): the user's confirmed click on a group's unguarded dispatcher, or
   * on one that misses this build's tools. Archives exactly that session (the group's stored one, by the id the user
   * saw), then starts a new guarded one as Start does. Refused for a guarded dispatcher with every tool, or when the
   * group's stored one is not the id given. With a group delete (later), the only ways Flowly archives a dispatcher.
   */
  replace(paseo: PaseoApi, raw: { groupId: string; agentId: string }): Promise<{ agentId: string }> {
    const { groupId, agentId } = dispatcherReplaceInputSchema.parse(raw);
    return this.queued(async () => {
      const group = await this.boardGroup(groupId);
      const entry = (await this.resolvedRecord()).groups[groupId];
      if (!entry?.agentId || entry.agentId !== agentId) throw new ToolError("DISPATCHER_CHANGED", "The dispatcher changed meanwhile; nothing was replaced.");
      // A guarded one is replaced only when it misses this build's tools (Ruling, Noah 2026-11-09).
      if (guarded(entry) && !missesTools(entry)) throw new ToolError("DISPATCHER_GUARDED", "This dispatcher has the current guard and tools; Flowly does not replace it.");
      const model = await this.model(group, {});
      if (!dispatcherProviderSupported(model.provider)) throw new ToolError("DISPATCHER_PROVIDER_UNSUPPORTED", dispatcherProviderReason);
      // Archived inside the start, after every step that can fail but the session create (§3).
      return this.run(paseo, group, model, agentId);
    });
  }

  private queued<T>(job: () => Promise<T>): Promise<T> {
    const run = this.starts.then(job);
    this.starts = run.catch(() => undefined);
    return run;
  }

  /** The board group `groupId`, else GROUP_NOT_FOUND (§0, §8). */
  private async boardGroup(groupId: string): Promise<Group> {
    const group = (await this.deps.board()).groups.find((g) => g.id === groupId);
    if (!group) throw groupNotFound();
    return group;
  }

  /** The passed `provider/model`, else the group's Dispatcher model, else the host setting, else the server default (§0, §3). */
  private async model(group: Group, input: { provider?: string; modeId?: string }): Promise<{ provider: string; modeId?: string; thinking?: string }> {
    if (input.provider) return { provider: input.provider, ...(input.modeId ? { modeId: input.modeId } : {}) };
    // The host setting is read only when the group has no model of its own.
    const host = group.defaults?.dispatcherModel
      ? null
      : await this.modelSetting().catch((e) => {
          logFailure("Flowly dispatcher model setting unreadable; using the default:", e);
          return null;
        });
    const model = effectiveDispatcherModel(group, host);
    const modeId = input.modeId ?? model.mode;
    return { provider: `${model.provider}/${model.model}`, ...(modeId ? { modeId } : {}), ...(model.thinking ? { thinking: model.thinking } : {}) };
  }

  /**
   * Starts a group's dispatcher; `replacing` is the unguarded session Replace archives (§3). The folder, workspace, MCP
   * server and board summary come first; then the old session is archived (a failed archive starts nothing), and only
   * then is the new session stored and created. A crash or failed save after the archive leaves the record naming the
   * archived session: ended, never a live session Flowly no longer tracks. A group deleted meanwhile gets nothing
   * stored, and a session made for it is archived.
   */
  private async run(paseo: PaseoApi, group: Group, input: { provider: string; modeId?: string; thinking?: string }, replacing?: string) {
    const groupId = group.id;
    const stored = await this.resolvedRecord();
    const current = stored.groups[groupId]?.agentId;
    // Only this group's session counts: another group's dead one never makes room here (§0).
    if (current && current !== replacing && !isDeadDispatcher((await paseo.agents.ref(current).refresh())?.agent)) throw dispatcherRunning();
    const workspaceId = await this.workspace(paseo, stored);
    const before = await this.record();
    const previous = before.groups[groupId];
    const agentId = randomUUID();
    const notes = this.groupState(groupId);
    // Held from before the board summary is taken: a note that arrives while it is written, or before the new id
    // is stored, waits for the new session instead of reaching (and being dropped for) the dead one (§7).
    notes.starting = agentId;
    // What is held now is on the board the summary reads; later notes are kept (one may repeat the summary).
    const covered = [...notes.held];
    try {
      const [mcp, summary] = await Promise.all([this.deps.mcp({ agentId, workspaceId, groupId }), this.deps.summary(groupId)]);
      if (replacing) await this.archiveReplaced(paseo, replacing);
      else if (previous?.agentId) await this.stillDead(paseo, previous.agentId);
      // A group deleted meanwhile gets no entry back (§0).
      if (!(await this.onBoard(groupId))) throw groupNotFound();
      const now = this.deps.now?.() ?? Date.now();
      // Stored first: the session's first tool calls already pass the caller check (§4).
      // Saved with its tools (§3); a record without the mark is a dispatcher from before, served by the open hook.
      await this.save((r) =>
        withSession(r, groupId, {
          agentId,
          startedAt: new Date(now).toISOString(),
          savedTools: [...dispatcherToolNames],
          guard: { version: dispatcherGuardVersion, provider: input.provider.split("/")[0] },
        }),
      );
      for (const [taskId, held] of covered) if (notes.held.get(taskId) === held) notes.held.delete(taskId);
      await this.create(paseo, { workspaceId, group, agentId, mcp, summary, input, previous, previousGlobal: before.previousAgentIds, replaced: !!replacing });
      await this.lateStart(paseo, groupId, agentId);
    } finally {
      notes.starting = null;
      // Notes held meanwhile go out by the dispatcher's state now (the new one, or the one a refused start kept).
      if (!this.disposed) notes.kick(paseo);
    }
    return { agentId };
  }

  /** Whether the board still has `groupId`. */
  private async onBoard(groupId: string) {
    return (await this.deps.board()).groups.some((g) => g.id === groupId);
  }

  /**
   * A start that finished after its group was deleted (§0): its entry is removed (the ids join the global list) and
   * the session just made is archived, as for a refused create. The group delete itself shares the start queue, so
   * this covers only a delete that bypassed it.
   */
  private async lateStart(paseo: PaseoApi, groupId: string, agentId: string) {
    if (await this.onBoard(groupId)) return;
    await this.save((r) => (r.groups[groupId]?.agentId === agentId ? withoutGroup(r, groupId) : r));
    await paseo.agents
      .ref(agentId)
      .archive()
      .catch((e) => logFailure("Flowly dispatcher of a deleted group not archived:", e, agentId));
    throw new ToolError("GROUP_NOT_FOUND", "The group was deleted while its dispatcher started; the new session was archived.");
  }

  /**
   * The stored dispatcher is being replaced: read it again just before; a session that came back meanwhile (restored
   * from the archive) refuses the start. A dead one is already archived or gone, so Flowly archives nothing.
   */
  private async stillDead(paseo: PaseoApi, agentId: string) {
    if (!isDeadDispatcher((await paseo.agents.ref(agentId).refresh())?.agent)) throw dispatcherRunning();
  }

  /** Replace's archive of exactly that session (unless already dead), before the record changes; a failure starts nothing. */
  private async archiveReplaced(paseo: PaseoApi, agentId: string) {
    const ref = paseo.agents.ref(agentId);
    try {
      if (!isDeadDispatcher((await ref.refresh())?.agent)) await ref.archive();
    } catch (e) {
      logFailure("Flowly dispatcher not archived for replace:", e, agentId);
      throw new ToolError("REPLACE_FAILED", `Paseo did not archive the dispatcher session: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Puts the group's earlier entry back (its session, marks and history) after a start that made no session. */
  private restore(groupId: string, workspaceId: string, previous: DispatcherEntry | undefined, previousGlobal: string[] | undefined) {
    return this.save((r) => {
      const { previousAgentIds: _, savedTools: __, guard: ___, agentId: ____, startedAt: _____, ...marks } = r.groups[groupId] ?? {};
      const back: DispatcherEntry = {
        ...marks,
        agentId: previous?.agentId ?? null,
        startedAt: previous?.startedAt ?? null,
        ...(previous?.savedTools ? { savedTools: previous.savedTools } : {}),
        ...(previous?.guard ? { guard: previous.guard } : {}),
        ...(previous?.previousAgentIds ? { previousAgentIds: previous.previousAgentIds } : {}),
      };
      const { [groupId]: ______, ...others } = r.groups;
      const empty = !back.agentId && !back.startedAt && Object.keys(back).length === 2;
      const { previousAgentIds: _______, ...rest } = r;
      return {
        ...rest,
        workspaceId,
        groups: empty ? others : { ...others, [groupId]: back },
        ...(previousGlobal ? { previousAgentIds: previousGlobal } : {}),
      };
    });
  }

  private async create(
    paseo: PaseoApi,
    { workspaceId, group, agentId, mcp, summary, input, previous, previousGlobal, replaced }: {
      workspaceId: string;
      group: Group;
      agentId: string;
      mcp: DispatcherMcpServer;
      summary: string;
      input: { provider: string; modeId?: string; thinking?: string };
      previous: DispatcherEntry | undefined;
      previousGlobal: string[] | undefined;
      /** Replace archived the earlier session already: it stays archived, and the user starts a new one (§3). */
      replaced: boolean;
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
          systemPrompt: dispatcherCharter(group),
          // No route to a card's ask (§3): Paseo's agent tools are withheld, and the built-in tools are an allowlist.
          // `--strict-mcp-config` (a null value is a bare flag) loads only the MCP servers Paseo passes (its own and its
          // plugins'), none from Claude Code's user, project, plugin or cloud configuration.
          // The SDK's `options` is the session's `providerOptions`, validated by Claude's provider schema.
          options: { disallowedTools: [...dispatcherWithheldTools], extraArgs: { tools: dispatcherBuiltinTools.join(","), "strict-mcp-config": null } },
          // Saved with the session and its card tools preapproved, so they never prompt (they are gated by the
          // "Agents create and edit cards" switch); Paseo checks each grant's server is in this same request (§3).
          // `dispatcherConfirmedToolNames` (flowly_create_project) are left out: the user confirms each call.
          mcpServers: { [dispatcherServerName]: mcp },
          toolPolicy: { preapproved: dispatcherToolNames.map((tool) => ({ kind: "mcp" as const, server: dispatcherServerName, tool })) },
        },
        title: dispatcherSessionTitle(group),
        labels: { "flowly-dispatcher": "1", "flowly-dispatcher-group": group.id },
        prompt: summary,
      });
    } catch (e) {
      const made = await paseo.agents
        .ref(agentId)
        .refresh()
        .then((found) => !!found?.agent)
        .catch(() => false);
      if (!made) {
        await this.restore(group.id, workspaceId, previous, previousGlobal);
        logFailure("Flowly dispatcher not started:", e, `workspace ${workspaceId}`);
        const reason = e instanceof Error ? e.message : String(e);
        throw new ToolError(
          "START_FAILED",
          replaced
            ? `Paseo did not start the new dispatcher: ${reason}. The old dispatcher was archived; start a new one.`
            : `Paseo did not start the dispatcher: ${reason}`,
        );
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

  /** A group's note delivery, made on first use. */
  private groupState(groupId: string): GroupDispatcher {
    let group = this.perGroup.get(groupId);
    if (!group) {
      group = new GroupDispatcher(groupId, {
        entry: async (id) => (await this.resolvedRecord()).groups[id],
        now: () => this.now(),
        sent: (id, agentId, notes, at) => this.onSent?.(notes, at, { groupId: id, agentId }),
      });
      if (this.disposed) group.disposed = true;
      this.perGroup.set(groupId, group);
    }
    return group;
  }

  /** Delivers a batch to a group's dispatcher by its state: idle → sent, running → held until its turn ends, down → dropped (§7). */
  deliver(groupId: string, notes: readonly DispatcherNote[], paseo: PaseoApi): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.groupState(groupId).deliver(notes, paseo);
  }

  /**
   * A batch from the note batcher: each note goes to the dispatcher of its project's group as the board has it now; a
   * note of a project no longer on the board is dropped.
   */
  async deliverNotes(notes: readonly DispatcherNote[], paseo: PaseoApi): Promise<void> {
    if (this.disposed) return;
    let board: Pick<Board, "projects">;
    try {
      board = await this.deps.board();
    } catch (e) {
      logFailure("Flowly dispatcher notes dropped: board unreadable:", e, `${notes.length} notes`);
      return;
    }
    const groupOf = new Map(board.projects.map((p) => [p.id, p.groupId]));
    const byGroup = new Map<string, DispatcherNote[]>();
    for (const note of notes) {
      const groupId = groupOf.get(note.projectId);
      if (groupId) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), note]);
    }
    await Promise.all([...byGroup].map(([groupId, list]) => this.deliver(groupId, list, paseo)));
  }

  /** `agent.turn_ended` of any session: a group's own dispatcher sends what it held. */
  async turnEnded(agentId: string, paseo: PaseoApi): Promise<void> {
    if (this.disposed || ![...this.perGroup.values()].some((g) => g.held.size)) return;
    const own = await this.sessionOf(agentId);
    if (own) await this.groupState(own.groupId).turnEnded(agentId, paseo);
  }

  /** Drops a group's note delivery (held notes logged), e.g. when the group is gone. */
  forgetGroup(groupId: string) {
    this.perGroup.get(groupId)?.dispose();
    this.perGroup.delete(groupId);
  }

  /** Plugin unload: no more sends or re-checks; held notes are dropped and logged (§7). */
  dispose() {
    for (const group of this.perGroup.values()) group.dispose();
    this.disposed = true;
  }

  /**
   * Mark seen (§9.2), for one group: the mark only moves forward and never past the daemon's clock. At the same
   * millisecond the event ids add up; a clamped mark keeps no ids (they belong to a later millisecond).
   */
  async markSeen(groupId: string, revision: number, ids: readonly string[] = []): Promise<number> {
    await this.boardGroup(groupId);
    // After the v1 migration, so a mark written now is not displaced by the migrated session's entry.
    await this.resolvedRecord();
    const now = this.now();
    const target = Math.min(revision, now);
    const marked = target === revision ? ids : [];
    let seen = 0;
    await this.save((r) => {
      const entry: DispatcherEntry = r.groups[groupId] ?? { agentId: null, startedAt: null };
      if (entry.seenRevision !== undefined && target < entry.seenRevision) {
        seen = entry.seenRevision;
        return r;
      }
      const kept = target === entry.seenRevision ? (entry.seenIds ?? []) : [];
      seen = target;
      return { ...r, groups: { ...r.groups, [groupId]: { ...entry, seenRevision: target, seenIds: [...new Set([...kept, ...marked])].slice(-seenIdLimit) } } };
    });
    return seen;
  }

  /** "What should I do?" (§9.2): only to a group's dispatcher that is up and guarded; always steered, as by the composer (`userSendOptions`). */
  async whatNext(paseo: PaseoApi, groupId: string, text: string, seen?: { revision: number; ids: readonly string[] }): Promise<void> {
    const agentId = await this.reachable(paseo, groupId);
    await paseo.agents.ref(agentId).send(text, userSendOptions);
    // The cards it asked about are seen, as Mark seen would mark them; only once the question was sent (ruling, §9.2).
    if (seen) await this.markSeen(groupId, seen.revision, seen.ids);
  }

  /** The user's message from the dispatcher chat (§9.3): only to a group's dispatcher that is up and guarded; always steered. */
  async send(paseo: PaseoApi, input: { groupId: string; text: string; images?: OutgoingImage[]; messageId: string }): Promise<{ sent: true }> {
    const agentId = await this.reachable(paseo, input.groupId);
    await paseo.agents.ref(agentId).send(input.text, { ...userSendOptions, ...(input.images?.length ? { images: input.images } : {}), messageId: input.messageId });
    return { sent: true };
  }

  /**
   * The session the user's messages may reach: up (running, idle or closed) and guarded. An unguarded one takes no
   * messages from the user until Replace (ruling, Noah 2026-11-09; §3); nothing is sent.
   */
  private async reachable(paseo: PaseoApi, groupId: string): Promise<string> {
    const { state, agentId, unguarded } = await this.status(paseo, groupId);
    if (!agentId || (state !== "running" && state !== "idle"))
      throw new ToolError("DISPATCHER_DOWN", "The dispatcher is not running. Start it first.");
    if (unguarded) throw new ToolError("DISPATCHER_UNGUARDED", "Replace the dispatcher to keep chatting; nothing was sent.");
    return agentId;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
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
      const raw: unknown = JSON.parse(text);
      const current = recordSchema.safeParse(raw);
      if (current.success) return current.data;
      const v1 = fromV1(recordV1Schema.parse(raw));
      this.legacyFile = true;
      return v1;
    } catch (e) {
      const kept = `${this.path}.invalid-${this.deps.now?.() ?? Date.now()}`;
      await rename(this.path, kept).catch((error) => logFailure("Flowly dispatcher record not preserved:", error));
      logFailure("Flowly dispatcher record is invalid; starting empty:", e, kept);
      return emptyRecord();
    }
  }

  /** Writes `change` of the latest record, so concurrent writes (start, Mark seen) never drop each other's fields. Always v2. */
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
      this.legacyFile = false;
    });
    this.writes = job.catch(() => undefined);
    return job;
  }
}

/**
 * The record with `groupId`'s new session stored (§3): its tool marks replaced, the replaced session's id added to the
 * group's earlier ones (at most `previousAgentIdLimit`; older ones move to the global list), the seen mark kept.
 */
function withSession(
  record: DispatcherRecord,
  groupId: string,
  session: Required<Pick<DispatcherEntry, "agentId" | "startedAt" | "savedTools" | "guard">>,
): DispatcherRecord {
  const prev = record.groups[groupId];
  const { savedTools: _, guard: __, previousAgentIds: ___, ...marks } = prev ?? { agentId: null, startedAt: null };
  const all = prev?.agentId ? [...(prev.previousAgentIds ?? []).filter((id) => id !== prev.agentId), prev.agentId] : (prev?.previousAgentIds ?? []);
  const overflow = all.slice(0, Math.max(0, all.length - previousAgentIdLimit));
  const earlier = all.slice(-previousAgentIdLimit);
  return {
    ...record,
    ...(overflow.length ? { previousAgentIds: appendGlobal(record.previousAgentIds, overflow) } : {}),
    groups: { ...record.groups, [groupId]: { ...marks, ...session, ...(earlier.length ? { previousAgentIds: earlier } : {}) } },
  };
}

/**
 * Bus → batcher → dispatchers (§7): only stops are batched, facts of any dispatcher session ever recorded are dropped
 * by the batcher, and each batch goes to the dispatchers of its cards' groups with the Paseo API the plugin last saw.
 * Returns the unload cleanup.
 */
export function wireDispatcher(bus: EventBus, dispatcher: Dispatcher, paseo: () => PaseoApi | undefined) {
  const batcher = new NoteBatcher({ ...noteBatching, exclude: () => dispatcher.allAgentIds() }, (notes) => {
    const api = paseo();
    if (!api) {
      logFailure("Flowly dispatcher notes dropped: no Paseo connection yet:", new Error("no Paseo connection"), `${notes.length} notes`);
      return;
    }
    void dispatcher.deliverNotes(notes, api).catch((e) => logFailure("Flowly dispatcher notes not delivered:", e));
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
