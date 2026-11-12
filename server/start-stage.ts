import { startedStatus } from "../shared/lanes";
import type { BoardStore } from "./store";

/**
 * A started card leaves Backlog/Todo (DISPATCHER-SPEC §4.1): a card still in either moves to the project's active-work
 * lane; every other card stays. Returns the new status, or null when nothing moved.
 */
export async function moveStartedCard(store: BoardStore, taskId: string, now = new Date().toISOString()) {
  return store.transaction((board) => {
    const task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    const to = task && !task.archivedAt && project ? startedStatus(project, task.status) : null;
    if (!task || !to) return { value: null, changed: false };
    const from = task.status;
    task.status = to;
    task.revision++;
    task.updatedAt = now;
    store.event(board, { taskId: task.id, actor: "system", action: "status_changed", from, to, note: "Session started" });
    return { value: to, changed: true };
  });
}
