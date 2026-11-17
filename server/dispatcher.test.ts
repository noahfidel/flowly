import { afterEach, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  Dispatcher,
  RECHECK_MAX_MS,
  dispatcherFolder,
  dispatcherSummary,
  globalPreviousAgentIdLimit,
  previousAgentIdLimit,
  type DispatcherMcpServer,
  type DispatcherRecord,
  dispatcherState,
  isDeadDispatcher,
  legacyNoteGroup,
  noteMessage,
  wireDispatcher,
} from "./dispatcher";
import { dispatcherSessionIds } from "./dispatcher-items";
import { EventBus, NoteBatcher, type BusFact } from "./event-bus";
import { BoardService } from "./service";
import { SessionTailService } from "./session-tail";
import { SessionSettingsService } from "./session-settings";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";
import { agentFixture } from "./agent-fixture";
import type { DispatcherIdentity } from "./tool-context";
import { dispatcherBuiltinTools, dispatcherCharter, dispatcherCharterVersion, dispatcherConfirmedToolNames, dispatcherGuardVersion, dispatcherToolNames, dispatcherWithheldTools, noteReplyRule, startRule, userSendOptions, type DispatcherNote } from "../shared/dispatcher";
import { emptyBoard, type Board, type BoardEvent, type Group } from "../shared/model";

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
  labels?: Record<string, string>;
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
  /** Agents `ref(id).refresh()` misses while `list` still returns them live (a background-workspace lookup miss). */
  const hidden = new Set<string>();
  const archiveErrors = new Map<string, Error>();
  const lists: { filter: unknown }[] = [];
  let pageSize = 200;
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
            agents.set(agentId, { id: agentId, workspaceId: id, status: "running", archivedAt: null, labels: options.labels as Record<string, string> | undefined });
            return { id: agentId };
          },
        },
      }),
    },
    agents: {
      list: async ({ filter, page }: { filter: { includeArchived?: boolean; includeBackground?: boolean }; page: { limit: number; cursor?: string } }) => {
        lists.push({ filter });
        const all = [...agents.values()].filter((a) => filter.includeArchived || !a.archivedAt);
        const start = page.cursor ? Number(page.cursor) : 0;
        const end = start + Math.min(page.limit, pageSize);
        return {
          entries: all.slice(start, end).map((a) => ({ agent: { ...a, labels: { ...(a.labels ?? {}) } }, project: null })),
          pageInfo: { nextCursor: end < all.length ? String(end) : null, prevCursor: null, hasMore: end < all.length },
        };
      },
      ref: (id: string) => ({
        refresh: async () => {
          const agent = hidden.has(id) ? undefined : agents.get(id);
          return agent ? { agent: { ...agent } } : null;
        },
        send: async (text: string, options?: unknown) => {
          if (sendError) throw sendError;
          sends.push({ id, text, options });
        },
        archive: async () => {
          const failure = archiveErrors.get(id);
          if (failure) throw failure;
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
    hidden,
    lists,
    failArchive: (id: string, e: Error | null) => (e ? archiveErrors.set(id, e) : archiveErrors.delete(id)),
    pageSize: (n: number) => (pageSize = n),
  };
}

/** The board group most tests use; its project "p" holds every note's card. */
const G = "g1";
const T = "2026-11-01T00:00:00.000Z";
const group = (id: string, name: string, position: number, extra: Partial<Group> = {}): Group => ({ id, name, position, revision: 1, createdAt: T, updatedAt: T, ...extra });
const boardProject = (id: string, groupId: string, archivedAt: string | null = null) =>
  ({ id, paseoProjectId: `n-${id}`, title: id.toUpperCase(), description: "", primaryPath: `/r/${id}`, repos: [`/r/${id}`], revision: 1, createdAt: T, updatedAt: T, archivedAt, groupId }) as Board["projects"][number];
const boardTask = (id: string, projectId: string, status = "todo", archivedAt: string | null = null) =>
  ({ id, projectId, workspaceId: `w-${id}`, sourcePath: "/r", repoPaths: ["/r"], title: `Card ${id}`, description: "", status, priority: "normal", position: 0, revision: 1, operationId: `o-${id}`, createdAt: T, updatedAt: T, archivedAt }) as Board["tasks"][number];
/** A board with the one group G (the default) holding project "p". */
function groupBoard(): Board {
  const b = emptyBoard();
  b.groups.push(group(G, "Projects", 0, { isDefault: true }));
  b.projects.push(boardProject("p", G));
  return b;
}

/** The record as one group's dispatcher sees it: the shared fields with that group's entry on top (the v1 shape). */
function flatten(record: DispatcherRecord, groupId: string) {
  const { groups, unassigned: _, previousAgentIds: __, ...rest } = record;
  return { ...rest, ...(groups[groupId] ?? { agentId: null, startedAt: null }) };
}

/** The hub bound to one group, so the single-dispatcher tests read as before (DISPATCHER-SPEC §0). */
function bound(hub: Dispatcher, groupId = G) {
  return {
    hub,
    get modelSetting() {
      return hub.modelSetting;
    },
    set modelSetting(value: Dispatcher["modelSetting"]) {
      hub.modelSetting = value;
    },
    set onSent(value: Dispatcher["onSent"]) {
      hub.onSent = value;
    },
    status: (paseo: PaseoApi) => hub.status(paseo, groupId),
    start: (paseo: PaseoApi, input: { provider?: string; modeId?: string } = {}) => hub.start(paseo, { groupId, ...input }),
    replace: (paseo: PaseoApi, input: { agentId: string }) => hub.replace(paseo, { groupId, ...input }),
    deliver: (notes: readonly DispatcherNote[], paseo: PaseoApi) => hub.deliver(groupId, notes, paseo),
    turnEnded: (agentId: string, paseo: PaseoApi) => hub.turnEnded(agentId, paseo),
    markSeen: (revision: number, ids?: readonly string[]) => hub.markSeen(groupId, revision, ids),
    whatNext: (paseo: PaseoApi, text: string, seen?: { revision: number; ids: readonly string[] }) => hub.whatNext(paseo, groupId, text, seen),
    send: (paseo: PaseoApi, input: { text: string; images?: { data: string; mimeType: "image/png" }[]; messageId: string }) => hub.send(paseo, { groupId, ...input }),
    owns: (id: string) => hub.owns(id),
    ownsRoot: (path: string) => hub.ownsRoot(path),
    dispose: () => hub.dispose(),
    record: async () => flatten(await hub.resolvedRecord(), groupId),
  };
}

/** A Paseo home with the plugin data folder at its usual place, and the dispatcher folder derived from that home. */
async function setup(
  summary: (groupId: string) => Promise<string> = async () => "Board summary",
  folderOf: (home: string, directory: string) => string = (home) => dispatcherFolder(home),
  mcp: (identity: DispatcherIdentity) => Promise<DispatcherMcpServer> = async (identity) => ({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: `Bearer ${identity.agentId}` } }),
) {
  const home = await mkdtemp(join(tmpdir(), "flowly-paseo-home-"));
  directories.push(home);
  const directory = join(home, "plugin-data", "flowly");
  await mkdir(directory, { recursive: true });
  const folder = folderOf(home, directory);
  const fake = fakePaseo();
  const state = { board: groupBoard() };
  const hub = new Dispatcher(directory, { summary, mcp, board: async () => state.board }, folder);
  dispatchers.push(hub);
  return { home, directory, folder, hub, dispatcher: bound(hub), state, ...fake };
}

/** The stored file as group G's dispatcher sees it. */
async function onDisk(x: { directory: string }, groupId = G) {
  return flatten(JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")) as DispatcherRecord, groupId);
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
      title: "Flowly dispatcher · Projects",
      prompt: "Board summary",
      labels: { "flowly-dispatcher": "1", "flowly-dispatcher-group": G },
      config: {
        provider: "claude/claude-sonnet-5-5",
        modeId: "default",
        systemPrompt: dispatcherCharter({ name: "Projects" }),
        // Its tools are saved with the session, each one preapproved, so they never prompt (§3).
        mcpServers: { "flowly-dispatcher": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: `Bearer ${first.agentId}` } } },
        toolPolicy: { preapproved: dispatcherToolNames.map((tool) => ({ kind: "mcp", server: "flowly-dispatcher", tool })) },
      },
    },
  });
  const stored = JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8"));
  // The record keeps the tool list it was saved with, to tell when a later build lists more (§1, §3).
  expect(stored).toMatchObject({ version: 2, workspaceId: "dw-1", groups: { [G]: { agentId: first.agentId, savedTools: [...dispatcherToolNames] } } });
  expect(typeof stored.groups[G].startedAt).toBe("string");
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
  x.agents.get(second.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  x.agents.get(agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await x.dispatcher.status(x.paseo);
  await x.dispatcher.deliver([note("t2")], x.paseo);
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // Neither the dead (already archived) session nor the workspace is archived by Flowly.
  expect(x.archived).toEqual([]);
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

test("one long-lived dispatcher: dead means archived or missing; a stopped (closed) session is alive (ruling, Noah 2026-11-09)", () => {
  expect(isDeadDispatcher(null)).toBe(true);
  expect(isDeadDispatcher(undefined)).toBe(true);
  expect(isDeadDispatcher({ status: "idle", archivedAt: "2026-11-08T11:00:00.000Z" })).toBe(true);
  expect(isDeadDispatcher({ status: "closed", archivedAt: "2026-11-08T11:00:00.000Z" })).toBe(true);
  // Paseo closes an idle session after an hour and on a restart; a message resumes it.
  for (const status of ["running", "initializing", "idle", "error", "closed"]) expect(isDeadDispatcher({ status, archivedAt: null }), status).toBe(false);
  // A full context is no state of its own: the session compacts and stays the dispatcher.
  const full = { status: "idle", archivedAt: null, lastUsage: { contextWindowUsedTokens: 99, contextWindowMaxTokens: 100 } };
  expect(dispatcherState(full)).toBe("idle");
  expect(dispatcherState({ status: "error", archivedAt: null })).toBe("idle");
  expect(dispatcherState({ status: "closed", archivedAt: null })).toBe("idle");
});

test("a closed dispatcher is resumed, not replaced: Start refuses, nothing is archived, notes and What should I do? reach it", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "closed";
  expect(await x.dispatcher.status(x.paseo)).toMatchObject({ state: "idle", agentId });
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect(x.agentCreates).toHaveLength(1);
  expect(x.archived).toEqual([]);
  // A note batch is sent to it (Paseo reloads the session for the message), as to an idle one.
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends.filter((m) => m.id === agentId).length).toBe(1);
  await x.dispatcher.whatNext(x.paseo, "What should I do?", { revision: 1_700_000_000_000, ids: [] });
  expect(x.sends.at(-1)).toMatchObject({ id: agentId, text: "What should I do?" });
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

test("a replacement archives nothing, re-reads the dead dispatcher first and remembers it", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  const second = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.delete(second.agentId);
  const third = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  // A dead dispatcher is already archived or gone: Flowly archives nothing.
  expect(x.archived).toEqual([]);
  // The earlier sessions are remembered, newest last, without the current one.
  expect((await x.dispatcher.record()).previousAgentIds).toEqual([first.agentId, second.agentId]);
  expect(dispatcherSessionIds(await x.dispatcher.record())).toEqual([first.agentId, second.agentId, third.agentId]);
  // A session restored between the status read and the start is never replaced: the start is refused.
  x.agents.get(third.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
            // The first read sees it archived; the re-read just before replacing sees it restored.
            if (++reads > 1 && found?.agent) return { agent: { ...found.agent, archivedAt: null, status: "idle" } };
            return found;
          },
        };
      },
    },
  } as unknown as PaseoApi;
  await expect(x.dispatcher.start(paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect((await x.dispatcher.record()).agentId).toBe(third.agentId);
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
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  // A dispatcher with the current charter has the rules in it: the batch ends with the last note.
  expect(sent.text.split("\n").at(-1)).toContain('- "Card t2" [t2] in project p');
  expect(sent.text).not.toContain(startRule);
  expect(sent.text).not.toContain(noteReplyRule);
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
  x.agents.get(agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  expect((await onDisk(x)).agentId).toBe(agentId);
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
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  expect((await onDisk(x)).agentId).toBe(first.agentId);
});

test("only stops reach the batcher and the dispatcher's own facts never do", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  const bus = new EventBus();
  const delivered: (readonly DispatcherNote[])[] = [];
  const deliver = vi.spyOn(x.hub, "deliver").mockImplementation(async (groupId, notes) => {
    // Routed to the dispatcher of the card's project's group.
    expect(groupId).toBe(G);
    delivered.push(notes);
  });
  const dispose = wireDispatcher(bus, x.hub, () => x.paseo);
  let seq = 0;
  const fact = (patch: Partial<BoardEvent>): BusFact => ({
    kind: "board",
    projectId: "p",
    groupId: G,
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

test("A1r restores and the user's own moves never wake the dispatcher, a real delivery does", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  x.agents.get(agentId)!.status = "idle";
  const bus = new EventBus();
  const delivered: (readonly DispatcherNote[])[] = [];
  const deliver = vi.spyOn(x.hub, "deliver").mockImplementation(async (_groupId, notes) => {
    delivered.push(notes);
  });
  wireDispatcher(bus, x.hub, () => x.paseo);
  let seq = 0;
  const fact = (patch: Partial<BoardEvent>): BusFact => ({
    kind: "board",
    projectId: "p",
    groupId: G,
    title: "Card t1",
    event: { id: `e${++seq}`, taskId: "t1", actor: "agent", action: "status_changed", at: "2026-11-08T10:00:00.000Z", ...patch },
  });
  const chat = () => [
    fact({ actor: "system", rule: "A1", from: "in_review", to: "development" }),
    fact({ actor: "system", rule: "A1r", from: "development", to: "in_review", note: "No work was reported in that turn; restored" }),
  ];
  bus.publish(chat());
  bus.publish([fact({ actor: "human", from: "in_review", to: "done" })]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(deliver).not.toHaveBeenCalled();
  // A real delivery is not a restore and is delivered.
  bus.publish([fact({ from: "development", to: "in_review", note: "Done, please review" })]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(delivered[0]).toHaveLength(1);
  expect(delivered[0][0]).toMatchObject({ taskId: "t1", detail: "development → in_review: Done, please review" });
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
  const deliver = vi.spyOn(x.hub, "deliver");
  const dispose = wireDispatcher(bus, x.hub, () => undefined);
  bus.publish([{ kind: "board", projectId: "p", groupId: G, title: "Card t1", event: { id: "e1", taskId: "t1", actor: "agent", action: "status_changed", from: "todo", to: "blocked", at: "now" } }]);
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
  wireDispatcher(new EventBus(), y.hub, () => y.paseo)();
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
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  // Once it is dead (archived), the new dispatcher gets a new workspace in the new folder; nothing is archived.
  x.agents.get("old")!.archivedAt = "2026-11-09T00:00:00.000Z";
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({ source: { kind: "directory", path: x.folder } });
  expect(x.agentCreates[0].workspaceId).toBe("dw-1");
  expect(await onDisk(x)).toMatchObject({ workspaceId: "dw-1", agentId });
  expect(x.archived).toEqual([]);
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
  x.agents.get(agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(x.created).toHaveLength(2);
});

test("start without a provider uses the Dispatcher model setting, else the server default", async () => {
  const x = await setup();
  const first = await x.dispatcher.start(x.paseo, {});
  expect(x.agentCreates[0].options.config).toMatchObject({ provider: "claude/claude-sonnet-5-5" });
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  // A setting on a provider that cannot withhold the routes to a card's asks is refused, naming what to pick.
  x.dispatcher.modelSetting = async () => ({ provider: "codex", model: "gpt-5.4", thinking: "high", mode: "full-access" });
  await expect(x.dispatcher.start(x.paseo, {})).rejects.toMatchObject({ code: "DISPATCHER_PROVIDER_UNSUPPORTED", message: expect.stringContaining("Claude") });
  expect(x.agentCreates).toHaveLength(1);
  x.dispatcher.modelSetting = async () => ({ provider: "claude", model: "claude-opus-5-5", thinking: "high", mode: "bypassPermissions" });
  const second = await x.dispatcher.start(x.paseo, {});
  expect(x.agentCreates[1].options.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" });
  // An explicit provider wins over the setting.
  x.agents.get(second.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-opus-5-5" });
  expect(x.agentCreates[2].options.config).toMatchObject({ provider: "claude/claude-opus-5-5" });
  expect((x.agentCreates[2].options.config as Record<string, unknown>).thinkingOptionId).toBeUndefined();
  // An unreadable setting falls back to the default.
  x.agents.get((await onDisk(x)).agentId!)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  x.agents.get(agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
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
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: "2026-11-09T00:00:00.000Z" });
  x.failAgentCreate(new Error("Provider 'x' cannot preapprove exact MCP tools for unattended execution; select Claude, Codex, or OpenCode"));
  await expect(x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
  const stored = await onDisk(x);
  expect(stored.agentId).toBe("old");
  expect(stored.savedTools).toBeUndefined();
  expect(errors.mock.calls.some((c) => String(c[0]) === "Flowly dispatcher not started:")).toBe(true);
});

test("a dispatcher saved with fewer tools than this build lists says a new one gets them; nothing restarts it (§3)", async () => {
  const status = async (extra: Record<string, unknown>, agentStatus = "idle") => {
    const x = await setup();
    x.agents.set("old", { id: "old", workspaceId: "dw-0", status: agentStatus, archivedAt: null });
    await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", guard, charter: dispatcherCharterVersion, ...extra }));
    const read = await x.dispatcher.status(x.paseo);
    expect(x.created).toHaveLength(0);
    return read;
  };
  const guard = { version: dispatcherGuardVersion, provider: "claude" };
  expect(await status({ savedTools: dispatcherToolNames.slice(0, -1) })).toEqual({ state: "idle", agentId: "old", newTools: true });
  // Saved with this build's list: nothing to say.
  expect(await status({ savedTools: [...dispatcherToolNames] })).toEqual({ state: "idle", agentId: "old" });
  // Tools the user confirms each time are never saved preapproved, so missing them is not news (ruling, Noah 2026-11-10).
  for (const tool of dispatcherConfirmedToolNames) expect(dispatcherToolNames).not.toContain(tool);
  // Saved with the first eight, by name or marked true: the idea tools came later (§5.1), so a new session gets them.
  const firstEight = ["flowly_list_projects", "flowly_list_cards", "flowly_get_card", "flowly_create_card", "flowly_update_card", "flowly_start_card", "flowly_propose_idea", "flowly_link_cards"];
  expect(await status({ savedTools: firstEight })).toEqual({ state: "idle", agentId: "old", newTools: true });
  expect(await status({ savedTools: true })).toEqual({ state: "idle", agentId: "old", newTools: true });
  // flowly_create_card is one of them but is now confirmed by the user (§5.2), so no longer preapproved.
  expect(dispatcherToolNames).toEqual(expect.arrayContaining([...firstEight.filter((tool) => tool !== "flowly_create_card"), "flowly_list_ideas", "flowly_update_idea"]));
  // Tools from the open hook are read at each open, always this build's.
  expect(await status({})).toEqual({ state: "idle", agentId: "old" });
  // An ended one says nothing: Start gives a new one anyway.
  // A closed one is alive (resumed by the next message): it says so too.
  expect(await status({ savedTools: ["flowly_list_projects"] }, "closed")).toEqual({ state: "idle", agentId: "old", newTools: true });
});

test("a live dispatcher started without this build's routes withheld says to replace it; nothing restarts it (§3)", async () => {
  const status = async (guard: unknown, agentStatus = "idle") => {
    const x = await setup();
    x.agents.set("old", { id: "old", workspaceId: "dw-0", status: agentStatus, archivedAt: null });
    const record = { version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", savedTools: [...dispatcherToolNames], charter: dispatcherCharterVersion, ...(guard ? { guard } : {}) };
    await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(record));
    const read = await x.dispatcher.status(x.paseo);
    expect(x.created).toHaveLength(0);
    expect(x.archived).toEqual([]);
    return read;
  };
  // Started before the guard (no mark), with an older guard, or on a provider that cannot withhold the routes.
  expect(await status(undefined)).toEqual({ state: "idle", agentId: "old", unguarded: true });
  expect(await status(undefined, "running")).toEqual({ state: "running", agentId: "old", unguarded: true });
  expect(await status({ version: dispatcherGuardVersion - 1, provider: "claude" })).toEqual({ state: "idle", agentId: "old", unguarded: true });
  expect(await status({ version: dispatcherGuardVersion, provider: "codex" })).toEqual({ state: "idle", agentId: "old", unguarded: true });
  expect(await status({ version: dispatcherGuardVersion, provider: "claude" })).toEqual({ state: "idle", agentId: "old" });
  // A closed one is alive and says so; an archived one has ended and says nothing.
  expect(await status(undefined, "closed")).toEqual({ state: "idle", agentId: "old", unguarded: true });
});

/** A stored dispatcher "old" in `status`, recorded with `guard` (absent: started before the guard) and the current charter. */
async function oldDispatcher(guard?: unknown, agentStatus = "idle", ...args: Parameters<typeof setup>) {
  const x = await setup(...args);
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: agentStatus, archivedAt: null });
  const record = { version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", savedTools: [...dispatcherToolNames], charter: dispatcherCharterVersion, ...(guard ? { guard } : {}) };
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(record));
  return x;
}

test("an unguarded dispatcher gets no board notes: they are held for a fresh one, and it is never woken (ruling, Noah 2026-11-09)", async () => {
  for (const guard of [undefined, { version: dispatcherGuardVersion - 1, provider: "claude" }, { version: dispatcherGuardVersion, provider: "codex" }]) {
    for (const agentStatus of ["idle", "closed"]) {
      const x = await oldDispatcher(guard, agentStatus);
      await x.dispatcher.deliver([note("a"), note("b")], x.paseo);
      // A status read that sees it idle (closed reads idle) does not deliver either.
      expect(await x.dispatcher.status(x.paseo)).toMatchObject({ state: "idle", unguarded: true });
      await x.dispatcher.deliver([note("c")], x.paseo);
      expect(x.sends, JSON.stringify({ guard, agentStatus })).toEqual([]);
      expect(x.archived).toEqual([]);
      // Replaced: the held notes are on the board the fresh dispatcher's summary reads; later ones reach it.
      const { agentId } = await x.dispatcher.replace(x.paseo, { agentId: "old" });
      x.agents.get(agentId)!.status = "idle";
      await x.dispatcher.deliver([note("d")], x.paseo);
      expect(x.sends.map((s) => s.id)).toEqual([agentId]);
      expect(x.sends[0].text).toContain("Card d");
      expect(x.sends.some((s) => s.id === "old")).toBe(false);
    }
  }
  // A guarded one gets its notes as before.
  const y = await oldDispatcher({ version: dispatcherGuardVersion, provider: "claude" });
  await y.dispatcher.deliver([note("a")], y.paseo);
  expect(y.sends.map((s) => s.id)).toEqual(["old"]);
});

test("Replace archives exactly the unguarded dispatcher's session and starts a guarded one (ruling, Noah 2026-11-09)", async () => {
  for (const agentStatus of ["idle", "running", "closed", "error"]) {
    const x = await oldDispatcher(undefined, agentStatus);
    x.agents.set("card-session", { id: "card-session", workspaceId: "w-a", status: "idle", archivedAt: null });
    const { agentId } = await x.dispatcher.replace(x.paseo, { agentId: "old" });
    expect(x.archived, agentStatus).toEqual(["agent:old"]);
    expect(agentId).not.toBe("old");
    const record = await x.dispatcher.record();
    expect(record).toMatchObject({ agentId, guard: { version: dispatcherGuardVersion, provider: "claude" }, savedTools: [...dispatcherToolNames], charter: dispatcherCharterVersion });
    expect(record.previousAgentIds).toEqual(["old"]);
    expect(x.agentCreates).toHaveLength(1);
    expect(x.agentCreates[0].options).toMatchObject({ config: { options: { disallowedTools: [...dispatcherWithheldTools] } } });
    expect(await x.dispatcher.status(x.paseo)).not.toHaveProperty("unguarded");
  }
  // Already dead (archived meanwhile): nothing is archived again, the new one starts.
  const y = await oldDispatcher();
  y.agents.get("old")!.archivedAt = "2026-11-09T00:00:00.000Z";
  await y.dispatcher.replace(y.paseo, { agentId: "old" });
  expect(y.archived).toEqual([]);
  expect(y.agentCreates).toHaveLength(1);
});

test("Replace also takes a guarded dispatcher that misses this build's tools (Ruling, Noah 2026-11-09)", async () => {
  const x = await setup();
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: null });
  const record = { version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", savedTools: dispatcherToolNames.slice(0, -1), guard: { version: dispatcherGuardVersion, provider: "claude" }, charter: dispatcherCharterVersion };
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(record));
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "idle", agentId: "old", newTools: true });
  const { agentId } = await x.dispatcher.replace(x.paseo, { agentId: "old" });
  expect(x.archived).toEqual(["agent:old"]);
  expect(await x.dispatcher.record()).toMatchObject({ agentId, savedTools: [...dispatcherToolNames], previousAgentIds: ["old"] });
  expect(await x.dispatcher.status(x.paseo)).not.toHaveProperty("newTools");
});

/** A guarded dispatcher with every tool and the given charter (absent: started before charter versioning). */
async function charterDispatcher(charter?: number) {
  const x = await setup();
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: null });
  const record = { version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", savedTools: [...dispatcherToolNames], guard: { version: dispatcherGuardVersion, provider: "claude" }, ...(charter === undefined ? {} : { charter }) };
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(record));
  return x;
}

test("a guarded dispatcher with every tool but an older charter says a new one gets the current one (§3)", async () => {
  for (const charter of [undefined, 0]) {
    const x = await charterDispatcher(charter);
    expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "idle", agentId: "old", oldCharter: true });
    expect(x.created).toHaveLength(0);
    expect(x.archived).toEqual([]);
  }
  const y = await charterDispatcher(dispatcherCharterVersion);
  expect(await y.dispatcher.status(y.paseo)).toEqual({ state: "idle", agentId: "old" });
});

test("Replace also takes a guarded dispatcher with every tool whose charter is old (Ruling, Noah 2026-11-14)", async () => {
  const x = await charterDispatcher();
  const { agentId } = await x.dispatcher.replace(x.paseo, { agentId: "old" });
  expect(x.archived).toEqual(["agent:old"]);
  expect(await x.dispatcher.record()).toMatchObject({ agentId, charter: dispatcherCharterVersion, previousAgentIds: ["old"] });
  expect(await x.dispatcher.status(x.paseo)).not.toHaveProperty("oldCharter");
  // Now current on guard, tools and charter: refused.
  await expect(x.dispatcher.replace(x.paseo, { agentId })).rejects.toMatchObject({ code: "DISPATCHER_GUARDED" });
});

test("note batches carry the start and reply rules only for a dispatcher at charter version 0 (§7)", () => {
  const notes = [note("t1")];
  const lines = noteMessage(notes, 0).split("\n");
  expect(lines.at(-2)).toBe(startRule);
  expect(lines.at(-1)).toBe(noteReplyRule);
  const current = noteMessage(notes, dispatcherCharterVersion);
  expect(current).not.toContain(startRule);
  expect(current).not.toContain(noteReplyRule);
  expect(current.split("\n").at(-1)).toContain("[t1]");
});

test("a batch to a dispatcher without a charter version still ends with the start and reply rules (§7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await charterDispatcher();
  await x.dispatcher.deliver([note("t1")], x.paseo);
  expect(x.sends).toHaveLength(1);
  const lines = x.sends[0].text.split("\n");
  expect(lines.at(-2)).toBe(startRule);
  expect(lines.at(-1)).toBe(noteReplyRule);
  x.dispatcher.dispose();
});

test("Replace is refused for a guarded dispatcher, another session id or none, and archives nothing (ruling, Noah 2026-11-09)", async () => {
  const x = await oldDispatcher({ version: dispatcherGuardVersion, provider: "claude" });
  await expect(x.dispatcher.replace(x.paseo, { agentId: "old" })).rejects.toMatchObject({ code: "DISPATCHER_GUARDED" });
  const y = await oldDispatcher();
  await expect(y.dispatcher.replace(y.paseo, { agentId: "another" })).rejects.toMatchObject({ code: "DISPATCHER_CHANGED" });
  const z = await setup();
  await expect(z.dispatcher.replace(z.paseo, { agentId: "old" })).rejects.toMatchObject({ code: "DISPATCHER_CHANGED" });
  for (const w of [x, y, z]) {
    expect(w.archived).toEqual([]);
    expect(w.agentCreates).toHaveLength(0);
  }
  // Start still refuses the live unguarded one: Replace is the only route.
  await expect(y.dispatcher.start(y.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  expect(y.archived).toEqual([]);
  // A failed archive starts nothing.
  const v = await oldDispatcher();
  const ref = v.paseo.agents.ref;
  (v.paseo.agents as { ref: unknown }).ref = (id: string) => ({ ...ref(id), archive: async () => { throw new Error("busy"); } });
  await v.dispatcher.deliver([note("a")], v.paseo);
  await expect(v.dispatcher.replace(v.paseo, { agentId: "old" })).rejects.toMatchObject({ code: "REPLACE_FAILED" });
  expect(v.agentCreates).toHaveLength(0);
  expect((await v.dispatcher.record()).agentId).toBe("old");
  expect(await v.dispatcher.record()).not.toHaveProperty("guard");
  // Its held note still waits for a fresh dispatcher.
  expect([...(v.hub as unknown as { perGroup: Map<string, { held: Map<string, unknown> }> }).perGroup.get(G)!.held.keys()]).toEqual(["a"]);
});

test("Replace does every step that can fail before it archives: a failed preparation archives nothing and keeps the dispatcher", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failures: [string, () => Promise<ReturnType<typeof setup> extends Promise<infer X> ? X : never>][] = [
    ["folder refused", () => oldDispatcher(undefined, "idle", undefined, (_, d) => join(d, "dispatcher"))],
    ["workspace not created", async () => {
      const x = await oldDispatcher();
      x.failCreate(new Error("no workspace"));
      return x;
    }],
    ["no MCP server", () => oldDispatcher(undefined, "idle", undefined, undefined, async () => { throw new Error("no credential"); })],
    ["no summary", () => oldDispatcher(undefined, "idle", async () => { throw new Error("board unreadable"); })],
  ];
  for (const [label, make] of failures) {
    const x = await make();
    // The v1 file is migrated (to v2) by the first read; the failed replace must leave that file as it is.
    await x.dispatcher.record();
    const before = await readFile(join(x.directory, "dispatcher.json"), "utf8");
    await x.dispatcher.deliver([note("a")], x.paseo);
    await expect(x.dispatcher.replace(x.paseo, { agentId: "old" }), label).rejects.toThrow();
    expect(x.archived, label).toEqual([]);
    expect(x.agentCreates, label).toHaveLength(0);
    const record = await x.dispatcher.record();
    expect(record, label).toMatchObject({ agentId: "old", startedAt: "2026-11-01T00:00:00.000Z" });
    expect(record, label).not.toHaveProperty("guard");
    expect(record.previousAgentIds, label).toBeUndefined();
    // Nothing was made: the file is as it was. (A workspace Paseo did make is remembered, as a Start would.)
    if (label !== "no MCP server" && label !== "no summary") expect(await readFile(join(x.directory, "dispatcher.json"), "utf8"), label).toBe(before);
    // The old one is still the dispatcher, still unguarded, and its held note still waits for a fresh one.
    expect(await x.dispatcher.status(x.paseo), label).toMatchObject({ state: "idle", agentId: "old", unguarded: true });
    expect(x.sends, label).toEqual([]);
  }
});

test("Replace archives before it stores the new session: a failed save after the archive leaves an ended dispatcher, and Start works", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await oldDispatcher();
  // The save that would store the new session fails (as a crash there would): only once the old one is archived.
  const internals = x.hub as unknown as { save: (...args: unknown[]) => Promise<unknown> };
  const save = internals.save.bind(x.hub);
  let failing = true;
  internals.save = async (...args: unknown[]) => {
    if (failing && x.archived.includes("agent:old")) throw new Error("disk full");
    return save(...args);
  };
  await expect(x.dispatcher.replace(x.paseo, { agentId: "old" })).rejects.toThrow("disk full");
  expect(x.archived).toEqual(["agent:old"]);
  expect(x.agentCreates).toHaveLength(0);
  // The record still names the archived session: ended, not a live session Flowly lost track of.
  expect(await x.dispatcher.record()).toMatchObject({ agentId: "old" });
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "ended", agentId: "old" });
  failing = false;
  const { agentId } = await x.dispatcher.start(x.paseo, {});
  expect(await x.dispatcher.record()).toMatchObject({ agentId, guard: { version: dispatcherGuardVersion, provider: "claude" }, previousAgentIds: ["old"] });
  expect(x.archived).toEqual(["agent:old"]);
});

test("Replace whose create fails after the archive leaves an ended dispatcher, says so, and Start works", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await oldDispatcher();
  x.failAgentCreate(new Error("refused"));
  const failed = x.dispatcher.replace(x.paseo, { agentId: "old" });
  await expect(failed).rejects.toMatchObject({ code: "START_FAILED" });
  await expect(failed).rejects.toThrow(/old dispatcher was archived/);
  expect(x.archived).toEqual(["agent:old"]);
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "ended", agentId: "old" });
  x.failAgentCreate(null);
  const { agentId } = await x.dispatcher.start(x.paseo, {});
  expect(await x.dispatcher.record()).toMatchObject({ agentId, guard: { version: dispatcherGuardVersion, provider: "claude" }, previousAgentIds: ["old"] });
  expect(x.archived).toEqual(["agent:old"]);
});

test("an unguarded dispatcher's turn end sets no re-check timer and sends nothing (§3, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  for (const agentStatus of ["running", "idle"]) {
    const x = await oldDispatcher(undefined, agentStatus);
    await x.dispatcher.deliver([note("a")], x.paseo);
    await x.dispatcher.turnEnded("old", x.paseo);
    expect(vi.getTimerCount(), agentStatus).toBe(0);
    x.agents.get("old")!.status = "idle";
    await vi.advanceTimersByTimeAsync(RECHECK_MAX_MS * 3);
    expect(x.sends, agentStatus).toEqual([]);
    x.dispatcher.dispose();
  }
});

test("after Replace, the first send leaves out the notes its board summary already covers (§3, §7)", async () => {
  let gated = false;
  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => (summaryStarted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const x = await oldDispatcher(undefined, "idle", async () => {
    if (gated) {
      summaryStarted();
      await gate;
    }
    return "Board summary";
  });
  // Held for the unguarded one: on the board the new one's summary reads.
  await x.dispatcher.deliver([note("a"), note("b")], x.paseo);
  gated = true;
  const replacing = x.dispatcher.replace(x.paseo, { agentId: "old" });
  await started;
  // Arrives while the summary is written: it may be in it or not, so it is kept.
  await x.dispatcher.deliver([note("c")], x.paseo);
  release();
  const { agentId } = await replacing;
  expect(x.agentCreates[0].options.prompt).toBe("Board summary");
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.turnEnded(agentId, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0].id).toBe(agentId);
  expect(x.sends[0].text).toContain("[c]");
  expect(x.sends[0].text).not.toContain("[a]");
  expect(x.sends[0].text).not.toContain("[b]");
});

test("Replace and Start share one queue: exactly one dispatcher is made, whichever is asked first (§3)", async () => {
  // Replace first: the new dispatcher is live, so the Start behind it is refused.
  const x = await oldDispatcher();
  const [replaced, started] = await Promise.allSettled([x.dispatcher.replace(x.paseo, { agentId: "old" }), x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" })]);
  expect(replaced.status).toBe("fulfilled");
  expect(started).toMatchObject({ status: "rejected", reason: { code: "DISPATCHER_RUNNING" } });
  expect(x.archived).toEqual(["agent:old"]);
  expect(x.agentCreates).toHaveLength(1);
  // Start first: refused (the unguarded one is live, Replace is the only route), then Replace goes through.
  const y = await oldDispatcher();
  const [started2, replaced2] = await Promise.allSettled([y.dispatcher.start(y.paseo, { provider: "claude/claude-sonnet-5-5" }), y.dispatcher.replace(y.paseo, { agentId: "old" })]);
  expect(started2).toMatchObject({ status: "rejected", reason: { code: "DISPATCHER_RUNNING" } });
  expect(replaced2.status).toBe("fulfilled");
  expect(y.archived).toEqual(["agent:old"]);
  expect(y.agentCreates).toHaveLength(1);
  // The old one archived meanwhile: Start makes the new one, and the Replace behind it finds another dispatcher.
  const z = await oldDispatcher();
  z.agents.get("old")!.archivedAt = "2026-11-09T00:00:00.000Z";
  const [started3, replaced3] = await Promise.allSettled([z.dispatcher.start(z.paseo, { provider: "claude/claude-sonnet-5-5" }), z.dispatcher.replace(z.paseo, { agentId: "old" })]);
  expect(started3.status).toBe("fulfilled");
  expect(replaced3).toMatchObject({ status: "rejected", reason: { code: "DISPATCHER_CHANGED" } });
  expect(z.archived).toEqual([]);
  expect(z.agentCreates).toHaveLength(1);
});

test("a started dispatcher records its guard; a refused create restores the earlier one (§1, §3)", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  expect(await x.dispatcher.record()).toMatchObject({ agentId, guard: { version: dispatcherGuardVersion, provider: "claude" }, charter: dispatcherCharterVersion });
  expect(await x.dispatcher.status(x.paseo)).not.toHaveProperty("unguarded");
  const y = await setup();
  y.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: "2026-11-09T00:00:00.000Z" });
  await writeFile(join(y.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z" }));
  y.failAgentCreate(new Error("refused"));
  await expect(y.dispatcher.start(y.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
  expect(await y.dispatcher.record()).not.toHaveProperty("guard");
  expect(await y.dispatcher.record()).not.toHaveProperty("charter");
  // An earlier charter is put back as it was.
  const z = await setup();
  z.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: "2026-11-09T00:00:00.000Z" });
  await writeFile(join(z.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "dw-0", agentId: "old", startedAt: "2026-11-01T00:00:00.000Z", charter: 0 }));
  z.failAgentCreate(new Error("refused"));
  await expect(z.dispatcher.start(z.paseo, { provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "START_FAILED" });
  expect(await z.dispatcher.record()).toMatchObject({ charter: 0 });
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
  x.agents.get(agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await expect(x.dispatcher.whatNext(x.paseo, "What should I do?", seen)).rejects.toMatchObject({ code: "DISPATCHER_DOWN" });
  expect((await x.dispatcher.record()).seenRevision).toBeUndefined();
  // Sent: marked with that line's revision and ids, as Mark seen does.
  x.agents.get(agentId)!.archivedAt = null;
  x.agents.get(agentId)!.status = "idle";
  await x.dispatcher.whatNext(x.paseo, "What should I do?", seen);
  expect(x.sends.at(-1)).toMatchObject({ id: agentId, text: "What should I do?" });
  expect(await x.dispatcher.record()).toMatchObject({ seenRevision: seen.revision, seenIds: seen.ids });
});

test("an unguarded dispatcher takes no messages from the user until Replace: chat send and What should I do? are refused (ruling, Noah 2026-11-09)", async () => {
  const seen = { revision: 1_700_000_000_000, ids: ["e1"] };
  const image = { data: "aGk=", mimeType: "image/png" as const };
  for (const agentStatus of ["idle", "running", "closed"]) {
    const x = await oldDispatcher(undefined, agentStatus);
    await expect(x.dispatcher.send(x.paseo, { text: "Make a card", messageId: "m1" }), agentStatus).rejects.toMatchObject({ code: "DISPATCHER_UNGUARDED" });
    await expect(x.dispatcher.whatNext(x.paseo, "What should I do?", seen), agentStatus).rejects.toMatchObject({ code: "DISPATCHER_UNGUARDED" });
    expect(x.sends, agentStatus).toEqual([]);
    // Refused before anything is marked seen.
    expect((await x.dispatcher.record()).seenRevision, agentStatus).toBeUndefined();
    // Replaced: both reach the new, guarded one, steered as before.
    const { agentId } = await x.dispatcher.replace(x.paseo, { agentId: "old" });
    x.agents.get(agentId)!.status = "idle";
    await x.dispatcher.send(x.paseo, { text: "Make a card", images: [image], messageId: "m2" });
    expect(x.sends.at(-1), agentStatus).toEqual({ id: agentId, text: "Make a card", options: { activeTurnBehavior: "steer", images: [image], messageId: "m2" } });
    await x.dispatcher.whatNext(x.paseo, "What should I do?", seen);
    expect(x.sends.at(-1), agentStatus).toMatchObject({ id: agentId, text: "What should I do?" });
    expect(await x.dispatcher.record(), agentStatus).toMatchObject({ seenRevision: seen.revision });
    expect(x.sends.some((s) => s.id === "old"), agentStatus).toBe(false);
  }
  // A guarded one takes the user's message; a dead one or none is refused as down.
  const y = await oldDispatcher({ version: dispatcherGuardVersion, provider: "claude" });
  await y.dispatcher.send(y.paseo, { text: "hi", messageId: "m3" });
  expect(y.sends).toEqual([{ id: "old", text: "hi", options: { activeTurnBehavior: "steer", messageId: "m3" } }]);
  const z = await setup();
  await expect(z.dispatcher.send(z.paseo, { text: "hi", messageId: "m4" })).rejects.toMatchObject({ code: "DISPATCHER_DOWN" });
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

test("only the MCP servers Paseo passes load: --strict-mcp-config keeps Claude Code's user, project, plugin and cloud servers out (ruling, Noah 2026-11-09)", async () => {
  const x = await setup();
  await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5" });
  const config = x.agentCreates[0].options.config as { options?: { extraArgs?: Record<string, string | null> }; mcpServers?: Record<string, unknown> };
  // The SDK turns a null `extraArgs` value into a bare flag: `--strict-mcp-config`. Paseo's own servers (its plugins'
  // `agent.open.before` servers, chat_polish among them) reach the SDK as `mcpServers` (`--mcp-config`), so they stay.
  expect(config.options?.extraArgs).toEqual({ tools: dispatcherBuiltinTools.join(","), "strict-mcp-config": null });
  expect(Object.keys(config.mcpServers ?? {})).toEqual(["flowly-dispatcher"]);
});

test("the charter limits flowly_reply_to_agent to answering an agent that wrote (DISPATCHER-SPEC §5.4, §6)", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => l.includes("flowly_reply_to_agent"))!;
  expect(line).toBeDefined();
  expect(line).toMatch(/only to answer an agent that messaged you/i);
  expect(line).toMatch(/short/);
  expect(line).toMatch(/never start/i);
  expect(line).toMatch(/never .*relay/i);
});

test("the charter says a card message is queued, not refused, while the session waits on the user (DISPATCHER-SPEC §5.3, §6)", () => {
  const line = dispatcherCharter({ name: "Projects" }).split("\n").find((l) => l.startsWith("- Send a card's session an instruction with flowly_message_card"))!;
  expect(line).toBeDefined();
  expect(line).toMatch(/never answers an ask/);
  expect(line).toMatch(/queued/);
  expect(line).toMatch(/tell the user which card waits/);
  expect(line).not.toContain("SESSION_WAITING_ON_USER");
});

test("the charter says to answer an agent once: the tool or final text, never both (DISPATCHER-SPEC §5.4)", () => {
  const line = dispatcherCharter({ name: "Projects" }).split("\n").find((l) => l.includes("flowly_reply_to_agent"))!;
  expect(line).toMatch(/Answer once/);
  expect(line).toMatch(/final turn text/);
  expect(line).toMatch(/never both/);
});

test("the charter answers board updates in one line per card and lists flowly_create_project once", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => l.startsWith('- Messages that start with "Flowly board update"'))!;
  expect(line).toContain("at most one line per card");
  expect(line).toContain("Never restate the card's report");
  expect(line).toContain("Never add reminders");
  expect(charter).toContain("No headings or bullet lists for routine updates.");
  expect(charter.split("Create a Flowly project with flowly_create_project").length - 1).toBe(1);
});

test("the charter reads \"start X\" as create and start a card, never doing the work itself", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => /"start"/i.test(l))!;
  expect(line).toBeDefined();
  expect(line).toContain("flowly_create_card");
  expect(line).toContain("flowly_start_card");
  expect(line).toContain("ideaId");
  expect(line).toMatch(/never .*(do|perform) the work yourself/i);
  expect(line).toMatch(/never ask/i);
  expect(charter).toContain(startRule);
});

test("the charter says each card creation is confirmed in the chat and a cancel stops it (DISPATCHER-SPEC §5.2, §6)", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => l.includes("CARD_REFUSED"))!;
  expect(line).toBeDefined();
  expect(line).toContain("flowly_create_card");
  expect(line).toMatch(/asks the user to confirm it in this chat/);
  expect(line).toMatch(/do not announce/i);
  expect(line).toContain("CONFIRMATION_UNAVAILABLE");
});

test("the charter has the rules for messaging another group's dispatcher and is versioned 3 (DISPATCHER-SPEC §5.5, §6)", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => l.startsWith("- Message another board group's dispatcher with flowly_message_dispatcher"))!;
  expect(line).toBeDefined();
  expect(line).toMatch(/coordinat/);
  expect(line).toMatch(/user asked for it or it follows from their standing requests/);
  expect(line).toMatch(/short and self-contained/);
  expect(line).toMatch(/cannot see this chat/);
  expect(line).toMatch(/only when it needs (one|an answer)/);
  expect(line).toMatch(/not from the user/);
  expect(line).toMatch(/your own tools in your own group/);
  // The invariant: nothing about a card's asks crosses between dispatchers (ruling, Noah 2026-11-16).
  expect(line).toContain("Nothing about a card's asks crosses between dispatchers");
  expect(line).toMatch(/never answer, approve, deny, dismiss or relay a card's question, permission request or blocker, in this group or another/);
  expect(line).toMatch(/never ask another dispatcher to/);
  expect(line).toMatch(/treat such a request from another dispatcher as one you cannot do/);
  for (const outcome of ["DISPATCHER_DOWN", "DISPATCHER_UNGUARDED", "queued: true", "DISPATCHER_CHAIN_LIMIT", "DISPATCHER_MESSAGE_LIMIT"]) expect(line).toContain(outcome);
  // flowly_reply_to_agent still refuses dispatchers and points to the new tool.
  const reply = charter.split("\n").find((l) => l.includes("flowly_reply_to_agent"))!;
  expect(reply).toMatch(/REPLY_NOT_ALLOWED: [^;]*dispatcher/);
  expect(reply).toContain("flowly_message_dispatcher");
  // A charter change a running dispatcher should get raises the version (§3); the guard is unchanged.
  expect(dispatcherCharterVersion).toBeGreaterThanOrEqual(3);
  expect(dispatcherGuardVersion).toBe(2);
  expect(dispatcherToolNames).toContain("flowly_message_dispatcher");
});

test("the charter says how a follow-up is created and where it branches from, and is versioned 4 (START-CARD-SPEC §11)", () => {
  const charter = dispatcherCharter({ name: "Projects" });
  const line = charter.split("\n").find((l) => l.includes("BASE_CHOICE_NEEDED"))!;
  expect(line).toBeDefined();
  // Linked before the start, so flowly_start_card sees the parent.
  expect(line).toMatch(/flowly_link_cards[^.]*follow_up[^.]*before[^.]*flowly_start_card/);
  expect(line).toMatch(/do not ask the user where to branch/i);
  expect(line).toMatch(/baseRef \("parent" or a branch\) only when the user chose/);
  expect(line).toMatch(/warning/);
  expect(dispatcherCharterVersion).toBe(4);
});

test("the charter says plainly that only the user answers a card's asks", () => {
  expect(dispatcherCharter({ name: "Projects" })).toContain("You have no tool that answers them");
  expect(dispatcherCharter({ name: "Projects" })).toContain("buttons");
});

test("the charter names its group and keeps the dispatcher to that group's projects (§0)", () => {
  const charter = dispatcherCharter({ name: "  Client\nwork " });
  expect(charter).toContain('the board group "Client work"');
  expect(charter).toContain("PROJECT_OUT_OF_GROUP");
});

test("the charter forbids cards whose agent would answer another card's asks (ruling, Noah 2026-11-09)", () => {
  // Card sessions keep Paseo's agent tools, so the rule is the instruction plus the user seeing every card it makes.
  expect(dispatcherCharter({ name: "Projects" })).toContain(
    "Never create or start a card, or word a card's description, so that its agent answers, approves or dismisses another card's questions, permission requests or blockers.",
  );
});

// ---- One dispatcher per board group (DISPATCHER-SPEC §0; BOARD-GROUPS-SPEC §7 step 4) ----

const H = "g2";
/** A board with groups G ("Projects", p) and H ("Clients", p2), in that order. */
function twoGroupBoard(): Board {
  const b = groupBoard();
  b.groups.push(group(H, "Clients", 1));
  b.projects.push(boardProject("p2", H));
  return b;
}
const v1Record = {
  version: 1,
  workspaceId: "dw-0",
  agentId: "old",
  startedAt: "2026-11-01T00:00:00.000Z",
  seenRevision: 1_700_000_000_000,
  seenIds: ["e1"],
  previousAgentIds: ["older"],
  savedTools: [...dispatcherToolNames],
  guard: { version: dispatcherGuardVersion, provider: "claude" },
  charter: dispatcherCharterVersion,
};
const readRaw = async (x: { directory: string }) => JSON.parse(await readFile(join(x.directory, "dispatcher.json"), "utf8")) as DispatcherRecord;

test("the v1 session moves to the group with the most open cards, every field with it; other groups have none", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  // H has two open cards (a Done, an archived card and an archived project's card do not count); G has one.
  x.state.board.projects.push(boardProject("p3", G, T));
  x.state.board.tasks.push(
    boardTask("a", "p"),
    boardTask("b1", "p2"),
    boardTask("b2", "p2", "in_review"),
    boardTask("b3", "p2", "done"),
    boardTask("b4", "p2", "todo", T),
    boardTask("c1", "p3"),
    boardTask("c2", "p3"),
  );
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: null });
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(v1Record));
  await x.hub.migrate();
  // The entry keeps the workspace its session lives in (§1); the record's stays the one new sessions start in.
  const { version: _, ...entry } = v1Record;
  expect(await readRaw(x)).toEqual({ version: 2, workspaceId: entry.workspaceId, groups: { [H]: entry }, legacyGroupId: H });
  expect(await x.hub.status(x.paseo, H)).toEqual({ state: "idle", agentId: "old" });
  expect(await x.hub.status(x.paseo, G)).toEqual({ state: "none", agentId: null });
  // The moved session keeps its workspace and is the one the tools and the open hook know.
  expect(await x.hub.sessionOf("old")).toMatchObject({ groupId: H, workspaceId: "dw-0", entry: { seenRevision: v1Record.seenRevision } });
  expect(await x.hub.owns("dw-0")).toBe(true);
  expect(x.hub.allAgentIds().sort()).toEqual(["old", "older"]);
  expect(x.hub.pastIds()).toEqual(["older"]);
  expect(x.archived).toEqual([]);
});

test("the v1 migration breaks ties for the first group, and a board of empty groups gives it to the first group", async () => {
  for (const tasks of [[boardTask("a", "p"), boardTask("b", "p2")], []]) {
    const x = await setup();
    x.state.board = twoGroupBoard();
    // H comes first in order.
    x.state.board.groups[1].position = -1;
    x.state.board.tasks.push(...tasks);
    await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(v1Record));
    await x.hub.migrate();
    expect(Object.keys((await readRaw(x)).groups)).toEqual([H]);
  }
  // Groups without any project at all.
  const y = await setup();
  y.state.board = emptyBoard();
  y.state.board.groups.push(group("first", "First", 0, { isDefault: true }), group("second", "Second", 1));
  await writeFile(join(y.directory, "dispatcher.json"), JSON.stringify(v1Record));
  await y.hub.migrate();
  expect(Object.keys((await readRaw(y)).groups)).toEqual(["first"]);
});

test("with no groups yet the v1 session waits as unassigned (written as v2), and moves once groups exist", async () => {
  const x = await setup();
  x.state.board = emptyBoard();
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(v1Record));
  await x.hub.migrate();
  const { version: _, ...entry } = v1Record;
  const workspaceId = entry.workspaceId;
  expect(await readRaw(x)).toEqual({ version: 2, workspaceId, groups: {}, unassigned: entry });
  // Nothing to talk to yet: no group.
  await expect(x.hub.status(x.paseo, G)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  // The session is still known (its notes are not news, its workspace is still the dispatcher's).
  expect(x.hub.allAgentIds()).toContain("old");
  expect(await x.hub.owns("dw-0")).toBe(true);
  // Groups arrive (the board's migration, or a restore): the next migration, or any lifecycle call, assigns it.
  x.state.board = groupBoard();
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: null });
  expect(await x.hub.status(x.paseo, G)).toEqual({ state: "idle", agentId: "old" });
  expect(await readRaw(x)).toEqual({ version: 2, workspaceId, groups: { [G]: entry }, legacyGroupId: G });
});

test("the v1 migration is idempotent and never writes v1 again", async () => {
  const x = await setup();
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(v1Record));
  await x.hub.migrate();
  const once = await readFile(join(x.directory, "dispatcher.json"), "utf8");
  await x.hub.migrate();
  await x.hub.migrate(twoGroupBoard());
  expect(await readFile(join(x.directory, "dispatcher.json"), "utf8")).toBe(once);
  // A fresh hub over the migrated file has nothing to do either.
  const again = new Dispatcher(x.directory, { summary: async () => "", mcp: async () => ({ type: "http", url: "", headers: {} }), board: async () => twoGroupBoard() }, x.folder);
  dispatchers.push(again);
  await again.migrate();
  expect(await readFile(join(x.directory, "dispatcher.json"), "utf8")).toBe(once);
  expect(JSON.parse(once).version).toBe(2);
  // An empty install writes nothing.
  const y = await setup();
  await y.hub.migrate();
  await expect(stat(join(y.directory, "dispatcher.json"))).rejects.toThrow();
});

test("an invalid record is kept aside and read as empty, v1 and v2 alike", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const bad of [{ version: 1, agentId: 5 }, { version: 2, workspaceId: null, groups: { [G]: { agentId: 5 } } }, { version: 3 }]) {
    const x = await setup();
    await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(bad));
    expect(await x.hub.status(x.paseo, G)).toEqual({ state: "none", agentId: null });
    const kept = (await readdir(x.directory)).find((n) => n.startsWith("dispatcher.json.invalid-"));
    expect(JSON.parse(await readFile(join(x.directory, kept!), "utf8"))).toEqual(bad);
  }
});

test("each group starts, reads and replaces its own dispatcher, in one shared workspace", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const a = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  // G's live dispatcher does not block H's start.
  const b = await x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  expect(a.agentId).not.toBe(b.agentId);
  expect(x.created).toHaveLength(1);
  expect(x.agentCreates.map((c) => c.workspaceId)).toEqual(["dw-1", "dw-1"]);
  expect(x.agentCreates[1].options).toMatchObject({
    title: "Flowly dispatcher · Clients",
    labels: { "flowly-dispatcher": "1", "flowly-dispatcher-group": H },
    config: { systemPrompt: dispatcherCharter({ name: "Clients" }) },
  });
  expect(await x.hub.status(x.paseo, G)).toEqual({ state: "running", agentId: a.agentId });
  expect(await x.hub.status(x.paseo, H)).toEqual({ state: "running", agentId: b.agentId });
  // DISPATCHER_RUNNING is per group.
  await expect(x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  await expect(x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  // Replace takes the group's own session only: G's id is not H's.
  await expect(x.hub.replace(x.paseo, { groupId: H, agentId: a.agentId })).rejects.toMatchObject({ code: "DISPATCHER_CHANGED" });
  expect(x.archived).toEqual([]);
  // A replaced session of H stays H's history.
  const record = await x.hub.resolvedRecord();
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ ...record, groups: { ...record.groups, [H]: { ...record.groups[H], guard: undefined } } }));
  const fresh = new Dispatcher(x.directory, { summary: async () => "", mcp: async (i) => ({ type: "http", url: "", headers: { g: i.groupId ?? "" } }), board: async () => x.state.board }, x.folder);
  dispatchers.push(fresh);
  const c = await fresh.replace(x.paseo, { groupId: H, agentId: b.agentId });
  expect(x.archived).toEqual([`agent:${b.agentId}`]);
  expect((await fresh.resolvedRecord()).groups).toMatchObject({ [G]: { agentId: a.agentId }, [H]: { agentId: c.agentId, previousAgentIds: [b.agentId] } });
  expect((await fresh.resolvedRecord()).groups[G].previousAgentIds).toBeUndefined();
  // Its MCP credential names its group.
  expect((x.agentCreates[2].options.config as { mcpServers: Record<string, { headers: { g: string } }> }).mcpServers["flowly-dispatcher"].headers.g).toBe(H);
  // An unknown group is refused everywhere.
  for (const call of [
    () => x.hub.status(x.paseo, "nope"),
    () => x.hub.start(x.paseo, { groupId: "nope", provider: "claude/claude-sonnet-5-5" }),
    () => x.hub.replace(x.paseo, { groupId: "nope", agentId: a.agentId }),
    () => x.hub.send(x.paseo, { groupId: "nope", text: "hi", messageId: "m" }),
  ])
    await expect(call()).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
});

test("one group's dead dispatcher is never replaced by another group's start", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const a = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  x.agents.get(a.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  expect(await x.hub.status(x.paseo, G)).toEqual({ state: "ended", agentId: a.agentId });
  expect((await x.hub.resolvedRecord()).groups[G]).toMatchObject({ agentId: a.agentId });
  expect((await x.hub.resolvedRecord()).groups[H].previousAgentIds).toBeUndefined();
  expect(x.archived).toEqual([]);
});

test("starts of two groups at once make one workspace (one queue)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const [a, b] = await Promise.all([
    x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" }),
    x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" }),
  ]);
  expect(x.created).toHaveLength(1);
  expect(new Set(x.agentCreates.map((c) => c.workspaceId))).toEqual(new Set(["dw-1"]));
  expect((await x.hub.resolvedRecord()).groups).toMatchObject({ [G]: { agentId: a.agentId }, [H]: { agentId: b.agentId } });
});

test("the model: passed provider, then the group's Dispatcher model, then the host setting, then the default (§0, §3)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  x.state.board.groups[1].defaults = { dispatcherModel: { provider: "claude", model: "claude-opus-5-5", thinking: "high", mode: "plan" } };
  let hostReads = 0;
  x.hub.modelSetting = async () => {
    hostReads++;
    return { provider: "claude", model: "claude-haiku-5-5" };
  };
  await x.hub.start(x.paseo, { groupId: H });
  expect(x.agentCreates[0].options.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "plan", thinkingOptionId: "high" });
  // The host setting is read only for a group without its own model.
  expect(hostReads).toBe(0);
  await x.hub.start(x.paseo, { groupId: G });
  expect(x.agentCreates[1].options.config).toMatchObject({ provider: "claude/claude-haiku-5-5" });
  expect(hostReads).toBe(1);
  // A passed provider wins over the group's.
  x.agents.get(x.agentCreates[0].options.agentId as string)!.archivedAt = "2026-11-09T00:00:00.000Z";
  await x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  expect(x.agentCreates[2].options.config).toMatchObject({ provider: "claude/claude-sonnet-5-5" });
  expect((x.agentCreates[2].options.config as Record<string, unknown>).modeId).toBeUndefined();
  // A group model on a provider that cannot keep the guard is refused.
  x.agents.get(x.agentCreates[2].options.agentId as string)!.archivedAt = "2026-11-09T00:00:00.000Z";
  x.state.board.groups[1].defaults = { dispatcherModel: { provider: "codex", model: "gpt-6-luna" } };
  await expect(x.hub.start(x.paseo, { groupId: H })).rejects.toMatchObject({ code: "DISPATCHER_PROVIDER_UNSUPPORTED" });
  expect(x.agentCreates).toHaveLength(3);
});

test("a start whose group is deleted meanwhile stores nothing and archives the session it made (§0)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Deleted while the session is created: the entry is dropped and the new session archived.
  const x = await setup();
  x.state.board = twoGroupBoard();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const paseo = {
    ...x.paseo,
    workspaces: {
      ...x.paseo.workspaces,
      ref: (id: string) => {
        const ref = x.paseo.workspaces.ref(id);
        return { ...ref, agents: { create: async (options: Record<string, unknown>) => (await gate, ref.agents.create(options as never)) } };
      },
    },
  } as unknown as PaseoApi;
  const starting = x.hub.start(paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  await vi.waitFor(async () => expect((await x.hub.resolvedRecord()).groups[H]?.agentId).toBeTruthy());
  const made = (await x.hub.resolvedRecord()).groups[H].agentId!;
  x.state.board = groupBoard();
  release();
  await expect(starting).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  expect(x.archived).toEqual([`agent:${made}`]);
  const record = await x.hub.resolvedRecord();
  expect(record.groups[H]).toBeUndefined();
  // Its id is still known: its actions are not news.
  expect(record.previousAgentIds).toEqual([made]);
  expect(x.hub.allAgentIds()).toContain(made);
  // Deleted while the summary is taken: nothing is stored or created.
  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => (summaryStarted = resolve));
  let go!: () => void;
  const summaryGate = new Promise<void>((resolve) => (go = resolve));
  const y = await setup(async () => {
    summaryStarted();
    await summaryGate;
    return "Board summary";
  });
  y.state.board = twoGroupBoard();
  const late = y.hub.start(y.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  await started;
  y.state.board = groupBoard();
  go();
  await expect(late).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  expect(y.agentCreates).toEqual([]);
  expect((await y.hub.resolvedRecord()).groups).toEqual({});
});

test("a group keeps its 20 newest earlier sessions; older ones join the global list, which keeps 100 (§0)", async () => {
  const x = await setup();
  const old = Array.from({ length: globalPreviousAgentIdLimit }, (_, i) => `global-${i}`);
  const earlier = Array.from({ length: previousAgentIdLimit }, (_, i) => `earlier-${i}`);
  await writeFile(
    join(x.directory, "dispatcher.json"),
    JSON.stringify({ version: 2, workspaceId: null, groups: { [G]: { agentId: "current", startedAt: T, previousAgentIds: earlier } }, previousAgentIds: old }),
  );
  const { agentId } = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  const record = await x.hub.resolvedRecord();
  expect(record.groups[G].previousAgentIds).toEqual([...earlier.slice(1), "current"]);
  expect(record.previousAgentIds).toHaveLength(globalPreviousAgentIdLimit);
  expect(record.previousAgentIds!.at(-1)).toBe("earlier-0");
  expect(record.previousAgentIds![0]).toBe("global-1");
  expect(x.hub.pastIds()).not.toContain(agentId);
  expect(x.hub.pastIds()).toContain("current");
  expect(x.hub.allAgentIds()).toContain(agentId);
});

let stopSeq = 0;
/** A stop on a card of `projectId`, committed while the project was in `groupId` (absent: a board without groups). */
const stop = (taskId: string, projectId: string, groupId: string | undefined, extra: Partial<BoardEvent> = {}): BusFact => ({
  kind: "board",
  projectId,
  ...(groupId ? { groupId } : {}),
  title: `Card ${taskId}`,
  event: { id: `s${++stopSeq}`, taskId, actor: "agent", action: "status_changed", from: "todo", to: "blocked", at: "2026-11-08T10:00:00.000Z", ...extra },
});
const startBoth = async (x: Awaited<ReturnType<typeof setup>>) => {
  x.state.board = twoGroupBoard();
  const a = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  const b = await x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  return { a: a.agentId, b: b.agentId };
};

test("a stop goes to the batcher of its project's group when it is pushed; each group's notes reach only its session (§0, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { a, b } = await startBoth(x);
  x.agents.get(a)!.status = "idle";
  x.agents.get(b)!.status = "idle";
  const sent: { groupId: string; agentId: string; notes: string[] }[] = [];
  x.hub.onSent = (notes, _, to) => void sent.push({ ...to, notes: notes.map((n) => n.taskId) });
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  bus.publish([stop("t1", "p", G), stop("t2", "p2", H), stop("t3", "p", undefined)]);
  // The group is the commit's: moving the project on the board afterwards does not re-route a note already pushed.
  x.state.board.projects.find((p) => p.id === "p")!.groupId = H;
  await vi.advanceTimersByTimeAsync(11_000);
  expect(x.sends.map((s) => [s.id, s.text.includes("[t1]"), s.text.includes("[t2]"), s.text.includes("[t3]")]).sort()).toEqual(
    [
      [a, true, false, false],
      [b, false, true, false],
    ].sort(),
  );
  // Each chat row batch is stamped with the group and session that received it.
  expect(sent.sort((l, r) => l.groupId.localeCompare(r.groupId))).toEqual([
    { groupId: G, agentId: a, notes: ["t1"] },
    { groupId: H, agentId: b, notes: ["t2"] },
  ]);
  x.hub.dispose();
});

test("one group's held notes, cooldown and turn end never affect another's (§0, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { a, b } = await startBoth(x);
  x.agents.get(b)!.status = "idle";
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  // G runs: its note is held. H is idle: its note goes out now.
  bus.publish([stop("t1", "p", G), stop("t2", "p2", H)]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(x.sends.map((s) => s.id)).toEqual([b]);
  // H's cooldown holds H's next batch only; G's turn end delivers G's held note at once.
  x.agents.get(a)!.status = "idle";
  await x.hub.turnEnded(b, x.paseo);
  expect(x.sends).toHaveLength(1);
  await x.hub.turnEnded(a, x.paseo);
  expect(x.sends.map((s) => s.id)).toEqual([b, a]);
  expect(x.sends[1].text).toContain("[t1]");
  await x.hub.deliver(H, [{ ...note("t9"), projectId: "p2" }], x.paseo);
  await x.hub.deliver(G, [note("t8")], x.paseo);
  // Both inside their own cooldowns now.
  expect(x.sends).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(x.sends.slice(2).map((s) => [s.id, s.text.includes("[t9]"), s.text.includes("[t8]")]).sort()).toEqual(
    [
      [a, false, true],
      [b, true, false],
    ].sort(),
  );
  x.hub.dispose();
});

test("a group's start window holds only that group's notes (§0, §7)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let summarizing = false;
  const x = await setup(async (groupId) => {
    if (groupId === H) {
      summarizing = true;
      await gate;
    }
    return "Board summary";
  });
  x.state.board = twoGroupBoard();
  const a = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  x.agents.get(a.agentId)!.status = "idle";
  const starting = x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  await vi.waitFor(() => expect(summarizing).toBe(true));
  // H is starting; G's note still goes out at once.
  await x.hub.deliver(G, [note("t1")], x.paseo);
  await x.hub.deliver(H, [{ ...note("t2"), projectId: "p2" }], x.paseo);
  expect(x.sends.map((s) => s.id)).toEqual([a.agentId]);
  release();
  const b = await starting;
  // H's held note waits for its new session (running now): nothing reached G.
  expect(x.sends.map((s) => s.id)).toEqual([a.agentId]);
  x.agents.get(b.agentId)!.status = "idle";
  await x.hub.turnEnded(b.agentId, x.paseo);
  expect(x.sends.map((s) => s.id)).toEqual([a.agentId, b.agentId]);
  expect(x.sends[1].text).toContain("[t2]");
});

test("every batcher drops the facts of any group's dispatcher session, past or current (§0)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  x.state.board = twoGroupBoard();
  await writeFile(
    join(x.directory, "dispatcher.json"),
    JSON.stringify({
      version: 2,
      workspaceId: null,
      groups: { [G]: { agentId: "g-now", startedAt: T, previousAgentIds: ["g-old"] }, [H]: { agentId: "h-now", startedAt: T } },
      previousAgentIds: ["deleted-group"],
    }),
  );
  await x.hub.resolvedRecord();
  const delivered: [string, string[]][] = [];
  vi.spyOn(x.hub, "deliver").mockImplementation(async (groupId, notes) => void delivered.push([groupId, notes.map((n) => n.taskId)]));
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  bus.publish([
    stop("t1", "p", G, { agentId: "g-old" }),
    stop("t2", "p", G, { agentId: "h-now" }),
    stop("t3", "p2", H, { agentId: "deleted-group" }),
    stop("t4", "p2", H, { agentId: "g-now" }),
    stop("t5", "p", G, { agentId: "card-agent" }),
  ]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(delivered).toEqual([[G, ["t5"]]]);
  x.hub.dispose();
});

test("a project that changes group takes its pending notes along, both layers; none reach the old group (§0, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { a, b } = await startBoth(x);
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  // Both run. t1 is held by G's delivery; t2 still waits in G's batcher; t3 (another project of G) stays.
  x.state.board.projects.push(boardProject("p3", G));
  bus.publish([stop("t1", "p", G, { from: "development", to: "in_review" })]);
  await vi.advanceTimersByTimeAsync(11_000);
  bus.publish([stop("t2", "p", G), stop("t3", "p3", G)]);
  x.state.board.projects.find((p) => p.id === "p")!.groupId = H;
  await x.hub.projectMoved("p", H);
  await vi.advanceTimersByTimeAsync(11_000);
  // G's turn end sends only what stayed G's.
  x.agents.get(a)!.status = "idle";
  await x.hub.turnEnded(a, x.paseo);
  expect(x.sends).toHaveLength(1);
  expect(x.sends[0]).toMatchObject({ id: a });
  expect(x.sends[0].text).toContain("[t3]");
  expect(x.sends[0].text).not.toMatch(/\[t1\]|\[t2\]/);
  // H's session gets both moved notes.
  x.agents.get(b)!.status = "idle";
  await x.hub.turnEnded(b, x.paseo);
  expect(x.sends).toHaveLength(2);
  expect(x.sends[1]).toMatchObject({ id: b });
  expect(x.sends[1].text).toContain("[t1] in project p: status_changed — development → in_review");
  expect(x.sends[1].text).toContain("[t2]");
  x.hub.dispose();
});

test("a project's pending notes are dropped when its new group has no dispatcher (§0, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { a } = await startBoth(x);
  x.state.board.groups.push(group("g3", "Empty", 2));
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  bus.publish([stop("t1", "p", G)]);
  await vi.advanceTimersByTimeAsync(11_000);
  bus.publish([stop("t2", "p", G)]);
  x.state.board.projects.find((p) => p.id === "p")!.groupId = "g3";
  await x.hub.projectMoved("p", "g3");
  await vi.advanceTimersByTimeAsync(70_000);
  x.agents.get(a)!.status = "idle";
  await x.hub.turnEnded(a, x.paseo);
  await vi.advanceTimersByTimeAsync(70_000);
  expect(x.sends).toEqual([]);
  // Nothing lingers to fire later.
  expect(vi.getTimerCount()).toBe(0);
  x.hub.dispose();
});

/** A store whose delete moves the group's projects to the default group of `x`'s board and removes it, as the real one does. */
function deleteStore(x: { state: { board: Board } }, calls: string[] = []) {
  return {
    calls,
    deleteGroup: vi.fn(async (input: { id: string; revision: number }) => {
      calls.push("board");
      const b = x.state.board;
      const target = b.groups.find((g) => g.isDefault)!;
      const projectIds = b.projects.filter((p) => p.groupId === input.id).map((p) => p.id);
      b.projects = b.projects.map((p) => (p.groupId === input.id ? { ...p, groupId: target.id } : p));
      b.groups = b.groups.filter((g) => g.id !== input.id);
      return { id: input.id, movedTo: target.id, projectIds };
    }),
  };
}
/** Records the order of the delete's steps: the Paseo archive, the record write and the store's board write. */
function traced(x: Awaited<ReturnType<typeof setup>>, calls: string[]) {
  const hub = x.hub as unknown as { save: (change: unknown) => Promise<void> };
  const save = hub.save.bind(x.hub);
  vi.spyOn(hub, "save").mockImplementation((change) => (calls.push("record"), save(change)));
  return {
    ...x.paseo,
    agents: {
      ref: (id: string) => {
        const ref = x.paseo.agents.ref(id);
        return { ...ref, archive: async () => (calls.push(`archive:${id}`), ref.archive()) };
      },
    },
  } as unknown as PaseoApi;
}

test("a group delete archives that group's session, then writes the record, then the board; its notes are dropped (§0)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { a, b } = await startBoth(x);
  x.agents.get(b)!.status = "idle";
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  // H holds one note (a pending permission keeps it from being sent) and has another in its batcher.
  x.agents.get(b)!.pendingPermissions = [{ id: "perm" }];
  bus.publish([stop("h1", "p2", H)]);
  await vi.advanceTimersByTimeAsync(11_000);
  x.agents.get(b)!.pendingPermissions = [];
  bus.publish([stop("h2", "p2", H)]);
  const calls: string[] = [];
  const paseo = traced(x, calls);
  const store = deleteStore(x, calls);
  const workspaceArchives = x.archived.filter((id) => !id.startsWith("agent:")).length;
  expect(await x.hub.deleteGroup(paseo, { id: H, revision: 1 }, store)).toEqual({ id: H, movedTo: G, projectIds: ["p2"] });
  expect(calls).toEqual([`archive:${b}`, "record", "board"]);
  // Only H's session; the shared workspace is never archived.
  expect(x.archived.filter((id) => id.startsWith("agent:"))).toEqual([`agent:${b}`]);
  expect(x.archived.filter((id) => !id.startsWith("agent:"))).toHaveLength(workspaceArchives);
  const record = await x.hub.resolvedRecord();
  expect(Object.keys(record.groups)).toEqual([G]);
  expect(record.groups[G].agentId).toBe(a);
  expect(record.previousAgentIds).toContain(b);
  expect(x.hub.allAgentIds()).toContain(b);
  // H's held and buffered notes are dropped, never moved to G with p2.
  x.agents.get(a)!.status = "idle";
  await x.hub.turnEnded(a, x.paseo);
  await vi.advanceTimersByTimeAsync(70_000);
  expect(x.sends).toEqual([]);
  // A later stop of p2 is G's now (the commit says so).
  bus.publish([stop("h3", "p2", G)]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(x.sends.map((s) => s.id)).toEqual([a]);
  expect(x.sends[0].text).toContain("[h3]");
  x.hub.dispose();
});

test("a group delete is refused while its dispatcher runs, and when the archive fails; nothing changes (§0)", async () => {
  const x = await setup();
  const { b } = await startBoth(x);
  const before = await readFile(join(x.directory, "dispatcher.json"), "utf8");
  const store = deleteStore(x);
  // Running (and initializing) refuse.
  for (const status of ["running", "initializing"]) {
    x.agents.get(b)!.status = status;
    await expect(x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, store)).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  }
  // An archive that fails refuses with DELETE_FAILED, logged under a fixed label.
  x.agents.get(b)!.status = "idle";
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failing = {
    ...x.paseo,
    agents: { ref: (id: string) => ({ ...x.paseo.agents.ref(id), archive: async () => Promise.reject(new Error("daemon busy")) }) },
  } as unknown as PaseoApi;
  await expect(x.hub.deleteGroup(failing, { id: H, revision: 1 }, store)).rejects.toMatchObject({ code: "DELETE_FAILED" });
  expect(errors.mock.calls.some((c) => c[0] === "Flowly dispatcher not archived for a group delete:")).toBe(true);
  expect(x.archived).toEqual([]);
  expect(store.deleteGroup).not.toHaveBeenCalled();
  expect(await readFile(join(x.directory, "dispatcher.json"), "utf8")).toBe(before);
  expect(x.state.board.groups.map((g) => g.id)).toEqual([G, H]);
});

test("a group delete checks the store's refusals before it archives anything (§0)", async () => {
  const x = await setup();
  const { a, b } = await startBoth(x);
  x.agents.get(a)!.status = "idle";
  x.agents.get(b)!.status = "idle";
  const store = deleteStore(x);
  await expect(x.hub.deleteGroup(x.paseo, { id: G, revision: 1 }, store)).rejects.toMatchObject({ code: "DEFAULT_REQUIRED" });
  await expect(x.hub.deleteGroup(x.paseo, { id: H, revision: 2 }, store)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(x.hub.deleteGroup(x.paseo, { id: "nope", revision: 1 }, store)).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  expect(x.archived).toEqual([]);
  expect(store.deleteGroup).not.toHaveBeenCalled();
  expect(Object.keys((await x.hub.resolvedRecord()).groups).sort()).toEqual([G, H].sort());
});

test("a group delete archives no dead session and needs none (§0)", async () => {
  const x = await setup();
  const { b } = await startBoth(x);
  x.agents.get(b)!.archivedAt = "2026-11-09T00:00:00.000Z";
  const store = deleteStore(x);
  await x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, store);
  expect(x.archived).toEqual([]);
  expect((await x.hub.resolvedRecord()).previousAgentIds).toEqual([b]);
  // A group with no entry at all.
  x.state.board.groups.push(group("g3", "Empty", 2));
  await x.hub.deleteGroup(x.paseo, { id: "g3", revision: 1 }, store);
  expect(store.deleteGroup).toHaveBeenCalledTimes(2);
  expect(x.archived).toEqual([]);
});

test("a group delete is refused with DISPATCHER_UNAVAILABLE when the record can't be read (§0)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  // A directory where the file should be: reading fails with EISDIR.
  await mkdir(join(x.directory, "dispatcher.json"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const store = deleteStore(x);
  const failure = x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, store);
  await expect(failure).rejects.toMatchObject({ code: "DISPATCHER_UNAVAILABLE" });
  await expect(failure).rejects.not.toThrow(x.directory);
  expect(errors.mock.calls.some((c) => c[0] === "Flowly dispatcher record not read for a group delete:")).toBe(true);
  expect(store.deleteGroup).not.toHaveBeenCalled();
  expect(x.state.board.groups.map((g) => g.id)).toEqual([G, H]);
});

test("a group delete shares the start queue: a start asked after it finds no group and makes nothing (§0)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const store = deleteStore(x);
  const deleting = x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, store);
  const starting = x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  await deleting;
  await expect(starting).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  expect(x.agentCreates).toEqual([]);
  expect((await x.hub.resolvedRecord()).groups[H]).toBeUndefined();
  // And a delete asked after a start waits for it, then sees its (running) session.
  x.state.board = twoGroupBoard();
  const started = x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  const refused = x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, store);
  await started;
  await expect(refused).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
});

test("unstamped (v1) chat notes belong to the group the v1 session moved to, else the default group (§0, §9)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  x.state.board.tasks.push(boardTask("b1", "p2"));
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(v1Record));
  await x.hub.migrate();
  const record = await x.hub.resolvedRecord();
  expect(legacyNoteGroup(record, x.state.board)).toBe(H);
  // Kept when that group's session is replaced by a new one.
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: "2026-11-09T00:00:00.000Z" });
  await x.hub.start(x.paseo, { groupId: H, provider: "claude/claude-sonnet-5-5" });
  expect((await x.hub.resolvedRecord()).legacyGroupId).toBe(H);
  // A record with nothing migrated: the default group.
  expect(legacyNoteGroup({}, x.state.board)).toBe(G);
  expect(legacyNoteGroup({}, emptyBoard())).toBeNull();
});

test("a group's first message summarizes only that group's live projects (§6)", () => {
  const b = twoGroupBoard();
  b.projects.push(boardProject("p3", H, T));
  b.tasks.push(boardTask("a1", "p"), boardTask("b1", "p2"), boardTask("c1", "p3"));
  const summary = dispatcherSummary(b, H);
  expect(summary).toContain("- p2: P2");
  expect(summary).not.toContain("- p: P");
  expect(summary).not.toContain("p3");
  expect(summary).toContain("Card b1");
  expect(summary).not.toContain("Card a1");
  expect(dispatcherSummary(b, "empty")).toContain("- none yet");
});

// ---- Review fixes: per-group workspace, flush re-check, delete re-check, late stops (DISPATCHER-SPEC §0-§2, §7) ----

const sonnet = "claude/claude-sonnet-5-5";

test("a group's session keeps the workspace it lives in when another group's start makes a new one (legacy folder, §1, §2)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  // The v1 dispatcher lives in the old in-data folder, which is never reused (§2); no guard, so Replace takes it.
  const old = join(x.directory, "dispatcher");
  await mkdir(old);
  x.workspaces.set("old-ws", { id: "old-ws", archivingAt: null, workspaceDirectory: old });
  x.agents.set("old", { id: "old", workspaceId: "old-ws", status: "idle", archivedAt: null });
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 1, workspaceId: "old-ws", agentId: "old", startedAt: T }));
  await x.hub.migrate();
  expect((await x.hub.resolvedRecord()).groups[G]).toMatchObject({ agentId: "old", workspaceId: "old-ws" });
  // Group H starts: a new workspace in the dispatcher folder, which becomes the one new sessions start in.
  const b = await x.hub.start(x.paseo, { groupId: H, provider: sonnet });
  expect(x.agentCreates.map((c) => c.workspaceId)).toEqual(["dw-1"]);
  expect(await x.hub.resolvedRecord()).toMatchObject({
    workspaceId: "dw-1",
    groups: { [G]: { agentId: "old", workspaceId: "old-ws" }, [H]: { agentId: b.agentId, workspaceId: "dw-1" } },
  });
  // G's session is still the one its token, the open hook and its turn end name, in its own workspace.
  expect(await x.hub.sessionOf("old")).toMatchObject({ groupId: G, workspaceId: "old-ws" });
  expect(await x.hub.sessionOf(b.agentId)).toMatchObject({ groupId: H, workspaceId: "dw-1" });
  // Both tails read.
  const tails = new SessionTailService({} as never);
  tails.dispatcher = (groupId) => x.hub.groupSession(groupId);
  const tailPaseo = {
    agents: {
      ref: (id: string) => ({
        timeline: { refetch: async () => ({ entries: [], epoch: 1, agent: { ...x.agents.get(id)! }, hasOlder: false, hasNewer: false, startCursor: null }) },
        refresh: async () => null,
      }),
    },
  } as unknown as PaseoApi;
  await expect(tails.dispatcherTail({ groupId: G, agentId: "old", limit: 5 }, tailPaseo)).resolves.toMatchObject({ entries: [] });
  await expect(tails.dispatcherTail({ groupId: H, agentId: b.agentId, limit: 5 }, tailPaseo)).resolves.toMatchObject({ entries: [] });
  // Both workspaces stay out of a card's reach.
  expect(await x.hub.owns("old-ws")).toBe(true);
  expect(await x.hub.owns("dw-1")).toBe(true);
  // G's dispatcher is still live: Start is refused.
  await expect(x.hub.start(x.paseo, { groupId: G, provider: sonnet })).rejects.toMatchObject({ code: "DISPATCHER_RUNNING" });
  // Replace archives G's session in its old workspace and starts the new one in the current workspace.
  const c = await x.hub.replace(x.paseo, { groupId: G, agentId: "old" });
  expect(x.archived).toEqual(["agent:old"]);
  expect(x.created).toHaveLength(1);
  expect(x.agentCreates.at(-1)!.workspaceId).toBe("dw-1");
  expect((await x.hub.resolvedRecord()).groups[G]).toMatchObject({ agentId: c.agentId, workspaceId: "dw-1", previousAgentIds: ["old"] });
  expect(await x.hub.owns("old-ws")).toBe(false);
});

test("an entry written without a workspace of its own keeps the earlier one when a new workspace is made (§1)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  x.agents.set("a", { id: "a", workspaceId: "gone-ws", status: "idle", archivedAt: null });
  await writeFile(
    join(x.directory, "dispatcher.json"),
    JSON.stringify({ version: 2, workspaceId: "gone-ws", groups: { [G]: { agentId: "a", startedAt: T }, [H]: { agentId: null, startedAt: null, seenRevision: 5 } } }),
  );
  // Read as the record's workspace until then.
  expect(await x.hub.sessionOf("a")).toMatchObject({ groupId: G, workspaceId: "gone-ws" });
  await x.hub.start(x.paseo, { groupId: H, provider: sonnet });
  const record = await x.hub.resolvedRecord();
  expect(record.workspaceId).toBe("dw-1");
  expect(record.groups[G]).toEqual({ agentId: "a", startedAt: T, workspaceId: "gone-ws" });
  expect(await x.hub.sessionOf("a")).toMatchObject({ groupId: G, workspaceId: "gone-ws" });
  expect(await x.hub.groupSession(G)).toEqual({ agentId: "a", workspaceId: "gone-ws" });
});

test("a refused create restores the group's earlier session with its own workspace (§1, §3)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const x = await setup();
  x.agents.set("old", { id: "old", workspaceId: "dw-0", status: "idle", archivedAt: "2026-11-09T00:00:00.000Z" });
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ version: 2, workspaceId: "dw-0", groups: { [G]: { agentId: "old", startedAt: T, workspaceId: "dw-0" } } }));
  x.failAgentCreate(new Error("no"));
  await expect(x.hub.start(x.paseo, { groupId: G, provider: sonnet })).rejects.toMatchObject({ code: "START_FAILED" });
  const record = await x.hub.resolvedRecord();
  expect(record.workspaceId).toBe("dw-1");
  expect(record.groups[G]).toEqual({ agentId: "old", startedAt: T, workspaceId: "dw-0" });
});

test("a flush whose held notes were taken while it read the dispatcher's state sends nothing (§7)", async () => {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const { agentId } = await x.hub.start(x.paseo, { groupId: G, provider: sonnet });
  x.agents.get(agentId)!.status = "idle";
  let reading!: () => void;
  const read = new Promise<void>((resolve) => (reading = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => {
        const ref = x.paseo.agents.ref(id);
        return { ...ref, refresh: async () => (reading(), await gate, ref.refresh()) };
      },
    },
  } as unknown as PaseoApi;
  const delivering = x.hub.deliver(G, [note("t1")], paseo);
  await read;
  // The project moves to H (no dispatcher there) while G's delivery waits on Paseo: its note leaves G.
  await x.hub.projectMoved("p", H);
  release();
  await delivering;
  expect(x.sends).toEqual([]);
});

/** A store that refuses as the real one does (missing group, stale revision) before `deleteStore`'s delete. */
function checkedStore(x: { state: { board: Board } }) {
  const inner = deleteStore(x);
  return {
    deleteGroup: vi.fn(async (input: { id: string; revision: number }) => {
      const found = x.state.board.groups.find((g) => g.id === input.id);
      if (!found) throw new ToolError("GROUP_NOT_FOUND", "No board group with that id.");
      if (found.revision !== input.revision) throw new ToolError("REVISION_CONFLICT", "This group changed. Reload it before saving.");
      return inner.deleteGroup(input);
    }),
  };
}
const bumpGroup = (x: { state: { board: Board } }, id: string) => {
  x.state.board.groups = x.state.board.groups.map((g) => (g.id === id ? { ...g, revision: g.revision + 1 } : g));
};

test("a group delete checks the group again right before the archive: an edit meanwhile archives nothing (§0)", async () => {
  const x = await setup();
  const { b } = await startBoth(x);
  x.agents.get(b)!.status = "idle";
  const store = checkedStore(x);
  // The group is renamed while the delete reads its session's state.
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => {
        const ref = x.paseo.agents.ref(id);
        return { ...ref, refresh: async () => (id === b && bumpGroup(x, H), ref.refresh()) };
      },
    },
  } as unknown as PaseoApi;
  const before = await readFile(join(x.directory, "dispatcher.json"), "utf8");
  await expect(x.hub.deleteGroup(paseo, { id: H, revision: 1 }, store)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(x.archived).toEqual([]);
  expect(store.deleteGroup).not.toHaveBeenCalled();
  expect(await readFile(join(x.directory, "dispatcher.json"), "utf8")).toBe(before);
});

test("a group delete whose board write is refused after the archive says the session was already archived (§0)", async () => {
  const x = await setup();
  const { b } = await startBoth(x);
  x.agents.get(b)!.status = "idle";
  const store = checkedStore(x);
  // The group is edited while Paseo archives its session.
  const paseo = {
    ...x.paseo,
    agents: {
      ref: (id: string) => {
        const ref = x.paseo.agents.ref(id);
        return { ...ref, archive: async () => (bumpGroup(x, H), ref.archive()) };
      },
    },
  } as unknown as PaseoApi;
  const failure = x.hub.deleteGroup(paseo, { id: H, revision: 1 }, store);
  await expect(failure).rejects.toMatchObject({ code: "REVISION_CONFLICT", message: expect.stringContaining("already archived") });
  expect(x.archived).toEqual([`agent:${b}`]);
  // The group stays (at revision 2) with no session recorded: a refusal now archived nothing and says nothing of it.
  const refusing = { deleteGroup: vi.fn(async (): Promise<never> => Promise.reject(new ToolError("REVISION_CONFLICT", "This group changed. Reload it before saving."))) };
  await expect(x.hub.deleteGroup(x.paseo, { id: H, revision: 2 }, refusing)).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
    message: "This group changed. Reload it before saving.",
  });
  expect(refusing.deleteGroup).toHaveBeenCalledOnce();
  expect(x.archived).toEqual([`agent:${b}`]);
});

test("a stop of a deleted group pushed after its delete recreates no batcher or delivery; a restored group gets stops again (§0, §7)", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T10:00:00.000Z") });
  const x = await setup();
  const { b } = await startBoth(x);
  x.agents.get(b)!.status = "idle";
  const bus = new EventBus();
  wireDispatcher(bus, x.hub, () => x.paseo);
  await x.hub.deleteGroup(x.paseo, { id: H, revision: 1 }, deleteStore(x));
  const maps = x.hub as unknown as { batchers: Map<string, unknown>; perGroup: Map<string, unknown> };
  // Committed while p2 was still H's, pushed after the delete.
  bus.publish([stop("late", "p2", H)]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(maps.batchers.has(H)).toBe(false);
  expect(maps.perGroup.has(H)).toBe(false);
  expect(x.sends).toEqual([]);
  // A restore brings the group back; once it is read on the board, its stops are heard again.
  x.state.board.groups.push(group(H, "Clients", 1));
  await x.hub.status(x.paseo, H);
  bus.publish([stop("back", "p2", H)]);
  expect(maps.batchers.has(H)).toBe(true);
  x.hub.dispose();
});

test("the charter asks for card links with real ids", () => {
  expect(dispatcherCharter({ name: "Main" })).toContain("flowly://card/<projectId>/<taskId>");
});

test("changing the dispatcher's permission mode from the chat keeps it guarded and its record unchanged (Ruling, Noah 2026-11-11)", async () => {
  const x = await setup();
  const { agentId } = await x.dispatcher.start(x.paseo, { provider: "claude/claude-sonnet-5-5", modeId: "default" });
  const agent = x.agents.get(agentId)!;
  agent.status = "idle";
  Object.assign(agent, { availableModes: [{ id: "default" }, { id: "bypassPermissions" }], currentModeId: "default" });
  const before = await readFile(join(x.directory, "dispatcher.json"), "utf8");
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "idle", agentId });
  const calls: string[][] = [];
  const settings = new SessionSettingsService({} as BoardStore, async (_bin, args) => {
    calls.push(args);
    // The CLI switches the mode; nothing else about the session changes.
    if (args[1] === "mode") Object.assign(agent, { currentModeId: args[3] });
    return "";
  }, async () => "/bin/paseo");
  settings.dispatcher = (groupId) => x.hub.groupSession(groupId);
  expect(await settings.dispatcherApply({ groupId: G, agentId, modeId: "bypassPermissions" }, x.paseo)).toEqual({ applied: ["permissions"] });
  expect(calls.map((c) => c.slice(0, 4))).toEqual([["agent", "mode", agentId, "bypassPermissions"]]);
  // The guard is the stored start mark, not the mode: still guarded, no Replace offer, notes and messages still reach it.
  expect(await x.dispatcher.status(x.paseo)).toEqual({ state: "idle", agentId });
  expect(await readFile(join(x.directory, "dispatcher.json"), "utf8")).toBe(before);
  await x.dispatcher.send(x.paseo, { text: "hi", messageId: "m1" });
  expect(x.sends.map((s) => s.text)).toContain("hi");
});

/** One live dispatcher per group: the record and agents the sweep tests share (G's stored session `stale`, H's `h-live`). */
async function leakedDispatchers() {
  const x = await setup();
  x.state.board = twoGroupBoard();
  const entry = (agentId: string, previousAgentIds: string[]) => ({
    agentId,
    startedAt: T,
    workspaceId: "dw-0",
    previousAgentIds,
    savedTools: [...dispatcherToolNames],
    guard: { version: dispatcherGuardVersion, provider: "claude" },
    charter: dispatcherCharterVersion,
  });
  const record = {
    version: 2,
    workspaceId: "dw-0",
    groups: { [G]: entry("stale", ["older", "gone"]), [H]: entry("h-live", ["h-old"]) },
    previousAgentIds: ["ancient"],
  };
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify(record));
  const live = (id: string, labels?: Record<string, string>, workspaceId = "dw-0") => x.agents.set(id, { id, workspaceId, status: "idle", archivedAt: null, ...(labels ? { labels } : {}) });
  const ofGroup = (groupId: string) => ({ "flowly-dispatcher": "1", "flowly-dispatcher-group": groupId });
  // G's stored session is live, but Paseo's lookup misses it, so Flowly reads it as dead (the reported leak).
  live("stale", ofGroup(G));
  x.hidden.add("stale");
  live("older", ofGroup(G));
  live("ancient", ofGroup(G));
  // An archived earlier one is not listed.
  x.agents.set("gone", { id: "gone", workspaceId: "dw-0", status: "idle", archivedAt: T, labels: ofGroup(G) });
  // Never archived: an unrecorded session with the same labels, another group's sessions, a card session.
  live("rogue", ofGroup(G));
  live("h-live", ofGroup(H));
  live("h-old", ofGroup(H));
  live("card-session", undefined, "w-a");
  // Every page holds one agent, so the sweep must follow the cursor.
  x.pageSize(1);
  return x;
}
const liveIds = (x: { agents: Map<string, Agent> }, groupId: string) =>
  [...x.agents.values()].filter((a) => !a.archivedAt && a.labels?.["flowly-dispatcher-group"] === groupId).map((a) => a.id).sort();

test("a start archives every older recorded dispatcher of its group that Paseo still lists live, and nothing else", async () => {
  const x = await leakedDispatchers();
  const { agentId } = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  expect(x.archived.sort()).toEqual(["agent:ancient", "agent:older", "agent:stale"]);
  expect(liveIds(x, G)).toEqual(["rogue", agentId].sort());
  expect(liveIds(x, H)).toEqual(["h-live", "h-old"]);
  expect(x.agents.get("card-session")!.archivedAt).toBeNull();
  // The listing covers background workspaces and leaves archived sessions out.
  expect(x.lists[0].filter).toEqual({ includeArchived: false, includeBackground: true });
  const record = await readRaw(x);
  expect(record.groups[G]).toMatchObject({ agentId, previousAgentIds: ["older", "gone", "stale"] });
  expect(record.groups[G]).not.toHaveProperty("pendingArchive");
  // No workspace is archived.
  expect(x.archived.some((a) => !a.startsWith("agent:"))).toBe(false);
});

test("after Replace no older recorded dispatcher of the group stays live", async () => {
  const x = await leakedDispatchers();
  // The stored one is old enough to be replaced, and Paseo finds it.
  x.hidden.delete("stale");
  const raw = await readRaw(x);
  await writeFile(join(x.directory, "dispatcher.json"), JSON.stringify({ ...raw, groups: { ...raw.groups, [G]: { ...raw.groups[G], charter: 0 } } }));
  x.hidden.add("older");
  const { agentId } = await x.hub.replace(x.paseo, { groupId: G, agentId: "stale" });
  expect(liveIds(x, G)).toEqual(["rogue", agentId].sort());
  expect(liveIds(x, H)).toEqual(["h-live", "h-old"]);
  // Replace's own archive still comes first, before the new session.
  expect(x.archived[0]).toBe("agent:stale");
});

test("a failed archive of an earlier dispatcher keeps the new one, is logged and retried until Paseo archives it", async () => {
  let now = Date.parse("2026-11-17T00:00:00.000Z");
  const x = await leakedDispatchers();
  // A hub with a clock the test moves.
  const hub = new Dispatcher(x.directory, { summary: async () => "Board summary", mcp: async () => ({ type: "http", url: "http://127.0.0.1:1/mcp", headers: {} }), board: async () => x.state.board, now: () => now }, x.folder);
  dispatchers.push(hub);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  x.failArchive("stale", new Error("Agent not found"));
  const { agentId } = await hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  expect(x.archived.sort()).toEqual(["agent:ancient", "agent:older"]);
  let record = await readRaw(x);
  expect(record.groups[G]).toMatchObject({ agentId, pendingArchive: ["stale"] });
  expect(errors.mock.calls.some((c) => c[0] === "Flowly dispatcher earlier session not archived:" && String(c[1]).includes("stale"))).toBe(true);
  // Its notes and changes are still not news: the id stays recorded.
  expect(hub.allAgentIds()).toContain("stale");
  // A status read retries; while Paseo still refuses, the id stays.
  await hub.status(x.paseo, G);
  await vi.waitFor(() => expect(errors.mock.calls.filter((c) => c[0] === "Flowly dispatcher earlier session not archived:")).toHaveLength(2));
  await hub.retryPendingArchives(x.paseo, G);
  expect((await readRaw(x)).groups[G].pendingArchive).toEqual(["stale"]);
  // Reads within the retry window do not list again.
  const lists = x.lists.length;
  await hub.status(x.paseo, G);
  await hub.retryPendingArchives(x.paseo, G);
  expect(x.lists.length).toBe(lists);
  // Once Paseo archives it, the next retry clears it.
  x.failArchive("stale", null);
  now += 61_000;
  await hub.status(x.paseo, G);
  await vi.waitFor(async () => expect((await readRaw(x)).groups[G]).not.toHaveProperty("pendingArchive"));
  expect(x.archived).toContain("agent:stale");
  expect(liveIds(x, G)).toEqual(["rogue", agentId].sort());
  record = await readRaw(x);
  expect(record.groups[G].agentId).toBe(agentId);
});

test("a pending archive Paseo no longer lists live is cleared without archiving; the next start retries the rest", async () => {
  const x = await leakedDispatchers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  x.failArchive("stale", new Error("boom"));
  x.failArchive("older", new Error("boom"));
  const first = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  expect((await readRaw(x)).groups[G].pendingArchive?.sort()).toEqual(["older", "stale"]);
  // Archived by someone else meanwhile: cleared, not archived again.
  x.agents.get("older")!.archivedAt = T;
  // The current one ends; the next start sweeps again and archives the one still pending.
  x.agents.get(first.agentId)!.archivedAt = T;
  x.failArchive("stale", null);
  const archivedBefore = x.archived.length;
  const second = await x.hub.start(x.paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  expect(x.archived.slice(archivedBefore)).toEqual(["agent:stale"]);
  const record = await readRaw(x);
  expect(record.groups[G].agentId).toBe(second.agentId);
  expect(record.groups[G]).not.toHaveProperty("pendingArchive");
});

test("a listing that fails after a start keeps the new dispatcher and leaves the group's earlier ids to retry", async () => {
  const x = await leakedDispatchers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const paseo = { ...x.paseo, agents: { ...x.paseo.agents, list: async () => { throw new Error("list down"); } } } as unknown as PaseoApi;
  const { agentId } = await x.hub.start(paseo, { groupId: G, provider: "claude/claude-sonnet-5-5" });
  expect(errors.mock.calls.some((c) => c[0] === "Flowly dispatcher earlier sessions not listed:")).toBe(true);
  expect((await readRaw(x)).groups[G]).toMatchObject({ agentId, pendingArchive: ["older", "gone", "stale"] });
  // The retry with a working listing archives the live ones and clears the rest.
  await x.hub.retryPendingArchives(x.paseo, G);
  expect(liveIds(x, G)).toEqual(["rogue", agentId].sort());
  expect((await readRaw(x)).groups[G]).not.toHaveProperty("pendingArchive");
});
