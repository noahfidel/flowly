import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { skillText } from "./skill-source";
import { turnChecklist } from "../shared/turn-checklist";

test("the installed skill source contains the exact live checklist before details", async () => {
  const core = skillText.split("## Start of every turn\n")[1]!.split("## Details")[0]!;
  for (const [index, rule] of turnChecklist.entries())
    expect(core).toContain(`${index + 1}. ${rule}`);
  expect(turnChecklist).toHaveLength(6);
  expect(turnChecklist.join("\n").length).toBeLessThan(1800);
  expect(skillText).not.toContain("before starting a work phase");
  expect(skillText).not.toMatch(/Start of every turn, step \d/);
  expect(await readFile(new URL("../skills/flowly/SKILL.md", import.meta.url), "utf8")).toBe(skillText);
});

test("the skill lets a related change join the card and names the project base, not the main checkout's branch (rulings 2026-11-18)", () => {
  expect(skillText).toContain("A card is one branch and at most one PR: a related change that fits the same PR joins the card (widen its title and description to match; ask the user when unclear); only unrelated work becomes a separate card");
  expect(skillText).not.toContain("Keep one card = one branch or PR; parallel deliverables are separate cards");
  expect(skillText).not.toContain("a new worktree branched off the main checkout's current branch");
  expect(skillText).toContain("a new worktree branched off the project's base branch");
  expect(skillText).toContain("with Auto review off, ship in the same turn once your own checks pass and your review has no open findings");
});

test("the skill names the umbrella block and the [contract] rule", () => {
  expect(skillText).toContain("umbrella block in flowly_get_task");
  expect(skillText).toContain("[contract]");
  expect(skillText).toContain("flowly_add_umbrella_entry");
  expect(skillText).toContain("never edit the brief or the contract");
  expect(skillText).toContain("proposing a change with flowly_propose_contract_change");
});
