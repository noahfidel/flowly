import { describe, expect, test } from "vitest";
import type { ExternalSummary } from "../shared/connectors";
import { firstMessage } from "./first-message";
import { linearOpenParams, linearQuickSeed, linearStartParams, parseLinearOpen, parseLinearStart, linearStartTarget } from "./linear-start";
import type { Group, Project } from "../shared/model";
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
  test("Quick task opens seeded with the issue as an external and the KEY: title card title (LINEAR-BOARD-SPEC §5)", () => {
    const seed = linearQuickSeed(issue);
    expect(seed).toEqual({ title: "ENG-42: Login retry loops", externals: [{ item: issue, provider: "linear" }] });
    // An issue without a title is named by its key alone.
    expect(linearQuickSeed({ ...issue, summary: "" }).title).toBe("ENG-42");
    // The Quick task's empty text sends the default that points at the attached issue.
    expect(firstMessage("", seed.externals.map((x) => x.item))).toContain("ENG-42");
  });
});

const project = (id: string, over: Partial<Project> = {}): Project =>
  ({ id, paseoProjectId: `native-${id}`, title: id, description: "", primaryPath: `/tmp/${id}`, repos: [], revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", archivedAt: null, ...over }) as Project;
const group = (id: string, position: number, over: Partial<Group> = {}): Group =>
  ({ id, name: id, position, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over }) as Group;

describe("Start card's project (LINEAR-BOARD-SPEC §5, board groups)", () => {
  const groups = [group("g1", 0, { isDefault: true }), group("g2", 1), group("g3", 2)];
  const a = project("a", { position: 0, groupId: "g1" }),
    b = project("b", { position: 1, groupId: "g1" }),
    c = project("c", { position: 2, groupId: "g2" }),
    d = project("d", { position: 3, groupId: "g2" }),
    old = project("old", { position: 4, groupId: "g2", archivedAt: "2026-11-02T00:00:00.000Z" });
  const projects = [a, b, c, d, old];
  const base = { groups, projects, shownGroupId: "g1", filterId: "", lastQuickProjectId: "", settingsLoaded: true };

  test("not ready until the board-view settings and the groups are loaded", () => {
    expect(linearStartTarget({ ...base, settingsLoaded: false })).toEqual({ ready: false });
    expect(linearStartTarget({ ...base, groups: [] })).toEqual({ ready: false });
  });

  test("the shown group's first member, not the last quick-task project of another group", () => {
    expect(linearStartTarget({ ...base, shownGroupId: "g2", lastQuickProjectId: "a" })).toEqual({ ready: true, projectId: "c" });
  });

  test("the group's Project filter wins", () => {
    expect(linearStartTarget({ ...base, shownGroupId: "g2", filterId: "d", lastQuickProjectId: "c" })).toEqual({ ready: true, projectId: "d" });
  });

  test("the last quick-task project wins when a live member of the shown group", () => {
    expect(linearStartTarget({ ...base, shownGroupId: "g2", lastQuickProjectId: "d" })).toEqual({ ready: true, projectId: "d" });
  });

  test("archived projects are never chosen", () => {
    expect(linearStartTarget({ ...base, shownGroupId: "g2", lastQuickProjectId: "old" })).toEqual({ ready: true, projectId: "c" });
    expect(linearStartTarget({ ...base, shownGroupId: "g2", filterId: "old" })).toEqual({ ready: true, projectId: "c" });
  });

  test("an empty shown group falls back to All's rule", () => {
    expect(linearStartTarget({ ...base, shownGroupId: "g3", lastQuickProjectId: "d" })).toEqual({ ready: true, projectId: "d" });
    expect(linearStartTarget({ ...base, shownGroupId: "g3" })).toEqual({ ready: true, projectId: "a" });
  });

  test("no live project gives null", () => {
    expect(linearStartTarget({ ...base, projects: [old] })).toEqual({ ready: true, projectId: null });
    expect(linearStartTarget({ ...base, projects: [] })).toEqual({ ready: true, projectId: null });
  });
});
