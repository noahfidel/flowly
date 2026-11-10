import { expect, test } from "vitest";
import { railShown, toolbarDockButtons } from "./dock-logic";

/** The left dock is the dispatcher chat only; minimized on desktop it leaves a rail (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09). */

test("desktop shows the rail exactly while the dock is minimized; phones and boards without a dock never", () => {
  expect(railShown({ compact: false, dockAvailable: true, open: false })).toBe(true);
  expect(railShown({ compact: false, dockAvailable: true, open: true })).toBe(false);
  expect(railShown({ compact: true, dockAvailable: true, open: false })).toBe(false);
  expect(railShown({ compact: false, dockAvailable: false, open: false })).toBe(false);
});

test("the toolbar's bell and Dispatcher buttons are phone-only, and only on a board", () => {
  expect(toolbarDockButtons({ compact: true, dockAvailable: true })).toEqual({ bell: true, dispatcher: true });
  expect(toolbarDockButtons({ compact: false, dockAvailable: true })).toEqual({ bell: false, dispatcher: false });
  expect(toolbarDockButtons({ compact: false, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
  expect(toolbarDockButtons({ compact: true, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
});
