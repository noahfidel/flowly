import { describe, expect, test } from "vitest";
import { collapseGroupAutoReview, continuesRound, conversationForReview, hasEvidence, joinCommand, reviewContext, reviewProgress, reviewVerdict, reworkMessage, splitCommand, visibleReview, effectiveAutoReview, projectAutoReview } from "./auto-review";
import { projectSchema, reviewSchema, type BoardEvent, type Group, type Project, type Review, type ReviewItem } from "./model";

const review = (state: Review["state"], extra: Partial<Review> = {}): Review => ({
  trigger: { eventId: "e", agentId: "a", from: "development" },
  round: 1,
  maxRounds: 2,
  state,
  fingerprint: { taskRevision: 1, workpadRevision: 1, dirty: false },
  shared: true,
  items: [],
  startedAt: "2026-10-28T00:00:00.000Z",
  finishedAt: "2026-10-28T00:01:00.000Z",
  ...extra,
});
const event = (action: string, at: string, extra: Partial<BoardEvent> = {}): BoardEvent => ({ id: `${action}${at}`, taskId: "t", actor: "system", action, at, ...extra });

test("settings commands split on spaces, quotes keep spaces, nothing else is shell syntax", () => {
  expect(splitCommand("  npm run   typecheck ")).toEqual(["npm", "run", "typecheck"]);
  expect(splitCommand(`npx vitest run "a b.test.ts" 'x y'`)).toEqual(["npx", "vitest", "run", "a b.test.ts", "x y"]);
  expect(splitCommand("echo $HOME | wc")).toEqual(["echo", "$HOME", "|", "wc"]);
  expect(joinCommand(["npx", "vitest", "a b.ts"])).toBe(`npx vitest "a b.ts"`);
  expect(splitCommand(joinCommand(["npx", "vitest", "a b.ts"]))).toEqual(["npx", "vitest", "a b.ts"]);
});

test("a delivery continues the round only after a rework with at most the rework turn in between", () => {
  const prev = review("rework");
  expect(continuesRound([], "t", prev)).toBe(true);
  expect(continuesRound([event("agent.turn_started", "2026-10-28T00:02:00.000Z")], "t", prev)).toBe(true);
  const twoTurns = [event("agent.turn_started", "2026-10-28T00:02:00.000Z"), event("agent.turn_started", "2026-10-28T00:03:00.000Z")];
  expect(continuesRound(twoTurns, "t", prev)).toBe(false);
  expect(continuesRound([event("status_changed", "2026-10-28T00:02:00.000Z", { actor: "human" })], "t", prev)).toBe(false);
  // Events before the review finished do not count.
  expect(continuesRound([event("status_changed", "2026-10-27T00:00:00.000Z", { actor: "human" })], "t", prev)).toBe(true);
  for (const state of ["passed", "failed", "unavailable", "cancelled", "running"] as const) expect(continuesRound([], "t", review(state))).toBe(false);
  expect(continuesRound([], "t", undefined)).toBe(false);
});

test("the card shows a review only where that review left it", () => {
  const at = (status: string, state: Review["state"]) => visibleReview({ status: status as never, review: review(state), archivedAt: null })?.state ?? null;
  expect(at("in_review", "running")).toBe("running");
  expect(at("done", "passed")).toBeNull();
  expect(at("test", "rework")).toBe("rework");
  expect(at("in_review", "rework")).toBeNull();
  expect(at("blocked", "failed")).toBe("failed");
  expect(at("in_review", "failed")).toBe("failed");
  expect(at("development", "unavailable")).toBe("unavailable");
  expect(at("in_review", "cancelled")).toBe("cancelled");
  expect(at("development", "cancelled")).toBeNull();
  expect(visibleReview({ status: "in_review", review: review("passed"), archivedAt: "x" })).toBeNull();
});

const item = (id: string, kind: ReviewItem["kind"], state: ReviewItem["state"], extra: Partial<ReviewItem> = {}): ReviewItem => ({ id, kind, name: id, gating: true, state, ...extra });

test("settings narrow to the switch and the rounds; stored rules, goal and guidance are kept on disk but ignored (GUARDRAILS-SPEC §8)", () => {
  const stored = { enabled: true, maxRounds: 3, rules: [{ id: "a", name: "A", kind: "command", argv: ["x"] }], goal: false, guidance: "g", checks: [] };
  expect(effectiveAutoReview({ autoReview: stored }, null)).toEqual({ enabled: true, maxRounds: 3, source: "project" });
  expect(effectiveAutoReview(null, null)).toEqual({ enabled: false, maxRounds: 2, source: "default" });
  // A project saved before guardrails still reads; a reviewDraft is dropped.
  const project = projectSchema.parse({ id: "p", title: "P", description: "", paseoProjectId: "n", primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: "x", updatedAt: "x", archivedAt: null, autoReview: stored, reviewDraft: { rules: [] } });
  expect(project.autoReview?.enabled).toBe(true);
  expect(project).not.toHaveProperty("reviewDraft");
});

test("a review written before guardrails reads its rules as items", () => {
  const old = { ...review("rework"), items: undefined, rules: [
    { id: "unit", kind: "command", name: "Unit", state: "failed", argv: ["npm", "test"] },
    { id: "goal", kind: "llm", name: "Does what you asked", state: "passed" },
    { id: "i18n", kind: "llm", name: "i18n", state: "na" },
  ] };
  const read = reviewSchema.parse(old);
  expect(read.items.map((i) => [i.id, i.kind, i.gating])).toEqual([["unit", "command", true], ["goal", "goal", true], ["i18n", "guideline", true]]);
  expect(reviewSchema.parse({ ...review("passed"), items: undefined }).items).toEqual([]);
});

test("the verdict counts gating items only: observing commands never decide, disputed findings are not failures (§6.3)", () => {
  expect(reviewVerdict([item("c", "command", "failed", { gating: false }), item("goal", "goal", "passed")])).toBe("passed");
  expect(reviewVerdict([item("c", "command", "unavailable", { gating: false }), item("goal", "goal", "na")])).toBe("passed");
  expect(reviewVerdict([item("goal", "goal", "passed"), item("g", "guideline", "disputed")])).toBe("passed");
  expect(reviewVerdict([item("goal", "goal", "passed"), item("g", "guideline", "failed")])).toBe("failed");
  expect(reviewVerdict([item("c", "command", "unavailable"), item("goal", "goal", "skipped")])).toBe("unavailable");
  expect(reviewVerdict([item("c", "command", "failed"), item("x", "command", "unavailable")])).toBe("failed");
});

test("B1: a fail stands with a file in the diff, an existing repository file, or a quote found in what the reviewer was given", () => {
  const diff = new Set(["shared/a.ts"]);
  const existing = new Set(["shared/i18n/zh-TW.ts"]);
  const sources = ["Add a rerun button", "The card asked for a\n  Rerun   button on failed checks.", undefined, null];
  expect(hasEvidence({ file: "shared/a.ts" }, diff, existing, [])).toBe(true);
  expect(hasEvidence({ file: "shared/i18n/zh-TW.ts" }, diff, existing, [])).toBe(true);
  // Substring, case-insensitive, whitespace runs collapsed.
  expect(hasEvidence({ quote: "the card asked for a Rerun button" }, diff, existing, sources)).toBe(true);
  expect(hasEvidence({ quote: "  ADD a  rerun\tbutton " }, diff, existing, sources)).toBe(true);
  // An invented quote is no evidence; a valid file still is.
  expect(hasEvidence({ quote: "the user wanted a dark mode" }, diff, existing, sources)).toBe(false);
  expect(hasEvidence({ quote: "the user wanted a dark mode", file: "shared/a.ts" }, diff, existing, sources)).toBe(true);
  expect(hasEvidence({ quote: "the card asked for a Rerun button" }, diff, existing, [])).toBe(false);
  expect(hasEvidence({ file: "nowhere.ts" }, diff, existing, sources)).toBe(false);
  expect(hasEvidence({ quote: "  " }, diff, existing, sources)).toBe(false);
  expect(hasEvidence({}, diff, existing, sources)).toBe(false);
});

test("reviewProgress: passed (na included) and failed of the gating items; what runs now (§7.1.1)", () => {
  const running = (items: ReviewItem[]) => reviewProgress({ state: "running", items });
  expect(running([item("c", "command", "queued"), item("goal", "goal", "queued")])).toEqual({ passed: 0, failed: 0, total: 2, phase: "starting" });
  expect(running([item("c", "command", "running", { name: "npm test" }), item("o", "command", "queued", { gating: false }), item("goal", "goal", "queued")])).toEqual({
    passed: 0,
    failed: 0,
    total: 2,
    phase: "running",
    current: "npm test",
  });
  expect(running([item("c", "command", "passed"), item("o", "command", "failed", { gating: false }), item("goal", "goal", "running"), item("g", "guideline", "running"), item("d", "item", "disputed")])).toEqual({
    passed: 1,
    failed: 0,
    total: 3,
    phase: "judging",
    judging: 2,
  });
  expect(running([item("c", "command", "passed"), item("x", "command", "queued")]).phase).toBe("running");
  expect(reviewProgress({ state: "rework", items: [item("c", "command", "passed"), item("goal", "goal", "na"), item("g", "guideline", "failed")] })).toEqual({ passed: 2, failed: 1, total: 3, phase: "done" });
});

test("the rework message lists what failed in the user's words, with ids to dispute (§6.5)", () => {
  const r = review("rework", {
    items: [
      item("c1", "command", "passed", { argv: ["npm", "run", "typecheck"] }),
      item("c2", "command", "passed", { argv: ["npm", "test"] }),
      item("o", "command", "failed", { gating: false, argv: ["npm", "run", "test:e2e"] }),
      item("g1", "guideline", "failed", { name: "Every new UI string is in all catalogs", detail: 'zh-TW.ts has no entry for "Review passed"', file: "shared/i18n/zh-TW.ts", line: 412 }),
      item("goal", "goal", "failed", { name: "Does what you asked", detail: "the card asked for a Rerun button; none was added" }),
      item("g2", "guideline", "passed"),
    ],
  });
  const text = reworkMessage(r, new Map([["g1", "新文案也要进所有语言"]]));
  expect(text.split("\n")).toEqual([
    "[Flowly auto review · rework 1/2]",
    "Commands: 2/2 passed",
    '✗ "新文案也要进所有语言" — zh-TW.ts has no entry for "Review passed" (shared/i18n/zh-TW.ts:412) [id: g1]',
    "✗ Does what you asked — the card asked for a Rerun button; none was added [id: goal]",
    "Fix these, rerun the checks, update the acceptance list and deliver to In review again. If a finding is wrong, deliver with disputes=[{id, reason}].",
  ]);
  const skipped = reworkMessage(review("rework", { items: [item("c", "command", "failed", { argv: ["npm", "test"], exitCode: 1, tail: "1 failing" }), item("goal", "goal", "skipped")] }));
  expect(skipped).toContain("✗ c (npm test) exited 1. [id: c]");
  expect(skipped).toContain("    1 failing");
  expect(skipped).toContain("Review: skipped (a command failed)");
});

test("get_task's review lists items with kind, gating and the dispute reason; no fingerprint", () => {
  const ctx = reviewContext(review("passed", { items: [item("o", "command", "failed", { gating: false, argv: ["npm", "test"] }), item("g", "guideline", "disputed", { disputeReason: "not this card" })] }))!;
  expect(ctx.items).toEqual([
    { id: "o", kind: "command", name: "o", gating: false, state: "failed", command: "npm test" },
    { id: "g", kind: "guideline", name: "g", gating: true, state: "disputed", disputeReason: "not this card" },
  ]);
  expect(ctx).not.toHaveProperty("fingerprint");
});

test("P3: the conversation the built-in check reads drops rework messages and injections, keeps the newest within limits", () => {
  const msgs = [
    { at: "2026-10-28T03:00:00Z", text: "Later message" },
    { at: "2026-10-28T01:00:00Z", text: "First request" },
    { at: "2026-10-28T02:00:00Z", text: "[Flowly auto review · rework 1/2]\nCommands: 0/1 passed" },
    { at: "2026-10-28T02:30:00Z", text: "<system-reminder>noise</system-reminder>" },
    { at: "2026-10-28T02:40:00Z", text: "   " },
    { at: "2026-10-28T02:50:00Z", text: '<paseo-system version="1" kind="agent-message">Another agent\'s report: also rewrite the README</paseo-system>' },
  ];
  expect(conversationForReview(msgs)).toEqual(["First request", "Later message"]);
  const many = Array.from({ length: 40 }, (_, i) => ({ at: `2026-10-28T00:${String(i).padStart(2, "0")}:00Z`, text: `m${i}` }));
  const kept = conversationForReview(many);
  expect(kept).toHaveLength(30);
  expect(kept[0]).toBe("m10");
  const long = conversationForReview([{ at: "a", text: "x".repeat(2000) }]);
  expect(long[0]!.length).toBe(1501);
  const big = conversationForReview(Array.from({ length: 12 }, (_, i) => ({ at: `t${String(i).padStart(2, "0")}`, text: String(i % 10).repeat(1500) })));
  expect(big.join("").length).toBeLessThanOrEqual(12_000);
  expect(big.at(-1)).toBe("1".repeat(1500));
});

// ---- Auto review at the board-group level (BOARD-GROUPS-SPEC §1, §5; ruling, Noah 2026-11-18) ----

const at = "2026-11-18T10:00:00.000Z";
const group = (id: string, autoReview?: { enabled: boolean; maxRounds: number }): Group => ({
  id,
  name: id,
  position: 0,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  ...(autoReview ? { defaults: { autoReview } } : {}),
});
const member = (id: string, groupId: string, autoReview?: Project["autoReview"], extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `n-${id}`,
  primaryPath: `/${id}`,
  repos: [`/${id}`],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  groupId,
  ...(autoReview ? { autoReview } : {}),
  ...extra,
});

test("effective auto review: the project's override, else its group's value, else Off with 2 rounds", () => {
  const on = group("on", { enabled: true, maxRounds: 3 });
  const off = group("off", { enabled: false, maxRounds: 1 });
  const unset = group("unset");
  // The group's value applies to a project without an override.
  expect(effectiveAutoReview({}, on)).toEqual({ enabled: true, maxRounds: 3, source: "group" });
  expect(effectiveAutoReview({}, off)).toEqual({ enabled: false, maxRounds: 1, source: "group" });
  // The override wins both ways, rounds included.
  expect(effectiveAutoReview({ autoReview: { enabled: true, maxRounds: 5 } }, off)).toEqual({ enabled: true, maxRounds: 5, source: "project" });
  expect(effectiveAutoReview({ autoReview: { enabled: false, maxRounds: 2 } }, on)).toEqual({ enabled: false, maxRounds: 2, source: "project" });
  expect(effectiveAutoReview({ autoReview: { enabled: true, maxRounds: 0 } }, on)).toEqual({ enabled: true, maxRounds: 0, source: "project" });
  // A group that never set it means Off.
  expect(effectiveAutoReview({}, unset)).toEqual({ enabled: false, maxRounds: 2, source: "default" });
  expect(effectiveAutoReview({}, null)).toEqual({ enabled: false, maxRounds: 2, source: "default" });
});

test("an inheriting project follows its new group after a move; an override stays", () => {
  const board = { groups: [group("a", { enabled: true, maxRounds: 2 }), group("b", { enabled: false, maxRounds: 4 })] };
  const inherits = member("x", "a");
  const overrides = member("y", "a", { enabled: true, maxRounds: 1 });
  expect(projectAutoReview(board, inherits)).toMatchObject({ enabled: true, maxRounds: 2, source: "group" });
  inherits.groupId = "b";
  overrides.groupId = "b";
  expect(projectAutoReview(board, inherits)).toMatchObject({ enabled: false, maxRounds: 4, source: "group" });
  expect(projectAutoReview(board, overrides)).toEqual({ enabled: true, maxRounds: 1, source: "project" });
  // A project whose group is gone reads the built-in default.
  expect(projectAutoReview(board, member("z", "gone"))).toMatchObject({ enabled: false, maxRounds: 2, source: "default" });
});

describe("the one-time collapse into group values (BOARD-GROUPS-SPEC §7)", () => {
  const effective = (board: { groups: Group[]; projects: Project[] }) => Object.fromEntries(board.projects.map((p) => [p.id, (({ enabled, maxRounds }) => ({ enabled, maxRounds }))(projectAutoReview(board, p))]));
  const on2 = { enabled: true, maxRounds: 2 };

  test("a group whose members all agree takes their value and every member inherits", () => {
    const board = { groups: [group("tooling")], projects: ["a", "b", "c", "d", "e", "f"].map((id) => member(id, "tooling", { ...on2 })) };
    const before = effective(board);
    expect(collapseGroupAutoReview(board)).toBe(true);
    expect(board.groups[0]!.defaults?.autoReview).toEqual(on2);
    for (const p of board.projects) expect(p).not.toHaveProperty("autoReview");
    expect(effective(board)).toEqual(before);
  });

  test("a project without a value in an On group keeps Off as its own override", () => {
    const board = { groups: [group("zen")], projects: [member("infra", "zen", { ...on2 }), member("gitops", "zen", { ...on2 }), member("zenlytic", "zen")] };
    const before = effective(board);
    collapseGroupAutoReview(board);
    expect(board.groups[0]!.defaults?.autoReview).toEqual(on2);
    expect(board.projects.find((p) => p.id === "infra")).not.toHaveProperty("autoReview");
    expect(board.projects.find((p) => p.id === "gitops")).not.toHaveProperty("autoReview");
    expect(board.projects.find((p) => p.id === "zenlytic")!.autoReview).toEqual({ enabled: false, maxRounds: 2 });
    expect(effective(board)).toEqual(before);
  });

  test("a tie goes to Off with 2 rounds when tied, else to the first member's value; rounds count as part of the value", () => {
    const tied = { groups: [group("g")], projects: [member("a", "g", { ...on2 }), member("b", "g")] };
    const before = effective(tied);
    collapseGroupAutoReview(tied);
    expect(tied.groups[0]!.defaults?.autoReview).toEqual({ enabled: false, maxRounds: 2 });
    expect(tied.projects[0]!.autoReview).toEqual(on2);
    expect(tied.projects[1]).not.toHaveProperty("autoReview");
    expect(effective(tied)).toEqual(before);
    const first = { groups: [group("g")], projects: [member("a", "g", { enabled: true, maxRounds: 3 }), member("b", "g", { ...on2 })] };
    collapseGroupAutoReview(first);
    expect(first.groups[0]!.defaults?.autoReview).toEqual({ enabled: true, maxRounds: 3 });
    expect(first.projects[0]).not.toHaveProperty("autoReview");
    expect(first.projects[1]!.autoReview).toEqual(on2);
  });

  test("only live members count (ruling, Noah 2026-11-18); a group without members stays unset; other defaults are kept", () => {
    const board = {
      groups: [{ ...group("g"), defaults: { deliveryMode: "draft_pr" } }, group("empty")],
      projects: [
        member("a", "g", { ...on2 }, { archivedAt: at }),
        member("b", "g", { ...on2 }, { archivedAt: at }),
        member("c", "g", { ...on2 }),
        member("d", "g"),
        member("e", "g"),
      ],
    };
    const before = effective(board);
    collapseGroupAutoReview(board);
    // Live: one On, two Off; the two archived On members are not counted.
    expect(board.groups[0]!.defaults).toEqual({ deliveryMode: "draft_pr", autoReview: { enabled: false, maxRounds: 2 } });
    expect(board.groups[1]).not.toHaveProperty("defaults");
    expect(board.projects[0]!.autoReview).toEqual(on2);
    expect(board.projects[1]!.autoReview).toEqual(on2);
    expect(board.projects[2]!.autoReview).toEqual(on2);
    expect(board.projects[3]).not.toHaveProperty("autoReview");
    expect(effective(board)).toEqual(before);
  });

  test("a group with only archived members takes their most common value", () => {
    const board = { groups: [group("g")], projects: [member("a", "g", { ...on2 }, { archivedAt: at }), member("b", "g", { ...on2 }, { archivedAt: at }), member("c", "g", undefined, { archivedAt: at })] };
    const before = effective(board);
    collapseGroupAutoReview(board);
    expect(board.groups[0]!.defaults?.autoReview).toEqual(on2);
    expect(board.projects[2]!.autoReview).toEqual({ enabled: false, maxRounds: 2 });
    expect(effective(board)).toEqual(before);
  });

  test("a rerun on a collapsed board changes nothing; a member without a value in a group with one keeps inheriting", () => {
    const board = { groups: [group("zen")], projects: [member("infra", "zen", { ...on2 }), member("gitops", "zen", { ...on2 }), member("zenlytic", "zen")] };
    collapseGroupAutoReview(board);
    const once = JSON.parse(JSON.stringify(board));
    expect(collapseGroupAutoReview(board)).toBe(false);
    expect(board).toEqual(once);
    // Inheriting members of a group that already has a value are left alone.
    const set = { groups: [group("g", { ...on2 })], projects: [member("a", "g"), member("b", "g", { enabled: false, maxRounds: 2 })] };
    expect(collapseGroupAutoReview(set)).toBe(false);
    expect(set.projects[0]).not.toHaveProperty("autoReview");
    expect(set.projects[1]!.autoReview).toEqual({ enabled: false, maxRounds: 2 });
  });

  test("a stored value carrying rules from before guardrails stays while the guardrails migration is pending", () => {
    const legacy = { ...on2, rules: [{ id: "t", name: "Tests", kind: "command", argv: ["npm", "test"] }] };
    const board = { groups: [group("g")], projects: [member("a", "g", legacy), member("b", "g", { ...on2 })] };
    collapseGroupAutoReview(board, { keepLegacy: true });
    expect(board.groups[0]!.defaults?.autoReview).toEqual(on2);
    expect(board.projects[0]!.autoReview).toEqual(legacy);
    expect(board.projects[1]).not.toHaveProperty("autoReview");
  });

  test("once guardrails migrated, a legacy value equal to the group's is dropped; a different one stays as the override", () => {
    const legacy = { ...on2, rules: [{ id: "t", name: "Tests", kind: "command", argv: ["npm", "test"] }] };
    const other = { enabled: true, maxRounds: 4, checks: [] };
    const board = { groups: [group("g")], projects: [member("a", "g", legacy), member("b", "g", { ...on2 }), member("c", "g", other)] };
    collapseGroupAutoReview(board, { keepLegacy: false });
    expect(board.groups[0]!.defaults?.autoReview).toEqual(on2);
    expect(board.projects[0]).not.toHaveProperty("autoReview");
    expect(board.projects[2]!.autoReview).toEqual(other);
  });
});
