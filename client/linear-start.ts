import { z } from "zod";
import type { PluginScreenParams } from "@getpaseo/plugin/client";
import type { ConnectorProvider, ExternalSummary } from "../shared/connectors";
import type { LinearCard } from "../shared/linear-board";
import type { Group, Project } from "../shared/model";
import { includedProjects } from "./all-projects";
import { groupMembers, groupQuickProject } from "./board-groups";
import { t } from "../shared/i18n";
import type { QuickTaskSeed } from "./quick-task";

/**
 * From the Linear board to Flowly's board (LINEAR-BOARD-SPEC §5): Start card opens New task with the
 * issue attached, Open card opens the card that already references it. Both travel as screen params.
 */

const id = z.string().min(1).max(300);
const startSchema = z.object({ linearIssue: id, connectionId: id, requestId: id });
const openSchema = z.object({ openTaskId: id, projectId: id, workspaceId: id, requestId: id });
export type LinearStart = { key: string; connectionId: string; requestId: string };
export type LinearOpen = { taskId: string; projectId: string; workspaceId: string; requestId: string };

export const linearStartParams = (issue: { connectionId: string; key: string }, requestId: string): PluginScreenParams => ({
  linearIssue: issue.key,
  connectionId: issue.connectionId,
  requestId,
});

export const linearOpenParams = (card: LinearCard, requestId: string): PluginScreenParams => ({
  openTaskId: card.taskId,
  projectId: card.projectId,
  workspaceId: card.workspaceId,
  requestId,
});

export function parseLinearStart(params?: PluginScreenParams): LinearStart | null {
  if (!params || !("linearIssue" in params)) return null;
  const parsed = startSchema.safeParse(params);
  if (!parsed.success) throw new Error(t("Invalid Start card link. Start the card again from the Linear board."));
  return { key: parsed.data.linearIssue, connectionId: parsed.data.connectionId, requestId: parsed.data.requestId };
}

export function parseLinearOpen(params?: PluginScreenParams): LinearOpen | null {
  if (!params || !("openTaskId" in params)) return null;
  const parsed = openSchema.safeParse(params);
  if (!parsed.success) throw new Error(t("Invalid Open card link. Open the card again from the Linear board."));
  return { taskId: parsed.data.openTaskId, projectId: parsed.data.projectId, workspaceId: parsed.data.workspaceId, requestId: parsed.data.requestId };
}

/** Params of these links are not session links. */
export const isLinearLink = (params: PluginScreenParams) => "linearIssue" in params || "openTaskId" in params;

/** What Quick task opens with: the issue attached and the card titled `KEY: title` (LINEAR-BOARD-SPEC §5). */
export function linearQuickSeed(item: ExternalSummary, provider: ConnectorProvider = "linear"): QuickTaskSeed {
  return { title: item.summary ? `${item.key}: ${item.summary}` : item.key, externals: [{ item, provider }] };
}

/**
 * The project Start card opens Quick task in (LINEAR-BOARD-SPEC §5, QUICK-TASK-SPEC §3): the shown group's quick
 * project (its Project filter, else the last quick-task project when a live member, else its first member; an empty
 * group uses All's rule). Not ready until the board-view settings and the groups are loaded, so a cold start uses the
 * stored group and filter instead of the default group.
 */
export function linearStartTarget(input: {
  groups: readonly Group[];
  projects: readonly Project[];
  shownGroupId: string;
  filterId: string;
  lastQuickProjectId: string;
  settingsLoaded: boolean;
}): { ready: false } | { ready: true; projectId: string | null } {
  if (!input.settingsLoaded || input.groups.length === 0) return { ready: false };
  const live = includedProjects(input.projects);
  const shown = input.groups.find((g) => g.id === input.shownGroupId);
  const members = shown ? groupMembers(shown, input.projects).filter((p) => !p.archivedAt) : live;
  const target = groupQuickProject(members, live, input.lastQuickProjectId, input.filterId);
  return { ready: true, projectId: target?.id ?? null };
}
