import type { Group, Project, Status } from "../shared/model";
import { allQuickProject, includedProjects } from "./all-projects";
import { quickProject } from "./quick-task";

/** Board groups (docs/BOARD-GROUPS-SPEC.md): the board's only navigation unit; each group opens as one board. Pure. */

/** The board's choice for a group's board; never a project id (UUIDs). */
const GROUP_VIEW = "*group:";
/** The pre-groups "All projects" choice, still found in remembered views; it maps to the default group. */
const LEGACY_ALL = "*all";
export const groupViewId = (groupId: string) => `${GROUP_VIEW}${groupId}`;
export const isGroupView = (viewId: string) => viewId.startsWith(GROUP_VIEW);
export function groupOfView<G extends Pick<Group, "id">>(groups: readonly G[], viewId: string): G | undefined {
  if (!isGroupView(viewId)) return undefined;
  const id = viewId.slice(GROUP_VIEW.length);
  return groups.find((g) => g.id === id);
}

/** The group new and ungrouped projects belong to: the flagged one, else the first by position (§1). */
export function defaultGroup<G extends Pick<Group, "isDefault" | "position">>(groups: readonly G[]): G | undefined {
  return groups.find((g) => g.isDefault) ?? [...groups].sort((x, y) => x.position - y.position)[0];
}

/** A group's projects on its board: the live members in chooser order (§3). */
export function groupMembers<P extends Pick<Project, "id" | "archivedAt" | "position" | "createdAt" | "groupId">>(group: Pick<Group, "id">, projects: readonly P[]): P[] {
  return includedProjects(projects).filter((p) => p.groupId === group.id);
}

/** The group a project belongs to, archived or not; a project with none (or an unknown one) is in the default group. */
export function groupOfProject<G extends Pick<Group, "id" | "isDefault" | "position">>(groups: readonly G[], projects: readonly Pick<Project, "id" | "groupId">[], projectId: string): G | undefined {
  const groupId = projects.find((p) => p.id === projectId)?.groupId;
  return groups.find((g) => g.id === groupId) ?? defaultGroup(groups);
}

/** Whether a project's cards and signals belong to the board shown (feeds the step-through queues and counts, §4). */
export function boardScope(projectIds: readonly string[]): (projectId: string) => boolean {
  const ids = new Set(projectIds);
  return (id) => ids.has(id);
}

/**
 * What the board's overview bar covers (§3, §4; Ruling, Noah 2026-11-10): the "N need you" / "N updated" counts and
 * the N/U step-throughs cover the filtered project, else every live member of the group shown; `perProject` says
 * whether the one entry that stays per project (Guardrails, **G**) shows. An empty group covers nothing.
 */
export function overviewScope<P extends { id: string }>(project: P | undefined, members: readonly P[]): { projects: P[]; perProject: boolean } {
  return project ? { projects: [project], perProject: true } : { projects: [...members], perProject: false };
}

/**
 * The group the board opens: the explicit choice, else the view last viewed in this run, else the default group.
 * A choice is a group's view id (used while the group exists), the legacy "*all" (the default group) or a bare
 * project id (that project's group); anything unknown is skipped to the next candidate.
 */
export function pickGroupView<G extends Pick<Group, "id" | "isDefault" | "position">>(
  groups: readonly G[],
  projects: readonly Pick<Project, "id" | "groupId">[],
  chosen: string,
  viewed: string,
  /** The group last viewed as stored in the board-view settings (survives a restart; §3). */
  stored = "",
): G | undefined {
  const resolve = (id: string): G | undefined => {
    if (!id) return undefined;
    if (isGroupView(id)) return groupOfView(groups, id);
    if (id === LEGACY_ALL) return defaultGroup(groups);
    return projects.some((p) => p.id === id) ? groupOfProject(groups, projects, id) : undefined;
  };
  return resolve(chosen) ?? resolve(viewed) ?? (stored ? groupOfView(groups, groupViewId(stored)) : undefined) ?? defaultGroup(groups);
}

/**
 * A group choice whose group was deleted is dropped once the board and settings are loaded (`ready`); an empty list
 * while loading is not a deletion. Legacy choices ("*all", project ids) are never stale: they just map (§6).
 */
export function staleGroupChoice(chosen: string, groups: readonly Pick<Group, "id">[], ready: boolean): boolean {
  return ready && isGroupView(chosen) && !groupOfView(groups, chosen);
}

/**
 * The project Quick task opens with on a group's board (§5): the last quick-task project when it is a live member,
 * else the first member; an empty group uses All's rule.
 */
export function groupQuickProject(members: readonly Project[], projects: readonly Project[], lastQuickProjectId: string, filteredId = "") {
  if (!members.length) return allQuickProject(projects, lastQuickProjectId);
  return quickProject(members, { pinned: filteredId, last: lastQuickProjectId, current: "" });
}

/** The board's Project filter: a project of the group shown (§3); it lives with the group it was set in. */
export type ProjectFilter = { groupId: string; projectId: string } | null;

/** The filtered project's id while it applies: cleared ("") when no filter, another group is shown or the project left the group. */
/**
 * The Project filter a board starts with (§4): the one set or cleared in this app run (`undefined`: none yet), else the
 * one stored in the board-view settings. Always read through `validProjectFilter`: the group or project may be gone.
 */
export function restoredFilter(run: ProjectFilter | undefined, stored: ProjectFilter): ProjectFilter {
  return run === undefined ? stored : run;
}

export function validProjectFilter(filter: ProjectFilter, groupId: string, memberIds: readonly string[]): string {
  return filter && filter.groupId === groupId && memberIds.includes(filter.projectId) ? filter.projectId : "";
}

/** The board's one project: the filtered live member, else the only member of a one-project group, else none. */
export function boardProject<P extends { id: string }>(filterProjectId: string, members: readonly P[]): P | undefined {
  return members.find((p) => p.id === filterProjectId) ?? (members.length === 1 ? members[0] : undefined);
}

/** Focusing a project (card, idea, search hit) in another group filters that group's board to it; in the shown group nothing changes (§3). */
export function focusFilter(current: ProjectFilter, shownGroupId: string, targetGroupId: string, projectId: string): ProjectFilter {
  return targetGroupId !== shownGroupId ? { groupId: targetGroupId, projectId } : current;
}

/** The project picker on a group's board: the group's projects first, then the rest, each in its given order (§5). */
export function membersFirst<P extends { id: string }>(projects: readonly P[], memberIds: readonly string[]): P[] {
  const ids = new Set(memberIds);
  return [...projects.filter((p) => ids.has(p.id)), ...projects.filter((p) => !ids.has(p.id))];
}

/**
 * The phone's lane on a board's lanes: kept when it is one of them or there are none (an empty group has no lanes,
 * and nothing must render a missing status, §3); otherwise Todo when shown, else the first lane.
 */
export function mobileLane(shown: readonly Status[], current: Status): Status {
  if (!shown.length || shown.includes(current)) return current;
  return shown.includes("todo") ? "todo" : shown[0];
}

/**
 * What Insights, Ideas and Memory (and **I**, **B**, **M**) cover (§4; Ruling, Noah 2026-11-10): the board's one
 * project (filtered, or a group of one), else every live member of the group shown, read as that group (`groupId`).
 * None for an empty group, or a board shown before its group is known (a cold link): the entries hide there.
 */
export type PageScope<P> = { projects: P[]; groupId: string | null };
export function pageScope<P extends { id: string }>(project: P | undefined, members: readonly P[], groupId: string | undefined): PageScope<P> | null {
  if (project) return { projects: [project], groupId: null };
  return groupId && members.length ? { projects: [...members], groupId } : null;
}

/**
 * The project Add memory and Import ideas start with on an unfiltered group board (§4): the one last added to there
 * (board-view `lastAddProjectId`) while it is still offered, else the first.
 */
export function addProject<P extends { id: string }>(projects: readonly P[], lastId: string): P | undefined {
  return projects.find((p) => p.id === lastId) ?? projects[0];
}
