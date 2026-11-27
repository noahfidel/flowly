/**
 * The client side of a project's Start prompt (START-PROMPT-TEMPLATE-SPEC §4, §5): the card drawer's New session text
 * and the settings preview. Pure: no React, no i18n; the rendered text is agent-facing English.
 */
import type { CardDetail } from "../shared/card-detail";
import type { Project, Task } from "../shared/model";
import { defaultSessionStartText } from "../shared/session-start";
import { parseTemplate, promptState, renderStartPrompt, renderTemplate, type StartPromptState } from "../shared/start-prompt";

type Detail = Pick<CardDetail, "artifacts" | "links" | "relatedTasks">;

/** An existing card's state; without its detail (not loaded yet) it has no artifacts or links. */
export function cardPromptState(input: {
  project: Pick<Project, "lanes"> | null | undefined;
  task: Task;
  detail: Detail | null | undefined;
  deliveryMode: string;
  firstSession: boolean;
  workspaceDir?: string;
}): StartPromptState {
  const { detail } = input;
  return promptState({
    project: input.project,
    task: input.task,
    board: { artifacts: detail?.artifacts ?? [], links: detail?.links ?? [], tasks: detail?.relatedTasks ?? [] },
    deliveryMode: input.deliveryMode,
    firstSession: input.firstSession,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
}

/** The settings preview's state: the card counts as started once one of its events came from an agent. */
export function previewPromptState(input: {
  project: Pick<Project, "lanes"> | null | undefined;
  task: Task;
  detail: (Detail & Pick<CardDetail, "events">) | null | undefined;
  deliveryMode: string;
}): StartPromptState {
  return cardPromptState({ ...input, firstSession: !input.detail?.events.some((e) => e.agentId) });
}

/** What the drawer's New session box opens with: the template rendered for the card, else the built-in text (§4). */
export function drawerStartText(project: Pick<Project, "sessionStartText">, state: StartPromptState): string {
  return renderStartPrompt(project.sessionStartText, state) ?? defaultSessionStartText;
}

/** The cards the preview may show (§5): the project's live cards outside Done and Cancelled, newest first. */
export function previewCards<T extends Pick<Task, "projectId" | "status" | "archivedAt" | "createdAt">>(tasks: readonly T[], projectId: string): T[] {
  return tasks
    .filter((t) => t.projectId === projectId && !t.archivedAt && t.status !== "done" && t.status !== "cancelled")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The card shown: the chosen one while it is listed, else the first; "" when there is none. */
export function previewCardId(cards: readonly Pick<Task, "id">[], chosen: string): string {
  return cards.some((c) => c.id === chosen) ? chosen : (cards[0]?.id ?? "");
}

export type StartPromptPreview = { kind: "text"; text: string } | { kind: "error"; error: string; line: number };

/**
 * What the preview shows for the field's text (§5): a parse error with its line (with or without a card); with a card,
 * the template rendered for it, or what the drawer opens with today when the field is empty or renders empty; null
 * when there is no card to render for.
 */
export function startPromptPreview(text: string, state: StartPromptState | null): StartPromptPreview | null {
  const parsed = text.trim() ? parseTemplate(text) : null;
  if (parsed && !parsed.ok) return { kind: "error", error: parsed.error, line: parsed.line };
  if (!state) return null;
  return { kind: "text", text: (parsed?.ok && renderTemplate(parsed.template, state)) || defaultSessionStartText };
}
