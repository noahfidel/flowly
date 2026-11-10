import { afterEach, expect, test } from "vitest";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { GuardrailsService, guardrailsStore } from "./guardrails";
import { MemoryService } from "./memory";
import { SummaryStore } from "./summaries";
import { emptyCounts, type GuardrailEntry } from "../shared/guardrails";
import type { MemoryState } from "../shared/memory";
import type { DetectedCommand } from "./review-detect";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(detected: DetectedCommand[] = []) {
  const f = await agentFixture();
  roots.push(f.root);
  const guardrails = new GuardrailsService(f.store, () => Date.now(), async () => detected);
  f.service.guardrails = guardrails;
  const stamp = new Date().toISOString();
  // Card "u": a second card of the project, a small bugfix delivery.
  await f.store.mutate((board) => {
    board.tasks.push({ ...board.tasks[0], id: "u", workspaceId: "wu", title: "Card U", type: "bugfix", operationId: "create-u", createdAt: stamp, updatedAt: stamp });
    board.tasks[0].review = review("m");
    board.tasks[1].review = review("s");
  });
  const state = () => guardrails.store.read();
  const learn = (taskId: string, correction: Parameters<GuardrailsService["learn"]>[0]["correction"], quote = "新文案也要进所有语言") => guardrails.learn({ taskId, correction, quote });
  return { ...f, guardrails, state, learn };
}
function review(size: "s" | "m" | "l") {
  const at = new Date().toISOString();
  return {
    trigger: { eventId: "e", agentId: "actor", from: "development" as const },
    round: 1,
    maxRounds: 2,
    state: "passed" as const,
    fingerprint: { taskRevision: 1, workpadRevision: 1, dirty: false },
    shared: false,
    items: [],
    shape: { files: 1, lines: size === "s" ? 10 : 100, size },
    startedAt: at,
  };
}
function entry(id: string, extra: Partial<GuardrailEntry> = {}): GuardrailEntry {
  const at = new Date().toISOString();
  return { id, projectId: "p", kind: "guideline", text: `Guideline ${id}`, scope: { types: ["feature"], sizes: ["m"] }, state: "active", stateAt: at, counts: emptyCounts(), sources: [], by: "learned", revision: 1, createdAt: at, updatedAt: at, ...extra };
}
async function seed(x: Awaited<ReturnType<typeof setup>>, entries: GuardrailEntry[]) {
  await x.guardrails.store.update((s) => {
    s.entries.push(...entries);
    return { value: undefined, changed: true };
  });
}
const exists = (path: string) => access(path).then(() => true, () => false);

test("migration (§3.6): memory.json and the review rules move once; memory.json is renamed; a second start changes nothing", async () => {
  const x = await setup();
  const dir = x.store.directory;
  const stamp = new Date().toISOString();
  const memory: MemoryState = {
    version: 1,
    revision: 4,
    entries: [
      { id: "m1", projectId: "p", kind: "pitfall", title: "Two modals freeze Paseo", body: "", tags: [], keywords: [], pinned: false, status: "candidate", source: { by: "agent", taskId: "t" }, revision: 1, createdAt: stamp, updatedAt: stamp },
      { id: "m2", projectId: "p", kind: "decision", title: "No upper bound", body: "", tags: [], keywords: [], pinned: false, status: "dismissed", source: { by: "retro", taskId: "t" }, revision: 2, createdAt: stamp, updatedAt: stamp },
    ],
    errors: [],
    retros: [],
    recallStats: {},
    clues: [{ id: "c", taskId: "t", projectId: "p", at: stamp, kind: "feedback", text: "Strings go in every catalog" }],
  };
  await writeFile(join(dir, "memory.json"), JSON.stringify(memory));
  await x.store.mutate((board) => {
    board.projects[0].autoReview = { enabled: true, maxRounds: 2, rules: [{ id: "tests", name: "Tests", kind: "command", argv: ["npm", "test"] }, { id: "i18n", name: "i18n", kind: "llm", prompt: "Every new string is in all catalogs.", types: ["feature"] }] };
  });
  const store = guardrailsStore(dir);
  expect(await store.migrate(async () => (await x.store.read()).projects)).toBe("migrated");
  const state = await store.read();
  expect(state.entries.map((e) => [e.id.length > 2 ? "new" : e.id, e.kind, e.state, e.text])).toEqual([
    ["m1", "note", "active", "Two modals freeze Paseo"],
    ["m2", "note", "archived", "No upper bound"],
    ["new", "command", "active", "Tests"],
    ["new", "guideline", "active", "Every new string is in all catalogs."],
  ]);
  expect(state.clues).toEqual(memory.clues);
  expect(await exists(join(dir, "memory.json"))).toBe(false);
  expect(JSON.parse(await readFile(join(dir, "memory.json.migrated"), "utf8"))).toEqual(memory);
  expect(await store.migrate(async () => (await x.store.read()).projects)).toBe("present");
  expect((await store.read()).entries).toHaveLength(4);
});

test("a failed migration leaves both files as they were; the store reads empty, refuses writes, and a later migration still runs", async () => {
  const x = await setup();
  const dir = x.store.directory;
  await writeFile(join(dir, "memory.json"), "{ broken");
  const store = guardrailsStore(dir);
  const projects = async () => (await x.store.read()).projects;
  expect(await store.migrate(projects)).toBe("failed");
  expect(await readFile(join(dir, "memory.json"), "utf8")).toBe("{ broken");
  expect((await store.read()).entries).toEqual([]);
  // A write would create guardrails.json and the next start would skip the migration.
  await expect(store.update(() => ({ value: undefined, changed: true }))).rejects.toThrow(`Guardrails migration from memory.json failed; nothing is saved until it is fixed (see ${join(dir, "memory.json")})`);
  expect(await exists(join(dir, "guardrails.json"))).toBe(false);
  // The next start, with memory.json fixed, migrates and writes work again.
  const stamp = new Date().toISOString();
  const memory: MemoryState = {
    version: 1,
    revision: 1,
    entries: [{ id: "m1", projectId: "p", kind: "pitfall", title: "Two modals freeze Paseo", body: "", tags: [], keywords: [], pinned: false, status: "candidate", source: { by: "agent", taskId: "t" }, revision: 1, createdAt: stamp, updatedAt: stamp }],
    errors: [],
    retros: [],
    recallStats: {},
    clues: [],
  };
  await writeFile(join(dir, "memory.json"), JSON.stringify(memory));
  expect(await store.migrate(projects)).toBe("migrated");
  expect((await store.read()).entries.map((e) => e.id)).toEqual(["m1"]);
  await store.update(() => ({ value: undefined, changed: true }));
});

test("learning (§4.3): new opens an item; the same on this card counts; the same on another card promotes both into a guideline", async () => {
  const x = await setup();
  await x.learn("t", { kind: "new", text: "Every new UI string is in all language catalogs" });
  let s = await x.state();
  expect(s.items).toEqual([expect.objectContaining({ taskId: "t", text: "Every new UI string is in all language catalogs", quote: "新文案也要进所有语言", shape: { type: "feature", size: "m" }, count: 1, state: "open" })]);
  const first = s.items[0];
  await x.learn("t", { kind: "same", matches: `#${first.id.slice(0, 8)}` });
  expect((await x.state()).items[0].count).toBe(2);
  // Card U, a small bugfix, is sent back for the same thing.
  await x.learn("u", { kind: "same", matches: first.id.slice(0, 8) }, "zh-TW 又漏了");
  s = await x.state();
  const g = s.entries.find((e) => e.kind === "guideline")!;
  expect(g).toMatchObject({ text: "Every new UI string is in all language catalogs", state: "active", by: "learned", scope: { types: ["feature", "bugfix"], sizes: ["m", "s"] } });
  expect(g.sources.map((src) => [src.taskId, src.quote])).toEqual([
    ["t", "新文案也要进所有语言"],
    ["u", "zh-TW 又漏了"],
  ]);
  expect(s.items.map((i) => [i.taskId, i.state, i.promotedTo])).toEqual([
    ["t", "promoted", g.id],
    ["u", "promoted", g.id],
  ]);
  const events = (await x.store.read()).events.filter((e) => e.action === "guardrail_learned");
  expect(events.map((e) => [e.taskId, e.guardrail])).toEqual([
    ["t", { change: "item", kind: "item", id: first.id }],
    ["u", { change: "guideline", kind: "guideline", id: g.id }],
  ]);
});

test("learning: a matched active guideline counts a miss and widens its scope; a paused or archived one is revived", async () => {
  const x = await setup();
  await seed(x, [entry("aaaaaaaa-1"), entry("bbbbbbbb-1", { state: "paused", stateReason: "misfired twice in 30 days", scope: { types: ["feature"], sizes: "all" } })]);
  // Both cards' latest reviews let the guideline through (passed / not applicable).
  await x.store.mutate((board) => {
    board.tasks[0].review!.items = [{ id: "bbbbbbbb-1", kind: "guideline", name: "Guideline", gating: true, state: "na" }];
    board.tasks[1].review!.items = [{ id: "aaaaaaaa-1", kind: "guideline", name: "Guideline", gating: true, state: "passed" }];
  });
  // Card U (bugfix, s) is out of scope for aaaaaaaa: it widens to hold it.
  await x.learn("u", { kind: "same", matches: "aaaaaaaa" });
  let s = await x.state();
  expect(s.entries[0]).toMatchObject({ counts: { missed: 1 }, scope: { types: ["feature", "bugfix"], sizes: ["m", "s"] }, revision: 2 });
  expect(s.entries[0].sources.map((src) => src.taskId)).toEqual(["u"]);
  await x.learn("t", { kind: "same", matches: "bbbbbbbb" });
  s = await x.state();
  expect(s.entries[1]).toMatchObject({ state: "active", stateReason: "revived", counts: { missed: 1 } });
  // No duplicate guideline or item was created.
  expect(s.entries).toHaveLength(2);
  expect(s.items).toEqual([]);
  const changes = (await x.store.read()).events.filter((e) => e.action === "guardrail_learned").map((e) => e.guardrail?.change);
  expect(changes).toEqual(["widened", "revived"]);
});

test("card A is Done before card B is sent back for the same problem: A's item still promotes (§3.3)", async () => {
  const x = await setup();
  await x.learn("t", { kind: "new", text: "Every new UI string is in all language catalogs" });
  await x.store.mutate((board) => {
    board.tasks[0].status = "done";
  });
  await x.guardrails.finishTask("t");
  const item = (await x.state()).items[0];
  expect(item.state).toBe("open");
  // The rework summary of card U still lists A's item, and its correction matches it.
  expect(await x.guardrails.section("u")).toContain(`#${item.id.slice(0, 8)} other card: Every new UI string is in all language catalogs`);
  await x.learn("u", { kind: "same", matches: item.id.slice(0, 8) });
  const s = await x.state();
  expect(s.entries).toEqual([expect.objectContaining({ kind: "guideline", state: "active", text: "Every new UI string is in all language catalogs" })]);
  expect(s.items.map((i) => [i.taskId, i.state])).toEqual([
    ["t", "promoted"],
    ["u", "promoted"],
  ]);
});

test("a correction that matches a merged guideline counts on the live one, which the old one is not revived over (§4.3)", async () => {
  const x = await setup();
  await seed(x, [
    entry("aaaaaaaa-old", { text: "New strings go in every catalog", state: "archived", stateReason: "merged", supersededBy: "bbbbbbbb-new" }),
    entry("bbbbbbbb-new", { text: "Every new UI string is in all language catalogs" }),
  ]);
  await x.learn("t", { kind: "same", matches: "aaaaaaaa" });
  // By text too.
  await x.learn("t", { kind: "new", text: "New strings go in every catalog" });
  const s = await x.state();
  expect(s.entries[0]).toMatchObject({ state: "archived", stateReason: "merged", revision: 1 });
  expect(s.entries[1].sources.map((src) => src.taskId)).toEqual(["t"]);
  expect(s.entries[1].revision).toBe(3);
  expect(s.items).toEqual([]);
});

test("no miss without a review that let the guideline through: the source is added and the scope widened all the same", async () => {
  const x = await setup();
  await seed(x, [entry("aaaaaaaa-1"), entry("bbbbbbbb-1", { state: "archived", stateReason: "never caught anything" })]);
  // Card U's latest review failed the guideline (it did not let it through) and never judged bbbbbbbb.
  await x.store.mutate((board) => {
    board.tasks[1].review!.items = [{ id: "aaaaaaaa-1", kind: "guideline", name: "Guideline", gating: true, state: "failed" }];
  });
  await x.learn("u", { kind: "same", matches: "aaaaaaaa" });
  await x.learn("u", { kind: "same", matches: "bbbbbbbb" });
  const s = await x.state();
  expect(s.entries[0]).toMatchObject({ counts: { missed: 0 }, scope: { types: ["feature", "bugfix"], sizes: ["m", "s"] } });
  expect(s.entries[0].sources.map((src) => src.taskId)).toEqual(["u"]);
  expect(s.entries[1]).toMatchObject({ state: "active", stateReason: "revived", counts: { missed: 0 } });
});

test("a disputed finding the user sends the card back for counts as caught, not missed, and the dispute ends (§6.6)", async () => {
  const x = await setup();
  await seed(x, [entry("cccccccc-1")]);
  await x.store.mutate((board) => {
    board.tasks[0].disputes = [{ id: "cccccccc-1", kind: "guideline", name: "Guideline", reason: "Not needed here", round: 1, at: new Date().toISOString() }];
  });
  await x.learn("t", { kind: "same", matches: "cccccccc" });
  expect((await x.state()).entries[0].counts).toMatchObject({ caught: 1, missed: 0 });
  expect((await x.store.read()).tasks[0].disputes).toBeUndefined();
});

test("finishing a card keeps its open items and counts each remaining dispute as a misfire", async () => {
  const x = await setup();
  await seed(x, [entry("dddddddd-1")]);
  await x.learn("t", { kind: "new", text: "Rerun button is missing" });
  await x.store.mutate((board) => {
    board.tasks[0].disputes = [{ id: "dddddddd-1", kind: "guideline", name: "Guideline", reason: "Docs-only change", round: 1, at: new Date().toISOString() }];
  });
  await x.guardrails.finishTask("t");
  const s = await x.state();
  expect(s.items[0].state).toBe("open");
  expect(s.entries[0].counts).toMatchObject({ misfire: 1, misfireAt: [expect.any(String)] });
  expect((await x.store.read()).tasks[0].disputes).toBeUndefined();
});

test("caps: five open items per card close the oldest; a promotion past 20 guidelines displaces the weakest", async () => {
  const x = await setup();
  for (let i = 0; i < 6; i++) await x.learn("t", { kind: "new", text: `Problem number ${i}` });
  let s = await x.state();
  expect(s.items.filter((i) => i.state === "open").map((i) => i.text)).toEqual(["Problem number 1", "Problem number 2", "Problem number 3", "Problem number 4", "Problem number 5"]);
  expect(s.items[0].state).toBe("closed");
  await seed(x, Array.from({ length: 20 }, (_, i) => entry(`g${String(i).padStart(9, "0")}`, { counts: { ...emptyCounts(), reviews: 10, caught: i === 4 ? 0 : 3 } })));
  const open = s.items.find((i) => i.state === "open")!;
  await x.learn("u", { kind: "same", matches: open.id.slice(0, 8) });
  s = await x.state();
  expect(s.entries.filter((e) => e.kind === "guideline" && e.state === "active")).toHaveLength(20);
  expect(s.entries.find((e) => e.id === "g000000004")).toMatchObject({ state: "archived", stateReason: "displaced" });
  expect((await x.store.read()).events.filter((e) => e.action === "guardrail_retired").map((e) => e.guardrail)).toEqual([{ change: "displaced", kind: "guideline", id: "g000000004" }]);
});

test("nothing is learned from a secret, with Guardrails off, or from none", async () => {
  const x = await setup();
  await x.learn("t", { kind: "new", text: "Use token npm_" + "t438cQg15C1LvYZFBfjwhHilAzSKAl1UuTLQ" });
  await x.learn("t", { kind: "none" });
  let s = await x.state();
  expect(s.items).toEqual([]);
  expect(s.errors).toEqual([expect.objectContaining({ projectId: "p", taskId: "t", message: expect.stringContaining("secret") })]);
  await x.store.mutate((board) => {
    board.projects[0].memory = false;
  });
  await x.learn("t", { kind: "new", text: "Anything" });
  s = await x.state();
  expect(s.items).toEqual([]);
  expect(await x.guardrails.section("t")).toBeNull();
});

test("guardrails RPCs: create, a stale revision is GUARDRAIL_CONFLICT, delete keeps a backup", async () => {
  const x = await setup();
  const command = await x.guardrails.create({ projectId: "p", kind: "command", text: "Tests", argv: ["npm", "test"] });
  expect(command).toMatchObject({ state: "active", by: "user", revision: 1 });
  await expect(x.guardrails.create({ projectId: "p", kind: "command", text: "tests", argv: ["npm", "t"] })).rejects.toMatchObject({ code: "MEMORY_DUPLICATE" });
  const paused = await x.guardrails.update({ id: command.id, revision: 1, state: "paused" });
  expect(paused).toMatchObject({ state: "paused", revision: 2 });
  await expect(x.guardrails.update({ id: command.id, revision: 1, state: "active" })).rejects.toMatchObject({ code: "GUARDRAIL_CONFLICT" });
  await expect(x.guardrails.remove({ id: command.id, revision: 1 })).rejects.toMatchObject({ code: "GUARDRAIL_CONFLICT" });
  const note = await x.guardrails.create({ projectId: "p", kind: "note", noteKind: "convention", text: "MR descriptions follow the template" });
  await expect(x.guardrails.update({ id: note.id, revision: 1, state: "observing" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await x.guardrails.remove({ id: command.id, revision: 2 });
  expect((await x.state()).entries.map((e) => e.id)).toEqual([note.id]);
  expect((await readdir(join(x.store.directory, "removed"))).some((n) => n.startsWith(`guardrail-${command.id}`))).toBe(true);
  const view = await x.guardrails.view("p");
  expect(view).toMatchObject({ enabled: true, running: [] });
  expect(view.entries).toHaveLength(1);
});

test("detection adds the found commands as observing, skips names and argv the project has, and stops at the cap", async () => {
  const x = await setup([
    { name: "Typecheck", argv: ["npm", "run", "typecheck"], checked: true },
    { name: "Tests", argv: ["npm", "run", "test"], checked: true },
    { name: "Build", argv: ["npm", "run", "build"], checked: false },
  ]);
  await x.guardrails.create({ projectId: "p", kind: "command", text: "Unit", argv: ["npm", "run", "test"] });
  const result = await x.guardrails.detect("p");
  expect(result.found).toEqual(["Typecheck", "Tests"]);
  expect(result.added.map((e) => [e.text, e.state, e.by, e.observe])).toEqual([["Typecheck", "observing", "detect", { reviews: 0, passed: 0 }]]);
  expect((await x.guardrails.detect("p")).added).toEqual([]);
  expect(await x.guardrails.counts()).toEqual({ p: { observing: 1, added: 0, notes: 0 } });
  await x.guardrails.create({ projectId: "p", kind: "note", noteKind: "decision", text: "Keep argv arrays" });
  expect(await x.guardrails.counts()).toEqual({ p: { observing: 1, added: 0, notes: 1 } });
});

test("get_task.guardrails (§5.2): commands, guidelines in the card's current scope and its open items; memory has no candidates", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects[0].autoReview = { enabled: true, maxRounds: 3 };
  });
  await seed(x, [
    entry("eeeeeeee-1", { text: "In scope" }),
    entry("ffffffff-1", { text: "Large only", scope: { types: "all", sizes: ["l"] } }),
    { ...entry("cmd-1"), kind: "command", text: "Tests", argv: ["npm", "test"], scope: undefined, state: "observing" },
    { ...entry("cmd-2"), kind: "command", text: "Lint", argv: ["npm", "run", "lint"], scope: undefined, state: "paused" },
  ]);
  await x.learn("t", { kind: "new", text: "Rerun button is missing" });
  x.service.memory = new MemoryService(x.store, new SummaryStore(x.store.directory), async () => ({ summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true }), async () => "en");
  const ctx = await x.service.get(x.identity);
  expect(ctx.guardrails).toMatchObject({
    enabled: true,
    maxRounds: 3,
    commands: [{ id: "cmd-1", name: "Tests", argv: ["npm", "test"], state: "observing" }],
    guidelines: [{ id: "eeeeeeee-1", text: "In scope", scope: { types: ["feature"], sizes: ["m"] } }],
    items: [{ text: "Rerun button is missing", count: 1 }],
    lastReview: { shape: { size: "m" } },
  });
  expect(ctx.memory).toEqual({ enabled: true, total: 0, entries: [] });
  // Guardrails off: commands only.
  await x.store.mutate((board) => {
    board.projects[0].memory = false;
  });
  const off = await x.service.get(x.identity);
  expect(off.guardrails).toMatchObject({ commands: [{ id: "cmd-1" }], guidelines: [], items: [] });
});

test("a new session's first instructions list the guidelines for its type, then the notes", async () => {
  const x = await setup();
  await seed(x, [
    entry("gg000001", { text: "Every new UI string is in all language catalogs", scope: { types: ["feature"], sizes: ["s"] }, counts: { ...emptyCounts(), caught: 2 } }),
    entry("gg000002", { text: "Bugfixes come with a regression test", scope: { types: ["bugfix"], sizes: "all" } }),
    { ...entry("nn000001"), kind: "note", noteKind: "pitfall", text: "Two modals in one frame freeze Paseo", scope: undefined, tags: [], keywords: [] },
  ]);
  const ctx = await new BoardService(x.store).context("t", x.paseo);
  expect(ctx.context).toContain(
    "Project guardrails (checked when you deliver; 1 of them apply to this card's type):\n- Every new UI string is in all language catalogs (caught 2 times)\nProject memory (all 1 entries):\n- [Pitfall] Two modals in one frame freeze Paseo (memory nn000001)\n",
  );
  expect(ctx.context).not.toContain("regression test");
  expect(ctx.memoryIds).toEqual(["nn000001"]);
});

test("a deleted card's open and closed items go (backed up), its promoted ones stay; a removed project goes whole", async () => {
  const x = await setup();
  await x.learn("t", { kind: "new", text: "First problem" });
  await x.learn("t", { kind: "new", text: "Second problem" });
  const first = (await x.state()).items[0];
  await x.learn("u", { kind: "same", matches: first.id.slice(0, 8) });
  await x.guardrails.removeTask("t");
  let s = await x.state();
  expect(s.items.map((i) => [i.taskId, i.text, i.state])).toEqual([
    ["t", "First problem", "promoted"],
    ["u", "First problem", "promoted"],
  ]);
  expect(s.entries).toHaveLength(1);
  await x.guardrails.removeProject("p", new Set(["t", "u"]));
  s = await x.state();
  expect([s.entries, s.items]).toEqual([[], []]);
  const removed = await readdir(join(x.store.directory, "removed"));
  expect(removed.some((n) => n.startsWith("task-t-guardrails"))).toBe(true);
  expect(removed.some((n) => n.startsWith("p-guardrails"))).toBe(true);
});

test("a rework turn is one the user opened while the card was In review", async () => {
  const x = await setup();
  const memory = new MemoryService(x.store, new SummaryStore(x.store.directory), async () => ({ summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true }), async () => "en");
  const turn = async (text: string, delivered: boolean) => {
    await x.store.mutate((board) => {
      if (delivered) x.store.event(board, { taskId: "t", agentId: "actor", actor: "agent", action: "status_changed", from: "development", to: "in_review", note: "done" });
      x.store.event(board, { taskId: "t", agentId: "actor", actor: "system", action: "agent.turn_started" });
    });
    return memory.reworkQuote(x.identity, [{ type: "user_message", text }], await x.store.read());
  };
  expect(await turn("The zh-TW catalog is missing the new strings", true)).toBe("The zh-TW catalog is missing the new strings");
  // A short correction counts; it is still too short to be kept as a clue (§4.1).
  expect(await turn("测试没跑", true)).toBe("测试没跑");
  await memory.recordTurn(x.identity, [{ type: "user_message", text: "测试没跑" }], await x.store.read());
  expect((await x.state()).clues).toEqual([]);
  // A picked next move is not the user's own words, however short.
  await x.store.mutate((board) => {
    x.store.event(board, { taskId: "t", agentId: "actor", actor: "agent", action: "next_moves_suggested", moves: [{ label: "Push", prompt: "push" }] });
  });
  expect(await turn("push", true)).toBeNull();
  await x.store.mutate((board) => {
    x.store.event(board, { taskId: "t", agentId: "actor", actor: "human", action: "status_changed", from: "in_review", to: "development" });
  });
  expect(await turn("Now also add a settings toggle please", false)).toBeNull();
});

test("an invalid guardrails.json is preserved and reported, never reset", async () => {
  const x = await setup();
  await mkdir(x.store.directory, { recursive: true });
  await writeFile(join(x.store.directory, "guardrails.json"), "[]");
  await expect(x.guardrails.create({ projectId: "p", kind: "note", noteKind: "pitfall", text: "x" })).rejects.toThrow("preserved");
  expect(await readFile(join(x.store.directory, "guardrails.json"), "utf8")).toBe("[]");
});

test("phase B surface: the removed RPCs (memory.* included) are gone, insights.guardrails exists; project settings take only enabled and maxRounds (§7.5, §8)", async () => {
  const rpc = await import("../shared/rpc");
  const { projectEdit } = await import("../shared/model");
  const names = Object.values(rpc).flatMap((v) => (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" ? [(v as { name: string }).name] : []));
  for (const gone of [
    "reviews.detect-commands",
    "reviews.analyze-history",
    "reviews.analysis-status",
    "reviews.apply-draft",
    "reviews.discard-draft",
    "reviews.setup-card",
    "insights.add-review-check",
    "insights.pause-review-check",
    "insights.dismiss-review-nudge",
    "workpads.resolve-confusion",
    "workpads.refresh",
  ])
    expect(names).not.toContain(gone);
  // The Guardrails page replaced the Memory page: no memory.* RPC is left (the retro is guardrails.retro).
  expect(names.filter((n) => n.startsWith("memory."))).toEqual([]);
  for (const kept of ["insights.guardrails", "reviews.rerun", "workpads.check", "guardrails.detect", "guardrails.retro"]) expect(names).toContain(kept);
  expect(projectEdit.safeParse({ id: "p", revision: 1, autoReview: { enabled: true, maxRounds: 2 } }).success).toBe(true);
  for (const extra of [{ rules: [] }, { goal: false }, { guidance: "g" }, { checks: [] }])
    expect(projectEdit.safeParse({ id: "p", revision: 1, autoReview: { enabled: true, maxRounds: 2, ...extra } }).success).toBe(false);
});

test("weekly helpers: a command's log keys in every package manager's spelling; a gone script or make target (§4.5)", async () => {
  const { commandKeys, scriptMissing, usageCards } = await import("./guardrails");
  expect(commandKeys(["npm", "run", "test"])).toEqual(expect.arrayContaining(["npm run test", "npm test", "pnpm test", "yarn test", "bun run test"]));
  expect(commandKeys(["pnpm", "run", "test:e2e"])).toEqual(expect.arrayContaining(["npm run test:e2e", "yarn test:e2e"]));
  expect(commandKeys(["go", "vet", "./..."])).toEqual(["go vet"]);
  const record = (taskId: string, actions: string[]) => ({ id: `${taskId}${actions[0]}`, at: new Date().toISOString(), taskId, agentId: "a", lane: "development", provider: "claude", status: "completed" as const, actions, explore: 0 });
  expect(usageCards(["npm", "run", "lint"], [record("a", ["npm run lint"]), record("b", ["yarn lint"]), record("b", ["pnpm run lint"]), record("c", ["npm test"])])).toBe(2);
  const names = { scripts: new Set(["test", "lint"]), targets: new Set(["check"]) };
  expect(scriptMissing(["npm", "run", "typecheck"], names)).toBe(true);
  expect(scriptMissing(["npm", "test"], names)).toBe(false);
  expect(scriptMissing(["make", "test"], names)).toBe(true);
  expect(scriptMissing(["make", "check"], names)).toBe(false);
  expect(scriptMissing(["cargo", "test"], names)).toBe(false);
  // Unreadable package.json: nothing counts as missing.
  expect(scriptMissing(["npm", "run", "typecheck"], { scripts: null, targets: null })).toBe(false);
});

test("reviewInput: commands always; guidelines in scope and the card's open items only while Guardrails is on, with the user's words", async () => {
  const x = await setup();
  await x.guardrails.store.update((state) => {
    state.entries.push(
      entry("g-in", { scope: { types: ["feature"], sizes: ["m"] }, sources: [{ taskId: "old", at: new Date().toISOString(), quote: "earlier words" }, { taskId: "u", at: new Date().toISOString(), quote: "latest words" }] }),
      entry("g-out", { scope: { types: ["feature"], sizes: ["l"] } }),
      { ...entry("c-obs"), kind: "command", text: "E2E", argv: ["npm", "run", "e2e"], scope: undefined, state: "observing" },
      { ...entry("c-off"), kind: "command", text: "Old", argv: ["npm", "run", "old"], scope: undefined, state: "paused" },
    );
    state.items.push({ id: "i-1", projectId: "p", taskId: "t", text: "Keep scroll", quote: "滚动位置丢了", shape: {}, count: 1, state: "open", createdAt: "x", updatedAt: "x" });
    return { value: undefined, changed: true };
  });
  const board = await x.store.read();
  const input = await x.guardrails.reviewInput(board.tasks[0]!, board.projects[0]!, "m");
  expect(input.commands.map((c) => c.id)).toEqual(["c-obs"]);
  expect(input.guidelines.map((g) => g.id)).toEqual(["g-in"]);
  expect(input.items.map((i) => i.id)).toEqual(["i-1"]);
  expect([...input.words]).toEqual([["g-in", "latest words"], ["i-1", "滚动位置丢了"]]);
  const off = await x.guardrails.reviewInput(board.tasks[0]!, { ...board.projects[0]!, memory: false }, "m");
  expect([off.commands.length, off.guidelines.length, off.items.length]).toEqual([1, 0, 0]);
});
