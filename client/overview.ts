import type { Project, Task } from "../shared/model";
import { laneEnabled } from "../shared/lanes";
import type { AttentionItem } from "./attention";
import { cardActivities, type ProviderRunning, type RunningAgent } from "../shared/card-running";

type Agent = RunningAgent;

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
  provider?: ProviderRunning,
) {
  const ids = new Set(projects.map((p) => p.id));
  const live = tasks.filter((t) => !t.archivedAt && ids.has(t.projectId));
  const workspaces = new Set(live.map((t) => t.workspaceId));
  // A card runs while a session or one of its subagents runs (SUBAGENTS-SPEC §10).
  const activity = [...cardActivities(workspaces, agents, provider).values()];
  const mine = attention.filter((i) => ids.has(i.project.id) && !i.task.archivedAt);
  const doneIn = new Set(projects.filter((p) => laneEnabled(p, "done")).map((p) => p.id));
  return {
    total: live.length,
    done: doneIn.size ? live.filter((t) => t.status === "done" && doneIn.has(t.projectId)).length : null,
    /** Cards with a session or a subagent working (SUBAGENTS-SPEC §10), and the number of working sessions. */
    runningTasks: activity.filter((a) => a.running).length,
    runningSessions: activity.reduce((n, a) => n + a.sessions + a.starting, 0),
    /** Cards waiting on you: an open agent question or a permission request. */
    needsYou: mine.filter((i) => i.questions || i.permissions).length,
    unread: mine.filter((i) => i.unread && !i.questions && !i.permissions).length,
    errors: mine.filter((i) => i.errors).length,
  };
}
export type BoardOverview = ReturnType<typeof boardOverview>;

/**
 * Which chips and dividers the overview row shows (UI-REFRESH-SPEC §7u; Ruling, Noah 2026-11-09): the running chip
 * only while a card runs, one "N need you" chip for every open ask, and "N unread" for the cards with an unread turn
 * (never part of need-you). A divider follows the count only when something follows, and sits between the
 * status chips and Ideas / Memory / Insights only when both show.
 */
export function overviewRow(
  o: { runningTasks: number; needYou: number; updated: number; prs?: number; prsHidden?: number },
  tools: { ideas: boolean; memory: boolean; insights: boolean },
): { running: boolean; needYou: boolean; updated: boolean; prs?: boolean; statusDivider: boolean; toolsDivider: boolean } {
  const running = o.runningTasks > 0;
  const needYou = o.needYou > 0;
  const updated = o.updated > 0;
  // "N PRs" (PR-MENU-SPEC §2.1) sits with the status chips, only while the board has PRs; hidden ones keep it so the Hidden view stays reachable (D12).
  const prs = (o.prs ?? 0) + (o.prsHidden ?? 0) > 0;
  const status = running || needYou || updated || prs;
  const anyTool = tools.ideas || tools.memory || tools.insights;
  return { running, needYou, updated, ...(o.prs !== undefined ? { prs } : {}), statusDivider: status || anyTool, toolsDivider: status && anyTool };
}

/** One row of the running list (DISPATCHER-SPEC §9.2a): a card with a working session or subagent (SUBAGENTS-SPEC §10). */
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

/** Cards (live, in the shown projects) with a working session or subagent, oldest run first, ties by id, so a start or stop moves no other row. */
export function runningRows(
  projects: readonly Pick<Project, "id">[],
  tasks: readonly Task[],
  agents: readonly Agent[],
  provider?: ProviderRunning,
): RunningRow[] {
  const ids = new Set(projects.map((p) => p.id));
  const since = new Map<string, string | null>();
  const workspaces = new Set(tasks.filter((t) => !t.archivedAt && ids.has(t.projectId)).map((t) => t.workspaceId));
  cardActivities(workspaces, agents, provider).forEach((a, workspaceId) => {
    if (a.running) since.set(workspaceId, a.since);
  });
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

/** True when both lists hold the same rows in the same order, so a state update can keep its current reference. */
export function sameRunningRows(a: readonly RunningRow[], b: readonly RunningRow[]): boolean {
  return a.length === b.length && a.every((r, i) => {
    const o = b[i];
    return r.taskId === o.taskId && r.title === o.title && r.projectId === o.projectId && r.status === o.status && r.since === o.since && r.ended === o.ended;
  });
}
