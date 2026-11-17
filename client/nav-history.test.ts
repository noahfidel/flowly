import { describe, expect, test } from "vitest";
import * as navHistory from "./nav-history";
import {
  canNavStep,
  emptyNavHistory,
  navAlive,
  navHistoryCap,
  navOpenAction,
  navStep,
  pruneNavHistory,
  recordLocation,
  type NavEntry,
  type NavHistory,
} from "./nav-history";

/** Back and Forward walk what the user opened, in order (UI-REFRESH-SPEC §7ae). */

const board: NavEntry = { kind: "board" };
const card = (taskId: string, sessionId?: string): NavEntry => (sessionId === undefined ? { kind: "card", taskId } : { kind: "card", taskId, sessionId });
const dispatcher = (groupId: string): NavEntry => ({ kind: "dispatcher", groupId });
const alive = () => true;
const record = (...entries: NavEntry[]) => entries.reduce<NavHistory>((h, e) => recordLocation(h, e), emptyNavHistory);
const current = (h: NavHistory) => h.entries[h.index];

describe("the stack", () => {
  test("pushes each new place and points at the newest", () => {
    const h = record(board, card("a"), dispatcher("g"));
    expect(h.entries).toEqual([board, card("a"), dispatcher("g")]);
    expect(h.index).toBe(2);
  });

  test("the empty history can go nowhere", () => {
    expect(canNavStep(emptyNavHistory, "back", alive)).toBe(false);
    expect(canNavStep(emptyNavHistory, "forward", alive)).toBe(false);
    expect(navStep(emptyNavHistory, "back", alive)).toBeNull();
  });

  test("a consecutive duplicate is not pushed and returns the same history object", () => {
    const h = record(board, card("a"));
    expect(recordLocation(h, card("a"))).toBe(h);
    expect(recordLocation(record(board), board)).toEqual(record(board));
    expect(recordLocation(record(dispatcher("g")), dispatcher("g")).entries).toHaveLength(1);
  });

  test("a session change inside the same card updates the entry in place", () => {
    const h = record(board, card("a"), card("a", "s1"), card("a", "s2"));
    expect(h.entries).toEqual([board, card("a", "s2")]);
    expect(h.index).toBe(1);
    // An unknown session (the drawer has not reported yet) never overwrites the known one.
    expect(recordLocation(h, card("a"))).toBe(h);
    // Back to the card's details is a session change too.
    expect(current(recordLocation(h, card("a", "")))).toEqual(card("a", ""));
  });

  test("switching the group the dock follows replaces a dispatcher entry", () => {
    const h = record(board, dispatcher("g1"), dispatcher("g2"));
    expect(h.entries).toEqual([board, dispatcher("g2")]);
  });

  test("keeps at most 50 entries, dropping the oldest", () => {
    let h = emptyNavHistory;
    for (let i = 0; i < navHistoryCap + 10; i++) h = recordLocation(h, card(`c${i}`));
    expect(navHistoryCap).toBe(50);
    expect(h.entries).toHaveLength(50);
    expect(h.entries[0]).toEqual(card("c10"));
    expect(current(h)).toEqual(card("c59"));
    expect(h.index).toBe(49);
  });

  test("back and forward move the pointer; canNavStep says whether a step exists", () => {
    let h = record(board, card("a"), card("b"));
    expect(canNavStep(h, "back", alive)).toBe(true);
    expect(canNavStep(h, "forward", alive)).toBe(false);
    let step = navStep(h, "back", alive)!;
    expect(step.entry).toEqual(card("a"));
    h = step.history;
    expect(h.index).toBe(1);
    expect(canNavStep(h, "forward", alive)).toBe(true);
    step = navStep(h, "back", alive)!;
    expect(step.entry).toEqual(board);
    h = step.history;
    expect(canNavStep(h, "back", alive)).toBe(false);
    expect(navStep(h, "back", alive)).toBeNull();
    step = navStep(h, "forward", alive)!;
    expect(step.entry).toEqual(card("a"));
    step = navStep(step.history, "forward", alive)!;
    expect(step.entry).toEqual(card("b"));
    expect(canNavStep(step.history, "forward", alive)).toBe(false);
  });

  test("arriving at the entry a step went to records nothing", () => {
    const h = record(board, card("a"), card("b"));
    const step = navStep(h, "back", alive)!;
    expect(recordLocation(step.history, card("a"))).toBe(step.history);
  });

  test("opening something after going back truncates the forward part", () => {
    const h = record(board, card("a"), card("b"), card("c"));
    const back = navStep(navStep(h, "back", alive)!.history, "back", alive)!.history;
    expect(current(back)).toEqual(card("a"));
    const next = recordLocation(back, card("d"));
    expect(next.entries).toEqual([board, card("a"), card("d")]);
    expect(canNavStep(next, "forward", alive)).toBe(false);
  });
});

describe("entries that disappeared", () => {
  const gone = (...dead: string[]) => (e: NavEntry) => !(e.kind === "card" && dead.includes(e.taskId)) && !(e.kind === "dispatcher" && dead.includes(e.groupId));

  test("back skips and prunes dead entries", () => {
    const h = record(board, card("a"), card("b"), card("c"));
    const step = navStep(h, "back", gone("b"))!;
    expect(step.entry).toEqual(card("a"));
    expect(step.history.entries).toEqual([board, card("a"), card("c")]);
    expect(current(step.history)).toEqual(card("a"));
  });

  test("forward skips and prunes dead entries", () => {
    const h = record(board, card("a"), card("b"), card("c"));
    const atStart = navStep(navStep(navStep(h, "back", alive)!.history, "back", alive)!.history, "back", alive)!.history;
    expect(current(atStart)).toEqual(board);
    const step = navStep(atStart, "forward", gone("a", "b"))!;
    expect(step.entry).toEqual(card("c"));
    expect(step.history.entries).toEqual([board, card("c")]);
    expect(step.history.index).toBe(1);
  });

  test("a vanished group's dispatcher is skipped too", () => {
    const h = record(board, dispatcher("g1"), card("a"));
    expect(navStep(h, "back", gone("g1"))!.entry).toEqual(board);
  });

  test("the button is off when no reachable entry remains in that direction", () => {
    const h = record(card("a"), card("b"), card("c"));
    expect(canNavStep(h, "back", gone("a", "b"))).toBe(false);
    expect(navStep(h, "back", gone("a", "b"))).toBeNull();
    const back = navStep(h, "back", alive)!.history;
    expect(canNavStep(back, "forward", gone("c"))).toBe(false);
  });

  test("a step never lands on the place already shown when pruning brings it next to itself", () => {
    // a, x, a: with x gone, Back from the second a must not stop on the first a.
    const h = record(board, card("a"), card("x"), card("a"));
    expect(canNavStep(h, "back", gone("x"))).toBe(true);
    const step = navStep(h, "back", gone("x"))!;
    expect(step.entry).toEqual(board);
    expect(step.history.entries).toEqual([board, card("a")]);
    expect(step.history.index).toBe(0);
  });

  test("folding two entries for the same place keeps the later session", () => {
    const h = record(card("a", "s1"), card("b"), card("a", "s2"), card("c"));
    const step = navStep(h, "back", gone("b"))!;
    expect(step.entry).toEqual(card("a", "s2"));
    expect(step.history.entries).toEqual([card("a", "s2"), card("c")]);
    expect(step.history.index).toBe(0);
    expect(pruneNavHistory(h, gone("b"))).toEqual({ entries: [card("a", "s2"), card("c")], index: 1 });
  });

  test("pruning keeps the pointer on the place shown, or the nearest older one", () => {
    const h = record(board, card("a"), card("b"), card("c"));
    const atB = navStep(h, "back", alive)!.history;
    expect(pruneNavHistory(atB, gone("a"))).toEqual({ entries: [board, card("b"), card("c")], index: 1 });
    expect(pruneNavHistory(atB, gone("b"))).toEqual({ entries: [board, card("a"), card("c")], index: 1 });
    const nothing = pruneNavHistory(h, alive);
    expect(nothing).toBe(h);
  });
});

describe("the walk through what needs you", () => {
  test("from X, a walk opening A, B, C pushes them; Back goes C, B, A, then X", () => {
    for (const x of [board, dispatcher("g"), card("x")]) {
      let h = record(x);
      // showStepCard opens each card with the session that waits there.
      h = recordLocation(h, card("a", "sa"));
      h = recordLocation(h, card("b", "sb"));
      h = recordLocation(h, card("c", "sc"));
      const seen: NavEntry[] = [];
      for (let step = navStep(h, "back", alive); step; step = navStep(h, "back", alive)) {
        seen.push(step.entry);
        h = step.history;
      }
      expect(seen).toEqual([card("b", "sb"), card("a", "sa"), x]);
      expect(current(h)).toEqual(x);
    }
  });
});

describe("history never touches read state", () => {
  test("applying an entry is only ever an open", () => {
    expect(navOpenAction(card("a", "s"))).toEqual({ kind: "open-card", taskId: "a", sessionId: "s" });
    // No session known: the card opens on its details, as a card link does.
    expect(navOpenAction(card("a"))).toEqual({ kind: "open-card", taskId: "a", sessionId: "" });
    expect(navOpenAction(dispatcher("g"))).toEqual({ kind: "open-dispatcher", groupId: "g" });
    expect(navOpenAction(board)).toEqual({ kind: "show-board" });
    for (const e of [card("a"), card("a", "s"), dispatcher("g"), board])
      expect(navOpenAction(e).kind).toMatch(/^(open-card|open-dispatcher|show-board)$/);
  });

  test("the module offers nothing that reads or marks", () => {
    expect(Object.keys(navHistory).filter((name) => /read|unread|seen|mark/i.test(name))).toEqual([]);
  });
});

describe("which entries are still there", () => {
  const tasks = [
    { id: "open", projectId: "p", status: "development", archivedAt: null },
    { id: "archived", projectId: "p", status: "todo", archivedAt: "2026-11-01" },
    { id: "done", projectId: "p", status: "done", archivedAt: null },
    { id: "cancelled", projectId: "p", status: "cancelled", archivedAt: null },
    { id: "in-old", projectId: "old", status: "todo", archivedAt: null },
    { id: "orphan", projectId: "missing", status: "todo", archivedAt: null },
  ];
  const projects = [{ id: "p", archivedAt: null }, { id: "old", archivedAt: "2026-11-01" }];
  const isAlive = navAlive({ tasks, projects, groups: [{ id: "g" }] });

  test("a card is there while it exists, is not archived or finished, and its project is live", () => {
    expect(isAlive(card("open", "s"))).toBe(true);
    for (const id of ["archived", "done", "cancelled", "in-old", "orphan", "deleted"]) expect(isAlive(card(id))).toBe(false);
  });

  test("a dispatcher is there while its group exists; the bare board always is", () => {
    expect(isAlive(dispatcher("g"))).toBe(true);
    expect(isAlive(dispatcher("removed"))).toBe(false);
    expect(isAlive(board)).toBe(true);
  });

  test("before the full overview and the groups are known nothing counts as gone", () => {
    const unknown = navAlive({ tasks: null, projects: null, groups: [] });
    expect(unknown(card("deleted"))).toBe(true);
    expect(unknown(dispatcher("removed"))).toBe(true);
  });
});
