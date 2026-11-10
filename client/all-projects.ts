import { enabledStatuses, laneEnabled, laneName } from "../shared/lanes";
import { projectOrder, statuses, type Group, type Project, type Status, type Task } from "../shared/model";
import { sortTasks, type BoardSort } from "../shared/sort";
import { taskMatchesSearch, taskMatchesTagFilter } from "../shared/tags";
import { quickProject } from "./quick-task";

/** The All projects board (docs/ALL-PROJECTS-SPEC.md). Pure, so the board and its tests agree. */

/** The projects whose cards the All board shows: the live ones, in chooser order (§3). */
export function includedProjects<P extends Pick<Project, "id" | "archivedAt" | "position" | "createdAt">>(projects: readonly P[]): P[] {
  return projects.filter((p) => !p.archivedAt).sort(projectOrder);
}

/** All's columns: each built-in status enabled in at least one included project, in built-in order (§2). */
export function allStatuses(projects: readonly Pick<Project, "lanes" | "archivedAt">[]): Status[] {
  const enabled = new Set(projects.filter((p) => !p.archivedAt).flatMap((p) => enabledStatuses(p)));
  return statuses.filter((s) => enabled.has(s));
}

/**
 * The board's columns and lane names (BOARD-GROUPS-SPEC §4): a group board, filtered or not, shows its group's enabled
 * lanes in the group's order with the group's names. A board shown before its group is known keeps the old rules: the
 * shown project's lanes, else the union of the live projects with default names (ALL-PROJECTS-SPEC §2).
 */
export function boardLanes(
  group: Pick<Group, "lanes"> | null | undefined,
  project: Pick<Project, "lanes"> | null | undefined,
  projects: readonly Pick<Project, "lanes" | "archivedAt">[],
): { statuses: Status[]; nameOf(status: Status): string } {
  const source = group ?? project ?? null;
  return {
    statuses: source ? enabledStatuses(source) : allStatuses(projects),
    nameOf: (status) => laneName(source, status),
  };
}

export type BoardFilters = { search: string; priority: string; taskType: string; tags: readonly string[] };

/** A card passes the board filters (search, priority, type, tags). */
export function matchesFilters(task: Task, f: BoardFilters) {
  return (
    taskMatchesSearch(task, f.search) &&
    (f.priority === "all" || task.priority === f.priority) &&
    (f.taskType === "all" || task.type === f.taskType) &&
    taskMatchesTagFilter(task, f.tags)
  );
}

/** The cards of the board's scope: one project, or every included project (§3); archived cards only when shown. */
export function scopeTasks(tasks: readonly Task[], scope: { all: true; projectIds: ReadonlySet<string> } | { all: false; projectId: string }, archived: boolean) {
  return tasks.filter((t) => (scope.all ? scope.projectIds.has(t.projectId) : t.projectId === scope.projectId) && (archived || !t.archivedAt));
}

/**
 * One All column in display order (§4): Manual groups cards by project in chooser order and keeps each
 * project's manual order; other sorts apply across projects, ties falling back to manual, then project order.
 */
export function sortAllColumn(column: readonly Task[], mode: BoardSort, activity: ReadonlyMap<string, string>, projectRank: ReadonlyMap<string, number>) {
  const rank = (t: Task) => projectRank.get(t.projectId) ?? Number.MAX_SAFE_INTEGER;
  if (mode === "manual")
    return [...column].sort((a, b) => rank(a) - rank(b) || a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  // sortTasks is stable for equal keys; pre-order by project so its manual tie-break stays deterministic.
  return sortTasks([...column].sort((a, b) => rank(a) - rank(b)), mode, activity);
}

/** Drag reorder within a column (§4): never in All, on a project board only with the Manual sort. */
export function reorderAllowed(all: boolean, sort: BoardSort) {
  return !all && sort === "manual";
}

/**
 * A drop on `status`: on a group board every column is a lane of every member, so a member's card may always drop
 * (BOARD-GROUPS-SPEC §4); with no group known, refused when the card's own project has no such lane (ALL-PROJECTS-SPEC §4).
 */
export function dropAllowed(project: Pick<Project, "lanes" | "groupId"> | undefined, status: Status, group?: Pick<Group, "id" | "lanes"> | null) {
  if (group) return !!project && project.groupId === group.id && laneEnabled(group, status);
  return !!project && laneEnabled(project, status);
}

export type NewTaskOpen =
  | { kind: "quick"; status: Status; projectId?: string; recent?: boolean }
  | { kind: "form"; status: Status };

/**
 * What New task, T, a lane's Add task and the empty-board hint open (§5, QUICK-TASK-SPEC §3). In All: always
 * Quick task with the last quick-task project (`recent`), never a pinned one. On a project board: Quick task
 * unless turned off, in the pinned project, else the board's.
 */
export function newTaskOpen(input: { all: boolean; quickDefault: boolean; status: Status; pinned?: string; current?: string }): NewTaskOpen {
  if (input.all) return { kind: "quick", status: input.status, recent: true };
  if (!input.quickDefault) return { kind: "form", status: input.status };
  const projectId = input.pinned ?? input.current;
  return { kind: "quick", status: input.status, ...(projectId ? { projectId } : {}) };
}

/** The project Quick task opens with in All: the last quick-task project when live, else the first live one. */
export function allQuickProject(projects: readonly Project[], lastQuickProjectId: string) {
  return quickProject(includedProjects(projects), { last: lastQuickProjectId, current: "" });
}
