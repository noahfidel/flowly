// Pure (no react-native imports) so vitest can load it; card.tsx renders what this builds.
import { priorityLabels, taskTypeLabels, type Task } from "../shared/model";
import { t, tn } from "../shared/i18n";
import type { WorkpadSignal } from "../shared/workpad";
import type { SessionAttentionSummary } from "../shared/session-attention";
import type { CardOutput } from "./card-output";

/** The card's workpad signal: only `Acceptance n/m` (GUARDRAILS-SPEC §7.1). */
export function workpadText(signal: WorkpadSignal) {
  return signal.kind === "acceptance" ? t("Acceptance {done}/{total}", { done: signal.done, total: signal.total }) : "";
}

/**
 * The card's accessible name (UI-UX-SPEC §2, automation names): the title and lane first, then
 * every fact the card can show, whatever Card display hides (CARD-DISPLAY-SPEC §2). Scripts open
 * a card by matching `^Open task {title}.`; screen readers hear the same sentence.
 */
export function taskCardLabel(card: {
  title: string;
  /** The lane's display name (lanes are statuses; it covers both). Empty when unknown. */
  lane?: string;
  questions: number;
  ideas: number;
  waiting: number;
  waitingTitles: string;
  progress: { state: string; at: string } | null;
  workpad: WorkpadSignal | null;
  /** The auto review's label when the card shows it, else empty (built by the caller). */
  review?: string;
  attentionDismissed: boolean;
  priority: Task["priority"];
  type: Task["type"];
  /** Worktree or local, already localized, while the workspace is live (CARD-DISPLAY-SPEC §8). Empty when unknown. */
  workspace?: string;
  archivedAt: string | null;
  legacy: boolean;
  summaryState: "ready" | "loading" | "stale" | "unavailable";
  summary?: SessionAttentionSummary;
  output: CardOutput | null;
  outputTime: string;
}): string {
  const { title, lane, questions, ideas, waiting, waitingTitles, progress, workpad, review, attentionDismissed, summaryState, summary, output, outputTime } = card;
  return [
    t("Open task {title}", { title }),
    lane || "",
    questions ? tn(questions, "Needs you: {n} open question", "Needs you: {n} open questions") : "",
    ideas ? tn(ideas, "{n} idea", "{n} ideas") : "",
    waiting ? tn(waiting, "Waiting on {n} card: {waitingTitles}", "Waiting on {n} cards: {waitingTitles}", { waitingTitles }) : "",
    progress ? t("Progress: {state}", { state: progress.state }) : "",
    workpad ? workpadText(workpad) : "",
    review || "",
    attentionDismissed ? t("Dismissed from Attention") : "",
    [t("{priority} priority", { priority: priorityLabels[card.priority] }), card.type ? taskTypeLabels[card.type] : "", card.workspace || "", card.archivedAt ? t("archived") : "", card.legacy ? t("legacy scope") : ""].filter(Boolean).join(", "),
    summaryState === "ready" && summary
      ? t("{running} running, {finished} finished turns, {unread} unread sessions, {attention} need attention", { running: summary.running, finished: summary.finished, unread: summary.unread, attention: summary.attention })
      : "",
    output ? t(outputTime ? "Latest agent output {time}: {text}" : "Latest agent output: {text}", { time: outputTime ?? "", text: output.text.length > 80 ? output.text.slice(0, 80) + "…" : output.text }) : "",
  ]
    .filter(Boolean)
    .join(". ") + ".";
}
