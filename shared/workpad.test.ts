import { describe, expect, test } from "vitest";
import { workpadSchema, type Workpad } from "./model";
import { mergeWorkpad, planFromTimeline, workpadNote, workpadSignal, type WorkpadDraft } from "./workpad";

const t0 = "2026-10-19T00:00:00.000Z",
  t1 = "2026-10-19T01:00:00.000Z";

function pad(over: Partial<Workpad> = {}): Workpad {
  return { taskId: "t", projectId: "p", revision: 1, acceptance: [], updatedAt: t0, updatedBy: "agent", ...over };
}

describe("reading a workpad written before guardrails (GUARDRAILS-SPEC §7.1)", () => {
  test("checks, confusions, the environment stamp, HEAD and the delivery marker are dropped; acceptance stays", () => {
    const old = {
      ...pad({ acceptance: [{ id: "a", text: "Works", done: true, by: "agent", at: t0 }] }),
      validation: [{ id: "v", text: "tests", state: "pass", sha: "aaaaaaaaaaaa", by: "agent", at: t0 }],
      confusions: [{ id: "c", text: "unclear", at: t0 }],
      env: { host: "h", path: "/p", head: null },
      head: { sha: "aaaaaaaaaaaa", dirty: false, at: t0 },
      delivery: { unchecked: 0, failed: 0, unrun: 0, stale: 0, total: 0, revision: 1, eventId: "e", at: t0 },
    };
    const read = workpadSchema.parse(old);
    expect(Object.keys(read).sort()).toEqual(["acceptance", "projectId", "revision", "taskId", "updatedAt", "updatedBy"]);
    expect(read.acceptance).toHaveLength(1);
  });
});

describe("merging an agent's full replacement (§3.1)", () => {
  const ctx = { now: t1 };
  const draft = (over: Partial<WorkpadDraft> = {}): WorkpadDraft => ({ acceptance: [], ...over });

  test("new items get slug ids; unchanged items keep who changed them and when", () => {
    const first = mergeWorkpad(undefined, draft({ acceptance: [{ text: "Shows Checks 3/5", done: false }, { text: "Shows Checks 3/5 too", done: false }] }), ctx);
    expect(first.acceptance.map((a) => a.id)).toEqual(["shows-checks-3-5", "shows-checks-3-5-too"]);
    // A person ticked the first one; the agent sends it back unchanged, matched by text.
    const ticked = { ...first, acceptance: [{ ...first.acceptance[0]!, done: true, by: "human" as const, at: t0 }, first.acceptance[1]!] };
    const next = mergeWorkpad(ticked, draft({ acceptance: [{ text: "shows checks 3/5", done: true }, { id: "shows-checks-3-5-too", text: "Shows Checks 3/5 too", done: true }] }), { now: "2026-10-19T02:00:00.000Z" });
    expect(next.acceptance[0]).toMatchObject({ id: "shows-checks-3-5", by: "agent" }); // text changed (case)
    expect(next.acceptance[1]).toMatchObject({ id: "shows-checks-3-5-too", done: true, by: "agent" });
    const same = mergeWorkpad(ticked, draft({ acceptance: [{ text: "Shows Checks 3/5", done: true }] }), ctx);
    expect(same.acceptance[0]).toMatchObject({ by: "human", at: t0 });
  });

  test("CJK text without ids still gets distinct ids and keeps them by text", () => {
    const first = mergeWorkpad(undefined, draft({ acceptance: [{ text: "不清楚范围", done: false }, { text: "不清楚优先级", done: false }] }), ctx);
    expect(first.acceptance.map((c) => c.id)).toEqual(["item", "item-2"]);
    const again = mergeWorkpad(first, draft({ acceptance: [{ text: "不清楚优先级", done: false }] }), ctx);
    expect(again.acceptance).toEqual([first.acceptance[1]]);
  });

  test("duplicate explicit ids are refused", () => {
    expect(() => mergeWorkpad(undefined, draft({ acceptance: [{ id: "x", text: "a", done: false }, { id: "x", text: "b", done: false }] }), ctx)).toThrow(/Duplicate/);
  });

  test("limits", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ text: `c${i}`, done: false }));
    expect(() => mergeWorkpad(undefined, draft({ acceptance: many }), ctx)).toThrow(/At most 20/);
  });
});

describe("card signal and event note (§7.1)", () => {
  test("Acceptance n/m, nothing without a list", () => {
    const w = pad({ acceptance: [{ id: "a", text: "a", done: true, by: "agent", at: t0 }, { id: "b", text: "b", done: false, by: "agent", at: t0 }] });
    expect(workpadSignal(w)).toEqual({ kind: "acceptance", done: 1, total: 2 });
    expect(workpadSignal(pad())).toBeNull();
    expect(workpadSignal(null)).toBeNull();
  });

  test("event note", () => {
    expect(workpadNote(pad({ acceptance: [{ id: "a", text: "a", done: true, by: "agent", at: t0 }] }))).toBe("Acceptance 1/1");
    expect(workpadNote(pad())).toBe("Workpad cleared");
  });
});

describe("plan from the native todo list (§2.2)", () => {
  test("the last todo of the turn; none keeps the previous plan; empty clears it", () => {
    const timeline = [
      { type: "todo", items: [{ text: "old", completed: false }] },
      { type: "assistant_message" },
      {
        type: "todo",
        items: [
          { text: "Write spec", completed: true },
          { text: "Implement", completed: false, status: "in_progress" },
          { text: "  ", completed: false },
          { text: "Test", completed: false },
        ],
      },
    ];
    expect(planFromTimeline(timeline)).toEqual([
      { text: "Write spec", status: "completed" },
      { text: "Implement", status: "in_progress" },
      { text: "Test", status: "pending" },
    ]);
    expect(planFromTimeline([{ type: "assistant_message" }])).toBeUndefined();
    expect(planFromTimeline(undefined)).toBeUndefined();
    expect(planFromTimeline([{ type: "todo", items: [] }])).toEqual([]);
  });
});
