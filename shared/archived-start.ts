import type { Task } from "./model";

/**
 * Whether Flowly may restore a card's archived workspace so the card can start (START-CARD-SPEC "Archived own
 * workspace at start"): only the directory or worktree workspace Flowly made for the card, never switched.
 * A shared or switched card's workspace is never touched.
 */
export function archivedWorkspaceStart(task: Pick<Task, "ownsWorkspace" | "previousWorkspaces" | "switch">): { restorable: boolean; reason: string } {
  const restorable = task.ownsWorkspace === true && !task.previousWorkspaces?.length && !task.switch;
  return {
    restorable,
    reason: restorable
      ? "The card's workspace was archived outside Flowly; starting the card restores it."
      : "The card's workspace was archived outside Flowly, and it is shared or was switched, so Flowly does not restore it.",
  };
}
