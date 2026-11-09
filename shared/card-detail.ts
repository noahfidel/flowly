import { z } from "zod";
import { attentionDismissalSchema } from "./attention-dismiss";
import { artifactSchema, boardSchema, eventSchema, ideaSchema, linkSchema, planSnapshotSchema, projectSchema, taskSchema, workpadSchema } from "./model";
import { projectTagStats } from "./tags";
import { connectorProviderSchema } from "./connectors";

export const cardReferenceSchema = taskSchema.pick({ id: true, projectId: true, title: true, status: true, archivedAt: true, position: true, type: true, priority: true, workspaceId: true });
export type CardReference = z.infer<typeof cardReferenceSchema>;
export const cardDetailSchema = z.strictObject({
  version: z.literal(1), revision: z.number().int().nonnegative(), task: taskSchema, project: projectSchema,
  events: z.array(eventSchema), ideas: z.array(ideaSchema), artifacts: z.array(artifactSchema),
  workpad: workpadSchema.nullable(), plans: z.array(planSnapshotSchema), links: z.array(linkSchema),
  relatedTasks: z.array(cardReferenceSchema), attentionDismissal: attentionDismissalSchema.nullable(),
});
export type CardDetail = z.infer<typeof cardDetailSchema>;
export const projectCardIndexSchema = z.strictObject({
  version: z.literal(1), projectId: z.string(), revision: z.number().int().nonnegative(), cards: z.array(cardReferenceSchema),
  tags: z.array(z.strictObject({ tag: z.string(), count: z.number().int().nonnegative(), lastUsedAt: z.string() })),
  /** Tickets, pages and PRs already on this project's cards, so a form can say which card uses one (LOADING-R2-SPEC §2B). */
  externals: z.array(z.strictObject({ taskId: z.string(), provider: connectorProviderSchema, key: z.string() })),
});
export type ProjectCardIndex = z.infer<typeof projectCardIndexSchema>;
export const projectIdeasSchema = z.strictObject({ version: z.literal(1), projectId: z.string(), revision: z.number().int().nonnegative(), ideas: z.array(ideaSchema) });
export type ProjectIdeas = z.infer<typeof projectIdeasSchema>;
export const PROJECT_UNAVAILABLE = "Project is unavailable.";
/** Whether a read failed because its card or project no longer exists (not a network or daemon failure). */
export const gone = (error: unknown, reason: string) => error instanceof Error && error.message.includes(reason);
export const CARD_UNAVAILABLE = "This session's linked card is unavailable. Refresh the session chip or open Flowly.";
type Board = z.infer<typeof boardSchema>;
export const cardReference = (task: Board["tasks"][number]): CardReference => cardReferenceSchema.parse(task);
/** Complete stored bodies for one card; never masquerades as a Board. Also used by the web adapter. */
export function cardDetail(board: Board, input: { taskId: string; workspaceId: string }): CardDetail {
  const task = board.tasks.find(t => t.id === input.taskId && t.workspaceId === input.workspaceId);
  const project = task && board.projects.find(p => p.id === task.projectId);
  if (!task || !project) throw new Error(CARD_UNAVAILABLE);
  const links = board.links.filter(l => l.from === task.id || l.to === task.id);
  const ideas = board.ideas.filter(i => i.taskId === task.id);
  const ids = new Set([task.id, ...(task.origin?.taskId ? [task.origin.taskId] : []), ...links.flatMap(l => [l.from, l.to]), ...ideas.flatMap(i => i.acceptedTaskId ? [i.acceptedTaskId] : [])]);
  return { version: 1, revision: board.revision, task, project, links, ideas,
    events: board.events.filter(e => e.taskId === task.id), artifacts: board.artifacts.filter(a => a.taskId === task.id),
    workpad: board.workpads.find(w => w.taskId === task.id) ?? null, plans: board.plans.filter(p => p.taskId === task.id),
    relatedTasks: board.tasks.filter(t => ids.has(t.id)).map(cardReference),
    attentionDismissal: board.attentionDismissals.find(a => a.taskId === task.id) ?? null };
}
export function projectCardIndex(board: Board, projectId: string): ProjectCardIndex {
  if (!board.projects.some(p => p.id === projectId)) throw new Error(PROJECT_UNAVAILABLE);
  const cards = board.tasks.filter(t => t.projectId === projectId), ids = new Set(cards.map(t => t.id));
  const externals = board.artifacts.flatMap(a => a.external && ids.has(a.taskId) ? [{ taskId: a.taskId, provider: a.external.provider, key: a.external.key }] : []);
  return { version: 1, projectId, revision: board.revision, cards: cards.map(cardReference), tags: projectTagStats(board.tasks, projectId), externals };
}
export function projectIdeas(board: Board, projectId: string): ProjectIdeas {
  if (!board.projects.some(p => p.id === projectId)) throw new Error(PROJECT_UNAVAILABLE);
  return { version: 1, projectId, revision: board.revision, ideas: board.ideas.filter(i => i.projectId === projectId) };
}
