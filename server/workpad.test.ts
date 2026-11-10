import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { WorkpadService } from "./workpad";
import { workpadCheck, type Workpad } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup(withPad = true) {
  const f = await agentFixture({ workpad: false });
  roots.push(f.root);
  const service = new WorkpadService(f.store, () => Date.parse("2026-10-19T00:00:00.000Z"));
  if (withPad)
    await f.store.mutate((board) => {
      const pad: Workpad = {
        taskId: "t",
        projectId: "p",
        revision: 1,
        acceptance: [{ id: "a", text: "Shows checks", done: false, by: "agent", at: "2026-10-18T00:00:00.000Z" }],
        updatedAt: "2026-10-18T00:00:00.000Z",
        updatedBy: "agent",
        agentId: "actor",
      };
      board.workpads.push(pad);
    });
  return { ...f, service };
}

test("a person ticks acceptance criteria; the task revision never moves; archived cards refuse edits", async () => {
  const x = await setup();
  const before = (await x.store.read()).tasks[0]!.revision;
  const ticked = await x.service.check({ taskId: "t", section: "acceptance", itemId: "a", done: true });
  expect(ticked.revision).toBe(2);
  expect(ticked.updatedBy).toBe("human");
  expect(ticked.acceptance[0]).toMatchObject({ done: true, by: "human" });
  const board = await x.store.read();
  expect(board.tasks[0]!.revision).toBe(before);
  expect(board.events.filter((e) => e.action === "workpad_checked").map((e) => e.note)).toEqual(["Acceptance: Shows checks → met"]);
  await expect(x.service.check({ taskId: "t", section: "acceptance", itemId: "gone", done: true })).rejects.toThrow("no longer in the workpad");
  await x.store.mutate((board) => {
    board.tasks[0]!.archivedAt = "2026-10-19T00:00:00.000Z";
  });
  await expect(x.service.check({ taskId: "t", section: "acceptance", itemId: "a", done: true })).rejects.toThrow("Archived cards can't be changed.");
});

test("workpads.check takes only acceptance ticks (GUARDRAILS-SPEC §7.5)", () => {
  expect(workpadCheck.parse({ taskId: "t", itemId: "a", done: true })).toEqual({ taskId: "t", section: "acceptance", itemId: "a", done: true });
  expect(workpadCheck.safeParse({ taskId: "t", section: "validation", itemId: "unit", state: "pass" }).success).toBe(false);
  expect(workpadCheck.safeParse({ taskId: "t", section: "acceptance", itemId: "a", done: true, state: "pass" }).success).toBe(false);
});

test("turn end: the last todo list becomes the session's plan; none keeps it; empty clears it", async () => {
  const x = await setup(false);
  const todo = (items: { text: string; completed: boolean }[]) => [{ type: "todo", items } as { type: string }];
  await x.service.recordTurn(x.identity, todo([{ text: "Spec", completed: true }, { text: "Build", completed: false }]));
  await x.service.recordTurn({ ...x.identity, agentId: "second" }, todo([{ text: "Verify", completed: false }]));
  let plans = (await x.store.read()).plans;
  expect(plans.map((p) => [p.agentId, p.items.map((i) => `${i.text}:${i.status}`)])).toEqual([
    ["actor", ["Spec:completed", "Build:pending"]],
    ["second", ["Verify:pending"]],
  ]);
  const revision = (await x.store.read()).revision;
  await x.service.recordTurn(x.identity, [{ type: "assistant_message" }]);
  expect((await x.store.read()).revision).toBe(revision);
  await x.service.recordTurn(x.identity, todo([]));
  plans = (await x.store.read()).plans;
  expect(plans.map((p) => p.agentId)).toEqual(["second"]);
  // A session of another workspace never writes a plan here.
  await x.service.recordTurn({ ...x.identity, workspaceId: "other" }, todo([{ text: "X", completed: false }]));
  expect((await x.store.read()).plans).toHaveLength(1);
});

test("deleting a card removes its workpad and plans with it, into the backup", async () => {
  const x = await setup();
  await x.service.recordTurn(x.identity, [{ type: "todo", items: [{ text: "A", completed: false }] } as { type: string }]);
  const deleted = await x.store.deleteTask({ id: "t", revision: (await x.store.read()).tasks[0]!.revision });
  const board = await x.store.read();
  expect(board.workpads).toEqual([]);
  expect(board.plans).toEqual([]);
  const { readFile } = await import("node:fs/promises");
  const backup = JSON.parse(await readFile(deleted.backup, "utf8"));
  expect(backup.workpads).toHaveLength(1);
  expect(backup.plans).toHaveLength(1);
});

test("off for the project: no plan recorded, people's edits refused", async () => {
  const x = await setup();
  await x.store.updateProject({ id: "p", revision: 1, workpad: false });
  await x.service.recordTurn(x.identity, [{ type: "todo", items: [{ text: "A", completed: false }] } as { type: string }]);
  expect((await x.store.read()).plans).toEqual([]);
  await expect(x.service.check({ taskId: "t", section: "acceptance", itemId: "a", done: true })).rejects.toThrow("turned off");
});
