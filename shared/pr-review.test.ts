import { describe, expect, it } from "vitest";
import { parsePrReviewLabel, prReviewCard, prReviewCardKey, prReviewCardUrl } from "./pr-review";

const card = (description: string, prRef?: string, operationId = "pr-review:a1") => ({ description, prRef, operationId });
const url = "https://github.com/Zenlytic/zenlytic/pull/9164";

describe("prReviewCardUrl", () => {
  it("builds the URL from the stored prRef", () => {
    expect(prReviewCardUrl(card("whatever", "zenlytic/zenlytic#9164"))).toBe("https://github.com/zenlytic/zenlytic/pull/9164");
  });
  it("prefers the original-case URL of the description when it is the same PR", () => {
    expect(prReviewCardUrl(card(`PR: [Zenlytic/zenlytic#9164](${url})`, "zenlytic/zenlytic#9164"))).toBe(url);
  });
  it("ignores a description URL of another PR when prRef is stored", () => {
    expect(prReviewCardUrl(card(`PR: [a/b#1](https://github.com/a/b/pull/1)`, "x/y#2"))).toBe("https://github.com/x/y/pull/2");
  });
  it("reads the old format", () => {
    expect(prReviewCardUrl(card(`PR: Zenlytic/zenlytic#9164 (${url})\n\nx`))).toBe(url);
  });
  it("reads the new markdown format", () => {
    expect(prReviewCardUrl(card(`PR: [Zenlytic/zenlytic#9164](${url})\n\nx`))).toBe(url);
  });
  it("reads the bare format", () => {
    expect(prReviewCardUrl(card("PR: Zenlytic/zenlytic#9164"))).toBe(url.toLowerCase());
  });
  it("is null for a loose label", () => {
    expect(prReviewCardUrl(card("PR: some text"))).toBeNull();
  });
  it("is null for a card that is not a PR review card", () => {
    expect(prReviewCardUrl(card("PR: Zenlytic/zenlytic#9164", "zenlytic/zenlytic#9164", "op-1"))).toBeNull();
  });
});

describe("prReviewCard description", () => {
  it("links the PR in markdown and round-trips through the parser", () => {
    const { description } = prReviewCard(parsePrReviewLabel("Zenlytic/zenlytic#9164")!, "t");
    expect(description.split("\n")[0]).toBe(`PR: [Zenlytic/zenlytic#9164](${url})`);
    expect(prReviewCardKey({ description })).toBe("zenlytic/zenlytic#9164");
  });
  it("keeps a loose label as plain text with no key", () => {
    const { description } = prReviewCard(parsePrReviewLabel("some text")!, "t");
    expect(description.split("\n")[0]).toBe("PR: some text");
    expect(prReviewCardKey({ description })).toBeNull();
  });
  it("still matches old and bare descriptions", () => {
    expect(prReviewCardKey({ description: `PR: Zenlytic/zenlytic#9164 (${url})` })).toBe("zenlytic/zenlytic#9164");
    expect(prReviewCardKey({ description: "x\nPR: Zenlytic/zenlytic#9164" })).toBe("zenlytic/zenlytic#9164");
  });
});
