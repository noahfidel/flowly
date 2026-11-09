import { expect, test } from "vitest";
import { defaultDeliveryMode, deliveryLine, deliveryModeLabels, deliveryModeLocked, deliveryModes, effectiveDeliveryMode } from "./delivery-mode";
import { deliverySettings, deliverySettingsValues } from "./settings";
import { taskEdit, taskInput, taskSchema } from "./model";

test("the three modes, with the branch default (DELIVERY-MODE-SPEC §1)", () => {
  expect(deliveryModes).toEqual(["branch", "draft_pr", "ready_pr"]);
  expect(defaultDeliveryMode).toBe("branch");
  expect(deliveryModes.map((m) => deliveryModeLabels[m])).toEqual(["Branch, I bless", "Draft PR", "Ready PR"]);
});

test("each mode's agent-facing line (§3)", () => {
  expect(deliveryLine("branch")).toBe(`Delivery: commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch.`);
  expect(deliveryLine("draft_pr")).toMatch(/^Delivery: push the card's branch and open a draft PR; register its URL as an output\./);
  expect(deliveryLine("ready_pr")).toMatch(/^Delivery: push the card's branch and open a PR ready for review; register its URL as an output\./);
});

test("the PR lines keep the user's permission prompt and the review-notes rule (§3, §4)", () => {
  for (const mode of ["draft_pr", "ready_pr"] as const) expect(deliveryLine(mode)).toContain("still go through the user's permission prompt, which the user answers");
  expect(deliveryLine("ready_pr")).toContain("Never mark a PR ready while review notes are open");
  expect(deliveryLine("branch")).not.toContain("permission");
});

test("an unknown or missing stored mode gives the fallback (§2)", () => {
  expect(effectiveDeliveryMode("ready_pr", "branch")).toBe("ready_pr");
  expect(effectiveDeliveryMode(undefined, "draft_pr")).toBe("draft_pr");
  expect(effectiveDeliveryMode("auto_merge", "draft_pr")).toBe("draft_pr");
  expect(effectiveDeliveryMode(42)).toBe("branch");
});

test("the setting defaults to branch, also from unreadable values", () => {
  expect(deliverySettingsValues({})).toEqual({ defaultMode: "branch" });
  expect(deliverySettingsValues({ defaultMode: "draft_pr" })).toEqual({ defaultMode: "draft_pr" });
  expect(deliverySettingsValues({ defaultMode: "nope" })).toEqual({ defaultMode: "branch" });
  expect(deliverySettings.id).toBe("delivery");
});

test("New task accepts only the three modes; a stored card keeps any string (§5)", () => {
  const base = { projectId: "p", operationId: "o", title: "T", mode: "directory" as const };
  expect(taskInput.parse({ ...base, deliveryMode: "draft_pr" }).deliveryMode).toBe("draft_pr");
  expect(taskInput.parse(base).deliveryMode).toBeUndefined();
  expect(() => taskInput.parse({ ...base, deliveryMode: "auto_merge" })).toThrow();
  const stored = { id: "t", projectId: "p", workspaceId: "w", sourcePath: "/r", repoPaths: [], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", archivedAt: null };
  expect(taskSchema.parse({ ...stored, deliveryMode: "from_the_future" }).deliveryMode).toBe("from_the_future");
  // No length cap on what a newer version may have stored: it still loads.
  const long = `mode_${"x".repeat(60)}`;
  expect(taskSchema.parse({ ...stored, deliveryMode: long }).deliveryMode).toBe(long);
});

test("Edit accepts only the three modes, and the mode is fixed once the card delivers (§2)", () => {
  expect(taskEdit.parse({ id: "t", revision: 1, deliveryMode: "ready_pr" }).deliveryMode).toBe("ready_pr");
  expect(taskEdit.parse({ id: "t", revision: 1 }).deliveryMode).toBeUndefined();
  expect(() => taskEdit.parse({ id: "t", revision: 1, deliveryMode: "auto_merge" })).toThrow();
  for (const status of ["backlog", "todo", "development", "blocked", "done", "cancelled"] as const) expect(deliveryModeLocked(status), status).toBe(false);
  for (const status of ["in_review", "committed", "integrated"] as const) expect(deliveryModeLocked(status), status).toBe(true);
});
