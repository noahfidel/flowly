import { z } from "zod";

/** The Linear board (LINEAR-BOARD-SPEC): issue rows, one lane per workflow state, and the "already has a card" marker. */

export const linearCardSchema = z.object({ taskId: z.string(), projectId: z.string(), workspaceId: z.string(), title: z.string() });
export type LinearCard = z.infer<typeof linearCardSchema>;

export const linearIssueRowSchema = z.object({
  key: z.string(),
  remoteId: z.string(),
  title: z.string(),
  url: z.string(),
  updated: z.string(),
  /** 0 none, 1 urgent … 4 low. */
  priority: z.number().int().min(0).max(4),
  /** "" for none. */
  priorityLabel: z.string(),
  stateName: z.string(),
  /** Linear's workflow state type, lowercased: triage, backlog, unstarted, started, completed, canceled. */
  stateType: z.string(),
  statePosition: z.number(),
  /** The workflow state's and the team's ids ("" when Linear gave none). */
  stateId: z.string(),
  teamId: z.string(),
  assignee: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
});
export type LinearIssueRow = z.infer<typeof linearIssueRowSchema>;
export const linearBoardRowSchema = linearIssueRowSchema.extend({ card: linearCardSchema.nullable() });
export type LinearBoardRow = z.infer<typeof linearBoardRowSchema>;
export const linearTeamSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });
export type LinearTeam = z.infer<typeof linearTeamSchema>;

/** A workflow state of a team (LINEAR-BOARD-SPEC §3.1). */
export const linearStateSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number(), teamId: z.string() });
export type LinearState = z.infer<typeof linearStateSchema>;

/** One board lane: the issues in the states of one name. `key` is the lowercased trimmed name ("" for none). */
export type LinearLane<T extends LinearIssueRow = LinearIssueRow> = { key: string; title: string; type: string; issues: T[] };

/** Linear's board order of state types; an unknown type goes last. */
const typeRank = (type: string) => {
  const rank = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"].indexOf(type === "cancelled" ? "canceled" : type);
  return rank < 0 ? 7 : rank;
};
const laneKey = (name: string) => name.trim().toLowerCase();

/** Urgent first, no priority last; then most recently updated. */
const byPriority = (a: LinearIssueRow, b: LinearIssueRow) => (a.priority || 5) - (b.priority || 5) || b.updated.localeCompare(a.updated);

/**
 * One lane per state name, merged across teams (LINEAR-BOARD-SPEC §4): Linear's order (type rank, then lowest
 * position, then name), every state present even when empty, and an issue whose state is not in `states` makes
 * a lane from its own fields so it is never dropped. The title is Linear's own spelling; "" has no title.
 */
export function buildLanes<T extends LinearIssueRow>(states: readonly LinearState[], issues: readonly T[]): LinearLane<T>[] {
  const lanes = new Map<string, LinearLane<T> & { position: number }>();
  const add = (name: string, type: string, position: number) => {
    const key = laneKey(name);
    const type_ = type.toLowerCase();
    const lane = lanes.get(key);
    if (!lane) lanes.set(key, { key, title: name.trim(), type: type_, issues: [], position });
    else if (typeRank(type_) < typeRank(lane.type) || (typeRank(type_) === typeRank(lane.type) && position < lane.position)) {
      lane.type = type_;
      lane.position = position;
    }
  };
  for (const s of states) add(s.name, s.type, s.position);
  for (const issue of issues) add(issue.stateName, issue.stateType, issue.statePosition);
  for (const issue of issues) lanes.get(laneKey(issue.stateName))!.issues.push(issue);
  return [...lanes.values()]
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position || a.title.localeCompare(b.title))
    .map(({ position: _position, ...lane }) => ({ ...lane, issues: lane.issues.sort(byPriority) }));
}

/** The lanes the status filter leaves shown, in order. */
export function visibleGroups<G extends { key: string }>(groups: readonly G[], hidden: readonly string[]): G[] {
  return groups.filter((g) => !hidden.includes(g.key));
}

type MarkerTask = { id: string; projectId: string; workspaceId: string; title: string; archivedAt: string | null; updatedAt: string };
type MarkerArtifact = { taskId: string; external?: { provider: string; key: string } };

/**
 * Linear key → the card that already references it (LINEAR-BOARD-SPEC §3.3): a non-archived card with a Linear
 * input of that key, through any Linear connection; the most recently updated one when there are several.
 */
export function linearCardsByKey(tasks: readonly MarkerTask[], artifacts: readonly MarkerArtifact[]): Map<string, LinearCard> {
  const live = new Map(tasks.filter((t) => !t.archivedAt).map((t) => [t.id, t]));
  const best = new Map<string, MarkerTask>();
  for (const a of artifacts) {
    if (a.external?.provider !== "linear") continue;
    const task = live.get(a.taskId);
    if (!task) continue;
    const key = a.external.key.toUpperCase();
    const current = best.get(key);
    if (!current || task.updatedAt > current.updatedAt) best.set(key, task);
  }
  return new Map([...best].map(([key, t]) => [key, { taskId: t.id, projectId: t.projectId, workspaceId: t.workspaceId, title: t.title }]));
}
