/** What's new after an update (WHATS-NEW-SPEC). Pure data and decisions; no React, no storage. */
import { msg } from "../shared/i18n";
import type { SettingsSection } from "./summary-settings";

export interface WhatsNewItem {
  icon: string;
  /** One sentence, msg()-marked; translated at render. */
  text: string;
  /** `auto-review`: the current project's Edit project with Auto review switched on (GUARDRAILS-SPEC §10). */
  action?: { label: string; to: "settings"; section: SettingsSection } | { label: string; to: "tour" } | { label: string; to: "auto-review" };
}

export interface WhatsNewRelease {
  /** The release that ships these changes, `major.minor.patch`. */
  version: string;
  items: WhatsNewItem[];
}

/**
 * Releases, newest first (§4): the window opens on the first and pages back to older ones.
 * Starts at 1.5.0; nothing older is listed. Add a release on top when it ships changes worth
 * telling existing users about (§9); a release without items is left out.
 */
export const whatsNew: WhatsNewRelease[] = [
  {
    // SEARCH-SPEC §8, GUARDRAILS-SPEC §10, CONNECTORS-SPEC §15, DISPATCHER-SPEC §9.3-9.4, BOARD-GROUPS-SPEC.
    version: "1.8.0",
    items: [
      { icon: "Search", text: msg("Search past cards, summaries, notes, workpads, ideas and deliverables. Agents can search them too.") },
      // GUARDRAILS-SPEC §10 (D1): on for new projects; existing ones turn it on here.
      {
        icon: "ShieldCheck",
        text: msg("Auto review checks every delivery before it reaches you and sends it back to the agent when it falls short. On for new projects."),
        action: { label: msg("Turn on for this project"), to: "auto-review" },
      },
      // Merged to make room for Board groups within the 7-item cap (WHATS-NEW-SPEC).
      { icon: "Undo2", text: msg("Flowly learns from what you send cards back for (the second card with the same problem becomes a project guideline), and memory no longer needs confirming.") },
      {
        icon: "PlugZap",
        text: msg("Shortcut stories and epics can now be card inputs, next to Jira, Confluence, GitHub, GitLab and Azure DevOps."),
        action: { label: msg("Open settings"), to: "settings", section: "connections" },
      },
      // DISPATCHER-SPEC §9.4 (Rulings, Noah 2026-11-09): the bell and Attention moved to the overview's chip and the card sidebar; unread turns are in "N updated", not "N need you".
      { icon: "BellRing", text: msg("The bell is now the “N need you” chip above the board: it opens each card waiting on you in turn in the card sidebar, with what it asks on top. “N updated” does the same for what is new to read: cards that changed and finished turns you have not opened.") },
      // DISPATCHER-SPEC §9.3 (Ruling, Noah 2026-11-09): the dock is the chat only (the toolbar's Dispatcher button, or D, reopens it when minimized); the gear moved into the toolbar.
      // BOARD-GROUPS-SPEC (approved, Noah 2026-11-10).
      { icon: "Layers", text: msg("Group projects in Settings → Workflow and open each group from the project switcher as its own board: like All projects, for just those projects."), action: { label: msg("Open settings"), to: "settings", section: "workflow" } },
      { icon: "PanelLeft", text: msg("The left dock is just the dispatcher chat. Minimized, it leaves nothing on the board: the Dispatcher button in the toolbar (or D) opens it again. Settings moved to the gear at the top of the board.") },
    ],
  },
  {
    // INSIGHTS-REDESIGN-SPEC §5: Skills turn on for everyone who never touched the switch.
    version: "1.7.0",
    items: [
      {
        icon: "CalendarDays",
        text: msg("Insights is redesigned: a year of activity, a summary of each day you can page through, and how each finished card went (review rounds, waiting, tokens)."),
      },
      {
        icon: "Sparkles",
        text: msg("Insights drafts skills from your cards and adds them to the project when you say so. On by default; turn it off in Settings."),
        action: { label: msg("Open settings"), to: "settings", section: "ai" },
      },
      { icon: "Gauge", text: msg("The board opens and refreshes faster, most of all on phones: it reads only the overview and the open card.") },
      {
        icon: "MonitorSmartphone",
        text: msg("Settings fill the screen on phones, and Settings → Cards can turn off the running sweep on cards and sessions."),
        action: { label: msg("Open settings"), to: "settings", section: "cards" },
      },
      {
        icon: "Database",
        text: msg("Where Paseo supports it, the board moves to a local SQLite database with daily backups; Settings → Storage restores one or exports the board to JSON."),
        action: { label: msg("Open settings"), to: "settings", section: "storage" },
      },
      {
        icon: "Activity",
        text: msg("Flowly now sends anonymous usage data: once a day, versions, which features are on and usage counts; on errors, where in Flowly's code. Never your content, paths or code. You can turn it off in Settings."),
        action: { label: msg("Open settings"), to: "settings", section: "general" },
      },
    ],
  },
  {
    version: "1.6.0",
    items: [
      {
        icon: "Brain",
        text: msg("Project memory: decisions and pitfalls you confirm on one card carry over to later cards' sessions, and finished cards can suggest new ones."),
      },
      {
        icon: "SlidersHorizontal",
        text: msg("Project memory and Insights now each have one switch for all projects."),
        action: { label: msg("Open settings"), to: "settings", section: "ai" },
      },
      {
        icon: "MessagesSquare",
        text: msg("Progress, suggested next steps and Ideas can also run in sessions Flowly doesn't manage. They are off for you; when on, each of their turns runs the summary model once."),
        action: { label: msg("Open settings"), to: "settings", section: "ai" },
      },
      {
        icon: "ListOrdered",
        text: msg("Choose multiple summary models and set their fallback priority in Settings → Models."),
        action: { label: msg("Open settings"), to: "settings", section: "models" },
      },
      {
        icon: "ShieldCheck",
        text: msg("New sessions can start in a default permission mode, set for all projects or per project."),
        action: { label: msg("Open settings"), to: "settings", section: "models" },
      },
      {
        icon: "PlugZap",
        text: msg("Azure DevOps work items can now be card inputs, next to Jira, Confluence, GitHub and GitLab."),
        action: { label: msg("Open settings"), to: "settings", section: "connections" },
      },
      {
        icon: "CircleHelp",
        text: msg("The welcome tour now sets your languages and AI features in one place."),
        action: { label: msg("Take the tour"), to: "tour" },
      },
    ],
  },
  {
    version: "1.5.0",
    items: [
      {
        icon: "Activity",
        text: msg("Workflow insights (opt-in): from the commands agents run, Flowly suggests scripts, setup steps and rules worth keeping."),
        action: { label: msg("Open settings"), to: "settings", section: "ai" },
      },
      {
        icon: "Sparkles",
        text: msg("One AI output language now decides the language of everything AI writes: progress, digests, insights, next steps and ideas."),
        action: { label: msg("Open settings"), to: "settings", section: "ai" },
      },
      {
        icon: "ListChecks",
        text: msg("Agents set each card's type, tags and workpad (acceptance criteria and checks) before they start."),
      },
      {
        icon: "GitPullRequest",
        text: msg("Agents can add their own pull requests to a card's outputs; new review comments mark them unread."),
      },
      {
        icon: "FileText",
        text: msg("Card descriptions are shown as Markdown."),
      },
    ],
  },
];

/** The oldest release listed (§13 W4). */
export const WHATS_NEW_FROM = "1.5.0";
/** At most this many items per release, so a page stays short. */
export const WHATS_NEW_MAX_ITEMS = 7;

/** The release the window opens on and that decides whether it opens by itself. */
export const latestRelease: WhatsNewRelease | null = whatsNew.find((r) => r.items.length) ?? null;

/** Page index after an Older (+1) / Newer (-1) step, kept inside the list. */
export function stepRelease(index: number, direction: 1 | -1, count: number): number {
  return Math.max(0, Math.min(count - 1, index + direction));
}

const versionPattern = /^\d+\.\d+\.\d+$/;
export const validVersion = (v: string) => versionPattern.test(v);

/** Numeric `major.minor.patch` order; "" (never seen) and malformed values sort before any release. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (validVersion(v) ? v.split(".").map(Number) : [-1, -1, -1]);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** What `whatsNewSeen` becomes when the window closes, or when the first-run tour closes (§2). */
export function whatsNewVersion(release: WhatsNewRelease | null): string {
  return release && release.items.length ? release.version : "";
}

/** The stored `whatsNewSeen` after this release was seen; never moves back. */
export function seenAfter(current: string, release: WhatsNewRelease | null): string {
  const version = whatsNewVersion(release);
  return version && compareVersions(version, current) > 0 ? version : current;
}

/** "1.6.0" → "1.6", "1.6.2" stays. */
export function versionLabel(version: string): string {
  return version.replace(/\.0$/, "");
}

export type WhatsNewDecision = "wait" | "show" | "none";

/**
 * Whether to open What's new now (§2): only for existing users (the welcome tour is seen),
 * only when this release has items newer than the one last seen, and never over something else.
 */
export function whatsNewDecision(input: {
  settingsStatus: string;
  boardLoaded: boolean;
  welcomeSeen: boolean;
  whatsNewSeen: string;
  release: WhatsNewRelease | null;
  /** Another dialog, an open card, the tour or the settings callout is in the way. */
  blocked: boolean;
}): WhatsNewDecision {
  if (input.settingsStatus !== "ready" || !input.boardLoaded) return "wait";
  // A new user gets the tour, which already covers these; an unmarked existing user is marked first.
  if (!input.welcomeSeen) return "none";
  const version = whatsNewVersion(input.release);
  if (!version || compareVersions(version, input.whatsNewSeen) <= 0) return "none";
  return input.blocked ? "wait" : "show";
}
