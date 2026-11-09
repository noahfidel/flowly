import { msg, t } from "../shared/i18n";

/** Start again's refusals in the user's words (DISPATCHER-SPEC §9.4); the daemon sends `CODE: message`. */
const refusals: Record<string, string> = {
  NEEDS_WORKTREE: msg("This card's folder already had sessions, or Flowly didn't create it for the card. Switch the card to a worktree from its menu, then start again."),
  CARD_HAS_SESSION: msg("The card already has a running session. Send it a message instead."),
};

function refusalText(error: string, known: Record<string, string>): string {
  const coded = /^([A-Z_]+): ([\s\S]*)$/.exec(error);
  if (!coded) return error;
  const text = known[coded[1]];
  return text ? t(text) : coded[2];
}

export function startAgainMessage(error: string): string {
  return refusalText(error, refusals);
}

/** Start dispatcher's refusals in the user's words (DISPATCHER-SPEC §3); the daemon sends `CODE: message`. */
const dispatcherRefusals: Record<string, string> = {
  DISPATCHER_PROVIDER_UNSUPPORTED: msg("The dispatcher runs only on Claude: on other providers Flowly can't keep it from answering cards' questions and permission requests. Choose a Claude model for the dispatcher in Settings → Models."),
};

export function dispatcherStartMessage(error: string): string {
  return refusalText(error, dispatcherRefusals);
}
