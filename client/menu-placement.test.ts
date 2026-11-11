import { describe, expect, test } from "vitest";
import { menuHeight, placeMenu } from "./menu-placement";

const origin = { x: 100, y: 50, width: 800, height: 600 };
const place = (at: { x: number; y: number }, height: number, width = 232) => placeMenu({ at, origin, width, height, margin: 4 });

describe("menuHeight", () => {
  test("counts items, separators and labels plus padding", () => {
    expect(menuHeight([{}, {}, { kind: "separator" }, { kind: "label" }], false)).toBe(10 + 30 + 30 + 9 + 22);
    expect(menuHeight([{}, { kind: "submenu" }], true)).toBe(10 + 40 + 40);
  });
});

describe("placeMenu", () => {
  test("opens below the point when it fits", () => {
    expect(place({ x: 300, y: 150 }, 200)).toEqual({ left: 200, top: 100, maxHeight: 592 });
  });

  test("opens upward when there is no room below but room above", () => {
    const placed = place({ x: 300, y: 600 }, 200);
    expect(placed.top).toBe(550 - 200);
  });

  test("pins to the top margin, scrolling, when neither side fits", () => {
    const placed = place({ x: 300, y: 350 }, 900);
    expect(placed.top).toBe(4);
    expect(placed.maxHeight).toBe(600 - 8);
  });

  test("keeps left inside the box", () => {
    expect(place({ x: 110, y: 100 }, 100).left).toBe(10);
    expect(place({ x: 100, y: 100 }, 100).left).toBe(4);
    expect(place({ x: 890, y: 100 }, 100).left).toBe(800 - 232 - 4);
  });

  test("never leaves the box, whatever the point and height", () => {
    for (const y of [-20, 0, 50, 100, 300, 500, 640, 700]) {
      for (const height of [40, 200, 590, 592, 593, 700, 2000]) {
        const { top, maxHeight } = place({ x: 400, y }, height);
        expect(top).toBeGreaterThanOrEqual(4);
        expect(top + Math.min(height, maxHeight)).toBeLessThanOrEqual(origin.height - 4);
      }
    }
  });
});
