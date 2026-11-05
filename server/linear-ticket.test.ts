import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("the project setting is saved and the first-session context follows it (LINEAR-TICKET-SPEC §1, §2)", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  const context = async () => (await new BoardService(x.store).context("t", x.paseo)).context;
  expect(await context()).not.toContain("Linear ticket:");

  const on = await x.store.updateProject({ id: "p", revision: 1, linearTicket: true, linearTeam: "  Platform\nEng " });
  expect(on).toMatchObject({ linearTicket: true, linearTeam: "Platform Eng" });
  expect(await context()).toContain('Linear ticket: this project wants every card tracked');
  expect(await context()).toContain('Linear team "Platform Eng"');

  // An empty team removes it; the switch stays on.
  const cleared = await x.store.updateProject({ id: "p", revision: 2, linearTeam: "" });
  expect(cleared.linearTicket).toBe(true);
  expect("linearTeam" in cleared).toBe(false);
  expect(await context()).toContain("ask the user once");

  // A linked Linear issue removes the block.
  await x.store.mutate((board) => {
    board.artifacts.push({
      id: "a1",
      taskId: "t",
      projectId: "p",
      role: "input",
      kind: "url",
      target: "https://linear.app/chord/issue/ENG-7/fix",
      title: "ENG-7",
      note: "",
      createdBy: "agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  });
  expect(await context()).not.toContain("Linear ticket:");

  // Off keeps the team for next time.
  const off = await x.store.updateProject({ id: "p", revision: 3, linearTicket: false, linearTeam: "ENG" });
  expect(off).toMatchObject({ linearTicket: false, linearTeam: "ENG" });
});
