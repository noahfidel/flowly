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
import { toolContextSchema, umbrellaEntryInputSchema } from "../shared/tools";
import type { Lane, UmbrellaEntry } from "../shared/model";
import { closeUmbrella, createUmbrella, resolveChange, setMembership, updateEntry, updateUmbrella } from "./umbrellas";
import type { MemoryService } from "./memory";

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
/** Lanes are group-level (BOARD-GROUPS-SPEC §1): turn groups on and edit the project's group's lanes. */
async function setGroupLanes(store: BoardStore, projectId: string, lanes: Lane[]) {
  if (!store.groupsAvailable) await store.migrateGroups(async () => []);
  const board = await store.read();
  const group = board.groups.find((g) => g.id === board.projects.find((p) => p.id === projectId)!.groupId)!;
  await store.updateGroup({ id: group.id, revision: group.revision, lanes });
}
test("agents only see and use the project's enabled lanes", async () => {
  const x = await setup();
  const board = await x.store.read();
  const project = board.projects[0];
  await setGroupLanes(x.store, project.id, (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({
      status,
      enabled: status !== "blocked" && status !== "committed" && status !== "integrated",
      ...(status === "in_review" ? { name: "QA" } : {}),
    })),
  );
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

const workpadInput = (ctx: Awaited<ReturnType<AgentService["get"]>>, body: { acceptance?: unknown[] } & Record<string, unknown>, workpadRevision = ctx.workpad?.revision ?? 0) => ({
  expectedRevision: ctx.revision,
  request: ctx.request,
  workpadRevision,
  acceptance: [],
  ...body,
});

test("workpad: replace the acceptance list with its own revision; task revision and status untouched; replay returns the receipt", async () => {
  const x = await setup({ workpad: false });
  const ctx = await x.service.get(x.identity);
  expect(ctx.workpad).toBeNull();
  const body = { acceptance: [{ text: "Card shows Acceptance n/m", done: false }] };
  const first = await x.service.write(x.identity, "workpad", workpadInput(ctx, body));
  expect(first.receipt).toMatchObject({ action: "workpad", workpadRevision: 1, taskRevision: ctx.revision.task });
  const stored = (await x.store.read()).workpads[0]!;
  expect(stored).toEqual({
    taskId: "t",
    projectId: "p",
    revision: 1,
    acceptance: [{ id: "card-shows-acceptance-n", text: "Card shows Acceptance n/m", done: false, by: "agent", at: expect.any(String) }],
    updatedAt: expect.any(String),
    updatedBy: "agent",
    agentId: "actor",
  });
  expect((await x.store.read()).tasks[0]!.revision).toBe(ctx.revision.task);
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "workpad_updated", actor: "agent", note: "Acceptance 0/1" });
  expect(first.current?.workpad).toEqual({ revision: 1, acceptance: stored.acceptance });
  const replay = await x.service.write(x.identity, "workpad", workpadInput(ctx, body));
  expect(replay.replayed).toBe(true);
  expect((await x.store.read()).workpads[0]!.revision).toBe(1);
});

test("workpad: a person's tick bumps the workpad revision only; the agent's stale copy conflicts, other tools do not", async () => {
  const x = await setup({ workpad: false });
  const ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ id: "a", text: "A", done: false }] }));
  const { WorkpadService } = await import("./workpad");
  const human = new WorkpadService(x.store);
  await human.check({ taskId: "t", section: "acceptance", itemId: "a", done: true });
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

test("workpad: only acceptance; validation, confusions or any other field is WORKPAD_INVALID and nothing is written (GUARDRAILS-SPEC §7.1)", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  const before = await readFile(x.store.path, "utf8");
  for (const extra of [{ validation: [] }, { confusions: [{ text: "?" }] }, { validation: [{ text: "Tests", state: "pass", sha: "abc1234" }], env: null }]) {
    const refused = await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "A", done: false }], ...extra })).catch((e) => e);
    expect(refused).toMatchObject({ code: "WORKPAD_INVALID" });
    for (const key of Object.keys(extra)) expect(String(refused.message)).toContain(key);
  }
  await expect(
    x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ id: "a", text: "a", done: false }, { id: "a", text: "b", done: false }] })),
  ).rejects.toMatchObject({ code: "WORKPAD_INVALID" });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
});

test("workpad: unticked criteria never refuse a delivery and leave no snapshot (no WORKPAD_OPEN, GUARDRAILS-SPEC §6.1)", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Works", done: false }, { text: "Fast", done: false }] }));
  ctx = await x.service.get(x.identity);
  const ok = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review" });
  expect(ok.receipt.status).toBe("in_review");
  const board = await x.store.read();
  expect(board.events.find((e) => e.id === ok.receipt.eventId)?.workpad).toBeUndefined();
});

test("workpad: off for the project — tool refused, no gate, get_task hides it; data kept and back when on", async () => {
  const x = await setup({ workpad: false });
  let ctx = await x.service.get(x.identity);
  expect(ctx.workpadEnabled).toBe(true);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ id: "e2e", text: "E2E", done: false }] }));
  const off = await x.store.updateProject({ id: "p", revision: 1, workpad: false });
  expect(off.workpad).toBe(false);
  ctx = await x.service.get(x.identity);
  expect(ctx).toMatchObject({ workpadEnabled: false, workpad: null, plan: [] });
  await expect(x.service.write(x.identity, "workpad", workpadInput(ctx, {}, 1))).rejects.toMatchObject({ code: "WORKPAD_DISABLED" });
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  const ok = await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  expect(ok.receipt.status).toBe("in_review");
  await x.store.updateProject({ id: "p", revision: 2, workpad: true });
  ctx = await x.service.get(x.identity);
  expect(ctx.workpad).toMatchObject({ revision: 1, acceptance: [{ id: "e2e" }] });
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

test("next moves: a delivery refused for missing setup records no suggestion; the resend with the same moves does", async () => {
  const x = await setup({ tags: false });
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  const call = { ...input(ctx, "Delivered; no tags"), status: "in_review", nextMoves: [commitMove] };
  await expect(x.service.write(x.identity, "status", call)).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
  let board = await x.store.read();
  expect(board.tasks[0]!.status).toBe("development");
  expect(suggestions(board)).toHaveLength(0);
  await x.service.write(x.identity, "status", { ...call, acknowledgeOpen: true });
  board = await x.store.read();
  expect(board.events.slice(-2).map((e) => e.action)).toEqual(["status_changed", "next_moves_suggested"]);
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
  let ctx = await x.service.get(x.identity);
  expect(Object.keys(ctx).slice(0, 2)).toEqual(["identity", "setup"]);
  expect(ctx.setup).toEqual({ typeMissing: true, tagsMissing: true, workpadMissing: true, stage: "todo", missing: ["type", "tags", "workpad"] });
  // An empty acceptance list is still missing.
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
  await expect(deliver(x)).rejects.toMatchObject({ code: "SETUP_INCOMPLETE", message: expect.stringContaining("no acceptance list") });
  await x.store.updateProject({ id: "p", revision: 1, workpad: false });
  expect((await deliver(x)).receipt.status).toBe("in_review");
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

test("gate: pre-acknowledgement refuses, same-state retry succeeds; pad/revision/turn/expiry/reload/session invalidate it", async () => {
  for (const change of ["none", "pad", "task", "project", "turn", "expiry", "reload", "session"] as const) {
    const x = await setup({ tags: false });
    const before = await readFile(x.store.path, "utf8");
    await expect(deliver(x, { acknowledgeOpen: true })).rejects.toMatchObject({ code: "SETUP_INCOMPLETE", message: expect.stringContaining("first attempt is always refused") });
    expect(await readFile(x.store.path, "utf8")).toBe(before);
    if (change === "pad") await pad(x, { acceptance: [{ text: "New criterion", done: true }] });
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
      next.attach(x.paseo);
      Object.assign(x, { service: next });
    }
    if (change === "session") Object.assign(x, { identity: { ...x.identity, agentId: "second" } });
    if (change !== "none") await expect(deliver(x, { acknowledgeOpen: true })).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
    const result = await deliver(x, { acknowledgeOpen: true, note: "No tags: intentionally omitted for this controlled gate check" });
    expect(result.receipt.status, change).toBe("in_review");
  }
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

test("committed is a delivery like In review: outputs and a Done move; refused when the lane is off", async () => {
  const x = await setup({ workpad: false });
  let ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).toEqual(["design", "development", "test", "blocked", "in_review", "committed", "integrated"]);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Works", done: true }] }));
  ctx = await x.service.get(x.identity);
  const done = [{ label: "Move to Done", moveTo: "done" }];
  const call = { ...input(ctx, "Committed cccccccc; not pushed"), status: "committed", nextMoves: done, outputs: [{ target: "https://github.com/fixture/repo/pull/7" }] };
  const ok = await x.service.write(x.identity, "status", call);
  expect(ok.receipt).toMatchObject({ status: "committed", artifactIds: [expect.any(String)] });
  expect(ok.reminders).toContain(ideasReminder);
  expect(ok.reminders).not.toContain(movesReminder);
  let board = await x.store.read();
  const moved = board.events.find((e) => e.id === ok.receipt.eventId)!;
  expect(moved).toMatchObject({ action: "status_changed", from: "development", to: "committed" });
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual(done);
  expect(board.artifacts.map((a) => a.role)).toEqual(["output"]);
  // The lane off (after a person moved the card out): STATUS_UNAVAILABLE.
  await x.store.editTask({ id: "t", revision: board.tasks[0]!.revision, status: "in_review", actor: "human" });
  board = await x.store.read();
  const project = board.projects[0]!;
  await setGroupLanes(x.store, project.id, (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "committed" })),
  );
  ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).not.toContain("committed");
  await expect(x.service.write(x.identity, "status", { ...input(ctx), status: "committed", nextMoves: [] })).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
});

test("integrated is a delivery like Committed, also straight from a work stage; refused when the lane is off (INTEGRATED-STAGE-SPEC §3)", async () => {
  const x = await setup({ workpad: false });
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", workpadInput(ctx, { acceptance: [{ text: "Works", done: true }] }));
  ctx = await x.service.get(x.identity);
  // Committed directly on the main checkout's branch: integrated with the commit, so no Committed first.
  const done = [{ label: "Move to Done", moveTo: "done" }];
  const call = { ...input(ctx, "Committed dddddddd on main in the main checkout; not pushed"), status: "integrated", nextMoves: done, outputs: [{ target: "https://github.com/fixture/repo/pull/8" }] };
  const ok = await x.service.write(x.identity, "status", call);
  expect(ok.receipt).toMatchObject({ status: "integrated", artifactIds: [expect.any(String)] });
  expect(ok.reminders).toContain(ideasReminder);
  let board = await x.store.read();
  const moved = board.events.find((e) => e.id === ok.receipt.eventId)!;
  expect(moved).toMatchObject({ action: "status_changed", from: "development", to: "integrated" });
  expect(openNextMoves(board.events, x.identity.agentId)?.moves).toEqual(done);
  // The lane off (after a person moved the card out): STATUS_UNAVAILABLE.
  await x.store.editTask({ id: "t", revision: board.tasks[0]!.revision, status: "committed", actor: "human" });
  board = await x.store.read();
  const project = board.projects[0]!;
  await setGroupLanes(x.store, project.id, (["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "integrated" })),
  );
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

type Board = import("../shared/model").Board;

test("get_task delivery mode: card, then project, then group, then host (board groups spec §5)", async () => {
  const x = await setup();
  x.service.deliveryDefault = async () => "branch";
  const mutate = (fn: (board: Board) => void) => x.store.mutate(fn);
  const task = (board: Board) => board.tasks.find((t) => t.id === "t") as { deliveryMode?: string; projectId: string };
  await mutate((board) => {
    const project = board.projects.find((p) => p.id === task(board).projectId)!;
    board.groups = [{ id: "g", name: "G", position: 0, revision: 1, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", isDefault: true, defaults: { deliveryMode: "draft_pr" } }];
    project.groupId = "g";
  });
  expect((await x.service.get(x.identity)).deliveryMode).toBe("draft_pr");
  await mutate((board) => {
    board.projects.find((p) => p.id === task(board).projectId)!.deliveryMode = "ready_pr";
  });
  expect((await x.service.get(x.identity)).deliveryMode).toBe("ready_pr");
  await mutate((board) => {
    task(board).deliveryMode = "branch";
  });
  expect((await x.service.get(x.identity)).deliveryMode).toBe("branch");
});

test("get_task lists the card's sessions in background workspaces too", async () => {
  const x = await setup();
  const list = vi.fn(x.paseo.agents.list.bind(x.paseo.agents));
  (x.paseo.agents as { list: unknown }).list = list;
  await x.service.get(x.identity);
  expect(list).toHaveBeenCalled();
  for (const [input] of list.mock.calls) expect(input).toMatchObject({ filter: { includeBackground: true } });
});

/** Card t (this session's) and s join umbrella "Fresh context" in the fixture's group; returns its id. */
async function umbrellaSetup(brief = "The goal") {
  const x = await setup();
  const groupId = "g";
  const human = { kind: "human" as const };
  await x.store.mutate((board) => {
    board.groups.push({ id: groupId, name: "G", position: 0, isDefault: true, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    board.projects[0]!.groupId = groupId;
    board.tasks.push({ ...board.tasks[0]!, id: "s", workspaceId: "w-s", title: "Sibling", operationId: "create-s" });
  });
  const u = await createUmbrella(x.store, { groupId, title: "Fresh context", brief }, human);
  await setMembership(x.store, { taskId: "t", umbrellaId: u.id, role: "feature map", order: 1 }, human);
  await setMembership(x.store, { taskId: "s", umbrellaId: u.id, role: "harness", order: 2 }, human);
  const addEntries = (entries: Partial<UmbrellaEntry>[]) =>
    x.store.mutate((board) => {
      for (const e of entries)
        board.umbrellaEntries.push({
          id: e.id!, umbrellaId: u.id, kind: "decision", title: e.id!, body: "", status: "active", by: human,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...e,
        });
    });
  return { ...x, umbrellaId: u.id, human, addEntries };
}

test("a card outside an umbrella gets umbrella null; the field is optional in the schema and always sent", async () => {
  const x = await setup();
  const ctx = await x.service.get(x.identity);
  expect(ctx).toHaveProperty("umbrella", null);
  const { umbrella: _umbrella, ...older } = ctx;
  expect(toolContextSchema.safeParse(older).success).toBe(true);
  expect(toolContextSchema.safeParse(ctx).success).toBe(true);
});

test("a member reads its umbrella in flowly_get_task", async () => {
  const x = await umbrellaSetup();
  const ctx = await x.service.get(x.identity);
  expect(toolContextSchema.safeParse(ctx).success).toBe(true);
  expect(ctx.umbrella).toMatchObject({
    id: x.umbrellaId, title: "Fresh context", role: "feature map", integration: false,
    brief: { text: "The goal", unread: true, truncated: false },
    siblings: [{ taskId: "s", title: "Sibling", role: "harness", laneName: "Todo", projectTitle: "Project" }],
  });
});

test("an edit by another session marks the brief unread once", async () => {
  const x = await umbrellaSetup();
  expect((await x.service.get(x.identity)).umbrella!.brief.unread).toBe(true);
  expect((await x.service.get(x.identity)).umbrella!.brief.unread).toBe(false);
  // The second session on the same card has its own marks.
  expect((await x.service.get({ ...x.identity, agentId: "second" })).umbrella!.brief.unread).toBe(true);
  const revision = (await x.store.read()).umbrellas[0]!.revision;
  await updateUmbrella(x.store, { id: x.umbrellaId, revision, brief: "The new goal" }, x.human);
  const after = await x.service.get(x.identity);
  expect(after.umbrella!.brief).toMatchObject({ text: "The new goal", unread: true });
  expect((await x.service.get(x.identity)).umbrella!.brief.unread).toBe(false);
  // An agent's own entry is never unread to it; a write's context does not clear unread marks.
  await x.addEntries([{ id: "mine", by: { kind: "agent", agentId: "actor", taskId: "t" }, sourceTaskId: "t" }, { id: "theirs" }]);
  const passive = await x.service.get(x.identity, false);
  expect(passive.umbrella!.feed.map((e) => [e.id, e.unread])).toEqual(expect.arrayContaining([["mine", false], ["theirs", true]]));
  expect((await x.service.get(x.identity)).umbrella!.feed.find((e) => e.id === "theirs")!.unread).toBe(true);
  expect((await x.service.get(x.identity)).umbrella!.feed.find((e) => e.id === "theirs")!.unread).toBe(false);
});

test("unread entries left out stay unread and are counted", async () => {
  const x = await umbrellaSetup();
  await x.addEntries([1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, title: "t".repeat(100), body: "x".repeat(2000), createdAt: `2026-11-25T00:0${n}:00.000Z` })));
  const first = (await x.service.get(x.identity)).umbrella!;
  expect(first.feed.map((e) => e.id)).toEqual(["d5", "d4"]);
  expect(first).toMatchObject({ unreadLeftOut: 3, truncatedFeed: 3 });
  const second = (await x.service.get(x.identity)).umbrella!;
  expect(second.feed.slice(0, 2).map((e) => [e.id, e.unread])).toEqual([["d3", true], ["d2", true]]);
  expect(second.unreadLeftOut).toBe(1);
});

test("a long brief is cut at 8,000, marked truncated and stays unread", async () => {
  const x = await umbrellaSetup("b".repeat(9000));
  for (let i = 0; i < 2; i++) {
    const brief = (await x.service.get(x.identity)).umbrella!.brief;
    expect(brief).toMatchObject({ truncated: true, unread: true });
    expect(brief.text).toHaveLength(8000);
  }
});

test("an answered question returns once to the asking card with its answer", async () => {
  const x = await umbrellaSetup();
  await x.addEntries([{ id: "q", kind: "question", status: "open", sourceTaskId: "t", by: { kind: "agent", agentId: "actor", taskId: "t" } }]);
  expect((await x.service.get(x.identity)).umbrella!.feed).toEqual([expect.objectContaining({ id: "q", status: "open", unread: false })]);
  await updateEntry(x.store, { id: "q", status: "answered", answer: "Drafts only" }, x.human);
  const first = (await x.service.get(x.identity)).umbrella!;
  expect(first.feed).toEqual([expect.objectContaining({ id: "q", status: "answered", answer: "Drafts only", unread: true })]);
  expect((await x.service.get(x.identity)).umbrella!.feed).toEqual([]);
  // Once per session: the card's second session gets it once too.
  expect((await x.service.get({ ...x.identity, agentId: "second" })).umbrella!.feed).toEqual([expect.objectContaining({ id: "q", answer: "Drafts only" })]);
  expect((await x.service.get({ ...x.identity, agentId: "second" })).umbrella!.feed).toEqual([]);
});

/** umbrellaSetup plus a session "sib" on the sibling card s, and card o outside the umbrella with its session "out". */
async function memberSetup() {
  const x = await umbrellaSetup();
  x.actors.sib = { id: "sib", workspaceId: "w-s", title: "Sibling session", status: "idle", archivedAt: null };
  x.actors.out = { id: "out", workspaceId: "w-o", title: "Outside session", status: "idle", archivedAt: null };
  await x.store.mutate((board) => {
    const { umbrella: _umbrella, ...plain } = board.tasks[0]!;
    board.tasks.push({ ...plain, id: "o", workspaceId: "w-o", title: "Outside", operationId: "create-o" });
  });
  const sibling = { agentId: "sib", taskId: "s", workspaceId: "w-s" },
    outside = { agentId: "out", taskId: "o", workspaceId: "w-o" };
  const signed = async (who = x.identity) => {
    const ctx = await x.service.get(who, false);
    return { expectedRevision: ctx.revision, request: ctx.request };
  };
  const entry = async (who = x.identity, extra: Record<string, unknown> = {}) =>
    x.service.write(who, "umbrella_entry", { ...(await signed(who)), kind: "decision", title: "Use drafts", body: "Drafts keep review cheap.", ...extra });
  const code = (promise: Promise<unknown>) => promise.then(() => "none", (e) => toolFailure(e).code);
  return { ...x, sibling, outside, signed, entry, code };
}

test("flowly_add_umbrella_entry appends to the card's umbrella and every sibling sees it", async () => {
  const x = await memberSetup();
  const result = await x.entry();
  expect(result).toMatchObject({ replayed: false, receipt: { action: "umbrella_entry", taskRevision: 1 } });
  const stored = (await x.store.read()).umbrellaEntries.find((e) => e.title === "Use drafts")!;
  expect(stored).toMatchObject({ umbrellaId: x.umbrellaId, kind: "decision", status: "active", sourceTaskId: "t", by: { kind: "agent", agentId: "actor", taskId: "t" } });
  // The sibling's session gets it unread; the writing session never does.
  const seen = (await x.service.get(x.sibling)).umbrella!.feed.find((e) => e.id === stored.id);
  expect(seen).toMatchObject({ title: "Use drafts", sourceTaskId: "t", sourceTitle: "Card", unread: true });
  expect((await x.service.get(x.identity)).umbrella!.feed.find((e) => e.id === stored.id)!.unread).toBe(false);
  expect((await x.service.get(x.outside)).umbrella).toBeNull();
});

test("a ruling without a quote is refused", async () => {
  const x = await memberSetup();
  const base = { ...(await x.signed()), kind: "ruling", title: "No PRs", body: "" };
  expect(umbrellaEntryInputSchema.safeParse(base).success).toBe(false);
  expect(umbrellaEntryInputSchema.safeParse({ ...base, quote: "  " }).success).toBe(false);
  expect(umbrellaEntryInputSchema.safeParse({ ...base, quote: "suggestions never open PRs" }).success).toBe(true);
  // A quote is only for a ruling.
  expect(umbrellaEntryInputSchema.safeParse({ ...base, kind: "decision", quote: "x" }).success).toBe(false);
  await expect(x.service.write(x.identity, "umbrella_entry", base)).rejects.toThrow();
  expect((await x.store.read()).umbrellaEntries).toEqual([]);
});

test("a ruling records the quote and the agent", async () => {
  const x = await memberSetup();
  await x.entry(x.identity, { kind: "ruling", title: "No PRs from suggestions", quote: "suggestions never open PRs without review" });
  const ruling = (await x.store.read()).umbrellaEntries[0]!;
  expect(ruling).toMatchObject({ kind: "ruling", status: "active", quote: "suggestions never open PRs without review", by: { kind: "agent", agentId: "actor", taskId: "t" } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ taskId: "t", actor: "agent", agentId: "actor", action: "umbrella_ruling_added", note: "ruling: No PRs from suggestions" });
  await x.entry();
  expect((await x.store.read()).events.at(-1)).toMatchObject({ taskId: "t", action: "umbrella_entry_added", note: "decision: Use drafts" });
});

test("an agent entry bumps feedRevision and leaves revision alone", async () => {
  const x = await memberSetup();
  const before = await x.store.read();
  const u0 = before.umbrellas[0]!;
  await x.entry();
  const after = await x.store.read();
  expect(after.umbrellas[0]).toMatchObject({ revision: u0.revision, feedRevision: u0.feedRevision + 1 });
  expect(after.tasks.find((t) => t.id === "t")!.revision).toBe(before.tasks.find((t) => t.id === "t")!.revision);
  // An open panel edit under the old revision still goes through.
  await expect(updateUmbrella(x.store, { id: x.umbrellaId, revision: u0.revision, title: "Renamed" }, x.human)).resolves.toMatchObject({ title: "Renamed" });
});

test("the 21st feed write in an hour is refused", async () => {
  const x = await memberSetup();
  for (let i = 0; i < 19; i++) await x.entry(x.identity, { title: `Entry ${i}` });
  // A replayed request does not take a slot.
  const last = { ...(await x.signed()), kind: "finding", title: "Twentieth", body: "" };
  expect((await x.service.write(x.identity, "umbrella_entry", last)).replayed).toBe(false);
  expect((await x.service.write(x.identity, "umbrella_entry", last)).replayed).toBe(true);
  expect(await x.code(x.entry(x.identity, { title: "One too many" }))).toBe("UMBRELLA_RATE_LIMIT");
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "pitfall", title: "Also refused" }))).toBe("UMBRELLA_RATE_LIMIT");
  // Another session has its own 20.
  expect(await x.code(x.entry(x.sibling, { title: "Sibling's first" }))).toBe("none");
  x.advance(3600000);
  expect(await x.code(x.entry(x.identity, { title: "Next hour" }))).toBe("none");
});

test("a refused feed write gives its hourly slot back", async () => {
  const x = await memberSetup();
  for (let i = 0; i < 20; i++) expect(await x.code(x.entry(x.identity, { supersedes: "missing" }))).toBe("NOT_FOUND");
  expect(await x.code(x.entry())).toBe("none");
});

test("a closed umbrella refuses feed writes", async () => {
  const x = await memberSetup();
  await x.entry();
  const mine = (await x.store.read()).umbrellaEntries[0]!;
  await closeUmbrella(x.store, { id: x.umbrellaId, revision: (await x.store.read()).umbrellas[0]!.revision }, x.human);
  expect(await x.code(x.entry(x.identity, { title: "Late" }))).toBe("UMBRELLA_CLOSED");
  expect(await x.code(x.service.write(x.identity, "umbrella_withdraw", { ...(await x.signed()), id: mine.id }))).toBe("UMBRELLA_CLOSED");
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "decision", title: "Late" }))).toBe("UMBRELLA_CLOSED");
  // It stays readable.
  expect((await x.service.get(x.identity)).umbrella).toMatchObject({ status: "closed", feed: [expect.objectContaining({ id: mine.id })] });
});

test("a non-member gets NOT_IN_UMBRELLA", async () => {
  const x = await memberSetup();
  expect(await x.code(x.entry(x.outside))).toBe("NOT_IN_UMBRELLA");
  expect(await x.code(x.service.write(x.outside, "umbrella_withdraw", { ...(await x.signed(x.outside)), id: "any" }))).toBe("NOT_IN_UMBRELLA");
  expect(await x.code(x.service.write(x.outside, "remember", { ...(await x.signed(x.outside)), scope: "umbrella", kind: "decision", title: "X" }))).toBe("NOT_IN_UMBRELLA");
  expect(await x.code(x.service.write(x.outside, "idea", { ...(await x.signed(x.outside)), title: "X", detail: "D", rationale: "R", umbrella: true }))).toBe("NOT_IN_UMBRELLA");
  const board = await x.store.read();
  expect(board.umbrellaEntries).toEqual([]);
  expect(board.ideas).toEqual([]);
  expect(board.agentReceipts).toEqual([]);
});

test("remember scope=umbrella writes a feed entry and no project note", async () => {
  const x = await memberSetup();
  const memory = { precheck: vi.fn(), propose: vi.fn(), taskContext: vi.fn(async () => ({ enabled: true, total: 0, entries: [] })) };
  x.service.memory = memory as unknown as MemoryService;
  const result = await x.service.write(x.identity, "remember", {
    ...(await x.signed()), scope: "umbrella", kind: "convention", title: "Fixtures live in tinylink", body: "Never a new demo.", tags: ["Not A Tag!!"], keywords: ["k"],
  });
  expect(result.receipt.action).toBe("remember");
  expect(result).not.toHaveProperty("memoryId");
  expect(memory.precheck).not.toHaveBeenCalled();
  expect(memory.propose).not.toHaveBeenCalled();
  const stored = (await x.store.read()).umbrellaEntries;
  expect(stored).toEqual([expect.objectContaining({ kind: "convention", title: "Fixtures live in tinylink", body: "Never a new demo.", status: "active", sourceTaskId: "t" })]);
  expect(stored[0]).not.toHaveProperty("tags");
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "umbrella_entry_added", note: "convention: Fixtures live in tinylink" });
  expect((await x.service.get(x.sibling)).umbrella!.feed.map((e) => e.title)).toEqual(["Fixtures live in tinylink"]);
  // supersedes names a feed entry.
  await x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "convention", title: "Fixtures live in tinylink only", supersedes: stored[0]!.id });
  expect((await x.store.read()).umbrellaEntries[0]!.status).toBe("superseded");
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "contact", title: "Ops is Jane" }))).toBe("UMBRELLA_KIND");
  // MEMORY_DISABLED never applies to the umbrella scope.
  x.service.memory = undefined;
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "pitfall", title: "Works with memory off" }))).toBe("none");
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), kind: "pitfall", title: "Project note" }))).toBe("MEMORY_DISABLED");
});

test("withdraw only touches this card's own entries", async () => {
  const x = await memberSetup();
  await x.entry();
  await x.entry(x.sibling, { title: "Sibling's" });
  const [mine, theirs] = (await x.store.read()).umbrellaEntries;
  const feedRevision = (await x.store.read()).umbrellas[0]!.feedRevision;
  const result = await x.service.write(x.identity, "umbrella_withdraw", { ...(await x.signed()), id: mine!.id });
  expect(result.receipt.action).toBe("umbrella_withdraw");
  expect(await x.code(x.service.write(x.identity, "umbrella_withdraw", { ...(await x.signed()), id: theirs!.id }))).toBe("NOT_FOUND");
  const board = await x.store.read();
  expect(board.umbrellaEntries.map((e) => e.status)).toEqual(["superseded", "active"]);
  expect(board.umbrellas[0]).toMatchObject({ feedRevision: feedRevision + 1 });
  expect(board.events.at(-1)).toMatchObject({ taskId: "t", action: "umbrella_entry_withdrawn", note: "decision: Use drafts" });
});

test("propose_idea umbrella=true sets umbrellaId and siblings see it in ideas", async () => {
  const x = await memberSetup();
  const idea = { title: "Share fixtures", detail: "D", rationale: "R" };
  const flagged = await x.service.write(x.identity, "idea", { ...(await x.signed()), ...idea, umbrella: true });
  await x.service.write(x.identity, "idea", { ...(await x.signed()), ...idea, title: "Card only" });
  const board = await x.store.read();
  expect(board.ideas.find((i) => i.id === flagged.ideaId)).toMatchObject({ umbrellaId: x.umbrellaId });
  expect(board.ideas.find((i) => i.title === "Card only")).not.toHaveProperty("umbrellaId");
  expect((await x.service.get(x.sibling)).umbrella!.ideas).toEqual([expect.objectContaining({ id: flagged.ideaId, title: "Share fixtures", sourceTaskId: "t" })]);
});

test("AGENT_CARDS_DISABLED refuses umbrella writes", async () => {
  const x = await memberSetup();
  await x.entry();
  const mine = (await x.store.read()).umbrellaEntries[0]!;
  x.service.agentCardsOn = async () => false;
  expect(await x.code(x.entry(x.identity, { title: "Off" }))).toBe("AGENT_CARDS_DISABLED");
  expect(await x.code(x.service.write(x.identity, "umbrella_withdraw", { ...(await x.signed()), id: mine.id }))).toBe("AGENT_CARDS_DISABLED");
  expect(await x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "decision", title: "Off" }))).toBe("AGENT_CARDS_DISABLED");
  expect(await x.code(x.service.write(x.identity, "idea", { ...(await x.signed()), title: "Off", detail: "D", rationale: "R", umbrella: true }))).toBe("AGENT_CARDS_DISABLED");
  // A plain idea is not an umbrella write.
  expect(await x.code(x.service.write(x.identity, "idea", { ...(await x.signed()), title: "Plain", detail: "D", rationale: "R" }))).toBe("none");
  expect((await x.store.read()).umbrellaEntries).toHaveLength(1);
});

test("D22: remember scope=umbrella can't supersede a ruling or another card's open question", async () => {
  const x = await memberSetup();
  await x.entry(x.sibling, { kind: "ruling", title: "No PRs", quote: "never open PRs" });
  await x.entry(x.sibling, { kind: "question", title: "Drafts?" });
  const [ruling, asked] = (await x.store.read()).umbrellaEntries;
  const remember = async (supersedes: string) =>
    x.code(x.service.write(x.identity, "remember", { ...(await x.signed()), scope: "umbrella", kind: "decision", title: `Replace ${supersedes}`, supersedes }));
  expect(await remember(ruling!.id)).toBe("UMBRELLA_KIND");
  expect(await remember(asked!.id)).toBe("INVALID_INPUT");
  expect((await x.store.read()).umbrellaEntries.map((e) => e.status)).toEqual(["active", "open"]);
});

/** memberSetup plus `propose`: flowly_propose_contract_change from a session, on the contract revision it read. */
async function proposalSetup() {
  const x = await memberSetup();
  const propose = async (who = x.identity, after = "shape: {a, b}", reason = "The gallery needs b") => {
    const ctx = await x.service.get(who, false);
    return x.service.write(who, "contract_change", {
      expectedRevision: ctx.revision,
      request: ctx.request,
      after,
      reason,
      baseRevision: ctx.umbrella!.contract.revision,
    });
  };
  return { ...x, propose };
}

test("flowly_propose_contract_change records a proposal and never edits the contract", async () => {
  const x = await proposalSetup();
  const result = await x.propose();
  expect(result).toMatchObject({ replayed: false, receipt: { action: "contract_change", taskRevision: 1 } });
  const board = await x.store.read();
  expect(board.umbrellaEntries).toEqual([
    expect.objectContaining({ kind: "contract_change", status: "proposed", sourceTaskId: "t", change: expect.objectContaining({ after: "shape: {a, b}", baseRevision: 0 }) }),
  ]);
  expect(board.umbrellas[0]!.contract).toMatchObject({ text: "", revision: 0 });
  expect(board.events.at(-1)).toMatchObject({ taskId: "t", actor: "agent", agentId: "actor", action: "umbrella_contract_proposed" });
  // The sibling reads it among the pending changes; a stale base is refused.
  expect((await x.service.get(x.sibling)).umbrella).toMatchObject({ pendingContractChanges: 1 });
  const ctx = await x.service.get(x.sibling, false);
  expect(
    await x.code(x.service.write(x.sibling, "contract_change", { expectedRevision: ctx.revision, request: ctx.request, after: "x", reason: "y", baseRevision: 5 })),
  ).toBe("CONTRACT_STALE");
});

test("an accepted proposal marks the contract unread for every member", async () => {
  const x = await proposalSetup();
  // Both sessions read the umbrella first, so the contract is read.
  await x.service.get(x.identity);
  await x.service.get(x.sibling);
  await x.propose();
  const proposal = (await x.store.read()).umbrellaEntries[0]!;
  await resolveChange(x.store, { id: proposal.id, decision: "accepted" }, x.human);
  for (const who of [x.sibling, x.identity]) {
    expect((await x.service.get(who)).umbrella!.contract).toMatchObject({ text: "shape: {a, b}", revision: 1, unread: true });
    expect((await x.service.get(who)).umbrella!.contract.unread).toBe(false);
  }
});

test("rejecting returns the entry once to the proposing card with the note", async () => {
  const x = await proposalSetup();
  await x.propose();
  const proposal = (await x.store.read()).umbrellaEntries[0]!;
  await x.service.get(x.sibling);
  await updateEntry(x.store, { id: proposal.id, status: "rejected", answer: "Keep a alone for now" }, x.human);
  const first = (await x.service.get(x.identity)).umbrella!;
  expect(first.feed).toEqual([expect.objectContaining({ id: proposal.id, status: "rejected", answer: "Keep a alone for now", unread: true })]);
  expect((await x.service.get(x.identity)).umbrella!.feed.find((e) => e.id === proposal.id)).toBeUndefined();
  // A sibling never gets it.
  expect((await x.service.get(x.sibling)).umbrella!.feed.find((e) => e.id === proposal.id)).toBeUndefined();
});

/** memberSetup with two acceptance items and the session's card "t" as the umbrella's integration card. */
async function acceptanceSetup(integration = true) {
  const x = await memberSetup();
  await updateUmbrella(
    x.store,
    {
      id: x.umbrellaId,
      revision: (await x.store.read()).umbrellas[0]!.revision,
      acceptance: [{ text: "Corrections reach the next session", done: false }, { text: "No duplicate notes", done: false }],
      ...(integration ? { integrationTaskId: "t" } : {}),
    },
    x.human,
  );
  const items = (await x.store.read()).umbrellas[0]!.acceptance;
  const tick = async (extra: Record<string, unknown> = {}, who = x.identity) =>
    x.service.write(who, "umbrella_acceptance", { ...(await x.signed(who)), acceptance: [{ id: items[0]!.id, done: true }], note: "Ran it end to end.", ...extra });
  return { ...x, items, tick };
}

test("flowly_update_umbrella_acceptance ticks an item with a note on the integration card", async () => {
  const x = await acceptanceSetup();
  // get_task gives the integration card the ids it needs.
  expect((await x.service.get(x.identity)).umbrella).toMatchObject({ integration: true, acceptance: [{ id: x.items[0]!.id, done: false }, { id: x.items[1]!.id, done: false }] });
  const before = (await x.store.read()).umbrellas[0]!;
  const result = await x.tick();
  expect(result).toMatchObject({ replayed: false, receipt: { action: "umbrella_acceptance", taskRevision: 1 } });
  const board = await x.store.read();
  expect(board.umbrellas[0]!.acceptance[0]).toMatchObject({ done: true, by: { kind: "agent", agentId: "actor", taskId: "t" } });
  expect(board.umbrellas[0]).toMatchObject({ revision: before.revision, feedRevision: before.feedRevision + 1 });
  expect(board.events.at(-1)).toMatchObject({ taskId: "t", actor: "agent", agentId: "actor", action: "umbrella_acceptance_ticked", note: expect.stringContaining("Ran it end to end.") });
  expect((await x.service.get(x.sibling)).umbrella!.acceptance[0]).toMatchObject({ done: true });
});

test("flowly_update_umbrella_acceptance refuses other cards, unknown ids, a missing note and a closed umbrella", async () => {
  const x = await acceptanceSetup();
  expect(await x.code(x.tick({ acceptance: [{ id: "nope", done: true }] }))).toBe("NOT_FOUND");
  await expect(x.tick({ note: "" })).rejects.toThrow();
  expect(await x.code(x.tick({}, x.sibling))).toBe("NOT_INTEGRATION_CARD");
  expect(await x.code(x.tick({}, x.outside))).toBe("NOT_IN_UMBRELLA");
  expect((await x.store.read()).umbrellas[0]!.acceptance.every((a) => !a.done)).toBe(true);
  await closeUmbrella(x.store, { id: x.umbrellaId, revision: (await x.store.read()).umbrellas[0]!.revision }, x.human);
  expect(await x.code(x.tick())).toBe("UMBRELLA_CLOSED");
});

test("a card that is not the integration card is refused even when none is set", async () => {
  const x = await acceptanceSetup(false);
  expect(await x.code(x.tick())).toBe("NOT_INTEGRATION_CARD");
});

test("flowly_update_umbrella_acceptance sits behind Agents create and edit cards and takes a feed slot", async () => {
  const x = await acceptanceSetup();
  x.service.agentCardsOn = async () => false;
  expect(await x.code(x.tick())).toBe("AGENT_CARDS_DISABLED");
  expect((await x.store.read()).umbrellas[0]!.acceptance.every((a) => !a.done)).toBe(true);
});
