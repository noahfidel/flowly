/** Pure parts of the group settings page and the inherited defaults (BOARD-GROUPS-SPEC §5). No React. */
import { t, tn } from "../shared/i18n";
import { orderedGroups } from "../shared/groups";
import { projectOrder, type Group, type Project, type Task } from "../shared/model";
import { umbrellasLosingMembers, type UmbrellaSummary } from "../shared/umbrella";
import { effectiveDispatcherModel, type AgentModel } from "../shared/agent-defaults";
import { deliveryModeLabels, resolveDeliveryMode } from "../shared/delivery-mode";
import { effectiveAutoReview, type ReviewConfig } from "../shared/auto-review";

/** An empty default's label: what it takes from the level above, shown (§5). */
export const inheritLabel = (value: string) => t("Inherit: {value}", { value });

/** A model default in one line. */
export const agentModelText = (model: AgentModel) => `${model.provider} · ${model.model}`;

/** What an empty new-card model inherits: the group's default (when asked from a project), else the host's, else Automatic. */
export function inheritedModelText(group: Pick<Group, "defaults"> | null | undefined, host: AgentModel | null | undefined): string {
  const model = group?.defaults?.agentModel ?? host;
  return model ? agentModelText(model) : t("Automatic");
}

/** What an empty delivery mode inherits: the group's (when asked from a project), else the host default. */
export function inheritedDeliveryText(group: Pick<Group, "defaults"> | null | undefined, host: unknown): string {
  return t(deliveryModeLabels[resolveDeliveryMode({ group: group?.defaults?.deliveryMode, host }).mode]);
}

/** What a group's empty dispatcher model inherits: the host setting, else the built-in default (`effectiveDispatcherModel`). */
export function inheritedDispatcherText(host: AgentModel | null | undefined): string {
  return agentModelText(effectiveDispatcherModel(null, host));
}

/** An Auto review value in one line: "On, 2 rounds" or "Off". */
export const autoReviewText = (config: ReviewConfig) => (config.enabled ? tn(config.maxRounds, "On, {n} round", "On, {n} rounds") : t("Off"));

/** What a project without an Auto review override follows: its group's value, else Off (BOARD-GROUPS-SPEC §5). */
export function inheritedAutoReviewText(group: Pick<Group, "name" | "defaults"> | null | undefined): string {
  const value = autoReviewText(effectiveAutoReview(null, group));
  return group ? t("Inherited from {group}: {value}", { group: group.name, value }) : t("Inherited: {value}", { value });
}

/**
 * The line shown when moving a project to another group changes its Auto review: only for a project without an
 * override, and only when the target group's value differs from the current one. Null otherwise.
 */
export function autoReviewMoveNote(
  project: Pick<Project, "autoReview">,
  from: Pick<Group, "defaults"> | null | undefined,
  to: Pick<Group, "name" | "defaults">,
): string | null {
  if (project.autoReview) return null;
  const before = effectiveAutoReview(null, from),
    after = effectiveAutoReview(null, to);
  if (before.enabled === after.enabled && (!after.enabled || before.maxRounds === after.maxRounds)) return null;
  return t("Auto review will follow {group}: {value}.", { group: to.name, value: autoReviewText(after) });
}

/** A group's member projects in board order, archived ones last. */
export function groupMembersOf<P extends Pick<Project, "id" | "groupId" | "archivedAt" | "position" | "createdAt">>(projects: readonly P[], groupId: string): P[] {
  return projects
    .filter((p) => p.groupId === groupId)
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || projectOrder(a, b));
}

/** The move-to-group choices: every group in tab order. */
export function groupChoices(groups: readonly Group[]) {
  return orderedGroups(groups).map((g) => ({ value: g.id, label: g.name }));
}

/** The project ids with unsaved edits after one section reports; the same set when nothing changed. */
export function withDirty(dirty: ReadonlySet<string>, projectId: string, isDirty: boolean): ReadonlySet<string> {
  if (dirty.has(projectId) === isDirty) return dirty;
  const next = new Set(dirty);
  if (isDirty) next.add(projectId);
  else next.delete(projectId);
  return next;
}

/** The key unsaved lane edits use among the page's unsaved sections (project ids otherwise). */
export const lanesDirtyKey = "*lanes";

/**
 * Discard drops every unsaved section's key, the lane draft's and each project section's (ruling, Noah 2026-11-11); the
 * drafts themselves are reset by remounting the editors (the page's discard epoch).
 */
const clean: ReadonlySet<string> = new Set();
export const afterDiscard = (dirty: ReadonlySet<string>): ReadonlySet<string> => (dirty.size ? clean : dirty);

/** Closing, moving a project or deleting the group asks first while any section holds unsaved edits. */
export const needsDiscardConfirm = (dirty: ReadonlySet<string>): boolean => dirty.size > 0;

/**
 * The group to show: the one the overview lists, unless this page wrote a newer revision. A group this page wrote or
 * created counts only until the overview has listed it once (`seen`); after that, absent means gone.
 */
export function shownGroup(listed: Group | undefined, written: Group | undefined, seen: boolean): Group | undefined {
  if (!written) return listed;
  if (!listed) return seen ? undefined : written;
  return written.revision > listed.revision ? written : listed;
}

/** The revision a project write must send: the newest of the overview's and the last one a section save returned. */
export const currentRevision = (project: Pick<Project, "revision">, saved: number | undefined): number => Math.max(project.revision, saved ?? 0);

/** What the confirm of a project move or a Delete group reads: the overview's groups, projects, cards and umbrella summaries. */
export type UmbrellaMoveBoard = { groups: readonly Group[]; projects: readonly Project[]; tasks: readonly Task[]; umbrellas: readonly UmbrellaSummary[] };

/** One line per umbrella a move would split, "<title> loses N cards" (UMBRELLA-SPEC §9); none when nothing is lost. */
export function umbrellaLossLines(board: UmbrellaMoveBoard, moves: readonly { projectId: string; groupId: string }[]): string[] {
  return umbrellasLosingMembers(board, moves).map((u) => tn(u.cards, "{title} loses {n} card", "{title} loses {n} cards", { title: u.title }));
}

/** The lines for deleting a group: every project in it goes to the default group. */
export function umbrellaLossLinesForDelete(board: UmbrellaMoveBoard, groupId: string, defaultGroupId: string | undefined): string[] {
  if (!defaultGroupId) return [];
  return umbrellaLossLines(
    board,
    board.projects.filter((p) => p.groupId === groupId).map((p) => ({ projectId: p.id, groupId: defaultGroupId })),
  );
}
