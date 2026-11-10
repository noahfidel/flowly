import type { z } from "zod";
import type { boardSchema, BoardEvent } from "../shared/model";
import type { BoardOverview, SessionFacts } from "../shared/overview";
import { currentWrapup } from "../shared/wrapup-state";
import { cardQuestions, openQuestion, openReport, silentTurn } from "../shared/progress";
import { workpadSignal } from "../shared/workpad";
import { hasOpenNextMoves } from "../shared/next-moves";
import { faceKey, familyOf } from "../shared/connectors";
import { overviewCollections, overviewKeys, type OverviewCollection, type OverviewPatch } from "../shared/overview";
import { etagOf } from "./etag";

type Board = z.infer<typeof boardSchema>;

/** Preserve rule results; no history/body is removed from storage. */
export function boardOverview(board: Board): BoardOverview {
  const events = new Map<string, BoardEvent[]>();
  for (const e of board.events) {
    const list = events.get(e.taskId);
    if (list) list.push(e); else events.set(e.taskId, [e]);
  }
  const workpads = new Map(board.workpads.map(w => [w.taskId, w]));
  const cards = board.tasks.map(task => {
    const own = events.get(task.id) || [];
    const actors = [...new Set(own.flatMap(e => e.agentId ? [e.agentId] : []))];
    const sessions: SessionFacts[] = actors.map(agentId => {
      const mine = own.filter(e => e.agentId === agentId);
      const turn = mine.filter(e => e.action === "agent.turn_started" || e.action === "agent.turn_ended").at(-1);
      return {
        agentId,
        ...(turn ? { latestTurn: { action: turn.action as "agent.turn_started" | "agent.turn_ended", at: turn.at } } : {}),
        questionEventId: openQuestion(own, agentId)?.id ?? null,
        blockerEventId: openReport(own, agentId, "blocker")?.id ?? null,
        silent: silentTurn(task, own, agentId),
        hadTurnEnd: mine.some(e => e.action === "agent.turn_ended"),
      };
    });
    const artifacts = board.artifacts.filter(a => a.taskId === task.id);
    const external = artifacts.flatMap(a => {
      const text = a.external ? faceKey(a.external) : null;
      return text ? [{ text, family: familyOf(a.external!.provider) }] : [];
    });
    const finishedAt = (task.status === "done" || task.status === "cancelled"
      ? own.filter(e => e.action === "status_changed" && e.to === task.status).map(e => e.at).sort().at(-1)
      : undefined) || task.updatedAt;
    const turnEndedAt = own.filter(e => e.action === "agent.turn_ended").map(e => e.at).sort().at(-1);
    const workpad = workpads.get(task.id);
    return {
      taskId: task.id,
      wrapped: !!currentWrapup(own, task.id),
      questions: cardQuestions(task, own).length,
      openIdeas: board.ideas.filter(i => i.taskId === task.id && i.status === "open").length,
      ...(external.length ? { external: { ...external[0], text: external.length > 1 ? `${external[0].text} +${external.length - 1}` : external[0].text } } : {}),
      workpad: workpadSignal(workpad),
      finishedAt,
      ...(turnEndedAt ? { turnEndedAt } : {}),
      hasArtifacts: artifacts.length > 0,
      hasExternal: artifacts.some(a => !!a.external),
      hasWorkpad: !!workpad,
      hasNextMoves: hasOpenNextMoves(own),
      sessions,
    };
  });
  return { version: 1, revision: board.revision, groups: [...board.groups].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)), projects: board.projects, tasks: board.tasks, links: board.links, attentionDismissals: board.attentionDismissals, cards, projectIdeas: projectIdeaFacts(board) };
}

/** Open project-level ideas per project (PROJECT-IDEAS-SPEC §5); a project with none still has an entry. */
function projectIdeaFacts(board: Board) {
  const open = new Map<string, number>();
  for (const i of board.ideas) if (!i.taskId && i.status === "open") open.set(i.projectId, (open.get(i.projectId) ?? 0) + 1);
  return board.projects.map(p => ({ projectId: p.id, open: open.get(p.id) ?? 0 }));
}

type Fingerprint = Record<OverviewCollection, { ids: string[]; hashes: Map<string, string> }>;
function fingerprint(view: BoardOverview): Fingerprint {
  const result = {} as Fingerprint;
  for (const name of overviewCollections) {
    const key = overviewKeys[name] as (item: never) => string;
    const items = view[name] as never[];
    result[name] = { ids: items.map(key), hashes: new Map(items.map(item => [key(item), etagOf(item)])) };
  }
  return result;
}

/** A separate namespace/cache: never adapt the overview to BoardDeltas' Board shape. */
export class OverviewDeltas {
  private readonly seen = new Map<string, Fingerprint>();
  constructor(private readonly capacity = 32) {}
  read(view: BoardOverview, input: { etag?: string }) {
    const etag = `overview-v1:${etagOf(view)}`;
    if (etag === input.etag) return { etag };
    const base = input.etag ? this.seen.get(input.etag) : undefined;
    const now = fingerprint(view);
    this.seen.delete(etag);
    this.seen.set(etag, now);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value!);
    if (!base) return { etag, value: view };
    const patch: OverviewPatch = { baseEtag: input.etag!, revision: view.revision };
    for (const name of overviewCollections) {
      const before = base[name], after = now[name];
      const key = overviewKeys[name] as (item: never) => string;
      const set = (view[name] as never[]).filter(item => before.hashes.get(key(item)) !== after.hashes.get(key(item)));
      const remove = before.ids.filter(id => !after.hashes.has(id));
      const added = after.ids.filter(id => !before.hashes.has(id));
      const applied = before.ids.filter(id => after.hashes.has(id)).concat(added);
      const order = applied.join("\0") === after.ids.join("\0") ? undefined : after.ids;
      if (set.length || remove.length || order) patch[name] = { set, remove, ...(order ? { order } : {}) } as never;
    }
    return { etag, patch };
  }
}
