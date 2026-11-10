import { enabledStatuses, laneEnabled } from "./lanes";
import {
  isWorkStatus,
  legacyStatus,
  workStatuses,
  type BoardEvent,
  type HistoryStatus,
  type Project,
  type Review,
  type ReviewItem,
  type Status,
  type Task,
} from "./model";

/** Rule ids on the status changes an automatic review makes (AUTO-REVIEW-SPEC §3.2). */
export const reworkRule = "R1";
export const reviewFailedRule = "R2";
export const reviewStartedAction = "review_started";
export const reviewFinishedAction = "review_finished";
export const defaultCheckTimeoutSec = 600;

/** A project's review settings (GUARDRAILS-SPEC §8): the switch and the rework rounds. What is checked lives in its guardrails. */
export type ReviewConfig = { enabled: boolean; maxRounds: number };
export const defaultAutoReview: ReviewConfig = { enabled: false, maxRounds: 2 };

/**
 * The built-in check "Does what you asked" (AUTO-REVIEW-SPEC §4.2, D12): judged by the review session against the
 * card and what the user said in its sessions. Stored by id only; its name is translated where it is shown.
 */
export const GOAL_ID = "goal";
export const GOAL_NAME = "Does what you asked";
export const goalPrompt =
  "The change does what the user asked for this card: its title and description, and what the user said in the card's conversation. A later instruction replaces an earlier one; something the user said to leave for later is not missing. Judge na when the request is too vague to judge. The acceptance list is the agent's own claim: read it as context, not as proof.";

export function autoReviewOf(project: Pick<Project, "autoReview"> | null | undefined): ReviewConfig {
  const stored = project?.autoReview;
  return stored ? { enabled: stored.enabled, maxRounds: stored.maxRounds } : defaultAutoReview;
}
export const autoReviewEnabled = (project: Pick<Project, "autoReview"> | null | undefined) => !!project?.autoReview?.enabled;
/** A delivery starts a review whenever the switch is on: the built-in check always runs (GUARDRAILS-SPEC §6.1). */
export const autoReviewRuns = autoReviewEnabled;

/**
 * Where a failed review sends the card (R1): the work stage it was delivered from when that lane is on,
 * else the latest work stage it was in, else the first enabled one; null when the workflow has none.
 */
export function reworkStage(events: readonly BoardEvent[], task: Pick<Task, "id">, project: Pick<Project, "lanes">, from: HistoryStatus): Status | null {
  const stage = from === legacyStatus ? "development" : from;
  if (isWorkStatus(stage) && laneEnabled(project, stage)) return stage;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== task.id || e.action !== "status_changed" || !e.to) continue;
    const to = e.to === legacyStatus ? "development" : e.to;
    if (isWorkStatus(to) && laneEnabled(project, to)) return to;
  }
  return enabledStatuses(project).find((s) => (workStatuses as readonly Status[]).includes(s)) ?? null;
}

/**
 * Whether a new delivery continues the previous review's rework round (§3.3): it asked for rework, and since then no
 * person moved the card and no turn other than the rework one started on the card.
 */
export function continuesRound(events: readonly BoardEvent[], taskId: string, previous: Review | undefined): boolean {
  if (previous?.state !== "rework" || !previous.finishedAt) return false;
  const since = events.filter((e) => e.taskId === taskId && e.at > previous.finishedAt!);
  if (since.some((e) => e.actor === "human" && e.action === "status_changed")) return false;
  return since.filter((e) => e.action === "agent.turn_started").length <= 1;
}

/** The review the card face and Attention show: only while the card is still where that review left it (§7). */
export function visibleReview(task: Pick<Task, "status" | "review" | "archivedAt">): Review | null {
  const review = task.review;
  if (!review || task.archivedAt) return null;
  const status = task.status;
  switch (review.state) {
    case "running":
    case "passed":
      return status === "in_review" ? review : null;
    case "rework":
      return isWorkStatus(status) ? review : null;
    case "failed":
      return status === "blocked" || status === "in_review" ? review : null;
    case "unavailable":
      return status === "in_review" || isWorkStatus(status) ? review : null;
    case "cancelled":
      // Never silent: the card shows it was not reviewed, and Rerun is one tap away.
      return status === "in_review" ? review : null;
    default:
      return null;
  }
}

/**
 * A finished review that needs a person (§7): its Attention signal key, else null. A pass is not one: it only releases
 * the unread sessions the running review held back, which Mark as read clears as usual.
 */
export function reviewSignal(task: Pick<Task, "status" | "review" | "archivedAt">): { state: "failed" | "unavailable"; key: string } | null {
  const review = visibleReview(task);
  if (!review || (review.state !== "failed" && review.state !== "unavailable")) return null;
  return { state: review.state, key: `review:${review.state}:${review.startedAt}` };
}

/** While a review runs, the card's unread sessions are not counted (§3.2). */
export const reviewing = (task: Pick<Task, "status" | "review" | "archivedAt">) => visibleReview(task)?.state === "running";

const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** The end of a check's output, without colour codes, at most `max` characters. */
export function outputTail(text: string, max: number) {
  const clean = text.replace(ansi, "").replace(/\r\n?/g, "\n").trimEnd();
  return clean.length > max ? clean.slice(clean.length - max) : clean;
}

/** An item's result counts as passing: passed, or not applicable to this change. */
export const itemPassed = (i: Pick<ReviewItem, "state">) => i.state === "passed" || i.state === "na";

/**
 * The overall result (GUARDRAILS-SPEC §6.3 step 3), from the gating items only (an observing command never counts):
 * any failed → failed; else any that could not finish → unavailable; else passed. Disputed items are not failures.
 */
export function reviewVerdict(items: readonly Pick<ReviewItem, "gating" | "state">[]): "passed" | "failed" | "unavailable" {
  const gating = items.filter((i) => i.gating);
  if (gating.some((i) => i.state === "failed")) return "failed";
  if (gating.some((i) => i.state === "unavailable" || i.state === "queued" || i.state === "running")) return "unavailable";
  return "passed";
}

const normalizedQuote = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * B1 (§6.3): a `fail` stands only with evidence: a file in the diff, an existing repository file, or a quote of the
 * card or the user's words. `existing` holds the cited files the daemon found in the repository; `sources` is the text
 * the reviewer was given that a quote may come from (card title and description, the filtered conversation, the
 * check's own user words). A quote counts only when it appears in one of them, ignoring case and runs of whitespace.
 */
export function hasEvidence(
  v: { file?: string; quote?: string },
  diffFiles: ReadonlySet<string>,
  existing: ReadonlySet<string>,
  sources: readonly (string | null | undefined)[],
): boolean {
  const quote = normalizedQuote(v.quote ?? "");
  if (quote && sources.some((s) => !!s && normalizedQuote(s).includes(quote))) return true;
  return !!v.file && (diffFiles.has(v.file) || existing.has(v.file));
}

export type ReviewProgress = {
  passed: number;
  failed: number;
  total: number;
  phase: "starting" | "running" | "judging" | "done";
  /** The command running now. */
  current?: string;
  /** How many checks the review session is judging now. */
  judging?: number;
};
/**
 * The card's review strip (GUARDRAILS-SPEC §7.1.1): passed (na included) and failed among the gating items, which
 * are the total (observing commands and disputed findings are not); what runs now. Clients only render it.
 */
export function reviewProgress(review: Pick<Review, "items" | "state">): ReviewProgress {
  const counted = review.items.filter((i) => i.gating && i.state !== "disputed");
  const out: ReviewProgress = {
    passed: counted.filter(itemPassed).length,
    failed: counted.filter((i) => i.state === "failed").length,
    total: counted.length,
    phase: "done",
  };
  if (review.state !== "running") return out;
  const command = review.items.find((i) => i.kind === "command" && i.state === "running");
  const judging = review.items.filter((i) => i.kind !== "command" && i.state === "running").length;
  if (command) return { ...out, phase: "running", current: command.name };
  if (judging) return { ...out, phase: "judging", judging };
  const ended = review.items.some((i) => i.state !== "queued" && i.state !== "running" && i.state !== "disputed");
  return { ...out, phase: ended ? "running" : "starting" };
}

/** The item's label in agent-facing text: the built-in check's name, or the user's words for a guideline or card item. */
function itemLabel(item: ReviewItem, words: ReadonlyMap<string, string>) {
  if (item.kind === "goal") return GOAL_NAME;
  if (item.kind === "command") return item.name;
  return `"${(words.get(item.id) || item.name).replace(/\s+/g, " ").trim()}"`;
}

/** One line for an item that did not pass, for the rework message. Its id, so the agent can dispute it. */
export function failureLine(item: ReviewItem, words: ReadonlyMap<string, string> = new Map()): string {
  const id = ` [id: ${item.id}]`;
  if (item.kind === "command") {
    const command = (item.argv || []).join(" ");
    if (item.timedOut) return `✗ ${item.name} (${command}) timed out.${id}`;
    return `✗ ${item.name} (${command}) ${item.exitCode === null || item.exitCode === undefined ? "did not finish" : `exited ${item.exitCode}`}.${id}`;
  }
  const where = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
  return `✗ ${itemLabel(item, words)} — ${item.detail || item.reason || "not met"}${where}${id}`;
}

/** The failed gating items as one short note. */
export const failureSummary = (review: Pick<Review, "items">) =>
  review.items.filter((i) => i.gating && i.state === "failed").map((i) => (i.kind === "goal" ? GOAL_NAME : i.name)).join(", ");

/**
 * The marked rework message sent to the delivering session (GUARDRAILS-SPEC §6.5). `words`: the user's own words for
 * a guideline or card item, by item id. Agent-facing English.
 */
export function reworkMessage(review: Review, words: ReadonlyMap<string, string> = new Map()): string {
  const lines = [`[Flowly auto review · rework ${review.round}/${review.maxRounds}]`];
  const commands = review.items.filter((i) => i.kind === "command" && i.gating);
  const judged = review.items.filter((i) => i.kind !== "command");
  if (commands.length) {
    lines.push(`Commands: ${commands.filter(itemPassed).length}/${commands.length} passed`);
    for (const c of commands.filter((x) => x.state === "failed")) {
      lines.push(failureLine(c));
      if (c.tail) lines.push(...outputTail(c.tail, 2000).split("\n").map((l) => `    ${l}`));
    }
  }
  if (judged.length && judged.every((i) => i.state === "skipped" || i.state === "disputed")) lines.push("Review: skipped (a command failed)");
  else for (const i of judged.filter((x) => x.state === "failed")) lines.push(failureLine(i, words));
  lines.push("Fix these, rerun the checks, update the acceptance list and deliver to In review again. If a finding is wrong, deliver with disputes=[{id, reason}].");
  return lines.join("\n");
}

/** What flowly_get_task shows of the card's review (§5.2): no fingerprint. */
export function reviewContext(review: Review | undefined) {
  if (!review) return undefined;
  return {
    state: review.state,
    round: review.round,
    maxRounds: review.maxRounds,
    ...(review.reason ? { reason: review.reason } : {}),
    items: review.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      name: i.kind === "goal" ? GOAL_NAME : i.name,
      gating: i.gating,
      state: i.state,
      ...(i.argv ? { command: i.argv.join(" ") } : {}),
      ...(i.exitCode !== undefined ? { exitCode: i.exitCode } : {}),
      ...(i.timedOut ? { timedOut: true } : {}),
      ...(i.tail ? { tail: outputTail(i.tail, 2000) } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
      ...(i.file ? { file: i.file } : {}),
      ...(i.line ? { line: i.line } : {}),
      ...(i.quote ? { quote: i.quote } : {}),
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.disputeReason ? { disputeReason: i.disputeReason } : {}),
    })),
    ...(review.shape ? { shape: review.shape } : {}),
    startedAt: review.startedAt,
    ...(review.finishedAt ? { finishedAt: review.finishedAt } : {}),
  };
}

/**
 * Turns a command line typed in project settings into an argument array: split on spaces, with "double" or 'single'
 * quotes keeping spaces inside one argument. No other shell syntax is interpreted; the result never runs in a shell.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = "",
    quote: string | null = null,
    has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else current += ch;
  }
  if (has || current) out.push(current);
  return out.filter((a) => a.length);
}

/** An argument array as one line for the settings field: quoted when it has spaces. */
export const joinCommand = (argv: readonly string[]) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

/** The user's messages the built-in check reads (§4.2): newest 30, at most 12 000 characters, each at most 1 500. */
export const conversationLimits = { perSession: 200, messages: 30, total: 12_000, each: 1_500 } as const;
const reworkMark = "[Flowly auto review";
// Provider injections, and messages one agent sends another (their full report, not the user's request).
const injectedMessage = /^(<task-notification|<system-reminder|<command-|<local-command|<paseo-system)/;
/** The card's user messages across its sessions, oldest first, without rework messages and injections. */
export function conversationForReview(messages: readonly { at: string; text: string }[]): string[] {
  const kept = messages
    .map((m) => ({ at: m.at, text: m.text.trim() }))
    .filter((m) => m.text && !m.text.startsWith(reworkMark) && !injectedMessage.test(m.text))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-conversationLimits.messages)
    .map((m) => (m.text.length > conversationLimits.each ? `${m.text.slice(0, conversationLimits.each)}…` : m.text));
  // Keep the newest within the total; the earliest go first.
  let total = 0;
  const out: string[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    if (total + kept[i].length > conversationLimits.total) break;
    total += kept[i].length;
    out.unshift(kept[i]);
  }
  return out;
}
