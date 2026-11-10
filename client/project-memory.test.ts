import { expect, test } from "vitest";
import { lastViewedGroupView, lastViewedProject, pickProject, rememberViewedGroupView, rememberViewedProject } from "./project-memory";

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
