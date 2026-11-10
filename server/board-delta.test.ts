import { expect, test } from "vitest";
import { BoardDeltas, diffBoard, fingerprint, type View } from "./board-delta";

const task = (id: string, title = id) => ({ id, title });
const board = (over: Partial<Record<string, unknown>> = {}): View =>
  ({
    revision: 1,
    events: [{ id: "e1" }, { id: "e2" }],
    plans: [],
    projects: [{ id: "p" }],
    tasks: [task("a"), task("b"), task("c")],
    ideas: [],
    links: [],
    artifacts: [],
    workpads: [{ taskId: "a", revision: 1 }],
    attentionDismissals: [],
    groups: [],
    ...over,
  }) as unknown as View;

const patchOf = (before: View, after: View) => diffBoard(fingerprint(before), fingerprint(after), after)!;

test("only changed items, removed ids and new events travel", () => {
  const patch = patchOf(board(), board({ revision: 2, events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }], tasks: [task("a"), task("b", "renamed"), task("c")] }));
  expect(patch.revision).toBe(2);
  expect(patch.events).toEqual([{ id: "e3" }]);
  expect(patch.tasks).toEqual({ set: [task("b", "renamed")], remove: [] });
  expect(patch.workpads).toBeUndefined();
  expect(patch.projects).toBeUndefined();
  expect(patch.plans).toBeUndefined();
});

test("added items are appended, removed ones listed, and an order is sent only when it differs", () => {
  const added = patchOf(board(), board({ tasks: [task("a"), task("b"), task("c"), task("d")] }));
  expect(added.tasks).toEqual({ set: [task("d")], remove: [] });
  const removed = patchOf(board(), board({ tasks: [task("a"), task("c")] }));
  expect(removed.tasks).toEqual({ set: [], remove: ["b"] });
  const inserted = patchOf(board(), board({ tasks: [task("d"), task("a"), task("b"), task("c")] }));
  expect(inserted.tasks).toEqual({ set: [task("d")], remove: [], order: ["d", "a", "b", "c"] });
  const moved = patchOf(board(), board({ tasks: [task("c"), task("a"), task("b")] }));
  expect(moved.tasks).toEqual({ set: [], remove: [], order: ["c", "a", "b"] });
});

test("plans travel whole when they change; workpads are matched by task", () => {
  const patch = patchOf(board(), board({ plans: [{ taskId: "a" }], workpads: [{ taskId: "a", revision: 2 }, { taskId: "b", revision: 1 }] }));
  expect(patch.plans).toEqual([{ taskId: "a" }]);
  expect(patch.workpads).toEqual({ set: [{ taskId: "a", revision: 2 }, { taskId: "b", revision: 1 }], remove: [] });
});

test("events are matched by id: dropped ones are listed, shifted positions do not matter", () => {
  const before = board({ events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] });
  // a card at its cap loses its oldest event from the middle while a new one is appended
  const capped = board({ events: [{ id: "e1" }, { id: "e3" }, { id: "e4" }] });
  const patch = diffBoard(fingerprint(before), fingerprint(capped), capped)!;
  expect(patch.events).toEqual([{ id: "e4" }]);
  expect(patch.removeEvents).toEqual(["e2"]);
  const shorter = board({ events: [{ id: "e1" }] });
  expect(diffBoard(fingerprint(before), fingerprint(shorter), shorter)!.removeEvents).toEqual(["e2", "e3"]);
  expect(patchOf(before, before).removeEvents).toBeUndefined();
});

test("an event inserted before the end cannot be appended, so there is no patch", () => {
  const before = fingerprint(board());
  const inserted = board({ events: [{ id: "e1" }, { id: "x" }, { id: "e2" }] });
  expect(diffBoard(before, fingerprint(inserted), inserted)).toBeNull();
});

test("the daemon patches a remembered etag and falls back otherwise", () => {
  const deltas = new BoardDeltas(2);
  const first = deltas.read(board(), {});
  expect(first).toHaveProperty("value");
  expect(deltas.read(board(), { etag: first.etag })).toEqual({ etag: first.etag });
  const next = board({ revision: 2, tasks: [task("a"), task("b", "renamed"), task("c")] });
  const patched = deltas.read(next, { etag: first.etag });
  expect(patched).toHaveProperty("patch");
  expect(patched).not.toHaveProperty("value");
  // An etag it never served: the events-only delta when the caller says what it holds, else everything.
  const bigger = board({ revision: 3, events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] });
  expect(deltas.read(bigger, { etag: "unknown", since: { count: 2, lastId: "e2" } })).toMatchObject({ delta: true });
  expect(deltas.read(bigger, { etag: "unknown" })).toMatchObject({ value: bigger });
  // The first board was forgotten (capacity 2): a full read again.
  expect(deltas.read(bigger, { etag: first.etag })).toHaveProperty("value");
});

test("a full read says why", () => {
  const events = [{ id: "a" }, { id: "b" }];
  const view = (extra: object[] = []) => ({ revision: 1, events: [...events, ...extra], plans: [], projects: [], tasks: [], ideas: [], links: [], artifacts: [], workpads: [], attentionDismissals: [], groups: [] }) as never;
  const reasons: string[] = [];
  const deltas = new BoardDeltas(2, (reason) => reasons.push(reason));
  deltas.read(view(), {});
  const first = deltas.read(view([{ id: "c" }]), {});
  deltas.read(view([{ id: "c" }, { id: "d" }]), { etag: "never-served" });
  deltas.read(view([{ id: "c" }, { id: "d" }, { id: "e" }]), { etag: (first as { etag: string }).etag });
  expect(reasons).toEqual(["no-etag", "no-etag", "etag-unknown"]);
});

test("an event on a card at its 100-event cap is a patch, not a full read (was the cause of full reads)", () => {
  // store.event() keeps 100 events per card: appending one drops that card's oldest, which sits in the middle of the list.
  const log = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, taskId: "A" })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, taskId: "B" })),
  ];
  const view = (events: { id: string }[]) => ({ revision: 1, events, plans: [], projects: [], tasks: [], ideas: [], links: [], artifacts: [], workpads: [], attentionDismissals: [], groups: [] }) as never;
  const next = [...log.filter((e) => e.id !== "a0"), { id: "a100", taskId: "A" }];
  expect(next.length).toBe(log.length);
  const reasons: string[] = [];
  const deltas = new BoardDeltas(32, (reason) => reasons.push(reason));
  const first = deltas.read(view(log), {}) as { etag: string };
  const again = deltas.read(view(next), { etag: first.etag, since: { count: log.length, lastId: "b4" } }) as { value?: unknown; patch?: { events: unknown[]; removeEvents?: string[] } };
  expect(again.value).toBeUndefined();
  expect(again.patch?.events).toEqual([{ id: "a100", taskId: "A" }]);
  expect(again.patch?.removeEvents).toEqual(["a0"]);
  expect(reasons).toEqual(["no-etag"]);
});
