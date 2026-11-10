import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BUNDLE, BUNDLE_FILE, exceptionReport, expectedRpcError, logFailure, outsideError, ownFrames, pluginRoot, reportRpcErrors, setErrorSink } from "./error-report";
import { LocalDaemonUnavailable } from "./local-daemon";
import { SummaryModelError } from "./summary-models";
import { MAX_ERRORS_PER_DAY, TelemetryService } from "./telemetry";
import { ToolError } from "./tool-error";
import { FLOWLY_VERSION } from "../shared/version";

const ROOT = "/home/someone/.paseo/plugins/flowly";
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const dirs: string[] = [];
afterEach(async () => {
  setErrorSink(null);
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function failure(name = "TypeError", code?: string, message = "Cannot read card /Users/alice/secret-repo/notes.md") {
  const error = new Error(message);
  error.name = name;
  if (code) (error as NodeJS.ErrnoException).code = code;
  error.stack = [
    `${name}: ${message}`,
    `    at BoardService.update (${ROOT}/server/service.ts:120:15)`,
    `    at ${ROOT}/node_modules/zod/lib/index.js:10:2`,
    `    at readFile (node:internal/fs/promises:100:3)`,
    `    at Object.handler (file://${ROOT}/index.server.ts:300:7)`,
    `    at run (/Users/alice/other-plugin/server.js:1:1)`,
    `    at async Promise.all (index 0)`,
  ].join("\n");
  return error;
}

test("plugin root: the folder above server/ from source, the bundle's folder when bundled", () => {
  expect(pluginRoot(`Error\n    at pluginRoot (${ROOT}/server/error-report.ts:40:20)`)).toBe(ROOT);
  expect(pluginRoot(`Error\n    at pluginRoot (file://${ROOT}/dist/server.js:40:20)`)).toBe(`${ROOT}/dist`);
  expect(pluginRoot("Error")).toBe("");
  expect(pluginRoot(`Error\n    at pluginRoot (eval at evaluateBundle (file:///root/.nvm/lib/node_modules/@getpaseo/server/dist/plugins/bundle-evaluator.js:32:21), <anonymous>:99:20)`)).toBe(BUNDLE);
});

// As seen on Paseo 0.13.0 (Coder E2E 2026-10-26): the plugin bundle runs through eval.
test("frames of Paseo's evaluated bundle: fixed file name, bundle positions, function names; no paths", () => {
  const at = "eval at evaluateBundle (file:///root/.nvm/versions/node/v22.19.0/lib/node_modules/@getpaseo/server/dist/server/server/plugins/bundle-evaluator.js:32:21), <anonymous>";
  const stack = [
    "Error: ENOENT: no such file or directory, realpath '/tmp/alice-secret'",
    `    at async directory (${at}:102566:21)`,
    `    at async listDirectories (${at}:102580:19)`,
    "    at async Object.realpath (node:internal/fs/promises:1000:10)",
    "    at async handle (file:///root/.nvm/lib/node_modules/@getpaseo/server/dist/server/plugins/host.js:10:3)",
  ].join("\n");
  const frames = ownFrames(stack, BUNDLE);
  expect(frames.map((f) => [f.filename, f.function, f.lineno, f.colno])).toEqual([
    [BUNDLE_FILE, "async listDirectories", 102580, 19],
    [BUNDLE_FILE, "async directory", 102566, 21],
  ]);
  expect(JSON.stringify(frames)).not.toMatch(/root|nvm|alice|internal|host\.js/);
});

test("frames: only Flowly's own files, relative, oldest call first; never a path outside the plugin", () => {
  const frames = ownFrames(failure().stack!, ROOT);
  expect(frames.map((f) => [f.filename, f.function, f.lineno])).toEqual([
    ["index.server.ts", "Object.handler", 300],
    ["server/service.ts", "BoardService.update", 120],
  ]);
  expect(JSON.stringify(frames)).not.toMatch(/home|Users|alice|node_modules|internal/);
  expect(ownFrames(failure().stack!, "")).toEqual([]);
});

test("report: class and safe code only, never the message", () => {
  const report = exceptionReport(failure("SqliteError", "SQLITE_BUSY"), "Kanban auto wrap-up failed:", true, ROOT);
  expect(report).toMatchObject({ type: "SqliteError", value: "SQLITE_BUSY", source: "Kanban auto wrap-up failed", handled: true });
  expect(JSON.stringify(report)).not.toMatch(/secret|alice|Cannot read/);
  expect(exceptionReport(failure("Error", "not a code"), "x", true, ROOT).value).toBe("");
  expect(exceptionReport(failure("weird name!"), "x", true, ROOT).type).toBe("Error");
  expect(exceptionReport("a string /Users/alice", "x", true, ROOT)).toMatchObject({ type: "NonError", value: "", frames: [] });
  expect(exceptionReport(failure(), "label with /Users/alice?\n", true, ROOT).source).toBe("other");
  // Same kind and place: same fingerprint; another throw site: another one.
  expect(exceptionReport(failure(), "x", true, ROOT).fingerprint).toBe(exceptionReport(failure("TypeError", undefined, "other text"), "x", true, ROOT).fingerprint);
  const elsewhere = failure();
  elsewhere.stack = elsewhere.stack!.replace("service.ts:120", "service.ts:121");
  expect(exceptionReport(elsewhere, "x", true, ROOT).fingerprint).not.toBe(exceptionReport(failure(), "x", true, ROOT).fingerprint);
});

test("a Paseo RPC error reports which request failed and Paseo's code, never its message", () => {
  // Shaped like @getpaseo/client's DaemonRpcError: the message repeats the server's error text.
  const rpc = (requestType: unknown, code?: unknown) =>
    Object.assign(failure("DaemonRpcError", undefined, `Agent /Users/alice/secret not found requestType=${String(requestType)} code=${String(code)}`), { requestType, code, requestId: "req-1" });
  const report = exceptionReport(rpc("fetch_agent_timeline_request", "agent_refresh_failed"), "Flowly session insight rows not added", true, ROOT);
  expect(report).toMatchObject({ type: "DaemonRpcError", value: "fetch_agent_timeline_request:agent_refresh_failed" });
  expect(JSON.stringify(report)).not.toMatch(/alice|secret|not found|req-1/);
  expect(exceptionReport(rpc("project.list.request", "WORKTREE_BUSY"), "x", true, ROOT).value).toBe("project.list.request:worktree_busy");
  expect(exceptionReport(rpc("send_agent_message_request"), "x", true, ROOT).value).toBe("send_agent_message_request");
  // Anything that is not wholly an identifier is dropped, not trimmed into one.
  expect(exceptionReport(rpc("fetch /Users/alice", "bad code!"), "x", true, ROOT).value).toBe("");
  expect(exceptionReport(rpc("x".repeat(61), "handler_error"), "x", true, ROOT).value).toBe(":handler_error");
  // Another kind of report: requestType grouping splits the fingerprint.
  expect(exceptionReport(rpc("a_request", "c"), "x", true, ROOT).fingerprint).not.toBe(exceptionReport(rpc("b_request", "c"), "x", true, ROOT).fingerprint);
});

test("expected RPC errors are not reported: tool errors and plain messages; bugs and system errors are", () => {
  expect(expectedRpcError(new ToolError("TAG_INVALID", "bad"))).toBe(true);
  expect(expectedRpcError(new Error("Task not found."))).toBe(true);
  expect(expectedRpcError(failure("Error", "ENOENT"))).toBe(false);
  expect(expectedRpcError(new TypeError("x"))).toBe(false);
  expect(expectedRpcError("x")).toBe(false);
});

test("failures outside Flowly are never reported: lost daemon connection, unavailable local daemon, summary models", () => {
  const lost = Object.assign(new Error("Transport closed"), { name: "DaemonConnectionError", code: "DAEMON_CONNECTION_LOST" });
  for (const error of [lost, new LocalDaemonUnavailable("restarting"), new SummaryModelError("a: timed out")]) {
    expect(outsideError(error)).toBe(true);
    expect(expectedRpcError(error)).toBe(true);
  }
  expect(outsideError(new Error("x"))).toBe(false);
  expect(outsideError(failure("Error", "ENOENT"))).toBe(false);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const reported: string[] = [];
  setErrorSink((source) => reported.push(source));
  logFailure("Flowly read-state sync failed:", new LocalDaemonUnavailable("restarting"));
  logFailure("Flowly session insight failed:", new SummaryModelError("a: timed out"));
  logFailure("Kanban auto wrap-up failed:", new Error("boom"));
  expect(log).toHaveBeenCalledTimes(3);
  expect(reported).toEqual(["Kanban auto wrap-up failed:"]);
  log.mockRestore();
});

async function harness(options: { env?: NodeJS.ProcessEnv; enabled?: boolean; now?: () => number; paseoVersion?: () => Promise<string> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-errors-"));
  dirs.push(directory);
  const calls: { url: string; body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> } }[] = [];
  const service = new TelemetryService({
    directory,
    env: options.env ?? {},
    apiKey: "phc_test",
    pluginRoot: ROOT,
    paseoVersion: options.paseoVersion,
    now: options.now ?? (() => NOW),
    enabled: async () => options.enabled ?? true,
    snapshot: async () => {
      throw new Error("not used");
    },
    activity: async () => ({ events: [], memoryConfirmedAt: [] }),
    fetch: (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true } as Response;
    }) as unknown as typeof fetch,
  });
  return { service, calls, directory };
}

test("paseo_version: the host's version when known, retried after an empty answer, \"\" when unavailable", async () => {
  let answers = ["", "0.13.0", "0.14.0"];
  const { service, calls } = await harness({ paseoVersion: async () => answers.shift() ?? "" });
  await service.reportError("a", failure());
  await service.reportError("b", failure());
  await service.reportError("c", failure());
  expect(calls.map((c) => c.body.properties.paseo_version)).toEqual(["", "0.13.0", "0.13.0"]);
  const { service: bare, calls: bareCalls } = await harness({ paseoVersion: async () => Promise.reject(new Error("no daemon")) });
  await bare.reportError("a", failure());
  expect(bareCalls[0]!.body.properties.paseo_version).toBe("");
});

test("sends one $exception with the §11 keys and the heartbeat's install id", async () => {
  const { service, calls, directory } = await harness();
  expect(await service.reportError("Kanban auto wrap-up failed:", failure())).toBe(true);
  expect(calls).toHaveLength(1);
  const { body } = calls[0]!;
  expect(body.event).toBe("$exception");
  expect(Object.keys(body.properties).sort()).toEqual(
    ["$process_person_profile", "$geoip_disable", "$exception_list", "$exception_fingerprint", "source", "flowly_version", "paseo_version", "node_major", "os", "arch"].sort(),
  );
  expect(body.properties.flowly_version).toBe(FLOWLY_VERSION);
  expect(body.properties.$exception_list).toEqual([
    {
      type: "TypeError",
      value: "",
      mechanism: { handled: true, synthetic: false },
      stacktrace: { type: "raw", frames: exceptionReport(failure(), "x", true, ROOT).frames },
    },
  ]);
  expect(JSON.stringify(body)).not.toMatch(/secret|alice|home/);
  const state = JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8"));
  expect(body.distinct_id).toBe(state.installId);
});

test("a fresh install: concurrent first reports share one install id", async () => {
  const { service, calls, directory } = await harness();
  await Promise.all([1, 2, 3].map((i) => service.reportError(`burst ${i}`, failure())));
  expect(calls).toHaveLength(3);
  const state = JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8"));
  expect(new Set(calls.map((c) => c.body.distinct_id))).toEqual(new Set([state.installId]));
});

test("each kind once per UTC day, at most 20 a day; a new day starts over", async () => {
  let now = NOW;
  const { service, calls } = await harness({ now: () => now });
  await service.reportError("x", failure());
  await service.reportError("x", failure());
  expect(calls).toHaveLength(1);
  for (let i = 0; i < 30; i++) await service.reportError(`kind ${i}`, failure());
  expect(calls).toHaveLength(MAX_ERRORS_PER_DAY);
  now += 24 * 3_600_000;
  await service.reportError("x", failure());
  expect(calls).toHaveLength(MAX_ERRORS_PER_DAY + 1);
});

test("nothing is sent when the switch is off or DO_NOT_TRACK is set", async () => {
  const off = await harness({ enabled: false });
  expect(await off.service.reportError("x", failure())).toBe(false);
  expect(off.calls).toHaveLength(0);
  const dnt = await harness({ env: { DO_NOT_TRACK: "1" } });
  expect(await dnt.service.reportError("x", failure())).toBe(false);
  expect(dnt.calls).toHaveLength(0);
});

test("uncaught errors are reported only when they pass through Flowly's code", async () => {
  const { service, calls } = await harness();
  const foreign = new TypeError("x");
  foreign.stack = "TypeError: x\n    at run (/opt/paseo/server.js:1:1)";
  expect(await service.reportError("uncaught", foreign, false)).toBe(false);
  expect(await service.reportError("uncaught", failure(), false)).toBe(true);
  expect(calls[0]!.body.properties.$exception_list).toMatchObject([{ mechanism: { handled: false } }]);
});

test("RPC handlers: unexpected failures are reported and rethrown; expected ones are only rethrown", async () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const host = {
    marker: 1,
    handle(contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;
  const reported: string[] = [];
  setErrorSink((source) => reported.push(source));
  const server = reportRpcErrors(host);
  expect((server as unknown as { marker: number }).marker).toBe(1);
  const contract = (name: string) => ({ name }) as unknown as Parameters<PluginServerContext["handle"]>[0];
  server.handle(contract("a.sync"), () => {
    throw new TypeError("boom");
  });
  server.handle(contract("a.async"), async () => {
    throw failure("Error", "ENOENT");
  });
  server.handle(contract("a.expected"), async () => {
    throw new ToolError("TAG_INVALID", "bad");
  });
  server.handle(contract("a.ok"), () => 42);
  expect(() => handlers.get("a.sync")!({}, {})).toThrow("boom");
  await expect(handlers.get("a.async")!({}, {})).rejects.toThrow();
  await expect(handlers.get("a.expected")!({}, {})).rejects.toThrow("bad");
  expect(handlers.get("a.ok")!({}, {})).toBe(42);
  expect(reported).toEqual(["rpc a.sync", "rpc a.async"]);
});

test("logFailure: context goes to the log only, the report gets the label", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const reported: string[] = [];
  setErrorSink((source) => reported.push(source));
  logFailure("Kanban project folder not saved:", new Error("EACCES /Users/alice"), "project-123");
  expect(log).toHaveBeenCalledWith("Kanban project folder not saved:", "project-123", "EACCES /Users/alice");
  expect(reported).toEqual(["Kanban project folder not saved:"]);
  log.mockRestore();
});

// TELEMETRY-SPEC §11.2: every daemon-side error log is reported, so new code cannot bypass logFailure.
test("daemon code logs failures only through logFailure", async () => {
  const root = join(__dirname, "..");
  const files = ["index.server.ts", ...(await readdir(join(root, "server"), { recursive: true })).map((f) => join("server", String(f)))].filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== join("server", "error-report.ts"),
  );
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.includes("console.error(")) offenders.push(`${file}:${i + 1}`);
    });
  }
  expect(offenders, "use logFailure(label, error, context?) from server/error-report.ts").toEqual([]);
});
