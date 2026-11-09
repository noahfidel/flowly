import { msg, t } from "../shared/i18n";

/** Start again's refusals in the user's words (DISPATCHER-SPEC §9.4); the daemon sends `CODE: message`. */
const refusals: Record<string, string> = {
  NEEDS_WORKTREE: msg("This card's folder already had sessions, or Flowly didn't create it for the card. Switch the card to a worktree from its menu, then start again."),
  CARD_HAS_SESSION: msg("The card already has a running session. Send it a message instead."),
};

export function startAgainMessage(error: string): string {
  const coded = /^([A-Z_]+): ([\s\S]*)$/.exec(error);
  if (!coded) return error;
  const known = refusals[coded[1]];
  return known ? t(known) : coded[2];
}
