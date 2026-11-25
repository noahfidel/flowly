import { describe, expect, test } from "vitest";
import type { Group, Project } from "../shared/model";
import { umbrellaLossLines, umbrellaLossLinesForDelete, agentModelText, autoReviewMoveNote, autoReviewText, inheritedAutoReviewText, currentRevision, groupChoices, groupMembersOf, inheritLabel, inheritedDeliveryText, inheritedDispatcherText, inheritedModelText, afterDiscard, lanesDirtyKey, needsDiscardConfirm, shownGroup, withDirty } from "./group-settings-logic";

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

describe("auto review at the group level (BOARD-GROUPS-SPEC §5; ruling, Noah 2026-11-18)", () => {
  const on = group("on", 0, { autoReview: { enabled: true, maxRounds: 2 } });
  const off = group("off", 1, { autoReview: { enabled: false, maxRounds: 2 } });
  const unset = group("unset", 2);
  test("a value in one line", () => {
    expect(autoReviewText({ enabled: true, maxRounds: 2 })).toBe("On, 2 rounds");
    expect(autoReviewText({ enabled: true, maxRounds: 1 })).toBe("On, 1 round");
    expect(autoReviewText({ enabled: false, maxRounds: 3 })).toBe("Off");
  });
  test("what a project without an override inherits, with the group's name", () => {
    expect(inheritedAutoReviewText(on)).toBe("Inherited from ON: On, 2 rounds");
    expect(inheritedAutoReviewText(unset)).toBe("Inherited from UNSET: Off");
    expect(inheritedAutoReviewText(null)).toBe("Inherited: Off");
  });
  test("a move notes the change only for an inheriting project whose value differs in the target group", () => {
    const inherits = { autoReview: undefined };
    expect(autoReviewMoveNote(inherits, on, off)).toBe("Auto review will follow OFF: Off.");
    expect(autoReviewMoveNote(inherits, off, on)).toBe("Auto review will follow ON: On, 2 rounds.");
    expect(autoReviewMoveNote(inherits, off, unset)).toBeNull();
    expect(autoReviewMoveNote({ autoReview: { enabled: true, maxRounds: 2 } }, on, off)).toBeNull();
  });
});

describe("umbrella warnings on a group move (UMBRELLA-SPEC §9)", () => {
  const project = (id: string, groupId: string) => ({ id, groupId, title: id, position: 0, createdAt: at }) as unknown as Project;
  const member = (id: string, projectId: string) => ({ id, projectId, title: id, umbrella: { id: "u1" } }) as never;
  const summary = { id: "u1", groupId: "g1", title: "Fresh context" } as never;
  const board = {
    groups: [group("g1", 0), group("g2", 1)],
    projects: [project("a", "g1"), project("b", "g1")],
    tasks: [member("t1", "a"), member("t2", "a"), member("t3", "b")],
    umbrellas: [summary],
  };
  test("moving one project of a split umbrella names how many cards leave it", () => {
    expect(umbrellaLossLines(board, [{ projectId: "a", groupId: "g2" }])).toEqual(["Fresh context loses 2 cards"]);
    expect(umbrellaLossLines(board, [{ projectId: "b", groupId: "g2" }])).toEqual(["Fresh context loses 1 card"]);
  });
  test("moving every member's project together loses nothing", () => {
    expect(umbrellaLossLines(board, [{ projectId: "a", groupId: "g2" }, { projectId: "b", groupId: "g2" }])).toEqual([]);
  });
  test("deleting a group sends all its projects to the default group", () => {
    expect(umbrellaLossLinesForDelete(board, "g1", "g2")).toEqual([]);
    // Project b is in a third group: the default group cannot hold every member, so all three cards leave.
    expect(umbrellaLossLinesForDelete({ ...board, projects: [project("a", "g1"), project("b", "g3")] }, "g1", "g2")).toEqual(["Fresh context loses 3 cards"]);
    expect(umbrellaLossLinesForDelete(board, "g1", undefined)).toEqual([]);
  });
});
