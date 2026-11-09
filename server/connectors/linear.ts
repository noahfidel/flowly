import { createHash } from "node:crypto";
import { classifyQuery, connectorLimits, issueKey, linearItemUrl, type ExternalSummary } from "../../shared/connectors";
import { ExternalError, ReadOnlyHttp, cut, mapLimit, retryAfter, type Fetch, type StoredConnection } from "./http";
import { withDiscussion } from "./fingerprint";
import type { ConnectorAdapter, Fetched, ItemRef } from "./types";
import type { LinearIssueRow, LinearTeam } from "../../shared/linear-board";

/**
 * Linear issues (CONNECTORS-SPEC §14): linear.app only, GraphQL, personal API key.
 * GraphQL needs POST, so /graphql is the one query endpoint and every document must be a query.
 */

const API_ROOT = "https://api.linear.app";
const WORKSPACE_ROOT = "https://linear.app";
/** issue(id:) lookups merged into one request by getMany. */
const BATCH = 25;
/** Title words that each become a filter clause. */
const MAX_WORDS = 8;

type Person = { name?: string | null; displayName?: string | null } | null | undefined;
export type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string;
  updatedAt?: string;
  priorityLabel?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: Person;
  team?: { key?: string; name?: string } | null;
  /** Linear's suggested git branch (the Linear MCP calls it gitBranchName). */
  branchName?: string | null;
  description?: string | null;
  creator?: Person;
  project?: { name?: string } | null;
  labels?: { nodes?: { name?: string }[] } | null;
  parent?: { identifier?: string; title?: string } | null;
  comments?: { nodes?: Comment[] } | null;
};
type Comment = { id?: string; body?: string | null; createdAt?: string; updatedAt?: string; user?: Person };
type GraphqlError = { message?: string; extensions?: { code?: string; userPresentableMessage?: string } };
type Reply<T> = { data?: T | null; errors?: GraphqlError[] };

const summaryFields = "id identifier title url updatedAt priorityLabel state { name type } assignee { name displayName } team { key name } branchName";
const fullFields = `${summaryFields} description creator { name displayName } project { name } labels { nodes { name } } parent { identifier title } comments(first: ${connectorLimits.comments}, orderBy: createdAt) { nodes { id body createdAt updatedAt user { name displayName } } }`;

const viewerQuery = "query Viewer { viewer { name displayName email organization { name urlKey } } }";
const issueQuery = (full: boolean) => `query Issue($id: String!) { issue(id: $id) { ${full ? fullFields : summaryFields} } }`;
const issuesQuery = `query Issues($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${summaryFields} } } }`;
const batchQuery = (count: number) =>
  `query Batch(${Array.from({ length: count }, (_, i) => `$k${i}: String!`).join(", ")}) { ${Array.from({ length: count }, (_, i) => `i${i}: issue(id: $k${i}) { ${summaryFields} }`).join(" ")} }`;

/** The Linear board (LINEAR-BOARD-SPEC §3.1): a scope's issues page by page, and the teams the key sees. */
const rowFields = "id identifier title url updatedAt priority priorityLabel state { name type position } assignee { name displayName } team { key name }";
const scopeQuery = `query Scope($filter: IssueFilter, $first: Int, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${rowFields} } pageInfo { hasNextPage endCursor } } }`;
const teamsQuery = "query Teams($first: Int) { teams(first: $first) { nodes { id key name } } }";

/** Seconds to wait: Retry-After, else the request window's reset (UTC epoch milliseconds). */
function waitFor(headers: Headers) {
  const after = retryAfter(headers);
  if (after) return after;
  const reset = Number(headers.get("x-ratelimit-requests-reset"));
  return Number.isFinite(reset) && reset > Date.now() ? Math.ceil((reset - Date.now()) / 1000) : undefined;
}

/** A GraphQL error as one of the shared codes. An issue this key can't see never disables the connection. */
function graphqlError(errors: readonly GraphqlError[], headers?: Headers): ExternalError {
  const first = errors[0] || {};
  const code = (first.extensions?.code || "").toUpperCase();
  const text = (first.extensions?.userPresentableMessage || first.message || "").slice(0, 200);
  if (code === "RATELIMITED") return new ExternalError("EXTERNAL_UNAVAILABLE", "Linear is busy or rate limited; try again shortly.", headers ? waitFor(headers) : undefined);
  if (code === "AUTHENTICATION_ERROR") return new ExternalError("EXTERNAL_AUTH", "Linear refused the token. Update the connection in Flowly settings.");
  if (code === "FORBIDDEN" || /not found|could not find/i.test(text)) return new ExternalError("EXTERNAL_NOT_FOUND", "Not found, or this account can't see it.");
  return new ExternalError("EXTERNAL_INVALID", `Linear rejected the request${text ? `: ${text}` : ""}.`);
}

const parse = <T>(body: string): Reply<T> | null => {
  try {
    return JSON.parse(body) as Reply<T>;
  } catch {
    return null;
  }
};

function http(connection: StoredConnection, fetchImpl: Fetch) {
  return new ReadOnlyHttp({
    root: API_ROOT,
    endpoints: [],
    queryEndpoints: [/^\/graphql$/],
    // A personal API key goes as is, without "Bearer".
    headers: { Authorization: connection.secret },
    label: "Linear",
    fetchImpl,
    failure(response, body) {
      // A server failure is UNAVAILABLE whatever its body says (the cache then answers); the shared mapping handles it.
      if (response.status >= 500) return undefined;
      const reply = parse(body);
      if (reply?.errors?.length) return graphqlError(reply.errors, response.headers);
      if (response.status === 400) return new ExternalError("EXTERNAL_INVALID", "Linear rejected the request (HTTP 400).");
      return undefined;
    },
  });
}

/** Sends one read-only GraphQL document; mutations and subscriptions never leave this function. */
async function graphql<T>(connection: StoredConnection, fetchImpl: Fetch, document: string, variables: Record<string, unknown> = {}) {
  if (!/^query\s/.test(document) || /\b(mutation|subscription)\b/.test(document)) throw new ExternalError("EXTERNAL_INVALID", "Refused a Linear request that is not a read-only query.");
  const { data, headers } = await http(connection, fetchImpl).query<Reply<T>>("/graphql", { query: document, variables });
  return { data: data?.data ?? null, errors: data?.errors ?? [], headers };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const personName = (person: Person) => person?.displayName || person?.name || "";

const category = (type: string) => {
  if (type === "triage" || type === "backlog" || type === "unstarted") return "new";
  if (type === "started") return "indeterminate";
  if (type === "completed" || type === "canceled" || type === "cancelled") return "done";
  return "";
};

export function linearSummary(connection: Pick<StoredConnection, "id" | "baseUrl">, issue: LinearIssue): ExternalSummary {
  const key = issueKey(text(issue.identifier)) || text(issue.identifier);
  const priority = text(issue.priorityLabel);
  const branchName = text(issue.branchName).trim();
  return {
    ...(branchName ? { branchName } : {}),
    connectionId: connection.id,
    itemType: "issue",
    key,
    remoteId: text(issue.id),
    url: text(issue.url) || linearItemUrl(connection.baseUrl, key),
    summary: text(issue.title),
    status: text(issue.state?.name),
    statusCategory: category(text(issue.state?.type).toLowerCase()),
    type: "",
    priority: priority === "No priority" ? "" : priority,
    assignee: personName(issue.assignee),
    container: text(issue.team?.name),
    updated: text(issue.updatedAt),
  };
}

const notFound = (error: unknown) => error instanceof ExternalError && error.code === "EXTERNAL_NOT_FOUND";

async function item(connection: StoredConnection, fetchImpl: Fetch, ref: ItemRef, full: boolean): Promise<Fetched> {
  const key = issueKey(ref.key);
  if (!key) throw new ExternalError("EXTERNAL_INVALID", `"${ref.key}" is not a Linear issue key (ENG-123).`);
  const { data, errors, headers } = await graphql<{ issue?: LinearIssue | null }>(connection, fetchImpl, issueQuery(full), { id: key });
  const issue = data?.issue;
  if (!issue) throw errors.length ? graphqlError(errors, headers) : new ExternalError("EXTERNAL_NOT_FOUND", "Not found, or this account can't see it.");
  const summary = linearSummary(connection, issue);
  if (!full) return { summary };
  const comments = [...(issue.comments?.nodes || [])].sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt))).slice(-connectorLimits.comments);
  return { summary, full: { ...issue, comments: { nodes: comments } } satisfies LinearIssue };
}

/** Issues for a filter, most recently updated first. */
async function list(connection: StoredConnection, fetchImpl: Fetch, filter: Record<string, unknown>, first: number): Promise<Fetched[]> {
  const { data, errors, headers } = await graphql<{ issues?: { nodes?: LinearIssue[] } | null }>(connection, fetchImpl, issuesQuery, { filter, first });
  if (!data?.issues && errors.length) throw graphqlError(errors, headers);
  return (data?.issues?.nodes || [])
    .filter((i) => i && i.identifier)
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)))
    .slice(0, first)
    .map((i) => ({ summary: linearSummary(connection, i) }));
}

export const recentFilter = { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } };
/** Every word must be in the title; the words travel as variables, never inside the query text. */
export const titleFilter = (words: string) => ({
  and: words
    .replace(/[\u0000-\u001f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((word) => ({ title: { containsIgnoreCase: word } })),
});

/** My issues or a team's; finished ones only when updated after `since` (LINEAR-BOARD-SPEC §3.1). */
export function scopeFilter(scope: { teamId?: string }, since: string | undefined) {
  const part = scope.teamId ? { team: { id: { eq: scope.teamId } } } : { assignee: { isMe: { eq: true } } };
  const recent = since ? [{ or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { updatedAt: { gt: since } }] }] : [];
  return { and: [part, ...recent] };
}

type BoardIssue = LinearIssue & { priority?: number | null; state?: { name?: string; type?: string; position?: number } | null };

function issueRow(connection: Pick<StoredConnection, "id" | "baseUrl">, issue: BoardIssue): LinearIssueRow {
  const summary = linearSummary(connection, issue);
  const priority = Number(issue.priority);
  return {
    key: summary.key,
    remoteId: summary.remoteId,
    title: summary.summary,
    url: summary.url,
    updated: summary.updated,
    priority: Number.isInteger(priority) && priority >= 0 && priority <= 4 ? priority : 0,
    priorityLabel: summary.priority,
    stateName: summary.status,
    stateType: text(issue.state?.type).toLowerCase(),
    statePosition: Number.isFinite(issue.state?.position) ? Number(issue.state?.position) : 0,
    assignee: summary.assignee,
    teamKey: text(issue.team?.key),
    teamName: summary.container,
  };
}

/** A scope's issues, `pageSize` per request, at most `maxPages` requests; `truncated` when more remained. */
export async function listScope(
  connection: StoredConnection,
  fetchImpl: Fetch,
  scope: { teamId?: string },
  { since, pageSize = 50, maxPages = 4 }: { since?: string; pageSize?: number; maxPages?: number } = {},
): Promise<{ issues: LinearIssueRow[]; truncated: boolean }> {
  const filter = scopeFilter(scope, since);
  const seen = new Set<string>();
  const issues: LinearIssueRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    type Page = { issues?: { nodes?: BoardIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null };
    const reply: { data: Page | null; errors: GraphqlError[]; headers: Headers } = await graphql<Page>(connection, fetchImpl, scopeQuery, { filter, first: pageSize, after });
    if (!reply.data?.issues) throw reply.errors.length ? graphqlError(reply.errors, reply.headers) : new ExternalError("EXTERNAL_INVALID", "Linear rejected the request.");
    for (const node of reply.data.issues.nodes || []) {
      if (!node?.identifier) continue;
      const row = issueRow(connection, node);
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      issues.push(row);
    }
    const info = reply.data.issues.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return { issues, truncated: false };
    after = info.endCursor;
  }
  return { issues, truncated: true };
}

/** The teams this key can see, by name. */
export async function listTeams(connection: StoredConnection, fetchImpl: Fetch): Promise<LinearTeam[]> {
  const { data, errors, headers } = await graphql<{ teams?: { nodes?: { id?: string; key?: string; name?: string }[] } | null }>(connection, fetchImpl, teamsQuery, { first: 100 });
  if (!data?.teams) throw errors.length ? graphqlError(errors, headers) : new ExternalError("EXTERNAL_INVALID", "Linear rejected the request.");
  return (data.teams.nodes || [])
    .filter((t) => t?.id)
    .map((t) => ({ id: text(t.id), key: text(t.key), name: text(t.name) || text(t.key) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export const linearAdapter: ConnectorAdapter = {
  label: "Linear",
  readBytes: connectorLimits.readBytes,
  // Whether a new comment moves the issue's updatedAt is not documented; read the comments again for fingerprints.
  updatedCoversContent: false,
  async verify(connection, fetchImpl) {
    const { data, errors, headers } = await graphql<{ viewer?: { name?: string; displayName?: string; email?: string; organization?: { name?: string; urlKey?: string } } | null }>(
      connection,
      fetchImpl,
      viewerQuery,
    );
    const viewer = data?.viewer;
    if (!viewer) throw errors.length ? graphqlError(errors, headers) : new ExternalError("EXTERNAL_AUTH", "Linear refused the token. Update the connection in Flowly settings.");
    const name = viewer.name || viewer.displayName || "";
    const login = viewer.email || "";
    const urlKey = viewer.organization?.urlKey || "";
    return {
      account: name && login && name !== login ? `${name} (${login})` : name || login,
      login,
      ...(/^[A-Za-z0-9_-]{1,64}$/.test(urlKey) ? { baseUrl: `${WORKSPACE_ROOT}/${urlKey}` } : {}),
    };
  },
  async search(connection, fetchImpl, raw) {
    const query = classifyQuery(raw, connection);
    if (query.kind === "recent") return list(connection, fetchImpl, recentFilter, connectorLimits.recent);
    if (query.kind === "key")
      return item(connection, fetchImpl, query, false).then(
        (f) => [f],
        (error) => {
          if (notFound(error)) return [];
          throw error;
        },
      );
    // Numbers repeat across teams: ENG-12 and OPS-12 both match "12".
    if (query.kind === "number") return list(connection, fetchImpl, { number: { eq: Number(query.number) } }, connectorLimits.search);
    if (query.kind !== "text") return [];
    const filter = titleFilter(query.text);
    return filter.and.length ? list(connection, fetchImpl, filter, connectorLimits.search) : [];
  },
  get: item,
  async getMany(connection, fetchImpl, refs) {
    const keys = [...new Set(refs.flatMap((r) => issueKey(r.key) || []))];
    const out: Fetched[] = [];
    for (let start = 0; start < keys.length; start += BATCH) {
      const chunk = keys.slice(start, start + BATCH);
      const variables = Object.fromEntries(chunk.map((key, i) => [`k${i}`, key]));
      const { data, errors, headers } = await graphql<Record<string, LinearIssue | null>>(connection, fetchImpl, batchQuery(chunk.length), variables);
      // A refused key or a rate limit fails the batch.
      const fatal = errors.find((e) => ["RATELIMITED", "AUTHENTICATION_ERROR"].includes((e.extensions?.code || "").toUpperCase()));
      if (fatal) throw graphqlError([fatal], headers);
      if (!data && errors.length) {
        // issue(id:) is non-null (Issue!), so one missing or hidden issue nulls the whole reply. When that is all
        // that went wrong, read the chunk one by one and leave out only the issues that can't be found.
        if (!errors.every((e) => graphqlError([e]).code === "EXTERNAL_NOT_FOUND")) throw graphqlError(errors, headers);
        const each = await mapLimit(chunk, 4, (key) =>
          item(connection, fetchImpl, { itemType: "issue", key }, false).catch((error) => {
            if (notFound(error)) return null;
            throw error;
          }),
        );
        out.push(...each.filter((f): f is Fetched => !!f));
        continue;
      }
      // Should Linear ever answer with per-alias nulls instead, those issues are simply left out.
      chunk.forEach((_, i) => {
        const issue = data?.[`i${i}`];
        if (issue && issue.identifier) out.push({ summary: linearSummary(connection, issue) });
      });
    }
    return out;
  },
  fingerprint(full) {
    const issue = full as LinearIssue;
    const discussion = (issue.comments?.nodes || []).map((c) => `${c.id}:${c.updatedAt || c.createdAt}`);
    return withDiscussion(hash([text(issue.title), text(issue.description), discussion]), hash(discussion));
  },
  markdown(summary, full, limit) {
    const issue = full as LinearIssue;
    const labels = (issue.labels?.nodes || []).map((l) => text(l.name)).filter(Boolean);
    const parent = issue.parent?.identifier ? `${issue.parent.identifier} ${text(issue.parent.title)}`.trim() : "";
    const team = issue.team?.name ? `${issue.team.name}${issue.team.key ? ` (${issue.team.key})` : ""}` : "";
    const meta = [
      ["State", summary.status],
      ["Priority", summary.priority],
      ["Assignee", summary.assignee || "Unassigned"],
      ["Created by", personName(issue.creator)],
      ["Team", team],
      ["Project", text(issue.project?.name)],
      ["Labels", labels.join(", ")],
      ["Parent", parent],
      ["Updated", summary.updated],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `- ${label}: ${value}`);
    const sections = [`# ${summary.key} ${summary.summary}`, summary.url, "", ...meta, "", "## Description", "", text(issue.description).trim() || "(empty)"];
    const comments = issue.comments?.nodes || [];
    if (comments.length) {
      sections.push("", `## Comments (latest ${comments.length})`);
      for (const c of comments) sections.push("", `### ${personName(c.user) || "Someone"} · ${text(c.createdAt)}`, "", text(c.body).trim());
    }
    return cut(sections.join("\n"), summary.url, limit);
  },
};
