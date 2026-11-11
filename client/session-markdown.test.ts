import { expect, test } from "vitest";
import { cardLink, isInlineUiFence, linkBareCardIds, parseSessionInline, parseSessionMarkdown } from "./session-markdown";
import { cardChipState } from "./card-links";

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

const P = "11111111-1111-4111-8111-111111111111", T = "22222222-2222-4222-8222-222222222222";

test("cardLink accepts only strict flowly card links", () => {
  expect(cardLink(`flowly://card/${P}/${T}`)).toEqual({ projectId: P, taskId: T });
  expect(cardLink(`flowly://card/${P.toUpperCase()}/${T.toUpperCase()}`)).toEqual({ projectId: P.toUpperCase(), taskId: T.toUpperCase() });
  expect(cardLink(`https://card/${P}/${T}`)).toBeNull();
  expect(cardLink(`flowly://card/${P}/${T}/extra`)).toBeNull();
  expect(cardLink(`flowly://card/${P}/not-a-uuid`)).toBeNull();
  expect(cardLink(`flowly://card/${P}`)).toBeNull();
  expect(cardLink(undefined)).toBeNull();
});

test("a markdown card link parses to a link part with its card", () => {
  const [part] = parseSessionInline(`[Fix it](flowly://card/${P}/${T})`);
  expect(part).toMatchObject({ kind: "link", text: "Fix it", card: { projectId: P, taskId: T } });
  expect(parseSessionInline("[x](flowly://card/1/2)")[0].card).toBeUndefined();
});

test("linkBareCardIds links only ids the board knows, in plain text", () => {
  const known = (id: string) => id === T;
  expect(linkBareCardIds(parseSessionInline(`see [${T}] now`), known)).toEqual([
    { kind: "text", text: "see [" },
    { kind: "link", text: T, card: { taskId: T } },
    { kind: "text", text: "] now" },
  ]);
  expect(linkBareCardIds(parseSessionInline(`see ${P}`), known)).toEqual([{ kind: "text", text: `see ${P}` }]);
  expect(linkBareCardIds(parseSessionInline(`\`${T}\``), known)).toEqual([{ kind: "code", text: T }]);
  const linked = parseSessionInline(`[${T}](https://example.com)`);
  expect(linkBareCardIds(linked, known)).toEqual(linked);
});

test("card chip state: open, archived, project archived, missing", () => {
  expect(cardChipState({ title: "a", archived: false, openable: true })).toBe("open");
  expect(cardChipState({ title: "a", archived: true, openable: true })).toBe("archived");
  expect(cardChipState({ title: "a", archived: true, openable: false })).toBe("project-archived");
  expect(cardChipState(null)).toBe("missing");
});
