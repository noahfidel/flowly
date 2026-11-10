import { expect, test } from "vitest";
import { dockShortcut, escAction, toolbarDockButtons } from "./dock-logic";

/** The left dock is the dispatcher chat only; minimized on desktop it leaves nothing, and the toolbar button or D reopens it (DISPATCHER-SPEC §9.3; Ruling, Noah 2026-11-09). */

test("the toolbar's Dispatcher button is on every board with a dock; the bell is phone-only", () => {
  expect(toolbarDockButtons({ compact: true, dockAvailable: true })).toEqual({ bell: true, dispatcher: true });
  expect(toolbarDockButtons({ compact: false, dockAvailable: true })).toEqual({ bell: false, dispatcher: true });
  expect(toolbarDockButtons({ compact: false, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
  expect(toolbarDockButtons({ compact: true, dockAvailable: false })).toEqual({ bell: false, dispatcher: false });
});

test("D opens the dock (or keeps it open) and focuses the box; it never closes; nothing without a dock", () => {
  expect(dockShortcut({ dockAvailable: true })).toBe("focus");
  expect(dockShortcut({ dockAvailable: false })).toBeNull();
});

test("Esc acts on the area the user is in: a modal first, then the active dock, then the usual chain", () => {
  const base = { modalOpen: false, dockActive: false, boxFocused: false, draftEmpty: true };
  expect(escAction({ ...base, modalOpen: true, dockActive: true })).toBe("modal");
  expect(escAction({ ...base, dockActive: true, boxFocused: true, draftEmpty: false })).toBe("blur");
  expect(escAction({ ...base, dockActive: true, boxFocused: true, draftEmpty: true })).toBe("closeDock");
  expect(escAction({ ...base, dockActive: true, boxFocused: false, draftEmpty: false })).toBe("closeDock");
  expect(escAction({ ...base, dockActive: true, boxFocused: false, draftEmpty: true })).toBe("closeDock");
  expect(escAction(base)).toBe("chain");
  expect(escAction({ ...base, draftEmpty: false, boxFocused: true })).toBe("chain");
});
