import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { AgentCards } from "./agent-cards";
import { agentFixture } from "./agent-fixture";
import { toolFailure } from "./tool-error";
import { statuses, tagLimits } from "../shared/model";
import { agentCardLimits } from "../shared/tools";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

/** The agent fixture plus a Paseo that records workspace creations, and the card tools on top. */
async function setup() {
  const x = await agentFixture();
  roots.push(x.root);
  let now = Date.now(),
    on = true;
  const workspaces: { title: string; source: { kind: string; path?: string; projectId?: string } }[] = [];
  const paseo = {
    ...(x.paseo as unknown as Record<string, unknown>),
    workspaces: {
      ref: () => ({ refresh: async () => x.workspace() }),
      create: async (request: (typeof workspaces)[number]) => {
        workspaces.push(request);
        return { id: `created-${workspaces.length}` };
      },
    },
  } as unknown as PaseoApi;
  const cards = new AgentCards(x.store, () => now);
  cards.attach(paseo);
  cards.on = async () => on;
  const card = { agentId: "actor", projectId: "p", taskId: "t" },
    board = { agentId: "outside", projectId: "p" };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => toolFailure(e).code,
    );
  return {
    ...x,
    paseo,
    cards,
    card,
    board,
    workspaces,
    failure,
    advance: (ms: number) => {
      now += ms;
    },
    turn: (value: boolean) => {
      on = value;
    },
  };
}

test("a card session creates a card: own workspace, Backlog, agent attribution, follow-up link; the key replays it", async () => {
  const x = await setup();
  const made = await x.cards.create(x.card, {
    title: "Split part",
    description: "Do the split part.",
    priority: "high",
    type: "refactor",
    tags: ["Drawer", "perf"],
    idempotencyKey: "split-part",
  });
  expect(made.replayed).toBe(false);
  expect(made.card).toMatchObject({
    title: "Split part",
    description: "Do the split part.",
    status: "backlog",
    laneName: "Backlog",
    priority: "high",
    type: "refactor",
    tags: [
      { tag: "drawer", by: "agent" },
      { tag: "perf", by: "agent" },
    ],
    revision: 1,
    workspaceId: "created-1",
    links: [{ relation: "follow_up_of", taskId: "t", title: "Card" }],
  });
  expect(x.workspaces).toEqual([expect.objectContaining({ title: "Split part", source: { kind: "directory", path: x.a, projectId: "native" } })]);
  const stored = await x.store.read();
  const task = stored.tasks.find((t) => t.id === made.card.taskId)!;
  expect(task.tags).toEqual([
    expect.objectContaining({ tag: "drawer", by: "agent", agentId: "actor" }),
    expect.objectContaining({ tag: "perf", by: "agent", agentId: "actor" }),
  ]);
  expect(task.ownsWorkspace).toBe(true);
  expect(stored.events.filter((e) => e.taskId === task.id)).toEqual([expect.objectContaining({ action: "created", actor: "agent", agentId: "actor" })]);
  expect(stored.events.filter((e) => e.taskId === "t").at(-1)).toMatchObject({ action: "card_created", actor: "agent", agentId: "actor", note: "Split part" });
  expect(stored.links).toEqual([expect.objectContaining({ kind: "derived", from: task.id, to: "t", createdBy: "system" })]);
  // The same key returns the same card without a second workspace; a different card under it is refused.
  const again = await x.cards.create(x.card, { title: "Split part", idempotencyKey: "split-part" });
  expect(again).toMatchObject({ replayed: true, card: { taskId: task.id } });
  expect(await x.failure(x.cards.create(x.card, { title: "Another part", idempotencyKey: "split-part" }))).toBe("REQUEST_REUSED");
  expect(x.workspaces).toHaveLength(1);
  // The same key from another session is another card.
  const other = await x.cards.create({ ...x.card, agentId: "second" }, { title: "Split part", idempotencyKey: "split-part" });
  expect(other.card.taskId).not.toBe(task.id);
});

test("a session outside cards creates a plain card: no link and nothing on another card", async () => {
  const x = await setup();
  const made = await x.cards.create(x.board, { title: "Loose card", status: "todo", idempotencyKey: "loose" });
  expect(made.card).toMatchObject({ status: "todo", links: [], tags: [] });
  const stored = await x.store.read();
  expect(stored.links).toEqual([]);
  expect(stored.events.filter((e) => e.taskId === "t")).toEqual([]);
  expect(stored.events.find((e) => e.taskId === made.card.taskId)).toMatchObject({ actor: "agent", agentId: "outside", action: "created" });
});

test("create_card with workspace=worktree branches off the project's base", async () => {
  const x = await setup();
  execFileSync("git", ["-C", x.a, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", x.a, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const made = await x.cards.create(x.board, { title: "In a worktree", workspace: "worktree", idempotencyKey: "wt" });
  expect(x.workspaces).toEqual([
    expect.objectContaining({
      title: "In a worktree",
      source: expect.objectContaining({ kind: "worktree", cwd: x.a, projectId: "native", action: "branch-off", refName: "refs/heads/main", branchName: expect.stringMatching(/^kanban\/in-a-worktree-[0-9a-f]{6}$/) }),
    }),
  ]);
  expect((await x.store.read()).tasks.find((t) => t.id === made.card.taskId)!.ownsWorkspace).toBe(true);
  // The default stays a directory workspace.
  await x.cards.create(x.board, { title: "Plain", idempotencyKey: "plain" });
  expect(x.workspaces[1].source).toEqual({ kind: "directory", path: x.a, projectId: "native" });
  // A linked-root project has no worktree option; nothing is created.
  await x.store.mutate((board) => {
    board.projects[0].links = [{ name: "a", target: x.a }];
  });
  expect(await x.failure(x.cards.create(x.board, { title: "Linked", workspace: "worktree", idempotencyKey: "linked" }))).toBe("WORKTREE_UNAVAILABLE");
  expect(x.workspaces).toHaveLength(2);
});

test("create refusals come before any workspace: setting, lane, tags, hourly limit", async () => {
  const x = await setup();
  x.turn(false);
  expect(await x.failure(x.cards.create(x.card, { title: "A", idempotencyKey: "a" }))).toBe("AGENT_CARDS_DISABLED");
  x.turn(true);
  expect(await x.failure(x.cards.create(x.card, { title: "A", tags: ["bad tag!"], idempotencyKey: "a" }))).toBe("TAG_INVALID");
  expect(await x.failure(x.cards.create(x.card, { title: "A", tags: Array.from({ length: tagLimits.perTask + 1 }, (_, i) => `t${i}`), idempotencyKey: "a" }))).toBe("INVALID_INPUT");
  expect(await x.failure(x.cards.create(x.card, { title: "A", status: "development" as "todo", idempotencyKey: "a" }))).toBe("INVALID_STATUS");
  // Without a Backlog lane the default is Todo, and Backlog is refused.
  await x.store.mutate((board) => {
    board.projects[0].lanes = statuses.map((status) => ({ status, enabled: status !== "backlog" }));
  });
  expect(await x.failure(x.cards.create(x.card, { title: "A", status: "backlog", idempotencyKey: "a" }))).toBe("STATUS_UNAVAILABLE");
  expect(x.workspaces).toHaveLength(0);
  expect((await x.cards.create(x.card, { title: "A", idempotencyKey: "a" })).card.status).toBe("todo");
  for (let i = 1; i < agentCardLimits.perHour; i++) await x.cards.create(x.card, { title: `Card ${i}`, idempotencyKey: `k${i}` });
  expect(await x.failure(x.cards.create(x.card, { title: "One too many", idempotencyKey: "over" }))).toBe("CARD_LIMIT");
  // Replays still answer, other sessions are not limited, and the window moves on.
  expect((await x.cards.create(x.card, { title: "A", idempotencyKey: "a" })).replayed).toBe(true);
  await x.cards.create(x.board, { title: "Someone else", idempotencyKey: "else" });
  x.advance(3600001);
  expect((await x.cards.create(x.card, { title: "Next hour", idempotencyKey: "later" })).replayed).toBe(false);
  // An archived project takes no new cards.
  await x.store.mutate((board) => {
    board.projects[0].archivedAt = new Date().toISOString();
  });
  expect(await x.failure(x.cards.create(x.board, { title: "Archived", idempotencyKey: "arch" }))).toBe("ARCHIVED");
});

test("update edits fields under the card's revision and records the agent", async () => {
  const x = await setup();
  const updated = await x.cards.update(x.board, {
    taskId: "t",
    revision: 1,
    title: "Renamed",
    description: "New text",
    priority: "urgent",
    type: "bugfix",
  });
  expect(updated.changed).toEqual(["title", "description", "priority", "type"]);
  expect(updated.card).toMatchObject({ title: "Renamed", description: "New text", priority: "urgent", type: "bugfix", revision: 2 });
  const events = (await x.store.read()).events.filter((e) => e.taskId === "t");
  expect(events.at(-1)).toMatchObject({ action: "edited", actor: "agent", agentId: "outside", note: "Changed title, description, priority, type" });
  // A stale revision changes nothing; the same values are no change at all.
  expect(await x.failure(x.cards.update(x.board, { taskId: "t", revision: 1, title: "Stale" }))).toBe("REVISION_CONFLICT");
  const same = await x.cards.update(x.board, { taskId: "t", revision: 2, title: "Renamed" });
  expect(same).toMatchObject({ changed: [], card: { revision: 2 } });
  expect(await x.failure(x.cards.update(x.board, { taskId: "t", revision: 2 }))).toBe("INVALID_INPUT");
  x.turn(false);
  expect(await x.failure(x.cards.update(x.board, { taskId: "t", revision: 2, title: "Off" }))).toBe("AGENT_CARDS_DISABLED");
});

test("update moves only between Backlog and Todo and never touches finished, archived or other projects' cards", async () => {
  const x = await setup();
  const moved = await x.cards.update(x.card, { taskId: "t", revision: 1, status: "backlog" });
  expect(moved).toMatchObject({ changed: ["status"], card: { status: "backlog", revision: 2 } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "status_changed", from: "todo", to: "backlog", actor: "agent" });
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 2, status: "development" as "todo" }))).toBe("INVALID_STATUS");
  await x.store.mutate((board) => {
    board.tasks[0].status = "development";
    board.tasks[0].revision = 3;
    board.projects.push({ ...board.projects[0], id: "q", paseoProjectId: "other" });
    board.tasks.push({ ...board.tasks[0], id: "other", projectId: "q", workspaceId: "w9", operationId: "o", revision: 1 });
  });
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 3, status: "todo" }))).toBe("STATUS_FORBIDDEN");
  // Other fields of a card in a work stage can still change.
  expect((await x.cards.update(x.card, { taskId: "t", revision: 3, priority: "low" })).card.revision).toBe(4);
  expect(await x.failure(x.cards.update(x.card, { taskId: "other", revision: 1, title: "Other" }))).toBe("CARD_NOT_FOUND");
  await x.store.mutate((board) => {
    board.tasks[0].status = "done";
  });
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 4, title: "Done" }))).toBe("TASK_FINISHED");
  await x.store.mutate((board) => {
    board.tasks[0].status = "todo";
    board.tasks[0].archivedAt = new Date().toISOString();
  });
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 4, title: "Archived" }))).toBe("ARCHIVED");
});

test("update tags: agents add tags and remove only agent tags", async () => {
  const x = await setup();
  const added = await x.cards.update(x.card, { taskId: "t", revision: 1, addTags: ["api"] });
  expect(added).toMatchObject({ changed: ["tags"], card: { revision: 2, tags: [{ tag: "fixture", by: "human" }, { tag: "api", by: "agent" }] } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "tags_changed", actor: "agent", note: "+api" });
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 2, removeTags: ["fixture"] }))).toBe("TAG_FORBIDDEN");
  expect(await x.failure(x.cards.update(x.card, { taskId: "t", revision: 2, addTags: Array.from({ length: tagLimits.perTask - 1 }, (_, i) => `t${i}`) }))).toBe("TAG_INVALID");
  const removed = await x.cards.update(x.card, { taskId: "t", revision: 2, removeTags: ["api"] });
  expect(removed.card.tags).toEqual([{ tag: "fixture", by: "human" }]);
});

test("list and get: this project only, filters, previews and the full card", async () => {
  const x = await setup();
  const long = "x".repeat(agentCardLimits.preview + 20);
  await x.store.mutate((board) => {
    const base = board.tasks[0];
    board.tasks.push({ ...base, id: "b", workspaceId: "wb", operationId: "b", title: "Backlog card", description: long, status: "backlog", position: 0 });
    board.tasks.push({ ...base, id: "gone", workspaceId: "wg", operationId: "g", title: "Archived card", archivedAt: new Date().toISOString() });
    board.projects.push({ ...board.projects[0], id: "q", paseoProjectId: "other" });
    board.tasks.push({ ...base, id: "other", projectId: "q", workspaceId: "wo", operationId: "o", title: "Other project card" });
  });
  const all = await x.cards.list(x.board, {});
  expect(all.project).toEqual({ id: "p", title: "Project" });
  expect(all.cards.map((c) => c.taskId)).toEqual(["b", "t"]);
  expect(all.cards[0]).toMatchObject({ laneName: "Backlog", descriptionTruncated: true, revision: 1 });
  expect(all.cards[0].description).toHaveLength(agentCardLimits.preview);
  expect(all.lanes.map((l) => l.status)).toContain("backlog");
  expect((await x.cards.list(x.board, { status: ["todo"] })).cards.map((c) => c.taskId)).toEqual(["t"]);
  expect((await x.cards.list(x.board, { query: "BACKLOG card" })).cards.map((c) => c.taskId)).toEqual(["b"]);
  expect((await x.cards.list(x.board, { query: "fixture" })).cards.map((c) => c.taskId)).toEqual(["b", "t"]);
  expect((await x.cards.list(x.board, { includeArchived: true })).cards.map((c) => c.taskId)).toContain("gone");
  expect(await x.cards.list(x.board, { limit: 1 })).toMatchObject({ truncated: true, cards: [{ taskId: "b" }] });
  expect(await x.cards.get(x.board, { taskId: "b" })).toMatchObject({ card: { description: long }, editable: true, reason: "" });
  expect(await x.cards.get(x.board, { taskId: "gone" })).toMatchObject({ editable: false, reason: "The card is archived." });
  expect(await x.failure(x.cards.get(x.board, { taskId: "other" }))).toBe("CARD_NOT_FOUND");
});

test("a card session's caller is its card and project", async () => {
  const x = await setup();
  expect(await x.service.cardCaller(x.identity)).toEqual({ agentId: "actor", projectId: "p", taskId: "t" });
  expect(await x.failure(x.service.cardCaller({ ...x.identity, agentId: "wrong" }))).toBe("SESSION_MISMATCH");
});

test("sessions outside cards: who gets the tools, and every call checks the session, workspace and project again", async () => {
  const x = await setup();
  const open = { agentId: "outside", workspaceId: "w" };
  // The fixture workspace belongs to another native project.
  expect(await x.cards.boardSession(open, false)).toBeNull();
  x.setWorkspace({ ...x.workspace(), projectId: "native" });
  expect(await x.cards.boardSession(open, false)).toEqual({ agentId: "outside", workspaceId: "w", projectId: "p" });
  expect(await x.cards.boardSession(open, true)).toBeNull();
  expect(await x.cards.boardSession({ ...open, workspaceId: null }, false)).toBeNull();
  expect(await x.cards.boardSession({ ...open, labels: { flowly: "summarizer" } }, false)).toBeNull();
  x.turn(false);
  expect(await x.cards.boardSession(open, false)).toBeNull();
  expect(await x.failure(x.cards.boardCaller({ agentId: "actor", workspaceId: "w", projectId: "p" }))).toBe("AGENT_CARDS_DISABLED");
  x.turn(true);
  expect(await x.cards.boardCaller({ agentId: "actor", workspaceId: "w", projectId: "p" })).toEqual({ agentId: "actor", projectId: "p" });
  expect(await x.failure(x.cards.boardCaller({ agentId: "wrong", workspaceId: "w", projectId: "p" }))).toBe("SESSION_MISMATCH");
  expect(await x.failure(x.cards.boardCaller({ agentId: "missing", workspaceId: "w", projectId: "p" }))).toBe("SESSION_MISMATCH");
  x.setWorkspace({ ...x.workspace(), projectId: "elsewhere" });
  expect(await x.failure(x.cards.boardCaller({ agentId: "actor", workspaceId: "w", projectId: "p" }))).toBe("SESSION_MISMATCH");
  x.setWorkspace({ ...x.workspace(), projectId: "native" });
  await x.store.mutate((board) => {
    board.projects[0].archivedAt = new Date().toISOString();
  });
  expect(await x.failure(x.cards.boardCaller({ agentId: "actor", workspaceId: "w", projectId: "p" }))).toBe("ARCHIVED");
  expect(await x.cards.boardSession(open, false)).toBeNull();
  x.setWorkspace(null);
  expect(await x.cards.boardSession(open, false)).toBeNull();
});
