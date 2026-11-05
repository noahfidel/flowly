import type { Artifact, Project } from "./model";

/**
 * "Make sure there's a Linear ticket" (docs/LINEAR-TICKET-SPEC.md). Flowly only asks the agent; the agent searches,
 * creates and links the ticket with its own Linear tools. Flowly never writes to Linear.
 */

export const linearTeamMax = 80;

/** The stored team: trimmed, one line, at most 80 characters; "" means none (§1). */
export const linearTeamValue = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, linearTeamMax).trim();

function onLinearApp(target: string) {
  try {
    const url = new URL(target.trim());
    const host = url.hostname.toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:") && (host === "linear.app" || host.endsWith(".linear.app"));
  } catch {
    return false;
  }
}

/** Whether one of the card's artifacts is a Linear item: a Linear connector item or a linear.app link (§2). */
export function hasLinearItem(artifacts: readonly Pick<Artifact, "kind" | "target" | "external">[]) {
  return artifacts.some((a) => a.external?.provider === "linear" || (a.kind === "url" && onLinearApp(a.target)));
}

/** The block for the card's session context, or [] when the project does not ask for it or a ticket is linked (§2, §3). */
export function linearTicketLines(
  project: Pick<Project, "linearTicket" | "linearTeam">,
  artifacts: readonly Pick<Artifact, "kind" | "target" | "external">[],
): string[] {
  if (project.linearTicket !== true || hasLinearItem(artifacts)) return [];
  const team = linearTeamValue(project.linearTeam ?? "");
  return [
    "Linear ticket: this project wants every card tracked by a Linear ticket, and none is linked to this card yet. Before you start the work:",
    "1. Search Linear with your Linear tools (for example list_issues) for an existing ticket that matches this card.",
    team
      ? `2. If none fits, create one in the Linear team "${team}". Follow the eng-conventions:linear-tickets skill when it is available.`
      : "2. If none fits, create one in the team the card, the repository or Linear makes clear; when you can't tell, ask the user once which team. Follow the eng-conventions:linear-tickets skill when it is available.",
    "3. Link the ticket to this card with flowly_add_artifact role=input and the ticket URL as target, and name the ticket ID in your first progress report.",
    "If you have no Linear tools, say so in one line and carry on with the card.",
  ];
}
