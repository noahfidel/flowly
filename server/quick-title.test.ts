import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { QuickTitleService, type QuickTitleModel } from "./quick-title";
import { BackgroundWorkspaces } from "./background-workspace";
import type { QuickTitle } from "../shared/quick-task";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const paseo = {} as PaseoApi;
async function setup(reply: QuickTitle | Error, hold?: Promise<void>) {
  // The quick-task card: no type, no tags, provisional title.
  const f = await agentFixture({ type: false, tags: false });
  roots.push(f.root);
  await f.store.mutate((board) => {
    board.tasks[0].title = "Fix the login bug";
  });
  const prompts: string[] = [];
  const model: QuickTitleModel = async (_project, prompt) => {
    prompts.push(prompt);
    if (hold) await hold;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const service = new QuickTitleService(f.store, async () => ({ summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true }), async () => "en", { model });
  return { ...f, service, prompts };
}
const card = async (x: { store: { read(): Promise<{ tasks: { id: string }[] }> } }) => (await x.store.read()).tasks.find((t) => t.id === "t") as Record<string, unknown>;

test("start returns at once and the result is applied in the background", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const x = await setup({ title: "Fix login redirect loop", type: "bugfix", tags: ["auth"] }, hold);
  expect(await x.service.start({ taskId: "t", text: "Fix the login bug please", provisionalTitle: "Fix the login bug" }, paseo)).toEqual({ started: true });
  expect((await card(x)).title).toBe("Fix the login bug");
  release();
  await x.service.settled();
  const after = await card(x);
  expect(after).toMatchObject({ title: "Fix login redirect loop", type: "bugfix", revision: 2 });
  expect(after.tags).toEqual([{ tag: "auth", by: "agent", at: expect.any(String) }]);
  expect(x.prompts[0]).toContain("Fix the login bug please");
  const events = (await x.store.read()).events.filter((e) => e.taskId === "t");
  expect(events.at(-2)).toMatchObject({ actor: "system", action: "edited" });
  expect(events.at(-1)).toMatchObject({ actor: "system", action: "tags_changed" });
});

test("a title edited and a type set while the model ran are kept", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const x = await setup({ title: "AI title", type: "bugfix", tags: [] }, hold);
  await x.service.start({ taskId: "t", text: "Fix the login bug", provisionalTitle: "Fix the login bug" }, paseo);
  await x.store.mutate((board) => {
    board.tasks[0].title = "My title";
    board.tasks[0].type = "feature";
    board.tasks[0].revision = 5;
  });
  release();
  await x.service.settled();
  expect(await card(x)).toMatchObject({ title: "My title", type: "feature", revision: 5 });
});

test("a model failure leaves the provisional title and is only logged", async () => {
  const x = await setup(new Error("no summary model"));
  await x.service.start({ taskId: "t", text: "Fix the login bug", provisionalTitle: "Fix the login bug" }, paseo);
  await x.service.settled();
  expect(await card(x)).toMatchObject({ title: "Fix the login bug", revision: 1 });
});

test("a missing or archived card is not started", async () => {
  const x = await setup({ title: "AI", type: null, tags: [] });
  expect(await x.service.start({ taskId: "nope", text: "x", provisionalTitle: "x" }, paseo)).toEqual({ started: false });
  await x.store.mutate((board) => {
    board.tasks[0].archivedAt = new Date().toISOString();
  });
  expect(await x.service.start({ taskId: "t", text: "x", provisionalTitle: "x" }, paseo)).toEqual({ started: false });
  expect(x.prompts).toEqual([]);
});

test("the default model runs in the background workspace with the summary models and deletes its session", async () => {
  const f = await agentFixture({ type: false, tags: false });
  roots.push(f.root);
  const created: { workspaceId: string; labels: Record<string, string>; provider: string }[] = [];
  const removed: string[] = [];
  const fake = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }], error: null }),
    },
    workspaces: {
      create: async () => ({ id: "bg-ws" }),
      archive: async () => ({}),
      ref: (workspaceId: string) => ({
        agents: {
          create: async (o: { labels: Record<string, string>; config: { provider: string } }) => {
            created.push({ workspaceId, labels: o.labels, provider: o.config.provider });
            return {
              id: "title-1",
              waitForFinish: async () => ({ status: "idle", error: null, lastMessage: '{"title":"Better","type":"docs","tags":[]}' }),
              archive: async () => ({}),
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const service = new QuickTitleService(
    f.store,
    async () => ({ summaryEnabled: true, summaryModel: "claude/claude-haiku-5-5", digestEnabled: true, retroEnabled: true }),
    async () => "en",
    { background: new BackgroundWorkspaces(f.store.directory, async () => "live"), remove: async (agent) => void removed.push(agent.id) },
  );
  await service.start({ taskId: "t", text: "Write the docs", provisionalTitle: "Card" }, fake);
  await service.settled();
  expect(created).toEqual([{ workspaceId: "bg-ws", provider: "claude/claude-haiku-5-5", labels: expect.objectContaining({ flowly: "summarizer", "flowly-run": "quick-title", "flowly-task": "t" }) }]);
  expect(removed).toEqual(["title-1"]);
  expect((await f.store.read()).tasks[0]).toMatchObject({ title: "Better", type: "docs" });
});
