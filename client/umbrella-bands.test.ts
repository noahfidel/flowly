import { expect, test } from "vitest";
import type { UmbrellaSummary } from "../shared/umbrella";
import { bandKey, bandRows, bandedOrder, umbrellaBands } from "./umbrella-bands";
import { laneRows, sameRows } from "./lane-rows";

const summary = (id: string, title: string, over: Partial<UmbrellaSummary> = {}): UmbrellaSummary => ({
  id, groupId: "g", title, status: "open", members: 0, openQuestions: 0, pendingChanges: 0, revision: 1, feedRevision: 0, archivedAt: null, ...over,
});
const card = (id: string, umbrella?: string) => ({ id, ...(umbrella ? { umbrella: { id: umbrella } } : {}) });
const shape = (bands: ReturnType<typeof umbrellaBands<{ id: string; umbrella?: { id: string } }>>) => bands.map((b) => [b.id, b.title, b.tasks.map((t) => t.id)]);

const umbrellas = [summary("u-z", "Zeta rollout"), summary("u-a", "Alpha launch"), summary("u-m", "Migration")];

test("one band per umbrella with shown members, then No umbrella", () => {
  const bands = umbrellaBands([card("1", "u-z"), card("2"), card("3", "u-a"), card("4", "u-z")], umbrellas);
  expect(shape(bands)).toEqual([
    ["u-a", "Alpha launch", ["3"]],
    ["u-z", "Zeta rollout", ["1", "4"]],
    [null, "", ["2"]],
  ]);
  // No card without an umbrella: no "No umbrella" band.
  expect(shape(umbrellaBands([card("1", "u-m")], umbrellas))).toEqual([["u-m", "Migration", ["1"]]]);
  // A closed umbrella's members still get its band.
  expect(shape(umbrellaBands([card("1", "u-c")], [summary("u-c", "Closed", { status: "closed" })]))).toEqual([["u-c", "Closed", ["1"]]]);
  // A membership whose umbrella is not listed falls back to No umbrella, never a band without a title.
  expect(shape(umbrellaBands([card("1", "gone"), card("2")], umbrellas))).toEqual([[null, "", ["1", "2"]]]);
  expect(umbrellaBands([], umbrellas)).toEqual([]);
});

test("bands keep the board's order inside a lane", () => {
  const sorted = [card("c", "u-a"), card("x"), card("a", "u-a"), card("y"), card("b", "u-a")];
  expect(shape(umbrellaBands(sorted, umbrellas))).toEqual([
    ["u-a", "Alpha launch", ["c", "a", "b"]],
    [null, "", ["x", "y"]],
  ]);
  // Same titles: ordered by id, so the order never flips between renders.
  const twins = [summary("u2", "Same"), summary("u1", "Same")];
  expect(umbrellaBands([card("a", "u2"), card("b", "u1")], twins).map((b) => b.id)).toEqual(["u1", "u2"]);
  // The board's lane order with bands on is the bands' cards in turn.
  expect(bandedOrder(sorted, umbrellas).map((t) => t.id)).toEqual(["c", "a", "b", "x", "y"]);
});

test("an umbrella with no shown member has no band", () => {
  const bands = umbrellaBands([card("1", "u-a")], umbrellas);
  expect(bands.map((b) => b.id)).toEqual(["u-a"]);
  expect(bands.some((b) => b.id === "u-m" || b.id === "u-z")).toBe(false);
});

test("phone rows: a header per band, a collapsed band shows its header only", () => {
  const bands = umbrellaBands([card("1", "u-a"), card("2"), card("3", "u-a")], umbrellas);
  const rows = bandRows(bands, new Set<string>());
  expect(rows.map((r) => (r.kind === "task" ? r.task.id : `${r.kind}:${r.kind === "band" ? r.id : ""}`))).toEqual(["band:u-a", "1", "3", "band:null", "2"]);
  const folded = bandRows(bands, new Set([bandKey("u-a")]));
  expect(folded.map((r) => (r.kind === "task" ? r.task.id : r.key))).toEqual(["band:u-a", "band:", "2"]);
  expect(folded[0]).toMatchObject({ kind: "band", title: "Alpha launch", count: 2, collapsed: true });
  const keys = rows.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("phone rows keep their identity until a band folds, renames or changes count", () => {
  const a = card("1", "u-a"),
    b = card("2");
  const rows = (tasks: ReturnType<typeof card>[], folded: string[] = [], list = umbrellas) =>
    laneRows(tasks, [], false, bandRows(umbrellaBands(tasks, list), new Set(folded)));
  const first = rows([a, b]);
  expect(sameRows(first, rows([a, b]))).toBe(first);
  const folded = rows([a, b], ["u-a"]);
  expect(sameRows(first, folded)).toBe(folded);
  const renamed = rows([a, b], [], [summary("u-a", "Renamed")]);
  expect(sameRows(first, renamed)).toBe(renamed);
  // An empty lane keeps its placeholder with bands on.
  expect(rows([])).toEqual([{ key: "empty", kind: "empty", hasOlder: false }]);
});
