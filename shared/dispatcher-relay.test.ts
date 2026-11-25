import { expect, test } from "vitest";
import { contractMarker, contractNews, contractRelayTargets, relayEchoMs, relayLimits, relayLine, relayTargetLimit, rememberRelays } from "./dispatcher-relay";
import type { Board, Link, Task } from "./model";

const ev = (patch: Record<string, unknown>) => ({ actor: "agent" as const, action: "progress_reported", ...patch }) as Parameters<typeof contractNews>[0];

test("a marked result or progress report or a delivery is contract news (DISPATCHER-SPEC §5.8)", () => {
  expect(contractMarker).toBe("[contract]");
  expect(contractNews(ev({ reportKind: "result", note: "[contract] harness returns {ok}" }))).toBe("harness returns {ok}");
  expect(contractNews(ev({ reportKind: "progress", note: "  [CONTRACT]  shape changed " }))).toBe("shape changed");
  expect(contractNews(ev({ action: "status_changed", to: "in_review", note: "[contract] ready" }))).toBe("ready");
  expect(contractNews(ev({ action: "status_changed", to: "committed", reportKind: "result", note: "[contract] x" }))).toBe("x");
});

test("questions, blockers, the user's events and unmarked notes are never contract news", () => {
  for (const reportKind of ["question", "blocker"]) expect(contractNews(ev({ reportKind, note: "[contract] x" }))).toBeNull();
  expect(contractNews(ev({ actor: "human", reportKind: "result", note: "[contract] x" }))).toBeNull();
  expect(contractNews(ev({ reportKind: "result", note: "contract x" }))).toBeNull();
  expect(contractNews(ev({ reportKind: "result" }))).toBeNull();
  expect(contractNews(ev({ action: "status_changed", to: "development", note: "[contract] x" }))).toBeNull();
  expect(contractNews(ev({ action: "agent.turn_ended", note: "[contract] x" }))).toBeNull();
});

const T = "2026-11-01T00:00:00.000Z";
const task = (id: string, extra: Partial<Task> = {}) => ({ id, title: `Card ${id}`, status: "development", workspaceId: `w-${id}`, archivedAt: null, ...extra }) as Task;
const link = (kind: Link["kind"], from: string, to: string, id = `${kind}-${from}-${to}`) => ({ id, projectId: "p", kind, from, to, createdAt: T }) as Link;
const live = (...ids: string[]) => new Set(ids.map((id) => `w-${id}`));
const ids = (list: { targets: { id: string }[] } | { id: string }[]) => (Array.isArray(list) ? list : list.targets).map((t) => t.id);

test("targets are live cards related to the source, once each, in link order (§5.8)", () => {
  const board = {
    tasks: [task("src"), task("a"), task("done", { status: "done" }), task("gone", { status: "cancelled" }), task("arch", { archivedAt: T }), task("idle"), task("blk"), task("b")],
    links: [
      link("related", "src", "a"),
      link("related", "a", "src", "dup"),
      link("related", "done", "src"),
      link("related", "src", "gone"),
      link("related", "src", "arch"),
      link("related", "src", "idle"),
      link("blocks", "src", "blk"),
      link("related", "src", "src", "self"),
      link("related", "b", "src"),
    ],
  };
  const now = 10_000_000;
  const { targets, leftOut } = contractRelayTargets({ board: { ...board, umbrellas: [] }, sourceTaskId: "src", liveWorkspaceIds: live("src", "a", "done", "gone", "arch", "blk", "b"), recent: [], now });
  expect(ids(targets)).toEqual(["a", "b"]);
  expect(leftOut).toBe(0);
});

test("a target that was itself relayed to the source within the echo window is left out", () => {
  const board = { tasks: [task("src"), task("a"), task("b")], links: [link("related", "src", "a"), link("related", "src", "b")], umbrellas: [] };
  const now = 10_000_000;
  const input = { board, sourceTaskId: "src", liveWorkspaceIds: live("a", "b"), now };
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "a", to: "src", at: now - relayEchoMs }] }))).toEqual(["b"]);
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "a", to: "src", at: now - relayEchoMs - 1 }] }))).toEqual(["a", "b"]);
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "src", to: "a", at: now }] }))).toEqual(["a", "b"]);
});

test("at most relayTargetLimit targets, the rest counted", () => {
  expect(relayTargetLimit).toBe(30);
  const many = Array.from({ length: 35 }, (_, i) => `c${i}`);
  const board = { tasks: [task("src"), ...many.map((id) => task(id))], links: many.map((id) => link("related", "src", id)), umbrellas: [] };
  const { targets, leftOut } = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live(...many), recent: [], now: 1 });
  expect(targets).toHaveLength(relayTargetLimit);
  expect(leftOut).toBe(5);
  expect(ids(targets)[0]).toBe("c0");
});

test("relayLine names each target with its title and id, and the event to pass as relayOf", () => {
  expect(relayLine([{ id: "a", title: "Card  one\n" }, { id: "b", title: "Two" }], "Shape\nv2", 0, "contract", "e1")).toBe(
    '  Relay contract news with flowly_message_card to: "Card one" [a]; "Two" [b]. Pass relayOf: "e1". The news: "Shape v2"',
  );
  expect(relayLine([{ id: "a", title: "A" }], "x".repeat(600), 0, "contract", "e1").length).toBeLessThan(700);
  expect(relayLine([{ id: "a", title: "A" }], "ruling: drafts", 3, "umbrella", "e2")).toBe(
    '  Relay umbrella news with flowly_message_card to: "A" [a] (3 more left out). Pass relayOf: "e2". The news: "ruling: drafts"',
  );
});

const human = { kind: "human" as const };
const member = (id: string, umbrellaId: string, order?: number, extra: Partial<Task> = {}) =>
  task(id, { umbrella: { id: umbrellaId, joinedAt: T, by: human, ...(order === undefined ? {} : { order }) }, ...extra });
const umbrella = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "open", archivedAt: null, ...extra }) as unknown as Board["umbrellas"][number];

test("contract news goes to live siblings and related cards, each once, never the source", () => {
  const board = {
    tasks: [
      member("src", "u", 1),
      member("s2", "u", 2),
      member("both", "u", 3),
      member("done", "u", 4, { status: "done" }),
      member("arch", "u", 5, { archivedAt: T }),
      member("idle", "u", 6),
      member("other", "v", 1),
      task("rel"),
    ],
    links: [link("related", "src", "both"), link("related", "src", "rel"), link("related", "src", "other")],
    umbrellas: [umbrella("u"), umbrella("v")],
  };
  const { targets, leftOut } = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live("src", "s2", "both", "done", "arch", "other", "rel"), recent: [], now: 1 });
  expect(ids(targets)).toEqual(["s2", "both", "rel", "other"]);
  expect(leftOut).toBe(0);
  // Umbrella news goes to the siblings only.
  expect(ids(contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live("s2", "both", "rel", "other"), recent: [], now: 1, siblingsOnly: true }))).toEqual(["s2", "both"]);
  // A closed or archived umbrella has no live siblings to relay to.
  for (const shut of [umbrella("u", { status: "closed" }), umbrella("u", { archivedAt: T })])
    expect(ids(contractRelayTargets({ board: { ...board, umbrellas: [shut] }, sourceTaskId: "src", liveWorkspaceIds: live("s2", "both", "rel"), recent: [], now: 1 }))).toEqual(["both", "rel"]);
});

test("siblings come first by order and the rest is counted past 30", () => {
  // 20 siblings (orders reversed against their titles) and 12 related cards: 32 eligible.
  const siblings = Array.from({ length: 20 }, (_, i) => member(`s${i}`, "u", 20 - i));
  const related = Array.from({ length: 12 }, (_, i) => task(`r${i}`));
  const board = {
    tasks: [member("src", "u", 0), ...related, ...siblings],
    links: related.map((t) => link("related", t.id, "src")),
    umbrellas: [umbrella("u")],
  };
  const all = [...siblings, ...related].map((t) => t.id);
  const { targets, leftOut } = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live(...all), recent: [], now: 1 });
  expect(targets).toHaveLength(30);
  expect(leftOut).toBe(2);
  expect(ids(targets).slice(0, 20)).toEqual(siblings.map((t) => t.id).reverse());
  expect(ids(targets).slice(20)).toEqual(related.slice(0, 10).map((t) => t.id));
  expect(relayLine(targets, "x", leftOut, "contract", "e1")).toContain("2 more left out");
  // The echo guard still applies to siblings.
  const guarded = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live(...all), recent: [{ from: "s19", to: "src", at: 1 }], now: 1 });
  expect(ids(guarded)[0]).toBe("s18");
  expect(guarded.leftOut).toBe(1);
});

test("relay memory keeps the last 500 per group", () => {
  expect(relayLimits.perHour).toBe(60);
  const rec = (id: string, groupId: string) => ({ id, groupId, at: T, targets: ["a"] });
  let relayed: Board["relayed"] = [rec("g2-old", "g2")];
  relayed = rememberRelays(relayed, Array.from({ length: 499 }, (_, i) => rec(`a${i}`, "g1")), ["g1", "g2"]);
  relayed = rememberRelays(relayed, [rec("b0", "g1"), rec("b1", "g1")], ["g1", "g2"]);
  const g1 = relayed.filter((r) => r.groupId === "g1").map((r) => r.id);
  expect(g1).toHaveLength(500);
  expect(g1[0]).toBe("a1");
  expect(g1.at(-1)).toBe("b1");
  // Another group's memory is its own; a deleted group's is dropped.
  expect(relayed.filter((r) => r.groupId === "g2").map((r) => r.id)).toEqual(["g2-old"]);
  expect(rememberRelays(relayed, [], ["g1"]).some((r) => r.groupId === "g2")).toBe(false);
  // The same event id is remembered once.
  expect(rememberRelays([rec("x", "g1")], [rec("x", "g1")], ["g1"])).toHaveLength(1);
});
