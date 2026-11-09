import { describe, expect, test } from "vitest";
import { goodIdeaPlan, ideaLinkOptions, ideaOtherOptions, newTaskFromIdea, type ChoiceSession } from "./idea-choice";
import type { Idea } from "../shared/model";

const idea = (over: Partial<Idea> = {}): Idea => ({
  id: "i1",
  taskId: "t1",
  projectId: "p1",
  agentId: "a2",
  title: "Add retry to the importer",
  detail: "Wrap the fetch in a retry with backoff.",
  rationale: "",
  context: "",
  status: "open",
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  ...over,
});
const live = { title: "Importer", status: "development" as const, archivedAt: null };
const a1: ChoiceSession = { id: "a1", title: "Newest" };
const a2: ChoiceSession = { id: "a2", title: "Proposer" };
const gone: ChoiceSession = { id: "a0", title: "Old", archivedAt: "2026-11-01T00:00:00.000Z" };

describe("goodIdeaPlan (IDEAS-SPEC §6, QUICK-TASK-SPEC §10)", () => {
  test("a project idea goes straight to a new task", () => {
    expect(goodIdeaPlan(idea({ taskId: undefined }), undefined, [])).toEqual({ kind: "new-task" });
  });
  test("a finished, archived or gone card goes straight to a new task, with the reason kept", () => {
    expect(goodIdeaPlan(idea(), { ...live, status: "done" }, [a1])).toEqual({ kind: "new-task", blocked: { reason: "finished", title: "Importer" } });
    expect(goodIdeaPlan(idea(), { ...live, status: "cancelled" }, [a1])).toEqual({ kind: "new-task", blocked: { reason: "finished", title: "Importer" } });
    expect(goodIdeaPlan(idea(), { ...live, archivedAt: "2026-11-02T00:00:00.000Z" }, [a1])).toEqual({ kind: "new-task", blocked: { reason: "archived", title: "Importer" } });
    expect(goodIdeaPlan(idea(), undefined, [a1])).toEqual({ kind: "new-task", blocked: { reason: "gone" } });
  });
  test("scope here on a live card: Continue (the proposer's session) suggested first, Start a new task last", () => {
    const plan = goodIdeaPlan(idea({ scope: "here" }), live, [a1, a2, gone]);
    expect(plan.kind).toBe("menu");
    if (plan.kind !== "menu") return;
    expect(plan.entries.map((e) => e.kind)).toEqual(["continue", "send-other", "new-session", "separator", "new-task"]);
    expect(plan.entries[0]).toEqual({ kind: "continue", session: a2, suggested: true });
    expect(plan.entries[1]).toEqual({ kind: "send-other", sessions: [a1, a2], current: a2 });
    expect(plan.entries[2]).toEqual({ kind: "new-session", suggested: false });
    expect(plan.entries[4]).toEqual({ kind: "new-task", suggested: false });
  });
  test("scope here without a live session: Do it in a new session is suggested", () => {
    const plan = goodIdeaPlan(idea({ scope: "here" }), live, [gone]);
    expect(plan.kind === "menu" && plan.entries).toEqual([{ kind: "new-session", suggested: true }, { kind: "separator" }, { kind: "new-task", suggested: false }]);
  });
  test("scope new (or none): Start a new task suggested first", () => {
    const plan = goodIdeaPlan(idea(), live, [a1]);
    expect(plan.kind === "menu" && plan.entries).toEqual([
      { kind: "new-task", suggested: true },
      { kind: "separator" },
      { kind: "continue", session: a1, suggested: false },
      { kind: "new-session", suggested: false },
    ]);
  });
});

describe("ideaOtherOptions: Quick task's Other options… (QUICK-TASK-SPEC §10)", () => {
  test("a live card: the full form, then its card actions in the menu's order", () => {
    expect(ideaOtherOptions(idea({ scope: "here" }), live, [a1, a2])).toEqual([
      { kind: "form" },
      { kind: "continue", session: a2, suggested: true },
      { kind: "send-other", sessions: [a1, a2], current: a2 },
      { kind: "new-session", suggested: false },
    ]);
  });
  test("a project idea: only the full form", () => {
    expect(ideaOtherOptions(idea({ taskId: undefined }), undefined, [])).toEqual([{ kind: "form" }]);
  });
  test("a finished or archived card: the full form and why it cannot continue", () => {
    expect(ideaOtherOptions(idea(), { ...live, status: "done" }, [a1])).toEqual([{ kind: "form" }, { kind: "note", blocked: { reason: "finished", title: "Importer" } }]);
    expect(ideaOtherOptions(idea(), undefined, [a1])).toEqual([{ kind: "form" }, { kind: "note", blocked: { reason: "gone" } }]);
  });
});

describe("newTaskFromIdea (QUICK-TASK-SPEC §10)", () => {
  test("Quick task by default, the full form when Quick task for New task is off", () => {
    expect(newTaskFromIdea(true)).toBe("quick");
    expect(newTaskFromIdea(false)).toBe("form");
  });
});

describe("ideaLinkOptions: an idea link's Other options… (QUICK-TASK-SPEC §10)", () => {
  test("a card that can continue offers its actions, as from the drawer", () => {
    expect(ideaLinkOptions(idea(), live, [a1, a2])).toEqual(ideaOtherOptions(idea(), live, [a1, a2]));
  });
  test("a finished card shows why; a project idea only the form", () => {
    expect(ideaLinkOptions(idea(), { ...live, status: "done" }, [a1])).toEqual([{ kind: "form" }, { kind: "note", blocked: { reason: "finished", title: "Importer" } }]);
    expect(ideaLinkOptions(idea({ taskId: undefined }), undefined, [])).toEqual([{ kind: "form" }]);
  });
  test("a card the board has not read yet is not called gone: only the form", () => {
    expect(ideaLinkOptions(idea(), undefined, [a1])).toEqual([{ kind: "form" }]);
  });
});
