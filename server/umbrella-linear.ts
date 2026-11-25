import type { Board } from "../shared/model";
import { issuesWithoutCard, linearKeysOf, membersOf, parseLinearProject, suggestedMembers, type LinearProjectIssue, type SuggestedMember } from "../shared/umbrella";
import { ExternalError } from "./connectors/http";
import { ToolError } from "./tool-error";

/**
 * The umbrella's Linear project (UMBRELLA-SPEC §10), read-only: the project, its issues no member references, and the
 * group's cards that look like members. Nothing is written to Linear or to the umbrella.
 */
export type UmbrellaLinear = {
  connectionId: string;
  project: { name: string; state: string; targetDate: string | null; url: string };
  withoutCard: LinearProjectIssue[];
  suggested: SuggestedMember[];
};

type ProjectReader = (ref: { url?: string; key?: string }) => Promise<{ connectionId: string; name: string; state: string; targetDate: string | null; url: string; issues: LinearProjectIssue[] }>;

export async function readUmbrellaLinear(board: Board, id: string, read: ProjectReader): Promise<UmbrellaLinear> {
  const umbrella = board.umbrellas.find((u) => u.id === id);
  if (!umbrella) throw new ToolError("NOT_FOUND", "No umbrella with that id.");
  const stored = umbrella.linearProject;
  if (!stored) throw new ToolError("NOT_FOUND", "This umbrella has no Linear project.");
  const ref = parseLinearProject(stored.url) ?? (stored.key ? parseLinearProject(stored.key) : null);
  if (!ref) throw new ToolError("EXTERNAL_INVALID", "The umbrella's Linear project is not a project link or key.");
  try {
    const found = await read(ref);
    const memberIds = new Set(membersOf(board, id).map((t) => t.id));
    return {
      connectionId: found.connectionId,
      project: { name: found.name, state: found.state, targetDate: found.targetDate, url: found.url },
      withoutCard: issuesWithoutCard(found.issues, linearKeysOf(board, memberIds)),
      suggested: suggestedMembers(board, umbrella, new Set(found.issues.map((i) => i.identifier.toUpperCase()))),
    };
  } catch (error) {
    // The client maps the code (`CODE: message`) to its own words; the daemon text stays English.
    if (error instanceof ExternalError) throw new ToolError(error.code, error.message);
    throw error;
  }
}
