# More connectors: Confluence / GitHub / GitLab as read-only inputs

Status: confirmed by the user on 2026-10-20 (§11) and implemented. Luna 6 acceptance passed; live integration against real GitLab (git.garena.com) and Confluence (confluence.shopee.io) passed ([evidence](verification/connectors.md)); GitHub live integration is waiting for a token. 2026-10-20 · card "More connector integrations".

Prerequisite: [EXTERNAL-TRACKER-SPEC](EXTERNAL-TRACKER-SPEC.md) (Jira tickets as read-only inputs, implemented). This spec generalizes that mechanism into a common **connector** and adds Confluence, GitHub and GitLab. Any rule not rewritten here follows EXTERNAL-TRACKER-SPEC.

## 0. User request and conclusions

User request (2026-10-20): design the integration of more external connectors, including Confluence, GitHub and GitLab; the Artifacts **+** button should gather all these connectors in one place; then build the integration for each connector in turn.

Conclusions:

1. **Keep Jira's four principles**: one-way read-only; external state does not drive the card; an external item is a kind of artifact, input by default (a PR/MR the agent opened itself may be registered as output, §3.1); credentials stay in the daemon. The same holds for GitHub/GitLab PRs/MRs: Flowly does not comment, approve, merge or change labels, and PR automation stays outside v1 (AGENTS.md).
2. **One connector framework, four provider families**: Jira (existing), Confluence, GitHub, GitLab. Link recognition, the picker, snapshot cache, unread, agent reads and the settings page all go through the same interface; a provider only implements "how to recognize a link, how to search, how to read, how to convert to Markdown".
3. **Artifacts has a single +**: it opens an add menu, "File or link" plus every connected connector; the sidebar no longer has a separate Jira icon button. Pasting a link from any connected service is still recognized automatically.
4. **Switch to generic names** (user decision 2026-10-20, §3.3): artifact field `ticket` → `external`, tool `flowly_read_ticket` → `flowly_read_external`, CLI `ticket` → `external`, RPC `tickets.*` → `connectors.*`. The old tool name and CLI command stay as aliases; the board moves to v5 and the data is migrated.

## 1. Scope

| In | Out |
| --- | --- |
| A generic connector framework; move Jira onto the framework with unchanged behavior | Any write operation: comment, review, approve, merge, change status/labels, create branch |
| Confluence pages (DC + Cloud) | Confluence attachment content, bulk import of spaces/page trees, blog posts (P2) |
| GitHub issues and pull requests (github.com + Enterprise Server) | PR diff body (the agent looks with git itself), Actions/CI status (P2), Discussions |
| GitLab issues and merge requests (gitlab.com + self-hosted, such as git.garena.com) | MR diff body, pipeline status (P2), epics, wiki, snippets |
| Unified Artifacts + menu; New task's From Jira generalized to From…; four groups on the Settings Connections page | Background polling, webhooks, OAuth, reading the credentials of other tools such as `gh`/`glab`/sra |
| The agent reads any connector item through `flowly_read_external`; content changes mark it unread | The agent accessing items the card does not reference, or running arbitrary searches |

Linear was then P2 in EXTERNAL-TRACKER-SPEC and this card does not do it; it was later added as the sixth provider family, see §14.

## 2. Item types

| Provider family | Provider id | Item type `itemType` | Key (display and agent use) | Card-face badge |
| --- | --- | --- | --- | --- |
| Jira | `jira-dc` / `jira-cloud` | `issue` | `SHOPSR-123` | `SHOPSR-123` |
| Confluence | `confluence-dc` / `confluence-cloud` | `page` | Page id (`123456`), shown with the page title | Not shown (a document is not a work item) |
| GitHub | `github` (github.com and GHES share it) | `issue` / `pull` | `owner/repo#12` (issues and PRs share one number space) | `repo#12` |
| GitLab | `gitlab` (gitlab.com and self-hosted share it) | `issue` / `merge_request` | `group/sub/proj#12`, `group/sub/proj!34` | `proj#12`, `proj!34` |

The card face follows EXTERNAL-TRACKER-SPEC §6: it shows only the key of the first displayable item, and `KEY +2` when there are several; it does not show external status. Confluence pages are shown only in the sidebar Artifacts.

## 3. Data

### 3.1 artifact

`artifactSchema.ticket` is renamed `external` and its values extended; board.json moves to **v5** (§3.3):

```ts
// shared/connectors.ts
export const connectorProviders = ["jira-dc", "jira-cloud", "confluence-dc", "confluence-cloud", "github", "gitlab"] as const;

// shared/model.ts, artifactSchema
external: z.object({
  connectionId: z.string(),
  provider: connectorProviderSchema,
  key: z.string().max(300),          // the old limit of 64 is relaxed: GitLab paths can be long
  remoteId: z.string().max(64),      // Jira issue id / Confluence page id / GitHub node id / GitLab global id
  itemType: z.enum(["issue", "pull", "merge_request", "page"]).optional(), // default = issue (old Jira data)
}).optional(),
```

**role (revised 2026-10-21)**: an external item's `role` is decided by the caller like any other item, and the server no longer forces it to input. The default is still input: both the picker in the + menu and pasting in "File or link" default to input (the form has a Role selector and can choose output). The typical output is a PR/MR the agent opened itself, which keeps its live state (Open / Merged). An output external item is not a task requirement, and the skill does not treat it as one (§9); a person can change the role while editing, and the agent can also change the role when it registers an item it added itself again. **The agent cannot change an item a person added**: when it registers again with a different role, the tool result carries a `notice` ("Already added by the user as input; role not changed."), no longer silent. Items that were forced to input in old data are not migrated.

All old data is Jira, and a missing `itemType` means `issue`. The v4 → v5 migration does exactly one thing: it renames each artifact's `ticket` to `external` and keeps everything else as is; before the first write it keeps a `board.pre-v5.json` (the same as the v4 migration). An older plugin that reads a v5 file fails validation and keeps the file; it does not reset the data and does not quietly drop the `external` field.

### 3.2 Connections and cache

- The data directory `<plugin-data>/tickets/` becomes `<plugin-data>/connectors/`: at startup, if only the old directory exists, it is renamed as a whole (permissions stay with the files); `ticket-reads.json` becomes `external-reads.json`. The provider enum of `connections.json` is extended, `version` stays 1, and old files remain readable as is. Connections are still host-level.
- The snapshot cache `cache.json` moves to version 2, the key becomes `connectionId:itemType:key`, and every record carries its provider. An old version 1 cache (Jira only) is simply discarded and refetched on demand: it is only a cache, and the fingerprints used for unread are stored separately in `external-reads.json` and are not affected.
- `TicketSummary` gains `itemType` and `container` (repository path / Confluence space name / Jira project, may be empty); for Confluence, `status` is an empty string and `statusCategory` is empty.
- Content fingerprint (unread):

| Provider | Fingerprint source (status, assignee and label changes do not count) |
| --- | --- |
| Jira | Unchanged: summary, description, comment id+updated time, subtasks |
| Confluence | Page `version.number`, title, comment id+version |
| GitHub | Title, body, comment id+`updated_at`; a PR also adds review id+state and head sha |
| GitLab | Title, description, non-system note id+`updated_at`; an MR also adds head sha |

A PR/MR's head sha counts in the fingerprint: a new push means the content to review has changed, and the agent should be prompted to read it again.

**Unread for output items (2026-10-21)**: the agent's own push should not turn the PR it opened into unread. The fingerprint is therefore written as `<all content>~<discussion part>` (`server/connectors/fingerprint.ts`): the first half is the original fingerprint (old values compare as before, with no false positives), and the second half contains only comments and reviews (GitHub: comments, reviews; GitLab: non-system notes). An input item compares the first half (any content change counts); when the role is output and the fingerprint carries a discussion part, only the second half is compared, so new commits and description edits do not count, and only a new comment or review makes it unread. Jira/Confluence have no discussion part, and output still compares all content. When the read record has only the old format (no discussion part) there is no baseline, so it does not report unread, and the baseline is established after the next read.

### 3.3 Naming (user decision 2026-10-20: switch to generic names)

The design draft originally suggested keeping the old names, for compatibility. After hearing the cost, the user decided to rename, executed per the table below:

| Old | New | Compatibility |
| --- | --- | --- |
| artifact field `ticket` | `external` | Board v4 → v5 migration (§3.1) |
| tool `flowly_read_ticket` | `flowly_read_external` | The old name stays as an alias with the same behavior, its description marked deprecated, for sessions that already loaded the old skill |
| CLI `ticket --id` | `external --id` | The old command stays as an alias |
| RPC `tickets.*` | `connectors.*` | Not kept (the client and daemon ship together with the plugin) |
| Error codes `TICKET_*` / `TICKETS_DISABLED` | `EXTERNAL_AUTH` / `EXTERNAL_NOT_FOUND` / `EXTERNAL_UNAVAILABLE` / `CONNECTORS_DISABLED` | The alias tool also returns the new error codes |
| `get_task.artifacts[].ticket` | `external` | Jira items also output a `ticket` (deprecated) so sessions with the old skill can recognize them; removed in a later version |
| Setting `lastTicketConnection` | `lastConnections` (per family) | The old value is read as the jira memory |
| Card display field `ticket` | `external` | `ticket` in a stored `cardHidden` is read as `external` |
| Code modules `shared/tickets.ts`, `server/tickets.ts`, `client/tickets.tsx` | `shared/connectors.ts`, `server/connectors/*`, `client/connectors.tsx` | — |

The ids of one-time tips (`first-ticket`, `jira-connect`) **do not change**: they are recorded in the user's stored `tipsSeen`, and changing an id would make users who have already seen them see it again. Only the copy is updated.

## 4. Framework

### 4.1 shared (pure functions, usable by the client)

`shared/connectors.ts` (replaces `shared/tickets.ts`):

- Provider registry: family, display name, item types, auth fields (whether an email is needed), default address (`https://github.com`, `https://gitlab.com`), token hint and the minimum permission required.
- `recognize(url, connection)` → `{ itemType, key }`: one recognizer function per provider (§5–§7).
- `parseKey(text, connections)`: bare keys (`SHOPSR-1`, `owner/repo#12`, `group/proj!34`). With only one connection of the same family it is used directly; with several, the user picks a connection, consistent with the Jira rule.
- `classifyQuery(provider, text)`: classification for the picker's search box (recent / key / number / text); each family extends its own forms.
- Query literal escaping: JQL/CQL share `quotedText`; GitHub search only concatenates `in:title` and a validated `repo:owner/name` qualifier; GitLab uses the `search` parameter and does not concatenate a query language.

### 4.2 daemon

```
server/connectors/
  http.ts        // ReadOnlyHttp: sends GET only, the path must hit the provider's allowlist, redirect:"error", 15 s timeout, non-JSON is treated as a login page
  jira.ts        // the existing JiraClient and Markdown rendering move in, behavior unchanged
  confluence.ts
  github.ts
  gitlab.ts
  index.ts       // adapterFor(provider)
  service.ts     // ConnectorService (formerly TicketService): connections, cache, backoff, locate, summaries, detail; no provider details
```

Adapter interface:

```ts
interface ConnectorAdapter {
  verify(c: StoredConnection): Promise<{ account: string; login?: string }>;
  search(c, q: ConnectorQuery, scope: { repos: string[] }): Promise<RawItem[]>;
  get(c, ref: { itemType; key }, full: boolean): Promise<RawItem>;
  getMany?(c, refs): Promise<RawItem[]>;        // for providers with a batch API (Jira key in, Confluence id in; GitHub GraphQL is not used, see §6)
  summary(c, item: RawItem): TicketSummary;
  fingerprint(item: RawItem): string;
  markdown(summary, item: RawItem, limit: number): { markdown: string; truncated: boolean };
}
```

Errors are unified as `EXTERNAL_AUTH` / `EXTERNAL_NOT_FOUND` / `EXTERNAL_UNAVAILABLE` / `EXTERNAL_INVALID`; backoff, the credential-invalid marker, cache fallback and `locate` (automatic recovery by address after a connection is deleted) all live in `ConnectorService` and apply to every provider.

### 4.3 Project repository scope (GitHub / GitLab)

Site-wide search results on GitHub and GitLab are too noisy. The daemon reads git remotes from the project root the card lives in to get the "project repositories", and uses them to:

- Resolve bare numbers: `#12` / `!34` resolve directly when exactly one repository matches;
- Text search: by default only the project repositories are searched, and the picker can switch to "everything I'm involved in" (GitHub `involves:@me`; GitLab `scope=all`);
- My recent items: not limited to the repositories (consistent with Jira).

Project repositories = the project root itself (if it is a git repository) plus the git repositories in its first-level subdirectories (covering the symlinks of a linked root). It reads all remotes with `git remote get-url` (argument array, not through a shell) and keeps only those whose host equals the connection address. Results are cached per project for 5 minutes. The RPC `connectors.search` gains an optional `projectId`.

## 5. GitLab

- **Connection**: address (default `https://gitlab.com`, self-hosted such as `https://git.garena.com`); Personal Access Token with scope `read_api` (read-only); request header `PRIVATE-TOKEN`. Verify with `GET /api/v4/user`, and the account is shown as `name (@username)`.
- **Recognition**: `<base>/<path>/-/issues/<iid>`, `<base>/<path>/-/merge_requests/<iid>` (including subpages such as `/diffs` and `/commits` and anchors after it), `<base>/<path>/-/work_items/<iid>` (the new issue link). `<path>` can have several levels of group. Bare keys `<path>#<iid>` / `<path>!<iid>`.
- **My recent**: `GET /api/v4/issues?scope=assigned_to_me&state=opened` and `GET /api/v4/merge_requests?scope=assigned_to_me&state=opened`, `…?reviewer_username=<me>&state=opened`, merged by `updated_at`, taking the first 10.
- **Search**: key/link fetched directly; `#12` / `!34` resolved in the project repositories; text uses `GET /api/v4/projects/:id/issues|merge_requests?search=…&in=title` (project repositories), and when switched to "all" uses `GET /api/v4/issues|merge_requests?scope=all&search=…`.
- **Read**:
  - issue: `GET /api/v4/projects/:path/issues/:iid` and `/notes?sort=desc&per_page=20` (skip notes with `system: true`);
  - MR: `GET /api/v4/projects/:path/merge_requests/:iid` (state including draft/merged/closed, source/target branch, head sha, `changes_count`, reviewers) and notes;
  - Markdown: title, metadata (state, author, assignee, reviewer, labels, milestone, branch), description (GitLab is Markdown already), the latest 20 comments (author, time; diff comments mark the file and line), related issues not expanded.
- **Batch summaries**: GitLab has no cross-project batch query by iid, so it GETs one by one, concurrency ≤4. The items on a card are usually ≤5, which is acceptable.
- **Errors**: 401 → AUTH; 403 with a working token → NOT_FOUND (no permission is treated as not visible); 429 reads `RateLimit-Reset` / `Retry-After`.
- **Allowlist**: `/api/v4/user`, `/api/v4/issues`, `/api/v4/merge_requests`, `/api/v4/projects/:id`, `/api/v4/projects/:id/(issues|merge_requests)(/:iid(/notes)?)?`.

## 6. GitHub

- **Connection**: type github.com or GitHub Enterprise Server (address such as `https://github.example.com`). API root: `https://api.github.com` for github.com, `<base>/api/v3` for GHES. Token: a fine-grained PAT (read-only: Issues, Pull requests, Metadata) or a classic PAT (`repo` for private repositories); `Authorization: Bearer`, with `X-GitHub-Api-Version: 2022-11-28`. Verify with `GET /user`, and the account is shown as `name (@login)`.
- **Recognition**: `<base>/<owner>/<repo>/issues/<n>`, `/pull/<n>` (including subpages such as `/files` and `/commits` and anchors). Bare key `owner/repo#n`. Issues and PRs share numbers: when the link says `/issues/` but it is actually a PR, after reading, `itemType` is corrected from the `pull_request` field the API returns.
- **My recent**: `GET /search/issues?q=is:open involves:@me archived:false&sort=updated&per_page=10`. GitHub now requires every issue search to carry `is:issue` or `is:pull-request` (otherwise HTTP 422), so every search is split into the two kinds, queried once each and merged by update time (found by the user during live integration on 2026-10-20).
- **Search**: key/link fetched directly; `#12` resolved in the project repositories; text uses `q=<text> in:title repo:<o/r> …` (project repositories), and when switched to "all" it is `q=<text> in:title involves:<login>`. The search API allows 30 requests per minute, and the picker already has a 300 ms debounce and a 2-character threshold.
- **Read**:
  - `GET /repos/:o/:r/issues/:n` (works for PRs too, body and comment count) and `/issues/:n/comments?per_page=20&page=<last page>`;
  - A PR also reads `GET /repos/:o/:r/pulls/:n` (draft, merged, head/base branch, head sha, added/removed lines, changed file count), `/pulls/:n/reviews` (review state and body), `/pulls/:n/files?per_page=100` (only file names and added/removed lines, no patch);
  - Markdown: title, metadata (state, author, assignee, reviewer, labels, milestone, branch), body, changed file list (PR, at most 100), review summary, the latest 20 comments.
- **Batch summaries**: `GET /repos/:o/:r/issues/:n` one by one, concurrency ≤4 (REST's 5000 requests/hour is enough).
- **Errors**: 401 → AUTH; 403/429 with `x-ratelimit-remaining: 0` → UNAVAILABLE (back off by `x-ratelimit-reset`), and it does **not** mark the credential invalid; other 403 and 404 → NOT_FOUND (GitHub returns 404 for a private repository without permission).
- **Allowlist**: `/user`, `/search/issues`, `/repos/:o/:r/issues/:n(/comments)?`, `/repos/:o/:r/pulls/:n(/reviews|/files)?`.

## 7. Confluence

- **Connection**: type Confluence (self-hosted, Data Center/Server) or Confluence Cloud. Self-hosted uses a PAT (`Bearer`); Cloud uses email + API token (Basic), with the address `https://<site>.atlassian.net/wiki`. Verify with `GET /rest/api/user/current`. Jira and Confluence of the same Atlassian Cloud site are two connections, each with its own token entered once (credentials are not shared between connections, so deleting one connection does not affect the other).
- **Recognition**:
  - `…/pages/viewpage.action?pageId=<id>`;
  - `…/spaces/<SPACE>/pages/<id>(/<title>)?` (Cloud and newer DC);
  - `…/display/<SPACE>/<Title>`: needs one `GET /rest/api/content?spaceKey=&title=` to turn it into an id;
  - Short link `…/x/<code>`: the tiny link is the base64 encoding of the page id, decoded locally without sending a request;
  - Bare page id (digits only): accepted only when there is exactly one Confluence connection.
- **My recent** (user request 2026-10-20: viewed and edited): viewed comes from DC's `/rest/recentlyviewed/1.0/recent` (with view time); Cloud has no such API, so it uses CQL `id in recentlyViewedContent(n)`, and likewise falls back to it when the DC API is unavailable. Edited uses CQL `type = page AND contributor = currentUser() ORDER BY lastmodified DESC`. The two are merged and deduplicated, and the first 10 are taken in descending order of max(view time, last modified time). The allowlist adds `/rest/recentlyviewed/1.0/recent` (called only for confluence-dc).
- **Search**: link/id fetched directly; text uses CQL `type = page AND title ~ "<text>" ORDER BY lastmodified DESC`, and falls back to `text ~ "<text>"` when there are no results; literal escaping is the same as JQL. A picker row shows the space name, last editor and relative time.
- **Read**: `GET /rest/api/content/:id?expand=body.storage,version,space,ancestors` and `GET /rest/api/content/:id/child/comment?expand=body.storage,version&limit=20`. The storage format (XHTML + `ac:` macros) is converted to Markdown: headings, paragraphs, lists, tables, code macros, info/note/warning macros (converted to blockquotes), page links (`ac:link` → page title), images (`[image: file name]`), Jira macros (`[Jira: KEY]`); other macros keep their plain text. The Markdown header: title, space, ancestor path, version and last editor.
- **Batch summaries**: CQL `id in (…≤50)`, fetching only `version,space`.
- **Errors and allowlist**: same as the Jira rules; the allowlist is `/rest/api/user/current`, `/rest/api/content/search`, `/rest/api/content` (only the `spaceKey`+`title` query), `/rest/api/content/:id`, `/rest/api/content/:id/child/comment`. Cloud's v1 content API still works, and if it is taken offline we switch to v2; the interface is internal to the adapter.
- Pages are usually longer than tickets: the read limit is raised from 32 KB to 64 KB (Confluence only), and anything beyond is truncated with a link attached.

## 8. UI

### 8.1 The Artifacts + menu (user request)

The sidebar Artifacts title row keeps only one **+** (removing the separate Jira icon button). Opening it gives a menu (anchored popover on desktop, a bottom list on phones, reusing the MenuEntry in `client/context-menu.tsx`):

```
File or link…
────────────
Jira ticket…              (when a Jira connection exists)
Confluence page…          (when a Confluence connection exists)
GitHub issue or PR…       (when a GitHub connection exists)
GitLab issue or MR…       (when a GitLab connection exists)
────────────
Connect another service…  (when families remain unconnected; opens Settings → Connections)
```

- Picking a connector entry opens the matching picker (the current `LinkTicket` generalized to `LinkExternal`), with my recent + search, and picking adds it as input, with the toast "Linked <key>". With several connections of the same family, the top of the picker switches connections (`lastTicketConnection` becomes remembered per family: `lastConnections: Record<family, id>`, and the old value moves into jira).
- "File or link…" is the current form; a pasted link that belongs to any connected service is automatically recognized as that item (role taken from the form's choice, default input; since 2026-10-21 it is no longer fixed to input, and a PR/MR the agent opened itself can be registered as output).
- With no connection at all, + opens the "File or link" form directly, with one pale hint line below the form: "You can also connect Jira, Confluence, GitHub, GitLab".

### 8.2 New task form

The `From Jira` button becomes **From…**: one button per connected service ("From Jira", "From GitLab", etc., wrapped onto several lines). The implementation did not use a menu: the New task form is itself in a Modal, the board's context menu is drawn below the Modal, so a row of buttons is more reliable and saves a click. The item chip shows the family icon. The title prefill rule is unchanged (the title is prefilled only when empty, and picking another item replaces only a prefilled value that has not been edited): an issue/PR/MR uses its title, a Confluence page uses the page title. When creating a card there are at most 5 items per card, as now.

User decision (2026-11-04): when at least one item is selected and Start an agent now is on, Instruction becomes optional (placeholder "Optional: the agent starts with the attached items"); when left empty, the first message sent to the agent is `Start on this card: read its inputs, including <item keys joined with ", ">, then begin.` If the user typed text it is sent as is, with no default sentence appended. The rule is in UI-REFRESH-SPEC §7s.

### 8.3 Sidebar rows and preview

- Brand icons (user request, 2026-10-20): each service uses its own logo (`BrandIcon` in `client/brand-icons.tsx`), appearing in the Artifacts rows and the + menu, the item key on the card face, the New task From buttons, the picker and preview titles, the group rows of Settings Connections and the edit page title. The host `Icon` only knows Lucide names and the plugin cannot import SVG modules, so the logos are Simple Icons (CC0) paths pre-rendered as 48px PNGs and handed to RN `Image` as data URIs (about 0.6–0.8 KB each, with negligible cold-start impact). Colors: Jira #0052CC, Confluence #1868DB (Simple Icons' #172B4D is hard to see in the dark theme), GitLab #FC6D26; the GitHub black logo is replaced with a light version in the dark theme, chosen by the brightness of `colors.surface0`.
- Item rows in the picker still use Lucide icons by type: Confluence `BookOpen`, issue `CircleDot`, PR/MR `GitPullRequest`, to tell types apart within the same service.
- Second line: `GitLab merge request · Merged · <note>`; Confluence: `Confluence page · <space>`.
- Preview button copy: "Open in Jira / Confluence / GitHub / GitLab".

### 8.4 Settings → Connections

The same page has four groups (Jira, Confluence, GitHub, GitLab), each listing its connections with "Add a … connection". The edit form (still switched in place within the page, not stacking a Modal, for the reason in EXTERNAL-TRACKER-SPEC §2) is driven by the registry: type (self-hosted/Cloud, github.com/Enterprise, gitlab.com/self-hosted), address (github.com/gitlab.com prefilled and not editable), email for Cloud, token and permission notes. Test connection and the delete confirmation (showing the number of affected cards) are consistent across all families.

### 8.5 Onboarding and copy

- The welcome page feature row "Jira tickets as inputs" becomes "Tickets, docs and PRs as inputs" (Jira, Confluence, GitHub, GitLab); the Chinese and English README are synced.
- A new one-time tip `connectors`: when a card is opened (the sidebar Artifacts is visible) it says "+ can now also add Confluence pages and GitHub/GitLab issues and PRs", ranked before `sidebar-order`. A new tip id is shown once to every existing user (ONBOARDING-SPEC rule); `first-ticket` and `jira-connect` keep their ids and their copy is extended to all services.
- All new copy goes through `t()` and is added to the 9 language catalogs.

## 9. Agent side

- `get_task.artifacts[].external`: `provider`, `itemType`, `key`, `summary`, `status`, `statusCategory`, `type`, `priority`, `assignee`, `container`, `updated`, `stale`, `connection` (when `removed`). Confluence's `status` is empty. Jira items additionally carry a deprecated `ticket` (§3.3).
- New tool `flowly_read_external` (CLI `external --id`): reads this card's external item inputs, including Jira tickets, Confluence pages, and GitHub/GitLab issues or PRs/MRs. A PR/MR returns the changed file names but no diff: to see the code changes, the agent should `git fetch` the matching branch locally (the returned Markdown header states the branch and head sha). The old name `flowly_read_ticket` / CLI `ticket` are aliases.
- Session context Inputs line: `- [user] group/proj!34 Fix login (GitLab merge request; read it with flowly_read_external artifactId=…): <url>`.
- Skill: the line "An artifact with a ticket field is a Jira ticket…" is rewritten as a generic description of external items, and the other rules stay (it is a requirement input; the state is for reference only; do not try to modify the external system; the user wins in a conflict; state which items it relied on at delivery). One sentence is appended: when a PR/MR input is to be reviewed or continued, fetch its branch with git, and do not write back through Flowly. (2026-10-21) "Is a requirement input" is limited to role=input; a PR/MR the agent opened itself is registered with role=output, shows live status, and when unread (new comment/review) it is read to get the review comments; when a tool result carries a `notice`, handle it accordingly.
- Error codes are in §3.3.

## 10. Implementation order and tests

This card is delivered in the following order, each step independently verifiable, with Jira behavior unchanged at every step:

1. **Framework refactor and rename**: `server/connectors/*`, `ConnectorService`, shared registry, v5 migration, aliases; Jira moves in, and the existing Jira tests only change names, not behavior expectations.
2. **Unified + menu and settings page**: §8.1, §8.4, and the generic part of §8.2.
3. **Confluence** (§7).
4. **GitLab** (§5).
5. **GitHub** (§6).
6. onboarding / i18n / README / skill; overall verification.

Tests:

- Each adapter uses a mock fetch: link recognition (including multi-level groups, subpages, anchors, tiny links, `/display/`), bare keys, paths outside the allowlist throwing directly, sending GET only, error mapping (GitHub rate-limit 403 does not count as a credential failure, GitLab 403, the Confluence login page), Markdown rendering and truncation, fingerprints (status/label changes do not count, a new commit does).
- Unit tests for the storage → Markdown converter (code macro, table, info macro, ac:link, image).
- Project repository scope: remote parsing (ssh/https forms, several remotes, symlinked sub-repositories), ignored when the host does not match.
- Credentials: RPC returns, logs and tool output contain no token.
- Live integration: read-only verification against git.garena.com and the company Confluence with the token the user provides (the user enters the token in the settings page, and the agent does not touch it), and for GitHub one item each from a public repository and a private repository of the user.
- As the project requires, UI acceptance with a full-access `codex/gpt-6-luna` session (desktop and phone layouts, + menu, picker, preview, recovery after deleting a connection), with evidence saved to `docs/verification/connectors.md`.

## 11. User decisions (2026-10-20)

1. Naming: **switch to generic names** (the design draft suggested keeping the old names; after hearing the cost of aliases and migration the user decided to rename), see §3.3.
2. Item scope per §2; PRs/MRs **give only file names**, no diff.
3. New task's From Jira is **generalized together** to From… (§8.2).
4. Implementation order: **Confluence → GitLab → GitHub** (the framework and the + menu/settings page first), see §10.

## 12. Implementation record (2026-10-20)

- Shared: `shared/connectors.ts` (provider registry, link and key recognition for four families, tiny link decoding, git remote parsing, query classification, JQL/CQL literals, card-face key), replacing `shared/tickets.ts`.
- daemon: `server/connectors/`
  - `http.ts`: `ReadOnlyHttp` (GET only, path allowlist, `redirect: "error"`, 15 second timeout, a login page treated as credential failure), `ExternalError`, `StoredConnection` (adds `login`, empty by default for old records);
  - `jira.ts` (the original `JiraClient`, Markdown and wiki conversion move in, behavior unchanged), `confluence.ts`, `gitlab.ts`, `github.ts`, with `index.ts` dispatching by family;
  - `storage-markdown.ts`: Confluence storage format to Markdown;
  - `service.ts`: `ConnectorService` (formerly `TicketService`), `ConnectionStore`, `ExternalReadStore`, `migrateTicketDirectory` (renames `tickets/` → `connectors/` synchronously at plugin start);
  - `repos.ts`: project repositories from the git remotes of the project root and first-level sub-repositories, cached for 5 minutes (reusing `findRepos`).
- Board v5: `renameTicketField` in `server/migrate.ts`, and `server/store.ts` keeps `board.pre-v5.json` before the first write.
- RPC `connectors.*`; `tasks.create`'s `tickets` becomes `externals` (may carry `itemType`).
- agent: `flowly_read_external` and the alias `flowly_read_ticket`; HTTP action `external` (`ticket` compatible); CLI `external --id` (`ticket` compatible); `get_task.artifacts[].external`, with Jira items also carrying a deprecated `ticket`; skill paragraph rewritten.
- Client: `client/connectors.tsx` (replacing `client/tickets.tsx`: four groups on the settings page, `ExternalPicker`, `LinkExternal`, `ExternalPreview`, `ExternalChip`); a single + menu in the sidebar Artifacts (`client/task-artifacts.tsx`, "Connect another service…" opens Settings → Connections through `client/settings-opener.ts`); the From… button row of New task (`client/forms.tsx`); card-face key and icon (`client/board.tsx`, `client/card.tsx`); setting `lastConnections`, card display field `external` (reads the old `ticket`); tip `connectors`; welcome page feature row; README; +68 / −32 entries in each of the 9 language catalogs.
- Tests: `shared/connectors.test.ts`, `server/connectors/{jira,confluence,gitlab,github}.test.ts` (mock fetch, covering the read-only allowlist, error mapping, Markdown, fingerprints, repository scope), store v4 → v5 migration, card-display old id, onboarding tip rules.

### 12.1 Fixes after review (2026-10-20, independent code review)

- **A token only goes back to its original address**: when editing a connection, leaving the token empty keeps the stored token only if both the provider and the address are unchanged; changing the address or type requires entering it again (the original Jira implementation had the same hole: Test connection could send the stored token to a new address).
- **https only**: the connection address must be https; http is allowed only for the local machine (`localhost`, `127.0.0.1`, `[::1]`, for local mirrors and tests), so tokens are not sent in plaintext.
- **Redirects are not followed**: `redirect: "manual"`, and a 3xx (such as GitHub's 301 for a renamed repository) reports `EXTERNAL_NOT_FOUND` "moved, add the new link", no longer treated as the service being unavailable and no longer making the whole connection back off.
- **The timeout covers the response body**: the 15 second timer runs until the body is fully read; a response that declares more than 16 MB is rejected outright.
- **Moved Jira tickets**: when returned under a new key, it is also attached under the old key the card recorded, and no longer reports "not found".
- **Confluence comments count toward unread**: the page version does not change with comments, so a Confluence summary refresh does not reuse the old fingerprint (adapter flag `updatedCoversContent: false`), and every get_task (outside the 60 second cache) fetches the full text again to compute the fingerprint.
- **Bare keys do not hijack file paths**: targets like `docs/spec.md#3` and `2024` that are not links fall back to a file path when the remote cannot find them; a link that cannot be found still reports an error.
- **The picker carries the connection**: `artifacts.create` gains an optional `external: { connectionId, key, itemType }`, and when added from the picker it is resolved by the selected connection, no longer re-recognized from the URL (correct both when one host has several connections and when the web address differs from the connection address).
- **Selected check distinguishes services**: `pickKey = family:key`, so `team/app#12`, the same name on GitHub and GitLab, no longer marks each other as selected.
- **Changed files on GitLab 14.x** (found in live integration, git.garena.com is 14.10): `/diffs` exists only since 15.7; when it returns 404 it falls back to `/changes`, taking only file names and no patch.
- **Deleting a connection also cleans the disk cache** (found in item 9 of the Luna acceptance): `cache.json` is written back right after deletion; when the cache loads, entries of connections that no longer exist are dropped.
- Not changed: when `external-reads.json` is corrupt it starts from empty (the same as the original `ticket-reads.json`; it is only read markers, not user data).

## 13. Azure DevOps (2026-10-24, card "Add Azure DevOps connector")

The fifth provider family `azure` (provider id `azure-devops`), following all the rules of this spec: read-only, external state does not drive the card, input by default, tokens only in the daemon. The scope is only **work items** (Boards); Azure Repos PRs, Pipelines, Wiki and Test Plans are not done. The goal is "create a task from an ADO work item": New task's **From Azure DevOps** and the Artifacts + menu both show this service.

- **Connection**: one connection = one organization (Services: `https://dev.azure.com/<org>`, the old form `https://<org>.visualstudio.com`; Server: `https://host/tfs/<collection>`). A personal access token (Work Items: Read), with request header `Authorization: Basic base64(":"+PAT)`. Verify with `GET /_apis/connectionData`, and the account is shown as `name (login)`. There is no default address, and the settings page requires the organization address.
- **key**: `AB#123` (the form Azure Boards itself uses). A work item id is unique within the organization, so no project path is needed. A bare key accepts only `AB#123`; in the picker `123` / `#123` is also taken directly as a key, and text searches by title. `itemType` is still `issue`, the card face shows `AB#123`, and the agent context says "Azure DevOps work item".
- **Recognition**: `…/_workitems/edit/<id>` under the connection address (with or without a project segment, trailing slash either way), and any board/Backlog page carrying `?workitem=<id>`. Links from other organizations and PR links are not recognized.
- **My recent**: WIQL `[System.AssignedTo] = @Me` with state not in Closed/Done/Removed/Completed/Resolved, ordered by `ChangedDate` descending, taking 10. **Text search**: WIQL `[System.Title] CONTAINS '<text>'`, with single quotes doubled as escaping. WIQL requires POST, the first POST in this framework: `ReadOnlyHttp` gains `query()`, which allows only `queryEndpoints` (currently just `/_apis/wit/wiql`); every other path can still only GET, and write operations still do not exist.
- **Read**: `GET /_apis/wit/workitems/:id` (all fields) and `GET /<project>/_apis/wit/workItems/:id/comments` (the latest 20). Markdown: title, state, type, assignee, creator, priority, project/area/iteration, tags, parent, then Description / Repro steps / Acceptance criteria (HTML converted through `storageToMarkdown`) and comments.
- **Fingerprint**: title, Description, Repro steps, Acceptance criteria, comment id+modified time; changes to state, assignee and priority do not count. It is uncertain whether a comment advances `ChangedDate`, so `updatedCoversContent: false` (the same as Confluence), and the full text is read again every time.
- **API version**: Services uses `7.1` (comments `7.1-preview.4`), Server uses `5.0` (comments `5.1-preview.3`); the Server paths have not yet been verified against a real instance.
- **Errors**: 401/203 login page → AUTH; 403 (other than connectionData) and 404 → NOT_FOUND; 429/5xx → UNAVAILABLE.
- **UI**: the brand icon follows §8.3, rendered from the Simple Icons Azure DevOps path (CC0) as a 48 px PNG, color #0078D4, packaged as a data URI (about 0.8 KB). Settings → Connections gains a fifth group.
- **Tests**: `server/connectors/azure.test.ts` (mock fetch: Basic header, login page, link/AB# recognition, WIQL and quote escaping, Markdown, fingerprint, 403, WIQL is the only POST), `shared/connectors.test.ts` (links, Server/old domain, key, query classification). **Not done**: live integration against a real organization (needs the user's organization address and PAT).
- onboarding: update the welcome page feature row, the `jira-connect` tip copy and the README; no new tip id (connections and how they are used have not changed, and the existing tips cover it).

## 14. Linear (2026-11-03, branch `feat/linear-connector`)

The sixth provider family `linear` (provider id `linear`), implementing the P2 of EXTERNAL-TRACKER-SPEC and following all the rules of this spec: read-only, external state does not drive the card, input by default, tokens only in the daemon. The scope is only **issues**; projects, cycles, documents, initiatives and bulk import of sub-issues are not done. New task's **From Linear** and the Artifacts + menu both show this service.

- **Connection**: Linear is cloud-only, the API address is fixed at `https://api.linear.app/graphql` and held by the adapter as a constant. The settings page has **no address field** (registry `noAddress: true`): the user fills in only a name and a personal API key. Request header `Authorization: <key>`, without `Bearer`. The verification query is `viewer { name displayName email organization { name urlKey } }`: the account is shown as `name (email)`, and login takes the email. After successful verification the connection's `baseUrl` takes the **workspace address** `https://linear.app/<urlKey>` (the adapter's `verify` may return `baseUrl`, adopted only by providers with `noAddress`); it is used only to recognize links and build item links, and the token is only ever sent to the fixed API address. So when editing a connection, a change of `baseUrl` does not count as "address changed", and leaving the token empty still keeps the stored token. When the name is left empty it defaults to `linear.app/<urlKey>`.
- **Item type and key**: `itemType` is `issue`, the key is Linear's identifier `ENG-123` (team key + number, uppercase), the card face shows `ENG-123`, and the agent context says "Linear issue". `remoteId` is the issue's UUID. When an issue changes team its identifier changes, and Linear still accepts the old identifier; when a read returns a new key it is cached under the key the card stored, per the rule in §4.2.
- **Bare keys**: `ENG-123` is written the same as a Jira key. When only one connection accepts it, it is used directly (EXTERNAL-TRACKER-SPEC §3.1); when both Jira and Linear connections exist, a bare key is ambiguous, the Artifacts form does not recognize it automatically, and the user pastes a link or uses the picker. The picker searches only the current connection, so there is no ambiguity.
- **Recognition**: `/issue/<KEY>` under the workspace address, with or without a title slug, subpath, query or anchor (`#comment-…`). Links from other workspaces do not match (`urlKey` is part of `baseUrl`). Project, view and cycle links are not recognized. The item link is `<baseUrl>/issue/<KEY>`, and on read the `url` returned by the API is preferred.
- **My recent**: `issues(filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }, orderBy: updatedAt, first: 10)`, sorted once more in the daemon by `updatedAt` descending.
- **Search**: in the picker, `ENG-123` or a link is read by key (an empty result when not found); a bare number is looked up across all teams by number (`number: { eq }`, possibly several, in descending update time, at most 20); other text searches by title words: one `title: { containsIgnoreCase }` per word, joined with `and` (at most 8 words), in descending `updatedAt` taking 20. User text is passed only through GraphQL variables, and the query text is a constant in code, with no user input concatenated.
- **Read**: `issue(id: "<KEY>")`, one request reads everything: title, description (already Markdown, no conversion), state, priority, assignee, creator, labels, team, project, parent issue (key and title), link, the latest 20 comments (`comments(first: 20, orderBy: createdAt)`, shown in ascending creation time).
- **Markdown**: `# KEY title`, link, then metadata (State, Priority, Assignee, Created by, Team, Project, Labels, Parent, Updated), then `## Description` (`(empty)` when empty), then `## Comments (latest N)`, each as `### name · time`.
- **Batch summaries**: `getMany` combines several `issue(id:)` into one request with GraphQL aliases (at most 25 per request). The type of `issue(id:)` is the non-null `Issue!`, so if even one issue does not exist or cannot be seen, the whole `data` is null: in that case, if all the errors are "not found", the batch is re-read one by one (concurrency 4) and only the not-found ones are skipped; rate limits or a rejected token still fail the whole batch. If Linear changes to null only that alias, it is likewise skipped directly. A deleted issue does not stop the other items of the same connection from refreshing.
- **summary mapping**: `status` = state name; `statusCategory` comes from the state `type`: triage/backlog/unstarted → new, started → indeterminate, completed/canceled → done; `priority` = `priorityLabel` ("No priority" is recorded as empty); `type` is empty (Linear has no issue types); `container` = team name; `assignee` = the assignee's display name.
- **Fingerprint**: title, description, and the id plus `updatedAt` of each comment; state, assignee, priority and labels do not count (§3.2). It is uncertain whether a new comment advances the issue's `updatedAt`, so `updatedCoversContent: false` (the same as Confluence and Azure DevOps).
- **Read-only guarantee**: GraphQL only has POST, so `/graphql` is the only path in `queryEndpoints` (for the same reason as Azure DevOps's WIQL), and the GET allowlist is empty. Every document the adapter sends must start with `query`, otherwise it is rejected before sending; no mutation exists in the code.
- **Errors**: HTTP 401 or the GraphQL error code `AUTHENTICATION_ERROR` → AUTH (the connection is marked `authFailed`); `FORBIDDEN` and "Entity not found"-type errors → NOT_FOUND (an issue that cannot be seen does not invalidate the whole connection); rate limits (HTTP 400 or 429, error code `RATELIMITED`) → UNAVAILABLE, with the wait time taken from `Retry-After`, or, when absent, from `X-RateLimit-Requests-Reset` (a UTC millisecond timestamp); 5xx → UNAVAILABLE, whatever error code or message is in the response body (so the cache still covers when a read fails); other GraphQL errors → INVALID, with the first error message. The token and request headers do not appear in error messages.
- **UI**: the brand icon follows §8.3, rendered from the Simple Icons Linear path (CC0) as a 48 px PNG, color #5E6AD2, packaged as a data URI (about 2 KB). Settings → Connections gains a sixth group; the edit page has no type or address selection, the token field is named "API key", and the hint says to create it at Linear → Settings → Security & access → Personal API keys, with Read permission being enough.
- **Acceptance**: Test connection shows the account; after saving, the connection address is the workspace address; pasting an issue link (with a slug or anchor) and typing `ENG-123`, a number or title words in the picker all find it; **From Linear** lists the unfinished issues assigned to oneself; the agent reads the fields and comments listed above with `flowly_read_external`; editing the description or adding a comment changes the fingerprint, and changing only the state does not; when the token is rejected the connection is marked `authFailed`, and on a rate limit it backs off without losing the cache; every request is a POST to `https://api.linear.app/graphql`, with documents all starting with `query`.
- **Tests**: `server/connectors/linear.test.ts` (mock fetch, recorded-shape GraphQL responses: the Authorization header without Bearer, workspace address, keeping the token when editing, link and key recognition, variables for recent/number/text queries, Markdown, fingerprint, AUTH/NOT_FOUND/rate limit, batch aliases, only `query` documents), `shared/connectors.test.ts` (links, keys, query classification, item links, card-face key). No live API integration.
- onboarding: update the welcome page feature row, the `jira-connect` tip copy and the README; no new tip id (connections and how they are used have not changed, and the existing tips cover it). No What's new (1.8.0 is not finalized, decided at release time).
- Telemetry: no heartbeat field (for the same reason as Shortcut: TELEMETRY-SPEC §4.6 does not send the connector type).

## 15. Shortcut (2026-10-29, card "Shortcut connector")

The seventh provider family `shortcut` (provider id `shortcut`), following all the rules of this spec: read-only, external state does not drive the card, input by default, tokens only in the daemon. The scope is **stories and epics**; Shortcut documents, iterations, objectives and milestones are not done. The goal is "create a card from a Shortcut story, and let the agent read the epic it belongs to": New task's **From Shortcut** and the Artifacts + menu both show this service.

- **Connection**: Shortcut is cloud-only, so there is only one provider and no self-hosted variant. One connection = one workspace, `baseUrl` is `https://app.shortcut.com/<workspace-slug>`, for the same reason as the Azure DevOps organization address (§13); **there is no `defaultBaseUrl`**, and the settings page requires the address. **The API root is a different domain**, `https://api.app.shortcut.com/api/v3`, held by the adapter as a constant, and `baseUrl` does not take part in building it. An API token, request header `Shortcut-Token`, with no email field. Verify with `GET /api/v3/member`: the account is shown as `name (@mention_name)`, login takes `mention_name`, and the `workspace2.url_slug` in the response is compared with the configured slug; when the token belongs to another workspace, the error gives both names, instead of quietly reading the wrong board.
- **Item types**: `itemTypes` gains `story` and `epic`. In the agent context a story is written "Shortcut story" and an epic "Shortcut epic".
- **key**: a story is `sc-<id>` (the form Shortcut's own branch naming uses), an epic is `epic-<id>`. Both must be parseable by `parseKey`, because `ConnectorService.resolve` runs every key produced by a link through `parseKey` again. A bare `<id>` in the picker is read as a **story**, because that is what people type by hand; an epic comes in through a link, `epic-<id>` or search.
- **Recognition**: `(story|epic)/<id>` under the workspace address, with or without a title slug, subpath or anchor. The slug is part of `baseUrl`, so links from other workspaces do not match. Links to documents, iterations and objectives are not recognized.
- **My recent**: `GET /api/v3/search/stories?query=owner:<login> !is:done`, sorted on the client by `updated_at` (the search API has no sort parameter), taking the first 10.
- **Text search**: the same API with the user's words. Shortcut's query language uses `field:value` operators, so text containing `:` or a double quote is quoted as a whole with inner quotes doubled; the query string is never built by concatenating unescaped words. Epics use `GET /api/v3/search/epics`, with the same rules.
- **Read**: `GET /api/v3/stories/{id}` and `GET /api/v3/epics/{id}`. Both **return comments inline**, so reading the full text is one request rather than two. An epic also reads `GET /api/v3/epics/{id}/stories` to get its story list.
- **Workspace name lookups**: a story carries only `workflow_state_id` and `owner_ids`, no names. The adapter resolves them with `GET /api/v3/workflows` and `GET /api/v3/members`, cached per connection for 10 minutes. If either fails, the Markdown just loses one line (state or assignee), and the read does not fail.
- **Markdown**: title, then metadata (type, state, owner, labels, epic, iteration, estimate, due date, branch), then the description, then the latest 20 comments. Shortcut's description is already Markdown, so no storage-format conversion is needed (unlike Jira and Azure DevOps). An epic appends its story list, in the form `sc-<id> — title (state)`.
- **Fingerprint**: title, description, and the id plus `updated_at` of each comment. State, owner, labels and ordering do not count, per §3.2. It is uncertain whether a new comment advances the story's own `updated_at`, so `updatedCoversContent: false` (the same as Confluence and Azure DevOps): the fingerprint reads the full text again every time.
- **Batch summaries**: Shortcut has no API for reading by id in batch, so `getMany` GETs one by one, with concurrency 4, consistent with the rule §5 set for GitLab.
- **Errors**: 401/403 → AUTH; 404 → NOT_FOUND; 429 → UNAVAILABLE and reads `Retry-After` (Shortcut rate-limits per minute); 5xx → UNAVAILABLE.
- **Allowlist**: `/api/v3/member`, `/api/v3/members`, `/api/v3/workflows`, `/api/v3/search/(stories|epics)`, `/api/v3/stories/:id`, `/api/v3/epics/:id`, `/api/v3/epics/:id/stories`. GET only, and this family adds no `queryEndpoints`.
- **UI**: the brand icon follows §8.3, rendered from the Simple Icons Shortcut path (CC0) as a 48 px PNG, color #58B1E4, packaged as a data URI. Settings → Connections gains a seventh group.
- **Acceptance**: the connection can be verified and shows the account; both pasting a story link and typing `sc-<id>` by hand resolve; **From Shortcut** lists the current user's unfinished stories; the agent can read stories and epics with `flowly_read_external`, and the epic's Markdown lists its stories; editing the description changes the fingerprint, and changing only the state does not; when the token is revoked the connection is marked `authFailed` and the cached content is not lost.
- **Tests**: `server/connectors/shortcut.test.ts` (mock fetch: the `Shortcut-Token` header, the derived API domain, login page, search escaping, story and epic reads, Markdown, fingerprint unchanged when the state changes, 404 and 429, every request inside the allowlist), `shared/connectors.test.ts` (link recognition, `sc-` and `epic-` keys, query classification), `server/connectors/shortcut.live.test.ts` (live workspace integration, skipped automatically when `SHORTCUT_API_TOKEN` is not set). Live integration against a real workspace passed on 2026-10-29 ([evidence](verification/shortcut-connector.md)).
- onboarding: update the welcome page feature row, the `jira-connect` tip copy, the README and the What's new of 1.8.0; no new tip id (connections and how they are used have not changed, and the existing tips cover it).
- Telemetry: no heartbeat field. TELEMETRY-SPEC §4.6 lists "the type or address of a connector" as never sent, and counting Shortcut connections would conflict with it; the existing per-turn and per-card counts already cover the work done from a Shortcut card.
