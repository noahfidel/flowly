import { expect, test } from "vitest";
import { statuses } from "./model";
import { boardViewSettings, boardViewValues, groupCollapsedOf, groupFilterOf, linkedCardFilter, statusSettingsValues, storedFilters, withGroupEntry } from "./settings";

test("older stored settings get defaults for newer fields; invalid values fall back", () => {
  expect(boardViewValues({ lastQuickProjectId: "p" })).toEqual({ sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "p", lastAddProjectId: "", lastGroupId: "", lastFilter: null, projectFilters: {}, boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterUmbrella: "", filterTags: [], showArchived: false, groupFilters: {}, groupCollapsed: {}, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], linearSearch: {}, prMine: false, memoryKind: "all", memorySort: "newest", memoryLayout: "list", drawerShare: 0, chatMinimized: false, chatExpanded: false, chatWidth: 0 });
  expect(boardViewValues(undefined)).toEqual({ sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "", lastAddProjectId: "", lastGroupId: "", lastFilter: null, projectFilters: {}, boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterUmbrella: "", filterTags: [], showArchived: false, groupFilters: {}, groupCollapsed: {}, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], linearSearch: {}, prMine: false, memoryKind: "all", memorySort: "newest", memoryLayout: "list", drawerShare: 0, chatMinimized: false, chatExpanded: false, chatWidth: 0 });
  expect(boardViewValues({ sendBehavior: "bogus" }).sendBehavior).toBe("steer");
  // The dock's old tab, layouts and Attention sections (Ruling, Noah 2026-11-09: the dock is the chat only) are dropped.
  expect(boardViewValues({ dockLayout: "side", dockStackShare: 0.3, attentionOpen: { needs: false }, dockTab: "attention", lastQuickProjectId: "p" })).toEqual(boardViewValues({ lastQuickProjectId: "p" }));
  // Quick task (QUICK-TASK-SPEC §6): a bad value falls back to its default, not the whole document.
  expect(boardViewValues({ quickTaskMode: "nope", quickTaskDefault: false, lastQuickProjectId: "p" })).toMatchObject({ quickTaskMode: "worktree", quickTaskDefault: false, lastQuickProjectId: "p" });
  expect(boardViewValues({ memoryKind: "pitfall", memorySort: "used", memoryLayout: "grid" })).toMatchObject({ memoryKind: "pitfall", memorySort: "used", memoryLayout: "grid" });
  expect(boardViewValues({ memoryKind: "bogus", memorySort: "bogus", memoryLayout: "bogus", lastQuickProjectId: "p" })).toMatchObject({ memoryKind: "all", memorySort: "newest", memoryLayout: "list", lastQuickProjectId: "p" });
  expect(boardViewValues({ sendBehavior: "queue", startAgentOnCreate: false })).toMatchObject({ sendBehavior: "queue", startAgentOnCreate: false });
  // v1 keys that moved into the board (BOARD-GROUPS-SPEC §7) are dropped; they never reset the other fields.
  const old = boardViewValues({ allProjectsTab: false, boardGroups: [{ id: "g", name: "G", projectIds: [] }], lastProjectId: "p", quickTaskMode: "directory" });
  expect(old).toEqual(boardViewValues({ quickTaskMode: "directory" }));
  expect(old).not.toHaveProperty("allProjectsTab");
  expect(old).not.toHaveProperty("boardGroups");
  expect(old).not.toHaveProperty("lastProjectId");
});

test("board sort is remembered and defaults to manual", () => {
  expect(boardViewValues({ boardSort: "priority" }).boardSort).toBe("priority");
  expect(boardViewValues({ lastQuickProjectId: "p" }).boardSort).toBe("manual");
});

test("collapsed columns are remembered; unknown statuses invalidate", () => {
  expect(boardViewValues({ collapsedColumns: ["blocked"] }).collapsedColumns).toEqual(["blocked"]);
  expect(boardViewValues({ collapsedColumns: ["nope"] }).collapsedColumns).toEqual([]);
});

test("every status can be collapsed at once; more than that or a non-status is rejected", () => {
  expect(statuses.length).toBeGreaterThan(7);
  for (const n of [8, statuses.length]) {
    const collapsedColumns = statuses.slice(0, n);
    expect(boardViewSettings.schema.safeParse({ collapsedColumns }).success).toBe(true);
    expect(boardViewValues({ collapsedColumns }).collapsedColumns).toEqual(collapsedColumns);
  }
  expect(boardViewSettings.schema.safeParse({ collapsedColumns: [...statuses, statuses[0]] }).success).toBe(false);
  expect(boardViewSettings.schema.safeParse({ collapsedColumns: ["nope"] }).success).toBe(false);
});

test("filters are remembered with safe defaults", () => {
  expect(boardViewValues({ filterPriority: "high", showArchived: true, filterSearch: "api" })).toMatchObject({ filterPriority: "high", showArchived: true, filterSearch: "api" });
  expect(boardViewValues({}).filterPriority).toBe("all");
  expect(boardViewValues({}).filterType).toBe("all");
  expect(boardViewValues({ filterType: "research" }).filterType).toBe("research");
});

test("automatic status rules default to on; unset or invalid stored values stay on", () => {
  expect(statusSettingsValues(undefined).autoStatus).toBe(true);
  expect(statusSettingsValues({}).autoStatus).toBe(true);
  expect(statusSettingsValues({ autoStatus: "no" }).autoStatus).toBe(true);
  expect(statusSettingsValues({ autoStatus: false }).autoStatus).toBe(false);
});

test("old finished cards fold after 14 days by default; 0 turns it off", () => {
  expect(boardViewValues({}).hideFinishedAfterDays).toBe(14);
  expect(boardViewValues({ hideFinishedAfterDays: 0 }).hideFinishedAfterDays).toBe(0);
  expect(boardViewValues({ hideFinishedAfterDays: 7 }).hideFinishedAfterDays).toBe(7);
});

test("card display options default to auto and all shown; a bad value does not reset other preferences", () => {
  expect(boardViewValues({}).cardActivity).toBe("auto");
  expect(boardViewValues({}).cardHidden).toEqual([]);
  expect(boardViewValues({ cardActivity: "both", cardHidden: ["tags", "future-field"] })).toMatchObject({ cardActivity: "both", cardHidden: ["tags", "future-field"] });
  expect(boardViewValues({ boardSort: "priority", cardActivity: "bogus", cardHidden: "tags" })).toMatchObject({ boardSort: "priority", cardActivity: "auto", cardHidden: [] });
  expect(boardViewValues({ drawerOrder: ["sessions", "future"] }).drawerOrder).toEqual(["sessions", "future"]);
  expect(boardViewValues({ boardSort: "priority", drawerOrder: "sessions" })).toMatchObject({ boardSort: "priority", drawerOrder: [] });
  expect(boardViewValues({ drawerOpen: { workpad: false } }).drawerOpen).toEqual({ workpad: false });
  expect(boardViewValues({ boardSort: "priority", drawerOpen: { workpad: "no" } })).toMatchObject({ boardSort: "priority", drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], memoryKind: "all", memorySort: "newest", memoryLayout: "list", drawerShare: 0, chatMinimized: false, chatExpanded: false, chatWidth: 0 });
  // The sidebar width is a share of the Flowly area; the earlier point value is dropped.
  expect(boardViewValues({ drawerShare: 0.62 }).drawerShare).toBe(0.62);
  // The Linear board's layout and scope (LINEAR-BOARD-SPEC §4): an unknown layout falls back to auto.
  expect(boardViewValues({ linearLayout: "grid", linearScope: "team-1" })).toMatchObject({ linearLayout: "auto", linearScope: "team-1", linearHidden: [] });
  // Hidden status lanes; a malformed list drops back to none hidden.
  expect(boardViewValues({ linearHidden: ["completed", "canceled"] }).linearHidden).toEqual(["completed", "canceled"]);
  // Lane keys are lowercased state names; legacy values stay harmless.
  expect(boardViewValues({ linearHidden: ["in review", "awaiting deploy", "started"] }).linearHidden).toEqual(["in review", "awaiting deploy", "started"]);
  expect(boardViewValues({ linearHidden: [""] }).linearHidden).toEqual([""]);
  expect(boardViewValues({ linearHidden: [1] }).linearHidden).toEqual([]);
  expect(boardViewValues({ linearHidden: ["x".repeat(101)] }).linearHidden).toEqual([]);
  expect(boardViewValues({ boardSort: "priority", drawerShare: 1.5 })).toMatchObject({ boardSort: "priority", drawerShare: 0 });
  expect(boardViewValues({ drawerWidth: 1290 })).not.toHaveProperty("drawerWidth");
  expect(boardViewValues({ drawerOpen: { workpad: "no" } })).toMatchObject({ memoryKind: "all", memorySort: "newest", memoryLayout: "list" });
});

test("the timing log is off unless the host setting says so", async () => {
  const { performanceLogOn } = await import("./settings");
  expect(performanceLogOn(undefined)).toBe(false);
  expect(performanceLogOn({})).toBe(false);
  expect(performanceLogOn({ log: "yes" })).toBe(false);
  expect(performanceLogOn({ log: true })).toBe(true);
});

test("the dispatcher chat starts open and its minimized state is kept (DISPATCHER-SPEC §9.3)", () => {
  expect(boardViewValues({}).chatMinimized).toBe(false);
  expect(boardViewValues({ chatMinimized: true }).chatMinimized).toBe(true);
  // A bad stored value falls back to open without dropping the other fields.
  expect(boardViewValues({ chatMinimized: "yes", lastQuickProjectId: "p" })).toMatchObject({ chatMinimized: false, lastQuickProjectId: "p" });
});

test("the dispatcher chat starts at its docked width and its expanded state is kept (DISPATCHER-SPEC §9.3)", () => {
  expect(boardViewValues({}).chatExpanded).toBe(false);
  expect(boardViewValues({ chatExpanded: true }).chatExpanded).toBe(true);
  expect(boardViewValues({ chatExpanded: 1, chatMinimized: true })).toMatchObject({ chatExpanded: false, chatMinimized: true });
});

test("the dispatcher chat's dragged width is kept; a bad value reads as never dragged (DISPATCHER-SPEC §9.3)", () => {
  expect(boardViewValues({}).chatWidth).toBe(0);
  expect(boardViewValues({ chatWidth: 512 }).chatWidth).toBe(512);
  expect(boardViewValues({ chatWidth: "wide", lastQuickProjectId: "p" })).toMatchObject({ chatWidth: 0, lastQuickProjectId: "p" });
  expect(boardViewValues({ chatWidth: -4 }).chatWidth).toBe(0);
  expect(boardViewValues({ chatWidth: 1e9 }).chatWidth).toBe(0);
});

test("the project last added to from an unfiltered group page is kept, and a bad value never resets the rest", () => {
  expect(boardViewValues({ lastAddProjectId: "q", lastQuickProjectId: "p" })).toMatchObject({ lastAddProjectId: "q", lastQuickProjectId: "p" });
  expect(boardViewValues({ lastAddProjectId: 7, lastQuickProjectId: "p" })).toMatchObject({ lastAddProjectId: "", lastQuickProjectId: "p" });
});

// BOARD-GROUPS-SPEC §3, §4: the group last viewed and its project filter survive a restart.
test("the last viewed group and project filter are kept; a bad value never resets the rest", () => {
  expect(boardViewValues({ lastGroupId: "g", lastFilter: { groupId: "g", projectId: "p" }, lastQuickProjectId: "q" })).toMatchObject({ lastGroupId: "g", lastFilter: { groupId: "g", projectId: "p" }, lastQuickProjectId: "q" });
  expect(boardViewValues({ lastGroupId: 4, lastFilter: { groupId: "g" }, lastQuickProjectId: "q" })).toMatchObject({ lastGroupId: "", lastFilter: null, lastQuickProjectId: "q" });
  expect(boardViewValues({ lastFilter: { groupId: "", projectId: "p" } }).lastFilter).toBeNull();
});

test("projectFilters: per-group map, bad data falls back, capped; the legacy lastFilter seeds a group with no entry", () => {
  expect(boardViewValues({ projectFilters: { g1: "a", g2: "b" } }).projectFilters).toEqual({ g1: "a", g2: "b" });
  expect(boardViewValues({ projectFilters: { g1: 4 } }).projectFilters).toEqual({});
  expect(boardViewValues({ projectFilters: "x" }).projectFilters).toEqual({});
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`g${i}`, "p"]));
  expect(Object.keys(boardViewValues({ projectFilters: many }).projectFilters)).toHaveLength(100);
  expect(storedFilters({ projectFilters: { g1: "a" }, lastFilter: { groupId: "g2", projectId: "b" } })).toEqual({ g1: "a", g2: "b" });
  expect(storedFilters({ projectFilters: { g2: "new" }, lastFilter: { groupId: "g2", projectId: "b" } })).toEqual({ g2: "new" });
  expect(storedFilters({ projectFilters: {}, lastFilter: null })).toEqual({});
});

test("groupFilters and groupCollapsed: per-group maps, bad data falls back, capped (ruling 2026-11-23)", () => {
  const f1 = { search: "bug", priority: "high", type: "feature", tags: ["ui"], archived: true };
  expect(boardViewValues({ groupFilters: { g1: f1 }, groupCollapsed: { g1: ["done"], g2: [] } })).toMatchObject({ groupFilters: { g1: f1 }, groupCollapsed: { g1: ["done"], g2: [] } });
  // A bad field falls back to its default; the rest of the entry and the other settings stay.
  expect(boardViewValues({ groupFilters: { g1: { ...f1, priority: "urgent!", tags: "ui" } }, lastQuickProjectId: "q" })).toMatchObject({
    groupFilters: { g1: { search: "bug", priority: "all", type: "feature", tags: [], archived: true } },
    lastQuickProjectId: "q",
  });
  expect(boardViewValues({ groupFilters: { g1: {} } }).groupFilters).toEqual({ g1: { search: "", priority: "all", type: "all", umbrella: "", tags: [], archived: false } });
  expect(boardViewValues({ groupCollapsed: { g1: ["nope"] } }).groupCollapsed).toEqual({ g1: [] });
  // A bad map: none.
  expect(boardViewValues({ groupFilters: "x", groupCollapsed: 4, lastQuickProjectId: "q" })).toMatchObject({ groupFilters: {}, groupCollapsed: {}, lastQuickProjectId: "q" });
  expect(boardViewValues({ groupFilters: { g1: 4 } }).groupFilters).toEqual({});
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`g${i}`, ["done"]]));
  expect(Object.keys(boardViewValues({ groupCollapsed: many }).groupCollapsed)).toHaveLength(100);
  expect(Object.keys(boardViewValues({ groupFilters: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`g${i}`, {}])) }).groupFilters)).toHaveLength(100);
});

test("a group with no entry starts from the global filters and collapsed lanes saved before per-group ones", () => {
  const values = boardViewValues({ filterSearch: "old", filterPriority: "low", filterType: "bugfix", filterTags: ["x"], showArchived: true, collapsedColumns: ["blocked"], groupFilters: { g1: { search: "mine" } }, groupCollapsed: { g1: ["done"] } });
  expect(groupFilterOf(values, "g2")).toEqual({ search: "old", priority: "low", type: "bugfix", tags: ["x"], archived: true, umbrella: "" });
  expect(groupFilterOf(values, "g1")).toEqual({ search: "mine", priority: "all", type: "all", umbrella: "", tags: [], archived: false });
  expect(groupCollapsedOf(values, "g2")).toEqual(["blocked"]);
  expect(groupCollapsedOf(values, "g1")).toEqual(["done"]);
});

test("a group filter without umbrella reads as all", () => {
  expect(boardViewValues({ groupFilters: { g1: { search: "x" } } }).groupFilters.g1!.umbrella).toBe("");
  expect(boardViewValues({ filterUmbrella: 4 }).filterUmbrella).toBe("");
  expect(groupFilterOf(boardViewValues({ filterUmbrella: "u1" }), "g9").umbrella).toBe("u1");
});

test("a card link clears the umbrella filter", () => {
  const saved = { search: "", priority: "all" as const, type: "all" as const, umbrella: "u1", tags: [], archived: false };
  expect(linkedCardFilter(saved, false).umbrella).toBe("");
});

test("a card link clears search, priority, type and tags; show-archived turns on only for an archived card or project", () => {
  const saved = { search: "x", priority: "high" as const, type: "bugfix" as const, umbrella: "u1", tags: ["t"], archived: true };
  expect(linkedCardFilter(saved, false)).toEqual({ search: "", priority: "all", type: "all", umbrella: "", tags: [], archived: true });
  expect(linkedCardFilter({ ...saved, archived: false }, false).archived).toBe(false);
  expect(linkedCardFilter({ ...saved, archived: false }, true).archived).toBe(true);
});

test("writing one group's entry keeps the others, drops deleted groups and keeps the cap", () => {
  expect(withGroupEntry({ g1: 1, g2: 2 }, "g2", 3, null)).toEqual({ g1: 1, g2: 3 });
  expect(withGroupEntry({ g1: 1, gone: 2 }, "g3", 3, ["g1", "g3"])).toEqual({ g1: 1, g3: 3 });
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`g${i}`, i]));
  const next = withGroupEntry(many, "new", 1, null);
  expect(Object.keys(next)).toHaveLength(100);
  expect(next.new).toBe(1);
  expect(next.g0).toBeUndefined();
});

test("prMine defaults off and falls back to off on a bad value", () => {
  expect(boardViewValues({}).prMine).toBe(false);
  expect(boardViewValues({ prMine: true }).prMine).toBe(true);
  expect(boardViewValues({ prMine: "yes", lastQuickProjectId: "p" })).toMatchObject({ prMine: false, lastQuickProjectId: "p" });
});

test("linearSearch: per-scope search text, bad data falls back, capped (LINEAR-BOARD-SPEC §4)", () => {
  expect(boardViewValues({ linearSearch: { "c1:me": "deploy" } }).linearSearch).toEqual({ "c1:me": "deploy" });
  expect(boardViewValues({ linearSearch: 4, lastQuickProjectId: "q" })).toMatchObject({ linearSearch: {}, lastQuickProjectId: "q" });
  // One bad entry makes the whole map fall back.
  expect(boardViewValues({ linearSearch: { "c1:me": "x".repeat(201) } }).linearSearch).toEqual({});
  expect(Object.keys(boardViewValues({ linearSearch: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`c:${i}`, "q"])) }).linearSearch)).toHaveLength(100);
});
