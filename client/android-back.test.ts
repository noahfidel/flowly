import { expect, test, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "android" }, BackHandler: {} }));
const { findHostScreen, screenBackHandler } = await import("./android-back");

const fn = () => true;
const screenWith = (isFocused: () => boolean) => ({ isFocused, addListener: fn, dispatch: fn, getState: fn });
const screen = screenWith(fn);
const nodeUnder = (...values: unknown[]) => {
  let fiber: { return: unknown; memoizedProps: { value?: unknown } | null } | null = null;
  for (const value of values.reverse()) fiber = { return: fiber, memoizedProps: value === undefined ? null : { value } };
  return { __internalInstanceHandle: fiber };
};

test("finds the nearest screen navigation object", () => {
  const outer = { ...screen };
  expect(findHostScreen(nodeUnder(undefined, { key: "route" }, screen, outer))).toBe(screen);
});

test("ignores look-alikes without listeners, and other tree shapes", () => {
  expect(findHostScreen(nodeUnder({ isFocused: fn, dispatch: fn, getState: fn }))).toBeNull();
  expect(findHostScreen(null)).toBeNull();
  expect(findHostScreen({})).toBeNull();
});

test("never throws on a hostile tree", () => {
  const hostile = { get __internalInstanceHandle() { throw new Error("no"); } };
  expect(findHostScreen(hostile)).toBeNull();
});

test("takes Back only while Flowly's screen is focused", () => {
  let focused = true;
  const onBack = vi.fn(() => true);
  const press = screenBackHandler(() => nodeUnder(screenWith(() => focused)), onBack);
  expect(press()).toBe(true);
  focused = false;
  expect(press()).toBe(false);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("leaves Back to the host when the screen is missing or fails", () => {
  const onBack = vi.fn(() => true);
  expect(screenBackHandler(() => ({}), onBack)()).toBe(false);
  const broken = screenWith(() => { throw new Error("gone"); });
  expect(screenBackHandler(() => nodeUnder(broken), onBack)()).toBe(false);
  expect(onBack).not.toHaveBeenCalled();
});

test("the bare board lets Back through", () => {
  expect(screenBackHandler(() => nodeUnder(screen), () => false)()).toBe(false);
});
