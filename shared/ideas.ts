import type { Idea, Task } from "./model";

/** Task description limit (taskSchema.description). */
export const DESCRIPTION_MAX = 20000;

/** Titles compare trimmed and case-insensitively (one open idea per title on a card). */
export const ideaTitleKey = (title: string) => title.trim().toLowerCase();

/** The Ideas page's default order (IDEAS-INBOX-SPEC §4), also flowly_list_ideas' (DISPATCHER-SPEC §5.1): newest first, then by id. */
export const ideaNewestFirst = (a: Pick<Idea, "createdAt" | "id">, b: Pick<Idea, "createdAt" | "id">) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

export const openIdeas = (ideas: readonly Idea[], taskId: string) =>
  ideas.filter((i) => i.taskId === taskId && i.status === "open");

/**
 * The instruction sent to a session of the idea's own card when the user
 * chooses "Do it in this task" (IDEAS-SPEC §6.2).
 */
export function ideaInstruction(idea: Pick<Idea, "title" | "detail" | "rationale" | "context">): string {
  return [
    `Good idea — go ahead with it in this task: ${idea.title.trim()}`,
    idea.detail.trim(),
    idea.rationale.trim() && `Why: ${idea.rationale.trim()}`,
    idea.context.trim() && `Context:\n${idea.context.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Prefilled description of a card created from an idea (IDEAS-SPEC §6): the idea,
 * why, its context, the source card and, when present, the source's progress.
 */
export function ideaDescription(
  idea: Pick<Idea, "detail" | "rationale" | "context">,
  source: Pick<Task, "id" | "title"> | undefined,
  progress?: { target: string; recap: string } | null,
): string {
  const sourceProgress = [progress?.target.trim(), progress?.recap.trim()].filter(Boolean).join("\n");
  const parts = [
    idea.detail.trim(),
    idea.rationale.trim() && `Why: ${idea.rationale.trim()}`,
    idea.context.trim() && `Context:\n${idea.context.trim()}`,
    source && `From card: ${source.title} (${source.id})`,
    sourceProgress && `Source progress:\n${sourceProgress}`,
  ].filter(Boolean);
  const text = parts.join("\n\n");
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

/**
 * A finished (Done/Cancelled) or archived card keeps its ideas, but they can
 * only become new cards: its sessions must not resume work (IDEAS-INBOX-SPEC §2.3).
 */
export const continuesInCard = (task: Pick<Task, "status" | "archivedAt">) =>
  !task.archivedAt && task.status !== "done" && task.status !== "cancelled";

export const FINISHED_CARD_IDEA =
  "This card is finished. Start a new task, or move the card back to continue in it.";
