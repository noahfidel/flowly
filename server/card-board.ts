import type { z } from "zod";
import type { boardSchema } from "../shared/model";

type Board = z.infer<typeof boardSchema>;
/** A fresh card view, never a replacement for the complete board cache. */
export function cardBoard(board: Board, input: { taskId: string; workspaceId: string }): Board {
  const task = board.tasks.find(t => t.id === input.taskId && t.workspaceId === input.workspaceId);
  if (!task || !board.projects.some(p => p.id === task.projectId))
    throw new Error("This session's linked card is unavailable. Refresh the session chip or open Flowly.");
  const links = board.links.filter(l => l.from === task.id || l.to === task.id);
  const ids = new Set([task.id, ...links.flatMap(l => [l.from, l.to])]);
  const tasks = board.tasks.filter(t => ids.has(t.id));
  const projects = new Set(tasks.map(t => t.projectId));
  const kept = board.projects.filter(p => projects.has(p.id));
  const groups = new Set(kept.map(p => p.groupId));
  return {
    ...board,
    tasks,
    projects: kept,
    groups: board.groups.filter(g => groups.has(g.id)),
    links,
    events: board.events.filter(e => e.taskId === task.id),
    ideas: board.ideas.filter(i => i.taskId === task.id),
    artifacts: board.artifacts.filter(a => a.taskId === task.id),
    workpads: board.workpads.filter(w => w.taskId === task.id),
    plans: board.plans.filter(p => p.taskId === task.id),
    attentionDismissals: board.attentionDismissals.filter(a => a.taskId === task.id),
  };
}
