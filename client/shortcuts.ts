import { useEffect } from "react";
import type { PluginScreenParams } from "@getpaseo/plugin/client";
import type { Status, Task } from "../shared/model";
import { t, msg } from "../shared/i18n";

/** Board-scoped desktop shortcuts. See docs/SHORTCUTS-SPEC.md. */
export type ShortcutAction =
  | "new-task"
  | "quick-task"
  | "projects"
  | "filters"
  | "attention"
  | "shortcuts"
  | "welcome"
  | "escape"
  | "next"
  | "previous"
  | "left"
  | "right"
  | "move-left"
  | "move-right"
  | "edit"
  | "insights"
  | "ideas"
  | "guardrails"
  | "memory"
  | "search"
  | "dispatcher";

export type BoardIntent = Extract<
  ShortcutAction,
  "new-task" | "quick-task" | "projects" | "filters" | "attention" | "shortcuts" | "welcome" | "search"
>;

export const shortcutHelp: readonly { keys: string[]; title: string }[] = [
  { keys: ["N"], title: msg("New task") },
  { keys: ["Q"], title: msg("Quick task") },
  { keys: ["P"], title: msg("Switch project") },
  { keys: ["S"], title: msg("Search") },
  { keys: ["/", "F"], title: msg("Search and filter") },
  { keys: ["A"], title: msg("Needs attention") },
  { keys: ["I"], title: msg("Project insights") },
  { keys: ["B"], title: msg("Project ideas") },
  { keys: ["G"], title: msg("Guardrails") },
  { keys: ["M"], title: msg("Memory") },
  { keys: ["D"], title: msg("Open the dispatcher and focus its message box") },
  { keys: ["J", "K"], title: msg("Next / previous card in column") },
  { keys: ["H", "L"], title: msg("Card in left / right column") },
  { keys: ["⇧H", "⇧L"], title: msg("Move the open card to the left / right column") },
  { keys: ["E"], title: msg("Edit the open card") },
  { keys: ["←", "→"], title: msg("Previous / next agent question") },
  { keys: ["Esc"], title: msg("Close the dispatcher (when you last used it), back from session, then close sidebar, then leave a project page") },
  { keys: ["?"], title: msg("Show keyboard shortcuts") },
];

const letters: Record<string, ShortcutAction> = {
  n: "new-task",
  q: "quick-task",
  p: "projects",
  f: "filters",
  a: "attention",
  j: "next",
  k: "previous",
  h: "left",
  l: "right",
  e: "edit",
  i: "insights",
  b: "ideas",
  g: "guardrails",
  m: "memory",
  s: "search",
  d: "dispatcher",
};

export interface ShortcutKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function resolveShortcut(
  event: ShortcutKey,
  enabled: boolean,
): ShortcutAction | null {
  if (!enabled || event.repeat || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key;
  if (key === "Escape") return "escape";
  if (key === "/") return "filters";
  if (key === "?") return "shortcuts";
  if (key.length !== 1) return null;
  if (event.shiftKey) {
    const lower = key.toLowerCase();
    return lower === "h" ? "move-left" : lower === "l" ? "move-right" : null;
  }
  return letters[key.toLowerCase()] ?? null;
}

/** Visible desktop columns in display order, each sorted like DesktopColumns. */
export function taskGrid(
  statuses: readonly Status[],
  tasks: readonly Task[],
  sortColumn: (column: Task[]) => Task[] = (column) =>
    [...column].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
) {
  return statuses.map((status) => sortColumn(tasks.filter((t) => t.status === status)).map((t) => t.id));
}

/** The status a card moves to with ⇧H / ⇧L: the adjacent shown column, if any. */
export function adjacentStatus(statuses: readonly Status[], current: Status, direction: "move-left" | "move-right") {
  const index = statuses.indexOf(current);
  if (index < 0) return null;
  return statuses[index + (direction === "move-right" ? 1 : -1)] ?? null;
}

export function navigateGrid(
  grid: readonly (readonly string[])[],
  current: string,
  action: "next" | "previous" | "left" | "right",
): string | null {
  const filled = grid.filter((column) => column.length);
  if (!filled.length) return null;
  const col = filled.findIndex((column) => column.includes(current));
  if (col < 0) return filled[0][0];
  const row = filled[col].indexOf(current);
  if (action === "next" || action === "previous") {
    const next = row + (action === "next" ? 1 : -1);
    return filled[col][Math.max(0, Math.min(filled[col].length - 1, next))];
  }
  const target = filled[col + (action === "right" ? 1 : -1)];
  if (!target) return current;
  return target[Math.min(row, target.length - 1)];
}

const intents: readonly BoardIntent[] = [
  "new-task",
  "quick-task",
  "projects",
  "filters",
  "attention",
  "shortcuts",
  "welcome",
  "search",
];
export const intentMaxAgeMs = 5_000;

export function intentParams(intent: BoardIntent, now = Date.now()) {
  return { intent, at: String(now) };
}

/** A fresh Command Center intent, or null for absent, stale or unknown params. */
export function parseBoardIntent(
  params: PluginScreenParams | undefined,
  now = Date.now(),
): { intent: BoardIntent; key: string } | null {
  const intent = params?.intent as BoardIntent | undefined;
  const at = params?.at;
  if (!intent || !intents.includes(intent) || !at || !/^\d{1,16}$/.test(at))
    return null;
  const age = now - Number(at);
  if (age < -intentMaxAgeMs || age > intentMaxAgeMs) return null;
  return { intent, key: `${intent}|${at}` };
}

/**
 * Plugin-owned text inputs and modals block board shortcuts while focused/open.
 * Counted here instead of reading DOM focus, which the plugin may not touch.
 */
const blockers = new Set<object>();
export function shortcutsBlocked() {
  return blockers.size > 0;
}
export function useShortcutBlock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const token = {};
    blockers.add(token);
    return () => {
      blockers.delete(token);
    };
  }, [active]);
}
