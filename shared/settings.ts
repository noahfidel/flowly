import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { boardSorts } from "./sort";
import { priorities, statusSchema, statuses, taskTypes } from "./model";
import { languageChoices, localeCodes } from "./i18n";
import { aiLanguageChoices } from "./ai-language";
import { cardActivityModes } from "./card-display";
import { linearColumns } from "./linear-board";
import { defaultDeliveryMode, deliveryModes } from "./delivery-mode";
import { agentModelSchema } from "./agent-defaults";

/** Host-scoped board view preferences (not board data). */
export const boardViewSettings = defineSettings({
  id: "board-view",
  scope: "host",
  version: 1,
  schema: z.object({
    lastProjectId: z.string().max(200).default(""),
    /** Mirrors Paseo's app "Default send" setting, which plugins cannot read. */
    sendBehavior: z.enum(["steer", "queue", "interrupt"]).default("steer"),
    /** New task form: start the first agent together with the task. */
    startAgentOnCreate: z.boolean().default(true),
    /** New task opens Quick task instead of the full form (QUICK-TASK-SPEC §6). */
    quickTaskDefault: z.boolean().catch(true).default(true),
    /** Quick task asks the summary model for a title, type and tags. */
    quickTaskAiTitle: z.boolean().catch(true).default(true),
    /** Quick task's workspace: a new worktree or a new directory workspace (linked projects always use a directory). */
    quickTaskMode: z.enum(["worktree", "directory"]).catch("worktree").default("worktree"),
    /** The project the last quick task was created in. */
    lastQuickProjectId: z.string().max(200).catch("").default(""),
    /** The All projects tab / switcher entry (ALL-PROJECTS-SPEC §1). */
    allProjectsTab: z.boolean().catch(true).default(true),
    /** Order of cards inside each column. */
    boardSort: z.enum(boardSorts).default("manual"),
    /** Desktop columns shown as a narrow strip. */
    collapsedColumns: z.array(statusSchema).max(statuses.length).default([]),
    /** Board filters, remembered between visits. */
    filterSearch: z.string().max(200).default(""),
    filterPriority: z.enum(["all", ...priorities]).default("all"),
    filterType: z.enum(["all", ...taskTypes]).default("all"),
    /** Tags shown (any matches); a value ending in "/" matches by prefix (CARD-TAGS-SPEC §6.4). */
    filterTags: z.array(z.string().max(80)).max(20).default([]),
    showArchived: z.boolean().default(false),
    /** Done/Cancelled cards that finished more than this many days ago fold under "Show older"; 0 shows all. */
    hideFinishedAfterDays: z.number().int().min(0).max(365).default(14),
    /** The dot sweep on running cards, sessions and subagent rows (MOTION-SPEC, running state). */
    runningSweep: z.boolean().default(true),
    /** Before CONNECTORS-SPEC: the Jira picker's connection; read as `lastConnections.jira`. */
    lastTicketConnection: z.string().max(200).default(""),
    /** Each family's picker connection, when there are several (CONNECTORS-SPEC §8.1). */
    lastConnections: z.record(z.string().max(20), z.string().max(200)).catch({}).default({}),
    /** The card's activity line (CARD-DISPLAY-SPEC §3). */
    cardActivity: z.enum(cardActivityModes).catch("auto").default("auto"),
    /** Card fields the user hid; unknown ids are kept and ignored (CARD-DISPLAY-SPEC §4). */
    cardHidden: z.array(z.string().max(40)).max(20).catch([]).default([]),
    /** The card sidebar's section order; unknown ids are kept and ignored (DRAWER-SPEC, Section order). */
    drawerOrder: z.array(z.string().max(40)).max(20).catch([]).default([]),
    /** Card sidebar sections that start open (true) or closed (false) unlike their default (DRAWER-SPEC, Section order). */
    drawerOpen: z.record(z.string().max(40), z.boolean()).catch({}).default({}),
    /** The Linear board's layout; auto = list on compact layouts, board otherwise (LINEAR-BOARD-SPEC §4). */
    linearLayout: z.enum(["auto", "board", "list"]).catch("auto").default("auto"),
    /** The Linear board's scope: "me" (Assigned to me) or a team id. */
    linearScope: z.string().max(200).catch("me").default("me"),
    /** Status columns the Linear board's filter hides. */
    linearHidden: z.array(z.enum(linearColumns)).max(5).catch([]).default([]),
    /** Card sidebar width as last dragged, as a share of the Flowly area; 0 = never dragged, opens at half (UI-UX-SPEC, drawer width). */
    drawerShare: z.number().min(0).max(1).catch(0).default(0),
    /** The dispatcher chat minimized on desktop; it starts open (DISPATCHER-SPEC §9.3). */
    chatMinimized: z.boolean().catch(false).default(false),
    /** The dispatcher chat expanded over the whole board area on desktop; it starts docked (DISPATCHER-SPEC §9.3). */
    chatExpanded: z.boolean().catch(false).default(false),
  }),
});

export type BoardView = z.infer<typeof boardViewSettings.schema>;
/**
 * Stored values may predate newer fields (the host does not apply schema
 * defaults), so always read through this to get a complete, valid object.
 */
export function boardViewValues(values: unknown): BoardView {
  const parsed = boardViewSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : boardViewSettings.schema.parse({});
}

/** What happens when a card is moved into Done or Cancelled (MULTITASK-SPEC). */
export const wrapupSettings = defineSettings({
  id: "wrap-up",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Off: ask whether to wrap up. On: archive the workspace automatically when the preflight is clean. */
    autoWrapup: z.boolean().default(false),
    /** Off: deleting a card asks whether to archive its sessions/workspace. On: archive without asking when the preflight is clean. */
    archiveOnDelete: z.boolean().default(false),
  }),
});
export type WrapupSettings = z.infer<typeof wrapupSettings.schema>;
export function wrapupSettingsValues(values: unknown): WrapupSettings {
  const parsed = wrapupSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : wrapupSettings.schema.parse({});
}

/** How new cards are delivered unless New task says otherwise (DELIVERY-MODE-SPEC §2). */
export const deliverySettings = defineSettings({
  id: "delivery",
  scope: "host",
  version: 1,
  schema: z.object({
    defaultMode: z.enum(deliveryModes).default(defaultDeliveryMode),
  }),
});
export type DeliverySettings = z.infer<typeof deliverySettings.schema>;
export function deliverySettingsValues(values: unknown): DeliverySettings {
  const parsed = deliverySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : deliverySettings.schema.parse({});
}

/** PR review cards (PR-REVIEW-CARDS-SPEC §6): a new agent labelled `pr-review-watch` gets a card in its own workspace. */
export const prReviewSettings = defineSettings({
  id: "pr-review-cards",
  scope: "host",
  version: 1,
  schema: z.object({
    prReviewCards: z.boolean().default(true),
  }),
});
export type PrReviewSettings = z.infer<typeof prReviewSettings.schema>;
export function prReviewSettingsValues(values: unknown): PrReviewSettings {
  const parsed = prReviewSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : prReviewSettings.schema.parse({});
}

/** Whether session lifecycle rules may move cards between lanes (AUTO-STATUS-SPEC). */
export const statusSettings = defineSettings({
  id: "auto-status",
  scope: "host",
  version: 1,
  schema: z.object({
    /** On: rules A1/A1r run (a project can still opt out). Off: lifecycle facts are recorded, lanes never move. */
    autoStatus: z.boolean().default(true),
  }),
});
export type StatusSettings = z.infer<typeof statusSettings.schema>;
export function statusSettingsValues(values: unknown): StatusSettings {
  const parsed = statusSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : statusSettings.schema.parse({});
}

/**
 * Paseo's own session view (NATIVE-SESSION-SPEC §6.4): what tapping a suggested next step on the timeline card does.
 * `fill` puts it in that session's message box where the app allows it (web and desktop), else copies it.
 */
export const nativeSessionSettings = defineSettings({
  id: "native-session",
  scope: "host",
  version: 1,
  schema: z.object({
    nextMoveTap: z.enum(["fill", "copy"]).default("fill"),
    /** Sessions Flowly does not manage get these too (NATIVE-SESSION-SPEC §12): off by default (it runs a model per turn). */
    outside: z.boolean().default(false),
    outsideProgress: z.boolean().default(true),
    outsideNextMoves: z.boolean().default(true),
    outsideIdeas: z.boolean().default(true),
  }),
});
export type NativeSessionSettings = z.infer<typeof nativeSessionSettings.schema>;
export function nativeSessionSettingsValues(values: unknown): NativeSessionSettings {
  const parsed = nativeSessionSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : nativeSessionSettings.schema.parse({});
}

/** Folders outside a card's directories that agents may attach files from (CARD-ARTIFACTS-SPEC, extra folders). */
export const artifactSettings = defineSettings({
  id: "artifacts",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Absolute paths, or `~/…`; the server expands `~` when it reads them. */
    extraFolders: z.array(z.string().max(1000)).max(20).default([]),
  }),
});
export type ArtifactSettings = z.infer<typeof artifactSettings.schema>;
/**
 * Whether the server will ignore an extra folder by its text alone: relative or `~user` entries, `/`, `~`, and `~`/`/` paths that
 * resolve to the filesystem root, the home directory or an ancestor of it. Empty is not flagged (a row not typed yet).
 * Symlinks and the real home directory are only known to the server (`resolveExtraRoots`).
 */
export function extraFolderIgnored(text: string): boolean {
  const value = text.trim();
  if (!value || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const home = value === "~" || value.startsWith("~/");
  if (!home && !value.startsWith("/")) return true;
  let depth = 0;
  for (const part of value.slice(home ? 1 : 0).split("/")) {
    if (!part || part === ".") continue;
    depth = part === ".." ? (home ? depth - 1 : Math.max(depth - 1, 0)) : depth + 1;
  }
  return depth <= 0;
}
/** Stored values with empty and relative entries dropped and trailing slashes removed; `/` is never kept. */
export function artifactSettingsValues(values: unknown): ArtifactSettings {
  const parsed = artifactSettings.schema.safeParse(values ?? {});
  const folders: string[] = [];
  for (const raw of parsed.success ? parsed.data.extraFolders : []) {
    const value = raw.trim().replace(/[\\/]+$/, "");
    if (value && /^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(value) && !folders.includes(value)) folders.push(value);
  }
  return { extraFolders: folders };
}

/** The Ideas feature (IDEAS-INBOX-SPEC §10): off hides every Ideas entry and refuses new proposals. */
export const ideasSettings = defineSettings({
  id: "ideas",
  scope: "host",
  version: 1,
  schema: z.object({
    ideas: z.boolean().default(true),
    /** Agents may record card artifacts (CARD-ARTIFACTS-SPEC §4.3). */
    artifacts: z.boolean().default(true),
    /** Agents may create and edit cards, and sessions outside cards get those tools (AGENT-CARDS-SPEC §2.3). */
    agentCards: z.boolean().default(true),
  }),
});
export type IdeasSettings = z.infer<typeof ideasSettings.schema>;
export function ideasSettingsValues(values: unknown): IdeasSettings {
  const parsed = ideasSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : ideasSettings.schema.parse({});
}

/**
 * Developer switch for the phone timing log (PERFORMANCE-SPEC §3, Timing log).
 * No settings page: set `{ "log": true }` in `~/.paseo/plugin-settings/flowly/performance.json`
 * on the host and reload the plugin.
 */
export const performanceSettings = defineSettings({
  id: "performance",
  scope: "host",
  version: 1,
  schema: z.object({ log: z.boolean().default(false) }),
});
export function performanceLogOn(values: unknown) {
  const parsed = performanceSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.log : false;
}

/**
 * Developer switches (INSIGHTS-REDESIGN-SPEC §6). No settings page: set
 * `{"version":1,"values":{"agentHabits":true}}` in `~/.paseo/plugin-settings/flowly/developer.json`
 * on the host and reload the plugin. `agentHabits` shows Agent habits on the Insights page.
 */
export const developerSettings = defineSettings({
  id: "developer",
  scope: "host",
  version: 1,
  schema: z.object({ agentHabits: z.boolean().default(false) }),
});
export function agentHabitsOn(values: unknown) {
  const parsed = developerSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.agentHabits : false;
}

/** Interface language: follow the device (default) or one fixed language. Host-scoped. */
export const languageSettings = defineSettings({
  id: "language",
  scope: "host",
  version: 1,
  schema: z.object({
    language: z.enum(languageChoices).default("auto"),
  }),
});
export type LanguageSettings = z.infer<typeof languageSettings.schema>;
export function languageSettingsValues(values: unknown): LanguageSettings {
  const parsed = languageSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : languageSettings.schema.parse({});
}

/** Language of everything AI writes (AI-LANGUAGE-SPEC §2): follow the interface language (default) or one fixed language. Host-scoped. */
export const aiLanguageSettings = defineSettings({
  id: "ai-language",
  scope: "host",
  version: 1,
  schema: z.object({
    aiLanguage: z.enum(aiLanguageChoices).default("interface"),
  }),
});
export type AiLanguageSettings = z.infer<typeof aiLanguageSettings.schema>;
export function aiLanguageSettingsValues(values: unknown): AiLanguageSettings {
  const parsed = aiLanguageSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : aiLanguageSettings.schema.parse({});
}

/**
 * The device language a client last reported (AI-LANGUAGE-SPEC §3): the daemon cannot see the device,
 * so the interface language "auto" resolves through this. No settings page; empty until a client reports.
 */
export const deviceLanguageSettings = defineSettings({
  id: "device-language",
  scope: "host",
  version: 1,
  schema: z.object({
    locale: z.enum(["", ...localeCodes]).default(""),
  }),
});
export function deviceLanguageValue(values: unknown): string {
  const parsed = deviceLanguageSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.locale : "";
}

/** First-run guidance (ONBOARDING-SPEC): whether the welcome tour was seen and which one-time tips were shown. Host-scoped. */
export const onboardingSettings = defineSettings({
  id: "onboarding",
  scope: "host",
  version: 1,
  schema: z.object({
    welcomeSeen: z.boolean().default(false),
    // Matches TIPS_SEEN_MAX (client/onboarding-logic.ts).
    tipsSeen: z.array(z.string().max(40)).max(100).default([]),
    /** The release whose What's new was last seen; "" before any (WHATS-NEW-SPEC §3). */
    whatsNewSeen: z.string().max(20).default(""),
  }),
});
export type OnboardingSettings = z.infer<typeof onboardingSettings.schema>;
export function onboardingSettingsValues(values: unknown): OnboardingSettings {
  const parsed = onboardingSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : onboardingSettings.schema.parse({});
}

/**
 * Advanced features as a whole (ONBOARDING-SETUP-SPEC §6). Off: memory is off in every project
 * (each project's own switch still applies when on); Insights is hidden and its digest and
 * Workflow insights do not run. Host-scoped.
 */
export const featureSettings = defineSettings({
  id: "features",
  scope: "host",
  version: 1,
  schema: z.object({
    memory: z.boolean().default(true),
    insights: z.boolean().default(true),
  }),
});
export type FeatureSettings = z.infer<typeof featureSettings.schema>;
export function featureSettingsValues(values: unknown): FeatureSettings {
  const parsed = featureSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : featureSettings.schema.parse({});
}

/** Anonymous daily usage data (TELEMETRY-SPEC §5): on unless the user turns it off. Host-scoped. */
export const telemetrySettings = defineSettings({
  id: "telemetry",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
  }),
});
export type TelemetrySettings = z.infer<typeof telemetrySettings.schema>;
export function telemetrySettingsValues(values: unknown): TelemetrySettings {
  const parsed = telemetrySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : telemetrySettings.schema.parse({});
}

/** Global default model for new sessions (MODEL-DEFAULTS-SPEC). Empty strings mean "none": new sessions follow the latest session. */
export const modelSettings = defineSettings({
  id: "models",
  scope: "host",
  version: 1,
  schema: z.object({
    defaultProvider: z.string().max(100).default(""),
    defaultModel: z.string().max(200).default(""),
    defaultThinking: z.string().max(100).default(""),
    defaultMode: z.string().max(100).default(""),
    /** The Dispatcher model (DISPATCHER-SPEC §3); null uses the server default, `dispatcherDefaultModel`. */
    dispatcherModel: agentModelSchema.nullable().catch(null).default(null),
  }),
});
export type ModelSettings = z.infer<typeof modelSettings.schema>;
export function modelSettingsValues(values: unknown): ModelSettings {
  const parsed = modelSettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data : modelSettings.schema.parse({});
}
