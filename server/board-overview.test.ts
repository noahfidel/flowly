import { expect, test } from "vitest";
import { boardSchema } from "../shared/model";
import { boardOverviewSchema } from "../shared/overview";
import { readOverviewChanged } from "../shared/rpc";
import { applyOverviewPatch } from "../client/overview-query";
import { boardOverview, OverviewDeltas } from "./board-overview";

function view(revision = 1) {
  return boardOverview(boardSchema.parse({ events: [], version: 5, revision, projects: [], tasks: [] }));
}
const at = "2026-10-23T00:00:00Z";
const project = { id: "p", title: "Project", description: "", paseoProjectId: "n", primaryPath: "/fixture", repos: ["/fixture"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null };
const task = (id: string) => ({ id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/fixture", repoPaths: ["/fixture"], title: id, description: "searchable", status: "todo" as const, priority: "normal" as const, position: 0, revision: 1, operationId: id, createdAt: at, updatedAt: at, archivedAt: null });

test("first/unknown etag returns only overview and unchanged returns only its independent tag", () => {
  const deltas = new OverviewDeltas(), board = view();
  const first = readOverviewChanged.output.parse(deltas.read(board, {}));
  expect(first).toEqual({ etag: expect.stringMatching(/^overview-v1:/), value: board });
  expect(deltas.read(board, { etag: first.etag })).toEqual({ etag: first.etag });
  expect(deltas.read(board, { etag: "complete-board-tag" })).toEqual(first);
  expect(readOverviewChanged.input.safeParse({ since: { count: 1, lastId: "x" } }).success).toBe(false);
});

test("add/update/remove/reorder patches match the exact snapshot and preserve unchanged objects", () => {
  const deltas = new OverviewDeltas();
  const initial = boardOverview(boardSchema.parse({ events: [], version: 5, revision: 1, projects: [project], tasks: [task("a"), task("b")] }));
  const first = deltas.read(initial, {});
  const next = boardOverview(boardSchema.parse({ events: [], version: 5, revision: 2, projects: [project], tasks: [{ ...task("c"), description: "new" }, task("b"), { ...task("a"), title: "edited" }] }));
  const response = readOverviewChanged.output.parse(deltas.read(next, { etag: first.etag }));
  expect(response.patch?.baseEtag).toBe(first.etag);
  expect(response.patch?.tasks?.order).toEqual(["c", "b", "a"]);
  const applied = applyOverviewPatch(initial, response.patch!);
  expect(applied).toEqual(next);
  expect(applied.tasks[1]).toBe(initial.tasks[1]);
  expect(applied.projects).toBe(initial.projects);
  const deleted = { ...next, revision: 3, tasks: next.tasks.filter(t => t.id !== "b"), cards: next.cards.filter(c => c.taskId !== "b") };
  const removal = deltas.read(deleted, { etag: response.etag });
  expect(removal.patch?.tasks?.remove).toEqual(["b"]);
  expect(removal.patch?.cards?.remove).toEqual(["b"]);
  expect(applyOverviewPatch(applied, removal.patch!)).toEqual(deleted);
});

test("eviction looks up the oldest base before remembering the next value; restart stays scoped", () => {
  const deltas = new OverviewDeltas(2);
  const a = deltas.read(view(1), {});
  deltas.read(view(2), {});
  const c = deltas.read(view(3), { etag: a.etag });
  expect(c.patch).toEqual({ baseEtag: a.etag, revision: 3 });
  const d = deltas.read(view(4), { etag: a.etag });
  expect(d.value).toEqual(view(4));
  expect(new OverviewDeltas().read(view(4), { etag: c.etag }).value).toEqual(view(4));
});

test("body-only event changes yield revision-only patches while signals change when the report changes", () => {
  const deltas = new OverviewDeltas();
  const board = boardSchema.parse({ version: 5, revision: 1, projects: [project], tasks: [task("a")], events: [{ id: "e", taskId: "a", actor: "agent", agentId: "s", action: "progress_reported", at, reportKind: "progress", note: "old body" }] });
  const first = deltas.read(boardOverview(board), {});
  const changed = { ...board, revision: 2, events: board.events.map(e => ({ ...e, note: "new body" })) };
  expect(deltas.read(boardOverview(changed), { etag: first.etag }).patch).toEqual({ baseEtag: first.etag, revision: 2 });
  changed.events[0].reportKind = "question";
  const signal = deltas.read(boardOverview(changed), { etag: first.etag }).patch!;
  expect(signal.cards?.set[0].questions).toBe(1);
  expect(JSON.stringify(signal)).not.toContain("new body");
  expect(boardOverviewSchema.parse(boardOverview(changed)).cards[0].questions).toBe(1);
});

test("groups ride in the overview sorted by position; add, rename, move and remove patch like any collection", () => {
  const group = (id: string, position: number, over = {}) => ({ id, name: id, position, revision: 1, createdAt: at, updatedAt: at, ...over });
  const build = (revision: number, groups: ReturnType<typeof group>[]) => boardOverview(boardSchema.parse({ events: [], version: 5, revision, projects: [project], tasks: [], groups }));
  const deltas = new OverviewDeltas();
  const initial = build(1, [group("b", 1), group("a", 0, { isDefault: true })]);
  expect(boardOverviewSchema.parse(initial).groups.map(g => g.id)).toEqual(["a", "b"]);
  const first = deltas.read(initial, {});
  const next = build(2, [group("a", 0, { isDefault: true, name: "Renamed", revision: 2 }), group("c", 1), group("b", 2)]);
  const response = readOverviewChanged.output.parse(deltas.read(next, { etag: first.etag }));
  expect(response.patch?.groups?.set.map(g => g.id).sort()).toEqual(["a", "b", "c"]);
  expect(response.patch?.groups?.order).toEqual(["a", "c", "b"]);
  expect(applyOverviewPatch(initial, response.patch!)).toEqual(next);
  const removed = build(3, [group("a", 0, { isDefault: true, name: "Renamed", revision: 2 }), group("b", 2)]);
  const removal = deltas.read(removed, { etag: response.etag });
  expect(removal.patch?.groups?.remove).toEqual(["c"]);
  expect(applyOverviewPatch(next, removal.patch!)).toEqual(removed);
});
