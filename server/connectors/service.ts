import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  connectionInput,
  externalTarget,
  externalTitle,
  familyOf,
  itemTypeOf,
  itemUrl,
  normalizeBaseUrl,
  parseKey,
  providerInfo,
  recognizeUrl,
  type Connection,
  type ConnectionInput,
  type ConnectorProvider,
  type ExternalRef,
  type ExternalSummary,
  type ItemType,
} from "../../shared/connectors";
import { ExternalError, storedConnection, type Fetch, type StoredConnection } from "./http";
import { adapterFor } from "./index";
import type { Fetched, ItemRef, SearchScope } from "./types";
import { logFailure } from "../error-report";

/**
 * External items as read-only card inputs (CONNECTORS-SPEC, EXTERNAL-TRACKER-SPEC).
 * The daemon is the only place that holds credentials or talks to the
 * services, and it only ever reads: every request goes through an adapter's
 * `ReadOnlyHttp`, which refuses anything outside a fixed list of read endpoints.
 */

const connectionsFile = z.object({ version: z.literal(1), connections: z.array(storedConnection) });

const publicConnection = ({ secret: _secret, email: _email, login: _login, ...c }: StoredConnection): Connection => c;

async function atomicWrite(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/**
 * Moves `<data>/tickets` (EXTERNAL-TRACKER-SPEC) to `<data>/connectors` once
 * (CONNECTORS-SPEC §3.2); the rename keeps every file's permissions. Runs at
 * plugin start, before anything reads the directory.
 */
export function migrateTicketDirectory(data: string) {
  const from = join(data, "tickets");
  const to = join(data, "connectors");
  if (!existsSync(from)) return;
  if (existsSync(to)) return void console.warn(`Flowly: both ${from} and ${to} exist; using ${to} and leaving the old one untouched.`);
  renameSync(from, to);
  if (existsSync(join(to, "ticket-reads.json"))) renameSync(join(to, "ticket-reads.json"), join(to, "external-reads.json"));
}

/** Connections with their credentials, in `<data>/connectors/connections.json` (0600, never sent to clients). */
export class ConnectionStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "connections.json");
  }
  private async load(): Promise<StoredConnection[]> {
    try {
      return connectionsFile.parse(JSON.parse(await readFile(this.path, "utf8"))).connections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Connections are invalid; preserved at ${this.path}.`);
    }
  }
  async all() {
    await this.tail;
    return this.load();
  }
  async get(id: string) {
    const found = (await this.all()).find((c) => c.id === id);
    if (!found) throw new ExternalError("EXTERNAL_INVALID", "This connection no longer exists.");
    return found;
  }
  /** Serialized read-modify-write; a corrupt file is preserved, never reset. */
  update<T>(change: (list: StoredConnection[]) => T): Promise<T> {
    const job = this.tail.then(async () => {
      const list = await this.load();
      const value = change(list);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await copyFile(this.path, `${this.path}.bak`);
        await chmod(`${this.path}.bak`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWrite(this.path, JSON.stringify({ version: 1, connections: list }, null, 2));
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

type CacheEntry = { provider: ConnectorProvider; summary: ExternalSummary; fingerprint: string; fetchedAt: number; full?: { data: unknown; at: number } };
const SUMMARY_TTL = 60_000;
const BADGE_TTL = 30 * 60_000;
const MAX_CACHE = 2000;

export type ExternalDetail = { summary: ExternalSummary; markdown: string; truncated: boolean; fingerprint: string; stale: boolean; fetchedAt: string };
export type Summaries = Map<string, { summary: ExternalSummary; fingerprint: string; stale: boolean }>;

/** The cache and summaries key of an item. */
export const refKey = (ref: Pick<ExternalRef, "connectionId" | "key" | "itemType">) => `${ref.connectionId}:${itemTypeOf(ref)}:${ref.key}`;

/** Connections, read-through cache and searches (CONNECTORS-SPEC §4). */
export class ConnectorService {
  readonly connections: ConnectionStore;
  private cache = new Map<string, CacheEntry>();
  private blockedUntil = new Map<string, number>();
  private loaded = false;
  /** Repositories of a project on a connection's host, for GitHub/GitLab searches (CONNECTORS-SPEC §4.3). */
  projectRepos: (projectId: string, connection: Pick<StoredConnection, "baseUrl">) => Promise<string[]> = async () => [];
  constructor(
    readonly directory: string,
    readonly fetchImpl: Fetch = fetch,
    readonly clock = () => Date.now(),
  ) {
    this.connections = new ConnectionStore(directory);
  }
  private get cachePath() {
    return join(this.directory, "cache.json");
  }

  private async loadCache() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.cachePath, "utf8")) as { version?: number; entries?: Record<string, Omit<CacheEntry, "full">> };
      // Version 1 (Jira only) used other keys; it is only a cache, so it is refetched.
      if (data.version !== 2) return;
      // Entries of connections removed meanwhile (or by an older build) are dropped.
      const live = new Set((await this.connections.all().catch(() => [])).map((c) => c.id));
      let dropped = false;
      for (const [k, v] of Object.entries(data.entries || {})) {
        if (!live.has(v.summary.connectionId)) dropped = true;
        else if (!this.cache.has(k)) this.cache.set(k, { provider: v.provider, summary: v.summary, fingerprint: v.fingerprint, fetchedAt: v.fetchedAt });
      }
      if (dropped) this.persist();
    } catch {
      // A missing or unreadable cache only means fetching again.
    }
  }
  private saving: Promise<unknown> = Promise.resolve();
  private persist() {
    this.saving = this.saving.then(async () => {
      const entries = [...this.cache.entries()].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_CACHE);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWrite(
        this.cachePath,
        JSON.stringify({ version: 2, entries: Object.fromEntries(entries.map(([k, v]) => [k, { provider: v.provider, summary: v.summary, fingerprint: v.fingerprint, fetchedAt: v.fetchedAt }])) }),
      );
    }).catch((e) => logFailure("Flowly connector cache not saved:", e));
  }

  /** Waits for pending cache writes (shutdown, tests). */
  async flush() {
    await this.saving;
  }

  async list(): Promise<Connection[]> {
    return (await this.connections.all()).map(publicConnection);
  }

  /**
   * The connection the input describes, checked with the service. An empty
   * secret or email on an existing connection keeps the stored one.
   */
  private async verify(raw: ConnectionInput): Promise<StoredConnection> {
    const input = connectionInput.parse(raw);
    const info = providerInfo[input.provider];
    const adapter = adapterFor(input.provider);
    // A fixed API (Linear) takes no address from the user; the account check reports the workspace address below.
    const baseUrl = normalizeBaseUrl(info.noAddress || (info.defaultBaseUrl && !input.baseUrl) ? info.defaultBaseUrl! : input.baseUrl);
    if (!baseUrl) throw new Error(`Enter the ${adapter.label} address, e.g. ${info.defaultBaseUrl || `https://${familyOf(input.provider)}.example.com`}.`);
    // Tokens never travel in clear text, except to this machine (local mirrors, tests).
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error(`Use an https address for ${adapter.label}; tokens are not sent over plain http.`);
    const previous = input.id ? await this.connections.get(input.id) : undefined;
    // A stored token only goes back to the address and service it was entered for. A fixed API has one address.
    const same = !!previous && previous.provider === input.provider && (!!info.noAddress || previous.baseUrl === baseUrl);
    const secret = input.secret || (same ? previous.secret : "");
    const email = input.email || (same ? previous.email : "");
    if (previous && !same && !input.secret) throw new Error("The address or type changed: enter the token again.");
    if (!secret) throw new Error(info.email ? "Enter an API token." : "Enter a personal access token.");
    if (info.email && !email) throw new Error("Enter the email of the Atlassian account the API token belongs to.");
    const candidate: StoredConnection = {
      id: previous?.id || randomUUID(),
      provider: input.provider,
      name: input.name || new URL(baseUrl).host,
      baseUrl,
      email: info.email ? email : "",
      secret,
      account: "",
      login: "",
      verifiedAt: "",
      authFailed: false,
    };
    const me = await adapter.verify(candidate, this.fetchImpl).catch((error) => {
      throw new Error(error instanceof ExternalError ? error.message : `Couldn't reach ${adapter.label}.`);
    });
    candidate.account = me.account;
    candidate.login = me.login;
    if (info.noAddress) {
      const workspace = me.baseUrl ? normalizeBaseUrl(me.baseUrl) : null;
      if (!workspace || new URL(workspace).host !== new URL(baseUrl).host) throw new Error(`${adapter.label} did not report a workspace address for this key.`);
      candidate.baseUrl = workspace;
      if (!input.name) candidate.name = workspace.replace(/^https?:\/\//, "");
    }
    candidate.verifiedAt = new Date(this.clock()).toISOString();
    return candidate;
  }

  /** Test connection: checks the address and token without saving anything. */
  async test(raw: ConnectionInput): Promise<{ account: string; baseUrl: string }> {
    const checked = await this.verify(raw);
    return { account: checked.account, baseUrl: checked.baseUrl };
  }

  /** Tests the credentials, then stores the connection. */
  async save(raw: ConnectionInput): Promise<Connection> {
    const candidate = await this.verify(raw);
    await this.connections.update((list) => {
      const index = list.findIndex((c) => c.id === candidate.id);
      if (index >= 0) list[index] = candidate;
      else list.push(candidate);
    });
    this.blockedUntil.delete(candidate.id);
    return publicConnection(candidate);
  }

  /**
   * The connection each external input reads through now (EXTERNAL-TRACKER-SPEC §2):
   * its own, or, once that one was removed, any connection to the same
   * service that recognizes its link, so adding it again brings the items back.
   * An item without a connection maps to null: it stays a plain link.
   */
  async locate(list: readonly { id: string; target: string; external?: ExternalRef }[]): Promise<Map<string, ExternalRef | null>> {
    const connections = await this.connections.all();
    const out = new Map<string, ExternalRef | null>();
    for (const a of list) {
      if (!a.external) continue;
      const ref = a.external;
      const own = connections.find((c) => c.id === ref.connectionId);
      const same =
        own ||
        connections.find((c) => {
          if (familyOf(c.provider) !== familyOf(ref.provider)) return false;
          const found = recognizeUrl(a.target, c);
          return !!found && "key" in found && found.key === ref.key;
        });
      out.set(a.id, same ? { ...ref, connectionId: same.id, provider: same.provider } : null);
    }
    return out;
  }

  async remove(id: string) {
    await this.connections.update((list) => {
      const index = list.findIndex((c) => c.id === id);
      if (index >= 0) list.splice(index, 1);
    });
    await this.loadCache();
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${id}:`)) this.cache.delete(key);
    // A removed service's titles and statuses don't stay on disk.
    this.persist();
    return { id };
  }

  /** Runs one request for a connection, honouring backoff and recording refused tokens. */
  private async call<T>(connectionId: string, run: (connection: StoredConnection) => Promise<T>): Promise<T> {
    const connection = await this.connections.get(connectionId);
    const label = adapterFor(connection.provider).label;
    if (connection.authFailed) throw new ExternalError("EXTERNAL_AUTH", `${label} refused the token. Update the connection in Flowly settings.`);
    const blocked = this.blockedUntil.get(connectionId) || 0;
    if (blocked > this.clock()) throw new ExternalError("EXTERNAL_UNAVAILABLE", `${label} asked Flowly to wait; try again shortly.`);
    try {
      return await run(connection);
    } catch (error) {
      if (error instanceof ExternalError && error.code === "EXTERNAL_AUTH")
        await this.connections
          .update((list) => {
            const c = list.find((x) => x.id === connectionId);
            if (c) c.authFailed = true;
          })
          .catch(() => undefined);
      if (error instanceof ExternalError && error.code === "EXTERNAL_UNAVAILABLE")
        this.blockedUntil.set(connectionId, this.clock() + Math.min(300, Math.max(error.retryAfter || 5, 5)) * 1000);
      throw error;
    }
  }

  private remember(connection: StoredConnection, fetched: Fetched) {
    const adapter = adapterFor(connection.provider);
    const summary = fetched.summary;
    const key = refKey(summary);
    const previous = this.cache.get(key);
    const now = this.clock();
    // Where `updated` misses some content (Confluence comments), a summary fetch can't vouch for the old fingerprint.
    const unchanged = adapter.updatedCoversContent !== false && previous && previous.summary.updated === summary.updated;
    const entry: CacheEntry = {
      provider: connection.provider,
      summary,
      // A summary-only fetch can't see content changes; keep the fingerprint while `updated` is unchanged.
      fingerprint: fetched.full !== undefined ? adapter.fingerprint(fetched.full) : unchanged ? previous.fingerprint : "",
      fetchedAt: now,
      ...(fetched.full !== undefined ? { full: { data: fetched.full, at: now } } : unchanged && previous.full ? { full: previous.full } : {}),
    };
    this.cache.set(key, entry);
    // A GitHub link through /issues/ can be a pull request: remember it under both.
    if (summary.itemType === "pull") this.cache.set(refKey({ connectionId: connection.id, itemType: "issue", key: summary.key }), entry);
    return entry;
  }

  /** Picker rows: recent when the query is empty, else by key, link, number or text. */
  async search(input: { connectionId: string; query: string; projectId?: string; all?: boolean }): Promise<{ results: ExternalSummary[] }> {
    await this.loadCache();
    const connection = await this.connections.get(input.connectionId);
    const family = familyOf(connection.provider);
    const scope: SearchScope = {
      repos: (family === "github" || family === "gitlab") && input.projectId ? await this.projectRepos(input.projectId, connection).catch(() => []) : [],
      all: !!input.all,
    };
    const found = await this.call(connection.id, (c) => adapterFor(c.provider).search(c, this.fetchImpl, input.query, scope));
    const results = found.map((f) => this.remember(connection, f).summary);
    this.persist();
    return { results };
  }

  /** The item a link or bare key names, checked with the service; null when it isn't one of a connection. */
  async recognize(target: string): Promise<{ external: ExternalRef; url: string; title: string } | null> {
    const connections = await this.connections.all();
    const match = externalTarget(target, connections);
    if (!match) return null;
    if ("space" in match) {
      const connection = connections.find((c) => c.id === match.connectionId)!;
      const lookup = adapterFor(connection.provider).lookup;
      if (!lookup) return null;
      const id = await this.call(connection.id, (c) => lookup(c, this.fetchImpl, match.space, match.title));
      return this.resolve(connection.id, id, "page");
    }
    const link = /^[a-z]+:\/\//i.test(target.trim());
    return this.resolve(match.connectionId, match.key, match.itemType).catch((error) => {
      // A bare "a/b#12" or "2024" may be a file path; only a link insists on being an item.
      if (!link && error instanceof ExternalError && (error.code === "EXTERNAL_NOT_FOUND" || error.code === "EXTERNAL_INVALID")) return null;
      throw error;
    });
  }

  /** Fetches the item (it must exist and be visible) and returns what an artifact stores. */
  async resolve(connectionId: string, rawKey: string, itemType?: ItemType): Promise<{ external: ExternalRef; url: string; title: string }> {
    await this.loadCache();
    const connection = await this.connections.get(connectionId);
    const parsed = parseKey(rawKey, connection.provider);
    if (!parsed) throw new ExternalError("EXTERNAL_INVALID", `"${rawKey}" is not a ${adapterFor(connection.provider).label} key.`);
    // GitHub keys don't say whether they are pull requests; the caller may know.
    const ref: ItemRef = { itemType: itemType && familyOf(connection.provider) === "github" ? itemType : parsed.itemType, key: parsed.key };
    const fetched = await this.call(connectionId, (c) => adapterFor(c.provider).get(c, this.fetchImpl, ref, false));
    const summary = this.remember(connection, fetched).summary;
    this.persist();
    return {
      external: { connectionId, provider: connection.provider, itemType: summary.itemType, key: summary.key, remoteId: summary.remoteId },
      url: summary.url || itemUrl(connection, summary.itemType, summary.key),
      title: externalTitle(summary.itemType, summary.key, summary.summary),
    };
  }

  /**
   * Current summaries (EXTERNAL-TRACKER-SPEC §3.3): reused for `maxAge`, else
   * batched per connection. Failures fall back to the cache, marked stale.
   */
  async summaries(refs: readonly ExternalRef[], maxAge = SUMMARY_TTL, fingerprints = true): Promise<Summaries> {
    await this.loadCache();
    const out: Summaries = new Map();
    const now = this.clock();
    const byConnection = new Map<string, ExternalRef[]>();
    for (const ref of refs) {
      const hit = this.cache.get(refKey(ref));
      if (hit && now - hit.fetchedAt < maxAge) out.set(refKey(ref), { summary: hit.summary, fingerprint: hit.fingerprint, stale: false });
      else byConnection.set(ref.connectionId, [...(byConnection.get(ref.connectionId) || []), ref]);
    }
    let fetched = false;
    for (const [connectionId, list] of byConnection) {
      const connection = await this.connections.get(connectionId).catch(() => null);
      let items: Fetched[] | null = null;
      if (connection)
        items = await this.call(connectionId, (c) =>
          adapterFor(c.provider).getMany(
            c,
            this.fetchImpl,
            list.map((r) => ({ itemType: itemTypeOf(r), key: r.key })),
          ),
        ).catch(() => null);
      if (items && connection) {
        fetched = true;
        for (const item of items) this.remember(connection, item);
      }
      for (const ref of list) {
        const hit = this.cache.get(refKey(ref));
        if (hit) out.set(refKey(ref), { summary: hit.summary, fingerprint: hit.fingerprint, stale: !items });
      }
    }
    // Content fingerprints need the full item; fetch it only where `updated` moved.
    for (const ref of fingerprints ? refs : []) {
      const k = refKey(ref);
      const hit = this.cache.get(k);
      if (!hit || hit.fingerprint || out.get(k)?.stale) continue;
      const detail = await this.detail(ref).catch(() => null);
      if (detail) out.set(k, { summary: detail.summary, fingerprint: detail.fingerprint, stale: detail.stale });
    }
    if (fetched) this.persist();
    return out;
  }

  /** Badge/sidebar summaries: cached up to 30 minutes. */
  badges(refs: readonly ExternalRef[], refresh = false) {
    return this.summaries(refs, refresh ? 0 : BADGE_TTL, false);
  }

  /** The full item; the cache answers for 60 s, and when the service can't be reached. */
  async detail(ref: Pick<ExternalRef, "connectionId" | "key" | "itemType">, refresh = false): Promise<ExternalDetail> {
    await this.loadCache();
    const k = refKey(ref);
    const hit = this.cache.get(k);
    const now = this.clock();
    if (!refresh && hit?.full && now - hit.full.at < SUMMARY_TTL) return this.render(hit, false);
    const connection = await this.connections.get(ref.connectionId);
    try {
      const item = { itemType: itemTypeOf(ref), key: ref.key };
      const fetched = await this.call(ref.connectionId, (c) => adapterFor(c.provider).get(c, this.fetchImpl, item, true));
      const entry = this.remember(connection, fetched);
      // A moved Jira issue answers under its new key; keep it reachable by the key the card stores.
      if (refKey(fetched.summary) !== k) this.cache.set(k, entry);
      this.persist();
      return this.render(entry, false);
    } catch (error) {
      if (hit?.full && error instanceof ExternalError && error.code === "EXTERNAL_UNAVAILABLE") return this.render(hit, true);
      throw error;
    }
  }

  private render(entry: CacheEntry, stale: boolean): ExternalDetail {
    const adapter = adapterFor(entry.provider);
    const { markdown, truncated } = adapter.markdown(entry.summary, entry.full!.data, adapter.readBytes);
    return { summary: entry.summary, markdown, truncated, fingerprint: entry.fingerprint, stale, fetchedAt: new Date(entry.full!.at).toISOString() };
  }

  /** Last known summary without any request (titles while offline). */
  async cached(ref: Pick<ExternalRef, "connectionId" | "key" | "itemType">) {
    await this.loadCache();
    return this.cache.get(refKey(ref))?.summary;
  }
}

/** Per-session content fingerprints last seen, for external `unread` (EXTERNAL-TRACKER-SPEC §4.1). */
export class ExternalReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "external-reads.json");
  }
  private async load(): Promise<Record<string, Record<string, string>>> {
    try {
      return z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return {};
    }
  }
  async seen(agentId: string) {
    await this.tail;
    return (await this.load())[agentId] || {};
  }
  mark(agentId: string, fingerprints: Record<string, string>) {
    const job = this.tail.then(async () => {
      const state = await this.load();
      state[agentId] = { ...(state[agentId] || {}), ...fingerprints };
      const agents = Object.keys(state);
      for (const old of agents.slice(0, Math.max(0, agents.length - 2000))) delete state[old];
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicWrite(this.path, JSON.stringify(state));
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}
