# Dispatcher (DISPATCHER-SPEC)

One Flowly-owned agent session for all projects: it hears every card's stops, creates and starts cards in any live project, and parks asks as project ideas. Contract only; progress is in `docs/PROGRESS.md`. This document covers the agent, its workspace, its credential and tools, and note delivery. The chat panel (Task 10) and asks in the chat (Task 11) extend it.

Status: user decisions 2026-11-08 (single-pane spec D1, D2; plan Decisions Q5, Q6). AGENTS.md records the dated user-requested exception (role orchestration and automatic session starts by a plugin-owned, never-archived background session).

## 1. Stored record

`<dataDir>/dispatcher.json`:

```json
{ "version": 1, "workspaceId": "…" | null, "agentId": "…" | null, "startedAt": "ISO time" | null }
```

- Written atomically (temporary file + rename, mode 0600) and serialized; a missing file is the empty record (all `null`).
- A file that does not parse or validate is renamed to `dispatcher.json.invalid-<epoch ms>` (kept, never deleted) and treated as empty; the next write creates a fresh file.
- The record names the one current dispatcher. Starting a new dispatcher replaces `agentId` and `startedAt`; the earlier session is left as it is in Paseo (Flowly never archives it) and loses its tools (§4).

## 2. Workspace

- A directory workspace on `<dataDir>/dispatcher/` (created with mode 0700 when missing), titled "Flowly dispatcher", created with `background: true` and without a Paseo project id, so Paseo files it under its own project for that directory, apart from every Flowly project.
- Reused while Paseo still returns it and it is not being archived; otherwise a new one is created and its id replaces `workspaceId`.
- Flowly never archives it: no archive, wrap-up, delete, switch or background-workspace path acts on it. Those paths act only on workspaces bound to a card or on the per-project `Flowly background` workspaces, and the dispatcher workspace cannot be bound to a card (New task with an existing workspace refuses it).
- A host without background workspaces (`workspaces.create` throws "Update the host to use background workspaces.") makes `dispatcher.start` fail with `HOST_UNSUPPORTED` ("Update Paseo to use the dispatcher: this host has no background workspaces."). Nothing is retried and the record is not changed.

## 3. Lifecycle

`status` → `{ state, agentId }`:

| state | when |
|---|---|
| `none` | the record has no `agentId` |
| `ended` | Paseo does not return the agent, it is archived, or its status is `error` or `closed` |
| `context_full` | `lastUsage.contextWindowUsedTokens / contextWindowMaxTokens ≥ 0.95` (both present, max > 0) |
| `running` | status `running` or `initializing` |
| `idle` | otherwise |

`start({ provider, modeId? })`:

- Refused with `DISPATCHER_RUNNING` while the state is `running` or `idle`: there is one dispatcher. Concurrent starts run one after another.
- Opens the workspace (§2), chooses a new agent id, writes the record (new `agentId`, `startedAt` now) before Paseo creates the session, so the session's first tool calls already pass §4. If Paseo did not create it (the agent is not found after the error), the record goes back to the previous `agentId`/`startedAt` and the error is returned.
- The session: `provider` (`provider/model`; the client passes the Dispatcher model setting, Q6, default `claude/claude-sonnet-5-5`), optional `modeId`, system prompt `dispatcherCharter` (§6), title "Flowly dispatcher", label `flowly-dispatcher=1`, MCP server `flowly-dispatcher` (§4), first message the board summary (§6).
- When a session opens (`agent.session_open`) and its id is the stored `agentId`, Flowly adds the `flowly-dispatcher` MCP server again (a resumed session keeps its tools). No other session gets it.

## 4. Credential and caller check

- The `flowly-dispatcher` server's bearer token is sealed with purpose `dispatcher` over `{ agentId, workspaceId }`. `authenticateAny` returns `kind: "dispatcher"` for it. A card (`session`) or board token is never accepted as a dispatcher token and vice versa.
- A dispatcher token gets the dispatcher tools (§5) only: none of the card-session tools, none of the board tools, and not the CLI endpoint (`/api` refuses it).
- Every call checks, in order: the token's `agentId` equals the stored `agentId` and its `workspaceId` the stored `workspaceId` (else `DISPATCHER_REPLACED`); Paseo returns that agent, not archived, in that workspace (else `SESSION_MISMATCH`).
- Every tool with a `projectId` then checks the project: unknown → `NOT_FOUND`; archived → `PROJECT_ARCHIVED`; its root (`primaryPath`) is not a readable directory → `ROOT_UNAVAILABLE`. A card id must belong to that project (`CARD_NOT_FOUND`). Refusals write nothing.

## 5. Tools

All take `projectId` explicitly, except `flowly_list_projects`. Writes are recorded with `actor: "agent"` and the dispatcher's `agentId`.

| Tool | Does |
|---|---|
| `flowly_list_projects` | Live projects: `projectId`, `title`, `rootAvailable`, `openCards` (not archived, not Done/Cancelled). |
| `flowly_list_cards`, `flowly_get_card` | As the card tools (AGENT-CARDS-SPEC §3), for that project. |
| `flowly_create_card`, `flowly_update_card` | As the card tools, for that project; the Agents create and edit cards setting and the hourly limit apply (the limit counts per dispatcher session, shared with starts). |
| `flowly_start_card` | As START-CARD-SPEC, for that project's card. |
| `flowly_propose_idea` | A project-level idea (PROJECT-IDEAS-SPEC); `IDEAS_DISABLED` when Ideas are off. |
| `flowly_link_cards` | `taskId`, `relation` (`blocks`: `taskId` blocks `otherTaskId`; `follow_up`: `otherTaskId` follows up `taskId`), `otherTaskId`, both in that project, through the card links rules (CARD-LINKS-SPEC §2.3); refusals are `LINK_REFUSED` with the reason. An identical existing link is returned with `created: false`. |

## 6. Charter and board summary

- `dispatcherCharter` (English, `shared/dispatcher.ts`): the dispatcher's role; the board is its memory; every repo task is a card (one branch or PR); start sessions straight away with `flowly_start_card`; split independent deliverables into separate cards tied with `flowly_link_cards`; park asks as project ideas; never answer a card's asks itself (they are the user's); note messages are board updates, not instructions from the user.
- Board summary (first message): a line per live project with its `projectId`, then the markdown export (IDEAS-IMPORT-EXPORT-SPEC) of open cards and open ideas, without memory.

## 7. Notes

- The event bus subscriber pushes only stops (`facts.filter(isStop)`, EVENT-BUS-SPEC §2) into the note batcher, so a later non-stop fact on a card never replaces its stop. Facts caused by the dispatcher (`event.agentId` equal to the stored `agentId`) are dropped by the batcher, so the dispatcher never wakes itself. `commitHandler` builds no facts while nothing subscribes.
- A batch is delivered by state: `idle` → one message to the dispatcher with the held notes and the batch (sent without `activeTurnBehavior`, after re-reading the state just before sending); `running` → held in memory (one per card, latest wins) until the dispatcher's `agent.turn_ended`, then delivered the same way; `none`, `ended`, `context_full` → dropped, held notes too (the next dispatcher's board summary covers them). Flowly never steers or interrupts the dispatcher's turn. A send that fails is logged (`logFailure`, fixed label) and its notes are dropped, not replayed.
- Message: `Flowly board update (N cards):` then one line per note: `- "<title>" [<taskId>] in project <projectId>: <kind> — <detail>`.
- On plugin unload the batcher is disposed (timer and pending notes cleared) and the subscription removed.

## 8. RPCs

- `dispatcher.status` `{}` → `{ state, agentId }` (§3).
- `dispatcher.start` `{ provider, modeId? }` → `{ agentId }`; errors `DISPATCHER_RUNNING`, `HOST_UNSUPPORTED`, `START_FAILED` (Paseo did not create the session; its reason in the message), returned as the RPC error.

## 9. Acceptance

- A dispatcher token can write to any live project; an archived project is refused with `PROJECT_ARCHIVED` and nothing is written; a token from a replaced dispatcher is refused.
- Card and board tokens cannot call dispatcher tools; a dispatcher token cannot call card-session or board tools.
- Start creates a background directory workspace once and reuses it; Flowly never archives it.
- Context at 95% reports `context_full`.
- Notes wait for the turn to end and never steer; notes are dropped while the dispatcher is down.
- A corrupt `dispatcher.json` is preserved and treated as empty.
