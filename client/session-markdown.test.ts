import { expect, test } from "vitest";
import { isInlineUiFence, parseSessionInline, parseSessionMarkdown } from "./session-markdown";

test("tables accept short delimiters, alignment and missing outer pipes", () => {
  const [table] = parseSessionMarkdown(
    "a | b | c\n:-|:-:|-:\n1 | 2 | 3\nx | y\\|z | `p|q`",
  );
  expect(table).toEqual({
    kind: "table",
    headers: ["a", "b", "c"],
    align: ["left", "center", "right"],
    rows: [
      ["1", "2", "3"],
      ["x", "y|z", "`p|q`"],
    ],
  });
});

test("a pipe line with a mismatched delimiter stays a paragraph", () => {
  expect(parseSessionMarkdown("a | b\n--- | --- | ---")[0].kind).toBe("paragraph");
});

test("ui/app fences are detected by first language word, like genui", () => {
  expect(isInlineUiFence("ui")).toBe(true);
  expect(isInlineUiFence("app")).toBe(true);
  expect(isInlineUiFence("UI")).toBe(true);
  expect(isInlineUiFence(" App ")).toBe(true);
  expect(isInlineUiFence("ui demo")).toBe(true);
  expect(isInlineUiFence("")).toBe(false);
  expect(isInlineUiFence("apples")).toBe(false);
  expect(isInlineUiFence("ui-js")).toBe(false);
});

test("a ui fence parses to the code block the notice keys off, closed or streaming", () => {
  expect(parseSessionMarkdown('Here:\n```ui\nCard("Demo", [])')).toEqual([
    { kind: "paragraph", text: "Here:" },
    { kind: "code", language: "ui", text: 'Card("Demo", [])' },
  ]);
  expect(parseSessionMarkdown("~~~APP\n<html>\n~~~")[0]).toEqual({
    kind: "code",
    language: "APP",
    text: "<html>",
  });
});

test("links accept <angle> destinations with spaces, nested parens and titles", () => {
  const link = (text: string) => parseSessionInline(text)[0];
  expect(link("[验收](</Users/a/Search System/docs/D+1.md>)")).toEqual({
    kind: "link",
    text: "验收",
    url: "/Users/a/Search System/docs/D+1.md",
  });
  expect(link("[w](https://x.org/a_(b))").url).toBe("https://x.org/a_(b)");
  expect(link('[t](https://x.org "title")').url).toBe("https://x.org");
});

test("bare and <angle> URLs become links without trailing punctuation", () => {
  expect(parseSessionInline("see https://a.io/x_y_z, then (https://b.io/p).")).toEqual([
    { kind: "text", text: "see " },
    { kind: "link", text: "https://a.io/x_y_z", url: "https://a.io/x_y_z" },
    { kind: "text", text: ", then (" },
    { kind: "link", text: "https://b.io/p", url: "https://b.io/p" },
    { kind: "text", text: ")." },
  ]);
  expect(parseSessionInline("<https://c.io>")[0].url).toBe("https://c.io");
});
