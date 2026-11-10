import { z } from "zod";

/** Dismissing a card from Attention until something new happens (ATTENTION-DISMISS-SPEC). */
export const attentionDismissLimits = { signals: 100, signal: 600, records: 10000 } as const;

const signalList = z
  .array(z.string().min(1).max(attentionDismissLimits.signal))
  .min(1)
  .max(attentionDismissLimits.signals)
  .refine((list) => new Set(list).size === list.length, "Duplicate attention signal.");

export const attentionDismissalSchema = z.object({
  taskId: z.string().min(1).max(200),
  signals: signalList,
  dismissedAt: z.string().datetime(),
});
export type AttentionDismissal = z.infer<typeof attentionDismissalSchema>;

export const attentionDismissInput = z.strictObject({
  taskId: z.string().min(1).max(200),
  signals: signalList,
});
export type AttentionDismissInput = z.infer<typeof attentionDismissInput>;
export const attentionRestoreInput = z.strictObject({ taskId: z.string().min(1).max(200) });
export type AttentionRestoreInput = z.infer<typeof attentionRestoreInput>;

/** One session's attention, as counted by Attention; each part is one concrete thing to deal with. */
export interface SessionSignals {
  agent: {
    id: string;
    attentionTimestamp?: string | null;
    lastUserMessageAt?: string | null;
  };
  /** The open Kanban question event, if any. */
  questionEventId: string | null;
  /** The open Kanban blocker event, if any (open until the session's next turn starts; plan Q5). */
  blockerEventId?: string | null;
  /** Pending permission/question request IDs; empty when the host omits them. */
  requestIds: readonly string[];
  /** Those of `requestIds` that are agent questions (AskUserQuestion) rather than approvals. */
  questionRequestIds?: readonly string[];
  permission: boolean;
  error: boolean;
  unread: boolean;
  /** Native attention token of the unread generation; null when unknown. */
  token: string | null;
  manualUnread: boolean;
}

/** What one signal is, as the dispatcher chat answers it (DISPATCHER-SPEC §9.4). */
export const askKinds = ["question_report", "blocker_report", "ask_user", "permission", "error", "unread"] as const;
export type AskKind = (typeof askKinds)[number];
/**
 * Whether a signal waits on you and counts in "N need you" (DISPATCHER-SPEC §9.4; Ruling, Noah 2026-11-09): questions,
 * blockers, requests and errors do; an unread turn is something new to read and counts in "N updated" instead.
 */
export const waitsOnYou = (kind: AskKind): boolean => kind !== "unread";
export const askStates = ["open", "answered", "session_ended", "dismissed"] as const;
export type AskState = (typeof askStates)[number];
/** One signal: its key, its kind, and the event or request it stands for. */
export type SignalPart = { key: string; kind: AskKind; eventId?: string; requestId?: string };

/** The signals of one session, each with what it stands for (§2.2, §7a). */
export function sessionSignalParts(s: SessionSignals): SignalPart[] {
  const id = s.agent.id,
    parts: SignalPart[] = [];
  if (s.questionEventId) parts.push({ key: `q:${s.questionEventId}`, kind: "question_report", eventId: s.questionEventId });
  if (s.blockerEventId) parts.push({ key: `b:${s.blockerEventId}`, kind: "blocker_report", eventId: s.blockerEventId });
  if (s.permission || s.requestIds.length) {
    const questions = new Set(s.questionRequestIds ?? []);
    if (s.requestIds.length)
      s.requestIds.forEach((r) => parts.push({ key: `p:${id}:${r}`, kind: questions.has(r) ? "ask_user" : "permission", requestId: r }));
    else parts.push({ key: `p:${id}:${s.agent.attentionTimestamp || ""}`, kind: "permission" });
  }
  if (s.error) parts.push({ key: `e:${id}:${s.agent.attentionTimestamp || "status"}`, kind: "error" });
  if (s.unread)
    parts.push({
      key: s.manualUnread ? `u:${id}:manual` : s.token ? `u:${s.token}` : `u:${id}:${s.agent.lastUserMessageAt || ""}`,
      kind: "unread",
    });
  return parts;
}

/**
 * Stable identities of what a session is waiting on: a new question, blocker, request,
 * error or finished turn gets a new key (§2.2).
 */
export function sessionSignalKeys(s: SessionSignals): string[] {
  return sessionSignalParts(s).map((p) => p.key);
}

/**
 * The card's set after dismissing one more signal (§7a): every key already there is kept; when the set is
 * full, its oldest keys that are no longer `current` make room. Throws rather than drop a current key.
 */
export function addDismissedSignal(existing: readonly string[], signal: string, current: readonly string[]): string[] {
  if (existing.includes(signal)) return [...existing];
  const next = [...existing, signal];
  const live = new Set(current);
  live.add(signal);
  while (next.length > attentionDismissLimits.signals) {
    const stale = next.findIndex((key) => !live.has(key));
    if (stale < 0) throw new Error(`This card already has ${attentionDismissLimits.signals} dismissed signals.`);
    next.splice(stale, 1);
  }
  return next;
}

/** Hidden while every current signal was already there when the card was dismissed (§2.3). */
export function isDismissed(signals: readonly string[], record: Pick<AttentionDismissal, "signals"> | undefined | null) {
  if (!record || !signals.length) return false;
  const seen = new Set(record.signals);
  return signals.every((s) => seen.has(s));
}

/** The signal list to store: unique, bounded, order kept. */
export function dismissalSignals(signals: readonly string[]) {
  return [...new Set(signals)].slice(0, attentionDismissLimits.signals);
}
