import { describe, expect, it } from "vitest";
import { defaultSessionStartText, sessionFirstMessage, sessionStartMax, sessionStartProblem, sessionStartText, sessionStartValue } from "./session-start";

describe("New session starting text (SESSION-START-TEXT-SPEC)", () => {
  it("opens with the project's text, else the built-in default", () => {
    expect(sessionStartText({})).toBe(defaultSessionStartText);
    expect(defaultSessionStartText).toBe("Read the card and pick up where it left off.");
    expect(sessionStartText({ sessionStartText: "Run the tests first." })).toBe("Run the tests first.");
    expect(sessionStartText({ sessionStartText: "   " })).toBe(defaultSessionStartText);
  });
  it("stores trimmed text and an empty value as none", () => {
    expect(sessionStartValue("  Go on.  ")).toBe("Go on.");
    expect(sessionStartValue("   ")).toBe("");
    expect(sessionStartValue("x".repeat(sessionStartMax + 50))).toHaveLength(sessionStartMax);
  });
  it("sends the typed text, or the card's title and description when the box is empty", () => {
    const task = { title: "Fix login", description: "Users get a blank page." };
    expect(sessionFirstMessage("  Continue.  ", task)).toBe("Continue.");
    expect(sessionFirstMessage("   ", task)).toBe("Fix login\n\nUsers get a blank page.");
    expect(sessionFirstMessage("", { title: "Fix login", description: "  " })).toBe("Fix login");
  });
  it("holds up to 4000 characters (START-PROMPT-TEMPLATE-SPEC §5)", () => {
    expect(sessionStartMax).toBe(4000);
    expect(sessionStartValue("x".repeat(4100))).toHaveLength(4000);
  });
  it("names a template's problem with its line, and nothing for a valid or empty one", () => {
    expect(sessionStartProblem("")).toBe("");
    expect(sessionStartProblem("Plain text.")).toBe("");
    expect(sessionStartProblem("{{#if planApproved}}Run {{plan}}.{{/if}}")).toBe("");
    expect(sessionStartProblem("Hi\n{{#if planApproved}}")).toBe("Unclosed {{#if}} (line 2)");
    expect(sessionStartProblem("\n\n{{titel}}")).toBe('Unknown variable "titel" (line 3)');
  });
});
