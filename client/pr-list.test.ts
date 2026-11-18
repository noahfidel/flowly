import { expect, test } from "vitest";
import type { Status } from "../shared/model";
import { prCount, prRowTitle, prRowDetail, prSections, type PrListRow } from "./pr-list";

/** The pull requests menu (PR-MENU-SPEC §1 D5, §2.3): sections, their order and each row's text. */

const at = (s: number) => new Date(Date.parse("2026-11-18T10:00:00.000Z") + s * 1000).toISOString();
const row = (taskId: string, number: string, s: number, over: Partial<PrListRow> = {}): PrListRow => ({
  taskId,
  projectId: "p",
  artifactId: `a-${taskId}-${number}`,
  kind: "pr",
  url: `https://github.com/o/r/pull/${number.slice(1)}`,
  number,
  repo: "o/r",
  title: "",
  createdAt: at(s),
  state: "open",
  ...over,
});
const lanes: Record<string, Status> = { dev: "development", review: "in_review", done: "integrated", todo: "todo", blocked: "blocked", design: "design" };
const statusOf = (id: string) => lanes[id];
const ids = (sections: ReturnType<typeof prSections>) => sections.map((s) => `${s.id}: ${s.rows.map((r) => `${r.taskId}${r.number}`).join(" ")}`);

test("three sections, each only when it has rows; unknown state and drafts are Open", () => {
  expect(prSections([], statusOf)).toEqual([]);
  const rows = [
    row("dev", "#1", 1, { state: "" }),
    row("dev", "#2", 2, { state: "draft" }),
    row("review", "#3", 3, { state: "merged" }),
    row("review", "#4", 4, { state: "closed" }),
    row("todo", "#5", 5, { kind: "review", artifactId: undefined }),
  ];
  expect(ids(prSections(rows, statusOf))).toEqual(["open: dev#2 dev#1", "reviewing: todo#5", "closed: review#4 review#3"]);
  expect(ids(prSections([rows[0]], statusOf))).toEqual(["open: dev#1"]);
});

test("within a section: lane furthest along first, then newest PR first", () => {
  const rows = [
    row("todo", "#1", 9),
    row("blocked", "#2", 8),
    row("design", "#3", 7),
    row("dev", "#4", 1),
    row("dev", "#5", 2),
    row("review", "#6", 3),
    row("done", "#7", 0),
    row("gone", "#8", 10),
  ];
  expect(ids(prSections(rows, statusOf))).toEqual(["open: done#7 review#6 dev#5 dev#4 design#3 blocked#2 todo#1 gone#8"]);
});

test("row title: the number, then the artifact title unless it only repeats the number", () => {
  expect(prRowTitle(row("t", "#42", 0, { title: "Fix the menu" }), "Card")).toBe("#42 Fix the menu");
  expect(prRowTitle(row("t", "#42", 0, { title: "#42" }), "Card")).toBe("#42");
  expect(prRowTitle(row("t", "#42", 0, { title: "PR #42" }), "Card")).toBe("#42");
  expect(prRowTitle(row("t", "#42", 0, { title: "#42: Fix the menu" }), "Card")).toBe("#42 Fix the menu");
  expect(prRowTitle(row("t", "!7", 0, { title: "https://gitlab.com/g/r/-/merge_requests/7" , url: "https://gitlab.com/g/r/-/merge_requests/7" }), "Card")).toBe("!7");
  expect(prRowTitle(row("t", "#42", 0, { title: "" }), "Card")).toBe("#42");
  // A PR review card's row uses the card title.
  expect(prRowTitle(row("t", "#5", 0, { kind: "review", title: "PR review: o/r#5" }), "Review the API change")).toBe("#5 Review the API change");
});

test("row detail: repo · card · lane, with the project first when several are shown; review rows omit the card", () => {
  expect(prRowDetail(row("t", "#1", 0), { card: "Card A", lane: "In review" })).toBe("o/r · Card A · In review");
  expect(prRowDetail(row("t", "#1", 0, { repo: "" }), { card: "Card A", lane: "In review" })).toBe("Card A · In review");
  expect(prRowDetail(row("t", "#1", 0), { card: "Card A", lane: "In review", project: "Web" })).toBe("Web · o/r · Card A · In review");
  expect(prRowDetail(row("t", "#1", 0, { kind: "review" }), { card: "Card A", lane: "Todo" })).toBe("o/r · Todo");
});

test("the chip's count sums the overview's per-card prs over the live cards of the shown projects", () => {
  const tasks = [
    { id: "a", projectId: "p", archivedAt: null },
    { id: "b", projectId: "q", archivedAt: null },
    { id: "c", projectId: "p", archivedAt: at(1) },
    { id: "d", projectId: "p", archivedAt: null },
  ];
  const facts = new Map([["a", { prs: 2 }], ["b", { prs: 5 }], ["c", { prs: 1 }]]);
  expect(prCount([{ id: "p" }], tasks, facts)).toBe(2);
  expect(prCount([{ id: "p" }, { id: "q" }], tasks, facts)).toBe(7);
  expect(prCount([], tasks, facts)).toBe(0);
});

test("row title never repeats the PR, and never drops a bare leading number that is part of the title", () => {
  expect(prRowTitle(row("t", "#42", 0, { kind: "review" }), "PR review: a/b#42")).toBe("#42");
  expect(prRowTitle(row("t", "#42", 0, { kind: "review" }), "PR review: a/b#42 tighten auth")).toBe("#42 tighten auth");
  expect(prRowTitle(row("t", "#42", 0, { kind: "review" }), "PR review: #42")).toBe("#42");
  expect(prRowTitle(row("t", "#2024", 0, { title: "2024 roadmap" }), "Card")).toBe("#2024 2024 roadmap");
  expect(prRowTitle(row("t", "#2024", 0, { title: "#2024 — roadmap" }), "Card")).toBe("#2024 roadmap");
  expect(prRowTitle(row("t", "#42", 0, { title: "#420 other" }), "Card")).toBe("#42 #420 other");
  expect(prRowTitle(row("t", "!7", 0, { title: "!7 - Fix" }), "Card")).toBe("!7 Fix");
});
