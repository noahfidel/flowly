import { afterEach, describe, expect, test } from "vitest";
import { githubApiRoot, githubSummary } from "./github";
import { fakeService, fixtures, type Route } from "./fake";
import { fingerprintChanged } from "./fingerprint";
import { refKey } from "./service";

const env = fixtures();
afterEach(() => env.cleanup());

type Item = { repo: string; number: number; pull?: boolean; title: string; state?: string; merged?: boolean; sha?: string; comments?: { id: number; body: string }[]; reviews?: { id: number; state: string; body?: string }[] };

function github(items: Item[], root = "https://api.github.com") {
  const issue = (x: Item) => ({
    id: 5000 + x.number,
    number: x.number,
    title: x.title,
    body: "Body text",
    state: x.state || "open",
    html_url: `https://github.com/${x.repo}/${x.pull ? "pull" : "issues"}/${x.number}`,
    user: { login: "ada" },
    assignees: [{ login: "bob" }],
    labels: [{ name: "bug" }],
    comments: (x.comments || []).length,
    updated_at: "2026-10-19T08:00:00Z",
    ...(x.pull ? { pull_request: { merged_at: x.merged ? "2026-10-19T09:00:00Z" : null }, draft: false } : {}),
  });
  const route: Route = (url) => {
    if (!url.href.startsWith(root)) return { status: 404 };
    const path = url.href.slice(root.length).split("?")[0]!;
    if (path === "/user") return { body: { login: "ada", name: "Ada Lovelace" } };
    if (path === "/search/issues") {
      const q = url.searchParams.get("q") || "";
      // Like GitHub since 2025: a query without the kind is rejected.
      const pulls = /(^| )is:pull-request( |$)/.test(q);
      if (!pulls && !/(^| )is:issue( |$)/.test(q)) return { status: 422, body: { message: "Query must include 'is:issue' or 'is:pull-request'" } };
      const repos = [...q.matchAll(/repo:(\S+)/g)].map((m) => m[1]);
      const text = q.replace(/\S+:\S+/g, "").trim().toLowerCase();
      return { body: { items: items.filter((x) => !!x.pull === pulls && (!repos.length || repos.includes(x.repo)) && x.title.toLowerCase().includes(text)).map(issue) } };
    }
    const one = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)(\/comments|\/reviews|\/files)?$/.exec(path);
    if (one) {
      const found = items.find((x) => x.repo.toLowerCase() === one[1]!.toLowerCase() && x.number === Number(one[3]));
      if (!found || (one[2] === "pulls" && !found.pull)) return { status: 404, body: { message: "Not Found" } };
      if (one[4] === "/comments") return { body: (found.comments || []).map((c) => ({ ...c, user: { login: "cy" }, created_at: "2026-10-19T09:00:00Z", updated_at: "2026-10-19T09:00:00Z" })) };
      if (one[4] === "/reviews") return { body: (found.reviews || []).map((r) => ({ ...r, user: { login: "dee" }, submitted_at: "2026-10-19T10:00:00Z" })) };
      if (one[4] === "/files") return { body: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 }] };
      if (one[2] === "pulls") return { body: { merged: !!found.merged, head: { ref: "fix/x", sha: found.sha || "aaa111" }, base: { ref: "main" }, additions: 3, deletions: 1, changed_files: 1, requested_reviewers: [{ login: "eve" }] } };
      return { body: issue(found) };
    }
    return undefined;
  };
  return fakeService(route);
}

async function connected(items: Item[], repos: string[] = []) {
  const fake = github(items);
  const service = await env.service(fake.fetchImpl);
  service.projectRepos = async () => repos;
  const connection = await service.save({ provider: "github", baseUrl: "", secret: "ghp_secret" });
  return { service, connection, ...fake };
}

describe("GitHub (CONNECTORS-SPEC §6)", () => {
  test("github.com is the default address and talks to api.github.com; Enterprise uses /api/v3", async () => {
    const x = await connected([]);
    expect(x.connection).toMatchObject({ provider: "github", baseUrl: "https://github.com", account: "Ada Lovelace (@ada)" });
    expect(x.calls[0]!.url.href).toBe("https://api.github.com/user");
    expect(x.calls[0]!.headers.Authorization).toBe("Bearer ghp_secret");
    expect(x.calls[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(githubApiRoot("https://github.example.com")).toBe("https://github.example.com/api/v3");
    const ghes = github([], "https://github.example.com/api/v3");
    const service = await env.service(ghes.fetchImpl);
    await service.save({ provider: "github", baseUrl: "https://github.example.com", secret: "t" });
    expect(ghes.calls[0]!.url.href).toBe("https://github.example.com/api/v3/user");
  });

  test("an /issues/ link that is really a pull request is stored as a pull request", async () => {
    const x = await connected([{ repo: "acme/web", number: 12, pull: true, title: "Fix login" }]);
    const found = await x.service.recognize("https://github.com/acme/web/issues/12");
    expect(found).toMatchObject({ external: { itemType: "pull", key: "acme/web#12", remoteId: "5012" }, url: "https://github.com/acme/web/pull/12", title: "acme/web#12 Fix login" });
    const detail = await x.service.detail(found!.external);
    expect(detail.summary.itemType).toBe("pull");
    // Recent lists issues and pull requests together (two searches, one per kind).
    expect((await x.service.search({ connectionId: x.connection.id, query: "" })).results.map((r) => [r.key, r.itemType])).toEqual([["acme/web#12", "pull"]]);
  });

  test("picker: open items I'm involved in, numbers and text in the project's repositories, or everything I'm involved in", async () => {
    const x = await connected(
      [
        { repo: "acme/web", number: 12, title: "Fix login" },
        { repo: "acme/api", number: 3, title: "Login timeout" },
      ],
      ["acme/web"],
    );
    await x.service.search({ connectionId: x.connection.id, query: "" });
    expect(x.calls.slice(-2).map((c) => c.url.searchParams.get("q")).sort()).toEqual(["is:issue is:open involves:@me archived:false", "is:pull-request is:open involves:@me archived:false"]);
    expect((await x.service.search({ connectionId: x.connection.id, query: "#12", projectId: "p" })).results.map((r) => r.key)).toEqual(["acme/web#12"]);
    expect((await x.service.search({ connectionId: x.connection.id, query: 'login "x:y', projectId: "p" })).results).toEqual([]);
    expect(x.calls.at(-1)!.url.searchParams.get("q")).toMatch(/^is:(issue|pull-request) login x y in:title repo:acme\/web$/);
    expect((await x.service.search({ connectionId: x.connection.id, query: "login", projectId: "p" })).results.map((r) => r.key)).toEqual(["acme/web#12"]);
    await x.service.search({ connectionId: x.connection.id, query: "login", projectId: "p", all: true });
    expect(x.calls.at(-1)!.url.searchParams.get("q")).toMatch(/^is:(issue|pull-request) login in:title involves:@me$/);
  });

  test("full pull request: branches, head, files, reviews and comments; a new push changes the fingerprint", async () => {
    const items: Item[] = [{ repo: "acme/web", number: 12, pull: true, title: "Fix login", comments: [{ id: 1, body: "LGTM?" }], reviews: [{ id: 9, state: "CHANGES_REQUESTED", body: "Add a test" }, { id: 10, state: "COMMENTED", body: "" }] }];
    const x = await connected(items);
    const ref = { connectionId: x.connection.id, provider: "github" as const, itemType: "pull" as const, key: "acme/web#12", remoteId: "" };
    const first = await x.service.detail(ref);
    for (const part of ["# acme/web#12 Fix login", "- Status: Open", "- Branches: fix/x → main", "- Head: aaa111", "- Requested reviewers: eve", "- src/a.ts +3 −1", "### dee · changes requested", "Add a test", "### cy", "LGTM?", "fetch the head branch with git"])
      expect(first.markdown).toContain(part);
    expect(first.markdown).not.toContain("### dee · commented");
    items[0]!.sha = "bbb222";
    const pushed = await x.service.detail(ref, true);
    expect(pushed.fingerprint).not.toBe(first.fingerprint);
    // A push does not move the discussion part, a new review does (what an output PR watches).
    expect(fingerprintChanged("output", first.fingerprint, pushed.fingerprint)).toBe(false);
    items[0]!.reviews!.push({ id: 11, state: "APPROVED", body: "ok" });
    expect(fingerprintChanged("output", pushed.fingerprint, (await x.service.detail(ref, true)).fingerprint)).toBe(true);
    items[0]!.state = "closed";
    items[0]!.merged = true;
    expect((await x.service.detail(ref, true)).summary.status).toBe("Merged");
  });

  test("the key falls back to the API repository when the web address uses another host", () => {
    const summary = githubSummary({ id: "c", baseUrl: "https://github.example.com" }, { id: 1, number: 7, title: "T", html_url: "https://ghe-proxy.example.com/acme/web/issues/7", repository_url: "https://github.example.com/api/v3/repos/acme/web" });
    expect(summary).toMatchObject({ key: "acme/web#7", container: "acme/web", url: "https://ghe-proxy.example.com/acme/web/issues/7" });
  });

  test("the summary carries the author's login, empty when GitHub names none", () => {
    const base = { id: "c", baseUrl: "https://github.com" };
    expect(githubSummary(base, { id: 1, number: 7, title: "T", html_url: "https://github.com/acme/web/pull/7", user: { login: "ada" }, pull_request: {} })).toMatchObject({ author: "ada" });
    expect(githubSummary(base, { id: 1, number: 7, title: "T", html_url: "https://github.com/acme/web/pull/7" })).toMatchObject({ author: "" });
  });

  test("a rate-limit 403 waits instead of marking the token refused; other 403s are not found", async () => {
    let mode: "ok" | "limited" | "forbidden" = "ok";
    const fake = github([{ repo: "acme/web", number: 1, title: "A" }]);
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (mode === "limited") return new Response("{}", { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 30) } });
      if (mode === "forbidden") return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      return fake.fetchImpl(input, init);
    }) as typeof fetch;
    const service = await env.service(fetchImpl);
    const c = await service.save({ provider: "github", baseUrl: "https://github.com", secret: "t" });
    mode = "forbidden";
    await expect(service.recognize("https://github.com/acme/web/issues/1")).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" });
    mode = "limited";
    await expect(service.search({ connectionId: c.id, query: "" })).rejects.toMatchObject({ code: "EXTERNAL_UNAVAILABLE" });
    expect((await service.list())[0]!.authFailed).toBe(false);
    expect(new Set(fake.calls.map((x) => x.method))).toEqual(new Set(["GET"]));
  });

  test("a renamed repository (301) is reported as moved, never followed, and doesn't pause the connection", async () => {
    let moved = false;
    const fake = github([{ repo: "acme/web", number: 1, title: "A" }]);
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      if (moved && String(input).includes("/repos/")) return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/1" } });
      return fake.fetchImpl(input, init);
    }) as typeof fetch;
    const service = await env.service(fetchImpl);
    const c = await service.save({ provider: "github", baseUrl: "https://github.com", secret: "t" });
    moved = true;
    await expect(service.recognize("https://github.com/acme/web/issues/1")).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND", message: expect.stringMatching(/moved/) });
    // Not a backoff: the next request goes out.
    expect((await service.search({ connectionId: c.id, query: "" })).results).toHaveLength(1);
  });
});

test("a badge read by a key in another case than GitHub's is cached under that key too, so the next read needs no call (PR-MENU-SPEC §3.2)", async () => {
  const x = await connected([{ repo: "Acme/Web", number: 42, pull: true, title: "Fix" }]);
  const ref = { connectionId: x.connection.id, provider: "github" as const, key: "acme/web#42", remoteId: "", itemType: "pull" as const };
  const first = await x.service.badges([ref]);
  expect(first.get(refKey(ref))?.summary.status).toBe("Open");
  const calls = x.calls.length;
  const again = await x.service.badges([ref]);
  expect(again.get(refKey(ref))).toMatchObject({ stale: false, summary: { status: "Open" } });
  expect(x.calls.length).toBe(calls);
  // The cache-only read answers by that key as well.
  expect((await x.service.cachedBadges([ref])).get(refKey(ref))).toMatchObject({ expired: false, summary: { status: "Open" } });
});
