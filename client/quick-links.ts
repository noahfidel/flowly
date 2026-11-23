import type { Artifact } from "../shared/model";
import { prNumberOf, prStateOf, type PrState } from "../shared/pr-rows";

// PR recognition lives in shared/ so the daemon counts PRs by the same rule (PR-MENU-SPEC §3.1).
export { prNumberOf, prStateOf, type PrState };

/**
 * Card home quick links (DRAWER-SPEC "Quick links"): one row of chips under the card's header, so its PRs,
 * sessions and outputs are one click away without scrolling to Sessions or Artifacts. Pure rules only;
 * `QuickLinks` in `client/drawer.tsx` draws them. The sections below stay the full lists.
 */

/** Sessions and other outputs shown before a "+N more" chip. PRs are never limited. */
export const QUICK_LIMIT = 3;

export type QuickSessionState = "waiting" | "running" | "error" | "done";
/** A main, non-archived session of the card. `title` "" shows as "Session N". */
export type QuickSession = { id: string; title: string; createdAt: string; state: QuickSessionState };

export type QuickChip =
  | { kind: "linear"; id: string; key: string; url: string | null; title: string }
  | { kind: "pr"; id: string; url: string; number: string; state: PrState; title: string }
  | { kind: "session"; id: string; title: string; number: number; state: QuickSessionState }
  | { kind: "output"; id: string; title: string; file: boolean; artifact: Artifact }
  | { kind: "more"; section: "sessions" | "artifacts"; count: number };

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

/** The URL of the card's newest pull request (the first PR chip), or null. `outputs` as for quickLinks. */
export function newestPrUrl(outputs: readonly Artifact[]): string | null {
  const chip = quickLinks({ outputs, sessions: [] }).find((c) => c.kind === "pr");
  return chip?.kind === "pr" ? chip.url : null;
}

/** The stored target when it is an http(s) URL, else null (a chip never opens anything else). */
function httpUrlOf(target: string): string | null {
  const url = target.trim();
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The chips, in order: the card's Linear issue (`linear`, its first Linear issue input, never limited and not counted
 * in "+N more"; its chip has no URL when the stored target is not an http(s) URL), every PR output (newest first, one per URL), then up to QUICK_LIMIT sessions
 * (waiting, running, error, done; newest first within each) and "+N more", then up to QUICK_LIMIT other
 * outputs (newest first) and "+N more". `outputs` are the card's artifacts newest first; inputs and the
 * plan are skipped. `prStatus` maps an artifact id to its connector status. Empty when there is nothing.
 */
export function quickLinks({
  outputs,
  sessions,
  prStatus,
  linear,
}: {
  outputs: readonly Artifact[];
  sessions: readonly QuickSession[];
  prStatus?: ReadonlyMap<string, string | undefined>;
  linear?: Artifact;
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
  const chips: QuickChip[] = [];
  if (linear?.external) chips.push({ kind: "linear", id: linear.id, key: linear.external.key, url: httpUrlOf(linear.target), title: linear.title });
  chips.push(...prs);
  for (const s of shown.slice(0, QUICK_LIMIT)) chips.push({ kind: "session", id: s.id, title: s.title, number: numberOf.get(s.id)!, state: s.state });
  if (shown.length > QUICK_LIMIT) chips.push({ kind: "more", section: "sessions", count: shown.length - QUICK_LIMIT });
  for (const a of others.slice(0, QUICK_LIMIT)) chips.push({ kind: "output", id: a.id, title: a.title, file: a.kind === "file", artifact: a });
  if (others.length > QUICK_LIMIT) chips.push({ kind: "more", section: "artifacts", count: others.length - QUICK_LIMIT });
  return chips;
}
