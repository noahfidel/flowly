import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { emptyBoard, type Board } from "../shared/model";

const directories: string[] = [];
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "ultra-kanban-test-"));
  directories.push(path);
  return new BoardStore(path);
}
function fixture(): Board {
  const b = emptyBoard(),
    now = new Date().toISOString();
  b.projects.push({
    id: "p1",
    paseoProjectId: "native1",
    title: "Fixture",
    description: "",
    primaryPath: "/repo1",
    repos: ["/repo1", "/repo2"],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  b.tasks.push({
    id: "t1",
    projectId: "p1",
    workspaceId: "w1",
    sourcePath: "/repo1",
    repoPaths: [],
    title: "Task",
    description: "",
    status: "todo",
    priority: "normal",
    position: 0,
    revision: 1,
    operationId: "op1",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return b;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("board durability and business invariants", () => {
  test("task type is optional, set and cleared by edits, and kept by unrelated edits", async () => {
    const s = await setup();
    await writeFile(s.path, JSON.stringify({ ...fixture(), version: 4, agentReceipts: [] }));
    expect((await s.read()).tasks[0].type).toBeUndefined();
    await s.editTask({ id: "t1", revision: 1, type: "bugfix", actor: "human" });
    await s.editTask({ id: "t1", revision: 2, title: "Renamed", actor: "human" });
    expect((await s.read()).tasks[0]).toMatchObject({ type: "bugfix", title: "Renamed", revision: 3 });
    await s.editTask({ id: "t1", revision: 3, type: null, actor: "human" });
    const stored = JSON.parse(await readFile(s.path, "utf8")).tasks[0];
    expect("type" in stored).toBe(false);
  });
  test("delivery mode is editable until the card delivers, then fixed (DELIVERY-MODE-SPEC §2)", async () => {
    const s = await setup();
    const board = fixture();
    (board.tasks[0] as { deliveryMode?: string }).deliveryMode = "from_the_future";
    await writeFile(s.path, JSON.stringify({ ...board, version: 4, agentReceipts: [] }));
    // An edit that does not touch it keeps an unknown stored value.
    await s.editTask({ id: "t1", revision: 1, title: "Renamed", actor: "human" });
    expect((await s.read()).tasks[0].deliveryMode).toBe("from_the_future");
    await s.editTask({ id: "t1", revision: 2, deliveryMode: "draft_pr", actor: "human" });
    expect((await s.read()).tasks[0]).toMatchObject({ deliveryMode: "draft_pr", revision: 3 });
    for (const [revision, status] of [[3, "in_review"], [5, "committed"], [7, "integrated"]] as const) {
      await s.editTask({ id: "t1", revision, status, actor: "human" });
      await expect(s.editTask({ id: "t1", revision: revision + 1, deliveryMode: "ready_pr", actor: "human" })).rejects.toThrow(
        "The delivery mode can't be changed once the card has been in review, committed or integrated.",
      );
      // Sending the stored value again is no change and passes.
      await s.editTask({ id: "t1", revision: revision + 1, deliveryMode: "draft_pr", actor: "human" });
    }
    const delivered = (await s.read()).tasks[0];
    expect(delivered.deliveryMode).toBe("draft_pr");
    expect(typeof delivered.deliveredAt).toBe("string");
    // Moved back out of delivery, it stays fixed (ruling 2026-11-09), and the first delivery time is kept.
    await s.editTask({ id: "t1", revision: 9, status: "development", actor: "human" });
    await expect(s.editTask({ id: "t1", revision: 10, deliveryMode: "branch", actor: "human" })).rejects.toThrow(
      "The delivery mode can't be changed once the card has been in review, committed or integrated.",
    );
    expect((await s.read()).tasks[0]).toMatchObject({ deliveryMode: "draft_pr", deliveredAt: delivered.deliveredAt, status: "development" });
  });
  test("every write into a delivery lane marks the card delivered, a drag and a rule's change included (DELIVERY-MODE-SPEC §2)", async () => {
    const s = await setup();
    await writeFile(s.path, JSON.stringify({ ...fixture(), version: 4, agentReceipts: [] }));
    const before = (await s.read()).tasks[0];
    expect(before.deliveredAt).toBeUndefined();
    await s.placeTask({ id: "t1", revision: before.revision, status: "in_review", beforeId: null, afterId: null });
    await s.placeTask({ id: "t1", revision: before.revision + 1, status: "development", beforeId: null, afterId: null });
    await expect(s.editTask({ id: "t1", revision: before.revision + 2, deliveryMode: "ready_pr", actor: "human" })).rejects.toThrow(
      "once the card has been in review",
    );
    // A status set by any other writer (a status rule, an agent tool) goes through the same commit.
    const s2 = await setup();
    await writeFile(s2.path, JSON.stringify({ ...fixture(), version: 4, agentReceipts: [] }));
    await s2.mutate((board) => {
      board.tasks[0].status = "committed";
    });
    await s2.mutate((board) => {
      board.tasks[0].status = "todo";
    });
    expect(typeof (await s2.read()).tasks[0].deliveredAt).toBe("string");
    // A card that has never delivered stays editable.
    const s3 = await setup();
    await writeFile(s3.path, JSON.stringify({ ...fixture(), version: 4, agentReceipts: [] }));
    await s3.editTask({ id: "t1", revision: 1, deliveryMode: "ready_pr", actor: "human" });
    expect((await s3.read()).tasks[0]).toMatchObject({ deliveryMode: "ready_pr" });
    expect((await s3.read()).tasks[0].deliveredAt).toBeUndefined();
  });
  test("v2 migration preserves selected scope/history, waits for a commit, and backs up the source", async () => {
    const s = await setup(),
      old = { ...fixture(), version: 2 };
    old.tasks[0].repoPaths = ["/repo2"];
    const source = JSON.stringify(old);
    await writeFile(s.path, source);
    expect((await s.read()).tasks[0].repoPaths).toEqual(["/repo2"]);
    expect(await readFile(s.path, "utf8")).toBe(source);
    await s.transaction(() => ({
      value: "read-only transaction",
      changed: false,
    }));
    expect(await readFile(s.path, "utf8")).toBe(source);
    await s.editTask({
      id: "t1",
      revision: 1,
      title: "Migrated",
      actor: "human",
    });
    expect((await new BoardStore(s.directory).read()).version).toBe(5);
    expect(await readFile(s.path + ".bak", "utf8")).toBe(source);
    expect((await s.read()).agentReceipts).toEqual([]);
  });
  test("v3 → v4 splits In progress: cards to Development, lanes expanded in place, history kept, pre-v4 copy once", async () => {
    const s = await setup(),
      old = { ...fixture(), version: 3, agentReceipts: [] } as unknown as Board;
    (old.tasks[0] as { status: string }).status = "in_progress";
    (old.projects[0] as Record<string, unknown>).lanes = [
      { status: "backlog", enabled: false },
      { status: "todo", enabled: true },
      { status: "in_progress", enabled: true, name: "Doing" },
      { status: "in_review", enabled: true },
      { status: "blocked", enabled: false },
      { status: "done", enabled: true },
      { status: "cancelled", enabled: true },
    ];
    old.events = [{ id: "e1", taskId: "t1", actor: "human", action: "status_changed", from: "todo", to: "in_progress", at: old.tasks[0].createdAt } as never];
    const source = JSON.stringify(old);
    await writeFile(s.path, source);
    const read = await s.read();
    expect(read.version).toBe(5);
    expect(read.tasks[0]).toMatchObject({ status: "development", revision: 1 });
    expect(read.projects[0].lanes).toEqual([
      { status: "backlog", enabled: false },
      { status: "todo", enabled: true },
      { status: "design", enabled: true },
      { status: "development", enabled: true, name: "Doing" },
      { status: "test", enabled: true },
      { status: "in_review", enabled: true },
      // Lanes stored before Committed get it after In review, and Integrated after it (COMMITTED-STAGE-SPEC §2, INTEGRATED-STAGE-SPEC §2).
      { status: "committed", enabled: true },
      { status: "integrated", enabled: true },
      { status: "blocked", enabled: false },
      { status: "done", enabled: true },
      { status: "cancelled", enabled: true },
    ]);
    expect(read.events[0]).toMatchObject({ from: "todo", to: "in_progress" });
    expect(await readFile(s.path, "utf8")).toBe(source);
    expect(await readFile(join(s.directory, "board.pre-v4.json"), "utf8")).toBe(source);
    await s.editTask({ id: "t1", revision: 1, title: "Migrated", actor: "human" });
    expect(JSON.parse(await readFile(s.path, "utf8"))).toMatchObject({ version: 5, tasks: [{ status: "development" }] });
    expect(await readFile(join(s.directory, "board.pre-v4.json"), "utf8")).toBe(source);
  });
  test("v5 lanes stored before Committed read with it after In review and Integrated after it; reading rewrites nothing, the next write stores them", async () => {
    const s = await setup(),
      old = { ...fixture(), agentReceipts: [] };
    const lanes = ["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"].map((status) => ({ status, enabled: status !== "backlog", ...(status === "in_review" ? { name: "QA" } : {}) }));
    (old.projects[0] as Record<string, unknown>).lanes = lanes;
    const source = JSON.stringify(old);
    await writeFile(s.path, source);
    const read = await s.read();
    expect(read.projects[0].lanes!.map((l) => l.status)).toEqual(["backlog", "todo", "design", "development", "test", "in_review", "committed", "integrated", "blocked", "done", "cancelled"]);
    expect(read.projects[0].lanes![5]).toEqual({ status: "in_review", enabled: true, name: "QA" });
    expect(read.projects[0].lanes![6]).toEqual({ status: "committed", enabled: true });
    expect(read.projects[0].lanes![7]).toEqual({ status: "integrated", enabled: true });
    expect(await readFile(s.path, "utf8")).toBe(source);
    await s.editTask({ id: "t1", revision: 1, status: "committed", actor: "human" });
    const saved = JSON.parse(await readFile(s.path, "utf8"));
    expect(saved.projects[0].lanes).toHaveLength(11);
    expect(saved.tasks[0].status).toBe("committed");
  });
  test("v5 lanes stored with Committed read with Integrated right after it, Committed's name and switch kept (INTEGRATED-STAGE-SPEC §2)", async () => {
    const s = await setup(),
      old = { ...fixture(), agentReceipts: [] };
    const lanes = ["backlog", "todo", "design", "development", "test", "in_review", "committed", "blocked", "done", "cancelled"].map((status) => ({ status, enabled: status !== "committed", ...(status === "committed" ? { name: "Landed" } : {}) }));
    (old.projects[0] as Record<string, unknown>).lanes = lanes;
    const source = JSON.stringify(old);
    await writeFile(s.path, source);
    const read = await s.read();
    expect(read.projects[0].lanes!.slice(6, 8)).toEqual([{ status: "committed", enabled: false, name: "Landed" }, { status: "integrated", enabled: true }]);
    expect(await readFile(s.path, "utf8")).toBe(source);
    await s.editTask({ id: "t1", revision: 1, status: "integrated", actor: "human" });
    const saved = JSON.parse(await readFile(s.path, "utf8"));
    expect(saved.projects[0].lanes).toHaveLength(11);
    expect(saved.tasks[0].status).toBe("integrated");
  });
  test("v4 → v5 renames the artifact field ticket to external, keeps everything else, pre-v5 copy once (CONNECTORS-SPEC §3.1)", async () => {
    const s = await setup();
    const ticket = { connectionId: "c", provider: "jira-dc", key: "AB-1", remoteId: "10001" };
    const artifact = { id: "a1", taskId: "t1", projectId: fixture().projects[0]!.id, role: "input", kind: "url", target: "https://jira.example.com/browse/AB-1", title: "AB-1 Bug", note: "", createdBy: "human", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ticket };
    const source = JSON.stringify({ ...fixture(), version: 4, agentReceipts: [], artifacts: [artifact] });
    await writeFile(s.path, source);
    const read = await s.read();
    expect(read.version).toBe(5);
    expect(read.artifacts[0]).toMatchObject({ id: "a1", external: ticket });
    expect(read.artifacts[0]).not.toHaveProperty("ticket");
    // Reading alone rewrites nothing; the first write persists v5 after keeping the v4 copy.
    expect(await readFile(s.path, "utf8")).toBe(source);
    await s.editTask({ id: "t1", revision: 1, title: "Migrated", actor: "human" });
    const saved = JSON.parse(await readFile(s.path, "utf8"));
    expect(saved).toMatchObject({ version: 5, artifacts: [{ id: "a1", external: ticket }] });
    expect(saved.artifacts[0].ticket).toBeUndefined();
    expect(await readFile(join(s.directory, "board.pre-v5.json"), "utf8")).toBe(source);
  });
  test("a retired in_progress card status is rejected on v4 data", async () => {
    const s = await setup();
    await writeFile(s.path, JSON.stringify({ ...fixture(), version: 4, agentReceipts: [], tasks: fixture().tasks.map((t) => ({ ...t, status: "in_progress" })) }));
    await expect(s.read()).rejects.toThrow("preserved");
  });
  test("unknown data version is preserved", async () => {
    const s = await setup(),
      source = JSON.stringify({ ...fixture(), version: 99 });
    await writeFile(s.path, source);
    await expect(s.read()).rejects.toThrow("preserved");
    expect(await readFile(s.path, "utf8")).toBe(source);
  });
  test("persists across store instances and retains a backup", async () => {
    const s = await setup();
    await s.mutate((b) => Object.assign(b, fixture()));
    await s.editTask({
      id: "t1",
      revision: 1,
      status: "development",
      actor: "human",
    });
    expect((await new BoardStore(s.directory).read()).tasks[0].status).toBe(
      "development",
    );
    expect(
      JSON.parse(await readFile(`${s.path}.bak`, "utf8")).tasks[0].status,
    ).toBe("todo");
  });
  test("concurrent edits reject the stale revision and preserve the winner", async () => {
    const s = await setup();
    await s.mutate((b) => Object.assign(b, fixture()));
    const results = await Promise.allSettled([
      s.editTask({ id: "t1", revision: 1, title: "First", actor: "human" }),
      s.editTask({ id: "t1", revision: 1, title: "Second", actor: "human" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((await s.read()).tasks[0].title).toBe("First");
  });
  test("prevents duplicate workspace and native-project links, including archived records", async () => {
    const s = await setup();
    await s.mutate((b) => Object.assign(b, fixture()));
    await expect(
      s.mutate((b) =>
        b.tasks.push({
          ...b.tasks[0],
          id: "t2",
          operationId: "op2",
          archivedAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow("already bound");
    await expect(
      s.mutate((b) => b.projects.push({ ...b.projects[0], id: "p2" })),
    ).rejects.toThrow("already linked");
    expect((await s.read()).tasks).toHaveLength(1);
  });
  test("preserves a corrupt file instead of silently resetting it", async () => {
    const s = await setup();
    await writeFile(s.path, "{broken");
    await expect(s.read()).rejects.toThrow("preserved");
    await expect(s.mutate(() => undefined)).rejects.toThrow("preserved");
    expect(await readFile(s.path, "utf8")).toBe("{broken");
  });
  test("keeps business status independent and limits history per card", async () => {
    const s = await setup();
    await s.mutate((b) => {
      Object.assign(b, fixture());
      for (let i = 0; i < 130; i++)
        s.event(b, { taskId: "t1", actor: "system", action: "turn_ended" });
    });
    const b = await s.read();
    expect(b.tasks[0].status).toBe("todo");
    expect(b.events).toHaveLength(100);
  });
  test("rejects removal of a card-used repository", async () => {
    const s = await setup();
    await s.mutate((b) => Object.assign(b, fixture()));
    await expect(
      s.mutate((b) => (b.projects[0].repos = ["/repo2"])),
    ).rejects.toThrow();
    expect((await s.read()).projects[0].repos).toContain("/repo1");
  });
  test("migrates legacy cards to unrestricted scope and preserves the v1 backup", async () => {
    const s = await setup();
    const old = {
      ...fixture(),
      version: 1,
      tasks: fixture().tasks.map(({ repoPaths, ...task }) => task),
    };
    await writeFile(s.path, JSON.stringify(old));
    expect((await s.read()).tasks[0].repoPaths).toEqual([]);
    expect(JSON.parse(await readFile(s.path, "utf8")).version).toBe(1);
    await s.editTask({
      id: "t1",
      revision: 1,
      title: "Still linked",
      actor: "human",
    });
    const saved = await new BoardStore(s.directory).read();
    expect(saved.version).toBe(5);
    expect(saved.tasks[0]).toMatchObject({
      repoPaths: [],
      workspaceId: "w1",
      sourcePath: "/repo1",
    });
    expect(JSON.parse(await readFile(`${s.path}.bak`, "utf8"))).toEqual(old);
  });
  test("preserves a selected legacy scope through card edits and rejects loss of its directory", async () => {
    const s = await setup();
    await s.mutate((b) => Object.assign(b, fixture()));
    await s.mutate((b) => {
      b.tasks[0].repoPaths = ["/repo2"];
    });
    await s.editTask({
      id: "t1",
      revision: 1,
      title: "Changed",
      actor: "human",
    });
    expect((await s.read()).tasks[0].repoPaths).toEqual(["/repo2"]);
    await expect(
      s.mutate((b) => {
        b.projects[0].repos = ["/repo1"];
      }),
    ).rejects.toThrow("project");
    expect((await s.read()).tasks[0].workspaceId).toBe("w1");
  });
});
