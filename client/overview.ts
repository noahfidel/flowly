import type { Project, Task } from "../shared/model";
import { laneEnabled } from "../shared/lanes";
import type { AttentionItem } from "./attention";

type Agent = { workspaceId?: string | null; status: string; archivedAt?: string | null; activeTurn?: { startedAt?: string | null } | null };

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

/** One row of the running list (DISPATCHER-SPEC §9.2a): a card with a working session. */
export type RunningRow = {
  taskId: string;
  title: string;
  projectId: string;
  status: Task["status"];
  /** When its earliest working turn started; null when Paseo gave none. */
  since: string | null;
  /** The session finished while the list was open; the row stays (greyed) so the others do not move. */
  ended: boolean;
};

const isWorking = (a: Agent) => !a.archivedAt && !!a.workspaceId && (a.status === "running" || a.status === "initializing");

/** Cards (live, in the shown projects) with a working session, oldest run first, ties by id, so a start or stop moves no other row. */
export function runningRows(projects: readonly Pick<Project, "id">[], tasks: readonly Task[], agents: readonly Agent[]): RunningRow[] {
  const ids = new Set(projects.map((p) => p.id));
  const since = new Map<string, string | null>();
  for (const a of agents) {
    if (!isWorking(a)) continue;
    const at = a.activeTurn?.startedAt ?? null;
    const known = since.get(a.workspaceId!);
    since.set(a.workspaceId!, known === undefined ? at : known && at && known < at ? known : (at ?? known));
  }
  const seen = new Set<string>();
  const rows: RunningRow[] = [];
  for (const t of tasks) {
    if (t.archivedAt || !ids.has(t.projectId) || !since.has(t.workspaceId) || seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push({ taskId: t.id, title: t.title, projectId: t.projectId, status: t.status, since: since.get(t.workspaceId) ?? null, ended: false });
  }
  return rows.sort((a, b) => (a.since ?? "9") .localeCompare(b.since ?? "9") || a.taskId.localeCompare(b.taskId));
}

/**
 * The list while it is open: keeps the rows already shown in place, marks the ones that stopped as `ended` (they stay
 * until the list closes), and appends new ones at the end, so nothing jumps under the pointer.
 */
export function mergeRunning(shown: readonly RunningRow[], now: readonly RunningRow[]): RunningRow[] {
  const byId = new Map(now.map((r) => [r.taskId, r]));
  const kept = shown.map((r) => byId.get(r.taskId) ?? { ...r, ended: true });
  const have = new Set(shown.map((r) => r.taskId));
  return [...kept, ...now.filter((r) => !have.has(r.taskId))];
}
