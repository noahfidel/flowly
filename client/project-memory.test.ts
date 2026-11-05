import { expect, test } from "vitest";
import { lastViewedProject, pickProject, pickView, rememberViewedProject, staleAllChoice } from "./project-memory";

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("cold start opens the first project", () => {
  expect(lastViewedProject()).toBe("");
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("a");
});

test("re-entering the board returns to the project viewed last in this run", () => {
  rememberViewedProject("c");
  rememberViewedProject(undefined);
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("c");
  expect(pickProject(projects, "b", lastViewedProject())?.id).toBe("b");
});

test("a removed or archived-away project falls back to the first", () => {
  expect(pickProject(projects.slice(0, 2), "", "c")?.id).toBe("a");
  expect(pickProject([], "", "c")).toBeUndefined();
});

test("an All choice the board fell back from is dropped, so All does not come back by itself", () => {
  const all = "*all";
  const off = { id: all, ok: false };
  // Setting off or one live project: the board shows a project and the All choice is stale.
  expect(pickView(projects, all, "", off)).toEqual({ all: false, project: { id: "a" } });
  expect(staleAllChoice(all, off, true)).toBe(true);
  // The board replaces it with the project it shows; All becoming available again keeps that project.
  rememberViewedProject("a");
  expect(pickView(projects, "a", lastViewedProject(), { id: all, ok: true })).toEqual({ all: false, project: { id: "a" } });
  // Not stale: All still available, a project choice, or data still loading.
  expect(staleAllChoice(all, { id: all, ok: true }, true)).toBe(false);
  expect(staleAllChoice("b", off, true)).toBe(false);
  expect(staleAllChoice(all, off, false)).toBe(false);
});
