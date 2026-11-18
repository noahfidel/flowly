import { linksOf } from "./links";
import type { Board, BoardEvent, Task } from "./model";

/** Relaying contract news to related cards (DISPATCHER-SPEC §5.8). Pure and runtime-neutral. */

/** A card agent starts the note of its report with this to mark contract news. */
export const contractMarker = "[contract]";
/** At most this many cards get one update's relay. */
export const relayTargetLimit = 10;
/** A target that was itself relayed to the source within this long is left out (echo guard). */
export const relayEchoMs = 30 * 60_000;
/** Relayed event ids remembered per group. */
export const relayedIdLimit = 500;
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

/** The live cards that hear about the source's contract news: `related` links only, each once, in link order. */
export function contractRelayTargets(input: {
  board: Pick<Board, "links" | "tasks">;
  sourceTaskId: string;
  liveWorkspaceIds: ReadonlySet<string>;
  recent: readonly { from: string; to: string; at: number }[];
  now: number;
}): Task[] {
  const { board, sourceTaskId, liveWorkspaceIds, recent, now } = input;
  const seen = new Set<string>([sourceTaskId]);
  const targets: Task[] = [];
  for (const view of linksOf(board, sourceTaskId)) {
    const other = view.other;
    if (view.relation !== "related" || !other || seen.has(other.id)) continue;
    seen.add(other.id);
    if (other.archivedAt || other.status === "done" || other.status === "cancelled") continue;
    if (!liveWorkspaceIds.has(other.workspaceId)) continue;
    if (recent.some((r) => r.from === other.id && r.to === sourceTaskId && r.at >= now - relayEchoMs)) continue;
    targets.push(other);
    if (targets.length >= relayTargetLimit) break;
  }
  return targets;
}

/** The line under a note that lists the cards to relay to. */
export function relayLine(targets: readonly Pick<Task, "title" | "id">[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return `  Relay contract news with flowly_message_card to: ${targets.map((t) => `"${oneLine(t.title)}" [${t.id}]`).join("; ")}`;
}
