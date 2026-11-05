import { expect, test } from "vitest";
import { dollars, roundTokens, runCost, runTokens } from "./ai-cost";

test("a Progress run on Haiku 5.5 costs well under a cent at API prices", () => {
  expect(runTokens("progress")).toBe(55_250);
  expect(roundTokens(runTokens("progress"))).toBe("55K");
  expect(dollars(runCost("progress", "claude/claude-haiku-5-5")!)).toBe("$0.006");
  expect(dollars(runCost("workflow", "claude/claude-sonnet-5-5")!)).toBe("$0.32");
});

test("models without a known price give no cost", () => {
  expect(runCost("progress", "codex/gpt-6-luna")).toBeNull();
  expect(runCost("progress", "claude/some-future-model")).toBeNull();
});

test("dollars keeps one significant digit below a cent and cents above", () => {
  expect(dollars(0.00563)).toBe("$0.006");
  expect(dollars(0.0563)).toBe("$0.056");
  expect(dollars(0.56)).toBe("$0.56");
  expect(dollars(1.126)).toBe("$1.13");
});

test("a quick task title is priced like a short Progress run (QUICK-TASK-SPEC §6)", () => {
  expect(runTokens("quickTitle")).toBeLessThan(runTokens("progress"));
  expect(runCost("quickTitle", "claude/claude-haiku-5-5")).toBeGreaterThan(0);
});
