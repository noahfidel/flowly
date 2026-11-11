import { expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { boardSchema } from "../shared/model";
import { boardOverview, OverviewDeltas } from "../server/board-overview";
import { boardKey, overviewQueryOptions } from "./queries";
import { applyOverviewPatch, readOverviewDelta, overviewKey, projectOpenIdeaCount, groupOpenIdeaCount } from "./overview-query";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => null, useRpc: () => null }));
const full = () => boardSchema.parse({ events: [], version: 5, revision: 1, projects: [], tasks: [] });
const view = () => boardOverview(full());

test("missing or wrong patch baseline rereads overview once without an etag", async () => {
  const read = vi.fn(async (input: { etag?: string }) => input.etag ? { etag: "new", patch: { baseEtag: "wrong", revision: 2 } } : { etag: "new", value: view() });
  expect((await readOverviewDelta(read, view(), "old")).value).toEqual(view());
  expect(read.mock.calls.map(([input]) => input)).toEqual([{ etag: "old" }, {}]);
  const broken = vi.fn(async () => ({ etag: "new", patch: { baseEtag: "wrong", revision: 2 } }));
  await expect(readOverviewDelta(broken, undefined, "old")).rejects.toThrow("Missing overview");
  expect(broken).toHaveBeenCalledTimes(2);
});

test("malformed order triggers a scoped reread, not a partially lost task list", async () => {
  const initial = { ...view(), projects: [{ id: "p" }] } as ReturnType<typeof view>;
  const read = vi.fn(async (input: { etag?: string }) => input.etag ? { etag: "new", patch: { baseEtag: "old", revision: 2, projects: { set: [], remove: [], order: [] } } } : { etag: "new", value: view() });
  expect((await readOverviewDelta(read, initial, "old")).value).toEqual(view());
  expect(read).toHaveBeenCalledTimes(2);
});

test("etag reuse, foreign cache replacement and concurrent same-scope requests stay local", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const deltas = new OverviewDeltas();
  const read = vi.fn(async (input: { etag?: string }) => deltas.read(view(), input));
  const options = overviewQueryOptions(client, "h", read);
  await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
  expect(read).toHaveBeenCalledTimes(1);
  const held = client.getQueryData(overviewKey("h"));
  await client.fetchQuery(options);
  expect(read.mock.calls[1][0].etag).toMatch(/^overview-v1:/);
  expect(client.getQueryData(overviewKey("h"))).toBe(held);
  client.setQueryData(overviewKey("h"), { ...view(), revision: 99 });
  await client.fetchQuery(options);
  expect(read.mock.calls.at(-1)?.[0]).toEqual({});
  expect(client.getQueryData(boardKey)).toBeUndefined();
  client.clear();
});

test("the project Ideas count comes from the overview's card facts", () => {
  const overview = { ...view(), tasks: [{ id: "t", projectId: "p" }, { id: "x", projectId: "other" }], cards: [{ taskId: "t", openIdeas: 2 }, { taskId: "x", openIdeas: 1 }] } as unknown as ReturnType<typeof view>;
  expect(projectOpenIdeaCount(overview, "p")).toBe(2);
  expect(projectOpenIdeaCount(undefined, "p")).toBe(0);
  // Open ideas of the project itself (no card) add to its cards' ideas, and only for that project.
  const withOwn = { ...overview, projectIdeas: [{ projectId: "p", open: 3 }, { projectId: "other", open: 5 }] };
  expect(projectOpenIdeaCount(withOwn, "p")).toBe(5);
  expect(projectOpenIdeaCount(withOwn, "other")).toBe(6);
  // An unfiltered group board counts every live member's open ideas (ruling, Noah 2026-11-10).
  expect(groupOpenIdeaCount(withOwn, ["p", "other"])).toBe(11);
  expect(groupOpenIdeaCount(withOwn, ["p"])).toBe(5);
  expect(groupOpenIdeaCount(withOwn, [])).toBe(0);
});

test("an overview patch that only changes project ideas changes the count and keeps cards and tasks identity", () => {
  // The Ideas count memo depends on cards, tasks and projectIdeas: after an import only projectIdeas is new.
  const base = { ...view(), tasks: [{ id: "t", projectId: "p" }], cards: [{ taskId: "t", openIdeas: 1 }], projectIdeas: [{ projectId: "p", open: 1 }] } as unknown as ReturnType<typeof view>;
  const next = { ...base, revision: base.revision + 1, projectIdeas: [{ projectId: "p", open: 4 }] };
  const deltas = new OverviewDeltas();
  const first = deltas.read(base, {});
  const second = deltas.read(next, { etag: first.etag });
  expect(Object.keys(second.patch!).sort()).toEqual(["baseEtag", "projectIdeas", "revision"]);
  const applied = applyOverviewPatch(base, second.patch!);
  expect(applied.cards).toBe(base.cards);
  expect(applied.tasks).toBe(base.tasks);
  expect(applied.projectIdeas).not.toBe(base.projectIdeas);
  expect(projectOpenIdeaCount(base, "p")).toBe(2);
  expect(projectOpenIdeaCount(applied, "p")).toBe(5);
});

test("the overview carries the board groups, and a rename reaches the client as a groups patch (DISPATCHER-SPEC §0)", () => {
  const at = "2026-11-10T10:00:00.000Z";
  const board = full();
  board.groups.push({ id: "g", name: "Work", position: 0, isDefault: true, revision: 1, createdAt: at, updatedAt: at });
  const base = boardOverview(board);
  expect(base.groups.map((g) => g.name)).toEqual(["Work"]);
  const next = boardOverview({ ...board, groups: [{ ...board.groups[0], name: "Clients", revision: 2 }] });
  const deltas = new OverviewDeltas();
  const second = deltas.read(next, { etag: deltas.read(base, {}).etag });
  expect(Object.keys(second.patch!).sort()).toEqual(["baseEtag", "groups", "revision"]);
  const applied = applyOverviewPatch(base, second.patch!);
  expect(applied.groups.map((g) => g.name)).toEqual(["Clients"]);
  expect(applied.tasks).toBe(base.tasks);
});
