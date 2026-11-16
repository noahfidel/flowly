import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { openLocalDaemon } from "./local-daemon";
import { paseoHome } from "./service";
import {
  nativeAttentionToken,
  type AttentionAgent,
  sessionReadStateSchema,
  manualUnreadToken,
  markSessionReadInput,
  markSessionUnreadInput,
  type MarkSessionReadInput,
  type MarkSessionUnreadInput,
  type SessionReadReceipt,
} from "../shared/session-attention";
import { logFailure } from "./error-report";

export class SessionReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "session-reads.json");
  }
  private async load() {
    try {
      return sessionReadStateSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1 as const, receipts: [] as SessionReadReceipt[] };
      throw new Error(
        `Session read data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`,
      );
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  /** Serialized read-modify-write with backup and atomic replacement. */
  private update<T>(
    operation: (state: { version: 1; receipts: SessionReadReceipt[] }) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      sessionReadStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), {
          mode: 0o600,
        });
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

  /**
   * Acknowledges the current attention (and clears a manual unread mark).
   * Returns null when there was nothing to record.
   */
  mark(
    input: MarkSessionReadInput,
    validate: () => Promise<{ workspaceId: string; token: string | null }>,
    /** Called once the new state is saved, only when the read changed it (the session was unread). */
    onChanged?: () => void,
  ): Promise<SessionReadReceipt | null> {
    const parsed = markSessionReadInput.parse(input);
    let recorded = false;
    return this.update(async (state) => {
      const current = await validate();
      const existing = state.receipts.find(
        (r) =>
          r.taskId === parsed.taskId &&
          r.agentId === parsed.agentId &&
          r.workspaceId === current.workspaceId,
      );
      if (!current.token) {
        // Nothing native to acknowledge: only a manual unread mark can be cleared.
        if (existing?.token !== manualUnreadToken) return { value: existing ?? null, changed: false };
        state.receipts = state.receipts.filter((r) => r !== existing);
        recorded = true;
        return { value: null, changed: true };
      }
      if (parsed.token && current.token !== parsed.token && parsed.token !== manualUnreadToken)
        throw new Error(
          "Session attention changed. Refresh before marking it as read.",
        );
      if (existing?.token === current.token) return { value: existing, changed: false };
      if (!existing && state.receipts.length >= 10000)
        throw new Error(
          "Session read-state capacity reached. Existing records were preserved.",
        );
      const receipt: SessionReadReceipt = {
        taskId: parsed.taskId,
        agentId: parsed.agentId,
        token: current.token,
        workspaceId: current.workspaceId,
        readAt: new Date().toISOString(),
      };
      state.receipts = state.receipts.filter((r) => r !== existing);
      state.receipts.push(receipt);
      recorded = true;
      return { value: receipt, changed: true };
    }).then((value) => {
      if (recorded) onChanged?.();
      return value;
    });
  }

  /** "Mark as unread": the session stays unread until it is read again. */
  markUnread(
    input: MarkSessionUnreadInput,
    validate: () => Promise<{ workspaceId: string }>,
  ): Promise<SessionReadReceipt> {
    const parsed = markSessionUnreadInput.parse(input);
    return this.update(async (state) => {
      const current = await validate();
      const existing = state.receipts.find(
        (r) => r.taskId === parsed.taskId && r.agentId === parsed.agentId && r.workspaceId === current.workspaceId,
      );
      if (existing?.token === manualUnreadToken) return { value: existing, changed: false };
      if (!existing && state.receipts.length >= 10000)
        throw new Error("Session read-state capacity reached. Existing records were preserved.");
      const mark: SessionReadReceipt = {
        ...parsed,
        workspaceId: current.workspaceId,
        token: manualUnreadToken,
        readAt: new Date().toISOString(),
      };
      state.receipts = state.receipts.filter((r) => r !== existing);
      state.receipts.push(mark);
      return { value: mark, changed: true };
    });
  }
}

/** One short-lived connection to Paseo's own (native) read state. */
export interface NativeAttentionConnection {
  /** Live (unarchived) sessions with their native attention fields. */
  agents(): Promise<AttentionAgent[]>;
  /** Clears Paseo's unread/attention flag, as reading the session in Paseo does. */
  clear(agentIds: string[]): Promise<void>;
  close(): Promise<void>;
}
export interface NativeAttention {
  connect(): Promise<NativeAttentionConnection>;
}

/**
 * COMPAT(sdk-local-daemon): `PaseoApi` cannot clear a session's attention in
 * @getpaseo/client 0.11.2; the daemon serves `clear_agent_attention`. Use a
 * short-lived local connection until the SDK exposes it (SESSION-ATTENTION-SPEC).
 */
export function daemonNativeAttention(home = paseoHome()): NativeAttention {
  return {
    async connect() {
      const client = await openLocalDaemon(
        home,
        "flowly-session-reads",
        ["clearAgentAttention", "fetchAgents"],
        "This Paseo version cannot sync read state.",
      );
      return {
        async agents() {
          const found: AttentionAgent[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.fetchAgents({ page: { limit: 200, cursor } });
            for (const { agent } of page.entries) found.push(agent as AttentionAgent);
            cursor = page.pageInfo.nextCursor ?? undefined;
          } while (cursor);
          return found;
        },
        clear: (ids) => client.clearAgentAttention(ids),
        close: () => client.close().catch(() => undefined),
      };
    },
  };
}

/**
 * Receipts whose token is still the session's current native attention: read in
 * Flowly, still unread in Paseo. Manual unread marks never clear anything.
 */
export function unsyncedReads(receipts: readonly SessionReadReceipt[], agents: readonly AttentionAgent[]) {
  const live = new Map(agents.filter((a) => !a.archivedAt).map((a) => [a.id, a]));
  const ids = new Set<string>();
  for (const r of receipts) {
    if (r.token === manualUnreadToken) continue;
    const agent = live.get(r.agentId);
    if (agent && agent.workspaceId === r.workspaceId && nativeAttentionToken(agent) === r.token) ids.add(agent.id);
  }
  return [...ids];
}

export class SessionReadService {
  constructor(
    readonly board: BoardStore,
    readonly reads: SessionReadStore,
    readonly native: NativeAttention | null = null,
  ) {}
  /**
   * Called after a read that changed state (the session was unread, or manually marked unread), with the card and its
   * project. A failure is logged and never fails the read.
   */
  onRead: ((taskId: string, projectId: string) => Promise<void>) | null = null;
  /** The task must be live and the session must belong to its workspace. */
  private async current(input: { taskId: string; agentId: string }, paseo: PaseoApi) {
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const project = board.projects.find((p) => p.id === task.projectId);
    if (!project) throw new Error("Project not found.");
    if (task.archivedAt || project.archivedAt)
      throw new Error("Archived task or project is read-only.");
    const [snapshot, workspace] = await Promise.all([
      paseo.agents.ref(input.agentId).refresh(),
      paseo.workspaces.ref(task.workspaceId).refresh(),
    ]);
    const actor = snapshot?.agent;
    if (!actor || actor.id !== input.agentId)
      throw new Error("Session is unavailable.");
    if (actor.workspaceId !== task.workspaceId)
      throw new Error("Session belongs to a different workspace.");
    if (actor.archivedAt) throw new Error("Archived session is read-only.");
    if (
      !workspace ||
      workspace.id !== task.workspaceId ||
      workspace.archivingAt
    )
      throw new Error("Workspace is unavailable.");
    return {
      workspaceId: task.workspaceId,
      token: nativeAttentionToken(actor),
    };
  }
  async mark(input: MarkSessionReadInput, paseo: PaseoApi) {
    let read = false;
    const receipt = await this.reads.mark(input, () => this.current(input, paseo), () => (read = true));
    if (read && this.onRead) {
      const board = await this.board.read();
      const projectId = board.tasks.find((t) => t.id === input.taskId)?.projectId;
      if (projectId) await this.onRead(input.taskId, projectId).catch((e) => logFailure("Flowly could not mark a read card seen:", e));
    }
    // The Flowly receipt is committed; Paseo's own unread flag follows. A failure
    // keeps the receipt and is retried by `syncNative`.
    if (receipt && receipt.token !== manualUnreadToken) await this.clearNative([receipt.agentId]);
    return receipt;
  }
  private async clearNative(agentIds: string[]) {
    if (!this.native || agentIds.length === 0) return true;
    let connection: NativeAttentionConnection | null = null;
    try {
      connection = await this.native.connect();
      await connection.clear(agentIds);
      return true;
    } catch (e) {
      logFailure("Flowly could not clear Paseo read state:", e);
      return false;
    } finally {
      await connection?.close();
    }
  }
  /** Clears Paseo's unread flag for every session Flowly already marked read. Returns the cleared count. */
  async syncNative(): Promise<number> {
    if (!this.native) return 0;
    const connection = await this.native.connect();
    try {
      const ids = unsyncedReads((await this.reads.read()).receipts, await connection.agents());
      if (ids.length) await connection.clear(ids);
      return ids.length;
    } finally {
      await connection.close();
    }
  }
  markUnread(input: MarkSessionUnreadInput, paseo: PaseoApi) {
    return this.reads.markUnread(input, () => this.current(input, paseo));
  }
}
