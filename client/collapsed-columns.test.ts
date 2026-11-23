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

test("the last known set is kept per host and group and survives a fresh module (a client re-run)", () => {
  expect(lastCollapsed("h1", "g1")).toBeUndefined();
  rememberCollapsed("h1", "g1", ["done"]);
  rememberCollapsed("h1", "g2", ["blocked"]);
  rememberCollapsed("h2", "g1", []);
  expect(lastCollapsed("h1", "g1")).toEqual(["done"]);
  expect(lastCollapsed("h1", "g2")).toEqual(["blocked"]);
  expect(lastCollapsed("h2", "g1")).toEqual([]);
  expect(lastCollapsed("h3", "g1")).toBeUndefined();
  // A group not drawn yet in this run has no set; a board that knows no group yet takes the host's last shown one.
  expect(lastCollapsed("h1", "g3")).toBeUndefined();
  expect(lastCollapsed("h1", "")).toEqual(["blocked"]);
});

test("only a lane the user toggled animates", () => {
  expect(animatesCollapse(new Set(["done"]), "done")).toBe(true);
  expect(animatesCollapse(new Set(["done"]), "in_review")).toBe(false);
  expect(animatesCollapse(new Set(), "done")).toBe(false);
});
