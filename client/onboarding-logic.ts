/** Pure decisions for first-run guidance (ONBOARDING-SPEC). No React, no storage. */

/** How it works, Built in, Guardrails, Insights, Ready (ONBOARDING-SETUP-SPEC §3). */
export const welcomePageCount = 5;

/** Page index after a Back/Next step, kept inside the tour. */
export function stepPage(page: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(welcomePageCount - 1, page + direction));
}

export type WelcomeDecision = "wait" | "show" | "mark-seen" | "none";

/**
 * What to do with the welcome tour once settings and the board are known.
 * Unknown state never shows it; a user who already has a project is marked
 * as seen without being interrupted; only an empty board gets the tour.
 */
export function welcomeDecision(input: {
  settingsStatus: string;
  welcomeSeen: boolean;
  boardLoaded: boolean;
  projectCount: number;
  /** Another dialog or an open card is in the way. */
  blocked: boolean;
}): WelcomeDecision {
  if (input.settingsStatus !== "ready" || !input.boardLoaded) return "wait";
  if (input.welcomeSeen) return "none";
  if (input.projectCount > 0) return "mark-seen";
  return input.blocked ? "wait" : "show";
}

export const tipIds = ["first-card", "needs-you", "first-idea", "first-done", "first-artifact", "first-tag", "agent-question", "older-finished", "next-move", "first-ticket", "jira-connect", "board-groups", "first-workpad", "subagents", "card-display", "first-workflow-insight", "attention-dismiss", "sidebar-order", "connectors", "session-history", "ai-language", "summary-models", "first-skill-draft", "search", "quick-task", "settings-entry", "dispatcher", "idea-discuss", "lane-swipe", "auto-review", "first-guardrail", "plan"] as const;
export type TipId = (typeof tipIds)[number];

export interface TipFacts {
  /** The current project has at least one card. */
  hasCard: boolean;
  /** Some card is waiting for the user (question, approval or error). */
  needsYou: boolean;
  /** The Ideas inbox has an open item and the feature is on. */
  openIdea: boolean;
  /** The user just moved a card into Done or Cancelled. */
  movedToFinished: boolean;
  /** A card of the current project has an artifact (CARD-ARTIFACTS-SPEC). */
  hasArtifact: boolean;
  /** A card of the current project has a tag an agent added (CARD-TAGS-SPEC §6.5). */
  hasAgentTag: boolean;
  /** A session of the current project is waiting on an agent question (SESSION-QUESTION-SPEC). */
  agentQuestion: boolean;
  /** Old Done/Cancelled cards are folded under "Show older" in the current project. */
  olderHidden: boolean;
  /** A session of the current project suggested next steps for this turn (NEXT-MOVES-SPEC). */
  nextMove: boolean;
  /** A card of the current project has an external input (EXTERNAL-TRACKER-SPEC, CONNECTORS-SPEC). */
  hasTicket: boolean;
  /** The current project has cards and no connection is configured (known, not loading). */
  noConnection: boolean;
  /** A card's sidebar is open, so its Artifacts + is in view (CONNECTORS-SPEC §8.5). */
  cardOpen: boolean;
  /** Desktop group tabs show (two or more projects, no card is open; BOARD-GROUPS-SPEC §1). */
  groupTabs: boolean;
  /** A card of the current project has a workpad (WORKPAD-SPEC §8). */
  hasWorkpad: boolean;
  /** A session of the current project has a live Paseo child agent (SUBAGENTS-SPEC §7). */
  hasSubagent: boolean;
  /** The current project has 6 or more active cards and no card is open (CARD-DISPLAY-SPEC §5). */
  busyBoard: boolean;
  /** Workflow insights has an open suggestion for the current project (WORKFLOW-INSIGHTS-SPEC §8). */
  workflowSuggestion: boolean;
  /** Three or more cards are in Attention, none of them dismissed yet (ATTENTION-DISMISS-SPEC §6). */
  crowdedAttention: boolean;
  /** A card's sidebar is open and shows at least one artifact or idea, so it has several sections (DRAWER-SPEC, Section order). */
  fullSidebar: boolean;
  /** A card's sidebar is open and the card has a session, so its session output is one tap away (SESSION-PANE-SPEC §1). */
  cardWithSession: boolean;
  /** A card of the current project has an AI progress summary, so AI-written text is in view (AI-LANGUAGE-SPEC §7). */
  hasSummary: boolean;
  /** The current project has 3 or more finished cards and no card is open, so Insights has history to show (INSIGHTS-REDESIGN-SPEC §8). */
  /** An open skill draft in the current project, Insights and Skills on (INSIGHTS-REDESIGN-SPEC §5). */
  skillDraft: boolean;
  /** The current project shows 10 or more cards and no card is open, so there is history to search (SEARCH-SPEC §8). */
  searchable: boolean;
  /** The current project has a card, no card is open and the dispatcher chat is closed (DISPATCHER-SPEC §9.3). */
  dispatcherIntro: boolean;
  /** The current project has an open idea and the board can open the dispatcher chat (DISPATCHER-SPEC §9.5). */
  ideaDiscuss: boolean;
  /** A card of the current project shows an automatic review state and no card is open (AUTO-REVIEW-SPEC §9.1). */
  reviewShown: boolean;
  /** The current project learned a guideline from cards sent back, this week, and no card is open (GUARDRAILS-SPEC §10). */
  learnedGuideline: boolean;
  /** A phone board (iOS/Android) shows two or more lanes, the project has cards, and no card or page is open (UI-UX-SPEC §5, lane swipe). */
  laneSwipe: boolean;
  /** A card's sidebar is open and the card has an approved plan (CARD-PLAN-SPEC §2.1). */
  cardPlan: boolean;
}

/** Banner tips; `settings-entry` is the callout by the settings button instead (settingsHintDue). */
const tipFact: Record<Exclude<TipId, "settings-entry">, keyof TipFacts> = {
  "first-card": "hasCard",
  "needs-you": "needsYou",
  "first-idea": "openIdea",
  "first-done": "movedToFinished",
  "first-artifact": "hasArtifact",
  "first-tag": "hasAgentTag",
  "agent-question": "agentQuestion",
  "older-finished": "olderHidden",
  "next-move": "nextMove",
  "first-ticket": "hasTicket",
  "jira-connect": "noConnection",
  "board-groups": "groupTabs",
  "first-workpad": "hasWorkpad",
  subagents: "hasSubagent",
  "card-display": "busyBoard",
  "first-workflow-insight": "workflowSuggestion",
  "attention-dismiss": "crowdedAttention",
  "sidebar-order": "fullSidebar",
  connectors: "cardOpen",
  "session-history": "cardWithSession",
  "ai-language": "hasSummary",
  "summary-models": "hasSummary",
  "first-skill-draft": "skillDraft",
  search: "searchable",
  "quick-task": "hasCard",
  dispatcher: "dispatcherIntro",
  "idea-discuss": "ideaDiscuss",
  "auto-review": "reviewShown",
  "first-guardrail": "learnedGuideline",
  "lane-swipe": "laneSwipe",
  plan: "cardPlan",
};

/** No fact holds: the starting point for a board that shows no single project (a group board, BOARD-GROUPS-SPEC §1). */
export const noTipFacts: TipFacts = {
  hasCard: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, groupTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, skillDraft: false, searchable: false, dispatcherIntro: false, ideaDiscuss: false, reviewShown: false, learnedGuideline: false, laneSwipe: false, cardPlan: false,
};

/** The one tip to show now: first in priority order whose fact holds and that was not shown before. */
export function nextTip(input: { tipsSeen: readonly string[]; facts: TipFacts; blocked: boolean }): TipId | null {
  if (input.blocked) return null;
  // Waiting for the user outranks introductions; the answer-in-session tip is the more specific one.
  const order: Exclude<TipId, "settings-entry">[] = ["agent-question", "needs-you", "attention-dismiss", "first-done", "older-finished", "next-move", "auto-review", "first-guardrail", "plan", "first-workpad", "subagents", "first-idea", "idea-discuss", "first-skill-draft", "first-workflow-insight", "ai-language", "summary-models", "first-artifact", "first-ticket", "first-tag", "first-card", "dispatcher", "lane-swipe", "card-display", "search", "connectors", "session-history", "sidebar-order", "board-groups", "jira-connect", "quick-task"];
  return order.find((id) => input.facts[tipFact[id]] && !input.tipsSeen.includes(id)) ?? null;
}

/**
 * The setting's bound. Far above the number of tips: when the list was capped
 * at 20 with 20 tips, each new tip pushed out the oldest, which then showed again.
 */
export const TIPS_SEEN_MAX = 100;

/** Stored tips with `id` added once (bounded like the setting). */
export function withTipSeen(tipsSeen: readonly string[], id: string): string[] {
  return tipsSeen.includes(id) ? [...tipsSeen] : [...tipsSeen, id].slice(-TIPS_SEEN_MAX);
}

/**
 * The callout by the settings button (ONBOARDING-SETUP-SPEC §5): once, after the welcome tour
 * closed in this visit, when nothing else is open.
 */
export function settingsHintDue(input: { tipsSeen: readonly string[]; tourClosed: boolean; blocked: boolean }): boolean {
  return input.tourClosed && !input.blocked && !input.tipsSeen.includes("settings-entry");
}

/** The tour's "Also in sessions outside Flowly" switches, one per built-in feature. */
export interface OutsideChoice {
  progress: boolean;
  nextMoves: boolean;
  ideas: boolean;
}

/** What the first-run tour shows and, closed in any way, stores (§4): all on. */
export const firstRunOutside: OutsideChoice = { progress: true, nextMoves: true, ideas: true };

/** What the stored settings mean for each feature: a part only runs while the master switch is on. */
export function outsideShown(v: { outside: boolean; outsideProgress: boolean; outsideNextMoves: boolean; outsideIdeas: boolean }): OutsideChoice {
  return { progress: v.outside && v.outsideProgress, nextMoves: v.outside && v.outsideNextMoves, ideas: v.outside && v.outsideIdeas };
}

/**
 * The native-session patch for a choice. All four fields are written so that turning one part on
 * never wakes the others that only looked off because the master switch was.
 */
export function outsidePatch(c: OutsideChoice) {
  return { outside: c.progress || c.nextMoves || c.ideas, outsideProgress: c.progress, outsideNextMoves: c.nextMoves, outsideIdeas: c.ideas };
}

export type TourKeyAction = "next" | "back" | "finish";

/**
 * Keyboard navigation in the welcome tour (ONBOARDING-SETUP-SPEC §3.2): Enter takes the primary
 * step (Next, or finishing on the last page) but only when the tour itself has focus, so Enter on a
 * focused switch or button keeps its own meaning; → and ← page anywhere in the tour. Modifiers,
 * key repeat and IME composition are ignored; Esc is the window's own close.
 */
export function tourKey(
  key: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean },
  state: { page: number; onTour: boolean },
): TourKeyAction | null {
  if (key.metaKey || key.ctrlKey || key.altKey || key.shiftKey || key.repeat || key.isComposing) return null;
  const last = state.page >= welcomePageCount - 1;
  if (key.key === "Enter") return state.onTour ? (last ? "finish" : "next") : null;
  if (key.key === "ArrowRight") return last ? null : "next";
  if (key.key === "ArrowLeft") return state.page > 0 ? "back" : null;
  return null;
}

/** What the Built in page's autoplay does next (ONBOARDING-SETUP-SPEC §3, page 2), or null while the demo is busy or done. */
export type LoopAutoStep = { cue: "move" | "send" | "idea" | "restart"; wait: number };

export function loopAutoStep(s: {
  turn: number;
  draft: boolean;
  working: boolean;
  updating: boolean;
  idea: "none" | "open" | "task" | "dismissed";
}): LoopAutoStep | null {
  if (s.working || s.updating) return null;
  if (s.idea === "task" || s.idea === "dismissed") return { cue: "restart", wait: 4000 };
  if (s.idea === "open") return { cue: "idea", wait: 1500 };
  if (s.turn === 0) return s.draft ? { cue: "send", wait: 800 } : { cue: "move", wait: 1500 };
  return null;
}
