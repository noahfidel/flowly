import { msg } from "./i18n";

/** How a card's work is handed over (DELIVERY-MODE-SPEC §1). */
export const deliveryModes = ["branch", "draft_pr", "ready_pr"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const defaultDeliveryMode: DeliveryMode = "branch";

/** Translate at render with `t()`. */
export const deliveryModeLabels: Record<DeliveryMode, string> = {
  branch: msg("Branch, I bless"),
  draft_pr: msg("Draft PR"),
  ready_pr: msg("Ready PR"),
};

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === "string" && (deliveryModes as readonly string[]).includes(value);
}

/** The card's stored mode when it is a known one, else `fallback` (the host default); an unknown stored value is never rewritten (§2). */
export function effectiveDeliveryMode(stored: unknown, fallback: DeliveryMode = defaultDeliveryMode): DeliveryMode {
  return isDeliveryMode(stored) ? stored : fallback;
}

const permission = "Pushing and opening the PR still go through the user's permission prompt, which the user answers.";

/** The agent-facing line of a mode, English (§3). */
export function deliveryLine(mode: DeliveryMode): string {
  switch (mode) {
    case "branch":
      return `Delivery: commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch.`;
    case "draft_pr":
      return `Delivery: push the card's branch and open a draft PR; register its URL as an output. ${permission} Leave the PR a draft; never mark it ready.`;
    case "ready_pr":
      return `Delivery: push the card's branch and open a PR ready for review; register its URL as an output. ${permission} Never mark a PR ready while review notes are open.`;
  }
}
