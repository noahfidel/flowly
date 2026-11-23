import { createHash } from "node:crypto";
import { classifyQuery, connectorLimits, githubFromUrl, githubItemUrl, splitRepoKey, type ExternalSummary } from "../../shared/connectors";
import { ExternalError, ReadOnlyHttp, cut, mapLimit, retryAfter, type Fetch, type StoredConnection } from "./http";
import type { ConnectorAdapter, Fetched, ItemRef } from "./types";
import { withDiscussion } from "./fingerprint";

/** GitHub issues and pull requests (CONNECTORS-SPEC §6), github.com and Enterprise Server, REST. */

const repo = "[^/]+/[^/]+";
const readEndpoints = [
  /^\/user$/,
  /^\/search\/issues$/,
  new RegExp(`^/repos/${repo}/issues/\\d+(/comments)?$`),
  new RegExp(`^/repos/${repo}/pulls/\\d+(/(reviews|files))?$`),
];

/** api.github.com for github.com, <base>/api/v3 for Enterprise Server. */
export const githubApiRoot = (baseUrl: string) => (new URL(baseUrl).host.toLowerCase() === "github.com" ? "https://api.github.com" : `${baseUrl}/api/v3`);

type User = { login?: string; name?: string | null };
export type GithubIssue = {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  draft?: boolean;
  html_url?: string;
  /** API address of the repository, e.g. https://api.github.com/repos/acme/web. */
  repository_url?: string;
  user?: User;
  assignees?: User[];
  labels?: (string | { name?: string })[];
  milestone?: { title?: string } | null;
  comments?: number;
  updated_at?: string;
  pull_request?: { merged_at?: string | null };
};
type Pull = { draft?: boolean; merged?: boolean; head?: { ref?: string; sha?: string }; base?: { ref?: string }; additions?: number; deletions?: number; changed_files?: number; requested_reviewers?: User[] };
type Comment = { id?: number; body?: string; user?: User; created_at?: string; updated_at?: string };
type Review = { id?: number; state?: string; body?: string; user?: User; submitted_at?: string };
type Full = { issue: GithubIssue; comments: Comment[]; pull: Pull | null; reviews: Review[]; files: { filename?: string; status?: string; additions?: number; deletions?: number }[] };

function http(connection: StoredConnection, fetchImpl: Fetch) {
  return new ReadOnlyHttp({
    root: githubApiRoot(connection.baseUrl),
    endpoints: readEndpoints,
    headers: { Authorization: `Bearer ${connection.secret}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    label: "GitHub",
    fetchImpl,
    failure(response, _body, path) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0" || !!response.headers.get("retry-after");
      // Rate limits answer 403 or 429: wait, the token is fine.
      if ((response.status === 403 || response.status === 429) && limited) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const wait = retryAfter(response.headers) ?? (Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : undefined);
        return new ExternalError("EXTERNAL_UNAVAILABLE", "GitHub's rate limit was reached; try again shortly.", wait);
      }
      // Without access GitHub answers 403 or 404 for an item; only /user says the token is refused.
      if (response.status === 403 && path !== "/user") return new ExternalError("EXTERNAL_NOT_FOUND", "Not found, or this account can't see it.");
      return undefined;
    },
  });
}

/** A pull request's author and reviews, as the review-approval check needs them (LANDED-DONE-SPEC §9.3). */
export type PullReviewFacts = { author: string; reviews: { login: string; state: string; submittedAt: string }[] };

/** Reads one pull request's author and its first 100 reviews through the read-only endpoints. */
export async function githubPullReviews(connection: StoredConnection, fetchImpl: Fetch, repoKey: string, number: number): Promise<PullReviewFacts> {
  const client = http(connection, fetchImpl);
  const base = `/repos/${repoKey}/pulls/${number}`;
  const pull = (await client.get<{ user?: User }>(base)).data;
  const reviews = (await client.get<Review[]>(`${base}/reviews`, { per_page: 100 })).data;
  return {
    author: pull.user?.login || "",
    reviews: (Array.isArray(reviews) ? reviews : []).map((r) => ({ login: r.user?.login || "", state: r.state || "", submittedAt: r.submitted_at || "" })),
  };
}

function statusOf(issue: GithubIssue) {
  if (issue.pull_request) {
    if (issue.pull_request.merged_at) return "Merged";
    if (issue.state === "closed") return "Closed";
    return issue.draft ? "Draft" : "Open";
  }
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "Closed (not planned)" : "Closed";
  return "Open";
}

export function githubSummary(connection: Pick<StoredConnection, "id" | "baseUrl">, issue: GithubIssue): ExternalSummary {
  const parsed = issue.html_url ? githubFromUrl(issue.html_url, connection.baseUrl) : null;
  const itemType = issue.pull_request ? "pull" : "issue";
  // The web address can use another host than the connection (proxies, renamed GHES): fall back to the API's repository.
  const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url || "")?.[1];
  const key = parsed?.key || (repo && issue.number ? `${repo}#${issue.number}` : "");
  const status = statusOf(issue);
  return {
    connectionId: connection.id,
    itemType,
    key,
    remoteId: issue.id ? String(issue.id) : "",
    url: issue.html_url || githubItemUrl(connection.baseUrl, key, itemType),
    summary: issue.title || "",
    status,
    statusCategory: status === "Open" || status === "Draft" ? "indeterminate" : "done",
    type: itemType === "pull" ? "Pull request" : "Issue",
    priority: "",
    assignee: (issue.assignees || []).map((a) => a.login).filter(Boolean).join(", "),
    author: issue.user?.login || "",
    container: splitRepoKey(key)?.repo || "",
    updated: issue.updated_at || "",
  };
}

const notFound = (error: unknown) => error instanceof ExternalError && error.code === "EXTERNAL_NOT_FOUND";

async function item(connection: StoredConnection, fetchImpl: Fetch, ref: ItemRef, full: boolean): Promise<Fetched> {
  const parts = splitRepoKey(ref.key);
  if (!parts || parts.sep !== "#") throw new ExternalError("EXTERNAL_INVALID", `"${ref.key}" is not a GitHub issue or pull request key.`);
  const client = http(connection, fetchImpl);
  const base = `/repos/${parts.repo}`;
  // The issues endpoint answers for pull requests too.
  const { data: issue } = await client.get<GithubIssue>(`${base}/issues/${parts.number}`);
  const summary = githubSummary(connection, issue);
  if (!full) return { summary };
  const count = issue.comments || 0;
  const last = Math.max(1, Math.ceil(count / 100));
  const page = (n: number) => client.get<Comment[]>(`${base}/issues/${parts.number}/comments`, { per_page: 100, page: n }).then((r) => r.data);
  const pr = summary.itemType === "pull";
  const [lastPage, pull, reviews, files] = await Promise.all([
    count ? page(last) : Promise.resolve([] as Comment[]),
    pr ? client.get<Pull>(`${base}/pulls/${parts.number}`).then((r) => r.data) : Promise.resolve(null),
    pr ? client.get<Review[]>(`${base}/pulls/${parts.number}/reviews`, { per_page: 100 }).then((r) => r.data) : Promise.resolve([] as Review[]),
    pr ? client.get<Full["files"]>(`${base}/pulls/${parts.number}/files`, { per_page: connectorLimits.files }).then((r) => r.data) : Promise.resolve([] as Full["files"]),
  ]);
  const comments = lastPage.length < connectorLimits.comments && last > 1 ? [...(await page(last - 1)), ...lastPage] : lastPage;
  return { summary, full: { issue, comments: comments.slice(-connectorLimits.comments), pull, reviews, files } satisfies Full };
}

/** GitHub search text: no quotes, backslashes or qualifiers of the user's own. */
const searchText = (text: string) => text.replace(/["\\:]/g, " ").replace(/\s+/g, " ").trim().slice(0, connectorLimits.query);

/**
 * Issues and pull requests matching `q`, newest first. GitHub's issue search
 * requires `is:issue` or `is:pull-request` in every query (HTTP 422 otherwise),
 * so both kinds are searched and merged.
 */
async function search(connection: StoredConnection, fetchImpl: Fetch, q: string, perPage: number) {
  const client = http(connection, fetchImpl);
  const kinds = await Promise.all(
    ["is:issue", "is:pull-request"].map((kind) =>
      client.get<{ items?: GithubIssue[] }>("/search/issues", { q: `${kind} ${q}`, sort: "updated", order: "desc", per_page: perPage }).then((r) => r.data.items || []),
    ),
  );
  return kinds
    .flat()
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
    .slice(0, perPage)
    .map((issue) => ({ summary: githubSummary(connection, issue) }))
    .filter((f) => f.summary.key);
}

export const githubAdapter: ConnectorAdapter = {
  label: "GitHub",
  readBytes: connectorLimits.readBytes,
  async verify(connection, fetchImpl) {
    const { data } = await http(connection, fetchImpl).get<User>("/user");
    return { account: data.name && data.login ? `${data.name} (@${data.login})` : data.login || data.name || "", login: data.login || "" };
  },
  async search(connection, fetchImpl, raw, scope) {
    const query = classifyQuery(raw, connection);
    if (query.kind === "recent") return search(connection, fetchImpl, "is:open involves:@me archived:false", connectorLimits.recent);
    if (query.kind === "key")
      return item(connection, fetchImpl, query, false).then(
        (f) => [f],
        (error) => {
          if (notFound(error)) return [];
          throw error;
        },
      );
    const repos = scope.repos.slice(0, 5);
    if (query.kind === "number") return githubAdapter.getMany(connection, fetchImpl, repos.map((r) => ({ itemType: "issue" as const, key: `${r}#${query.number}` })));
    if (query.kind !== "text") return [];
    const text = searchText(query.text);
    if (!text) return [];
    const where = repos.length && !scope.all ? repos.map((r) => `repo:${r}`).join(" ") : "involves:@me";
    return search(connection, fetchImpl, `${text} in:title ${where}`, connectorLimits.search);
  },
  get: item,
  async getMany(connection, fetchImpl, refs) {
    const found = await mapLimit(refs, 4, (ref) =>
      item(connection, fetchImpl, ref, false).catch((error) => {
        if (notFound(error)) return null;
        throw error;
      }),
    );
    return found.filter((f): f is Fetched => !!f);
  },
  fingerprint(full) {
    const { issue, comments, pull, reviews } = full as Full;
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    const discussion = [comments.map((c) => `${c.id}:${c.updated_at || c.created_at}`), reviews.map((r) => `${r.id}:${r.state}`)];
    return withDiscussion(hash([issue.title || "", issue.body || "", ...discussion, pull?.head?.sha || ""]), hash(discussion));
  },
  markdown(summary, full, limit) {
    const { issue, comments, pull, reviews, files } = full as Full;
    const logins = (users?: User[]) => (users || []).map((u) => u.login).filter(Boolean).join(", ");
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean).join(", ");
    const meta = [
      ["Status", summary.status],
      ["Type", summary.type],
      ["Author", issue.user?.login || ""],
      ["Assignees", logins(issue.assignees) || "Unassigned"],
      ["Requested reviewers", logins(pull?.requested_reviewers)],
      ["Labels", labels],
      ["Milestone", issue.milestone?.title || ""],
      ["Branches", pull?.head?.ref ? `${pull.head.ref} → ${pull.base?.ref || ""}` : ""],
      ["Head", pull?.head?.sha || ""],
      ["Changes", pull ? `${pull.changed_files ?? files.length} files, +${pull.additions ?? 0} −${pull.deletions ?? 0}` : ""],
      ["Updated", summary.updated],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `- ${label}: ${value}`);
    const sections = [`# ${summary.key} ${summary.summary}`, summary.url, "", ...meta, "", "## Description", "", (issue.body || "").trim() || "(empty)"];
    if (pull) sections.push("", "To review or continue the code, fetch the head branch with git; Flowly does not include the diff.");
    if (files.length)
      sections.push(
        "",
        `## Changed files (${files.length}${files.length >= connectorLimits.files ? "+" : ""})`,
        "",
        ...files.map((f) => `- ${f.filename}${f.status && f.status !== "modified" ? ` (${f.status})` : ""} +${f.additions ?? 0} −${f.deletions ?? 0}`),
      );
    const decided = reviews.filter((r) => r.state && (r.state !== "COMMENTED" || (r.body || "").trim())).slice(-connectorLimits.comments);
    if (decided.length) {
      sections.push("", "## Reviews");
      for (const r of decided) sections.push("", `### ${r.user?.login || "Someone"} · ${r.state?.toLowerCase().replace(/_/g, " ")} · ${r.submitted_at || ""}`, ...((r.body || "").trim() ? ["", r.body!.trim()] : []));
    }
    if (comments.length) {
      sections.push("", `## Comments (latest ${comments.length} of ${Math.max(issue.comments || 0, comments.length)})`);
      for (const c of comments) sections.push("", `### ${c.user?.login || "Someone"} · ${c.created_at || ""}`, "", (c.body || "").trim());
    }
    return cut(sections.join("\n"), summary.url, limit);
  },
};
