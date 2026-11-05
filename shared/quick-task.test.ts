import { describe, expect, test } from "vitest";
import { mergeQuickTitle, parseQuickTitle, provisionalTitle, quickTitlePrompt, quickTitleText, QUICK_TEXT_MAX, QUICK_TITLE_MAX } from "./quick-task";
import { quickTaskTitle } from "./rpc";

describe("provisionalTitle (QUICK-TASK-SPEC §2)", () => {
  test("first non-empty line, whitespace collapsed", () => {
    expect(provisionalTitle("\n\n  Fix   the login   bug \nmore detail here")).toBe("Fix the login bug");
  });
  test("leading Markdown markers are removed", () => {
    expect(provisionalTitle("# Add dark mode")).toBe("Add dark mode");
    expect(provisionalTitle("- [ ] write docs")).toBe("[ ] write docs");
    expect(provisionalTitle("> 1. Rename the API")).toBe("Rename the API");
    expect(provisionalTitle("* bullet")).toBe("bullet");
  });
  test("a long line is cut at a word boundary with an ellipsis", () => {
    const text = "Refactor the session pane so that the transcript and the composer share one keyboard avoidance hook everywhere";
    const title = provisionalTitle(text);
    expect([...title].length).toBeLessThanOrEqual(QUICK_TITLE_MAX + 1);
    expect(title.endsWith("…")).toBe(true);
    expect(text.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(" ")).toBe(false);
    expect(text[title.length - 1]).toBe(" ");
  });
  test("text without spaces is cut hard", () => {
    const title = provisionalTitle("x".repeat(200));
    expect(title).toBe(`${"x".repeat(QUICK_TITLE_MAX)}…`);
  });
  test("a word boundary too early is ignored", () => {
    const title = provisionalTitle(`ab ${"y".repeat(150)}`);
    expect(title).toBe(`${`ab ${"y".repeat(150)}`.slice(0, QUICK_TITLE_MAX)}…`);
  });
  test("short text and empty text", () => {
    expect(provisionalTitle("Short")).toBe("Short");
    expect(provisionalTitle("   \n ")).toBe("");
    expect(provisionalTitle("#")).toBe("#");
  });
});

describe("parseQuickTitle", () => {
  test("reads the title only", () => {
    expect(parseQuickTitle('{"title":"Fix login","type":"bugfix","tags":["auth"]}')).toEqual({ title: "Fix login" });
  });
  test("tolerates a code fence and a missing title", () => {
    expect(parseQuickTitle('```json\n{"title":" Fix "}\n```')).toEqual({ title: "Fix" });
    expect(parseQuickTitle("{}")).toEqual({ title: "" });
  });
  test("limits the title length", () => {
    const out = parseQuickTitle(JSON.stringify({ title: "t".repeat(300) }));
    expect([...out.title].length).toBeLessThanOrEqual(QUICK_TITLE_MAX + 1);
  });
  test("invalid output throws", () => {
    expect(() => parseQuickTitle("not json")).toThrow();
    expect(() => parseQuickTitle(null)).toThrow();
  });
});

describe("mergeQuickTitle (QUICK-TASK-SPEC §4)", () => {
  const card = (over: Partial<{ title: string; status: "todo" | "done"; archivedAt: string | null }> = {}) => ({
    title: "Fix the login bug",
    status: "todo" as const,
    archivedAt: null,
    ...over,
  });
  const suggestion = { title: "Fix login redirect loop" };

  test("sets the title of an untouched card, and nothing else", () => {
    expect(mergeQuickTitle(card(), "Fix the login bug", suggestion)).toEqual({ title: "Fix login redirect loop" });
  });
  test("never overwrites a title the user edited", () => {
    expect(mergeQuickTitle(card({ title: "My own title" }), "Fix the login bug", suggestion)).toBeNull();
  });
  test("an empty or identical suggestion changes nothing", () => {
    expect(mergeQuickTitle(card(), "Fix the login bug", { title: "Fix the login bug" })).toBeNull();
    expect(mergeQuickTitle(card(), "Fix the login bug", { title: "" })).toBeNull();
  });
  test("finished or archived cards are left alone", () => {
    expect(mergeQuickTitle(card({ status: "done" }), "Fix the login bug", suggestion)).toBeNull();
    expect(mergeQuickTitle(card({ archivedAt: "2026-11-05T00:00:00.000Z" }), "Fix the login bug", suggestion)).toBeNull();
  });
});

test("quickTitlePrompt asks for a title only, in the output language", () => {
  const prompt = quickTitlePrompt({ text: "Make the login page faster", language: "en" });
  expect(prompt).toContain("Make the login page faster");
  expect(prompt).toContain('{"title": ...}');
  expect(prompt).not.toMatch(/bugfix|tags/);
  const long = quickTitlePrompt({ text: "z".repeat(10_000), language: "en" });
  expect(long.length).toBeLessThan(6_000);
});

test("quickTitleText keeps at most QUICK_TEXT_MAX characters, so a long paste still fits the RPC (§4)", () => {
  expect(quickTitleText("short")).toBe("short");
  const long = quickTitleText("😀".repeat(30_000));
  expect([...long]).toHaveLength(QUICK_TEXT_MAX);
  // tasks.quick-title accepts at most 20,000 UTF-16 units; 4,000 characters never exceed it.
  expect(quickTaskTitle.input.safeParse({ taskId: "t", text: long, provisionalTitle: "x" }).success).toBe(true);
});
