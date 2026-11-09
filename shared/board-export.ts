import { agentsRule, type MemoryEntry } from "./memory";
import { isSourceNote, parseBacklog } from "./ideas-import";
import type { Board, Idea } from "./model";

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

export function exportMarkdown(board: Board, memory: Record<string, MemoryEntry[]>): string {
  const out: string[] = [];
  for (const project of board.projects.filter((p) => !p.archivedAt)) {
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
  return out.join("\n");
}
