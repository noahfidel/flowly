import { expect, test } from "vitest";
import { exitRows, groupByCard, ideaTabCounts, projectIdeas, visibleIdeas, type IdeaQuery } from "./idea-rows";
import type { Idea, Status } from "../shared/model";

const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, d = { id: "d" };

test("a leaving idea keeps its slot while it collapses", () => {
  expect(exitRows([a, c], [{ item: b, index: 1 }], new Set(["a", "b", "c"]))).toEqual([
    { item: a, leaving: false, entering: false },
    { item: b, leaving: true, entering: false },
    { item: c, leaving: false, entering: false },
  ]);
});

test("only ideas that arrive after the drawer opened rise in", () => {
  expect(exitRows([a, d], [], new Set(["a"])).map((r) => r.entering)).toEqual([false, true]);
});

test("an idea that came back is not also shown as leaving; out-of-range slots go last", () => {
  expect(exitRows([a, b], [{ item: b, index: 0 }, { item: c, index: 9 }], new Set(["a", "b", "c"]))).toEqual([
    { item: a, leaving: false, entering: false },
    { item: b, leaving: false, entering: false },
    { item: c, leaving: true, entering: false },
  ]);
});

const at = (n: number) => new Date(Date.UTC(2026, 9, 16, n)).toISOString();
const card = (id: string, status: Status, position = 0, archivedAt: string | null = null) => ({ id, title: `Card ${id}`, status, position, archivedAt });
const idea = (id: string, taskId: string, extra: Partial<Idea> = {}): Idea => ({
  id, taskId, projectId: "p", agentId: "a", eventId: "e", title: `Idea ${id}`, detail: "", rationale: "", context: "",
  status: "open", createdAt: at(1), updatedAt: at(1), ...extra,
});
const query = (extra: Partial<IdeaQuery> = {}): IdeaQuery => ({ tab: "open", search: "", scopes: new Set(), finishedOnly: false, taskId: "", sort: "newest", ...extra });
const lanes: Status[] = ["todo", "development", "in_review", "done"];
const tasks = [card("w", "development", 1), card("d", "done"), card("x", "development", 2, at(0)), card("t", "todo")];
const ideas = [
  idea("1", "w", { createdAt: at(3), priority: "low", scope: "here" }),
  idea("2", "d", { createdAt: at(2), priority: "urgent", detail: "Tune the Flaky retry" }),
  idea("3", "x", { createdAt: at(4) }),
  idea("4", "t", { createdAt: at(1), status: "dismissed" }),
  idea("5", "w", { createdAt: at(5), status: "accepted" }),
];
const ids = (list: Idea[]) => list.map((i) => i.id);

test("segment counts include ideas on finished and archived cards", () => {
  expect(ideaTabCounts(ideas)).toEqual({ open: 3, accepted: 1, dismissed: 1 });
  expect(projectIdeas([...ideas, idea("9", "o", { projectId: "q" })], "p")).toHaveLength(5);
});

test("ideas sort newest first, by priority, or by the card's lane and position with archived cards last", () => {
  expect(ids(visibleIdeas(ideas, tasks, lanes, query()))).toEqual(["3", "1", "2"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ sort: "priority" })))).toEqual(["2", "3", "1"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ sort: "card" })))).toEqual(["1", "2", "3"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ tab: "dismissed" })))).toEqual(["4"]);
});

test("search matches the idea's text and its card title; filters combine", () => {
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ search: " flaky " })))).toEqual(["2"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ search: "card x" })))).toEqual(["3"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ scopes: new Set(["here"]) })))).toEqual(["1"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ scopes: new Set(["new"]) })))).toEqual(["3", "2"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ finishedOnly: true })))).toEqual(["3", "2"]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ finishedOnly: true, scopes: new Set(["here"]) })))).toEqual([]);
  expect(ids(visibleIdeas(ideas, tasks, lanes, query({ taskId: "w", tab: "accepted" })))).toEqual(["5"]);
});

test("grouping by card keeps the list order", () => {
  const rows = [idea("1", "w"), idea("2", "d"), idea("3", "w")];
  expect(groupByCard(rows).map((g) => [g.taskId, ids(g.ideas)])).toEqual([["w", ["1", "3"]], ["d", ["2"]]]);
});

test("project ideas form a group with key null, sorted first", () => {
  const project = idea("p1", undefined as unknown as string, { taskId: undefined, createdAt: at(1) });
  const rows = [idea("1", "w"), project, idea("2", "w"), idea("3", "d")];
  expect(groupByCard(rows).map((g) => [g.taskId, g.ideas.map((i) => i.id)])).toEqual([
    [null, ["p1"]],
    ["w", ["1", "2"]],
    ["d", ["3"]],
  ]);
  // Project ideas lead the card order when sorting by card, too.
  expect(visibleIdeas([idea("1", "w"), project], tasks, lanes, query({ sort: "card" })).map((i) => i.id)).toEqual(["p1", "1"]);
  expect(visibleIdeas([project], tasks, lanes, query({ search: "idea p1" })).map((i) => i.id)).toEqual(["p1"]);
  expect(visibleIdeas([project], tasks, lanes, query({ finishedOnly: true }))).toEqual([]);
});

// Ruling (Noah, 2026-11-10): an unfiltered group board's Ideas page lists every live member's ideas; each project's own
// ideas form their own group, labelled with that project.
test("project ideas of several projects form one group per project, before the cards", () => {
  const own = (id: string, projectId: string) => idea(id, undefined as unknown as string, { taskId: undefined, projectId });
  const rows = [idea("1", "w"), own("p1", "p"), own("q1", "q"), own("p2", "p")];
  expect(groupByCard(rows).map((g) => [g.taskId, g.projectId, ids(g.ideas)])).toEqual([
    [null, "p", ["p1", "p2"]],
    [null, "q", ["q1"]],
    ["w", "p", ["1"]],
  ]);
});
