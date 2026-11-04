import { afterEach, describe, expect, test } from "vitest";
import { fakeService, fixtures, type Route } from "./fake";
import { scopeFilter } from "./linear";

/** The Linear board's scope query and teams (LINEAR-BOARD-SPEC §3.1), against recorded-shape GraphQL replies. */

const env = fixtures();
afterEach(() => env.cleanup());

const api = "https://api.linear.app/graphql";
type Request = { query: string; variables: Record<string, unknown> };
type Node = { identifier: string; title?: string; type?: string; state?: string; updatedAt?: string; priority?: number; assignee?: string | null };

const node = (x: Node) => ({
  id: `uuid-${x.identifier.toLowerCase()}`,
  identifier: x.identifier,
  title: x.title || x.identifier,
  url: `https://linear.app/acme/issue/${x.identifier}/slug`,
  updatedAt: x.updatedAt || "2026-11-01T08:00:00.000Z",
  priority: x.priority ?? 0,
  priorityLabel: ["No priority", "Urgent", "High", "Medium", "Low"][x.priority ?? 0],
  state: { name: x.state || "Todo", type: x.type || "unstarted", position: 1 },
  assignee: x.assignee === null ? null : { name: "ada", displayName: x.assignee || "Ada" },
  team: { id: "team-eng", key: x.identifier.split("-")[0], name: "Engineering" },
});

/** Answers Viewer, Teams and Scope; Scope pages through `pages` by cursor. */
function linear(pages: Node[][], teams = [{ id: "t2", key: "OPS", name: "Operations" }, { id: "t1", key: "ENG", name: "Engineering" }]) {
  const requests: Request[] = [];
  const route: Route = (url, body) => {
    if (`${url.origin}${url.pathname}` !== api) return undefined;
    const request = JSON.parse(body || "{}") as Request;
    requests.push(request);
    const { query, variables } = request;
    if (query.startsWith("query Viewer")) return { body: { data: { viewer: { name: "Ada", email: "ada@acme.test", organization: { name: "Acme", urlKey: "acme" } } } } };
    if (query.startsWith("query Teams")) return { body: { data: { teams: { nodes: teams } } } };
    if (query.startsWith("query Scope")) {
      const index = variables.after ? Number(String(variables.after).slice(1)) : 0;
      const page = pages[index] || [];
      const more = index + 1 < pages.length;
      return { body: { data: { issues: { nodes: page.map(node), pageInfo: { hasNextPage: more, endCursor: more ? `c${index + 1}` : null } } } } };
    }
    return { status: 400, body: { errors: [{ message: "Unknown operation", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } };
  };
  return { ...fakeService(route), requests };
}

async function connected(pages: Node[][]) {
  const fake = linear(pages);
  const service = await env.service(fake.fetchImpl);
  const connection = await service.save({ provider: "linear", secret: "lin_api_secret" });
  return { service, connection, ...fake };
}

describe("Linear board scope (LINEAR-BOARD-SPEC §3.1)", () => {
  test("the filter is my issues or a team's, with finished ones limited to recently updated", () => {
    const since = "2026-10-21T00:00:00.000Z";
    const recent = { or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { updatedAt: { gt: since } }] };
    expect(scopeFilter({}, since)).toEqual({ and: [{ assignee: { isMe: { eq: true } } }, recent] });
    expect(scopeFilter({ teamId: "t1" }, since)).toEqual({ and: [{ team: { id: { eq: "t1" } } }, recent] });
    // No limit: every finished issue.
    expect(scopeFilter({}, undefined)).toEqual({ and: [{ assignee: { isMe: { eq: true } } }] });
  });

  test("pages through endCursor, maps rows and drops duplicates across pages", async () => {
    const x = await connected([
      [{ identifier: "ENG-1", title: "One", priority: 1, type: "started", state: "In Review" }, { identifier: "ENG-2", assignee: null }],
      [{ identifier: "ENG-2" }, { identifier: "ENG-3", type: "completed", state: "Done" }],
    ]);
    const before = x.requests.length;
    const board = await x.service.linearBoard({ connectionId: x.connection.id, since: "2026-10-21T00:00:00.000Z" });
    const sent = x.requests.slice(before);
    expect(sent.map((r) => [r.query.split("(")[0], r.variables.after ?? null, r.variables.first])).toEqual([
      ["query Scope", null, 50],
      ["query Scope", "c1", 50],
    ]);
    expect(sent[0]!.variables.filter).toEqual(scopeFilter({}, "2026-10-21T00:00:00.000Z"));
    expect(board.truncated).toBe(false);
    expect(board.issues.map((i) => i.key)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(board.issues[0]).toEqual({
      key: "ENG-1",
      remoteId: "uuid-eng-1",
      title: "One",
      url: "https://linear.app/acme/issue/ENG-1/slug",
      updated: "2026-11-01T08:00:00.000Z",
      priority: 1,
      priorityLabel: "Urgent",
      stateName: "In Review",
      stateType: "started",
      statePosition: 1,
      assignee: "Ada",
      teamKey: "ENG",
      teamName: "Engineering",
    });
    expect(board.issues[1]).toMatchObject({ assignee: "", priority: 0, priorityLabel: "" });
  });

  test("stops after the page limit and says the list was cut", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => [{ identifier: `ENG-${i + 1}` }]);
    const x = await connected(pages);
    const before = x.requests.length;
    const board = await x.service.linearBoard({ connectionId: x.connection.id, teamId: "t1" });
    expect(x.requests.length - before).toBe(4);
    expect(x.requests.at(-1)!.variables.filter).toEqual({ and: [{ team: { id: { eq: "t1" } } }] });
    expect(board.truncated).toBe(true);
    expect(board.issues).toHaveLength(4);
  });

  test("teams the key can see, by name", async () => {
    const x = await connected([]);
    expect((await x.service.linearTeams({ connectionId: x.connection.id })).teams).toEqual([
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t2", key: "OPS", name: "Operations" },
    ]);
  });

  test("only read-only queries go out, and other services are refused", async () => {
    const x = await connected([[{ identifier: "ENG-1" }]]);
    await x.service.linearBoard({ connectionId: x.connection.id });
    await x.service.linearTeams({ connectionId: x.connection.id });
    expect(x.calls.every((c) => c.method === "POST" && c.url.href === api)).toBe(true);
    expect(x.requests.every((r) => /^query \w+/.test(r.query) && !/\b(mutation|subscription)\b/.test(r.query))).toBe(true);
    // A GitHub connection has no Linear board.
    const github = fakeService((url) => (url.pathname === "/user" ? { body: { login: "ada", name: "Ada" } } : undefined));
    const other = await env.service(github.fetchImpl);
    const gh = await other.save({ provider: "github", secret: "ghp_x" });
    await expect(other.linearBoard({ connectionId: gh.id })).rejects.toMatchObject({ code: "EXTERNAL_INVALID" });
  });
});
