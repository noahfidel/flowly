import { expect, test } from "vitest";
import { defaultDeliveryMode, deliveryLine, deliveryModeLabels, deliveryModeLocked, deliveryModes, effectiveDeliveryMode, resolveDeliveryMode } from "./delivery-mode";
import { deliverySettings, deliverySettingsValues } from "./settings";
import { taskEdit, taskInput, taskSchema } from "./model";

test("the four modes, with the branch default (DELIVERY-MODE-SPEC §1)", () => {
  expect(deliveryModes).toEqual(["branch", "draft_pr", "ready_pr", "ship_main"]);
  expect(defaultDeliveryMode).toBe("branch");
  expect(deliveryModes.map((m) => deliveryModeLabels[m])).toEqual(["Branch, I bless", "Draft PR", "Ready PR", "Ship to main"]);
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
  for (const status of ["backlog", "todo", "development", "blocked", "done", "cancelled"] as const) {
    expect(deliveryModeLocked({ status }), status).toBe(false);
    // Once delivered, it stays fixed in every lane (ruling 2026-11-09).
    expect(deliveryModeLocked({ status, deliveredAt: "2026-11-09T00:00:00.000Z" }), status).toBe(true);
  }
  // A card in a delivery lane with no mark yet (written before the mark) counts as delivered.
  for (const status of ["in_review", "committed", "integrated"] as const) expect(deliveryModeLocked({ status }), status).toBe(true);
  const stored = { id: "t", projectId: "p", workspaceId: "w", sourcePath: "/r", repoPaths: [], title: "T", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", archivedAt: null };
  expect(taskSchema.parse({ ...stored, deliveredAt: "2026-11-09T00:00:00.000Z" }).deliveredAt).toBe("2026-11-09T00:00:00.000Z");
});

test("resolveDeliveryMode: card, project, group, host, then the built-in default (board groups spec §5)", () => {
  expect(resolveDeliveryMode({ card: "ready_pr", project: "draft_pr", group: "draft_pr", host: "draft_pr" })).toEqual({ mode: "ready_pr", source: "card" });
  expect(resolveDeliveryMode({ project: "draft_pr", group: "ready_pr", host: "ready_pr" })).toEqual({ mode: "draft_pr", source: "project" });
  expect(resolveDeliveryMode({ group: "ready_pr", host: "draft_pr" })).toEqual({ mode: "ready_pr", source: "group" });
  expect(resolveDeliveryMode({ host: "draft_pr" })).toEqual({ mode: "draft_pr", source: "host" });
  expect(resolveDeliveryMode({})).toEqual({ mode: "branch", source: "host" });
});

test("resolveDeliveryMode skips a level that is not a known mode", () => {
  expect(resolveDeliveryMode({ card: "from_the_future", project: 7, group: "ready_pr", host: "draft_pr" })).toEqual({ mode: "ready_pr", source: "group" });
  expect(resolveDeliveryMode({ card: "nope", project: "", group: null, host: "draft_pr" })).toEqual({ mode: "draft_pr", source: "host" });
  expect(resolveDeliveryMode({ card: "nope", host: "also_nope" })).toEqual({ mode: "branch", source: "host" });
});

test("the Ship to main line states the ship steps, the stop rules and the no-force rule (DELIVERY-MODE-SPEC §3, §4)", () => {
  const line = deliveryLine("ship_main");
  expect(line).toMatch(/^Delivery: ship to main only after the card's checks pass and its review has no open findings\./);
  expect(line).toContain("git push origin main");
  expect(line).toContain("Never force-push and never push any other branch");
  expect(line).toContain("the user's permission prompt");
  expect(line).toContain("leaving the card In review");
});

test("a Ship to main card or a group default of it resolves and survives (DELIVERY-MODE-SPEC §2, board groups §5)", () => {
  expect(resolveDeliveryMode({ group: "ship_main", host: "branch" })).toEqual({ mode: "ship_main", source: "group" });
  expect(effectiveDeliveryMode("ship_main")).toBe("ship_main");
  expect(taskEdit.parse({ id: "t", revision: 1, deliveryMode: "ship_main" }).deliveryMode).toBe("ship_main");
  expect(taskInput.parse({ projectId: "p", operationId: "o", title: "T", mode: "directory", deliveryMode: "ship_main" }).deliveryMode).toBe("ship_main");
});
