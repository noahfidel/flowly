# Linear board

Status: accepted 2026-11-04 (plan `2026-11-04-flowly-linear-board`). Builds on the Linear connector (CONNECTORS-SPEC §14).

## 1. Goal

A **Linear** entry in Paseo's main bar opens a board of the user's Linear issues. From any issue, **Start card** opens Flowly's Quick task dialog (QUICK-TASK-SPEC §9) with the issue attached, so Start card → Enter starts a card session. An issue a Flowly card already references offers **Open card** instead.

Out of scope: writing to Linear (status, comments, assignment, new issues), background polling or webhooks, other services on this board, replacing Flowly's board or the New task picker.

## 2. Entry point

- `contribute` registers a second screen `linear` and a sidebar header item `linear`, both titled "Linear" (a brand, not translated). The row shows the Linear brand icon.
- The row renders only when at least one Linear connection exists (`connectors.connections`, the same query and cache as the settings page). With none, nothing is shown; the screen itself, when opened by URL, shows "Add a Linear connection in Flowly → Settings → Connections." with an Open Flowly button.
- Plugin load starts no network work: the connections read happens when the sidebar row mounts.

## 3. Data

### 3.1 Scope query (daemon, read-only)

`linearAdapter`'s module exports three read-only functions, used only for connections of family `linear`:

- `listScope(connection, fetch, scope, { since, pageSize = 50, maxPages = 4 })`: one GraphQL document
  `query Scope($filter: IssueFilter, $first: Int, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { … } pageInfo { hasNextPage endCursor } } }`,
  requested page by page with `after = endCursor` until `hasNextPage` is false or `maxPages` pages were read. `truncated` is true when more pages remained. Duplicate identifiers across pages are dropped. After the pages, the scope's workflow states are read (below) and returned as `states`.
- Filter, sent only as variables: `{ and: [scopePart, recentPart] }`.
  - `scopePart`: "Assigned to me" → `{ assignee: { isMe: { eq: true } } }`; a team → `{ team: { id: { eq: <teamId> } } }`.
  - `recentPart` (only when `since` is set): `{ or: [{ state: { type: { nin: ["completed", "canceled", "duplicate"] } } }, { updatedAt: { gt: <since ISO> } }] }`. Finished issues are limited to those updated in the last N days, N = the board view's `hideFinishedAfterDays` (default 14; 0 = no limit), the same rule Flowly uses for its own Done/Cancelled columns.
- `scopeStates`: `query States($filter: WorkflowStateFilter, $first: Int) { workflowStates(filter: $filter, first: $first) { nodes { id name type position team { id } } } }`, variables `{ filter: { team: { id: { in: <teamIds> } } }, first: 250 }`. A team scope reads that team's id; Assigned to me reads the distinct team ids of the loaded issues. With no issues there is no request and `states` is empty. Archived states are not returned (Linear's default). A failed read fails the board read with the connector's error.
- `listTeams(connection, fetch)`: `query Teams($first: Int) { teams(first: $first) { nodes { id key name } } }` with `first: 100`, sorted by name.
- Both go through the existing `graphql()` helper, so the read-only guard (`^query\s`, no `mutation`/`subscription`) and the error mapping of CONNECTORS-SPEC §14 apply unchanged. `ConnectorService` runs them through `call()` (backoff, `authFailed`). A connection that is not Linear is `EXTERNAL_INVALID`.

### 3.2 Issue row

`linearIssueRowSchema` (shared): `key` (ENG-123), `remoteId`, `title`, `url`, `updated`, `priority` (0 none, 1 urgent … 4 low), `priorityLabel` ("" for none), `stateName`, `stateType` (Linear's type, lowercased), `statePosition`, `assignee` (display name or ""), `teamKey`, `teamName`, `stateId`, `teamId` ("" when Linear gave none), and `card` (see 3.3) or null.

### 3.3 "Already has a card" marker

The daemon marks each row with the card that already references it: a non-archived card that has an artifact whose `external` is of family `linear` with the same `key` (any Linear connection, as the New task picker's "On card"). With several, the most recently updated card wins. `card = { taskId, projectId, workspaceId, title }`.

### 3.4 RPCs

- `connectors.linear-board` `{ connectionId, teamId?, recentDays (0–365) }` → `{ issues, states: { id, name, type, position, teamId }[], truncated }`. No `teamId` = Assigned to me.
- `connectors.linear-teams` `{ connectionId }` → `{ teams: { id, key, name }[] }`.
- `connectors.read-item` `{ connectionId, key, itemType?, refresh? }` → the same output as `connectors.read`: the preview of an item that is not (yet) a card input. Reads through `ConnectorService.detail` (60 s cache).

Client caching: react-query, 60 s stale time, no polling, refetch only on open or the Refresh button.

## 4. Board

- One lane per **workflow state** (ruling 2026-11-23: the old five state-type columns merged custom states and put Triage and Duplicate in Backlog). The lane key is the state name lowercased and trimmed, so Assigned to me merges the same-named states of several teams into one lane; the title is the state's name as Linear spells it (user data, not translated). Order is Linear's board order: type rank (triage, backlog, unstarted, started, completed, canceled, duplicate, unknown types last), then the lowest `position` among the merged states, then name. Every state in `states` gets a lane even with no issues. An issue whose state is not in `states` (archived state, unknown type) makes a lane from its own `stateName`, `stateType` and `statePosition`, so no issue is dropped. A state with an empty name is the lane with key "" titled "No state". Duplicate (type `duplicate`) has its own lane and is trimmed by the recent filter like Done and Canceled.
- Inside a lane: by priority (urgent first, no priority last), then most recently updated.
- Toolbar: connection switch (only with more than one Linear connection), scope (Assigned to me, then each team as `KEY · Name`), Board / List toggle, Refresh.
- Status filter (user request 2026-11-04): one chip per lane under the toolbar, pressed to hide or show that lane in both layouts. Hidden lanes are remembered by lane key (`linearHidden`, board-view settings, up to 100 strings of up to 100 characters, default none hidden; older stored state types match no lane and are harmless). Hiding is client-side; the query does not change. When every lane with issues is hidden, the board says "No issues in this view."
- Search (user request 2026-11-23): a box in the page, under the toolbar and above the status chips (inline, so it works on phones too), with a clear (X) icon button while it holds text. It filters live over the issues already loaded, client-side; the query does not change. Fields matched, case-insensitively: key, title, assignee, state name, team key and name, priority label. Labels and project are not loaded today (widening the GraphQL document and row schema is out of scope), so they are not matched. The text splits on whitespace and every word must appear in some field (`zen deploy` finds ZEN-1 "Fix deploy", not ZEN-1 "Fix build"); blank text is no filter. Search applies after the status chips (hidden lanes stay hidden); while the text is non-blank, lanes with no match are left out in both layouts and lane counts show matches. Nothing matches (and the shown lanes had issues) → "No issues match your search."; otherwise "No issues in this view." stays. While text is typed, a muted line under the box says what is searched: when `truncated`, "Searches only the {n} most recently updated issues loaded here, not all of Linear."; else "Searches only the issues on this board, not all of Linear." The text is remembered per scope (`linearSearch`, below). No keyboard shortcut: board shortcuts (SHORTCUTS-SPEC §2.1) are the Flowly board root's handler and the Linear screen has none, so a key there would be a new shortcut scope.
- Card face: key, title (two lines), priority label when set, assignee, and a "Card" marker when 3.3 found one.
- **List**: the same issues as one list, grouped by lane with a count per header, same rows and actions.
- Remembered (board-view settings, host scope): `linearLayout` (`auto` | `board` | `list`; `auto` = list on compact layouts, board otherwise), `linearScope` (`me` or a team id; a team the key no longer sees falls back to `me`), the connection in `lastConnections.linear` (shared with the New task picker), and `linearSearch` (the search text by `<connectionId>:<me|teamId>`, at most 100 entries of up to 200 characters, a bad map falls back to none). Typing filters live (150 ms); the text is saved after a 500 ms pause, on a scope or connection change and on leaving the screen; clearing saves at once; past 100 entries the oldest goes.
- States: loading; error (the connector's message, e.g. refused key, with Refresh); empty lane shows nothing but its header; no issues at all → "No issues in this view."; `truncated` → "Showing the {n} most recently updated issues."

## 5. Issue preview and actions

- Pressing an issue opens the existing external preview (the same view as an attached input's preview: Open in Linear, Refresh, the item's Markdown) reading through `connectors.read-item`.
- The preview adds **Start card**, or **Open card** when the row has a card.
- **Start card** opens the Flowly board screen with params `{ linearIssue: <key>, connectionId, requestId }`. The board, once its overview, the board groups and the board-view settings are loaded (so a cold start uses the stored group and Project filter), reads the issue's summary through `connectors.search` (query = the key), then opens Quick task in the shown group's quick project: the group's Project filter, else the last quick-task project when a live member of that group, else the group's first member (an empty group falls back as New task does, QUICK-TASK-SPEC §3); the Project picker lists that group's projects only, and the Group picker works as for every entry point. Whatever the *Quick task for New task* setting says, with:
  - the issue attached as a From Linear item, shown as a removable chip, exactly as the full form attaches it, so it becomes a Linear artifact on the card (the per-project Linear ticket block, LINEAR-TICKET-SPEC §2, is therefore never added);
  - the card titled `<KEY>: <issue title>` (the key alone when the issue has no title); no AI title run for it;
  - the text box optional (UI-REFRESH-SPEC §7s: an empty box sends the default that points at the attached item; typed text is sent as typed).
  The agent, workspace and **More options…** behave as in Quick task; More options… opens the full form with the issue still attached. Each `requestId` is applied once. With no live project: "Create a project first, then start the card again." An issue that cannot be read shows the connector's error on the board.
- **Open card** opens the board screen with `{ openTaskId, projectId, workspaceId, requestId }`; the board switches to the card's group tab (the card may be in another group than the one shown) and opens its sidebar (as a search result does), leaving each group's Project filter as it is.
- Session-link parsing ignores both param sets.

## 6. Phone

Compact layouts default to List (`auto`). The search box is full width in the toolbar area. Rows are memoized; the list is one scroll view. No polling.

## 7. Acceptance

- Linear row appears in the main bar with a Linear connection, and not without.
- The board shows one lane per workflow state (ZEN: Triage, Backlog, To Do, In Progress, In Review, Awaiting Deploy, Deployed, Done, Canceled, Duplicate), in Linear's order and with empty lanes; Assigned to me merges same-named states across teams; Done/Canceled/Duplicate show only recently updated issues.
- Scope switch to a team, list toggle (remembered), connection switch with two connections.
- Start card → Enter (empty box) starts a card session titled `KEY: title` with the issue attached and the default first message; no `tasks.quick-title` call is made.
- An issue already on a card shows the marker and Open card, which opens that card.
- Search: typing filters the loaded issues live by key, title, assignee, state, team and priority (all words must match); clear restores them; no match shows "No issues match your search."; the scope note is visible while text is typed; the text comes back per scope after a reload.
- Every new GraphQL document is a plain `query`; the read-only guard test still passes.

Tests: `server/connectors/linear-scope.test.ts` (scope filter incl. duplicate, paging over fake replies, states query per scope, teams, guard; the existing guard test in `linear.test.ts` is unchanged), `shared/linear-board.test.ts` (lanes, merging, ordering, filter, search matching and lane filtering, markers), `client/linear-start.test.ts` (link parsing, Quick task seed, the shown group's project), `client/quick-task.test.ts` (seeded title, no AI title, default message), `server/linear-ticket.test.ts` (no ticket block for a Linear-seeded card), `shared/settings.test.ts` (layout and scope defaults, lane-key `linearHidden`, `linearSearch` fallback and cap); `client/linear-start.test.ts` also checks that session and idea links ignore the new params.

Onboarding: a More features row on the tour's last page. No new tip id and no What's new entry (decided at release). Telemetry: no heartbeat field (TELEMETRY-SPEC §4.6 does not send connector types).
