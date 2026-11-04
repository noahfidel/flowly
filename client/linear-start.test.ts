import { describe, expect, test } from "vitest";
import type { ExternalSummary } from "../shared/connectors";
import { firstMessage } from "./first-message";
import { linearOpenParams, linearSeed, linearStartParams, parseLinearOpen, parseLinearStart, startProject } from "./linear-start";
import { parseIdeaLink, parseSessionLink } from "./session-link";

const issue: ExternalSummary = {
  connectionId: "c1",
  itemType: "issue",
  key: "ENG-42",
  remoteId: "uuid-eng-42",
  url: "https://linear.app/acme/issue/ENG-42/login",
  summary: "Login retry loops",
  status: "Todo",
  statusCategory: "new",
  type: "",
  priority: "High",
  assignee: "Ada",
  container: "Engineering",
  updated: "2026-11-01T00:00:00.000Z",
};

describe("Start card / Open card links (LINEAR-BOARD-SPEC §5)", () => {
  test("a Start card link round-trips and is not a session or idea link", () => {
    const params = linearStartParams({ connectionId: "c1", key: "ENG-42" }, "r1");
    expect(params).toEqual({ linearIssue: "ENG-42", connectionId: "c1", requestId: "r1" });
    expect(parseLinearStart(params)).toEqual({ key: "ENG-42", connectionId: "c1", requestId: "r1" });
    expect(parseSessionLink(params)).toBeNull();
    expect(parseIdeaLink(params)).toBeNull();
    expect(parseLinearStart(undefined)).toBeNull();
    expect(parseLinearStart({ taskId: "t" })).toBeNull();
    expect(() => parseLinearStart({ linearIssue: "ENG-42" })).toThrow(/Start card/);
  });

  test("an Open card link round-trips and is not a session link", () => {
    const params = linearOpenParams({ taskId: "t1", projectId: "p1", workspaceId: "w1", title: "Card" }, "r2");
    expect(params).toEqual({ openTaskId: "t1", projectId: "p1", workspaceId: "w1", requestId: "r2" });
    expect(parseLinearOpen(params)).toEqual({ taskId: "t1", projectId: "p1", workspaceId: "w1", requestId: "r2" });
    expect(parseSessionLink(params)).toBeNull();
    expect(parseIdeaLink(params)).toBeNull();
    expect(parseLinearOpen({ linearIssue: "ENG-1", connectionId: "c", requestId: "r" })).toBeNull();
    expect(() => parseLinearOpen({ openTaskId: "t1" })).toThrow(/Open card/);
  });
});

describe("Start card prefill (LINEAR-BOARD-SPEC §5)", () => {
  test("the issue is attached, the title comes from it, the agent starts, and no instruction is needed", () => {
    const seed = linearSeed(issue);
    expect(seed).toEqual({ title: "Login retry loops", description: "", externals: [{ item: issue, provider: "linear" }], startAgent: true });
    // The form's Create waits for an instruction only without attached items.
    expect(firstMessage("", seed.externals!.map((x) => x.item))).not.toBeNull();
    // An issue without a title falls back to its key.
    expect(linearSeed({ ...issue, summary: "" }).title).toBe("ENG-42");
  });

  test("the card goes to the board's current project: the one viewed last, else the first", () => {
    const projects = [{ id: "p1" }, { id: "p2" }];
    expect(startProject(projects, "p2", "p1")?.id).toBe("p2");
    expect(startProject(projects, "", "p2")?.id).toBe("p2");
    expect(startProject(projects, "", "")?.id).toBe("p1");
    expect(startProject(projects, "gone", "")?.id).toBe("p1");
    expect(startProject([], "", "")).toBeUndefined();
  });
});
