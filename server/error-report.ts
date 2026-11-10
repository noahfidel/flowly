import { createHash } from "node:crypto";
import { basename, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ZodError } from "zod";
import { StoreInvalidError } from "./board-file";
import { ExternalError } from "./connectors/http";
import { LocalDaemonUnavailable } from "./local-daemon";
import { MemoryError } from "./memory";
import { GuardrailError } from "./guardrails";
import { SummaryModelError } from "./summary-models";
import { ToolError } from "./tool-error";

/**
 * Error reports for telemetry (TELEMETRY-SPEC §11). Only the error's class, a safe code and
 * Flowly's own stack frames (paths relative to the plugin folder) leave the machine: never the
 * message, never a path outside the plugin.
 */

const MAX_FRAMES = 20;
const identifier = /^[A-Za-z_$][\w$]{0,60}$/;
const safeCode = /^[A-Z][A-Z0-9_]{1,40}$/;
/** A Paseo request type or RPC error code (`fetch_agent_timeline_request`, `project.list.request`). */
const rpcIdentifier = /^[a-z][a-z0-9_.]{0,59}$/;
const safeFunction = /^[\w$.<> ]{1,80}$/;
const safeSource = /^[\w .,;:'/-]{1,80}$/;

export type ExceptionFrame = { filename: string; function: string; lineno: number; colno: number; in_app: true; platform: "node:javascript" };
export type ExceptionReport = {
  type: string;
  value: string;
  source: string;
  handled: boolean;
  frames: ExceptionFrame[];
  fingerprint: string;
};

const frameLine = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
/**
 * Paseo compiles the plugin into one bundle and runs it with `eval` (no file name, no source
 * map), so its frames read `eval at evaluateBundle (…), <anonymous>:line:col`.
 */
const evalFrame = /^eval at .+, <anonymous>$/;
/** `pluginRoot()` when the plugin runs as Paseo's evaluated bundle. */
export const BUNDLE = "<bundle>";
/** File name sent for frames of the evaluated bundle; line and column are bundle positions. */
export const BUNDLE_FILE = "flowly-bundle.js";

function filePath(location: string) {
  if (location.startsWith("file://")) {
    try {
      return fileURLToPath(location);
    } catch {
      return "";
    }
  }
  return location;
}

/**
 * The plugin folder, from where this file runs: from source it sits in `server/`, bundled it is
 * the bundle's folder; `BUNDLE` when Paseo evaluated the bundle.
 */
export function pluginRoot(stack = new Error().stack ?? ""): string {
  const own = stack.split("\n").map((line) => frameLine.exec(line)).find(Boolean);
  if (!own) return "";
  if (evalFrame.test(own[2]!)) return BUNDLE;
  const dir = dirname(filePath(own[2]!));
  return basename(dir) === "server" ? dirname(dir) : dir;
}

const root = pluginRoot();

/**
 * Flowly's own frames, oldest call first (PostHog's order): relative to the plugin folder, or
 * `BUNDLE_FILE` with bundle positions when Paseo evaluated the bundle. Evaluated frames of other
 * plugins look the same; only uncaught errors can contain them (§11.2).
 */
export function ownFrames(stack: string, base = root): ExceptionFrame[] {
  if (!base) return [];
  const frames: ExceptionFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = frameLine.exec(line);
    if (!match) continue;
    let relative: string;
    if (base === BUNDLE) {
      if (!evalFrame.test(match[2]!)) continue;
      relative = BUNDLE_FILE;
    } else {
      const file = filePath(match[2]!);
      if (!file.startsWith(base + sep)) continue;
      relative = file.slice(base.length + 1).split(sep).join("/");
      if (relative.startsWith("node_modules/") || relative.includes("/node_modules/")) continue;
    }
    const fn = match[1] ?? "";
    frames.push({
      filename: relative,
      function: safeFunction.test(fn) ? fn : "",
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: true,
      platform: "node:javascript",
    });
    if (frames.length === MAX_FRAMES) break;
  }
  return frames.reverse();
}

/**
 * A Paseo RPC error (`DaemonRpcError` of @getpaseo/client, matched by name because the host's
 * client is another copy) as `requestType:code`, each part only when the whole of it is an
 * identifier, lowercased: which call failed and Paseo's reason, never its message.
 */
function rpcValue(error: { requestType?: unknown; code?: unknown }): string {
  const part = (v: unknown) => (typeof v === "string" && rpcIdentifier.test(v.toLowerCase()) ? v.toLowerCase() : "");
  const requestType = part(error.requestType);
  const code = part(error.code);
  return code ? `${requestType}:${code}` : requestType;
}

export function exceptionReport(error: unknown, source: string, handled: boolean, base = root): ExceptionReport {
  const isError = error instanceof Error;
  const name = isError ? error.name : "";
  const type = !isError ? "NonError" : identifier.test(name) ? name : "Error";
  const code = isError ? (error as NodeJS.ErrnoException).code : undefined;
  const value = name === "DaemonRpcError" ? rpcValue(error as Error & { requestType?: unknown; code?: unknown })
    : typeof code === "string" && safeCode.test(code) ? code : "";
  const frames = isError ? ownFrames(error.stack ?? "", base) : [];
  const label = source.replace(/:$/, "").trim();
  const safe = safeSource.test(label) ? label : "other";
  const key = [type, value, safe, ...frames.map((f) => `${f.filename}:${f.function}:${f.lineno}`)].join("|");
  return { type, value, source: safe, handled, frames, fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 32) };
}

/**
 * Failures outside Flowly's control, never reported (§11.2): the daemon connection dropped
 * (`DaemonConnectionError`, matched by name because the host's client is a separate copy), the
 * local daemon is unavailable (restarting, no local credential) and every summary model failed
 * (provider or model trouble; the card or insight shows the error).
 */
export function outsideError(error: unknown) {
  return error instanceof LocalDaemonUnavailable || error instanceof SummaryModelError || (error instanceof Error && error.name === "DaemonConnectionError");
}

/**
 * Errors an RPC handler throws on purpose, as its answer to the caller (validation, conflicts,
 * disabled features): not reported. A plain `Error` without a system code is such a message too.
 */
export function expectedRpcError(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error instanceof ToolError || error instanceof MemoryError || error instanceof GuardrailError || error instanceof StoreInvalidError || error instanceof ExternalError || error instanceof ZodError || outsideError(error))
    return true;
  return error.constructor === Error && typeof (error as NodeJS.ErrnoException).code !== "string";
}

type Sink = (source: string, error: unknown, handled: boolean) => void;
let sink: Sink | null = null;

/** Set by the plugin once telemetry exists; null stops reporting (unload). */
export function setErrorSink(next: Sink | null) {
  sink = next;
}

export function reportError(source: string, error: unknown, handled = true) {
  try {
    sink?.(source, error, handled);
  } catch {
    // Reporting never affects the caller.
  }
}

/**
 * Logs a background failure (label, optional log-only context, message) and reports it unless it
 * is an `outsideError`. Every daemon-side error log goes through here; `server/error-report.test.ts`
 * fails on a bare `console.error` elsewhere. `context` (ids, paths) is printed but never reported.
 */
export function logFailure(label: string, error: unknown, context?: string) {
  const text = error instanceof Error ? error.message : String(error);
  if (context) console.error(label, context, text);
  else console.error(label, text);
  if (!outsideError(error)) reportError(label, error);
}

/** The plugin context with every RPC handler's unexpected failures reported, then rethrown unchanged. */
export function reportRpcErrors(server: PluginServerContext): PluginServerContext {
  const handle: PluginServerContext["handle"] = (contract, handler) =>
    server.handle(contract, (input, context) => {
      const fail = (error: unknown): never => {
        if (!expectedRpcError(error)) reportError(`rpc ${contract.name}`, error);
        throw error;
      };
      try {
        const out = handler(input, context);
        return out instanceof Promise ? out.catch(fail) : out;
      } catch (error) {
        return fail(error);
      }
    });
  return new Proxy(server, {
    get(target, key) {
      if (key === "handle") return handle;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
