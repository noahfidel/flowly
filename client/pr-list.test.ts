import { expect, test } from "vitest";
import type { Status } from "../shared/model";
import { hiddenPrRows, isOwnPr, mineNote, prChipText, prCount, prListRead, prRowTitle, prRowDetail, prSections, type PrListRow } from "./pr-list";

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
  hidden: false,
  mine: null,
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
  const facts = new Map([["a", { prs: 2, prsHidden: 1, prsMine: 1 }], ["b", { prs: 5, prsHidden: 0 }], ["c", { prs: 1 }]]);
  expect(prCount([{ id: "p" }], tasks, facts)).toEqual({ shown: 2, hidden: 1, mine: 1 });
  expect(prCount([{ id: "p" }, { id: "q" }], tasks, facts)).toEqual({ shown: 7, hidden: 1, mine: 1 });
  expect(prCount([], tasks, facts)).toEqual({ shown: 0, hidden: 0, mine: 0 });
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

test("hidden PRs leave the sections; the hidden view lists them, newest first", () => {
  const rows = [row("dev", "#1", 1), row("dev", "#2", 2, { hidden: true }), row("review", "#3", 3, { hidden: true, state: "merged" }), row("todo", "#4", 4, { kind: "review", hidden: true })];
  expect(ids(prSections(rows, statusOf))).toEqual(["open: dev#1"]);
  expect(hiddenPrRows(rows).map((r) => `${r.taskId}${r.number}`)).toEqual(["todo#4", "review#3", "dev#2"]);
  expect(hiddenPrRows([rows[0]])).toEqual([]);
});

test("My PRs on: only own PRs in Open and Merged or closed, review rows dropped, unknown author in its own last section", () => {
  const rows = [
    row("dev", "#1", 1, { mine: true }),
    row("dev", "#2", 2, { mine: false }),
    row("dev", "#3", 3, { mine: null }),
    row("review", "#4", 4, { mine: true, state: "merged" }),
    row("done", "#5", 5, { mine: null, state: "closed" }),
    row("todo", "#6", 6, { kind: "review", artifactId: undefined, mine: true }),
    row("dev", "#7", 7, { mine: true, hidden: true }),
  ];
  expect(ids(prSections(rows, statusOf, { mine: true }))).toEqual(["open: dev#1", "closed: review#4", "unknown: done#5 dev#3"]);
  expect(ids(prSections(rows, statusOf, { mine: false }))).toEqual(ids(prSections(rows, statusOf)));
  expect(ids(prSections(rows, statusOf))).toEqual(["open: dev#3 dev#2 dev#1", "reviewing: todo#6", "closed: done#5 review#4"]);
});

test("My PRs note: none known to be yours, or no login known at all", () => {
  const mineRow = row("dev", "#1", 1, { mine: true });
  const other = row("dev", "#2", 2, { mine: false });
  const unknown = row("dev", "#3", 3, { mine: null });
  const review = row("todo", "#4", 4, { kind: "review", artifactId: undefined, mine: false });
  expect(mineNote([mineRow, other])).toBeNull();
  expect(mineNote([other])).toBe("none");
  expect(mineNote([other, unknown])).toBe("none");
  expect(mineNote([unknown, review])).toBe("noLogin");
  expect(mineNote([review])).toBe("none");
  expect(mineNote([unknown, row("dev", "#5", 5, { mine: true, hidden: true })])).toBe("noLogin");
  expect(mineNote([])).toBeNull();
});

test("only a row known to be the user's gets the marker; unknown authors never do (D19)", () => {
  expect(isOwnPr(row("t", "#1", 0, { mine: true }))).toBe(true);
  expect(isOwnPr(row("t", "#1", 0, { mine: false }))).toBe(false);
  expect(isOwnPr(row("t", "#1", 0, { mine: null }))).toBe(false);
});

test("the chip shows the yours count after a person icon only when it is above 0 (D20–D22)", () => {
  expect(prChipText(8, 3)).toEqual({ text: "8 PRs", mine: "3 yours", label: "Show 8 pull requests, 3 yours", tooltip: "Show 8 pull requests, 3 yours" });
  expect(prChipText(1, 1)).toEqual({ text: "1 PR", mine: "1 yours", label: "Show 1 pull request, 1 yours", tooltip: "Show 1 pull request, 1 yours" });
  expect(prChipText(8, 0)).toEqual({ text: "8 PRs", mine: null, label: "Show 8 pull requests", tooltip: null });
  expect(prChipText(1, 0)).toEqual({ text: "1 PR", mine: null, label: "Show 1 pull request", tooltip: null });
});

/** D23: the board reads the list on load when it shows a visible PR, so the chip's yours part needs no menu open. */
test("prListRead reads while closed only when the board shows a visible PR", () => {
  expect(prListRead({ open: false, prs: 3 })).toEqual({ enabled: true, refreshOnArrival: true });
  expect(prListRead({ open: false, prs: 0 })).toEqual({ enabled: false, refreshOnArrival: false });
  expect(prListRead({ open: true, prs: 0 })).toEqual({ enabled: true, refreshOnArrival: true });
});
