import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { emptyBoard, storageSchema, type Board } from "../shared/model";
import type { StorageReason, StorageStatus } from "../shared/storage";
import {
  JsonBoardFile,
  StoreInvalidError,
  assertBoardInvariants,
  isRetiredMarker,
  retiredMarker,
  syncDirectory,
  syncFile,
  writeFileAtomic,
  writeFileDurable,
  type BoardPersistence,
} from "./board-file";
import { logFailure } from "./error-report";

/**
 * The board in `flowly.sqlite` (SQLITE-STORAGE-SPEC): start-up rules, the one-time move from
 * board.json, row-level writes, backups, restore and the export back to JSON. Everything
 * except {@link BoardStorage.status} runs inside BoardStore's write queue.
 */
type Sqlite = typeof import("node:sqlite");
export type StorageOptions = {
  /** node:sqlite, or null when this host has none. */
  sqlite?: () => Promise<Sqlite | null>;
  /** Refuse SQLite versions with the WAL reset bug; off only for tests on older runtimes. */
  checkVersion?: boolean;
  now?: () => Date;
  /** Test seam called at named points of a migration, write, restore or export. */
  step?: (name: string) => void;
};

const DB = "flowly.sqlite",
  TMP = "flowly.sqlite.tmp",
  OWNER = "storage-owner.sqlite",
  MODE = "storage-mode.json",
  KEEP_BACKUPS = 7,
  DAY = 24 * 60 * 60 * 1000;
const backupName = /^flowly-(\d{8})-(\d{6})(?:-(\d+))?\.sqlite$/;
const SIDE = ["-wal", "-shm", "-journal"];

/** SQLite 3.51.3, or the fixed 3.50.7 / 3.44.6 branches: earlier versions can corrupt a WAL database. */
export function sqliteVersionOk(version: string) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major !== 3) return major > 3;
  return minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6);
}

const loadSqlite = async (): Promise<Sqlite | null> => {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
};
const exists = (path: string) => stat(path).then(() => true, () => false);
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const stamp = (at: Date) => at.toISOString().replace(/\D/g, "").slice(0, 14).replace(/^(\d{8})/, "$1-");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---- Rows ----------------------------------------------------------------------------------

type Row = { ord: number; body: string };
type Collection = { rows: Map<string, Row>; maxOrd: number };
/** What the database holds, by collection and key: compared with the next board to write only what changed. */
type Index = Map<string, Collection>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS items (
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  ord INTEGER NOT NULL,
  task_id TEXT,
  project_id TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (collection, key)
) STRICT;
CREATE INDEX IF NOT EXISTS items_task ON items (collection, task_id);
CREATE INDEX IF NOT EXISTS items_project ON items (collection, project_id);`;

const collectionsOf = (board: Board) => Object.keys(board).filter((k) => Array.isArray((board as Record<string, unknown>)[k]));
/** A stable key per element: its id, receipt key or card; repeated keys (old duplicate events) get an occurrence suffix. */
function keysOf(items: readonly Record<string, unknown>[]) {
  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const base = typeof item.id === "string" ? item.id : typeof item.key === "string" ? item.key : typeof item.taskId === "string" ? item.taskId : `\u001f@${i}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}\u001f#${n}` : base;
  });
}
const taskOf = (collection: string, item: Record<string, unknown>) =>
  collection === "tasks" ? (item.id as string) : typeof item.taskId === "string" ? item.taskId : null;
const projectOf = (collection: string, item: Record<string, unknown>) =>
  collection === "projects" ? (item.id as string) : typeof item.projectId === "string" ? item.projectId : null;

/** Writes the rows that differ from `index` (inside the caller's transaction) and returns the new index. */
function writeBoard(db: DatabaseSync, board: Board, index: Index): Index {
  const upsert = db.prepare(
    "INSERT INTO items (collection, key, ord, task_id, project_id, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET ord = excluded.ord, task_id = excluded.task_id, project_id = excluded.project_id, body = excluded.body",
  );
  const remove = db.prepare("DELETE FROM items WHERE collection = ? AND key = ?");
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const names = collectionsOf(board);
  for (const name of index.keys()) if (!names.includes(name)) db.prepare("DELETE FROM items WHERE collection = ?").run(name);
  const next: Index = new Map();
  for (const name of names) {
    const items = (board as Record<string, unknown>)[name] as Record<string, unknown>[];
    const keys = keysOf(items);
    const before = index.get(name) ?? { rows: new Map(), maxOrd: -1 };
    const present = new Set(keys);
    for (const key of before.rows.keys()) if (!present.has(key)) remove.run(name, key);
    // Kept elements in the same order and new ones only at the end: existing rows keep their place.
    let inOrder = true,
      last = -Infinity,
      added = false;
    for (const key of keys) {
      const row = before.rows.get(key);
      if (!row) added = true;
      else if (added || row.ord <= last) {
        inOrder = false;
        break;
      } else last = row.ord;
    }
    let ord = before.maxOrd,
      maxOrd = -1;
    const rows = new Map<string, Row>();
    keys.forEach((key, i) => {
      const item = items[i],
        body = JSON.stringify(item),
        old = before.rows.get(key);
      const place = inOrder ? (old ? old.ord : ++ord) : i;
      if (!old || old.ord !== place || old.body !== body) upsert.run(name, key, place, taskOf(name, item), projectOf(name, item), body);
      rows.set(key, { ord: place, body });
      maxOrd = Math.max(maxOrd, place);
    });
    next.set(name, { rows, maxOrd });
  }
  for (const [key, value] of Object.entries(board)) if (!Array.isArray(value)) meta.run(`board.${key}`, JSON.stringify(value));
  meta.run("board.collections", JSON.stringify(names));
  return next;
}

function readBoard(db: DatabaseSync): { board: Board; index: Index; migratedAt?: string } {
  const meta = new Map((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  if (meta.get("schema") !== "1") throw new Error(`Unknown flowly.sqlite schema ${meta.get("schema") ?? "(none)"}.`);
  const raw: Record<string, unknown> = {};
  const index: Index = new Map();
  for (const [key, value] of meta) if (key.startsWith("board.") && key !== "board.collections") raw[key.slice(6)] = JSON.parse(value);
  for (const name of JSON.parse(meta.get("board.collections") ?? "[]") as string[]) {
    raw[name] = [];
    index.set(name, { rows: new Map(), maxOrd: -1 });
  }
  for (const row of db.prepare("SELECT collection, key, ord, body FROM items ORDER BY collection, ord").iterate() as Iterable<{ collection: string; key: string; ord: number; body: string }>) {
    let collection = index.get(row.collection);
    if (!collection) index.set(row.collection, (collection = { rows: new Map(), maxOrd: -1 }));
    ((raw[row.collection] ??= []) as unknown[]).push(JSON.parse(row.body));
    collection.rows.set(row.key, { ord: row.ord, body: row.body });
    collection.maxOrd = Math.max(collection.maxOrd, row.ord);
  }
  const board = storageSchema.parse(raw);
  assertBoardInvariants(board);
  return { board, index, migratedAt: meta.get("migratedAt") };
}

function configure(db: DatabaseSync, journal: "WAL" | "DELETE") {
  db.exec(`PRAGMA journal_mode = ${journal}`);
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 1000");
  const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  const sync = (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
  if (mode.toUpperCase() !== journal || sync !== 2) throw new Error(`SQLite kept journal_mode=${mode}, synchronous=${sync}.`);
}
function check(db: DatabaseSync, pragma: "integrity_check" | "quick_check") {
  const result = (db.prepare(`PRAGMA ${pragma}`).all() as Record<string, string>[]).map((r) => Object.values(r)[0]);
  if (result.length !== 1 || result[0] !== "ok") throw new Error(`SQLite ${pragma} failed: ${result.slice(0, 3).join("; ")}`);
}
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
/** The highest revision a client or agent can hold for this board. */
const maxRevision = (board: Board) => Math.max(board.revision, ...board.projects.map((p) => p.revision), ...board.tasks.map((t) => t.revision), ...board.workpads.map((w) => w.revision), ...board.groups.map((g) => g.revision));
/** Moves every revision past `offset` so edits and agent requests made against other data are refused (§7). */
function bumpRevisions(board: Board, offset: number) {
  board.revision += offset;
  for (const p of board.projects) p.revision += offset;
  for (const t of board.tasks) t.revision += offset;
  for (const w of board.workpads) w.revision += offset;
  for (const g of board.groups) g.revision += offset;
}

/** The open database and its cached board; only this process writes it (owner lock). */
class SqliteBoard implements BoardPersistence {
  constructor(
    readonly db: DatabaseSync,
    private board: Board,
    private index: Index,
    private readonly step?: (name: string) => void,
  ) {}
  current() {
    return structuredClone(this.board);
  }
  async load() {
    return structuredClone(this.board);
  }
  async save(board: Board) {
    this.index = transaction(this.db, () => {
      const index = writeBoard(this.db, board, this.index);
      this.step?.("save:written");
      return index;
    });
    this.board = board;
  }
}

type State =
  | { kind: "starting" }
  | { kind: "sqlite"; board: SqliteBoard; migratedAt?: string }
  | { kind: "json"; reason: "exported" | "unsupported" | "migration-failed"; detail?: string }
  | { kind: "error"; reason: "busy" | "diverged" | "missing" | "unsupported" | "invalid"; detail: string; at: number };
const errorCodes = { busy: "STORAGE_BUSY", diverged: "STORAGE_DIVERGED", missing: "STORAGE_MISSING", unsupported: "STORAGE_UNSUPPORTED", invalid: "STORE_INVALID" } as const;

export class BoardStorage {
  private state: State = { kind: "starting" };
  private sqlite: Sqlite | null | undefined;
  private owner: DatabaseSync | null = null;
  private lastBackup = 0;
  constructor(
    readonly directory: string,
    private readonly json: JsonBoardFile,
    private readonly options: StorageOptions = {},
  ) {}
  private path(name: string) {
    return join(this.directory, name);
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private step(name: string) {
    this.options.step?.(name);
  }

  /** Applies the start-up rules (§6). Never rejects: a failure becomes a JSON fallback or an error state. */
  async start() {
    try {
      await this.open();
    } catch (error) {
      this.closeDatabase();
      this.releaseOwner();
      this.fail("invalid", `Flowly could not open its storage in ${this.directory}: ${message(error)}`);
    }
  }
  /** Where reads and writes go now; a busy owner lock is retried at most every two seconds. */
  async persistence(): Promise<BoardPersistence> {
    if (this.state.kind === "error" && this.state.reason === "busy" && Date.now() - this.state.at > 2000) await this.start();
    const state = this.state;
    if (state.kind === "sqlite") return state.board;
    if (state.kind === "json") return this.json;
    if (state.kind === "starting") throw new StoreInvalidError("Flowly storage is still starting.", "STORAGE_BUSY", true);
    throw new StoreInvalidError(state.detail, errorCodes[state.reason], state.reason === "busy");
  }

  private fail(reason: Extract<State, { kind: "error" }>["reason"], detail: string) {
    this.state = { kind: "error", reason, detail, at: Date.now() };
    // No error object here: report the storage error code (detail may hold paths, so it is log-only).
    logFailure("Flowly storage failed:", Object.assign(new Error(detail), { name: "StorageError", code: errorCodes[reason] }));
  }
  private async readMode() {
    try {
      return (JSON.parse(await readFile(this.path(MODE), "utf8")) as { backend?: unknown }).backend === "json";
    } catch {
      return false;
    }
  }
  /** board.json now: absent, the retired marker, or a board (its bytes, even when they don't parse). */
  private async boardFile(): Promise<{ kind: "none" } | { kind: "marker" } | { kind: "board"; bytes: Buffer }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.json.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      throw error;
    }
    try {
      if (isRetiredMarker(JSON.parse(bytes.toString("utf8")))) return { kind: "marker" };
    } catch {
      /* unreadable JSON counts as a board: never overwritten silently */
    }
    return { kind: "board", bytes };
  }
  private writeMarker() {
    return writeFileAtomic(this.json.path, `${JSON.stringify(retiredMarker(this.now().toISOString()), null, 2)}\n`);
  }
  /** The sha256 of board.json in the newest migration snapshot. */
  private async snapshotHash() {
    const folder = this.path("migrations");
    const runs = (await readdir(folder).catch(() => [] as string[])).sort().reverse();
    for (const run of runs) {
      try {
        const manifest = JSON.parse(await readFile(join(folder, run, "manifest.json"), "utf8")) as { files?: Record<string, { sha256: string }> };
        if (manifest.files?.["board.json"]) return manifest.files["board.json"].sha256;
      } catch {
        /* an unreadable snapshot is skipped */
      }
    }
    return null;
  }

  private async open() {
    this.closeDatabase();
    if (await this.readMode()) {
      if ((await this.boardFile()).kind === "board") {
        // An export that stopped before renaming the database aside finishes here (§8).
        if (await exists(this.path(DB)))
          await this.retireDatabase("retired").catch((error) => logFailure("Flowly storage: renaming the exported database aside failed; it stays unused:", error));
        this.releaseOwner();
        this.state = { kind: "json", reason: "exported" };
        return;
      }
      // The export stopped before board.json held the board: it did not happen.
      await rm(this.path(MODE), { force: true });
    }
    this.sqlite ??= await (this.options.sqlite ?? loadSqlite)();
    const sqlite = this.sqlite;
    const version = sqlite ? this.sqliteVersion(sqlite) : null;
    if (!sqlite || (this.options.checkVersion !== false && !sqliteVersionOk(version!))) {
      const why = sqlite ? `SQLite ${version} has a known WAL bug; it needs 3.51.3 or later.` : "This Paseo has no node:sqlite.";
      if ((await exists(this.path(DB))) || (await this.boardFile()).kind === "marker")
        return this.fail("unsupported", `Flowly's board is in ${this.path(DB)}, but this Paseo cannot open it. ${why} Update Paseo.`);
      this.state = { kind: "json", reason: "unsupported", detail: why };
      return;
    }
    if (!(await this.acquireOwner(sqlite))) return this.fail("busy", "Another Flowly process is still using this data. Reload the plugin if this persists.");
    for (const name of [TMP, ...SIDE.map((s) => TMP + s)]) await rm(this.path(name), { force: true });
    const file = await this.boardFile();
    if (await exists(this.path(DB))) {
      if (file.kind === "none") await this.writeMarker();
      else if (file.kind === "board") {
        // A move that stopped after the rename and before the marker leaves the snapshot's board.json here.
        if (sha256(file.bytes) !== (await this.snapshotHash()))
          return this.fail("diverged", `Both ${this.path(DB)} and a different ${this.json.path} exist. Flowly changed neither; move one of them aside.`);
        await this.writeMarker();
      }
      return this.openDatabase(sqlite);
    }
    if (file.kind === "board") return this.migrate(sqlite);
    if (file.kind === "marker" || (await exists(this.path("backups"))) || (await exists(this.path("migrations"))))
      return this.fail("missing", `${this.path(DB)} is missing. Restore a backup in Settings > Storage, or copy one from ${this.path("backups")}.`);
    await this.migrate(sqlite, true);
  }
  private sqliteVersion(sqlite: Sqlite) {
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      return (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    } finally {
      db.close();
    }
  }
  /** OS-released lock on storage-owner.sqlite: only its holder opens flowly.sqlite. Retries briefly while an old process exits. */
  private async acquireOwner(sqlite: Sqlite) {
    if (this.owner) return true;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 10; attempt++) {
      const db = new sqlite.DatabaseSync(this.path(OWNER));
      try {
        db.exec("PRAGMA busy_timeout = 0");
        db.exec("PRAGMA journal_mode = DELETE");
        db.exec("CREATE TABLE IF NOT EXISTS owner (one INTEGER PRIMARY KEY) STRICT");
        db.exec("BEGIN EXCLUSIVE");
        this.owner = db;
        await chmod(this.path(OWNER), 0o600);
        return true;
      } catch (error) {
        db.close();
        if (!/locked|busy/i.test(message(error))) throw error;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
  private releaseOwner() {
    if (!this.owner) return;
    try {
      this.owner.exec("ROLLBACK");
    } catch {
      /* closing releases the lock anyway */
    }
    this.owner.close();
    this.owner = null;
  }
  private closeDatabase() {
    if (this.state.kind !== "sqlite") return;
    const { db } = this.state.board;
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      logFailure("Flowly storage: checkpoint before close failed:", error);
    }
    db.close();
    this.state = { kind: "starting" };
  }
  private async openDatabase(sqlite: Sqlite) {
    const db = new sqlite.DatabaseSync(this.path(DB));
    try {
      configure(db, "WAL");
      await chmod(this.path(DB), 0o600);
      const { board, index, migratedAt } = readBoard(db);
      this.state = { kind: "sqlite", board: new SqliteBoard(db, board, index, this.options.step), migratedAt };
    } catch (error) {
      db.close();
      return this.fail("invalid", `${this.path(DB)} cannot be read (${message(error)}). Restore a backup in Settings > Storage.`);
    }
    this.lastBackup = (await this.backups())[0]?.time ?? 0;
    if (this.now().getTime() - this.lastBackup >= DAY) await this.backupQuietly();
  }

  /** The one-time move from board.json (§6). Any failure before the rename keeps board.json and falls back to JSON. */
  private async migrate(sqlite: Sqlite, fresh = false) {
    const started = Date.now();
    let source: Board;
    try {
      source = fresh ? emptyBoard() : await this.json.load();
    } catch (error) {
      this.releaseOwner();
      this.state = { kind: "json", reason: "migration-failed", detail: message(error) };
      return;
    }
    const at = this.now();
    const tmp = this.path(TMP);
    try {
      if (!fresh) await this.snapshot(at);
      this.step("migrate:snapshot");
      const db = new sqlite.DatabaseSync(tmp);
      try {
        await chmod(tmp, 0o600);
        configure(db, "DELETE");
        db.exec(SCHEMA);
        transaction(db, () => {
          writeBoard(db, source, new Map());
          const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          meta.run("schema", "1");
          meta.run("migratedAt", at.toISOString());
        });
        check(db, "integrity_check");
        // The database must give back exactly the board the existing reader produced.
        if (JSON.stringify(readBoard(db).board) !== JSON.stringify(storageSchema.parse(source))) throw new Error("The new database does not read back the same board.");
        this.step("migrate:checked");
      } finally {
        db.close();
      }
      await syncFile(tmp);
      this.step("migrate:before-rename");
      // The commit point: before it board.json is the board, after it flowly.sqlite is.
      await rename(tmp, this.path(DB));
    } catch (error) {
      await rm(tmp, { force: true });
      this.releaseOwner();
      this.state = { kind: "json", reason: "migration-failed", detail: message(error) };
      logFailure("Flowly storage: moving the board to SQLite failed; staying on board.json:", error);
      return;
    }
    await syncDirectory(this.directory).catch((error) => logFailure("Flowly storage: syncing the data folder failed:", error));
    this.step("migrate:after-rename");
    // From here flowly.sqlite is the board; a failed marker is written again at the next start (§6 rule 5).
    await this.writeMarker().catch((error) => logFailure("Flowly storage: writing the board.json marker failed:", error));
    console.log(`Flowly storage: moved the board to SQLite in ${Date.now() - started} ms (${source.tasks.length} cards, ${source.events.length} events).`);
    await this.openDatabase(sqlite);
  }
  /** Copies board.json and its .bak into migrations/<time>/ with their sha256, read back before anything else changes. */
  private async snapshot(at: Date) {
    await mkdir(this.path("migrations"), { recursive: true, mode: 0o700 });
    let folder = join(this.path("migrations"), stamp(at));
    for (let n = 1; await exists(folder); n++) folder = join(this.path("migrations"), `${stamp(at)}-${n}`);
    await mkdir(folder, { mode: 0o700 });
    const files: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ["board.json", "board.json.bak"]) {
      let bytes: Buffer;
      try {
        bytes = await readFile(this.path(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await copyFile(this.path(name), join(folder, name));
      await chmod(join(folder, name), 0o600);
      await syncFile(join(folder, name));
      if (sha256(await readFile(join(folder, name))) !== sha256(bytes)) throw new Error(`The snapshot of ${name} does not match the original.`);
      files[name] = { sha256: sha256(bytes), bytes: bytes.length };
    }
    await writeFileDurable(join(folder, "manifest.json"), `${JSON.stringify({ createdAt: at.toISOString(), files }, null, 2)}\n`, "wx");
    await syncDirectory(folder);
  }

  // ---- Backups (§7) ------------------------------------------------------------------------

  async backups() {
    const folder = this.path("backups");
    const names = (await readdir(folder).catch(() => [] as string[])).filter((n) => backupName.test(n));
    const list = await Promise.all(
      names.map(async (name) => {
        const [, day, time, n] = backupName.exec(name)!;
        const when = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}Z`);
        return { name, at: when.toISOString(), time: when.getTime(), n: Number(n ?? 0), bytes: (await stat(join(folder, name))).size };
      }),
    );
    // Newest first; within one second the later file has the higher suffix.
    return list.sort((a, b) => b.time - a.time || b.n - a.n);
  }
  /** Backs up the open database now; returns the file name. */
  async backup() {
    const state = this.state;
    if (state.kind !== "sqlite") throw new StoreInvalidError("Backups need the SQLite storage.", "STORAGE_UNSUPPORTED");
    const folder = this.path("backups");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const base = `flowly-${stamp(this.now())}`;
    let name = `${base}.sqlite`;
    for (let n = 1; await exists(join(folder, name)); n++) name = `${base}-${n}.sqlite`;
    const tmp = join(folder, `${name}.tmp`);
    await rm(tmp, { force: true });
    try {
      state.board.db.prepare("VACUUM INTO ?").run(tmp);
      await chmod(tmp, 0o600);
      const copy = new this.sqlite!.DatabaseSync(tmp);
      try {
        check(copy, "quick_check");
        readBoard(copy);
      } finally {
        copy.close();
      }
      await syncFile(tmp);
      await rename(tmp, join(folder, name));
      await syncDirectory(folder);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    this.lastBackup = this.now().getTime();
    for (const old of (await this.backups()).slice(KEEP_BACKUPS)) await rm(join(folder, old.name), { force: true });
    return name;
  }
  private async backupQuietly() {
    try {
      await this.backup();
    } catch (error) {
      logFailure("Flowly storage: daily backup failed:", error);
    }
  }
  /** After each committed write: one automatic backup a day. */
  async afterCommit() {
    if (this.state.kind === "sqlite" && this.now().getTime() - this.lastBackup >= DAY) await this.backupQuietly();
  }

  /** Replaces the board with a backup; the current database is kept beside it (§7). */
  async restore(name: string) {
    if (!backupName.test(name)) throw new Error("Unknown backup.");
    if (this.state.kind === "json" || (this.state.kind === "error" && (this.state.reason === "busy" || this.state.reason === "diverged")))
      throw new Error("A backup can be restored only while the board uses SQLite, or when flowly.sqlite is missing or unreadable.");
    const source = join(this.path("backups"), name);
    if (!(await exists(source))) throw new Error("That backup no longer exists.");
    const sqlite = this.sqlite ?? (this.sqlite = await (this.options.sqlite ?? loadSqlite)());
    if (!sqlite) throw new StoreInvalidError("This Paseo cannot open SQLite backups.", "STORAGE_UNSUPPORTED");
    if (!(await this.acquireOwner(sqlite))) throw new StoreInvalidError("Another Flowly process is still using this data.", "STORAGE_BUSY", true);
    const candidate = new sqlite.DatabaseSync(source, { readOnly: true });
    let restoredMax: number;
    try {
      check(candidate, "quick_check");
      restoredMax = maxRevision(readBoard(candidate).board);
    } finally {
      candidate.close();
    }
    const live = this.state.kind === "sqlite" ? this.state.board.current() : null;
    const offset = 1 + Math.max(live ? maxRevision(live) : 0, restoredMax);
    const tmp = this.path(TMP);
    await copyFile(source, tmp);
    try {
      const db = new sqlite.DatabaseSync(tmp);
      try {
        configure(db, "DELETE");
        const { board, index } = readBoard(db);
        bumpRevisions(board, offset);
        const bumped = storageSchema.parse(board);
        transaction(db, () => writeBoard(db, bumped, index));
        check(db, "integrity_check");
      } finally {
        db.close();
      }
      await syncFile(tmp);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    this.closeDatabase();
    // The current database is copied aside, then replaced in one rename: a crash leaves the old or the new one, never none.
    let aside: string | null = null;
    try {
      aside = await this.keepAside();
      this.step("restore:aside");
      await rename(tmp, this.path(DB));
      await syncDirectory(this.directory);
    } catch (error) {
      await rm(tmp, { force: true });
      await this.start();
      throw error;
    }
    if ((await this.boardFile()).kind === "none") await this.writeMarker();
    this.step("restore:replaced");
    await this.openDatabase(sqlite);
    const opened = this.state as State;
    if (opened.kind === "error")
      throw new StoreInvalidError(
        `The backup ${name} is now flowly.sqlite but cannot be opened: ${opened.detail} The previous database is ${aside ?? "(none)"}; restore another backup.`,
        errorCodes[opened.reason],
        false,
      );
    console.log(`Flowly storage: restored ${name}; the previous database is ${aside ?? "(none)"}.`);
    return { aside };
  }
  /** Copies the closed flowly.sqlite to flowly.sqlite.before-restore-<time>; its emptied side files move with it. */
  private async keepAside() {
    if (!(await exists(this.path(DB)))) return null;
    const name = await this.freeName("before-restore");
    await copyFile(this.path(DB), this.path(name), constants.COPYFILE_EXCL);
    await syncFile(this.path(name));
    for (const suffix of SIDE) if (await exists(this.path(DB + suffix))) await rename(this.path(DB + suffix), this.path(name + suffix));
    await syncDirectory(this.directory);
    return name;
  }
  /** flowly.sqlite.<label>-<time>, with a suffix when that second is taken: a kept database is never overwritten. */
  private async freeName(label: "before-restore" | "retired") {
    const base = `${DB}.${label}-${stamp(this.now())}`;
    let name = base;
    for (let n = 1; (await exists(this.path(name))) || (await exists(this.path(`${name}-wal`))); n++) name = `${base}-${n}`;
    return name;
  }
  /** Renames flowly.sqlite (and its side files) to flowly.sqlite.<label>-<time>; null when there is none. */
  private async retireDatabase(label: "retired") {
    if (!(await exists(this.path(DB)))) return null;
    const name = await this.freeName(label);
    for (const suffix of SIDE) if (await exists(this.path(DB + suffix))) await rename(this.path(DB + suffix), this.path(name + suffix));
    await rename(this.path(DB), this.path(name));
    await syncDirectory(this.directory);
    return name;
  }

  // ---- Back to JSON (§8) -------------------------------------------------------------------

  /** Writes the board as a v5 board.json that older versions read, and switches this process to it. */
  async exportJson() {
    const state = this.state;
    if (state.kind !== "sqlite") throw new StoreInvalidError("Only the SQLite storage can be exported.", "STORAGE_UNSUPPORTED");
    const board = state.board.current();
    bumpRevisions(board, 1 + maxRevision(board));
    const parsed = storageSchema.parse(board);
    assertBoardInvariants(parsed);
    // The mode file first: a stop before board.json is written finds the marker and stays on SQLite;
    // once board.json holds the board, the next start finishes the export (§6 rule 1).
    await writeFileAtomic(this.path(MODE), `${JSON.stringify({ backend: "json", at: this.now().toISOString() })}\n`);
    this.step("export:mode");
    try {
      await writeFileAtomic(this.json.path, JSON.stringify(parsed, null, 2));
    } catch (error) {
      await rm(this.path(MODE), { force: true });
      throw error;
    }
    this.step("export:json");
    this.closeDatabase();
    // board.json is the board now; a database that cannot be renamed aside is left unused.
    const retired = await this.retireDatabase("retired").catch((error) => {
      logFailure("Flowly storage: renaming the exported database aside failed; it stays unused:", error);
      return null;
    });
    this.releaseOwner();
    this.state = { kind: "json", reason: "exported" };
    console.log(`Flowly storage: exported the board to board.json; the database is now ${retired}.`);
    return { retired };
  }
  /** Leaves JSON after an export: the board moves to SQLite again like the first time. */
  async useSqlite() {
    if (this.state.kind !== "json") throw new Error("The board already uses SQLite.");
    // A database left behind by an export that could not rename it would block the move as diverged.
    if (await exists(this.path(DB))) await this.retireDatabase("retired");
    await rm(this.path(MODE), { force: true });
    await this.start();
    // start() replaced the state; the narrowing from the check above no longer holds.
    const state = this.state as State;
    if (state.kind === "json") throw new Error(state.detail ?? "The board could not move to SQLite.");
    if (state.kind === "error") throw new StoreInvalidError(state.detail, errorCodes[state.reason], state.reason === "busy");
  }

  async status(): Promise<StorageStatus> {
    const backups = (await this.backups()).map(({ name, at, bytes }) => ({ name, at, bytes }));
    const base = { directory: this.directory, backups, ...(this.sqlite ? { sqliteVersion: this.sqliteVersion(this.sqlite) } : {}) };
    const state = this.state;
    if (state.kind === "sqlite")
      return { ...base, backend: "sqlite", databaseBytes: (await stat(this.path(DB)).catch(() => null))?.size, ...(state.migratedAt ? { migratedAt: state.migratedAt } : {}) };
    if (state.kind === "json") return { ...base, backend: "json", reason: state.reason as StorageReason, ...(state.detail ? { detail: state.detail.slice(0, 2000) } : {}) };
    if (state.kind === "starting") return { ...base, backend: "error", reason: "busy", detail: "Starting." };
    return { ...base, backend: "error", reason: state.reason, detail: state.detail.slice(0, 2000) };
  }
  close() {
    this.closeDatabase();
    this.releaseOwner();
  }
  /** Tests: drop the handles the way a killed process would, without checkpoint or cleanup. */
  abandon() {
    if (this.state.kind === "sqlite") this.state.board.db.close();
    this.owner?.close();
    this.owner = null;
    this.state = { kind: "starting" };
  }
}

/** Reads a database file without the owner lock: tests and the verification script. */
export function readDatabaseFile(sqlite: Sqlite, path: string) {
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    return readBoard(db).board;
  } finally {
    db.close();
  }
}
