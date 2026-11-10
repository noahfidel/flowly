import { expect, test } from "vitest";
import { findHostHorizontalScroll } from "./host-horizontal-scroll";

const registry = { registerScrollOffset() {}, unregisterScrollOffset() {}, isAnyScrolledRight: { value: false } };
const nodeUnder = (...values: unknown[]) => {
  let fiber: { return: unknown; memoizedProps: { value?: unknown } | null } | null = null;
  for (const value of values.reverse()) fiber = { return: fiber, memoizedProps: value === undefined ? null : { value } };
  return { __internalInstanceHandle: fiber };
};

test("finds the nearest provider shaped like Paseo's horizontal-scroll registry", () => {
  expect(findHostHorizontalScroll(nodeUnder(undefined, { theme: 1 }, registry))).toBe(registry);
});

test("ignores look-alikes without the shared value, and other tree shapes", () => {
  const lookAlike = { registerScrollOffset() {}, unregisterScrollOffset() {} };
  expect(findHostHorizontalScroll(nodeUnder(lookAlike))).toBeNull();
  expect(findHostHorizontalScroll(null)).toBeNull();
  expect(findHostHorizontalScroll({})).toBeNull();
  const cyclic: { return?: unknown; memoizedProps: null } = { memoizedProps: null };
  cyclic.return = cyclic;
  expect(findHostHorizontalScroll({ __internalInstanceHandle: cyclic })).toBeNull();
});

test("never throws on a hostile tree", () => {
  const hostile = { get __internalInstanceHandle() { throw new Error("no"); } };
  expect(findHostHorizontalScroll(hostile)).toBeNull();
});
