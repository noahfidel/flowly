import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { availableModels, finishRefusingPermissions, runSummaryModels, SummaryModelError } from "./summary-models";

const paseo = {
  providers: {
    listAvailable: async () => ({ providers: [{ provider: "one", available: true }, { provider: "two", available: true }, { provider: "unused", available: true }] }),
    listModels: vi.fn(async (provider: string) => ({ models: provider === "one" ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }], error: null })),
  },
} as unknown as PaseoApi;

test("custom providers are discovered once; unrelated providers are not queried", async () => {
  vi.mocked(paseo.providers.listModels).mockClear();
  const providers = await availableModels(paseo, ["two/c", "one/a", "one/b"]);
  expect(providers.map((p) => p.provider)).toEqual(["one", "two"]);
  expect(vi.mocked(paseo.providers.listModels).mock.calls.map(([p]) => p)).toEqual(["one", "two"]);
});

test("shared callers get ordered parsing fallback, cleanup before retry, and stop at valid empty output", async () => {
  const actions: string[] = [];
  const create = async (model: string) => {
    actions.push(`create ${model}`);
    return { id: model, archive: async () => undefined, waitForFinish: async () => ({ status: "idle", lastMessage: model === "two/c" ? "bad" : "[]" }) };
  };
  const result = await runSummaryModels(paseo, ["missing/x", "two/c", "one/b", "one/a"], {
    create, parse: (text) => JSON.parse(text!), timeoutMs: 100,
    remove: async (agent) => { actions.push(`remove ${agent.id}`); },
  });
  expect(result).toEqual({ model: "one/b", output: [] });
  expect(actions).toEqual(["create two/c", "remove two/c", "create one/b", "remove one/b"]);
});

test("provider-list failure cannot mark unknown models as available", async () => {
  const broken = { providers: { ...paseo.providers, listModels: async () => { throw new Error("discovery offline"); } } } as unknown as PaseoApi;
  const create = vi.fn();
  await expect(runSummaryModels(broken, ["one/a"], { create, parse: () => null, remove: async () => {}, timeoutMs: 100 })).rejects.toThrow(/No configured summary model/);
  await expect(runSummaryModels(broken, ["one/a"], { create, parse: () => null, remove: async () => {}, timeoutMs: 100 })).rejects.toBeInstanceOf(SummaryModelError);
  expect(create).not.toHaveBeenCalled();
});

test("every model failing is a SummaryModelError naming each failure", async () => {
  const create = async (model: string) => ({ id: model, archive: async () => undefined, waitForFinish: async () => ({ status: "timeout" }) });
  const error = await runSummaryModels(paseo, ["one/a", "two/c"], { create, parse: () => null, remove: async () => {}, timeoutMs: 100 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SummaryModelError);
  expect((error as Error).message).toBe("one/a: The summary model timed out.; two/c: The summary model timed out.");
});

test("a permission request on a temporary session is refused and the run goes on", async () => {
  const denied: unknown[] = [];
  let waits = 0;
  const create = async (model: string) => ({
    id: model, archive: async () => undefined,
    respondToPermission: async (o: unknown) => { denied.push(o); },
    waitForFinish: async () => (++waits === 1 ? { status: "permission", final: { pendingPermissions: [{ id: "r1" }, { id: "r2" }] } } : { status: "idle", lastMessage: "[]" }),
  });
  const result = await runSummaryModels(paseo, ["one/a"], { create, parse: (text) => JSON.parse(text!), remove: async () => {}, timeoutMs: 100 });
  expect(result).toEqual({ model: "one/a", output: [] });
  expect(denied.map((d) => (d as { requestId: string; response: { behavior: string } }).requestId)).toEqual(["r1", "r2"]);
  expect(denied.every((d) => (d as { response: { behavior: string } }).response.behavior === "deny")).toBe(true);
});

test("a permission request that cannot be refused still fails the model, and an endless one stops", async () => {
  const stuck = async (model: string) => ({ id: model, archive: async () => undefined, waitForFinish: async () => ({ status: "permission", final: { pendingPermissions: [] } }) });
  await expect(runSummaryModels(paseo, ["one/a"], { create: stuck, parse: () => null, remove: async () => {}, timeoutMs: 100 })).rejects.toThrow("one/a: The summary model asked for a permission.");
  const respond = vi.fn(async () => {});
  const endless = async (model: string) => ({ id: model, archive: async () => undefined, respondToPermission: respond, waitForFinish: async () => ({ status: "permission", final: { pendingPermissions: [{ id: "r" }] } }) });
  await expect(runSummaryModels(paseo, ["one/a"], { create: endless, parse: () => null, remove: async () => {}, timeoutMs: 100 })).rejects.toThrow(/asked for a permission/);
  expect(respond).toHaveBeenCalledTimes(20);
});

test("refusing permissions does not restart the timeout: every wait shares one deadline", async () => {
  vi.useFakeTimers({ now: 0 });
  try {
    const waits: number[] = [];
    const agent = {
      id: "a", archive: async () => undefined,
      respondToPermission: async () => {},
      waitForFinish: async (timeout: number) => {
        waits.push(timeout);
        vi.setSystemTime(Date.now() + 40);
        return { status: "permission", final: { pendingPermissions: [{ id: "r" }] } };
      },
    };
    const result = await finishRefusingPermissions(agent, 100);
    expect(waits).toEqual([100, 60, 20]);
    expect(result.status).toBe("timeout");
  } finally {
    vi.useRealTimers();
  }
});
