import { z } from "zod";

/** The Linear board (LINEAR-BOARD-SPEC): issue rows, columns by state type, and the "already has a card" marker. */

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
  assignee: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
});
export type LinearIssueRow = z.infer<typeof linearIssueRowSchema>;
export const linearBoardRowSchema = linearIssueRowSchema.extend({ card: linearCardSchema.nullable() });
export type LinearBoardRow = z.infer<typeof linearBoardRowSchema>;
export const linearTeamSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });
export type LinearTeam = z.infer<typeof linearTeamSchema>;

export const linearColumns = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export type LinearColumn = (typeof linearColumns)[number];

/** The column of a state type; triage and unknown types count as Backlog. */
export function columnOf(stateType: string): LinearColumn {
  const type = stateType.toLowerCase();
  if (type === "cancelled") return "canceled";
  return (linearColumns as readonly string[]).includes(type) ? (type as LinearColumn) : "backlog";
}

/** Urgent first, no priority last; then most recently updated. */
const byPriority = (a: LinearIssueRow, b: LinearIssueRow) => (a.priority || 5) - (b.priority || 5) || b.updated.localeCompare(a.updated);

/** Every column in order, each with its issues sorted. */
export function groupIssues<T extends LinearIssueRow>(issues: readonly T[]): { column: LinearColumn; issues: T[] }[] {
  const groups = new Map<LinearColumn, T[]>(linearColumns.map((c) => [c, []]));
  for (const issue of issues) groups.get(columnOf(issue.stateType))!.push(issue);
  return linearColumns.map((column) => ({ column, issues: groups.get(column)!.sort(byPriority) }));
}

/** The columns the status filter leaves shown, in order. */
export function visibleGroups<G extends { column: LinearColumn }>(groups: readonly G[], hidden: readonly LinearColumn[]): G[] {
  return groups.filter((g) => !hidden.includes(g.column));
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
