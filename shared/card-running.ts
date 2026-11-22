/**
 * When a card counts as running (SUBAGENTS-SPEC §10): one of its sessions runs a turn, or one of its subagents
 * runs (Ruling, Noah 2026-11-22). The one definition for the card's live edge and signal, its accessible name,
 * the overview's running chip and the running list. Pure: no React, no SDK calls.
 */
import { parentOf } from "./subagents";

export type RunningAgent = {
  id?: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
  labels?: Record<string, string> | null;
  createdAt?: string | null;
  activeTurn?: { startedAt?: string | null } | null;
};

/** Running provider subagents per card session (`subagents.activity`), and when the oldest of them started. */
export type ProviderRunning = {
  running: Readonly<Record<string, number>>;
  since?: Readonly<Record<string, string>>;
};

export type CardActivity = {
  /** Card sessions in a running turn. */
  sessions: number;
  /** Card sessions still starting. */
  starting: number;
  /** Running provider subagents of the card's sessions, plus their active Paseo child agents in other workspaces. */
  subagents: number;
  running: boolean;
  /** The earliest start among what runs; null when none is known. */
  since: string | null;
};

/** A session or child agent that is working: Paseo's `running` or `initializing`. */
export const isAgentActive = (status: string) => status === "running" || status === "initializing";

export const idleActivity: CardActivity = Object.freeze({ sessions: 0, starting: 0, subagents: 0, running: false, since: null });
const noProvider: ProviderRunning = Object.freeze({ running: Object.freeze({}) });

const earlier = (a: string | null, b: string | null | undefined) => (!b ? a : !a || b < a ? b : a);

/**
 * Activity of every card workspace in `workspaceIds`, in one pass over the agents. Only workspaces with something
 * running get an entry. A Paseo child agent in the card's own workspace is a card session already and is counted
 * once, as a session; a child in another workspace (a helper workspace) counts as a subagent of the card whose
 * session started it (Ruling, Noah 2026-11-22). Archived agents never count.
 */
export function cardActivities(
  workspaceIds: ReadonlySet<string>,
  agents: readonly RunningAgent[],
  provider: ProviderRunning = noProvider,
): Map<string, CardActivity> {
  const out = new Map<string, CardActivity>();
  const entry = (workspaceId: string) => {
    let found = out.get(workspaceId);
    if (!found) out.set(workspaceId, (found = { sessions: 0, starting: 0, subagents: 0, running: false, since: null }));
    return found;
  };
  // Card sessions by id, so a child elsewhere finds its parent's card.
  const sessionWorkspace = new Map<string, string>();
  for (const a of agents) {
    if (a.archivedAt || !a.workspaceId || !workspaceIds.has(a.workspaceId)) continue;
    if (a.id) sessionWorkspace.set(a.id, a.workspaceId);
    const subagents = (a.id && provider.running[a.id]) || 0;
    if (a.status === "running" || a.status === "initializing") {
      const e = entry(a.workspaceId);
      if (a.status === "running") e.sessions++;
      else e.starting++;
      e.since = earlier(e.since, a.activeTurn?.startedAt);
    }
    if (subagents > 0) {
      const e = entry(a.workspaceId);
      e.subagents += subagents;
      e.since = earlier(e.since, a.id ? provider.since?.[a.id] : null);
    }
  }
  for (const a of agents) {
    if (a.archivedAt || !isAgentActive(a.status)) continue;
    const parent = parentOf(a);
    const workspaceId = parent ? sessionWorkspace.get(parent) : undefined;
    if (!workspaceId || a.workspaceId === workspaceId) continue;
    // In another card's workspace it is that card's session too; it still runs work this card started.
    const e = entry(workspaceId);
    e.subagents++;
    e.since = earlier(e.since, a.activeTurn?.startedAt || a.createdAt);
  }
  out.forEach((e) => {
    e.running = e.sessions + e.starting + e.subagents > 0;
  });
  return out;
}

/** One card's activity (see `cardActivities`). */
export function cardActivity(input: { cardWorkspaceId: string; agents: readonly RunningAgent[]; providerRunning?: ProviderRunning }): CardActivity {
  return cardActivities(new Set([input.cardWorkspaceId]), input.agents, input.providerRunning).get(input.cardWorkspaceId) ?? idleActivity;
}
