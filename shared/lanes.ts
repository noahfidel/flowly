import { completeLanes, isWorkStatus, statusLabels, statuses, type Lane, type Project, type Status } from "./model";

type WithLanes = Pick<Project, "lanes"> | null | undefined;

/** Every lane of a project in display order (enabled or not), with defaults filled in. */
export function projectLanes(project: WithLanes): Lane[] {
  const configured = project?.lanes;
  if (!configured) return statuses.map((status) => ({ status, enabled: true }));
  // Defensive: statuses missing from stored data are inserted after their default predecessor, enabled.
  return completeLanes(configured);
}

/** Enabled lanes in display order: the project's workflow. */
export function enabledStatuses(project: WithLanes): Status[] {
  return projectLanes(project)
    .filter((l) => l.enabled)
    .map((l) => l.status);
}

export function laneEnabled(project: WithLanes, status: Status) {
  return enabledStatuses(project).includes(status);
}

/** The lane's display name (custom, else the built-in label). */
export function laneName(project: WithLanes, status: Status) {
  return projectLanes(project).find((l) => l.status === status)?.name?.trim() || statusLabels[status];
}

/** Error text when a status is not part of the project's workflow, else "". */
export function laneProblem(project: WithLanes, status: Status) {
  return laneEnabled(project, status) ? "" : `${laneName(project, status)} is not a lane in this project.`;
}

/**
 * The lane a started card moves to (DISPATCHER-SPEC §4.1): only a card still in Backlog or Todo moves, to the project's
 * active-work lane chosen by role, never by id: Development when enabled, else the first enabled work lane. Null when
 * the card stays (any other status, or the workflow has no work lane).
 */
export function startedStatus(project: WithLanes, status: Status): Status | null {
  if (status !== "backlog" && status !== "todo") return null;
  const enabled = enabledStatuses(project);
  return enabled.includes("development") ? "development" : (enabled.find((s) => isWorkStatus(s)) ?? null);
}
