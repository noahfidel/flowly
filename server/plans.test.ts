import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFixture } from "./agent-fixture";
import { ArtifactService } from "./artifacts";
import { PlanModeWatcher, PlanService, setPlan, type PlanRequestEntry } from "./plans";
import { planOf } from "../shared/plans";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  await mkdir(join(f.a, "docs"));
  await writeFile(join(f.a, "docs", "plan.md"), "# First plan\n");
  await writeFile(join(f.a, "docs", "next.md"), "# Second plan\n");
  await mkdir(join(f.root, "outside"));
  await writeFile(join(f.root, "outside", "plan.md"), "# Elsewhere\n");
  const artifacts = new ArtifactService(f.store);
  return { ...f, artifacts, plans: new PlanService(f.store, artifacts) };
}
const card = async (x: Awaited<ReturnType<typeof setup>>) => (await x.store.read()).artifacts.filter((a) => a.taskId === "t");

test("plans.set adds a new approved input, board revision only, events and actor human", async () => {
  const x = await setup();
  const before = await x.store.read();
  const plan = await x.plans.set({ taskId: "t", target: "docs/plan.md", title: "Ship the thing" }, x.paseo);
  expect(plan).toMatchObject({ role: "input", target: "./docs/plan.md", title: "Ship the thing", createdBy: "human", plan: { source: "manual", approvedBy: { kind: "human" } } });
  expect(plan.plan!.approvedAt).toBeTruthy();
  const board = await x.store.read();
  expect(board.revision).toBe(before.revision + 1);
  expect(board.tasks[0].revision).toBe(before.tasks[0].revision);
  expect(board.events.slice(-2).map((e) => [e.action, e.actor, e.note])).toEqual([
    ["artifact_added", "human", "Input: Ship the thing"],
    ["plan_set", "human", "Approved: Ship the thing"],
  ]);
});

test("an existing artifact becomes the plan and keeps its role; replacing keeps the old one as an ordinary artifact", async () => {
  const x = await setup();
  const out = await x.artifacts.create({ taskId: "t", role: "output", target: "docs/plan.md" }, x.paseo);
  const first = await x.plans.set({ taskId: "t", target: "docs/plan.md" }, x.paseo);
  expect(first).toMatchObject({ id: out.id, role: "output" });
  const second = await x.plans.set({ taskId: "t", target: "docs/next.md" }, x.paseo);
  const list = await card(x);
  expect(list.filter((a) => a.plan).map((a) => a.id)).toEqual([second.id]);
  expect(list.find((a) => a.id === out.id)).toMatchObject({ role: "output" });
  expect(list.find((a) => a.id === out.id)!.plan).toBeUndefined();
  expect(planOf(list, "t")!.id).toBe(second.id);
});

test("approve and clear; no un-approve; the same target only updates approval", async () => {
  const x = await setup();
  await x.store.transaction((board) => ({
    value: setPlan(x.store, board, { taskId: "t", kind: "file", target: "./docs/plan.md", approved: false, by: { kind: "agent", agentId: "actor" }, source: "tool" }),
    changed: true,
  }));
  let plan = planOf(await card(x), "t")!;
  expect(plan.plan).toMatchObject({ approvedAt: null, source: "tool" });
  expect(plan.plan.approvedBy).toBeUndefined();
  expect(plan.createdBy).toBe("agent");
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "plan_set", actor: "agent", agentId: "actor", note: "Draft: plan.md" });
  // Same target with approved=true approves the draft.
  await x.store.transaction((board) => ({
    value: setPlan(x.store, board, { taskId: "t", kind: "file", target: "./docs/plan.md", approved: true, by: { kind: "agent", agentId: "actor" }, source: "tool" }),
    changed: true,
  }));
  plan = planOf(await card(x), "t")!;
  expect(plan.plan).toMatchObject({ approvedBy: { kind: "agent", agentId: "actor" } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "plan_approved", note: "plan.md" });
  // approved=false never un-approves.
  const revision = (await x.store.read()).revision;
  await x.store.transaction((board) => {
    const r = setPlan(x.store, board, { taskId: "t", kind: "file", target: "./docs/plan.md", approved: false, by: { kind: "human" }, source: "manual" });
    return { value: r, changed: r.changed };
  });
  expect(planOf(await card(x), "t")!.plan.approvedAt).toBe(plan.plan.approvedAt);
  expect((await x.store.read()).revision).toBe(revision);
  // plans.approve on an approved plan: no change; clear empties the slot and keeps the artifact.
  await x.plans.approve({ taskId: "t" });
  expect((await x.store.read()).revision).toBe(revision);
  expect(await x.plans.clear({ taskId: "t" })).toBeNull();
  expect(planOf(await card(x), "t")).toBeNull();
  expect(await card(x)).toHaveLength(1);
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "plan_cleared", actor: "human", note: "plan.md" });
  await expect(x.plans.approve({ taskId: "t" })).rejects.toThrow("This card has no plan.");
  // Clear with no plan: no change.
  const after = (await x.store.read()).revision;
  await x.plans.clear({ taskId: "t" });
  expect((await x.store.read()).revision).toBe(after);
});

test("a review ledger can't be the plan; archived cards refuse; targets outside are refused", async () => {
  const x = await setup();
  const ledger = await x.artifacts.create({ taskId: "t", role: "output", target: "docs/next.md" }, x.paseo);
  await x.store.mutate((b) => void (b.artifacts.find((a) => a.id === ledger.id)!.origin = "review-ledger"));
  await expect(x.plans.set({ taskId: "t", target: "docs/next.md" }, x.paseo)).rejects.toThrow("A review ledger can't be the plan.");
  await expect(x.plans.set({ taskId: "t", target: join(x.root, "outside", "plan.md") }, x.paseo)).rejects.toThrow("outside this card's directories");
  await x.store.mutate((b) => void (b.tasks[0].archivedAt = new Date().toISOString()));
  await expect(x.plans.set({ taskId: "t", target: "docs/plan.md" }, x.paseo)).rejects.toThrow("Archived cards can't be changed.");
});

test("deleting the plan artifact empties the slot and records plan_cleared", async () => {
  const x = await setup();
  const plan = await x.plans.set({ taskId: "t", target: "docs/plan.md" }, x.paseo);
  await x.artifacts.delete({ id: plan.id });
  const board = await x.store.read();
  expect(board.artifacts).toHaveLength(0);
  expect(board.events.slice(-2).map((e) => e.action)).toEqual(["plan_cleared", "artifact_removed"]);
});

const entry = (x: Awaited<ReturnType<typeof setup>>, request: { id: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }, allow = true, identity: { agentId: string; taskId: string } | null = { agentId: "actor", taskId: "t" }) => {
  const watcher = new PlanModeWatcher((e: PlanRequestEntry) => x.plans.fromPlanMode(e, x.paseo));
  watcher.before(identity, { kind: "plan", ...request });
  return watcher.after("actor", request.id, { behavior: allow ? "allow" : "deny" });
};

test("plan mode: an allowed request with a path inside the roots points at it", async () => {
  const x = await setup();
  await entry(x, { id: "r1", input: { plan: "# Rework the store\nsteps", planFilePath: join(x.a, "docs", "plan.md") } });
  const plan = planOf(await card(x), "t")!;
  expect(plan).toMatchObject({ target: "./docs/plan.md", title: "Rework the store", createdBy: "human", plan: { source: "plan-mode", approvedBy: { kind: "human" } } });
  expect((await x.store.read()).events.at(-1)).toMatchObject({ action: "plan_set", actor: "human" });
});

test("plan mode: a path outside, or none, saves a copy under plans/<taskId>/ that stays inside the card's roots", async () => {
  const x = await setup();
  await entry(x, { id: "r1", input: { plan: "# Outside plan\nbody", planFilePath: join(x.root, "outside", "plan.md") } });
  const folder = join(x.store.directory, "plans", "t");
  const files = await readdir(folder);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/);
  expect(await readFile(join(folder, files[0]), "utf8")).toBe("# Outside plan\nbody\n");
  expect((await stat(folder)).mode & 0o777).toBe(0o700);
  expect((await stat(join(folder, files[0]))).mode & 0o777).toBe(0o600);
  let plan = planOf(await card(x), "t")!;
  expect(plan).toMatchObject({ target: join(folder, files[0]), title: "Outside plan" });
  expect((await x.artifacts.status({ taskId: "t" }, x.paseo)).missing).toEqual([]);
  expect(await x.artifacts.preview({ id: plan.id }, x.paseo)).toMatchObject({ type: "text", markdown: true });
  // A later approval (no path) replaces it; the first stays an ordinary input.
  await entry(x, { id: "r2", input: { plan: "No heading here" } });
  plan = planOf(await card(x), "t")!;
  expect(plan.title).toBe("Plan");
  expect(await card(x)).toHaveLength(2);
  expect((await readdir(folder)).length).toBe(2);
});

test("plan mode: deny, a non-card session, empty text without a path, or a non-plan request set nothing", async () => {
  const x = await setup();
  await entry(x, { id: "r1", input: { plan: "# Keep planning" } }, false);
  await entry(x, { id: "r2", input: { plan: "# Not a card" } }, true, null);
  await entry(x, { id: "r3", input: { plan: "  " } });
  const watcher = new PlanModeWatcher((e) => x.plans.fromPlanMode(e, x.paseo));
  watcher.before({ agentId: "actor", taskId: "t" }, { id: "r4", kind: "tool", input: { plan: "# Tool" } });
  await watcher.after("actor", "r4", { behavior: "allow" });
  // Another session answering the id does not count.
  watcher.before({ agentId: "actor", taskId: "t" }, { id: "r5", kind: "plan", input: { plan: "# Mine" } });
  await watcher.after("second", "r5", { behavior: "allow" });
  expect(watcher.size).toBe(0);
  expect(await card(x)).toEqual([]);
});

test("plan mode watcher keeps at most 200 requests and drops them after 24 h", async () => {
  let now = 0;
  const applied: string[] = [];
  const watcher = new PlanModeWatcher(async (e) => void applied.push(e.text), () => now);
  for (let i = 0; i < 205; i++) watcher.before({ agentId: "a", taskId: "t" }, { id: `r${i}`, kind: "plan", input: { plan: `p${i}` } });
  expect(watcher.size).toBe(200);
  await watcher.after("a", "r0", { behavior: "allow" });
  expect(applied).toEqual([]);
  now = 25 * 3600 * 1000;
  await watcher.after("a", "r204", { behavior: "allow" });
  expect(applied).toEqual([]);
  // A failing apply never throws out of the hook.
  const failing = new PlanModeWatcher(async () => {
    throw new Error("boom");
  });
  failing.before({ agentId: "a", taskId: "t" }, { id: "x", kind: "plan", input: { plan: "# p" } });
  await expect(failing.after("a", "x", { behavior: "allow" })).resolves.toBeUndefined();
});
