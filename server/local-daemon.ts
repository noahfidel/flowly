import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/**
 * The local daemon cannot be reached right now for a reason outside Flowly: it
 * is not running, restarting (no address yet, `paseo.pid` being rewritten),
 * does not answer the connection, or this Paseo has no local credential. Logged,
 * not reported to telemetry (TELEMETRY-SPEC §11.2).
 */
export class LocalDaemonUnavailable extends Error {
  override name = "LocalDaemonUnavailable";
}

export type DaemonTarget = { url: string; socketPath?: string };

/**
 * Where the daemon listens, from `paseo.pid`'s `listen`, read the way the
 * `paseo` CLI reads it (Paseo 0.13 `resolveDaemonTarget`): `host:port`, a bare
 * port, `tcp://host:port`, a Unix socket (`/path`, `~/path`, `unix://path`) or
 * a Windows named pipe (`\\.\pipe\name`, `pipe://name`). For a socket or pipe the
 * URL is a placeholder; `openLocalDaemon` connects through `socketPath`.
 */
export function daemonTarget(listen: unknown): DaemonTarget {
  const value = typeof listen === "string" ? listen.trim() : "";
  if (!value) throw new LocalDaemonUnavailable("The Paseo daemon has no address yet; it may be restarting.");
  const ipc = /^unix:\/\//.test(value) ? value.slice(7)
    : /^pipe:\/\//.test(value) ? value.slice(7)
      : value.startsWith("\\\\.\\pipe\\") || value.startsWith("/") || value.startsWith("~") ? value
        : null;
  if (ipc !== null) {
    const socketPath = ipc.trim().replace(/^~(?=[/\\]|$)/, homedir());
    if (!socketPath) throw new Error("The Paseo daemon address has no socket path.");
    return { url: "ws://localhost/ws", socketPath };
  }
  const tcp = value.replace(/^tcp:\/\//, "").replace(/[/?].*$/, "");
  const endpoint = /^\d+$/.test(tcp) ? `127.0.0.1:${tcp}` : tcp;
  if (!/^[\w.-]+:\d+$|^\[[\da-f:]+\]:\d+$/i.test(endpoint))
    throw new Error("The Paseo daemon address is not a local endpoint.");
  return { url: `ws://${endpoint}/ws` };
}

/** Paseo's own `readPidLock` (0.15 `pid-lock.ts`) reads this often before giving up. */
const PID_READ_ATTEMPTS = 10;
const PID_READ_DELAY_MS = 50;

/**
 * `paseo.pid`'s `listen`. Paseo writes the file in place (created empty, then written; `listen`
 * set later by truncating and rewriting), so a read can see it empty or half written: retry like
 * Paseo's own reader. No file, or still unreadable, means no daemon to reach right now.
 */
export async function readListen(home: string, delayMs = PID_READ_DELAY_MS): Promise<unknown> {
  const path = join(home, "paseo.pid");
  for (let attempt = 1; ; attempt++) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new LocalDaemonUnavailable("The Paseo daemon is not running (no paseo.pid).");
      throw e;
    }
    try {
      const lock = JSON.parse(content) as { listen?: unknown } | null;
      if (lock && typeof lock === "object") return lock.listen;
    } catch {
      // Empty or half written: Paseo is rewriting it.
    }
    if (attempt === PID_READ_ATTEMPTS)
      throw new LocalDaemonUnavailable("The Paseo daemon state (paseo.pid) is being rewritten; it may be restarting.");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * COMPAT(sdk-local-daemon): a short-lived local daemon connection for the few
 * daemon calls the plugin SDK (`PaseoApi`, @getpaseo/client 0.11.2) does not
 * expose yet: workspace restore, session unarchive (WORKSPACE-RESTORE-SPEC) and
 * clearing a session's native attention (SESSION-ATTENTION-SPEC). Connects the
 * way the `paseo` CLI does: the address from `paseo.pid` and the local
 * credential file. The token is never logged. `methods` must exist on this
 * Paseo version, otherwise `unsupported` is thrown. Callers close the client.
 */
export async function openLocalDaemon(
  home: string,
  clientId: string,
  methods: readonly (keyof DaemonClient)[],
  unsupported: string,
): Promise<DaemonClient> {
  const target = daemonTarget(await readListen(home));
  const token = (await readFile(join(home, "local-credential"), "utf8").catch(() => "")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new LocalDaemonUnavailable("The Paseo local credential is unavailable.");
  const socketPath = target.socketPath;
  const client = new DaemonClient({
    url: target.url,
    clientId,
    clientType: "cli",
    localCredential: () => token,
    reconnect: { enabled: false },
    connectTimeoutMs: 5000,
    // Node's built-in WebSocket cannot use a socket; `ws` can, given the connection. `net`
    // opens Unix sockets and Windows named pipes alike.
    ...(socketPath
      ? { webSocketFactory: (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }) =>
          new WebSocket(url, options?.protocols, { headers: options?.headers, createConnection: () => connect(socketPath) }) as never }
      : {}),
  });
  try {
    // With reconnect off, a daemon that is starting, restarting or busy rejects with a plain
    // Error (timeout, refused, closed): not Flowly's failure. A rejected local credential
    // (`DaemonAuthenticationError`) is not a busy daemon, so it stays reported.
    await client.connect().catch((e: unknown) => {
      if (e instanceof Error && e.name === "DaemonAuthenticationError") throw e;
      throw new LocalDaemonUnavailable(`The Paseo daemon could not be reached: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    });
    for (const method of methods)
      if (typeof client[method] !== "function") throw new Error(unsupported);
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }
  return client;
}
