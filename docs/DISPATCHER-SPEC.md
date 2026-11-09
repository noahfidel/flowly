# Dispatcher (DISPATCHER-SPEC)

One Flowly-owned agent session for all projects: it hears every card's stops, creates and starts cards in any live project, and parks asks as project ideas. Contract only; progress is in `docs/PROGRESS.md`. This document covers the agent, its workspace, its credential and tools, and note delivery. The chat panel (Task 10) and asks in the chat (Task 11) extend it.

Status: user decisions 2026-11-08 (single-pane spec D1, D2; plan Decisions Q5, Q6). AGENTS.md records the dated user-requested exception (role orchestration and automatic session starts by a plugin-owned, never-archived background session).

## 1. Stored record

`<dataDir>/dispatcher.json`:

```json
{ "version": 1, "workspaceId": "…" | null, "agentId": "…" | null, "startedAt": "ISO time" | null, "seenRevision"?: number }
```

`seenRevision` is the user's "Changed since you looked" mark (§9.2); every write keeps the fields it does not change.

- Written atomically (temporary file + rename, mode 0600) and serialized; a missing file is the empty record (all `null`).
- A file that does not parse or validate is renamed to `dispatcher.json.invalid-<epoch ms>` (kept, never deleted) and treated as empty; the next write creates a fresh file.
- The record names the one current dispatcher. Starting a new dispatcher replaces `agentId` and `startedAt`; the earlier session is left as it is in Paseo (Flowly never archives it) and loses its tools (§4).

## 2. Workspace

- A directory workspace on `<dataDir>/dispatcher/` (created with mode 0700 when missing), titled "Flowly dispatcher", created with `background: true` and without a Paseo project id, so Paseo files it under its own project for that directory, apart from every Flowly project.
- Reused while Paseo still returns it and it is not being archived; otherwise a new one is created and its id replaces `workspaceId`.
- Flowly never archives it: no archive, wrap-up, delete, switch or background-workspace path acts on it. Those paths act only on workspaces bound to a card or on the per-project `Flowly background` workspaces, and the dispatcher workspace cannot be bound to a card (New task with an existing workspace refuses it).
- Its folder never becomes a Flowly project: the Paseo project rooted there and its workspaces are left out of the resources Add project and New task list, and Add project (and restore) with that folder is refused ("This is the Flowly dispatcher's folder; it can't be a Flowly project."). The folder is compared after resolving symlinks.
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

`start({ provider?, modeId? })`:

- Refused with `DISPATCHER_RUNNING` while the state is `running` or `idle`: there is one dispatcher. Concurrent starts run one after another.
- Opens the workspace (§2), chooses a new agent id, writes the record (new `agentId`, `startedAt` now) before Paseo creates the session, so the session's first tool calls already pass §4. If Paseo did not create it (the agent is not found after the error), the record goes back to the previous `agentId`/`startedAt` and the error is returned.
- The model: a passed `provider` (`provider/model`, with the passed `modeId`) wins; otherwise the **Dispatcher model** setting (Settings → Models, stored as `dispatcherModel` in the host `models` settings: provider, model, optional reasoning and permission mode); when it is empty or unreadable, the server default `claude/claude-sonnet-5-5` (plan Q6). An unreadable setting is logged.
- The session: that model (`provider/model`, `modeId`, `thinkingOptionId` from the setting's reasoning), system prompt `dispatcherCharter` (§6), title "Flowly dispatcher", label `flowly-dispatcher=1`, MCP server `flowly-dispatcher` (§4), first message the board summary (§6).
- When a session opens (`agent.session_open`) and its id is the stored `agentId`, Flowly adds the `flowly-dispatcher` MCP server again (a resumed session keeps its tools). No other session gets it.

## 4. Credential and caller check

- The `flowly-dispatcher` server's bearer token is sealed with purpose `dispatcher` over `{ agentId, workspaceId }`. `authenticateAny` returns `kind: "dispatcher"` for it. A card (`session`) or board token is never accepted as a dispatcher token and vice versa.
- A dispatcher token gets the dispatcher tools (§5) only: none of the card-session tools, none of the board tools, and not the CLI endpoint (`/api` refuses it).
- Every call checks, in order: the token's `agentId` equals the stored `agentId` and its `workspaceId` the stored `workspaceId` (else `DISPATCHER_REPLACED`); Paseo returns that agent, not archived, in that workspace (else `SESSION_MISMATCH`).
- Every tool with a `projectId` then checks the project: unknown → `NOT_FOUND`; archived → `PROJECT_ARCHIVED`; its root (`primaryPath`) is not a readable directory → `ROOT_UNAVAILABLE`. A card id must belong to that project (`CARD_NOT_FOUND`). Refusals write nothing.
- A legacy multi-repo project (more than one stored `repos`, SINGLE-ROOT-SPEC) is read-only to the dispatcher: `flowly_create_card`, `flowly_update_card`, `flowly_start_card` and `flowly_link_cards` there are refused with `LEGACY_PROJECT` (ruling 2026-11-08); reads stay allowed.

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
- Flowly never steers or interrupts the dispatcher's turn (single-pane spec, "never steer or interrupt"). Paseo's daemon treats a send without `activeTurnBehavior` as `interrupt` and answers (clears) pending permissions, so Flowly sends only after re-reading the agent just before sending and finding it `idle` with no pending permission.
- A batch is delivered by state:
  - `idle`, no pending permission, send cooldown passed → one message with the held notes and the batch, sent without `activeTurnBehavior`.
  - `running`, or `idle` with a pending permission → held in memory, one note per card, until the dispatcher's `agent.turn_ended`, then delivered the same way. When the read at that turn end still says `running` (the hook can arrive before Paseo's snapshot changes), Flowly reads once more 2 s later; if it still holds, the notes wait for the next turn end.
  - Send cooldown: no second send within 8 s of the last one (as the composer's queue drain), so a stale `idle` read cannot double-send; a batch inside it is held and sent once it has passed, under the same checks.
  - `none`, `ended`, `context_full` → dropped, held notes too (the next dispatcher's board summary covers them).
- Held notes for a card merge as the batcher's do (EVENT-BUS-SPEC §3): a question or blocker is kept over a later plain status change (shown as `; then <move>`), anything else is replaced by the newer note, and the count of facts not shown carries over across batches.
- A failed state read drops the held notes and is logged; a send that fails is logged and its notes are dropped, not replayed. Notes that reach Flowly before it has a Paseo connection are dropped and logged ("Flowly dispatcher notes dropped: no Paseo connection yet:"). All with `logFailure` under fixed labels; counts only, no note text.
- Message: `Flowly board update (N cards):` then one line per note: `- "<title>" [<taskId>] in project <projectId>: <kind> — <detail>[; then <later>][ (+N earlier)]`.
- On plugin unload the batcher and the dispatcher's delivery are disposed (timers and pending notes cleared, no later sends) and the subscription removed; held notes lost that way are logged ("Flowly dispatcher held notes dropped on unload:"). Held notes live in memory only.

## 8. RPCs

- `dispatcher.status` `{}` → `{ state, agentId }` (§3).
- `dispatcher.start` `{ provider?, modeId? }` → `{ agentId }` (no `provider`: the Dispatcher model setting, §3); errors `DISPATCHER_RUNNING`, `HOST_UNSUPPORTED`, `START_FAILED` (Paseo did not create the session; its reason in the message), returned as the RPC error.
- `dispatcher.items-changed` `{ etag? }` → `{ etag, value?: ChatItem[] }`: the stored items plus the change line (§9.1, §9.2).
- `dispatcher.tail`: the `sessions.tail` input without `taskId` and its output, for the stored dispatcher session only (§9.3).
- `dispatcher.mark-seen` `{ revision }` → `{ seenRevision }` (§9.2).
- `dispatcher.what-next` `{}` → `{ sent: true }` (§9.2).

## 9. Chat panel

The dispatcher's chat sits next to the board (single-pane spec, "Design details"): the dispatcher's transcript with Flowly-rendered items interleaved by time.

### 9.1 Items

`<dataDir>/dispatcher-items.json` `{ version: 1, items: ChatItem[] }`, written atomically (temporary file + rename, mode 0600) and serialized; a file that does not parse or validate is renamed to `dispatcher-items.json.invalid-<epoch ms>` and read as empty. `ChatItem` (`shared/dispatcher.ts`) is `{ id, at, kind, … }`:

| kind | stored | holds |
|---|---|---|
| `note` | yes | one dispatcher note (§7), recorded when its batch was sent to the dispatcher; never when the batch was dropped, so the chat shows exactly what the dispatcher received |
| `ask` | yes | a card's ask (`signal`, `taskId`, `projectId`, `title`, `state` open / answered / session_ended / dismissed, `resolvedAt`); filled in by asks in the chat |
| `answer` | yes | the user's answer to an ask, addressed to the card (`signal`, `taskId`, `projectId`, `text`, `delivered`) |
| `change` | no, computed on read | "Changed since you looked" (§9.2) |

On every write the list is pruned: asks answered or dismissed more than 7 days ago (`resolvedAt`, else `at`) are dropped, then only the 500 newest items (by `at`) are kept.

### 9.2 Changed since you looked

- An event's revision is its time in epoch milliseconds (`Date.parse(event.at)`). The user's mark is `seenRevision` in `dispatcher.json` (§1; absent in older files). While it is absent the dispatcher's `startedAt` is the mark; with neither there is no change line.
- The change line counts the cards with an event newer than the mark, by an agent or the system (the user's own changes are not news to them), whose card is not archived and whose project is live. Its `revision` is the newest such event's, its `at` that event's time, and it lists each card (`taskId`, `projectId`, `title`, `status`, number of events), newest first.
- **Mark seen** (`dispatcher.mark-seen { revision }`) stores `max(seenRevision, revision)`, so a mark never moves back and a change after the line was read shows again. A new dispatcher keeps the mark.
- **What should I do?** (`dispatcher.what-next`) sends the dispatcher `What should I do?` followed by the changed cards (`- "<title>" [<taskId>] in project <projectId>: <status>`); it does not mark them seen. Refused with `DISPATCHER_DOWN` unless the dispatcher is running or idle; while it runs the message steers its turn, as the composer's does.

### 9.3 Panel

- Desktop: a panel beside the board, before an open card's sidebar, toggled from the toolbar. Phone: a full-screen page from the same toolbar button, hidden rather than unmounted when closed.
- The transcript is read with `dispatcher.tail` (the `sessions.tail` contract, only for the stored dispatcher session in the stored workspace; any other session is refused). Note-batch messages (`Flowly board update (`) are left out of the transcript (the note rows stand for them), and the first message (`Flowly board summary.`) shows as one line.
- Items are read with `dispatcher.items-changed` (etag), the status with `dispatcher.status`; both, the transcript and its stream run only while the panel is visible.
- States none, ended and context_full show **Start dispatcher** (`dispatcher.start` with the Dispatcher model setting); an error, such as `HOST_UNSUPPORTED`, shows as a notice under it. While running or idle the composer sends exactly the typed text with the host Paseo client (`activeTurnBehavior: "steer"` while it runs).
- A note row is one line (card title, kind, detail); pressing it opens the card. The change line is collapsed to its count; expanded it lists the cards (press opens one), with **Mark seen** and **What should I do?**.

## 10. Acceptance

- A dispatcher token can write to any live project; an archived project is refused with `PROJECT_ARCHIVED` and nothing is written; a token from a replaced dispatcher is refused.
- Card and board tokens cannot call dispatcher tools; a dispatcher token cannot call card-session or board tools.
- Start creates a background directory workspace once and reuses it; Flowly never archives it.
- Context at 95% reports `context_full`.
- Notes wait for the turn to end and never steer; a pending permission holds them like a running turn; a turn end read as still running is retried once; a second send waits for the cooldown; notes are dropped while the dispatcher is down.
- A legacy multi-repo project is read-only to the dispatcher (`LEGACY_PROJECT`).
- The dispatcher's folder is never offered or accepted as a Flowly project.
- Start without a provider uses the Dispatcher model setting, else `claude/claude-sonnet-5-5`.
- A corrupt `dispatcher.json` is preserved and treated as empty.
- Transcript entries and chat items interleave by time; note-batch messages appear only as note rows, one per note the dispatcher received.
- The change line counts the cards changed since the mark; Mark seen hides it until something new changes.
- Items are capped at 500; answered or dismissed asks older than 7 days are dropped.
- `dispatcher.tail` refuses every session except the stored dispatcher; `sessions.tail` still refuses sessions outside the card's workspace.
- A host without background workspaces shows the `HOST_UNSUPPORTED` message in the panel.
