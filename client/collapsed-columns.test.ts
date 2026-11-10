import { beforeEach, expect, test } from "vitest";
import { animatesCollapse, lastCollapsed, rememberCollapsed, shownCollapsed } from "./collapsed-columns";

/** No collapse flash on open (Ruling, Noah 2026-11-09). */

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("flowly.collapsedColumns")];
});

test("the stored set wins once loaded; before that the last known one; with neither the lanes wait", () => {
  expect(shownCollapsed(["done"], ["in_review"])).toEqual({ ready: true, collapsed: ["done"] });
  expect(shownCollapsed([], ["in_review"])).toEqual({ ready: true, collapsed: [] });
  expect(shownCollapsed(undefined, ["in_review"])).toEqual({ ready: true, collapsed: ["in_review"] });
  expect(shownCollapsed(null, undefined)).toEqual({ ready: false, collapsed: [] });
});

test("the last known set is kept per host and survives a fresh module (a client re-run)", () => {
  expect(lastCollapsed("h1")).toBeUndefined();
  rememberCollapsed("h1", ["done"]);
  rememberCollapsed("h2", []);
  expect(lastCollapsed("h1")).toEqual(["done"]);
  expect(lastCollapsed("h2")).toEqual([]);
  expect(lastCollapsed("h3")).toBeUndefined();
});

test("only a lane the user toggled animates", () => {
  expect(animatesCollapse(new Set(["done"]), "done")).toBe(true);
  expect(animatesCollapse(new Set(["done"]), "in_review")).toBe(false);
  expect(animatesCollapse(new Set(), "done")).toBe(false);
});
