import { expect, test } from "vitest";
import type { BoardEvent } from "./model";
import { currentWrapup, wrappedUpTaskIds } from "./wrapup-state";

let n = 0;
const ev = (action: string, extra: Partial<BoardEvent> = {}): BoardEvent =>
  ({ id: String(++n), taskId: "t", actor: "human", action, at: new Date(n * 1000).toISOString(), ...extra }) as BoardEvent;

test("a wrap-up applies until the workspace is restored or the card leaves Done/Cancelled", () => {
  const done = ev("status_changed", { from: "development", to: "done" });
  expect(currentWrapup([done], "t")).toBeNull();
  const wrap = ev("wrapped_up", { note: "1 session(s) archived; workspace archived; card kept" });
  expect(currentWrapup([done, wrap], "t")).toBe(wrap);
  const auto = ev("workspace_auto_archived");
  expect(currentWrapup([done, auto, ev("status_changed", { from: "done", to: "cancelled" })], "t")).toBe(auto);
  expect(currentWrapup([done, wrap, ev("status_changed", { from: "done", to: "development" })], "t")).toBeNull();
  expect(currentWrapup([done, wrap, ev("workspace_restored")], "t")).toBeNull();
  expect(currentWrapup([done, { ...wrap, taskId: "other" }], "t")).toBeNull();
});

test("wrappedUpTaskIds agrees with currentWrapup across wrap, restore, reopen and re-wrap", () => {
  const other = (action: string, extra: Partial<BoardEvent> = {}) => ev(action, { taskId: "u", ...extra });
  const seqs: BoardEvent[][] = [
    [],
    [ev("status_changed", { to: "done" })],
    [ev("status_changed", { to: "done" }), ev("wrapped_up")],
    [ev("wrapped_up"), ev("workspace_restored")],
    [ev("wrapped_up"), ev("status_changed", { from: "done", to: "development" })],
    [ev("wrapped_up"), ev("status_changed", { from: "done", to: "cancelled" })],
    [ev("wrapped_up"), ev("workspace_restored"), ev("workspace_auto_archived")],
    [ev("wrapped_up"), ev("status_changed", { to: "development" }), ev("status_changed", { to: "done" }), ev("wrapped_up")],
    [ev("workspace_auto_archived"), other("wrapped_up"), other("workspace_restored"), ev("progress_reported")],
  ];
  for (const events of seqs) {
    const set = wrappedUpTaskIds(events);
    for (const id of ["t", "u"]) expect(set.has(id)).toBe(currentWrapup(events, id) !== null);
  }
});
