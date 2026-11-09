import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatcherItems, changeLine, seenMark, whatNextMessage } from "./dispatcher-items";
import { Dispatcher } from "./dispatcher";
import { chatItemLimit, type StoredChatItem as ChatItem } from "../shared/dispatcher";
import { emptyBoard, type Board, type BoardEvent } from "../shared/model";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), "flowly-dispatcher-items-"));
  directories.push(d);
  return d;
}

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function board(): Board {
  const b = emptyBoard();
  const now = iso(T0);
  const project = (id: string, archivedAt: string | null = null) => ({ id, paseoProjectId: `n-${id}`, title: id.toUpperCase(), description: "", primaryPath: `/r/${id}`, repos: [`/r/${id}`], revision: 1, createdAt: now, updatedAt: now, archivedAt });
  const task = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({ id, projectId, workspaceId: `w-${id}`, sourcePath: "/r", repoPaths: ["/r"], title: `Card ${id}`, description: "", status: "in_progress", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`, createdAt: now, updatedAt: now, archivedAt: null, ...extra });
  b.projects.push(project("p"), project("gone", now) as never);
  b.tasks.push(task("t1", "p") as never, task("t2", "p", { status: "in_review" }) as never, task("t3", "p", { archivedAt: now }) as never, task("t4", "gone") as never);
  return b;
}
const event = (taskId: string, at: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({ id: `e-${taskId}-${at}`, taskId, actor: "agent", action: "progress_reported", at: iso(at), ...extra });

test("the change line counts cards changed since the seen revision", () => {
  const b = board();
  b.events.push(
    event("t1", T0 + 1_000),
    event("t1", T0 + 5_000),
    event("t2", T0 + 3_000, { actor: "system", action: "status_changed", to: "in_review" }),
    // Not news: before the mark, the user's own change, an archived card, an archived project.
    event("t2", T0 - 1),
    event("t1", T0 + 9_000, { actor: "human", action: "status_changed" }),
    event("t3", T0 + 2_000),
    event("t4", T0 + 2_000),
  );
  const line = changeLine(b, T0);
  expect(line).toMatchObject({ kind: "change", id: "change", revision: T0 + 5_000, at: iso(T0 + 5_000) });
  expect(line?.kind === "change" && line.cards).toEqual([
    { taskId: "t1", projectId: "p", title: "Card t1", status: "in_progress", events: 2 },
    { taskId: "t2", projectId: "p", title: "Card t2", status: "in_review", events: 1 },
  ]);
  // Nothing newer than the mark: no line. No mark at all: no line.
  expect(changeLine(b, T0 + 5_000)).toBeNull();
  expect(changeLine(b, null)).toBeNull();
  // What should I do? lists the same cards.
  const text = whatNextMessage(line);
  expect(text.split("\n")[0]).toBe("What should I do?");
  expect(text).toContain('- "Card t1" [t1] in project p: in_progress');
  expect(text).toContain('- "Card t2" [t2] in project p: in_review');
  expect(whatNextMessage(null)).toBe("What should I do?");
});

test("Mark seen hides the change line until something new changes", async () => {
  const dir = await directory();
  const now = { value: T0 };
  const dispatcher = new Dispatcher(dir, { mcp: async () => ({ type: "http", url: "http://x", headers: {} }), summary: async () => "", now: () => now.value });
  // Before any dispatcher and any mark: no baseline.
  expect(seenMark(await dispatcher.record())).toBeNull();
  // The dispatcher's start is the mark until the user marks seen.
  expect(seenMark({ startedAt: iso(T0) })).toBe(T0);
  const b = board();
  b.events.push(event("t1", T0 + 1_000));
  const line = changeLine(b, T0);
  expect(line?.kind === "change" && line.cards.length).toBe(1);
  await dispatcher.markSeen(line!.kind === "change" ? line!.revision : 0);
  expect(changeLine(b, seenMark(await dispatcher.record()))).toBeNull();
  // An older mark never moves it back.
  await dispatcher.markSeen(T0 - 10);
  expect((await dispatcher.record()).seenRevision).toBe(T0 + 1_000);
  // Something new shows the line again, with only the new change.
  b.events.push(event("t2", T0 + 2_000));
  const next = changeLine(b, seenMark(await dispatcher.record()));
  expect(next?.kind === "change" && next.cards.map((c) => c.taskId)).toEqual(["t2"]);
  // The mark is stored and survives a reload.
  const again = new Dispatcher(dir, { mcp: async () => ({ type: "http", url: "http://x", headers: {} }), summary: async () => "" });
  expect((await again.record()).seenRevision).toBe(T0 + 1_000);
});

const note = (taskId: string, at: number): ChatItem => ({ id: `n-${taskId}-${at}`, at: iso(at), kind: "note", note: { taskId, projectId: "p", title: `Card ${taskId}`, kind: "status_changed", detail: "a → b", at: iso(at) } });
const ask = (id: string, at: number, state: "open" | "answered" | "dismissed", resolvedAt?: number): ChatItem => ({ id, at: iso(at), kind: "ask", signal: `s-${id}`, taskId: "t1", projectId: "p", title: "Which DB?", state, ...(resolvedAt ? { resolvedAt: iso(resolvedAt) } : {}) });

test("items are capped and old answered asks expire", async () => {
  const dir = await directory();
  const day = 86_400_000;
  const now = { value: T0 };
  const items = new DispatcherItems(dir, { now: () => now.value });
  expect(await items.list()).toEqual([]);
  await items.put([
    ask("old-answered", T0 - 10 * day, "answered", T0 - 8 * day),
    ask("old-dismissed", T0 - 9 * day, "dismissed"),
    ask("recent-answered", T0 - 10 * day, "answered", T0 - 2 * day),
    ask("old-open", T0 - 30 * day, "open"),
  ]);
  expect((await items.list()).map((i) => i.id)).toEqual(["old-open", "recent-answered"]);
  // Time passing expires an ask on the next write; an open ask stays.
  now.value = T0 + 6 * day;
  await items.put([note("late", T0)]);
  expect((await items.list()).map((i) => i.id)).toEqual(["old-open", "n-late-" + T0]);
  // 600 notes: only the newest 500 items stay, oldest first.
  await items.put(Array.from({ length: 600 }, (_, i) => note(`t${i}`, T0 + i)));
  const kept = await items.list();
  expect(kept).toHaveLength(chatItemLimit);
  expect(kept[0].id).toBe("n-t100-" + (T0 + 100));
  expect(kept.at(-1)!.id).toBe("n-t599-" + (T0 + 599));
  // Stored atomically and read back by a fresh instance.
  const fresh = new DispatcherItems(dir, { now: () => now.value });
  expect(await fresh.list()).toEqual(kept);
  // An item with the same id is replaced, not duplicated.
  await fresh.put([{ ...note("t599", T0 + 599), at: iso(T0 + 700) }]);
  expect((await fresh.list()).filter((i) => i.id === "n-t599-" + (T0 + 599))).toHaveLength(1);
});

test("a corrupt items file is preserved and read as empty", async () => {
  const dir = await directory();
  await writeFile(join(dir, "dispatcher-items.json"), "{ not json");
  const items = new DispatcherItems(dir, { now: () => T0 });
  expect(await items.list()).toEqual([]);
  expect((await readdir(dir)).some((f) => f.startsWith("dispatcher-items.json.invalid-"))).toBe(true);
  await items.put([note("t1", T0)]);
  expect(JSON.parse(await readFile(join(dir, "dispatcher-items.json"), "utf8")).items).toHaveLength(1);
});
