import { rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { ProjectIdeas } from "./project-ideas";
import { adoptIdea } from "./ideas";
import { boardOverview } from "./board-overview";
import type { ImportRow } from "../shared/ideas-import";
import { ToolError } from "./tool-error";
import { projectIdeaInputSchema } from "../shared/tools";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  return { ...f, ideas: new ProjectIdeas(f.store) };
}
const input = (title: string, extra: Record<string, unknown> = {}) =>
  projectIdeaInputSchema.parse({ title, detail: "Do the thing", rationale: "Because", ...extra });
const human = { actor: "human" } as const;
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => (e instanceof ToolError ? e.code : String(e)),
  );

test("a project idea is stored without a card and listed for its project", async () => {
  const x = await setup();
  const idea = await x.ideas.propose("p", input("Retry the upload", { source: "BACKLOG.md:12" }), { actor: "agent", agentId: "second" });
  expect(idea.taskId).toBeUndefined();
  expect(idea.eventId).toBeUndefined();
  expect(idea).toMatchObject({ projectId: "p", agentId: "second", status: "open", source: "BACKLOG.md:12", title: "Retry the upload" });
  expect((await x.ideas.list("p")).map((i) => i.id)).toEqual([idea.id]);
  expect(await x.ideas.list("other")).toEqual([]);
  // No board event: events need a card.
  expect((await x.store.read()).events).toEqual([]);
});

test("a card's own ideas are not project ideas", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.ideas.push({ id: "c1", taskId: "t", projectId: "p", agentId: "actor", eventId: "e", title: "Card idea", detail: "", rationale: "", context: "", status: "open", createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z" });
  });
  expect(await x.ideas.list("p")).toEqual([]);
  // Same title as a card idea is not a duplicate.
  expect((await x.ideas.propose("p", input("Card idea"), human)).taskId).toBeUndefined();
});

test("project ideas have no open cap", async () => {
  const x = await setup();
  for (let i = 0; i < 60; i++) await x.ideas.propose("p", input(`Idea ${i}`), human);
  expect(await x.ideas.list("p")).toHaveLength(60);
});

test("a duplicate open project idea title is refused", async () => {
  const x = await setup();
  const first = await x.ideas.propose("p", input("Same title"), human);
  expect(await failure(x.ideas.propose("p", input("  SAME title "), human))).toBe("DUPLICATE_IDEA");
  // A dismissed one no longer blocks it.
  await x.store.updateIdea({ id: first.id, status: "dismissed" });
  await x.ideas.propose("p", input("Same title"), human);
  expect(await x.ideas.list("p")).toHaveLength(2);
});

test("an archived project refuses project ideas", async () => {
  const x = await setup();
  const idea = await x.ideas.propose("p", input("Before archive"), human);
  await x.store.mutate((board) => {
    board.projects[0].archivedAt = "2026-11-08T00:00:00.000Z";
  });
  expect(await failure(x.ideas.propose("p", input("After archive"), human))).toBe("PROJECT_ARCHIVED");
  await expect(x.store.updateIdea({ id: idea.id, status: "dismissed" })).rejects.toThrow("archived");
  expect(await failure(x.ideas.propose("missing", input("Nowhere"), human))).toBe("NOT_FOUND");
});

test("dismissing a project idea works without a card", async () => {
  const x = await setup();
  const idea = await x.ideas.propose("p", input("Dismiss me"), human);
  const before = (await x.store.read()).events.length;
  expect((await x.store.updateIdea({ id: idea.id, status: "dismissed" })).status).toBe("dismissed");
  expect((await x.ideas.list("p"))[0].status).toBe("dismissed");
  expect((await x.store.updateIdea({ id: idea.id, status: "open" })).status).toBe("open");
  expect((await x.store.read()).events).toHaveLength(before);
  // Restoring refuses a title that another open project idea took meanwhile.
  await x.store.updateIdea({ id: idea.id, status: "dismissed" });
  await x.ideas.propose("p", input("Dismiss me"), human);
  await expect(x.store.updateIdea({ id: idea.id, status: "open" })).rejects.toThrow("open idea with that title");
});

test("creating a card from a project idea accepts it with no derived link", async () => {
  const x = await setup();
  const idea = await x.ideas.propose("p", input("Make it a card"), human);
  const before = await x.store.read();
  const paseo = { workspaces: { create: vi.fn(async () => ({ id: "new-ws" })) } } as unknown as PaseoApi;
  const task = await new BoardService(x.store).createTask(
    {
      projectId: "p", operationId: "op-from-project-idea", title: "Make it a card", description: "", status: "todo",
      priority: "normal", mode: "directory", baseRef: "", ideaId: idea.id,
    },
    paseo,
  );
  const board = await x.store.read();
  const stored = board.ideas.find((i) => i.id === idea.id)!;
  expect(stored).toMatchObject({ status: "accepted", acceptedTaskId: task.id });
  expect(task.origin).toEqual({ ideaId: idea.id });
  expect(board.links).toEqual(before.links);
  expect(board.events.filter((e) => e.action === "idea_accepted")).toEqual([]);
  // An accepted idea is final.
  await expect(x.store.updateIdea({ id: idea.id, status: "dismissed" })).rejects.toThrow("already became a card");
});

test("a project's delete takes its project ideas with it", async () => {
  const x = await setup();
  await x.ideas.propose("p", input("Gone with the project"), human);
  await x.store.removeProject({ id: "p", revision: 1 } as never);
  expect((await x.store.read()).ideas).toEqual([]);
});

const importRow = (line: number, title: string, extra: Partial<ImportRow> = {}): ImportRow => ({ line, title, detail: "", source: null, done: false, keep: true, ...extra });

test("import creates exactly the kept rows and replays by operationId", async () => {
  const x = await setup();
  const rows = [
    importRow(3, "Kept one", { detail: "- a note", source: "added 2026-10-20, a-branch" }),
    importRow(4, "Unchecked in review", { keep: false }),
    importRow(5, "Shipped", { done: true, keep: false }),
    importRow(6, "Kept two"),
  ];
  const first = await x.ideas.import("p", rows, "op-1");
  expect(first).toEqual({ created: 2, skipped: [] });
  const stored = await x.ideas.list("p");
  expect(stored.map((i) => i.title)).toEqual(["Kept one", "Kept two"]);
  expect(stored[0]).toMatchObject({ detail: "- a note", source: "added 2026-10-20, a-branch", status: "open", rationale: "", context: "" });
  expect(stored[0]!.taskId).toBeUndefined();
  expect(stored[0]!.agentId).toBeUndefined();
  expect((await x.store.read()).events).toEqual([]);
  // A retry with the same operationId returns the first result and creates nothing.
  expect(await x.ideas.import("p", rows, "op-1")).toEqual(first);
  expect(await x.ideas.list("p")).toHaveLength(2);
  // Another operationId is a new import: the same titles are now duplicates.
  expect(await x.ideas.import("p", rows, "op-2")).toEqual({
    created: 0,
    skipped: [{ line: 3, reason: "Already an open idea in this project." }, { line: 6, reason: "Already an open idea in this project." }],
  });
});

test("import skips duplicates, repeats inside the paste and bad rows without failing the rest", async () => {
  const x = await setup();
  await x.ideas.propose("p", input("Already here"), human);
  const result = await x.ideas.import(
    "p",
    [importRow(1, "already HERE"), importRow(2, "Fresh"), importRow(3, "fresh "), importRow(4, "A", { source: "x".repeat(1001) })],
    "op-dup",
  );
  expect(result.created).toBe(1);
  expect(result.skipped.map((s) => s.line)).toEqual([1, 3, 4]);
  expect((await x.ideas.list("p")).map((i) => i.title)).toEqual(["Already here", "Fresh"]);
});

test("import into an archived or unknown project writes nothing", async () => {
  const x = await setup();
  expect(await failure(x.ideas.import("missing", [importRow(1, "A")], "op-a"))).toBe("NOT_FOUND");
  await x.store.mutate((board) => {
    board.projects[0].archivedAt = "2026-11-08T00:00:00.000Z";
  });
  expect(await failure(x.ideas.import("p", [importRow(1, "A")], "op-b"))).toBe("PROJECT_ARCHIVED");
  expect(await x.ideas.list("p")).toEqual([]);
});

test("the same operationId in another project is a different import", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects.push({ ...structuredClone(board.projects[0]!), id: "q", title: "Second", paseoProjectId: "native-q" });
  });
  const rows = [importRow(1, "Shared title")];
  expect(await x.ideas.import("p", rows, "same-op")).toEqual({ created: 1, skipped: [] });
  expect(await x.ideas.import("q", rows, "same-op")).toEqual({ created: 1, skipped: [] });
  expect(await x.ideas.import("p", rows, "same-op")).toEqual({ created: 1, skipped: [] });
  expect((await x.ideas.list("q")).map((i) => i.title)).toEqual(["Shared title"]);
});

test("the preview lists rows and flags titles that match an open project idea", async () => {
  const x = await setup();
  await x.ideas.propose("p", input("Fix the upload"), human);
  const dismissed = await x.ideas.propose("p", input("Old thing"), human);
  await x.store.updateIdea({ id: dismissed.id, status: "dismissed" });
  const preview = await x.ideas.preview("p", "# b\n\n- [ ] fix the UPLOAD (added 2026-10-20)\n- [ ] Old thing\n- [x] Done thing\n");
  expect(preview.rows.map((r) => r.title)).toEqual(["fix the UPLOAD", "Old thing", "Done thing"]);
  expect(preview.duplicates).toEqual([0]);
  expect(await failure(x.ideas.preview("missing", ""))).toBe("NOT_FOUND");
  // A title repeated inside the paste is flagged from its second occurrence on (case-insensitive).
  const repeated = await x.ideas.preview("p", "- [ ] Brand new\n- [ ] other\n- [ ] BRAND new (added 2026-10-20)\n- [ ] Brand New\n");
  expect(repeated.duplicates).toEqual([2, 3]);
});

test("a project idea cannot be continued in a card", async () => {
  const x = await setup();
  const idea = await x.ideas.propose("p", input("No card for me"), human);
  const push = vi.fn(async () => ({}));
  await expect(adoptIdea(x.store, push, { id: idea.id, agentId: "second" }, x.paseo)).rejects.toThrow("A project idea has no card to continue in.");
  expect((await x.store.read()).ideas.find((i) => i.id === idea.id)!.status).toBe("open");
  expect(push).not.toHaveBeenCalled();
});

test("the board overview's per-project Ideas count includes open project ideas", async () => {
  const x = await setup();
  await x.ideas.propose("p", input("One"), human);
  const dismissed = await x.ideas.propose("p", input("Two"), human);
  await x.store.updateIdea({ id: dismissed.id, status: "dismissed" });
  await x.ideas.propose("p", input("Three"), human);
  const view = boardOverview(await x.store.read());
  expect(view.projectIdeas.find((c) => c.projectId === "p")).toEqual({ projectId: "p", open: 2 });
  // A project with none still has an entry, so the client never guesses.
  expect(view.projectIdeas).toHaveLength(view.projects.length);
});
