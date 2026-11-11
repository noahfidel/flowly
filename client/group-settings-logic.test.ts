import { describe, expect, test } from "vitest";
import type { Group, Project } from "../shared/model";
import { agentModelText, currentRevision, groupChoices, groupMembersOf, inheritLabel, inheritedDeliveryText, inheritedDispatcherText, inheritedModelText, afterDiscard, lanesDirtyKey, needsDiscardConfirm, shownGroup, withDirty } from "./group-settings-logic";

const at = "2026-11-10T00:00:00.000Z";
const group = (id: string, position: number, defaults?: Group["defaults"]): Group => ({ id, name: id.toUpperCase(), position, revision: 1, createdAt: at, updatedAt: at, ...(defaults ? { defaults } : {}) });
const claude = { provider: "claude", model: "claude-opus-5-5" };
const codex = { provider: "codex", model: "gpt-6" };

describe("inherited defaults (BOARD-GROUPS-SPEC §5)", () => {
  test("the label shows the inherited value", () => {
    expect(inheritLabel("Draft PR")).toBe("Inherit: Draft PR");
    expect(inheritLabel(agentModelText(claude))).toBe("Inherit: claude · claude-opus-5-5");
  });
  test("a project's empty model inherits the group's, then the host's, then Automatic", () => {
    expect(inheritedModelText(group("g", 0, { agentModel: claude }), codex)).toBe("claude · claude-opus-5-5");
    expect(inheritedModelText(group("g", 0), codex)).toBe("codex · gpt-6");
    expect(inheritedModelText(null, codex)).toBe("codex · gpt-6");
    expect(inheritedModelText(null, null)).toBe("Automatic");
  });
  test("an empty delivery mode inherits the group's, then the host's; unknown values are skipped", () => {
    expect(inheritedDeliveryText(group("g", 0, { deliveryMode: "draft_pr" }), "ready_pr")).toBe("Draft PR");
    expect(inheritedDeliveryText(group("g", 0, { deliveryMode: "later" }), "ready_pr")).toBe("Ready PR");
    expect(inheritedDeliveryText(null, "ready_pr")).toBe("Ready PR");
    expect(inheritedDeliveryText(null, undefined)).toBe("Branch, I bless");
  });
  test("a group's empty dispatcher model inherits the host's, else the built-in default", () => {
    expect(inheritedDispatcherText(claude)).toBe("claude · claude-opus-5-5");
    expect(inheritedDispatcherText(null)).toBe("claude · claude-sonnet-5-5");
  });
});

describe("group members and choices", () => {
  const project = (id: string, groupId: string | undefined, position: number, archived = false) =>
    ({ id, groupId, position, createdAt: at, ...(archived ? { archivedAt: at } : {}) }) as Pick<Project, "id" | "groupId" | "archivedAt" | "position" | "createdAt">;
  test("members in board order, archived last, other groups left out", () => {
    const list = [project("c", "g", 0, true), project("b", "g", 2), project("a", "g", 1), project("x", "h", 0), project("y", undefined, 0)];
    expect(groupMembersOf(list, "g").map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(groupMembersOf(list, "none")).toEqual([]);
  });
  test("move-to-group choices follow tab order", () => {
    expect(groupChoices([group("b", 1), group("a", 0)])).toEqual([{ value: "a", label: "A" }, { value: "b", label: "B" }]);
  });
});

describe("unsaved edits guard and stale state", () => {
  const g = (revision: number) => ({ ...group("g", 0), revision });
  test("withDirty adds and removes ids, keeping the set when nothing changes", () => {
    const none: ReadonlySet<string> = new Set();
    const one = withDirty(none, "a", true);
    expect([...one]).toEqual(["a"]);
    expect(withDirty(one, "a", true)).toBe(one);
    expect(withDirty(none, "a", false)).toBe(none);
    expect(withDirty(one, "a", false).size).toBe(0);
  });
  // Ruling (Noah, 2026-11-11): Discard resets every section with unsaved edits, the lane draft and each project's.
  test("Discard drops every dirty key, the lane draft's and every project section's", () => {
    expect(afterDiscard(new Set([lanesDirtyKey, "p1", "p2"])).size).toBe(0);
    expect(needsDiscardConfirm(afterDiscard(new Set(["p1"])))).toBe(false);
    const clean: ReadonlySet<string> = new Set();
    expect(afterDiscard(clean)).toBe(clean);
  });
  test("a leave asks only while a section is dirty", () => {
    expect(needsDiscardConfirm(new Set())).toBe(false);
    expect(needsDiscardConfirm(new Set(["a"]))).toBe(true);
  });
  test("the written group stands in only until the overview has listed it", () => {
    expect(shownGroup(undefined, g(1), false)?.revision).toBe(1);
    expect(shownGroup(undefined, g(1), true)).toBeUndefined();
    expect(shownGroup(g(1), g(2), true)?.revision).toBe(2);
    expect(shownGroup(g(3), g(2), true)?.revision).toBe(3);
    expect(shownGroup(g(3), undefined, false)?.revision).toBe(3);
    expect(shownGroup(undefined, undefined, false)).toBeUndefined();
  });
  test("a move sends the newest project revision", () => {
    expect(currentRevision({ revision: 2 }, undefined)).toBe(2);
    expect(currentRevision({ revision: 2 }, 4)).toBe(4);
    expect(currentRevision({ revision: 5 }, 4)).toBe(5);
  });
});
