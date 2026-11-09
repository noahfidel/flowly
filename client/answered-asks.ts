import { useSyncExternalStore } from "react";

/**
 * Asks answered (or ended, or dismissed) from the dispatcher chat that the board's live sources may still show
 * (DISPATCHER-SPEC §9.4): the bell leaves them out of its count until they leave the live list, as the daemon's
 * count leaves out what the chat recorded. Kept in memory for this client only.
 */

let answered: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const changed = (next: ReadonlySet<string>) => {
  answered = next;
  listeners.forEach((listener) => listener());
};

export function markAsksAnswered(signals: Iterable<string>) {
  const next = new Set(answered);
  for (const signal of signals) next.add(signal);
  if (next.size !== answered.size) changed(next);
}

/** Drops the signals no longer in the live list (`live`: every signal the board currently shows). */
export function forgetAnsweredMissing(live: ReadonlySet<string>) {
  const next = new Set([...answered].filter((signal) => live.has(signal)));
  if (next.size !== answered.size) changed(next);
}

export const answeredAsks = () => answered;

/**
 * What the bell leaves out: the daemon's resolved signals (`asks.resolved`, right after a reload or with the chat
 * closed) and this client's own answers not yet listed there. The client set itself when the daemon's adds nothing.
 */
export function bellResolved(daemon: readonly string[] | undefined, client: ReadonlySet<string>): ReadonlySet<string> {
  if (!daemon?.length) return client;
  return new Set([...daemon, ...client]);
}

export function subscribeAnsweredAsks(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useAnsweredAsks(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeAnsweredAsks, answeredAsks, answeredAsks);
}
