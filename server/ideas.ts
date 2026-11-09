import type { PaseoApi } from "@getpaseo/client";
import type { IdeaAdoption } from "../shared/model";
import { FINISHED_CARD_IDEA, continuesInCard, ideaInstruction } from "../shared/ideas";
import { isSummarizer } from "../shared/summary";
import type { BoardStore } from "./store";

type Push = (input: { taskId: string; agentId: string; text: string }, paseo: PaseoApi) => Promise<unknown>;

/**
 * "Do it in this task" (IDEAS-SPEC §6.2): mark the idea accepted for the
 * chosen session of its own card, then (unless `send` is false, for a session
 * just started with the idea as its first instruction) queue it through the
 * composer (sent now when idle, after the running turn otherwise). The mark
 * comes first so a repeated press cannot send twice; a failed hand-off puts
 * the idea back to open.
 */
export async function adoptIdea(store: BoardStore, push: Push, input: IdeaAdoption, paseo: PaseoApi) {
  const board = await store.read();
  const idea = board.ideas.find((i) => i.id === input.id);
  if (idea && idea.status === "open" && !idea.taskId) throw new Error("A project idea has no card to continue in.");
  const task = idea && board.tasks.find((t) => t.id === idea.taskId);
  if (!idea || idea.status !== "open" || !task) throw new Error("This idea is no longer open.");
  if (!continuesInCard(task)) throw new Error(FINISHED_CARD_IDEA);
  const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
  if (!agent || agent.workspaceId !== task.workspaceId || agent.archivedAt || isSummarizer(agent))
    throw new Error("Choose a live session of this card.");
  const accepted = await store.transaction((current) => {
    const live = current.ideas.find((i) => i.id === input.id);
    const card = live && current.tasks.find((t) => t.id === live.taskId);
    const project = card && current.projects.find((p) => p.id === card.projectId);
    if (!live || live.status !== "open" || !card) throw new Error("This idea is no longer open.");
    if (!project || project.archivedAt) throw new Error("The project is archived.");
    if (!continuesInCard(card)) throw new Error(FINISHED_CARD_IDEA);
    live.status = "accepted";
    live.acceptedAgentId = input.agentId;
    live.updatedAt = new Date().toISOString();
    const event = store.event(current, {
      taskId: card.id,
      actor: "human",
      action: "idea_adopted",
      agentId: input.agentId,
      note: live.title,
    });
    return { value: { idea: { ...live }, eventId: event.id }, changed: true };
  });
  if (input.send === false) return accepted.idea;
  try {
    await push({ taskId: task.id, agentId: input.agentId, text: ideaInstruction(accepted.idea) }, paseo);
  } catch (error) {
    await store.transaction((current) => {
      const live = current.ideas.find((i) => i.id === input.id);
      if (!live || live.acceptedAgentId !== input.agentId) return { value: null, changed: false };
      live.status = "open";
      delete live.acceptedAgentId;
      live.updatedAt = new Date().toISOString();
      current.events = current.events.filter((e) => e.id !== accepted.eventId);
      return { value: null, changed: true };
    });
    throw error;
  }
  return accepted.idea;
}
