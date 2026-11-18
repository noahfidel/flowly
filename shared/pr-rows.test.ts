import { expect, test } from "vitest";
import { boardSchema, type Artifact, type Task } from "./model";
import { prReviewOperationId } from "./pr-review";
import { boardPrs, cardPrs, githubPrKey, prMenuCard, prRepoOf } from "./pr-rows";
import { boardOverview } from "../server/board-overview";

/** The pull requests menu's rows (PR-MENU-SPEC §3.1): which PRs each card contributes. */

const at = (s: number) => new Date(Date.parse("2026-11-18T10:00:00.000Z") + s * 1000).toISOString();
let n = 0;
const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    projectId: "p",
    workspaceId: `w-${id}`,
    sourcePath: "/fixture",
    repoPaths: ["/fixture"],
    title: `Card ${id}`,
    description: "",
    status: "in_review",
    priority: "normal",
    position: 0,
    revision: 1,
    operationId: id,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    ...over,
  }) as Task;
const artifact = (taskId: string, target: string, over: Partial<Artifact> = {}): Artifact =>
  ({
    id: `a${++n}`,
    taskId,
    projectId: "p",
    role: "output",
    kind: /^https?:/.test(target) ? "url" : "file",
    target,
    title: target,
    note: "",
    createdBy: "agent",
    createdAt: at(n),
    updatedAt: at(n),
    ...over,
  }) as Artifact;
const review = (id: string, prRef: string, over: Partial<Task> = {}) => task(id, { operationId: prReviewOperationId(`agent-${id}`), prRef, title: `PR review: ${prRef}`, ...over });

test("outputs only: inputs, plans and non-PR links give no row; GitHub and GitLab numbers", () => {
  const t = task("t");
  const list = [
    artifact("t", "https://github.com/Acme/Web/pull/42"),
    artifact("t", "https://gitlab.com/g/sub/r/-/merge_requests/7"),
    artifact("t", "https://github.com/acme/web/pull/43", { role: "input" }),
    artifact("t", "./plan.md", { plan: { approvedAt: null, source: "manual", setAt: at(0) } as Artifact["plan"] }),
    artifact("t", "https://example.com/report"),
    artifact("other", "https://github.com/acme/web/pull/44"),
  ];
  const rows = cardPrs(t, list);
  expect(rows.map((r) => [r.kind, r.number, r.repo])).toEqual([
    ["pr", "!7", "g/sub/r"],
    ["pr", "#42", "Acme/Web"],
  ]);
  expect(rows[1]).toMatchObject({ artifactId: list[0].id, url: "https://github.com/Acme/Web/pull/42", title: list[0].title, createdAt: list[0].createdAt });
});

test("one row per URL per card, newest kept", () => {
  const t = task("t");
  const older = artifact("t", "https://github.com/o/r/pull/1", { title: "older" });
  const newer = artifact("t", "https://github.com/o/r/pull/1", { title: "newer" });
  expect(cardPrs(t, [older, newer]).map((r) => r.title)).toEqual(["newer"]);
});

test("a connector-linked PR reads its number and repo from the key", () => {
  const t = task("t");
  const a = artifact("t", "https://ghe.example.com/o/r/pull/9", { external: { connectionId: "c", provider: "github", key: "o/r#9", remoteId: "", itemType: "pull" } as Artifact["external"] });
  expect(cardPrs(t, [a]).map((r) => [r.number, r.repo])).toEqual([["#9", "o/r"]]);
  expect(prRepoOf(artifact("t", "https://example.com/x"))).toBe("");
});

test("a PR review card gives its prRef row, unless an output already names the same PR", () => {
  const card = review("r", "acme/web#5", { createdAt: at(-5) });
  const rows = cardPrs(card, []);
  expect(rows).toEqual([{ kind: "review", url: "https://github.com/acme/web/pull/5", number: "#5", repo: "acme/web", title: card.title, createdAt: card.createdAt }]);
  const same = artifact("r", "https://github.com/Acme/Web/pull/5");
  expect(cardPrs(card, [same]).map((r) => r.kind)).toEqual(["pr"]);
  const other = artifact("r", "https://github.com/acme/web/pull/6");
  expect(cardPrs(card, [other]).map((r) => `${r.kind}:${r.number}`)).toEqual(["pr:#6", "review:#5"]);
  // An ordinary card with a stray prRef is not a PR review card.
  expect(cardPrs(task("x", { prRef: "acme/web#5" }), [])).toEqual([]);
});

test("archived cards and Done/Cancelled lanes are left out; every other lane counts", () => {
  expect(prMenuCard(task("a", { archivedAt: at(1) }))).toBe(false);
  expect(prMenuCard(task("d", { status: "done" }))).toBe(false);
  expect(prMenuCard(task("c", { status: "cancelled" }))).toBe(false);
  for (const status of ["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked"] as const)
    expect(prMenuCard(task("s", { status }))).toBe(true);
});

test("board rows keep only the chosen projects' live cards", () => {
  const tasks = [task("a"), task("b", { projectId: "q" }), task("d", { status: "done" })];
  const artifacts = [artifact("a", "https://github.com/o/r/pull/1"), artifact("b", "https://github.com/o/r/pull/2", { projectId: "q" }), artifact("d", "https://github.com/o/r/pull/3")];
  expect(boardPrs({ tasks, artifacts }, ["p"]).map((r) => `${r.taskId}:${r.projectId}:${r.number}`)).toEqual(["a:p:#1"]);
  expect(boardPrs({ tasks, artifacts }, ["p", "q"]).map((r) => r.number)).toEqual(["#1", "#2"]);
});

test("githubPrKey: owner/repo#n of a github.com pull URL, else null", () => {
  expect(githubPrKey("https://github.com/Acme/Web/pull/42/files")).toBe("Acme/Web#42");
  expect(githubPrKey("https://gitlab.com/g/r/-/merge_requests/1")).toBeNull();
  expect(githubPrKey("https://ghe.example.com/o/r/pull/1")).toBeNull();
});

test("the overview's prs count per card matches the rows rule", () => {
  const project = { id: "p", title: "Project", description: "", paseoProjectId: "n", primaryPath: "/fixture", repos: ["/fixture"], revision: 1, createdAt: at(0), updatedAt: at(0), archivedAt: null };
  const tasks = [task("a"), task("d", { status: "done" }), review("r", "acme/web#5"), task("none")];
  const artifacts = [artifact("a", "https://github.com/o/r/pull/1"), artifact("a", "https://github.com/o/r/pull/1"), artifact("a", "https://gitlab.com/g/r/-/merge_requests/2"), artifact("d", "https://github.com/o/r/pull/3")];
  const board = boardSchema.parse({ version: 5, revision: 1, events: [], projects: [project], tasks, artifacts });
  const counts = Object.fromEntries(boardOverview(board).cards.map((c) => [c.taskId, c.prs]));
  expect(counts).toEqual({ a: 2, d: 0, r: 1, none: 0 });
  const rows = boardPrs(board, ["p"]);
  for (const t of tasks) expect(counts[t.id]).toBe(rows.filter((r) => r.taskId === t.id).length);
});
