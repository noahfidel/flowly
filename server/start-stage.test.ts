import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { moveStartedCard } from "./start-stage";
import { startedStatus } from "../shared/lanes";
import type { Status } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

// The board's own starts (drawer, New task, quick task) reach the server through prepareSession, which calls this.
test.each([
  ["backlog", "development"],
  ["todo", "development"],
  ["development", null],
  ["design", null],
  ["in_review", null],
  ["blocked", null],
  ["done", null],
  ["cancelled", null],
] as [Status, Status | null][])("starting a card in %s gives %s", async (from, to) => {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((b) => {
    b.tasks[0].status = from;
  });
  expect(await moveStartedCard(x.store, "t")).toBe(to);
  const board = await x.store.read();
  expect(board.tasks[0].status).toBe(to ?? from);
  expect(board.events.filter((e) => e.action === "status_changed").length).toBe(to ? 1 : 0);
});

test("an archived card does not move", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((b) => {
    b.tasks[0].status = "backlog";
    b.tasks[0].archivedAt = new Date().toISOString();
  });
  expect(await moveStartedCard(x.store, "t")).toBeNull();
});

test("the target lane is chosen by role and is null when the workflow has no work lane", () => {
  const lanes = (on: Status[]) => ({ lanes: (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as Status[]).map((status) => ({ status, enabled: on.includes(status) })) });
  expect(startedStatus(lanes(["todo", "development", "done"]), "todo")).toBe("development");
  expect(startedStatus(lanes(["backlog", "design", "test", "done"]), "backlog")).toBe("design");
  expect(startedStatus(lanes(["backlog", "done"]), "backlog")).toBeNull();
});
