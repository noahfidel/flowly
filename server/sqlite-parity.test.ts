import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { emptyBoard, type Board } from "../shared/model";

// The same operations on board.json and on flowly.sqlite give the same board after every step
// (SQLITE-STORAGE-SPEC §11 item 2). Ids and times are made deterministic so both runs can be compared.
let counter = 0;
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
}));

const directories: string[] = [];
const stores: BoardStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const at = "2026-10-20T10:00:00.000Z";
const project = (id: string, n: number) => ({ id, paseoProjectId: `native-${id}`, title: `Project ${id}`, description: "", primaryPath: `/repo-${id}`, repos: [`/repo-${id}`], revision: 1, createdAt: at, updatedAt: at, archivedAt: null, position: n });
const task = (id: string, projectId: string, position: number) => ({
  id,
  projectId,
  workspaceId: `w-${id}`,
  sourcePath: `/repo-${projectId}`,
  repoPaths: [],
  title: `Card ${id}`,
  description: "",
  status: "todo" as const,
  priority: "normal" as const,
  position,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
});
function fixture(): Board {
  const b = emptyBoard();
  const { position: _, ...p1 } = project("p1", 0);
  b.projects.push(p1);
  b.tasks.push(task("t1", "p1", 0), task("t2", "p1", 1));
  return b;
}

const steps: [string, (s: BoardStore) => Promise<unknown>][] = [
  [
    "create a project with cards and events",
    (s) =>
      s.mutate((b) => {
        const { position: _, ...p2 } = project("p2", 1);
        b.projects.push(p2);
        b.tasks.push(task("t3", "p2", 0), task("t4", "p2", 1));
        s.event(b, { taskId: "t3", actor: "human", action: "created" });
        s.event(b, { taskId: "t4", actor: "human", action: "created" });
      }),
  ],
  ["edit a card with tags", async (s) => s.editTask({ id: "t1", revision: 1, title: "Renamed", tags: ["drawer"], tagsBase: [], actor: "human" })],
  ["add tags", (s) => s.editTags({ taskId: "t2", add: ["mobile", "a11y"] })],
  ["move a card", (s) => s.placeTask({ id: "t3", revision: 1, status: "development", beforeId: null, afterId: null })],
  ["edit a project", (s) => s.updateProject({ id: "p2", revision: 1, title: "Renamed project" })],
  ["reorder projects", (s) => s.moveProject({ id: "p2", direction: "up" })],
  [
    "agent records: ideas, artifacts, links, workpads, plans, receipts",
    (s) =>
      s.mutate((b) => {
        b.ideas.push({ id: "i1", taskId: "t3", projectId: "p2", agentId: "a1", eventId: "e-i1", title: "Idea", detail: "Detail", rationale: "Why", context: "", status: "open", createdAt: at, updatedAt: at });
        b.artifacts.push({ id: "a1", taskId: "t3", projectId: "p2", role: "output", kind: "url", target: "https://example.com/pr/1", title: "PR", note: "", createdBy: "agent", agentId: "a1", createdAt: at, updatedAt: at });
        b.links.push({ id: "l1", projectId: "p2", kind: "related", from: "t3", to: "t4", createdBy: "human", createdAt: at });
        b.workpads.push({ taskId: "t3", projectId: "p2", revision: 1, acceptance: [{ id: "x", text: "Works", done: false, by: "agent", at }], updatedAt: at, updatedBy: "agent" });
        b.plans.push({ taskId: "t3", agentId: "a1", items: [{ text: "Step", status: "pending" }], at });
        b.agentReceipts.push({ key: "k1", agentId: "a1", taskId: "t3", payloadHash: "h", action: "progress", eventId: "e1", taskRevision: 1, projectRevision: 1, status: "todo", at, expiresAt: at });
      }),
  ],
  ["dismiss an idea", (s) => s.updateIdea({ id: "i1", status: "dismissed" })],
  ["dismiss attention", (s) => s.dismissAttention({ taskId: "t1", signals: ["question:1"] })],
  ["delete a card", (s) => s.deleteTask({ id: "t4", revision: 1 })],
  ["remove a project", async (s) => s.removeProject({ id: "p2", revision: (await s.read()).projects.find((p) => p.id === "p2")!.revision })],
];

describe("board.json and flowly.sqlite", () => {
  test("give the same board after every step, and after reopening", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
    const [jsonDir, sqliteDir] = await Promise.all([mkdtemp(join(tmpdir(), "flowly-parity-json-")), mkdtemp(join(tmpdir(), "flowly-parity-sqlite-"))]);
    directories.push(jsonDir, sqliteDir);
    for (const dir of [jsonDir, sqliteDir]) await writeFile(join(dir, "board.json"), JSON.stringify(fixture()));
    const json = new BoardStore(jsonDir);
    const sqlite = new BoardStore(sqliteDir, { backend: "sqlite", storage: { checkVersion: false } });
    stores.push(json, sqlite);
    expect(JSON.stringify(await sqlite.read())).toBe(JSON.stringify(await json.read()));
    let clock = Date.parse("2026-10-26T01:00:00.000Z");
    for (const [name, step] of steps) {
      clock += 60_000;
      const base = counter;
      for (const store of [json, sqlite]) {
        counter = base;
        vi.setSystemTime(new Date(clock));
        await step(store);
      }
      expect(JSON.stringify(await sqlite.read()), name).toBe(JSON.stringify(await json.read()));
    }
    const final = JSON.stringify(await json.read());
    expect(final).toContain("Renamed");
    expect(final).not.toContain('"p2"');
    await sqlite.close();
    const reopened = new BoardStore(sqliteDir, { backend: "sqlite", storage: { checkVersion: false } });
    stores.push(reopened);
    expect(JSON.stringify(await reopened.read())).toBe(final);
  });
});
