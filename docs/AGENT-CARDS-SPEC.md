# Agent card tools: create and edit cards (AGENT-CARDS-SPEC)

Status: user decisions 2026-10-29, card "create cards via ai agent":

- **D1 Policy.** An agent creates a card only when the user asks it to in the session ("split this into cards", "make a card for X"). Follow-up work the user did not ask for stays an idea (`flowly_propose_idea`). This amends IDEAS-SPEC §1 ("an agent never creates cards itself"); ideas remain the path for unasked suggestions.
  - *Amended 2026-11-08 (user-requested, single-pane plan Q3):* "No workspace without a card": a session that starts repo work in a workspace with no card creates a worktree card for it and moves the work there (`flowly_create_card` + `flowly_start_card`, START-CARD-SPEC) without being asked. Unasked follow-ups that are not work the session is starting stay ideas.
- **D2 Update scope.** An agent may edit any live card of its project, not only its own or the ones it created. The user chose this over "own card + cards an agent created" after hearing the risk that an agent can rewrite another card's requirements. The revision check, activity entries and D1 limit it.
- **D3 New card.** Like the New card form's default: a new workspace in the project directory (`mode: "directory"`), lane Backlog or Todo, no session. The user starts the session.
  - *Amended 2026-11-08 (user-requested, single-pane plan Q2(b)):* `workspace: "worktree"` creates the card in a new worktree instead (§3.3), and an agent may start a card's session with `flowly_start_card` (START-CARD-SPEC), which moves a session-less directory card Flowly created into a worktree first.
- **D4 Callers.** Any Paseo session in a Flowly project's workspaces, not only card sessions. The user chose this after hearing that it needs a new project-scoped credential and injection. Delivered over MCP on hosts whose `agent.session_open` hook accepts `mcpServers` (Paseo 0.14); card sessions also get it through their existing MCP server and CLI on every host.

## 1. Goal and non-goals

An AI agent can, when asked, read the cards of its project, create a card and edit a card, through MCP tools (and the card CLI).

Non-goals (v1):

- Assigning a card or creating it in another project. (Starting a session and creating in a worktree moved to START-CARD-SPEC, 2026-11-08.)
- Moving a card into a work stage, In review, Done or Cancelled with these tools; deleting, archiving or restoring cards; editing links, workpads, artifacts or ideas of other cards.
- A CLI for sessions outside cards (they get MCP only). Sessions outside cards on hosts without `mcpServers` in `agent.session_open` get nothing.
- External inputs (Jira, GitHub …) on create.
- Exact replays of an edit: a retried edit after a lost response gets `REVISION_CONFLICT`, and the agent re-reads.

## 2. Callers and access

### 2.1 Card sessions

The four tools (§3) are registered on the card MCP server (`flowly`) and in the card CLI (§5). The project is the card's project. Every call checks the session as the other tools do (`SESSION_MISMATCH`, `RESOURCE_UNAVAILABLE`). They take no signed `request` or `expectedRevision`: creating or editing another card does not depend on this card's revision.

### 2.2 Sessions outside cards

`server.before("agent.session_open")` adds an MCP server named `flowly-board` (`{ type: "http", url: <tool service>/mcp, headers: { Authorization: "Bearer <credential>" } }`) when all of these hold:

- the host's request has an `mcpServers` field (feature-detected; older hosts are left unchanged),
- `purpose` is `interactive` and `workspaceId` is set,
- the setting (§2.3) is on,
- the session is not Flowly-managed (it has no card context: it already gets the tools through `flowly`),
- its labels are not Flowly's own short-lived sessions (`isSummarizer`),
- the workspace's native project is the `paseoProjectId` of a live (not archived) Flowly project.

The credential is the HMAC-sealed `{ agentId, workspaceId, projectId }` with its own purpose (`board`), so it is never accepted as a card credential and nothing is stored on disk. The hook never blocks a session from opening: any failure is logged and the request is returned unchanged.

Each call re-checks: the session exists, is not archived and is still in that workspace; the workspace exists and still belongs to the project's native project; the project is live; the setting is on. Failures: `SESSION_MISMATCH`, `RESOURCE_UNAVAILABLE`, `ARCHIVED`, `AGENT_CARDS_DISABLED`.

### 2.3 Setting

Settings → AI features → Cards: **Agents create and edit cards** (`ideas` settings, field `agentCards`, default on). Detail: *Only when you ask. Sessions in a project's folders that are not on a card get these tools too.*

Off: `flowly_create_card` and `flowly_update_card` refuse with `AGENT_CARDS_DISABLED`; sessions outside cards get no `flowly-board` server at their next open, and their calls refuse with `AGENT_CARDS_DISABLED`. Card sessions keep `flowly_list_cards` and `flowly_get_card`.

## 3. Tools

All four are the same for both callers. A *card view* is:

`{ taskId, title, description, status, laneName, priority, type?, tags: [{ tag, by }], revision, createdAt, updatedAt, archived, workspaceId, links: [{ relation, taskId, title, status }] }`

### 3.1 `flowly_list_cards` (read-only)

Input: `query?` (words that must all appear in title, description or tags, case-insensitive), `status?` (array of statuses), `includeArchived?` (default false), `limit?` (1–200, default 50).

Output: `{ project: { id, title }, lanes: [{ status, name }], cards: [...], truncated }`. Each card: `{ taskId, title, status, laneName, priority, type?, tags: string[], revision, updatedAt, archived, description }` with `description` cut to 300 characters (`descriptionTruncated: true` when cut). Order: lane order, then board position.

### 3.2 `flowly_get_card` (read-only)

Input: `taskId`. Output: `{ card: <card view>, editable, reason }`. `editable` is false for archived and Done/Cancelled cards, with the reason. A card of another project is `CARD_NOT_FOUND`.

### 3.3 `flowly_create_card`

Input:

| Field | Rule |
|---|---|
| `title` | 1–200 characters |
| `description` | up to 20000 characters, default empty |
| `status` | `backlog` or `todo`, default the first of them that is a lane of the project |
| `priority` | `low` / `normal` / `high` / `urgent`, default `normal` |
| `type` | optional task type |
| `tags` | optional, normalized like `flowly_set_tags`, at most 12 on a card |
| `workspace` | `directory` (default) or `worktree` (START-CARD-SPEC §7; a linked-root project refuses `worktree` with `WORKTREE_UNAVAILABLE`) |
| `idempotencyKey` | 1–200 characters, chosen by the agent; the same key retries the same create |
| `linearTicket` | optional boolean: `false` opts the card out of the project's Linear ticket ask, `true` or omitted inherits it (LINEAR-TICKET-SPEC §5) |

Behavior:

1. Checks (no workspace is created when one fails): setting on (`AGENT_CARDS_DISABLED`), project live (`ARCHIVED`), lane allowed and enabled (`STATUS_UNAVAILABLE`), tags valid (`TAG_INVALID`), at most 20 new cards per session per hour (`CARD_LIMIT`, counted in memory, reset by a plugin reload; `flowly_start_card` counts against the same limit).
2. `operationId` = `agent-card:<sha256(caller scope + idempotencyKey)>`, scope = card id or project id plus the agent id. A card with that `operationId` already in the project returns it with `replayed: true`; a different title under the same key is `REQUEST_REUSED`.
3. The card is created through the same path as the New card form (`BoardService.createTask`, `mode: "directory"`, or `mode: "worktree"` for `workspace: "worktree"`): a new Paseo workspace in the project directory or a new worktree branched off the main checkout's current branch, same position rules.
4. Its `created` event has `actor: "agent"` and the session's `agentId`. Tags are recorded `by: "agent"` with the `agentId`.
5. Card sessions: the new card follows up the session's card (`derived` link, CARD-LINKS-SPEC §3), and the session's card gets an event `card_created` (`actor: "agent"`, note = the new card's title).

Output: `{ card: <card view>, replayed }`. A failure of the New card path is `CARD_CREATE_FAILED` with its message (after the workspace exists it names the workspace); retrying with the same key reuses that workspace.

### 3.4 `flowly_update_card`

Input: `taskId`, `revision` (the card's revision from list/get), and at least one of: `title`, `description`, `priority`, `type`, `addTags`, `removeTags`, `status` (`backlog` or `todo`), `linearTicket` (`false` opts out of the Linear ticket ask, `true` inherits the project's again; LINEAR-TICKET-SPEC §5).

Rules, all checked in one transaction (nothing changes when one fails):

- setting on (`AGENT_CARDS_DISABLED`); card in the caller's project (`CARD_NOT_FOUND`); not archived (`ARCHIVED`); not Done/Cancelled (`TASK_FINISHED`); `revision` equal to the card's (`REVISION_CONFLICT` with the current revision).
- `status` only between Backlog and Todo, and only for a card that is in one of them; any other move is `STATUS_FORBIDDEN` (work stages belong to the card's own session through `flowly_update_status`; Done and Cancelled to the user). The lane must be enabled (`STATUS_UNAVAILABLE`).
- `type` sets or changes the type (an explicit edit, unlike `flowly_set_type`, which only fills a missing one).
- `removeTags` removes only tags an agent added (`TAG_FORBIDDEN`); `addTags` respects the 12-tag limit (`TAG_INVALID`).
- No field differs from the card: nothing is written, `changed: []`.

Effect: changed fields are written, `revision` +1, `updatedAt` set; event `edited` (or `status_changed` with from/to when the lane changed) with `actor: "agent"`, `agentId`, note `Changed <fields>`; a tag change also records `tags_changed`. The revision bump makes open forms and that card's sessions re-read, like a human edit.

Output: `{ card: <card view>, changed: string[] }`.

## 4. Errors

Tool errors use the existing `{ code, message, retryable }` shape. New codes: `AGENT_CARDS_DISABLED`, `CARD_NOT_FOUND`, `CARD_LIMIT`, `STATUS_FORBIDDEN`, `CARD_CREATE_FAILED` (the New card path refused, e.g. the workspace could not be created or the source card has 50 links; the message says why). Reused: `SESSION_MISMATCH`, `RESOURCE_UNAVAILABLE`, `ARCHIVED`, `TASK_FINISHED`, `REVISION_CONFLICT`, `STATUS_UNAVAILABLE`, `TAG_INVALID`, `TAG_FORBIDDEN`, `REQUEST_REUSED`, `INVALID_INPUT`.

## 5. CLI (card sessions)

`flowly.mjs` gains `cards [--input '<JSON>']`, `card --id <taskId>`, `create-card --input '<JSON>'` and `update-card --input '<JSON>'`; the JSON is the matching tool's input (`flowly_list_cards`, `flowly_create_card`, `flowly_update_card`). HTTP API actions `list_cards`, `get_card`, `create_card`, `update_card`, card credentials only (a board credential gets `401 UNAUTHORIZED` there). No request file.

## 6. Skill and instructions

The skill replaces "never start one or create cards yourself" with: create or edit cards (`flowly_create_card`, `flowly_update_card`) only when the user asks; otherwise propose an idea. Read the card first (`flowly_get_card`) and pass its revision; on `REVISION_CONFLICT` re-read and keep the other person's changes.

## 7. Data and UI

- No storage change. Attribution lives in events (`actor: "agent"`, `agentId`).
- Activity: `card_created` reads *Created a card*; the note is the new card's title.
- Settings → AI features gets the Cards group with the switch (§2.3).
- Onboarding: one More features entry, *Cards from your agents*: *Ask an agent to create or edit cards. New cards land in Backlog or Todo; you start them.*
- Telemetry: no heartbeat field (this fork keeps telemetry off).

## 8. Acceptance

- `server/agent-cards.test.ts`: create (workspace, lane default, follow-up link and `card_created` for card sessions, agent actor and tag attribution), idempotent replay, `REQUEST_REUSED`, `CARD_LIMIT`, lane and setting refusals before any workspace; update (fields, revision conflict, Backlog↔Todo only, finished/archived/other-project refusals, agent-only tag removal, no-op); list/get (filters, truncation, other projects hidden); who gets the board server and the per-call re-checks of a board caller (`boardSession`, `boardCaller`).
- `server/tool-server.test.ts`: the card MCP server lists the four tools; a board credential (from `boardServer`) lists only them, cannot call card tools and gets 401 on `/api`; the CLI's four commands.
- Not covered by tests: the hook's feature detection itself (`index.server.ts`), which needs a live Paseo 0.14 host.
- `npm run typecheck` and `npm test` pass; all catalogs have the new strings.

## 9. The card's plan (2026-11-10)

Card tools gain `flowly_set_plan` and `flowly_clear_plan` (same callers, scope and switch as `flowly_update_card`), `flowly_create_card` gains optional `plan: { target, title?, approved }`, and the card view gains `plan: { title, approved } | null`. This amends the §1 non-goal "editing … artifacts … of other cards" for the plan slot only. See [CARD-PLAN-SPEC](CARD-PLAN-SPEC.md) §5.2.
