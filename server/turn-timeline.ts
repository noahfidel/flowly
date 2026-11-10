import type { PaseoApi } from "@getpaseo/client";
import { lastTurn } from "../shared/summary";
import { logFailure } from "./error-report";

/**
 * The items of the turn that just ended. The `agent.turn.after` hook's `timeline` is always empty
 * (deprecated), so the turn is the last one of the newest timeline page, as the manual summary refresh
 * reads it. The page is 200 entries, not 20: a turn with many tool calls must still reach its user message.
 * A failed read gives an empty turn.
 */
export async function turnTimeline<T extends { type: string }>(
  paseo: PaseoApi,
  agentId: string,
): Promise<readonly T[]> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200, projection: "projected" });
    return lastTurn(page.entries.flatMap((e) => (e.item ? [e.item as unknown as T] : [])));
  } catch (e) {
    logFailure("Flowly turn timeline not read:", e);
    return [];
  }
}
