import { describe, expect, test } from "vitest";
import { exportMarkdown } from "./board-export";
import { parseBacklog } from "./ideas-import";
import type { Board, Idea, Project, Task } from "./model";
import { emptyBoard } from "./model";
import type { MemoryEntry } from "./memory";

const at = "2026-11-08T10:00:00.000Z";
const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  title: "Recipes",
  description: "",
  paseoProjectId: "pp",
  primaryPath: "/tmp/r",
  repos: ["/tmp/r"],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...over,
});
const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
  workspaceId: "w1",
  sourcePath: "/tmp/r",
  repoPaths: ["/tmp/r"],
  title: "Scale quantities",
  description: "",
  status: "todo",
  priority: "normal",
  position: 1,
  revision: 1,
  operationId: "op",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...over,
});
const idea = (over: Partial<Idea> = {}): Idea => ({
  id: "i1",
  projectId: "p1",
  title: "Offline mode",
  detail: "",
  rationale: "",
  context: "",
  status: "open",
  createdAt: at,
  updatedAt: at,
  ...over,
});
const memory = (over: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({
    id: "m1",
    projectId: "p1",
    kind: "convention",
    title: "Use pnpm",
    body: "Never npm.",
    status: "active",
    tags: [],
    keywords: [],
    source: { by: "human" },
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...over,
  }) as MemoryEntry;
const board = (over: Partial<Board>): Board => ({ ...emptyBoard(), ...over });

describe("exportMarkdown", () => {
  test("export lists open cards, open ideas and active memory per project", () => {
    const md = exportMarkdown(
      board({
        projects: [project(), project({ id: "p2", title: "Planner" })],
        tasks: [task({ description: "\n\nFirst line\nsecond line" }), task({ id: "t2", projectId: "p2", title: "Other", status: "design" })],
        ideas: [
          idea({ source: "added 2026-10-20, a-branch", detail: "- note one\nplain line" }),
          idea({ id: "i2", taskId: "t1", title: "From a card" }),
        ],
      }),
      { p1: [memory()] },
    );
    expect(md).toContain("## Recipes\n");
    expect(md).toContain("### Open cards\n- [ ] Scale quantities (todo, t1)\n  First line\n");
    expect(md).toContain("### Ideas\n- [ ] Offline mode (added 2026-10-20, a-branch)\n  - note one\n  - plain line\n");
    expect(md).toContain("- [ ] From a card (added 2026-11-08, Scale quantities)");
    expect(md).toContain("### Memory\n- Use pnpm: Never npm.\n");
    expect(md).toContain("## Planner\n\n### Open cards\n- [ ] Other (design, t2)\n");
    expect(md.indexOf("## Recipes")).toBeLessThan(md.indexOf("## Planner"));
  });

  test("done cards, dismissed ideas and candidate memory are left out", () => {
    const md = exportMarkdown(
      board({
        projects: [project(), project({ id: "p9", title: "Old", archivedAt: at })],
        tasks: [
          task({ id: "a", title: "Shipped", status: "done" }),
          task({ id: "b", title: "Dropped", status: "cancelled" }),
          task({ id: "c", title: "Hidden", archivedAt: at }),
        ],
        ideas: [idea({ title: "Nope", status: "dismissed" }), idea({ id: "i2", title: "Took", status: "accepted" })],
      }),
      { p1: [memory({ title: "Maybe", status: "candidate" }), memory({ id: "m3", title: "Gone", status: "archived" })] },
    );
    for (const word of ["Shipped", "Dropped", "Hidden", "Nope", "Took", "Maybe", "Gone", "Old"]) expect(md).not.toContain(word);
    expect(md).not.toContain("###");
    expect(md).toContain("## Recipes");
  });

  test("exported ideas re-import to the same titles", () => {
    const ideas = [
      idea({ title: "Plain one", source: "added 2026-10-20, kanban/fix-x", detail: "- first\n- second" }),
      idea({ id: "i2", title: "Has (own) parens: and colon", source: "started 2026-10-21; added 2026-10-20, branch" }),
      idea({ id: "i3", taskId: "t1", title: "Card note" }),
      idea({ id: "i4", title: "Free-text source", source: "Cart review (round 2" }),
      idea({ id: "i5", title: "Bare" }),
      idea({ id: "i6", title: "Multi\nline title", detail: "loose line" }),
    ];
    const md = exportMarkdown(board({ projects: [project()], tasks: [task({ title: "Scale quantities" })], ideas }), {});
    const rows = parseBacklog(md.split("### Ideas")[1]!);
    expect(rows.map((r) => r.title)).toEqual(["Plain one", "Has (own) parens: and colon", "Card note", "Free-text source", "Bare", "Multi line title"]);
    expect(rows[0]!.detail).toBe("- first\n- second");
    expect(rows[0]!.source).toBe("added 2026-10-20, kanban/fix-x");
    expect(rows[2]!.source).toBe("added 2026-11-08, Scale quantities");
    expect(rows[5]!.detail).toBe("- loose line");
    expect(rows.every((r) => r.keep)).toBe(true);
  });
});
