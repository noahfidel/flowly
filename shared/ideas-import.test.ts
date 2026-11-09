import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { importDuplicateReason, importOutcome, importRowSchema, importTitleLimit, parseBacklog } from "./ideas-import";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "backlogs", name), "utf8");
const itemLines = (markdown: string) => markdown.split("\n").filter((l) => /^- \[[ x]\] /.test(l));
const row = (markdown: string) => parseBacklog(markdown)[0]!;

test("the recipes backlog parses to one row per item", () => {
  for (const name of ["recipes.md", "meal-planner.md", "shopping.md"]) {
    const markdown = fixture(name);
    expect(parseBacklog(markdown)).toHaveLength(itemLines(markdown).length);
  }
});

test("header and prose lines are skipped", () => {
  const markdown = fixture("recipes.md");
  const prose = markdown.split("\n")[2]!;
  expect(prose).toMatch(/^Notes for later/);
  const rows = parseBacklog(markdown);
  expect(rows.some((r) => r.title.startsWith("#"))).toBe(false);
  expect(rows.some((r) => r.title === prose || r.detail.includes(prose))).toBe(false);
  expect(rows[0]!.line).toBe(5);
  expect(rows[0]!.title.startsWith("Scale ingredient quantities")).toBe(true);
});

test("the added suffix becomes the source note", () => {
  const r = row("- [ ] Fix X (added 2026-10-20, kanban/fix-x)\n");
  expect(r.title).toBe("Fix X");
  expect(r.source).toBe("added 2026-10-20, kanban/fix-x");
  expect(r).toMatchObject({ detail: "", done: false, keep: true, line: 1 });
});

test("every source shape of the real files is recognized", () => {
  const source = (text: string) => row(`- [ ] ${text}\n`).source;
  expect(source("A (added 2026-10-18)")).toBe("added 2026-10-18");
  expect(source("A (added 11/03/26, some-branch)")).toBe("added 11/03/26, some-branch");
  expect(source("A (started 2026-10-21; added 2026-10-20, some-branch)")).toBe("started 2026-10-21; added 2026-10-20, some-branch");
  expect(source("A (pre-existing, added 2026-10-29, search review)")).toBe("pre-existing, added 2026-10-29, search review");
  expect(source("A (added 2026-10-21; built 2026-10-22 then removed, a branch)")).toBe("added 2026-10-21; built 2026-10-22 then removed, a branch");
  expect(source("A (added 2026-10-22, rescoped 03/04/26)")).toBe("added 2026-10-22, rescoped 03/04/26");
  expect(source("A (added 2026-10-19, issue list; in docs/cleanup.md)")).toBe("added 2026-10-19, issue list; in docs/cleanup.md");
  // The first part is never read as a branch name: the source is one opaque note.
  expect(row("- [ ] A (added 2026-10-20, kanban/fix-x)\n").title).not.toContain("kanban");
});

test("a title's own parentheses stay, and only the last added-style note is the source", () => {
  const r = row("- [ ] Call `fetch(2)` once per batch (the default size) now (added 2026-10-20, branch-a)\n");
  expect(r.title).toBe("Call `fetch(2)` once per batch (the default size) now");
  expect(r.source).toBe("added 2026-10-20, branch-a");
  const none = row("- [ ] Rename the badge (blue variant, `compact` size only, 2026-10-22) in the header\n");
  expect(none.source).toBeNull();
  expect(none.title).toBe("Rename the badge (blue variant, `compact` size only, 2026-10-22) in the header");
  // Parentheses inside a code span do not confuse the scan.
  const code = row("- [ ] Handle the `(` token (added 2026-10-20)\n");
  expect(code).toMatchObject({ title: "Handle the `(` token", source: "added 2026-10-20" });
});

test("a mid-line added note followed by prose keeps the prose in the title", () => {
  const r = row("- [ ] Cleanup items (added 2026-10-27, tidy-up): (a) drop the old flag; (b) rename `cache_key`.\n");
  expect(r.source).toBe("added 2026-10-27, tidy-up");
  expect(r.title).toBe("Cleanup items: (a) drop the old flag; (b) rename `cache_key`.");
  const fixtureRow = parseBacklog(fixture("recipes.md")).find((x) => x.title.startsWith("Pantry page minors"))!;
  expect(fixtureRow.title).toBe("Pantry page minors: expiry colors, empty text, and the sort label (a) soonest (b) alphabetical");
  expect(fixtureRow.source).toBe("added 2026-04-05, pantry");
});

test("titles with colons, backticks and prefixes are kept as written", () => {
  const rows = parseBacklog(fixture("recipes.md"));
  expect(rows.some((r) => r.title.startsWith("SECURITY: the public profile page"))).toBe(true);
  expect(rows.some((r) => r.title.startsWith("URGENT: saving a recipe"))).toBe(true);
  expect(rows.find((r) => r.title.startsWith("Unit conversion"))!.title).toContain('`to_ml(1/3, "cup")`');
});

test("titles over 120 characters are cut at a word and the full text kept in detail", () => {
  const rows = parseBacklog(fixture("recipes.md"));
  const long = rows.find((r) => r.title.startsWith("Let people reorder the steps"))!;
  const fullText = "Let people reorder the steps of a recipe by dragging, keep the numbering in sync, announce the move to screen readers, and undo it with one tap";
  expect(importTitleLimit).toBe(120);
  expect(long.title.length).toBeLessThanOrEqual(120);
  expect(long.title.endsWith("…")).toBe(true);
  // Cut on a word boundary: what precedes the ellipsis is a whole-word prefix of the text.
  const kept = long.title.slice(0, -1);
  expect(fullText.startsWith(kept)).toBe(true);
  // The cut leaves no trailing comma: what follows the kept text is a space or the punctuation before one.
  expect(fullText.slice(kept.length)).toMatch(/^[,;:]? /);
  expect(long.detail.startsWith(fullText)).toBe(true);
  expect(long.detail).toContain("(added 2026-04-09, reorder)");
  expect(long.detail).toContain("- Keep the existing step ids: other pages link to them.");
  // A long title with no added note still keeps the whole line.
  const infra = parseBacklog(fixture("meal-planner.md")).find((r) => r.title.startsWith("Copying a day"))!;
  expect(infra.title.length).toBeLessThanOrEqual(120);
  expect(infra.source).toBeNull();
  expect(infra.detail.startsWith("Copying a day keeps the old notes: should they move too, or stay on the original? The plan export (week of 2026-04-13, `.ics` only)")).toBe(true);
  expect(infra.detail.endsWith("- Needs a decision from the product owner.")).toBe(true);
});

test("a title of exactly 120 characters is not cut", () => {
  const text = "x".repeat(120);
  expect(row(`- [ ] ${text}\n`)).toMatchObject({ title: text, detail: "" });
  expect(row(`- [ ] ${text}y\n`).title.length).toBeLessThanOrEqual(120);
  // No space to cut at: hard cut.
  expect(row(`- [ ] ${"y".repeat(300)}\n`).title).toBe(`${"y".repeat(119)}…`);
});

test("indented notes join the detail", () => {
  const rows = parseBacklog(fixture("recipes.md"));
  const none = rows.find((r) => r.title.startsWith("Make the empty state friendlier"))!;
  expect(none.detail).toBe("");
  expect(none.source).toBeNull();
  const one = rows.find((r) => r.title.startsWith("URGENT"))!;
  expect(one.detail).toBe("");
  const single = rows.find((r) => r.title.startsWith("Photo upload:"))!;
  expect(single.detail).toBe("- Likely the `onProgress` callback fires before the resize finishes.");
  expect(single.source).toBe("started 2026-04-06; added 2026-04-04, upload-ring");
  // A cut title keeps its whole line first, then the notes.
  const cut = rows.find((r) => r.title.startsWith("Let people reorder the steps"))!;
  expect(cut.title.endsWith("…")).toBe(true);
  expect(cut.detail.split("\n")).toEqual([
    expect.stringMatching(/^Let people reorder the steps .* \(added 2026-04-09, reorder\)$/),
    "- Keep the existing step ids: other pages link to them.",
  ]);
  const several = rows.find((r) => r.title.startsWith("Scale ingredient quantities"))!;
  expect(several.detail.split("\n")).toEqual([
    "- Fractions such as 1/3 and 3/4 should stay fractions, not turn into decimals.",
    '- Decide what to do with "a pinch" and "to taste".',
    "- The stepper lives in the header: 1 to 24, defaulting to the recipe's own count.",
  ]);
  // A note after a blank line or another item belongs to its own item only.
  const after = rows.find((r) => r.title.startsWith("Write a short guide"))!;
  expect(after.detail).toBe("- Mention that `units.py` keeps ratios, not formulas.");
});

test("nested or unindented lines under an item do not become rows", () => {
  const rows = parseBacklog("- [ ] One\n  - note a\n    - deeper\n  plain continuation\n- [ ] Two\n- not an item\n  - orphan\n");
  expect(rows.map((r) => r.title)).toEqual(["One", "Two"]);
  expect(rows[0]!.detail).toBe("- note a");
  expect(rows[1]!.detail).toBe("");
});

test("[x] lines are listed and not kept by default", () => {
  const rows = parseBacklog("- [x] Shipped thing (added 2026-10-01, a-branch)\n- [ ] Open thing\n");
  expect(rows.map((r) => ({ title: r.title, done: r.done, keep: r.keep }))).toEqual([
    { title: "Shipped thing", done: true, keep: false },
    { title: "Open thing", done: false, keep: true },
  ]);
});

test("a done item in the fixture keeps its note and is not kept", () => {
  const shipped = parseBacklog(fixture("recipes.md")).find((r) => r.title.startsWith("Print view cuts off"))!;
  expect(shipped).toMatchObject({ done: true, keep: false, source: "added 2026-03-28, print-fix", detail: "" });
});

test("long notes and long original text are cut to fit with an ellipsis, so every row passes the row schema", () => {
  const notes = Array.from({ length: 200 }, (_, i) => `  - note number ${i} with some padding text`).join("\n");
  const many = row(`- [ ] Many notes\n${notes}\n`);
  expect(many.detail.length).toBe(4000);
  expect(many.detail.endsWith("…")).toBe(true);
  expect(many.detail.startsWith("- note number 0 with some padding text\n- note number 1")).toBe(true);
  expect(importRowSchema.safeParse(many).success).toBe(true);
  const huge = row(`- [ ] ${"word ".repeat(1500)}(added 2026-10-20, a-branch)\n  - a note\n`);
  expect(huge.title.length).toBeLessThanOrEqual(120);
  expect(huge.detail.length).toBeLessThanOrEqual(4000);
  expect(huge.detail.endsWith("…")).toBe(true);
  expect(huge.detail.startsWith("word word")).toBe(true);
  expect(importRowSchema.safeParse(huge).success).toBe(true);
  const longSource = row(`- [ ] Item (added 2026-10-20, ${"x".repeat(1200)})\n`);
  expect(longSource.source!.length).toBe(1000);
  expect(importRowSchema.safeParse(longSource).success).toBe(true);
});

test("an import result of only duplicates reads as already imported", () => {
  const dup = { reason: importDuplicateReason };
  expect(importOutcome({ created: 2, skipped: [dup] })).toBe("created");
  expect(importOutcome({ created: 0, skipped: [dup, dup] })).toBe("already");
  expect(importOutcome({ created: 0, skipped: [dup, { reason: "Too long." }] })).toBe("skipped");
  expect(importOutcome({ created: 0, skipped: [] })).toBe("skipped");
});

test("Windows line endings and an empty file are handled", () => {
  expect(parseBacklog("# t\r\n\r\n- [ ] One (added 2026-10-20)\r\n  - note\r\n")[0]).toMatchObject({ title: "One", source: "added 2026-10-20", detail: "- note" });
  expect(parseBacklog("")).toEqual([]);
  expect(parseBacklog("# only a header\n\nSome prose.\n")).toEqual([]);
});

test("an item that is only a note keeps its text as the title", () => {
  expect(row("- [ ] (added 2026-10-20, a-branch)\n")).toMatchObject({ title: "(added 2026-10-20, a-branch)", source: null });
});

describe("the real backlog files", () => {
  const dir = process.env.FLOWLY_BACKLOG_DIR ?? join(homedir(), ".claude", "backlogs");
  test.skipIf(!existsSync(dir))("parse to one short-titled row per item", () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      const markdown = readFileSync(join(dir, name), "utf8");
      const rows = parseBacklog(markdown);
      expect(rows, name).toHaveLength(itemLines(markdown).length);
      for (const r of rows) {
        expect(r.title.length, `${name}:${r.line}`).toBeLessThanOrEqual(120);
        expect(r.title.startsWith("#"), `${name}:${r.line}`).toBe(false);
        expect(r.title.length, `${name}:${r.line}`).toBeGreaterThan(0);
      }
    }
  });
});
