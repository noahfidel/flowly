import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeLineCache, DispatcherItems, changeLine, groupItems, groupProjectIds, noteItems, pruneItems, seenMark, whatNextMessage, type SeenMark } from "./dispatcher-items";
import { logFailure } from "./error-report";
import { Dispatcher } from "./dispatcher";
import { chatItemLimit, type StoredChatItem as ChatItem } from "../shared/dispatcher";
import { emptyBoard, type Board, type BoardEvent, type Group } from "../shared/model";

vi.mock("./error-report", async (original) => ({ ...(await original<typeof import("./error-report")>()), logFailure: vi.fn() }));

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
/** A dispatcher of the one group "g1" (DISPATCHER-SPEC §0). */
function groupDispatcher(dir: string, now?: () => number) {
  const groups: Group[] = [{ id: "g1", name: "Projects", position: 0, isDefault: true, revision: 1, createdAt: iso(T0), updatedAt: iso(T0) }];
  return new Dispatcher(
    dir,
    { summary: async () => "", mcp: async () => ({ type: "http", url: "", headers: {} }), board: async () => ({ ...emptyBoard(), groups }), ...(now ? { now } : {}) },
    join(dir, "..", "unused-dispatcher-folder"),
  );
}
/** The group's seen mark as stored. */
const stored = async (d: Dispatcher) => seenMark((await d.record()).groups.g1 ?? {});
const event = (taskId: string, at: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({ id: `e-${taskId}-${at}`, taskId, actor: "agent", action: "progress_reported", at: iso(at), ...extra });
const mark = (revision: number, ids: string[] = []): SeenMark => ({ revision, ids });

test("a wrapped-up card is left out of the change line until its wrap-up stops applying", () => {
  const wraps: BoardEvent[][] = [
    [event("t1", T0 + 1_000, { actor: "human", action: "wrapped_up" })],
    [event("t1", T0 + 1_000, { actor: "system", action: "workspace_auto_archived" })],
  ];
  for (const wrap of wraps) {
    const b = board();
    b.events.push(...wrap, event("t1", T0 + 2_000), event("t2", T0 + 2_000));
    const cards = (x: typeof b) => { const l = changeLine(x, mark(T0), []); return l?.kind === "change" ? l.cards.map((c) => c.taskId) : []; };
    expect(cards(b)).toEqual(["t2"]);
    for (const back of [event("t1", T0 + 3_000, { actor: "human", action: "status_changed", to: "development" }), event("t1", T0 + 3_000, { actor: "human", action: "workspace_restored" })]) {
      const c = board();
      c.events.push(...wrap, event("t1", T0 + 2_000), event("t2", T0 + 2_000), back);
      expect(cards(c).sort()).toEqual(["t1", "t2"]);
    }
  }
});

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
    // The dispatcher's own actions are not news either (it made them).
    event("t2", T0 + 7_000, { action: "edited", agentId: "disp" }),
    event("t2", T0 + 7_001, { id: "e-t2-link", action: "linked", agentId: "disp" }),
  );
  const line = changeLine(b, mark(T0), ["disp"]);
  expect(line).toMatchObject({ kind: "change", id: "change", revision: T0 + 5_000, ids: [`e-t1-${T0 + 5_000}`], at: iso(T0 + 5_000) });
  expect(line?.kind === "change" && line.cards).toMatchObject([
    { taskId: "t1", projectId: "p", title: "Card t1", status: "in_progress", events: 2 },
    { taskId: "t2", projectId: "p", title: "Card t2", status: "in_review", events: 1 },
  ]);
  // Nothing newer than the mark: no line. No mark at all: no line.
  expect(changeLine(b, mark(T0 + 5_000, [`e-t1-${T0 + 5_000}`]), ["disp"])).toBeNull();
  expect(changeLine(b, null, ["disp"])).toBeNull();
  // Another agent's action on the same card is news.
  expect(changeLine(b, mark(T0 + 5_000, [`e-t1-${T0 + 5_000}`]), ["other"])?.kind).toBe("change");
  // An earlier dispatcher session of this install made them too: still not news after a replacement.
  expect(changeLine(b, mark(T0 + 5_000, [`e-t1-${T0 + 5_000}`]), ["disp", "disp2"])).toBeNull();
  expect(changeLine(b, mark(T0 + 5_000, [`e-t1-${T0 + 5_000}`]), ["disp2"])?.kind).toBe("change");
  // What should I do? lists the same cards.
  const text = whatNextMessage(line);
  expect(text.split("\n")[0]).toBe("What should I do?");
  expect(text).toContain('- "Card t1" [t1] in project p: in_progress');
  expect(text).toContain('- "Card t2" [t2] in project p: in_review');
  expect(whatNextMessage(null)).toBe("What should I do?");
});

test("Mark seen hides the change line until something new changes", async () => {
  const dir = await directory();
  const now = { value: T0 + 60_000 };
  const dispatcher = groupDispatcher(dir, () => now.value);
  // Before any dispatcher and any mark: no baseline.
  expect(await stored(dispatcher)).toBeNull();
  // The dispatcher's start is the mark until the user marks seen.
  expect(seenMark({ startedAt: iso(T0) })).toEqual(mark(T0));
  const b = board();
  b.events.push(event("t1", T0 + 1_000));
  const line = changeLine(b, mark(T0));
  expect(line?.kind === "change" && line.cards.length).toBe(1);
  await dispatcher.markSeen("g1", line!.kind === "change" ? line!.revision : 0, line!.kind === "change" ? line!.ids : []);
  expect(changeLine(b, await stored(dispatcher))).toBeNull();
  // An older mark never moves it back.
  await dispatcher.markSeen("g1", T0 - 10);
  expect((await dispatcher.record()).groups.g1.seenRevision).toBe(T0 + 1_000);
  // Something new shows the line again, with only the new change.
  b.events.push(event("t2", T0 + 2_000));
  const next = changeLine(b, await stored(dispatcher));
  expect(next?.kind === "change" && next.cards.map((c) => c.taskId)).toEqual(["t2"]);
  // A mark from a client whose clock runs ahead is clamped to the daemon's time.
  expect(await dispatcher.markSeen("g1", T0 + 3_600_000)).toBe(T0 + 60_000);
  expect(await stored(dispatcher)).toEqual(mark(T0 + 60_000));
  // The mark is stored and survives a reload.
  const again = groupDispatcher(dir);
  expect((await again.record()).groups.g1.seenRevision).toBe(T0 + 60_000);
  // An unknown group has no mark to set.
  await expect(dispatcher.markSeen("nope", T0)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
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
  // 600 more notes: only the newest 500 notes stay, oldest first; the ask is counted apart and stays.
  await items.put(Array.from({ length: 600 }, (_, i) => note(`t${i}`, T0 + i)));
  const kept = await items.list();
  expect(kept).toHaveLength(chatItemLimit + 1);
  expect(kept[0].id).toBe("old-open");
  expect(kept[1].id).toBe("n-t100-" + (T0 + 100));
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

test("events in the same millisecond as the mark are not lost", async () => {
  const dir = await directory();
  const dispatcher = groupDispatcher(dir, () => T0 + 60_000);
  const b = board();
  const ms = T0 + 1_000;
  b.events.push(event("t1", ms, { id: "a" }));
  const line = changeLine(b, mark(T0));
  expect(line?.kind === "change" && line.ids).toEqual(["a"]);
  await dispatcher.markSeen("g1", ms, ["a"]);
  // A second event lands in the same millisecond after the user looked: still news.
  b.events.push(event("t2", ms, { id: "b" }));
  const after = changeLine(b, await stored(dispatcher));
  expect(after?.kind === "change" && after.cards.map((c) => [c.taskId, c.events])).toEqual([["t2", 1]]);
  // Marking it too keeps both ids at that millisecond; an older mark changes nothing.
  await dispatcher.markSeen("g1", ms, ["b"]);
  await dispatcher.markSeen("g1", ms - 5, ["zzz"]);
  expect(await stored(dispatcher)).toEqual(mark(ms, ["a", "b"]));
  expect(changeLine(b, await stored(dispatcher))).toBeNull();
});

test("the change line is scanned once per board revision and mark, per group", () => {
  const scan = vi.fn(changeLine);
  const cache = new ChangeLineCache(scan);
  const b = board();
  b.revision = 7;
  b.events.push(event("t1", T0 + 1_000));
  const first = cache.get("g1", b, mark(T0), ["disp"], ["p"]);
  expect(cache.get("g1", b, mark(T0), ["disp"], ["p"])).toBe(first);
  expect(scan).toHaveBeenCalledTimes(1);
  // Another group has its own entry (its own mark and projects), and does not evict the first one.
  expect(cache.get("g2", b, mark(T0), ["disp"], [])).toBeNull();
  expect(cache.get("g1", b, mark(T0), ["disp"], ["p"])).toBe(first);
  expect(scan).toHaveBeenCalledTimes(2);
  // A new board revision, a new mark, a new dispatcher or a changed member list scans again.
  b.events.push(event("t2", T0 + 2_000));
  b.revision = 8;
  expect(cache.get("g1", b, mark(T0), ["disp"], ["p"])?.kind === "change").toBe(true);
  cache.get("g1", b, mark(T0 + 2_000), ["disp"], ["p"]);
  cache.get("g1", b, mark(T0 + 2_000), ["disp2"], ["p"]);
  cache.get("g1", b, mark(T0 + 2_000), ["disp2"], []);
  expect(scan).toHaveBeenCalledTimes(6);
  // A forgotten (deleted) group scans again.
  cache.forget("g2");
  cache.get("g2", b, mark(T0), ["disp"], []);
  expect(scan).toHaveBeenCalledTimes(7);
});

test("the change line counts only the group's live projects' cards (§0)", () => {
  const b = board();
  const now = iso(T0);
  b.projects.push({ ...b.projects[0], id: "q", groupId: "g2", createdAt: now } as never);
  b.projects[0] = { ...b.projects[0], groupId: "g1" };
  b.tasks.push({ ...b.tasks[0], id: "q1", projectId: "q", title: "Card q1" });
  b.events.push(event("t1", T0 + 1_000), event("q1", T0 + 2_000));
  const g1 = changeLine(b, mark(T0), [], groupProjectIds(b, "g1"));
  expect(g1?.kind === "change" && g1.cards.map((c) => c.taskId)).toEqual(["t1"]);
  const g2 = changeLine(b, mark(T0), [], groupProjectIds(b, "g2"));
  expect(g2?.kind === "change" && g2.cards.map((c) => c.taskId)).toEqual(["q1"]);
  // An archived member's cards never count, and a group without members has no line.
  expect(groupProjectIds(b, "g2")).toEqual(["q"]);
  b.projects[1] = { ...b.projects[1], groupId: "g1" };
  expect(groupProjectIds(b, "g1")).toEqual(["p"]);
  expect(changeLine(b, mark(T0), [], groupProjectIds(b, "nope"))).toBeNull();
  // Without a member list every live project counts, as before.
  expect(changeLine(b, mark(T0))?.kind === "change" && (changeLine(b, mark(T0)) as { cards: unknown[] }).cards).toHaveLength(2);
});

test("note rows are stamped with their group and session, and each group's chat shows only its own (§0, §9)", () => {
  const notes = [(note("t1", T0) as Extract<ChatItem, { kind: "note" }>).note];
  const [stamped] = noteItems(notes, iso(T0), { groupId: "g1", agentId: "a1" });
  expect(stamped).toMatchObject({ kind: "note", groupId: "g1", agentId: "a1", at: iso(T0) });
  const [plain] = noteItems(notes, iso(T0));
  expect(plain).not.toHaveProperty("groupId");
  const other = { ...stamped, id: "other", groupId: "g2", agentId: "a2" } as ChatItem;
  const legacy = note("t2", T0);
  const open = ask("q", T0, "open");
  const items = [stamped, other, legacy, open];
  // An unstamped (v1) note belongs to the migrated session's group; asks have no group.
  expect(groupItems(items, "g1", "g1").map((i) => i.id)).toEqual([stamped.id, legacy.id, "q"]);
  expect(groupItems(items, "g2", "g1").map((i) => i.id)).toEqual(["other", "q"]);
  expect(groupItems(items, "g2", null).map((i) => i.id)).toEqual(["other", "q"]);
});

test("the cap keeps the 500 newest notes of each group; asks are counted apart (§0, §9.1)", () => {
  const stampedNote = (groupId: string, i: number): ChatItem => ({ ...note(`${groupId}-${i}`, T0 + i), groupId, agentId: `a-${groupId}` }) as ChatItem;
  // Group a's notes are all newer than b's: a global cap would drop every one of b's.
  const items = [
    ...Array.from({ length: 520 }, (_, i) => stampedNote("b", i)),
    ...Array.from({ length: 600 }, (_, i) => stampedNote("a", 1_000 + i)),
    ask("old-open", T0 - 1, "open"),
  ];
  const kept = pruneItems(items, T0 + 10_000);
  const count = (groupId: string) => kept.filter((i) => i.kind === "note" && i.groupId === groupId).length;
  expect(count("a")).toBe(chatItemLimit);
  expect(count("b")).toBe(chatItemLimit);
  expect(kept.some((i) => i.id === "old-open")).toBe(true);
  // Each group keeps its newest, and the list stays oldest first.
  expect(kept.find((i) => i.kind === "note" && i.groupId === "b")!.id).toBe(`n-b-20-${T0 + 20}`);
  expect(kept.map((i) => i.at)).toEqual([...kept.map((i) => i.at)].sort());
});

test("concurrent first reads of a corrupt items file keep it aside once", async () => {
  const dir = await directory();
  await writeFile(join(dir, "dispatcher-items.json"), "{ not json");
  vi.mocked(logFailure).mockClear();
  let clock = T0;
  const items = new DispatcherItems(dir, { now: () => clock++ });
  const [a, b] = await Promise.all([items.list(), items.list()]);
  expect([a, b]).toEqual([[], []]);
  expect((await readdir(dir)).filter((f) => f.startsWith("dispatcher-items.json.invalid-"))).toHaveLength(1);
  expect(vi.mocked(logFailure)).toHaveBeenCalledTimes(1);
});

// ---- Updated picker: per-card mark seen, change summaries, echoes of the user's requests (DISPATCHER-SPEC §9.2) ----

const cardsOf = (line: ReturnType<typeof changeLine>) => (line?.kind === "change" ? line.cards : []);

test("mark seen with a card marks only that card; the others stay changed", async () => {
  const dir = await directory();
  const dispatcher = groupDispatcher(dir, () => T0 + 60_000);
  const b = board();
  b.tasks.push({ ...(b.tasks[0] as object), id: "t5", title: "Card t5" } as never);
  b.events.push(event("t1", T0 + 1_000), event("t2", T0 + 2_000), event("t5", T0 + 3_000));
  const line = changeLine(b, mark(T0));
  const t2 = cardsOf(line).find((c) => c.taskId === "t2")!;
  expect(cardsOf(line).map((c) => c.taskId)).toEqual(["t5", "t2", "t1"]);
  await dispatcher.markSeen("g1", t2.revision!, t2.ids, "t2");
  const marked = async () => ({ ...mark(T0), cards: (await dispatcher.record()).groups.g1.seenCards });
  expect(cardsOf(changeLine(b, await marked())).map((c) => c.taskId)).toEqual(["t5", "t1"]);
  // The group mark did not move, and a later change on the marked card shows again.
  expect((await dispatcher.record()).groups.g1.seenRevision).toBeUndefined();
  b.events.push(event("t2", T0 + 4_000));
  expect(cardsOf(changeLine(b, await marked())).map((c) => c.taskId)).toEqual(["t2", "t5", "t1"]);
});

test("each changed card says what changed, in plain kinds", () => {
  const b = board();
  b.events.push(
    event("t1", T0 + 1_000, { action: "status_changed", to: "committed" }),
    event("t1", T0 + 2_000, { action: "progress_reported", reportKind: "result" }),
    event("t1", T0 + 3_000, { action: "agent.turn_ended", outcome: "completed" }),
    event("t2", T0 + 4_000, { action: "progress_reported", reportKind: "question" }),
    event("t2", T0 + 5_000, { action: "progress_reported", reportKind: "blocker" }),
  );
  const cards = cardsOf(changeLine(b, mark(T0)));
  expect(cards.find((c) => c.taskId === "t1")?.changes).toEqual([
    { kind: "moved", status: "committed" },
    { kind: "result" },
    { kind: "session_finished" },
  ]);
  expect(cards.find((c) => c.taskId === "t2")?.changes).toEqual([{ kind: "question" }, { kind: "blocker" }]);
});

test("a card the dispatcher started at the user's request: its start-up is no news, its first stop is", () => {
  const b = board();
  b.events.push(
    event("t1", T0 + 1_000, { action: "created", agentId: "disp" }),
    event("t1", T0 + 2_000, { action: "agent.turn_started", actor: "system", agentId: "card-session" }),
    event("t1", T0 + 3_000, { action: "status_changed", to: "development", agentId: "card-session" }),
    event("t1", T0 + 4_000, { action: "tags_changed", agentId: "card-session" }),
  );
  // Only echoes of the request so far: nothing is news.
  expect(changeLine(b, mark(T0), ["disp"])).toBeNull();
  // The card then stops on its own: that is news, and only the stop counts.
  b.events.push(event("t1", T0 + 5_000, { action: "status_changed", to: "in_review", agentId: "card-session" }));
  const cards = cardsOf(changeLine(b, mark(T0), ["disp"]));
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ taskId: "t1", events: 1, changes: [{ kind: "moved", status: "in_review" }] });
  // Without the dispatcher's request, the same start-up counts.
  expect(cardsOf(changeLine(b, mark(T0), ["someone-else"]))[0].events).toBe(5);
});
