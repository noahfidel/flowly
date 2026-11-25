import { linksOf } from "./links";
import type { Board, BoardEvent, Task } from "./model";
import { membersOf } from "./umbrella";

/** Relaying contract news to related cards (DISPATCHER-SPEC §5.8). Pure and runtime-neutral. */

/** A card agent starts the note of its report with this to mark contract news. */
export const contractMarker = "[contract]";
/** At most this many cards get one update's relay (the umbrella member limit, UMBRELLA-SPEC §8). */
export const relayTargetLimit = 30;
/** A target that was itself relayed to the source within this long is left out (echo guard). */
export const relayEchoMs = 30 * 60_000;
/** Relayed event ids remembered per group, on the board (`Board.relayed`, UMBRELLA-SPEC §8). */
export const relayedIdLimit = 500;
/** A dispatcher's relay messages (`flowly_message_card` with a matching `relayOf`): their own hourly bucket (D21). */
export const relayLimits = { perHour: 60 } as const;
/** The dispatcher charter version that relays contract news. */
export const relayCharterVersion = 7;

const deliveries: readonly string[] = ["in_review", "committed", "integrated"];

/**
 * The text after the marker when the event is contract news, else null. Only an agent's (not the user's) result or
 * progress report, or a delivery with no report kind, counts; a question or blocker never does.
 */
export function contractNews(event: Pick<BoardEvent, "actor" | "action" | "to" | "reportKind" | "note">): string | null {
  if (event.actor === "human") return null;
  const { action, reportKind } = event;
  const report = (action === "progress_reported" || action === "status_changed") && (reportKind === "result" || reportKind === "progress");
  const delivery = action === "status_changed" && !reportKind && !!event.to && deliveries.includes(event.to);
  if (!report && !delivery) return null;
  const note = (event.note ?? "").trimStart();
  if (note.slice(0, contractMarker.length).toLowerCase() !== contractMarker) return null;
  return note.slice(contractMarker.length).trim();
}

/** The board events whose news is relayed to the source's umbrella siblings only, matched by action (UMBRELLA-SPEC §8, D12). */
export const umbrellaNewsActions: readonly string[] = ["umbrella_contract_accepted", "umbrella_ruling_added"];

/**
 * Umbrella news (an accepted contract change, a new ruling), whatever the actor: the event's own note, which the store
 * wrote as "contract r<rev> accepted: <reason>" or "ruling: <title>". Null for any other event.
 */
export function umbrellaNews(event: Pick<BoardEvent, "action" | "note">): string | null {
  if (!umbrellaNewsActions.includes(event.action)) return null;
  return (event.note ?? "").trim() || null;
}

/**
 * The live cards that hear about the source's news (§5.8, UMBRELLA-SPEC §8): its live siblings first (same open,
 * unarchived umbrella, by `order`, then title), then its `related` links in link order, each once, never the source.
 * Live = not archived, not Done/Cancelled, with a live session. `siblingsOnly` (umbrella news) skips the links. Past
 * `relayTargetLimit` the eligible rest is counted in `leftOut`.
 */
export function contractRelayTargets(input: {
  board: Pick<Board, "links" | "tasks" | "umbrellas">;
  sourceTaskId: string;
  liveWorkspaceIds: ReadonlySet<string>;
  recent: readonly { from: string; to: string; at: number }[];
  now: number;
  siblingsOnly?: boolean;
}): { targets: Task[]; leftOut: number } {
  const { board, sourceTaskId, liveWorkspaceIds, recent, now } = input;
  const seen = new Set<string>([sourceTaskId]);
  const targets: Task[] = [];
  let leftOut = 0;
  const consider = (other: Task) => {
    if (seen.has(other.id)) return;
    seen.add(other.id);
    if (other.archivedAt || other.status === "done" || other.status === "cancelled") return;
    if (!liveWorkspaceIds.has(other.workspaceId)) return;
    if (recent.some((r) => r.from === other.id && r.to === sourceTaskId && r.at >= now - relayEchoMs)) return;
    if (targets.length < relayTargetLimit) targets.push(other);
    else leftOut++;
  };
  const umbrellaId = board.tasks.find((t) => t.id === sourceTaskId)?.umbrella?.id;
  const umbrella = umbrellaId ? board.umbrellas.find((u) => u.id === umbrellaId) : undefined;
  if (umbrella && umbrella.status === "open" && !umbrella.archivedAt) membersOf(board, umbrella.id).forEach(consider);
  if (!input.siblingsOnly)
    for (const view of linksOf(board, sourceTaskId)) if (view.relation === "related" && view.other) consider(view.other);
  return { targets, leftOut };
}

/**
 * The relay memory after a sent batch (UMBRELLA-SPEC §8): `added` appended once per event id, at most `relayedIdLimit`
 * per group (oldest dropped), and the records of groups no longer on the board dropped.
 */
export function rememberRelays(relayed: readonly Board["relayed"][number][], added: readonly Board["relayed"][number][], groupIds: readonly string[]): Board["relayed"] {
  const groups = new Set(groupIds);
  const known = new Set(relayed.map((r) => `${r.groupId}\u001f${r.id}`));
  const all = [...relayed];
  for (const r of added) {
    const key = `${r.groupId}\u001f${r.id}`;
    if (known.has(key)) continue;
    known.add(key);
    all.push(r);
  }
  const kept = new Map<string, number>();
  const out: Board["relayed"] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i]!;
    if (!groups.has(r.groupId)) continue;
    const n = kept.get(r.groupId) ?? 0;
    if (n >= relayedIdLimit) continue;
    kept.set(r.groupId, n + 1);
    out.push(r);
  }
  return out.reverse();
}

/** The longest news text a relay line carries. */
export const relayTextLimit = 500;

/**
 * The line under a note that lists the cards to relay to and carries the news itself, so a later question or blocker
 * merged into the same note is never what gets relayed. It names the event to pass as `relayOf`, which puts each relay
 * message in the relay bucket (D21), and how many eligible cards were left out past `relayTargetLimit`.
 */
export function relayLine(targets: readonly Pick<Task, "title" | "id">[], news: string, leftOut = 0, label: "contract" | "umbrella" = "contract", eventId: string): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const text = oneLine(news);
  const cut = text.length > relayTextLimit ? `${text.slice(0, relayTextLimit - 1)}…` : text;
  const rest = leftOut > 0 ? ` (${leftOut} more left out)` : "";
  return `  Relay ${label} news with flowly_message_card to: ${targets.map((t) => `"${oneLine(t.title)}" [${t.id}]`).join("; ")}${rest}. Pass relayOf: "${eventId}". The news: "${cut}"`;
}
