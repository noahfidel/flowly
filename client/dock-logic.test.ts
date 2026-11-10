import { expect, test } from "vitest";
import { dockShortcut, toolbarDockButtons } from "./dock-logic";

/** The left dock is the dispatcher chat only; minimized on desktop it leaves nothing, and the toolbar button or D reopens it (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09). */

test("the toolbar's Dispatcher button is on every board with a dock; the bell is phone-only", () => {
  expect(toolbarDockButtons({ compact: true, dockAvailable: true })).toEqual({ bell: true, dispatcher: true });
  expect(toolbarDockButtons({ compact: false, dockAvailable: true })).toEqual({ bell: false, dispatcher: true });
  expect(toolbarDockButtons({ compact: false, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
  expect(toolbarDockButtons({ compact: true, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
});

test("D opens a minimized dock and minimizes an open one; nothing without a dock", () => {
  expect(dockShortcut({ dockAvailable: true, open: false })).toBe("open");
  expect(dockShortcut({ dockAvailable: true, open: true })).toBe("minimize");
  expect(dockShortcut({ dockAvailable: false, open: false })).toBeNull();
  expect(dockShortcut({ dockAvailable: false, open: true })).toBeNull();
});
