import { expect, test } from "vitest";
import { boardViewValues, statusSettingsValues } from "./settings";

test("older stored settings get defaults for newer fields; invalid values fall back", () => {
  expect(boardViewValues({ lastProjectId: "p" })).toEqual({ lastProjectId: "p", sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "", boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterTags: [], showArchived: false, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], drawerShare: 0 });
  expect(boardViewValues(undefined)).toEqual({ lastProjectId: "", sendBehavior: "steer", startAgentOnCreate: true, quickTaskDefault: true, quickTaskAiTitle: true, quickTaskMode: "worktree", lastQuickProjectId: "", boardSort: "manual", collapsedColumns: [], filterSearch: "", filterPriority: "all", filterType: "all", filterTags: [], showArchived: false, hideFinishedAfterDays: 14, runningSweep: true, lastTicketConnection: "", lastConnections: {}, cardActivity: "auto", cardHidden: [], drawerOrder: [], drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], drawerShare: 0 });
  expect(boardViewValues({ sendBehavior: "bogus" }).sendBehavior).toBe("steer");
  // Quick task (QUICK-TASK-SPEC §6): a bad value falls back to its default, not the whole document.
  expect(boardViewValues({ quickTaskMode: "nope", quickTaskDefault: false, lastProjectId: "p" })).toMatchObject({ quickTaskMode: "worktree", quickTaskDefault: false, lastProjectId: "p" });
  expect(boardViewValues({ sendBehavior: "queue", startAgentOnCreate: false })).toMatchObject({ sendBehavior: "queue", startAgentOnCreate: false });
});

test("board sort is remembered and defaults to manual", () => {
  expect(boardViewValues({ boardSort: "priority" }).boardSort).toBe("priority");
  expect(boardViewValues({ lastProjectId: "p" }).boardSort).toBe("manual");
});

test("collapsed columns are remembered; unknown statuses invalidate", () => {
  expect(boardViewValues({ collapsedColumns: ["blocked"] }).collapsedColumns).toEqual(["blocked"]);
  expect(boardViewValues({ collapsedColumns: ["nope"] }).collapsedColumns).toEqual([]);
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
  expect(boardViewValues({ boardSort: "priority", drawerOpen: { workpad: "no" } })).toMatchObject({ boardSort: "priority", drawerOpen: {}, linearLayout: "auto", linearScope: "me", linearHidden: [], drawerShare: 0 });
  // The sidebar width is a share of the Flowly area; the earlier point value is dropped.
  expect(boardViewValues({ drawerShare: 0.62 }).drawerShare).toBe(0.62);
  // The Linear board's layout and scope (LINEAR-BOARD-SPEC §4): an unknown layout falls back to auto.
  expect(boardViewValues({ linearLayout: "grid", linearScope: "team-1" })).toMatchObject({ linearLayout: "auto", linearScope: "team-1", linearHidden: [] });
  // Hidden status columns; an unknown column drops the list back to none hidden.
  expect(boardViewValues({ linearHidden: ["completed", "canceled"] }).linearHidden).toEqual(["completed", "canceled"]);
  expect(boardViewValues({ linearHidden: ["done"] }).linearHidden).toEqual([]);
  expect(boardViewValues({ boardSort: "priority", drawerShare: 1.5 })).toMatchObject({ boardSort: "priority", drawerShare: 0 });
  expect(boardViewValues({ drawerWidth: 1290 })).not.toHaveProperty("drawerWidth");
});

test("the timing log is off unless the host setting says so", async () => {
  const { performanceLogOn } = await import("./settings");
  expect(performanceLogOn(undefined)).toBe(false);
  expect(performanceLogOn({})).toBe(false);
  expect(performanceLogOn({ log: "yes" })).toBe(false);
  expect(performanceLogOn({ log: true })).toBe(true);
});
