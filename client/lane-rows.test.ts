import { expect, test } from "vitest";
import { laneRows, settledPage } from "./lane-rows";

const card = (id: string) => ({ id });
const shape = (rows: ReturnType<typeof laneRows<{ id: string }>>) => rows.map((r) => (r.kind === "task" ? r.task.id : r.kind));

test("recent cards come first, then the older toggle, then older cards only when shown", () => {
  expect(shape(laneRows([card("a"), card("b")], [card("o")], false))).toEqual(["a", "b", "older"]);
  expect(shape(laneRows([card("a")], [card("o1"), card("o2")], true))).toEqual(["a", "older", "o1", "o2"]);
  expect(shape(laneRows([card("a")], [], true))).toEqual(["a"]);
});

test("an empty lane has one placeholder that knows whether older cards exist", () => {
  expect(laneRows([], [], false)).toEqual([{ key: "empty", kind: "empty", hasOlder: false }]);
  const rows = laneRows([], [card("o")], false);
  expect(rows).toEqual([
    { key: "empty", kind: "empty", hasOlder: true },
    { key: "older", kind: "older" },
  ]);
});

test("row keys are unique, so a card never shares a key with a placeholder", () => {
  const keys = laneRows([card("a")], [card("o")], true).map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("rows that did not change keep their identity", async () => {
  const { sameRows } = await import("./lane-rows");
  const a = card("a"),
    b = card("b");
  const first = laneRows([a, b], [], false);
  expect(sameRows(first, laneRows([a, b], [], false))).toBe(first);
  const edited = laneRows([a, { id: "b" }], [], false);
  expect(sameRows(first, edited)).toBe(edited);
  const shorter = laneRows([a], [], false);
  expect(sameRows(first, shorter)).toBe(shorter);
  const first2 = laneRows([], [], false);
  const withOlder = laneRows([], [a], false);
  expect(sameRows(first2, withOlder)).toBe(withOlder);
  expect(sameRows(undefined, first)).toBe(first);
});

test("a released lane pager rests on the nearest page within its lanes", () => {
  expect(settledPage(0, 390, 7)).toBe(0);
  expect(settledPage(390 * 2 + 120, 390, 7)).toBe(2);
  expect(settledPage(390 * 2 + 250, 390, 7)).toBe(3);
  expect(settledPage(-40, 390, 7)).toBe(0);
  expect(settledPage(390 * 9, 390, 7)).toBe(6);
  expect(settledPage(500, 0, 7)).toBe(0);
});
