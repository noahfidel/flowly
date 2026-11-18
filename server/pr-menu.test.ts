import { expect, test } from "vitest";
import type { Connection, ExternalRef } from "../shared/connectors";
import type { Artifact, Task } from "../shared/model";
import { prReviewOperationId } from "../shared/pr-review";
import { listPrs, prFetchCap, type PrMenuReads } from "./pr-menu";
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
  states: Record<string, { status: string; stale?: boolean }>,
  calls: ExternalRef[][] = [],
  cache: Record<string, { status: string; expired: boolean }> = {},
): PrMenuReads {
  return {
    list: async () => connections,
    cached: async (refs) => new Map(refs.flatMap((ref) => (cache[ref.key] ? [[refKey(ref), { summary: { status: cache[ref.key].status } as never, expired: cache[ref.key].expired }] as const] : []))),
    locate: async (list) => new Map(list.filter((a) => a.external).map((a) => [a.id, connections.some((c) => c.id === a.external!.connectionId) ? a.external! : null])),
    badges: async (refs) => {
      calls.push([...refs]);
      const out: Summaries = new Map();
      for (const ref of refs) {
        const hit = states[ref.key];
        if (hit) out.set(refKey(ref), { summary: { status: hit.status } as never, fingerprint: "", stale: !!hit.stale });
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
