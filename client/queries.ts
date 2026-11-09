import { useEffect } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { PaseoAgent, PaseoApi, PaseoAgentUpdate } from "@getpaseo/client";
import * as rpc from "../shared/rpc";
import { isSummarizer } from "../shared/summary";
import { listAgents } from "./resources";
import type { BoardOverview } from "../shared/overview";
import { overviewKey, readOverviewDelta, type OverviewRead } from "./overview-query";

/**
 * Shared query definitions (PERFORMANCE-SPEC §3). Every reader of a key uses the
 * same fetcher, so the etag and live-update logic apply wherever the key is read.
 */

type Etagged<T> = { etag: string; value?: T };
type QueryState = ReturnType<QueryClient["getQueryState"]>;

/**
 * Remembers which value this reader stored under a key, so an unchanged daemon
 * response can keep the cached object (no re-render, no parse). The etag is only
 * sent while the cache still holds that value: any other write to the key
 * (setQueryData, another fetcher) bumps `dataUpdateCount` and forces a full read.
 */
export function createChangedReader() {
  const held = new Map<string, { etag: string; count: number }>();
  return async function readChanged<T>(
    client: Pick<QueryClient, "getQueryData" | "getQueryState">,
    key: QueryKey,
    fetch: (etag: string | undefined, why?: string) => Promise<Etagged<T>>,
  ): Promise<T> {
    const id = JSON.stringify(key);
    const state: QueryState = client.getQueryState(key);
    const current = client.getQueryData<T>(key);
    const mine = held.get(id);
    const valid = current !== undefined && !!mine && !!state && state.dataUpdateCount === mine.count;
    const response = await fetch(
      valid ? mine!.etag : undefined,
      valid ? undefined : current === undefined || !mine ? "first-read" : "cache-replaced",
    );
    // This result becomes the next data update of the key.
    const count = (client.getQueryState(key)?.dataUpdateCount ?? 0) + 1;
    if (response.value !== undefined) {
      held.set(id, { etag: response.etag, count });
      return response.value;
    }
    const latest = client.getQueryData<T>(key);
    if (latest === undefined || client.getQueryState(key)?.dataUpdateCount !== state?.dataUpdateCount) {
      // The cache changed while the request was in flight: read it in full.
      held.delete(id);
      const full = await fetch(undefined, "cache-changed-in-flight");
      held.set(id, { etag: full.etag, count: (client.getQueryState(key)?.dataUpdateCount ?? 0) + 1 });
      if (full.value === undefined) throw new Error("Missing value in a full read.");
      return full.value;
    }
    held.set(id, { etag: response.etag, count });
    return latest;
  };
}

const readChanged = createChangedReader();

export const boardKey = ["flowly", "board"] as const;
export const resourcesKey = ["flowly", "resources"] as const;
export const summariesKey = ["flowly", "summaries"] as const;
export const activityKey = ["flowly", "activity"] as const;

export function overviewQueryOptions(client: QueryClient, hostId: string, read: OverviewRead) {
  const key = overviewKey(hostId);
  return {
    queryKey: key,
    queryFn: () => readChanged(client, key, etag => readOverviewDelta(read, client.getQueryData<BoardOverview>(key), etag)),
    staleTime: 0,
  };
}

export function useOverviewQuery(hostId: string, options: { enabled: boolean; refetchInterval?: number }) {
  const read = useRpc(rpc.readOverviewChanged);
  const client = useQueryClient();
  return useQuery({ ...overviewQueryOptions(client, hostId, read), ...options });
}

export function useResourcesQuery(options: { refetchInterval?: number; enabled?: boolean } = {}) {
  const read = useRpc(rpc.readResourcesChanged);
  const client = useQueryClient();
  return useQuery({
    queryKey: resourcesKey,
    queryFn: () => readChanged(client, resourcesKey, (etag) => read(etag ? { etag } : {})),
    ...options,
  });
}

export function useSummariesQuery(enabled = true) {
  const read = useRpc(rpc.readSummariesChanged);
  const client = useQueryClient();
  return useQuery({
    queryKey: summariesKey,
    queryFn: () => readChanged(client, summariesKey, (etag) => read(etag ? { etag } : {})),
    enabled,
    refetchInterval: 5000,
    placeholderData: (previous) => previous,
  });
}

/**
 * Fields a running agent rewrites on every stream event (clock, turn handle,
 * usage counters) that no Flowly view reads live. An update that differs only
 * in these is dropped: it would re-render the board, drawer and session view
 * about twice a second for as long as any agent on the host runs (the phone's
 * JS thread cannot spare that). The 20 s reconcile still brings them current.
 */
const CHURN_KEYS = new Set(["updatedAt", "activeTurn", "lastUsage", "runtimeInfo"]);
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (Array.isArray(a) !== Array.isArray(b) || keys.length !== Object.keys(y).length) return false;
  return keys.every((k) => same(x[k], y[k]));
};
export function onlyChurned(before: PaseoAgent, after: PaseoAgent) {
  if (after.status !== "running" && after.status !== "initializing") return false;
  const a = before as unknown as Record<string, unknown>,
    b = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!CHURN_KEYS.has(key) && !same(a[key], b[key])) return false;
  return true;
}

/** Applies live agent updates to a list of live (non-archived, non-summarizer) agents. */
export function applyAgentUpdates(agents: readonly PaseoAgent[], updates: readonly PaseoAgentUpdate[]): PaseoAgent[] {
  let next: PaseoAgent[] | null = null;
  for (const update of updates) {
    const list: PaseoAgent[] = next ?? agents.slice();
    const id = update.kind === "upsert" ? update.agent.id : update.agentId;
    const index = list.findIndex((a) => a.id === id);
    if (update.kind === "remove" || update.agent.archivedAt || isSummarizer(update.agent as PaseoAgent)) {
      if (index >= 0) {
        list.splice(index, 1);
        next = list;
      }
      continue;
    }
    const agent = update.agent as PaseoAgent;
    // Updates can arrive out of order with a poll; never go back in time.
    if (index >= 0 && list[index].updatedAt > agent.updatedAt) continue;
    if (index >= 0 && onlyChurned(list[index], agent)) continue;
    next = list;
    if (index >= 0) list[index] = agent;
    else list.push(agent);
  }
  return next ?? (agents as PaseoAgent[]);
}

/** Poll intervals for the live agent list: reconcile slowly while the stream is up. */
export const AGENTS_STREAM_POLL_MS = 20_000;
export const AGENTS_FALLBACK_POLL_MS = 5_000;
const AGENT_BATCH_MS = 500;

type Stream = { refs: number; ready: boolean; stop(): void };
const streams = new WeakMap<object, Stream>();

/**
 * One filter-scoped agent update stream per Paseo connection, shared by every
 * mounted reader. A one-entry page keeps the bootstrap small; updates are not
 * paged. Released when the last reader unmounts.
 */
function openAgentStream(paseo: PaseoApi, client: QueryClient, onReady: () => void): Stream {
  let pending: PaseoAgentUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  let release: (() => Promise<void>) | null = null;
  const flush = () => {
    timer = null;
    const updates = pending;
    pending = [];
    client.setQueryData<PaseoAgent[]>(activityKey, (current) => (current ? applyAgentUpdates(current, updates) : current));
  };
  const stopListening = paseo.agents.subscribe((update) => {
    if (!alive) return;
    pending.push(update);
    if (!timer) timer = setTimeout(flush, AGENT_BATCH_MS);
  });
  const stream: Stream = {
    refs: 0,
    ready: false,
    stop() {
      alive = false;
      stopListening();
      if (timer) clearTimeout(timer);
      void release?.().catch(() => undefined);
    },
  };
  void paseo.agents
    .list({ filter: { includeArchived: false }, page: { limit: 1 }, subscribe: {} })
    .then((result) => {
      release = () => result.subscription.release();
      if (!alive) return void release().catch(() => undefined);
      stream.ready = true;
      onReady();
    })
    .catch(() => undefined);
  return stream;
}

/**
 * Live (non-archived) agents on this host, shared by board, drawer and sidebar.
 * The stream patches the cache; the full list reconciles every 20 s (5 s until
 * the stream is ready, or when it is unavailable).
 */
export function useLiveAgents<T = PaseoAgent[]>(
  options: {
    enabled?: boolean;
    stream?: boolean;
    refetchInterval?: number;
    retry?: number;
    /** Subscribe to part of the list: the component re-renders only when that part changes. */
    select?: (agents: PaseoAgent[]) => T;
    /**
     * false: read the shared cache (kept fresh by the stream and the board's
     * poll) without a timer of its own, and fetch only when nothing is cached.
     */
    poll?: boolean;
  } = {},
) {
  const paseo = usePaseo();
  const client = useQueryClient();
  const query = useQuery<PaseoAgent[], Error, T>({
    queryKey: activityKey,
    queryFn: () => listAgents(paseo),
    enabled: options.enabled,
    ...(options.select ? { select: options.select } : {}),
    refetchInterval: () =>
      options.poll === false
        ? false
        : (options.refetchInterval ??
          (options.stream !== false && streams.get(paseo)?.ready ? AGENTS_STREAM_POLL_MS : AGENTS_FALLBACK_POLL_MS)),
    ...(options.poll === false ? { staleTime: Infinity } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  });
  useEffect(() => {
    if (options.stream === false || options.enabled === false) return;
    let stream = streams.get(paseo);
    if (!stream) {
      stream = openAgentStream(paseo, client, () => void client.invalidateQueries({ queryKey: activityKey }));
      streams.set(paseo, stream);
    }
    stream.refs++;
    return () => {
      stream!.refs--;
      if (stream!.refs > 0) return;
      stream!.stop();
      if (streams.get(paseo) === stream) streams.delete(paseo);
    };
  }, [paseo, client, options.stream, options.enabled]);
  return query;
}

/** The client's IANA zone for day boundaries (PROJECT-INSIGHTS-SPEC §3). */
export const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

/**
 * Project Insights (INSIGHTS-REDESIGN-SPEC §7). Read only while the page is open; re-read
 * when the board changes (`revision`) and every few minutes (activity changes slowly).
 */
export function useInsightsQuery(projectId: string, revision: number, enabled: boolean) {
  const read = useRpc(rpc.projectInsights);
  const client = useQueryClient();
  const tz = localZone();
  const key = ["flowly", "insights", projectId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => readChanged(client, key, (etag) => read({ projectId, tz, ...(etag ? { etag } : {}) })),
    enabled,
    refetchInterval: enabled ? 300_000 : false,
    placeholderData: (previous) => previous,
  });
  const refetch = query.refetch;
  useEffect(() => {
    if (enabled) void refetch();
  }, [revision, enabled, refetch]);
  return query;
}

/** A day's digest; polls only while it is being generated. */
export function useDigestQuery(projectId: string, day: string | null, enabled: boolean) {
  const read = useRpc(rpc.projectDigest);
  const tz = localZone();
  return useQuery({
    queryKey: ["flowly", "digest", projectId, day || ""],
    queryFn: () => read({ projectId, tz, day: day! }),
    enabled: enabled && !!day,
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
}

/**
 * One day for the day summary card (INSIGHTS-REDESIGN-SPEC §2.2). `version` is the day's turn and
 * move count from the heatmap, so the day refreshes when the page's activity does and never polls
 * on its own; `tokens` also reads local provider logs, as a second query the card does not wait on.
 */
export function useDayQuery(projectId: string, day: string, version: string, tokens: boolean, enabled: boolean) {
  const read = useRpc(rpc.projectDay);
  const tz = localZone();
  return useQuery({
    queryKey: ["flowly", "insights-day", projectId, day, version, tokens],
    queryFn: () => read({ projectId, tz, day, ...(tokens ? { tokens } : {}) }),
    enabled,
    staleTime: Infinity,
  });
}

/** Tokens per finished card from local provider logs (INSIGHTS-REDESIGN-SPEC §2.5); separate so the page never waits on log parsing. */
export function useTokensQuery(projectId: string, enabled: boolean) {
  const read = useRpc(rpc.projectTokens);
  const client = useQueryClient();
  const tz = localZone();
  const key = ["flowly", "insights-tokens", projectId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => readChanged(client, key, (etag) => read({ projectId, tz, ...(etag ? { etag } : {}) })),
    enabled,
    refetchInterval: enabled ? 300_000 : false,
    placeholderData: (previous) => previous,
  });
}

/**
 * A project's workflow insights (WORKFLOW-INSIGHTS-SPEC §5.2): read while the
 * Insights page is open, every 10 s only while an analysis or backfill runs.
 * `poll: false` reads once (the board's tip fact) and never polls.
 */
export function useWorkflowInsightsQuery(projectId: string, enabled: boolean, poll = true) {
  const read = useRpc(rpc.workflowInsights);
  const client = useQueryClient();
  const key = ["flowly", "workflow-insights", projectId] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => readChanged(client, key, (etag) => read({ projectId, ...(etag ? { etag } : {}) })),
    enabled,
    staleTime: poll ? 0 : 5 * 60_000,
    refetchInterval: (q) => (poll && enabled && (q.state.data?.running || q.state.data?.backfilling) ? 10_000 : false),
    placeholderData: (previous) => previous,
  });
}

/** A project's memory (PROJECT-MEMORY-SPEC §5.1): read while the Memory page or a drawer's Memory section is shown. */
export const memoryKey = (projectId: string) => ["flowly", "memory", projectId] as const;
export function useMemoryQuery(projectId: string, enabled: boolean) {
  const read = useRpc(rpc.readMemory);
  const client = useQueryClient();
  const key = memoryKey(projectId);
  return useQuery({
    queryKey: key,
    queryFn: () => readChanged(client, key, (etag) => read({ projectId, ...(etag ? { etag } : {}) })),
    enabled: enabled && !!projectId,
    staleTime: 0,
    // Every 5 s while a finished-card review runs, else every 30 s.
    refetchInterval: (q) => (enabled ? (q.state.data?.running.length ? 5_000 : 30_000) : false),
    placeholderData: (previous) => previous,
  });
}
/** The dispatcher chat's items (DISPATCHER-SPEC §9.1): read only while the chat panel is visible. */
export const dispatcherItemsKey = ["flowly", "dispatcher", "items"] as const;
export function useDispatcherItemsQuery(enabled: boolean) {
  const read = useRpc(rpc.dispatcherItemsChanged);
  const client = useQueryClient();
  return useQuery({
    queryKey: dispatcherItemsKey,
    queryFn: () => readChanged(client, dispatcherItemsKey, (etag) => read(etag ? { etag } : {})),
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 4_000 : false,
    placeholderData: (previous) => previous,
  });
}
/**
 * The signals the dispatcher chat resolved (DISPATCHER-SPEC §9.4), so the board's bell leaves them out as the badge
 * does, with the chat closed and after a reload. An etag read: unchanged polls carry no list.
 */
export const asksResolvedKey = ["flowly", "asks-resolved"] as const;
export function useResolvedAsksQuery(enabled: boolean) {
  const read = useRpc(rpc.asksResolved);
  const client = useQueryClient();
  return useQuery({
    queryKey: asksResolvedKey,
    queryFn: () => readChanged(client, asksResolvedKey, (etag) => read(etag ? { etag } : {})),
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 5_000 : false,
    placeholderData: (previous) => previous,
  });
}
/** Candidates waiting per project, for the overview chip; read with the board, once a minute. */
export const memoryCountsKey = ["flowly", "memory-counts"] as const;
export function useMemoryCountsQuery(enabled: boolean) {
  const read = useRpc(rpc.memoryCounts);
  const client = useQueryClient();
  return useQuery({
    queryKey: memoryCountsKey,
    queryFn: () => readChanged(client, memoryCountsKey, (etag) => read(etag ? { etag } : {})),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    placeholderData: (previous) => previous,
  });
}
