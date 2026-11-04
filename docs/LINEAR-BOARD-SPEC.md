# Linear board

Status: accepted 2026-11-04 (plan `2026-11-04-flowly-linear-board`). Builds on the Linear connector (CONNECTORS-SPEC §14).

## 1. Goal

A **Linear** entry in Paseo's main bar opens a board of the user's Linear issues. From any issue, **Start card** opens Flowly's New task form with the issue attached and Start agent on, so Start card → Create starts a card session. An issue a Flowly card already references offers **Open card** instead.

Out of scope: writing to Linear (status, comments, assignment, new issues), background polling or webhooks, other services on this board, replacing Flowly's board or the New task picker.

## 2. Entry point

- `contribute` registers a second screen `linear` and a sidebar header item `linear`, both titled "Linear" (a brand, not translated). The row shows the Linear brand icon.
- The row renders only when at least one Linear connection exists (`connectors.connections`, the same query and cache as the settings page). With none, nothing is shown; the screen itself, when opened by URL, shows "Add a Linear connection in Flowly → Settings → Connections." with an Open Flowly button.
- Plugin load starts no network work: the connections read happens when the sidebar row mounts.

## 3. Data

### 3.1 Scope query (daemon, read-only)

`linearAdapter`'s module exports two read-only functions, used only for connections of family `linear`:

- `listScope(connection, fetch, scope, { since, pageSize = 50, maxPages = 4 })`: one GraphQL document
  `query Scope($filter: IssueFilter, $first: Int, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { … } pageInfo { hasNextPage endCursor } } }`,
  requested page by page with `after = endCursor` until `hasNextPage` is false or `maxPages` pages were read. `truncated` is true when more pages remained. Duplicate identifiers across pages are dropped.
- Filter, sent only as variables: `{ and: [scopePart, recentPart] }`.
  - `scopePart`: "Assigned to me" → `{ assignee: { isMe: { eq: true } } }`; a team → `{ team: { id: { eq: <teamId> } } }`.
  - `recentPart` (only when `since` is set): `{ or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { updatedAt: { gt: <since ISO> } }] }`. Finished issues are limited to those updated in the last N days, N = the board view's `hideFinishedAfterDays` (default 14; 0 = no limit), the same rule Flowly uses for its own Done/Cancelled columns.
- `listTeams(connection, fetch)`: `query Teams($first: Int) { teams(first: $first) { nodes { id key name } } }` with `first: 100`, sorted by name.
- Both go through the existing `graphql()` helper, so the read-only guard (`^query\s`, no `mutation`/`subscription`) and the error mapping of CONNECTORS-SPEC §14 apply unchanged. `ConnectorService` runs them through `call()` (backoff, `authFailed`). A connection that is not Linear is `EXTERNAL_INVALID`.

### 3.2 Issue row

`linearIssueRowSchema` (shared): `key` (ENG-123), `remoteId`, `title`, `url`, `updated`, `priority` (0 none, 1 urgent … 4 low), `priorityLabel` ("" for none), `stateName`, `stateType` (Linear's type, lowercased), `statePosition`, `assignee` (display name or ""), `teamKey`, `teamName`, and `card` (see 3.3) or null.

### 3.3 "Already has a card" marker

The daemon marks each row with the card that already references it: a non-archived card that has an artifact whose `external` is of family `linear` with the same `key` (any Linear connection, as the New task picker's "On card"). With several, the most recently updated card wins. `card = { taskId, projectId, workspaceId, title }`.

### 3.4 RPCs

- `connectors.linear-board` `{ connectionId, teamId?, recentDays (0–365) }` → `{ issues, truncated }`. No `teamId` = Assigned to me.
- `connectors.linear-teams` `{ connectionId }` → `{ teams: { id, key, name }[] }`.
- `connectors.read-item` `{ connectionId, key, itemType?, refresh? }` → the same output as `connectors.read`: the preview of an item that is not (yet) a card input. Reads through `ConnectorService.detail` (60 s cache).

Client caching: react-query, 60 s stale time, no polling, refetch only on open or the Refresh button.

## 4. Board

- Columns by **state type**, in order: Backlog (`backlog`, `triage`, and any unknown type), Todo (`unstarted`), In progress (`started`), Done (`completed`), Canceled (`canceled`/`cancelled`). A team's custom state names land in the column of their type; the card shows the state name when it differs from the column title.
- Inside a column: by priority (urgent first, no priority last), then most recently updated.
- Toolbar: connection switch (only with more than one Linear connection), scope (Assigned to me, then each team as `KEY · Name`), Board / List toggle, Refresh.
- Card face: key, title (two lines), priority label when set, assignee, and a "Card" marker when 3.3 found one.
- **List**: the same issues as one list, grouped by column with a count per header, same rows and actions.
- Remembered (board-view settings, host scope): `linearLayout` (`auto` | `board` | `list`; `auto` = list on compact layouts, board otherwise), `linearScope` (`me` or a team id; a team the key no longer sees falls back to `me`), and the connection in `lastConnections.linear` (shared with the New task picker).
- States: loading; error (the connector's message, e.g. refused key, with Refresh); empty column shows nothing but its header; no issues at all → "No issues in this view."; `truncated` → "Showing the {n} most recently updated issues."

## 5. Issue preview and actions

- Pressing an issue opens the existing external preview (the same view as an attached input's preview: Open in Linear, Refresh, the item's Markdown) reading through `connectors.read-item`.
- The preview adds **Start card**, or **Open card** when the row has a card.
- **Start card** opens the Flowly board screen with params `{ linearIssue: <key>, connectionId, requestId }`. The board, once its overview is loaded, reads the issue's summary through `connectors.search` (query = the key), then opens New task in the board's current project (the project viewed last; the first project on a cold start) with:
  - the issue attached as a From Linear item,
  - the title prefilled from the issue title (the existing rule: a later pick may replace it while unchanged),
  - Start an agent now on for this form (the remembered on/off setting is not changed),
  - the first instruction optional (UI-REFRESH-SPEC §7s: an empty box sends the default that points at the attached item).
  Nothing else about the form changes. Each `requestId` is applied once. With no project: "Create a project first, then start the card again." An issue that cannot be read shows the connector's error on the board.
- **Open card** opens the board screen with `{ openTaskId, projectId, workspaceId, requestId }`; the board switches to that project and opens the card's sidebar (as a search result does).
- Session-link parsing ignores both param sets.

## 6. Phone

Compact layouts default to List (`auto`). Rows are memoized; the list is one scroll view. No polling.

## 7. Acceptance

- Linear row appears in the main bar with a Linear connection, and not without.
- The board shows Assigned to me by state type; custom state names map by type; Done/Canceled show only recently updated issues.
- Scope switch to a team, list toggle (remembered), connection switch with two connections.
- Start card → Create starts a card session with the issue attached and no typed instruction.
- An issue already on a card shows the marker and Open card, which opens that card.
- Every new GraphQL document is a plain `query`; the read-only guard test still passes.

Tests: `server/connectors/linear-scope.test.ts` (scope filter, paging over fake replies, teams, guard; the existing guard test in `linear.test.ts` is unchanged), `shared/linear-board.test.ts` (columns, ordering, markers), `client/linear-start.test.ts` (link parsing, seed, project choice, optional first message), `shared/settings.test.ts` (layout and scope defaults); `client/linear-start.test.ts` also checks that session and idea links ignore the new params.

Onboarding: a More features row on the tour's last page. No new tip id and no What's new entry (decided at release). Telemetry: no heartbeat field (TELEMETRY-SPEC §4.6 does not send connector types).
