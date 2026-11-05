import { msg } from "../shared/i18n";
import type { BoardIntent } from "./shortcuts";

/**
 * Flowly's Command Center items, in registration order (QUICK-TASK-SPEC §7). The host ranks a plugin's items by
 * the order they were added, so View board comes first. Every other board intent (attention, new task, projects,
 * search, filters, shortcuts, welcome) stays reachable on the board and as a screen param, with no item here.
 * Titles are English identities (`msg`); translate them with `t` when registering.
 */
export type CommandItem = { id: string; title: string; icon: string; keywords: string[]; intent?: BoardIntent };

export const commandItems: readonly CommandItem[] = [
  { id: "open-board", title: msg("Flowly: View board"), icon: "PanelsTopLeft", keywords: ["kanban", "board", "open"] },
  { id: "board-quick-task", intent: "quick-task", title: msg("Flowly: Quick task"), icon: "Zap", keywords: ["kanban", "card", "create", "task", "agent", "quick"] },
];
