import { enabledStatuses } from "../shared/lanes";
import type { Project, Status } from "../shared/model";

/** Quick task defaults (docs/QUICK-TASK-SPEC.md §3). Pure, so the dialog and the board agree. */
export type QuickMode = "worktree" | "directory";

/**
 * The project a quick task opens with: `pinned` (an entry point tied to one project), else the last quick-task
 * project, else the board's, else the first live one. Archived projects never qualify.
 */
export function quickProject(
  projects: readonly Project[],
  ids: { pinned?: string; last: string; current: string },
): Project | null {
  const live = projects.filter((p) => !p.archivedAt);
  const find = (id?: string) => (id ? live.find((p) => p.id === id) : undefined);
  return find(ids.pinned) ?? find(ids.last) ?? find(ids.current) ?? live[0] ?? null;
}

/** The chosen workspace mode; a project with links has no worktree option (as in the full form). */
export function quickMode(project: Pick<Project, "links">, preferred: QuickMode): QuickMode {
  return project.links ? "directory" : preferred;
}

/** Where a new task starts: the requested lane when enabled, else the first active lane. */
export function startStatus(project: Project, requested: Status): Status {
  const lanes = enabledStatuses(project);
  if (lanes.includes(requested)) return requested;
  return lanes.find((s) => s !== "done" && s !== "cancelled") ?? lanes[0];
}
