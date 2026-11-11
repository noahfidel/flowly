import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFixture } from "./agent-fixture";
import { shipMessage } from "../shared/auto-review";
import {
  AutoReviewService,
  changedRepos,
  commandApplies,
  defaultGit,
  linkedHead,
  linkedRepos,
  linkedReviewDiff,
  linkedShape,
  numstatShape,
  repoPath,
  reviewDiff,
  reviewShape,
  type Git,
  type LlmReview,
  type LlmReviewInput,
  type RunCheck,
} from "./auto-review";
import { GuardrailsService } from "./guardrails";
import type { AgentService } from "./agent-service";
import type { ChangeShape, Lane } from "../shared/model";
import { emptyCounts, type CardItem, type GuardrailEntry } from "../shared/guardrails";
import { projectLanes } from "../shared/lanes";
import { attentionItems } from "../shared/attention";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

type Ctx = Awaited<ReturnType<AgentService["get"]>>;
const input = (ctx: Ctx, note = "checkpoint") => ({ expectedRevision: ctx.revision, request: ctx.request, note });
const stamp = new Date().toISOString();
const command = (id: string, argv: string[], extra: Partial<GuardrailEntry> = {}): GuardrailEntry => ({
  id,
  projectId: "p",
  kind: "command",
  text: id === "tests" ? "Tests" : id.toUpperCase(),
  argv,
  state: "active",
  stateAt: stamp,
  counts: emptyCounts(),
  sources: [],
  by: "user",
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...extra,
});
const guideline = (id: string, text: string, extra: Partial<GuardrailEntry> = {}): GuardrailEntry => ({
  id,
  projectId: "p",
  kind: "guideline",
  text,
  scope: { types: "all", sizes: "all" },
  state: "active",
  stateAt: stamp,
  counts: emptyCounts(),
  sources: [{ taskId: "old", at: stamp, quote: `quote of ${id}` }],
  by: "learned",
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...extra,
});
const cardItem = (id: string, text: string): CardItem => ({ id, projectId: "p", taskId: "t", text, quote: `words of ${id}`, shape: {}, count: 1, state: "open", createdAt: stamp, updatedAt: stamp });
/** Passes every check it is given. */
const passAll: LlmReview = async (input) => ({ model: "claude/haiku", verdicts: input.checks.map((c) => ({ id: c.id, verdict: "pass" as const, detail: "Fine." })) });

/**
 * A card with auto review on and the project's guardrails: by default one active command "Tests" (npm test) and a
 * reviewer that passes everything. `exits` maps a command line to its exit code (missing: 0).
 */
async function setup(
  options: {
    maxRounds?: number;
    lanes?: Lane[];
    exits?: Record<string, number | "spawn" | "timeout">;
    llm?: LlmReview;
    conversation?: () => Promise<string[] | null>;
    entries?: GuardrailEntry[];
    items?: CardItem[];
    shape?: ChangeShape;
    paths?: string[];
    exists?: (path: string) => Promise<boolean>;
    memory?: boolean;
    baseRef?: string;
    /** The workspace directory and git to use, with the real diff and shape (a linked root); default: fakes. */
    directory?: string;
    git?: Git;
    run?: RunCheck;
    /** The card's effective delivery mode (DELIVERY-MODE-SPEC §2); default: branch. */
    deliveryMode?: string;
  } = {},
) {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((b) => {
    b.projects[0]!.autoReview = { enabled: true, maxRounds: options.maxRounds ?? 2 };
    if (options.lanes) b.projects[0]!.lanes = options.lanes;
    if (options.memory === false) b.projects[0]!.memory = false;
    if (options.baseRef) b.tasks[0]!.baseRef = options.baseRef;
  });
  const guardrails = new GuardrailsService(x.store, () => Date.now(), async () => []);
  x.service.guardrails = guardrails;
  await guardrails.store.update((state) => {
    state.entries.push(...(options.entries ?? [command("tests", ["npm", "test"])]));
    state.items.push(...(options.items ?? []));
    return { value: undefined, changed: true };
  });
  const exits = { ...options.exits };
  const runs: string[] = [];
  let during: () => Promise<void> = async () => undefined;
  const run: RunCheck = async (argv) => {
    const key = argv.join(" ");
    runs.push(key);
    await during();
    const exit = exits[key] ?? 0;
    if (exit === "spawn") return { exitCode: null, timedOut: false, spawnError: "spawn npm ENOENT", ms: 1, output: "" };
    if (exit === "timeout") return { exitCode: null, timedOut: true, ms: 1, output: "slow" };
    return { exitCode: exit, timedOut: false, ms: 5, output: exit ? `\u001b[31mFAIL\u001b[0m expected 1 to be 2\n` : "ok\n" };
  };
  const repo = { head: "aaaaaaaaaaaa" };
  const git: Git =
    options.git ??
    (async (_cwd, args) => {
      const key = args.join(" ");
      if (key === "rev-parse --short=12 HEAD") return repo.head;
      if (key === "rev-parse --abbrev-ref HEAD") return "main";
      return "";
    });
  const diffs: (string | undefined)[] = [];
  const bases: (string | undefined)[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const reviews = new AutoReviewService(x.store, {
    workspace: async () => ({ directory: options.directory ?? x.a, worktree: false }),
    sessionBusy: async (agentId) => x.actors[agentId]?.status === "running",
    sessionLive: async (agentId) => !!x.actors[agentId] && !x.actors[agentId]!.archivedAt,
    send: async (message) => {
      sent.push({ agentId: message.agentId, text: message.text });
    },
    run: options.run ?? run,
    git,
    guardrails,
    llm: options.llm ?? passAll,
    deliveryMode: async () => options.deliveryMode ?? "branch",
    ...(options.conversation ? { conversation: options.conversation } : {}),
    ...(options.directory
      ? {}
      : {
          diff: async (_dir: string, since?: string, baseRef?: string) => {
            diffs.push(since);
            bases.push(baseRef);
            return "diff --git a/x b/x";
          },
          shape: async (_dir: string, baseRef?: string) => (bases.push(baseRef), { shape: options.shape ?? { files: 1, lines: 10, size: "s" as const }, paths: new Set(options.paths ?? ["src/a.ts"]) }),
        }),
    exists: options.exists ?? (async () => false),
  });
  let delivering: Promise<void> = Promise.resolve();
  x.service.onDelivered = (delivery, paseo) => {
    delivering = reviews.delivered(delivery, paseo);
  };
  /** Moves the card to `stage` and then delivers it, as the agent; waits for the review. */
  const deliver = async (stage?: "design" | "development" | "test", extra: Record<string, unknown> = {}) => {
    let ctx = await x.service.get(x.identity);
    if (stage && ctx.task.status !== stage) {
      await x.service.write(x.identity, "status", { ...input(ctx), status: stage });
      ctx = await x.service.get(x.identity);
    }
    await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review", nextMoves: [], ...extra });
    await delivering;
    await reviews.idle();
    return x.store.read();
  };
  const turnStarted = () =>
    x.store.mutate((b) => {
      x.store.event(b, { taskId: "t", actor: "system", action: "agent.turn_started", agentId: "actor" });
    });
  const entry = async (id: string) => (await guardrails.store.read()).entries.find((e) => e.id === id)!;
  return { ...x, reviews, guardrails, sent, runs, exits, repo, diffs, bases, deliver, turnStarted, entry, setDuring: (fn: () => Promise<void>) => (during = fn) };
}

const card = async (x: { store: { read(): Promise<import("../shared/model").Board> } }) => (await x.store.read()).tasks[0]!;

test("no L1 any more: an unticked acceptance list delivers; a card without one gets SETUP_INCOMPLETE once (GUARDRAILS-SPEC §6.1)", async () => {
  const x = await setup();
  let ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx), status: "development" });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "workpad", { expectedRevision: ctx.revision, request: ctx.request, workpadRevision: ctx.workpad!.revision, acceptance: [{ text: "Works", done: false }] });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review" });
  expect((await card(x)).status).toBe("in_review");
  // Without an acceptance list: refused once, then let through with acknowledgeOpen.
  await x.store.mutate((b) => {
    b.tasks[0]!.status = "development";
    b.workpads[0]!.acceptance = [];
  });
  ctx = await x.service.get(x.identity);
  const refused = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review", acknowledgeOpen: true }).catch((e) => e);
  expect(refused).toMatchObject({ code: "SETUP_INCOMPLETE" });
  expect(String(refused.message)).toContain("no acceptance list");
  await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review", acknowledgeOpen: true });
  expect((await card(x)).status).toBe("in_review");
});

test("a pass on a Ship to main card sends the ship message; any other mode sends nothing (DELIVERY-MODE-SPEC §4)", async () => {
  const ship = await setup({ deliveryMode: "ship_main" });
  const shipped = await ship.deliver("development");
  expect(shipped.tasks[0]).toMatchObject({ status: "in_review", review: { state: "passed" } });
  expect(ship.sent).toEqual([{ agentId: "actor", text: shipMessage }]);
  expect(shipMessage.startsWith("[Flowly auto review")).toBe(true);
  const branch = await setup({ deliveryMode: "branch" });
  await branch.deliver("development");
  expect(branch.sent).toEqual([]);
});

test("a Ship to main card whose review fails gets the rework message, never the ship message (DELIVERY-MODE-SPEC §4)", async () => {
  const x = await setup({ deliveryMode: "ship_main", exits: { "npm test": 1 } });
  const board = await x.deliver("development");
  expect(board.tasks[0]).toMatchObject({ review: { state: "rework" } });
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0]!.text).not.toBe(shipMessage);
  expect(x.sent[0]!.text.startsWith("[Flowly auto review")).toBe(true);
});

test("a passing review leaves the card in In review; a person's move into In review starts none", async () => {
  const x = await setup();
  const board = await x.deliver("development");
  const task = board.tasks[0]!;
  expect(task.status).toBe("in_review");
  expect(task.review).toMatchObject({ state: "passed", round: 1, maxRounds: 2, shared: true, trigger: { agentId: "actor", from: "development" }, shape: { files: 1, lines: 10, size: "s" }, model: "claude/haiku" });
  expect(task.review!.items).toEqual([
    { id: "tests", kind: "command", name: "Tests", gating: true, state: "passed", argv: ["npm", "test"], exitCode: 0, ms: 5 },
    expect.objectContaining({ id: "goal", kind: "goal", name: "Does what you asked", gating: true, state: "passed" }),
  ]);
  expect(task.review).not.toHaveProperty("rules");
  // review_finished carries each item's result and kind (§6.4).
  expect(board.events.filter((e) => e.action === "review_finished").at(-1)!.results).toEqual([
    { id: "tests", state: "passed", kind: "command" },
    { id: "goal", state: "passed", kind: "goal" },
  ]);
  expect(x.sent).toEqual([]);
  // The review never changed the task revision: only the delivery did.
  const ctx = await x.service.get(x.identity);
  expect(ctx.review).toMatchObject({ state: "passed", round: 1, items: [{ id: "tests", name: "Tests", command: "npm test", state: "passed", gating: true }, { id: "goal" }] });
  expect(ctx).not.toHaveProperty("reviewRules");
  expect(ctx.guardrails).toMatchObject({ enabled: true, maxRounds: 2, commands: [{ id: "tests", name: "Tests", argv: ["npm", "test"], state: "active" }] });
  expect("review" in ctx.task).toBe(false);
  // A person moving it out and back starts nothing.
  await x.store.mutate((b) => {
    b.tasks[0]!.status = "development";
  });
  await x.store.mutate((b) => {
    b.tasks[0]!.status = "in_review";
  });
  await x.reviews.idle();
  expect(x.runs).toEqual(["npm test"]);
});

test("R1: a failure sends the card back to the stage it was delivered from, then the marked rework message", async () => {
  for (const stage of ["test", "design"] as const) {
    let called = false;
    const x = await setup({
      exits: { "npm test": 1 },
      llm: async (i) => {
        called = true;
        return passAll(i, null as never);
      },
    });
    const board = await x.deliver(stage);
    const task = board.tasks[0]!;
    expect(task.status).toBe(stage);
    expect(task.review).toMatchObject({ state: "rework", round: 1 });
    expect(task.review!.items[0]).toMatchObject({ state: "failed", exitCode: 1, tail: "FAIL expected 1 to be 2" });
    // One repository: nothing to say where it ran (§6.3).
    expect(task.review!.items[0]!.detail).toBeUndefined();
    // D9: the review session runs only when every gating command passed.
    expect(task.review!.items[1]).toMatchObject({ id: "goal", state: "skipped", reason: "A command failed." });
    expect(called).toBe(false);
    const moved = board.events.filter((e) => e.action === "status_changed").at(-1)!;
    expect(moved).toMatchObject({ actor: "system", rule: "R1", from: "in_review", to: stage, agentId: "actor" });
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]!.agentId).toBe("actor");
    expect(x.sent[0]!.text.startsWith("[Flowly auto review · rework 1/2]\n")).toBe(true);
    expect(x.sent[0]!.text).toContain("Commands: 0/1 passed\n✗ Tests (npm test) exited 1. [id: tests]");
    expect(x.sent[0]!.text).toContain("Review: skipped (a command failed)");
    const ctx = await x.service.get(x.identity);
    expect(ctx.review).toMatchObject({ state: "rework", items: [{ state: "failed", exitCode: 1 }, { state: "skipped" }] });
  }
});

test("R1 falls back to the latest work stage when the card was delivered from elsewhere or that lane is off", async () => {
  const lanes = projectLanes(null).map((l) => (l.status === "test" ? { ...l, enabled: false } : l));
  const x = await setup({ exits: { "npm test": 1 }, lanes });
  // Delivered straight from Todo: the latest work stage is unknown, so the first enabled one.
  const board = await x.deliver();
  expect(board.tasks[0]!.status).toBe("design");
});

test("R2: past maxRounds the card goes to Blocked without another message; maxRounds 0 goes there at once", async () => {
  const x = await setup({ exits: { "npm test": 1 }, maxRounds: 1 });
  let board = await x.deliver("development");
  expect(board.tasks[0]).toMatchObject({ status: "development", review: { state: "rework", round: 1 } });
  // The rework turn starts and the agent delivers again: the same round continues.
  await x.turnStarted();
  board = await x.deliver();
  expect(board.tasks[0]).toMatchObject({ status: "blocked", review: { state: "failed", round: 2 } });
  expect(board.events.filter((e) => e.action === "status_changed").at(-1)).toMatchObject({ rule: "R2", to: "blocked", note: "Auto review failed after 1 rework round" });
  expect(x.sent).toHaveLength(1);

  const zero = await setup({ exits: { "npm test": 1 }, maxRounds: 0 });
  board = await zero.deliver("development");
  expect(board.tasks[0]).toMatchObject({ status: "blocked", review: { state: "failed", round: 1 } });
  expect(zero.sent).toEqual([]);

  const noBlocked = await setup({ exits: { "npm test": 1 }, maxRounds: 0, lanes: projectLanes(null).map((l) => (l.status === "blocked" ? { ...l, enabled: false } : l)) });
  board = await noBlocked.deliver("development");
  expect(board.tasks[0]).toMatchObject({ status: "in_review", review: { state: "failed" } });
});

test("a person's message or move between deliveries starts the count again", async () => {
  const x = await setup({ exits: { "npm test": 1 }, maxRounds: 1 });
  await x.deliver("development");
  // The rework turn and a second turn the user started.
  await x.turnStarted();
  await x.turnStarted();
  const board = await x.deliver();
  expect(board.tasks[0]).toMatchObject({ status: "development", review: { state: "rework", round: 1 } });
  expect(x.sent).toHaveLength(2);
});

test("unavailable: a check that cannot start or times out, or a gone session, leaves the round count alone", async () => {
  for (const exit of ["spawn", "timeout"] as const) {
    const x = await setup({ exits: { "npm test": exit } });
    const board = await x.deliver("development");
    expect(board.tasks[0]).toMatchObject({ status: "in_review", review: { state: "unavailable", round: 1 } });
    expect(board.tasks[0]!.review!.reason).toMatch(exit === "spawn" ? /Tests: Could not start: spawn npm ENOENT/ : /Tests: Timed out after 600 s/);
    // The judged checks were skipped: a command that could not run says nothing about the change.
    expect(board.tasks[0]!.review!.items.find((i) => i.kind === "goal")).toMatchObject({ state: "skipped", reason: "A command could not run." });
    expect(x.sent).toEqual([]);
  }
  const x = await setup({ exits: { "npm test": 1 } });
  x.setDuring(async () => {
    x.actors.actor!.archivedAt = new Date().toISOString();
  });
  const board = await x.deliver("development");
  // R1 already moved it; it stays there.
  expect(board.tasks[0]).toMatchObject({ status: "development", review: { state: "unavailable", round: 1 } });
  expect(board.tasks[0]!.review!.finishedAt).toBeTruthy();
  expect(x.sent).toEqual([]);
});

test("cancelled: a card that changed during the review drops the result", async () => {
  const x = await setup({ exits: { "npm test": 1 } });
  x.setDuring(async () => {
    await x.store.mutate((b) => {
      b.workpads[0]!.revision++;
    });
  });
  const board = await x.deliver("development");
  expect(board.tasks[0]).toMatchObject({ status: "in_review", review: { state: "cancelled" } });
  expect(board.events.filter((e) => e.rule === "R1")).toEqual([]);
  expect(x.sent).toEqual([]);
});

test("Rerun: only in In review, from round 1, with the latest delivering session", async () => {
  const x = await setup({ exits: { "npm test": 1 }, maxRounds: 0 });
  await x.deliver("development");
  expect((await card(x)).status).toBe("blocked");
  await expect(x.reviews.rerun("t", x.paseo)).rejects.toThrow("Only a card in In review");
  await x.store.mutate((b) => {
    b.tasks[0]!.status = "in_review";
  });
  x.exits["npm test"] = 0;
  await x.reviews.rerun("t", x.paseo);
  await x.reviews.idle();
  expect(await card(x)).toMatchObject({ status: "in_review", review: { state: "passed", round: 1, trigger: { agentId: "actor", eventId: "" } } });
});

test("attention: a running review holds back unread sessions; a pass only releases them; failed and unavailable are signals", async () => {
  const x = await setup();
  await x.deliver("development");
  const board = await x.store.read();
  const agents = [{ id: "actor", workspaceId: "w", status: "idle", archivedAt: null, requiresAttention: true, attentionReason: "finished", updatedAt: "2026-10-28T00:00:00.000Z" }];
  const task = board.tasks[0]!;
  const passed = attentionItems(board, agents as never, [], false);
  expect(passed[0]).toMatchObject({ review: null, unread: 1 });
  expect(passed[0]!.signals.some((k) => k.startsWith("review:"))).toBe(false);
  // Read: nothing keeps a passed card in Attention.
  expect(attentionItems(board, [{ ...agents[0], requiresAttention: false, attentionReason: null }] as never, [], false)).toEqual([]);
  task.review = { ...task.review!, state: "running" };
  const running = attentionItems(board, agents as never, [], false);
  expect(running.find((i) => i.task.id === "t")?.unread ?? 0).toBe(0);
  for (const state of ["failed", "unavailable"] as const) {
    task.review = { ...task.review!, state };
    const item = attentionItems(board, [] as never, [], false)[0]!;
    expect(item).toMatchObject({ review: state });
    expect(item.signals).toEqual([`review:${state}:${task.review.startedAt}`]);
    expect(item.updatedAt).toBe(task.review.finishedAt);
  }
});

test("the review starts when the delivering session's turn ends, not while it is still running", async () => {
  const x = await setup();
  x.actors.actor!.status = "running";
  let board = await x.deliver("development");
  expect(x.runs).toEqual([]);
  expect(board.tasks[0]!.review).toBeUndefined();
  // Another session's turn ending does not start it.
  await x.reviews.turnEnded("second", x.paseo);
  expect(x.runs).toEqual([]);
  x.actors.actor!.status = "idle";
  await x.reviews.turnEnded("actor", x.paseo);
  await x.reviews.idle();
  board = await x.store.read();
  expect(board.tasks[0]!.review).toMatchObject({ state: "passed" });
  expect(x.runs).toEqual(["npm test"]);
  // Once only.
  await x.reviews.turnEnded("actor", x.paseo);
  await x.reviews.idle();
  expect(x.runs).toEqual(["npm test"]);
});

test("runCheck runs an argument array without a shell: exit code, output tail, timeout and a missing command", async () => {
  const { runCheck } = await import("./auto-review");
  const failed = await runCheck([process.execPath, "-e", "console.log('a b'); console.error('$HOME'); process.exit(3)"], process.cwd(), 10_000);
  expect(failed).toMatchObject({ exitCode: 3, timedOut: false });
  expect(failed.output).toContain("a b");
  expect(failed.output).toContain("$HOME");
  const slow = await runCheck([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], process.cwd(), 300);
  expect(slow.timedOut).toBe(true);
  const missing = await runCheck(["flowly-no-such-command-xyz"], process.cwd(), 5_000);
  expect(missing.spawnError).toMatch(/ENOENT/);
});

test("recover: a review left running by a restart becomes unavailable", async () => {
  const x = await setup();
  await x.deliver("development");
  await x.store.mutate((b) => {
    b.tasks[0]!.review = { ...b.tasks[0]!.review!, state: "running" };
  });
  expect(await x.reviews.recover()).toBe(true);
  expect(await card(x)).toMatchObject({ review: { state: "unavailable", reason: "Flowly restarted during the review." } });
  expect(await x.reviews.recover()).toBe(false);
});

test("an observing command runs and shows its result but never decides the review; it counts toward its promotion (§4.5)", async () => {
  const x = await setup({
    entries: [command("tests", ["npm", "test"]), command("e2e", ["npm", "run", "test:e2e"], { state: "observing", by: "detect", observe: { reviews: 2, passed: 0 } })],
    exits: { "npm run test:e2e": 1 },
  });
  let board = await x.deliver("development");
  expect(x.runs).toEqual(["npm test", "npm run test:e2e"]);
  expect(board.tasks[0]!.review!.items.map((i) => [i.id, i.gating, i.state])).toEqual([
    ["tests", true, "passed"],
    ["e2e", false, "failed"],
    ["goal", true, "passed"],
  ]);
  expect(board.tasks[0]).toMatchObject({ status: "in_review", review: { state: "passed" } });
  expect(x.sent).toEqual([]);
  // Three reviews without a pass: still observing; a pass on the next one makes it active.
  expect(await x.entry("e2e")).toMatchObject({ state: "observing", observe: { reviews: 3, passed: 0 } });
  x.exits["npm run test:e2e"] = 0;
  await x.reviews.rerun("t", x.paseo);
  await x.reviews.idle();
  expect(await x.entry("e2e")).toMatchObject({ state: "active", stateReason: "observed", counts: { reviews: 2, passes: 1 } });
  expect((await x.entry("e2e")).observe).toBeUndefined();
  // A command that cannot run three times in a row is paused (§4.5).
  x.exits["npm test"] = "spawn";
  for (let i = 0; i < 3; i++) {
    await x.reviews.rerun("t", x.paseo);
    await x.reviews.idle();
  }
  expect(await x.entry("tests")).toMatchObject({ state: "paused", stateReason: "cannot run" });
  board = await x.store.read();
  expect(board.events.filter((e) => e.action === "guardrail_retired").map((e) => e.guardrail)).toEqual([{ change: "paused", kind: "command", id: "tests" }]);
});

test("what is judged: the built-in check, guidelines in scope by type and size, the card's open items; Guardrails off leaves only commands and the goal (§6.2, B4)", async () => {
  let seen: LlmReviewInput | undefined;
  const llm: LlmReview = async (input) => {
    seen = input;
    return passAll(input, null as never);
  };
  const entries = [
    command("tests", ["npm", "test"]),
    guideline("g-small", "Small feature rule", { scope: { types: ["feature"], sizes: ["s"] } }),
    guideline("g-large", "Large-only rule", { scope: { types: "all", sizes: ["l"] } }),
    guideline("g-bug", "Bugfix-only rule", { scope: { types: ["bugfix"], sizes: "all" } }),
    guideline("g-paused", "Paused rule", { state: "paused" }),
  ];
  const x = await setup({ entries, items: [cardItem("i-1", "Keeps the scroll position")], llm, conversation: async () => ["Add login."] });
  const board = await x.deliver("development");
  expect(board.tasks[0]!.review!.items.map((i) => [i.id, i.kind])).toEqual([
    ["tests", "command"],
    ["goal", "goal"],
    ["g-small", "guideline"],
    ["i-1", "item"],
  ]);
  expect(seen!.checks.map((c) => [c.id, c.kind, c.quote])).toEqual([
    ["goal", "goal", undefined],
    ["g-small", "guideline", "quote of g-small"],
    ["i-1", "item", "words of i-1"],
  ]);
  expect(seen!.checks[0]!.text).toContain("A later instruction replaces an earlier one");
  expect(seen!.conversation).toEqual(["Add login."]);
  expect(seen).toMatchObject({ deliveryNote: "Delivered", diff: "diff --git a/x b/x", commands: ["Tests: passed"], acceptance: [{ text: "Seeded criterion" }] });
  expect(seen!.incremental).toBeUndefined();
  // Guardrails off for the project: no guidelines or items, the commands and the goal still run.
  const off = await setup({ entries, items: [cardItem("i-1", "Keeps the scroll position")], memory: false });
  const after = await off.deliver("development");
  expect(after.tasks[0]!.review!.items.map((i) => i.id)).toEqual(["tests", "goal"]);
  // No guardrails at all: the built-in check alone.
  const bare = await setup({ entries: [] });
  expect((await bare.deliver("development")).tasks[0]!.review!.items.map((i) => i.id)).toEqual(["goal"]);
  expect(bare.runs).toEqual([]);
});

test("B1: a fail without evidence becomes na; a file in the diff, an existing repository file or a quote found in the reviewer's input keeps it", async () => {
  const llm: LlmReview = async () => ({
    model: "m",
    verdicts: [
      { id: "goal", verdict: "fail", detail: "Feels incomplete." },
      { id: "g-diff", verdict: "fail", detail: "Wrong here.", file: "./src/a.ts", line: 3 },
      { id: "g-repo", verdict: "fail", detail: "No zh-TW entry.", file: "shared/i18n/zh-TW.ts" },
      { id: "g-quote", verdict: "fail", detail: "No Rerun button.", quote: "add a Rerun button" },
      { id: "g-outside", verdict: "fail", detail: "Elsewhere.", file: "../other/x.ts" },
      { id: "g-words", verdict: "fail", detail: "Same as before.", quote: "QUOTE OF  g-words" },
      { id: "g-title", verdict: "fail", detail: "Not the card.", quote: "card" },
      { id: "g-invented", verdict: "fail", detail: "No dark mode.", quote: "the user asked for a dark mode" },
    ],
  });
  const ids = ["g-diff", "g-repo", "g-quote", "g-outside", "g-words", "g-title", "g-invented"];
  const entries = ids.map((id) => guideline(id, id));
  const x = await setup({ entries, llm, exists: async (path) => path.endsWith("shared/i18n/zh-TW.ts"), conversation: async () => ["Please ADD a\n rerun button next to each failed check."] });
  const board = await x.deliver("development");
  const items = board.tasks[0]!.review!.items;
  expect(items.map((i) => [i.id, i.state, i.reason])).toEqual([
    ["goal", "na", "no evidence"],
    ["g-diff", "failed", undefined],
    ["g-repo", "failed", undefined],
    // From the conversation, the check's own user words and the card title.
    ["g-quote", "failed", undefined],
    ["g-outside", "na", "no evidence"],
    ["g-words", "failed", undefined],
    ["g-title", "failed", undefined],
    // A quote that appears nowhere the reviewer was given is no evidence.
    ["g-invented", "na", "no evidence"],
  ]);
  expect(items[1]).toMatchObject({ file: "src/a.ts", line: 3 });
  expect(items[3]).toMatchObject({ quote: "add a Rerun button" });
  // The rework message uses the user's words for guidelines.
  expect(x.sent[0]!.text).toContain('✗ "quote of g-diff" — Wrong here. (src/a.ts:3) [id: g-diff]');
});

test("round 2 reads only the changes since the previous delivery and keeps what passed before (§6.3)", async () => {
  const inputs: LlmReviewInput[] = [];
  let round = 0;
  const llm: LlmReview = async (input) => {
    inputs.push(input);
    round++;
    return round === 1
      ? { model: "m", verdicts: [{ id: "goal", verdict: "pass", detail: "ok" }, { id: "g1", verdict: "fail", detail: "zh-TW missing", file: "src/a.ts" }] }
      : { model: "m", verdicts: [{ id: "g1", verdict: "pass", detail: "fixed" }] };
  };
  const x = await setup({ entries: [guideline("g1", "i18n everywhere")], llm });
  await x.deliver("development");
  expect(x.diffs).toEqual([undefined]);
  await x.turnStarted();
  x.repo.head = "bbbbbbbbbbbb";
  const board = await x.deliver();
  expect(board.tasks[0]!.review).toMatchObject({ state: "passed", round: 2 });
  expect(x.diffs).toEqual([undefined, "aaaaaaaaaaaa"]);
  expect(inputs[1]).toMatchObject({ incremental: true });
  expect(inputs[1]!.checks.map((c) => [c.id, c.previous?.state])).toEqual([["goal", "passed"], ["g1", "failed"]]);
  // The goal passed in round 1 and was not judged again: its pass stands.
  expect(board.tasks[0]!.review!.items.find((i) => i.id === "goal")).toMatchObject({ state: "passed", reason: "Passed in the previous round; not judged again." });
  // Caught (§6.6): failed in round 1, passed in round 2 of the same card.
  expect(await x.entry("g1")).toMatchObject({ counts: { caught: 1, reviews: 2, passes: 1 } });
  expect((await x.entry("g1")).counts.lastCaughtAt).toBeTruthy();
  // A person's Rerun starts from round 1 with the whole diff.
  await x.reviews.rerun("t", x.paseo);
  await x.reviews.idle();
  expect(x.diffs.at(-1)).toBeUndefined();
});

test("disputes: only failed findings of the latest review, kept on the card, judged as disputed next time (§6.1, B7)", async () => {
  let seen: LlmReviewInput | undefined;
  let round = 0;
  const llm: LlmReview = async (input) => {
    seen = input;
    round++;
    return { model: "m", verdicts: input.checks.map((c) => ({ id: c.id, verdict: round === 1 && c.id === "g1" ? ("fail" as const) : ("pass" as const), detail: "d", file: "src/a.ts" })) };
  };
  const x = await setup({ entries: [command("tests", ["npm", "test"]), guideline("g1", "Rule one")], llm });
  await x.deliver("development");
  expect((await card(x)).review!.state).toBe("rework");
  await x.turnStarted();
  let ctx = await x.service.get(x.identity);
  // An id that did not fail, or a dispute without a delivery, is refused and nothing is stored.
  const bad = await x.service.write(x.identity, "status", { ...input(ctx, "Delivered"), status: "in_review", disputes: [{ id: "tests", reason: "no" }] }).catch((e) => e);
  expect(bad).toMatchObject({ code: "INVALID_INPUT" });
  expect(String(bad.message)).toContain("(g1)");
  const midWork = await x.service.write(x.identity, "status", { ...input(ctx), status: "test", disputes: [{ id: "g1", reason: "no" }] }).catch((e) => e);
  expect(midWork).toMatchObject({ code: "INVALID_INPUT" });
  expect((await card(x)).disputes).toBeUndefined();
  const before = (await card(x)).revision;
  const board = await x.deliver(undefined, { disputes: [{ id: "g1", reason: "This card does not touch UI text." }] });
  const task = board.tasks[0]!;
  expect(task.disputes).toEqual([{ id: "g1", kind: "guideline", name: "Rule one", reason: "This card does not touch UI text.", round: 1, at: expect.any(String) }]);
  // Not judged again: recorded as disputed with the agent's reason; the review passes.
  expect(seen!.checks.map((c) => c.id)).toEqual(["goal"]);
  expect(task.review!.items.find((i) => i.id === "g1")).toMatchObject({ state: "disputed", disputeReason: "This card does not touch UI text.", gating: true });
  expect(task.review).toMatchObject({ state: "passed", round: 2 });
  // The delivery's own revision bump only; the dispute itself adds none.
  expect(task.revision).toBe(before + 1);
  // A disputed finding is not "caught" when it later passes.
  expect((await x.entry("g1")).counts.caught).toBe(0);
  // Sending the same dispute again is idempotent (the reason is updated).
  await x.store.mutate((b) => {
    b.tasks[0]!.status = "development";
  });
  ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { ...input(ctx, "Again"), status: "in_review", disputes: [{ id: "g1", reason: "Still not UI." }] });
  await x.reviews.idle();
  expect((await card(x)).disputes).toEqual([expect.objectContaining({ id: "g1", reason: "Still not UI.", round: 1 })]);
  // Done: the dispute still stands, so it counts as a misfire and is cleared (§6.6).
  await x.guardrails.finishTask("t");
  expect((await x.entry("g1")).counts.misfire).toBe(1);
  expect((await card(x)).disputes).toBeUndefined();
});

test("signals at review end: reviews and passes counted; two misfires in 30 days pause a guideline with an event (§6.6, §6.7)", async () => {
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const x = await setup({ entries: [guideline("g1", "Rule one", { counts: { ...emptyCounts(), misfire: 2, misfireAt: [recent, recent] } }), guideline("g2", "Rule two")] });
  const board = await x.deliver("development");
  expect(board.tasks[0]!.review!.state).toBe("passed");
  expect(await x.entry("g1")).toMatchObject({ state: "paused", stateReason: "misfired twice in 30 days", counts: { reviews: 1, passes: 1 } });
  expect(await x.entry("g2")).toMatchObject({ state: "active", counts: { reviews: 1, passes: 1, caught: 0 } });
  const events = (await x.store.read()).events.filter((e) => e.action === "guardrail_retired");
  expect(events.map((e) => [e.taskId, e.guardrail])).toEqual([["t", { change: "paused", kind: "guideline", id: "g1" }]]);
  // A cancelled review judged nothing and counts nothing.
  const y = await setup({ entries: [command("tests", ["npm", "test"]), guideline("g3", "Rule three")] });
  y.setDuring(async () => {
    await y.store.mutate((b) => {
      b.workpads[0]!.revision++;
    });
  });
  expect((await y.deliver("development")).tasks[0]!.review!.state).toBe("cancelled");
  expect((await y.entry("g3")).counts.reviews).toBe(0);
  expect((await y.entry("tests")).counts.reviews).toBe(0);
});

test("a check the review session left out is unavailable; with the rest passing the review is Unavailable, no rework", async () => {
  const x = await setup({ entries: [guideline("g1", "Rule one")], llm: async () => ({ model: "m", verdicts: [{ id: "goal", verdict: "pass", detail: "Fine." }] }) });
  const board = await x.deliver("development");
  expect(board.tasks[0]).toMatchObject({ status: "in_review", review: { state: "unavailable", round: 1 } });
  expect(board.tasks[0]!.review!.items.map((r) => r.state)).toEqual(["passed", "unavailable"]);
  expect(x.sent).toEqual([]);
  // A failing review session makes every judged check unavailable.
  const y = await setup({ llm: async () => { throw new Error("model down"); } });
  const after = await y.deliver("development");
  expect(after.tasks[0]!.review!.items[1]).toMatchObject({ state: "unavailable", reason: "The review session failed: model down" });
});

test("the delivery's shape from git --numstat: files, changed lines (binary 0), size band, renames (§6.2)", () => {
  const { shape, paths } = numstatShape("3\t2\tsrc/a.ts\n-\t-\tlogo.png\n", "40\t10\tsrc/{old => new}/b.ts\n1\t0\tsrc/a.ts\n");
  expect(shape).toEqual({ files: 3, lines: 56, size: "m" });
  expect([...paths].sort()).toEqual(["logo.png", "src/a.ts", "src/new/b.ts"]);
  expect(numstatShape("").shape).toEqual({ files: 0, lines: 0, size: "s" });
  expect(numstatShape("500\t1\tbig.ts").shape.size).toBe("l");
  expect(repoPath("/w", "./src/a.ts")).toBe("src/a.ts");
  expect(repoPath("/w", "/w/src/a.ts")).toBe("src/a.ts");
  expect(repoPath("/w", "../x.ts")).toBeNull();
  expect(repoPath("/w", "/etc/passwd")).toBeNull();
});

test("a worktree card's base ref reaches the shape and the review diff (§6.2)", async () => {
  const x = await setup({ baseRef: "refs/heads/main" });
  await x.deliver("development");
  expect(x.bases).toEqual(["refs/heads/main", "refs/heads/main"]);
});

/** A fake git that records each call's argv; `answers` maps an argv to its output, an Error to throw, or a `git diff --no-index` exit 1. */
function recordingGit(answers: Record<string, string | Error | { exit1: string }>) {
  const calls: string[] = [];
  const git: Git = async (_cwd, args) => {
    const key = args.join(" ");
    calls.push(key);
    const answer = answers[key] ?? "";
    if (answer instanceof Error) throw answer;
    if (typeof answer === "object") throw Object.assign(new Error("exit 1"), { code: 1, stdout: answer.exit1 });
    return answer;
  };
  return { git, calls };
}
const base = "0123456789abcdef0123456789abcdef01234567";
const untracked = "ls-files --others --exclude-standard -z";

test("shape: a worktree card counts its own change since the merge-base plus untracked files, text by lines and binary 0 (§6.2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowly-shape-"));
  roots.push(dir);
  await writeFile(join(dir, "fixture.txt"), Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n"));
  await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x0a]));
  // Over 1 MiB: one file, 0 lines, not read.
  await writeFile(join(dir, "dump.log"), "x\n".repeat(600_000));
  const { git, calls } = recordingGit({
    "merge-base refs/heads/main HEAD": `${base}\n`,
    [`diff ${base} --numstat`]: "3\t2\tsrc/a.ts\n",
    [untracked]: "fixture.txt\0logo.png\0dump.log\0",
  });
  const measured = await reviewShape(dir, "refs/heads/main", git);
  expect(calls).toEqual(["merge-base refs/heads/main HEAD", `diff ${base} --numstat`, untracked]);
  expect(measured!.shape).toEqual({ files: 4, lines: 455, size: "l" });
  expect([...measured!.paths].sort()).toEqual(["dump.log", "fixture.txt", "logo.png", "src/a.ts"]);
});

test("shape: a directory card, or a base ref git cannot resolve, keeps git diff HEAD plus the last five commits, with untracked files (§6.2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowly-shape-"));
  roots.push(dir);
  await writeFile(join(dir, "new.ts"), "a\nb\n");
  const answers = { "diff HEAD --numstat": "1\t1\tsrc/a.ts\n", "log -5 --numstat --format=": "10\t0\tsrc/b.ts\n", [untracked]: "new.ts\0" };
  const directory = recordingGit(answers);
  expect((await reviewShape(dir, undefined, directory.git))!.shape).toEqual({ files: 3, lines: 14, size: "s" });
  expect(directory.calls).toEqual(["diff HEAD --numstat", "log -5 --numstat --format=", untracked]);
  const failed = recordingGit({ ...answers, "merge-base gone HEAD": new Error("fatal: Not a valid object name gone") });
  expect((await reviewShape(dir, "gone", failed.git))!.shape).toEqual({ files: 3, lines: 14, size: "s" });
  expect(failed.calls).toEqual(["merge-base gone HEAD", "diff HEAD --numstat", "log -5 --numstat --format=", untracked]);
});

test("review diff: the card's branch since the merge-base, then untracked files under their own heading; round 2 adds them too (§6.3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowly-diff-"));
  roots.push(dir);
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs/new.md"), "hello\n");
  await writeFile(join(dir, "dump.log"), "x".repeat((1 << 20) + 1));
  const answers = {
    "merge-base main HEAD": `${base}\n`,
    [`diff ${base} --no-color`]: "diff --git a/src/a.ts b/src/a.ts\n",
    "diff aaaaaaaaaaaa --no-color": "diff --git a/src/c.ts b/src/c.ts\n",
    [untracked]: "docs/new.md\0dump.log\0",
    "diff --no-index --no-color -- /dev/null docs/new.md": { exit1: "diff --git a/docs/new.md b/docs/new.md\n+hello\n" },
  };
  const worktree = recordingGit(answers);
  const text = await reviewDiff(dir, { baseRef: "main" }, worktree.git);
  expect(worktree.calls).toEqual(["merge-base main HEAD", `diff ${base} --no-color`, untracked, "diff --no-index --no-color -- /dev/null docs/new.md"]);
  expect(text).toContain(`# Changes on this card's branch (git diff ${base})\ndiff --git a/src/a.ts`);
  expect(text).toContain("# New files (untracked)\ndiff --git a/docs/new.md b/docs/new.md\n+hello");
  expect(text).not.toContain("# Recent commits");
  // Over 1 MiB: named, never diffed.
  expect(text).toContain("new file dump.log (over 1 MiB or unreadable, not shown)");
  const round2 = recordingGit(answers);
  const later = await reviewDiff(dir, { since: "aaaaaaaaaaaa", baseRef: "main" }, round2.git);
  expect(round2.calls).toEqual(["diff aaaaaaaaaaaa --no-color", untracked, "diff --no-index --no-color -- /dev/null docs/new.md"]);
  expect(later).toContain("# New files (untracked)\ndiff --git a/docs/new.md");
  // A directory card: uncommitted changes and the last five commits, then the new files.
  const directory = recordingGit(answers);
  expect(await reviewDiff(dir, {}, directory.git)).toContain("# Recent commits\n\n# New files (untracked)\ndiff --git a/docs/new.md");
  expect(directory.calls.slice(0, 3)).toEqual(["diff HEAD --no-color", "log -5 -p --no-color --format=commit %h %s", untracked]);
});

/** Two Git repositories behind symlinks in a plain folder, like a linked root (PROJECT-PICKER-SPEC), each with one commit. */
async function linkedRoot() {
  const base = await mkdtemp(join(tmpdir(), "flowly-linked-"));
  roots.push(base);
  const git = (cwd: string, ...args: string[]) => defaultGit(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
  for (const name of ["admin", "smith"]) {
    const repo = join(base, "repos", name);
    await mkdir(join(repo, "src"), { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "src/app.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: name === "smith" ? { test: "vitest", typecheck: "tsc" } : { test: "jest" } }));
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  }
  const root = join(base, "root");
  await mkdir(root);
  await symlink(join(base, "repos/admin"), join(root, "Admin"), "dir");
  await symlink(join(base, "repos/smith"), join(root, "SMITH"), "dir");
  await mkdir(join(root, "notes"));
  await mkdir(join(root, ".hidden"));
  return { base, root, git };
}

test("linked root: the repositories behind its links, then each one's change with its paths under the link's name (§6.2)", async () => {
  const { root, base } = await linkedRoot();
  const repos = await linkedRepos(root);
  expect(repos).toEqual([
    { name: "Admin", directory: join(root, "Admin") },
    { name: "SMITH", directory: join(root, "SMITH") },
  ]);
  // A Git repository itself is not a linked root's child list; a folder without .git is skipped.
  expect(await readHeadOf(root)).toBeNull();
  await writeFile(join(base, "repos/smith/src/app.ts"), "export const a = 2;\nexport const b = 3;\n");
  await writeFile(join(base, "repos/smith/src/new.ts"), "x\ny\n");
  const shape = await linkedShape(repos);
  // Both repositories' last commits count, as for any directory card (D6), plus SMITH's edit and new file.
  expect(shape!.paths).toEqual(new Set(["Admin/package.json", "Admin/src/app.ts", "SMITH/package.json", "SMITH/src/app.ts", "SMITH/src/new.ts"]));
  expect(shape!.shape.files).toBe(5);
  expect(shape!.shape.lines).toBeGreaterThan(0);
  const diff = await linkedReviewDiff(repos);
  expect(diff).toContain("## Repository Admin (its paths start with Admin/)");
  expect(diff).toContain("## Repository SMITH (its paths start with SMITH/)");
  expect(diff).toContain("diff --git a/SMITH/src/app.ts b/SMITH/src/app.ts");
  expect(diff).toContain("+export const b = 3;");
  expect(diff).toContain("+++ b/SMITH/src/new.ts");
  expect(diff).not.toMatch(/a\/src\/app\.ts/);
  // Round 2: each repository since its own previous commit; a new commit in one changes the digest.
  const first = await linkedHead(repos, defaultGit);
  expect(Object.keys(first.repos)).toEqual(["Admin", "SMITH"]);
  expect(first.head).toMatchObject({ dirty: true });
  expect(first.head!.sha).toMatch(/^[0-9a-f]{12}$/);
  await writeFile(join(base, "repos/admin/src/app.ts"), "export const a = 9;\n");
  const later = await linkedReviewDiff(repos, { since: first.repos });
  expect(later).toContain(`# Changes since the previous delivery (git diff ${first.repos.Admin})`);
  expect(later).toContain("diff --git a/Admin/src/app.ts b/Admin/src/app.ts");
}, 20_000);
const readHeadOf = async (dir: string) => (await linkedHead([{ name: "root", directory: dir }], defaultGit)).head;

test("linked root: a command runs where its script is, and applies nowhere else (§6.3)", async () => {
  const { root } = await linkedRoot();
  expect(await commandApplies(["npm", "run", "typecheck"], join(root, "SMITH"))).toBe(true);
  expect(await commandApplies(["npm", "run", "typecheck"], join(root, "Admin"))).toBe(false);
  expect(await commandApplies(["npm", "test"], join(root, "Admin"))).toBe(true);
  expect(await commandApplies(["npm", "ci"], join(root, "Admin"))).toBe(true);
  expect(await commandApplies(["npm", "test"], join(root, "notes"))).toBe(false);
  expect(await commandApplies(["make", "check"], join(root, "SMITH"))).toBe(false);
  expect(await commandApplies(["go", "test", "./..."], join(root, "SMITH"))).toBe(false);
  expect(await commandApplies(["./scripts/check.sh"], join(root, "SMITH"))).toBe(true);
  await writeFile(join(root, "SMITH", "Makefile"), "build:\n\ttrue\ncheck: build ## all\n\ttrue\n");
  expect(await commandApplies(["make", "check"], join(root, "SMITH"))).toBe(true);
  expect(await commandApplies(["make", "-j", "4", "lint"], join(root, "SMITH"))).toBe(false);
}, 20_000);

test("linked root review: shape from both repositories, commands per repository, any failure fails, a cited file under a link counts (§6.2, §6.3)", async () => {
  const { root, base } = await linkedRoot();
  await writeFile(join(base, "repos/smith/src/app.ts"), "export const a = 2;\n");
  const seen: LlmReviewInput[] = [];
  const cwds: string[] = [];
  const x = await setup({
    directory: root,
    run: async (argv, cwd) => (cwds.push(`${argv.join(" ")} @ ${cwd.split("/").pop()}`), { exitCode: 0, timedOut: false, ms: 2, output: "" }),
    git: defaultGit,
    entries: [command("tests", ["npm", "test"]), command("types", ["npm", "run", "typecheck"]), command("make", ["make", "check"])],
    exists: async (path) => existsSync(path),
    llm: async (input) => {
      seen.push(input);
      return { model: "claude/haiku", verdicts: [{ id: "goal", verdict: "fail", detail: "Still returns 1 in Admin.", file: "Admin/src/app.ts", line: 1 }] };
    },
  });
  const board = await x.deliver("development");
  const review = board.tasks[0]!.review!;
  // Admin is untouched (its only commit predates the card): only SMITH runs the commands.
  expect(cwds).toEqual(["npm test @ SMITH", "npm run typecheck @ SMITH"]);
  expect(review.items.find((i) => i.id === "tests")).toMatchObject({ state: "passed", ms: 2, detail: "Ran in SMITH." });
  expect(review.items.find((i) => i.id === "make")).toMatchObject({ state: "skipped", reason: "No repository this delivery changed has this command." });
  expect(review.shape!.files).toBeGreaterThan(0);
  expect(review.fingerprint.repos).toEqual({ Admin: expect.stringMatching(/^[0-9a-f]{12}$/), SMITH: expect.stringMatching(/^[0-9a-f]{12}$/) });
  expect(seen[0]!.diff).toContain("diff --git a/SMITH/src/app.ts b/SMITH/src/app.ts");
  // The finding cites a file in a linked repository: evidence, so it fails and the rework message names it.
  expect(review.items.find((i) => i.id === "goal")).toMatchObject({ state: "failed", file: "Admin/src/app.ts" });
  expect(x.sent.at(-1)!.text).toContain("Admin/src/app.ts:1");
}, 20_000);

test("linked root review: a command that fails in one repository fails, with that repository's output", async () => {
  const { root, base } = await linkedRoot();
  await writeFile(join(base, "repos/admin/src/app.ts"), "export const a = 2;\n");
  await writeFile(join(base, "repos/smith/src/app.ts"), "export const a = 2;\n");
  const x = await setup({
    directory: root,
    git: defaultGit,
    run: async (_argv, cwd) => (cwd.endsWith("SMITH") ? { exitCode: 1, timedOut: false, ms: 3, output: "FAIL smith.test.ts\n" } : { exitCode: 0, timedOut: false, ms: 2, output: "" }),
  });
  const review = (await x.deliver("development")).tasks[0]!.review!;
  expect(review.items.find((i) => i.id === "tests")).toMatchObject({ state: "failed", exitCode: 1, ms: 5, detail: "Ran in Admin, SMITH." });
  expect(review.items.find((i) => i.id === "tests")!.tail).toContain("[SMITH]");
  expect(review.items.find((i) => i.id === "goal")).toMatchObject({ state: "skipped" });
}, 20_000);

test("linked root: commands run only in the repositories this delivery changed, all of them when none did (§6.3)", async () => {
  const { root, base, git } = await linkedRoot();
  const repos = await linkedRepos(root);
  const since = new Date(Date.now() + 1000).toISOString();
  expect((await changedRepos(repos, since)).map((r) => r.name)).toEqual(["Admin", "SMITH"]);
  await writeFile(join(base, "repos/smith/src/new.ts"), "x\n");
  expect((await changedRepos(repos, since)).map((r) => r.name)).toEqual(["SMITH"]);
  // A commit after the card was created counts, though the tree is clean again.
  await git(join(base, "repos/smith"), "add", ".");
  await git(join(base, "repos/smith"), "commit", "-q", "-m", "work");
  expect((await changedRepos(repos, new Date(Date.now() - 60_000).toISOString())).map((r) => r.name)).toEqual(["Admin", "SMITH"]);
  expect((await changedRepos(repos, since)).map((r) => r.name)).toEqual(["Admin", "SMITH"]);
  const failing: Git = async (cwd, args) => (cwd.endsWith("Admin") ? Promise.reject(new Error("not a repo")) : defaultGit(cwd, args));
  expect((await changedRepos(repos, since, failing)).map((r) => r.name)).toEqual(["Admin"]);
}, 20_000);

test("linked root diff: a large change in one repository cannot push the others out of the 64 KiB (§6.2)", async () => {
  const { root, base } = await linkedRoot();
  await writeFile(join(base, "repos/admin/src/app.ts"), Array.from({ length: 20_000 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
  await writeFile(join(base, "repos/smith/src/app.ts"), "export const a = 2;\n");
  const diff = await linkedReviewDiff(await linkedRepos(root));
  expect(diff.length).toBeLessThanOrEqual(64 * 1024 + 100);
  expect(diff).toContain("[Admin: diff truncated]");
  expect(diff).toContain("## Repository SMITH (its paths start with SMITH/)");
  expect(diff).toContain("diff --git a/SMITH/src/app.ts b/SMITH/src/app.ts");
}, 20_000);
