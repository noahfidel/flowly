import { afterEach, describe, expect, test } from "vitest";
import { fakeService, fixtures, type Route } from "./fake";
import { fingerprintChanged } from "./fingerprint";
import { recentFilter } from "./linear";

const env = fixtures();
afterEach(() => env.cleanup());

const api = "https://api.linear.app/graphql";
const workspace = "https://linear.app/acme";

type Issue = {
  key: string;
  title: string;
  state?: string;
  type?: string;
  assignee?: string | null;
  mine?: boolean;
  description?: string;
  updated?: string;
  priority?: string;
  comments?: { id: string; body: string; at: string; updated?: string }[];
};
type Request = { query: string; variables: Record<string, unknown> };
type Options = { status?: number; errors?: { message: string; extensions?: { code: string } }[]; headers?: Record<string, string> };

const uuid = (key: string) => `uuid-${key.toLowerCase()}`;

/** Linear's GraphQL API as recorded shapes: the operations the adapter sends, answered from `issues`. */
function linear(issues: Issue[], options: () => Options = () => ({})) {
  const summary = (x: Issue) => ({
    id: uuid(x.key),
    identifier: x.key,
    title: x.title,
    url: `${workspace}/issue/${x.key}/${x.title.toLowerCase().replace(/\W+/g, "-")}`,
    updatedAt: x.updated || "2026-11-01T08:00:00.000Z",
    priorityLabel: x.priority ?? "High",
    state: { name: x.state || "In Progress", type: x.type || "started" },
    assignee: x.assignee === null ? null : { name: "bob", displayName: x.assignee || "Bob" },
    team: { key: x.key.split("-")[0], name: "Engineering" },
  });
  const full = (x: Issue) => ({
    ...summary(x),
    description: x.description ?? "Steps:\n\n- open the app\n- sign in",
    creator: { name: "ada", displayName: "Ada" },
    project: { name: "Checkout" },
    labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
    parent: { identifier: "ENG-1", title: "Login epic" },
    // Newest first, as Linear orders createdAt.
    comments: { nodes: [...(x.comments || [])].reverse().map((c) => ({ id: c.id, body: c.body, createdAt: c.at, updatedAt: c.updated || c.at, user: { name: "rev", displayName: "Reviewer" } })) },
  });
  const notFound = { message: "Entity not found: Issue", extensions: { code: "INVALID_INPUT" } };
  const requests: Request[] = [];
  const route: Route = (url, body) => {
    if (`${url.origin}${url.pathname}` !== api) return undefined;
    const request = JSON.parse(body || "{}") as Request;
    requests.push(request);
    const o = options();
    if (o.status || o.errors) return { status: o.status ?? 200, body: { errors: o.errors || [] }, headers: o.headers };
    const { query, variables } = request;
    if (query.startsWith("query Viewer")) return { body: { data: { viewer: { name: "Ada Lovelace", displayName: "ada", email: "ada@acme.test", organization: { name: "Acme", urlKey: "acme" } } } } };
    if (query.startsWith("query Issue(")) {
      const found = issues.find((x) => x.key === variables.id);
      if (!found) return { body: { data: { issue: null }, errors: [notFound] } };
      return { body: { data: { issue: query.includes("comments") ? full(found) : summary(found) } } };
    }
    if (query.startsWith("query Issues")) {
      const filter = variables.filter as { assignee?: unknown; number?: { eq: number }; and?: { title: { containsIgnoreCase: string } }[] };
      const matches = issues.filter((x) => {
        if (filter.assignee) return x.mine !== false && !["completed", "canceled"].includes(x.type || "started");
        if (filter.number) return x.key.endsWith(`-${filter.number.eq}`);
        return (filter.and || []).every((c) => x.title.toLowerCase().includes(c.title.containsIgnoreCase.toLowerCase()));
      });
      return { body: { data: { issues: { nodes: matches.map(summary) } } } };
    }
    if (query.startsWith("query Batch")) {
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const [name, key] of Object.entries(variables)) {
        const found = issues.find((x) => x.key === key);
        data[name.replace("k", "i")] = found ? summary(found) : null;
        if (!found) errors.push({ ...notFound, path: [name.replace("k", "i")] });
      }
      return { body: { data, ...(errors.length ? { errors } : {}) } };
    }
    return { status: 400, body: { errors: [{ message: "Unknown operation", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } };
  };
  return { ...fakeService(route), requests };
}

async function connected(issues: Issue[], options?: () => Options) {
  const fake = linear(issues, options);
  const service = await env.service(fake.fetchImpl);
  const connection = await service.save({ provider: "linear", secret: "lin_api_secret" });
  return { service, connection, ...fake };
}

const ref = (connectionId: string, key: string) => ({ connectionId, provider: "linear" as const, itemType: "issue" as const, key, remoteId: uuid(key) });

describe("Linear (CONNECTORS-SPEC §14)", () => {
  test("connecting sends the key without Bearer to the fixed API and takes the workspace address from the account", async () => {
    const x = await connected([]);
    expect(x.connection).toMatchObject({ provider: "linear", baseUrl: workspace, name: "linear.app/acme", account: "Ada Lovelace (ada@acme.test)" });
    expect(x.calls[0]!.method).toBe("POST");
    expect(x.calls[0]!.url.href).toBe(api);
    expect(x.calls[0]!.headers.Authorization).toBe("lin_api_secret");
    expect(JSON.stringify(await x.service.list())).not.toContain("lin_api_secret");
    // Editing keeps the stored key although the saved address (the workspace) differs from the fixed API.
    const edited = await x.service.save({ id: x.connection.id, provider: "linear", name: "Acme Linear" });
    expect(edited).toMatchObject({ id: x.connection.id, name: "Acme Linear", baseUrl: workspace });
    expect(x.calls.at(-1)!.headers.Authorization).toBe("lin_api_secret");
    // An address typed by hand is ignored: the key only ever goes to api.linear.app.
    await x.service.test({ provider: "linear", baseUrl: "https://evil.example.com", secret: "other" });
    expect(x.calls.every((c) => c.url.href === api)).toBe(true);
  });

  test("a refused key is not saved: HTTP 401, or a 400 with AUTHENTICATION_ERROR", async () => {
    const unauthorized = linear([], () => ({ status: 401 }));
    await expect((await env.service(unauthorized.fetchImpl)).save({ provider: "linear", secret: "bad" })).rejects.toThrow(/refused the token/);
    const refused = linear([], () => ({ status: 400, errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] }));
    const service = await env.service(refused.fetchImpl);
    await expect(service.save({ provider: "linear", secret: "bad" })).rejects.toThrow(/refused the token/);
    expect(await service.list()).toEqual([]);
  });

  test("issue links and keys become inputs; other workspaces don't match and missing issues are not found", async () => {
    const x = await connected([{ key: "ENG-42", title: "Login retry loops" }]);
    expect(await x.service.recognize(`${workspace}/issue/ENG-42/login-retry-loops#comment-9f`)).toMatchObject({
      external: { provider: "linear", itemType: "issue", key: "ENG-42", remoteId: uuid("ENG-42") },
      url: `${workspace}/issue/ENG-42/login-retry-loops`,
      title: "ENG-42 Login retry loops",
    });
    expect((await x.service.recognize("eng-42"))!.external.key).toBe("ENG-42");
    expect(x.requests.at(-1)!.variables).toEqual({ id: "ENG-42" });
    expect(await x.service.recognize("https://linear.app/other/issue/ENG-42/login")).toBeNull();
    await expect(x.service.recognize(`${workspace}/issue/ENG-99`)).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" });
    // A bare key that doesn't exist may be something else (a file name): it stays a plain target.
    expect(await x.service.recognize("ENG-99")).toBeNull();
  });

  test("picker: my open issues by update time, a key, a number across teams, and title words as variables", async () => {
    const x = await connected([
      { key: "ENG-7", title: "Old login bug", updated: "2026-10-01T00:00:00.000Z", priority: "No priority", type: "backlog", state: "Backlog" },
      { key: "ENG-42", title: "Login retry loops", updated: "2026-11-02T00:00:00.000Z", assignee: "Bob B." },
      { key: "OPS-42", title: "Rotate keys", updated: "2026-10-20T00:00:00.000Z", mine: false },
      { key: "ENG-50", title: "Shipped", type: "completed", state: "Done" },
    ]);
    const recent = await x.service.search({ connectionId: x.connection.id, query: "" });
    expect(recent.results.map((r) => r.key)).toEqual(["ENG-42", "ENG-7"]);
    expect(x.requests.at(-1)!.variables).toEqual({ filter: recentFilter, first: 10 });
    expect(recent.results[0]).toMatchObject({ itemType: "issue", status: "In Progress", statusCategory: "indeterminate", priority: "High", assignee: "Bob B.", container: "Engineering", type: "" });
    expect(recent.results[1]).toMatchObject({ statusCategory: "new", priority: "" });

    expect((await x.service.search({ connectionId: x.connection.id, query: "OPS-42" })).results.map((r) => r.key)).toEqual(["OPS-42"]);
    expect((await x.service.search({ connectionId: x.connection.id, query: "ENG-404" })).results).toEqual([]);
    expect((await x.service.search({ connectionId: x.connection.id, query: "42" })).results.map((r) => r.key)).toEqual(["ENG-42", "OPS-42"]);
    expect(x.requests.at(-1)!.variables).toEqual({ filter: { number: { eq: 42 } }, first: 20 });

    const words = 'login "retry" }) { mutation';
    expect((await x.service.search({ connectionId: x.connection.id, query: words })).results).toEqual([]);
    const sent = x.requests.at(-1)!;
    expect(sent.variables.filter).toEqual({ and: ["login", '"retry"', "})", "{", "mutation"].map((w) => ({ title: { containsIgnoreCase: w } })) });
    // User text never reaches the query document.
    expect(sent.query).not.toContain("retry");
    expect((await x.service.search({ connectionId: x.connection.id, query: "LOGIN loops" })).results.map((r) => r.key)).toEqual(["ENG-42"]);
  });

  test("full issue as Markdown; description or comments change the fingerprint, state and assignee don't", async () => {
    const issues: Issue[] = [{ key: "ENG-42", title: "Login retry loops", description: "It loops.\n\n```\nretry()\n```", comments: [{ id: "c1", body: "Can reproduce", at: "2026-11-01T09:00:00.000Z" }, { id: "c2", body: "On Safari only", at: "2026-11-01T10:00:00.000Z" }] }];
    const x = await connected(issues);
    const first = await x.service.detail(ref(x.connection.id, "ENG-42"));
    for (const part of [
      "# ENG-42 Login retry loops",
      `${workspace}/issue/ENG-42/login-retry-loops`,
      "- State: In Progress",
      "- Priority: High",
      "- Assignee: Bob",
      "- Created by: Ada",
      "- Team: Engineering (ENG)",
      "- Project: Checkout",
      "- Labels: bug, auth",
      "- Parent: ENG-1 Login epic",
      "## Description",
      "```\nretry()\n```",
      "## Comments (latest 2)",
      "### Reviewer · 2026-11-01T09:00:00.000Z",
    ])
      expect(first.markdown).toContain(part);
    // Oldest comment first, whatever order the API sent.
    expect(first.markdown.indexOf("Can reproduce")).toBeLessThan(first.markdown.indexOf("On Safari only"));
    issues[0]!.state = "Done";
    issues[0]!.type = "completed";
    issues[0]!.assignee = "Cy";
    const moved = await x.service.detail(ref(x.connection.id, "ENG-42"), true);
    expect(moved.summary.statusCategory).toBe("done");
    expect(moved.fingerprint).toBe(first.fingerprint);
    issues[0]!.description = "It loops twice.";
    const edited = await x.service.detail(ref(x.connection.id, "ENG-42"), true);
    expect(fingerprintChanged("input", first.fingerprint, edited.fingerprint)).toBe(true);
    issues[0]!.comments!.push({ id: "c3", body: "Fixed in 2.1", at: "2026-11-02T09:00:00.000Z" });
    expect(fingerprintChanged("output", edited.fingerprint, (await x.service.detail(ref(x.connection.id, "ENG-42"), true)).fingerprint)).toBe(true);
  });

  test("an empty description says so", async () => {
    const x = await connected([{ key: "ENG-3", title: "Blank", description: "" }]);
    expect((await x.service.detail(ref(x.connection.id, "ENG-3"))).markdown).toContain("## Description\n\n(empty)");
  });

  test("summaries for several cards come from one aliased request; missing issues are left out", async () => {
    const x = await connected([
      { key: "ENG-1", title: "A" },
      { key: "OPS-2", title: "B" },
    ]);
    const before = x.requests.length;
    const badges = await x.service.badges([ref(x.connection.id, "ENG-1"), ref(x.connection.id, "OPS-2"), ref(x.connection.id, "ENG-404")], true);
    expect(x.requests.length - before).toBe(1);
    expect(x.requests.at(-1)!.variables).toEqual({ k0: "ENG-1", k1: "OPS-2", k2: "ENG-404" });
    expect([...badges.values()].map((b) => b.summary.key).sort()).toEqual(["ENG-1", "OPS-2"]);
  });

  test("rate limits back off; a hidden issue is not found without disabling the connection; a refused key does", async () => {
    let options: Options = {};
    let now = 1_000_000;
    const fake = linear([{ key: "ENG-1", title: "A" }], () => options);
    const service = await env.service(fake.fetchImpl, () => now);
    const c = await service.save({ provider: "linear", secret: "k" });

    options = { status: 429, errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }], headers: { "retry-after": "30" } };
    await expect(service.search({ connectionId: c.id, query: "" })).rejects.toMatchObject({ code: "EXTERNAL_UNAVAILABLE", retryAfter: 30 });
    options = {};
    const sent = fake.calls.length;
    // Still inside the 30 s Linear asked for: no request goes out.
    await expect(service.search({ connectionId: c.id, query: "" })).rejects.toMatchObject({ code: "EXTERNAL_UNAVAILABLE" });
    expect(fake.calls.length).toBe(sent);
    now += 31_000;
    // The older form: HTTP 400 with RATELIMITED, and only the reset time (epoch ms) to go by.
    options = { status: 400, errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }], headers: { "x-ratelimit-requests-reset": String(Date.now() + 60_000) } };
    await expect(service.search({ connectionId: c.id, query: "" })).rejects.toMatchObject({ code: "EXTERNAL_UNAVAILABLE" });
    now += 301_000;

    options = { errors: [{ message: "You don't have access to this issue", extensions: { code: "FORBIDDEN" } }] };
    await expect(service.detail(ref(c.id, "ENG-1"))).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" });
    expect((await service.list())[0]!.authFailed).toBe(false);

    options = { status: 400, errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] };
    await expect(service.search({ connectionId: c.id, query: "" })).rejects.toMatchObject({ code: "EXTERNAL_AUTH" });
    expect((await service.list())[0]!.authFailed).toBe(true);
  });

  test("only POSTs of read-only queries to api.linear.app/graphql", async () => {
    const x = await connected([{ key: "ENG-1", title: "A", comments: [{ id: "c1", body: "x", at: "2026-11-01T00:00:00.000Z" }] }]);
    await x.service.search({ connectionId: x.connection.id, query: "" });
    await x.service.search({ connectionId: x.connection.id, query: "1" });
    await x.service.search({ connectionId: x.connection.id, query: "a b" });
    await x.service.detail(ref(x.connection.id, "ENG-1"));
    await x.service.badges([ref(x.connection.id, "ENG-1")], true);
    expect(x.calls.every((c) => c.method === "POST" && c.url.href === api)).toBe(true);
    expect(x.requests.length).toBeGreaterThanOrEqual(6);
    expect(x.requests.every((r) => /^query \w+/.test(r.query) && !/\bmutation\b/.test(r.query))).toBe(true);
  });
});
