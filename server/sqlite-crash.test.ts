import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { JsonBoardFile } from "./board-file";
import { emptyBoard, type Board } from "../shared/model";

// Real process kills at the points where a crash matters most (SQLITE-STORAGE-SPEC §11 item 9).
const crashAt = process.env.FLOWLY_CRASH_AT;
const crashDir = process.env.FLOWLY_CRASH_DIR;

function fixture(): Board {
  const b = emptyBoard(),
    at = "2026-10-20T10:00:00.000Z";
  b.projects.push({ id: "p1", paseoProjectId: "native1", title: "Fixture", description: "", primaryPath: "/repo1", repos: ["/repo1"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
  b.tasks.push({ id: "t1", projectId: "p1", workspaceId: "w1", sourcePath: "/repo1", repoPaths: [], title: "Card", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "op1", createdAt: at, updatedAt: at, archivedAt: null });
  for (let i = 0; i < 200; i++) b.events.push({ id: `e${i}`, taskId: "t1", actor: "human", action: "edited", note: "x".repeat(200), at });
  return b;
}

describe.runIf(crashAt && crashDir)("crash child", () => {
  test("dies at the named point", async () => {
    const store = new BoardStore(crashDir!, {
      backend: "sqlite",
      storage: {
        checkVersion: false,
        step: (name) => {
          if (name === crashAt) process.kill(process.pid, "SIGKILL");
        },
      },
    });
    await store.read();
    if (crashAt === "save:written") await store.editTask({ id: "t1", revision: 1, title: "Never committed", actor: "human" });
    throw new Error(`The child did not reach ${crashAt}.`);
  });
});

describe.skipIf(!!crashAt)("a killed Flowly process", () => {
  async function killedAt(point: string) {
    const dir = await mkdtemp(join(tmpdir(), "flowly-crash-test-"));
    await writeFile(join(dir, "board.json"), JSON.stringify(fixture(), null, 2));
    const child = spawnSync(process.execPath, [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "server/sqlite-crash.test.ts", "--exclude", ".claude/**"], {
      cwd: process.cwd(),
      env: { ...process.env, FLOWLY_CRASH_AT: point, FLOWLY_CRASH_DIR: dir },
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${child.stdout}${child.stderr}`;
    // The worker running the child test was killed, not finished.
    expect(output).not.toContain("did not reach");
    expect(output).toContain("Worker exited unexpectedly");
    return dir;
  }
  const exists = (path: string) => stat(path).then(() => true, () => false);
  const boardVersion = async (dir: string) => JSON.parse(await readFile(join(dir, "board.json"), "utf8")).version;
  /** What the disk holds right after the kill, before anything restarts. */
  const leftBehind: Record<string, (dir: string) => Promise<void>> = {
    "migrate:before-rename": async (dir) => {
      expect(await exists(join(dir, "flowly.sqlite.tmp"))).toBe(true);
      expect(await exists(join(dir, "flowly.sqlite"))).toBe(false);
      expect(await boardVersion(dir)).toBe(5);
    },
    "migrate:after-rename": async (dir) => {
      expect(await exists(join(dir, "flowly.sqlite"))).toBe(true);
      expect(await boardVersion(dir)).toBe(5);
    },
    "save:written": async (dir) => {
      expect(await exists(join(dir, "flowly.sqlite"))).toBe(true);
      expect(await boardVersion(dir)).toBe(0);
    },
  };
  const expected = async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowly-crash-expected-"));
    try {
      await writeFile(join(dir, "board.json"), JSON.stringify(fixture()));
      return JSON.stringify(await new JsonBoardFile(dir).load());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test.each(["migrate:before-rename", "migrate:after-rename"])("killed at %s, the next start has the whole board in SQLite", { timeout: 90_000 }, async (point) => {
    const dir = await killedAt(point);
    await leftBehind[point](dir);
    const store = new BoardStore(dir, { backend: "sqlite", storage: { checkVersion: false } });
    try {
      expect(JSON.stringify(await store.read())).toBe(await expected());
      expect((await store.storageStatus()).backend).toBe("sqlite");
      expect(JSON.parse(await readFile(join(dir, "board.json"), "utf8")).storage).toBe("sqlite");
      await expect(stat(join(dir, "flowly.sqlite.tmp"))).rejects.toThrow();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("killed inside a write transaction, the next start has the board from before that write", { timeout: 90_000 }, async () => {
    const dir = await killedAt("save:written");
    await leftBehind["save:written"](dir);
    const store = new BoardStore(dir, { backend: "sqlite", storage: { checkVersion: false } });
    try {
      const board = await store.read();
      expect(board.tasks[0].title).toBe("Card");
      expect(JSON.stringify(board)).toBe(await expected());
      await store.editTask({ id: "t1", revision: 1, title: "Committed", actor: "human" });
      expect((await store.read()).tasks[0].title).toBe("Committed");
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
