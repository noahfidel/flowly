import { describe, expect, test } from "vitest";
import { quickMode, quickProject, startStatus } from "./quick-task";
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
  test("the last quick-task project when it is live", () => {
    expect(quickProject([a, b], { last: "b", current: "a" })?.id).toBe("b");
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
