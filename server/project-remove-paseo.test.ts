import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { BoardService } from "./service";

// `paseo project delete` is the only native project removal; record calls instead of running it.
const calls: string[][] = [];
let deleteFails = false;
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: unknown, callback: (e: unknown, r?: unknown) => void) => {
      const cb = typeof options === "function" ? (options as typeof callback) : callback;
      // The resolved CLI: bare `paseo` or the installed app's.
      if (/(^|\/)paseo$/.test(file)) {
        calls.push(args);
        if (deleteFails) cb(Object.assign(new Error("failed"), { stderr: "Error: project busy\n" }));
        else cb(null, { stdout: JSON.stringify({ projectId: args[2], removedWorkspaceIds: ["w1", "w2"] }), stderr: "" });
        return;
      }
      return (actual.execFile as Function)(file, args, options, callback);
    },
  };
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ultra-remove-paseo-"));
  calls.length = 0;
  deleteFails = false;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const now = new Date().toISOString();
async function setup(agentStatus: string) {
  const store = new BoardStore(join(dir, "data"));
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "native", title: "P", description: "", primaryPath: "/r", repos: ["/r"], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
  });
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "native", projectRootPath: "/r", projectDisplayName: "P" }] }) },
    workspaces: {
      list: async (o: { filter?: { includeBackground?: boolean } }) => ({
        entries: [{ id: "w1", projectId: "native" }, { id: "w9", projectId: "other" }, ...(o.filter?.includeBackground ? [{ id: "wb", projectId: "native", background: true }] : [])],
        pageInfo: { nextCursor: null },
      }),
    },
    agents: {
      list: async (o: { filter?: { includeBackground?: boolean } }) => ({
        entries: [
          { agent: { id: "a1", workspaceId: "w1", status: agentStatus, archivedAt: null } },
          { agent: { id: "a9", workspaceId: "w9", status: "running", archivedAt: null } },
          ...(o.filter?.includeBackground ? [{ agent: { id: "ab", workspaceId: "wb", status: agentStatus, archivedAt: null } }] : []),
        ],
        pageInfo: { nextCursor: null },
      }),
    },
  } as unknown as PaseoApi;
  return { store, service: new BoardService(store), paseo };
}

test("check counts only the project's workspaces and running sessions", async () => {
  const x = await setup("running");
  // Background (hidden) review workspaces and their sessions are removed with the project too.
  expect(await x.service.removeCheck("p", x.paseo)).toEqual({ cards: 0, paseoProjectId: "native", paseoExists: true, workspaces: 2, runningSessions: 2 });
});

test("board-only removal never touches Paseo", async () => {
  const x = await setup("running");
  const result = await x.service.removeProject({ id: "p", revision: 1 }, x.paseo);
  expect(result.paseo).toBeUndefined();
  expect(calls).toEqual([]);
  expect((await x.store.read()).projects).toEqual([]);
});

test("removing from Paseo is refused while a session runs, and nothing is removed", async () => {
  const x = await setup("running");
  await expect(x.service.removeProject({ id: "p", revision: 1, alsoPaseo: true }, x.paseo)).rejects.toThrow("still running");
  expect(calls).toEqual([]);
  expect((await x.store.read()).projects).toHaveLength(1);
});

test("removing from Paseo deletes the native project after the board record", async () => {
  const x = await setup("idle");
  const result = await x.service.removeProject({ id: "p", revision: 1, alsoPaseo: true }, x.paseo);
  expect(result.paseo).toEqual({ removed: true, workspaces: 2, error: "" });
  expect(calls[0].slice(0, 3)).toEqual(["project", "delete", "native"]);
  expect((await x.store.read()).projects).toEqual([]);
});

test("a failed Paseo step is reported while the board removal stands", async () => {
  const x = await setup("idle");
  deleteFails = true;
  const result = await x.service.removeProject({ id: "p", revision: 1, alsoPaseo: true }, x.paseo);
  expect(result.paseo).toEqual({ removed: false, workspaces: 0, error: "Error: project busy" });
  expect((await x.store.read()).projects).toEqual([]);
});
