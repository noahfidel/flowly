import { describe, expect, test } from "vitest";
import type { Task } from "../shared/model";
import {
  intentMaxAgeMs,
  intentParams,
  navigateGrid,
  parseBoardIntent,
  resolveShortcut,
  shortcutHelp,
  taskGrid,
  adjacentStatus,
  historyKeyHint,
  isApplePlatform,
  cardShortcutApplies,
} from "./shortcuts";
import { stepQuestion } from "../shared/permission-question";

describe("board shortcut keys", () => {
  test("maps letters case-insensitively and punctuation keys", () => {
    expect(resolveShortcut({ key: "t" }, true)).toBe("new-task");
    expect(resolveShortcut({ key: "T" }, true)).toBe("new-task");
    expect(resolveShortcut({ key: "n" }, true)).toBe("attention");
    expect(resolveShortcut({ key: "N" }, true)).toBe("attention");
    expect(resolveShortcut({ key: "a" }, true)).toBeNull();
    expect(resolveShortcut({ key: "q" }, true)).toBe("quick-task");
    expect(resolveShortcut({ key: "b" }, true)).toBe("ideas");
    expect(resolveShortcut({ key: "i" }, true)).toBe("insights");
    expect(resolveShortcut({ key: "g" }, true)).toBe("guardrails");
    expect(resolveShortcut({ key: "m" }, true)).toBe("memory");
    expect(resolveShortcut({ key: "p" }, true)).toBe("projects");
    expect(resolveShortcut({ key: "/" }, true)).toBe("filters");
    expect(resolveShortcut({ key: "f" }, true)).toBe("filters");
    expect(resolveShortcut({ key: "u" }, true)).toBe("updated");
    expect(resolveShortcut({ key: "U" }, true)).toBe("updated");
    expect(resolveShortcut({ key: "u", metaKey: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "u" }, false)).toBeNull();
    expect(shortcutHelp.find((row) => row.keys.includes("N"))?.title).toBe("Step through what needs you");
    expect(shortcutHelp.find((row) => row.keys.includes("U"))?.title).toBe("Step through unread cards");
    expect(resolveShortcut({ key: "?", shiftKey: true }, true)).toBe("shortcuts");
    expect(resolveShortcut({ key: "Escape" }, true)).toBe("escape");
    expect(resolveShortcut({ key: "j" }, true)).toBe("next");
    expect(resolveShortcut({ key: "k" }, true)).toBe("previous");
    expect(resolveShortcut({ key: "h" }, true)).toBe("left");
    expect(resolveShortcut({ key: "l" }, true)).toBe("right");
  });
  test("D is the dispatcher; it is inert while a text field blocks shortcuts, with chords, or shifted", () => {
    expect(resolveShortcut({ key: "d" }, true)).toBe("dispatcher");
    expect(resolveShortcut({ key: "D" }, true)).toBe("dispatcher");
    expect(resolveShortcut({ key: "d" }, false)).toBeNull();
    expect(resolveShortcut({ key: "d", metaKey: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "D", shiftKey: true }, true)).toBeNull();
    expect(shortcutHelp.some((row) => row.keys.includes("D") && row.title === "Open the dispatcher and focus its message box")).toBe(true);
  });
  test("O opens the open card's session and R its newest pull request; G stays Guardrails", () => {
    expect(resolveShortcut({ key: "o" }, true)).toBe("open-session");
    expect(resolveShortcut({ key: "O" }, true)).toBe("open-session");
    expect(resolveShortcut({ key: "r" }, true)).toBe("open-pr");
    expect(resolveShortcut({ key: "R" }, true)).toBe("open-pr");
    expect(resolveShortcut({ key: "g" }, true)).toBe("guardrails");
    for (const key of ["o", "r"]) {
      expect(resolveShortcut({ key }, false)).toBeNull();
      expect(resolveShortcut({ key, metaKey: true }, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true }, true)).toBeNull();
      expect(resolveShortcut({ key, altKey: true }, true)).toBeNull();
      expect(resolveShortcut({ key: key.toUpperCase(), shiftKey: true }, true)).toBeNull();
    }
    expect(shortcutHelp.some((row) => row.keys.includes("O") && row.title === "Open the open card's active session")).toBe(true);
    expect(shortcutHelp.some((row) => row.keys.includes("R") && row.title === "Open the open card's newest pull request")).toBe(true);
  });
  test("O and R apply only on desktop with a card open", () => {
    expect(cardShortcutApplies(undefined, false)).toBe(false);
    expect(cardShortcutApplies(null, false)).toBe(false);
    expect(cardShortcutApplies("", false)).toBe(false);
    expect(cardShortcutApplies("t1", true)).toBe(false);
    expect(cardShortcutApplies("t1", false)).toBe(true);
  });
  test("the help lists the double tap of Ctrl as its own, switchable row (SHORTCUTS-SPEC §5)", () => {
    const rows = shortcutHelp.filter((row) => row.doubleTap);
    expect(rows).toEqual([{ keys: ["Ctrl", "Ctrl"], title: "Open Flowly from anywhere in Paseo (double-tap Ctrl)", doubleTap: true }]);
  });
  test("leaves host chords, shifted letters and unknown keys alone", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(resolveShortcut({ key: "n", [mod]: true }, true)).toBeNull();
      expect(resolveShortcut({ key: "Escape", [mod]: true }, true)).toBeNull();
    }
    expect(resolveShortcut({ key: "N", shiftKey: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "T", shiftKey: true }, true)).toBeNull();
    expect(resolveShortcut({ key: "H", shiftKey: true }, true)).toBe("move-left");
    expect(resolveShortcut({ key: "L", shiftKey: true }, true)).toBe("move-right");
    expect(resolveShortcut({ key: "e" }, true)).toBe("edit");
    expect(resolveShortcut({ key: "x" }, true)).toBeNull();
    expect(resolveShortcut({ key: "ArrowDown" }, true)).toBeNull();
    expect(resolveShortcut({ key: "Enter" }, true)).toBeNull();
  });
  test("macOS: ⌃[ / ⌃] walk back and forward; ⌘[ / ⌘] and other chords stay with Paseo (ruling 2026-11-18)", () => {
    expect(resolveShortcut({ key: "[", ctrlKey: true }, true, true)).toBe("history-back");
    expect(resolveShortcut({ key: "]", ctrlKey: true }, true, true)).toBe("history-forward");
    // Platform defaults to Apple, like isApplePlatform(undefined).
    expect(resolveShortcut({ key: "[", ctrlKey: true }, true)).toBe("history-back");
    for (const key of ["[", "]"]) {
      expect(resolveShortcut({ key, metaKey: true }, true, true)).toBeNull();
      expect(resolveShortcut({ key }, true, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true, shiftKey: true }, true, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true, altKey: true }, true, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true, metaKey: true }, true, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true, repeat: true }, true, true)).toBeNull();
      expect(resolveShortcut({ key, ctrlKey: true }, false, true)).toBeNull();
    }
    // ⌥←/→ no longer navigate on macOS.
    expect(resolveShortcut({ key: "ArrowLeft", altKey: true }, true, true)).toBeNull();
    expect(resolveShortcut({ key: "ArrowRight", altKey: true }, true, true)).toBeNull();
    expect(shortcutHelp.some((row) => row.keys.join(" ") === "⌃[ ⌃]" && row.title === "Back / forward (Alt+← / Alt+→ on Windows and Linux)")).toBe(true);
    expect(shortcutHelp.some((row) => row.keys.some((k) => k.includes("⌥")))).toBe(false);
  });
  test("Windows / Linux: Alt+← / Alt+→ walk back and forward; Ctrl+[ / Ctrl+] stay with Paseo (its previous / next workspace)", () => {
    expect(resolveShortcut({ key: "ArrowLeft", altKey: true }, true, false)).toBe("history-back");
    expect(resolveShortcut({ key: "ArrowRight", altKey: true }, true, false)).toBe("history-forward");
    for (const key of ["[", "]"]) {
      expect(resolveShortcut({ key, ctrlKey: true }, true, false)).toBeNull();
      expect(resolveShortcut({ key, metaKey: true }, true, false)).toBeNull();
    }
    expect(resolveShortcut({ key: "ArrowLeft", metaKey: true, altKey: true }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft" }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft", ctrlKey: true }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft", ctrlKey: true, altKey: true }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowRight", shiftKey: true, altKey: true }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft", altKey: true, repeat: true }, true, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowLeft", altKey: true }, false, false)).toBeNull();
    expect(resolveShortcut({ key: "ArrowUp", altKey: true }, true, false)).toBeNull();
  });
  test("the Back / Forward button hints name ⌃[ / ⌃] on Apple systems and Alt+arrows elsewhere", () => {
    expect(historyKeyHint("back", true)).toBe("⌃[");
    expect(historyKeyHint("forward", true)).toBe("⌃]");
    expect(historyKeyHint("back", false)).toBe("Alt+←");
    expect(historyKeyHint("forward", false)).toBe("Alt+→");
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ platform: "iPad" })).toBe(true);
    expect(isApplePlatform({ platform: "Win32" })).toBe(false);
    expect(isApplePlatform({ platform: "Linux x86_64" })).toBe(false);
    expect(isApplePlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(true);
    expect(isApplePlatform(undefined)).toBe(true);
  });
  test("no shortcut collides with the agent-question arrows", () => {
    // A row may repeat its own key (Ctrl, Ctrl is one double tap); no two rows share one.
    const keys = shortcutHelp.flatMap((row) => [...new Set(row.keys)]);
    expect(new Set(keys).size).toBe(keys.length);
    const titles = shortcutHelp.map((row) => row.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(stepQuestion({ key, altKey: true }, 1, 3)).toBeNull();
      expect(stepQuestion({ key, metaKey: true, altKey: true }, 1, 3)).toBeNull();
    }
    expect(stepQuestion({ key: "ArrowLeft" }, 1, 3)).toBe(0);
    expect(stepQuestion({ key: "ArrowRight" }, 1, 3)).toBe(2);
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
