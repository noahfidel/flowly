import { rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { ProjectIdeas } from "./project-ideas";
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
