import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import {
  PrReviewArchiver,
  archiveFirstDelayMs,
  archiveLookupsPerTick,
  archiveTickMs,
  connectorPrState,
  firstKnown,
  ghPrState,
  type PrState,
  type PrTarget,
} from "./pr-review-archive";
import { refKey } from "./connectors/service";
import type { Status, Task } from "../shared/model";
import type { Connection, ExternalRef } from "../shared/connectors";

// Made-up repositories and PRs only.
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const stamp = "2026-11-10T09:00:00.000Z";

type CardSpec = { id: string; prRef?: string; status?: Status; review?: boolean; archived?: boolean; workspaceId?: string; projectId?: string };

async function fixture(cards: CardSpec[], states: Record<string, PrState | null | "throw"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "flowly-pr-archive-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"), { storage: { checkVersion: false } });
  await store.mutate((board) => {
    const project = (id: string, archivedAt: string | null = null) => ({
      id,
      paseoProjectId: `native-${id}`,
      title: id,
      description: "",
      primaryPath: root,
      repos: [root],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt,
    });
    board.projects.push(project("p"), project("old", stamp));
    cards.forEach((c, i) =>
      board.tasks.push({
        id: c.id,
        projectId: c.projectId ?? "p",
        workspaceId: c.workspaceId ?? `w-${c.id}`,
        sourcePath: root,
        repoPaths: [],
        title: `Review ${c.id}`,
        description: "",
        status: c.status ?? "in_review",
        priority: "normal",
        position: i,
        revision: 1,
        operationId: c.review === false ? `op-${c.id}` : `pr-review:agent-${c.id}`,
        ownsWorkspace: false,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: c.archived ? stamp : null,
        ...(c.prRef ? { prRef: c.prRef } : {}),
      } as Task),
    );
  });
  const running = new Set<string>();
  const paseo = {
    agents: {
      list: async () => ({
        entries: [...running].map((workspaceId, i) => ({ agent: { id: `a${i}`, workspaceId, status: "running", archivedAt: null } })),
        pageInfo: { nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  const looked: string[] = [];
  const lookup = async (pr: PrTarget) => {
    looked.push(pr.key);
    const state = states[pr.key];
    if (state === "throw") throw new Error("offline");
    return state ?? null;
  };
  const logs: string[] = [];
  let on = true;
  const archiver = new PrReviewArchiver(store, lookup, () => Date.now(), (line) => logs.push(line));
  archiver.enabled = async () => on;
  archiver.paseo = () => paseo;
  const archivedIds = async () => (await store.read()).tasks.filter((t) => t.archivedAt).map((t) => t.id).sort();
  return { store, archiver, running, looked, logs, archivedIds, setOn: (v: boolean) => (on = v) };
}

test("only live PR review cards in In review with a prRef are looked up", async () => {
  const x = await fixture(
    [
      { id: "ok", prRef: "acme/widgets#1" },
      { id: "todo", prRef: "acme/widgets#2", status: "todo" },
      { id: "done", prRef: "acme/widgets#3", status: "done" },
      { id: "noref" },
      { id: "loose", prRef: "not a pr" },
      { id: "plain", prRef: "acme/widgets#4", review: false },
      { id: "gone", prRef: "acme/widgets#5", archived: true },
      { id: "busy", prRef: "acme/widgets#6", workspaceId: "w-run" },
      { id: "oldproj", prRef: "acme/widgets#7", projectId: "old" },
    ],
    { "acme/widgets#1": "merged", "acme/widgets#2": "merged", "acme/widgets#3": "merged", "acme/widgets#4": "merged", "acme/widgets#6": "merged", "acme/widgets#7": "merged" },
  );
  x.running.add("w-run");
  expect(await x.archiver.tick()).toEqual([{ taskId: "ok", state: "merged" }]);
  expect(x.looked).toEqual(["acme/widgets#1"]);
  expect(await x.archivedIds()).toEqual(["gone", "ok"]);
});

test("merged and closed PRs archive the card with an activity entry; open ones stay", async () => {
  const x = await fixture(
    [
      { id: "m", prRef: "acme/widgets#10" },
      { id: "c", prRef: "acme/widgets#11" },
      { id: "o", prRef: "acme/widgets#12" },
    ],
    { "acme/widgets#10": "merged", "acme/widgets#11": "closed", "acme/widgets#12": "open" },
  );
  const out = await x.archiver.tick();
  expect(out).toEqual(expect.arrayContaining([{ taskId: "m", state: "merged" }, { taskId: "c", state: "closed" }]));
  expect(out).toHaveLength(2);
  const board = await x.store.read();
  const card = (id: string) => board.tasks.find((t) => t.id === id)!;
  expect(card("m").archivedAt).toBeTruthy();
  expect(card("m").revision).toBe(2);
  expect(card("c").archivedAt).toBeTruthy();
  expect(card("o").archivedAt).toBeNull();
  expect(card("o").revision).toBe(1);
  // Only the card: status and workspace are untouched.
  expect(card("m").status).toBe("in_review");
  expect(card("m").workspaceId).toBe("w-m");
  const last = (id: string) => board.events.filter((e) => e.taskId === id).at(-1);
  expect(last("m")).toMatchObject({ action: "archive_changed", actor: "system", note: "Archived: PR merged" });
  expect(last("c")).toMatchObject({ action: "archive_changed", actor: "system", note: "Archived: PR closed" });
  expect(board.events.some((e) => e.taskId === "o")).toBe(false);
});

test("the setting off does nothing", async () => {
  const x = await fixture([{ id: "m", prRef: "acme/widgets#20" }], { "acme/widgets#20": "merged" });
  x.setOn(false);
  expect(await x.archiver.tick()).toEqual([]);
  expect(x.looked).toEqual([]);
  expect(await x.archivedIds()).toEqual([]);
});

test("a failed or unknown lookup archives nothing and logs once, not every tick", async () => {
  const x = await fixture(
    [
      { id: "a", prRef: "acme/widgets#30" },
      { id: "b", prRef: "acme/widgets#31" },
    ],
    { "acme/widgets#30": "throw", "acme/widgets#31": null },
  );
  expect(await x.archiver.tick()).toEqual([]);
  expect(await x.archiver.tick()).toEqual([]);
  expect(await x.archivedIds()).toEqual([]);
  expect(x.logs).toHaveLength(1);
  expect(x.logs[0]).toMatch(/could not be read/);
});

test("one check makes at most the lookup limit, and the next check covers the rest", async () => {
  const cards = Array.from({ length: archiveLookupsPerTick + 5 }, (_, i) => ({ id: `c${i}`, prRef: `acme/widgets#${100 + i}` }));
  const x = await fixture(cards);
  await x.archiver.tick();
  expect(x.looked).toHaveLength(archiveLookupsPerTick);
  x.looked.length = 0;
  await x.archiver.tick();
  // The five not looked at yet come first.
  expect(x.looked.slice(0, 5).sort()).toEqual(cards.slice(archiveLookupsPerTick).map((c) => c.prRef).sort());
});

test("a card moved out of In review while its PR was looked up is left alone", async () => {
  const x = await fixture([{ id: "m", prRef: "acme/widgets#40" }]);
  const archiver = new PrReviewArchiver(x.store, async () => {
    await x.store.mutate((b) => {
      b.tasks.find((t) => t.id === "m")!.status = "todo";
    });
    return "merged";
  });
  archiver.paseo = x.archiver.paseo;
  expect(await archiver.tick()).toEqual([]);
  expect(await x.archivedIds()).toEqual([]);
});

test("the timer checks about a minute after start, then every 10 minutes, and stops", async () => {
  vi.useFakeTimers();
  const x = await fixture([]);
  const tick = vi.spyOn(x.archiver, "tick").mockResolvedValue([]);
  x.archiver.start();
  await vi.advanceTimersByTimeAsync(archiveFirstDelayMs - 1);
  expect(tick).toHaveBeenCalledTimes(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(archiveTickMs);
  expect(tick).toHaveBeenCalledTimes(2);
  x.archiver.stop();
  await vi.advanceTimersByTimeAsync(archiveTickMs * 3);
  expect(tick).toHaveBeenCalledTimes(2);
});

test("PR state sources: connector first, then gh; neither known is null", async () => {
  const pr: PrTarget = { key: "acme/widgets#7", repo: "acme/widgets", number: 7 };
  const connection: Connection = { id: "gh1", provider: "github", name: "GitHub", baseUrl: "https://github.com", account: "me", verifiedAt: stamp, authFailed: false };
  const summaries = (status: string | null, stale = false) => async (refs: readonly ExternalRef[]) =>
    new Map(status ? [[refKey(refs[0]), { summary: { status } as never, fingerprint: "", stale }]] : []);
  expect(await connectorPrState({ list: async () => [connection], summaries: summaries("Merged") })(pr)).toBe("merged");
  expect(await connectorPrState({ list: async () => [connection], summaries: summaries("Closed") })(pr)).toBe("closed");
  expect(await connectorPrState({ list: async () => [connection], summaries: summaries("Draft") })(pr)).toBe("open");
  expect(await connectorPrState({ list: async () => [connection], summaries: summaries("Merged", true) })(pr)).toBeNull();
  expect(await connectorPrState({ list: async () => [{ ...connection, authFailed: true }], summaries: summaries("Merged") })(pr)).toBeNull();
  expect(await connectorPrState({ list: async () => [], summaries: summaries("Merged") })(pr)).toBeNull();

  const calls: (readonly string[])[] = [];
  const gh = (out: string | Error) =>
    ghPrState(async (file, args) => {
      calls.push([file, ...args]);
      if (out instanceof Error) throw out;
      return out;
    });
  expect(await gh(JSON.stringify({ state: "MERGED", mergedAt: stamp }))(pr)).toBe("merged");
  expect(calls[0]).toEqual(["gh", "pr", "view", "7", "--repo", "acme/widgets", "--json", "state,mergedAt"]);
  expect(await gh(JSON.stringify({ state: "CLOSED", mergedAt: null }))(pr)).toBe("closed");
  expect(await gh(JSON.stringify({ state: "OPEN", mergedAt: null }))(pr)).toBe("open");

  const none = async () => null;
  expect(await firstKnown(none, gh(JSON.stringify({ state: "CLOSED" })))(pr)).toBe("closed");
  expect(await firstKnown(async () => "merged", gh(new Error("unused")))(pr)).toBe("merged");
  expect(await firstKnown(none, gh(new Error("gh: command not found")))(pr)).toBeNull();
});
