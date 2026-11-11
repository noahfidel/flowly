import { msg } from "./i18n";

/** How a card's work is handed over (DELIVERY-MODE-SPEC §1). */
export const deliveryModes = ["branch", "draft_pr", "ready_pr", "ship_main"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const defaultDeliveryMode: DeliveryMode = "branch";

/** Translate at render with `t()`. */
export const deliveryModeLabels: Record<DeliveryMode, string> = {
  branch: msg("Branch, I bless"),
  draft_pr: msg("Draft PR"),
  ready_pr: msg("Ready PR"),
  ship_main: msg("Ship to main"),
};

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === "string" && (deliveryModes as readonly string[]).includes(value);
}

/** The card's stored mode when it is a known one, else `fallback` (the host default); an unknown stored value is never rewritten (§2). */
export function effectiveDeliveryMode(stored: unknown, fallback: DeliveryMode = defaultDeliveryMode): DeliveryMode {
  return isDeliveryMode(stored) ? stored : fallback;
}

/**
 * The mode a card hands over with (board groups spec §5): the card's own, then its project's, its group's, then the
 * host default. Each level counts only when it is a known mode; the last fallback is the built-in default.
 */
export function resolveDeliveryMode(levels: { card?: unknown; project?: unknown; group?: unknown; host?: unknown }): { mode: DeliveryMode; source: "card" | "project" | "group" | "host" } {
  for (const source of ["card", "project", "group"] as const) {
    const value = levels[source];
    if (isDeliveryMode(value)) return { mode: value, source };
  }
  return { mode: isDeliveryMode(levels.host) ? levels.host : defaultDeliveryMode, source: "host" };
}

/**
 * A delivery lane: In review, Committed and Integrated (the same three as `deliveryStatuses` in
 * `shared/model.ts`, which imports this module).
 */
export function inDeliveryLane(status: string): boolean {
  return status === "in_review" || status === "committed" || status === "integrated";
}

/**
 * Whether a card has delivered, so its mode is fixed for good (§2, rulings 2026-11-08 and 2026-11-09): it carries
 * the `deliveredAt` mark (set by the store on its first write into a delivery lane), or it is in one now (a card
 * written before the mark).
 */
export function deliveryModeLocked(task: { status: string; deliveredAt?: string }): boolean {
  return !!task.deliveredAt || inDeliveryLane(task.status);
}

const permission ="Pushing and opening the PR still go through the user's permission prompt, which the user answers.";

/** The agent-facing line of a mode, English (§3). */
export function deliveryLine(mode: DeliveryMode): string {
  switch (mode) {
    case "branch":
      return `Delivery: commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch.`;
    case "draft_pr":
      return `Delivery: push the card's branch and open a draft PR; register its URL as an output. ${permission} Leave the PR a draft; never mark it ready.`;
    case "ready_pr":
      return `Delivery: push the card's branch and open a PR ready for review; register its URL as an output. ${permission} Never mark a PR ready while review notes are open.`;
    case "ship_main":
      return `Delivery: ship to main only after the card's checks pass and its review has no open findings. Rebase the card's branch onto the latest main (fetch first), rerun the checks, call flowly_integrate, then git push origin main. Never force-push and never push any other branch. ${permission} Stop and report, leaving the card In review, when the rebase conflicts, checks fail after the rebase, flowly_integrate refuses, or a review finding is open; if the push is rejected, set integrated and report it. Do not update the installed plugin.`;
  }
}
