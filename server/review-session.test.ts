import { expect, test } from "vitest";
import { llmReviewer, parseReviewOutput, reviewPrompt } from "./review-session";
import type { LlmReviewInput } from "./auto-review";

test("review output: lenient JSON, unknown ids and bad entries dropped, one verdict per id, quote kept", () => {
  const text =
    'Here you go:\n```json\n{"items":[{"id":"a","verdict":"fail","detail":"Missing test","file":"x.ts","line":4},{"id":"zzz","verdict":"pass","detail":""},{"id":"b","verdict":"maybe","detail":""},{"id":"a","verdict":"pass","detail":"dup"},{"id":"c","verdict":"na","detail":"n/a","line":0},{"id":"d","verdict":"fail","detail":"No button","quote":" add a Rerun button "}]}\n```';
  expect(parseReviewOutput(text, ["a", "b", "c", "d"])).toEqual([
    { id: "a", verdict: "fail", detail: "Missing test", file: "x.ts", line: 4 },
    { id: "c", verdict: "na", detail: "n/a" },
    { id: "d", verdict: "fail", detail: "No button", quote: "add a Rerun button" },
  ]);
  expect(() => parseReviewOutput("no json here", ["a"])).toThrow(/not JSON/);
  expect(() => parseReviewOutput('{"x":1}', ["a"])).toThrow(/no items list/);
});

const base: LlmReviewInput = {
  task: { id: "t", title: "Add login", description: "Desc", type: "feature", workspaceId: "w" },
  checks: [
    { id: "goal", kind: "goal", text: "The change does what the user asked." },
    { id: "g1", kind: "guideline", text: "Every new UI string is in all catalogs", quote: "新文案也要进所有语言" },
    { id: "i1", kind: "item", text: "Rerun keeps the scroll position", quote: "滚动位置丢了" },
  ],
  acceptance: [{ id: "a", text: "Login works", done: true, by: "agent", at: "x" }],
  deliveryNote: "Done",
  outputs: ["https://pr"],
  commands: ["Tests: passed", "E2E: failed (observing)"],
  diff: "DIFF",
  parentAgentId: "a",
};

test("review prompt carries the card, acceptance list, note, commands, every check with the user's words, the evidence rule and the diff", () => {
  const prompt = reviewPrompt(base);
  for (const part of [
    "Title: Add login",
    "Acceptance list (the agent's own claim, context only)\n- [x] Login works",
    "Delivery note (the agent's own report, context only)\nDone",
    "- https://pr",
    "E2E: failed (observing)",
    "- id: g1\n  kind: project guideline\n  check: Every new UI string is in all catalogs\n  user's words: 新文案也要进所有语言",
    "- id: i1\n  kind: this card's own item",
    "A fail without file or quote is discarded.",
    "## Diff\nDIFF",
    "Read-only",
  ])
    expect(prompt).toContain(part);
  // The project's guidance is gone: the provider loads AGENTS.md / CLAUDE.md itself (GUARDRAILS-SPEC §6.3).
  expect(prompt).not.toContain("Project guidance");
  expect(prompt).not.toContain("rework round");
});

test("round 2 reviews only the changes since the previous delivery and shows each check's previous result (§6.3)", () => {
  const prompt = reviewPrompt({ ...base, incremental: true, checks: [{ ...base.checks[1]!, previous: { state: "failed", detail: "zh-TW missing" } }] });
  expect(prompt).toContain("This is a rework round: the diff holds only what changed since the previous delivery");
  expect(prompt).toContain("previous result: failed — zh-TW missing");
});

test("the built-in check's input: the user's words in order, or a note when they could not be read; nothing without it", () => {
  const said = reviewPrompt({ ...base, conversation: ["Do A.", "A can wait."] });
  expect(said).toContain("## What the user said in this card's sessions (oldest first)\n[1] Do A.\n\n[2] A can wait.");
  expect(reviewPrompt({ ...base, conversation: null })).toContain("(conversation unavailable)");
  expect(reviewPrompt(base)).not.toContain("What the user said");
  // A shared directory: the built-in check is told other cards' changes may be in the diff (§4.2).
  expect(reviewPrompt({ ...base, shared: true })).toContain("may belong to another card");
  expect(reviewPrompt(base)).not.toContain("may belong to another card");
  expect(reviewPrompt({ ...base, shared: true, checks: [base.checks[1]!] })).not.toContain("may belong to another card");
});

test("the reviewer's model: the Review model, else the summary models, never the project's agent model (§6.3)", async () => {
  const tried: string[] = [];
  const paseo = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }, { id: "claude-opus-5-5" }] }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (input: { config: { provider: string } }) => {
            tried.push(input.config.provider);
            return { id: "r", waitForFinish: async () => ({ status: "idle", lastMessage: '{"items":[]}' }) };
          },
        },
      }),
    },
  };
  const review = (reviewModel: string) =>
    llmReviewer({ reviewModel: async () => reviewModel, summaryModels: async () => ["claude/claude-haiku-5-5"], remove: async () => undefined })(base, paseo as never);
  expect((await review("")).model).toBe("claude/claude-haiku-5-5");
  expect((await review("claude/claude-opus-5-5")).model).toBe("claude/claude-opus-5-5");
  expect(tried).toEqual(["claude/claude-haiku-5-5", "claude/claude-opus-5-5"]);
});
