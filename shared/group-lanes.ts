import { projectLanes } from "./lanes";
import { statuses, type Board, type Lane, type Status } from "./model";

/**
 * Group-level lanes (BOARD-GROUPS-SPEC §0 lanes ruling, §1, §7 step 7). A group's `lanes` is the source of truth;
 * each member project's `lanes` is a mirror the server keeps equal to it, so every reader of a project's lanes
 * resolves through the group.
 */

type Member = { id: string; lanes?: Lane[]; archivedAt: string | null; groupId?: string };
type Card = { projectId: string; status: Status; archivedAt: string | null };
type LaneBoard = { groups: Board["groups"]; projects: Member[]; tasks: readonly Card[] };

/**
 * The lanes a group gets when it has none (§7 step 7), from its live members and the statuses their live cards sit in:
 * a status is on when any live member has it on or a card sits in it; the order is the members' when every live
 * member's full lane list has the same order (so one member keeps its own), else the default order; a custom name is
 * kept only when every live member that has the status on uses that same name. No live member: the same rules over the
 * archived members; no member at all: every lane, built-in names.
 */
export function groupLanesFrom(members: readonly Pick<Member, "lanes" | "archivedAt">[], cardStatuses: Iterable<Status>): Lane[] {
  // A group with no live member takes its lanes from its archived members instead, by the same rules.
  const liveMembers = members.filter((m) => !m.archivedAt);
  const live = (liveMembers.length ? liveMembers : members).map((m) => projectLanes(m));
  if (!live.length) return statuses.map((status) => ({ status, enabled: true }));
  const held = new Set(cardStatuses);
  const orders = new Set(live.map((lanes) => lanes.map((l) => l.status).join(",")));
  const order: readonly Status[] = orders.size === 1 ? live[0].map((l) => l.status) : statuses;
  const result = order.map((status) => {
    const using = live.map((lanes) => lanes.find((l) => l.status === status)!).filter((l) => l.enabled);
    const names = new Set(using.map((l) => l.name?.trim() || ""));
    const name = names.size === 1 ? [...names][0] : "";
    return { status, enabled: using.length > 0 || held.has(status), ...(name ? { name } : {}) };
  });
  // A group never has every lane off (the per-project path could leave a member so): every lane on, built-in names.
  return result.some((l) => l.enabled) ? result : statuses.map((status) => ({ status, enabled: true }));
}

/** Live cards per lane over a group's live member projects: what holds a group lane on (§2 `LANE_NOT_EMPTY`). */
export function groupLaneCounts(board: { projects: readonly Member[]; tasks: readonly Card[] }, groupId: string): Partial<Record<Status, number>> {
  const live = new Set(board.projects.filter((p) => p.groupId === groupId && !p.archivedAt).map((p) => p.id));
  const counts: Partial<Record<Status, number>> = {};
  for (const t of board.tasks) if (!t.archivedAt && live.has(t.projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

/** Compares lane lists by content, not key order (parsed and freshly built objects order their keys differently). */
export const laneKey = (lanes: readonly Lane[] | undefined) => JSON.stringify(lanes?.map((l) => [l.status, l.enabled, l.name ?? ""]) ?? null);
const copy = (lanes: readonly Lane[]): Lane[] => lanes.map((l) => ({ status: l.status, enabled: l.enabled, ...(l.name ? { name: l.name } : {}) }));

/**
 * The lane invariants of §1, kept at the end of every write and on each read's copy: each group has lanes (computed
 * once by `groupLanesFrom` when absent, bumping nothing); a status a live card of a live member sits in is turned on
 * (the group's revision is bumped: its lanes changed); every member, archived ones too, mirrors its group's lanes.
 * `enabled` lists the groups that had a lane turned on for a card, `reenabled` which statuses (so a caller can log it). `bumpRevision: false` (reads, which write nothing)
 * turns the lane on in the copy without touching the group's revision or `updatedAt`.
 */
export function syncGroupLanes(board: LaneBoard, now: string, options: { bumpRevision?: boolean } = {}): { changed: boolean; enabled: string[]; reenabled: { groupId: string; statuses: Status[] }[] } {
  const bump = options.bumpRevision !== false;
  let changed = false;
  const enabled: string[] = [];
  const reenabled: { groupId: string; statuses: Status[] }[] = [];
  const membersOf = new Map<string, Member[]>();
  for (const p of board.projects) if (p.groupId) membersOf.set(p.groupId, [...(membersOf.get(p.groupId) ?? []), p]);
  const liveStatuses = new Map<string, Set<Status>>();
  const liveProject = new Map(board.projects.filter((p) => !p.archivedAt).map((p) => [p.id, p]));
  for (const t of board.tasks) {
    const p = liveProject.get(t.projectId);
    if (t.archivedAt || !p?.groupId) continue;
    const set = liveStatuses.get(p.groupId) ?? new Set<Status>();
    set.add(t.status);
    liveStatuses.set(p.groupId, set);
  }
  for (const group of board.groups) {
    const members = membersOf.get(group.id) ?? [];
    const held = liveStatuses.get(group.id) ?? new Set<Status>();
    if (!group.lanes) {
      group.lanes = groupLanesFrom(members, held);
      changed = true;
    } else {
      const lanes = projectLanes(group);
      const off = lanes.filter((l) => !l.enabled && held.has(l.status));
      const complete = laneKey(lanes) === laneKey(group.lanes);
      if (off.length || !complete) {
        group.lanes = lanes.map((l) => (held.has(l.status) ? { ...l, enabled: true } : l));
        changed = true;
      }
      if (off.length) {
        if (bump) {
          group.revision++;
          group.updatedAt = now;
        }
        enabled.push(group.id);
        reenabled.push({ groupId: group.id, statuses: off.map((l) => l.status) });
      }
    }
    const mirror = laneKey(group.lanes);
    for (const p of members)
      if (laneKey(p.lanes) !== mirror) {
        p.lanes = copy(group.lanes);
        changed = true;
      }
  }
  return { changed, enabled, reenabled };
}
