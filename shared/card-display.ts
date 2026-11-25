/** What a board card shows (CARD-DISPLAY-SPEC). Pure; the values live in the host-scoped board-view settings. */

/** Fields the user can hide. Signals that ask the user to act are not in this list: they always show. */
export const cardFields = ["workspace", "priority", "type", "external", "tags", "sessions", "workpad", "ideas", "umbrella"] as const;
export type CardField = (typeof cardFields)[number];

/** The activity line: `auto` shows the progress summary, else the latest output. */
export const cardActivityModes = ["auto", "progress", "output", "both", "none"] as const;
export type CardActivity = (typeof cardActivityModes)[number];

export type CardDisplay = { activity: CardActivity } & Record<CardField, boolean>;

export const defaultCardDisplay: CardDisplay = {
  activity: "auto",
  workspace: true,
  priority: true,
  type: true,
  external: true,
  tags: true,
  sessions: true,
  workpad: true,
  ideas: true,
  umbrella: true,
};

/** Visibility per field from the stored values; unknown hidden ids are ignored. */
export function cardDisplay(view: { cardActivity?: string; cardHidden?: readonly string[] } | null | undefined): CardDisplay {
  // `ticket` was the field's id before CONNECTORS-SPEC §3.3.
  const hidden = new Set((view?.cardHidden || []).map((id) => (id === "ticket" ? "external" : id)));
  const activity = (cardActivityModes as readonly string[]).includes(view?.cardActivity || "") ? (view!.cardActivity as CardActivity) : "auto";
  const display = { ...defaultCardDisplay, activity };
  for (const field of cardFields) display[field] = !hidden.has(field);
  return display;
}

/** `cardHidden` after showing or hiding one field; unknown ids from newer clients are kept. */
export function withCardField(hidden: readonly string[], field: CardField, shown: boolean): string[] {
  const rest = hidden.filter((id) => id !== field && !(field === "external" && id === "ticket"));
  return shown ? rest : [...rest, field];
}

/** Where a card works (CARD-DISPLAY-SPEC §8): its own Git worktree, or locally in a folder or checkout. */
export type CardWorkspace = "worktree" | "local";

/** Paseo's `workspaceKind` (directory, local_checkout, checkout, worktree) as the card shows it; unknown without a live workspace. */
export function cardWorkspace(kind: string | undefined): CardWorkspace | null {
  if (!kind) return null;
  return kind === "worktree" ? "worktree" : "local";
}

/** Which of the progress and output lines a card shows. */
export function activityLines(mode: CardActivity, hasProgress: boolean, hasOutput: boolean): { progress: boolean; output: boolean } {
  switch (mode) {
    case "none":
      return { progress: false, output: false };
    case "progress":
      return { progress: hasProgress, output: false };
    case "output":
      return { progress: false, output: hasOutput };
    case "both":
      return { progress: hasProgress, output: hasOutput };
    default:
      return { progress: hasProgress, output: !hasProgress && hasOutput };
  }
}
