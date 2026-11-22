import { familyOf, type Connection, type ExternalRef } from "../shared/connectors";
import type { Artifact, Project, Task } from "../shared/model";
import { boardPrs, githubPrKey, prStateOf, type BoardPr, type PrState } from "../shared/pr-rows";
import { refKey, type Summaries } from "./connectors/service";
import { logFailure } from "./error-report";
import { runFile, type Run } from "./pr-review-archive";

/** The board's pull requests menu (PR-MENU-SPEC §3.2): the rows of the chosen projects, each with its last known state. */

/** What the list needs of the connector service; the badge cache answers for up to 30 minutes. */
export type PrMenuReads = {
  list(): Promise<Connection[]>;
  locate(list: readonly { id: string; target: string; external?: ExternalRef }[]): Promise<Map<string, ExternalRef | null>>;
  /** Cache only, no network; `expired` once older than the badge TTL. */
  cached(refs: readonly ExternalRef[]): Promise<Map<string, { summary: { status?: string }; expired: boolean }>>;
  badges(refs: readonly ExternalRef[]): Promise<Summaries>;
  /** The `gh` CLI fallback for github.com PRs no GitHub connection reads (§3.2); with `ghCache`. */
  gh?: (pr: { repo: string; number: number }) => Promise<PrState | null>;
  ghCache?: GhPrCache;
};

/** How long a `gh` answer is fresh, as long as the badge cache. */
export const ghPrTtlMs = 30 * 60_000;

/** Daemon-memory cache of `gh` PR states, keyed by lower-case `owner/repo#n`; lost on restart. */
export class GhPrCache {
  private readonly entries = new Map<string, { state: PrState; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  get(key: string): { state: PrState; expired: boolean } | undefined {
    const hit = this.entries.get(key.toLowerCase());
    return hit ? { state: hit.state, expired: this.now() - hit.at > ghPrTtlMs } : undefined;
  }
  set(key: string, state: PrState): void {
    this.entries.set(key.toLowerCase(), { state, at: this.now() });
  }
}

/** One PR through the GitHub CLI (`gh pr view`), with an argument array, never a shell. */
export function ghPrMenuState(run: Run = runFile): (pr: { repo: string; number: number }) => Promise<PrState | null> {
  return async (pr) => {
    const out = await run("gh", ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "state,isDraft,mergedAt"]);
    const parsed = JSON.parse(out) as { state?: unknown; isDraft?: unknown; mergedAt?: unknown };
    if (parsed.state === "MERGED" || (typeof parsed.mergedAt === "string" && parsed.mergedAt)) return "merged";
    if (parsed.state === "CLOSED") return "closed";
    if (parsed.state === "OPEN") return parsed.isDraft === true ? "draft" : "open";
    return null;
  };
}

const ghConcurrency = 4;

/** Runs `work` over `items`, at most `ghConcurrency` at a time. */
async function inParallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(ghConcurrency, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

export type PrMenuRow = BoardPr & { state: PrState };

/** At most this many PRs are fetched per read; GitHub answers one REST call per PR (§3.2). */
export const prFetchCap = 20;

/** The user's working github.com GitHub connection, as the PR-review archive check picks it (`connectorPrState`). */
function githubConnection(connections: readonly Connection[]) {
  return connections.find((c) => {
    if (familyOf(c.provider) !== "github" || c.authFailed) return false;
    try {
      return new URL(c.baseUrl).host.toLowerCase() === "github.com";
    } catch {
      return false;
    }
  });
}

/**
 * Rows of the live projects among `projectIds` (unknown and archived ones skipped). A connector-linked artifact reads
 * its own ref, a plain github.com URL or a PR review card's PR the user's GitHub connection; anything else has no state.
 * A stale cache entry still gives its word. Fresh cache entries answer without a call; of the rest, at most `prFetchCap` are
 * fetched (never-fetched PRs first, then expired ones), and the others keep their cached word or show none until a later
 * read. A failing connector read leaves every state empty; the rows still list.
 * A github.com PR that no working GitHub connection reads goes through `reads.gh` (the `gh` CLI) when given: answers are
 * cached 30 minutes in `reads.ghCache`, the fetches share the cap with the connector ones (connector first), hidden rows
 * read that cache only, and a failing `gh` caches nothing, logs once and leaves the connector states alone.
 */
export async function listPrs(
  board: { projects: readonly Project[]; tasks: readonly Task[]; artifacts: readonly Artifact[]; hiddenPrs?: readonly { taskId: string; url: string }[] },
  projectIds: readonly string[],
  reads: PrMenuReads,
  log: typeof logFailure = logFailure,
): Promise<{ rows: PrMenuRow[] }> {
  const wanted = new Set(projectIds);
  const live = board.projects.filter((p) => wanted.has(p.id) && !p.archivedAt).map((p) => p.id);
  const rows = boardPrs(board, live);
  if (!rows.length) return { rows: [] };
  const refs = new Map<number, ExternalRef>();
  const ghRows = new Map<number, string>();
  try {
    const byId = new Map(board.artifacts.map((a) => [a.id, a]));
    const linked = rows.flatMap((r) => {
      const a = r.artifactId ? byId.get(r.artifactId) : undefined;
      return a?.external ? [a] : [];
    });
    const located = linked.length ? await reads.locate(linked) : new Map<string, ExternalRef | null>();
    let github: Connection | undefined | null = null;
    for (const [i, r] of rows.entries()) {
      const own = r.artifactId ? located.get(r.artifactId) : undefined;
      if (own) {
        refs.set(i, own);
        continue;
      }
      const key = githubPrKey(r.url);
      if (!key) continue;
      if (github === null) github = githubConnection(await reads.list());
      if (github) refs.set(i, { connectionId: github.id, provider: github.provider, key, remoteId: "", itemType: "pull" });
      else if (reads.gh && reads.ghCache) ghRows.set(i, key);
    }
    const unique = [...new Map([...refs.values()].map((ref) => [refKey(ref), ref])).values()];
    const cached = unique.length ? await reads.cached(unique) : new Map<string, { summary: { status?: string }; expired: boolean }>();
    // Hidden PRs never use the fetch budget: they read the cache only, unless a visible row names the same PR (PR-MENU-SPEC D14).
    const visibleKeys = new Set([...refs].filter(([i]) => !rows[i].hidden).map(([, ref]) => refKey(ref)));
    const candidates = unique.filter((ref) => visibleKeys.has(refKey(ref)));
    const fetch = [...candidates.filter((ref) => !cached.has(refKey(ref))), ...candidates.filter((ref) => cached.get(refKey(ref))?.expired)].slice(0, prFetchCap);
    const found: Summaries = fetch.length ? await reads.badges(fetch) : new Map();
    const ghStates = await ghStatesOf(rows, ghRows, reads, prFetchCap - fetch.length, log);
    return {
      rows: rows.map((r, i) => {
        const ghKey = ghRows.get(i);
        if (ghKey) return { ...r, state: ghStates.get(ghKey.toLowerCase()) ?? "" };
        const ref = refs.get(i);
        const status = ref ? (found.get(refKey(ref)) ?? cached.get(refKey(ref)))?.summary.status : undefined;
        return { ...r, state: prStateOf(status) };
      }),
    };
  } catch (error) {
    log("Flowly pull request states failed:", error, `${rows.length} rows`);
    return { rows: rows.map((r) => ({ ...r, state: "" as const })) };
  }
}

/** The `gh` state of each gh row's PR, by lower-case key: the cache's word (fresh or expired), then fresh answers for up to `budget` PRs. */
async function ghStatesOf(
  rows: readonly PrMenuRow[] | readonly BoardPr[],
  ghRows: ReadonlyMap<number, string>,
  reads: PrMenuReads,
  budget: number,
  log: typeof logFailure,
): Promise<Map<string, PrState>> {
  const states = new Map<string, PrState>();
  const { gh, ghCache } = reads;
  if (!ghRows.size || !gh || !ghCache) return states;
  const visible = new Map<string, string>();
  const expired = new Set<string>();
  for (const [i, key] of ghRows) {
    const id = key.toLowerCase();
    const hit = ghCache.get(id);
    if (hit) {
      states.set(id, hit.state);
      if (hit.expired) expired.add(id);
    }
    if (!rows[i].hidden) visible.set(id, key);
  }
  const todo = [...visible].filter(([id]) => !states.has(id));
  const stale = [...visible].filter(([id]) => expired.has(id));
  const queue = [...todo, ...stale].slice(0, Math.max(0, budget));
  const failures: unknown[] = [];
  await inParallel(queue, async ([id, key]) => {
    const at = key.lastIndexOf("#");
    try {
      const state = await gh({ repo: key.slice(0, at), number: Number(key.slice(at + 1)) });
      if (state) {
        ghCache.set(id, state);
        states.set(id, state);
      }
    } catch (error) {
      failures.push(error);
    }
  });
  if (failures.length) log("Flowly gh pull request states failed:", failures[0], `${failures.length} PRs`);
  return states;
}
