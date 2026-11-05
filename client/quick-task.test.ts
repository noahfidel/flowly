import { describe, expect, test } from "vitest";
import { quickCard, quickMode, quickProject, quickPrompt, startStatus } from "./quick-task";
import { defaultFirstMessage } from "./first-message";
import { statuses, type Project } from "../shared/model";

const project = (id: string, over: Partial<Project> = {}): Project =>
  ({
    id,
    paseoProjectId: `native-${id}`,
    title: id,
    description: "",
    primaryPath: `/tmp/${id}`,
    repos: [],
    revision: 1,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    archivedAt: null,
    ...over,
  }) as Project;

describe("quickProject (QUICK-TASK-SPEC §3)", () => {
  const a = project("a"),
    b = project("b"),
    gone = project("gone", { archivedAt: "2026-11-01T00:00:00.000Z" });
  test("the pinned project wins when it is live", () => {
    expect(quickProject([a, b], { pinned: "b", last: "a", current: "a" })?.id).toBe("b");
  });
  test("the last quick-task project when it is live (Q and the Command Center)", () => {
    expect(quickProject([a, b], { last: "b", current: "a" })?.id).toBe("b");
  });
  test("without a last project (\"+\", N, phone add, empty-board hint) the board's project wins", () => {
    expect(quickProject([a, b], { current: "b" })?.id).toBe("b");
    expect(quickProject([a, b], { pinned: "b", current: "a" })?.id).toBe("b");
  });
  test("falls back to the board's project when the last one is archived or gone", () => {
    expect(quickProject([a, b, gone], { last: "gone", current: "b" })?.id).toBe("b");
    expect(quickProject([a, b], { last: "missing", current: "b" })?.id).toBe("b");
  });
  test("then the first live project", () => {
    expect(quickProject([gone, a, b], { last: "", current: "gone" })?.id).toBe("a");
  });
  test("no live project", () => {
    expect(quickProject([gone], { last: "gone", current: "gone" })).toBeNull();
    expect(quickProject([], { last: "", current: "" })).toBeNull();
  });
});

describe("quickMode", () => {
  test("follows the setting", () => {
    expect(quickMode(project("a"), "worktree")).toBe("worktree");
    expect(quickMode(project("a"), "directory")).toBe("directory");
  });
  test("a project with links always gets a directory workspace", () => {
    const linked = project("l", { links: [{ name: "x", target: "/x" }] } as Partial<Project>);
    expect(quickMode(linked, "worktree")).toBe("directory");
  });
});

describe("startStatus", () => {
  test("the requested lane when the project has it, else the first active lane", () => {
    const p = project("a");
    expect(startStatus(p, "backlog")).toBe("backlog");
    const lanes = project("b", {
      lanes: statuses.map((status) => ({ status, enabled: status !== "backlog" && status !== "todo" })),
    });
    expect(startStatus(lanes, "todo")).toBe(statuses.find((s) => s !== "backlog" && s !== "todo"));
  });
});

describe("a Quick task seeded from a Linear issue (LINEAR-BOARD-SPEC §5, QUICK-TASK-SPEC §1)", () => {
  const item = { connectionId: "c1", itemType: "issue", key: "ENG-42", remoteId: "u", url: "https://linear.app/a/issue/ENG-42", summary: "Login retry loops", status: "Todo", statusCategory: "new", type: "", priority: "", assignee: "", container: "", updated: "" } as const;
  const seed = { title: "ENG-42: Login retry loops", externals: [{ item, provider: "linear" as const }] };
  const items = seed.externals.map((x) => x.item);

  test("the card is titled by the issue and no AI title is asked for", () => {
    expect(quickCard("fix it first", seed, items.length)).toEqual({ title: "ENG-42: Login retry loops", aiTitle: false });
  });
  test("without a seed, or once the issue chip is removed, it is an ordinary quick task", () => {
    expect(quickCard("Fix the login redirect", undefined, 0)).toEqual({ title: "Fix the login redirect", aiTitle: true });
    expect(quickCard("Fix the login redirect", seed, 0)).toEqual({ title: "Fix the login redirect", aiTitle: true });
  });
  test("an empty text with an issue attached sends the default message; typed text is sent as typed", () => {
    expect(quickPrompt("", items)).toBe(defaultFirstMessage(items));
    expect(quickPrompt("  ", items)).toContain("ENG-42");
    expect(quickPrompt("  only the retry part ", items)).toBe("only the retry part");
  });
  test("an empty text without an issue still cannot be sent", () => {
    expect(quickPrompt("", [])).toBeNull();
    expect(quickPrompt("do it", [])).toBe("do it");
  });
});
