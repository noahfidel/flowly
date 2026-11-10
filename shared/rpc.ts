import { cardDetailSchema, projectCardIndexSchema, projectIdeasSchema } from "./card-detail";
import { attentionDismissInput, attentionDismissalSchema, attentionRestoreInput } from "./attention-dismiss";
import { defineRpc } from "@getpaseo/plugin";
import { importMarkdownLimit, importRowLimit, importRowSchema } from "./ideas-import";
import { overviewResponseSchema } from "./overview";
import { storageStatusSchema } from "./storage";
import { sessionInsightViewSchema } from "./session-insights";
import { searchInputSchema, searchResultSchema } from "./search";
import { z } from "zod";
/** Lightweight sidebar: no board/events/agents cross the phone connection. */
export const readAttentionCount = defineRpc({
  name: "attention.count",
  input: z.strictObject({}),
  output: z.strictObject({ count: z.number().int().nonnegative().nullable() }),
});
import {
  ideaAdoption,
  ideaEdit,
  linkInput,
  linkSchema,
  artifactInput,
  artifactEdit,
  artifactSchema,
  workpadSchema,
  workpadCheck,
  ideaSchema,
  boardSchema,
  projectInput,
  projectEdit,
  linkedProjectInput,
  projectLinksEdit,
  projectRemoval,
  taskInput,
  taskDeletion,
  taskEdit,
  taskTagsEdit,
  taskPlacement,
  projectSchema,
  taskSchema,
  eventSchema,
  planSnapshotSchema,
} from "./model";
import { healthSchema, preparationSchema, projectIdeaInputSchema, startCardResultSchema } from "./tools";
import { connectionInput, connectionSchema, externalSummarySchema, itemTypeSchema } from "./connectors";
import { linearBoardRowSchema, linearTeamSchema } from "./linear-board";
import { composerStateSchema, composerTarget, maxImages, outgoingImageSchema, queuedMessageSchema } from "./composer";
import {
  sessionReadStateSchema,
  sessionReadReceiptSchema,
  markSessionReadInput,
  markSessionUnreadInput,
} from "./session-attention";
import { summaryEntrySchema, summaryOverviewSchema } from "./summary";
import { taskUsageSchema } from "./usage";
import { TURN_MAX_ENTRIES, tailPageSchema, timelineCursorSchema } from "./session-tail";
import { digestViewSchema } from "./digest";
import { memoryInputFields, memoryKeywordsSchema, memoryKinds, memoryTagsSchema } from "./memory";
import { guardrailEntrySchema, guardrailLimits, guardrailScopeSchema, guardrailStates, guardrailsLedgerSchema, guardrailsViewSchema } from "./guardrails";
import { perfReportSchema } from "./perf";
import { localeCodes } from "./i18n";
import { workflowOverviewSchema, workflowViewSchema } from "./workflow-insights";
import { cardTokensSchema, insightsViewSchema } from "./workflow-stats";
import { dayDetailSchema } from "./day-detail";
import {
  askAnswerInputSchema,
  askAnswerResultSchema,
  askDismissInputSchema,
  chatItemSchema,
  dispatcherStartInputSchema,
  dispatcherReplaceInputSchema,
  dispatcherSendInputSchema,
  dispatcherStartResultSchema,
  dispatcherStatusSchema,
  seenIdLimit,
  startAgainInputSchema,
} from "./dispatcher";

/** `{ etag }` in; the value is omitted when it still matches (PERFORMANCE-SPEC §3). */
const etagInput = z.strictObject({ etag: z.string().max(200).optional() });
/** Compact overview is a separate DTO/cache; it never satisfies a fresh full-board read. */
export const readOverviewChanged = defineRpc({ name: "board.overview-changed", input: etagInput, output: overviewResponseSchema });

/** Independent compact detail/project scopes, never interchangeable with Board. */
export const readCardDetailChanged = defineRpc({ name: "cards.detail-changed", input: etagInput.extend({ taskId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200) }), output: z.strictObject({ etag: z.string(), value: cardDetailSchema.optional() }) });
export const readProjectCardIndexChanged = defineRpc({ name: "projects.card-index-changed", input: etagInput.extend({ projectId: z.string().min(1).max(200) }), output: z.strictObject({ etag: z.string(), value: projectCardIndexSchema.optional() }) });
export const readProjectIdeasChanged = defineRpc({ name: "projects.ideas-changed", input: readProjectCardIndexChanged.input, output: z.strictObject({ etag: z.string(), value: projectIdeasSchema.optional() }) });

export const readSessionReceipts = defineRpc({
  name: "sessions.read-state",
  input: z.strictObject({}),
  output: sessionReadStateSchema,
});
export const markSessionRead = defineRpc({
  name: "sessions.mark-read",
  input: markSessionReadInput,
  /** Null when there was nothing to acknowledge (e.g. only a manual unread mark was cleared). */
  output: sessionReadReceiptSchema.nullable(),
});
export const markSessionUnread = defineRpc({
  name: "sessions.mark-unread",
  input: markSessionUnreadInput,
  output: sessionReadReceiptSchema,
});

/** A language's UI catalog, served on demand so the client bundle carries none (PERFORMANCE-SPEC, Cold start). */
export const i18nCatalog = defineRpc({
  name: "i18n.catalog",
  input: z.strictObject({ locale: z.enum(localeCodes.filter((c) => c !== "en") as [string, ...string[]]) }),
  output: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])),
});

/** Phone timings for the plugin log; a no-op unless the performance log setting is on. */
export const perfReport = defineRpc({
  name: "perf.report",
  input: perfReportSchema,
  output: z.object({ logged: z.boolean() }),
});

export const readBoard = defineRpc({
  name: "board.read",
  input: z.object({}),
  output: boardSchema,
});
const collectionPatch = <T extends z.ZodType>(item: T) =>
  z.object({ set: z.array(item), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional();
/** What changed since the board behind the caller's etag (PERFORMANCE-SPEC §3). */
export const boardPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  events: z.array(eventSchema),
  /** Events that left the board (a card keeps at most 100): drop them before appending `events`. */
  removeEvents: z.array(z.string()).optional(),
  plans: z.array(planSnapshotSchema).optional(),
  projects: collectionPatch(projectSchema),
  tasks: collectionPatch(taskSchema),
  ideas: collectionPatch(ideaSchema),
  links: collectionPatch(linkSchema),
  artifacts: collectionPatch(artifactSchema),
  workpads: collectionPatch(workpadSchema),
  attentionDismissals: collectionPatch(attentionDismissalSchema),
});
export const readBoardChanged = defineRpc({
  name: "board.read-changed",
  /** `since`: the caller holds this many events, the last being `lastId`; only newer ones are needed. */
  input: etagInput.extend({ since: z.strictObject({ count: z.number().int().nonnegative(), lastId: z.string().max(200) }).optional() }),
  /** `patch`: apply to the board behind the request's etag. `delta`: `value.events` holds only the events after `since`. */
  output: z.object({ etag: z.string(), value: boardSchema.optional(), delta: z.boolean().optional(), patch: boardPatchSchema.optional() }),
});
/** Read-only native-chip projection: no descriptions/history/workpads; separate etag namespace from the full board. */
export const readChipBoardChanged = defineRpc({
  name: "sessions.chip-board-changed",
  input: readBoardChanged.input,
  output: readBoardChanged.output,
});
/** Fresh single-card view for native navigation; never store under the complete board key. */
export const readCardBoard = defineRpc({
  name: "sessions.card-board",
  input: z.strictObject({ taskId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200) }),
  output: boardSchema,
});
export const createProject = defineRpc({
  name: "projects.create",
  input: projectInput,
  output: projectSchema,
});
export const createLinkedProject = defineRpc({
  name: "projects.create-linked",
  input: linkedProjectInput,
  output: projectSchema,
});
export const setProjectLinks = defineRpc({
  name: "projects.set-links",
  input: projectLinksEdit,
  output: projectSchema,
});
export const removeProject = defineRpc({
  name: "projects.remove",
  input: projectRemoval,
  output: z.object({
    id: z.string(),
    removedTasks: z.number().int(),
    backup: z.string(),
    /** Set when alsoPaseo was requested. */
    paseo: z.object({ removed: z.boolean(), workspaces: z.number().int(), error: z.string() }).optional(),
  }),
});
export const removeProjectCheck = defineRpc({
  name: "projects.remove-check",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({
    cards: z.number().int(),
    paseoProjectId: z.string(),
    /** False when the native project is already gone from Paseo. */
    paseoExists: z.boolean(),
    workspaces: z.number().int(),
    runningSessions: z.number().int(),
  }),
});
/** A project saved in a folder's `.flowly/` (PROJECT-FOLDER-SPEC §3). */
export const restoreProjectCheck = defineRpc({
  name: "projects.restore-check",
  input: z.object({ path: z.string().min(1).max(4096) }),
  output: z.union([
    z.object({ found: z.literal(false) }),
    z.object({
      found: z.literal(true),
      title: z.string(),
      cards: z.number().int(),
      savedAt: z.string(),
      /** Set: restore is refused (unreadable file, or the project is already on the board). */
      conflict: z.enum(["", "invalid", "on-board"]),
      /** Cards whose workspace is bound by another card; restored without it. */
      unbound: z.number().int(),
    }),
  ]),
});
export const restoreProject = defineRpc({
  name: "projects.restore",
  input: z.object({ path: z.string().min(1).max(4096) }),
  output: z.object({ project: projectSchema, cards: z.number().int(), unbound: z.number().int() }),
});
/** Where the project's board copy lives and whether its last write worked. */
export const projectFolderState = defineRpc({
  name: "projects.folder-state",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ path: z.string(), savedAt: z.string(), error: z.string() }),
});
export const nativePickers = ["finder", "explorer", "zenity", "kdialog"] as const;
export const listDirectories = defineRpc({
  name: "fs.list-directories",
  input: z.object({ path: z.string().max(4096).optional() }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    home: z.string(),
    native: z.enum(nativePickers).nullable(),
    truncated: z.boolean(),
    entries: z.array(z.object({ name: z.string(), path: z.string(), git: z.boolean() })),
  }),
});
export const pickNativeDirectory = defineRpc({
  name: "fs.pick-native",
  input: z.object({ multiple: z.boolean().default(false) }),
  output: z.object({ paths: z.array(z.string()) }),
});
export const updateProject = defineRpc({
  name: "projects.update",
  input: projectEdit,
  output: projectSchema,
});
export const createTask = defineRpc({
  name: "tasks.create",
  input: taskInput,
  output: taskSchema,
});
export const updateTask = defineRpc({
  name: "tasks.update",
  input: taskEdit,
  output: taskSchema,
});
/** Add or remove single tags without the card revision (CARD-TAGS-SPEC §3). */
export const updateTaskTags = defineRpc({
  name: "tasks.tags",
  input: taskTagsEdit,
  output: taskSchema,
});
/** Dismiss or restore an idea (IDEAS-SPEC §7). */
export const updateIdea = defineRpc({
  name: "ideas.update",
  input: ideaEdit,
  output: ideaSchema,
});
/** Propose an idea that belongs to a project, not a card (PROJECT-IDEAS-SPEC §4). */
export const createProjectIdea = defineRpc({
  name: "ideas.create-project",
  input: z.strictObject({ projectId: z.string().min(1), idea: projectIdeaInputSchema }),
  output: ideaSchema,
});
/** Read pasted backlog markdown into review rows, flagging titles already open in the project (IDEAS-IMPORT-EXPORT-SPEC §3). */
export const importIdeasPreview = defineRpc({
  name: "ideas.import-preview",
  input: z.strictObject({ projectId: z.string().min(1), markdown: z.string().max(importMarkdownLimit) }),
  output: z.strictObject({ rows: z.array(importRowSchema), duplicates: z.array(z.number().int().nonnegative()) }),
});
/** Create the rows the user kept as project ideas; the same `operationId` returns the first result (§4). */
export const importIdeas = defineRpc({
  name: "ideas.import",
  input: z.strictObject({ projectId: z.string().min(1), rows: z.array(importRowSchema).max(importRowLimit), operationId: z.string().min(1).max(200) }),
  output: z.strictObject({ created: z.number().int().nonnegative(), skipped: z.array(z.strictObject({ line: z.number().int(), reason: z.string() })) }),
});
/** Hide a card from Attention until something new happens (ATTENTION-DISMISS-SPEC §5). */
export const dismissAttention = defineRpc({
  name: "attention.dismiss",
  input: attentionDismissInput,
  output: attentionDismissalSchema,
});
/** Put a dismissed card back into Attention. */
export const restoreAttention = defineRpc({
  name: "attention.restore",
  input: attentionRestoreInput,
  output: z.object({ taskId: z.string() }),
});
/** Accept an idea in its own card: send it to one of the card's sessions (IDEAS-SPEC §6.2). */
export const adoptIdea = defineRpc({
  name: "ideas.adopt",
  input: ideaAdoption,
  output: ideaSchema,
});
/** Link two cards of one project (CARD-LINKS-SPEC §3). */
export const createLink = defineRpc({
  name: "links.create",
  input: linkInput,
  output: linkSchema,
});
export const deleteLink = defineRpc({
  name: "links.delete",
  input: z.strictObject({ id: z.string().min(1) }),
  output: z.object({ id: z.string() }),
});
/** Connections and read-only external inputs (CONNECTORS-SPEC, EXTERNAL-TRACKER-SPEC). Credentials never leave the daemon. */
export const listConnections = defineRpc({
  name: "connectors.connections",
  input: z.object({}),
  /** linkedCards: per connection id, the cards whose inputs read through it (the removal warning, CONNECTORS-SPEC). */
  output: z.object({ connections: z.array(connectionSchema), linkedCards: z.record(z.string(), z.number().int().nonnegative()) }),
});
export const saveConnection = defineRpc({
  name: "connectors.connection-save",
  input: connectionInput,
  output: connectionSchema,
});
/** Checks an address and token with the service without saving them. */
export const testConnection = defineRpc({
  name: "connectors.connection-test",
  input: connectionInput,
  output: z.object({ account: z.string(), baseUrl: z.string() }),
});
export const deleteConnection = defineRpc({
  name: "connectors.connection-delete",
  input: z.strictObject({ id: z.string().min(1) }),
  output: z.object({ id: z.string() }),
});
/**
 * Picker rows: my recent items for an empty query, else by key, link, number or text.
 * GitHub/GitLab search the project's repositories unless `all` (CONNECTORS-SPEC §4.3).
 */
export const searchExternal = defineRpc({
  name: "connectors.search",
  input: z.strictObject({ connectionId: z.string().min(1), query: z.string().max(500), projectId: z.string().min(1).optional(), all: z.boolean().optional() }),
  output: z.object({ results: z.array(externalSummarySchema) }),
});
/** Current summaries of a card's external inputs (cached up to 30 minutes unless `refresh`). */
export const cardExternals = defineRpc({
  name: "connectors.card",
  input: z.strictObject({ taskId: z.string().min(1), refresh: z.boolean().optional() }),
  output: z.object({
    items: z.array(z.object({ artifactId: z.string(), summary: externalSummarySchema, stale: z.boolean() })),
    /** External inputs whose connection was removed: shown as plain links until it is added again. */
    removed: z.array(z.string()).default([]),
  }),
});
export const readExternal = defineRpc({
  name: "connectors.read",
  input: z.strictObject({ artifactId: z.string().min(1), refresh: z.boolean().optional() }),
  output: z.object({ summary: externalSummarySchema, markdown: z.string(), truncated: z.boolean(), stale: z.boolean(), fetchedAt: z.string() }),
});
/** The preview of an item that is not a card input (yet): the Linear board's issues (LINEAR-BOARD-SPEC §5). */
export const readExternalItem = defineRpc({
  name: "connectors.read-item",
  input: z.strictObject({ connectionId: z.string().min(1), key: z.string().min(1).max(300), itemType: itemTypeSchema.optional(), refresh: z.boolean().optional() }),
  output: z.object({ summary: externalSummarySchema, markdown: z.string(), truncated: z.boolean(), stale: z.boolean(), fetchedAt: z.string() }),
});
/** The Linear board (LINEAR-BOARD-SPEC §3.4): my issues, or a team's; finished ones only from the last `recentDays` (0 = all). */
export const linearBoard = defineRpc({
  name: "connectors.linear-board",
  input: z.strictObject({ connectionId: z.string().min(1), teamId: z.string().min(1).max(200).optional(), recentDays: z.number().int().min(0).max(365) }),
  output: z.object({ issues: z.array(linearBoardRowSchema), truncated: z.boolean() }),
});
export const linearTeams = defineRpc({
  name: "connectors.linear-teams",
  input: z.strictObject({ connectionId: z.string().min(1) }),
  output: z.object({ teams: z.array(linearTeamSchema) }),
});
/** Card artifacts: references to files and links (CARD-ARTIFACTS-SPEC §3). */
export const createArtifact = defineRpc({
  name: "artifacts.create",
  input: artifactInput,
  output: artifactSchema,
});
export const updateArtifact = defineRpc({
  name: "artifacts.update",
  input: artifactEdit,
  output: artifactSchema,
});
export const deleteArtifact = defineRpc({
  name: "artifacts.delete",
  input: z.strictObject({ id: z.string().min(1) }),
  output: z.object({ id: z.string() }),
});
/** A person ticks an acceptance criterion (WORKPAD-SPEC §6.3). */
export const checkWorkpad = defineRpc({
  name: "workpads.check",
  input: workpadCheck,
  output: workpadSchema,
});
/** A person's Rerun of a card's automatic review (AUTO-REVIEW-SPEC §7). */
export const rerunReview = defineRpc({
  name: "reviews.rerun",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
/** Ids of a card's file artifacts that no longer exist (CARD-ARTIFACTS-SPEC §9). */
export const artifactStatus = defineRpc({
  name: "artifacts.status",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: z.object({ missing: z.array(z.string()) }),
});
/** Whether the review ledger folder can be read (REVIEW-LEDGERS-SPEC §5), for the settings screen. */
export const reviewLedgerCheck = defineRpc({
  name: "review-ledgers.check",
  input: z.strictObject({}),
  output: z.object({ attach: z.boolean(), usable: z.boolean(), reason: z.enum(["missing", "outside"]).optional() }),
});
export const previewArtifact = defineRpc({
  name: "artifacts.preview",
  input: z.strictObject({ id: z.string().min(1) }),
  output: z.discriminatedUnion("type", [
    z.object({ type: z.literal("image"), dataUri: z.string() }),
    z.object({ type: z.literal("text"), text: z.string(), markdown: z.boolean() }),
    z.object({
      type: z.literal("directory"),
      entries: z.array(z.object({ name: z.string(), directory: z.boolean() })),
      more: z.boolean(),
    }),
    z.object({ type: z.literal("unsupported"), size: z.number() }),
  ]),
});
export const deleteTask = defineRpc({
  name: "tasks.delete",
  input: taskDeletion,
  output: z.object({
    id: z.string(),
    backup: z.string(),
    /** Set when `archive` was requested. */
    archived: z.object({ sessions: z.number().int(), workspace: z.boolean() }).optional(),
  }),
});
export const moveTask = defineRpc({
  name: "tasks.move",
  input: z.object({
    id: z.string(),
    revision: z.number(),
    direction: z.enum(["up", "down"]),
  }),
  output: taskSchema,
});
export const placeTask = defineRpc({
  name: "tasks.place",
  input: taskPlacement,
  output: taskSchema,
});
export const listResources = defineRpc({
  name: "resources.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({ id: z.string(), name: z.string(), path: z.string() }),
    ),
    workspaces: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        name: z.string(),
        path: z.string(),
        status: z.string(),
        /** Paseo's workspaceKind: directory, local_checkout, checkout or worktree (CARD-DISPLAY-SPEC §8). */
        kind: z.string().optional(),
        /** A background (hidden) workspace, such as a PR-review one: counts for card availability and opening, not for pickers. */
        background: z.boolean().optional(),
        repoPaths: z.array(z.string()),
        owner: z.string(),
      }),
    ),
  }),
});
export const readResourcesChanged = defineRpc({
  name: "resources.read-changed",
  input: etagInput,
  output: z.object({ etag: z.string(), value: listResources.output.optional() }),
});
export const taskContext = defineRpc({
  name: "tasks.context",
  input: z.object({ id: z.string() }),
  output: z.object({
    available: z.boolean(),
    reason: z.string(),
    context: z.string(),
    owner: z.string(),
    workspaceRepoPaths: z.array(z.string()),
    directories: z.array(z.object({ repo: z.string(), directory: z.string() })),
  }),
});
export const toolsHealth = defineRpc({
  name: "tools.health",
  input: z.object({}),
  output: healthSchema,
});
export const prepareSession = defineRpc({
  name: "tools.prepare-session",
  input: z.object({ id: z.string(), operationId: z.string().min(1).max(200) }),
  output: preparationSchema,
});
export const prepareExisting = defineRpc({
  name: "tools.prepare-existing",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: preparationSchema,
});
export const accessState = defineRpc({
  name: "tools.access-state",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: healthSchema.extend({
    methods: z.array(z.string()),
    lastSuccessAt: z.string().nullable(),
    lastAction: z.string().nullable(),
  }),
});
export const wrapupCheckSchema = z.object({
  taskId: z.string(),
  revision: z.number().int(),
  workspace: z
    .object({ id: z.string(), kind: z.string(), directory: z.string() })
    .nullable(),
  archiveWorkspace: z.boolean(),
  sessions: z.number().int(),
  git: z
    .object({
      branch: z.string(),
      uncommitted: z.number().int(),
      unpushed: z.number().int(),
    })
    .nullable(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type WrapupCheck = z.infer<typeof wrapupCheckSchema>;
export const wrapupResultSchema = z.object({
  archivedSessions: z.number().int(),
  archivedWorkspace: z.boolean(),
  note: z.string(),
});
export type WrapupResult = z.infer<typeof wrapupResultSchema>;
export const wrapupCheck = defineRpc({
  name: "tasks.wrapup-check",
  input: z.strictObject({ id: z.string().min(1) }),
  output: wrapupCheckSchema,
});
export const wrapup = defineRpc({
  name: "tasks.wrapup",
  input: z.strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    acknowledgeWarnings: z.boolean(),
    /** Archive the sessions/workspace but leave the card on the board (the prompt after a move to Done/Cancelled). */
    keepCard: z.boolean().optional(),
  }),
  output: wrapupResultSchema,
});
/** Preflight for archiving Paseo resources before a permanent delete. */
export const deleteCheck = defineRpc({
  name: "tasks.delete-check",
  input: z.strictObject({ id: z.string().min(1) }),
  output: wrapupCheckSchema,
});
/** Workspace switch (WORKSPACE-SWITCH-SPEC §3, §9): preflight of either direction. */
const switchDirection = z.enum(["to_worktree", "to_local"]);
const branchSideSchema = z.object({
  branch: z.string(),
  /** Commits of this side the other side's branch does not contain. */
  notInOther: z.number().int(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), at: z.string() })),
});
/** Switch to local (§9.1): the worktree and the main checkout side by side. */
export const switchCompareSchema = z.object({
  worktree: branchSideSchema,
  main: branchSideSchema,
  /**
   * Changed files grouped by their first two directory levels (`folderOf`): how many changed
   * on each side and what Copy does with the worktree's. Conflicts first, then changed on
   * both sides, worktree only, main checkout only. Capped.
   */
  folders: z.array(
    z.object({
      path: z.string(),
      worktree: z.number().int(),
      main: z.number().int(),
      apply: z.number().int(),
      present: z.number().int(),
      conflicts: z.number().int(),
    }),
  ),
  totals: z.object({ worktree: z.number().int(), main: z.number().int(), both: z.number().int(), files: z.number().int(), folders: z.number().int() }),
});
export type SwitchCompare = z.infer<typeof switchCompareSchema>;
export const switchCheckSchema = z.object({
  taskId: z.string(),
  revision: z.number().int(),
  direction: switchDirection,
  workspace: z.object({ id: z.string(), kind: z.string(), directory: z.string() }).nullable(),
  /** The card owns its current workspace: it is archived, else only the card's sessions. */
  archiveWorkspace: z.boolean(),
  sessions: z.number().int(),
  /** Idle sessions of the card that can be asked for a handover (§2.2). */
  idleSessions: z.array(z.object({ id: z.string(), title: z.string() })),
  mainBranch: z.string().nullable(),
  base: z.string().nullable(),
  /** Suggested branch for the new worktree (to_worktree). */
  branchName: z.string(),
  copy: z
    .object({ tracked: z.number().int(), untracked: z.number().int(), bytes: z.number(), files: z.array(z.string()) })
    .nullable(),
  handover: z.object({ at: z.string(), files: z.number().int(), session: z.string() }).nullable(),
  /** The worktree being left (to_local). */
  worktree: z
    .object({
      branch: z.string(),
      uncommitted: z.number().int(),
      notIntegrated: z.number().int(),
      /**
       * With uncommitted changes: what "Copy to the main checkout" would do (§9).
       * `files` apply, `present` are already there, `conflicts` refuse the copy.
       */
      copyBack: z.object({ files: z.number().int(), present: z.number().int(), conflicts: z.array(z.string()), busy: z.string().nullable() }).nullable(),
    })
    .nullable(),
  compare: switchCompareSchema.nullable(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SwitchCheck = z.infer<typeof switchCheckSchema>;
export const switchCheck = defineRpc({
  name: "tasks.switch-check",
  input: z.strictObject({ id: z.string().min(1), direction: switchDirection }),
  output: switchCheckSchema,
});
export const switchWorkspace = defineRpc({
  name: "tasks.switch",
  input: z.strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    operationId: z.string().min(1).max(200),
    direction: switchDirection,
    branchName: z.string().trim().max(200).optional(),
    /**
     * to_local with uncommitted worktree changes (§9): copy them to the main checkout (refused on conflicts),
     * overwrite (copy, and the worktree's file wins where both changed it), or discard. A patch is kept either way.
     */
    uncommitted: z.enum(["copy", "overwrite", "discard"]).optional(),
  }),
  output: z.object({ workspaceId: z.string(), directory: z.string(), branch: z.string().nullable(), copied: z.number().int(), warnings: z.array(z.string()) }),
});
/** Sends the fixed handover prompt to an idle session of the card (§2.2). */
export const askHandover = defineRpc({
  name: "tasks.ask-handover",
  input: z.strictObject({ id: z.string().min(1), agentId: z.string().min(1) }),
  output: z.object({ sent: z.boolean() }),
});
/** Release from main (§5): preflight, run, undo. */
export const releaseCheckSchema = z.object({
  taskId: z.string(),
  revision: z.number().int(),
  files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
  /** Identifies the release patch the user saw; a changed patch refuses the run. */
  patchHash: z.string(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ReleaseCheck = z.infer<typeof releaseCheckSchema>;
export const releaseCheck = defineRpc({
  name: "tasks.release-check",
  input: z.strictObject({ id: z.string().min(1) }),
  output: releaseCheckSchema,
});
export const releaseChanges = defineRpc({
  name: "tasks.release",
  input: z.strictObject({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    operationId: z.string().min(1).max(200),
    patchHash: z.string().min(1),
    acknowledgeWarnings: z.boolean(),
  }),
  output: z.object({ files: z.number().int() }),
});
export const releaseUndo = defineRpc({
  name: "tasks.release-undo",
  input: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive(), operationId: z.string().min(1).max(200) }),
  output: z.object({ files: z.number().int() }),
});
export const managedSessions = defineRpc({
  name: "sessions.managed",
  input: z.strictObject({}),
  output: z.array(
    z.object({ agentId: z.string(), taskId: z.string(), workspaceId: z.string() }),
  ),
});
/** What the native session pane's Flowly chips need besides the board (NATIVE-SESSION-SPEC §8). */
export const nativeChips = defineRpc({
  name: "sessions.native-chips",
  input: z.strictObject({}),
  output: z.object({
    managed: z.array(z.object({ agentId: z.string(), taskId: z.string(), workspaceId: z.string() })),
    /** The Ideas switch (IDEAS-INBOX-SPEC §10): off hides the Ideas chip. */
    ideas: z.boolean(),
    /** Auto wrap up (MULTITASK-SPEC): on, Move to Done on the Next moves card asks nothing. */
    autoWrapup: z.boolean(),
    /** What tapping a message suggestion on the Next moves card does (NATIVE-SESSION-SPEC §6.4). */
    nextMoveTap: z.enum(["fill", "copy"]),
    /** Sessions Flowly does not manage (NATIVE-SESSION-SPEC §12.6): the switch and its three parts. */
    outside: z.object({ enabled: z.boolean(), progress: z.boolean(), nextMoves: z.boolean(), ideas: z.boolean() }),
  }),
});
/** Sessions Flowly does not manage: each one's current suggestion and open ideas (NATIVE-SESSION-SPEC §12.7). */
export const sessionInsights = defineRpc({
  name: "sessions.insights",
  input: z.strictObject({ etag: z.string().max(200).optional() }),
  output: z.object({ etag: z.string(), value: z.array(sessionInsightViewSchema).optional() }),
});
const sessionIdeaTarget = z.strictObject({ agentId: z.string().min(1).max(200), ideaId: z.string().min(1).max(200) });
export const runSessionIdea = defineRpc({
  name: "sessions.idea-run",
  input: sessionIdeaTarget.extend({ target: z.enum(["here", "session", "workspace"]) }),
  output: z.object({ target: z.enum(["here", "session", "workspace"]), agentId: z.string().optional(), workspaceId: z.string().optional() }),
});
export const dismissSessionIdea = defineRpc({
  name: "sessions.idea-dismiss",
  input: sessionIdeaTarget,
  output: z.object({ ok: z.literal(true) }),
});
export const configureSession = defineRpc({
  name: "sessions.configure",
  input: z
    .strictObject({
      taskId: z.string().min(1).max(200),
      // IDs become CLI arguments: never allow a leading "-" (option injection).
      agentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
      thinkingOptionId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
      modeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
      stop: z.boolean().optional(),
      /** New display name of the session; a single line. */
      title: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "A title is a single line.").optional(),
    })
    .refine((i) => i.thinkingOptionId || i.modeId || i.stop || i.title, { message: "Nothing to change." }),
  output: z.object({ applied: z.array(z.string()) }),
});
export const readComposer = defineRpc({
  name: "composer.read",
  input: z.strictObject({}),
  output: composerStateSchema,
});
export const saveDraft = defineRpc({
  name: "composer.draft",
  input: composerTarget.extend({ text: z.string().max(20000) }),
  output: z.object({ ok: z.boolean() }),
});
export const queueMessage = defineRpc({
  name: "composer.queue",
  input: composerTarget
    .extend({ text: z.string().trim().max(20000), images: z.array(outgoingImageSchema).max(maxImages).optional() })
    .refine((v) => !!v.text || !!v.images?.length, "Write a message or attach an image."),
  output: queuedMessageSchema,
});
export const unqueueMessage = defineRpc({
  name: "composer.unqueue",
  input: z.strictObject({ agentId: z.string().min(1).max(200), id: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});
export const sendQueuedNow = defineRpc({
  name: "composer.send-now",
  input: composerTarget.extend({ id: z.string().min(1).max(200) }),
  output: z.object({ sent: z.boolean() }),
});
export const sessionImage = defineRpc({
  name: "sessions.image",
  input: z.strictObject({
    taskId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    src: z.string().min(1).max(4096),
  }),
  output: z.object({ dataUri: z.string() }),
});
export const moveProject = defineRpc({
  name: "projects.move",
  input: z
    .strictObject({
      id: z.string().min(1).max(200),
      direction: z.enum(["up", "down", "top"]).optional(),
      /** Target index in the ordered list (drag and drop). */
      to: z.number().int().min(0).max(10000).optional(),
    })
    .refine((v) => (v.direction === undefined) !== (v.to === undefined), "Give either direction or to."),
  output: z.array(z.string()),
});
export const readSummaries = defineRpc({
  name: "summaries.read",
  input: z.strictObject({}),
  output: summaryOverviewSchema,
});
export const readSummariesChanged = defineRpc({
  name: "summaries.read-changed",
  input: etagInput,
  output: z.object({ etag: z.string(), value: summaryOverviewSchema.optional() }),
});
export const sessionTail = defineRpc({
  name: "sessions.tail",
  input: z.strictObject({
    taskId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100),
    /**
     * tail (default): the newest `limit` entries. turn: from the latest user
     * message on, at most `maxEntries`. before/after: one page next to `cursor`
     * (SESSION-PANE-SPEC §1.4).
     */
    mode: z.enum(["tail", "turn", "before", "after"]).optional(),
    cursor: timelineCursorSchema.optional(),
    maxEntries: z.number().int().min(1).max(TURN_MAX_ENTRIES).optional(),
  }),
  output: tailPageSchema,
});
export const archivedSessions = defineRpc({
  name: "sessions.archived",
  input: z.strictObject({ taskId: z.string().min(1).max(200) }),
  // Paseo agent snapshots, passed through as the daemon returns them.
  output: z.array(z.looseObject({ id: z.string(), archivedAt: z.string().nullish() })),
});
/**
 * The archived sessions that sit in a card's workspace, as bare ids: what the
 * Task chip needs (PERFORMANCE-SPEC, chip scan). Paging every agent on the host
 * took 7-13 s to decode on a phone; the daemon does it locally.
 */
export const archivedSessionRefs = defineRpc({
  name: "sessions.archived-refs",
  input: z.strictObject({}),
  output: z.array(z.object({ id: z.string(), workspaceId: z.string() })),
});
export const summaryHistory = defineRpc({
  name: "summaries.history",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: z.array(summaryEntrySchema),
});
export const refreshSummary = defineRpc({
  name: "summaries.refresh",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: z.object({ queued: z.boolean() }),
});
/** How many chats a card has for Progress to summarize (TASK-SUMMARY-SPEC §2.1); 0 for an unknown card. */
export const cardChats = defineRpc({
  name: "summaries.chats",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: z.object({ count: z.number().int().min(0) }),
});
/** Quick task: the AI title, type and tags, applied by the daemon in the background (QUICK-TASK-SPEC §4). */
export const quickTaskTitle = defineRpc({
  name: "tasks.quick-title",
  input: z.strictObject({ taskId: z.string().min(1), text: z.string().min(1).max(20000), provisionalTitle: z.string().max(200) }),
  output: z.object({ started: z.boolean() }),
});
export const taskUsage = defineRpc({
  name: "usage.task",
  input: z.strictObject({ taskId: z.string().min(1) }),
  output: taskUsageSchema,
});

/** Project Insights (PROJECT-INSIGHTS-SPEC §8). `tz` is the client's IANA zone. */
const insightsDay = {
  projectId: z.string().min(1),
  tz: z.string().max(100),
};
export const projectInsights = defineRpc({
  name: "insights.project",
  input: z.strictObject({ ...insightsDay, etag: z.string().max(200).optional() }),
  output: z.object({ etag: z.string(), value: insightsViewSchema.optional() }),
});
export const projectDigest = defineRpc({
  name: "insights.digest",
  input: z.strictObject({ ...insightsDay, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  output: digestViewSchema,
});
/** One day for the day summary card (INSIGHTS-REDESIGN-SPEC §2.2, §7); `tokens` also reads local provider logs. */
export const projectDay = defineRpc({
  name: "insights.day",
  input: z.strictObject({ ...insightsDay, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: z.boolean().optional() }),
  output: dayDetailSchema,
});
export const refreshDigest = defineRpc({
  name: "insights.digest-refresh",
  input: z.strictObject({ ...insightsDay, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  output: z.object({ queued: z.boolean() }),
});
export const projectTokens = defineRpc({
  name: "insights.tokens",
  input: z.strictObject({ ...insightsDay, etag: z.string().max(200).optional() }),
  output: z.object({ etag: z.string(), value: cardTokensSchema.optional() }),
});

// ---- Workflow insights (WORKFLOW-INSIGHTS-SPEC §6) ----
export const workflowInsights = defineRpc({
  name: "workflow-insights.get",
  input: z.strictObject({ projectId: z.string().min(1).max(200), etag: z.string().max(200).optional() }),
  output: z.object({ etag: z.string(), value: workflowViewSchema.optional() }),
});
export const runWorkflowInsights = defineRpc({
  name: "workflow-insights.run",
  input: z.strictObject({ projectId: z.string().min(1).max(200) }),
  output: z.object({ queued: z.boolean() }),
});
export const setWorkflowFinding = defineRpc({
  name: "workflow-insights.set-status",
  input: z.strictObject({
    projectId: z.string().min(1).max(200),
    findingId: z.string().min(1).max(100),
    status: z.enum(["open", "dismissed"]),
    expectedRevision: z.number().int().min(0),
  }),
  output: z.object({ revision: z.number() }),
});
/** Writes an open skill draft into the project (INSIGHTS-REDESIGN-SPEC §4.1). */
export const installSkill = defineRpc({
  name: "workflow-insights.install-skill",
  input: z.strictObject({ projectId: z.string().min(1).max(200), findingId: z.string().min(1).max(100), expectedRevision: z.number().int().min(0) }),
  output: z.object({ revision: z.number(), path: z.string(), linked: z.boolean(), notice: z.string().optional() }),
});
/** The closed loop's numbers for the top of Insights (GUARDRAILS-SPEC §7.2, §7.5); `tz` is the client's IANA zone. */
export const guardrailsInsights = defineRpc({
  name: "insights.guardrails",
  input: z.strictObject({ ...insightsDay }),
  output: guardrailsLedgerSchema,
});
export const workflowInsightsOverview = defineRpc({
  name: "workflow-insights.overview",
  input: z.strictObject({}),
  output: workflowOverviewSchema,
});
export const purgeWorkflowCommands = defineRpc({
  name: "workflow-insights.purge",
  input: z.strictObject({}),
  output: z.object({ deletedProjects: z.number() }),
});

// ---- Search (SEARCH-SPEC §4) ----
export const searchQuery = defineRpc({ name: "search.query", input: searchInputSchema, output: searchResultSchema });

// ---- Project guardrails (GUARDRAILS-SPEC §7.5) ----
const guardrailRef = { id: z.string().min(1).max(200), revision: z.number().int().positive() };
const commandName = z.string().trim().min(1).max(guardrailLimits.commandName);
const commandArgv = z.array(z.string().min(1).max(guardrailLimits.arg)).min(1).max(guardrailLimits.args);
const commandTimeout = z.number().int().min(guardrailLimits.minTimeout).max(guardrailLimits.maxTimeout);
export const readGuardrails = defineRpc({
  name: "guardrails.read",
  input: z.strictObject({ projectId: z.string().min(1).max(200), etag: z.string().max(200).optional() }),
  output: z.object({ etag: z.string(), value: guardrailsViewSchema.optional() }),
});
/** The overview chips: per project, observing commands, guidelines learned this week and memory added this week. */
export const guardrailCounts = defineRpc({
  name: "guardrails.counts",
  input: etagInput,
  output: z.object({ etag: z.string(), value: z.record(z.string(), z.object({ observing: z.number(), added: z.number(), notes: z.number() })).optional() }),
});
/** A person's command or note, active at once; guidelines only grow from cards sent back (§7.4). */
export const createGuardrail = defineRpc({
  name: "guardrails.create",
  input: z.discriminatedUnion("kind", [
    z.strictObject({ projectId: z.string().min(1).max(200), kind: z.literal("command"), text: commandName, argv: commandArgv, timeoutSec: commandTimeout.optional() }),
    z.strictObject({
      projectId: z.string().min(1).max(200),
      kind: z.literal("note"),
      noteKind: z.enum(memoryKinds),
      text: memoryInputFields.title,
      body: memoryInputFields.body.optional(),
      tags: memoryTagsSchema.optional(),
      keywords: memoryKeywordsSchema.optional(),
      pinned: z.boolean().optional(),
    }),
  ]),
  output: guardrailEntrySchema,
});
export const updateGuardrail = defineRpc({
  name: "guardrails.update",
  input: z.strictObject({
    ...guardrailRef,
    text: z.string().trim().min(1).max(guardrailLimits.guidelineText).optional(),
    body: z.string().trim().max(guardrailLimits.body).optional(),
    argv: commandArgv.optional(),
    timeoutSec: commandTimeout.optional(),
    scope: guardrailScopeSchema.optional(),
    tags: memoryTagsSchema.optional(),
    keywords: memoryKeywordsSchema.optional(),
    pinned: z.boolean().optional(),
    state: z.enum(guardrailStates).optional(),
    stateReason: z.string().trim().max(guardrailLimits.stateReason).optional(),
  }),
  output: guardrailEntrySchema,
});
export const deleteGuardrail = defineRpc({ name: "guardrails.delete", input: z.strictObject(guardrailRef), output: z.object({ id: z.string() }) });
/** The project's check commands found in its root, added as observing; never runs them (§4.5). */
export const detectGuardrails = defineRpc({
  name: "guardrails.detect",
  input: z.strictObject({ projectId: z.string().min(1).max(200) }),
  output: z.object({ found: z.array(z.string()), added: z.array(guardrailEntrySchema) }),
});
/** The finished-card review by hand (for developers; not in the UI). */
export const retroGuardrails = defineRpc({
  name: "guardrails.retro",
  input: z.strictObject({ taskId: z.string().min(1).max(200) }),
  output: z.object({ queued: z.boolean() }),
});
/** Settings > Storage (SQLITE-STORAGE-SPEC §9): works while the board itself cannot be read. */
export const readStorageStatus = defineRpc({ name: "storage.status", input: z.strictObject({}), output: storageStatusSchema });
export const backupStorage = defineRpc({ name: "storage.backup", input: z.strictObject({}), output: z.strictObject({ name: z.string() }) });
export const restoreStorage = defineRpc({
  name: "storage.restore",
  input: z.strictObject({ name: z.string().min(1).max(200) }),
  output: z.strictObject({ aside: z.string().nullable() }),
});
export const exportStorage = defineRpc({ name: "storage.export-json", input: z.strictObject({}), output: z.strictObject({ retired: z.string().nullable() }) });
/** The live projects (or one) as markdown: open cards, open ideas, active memory (IDEAS-IMPORT-EXPORT-SPEC §7). */
export const exportBoardMarkdown = defineRpc({
  name: "board.export-markdown",
  input: z.strictObject({ projectId: z.string().min(1).optional() }),
  output: z.strictObject({ markdown: z.string() }),
});
export const useSqliteStorage = defineRpc({ name: "storage.use-sqlite", input: z.strictObject({}), output: z.strictObject({}) });
/** The dispatcher session's state (DISPATCHER-SPEC §3, §8). */
export const dispatcherStatus = defineRpc({ name: "dispatcher.status", input: z.strictObject({}), output: dispatcherStatusSchema });
/** Starts a new dispatcher session; refused while one is up (DISPATCHER-SPEC §3, §8). */
export const dispatcherStart = defineRpc({ name: "dispatcher.start", input: dispatcherStartInputSchema, output: dispatcherStartResultSchema });
/** Replace an unguarded dispatcher: the user's confirmed click only; never a dispatcher tool (DISPATCHER-SPEC §3). */
export const dispatcherReplace = defineRpc({ name: "dispatcher.replace", input: dispatcherReplaceInputSchema, output: dispatcherStartResultSchema });
/** The chat's own items plus "Changed since you looked" (DISPATCHER-SPEC §9.1, §9.2). */
export const dispatcherItemsChanged = defineRpc({
  name: "dispatcher.items-changed",
  input: etagInput,
  output: z.object({ etag: z.string(), value: z.array(chatItemSchema).optional() }),
});
/** The dispatcher's transcript: `sessions.tail` for the stored dispatcher session only (DISPATCHER-SPEC §9.3). */
export const dispatcherTail = defineRpc({ name: "dispatcher.tail", input: sessionTail.input.omit({ taskId: true }), output: tailPageSchema });
/**
 * Mark seen: the change line counts from `revision` on, except the event `ids` seen at that very ms; never moves
 * back, clamped to the daemon's clock (DISPATCHER-SPEC §9.2).
 */
export const dispatcherMarkSeen = defineRpc({
  name: "dispatcher.mark-seen",
  input: z.strictObject({ revision: z.number().int().nonnegative(), ids: z.array(z.string().min(1).max(300)).max(seenIdLimit).optional() }),
  output: z.strictObject({ seenRevision: z.number().int().nonnegative() }),
});
/** The user's chat message to the dispatcher, sent by the daemon; refused for an unguarded one (DISPATCHER-SPEC §3, §9.3). */
export const dispatcherSend = defineRpc({ name: "dispatcher.send", input: dispatcherSendInputSchema, output: z.strictObject({ sent: z.literal(true) }) });
/** "What should I do?" with the changed cards, sent to the dispatcher (DISPATCHER-SPEC §9.2). */
export const dispatcherWhatNext = defineRpc({ name: "dispatcher.what-next", input: z.strictObject({}), output: z.strictObject({ sent: z.literal(true) }) });
/** Answers one ask from the chat, re-checked against its session; `delivered` only after the Paseo call resolved (DISPATCHER-SPEC §9.4). */
export const asksAnswer = defineRpc({ name: "asks.answer", input: askAnswerInputSchema, output: askAnswerResultSchema });
/** Dismisses one ask: its signal joins the card's dismissal set (ATTENTION-DISMISS-SPEC §7a). */
export const asksDismiss = defineRpc({ name: "asks.dismiss", input: askDismissInputSchema, output: z.strictObject({ taskId: z.string() }) });
/** The signals the chat resolved (answered, ended or dismissed there), sorted, for the board's bell (DISPATCHER-SPEC §9.4). */
export const asksResolved = defineRpc({
  name: "asks.resolved",
  input: etagInput,
  output: z.object({ etag: z.string(), value: z.array(z.string().max(1000)).max(10000).optional() }),
});
/** Start again on an ended ask: the flowly_start_card path, started by the user (DISPATCHER-SPEC §9.4). */
export const startAgain = defineRpc({ name: "tasks.start-again", input: startAgainInputSchema, output: startCardResultSchema });

/** Whether telemetry is forced off on the daemon's host by DO_NOT_TRACK / FLOWLY_TELEMETRY=0 / NODE_ENV=test, or by a build without a PostHog key (`builtOff`) (TELEMETRY-SPEC §5, §6). */
export const telemetryStatus = defineRpc({ name: "telemetry.status", input: z.strictObject({}), output: z.object({ forcedOff: z.boolean(), builtOff: z.boolean().default(false) }) });
