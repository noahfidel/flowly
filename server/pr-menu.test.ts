import { expect, test } from "vitest";
import type { Connection, ExternalRef } from "../shared/connectors";
import type { Artifact, Task } from "../shared/model";
import { prReviewOperationId } from "../shared/pr-review";
import { prSections } from "../client/pr-list";
import { GhPrCache, ghPrMenuState, ghViewerLogin, listPrs, PrMineIndex, prFetchCap, type PrMenuReads } from "./pr-menu";
import { refKey, type Summaries } from "./connectors/service";

/** `prs.list` (PR-MENU-SPEC §3.2): rows of the chosen projects, each with the connector badge's state word. */

const at = (s: number) => new Date(Date.parse("2026-11-18T10:00:00.000Z") + s * 1000).toISOString();
let n = 0;
const project = (id: string, archivedAt: string | null = null) => ({ id, title: id, description: "", paseoProjectId: id, primaryPath: "/f", repos: ["/f"], revision: 1, createdAt: at(0), updatedAt: at(0), archivedAt });
const task = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/f", repoPaths: ["/f"], title: `Card ${id}`, description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: id, createdAt: at(0), updatedAt: at(0), archivedAt: null, ...over }) as Task;
const artifact = (taskId: string, target: string, over: Partial<Artifact> = {}): Artifact =>
  ({ id: `a${++n}`, taskId, projectId: "p", role: "output", kind: "url", target, title: target, note: "", createdBy: "agent", createdAt: at(n), updatedAt: at(n), ...over }) as Artifact;

const github: Connection = { id: "gh", provider: "github", baseUrl: "https://github.com", name: "GitHub" } as unknown as Connection;
const gitlab: Connection = { id: "gl", provider: "gitlab", baseUrl: "https://gitlab.com", name: "GitLab" } as unknown as Connection;

function fakeReads(
  connections: Connection[],
  states: Record<string, { status: string; stale?: boolean; author?: string; summary?: string }>,
  calls: ExternalRef[][] = [],
  cache: Record<string, { status: string; expired: boolean; author?: string; summary?: string }> = {},
  viewers: Record<string, string> = {},
): PrMenuReads {
  return {
    list: async () => connections,
    viewers: async () => new Map(Object.entries(viewers)),
    cached: async (refs) => new Map(refs.flatMap((ref) => (cache[ref.key] ? [[refKey(ref), { summary: { status: cache[ref.key].status, author: cache[ref.key].author, summary: cache[ref.key].summary } as never, expired: cache[ref.key].expired }] as const] : []))),
    locate: async (list) => new Map(list.filter((a) => a.external).map((a) => [a.id, connections.some((c) => c.id === a.external!.connectionId) ? a.external! : null])),
    badges: async (refs) => {
      calls.push([...refs]);
      const out: Summaries = new Map();
      for (const ref of refs) {
        const hit = states[ref.key];
        if (hit) out.set(refKey(ref), { summary: { status: hit.status, author: hit.author, summary: hit.summary } as never, fingerprint: "", stale: !!hit.stale });
      }
      return out;
    },
  };
}

test("states: connector ref, plain github URL through the GitHub connection, review prRef, unknown elsewhere; stale keeps its word", async () => {
  const linked = artifact("a", "https://ghe.example.com/o/r/pull/9", { external: { connectionId: "gl", provider: "gitlab", key: "g/r!9", remoteId: "", itemType: "merge_request" } as Artifact["external"] });
  const plain = artifact("a", "https://github.com/Acme/Web/pull/42", { title: "Fix it" });
  const lab = artifact("b", "https://gitlab.com/g/r/-/merge_requests/3");
  const reviewCard = task("r", { operationId: prReviewOperationId("x"), prRef: "acme/api#7", status: "in_review" });
  const board = { projects: [project("p")], tasks: [task("a"), task("b"), reviewCard], artifacts: [linked, plain, lab] };
  const calls: ExternalRef[][] = [];
  const reads = fakeReads([github, gitlab], { "g/r!9": { status: "Merged" }, "Acme/Web#42": { status: "Draft", stale: true }, "acme/api#7": { status: "Open" } }, calls);
  const { rows } = await listPrs(board, ["p"], reads);
  const byNumber = Object.fromEntries(rows.map((r) => [`${r.taskId}${r.number}`, r]));
  expect(byNumber["a!9"]).toMatchObject({ kind: "pr", state: "merged", artifactId: linked.id, projectId: "p" });
  expect(byNumber["a#42"]).toMatchObject({ kind: "pr", state: "draft", repo: "Acme/Web", title: "Fix it", url: plain.target });
  expect(byNumber["b!3"]).toMatchObject({ state: "" });
  expect(byNumber["r#7"]).toMatchObject({ kind: "review", state: "open", url: "https://github.com/acme/api/pull/7" });
  expect(byNumber["r#7"].artifactId).toBeUndefined();
  // One batch through the badge cache.
  expect(calls).toHaveLength(1);
  expect(calls[0].map((r) => `${r.connectionId}:${r.key}`).sort()).toEqual(["gh:Acme/Web#42", "gh:acme/api#7", "gl:g/r!9"]);
});

test("no working GitHub connection: plain URLs have no state; nothing to look up makes no call", async () => {
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [artifact("a", "https://github.com/o/r/pull/1")] };
  const calls: ExternalRef[][] = [];
  const broken = { ...github, authFailed: true } as Connection;
  const { rows } = await listPrs(board, ["p"], fakeReads([broken], { "o/r#1": { status: "Open" } }, calls));
  expect(rows.map((r) => r.state)).toEqual([""]);
  expect(calls).toHaveLength(0);
});

test("unknown and archived projects are skipped", async () => {
  const board = {
    projects: [project("p"), project("old", at(1))],
    tasks: [task("a"), task("z", { projectId: "old" })],
    artifacts: [artifact("a", "https://github.com/o/r/pull/1"), artifact("z", "https://github.com/o/r/pull/2", { projectId: "old" })],
  };
  const { rows } = await listPrs(board, ["p", "old", "missing"], fakeReads([], {}));
  expect(rows.map((r) => r.taskId)).toEqual(["a"]);
});

test("a failing connector read still lists the rows, without states", async () => {
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [artifact("a", "https://github.com/o/r/pull/1")] };
  const reads: PrMenuReads = { ...fakeReads([github], {}), badges: async () => { throw new Error("offline"); } };
  const { rows } = await listPrs(board, ["p"], reads, () => {});
  expect(rows.map((r) => [r.number, r.state])).toEqual([["#1", ""]]);
});

test("a cold cache fetches at most 20 PRs per read; cached ones answer from the cache; the rest show no word this time", async () => {
  expect(prFetchCap).toBe(20);
  const tasks = [task("a")];
  const artifacts = Array.from({ length: 27 }, (_, i) => artifact("a", `https://github.com/o/r/pull/${i + 1}`));
  const board = { projects: [project("p")], tasks, artifacts };
  const states = Object.fromEntries(artifacts.map((_, i) => [`o/r#${i + 1}`, { status: "Open" }]));
  const calls: ExternalRef[][] = [];
  // #1 is fresh in the cache, #2 is in the cache but older than the badge TTL.
  const reads = fakeReads([github], states, calls, { "o/r#1": { status: "Merged", expired: false }, "o/r#2": { status: "Closed", expired: true } });
  const { rows } = await listPrs(board, ["p"], reads);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(20);
  // Never-fetched PRs go first; the expired one keeps its cached word.
  expect(calls[0].map((r) => r.key)).not.toContain("o/r#1");
  expect(calls[0].map((r) => r.key)).not.toContain("o/r#2");
  const state = Object.fromEntries(rows.map((r) => [r.number, r.state]));
  expect(state["#1"]).toBe("merged");
  expect(state["#2"]).toBe("closed");
  expect(rows.filter((r) => r.state === "open")).toHaveLength(20);
  expect(rows.filter((r) => r.state === "")).toHaveLength(5);
});

test("hidden: the flag is set per card and URL; a hidden PR is never fetched and keeps a cached word", async () => {
  const hiddenOne = artifact("a", "https://github.com/o/r/pull/1");
  const shownOne = artifact("a", "https://github.com/o/r/pull/2");
  const other = artifact("b", "https://github.com/o/r/pull/1");
  const board = {
    projects: [project("p")],
    tasks: [task("a"), task("b")],
    artifacts: [hiddenOne, shownOne, other],
    hiddenPrs: [{ taskId: "a", url: ` ${hiddenOne.target}`, hiddenAt: at(0) }],
  };
  const calls: ExternalRef[][] = [];
  const reads = fakeReads([github], { "o/r#1": { status: "Open" }, "o/r#2": { status: "Open" } }, calls);
  const { rows } = await listPrs(board, ["p"], reads);
  expect(rows.map((r) => `${r.taskId}${r.number}:${r.hidden}`).sort()).toEqual(["a#1:true", "a#2:false", "b#1:false"]);
  // o/r#1 is fetched once, for card b; o/r#2 once.
  expect(calls.flat().map((r) => r.key).sort()).toEqual(["o/r#1", "o/r#2"]);

  // Only hidden PRs: no network call, the cache word still shows.
  const onlyHidden = { ...board, tasks: [task("a")], artifacts: [hiddenOne] };
  const none: ExternalRef[][] = [];
  const cached = fakeReads([github], { "o/r#1": { status: "Open" } }, none, { "o/r#1": { status: "Merged", expired: true } });
  const result = await listPrs(onlyHidden, ["p"], cached);
  expect(none).toHaveLength(0);
  expect(result.rows).toMatchObject([{ hidden: true, state: "merged" }]);
  const empty = await listPrs(onlyHidden, ["p"], fakeReads([github], {}, none));
  expect(none).toHaveLength(0);
  expect(empty.rows).toMatchObject([{ hidden: true, state: "" }]);
});

test("hidden: a hidden PR that has merged stays hidden", async () => {
  const a = artifact("a", "https://github.com/o/r/pull/1");
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [a], hiddenPrs: [{ taskId: "a", url: a.target, hiddenAt: at(0) }] };
  const open = await listPrs(board, ["p"], fakeReads([github], {}, [], { "o/r#1": { status: "Open", expired: false } }));
  const merged = await listPrs(board, ["p"], fakeReads([github], {}, [], { "o/r#1": { status: "Merged", expired: false } }));
  expect(open.rows[0]).toMatchObject({ hidden: true, state: "open" });
  expect(merged.rows[0]).toMatchObject({ hidden: true, state: "merged" });
});

/** The `gh` fallback (PR-MENU-SPEC §3.2): github.com PRs no GitHub connection reads. */
const ghSetup = (words: Record<string, "merged" | "open" | "closed" | "draft" | null | "throw"> = {}, authors: Record<string, string> = {}, titles: Record<string, string> = {}) => {
  const asked: string[] = [];
  const cache = { now: 0 };
  const ghCache = new GhPrCache(() => cache.now);
  const gh: NonNullable<PrMenuReads["gh"]> = async (pr) => {
    asked.push(`${pr.repo}#${pr.number}`);
    const word = words[`${pr.repo}#${pr.number}`] ?? "open";
    if (word === "throw") throw new Error("gh missing");
    return word ? { state: word, author: authors[`${pr.repo}#${pr.number}`] ?? "", title: titles[`${pr.repo}#${pr.number}`] ?? "" } : null;
  };
  return { asked, clock: cache, ghCache, gh };
};
const plainBoard = (count = 1, over: object = {}) => ({
  projects: [project("p")],
  tasks: [task("a")],
  artifacts: Array.from({ length: count }, (_, i) => artifact("a", `https://github.com/o/r/pull/${i + 1}`)),
  ...over,
});

test("gh: with no GitHub connection a merged PR reads merged and lands in the Merged or closed section", async () => {
  const g = ghSetup({ "o/r#1": "merged" });
  const { rows } = await listPrs(plainBoard(), ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache });
  expect(rows.map((r) => r.state)).toEqual(["merged"]);
  expect(prSections(rows, () => "development").map((s) => s.id)).toEqual(["closed"]);
});

test("gh: a fresh cache entry answers without a call; an expired one calls again and a failed call keeps the old word", async () => {
  const g = ghSetup();
  const reads = { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache };
  g.ghCache.set("O/R#1", "merged");
  g.clock.now = 29 * 60_000;
  expect((await listPrs(plainBoard(), ["p"], reads)).rows[0].state).toBe("merged");
  expect(g.asked).toEqual([]);
  g.clock.now = 31 * 60_000;
  const failing = ghSetup({ "o/r#1": "throw" });
  failing.ghCache.set("o/r#1", "merged");
  failing.clock.now = 31 * 60_000;
  const logged: unknown[][] = [];
  const stale = await listPrs(plainBoard(), ["p"], { ...fakeReads([], {}), gh: failing.gh, ghCache: failing.ghCache }, (...a: unknown[]) => void logged.push(a));
  expect(failing.asked).toEqual(["o/r#1"]);
  expect(stale.rows[0].state).toBe("merged");
  expect(logged).toHaveLength(1);
  expect((await listPrs(plainBoard(), ["p"], reads)).rows[0].state).toBe("open");
  expect(g.asked).toEqual(["o/r#1"]);
});

test("gh: shares the 20-per-read cap with connector fetches, connector first", async () => {
  const linked = Array.from({ length: 15 }, (_, i) =>
    artifact("a", `https://gitlab.com/g/r/-/merge_requests/${i + 1}`, { external: { connectionId: "gl", provider: "gitlab", key: `g/r!${i + 1}`, remoteId: "", itemType: "merge_request" } as Artifact["external"] }),
  );
  const plain = Array.from({ length: 10 }, (_, i) => artifact("a", `https://github.com/o/r/pull/${i + 1}`));
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [...linked, ...plain] };
  const g = ghSetup();
  const calls: ExternalRef[][] = [];
  await listPrs(board, ["p"], { ...fakeReads([gitlab], {}, calls), gh: g.gh, ghCache: g.ghCache });
  expect(calls[0]).toHaveLength(15);
  expect(g.asked).toHaveLength(5);
});

test("gh: hidden rows never call gh but show a cached word", async () => {
  const a = artifact("a", "https://github.com/o/r/pull/1");
  const board = { ...plainBoard(0), artifacts: [a], hiddenPrs: [{ taskId: "a", url: a.target, hiddenAt: at(0) }] };
  const g = ghSetup();
  const cold = await listPrs(board, ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache });
  expect(cold.rows[0]).toMatchObject({ hidden: true, state: "" });
  g.ghCache.set("o/r#1", "closed");
  g.clock.now = 60 * 60_000;
  const warm = await listPrs(board, ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache });
  expect(warm.rows[0]).toMatchObject({ hidden: true, state: "closed" });
  expect(g.asked).toEqual([]);
});

test("gh: never called when a working github.com GitHub connection reads the PR", async () => {
  const g = ghSetup();
  const { rows } = await listPrs(plainBoard(), ["p"], { ...fakeReads([github], { "o/r#1": { status: "Merged" } }), gh: g.gh, ghCache: g.ghCache });
  expect(rows[0].state).toBe("merged");
  expect(g.asked).toEqual([]);
});

test("gh: a throwing gh gives no state, caches nothing, logs once, and leaves connector states alone", async () => {
  const linked = artifact("a", "https://gitlab.com/g/r/-/merge_requests/1", { external: { connectionId: "gl", provider: "gitlab", key: "g/r!1", remoteId: "", itemType: "merge_request" } as Artifact["external"] });
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [linked, artifact("a", "https://github.com/o/r/pull/1"), artifact("a", "https://github.com/o/r/pull/2")] };
  const g = ghSetup({ "o/r#1": "throw", "o/r#2": "throw" });
  const logged: unknown[][] = [];
  const { rows } = await listPrs(board, ["p"], { ...fakeReads([gitlab], { "g/r!1": { status: "Merged" } }), gh: g.gh, ghCache: g.ghCache }, (...a: unknown[]) => void logged.push(a));
  expect(rows.map((r) => r.state).sort()).toEqual(["", "", "merged"]);
  expect(g.ghCache.get("o/r#1")).toBeUndefined();
  expect(logged).toHaveLength(1);
  expect(logged[0][0]).toBe("Flowly gh pull request states failed:");
});

test("ghPrMenuState: maps gh's answer and passes an argument array", async () => {
  const seen: (readonly string[])[] = [];
  const answer = async (json: string) => ghPrMenuState(async (file, args) => { expect(file).toBe("gh"); seen.push(args); return json; })({ repo: "o/r", number: 7 });
  expect(await answer('{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-20T10:00:00Z"}')).toEqual({ state: "merged", author: "", title: "" });
  expect(await answer('{"state":"CLOSED","isDraft":false,"mergedAt":"2026-11-20T10:00:00Z"}')).toMatchObject({ state: "merged" });
  expect(await answer('{"state":"CLOSED","isDraft":false,"mergedAt":null}')).toMatchObject({ state: "closed" });
  expect(await answer('{"state":"OPEN","isDraft":true,"mergedAt":null}')).toMatchObject({ state: "draft" });
  expect(await answer('{"state":"OPEN","isDraft":false,"mergedAt":null,"author":{"login":"ada"},"title":"  Fix #7 now "}')).toEqual({ state: "open", author: "ada", title: "Fix #7 now" });
  expect(await answer('{"state":"WAT"}')).toBeNull();
  expect(seen[0]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "state,isDraft,mergedAt,author,title"]);
});

/** "My PRs" (PR-MENU-SPEC D16): `mine` compares the PR's author with the login of the connection or gh that read it. */
const ghRead = (viewer: string | null | "throw", authors: Record<string, string> = {}) => {
  const g = ghSetup({}, authors);
  const viewerCalls = { n: 0 };
  const ghViewer = async () => {
    viewerCalls.n++;
    if (viewer === "throw") throw new Error("gh not signed in");
    return viewer;
  };
  return { ...g, viewerCalls, ghViewer };
};

test("mine: connector row compares the author with the connection's stored login, ignoring case; unknown login or author is null", async () => {
  const board = {
    projects: [project("p")],
    tasks: [task("a")],
    artifacts: [artifact("a", "https://github.com/o/r/pull/1"), artifact("a", "https://github.com/o/r/pull/2"), artifact("a", "https://github.com/o/r/pull/3")],
  };
  const states = { "o/r#1": { status: "Open", author: "Ada" }, "o/r#2": { status: "Open", author: "bob" }, "o/r#3": { status: "Open" } };
  const rows = (await listPrs(board, ["p"], fakeReads([github], states, [], {}, { gh: "ADA" }))).rows;
  const byNumber = (list: typeof rows) => Object.fromEntries(list.map((r) => [r.number, r.mine]));
  expect(byNumber(rows)).toEqual({ "#1": true, "#2": false, "#3": null });
  const noLogin = (await listPrs(board, ["p"], fakeReads([github], states))).rows;
  expect(byNumber(noLogin)).toEqual({ "#1": null, "#2": null, "#3": null });
});

test("mine: a cache entry from before authors existed is null, and a review row by someone else is false", async () => {
  const reviewCard = task("r", { operationId: prReviewOperationId("x"), prRef: "acme/api#7", status: "in_review" });
  const board = { projects: [project("p")], tasks: [task("a"), reviewCard], artifacts: [artifact("a", "https://github.com/o/r/pull/1")] };
  const cache = { "o/r#1": { status: "Open", expired: false } };
  const viewers = { gh: "ada" };
  const { rows } = await listPrs(board, ["p"], fakeReads([github], { "acme/api#7": { status: "Open", author: "zed" } }, [], cache, viewers));
  expect(Object.fromEntries(rows.map((r) => [r.number, r.mine]))).toEqual({ "#1": null, "#7": false });
});

test("mine: the failing connector path gives null", async () => {
  const reads = { ...fakeReads([github], {}), list: async () => { throw new Error("down"); } };
  const { rows } = await listPrs(plainBoard(), ["p"], reads, () => undefined);
  expect(rows.map((r) => r.mine)).toEqual([null]);
});

test("mine: gh row compares gh's author with the gh viewer, ignoring case", async () => {
  const g = ghRead("Ada", { "o/r#1": "ada", "o/r#2": "bob" });
  const { rows } = await listPrs(plainBoard(2), ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache, ghViewer: g.ghViewer });
  expect(Object.fromEntries(rows.map((r) => [r.number, r.mine]))).toEqual({ "#1": true, "#2": false });
  expect(g.viewerCalls.n).toBe(1);
});

test("mine: a failing gh viewer gives null, keeps the states and logs once", async () => {
  const g = ghRead("throw", { "o/r#1": "ada", "o/r#2": "bob" });
  const logged: unknown[][] = [];
  const { rows } = await listPrs(plainBoard(2), ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache, ghViewer: g.ghViewer }, (...a: unknown[]) => void logged.push(a));
  expect(rows.map((r) => [r.state, r.mine])).toEqual([["open", null], ["open", null]]);
  expect(logged).toHaveLength(1);
});

test("mine: no gh viewer is read without a gh row, or when every gh row is hidden", async () => {
  const g = ghRead("ada", { "o/r#1": "ada" });
  await listPrs(plainBoard(1), ["p"], { ...fakeReads([github], { "o/r#1": { status: "Open" } }), gh: g.gh, ghCache: g.ghCache, ghViewer: g.ghViewer });
  const a = artifact("a", "https://github.com/o/r/pull/1");
  const hidden = { ...plainBoard(0), artifacts: [a], hiddenPrs: [{ taskId: "a", url: a.target, hiddenAt: at(0) }] };
  const { rows } = await listPrs(hidden, ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache, ghViewer: g.ghViewer });
  expect(rows[0].mine).toBeNull();
  expect(g.viewerCalls.n).toBe(0);
});

test("mine: an old gh cache entry without an author is null", async () => {
  const g = ghRead("ada");
  g.ghCache.set("o/r#1", "open");
  const { rows } = await listPrs(plainBoard(), ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache, ghViewer: g.ghViewer });
  expect(rows[0]).toMatchObject({ state: "open", mine: null });
});

test("ghViewerLogin: asks gh api user with an argument array, caches 30 minutes on success and nothing on failure", async () => {
  const seen: (readonly string[])[] = [];
  const clock = { now: 0 };
  let fail = true;
  const read = ghViewerLogin(async (file, args) => {
    expect(file).toBe("gh");
    seen.push(args);
    if (fail) throw new Error("not signed in");
    return "ada\n";
  }, () => clock.now);
  await expect(read()).rejects.toThrow();
  fail = false;
  expect(await read()).toBe("ada");
  expect(await read()).toBe("ada");
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(["api", "user", "--jq", ".login"]);
  clock.now = 31 * 60_000;
  expect(await read()).toBe("ada");
  expect(seen).toHaveLength(3);
});

test("mine index: records true rows, drops false ones, keeps on null, per card and trimmed URL (PR-MENU-SPEC D20)", async () => {
  const one = "https://github.com/o/r/pull/1";
  const board = { projects: [project("p")], tasks: [task("a"), task("b")], artifacts: [artifact("a", one), artifact("a", "https://github.com/o/r/pull/2"), artifact("a", "https://github.com/o/r/pull/3"), artifact("b", one)] };
  const index = new PrMineIndex();
  const states = { "o/r#1": { status: "Open", author: "Ada" }, "o/r#2": { status: "Open", author: "bob" }, "o/r#3": { status: "Open" } };
  await listPrs(board, ["p"], { ...fakeReads([github], states, [], {}, { gh: "ada" }), mineIndex: index });
  expect(index.has("a", ` ${one} `)).toBe(true);
  expect(index.has("b", one)).toBe(true);
  expect(index.has("a", "https://github.com/o/r/pull/2")).toBe(false);
  expect(index.has("a", "https://github.com/o/r/pull/3")).toBe(false);
  // A later read that no longer knows the login (null) keeps the entries; one that says someone else drops them.
  await listPrs(board, ["p"], { ...fakeReads([github], states), mineIndex: index });
  expect(index.has("a", one)).toBe(true);
  await listPrs(board, ["p"], { ...fakeReads([github], states, [], {}, { gh: "eve" }), mineIndex: index });
  expect(index.has("a", one)).toBe(false);
  expect(index.has("b", one)).toBe(false);
});

test("mine index: a failed read keeps what the last good read found (PR-MENU-SPEC D20)", async () => {
  const one = "https://github.com/o/r/pull/1";
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [artifact("a", one)] };
  const index = new PrMineIndex();
  await listPrs(board, ["p"], { ...fakeReads([github], { "o/r#1": { status: "Open", author: "ada" } }, [], {}, { gh: "ada" }), mineIndex: index });
  expect(index.has("a", one)).toBe(true);
  const failing: PrMenuReads = { ...fakeReads([github], {}), list: async () => { throw new Error("offline"); }, mineIndex: index };
  const { rows } = await listPrs(board, ["p"], failing, () => {});
  expect(rows.map((r) => r.mine)).toEqual([null]);
  expect(index.has("a", one)).toBe(true);
});

test("mine index: hidden rows are recorded too; listPrs works without an index", async () => {
  const a = artifact("a", "https://github.com/o/r/pull/1");
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [a], hiddenPrs: [{ taskId: "a", url: a.target, hiddenAt: at(0) }] };
  const index = new PrMineIndex();
  await listPrs(board, ["p"], { ...fakeReads([github], {}, [], { "o/r#1": { status: "Open", expired: false, author: "ada" } }, { gh: "ada" }), mineIndex: index });
  expect(index.has("a", a.target)).toBe(true);
  await expect(listPrs(board, ["p"], fakeReads([github], {}))).resolves.toBeTruthy();
});

/** The PR's own title (PR-MENU-SPEC D25): from the connector summary (fetched or cached) or gh; "" when not read. */
test("prTitle: a fetched summary, a cached summary and gh give the title trimmed; a failed read gives none", async () => {
  const board = { projects: [project("p")], tasks: [task("a")], artifacts: [artifact("a", "https://github.com/o/r/pull/1"), artifact("a", "https://github.com/o/r/pull/2")] };
  const fetched = await listPrs(board, ["p"], fakeReads([github], { "o/r#1": { status: "Open", summary: " Fix the menu " } }, [], { "o/r#2": { status: "Open", expired: false, summary: "From cache" } }), () => {});
  expect(Object.fromEntries(fetched.rows.map((r) => [r.number, r.prTitle]))).toEqual({ "#1": "Fix the menu", "#2": "From cache" });
  const g = ghSetup({}, {}, { "o/r#1": "From gh" });
  const viaGh = await listPrs(plainBoard(), ["p"], { ...fakeReads([], {}), gh: g.gh, ghCache: g.ghCache });
  expect(viaGh.rows[0].prTitle).toBe("From gh");
  const failing: PrMenuReads = { ...fakeReads([github], {}), badges: async () => { throw new Error("offline"); } };
  expect((await listPrs(plainBoard(), ["p"], failing, () => {})).rows[0].prTitle).toBe("");
});
