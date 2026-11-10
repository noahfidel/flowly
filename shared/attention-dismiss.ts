import { z } from "zod";

/**
 * Snoozing a card's Attention signals until something new happens, per list (ATTENTION-DISMISS-SPEC). Internal names
 * keep "dismiss"; the user-facing name is Snooze.
 */
export const attentionDismissLimits = { signals: 100, signal: 600, records: 10000 } as const;

/** The two Attention lists (ATTENTION-DISMISS-SPEC, Two lists): "N need you" and "N updated". */
export const snoozeLists = ["needs", "updated"] as const;
export type SnoozeList = (typeof snoozeLists)[number];
/** The list a signal key belongs to: an unread turn (`u:`) is in Updates, every other key in Needs you. */
export const signalList = (key: string): SnoozeList => (key.startsWith("u:") ? "updated" : "needs");

const keyList = (list: SnoozeList) =>
  z
    .array(z.string().min(1).max(attentionDismissLimits.signal))
    .min(1)
    .max(attentionDismissLimits.signals)
    .refine((keys) => new Set(keys).size === keys.length, "Duplicate attention signal.")
    .refine((keys) => keys.every((key) => signalList(key) === list), `Every signal must belong to the ${list} list.`);
const listSchema = (list: SnoozeList) => z.object({ signals: keyList(list), snoozedAt: z.string().datetime() });

/**
 * A record written before per-list Snooze, `{ taskId, signals, dismissedAt }`, reads as snoozed in both lists: its
 * `u:` keys in `updated`, the rest in `needs`, each with `snoozedAt = dismissedAt`, a list omitted when empty
 * (ATTENTION-DISMISS-SPEC, Data, Migration). Anything else passes through unchanged.
 */
function legacyDismissal(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.signals) || "needs" in value || "updated" in value) return raw;
  const { signals, dismissedAt, ...rest } = value;
  const keys = signals as unknown[];
  const of = (list: SnoozeList) => keys.filter((key) => typeof key !== "string" || signalList(key) === list);
  const needs = of("needs"),
    updated = of("updated");
  return {
    ...rest,
    ...(needs.length ? { needs: { signals: needs, snoozedAt: dismissedAt } } : {}),
    ...(updated.length ? { updated: { signals: updated, snoozedAt: dismissedAt } } : {}),
  };
}

export const attentionDismissalSchema = z.preprocess(
  legacyDismissal,
  z
    .object({
      taskId: z.string().min(1).max(200),
      needs: listSchema("needs").optional(),
      updated: listSchema("updated").optional(),
    })
    .refine((record) => !!record.needs || !!record.updated, "A snooze record needs at least one list."),
);
export type AttentionDismissal = z.infer<typeof attentionDismissalSchema>;

export const attentionDismissInput = z
  .strictObject({
    taskId: z.string().min(1).max(200),
    list: z.enum(snoozeLists),
    signals: z
      .array(z.string().min(1).max(attentionDismissLimits.signal))
      .min(1)
      .max(attentionDismissLimits.signals)
      .refine((keys) => new Set(keys).size === keys.length, "Duplicate attention signal."),
  })
  .refine((input) => input.signals.every((key) => signalList(key) === input.list), {
    message: "Every signal must belong to the list.",
    path: ["signals"],
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

/** The signals of one session, each with what it stands for (ATTENTION-DISMISS-SPEC, Signal keys). */
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
 * error or finished turn gets a new key (ATTENTION-DISMISS-SPEC, Signal keys).
 */
export function sessionSignalKeys(s: SessionSignals): string[] {
  return sessionSignalParts(s).map((p) => p.key);
}

/**
 * One list's set after snoozing one more signal (ATTENTION-DISMISS-SPEC, RPC, `asks.dismiss`): every key already
 * there is kept; when the set is full, its oldest keys that are no longer `current` (that list's current keys) make
 * room. Throws rather than drop a current key.
 */
export function addDismissedSignal(existing: readonly string[], signal: string, current: readonly string[]): string[] {
  if (existing.includes(signal)) return [...existing];
  const next = [...existing, signal];
  const live = new Set(current);
  live.add(signal);
  while (next.length > attentionDismissLimits.signals) {
    const stale = next.findIndex((key) => !live.has(key));
    if (stale < 0) throw new Error(`This card already has ${attentionDismissLimits.signals} snoozed signals in this list.`);
    next.splice(stale, 1);
  }
  return next;
}

type SnoozeRecord = Pick<AttentionDismissal, "needs" | "updated"> | undefined | null;

/** Whether a signal is snoozed: its key is in its own list's stored set (ATTENTION-DISMISS-SPEC, Rule). */
export function isKeySnoozed(key: string, record: SnoozeRecord): boolean {
  return !!record?.[signalList(key)]?.signals.includes(key);
}

/** Every stored key of the record, both lists. */
export function snoozedKeys(record: SnoozeRecord): Set<string> {
  return new Set([...(record?.needs?.signals ?? []), ...(record?.updated?.signals ?? [])]);
}

/**
 * Whether one list of a card is snoozed (ATTENTION-DISMISS-SPEC, Rule): the card has at least one current key of that
 * list and all of them are in the list's stored set. `signals` may hold both lists' keys; only `list`'s count.
 */
export function listSnoozed(signals: readonly string[], record: SnoozeRecord, list: SnoozeList): boolean {
  const own = signals.filter((key) => signalList(key) === list);
  const stored = record?.[list]?.signals;
  if (!own.length || !stored) return false;
  const seen = new Set(stored);
  return own.every((key) => seen.has(key));
}

/** The signal list to store: unique, bounded, order kept. */
export function dismissalSignals(signals: readonly string[]) {
  return [...new Set(signals)].slice(0, attentionDismissLimits.signals);
}
