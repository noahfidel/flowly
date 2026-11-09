import { randomUUID } from "node:crypto";
import { ideaTitleKey } from "../shared/ideas";
import { importDuplicateReason, importRowSchema, parseBacklog, type ImportRow } from "../shared/ideas-import";
import type { Board, Idea } from "../shared/model";
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
  /** Results of finished imports by `operationId`, newest last; a retry returns the first result (IDEAS-IMPORT-EXPORT-SPEC §4). */
  private readonly imports = new Map<string, Promise<ImportResult>>();
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
      const idea = addProjectIdea(board, projectId, input, tags, by);
      return { value: { ...idea }, changed: true };
    });
  }

  /** Reads pasted backlog markdown into review rows and flags those whose title matches an open project idea. */
  async preview(projectId: string, markdown: string): Promise<{ rows: ImportRow[]; duplicates: number[] }> {
    const board = await this.store.read();
    if (!board.projects.some((p) => p.id === projectId)) throw new ToolError("NOT_FOUND", "Project not found.");
    const known = new Set(openTitleKeys(board, projectId));
    const rows = parseBacklog(markdown);
    // A title already open, or repeated earlier in the paste, would be skipped by the import.
    const duplicates = rows.flatMap((r, i) => {
      const key = ideaTitleKey(r.title);
      const repeated = known.has(key);
      known.add(key);
      return repeated ? [i] : [];
    });
    return { rows, duplicates };
  }

  /**
   * Creates the rows the user kept as one write. A row that cannot be stored (an open duplicate, or one the idea
   * limits refuse) is skipped with a reason and does not stop the rest. The same `operationId` returns the first
   * result without writing again; the result is kept for the daemon's lifetime, and a retry after a restart finds
   * its titles already open and skips them, so nothing is stored twice.
   */
  async import(projectId: string, rows: ImportRow[], operationId: string): Promise<ImportResult> {
    // Keyed by project too: the same operationId in another project is a different import.
    const replayKey = `${projectId}\0${operationId}`;
    const earlier = this.imports.get(replayKey);
    if (earlier) return structuredClone(await earlier);
    const run = this.store.transaction((board) => {
      const project = board.projects.find((p) => p.id === projectId);
      if (!project) throw new ToolError("NOT_FOUND", "Project not found.");
      if (project.archivedAt) throw new ToolError("PROJECT_ARCHIVED", "The project is archived.");
      const open = new Set(openTitleKeys(board, projectId));
      const outcome: ImportResult = { created: 0, skipped: [] };
      for (const row of rows) {
        if (!row.keep) continue;
        const key = ideaTitleKey(row.title);
        if (open.has(key)) {
          outcome.skipped.push({ line: row.line, reason: importDuplicateReason });
          continue;
        }
        // The agent tool requires a detail and a rationale; an imported item may have neither.
        const parsed = importRowSchema.safeParse(row);
        if (!parsed.success) {
          outcome.skipped.push({ line: row.line, reason: parsed.error.issues[0]?.message ?? "Invalid idea." });
          continue;
        }
        addProjectIdea(board, projectId, { title: parsed.data.title, detail: parsed.data.detail, rationale: "", context: "", ...(parsed.data.source ? { source: parsed.data.source } : {}) }, [], { actor: "human" });
        open.add(key);
        outcome.created++;
      }
      return { value: outcome, changed: outcome.created > 0 };
    });
    // Kept while running too, so a retry that overlaps the first call waits for it instead of racing it.
    this.imports.set(replayKey, run);
    while (this.imports.size > importMemory) this.imports.delete(this.imports.keys().next().value!);
    try {
      return structuredClone(await run);
    } catch (e) {
      this.imports.delete(replayKey);
      throw e;
    }
  }

  /** The project's project-level ideas of every status, oldest first. */
  async list(projectId: string): Promise<Idea[]> {
    return (await this.store.read()).ideas
      .filter((i) => i.projectId === projectId && !i.taskId)
      // Ideas stored in the same millisecond (an import) keep their stored order: the sort is stable.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** What an import did: ideas created, and the kept rows that could not be stored. */
export type ImportResult = { created: number; skipped: { line: number; reason: string }[] };
const importMemory = 50;

const openTitleKeys = (board: Board, projectId: string) =>
  board.ideas.filter((i) => i.projectId === projectId && !i.taskId && i.status === "open").map((i) => ideaTitleKey(i.title));

/** Appends an open project idea to the board, or throws `PROJECT_ARCHIVED`, `NOT_FOUND` or `DUPLICATE_IDEA`. */
function addProjectIdea(board: Board, projectId: string, input: ProjectIdeaInput, tags: string[], by: IdeaProposer): Idea {
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
  return idea;
}
