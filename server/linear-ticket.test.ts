import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { putArtifact } from "./artifacts";

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
  // Agent artifacts off: no link step; later sessions look for the card's title instead.
  const unlinkable = (await new BoardService(x.store).context("t", x.paseo, undefined, { artifactsOn: false })).context;
  expect(unlinkable).toContain("Linear ticket:");
  expect(unlinkable).not.toContain("flowly_add_artifact");
  expect(unlinkable).toContain("starting with its title");

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

test("a card started from a Linear issue (Start card, LINEAR-BOARD-SPEC §5) never gets the ticket block", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.updateProject({ id: "p", revision: 1, linearTicket: true });
  const context = async () => (await new BoardService(x.store).context("t", x.paseo)).context;
  expect(await context()).toContain("Linear ticket:");
  // The input `tasks.create` writes for an attached Linear item: a connector item, even behind a custom domain.
  await x.store.mutate((board) => {
    putArtifact(
      x.store,
      board,
      {
        taskId: "t",
        role: "input",
        kind: "url",
        target: "https://tracker.example.com/ENG-42",
        title: "Login retry loops",
        createdBy: "human",
        external: { connectionId: "c1", provider: "linear", key: "ENG-42", remoteId: "uuid-eng-42", itemType: "issue" },
      },
      new Date().toISOString(),
    );
  });
  expect(await context()).not.toContain("Linear ticket:");
});

test("a card can opt out of the project's Linear ticket ask; others keep it (LINEAR-TICKET-SPEC §5)", async () => {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.updateProject({ id: "p", revision: 1, linearTicket: true });
  await x.store.mutate((board) => {
    const first = board.tasks.find((t) => t.id === "t")!;
    board.tasks.push({ ...structuredClone(first), id: "t2", title: "Second", operationId: "op-t2", workspaceId: "ws-t2" });
  });
  const context = async (id: string) => (await new BoardService(x.store).context(id, x.paseo)).context;
  const revision = async () => (await x.store.read()).tasks.find((t) => t.id === "t")!.revision;
  const stored = async () => (await x.store.read()).tasks.find((t) => t.id === "t")!;

  await x.store.editTask({ id: "t", revision: await revision(), linearTicket: false, actor: "human" });
  expect((await stored()).linearTicket).toBe(false);
  expect(await context("t")).not.toContain("Linear ticket:");
  expect(await context("t2")).toContain("Linear ticket:");

  await x.store.editTask({ id: "t", revision: await revision(), linearTicket: true, actor: "human" });
  expect("linearTicket" in (await stored())).toBe(false);
  expect(await context("t")).toContain("Linear ticket:");
});
