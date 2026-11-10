import { stat } from "node:fs/promises";
import type { Artifact, Board, BoardEvent, Idea, Project, Task, Workpad } from "../shared/model";
import type { MemoryEntry } from "../shared/memory";
import type { SummaryEntry } from "../shared/summary";
import { parseTagSearch, tagMatches, tagValues } from "../shared/tags";
import { fold, matchRanges } from "../shared/search-text";
import {
  agentSearchSources,
  searchInputSchema,
  searchLimits,
  searchSources,
  type SearchCard,
  type SearchHit,
  type SearchInput,
  type SearchMemoryHit,
  type SearchProjectIdea,
  type SearchResult,
  type SearchSource,
} from "../shared/search";

/** Search (SEARCH-SPEC): a plain scan of the daemon's data, no index on disk. */

export { fold } from "../shared/search-text";

export type SearchQuery = { terms: string[]; tags: string[] };

/** `#tag` filters, `"quoted phrases"` and plain words; empty when nothing is left to look for (§3.1). */
export function parseSearchQuery(query: string): SearchQuery {
  const { text, tags } = parseTagSearch(query.trim());
  const terms: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = fold((m[1] ?? m[2] ?? "").trim());
    if (term && !terms.includes(term)) terms.push(term);
  }
  return { terms, tags };
}

type Doc = {
  source: SearchSource;
  field: string;
  text: string;
  folded: string;
  weight: number;
  refId?: string;
  at?: string;
  status?: Idea["status"];
};
type CardDocs = { task: Task; docs: Doc[] };
type MemoryDocs = { entry: MemoryEntry; docs: Doc[] };
type ProjectIdeaDocs = { idea: Idea; docs: Doc[] };
export type SearchIndex = {
  projects: Map<string, Project>;
  cards: CardDocs[];
  memory: MemoryDocs[];
  /** Ideas that belong to a project, not to a card (PROJECT-IDEAS-SPEC). */
  projectIdeas: ProjectIdeaDocs[];
};
export type SearchData = Pick<Board, "projects" | "tasks" | "events" | "ideas" | "artifacts" | "workpads"> & {
  summaries?: readonly SummaryEntry[];
  memory?: readonly MemoryEntry[];
};

const NOTE_ACTIONS = new Set(["status_changed", "progress_reported"]);

function doc(out: Doc[], source: SearchSource, field: string, text: string | undefined, weight: number, extra: Partial<Doc> = {}) {
  if (!text || !text.trim()) return;
  out.push({ source, field, text, folded: fold(text), weight, ...extra });
}

/** The searchable text of every card and memory entry (§2). Archived projects are left out. */
export function buildSearchIndex(data: SearchData): SearchIndex {
  const projects = new Map(data.projects.filter((p) => !p.archivedAt).map((p) => [p.id, p]));
  const cards = new Map<string, CardDocs>();
  for (const task of data.tasks) {
    if (!projects.has(task.projectId)) continue;
    const docs: Doc[] = [];
    doc(docs, "card", "title", task.title, 6, { at: task.updatedAt });
    doc(docs, "card", "tags", tagValues(task).join(" "), 5, { at: task.updatedAt });
    doc(docs, "card", "description", task.description, 3, { at: task.updatedAt });
    doc(docs, "card", "type", task.type, 1, { at: task.updatedAt });
    cards.set(task.id, { task, docs });
  }
  const latest = new Map<string, SummaryEntry>();
  for (const s of data.summaries || []) {
    const seen = latest.get(s.taskId);
    if (!seen || s.at >= seen.at) latest.set(s.taskId, s);
  }
  for (const s of latest.values()) {
    const card = cards.get(s.taskId);
    if (!card) continue;
    for (const field of ["state", "target", "recap", "next"] as const) doc(card.docs, "summary", field, s[field], 4, { refId: s.id, at: s.at });
  }
  for (const e of data.events as readonly BoardEvent[]) {
    if (e.actor === "system" || !NOTE_ACTIONS.has(e.action)) continue;
    const card = cards.get(e.taskId);
    if (card) doc(card.docs, "note", "note", e.note, 2, { refId: e.id, at: e.at });
  }
  for (const w of data.workpads as readonly Workpad[]) {
    const card = cards.get(w.taskId);
    if (!card) continue;
    for (const a of w.acceptance) doc(card.docs, "workpad", "acceptance", a.text, 2, { refId: a.id, at: w.updatedAt });
  }
  const projectIdeas: ProjectIdeaDocs[] = [];
  for (const i of data.ideas as readonly Idea[]) {
    const own: Doc[] = [];
    const card = i.taskId ? cards.get(i.taskId) : undefined;
    if (i.taskId ? !card : !projects.has(i.projectId)) continue;
    const docs = card ? card.docs : own;
    const extra = { refId: i.id, at: i.updatedAt, status: i.status };
    doc(docs, "idea", "title", i.title, 4, extra);
    doc(docs, "idea", "detail", i.detail, 2, extra);
    doc(docs, "idea", "rationale", i.rationale, 2, extra);
    doc(docs, "idea", "context", i.context, 2, extra);
    if (!card) projectIdeas.push({ idea: i, docs: own });
  }
  for (const a of data.artifacts as readonly Artifact[]) {
    const card = cards.get(a.taskId);
    if (!card) continue;
    const extra = { refId: a.id, at: a.updatedAt };
    doc(card.docs, "artifact", "title", a.title, 3, extra);
    doc(card.docs, "artifact", "note", a.note, 3, extra);
    doc(card.docs, "artifact", "target", a.target, 3, extra);
    doc(card.docs, "artifact", "key", a.external?.key, 3, extra);
  }
  const memory: MemoryDocs[] = [];
  for (const entry of data.memory || []) {
    if (entry.status !== "active" || !projects.has(entry.projectId)) continue;
    const docs: Doc[] = [];
    doc(docs, "memory", "title", entry.title, 4);
    doc(docs, "memory", "body", entry.body, 4);
    doc(docs, "memory", "keywords", entry.keywords.join(", "), 4);
    doc(docs, "memory", "tags", entry.tags.join(" "), 4);
    memory.push({ entry, docs });
  }
  return { projects, cards: [...cards.values()], memory, projectIdeas };
}

/** A window around the first match: ±context characters, at most snippet long, whitespace collapsed (§3.2). */
export function snippetOf(text: string, folded: string, terms: readonly string[]): { snippet: string; ranges: [number, number][] } {
  let first = -1,
    length = 0;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
      length = term.length;
    }
  }
  if (first < 0) first = 0;
  const room = searchLimits.snippet - 2;
  let start = Math.max(0, first - searchLimits.context);
  let end = Math.min(text.length, first + length + searchLimits.context, start + room);
  if (start > 0 && /[\udc00-\udfff]/.test(text[start])) start--;
  if (end < text.length && /[\udc00-\udfff]/.test(text[end])) end++;
  const body = text.slice(start, end).replace(/\s+/g, " ");
  const snippet = `${start > 0 ? "…" : ""}${start > 0 ? body.trimStart() : body}`.trimEnd() + (end < text.length ? "…" : "");
  return { snippet, ranges: matchRanges(snippet, terms) };
}

const tier = (task: Task) => (task.archivedAt ? 2 : task.status === "done" || task.status === "cancelled" ? 1 : 0);
const newest = (a: string | undefined, b: string | undefined) => ((a || "") > (b || "") ? a || "" : b || "");

export type SearchOptions = {
  query: string;
  /** null: every project in the index. */
  projectIds: ReadonlySet<string> | null;
  sources?: readonly SearchSource[];
  limit: number;
  excludeTaskId?: string;
  memoryLimit?: number;
};
export type SearchMatches = { cards: SearchCard[]; memory: SearchMemoryHit[]; truncated: boolean; projectIdeas?: SearchProjectIdea[] };

/** Cards whose documents hold every term, ranked by best field, then open before closed, then recency (§3.3). */
export function runSearch(index: SearchIndex, options: SearchOptions): SearchMatches {
  const { terms, tags } = parseSearchQuery(options.query);
  if (!terms.length && !tags.length) return { cards: [], memory: [], truncated: false };
  const sources = new Set<SearchSource>(options.sources?.length ? options.sources : searchSources);
  const inScope = (projectId: string) => !options.projectIds || options.projectIds.has(projectId);
  const ranked: { card: SearchCard; weight: number; tier: number; at: string }[] = [];
  for (const { task, docs } of index.cards) {
    if (task.id === options.excludeTaskId || !inScope(task.projectId)) continue;
    if (tags.length && !tags.every((f) => tagValues(task).some((t) => tagMatches(t, f)))) continue;
    const pool = docs.filter((d) => sources.has(d.source));
    if (!terms.every((term) => pool.some((d) => d.folded.includes(term)))) continue;
    const hitDocs = terms.length ? pool.filter((d) => terms.some((term) => d.folded.includes(term))) : [];
    if (terms.length && !hitDocs.length) continue;
    hitDocs.sort((a, b) => b.weight - a.weight || (b.at || "").localeCompare(a.at || ""));
    const hits: SearchHit[] = hitDocs.slice(0, searchLimits.hitsPerCard).map((d) => ({
      source: d.source,
      ...(d.refId ? { refId: d.refId } : {}),
      field: d.field,
      ...snippetOf(d.text, d.folded, terms),
      ...(d.at ? { at: d.at } : {}),
      ...(d.status ? { status: d.status } : {}),
    }));
    const project = index.projects.get(task.projectId)!;
    ranked.push({
      card: {
        taskId: task.id,
        projectId: task.projectId,
        projectTitle: project.title,
        workspaceId: task.workspaceId,
        title: task.title,
        status: task.status,
        ...(task.type ? { type: task.type } : {}),
        archived: !!task.archivedAt,
        updatedAt: task.updatedAt,
        hits,
      },
      weight: hitDocs[0]?.weight || 0,
      tier: tier(task),
      at: hitDocs.reduce<string>((max, d) => newest(max, d.at), task.updatedAt),
    });
  }
  ranked.sort((a, b) => b.weight - a.weight || a.tier - b.tier || b.at.localeCompare(a.at) || a.card.taskId.localeCompare(b.card.taskId));
  // Project-level ideas have no card; they are listed apart, labelled with their project (PROJECT-IDEAS-SPEC §4).
  const ideas: { hit: SearchProjectIdea; weight: number; at: string }[] = [];
  if (sources.has("idea") && !tags.length) {
    for (const { idea, docs } of index.projectIdeas) {
      if (!inScope(idea.projectId) || !terms.every((term) => docs.some((d) => d.folded.includes(term)))) continue;
      const hitDocs = docs.filter((d) => terms.some((term) => d.folded.includes(term))).sort((a, b) => b.weight - a.weight);
      ideas.push({
        hit: {
          ideaId: idea.id,
          projectId: idea.projectId,
          projectTitle: index.projects.get(idea.projectId)!.title,
          title: idea.title,
          status: idea.status,
          updatedAt: idea.updatedAt,
          hits: hitDocs.slice(0, searchLimits.hitsPerCard).map((d) => ({
            source: d.source,
            ...(d.refId ? { refId: d.refId } : {}),
            field: d.field,
            ...snippetOf(d.text, d.folded, terms),
            ...(d.at ? { at: d.at } : {}),
            ...(d.status ? { status: d.status } : {}),
          })),
        },
        weight: hitDocs[0]?.weight || 0,
        at: idea.updatedAt,
      });
    }
    ideas.sort((a, b) => b.weight - a.weight || b.at.localeCompare(a.at) || a.hit.ideaId.localeCompare(b.hit.ideaId));
  }
  const memoryLimit = options.memoryLimit ?? searchLimits.memory;
  const memory: { hit: SearchMemoryHit; weight: number; at: string }[] = [];
  if (sources.has("memory") && memoryLimit > 0) {
    for (const { entry, docs } of index.memory) {
      if (!inScope(entry.projectId)) continue;
      if (tags.length && !tags.every((f) => entry.tags.some((t) => tagMatches(t, f)))) continue;
      if (!terms.every((term) => docs.some((d) => d.folded.includes(term)))) continue;
      const best = docs.find((d) => terms.some((term) => d.folded.includes(term))) || docs[0];
      memory.push({
        hit: { id: entry.id, projectId: entry.projectId, kind: entry.kind, title: entry.title, ...snippetOf(best.text, best.folded, terms) },
        weight: best.weight,
        at: entry.confirmedAt || entry.updatedAt,
      });
    }
    memory.sort((a, b) => b.weight - a.weight || b.at.localeCompare(a.at));
  }
  return {
    cards: ranked.slice(0, options.limit).map((r) => r.card),
    memory: memory.slice(0, memoryLimit).map((m) => m.hit),
    truncated: ranked.length > options.limit || memory.length > memoryLimit || ideas.length > options.limit,
    ...(ideas.length ? { projectIdeas: ideas.slice(0, options.limit).map((i) => i.hit) } : {}),
  };
}

type Stamped<T> = { stamp: string; value: T };
export type SearchSourcesIO = {
  board: () => Promise<Board>;
  summaries: { path: string; read: () => Promise<readonly SummaryEntry[]> };
  memory: { path: string; read: () => Promise<readonly MemoryEntry[]> };
  /** Memory is left out of a project with memory turned off. */
  memoryOn: (project: Project) => boolean;
  /** Ideas and artifacts follow their Settings switches. */
  ideasOn: () => Promise<boolean>;
  artifactsOn: () => Promise<boolean>;
};

const fileStamp = (path: string) =>
  stat(path).then(
    (s) => `${s.mtimeMs}:${s.size}`,
    () => "missing",
  );

/** search.query and flowly_search over the board, the summaries and project memory (§4, §6). */
export class SearchService {
  private summaries?: Stamped<readonly SummaryEntry[]>;
  private memory?: Stamped<readonly MemoryEntry[]>;
  private index?: { key: string; value: SearchIndex };
  constructor(private readonly io: SearchSourcesIO) {}

  /** Re-parses a JSON file only when its modification time or size changed. */
  private async cached<T>(slot: "summaries" | "memory", source: { path: string; read: () => Promise<readonly T[]> }) {
    const stamp = await fileStamp(source.path);
    const held = this[slot] as Stamped<readonly T[]> | undefined;
    if (held && held.stamp === stamp) return held;
    const value = await source.read();
    const next = { stamp, value } as Stamped<readonly T[]>;
    if (slot === "summaries") this.summaries = next as unknown as Stamped<readonly SummaryEntry[]>;
    else this.memory = next as unknown as Stamped<readonly MemoryEntry[]>;
    return next;
  }
  private async load() {
    const partial: SearchResult["partial"] = [];
    const [board, summaries, memory] = await Promise.all([
      this.io.board(),
      this.cached("summaries", this.io.summaries).catch(() => (partial.push("summaries"), undefined)),
      this.cached("memory", this.io.memory).catch(() => (partial.push("memory"), undefined)),
    ]);
    // The memory switches (global and per project) are part of the key: turning memory off applies at once.
    const enabled = new Set(board.projects.filter((p) => this.io.memoryOn(p)).map((p) => p.id));
    const key = `${board.revision}|${summaries?.stamp ?? "-"}|${memory?.stamp ?? "-"}|${[...enabled].sort().join(",")}`;
    if (this.index?.key !== key) {
      this.index = {
        key,
        value: buildSearchIndex({
          ...board,
          summaries: summaries?.value,
          memory: (memory?.value || []).filter((m) => enabled.has(m.projectId)),
        }),
      };
    }
    partial.sort();
    return { index: this.index.value, partial, summaries: summaries?.value || [] };
  }
  private async allowed(sources: readonly SearchSource[] | undefined, base: readonly SearchSource[]) {
    const [ideas, artifacts] = await Promise.all([this.io.ideasOn().catch(() => true), this.io.artifactsOn().catch(() => true)]);
    return (sources?.length ? sources : base).filter((s) => (s !== "idea" || ideas) && (s !== "artifact" || artifacts));
  }

  /** search.query (§4). */
  async query(raw: SearchInput): Promise<SearchResult> {
    const input = searchInputSchema.parse(raw);
    const { index, partial } = await this.load();
    if (input.projectId !== null && !index.projects.has(input.projectId)) throw new Error("Project not found.");
    const sources = await this.allowed(input.sources, searchSources);
    if (!sources.length) return { cards: [], memory: [], truncated: false, partial };
    const found = runSearch(index, {
      query: input.query,
      projectIds: input.projectId === null ? null : new Set([input.projectId]),
      sources,
      limit: input.limit,
    });
    return { ...found, partial };
  }

  /** flowly_search (§6): the caller's project, without its own card or project memory. */
  async forAgent(project: Project, taskId: string, input: { query: string; sources?: readonly SearchSource[]; limit: number }) {
    const { index, summaries } = await this.load();
    const base = (input.sources?.length ? input.sources : agentSearchSources).filter((s) => s !== "memory");
    const sources = await this.allowed(base, agentSearchSources);
    const found = sources.length
      ? runSearch(index, { query: input.query, projectIds: new Set([project.id]), sources, limit: input.limit, excludeTaskId: taskId, memoryLimit: 0 })
      : { cards: [], memory: [], truncated: false };
    const latest = new Map<string, SummaryEntry>();
    for (const s of summaries) {
      const seen = latest.get(s.taskId);
      if (!seen || s.at >= seen.at) latest.set(s.taskId, s);
    }
    const tasks = new Map(index.cards.map((c) => [c.task.id, c.task]));
    return {
      cards: found.cards.map((c) => {
        const task = tasks.get(c.taskId)!;
        const s = latest.get(c.taskId);
        const summary = s ? clip([s.state, s.recap].filter((v) => v.trim()).join("\n"), searchLimits.agentSummary) : "";
        return {
          taskId: c.taskId,
          title: c.title,
          status: c.status,
          ...(c.type ? { type: c.type } : {}),
          tags: tagValues(task),
          archived: c.archived,
          updatedAt: c.updatedAt,
          ...(summary ? { summary } : {}),
          hits: c.hits.map((h) => ({ source: h.source, snippet: h.snippet })),
        };
      }),
      truncated: found.truncated,
    };
  }
}

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
