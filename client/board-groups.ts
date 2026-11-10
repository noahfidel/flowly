import type { Project } from "../shared/model";
import type { BoardGroup } from "../shared/settings";
import { allQuickProject, includedProjects } from "./all-projects";
import { quickProject } from "./quick-task";

export type { BoardGroup };

/** Board groups (docs/BOARD-GROUPS-SPEC.md): named sets of projects, each opening as an All-like board. Pure. */

/** The board's choice for a group's board; never a project id (UUIDs) nor All's "*all". */
const GROUP_VIEW = "*group:";
export const groupViewId = (groupId: string) => `${GROUP_VIEW}${groupId}`;
export const isGroupView = (viewId: string) => viewId.startsWith(GROUP_VIEW);
export function groupOfView<G extends BoardGroup>(groups: readonly G[], viewId: string): G | undefined {
  if (!isGroupView(viewId)) return undefined;
  const id = viewId.slice(GROUP_VIEW.length);
  return groups.find((g) => g.id === id);
}

/** A group's projects on its board: the live members in chooser order; deleted and archived members drop out (§3). */
export function groupMembers<P extends Pick<Project, "id" | "archivedAt" | "position" | "createdAt">>(group: Pick<BoardGroup, "projectIds">, projects: readonly P[]): P[] {
  const ids = new Set(group.projectIds);
  return includedProjects(projects).filter((p) => ids.has(p.id));
}

export type BoardScope = { kind: "all" } | { kind: "group"; projectIds: readonly string[] } | { kind: "project"; projectId: string };

/** Whether a project's cards and signals belong to the board shown (feeds the step-through queues and counts, §4). */
export function boardScope(scope: BoardScope): (projectId: string) => boolean {
  if (scope.kind === "all") return () => true;
  if (scope.kind === "project") return (id) => id === scope.projectId;
  const ids = new Set(scope.projectIds);
  return (id) => ids.has(id);
}

/** A group choice whose group was deleted is dropped once settings are loaded, like an unavailable All (§6). */
export function staleGroupChoice(chosen: string, groupViews: readonly string[], ready: boolean): boolean {
  return ready && isGroupView(chosen) && !groupViews.includes(chosen);
}

/**
 * The project Quick task opens with on a group's board (§5): the last quick-task project when it is a live member,
 * else the first member; an empty group uses All's rule.
 */
export function groupQuickProject(members: readonly Project[], projects: readonly Project[], lastQuickProjectId: string) {
  if (!members.length) return allQuickProject(projects, lastQuickProjectId);
  return quickProject(members, { last: lastQuickProjectId, current: "" });
}

/** The project picker on a group's board: the group's projects first, then the rest, each in its given order (§5). */
export function membersFirst<P extends { id: string }>(projects: readonly P[], memberIds: readonly string[]): P[] {
  const ids = new Set(memberIds);
  return [...projects.filter((p) => ids.has(p.id)), ...projects.filter((p) => !ids.has(p.id))];
}

/** Settings editor (§2): a new group with a trimmed, non-empty name and no members. */
export function addGroup(groups: readonly BoardGroup[], name: string, id: string): BoardGroup[] {
  const trimmed = name.trim();
  return trimmed ? [...groups, { id, name: trimmed, projectIds: [] }] : [...groups];
}

export function renameGroup(groups: readonly BoardGroup[], id: string, name: string): BoardGroup[] {
  const trimmed = name.trim();
  return trimmed ? groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) : [...groups];
}

export function deleteGroup(groups: readonly BoardGroup[], id: string): BoardGroup[] {
  return groups.filter((g) => g.id !== id);
}

/** Ticks or unticks a project in one group; other groups keep theirs (a project can be in several). */
export function toggleMember(groups: readonly BoardGroup[], id: string, projectId: string): BoardGroup[] {
  return groups.map((g) =>
    g.id !== id ? g : { ...g, projectIds: g.projectIds.includes(projectId) ? g.projectIds.filter((p) => p !== projectId) : [...g.projectIds, projectId] },
  );
}
