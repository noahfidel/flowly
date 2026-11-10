import type { Project, Task } from "../shared/model";
import { laneEnabled } from "../shared/lanes";
import type { AttentionItem } from "./attention";

type Agent = { workspaceId?: string | null; status: string; archivedAt?: string | null };

/**
 * The board's at-a-glance state for its header, over the projects it shows (a group board unfiltered: every live
 * member; filtered: that project; BOARD-GROUPS-SPEC §4). Counts live cards (archived excluded), independent of
 * search/priority filters. `done` counts the projects whose Done lane is on; null when none has it.
 */
export function boardOverview(
  projects: readonly Pick<Project, "id" | "lanes">[],
  tasks: readonly Task[],
  agents: readonly Agent[],
  attention: readonly AttentionItem[],
) {
  const ids = new Set(projects.map((p) => p.id));
  const live = tasks.filter((t) => !t.archivedAt && ids.has(t.projectId));
  const workspaces = new Set(live.map((t) => t.workspaceId));
  const running = agents.filter(
    (a) => !a.archivedAt && !!a.workspaceId && workspaces.has(a.workspaceId) && (a.status === "running" || a.status === "initializing"),
  );
  const mine = attention.filter((i) => ids.has(i.project.id) && !i.task.archivedAt);
  const doneIn = new Set(projects.filter((p) => laneEnabled(p, "done")).map((p) => p.id));
  return {
    total: live.length,
    done: doneIn.size ? live.filter((t) => t.status === "done" && doneIn.has(t.projectId)).length : null,
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

/**
 * Which chips and dividers the overview row shows (UI-REFRESH-SPEC §7u; Ruling, Noah 2026-11-09): the running chip
 * only while a card runs, one "N need you" chip for every open ask, and "N updated" for the cards that changed since
 * you looked (never part of need-you). A divider follows the count only when something follows, and sits between the
 * status chips and Ideas / Memory / Insights only when both show.
 */
export function overviewRow(
  o: { runningTasks: number; needYou: number; updated: number },
  tools: { ideas: boolean; memory: boolean; insights: boolean },
): { running: boolean; needYou: boolean; updated: boolean; statusDivider: boolean; toolsDivider: boolean } {
  const running = o.runningTasks > 0;
  const needYou = o.needYou > 0;
  const updated = o.updated > 0;
  const status = running || needYou || updated;
  const anyTool = tools.ideas || tools.memory || tools.insights;
  return { running, needYou, updated, statusDivider: status || anyTool, toolsDivider: status && anyTool };
}
