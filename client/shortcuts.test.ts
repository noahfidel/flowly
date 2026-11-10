import { describe, expect, test } from "vitest";
import type { Task } from "../shared/model";
import {
  intentMaxAgeMs,
  intentParams,
  navigateGrid,
  parseBoardIntent,
  resolveShortcut,
  taskGrid,
  adjacentStatus,
} from "./shortcuts";

describe("board shortcut keys", () => {
  test("maps letters case-insensitively and punctuation keys", () => {
    expect(resolveShortcut({ key: "n" }, true)).toBe("new-task");
    expect(resolveShortcut({ key: "N" }, true)).toBe("new-task");
    expect(resolveShortcut({ key: "q" }, true)).toBe("quick-task");
    expect(resolveShortcut({ key: "b" }, true)).toBe("ideas");
    expect(resolveShortcut({ key: "i" }, true)).toBe("insights");
    expect(resolveShortcut({ key: "g" }, true)).toBe("guardrails");
    expect(resolveShortcut({ key: "m" }, true)).toBe("memory");
    expect(resolveShortcut({ key: "p" }, true)).toBe("projects");
    expect(resolveShortcut({ key: "/" }, true)).toBe("filters");
    expect(resolveShortcut({ key: "f" }, true)).toBe("filters");
    expect(resolveShortcut({ key: "a" }, true)).toBe("attention");
    expect(resolveShortcut({ key: "?", shiftKey: true }, true)).toBe("shortcuts");
    expect(resolveShortcut({ key: "Escape" }, true)).toBe("escape");
    expect(resolveShortcut({ key: "j" }, true)).toBe("next");
    expect(resolveShortcut({ key: "k" }, true)).toBe("previous");
    expect(resolveShortcut({ key: "h" }, true)).toBe("left");
    expect(resolveShortcut({ key: "l" }, true)).toBe("right");
  });
  test("leaves host chords, shifted letters and unknown keys alone", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(resolveShortcut({ key: "n", [mod]: true }, true)).toBeNull();
      expect(resolveShortcut({ key: "Escape", [mod]: true }, true)).toBeNull();
    }
    expect(resolveShortcut({ key: "N", shiftKey: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "H", shiftKey: true }, true)).toBe("move-left");
    expect(resolveShortcut({ key: "L", shiftKey: true }, true)).toBe("move-right");
    expect(resolveShortcut({ key: "e" }, true)).toBe("edit");
    expect(resolveShortcut({ key: "x" }, true)).toBeNull();
    expect(resolveShortcut({ key: "ArrowDown" }, true)).toBeNull();
    expect(resolveShortcut({ key: "Enter" }, true)).toBeNull();
  });
  test("is inert while blocked, repeating or composing", () => {
    expect(resolveShortcut({ key: "n" }, false)).toBeNull();
    expect(resolveShortcut({ key: "Escape" }, false)).toBeNull();
    expect(resolveShortcut({ key: "n", repeat: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "n", isComposing: true }, true)).toBeNull();
  });
});

const task = (id: string, status: Task["status"], position: number) =>
  ({ id, status, position, createdAt: "2026-10-01T00:00:00.000Z" }) as Task;

describe("card grid navigation", () => {
  const grid = taskGrid(
    ["todo", "development", "blocked", "in_review"],
    [
      task("t2", "todo", 2),
      task("t1", "todo", 1),
      task("t3", "todo", 3),
      task("r1", "in_review", 1),
      task("p1", "development", 1),
      task("p2", "development", 2),
      task("x", "done", 1),
    ],
  );
  test("orders columns by status and cards by position, dropping hidden statuses", () => {
    expect(grid).toEqual([["t1", "t2", "t3"], ["p1", "p2"], [], ["r1"]]);
  });
  test("starts at the first card when nothing visible is selected", () => {
    expect(navigateGrid(grid, "", "next")).toBe("t1");
    expect(navigateGrid(grid, "gone", "right")).toBe("t1");
    expect(navigateGrid([[], []], "", "next")).toBeNull();
  });
  test("moves within a column and clamps at its ends", () => {
    expect(navigateGrid(grid, "t1", "next")).toBe("t2");
    expect(navigateGrid(grid, "t3", "next")).toBe("t3");
    expect(navigateGrid(grid, "t2", "previous")).toBe("t1");
    expect(navigateGrid(grid, "t1", "previous")).toBe("t1");
  });
  test("crosses to the nearest non-empty column at the same row or its last card", () => {
    expect(navigateGrid(grid, "t2", "right")).toBe("p2");
    expect(navigateGrid(grid, "t3", "right")).toBe("p2");
    expect(navigateGrid(grid, "p1", "right")).toBe("r1");
    expect(navigateGrid(grid, "r1", "left")).toBe("p1");
    expect(navigateGrid(grid, "t1", "left")).toBe("t1");
    expect(navigateGrid(grid, "r1", "right")).toBe("r1");
  });
});

describe("Command Center board intents", () => {
  const now = 1_800_000_000_000;
  test("round-trips fresh intents with a once-only key", () => {
    const params = intentParams("new-task", now);
    expect(parseBoardIntent(params, now + 500)).toEqual({
      intent: "new-task",
      key: `new-task|${now}`,
    });
    expect(parseBoardIntent(intentParams("quick-task", now), now)?.intent).toBe("quick-task");
    expect(parseBoardIntent(intentParams("attention", now), now)?.key).not.toBe(
      parseBoardIntent(intentParams("attention", now + 1), now)?.key,
    );
  });
  test("ignores stale, malformed, unknown and absent intents", () => {
    expect(parseBoardIntent(undefined, now)).toBeNull();
    expect(parseBoardIntent({}, now)).toBeNull();
    expect(parseBoardIntent(intentParams("filters", now), now + intentMaxAgeMs + 1)).toBeNull();
    expect(parseBoardIntent({ intent: "filters", at: "soon" }, now)).toBeNull();
    expect(parseBoardIntent({ intent: "escape", at: String(now) }, now)).toBeNull();
    expect(parseBoardIntent({ intent: "delete-all", at: String(now) }, now)).toBeNull();
    expect(parseBoardIntent({ intent: "projects" }, now)).toBeNull();
  });
  test("does not collide with session-link params", () => {
    expect(
      parseBoardIntent({ taskId: "t", sessionId: "s", workspaceId: "w", requestId: "r" }, now),
    ).toBeNull();
  });
});

test("navigation follows the board sort; ⇧H/⇧L target the adjacent shown column", () => {
  const t = (id: string, status: Task["status"], position: number, priority: Task["priority"]) =>
    ({ id, status, position, priority, createdAt: "2026-10-01T00:00:00Z" }) as Task;
  const tasks = [t("a", "todo", 0, "low"), t("b", "todo", 1, "urgent")];
  expect(taskGrid(["todo"], tasks)).toEqual([["a", "b"]]);
  const byPriority = (c: Task[]) => [...c].sort((x, y) => (x.priority === "urgent" ? -1 : 0) - (y.priority === "urgent" ? -1 : 0));
  expect(taskGrid(["todo"], tasks, byPriority)).toEqual([["b", "a"]]);
  expect(adjacentStatus(["backlog", "todo", "development"], "todo", "move-right")).toBe("development");
  expect(adjacentStatus(["backlog", "todo", "development"], "backlog", "move-left")).toBeNull();
  expect(adjacentStatus(["todo"], "done", "move-left")).toBeNull();
});
