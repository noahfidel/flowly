import type { Artifact } from "../shared/model";

/**
 * Card home quick links (DRAWER-SPEC "Quick links"): one row of chips under the card's header, so its PRs,
 * sessions and outputs are one click away without scrolling to Sessions or Artifacts. Pure rules only;
 * `QuickLinks` in `client/drawer.tsx` draws them. The sections below stay the full lists.
 */

/** Sessions and other outputs shown before a "+N more" chip. PRs are never limited. */
export const QUICK_LIMIT = 3;

export type PrState = "draft" | "open" | "merged" | "closed" | "";
export type QuickSessionState = "waiting" | "running" | "error" | "done";
/** A main, non-archived session of the card. `title` "" shows as "Session N". */
export type QuickSession = { id: string; title: string; createdAt: string; state: QuickSessionState };

export type QuickChip =
  | { kind: "pr"; id: string; url: string; number: string; state: PrState; title: string }
  | { kind: "session"; id: string; title: string; number: number; state: QuickSessionState }
  | { kind: "output"; id: string; title: string; file: boolean; artifact: Artifact }
  | { kind: "more"; section: "sessions" | "artifacts"; count: number };

// Plain links: github.com and gitlab.com only; self-hosted PRs are recognized through their connector ref.
const githubPull = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/pull\/(\d{1,9})(?:[/?#]|$)/i;
const gitlabMerge = /^https?:\/\/(?:www\.)?gitlab\.com\/.+?\/-\/merge_requests\/(\d{1,9})(?:[/?#]|$)/i;

/** "#42" for a GitHub pull request, "!7" for a GitLab merge request; null for anything else. */
export function prNumberOf(artifact: Pick<Artifact, "kind" | "target" | "external">): string | null {
  const ext = artifact.external;
  if (ext && (ext.itemType === "pull" || ext.itemType === "merge_request")) {
    const m = /([#!])(\d+)$/.exec(ext.key);
    if (m) return `${ext.itemType === "merge_request" ? "!" : "#"}${m[2]}`;
  }
  if (artifact.kind !== "url") return null;
  const pull = githubPull.exec(artifact.target);
  if (pull) return `#${pull[1]}`;
  const merge = gitlabMerge.exec(artifact.target);
  return merge ? `!${merge[1]}` : null;
}

/** The connector's status word (GitHub/GitLab summaries: Draft, Open, Merged, Closed) as a chip state. */
export function prStateOf(status: string | undefined): PrState {
  switch (status) {
    case "Draft":
      return "draft";
    case "Open":
      return "open";
    case "Merged":
      return "merged";
    case "Closed":
      return "closed";
    default:
      return "";
  }
}

/** From `sessionState` (client/session-state.ts) and whether the session has an open question report on the card. */
export function quickSessionState(state: { label: string; active: boolean; waiting?: boolean }, asks: boolean): QuickSessionState {
  if (state.waiting || asks) return "waiting";
  if (state.label === "Error") return "error";
  if (state.active) return "running";
  return "done";
}

const stateRank: Record<QuickSessionState, number> = { waiting: 0, running: 1, error: 2, done: 3 };

/** Sessions in chip order: waiting, running, error, done; newest first within each. */
export function orderQuickSessions(sessions: readonly QuickSession[]): QuickSession[] {
  return [...sessions].sort(
    (a, b) => stateRank[a.state] - stateRank[b.state] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

/** The card's active session: the first in the Quick links order (the board's card double click opens it), or null. */
export function activeQuickSession(sessions: readonly QuickSession[]): string | null {
  return orderQuickSessions(sessions)[0]?.id ?? null;
}

/**
 * The chips, in order: every PR output (newest first, one per URL), then up to QUICK_LIMIT sessions
 * (waiting, running, error, done; newest first within each) and "+N more", then up to QUICK_LIMIT other
 * outputs (newest first) and "+N more". `outputs` are the card's artifacts newest first; inputs and the
 * plan are skipped. `prStatus` maps an artifact id to its connector status. Empty when there is nothing.
 */
export function quickLinks({
  outputs,
  sessions,
  prStatus,
}: {
  outputs: readonly Artifact[];
  sessions: readonly QuickSession[];
  prStatus?: ReadonlyMap<string, string | undefined>;
}): QuickChip[] {
  const prs: QuickChip[] = [];
  const others: Artifact[] = [];
  const seen = new Set<string>();
  for (const a of outputs) {
    if (a.role !== "output" || a.plan) continue;
    const number = prNumberOf(a);
    if (!number) {
      others.push(a);
      continue;
    }
    const url = a.target.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    prs.push({ kind: "pr", id: a.id, url, number, state: prStateOf(prStatus?.get(a.id)), title: a.title });
  }
  // "Session N" by start order, as the user started them.
  const started = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const numberOf = new Map(started.map((s, i) => [s.id, i + 1]));
  const shown = orderQuickSessions(sessions);
  const chips: QuickChip[] = [...prs];
  for (const s of shown.slice(0, QUICK_LIMIT)) chips.push({ kind: "session", id: s.id, title: s.title, number: numberOf.get(s.id)!, state: s.state });
  if (shown.length > QUICK_LIMIT) chips.push({ kind: "more", section: "sessions", count: shown.length - QUICK_LIMIT });
  for (const a of others.slice(0, QUICK_LIMIT)) chips.push({ kind: "output", id: a.id, title: a.title, file: a.kind === "file", artifact: a });
  if (others.length > QUICK_LIMIT) chips.push({ kind: "more", section: "artifacts", count: others.length - QUICK_LIMIT });
  return chips;
}
