import { z } from "zod";
import { ideaStatuses, statusSchema, taskTypeSchema } from "./model";
import { memoryKinds } from "./memory";

/** Search (SEARCH-SPEC): the contract shared by the daemon, the Search page and flowly_search. */

export const searchSources = ["card", "summary", "note", "workpad", "idea", "artifact", "memory"] as const;
export type SearchSource = (typeof searchSources)[number];
/** flowly_search leaves project memory to flowly_recall (§1). */
export const agentSearchSources = ["card", "summary", "note", "workpad", "idea", "artifact"] as const;

export const searchLimits = {
  query: 200,
  cardsDefault: 30,
  cardsMax: 50,
  memory: 10,
  hitsPerCard: 3,
  /** Characters kept on each side of the first match. */
  context: 40,
  snippet: 160,
  agentDefault: 10,
  agentMax: 20,
  agentSummary: 400,
} as const;

const range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

export const searchInputSchema = z.strictObject({
  query: z.string().max(searchLimits.query),
  /** null: every project that is not archived. */
  projectId: z.string().min(1).max(200).nullable(),
  sources: z.array(z.enum(searchSources)).max(searchSources.length).optional(),
  limit: z.number().int().min(1).max(searchLimits.cardsMax).default(searchLimits.cardsDefault),
});
export type SearchInput = z.input<typeof searchInputSchema>;

export const searchHitSchema = z.object({
  source: z.enum(searchSources),
  /** The idea, artifact or event the hit is in. */
  refId: z.string().optional(),
  field: z.string(),
  snippet: z.string(),
  ranges: z.array(range),
  at: z.string().optional(),
  /** Ideas: open, accepted or dismissed. */
  status: z.enum(ideaStatuses).optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchCardSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  status: statusSchema,
  type: taskTypeSchema.optional(),
  archived: z.boolean(),
  updatedAt: z.string(),
  hits: z.array(searchHitSchema),
});
export type SearchCard = z.infer<typeof searchCardSchema>;

/** An idea that belongs to a project, not a card (PROJECT-IDEAS-SPEC §4), labelled with its project. */
export const searchProjectIdeaSchema = z.object({
  ideaId: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  title: z.string(),
  status: z.enum(ideaStatuses),
  updatedAt: z.string(),
  hits: z.array(searchHitSchema),
});
export type SearchProjectIdea = z.infer<typeof searchProjectIdeaSchema>;

export const searchMemorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(memoryKinds),
  title: z.string(),
  snippet: z.string(),
  ranges: z.array(range),
});
export type SearchMemoryHit = z.infer<typeof searchMemorySchema>;

export const searchResultSchema = z.object({
  cards: z.array(searchCardSchema),
  memory: z.array(searchMemorySchema),
  /** Only when a project idea matched. */
  projectIdeas: z.array(searchProjectIdeaSchema).optional(),
  truncated: z.boolean(),
  /** Files that could not be read this time; their sources are missing from the result. */
  partial: z.array(z.enum(["summaries", "memory"])),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
