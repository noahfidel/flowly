import type { z } from "zod";
import type { boardSchema, BoardEvent } from "../shared/model";
import { nextMovesAction } from "../shared/next-moves";

/**
 * Native chips need card identities and the latest suggestion/turn boundary, not
 * the board's history, workpads or descriptions. Never publish this projection
 * into the full board query or use it to authorize an action.
 */
export function chipBoard(board: z.infer<typeof boardSchema>): z.infer<typeof boardSchema> {
  const seen = new Set<string>();
  const events: BoardEvent[] = [];
  for (let i = board.events.length - 1; i >= 0; i--) {
    const event = board.events[i];
    if (!event.agentId || seen.has(event.agentId) || (event.action !== nextMovesAction && event.action !== "agent.turn_started")) continue;
    seen.add(event.agentId);
    const { note: _note, ...boundary } = event;
    events.push(boundary);
  }
  return {
    ...board,
    projects: board.projects.map((project) => ({ ...project, description: "" })),
    tasks: board.tasks.map((task) => ({ ...task, description: "" })),
    events: events.reverse(),
    ideas: board.ideas.filter((idea) => idea.status === "open"),
    links: [], artifacts: [], workpads: [], plans: [], attentionDismissals: [], hiddenPrs: [],
  };
}
