import { projectOrder, type Group, type Status } from "./model";

/**
 * One manual order per column over a board group's projects (BOARD-GROUPS-SPEC §0 manual order ruling, §1, §7 step 8).
 * Cards keep the one `position` field; within a group it is comparable across the group's projects, so the group
 * board's Manual sort is plain position order, and one project's order (a filtered board, agents, the project's
 * own reads) is that order restricted to the project. A project's `orderGroupId` names the group whose order its
 * card positions belong to; when it differs from `groupId` (every project before this change, a project that moved
 * to another group, a new or restored project) the project's cards join the end of that group's columns.
 */

type OrderProject = { id: string; groupId?: string; orderGroupId?: string; archivedAt: string | null; position?: number; createdAt: string };
type OrderCard = { id: string; projectId: string; status: Status; position: number; createdAt: string; archivedAt: string | null };
type OrderBoard = { groups: readonly Pick<Group, "id">[]; projects: OrderProject[]; tasks: OrderCard[] };

/** Manual order inside a column: position, then creation (the order every reader already uses). */
const columnOrder = (a: OrderCard, b: OrderCard) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
const merged = (p: OrderProject) => !!p.groupId && p.orderGroupId === p.groupId;

/**
 * Brings every project into its group's order. Projects whose cards are not in it yet are taken live ones first, then
 * archived ones, each in chooser order, and each one's cards join the end of every column of the group in the
 * project's own order. Run on a board whose projects all start unmerged (the migration), this gives exactly the
 * order the group board showed before: projects in chooser order, each keeping its own order. Positions are
 * presentation: no revision changes. A project with no group, or one naming no group, is left to the group repair.
 */
export function syncGroupOrder(board: OrderBoard): { changed: boolean; projectIds: string[] } {
  const groups = new Set(board.groups.map((g) => g.id));
  const joining = board.projects
    .filter((p) => p.groupId && groups.has(p.groupId) && p.orderGroupId !== p.groupId)
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || projectOrder(a, b));
  if (!joining.length) return { changed: false, projectIds: [] };
  const groupOf = new Map(board.projects.filter(merged).map((p) => [p.id, p.groupId!]));
  // The last position of each group column so far: `${groupId} ${status}`.
  const ends = new Map<string, number>();
  for (const t of board.tasks) {
    const g = groupOf.get(t.projectId);
    if (!g) continue;
    const key = `${g} ${t.status}`;
    ends.set(key, Math.max(ends.get(key) ?? -Infinity, t.position));
  }
  for (const project of joining) {
    const g = project.groupId!;
    const cards = board.tasks.filter((t) => t.projectId === project.id).sort(columnOrder);
    for (const t of cards) {
      const key = `${g} ${t.status}`;
      const next = (ends.get(key) ?? -1) + 1;
      t.position = next;
      ends.set(key, next);
    }
    project.orderGroupId = g;
  }
  return { changed: true, projectIds: joining.map((p) => p.id) };
}

/**
 * The projects whose cards share one manual order with `projectId`'s: every member of its group (archived ones too)
 * once the project is in its group's order, else the project alone (no group yet, groups not migrated).
 */
export function orderScope(board: Pick<OrderBoard, "projects">, projectId: string): Set<string> {
  const project = board.projects.find((p) => p.id === projectId);
  if (!project || !merged(project)) return new Set([projectId]);
  return new Set(board.projects.filter((p) => p.groupId === project.groupId && p.orderGroupId === project.groupId).map((p) => p.id));
}

/** The position after the last card of `status` in `projectId`'s order scope (0 for an empty column): where new and moved-in cards go. */
export function columnEnd(board: Pick<OrderBoard, "projects" | "tasks">, projectId: string, status: Status) {
  const scope = orderScope(board, projectId);
  return Math.max(-1, ...board.tasks.filter((t) => scope.has(t.projectId) && t.status === status).map((t) => t.position)) + 1;
}

/**
 * The card a menu Move up / Move down steps past: the adjacent live card in the same column. `project` steps through
 * the card's own project (a project board, a filtered group board); `group` through the shown group board (the
 * group's live projects). Archived cards and archived projects are skipped: neither shows on the board.
 */
export function neighborCard<T extends OrderCard>(
  board: Pick<OrderBoard, "projects"> & { tasks: readonly T[] },
  task: T,
  direction: "up" | "down",
  scope: "project" | "group",
): T | undefined {
  const live = new Set(board.projects.filter((p) => !p.archivedAt).map((p) => p.id));
  const shared = scope === "group" ? orderScope(board, task.projectId) : new Set([task.projectId]);
  const column = board.tasks
    .filter((t) => shared.has(t.projectId) && live.has(t.projectId) && t.status === task.status && !t.archivedAt)
    .sort(columnOrder);
  const index = column.findIndex((t) => t.id === task.id);
  if (index < 0) return undefined;
  return column[index + (direction === "up" ? -1 : 1)];
}
