import type { Idea, Status, Task, priorities } from "../shared/model";
import { continuesInCard } from "../shared/ideas";

type Priority = (typeof priorities)[number];

/** Current items, with leaving ones re-inserted at their last index so nothing jumps while they collapse. */
export function exitRows<T extends { id: string }>(
  items: readonly T[],
  leaving: readonly { item: T; index: number }[],
  initial: ReadonlySet<string>,
) {
  const rows = items.map((item) => ({ item, leaving: false, entering: !initial.has(item.id) }));
  for (const { item, index } of [...leaving].sort((a, b) => a.index - b.index))
    if (!items.some((i) => i.id === item.id)) rows.splice(Math.min(index, rows.length), 0, { item, leaving: true, entering: false });
  return rows;
}

/** Ideas page (IDEAS-INBOX-SPEC §4): segments, search, filters, sort and grouping. */
export type IdeaTab = Idea["status"];
export type IdeaSort = "newest" | "priority" | "card";
export interface IdeaQuery {
  tab: IdeaTab;
  /** Lowercased match on the idea's text and its source card title; blank matches all. */
  search: string;
  /** Agent suggestions to keep; empty keeps both. */
  scopes: ReadonlySet<"here" | "new">;
  /** Only ideas whose source card is Done/Cancelled or archived. */
  finishedOnly: boolean;
  /** Only this card's ideas ("All ideas" from a card). */
  taskId: string;
  sort: IdeaSort;
}
type Card = Pick<Task, "id" | "title" | "status" | "archivedAt" | "position">;

export const projectIdeas = (ideas: readonly Idea[], projectId: string) => ideas.filter((i) => i.projectId === projectId);

export function ideaTabCounts(ideas: readonly Idea[]): Record<IdeaTab, number> {
  const counts = { open: 0, accepted: 0, dismissed: 0 };
  for (const i of ideas) counts[i.status]++;
  return counts;
}

const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** The ideas to show, in order. `lanes` is the project's lane order, for sorting by card. */
export function visibleIdeas(ideas: readonly Idea[], tasks: readonly Card[], lanes: readonly Status[], q: IdeaQuery): Idea[] {
  const cards = new Map(tasks.map((t) => [t.id, t]));
  const needle = q.search.trim().toLowerCase();
  const rows = ideas.filter((i) => {
    if (i.status !== q.tab || (q.taskId && i.taskId !== q.taskId)) return false;
    const card = i.taskId ? cards.get(i.taskId) : undefined;
    if (q.scopes.size && !q.scopes.has(i.scope || "new")) return false;
    if (q.finishedOnly && (!card || continuesInCard(card))) return false;
    if (!needle) return true;
    return [i.title, i.detail, i.rationale, card?.title || ""].some((text) => text.toLowerCase().includes(needle));
  });
  const newest = (a: Idea, b: Idea) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  // Project ideas have no card and lead (PROJECT-IDEAS-SPEC §5).
  const cardRank = (id: string | undefined) => {
    if (!id) return [-1, 0] as const;
    const card = cards.get(id);
    if (!card) return [Infinity, 0] as const;
    const lane = lanes.indexOf(card.status);
    return [card.archivedAt ? lanes.length + 1 : lane < 0 ? lanes.length : lane, card.position] as const;
  };
  const by: Record<IdeaSort, (a: Idea, b: Idea) => number> = {
    newest,
    priority: (a, b) => priorityRank[a.priority || "normal"] - priorityRank[b.priority || "normal"] || newest(a, b),
    card: (a, b) => {
      const [la, pa] = cardRank(a.taskId), [lb, pb] = cardRank(b.taskId);
      return la - lb || pa - pb || (a.taskId ?? "").localeCompare(b.taskId ?? "") || newest(a, b);
    },
  };
  return rows.sort(by[q.sort]);
}

/** One group per card in list order; the project's own ideas (key null) form the first group (group by card). */
export function groupByCard<T extends Pick<Idea, "taskId">>(ideas: readonly T[]): { taskId: string | null; ideas: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const idea of ideas) {
    const key = idea.taskId ?? null;
    const group = groups.get(key);
    if (group) group.push(idea);
    else groups.set(key, [idea]);
  }
  const list = [...groups].map(([taskId, items]) => ({ taskId, ideas: items }));
  return [...list.filter((g) => g.taskId === null), ...list.filter((g) => g.taskId !== null)];
}
