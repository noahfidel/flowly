import { afterEach, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Dispatcher, RECHECK_MAX_MS, dispatcherFolder, dispatcherState, isDeadDispatcher, wireDispatcher } from "./dispatcher";
import { dispatcherSessionIds } from "./dispatcher-items";
import { EventBus, NoteBatcher, type BusFact } from "./event-bus";
import { BoardService } from "./service";
import { agentFixture } from "./agent-fixture";
import { dispatcherBuiltinTools, dispatcherCharter, dispatcherToolNames, dispatcherWithheldTools, userSendOptions, type DispatcherNote } from "../shared/dispatcher";
import type { BoardEvent } from "../shared/model";

const directories: string[] = [];
const dispatchers: Dispatcher[] = [];
afterEach(async () => {
  for (const d of dispatchers.splice(0)) d.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Agent = {
  id: string;
  workspaceId: string;
  status: string;
  archivedAt: string | null;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };
  pendingPermissions?: unknown[];
};

/** A fake Paseo that records workspace creations, archives, agent creations and sends. */
function fakePaseo() {
  const agents = new Map<string, Agent>();
  const workspaces = new Map<string, { id: string; archivingAt: string | null; workspaceDirectory?: string }>();
  const created: Record<string, unknown>[] = [];
  const archived: string[] = [];
  const agentCreates: { workspaceId: string; options: Record<string, unknown> }[] = [];
  const sends: { id: string; text: string; options: unknown }[] = [];
  let createError: Error | null = null;
  let sendError: Error | null = null;
  let agentCreateError: Error | null = null;
  const paseo = {
    workspaces: {
      create: async (request: Record<string, unknown>) => {
        created.push(request);
        if (createError) throw createError;
        const id = `dw-${created.length}`;
        workspaces.set(id, { id, archivingAt: null, workspaceDirectory: (request.source as { path: string }).path });
        return { id };
      },
      archive: async (id: string) => {
        archived.push(id);
        return { workspaceId: id, archivedAt: "now", error: null, requestId: "r" };
      },
      ref: (id: string) => ({
        refresh: async () => workspaces.get(id) ?? null,
        archive: async () => {
          archived.push(id);
          return { workspaceId: id, archivedAt: "now", error: null, requestId: "r" };
        },
        agents: {
          create: async (options: Record<string, unknown>) => {
            agentCreates.push({ workspaceId: id, options });
            if (agentCreateError) throw agentCreateError;
            const agentId = options.agentId as string;
            agents.set(agentId, { id: agentId, workspaceId: id, status: "running", archivedAt: null });
            return { id: agentId };
          },
        },
      }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.get(id);
          return agent ? { agent: { ...agent } } : null;
        },
        send: async (text: string, options?: unknown) => {
          if (sendError) throw sendError;
          sends.push({ id, text, options });
        },
        archive: async () => {
          archived.push(`agent:${id}`);
          const agent = agents.get(id);
          if (agent) agent.archivedAt = "now";
          return { archivedAt: "now" };
        },
      }),
    },
  } as unknown as PaseoApi;
  return {
    paseo,
    agents,
    workspaces,
    created,
    archived,
    agentCreates,
    sends,
    failCreate: (e: Error | null) => (createError = e),
    failAgentCreate: (e: Error | null) => (agentCreateError = e),
    failSend: (e: Error | null) => (sendError = e),
  };
}

/** A Paseo home with the plugin data folder at its usual place, and the dispatcher folder derived from that home. */
async function setup(summary: () => Promise<string> = async () => "Board summary", folderOf: (home: string, directory: string) => string = (home) => dispatcherFolder(home)) {
  const home = await mkdtemp(join(tmpdir(), "flowly-paseo-home-"));
  directories.push(home);
  const directory = join(home, "plugin-data", "flowly");
  await mkdir(directory, { recursive: true });
  const folder = folderOf(home, directory);
  const fake = fakePaseo();
  const dispatcher = new Dispatcher(
    directory,
    {
      summary,
      mcp: async (identity) => ({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: `Bearer ${identity.agentId}` } }),
    },
    folder,
  );
  dispatchers.push(dispatcher);
  return { home, directory, folder, dispatcher, ...fake };
}

const note = (taskId: string, detail = "todo → in_review"): DispatcherNote => ({
  taskId,
  projectId: "p",
  title: `Card ${taskId}`,
  kind: "status_changed",
  detail,
  at: "2026-11-08T10:00:00.000Z",
});

test("start creates a background directory workspace once and reuses it", async () => {
  const x = await setup();
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "none", agentId: null });
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5", modeId: "default" });
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({
    title: "Flowly dispatcher",
    background: true,
    source: { kind: "directory", path: x.folder },
  });
  expect((x.created[0].source as Record<string, unknown>).projectId).toBeUndefined();
  expect(x.agentCreates).toHaveLength(1);
  expect(x.agentCreates[0]).toMatchObject({
    workspaceId: "dw-1",
    options: {
      agentId: first.agentId,
      title: "Flowly dispatcher",
      prompt: "Board summary",
      labels: { "flowly-dispatcher": "1" },
      config: {
        provider: "claude/claude-sonnet-5-5",
        modeId: "default",
        systemPrompt: dispatcherCharter,
        // Its tools are saved with the session, each one preapproved, so they never prompt (§3).
        mcpServers: { "flowly-dispatcher": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: `Bearer ${first.agentId}` } } },
        toolPolicy: { preapproved: dispatcherToolNames.map((tool) => ({ kind: "mcp", server: "flowly-dispatcher", tool })) },
      },
    },
  });
  const stored = JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8"));
  // The record keeps the tool list it was saved with, to tell when a later build lists more (§1, §3).
  expect(stored).toMatchObject({ version: 1, workspaceId: "dw-1", agentId: first.agentId, savedTools: [...dispatcherToolNames] });
  expect(typeof stored.startedAt).toBe("string");
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "running", agentId: first.agentId });
  // A second start while it runs is refused: there is one dispatcher.
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  // Once it ended, a new one starts in the same workspace.
  x.agents.get(first.agentId)!.archivedAt = "2026-11-08T11:00:00.000Z";
  expect((await x.dispatcher.status(x.paseo)).state).toBe("ended");
  const second = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(second.agentId).not.toBe(first.agentId);
  expect(x.created).toHaveLength(1);
  expect(x.agentCreates[1].workspaceId).toBe("dw-1");
  // A workspace Paseo no longer returns is replaced.
  x.workspaces.delete("dw-1");
  x.agents.get(second.agentId)!.status = "closed";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.created).toHaveLength(2);
  expect(JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")).workspaceId).toBe("dw-2");
});

test("the workspace is never archived", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.deliver([note("t1")], x.paseo);
  await x.dispatcher.turnEnded(agentId, x.paseo);
  x.agents.get(agentId)!.status = "closed";
  await x.dispatcher.status(x.paseo);
  await x.dispatcher.deliver([note("t2")], x.paseo);
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Only the dead session is archived, never the workspace.
  expect(x.archived).toEqual([`agent:${agentId}`]);
  expect(await x.dispatcher.owns("dw-1")).toBe(true);
  expect(await x.dispatcher.owns("other")).toBe(false);
  // The dispatcher workspace can never be bound to a card, so no card archive path reaches it.
  const fixture = await agentFixture();
  directories.push(fixture.root);
  const service = new BoardService(fixture.store);
  service.reservedWorkspace = (id) => x.dispatcher.owns(id);
  await expect(
    service.createTask(
      { projectId: "p", operationId: "bind-dispatcher", title: "Bind", description: "", status: "todo", priority: "normal", mode: "existing", workspaceId: "dw-1", baseRef: "" },
      fixture.paseo,
    ),
  ).rejects.toThrow("Flowly dispatcher");
});

test("one long-lived dispatcher: dead means archived, closed or missing", () => {
  expect(isDeadDispatcher(null)).toBe(true);
  expect(isDeadDispatcher(undefined)).toBe(true);
  expect(isDeadDispatcher({ status: "idle", archivedAt: "2026-11-08T11:00:00.000Z" })).toBe(true);
  expect(isDeadDispatcher({ status: "closed", archivedAt: null })).toBe(true);
  for (const status of ["running", "initializing", "idle", "error"]) expect(isDeadDispatcher({ status, archivedAt: null }), status).toBe(false);
  // A full context is no state of its own: the session compacts and stays the dispatcher.
  const full = { status: "idle", archivedAt: null, lastUsage: { contextWindowUsedTokens: 99, contextWindowMaxTokens: 100 } };
  expect(dispatcherState(full)).toBe("idle");
  expect(dispatcherState({ status: "error", archivedAt: null })).toBe("idle");
  expect(dispatcherState({ status: "closed", archivedAt: null })).toBe("ended");
});

test("start is refused while the dispatcher is alive, including a full context or an error", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const agent = x.agents.get(agentId)!;
  agent.status = "idle";
  agent.lastUsage = { contextWindowUsedTokens: 99_000, contextWindowMaxTokens: 100_000 };
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  agent.status = "error";
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect(x.agentCreates).toHaveLength(1);
  expect(x.archived).toEqual([]);
});

test("a replacement archives the dead dispatcher (that id only, after a re-read) and remembers it", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  const second = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.archived).toEqual([`agent:${first.agentId}`]);
  // An already archived or missing session has nothing to archive.
  x.agents.get(second.agentId)!.archivedAt = "2026-11-08T12:00:00.000Z";
  const third = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.delete(third.agentId);
  const fourth = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.archived).toEqual([`agent:${first.agentId}`]);
  // The earlier sessions are remembered, newest last, without the current one.
  expect((await x.dispatcher.record()).previousAgentIds).toEqual([first.agentId, second.agentId, third.agentId]);
  expect(dispatcherSessionIds(await x.dispatcher.record())).toEqual([first.agentId, second.agentId, third.agentId, fourth.agentId]);
  // A session that came back between the status read and the archive is never archived: the start is refused.
  x.agents.get(fourth.agentId)!.status = "closed";
  let reads = 0;
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => {
        const ref = x.paseo.agents.ref(id);
        return {
          ...ref,
          refresh: async () => {
            const found = await ref.refresh();
            // The first read sees it closed; the re-read before archiving sees it running again.
            if (++reads > 1 && found?.agent) return { agent: { ...found.agent, status: "running" } };
            return found;
          },
        };
      },
    },
  } as unknown as PaseoApi;
  await expect(x.dispatcher.start(paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect(x.archived).toEqual([`agent:${first.agentId}`]);
  expect((await x.dispatcher.record()).agentId).toBe(fourth.agentId);
});

test("a dead dispatcher that cannot be archived is logged and still replaced", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => ({
        ...x.paseo.agents.ref(id),
        archive: async () => Promise.reject(new Error("socket closed")),
      }),
    },
  } as unknown as PaseoApi;
  const second = await x.dispatcher.start(paseo, { provider: "claude/claude-sonnet-5-5" });
  expect((await x.dispatcher.record()).agentId).toBe(second.agentId);
  expect(errors.mock.calls.some((c) => c[0] === "Flowly dispatcher: dead session not archived:")).toBe(true);
});

test("notes in the start window are held until Paseo has created the session", async () => {
  const x = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const paseo = {
    ...x.paseo,
    workspaces: {
      ...x.paseo.workspaces,
      ref: (id: string) => {
        const ref = x.paseo.workspaces.ref(id);
        return {
          ...ref,
          agents: {
            create: async (options: Record<string, unknown>) => {
              await gate;
              const made = await ref.agents.create(options as never);
              x.agents.get(made.id)!.status = "idle";
              return made;
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const starting = x.dispatcher.start(paseo, { provider: "claude/claude-sonnet-5-5" });
  // Wait until the record names the new session but Paseo has not created it yet.
  await vi.waitFor(async () => expect((await x.dispatcher.record()).agentId).toBeTruthy());
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends).toEqual([]);
  release();
  const { agentId } = await starting;
  // Once it exists and is idle, the held notes go out.
  await vi.waitFor(() => expect(x.sends).toHaveLength(1));
  expect(x.sends[0]).toMatchObject({ id: agentId });
  expect(x.sends[0].text).toContain("[t1]");
});

test("notes that arrive while a replacement takes its board summary are held for the new dispatcher", async () => {
  let gated = false;
  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => (summaryStarted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const x = await setup(async () => {
    if (gated) {
      summaryStarted();
      await gate;
    }
    return "Board summary";
  });
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  gated = true;
  const replacing = x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await started;
  // The summary is being written and the record still names the dead session.
  await x.dispatcher.deliver([note("t1")], x.paseo);
  release();
  const second = await replacing;
  x.agents.get(second.agentId)!.status = "idle";
  await x.dispatcher.turnEnded(second.agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0]).toMatchObject({ id: second.agentId });
  expect(x.sends[0].text).toContain("[t1]");
});

test("notes held while the read says running are re-checked slowly even without a turn end", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const agent = x.agents.get(agentId)!;
  agent.status = "idle";
  // A turn end with nothing held starts no chase.
  await x.dispatcher.turnEnded(agentId, x.paseo);
  // A batch arrives while Paseo's snapshot still says running, and no turn end follows.
  agent.status = "running";
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends).toEqual([]);
  agent.status = "idle";
  await vi.advanceTimersByTimeAsync(RECHECK_MAX_MS);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].text).toContain("[t1]");
  x.dispatcher.dispose();
});

test("notes wait for the turn to end and never steer", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.agents.get(agentId)!.status).toBe("running");
  await x.dispatcher.deliver([note("t1", "todo → blocked")], x.paseo);
  await x.dispatcher.deliver([note("t1", "blocked → in_review"), note("t2")], x.paseo);
  expect(x.sends).toEqual([]);
  // Another session's turn ending changes nothing.
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.turnEnded("someone-else", x.paseo);
  expect(x.sends).toEqual([]);
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  const sent = x.sends[0];
  expect(sent.id).toBe(agentId);
  expect(sent.text).toContain("Flowly board update (2 cards):");
  expect(sent.text).toContain('- "Card t1" [t1] in project p: status_changed — blocked → in_review');
  expect(sent.text).not.toContain("todo → blocked");
  expect(sent.text).toContain('- "Card t2" [t2] in project p');
  expect((sent.options as { activeTurnBehavior?: unknown } | undefined)?.activeTurnBehavior).toBeUndefined();
  // Held notes are sent once.
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  // While idle (and past the send cooldown) a batch goes out at once.
  await vi.advanceTimersByTimeAsync(8_000);
  await x.dispatcher.deliver([note("t3")], x.paseo);
  expect(x.sends).toHaveLength(2);
  expect((x.sends[1].options as { activeTurnBehavior?: unknown } | undefined)?.activeTurnBehavior).toBeUndefined();
});

test("notes are dropped while the dispatcher is down", async () => {
  const x = await setup();
  // No dispatcher yet.
  await x.dispatcher.deliver([note("t0")], x.paseo);
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Held while it runs, then it closes: the held notes are dropped, not replayed.
  await x.dispatcher.deliver([note("t1")], x.paseo);
  x.agents.get(agentId)!.status = "closed";
  await x.dispatcher.turnEnded(agentId, x.paseo);
  await x.dispatcher.deliver([note("t2")], x.paseo);
  // Archived counts as down too.
  x.agents.get(agentId)!.status = "idle";
  x.agents.get(agentId)!.archivedAt = "2026-11-08T11:00:00.000Z";
  await x.dispatcher.deliver([note("t3")], x.paseo);
  expect(x.sends).toEqual([]);
  // The new dispatcher hears only what arrives after it is up.
  const next = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(next.agentId)!.status = "idle";
  await x.dispatcher.deliver([note("t4")], x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].text).toContain("[t4]");
  for (const old of ["[t0]", "[t1]", "[t2]", "[t3]"]) expect(x.sends[0].text).not.toContain(old);
});

test("a failed send is dropped, not replayed", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  let fail = true;
  const sends: string[] = [];
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => ({
        ...x.paseo.agents.ref(id),
        send: async (text: string) => {
          if (fail) throw new Error("socket closed");
          sends.push(text);
        },
      }),
    },
  } as unknown as PaseoApi;
  await x.dispatcher.deliver([note("t1")], paseo);
  fail = false;
  await x.dispatcher.deliver([note("t2")], paseo);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toContain("[t2]");
  expect(sends[0]).not.toContain("[t1]");
});

test("a corrupt dispatcher.json is preserved and treated as empty", async () => {
  const x = await setup();
  await writeFile(join(x.directory, "dispatcher.json"), "{ not json");
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "none", agentId: null });
  const names = await readdir(x.directory);
  const kept = names.find((n) => n.startsWith("dispatcher.json.invalid-"));
  expect(kept).toBeTruthy();
  expect(await readFile(join(x.directory, kept!), "utf8")).toBe("{ not json");
  // A valid-JSON record with the wrong shape is kept too.
  const other = await setup();
  await writeFile(join(other.directory, "dispatcher.json"), JSON.stringify({ version: 2, agentId: 5 }));
  expect((await other.dispatcher.status(other.paseo)).state).toBe("none");
  expect((await readdir(other.directory)).some((n) => n.startsWith("dispatcher.json.invalid-"))).toBe(true);
  // The next start writes a fresh record.
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")).agentId).toBe(agentId);
});

test("a host without background workspaces gets a clear error and no record", async () => {
  const x = await setup();
  x.failCreate(new Error("Update the host to use background workspaces."));
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({
    code: "HOST_UNSUPPORTED",
    message: expect.stringContaining("Update Paseo"),
  });
  expect(x.created).toHaveLength(1);
  expect(x.agentCreates).toEqual([]);
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "none", agentId: null });
});

test("a session Paseo did not create leaves the earlier record", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  const paseo = {
    ...x.paseo,
    workspaces: {
      ...x.paseo.workspaces,
      ref: (id: string) => ({
        ...x.paseo.workspaces.ref(id),
        agents: {
          create: async () => {
            throw new Error("provider down");
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  await expect(x.dispatcher.start(paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toThrow("provider down");
  expect(JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")).agentId).toBe(first.agentId);
});

test("only stops reach the batcher and the dispatcher's own facts never do", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  const bus = new EventBus();
  const delivered: (readonly DispatcherNote[])[] = [];
  const deliver = vi.spyOn(x.dispatcher, "deliver").mockImplementation(async (notes) => {
    delivered.push(notes);
  });
  const dispose = wireDispatcher(bus, x.dispatcher, () => x.paseo);
  let seq = 0;
  const fact = (patch: Partial<BoardEvent>): BusFact => ({
    kind: "board",
    projectId: "p",
    title: `Card ${patch.taskId}`,
    event: { id: `e${++seq}`, taskId: "t1", actor: "agent", action: "status_changed", at: "2026-11-08T10:00:00.000Z", ...patch },
  });
  // A stop, then a non-stop on the same card: the stop survives.
  bus.publish([fact({ taskId: "t1", from: "development", to: "in_review" })]);
  bus.publish([fact({ taskId: "t1", action: "agent.turn_started" }), fact({ taskId: "t1", from: "in_review", to: "development" })]);
  // The dispatcher's own stop is not news to it.
  bus.publish([fact({ taskId: "t2", from: "todo", to: "blocked", agentId })]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(delivered[0]).toHaveLength(1);
  expect(delivered[0][0]).toMatchObject({ taskId: "t1", kind: "status_changed", detail: "development → in_review" });
  // After dispose nothing is delivered and pending notes are cleared.
  bus.publish([fact({ taskId: "t3", from: "todo", to: "blocked" })]);
  dispose();
  expect(bus.hasSubscribers()).toBe(false);
  await vi.advanceTimersByTimeAsync(70_000);
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("NoteBatcher.dispose drops pending notes and its timer", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const flush = vi.fn();
  const batcher = new NoteBatcher({ windowMs: 10_000, maxWaitMs: 60_000, exclude: () => null }, flush);
  batcher.push([{ kind: "board", projectId: "p", title: "x", event: { id: "e", taskId: "t", actor: "agent", action: "status_changed", to: "blocked", at: "now" } }]);
  batcher.dispose();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(flush).not.toHaveBeenCalled();
});

test("a pending permission holds notes like a running turn", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const agent = x.agents.get(agentId)!;
  agent.status = "idle";
  agent.pendingPermissions = [{ id: "perm-1" }];
  await x.dispatcher.deliver([note("t1")], x.paseo);
  // A send would answer (clear) the pending permission: hold instead.
  expect(x.sends).toEqual([]);
  agent.pendingPermissions = [];
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].text).toContain("[t1]");
});

test("turn_ended while the read still says running retries shortly, then backs off until it reads idle", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const agent = x.agents.get(agentId)!;
  await x.dispatcher.deliver([note("t1")], x.paseo);
  // The hook fired before Paseo's snapshot caught up.
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toEqual([]);
  agent.status = "idle";
  await vi.advanceTimersByTimeAsync(3_000);
  expect(x.sends).toHaveLength(1);
  // The turn-end read and the 2 s re-check both still say running: Flowly keeps looking, more slowly.
  agent.status = "running";
  await vi.advanceTimersByTimeAsync(10_000);
  await x.dispatcher.deliver([note("t2")], x.paseo);
  await x.dispatcher.turnEnded(agentId, x.paseo);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(x.sends).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(x.sends).toHaveLength(1);
  // Delivered without another turn end once a re-check reads idle; never more often than the cap.
  agent.status = "idle";
  await vi.advanceTimersByTimeAsync(RECHECK_MAX_MS);
  expect(x.sends).toHaveLength(2);
  expect(x.sends[1].text).toContain("[t2]");
  // Nothing held: no more re-checks.
  expect(vi.getTimerCount()).toBe(0);
  // Never into a pending permission either: the chase holds and keeps looking.
  agent.status = "running";
  await x.dispatcher.deliver([note("t3")], x.paseo);
  agent.status = "idle";
  agent.pendingPermissions = [{ id: "perm" }];
  await x.dispatcher.turnEnded(agentId, x.paseo);
  await vi.advanceTimersByTimeAsync(RECHECK_MAX_MS * 3);
  expect(x.sends).toHaveLength(2);
  agent.pendingPermissions = [];
  await vi.advanceTimersByTimeAsync(RECHECK_MAX_MS);
  expect(x.sends).toHaveLength(3);
  x.dispatcher.dispose();
});

test("a status read that sees idle delivers held notes", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends).toEqual([]);
  x.agents.get(agentId)!.status = "idle";
  expect((await x.dispatcher.status(x.paseo)).state).toBe("idle");
  await vi.waitFor(() => expect(x.sends).toHaveLength(1));
  x.dispatcher.dispose();
});

test("a send cooldown keeps a stale idle read from double-sending", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends).toHaveLength(1);
  // Paseo still reports idle right after the send: the next batch waits for the cooldown.
  await x.dispatcher.deliver([note("t2")], x.paseo);
  expect(x.sends).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(7_000);
  expect(x.sends).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(x.sends).toHaveLength(2);
  expect(x.sends[1].text).toContain("[t2]");
  expect(x.sends[1].text).not.toContain("[t1]");
  x.dispatcher.dispose();
});

test("held notes keep a question over a later status change and count across batches", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.deliver([{ ...note("t1"), kind: "question", detail: "Which database?" }], x.paseo);
  await x.dispatcher.deliver([note("t1", "development → in_review")], x.paseo);
  await x.dispatcher.deliver([{ ...note("t2", "todo → blocked"), earlier: 2 }], x.paseo);
  await x.dispatcher.deliver([{ ...note("t2", "blocked → in_review"), earlier: 1 }], x.paseo);
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.turnEnded(agentId, x.paseo);
  const text = x.sends[0].text;
  expect(text).toContain('[t1] in project p: question — Which database?; then development → in_review');
  expect(text).not.toMatch(/\[t1\][^\n]*earlier/);
  // 2 + 1 hidden facts, plus the replaced note itself.
  expect(text).toContain("[t2] in project p: status_changed — blocked → in_review (+4 earlier)");
  x.dispatcher.dispose();
});

test("held notes are never dropped while the dispatcher lives, however full its context", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.deliver([note("t1")], x.paseo);
  const agent = x.agents.get(agentId)!;
  agent.status = "error";
  agent.lastUsage = { contextWindowUsedTokens: 99, contextWindowMaxTokens: 100 };
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].text).toContain("[t1]");
  x.dispatcher.dispose();
});

test("note-drop counts are logged with a fixed label and the count as context", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.deliver([note("t1"), note("t2")], x.paseo);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  x.dispatcher.dispose();
  const call = errors.mock.calls.find((c) => c[0] === "Flowly dispatcher held notes dropped on unload:");
  expect(call?.[1]).toBe("2 notes");
  void agentId;
});

test("a failed status read drops the held notes and logs it", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.deliver([note("t1")], x.paseo);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const broken = {
    ...x.paseo,
    agents: { ref: () => ({ refresh: async () => Promise.reject(new Error("socket closed")), send: async () => undefined }) },
  } as unknown as PaseoApi;
  await x.dispatcher.turnEnded(agentId, broken);
  expect(errors.mock.calls.some((c) => String(c[0]).includes("Flowly dispatcher state unreadable"))).toBe(true);
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.deliver([note("t2")], x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].text).not.toContain("[t1]");
});

test("a record load error is not cached", async () => {
  const x = await setup();
  // A directory where the file should be: reading fails with EISDIR, not ENOENT.
  await mkdir(join(x.directory, "dispatcher.json"));
  await expect(x.dispatcher.record()).rejects.toThrow();
  await rm(join(x.directory, "dispatcher.json"), { recursive: true });
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "dw", agentId: "a1", startedAt: null }));
  expect(await x.dispatcher.record()).toMatchObject({ agentId: "a1" });
});

test("notes dropped before a Paseo connection and held notes lost on unload are logged", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const bus = new EventBus();
  const deliver = vi.spyOn(x.dispatcher, "deliver");
  const dispose = wireDispatcher(bus, x.dispatcher, () => undefined);
  bus.publish([{ kind: "board", projectId: "p", title: "Card t1", event: { id: "e1", taskId: "t1", actor: "agent", action: "status_changed", from: "todo", to: "blocked", at: "now" } }]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(deliver).not.toHaveBeenCalled();
  expect(errors.mock.calls.some((c) => String(c[0]) === "Flowly dispatcher notes dropped: no Paseo connection yet:")).toBe(true);
  dispose();
  // Held notes at unload: the wiring's cleanup disposes the dispatcher too.
  const y = await setup();
  const { agentId } = await y.dispatcher.start(y.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(y.agents.get(agentId)!.status).toBe("running");
  await y.dispatcher.deliver([note("t2")], y.paseo);
  errors.mockClear();
  wireDispatcher(new EventBus(), y.dispatcher, () => y.paseo)();
  expect(errors.mock.calls.some((c) => String(c[0]) === "Flowly dispatcher held notes dropped on unload:")).toBe(true);
  // After dispose a late turn end or batch sends nothing.
  y.agents.get(agentId)!.status = "idle";
  await y.dispatcher.turnEnded(agentId, y.paseo);
  await y.dispatcher.deliver([note("t3")], y.paseo);
  expect(y.sends).toEqual([]);
});

test("the dispatcher's folder, and the old one in the data folder, are recognized through symlinks (§2)", async () => {
  const x = await setup();
  const old = join(x.directory, "dispatcher");
  expect(await x.dispatcher.ownsRoot(x.folder)).toBe(false);
  expect(await x.dispatcher.ownsRoot(old)).toBe(false);
  await mkdir(x.folder, { recursive: true });
  await mkdir(old);
  expect(await x.dispatcher.ownsRoot(x.folder)).toBe(true);
  expect(await x.dispatcher.ownsRoot(old)).toBe(true);
  const link = join(x.home, "link");
  await symlink(x.folder, link);
  expect(await x.dispatcher.ownsRoot(link)).toBe(true);
  expect(await x.dispatcher.ownsRoot(join(x.folder, ".."))).toBe(false);
  expect(await x.dispatcher.ownsRoot(join(old, ".."))).toBe(false);
  expect(await x.dispatcher.ownsRoot(x.directory)).toBe(false);
  expect(await x.dispatcher.ownsRoot(x.home)).toBe(false);
});

test("the dispatcher's folder is outside the plugin data folder, in a parent of its own (§2)", async () => {
  const x = await setup();
  await writeFile(join(x.directory, "board.json"), "{}");
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Derived from the Paseo home, not from the data folder, and not inside it.
  expect(x.folder).toBe(join(x.home, "flowly-dispatcher", "dispatcher"));
  expect(relative(x.directory, x.folder).startsWith("..")).toBe(true);
  // Its parent holds the dispatcher folder only: no board, key, database, settings or Paseo files are next to it.
  const parent = dirname(x.folder);
  expect(await readdir(parent)).toEqual(["dispatcher"]);
  expect(relative(parent, x.directory).startsWith("..")).toBe(true);
  expect(parent).not.toBe(x.home);
  // Only the user can enter it.
  expect((await stat(x.folder)).mode & 0o077).toBe(0);
  expect((await stat(parent)).mode & 0o077).toBe(0);
});

test("a folder inside or next to the data folder is refused and nothing is created (§2)", async () => {
  for (const place of [(_: string, d: string) => join(d, "dispatcher"), (_: string, d: string) => join(d, "..", "dispatcher"), (h: string) => join(h, "dispatcher")]) {
    const x = await setup(undefined, place);
    await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
    expect(x.created).toEqual([]);
    expect(x.agentCreates).toEqual([]);
  }
});

test("a dispatcher folder later replaced by a link into the data folder is refused before reuse (§2)", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  const inside = join(x.directory, "inside");
  await mkdir(inside);
  await rm(x.folder, { recursive: true });
  await symlink(inside, x.folder);
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
  expect(x.created).toHaveLength(1);
  expect(x.agentCreates).toHaveLength(1);
  expect(errors.mock.calls.some((c) => String(c[0]) === "Flowly dispatcher folder refused:")).toBe(true);
});

test("a linked flowly-dispatcher folder pointing into the data folder creates nothing (§2)", async () => {
  for (const target of ["inside", "missing"]) {
    const x = await setup();
    const inside = join(x.directory, target);
    if (target === "inside") await mkdir(inside);
    await symlink(inside, dirname(x.folder));
    await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
    expect(x.created).toEqual([]);
    if (target === "inside") expect(await readdir(inside)).toEqual([]);
    else await expect(stat(inside)).rejects.toThrow();
  }
});

test("existing dispatcher folders are made private (§2)", async () => {
  const x = await setup();
  await mkdir(x.folder, { recursive: true, mode: 0o755 });
  await chmod(dirname(x.folder), 0o755);
  await chmod(x.folder, 0o755);
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect((await stat(x.folder)).mode & 0o777).toBe(0o700);
  expect((await stat(dirname(x.folder))).mode & 0o777).toBe(0o700);
});

test("a stored workspace in the old in-data folder is not reused; the old folder and workspace stay (§2)", async () => {
  const x = await setup();
  const old = join(x.directory, "dispatcher");
  await mkdir(old);
  await writeFile(join(old, "notes.md"), "kept");
  x.workspaces.set("old-ws", { id: "old-ws", archivingAt: null, workspaceDirectory: old });
  x.agents.set("old", { id: "old", workspaceId: "old-ws", status: "idle", archivedAt: null });
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "old-ws", agentId: "old", startedAt: "2026-11-08T10:00:00.000Z" }));
  // While the old session is alive, start stays refused and nothing is created.
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect(x.created).toEqual([]);
  // Once it is dead, the new dispatcher gets a new workspace in the new folder; the old one is archived as a dead session only.
  x.agents.get("old")!.status = "closed";
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({ source: { kind: "directory", path: x.folder } });
  expect(x.agentCreates[0].workspaceId).toBe("dw-1");
  expect(JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8"))).toMatchObject({ workspaceId: "dw-1", agentId });
  expect(x.archived).toEqual(["agent:old"]);
  expect(await readFile(join(old, "notes.md"), "utf8")).toBe("kept");
  // The old workspace is no longer the stored one, but its folder is still the dispatcher's: no card can use it.
  expect(await x.dispatcher.owns("old-ws")).toBe(false);
  const fixture = await agentFixture();
  directories.push(fixture.root);
  fixture.setWorkspace({ ...fixture.workspace(), id: "old-ws", workspaceDirectory: old });
  const service = new BoardService(fixture.store);
  service.reservedWorkspace = (id) => x.dispatcher.owns(id);
  service.reservedRoot = (path) => x.dispatcher.ownsRoot(path);
  await expect(
    service.createTask(
      { projectId: "p", operationId: "bind-old-dispatcher", title: "Bind", description: "", status: "todo", priority: "normal", mode: "existing", workspaceId: "old-ws", baseRef: "" },
      fixture.paseo,
    ),
  ).rejects.toThrow("Flowly dispatcher");
  // A stored workspace elsewhere (not the dispatcher folder) is not reused either.
  x.workspaces.set("dw-1", { id: "dw-1", archivingAt: null, workspaceDirectory: x.home });
  x.agents.get(agentId)!.status = "closed";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.created).toHaveLength(2);
});

test("start without a provider uses the Dispatcher model setting, else the server default", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, {});
  expect(x.agentCreates[0].options.config).toMatchObject({ provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.status = "closed";
  // A setting on a provider that cannot withhold the routes to a card's asks is refused, naming what to pick.
  x.dispatcher.modelSetting = async () => ({ provider: "codex", model: "gpt-5.4", thinking: "high", mode: "full-access" });
  await expect(x.dispatcher.start(x.paseo, {})).rejects.toMatchObject({ code: "DISPATCHER_PROVIDER_UNSUPPORTED", message: expect.stringContaining("Claude") });
  expect(x.agentCreates).toHaveLength(1);
  x.dispatcher.modelSetting = async () => ({ provider: "claude", model: "claude-opus-5-5", thinking: "high", mode: "bypassPermissions" });
  const second = await x.dispatcher.start(x.paseo, {});
  expect(x.agentCreates[1].options.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" });
  // An explicit provider wins over the setting.
  x.agents.get(second.agentId)!.status = "closed";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-opus-5-5" });
  expect(x.agentCreates[2].options.config).toMatchObject({ provider: "claude/claude-opus-5-5" });
  expect((x.agentCreates[2].options.config as Record<string, unknown>).thinkingOptionId).toBeUndefined();
  // An unreadable setting falls back to the default.
  x.agents.get((JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")) as { agentId: string }).agentId)!.status = "closed";
  x.dispatcher.modelSetting = async () => Promise.reject(new Error("settings unreadable"));
  await x.dispatcher.start(x.paseo, {});
  expect(x.agentCreates[3].options.config).toMatchObject({ provider: "claude/claude-sonnet-5-5" });
});

test("the chat records exactly the notes the dispatcher received", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const recorded: { notes: DispatcherNote[]; at: string }[] = [];
  x.dispatcher.onSent = (notes, at) => void recorded.push({ notes: [...notes], at });
  // Dropped while down: nothing recorded.
  await x.dispatcher.deliver([note("t0")], x.paseo);
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Held while running: recorded only once sent.
  await x.dispatcher.deliver([note("t1", "todo → blocked")], x.paseo);
  await x.dispatcher.deliver([note("t1", "blocked → in_review"), note("t2")], x.paseo);
  expect(recorded).toEqual([]);
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(recorded).toHaveLength(1);
  expect(recorded[0].notes.map((n) => [n.taskId, n.detail])).toEqual([["t1", "blocked → in_review"], ["t2", "todo → in_review"]]);
  expect(recorded[0].at).toBe("2026-11-08T10:00:00.000Z");
  // A seen mark written meanwhile survives a new start.
  await x.dispatcher.markSeen(123);
  x.agents.get(agentId)!.status = "closed";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect((await x.dispatcher.record()).seenRevision).toBe(123);
});

test("What should I do? reaches only a dispatcher that is up, and always steers", async () => {
  const x = await setup();
  await expect(x.dispatcher.whatNext(x.paseo, "What should I do?")).rejects.toMatchObject({ code: "DISPATCHER_DOWN" });
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  await x.dispatcher.whatNext(x.paseo, "What should I do?");
  expect(x.sends.at(-1)).toEqual({ id: agentId, text: "What should I do?", options: { activeTurnBehavior: "steer" } });
  // A status read as idle can be stale by the time the message lands (a turn or a permission started meanwhile):
  // a send without activeTurnBehavior would interrupt it and clear its permissions, so idle steers too.
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.whatNext(x.paseo, "What should I do?");
  expect(x.sends.at(-1)!.options).toEqual({ activeTurnBehavior: "steer" });
  expect(userSendOptions).toEqual({ activeTurnBehavior: "steer" });
});

test("a refused session create restores the earlier record, its savedTools mark included (§3)", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup();
  // An earlier dispatcher from before saved tools: no mark.
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: null, agentId: "old", startedAt: "2026-11-01T00:00:00.000Z" }));
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "closed", archivedAt: null });
  x.failAgentCreate(new Error("Provider 'x' cannot preapprove exact MCP tools for unattended execution; select Claude, Codex, or OpenCode"));
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
  const stored = JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8"));
  expect(stored.agentId).toBe("old");
  expect(stored.savedTools).toBeUndefined();
  expect(errors.mock.calls.some((c) => String(c[0]) === "Flowly dispatcher not started:")).toBe(true);
});

test("a dispatcher saved with fewer tools than this build lists says a new one gets them; nothing restarts it (§3)", async () => {
  const status = async (extra: Record<string, unknown>, agentStatus = "idle") => {
    const x = await setup();
    x.agents.set("old", { id: "old", workspaceId: "dw-0", status: agentStatus, archivedAt: null });
    await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", ...extra }));
    const read = await x.dispatcher.status(x.paseo);
    expect(x.created).toHaveLength(0);
    return read;
  };
  expect(await status({ savedTools: dispatcherToolNames.slice(0, -1) })).toEqual({ state: "idle", agentId: "old", newTools: true });
  // Saved with this build's list, or marked true (saved with the first eight, all still listed): nothing to say.
  expect(await status({ savedTools: [...dispatcherToolNames] })).toEqual({ state: "idle", agentId: "old" });
  expect(await status({ savedTools: true })).toEqual({ state: "idle", agentId: "old" });
  // Tools from the open hook are read at each open, always this build's.
  expect(await status({})).toEqual({ state: "idle", agentId: "old" });
  // An ended one says nothing: Start gives a new one anyway.
  expect(await status({ savedTools: ["flowly_list_projects"] }, "closed")).toEqual({ state: "ended", agentId: "old" });
});

test("What should I do? marks the changed cards it sent as seen, only once it was sent (ruling 2026-11-09, §9.2)", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const seen = { revision: 1_700_000_000_000, ids: ["e1", "e2"] };
  // Not sent: nothing is marked, and the error reaches the caller.
  x.failSend(new Error("socket closed"));
  await expect(x.dispatcher.whatNext(x.paseo, "What should I do?", seen)).rejects.toThrow("socket closed");
  expect((await x.dispatcher.record()).seenRevision).toBeUndefined();
  // Down: refused before anything is marked.
  x.failSend(null);
  x.agents.get(agentId)!.status = "closed";
  await expect(x.dispatcher.whatNext(x.paseo, "What should I do?", seen)).rejects.toMatchObject({ code: "DISPATCHER_DOWN" });
  expect((await x.dispatcher.record()).seenRevision).toBeUndefined();
  // Sent: marked with that line's revision and ids, as Mark seen does.
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.whatNext(x.paseo, "What should I do?", seen);
  expect(x.sends.at(-1)).toMatchObject({ id: agentId, text: "What should I do?" });
  expect(await x.dispatcher.record()).toMatchObject({ seenRevision: seen.revision, seenIds: seen.ids });
});

test("no route to a card's ask: a Claude dispatcher starts without Paseo's tools, a shell or subagents (ruling, Noah 2026-11-09)", async () => {
  const x = await setup();
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5", modeId: "bypassPermissions" });
  // The SDK's `options` field is what it sends as the session's `providerOptions`; a `providerOptions` key here only
  // reached the daemon through the SDK's spread of unknown fields.
  const config = x.agentCreates[0].options.config as { options?: { disallowedTools?: string[] }; providerOptions?: unknown };
  expect(config.providerOptions).toBeUndefined();
  const withheld = config.options?.disallowedTools ?? [];
  // Paseo's own agent tools answer permissions (respond_to_permission), message a card's session (send_agent_prompt),
  // or reach a shell or another agent that could; the shell reaches the paseo CLI.
  for (const tool of ["mcp__paseo", "mcp__paseo__respond_to_permission", "mcp__paseo__send_agent_prompt", "mcp__paseo__create_agent", "mcp__paseo__send_terminal_keys", "mcp__paseo__set_agent_mode", "Bash", "Task", "Agent"])
    expect(withheld).toContain(tool);
  expect(withheld).toEqual([...dispatcherWithheldTools]);
  // None of its own tools is withheld.
  for (const tool of dispatcherToolNames) expect(withheld).not.toContain(`mcp__flowly-dispatcher__${tool}`);
});

test("no route to a card's ask: Claude's built-in tools are an allowlist, so its own messaging and agent tools never load", async () => {
  const x = await setup();
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5", modeId: "bypassPermissions" });
  const config = x.agentCreates[0].options.config as { options?: { extraArgs?: Record<string, string | null> } };
  // `extraArgs.tools` becomes Claude Code's `--tools`: the built-in tools it starts with; MCP servers are not affected.
  const tools = (config.options?.extraArgs?.tools ?? "").split(",");
  expect(tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "ToolSearch"]);
  expect(tools).toEqual([...dispatcherBuiltinTools]);
  // Claude Code 2.1.319's routes to another session or agent, a shell, a file write or a later turn (the reviewer's probe).
  for (const tool of ["SendMessage", "ListAgents", "Workflow", "RemoteTrigger", "CronCreate", "ScheduleWakeup", "Skill", "Write", "Edit", "NotebookEdit", "Bash", "Task", "Agent", "WebFetch"])
    expect(tools).not.toContain(tool);
});

test("the charter says plainly that only the user answers a card's asks", () => {
  expect(dispatcherCharter).toContain("You have no tool that answers them");
  expect(dispatcherCharter).toContain("buttons");
});
