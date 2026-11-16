import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { LocalDaemonUnavailable, openLocalDaemon } from "./local-daemon";
import { paseoHome } from "./service";
import { logFailure } from "./error-report";
import { slimTimeline, type TailPage, type TimelineCursor } from "../shared/session-tail";
import { providerSubagentStatuses, type ProviderSubagent, type ProviderSubagentStatus } from "../shared/subagents";

/** This Paseo has no provider subagent reads (older than 0.15.4): the chip shows native children only. */
export class ProviderSubagentsUnsupported extends Error {
  override name = "ProviderSubagentsUnsupported";
  constructor() {
    super("This Paseo version cannot show provider subagents.");
  }
}

type TimelineOptions = { direction: "tail" | "before" | "after"; cursor?: TimelineCursor; limit: number; timeout?: number };
type RawRow = { item?: unknown; timestamp?: unknown; seq?: unknown; seqStart?: unknown; seqEnd?: unknown };
type RawTimeline = {
  epoch: string;
  startCursor?: TimelineCursor | null;
  reset: boolean;
  staleCursor: boolean;
  gap?: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  rows: readonly RawRow[];
};

/** What the reads need from a daemon connection; `DaemonClient` satisfies it. */
export interface ProviderSubagentClient {
  readonly isConnected?: boolean;
  /** What the daemon announced on connect (`features`); the bundled client's methods exist on any daemon. */
  getLastServerInfoMessage(): { features?: Record<string, unknown> } | null;
  listProviderSubagents(parentAgentId: string, options?: { timeout?: number }): Promise<{ subagents: readonly unknown[] }>;
  fetchProviderSubagentTimeline(parentAgentId: string, subagentId: string, options: TimelineOptions): Promise<RawTimeline>;
  close(): Promise<void>;
}

const methods = ["listProviderSubagents", "fetchProviderSubagentTimeline"] as const;

/** COMPAT(sdk-local-daemon): the plugin SDK has neither read (SUBAGENTS-SPEC §9.1); the local connection does. */
async function connectLocal(): Promise<ProviderSubagentClient> {
  const client = await openLocalDaemon(paseoHome(), "flowly-provider-subagents", [], "");
  if (methods.some((m) => typeof client[m] !== "function")) {
    await client.close().catch(() => undefined);
    throw new ProviderSubagentsUnsupported();
  }
  return client as unknown as ProviderSubagentClient;
}

/** The daemon feature each read needs (SUBAGENTS-SPEC §9.1). */
type Feature = "providerSubagents" | "projectedSubagentTimeline";
/** An older daemon is not asked again for this long. */
export const UNSUPPORTED_MS = 5 * 60_000;

/** A call longer than this is given up (an older daemon may never answer an unknown request). */
const REQUEST_TIMEOUT_MS = 10_000;
export const IDLE_CLOSE_MS = 30_000;
/** At most this many descriptors per session; the newest are kept. */
const LIST_MAX = 500;

/** The daemon cannot serve the reads right now: not Flowly's failure, never reported. */
const unavailable = (e: unknown) =>
  e instanceof LocalDaemonUnavailable || e instanceof ProviderSubagentsUnsupported || (e instanceof Error && e.name === "DaemonConnectionError");
/** The daemon answered the request with an error (an older one does not know it): expected, never reported. */
const rpcError = (e: unknown): e is Error & { userMessage?: unknown } => e instanceof Error && e.name === "DaemonRpcError";
/** A daemon's own answer (`payload.error`), a request error or a request timeout: a plain message, expected. */
const plain = (e: unknown): e is Error => (e instanceof Error && e.constructor === Error) || rpcError(e);
/** The connection itself is gone; a request timeout leaves it usable for other calls. */
const connectionLost = (e: unknown) =>
  e instanceof LocalDaemonUnavailable ||
  (e instanceof Error && e.name === "DaemonConnectionError" && (e as { code?: unknown }).code !== "DAEMON_REQUEST_TIMEOUT");
const failureMessage = (e: unknown) =>
  rpcError(e) && typeof e.userMessage === "string" && e.userMessage ? e.userMessage : e instanceof Error ? e.message : String(e);

const text = (value: unknown, max: number) => (typeof value === "string" ? (value.length > max ? value.slice(0, max) : value) : null);

/** Only the fields SUBAGENTS-SPEC §9.1 names, strings capped; null for a descriptor that is not one. */
export function providerDescriptor(raw: unknown): ProviderSubagent | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const id = text(d.id, 200);
  const status = d.status as ProviderSubagentStatus;
  if (!id || !providerSubagentStatuses.includes(status)) return null;
  return {
    id,
    parentSubagentId: text(d.parentSubagentId, 200) || null,
    provider: text(d.provider, 100) ?? "",
    title: text(d.title, 200),
    description: text(d.description, 500),
    status,
    createdAt: text(d.createdAt, 64) ?? "",
    updatedAt: text(d.updatedAt, 64) ?? "",
    subtitle: text(d.subtitle, 300),
  };
}

/**
 * Provider subagents of a card session (SUBAGENTS-SPEC §9): the list and one subagent's
 * timeline, read-only over one reused local daemon connection, opened on first use and closed
 * after 30 s without a call and on plugin stop. The session must be in the card's workspace,
 * as for `sessions.tail`.
 */
export class ProviderSubagentService {
  private connection: Promise<ProviderSubagentClient> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = 0;
  private stopped = false;
  private readonly unsupportedUntil = new Map<Feature, number>();

  constructor(
    readonly store: BoardStore,
    private readonly connect: () => Promise<ProviderSubagentClient> = connectLocal,
    private readonly idleMs = IDLE_CLOSE_MS,
  ) {}

  async list(input: { taskId: string; agentId: string }, paseo: PaseoApi): Promise<{ subagents: ProviderSubagent[]; unavailable: boolean }> {
    await this.check(input, paseo);
    try {
      const response = await this.use("providerSubagents", (client) => client.listProviderSubagents(input.agentId, { timeout: REQUEST_TIMEOUT_MS }));
      const subagents = (response.subagents ?? [])
        .map(providerDescriptor)
        .filter((s): s is ProviderSubagent => !!s)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      return { subagents: subagents.slice(-LIST_MAX), unavailable: false };
    } catch (e) {
      // The chip then shows native children only; nothing extra on screen.
      if (!unavailable(e) && !plain(e)) logFailure("Flowly could not list provider subagents:", e);
      return { subagents: [], unavailable: true };
    }
  }

  async tail(
    input: { taskId: string; agentId: string; subagentId: string; limit: number; mode: "tail" | "before" | "after"; cursor?: TimelineCursor },
    paseo: PaseoApi,
  ): Promise<TailPage> {
    if (input.mode !== "tail" && !input.cursor) throw new Error("A cursor is required to page the timeline.");
    await this.check(input, paseo);
    let page: RawTimeline;
    try {
      page = await this.use("projectedSubagentTimeline", (client) =>
        client.fetchProviderSubagentTimeline(input.agentId, input.subagentId, {
          direction: input.mode,
          limit: input.limit,
          ...(input.mode !== "tail" && input.cursor ? { cursor: input.cursor } : {}),
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
    } catch (e) {
      if (e instanceof ProviderSubagentsUnsupported) throw new Error(e.message);
      if (unavailable(e)) throw new Error("Paseo could not be reached to read this subagent. Try again shortly.");
      if (!plain(e)) logFailure("Flowly could not read a provider subagent:", e);
      throw new Error(failureMessage(e));
    }
    // Rewritten, or rows were skipped: the client reads the tail again.
    if (page.reset || page.staleCursor || page.gap) return { entries: [], epoch: page.epoch, reset: true };
    const rows = page.rows.map((row) => ({
      ...row,
      seqStart: typeof row.seqStart === "number" ? row.seqStart : row.seq,
      seqEnd: typeof row.seqEnd === "number" ? row.seqEnd : row.seq,
    }));
    return {
      entries: slimTimeline(rows),
      epoch: page.epoch,
      startCursor: page.startCursor ?? null,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
    };
  }

  /** Closes the connection; later calls answer as if the daemon were unavailable. */
  async stop() {
    this.stopped = true;
    this.clearTimer();
    await this.drop();
  }

  /** The card must exist and the session must be in its workspace (same check as `sessions.tail`). */
  private async check(input: { taskId: string; agentId: string }, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!agent || agent.workspaceId !== task.workspaceId) throw new Error("Session is unavailable or belongs to a different workspace.");
  }

  private async use<T>(feature: Feature, call: (client: ProviderSubagentClient) => Promise<T>): Promise<T> {
    if ((this.unsupportedUntil.get(feature) ?? 0) > Date.now()) throw new ProviderSubagentsUnsupported();
    this.busy++;
    this.clearTimer();
    try {
      const client = await this.client().catch((e: unknown) => {
        if (e instanceof ProviderSubagentsUnsupported) this.unsupportedUntil.set(feature, Date.now() + UNSUPPORTED_MS);
        throw e;
      });
      // The bundled client has both methods whatever the daemon is; the daemon announces its own
      // features before `connect()` resolves (the connected state is set by that message).
      // Missing server info is treated as unsupported: the answer is remembered for 5 minutes.
      if (client.getLastServerInfoMessage()?.features?.[feature] !== true) {
        this.unsupportedUntil.set(feature, Date.now() + UNSUPPORTED_MS);
        throw new ProviderSubagentsUnsupported();
      }
      try {
        return await call(client);
      } catch (e) {
        // A lost connection is opened again by the next call; a timeout or a daemon's error
        // answer leaves it, and the calls in flight on it, alone.
        if (client.isConnected === false || connectionLost(e)) await this.drop(client);
        throw e;
      }
    } finally {
      this.busy--;
      if (!this.busy && this.connection && !this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.drop();
        }, this.idleMs);
        this.timer.unref?.();
      }
    }
  }

  private async client(): Promise<ProviderSubagentClient> {
    if (this.stopped) throw new LocalDaemonUnavailable("Flowly is stopping.");
    const current = this.connection;
    if (current) {
      const client = await current.catch(() => null);
      if (client && client.isConnected !== false) return client;
      if (this.connection === current) await this.drop(client ?? undefined);
      if (this.connection) return this.client();
    }
    // Concurrent first calls share one open; a failed open is not kept.
    const opening = this.connect();
    this.connection = opening;
    opening.catch(() => {
      if (this.connection === opening) this.connection = null;
    });
    return opening;
  }

  /** Forgets the connection (only `expected`, when given) and closes it. */
  private async drop(expected?: ProviderSubagentClient) {
    const current = this.connection;
    if (!current) {
      await expected?.close().catch(() => undefined);
      return;
    }
    const client = await current.catch(() => null);
    if (expected && client !== expected) {
      await expected.close().catch(() => undefined);
      return;
    }
    if (this.connection === current) this.connection = null;
    await client?.close().catch(() => undefined);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
