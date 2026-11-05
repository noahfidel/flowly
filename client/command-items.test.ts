import { expect, test } from "vitest";
import { commandItems } from "./command-items";
import { parseBoardIntent, intentParams } from "./shortcuts";

test("Flowly registers exactly View board then Quick task in the Command Center (QUICK-TASK-SPEC §7)", () => {
  expect(commandItems.map((item) => [item.id, item.title])).toEqual([
    ["open-board", "Flowly: View board"],
    ["board-quick-task", "Flowly: Quick task"],
  ]);
  expect(commandItems.some((item) => item.intent === "attention")).toBe(false);
});

test("View board opens the board plainly; Quick task carries its intent", () => {
  expect(commandItems[0].intent).toBeUndefined();
  expect(parseBoardIntent(intentParams(commandItems[1].intent!, 1), 1)?.intent).toBe("quick-task");
});

test("item ids are unique (the host rejects a duplicate)", () => {
  expect(new Set(commandItems.map((item) => item.id)).size).toBe(commandItems.length);
});
