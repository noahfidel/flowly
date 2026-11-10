import type { Project, Task } from "../shared/model";
import { laneEnabled } from "../shared/lanes";
import type { AttentionItem } from "./attention";

type Agent = { workspaceId?: string | null; status: string; archivedAt?: string | null };

/**
 * One project's at-a-glance state for the board header. Counts live cards
 * (archived excluded), independent of search/priority filters.
 */
export function boardOverview(
  project: Pick<Project, "id" | "lanes"> | null | undefined,
  tasks: readonly Task[],
  agents: readonly Agent[],
  attention: readonly AttentionItem[],
) {
  const live = tasks.filter((t) => !t.archivedAt && t.projectId === project?.id);
  const workspaces = new Set(live.map((t) => t.workspaceId));
  const running = agents.filter(
    (a) => !a.archivedAt && !!a.workspaceId && workspaces.has(a.workspaceId) && (a.status === "running" || a.status === "initializing"),
  );
  const mine = attention.filter((i) => i.project.id === project?.id && !i.task.archivedAt);
  const lane = (status: Task["status"]) =>
    laneEnabled(project, status) ? live.filter((t) => t.status === status).length : null;
  return {
    total: live.length,
    done: lane("done"),
    /** Cards with at least one session working, and the number of such sessions. */
    runningTasks: new Set(running.map((a) => a.workspaceId)).size,
    runningSessions: running.length,
    /** Cards waiting on you: an open agent question or a permission request. */
    needsYou: mine.filter((i) => i.questions || i.permissions).length,
    unread: mine.filter((i) => i.unread && !i.questions && !i.permissions).length,
    errors: mine.filter((i) => i.errors).length,
  };
}
export type BoardOverview = ReturnType<typeof boardOverview>;
