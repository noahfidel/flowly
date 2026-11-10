import { afterEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { outsideError } from "./error-report";
import { daemonTarget, LocalDaemonUnavailable, openLocalDaemon, readListen } from "./local-daemon";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("every listen form Paseo writes resolves to a WebSocket target", () => {
  expect(daemonTarget("127.0.0.1:6767")).toEqual({ url: "ws://127.0.0.1:6767/ws" });
  expect(daemonTarget("localhost:6767")).toEqual({ url: "ws://localhost:6767/ws" });
  expect(daemonTarget("[::1]:6767")).toEqual({ url: "ws://[::1]:6767/ws" });
  expect(daemonTarget("6767")).toEqual({ url: "ws://127.0.0.1:6767/ws" });
  expect(daemonTarget("tcp://127.0.0.1:6767?ssl=false")).toEqual({ url: "ws://127.0.0.1:6767/ws" });
  expect(daemonTarget("/run/user/1000/paseo.sock")).toEqual({ url: "ws://localhost/ws", socketPath: "/run/user/1000/paseo.sock" });
  expect(daemonTarget("unix:///tmp/paseo.sock")).toEqual({ url: "ws://localhost/ws", socketPath: "/tmp/paseo.sock" });
  expect(daemonTarget("~/.paseo/paseo.sock")).toEqual({ url: "ws://localhost/ws", socketPath: join(homedir(), ".paseo/paseo.sock") });
  expect(daemonTarget("\\\\.\\pipe\\paseo")).toEqual({ url: "ws://localhost/ws", socketPath: "\\\\.\\pipe\\paseo" });
  expect(daemonTarget("pipe://\\\\.\\pipe\\paseo")).toEqual({ url: "ws://localhost/ws", socketPath: "\\\\.\\pipe\\paseo" });
});

test("no address (the supervisor is restarting the worker) is a distinct, unavailable state", () => {
  for (const listen of [null, undefined, "", "  "]) expect(() => daemonTarget(listen)).toThrow(LocalDaemonUnavailable);
  expect(() => daemonTarget("not an address")).toThrow(/not a local endpoint/);
  expect(() => daemonTarget("unix://")).toThrow(/no socket path/);
});

test("a daemon on a Unix socket is reached through that socket with the local credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "flowly-ld-"));
  dirs.push(home);
  const socketPath = join(home, "d.sock");
  const token = "a".repeat(43);
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ pid: 1, listen: socketPath }));
  await writeFile(join(home, "local-credential"), `${token}\n`);
  const server = createServer();
  servers.push(server);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const hello = new Promise<string>((resolve) =>
    wss.on("connection", (socket) =>
      socket.once("message", (data) => {
        resolve(String(data));
        socket.close();
      }),
    ),
  );
  await new Promise<void>((r) => server.listen(socketPath, r));
  // The fake daemon closes after the hello, so the connection itself fails.
  const opened = openLocalDaemon(home, "flowly-test", [], "").catch((e: unknown) => e);
  expect(await hello).toContain(token);
  expect(await opened).toBeInstanceOf(Error);
});

async function paseoHome(pid?: string) {
  const home = await mkdtemp(join(tmpdir(), "flowly-ld-"));
  dirs.push(home);
  if (pid !== undefined) await writeFile(join(home, "paseo.pid"), pid);
  return home;
}

test("paseo.pid read while Paseo rewrites it in place is retried until it is complete", async () => {
  const home = await paseoHome("");
  const read = readListen(home, 200);
  // Written after the first read saw it empty, well before the retries run out.
  await new Promise((r) => setTimeout(r, 25));
  await writeFile(join(home, "paseo.pid"), '{"pid":1,"listen":"127.0.0.1:6767"}');
  expect(await read).toBe("127.0.0.1:6767");
});

test("a paseo.pid that is missing, or still empty or half written after the retries, means no daemon to reach", async () => {
  await expect(readListen(await paseoHome(), 1)).rejects.toBeInstanceOf(LocalDaemonUnavailable);
  for (const pid of ["", '{"pid":1,"lis', "null"])
    await expect(readListen(await paseoHome(pid), 1)).rejects.toBeInstanceOf(LocalDaemonUnavailable);
});

test("a refused connection to the daemon is unavailable, not a Flowly failure", async () => {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  // Nothing listens there any more: the connection is refused.
  await new Promise((r) => server.close(r));
  servers.splice(servers.indexOf(server), 1);
  const home = await paseoHome(JSON.stringify({ pid: 1, listen: `127.0.0.1:${port}` }));
  await writeFile(join(home, "local-credential"), "a".repeat(43));
  const error = await openLocalDaemon(home, "flowly-test", [], "").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LocalDaemonUnavailable);
  expect(outsideError(error)).toBe(true);
});

test("a daemon that rejects the local credential is reported, not treated as unavailable", async () => {
  const home = await paseoHome();
  const socketPath = join(home, "d.sock");
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ pid: 1, listen: socketPath }));
  await writeFile(join(home, "local-credential"), "a".repeat(43));
  const server = createServer();
  servers.push(server);
  new WebSocketServer({ server, path: "/ws" }).on("connection", (socket) => socket.close(4001, "Incorrect password"));
  await new Promise<void>((r) => server.listen(socketPath, r));
  const error = await openLocalDaemon(home, "flowly-test", [], "").catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(LocalDaemonUnavailable);
  expect((error as Error).name).toBe("DaemonAuthenticationError");
  expect(outsideError(error)).toBe(false);
});
