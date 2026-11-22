import { familyOf, type Connection, type ExternalRef } from "../shared/connectors";
import type { Artifact, Project, Task } from "../shared/model";
import { boardPrs, githubPrKey, prStateOf, type BoardPr, type PrState } from "../shared/pr-rows";
import { refKey, type Summaries } from "./connectors/service";
import { logFailure } from "./error-report";

/** The board's pull requests menu (PR-MENU-SPEC §3.2): the rows of the chosen projects, each with its last known state. */

/** What the list needs of the connector service; the badge cache answers for up to 30 minutes. */
export type PrMenuReads = {
  list(): Promise<Connection[]>;
  locate(list: readonly { id: string; target: string; external?: ExternalRef }[]): Promise<Map<string, ExternalRef | null>>;
  /** Cache only, no network; `expired` once older than the badge TTL. */
  cached(refs: readonly ExternalRef[]): Promise<Map<string, { summary: { status?: string }; expired: boolean }>>;
  badges(refs: readonly ExternalRef[]): Promise<Summaries>;
};

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
    }
    const unique = [...new Map([...refs.values()].map((ref) => [refKey(ref), ref])).values()];
    const cached = unique.length ? await reads.cached(unique) : new Map<string, { summary: { status?: string }; expired: boolean }>();
    // Hidden PRs never use the fetch budget: they read the cache only, unless a visible row names the same PR (PR-MENU-SPEC D14).
    const visibleKeys = new Set([...refs].filter(([i]) => !rows[i].hidden).map(([, ref]) => refKey(ref)));
    const candidates = unique.filter((ref) => visibleKeys.has(refKey(ref)));
    const fetch = [...candidates.filter((ref) => !cached.has(refKey(ref))), ...candidates.filter((ref) => cached.get(refKey(ref))?.expired)].slice(0, prFetchCap);
    const found: Summaries = fetch.length ? await reads.badges(fetch) : new Map();
    return {
      rows: rows.map((r, i) => {
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
