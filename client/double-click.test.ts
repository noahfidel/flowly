import { expect, test } from "vitest";
import { isMouseDoubleClick } from "./double-click";

/** Board card double click (UI-UX-SPEC "card double click"): only the second click of a mouse double click counts. */

test("a mouse double click (detail 2) counts", () => {
  expect(isMouseDoubleClick({ detail: 2, pointerType: "mouse" }, null)).toBe(true);
});

test("single and triple clicks do not", () => {
  expect(isMouseDoubleClick({ detail: 1, pointerType: "mouse" }, "mouse")).toBe(false);
  expect(isMouseDoubleClick({ detail: 3, pointerType: "mouse" }, "mouse")).toBe(false);
});

test("keyboard and native presses (no or zero detail) do not", () => {
  expect(isMouseDoubleClick({ detail: 0 }, "mouse")).toBe(false);
  expect(isMouseDoubleClick({}, "mouse")).toBe(false);
  expect(isMouseDoubleClick({ detail: undefined, pointerType: "mouse" }, "mouse")).toBe(false);
});

test("touch and pen do not", () => {
  expect(isMouseDoubleClick({ detail: 2, pointerType: "touch" }, "mouse")).toBe(false);
  expect(isMouseDoubleClick({ detail: 2, pointerType: "pen" }, "mouse")).toBe(false);
});

test("without a pointer type on the event, the last pointer decides", () => {
  expect(isMouseDoubleClick({ detail: 2 }, "mouse")).toBe(true);
  expect(isMouseDoubleClick({ detail: 2 }, null)).toBe(false);
  expect(isMouseDoubleClick({ detail: 2, pointerType: "" }, "mouse")).toBe(true);
  expect(isMouseDoubleClick({ detail: 2 }, "touch")).toBe(false);
});

test("no event does not count", () => {
  expect(isMouseDoubleClick(null, "mouse")).toBe(false);
  expect(isMouseDoubleClick(undefined, "mouse")).toBe(false);
});
