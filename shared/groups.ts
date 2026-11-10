import { groupLimits, type Board, type Group } from "./model";

/**
 * Board groups (BOARD-GROUPS-SPEC): the pure rules shared by the store, the migration and the later group pages.
 * Nothing here reads or writes storage.
 */

/** The default group's name when the daemon creates it; stored as English text (the daemon has no translation, §7). */
export const defaultGroupName = "Projects";

/** A group as the v1 `board-view.boardGroups` setting stored it, already through the v1 reader's rules. */
export type LegacyGroup = { id: string; name: string; projectIds: string[] };

type Groups = Pick<Board, "groups" | "projects">;

export const normalizeGroupName = (name: string) => name.trim();
/** Names are unique ignoring case (§1). */
export const groupNameKey = (name: string) => normalizeGroupName(name).toLocaleLowerCase("en");
export function nameTaken(groups: readonly Group[], name: string, exceptId?: string) {
  const key = groupNameKey(name);
  return groups.some((g) => g.id !== exceptId && groupNameKey(g.name) === key);
}
/** Tab and switcher order: position, then creation, then id. */
export function groupOrder(a: Group, b: Group) {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
export const orderedGroups = (groups: readonly Group[]) => [...groups].sort(groupOrder);
/** The group a project belongs to by its `groupId`; null when it has none or names no group (no fallback to the default). */
export function groupOfProject(board: { groups: readonly Group[] }, project: { groupId?: string } | null | undefined): Group | null {
  if (!project?.groupId) return null;
  return board.groups.find((g) => g.id === project.groupId) ?? null;
}
export const defaultGroupOf = (board: Pick<Board, "groups">) => board.groups.find((g) => g.isDefault);

/**
 * Read-time repair (§1): a board with projects and no group gets the default group **Projects**; a missing or doubled
 * default flag is set on one group (the first default, else the first group); a project whose `groupId` is missing or
 * names no group joins the default group. Archived projects included. Never run before the migration (§7): on an
 * unmigrated board it would create **Projects** and make the migration skip the stored groups.
 * A broken stored list is repaired too, so the commit invariants never block every write: a repeated group id keeps
 * its first group (in order) and drops the others; a repeated name (ignoring case) is renamed with " 2", " 3", ….
 * Returns the repaired project ids, the dropped or renamed group ids, and whether anything changed.
 */
export function ensureGroups(
  board: Groups,
  now: string,
  newId: () => string,
): { changed: boolean; projectIds: string[]; groupIds: string[] } {
  const projectIds: string[] = [],
    groupIds: string[] = [];
  let changed = false;
  if (!board.groups.length) {
    if (!board.projects.length) return { changed, projectIds, groupIds };
    board.groups.push({ id: newId(), name: defaultGroupName, position: 0, isDefault: true, revision: 1, createdAt: now, updatedAt: now });
    changed = true;
  }
  const seenIds = new Set<string>(),
    names = new Set<string>();
  const unique = orderedGroups(board.groups).filter((g) => {
    if (seenIds.has(g.id)) {
      groupIds.push(g.id);
      return false;
    }
    seenIds.add(g.id);
    return true;
  });
  if (unique.length !== board.groups.length) {
    board.groups = board.groups.filter((g) => unique.includes(g));
    changed = true;
  }
  for (const group of unique) {
    if (!names.has(groupNameKey(group.name))) {
      names.add(groupNameKey(group.name));
      continue;
    }
    group.name = uniqueName(group.name, names);
    groupIds.push(group.id);
    changed = true;
  }
  const ordered = unique;
  const flagged = ordered.filter((g) => g.isDefault);
  const keep = flagged[0] ?? ordered[0];
  if (flagged.length !== 1) {
    for (const g of flagged) if (g !== keep) delete g.isDefault;
    keep.isDefault = true;
    changed = true;
  }
  const ids = new Set(board.groups.map((g) => g.id));
  for (const project of board.projects)
    if (!project.groupId || !ids.has(project.groupId)) {
      project.groupId = keep.id;
      projectIds.push(project.id);
      changed = true;
    }
  return { changed, projectIds, groupIds };
}

/** The stored name cut to the cap, made unique with " 2", " 3", … (ignoring case); "" for a blank name. */
function uniqueName(raw: string, taken: Set<string>) {
  const base = normalizeGroupName([...normalizeGroupName(raw)].slice(0, groupLimits.name).join(""));
  if (!base) return "";
  let name = base;
  for (let n = 2; taken.has(groupNameKey(name)); n++) {
    const suffix = ` ${n}`;
    name = normalizeGroupName([...base].slice(0, groupLimits.name - suffix.length).join("")) + suffix;
  }
  taken.add(groupNameKey(name));
  return name;
}

/**
 * The one-time migration's steps 1–2 (§7): the host's v1 groups become board groups in stored order (blank names
 * dropped, names cut to 80, duplicates renamed, at most 50 kept); a project listed in several goes to the first, a
 * project in none (or in a dropped group) goes to **Projects**, made the default: a kept stored group of that name
 * (ignoring case) is reused, else one is created last, counting toward the cap (the 50th stored group gives way). With
 * no such project the first group is the default. No stored groups: one **Projects** holding every project. Archived
 * projects are placed like live ones; ids of projects no longer on the board are ignored.
 * Runs only on a board with projects and no groups; otherwise changes nothing (idempotent). Returns whether it changed.
 */
export function migrateLegacyGroups(board: Groups, legacy: readonly LegacyGroup[], now: string, newId: () => string) {
  if (board.groups.length || !board.projects.length) return false;
  const projectIds = new Set(board.projects.map((p) => p.id));
  const taken = new Set<string>();
  const candidates: { name: string; projectIds: readonly string[] }[] = [];
  for (const group of legacy) {
    const name = uniqueName(group.name, taken);
    if (name) candidates.push({ name, projectIds: group.projectIds });
  }
  const placement = (kept: typeof candidates) => {
    const memberOf = new Map<string, number>();
    kept.forEach((group, index) => {
      for (const id of group.projectIds) if (projectIds.has(id) && !memberOf.has(id)) memberOf.set(id, index);
    });
    return memberOf;
  };
  let kept = candidates.slice(0, groupLimits.groups);
  let memberOf = placement(kept);
  const needsDefault = board.projects.some((p) => !memberOf.has(p.id));
  const defaultKey = groupNameKey(defaultGroupName);
  // Ruling (Noah, 2026-11-10): a stored "Projects" (any case) becomes the default and takes the ungrouped projects.
  const reused = needsDefault ? kept.findIndex((g) => groupNameKey(g.name) === defaultKey) : -1;
  // A new Projects must fit under the cap too: the last stored group gives way, and its projects join Projects.
  if (needsDefault && reused < 0 && kept.length === groupLimits.groups) {
    kept = kept.slice(0, groupLimits.groups - 1);
    memberOf = placement(kept);
  }
  const groups: Group[] = kept.map((g, position) => ({ id: newId(), name: g.name, position, revision: 1, createdAt: now, updatedAt: now }));
  let fallback: Group | undefined;
  if (needsDefault) {
    if (reused >= 0) fallback = groups[reused];
    else {
      fallback = { id: newId(), name: defaultGroupName, position: groups.length, revision: 1, createdAt: now, updatedAt: now };
      groups.push(fallback);
    }
    fallback.isDefault = true;
  } else groups[0].isDefault = true;
  for (const project of board.projects) {
    const index = memberOf.get(project.id);
    project.groupId = index === undefined ? fallback!.id : groups[index].id;
  }
  board.groups = groups;
  return true;
}

/** Open cards: on a live project, not archived, not Done or Cancelled. */
const isOpen = (status: string) => status !== "done" && status !== "cancelled";
/** A card that counts as open (§7 step 4, DISPATCHER-SPEC §5): not archived, not Done or Cancelled. Its project is checked by the caller. */
export const isOpenCard = (task: Pick<Board["tasks"][number], "archivedAt" | "status">) => !task.archivedAt && isOpen(task.status);

/** Open cards per group: cards of live projects only, keyed by the project's `groupId`; a group without any is absent. */
export function openCardsByGroup(board: Pick<Board, "projects" | "tasks">): Map<string, number> {
  const groupOf = new Map(board.projects.filter((p) => !p.archivedAt && p.groupId).map((p) => [p.id, p.groupId!]));
  const counts = new Map<string, number>();
  for (const task of board.tasks) {
    const group = groupOf.get(task.projectId);
    if (group && isOpenCard(task)) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

/**
 * The group the v1 dispatcher session moves to (§7 step 4): the one with the most open cards; ties go to the first
 * group in order. Null on a board with no groups.
 */
export function dispatcherTarget(board: Pick<Board, "groups" | "projects" | "tasks">): string | null {
  const ordered = orderedGroups(board.groups);
  if (!ordered.length) return null;
  const counts = openCardsByGroup(board);
  let best = ordered[0];
  for (const group of ordered) if ((counts.get(group.id) ?? 0) > (counts.get(best.id) ?? 0)) best = group;
  return best.id;
}

/**
 * The invariants every committed write keeps (§1): at most 50 groups, unique ids, unique names ignoring case, exactly
 * one default while groups exist, and every project's `groupId` names a group. Checked on commit only, not on load, so
 * a dangling id stays repairable instead of making the board unreadable.
 */
export function assertGroupInvariants(board: Groups) {
  const { groups } = board;
  if (groups.length > groupLimits.groups) throw new Error(`A board has at most ${groupLimits.groups} groups.`);
  if (new Set(groups.map((g) => g.id)).size !== groups.length) throw new Error("Duplicate group id.");
  if (new Set(groups.map((g) => groupNameKey(g.name))).size !== groups.length) throw new Error("Duplicate group name.");
  if (groups.length && groups.filter((g) => g.isDefault).length !== 1) throw new Error("Exactly one group must be the default.");
  const ids = new Set(groups.map((g) => g.id));
  for (const project of board.projects)
    if (!project.groupId || !ids.has(project.groupId)) throw new Error("Every project must belong to a group.");
}
