import { useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { Idea, NextMove, Project, Task } from "../shared/model";
import type { NextRowData } from "../shared/native-session";
import type { SessionIdea } from "../shared/session-insights";
import { movesHidden } from "./hidden-moves";

/**
 * What Paseo's session view shows for a Flowly-managed session (NATIVE-SESSION-SPEC §6-8): the current Next moves
 * (for the timeline card) and the card's open ideas (for the Ideas chip). The chip refresh (`client/session-link.ts`)
 * fills it; popover contents and timeline rows read it, since host-rendered components get no props of ours.
 */
export type ChipState = {
  task: Task;
  project: Project;
  agentId: string;
  /** This turn's suggestions, or null when the Next moves card is hidden. */
  moves: { eventId: string; moves: NextMove[] } | null;
  /** The card's open ideas, newest first. */
  ideas: Idea[];
  /** The Auto wrap up setting: Move to Done then asks nothing here. */
  autoWrapup: boolean;
  /** What tapping a message suggestion on the Next moves card does (NATIVE-SESSION-SPEC §6.4). */
  nextMoveTap: "fill" | "copy";
};

/** A session Flowly does not manage (NATIVE-SESSION-SPEC §12): its current suggestion and open ideas. */
export type OutsideState = {
  agentId: string;
  workspaceId: string;
  moves: { eventId: string; moves: NextMove[] } | null;
  ideas: SessionIdea[];
  nextMoveTap: "fill" | "copy";
};
const outside = new Map<string, OutsideState>();
const outsideSignatures = new Map<string, string>();
export function setOutsideState(agentId: string, state: OutsideState | null) {
  if (state) {
    const signature = outsideSignature(state);
    if (outsideSignatures.get(agentId) === signature && outside.has(agentId)) return;
    outsideSignatures.set(agentId, signature);
    outside.set(agentId, state);
  } else {
    outsideSignatures.delete(agentId);
    if (!outside.delete(agentId)) return;
  }
  listeners.forEach((listener) => listener());
}
export function outsideStateIds() {
  return [...outside.keys()];
}
export function outsideState(agentId: string) {
  return outside.get(agentId) ?? null;
}
export function useOutsideState(agentId: string) {
  return useSyncExternalStore(subscribe, () => outsideState(agentId));
}

let client: PluginClientContext | null = null;
const states = new Map<string, ChipState>();
const listeners = new Set<() => void>();

/** The plugin context that registered the chips; null after teardown, so late actions do nothing. */
export function setChipClient(next: PluginClientContext | null) {
  client = next;
}
export function chipClient() {
  return client;
}

/** What a card or popover shows of a managed session: equal signatures need no re-render. */
const chipSignature = (s: ChipState) =>
  JSON.stringify([s.task.id, s.task.workspaceId, s.task.status, s.task.revision, s.project.id, s.project.revision, s.moves, s.ideas.map((i) => [i.id, i.updatedAt]), s.autoWrapup, s.nextMoveTap]);
const outsideSignature = (s: OutsideState) =>
  JSON.stringify([s.workspaceId, s.moves, s.ideas.map((i) => [i.id, i.updatedAt]), s.nextMoveTap]);
const signatures = new Map<string, string>();

export function setChipState(agentId: string, state: ChipState | null) {
  if (state) {
    // Every round recomputes this; only a real change may wake the cards and popovers that read it.
    const signature = chipSignature(state);
    if (signatures.get(agentId) === signature && states.has(agentId)) return;
    signatures.set(agentId, signature);
    states.set(agentId, state);
  } else {
    signatures.delete(agentId);
    if (!states.delete(agentId)) return;
  }
  listeners.forEach((listener) => listener());
}
export function chipStateIds() {
  return [...states.keys()];
}
export function chipState(agentId: string) {
  return states.get(agentId) ?? null;
}
export function clearChipStates() {
  if (!states.size && !pending.size && !outside.size) return;
  states.clear();
  pending.clear();
  outside.clear();
  signatures.clear();
  outsideSignatures.clear();
  listeners.forEach((listener) => listener());
}

/**
 * A wrap-up question the Next moves card is showing after Move to Done (NATIVE-SESSION-SPEC §6.4). Kept here, not in
 * the card, because moving the card to Done ends its suggestion set and the card would otherwise hide with the
 * question.
 */
export type WrapPending = { need: "ask" | "needs-flowly"; state: ChipState };
const pending = new Map<string, WrapPending>();
export function setWrapPending(agentId: string, eventId: string, value: WrapPending | null) {
  const key = `${agentId}:${eventId}`;
  if (value) pending.set(key, value);
  else if (!pending.delete(key)) return;
  listeners.forEach((listener) => listener());
}
export function wrapPending(agentId: string, eventId: string) {
  return pending.get(`${agentId}:${eventId}`) ?? null;
}
export function useWrapPending(agentId: string, eventId: string) {
  return useSyncExternalStore(subscribe, () => wrapPending(agentId, eventId));
}
/**
 * What a Next moves timeline row shows: its open wrap-up question, its moves while they are current, its moves
 * disabled once the next turn started (`past`, unless the user hid that set), or nothing.
 */
export function cardView(row: NextRowData, state: Pick<ChipState, "moves"> | null, agentId: string): "wrap" | "moves" | "past" | "hidden" {
  if (row.status === "past") return movesHidden(row.eventId) ? "hidden" : "past";
  if (row.status !== "ready") return "hidden";
  if (wrapPending(agentId, row.eventId)) return "wrap";
  // A row without a card belongs to a session Flowly does not manage (NATIVE-SESSION-SPEC §12.4).
  const current = row.taskId ? state?.moves : outsideState(agentId)?.moves;
  return current?.eventId === row.eventId ? "moves" : "hidden";
}
/** For tests: the listener set `useChipState` and friends subscribe to. */
export const subscribeForTest = (listener: () => void) => subscribe(listener);
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function useChipState(agentId: string) {
  return useSyncExternalStore(subscribe, () => chipState(agentId));
}

/**
 * The *Start progress rows collapsed* setting (NATIVE-SESSION-SPEC §5.3) for the Progress timeline rows, which Paseo
 * renders outside Flowly's tree: the chip refresh reads it with the other `native-session` settings. On (collapsed)
 * until the first read and when the daemon does not send it.
 */
let progressCollapsed = true;
export function setProgressRowsCollapsed(next: boolean) {
  if (next === progressCollapsed) return;
  progressCollapsed = next;
  listeners.forEach((listener) => listener());
}
export function progressRowsCollapsed() {
  return progressCollapsed;
}
export function useProgressRowsCollapsed() {
  return useSyncExternalStore(subscribe, progressRowsCollapsed);
}

let refresher: (() => void) | null = null;
/** Set by the chip refresh; null after teardown. */
export function setChipRefresher(next: (() => void) | null) {
  refresher = next;
}
/** After an action changed what the chips show (an idea dismissed, a card moved): refresh now, not at the next round. */
export function refreshChipsNow() {
  refresher?.();
}

const askedRows = new Map<string, number>();
/**
 * A Flowly timeline row reached Paseo's view before the chip refresh knew it as current (the row comes by push, the
 * state by the next round): ask for one round now, once per row, instead of waiting for the next tick.
 */
export function requestRowRefresh(agentId: string, eventId: string) {
  const key = `${agentId}:${eventId}`;
  if (askedRows.has(key)) return;
  // Bounded: only recent rows matter.
  if (askedRows.size >= 200) askedRows.delete(askedRows.keys().next().value!);
  askedRows.set(key, Date.now());
  refresher?.();
}

let requestSequence = 0;
export const chipRequestId = () => `${Date.now()}-n${++requestSequence}`;

/** "Open card" on a summary row: the same validated board link as the Task chip (SESSION-CHIP-SPEC). */
export function openCardFromRow(data: { taskId: string; workspaceId: string }, agentId: string) {
  client?.openScreen({
    screenId: "board",
    params: { taskId: data.taskId, workspaceId: data.workspaceId, sessionId: agentId, requestId: chipRequestId() },
  });
}
