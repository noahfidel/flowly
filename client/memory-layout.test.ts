import { describe, expect, it } from "vitest";
import { emptyCounts, type GuardrailEntry } from "../shared/guardrails";
import { estimateHeight, gridColumns, placeMasonry, sortNotes } from "./memory-layout";

const note = (id: string, patch: Partial<GuardrailEntry> = {}): GuardrailEntry => ({
  id,
  projectId: "p",
  kind: "note",
  noteKind: "decision",
  text: id,
  state: "active",
  stateAt: "2026-10-01T00:00:00.000Z",
  counts: emptyCounts(),
  sources: [],
  by: "agent",
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});
const used = (...tasks: [string, string][]) => ({ ...emptyCounts(), usedBy: tasks.map(([taskId, at]) => ({ taskId, at })), usedAt: tasks.at(-1)?.[1] });

describe("Memory page order (GUARDRAILS-SPEC §7.4)", () => {
  const a = note("a", { createdAt: "2026-10-03T00:00:00.000Z" });
  const b = note("b", { createdAt: "2026-10-02T00:00:00.000Z", counts: used(["t1", "2026-10-05T00:00:00.000Z"], ["t2", "2026-10-06T00:00:00.000Z"]) });
  const c = note("c", { createdAt: "2026-10-01T00:00:00.000Z", counts: used(["t1", "2026-10-09T00:00:00.000Z"]) });
  const pinned = note("pinned", { createdAt: "2026-09-01T00:00:00.000Z", pinned: true });
  it("puts pinned first, then newest, most used or recently used", () => {
    expect(sortNotes([c, a, pinned, b], "newest").map((e) => e.id)).toEqual(["pinned", "a", "b", "c"]);
    expect(sortNotes([c, a, pinned, b], "used").map((e) => e.id)).toEqual(["pinned", "b", "c", "a"]);
    expect(sortNotes([c, a, pinned, b], "recent").map((e) => e.id)).toEqual(["pinned", "c", "b", "a"]);
  });
  it("counts a card that used an entry twice once", () => {
    const twice = note("twice", { counts: used(["t1", "2026-10-05T00:00:00.000Z"], ["t1", "2026-10-06T00:00:00.000Z"]) });
    expect(sortNotes([twice, b], "used").map((e) => e.id)).toEqual(["b", "twice"]);
  });
});

describe("Memory grid", () => {
  it("uses columns at least 340 pt wide, two or three", () => {
    expect([400, 679, 680, 1019, 1020, 1120, 2000].map(gridColumns)).toEqual([2, 2, 2, 2, 3, 3, 3]);
  });
  it("places each entry into the shortest column and keeps earlier placements", () => {
    const items = [{ id: "1", h: 300 }, { id: "2", h: 100 }, { id: "3", h: 100 }, { id: "4", h: 100 }];
    const ids = (cols: { id: string }[][]) => cols.map((col) => col.map((x) => x.id));
    expect(ids(placeMasonry(items, 2, (x) => x.h))).toEqual([["1"], ["2", "3", "4"]]);
    // A new entry on top goes to the shortest column; the others stay where they were.
    const previous = new Map([["1", 0], ["2", 1], ["3", 1], ["4", 1]]);
    expect(ids(placeMasonry([{ id: "0", h: 100 }, ...items], 2, (x) => x.h, previous))).toEqual([["0", "1"], ["2", "3", "4"]]);
    // A placement past the current column count is placed again.
    expect(ids(placeMasonry(items, 2, (x) => x.h, new Map([["1", 3]])))).toEqual([["1"], ["2", "3", "4"]]);
  });
  it("estimates a longer body taller, up to the six-line fold", () => {
    const short = estimateHeight(note("s", { body: "x" }), 340);
    const long = estimateHeight(note("l", { body: "x".repeat(400) }), 340);
    expect(long).toBeGreaterThan(short);
    expect(estimateHeight(note("xl", { body: "x".repeat(4000) }), 340)).toBe(long);
  });
  it("never folds the title, and counts the tags/usage line only when there is one", () => {
    const one = estimateHeight(note("t"), 340);
    expect(estimateHeight(note("t".repeat(400)), 340)).toBeGreaterThan(estimateHeight(note("t".repeat(200)), 340));
    expect(estimateHeight(note("t", { tags: ["api"] }), 340)).toBeGreaterThan(one);
    expect(estimateHeight(note("t", { counts: used(["t1", "2026-10-05T00:00:00.000Z"]) }), 340)).toBeGreaterThan(one);
  });
});
