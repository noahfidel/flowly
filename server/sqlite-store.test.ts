import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { BoardStore } from "./store";
import { JsonBoardFile } from "./board-file";
import { upgradeBoard } from "./migrate";
import { readDatabaseFile, sqliteVersionOk, type StorageOptions } from "./sqlite-storage";
import { agentFixture } from "./agent-fixture";
import { AgentService } from "./agent-service";
import { ToolSecrets } from "./tool-context";
import { updateUmbrella } from "./umbrellas";
import { emptyBoard, type Board } from "../shared/model";

const directories: string[] = [];
const stores: BoardStore[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "flowly-sqlite-test-"));
  directories.push(path);
  return path;
}
function open(path: string, storage: StorageOptions = {}) {
  const store = new BoardStore(path, { backend: "sqlite", storage: { checkVersion: false, ...storage } });
  stores.push(store);
  return store;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const onDisk = (path: string) => readDatabaseFile(sqlite, join(path, "flowly.sqlite"));
const text = (value: unknown) => JSON.stringify(value);
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const missing = (path: string) => stat(path).then(() => false, () => true);
/** The board without its revisions: what a restore or export must keep unchanged. */
function content(board: Board) {
  const copy = structuredClone(board);
  copy.revision = 0;
  for (const x of [...copy.projects, ...copy.tasks, ...copy.workpads]) x.revision = 0;
  for (const u of copy.umbrellas) {
    u.revision = 0;
    u.feedRevision = 0;
  }
  return text(copy);
}
function fixture(): Board {
  const b = emptyBoard(),
    at = "2026-10-20T10:00:00.000Z";
  b.revision = 7;
  b.projects.push({ id: "p1", paseoProjectId: "native1", title: "Fixture", description: "", primaryPath: "/repo1", repos: ["/repo1"], revision: 3, createdAt: at, updatedAt: at, archivedAt: null });
  const task = (id: string, position: number) => ({
    id,
    projectId: "p1",
    workspaceId: `w-${id}`,
    sourcePath: "/repo1",
    repoPaths: [],
    title: `Card ${id} — ünïcode\nline`,
    description: "",
    status: "todo" as const,
    priority: "normal" as const,
    position,
    revision: 1,
    operationId: `op-${id}`,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  });
  // An explicitly empty tag list and none at all stay different.
  b.tasks.push({ ...task("t1", 0), tags: [] }, task("t2", 1.5));
  for (let i = 0; i < 5; i++) b.events.push({ id: `e${i}`, taskId: i % 2 ? "t2" : "t1", actor: "human", action: "edited", note: `n${i}`, at });
  // Old files can repeat an event id; every occurrence stays, in order.
  b.events.push({ id: "e1", taskId: "t2", actor: "system", action: "edited", at });
  return b;
}
async function writeBoard(path: string, board: unknown) {
  const bytes = JSON.stringify(board, null, 2);
  await writeFile(join(path, "board.json"), bytes);
  return bytes;
}
/** What the existing JSON reader makes of the same file, read in a separate directory. */
async function jsonReading(board: unknown) {
  const other = await directory();
  await writeBoard(other, board);
  return new JsonBoardFile(other).load();
}

describe("lanes stored before Committed or Integrated (COMMITTED-STAGE-SPEC §2, INTEGRATED-STAGE-SPEC §2)", () => {
  const all = ["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const;
  test.each([
    { rows: 9, missing: ["committed", "integrated"] },
    { rows: 10, missing: ["integrated"] },
  ])("a project row with $rows lanes reads with the missing ones in place; the next write stores 11", async ({ missing }) => {
    const d = await directory();
    const board = fixture();
    board.projects[0].lanes = all.map((status) => ({ status, enabled: true }));
    await writeBoard(d, board);
    await open(d).read();
    await stores.pop()!.close();
    // The row as an older Flowly wrote it.
    const db = new sqlite.DatabaseSync(join(d, "flowly.sqlite"));
    const row = db.prepare("SELECT body FROM items WHERE collection = 'projects' AND key = 'p1'").get() as { body: string };
    const project = JSON.parse(row.body);
    project.lanes = project.lanes.filter((l: { status: string }) => !missing.includes(l.status));
    db.prepare("UPDATE items SET body = ? WHERE collection = 'projects' AND key = 'p1'").run(JSON.stringify(project));
    db.close();
    const s = open(d);
    const read = await s.read();
    expect(read.projects[0].lanes!.map((l) => l.status)).toEqual(all);
    expect(onDisk(d).projects[0].lanes).toHaveLength(11);
    await s.editTask({ id: "t1", revision: 1, status: "integrated", actor: "human" });
    await s.close();
    stores.pop();
    const stored = new sqlite.DatabaseSync(join(d, "flowly.sqlite"));
    const after = JSON.parse((stored.prepare("SELECT body FROM items WHERE collection = 'projects' AND key = 'p1'").get() as { body: string }).body);
    stored.close();
    expect(after.lanes).toHaveLength(11);
  });
});

describe("moving board.json to SQLite", () => {
  test("the first start moves the board: same board, a retired board.json, a verified snapshot and a backup", async () => {
    const d = await directory();
    const bytes = await writeBoard(d, fixture());
    const expected = await jsonReading(fixture());
    const s = open(d);
    const board = await s.read();
    expect(text(board)).toBe(text(expected));
    expect(text(onDisk(d))).toBe(text(expected));
    expect(board.tasks[0].tags).toEqual([]);
    expect("tags" in board.tasks[1]).toBe(false);
    expect(board.events.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "e1"]);
    const marker = JSON.parse(await readFile(join(d, "board.json"), "utf8"));
    expect(marker).toMatchObject({ version: 0, storage: "sqlite" });
    // An older Flowly refuses the marker instead of starting with an empty board: its load() runs this same
    // upgradeBoard (server/migrate.ts is unchanged since 1.6.0) after copying the file to board.pre-v4.json.
    expect(() => upgradeBoard(marker)).toThrow();
    const [run] = await readdir(join(d, "migrations"));
    const manifest = JSON.parse(await readFile(join(d, "migrations", run, "manifest.json"), "utf8"));
    expect(manifest.files["board.json"].sha256).toBe(sha(bytes));
    expect(await readFile(join(d, "migrations", run, "board.json"), "utf8")).toBe(bytes);
    expect((await s.storageStatus()).backups).toHaveLength(1);
    expect(await s.storageStatus()).toMatchObject({ backend: "sqlite", migratedAt: expect.any(String) });
  });

  test.each([1, 2, 3, 4])("a v%i board moves exactly as the JSON reader upgrades it", async (version) => {
    const d = await directory();
    const raw: Record<string, unknown> = { ...fixture(), version };
    if (version === 1) raw.tasks = fixture().tasks.map(({ repoPaths: _, ...t }) => t);
    await writeBoard(d, raw);
    const expected = await jsonReading(raw);
    expect(text(await open(d).read())).toBe(text(expected));
  });

  test("a move that fails keeps board.json, works on JSON, and moves at the next start", async () => {
    const d = await directory();
    const bytes = await writeBoard(d, fixture());
    const s = open(d, {
      step: (name) => {
        if (name === "migrate:before-rename") throw new Error("disk full");
      },
    });
    await s.read();
    expect(await readFile(join(d, "board.json"), "utf8")).toBe(bytes);
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    expect(await missing(join(d, "flowly.sqlite.tmp"))).toBe(true);
    expect(await s.storageStatus()).toMatchObject({ backend: "json", reason: "migration-failed", detail: "disk full" });
    await s.editTask({ id: "t1", revision: 1, title: "On JSON", actor: "human" });
    expect(JSON.parse(await readFile(join(d, "board.json"), "utf8")).tasks[0].title).toBe("On JSON");
    await s.close();
    const next = open(d);
    expect((await next.read()).tasks[0].title).toBe("On JSON");
    expect((await next.storageStatus()).backend).toBe("sqlite");
  });

  test.each(["migrate:snapshot", "migrate:checked", "migrate:before-rename"])("a move that fails at %s leaves board.json as it was and stays on JSON", async (point) => {
    const d = await directory();
    const bytes = await writeBoard(d, fixture());
    const s = open(d, {
      step: (name) => {
        if (name === point) throw new Error(`failed at ${point}`);
      },
    });
    expect(text(await s.read())).toBe(text(await jsonReading(fixture())));
    expect(await readFile(join(d, "board.json"), "utf8")).toBe(bytes);
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    expect(await missing(join(d, "flowly.sqlite.tmp"))).toBe(true);
    expect(await s.storageStatus()).toMatchObject({ backend: "json", reason: "migration-failed" });
  });

  test("the snapshot and the backups are readable by the owner only", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d);
    await s.read();
    const [run] = await readdir(join(d, "migrations"));
    const [backup] = (await s.storageStatus()).backups;
    for (const file of [join(d, "migrations", run, "board.json"), join(d, "backups", backup.name), join(d, "flowly.sqlite")]) {
      const info = await stat(file);
      // Windows reports every writable file as 0o666.
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
    }
  });

  test("an unreadable board.json is not moved and fails as before", async () => {
    const d = await directory();
    await writeFile(join(d, "board.json"), "{ not json");
    const s = open(d);
    await expect(s.read()).rejects.toMatchObject({ code: "STORE_INVALID" });
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    expect(await readFile(join(d, "board.json"), "utf8")).toBe("{ not json");
  });
});

describe("start-up rules", () => {
  test("a move stopped after the rename and before the marker is completed", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const crashed = open(d, {
      step: (name) => {
        if (name === "migrate:after-rename") throw new Error("killed");
      },
    });
    await expect(crashed.read()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(d, "board.json"), "utf8")).version).toBe(5);
    await crashed.close();
    const next = open(d);
    expect(text(await next.read())).toBe(text(await jsonReading(fixture())));
    expect(JSON.parse(await readFile(join(d, "board.json"), "utf8")).storage).toBe("sqlite");
  });

  test("a leftover unfinished database is discarded before moving", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    await writeFile(join(d, "flowly.sqlite.tmp"), "half a database");
    expect(text(await open(d).read())).toBe(text(await jsonReading(fixture())));
    expect(await missing(join(d, "flowly.sqlite.tmp"))).toBe(true);
  });

  test("a database next to a different board.json is left alone", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d);
    await s.read();
    await s.close();
    const other = fixture();
    other.tasks[0].title = "Edited by an older version";
    const bytes = await writeBoard(d, other);
    const database = await readFile(join(d, "flowly.sqlite"));
    await expect(open(d).read()).rejects.toMatchObject({ code: "STORAGE_DIVERGED" });
    expect(await readFile(join(d, "board.json"), "utf8")).toBe(bytes);
    expect(sha(await readFile(join(d, "flowly.sqlite")))).toBe(sha(database));
  });

  test("a missing database is never replaced by an empty board; a backup brings it back", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d);
    const before = await s.read();
    await s.close();
    await rm(join(d, "flowly.sqlite"));
    const next = open(d);
    await expect(next.read()).rejects.toMatchObject({ code: "STORAGE_MISSING" });
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    const [backup] = (await next.storageStatus()).backups;
    await next.restoreStorage(backup.name);
    expect(content(await next.read())).toBe(content(before));
  });

  test("a new installation starts with an empty board in SQLite", async () => {
    const d = await directory();
    expect(text(await open(d).read())).toBe(text(emptyBoard()));
    expect(await missing(join(d, "flowly.sqlite"))).toBe(false);
    expect(JSON.parse(await readFile(join(d, "board.json"), "utf8")).storage).toBe("sqlite");
  });

  test("without node:sqlite the board stays on JSON, and a moved board is refused instead of read as empty", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const plain = open(d, { sqlite: async () => null });
    await plain.editTask({ id: "t1", revision: 1, title: "Still JSON", actor: "human" });
    expect(await plain.storageStatus()).toMatchObject({ backend: "json", reason: "unsupported" });
    await plain.close();
    await open(d).read();
    const old = open(d, { sqlite: async () => null });
    await expect(old.read()).rejects.toMatchObject({ code: "STORAGE_UNSUPPORTED" });
  });

  test("on a SQLite version with the WAL bug the board stays on JSON, and a moved board is refused", async () => {
    class OldSqlite extends sqlite.DatabaseSync {
      prepare(sql: string) {
        return sql.includes("sqlite_version") ? ({ get: () => ({ v: "3.50.4" }) } as unknown as ReturnType<sqlite.DatabaseSync["prepare"]>) : super.prepare(sql);
      }
    }
    const old = async () => ({ ...sqlite, DatabaseSync: OldSqlite }) as unknown as typeof sqlite;
    const d = await directory();
    await writeBoard(d, fixture());
    const plain = open(d, { sqlite: old, checkVersion: true });
    expect((await plain.read()).tasks).toHaveLength(2);
    expect(await plain.storageStatus()).toMatchObject({ backend: "json", reason: "unsupported", detail: expect.stringContaining("3.50.4") });
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    await plain.close();
    await open(d).read();
    await expect(open(d, { sqlite: old, checkVersion: true }).read()).rejects.toMatchObject({ code: "STORAGE_UNSUPPORTED" });
  });

  test("SQLite versions with the WAL reset bug are refused", () => {
    for (const ok of ["3.51.3", "3.53.4", "3.50.7", "3.44.6", "4.0.0"]) expect(sqliteVersionOk(ok)).toBe(true);
    for (const bad of ["3.51.2", "3.50.6", "3.49.1", "3.45.0", "3.44.5", "3.43.9"]) expect(sqliteVersionOk(bad)).toBe(false);
  });

  test("a second Flowly process cannot open the board while the first holds it", { timeout: 20000 }, async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const first = open(d);
    await first.read();
    const second = open(d);
    await expect(second.read()).rejects.toMatchObject({ code: "STORAGE_BUSY" });
    expect(await second.storageStatus()).toMatchObject({ backend: "error", reason: "busy" });
    await first.close();
    await new Promise((r) => setTimeout(r, 2100));
    expect((await second.read()).tasks).toHaveLength(2);
  });
});

describe("writes", () => {
  test("every kind of write reads back from the database exactly as cached", async () => {
    const x = await agentFixture({}, "sqlite");
    stores.push(x.store);
    directories.push(x.root);
    const d = x.store.directory;
    const same = async () => expect(text(onDisk(d))).toBe(text(await x.store.read()));
    const call = async () => {
      const c = await x.service.get(x.identity);
      return { expectedRevision: c.revision, request: c.request };
    };
    await same();
    await x.service.write(x.identity, "status", { ...(await call()), note: "start", status: "development" });
    await same();
    await x.service.write(x.identity, "progress", { ...(await call()), note: "working" });
    await same();
    await x.service.write(x.identity, "tags", { ...(await call()), add: ["drawer"] });
    await same();
    const idea = await x.service.write(x.identity, "idea", { ...(await call()), title: "Follow-up", detail: "Do it.", rationale: "Seen." });
    await same();
    await x.service.write(x.identity, "artifact", { ...(await call()), note: "Spec", role: "output", target: "https://example.com/spec" });
    await same();
    await x.service.write(x.identity, "next_moves", { ...(await call()), moves: [{ label: "Push", prompt: "Push it." }] });
    await same();
    const replayed = await call();
    const first = await x.service.write(x.identity, "progress", { ...replayed, note: "once" });
    expect(await x.service.write(x.identity, "progress", { ...replayed, note: "once" })).toMatchObject({ receipt: first.receipt, replayed: true });
    await same();
    await x.store.updateIdea({ id: (idea as { ideaId: string }).ideaId, status: "dismissed" });
    await same();
    const task = (await x.store.read()).tasks[0];
    await x.store.editTask({ id: "t", revision: task.revision, title: "Renamed", actor: "human" });
    await same();
    // A card at the front reorders the tasks; repeated event ids; an event removed from the middle.
    await x.store.mutate((b) => {
      b.tasks.unshift({ ...b.tasks[0], id: "t0", workspaceId: "w0", operationId: "op0", title: "Front" });
      const e = b.events[0];
      b.events.push({ ...e }, { ...e });
      b.events.splice(1, 1);
    });
    await same();
    await x.store.deleteTask({ id: "t0", revision: (await x.store.read()).tasks[0].revision });
    await same();
    const before = await x.store.read();
    await x.store.close();
    expect(text(await open(d).read())).toBe(text(before));
  });

  test("after a restart an agent request replays its stored receipt and writes nothing", async () => {
    const x = await agentFixture({}, "sqlite");
    stores.push(x.store);
    directories.push(x.root);
    const c = await x.service.get(x.identity);
    const request = { expectedRevision: c.revision, request: c.request, note: "deliver", status: "in_review" };
    const first = await x.service.write(x.identity, "status", request);
    await x.store.editTask({ id: "t", revision: 2, status: "done", archived: true, actor: "human" });
    x.advance(16 * 60 * 1000);
    await x.store.close();
    const store = open(x.store.directory);
    const secrets = new ToolSecrets(x.store.directory);
    await secrets.initialize();
    const restarted = new AgentService(store, secrets);
    restarted.attach(x.paseo);
    const before = text(await store.read());
    expect(await restarted.write(x.identity, "status", request)).toMatchObject({ receipt: first.receipt, replayed: true, current: { task: { status: "done" }, writable: false } });
    expect(text(await store.read())).toBe(before);
    expect(text(onDisk(x.store.directory))).toBe(before);
    await expect(restarted.write(x.identity, "status", { ...request, note: "different" })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  });

  test("a write that fails inside the transaction changes neither the database nor the cache", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    let fail = false;
    const s = open(d, {
      step: (name) => {
        if (fail && name === "save:written") throw new Error("injected");
      },
    });
    const before = await s.read();
    fail = true;
    await expect(s.editTask({ id: "t1", revision: 1, title: "Lost", actor: "human" })).rejects.toThrow("injected");
    fail = false;
    expect(text(await s.read())).toBe(text(before));
    expect(text(onDisk(d))).toBe(text(before));
    await s.editTask({ id: "t1", revision: 1, title: "Kept", actor: "human" });
    expect(onDisk(d).tasks[0].title).toBe("Kept");
  });
});

describe("backups, restore and the way back to JSON", () => {
  test("restore brings back a backup, moves every revision past the old ones and keeps the replaced database", async () => {
    let now = Date.parse("2026-10-26T00:00:00Z");
    const d = await directory();
    const board = fixture(),
      human = { kind: "human" as const },
      at = "2026-10-20T10:00:00.000Z";
    board.umbrellas.push({
      id: "u1", groupId: "g1", title: "Umbrella", brief: { text: "Before", revision: 1, updatedAt: at, updatedBy: human },
      contract: { text: "", revision: 0, updatedAt: at, updatedBy: human }, acceptance: [], status: "open",
      createdBy: human, createdAt: at, updatedAt: at, revision: 3, feedRevision: 2, archivedAt: null,
    });
    await writeBoard(d, board);
    const s = open(d, { now: () => new Date(now) });
    const original = await s.read();
    const [backup] = (await s.storageStatus()).backups;
    now += 1000;
    await s.editTask({ id: "t1", revision: 1, title: "After the backup", actor: "human" });
    const edited = await s.read();
    now += 1000;
    const { aside } = await s.restoreStorage(backup.name);
    const restored = await s.read();
    expect(content(restored)).toBe(content(original));
    expect(restored.revision).toBeGreaterThan(edited.revision);
    expect(restored.tasks[0].revision).toBeGreaterThan(edited.tasks[0].revision);
    expect(restored.projects[0].revision).toBeGreaterThan(edited.projects[0].revision);
    // A panel holding the umbrella from before the restore is refused and sees a new feedRevision.
    expect(restored.umbrellas[0].revision).toBeGreaterThan(edited.umbrellas[0].revision);
    expect(restored.umbrellas[0].feedRevision).toBeGreaterThan(edited.umbrellas[0].feedRevision);
    await expect(updateUmbrella(s, { id: "u1", revision: edited.umbrellas[0].revision, brief: "Stale" }, { kind: "human" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(s.editTask({ id: "t1", revision: edited.tasks[0].revision, title: "Stale", actor: "human" })).rejects.toThrow(/Revision conflict/);
    expect(aside).toMatch(/^flowly\.sqlite\.before-restore-/);
    expect(readDatabaseFile(sqlite, join(d, aside!)).tasks[0].title).toBe("After the backup");
    expect(text(onDisk(d))).toBe(text(restored));
  });

  test("a restored backup that cannot be opened is reported, and another backup still restores", async () => {
    let now = Date.parse("2026-10-26T00:00:00Z");
    let corrupt = false;
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d, {
      now: () => new Date(now),
      step: (name) => {
        if (corrupt && name === "restore:replaced") writeFileSync(join(d, "flowly.sqlite"), "not a database");
      },
    });
    const original = await s.read();
    now += 1000;
    await s.backupStorage();
    const [newest, oldest] = (await s.storageStatus()).backups;
    corrupt = true;
    await expect(s.restoreStorage(newest.name)).rejects.toThrow(/is now flowly\.sqlite but cannot be opened/);
    expect(await s.storageStatus()).toMatchObject({ backend: "error", reason: "invalid" });
    corrupt = false;
    now += 1000;
    await s.restoreStorage(oldest.name);
    expect(content(await s.read())).toBe(content(original));
  });

  test("backups run once a day after a write, and only the newest seven of Flowly's own are kept", async () => {
    let now = Date.parse("2026-10-26T00:00:00Z");
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d, { now: () => new Date(now) });
    await s.read();
    now += 60_000;
    await s.editTask({ id: "t1", revision: 1, title: "Same day", actor: "human" });
    expect((await s.storageStatus()).backups).toHaveLength(1);
    now += 24 * 60 * 60 * 1000;
    await s.editTask({ id: "t1", revision: 2, title: "Next day", actor: "human" });
    expect((await s.storageStatus()).backups).toHaveLength(2);
    await writeFile(join(d, "backups", "mine.sqlite"), "not Flowly's");
    for (let i = 0; i < 7; i++) {
      now += 1000;
      await s.backupStorage();
    }
    const names = (await s.storageStatus()).backups.map((b) => b.name);
    expect(names).toHaveLength(7);
    expect(names[0]).toBe("flowly-20261027-000107.sqlite");
    expect(await readFile(join(d, "backups", "mine.sqlite"), "utf8")).toBe("not Flowly's");
  });

  test("databases kept aside in the same second get their own names", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d, { now: () => new Date("2026-10-26T00:00:00Z") });
    await s.read();
    const [backup] = (await s.storageStatus()).backups;
    const first = await s.restoreStorage(backup.name);
    const second = await s.restoreStorage(backup.name);
    expect(first.aside).toBe("flowly.sqlite.before-restore-20261026-000000");
    expect(second.aside).toBe("flowly.sqlite.before-restore-20261026-000000-1");
    expect(await missing(join(d, first.aside!))).toBe(false);
  });

  test("backups made within one second keep their order, so the newest seven stay", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d, { now: () => new Date("2026-10-26T00:00:00Z") });
    await s.read();
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await s.backupStorage());
    const names = (await s.storageStatus()).backups.map((b) => b.name);
    expect(names).toEqual([...made].reverse());
    expect(names).not.toContain("flowly-20261026-000000.sqlite");
  });

  test.each(["export:mode", "export:json"])("an export stopped after %s restarts in a consistent state", async (point) => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d, {
      step: (name) => {
        if (name === point) throw new Error("killed");
      },
    });
    const before = await s.read();
    await expect(s.exportStorage()).rejects.toThrow("killed");
    await s.close();
    const next = open(d);
    const after = await next.read();
    if (point === "export:mode") {
      // board.json was never written: the export did not happen.
      expect(text(after)).toBe(text(before));
      expect((await next.storageStatus()).backend).toBe("sqlite");
      expect(await missing(join(d, "storage-mode.json"))).toBe(true);
    } else {
      // board.json already held the board: the export is finished.
      expect(content(after)).toBe(content(before));
      expect(await next.storageStatus()).toMatchObject({ backend: "json", reason: "exported" });
      expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    }
  });

  // A read-only folder blocks the rename except on Windows and for root, which ignores directory permissions.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an export whose database cannot be renamed aside still switches to JSON, and SQLite can come back", async () => {
    let now = Date.parse("2026-10-26T00:00:00Z");
    const d = await directory();
    await writeBoard(d, fixture());
    // Once board.json holds the board, the data folder stops accepting renames.
    const s = open(d, { now: () => new Date(now), step: (name) => name === "export:json" && chmodSync(d, 0o500) });
    const before = await s.read();
    try {
      expect(await s.exportStorage()).toEqual({ retired: null });
    } finally {
      chmodSync(d, 0o700);
    }
    expect(await missing(join(d, "flowly.sqlite"))).toBe(false);
    expect(await s.storageStatus()).toMatchObject({ backend: "json", reason: "exported" });
    expect(content(await s.read())).toBe(content(before));
    now += 1000;
    await s.useSqliteStorage();
    expect((await s.storageStatus()).backend).toBe("sqlite");
    expect(content(await s.read())).toBe(content(before));
  });

  test("export writes a board.json older versions read, retires the database, and SQLite can come back", async () => {
    const d = await directory();
    await writeBoard(d, fixture());
    const s = open(d);
    await s.editTask({ id: "t1", revision: 1, title: "Before export", actor: "human" });
    const before = await s.read();
    const { retired } = await s.exportStorage();
    const raw = JSON.parse(await readFile(join(d, "board.json"), "utf8"));
    // The reader of the previous release: upgradeBoard on the v5 file.
    const exported = upgradeBoard(raw);
    expect(raw.version).toBe(5);
    expect(content(exported)).toBe(content(before));
    expect(exported.tasks[0].revision).toBeGreaterThan(before.tasks[0].revision);
    expect(await missing(join(d, retired!))).toBe(false);
    expect(await missing(join(d, "flowly.sqlite"))).toBe(true);
    expect(await s.storageStatus()).toMatchObject({ backend: "json", reason: "exported" });
    await expect(s.editTask({ id: "t1", revision: before.tasks[0].revision, title: "Stale", actor: "human" })).rejects.toThrow(/Revision conflict/);
    await s.editTask({ id: "t1", revision: exported.tasks[0].revision, title: "On JSON", actor: "human" });
    await s.close();
    const again = open(d);
    expect((await again.read()).tasks[0].title).toBe("On JSON");
    expect((await again.storageStatus()).backend).toBe("json");
    await again.useSqliteStorage();
    expect((await again.storageStatus()).backend).toBe("sqlite");
    expect((await again.read()).tasks[0].title).toBe("On JSON");
    expect(onDisk(d).tasks[0].title).toBe("On JSON");
  });

  test("storage.export-json includes umbrellas and entries", async () => {
    const d = await directory();
    const board = fixture(),
      human = { kind: "human" as const },
      at = "2026-10-20T10:00:00.000Z";
    board.umbrellas.push({
      id: "u1", groupId: "g1", title: "Umbrella", brief: { text: "The full brief", revision: 1, updatedAt: at, updatedBy: human },
      contract: { text: "The contract", revision: 1, updatedAt: at, updatedBy: human }, acceptance: [], status: "open",
      createdBy: human, createdAt: at, updatedAt: at, revision: 3, feedRevision: 2, archivedAt: null,
    });
    board.umbrellaEntries.push({
      id: "e1", umbrellaId: "u1", kind: "decision", title: "Decided", body: "Body", status: "active", sourceTaskId: "t1",
      by: human, createdAt: at, updatedAt: at,
    });
    board.tasks[0].umbrella = { id: "u1", role: "map", joinedAt: at, by: human };
    await writeBoard(d, board);
    const s = open(d);
    await s.exportStorage();
    const raw = JSON.parse(await readFile(join(d, "board.json"), "utf8"));
    // Read from storage, not the client view: brief and contract text and the entries are all there.
    expect(raw.umbrellas).toEqual([expect.objectContaining({ id: "u1", brief: expect.objectContaining({ text: "The full brief" }), contract: expect.objectContaining({ text: "The contract" }) })]);
    expect(raw.umbrellaEntries).toEqual([expect.objectContaining({ id: "e1", sourceTaskId: "t1" })]);
    expect(raw.tasks[0].umbrella).toMatchObject({ id: "u1", role: "map" });
  });
});
