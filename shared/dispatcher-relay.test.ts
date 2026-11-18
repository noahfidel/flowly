import { expect, test } from "vitest";
import { contractMarker, contractNews, contractRelayTargets, relayEchoMs, relayLine, relayTargetLimit } from "./dispatcher-relay";
import type { Link, Task } from "./model";

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
const ids = (list: { id: string }[]) => list.map((t) => t.id);

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
  const targets = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live("src", "a", "done", "gone", "arch", "blk", "b"), recent: [], now });
  expect(ids(targets)).toEqual(["a", "b"]);
});

test("a target that was itself relayed to the source within the echo window is left out", () => {
  const board = { tasks: [task("src"), task("a"), task("b")], links: [link("related", "src", "a"), link("related", "src", "b")] };
  const now = 10_000_000;
  const input = { board, sourceTaskId: "src", liveWorkspaceIds: live("a", "b"), now };
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "a", to: "src", at: now - relayEchoMs }] }))).toEqual(["b"]);
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "a", to: "src", at: now - relayEchoMs - 1 }] }))).toEqual(["a", "b"]);
  expect(ids(contractRelayTargets({ ...input, recent: [{ from: "src", to: "a", at: now }] }))).toEqual(["a", "b"]);
});

test("at most relayTargetLimit targets", () => {
  const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
  const board = { tasks: [task("src"), ...many.map((id) => task(id))], links: many.map((id) => link("related", "src", id)) };
  const targets = contractRelayTargets({ board, sourceTaskId: "src", liveWorkspaceIds: live(...many), recent: [], now: 1 });
  expect(targets).toHaveLength(relayTargetLimit);
  expect(ids(targets)[0]).toBe("c0");
});

test("relayLine names each target with its title and id", () => {
  expect(relayLine([{ id: "a", title: "Card  one\n" }, { id: "b", title: "Two" }], "Shape\nv2")).toBe('  Relay contract news with flowly_message_card to: "Card one" [a]; "Two" [b]. The news: "Shape v2"');
  expect(relayLine([{ id: "a", title: "A" }], "x".repeat(600)).length).toBeLessThan(600);
});
