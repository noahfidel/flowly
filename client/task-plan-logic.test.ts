import { describe, expect, test } from "vitest";
import { artifactSaveSteps, formRoles, initialFormRole, planAwareDefaults, planChoiceAllowed } from "./task-plan-logic";

const plan = { approvedAt: "2026-11-10T10:00:00.000Z", approvedBy: { kind: "human" as const }, source: "manual" as const, setAt: "2026-11-10T10:00:00.000Z" };
const input = { role: "input" as const };
const output = { role: "output" as const };

describe("artifact form role (CARD-PLAN-SPEC §2.2)", () => {
  test("Set plan and Replace… open with Plan chosen", () => {
    expect(initialFormRole(null, "plan")).toBe("plan");
    expect(initialFormRole(output, "plan")).toBe("plan");
  });
  test("Set plan and Replace… offer only Plan; other forms offer all three", () => {
    expect(formRoles(null, "plan")).toEqual(["plan"]);
    expect(formRoles(null)).toEqual(["input", "output", "plan"]);
    expect(formRoles(input)).toEqual(["input", "output", "plan"]);
  });
  test("the plan artifact opens as Plan; others keep their role; a new one is an Input", () => {
    expect(initialFormRole({ ...input, plan })).toBe("plan");
    expect(initialFormRole(output)).toBe("output");
    expect(initialFormRole(null)).toBe("input");
  });
  test("review ledgers and external items are never offered as the plan", () => {
    expect(planChoiceAllowed(null)).toBe(true);
    expect(planChoiceAllowed(input)).toBe(true);
    expect(planChoiceAllowed({ ...output, origin: "review-ledger" })).toBe(false);
    expect(formRoles({ ...output, origin: "review-ledger" })).toEqual(["input", "output"]);
    expect(planChoiceAllowed({ ...input, external: { provider: "jira", key: "A-1" } as never })).toBe(false);
  });
});

describe("saving the artifact form (CARD-PLAN-SPEC §2.2)", () => {
  test("adding: Input or Output creates; Plan sets the plan, then saves a note", () => {
    expect(artifactSaveSteps(null, "input", "")).toEqual(["create"]);
    expect(artifactSaveSteps(null, "output", "x")).toEqual(["create"]);
    expect(artifactSaveSteps(null, "plan", "")).toEqual(["plan-set"]);
    expect(artifactSaveSteps(null, "plan", " why ")).toEqual(["plan-set", "update"]);
  });
  test("editing an artifact to Plan saves it, then makes it the plan", () => {
    expect(artifactSaveSteps({}, "plan", "")).toEqual(["update", "plan-set"]);
    expect(artifactSaveSteps({}, "input", "")).toEqual(["update"]);
  });
  test("the plan artifact stays the plan, or is updated first and its slot cleared when made an Input or Output", () => {
    expect(artifactSaveSteps({ plan }, "plan", "")).toEqual(["update"]);
    expect(artifactSaveSteps({ plan }, "input", "")).toEqual(["update", "plan-clear"]);
    expect(artifactSaveSteps({ plan }, "output", "")).toEqual(["update", "plan-clear"]);
  });
});

describe("Start session defaults with a plan (CARD-PLAN-SPEC §6.2)", () => {
  const claudePlan = { provider: "claude", model: "opus", mode: "plan" };
  test("an approved plan turns a default Plan mode into the provider's suggestion", () => {
    expect(planAwareDefaults(claudePlan, true)).toEqual({ ...claudePlan, mode: "auto" });
    expect(planAwareDefaults({ ...claudePlan, provider: "codex" }, true)?.mode).toBe("auto-review");
    // No built-in suggestion: unset, so the picker suggests one.
    expect(planAwareDefaults({ ...claudePlan, provider: "opencode" }, true)?.mode).toBe("");
  });
  test("no approved plan, or another default mode, leaves the defaults as they are", () => {
    expect(planAwareDefaults(claudePlan, false)).toBe(claudePlan);
    const edits = { ...claudePlan, mode: "acceptEdits" };
    expect(planAwareDefaults(edits, true)).toBe(edits);
    expect(planAwareDefaults(null, true)).toBeNull();
    expect(planAwareDefaults(undefined, true)).toBeUndefined();
  });
});
