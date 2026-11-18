import { expect, test, vi } from "vitest";
import { lastProjectFilter, lastViewedGroupView, lastViewedProject, pickProject, rememberViewedGroupView, rememberViewedProject, writeProjectFilter, writeViewedGroup } from "./project-memory";

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

test("the board writes the project filter to run state and the store; skips the store when unchanged", () => {
  const stored: unknown[] = [];
  const f = { groupId: "g1", projectId: "p1" };
  writeProjectFilter(f, "board", null, (x) => stored.push(x));
  expect(lastProjectFilter()).toEqual(f);
  expect(stored).toEqual([f]);
  writeProjectFilter(f, "board", { ...f }, (x) => stored.push(x));
  expect(stored).toHaveLength(1);
});

test("the workspace panel never writes the project filter", () => {
  const before = lastProjectFilter();
  const store = vi.fn();
  writeProjectFilter({ groupId: "g9", projectId: "p9" }, "panel", null, store);
  writeProjectFilter(null, "panel", { groupId: "g1", projectId: "p1" }, store);
  expect(lastProjectFilter()).toEqual(before);
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
