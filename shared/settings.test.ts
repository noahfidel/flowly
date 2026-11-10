import { expect, test } from "vitest";
import { statuses } from "./model";
import { boardViewSettings, boardViewValues, statusSettingsValues } from "./settings";

test("older stored settings get defaults for newer fields; invalid values fall back", () => {
  expect(boardViewValues({ lastQuickProjectId: "p" })).toEqual({ sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "p", boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterTags: [], showArchived: false, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], memoryKind: "all", memorySort: "newest", memoryLayout: "list", drawerShare: 0, chatMinimized: false, chatExpanded: false, chatWidth: 0 });
  expect(boardViewValues(undefined)).toEqual({ sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "", boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterTags: [], showArchived: false, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], memoryKind: "all", memorySort: "newest", memoryLayout: "list", drawerShare: 0, chatMinimized: false, chatExpanded: false, chatWidth: 0 });
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
  // Hidden status columns; an unknown column drops the list back to none hidden.
  expect(boardViewValues({ linearHidden: ["completed", "canceled"] }).linearHidden).toEqual(["completed", "canceled"]);
  expect(boardViewValues({ linearHidden: ["done"] }).linearHidden).toEqual([]);
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
