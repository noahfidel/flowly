import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createBlurCloser } from "./tag-input-logic";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a blur with nothing typed closes the open input after the delay; focus or a suggestion tap keeps it", () => {
  const close = vi.fn();
  const c = createBlurCloser(close, 200);
  c.opened();
  c.blurred(() => true);
  c.cancel();
  vi.advanceTimersByTime(500);
  expect(close).not.toHaveBeenCalled();
  c.blurred(() => false);
  vi.advanceTimersByTime(500);
  expect(close).not.toHaveBeenCalled();
  c.blurred(() => true);
  vi.advanceTimersByTime(200);
  expect(close).toHaveBeenCalledTimes(1);
});

test("the late blur after Esc/Enter closed the input arms nothing, so reopening within the delay stays open", () => {
  const close = vi.fn();
  const c = createBlurCloser(close, 200);
  c.opened();
  c.closed(); // Esc: close() removes the focused input
  c.blurred(() => true); // the blur TextBox sends at unmount
  expect(vi.getTimerCount()).toBe(0);
  c.opened(); // "Add tag" again at once
  vi.advanceTimersByTime(500);
  expect(close).not.toHaveBeenCalled();
});

test("a blur pending when the editor unmounts, or one sent after it, never fires", () => {
  const close = vi.fn();
  const c = createBlurCloser(close, 200, true);
  c.blurred(() => true);
  c.closed(); // the editor's unmount cleanup
  expect(vi.getTimerCount()).toBe(0);
  c.blurred(() => true); // the child TextBox's cleanup runs after the parent's
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(500);
  expect(close).not.toHaveBeenCalled();
});
