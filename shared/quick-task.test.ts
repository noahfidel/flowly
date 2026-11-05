import { describe, expect, test } from "vitest";
import { mergeQuickTitle, parseQuickTitle, provisionalTitle, quickTitlePrompt, QUICK_TITLE_MAX } from "./quick-task";
import type { TaskTag } from "./model";

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
  test("reads title, type and tags", () => {
    expect(parseQuickTitle('{"title":"Fix login","type":"bugfix","tags":["auth","Login Page"]}')).toEqual({
      title: "Fix login",
      type: "bugfix",
      tags: ["auth", "Login Page"],
    });
  });
  test("tolerates a code fence and unknown or missing fields", () => {
    expect(parseQuickTitle('```json\n{"title":" Fix ","type":"nonsense"}\n```')).toEqual({ title: "Fix", type: null, tags: [] });
  });
  test("limits tags to three and the title length", () => {
    const out = parseQuickTitle(JSON.stringify({ title: "t".repeat(300), type: "", tags: ["a", "b", "c", "d"] }));
    expect([...out.title].length).toBeLessThanOrEqual(QUICK_TITLE_MAX + 1);
    expect(out.tags).toEqual(["a", "b", "c"]);
    expect(out.type).toBeNull();
  });
  test("invalid output throws", () => {
    expect(() => parseQuickTitle("not json")).toThrow();
    expect(() => parseQuickTitle(null)).toThrow();
  });
});

describe("mergeQuickTitle (QUICK-TASK-SPEC §4)", () => {
  const at = "2026-11-05T00:00:00.000Z";
  const card = (over: Partial<{ title: string; type: "feature"; tags: TaskTag[]; status: "todo" | "done"; archivedAt: string | null }> = {}) => ({
    title: "Fix the login bug",
    tags: [] as TaskTag[],
    status: "todo" as const,
    archivedAt: null,
    ...over,
  });
  const suggestion = { title: "Fix login redirect loop", type: "bugfix" as const, tags: ["auth", "Login Page", "bad tag!"] };

  test("applies title, type and agent tags to an untouched card", () => {
    const merged = mergeQuickTitle(card(), "Fix the login bug", suggestion, at);
    expect(merged).toEqual({
      title: "Fix login redirect loop",
      type: "bugfix",
      tags: [
        { tag: "auth", by: "agent", at },
        { tag: "login-page", by: "agent", at },
      ],
      addedTags: ["auth", "login-page"],
    });
  });
  test("never overwrites a title the user edited", () => {
    const merged = mergeQuickTitle(card({ title: "My own title" }), "Fix the login bug", suggestion, at);
    expect(merged?.title).toBeUndefined();
    expect(merged?.type).toBe("bugfix");
  });
  test("never overrides a type that is set", () => {
    const merged = mergeQuickTitle(card({ type: "feature" }), "Fix the login bug", suggestion, at);
    expect(merged?.type).toBeUndefined();
  });
  test("keeps existing tags and their origin, adds only new ones", () => {
    const human: TaskTag = { tag: "auth", by: "human", at };
    const merged = mergeQuickTitle(card({ tags: [human] }), "Fix the login bug", suggestion, at);
    expect(merged?.tags).toEqual([human, { tag: "login-page", by: "agent", at }]);
    expect(merged?.addedTags).toEqual(["login-page"]);
  });
  test("stops at the card's tag limit", () => {
    const full = Array.from({ length: 11 }, (_, i): TaskTag => ({ tag: `t${i}`, by: "human", at }));
    const merged = mergeQuickTitle(card({ tags: full }), "Fix the login bug", suggestion, at);
    expect(merged?.addedTags).toEqual(["auth"]);
    expect(merged?.tags).toHaveLength(12);
  });
  test("nothing to change returns null", () => {
    expect(mergeQuickTitle(card({ title: "Mine", type: "feature" }), "Fix the login bug", { title: "x", type: "bugfix", tags: [] }, at)).toBeNull();
    expect(mergeQuickTitle(card(), "Fix the login bug", { title: "Fix the login bug", type: null, tags: [] }, at)).toBeNull();
    expect(mergeQuickTitle(card(), "Fix the login bug", { title: "", type: null, tags: [] }, at)).toBeNull();
  });
  test("finished or archived cards are left alone", () => {
    expect(mergeQuickTitle(card({ status: "done" }), "Fix the login bug", suggestion, at)).toBeNull();
    expect(mergeQuickTitle(card({ archivedAt: at }), "Fix the login bug", suggestion, at)).toBeNull();
  });
});

test("quickTitlePrompt names the text, types, tags and language", () => {
  const prompt = quickTitlePrompt({ text: "Make the login page faster", tags: ["auth", "perf"], language: "en" });
  expect(prompt).toContain("Make the login page faster");
  expect(prompt).toContain("bugfix");
  expect(prompt).toContain("auth, perf");
  const long = quickTitlePrompt({ text: "z".repeat(10_000), tags: [], language: "en" });
  expect(long.length).toBeLessThan(6_000);
});
