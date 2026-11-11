import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { AgentCards } from "./agent-cards";
import { agentFixture } from "./agent-fixture";
import { CardStarter } from "./start-card";
import { ExternalError } from "./connectors/http";
import { codedError, toolFailure } from "./tool-error";
import { agentCardLimits } from "../shared/tools";
import type { Task } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

type Agent = { id: string; workspaceId: string; title: string; status: string; archivedAt: string | null; createdAt: string; provider: string; model: string | null; labels?: Record<string, string> };
type Workspace = { id: string; projectId: string; workspaceDirectory: string; workspaceKind: string; archivingAt: string | null };
type Source = { kind: string; cwd?: string; path?: string; projectId?: string; action?: string; refName?: string; branchName?: string };
type Created = { agentId: string; idempotencyKey?: string; config: Record<string, unknown> & { mcpServers?: Record<string, unknown> }; env?: Record<string, string>; title?: string; labels?: Record<string, string>; prompt?: string };

/** A Git repository as the project root, a fake Paseo that records workspace and session creation, and the starter on top. */
async function setup() {
  const x = await agentFixture();
  roots.push(x.root);
  git(x.a, "init", "-q", "-b", "main");
  git(x.a, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const at = new Date().toISOString();
  const agents = new Map<string, Agent>();
  const workspaces = new Map<string, Workspace>();
  const createdWorkspaces: { title: string; idempotencyKey: string; source: Source }[] = [];
  const createdSessions: (Created & { workspaceId: string })[] = [];
  const archived: string[] = [];
  /** onCreate runs after Paseo made a workspace; lostCreates drops that many create responses. */
  const hooks: { onCreate?: () => unknown; lostCreates: number; archiveFails: boolean } = { lostCreates: 0, archiveFails: false };
  const space = (id: string, kind = "directory", directory = x.a) =>
    workspaces.set(id, { id, projectId: "native", workspaceDirectory: directory, workspaceKind: kind, archivingAt: null });
  const paseo = {
    agents: {
      ref: (id: string) => ({ refresh: async () => (agents.has(id) ? { agent: agents.get(id)! } : null) }),
      list: async (request: { filter?: { includeArchived?: boolean } }) => ({
        entries: [...agents.values()].filter((a) => request.filter?.includeArchived || !a.archivedAt).map((agent) => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
    },
    workspaces: {
      ref: (id: string) => ({
        refresh: async () => workspaces.get(id) ?? null,
        agents: {
          create: async (options: Created) => {
            createdSessions.push({ ...options, workspaceId: id });
            agents.set(options.agentId, {
              id: options.agentId,
              workspaceId: id,
              title: options.title || "",
              status: "running",
              archivedAt: null,
              createdAt: new Date().toISOString(),
              provider: String(options.config.provider).split("/")[0],
              model: String(options.config.provider).split("/")[1] ?? null,
              labels: options.labels,
            });
            return { id: options.agentId };
          },
        },
      }),
      create: async (request: (typeof createdWorkspaces)[number]) => {
        const previous = createdWorkspaces.findIndex((w) => w.idempotencyKey === request.idempotencyKey);
        if (previous >= 0) {
          // Paseo refuses a reused key with a different request.
          const { title, source } = createdWorkspaces[previous];
          if (JSON.stringify({ title, source }) !== JSON.stringify({ title: request.title, source: request.source })) throw new Error("workspace_request_key_conflict");
          return { id: `created-${previous + 1}` };
        }
        createdWorkspaces.push(request);
        const id = `created-${createdWorkspaces.length}`;
        space(id, request.source.kind, request.source.kind === "worktree" ? join(x.root, id) : x.a);
        await hooks.onCreate?.();
        if (hooks.lostCreates > 0) {
          hooks.lostCreates--;
          throw new Error("socket closed");
        }
        return { id };
      },
      archive: async (id: string) => {
        if (hooks.archiveFails) throw new Error("archive refused");
        archived.push(id);
        workspaces.get(id)!.archivingAt = at;
        return { archivedAt: at };
      },
    },
  } as unknown as PaseoApi;
  const cards = new AgentCards(x.store);
  cards.attach(paseo);
  let on = true;
  cards.on = async () => on;
  /** A starter as the plugin builds it; a second one is the same plugin after a reload (no in-memory state). */
  const starterFor = () => {
    const made = new CardStarter(x.store, cards, {
      // ToolServer.prepareSession without the tool service: the same prepared id per operation and workspace.
      prepare: async (taskId, operationId) => {
        const task = (await x.store.read()).tasks.find((t) => t.id === taskId)!;
        const { agentId } = await x.secrets.prepared(taskId, task.workspaceId, operationId);
        return { agentId, instructions: `INSTRUCTIONS ${taskId}`, contextFile: "/ctx.json", cliPath: "/flowly.mjs", skillPath: "/SKILL.md" };
      },
      preparedFor: (operationId) => x.secrets.preparedFor(operationId),
      keptWorktree: (operationId) => x.secrets.keptStart(operationId),
      keepWorktree: (operationId, request) => x.secrets.keepStart(operationId, request),
    });
    made.modelDefault = async () => ({ provider: "claude", model: "claude-sonnet-5-5" });
    return made;
  };
  const starter = starterFor();
  const caller = { agentId: "outside", projectId: "p" };
  const card = async (id: string, fields: Partial<Task> = {}, kind = "directory") => {
    space(fields.workspaceId ?? `ws-${id}`, kind);
    await x.store.mutate((board) => {
      board.tasks.push({
        id,
        projectId: "p",
        workspaceId: `ws-${id}`,
        sourcePath: x.a,
        repoPaths: [x.a],
        title: `Card ${id}`,
        description: `Do ${id}.`,
        status: "todo",
        priority: "normal",
        position: board.tasks.length,
        revision: 1,
        operationId: `op-${id}`,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        ...fields,
      });
    });
  };
  const session = (id: string, workspaceId: string, archivedAt: string | null = null) =>
    agents.set(id, { id, workspaceId, title: id, status: "idle", archivedAt, createdAt: at, provider: "claude", model: "claude-opus-5-5" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => toolFailure(e).code,
    );
  const linear = (taskId: string) =>
    x.store.mutate((board) => {
      board.artifacts.push({
        id: `art-${taskId}`,
        taskId,
        projectId: "p",
        role: "input",
        kind: "url",
        target: "https://linear.app/acme/issue/ZEN-123/fix-x",
        title: "ZEN-123 Fix x",
        note: "",
        createdBy: "human",
        createdAt: at,
        updatedAt: at,
        external: { connectionId: "lin", provider: "linear", key: "ZEN-123", remoteId: "uuid", itemType: "issue" },
      });
    });
  return {
    ...x,
    paseo,
    cards,
    starter,
    starterFor,
    hooks,
    caller,
    card,
    session,
    failure,
    linear,
    agents,
    workspaces,
    createdWorkspaces,
    createdSessions,
    archived,
    turn: (value: boolean) => {
      on = value;
    },
  };
}

test("start_card starts a labelled session in the card's worktree", async () => {
  const x = await setup();
  await x.card("c", { ownsWorkspace: true }, "worktree");
  const started = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(started).toMatchObject({ taskId: "c", workspaceId: "ws-c", replayed: false });
  expect(x.createdWorkspaces).toEqual([]);
  expect(x.createdSessions).toHaveLength(1);
  const created = x.createdSessions[0];
  expect(created).toMatchObject({
    workspaceId: "ws-c",
    agentId: started.agentId,
    idempotencyKey: `ultra-kanban-session:${started.agentId}`,
    title: "Card c",
    labels: { "flowly-task": "c", "flowly-started-by": "outside" },
    // No prompt given: the card's title and description.
    prompt: "Card c\n\nDo c.",
    env: { FLOWLY_CONTEXT_FILE: "/ctx.json", FLOWLY_CLI: "/flowly.mjs", FLOWLY_SKILL: "/SKILL.md" },
  });
  // The New task defaults: the global model, and the provider's suggested mode.
  expect(created.config).toMatchObject({ provider: "claude/claude-sonnet-5-5", systemPrompt: "INSTRUCTIONS c", modeId: "auto" });
  // No MCP server in the saved config: the agent.open.before hook adds it at launch (PASEO-SESSION-TOOLS-SPEC §4).
  expect(created.config.mcpServers).toBeUndefined();
  // The project's own default wins, and a given prompt is sent as is.
  await x.store.mutate((board) => {
    board.projects[0].agentModel = { provider: "codex", model: "gpt-6", thinking: "high", mode: "full-access" };
  });
  await x.card("d", { ownsWorkspace: true }, "worktree");
  await x.starter.start(x.caller, { taskId: "d", prompt: "Only the tests.", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[1].config).toMatchObject({ provider: "codex/gpt-6", modeId: "full-access", thinkingOptionId: "high" });
  expect(x.createdSessions[1].prompt).toBe("Only the tests.");
  // With no default at all, an earlier session never decides: not even a newer one in the project's cards.
  await x.store.mutate((board) => {
    delete board.projects[0].agentModel;
  });
  x.starter.modelDefault = async () => null;
  x.session("elsewhere", "ws-c");
  await x.card("e", {}, "worktree");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "e", idempotencyKey: "go" }, x.paseo))).toBe("MODEL_UNAVAILABLE");
  expect(x.createdSessions).toHaveLength(2);
});

test("start_card ignores a newer summarizer session and starts on the default's reasoning, else the model's own", async () => {
  const x = await setup();
  x.starter.modelDefault = async () => ({ provider: "claude", model: "claude-sonnet-5-5" });
  await x.card("c", {}, "worktree");
  // A newer Haiku summarizer in the card's workspace (made-up ids).
  x.agents.set("sum-1", { id: "sum-1", workspaceId: "ws-c", title: "Summary", status: "idle", archivedAt: null, createdAt: new Date(Date.now() + 60000).toISOString(), provider: "claude", model: "claude-haiku-5-5", labels: { flowly: "summarizer" }, thinkingOptionId: "low", currentModeId: "plan" } as never);
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  const config = x.createdSessions[0].config;
  expect(config).toMatchObject({ provider: "claude/claude-sonnet-5-5", modeId: "auto" });
  // No reasoning in the default: the model's own (no thinkingOptionId), never Extra High.
  expect(config.thinkingOptionId).toBeUndefined();
});

test("a retried start_card returns the same session", async () => {
  const x = await setup();
  // An owned, empty directory card: the first call makes the worktree and the session.
  await x.card("c", { ownsWorkspace: true });
  const first = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  // The response was lost: the same key returns the same workspace and session, nothing new.
  const again = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(again).toEqual({ taskId: "c", workspaceId: first.workspaceId, agentId: first.agentId, replayed: true });
  expect(x.createdWorkspaces).toHaveLength(1);
  expect(x.createdSessions).toHaveLength(1);
  // Another key on a card with a live session is refused, not a second session.
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "other" }, x.paseo))).toBe("CARD_HAS_SESSION");
});

test("an owned card that never had a session moves to a new worktree and its directory workspace is archived", async () => {
  const x = await setup();
  await x.card("c", { ownsWorkspace: true });
  const started = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces).toHaveLength(1);
  const { source, title } = x.createdWorkspaces[0];
  expect(title).toBe("Card c");
  expect(source).toMatchObject({ kind: "worktree", cwd: x.a, projectId: "native", action: "branch-off", refName: "refs/heads/main" });
  // Without a Linear input the branch name is generated.
  expect(source.branchName).toMatch(/^kanban\/.+-[0-9a-f]{6}$/);
  expect(started.workspaceId).toBe("created-1");
  const task = (await x.store.read()).tasks.find((t) => t.id === "c")!;
  expect(task).toMatchObject({ workspaceId: "created-1", ownsWorkspace: true, revision: 2 });
  expect(task.previousWorkspaces).toEqual([expect.objectContaining({ id: "ws-c", kind: "directory", directory: x.a })]);
  expect(task.switch).toBeUndefined();
  expect((await x.store.read()).events.filter((e) => e.taskId === "c").at(-1)).toMatchObject({
    action: "workspace_switched",
    actor: "agent",
    agentId: "outside",
    note: `directory → worktree ${source.branchName}`,
  });
  expect(x.archived).toEqual(["ws-c"]);
  expect(x.createdSessions[0].workspaceId).toBe("created-1");
});

test("directory cards Flowly did not create for this card, or that had a session, need a worktree first", async () => {
  const x = await setup();
  await x.card("old"); // no ownsWorkspace: created before the marker, or linked to an existing workspace
  await x.card("used", { ownsWorkspace: true });
  x.session("gone", "ws-used", new Date().toISOString());
  await x.card("switched", { ownsWorkspace: true, previousWorkspaces: [{ id: "w0", kind: "worktree", directory: "/x", switchedAt: new Date().toISOString() }] });
  for (const taskId of ["old", "used", "switched"])
    expect(await x.failure(x.starter.start(x.caller, { taskId, idempotencyKey: "go" }, x.paseo)), taskId).toBe("NEEDS_WORKTREE");
  expect(x.createdWorkspaces).toEqual([]);
  expect(x.createdSessions).toEqual([]);
  expect(x.archived).toEqual([]);
});

test("a linked-root project starts in its directory workspace", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects[0].links = [{ name: "a", target: x.a }];
  });
  await x.card("c");
  const started = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(started.workspaceId).toBe("ws-c");
  expect(x.createdWorkspaces).toEqual([]);
  expect(x.createdSessions[0].workspaceId).toBe("ws-c");
});

test("a Done card cannot be started; other refusals come before anything is created", async () => {
  const x = await setup();
  await x.card("done", { status: "done" }, "worktree");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "done", idempotencyKey: "go" }, x.paseo))).toBe("CARD_FINISHED");
  await x.card("archived", { archivedAt: new Date().toISOString() }, "worktree");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "archived", idempotencyKey: "go" }, x.paseo))).toBe("NOT_FOUND");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "missing", idempotencyKey: "go" }, x.paseo))).toBe("NOT_FOUND");
  await x.card("busy", {}, "worktree");
  x.session("live", "ws-busy");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "busy", idempotencyKey: "go" }, x.paseo))).toBe("CARD_HAS_SESSION");
  await x.card("c", {}, "worktree");
  // Another project's card is not found from this caller.
  expect(await x.failure(x.starter.start({ ...x.caller, projectId: "q" }, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("NOT_FOUND");
  // No default model: nothing else decides, a live session in the project included.
  x.starter.modelDefault = async () => null;
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("MODEL_UNAVAILABLE");
  x.turn(false);
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("AGENT_CARDS_DISABLED");
  x.turn(true);
  await x.store.mutate((board) => {
    board.projects[0].archivedAt = new Date().toISOString();
  });
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("PROJECT_ARCHIVED");
  expect(x.createdSessions).toEqual([]);
});

test("start_card and create_card share the hourly limit", async () => {
  const x = await setup();
  await x.card("c", {}, "worktree");
  await x.card("d", {}, "worktree");
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  for (let i = 1; i < agentCardLimits.perHour; i++) await x.cards.create(x.caller, { title: `Card ${i}`, idempotencyKey: `k${i}` });
  expect(await x.failure(x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo))).toBe("CARD_LIMIT");
  expect(await x.failure(x.cards.create(x.caller, { title: "One too many", idempotencyKey: "over" }))).toBe("CARD_LIMIT");
  // A replay is not a new start.
  expect((await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo)).replayed).toBe(true);
});

test("the worktree uses the Linear issue's branch name", async () => {
  const x = await setup();
  let branch = "noah/zen-123-fix-x";
  x.starter.connectors = { resolve: async () => ({}) as never, cached: async () => ({ branchName: branch }) as never };
  await x.card("c", { ownsWorkspace: true });
  await x.linear("c");
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces[0].source).toMatchObject({ action: "branch-off", refName: "refs/heads/main", branchName: "noah/zen-123-fix-x" });
  // A branch that already exists and no worktree has checked out is checked out.
  branch = "noah/zen-124-free";
  git(x.a, "branch", branch);
  await x.card("d", { ownsWorkspace: true });
  await x.linear("d");
  await x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces[1].source).toMatchObject({ action: "checkout", refName: "noah/zen-124-free" });
  expect(x.createdWorkspaces[1].source.branchName).toBeUndefined();
  // One another worktree has checked out falls back to the generated name.
  branch = "noah/zen-125-taken";
  git(x.a, "worktree", "add", "-q", "-b", branch, join(x.root, "taken"));
  await x.card("e", { ownsWorkspace: true });
  await x.linear("e");
  await x.starter.start(x.caller, { taskId: "e", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces[2].source).toMatchObject({ action: "branch-off" });
  expect(x.createdWorkspaces[2].source.branchName).toMatch(/^kanban\/card-e-[0-9a-f]{6}$/);
});

test("a failed Linear fetch or an invalid branch name falls back to the generated name", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  x.starter.connectors = {
    resolve: async () => {
      throw new ExternalError("EXTERNAL_UNAVAILABLE", "Linear is busy.");
    },
    cached: async () => undefined,
  };
  await x.card("c", { ownsWorkspace: true });
  await x.linear("c");
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces[0].source.branchName).toMatch(/^kanban\/card-c-[0-9a-f]{6}$/);
  expect(logged).toHaveBeenCalledWith("Flowly Linear branch name not read:", "c", "Linear is busy.");
  for (const [id, name] of [["d", "bad..name"], ["e", ""], ["f", "-leading"]] as const) {
    x.starter.connectors = { resolve: async () => ({}) as never, cached: async () => ({ branchName: name }) as never };
    await x.card(id, { ownsWorkspace: true });
    await x.linear(id);
    await x.starter.start(x.caller, { taskId: id, idempotencyKey: "go" }, x.paseo);
    expect(x.createdWorkspaces.at(-1)!.source.branchName, name).toMatch(new RegExp(`^kanban/card-${id}-[0-9a-f]{6}$`));
  }
});

test("a project root that is not a Git repository on a named branch needs a worktree", async () => {
  const x = await setup();
  await rm(join(x.a, ".git"), { recursive: true, force: true });
  await writeFile(join(x.a, "file.txt"), "x");
  await x.card("c", { ownsWorkspace: true });
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("NEEDS_WORKTREE");
  expect(x.createdWorkspaces).toEqual([]);
});

test("a session started in the directory workspace while the worktree is made keeps the card where it is", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  // The user pressed Start session in the drawer meanwhile.
  x.hooks.onCreate = () => x.session("drawer", "ws-c");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("CARD_HAS_SESSION");
  // The unused worktree is archived; the card and its directory workspace are untouched.
  expect(x.archived).toEqual(["created-1"]);
  expect((await x.store.read()).tasks.find((t) => t.id === "c")).toMatchObject({ workspaceId: "ws-c", revision: 1 });
  expect(x.createdSessions).toEqual([]);
  expect(logged).toHaveBeenCalledWith("Flowly start_card worktree not used:", expect.stringContaining("created-1"), expect.any(String));
});

test("a lost worktree response converges on retry, also after a plugin reload", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  x.hooks.lostCreates = 1;
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("START_FAILED");
  expect((await x.store.read()).tasks.find((t) => t.id === "c")!.workspaceId).toBe("ws-c");
  expect(logged).toHaveBeenCalledWith("Flowly start_card worktree not created:", expect.stringContaining("c"), "socket closed");
  // The plugin reloads and the card is renamed: the retry still sends the identical request.
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "c")!.title = "Renamed";
  });
  const started = await x.starterFor().start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(started).toMatchObject({ workspaceId: "created-1", replayed: false });
  expect(x.createdWorkspaces).toHaveLength(1);
  expect(x.createdSessions).toHaveLength(1);
  expect((await x.store.read()).tasks.find((t) => t.id === "c")!.workspaceId).toBe("created-1");
});

test("a card changed while its worktree was made is not moved", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  x.hooks.onCreate = () =>
    x.store.mutate((board) => {
      board.tasks.find((t) => t.id === "c")!.status = "done";
    });
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("START_FAILED");
  expect((await x.store.read()).tasks.find((t) => t.id === "c")!.workspaceId).toBe("ws-c");
  // The unused worktree is archived, as when a session started meanwhile.
  expect(x.archived).toEqual(["created-1"]);
  expect(x.createdSessions).toEqual([]);
  expect(logged).toHaveBeenCalledWith("Flowly start_card card not moved:", expect.stringContaining("created-1"), expect.any(String));
  // Reopened, a retry with the same key gets that archived worktree back from Paseo and is refused.
  x.hooks.onCreate = undefined;
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "c")!.status = "todo";
  });
  const retried = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo).catch((e: unknown) => toolFailure(e));
  expect(retried).toMatchObject({ code: "START_FAILED", message: expect.stringContaining("new idempotencyKey") });
  expect((await x.store.read()).tasks.find((t) => t.id === "c")!.workspaceId).toBe("ws-c");
  expect(x.createdSessions).toEqual([]);
  // A new key makes a new worktree.
  expect(await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "again" }, x.paseo)).toMatchObject({ workspaceId: "created-2" });
});

test("a worktree another card got meanwhile is refused and not archived", async () => {
  const x = await setup();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  await x.card("other", {}, "worktree");
  x.hooks.onCreate = () =>
    x.store.mutate((board) => {
      board.tasks.find((t) => t.id === "other")!.workspaceId = "created-1";
    });
  const refused = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo).catch((e: unknown) => toolFailure(e));
  expect(refused).toMatchObject({ code: "START_FAILED", message: expect.stringContaining("another card") });
  expect((await x.store.read()).tasks.find((t) => t.id === "c")!.workspaceId).toBe("ws-c");
  expect(x.archived).toEqual([]);
});

test("a refused start makes no branch and keeps no worktree request", async () => {
  const x = await setup();
  const starts = async () => (await readdir(join(x.secrets.directory, "starts")).catch(() => [])).length;
  const remote = join(x.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(x.a, "remote", "add", "origin", remote);
  git(x.a, "push", "-q", "origin", "main");
  git(x.a, "branch", "noah/zen-126-remote");
  git(x.a, "push", "-q", "origin", "noah/zen-126-remote");
  git(x.a, "branch", "-q", "-D", "noah/zen-126-remote");
  x.starter.connectors = { resolve: async () => ({}) as never, cached: async () => ({ branchName: "noah/zen-126-remote" }) as never };
  await x.card("c", { ownsWorkspace: true });
  await x.linear("c");
  x.starter.modelDefault = async () => null;
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("MODEL_UNAVAILABLE");
  expect(git(x.a, "branch", "--list", "noah/zen-126-remote").trim()).toBe("");
  expect(await starts()).toBe(0);
  x.starter.modelDefault = async () => ({ provider: "claude", model: "claude-sonnet-5-5" });
  for (let i = 0; i < agentCardLimits.perHour; i++) await x.cards.create(x.caller, { title: `Card ${i}`, idempotencyKey: `k${i}` });
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("CARD_LIMIT");
  expect(git(x.a, "branch", "--list", "noah/zen-126-remote").trim()).toBe("");
  expect(await starts()).toBe(0);
  expect(x.createdWorkspaces.filter((w) => w.source.kind === "worktree")).toEqual([]);
});

test("an unreadable kept worktree request refuses the start and is kept", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  x.hooks.lostCreates = 1;
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("START_FAILED");
  const [kept] = await readdir(join(x.secrets.directory, "starts"));
  const file = join(x.secrets.directory, "starts", kept);
  await writeFile(file, "{");
  const refused = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo).catch((e: unknown) => toolFailure(e));
  expect(refused).toMatchObject({ code: "START_FAILED", message: expect.stringContaining("new idempotencyKey") });
  expect(await readFile(file, "utf8")).toBe("{");
  expect(x.createdWorkspaces).toHaveLength(1);
  expect(logged).toHaveBeenCalledWith("Flowly start_card kept worktree request unreadable:", expect.any(String), expect.any(String));
});

test("a start waiting in one project does not hold up a start in another", async () => {
  const x = await setup();
  const at = new Date().toISOString();
  await x.store.mutate((board) => {
    board.projects.push({ id: "q", paseoProjectId: "native-q", title: "Other", description: "", primaryPath: x.b, repos: [x.b], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
  });
  await x.card("c", { ownsWorkspace: true });
  await x.card("d", {}, "worktree");
  await x.card("e", { projectId: "q", sourcePath: x.b, repoPaths: [x.b] }, "worktree");
  let open: (value?: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => (open = resolve));
  let inside: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (inside = resolve));
  // The first start stops inside Paseo's worktree create until the gate opens.
  x.hooks.onCreate = () => {
    inside();
    return gate;
  };
  const blocked = x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  await reached;
  let sameSettled = false;
  const same = x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo).finally(() => (sameSettled = true));
  // Another project's start finishes while the gate is still closed (were it queued behind the first, this would never resolve).
  const other = await x.starter.start({ ...x.caller, projectId: "q" }, { taskId: "e", idempotencyKey: "go" }, x.paseo);
  expect(other).toMatchObject({ workspaceId: "ws-e" });
  // The same project's start has not run: no session in its workspace, and it has not settled.
  expect(sameSettled).toBe(false);
  expect(x.createdSessions.map((s) => s.workspaceId)).toEqual(["ws-e"]);
  open();
  expect(await blocked).toMatchObject({ workspaceId: "created-1" });
  expect(await same).toMatchObject({ workspaceId: "ws-d" });
  expect(x.createdSessions.map((s) => s.workspaceId)).toEqual(["ws-e", "created-1", "ws-d"]);
});

test("the directory workspace is kept when another card refers to it or Paseo does not archive it", async () => {
  const x = await setup();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await x.card("c", { ownsWorkspace: true });
  await x.card("old", { archivedAt: new Date().toISOString(), previousWorkspaces: [{ id: "ws-c", kind: "directory", directory: x.a, switchedAt: new Date().toISOString() }] }, "worktree");
  const shared = await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.archived).toEqual([]);
  expect(shared.warnings).toEqual([expect.stringContaining("another card")]);
  await x.card("d", { ownsWorkspace: true });
  x.hooks.archiveFails = true;
  const failed = await x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo);
  expect(failed.workspaceId).toBe("created-2");
  expect(failed.warnings).toEqual([expect.stringContaining("archive refused")]);
  expect(logged).toHaveBeenCalledWith("Flowly start_card directory workspace not archived:", expect.stringContaining("ws-d"), "archive refused");
});

test("two starts of one card at once make one worktree and one session", async () => {
  const x = await setup();
  await x.card("c", { ownsWorkspace: true });
  const [a, b] = await Promise.allSettled([
    x.starter.start(x.caller, { taskId: "c", idempotencyKey: "a" }, x.paseo),
    x.starter.start(x.caller, { taskId: "c", idempotencyKey: "b" }, x.paseo),
  ]);
  expect(a.status).toBe("fulfilled");
  expect(b.status === "rejected" && toolFailure(b.reason).code).toBe("CARD_HAS_SESSION");
  // The same key twice at once: one start, the other a replay of it.
  await x.card("d", { ownsWorkspace: true });
  const [c, d] = await Promise.all([
    x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo),
    x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo),
  ]);
  expect(d).toEqual({ ...c, replayed: true });
  expect(x.createdWorkspaces).toHaveLength(2);
  expect(x.createdSessions).toHaveLength(2);
});

test("concurrent creates and starts cannot pass the hourly limit together, and a failed start gives its slot back", async () => {
  const x = await setup();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (let i = 1; i < agentCardLimits.perHour; i++) await x.cards.create(x.caller, { title: `Card ${i}`, idempotencyKey: `k${i}` });
  // A start that fails after its slot was taken returns it.
  await x.card("c", { ownsWorkspace: true });
  x.hooks.lostCreates = 1;
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo))).toBe("START_FAILED");
  await x.card("d", {}, "worktree");
  const results = await Promise.allSettled([
    x.cards.create(x.caller, { title: "Last", idempotencyKey: "last" }),
    x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo),
    x.cards.create(x.caller, { title: "Later", idempotencyKey: "later" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected").map((r) => toolFailure((r as PromiseRejectedResult).reason).code)).toEqual(["CARD_LIMIT", "CARD_LIMIT"]);
});

test("a Linear branch that exists only on the remote is checked out as a tracking branch", async () => {
  const x = await setup();
  const remote = join(x.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(x.a, "remote", "add", "origin", remote);
  git(x.a, "push", "-q", "origin", "main");
  git(x.a, "branch", "noah/zen-126-remote");
  git(x.a, "push", "-q", "origin", "noah/zen-126-remote");
  git(x.a, "branch", "-q", "-D", "noah/zen-126-remote");
  x.starter.connectors = { resolve: async () => ({}) as never, cached: async () => ({ branchName: "noah/zen-126-remote" }) as never };
  await x.card("c", { ownsWorkspace: true });
  await x.linear("c");
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.createdWorkspaces[0].source).toMatchObject({ action: "checkout", refName: "noah/zen-126-remote" });
  expect(git(x.a, "rev-parse", "--abbrev-ref", "noah/zen-126-remote@{upstream}").trim()).toBe("origin/noah/zen-126-remote");
});

test("the user's Start again takes the same path without the agent switch or limit, and is recorded as the user's", async () => {
  const x = await setup();
  const user = { agentId: "user", projectId: x.caller.projectId, human: true as const };
  await x.card("c", { ownsWorkspace: true });
  x.turn(false);
  for (let i = 0; i < agentCardLimits.perHour; i++) x.cards.reserve("user");
  const started = await x.starter.start(user, { taskId: "c", idempotencyKey: "again-1" }, x.paseo);
  expect(started).toMatchObject({ taskId: "c", workspaceId: "created-1", replayed: false });
  expect(x.createdSessions[0].labels).toEqual({ "flowly-task": "c", "flowly-started-by": "user" });
  const moved = (await x.store.read()).events.filter((e) => e.taskId === "c").at(-1);
  expect(moved).toMatchObject({ action: "workspace_switched", actor: "human" });
  expect(moved?.agentId).toBeUndefined();
  // The same refusals as an agent's start: a live session is not started twice.
  expect(await x.failure(x.starter.start(user, { taskId: "c", idempotencyKey: "again-2" }, x.paseo))).toBe("CARD_HAS_SESSION");
});

test("the user's Start again on a used directory card is told to switch to a worktree, in words for the user", async () => {
  const x = await setup();
  const user = { agentId: "user", projectId: x.caller.projectId, human: true as const };
  await x.card("used", { ownsWorkspace: true });
  x.session("gone", "ws-used", new Date().toISOString());
  const failed = await x.starter.start(user, { taskId: "used", idempotencyKey: "again" }, x.paseo).catch((e: unknown) => e);
  expect(toolFailure(failed).code).toBe("NEEDS_WORKTREE");
  expect(toolFailure(failed).message).not.toMatch(/ask the user/i);
  expect(toolFailure(failed).message).toMatch(/Switch to worktree/);
  // Over RPC only the message travels: the code goes with it, for the client to show its own text.
  expect((codedError(failed) as Error).message).toMatch(/^NEEDS_WORKTREE: /);
  expect(codedError(new Error("plain"))).toEqual(new Error("plain"));
});

test("the user's Start again counts a closed session as the card's, as a running or idle one; an archived one does not (ruling, Noah 2026-11-09)", async () => {
  const x = await setup();
  const user = { agentId: "user", projectId: x.caller.projectId, human: true as const };
  await x.card("c", {}, "worktree");
  x.turn(false);
  const first = await x.starter.start(user, { taskId: "c", idempotencyKey: "again-1" }, x.paseo);
  // Closed is a stopped process that a message resumes: send it instead, for the user as for an agent.
  x.agents.get(first.agentId)!.status = "closed";
  expect(await x.failure(x.starter.start(user, { taskId: "c", idempotencyKey: "again-2" }, x.paseo))).toBe("CARD_HAS_SESSION");
  x.turn(true);
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", idempotencyKey: "agent-1" }, x.paseo))).toBe("CARD_HAS_SESSION");
  x.agents.get(first.agentId)!.status = "idle";
  x.turn(false);
  expect(await x.failure(x.starter.start(user, { taskId: "c", idempotencyKey: "again-3" }, x.paseo))).toBe("CARD_HAS_SESSION");
  // Archived (its asks ended with it): a new session starts next to it, and nothing is archived.
  x.agents.get(first.agentId)!.archivedAt = "2026-11-09T00:00:00.000Z";
  const second = await x.starter.start(user, { taskId: "c", idempotencyKey: "again-4" }, x.paseo);
  expect(second).toMatchObject({ taskId: "c", workspaceId: "ws-c", replayed: false });
  expect(second.agentId).not.toBe(first.agentId);
  expect(x.createdSessions.map((s) => s.workspaceId)).toEqual(["ws-c", "ws-c"]);
  expect(x.archived).toEqual([]);
});

test("a group's default model is used when the project has none, and the project's still wins (board groups spec §5)", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    delete board.projects[0].agentModel;
    board.groups = [{ id: "g", name: "G", position: 0, revision: 1, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", isDefault: true, defaults: { agentModel: { provider: "codex", model: "gpt-6", mode: "full-access" } } }];
    board.projects[0].groupId = "g";
  });
  await x.card("g1", { ownsWorkspace: true }, "worktree");
  await x.starter.start(x.caller, { taskId: "g1", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[0].config).toMatchObject({ provider: "codex/gpt-6", modeId: "full-access" });
  await x.store.mutate((board) => {
    board.projects[0].agentModel = { provider: "claude", model: "claude-opus-5-5", mode: "plan" };
  });
  await x.card("g2", { ownsWorkspace: true }, "worktree");
  await x.starter.start(x.caller, { taskId: "g2", idempotencyKey: "go2" }, x.paseo);
  expect(x.createdSessions[1].config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "plan" });
});

test("a card with an approved plan starts out of plan mode and its default prompt carries the plan (CARD-PLAN-SPEC §6.1)", async () => {
  const x = await setup();
  x.starter.modelDefault = async () => ({ provider: "claude", model: "claude-sonnet-5-5", mode: "plan" });
  const at = new Date().toISOString();
  const plan = (taskId: string, approvedAt: string | null) =>
    x.store.mutate((board) => {
      board.artifacts.push({
        id: `plan-${taskId}`,
        taskId,
        projectId: "p",
        role: "input",
        kind: "file",
        target: "./plans/ship.md",
        title: "Ship plan",
        note: "",
        createdBy: "human",
        createdAt: at,
        updatedAt: at,
        plan: { approvedAt, ...(approvedAt ? { approvedBy: { kind: "human" as const } } : {}), source: "manual", setAt: at },
      });
    });
  await x.card("c", {}, "worktree");
  await plan("c", at);
  await x.starter.start(x.caller, { taskId: "c", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[0].config.modeId).toBe("auto");
  expect(x.createdSessions[0].prompt).toBe(`Card c\n\nDo c.\n\nApproved plan: ${join(x.a, "plans/ship.md")}. Execute this plan; do not plan again.`);
  // A draft plan: the resolved plan mode stands and the prompt has no plan line.
  await x.card("d", {}, "worktree");
  await plan("d", null);
  await x.starter.start(x.caller, { taskId: "d", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[1]).toMatchObject({ prompt: "Card d\n\nDo d.", config: { modeId: "plan" } });
  // An explicit mode wins, also plan mode on an approved card; a given prompt is sent as is.
  await x.card("e", {}, "worktree");
  await plan("e", at);
  await x.starter.start(x.caller, { taskId: "e", mode: "plan", prompt: "Plan again.", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[2]).toMatchObject({ prompt: "Plan again.", config: { modeId: "plan" } });
});

test("an explicit mode is checked against the provider's modes for the card's directory", async () => {
  const x = await setup();
  const asked: { provider: string; cwd?: string }[] = [];
  let listing: () => Promise<unknown> = async () => ({ modes: [{ id: "auto" }, { id: "plan" }, { id: "acceptEdits" }] });
  Object.assign(x.paseo as unknown as Record<string, unknown>, {
    providers: {
      listModes: async (provider: string, options?: { cwd?: string }) => {
        asked.push({ provider, cwd: options?.cwd });
        return listing();
      },
    },
  });
  await x.card("c", {}, "worktree");
  expect(await x.failure(x.starter.start(x.caller, { taskId: "c", mode: "yolo", idempotencyKey: "go" }, x.paseo))).toBe("MODE_UNAVAILABLE");
  await expect(x.starter.start(x.caller, { taskId: "c", mode: "yolo", idempotencyKey: "go2" }, x.paseo)).rejects.toThrow("auto, plan, acceptEdits");
  expect(asked[0]).toEqual({ provider: "claude", cwd: x.a });
  expect(x.createdSessions).toEqual([]);
  await x.starter.start(x.caller, { taskId: "c", mode: "acceptEdits", idempotencyKey: "go3" }, x.paseo);
  expect(x.createdSessions[0].config.modeId).toBe("acceptEdits");
  // When the list can't be read, the mode is passed as given.
  listing = async () => {
    throw new Error("provider offline");
  };
  await x.card("d", {}, "worktree");
  await x.starter.start(x.caller, { taskId: "d", mode: "custom-mode", idempotencyKey: "go" }, x.paseo);
  expect(x.createdSessions[1].config.modeId).toBe("custom-mode");
});
