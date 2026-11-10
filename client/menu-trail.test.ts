import { describe, expect, test } from "vitest";
import type { MenuEntry } from "./context-menu";
import { BACK, drillIn, escapeStep, freshTrail, stepBack, visibleEntries, type Submenu } from "./menu-trail";

const sub: Submenu = {
  kind: "submenu",
  id: "move",
  label: "Move to",
  entries: [
    { id: "a", label: "A", onPress: () => {} },
    { id: "b", label: "B", onPress: () => {} },
  ],
};
const root: MenuEntry[] = [{ id: "open", label: "Open", onPress: () => {} }, sub];
const ids = (entries: MenuEntry[]) => entries.map((e) => e.id);

describe("menu trail", () => {
  test("the root shows its own entries", () => {
    expect(visibleEntries(root, freshTrail())).toBe(root);
  });

  test("drilling in shows the children behind a Back row", () => {
    const trail = drillIn(freshTrail(), sub);
    expect(ids(visibleEntries(root, trail))).toEqual([BACK, `${BACK}-s`, "a", "b"]);
  });

  test("Back returns to the root", () => {
    const trail = stepBack(drillIn(freshTrail(), sub));
    expect(trail).toEqual([]);
    expect(visibleEntries(root, trail)).toBe(root);
  });

  test("escape pops one submenu, then closes", () => {
    const first = escapeStep(drillIn(freshTrail(), sub));
    expect(first).toEqual({ trail: [], close: false });
    expect(escapeStep(first.trail)).toEqual({ trail: [], close: true });
  });

  test("a re-open starts from the root again", () => {
    drillIn(freshTrail(), sub);
    expect(freshTrail()).toEqual([]);
  });
});
