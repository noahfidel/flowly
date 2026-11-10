import { localizedLabels, msg, t } from "../shared/i18n";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { legacyStatus, priorityLabels, type HistoryStatus, type Status, type Task, type TaskType } from "../shared/model";
import type { CardWorkspace } from "../shared/card-display";
import { tint, useTheme } from "./ui";

type Colors = PluginTheme["colors"];

export { priorityLabels };

const statusGlyph: Record<Status, { icon: string; color(c: Colors): string }> = {
  backlog: { icon: "CircleDashed", color: (c) => c.foregroundMuted },
  todo: { icon: "Circle", color: (c) => c.foregroundMuted },
  design: { icon: "CircleEllipsis", color: (c) => c.foreground },
  development: { icon: "CircleDot", color: (c) => c.statusWarning },
  test: { icon: "CircleGauge", color: (c) => c.accent },
  in_review: { icon: "CircleDotDashed", color: (c) => c.accent },
  committed: { icon: "GitCommitHorizontal", color: (c) => c.statusSuccess },
  integrated: { icon: "GitMerge", color: (c) => c.statusSuccess },
  blocked: { icon: "CircleSlash", color: (c) => c.statusDanger },
  done: { icon: "CircleCheck", color: (c) => c.statusSuccess },
  cancelled: { icon: "CircleX", color: (c) => c.foregroundMuted },
};

export function StatusIcon({ status, size = 14 }: { status: HistoryStatus; size?: number }) {
  const { colors } = useTheme();
  // History written before board v4 can name the retired In progress.
  const glyph = statusGlyph[status === legacyStatus ? "development" : status];
  return <Icon name={glyph.icon} size={size} color={glyph.color(colors)} />;
}

type Priority = Task["priority"];
const priorityGlyph: Record<Priority, { icon: string; color(c: Colors): string } | null> = {
  urgent: { icon: "TriangleAlert", color: (c) => c.statusDanger },
  high: { icon: "ArrowUp", color: (c) => c.statusWarning },
  normal: null,
  low: { icon: "ArrowDown", color: (c) => c.foregroundMuted },
};

/** The emphasis colour of a priority that deserves attention (Urgent, High), else null. */
export function priorityAccent(colors: Colors, priority: Priority): string | null {
  return priority === "urgent" ? colors.statusDanger : priority === "high" ? colors.statusWarning : null;
}

/** Renders nothing for Normal priority: the default carries no signal. */
export function PriorityIcon({ priority, size = 14, always = false }: { priority: Priority; size?: number; always?: boolean }) {
  const { colors } = useTheme();
  const glyph = priorityGlyph[priority] || (always ? { icon: "Minus", color: (c: Colors) => c.foregroundMuted } : null);
  if (!glyph) return null;
  return <Icon name={glyph.icon} size={size} color={glyph.color(colors)} />;
}

const typeIcons: Record<TaskType, string> = {
  feature: "Puzzle",
  bugfix: "Bug",
  research: "FlaskConical",
  refactor: "Shapes",
  docs: "FileText",
  chore: "Wrench",
};

/** A task type's glyph; an untyped card gets a muted placeholder only when `always`. */
export function TypeIcon({ type, size = 14, always = false }: { type?: TaskType; size?: number; always?: boolean }) {
  const { colors } = useTheme();
  if (!type && !always) return null;
  return <Icon name={type ? typeIcons[type] : "Tag"} size={size} color={colors.foregroundMuted} />;
}

/** Where a card works (CARD-DISPLAY-SPEC §8). */
export const workspaceLabels: Record<CardWorkspace, string> = localizedLabels({
  worktree: msg("Worktree"),
  local: msg("Local"),
});

/** Accessibility text that names the workspace kind. */
export function workspaceLabel(workspace: CardWorkspace) {
  return t("Workspace: {kind}", { kind: workspaceLabels[workspace] });
}

export function WorkspaceIcon({ workspace, size = 14 }: { workspace: CardWorkspace; size?: number }) {
  const { colors } = useTheme();
  return <Icon name={workspace === "worktree" ? "GitBranch" : "Folder"} size={size} color={colors.foregroundMuted} />;
}

/** Session visual tone derived from the shared sessionState label set. */
export function sessionTone(
  colors: Colors,
  state: { label: string; active: boolean; waiting?: boolean },
  unread = false,
) {
  if (state.waiting) return colors.statusWarning;
  if (state.label === "Error") return colors.statusDanger;
  if (state.active) return colors.accent;
  if (unread) return colors.statusSuccess;
  if (state.label === "Archived" || state.label === "Closed") return colors.border;
  return tint(colors.foregroundMuted, 0.55);
}
