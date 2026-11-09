import { localizedLabels, msg, t } from "./i18n";
import { agentModelSchema } from "./agent-defaults";
import { connectorLimits, externalRefSchema, itemTypeSchema } from "./connectors";
import { z } from "zod";
import { attentionDismissLimits, attentionDismissalSchema } from "./attention-dismiss";

export const statuses = [
  "backlog",
  "todo",
  "design",
  "development",
  "test",
  "in_review",
  "committed",
  "integrated",
  "blocked",
  "done",
  "cancelled",
] as const;
export const statusLabels: Record<Status, string> = localizedLabels({
  backlog: msg("Backlog"),
  todo: msg("Todo"),
  design: msg("Design"),
  development: msg("Development"),
  test: msg("Test"),
  in_review: msg("In review"),
  committed: msg("Committed"),
  integrated: msg("Integrated"),
  blocked: msg("Blocked"),
  done: msg("Done"),
  cancelled: msg("Cancelled"),
});
/** The working stages that replaced In progress (WORKFLOW-STAGES-SPEC). */
export const workStatuses = ["design", "development", "test"] as const satisfies readonly Status[];
export const isWorkStatus = (status: string): status is (typeof workStatuses)[number] =>
  (workStatuses as readonly string[]).includes(status);
/**
 * Statuses an agent delivers into: In review, Committed once the card's changes are committed (COMMITTED-STAGE-SPEC §1),
 * and Integrated once its commits are in the main checkout's branch (INTEGRATED-STAGE-SPEC §1).
 */
export const deliveryStatuses = ["in_review", "committed", "integrated"] as const satisfies readonly Status[];
export const isDeliveryStatus = (status: string | undefined): status is (typeof deliveryStatuses)[number] =>
  (deliveryStatuses as readonly (string | undefined)[]).includes(status);
/** Retired status: only found in history (events, receipts) written before board v4. */
export const legacyStatus = "in_progress" as const;
export const priorities = ["low", "normal", "high", "urgent"] as const;
/** What kind of work a card is (TASK-TYPE-SPEC). Optional on a task. */
export const taskTypes = ["feature", "bugfix", "research", "refactor", "docs", "chore"] as const;
export const taskTypeLabels: Record<TaskType, string> = localizedLabels({
  feature: msg("Feature"),
  bugfix: msg("Bug fix"),
  research: msg("Research"),
  refactor: msg("Refactor"),
  docs: msg("Docs"),
  chore: msg("Chore"),
});
export const statusSchema = z.enum(statuses);
export type Status = z.infer<typeof statusSchema>;
/** Statuses that may appear in history: current ones plus the retired In progress. */
export const historyStatusSchema = z.union([statusSchema, z.literal(legacyStatus)]);
export type HistoryStatus = z.infer<typeof historyStatusSchema>;
export const historyStatusLabel = (status: HistoryStatus) =>
  status === legacyStatus ? t("In progress") : statusLabels[status];
export const prioritySchema = z.enum(priorities);
export const taskTypeSchema = z.enum(taskTypes);
export type TaskType = z.infer<typeof taskTypeSchema>;
const timestamp = z.string();
/** Card tags: module / direction labels, free text in a normalized form (CARD-TAGS-SPEC §2). */
export const tagLimits = { length: 32, perTask: 12, perCall: 12, suggestions: 50, filter: 20 } as const;
/** A stored (already normalized) tag value; see `normalizeTag` in shared/tags.ts. */
export const tagValueSchema = z
  .string()
  .min(1)
  .max(tagLimits.length * 2)
  .regex(/^[\p{L}\p{N}\-./]+$/u)
  .refine((tag) => [...tag].length <= tagLimits.length && tag === tag.toLocaleLowerCase("en"));
export const taskTagSchema = z.object({
  tag: tagValueSchema,
  by: z.enum(["human", "agent"]),
  agentId: z.string().optional(),
  at: timestamp,
});
export type TaskTag = z.infer<typeof taskTagSchema>;
/** Raw tag input from people and agents; normalized by the daemon. */
export const tagInputList = z.array(z.string().max(200)).max(tagLimits.perCall);
/**
 * A project's lane configuration: the built-in statuses in display order, each
 * enabled or not, optionally renamed. Absent means every lane, default order and
 * names. Lanes define the project's workflow: people, rules and agents only use
 * enabled lanes.
 */
export const laneSchema = z.strictObject({
  status: statusSchema,
  name: z.string().trim().max(40).optional(),
  enabled: z.boolean(),
});
/**
 * Fills in built-in statuses that stored lanes predate (Committed, Integrated; COMMITTED-STAGE-SPEC §2): each missing one goes
 * right after the nearest status before it in the default order, enabled. Anything else passes through for the schema to judge.
 */
export function completeLanes<T>(lanes: T): T {
  if (!Array.isArray(lanes)) return lanes;
  const out: unknown[] = [...lanes];
  const at = (status: string) => out.findIndex((l) => typeof l === "object" && l !== null && (l as { status?: unknown }).status === status);
  statuses.forEach((status, i) => {
    if (at(status) >= 0) return;
    let after = -1;
    for (let j = i - 1; j >= 0 && after < 0; j--) after = at(statuses[j]);
    out.splice(after + 1, 0, { status, enabled: true });
  });
  return out as T;
}
export const lanesSchema = z
  .preprocess(completeLanes, z.array(laneSchema).length(statuses.length))
  .refine((lanes) => new Set(lanes.map((l) => l.status)).size === lanes.length, "Each lane appears once.")
  .refine((lanes) => lanes.some((l) => l.enabled), "Keep at least one lane enabled.");
export type Lane = z.infer<typeof laneSchema>;

export const projectSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000),
  paseoProjectId: z.string(),
  primaryPath: z.string(),
  repos: z.array(z.string()).min(1),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
  /** Session-driven status rules (AUTO-STATUS-SPEC). Absent means enabled. */
  autoStatus: z.boolean().optional(),
  /** Card workpads (WORKPAD-SPEC §9). Absent means enabled. */
  workpad: z.boolean().optional(),
  /** Included in workflow insights (WORKFLOW-INSIGHTS-SPEC §2.2). Absent means included. */
  workflowInsights: z.boolean().optional(),
  /** Project memory (PROJECT-MEMORY-SPEC §9). Absent means on. */
  memory: z.boolean().optional(),
  /** Ask agents to make sure the card has a Linear ticket (LINEAR-TICKET-SPEC §1). Absent means off. */
  linearTicket: z.boolean().optional(),
  /** The Linear team (name or key) those tickets go to; absent lets the agent infer it (LINEAR-TICKET-SPEC §1). */
  linearTeam: z.string().max(80).optional(),
  /** Display order in the project chooser (lower first); absent sorts by creation. */
  position: z.number().optional(),
  lanes: lanesSchema.optional(),
  /** Model new sessions start with in this project; wins over the global default (MODEL-DEFAULTS-SPEC). */
  agentModel: agentModelSchema.optional(),
  /** Linked multi-repo project: symlinks the plugin created inside its own root (PROJECT-PICKER-SPEC). */
  links: z.array(z.object({ name: z.string(), target: z.string() })).optional(),
});
/** Workspace switch (WORKSPACE-SWITCH-SPEC §7.1). */
export const switchLimits = { previousWorkspaces: 10, handoverFiles: 500, handoverPath: 500, handoverNotes: 20000 } as const;
export const previousWorkspaceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  directory: z.string(),
  branch: z.string().optional(),
  switchedAt: timestamp,
});
export const handoverSchema = z.object({
  agentId: z.string(),
  at: timestamp,
  files: z.array(z.string().max(switchLimits.handoverPath)).max(switchLimits.handoverFiles),
  notes: z.string().max(switchLimits.handoverNotes),
});
export type Handover = z.infer<typeof handoverSchema>;
export const switchDirections = ["to_worktree", "to_local"] as const;
export const switchSchema = z.object({
  id: z.string(),
  at: timestamp,
  direction: z.enum(switchDirections),
  /** The main checkout's HEAD the worktree started at (to_worktree). */
  base: z.string().optional(),
  mainBranch: z.string().optional(),
  /** The worktree's branch (to_worktree) or the earlier worktree's branch (to_local). */
  branch: z.string().optional(),
  release: z.enum(["none", "pending", "released"]),
  releasedAt: timestamp.optional(),
  /** Set once flowly_integrate landed the branch; Undo release is no longer offered. */
  integratedAt: timestamp.optional(),
});
export type WorkspaceSwitch = z.infer<typeof switchSchema>;
export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  sourcePath: z.string(),
  repoPaths: z.array(z.string()),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000),
  status: statusSchema,
  priority: prioritySchema,
  /** Absent: no type (all cards created before task types). */
  type: taskTypeSchema.optional(),
  /** Absent: no tags. Unique by `tag`, in the order they were added. */
  tags: z.array(taskTagSchema).max(tagLimits.perTask).optional(),
  position: z.number(),
  revision: z.number().int().positive(),
  operationId: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
  /** The plugin created this workspace for the card (not linked to an existing one). Absent on older cards. */
  ownsWorkspace: z.boolean().optional(),
  /** Created from an idea proposed on another card (IDEAS-SPEC §2.2). */
  /** Where the card came from: an idea (and the card it hung on); a project-level idea has no source card (PROJECT-IDEAS-SPEC §2). */
  origin: z.object({ taskId: z.string().optional(), ideaId: z.string() }).optional(),
  /** Earlier workspaces of the card, oldest first; read-only history (WORKSPACE-SWITCH-SPEC §8). */
  previousWorkspaces: z.array(previousWorkspaceSchema).max(switchLimits.previousWorkspaces).optional(),
  /** This card's own changes in the main checkout, written by its session (WORKSPACE-SWITCH-SPEC §2). */
  handover: handoverSchema.optional(),
  /** The latest workspace switch (WORKSPACE-SWITCH-SPEC §7.1). */
  switch: switchSchema.optional(),
});
/** A follow-up an agent proposed on its card; the user may turn it into a card (IDEAS-SPEC). */
export const ideaStatuses = ["open", "accepted", "dismissed"] as const;
export const ideaLimits = { title: 120, detail: 4000, rationale: 1000, context: 4000, source: 1000, openPerTask: 10, keptPerTask: 50 } as const;
export const ideaSchema = z.object({
  id: z.string(),
  /** The source card; absent for a project-level idea (PROJECT-IDEAS-SPEC §2). */
  taskId: z.string().optional(),
  projectId: z.string(),
  /** The proposing session; absent when a person or an import proposed it. */
  agentId: z.string().optional(),
  /** The Activity event of the proposal; a project-level idea has none. */
  eventId: z.string().optional(),
  title: z.string().trim().min(1).max(ideaLimits.title),
  detail: z.string().max(ideaLimits.detail),
  rationale: z.string().max(ideaLimits.rationale),
  context: z.string().max(ideaLimits.context),
  type: taskTypeSchema.optional(),
  priority: prioritySchema.optional(),
  /** Suggested tags (normalized) for the new card. */
  tags: z.array(tagValueSchema).max(tagLimits.perTask).optional(),
  /** The proposing agent's suggestion: continue in this card ("here") or start a new card ("new"). Absent reads as "new". */
  scope: z.enum(["here", "new"]).optional(),
  /** Free-text provenance, such as the backlog file an imported idea came from (PROJECT-IDEAS-SPEC §2). */
  source: z.string().max(ideaLimits.source).optional(),
  status: z.enum(ideaStatuses),
  /** Accepted as a new card. */
  acceptedTaskId: z.string().optional(),
  /** Accepted in this card: the session the idea was sent to. */
  acceptedAgentId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Idea = z.infer<typeof ideaSchema>;
/** A link between two cards of one project (CARD-LINKS-SPEC §2.1). */
export const linkKinds = ["derived", "related", "blocks"] as const;
export const linkLimits = { perTask: 50 } as const;
export const linkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** derived: from = follow-up card, to = source card. blocks: from blocks to. related: no direction. */
  kind: z.enum(linkKinds),
  from: z.string(),
  to: z.string(),
  /** Set on a derived link written when a card was created from an idea. */
  ideaId: z.string().optional(),
  createdBy: z.enum(["human", "system"]),
  createdAt: timestamp,
});
export type Link = z.infer<typeof linkSchema>;
export type LinkKind = Link["kind"];
export const linkInput = z.strictObject({
  kind: z.enum(linkKinds),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type LinkInput = z.infer<typeof linkInput>;
/** A file or link a card worked from (input) or delivered (output); a reference, not a copy (CARD-ARTIFACTS-SPEC §2.1). */
export const artifactRoles = ["input", "output"] as const;
export const artifactKinds = ["file", "url"] as const;
export const artifactLimits = { title: 120, note: 1000, target: 2000, perTask: 100 } as const;
export const artifactSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  role: z.enum(artifactRoles),
  kind: z.enum(artifactKinds),
  /** file: "./path" inside the card's workspace, else an absolute path; url: an http(s) URL. */
  target: z.string().min(1).max(artifactLimits.target),
  title: z.string().trim().min(1).max(artifactLimits.title),
  note: z.string().max(artifactLimits.note),
  createdBy: z.enum(["human", "agent"]),
  agentId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  /** A link to an item of a configured connection: a read-only input (CONNECTORS-SPEC §3.1). */
  external: externalRefSchema.optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactRole = Artifact["role"];
const artifactTitle = z.string().trim().max(artifactLimits.title);
const artifactNote = z.string().trim().max(artifactLimits.note);
export const artifactInput = z.strictObject({
  taskId: z.string().min(1),
  role: z.enum(artifactRoles),
  target: z.string().trim().min(1).max(artifactLimits.target),
  title: artifactTitle.optional(),
  note: artifactNote.optional(),
  /** The item a picker chose: resolved through this connection instead of re-recognizing `target` (CONNECTORS-SPEC §8.1). */
  external: z.strictObject({ connectionId: z.string().min(1), key: z.string().min(1).max(300), itemType: itemTypeSchema.optional() }).optional(),
});
export type ArtifactInput = z.infer<typeof artifactInput>;
export const artifactEdit = z.strictObject({
  id: z.string().min(1),
  /** The `updatedAt` the edit started from; a different one is a conflict. */
  updatedAt: z.string().min(1),
  role: z.enum(artifactRoles).optional(),
  title: artifactTitle.optional(),
  note: artifactNote.optional(),
});
export type ArtifactEdit = z.infer<typeof artifactEdit>;
/** The card's workpad: acceptance criteria, checks and confusions an agent keeps current (WORKPAD-SPEC §2). */
export const workpadLimits = {
  text: 300,
  command: 300,
  evidence: 600,
  confusion: 600,
  acceptance: 20,
  validation: 20,
  confusions: 10,
  planItems: 50,
  planText: 300,
} as const;
export const checkStates = ["pass", "fail", "unrun"] as const;
export type CheckState = (typeof checkStates)[number];
export const workpadItemId = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/);
const shortSha = z.string().regex(/^[0-9a-f]{4,40}$/);
export const acceptanceItemSchema = z.object({
  id: workpadItemId,
  text: z.string().min(1).max(workpadLimits.text),
  done: z.boolean(),
  by: z.enum(["agent", "human"]),
  at: timestamp,
});
export const validationItemSchema = z.object({
  id: workpadItemId,
  text: z.string().min(1).max(workpadLimits.text),
  command: z.string().max(workpadLimits.command).optional(),
  state: z.enum(checkStates),
  /** The commit it ran on (pass/fail only). */
  sha: shortSha.optional(),
  /** It ran with uncommitted changes in the working tree. */
  dirty: z.boolean().optional(),
  ranAt: timestamp.optional(),
  evidence: z.string().max(workpadLimits.evidence).optional(),
  by: z.enum(["agent", "human"]),
  at: timestamp,
});
export const confusionItemSchema = z.object({
  id: workpadItemId,
  text: z.string().min(1).max(workpadLimits.confusion),
  at: timestamp,
});
/** What git said about the card's workspace; every field optional when git is unavailable. */
export const gitHeadSchema = z.object({
  sha: shortSha.optional(),
  branch: z.string().max(300).optional(),
  dirty: z.boolean(),
  at: timestamp,
});
/** Open items when an agent delivered to In review (WORKPAD-SPEC §5.3). */
export const deliverySchema = z.object({
  unchecked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unrun: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const workpadSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  revision: z.number().int().positive(),
  acceptance: z.array(acceptanceItemSchema).max(workpadLimits.acceptance),
  validation: z.array(validationItemSchema).max(workpadLimits.validation),
  confusions: z.array(confusionItemSchema).max(workpadLimits.confusions),
  /** Where the agent last wrote it from: host, workspace path and git state then. */
  env: z.object({ host: z.string().max(300), path: z.string().max(4096), head: gitHeadSchema.nullable() }).nullable(),
  /** The workspace HEAD at the last refresh, for out-of-date checks (§5.2). */
  head: gitHeadSchema.nullable(),
  /** The latest agent delivery to In review and its open items (§5.3). */
  delivery: deliverySchema.extend({ eventId: z.string(), at: timestamp }).optional(),
  updatedAt: timestamp,
  updatedBy: z.enum(["agent", "human"]),
  agentId: z.string().optional(),
});
export type Workpad = z.infer<typeof workpadSchema>;
export type AcceptanceItem = z.infer<typeof acceptanceItemSchema>;
export type ValidationItem = z.infer<typeof validationItemSchema>;
export type ConfusionItem = z.infer<typeof confusionItemSchema>;
export type GitHead = z.infer<typeof gitHeadSchema>;
export const planStatuses = ["pending", "in_progress", "completed"] as const;
/** A session's plan, read from its native todo list at turn end (WORKPAD-SPEC §2.2). */
export const planSnapshotSchema = z.object({
  taskId: z.string(),
  agentId: z.string(),
  items: z
    .array(z.object({ text: z.string().min(1).max(workpadLimits.planText), status: z.enum(planStatuses) }))
    .max(workpadLimits.planItems),
  at: timestamp,
});
export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;
/** Human edits of one workpad item (WORKPAD-SPEC §6.3). */
export const workpadCheck = z.strictObject({
  taskId: z.string().min(1),
  section: z.enum(["acceptance", "validation"]),
  itemId: workpadItemId,
  done: z.boolean().optional(),
  state: z.enum(checkStates).optional(),
});
export type WorkpadCheck = z.infer<typeof workpadCheck>;
export const ideaEdit = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["open", "dismissed"]),
});
export type IdeaEdit = z.infer<typeof ideaEdit>;
/** Accept an idea in its own card by sending it to one of the card's sessions (IDEAS-SPEC §6.2). */
export const ideaAdoption = z.strictObject({
  id: z.string().min(1),
  // IDs reach Paseo calls; keep them plain.
  agentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  /** false: only record the session (it was just started with the idea as its first instruction). */
  send: z.boolean().default(true),
});
export type IdeaAdoption = z.input<typeof ideaAdoption>;
/** One suggested next message for a session (NEXT-MOVES-SPEC §2). */
export const nextMoveLimits = { count: 3, label: 60, prompt: 2000 } as const;
/** Action moves (NEXT-MOVES-SPEC §7): picking one acts on the card instead of filling the composer. */
export const nextMoveTargets = ["done"] as const;
export const nextMoveSchema = z.object({
  label: z.string().trim().min(1).max(nextMoveLimits.label),
  /** Required for a message move; an action move (`moveTo`) has none. */
  prompt: z.string().trim().min(1).max(nextMoveLimits.prompt).optional(),
  moveTo: z.enum(nextMoveTargets).optional(),
});
export type NextMove = z.infer<typeof nextMoveSchema>;
export const eventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  actor: z.enum(["human", "agent", "system"]),
  action: z.string(),
  agentId: z.string().optional(),
  note: z.string().max(10000).optional(),
  from: historyStatusSchema.optional(),
  to: historyStatusSchema.optional(),
  reportKind: z.enum(["progress", "blocker", "result", "question"]).optional(),
  /** Set when a status rule, not a person or an agent tool, made the change. */
  rule: z.string().max(20).optional(),
  outcome: z.enum(["completed", "failed", "canceled"]).optional(),
  /** next_moves_suggested: the session's suggested next messages (NEXT-MOVES-SPEC §2). */
  moves: z.array(nextMoveSchema).max(nextMoveLimits.count).optional(),
  /** agent.turn_ended: the session's `provider/model` when the turn ended (WORKFLOW-INSIGHTS-SPEC §12.4). */
  model: z.string().max(200).optional(),
  /**
   * agent.turn_ended: which of the suggestions open when the turn began the user's message matched
   * (index), or -1 for none. Absent when none was open or the message was not seen.
   */
  pick: z.number().int().min(-1).max(nextMoveLimits.count - 1).optional(),
  /** agent.turn_ended: the turn began with a real user message, not an injected one (INSIGHTS-REDESIGN-SPEC §7.1). Absent when unknown. */
  byUser: z.boolean().optional(),
  /** agent.permission_requested: the tool's name as the provider reports it, without its input (INSIGHTS-REDESIGN-SPEC §7.2). */
  tool: z.string().max(80).optional(),
  /** status_changed into In review by an agent: the workpad's open items then (WORKPAD-SPEC §5.3). */
  workpad: deliverySchema.optional(),
  /** status_changed into In review by an agent that acknowledged missing card setup (CARD-SETUP-SPEC §3.4). */
  setup: z.object({ missing: z.array(z.enum(["type", "tags", "workpad"])) }).optional(),
  at: timestamp,
});
export const boardSchema = z.object({
  version: z.literal(5),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  events: z.array(eventSchema),
  /** Absent in files written before ideas (IDEAS-SPEC §2.1). */
  ideas: z.array(ideaSchema).default([]),
  /** Absent in files written before card links; then derived from `Task.origin` once (CARD-LINKS-SPEC §2.2). */
  links: z.array(linkSchema).default([]),
  /** Absent in files written before artifacts (CARD-ARTIFACTS-SPEC §2.1). */
  artifacts: z.array(artifactSchema).default([]),
  /** Absent in files written before workpads (WORKPAD-SPEC §2). */
  workpads: z.array(workpadSchema).default([]),
  plans: z.array(planSnapshotSchema).default([]),
  /** Cards dismissed from Attention (ATTENTION-DISMISS-SPEC §4); absent in older files. */
  attentionDismissals: z.array(attentionDismissalSchema).max(attentionDismissLimits.records).default([]),
});
export const previousBoardSchema = boardSchema.extend({
  version: z.literal(2),
});
/** v3 differs from v4 only by the retired in_progress status, rewritten before parsing. */
export const v3BoardSchema = boardSchema.extend({
  version: z.literal(3),
});
/** v4 differs from v5 only by the artifact field `ticket`, renamed to `external` before parsing (CONNECTORS-SPEC §3.1). */
export const v4BoardSchema = boardSchema.extend({
  version: z.literal(4),
});
export const receiptSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  taskId: z.string(),
  payloadHash: z.string(),
  action: z.enum(["status", "progress", "idea", "idea_update", "idea_remove", "remember", "artifact", "artifact_remove", "tags", "type", "next_moves", "workpad", "handover"]),
  /** Empty when an artifact write changed nothing (same target already recorded). */
  eventId: z.string(),
  /** Stable result identity for idea writes, even after the idea is removed or pruned. */
  ideaId: z.string().optional(),
  /** The artifact an artifact write added, updated or removed. */
  artifactId: z.string().optional(),
  /** Output artifacts recorded atomically with a delivery; [] is an explicit declaration of none. */
  artifactIds: z.array(z.string()).max(20).optional(),
  /** Why an artifact write did not apply what was asked (an agent can't change an entry the user added); shown in the tool result. */
  notice: z.string().optional(),
  /** The workpad revision a workpad write committed. */
  workpadRevision: z.number().int().positive().optional(),
  taskRevision: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  status: historyStatusSchema,
  at: z.string(),
  expiresAt: z.string(),
});
export const storageSchema = boardSchema.extend({
  agentReceipts: z.array(receiptSchema).max(5000),
});
export const legacyBoardSchema = boardSchema.extend({
  version: z.literal(1),
  tasks: z.array(taskSchema.omit({ repoPaths: true })),
});
export type Board = z.infer<typeof storageSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type BoardEvent = z.infer<typeof eventSchema>;
export const emptyBoard = (): Board => ({
  version: 5,
  revision: 0,
  projects: [],
  tasks: [],
  events: [],
  ideas: [],
  links: [],
  artifacts: [],
  workpads: [],
  plans: [],
  attentionDismissals: [],
  agentReceipts: [],
});
export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(""),
  primaryPath: z.string().min(1),
  paseoProjectId: z.string().optional(),
});
const linkTargets = z.array(z.string().trim().min(1).max(4096)).min(1).max(50);
export const linkedProjectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(""),
  links: linkTargets,
});
export const projectLinksEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  links: linkTargets,
});
export type LinkedProjectInput = z.infer<typeof linkedProjectInput>;
export type ProjectLinksEdit = z.infer<typeof projectLinksEdit>;
/** Removes a project and its cards from the board only (PROJECT-REMOVE-SPEC). */
export const projectRemoval = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int(),
  /** Also remove the native Paseo project (its folders, worktrees and branches stay on disk). */
  alsoPaseo: z.boolean().default(false),
});
export type ProjectRemoval = z.input<typeof projectRemoval>;
/** Permanently deletes a card from the board (TASK-DELETE-SPEC). */
export const taskDeletion = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int(),
  /** First archive its sessions, and its workspace when the card owns it or it is a worktree. */
  archive: z.boolean().default(false),
  /** Required with `archive` when the preflight reported warnings. */
  acknowledgeWarnings: z.boolean().default(false),
});
export type TaskDeletion = z.infer<typeof taskDeletion>;
export const projectEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(10000).optional(),
  archived: z.boolean().optional(),
  autoStatus: z.boolean().optional(),
  workpad: z.boolean().optional(),
  workflowInsights: z.boolean().optional(),
  memory: z.boolean().optional(),
  linearTicket: z.boolean().optional(),
  /** "" removes the team (LINEAR-TICKET-SPEC §1). */
  linearTeam: z.string().max(200).optional(),
  lanes: lanesSchema.optional(),
  /** A model sets the project default; null removes it (the global default applies again). */
  agentModel: agentModelSchema.nullable().optional(),
});
export const taskInput = z.strictObject({
  projectId: z.string(),
  operationId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  status: statusSchema.default("todo"),
  priority: prioritySchema.default("normal"),
  type: taskTypeSchema.optional(),
  tags: tagInputList.optional(),
  mode: z.enum(["existing", "directory", "worktree"]),
  workspaceId: z.string().optional(),
  baseRef: z.string().default(""),
  branchName: z.string().optional(),
  /** Create from this open idea (IDEAS-SPEC §6). */
  ideaId: z.string().min(1).optional(),
  /** Create as a follow-up of this card (CARD-LINKS-SPEC §3); not together with ideaId. */
  followUpOf: z.string().min(1).optional(),
  /** Create from this open workflow-insights suggestion (WORKFLOW-INSIGHTS-SPEC §5.2). */
  insightFindingId: z.string().min(1).max(100).optional(),
  /** External items added as inputs in the same write (EXTERNAL-TRACKER-SPEC §5.4, CONNECTORS-SPEC §8.2). */
  externals: z
    .array(z.strictObject({ connectionId: z.string().min(1), key: z.string().min(1).max(300), itemType: itemTypeSchema.optional() }))
    .max(connectorLimits.perCreate)
    .optional(),
});
export const taskEdit = z.strictObject({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  /** null clears the type. */
  type: taskTypeSchema.nullable().optional(),
  /** The form's final tags; applied relative to `tagsBase`, what the form opened with (CARD-TAGS-SPEC §2.5). */
  tags: tagInputList.optional(),
  tagsBase: tagInputList.optional(),
  archived: z.boolean().optional(),
  note: z.string().max(10000).optional(),
  actor: z.enum(["human", "agent"]).default("human"),
  agentId: z.string().optional(),
});
/** Add or remove single tags from the drawer; no card revision (CARD-TAGS-SPEC §3). */
export const taskTagsEdit = z
  .strictObject({
    taskId: z.string().min(1),
    add: tagInputList.default([]),
    remove: tagInputList.default([]),
  })
  .refine((input) => input.add.length || input.remove.length, { message: "Add or remove at least one tag." });
export type TaskTagsEdit = z.input<typeof taskTagsEdit>;
export type ProjectInput = z.infer<typeof projectInput>;
export type TaskInput = z.infer<typeof taskInput>;
export type TaskEdit = z.infer<typeof taskEdit>;
export const taskPlacement = z
  .strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    status: statusSchema,
    beforeId: z.string().min(1).nullable(),
    afterId: z.string().min(1).nullable(),
  })
  .refine((input) => !(input.beforeId && input.afterId), {
    message: "Choose one drop anchor.",
  });
export type TaskPlacement = z.infer<typeof taskPlacement>;

/** Chooser order: explicit position first, then creation time. */
export function projectOrder<T extends { position?: number; createdAt: string; id: string }>(a: T, b: T) {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER,
    pb = b.position ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
export type ProjectEdit = z.infer<typeof projectEdit>;
