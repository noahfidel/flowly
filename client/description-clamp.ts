/**
 * The card drawer's description clamp: a description taller than about six
 * lines starts collapsed behind Show more (UI-REFRESH-SPEC §4).
 */

/** The description is SessionMarkdown body text (14 pt, line height 14 * 1.55, client/session-content.tsx). Six lines. */
export const DESCRIPTION_CLAMP_HEIGHT = Math.ceil(6 * 14 * 1.55);

/** Content a few points over the clamp does not get a toggle. */
export function clampOverflows(natural: number, clampHeight: number): boolean {
  return natural > clampHeight + 8;
}

/** Cards whose description the user expanded, kept for the client session (an app restart starts collapsed). */
const opened = new Map<string, true>();

export function descriptionOpen(taskId: string): boolean {
  return opened.has(taskId);
}

export function setDescriptionOpen(taskId: string, open: boolean): void {
  if (open) opened.set(taskId, true);
  else opened.delete(taskId);
}

/** Tests only. */
export function resetDescriptionOpen(): void {
  opened.clear();
}
