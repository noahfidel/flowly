import { afterEach, expect, test, vi } from "vitest";
import { readFile, rm, writeFile, stat } from "node:fs/promises";
import { AgentService } from "./agent-service";
import { BoardStore } from "./store";
import { ToolSecrets, digest } from "./tool-context";
import { toolFailure } from "./tool-error";
import { agentFixture } from "./agent-fixture";
import { openNextMoves } from "../shared/next-moves";
import { answersReminder, ideasReminder, movesReminder, outputsReminder } from "./reminders";
import { setupReminder } from "../shared/card-setup";
import { putArtifact } from "./artifacts";
import { ExternalError } from "./connectors/http";
import { turnChecklist } from "../shared/turn-checklist";
import { currentDelivery } from "../shared/workpad";
import { toolContextSchema } from "../shared/tools";

const roots: string[] = [];
async function setup(seed?: Parameters<typeof agentFixture>[0]) {
  const f = await agentFixture(seed);
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const input = (
  ctx: Awaited<ReturnType<AgentService["get"]>>,
  note = "checkpoint",
) => ({ expectedRevision: ctx.revision, request: ctx.request, note });

test("reads live scope and foreign native owner; read telemetry does not write board", async () => {
  const x = await setup(),
    before = await readFile(x.store.path, "utf8"),
    ctx = await x.service.get(x.identity);
  expect(ctx.scope.repoPaths).toEqual([x.a, x.b]);
  expect(ctx.workspace.nativeOwner).toBe("Foreign owner");
  expect(ctx.sessions.entries).toHaveLength(2);
  expect(ctx.turnChecklist).toEqual(turnChecklist);
  // An old server result remains valid; a caller cannot mutate the next live checklist.
  const { turnChecklist: rules, ...legacyContext } = ctx;
  expect(toolContextSchema.safeParse(legacyContext).success).toBe(true);
  rules!.push("caller-local mutation");
  expect((await x.service.get(x.identity)).turnChecklist).toEqual(turnChecklist);
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  await x.store.editTask({
    id: "t",
    revision: 1,
    title: "Human title edit",
    actor: "human",
  });
  expect((await x.service.get(x.identity)).scope.directories).toEqual([
    { repo: x.a, directory: x.a },
    { repo: x.b, directory: x.b },
  ]);
});
test("two concurrent state changes have one winner; stale report cannot overwrite human edits", async () => {
  const x = await setup(),
    other = { ...x.identity, agentId: "second" };
  const [a, b] = await Promise.all([
    x.service.get(x.identity),
    x.service.get(other),
  ]);
  const results = await Promise.allSettled([
    x.service.write(x.identity, "status", {
      ...input(a),
      status: "development",
    }),
    x.service.write(other, "status", { ...input(b), status: "blocked" }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    toolFailure(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).code,
  ).toBe("REVISION_CONFLICT");
  const c = await x.service.get(x.identity);
  await x.store.editTask({
    id: "t",
    revision: c.revision.task,
    priority: "high",
    actor: "human",
  });
  await expect(
    x.service.write(x.identity, "progress", input(c)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
test("concurrent progress and same-state reports preserve every task field", async () => {
  const x = await setup(),
    other = { ...x.identity, agentId: "second" };
  const [a, b] = await Promise.all([
    x.service.get(x.identity),
    x.service.get(other),
  ]);
  const before = (await x.store.read()).tasks[0];
  await Promise.all([
    x.service.write(x.identity, "progress", input(a)),
    x.service.write(other, "progress", {
      ...input(b, "blocker"),
      kind: "blocker",
    }),
  ]);
  expect((await x.store.read()).tasks[0]).toEqual(before);
  const c = await x.service.get(x.identity);
  await x.store.editTask({
    id: "t",
    revision: 1,
    status: "development",
    actor: "human",
  });
  const d = await x.service.get(x.identity),
    sameBefore = (await x.store.read()).tasks[0];
  await x.service.write(x.identity, "status", {
    ...input(d),
    status: "development",
  });
  expect((await x.store.read()).tasks[0]).toEqual(sameBefore);
  expect(
    (await x.store.read()).events.filter((e) => e.reportKind === "blocker"),
  ).toHaveLength(1);
  await expect(
    x.service.write(x.identity, "progress", input(c)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
test("exact replay survives reload, expiry, archive and human completion without another file write", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity),
    request = { ...input(ctx), status: "in_review" };
  const first = await x.service.write(x.identity, "status", request);
  await x.store.editTask({
    id: "t",
    revision: 2,
    status: "done",
    archived: true,
    actor: "human",
  });
  x.advance(16 * 60 * 1000);
  const secrets = new ToolSecrets(x.store.directory);
  await secrets.initialize();
  const restored = new AgentService(new BoardStore(x.store.directory), secrets);
  restored.attach(x.paseo);
  const before = await readFile(x.store.path, "utf8"),
    beforeStat = await stat(x.store.path);
  const replay = await restored.write(x.identity, "status", request);
  expect(replay).toMatchObject({
    receipt: first.receipt,
    replayed: true,
    current: { task: { status: "done" }, writable: false },
  });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  expect((await stat(x.store.path)).mtimeMs).toBe(beforeStat.mtimeMs);
  await expect(
    restored.write(x.identity, "status", { ...request, note: "different" }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});
test("signed identity/revisions/time, status policy and unknown arguments are enforced", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(
      { ...x.identity, agentId: "second" },
      "progress",
      input(ctx),
    ),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      expectedRevision: { task: 2, project: 1 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      request: { ...ctx.request, issuedAt: new Date(0).toISOString() },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      taskId: "another",
    }),
  ).rejects.toThrow();
  for (const status of ["done", "cancelled", "todo", "backlog"])
    await expect(
      x.service.write(x.identity, "status", { ...input(ctx), status }),
    ).rejects.toThrow();
  x.advance(15 * 60 * 1000 + 1);
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect((await x.store.read()).agentReceipts).toHaveLength(0);
});
test("project metadata revision invalidates a legacy card snapshot", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await x.store.mutate((b) => {
    b.projects[0].title = "Human project edit";
    b.projects[0].revision++;
  });
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect((await x.service.get(x.identity)).scope.repoPaths).toEqual([x.a, x.b]);
});
test("wrong, missing, archived actors and missing/incompatible/archiving workspaces are rejected", async () => {
  const x = await setup();
  for (const agentId of ["wrong", "missing"])
    await expect(
      x.service.get({ ...x.identity, agentId }),
    ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  x.actors.actor.archivedAt = new Date().toISOString();
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "SESSION_MISMATCH",
  });
  x.actors.actor.archivedAt = null;
  x.setWorkspace({ ...x.workspace(), workspaceDirectory: x.store.directory });
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "WORKSPACE_INCOMPATIBLE",
  });
  x.setWorkspace(null);
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "RESOURCE_UNAVAILABLE",
  });
  x.setWorkspace({
    id: "w",
    projectId: "foreign",
    projectDisplayName: "Foreign",
    workspaceDirectory: x.a,
    workspaceKind: "directory",
    status: "done",
    archivingAt: new Date().toISOString(),
  });
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "RESOURCE_UNAVAILABLE",
  });
});
test("archive and human done/cancelled reject new writes, read stays explicit", async () => {
  const x = await setup();
  for (const status of ["done", "cancelled"] as const) {
    await x.store.mutate((b) => {
      b.tasks[0].status = status;
      b.tasks[0].revision++;
    });
    const ctx = await x.service.get(x.identity);
    expect(ctx.writable).toBe(false);
    await expect(
      x.service.write(x.identity, "progress", input(ctx)),
    ).rejects.toMatchObject({ code: "TASK_FINISHED" });
  }
  await x.store.mutate((b) => {
    b.tasks[0].status = "todo";
    b.projects[0].archivedAt = new Date().toISOString();
  });
  const ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "ARCHIVED" });
});
test("capacity refuses fresh writes, allows replay, prunes only expired receipts", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  const first = await x.service.write(x.identity, "progress", input(ctx));
  await x.store.mutate((b) => {
    const seed = b.agentReceipts[0];
    for (let i = 1; i < 5000; i++)
      b.agentReceipts.push({
        ...seed,
        key: "fixture-" + i,
        eventId: "fixture-" + i,
      });
  });
  const fresh = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "progress", input(fresh)),
  ).rejects.toMatchObject({ code: "RECEIPTS_FULL" });
  expect(
    (await x.service.write(x.identity, "progress", input(ctx))).receipt,
  ).toEqual(first.receipt);
  await x.store.mutate((b) => {
    b.agentReceipts[1].expiresAt = new Date(0).toISOString();
  });
  await x.service.write(x.identity, "progress", input(fresh));
  expect((await x.store.read()).agentReceipts).toHaveLength(5000);
});
test("storage errors have a code and preserve data; public board strips private receipts", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "progress", input(ctx));
  expect("agentReceipts" in (await x.store.view())).toBe(false);
  expect(JSON.stringify(await x.store.read())).not.toContain(ctx.request.id);
  await writeFile(x.store.path, "{invalid");
  try {
    await x.service.get(x.identity);
    throw new Error("expected failure");
  } catch (error) {
    expect(toolFailure(error).code).toBe("STORE_INVALID");
  }
  expect(await readFile(x.store.path, "utf8")).toBe("{invalid");
});
test("session context signatures survive reload, reject rebinding and credential tampering", async () => {
  const x = await setup(),
    token = x.secrets.credential(x.identity),
    path = await x.secrets.writeContext(x.identity, "mcp");
  await x.secrets.writeContext(x.identity, "cli");
  expect(JSON.parse(await readFile(path, "utf8")).methods).toEqual([
    "mcp",
    "cli",
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const restored = new ToolSecrets(x.store.directory);
  await restored.initialize();
  expect(restored.authenticate(token)).toEqual(x.identity);
  expect(() => restored.authenticate(token.slice(0, -3) + "abc")).toThrow();
  expect(() => restored.authenticate(digest(token))).toThrow();
  await expect(
    restored.writeContext({ ...x.identity, taskId: "wrong" }),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  await writeFile(x.store.directory + "/tool-key.json", "invalid");
  await expect(
    new ToolSecrets(x.store.directory).initialize(),
  ).rejects.toMatchObject({ code: "TOOLS_UNAVAILABLE" });
  expect(await readFile(x.store.directory + "/tool-key.json", "utf8")).toBe(
    "invalid",
  );
});
test("agents only see and use the project's enabled lanes", async () => {
  const x = await setup();
  const board = await x.store.read();
  const project = board.projects[0];
  await x.store.updateProject({
    id: project.id,
    revision: project.revision,
    lanes: (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({
      status,
      enabled: status !== "blocked" && status !== "committed" && status !== "integrated",
      ...(status === "in_review" ? { name: "QA" } : {}),
    })),
  });
  const ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).toEqual(["design", "development", "test", "in_review"]);
  expect(ctx.lanes.find((l) => l.status === "in_review")?.name).toBe("QA");
  expect(ctx.lanes.some((l) => l.status === "blocked")).toBe(false);
  await expect(
    x.service.write(x.identity, "status", { ...input(ctx), status: "blocked" }),
  ).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
  await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  expect((await x.store.read()).tasks[0].status).toBe("in_review");
});
test("the retired in_progress status is an alias: keeps the work stage, else Development", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "in_progress" });
  expect((await x.store.read()).tasks[0].status).toBe("development");
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "test" });
  ctx = await x.service.get(x.identity);
  const result = await x.service.write(x.identity, "status", { ...input(ctx), status: "in_progress" });
  expect(result.receipt.status).toBe("test");
  expect((await x.store.read()).tasks[0].status).toBe("test");
});
test("an agent sets a missing type once; an existing type is kept", async () => {
  const x = await setup({ type: false });
  expect((await x.store.read()).tasks[0].type).toBeUndefined();
  let ctx = await x.service.get(x.identity);
  const call = { expectedRevision: ctx.revision, request: ctx.request, type: "bugfix" };
  const set = await x.service.write(x.identity, "type", call);
  let task = (await x.store.read()).tasks[0];
  expect(task.type).toBe("bugfix");
  expect(task.revision).toBe(ctx.revision.task + 1);
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "type_set", actor: "agent", note: "bugfix" });
  // A replay acknowledges the original write without another change.
  expect((await x.service.write(x.identity, "type", call)).replayed).toBe(true);
  ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "type", { expectedRevision: ctx.revision, request: ctx.request, type: "feature" }),
  ).rejects.toMatchObject({ code: "TYPE_ALREADY_SET" });
  // The same type again changes nothing.
  const same = await x.service.write(x.identity, "type", { expectedRevision: ctx.revision, request: ctx.request, type: "bugfix" });
  expect(same.receipt.eventId).toBe("");
  expect(same.receipt.taskRevision).toBe(set.receipt.taskRevision);
  // A type the user chose is never replaced.
  task = (await x.store.read()).tasks[0];
  await x.store.editTask({ id: "t", revision: task.revision, type: "docs", actor: "human" });
  ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "type", { expectedRevision: ctx.revision, request: ctx.request, type: "chore" }),
  ).rejects.toMatchObject({ code: "TYPE_ALREADY_SET" });
  expect((await x.store.read()).tasks[0].type).toBe("docs");
  await expect(
    x.service.write(x.identity, "type", { expectedRevision: ctx.revision, request: ctx.request, type: "epic" }),
  ).rejects.toThrow();
});

test("next moves: recorded per session without a revision change; the latest wins; limits and finished cards refused", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  const moves = [
    { label: "  Verify with Luna ", prompt: "Run the Luna verification for this change." },
    { label: "Commit", prompt: "Commit and push." },
  ];
  const call = { expectedRevision: ctx.revision, request: ctx.request, moves };
  const first = await x.service.write(x.identity, "next_moves", call);
  expect(first.receipt.action).toBe("next_moves");
  expect(first.receipt.taskRevision).toBe(ctx.revision.task);
  let board = await x.store.read();
  expect(board.tasks[0].revision).toBe(ctx.revision.task);
  expect(board.ideas).toHaveLength(0);
  expect(board.events.at(-1)).toMatchObject({
    action: "next_moves_suggested",
    actor: "agent",
    agentId: x.identity.agentId,
    note: "Verify with Luna · Commit",
    moves: [{ label: "Verify with Luna", prompt: "Run the Luna verification for this change." }, { label: "Commit", prompt: "Commit and push." }],
  });
  expect((await x.service.write(x.identity, "next_moves", call)).replayed).toBe(true);
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: [{ label: "Push", prompt: "Push it." }] });
  board = await x.store.read();
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual([{ label: "Push", prompt: "Push it." }]);
  ctx = await x.service.get(x.identity);
  const bad = (m: unknown) => x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: m });
  // An empty list is the explicit "nothing for the user" (NEXT-MOVES-SPEC §8.2); see its own test below.
  await expect(bad([1, 2, 3, 4].map((i) => ({ label: `m${i}`, prompt: "p" })))).rejects.toThrow();
  await expect(bad([{ label: "  ", prompt: "p" }])).rejects.toThrow();
  await expect(bad([{ label: "x".repeat(61), prompt: "p" }])).rejects.toThrow();
  await expect(bad([{ label: "ok", prompt: "p".repeat(2001) }])).rejects.toThrow();
  await expect(bad([{ label: "Done", moveTo: "done" }, { label: "Done 2", moveTo: "done" }])).rejects.toThrow();
  await expect(bad([{ label: "Done", moveTo: "review" }])).rejects.toThrow();
  await expect(bad([{ label: "No prompt" }])).rejects.toThrow();
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: [{ label: "Commit", prompt: "Commit and push." }, { label: "Move to Done", moveTo: "done" }] });
  board = await x.store.read();
  expect(board.events.at(-1)?.moves).toEqual([{ label: "Commit", prompt: "Commit and push." }, { label: "Move to Done", moveTo: "done" }]);
  expect(board.tasks[0].revision).toBe(ctx.revision.task);
  ctx = await x.service.get(x.identity);
  const task = (await x.store.read()).tasks[0];
  await x.store.editTask({ id: "t", revision: task.revision, status: "done", actor: "human" });
  ctx = await x.service.get(x.identity);
  await expect(bad([{ label: "ok", prompt: "p" }])).rejects.toMatchObject({ code: "TASK_FINISHED" });
});

/** A repository stand-in for the workpad: HEAD, dirty state and the commits it knows (WORKPAD-SPEC §4.2, §5.1). */
function fakeGit(state: { head: string | null; dirty?: boolean; commits?: string[] }) {
  return async (_cwd: string, args: string[]) => {
    if (!state.head) throw new Error("not a git repository");
    const key = args.join(" ");
    if (key === "rev-parse --short=12 HEAD") return `${state.head}\n`;
    if (key === "rev-parse --abbrev-ref HEAD") return "main\n";
    if (key === "status --porcelain") return state.dirty ? " M file\n" : "";
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const want = args.at(-1)!.replace("^{commit}", "");
      const hit = [state.head, ...(state.commits || [])].find((c) => c.startsWith(want));
      if (hit) return `${hit}\n`;
      throw new Error("unknown revision");
    }
    throw new Error(`unexpected git ${key}`);
  };
}
const workpadInput = (
  ctx: Awaited<ReturnType<AgentService["get"]>>,
  body: { acceptance?: unknown[]; validation?: unknown[]; confusions?: unknown[] },
  workpadRevision = ctx.workpad?.revision ?? 0,
) => ({ expectedRevision: ctx.revision, request: ctx.request, workpadRevision, acceptance: [], validation: [], confusions: [], ...body });

test("workpad: replace with its own revision; task revision and status untouched; replay returns the receipt", async () => {
  const x = await setup({ workpad: false });
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  const ctx = await x.service.get(x.identity);
  expect(ctx.workpad).toBeNull();
  const body = {
    acceptance: [{ text: "Card shows Checks n/m", done: false }],
    validation: [{ id: "unit", text: "Unit tests", command: "npm test", state: "pass" }],
    confusions: [{ text: "Unclear whether Notes stay" }],
  };
  const first = await x.service.write(x.identity, "workpad", workpadInput(ctx, body));
  expect(first.receipt).toMatchObject({ action: "workpad", workpadRevision: 1, taskRevision: ctx.revision.task });
  const stored = (await x.store.read()).workpads[0]!;
  expect(stored).toMatchObject({ revision: 1, updatedBy: "agent", agentId: "actor", head: { sha: "aaaaaaaaaaaa", branch: "main", dirty: false } });
  expect(stored.validation[0]).toMatchObject({ id: "unit", state: "pass", sha: "aaaaaaaaaaaa", command: "npm test" });
  expect(stored.env).toMatchObject({ path: x.a, head: { sha: "aaaaaaaaaaaa" } });
  expect((await x.store.read()).tasks[0]!.revision).toBe(ctx.revision.task);
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "workpad_updated", actor: "agent", note: "Acceptance 0/1 · Checks 1/1 · 1 confusion" });
  expect(first.current?.workpad).toMatchObject({ revision: 1, open: { unchecked: 1, total: 1 } });
  expect(first.current?.workpad?.validation[0]?.fresh).toBe("fresh");
  const replay = await x.service.write(x.identity, "workpad", workpadInput(ctx, body));
  expect(replay.replayed).toBe(true);
  expect((await x.store.read()).workpads[0]!.revision).toBe(1);
});

test("workpad: a person's tick bumps the workpad revision only; the agent's stale copy conflicts, other tools do not", async () => {
  const x = await setup({ workpad: false });
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  const ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ id: "a", text: "A", done: false }] }));
  const { WorkpadService } = await import("./workpad");
  const human = new WorkpadService(x.store, fakeGit({ head: "aaaaaaaaaaaa" }));
  await human.check({ taskId: "t", section: "acceptance", itemId: "a", done: true }, x.paseo);
  const after = await x.service.get(x.identity);
  expect(after.revision.task).toBe(ctx.revision.task);
  expect(after.workpad).toMatchObject({ revision: 2, acceptance: [{ id: "a", done: true, by: "human" }] });
  await expect(x.service.write(x.identity, "workpad", workpadInput(after, { acceptance: [{ id: "a", text: "A", done: false }] }, 1))).rejects.toMatchObject({
    code: "WORKPAD_CONFLICT",
  });
  // Progress with the same task revision still goes through.
  await x.service.write(x.identity, "progress", input(after));
  // Re-read and keep the person's tick: by stays human.
  const fresh = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(fresh, { acceptance: [{ id: "a", text: "A", done: true }] }));
  expect((await x.store.read()).workpads[0]!.acceptance[0]).toMatchObject({ done: true, by: "human" });
});

test("workpad: commits are verified; no sha outside git; limits are WORKPAD_INVALID", async () => {
  const x = await setup();
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa", commits: ["bbbbbbbbbbbb"] });
  const ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { validation: [{ text: "Old run", state: "fail", sha: "bbbbbbb", dirty: true }] }));
  expect((await x.store.read()).workpads[0]!.validation[0]).toMatchObject({ sha: "bbbbbbbbbbbb", dirty: true, state: "fail" });
  const next = await x.service.get(x.identity);
  expect(next.workpad?.validation[0]?.fresh).toBe("stale");
  await expect(x.service.write(x.identity, "workpad", workpadInput(next, { validation: [{ text: "x", state: "pass", sha: "cccccccc" }] }))).rejects.toMatchObject({
    code: "WORKPAD_INVALID",
  });
  await expect(
    x.service.write(x.identity, "workpad", workpadInput(next, { acceptance: [{ id: "a", text: "a", done: false }, { id: "a", text: "b", done: false }] })),
  ).rejects.toMatchObject({ code: "WORKPAD_INVALID" });
  x.service.git = fakeGit({ head: null });
  await expect(x.service.write(x.identity, "workpad", workpadInput(next, { validation: [{ text: "x", state: "pass", sha: "bbbbbbb" }] }))).rejects.toMatchObject({
    code: "WORKPAD_INVALID",
  });
  // Without git a check still records, with no commit (freshness unknown).
  await x.service.write(x.identity, "workpad", workpadInput(next, { validation: [{ text: "x", state: "pass" }] }));
  const noGit = await x.service.get(x.identity);
  expect(noGit.workpad?.validation[0]?.fresh).toBe("unknown");
  expect(noGit.workpad?.head).toBeNull();
});

test("workpad: delivering with open items needs acknowledgeOpen; the snapshot marks the delivery", async () => {
  const x = await setup({ workpad: false });
  const repo = { head: "aaaaaaaaaaaa" };
  x.service.git = fakeGit(repo);
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { validation: [{ id: "unit", text: "Unit tests", state: "pass" }, { id: "e2e", text: "E2E", state: "unrun" }] }));
  // A new commit after the run makes the pass out of date at delivery.
  repo.head = "cccccccccccc";
  ctx = await x.service.get(x.identity);
  const refused = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review" }).catch((e) => e);
  expect(refused).toMatchObject({ code: "WORKPAD_OPEN" });
  expect(String(refused.message)).toContain("check not run: E2E");
  expect(String(refused.message)).toContain("out of date");
  expect((await x.store.read()).tasks[0]!.status).toBe("development");
  // Same request, now acknowledged: nothing was committed, so it is not a reuse.
  const ok = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered; E2E not run, unit tests predate the last commit"), status: "in_review", acknowledgeOpen: true });
  expect(ok.receipt.status).toBe("in_review");
  const board = await x.store.read();
  const moved = board.events.find((e) => e.id === ok.receipt.eventId)!;
  expect(moved.workpad).toEqual({ unchecked: 0, failed: 0, unrun: 1, stale: 1, total: 2, revision: 1 });
  expect(board.workpads[0]!.delivery).toMatchObject({ total: 2, eventId: moved.id });
  expect(board.workpads[0]!.head?.sha).toBe("cccccccccccc");
});

test("workpad: nothing open delivers without acknowledgement", async () => {
  const x = await setup();
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Done", done: true }], validation: [{ text: "Tests", state: "pass" }] }));
  ctx = await x.service.get(x.identity);
  const ok = await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  expect((await x.store.read()).events.find((e) => e.id === ok.receipt.eventId)?.workpad?.total).toBe(0);
});

test("workpad: off for the project — tool refused, no gate, get_task hides it; data kept and back when on", async () => {
  const x = await setup({ workpad: false });
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  let ctx = await x.service.get(x.identity);
  expect(ctx.workpadEnabled).toBe(true);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { validation: [{ id: "e2e", text: "E2E", state: "unrun" }] }));
  const off = await x.store.updateProject({ id: "p", revision: 1, workpad: false });
  expect(off.workpad).toBe(false);
  ctx = await x.service.get(x.identity);
  expect(ctx).toMatchObject({ workpadEnabled: false, workpad: null, plan: [] });
  await expect(x.service.write(x.identity, "workpad", workpadInput(ctx, {}, 1))).rejects.toMatchObject({ code: "WORKPAD_DISABLED" });
  // The open E2E check does not stop delivery and no snapshot is taken.
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  const ok = await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  expect((await x.store.read()).events.find((e) => e.id === ok.receipt.eventId)?.workpad).toBeUndefined();
  expect((await x.store.read()).workpads[0]!.delivery).toBeUndefined();
  await x.store.updateProject({ id: "p", revision: 2, workpad: true });
  ctx = await x.service.get(x.identity);
  expect(ctx.workpad).toMatchObject({ revision: 1, validation: [{ id: "e2e" }] });
});

test("get_task lists the project's paseo.json scripts by name and type only (WORKFLOW-INSIGHTS-SPEC §5.4)", async () => {
  const x = await setup();
  expect((await x.service.get(x.identity)).projectScripts).toBeUndefined();
  await writeFile(`${x.a}/paseo.json`, JSON.stringify({ scripts: { verify: { type: "script", command: "npm run typecheck && npm test" }, web: { command: "npm run dev" } } }));
  const ctx = await x.service.get(x.identity);
  expect(ctx.projectScripts).toEqual([
    { name: "verify", type: "script" },
    { name: "web", type: "service" },
  ]);
  expect(JSON.stringify(ctx)).not.toContain("npm run dev");
});

test("get_task returns the AI output language for next moves and ideas (AI-LANGUAGE-SPEC §5)", async () => {
  const x = await setup();
  expect((await x.service.get(x.identity)).outputLanguage).toEqual({ code: "en", name: "English" });
  x.service.aiLanguage = async () => "zh-CN";
  expect((await x.service.get(x.identity)).outputLanguage).toEqual({ code: "zh-CN", name: "Simplified Chinese" });
});

// Next moves ride on the delivery call (NEXT-MOVES-SPEC §8).
const commitMove = { label: "Commit", prompt: "Commit and push." };
const suggestions = (board: Awaited<ReturnType<BoardStore["read"]>>) => board.events.filter((e) => e.action === "next_moves_suggested");

test("next moves on the delivery call: one write records the status change, then the suggestion", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const call = {
    ...input(ctx, "Delivered"),
    status: "in_review",
    nextMoves: [{ label: "  Commit  ", prompt: "Commit and push." }, { label: "Move to Done", moveTo: "done" }],
  };
  const res = await x.service.write(x.identity, "status", call);
  expect(res.receipt).toMatchObject({ action: "status", status: "in_review", taskRevision: ctx.revision.task + 1 });
  const board = await x.store.read();
  const [moved, suggested] = board.events.slice(-2);
  expect(moved).toMatchObject({ action: "status_changed", id: res.receipt.eventId, to: "in_review" });
  expect(suggested).toMatchObject({
    action: "next_moves_suggested",
    actor: "agent",
    agentId: x.identity.agentId,
    note: "Commit · Move to Done",
    moves: [commitMove, { label: "Move to Done", moveTo: "done" }],
  });
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toHaveLength(2);
  // An exact replay returns the original receipt and records no second suggestion; other moves are a reuse.
  expect(await x.service.write(x.identity, "status", call)).toMatchObject({ replayed: true, receipt: res.receipt });
  expect(suggestions(await x.store.read())).toHaveLength(1);
  await expect(x.service.write(x.identity, "status", { ...call, nextMoves: [commitMove] })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});

test("next moves on a report: every kind accepts them and the card status stays put", async () => {
  const x = await setup();
  for (const kind of ["question", "blocker", "result", "progress"] as const) {
    const ctx = await x.service.get(x.identity);
    const res = await x.service.write(x.identity, "progress", { ...input(ctx, kind), kind, nextMoves: [{ label: `Answer ${kind}`, prompt: `Use option ${kind}.` }] });
    expect(res.receipt).toMatchObject({ action: "progress", status: "todo", taskRevision: ctx.revision.task });
    const board = await x.store.read();
    expect(board.events.slice(-2).map((e) => e.action)).toEqual(["progress_reported", "next_moves_suggested"]);
    expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual([{ label: `Answer ${kind}`, prompt: `Use option ${kind}.` }]);
  }
});

test("next moves: [] is an explicit none that replaces this turn's suggestion; leaving it out keeps it", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: [commitMove] });
  // Not passing nextMoves records nothing and leaves the suggestion open.
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "progress", { ...input(ctx), kind: "result" });
  let board = await x.store.read();
  expect(suggestions(board)).toHaveLength(1);
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual([commitMove]);
  // [] on the delivery call: recorded as a none, which shows no chips.
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review", nextMoves: [] });
  board = await x.store.read();
  expect(board.events.at(-1)).toMatchObject({ action: "next_moves_suggested", actor: "agent", agentId: x.identity.agentId, moves: [], note: "No next steps needed" });
  expect(openNextMoves(board.events, x.identity.agentId)).toBeNull();
  // The standalone tool takes [] too, and the latest of the turn wins either way.
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: [commitMove] });
  expect(openNextMoves((await x.store.read()).events, x.identity.agentId)?.moves).toEqual([commitMove]);
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: [] });
  board = await x.store.read();
  expect(board.events.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [], note: "No next steps needed" });
  expect(openNextMoves(board.events, x.identity.agentId)).toBeNull();
});

test("next moves on a status or report: invalid moves are INVALID_INPUT and nothing is written", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const before = await readFile(x.store.path, "utf8");
  const bad = (nextMoves: unknown) => x.service.write(x.identity, "status", { ...input(ctx), status: "in_review", nextMoves });
  const badReport = (nextMoves: unknown) => x.service.write(x.identity, "progress", { ...input(ctx), kind: "result", nextMoves });
  for (const moves of [
    [1, 2, 3, 4].map((i) => ({ label: `m${i}`, prompt: "p" })),
    [{ label: "  ", prompt: "p" }],
    [{ label: "x".repeat(61), prompt: "p" }],
    [{ label: "ok", prompt: "p".repeat(2001) }],
    [{ label: "No prompt" }],
    [{ label: "Done", moveTo: "review" }],
    [{ label: "Done", moveTo: "done" }, { label: "Done 2", moveTo: "done" }],
    "not a list",
  ]) {
    // The schema error is a ZodError here; toolFailure gives the code the MCP and HTTP callers see.
    for (const call of [bad(moves), badReport(moves)]) expect(toolFailure(await call.catch((e) => e)).code, JSON.stringify(moves)).toBe("INVALID_INPUT");
  }
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("next moves: a Done move is only accepted with a delivery to In review; nothing is written otherwise", async () => {
  const x = await setup();
  const done = [commitMove, { label: "Move to Done", moveTo: "done" }];
  let ctx = await x.service.get(x.identity);
  const before = await readFile(x.store.path, "utf8");
  for (const status of ["design", "development", "test"]) {
    await expect(x.service.write(x.identity, "status", { ...input(ctx), status, nextMoves: done })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  await expect(x.service.write(x.identity, "progress", { ...input(ctx), kind: "result", nextMoves: done })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  // Refused whole: the status did not move, no event, no receipt.
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  // The same call delivering to In review goes through, and so does a later report while the card is there.
  await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review", nextMoves: done });
  expect(openNextMoves((await x.store.read()).events, x.identity.agentId)?.moves).toEqual(done);
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "progress", { ...input(ctx), kind: "result", nextMoves: done });
  expect(suggestions(await x.store.read())).toHaveLength(2);
  // The standalone tool is unchanged: it never looked at the card's lane.
  await x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "next_moves", { expectedRevision: ctx.revision, request: ctx.request, moves: done });
  // A finished card refuses everything, including the moves.
  const task = (await x.store.read()).tasks[0];
  await x.store.editTask({ id: "t", revision: task.revision, status: "done", actor: "human" });
  ctx = await x.service.get(x.identity);
  await expect(x.service.write(x.identity, "status", { ...input(ctx), status: "in_review", nextMoves: [commitMove] })).rejects.toMatchObject({ code: "TASK_FINISHED" });
  await expect(x.service.write(x.identity, "progress", { ...input(ctx), kind: "result", nextMoves: [] })).rejects.toMatchObject({ code: "TASK_FINISHED" });
});

test("next moves: a delivery refused for open workpad items records no suggestion; the resend with the same moves does", async () => {
  const x = await setup();
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { validation: [{ id: "e2e", text: "E2E", state: "unrun" }] }));
  ctx = await x.service.get(x.identity);
  const call = { ...input(ctx, "Delivered; E2E not run"), status: "in_review", nextMoves: [commitMove] };
  await expect(x.service.write(x.identity, "status", call)).rejects.toMatchObject({ code: "WORKPAD_OPEN" });
  let board = await x.store.read();
  expect(board.tasks[0]!.status).toBe("development");
  expect(suggestions(board)).toHaveLength(0);
  const ok = await x.service.write(x.identity, "status", { ...call, acknowledgeOpen: true });
  board = await x.store.read();
  expect(board.events.slice(-2).map((e) => e.action)).toEqual(["status_changed", "next_moves_suggested"]);
  // The delivery snapshot still points at the status event, not at the suggestion.
  expect(board.workpads[0]!.delivery?.eventId).toBe(ok.receipt.eventId);
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual([commitMove]);
});

// Delivery-time reminders (NEXT-MOVES-SPEC §9, IDEAS-SPEC §4.1): text in the result, never a refusal.
type Rig = Awaited<ReturnType<typeof setup>>;
const turnStarted = (x: Rig, agentId = x.identity.agentId) =>
  x.store.mutate((board) => {
    x.store.event(board, { taskId: "t", agentId, actor: "system", action: "agent.turn_started" });
  });
const deliver = async (x: Rig, extra: Record<string, unknown> = {}) =>
  x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity), "Delivered"), status: "in_review", outputs: [], ...extra });
const reportKind = async (x: Rig, kind: string, extra: Record<string, unknown> = {}) =>
  x.service.write(x.identity, "progress", { ...input(await x.service.get(x.identity), kind), kind, ...(kind === "result" ? { outputs: [] } : {}), ...extra });
const suggest = async (x: Rig, moves: unknown[]) =>
  x.service.write(x.identity, "next_moves", { ...(({ expectedRevision, request }) => ({ expectedRevision, request }))(input(await x.service.get(x.identity))), moves });
const proposeIdea = async (x: Rig, agentId = x.identity.agentId) => {
  const identity = { ...x.identity, agentId };
  const ctx = await x.service.get(identity);
  return x.service.write(identity, "idea", {
    expectedRevision: ctx.revision,
    request: ctx.request,
    title: `Follow-up of ${agentId}`,
    detail: "Do the follow-up.",
    rationale: "Noticed while working.",
  });
};

test("a delivery with no next moves and no ideas gets both reminders ahead of current, also on a replay", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const call = { ...input(ctx, "Delivered"), status: "in_review" };
  const res = await x.service.write(x.identity, "status", call);
  expect(res.reminders).toEqual([movesReminder, ideasReminder, outputsReminder]);
  // The reminders sit right after the receipt, before the card's whole context.
  expect(Object.keys(res)).toEqual(["receipt", "replayed", "reminders", "current"]);
  expect((await x.store.read()).tasks[0].status).toBe("in_review");
  // A replay (the first response may have been lost) is judged on the board as it is now.
  expect(await x.service.write(x.identity, "status", call)).toMatchObject({ replayed: true, reminders: [movesReminder, ideasReminder, outputsReminder] });
  await suggest(x, []);
  const again = await x.service.write(x.identity, "status", call);
  expect(again.replayed).toBe(true);
  expect(again.reminders).toEqual([ideasReminder, outputsReminder]);
});

test("reminders are absent when the call was made already: moves this turn, Ideas off, ideas proposed, moves on the call", async () => {
  // Moves sent earlier in this turn: only the ideas reminder is left.
  let x = await setup();
  await suggest(x, [commitMove]);
  expect((await deliver(x)).reminders).toEqual([ideasReminder]);
  // Moves carried by the delivery itself, including an explicit none.
  for (const nextMoves of [[commitMove], []]) {
    x = await setup();
    expect((await deliver(x, { nextMoves })).reminders).toEqual([ideasReminder]);
  }
  // Ideas off: no ideas reminder and nothing else changes.
  x = await setup();
  x.service.ideasOn = async () => false;
  expect((await deliver(x)).reminders).toEqual([movesReminder]);
  // This session already proposed an idea on the card, even when its events were pruned long ago.
  x = await setup();
  await proposeIdea(x);
  await x.store.mutate((board) => {
    for (let i = 0; i < 120; i++) x.store.event(board, { taskId: "t", actor: "system", action: "edited" });
  });
  expect((await x.store.read()).events.some((e) => e.action === "idea_proposed")).toBe(false);
  expect((await deliver(x)).reminders).toEqual([movesReminder]);
  // Everything done: the result has no reminders key at all.
  x = await setup();
  await proposeIdea(x);
  expect(await deliver(x, { nextMoves: [] })).not.toHaveProperty("reminders");
  // Another session's idea or moves do not count for this one.
  x = await setup();
  await proposeIdea(x, "second");
  await x.store.mutate((board) => {
    x.store.event(board, { taskId: "t", agentId: "second", actor: "agent", action: "next_moves_suggested", note: "Commit", moves: [commitMove] });
    x.store.event(board, { taskId: "other", agentId: x.identity.agentId, actor: "agent", action: "next_moves_suggested", note: "Commit", moves: [commitMove] });
  });
  expect((await deliver(x)).reminders).toEqual([movesReminder, ideasReminder]);
});

test("a new turn starts over: last turn's moves do not count, this turn's none does", async () => {
  const x = await setup();
  await turnStarted(x);
  await suggest(x, [commitMove]);
  expect((await reportKind(x, "result")).reminders).toBeUndefined();
  await turnStarted(x);
  expect((await reportKind(x, "result")).reminders).toEqual([movesReminder]);
  await suggest(x, []);
  expect(await reportKind(x, "result")).not.toHaveProperty("reminders");
  await turnStarted(x);
  expect((await reportKind(x, "result")).reminders).toEqual([movesReminder]);
  // The start of another session's turn does not reopen this one.
  await suggest(x, [commitMove]);
  await turnStarted(x, "second");
  expect(await reportKind(x, "result")).not.toHaveProperty("reminders");
});

test("only a delivery, an ask or a result reminds: stage changes and plain progress stay quiet", async () => {
  const x = await setup();
  const status = async (to: string) => x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status: to, ...(to === "in_review" ? { outputs: [] } : {}) });
  for (const to of ["design", "development", "test"]) expect(await status(to), to).not.toHaveProperty("reminders");
  for (const kind of ["progress", "blocker"]) expect(await reportKind(x, kind), kind).not.toHaveProperty("reminders");
  expect((await reportKind(x, "result")).reminders).toEqual([movesReminder]);
  // A question asks for answers; the question itself stays kind=question.
  expect((await reportKind(x, "question")).reminders).toEqual([answersReminder]);
  expect((await status("blocked")).reminders).toEqual([movesReminder]);
  expect((await status("in_review")).reminders).toEqual([movesReminder, ideasReminder]);
  // Other tools never remind.
  expect(await suggest(x, [])).not.toHaveProperty("reminders");
  expect(await proposeIdea(x)).not.toHaveProperty("reminders");
  // Nothing was blocked by a reminder: every write above is on the board.
  expect((await x.store.read()).events.filter((e) => e.action === "status_changed").map((e) => e.to)).toEqual([
    "design", "development", "test", "blocked", "in_review",
  ]);
});

test("a refused call or a finished card carries no reminders", async () => {
  const x = await setup();
  const stale = { ...input(await x.service.get(x.identity), "Delivered"), status: "in_review" };
  await x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status: "development" });
  await expect(x.service.write(x.identity, "status", stale)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  const call = { ...input(await x.service.get(x.identity), "Delivered"), status: "in_review" };
  const first = await x.service.write(x.identity, "status", call);
  expect(first.reminders).toEqual([movesReminder, ideasReminder, outputsReminder]);
  // The person moved the card to Done: its replay still returns the receipt, with nothing to remind.
  const task = (await x.store.read()).tasks[0];
  await x.store.editTask({ id: "t", revision: task.revision, status: "done", actor: "human" });
  const replay = await x.service.write(x.identity, "status", call);
  expect(replay).toMatchObject({ replayed: true, receipt: first.receipt });
  expect(replay).not.toHaveProperty("reminders");
});

// Card setup (CARD-SETUP-SPEC §3): get_task names what is missing, every write reminds, delivery is a soft gate.
const bare = () => setup({ type: false, tags: false, workpad: false });
const setType = async (x: Rig, type = "bugfix") => {
  const ctx = await x.service.get(x.identity);
  return x.service.write(x.identity, "type", { expectedRevision: ctx.revision, request: ctx.request, type });
};
const tag = async (x: Rig) => {
  const ctx = await x.service.get(x.identity);
  return x.service.write(x.identity, "tags", { expectedRevision: ctx.revision, request: ctx.request, add: ["drawer"] });
};
const pad = async (x: Rig, body: Parameters<typeof workpadInput>[1] = { acceptance: [{ text: "Works", done: false }] }) =>
  x.service.write(x.identity, "workpad", workpadInput(await x.service.get(x.identity), body));

test("setup: get_task names the missing items first; each clears once set, by anyone", async () => {
  const x = await bare();
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  let ctx = await x.service.get(x.identity);
  expect(Object.keys(ctx).slice(0, 2)).toEqual(["identity", "setup"]);
  expect(ctx.setup).toEqual({ typeMissing: true, tagsMissing: true, workpadMissing: true, stage: "todo", missing: ["type", "tags", "workpad"] });
  // An empty workpad is still missing.
  await pad(x, {});
  expect((await x.service.get(x.identity)).setup?.missing).toEqual(["type", "tags", "workpad"]);
  await setType(x);
  await pad(x);
  ctx = await x.service.get(x.identity);
  expect(ctx.setup).toMatchObject({ typeMissing: false, workpadMissing: false, missing: ["tags"] });
  // A tag the person added counts.
  await x.store.mutate((board) => {
    board.tasks[0]!.tags = [{ tag: "mine", by: "human", at: new Date().toISOString() }];
  });
  expect((await x.service.get(x.identity)).setup?.missing).toEqual([]);
  // The workpad turned off for the project is never missing.
  const y = await setup({ workpad: false });
  await y.store.updateProject({ id: "p", revision: 1, workpad: false });
  expect((await y.service.get(y.identity)).setup?.missing).toEqual([]);
});

test("setup: every write succeeds and reminds of what is still missing; a set type is not mentioned again", async () => {
  const x = await bare();
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  const all = setupReminder(["type", "tags", "workpad"]);
  const moved = await x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status: "development" });
  expect(moved.receipt.status).toBe("development");
  expect(moved.reminders).toEqual([all]);
  expect((await reportKind(x, "progress")).reminders).toEqual([all]);
  // Computed after the write: set_type's own result no longer names the type.
  expect((await setType(x)).reminders).toEqual([setupReminder(["tags", "workpad"])]);
  expect((await pad(x)).reminders).toEqual([setupReminder(["tags"])]);
  expect((await suggest(x, [])).reminders).toEqual([setupReminder(["tags"])]);
  const tagged = await tag(x);
  expect(tagged).not.toHaveProperty("reminders");
  expect(await reportKind(x, "progress")).not.toHaveProperty("reminders");
  expect(setupReminder(["type"])).toContain("no type (flowly_set_type");
});

test("setup: the reminder follows the delivery reminders, also on a replay, and never on a finished card", async () => {
  const x = await setup({ tags: false });
  const call = { ...input(await x.service.get(x.identity), "Result"), kind: "result" };
  const first = await x.service.write(x.identity, "progress", call);
  expect(first.reminders).toEqual([movesReminder, outputsReminder, setupReminder(["tags"])]);
  expect(await x.service.write(x.identity, "progress", call)).toMatchObject({ replayed: true, reminders: [movesReminder, outputsReminder, setupReminder(["tags"])] });
  const task = (await x.store.read()).tasks[0]!;
  await x.store.editTask({ id: "t", revision: task.revision, status: "done", actor: "human" });
  expect(await x.service.write(x.identity, "progress", call)).not.toHaveProperty("reminders");
});

test("setup: delivering with missing setup is SETUP_INCOMPLETE until acknowledged; the snapshot records it", async () => {
  const x = await setup({ tags: false });
  await x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status: "development" });
  const ctx = await x.service.get(x.identity);
  const refused = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review" }).catch((e) => e);
  expect(refused).toMatchObject({ code: "SETUP_INCOMPLETE" });
  expect(String(refused.message)).toContain("no tags (flowly_set_tags");
  expect(String(refused.message)).not.toContain("no type");
  expect((await x.store.read()).tasks[0]!.status).toBe("development");
  // Same request, acknowledged: nothing was committed before, so it is not a reuse.
  const ok = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered; no tags: the card spans no module"), status: "in_review", acknowledgeOpen: true });
  expect(ok.receipt.status).toBe("in_review");
  const event = (await x.store.read()).events.find((e) => e.id === ok.receipt.eventId)!;
  expect(event.setup).toEqual({ missing: ["tags"] });
  // A delivery with everything set has no snapshot.
  const y = await setup();
  const done = await deliver(y);
  expect((await y.store.read()).events.find((e) => e.id === done.receipt.eventId)?.setup).toBeUndefined();
});

test("setup: no workpad blocks delivery while the project has it on; off, type and tags alone are enough", async () => {
  const x = await setup({ workpad: false });
  await expect(deliver(x)).rejects.toMatchObject({ code: "SETUP_INCOMPLETE", message: expect.stringContaining("no workpad") });
  await x.store.updateProject({ id: "p", revision: 1, workpad: false });
  expect((await deliver(x)).receipt.status).toBe("in_review");
});

test("setup: open workpad items and missing setup come back in one WORKPAD_OPEN that names both", async () => {
  const x = await setup({ type: false, workpad: false });
  x.service.git = fakeGit({ head: "aaaaaaaaaaaa" });
  await pad(x, { validation: [{ id: "e2e", text: "E2E", state: "unrun" }] });
  const refused = await deliver(x).catch((e) => e);
  expect(refused).toMatchObject({ code: "WORKPAD_OPEN" });
  expect(String(refused.message)).toMatch(/no type \(flowly_set_type[\s\S]*check not run: E2E/);
  const ok = await deliver(x, { acknowledgeOpen: true, note: "Delivered; E2E not run; type left to the user" });
  const event = (await x.store.read()).events.find((e) => e.id === ok.receipt.eventId)!;
  expect(event).toMatchObject({ setup: { missing: ["type"] }, workpad: { unrun: 1 } });
});

test("outputs: delivery and result atomically register files and PR/MR links, deduplicate, preserve receipts across reload", async () => {
  const x = await setup();
  await writeFile(`${x.a}/report.md`, "evidence");
  const outputs = [{ target: "./report.md", title: "Report", note: "verified" }, { target: "https://github.com/fixture/repo/pull/12" }, { target: "https://gitlab.example/fixture/repo/-/merge_requests/13" }, { target: "./report.md" }];
  const call = { ...input(await x.service.get(x.identity)), status: "in_review", outputs, nextMoves: [] };
  const result = await x.service.write(x.identity, "status", call);
  expect(result.receipt.artifactIds).toHaveLength(3);
  expect(result.reminders).not.toContain(outputsReminder);
  const board = await x.store.read();
  expect(board.artifacts.map((a) => a.role)).toEqual(["output", "output", "output"]);
  expect(board.artifacts[0]).toMatchObject({ target: "./report.md", title: "Report", note: "verified" });
  expect(board.events.map((e) => e.action)).toEqual(["artifact_added", "artifact_added", "artifact_added", "status_changed", "next_moves_suggested"]);
  expect(result.receipt.eventId).toBe(board.events[3].id);
  await rm(`${x.a}/report.md`);
  const service = new AgentService(new BoardStore(x.store.directory), x.secrets);
  service.attach(x.paseo);
  service.artifactsOn = async () => false;
  const before = await readFile(x.store.path, "utf8");
  expect(await service.write(x.identity, "status", call)).toMatchObject({ replayed: true, receipt: result.receipt });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  await expect(service.write(x.identity, "status", { ...call, outputs: [] })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  const reported = await reportKind(x, "result", { outputs: [{ target: "https://example.com/result", title: "Result" }] });
  expect(reported.receipt).toMatchObject({ status: "in_review", taskRevision: result.receipt.taskRevision, artifactIds: [expect.any(String)] });
});

test("outputs: omission reminds per call, [] declares none without deleting artifacts; disabled allows []", async () => {
  const x = await setup();
  await deliver(x, { outputs: [{ target: "https://example.com/report" }] });
  expect((await reportKind(x, "result", { outputs: undefined, nextMoves: [] })).reminders).toEqual([outputsReminder]);
  const none = await reportKind(x, "result", { outputs: [], nextMoves: [] });
  expect(none.receipt.artifactIds).toEqual([]);
  expect(none).not.toHaveProperty("reminders");
  expect((await x.store.read()).artifacts).toHaveLength(1);
  x.service.artifactsOn = async () => false;
  expect(await reportKind(x, "result", { outputs: undefined, nextMoves: [] })).not.toHaveProperty("reminders");
  expect((await reportKind(x, "result", { nextMoves: [] })).receipt.artifactIds).toEqual([]);
  const before = await readFile(x.store.path, "utf8");
  await expect(reportKind(x, "result", { outputs: [{ target: "https://example.com/other" }] })).rejects.toMatchObject({ code: "ARTIFACTS_DISABLED" });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("outputs: invalid target, capacity, stale revision and gate refusal roll back the whole delivery", async () => {
  const x = await setup();
  for (const target of ["./missing.md", "../missing.md", "ftp://example.com/data"]) {
    const before = await readFile(x.store.path, "utf8");
    await expect(deliver(x, { outputs: [{ target: "https://example.com/good" }, { target }], nextMoves: [] })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await readFile(x.store.path, "utf8")).toBe(before);
  }
  await x.store.mutate((board) => {
    for (let i = 0; i < 99; i++) putArtifact(x.store, board, { taskId: "t", createdBy: "human", role: "input", kind: "url", target: `https://example.com/${i}` });
  });
  const before = await readFile(x.store.path, "utf8");
  await expect(deliver(x, { outputs: [{ target: "https://example.com/new1" }, { target: "https://example.com/new2" }], nextMoves: [] })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  const stale = await x.service.get(x.identity);
  await x.store.editTask({ id: "t", revision: stale.revision.task, title: "Changed", actor: "human" });
  const afterEdit = await readFile(x.store.path, "utf8");
  await expect(x.service.write(x.identity, "status", { ...input(stale), status: "in_review", outputs: [{ target: "https://example.com/new" }] })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(await readFile(x.store.path, "utf8")).toBe(afterEdit);
  const y = await setup({ tags: false });
  const beforeGate = await readFile(y.store.path, "utf8");
  await expect(deliver(y, { acknowledgeOpen: true, outputs: [{ target: "https://example.com/new" }] })).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
  expect(await readFile(y.store.path, "utf8")).toBe(beforeGate);
});

test("outputs: user-owned input stays unchanged and notice identifies its target", async () => {
  const x = await setup();
  await x.store.mutate((board) => putArtifact(x.store, board, { taskId: "t", createdBy: "human", role: "input", kind: "url", target: "https://example.com/input", title: "User title" }));
  const before = (await x.store.read()).artifacts[0];
  const result = await deliver(x, { outputs: [{ target: before.target, title: "Agent title" }] });
  expect((await x.store.read()).artifacts[0]).toEqual(before);
  expect(result.notice).toContain(before.target);
  expect(result.notice).toContain("role not changed");
  expect(result.receipt.artifactIds).toEqual([before.id]);
});

test("outputs: inappropriate action/kind and malformed lists refuse without writes", async () => {
  const x = await setup();
  const before = await readFile(x.store.path, "utf8");
  for (const status of ["design", "development", "test", "blocked"]) await expect(x.service.write(x.identity, "status", { ...input(await x.service.get(x.identity)), status, outputs: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const kind of ["progress", "question", "blocker"]) await expect(reportKind(x, kind, { outputs: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const outputs of [null, {}, ["x"], [{ target: "" }], [{ target: "https://example.com", role: "input" }], Array.from({ length: 21 }, () => ({ target: "https://example.com" }))]) {
    await expect(deliver(x, { outputs })).rejects.toThrow();
  }
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("outputs: recognized external keeps output role; unreadable private metadata still saves the explicit URL", async () => {
  const x = await setup();
  const target = "https://github.com/o/r/pull/5";
  const external = { connectionId: "c1", provider: "github", key: "o/r#5", remoteId: "5", itemType: "pull" } as const;
  let failure: Error | undefined;
  x.service.connectors = {
    recognize: async () => { if (failure) throw failure; return { url: target, external, title: "PR #5" }; },
    locate: async () => new Map(),
  } as unknown as NonNullable<AgentService["connectors"]>;
  const registered = await deliver(x, { outputs: [{ target }] });
  expect(registered.current?.artifacts[0]).toMatchObject({ role: "output", target });
  expect((await x.store.read()).artifacts[0]).toMatchObject({ role: "output", external });
  for (const code of ["EXTERNAL_AUTH", "EXTERNAL_NOT_FOUND", "EXTERNAL_UNAVAILABLE", "EXTERNAL_INVALID"] as const) {
    failure = new ExternalError(code, "Metadata inaccessible");
    const url = `https://github.com/o/private/pull/${code.length}`;
    const result = await reportKind(x, "result", { outputs: [{ target: url }] });
    expect(result.notice).toContain("no external status or content was verified");
    const artifact = (await x.store.read()).artifacts.find(a => a.id === result.receipt.artifactIds?.[0]);
    expect(artifact).toMatchObject({ role: "output", kind: "url", target: url });
    expect(artifact).not.toHaveProperty("external");
  }
  const before = await readFile(x.store.path, "utf8");
  await expect(reportKind(x, "result", { outputs: [{ target: "o/r#5" }] })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  failure = new TypeError("Programmer error");
  await expect(reportKind(x, "result", { outputs: [{ target }] })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("gate: pre-acknowledgement refuses, same-state retry succeeds; pad/HEAD/revision/turn/expiry/reload/session invalidate it", async () => {
  for (const change of ["none", "pad", "head", "dirty", "task", "project", "turn", "expiry", "reload", "session"] as const) {
    const x = await setup({ tags: false });
    const repo = { head: "aaaaaaaaaaaa", dirty: false };
    x.service.git = fakeGit(repo);
    const before = await readFile(x.store.path, "utf8");
    await expect(deliver(x, { acknowledgeOpen: true })).rejects.toMatchObject({ code: "SETUP_INCOMPLETE", message: expect.stringContaining("first attempt is always refused") });
    expect(await readFile(x.store.path, "utf8")).toBe(before);
    if (change === "pad") await pad(x, { acceptance: [{ text: "New criterion", done: true }] });
    if (change === "head") repo.head = "bbbbbbbbbbbb";
    if (change === "dirty") repo.dirty = true;
    if (change === "task") await x.store.editTask({ id: "t", revision: 1, title: "new", actor: "human" });
    if (change === "project") await x.store.updateProject({ id: "p", revision: 1, title: "new" });
    if (change === "turn") {
      x.service.turnStarted(x.identity);
      // No board history is needed to invalidate a turn, even when its lifecycle event was truncated.
      await x.store.mutate((board) => { board.events = []; });
    }
    if (change === "expiry") x.advance(15 * 60 * 1000 + 1);
    if (change === "reload") {
      const next = new AgentService(x.store, x.secrets);
      next.attach(x.paseo); next.git = fakeGit(repo);
      Object.assign(x, { service: next });
    }
    if (change === "session") Object.assign(x, { identity: { ...x.identity, agentId: "second" } });
    if (change !== "none") await expect(deliver(x, { acknowledgeOpen: true })).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
    const result = await deliver(x, { acknowledgeOpen: true, note: "No tags: intentionally omitted for this controlled gate check" });
    expect(result.receipt.status, change).toBe("in_review");
  }
});

test("gate: initial acknowledgeOpen also refuses open checks, fixing them needs no override", async () => {
  const x = await setup();
  await pad(x, { validation: [{ text: "E2E", state: "unrun" }] });
  await expect(deliver(x, { acknowledgeOpen: true })).rejects.toMatchObject({ code: "WORKPAD_OPEN" });
  await pad(x, { validation: [{ text: "E2E", state: "pass" }] });
  expect((await deliver(x)).receipt.status).toBe("in_review");
});

// An agent manages its card's ideas (IDEAS-SPEC §3.1).
const manageIdea = async (x: Rig, action: "idea_update" | "idea_remove", fields: Record<string, unknown>) => {
  const ctx = await x.service.get(x.identity);
  return x.service.write(x.identity, action, { expectedRevision: ctx.revision, request: ctx.request, ...fields });
};

test("an agent edits and dismisses an open idea of its card without touching the card", async () => {
  const x = await setup();
  const { ideaId } = await proposeIdea(x);
  const before = (await x.store.read()).tasks[0];
  const edited = await manageIdea(x, "idea_update", { id: ideaId, title: "Sharper title", priority: "high", tags: ["Ideas"] });
  expect(edited.ideaId).toBe(ideaId);
  let board = await x.store.read();
  expect(board.ideas[0]).toMatchObject({ title: "Sharper title", priority: "high", tags: ["ideas"], status: "open", detail: "Do the follow-up." });
  expect(board.events.at(-1)).toMatchObject({ action: "idea_edited", actor: "agent", agentId: x.identity.agentId, note: "Sharper title" });
  // The user rejected it in conversation: the agent closes it; it stays under Closed.
  const ctx = await x.service.get(x.identity);
  const call = { expectedRevision: ctx.revision, request: ctx.request, id: ideaId, status: "dismissed" };
  const dismissed = await x.service.write(x.identity, "idea_update", call);
  board = await x.store.read();
  expect(board.ideas[0]!.status).toBe("dismissed");
  expect(board.events.at(-1)).toMatchObject({ action: "idea_dismissed", actor: "agent", note: "Sharper title" });
  expect(board.tasks[0]).toEqual(before);
  // Exact replay returns the receipt; changed parameters are refused.
  expect(await x.service.write(x.identity, "idea_update", call)).toMatchObject({ replayed: true, ideaId, receipt: dismissed.receipt });
  await expect(x.service.write(x.identity, "idea_update", { ...call, title: "Other" })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  // Dismissing again is a no-op; a dismissed idea cannot be edited (only the user restores it).
  await manageIdea(x, "idea_update", { id: ideaId, status: "dismissed" });
  expect((await x.store.read()).events.filter((e) => e.action === "idea_dismissed")).toHaveLength(1);
  await expect(manageIdea(x, "idea_update", { id: ideaId, title: "Again" })).rejects.toMatchObject({ code: "IDEA_CLOSED" });
});

test("idea management refusals: nothing to change, duplicate title, another card, accepted, Ideas off", async () => {
  const x = await setup();
  const a = (await proposeIdea(x)).ideaId!;
  const b = (await proposeIdea(x, "second")).ideaId!;
  await expect(manageIdea(x, "idea_update", { id: a })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  // Another session's idea on the same card can be managed, but not given a taken title.
  await expect(manageIdea(x, "idea_update", { id: b, title: " follow-up OF " + x.identity.agentId })).rejects.toMatchObject({ code: "IDEA_DUPLICATE" });
  await expect(manageIdea(x, "idea_remove", { id: "missing" })).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });
  await x.store.mutate((board) => {
    board.ideas.find((i) => i.id === b)!.taskId = "other";
    board.ideas.find((i) => i.id === a)!.status = "accepted";
  });
  await expect(manageIdea(x, "idea_update", { id: b, status: "dismissed" })).rejects.toMatchObject({ code: "IDEA_NOT_FOUND" });
  await expect(manageIdea(x, "idea_update", { id: a, status: "dismissed" })).rejects.toMatchObject({ code: "IDEA_CLOSED" });
  await expect(manageIdea(x, "idea_remove", { id: a })).rejects.toMatchObject({ code: "IDEA_CLOSED" });
  x.service.ideasOn = async () => false;
  await expect(manageIdea(x, "idea_remove", { id: a })).rejects.toMatchObject({ code: "IDEAS_DISABLED" });
});

test("an agent removes an open or dismissed idea of its card", async () => {
  const x = await setup();
  const { ideaId } = await proposeIdea(x);
  const removed = await manageIdea(x, "idea_remove", { id: ideaId });
  expect(removed.ideaId).toBe(ideaId);
  const board = await x.store.read();
  expect(board.ideas).toEqual([]);
  expect(board.events.at(-1)).toMatchObject({ action: "idea_removed", actor: "agent", note: `Follow-up of ${x.identity.agentId}` });
  expect(board.agentReceipts.at(-1)).toMatchObject({ action: "idea_remove", eventId: board.events.at(-1)!.id });
  const again = (await proposeIdea(x)).ideaId;
  await manageIdea(x, "idea_update", { id: again, status: "dismissed" });
  await manageIdea(x, "idea_remove", { id: again });
  expect((await x.store.read()).ideas).toEqual([]);
});

test("proposal replay keeps the idea ID after removal and service reload without resurrecting it", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const call = { expectedRevision: ctx.revision, request: ctx.request, title: "Replay after removal", detail: "A follow-up", rationale: "Regression" };
  const first = await x.service.write(x.identity, "idea", call);
  await manageIdea(x, "idea_remove", { id: first.ideaId });
  const secrets = new ToolSecrets(x.store.directory);
  await secrets.initialize();
  const restored = new AgentService(new BoardStore(x.store.directory), secrets);
  restored.attach(x.paseo);
  const before = await readFile(x.store.path, "utf8");
  const replay = await restored.write(x.identity, "idea", call);
  expect(replay).toMatchObject({ replayed: true, ideaId: first.ideaId, receipt: first.receipt });
  expect(replay.current?.ideas).toEqual([]);
  expect(replay.current?.revision).toEqual(ctx.revision);
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("proposal replay reads legacy receipts without an idea ID while the idea is retained", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const call = { expectedRevision: ctx.revision, request: ctx.request, title: "Legacy receipt", detail: "A follow-up", rationale: "Compatibility" };
  const first = await x.service.write(x.identity, "idea", call);
  await x.store.mutate((board) => {
    const receipt = board.agentReceipts.find((r) => r.eventId === first.receipt.eventId)!;
    delete receipt.ideaId;
  });
  const secrets = new ToolSecrets(x.store.directory);
  await secrets.initialize();
  const restored = new AgentService(new BoardStore(x.store.directory), secrets);
  restored.attach(x.paseo);
  const before = await readFile(x.store.path, "utf8");
  expect(await restored.write(x.identity, "idea", call)).toMatchObject({ replayed: true, ideaId: first.ideaId });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("committed is a delivery like In review: outputs, a Done move, the gate and its snapshot; refused when the lane is off", async () => {
  const x = await setup({ workpad: false });
  const repo = { head: "aaaaaaaaaaaa" };
  x.service.git = fakeGit(repo);
  let ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).toEqual(["design", "development", "test", "blocked", "in_review", "committed", "integrated"]);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Works", done: true }], validation: [{ id: "unit", text: "Unit tests", state: "pass" }] }));
  // Checks ran on the uncommitted tree; the commit makes them out of date at the move.
  repo.head = "cccccccccccc";
  ctx = await x.service.get(x.identity);
  const done = [{ label: "Move to Done", moveTo: "done" }];
  const call = { ...input(ctx, "Committed cccccccc; not pushed"), status: "committed", nextMoves: done, outputs: [{ target: "https://github.com/fixture/repo/pull/7" }] };
  const refused = await x.service.write(x.identity, "status", call).catch((e) => e);
  expect(refused).toMatchObject({ code: "WORKPAD_OPEN" });
  expect(String(refused.message)).toContain("out of date");
  expect((await x.store.read()).tasks[0]!.status).toBe("development");
  const ok = await x.service.write(x.identity, "status", { ...call, acknowledgeOpen: true });
  expect(ok.receipt).toMatchObject({ status: "committed", artifactIds: [expect.any(String)] });
  expect(ok.reminders).toContain(ideasReminder);
  expect(ok.reminders).not.toContain(movesReminder);
  let board = await x.store.read();
  const moved = board.events.find((e) => e.id === ok.receipt.eventId)!;
  expect(moved).toMatchObject({ action: "status_changed", from: "development", to: "committed", workpad: { stale: 1, total: 1 } });
  expect(board.workpads[0]!.delivery).toMatchObject({ total: 1, eventId: moved.id });
  expect(currentDelivery(board.tasks[0]!, board.workpads[0], board.events)).toMatchObject({ eventId: moved.id });
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual(done);
  expect(board.artifacts.map((a) => a.role)).toEqual(["output"]);
  // A person moving it back to In review ends that delivery's mark.
  await x.store.editTask({ id: "t", revision: board.tasks[0]!.revision, status: "in_review", actor: "human" });
  expect(currentDelivery((await x.store.read()).tasks[0]!, board.workpads[0], (await x.store.read()).events)).toBeNull();
  // The lane off: STATUS_UNAVAILABLE.
  board = await x.store.read();
  const project = board.projects[0]!;
  await x.store.updateProject({
    id: project.id,
    revision: project.revision,
    lanes: (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "committed" })),
  });
  ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).not.toContain("committed");
  await expect(x.service.write(x.identity, "status", { ...input(ctx), status: "committed", nextMoves: [] })).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
});

test("integrated is a delivery like Committed, also straight from a work stage; refused when the lane is off (INTEGRATED-STAGE-SPEC §3)", async () => {
  const x = await setup({ workpad: false });
  const repo = { head: "aaaaaaaaaaaa" };
  x.service.git = fakeGit(repo);
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Works", done: true }], validation: [{ id: "unit", text: "Unit tests", state: "pass" }] }));
  // Committed directly on the main checkout's branch: integrated with the commit, so no Committed first.
  repo.head = "dddddddddddd";
  ctx = await x.service.get(x.identity);
  const done = [{ label: "Move to Done", moveTo: "done" }];
  const call = { ...input(ctx, "Committed dddddddd on main in the main checkout; not pushed"), status: "integrated", nextMoves: done, outputs: [{ target: "https://github.com/fixture/repo/pull/8" }] };
  const refused = await x.service.write(x.identity, "status", call).catch((e) => e);
  expect(refused).toMatchObject({ code: "WORKPAD_OPEN" });
  expect((await x.store.read()).tasks[0]!.status).toBe("development");
  const ok = await x.service.write(x.identity, "status", { ...call, acknowledgeOpen: true });
  expect(ok.receipt).toMatchObject({ status: "integrated", artifactIds: [expect.any(String)] });
  expect(ok.reminders).toContain(ideasReminder);
  let board = await x.store.read();
  const moved = board.events.find((e) => e.id === ok.receipt.eventId)!;
  expect(moved).toMatchObject({ action: "status_changed", from: "development", to: "integrated", workpad: { stale: 1, total: 1 } });
  expect(currentDelivery(board.tasks[0]!, board.workpads[0], board.events)).toMatchObject({ eventId: moved.id });
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual(done);
  // The lane off (after a person moved the card out): STATUS_UNAVAILABLE.
  await x.store.editTask({ id: "t", revision: board.tasks[0]!.revision, status: "committed", actor: "human" });
  board = await x.store.read();
  const project = board.projects[0]!;
  await x.store.updateProject({
    id: project.id,
    revision: project.revision,
    lanes: (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "integrated" })),
  });
  ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).toEqual(["design", "development", "test", "blocked", "in_review", "committed"]);
  await expect(x.service.write(x.identity, "status", { ...input(ctx), status: "integrated", nextMoves: [] })).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
  expect((await x.store.read()).tasks[0]!.status).toBe("committed");
});

test("handover: stored on the card without a revision change, replaced by the next one, shown in get_task", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  const first = await x.service.write(x.identity, "handover", { expectedRevision: ctx.revision, request: ctx.request, files: ["a.ts", "a.ts", "b.ts"], notes: "Hunk 2 of b.ts is mine." });
  expect(first.receipt.action).toBe("handover");
  expect(first.receipt.taskRevision).toBe(ctx.revision.task);
  let board = await x.store.read();
  expect(board.tasks[0].revision).toBe(ctx.revision.task);
  expect(board.tasks[0].handover).toMatchObject({ agentId: x.identity.agentId, files: ["a.ts", "b.ts"], notes: "Hunk 2 of b.ts is mine." });
  expect(board.events.at(-1)).toMatchObject({ action: "handover_written", actor: "agent", note: "2 files" });
  ctx = await x.service.get(x.identity);
  expect(ctx.task.handover?.files).toEqual(["a.ts", "b.ts"]);
  await x.service.write(x.identity, "handover", { expectedRevision: ctx.revision, request: ctx.request, files: ["c.ts"] });
  board = await x.store.read();
  expect(board.tasks[0].handover).toMatchObject({ files: ["c.ts"], notes: "" });
  ctx = await x.service.get(x.identity);
  await expect(x.service.write(x.identity, "handover", { expectedRevision: ctx.revision, request: ctx.request, files: [] })).rejects.toThrow();
});

test("get_task returns the card's delivery mode, or the default (DELIVERY-MODE-SPEC §5)", async () => {
  const x = await setup();
  expect((await x.service.get(x.identity)).deliveryMode).toBe("branch");
  x.service.deliveryDefault = async () => "draft_pr";
  expect((await x.service.get(x.identity)).deliveryMode).toBe("draft_pr");
  await x.store.mutate((board) => {
    (board.tasks.find((t) => t.id === "t") as { deliveryMode?: string }).deliveryMode = "ready_pr";
  });
  expect((await x.service.get(x.identity)).deliveryMode).toBe("ready_pr");
  await x.store.mutate((board) => {
    (board.tasks.find((t) => t.id === "t") as { deliveryMode?: string }).deliveryMode = "from_the_future";
  });
  expect((await x.service.get(x.identity)).deliveryMode).toBe("draft_pr");
});

test("get_task lists the card's sessions in background workspaces too", async () => {
  const x = await setup();
  const list = vi.fn(x.paseo.agents.list.bind(x.paseo.agents));
  (x.paseo.agents as { list: unknown }).list = list;
  await x.service.get(x.identity);
  expect(list).toHaveBeenCalled();
  for (const [input] of list.mock.calls) expect(input).toMatchObject({ filter: { includeBackground: true } });
});
