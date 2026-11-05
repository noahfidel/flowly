import { describe, expect, test } from "vitest";
import { hasLinearItem, linearTeamValue, linearTicketLines } from "./linear-ticket";
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
  test("off adds nothing", () => {
    expect(linearTicketLines(project(), [])).toEqual([]);
    expect(linearTicketLines(project({ linearTicket: false, linearTeam: "ENG" }), [])).toEqual([]);
  });
  test("on with a ticket linked adds nothing", () => {
    expect(linearTicketLines(project({ linearTicket: true }), [artifact({ target: "https://linear.app/chord/issue/ENG-12" })])).toEqual([]);
  });
  test("on without one asks the agent to find, create and link a ticket in the configured team", () => {
    const text = linearTicketLines(project({ linearTicket: true, linearTeam: "Platform" }), []).join("\n");
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
    const text = linearTicketLines(project({ linearTicket: true }), []).join("\n");
    expect(text).toContain("ask the user once");
    expect(text).not.toContain('Linear team "');
  });
  test("the block sits after the card's inputs in the session context and never in the description", () => {
    const task = { id: "t", title: "Fix login", description: "Steps", repoPaths: [] } as unknown as Task;
    const lines = linearTicketLines(project({ linearTicket: true }), []);
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
