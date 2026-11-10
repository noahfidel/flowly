import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { emptyBoard, type Board, type Project, type Task } from "../shared/model";
import type { MemoryEntry } from "../shared/memory";
import type { SummaryEntry } from "../shared/summary";
import { searchResultSchema } from "../shared/search";
import { agentSearchInputSchema, agentSearchResultSchema } from "../shared/tools";
import { buildSearchIndex, fold, parseSearchQuery, runSearch, SearchService, snippetOf, type SearchData } from "./search";

const at = "2026-10-20T00:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  title: `Project ${id}`,
  description: "",
  paseoProjectId: `n-${id}`,
  primaryPath: "/fixture",
  repos: ["/fixture"],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...over,
});
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: "p",
  workspaceId: `w-${id}`,
  sourcePath: "/fixture",
  repoPaths: ["/fixture"],
  title: `Card ${id}`,
  description: "",
  status: "todo",
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: id,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...over,
});
const tags = (...names: string[]) => names.map((tag) => ({ tag, by: "agent" as const, at }));
const summary = (taskId: string, over: Partial<SummaryEntry> = {}): SummaryEntry => ({
  id: `s-${taskId}-${over.at || at}`,
  taskId,
  at,
  model: "m",
  agentIds: [],
  state: "",
  target: "",
  recap: "",
  next: "",
  ...over,
});
const memoryEntry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({
    id,
    projectId: "p",
    kind: "pitfall",
    title: `Memory ${id}`,
    body: "",
    tags: [],
    keywords: [],
    pinned: false,
    status: "active",
    source: { by: "human" },
    revision: 1,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
    ...over,
  }) as MemoryEntry;

function data(over: Partial<SearchData> = {}): SearchData {
  return { ...emptyBoard(), projects: [project("p")], ...over };
}
const search = (d: SearchData, query: string, extra: Partial<Parameters<typeof runSearch>[1]> = {}) =>
  runSearch(buildSearchIndex(d), { query, projectIds: null, limit: 30, ...extra });

describe("query parsing and folding", () => {
  test("case and full-width ASCII fold without changing length", () => {
    expect(fold("ＳＱＬite　Ａ")).toBe("sqlite a");
    expect(fold("İstanbul").length).toBe("İstanbul".length);
  });
  test("quoted phrases stay whole, #tags filter, empty queries look for nothing", () => {
    expect(parseSearchQuery('Hermes "loop closure" #drawer')).toEqual({ terms: ["hermes", "loop closure"], tags: ["drawer"] });
    expect(parseSearchQuery("   ")).toEqual({ terms: [], tags: [] });
    expect(search(data({ tasks: [task("a")] }), "   ")).toEqual({ cards: [], memory: [], truncated: false });
  });
});

describe("project ideas", () => {
  const projectIdea = { id: "pi1", projectId: "p", agentId: "s", title: "Backlogword", detail: "detailtext", rationale: "", context: "", status: "open" as const, createdAt: at, updatedAt: at };
  test("project ideas are found and labelled with the project", () => {
    const d = data({ projects: [project("p"), project("q")], tasks: [task("a")], ideas: [projectIdea, { ...projectIdea, id: "pi2", projectId: "q", title: "Backlogword elsewhere" }] });
    expect(search(d, "backlogword", { projectIds: new Set(["p"]) })).toMatchObject({
      cards: [],
      projectIdeas: [{ ideaId: "pi1", projectId: "p", projectTitle: "Project p", title: "Backlogword", status: "open", hits: [{ source: "idea", field: "title", refId: "pi1" }] }],
    });
    expect(search(d, "backlogword").projectIdeas!.map((i) => i.ideaId)).toEqual(["pi1", "pi2"]);
    // Leaving out the idea source, an archived project and a missing match leave them out.
    expect(search(d, "backlogword", { sources: ["card"] }).projectIdeas).toBeUndefined();
    expect(search(d, "nomatchword").projectIdeas).toBeUndefined();
    expect(search(data({ projects: [project("p", { archivedAt: at })], ideas: [projectIdea] }), "backlogword").projectIdeas).toBeUndefined();
  });
});

describe("sources (§2)", () => {
  const board: SearchData = { agentReceipts: [{ receiptword: true }] } as never;
  Object.assign(board, data({
    tasks: [task("a", { title: "Storage busy", description: "desc words", tags: tags("drawer"), type: "bugfix" })],
    events: [
      { id: "e1", taskId: "a", actor: "agent", action: "status_changed", note: "delivered with noteword", at },
      { id: "e2", taskId: "a", actor: "human", action: "progress_reported", note: "human humanword", at },
      { id: "e3", taskId: "a", actor: "system", action: "status_changed", note: "systemword resumed", at },
      { id: "e4", taskId: "a", actor: "agent", action: "workspace_auto_archived", note: "archivedword", at },
    ],
    workpads: [
      {
        taskId: "a",
        projectId: "p",
        revision: 1,
        acceptance: [{ id: "x", text: "acceptword", done: false, by: "agent", at }],
        updatedAt: at,
        updatedBy: "agent",
      },
    ],
    ideas: [
      { id: "i1", taskId: "a", projectId: "p", agentId: "s", eventId: "e1", title: "ideaword", detail: "detailword", rationale: "rationaleword", context: "contextword", status: "dismissed", createdAt: at, updatedAt: at },
    ],
    artifacts: [
      { id: "r1", taskId: "a", projectId: "p", role: "output", kind: "url", target: "https://github.com/x/pull/64", title: "PR title", note: "artifactnote", createdBy: "agent", createdAt: at, updatedAt: at, external: { connectionId: "c", provider: "jira", key: "SHOPSR-123", remoteId: "1" } as never },
    ],
    summaries: [
      summary("a", { at, recap: "oldsummaryword" }),
      summary("a", { at: later(5), recap: "newsummaryword", target: "targetword" }),
    ],
    memory: [memoryEntry("m1", { title: "memoryword" }), memoryEntry("m2", { title: "candidateword", status: "candidate" })],
  }));
  test.each([
    ["storage", "card", "title"],
    ["#drawer", null, null],
    ["desc", "card", "description"],
    ["bugfix", "card", "type"],
    ["noteword", "note", "note"],
    ["humanword", "note", "note"],
    ["acceptword", "workpad", "acceptance"],
    ["ideaword", "idea", "title"],
    ["rationaleword", "idea", "rationale"],
    ["contextword", "idea", "context"],
    ["pull/64", "artifact", "target"],
    ["shopsr-123", "artifact", "key"],
    ["artifactnote", "artifact", "note"],
    ["newsummaryword", "summary", "recap"],
    ["targetword", "summary", "target"],
  ])("%s matches %s %s", (query, source, field) => {
    const found = search(board, query);
    expect(found.cards.map((c) => c.taskId)).toEqual(["a"]);
    if (source) expect(found.cards[0].hits[0]).toMatchObject({ source, field });
  });
  test("workpad hits name their item, so the drawer can land on it", () => {
    expect(search(board, "acceptword").cards[0].hits[0].refId).toBe("x");
  });
  test("ideas carry their status", () => {
    expect(search(board, "ideaword").cards[0].hits[0].status).toBe("dismissed");
  });
  test.each(["systemword", "archivedword", "receiptword", "oldsummaryword", "candidateword"])("%s is not searched", (query) => {
    const found = search(board, query);
    expect(found.cards).toEqual([]);
    expect(found.memory).toEqual([]);
  });
  test("active memory is its own group; the memory source can be left out", () => {
    expect(search(board, "memoryword").memory).toMatchObject([{ id: "m1", kind: "pitfall", title: "memoryword" }]);
    expect(search(board, "memoryword", { sources: ["card"] }).memory).toEqual([]);
  });
  test("archived projects are left out", () => {
    const d = data({ projects: [project("p", { archivedAt: at })], tasks: [task("a", { title: "hidden" })], memory: [memoryEntry("m", { title: "hidden" })] });
    expect(search(d, "hidden")).toEqual({ cards: [], memory: [], truncated: false });
  });
});

describe("matching (§3.1)", () => {
  const board = data({
    tasks: [task("a", { title: "Hermes loop", tags: tags("drawer", "module/composer") }), task("b", { title: "Hermes only" }), task("c", { title: "搜索功能设计" })],
    summaries: [summary("a", { recap: "the closure bug" })],
  });
  test("every word must appear somewhere in the card, across sources", () => {
    expect(search(board, "hermes closure").cards.map((c) => c.taskId)).toEqual(["a"]);
    expect(search(board, "hermes missing").cards).toEqual([]);
  });
  test("quoted phrases match as a whole", () => {
    expect(search(board, '"hermes loop"').cards.map((c) => c.taskId)).toEqual(["a"]);
    expect(search(board, '"loop hermes"').cards).toEqual([]);
  });
  test("#tag and #prefix/ filter like the board", () => {
    expect(search(board, "hermes #drawer").cards.map((c) => c.taskId)).toEqual(["a"]);
    expect(search(board, "#module/").cards.map((c) => c.taskId)).toEqual(["a"]);
    expect(search(board, "hermes #nothing").cards).toEqual([]);
  });
  test("case and full-width letters match; one or two Chinese characters match", () => {
    expect(search(board, "ＨＥＲＭＥＳ").cards).toHaveLength(2);
    expect(search(board, "搜").cards.map((c) => c.taskId)).toEqual(["c"]);
    expect(search(board, "搜索").cards.map((c) => c.taskId)).toEqual(["c"]);
  });
});

describe("snippets (§3.2)", () => {
  test("a window around the first match, at most 160 characters, ranges on the snippet", () => {
    const text = `${"a".repeat(300)}\n\nNeedle here ${"b".repeat(300)} needle`;
    const { snippet, ranges } = snippetOf(text, fold(text), ["needle"]);
    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet.startsWith("…") && snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("\n");
    expect(ranges).toHaveLength(1);
    expect(snippet.slice(ranges[0][0], ranges[0][1])).toBe("Needle");
  });
  test("at most three hits per card, best weight first", () => {
    const d = data({
      tasks: [task("a", { title: "word", description: "word" })],
      events: [1, 2, 3].map((n) => ({ id: `e${n}`, taskId: "a", actor: "agent" as const, action: "progress_reported", note: `word ${n}`, at: later(n) })),
    });
    const hits = search(d, "word").cards[0].hits;
    expect(hits.map((h) => `${h.source}:${h.field}`)).toEqual(["card:title", "card:description", "note:note"]);
    expect(hits[2].refId).toBe("e3");
  });
});

describe("ranking and limits (§3.3, §3.4)", () => {
  test("best field, then open before closed before archived, then recency", () => {
    const d = data({
      tasks: [
        task("archived", { title: "zeta", archivedAt: at, updatedAt: later(30) }),
        task("done", { title: "zeta", status: "done", updatedAt: later(20) }),
        task("old", { title: "zeta", updatedAt: later(1) }),
        task("new", { title: "zeta", updatedAt: later(10) }),
        task("desc", { description: "zeta", updatedAt: later(40) }),
      ],
    });
    expect(search(d, "zeta").cards.map((c) => c.taskId)).toEqual(["new", "old", "done", "archived", "desc"]);
    expect(search(d, "zeta").cards.find((c) => c.taskId === "archived")?.archived).toBe(true);
  });
  test("limit and truncated; project scope", () => {
    const d = data({ projects: [project("p"), project("q")], tasks: [task("a", { title: "x1" }), task("b", { title: "x1" }), task("c", { title: "x1", projectId: "q" })] });
    expect(search(d, "x1", { limit: 2 })).toMatchObject({ truncated: true });
    expect(search(d, "x1", { limit: 2 }).cards).toHaveLength(2);
    expect(search(d, "x1", { projectIds: new Set(["q"]) }).cards).toMatchObject([{ taskId: "c", projectTitle: "Project q" }]);
    expect(search(d, "x1", { excludeTaskId: "a" }).cards.map((c) => c.taskId)).not.toContain("a");
  });
});

describe("SearchService (§4, §6)", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });
  async function service(board: Board, opts: { summaries?: () => Promise<SummaryEntry[]>; memory?: () => Promise<MemoryEntry[]>; memoryOn?: boolean; ideas?: boolean } = {}) {
    dir = await mkdtemp(join(tmpdir(), "flowly-search-"));
    await writeFile(join(dir, "summaries.json"), "{}");
    await writeFile(join(dir, "memory.json"), "{}");
    return new SearchService({
      board: async () => structuredClone(board),
      summaries: { path: join(dir, "summaries.json"), read: opts.summaries || (async () => [summary("a", { recap: "summaryhit" })]) },
      memory: { path: join(dir, "memory.json"), read: opts.memory || (async () => [memoryEntry("m", { title: "memhit" })]) },
      memoryOn: () => opts.memoryOn ?? true,
      ideasOn: async () => opts.ideas ?? true,
      artifactsOn: async () => true,
    });
  }
  const board = (): Board => ({
    ...emptyBoard(),
    projects: [project("p"), project("q"), project("z", { archivedAt: at })],
    tasks: [task("a", { title: "alpha shared" }), task("b", { title: "beta shared" }), task("c", { title: "gamma shared", projectId: "q" })],
    ideas: [{ id: "i", taskId: "b", projectId: "p", agentId: "s", eventId: "e", title: "ideahit", detail: "", rationale: "", context: "", status: "open", createdAt: at, updatedAt: at }],
  });
  test("results follow the schema; null project searches every project that is not archived", async () => {
    const s = await service(board());
    const all = searchResultSchema.parse(await s.query({ query: "shared", projectId: null }));
    expect(all.cards.map((c) => c.taskId).sort()).toEqual(["a", "b", "c"]);
    expect((await s.query({ query: "shared", projectId: "q" })).cards.map((c) => c.taskId)).toEqual(["c"]);
    expect((await s.query({ query: "summaryhit", projectId: "p" })).cards.map((c) => c.taskId)).toEqual(["a"]);
    expect((await s.query({ query: "memhit", projectId: "p" })).memory).toHaveLength(1);
  });
  test("unknown or archived projects and invalid input are errors", async () => {
    const s = await service(board());
    await expect(s.query({ query: "x", projectId: "missing" })).rejects.toThrow("Project not found.");
    await expect(s.query({ query: "x", projectId: "z" })).rejects.toThrow("Project not found.");
    await expect(s.query({ query: "x".repeat(201), projectId: null })).rejects.toThrow();
    await expect(s.query({ query: "x", projectId: null, limit: 51 })).rejects.toThrow();
    await expect(s.query({ query: "x", projectId: null, sources: ["nope" as never] })).rejects.toThrow();
  });
  test("an unreadable summaries or memory file leaves the rest and is reported in partial", async () => {
    const s = await service(board(), { summaries: async () => Promise.reject(new Error("bad")), memory: async () => Promise.reject(new Error("bad")) });
    const found = await s.query({ query: "shared", projectId: "p" });
    expect(found.cards).toHaveLength(2);
    expect(found.partial).toEqual(["memory", "summaries"]);
  });
  test("memory off for a project and ideas turned off leave those sources out", async () => {
    const s = await service(board(), { memoryOn: false, ideas: false });
    expect((await s.query({ query: "memhit", projectId: "p" })).memory).toEqual([]);
    expect((await s.query({ query: "ideahit", projectId: "p" })).cards).toEqual([]);
  });
  test("turning memory off applies to the next search without any data change", async () => {
    let on = true;
    dir = await mkdtemp(join(tmpdir(), "flowly-search-"));
    const s = new SearchService({
      board: async () => board(),
      summaries: { path: join(dir, "summaries.json"), read: async () => [] },
      memory: { path: join(dir, "memory.json"), read: async () => [memoryEntry("m", { title: "memhit" })] },
      memoryOn: () => on,
      ideasOn: async () => true,
      artifactsOn: async () => true,
    });
    expect((await s.query({ query: "memhit", projectId: "p" })).memory).toHaveLength(1);
    on = false;
    expect((await s.query({ query: "memhit", projectId: "p" })).memory).toEqual([]);
  });
  test("flowly_search drops the summary when the summaries file cannot be read", async () => {
    let fail = false;
    dir = await mkdtemp(join(tmpdir(), "flowly-search-"));
    const s = new SearchService({
      board: async () => board(),
      summaries: { path: join(dir, "summaries.json"), read: async () => (fail ? Promise.reject(new Error("bad")) : [summary("b", { state: "old state" })]) },
      memory: { path: join(dir, "memory.json"), read: async () => [] },
      memoryOn: () => true,
      ideasOn: async () => true,
      artifactsOn: async () => true,
    });
    const p = board().projects[0];
    expect((await s.forAgent(p, "a", agentSearchInputSchema.parse({ query: "beta" }))).cards[0].summary).toBe("old state");
    fail = true;
    await writeFile(join(dir, "summaries.json"), "changed");
    expect((await s.forAgent(p, "a", agentSearchInputSchema.parse({ query: "beta" }))).cards[0].summary).toBeUndefined();
  });
  test("flowly_search: own project only, own card excluded, no memory, latest summary clipped", async () => {
    const long = "word ".repeat(200);
    const s = await service(board(), { summaries: async () => [summary("b", { state: "state", recap: long })] });
    const p = board().projects[0];
    const found = agentSearchResultSchema.parse(await s.forAgent(p, "a", agentSearchInputSchema.parse({ query: "shared" })));
    expect(found.cards.map((c) => c.taskId)).toEqual(["b"]);
    expect(found.cards[0].summary!.length).toBeLessThanOrEqual(400);
    expect(found.cards[0].summary!.startsWith("state\n")).toBe(true);
    expect((await s.forAgent(p, "a", agentSearchInputSchema.parse({ query: "memhit" }))).cards).toEqual([]);
    expect(agentSearchInputSchema.safeParse({ query: "x", sources: ["memory"] }).success).toBe(false);
    expect(agentSearchInputSchema.safeParse({ query: "x", limit: 21 }).success).toBe(false);
  });
});

test("performance: one search over ten times the current data stays under 50 ms (§11.9)", () => {
  const tasks: Task[] = [];
  const events: Board["events"] = [];
  const summaries: SummaryEntry[] = [];
  const words = ["sqlite", "drawer", "composer", "migration", "搜索", "迁移", "hermes", "closure", "keyboard", "insights"];
  for (let i = 0; i < 1130; i++) {
    tasks.push(task(`t${i}`, { title: `${words[i % 10]} card ${i}`, description: `Description ${i} ${words[(i * 3) % 10]} `.repeat(8) }));
    summaries.push(summary(`t${i}`, { recap: `- did ${words[(i * 7) % 10]} work\n`.repeat(6), state: "state" }));
  }
  for (let i = 0; i < 48000; i++) {
    events.push({ id: `e${i}`, taskId: `t${i % 1130}`, actor: "agent", action: "status_changed", note: `Delivered ${words[i % 10]} change ${i}; checks passed`.repeat(3), at: later(i % 5000) });
  }
  const d = data({ tasks, events, summaries });
  const index = buildSearchIndex(d);
  const queries = ["sqlite closure", "搜索", "迁移 drawer", "nothing-matches-this", "keyboard #none"];
  for (const q of queries) runSearch(index, { query: q, projectIds: null, limit: 30 });
  // Best of five per query: under a loaded parallel run one search can wait far longer for the CPU or a GC
  // pause than it spends searching; the fastest run is what the search itself costs.
  let worst = 0;
  for (const q of queries) {
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      runSearch(index, { query: q, projectIds: null, limit: 30 });
      best = Math.min(best, performance.now() - started);
    }
    worst = Math.max(worst, best);
  }
  expect(worst).toBeLessThan(50);
});
