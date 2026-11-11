import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { FlowLog } from "./flow-log";
import { GitStats } from "./git-stats";
import { SummaryStore } from "./summaries";
import { DigestStore, InsightsService } from "./insights";
import type { SummarySettings } from "../shared/summary";
import type { BoardEvent } from "../shared/model";
import { insightsViewSchema } from "../shared/workflow-stats";
import { BackgroundWorkspaces } from "./background-workspace";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
// Waits for the background digest runs themselves, not for a fixed time.
const settle = (x: { service: InsightsService }) => x.service.idle();
const NOW = Date.parse("2026-10-16T12:00:00.000Z");

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-insights-")));
  roots.push(root);
  const board = new BoardStore(join(root, "data"));
  const flow = new FlowLog(board.directory);
  board.flow = flow;
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: "", updatedAt: "", archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "Login", description: "", status: "in_review", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: "2026-10-15T01:00:00.000Z", updatedAt: "2026-10-15T09:00:00.000Z", archivedAt: null });
    b.events.push(
      { id: "e1", taskId: "t", actor: "human", action: "created", at: "2026-10-15T01:00:00.000Z" },
      { id: "e2", taskId: "t", actor: "agent", action: "status_changed", from: "todo", to: "in_review", at: "2026-10-15T09:00:00.000Z" },
    );
  });
  const created: { workspaceId: string; labels: Record<string, string>; prompt: string; parent?: string; config?: { provider: string } }[] = [];
  let archived = 0;
  let wsArchived = 0;
  const removed: string[] = [];
  const replies: string[] = [];
  let reply = JSON.stringify({ headline: "Login is ready for review", done: [], progressed: [{ text: "Login built", taskId: "t" }], issues: [], next: [] });
  const paseo = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }], error: null }),
    },
    agents: {
      list: async () => ({
        entries: [{ agent: { id: "a1", workspaceId: "w", provider: "codex", runtimeInfo: { model: "gpt-6-astra" }, status: "running", archivedAt: null, labels: {} } }],
        pageInfo: { nextCursor: null },
      }),
    },
    workspaces: {
      create: async () => ({ id: "bg-ws" }),
      archive: async () => {
        wsArchived++;
        return {};
      },
      ref: (workspaceId: string) => ({
        agents: {
          create: async (o: { labels: Record<string, string>; prompt: string; parent?: string }) => {
            created.push({ workspaceId, ...o });
            return {
              id: `digest-${created.length}`,
              waitForFinish: async () => ({ status: "idle", error: null, lastMessage: replies.shift() ?? reply }),
              archive: async () => {
                archived++;
                return {};
              },
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  let settings: SummarySettings = { summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true };
  const digests = new DigestStore(board.directory);
  const git = new GitStats(async () => "");
  const service = new InsightsService(board, flow, git, new SummaryStore(board.directory), digests, async () => settings, async () => "en", 1000, () => NOW, new BackgroundWorkspaces(board.directory, async () => "live"), async (agent) => {
    removed.push(agent.id);
  });
  return {
    root,
    board,
    flow,
    digests,
    service,
    paseo,
    created,
    archived: () => archived,
    wsArchived: () => wsArchived,
    removed,
    replies,
    setReply: (text: string) => (reply = text),
    setSettings: (s: Partial<SummarySettings>) => (settings = { ...settings, ...s }),
  };
}

test("project insights backfill the flow log and carry a year of activity", async () => {
  const x = await setup();
  const result = await x.service.project({ projectId: "p", tz: "UTC" }, x.paseo);
  expect((await x.flow.read("p")).map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(result.today).toBe("2026-10-16");
  expect(result.activity.from).toBe("2025-10-13");
  expect(result.activity.days.map((d) => d.day)).toEqual(["2026-10-15"]);
  // Habits only with the developer switch on (INSIGHTS-REDESIGN-SPEC §6).
  expect(result.habits).toBeUndefined();
  await expect(x.service.project({ projectId: "nope", tz: "UTC" }, x.paseo)).rejects.toThrow("Project not found.");
});

test("project insights carry the agent habits; turns without a stamped model take the session's current one", async () => {
  const x = await setup();
  const a = (id: string, action: string, at: string, extra: Partial<BoardEvent> = {}): BoardEvent => ({ id, taskId: "t", actor: action.startsWith("agent.") ? "system" : "agent", action, agentId: "a1", at, ...extra });
  await x.board.mutate((b) => {
    b.events.push(
      a("h1", "agent.turn_started", "2026-10-16T09:00:00.000Z"),
      a("h2", "next_moves_suggested", "2026-10-16T09:01:00.000Z", { moves: [{ label: "Verify", prompt: "Verify it." }] }),
      a("h3", "status_changed", "2026-10-16T09:02:00.000Z", { from: "development", to: "in_review", reportKind: "progress" }),
      a("h4", "agent.turn_ended", "2026-10-16T09:03:00.000Z", { outcome: "completed" }),
      a("h5", "agent.turn_started", "2026-10-16T10:00:00.000Z"),
      a("h6", "status_changed", "2026-10-16T10:01:00.000Z", { from: "development", to: "in_review", reportKind: "progress" }),
      a("h7", "agent.turn_ended", "2026-10-16T10:02:00.000Z", { outcome: "completed", model: "claude/claude-sonnet-5", pick: 0 }),
    );
  });
  x.service.agentHabits = async () => true;
  const result = await x.service.project({ projectId: "p", tz: "UTC" }, x.paseo);
  // The RPC validates its answer against this schema; a mismatch would fail every Insights read.
  const habits = insightsViewSchema.parse(result).habits!;
  expect(habits.days).toHaveLength(7);
  expect(habits.days.at(-1)).toMatchObject({ day: "2026-10-16", deliveries: 2, moves: 1, movesAny: 1, offered: 1, picked: 1 });
  expect(Object.fromEntries(habits.models.map((m) => [m.model, m.deliveries]))).toEqual({ "codex/gpt-6-astra": 1, "claude/claude-sonnet-5": 1 });
  // The flow log keeps what the counters need from a suggestion, not its text.
  const logged = (await x.flow.read("p")).find((e) => e.id === "h2");
  expect(logged).toMatchObject({ offered: 1 });
  expect(JSON.stringify(logged)).not.toContain("Verify it");
});

test("a past day's digest is generated once on read; today's only on refresh", async () => {
  const x = await setup();
  const first = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  expect(first).toMatchObject({ entry: null, running: true, empty: false });
  await settle(x);
  const second = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  expect(second.entry).toMatchObject({ headline: "Login is ready for review", progressed: [{ text: "Login built", taskId: "t" }], model: "claude/claude-haiku-5-5" });
  expect(x.created.length).toBe(1);
  expect(x.created[0]).toMatchObject({ workspaceId: "bg-ws", labels: { flowly: "summarizer", "flowly-project": "p" } });
  expect(x.created[0].prompt).toContain("## Card t: Login");
  expect(x.created[0].prompt).toContain("Todo → In review (agent)");
  // Hard-deleted, not archived (AGENTS.md exception).
  expect(x.removed).toEqual(["digest-1"]);
  expect(x.archived()).toBe(0);

  const today = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-16" }, x.paseo);
  expect(today).toMatchObject({ entry: null, running: false, empty: true });
  expect(x.created.length).toBe(1);
});

test("one digest per project at a time: days picked meanwhile generate only the last one", async () => {
  const x = await setup();
  x.service.refresh({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  x.service.refresh({ projectId: "p", tz: "UTC", day: "2026-10-14" }, x.paseo);
  const waiting = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-13" }, x.paseo);
  // 10-13 had no activity, so reading it alone queues nothing; refresh it to wait instead.
  expect(waiting.running).toBe(false);
  x.service.refresh({ projectId: "p", tz: "UTC", day: "2026-10-13" }, x.paseo);
  expect((await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-13" }, x.paseo)).running).toBe(true);
  await settle(x);
  const state = await x.digests.read();
  expect(state.entries.map((e) => e.day)).toEqual(["2026-10-15"]);
  // 10-14 was replaced while waiting and never ran; 10-13 ran after 10-15 (and found nothing to summarize).
  expect(state.errors.map((e) => e.day)).toEqual(["2026-10-13"]);
  expect(x.created.length).toBe(1);
});

test("auto generation follows the setting; failures are recorded and the session deleted; no workspace falls back to a card", async () => {
  const x = await setup();
  x.setSettings({ digestEnabled: false });
  const off = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  expect(off).toMatchObject({ running: false, enabled: false });
  x.setReply("not json");
  x.service.refresh({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  await settle(x);
  const failed = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  expect(failed.error?.message).toContain("no JSON");
  // Never a card's workspace, even when the project root has none of its own.
  expect(x.created[0].workspaceId).toBe("bg-ws");
  expect(x.removed).toEqual(["digest-1"]);
  expect(x.archived()).toBe(0);
});

test("project removal backs up and drops digests", async () => {
  const x = await setup();
  await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  await settle(x);
  expect((await x.digests.read()).entries.length).toBe(1);
  const backup = await x.digests.removeProject("p");
  expect(backup).toContain("p-digests-");
  expect((await x.digests.read()).entries).toEqual([]);
});

test("daily digest follows summary model priority and records the successful model", async () => {
  const x = await setup();
  x.setSettings({ summaryModels: ["claude/claude-sonnet-5-5", "claude/claude-haiku-5-5"] });
  x.replies.push("quota limit");
  await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  await settle(x);
  const result = await x.service.digest({ projectId: "p", tz: "UTC", day: "2026-10-15" }, x.paseo);
  expect(result.entry?.model).toBe("claude/claude-haiku-5-5");
  expect(x.created.map((a) => a.config?.provider)).toEqual(["claude/claude-sonnet-5-5", "claude/claude-haiku-5-5"]);
  expect(x.removed).toEqual(["digest-1", "digest-2"]);
  expect(x.archived()).toBe(0);
});

test("group insights cover the group's live members as one; archived members and other groups are left out", async () => {
  const x = await setup();
  const at = (day: string) => `${day}T09:00:00.000Z`;
  const card = (id: string, projectId: string, workspaceId: string) => ({ id, projectId, workspaceId, sourcePath: x.root, repoPaths: [x.root], title: id.toUpperCase(), description: "", status: "todo" as const, priority: "normal" as const, position: 0, revision: 1, operationId: `o-${id}`, createdAt: at("2026-10-10"), updatedAt: at("2026-10-10"), archivedAt: null });
  const project = (id: string, groupId: string, archivedAt: string | null = null) => ({ id, paseoProjectId: `n-${id}`, title: id.toUpperCase(), description: "", primaryPath: x.root, repos: [x.root], revision: 1, createdAt: "", updatedAt: "", archivedAt, groupId });
  const group = (id: string, position: number) => ({ id, name: id, position, revision: 1, createdAt: at("2026-10-01"), updatedAt: at("2026-10-01") });
  await x.board.mutate((b) => {
    b.groups.push({ ...group("g", 0), isDefault: true }, group("h", 1));
    b.projects[0].groupId = "g";
    b.projects.push(project("q", "g"), project("r", "g", at("2026-10-12")), project("s", "h"));
    b.tasks.push(card("tq", "q", "wq"), card("tr", "r", "wr"), card("ts", "s", "ws"));
    b.events.push(
      { id: "q1", taskId: "tq", actor: "agent", action: "status_changed", from: "todo", to: "done", at: at("2026-10-14") },
      { id: "r1", taskId: "tr", actor: "agent", action: "status_changed", from: "todo", to: "development", at: at("2026-10-13") },
      { id: "s1", taskId: "ts", actor: "agent", action: "status_changed", from: "todo", to: "development", at: at("2026-10-12") },
    );
  });
  expect(await x.service.groupProjectIds("g")).toEqual(["p", "q"]);
  const view = insightsViewSchema.parse(await x.service.group({ groupId: "g", tz: "UTC" }, x.paseo));
  // p moved on the 15th, q on the 14th; r is archived and s is in another group.
  expect(view.activity.days.map((d) => [d.day, d.cards, d.done])).toEqual([["2026-10-14", 1, ["tq"]], ["2026-10-15", 1, []]]);
  // A single project reads exactly as before.
  expect((await x.service.project({ projectId: "p", tz: "UTC" }, x.paseo)).activity.days.map((d) => d.day)).toEqual(["2026-10-15"]);
  const day = await x.service.groupDay({ groupId: "g", tz: "UTC", day: "2026-10-14" }, x.paseo);
  expect(day.list.map((c) => c.taskId)).toEqual(["tq"]);
  await expect(x.service.group({ groupId: "nope", tz: "UTC" }, x.paseo)).rejects.toThrow("Group not found.");
  // A group with no live member reads as no activity, not an error.
  await x.board.mutate((b) => void b.groups.push(group("e", 2)));
  expect((await x.service.group({ groupId: "e", tz: "UTC" }, x.paseo)).activity.days).toEqual([]);
});
