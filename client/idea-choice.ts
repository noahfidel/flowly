import type { Idea, Task } from "../shared/model";
import { continuesInCard } from "../shared/ideas";

/**
 * What Good idea offers (IDEAS-SPEC §6, IDEAS-INBOX-SPEC §2.3) and what Quick task's Other options… lists
 * (QUICK-TASK-SPEC §10). Pure: no React, no i18n; the lists turn into menu rows where they are shown.
 */

export type ChoiceSession = { id: string; title?: string | null; archivedAt?: string | null };
type Card = Pick<Task, "title" | "status" | "archivedAt">;

/** Why an idea cannot continue in its card: the card is Done/Cancelled, archived, or no longer there. */
export type CardBlock = { reason: "finished" | "archived" | "gone"; title?: string };

export type IdeaStep =
  | { kind: "new-task"; suggested: boolean }
  | { kind: "continue"; session: ChoiceSession; suggested: boolean }
  /** The live sessions to pick from; `current` is the one Continue would use. */
  | { kind: "send-other"; sessions: ChoiceSession[]; current: ChoiceSession | undefined }
  | { kind: "new-session"; suggested: boolean };

export type GoodIdeaPlan =
  /** Only a new task is possible: no menu. `blocked`: the card it cannot continue in. */
  | { kind: "new-task"; blocked?: CardBlock }
  | { kind: "menu"; entries: (IdeaStep | { kind: "separator" })[] };

/** Quick task's Other options…: the full form, the card's own actions, or why there are none. */
export type OtherOption = { kind: "form" } | Exclude<IdeaStep, { kind: "new-task" }> | { kind: "note"; blocked: CardBlock };

/** Null when the idea can continue in its card (or has none: a project idea). */
export function cardBlock(idea: Pick<Idea, "taskId">, card: Card | undefined): CardBlock | null {
  if (!idea.taskId) return null;
  if (!card) return { reason: "gone" };
  if (continuesInCard(card)) return null;
  return { reason: card.archivedAt ? "archived" : "finished", title: card.title };
}

/** The card's own actions: continue in the proposer's session (else the newest live one), another one, or a new one. */
export function continueSteps(idea: Pick<Idea, "agentId" | "scope">, sessions: readonly ChoiceSession[]): Exclude<IdeaStep, { kind: "new-task" }>[] {
  const here = idea.scope === "here";
  const live = sessions.filter((s) => !s.archivedAt);
  const session = live.find((s) => s.id === idea.agentId) || live[0];
  return [
    ...(session ? [{ kind: "continue" as const, session, suggested: here }] : []),
    ...(live.length > 1 ? [{ kind: "send-other" as const, sessions: live, current: session }] : []),
    { kind: "new-session" as const, suggested: here && !session },
  ];
}

/** Good idea: straight to a new task when that is the only path, else the menu with the agent's suggestion first. */
export function goodIdeaPlan(idea: Pick<Idea, "taskId" | "agentId" | "scope">, card: Card | undefined, sessions: readonly ChoiceSession[]): GoodIdeaPlan {
  if (!idea.taskId) return { kind: "new-task" };
  const blocked = cardBlock(idea, card);
  if (blocked) return { kind: "new-task", blocked };
  const here = idea.scope === "here";
  const inCard = continueSteps(idea, sessions);
  const divider = { kind: "separator" as const };
  const newTask = { kind: "new-task" as const, suggested: !here };
  return { kind: "menu", entries: here ? [...inCard, divider, newTask] : [newTask, divider, ...inCard] };
}

/** Quick task's Other options… for this idea (QUICK-TASK-SPEC §10). */
export function ideaOtherOptions(idea: Pick<Idea, "taskId" | "agentId" | "scope">, card: Card | undefined, sessions: readonly ChoiceSession[]): OtherOption[] {
  if (!idea.taskId) return [{ kind: "form" }];
  const blocked = cardBlock(idea, card);
  return blocked ? [{ kind: "form" }, { kind: "note", blocked }] : [{ kind: "form" }, ...continueSteps(idea, sessions)];
}

/**
 * Other options… for an idea link: as from the drawer, except that a card missing from the board's overview is not
 * called gone (the link reads the idea fresh; the overview may lag), so it offers only the full form.
 */
export function ideaLinkOptions(idea: Pick<Idea, "taskId" | "agentId" | "scope">, card: Card | undefined, sessions: readonly ChoiceSession[]): OtherOption[] {
  return idea.taskId && !card ? [{ kind: "form" }] : ideaOtherOptions(idea, card, sessions);
}

/** Where a new task from an idea opens: Quick task unless *Quick task for New task* is off. */
export const newTaskFromIdea = (quickDefault: boolean): "quick" | "form" => (quickDefault ? "quick" : "form");
