import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";

/** Every ToolServer the plugin entry makes, so the test can reach its dispatcher tools. */
const toolServers = vi.hoisted(() => [] as { dispatcherTools: { createProjectWith?: unknown } }[]);
vi.mock("./tool-server", async (original) => {
  const actual = await original<typeof import("./tool-server")>();
  class Recorded extends actual.ToolServer {
    constructor(...args: ConstructorParameters<typeof actual.ToolServer>) {
      super(...args);
      toolServers.push(this);
    }
  }
  return { ...actual, ToolServer: Recorded };
});

import contribute from "../index.server";
import { BoardService } from "./service";
import { GuardrailsService } from "./guardrails";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

/** A host that records RPC handlers and answers everything else with nothing. */
function fakeHost() {
  const handlers = new Map<string, (input: unknown, context: { paseo: PaseoApi }) => unknown>();
  const settings = { read: async () => ({ status: "ready", revision: "r", values: {} }), subscribe: () => () => {} };
  const host = new Proxy(
    {},
    {
      get(_, key) {
        if (key === "handle") return (contract: { name: string }, handler: never) => handlers.set(contract.name, handler);
        if (key === "registerSettings") return () => settings;
        return () => () => {};
      },
    },
  ) as PluginServerContext;
  return { host, handlers };
}

test("the plugin entry gives flowly_create_project the projects.create RPC's own path (DISPATCHER-SPEC §5.2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-entry-"));
  const env = { FLOWLY_DATA_DIR: process.env.FLOWLY_DATA_DIR, PASEO_HOME: process.env.PASEO_HOME };
  process.env.FLOWLY_DATA_DIR = join(root, "data");
  process.env.PASEO_HOME = join(root, "home");
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    // The entry's background work (store close, first reads) can still be writing for a moment.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  // The board service's create and the guardrail detection are the RPC's path; record who calls them.
  const services: unknown[] = [];
  let made = 0;
  vi.spyOn(BoardService.prototype, "createProject").mockImplementation(async function (this: BoardService, input) {
    services.push(this);
    return { id: `made-${++made}`, title: input.title, primaryPath: input.primaryPath } as never;
  });
  const detect = vi.spyOn(GuardrailsService.prototype, "detect").mockResolvedValue({ found: [], added: [] });
  const { host, handlers } = fakeHost();
  toolServers.length = 0;
  const dispose = contribute(host);
  cleanups.push(() => dispose());
  const paseo = {} as PaseoApi;

  const rpc = handlers.get("projects.create");
  expect(rpc).toBeDefined();
  await rpc!({ title: "From the form", description: "", primaryPath: "/x" }, { paseo });
  expect(toolServers).toHaveLength(1);
  const create = toolServers[0].dispatcherTools.createProjectWith as ((input: unknown, paseo: PaseoApi) => Promise<{ id: string }>) | undefined;
  // Wired by the entry: removing that line leaves the tool unwired (PASEO_UNAVAILABLE) and fails here.
  expect(create).toBeTypeOf("function");
  const project = await create!({ title: "From the dispatcher", description: "", primaryPath: "/y" }, paseo);
  expect(project.id).toBe("made-2");
  // The same board service (one queue with the form) and the same follow-up for both.
  expect(services).toHaveLength(2);
  expect(services[1]).toBe(services[0]);
  expect(detect.mock.calls.map(([id]) => id)).toEqual(["made-1", "made-2"]);
});

test("the plugin entry migrates board groups first and serves the group RPCs with coded refusals (BOARD-GROUPS-SPEC §2, §7)", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-entry-"));
  const env = { FLOWLY_DATA_DIR: process.env.FLOWLY_DATA_DIR, PASEO_HOME: process.env.PASEO_HOME };
  process.env.FLOWLY_DATA_DIR = join(root, "data");
  process.env.PASEO_HOME = join(root, "home");
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const { host, handlers } = fakeHost();
  const dispose = contribute(host);
  cleanups.push(() => dispose());
  const call = (name: string, input: unknown) => handlers.get(name)!(input, { paseo: {} as PaseoApi }) as Promise<{ id: string; revision: number }>;
  for (const name of ["groups.create", "groups.update", "groups.move", "groups.delete", "projects.set-group"]) expect(handlers.has(name), name).toBe(true);
  // The empty board's first group is its default, which can't be deleted; the code crosses the RPC as a prefix.
  const first = await call("groups.create", { name: "First" });
  await expect(call("groups.delete", { id: first.id, revision: first.revision })).rejects.toThrow(/^DEFAULT_REQUIRED: /);
  await expect(call("groups.create", { name: "first" })).rejects.toThrow(/^NAME_TAKEN: /);
});
