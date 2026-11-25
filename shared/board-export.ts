import { agentsRule, type MemoryEntry } from "./memory";
import { isSourceNote, parseBacklog } from "./ideas-import";
import type { Board, Idea, Project } from "./model";
import { membersOf } from "./umbrella";

/** Markdown export of a board (IDEAS-IMPORT-EXPORT-SPEC §7): open cards, open ideas and active memory per live project. */

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const balanced = (text: string) => {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

/** The parenthetical after an idea title, in a form `parseBacklog` takes as the source note. */
function ideaNote(idea: Idea, cardTitle: string | undefined) {
  let note = oneLine((idea.source || cardTitle || "").replace(/`/g, ""));
  // Unbalanced parentheses are dropped first, so a note of only parentheses gets the same title guard as no note.
  if (!balanced(note)) note = oneLine(note.replace(/[()]/g, ""));
  if (!note) {
    // No note of its own: a title that already ends in an added-style parenthetical would lose it to the parser on re-import.
    const title = oneLine(idea.title);
    const [row] = parseBacklog(`- [ ] ${title}`);
    return row && (row.source !== null || row.title !== title) ? `added ${idea.createdAt.slice(0, 10)}` : "";
  }
  return isSourceNote(note) ? note : `added ${idea.createdAt.slice(0, 10)}, ${note}`;
}

const ideaLines = (idea: Idea, cardTitle: string | undefined) => {
  const note = ideaNote(idea, cardTitle);
  const lines = [`- [ ] ${oneLine(idea.title)}${note ? ` (${note})` : ""}`];
  for (const raw of idea.detail.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) lines.push(`  ${line.startsWith("- ") ? line : `- ${line}`}`);
  }
  return lines;
};

/** How much of an umbrella's brief the export carries (UMBRELLA-SPEC §9). */
export const exportBriefLimit = 2000;

/**
 * The umbrellas with a member in the exported projects, each once, after the projects (UMBRELLA-SPEC §9): title,
 * Linear link, the brief (cut to `exportBriefLimit`, as a quote so its headings stay inside it), the members in the
 * exported projects, and the members elsewhere as `title (project)` only. Pass the full board (`store.read()`): the
 * client view holds no brief text.
 */
function umbrellaSection(board: Board, exported: readonly Project[], projects: readonly Pick<Project, "id" | "title">[], briefs: boolean): string[] {
  const inExport = new Set(exported.map((p) => p.id));
  const projectTitle = (id: string) => {
    const project = projects.find((p) => p.id === id);
    return project ? oneLine(project.title) : "unknown project";
  };
  const out: string[] = [];
  for (const umbrella of board.umbrellas) {
    const members = membersOf(board, umbrella.id);
    const here = members.filter((t) => inExport.has(t.projectId));
    if (!here.length) continue;
    out.push(`### ${oneLine(umbrella.title)}`);
    if (umbrella.archivedAt || umbrella.status !== "open") out.push(`Status: ${umbrella.archivedAt ? "archived" : umbrella.status}`);
    if (umbrella.linearProject) out.push(`Linear: ${umbrella.linearProject.url}`);
    const brief = umbrella.brief.text.trim();
    if (briefs && brief) {
      const cut = brief.length > exportBriefLimit ? `${brief.slice(0, exportBriefLimit)}…` : brief;
      out.push("", ...cut.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : ">")), "");
    }
    out.push("Members:");
    for (const t of here) {
      const where = inExport.size > 1 ? `${projectTitle(t.projectId)}, ` : "";
      const archived = t.archivedAt ? ", archived" : "";
      const role = t.umbrella?.role ? `; role: ${oneLine(t.umbrella.role)}` : "";
      out.push(`- ${oneLine(t.title)} (${where}${t.status}, ${t.id}${archived}${role})`);
    }
    const elsewhere = members.filter((t) => !inExport.has(t.projectId));
    if (elsewhere.length) out.push("Members elsewhere:", ...elsewhere.map((t) => `- ${oneLine(t.title)} (${projectTitle(t.projectId)})`));
    out.push("");
  }
  return out.length ? ["## Umbrellas", "", ...out] : [];
}

/**
 * `board.projects` are the projects to export (live ones; callers pass the chosen subset). Options: `umbrellaBriefs`
 * (default true; false lists each umbrella's title and members only, for a dispatcher's first message) and
 * `allProjects` (every project, to name members in projects outside the export; default `board.projects`).
 */
export function exportMarkdown(
  board: Board,
  memory: Record<string, MemoryEntry[]>,
  options: { umbrellaBriefs?: boolean; allProjects?: readonly Pick<Project, "id" | "title">[] } = {},
): string {
  const out: string[] = [];
  const exported = board.projects.filter((p) => !p.archivedAt);
  for (const project of exported) {
    out.push(`## ${oneLine(project.title)}`, "");
    const cards = board.tasks.filter((t) => t.projectId === project.id && !t.archivedAt && t.status !== "done" && t.status !== "cancelled");
    if (cards.length) {
      out.push("### Open cards");
      for (const card of cards) {
        out.push(`- ${oneLine(card.title)} (${card.status}, ${card.id})`);
        const first = card.description.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first) out.push(`  ${first}`);
      }
      out.push("");
    }
    const ideas = board.ideas.filter((i) => i.projectId === project.id && i.status === "open");
    if (ideas.length) {
      out.push("### Ideas");
      for (const idea of ideas) out.push(...ideaLines(idea, idea.taskId ? board.tasks.find((t) => t.id === idea.taskId)?.title : undefined));
      out.push("");
    }
    const rules = (memory[project.id] ?? []).filter((e) => e.status === "active");
    if (rules.length) out.push("### Memory", ...rules.map(agentsRule), "");
  }
  out.push(...umbrellaSection(board, exported, options.allProjects ?? board.projects, options.umbrellaBriefs ?? true));
  return out.join("\n");
}
