import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import { isSummarizer } from "../shared/summary";

export async function listAgents(
  paseo: PaseoApi,
  workspaceId?: string,
  includeArchived = !!workspaceId,
): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived, includeBackground: true },
      page: { limit: 200, cursor },
    });
    agents.push(
      ...page.entries
        .map((e) => e.agent)
        // Progress summarizers are plugin plumbing, not the card's sessions.
        .filter((a) => (!workspaceId || a.workspaceId === workspaceId) && !isSummarizer(a)),
    );
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}
