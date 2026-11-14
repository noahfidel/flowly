# External ticket integration (Jira / Linear): read-only input

Status: confirmed by the user on 2026-10-19 (§10), P1 implemented. 2026-10-19 · card "Jira ticket integration".

> Since 2026-10-20, [CONNECTORS-SPEC](CONNECTORS-SPEC.md) extends this to Confluence, GitHub and GitLab, and by the user's decision switches to generic names: artifact field `ticket` → `external` (board v5), tool `flowly_read_ticket` → `flowly_read_external` (the old name is an alias), CLI `ticket` → `external`, RPC `tickets.*` → `connectors.*`, error codes `TICKET_*` → `EXTERNAL_*`, data directory `tickets/` → `connectors/`. The text below keeps the Jira naming of the time; the behavior rules are still valid.

## 0. User decision and conclusions

The user's question: how should one connect a ticket system like Jira or Linear while managing work in Flowly? Taking Jira as the example, should the status be isolated or merged?

The user's decision (2026-10-19): **The ticket system is only an input and a reference. Flowly's status flow does not affect the external ticket system at all, and only takes the ticket content as input.**

The typical scenario the user described (2026-10-19):

1. After binding Jira, in the New task form click **From Jira**, which automatically lists the latest 5–10 tickets assigned to me, and can also search by title text or ticket number.
2. After a ticket is selected, if the card title is not yet filled in, it is prefilled with the ticket title; one already filled in is not overwritten. The rest of the flow is the same as now.
3. An existing card can use the same flow to link a Jira ticket.
4. In every later turn, the agent can, as it does with artifacts, know that the card is linked to a ticket and read the ticket's content.

This gives four points:

1. **Fully isolated, one-way read-only**. Flowly never writes to the ticket system: no transition, no comment, no remote link, no field change. Data flows only from the ticket to Flowly.
2. **Ticket status does not drive the card**. Ticket status is shown only as reference information; it does not move cards, trigger prompts or count into Attention. Card status is still decided by humans and agents under the existing rules.
3. **A ticket is a kind of input artifact**. The card's Artifacts already have the semantics "input/output, added by human/agent, unread" (CARD-ARTIFACTS-SPEC), and a ticket link is added directly as an input, with the daemon filling in the ticket content after recognizing it. No one-to-one binding such as "card linked ticket" is added; a card can reference several tickets, and a ticket can be referenced by several cards.
4. **Credentials stay in the daemon only**. Jira needs login and the agent cannot open the link, so the daemon reads the ticket and then hands it to the agent through a tool. The agent cannot get the token, and can read only the tickets referenced on its own card.

Why status is not merged (the analysis of the previous version, still valid): Flowly has a fixed set of 9 statuses, while Jira's workflow is defined arbitrarily per project and per issue type, can only move through transitions, and comes with conditions and required fields; Flowly's stage changes with each turn of the agent's work, and Done also triggers wrap-up and archiving. The read-only plan does not need to handle mapping, conflicts and failure retries, so it is simpler.

## 1. Scope

| Do | Do not |
| --- | --- |
| Configure ticket system connections (Jira DC / Jira Cloud; Linear is in P2) | Any write operation: status, comment, field, worklog, remote link |
| Add a ticket link or key as a card input, recognize it automatically and show the key, title and status | Move cards by ticket status, prompt about deviation, auto wrap-up |
| The agent reads the ticket body, comments, subtasks and linked ticket list through a tool | The agent accessing tickets the card does not reference, or running arbitrary JQL |
| The **From Jira** picker in New task (my recent tickets + search), and **Link Jira ticket** for existing cards | Creating cards automatically by JQL; background timed polling; bulk import (P2) |
| After the ticket content changes, mark it unread for the agent | Downloading attachment content (Jira DC's PAT cannot download attachments, JRASERVER-72019) |

Putting the ticket key in the worktree branch name or commit message makes Jira's GitLab development panel show the link. This is an indirect effect and is **not done by default**, and the skill does not require it. A user writing the key in a branch name themselves is not restricted.

## 2. Connections

- Settings gets a new **Connections** section (alongside General / Models / Workflow / AI features). Adding a connection: provider (`jira-dc` / `jira-cloud`, with `linear` added in P2), base URL, credentials, display name.
- When adding or editing a connection, the Connections page switches in place to an edit form (with a back button), **without opening another dialog**: the settings window itself is a React Native Modal, and opening a host Modal on top of it makes two layers of focus traps fight over focus, freezing the whole Paseo (user report 2026-10-19).
- The **Test connection** button (RPC `tickets.connection-test`) calls `GET /rest/api/2/myself`, validates only the address and token without saving, and shows in the form "Connection OK, connected as X" or the error reason; when editing an existing connection, leaving the token empty tests with the saved token. The result corresponds only to the address, type, email and token at test time, and is hidden after any change. **Save** likewise validates first, and does not save on failure.
- Authentication:
  - Jira Data Center (such as jira.shopee.io): Personal Access Token, `Authorization: Bearer`;
  - Jira Cloud: email + API token, Basic. Requests using an API token do not count toward the points-per-hour quota enforced from 2026-03, and are subject only to burst limits;
  - Linear: personal API key, `Authorization: <key>`, without Bearer.
  - No OAuth: Cloud 3LO needs an app to be registered and DC needs an administrator to create an application link, which is not worth it for a local personal tool.
- Credentials are handed to the daemon through RPC and stored in `<plugin-data>/tickets/credentials.json` (directory 0700, file 0600), and are **never returned to the client**. The UI shows only "configured · username · last verified time", and they can be replaced or deleted but not viewed. Logs, errors, activity and agent output contain only the key, never credentials or request headers.
- Credential files of other tools are not read (for example `~/.config/sra/credentials.json`).
- A connection is host-level, shared by all projects.
- **Deleting a connection** (asked by the user on 2026-10-19, implemented):
  - The confirmation shows how many cards carry tickets of this Jira, and explains the consequences;
  - The ticket inputs on cards are kept as is (link, key, title and the `ticket` field are all unchanged), and the key on the card face is still shown; that connection's cache is cleared;
  - The sidebar ticket row shows "Connection removed", the preview prompts to add the connection again, and "Open in Jira" still works;
  - The agent sees `get_task.artifacts[].ticket.connection = "removed"`, with no unread; `flowly_read_ticket` returns `TICKET_UNAVAILABLE` and prompts the agent to tell the user and not guess the content; in a new session's context this line reads "connection removed, cannot read, ask the user", and no longer prompts calling `flowly_read_ticket`;
  - **Adding the same Jira again recovers automatically**: a ticket input first looks for the connection it recorded; if not found, it uses any current connection whose base URL can recognize its link (`TicketService.locate`), so a new connection with a different id also works, and no board data needs to change.

## 3. Ticket input

### 3.1 Recognition

- When a human or agent adds a url-type artifact, the daemon matches it against the base URLs of the configured connections:
  - Jira: `<base>/browse/KEY-123`, and board links with a `selectedIssue=KEY-123` parameter;
  - Linear: `linear.app/<workspace>/issue/ENG-42/...` (implemented, rules in [CONNECTORS-SPEC §14](CONNECTORS-SPEC.md)).
- The main entry is the ticket picker of §5. In the Artifacts add form you can also paste a link directly or fill in only a key (`SHOPSR-123`): with only one Jira connection it is joined into a URL directly, with several you choose the connection.
- A successful match is a **ticket input**: `role` is fixed to input (a ticket cannot be an output), and `title` defaults to `KEY summary`. A failed match is still an ordinary link, as now.

### 3.2 Data

The artifact gains only one optional field, and board.json does not bump its version:

```ts
// shared/model.ts, artifactSchema
ticket: z.object({
  connectionId: z.string(),
  provider: z.enum(["jira-dc", "jira-cloud", "linear"]),
  key: z.string().max(64),       // SHOPSR-123; the key changes when a ticket moves to another project, so remoteId is authoritative
  remoteId: z.string(),
}).optional(),
```

Ticket content is stored in a snapshot cache outside board.json, `<plugin-data>/tickets/cache.json`, keyed by `connectionId:remoteId`. Snapshot content: summary, status (name and category), type, priority, assignee, reporter, remote `updated`, content fingerprint, fetch time. The body and comments are here too, converted to Markdown when read. The cache does not change the board revision, nor the board etag (PERFORMANCE-SPEC).

The content fingerprint is a hash of the summary, description, comment IDs and their update times, and the subtask list. When only fields such as status or assignee change, the fingerprint does not change.

### 3.3 Refresh: on demand, no background polling

The daemon fetches only when someone needs it, and reuses the cache for the same ticket within 60 seconds:

| When | What is fetched |
| --- | --- |
| Picker list and search, adding a ticket input | Summary fields (picker results are also written to the cache) |
| The agent calls `flowly_get_task` | The summary fields of all tickets on this card, used to compute unread. Batch queried by connection with `key in (…≤50)`, fetching only `summary,status,updated,…` |
| The agent calls `flowly_read_ticket` | Full content: body, comments, subtasks, linked ticket list, attachment names |
| Opening a card in the sidebar / ticket preview | Summary fields; full content when expanded |
| The card-face badge on the board | Not fetched: the card face shows only the key (§10), and the key is stored on the artifact |
| The status label of Artifacts in the sidebar | `tickets.card`, returned directly from the cache within 30 minutes; no content fingerprint is computed for the badge |

Interfaces:
- Jira DC: `GET /rest/api/2/search`, `GET /rest/api/2/issue/{key}?fields=…&expand=renderedFields` and `/comment`;
- Jira Cloud: the old `/search` is retired, use `/rest/api/3/search/jql` (`nextPageToken` paging). The body is read from the v2 interface, getting wiki markup, unified with DC, and ADF is not handled;
- All requests use `fetch` in the daemon, with a timeout, and pass `fields` explicitly.

Errors:
- On 429/5xx, wait no less than `Retry-After`, with a backoff cap of 5 minutes, keep using the old cache during that time and mark it "may be stale";
- On 401/403, the connection is marked "credentials invalid", not retried, and shown on the settings page and the related cards;
- On 404, the ticket input is marked Missing, consistent with the Missing of file artifacts.
- When the remote errors, board and agent reads both keep working, just without new content.

## 4. Agent side

### 4.1 `flowly_get_task`

A ticket input in `artifacts[]` gets an extra:

```json
"ticket": { "key": "SHOPSR-123", "summary": "…", "status": "In Progress", "statusCategory": "started",
            "type": "Bug", "priority": "P1", "assignee": "…", "updated": "…", "stale": false }
```

The `unread` rule is extended to: the artifact itself was added or edited after this session's last read, **or** the ticket content fingerprint changed after the last read. A change only in status or assignee does not count as unread, since these are not requirement changes. The read time reuses `artifact-reads.json`, and the last fingerprint each session saw is stored separately.

### 4.2 New tool `flowly_read_ticket` (+ CLI `ticket <artifactId>`)

- Input: `artifactId`, which can only be a ticket input of **this card**. When the agent wants to see a linked ticket, it first uses `flowly_add_artifact` to add its link as an input and then reads it, so humans can see on the card what the agent referenced.
- Returns Markdown: title, metadata (status, type, priority, assignee, reporter, components, versions, labels), description, the latest 20 comments (author, time), subtasks and linked tickets (key, title, status, relation), and the attachment name list. Truncated beyond 32 KB, with the ticket URL appended.
- Read-only, writes no receipt and does not change the board revision. Returning the result advances the content to "read", consistent with the rule by which `flowly_get_task` advances artifact read state.
- Error codes: `TICKET_NOT_FOUND`, `TICKET_AUTH` (connection credentials invalid, ask the user to update them in settings), `TICKET_UNAVAILABLE` (remote unavailable, with the cache time and cached content attached), `TICKETS_DISABLED`.

### 4.3 Skill and session context

- In the Inputs section injected when a session is created, a ticket row is written as `- [user] SHOPSR-123 <summary> (Jira, In Progress): <url>`, with a prompt to read the full text with `flowly_read_ticket`.
- Skill additions:
  - A ticket input is the task requirement; read it fully with `flowly_read_ticket` before starting work; when unread, reread first;
  - Ticket status is only a reference; do not set the card stage by it, and do not try to modify the ticket;
  - When the ticket description conflicts with the user's instruction, the user's instruction wins; when unsure, ask the user with `kind=question`;
  - On delivery, state which tickets were relied on.
- An ordinary follow-up still sends only the user's original text, with no ticket content attached.

## 5. Choosing a ticket: From Jira and Link Jira ticket

Creating a card and linking an existing card share one **ticket picker**, which appears only when at least one Jira connection is configured.

### 5.1 Entry points

| Entry | Position | After selecting |
| --- | --- | --- |
| **From Jira** | The top of the New task form, a button above the title field | A ticket bar appears at the top of the form (key, title, status, ✕ cancel); when the title is empty it is prefilled (see §5.3); on submit the card and the ticket input are **created together** |
| **Link Jira ticket** | The card detail menu, and the Add menu of the sidebar Artifacts block | Immediately adds a ticket input to that card, toast "Linked SHOPSR-123". It **does not change** the card title or other fields |

Both can be used multiple times, because a card can reference several tickets. A ticket already on this card is shown as linked in the list and cannot be selected again.

### 5.2 Picker content

- On open it shows **my recent tickets**: the 10 most recently updated unfinished tickets assigned to me.
  - Query: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, `maxResults=10`, fetching only `summary,status,issuetype,priority,updated`.
  - Each row shows the type icon, key, title, status (neutral color), and relative update time. If the ticket is already referenced by another card of this project, add one gray line "On card ‹title›", and it can still be selected.
- The search box at the top accepts:
  - **Ticket number**: `SHOPSR-123`, case-insensitive, fetching this one directly by key;
  - **Ticket link**: paste a browse link, and after parsing out the key, as above;
  - **Digits only**: `123`, combining candidates (such as `SHOPSR-123`) from the project keys seen in the recent tickets, listing however many are found;
  - **Text**: use Jira's issue picker interface `GET /rest/api/2/issue/picker?query=…` (Jira's own input box uses it, available in both DC and Cloud, fuzzy matching on key and title). When no result comes back, fall back to JQL `summary ~ "<text>*" ORDER BY updated DESC`.
  - Text search is **not limited** by assignee, and can select any ticket you have permission to see.
- Input is debounced by 300 ms (`TextBox`'s `commitDelay`), searches only with at least 2 characters, and discards the result of an old request when a new result arrives.
- User input is put into JQL only as a string literal: escape `\` and `"`, and remove Jira text search's reserved characters, and no JQL keyword is concatenated.
- Empty state and errors:
  - No result: "No matching tickets";
  - Credentials invalid: "Jira connection needs a new token", with Open settings;
  - Network error: "Jira is unreachable" and Retry.
  - None of these blocks the form; the user can close the picker and create the card manually as usual.
- With several Jira connections, the top of the picker can switch connection, defaulting to the last used connection (host-level setting `lastTicketConnection`).

### 5.3 Prefill when creating a card

- When a ticket is selected, the ticket summary is **prefilled only if the title is empty** (without the key, the key is shown as a badge). A title the user has already typed stays unchanged.
- When the user switches to another ticket, if the title is still the original text prefilled by the previous ticket and has not been changed, it is replaced with the new ticket's summary; if it was changed it is kept. Cancelling the selection (✕) does not clear the title.
- Other fields (description, status, priority, type, tags, workspace, first message) are **not prefilled**, and the flow is as before.
- Implementation note: per the text input rules of AGENTS.md, on native the title input holds the text itself. A prefill is an outside change, done by changing the seed value and remounting the title field, and only when the title is empty or still equals the last prefilled value. User input is not written back through `value`.

### 5.4 Data writes for creating and linking

- `taskInput` gets an optional field `tickets?: [{ connectionId, key }]` (at most 5). `tasks.create` creates the card and the matching ticket input artifacts (`createdBy: human`, event `artifact_added`) in **the same commit**, so the first session generated by "start an agent when creating the card" already has the ticket in its context.
- Before writing, the daemon reads the ticket once more with that connection to confirm it exists and is permitted, and also gets `remoteId` and the snapshot. When the read fails, the whole creation fails and shows the reason; the form keeps its content, and the user can remove the ticket and submit again.
- Link Jira ticket goes through the existing `artifacts.create`, the target is the ticket URL, recognized as a ticket input by the rules of §3.1, with the same validation.
- Both paths only read Jira.

## 6. UI

- **Card face**: when there is a ticket input, the first ticket's key badge is shown before the title row, and with several it shows `KEY +2`. Status is shown only in the tooltip and the sidebar; the card face carries no ticket status, to avoid confusion with the card lane.
- **Sidebar**:
  - In the Artifacts block, a ticket row shows the provider icon, key, summary, a small status label (neutral color, not the lane's color), and "updated at". Opening it gives the ticket preview: metadata, body, comments, subtasks, with Open in Jira and Refresh;
  - The Add menu gets Link Jira ticket.
- **New task form**: the From Jira button and ticket bar are in §5. With no Jira connection the button is not shown; the first time the form is opened, a tip can guide to binding in settings.
- **Settings Connections page**: see §2.
- Per project constraints:
  - Copy goes through `t()` and into all 9 language catalogs;
  - Two new one-time tips: `jira-connect` (when there is a project but no connection, the New task form hints that Jira can be bound) and `first-ticket` (after the first ticket is linked, explains "A ticket is only an input; Flowly will not modify it, and the agent can read it every turn");
  - One row is added to the welcome page's feature list, and the README is updated in sync;
  - Picker list items and badges use memo, and opening and closing use the unified short animation.

## 7. Delete and wrap-up

- Deleting a ticket input, deleting a card, or removing a project deletes only Flowly's records. Snapshots not referenced by any card are cleaned up at the next startup. The remote ticket is not affected.
- Wrap-up and archiving do not involve tickets.

## 8. Phases

| Phase | Content |
| --- | --- |
| **P1** | Jira DC + Cloud connections; the ticket picker (my recent tickets, key/link/digits/text search); New task → From Jira (title prefill, atomic creation); Link Jira ticket; ticket input recognition and snapshot; `get_task.ticket` and unread; `flowly_read_ticket` / CLI; sidebar ticket preview; card key badge; skill, tip, i18n |
| **P2** | ~~Linear provider~~ (implemented: GraphQL, sorted by `updatedAt`; rate limiting is now returned as HTTP 429 with error code `RATELIMITED`, the old form was HTTP 400, and both are treated as rate limiting; see [CONNECTORS-SPEC §14](CONNECTORS-SPEC.md)); bulk import by JQL; a new-ticket inbox (the same pattern as the Ideas inbox); adding a ticket's linked tickets as inputs in one click |

## 8.1 Implementation record (P1, 2026-10-19)

- Shared: `shared/tickets.ts` (connection and snapshot schema, key/link recognition, search classification, JQL literal escaping, wiki → Markdown).
- daemon: `server/tickets.ts`
  - `ConnectionStore`: `<plugin-data>/tickets/connections.json`, 0600, `.bak` likewise 0600;
  - `JiraClient`: sends only GET, paths limited to an allowlist, `redirect: "error"`, 15-second timeout, and a non-JSON return is treated as invalid credentials;
  - `TicketService`: search, recognition, snapshot cache `cache.json`, 60-second detail cache, backoff;
  - `TicketReadStore`: `ticket-reads.json`, recording the content fingerprint each session saw.
- RPC: `tickets.connections`, `tickets.connection-test`, `tickets.connection-save`, `tickets.connection-delete`, `tickets.search`, `tickets.card`, `tickets.read`.
- Changes to existing interfaces:
  - `artifacts.create` and the agent's `flowly_add_artifact` both recognize ticket links or keys first;
  - `tasks.create` accepts `tickets`;
  - setting `board-view.lastTicketConnection`;
  - `Field` gets `secure`, so token input does not show plaintext.
- agent:
  - `get_task.artifacts[].ticket`;
  - `flowly_read_ticket`, with the CLI as `ticket --id`;
  - the skill gets a ticket paragraph, and `skills/paseo-ultra-kanban/SKILL.md` is synced.
- Client:
  - `client/tickets.tsx`: the Connections page, TicketPicker, TicketChip, LinkTicket, TicketPreview;
  - From Jira in New task (`client/forms.tsx`);
  - Ticket rows in the sidebar Artifacts, Link Jira ticket and preview (`client/task-artifacts.tsx`);
  - The card key row (`client/card.tsx`, computed in `client/board.tsx`);
  - tips `first-ticket` / `jira-connect`, the welcome page feature row, README;
  - 49 new strings in each of the 9 language catalogs.
- Linear was not yet in the provider enum at the time; on 2026-11-03 it was added as the connector family `linear` (CONNECTORS-SPEC §14).

## 9. Test points

- Picker:
  - The query and fields of recent tickets;
  - Classification of search input: key, link, digits only, text;
  - JQL literal escaping (quotes, backslash, reserved characters);
  - Debounce and discarding of stale results;
  - The form can still be submitted on 401 and network errors;
  - A ticket already on this card cannot be selected again; those referenced by other cards show a hint.
- Prefill:
  - Prefilled when the title is empty; not overwritten when filled in;
  - When switching tickets, only an unchanged prefilled title is replaced;
  - Cancelling the selection does not clear the title.
- Creation:
  - The card and the ticket input are created in the same commit;
  - The first session's context has the ticket row;
  - No card is created when the ticket read fails;
  - Link does not change the card title.
- Recognition: DC and Cloud browse links, board selectedIssue links, key only, multi-connection choice; a non-ticket link stays an ordinary link.
- Read-only guarantee: use a mock HTTP service to assert Flowly sends only GET, plus DC search's read-only POST. The provider layer uses a method plus path allowlist, and throws directly outside the allowlist.
- unread: a content fingerprint change counts as unread, a change only in status or assignee does not; a ticket input added by the session itself does not count.
- Errors: 401 marks the connection invalid, 404 marks Missing, 429 honors `Retry-After`, and the cache is returned when the remote is unavailable.
- Credentials: there is no token in RPC return values, logs or tool output.
- Tool scope: `flowly_read_ticket` rejects another card's artifacts and ordinary links.

Integration: a mock Jira covers both DC and Cloud responses; the real jira.shopee.io is verified read-only, with the tickets the user specifies. Per project requirements, UI acceptance uses a full-access `codex/gpt-6-luna` session, covering desktop and phone layouts, with evidence kept in `docs/verification/external-tracker.md`.

## 10. Settled questions (2026-10-19, the user)

1. P1 supports both privately deployed Jira (Data Center/Server, such as jira.shopee.io) and public Jira Cloud.
2. "My recent tickets" excludes finished tickets, taking 10.
3. The card face shows only the ticket key, not the ticket status.

## References

- Existing design: CARD-ARTIFACTS-SPEC (input/unread/preview), IDEAS-INBOX-SPEC (inbox pattern), PERFORMANCE-SPEC (etag, on-demand reads), AUTO-STATUS-SPEC / WORKFLOW-STAGES-SPEC (card status rules, not changed by this design)
- Similar practice: when Devin, Cursor and Codex connect to Jira/Linear, they all take the ticket as the task input, and the only things written back are comments and PR links. This design does not write back even those two.
- External material (consulted 2026-10-19):
  - Jira DC PAT: https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html ; attachment limitation https://jira.atlassian.com/browse/JRASERVER-72019
  - Jira search: Cloud https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API ; DC https://developer.atlassian.com/server/jira/platform/jira-rest-api-example-query-issues-6291606/
  - JQL time zone: https://jira.atlassian.com/browse/JRACLOUD-81174
  - Jira rate limiting and webhooks: https://developer.atlassian.com/cloud/jira/platform/rate-limiting ; https://developer.atlassian.com/cloud/jira/platform/webhooks/
  - ADF: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
  - Linear API, filtering, rate limiting: https://linear.app/developers/graphql ; https://linear.app/developers/filtering ; https://linear.app/developers/rate-limiting
  - Devin for Jira: https://docs.devin.ai/integrations/jira.md ; Cursor + Linear: https://cursor.com/docs/integrations/linear ; Codex + Linear: https://developers.openai.com/codex/integrations/linear
