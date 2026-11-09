import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { ToolServer } from "./tool-server";
import { agentFixture } from "./agent-fixture";

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
  "flowly_start_card",
  "flowly_propose_idea",
  "flowly_link_cards",
];

async function setup() {
  const fixture = await agentFixture();
  // The dispatcher folder of a Paseo home of its own, outside the fixture's data folder (DISPATCHER-SPEC §2).
  const dispatcherPath = join(fixture.root, "paseo-home", "flowly-dispatcher", "dispatcher");
  await mkdir(dispatcherPath, { recursive: true });
  const server = new ToolServer(fixture.store, dispatcherPath);
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
  // The stored dispatcher: agent "disp" in workspace "dw".
  await writeFile(
    join(fixture.store.directory, "dispatcher.json"),
    JSON.stringify({ version: 1, workspaceId: "dw", agentId: "disp", startedAt: stamp }),
  );
  const agents: Record<string, { id: string; workspaceId: string; status: string; archivedAt: string | null; lastUsage?: unknown }> = {
    disp: { id: "disp", workspaceId: "dw", status: "idle", archivedAt: null },
    actor: { id: "actor", workspaceId: "w", status: "idle", archivedAt: null },
  };
  const createdWorkspaces: { title: string; source: { kind: string; projectId?: string } }[] = [];
  /** The MCP servers each created session launched with: its saved ones plus what the plugin's open hook adds. */
  const launched: Record<string, Record<string, unknown>> = {};
  /** The tool policy each created session was saved with. */
  const policies: Record<string, unknown> = {};
  const paseo = {
    ...(fixture.paseo as unknown as Record<string, unknown>),
    agents: {
      ref: (id: string) => ({ refresh: async () => (agents[id] ? { agent: { ...agents[id] } } : null) }),
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
            const added = await server.dispatcherSession(options.agentId, paseo);
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
  return { ...fixture, server, paseo, agents, url, createdWorkspaces, launched, policies, connect, dispatcherToken };
}

const code = (result: { isError?: boolean; structuredContent?: { error?: { code?: string } } }) =>
  result.isError ? result.structuredContent?.error?.code : undefined;

test("a dispatcher token can write to any live project", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(await d.names()).toEqual(dispatcherTools);
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
    ["flowly_start_card", { taskId: "z1", idempotencyKey: "s-z" }],
    ["flowly_propose_idea", { title: "Nope", detail: "x", rationale: "y" }],
    ["flowly_link_cards", { taskId: "z1", relation: "blocks", otherTaskId: "q1" }],
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
    ["flowly_start_card", { taskId: "q1", idempotencyKey: "s-off" }],
    ["flowly_link_cards", { taskId: "q1", relation: "blocks", otherTaskId: "q2" }],
    ["flowly_propose_idea", { title: "Nope", detail: "x", rationale: "y" }],
  ];
  for (const [name, args] of writes) expect(code(await d.call(name, { projectId: "q", ...args })), name).toBe("AGENT_CARDS_DISABLED");
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
  x.agents.disp.status = "closed";
  const { agentId } = await x.server.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Saved once, with the session: the open hook adds nothing, so Paseo's name check is never tripped.
  expect(await x.server.dispatcherSession(agentId, x.paseo)).toBeNull();
  expect(Object.keys(x.launched[agentId])).toEqual(["flowly-dispatcher"]);
  const server = x.launched[agentId]["flowly-dispatcher"] as { type: string; headers: { Authorization: string } };
  expect(server.type).toBe("http");
  const fresh = await x.connect(server.headers.Authorization.replace(/^Bearer /, ""));
  expect(code(await fresh.call("flowly_list_projects", {}))).toBeUndefined();
  // Exactly the tools that credential lists, each preapproved by name on that server; nothing else.
  const listed = (await fresh.names()).sort();
  const policy = x.policies[agentId] as { preapproved: { kind: string; server: string; tool: string }[] };
  expect(policy.preapproved.map((g) => g.tool).sort()).toEqual(listed);
  expect(policy.preapproved.every((g) => g.kind === "mcp" && g.server === "flowly-dispatcher")).toBe(true);
});

test("a dispatcher started before its tools were saved still gets them from the open hook (DISPATCHER-SPEC §3)", async () => {
  const x = await setup();
  // The stored "disp" record has no savedTools mark.
  expect(await x.server.dispatcherSession("disp", x.paseo)).toMatchObject({ type: "http" });
  expect(await x.server.dispatcherSession("actor", x.paseo)).toBeNull();
});

test("a dispatcher token from a replaced dispatcher is refused", async () => {
  const x = await setup();
  const d = await x.connect(x.dispatcherToken);
  expect(code(await d.call("flowly_list_projects", {}))).toBeUndefined();
  // The dispatcher session closed: a new one replaces it.
  x.agents.disp.status = "closed";
  const { agentId } = await x.server.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
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

test("a card or board token cannot call dispatcher tools", async () => {
  const x = await setup();
  const card = await x.connect(x.server.secrets.credential(x.identity));
  const cardNames = await card.names();
  expect(cardNames).not.toContain("flowly_list_projects");
  expect(cardNames).not.toContain("flowly_link_cards");
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
