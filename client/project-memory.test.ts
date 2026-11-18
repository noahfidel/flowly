import { expect, test, vi } from "vitest";
import { lastProjectFilter, lastViewedGroupView, lastViewedProject, pickProject, rememberProjectFilter, rememberViewedGroupView, rememberViewedProject, restoredFilters, writeProjectFilter, writeViewedGroup } from "./project-memory";

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("cold start opens the first project", () => {
  expect(lastViewedProject()).toBe("");
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("a");
});

test("re-entering returns to the project viewed last in this run", () => {
  rememberViewedProject("c");
  rememberViewedProject(undefined);
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("c");
  expect(pickProject(projects, "b", lastViewedProject())?.id).toBe("b");
});

test("a removed or archived-away project falls back to the first", () => {
  expect(pickProject(projects.slice(0, 2), "", "c")?.id).toBe("a");
  expect(pickProject([], "", "c")).toBeUndefined();
});

test("the group view last viewed is remembered for this run; an empty value is ignored", () => {
  expect(lastViewedGroupView()).toBe("");
  rememberViewedGroupView("*group:g2");
  rememberViewedGroupView(undefined);
  rememberViewedGroupView("");
  expect(lastViewedGroupView()).toBe("*group:g2");
});

test("the board writes a group's project filter to run state and the store; skips the store when unchanged", () => {
  const stored: unknown[] = [];
  writeProjectFilter("g1", "p1", "board", {}, (x) => stored.push(x));
  expect(lastProjectFilter("g1")).toBe("p1");
  expect(stored).toEqual([{ g1: "p1" }]);
  writeProjectFilter("g1", "p1", "board", { g1: "p1" }, (x) => stored.push(x));
  expect(stored).toHaveLength(1);
});

test("run state is per group: clearing one group leaves another's entry", () => {
  const stored: Record<string, string>[] = [];
  writeProjectFilter("g2", "p2", "board", { g1: "p1" }, (x) => stored.push(x));
  expect(stored[0]).toEqual({ g1: "p1", g2: "p2" });
  writeProjectFilter("g1", null, "board", stored[0], (x) => stored.push(x));
  expect(stored[1]).toEqual({ g2: "p2" });
  expect(lastProjectFilter("g1")).toBeNull();
  expect(lastProjectFilter("g2")).toBe("p2");
  expect(lastProjectFilter("never-set")).toBeUndefined();
});

test("the effective filter of a group is this run's value, else the stored one", () => {
  rememberProjectFilter("g7", null);
  rememberProjectFilter("g8", "p8");
  const stored = { g7: "x", g8: "y", g9: "p9" };
  expect(restoredFilters(stored)).toMatchObject({ g8: "p8", g9: "p9" });
  expect(restoredFilters(stored).g7).toBeUndefined();
});

test("the workspace panel never writes the project filter", () => {
  const before = lastProjectFilter("g1");
  const store = vi.fn();
  writeProjectFilter("g9", "p9", "panel", {}, store);
  writeProjectFilter("g1", null, "panel", { g1: "p1" }, store);
  expect(lastProjectFilter("g1")).toEqual(before);
  expect(lastProjectFilter("g9")).toBeUndefined();
  expect(store).not.toHaveBeenCalled();
});

test("the board writes the viewed group; the panel never does", () => {
  const store = vi.fn();
  writeViewedGroup("g3", "*group:g3", "board", "g2", store);
  expect(lastViewedGroupView()).toBe("*group:g3");
  expect(store).toHaveBeenCalledWith("g3");
  store.mockClear();
  writeViewedGroup("g3", "*group:g3", "board", "g3", store);
  expect(store).not.toHaveBeenCalled();
  writeViewedGroup("g7", "*group:g7", "panel", "g2", store);
  expect(lastViewedGroupView()).toBe("*group:g3");
  expect(store).not.toHaveBeenCalled();
});
