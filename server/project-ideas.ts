import { randomUUID } from "node:crypto";
import { ideaTitleKey } from "../shared/ideas";
import type { Idea } from "../shared/model";
import { normalizeTags } from "../shared/tags";
import { projectIdeaInputSchema, type ProjectIdeaInput } from "../shared/tools";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";

/** Who proposed a project idea: a person, an import, or a session outside cards. */
export type IdeaProposer = { actor: "human" | "agent"; agentId?: string };

/**
 * Ideas that belong to a project, not to a card (PROJECT-IDEAS-SPEC). They have no `taskId` and write no
 * board event; there is no open cap, and an open title is unique within the project.
 */
export class ProjectIdeas {
  constructor(private readonly store: BoardStore) {}

  /** Stores a new open idea, or refuses with `PROJECT_ARCHIVED`, `NOT_FOUND`, `DUPLICATE_IDEA` or `INVALID_INPUT`. */
  async propose(projectId: string, raw: ProjectIdeaInput, by: IdeaProposer): Promise<Idea> {
    const input = projectIdeaInputSchema.parse(raw);
    let tags: string[];
    try {
      tags = normalizeTags(input.tags ?? []);
    } catch (e) {
      throw new ToolError("INVALID_INPUT", e instanceof Error ? e.message : String(e));
    }
    return this.store.transaction((board) => {
      const project = board.projects.find((p) => p.id === projectId);
      if (!project) throw new ToolError("NOT_FOUND", "Project not found.");
      if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The project is archived.");
      const key = ideaTitleKey(input.title);
      const same = board.ideas.find((i) => i.projectId === projectId && !i.taskId && i.status === "open" && ideaTitleKey(i.title) === key);
      if (same) throw new ToolError("DUPLICATE_IDEA", `This project already has an open idea with that title (${same.id}).`);
      const now = new Date().toISOString();
      const idea: Idea = {
        id: randomUUID(),
        projectId,
        ...(by.actor === "agent" && by.agentId ? { agentId: by.agentId } : {}),
        title: input.title,
        detail: input.detail,
        rationale: input.rationale,
        context: input.context,
        ...(input.type ? { type: input.type } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(tags.length ? { tags } : {}),
        ...(input.source ? { source: input.source } : {}),
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      board.ideas.push(idea);
      return { value: { ...idea }, changed: true };
    });
  }

  /** The project's project-level ideas of every status, oldest first. */
  async list(projectId: string): Promise<Idea[]> {
    return (await this.store.read()).ideas
      .filter((i) => i.projectId === projectId && !i.taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}
