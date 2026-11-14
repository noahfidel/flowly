import { describe, expect, test } from "vitest";
import { hasLinearItem, linearSkipTypesValue, linearSkipTypesOf, linearTeamValue, linearTicketLines, linearTicketPatch, linearTicketTypeDefault, linearTicketWanted } from "./linear-ticket";
import { taskTypes } from "./model";
import { sessionContext } from "./scope";
import type { Artifact, Project, Task } from "./model";

const artifact = (over: Partial<Artifact>): Artifact =>
  ({ id: "a", taskId: "t", role: "input", kind: "url", target: "https://example.com/x", title: "x", note: "", createdBy: "human", createdAt: "2026-11-05T00:00:00Z", ...over }) as Artifact;
const project = (over: Partial<Project> = {}) => ({ id: "p", title: "P", primaryPath: "/r", repos: ["/r"], ...over }) as Project;

describe("whether a card has a Linear item (LINEAR-TICKET-SPEC §2)", () => {
  test("a Linear connector item or a linear.app link counts", () => {
    expect(hasLinearItem([artifact({ external: { connectionId: "c", provider: "linear", key: "ENG-1", remoteId: "r" } })])).toBe(true);
    expect(hasLinearItem([artifact({ target: "https://linear.app/chord/issue/ENG-12/fix-it" })])).toBe(true);
    expect(hasLinearItem([artifact({ role: "output", target: "https://acme.linear.app/issue/ENG-3" })])).toBe(true);
  });
  test("other trackers, look-alike hosts and files do not", () => {
    expect(hasLinearItem([])).toBe(false);
    expect(hasLinearItem([artifact({ external: { connectionId: "c", provider: "github", key: "o/r#1", remoteId: "r" }, target: "https://github.com/o/r/issues/1" })])).toBe(false);
    expect(hasLinearItem([artifact({ target: "https://notlinear.app/issue/ENG-1" })])).toBe(false);
    expect(hasLinearItem([artifact({ kind: "file", target: "./linear.app.md" })])).toBe(false);
  });
});

describe("the Linear ticket block (LINEAR-TICKET-SPEC §3)", () => {
  const link = { title: "Fix login", canLink: true };
  test("off adds nothing", () => {
    expect(linearTicketLines(project(), [], link)).toEqual([]);
    expect(linearTicketLines(project({ linearTicket: false, linearTeam: "ENG" }), [], link)).toEqual([]);
  });
  test("a card that opted out gets nothing; unset inherits; true cannot turn it on where the project is off (§5)", () => {
    const on = project({ linearTicket: true });
    expect(linearTicketLines(on, [], { ...link, linearTicket: false })).toEqual([]);
    expect(linearTicketLines(on, [], { ...link, linearTicket: undefined }).join("\n")).toMatch(/^Linear ticket:/);
    expect(linearTicketLines(on, [], { ...link, linearTicket: true }).join("\n")).toMatch(/^Linear ticket:/);
    expect(linearTicketLines(project(), [], { ...link, linearTicket: true })).toEqual([]);
  });
  test("on with a ticket linked adds nothing", () => {
    expect(linearTicketLines(project({ linearTicket: true }), [artifact({ target: "https://linear.app/chord/issue/ENG-12" })], link)).toEqual([]);
  });
  test("on without one asks the agent to find, create and link a ticket in the configured team", () => {
    const text = linearTicketLines(project({ linearTicket: true, linearTeam: "Platform" }), [], link).join("\n");
    expect(text).toMatch(/^Linear ticket:/);
    expect(text).toContain("list_issues");
    expect(text).toContain('Linear team "Platform"');
    expect(text).toContain("eng-conventions:linear-tickets");
    expect(text).toContain("flowly_add_artifact role=input");
    expect(text).toContain("first progress report");
    expect(text).toContain("no Linear tools");
    expect(text).not.toContain("ask the user once");
  });
  test("without a team the agent infers it or asks once", () => {
    const text = linearTicketLines(project({ linearTicket: true }), [], link).join("\n");
    expect(text).toContain("ask the user once");
    expect(text).not.toContain('Linear team "');
  });
  test("with agent artifacts off it does not ask to link, and later sessions look for the card's title first", () => {
    const text = linearTicketLines(project({ linearTicket: true }), [], { title: "Fix  login", canLink: false }).join("\n");
    expect(text).not.toContain("flowly_add_artifact");
    expect(text).toContain('starting with its title "Fix login"');
    expect(text).toContain("Reuse it");
    expect(text).toMatch(/1\. Search Linear[\s\S]*2\. If none fits, create one/);
    expect(text).toContain("first progress report");
  });
  test("the block sits after the card's inputs in the session context and never in the description", () => {
    const task = { id: "t", title: "Fix login", description: "Steps", repoPaths: [] } as unknown as Task;
    const lines = linearTicketLines(project({ linearTicket: true }), [], link);
    const ctx = sessionContext(task, project(), [{ repo: "/r", directory: "/r" }], "/r", [], ["Inputs:", "- [user] Doc: ./a.md"], "", [], lines);
    expect(ctx).toContain(`Steps\nInputs:\n- [user] Doc: ./a.md\n${lines.join("\n")}\nProject: P`);
    expect(sessionContext(task, project(), [{ repo: "/r", directory: "/r" }], "/r")).not.toContain("Linear ticket");
  });
});

test("the team value is trimmed, one line and at most 80 characters", () => {
  expect(linearTeamValue("  Platform \n Eng ")).toBe("Platform Eng");
  expect(linearTeamValue("   ")).toBe("");
  expect(linearTeamValue("x".repeat(100))).toHaveLength(80);
});

describe("which cards get the Linear step (LINEAR-TICKET-SPEC §1, §2, §6)", () => {
  const on = project({ linearTicket: true });
  const link = { kind: "url", target: "https://linear.app/chord/issue/ENG-1" } as Artifact;
  test("skip list: absent is research, [] skips none, the stored order follows the card types", () => {
    expect(linearSkipTypesOf(project())).toEqual(["research"]);
    expect(linearSkipTypesOf(project({ linearSkipTypes: [] }))).toEqual([]);
    expect(linearSkipTypesOf(project({ linearSkipTypes: ["chore", "docs"] }))).toEqual(["chore", "docs"]);
    expect(linearSkipTypesValue(["chore", "feature", "chore", "docs", "feature"])).toEqual(["feature", "docs", "chore"]);
    expect(linearSkipTypesValue([])).toEqual([]);
  });
  test("a project with the switch off gives no card the step, whatever its type or field", () => {
    for (const p of [project(), project({ linearTicket: false })])
      for (const type of [...taskTypes, undefined])
        for (const linearTicket of [true, false, undefined]) expect(linearTicketWanted(p, { type, linearTicket }, [])).toBe(false);
    expect(linearTicketTypeDefault(project(), "feature")).toBe(false);
  });
  test("default list: research unset is no, every other type and no type is yes", () => {
    expect(linearTicketWanted(on, { type: "research" }, [])).toBe(false);
    for (const type of ["feature", "bugfix", "refactor", "docs", "chore"] as const) expect(linearTicketWanted(on, { type }, [])).toBe(true);
    expect(linearTicketWanted(on, {}, [])).toBe(true);
    expect(linearTicketWanted(on, { type: null }, [])).toBe(true);
  });
  test("true forces a skipped type on; false turns any type off", () => {
    expect(linearTicketWanted(on, { type: "research", linearTicket: true }, [])).toBe(true);
    for (const type of [...taskTypes, undefined]) expect(linearTicketWanted(on, { type, linearTicket: false }, [])).toBe(false);
  });
  test("a custom list and an empty list", () => {
    const chore = project({ linearTicket: true, linearSkipTypes: ["chore"] });
    expect(linearTicketWanted(chore, { type: "chore" }, [])).toBe(false);
    expect(linearTicketWanted(chore, { type: "research" }, [])).toBe(true);
    expect(linearTicketWanted(chore, { type: "chore", linearTicket: true }, [])).toBe(true);
    const none = project({ linearTicket: true, linearSkipTypes: [] });
    for (const type of taskTypes) expect(linearTicketWanted(none, { type }, [])).toBe(true);
  });
  test("a linked Linear item means no step, even with true", () => {
    expect(linearTicketWanted(on, { type: "feature", linearTicket: true }, [link])).toBe(false);
    expect(linearTicketWanted(on, { type: "feature" }, [link])).toBe(false);
  });
  test("the type default", () => {
    expect(linearTicketTypeDefault(on, "research")).toBe(false);
    expect(linearTicketTypeDefault(on, "feature")).toBe(true);
    expect(linearTicketTypeDefault(on, undefined)).toBe(true);
    expect(linearTicketTypeDefault(on, null)).toBe(true);
    expect(linearTicketTypeDefault(project({ linearTicket: true, linearSkipTypes: [] }), "research")).toBe(true);
  });
  test("the block follows the type", () => {
    const card = { title: "Audit", canLink: true };
    expect(linearTicketLines(on, [], { ...card, type: "research" })).toEqual([]);
    expect(linearTicketLines(on, [], { ...card, type: "feature" }).join("\n")).toMatch(/^Linear ticket:/);
    expect(linearTicketLines(on, [], { ...card, type: "research", linearTicket: true }).join("\n")).toMatch(/^Linear ticket:/);
  });
});

describe("what the card form sends (LINEAR-TICKET-SPEC §5)", () => {
  const on = project({ linearTicket: true });
  test("untouched sends nothing", () => {
    expect(linearTicketPatch(on, { type: "feature", stored: false, choice: null, isNew: false })).toEqual({});
    expect(linearTicketPatch(on, { type: "feature", choice: null, isNew: true })).toEqual({});
  });
  test("a switch ending at the stored value sends nothing", () => {
    expect(linearTicketPatch(on, { type: "feature", stored: true, choice: true, isNew: false })).toEqual({});
    expect(linearTicketPatch(on, { type: "feature", stored: false, choice: false, isNew: false })).toEqual({});
  });
  test("an existing card: back to the type default drops a stored value, otherwise the value is sent", () => {
    expect(linearTicketPatch(on, { type: "feature", stored: false, choice: true, isNew: false })).toEqual({ linearTicket: null });
    expect(linearTicketPatch(on, { type: "feature", choice: true, isNew: false })).toEqual({});
    expect(linearTicketPatch(on, { type: "feature", choice: false, isNew: false })).toEqual({ linearTicket: false });
    expect(linearTicketPatch(on, { type: "research", stored: false, choice: true, isNew: false })).toEqual({ linearTicket: true });
  });
  test("a new card sends a value only when it differs from the type default", () => {
    expect(linearTicketPatch(on, { type: "feature", choice: true, isNew: true })).toEqual({});
    expect(linearTicketPatch(on, { type: "feature", choice: false, isNew: true })).toEqual({ linearTicket: false });
    expect(linearTicketPatch(on, { type: "research", choice: true, isNew: true })).toEqual({ linearTicket: true });
    expect(linearTicketPatch(on, { type: "research", choice: false, isNew: true })).toEqual({});
    expect(linearTicketPatch(on, { type: undefined, choice: false, isNew: true })).toEqual({ linearTicket: false });
  });
});
