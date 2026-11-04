import { vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorService } from "./service";

/** Test helpers for connector adapters: a routed fake service and services that clean up after themselves. */

export type Call = { method: string; url: URL; headers: Record<string, string>; body?: string };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; html?: boolean };
/** `body` is the request body of a POST (GraphQL, WIQL). */
export type Route = (url: URL, body?: string) => Reply | undefined;

export function fakeService(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method || "GET", url, headers: (init?.headers || {}) as Record<string, string>, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const reply = route(url, typeof init?.body === "string" ? init.body : undefined) ?? { status: 404, body: { message: "Not Found" } };
    const headers = { "content-type": reply.html ? "text/html" : "application/json", ...(reply.headers || {}) };
    return new Response(reply.html ? "<html>login</html>" : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

export function fixtures() {
  const roots: string[] = [];
  const services: ConnectorService[] = [];
  return {
    async service(fetchImpl: typeof fetch, clock?: () => number) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-connectors-")));
      roots.push(root);
      const service = new ConnectorService(join(root, "connectors"), fetchImpl, clock);
      services.push(service);
      return service;
    },
    async cleanup() {
      await Promise.all(services.splice(0).map((s) => s.flush()));
      await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
    },
  };
}
