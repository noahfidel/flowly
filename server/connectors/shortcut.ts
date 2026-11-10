import { createHash } from "node:crypto";
import { classifyQuery, connectorLimits, quotedText, shortcutIdOfKey, shortcutItemUrl, shortcutKey, type ExternalSummary, type ItemType } from "../../shared/connectors";
import { ExternalError, ReadOnlyHttp, cut, mapLimit, retryAfter, type Fetch, type StoredConnection } from "./http";
import type { ConnectorAdapter, Fetched, ItemRef } from "./types";
import { withDiscussion } from "./fingerprint";

/** Shortcut stories and epics (CONNECTORS-SPEC §14), cloud only, REST v3. */

const readEndpoints = [/^\/member$/, /^\/members$/, /^\/workflows$/, /^\/search\/(stories|epics)$/, /^\/stories\/\d+$/, /^\/epics\/\d+$/, /^\/epics\/\d+\/stories$/];

/** Links live on app.shortcut.com/<workspace>; the API is a separate host, so baseUrl never reaches it. */
const API_ROOT = "https://api.app.shortcut.com/api/v3";

type Profile = { name?: string; mention_name?: string };
type MemberInfo = { id?: string; name?: string; mention_name?: string; workspace2?: { url_slug?: string; name?: string } };
type Member = { id?: string; profile?: Profile };
type WorkflowState = { id?: number; name?: string; type?: string };
type Workflow = { states?: WorkflowState[] };
type Comment = { id?: number; text?: string; author_id?: string; created_at?: string; updated_at?: string };
export type Story = {
  id?: number;
  name?: string;
  description?: string;
  app_url?: string;
  story_type?: string;
  epic_id?: number | null;
  iteration_id?: number | null;
  workflow_state_id?: number;
  owner_ids?: string[];
  labels?: { name?: string }[];
  branches?: { name?: string }[];
  estimate?: number | null;
  deadline?: string | null;
  updated_at?: string;
  comments?: Comment[];
  completed?: boolean;
  started?: boolean;
};
export type Epic = { id?: number; name?: string; description?: string; app_url?: string; state?: string; updated_at?: string; comments?: Comment[] };
type EpicStory = { id?: number; name?: string; workflow_state_id?: number };
type Full = { item: Story | Epic; comments: Comment[]; stories: EpicStory[] | null; names: Names };

/** Workflow state and member names, which stories carry only as ids. */
type Names = { states: Map<number, string>; members: Map<string, string> };
const emptyNames = (): Names => ({ states: new Map(), members: new Map() });

function http(connection: StoredConnection, fetchImpl: Fetch) {
  return new ReadOnlyHttp({
    root: API_ROOT,
    endpoints: readEndpoints,
    headers: { "Shortcut-Token": connection.secret },
    label: "Shortcut",
    fetchImpl,
    failure(response) {
      if (response.status === 429) return new ExternalError("EXTERNAL_UNAVAILABLE", "Shortcut asked Flowly to slow down (HTTP 429).", retryAfter(response.headers));
      return undefined;
    },
  });
}

/** A failure leaves the maps empty: Markdown drops those lines rather than failing the read. */
const nameCache = new Map<string, { at: number; names: Names }>();
const NAMES_TTL = 10 * 60 * 1000;

async function lookupNames(connection: StoredConnection, fetchImpl: Fetch): Promise<Names> {
  // Keyed by the verification too: a token repointed at another workspace must not reuse these names.
  const cacheKey = `${connection.id}@${connection.verifiedAt}`;
  const cached = nameCache.get(cacheKey);
  if (cached && Date.now() - cached.at < NAMES_TTL) return cached.names;
  const client = http(connection, fetchImpl);
  const [workflows, members] = await Promise.all([
    client.get<Workflow[]>("/workflows").then((r) => r.data, () => null),
    client.get<Member[]>("/members").then((r) => r.data, () => null),
  ]);
  const names = emptyNames();
  for (const w of workflows || []) for (const s of w.states || []) if (s.id && s.name) names.states.set(s.id, s.name);
  for (const m of members || []) if (m.id && m.profile?.name) names.members.set(m.id, m.profile.name);
  // Only a complete lookup is cached: one transient failure would otherwise blank every
  // status and owner for the whole TTL.
  if (workflows && members) nameCache.set(cacheKey, { at: Date.now(), names });
  return names;
}

const isEpic = (itemType: ItemType) => itemType === "epic";

function statusOf(item: Story | Epic, itemType: ItemType, names: Names) {
  // Epic states arrive lower-case ("in progress"); workflow state names do not.
  if (isEpic(itemType)) return titleCase((item as Epic).state || "");
  const story = item as Story;
  return (story.workflow_state_id && names.states.get(story.workflow_state_id)) || (story.completed ? "Done" : story.started ? "Started" : "Unstarted");
}

function categoryOf(item: Story | Epic, itemType: ItemType) {
  if (isEpic(itemType)) {
    const state = ((item as Epic).state || "").toLowerCase();
    return state === "done" ? "done" : state === "in progress" ? "indeterminate" : "new";
  }
  const story = item as Story;
  return story.completed ? "done" : story.started ? "indeterminate" : "new";
}

export function shortcutSummary(connection: Pick<StoredConnection, "id" | "baseUrl">, item: Story | Epic, itemType: ItemType, names: Names = emptyNames()): ExternalSummary {
  const key = shortcutKey(isEpic(itemType) ? "epic" : "story", String(item.id ?? ""));
  const owners = isEpic(itemType) ? [] : ((item as Story).owner_ids || []).map((id) => names.members.get(id)).filter(Boolean);
  return {
    connectionId: connection.id,
    itemType,
    key,
    remoteId: item.id ? String(item.id) : "",
    url: item.app_url || shortcutItemUrl(connection.baseUrl, key, itemType),
    summary: item.name || "",
    status: statusOf(item, itemType, names),
    statusCategory: categoryOf(item, itemType),
    type: isEpic(itemType) ? "Epic" : titleCase((item as Story).story_type || "story"),
    priority: "",
    assignee: owners.join(", "),
    container: "",
    updated: item.updated_at || "",
  };
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");

const notFound = (error: unknown) => error instanceof ExternalError && error.code === "EXTERNAL_NOT_FOUND";

async function item(connection: StoredConnection, fetchImpl: Fetch, ref: ItemRef, full: boolean): Promise<Fetched> {
  const epic = isEpic(ref.itemType);
  const id = shortcutIdOfKey(ref.key, epic ? "epic" : "story");
  if (!id) throw new ExternalError("EXTERNAL_INVALID", `"${ref.key}" is not a Shortcut story or epic key.`);
  const client = http(connection, fetchImpl);
  // Stories and epics both carry their comments, so a full read is still one request.
  const { data } = await client.get<Story | Epic>(`/${epic ? "epics" : "stories"}/${id}`);
  const names = await lookupNames(connection, fetchImpl);
  const summary = shortcutSummary(connection, data, ref.itemType, names);
  if (!full) return { summary };
  const stories = epic ? await client.get<EpicStory[]>(`/epics/${id}/stories`).then((r) => r.data, () => null) : null;
  const comments = (data.comments || []).slice(-connectorLimits.comments);
  return { summary, full: { item: data, comments, stories, names } satisfies Full };
}

/** Shortcut's search language reads `field:value`, so user text goes in as one quoted literal. */
const searchText = (text: string) => quotedText(text);

/** Mention names are letters, digits, dot, dash and underscore; anything else is not interpolated into a query. */
const safeLogin = (login: string) => (/^[A-Za-z0-9._-]{1,60}$/.test(login) ? login : "");

type SearchResults<T> = { data?: T[] };

async function searchKind<T extends Story | Epic>(connection: StoredConnection, fetchImpl: Fetch, kind: "stories" | "epics", query: string, limit: number): Promise<T[]> {
  const { data } = await http(connection, fetchImpl).get<SearchResults<T>>(`/search/${kind}`, { query, page_size: limit, detail: "slim" });
  return data.data || [];
}

const byUpdated = (a: Story | Epic, b: Story | Epic) => (b.updated_at || "").localeCompare(a.updated_at || "");

export const shortcutAdapter: ConnectorAdapter = {
  label: "Shortcut",
  readBytes: connectorLimits.readBytes,
  // Whether a new comment advances a story's own updated_at is unconfirmed, so full reads decide.
  updatedCoversContent: false,
  async verify(connection, fetchImpl) {
    const { data } = await http(connection, fetchImpl).get<MemberInfo>("/member");
    const slug = data.workspace2?.url_slug || "";
    const configured = new URL(connection.baseUrl).pathname.replace(/^\/+|\/+$/g, "");
    if (slug && configured && slug.toLowerCase() !== configured.toLowerCase())
      throw new ExternalError("EXTERNAL_INVALID", `This token belongs to the "${slug}" workspace, but the address says "${configured}". Use https://app.shortcut.com/${slug}.`);
    const login = data.mention_name || "";
    return { account: data.name && login ? `${data.name} (@${login})` : data.name || login || "", login };
  },
  async search(connection, fetchImpl, raw) {
    const query = classifyQuery(raw, connection);
    if (query.kind === "key")
      return item(connection, fetchImpl, query, false).then(
        (f) => [f],
        (error) => {
          if (notFound(error)) return [];
          throw error;
        },
      );
    if (query.kind !== "recent" && query.kind !== "text") return [];
    const names = await lookupNames(connection, fetchImpl);
    if (query.kind === "recent") {
      const login = safeLogin(connection.login);
      const stories = await searchKind<Story>(connection, fetchImpl, "stories", login ? `owner:${login} !is:done` : "!is:done", connectorLimits.search);
      return stories.sort(byUpdated).slice(0, connectorLimits.recent).map((s) => ({ summary: shortcutSummary(connection, s, "story", names) }));
    }
    const text = searchText(query.text);
    const [stories, epics] = await Promise.all([
      searchKind<Story>(connection, fetchImpl, "stories", text, connectorLimits.search),
      searchKind<Epic>(connection, fetchImpl, "epics", text, connectorLimits.search).catch(() => [] as Epic[]),
    ]);
    return [
      ...stories.sort(byUpdated).map((s) => ({ summary: shortcutSummary(connection, s, "story", names) })),
      ...epics.sort(byUpdated).map((e) => ({ summary: shortcutSummary(connection, e, "epic", names) })),
    ].slice(0, connectorLimits.search);
  },
  get: item,
  async getMany(connection, fetchImpl, refs) {
    // Shortcut has no batch read by id, so one GET each at the concurrency §5 sets for GitLab.
    const found = await mapLimit(refs, 4, (ref) =>
      item(connection, fetchImpl, ref, false).catch((error) => {
        if (notFound(error)) return null;
        throw error;
      }),
    );
    return found.filter((f): f is Fetched => !!f);
  },
  fingerprint(full) {
    const { item: x, comments } = full as Full;
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    const discussion = comments.map((c) => `${c.id}:${c.updated_at || c.created_at}`);
    return withDiscussion(hash([x.name || "", x.description || "", discussion]), hash(discussion));
  },
  markdown(summary, full, limit) {
    const { item: x, comments, stories, names } = full as Full;
    const story = summary.itemType === "story" ? (x as Story) : null;
    const meta = [
      ["Status", summary.status],
      ["Type", summary.type],
      ["Owners", summary.assignee || (story ? "Unowned" : "")],
      ["Labels", (story?.labels || []).map((l) => l.name).filter(Boolean).join(", ")],
      ["Epic", story?.epic_id ? shortcutKey("epic", String(story.epic_id)) : ""],
      ["Iteration", story?.iteration_id ? String(story.iteration_id) : ""],
      ["Estimate", story?.estimate != null ? String(story.estimate) : ""],
      ["Deadline", story?.deadline || ""],
      ["Branches", (story?.branches || []).map((b) => b.name).filter(Boolean).join(", ")],
      ["Updated", summary.updated],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `- ${label}: ${value}`);
    // Shortcut descriptions are Markdown already, so nothing is converted.
    const sections = [`# ${summary.key} ${summary.summary}`, summary.url, "", ...meta, "", "## Description", "", (x.description || "").trim() || "(empty)"];
    if (stories?.length) {
      sections.push("", `## Stories (${stories.length})`, "");
      for (const s of stories) sections.push(`- ${shortcutKey("story", String(s.id ?? ""))} ${s.name || ""}${s.workflow_state_id && names.states.get(s.workflow_state_id) ? ` (${names.states.get(s.workflow_state_id)})` : ""}`);
    }
    if (comments.length) {
      sections.push("", `## Comments (latest ${comments.length})`);
      for (const c of comments) sections.push("", `### ${(c.author_id && names.members.get(c.author_id)) || "Someone"} · ${c.created_at || ""}`, "", (c.text || "").trim());
    }
    return cut(sections.join("\n"), summary.url, limit);
  },
};
