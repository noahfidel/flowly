import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { ToolServer } from "./tool-server";
import { groupWriter } from "./group-writes";
import { agentFixture } from "./agent-fixture";
import { changeLine } from "./dispatcher-items";
import { dispatcherInputs, replyOnceNote } from "./dispatcher-tools";
import { BoardService } from "./service";
import { projectCreator } from "./project-create";
import {
  dispatcherConfirmedToolNames,
  dispatcherMessagePrefix,
  dispatcherRepliesPerAgentPerHour,
  dispatcherRepliesPerHour,
  dispatcherToolNames,
} from "../shared/dispatcher";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

const stamp = "2026-11-08T10:00:00.000Z";
const dispatcherTools = [
  "flowly_list_projects",
  "flowly_list_cards",
  "flowly_get_card",
  "flowly_create_card",
  "flowly_update_card",
  "flowly_set_linear",
  "flowly_clear_linear",
  "flowly_start_card",
  "flowly_propose_idea",
  "flowly_link_cards",
  "flowly_list_ideas",
  "flowly_update_idea",
  "flowly_message_card",
  "flowly_reply_to_agent",
  "flowly_archive_card",
  // Not preapproved: the user confirms each call (ruling, Noah 2026-11-10).
  "flowly_create_project",
  "flowly_manage_groups",
];

async function setup() {
  const fixture = await agentFixture();
  // The dispatcher folder of a Paseo home of its own, outside the fixture's data folder (DISPATCHER-SPEC §2).
  const dispatcherPath = join(fixture.root, "paseo-home", "flowly-dispatcher", "dispatcher");
  await mkdir(dispatcherPath, { recursive: true });
  const server = new ToolServer(fixture.store, dispatcherPath);
  // The group writes the tool shares with the groups.* RPCs (index.server.ts wires the same).
  server.dispatcherTools.groupsWith = groupWriter(fixture.store, server.dispatcher, () => {});
  cleanups.push(async () => {
    await server.stop();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const qRoot = join(fixture.root, "q");
  await mkdir(qRoot);
  await fixture.store.mutate((board) => {
    const project = (id: string, primaryPath: string, archivedAt: string | null = null) => ({
      id,
      paseoProjectId: `native-${id}`,
      title: `Project ${id}`,
      description: "",
      primaryPath,
      repos: [primaryPath],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt,
    });
    // "p" (the fixture's) is a legacy multi-repo project; "q" and "r" are single-root.
    board.projects.push(project("q", qRoot), project("z", qRoot, stamp), project("gone", join(fixture.root, "missing")), project("r", qRoot));
    const card = (id: string, projectId: string) => ({
      id,
      projectId,
      workspaceId: `w-${id}`,
      sourcePath: qRoot,
      repoPaths: [],
      title: `Card ${id}`,
      description: "",
      status: "todo" as const,
      priority: "normal" as const,
      position: 0,
      revision: 1,
      operationId: `op-${id}`,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    });
    board.tasks.push(card("q1", "q"), card("q2", "q"), card("z1", "z"));
  });
  // Board groups (BOARD-GROUPS-SPEC §7): every project lands in the default group "Projects".
  await fixture.store.migrateGroups(async () => []);
  const groupId = (await fixture.store.read()).groups[0].id;
  // The stored dispatcher (a v1 record, moved to that group on first read): agent "disp" in workspace "dw".
  await writeFile(
    join(fixture.store.directory, "dispatcher.json"),
    JSON.stringify({ version: 1, workspaceId: "dw", agentId: "disp", startedAt: stamp }),
  );
  const agents: Record<string, { id: string; workspaceId: string; status: string; archivedAt: string | null; lastUsage?: unknown; currentModeId?: string | null; pendingPermissions?: unknown[]; labels?: Record<string, string> }> = {
    disp: { id: "disp", workspaceId: "dw", status: "idle", archivedAt: null, currentModeId: "default" },
    actor: { id: "actor", workspaceId: "w", status: "idle", archivedAt: null },
  };
  const createdWorkspaces: { title: string; source: { kind: string; projectId?: string } }[] = [];
  /** The MCP servers each created session launched with: its saved ones plus what the plugin's open hook adds. */
  const launched: Record<string, Record<string, unknown>> = {};
  /** The tool policy each created session was saved with. */
  const policies: Record<string, unknown> = {};
  /** Messages sent to sessions through `agents.ref(id).send`, and whether the next sends fail. */
  const sent: { id: string; text: string; options?: unknown }[] = [];
  let failSend = false;
  /** Each session's projected timeline, oldest first, paged as Paseo pages it (tail, then before a cursor). */
  const timelines: Record<string, { seqStart: number; seqEnd: number; timestamp?: string; item: Record<string, unknown> }[]> = {};
  const timelineReads: { id: string; direction: string }[] = [];
  const paseo = {
    ...(fixture.paseo as unknown as Record<string, unknown>),
    agents: {
      ref: (id: string) => ({
        refresh: async () => (agents[id] ? { agent: { ...agents[id] } } : null),
        send: async (text: string, options?: unknown) => {
          if (failSend) throw new Error("daemon down");
          sent.push({ id, text, options });
        },
        timeline: {
          refetch: async (o: { direction: string; limit: number; cursor?: { seq: number } }) => {
            timelineReads.push({ id, direction: o.direction });
            const all = timelines[id] ?? [];
            const before = o.direction === "before" ? all.filter((e) => e.seqStart < o.cursor!.seq) : all;
            const entries = before.slice(-o.limit);
            const first = entries[0];
            return {
              entries,
              epoch: "e1",
              hasOlder: before.length > entries.length,
              hasNewer: false,
              startCursor: first ? { epoch: "e1", seq: first.seqStart } : null,
              error: null,
            };
          },
        },
      }),
      list: async () => ({ entries: Object.values(agents).map((agent) => ({ agent })), pageInfo: { nextCursor: null } }),
    },
    workspaces: {
      ref: (id: string) => ({
        refresh: async () => (id === "dw" ? { id: "dw", archivingAt: null, workspaceDirectory: dispatcherPath } : fixture.workspace()),
        agents: {
          create: async (options: {
            agentId: string;
            config?: { mcpServers?: Record<string, unknown>; toolPolicy?: { preapproved: { kind: string; server: string; tool: string }[] } };
          }) => {
            // As Paseo's daemon (agent-manager.js validateToolPolicyServers): a preapproved tool's server must be saved
            // in the same request.
            const saved = options.config?.mcpServers ?? {};
            for (const grant of options.config?.toolPolicy?.preapproved ?? [])
              if (!(grant.server in saved))
                throw new Error(`toolPolicy preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same agent request`);
            policies[options.agentId] = options.config?.toolPolicy;
            // As resolveProviderLaunchConfig: a server the plugin's open hook adds (index.server.ts adds the
            // dispatcher's through dispatcherSession) must not share a name with a saved one.
            const added = (await server.dispatcherSession(options.agentId, paseo))?.mcp;
            const plugin: Record<string, unknown> = added ? { "flowly-dispatcher": added } : {};
            for (const name of Object.keys(plugin))
              if (name in saved) throw new Error(`MCP server '${name}' from plugin flowly collides with agent saved configuration`);
            launched[options.agentId] = { ...saved, ...plugin };
            agents[options.agentId] = { id: options.agentId, workspaceId: id, status: "running", archivedAt: null };
            return { id: options.agentId };
          },
        },
      }),
      create: async (request: (typeof createdWorkspaces)[number]) => {
        createdWorkspaces.push(request);
        return { id: `created-${createdWorkspaces.length}` };
      },
    },
  } as unknown as PaseoApi;
  server.attach(paseo);
  await server.start();
  const { url } = JSON.parse(await readFile(join(fixture.store.directory, "tool-endpoint.json"), "utf8"));
  const caller = (token: string) => {
    let id = 0;
    return async (method: string, params: unknown) => {
      const response = await fetch(url + "mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = await response.text();
      return JSON.parse(
        response.headers.get("content-type")?.includes("text/event-stream")
          ? body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).at(-1)!
          : body,
      );
    };
  };
  const connect = async (token: string) => {
    const mcp = caller(token);
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const call = async (name: string, args: unknown) => (await mcp("tools/call", { name, arguments: args })).result;
    const names = async () => (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name) as string[];
    return { mcp, call, names };
  };
  const dispatcherToken = server.secrets.dispatcherCredential({ agentId: "disp", workspaceId: "dw" });
  /** Group `groupId`'s entry of the stored record (DISPATCHER-SPEC §1). */
  const entry = async (id = groupId) => (await server.dispatcher.resolvedRecord()).groups[id];
  return { ...fixture, server, paseo, agents, sent, timelines, timelineReads, failSend: (v: boolean) => (failSend = v), url, createdWorkspaces, launched, policies, connect, dispatcherToken, groupId, entry };
}

const code = (result: { isError?: boolean; structuredContent?: { error?: { code?: string } } }) =>
  result.isError ? result.structuredContent?.error?.code : undefined;

test("a dispatcher token can write to any live project", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(await d.names()).toEqual(dispatcherTools);
  // None of them answers a card's ask (permission, question, blocker); only flowly_message_card messages a card's
  // session, and never answers (ruling, Noah 2026-11-09; DISPATCHER-SPEC §5.3).
  for (const name of await d.names()) expect(name).not.toMatch(/answer|respond|permission|approve|allow|deny|send|prompt/);
  expect((await d.names()).filter((n) => /message/.test(n))).toEqual(["flowly_message_card"]);
  // Replacing or archiving a dispatcher (its session or workspace) is the user's confirmed click only, never one of its
  // own tools (ruling, Noah 2026-11-09). Archiving a card (flowly_archive_card) is a board edit, not that.
  for (const name of await d.names()) expect(name).not.toMatch(/replace|dispatcher|archive_(session|agent|workspace)/);
  const projects = (await d.call("flowly_list_projects", {})).structuredContent.projects;
  expect(projects).toEqual([
    { projectId: "p", title: "Project", rootAvailable: true, openCards: 1 },
    { projectId: "q", title: "Project q", rootAvailable: true, openCards: 2 },
    { projectId: "gone", title: "Project gone", rootAvailable: false, openCards: 0 },
    { projectId: "r", title: "Project r", rootAvailable: true, openCards: 0 },
  ]);
  // Cards in two different projects from the same session.
  const inR = await d.call("flowly_create_card", { projectId: "r", title: "Work in r", idempotencyKey: "k-r" });
  expect(code(inR)).toBeUndefined();
  const inQ = await d.call("flowly_create_card", { projectId: "q", title: "Work in q", idempotencyKey: "k-q" });
  expect(inQ.structuredContent.card).toMatchObject({ title: "Work in q" });
  const board = await x.store.read();
  expect(board.tasks.find((t) => t.title === "Work in r")?.projectId).toBe("r");
  expect(board.tasks.find((t) => t.title === "Work in q")?.projectId).toBe("q");
  expect(x.createdWorkspaces.map((w) => w.source.projectId)).toEqual(["native-r", "native-q"]);
  const created = board.events.filter((e) => e.taskId === inQ.structuredContent.card.taskId);
  expect(created.length).toBeGreaterThan(0);
  expect(created.every((e) => e.agentId === "disp")).toBe(true);
  // Reads, edits, links and ideas in q.
  expect((await d.call("flowly_list_cards", { projectId: "q" })).structuredContent.cards.map((c: { taskId: string }) => c.taskId)).toContain("q1");
  expect((await d.call("flowly_get_card", { projectId: "q", taskId: "q1" })).structuredContent.card).toMatchObject({ taskId: "q1" });
  const updated = await d.call("flowly_update_card", { projectId: "q", taskId: "q1", revision: 1, priority: "high" });
  expect(updated.structuredContent).toMatchObject({ changed: ["priority"], card: { revision: 2 } });
  // A card's Linear issue: read through Linear, saved as its input, shown by get and list, cleared again (LINEAR-LINK-SPEC §3).
  x.server.cards.connectors = {
    recognizeLinear: async (text: string) => {
      if (!text.includes("ZEN-9132")) throw new Error(`${text} was not found in Linear.`);
      return {
        external: { connectionId: "lin", provider: "linear" as const, itemType: "issue" as const, key: "ZEN-9132", remoteId: "id" },
        url: "https://linear.app/acme/issue/ZEN-9132",
        title: "ZEN-9132 Link cards",
      };
    },
    cached: async () => ({ summary: "Link cards", status: "Todo" }) as never,
  };
  const set = await d.call("flowly_set_linear", { projectId: "q", taskId: "q1", issue: "ZEN-9132" });
  expect(set.structuredContent).toEqual({ linear: { key: "ZEN-9132", url: "https://linear.app/acme/issue/ZEN-9132", title: "Link cards", state: "Todo" } });
  expect((await d.call("flowly_get_card", { projectId: "q", taskId: "q1" })).structuredContent.card.linear).toMatchObject({ key: "ZEN-9132" });
  expect((await d.call("flowly_list_cards", { projectId: "q", query: "zen-9132" })).structuredContent.cards).toMatchObject([{ taskId: "q1", linear: { key: "ZEN-9132" } }]);
  expect(code(await d.call("flowly_set_linear", { projectId: "q", taskId: "q1", issue: "ZEN-1" }))).toBe("LINEAR_INVALID");
  expect((await d.call("flowly_clear_linear", { projectId: "q", taskId: "q1" })).structuredContent).toEqual({ cleared: true });
  const linked = await d.call("flowly_link_cards", { projectId: "q", taskId: "q1", relation: "blocks", otherTaskId: "q2" });
  expect(linked.structuredContent).toMatchObject({ created: true, link: { kind: "blocks", from: "q1", to: "q2" } });
  const again = await d.call("flowly_link_cards", { projectId: "q", taskId: "q1", relation: "blocks", otherTaskId: "q2" });
  expect(again.structuredContent).toMatchObject({ created: false });
  const follow = await d.call("flowly_link_cards", { projectId: "q", taskId: "q1", relation: "follow_up", otherTaskId: "q2" });
  expect(follow.structuredContent.link).toMatchObject({ kind: "derived", from: "q2", to: "q1" });
  const linkedEvents = (await x.store.read()).events.filter((e) => e.action === "linked");
  expect(linkedEvents.length).toBeGreaterThan(0);
  expect(linkedEvents.every((e) => e.actor === "agent" && e.agentId === "disp")).toBe(true);
  const cycle = await d.call("flowly_link_cards", { projectId: "q", taskId: "q2", relation: "blocks", otherTaskId: "q1" });
  expect(code(cycle)).toBe("LINK_REFUSED");
  const idea = await d.call("flowly_propose_idea", { projectId: "q", title: "Cache the board", detail: "Keep the last read", rationale: "Reads dominate" });
  expect(idea.structuredContent.idea).toMatchObject({ projectId: "q", agentId: "disp", status: "open" });
  // A card id from another project is not reachable through this project.
  expect(code(await d.call("flowly_get_card", { projectId: "q", taskId: "t" }))).toBe("CARD_NOT_FOUND");
  expect(code(await d.call("flowly_link_cards", { projectId: "q", taskId: "q1", relation: "blocks", otherTaskId: "t" }))).toBe("CARD_NOT_FOUND");
});

test("an archived project is refused", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  const before = JSON.stringify(await x.store.read());
  const attempts: [string, Record<string, unknown>][] = [
    ["flowly_list_cards", {}],
    ["flowly_get_card", { taskId: "z1" }],
    ["flowly_create_card", { title: "Nope", idempotencyKey: "k-z" }],
    ["flowly_update_card", { taskId: "z1", revision: 1, title: "Nope" }],
    ["flowly_set_linear", { taskId: "z1", issue: "ZEN-9132" }],
    ["flowly_clear_linear", { taskId: "z1" }],
    ["flowly_start_card", { taskId: "z1", idempotencyKey: "s-z" }],
    ["flowly_propose_idea", { title: "Nope", detail: "x", rationale: "y" }],
    ["flowly_link_cards", { taskId: "z1", relation: "blocks", otherTaskId: "q1" }],
    ["flowly_archive_card", { taskId: "z1" }],
  ];
  for (const [name, args] of attempts) expect(code(await d.call(name, { projectId: "z", ...args })), name).toBe("PROJECT_ARCHIVED");
  for (const [name, args] of attempts) expect(code(await d.call(name, { projectId: "nope", ...args })), name).toBe("NOT_FOUND");
  // A project whose folder is missing can be read, not written.
  expect(code(await d.call("flowly_list_cards", { projectId: "gone" }))).toBeUndefined();
  expect(code(await d.call("flowly_get_card", { projectId: "gone", taskId: "z1" }))).toBe("CARD_NOT_FOUND");
  for (const [name, args] of attempts.slice(2)) expect(code(await d.call(name, { projectId: "gone", ...args })), name).toBe("ROOT_UNAVAILABLE");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  expect(x.createdWorkspaces).toEqual([]);
  // A project archived after the session started is refused on the next call.
  await x.store.mutate((board) => {
    board.projects.find((p) => p.id === "q")!.archivedAt = stamp;
  });
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "Late", idempotencyKey: "k-late" }))).toBe("PROJECT_ARCHIVED");
  expect((await d.call("flowly_list_projects", {})).structuredContent.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["p", "gone", "r"]);
});

test("a legacy multi-repo project follows the card agents' rules", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(code(await d.call("flowly_list_cards", { projectId: "p" }))).toBeUndefined();
  expect(code(await d.call("flowly_get_card", { projectId: "p", taskId: "t" }))).toBeUndefined();
  const made = await d.call("flowly_create_card", { projectId: "p", title: "Legacy work", idempotencyKey: "k-legacy" });
  expect(code(made)).toBeUndefined();
  const other = made.structuredContent.card.taskId as string;
  expect(code(await d.call("flowly_update_card", { projectId: "p", taskId: "t", revision: 1, priority: "high" }))).toBeUndefined();
  expect(code(await d.call("flowly_link_cards", { projectId: "p", taskId: "t", relation: "blocks", otherTaskId: other }))).toBeUndefined();
  expect(code(await d.call("flowly_propose_idea", { projectId: "p", title: "Legacy idea", detail: "x", rationale: "y" }))).toBeUndefined();
  // Start goes through START-CARD-SPEC's own checks; no legacy refusal.
  expect(code(await d.call("flowly_start_card", { projectId: "p", taskId: "t", idempotencyKey: "s-legacy" }))).not.toBe("LEGACY_PROJECT");
});

test("the Agents create and edit cards switch turns off every dispatcher write", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  x.server.cards.on = async () => false;
  const before = JSON.stringify(await x.store.read());
  const writes: [string, Record<string, unknown>][] = [
    ["flowly_create_card", { title: "Nope", idempotencyKey: "k-off" }],
    ["flowly_update_card", { taskId: "q1", revision: 1, title: "Nope" }],
    ["flowly_set_linear", { taskId: "q1", issue: "ZEN-9132" }],
    ["flowly_clear_linear", { taskId: "q1" }],
    ["flowly_start_card", { taskId: "q1", idempotencyKey: "s-off" }],
    ["flowly_link_cards", { taskId: "q1", relation: "blocks", otherTaskId: "q2" }],
    ["flowly_propose_idea", { title: "Nope", detail: "x", rationale: "y" }],
    ["flowly_archive_card", { taskId: "q1" }],
  ];
  for (const [name, args] of writes) expect(code(await d.call(name, { projectId: "q", ...args })), name).toBe("AGENT_CARDS_DISABLED");
  // Creating a project is a write too, refused before the folder is looked at.
  expect(code(await d.call("flowly_create_project", { path: x.root }))).toBe("AGENT_CARDS_DISABLED");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  // Reads stay allowed.
  expect(code(await d.call("flowly_list_projects", {}))).toBeUndefined();
  expect(code(await d.call("flowly_list_cards", { projectId: "q" }))).toBeUndefined();
  expect(code(await d.call("flowly_get_card", { projectId: "q", taskId: "q1" }))).toBeUndefined();
});

test("the dispatcher has its own hourly limit of 40, apart from the card agents' 20", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  // A card agent with the same id filling its own bucket does not touch the dispatcher's.
  for (let i = 0; i < 20; i++) x.server.cards.reserve("disp");
  expect(() => x.server.cards.reserve("disp")).toThrow(expect.objectContaining({ code: "CARD_LIMIT" }));
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "First", idempotencyKey: "k-1" }))).toBeUndefined();
  for (let i = 0; i < 38; i++) x.server.cards.reserve("disp", true);
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "Fortieth", idempotencyKey: "k-40" }))).toBeUndefined();
  const over = await d.call("flowly_create_card", { projectId: "q", title: "Too many", idempotencyKey: "k-41" });
  expect(code(over)).toBe("CARD_LIMIT");
  expect(over.structuredContent.error.message).toContain("40");
  // And the dispatcher's 40 leave a card agent's 20 untouched.
  expect(() => x.server.cards.reserve("actor")).not.toThrow();
});

test("a new dispatcher saves its tools with every one preapproved, so they never prompt (DISPATCHER-SPEC §3)", async () => {
  const x = await setup();
  x.agents.disp.archivedAt = "2026-11-09T00:00:00.000Z";
  const { agentId } = await x.server.dispatcher.start(x.paseo, { groupId: x.groupId, provider: "claude/claude-sonnet-5-5" });
  // Saved once, with the session: the open hook adds nothing, so Paseo's name check is never tripped, and it is
  // still known as the dispatcher, so the hook stops there (no card context, no board tools).
  expect(await x.server.dispatcherSession(agentId, x.paseo)).toEqual({ mcp: null });
  expect(Object.keys(x.launched[agentId])).toEqual(["flowly-dispatcher"]);
  const server = x.launched[agentId]["flowly-dispatcher"] as { type: string; headers: { Authorization: string } };
  expect(server.type).toBe("http");
  const fresh = await x.connect(server.headers.Authorization.replace(/^Bearer /, ""));
  expect(code(await fresh.call("flowly_list_projects", {}))).toBeUndefined();
  // The tools that credential lists, each preapproved by name on that server, except the ones the user confirms
  // each time (flowly_create_project, ruling, Noah 2026-11-10); nothing else.
  const listed = (await fresh.names()).sort();
  const policy = x.policies[agentId] as { preapproved: { kind: string; server: string; tool: string }[] };
  expect(policy.preapproved.map((g) => g.tool).sort()).toEqual(listed.filter((name) => !dispatcherConfirmedToolNames.includes(name as never)));
  expect(listed).toContain("flowly_create_project");
  expect(policy.preapproved.every((g) => g.kind === "mcp" && g.server === "flowly-dispatcher")).toBe(true);
  // Its saved tools are the preapproved ones, so the tool it was not given shows no new-tools warning.
  expect((await x.entry()).savedTools).not.toContain("flowly_create_project");
  expect(await x.server.dispatcher.status(x.paseo, x.groupId)).not.toHaveProperty("newTools");
});

test("the dispatcher starts only on a provider that can withhold the routes to a card's asks (ruling, Noah 2026-11-09)", async () => {
  for (const provider of ["codex/gpt-5", "opencode/some-model", "copilot/gpt-5", "kimi/k2", "pi/x", "my-claude/claude-sonnet-5-5"]) {
    const x = await setup();
    x.agents.disp.archivedAt = "2026-11-09T00:00:00.000Z";
    const before = await x.server.dispatcher.resolvedRecord();
    await expect(x.server.dispatcher.start(x.paseo, { groupId: x.groupId, provider }), provider).rejects.toMatchObject({ code: "DISPATCHER_PROVIDER_UNSUPPORTED" });
    // Nothing was created or stored: the dead dispatcher's record stays as it was.
    expect(Object.keys(x.policies), provider).toEqual([]);
    expect(await x.server.dispatcher.resolvedRecord(), provider).toEqual(before);
  }
  // Claude: saved with its tools, as always.
  const x = await setup();
  x.agents.disp.archivedAt = "2026-11-09T00:00:00.000Z";
  const { agentId } = await x.server.dispatcher.start(x.paseo, { groupId: x.groupId, provider: "claude/claude-sonnet-5-5" });
  expect(x.policies[agentId]).toBeDefined();
  expect((await x.entry()).savedTools).toEqual(expect.any(Array));
});

test("a dispatcher started before its tools were saved still gets them from the open hook (DISPATCHER-SPEC §3)", async () => {
  const x = await setup();
  // The stored "disp" record has no savedTools mark.
  expect(await x.server.dispatcherSession("disp", x.paseo)).toMatchObject({ mcp: { type: "http" } });
  expect(await x.server.dispatcherSession("actor", x.paseo)).toBeNull();
});

test("a dispatcher token from a replaced dispatcher is refused", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(code(await d.call("flowly_list_projects", {}))).toBeUndefined();
  // The dispatcher session closed: a new one replaces it.
  x.agents.disp.archivedAt = "2026-11-09T00:00:00.000Z";
  const { agentId } = await x.server.dispatcher.start(x.paseo, { groupId: x.groupId, provider: "claude/claude-sonnet-5-5" });
  expect(agentId).not.toBe("disp");
  expect(code(await d.call("flowly_list_projects", {}))).toBe("DISPATCHER_REPLACED");
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "Old", idempotencyKey: "k-old" }))).toBe("DISPATCHER_REPLACED");
  // The new one works.
  const fresh = await x.connect(x.server.secrets.dispatcherCredential({ agentId, workspaceId: "dw" }));
  expect(code(await fresh.call("flowly_list_projects", {}))).toBeUndefined();
  // A token for the right agent in another workspace, and an archived dispatcher, are refused too.
  const elsewhere = await x.connect(x.server.secrets.dispatcherCredential({ agentId, workspaceId: "other" }));
  expect(code(await elsewhere.call("flowly_list_projects", {}))).toBe("DISPATCHER_REPLACED");
  x.agents[agentId].archivedAt = stamp;
  expect(code(await fresh.call("flowly_list_projects", {}))).toBe("SESSION_MISMATCH");
});

test("flowly_archive_card archives and unarchives one card of the project, only the card", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  const archived = await d.call("flowly_archive_card", { projectId: "q", taskId: "q1", reason: "PR merged" });
  expect(code(archived)).toBeUndefined();
  expect(archived.structuredContent).toEqual({ card: { taskId: "q1", title: "Card q1", status: "todo", archived: true, revision: 2 }, changed: true });
  let board = await x.store.read();
  expect(board.tasks.find((t) => t.id === "q1")?.archivedAt).toBeTruthy();
  expect(board.events.filter((e) => e.taskId === "q1").at(-1)).toMatchObject({ action: "archive_changed", actor: "agent", agentId: "disp", note: "PR merged" });
  // Again: nothing changes.
  expect((await d.call("flowly_archive_card", { projectId: "q", taskId: "q1" })).structuredContent).toMatchObject({ changed: false, card: { archived: true, revision: 2 } });
  // Archived cards leave the default list and come back with includeArchived.
  expect((await d.call("flowly_list_cards", { projectId: "q" })).structuredContent.cards.map((c: { taskId: string }) => c.taskId)).not.toContain("q1");
  expect((await d.call("flowly_list_cards", { projectId: "q", includeArchived: true })).structuredContent.cards.map((c: { taskId: string }) => c.taskId)).toContain("q1");
  const back = await d.call("flowly_archive_card", { projectId: "q", taskId: "q1", archived: false });
  expect(back.structuredContent).toEqual({ card: { taskId: "q1", title: "Card q1", status: "todo", archived: false, revision: 3 }, changed: true });
  board = await x.store.read();
  expect(board.tasks.find((t) => t.id === "q1")?.archivedAt).toBeNull();
  expect(board.events.filter((e) => e.taskId === "q1").at(-1)).toMatchObject({ action: "archive_changed", note: "Unarchived by the dispatcher" });
  // Unknown card, or a card of another project: refused, nothing written. Never a delete.
  expect(code(await d.call("flowly_archive_card", { projectId: "q", taskId: "nope" }))).toBe("CARD_NOT_FOUND");
  expect(code(await d.call("flowly_archive_card", { projectId: "r", taskId: "q2" }))).toBe("CARD_NOT_FOUND");
  expect(code(await d.call("flowly_archive_card", { projectId: "z", taskId: "z1" }))).toBe("PROJECT_ARCHIVED");
  board = await x.store.read();
  expect(board.tasks.map((t) => t.id)).toEqual(expect.arrayContaining(["q1", "q2", "z1"]));
  expect(board.tasks.find((t) => t.id === "q2")?.archivedAt).toBeNull();
});

test("flowly_list_cards shows a PR review card's prRef", async () => {
  const x = await setup();
  await x.store.mutate((b) => {
    const t = b.tasks.find((t) => t.id === "q2")!;
    t.operationId = "pr-review:agent-9";
    t.prRef = "acme/widgets#42";
  });
  const d = await x.connect(x.dispatcherToken);
  const cards = (await d.call("flowly_list_cards", { projectId: "q" })).structuredContent.cards as { taskId: string; prRef?: string }[];
  expect(cards.find((c) => c.taskId === "q2")?.prRef).toBe("acme/widgets#42");
  expect(cards.find((c) => c.taskId === "q1")).not.toHaveProperty("prRef");
});

test("a card or board token cannot call dispatcher tools", async () => {
  const x = await setup();
  const card = await x.connect(x.server.secrets.credential(x.identity));
  const cardNames = await card.names();
  expect(cardNames).not.toContain("flowly_list_projects");
  expect(cardNames).not.toContain("flowly_link_cards");
  expect(cardNames).not.toContain("flowly_archive_card");
  const listed = await card.mcp("tools/call", { name: "flowly_list_projects", arguments: {} });
  expect(listed.result?.isError ?? !!listed.error).toBe(true);
  // The card tools take no projectId: no reaching another project.
  x.server.attach(x.paseo);
  const crossCard = await card.call("flowly_create_card", { projectId: "q", title: "Cross", idempotencyKey: "k-x" });
  expect(crossCard.isError).toBe(true);
  expect(JSON.stringify(crossCard)).toMatch(/projectId|Unrecognized/);
  const board = await x.connect(x.server.secrets.boardCredential({ agentId: "actor", workspaceId: "w", projectId: "p" }));
  const boardNames = await board.names();
  expect(boardNames).not.toContain("flowly_list_projects");
  expect(boardNames).not.toContain("flowly_link_cards");
  expect(boardNames).not.toContain("flowly_archive_card");
  const crossBoard = await board.call("flowly_list_cards", { projectId: "q" });
  expect(crossBoard.isError).toBe(true);
  expect(JSON.stringify(crossBoard)).toMatch(/projectId|Unrecognized/);
  expect((await x.store.read()).tasks.some((t) => t.title === "Cross")).toBe(false);
  // Neither credential reads as a dispatcher one.
  expect(x.server.secrets.authenticateAny(x.server.secrets.credential(x.identity)).kind).toBe("card");
  expect(x.server.secrets.authenticateAny(x.server.secrets.boardCredential({ agentId: "actor", workspaceId: "w", projectId: "p" })).kind).toBe("board");
});

test("a dispatcher token cannot call card-session tools", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  for (const name of ["flowly_get_task", "flowly_update_status", "flowly_report_progress", "flowly_remember", "flowly_integrate"]) {
    const result = await d.mcp("tools/call", { name, arguments: {} });
    expect(result.result?.isError ?? !!result.error, name).toBe(true);
  }
  expect(await d.names()).not.toContain("flowly_get_task");
  // The CLI endpoint is for card sessions only.
  const api = await fetch(x.url + "api", {
    method: "POST",
    headers: { Authorization: `Bearer ${x.dispatcherToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get", input: {} }),
  });
  expect(api.status).toBe(401);
  // The sealed purpose tells the credentials apart; a dispatcher token is no card or board token.
  expect(x.server.secrets.authenticateAny(x.dispatcherToken)).toEqual({ kind: "dispatcher", identity: { agentId: "disp", workspaceId: "dw" } });
  expect(() => x.server.secrets.authenticate(x.dispatcherToken)).toThrow();
  expect(() => x.server.secrets.authenticateAny(x.dispatcherToken + "x")).toThrow();
});

/** Ideas of q (two project ideas and card ideas of q1), one of r, seeded with fixed times. */
async function seedIdeas(x: Awaited<ReturnType<typeof setup>>) {
  await x.store.mutate((board) => {
    const idea = (id: string, projectId: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      title: `Idea ${id}`,
      detail: `Detail of ${id}`,
      rationale: "Because",
      context: "",
      status: "open" as const,
      createdAt,
      updatedAt: createdAt,
      ...extra,
    });
    board.ideas.push(
      idea("i-old", "q", "2026-11-01T00:00:00.000Z", { tags: ["perf"], type: "feature", priority: "high" }),
      idea("i-card", "q", "2026-11-03T00:00:00.000Z", { taskId: "q1", scope: "here", tags: ["perf", "ui"] }),
      idea("i-new", "q", "2026-11-05T00:00:00.000Z", { detail: "Cache the BOARD reads", type: "bugfix" }),
      idea("i-tie-b", "q", "2026-11-04T00:00:00.000Z"),
      idea("i-tie-a", "q", "2026-11-04T00:00:00.000Z"),
      idea("i-gone", "q", "2026-11-02T00:00:00.000Z", { status: "dismissed" }),
      idea("i-took", "q", "2026-11-02T12:00:00.000Z", { status: "accepted", acceptedTaskId: "q2" }),
      idea("i-r", "r", "2026-11-06T00:00:00.000Z"),
    );
  });
}
const ids = (result: { structuredContent: { ideas: { id: string }[] } }) => result.structuredContent.ideas.map((i) => i.id);

test("flowly_list_ideas lists a project's open ideas newest first, and filters them (DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  // Open by default, card and project ideas together, newest first; a tie in time goes by id.
  const open = await d.call("flowly_list_ideas", { projectId: "q" });
  expect(ids(open)).toEqual(["i-new", "i-tie-a", "i-tie-b", "i-card", "i-old"]);
  expect(open.structuredContent.truncated).toBe(false);
  expect(open.structuredContent.ideas.find((i: { id: string }) => i.id === "i-card")).toEqual({
    id: "i-card",
    title: "Idea i-card",
    detail: "Detail of i-card",
    rationale: "Because",
    context: "",
    tags: ["perf", "ui"],
    status: "open",
    scope: "here",
    taskId: "q1",
    createdAt: "2026-11-03T00:00:00.000Z",
  });
  expect(open.structuredContent.ideas.find((i: { id: string }) => i.id === "i-old")).toMatchObject({ type: "feature", priority: "high", tags: ["perf"] });
  expect(open.structuredContent.ideas.find((i: { id: string }) => i.id === "i-old")).not.toHaveProperty("taskId");
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", status: "dismissed" }))).toEqual(["i-gone"]);
  const accepted = await d.call("flowly_list_ideas", { projectId: "q", status: "accepted" });
  expect(accepted.structuredContent.ideas).toEqual([expect.objectContaining({ id: "i-took", acceptedTaskId: "q2" })]);
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", status: "all" }))).toEqual(["i-new", "i-tie-a", "i-tie-b", "i-card", "i-took", "i-gone", "i-old"]);
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", tag: "PERF" }))).toEqual(["i-card", "i-old"]);
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", type: "bugfix" }))).toEqual(["i-new"]);
  // Title or detail, any case.
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", query: "board" }))).toEqual(["i-new"]);
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", query: "IDEA I-T" }))).toEqual(["i-tie-a", "i-tie-b"]);
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", query: "because" }))).toEqual([]);
  const cut = await d.call("flowly_list_ideas", { projectId: "q", limit: 2 });
  expect(ids(cut)).toEqual(["i-new", "i-tie-a"]);
  expect(cut.structuredContent.truncated).toBe(true);
  expect((await d.call("flowly_list_ideas", { projectId: "q", limit: 201 })).isError).toBe(true);
  expect(code(await d.call("flowly_list_ideas", { projectId: "q", tag: "not a tag!" }))).toBe("TAG_INVALID");
  // Another project's ideas are its own.
  expect(ids(await d.call("flowly_list_ideas", { projectId: "r" }))).toEqual(["i-r"]);
  // A read: archived and unknown projects refused; a missing root, Ideas off and the card switch off are fine.
  expect(code(await d.call("flowly_list_ideas", { projectId: "z" }))).toBe("PROJECT_ARCHIVED");
  expect(code(await d.call("flowly_list_ideas", { projectId: "nope" }))).toBe("NOT_FOUND");
  expect(code(await d.call("flowly_list_ideas", { projectId: "gone" }))).toBeUndefined();
  x.server.agents.ideasOn = async () => false;
  x.server.cards.on = async () => false;
  expect(ids(await d.call("flowly_list_ideas", { projectId: "q", status: "dismissed" }))).toEqual(["i-gone"]);
});

test("flowly_update_idea edits and dismisses any idea of the project, through the card sessions' rules (DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  const idea = async (id: string) => (await x.store.read()).ideas.find((i) => i.id === id)!;
  // Fields of a project idea; no event (PROJECT-IDEAS-SPEC §3).
  const eventsBefore = (await x.store.read()).events.length;
  const edited = await d.call("flowly_update_idea", {
    projectId: "q",
    ideaId: "i-old",
    title: "Sharper title",
    detail: "New detail",
    rationale: "New why",
    context: "src/x.ts",
    type: "refactor",
    priority: "low",
  });
  expect(code(edited)).toBeUndefined();
  expect(edited.structuredContent).toMatchObject({ changed: true, idea: { id: "i-old", title: "Sharper title", type: "refactor", priority: "low", status: "open" } });
  expect(await idea("i-old")).toMatchObject({ title: "Sharper title", detail: "New detail", rationale: "New why", context: "src/x.ts", type: "refactor", priority: "low" });
  expect((await x.store.read()).events.length).toBe(eventsBefore);
  // The same values again change nothing.
  expect((await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", title: "Sharper title" })).structuredContent.changed).toBe(false);
  // Tags: a full set, then add/remove (adding one there and removing one missing do nothing).
  await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", tags: ["A", "b"] });
  expect((await idea("i-old")).tags).toEqual(["a", "b"]);
  await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: ["c", "a"], removeTags: ["b", "missing"] });
  expect((await idea("i-old")).tags).toEqual(["a", "c"]);
  await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", tags: [] });
  expect((await idea("i-old")).tags).toBeUndefined();
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", tags: ["a"], addTags: ["b"] }))).toBe("INVALID_INPUT");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", tags: ["a"], removeTags: ["b"] }))).toBe("INVALID_INPUT");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: ["a"], removeTags: ["a"] }))).toBe("TAG_INVALID");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: ["bad tag!"] }))).toBe("TAG_INVALID");
  const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
  await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", tags: many });
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: ["one-more"] }))).toBe("TAG_INVALID");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old" }))).toBe("INVALID_INPUT");
  // A project idea's title stays unique among the project's open ideas.
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", title: "idea i-new" }))).toBe("DUPLICATE_IDEA");
  // A card-proposed idea: its changes are events on its card, by the dispatcher.
  const card = await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card", priority: "urgent", status: "dismissed" });
  expect(card.structuredContent).toMatchObject({ changed: true, idea: { id: "i-card", priority: "urgent", status: "dismissed", taskId: "q1" } });
  const cardEvents = (await x.store.read()).events.filter((e) => e.taskId === "q1" && e.action.startsWith("idea_"));
  expect(cardEvents.map((e) => e.action)).toEqual(["idea_edited", "idea_dismissed"]);
  expect(cardEvents.every((e) => e.actor === "agent" && e.agentId === "disp")).toBe(true);
  // Dismissed: no more edits; dismissing again changes nothing. Accepted: final.
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card", title: "Again" }))).toBe("IDEA_CLOSED");
  expect((await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card", status: "dismissed" })).structuredContent.changed).toBe(false);
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-took", status: "dismissed" }))).toBe("IDEA_CLOSED");
  // A project idea dismissed.
  expect((await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-new", status: "dismissed" })).structuredContent.idea.status).toBe("dismissed");
  // Unknown ids and another project's ideas are not found; nothing is written.
  const before = JSON.stringify(await x.store.read());
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "nope", title: "x" }))).toBe("IDEA_NOT_FOUND");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-r", title: "x" }))).toBe("IDEA_NOT_FOUND");
  expect(code(await d.call("flowly_update_idea", { projectId: "r", ideaId: "i-tie-a", title: "x" }))).toBe("IDEA_NOT_FOUND");
  // Ideas off, the card switch off, an archived project or a missing root: refused.
  x.server.agents.ideasOn = async () => false;
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-tie-a", title: "x" }))).toBe("IDEAS_DISABLED");
  x.server.agents.ideasOn = async () => true;
  expect(code(await d.call("flowly_update_idea", { projectId: "z", ideaId: "i-tie-a", title: "x" }))).toBe("PROJECT_ARCHIVED");
  expect(code(await d.call("flowly_update_idea", { projectId: "gone", ideaId: "i-tie-a", title: "x" }))).toBe("ROOT_UNAVAILABLE");
  x.server.cards.on = async () => false;
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-tie-a", title: "x" }))).toBe("AGENT_CARDS_DISABLED");
  expect(JSON.stringify(await x.store.read())).toBe(before);
});

test("flowly_create_card with ideaId takes the idea up as New card from it does (DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  // A project idea: accepted with the card's id; the card records where it came from.
  const made = await d.call("flowly_create_card", { projectId: "q", title: "From idea", idempotencyKey: "k-idea", ideaId: "i-new" });
  expect(code(made)).toBeUndefined();
  const taskId = made.structuredContent.card.taskId as string;
  let board = await x.store.read();
  expect(board.ideas.find((i) => i.id === "i-new")).toMatchObject({ status: "accepted", acceptedTaskId: taskId });
  expect(board.tasks.find((t) => t.id === taskId)?.origin).toEqual({ ideaId: "i-new" });
  // A retry with the same key returns the same card, not a refusal for the now-accepted idea.
  const again = await d.call("flowly_create_card", { projectId: "q", title: "From idea", idempotencyKey: "k-idea", ideaId: "i-new" });
  expect(again.structuredContent).toMatchObject({ replayed: true, card: { taskId } });
  // The same key with another idea, or with none, is a different request.
  const reused = await d.call("flowly_create_card", { projectId: "q", title: "From idea", idempotencyKey: "k-idea", ideaId: "i-tie-a" });
  expect(code(reused)).toBe("REQUEST_REUSED");
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "From idea", idempotencyKey: "k-idea" }))).toBe("REQUEST_REUSED");
  expect((await x.store.read()).ideas.find((i) => i.id === "i-tie-a")?.status).toBe("open");
  // A key first used without an idea cannot take one up on replay.
  await d.call("flowly_create_card", { projectId: "q", title: "Plain", idempotencyKey: "k-plain" });
  expect(code(await d.call("flowly_create_card", { projectId: "q", title: "Plain", idempotencyKey: "k-plain", ideaId: "i-tie-a" }))).toBe("REQUEST_REUSED");
  expect((await x.store.read()).ideas.find((i) => i.id === "i-tie-a")?.status).toBe("open");
  // A card idea: also the derived link to its source card and the idea_accepted event there.
  const fromCard = await d.call("flowly_create_card", { projectId: "q", title: "From card idea", idempotencyKey: "k-card-idea", ideaId: "i-card" });
  const second = fromCard.structuredContent.card.taskId as string;
  board = await x.store.read();
  expect(board.ideas.find((i) => i.id === "i-card")).toMatchObject({ status: "accepted", acceptedTaskId: second });
  expect(board.tasks.find((t) => t.id === second)?.origin).toEqual({ taskId: "q1", ideaId: "i-card" });
  expect(board.links.some((l) => l.kind === "derived" && l.from === second && l.to === "q1" && l.ideaId === "i-card")).toBe(true);
  expect(board.events.some((e) => e.taskId === "q1" && e.action === "idea_accepted")).toBe(true);
  // Refused before anything is made: another project's idea, an unknown one, one not open, Ideas off.
  const before = JSON.stringify(await x.store.read());
  const workspaces = x.createdWorkspaces.length;
  const attempt = (ideaId: string, key: string) => d.call("flowly_create_card", { projectId: "q", title: `Card ${key}`, idempotencyKey: key, ideaId });
  expect(code(await attempt("i-r", "k-r"))).toBe("IDEA_NOT_FOUND");
  expect(code(await attempt("nope", "k-nope"))).toBe("IDEA_NOT_FOUND");
  expect(code(await attempt("i-gone", "k-gone"))).toBe("IDEA_CLOSED");
  expect(code(await attempt("i-took", "k-took"))).toBe("IDEA_CLOSED");
  x.server.agents.ideasOn = async () => false;
  expect(code(await attempt("i-tie-a", "k-off"))).toBe("IDEAS_DISABLED");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  expect(x.createdWorkspaces.length).toBe(workspaces);
  // Refusals took no slot of the hourly limit: 3 used, so 37 more go through.
  for (let i = 0; i < 37; i++) x.server.cards.reserve("disp", true);
  expect(() => x.server.cards.reserve("disp", true)).toThrow(expect.objectContaining({ code: "CARD_LIMIT" }));
});

test("two creates from one idea at once: one card, the other refused with IDEA_CLOSED (DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  const results = await Promise.all(
    ["k-a", "k-b"].map((key) => d.call("flowly_create_card", { projectId: "q", title: `Race ${key}`, idempotencyKey: key, ideaId: "i-tie-a" })),
  );
  expect(results.map(code).sort()).toEqual(["IDEA_CLOSED", undefined].sort());
  const board = await x.store.read();
  const winner = results.find((r) => !code(r))!.structuredContent.card.taskId;
  expect(board.ideas.find((i) => i.id === "i-tie-a")).toMatchObject({ status: "accepted", acceptedTaskId: winner });
  expect(board.tasks.filter((t) => t.title.startsWith("Race "))).toHaveLength(1);
});

test("flowly_update_idea: empty addTags and removeTags alone change nothing and are refused (DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: [], removeTags: [] }))).toBe("INVALID_INPUT");
  expect(code(await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: [] }))).toBe("INVALID_INPUT");
  // With another field they are just nothing to do for the tags.
  expect((await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-old", addTags: [], priority: "low" })).structuredContent.changed).toBe(true);
});

test("flowly_update_idea works on ideas of finished and archived cards (ruling 2026-11-09, DISPATCHER-SPEC §5.1)", async () => {
  const x = await setup();
  await seedIdeas(x);
  await x.store.mutate((board) => {
    board.ideas.push({ ...board.ideas.find((i) => i.id === "i-card")!, id: "i-card2", title: "Second card idea", taskId: "q2" });
    board.tasks.find((t) => t.id === "q1")!.status = "done";
    board.tasks.find((t) => t.id === "q2")!.archivedAt = stamp;
  });
  const d = await x.connect(x.dispatcherToken);
  const done = await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card", title: "Still worth it" });
  expect(done.structuredContent).toMatchObject({ changed: true, idea: { title: "Still worth it" } });
  const archived = await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card2", status: "dismissed" });
  expect(archived.structuredContent).toMatchObject({ changed: true, idea: { status: "dismissed" } });
});

test("the dispatcher's own idea edits do not show in its changed-since line (DISPATCHER-SPEC §9.2)", async () => {
  const x = await setup();
  await seedIdeas(x);
  const d = await x.connect(x.dispatcherToken);
  const mark = { revision: Date.now() - 1, ids: [] };
  await d.call("flowly_update_idea", { projectId: "q", ideaId: "i-card", title: "Edited", status: "dismissed" });
  const board = await x.store.read();
  expect(board.events.filter((e) => e.taskId === "q1" && e.action.startsWith("idea_")).length).toBe(2);
  expect(changeLine(board, mark, ["disp"])).toBeNull();
  // The same events from another session would count.
  expect(changeLine(board, mark, ["someone-else"])?.kind).toBe("change");
});

/**
 * flowly_create_project wired as the plugin entry wires it: the RPC's own `projectCreator` over a real board service
 * (its queue and guardrail detection), with native projects listed by a fake Paseo.
 */
async function withProjects() {
  const x = await setup();
  const service = new BoardService(x.store);
  service.reservedRoot = (path) => x.server.dispatcher.ownsRoot(path);
  const natives: { projectId: string; projectRootPath: string; projectDisplayName: string }[] = [];
  const detected: string[] = [];
  const passed: unknown[] = [];
  const withNatives = (paseo: PaseoApi) =>
    ({ ...(paseo as object), projects: { list: async () => ({ projects: natives }) } }) as unknown as PaseoApi;
  // The one function the RPC handler and the tool share (index.server.ts).
  const rpcCreate = projectCreator(service, (id) => detected.push(id));
  x.server.dispatcherTools.createProjectWith = (input, paseo) => {
    passed.push(paseo);
    return rpcCreate(input, withNatives(paseo));
  };
  const folder = async (name = "repo-") => {
    const made = await realpath(await mkdtemp(join(x.root, name)));
    natives.push({ projectId: `native-${basename(made)}`, projectRootPath: made, projectDisplayName: basename(made) });
    return made;
  };
  return { ...x, natives, detected, passed, folder, rpcCreate, withNatives, d: await x.connect(x.dispatcherToken) };
}

test("flowly_create_project creates a single-directory project through the projects.create path (DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const repo = await x.folder();
  const created = await x.d.call("flowly_create_project", { path: repo, description: "Made by the dispatcher" });
  expect(code(created)).toBeUndefined();
  const { projectId, title, path } = created.structuredContent;
  // The folder's name is the default title.
  expect({ title, path }).toEqual({ title: basename(repo), path: repo });
  expect(x.passed).toEqual([x.paseo]);
  // The RPC's follow-up ran: the new project's check commands are detected for its guardrails.
  expect(x.detected).toEqual([projectId]);
  const project = (await x.store.read()).projects.find((p) => p.id === projectId);
  expect(project).toMatchObject({
    title: basename(repo),
    description: "Made by the dispatcher",
    paseoProjectId: `native-${basename(repo)}`,
    primaryPath: repo,
    repos: [repo],
    revision: 1,
    archivedAt: null,
    autoReview: { enabled: true, maxRounds: 2 },
  });
  // It is a live project the dispatcher can read and write in at once.
  expect((await x.d.call("flowly_list_projects", {})).structuredContent.projects).toContainEqual({ projectId, title, rootAvailable: true, openCards: 0 });
  // A given title wins.
  const other = await x.folder();
  const named = await x.d.call("flowly_create_project", { path: other, title: "  Named  " });
  expect(named.structuredContent).toMatchObject({ title: "Named", path: other });
  // A folder whose name is only spaces gets the fallback title instead of an input error.
  const blank = join(await x.folder("parent-"), "   ");
  await mkdir(blank);
  x.natives.push({ projectId: "native-blank", projectRootPath: blank, projectDisplayName: "blank" });
  const fallback = await x.d.call("flowly_create_project", { path: blank });
  expect(code(fallback)).toBeUndefined();
  expect(fallback.structuredContent.title).toBe("Project");
});

test("flowly_create_project and the projects.create RPC share one queue: the same folder twice at once makes one project (DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const repo = await x.folder();
  const [viaRpc, viaTool] = await Promise.all([
    x.rpcCreate({ title: "From the form", description: "", primaryPath: repo }, x.withNatives(x.paseo)).then(
      () => "made",
      (e: Error) => e.message,
    ),
    x.d.call("flowly_create_project", { path: repo }),
  ]);
  expect(viaRpc).toBe("made");
  expect(code(viaTool)).toBe("PROJECT_REFUSED");
  expect(viaTool.structuredContent.error.message).toContain("already linked");
  expect((await x.store.read()).projects.filter((p) => p.primaryPath === repo)).toHaveLength(1);
});

test("flowly_create_project refuses what the projects.create RPC refuses, and writes nothing (DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const repo = await x.folder();
  expect(code(await x.d.call("flowly_create_project", { path: repo }))).toBeUndefined();
  const before = JSON.stringify((await x.store.read()).projects);
  const refused = async (args: Record<string, unknown>, message: string) => {
    const result = await x.d.call("flowly_create_project", args);
    expect(code(result), message).toBe("PROJECT_REFUSED");
    expect(result.structuredContent.error.message).toContain(message);
  };
  // The same folder again: its native project is already on the board.
  await refused({ path: repo, title: "Again" }, "already linked");
  // A missing folder, and a file.
  await refused({ path: join(x.root, "no-such-folder") }, "Expected an existing directory.");
  await refused({ path: join(x.root, "no-such-folder"), title: "Named" }, "Expected an existing directory.");
  const file = join(x.root, "a-file");
  await writeFile(file, "x");
  await refused({ path: file }, "Expected an existing directory.");
  // Bad input is the schema's refusal: no path, a relative path, an over-long title, linked-project fields.
  expect((await x.d.call("flowly_create_project", {})).isError).toBe(true);
  expect((await x.d.call("flowly_create_project", { path: "repo" })).isError).toBe(true);
  expect((await x.d.call("flowly_create_project", { path: "./repo" })).isError).toBe(true);
  expect((await x.d.call("flowly_create_project", { path: repo, title: "x".repeat(121) })).isError).toBe(true);
  expect((await x.d.call("flowly_create_project", { path: repo, links: [repo] })).isError).toBe(true);
  expect(JSON.stringify((await x.store.read()).projects)).toBe(before);
  expect(x.detected).toHaveLength(1);
});

test("flowly_create_project refuses Flowly's own folders, and what holds them; the form's RPC does not (ruling B, DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const dispatcherParent = join(x.root, "paseo-home", "flowly-dispatcher");
  const projectsBefore = JSON.stringify((await x.store.read()).projects);
  const holdsData = await realpath(join(x.store.directory, ".."));
  const reserved = [
    x.store.directory, // the plugin data folder
    join(x.store.directory, "inside"), // inside it
    holdsData, // holding it (the fixture root)
    dispatcherParent, // the dispatcher's parent
    join(dispatcherParent, "dispatcher"), // the dispatcher's folder, inside it
    join(x.root, "paseo-home"), // holding it
  ];
  await mkdir(join(x.store.directory, "inside"), { recursive: true });
  for (const path of reserved) {
    const canonical = await realpath(path);
    x.natives.push({ projectId: `native-${canonical}`, projectRootPath: canonical, projectDisplayName: "r" });
    const result = await x.d.call("flowly_create_project", { path });
    expect(code(result), path).toBe("PROJECT_REFUSED");
    expect(result.structuredContent.error.message, path).toContain("Flowly's own data or the dispatcher's folder");
  }
  // By a link too: canonical paths are compared.
  const link = join(await x.folder("links-"), "to-data");
  await symlink(x.store.directory, link);
  expect(code(await x.d.call("flowly_create_project", { path: link }))).toBe("PROJECT_REFUSED");
  // A bare ~ is the home folder: in a real install it holds the Paseo home, so it is refused the same way.
  const home = process.env.HOME;
  process.env.HOME = x.root;
  try {
    const result = await x.d.call("flowly_create_project", { path: "~" });
    expect(code(result)).toBe("PROJECT_REFUSED");
    expect(result.structuredContent.error.message).toContain("Flowly's own data");
  } finally {
    process.env.HOME = home;
  }
  expect(x.passed).toEqual([]);
  expect(JSON.stringify((await x.store.read()).projects)).toBe(projectsBefore);
  // The form's RPC keeps its own rules: the plugin data subfolder is accepted there.
  const inside = await realpath(join(x.store.directory, "inside"));
  await expect(x.rpcCreate({ title: "Form", description: "", primaryPath: inside }, x.withNatives(x.paseo))).resolves.toMatchObject({ primaryPath: inside });
});

test("flowly_create_project runs only in a permission mode that asks the user (ruling A, DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const repo = await x.folder();
  for (const mode of ["bypassPermissions", "auto", "some-new-mode"]) {
    x.agents.disp.currentModeId = mode;
    const result = await x.d.call("flowly_create_project", { path: repo });
    expect(code(result), mode).toBe("CONFIRMATION_UNAVAILABLE");
    expect(result.structuredContent.error.message).toContain(mode);
  }
  // No mode reported is refused too: the prompt cannot be shown to happen.
  x.agents.disp.currentModeId = null;
  const unknown = await x.d.call("flowly_create_project", { path: repo });
  expect(code(unknown)).toBe("CONFIRMATION_UNAVAILABLE");
  expect(unknown.structuredContent.error.message).toContain("unknown");
  expect(x.passed).toEqual([]);
  // The modes that ask go through.
  for (const mode of ["default", "acceptEdits", "plan"]) {
    x.agents.disp.currentModeId = mode;
    expect(code(await x.d.call("flowly_create_project", { path: await x.folder() })), String(mode)).toBeUndefined();
  }
});

test("flowly_create_project: at most 5 projects per dispatcher hour, apart from the card bucket (ruling A, DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  x.server.dispatcherTools.clock = () => now;
  // Refusals give their slot back.
  for (let i = 0; i < 3; i++) expect(code(await x.d.call("flowly_create_project", { path: join(x.root, "missing") }))).toBe("PROJECT_REFUSED");
  for (let i = 0; i < 5; i++) expect(code(await x.d.call("flowly_create_project", { path: await x.folder() })), `#${i + 1}`).toBeUndefined();
  const over = await x.d.call("flowly_create_project", { path: await x.folder() });
  expect(code(over)).toBe("PROJECT_LIMIT");
  expect(over.structuredContent.error.message).toContain("5");
  // The card bucket is untouched.
  expect(code(await x.d.call("flowly_create_card", { projectId: "q", title: "Still fine", idempotencyKey: "k-cap" }))).toBeUndefined();
  // An hour later there is room again.
  now += 3_600_001;
  expect(code(await x.d.call("flowly_create_project", { path: await x.folder() }))).toBeUndefined();
});

test("flowly_create_project is checked like every dispatcher write: replaced dispatcher, the switch, not wired yet (DISPATCHER-SPEC §4)", async () => {
  const x = await withProjects();
  const repo = await x.folder();
  const before = JSON.stringify((await x.store.read()).projects);
  // A token of a replaced dispatcher.
  const stale = await x.connect(x.server.secrets.dispatcherCredential({ agentId: "old", workspaceId: "dw" }));
  expect(code(await stale.call("flowly_create_project", { path: repo }))).toBe("DISPATCHER_REPLACED");
  // The Agents create and edit cards switch.
  x.server.cards.on = async () => false;
  expect(code(await x.d.call("flowly_create_project", { path: repo }))).toBe("AGENT_CARDS_DISABLED");
  x.server.cards.on = async () => true;
  // Before the plugin entry hands over the RPC's path.
  x.server.dispatcherTools.createProjectWith = undefined;
  const early = await x.d.call("flowly_create_project", { path: repo });
  expect(code(early)).toBe("PASEO_UNAVAILABLE");
  expect(early.structuredContent.error.retryable).toBe(true);
  expect(x.passed).toEqual([]);
  expect(JSON.stringify((await x.store.read()).projects)).toBe(before);
});

/**
 * Two groups (DISPATCHER-SPEC §0): "Projects" (A: p, q, gone and the archived z) with the stored dispatcher "disp", and
 * "Clients" (B: r) with a dispatcher of its own, started through the hub and called with the token it was saved with.
 */
async function twoGroups<X extends Awaited<ReturnType<typeof setup>>>(x: X) {
  const clients = await x.store.createGroup({ name: "Clients" });
  const r = (await x.store.read()).projects.find((p) => p.id === "r")!;
  await x.store.setProjectGroup({ projectId: "r", revision: r.revision, groupId: clients.id });
  // Moving r bumped the group's revision: hand back the group as it is now.
  const current = (await x.store.read()).groups.find((g) => g.id === clients.id)!;
  const { agentId } = await x.server.dispatcher.start(x.paseo, { groupId: clients.id, provider: "claude/claude-sonnet-5-5" });
  x.agents[agentId].currentModeId = "default";
  const saved = x.launched[agentId]["flowly-dispatcher"] as { headers: { Authorization: string } };
  const token = saved.headers.Authorization.replace(/^Bearer /, "");
  return { clients: current, agentId, token, b: await x.connect(token), a: await x.connect(x.dispatcherToken) };
}
const projectIds = (result: { structuredContent: { projects: { projectId: string }[] } }) => result.structuredContent.projects.map((p) => p.projectId);

test("each group's dispatcher works on its own group's projects only (DISPATCHER-SPEC §0, §4)", async () => {
  const x = await setup();
  const { clients, agentId, token, a, b } = await twoGroups(x);
  // The new session's token names its group; the stored one from before (no group) still works.
  expect(x.server.secrets.authenticateAny(token)).toEqual({ kind: "dispatcher", identity: { agentId, workspaceId: "dw", groupId: clients.id } });
  expect(await x.server.dispatcherSession(agentId, x.paseo)).toEqual({ mcp: null });
  // flowly_list_projects lists the caller's group's live members.
  expect(projectIds(await a.call("flowly_list_projects", {}))).toEqual(["p", "q", "gone"]);
  expect(projectIds(await b.call("flowly_list_projects", {}))).toEqual(["r"]);
  // Another group's project is refused, before any card check, for reads and writes alike.
  const before = JSON.stringify(await x.store.read());
  expect(code(await a.call("flowly_list_cards", { projectId: "r" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await a.call("flowly_create_card", { projectId: "r", title: "Nope", idempotencyKey: "k-ab" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await b.call("flowly_get_card", { projectId: "q", taskId: "q1" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await b.call("flowly_propose_idea", { projectId: "q", title: "Nope", detail: "x", rationale: "y" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await b.call("flowly_link_cards", { projectId: "q", taskId: "q1", relation: "blocks", otherTaskId: "q2" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await b.call("flowly_list_ideas", { projectId: "q" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  // Its own group's projects work.
  expect(code(await b.call("flowly_create_card", { projectId: "r", title: "Client work", idempotencyKey: "k-b" }))).toBeUndefined();
  expect(code(await a.call("flowly_list_cards", { projectId: "q" }))).toBeUndefined();
  // A token whose group is not the one holding its session is refused.
  const wrong = await x.connect(x.server.secrets.dispatcherCredential({ agentId, workspaceId: "dw", groupId: x.groupId }));
  expect(code(await wrong.call("flowly_list_projects", {}))).toBe("DISPATCHER_REPLACED");
});

test("a project moved to another group between calls is refused, and its new group's dispatcher takes it (DISPATCHER-SPEC §4)", async () => {
  const x = await setup();
  const { clients, a, b } = await twoGroups(x);
  expect(code(await a.call("flowly_get_card", { projectId: "q", taskId: "q1" }))).toBeUndefined();
  const q = (await x.store.read()).projects.find((p) => p.id === "q")!;
  await x.store.setProjectGroup({ projectId: "q", revision: q.revision, groupId: clients.id });
  expect(code(await a.call("flowly_get_card", { projectId: "q", taskId: "q1" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await a.call("flowly_update_card", { projectId: "q", taskId: "q1", revision: 1, priority: "high" }))).toBe("PROJECT_OUT_OF_GROUP");
  expect(code(await b.call("flowly_get_card", { projectId: "q", taskId: "q1" }))).toBeUndefined();
  expect(projectIds(await b.call("flowly_list_projects", {}))).toEqual(["q", "r"]);
});

test("a project moved to another group during a write is refused when the write is stored (DISPATCHER-SPEC §4)", async () => {
  const x = await setup();
  const { clients, a } = await twoGroups(x);
  const home = (await x.store.read()).projects.find((p) => p.id === "q")!.groupId!;
  const idea = (await a.call("flowly_propose_idea", { projectId: "q", title: "Keep", detail: "x", rationale: "y" })).structuredContent as { idea: { id: string } };
  // The move lands after the caller's group check and before the write, as another call's would.
  const tools = x.server.dispatcherTools as unknown as { projectCaller: (...args: unknown[]) => Promise<unknown> };
  const check = tools.projectCaller.bind(tools);
  const moveQ = async (groupId: string) => {
    const q = (await x.store.read()).projects.find((p) => p.id === "q")!;
    await x.store.setProjectGroup({ projectId: "q", revision: q.revision, groupId });
  };
  // The board right after the move (moving re-places the project's cards in its new group's order).
  let moved: Awaited<ReturnType<typeof x.store.read>> | undefined;
  tools.projectCaller = async (...args) => {
    const caller = await check(...args);
    await moveQ(clients.id);
    moved = await x.store.read();
    return caller;
  };
  const q1 = () => x.store.read().then((b) => b.tasks.find((t) => t.id === "q1")!);
  const writes: [string, () => Promise<Record<string, unknown>>][] = [
    ["flowly_create_card", async () => ({ title: "Nope", idempotencyKey: "k-race" })],
    ["flowly_update_card", async () => ({ taskId: "q1", revision: (await q1()).revision, title: "Nope" })],
    ["flowly_link_cards", async () => ({ taskId: "q1", relation: "blocks", otherTaskId: "q2" })],
    ["flowly_propose_idea", async () => ({ title: "Nope", detail: "x", rationale: "y" })],
    ["flowly_update_idea", async () => ({ ideaId: idea.idea.id, title: "Nope" })],
    ["flowly_archive_card", async () => ({ taskId: "q1" })],
    ["flowly_start_card", async () => ({ taskId: "q1", idempotencyKey: "s-race" })],
  ];
  for (const [name, args] of writes) {
    expect(code(await a.call(name, { projectId: "q", ...(await args()) })), name).toBe("PROJECT_OUT_OF_GROUP");
    const before = moved!;
    const after = await x.store.read();
    expect(after.tasks.filter((t) => t.projectId === "q"), name).toEqual(before.tasks.filter((t) => t.projectId === "q"));
    expect(after.ideas.filter((i) => i.projectId === "q"), name).toEqual(before.ideas.filter((i) => i.projectId === "q"));
    expect(after.links ?? [], name).toEqual(before.links ?? []);
    await moveQ(home);
  }
});

test("another group's start in a new workspace leaves a live dispatcher's tools and open hook working (DISPATCHER-SPEC §1, §2, §4)", async () => {
  const x = await setup();
  // The stored workspace is no longer in the dispatcher folder (as one in the old in-data folder): the next start makes a new one.
  const workspaces = x.paseo.workspaces as unknown as { ref: (id: string) => Record<string, unknown> };
  const ref = workspaces.ref;
  workspaces.ref = (id) => (id === "dw" ? { ...ref(id), refresh: async () => ({ id: "dw", archivingAt: null, workspaceDirectory: x.root }) } : ref(id));
  const { agentId, a, b } = await twoGroups(x);
  expect(x.agents[agentId].workspaceId).toBe("created-1");
  expect(code(await a.call("flowly_list_projects", {}))).toBeUndefined();
  expect(code(await b.call("flowly_list_projects", {}))).toBeUndefined();
  // The open hook still gives "disp" a credential for the workspace it lives in.
  const hook = (await x.server.dispatcherSession("disp", x.paseo))?.mcp;
  const token = hook!.headers.Authorization.replace(/^Bearer /, "");
  expect(x.server.secrets.authenticateAny(token)).toMatchObject({ kind: "dispatcher", identity: { agentId: "disp", workspaceId: "dw" } });
});

test("a dispatcher whose group was deleted is refused as replaced (DISPATCHER-SPEC §4)", async () => {
  const x = await setup();
  const { clients, a, b } = await twoGroups(x);
  const group = (await x.store.read()).groups.find((g) => g.id === clients.id)!;
  await x.store.deleteGroup({ id: group.id, revision: group.revision });
  expect(code(await b.call("flowly_list_projects", {}))).toBe("DISPATCHER_REPLACED");
  expect(code(await b.call("flowly_create_card", { projectId: "r", title: "Late", idempotencyKey: "k-late-b" }))).toBe("DISPATCHER_REPLACED");
  // The other group's dispatcher is untouched, and now has r (moved to the default group).
  expect(projectIds(await a.call("flowly_list_projects", {}))).toEqual(["p", "q", "gone", "r"]);
});

test("flowly_create_project puts the new project in the caller's group (DISPATCHER-SPEC §5.2)", async () => {
  const x = await withProjects();
  const { clients, b } = await twoGroups(x);
  const made = await b.call("flowly_create_project", { path: await x.folder() });
  expect(code(made)).toBeUndefined();
  const { projectId } = made.structuredContent;
  expect((await x.store.read()).projects.find((p) => p.id === projectId)?.groupId).toBe(clients.id);
  expect(projectIds(await b.call("flowly_list_projects", {}))).toContain(projectId);
  expect(projectIds(await x.d.call("flowly_list_projects", {}))).not.toContain(projectId);
  // The stored dispatcher's lands in its own group.
  const other = (await x.d.call("flowly_create_project", { path: await x.folder() })).structuredContent.projectId;
  expect((await x.store.read()).projects.find((p) => p.id === other)?.groupId).toBe(x.groupId);
});

test("each group's dispatcher has its own hourly card and project buckets (DISPATCHER-SPEC §5, §5.2)", async () => {
  const x = await withProjects();
  const { agentId, b } = await twoGroups(x);
  // B fills its 40 cards and its 5 projects.
  for (let i = 0; i < 40; i++) x.server.cards.reserve(agentId, true);
  expect(code(await b.call("flowly_create_card", { projectId: "r", title: "Too many", idempotencyKey: "k-b41" }))).toBe("CARD_LIMIT");
  for (let i = 0; i < 5; i++) expect(code(await b.call("flowly_create_project", { path: await x.folder() })), `#${i + 1}`).toBeUndefined();
  expect(code(await b.call("flowly_create_project", { path: await x.folder() }))).toBe("PROJECT_LIMIT");
  // A's buckets are untouched.
  expect(code(await x.d.call("flowly_create_card", { projectId: "q", title: "Still fine", idempotencyKey: "k-a1" }))).toBeUndefined();
  expect(code(await x.d.call("flowly_create_project", { path: await x.folder() }))).toBeUndefined();
});

async function withSessions() {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  x.agents.s1 = { id: "s1", workspaceId: "w-q1", status: "idle", archivedAt: null };
  const message = (args: Record<string, unknown>) => d.call("flowly_message_card", { projectId: "q", taskId: "q1", text: "integrate", ...args });
  return { ...x, d, message };
}

test("flowly_message_card steers a prefixed message into the card's only live session (DISPATCHER-SPEC §5.3)", async () => {
  const x = await withSessions();
  const result = await x.message({ text: "  finish up  " });
  expect(code(result)).toBeUndefined();
  expect(result.structuredContent).toEqual({ sent: true, sessionId: "s1" });
  // The prefix marks it as the dispatcher's, the user's text follows unchanged (trimmed), and it is steered.
  expect(x.sent).toEqual([{ id: "s1", text: `${dispatcherMessagePrefix}finish up`, options: { activeTurnBehavior: "steer" } }]);
  expect(dispatcherMessagePrefix).toMatch(/^From the Flowly dispatcher/);
  // Archived and helper sessions do not count; another card's session is never reached.
  x.agents.old = { id: "old", workspaceId: "w-q1", status: "idle", archivedAt: stamp };
  x.agents.helper = { id: "helper", workspaceId: "w-q1", status: "running", archivedAt: null, labels: { flowly: "summarizer" } };
  x.agents.other = { id: "other", workspaceId: "w-q2", status: "idle", archivedAt: null };
  expect((await x.message({})).structuredContent.sessionId).toBe("s1");
  expect(code(await x.message({ sessionId: "other" }))).toBe("SESSION_NOT_FOUND");
  expect(code(await x.message({ sessionId: "old" }))).toBe("SESSION_NOT_FOUND");
  expect(x.sent.map((m) => m.id)).toEqual(["s1", "s1"]);
});

test("flowly_message_card: no live session, an ambiguous default, and a named session (DISPATCHER-SPEC §5.3)", async () => {
  const x = await withSessions();
  expect(code(await x.message({ taskId: "q2" }))).toBe("NO_LIVE_SESSION");
  x.agents.s2 = { id: "s2", workspaceId: "w-q1", status: "idle", archivedAt: null };
  const ambiguous = await x.message({});
  expect(code(ambiguous)).toBe("SESSION_AMBIGUOUS");
  expect(ambiguous.structuredContent.error.message).toContain("s1");
  expect(ambiguous.structuredContent.error.message).toContain("s2");
  expect(x.sent).toEqual([]);
  // The one running session is the default; two running are ambiguous again; a named one always works.
  x.agents.s2.status = "running";
  expect((await x.message({})).structuredContent.sessionId).toBe("s2");
  x.agents.s1.status = "running";
  expect(code(await x.message({}))).toBe("SESSION_AMBIGUOUS");
  expect((await x.message({ sessionId: "s1" })).structuredContent.sessionId).toBe("s1");
  expect(x.sent.map((m) => m.id)).toEqual(["s2", "s1"]);
});

test("flowly_message_card never touches a session that waits on the user (DISPATCHER-SPEC §5.3)", async () => {
  const x = await withSessions();
  // A pending permission or question: refused, nothing sent, nothing answered.
  x.agents.s1.pendingPermissions = [{ id: "req-1", kind: "question", name: "AskUserQuestion", input: {} }];
  expect(code(await x.message({}))).toBe("SESSION_WAITING_ON_USER");
  x.agents.s1.pendingPermissions = [{ id: "req-2", kind: "tool", name: "Bash", input: {} }];
  expect(code(await x.message({}))).toBe("SESSION_WAITING_ON_USER");
  x.agents.s1.pendingPermissions = [];
  // An open question or blocker report, until the session's next turn starts.
  const report = (id: string, reportKind: string, at: string) => ({
    id,
    taskId: "q1",
    at,
    actor: "agent" as const,
    agentId: "s1",
    action: "progress_reported" as const,
    reportKind,
    note: "?",
  });
  for (const [n, kind] of ["question", "blocker"].entries()) {
    await x.store.mutate((board) => {
      board.events.push(report(`e-${kind}`, kind, `2026-11-08T1${n * 2 + 1}:00:00.000Z`) as never);
    });
    expect(code(await x.message({})), kind).toBe("SESSION_WAITING_ON_USER");
    await x.store.mutate((board) => {
      board.events.push({ id: `t-${kind}`, taskId: "q1", at: `2026-11-08T1${n * 2 + 2}:00:00.000Z`, actor: "system", agentId: "s1", action: "agent.turn_started" } as never);
    });
    expect(code(await x.message({})), `after ${kind}`).toBeUndefined();
  }
  expect(x.sent.length).toBe(2);
  // Another session of the card that waits does not block a named, free one.
  x.agents.s2 = { id: "s2", workspaceId: "w-q1", status: "idle", archivedAt: null, pendingPermissions: [{ id: "r", kind: "tool", name: "Bash", input: {} }] };
  expect(code(await x.message({ sessionId: "s2" }))).toBe("SESSION_WAITING_ON_USER");
  expect(code(await x.message({ sessionId: "s1" }))).toBeUndefined();
});

test("flowly_message_card is gated like every dispatcher write (DISPATCHER-SPEC §4)", async () => {
  const x = await withSessions();
  x.server.cards.on = async () => false;
  expect(code(await x.message({}))).toBe("AGENT_CARDS_DISABLED");
  x.server.cards.on = async () => true;
  expect(code(await x.message({ projectId: "z", taskId: "z1" }))).toBe("PROJECT_ARCHIVED");
  expect(code(await x.message({ projectId: "gone" }))).toBe("ROOT_UNAVAILABLE");
  expect(code(await x.message({ projectId: "nope" }))).toBe("NOT_FOUND");
  expect(code(await x.message({ taskId: "t" }))).toBe("CARD_NOT_FOUND");
  expect(code(await x.message({ projectId: "r", taskId: "q1" }))).toBe("CARD_NOT_FOUND");
  expect(x.sent).toEqual([]);
  // A board token cannot call it.
  const card = await x.connect(x.server.secrets.boardCredential({ agentId: "actor", workspaceId: "w", projectId: "p" }));
  expect(await card.names()).not.toContain("flowly_message_card");
});

test("flowly_message_card: 30 per hour, its own bucket; refusals and failed sends give the slot back (DISPATCHER-SPEC §5.3)", async () => {
  const x = await withSessions();
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  x.server.dispatcherTools.clock = () => now;
  expect(code(await x.message({ taskId: "q2" }))).toBe("NO_LIVE_SESSION");
  x.failSend(true);
  expect(code(await x.message({}))).toBe("SEND_FAILED");
  x.failSend(false);
  for (let i = 0; i < 30; i++) expect(code(await x.message({})), `#${i + 1}`).toBeUndefined();
  const over = await x.message({});
  expect(code(over)).toBe("MESSAGE_LIMIT");
  expect(over.structuredContent.error.message).toContain("30");
  expect(x.sent.length).toBe(30);
  // The card bucket is untouched, and an hour later there is room again.
  expect(code(await x.d.call("flowly_create_card", { projectId: "q", title: "Still fine", idempotencyKey: "k-msg" }))).toBeUndefined();
  now += 3_600_001;
  expect(code(await x.message({}))).toBeUndefined();
});

test("flowly_message_card works per group: another group's card is refused, each session has its own bucket (DISPATCHER-SPEC §5.3)", async () => {
  const x = await setup();
  const { agentId, a, b } = await twoGroups(x);
  x.agents.s1 = { id: "s1", workspaceId: "w-q1", status: "idle", archivedAt: null };
  const toQ1 = (c: typeof a) => c.call("flowly_message_card", { projectId: "q", taskId: "q1", text: "integrate" });
  expect(code(await toQ1(b))).toBe("PROJECT_OUT_OF_GROUP");
  expect(x.sent).toEqual([]);
  // B's bucket full does not touch A's.
  for (let i = 0; i < 30; i++) x.server.dispatcherTools["reserveMessage"](agentId);
  expect(code(await toQ1(a))).toBeUndefined();
  expect(x.sent.map((m) => m.id)).toEqual(["s1"]);
});

/** flowly_manage_groups (DISPATCHER-SPEC §0, §5.2): the confirmed board group tool and its refusals. */
test("flowly_manage_groups is confirmed on every call, never preapproved (DISPATCHER-SPEC §5.2)", async () => {
  expect(dispatcherConfirmedToolNames).toContain("flowly_manage_groups");
  expect(dispatcherToolNames as readonly string[]).not.toContain("flowly_manage_groups");
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(await d.names()).toContain("flowly_manage_groups");
  expect(code(await d.call("flowly_manage_groups", { action: "create", name: "Shown" }))).toBeUndefined();
});

test("flowly_manage_groups runs only in a permission mode that asks, and only while agent cards are on (DISPATCHER-SPEC §5.2)", async () => {
  const x = await setup();
  const { clients, agentId, b } = await twoGroups(x);
  const before = JSON.stringify((await x.store.read()).groups);
  const rename = { action: "rename", groupId: clients.id, revision: clients.revision, name: "Nope" } as const;
  for (const mode of ["bypassPermissions", "auto", "some-new-mode", null]) {
    x.agents[agentId].currentModeId = mode;
    const result = await b.call("flowly_manage_groups", rename);
    expect(code(result), String(mode)).toBe("CONFIRMATION_UNAVAILABLE");
  }
  expect(JSON.stringify((await x.store.read()).groups)).toBe(before);
  // The switch is checked before the mode: with cards off, the answer is AGENT_CARDS_DISABLED in any mode.
  x.agents[agentId].currentModeId = "bypassPermissions";
  x.server.cards.on = async () => false;
  expect(code(await b.call("flowly_manage_groups", rename))).toBe("AGENT_CARDS_DISABLED");
  x.server.cards.on = async () => true;
  x.agents[agentId].currentModeId = "default";
  expect(code(await b.call("flowly_manage_groups", { action: "create", name: "On" }))).toBeUndefined();
});

test("flowly_manage_groups: 10 calls per dispatcher hour in their own bucket; a refusal gives its slot back (DISPATCHER-SPEC §5.2)", async () => {
  const x = await setup();
  const { b } = await twoGroups(x);
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  x.server.dispatcherTools.clock = () => now;
  for (let i = 0; i < 3; i++)
    expect(code(await b.call("flowly_manage_groups", { action: "rename", groupId: "nope", revision: 1, name: "x" }))).toBe("GROUP_NOT_FOUND");
  for (let i = 1; i <= 10; i++) expect(code(await b.call("flowly_manage_groups", { action: "create", name: `Team ${i}` })), `#${i}`).toBeUndefined();
  expect(code(await b.call("flowly_manage_groups", { action: "create", name: "Too many" }))).toBe("GROUP_LIMIT");
  // Its own bucket: the card bucket is untouched.
  expect(code(await b.call("flowly_create_card", { projectId: "r", title: "Still fine", idempotencyKey: "k-group-bucket" }))).toBeUndefined();
  now += 3_600_001;
  expect(code(await b.call("flowly_manage_groups", { action: "create", name: "Too many" }))).toBeUndefined();
});

test("flowly_manage_groups create, rename and set_default keep the group rules (BOARD-GROUPS-SPEC §2)", async () => {
  const x = await setup();
  const { clients, b } = await twoGroups(x);
  expect(code(await b.call("flowly_manage_groups", { action: "create", name: "clients" }))).toBe("NAME_TAKEN");
  expect(code(await b.call("flowly_manage_groups", { action: "rename", groupId: clients.id, revision: 99, name: "Late" }))).toBe("REVISION_CONFLICT");
  const renamed = await b.call("flowly_manage_groups", { action: "rename", groupId: clients.id, revision: clients.revision, name: "Partners" });
  expect(code(renamed)).toBeUndefined();
  expect(renamed.structuredContent).toMatchObject({ action: "rename", groupId: clients.id, name: "Partners", revision: clients.revision + 1 });
  const promoted = await b.call("flowly_manage_groups", { action: "set_default", groupId: clients.id, revision: clients.revision + 1 });
  expect(code(promoted)).toBeUndefined();
  const groups = (await x.store.read()).groups;
  expect(groups.find((g) => g.id === clients.id)?.isDefault).toBe(true);
  expect(groups.filter((g) => g.isDefault)).toHaveLength(1);
});

test("flowly_manage_groups refuses the caller's own group, the default group and a group with a live dispatcher (DISPATCHER-SPEC §0, §5.2)", async () => {
  const x = await setup();
  const { clients, agentId, a, b } = await twoGroups(x);
  const defaultGroup = (await x.store.read()).groups.find((g) => g.id === x.groupId)!;
  const before = JSON.stringify(await x.store.read());
  expect(code(await b.call("flowly_manage_groups", { action: "delete", groupId: clients.id, revision: clients.revision }))).toBe("GROUP_PROTECTED");
  expect(code(await a.call("flowly_manage_groups", { action: "delete", groupId: x.groupId, revision: defaultGroup.revision }))).toBe("GROUP_PROTECTED");
  expect(code(await b.call("flowly_manage_groups", { action: "delete", groupId: x.groupId, revision: defaultGroup.revision }))).toBe("DEFAULT_REQUIRED");
  // A live dispatcher (running, idle, closed) blocks the delete; the tool never archives it.
  for (const status of ["running", "idle", "closed"]) {
    x.agents[agentId].status = status;
    expect(code(await a.call("flowly_manage_groups", { action: "delete", groupId: clients.id, revision: clients.revision })), status).toBe("GROUP_BUSY");
  }
  expect(x.agents[agentId].archivedAt).toBeNull();
  expect(JSON.stringify(await x.store.read())).toBe(before);
  // Once its dispatcher is archived (a dead one), the delete goes through: its projects move to the default group.
  x.agents[agentId].archivedAt = stamp;
  const deleted = await a.call("flowly_manage_groups", { action: "delete", groupId: clients.id, revision: clients.revision });
  expect(code(deleted)).toBeUndefined();
  expect(deleted.structuredContent).toEqual({ action: "delete", groupId: clients.id, movedTo: x.groupId, projectIds: ["r"] });
  expect((await x.store.read()).groups.some((g) => g.id === clients.id)).toBe(false);
});

test("flowly_manage_groups set_members replaces the member list in one write (DISPATCHER-SPEC §0, §5.2)", async () => {
  const x = await setup();
  const { clients, a, b } = await twoGroups(x);
  // Default: p, q, gone, and the archived z. Clients: r.
  const members = async (groupId: string) => (await x.store.read()).projects.filter((p) => p.groupId === groupId).map((p) => p.id).sort();
  const setMembers = (groupId: string, revision: number, projectIds: string[], caller = b) =>
    caller.call("flowly_manage_groups", { action: "set_members", groupId, revision, projectIds });
  // Listed projects move in from their groups; the group's left-out members (none) go to the default group.
  const added = await setMembers(clients.id, clients.revision, ["r", "q"]);
  expect(code(added)).toBeUndefined();
  expect(added.structuredContent).toMatchObject({ action: "set_members", groupId: clients.id, revision: clients.revision + 1 });
  expect(await members(clients.id)).toEqual(["q", "r"]);
  expect(await members(x.groupId)).toEqual(["gone", "p", "z"]);
  // A member left out goes to the default group, a listed one moves in.
  const replaced = await setMembers(clients.id, clients.revision + 1, ["p"]);
  expect(code(replaced)).toBeUndefined();
  expect(await members(clients.id)).toEqual(["p"]);
  expect(await members(x.groupId)).toEqual(["gone", "q", "r", "z"]);
  // A stale revision is refused and writes nothing.
  expect(code(await setMembers(clients.id, clients.revision, ["r"]))).toBe("REVISION_CONFLICT");
  // An archived project that is not already a member can't join.
  expect(code(await setMembers(clients.id, clients.revision + 2, ["z"]))).toBe("PROJECT_ARCHIVED");
  // An unknown project refuses the whole list: nothing moves.
  const before = JSON.stringify(await x.store.read());
  expect(code(await setMembers(clients.id, clients.revision + 2, ["p", "nope"]))).toBe("NOT_FOUND");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  // The default group only adds: leaving "gone" out is refused, adding p from Clients is not.
  const defaultGroup = (await x.store.read()).groups.find((g) => g.id === x.groupId)!;
  expect(code(await a.call("flowly_manage_groups", { action: "set_members", groupId: x.groupId, revision: defaultGroup.revision, projectIds: ["q", "r", "z"] }))).toBe(
    "DEFAULT_REQUIRED",
  );
  const grown = await a.call("flowly_manage_groups", {
    action: "set_members",
    groupId: x.groupId,
    revision: defaultGroup.revision,
    projectIds: ["gone", "p", "q", "r", "z"],
  });
  expect(code(grown)).toBeUndefined();
  expect(await members(x.groupId)).toEqual(["gone", "p", "q", "r", "z"]);
  expect(await members(clients.id)).toEqual([]);
});


test("flowly_manage_groups delete never archives a dispatcher, even one that reads live after a dead read (DISPATCHER-SPEC §0)", async () => {
  const x = await setup();
  const { clients, agentId, a } = await twoGroups(x);
  // First read: archived (dead). Any later read: running. The tool must not archive it.
  x.agents[agentId].archivedAt = stamp;
  const agents = x.paseo.agents as unknown as { ref: (id: string) => { refresh: () => Promise<unknown>; archive?: () => Promise<void> } };
  const ref = agents.ref;
  let reads = 0;
  let archived = false;
  agents.ref = (id) => {
    const real = ref(id);
    return id === agentId
      ? { ...real, refresh: async () => (reads++ === 0 ? { agent: { ...x.agents[agentId], archivedAt: stamp } } : { agent: { ...x.agents[agentId], archivedAt: null, status: "idle" } }), archive: async () => { archived = true; } }
      : real;
  };
  const result = await a.call("flowly_manage_groups", { action: "delete", groupId: clients.id, revision: clients.revision });
  expect(code(result)).toBeUndefined();
  expect(archived).toBe(false);
});

test("flowly_manage_groups set_members hands each moved project to projectMoved (BOARD-GROUPS-SPEC §7)", async () => {
  const x = await setup();
  const { clients, b } = await twoGroups(x);
  const moved: [string, string][] = [];
  const dispatcher = x.server.dispatcher;
  const real = dispatcher.projectMoved.bind(dispatcher);
  dispatcher.projectMoved = async (projectId: string, toGroupId: string) => {
    moved.push([projectId, toGroupId]);
    return real(projectId, toGroupId);
  };
  const result = await b.call("flowly_manage_groups", { action: "set_members", groupId: clients.id, revision: clients.revision, projectIds: ["q", "r"] });
  expect(code(result)).toBeUndefined();
  expect(moved).toEqual([["q", clients.id]]);
});

test("a membership change bumps every group it touches, so a stale set_members is refused (DISPATCHER-SPEC §5.2)", async () => {
  const x = await setup();
  const { clients, b } = await twoGroups(x);
  const revisionOf = async (groupId: string) => (await x.store.read()).groups.find((g) => g.id === groupId)!.revision;
  const defaultRevision = await revisionOf(x.groupId);
  // The UI moves q into Clients: Clients (target) and the default group (source) both change.
  const q = (await x.store.read()).projects.find((p) => p.id === "q")!;
  await x.store.setProjectGroup({ projectId: "q", revision: q.revision, groupId: clients.id });
  expect(await revisionOf(clients.id)).toBe(clients.revision + 1);
  expect(await revisionOf(x.groupId)).toBe(defaultRevision + 1);
  // A dispatcher that still holds Clients at its old revision is refused: nothing is undone.
  const before = JSON.stringify(await x.store.read());
  expect(code(await b.call("flowly_manage_groups", { action: "set_members", groupId: clients.id, revision: clients.revision, projectIds: ["r"] }))).toBe("REVISION_CONFLICT");
  expect(JSON.stringify(await x.store.read())).toBe(before);
  // The same happens when a project leaves the group in the UI (the source changes).
  const r = (await x.store.read()).projects.find((p) => p.id === "r")!;
  await x.store.setProjectGroup({ projectId: "r", revision: r.revision, groupId: x.groupId });
  expect(await revisionOf(clients.id)).toBe(clients.revision + 2);
  // A set_members that moves nothing does not bump anything.
  const current = await revisionOf(clients.id);
  const fresh = await b.call("flowly_manage_groups", { action: "set_members", groupId: clients.id, revision: current, projectIds: [] });
  expect(code(fresh)).toBeUndefined();
  expect(await revisionOf(clients.id)).toBe(current + 1);
  expect(await revisionOf(x.groupId)).toBeGreaterThan(defaultRevision + 1);
});

/** flowly_reply_to_agent (DISPATCHER-SPEC §5.4): answers only an agent that wrote to the dispatcher. */
async function withPrompts() {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  let now = Date.parse("2026-11-12T12:00:00.000Z");
  x.server.dispatcherTools.clock = () => now;
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  let seq = 0;
  /** A prompt from `id` in the dispatcher's timeline, `msAgo` before now. */
  const prompt = (id: string, msAgo = 60_000, title?: string) =>
    (x.timelines.disp ??= []).push({
      seqStart: ++seq,
      seqEnd: seq,
      timestamp: iso(msAgo),
      item: { type: "tool_call", name: "agent_message", callId: `paseo-agent-message:${seq}`, status: "completed", agentMessage: { sender: { id, ...(title ? { title } : {}) }, text: "How is it going?", event: "message" } },
    });
  const filler = (n: number, msAgo = 30_000) => {
    for (let i = 0; i < n; i++) (x.timelines.disp ??= []).push({ seqStart: ++seq, seqEnd: seq, timestamp: iso(msAgo), item: { type: "assistant_message", text: "…" } });
  };
  x.agents.bot = { id: "bot", workspaceId: "bot-ws", status: "idle", archivedAt: null };
  const reply = (args: Record<string, unknown> = {}) => d.call("flowly_reply_to_agent", { agentId: "bot", text: "On it.", ...args });
  return { ...x, d, reply, prompt, filler, advance: (ms: number) => (now += ms) };
}

test("flowly_reply_to_agent steers a prefixed reply to an agent that wrote to the dispatcher (DISPATCHER-SPEC §5.4)", async () => {
  const x = await withPrompts();
  x.prompt("bot", 60_000, "Ops");
  const result = await x.reply({ text: "  Two cards run; nothing waits.  " });
  expect(code(result)).toBeUndefined();
  expect(result.structuredContent).toEqual({ sent: true, agentId: "bot", note: replyOnceNote });
  // The sender also gets the dispatcher's final turn text from Paseo, so the result tells it not to repeat the reply there.
  expect(replyOnceNote).toMatch(/final turn text/);
  expect(replyOnceNote).toMatch(/don't repeat/);
  expect(x.sent).toEqual([{ id: "bot", text: `${dispatcherMessagePrefix}Two cards run; nothing waits.`, options: { activeTurnBehavior: "steer" } }]);
  // It reads only its own timeline to know who wrote to it.
  expect(new Set(x.timelineReads.map((r) => r.id))).toEqual(new Set(["disp"]));
});

test("flowly_reply_to_agent finds a prompt deep in a long day, page by page (DISPATCHER-SPEC §5.4)", async () => {
  const x = await withPrompts();
  x.prompt("bot", 20 * 3_600_000);
  x.filler(450);
  expect(code(await x.reply())).toBeUndefined();
  expect(x.timelineReads.filter((r) => r.direction === "before").length).toBeGreaterThan(0);
});

test("flowly_reply_to_agent never starts a conversation, reaches a card or a dispatcher (DISPATCHER-SPEC §5.4)", async () => {
  const x = await withPrompts();
  // Nobody wrote: refused.
  const none = await x.reply();
  expect(code(none)).toBe("REPLY_NOT_ALLOWED");
  expect(none.structuredContent.error.message).toMatch(/only answer an agent that messaged you/i);
  // A prompt older than 24 hours no longer counts; another agent's prompt does not open this one.
  x.prompt("bot", 24 * 3_600_000 + 1);
  x.prompt("someone-else");
  expect(code(await x.reply())).toBe("REPLY_NOT_ALLOWED");
  // Itself, even if its own id showed up as a sender.
  x.prompt("disp");
  expect(code(await x.reply({ agentId: "disp" }))).toBe("REPLY_NOT_ALLOWED");
  // A card's session that wrote to it: refused, flowly_message_card is the route to a card.
  x.agents.s1 = { id: "s1", workspaceId: "w-q1", status: "idle", archivedAt: null };
  x.prompt("s1");
  const card = await x.reply({ agentId: "s1" });
  expect(code(card)).toBe("REPLY_NOT_ALLOWED");
  expect(card.structuredContent.error.message).toContain("flowly_message_card");
  // Another dispatcher session (one in the dispatcher workspace).
  x.agents.d2 = { id: "d2", workspaceId: "dw", status: "idle", archivedAt: null };
  x.prompt("d2");
  expect(code(await x.reply({ agentId: "d2" }))).toBe("REPLY_NOT_ALLOWED");
  // A sender that is gone or archived.
  x.prompt("ghost");
  expect(code(await x.reply({ agentId: "ghost" }))).toBe("AGENT_NOT_FOUND");
  x.agents.old = { id: "old", workspaceId: "bot-ws", status: "idle", archivedAt: stamp };
  x.prompt("old");
  expect(code(await x.reply({ agentId: "old" }))).toBe("AGENT_NOT_FOUND");
  expect(x.sent).toEqual([]);
});

test("flowly_reply_to_agent never answers an agent that waits on the user (DISPATCHER-SPEC §5.4)", async () => {
  const x = await withPrompts();
  x.prompt("bot");
  x.agents.bot.pendingPermissions = [{ id: "req-1", kind: "question", name: "AskUserQuestion", input: {} }];
  expect(code(await x.reply())).toBe("SESSION_WAITING_ON_USER");
  x.agents.bot.pendingPermissions = [{ id: "req-2", kind: "tool", name: "Bash", input: {} }];
  expect(code(await x.reply())).toBe("SESSION_WAITING_ON_USER");
  expect(x.sent).toEqual([]);
  x.agents.bot.pendingPermissions = [];
  expect(code(await x.reply())).toBeUndefined();
});

test("flowly_reply_to_agent: per-agent and hourly caps stop two bots looping; refusals and failed sends give the slot back (DISPATCHER-SPEC §5.4)", async () => {
  const x = await withPrompts();
  expect(dispatcherRepliesPerAgentPerHour).toBe(5);
  x.prompt("bot");
  x.failSend(true);
  expect(code(await x.reply())).toBe("SEND_FAILED");
  x.failSend(false);
  for (let i = 0; i < dispatcherRepliesPerAgentPerHour; i++) expect(code(await x.reply()), `#${i + 1}`).toBeUndefined();
  const over = await x.reply();
  expect(code(over)).toBe("REPLY_LIMIT");
  expect(over.structuredContent.error.message).toContain(`${dispatcherRepliesPerAgentPerHour}`);
  // The shared cap across agents.
  const others = Array.from({ length: 10 }, (_, i) => `bot${i}`);
  for (const id of others) {
    x.agents[id] = { id, workspaceId: "bot-ws", status: "idle", archivedAt: null };
    x.prompt(id);
  }
  let sentTotal = dispatcherRepliesPerAgentPerHour;
  outer: for (const id of others)
    for (let i = 0; i < dispatcherRepliesPerAgentPerHour; i++) {
      const r = await x.reply({ agentId: id });
      if (code(r) === "REPLY_LIMIT") {
        expect(r.structuredContent.error.message).toContain(`${dispatcherRepliesPerHour}`);
        break outer;
      }
      expect(code(r)).toBeUndefined();
      sentTotal++;
    }
  expect(sentTotal).toBe(dispatcherRepliesPerHour);
  expect(x.sent.length).toBe(dispatcherRepliesPerHour);
  // flowly_message_card has its own bucket; an hour later there is room again.
  x.agents.s1 = { id: "s1", workspaceId: "w-q1", status: "idle", archivedAt: null };
  expect(code(await x.d.call("flowly_message_card", { projectId: "q", taskId: "q1", text: "integrate" }))).toBeUndefined();
  x.advance(3_600_001);
  expect(code(await x.reply())).toBeUndefined();
});

test("flowly_reply_to_agent is gated like every dispatcher write, and only the dispatcher has it (DISPATCHER-SPEC §4, §5.4)", async () => {
  const x = await withPrompts();
  x.prompt("bot");
  x.server.cards.on = async () => false;
  expect(code(await x.reply())).toBe("AGENT_CARDS_DISABLED");
  x.server.cards.on = async () => true;
  expect((await x.reply({ text: "   " })).isError).toBe(true);
  expect(x.sent).toEqual([]);
  const card = await x.connect(x.server.secrets.boardCredential({ agentId: "actor", workspaceId: "w", projectId: "p" }));
  expect(await card.names()).not.toContain("flowly_reply_to_agent");
  // Preapproved by name like the other tools: a dispatcher saved without it shows the new-tools warning.
  expect(dispatcherToolNames).toContain("flowly_reply_to_agent");
});


test("the dispatcher's card tools accept linearTicket (LINEAR-TICKET-SPEC §5)", () => {
  expect(dispatcherInputs.createCard.parse({ projectId: "p", title: "Audit", idempotencyKey: "k1", linearTicket: false })).toMatchObject({ linearTicket: false });
  expect(dispatcherInputs.updateCard.parse({ projectId: "p", taskId: "t", revision: 1, linearTicket: true })).toMatchObject({ linearTicket: true });
});
