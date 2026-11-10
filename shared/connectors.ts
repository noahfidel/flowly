import { z } from "zod";

/**
 * External items as read-only card inputs (CONNECTORS-SPEC; Jira rules in
 * EXTERNAL-TRACKER-SPEC). Pure helpers shared by daemon, tools and client:
 * the provider registry, recognizing item links and keys, and classifying
 * picker searches. Nothing here talks to a service.
 */

export const connectorFamilies = ["jira", "confluence", "github", "gitlab", "azure", "linear", "shortcut"] as const;
export type ConnectorFamily = (typeof connectorFamilies)[number];

export const connectorProviders = ["jira-dc", "jira-cloud", "confluence-dc", "confluence-cloud", "github", "gitlab", "azure-devops", "linear", "shortcut"] as const;
export type ConnectorProvider = (typeof connectorProviders)[number];
export const connectorProviderSchema = z.enum(connectorProviders);

export const itemTypes = ["issue", "pull", "merge_request", "page", "story", "epic"] as const;
export type ItemType = (typeof itemTypes)[number];
export const itemTypeSchema = z.enum(itemTypes);

/** What a provider needs to connect (CONNECTORS-SPEC §4.1). */
export const providerInfo: Record<
  ConnectorProvider,
  {
    family: ConnectorFamily;
    email: boolean;
    defaultBaseUrl?: string;
    /** The API address is fixed and the user enters none; the account check reports the workspace address (Linear, CONNECTORS-SPEC §14). */
    noAddress?: boolean;
  }
> = {
  "jira-dc": { family: "jira", email: false },
  "jira-cloud": { family: "jira", email: true },
  "confluence-dc": { family: "confluence", email: false },
  "confluence-cloud": { family: "confluence", email: true },
  github: { family: "github", email: false, defaultBaseUrl: "https://github.com" },
  gitlab: { family: "gitlab", email: false, defaultBaseUrl: "https://gitlab.com" },
  "azure-devops": { family: "azure", email: false },
  linear: { family: "linear", email: false, defaultBaseUrl: "https://linear.app", noAddress: true },
  // One connection is one workspace, so baseUrl carries the slug and there is no default.
  shortcut: { family: "shortcut", email: false },
};
export const familyOf = (provider: ConnectorProvider) => providerInfo[provider].family;
export const familyProviders = (family: ConnectorFamily) => connectorProviders.filter((p) => providerInfo[p].family === family);

export const connectorLimits = { perCreate: 5, recent: 10, search: 20, query: 200, name: 60, comments: 20, readBytes: 32 * 1024, pageBytes: 64 * 1024, files: 100 } as const;

/** A connection as the client sees it: never the credential. */
export const connectionSchema = z.object({
  id: z.string(),
  provider: connectorProviderSchema,
  name: z.string(),
  /** Normalized: https origin plus optional context path, no trailing slash. */
  baseUrl: z.string(),
  /** Display name of the account the token belongs to, from the last successful test. */
  account: z.string(),
  verifiedAt: z.string(),
  /** The last request was refused (401/403): the token needs replacing. */
  authFailed: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionInput = z.strictObject({
  /** Present: replace this connection (an empty secret keeps the stored one). */
  id: z.string().optional(),
  provider: connectorProviderSchema,
  name: z.string().trim().max(connectorLimits.name).default(""),
  baseUrl: z.string().trim().max(500).default(""),
  /** Atlassian Cloud: the account email used with the API token. */
  email: z.string().trim().max(200).default(""),
  /** Personal access token or API token. */
  secret: z.string().trim().max(2000).default(""),
});
export type ConnectionInput = z.input<typeof connectionInput>;

/** Stored on an external artifact; the content lives in the daemon's cache (CONNECTORS-SPEC §3.1). */
export const externalRefSchema = z.object({
  connectionId: z.string(),
  provider: connectorProviderSchema,
  /** SHOPSR-123, owner/repo#12, group/proj!34, AB#123 (Azure DevOps), or a Confluence page id. */
  key: z.string().max(300),
  remoteId: z.string().max(64),
  /** Absent in Jira records written before other connectors: an issue. */
  itemType: itemTypeSchema.optional(),
});
export type ExternalRef = z.infer<typeof externalRefSchema>;
export const itemTypeOf = (ref: Pick<ExternalRef, "itemType">): ItemType => ref.itemType || "issue";

/** One row of a picker and the summary shown on a card. */
export const externalSummarySchema = z.object({
  connectionId: z.string(),
  itemType: itemTypeSchema,
  key: z.string(),
  remoteId: z.string(),
  url: z.string(),
  /** Ticket summary, issue or pull request title, page title. */
  summary: z.string(),
  /** "" for pages. */
  status: z.string(),
  /** new | indeterminate | done, or "" when unknown. */
  statusCategory: z.string(),
  type: z.string(),
  priority: z.string(),
  assignee: z.string(),
  /** Repository path, Confluence space or Jira project; may be empty. */
  container: z.string().default(""),
  updated: z.string(),
  /** Linear's suggested git branch for the issue (START-CARD-SPEC §6); other providers leave it out. */
  branchName: z.string().optional(),
});
export type ExternalSummary = z.infer<typeof externalSummarySchema>;

/** https origin plus context path without a trailing slash; null when not an http(s) URL. */
export function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

/** The path of `value` below `baseUrl` ("" for the base itself), with its query; null for other hosts or paths. */
function below(value: string, baseUrl: string): { rest: string; params: URLSearchParams } | null {
  let url: URL, base: URL;
  try {
    url = new URL(value.trim());
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== base.host.toLowerCase()) return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) return null;
  return { rest: url.pathname.slice(prefix.length), params: url.searchParams };
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/* ---------- Jira ---------- */

/** The text before an issue key and number, e.g. "SHOPSR" in SHOPSR-123. */
const jiraKeyPattern = /^([A-Za-z][A-Za-z0-9_]{0,30})-(\d{1,9})$/;

/** "shopsr-123" → "SHOPSR-123"; anything else → null. */
export function issueKey(value: string): string | null {
  const match = jiraKeyPattern.exec(value.trim());
  return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

export const browseUrl = (baseUrl: string, key: string) => `${baseUrl}/browse/${key}`;

/** /browse/KEY-1, or any page with ?selectedIssue=KEY-1 (boards), below `baseUrl`. */
export function keyFromUrl(value: string, baseUrl: string): string | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const browse = /^\/browse\/([^/?#]+)\/?$/.exec(at.rest);
  if (browse) return issueKey(decode(browse[1]!));
  const selected = at.params.get("selectedIssue");
  return selected ? issueKey(selected) : null;
}

/** A JQL/CQL string literal holding user text: quotes and backslashes escaped, search operators dropped. */
export function quotedText(value: string) {
  const cleaned = value
    .replace(/[+\-&|!(){}[\]^~*?:\\/"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, connectorLimits.query);
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A JQL list of keys; each one is validated, so nothing else reaches the query. */
export function jqlKeys(keys: readonly string[]) {
  const valid = keys.map(issueKey).filter((k): k is string => !!k);
  return valid.length ? `key in (${valid.join(", ")})` : null;
}

export const recentJql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const textJql = (text: string) => `summary ~ ${quotedText(text)} ORDER BY updated DESC`;

/** Candidate keys for a bare number: the project keys of the given tickets, most recent first. */
export function numberCandidates(number: string, recent: readonly Pick<ExternalSummary, "key">[], limit = 5) {
  const projects: string[] = [];
  for (const t of recent) {
    const project = t.key.split("-")[0];
    if (project && !projects.includes(project)) projects.push(project);
  }
  return projects.slice(0, limit).map((p) => `${p}-${number}`);
}

/* ---------- Confluence ---------- */

const pageId = (value: string | null | undefined) => (value && /^\d{1,19}$/.test(value) ? value : null);

/**
 * Tiny links (/x/<code>) are the page id as little-endian bytes in a URL-safe
 * base64 without padding; decoded locally, no request.
 */
export function tinyLinkId(code: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,11}$/.test(code)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const text = code.replace(/-/g, "/").replace(/_/g, "+").padEnd(11, "A");
  let bits = 0,
    count = 0;
  const bytes: number[] = [];
  for (const ch of text) {
    bits = (bits << 6) | alphabet.indexOf(ch);
    count += 6;
    if (count >= 8) {
      count -= 8;
      bytes.push((bits >> count) & 0xff);
    }
  }
  // Page ids stay far below 2^53, so plain numbers are exact (and Hermes needs no BigInt).
  let id = 0;
  for (let i = Math.min(bytes.length, 8) - 1; i >= 0; i--) id = id * 256 + bytes[i]!;
  return id > 0 && Number.isSafeInteger(id) ? String(id) : null;
}

/** A Confluence page link below `baseUrl`: by id, or by space and title (/display/, needs a lookup). */
export function pageFromUrl(value: string, baseUrl: string): { id: string } | { space: string; title: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  if (/^\/pages\/(viewpage|editpage|viewinfo|viewpageattachments)\.action$/.test(at.rest)) {
    const id = pageId(at.params.get("pageId"));
    return id ? { id } : null;
  }
  const spaces = /^\/spaces\/[^/]+\/pages\/(?:edit-v2\/)?(\d{1,19})(?:\/[^?#]*)?$/.exec(at.rest);
  if (spaces) return { id: spaces[1]! };
  const tiny = /^\/x\/([A-Za-z0-9_-]+)\/?$/.exec(at.rest);
  if (tiny) {
    const id = tinyLinkId(tiny[1]!);
    return id ? { id } : null;
  }
  const display = /^\/display\/([^/]+)\/([^/?#]+)\/?$/.exec(at.rest);
  if (display) return { space: decode(display[1]!), title: decode(display[2]!.replace(/\+/g, " ")) };
  return null;
}

export const pageUrl = (baseUrl: string, id: string) => `${baseUrl}/pages/viewpage.action?pageId=${id}`;

/* ---------- GitHub and GitLab ---------- */

const repoPart = /^[A-Za-z0-9_.-]{1,100}$/;
const repoPath = (path: string) => {
  const parts = path.split("/");
  return parts.length >= 2 && parts.every((p) => repoPart.test(p) && p !== "." && p !== "..") ? path : null;
};

/** github.com/owner/repo/(issues|pull)/n with any subpage. */
export function githubFromUrl(value: string, baseUrl: string): { itemType: "issue" | "pull"; key: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d{1,9})(?:\/[^?#]*)?$/.exec(at.rest);
  if (!match || !repoPath(`${match[1]}/${match[2]}`)) return null;
  return { itemType: match[3] === "pull" ? "pull" : "issue", key: `${match[1]}/${match[2]}#${match[4]}` };
}

/** <path>/-/(issues|work_items|merge_requests)/<iid> with any subpage; the path may have nested groups. */
export function gitlabFromUrl(value: string, baseUrl: string): { itemType: "issue" | "merge_request"; key: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const match = /^\/(.+?)\/-\/(issues|work_items|merge_requests)\/(\d{1,9})(?:\/[^?#]*)?$/.exec(at.rest);
  if (!match || !repoPath(match[1]!)) return null;
  const mr = match[2] === "merge_requests";
  return { itemType: mr ? "merge_request" : "issue", key: `${match[1]}${mr ? "!" : "#"}${match[3]}` };
}

/** owner/repo#12 (GitHub), group/proj#12 or group/proj!34 (GitLab). */
export function splitRepoKey(key: string): { repo: string; sep: "#" | "!"; number: string } | null {
  const match = /^([^#!\s]+)([#!])(\d{1,9})$/.exec(key.trim());
  if (!match || !repoPath(match[1]!)) return null;
  return { repo: match[1]!, sep: match[2] as "#" | "!", number: match[3]! };
}

export const githubItemUrl = (baseUrl: string, key: string, itemType: ItemType) => {
  const parts = splitRepoKey(key);
  return parts ? `${baseUrl}/${parts.repo}/${itemType === "pull" ? "pull" : "issues"}/${parts.number}` : "";
};
export const gitlabItemUrl = (baseUrl: string, key: string, itemType: ItemType) => {
  const parts = splitRepoKey(key);
  return parts ? `${baseUrl}/${parts.repo}/-/${itemType === "merge_request" ? "merge_requests" : "issues"}/${parts.number}` : "";
};

/** owner/repo of a git remote URL (https or scp/ssh form) on `baseUrl`'s host; null for other hosts. */
export function remoteRepo(remote: string, baseUrl: string): string | null {
  let host: string, path: string;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(remote.trim());
  try {
    if (scp && !/^[a-z]+:\/\//i.test(remote.trim())) {
      host = scp[1]!;
      path = scp[2]!;
    } else {
      const url = new URL(remote.trim());
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
    }
    const base = new URL(baseUrl);
    if (host.toLowerCase() !== base.hostname.toLowerCase()) return null;
    const prefix = base.pathname.replace(/^\/+|\/+$/g, "");
    if (prefix && path.startsWith(prefix + "/")) path = path.slice(prefix.length + 1);
  } catch {
    return null;
  }
  return repoPath(path.replace(/\.git$/, "").replace(/\/+$/, ""));
}

/* ---------- Azure DevOps ---------- */

/** Work item ids are unique within an organization (or collection), so "AB#123" names one; AB is Azure Boards' own prefix. */
const azureId = (value: string | null | undefined) => (value && /^\d{1,9}$/.test(value) ? value : null);
export const azureKey = (id: string) => `AB#${id}`;

/**
 * .../_workitems/edit/<id> below the organization address (dev.azure.com/<org>,
 * <org>.visualstudio.com, or a Server collection), with or without a project
 * segment, or any board/backlog page that carries ?workitem=<id>.
 */
export function azureFromUrl(value: string, baseUrl: string): { itemType: "issue"; key: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const edit = /^(?:\/[^/]+)*\/_workitems\/edit\/(\d{1,9})\/?$/i.exec(at.rest);
  const id = azureId(edit?.[1] || at.params.get("workitem"));
  return id ? { itemType: "issue", key: azureKey(id) } : null;
}

/** AB#123 (any case). A bare number is only a key when the user is searching in a picker (classifyQuery). */
export function azureIdOfKey(text: string) {
  return azureId(/^AB#(\d{1,9})$/i.exec(text.trim())?.[1]);
}

export const azureItemUrl = (baseUrl: string, key: string) => {
  const id = azureIdOfKey(key);
  return id ? `${baseUrl}/_workitems/edit/${id}` : "";
};

/* ---------- Linear ---------- */

/** /issue/ENG-123 below the workspace address (https://linear.app/<urlKey>), with any title slug or subpage. */
export function linearFromUrl(value: string, baseUrl: string): { itemType: "issue"; key: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const match = /^\/issue\/([^/?#]+)(?:\/[^?#]*)?$/.exec(at.rest);
  const key = match ? issueKey(decode(match[1]!)) : null;
  return key ? { itemType: "issue", key } : null;
}

export const linearItemUrl = (baseUrl: string, key: string) => {
  const valid = issueKey(key);
  return valid ? `${baseUrl}/issue/${valid}` : "";
};

/* ---------- Shortcut ---------- */

const shortcutId = (value: string | null | undefined) => (value && /^\d{1,9}$/.test(value) ? value : null);

/** Story keys use Shortcut's own branch-name form; epics have no short form, so they get a distinct prefix. */
export const shortcutKey = (itemType: "story" | "epic", id: string) => `${itemType === "epic" ? "epic" : "sc"}-${id}`;

/** sc-123 (any case) names a story. A bare number is only a key in a picker (classifyQuery). */
export function shortcutIdOfKey(text: string, itemType: "story" | "epic" = "story") {
  return shortcutId(new RegExp(`^${itemType === "epic" ? "epic" : "sc"}-(\\d{1,9})$`, "i").exec(text.trim())?.[1]);
}

/**
 * (story|epic)/<id> below the workspace address, with any trailing title slug or
 * subpage. The workspace slug is part of `baseUrl`, as an Azure DevOps organization is.
 */
export function shortcutFromUrl(value: string, baseUrl: string): { itemType: "story" | "epic"; key: string } | null {
  const at = below(value, baseUrl);
  if (!at) return null;
  const match = /^\/(story|epic)\/(\d{1,9})(?:\/[^?#]*)?$/.exec(at.rest);
  if (!match) return null;
  const itemType = match[1] as "story" | "epic";
  return { itemType, key: shortcutKey(itemType, match[2]!) };
}

export const shortcutItemUrl = (baseUrl: string, key: string, itemType: ItemType) => {
  const kind = itemType === "epic" ? "epic" : "story";
  const id = shortcutIdOfKey(key, kind);
  return id ? `${baseUrl}/${kind}/${id}` : "";
};

/* ---------- Dispatch ---------- */

/** The item a link of `connection` points at; null when it is not one. Display-name page links need a lookup. */
export function recognizeUrl(
  value: string,
  connection: Pick<Connection, "provider" | "baseUrl">,
): { itemType: ItemType; key: string } | { itemType: "page"; space: string; title: string } | null {
  const family = familyOf(connection.provider);
  if (family === "jira") {
    const key = keyFromUrl(value, connection.baseUrl);
    return key ? { itemType: "issue", key } : null;
  }
  if (family === "confluence") {
    const page = pageFromUrl(value, connection.baseUrl);
    if (!page) return null;
    return "id" in page ? { itemType: "page", key: page.id } : { itemType: "page", ...page };
  }
  if (family === "github") return githubFromUrl(value, connection.baseUrl);
  if (family === "azure") return azureFromUrl(value, connection.baseUrl);
  if (family === "linear") return linearFromUrl(value, connection.baseUrl);
  if (family === "shortcut") return shortcutFromUrl(value, connection.baseUrl);
  return gitlabFromUrl(value, connection.baseUrl);
}

/** Per connection: the cards with an input that reads through it, by connection id or by a URL it recognizes. */
export function linkedCardCounts(
  connections: readonly Connection[],
  artifacts: readonly { taskId: string; target: string; external?: Pick<ExternalRef, "connectionId" | "provider"> }[],
): Record<string, number> {
  return Object.fromEntries(
    connections.map((c) => {
      const cards = new Set<string>();
      for (const a of artifacts)
        if (a.external && (a.external.connectionId === c.id || (familyOf(a.external.provider) === familyOf(c.provider) && recognizeUrl(a.target, c)))) cards.add(a.taskId);
      return [c.id, cards.size];
    }),
  );
}

/** A bare key in the syntax of `provider`: SHOPSR-1, a page id, owner/repo#12, group/proj!34. */
export function parseKey(value: string, provider: ConnectorProvider): { itemType: ItemType; key: string } | null {
  const family = familyOf(provider);
  const text = value.trim();
  if (family === "jira" || family === "linear") {
    // Linear identifiers (ENG-123) are written like Jira keys.
    const key = issueKey(text);
    return key ? { itemType: "issue", key } : null;
  }
  if (family === "confluence") return pageId(text) ? { itemType: "page", key: text } : null;
  if (family === "azure") {
    const id = azureIdOfKey(text);
    return id ? { itemType: "issue", key: azureKey(id) } : null;
  }
  if (family === "shortcut") {
    const story = shortcutIdOfKey(text);
    if (story) return { itemType: "story", key: shortcutKey("story", story) };
    const epic = shortcutIdOfKey(text, "epic");
    return epic ? { itemType: "epic", key: shortcutKey("epic", epic) } : null;
  }
  const parts = splitRepoKey(text);
  if (!parts) return null;
  if (family === "github") return parts.sep === "#" ? { itemType: "issue", key: `${parts.repo}#${parts.number}` } : null;
  return { itemType: parts.sep === "!" ? "merge_request" : "issue", key: `${parts.repo}${parts.sep}${parts.number}` };
}

/** The web address of an item. */
export function itemUrl(connection: Pick<Connection, "provider" | "baseUrl">, itemType: ItemType, key: string) {
  const family = familyOf(connection.provider);
  if (family === "jira") return browseUrl(connection.baseUrl, key);
  if (family === "confluence") return pageUrl(connection.baseUrl, key);
  if (family === "github") return githubItemUrl(connection.baseUrl, key, itemType);
  if (family === "azure") return azureItemUrl(connection.baseUrl, key);
  if (family === "linear") return linearItemUrl(connection.baseUrl, key);
  if (family === "shortcut") return shortcutItemUrl(connection.baseUrl, key, itemType);
  return gitlabItemUrl(connection.baseUrl, key, itemType);
}

/**
 * The connection and item a link or bare key refers to. A link picks its own
 * connection; a bare key needs exactly one connection whose syntax accepts it.
 */
export function externalTarget(value: string, connections: readonly Pick<Connection, "id" | "provider" | "baseUrl">[]) {
  const trimmed = value.trim();
  for (const c of connections) {
    const found = recognizeUrl(trimmed, c);
    if (found) return { connectionId: c.id, ...found };
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) return null;
  const matches = connections.flatMap((c) => {
    const found = parseKey(trimmed, c.provider);
    return found ? [{ connectionId: c.id, ...found }] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** What a picker search box holds (EXTERNAL-TRACKER-SPEC §5.2, CONNECTORS-SPEC §5–§7). */
export type ExternalQuery =
  | { kind: "recent" }
  | { kind: "key"; itemType: ItemType; key: string }
  | { kind: "lookup"; space: string; title: string }
  | { kind: "number"; number: string; sep?: "#" | "!" }
  | { kind: "text"; text: string };

export function classifyQuery(raw: string, connection: Pick<Connection, "provider" | "baseUrl">): ExternalQuery {
  const value = raw.trim();
  if (!value) return { kind: "recent" };
  const family = familyOf(connection.provider);
  const fromUrl = recognizeUrl(value, connection);
  if (fromUrl) return "key" in fromUrl ? { kind: "key", itemType: fromUrl.itemType, key: fromUrl.key } : { kind: "lookup", space: fromUrl.space, title: fromUrl.title };
  const key = parseKey(value, connection.provider);
  if (key) return { kind: "key", ...key };
  if (family === "azure") {
    // Ids are unique per organization: "123" and "#123" name the work item.
    const id = azureId(/^#?(\d+)$/.exec(value)?.[1]);
    return id ? { kind: "key", itemType: "issue", key: azureKey(id) } : { kind: "text", text: value.slice(0, connectorLimits.query) };
  }
  if (family === "shortcut") {
    // Ids are unique per workspace: "123" and "sc-123" both name the story.
    const id = shortcutId(/^(?:sc-)?(\d+)$/i.exec(value)?.[1]);
    return id ? { kind: "key", itemType: "story", key: shortcutKey("story", id) } : { kind: "text", text: value.slice(0, connectorLimits.query) };
  }
  if (family !== "confluence") {
    const number = /^([#!]?)(\d{1,9})$/.exec(value);
    if (number && (family === "gitlab" || number[1] !== "!"))
      return { kind: "number", number: number[2]!, ...(number[1] ? { sep: number[1] as "#" | "!" } : {}) };
  }
  return { kind: "text", text: value.slice(0, connectorLimits.query) };
}

/** Artifact title for an item: "KEY summary" (a page: its title). */
export const externalTitle = (itemType: ItemType, key: string, summary: string) =>
  (itemType === "page" ? summary || key : `${key} ${summary}`).trim().slice(0, 120);

/** The short key shown on a card face (CONNECTORS-SPEC §2); null for pages. */
export function faceKey(ref: Pick<ExternalRef, "key" | "itemType">): string | null {
  if (itemTypeOf(ref) === "page") return null;
  const parts = splitRepoKey(ref.key);
  if (!parts) return ref.key;
  return `${parts.repo.split("/").pop()}${parts.sep}${parts.number}`;
}

/** "GitLab merge request", for agent context lines (English, agent-facing). */
export function itemLabel(provider: ConnectorProvider, itemType: ItemType) {
  const family = familyOf(provider);
  if (family === "jira") return "Jira ticket";
  if (family === "confluence") return "Confluence page";
  if (family === "azure") return "Azure DevOps work item";
  if (family === "linear") return "Linear issue";
  if (family === "shortcut") return itemType === "epic" ? "Shortcut epic" : "Shortcut story";
  const name = family === "github" ? "GitHub" : "GitLab";
  return `${name} ${itemType === "pull" ? "pull request" : itemType === "merge_request" ? "merge request" : "issue"}`;
}
