import { enabledStatuses } from "../shared/lanes";
import type { Idea, Project, Status, Task } from "../shared/model";
import type { ConnectorProvider, ExternalSummary } from "../shared/connectors";
import { provisionalTitle } from "../shared/quick-task";
import { ideaDescription } from "../shared/ideas";
import { firstMessage } from "./first-message";
import type { TaskSeed } from "./forms";

/** Quick task defaults (docs/QUICK-TASK-SPEC.md §3). Pure, so the dialog and the board agree. */
export type QuickMode = "worktree" | "directory";

/**
 * The project a quick task opens with: `pinned` (an entry point tied to one project), else `last` (only Q and
 * the Command Center pass the last quick-task project), else the board's, else the first live one. Archived
 * projects never qualify.
 */
export function quickProject(
  projects: readonly Project[],
  ids: { pinned?: string; last?: string; current: string },
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

type Externals = { item: ExternalSummary; provider: ConnectorProvider }[];

/** The idea a Quick task makes a card from (QUICK-TASK-SPEC §10): what the card gets besides the typed text. */
export type QuickIdea = Pick<Idea, "id" | "projectId" | "type" | "priority" | "tags"> & { description: string };

/**
 * What Quick task opens with when it starts from an external item, e.g. Linear's Start card (LINEAR-BOARD-SPEC §5),
 * or from an idea (QUICK-TASK-SPEC §10).
 */
export type QuickTaskSeed = {
  /** The card's title while the items stay attached, or the idea's title. */
  title: string;
  externals: Externals;
  /** The text box's first text. */
  text?: string;
  /** From an idea: its project is locked and the card is made from it. */
  idea?: QuickIdea;
};

/** The idea's title and detail, as the text box's first text. */
export const ideaQuickText = (idea: Pick<Idea, "title" | "detail">) => [idea.title.trim(), idea.detail.trim()].filter(Boolean).join("\n\n");

/** Quick task from an idea: the full form's description (IDEAS-SPEC §6.1) and the idea's own fields. */
export function ideaQuickSeed(idea: Idea, source: Pick<Task, "id" | "title"> | undefined, progress?: { target: string; recap: string } | null): QuickTaskSeed {
  return {
    title: idea.title,
    externals: [],
    text: ideaQuickText(idea),
    idea: {
      id: idea.id,
      projectId: idea.projectId,
      description: ideaDescription(idea, source, progress),
      ...(idea.type ? { type: idea.type } : {}),
      ...(idea.priority ? { priority: idea.priority } : {}),
      ...(idea.tags?.length ? { tags: idea.tags } : {}),
    },
  };
}

/** The projects the dialog may choose from: the live ones, or only the idea's (locked; none when it is not live). */
export function quickProjects(projects: readonly Project[], seed: Pick<QuickTaskSeed, "idea"> | undefined): Project[] {
  const live = projects.filter((p) => !p.archivedAt);
  return seed?.idea ? live.filter((p) => p.id === seed.idea!.projectId) : live;
}

/**
 * The card's title and whether the AI may retitle it: an idea, or an attached seed item, already names the card, so no
 * AI title runs; without one (or once its chip is removed) the provisional title from the text applies (QUICK-TASK-SPEC §2).
 */
export function quickCard(text: string, seed: Pick<QuickTaskSeed, "title" | "idea"> | undefined, attached: number): { title: string; aiTitle: boolean } {
  return seed && (seed.idea || attached > 0) ? { title: seed.title, aiTitle: false } : { title: provisionalTitle(text), aiTitle: true };
}

/** The `tasks.create` input of a quick task (§2); from an idea it carries the idea's id and fields (§10). */
export function quickCreateInput(input: {
  projectId: string;
  operationId: string;
  text: string;
  seed: QuickTaskSeed | undefined;
  externals: Externals;
  status: Status;
  mode: QuickMode;
}) {
  const idea = input.seed?.idea;
  const items = input.externals.map((x) => x.item);
  return {
    projectId: input.projectId,
    operationId: input.operationId,
    title: quickCard(input.text, input.seed, input.externals.length).title,
    description: idea?.description ?? "",
    status: input.status,
    priority: idea?.priority ?? ("normal" as const),
    ...(idea?.type ? { type: idea.type } : {}),
    ...(idea?.tags?.length ? { tags: idea.tags } : {}),
    mode: input.mode,
    baseRef: "",
    branchName: "",
    ...(items.length ? { externals: items.map((x) => ({ connectionId: x.connectionId, key: x.key, itemType: x.itemType })) } : {}),
    ...(idea ? { ideaId: idea.id } : {}),
  };
}

/** What More options… hands to the full form (§1), without the agent and images the dialog adds. */
export function quickMoreSeed(input: { text: string; seed: QuickTaskSeed | undefined; externals: Externals; mode: QuickMode }): TaskSeed {
  const idea = input.seed?.idea;
  return {
    ...(idea ? { ideaId: idea.id } : {}),
    title: quickCard(input.text, input.seed, input.externals.length).title,
    description: idea?.description ?? "",
    ...(idea?.type ? { type: idea.type } : {}),
    ...(idea?.priority ? { priority: idea.priority } : {}),
    ...(idea?.tags?.length ? { tags: idea.tags } : {}),
    ...(input.externals.length ? { externals: input.externals } : {}),
    prompt: input.text,
    startAgent: true,
    mode: input.mode,
  };
}

/** The agent's first message: the typed text, else the default that points at the attached items, else null (cannot send). */
export const quickPrompt = (text: string, items: Parameters<typeof firstMessage>[1]) => firstMessage(text, items);
