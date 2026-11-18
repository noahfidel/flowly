import type { PaseoApi } from "@getpaseo/client";
import type { Project, ProjectInput } from "../shared/model";
import type { BoardService } from "./service";
import { projectAutoReview } from "../shared/auto-review";

/**
 * The `projects.create` RPC's path: the board service's create (serialized with every other project and card write
 * of that service), then, when its group has Auto review on (the project inherits it, BOARD-GROUPS-SPEC §5), the new
 * project's check commands detected for its guardrails (GUARDRAILS-SPEC §4.5), which never block the creation. The RPC and the dispatcher's `flowly_create_project` use the one function the plugin
 * entry makes (DISPATCHER-SPEC §5.2).
 */
export function projectCreator(service: BoardService, detectCommands: (projectId: string) => void) {
  return async (input: ProjectInput, paseo: PaseoApi): Promise<Project> => {
    const project = await service.createProject(input, paseo);
    const board = await service.store.read().catch(() => null);
    if (board && projectAutoReview(board, board.projects.find((p) => p.id === project.id) ?? project).enabled) detectCommands(project.id);
    return project;
  };
}
