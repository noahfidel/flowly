import { z } from "zod";
import { projectSchema, taskSchema, linkSchema } from "./model";
import { attentionDismissalSchema } from "./attention-dismiss";
import { connectorFamilies } from "./connectors";

/** Event facts, not a shortened event history (NATIVE-OVERVIEW-SPEC). */
export const sessionFactsSchema = z.strictObject({
  agentId: z.string(),
  latestTurn: z.strictObject({ action: z.enum(["agent.turn_started", "agent.turn_ended"]), at: z.string() }).optional(),
  questionEventId: z.string().nullable(),
  /** The session's open blocker report (ATTENTION-DISMISS-SPEC §7a). */
  blockerEventId: z.string().nullable(),
  silent: z.boolean(),
  hadTurnEnd: z.boolean(),
});
export type SessionFacts = z.infer<typeof sessionFactsSchema>;
export const cardFactsSchema = z.strictObject({
  taskId: z.string(),
  wrapped: z.boolean(),
  questions: z.number().int().nonnegative(),
  openIdeas: z.number().int().nonnegative(),
  external: z.strictObject({ text: z.string(), family: z.enum(connectorFamilies) }).optional(),
  workpad: z.strictObject({ kind: z.enum(["delivered", "failed", "stale", "checks", "acceptance"]), done: z.number(), total: z.number(), count: z.number() }).nullable(),
  finishedAt: z.string(),
  turnEndedAt: z.string().optional(),
  hasArtifacts: z.boolean(),
  hasExternal: z.boolean(),
  hasWorkpad: z.boolean(),
  hasNextMoves: z.boolean(),
  sessions: z.array(sessionFactsSchema),
});
export type CardFacts = z.infer<typeof cardFactsSchema>;
/** Open ideas that belong to a project, not to a card (PROJECT-IDEAS-SPEC §5); one entry per project. */
export const projectIdeaFactsSchema = z.strictObject({ projectId: z.string(), open: z.number().int().nonnegative() });
export type ProjectIdeaFacts = z.infer<typeof projectIdeaFactsSchema>;
export const boardOverviewSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  links: z.array(linkSchema),
  attentionDismissals: z.array(attentionDismissalSchema),
  cards: z.array(cardFactsSchema),
  projectIdeas: z.array(projectIdeaFactsSchema),
});
export type BoardOverview = z.infer<typeof boardOverviewSchema>;
const collection = <T extends z.ZodType>(item: T) => z.strictObject({ set: z.array(item), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional();
export const overviewPatchSchema = z.strictObject({
  baseEtag: z.string(),
  revision: z.number().int().nonnegative(),
  projects: collection(projectSchema),
  tasks: collection(taskSchema),
  links: collection(linkSchema),
  attentionDismissals: collection(attentionDismissalSchema),
  cards: collection(cardFactsSchema),
  projectIdeas: collection(projectIdeaFactsSchema),
});
export type OverviewPatch = z.infer<typeof overviewPatchSchema>;
export const overviewResponseSchema = z.strictObject({ etag: z.string(), value: boardOverviewSchema.optional(), patch: overviewPatchSchema.optional() });

/** Every collection has an explicit scope and identity; there is no Board fallback. */
export const overviewKeys = {
  projects: (x: { id: string }) => x.id,
  tasks: (x: { id: string }) => x.id,
  links: (x: { id: string }) => x.id,
  attentionDismissals: (x: { taskId: string }) => x.taskId,
  cards: (x: { taskId: string }) => x.taskId,
  projectIdeas: (x: { projectId: string }) => x.projectId,
} as const;
export type OverviewCollection = keyof typeof overviewKeys;
export const overviewCollections = Object.keys(overviewKeys) as OverviewCollection[];
