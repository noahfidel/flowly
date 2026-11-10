import { describe, expect, test } from "vitest";
import {
  caughtIds,
  caughtInWindow,
  catchUpPrompt,
  correctionOf,
  guardrailsLedger,
  mergeInto,
  mergePair,
  parseCatchUp,
  recallGuidelines,
  countMisfire,
  emptyCounts,
  guardrailContext,
  guardrailEntrySchema,
  guardrailsSection,
  guidelineToDisplace,
  inScope,
  liveEntry,
  migrateToGuardrails,
  noteToDisplace,
  parseCorrection,
  resolveShortId,
  retirement,
  scopeOf,
  sizeOf,
  toMemoryEntry,
  widenScope,
  type CardItem,
  type GuardrailEntry,
} from "./guardrails";
import type { MemoryEntry, MemoryState } from "./memory";
import type { Project } from "./model";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function guideline(id: string, extra: Partial<GuardrailEntry> = {}): GuardrailEntry {
  return { id, projectId: "p", kind: "guideline", text: `Guideline ${id}`, scope: { types: "all", sizes: "all" }, state: "active", stateAt: ago(1), counts: emptyCounts(), sources: [], by: "learned", revision: 1, createdAt: ago(10), updatedAt: ago(1), ...extra };
}
function note(id: string, extra: Partial<GuardrailEntry> = {}): GuardrailEntry {
  return { id, projectId: "p", kind: "note", noteKind: "pitfall", text: `Note ${id}`, tags: [], keywords: [], state: "active", stateAt: ago(1), counts: emptyCounts(), sources: [], by: "agent", revision: 1, createdAt: ago(10), updatedAt: ago(1), ...extra };
}
function item(id: string, taskId: string, extra: Partial<CardItem> = {}): CardItem {
  return { id, projectId: "p", taskId, text: `Item ${id}`, quote: "q", shape: {}, count: 1, state: "open", createdAt: ago(2), updatedAt: ago(2), ...extra };
}

describe("shape and scope (§6.2, §4.3)", () => {
  test("size bands: ≤50 small, ≤400 medium, above large", () => {
    expect([0, 50, 51, 400, 401].map(sizeOf)).toEqual(["s", "s", "m", "m", "l"]);
  });
  test("in scope by type and size; a card without a type or a known size counts as held; all holds everything", () => {
    const g = { scope: { types: ["feature" as const], sizes: ["s" as const, "m" as const] } };
    expect(inScope(g, { type: "feature", size: "s" })).toBe(true);
    expect(inScope(g, { type: "bugfix", size: "s" })).toBe(false);
    expect(inScope(g, { type: "feature", size: "l" })).toBe(false);
    expect(inScope(g, { size: "m" })).toBe(true);
    expect(inScope(g, { type: "feature" })).toBe(true);
    expect(inScope({ scope: { types: "all", sizes: "all" } }, { type: "docs", size: "l" })).toBe(true);
    expect(inScope({}, { type: "docs", size: "l" })).toBe(true);
  });
  test("a promoted guideline's scope is the union of its cards' known shapes; nothing known is all", () => {
    expect(scopeOf([{ type: "feature", size: "s" }, { type: "bugfix", size: "s" }])).toEqual({ types: ["feature", "bugfix"], sizes: ["s"] });
    expect(scopeOf([{ type: "feature" }, {}])).toEqual({ types: ["feature"], sizes: "all" });
    expect(scopeOf([{}, {}])).toEqual({ types: "all", sizes: "all" });
  });
  test("widening adds the card's type and size, never narrows, and leaves all alone", () => {
    expect(widenScope({ types: ["feature"], sizes: ["s"] }, { type: "bugfix", size: "l" })).toEqual({ scope: { types: ["feature", "bugfix"], sizes: ["s", "l"] }, changed: true });
    expect(widenScope({ types: ["feature"], sizes: "all" }, { type: "feature", size: "l" })).toEqual({ scope: { types: ["feature"], sizes: "all" }, changed: false });
    expect(widenScope({ types: ["feature"], sizes: ["m"] }, {})).toMatchObject({ changed: false });
  });
});

describe("correction parsing (§4.2)", () => {
  test("missing, none, new, same and malformed values", () => {
    expect(parseCorrection(undefined)).toEqual({ kind: "none" });
    expect(parseCorrection({ kind: "none", text: "x" })).toEqual({ kind: "none" });
    expect(parseCorrection({ kind: "new", text: "  Every new  string is in all catalogs " })).toEqual({ kind: "new", text: "Every new string is in all catalogs" });
    expect(parseCorrection({ kind: "same", matches: "#ab12cd34", text: "Every new string" })).toEqual({ kind: "same", matches: "ab12cd34", text: "Every new string" });
    // A "same" that names no line but says what is wrong is a new correction; one that says nothing is none.
    expect(parseCorrection({ kind: "same", text: "Buttons need labels" })).toEqual({ kind: "new", text: "Buttons need labels" });
    expect(parseCorrection({ kind: "same" })).toEqual({ kind: "none" });
    expect(parseCorrection({ kind: "new" })).toEqual({ kind: "none" });
    expect(parseCorrection({ kind: "maybe", text: "x" })).toEqual({ kind: "none" });
    expect(parseCorrection("new")).toEqual({ kind: "none" });
    expect((parseCorrection({ kind: "new", text: "x".repeat(300) }) as { text: string }).text).toHaveLength(120);
  });
  test("read from the summarizer's text output, fences tolerated; no JSON or no field is none", () => {
    expect(correctionOf('```json\n{"update": true, "state": "s", "correction": {"kind": "new", "text": "Add a test"}}\n```')).toEqual({ kind: "new", text: "Add a test" });
    expect(correctionOf('{"update": false}')).toEqual({ kind: "none" });
    expect(correctionOf("no json")).toEqual({ kind: "none" });
    expect(correctionOf(null)).toEqual({ kind: "none" });
  });
  test("a superseded or merged entry resolves to the live end of its chain; a cycle or a missing successor stops", () => {
    const a = guideline("a", { state: "archived", stateReason: "merged", supersededBy: "b" });
    const b = guideline("b", { state: "archived", stateReason: "superseded", supersededBy: "c" });
    const c = guideline("c");
    expect(liveEntry([a, b, c], a)).toBe(c);
    expect(liveEntry([a, b], a)).toBe(b);
    const x = guideline("x", { supersededBy: "y" }), y = guideline("y", { supersededBy: "x" });
    expect(liveEntry([x, y], x)).toBe(y);
    expect(liveEntry([c], c)).toBe(c);
  });
  test("short ids resolve by a unique prefix of at least 6 characters", () => {
    const list = [{ id: "abcdef12-0000" }, { id: "abcdef34-0000" }, { id: "99999999-0000" }];
    expect(resolveShortId("#abcdef12", list)).toBe(list[0]);
    expect(resolveShortId("abcdef", list)).toBeNull();
    expect(resolveShortId("999", list)).toBeNull();
    expect(resolveShortId("999999", list)).toBe(list[2]);
  });
});

describe("the Guardrails section (§4.2, B2)", () => {
  test("in order: in-scope guidelines, this card's items, out-of-scope guidelines, other cards' recent items, paused and recently archived", () => {
    const entries = [
      guideline("aaaaaaaa", { text: "In scope", scope: { types: ["feature"], sizes: "all" } }),
      guideline("bbbbbbbb", { text: "Out of scope", scope: { types: ["docs"], sizes: "all" } }),
      guideline("cccccccc", { text: "Paused one", state: "paused" }),
      guideline("dddddddd", { text: "Archived lately", state: "archived", stateAt: ago(10) }),
      guideline("eeeeeeee", { text: "Archived long ago", state: "archived", stateAt: ago(120) }),
      note("ffffffff"),
    ];
    const items = [item("11111111", "t", { text: "Mine" }), item("22222222", "u", { text: "Theirs" }), item("33333333", "u", { text: "Old", updatedAt: ago(40) }), item("44444444", "u", { text: "Closed", state: "closed" })];
    expect(guardrailsSection({ entries, items, projectId: "p", taskId: "t", shape: { type: "feature" }, now: NOW })).toEqual([
      "#aaaaaaaa guideline: In scope",
      "#11111111 this card: Mine",
      "#bbbbbbbb guideline, out of scope: Out of scope",
      "#22222222 other card: Theirs",
      "#cccccccc guideline, paused: Paused one",
      "#dddddddd guideline, archived: Archived lately",
    ]);
  });
  test("at most 60 lines of at most 120 characters", () => {
    const entries = Array.from({ length: 70 }, (_, i) => guideline(`g${String(i).padStart(7, "0")}`, { text: "x".repeat(200) }));
    const lines = guardrailsSection({ entries, items: [], projectId: "p", taskId: "t", shape: {}, now: NOW });
    expect(lines).toHaveLength(60);
    expect(Math.max(...lines.map((l) => l.length))).toBe(120);
  });
});

describe("counters (§6.6)", () => {
  test("caught: failed in the previous review and passed now, without a dispute", () => {
    const previous = [{ id: "a", state: "failed" }, { id: "b", state: "failed" }, { id: "c", state: "passed" }, { id: "d", state: "failed" }];
    const current = [{ id: "a", state: "passed" }, { id: "b", state: "failed" }, { id: "c", state: "passed" }, { id: "d", state: "passed" }];
    expect(caughtIds(previous, current, ["d"])).toEqual(["a"]);
    expect(caughtIds(undefined, current)).toEqual([]);
  });
  test("misfire times keep the latest ten", () => {
    const counts = emptyCounts();
    for (let i = 0; i < 12; i++) countMisfire(counts, ago(12 - i));
    expect(counts.misfire).toBe(12);
    expect(counts.misfireAt).toHaveLength(10);
    expect(counts.misfireAt!.at(-1)).toBe(ago(1));
  });
});

describe("automatic retirement (§6.7, §4.5)", () => {
  test("guidelines: two misfires in 30 days pause; 20 reviews that never caught archive unless missed lately", () => {
    expect(retirement(guideline("g", { counts: { ...emptyCounts(), misfire: 2, misfireAt: [ago(3), ago(20)] } }), NOW)).toEqual({ state: "paused", reason: "misfired twice in 30 days" });
    expect(retirement(guideline("g", { counts: { ...emptyCounts(), misfire: 2, misfireAt: [ago(3), ago(40)] } }), NOW)).toBeNull();
    expect(retirement(guideline("g", { counts: { ...emptyCounts(), reviews: 20 } }), NOW)).toEqual({ state: "archived", reason: "never caught anything" });
    expect(retirement(guideline("g", { counts: { ...emptyCounts(), reviews: 20, missed: 1, lastMissedAt: ago(30) } }), NOW)).toBeNull();
    expect(retirement(guideline("g", { counts: { ...emptyCounts(), reviews: 20, caught: 1 } }), NOW)).toBeNull();
    expect(retirement(guideline("g", { state: "paused", counts: { ...emptyCounts(), reviews: 25 } }), NOW)).toBeNull();
  });
  test("commands: three unavailable runs pause; an observing one with 3 reviews and a pass becomes active", () => {
    const command = (extra: Partial<GuardrailEntry>): GuardrailEntry => ({ ...guideline("c"), kind: "command", text: "Tests", argv: ["npm", "test"], scope: undefined, ...extra });
    expect(retirement(command({ counts: { ...emptyCounts(), unavailableRun: 3 } }), NOW)).toEqual({ state: "paused", reason: "cannot run" });
    expect(retirement(command({ state: "observing", observe: { reviews: 3, passed: 1 } }), NOW)).toEqual({ state: "active", reason: "observed" });
    expect(retirement(command({ state: "observing", observe: { reviews: 3, passed: 0 } }), NOW)).toBeNull();
  });
  test("notes: 90 days unused archive (from creation when never used); pinned ones stay", () => {
    expect(retirement(note("n", { createdAt: ago(91) }), NOW)).toEqual({ state: "archived", reason: "unused for 90 days" });
    expect(retirement(note("n", { createdAt: ago(200), counts: { ...emptyCounts(), usedAt: ago(10) } }), NOW)).toBeNull();
    expect(retirement(note("n", { createdAt: ago(200), pinned: true }), NOW)).toBeNull();
  });
});

describe("caps and displacement (§3.4)", () => {
  test("a full project gives up the guideline with the lowest caught rate, then the longest since it caught anything", () => {
    const list = Array.from({ length: 20 }, (_, i) => guideline(`g${i}`, { counts: { ...emptyCounts(), reviews: 10, caught: 5, lastCaughtAt: ago(1) } }));
    list[3].counts = { ...emptyCounts(), reviews: 10, caught: 1, lastCaughtAt: ago(2) };
    list[7].counts = { ...emptyCounts(), reviews: 10, caught: 1, lastCaughtAt: ago(9) };
    expect(guidelineToDisplace(list, "p", "new")).toBeNull();
    const fresh = guideline("new");
    expect(guidelineToDisplace([...list, fresh], "p", "new")?.id).toBe("g7");
  });
  test("a full project gives up its longest-unused, unpinned note, never the new one", () => {
    const list = Array.from({ length: 100 }, (_, i) => note(`n${i}`, { createdAt: ago(50 - i * 0.1) }));
    list[0].pinned = true;
    list[1].counts = { ...emptyCounts(), usedAt: ago(1) };
    expect(noteToDisplace([...list, note("new", { createdAt: ago(100) })], "p", "new")?.id).toBe("n2");
  });
});

describe("prevention (§5.1)", () => {
  test("guidelines in scope by the card's type (size ignored), then the notes block", () => {
    const entries = [
      guideline("g1", { text: "Every new UI string is in all language catalogs", scope: { types: ["feature"], sizes: ["s"] }, counts: { ...emptyCounts(), caught: 4 } }),
      guideline("g2", { text: "Docs only", scope: { types: ["docs"], sizes: "all" } }),
      guideline("g3", { text: "Paused", state: "paused" }),
      note("n1", { text: "Use the shared toast" }),
    ];
    const { lines, noteIds } = guardrailContext({ entries }, { id: "t", projectId: "p", title: "Card", description: "", type: "feature" });
    expect(lines).toEqual([
      "Project guardrails (checked when you deliver; 1 of them apply to this card's type):",
      "- Every new UI string is in all language catalogs (caught 4 times)",
      "Project memory (all 1 entries):",
      "- [Pitfall] Use the shared toast (memory n1)",
    ]);
    expect(noteIds).toEqual(["n1"]);
    expect(guardrailContext({ entries: [] }, { id: "t", projectId: "p", title: "Card", description: "" }).lines).toEqual([]);
  });
});

describe("migration (§3.6)", () => {
  const memory = (status: MemoryEntry["status"], extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: `m-${status}`,
    projectId: "p",
    kind: "decision",
    title: `Memory ${status}`,
    body: "Why",
    tags: ["release"],
    keywords: ["k"],
    pinned: false,
    status,
    source: { by: "agent", taskId: "t", agentId: "a", eventId: "e" },
    revision: 3,
    createdAt: ago(5),
    updatedAt: ago(4),
    ...extra,
  });
  test("active and candidate become active notes; dismissed and archived stay archived; clues and the rest move as they are", () => {
    const state: MemoryState = {
      version: 1,
      revision: 9,
      entries: [
        memory("active", { pinned: true, confirmedAt: ago(4), usedAt: ago(1), usedBy: [{ taskId: "u", at: ago(1) }], source: { by: "human" } }),
        memory("candidate", { source: { by: "retro", taskId: "t" }, evidence: "the quote" }),
        memory("dismissed"),
        memory("archived", { archivedReason: "superseded" }),
      ],
      errors: [{ taskId: "t", projectId: "p", at: ago(1), message: "x" }],
      retros: [{ taskId: "t", at: ago(1) }],
      recallStats: { p: { days: { "2026-10-27": { queries: 2, empty: 1 } } } },
      clues: [{ id: "c", taskId: "t", projectId: "p", at: ago(1), kind: "feedback", text: "Not like this" }],
    };
    const out = migrateToGuardrails(state, [], ago(0), () => "new-id");
    const byId = new Map(out.entries.map((e) => [e.id, e]));
    expect(byId.get("m-active")).toMatchObject({ kind: "note", state: "active", noteKind: "decision", pinned: true, by: "user", counts: { usedAt: ago(1), usedBy: [{ taskId: "u", at: ago(1) }] }, stateAt: ago(4), revision: 3 });
    expect(byId.get("m-candidate")).toMatchObject({ state: "active", by: "retro", sources: [{ taskId: "t", quote: "the quote" }] });
    expect(byId.get("m-dismissed")).toMatchObject({ state: "archived", stateReason: "dismissed", by: "agent", source: { taskId: "t", agentId: "a", eventId: "e" } });
    expect(byId.get("m-archived")).toMatchObject({ state: "archived", stateReason: "superseded" });
    expect([out.clues, out.retros, out.recallStats]).toEqual([state.clues, state.retros, state.recallStats]);
    expect(out.errors).toEqual(state.errors);
    for (const e of out.entries) guardrailEntrySchema.parse(e);
    // The memory.* view reads them back as they were, the candidate now active.
    expect(out.entries.map(toMemoryEntry).map((e) => [e.id, e.status, e.archivedReason])).toEqual([
      ["m-active", "active", undefined],
      ["m-candidate", "active", undefined],
      ["m-dismissed", "dismissed", undefined],
      ["m-archived", "archived", "superseded"],
    ]);
  });
  test("command rules become active commands, LLM rules guidelines scoped by their types, paused ones paused; P1 checks are commands too", () => {
    let n = 0;
    const projects: Pick<Project, "id" | "autoReview">[] = [
      {
        id: "p",
        autoReview: {
          enabled: true,
          maxRounds: 2,
          goal: true,
          guidance: "dropped",
          rules: [
            { id: "tests", name: "Tests", kind: "command", argv: ["npm", "test"], timeoutSec: 300 },
            { id: "lint", name: "Lint", kind: "command", argv: ["npm", "run", "lint"], off: true },
            { id: "i18n", name: "i18n", kind: "llm", prompt: "Every new UI string is in all language catalogs.", types: ["feature"] },
            { id: "docs", name: "Docs", kind: "llm", prompt: "The spec is updated.", off: true },
          ],
        },
      },
      { id: "q", autoReview: { enabled: false, maxRounds: 1, checks: [{ name: "Typecheck", argv: ["npm", "run", "typecheck"] }] } },
      { id: "r" },
    ];
    const out = migrateToGuardrails(null, projects, ago(0), () => `id${++n}`);
    expect(out.entries.map((e) => [e.projectId, e.kind, e.text, e.state, e.by, e.argv, e.scope])).toEqual([
      ["p", "command", "Tests", "active", "user", ["npm", "test"], undefined],
      ["p", "command", "Lint", "paused", "user", ["npm", "run", "lint"], undefined],
      ["p", "guideline", "Every new UI string is in all language catalogs.", "active", "user", undefined, { types: ["feature"], sizes: "all" }],
      ["p", "guideline", "The spec is updated.", "paused", "user", undefined, { types: "all", sizes: "all" }],
      ["q", "command", "Typecheck", "active", "user", ["npm", "run", "typecheck"], undefined],
    ]);
    expect(out.entries[0].timeoutSec).toBe(300);
    for (const e of out.entries) guardrailEntrySchema.parse(e);
  });
});

describe("weekly run pieces (§7.3)", () => {
  const g = (id: string, extra: Partial<GuardrailEntry> = {}): GuardrailEntry =>
    guardrailEntrySchema.parse({ id, projectId: "p", kind: "guideline", text: `Rule ${id}`, scope: { types: "all", sizes: "all" }, state: "active", stateAt: ago(1), counts: emptyCounts(), sources: [], by: "learned", revision: 1, createdAt: ago(1), updatedAt: ago(1), ...extra });

  test("merges need two distinct active entries of the project of one kind; ids are #prefixes", () => {
    const entries = [g("aaaaaaaa-1"), g("bbbbbbbb-2"), g("cccccccc-3", { state: "paused" }), g("dddddddd-4", { kind: "note", noteKind: "pitfall", scope: undefined }), g("eeeeeeee-5", { projectId: "q" })];
    expect(mergePair(entries, "p", { keep: "#aaaaaaaa", drop: "#bbbbbbbb" })?.drop.id).toBe("bbbbbbbb-2");
    expect(mergePair(entries, "p", { keep: "#aaaaaaaa", drop: "#cccccccc" })).toBeNull();
    expect(mergePair(entries, "p", { keep: "#aaaaaaaa", drop: "#dddddddd" })).toBeNull();
    expect(mergePair(entries, "p", { keep: "#aaaaaaaa", drop: "#eeeeeeee" })).toBeNull();
    expect(mergePair(entries, "p", { keep: "#aaaaaaaa", drop: "#aaaaaaaa" })).toBeNull();
    expect(mergePair(entries, "p", { keep: "#aaa", drop: "#bbbbbbbb" })).toBeNull();
  });

  test("a merge sums counts, keeps both sources, widens the scope and archives the dropped one as merged", () => {
    const keep = g("k", { scope: { types: ["feature"], sizes: ["s"] }, counts: { ...emptyCounts(), reviews: 3, caught: 1, lastCaughtAt: ago(5) }, sources: [{ taskId: "t1", at: ago(9) }] });
    const drop = g("d", { scope: { types: ["bugfix"], sizes: "all" }, counts: { ...emptyCounts(), reviews: 2, caught: 2, missed: 1, lastCaughtAt: ago(2), misfire: 1, misfireAt: [ago(3)] }, sources: [{ taskId: "t1", at: ago(9) }, { taskId: "t2", at: ago(4) }] });
    mergeInto(keep, drop, ago(0));
    expect(keep.counts).toMatchObject({ reviews: 5, caught: 3, missed: 1, misfire: 1, lastCaughtAt: ago(2), misfireAt: [ago(3)] });
    expect(keep.scope).toEqual({ types: ["feature", "bugfix"], sizes: "all" });
    expect(keep.sources.map((x) => x.taskId)).toEqual(["t1", "t2"]);
    expect(drop).toMatchObject({ state: "archived", stateReason: "merged", supersededBy: "k" });
    // A merged entry stands for its successor when a correction matches it later (§4.3).
    expect(liveEntry([keep, drop], drop).id).toBe("k");
  });

  test("catch-up: one prompt over the numbered words; answers by number, malformed ones read as none", () => {
    const prompt = catchUpPrompt([{ taskId: "aaaaaaaa-1", text: "新文案\n也要进所有语言" }], ["#12345678 guideline: x"]);
    expect(prompt).toContain("1. (card aaaaaaaa) 新文案 也要进所有语言");
    expect(prompt).toContain("#12345678 guideline: x");
    expect(parseCatchUp('```json\n{"corrections":[{"n":2,"kind":"new","text":"Add every catalog"},{"n":9,"kind":"new","text":"out of range"},{"n":1,"kind":"same","matches":"#12345678"},{"n":3,"kind":"bogus"}]}\n```', 3)).toEqual([
      { kind: "same", matches: "12345678" },
      { kind: "new", text: "Add every catalog" },
      { kind: "none" },
    ]);
    expect(() => parseCatchUp("no json", 1)).toThrow(/not JSON/);
  });

  test("caught in the window: failed in one review of a card, passed in its next", () => {
    const r = (taskId: string, at: string, state: string) => ({ taskId, at, action: "review_finished", results: [{ id: "g", state }] });
    const flow = [r("a", ago(40), "failed"), r("a", ago(35), "passed"), r("a", ago(10), "failed"), r("a", ago(9), "passed"), r("b", ago(8), "failed"), r("b", ago(7), "na"), r("c", ago(6), "failed"), r("c", ago(5), "passed")];
    expect(caughtInWindow(flow, NOW - 30 * DAY)).toEqual(new Map([["g", 2]]));
  });

  test("flowly_recall finds active guidelines by their words and the user's; a note kind leaves them out", () => {
    const entries = [
      g("1", { text: "Every new UI string is in all catalogs", sources: [{ taskId: "t", at: ago(1), quote: "新文案也要进所有语言" }], counts: { ...emptyCounts(), caught: 4 } }),
      g("2", { text: "Run the migration test", state: "paused" }),
      g("3", { text: "Keep the scroll position", projectId: "q" }),
    ];
    expect(recallGuidelines(entries, "p", { query: "catalogs string" })).toEqual([{ id: "1", text: "Every new UI string is in all catalogs", scope: { types: "all", sizes: "all" }, quote: "新文案也要进所有语言", caught: 4 }]);
    expect(recallGuidelines(entries, "p", { query: "" }).map((x) => x.id)).toEqual(["1"]);
    expect(recallGuidelines(entries, "p", { query: "catalogs", kind: "pitfall" })).toEqual([]);
  });
});

describe("the Insights ledger (§7.2, §7.5)", () => {
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  const delivered = (taskId: string, h: number) => ({ taskId, at: at(h), action: "status_changed", actor: "agent", to: "in_review" });
  const finished = (taskId: string, h: number, results: { id: string; state: string; kind?: string; gating?: false }[]) => ({ taskId, at: at(h), action: "review_finished", actor: "system", results });
  const event = (action: string, h: number, change: string) => ({ taskId: "a", at: at(h), action, actor: "system", guardrail: { change, kind: "guideline", id: "x" } });

  test("deliveries in 14 days, reviewed, first-review passes (an observing failure passes), judged failures in 30 days, this week's changes", () => {
    const flow = [
      delivered("a", 100),
      finished("a", 99, [{ id: "tests", state: "passed", kind: "command" }, { id: "e2e", state: "failed", kind: "command", gating: false }, { id: "goal", state: "passed", kind: "goal" }]),
      delivered("b", 80),
      finished("b", 79, [{ id: "tests", state: "passed", kind: "command" }, { id: "goal", state: "failed", kind: "goal" }, { id: "g", state: "failed", kind: "guideline" }]),
      // The rerun after a pass does not count again for the same delivery.
      finished("b", 78, [{ id: "goal", state: "passed", kind: "goal" }]),
      delivered("c", 60),
      // Cancelled: no results, not reviewed.
      { taskId: "c", at: at(59), action: "review_finished", actor: "system" },
      delivered("d", 20 * 24),
      finished("d", 20 * 24 - 1, [{ id: "i", state: "failed", kind: "item" }]),
      delivered("e", 40 * 24),
      finished("e", 40 * 24 - 1, [{ id: "g", state: "failed", kind: "guideline" }]),
      event("guardrail_learned", 30, "guideline"),
      event("guardrail_learned", 30, "item"),
      event("guardrail_learned", 20, "widened"),
      event("guardrail_learned", 10, "revived"),
      event("guardrail_retired", 5, "paused"),
      event("guardrail_retired", 10 * 24, "archived"),
    ];
    const entries = [
      guardrailEntrySchema.parse({ id: "m", projectId: "p", kind: "guideline", text: "M", state: "active", stateAt: ago(1), counts: { ...emptyCounts(), misfire: 2, misfireAt: [ago(40), ago(3)] }, sources: [], by: "learned", revision: 1, createdAt: ago(1), updatedAt: ago(1) }),
      guardrailEntrySchema.parse({ id: "o", projectId: "p", kind: "command", text: "E2E", argv: ["npm", "run", "e2e"], state: "observing", stateAt: ago(1), counts: emptyCounts(), sources: [], by: "detect", revision: 1, createdAt: ago(1), updatedAt: ago(1) }),
    ];
    expect(guardrailsLedger({ flow, entries, projectId: "p", now: NOW, tz: "UTC" })).toEqual({
      deliveries: 3,
      reviewed: 2,
      firstPass: 1,
      judged: 3,
      misfires: 1,
      changes: { learned: 1, widened: 1, revived: 1, retired: 1, observing: 1 },
    });
  });
});
