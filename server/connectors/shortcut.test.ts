import { afterEach, describe, expect, test } from "vitest";
import { fakeService, fixtures, type Route } from "./fake";
import { fingerprintChanged } from "./fingerprint";

const env = fixtures();
afterEach(() => env.cleanup());


const base = "https://app.shortcut.com/acme";
const api = "https://api.app.shortcut.com/api/v3";

type Story = { id: number; name: string; description?: string; state?: number; owner?: string; epic?: number; updated?: string; done?: boolean };
type Epic = { id: number; name: string; description?: string; state?: string; stories?: number[] };
type Comment = { id: number; text: string; updated?: string };

const STATES: Record<number, string> = { 500: "Backlog", 501: "In Progress", 502: "Done" };

function shortcut(
  stories: Story[],
  epics: Epic[] = [],
  comments: Record<string, Comment[]> = {},
  options: { status?: number; headers?: Record<string, string>; slug?: string } = {},
) {
  const commentsOf = (key: string) =>
    (comments[key] || []).map((c) => ({ id: c.id, text: c.text, author_id: "m1", created_at: "2026-10-19T09:00:00.000Z", updated_at: c.updated || "2026-10-19T09:00:00.000Z" }));
  const storyJson = (s: Story) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? "Steps:\n- open",
    story_type: "bug",
    workflow_state_id: s.state ?? 501,
    owner_ids: s.owner ? [s.owner] : [],
    labels: [{ name: "backend" }],
    branches: [{ name: `sc-${s.id}/fix` }],
    epic_id: s.epic ?? null,
    estimate: 2,
    completed: !!s.done,
    started: !s.done,
    updated_at: s.updated || "2026-10-19T08:00:00.000Z",
    app_url: `${base}/story/${s.id}`,
    comments: commentsOf(`sc-${s.id}`),
  });
  const epicJson = (e: Epic) => ({
    id: e.id,
    name: e.name,
    description: e.description ?? "Epic goal",
    state: e.state || "in progress",
    updated_at: "2026-10-19T08:00:00.000Z",
    app_url: `${base}/epic/${e.id}`,
    comments: commentsOf(`epic-${e.id}`),
  });
  const route: Route = (url) => {
    if (options.status) return { status: options.status, headers: options.headers, body: { message: "nope" } };
    const path = url.pathname.replace(/^\/api\/v3/, "");
    if (path === "/member")
      return { body: { id: "m1", name: "Ada Lovelace", mention_name: "ada", workspace2: { url_slug: options.slug ?? "acme", name: "Acme" } } };
    if (path === "/members") return { body: [{ id: "m1", profile: { name: "Ada Lovelace", mention_name: "ada" } }] };
    if (path === "/workflows") return { body: [{ states: Object.entries(STATES).map(([id, name]) => ({ id: Number(id), name })) }] };
    if (path === "/search/stories") {
      const query = (url.searchParams.get("query") || "").toLowerCase();
      const mine = query.includes("owner:ada");
      const text = query.replace(/owner:\S+|!is:done/g, "").replace(/"/g, "").trim();
      return { body: { data: stories.filter((s) => (mine ? !s.done : true) && (!text || s.name.toLowerCase().includes(text))).map(storyJson) } };
    }
    if (path === "/search/epics") {
      const text = (url.searchParams.get("query") || "").replace(/"/g, "").trim().toLowerCase();
      return { body: { data: epics.filter((e) => !text || e.name.toLowerCase().includes(text)).map(epicJson) } };
    }
    const story = /^\/stories\/(\d+)$/.exec(path);
    if (story) {
      const found = stories.find((s) => s.id === Number(story[1]));
      return found ? { body: storyJson(found) } : { status: 404, body: { message: "Resource not found." } };
    }
    const epicStories = /^\/epics\/(\d+)\/stories$/.exec(path);
    if (epicStories) {
      const found = epics.find((e) => e.id === Number(epicStories[1]));
      return { body: (found?.stories || []).flatMap((id) => stories.filter((s) => s.id === id)).map(storyJson) };
    }
    const epic = /^\/epics\/(\d+)$/.exec(path);
    if (epic) {
      const found = epics.find((e) => e.id === Number(epic[1]));
      return found ? { body: epicJson(found) } : { status: 404, body: { message: "Resource not found." } };
    }
    return undefined;
  };
  return fakeService(route);
}

async function connected(stories: Story[], epics: Epic[] = [], comments: Record<string, Comment[]> = {}) {
  const fake = shortcut(stories, epics, comments);
  const service = await env.service(fake.fetchImpl);
  const connection = await service.save({ provider: "shortcut", baseUrl: base, secret: "sc-secret-token" });
  return { service, connection, ...fake };
}

describe("Shortcut (CONNECTORS-SPEC §14)", () => {
  test("connecting uses Shortcut-Token on the API host; a refused token and a foreign workspace are not saved", async () => {
    const x = await connected([]);
    expect(x.connection).toMatchObject({ provider: "shortcut", baseUrl: base, account: "Ada Lovelace (@ada)" });
    expect(x.calls[0]!.url.href).toBe(`${api}/member`);
    expect(x.calls[0]!.headers["Shortcut-Token"]).toBe("sc-secret-token");
    expect(JSON.stringify(await x.service.list())).not.toContain("sc-secret-token");

    const refused = await env.service(shortcut([], [], {}, { status: 401 }).fetchImpl);
    await expect(refused.save({ provider: "shortcut", baseUrl: base, secret: "bad" })).rejects.toThrow(/refused the token/);

    const elsewhere = await env.service(shortcut([], [], {}, { slug: "other-org" }).fetchImpl);
    await expect(elsewhere.save({ provider: "shortcut", baseUrl: base, secret: "sc-secret-token" })).rejects.toThrow(/"other-org" workspace/);
  });

  test("story and epic links and a bare sc- key become inputs with their kind", async () => {
    const x = await connected([{ id: 1042, name: "Fix the retry backoff" }], [{ id: 2007, name: "Delivery pipeline health" }]);
    expect(await x.service.recognize(`${base}/story/1042/fix-the-retry-backoff`)).toMatchObject({
      external: { provider: "shortcut", itemType: "story", key: "sc-1042", remoteId: "1042" },
      url: `${base}/story/1042`,
      title: "sc-1042 Fix the retry backoff",
    });
    expect(await x.service.recognize(`${base}/epic/2007`)).toMatchObject({ external: { itemType: "epic", key: "epic-2007" } });
    expect(await x.service.recognize("sc-1042")).toMatchObject({ external: { itemType: "story", key: "sc-1042" } });
    await expect(x.service.recognize(`${base}/story/99`)).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" });
  });

  test("picker: my open stories, a bare number as a story, and text matching stories and epics", async () => {
    const x = await connected(
      [
        { id: 1, name: "Retry backoff wrong", owner: "m1", updated: "2026-10-19T10:00:00.000Z" },
        { id: 2, name: "Counters reset", owner: "m1", updated: "2026-10-19T11:00:00.000Z" },
        { id: 3, name: "Shipped already", owner: "m1", done: true },
      ],
      [{ id: 9, name: "Counters epic" }],
    );
    const recent = await x.service.search({ connectionId: x.connection.id, query: "" });
    expect(recent.results.map((r) => r.key)).toEqual(["sc-2", "sc-1"]);
    expect(x.calls.at(-1)!.url.searchParams.get("query")).toBe("owner:ada !is:done");
    expect(recent.results[0]).toMatchObject({ itemType: "story", status: "In Progress", type: "Bug", assignee: "Ada Lovelace" });

    expect((await x.service.search({ connectionId: x.connection.id, query: "1" })).results.map((r) => r.key)).toEqual(["sc-1"]);
    const text = await x.service.search({ connectionId: x.connection.id, query: "counters" });
    expect(text.results.map((r) => r.key)).toEqual(["sc-2", "epic-9"]);
  });

  test("search text is one quoted literal, so field: operators in it never reach the query", async () => {
    const x = await connected([{ id: 1, name: "Plain" }]);
    await x.service.search({ connectionId: x.connection.id, query: 'owner:someone "or" this' });
    const sent = x.calls.filter((c) => c.url.pathname.endsWith("/search/stories")).at(-1)!.url.searchParams.get("query")!;
    expect(sent.startsWith('"') && sent.endsWith('"')).toBe(true);
    expect(sent).not.toContain("owner:");
  });

  test("a full story read is one request and carries its comments; the description moves the fingerprint, the status does not", async () => {
    const stories: Story[] = [{ id: 1042, name: "Fix the retry backoff", owner: "m1", epic: 2007, description: "The client retries too aggressively." }];
    const comments = { "sc-1042": [{ id: 1, text: "Branch is up." }] };
    const x = await connected(stories, [], comments);
    const ref = { connectionId: x.connection.id, provider: "shortcut" as const, itemType: "story" as const, key: "sc-1042", remoteId: "1042" };

    const first = await x.service.detail(ref);
    for (const part of ["# sc-1042 Fix the retry backoff", "- Status: In Progress", "- Type: Bug", "- Owners: Ada Lovelace", "- Labels: backend", "- Epic: epic-2007", "- Branches: sc-1042/fix", "The client retries too aggressively.", "### Ada Lovelace · 2026-10-19T09:00:00.000Z", "Branch is up."])
      expect(first.markdown).toContain(part);
    expect(x.calls.filter((c) => c.url.pathname === "/api/v3/stories/1042")).toHaveLength(1);

    stories[0]!.state = 502;
    stories[0]!.done = true;
    expect((await x.service.detail(ref, true)).fingerprint).toBe(first.fingerprint);

    stories[0]!.description = "Rewritten.";
    const edited = await x.service.detail(ref, true);
    expect(edited.fingerprint).not.toBe(first.fingerprint);
    expect(fingerprintChanged("output", first.fingerprint, edited.fingerprint)).toBe(false);

    comments["sc-1042"].push({ id: 2, text: "Merged." });
    expect(fingerprintChanged("output", edited.fingerprint, (await x.service.detail(ref, true)).fingerprint)).toBe(true);
  });


  test("an epic read lists its stories with their states", async () => {
    const x = await connected(
      [
        { id: 1042, name: "Retry backoff", state: 501 },
        { id: 1043, name: "Counters reset", state: 502, done: true },
      ],
      [{ id: 2007, name: "Delivery pipeline health", stories: [1042, 1043] }],
    );
    const ref = { connectionId: x.connection.id, provider: "shortcut" as const, itemType: "epic" as const, key: "epic-2007", remoteId: "2007" };
    const detail = await x.service.detail(ref);
    expect(detail.markdown).toContain("# epic-2007 Delivery pipeline health");
    expect(detail.markdown).toContain("## Stories (2)");
    expect(detail.markdown).toContain("- sc-1042 Retry backoff (In Progress)");
    expect(detail.markdown).toContain("- sc-1043 Counters reset (Done)");
  });

  test("every request is a GET inside the read-only allowlist, on the API host", async () => {
    const x = await connected([{ id: 1, name: "One" }], [{ id: 9, name: "Nine", stories: [1] }]);
    await x.service.search({ connectionId: x.connection.id, query: "one" });
    const epicRef = { connectionId: x.connection.id, provider: "shortcut" as const, itemType: "epic" as const, key: "epic-9", remoteId: "9" };
    await x.service.detail(epicRef);
    const allowed = /^\/api\/v3\/(member|members|workflows|search\/(stories|epics)|stories\/\d+|epics\/\d+(\/stories)?)$/;
    for (const call of x.calls) {
      expect(call.method).toBe("GET");
      expect(call.url.host).toBe("api.app.shortcut.com");
      expect(call.url.pathname).toMatch(allowed);
    }
  });



  test("rate limiting reports how long to wait", async () => {
    // save() flattens every adapter error to its message, so the code is read on a later call.
    const options: { status?: number; headers?: Record<string, string> } = {};
    const fake = shortcut([{ id: 1, name: "One" }], [], {}, options);
    const service = await env.service(fake.fetchImpl);
    const connection = await service.save({ provider: "shortcut", baseUrl: base, secret: "t" });
    options.status = 429;
    options.headers = { "retry-after": "30" };
    await expect(service.search({ connectionId: connection.id, query: "one" })).rejects.toMatchObject({ code: "EXTERNAL_UNAVAILABLE", retryAfter: 30 });
  });
});
