import type { CardDetail } from "../shared/card-detail";
import { z } from "zod";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { ComponentType } from "react";
import type {
  PluginButtonContentProps,
  PluginClientContext,
  PluginButtonRegistration,
  PluginScreenParams,
} from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { archivedSessionRefs, nativeChips, readChipBoardChanged, sessionInsights } from "../shared/rpc";
import type { SessionInsightView } from "../shared/session-insights";
import { parentOf } from "../shared/subagents";
import { isSummarizer } from "../shared/summary";
import { chipMoves, sessionChipMoves } from "../shared/next-moves";
import { movesHidden, onMovesHidden } from "./hidden-moves";
import { applyLiveUpdate, relevantChange } from "./live-agents";
import { perfEnd, perfStart } from "./perf";
import {
  chipStateIds,
  clearChipStates,
  outsideStateIds,
  setChipClient,
  setChipRefresher,
  setChipState,
  setOutsideState,
  type ChipState,
  type OutsideState,
} from "./native-chips";
import { listAgents } from "./resources";
import { readBoardDelta, type Board } from "./board-read";
import { t } from "../shared/i18n";
import { isLinearLink } from "./linear-start";

const id = z.string().min(1).max(200);
const linkSchema = z.object({
  taskId: id,
  sessionId: id,
  workspaceId: id,
  requestId: id,
});
export type CardSessionLink = z.infer<typeof linkSchema>;
/** A one-time drawer entry; an empty `sessionId` opens the card overview. */
export type SessionEntry = { sessionId: string; requestId: string };
export type LinkBoard = Board;

export function parseSessionLink(
  params?: PluginScreenParams,
): CardSessionLink | null {
  if (
    !params ||
    // An idea link ("Start a new task" from the Ideas chip) and the Linear board's links also carry a requestId.
    "ideaId" in params ||
    isLinearLink(params) ||
    !["taskId", "sessionId", "workspaceId", "requestId"].some(
      (key) => key in params,
    )
  )
    return null;
  const result = linkSchema.safeParse(params);
  if (!result.success)
    throw new Error(
      t("Invalid Kanban session link. Open it again from the session chip."),
    );
  return result.data;
}
/** projectId: the idea's project, so the board reads only its ideas; links from before it name none. */
const ideaLinkSchema = z.object({ ideaId: id, projectId: id.optional(), requestId: id });
export type IdeaLink = z.infer<typeof ideaLinkSchema>;
/** "Start a new task" from the native Ideas chip: open Flowly's new-card form for this idea (NATIVE-SESSION-SPEC §7.3). */
export function parseIdeaLink(params?: PluginScreenParams): IdeaLink | null {
  if (!params || !("ideaId" in params)) return null;
  const result = ideaLinkSchema.safeParse(params);
  if (!result.success) throw new Error(t("Invalid idea link. Open it again from the Ideas chip."));
  return result.data;
}
export function sessionLinkKey(link: CardSessionLink) {
  return JSON.stringify([
    link.taskId,
    link.sessionId,
    link.workspaceId,
    link.requestId,
  ]);
}

/** Prefix a failure with the step that produced it, so host toasts are diagnosable. */
async function step<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${text}`);
  }
}

/** Native navigation authorizes a fresh detail scope and the exact native session. */
export async function resolveCardDetailLink(paseo: PaseoApi, read: () => Promise<CardDetail>, link: CardSessionLink) {
  const [detail, snapshot] = await Promise.all([
    step(t("Kanban board read failed"), read),
    step(t("Session lookup failed"), () => paseo.agents.ref(link.sessionId).refresh()),
  ]);
  if (detail.task.id !== link.taskId || detail.task.workspaceId !== link.workspaceId || detail.project.id !== detail.task.projectId)
    throw new Error(t("This session's linked card is unavailable. Refresh the session chip or open Flowly."));
  const actor = snapshot?.agent;
  if (!actor || actor.id !== link.sessionId || actor.workspaceId !== link.workspaceId)
    throw new Error(t("This session is unavailable or its workspace changed. Refresh the session chip."));
  return { detail, board: undefined, task: detail.task, project: detail.project, actor, link };
}

let requestSequence = 0;
const newRequestId = () => `${Date.now()}-${++requestSequence}`;

/** The first chip round waits this long, so it does not compete with the plugin's own first paint (PERFORMANCE-SPEC, Cold start). */
export const CHIPS_START_DELAY_MS = 2500;

/** The Ideas chip's popovers (NATIVE-SESSION-SPEC §7, §12.5); passed in so this module stays free of UI code. */
export type ChipPopovers = {
  ideas: ComponentType<PluginButtonContentProps>;
  /** For a session Flowly does not manage; without it those sessions get no Ideas chip. */
  outsideIdeas?: ComponentType<PluginButtonContentProps>;
};

export function registerSessionChips(
  client: PluginClientContext,
  interval = 5000,
  startDelay = CHIPS_START_DELAY_MS,
  popovers?: ChipPopovers,
) {
  const registrations = new Map<
    string,
    { binding: string; label: string; chip: PluginButtonRegistration }
  >();
  // The Ideas pills, by session; `signature` covers what the popover shows. The Next moves card is a timeline row
  // (NATIVE-SESSION-SPEC §6): this refresh only records which suggestion set is current for it.
  type Extra = { binding: string; signature: string; chip: PluginButtonRegistration };
  const ideaPills = new Map<string, Extra>();
  type Outside = { enabled: boolean; progress: boolean; nextMoves: boolean; ideas: boolean };
  let chipInfo: { managed: Set<string>; ideas: boolean; autoWrapup: boolean; nextMoveTap: "fill" | "copy"; outside: Outside } | null = null,
    chipInfoAt = 0;
  let outsideEtag = "",
    outsideViews = new Map<string, SessionInsightView>();
  if (popovers) setChipClient(client);
  let lastRound: { current: LinkBoard; tasks: Map<string, LinkBoard["tasks"][number]> } | null = null;
  // Hiding a set on the Next moves card takes it away at once, not at the next round.
  const stopHidden = onMovesHidden(() => {
    if (!disposed && lastRound) syncExtras(lastRound.current, [...live.values()], lastRound.tasks);
  });
  // This poll runs on every client, phones included, where each response is
  // decoded on the JS thread while the user may be typing in a composer
  // (PERFORMANCE-SPEC). So: the board is re-read only when its etag changed;
  // live sessions come from the agent stream (listed once, then every minute to
  // reconcile; every round only where there is no stream); and the archived scan
  // (every agent on the host, megabytes) runs after the round, never inside it,
  // when a chipped session left the live list or once a minute (NATIVE-SESSION-SPEC §8).
  let board: LinkBoard | null = null,
    etag = "",
    // Only what the Task chip needs of an archived session.
    archived: { id: string; workspaceId: string | null }[] = [],
    archivedAt = 0,
    scanning = false;
  const archivedEvery = 60_000;
  const liveEvery = 60_000;
  // A pushed change of one session asks for a round soon; the wait gathers the updates of one transition.
  const nudgeAfter = 150;
  const live = new Map<string, PaseoAgent>();
  let liveAt = 0,
    streamReady = false,
    // Set when the stream starts: a list that began earlier may have missed updates, so list once more.
    relist = false,
    stopStream: (() => void) | null = null,
    releaseStream: (() => Promise<void>) | null = null;
  const opening = new Set<string>();
  let disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    latestClick = 0;
  function clearExtras() {
    for (const { chip } of ideaPills.values()) chip.remove();
    ideaPills.clear();
    clearChipStates();
  }
  function clear() {
    for (const { chip } of registrations.values()) chip.remove();
    registrations.clear();
    clearExtras();
    lastRound = null;
  }
  /** The full list of live sessions replaces what is held (a newer pushed copy of a session wins). */
  function reconcileLive(list: readonly PaseoAgent[]) {
    const ids = new Set(list.map((a) => a.id));
    for (const id of [...live.keys()]) if (!ids.has(id)) live.delete(id);
    // The list is the host's own answer for live sessions: trust it, but never go back in time on a pushed copy.
    for (const agent of list) {
      const held = live.get(agent.id);
      if (!held || !(held.updatedAt > agent.updatedAt)) live.set(agent.id, agent);
    }
    liveAt = Date.now();
  }
  /** Follows the sessions by push, as the board does (`openAgentStream` in queries.ts); a phone then lists them rarely. */
  function openStream() {
    const agents = client.paseo.agents;
    if (stopStream || typeof agents.subscribe !== "function") return;
    let nudge: ReturnType<typeof setTimeout> | undefined;
    const stopListening = agents.subscribe((update) => {
      if (disposed) return;
      const { changed, before, after } = applyLiveUpdate(live, update);
      if (!changed || !relevantChange(before, after)) return;
      clearTimeout(nudge);
      nudge = setTimeout(refreshNow, nudgeAfter);
    });
    stopStream = () => {
      stopListening();
      clearTimeout(nudge);
    };
    void agents
      .list({ filter: { includeArchived: false }, page: { limit: 1 }, subscribe: {} })
      .then((result) => {
        releaseStream = () => result.subscription.release();
        if (disposed) return void releaseStream().catch(() => undefined);
        streamReady = true;
        relist = true;
      })
      .catch(() => undefined);
  }
  // Adds, updates in place, or removes one Next/Ideas pill; `button` is null to remove.
  function syncPill(
    pills: Map<string, Extra>,
    id: string,
    agentId: string,
    workspaceId: string,
    binding: string,
    signature: string,
    button: ReturnType<typeof ideasButton> | null,
  ) {
    let existing = pills.get(agentId);
    if (existing && (!button || existing.binding !== binding)) {
      existing.chip.remove();
      pills.delete(agentId);
      existing = undefined;
    }
    if (!button) return;
    if (existing) {
      if (existing.signature !== signature) {
        existing.chip.update(button);
        existing.signature = signature;
      }
    } else pills.set(agentId, { binding, signature, chip: client.addComposerPill({ id, workspaceId, agentId, button }) });
  }
  // Built in their own calls (Hermes, see chipButton). The content comes from the chip store, keyed by session.
  function ideasButton(state: ChipState) {
    return {
      title: t("Ideas for this card"),
      label: t("Ideas · {n}", { n: state.ideas.length }),
      icon: "Lightbulb",
      behavior: { kind: "popover" as const, Content: popovers!.ideas },
    };
  }
  /** NATIVE-SESSION-SPEC §6.1, §7.1: managed, live sessions of an active card only. */
  function syncExtras(current: LinkBoard, agents: readonly PaseoAgent[], tasks: Map<string, LinkBoard["tasks"][number]>) {
    if (!popovers || !chipInfo) return;
    const seen = new Set<string>();
    for (const actor of agents) {
      const task = actor.workspaceId ? tasks.get(actor.workspaceId) : undefined;
      const project = task && current.projects.find((p) => p.id === task.projectId);
      if (!task || !project || task.archivedAt || project.archivedAt || actor.archivedAt || !chipInfo.managed.has(actor.id)) continue;
      seen.add(actor.id);
      const finished = task.status === "done" || task.status === "cancelled";
      const moves = chipMoves({ events: current.events ?? [], agent: actor, cardFinished: finished, hidden: movesHidden });
      const ideas = chipInfo.ideas
        ? (current.ideas ?? []).filter((i) => i.taskId === task.id && i.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];
      const state: ChipState = { task, project, agentId: actor.id, moves, ideas, autoWrapup: chipInfo.autoWrapup, nextMoveTap: chipInfo.nextMoveTap };
      setChipState(actor.id, state);
      const binding = JSON.stringify([task.id, task.workspaceId]);
      syncPill(ideaPills, "flowly-ideas", actor.id, task.workspaceId, binding,
        JSON.stringify(ideas.map((i) => [i.id, i.updatedAt])), ideas.length ? ideasButton(state) : null);
    }
    const seenOutside = syncOutside(agents);
    for (const agentId of [...ideaPills.keys()]) {
      if (seen.has(agentId) || seenOutside.has(agentId)) continue;
      ideaPills.get(agentId)?.chip.remove();
      ideaPills.delete(agentId);
    }
    for (const agentId of chipStateIds()) if (!seen.has(agentId)) setChipState(agentId, null);
    for (const agentId of outsideStateIds()) if (!seenOutside.has(agentId)) setOutsideState(agentId, null);
  }
  /** NATIVE-SESSION-SPEC §12: live, top-level sessions Flowly does not manage, when switched on. */
  function syncOutside(agents: readonly PaseoAgent[]) {
    const seen = new Set<string>();
    const settings = chipInfo?.outside;
    if (!popovers || !chipInfo || !settings?.enabled) return seen;
    for (const actor of agents) {
      if (chipInfo.managed.has(actor.id) || actor.archivedAt || !actor.workspaceId || parentOf(actor) || isSummarizer(actor)) continue;
      const view = outsideViews.get(actor.id);
      const moves = settings.nextMoves ? sessionChipMoves({ suggestion: view?.suggestion ?? null, agent: actor, hidden: movesHidden }) : null;
      const ideas = settings.ideas && popovers.outsideIdeas ? [...(view?.ideas ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
      if (!moves && !ideas.length) continue;
      seen.add(actor.id);
      const state: OutsideState = { agentId: actor.id, workspaceId: actor.workspaceId, moves, ideas, nextMoveTap: chipInfo.nextMoveTap };
      setOutsideState(actor.id, state);
      syncPill(ideaPills, "flowly-ideas", actor.id, actor.workspaceId, JSON.stringify(["outside", actor.workspaceId]),
        JSON.stringify(ideas.map((i) => [i.id, i.updatedAt])), ideas.length ? outsideIdeasButton(ideas.length) : null);
    }
    return seen;
  }
  function outsideIdeasButton(count: number) {
    return {
      title: t("Ideas for this session"),
      label: t("Ideas · {n}", { n: count }),
      icon: "Lightbulb",
      behavior: { kind: "popover" as const, Content: popovers!.outsideIdeas! },
    };
  }
  // The board screen re-reads and validates the link before showing anything
  // (fail-closed), so the chip only navigates. Keeping SDK/RPC calls out of
  // the press handler avoids host-specific failures in the action context.
  async function open(link: CardSessionLink) {
    if (disposed) return;
    await step(t("Couldn't open Flowly"), () =>
      client.openScreen({
        screenId: "board",
        params: { ...link, requestId: newRequestId() },
      }),
    );
  }
  // Built in its own call so the press handler keeps this chip's task and
  // session: Hermes gives loop-body `const`s one binding for the whole loop,
  // so a closure created in the loop would see the last iteration's values.
  function chipButton(task: LinkBoard["tasks"][number], sessionId: string) {
    const titleCharacters = Array.from(task.title);
    const link = { taskId: task.id, workspaceId: task.workspaceId, sessionId };
    return {
      title: t("Open Kanban task: {title}", { title: task.title }),
      label: t("Task · {title}", { title: titleCharacters.length > 28 ? titleCharacters.slice(0, 28).join("") + "…" : task.title }),
      icon: "PanelsTopLeft",
      behavior: {
        kind: "action" as const,
        onPress: () => open({ ...link, requestId: newRequestId() }),
      },
    };
  }
  // One round at a time: an extra request while a round runs queues exactly one more, right after it.
  let running = false,
    again = false;
  function refreshNow() {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    clearTimeout(timer);
    void refresh();
  }
  if (popovers) setChipRefresher(refreshNow);
  /** The Task chip: one per session in a card's workspace, live or archived. */
  function syncTaskChips(
    current: LinkBoard,
    agents: readonly { id: string; workspaceId?: string | null }[],
    tasks: Map<string, LinkBoard["tasks"][number]>,
  ) {
    const found = new Set<string>();
    for (const actor of agents) {
      const task = actor.workspaceId ? tasks.get(actor.workspaceId) : undefined;
      if (!task) continue;
      found.add(actor.id);
      const binding = JSON.stringify([task.id, task.workspaceId]);
      let existing = registrations.get(actor.id);
      if (existing && existing.binding !== binding) {
        existing.chip.remove();
        registrations.delete(actor.id);
        existing = undefined;
      }
      const button = chipButton(task, actor.id);
      // Updating a pill re-renders the host composer next to the user's input: only when its text changed.
      const label = `${button.label}\n${button.title}`;
      if (existing) {
        if (existing.label !== label) {
          existing.chip.update(button);
          existing.label = label;
        }
      } else
        registrations.set(actor.id, {
          binding,
          label,
          chip: client.addComposerPill({
            id: "kanban-task",
            workspaceId: task.workspaceId,
            agentId: actor.id,
            button,
          }),
        });
    }
    for (const [agentId, registration] of registrations) {
      if (!found.has(agentId)) {
        registration.chip.remove();
        registrations.delete(agentId);
      }
    }
  }
  const taskMap = (current: LinkBoard) =>
    new Map(
      current.tasks
        .filter((t) => current.projects.some((p) => p.id === t.projectId))
        .map((t) => [t.workspaceId, t] as const),
    );
  /** Every agent on the host, archived ones included: megabytes, so never inside a round (see above). */
  async function scanArchived() {
    const start = perfStart();
    try {
      // The daemon pages every agent locally and sends back bare ids (a phone took 7-13 s to decode the full list).
      const refs = await client.rpc(archivedSessionRefs, {});
      if (disposed) return;
      archived = refs;
      archivedAt = Date.now();
      perfEnd("chips.archived", start);
      // New archived sessions of a card get their chip now; the cards themselves were synced by the round.
      if (board) syncTaskChips(board, [...live.values(), ...archived.filter((a) => !live.has(a.id))], taskMap(board));
    } catch {
      // Try again soon, not every round.
      archivedAt = Date.now() - archivedEvery + 15_000;
    } finally {
      scanning = false;
    }
  }
  async function refresh() {
    running = true;
    const roundStart = perfStart();
    try {
      openStream();
      const needLive = !streamReady || relist || Date.now() - liveAt >= liveEvery;
      // Only a list that began after the stream was up counts as complete.
      if (needLive && streamReady) relist = false;
      const [boardResult, liveResult] = await Promise.allSettled([
        // This private projection excludes histories/workpads; never share its etag or value with the board screen.
        readBoardDelta((input) => client.rpc(readChipBoardChanged, input), board ?? undefined, etag && board ? etag : undefined, "chips-first-read"),
        needLive ? listAgents(client.paseo, undefined, false) : Promise.resolve(null),
      ]);
      if (disposed) return;
      if (boardResult.status !== "fulfilled" || liveResult.status !== "fulfilled" || (!boardResult.value.value && !board)) {
        board = null;
        etag = "";
        clear();
        return;
      }
      const changed = !!boardResult.value.value;
      if (boardResult.value.value) board = boardResult.value.value;
      etag = boardResult.value.etag;
      if (liveResult.value) reconcileLive(liveResult.value);
      const liveAgents = [...live.values()];
      // Managed sessions and the Ideas switch: when the board changed, else once a minute (a setting change alone).
      // A session in a card's workspace that is not known as managed yet may just have been prepared: check sooner.
      const unknown =
        !!chipInfo &&
        Date.now() - chipInfoAt >= 15_000 &&
        liveAgents.some((a) => !chipInfo!.managed.has(a.id) && !!a.workspaceId && board!.tasks.some((x) => x.workspaceId === a.workspaceId));
      if (popovers && (changed || unknown || !chipInfo || Date.now() - chipInfoAt >= archivedEvery)) {
        const info = await client.rpc(nativeChips, {}).catch(() => null);
        if (disposed) return;
        chipInfo = info
          ? { managed: new Set(info.managed.map((m) => m.agentId)), ideas: info.ideas, autoWrapup: info.autoWrapup, nextMoveTap: info.nextMoveTap, outside: info.outside ?? { enabled: false, progress: false, nextMoves: false, ideas: false } }
          : chipInfo;
        chipInfoAt = Date.now();
      }
      // Sessions Flowly does not manage (NATIVE-SESSION-SPEC §12.7): read only when switched on, by etag.
      if (popovers && chipInfo?.outside?.enabled) {
        const result = await client.rpc(sessionInsights, outsideEtag ? { etag: outsideEtag } : {}).catch(() => null);
        if (disposed) return;
        if (result) {
          if (result.value) outsideViews = new Map(result.value.map((v) => [v.agentId, v]));
          outsideEtag = result.etag;
        }
      } else if (outsideEtag) {
        outsideEtag = "";
        outsideViews = new Map();
      }
      const current = board!;
      const tasks = taskMap(current);
      // The cards and chips first (what a person is waiting for), the archived scan after.
      lastRound = { current, tasks };
      syncExtras(current, liveAgents, tasks);
      const liveIds = new Set(live.keys());
      const archivedIds = new Set(archived.map((a) => a.id));
      syncTaskChips(current, [...liveAgents, ...archived.filter((a) => !liveIds.has(a.id))], tasks);
      // A chipped session that left the live list was probably just archived.
      const vanished = [...registrations.keys()].some((id) => !liveIds.has(id) && !archivedIds.has(id));
      if (!scanning && (vanished || Date.now() - archivedAt >= archivedEvery)) {
        scanning = true;
        void scanArchived();
      }
    } catch {
      if (!disposed) clear();
    } finally {
      running = false;
      perfEnd("chips.round", roundStart);
      if (!disposed) {
        if (again) {
          again = false;
          void refresh();
        } else
          timer = setTimeout(() => {
            void refresh();
          }, interval);
      }
    }
  }
  if (startDelay > 0)
    timer = setTimeout(() => {
      void refresh();
    }, startDelay);
  else void refresh();
  return () => {
    disposed = true;
    latestClick++;
    clearTimeout(timer);
    stopHidden();
    stopStream?.();
    void releaseStream?.().catch(() => undefined);
    clear();
    lastRound = null;
    if (popovers) {
      setChipClient(null);
      setChipRefresher(null);
    }
  };
}
