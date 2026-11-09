import { localizedLabels, msg } from "./i18n";
import type { Link, LinkKind, Task } from "./model";

/** How a link reads from one of its cards (CARD-LINKS-SPEC §2.5). */
export const relations = ["blocked_by", "blocks", "follow_up_of", "follow_up", "related"] as const;
export type Relation = (typeof relations)[number];

export const relationLabels: Record<Relation, string> = localizedLabels({
  blocked_by: msg("Blocked by"),
  blocks: msg("Blocks"),
  follow_up_of: msg("Follow-up of"),
  follow_up: msg("Follow-up"),
  related: msg("Related"),
});

export function relationOf(link: Pick<Link, "kind" | "from">, taskId: string): Relation {
  if (link.kind === "related") return "related";
  const outgoing = link.from === taskId;
  if (link.kind === "derived") return outgoing ? "follow_up_of" : "follow_up";
  return outgoing ? "blocks" : "blocked_by";
}

/** The link that, seen from `taskId`, has `relation` toward `otherId`. */
export function linkFor(relation: Relation, taskId: string, otherId: string): { kind: LinkKind; from: string; to: string } {
  switch (relation) {
    case "blocked_by":
      return { kind: "blocks", from: otherId, to: taskId };
    case "blocks":
      return { kind: "blocks", from: taskId, to: otherId };
    case "follow_up_of":
      return { kind: "derived", from: taskId, to: otherId };
    case "follow_up":
      return { kind: "derived", from: otherId, to: taskId };
    case "related":
      return { kind: "related", from: taskId, to: otherId };
  }
}

export const otherEnd = (link: Pick<Link, "from" | "to">, taskId: string) => (link.from === taskId ? link.to : link.from);

export const touches = (link: Pick<Link, "from" | "to">, taskId: string) => link.from === taskId || link.to === taskId;

/** Same pair of cards, either direction. */
export const samePair = (link: Pick<Link, "from" | "to">, a: string, b: string) =>
  (link.from === a && link.to === b) || (link.from === b && link.to === a);

export interface LinkView<T = Task> {
  link: Link;
  relation: Relation;
  other: T | undefined;
}

export function linksOf<T extends Pick<Task, "id">>(board: { links: readonly Link[]; tasks: readonly T[] }, taskId: string): LinkView<T>[] {
  return board.links
    .filter((l) => touches(l, taskId))
    .map((link) => ({
      link,
      relation: relationOf(link, taskId),
      other: board.tasks.find((t) => t.id === otherEnd(link, taskId)),
    }));
}

/** A blocker no longer holds up its card once Done, Cancelled, archived or gone. */
export const isResolved = (blocker: Pick<Task, "status" | "archivedAt"> | undefined) =>
  !blocker || !!blocker.archivedAt || blocker.status === "done" || blocker.status === "cancelled";

/** The unresolved blockers of `taskId`. */
export function waitingOn(board: { links: readonly Link[]; tasks: readonly Task[] }, taskId: string): Task[] {
  return linksOf(board, taskId)
    .filter((v) => v.relation === "blocked_by" && !isResolved(v.other))
    .map((v) => v.other!);
}

/**
 * The card IDs of the cycle that a new directed `kind` link from → to would
 * close (starting and ending at `from`), or undefined. Related links have no
 * direction and never form cycles.
 */
export function wouldCycle(links: readonly Link[], kind: LinkKind, from: string, to: string): string[] | undefined {
  if (kind === "related") return undefined;
  if (from === to) return [from, from];
  const edges = links.filter((l) => l.kind === kind);
  const previous = new Map<string, string>([[to, from]]);
  const queue = [to];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== node || previous.has(edge.to)) continue;
      previous.set(edge.to, node);
      if (edge.to === from) {
        const path = [from];
        for (let at = node; at !== from; at = previous.get(at)!) path.unshift(at);
        return [from, ...path];
      }
      queue.push(edge.to);
    }
  }
  return undefined;
}

/** Derived links for cards created from an idea, for files written before links existed (CARD-LINKS-SPEC §2.2). */
export function originLinks(tasks: readonly Task[]): Link[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks
    .filter((t) => t.origin?.taskId && ids.has(t.origin.taskId) && t.origin.taskId !== t.id)
    .map((t) => ({
      id: `origin-${t.id}`,
      projectId: t.projectId,
      kind: "derived" as const,
      from: t.id,
      to: t.origin!.taskId!,
      ideaId: t.origin!.ideaId,
      createdBy: "system" as const,
      createdAt: t.createdAt,
    }));
}

/** Context lines listing a card's links for a new session (CARD-LINKS-SPEC §4); at most `limit` per relation. */
export function linkContextLines(
  views: readonly LinkView[],
  laneOf: (task: Task) => string,
  limit = 10,
): string[] {
  const order: Relation[] = ["follow_up_of", "blocked_by", "blocks", "follow_up", "related"];
  return order.flatMap((relation) => {
    const list = views.filter(
      (v) => v.relation === relation && v.other && (relation !== "blocked_by" || !isResolved(v.other)),
    );
    return [
      ...list.slice(0, limit).map((v) => `${relationLabels[relation]}: ${v.other!.title} (${v.other!.id}) [${laneOf(v.other!)}]`),
      ...(list.length > limit ? [`${relationLabels[relation]}: …and ${list.length - limit} more`] : []),
    ];
  });
}
