# Dispatcher (DISPATCHER-SPEC)

One Flowly-owned agent session for all projects: it hears every card's stops, creates and starts cards in any live project, and parks asks as project ideas. Contract only; progress is in `docs/PROGRESS.md`. This document covers the agent, its workspace, its credential and tools, and note delivery. The chat panel (Task 10) and asks in the chat (Task 11) extend it.

Status: user decisions 2026-11-08 (single-pane spec D1, D2; plan Decisions Q5, Q6; one long-lived dispatcher session). AGENTS.md records the dated user-requested exception (role orchestration and automatic session starts by a plugin-owned background session whose workspace is never archived; a dead dispatcher session is archived when its replacement starts).

## 1. Stored record

`<dataDir>/dispatcher.json`:

```json
{ "version": 1, "workspaceId": "…" | null, "agentId": "…" | null, "startedAt": "ISO time" | null, "seenRevision"?: number, "seenIds"?: string[], "previousAgentIds"?: string[] }
```

`seenRevision` and `seenIds` are the user's "Changed since you looked" mark (§9.2); `previousAgentIds` the earlier dispatcher sessions of this install, oldest first, at most 20. Every write keeps the fields it does not change.

- Written atomically (temporary file + rename, mode 0600) and serialized; a missing file is the empty record (all `null`).
- A file that does not parse or validate is renamed to `dispatcher.json.invalid-<epoch ms>` (kept, never deleted) and treated as empty; the next write creates a fresh file.
- The record names the one current dispatcher. A new dispatcher starts only when the stored one is dead (§3); it replaces `agentId` and `startedAt`, and the dead session's id moves to the end of `previousAgentIds`. The dead session loses its tools (§4).

## 2. Workspace

- A directory workspace on the **dispatcher folder** `<Paseo home>/flowly-dispatcher/dispatcher` (the Paseo home is `PASEO_HOME`, else `~/.paseo`, the same home the plugin data folder is derived from), titled "Flowly dispatcher", created with `background: true` and without a Paseo project id, so Paseo files it under its own project for that directory, apart from every Flowly project. The folder and its parent are created with mode 0700, and set to 0700 at every start when they already exist.
- Why there (ruling, Noah 2026-11-09): the dispatcher's working folder (its cwd) keeps the plugin data out. Inside the plugin data folder, a provider that auto-allows reads or edits inside the cwd covered `board.json`, `flowly.sqlite`, the token-sealing key and plugin settings; now such access goes through the provider's permission prompts. A direct child of the Paseo home would put Paseo's own credentials and configuration next to it; its own parent, `flowly-dispatcher`, holds the dispatcher folder only. This is not a sandbox: in a full-access or bypass mode, or by absolute paths, the agent can still reach any file the user can (`../..` from the folder is the Paseo home). The real boundary is the sealed dispatcher credential (§4) plus the provider's permission prompts. The host offers plugins no other per-plugin working folder. The folder keeps the name `dispatcher`, so Paseo's project for it keeps its name.
- At every start, before the stored workspace is reused or a new one is created, a dispatcher folder inside the plugin data folder, holding it, or whose parent holds it makes `dispatcher.start` fail with `START_FAILED` and is logged. It is checked as given; then on where its existing part really leads (the real path of its deepest existing ancestor plus the rest, so a linked `flowly-dispatcher` creates nothing in the data folder; a link on the way that points nowhere is refused too) before any folder is made; and again on the real path once it exists (so a folder replaced by a link is refused, reuse included).
- The stored workspace is reused while Paseo still returns it, it is not being archived and its directory is the dispatcher folder (after resolving symlinks); otherwise a new one is created on the dispatcher folder and its id replaces `workspaceId`.
- An earlier dispatcher worked in `<dataDir>/dispatcher/`. A stored workspace there is not reused: the next start creates the workspace on the dispatcher folder. That start follows §3 as any other (refused while the stored session is alive; a dead one is archived as usual). Flowly never moves or deletes the old folder, and never archives its workspace. A dispatcher started there also leaves its Paseo project registered; `ownsRoot` keeps it hidden, and Flowly never removes it.
- Flowly never archives the workspace: no archive, wrap-up, delete, switch or background-workspace path acts on it. Those paths act only on workspaces bound to a card or on the per-project `Flowly background` workspaces, and the dispatcher workspace cannot be bound to a card (New task with an existing workspace refuses the stored dispatcher workspace and any workspace whose directory is the dispatcher folder or the old `<dataDir>/dispatcher/`).
- Its folder, and the old `<dataDir>/dispatcher/`, never become a Flowly project: the Paseo project rooted there and its workspaces are left out of the resources Add project and New task list, and Add project (and restore) with that folder is refused ("This is the Flowly dispatcher's folder; it can't be a Flowly project."). The folder is compared after resolving symlinks.
- A host without background workspaces (`workspaces.create` throws "Update the host to use background workspaces.") makes `dispatcher.start` fail with `HOST_UNSUPPORTED` ("Update Paseo to use the dispatcher: this host has no background workspaces."). Nothing is retried and the record is not changed.

## 3. Lifecycle

The dispatcher is one long-lived session: the provider compacts its context as it fills, and the board is its memory (§6). There is no "context full" state and no start-fresh flow; a new dispatcher starts only to recover from a dead one.

A stored session is **dead** when Paseo does not return it, it is archived, or its status is `closed` (one predicate, `isDeadDispatcher`). Every other status is the live dispatcher, `error` included (ruling, Noah 2026-11-09): a dispatcher in `error` is never replaced automatically; the user can archive it to start a new one.

`status` → `{ state, agentId }`:

| state | when |
|---|---|
| `none` | the record has no `agentId` |
| `ended` | the stored session is dead |
| `running` | status `running` or `initializing` |
| `idle` | otherwise (including `error`) |

`start({ provider?, modeId? })`:

- Refused with `DISPATCHER_RUNNING` unless the stored session is dead (or there is none): there is one dispatcher. Concurrent starts run one after another.
- Opens the workspace (§2) and chooses a new agent id. When a dead session is stored, Flowly reads it again just before replacing it: if it is no longer dead the start is refused with `DISPATCHER_RUNNING` and nothing changes; if it is closed and not archived yet, Flowly archives that session (that stored id only; never a live session, never the workspace). A failed archive is logged and the start goes on.
- Writes the record (new `agentId`, `startedAt` now, the old id added to `previousAgentIds`) before Paseo creates the session, so the session's first tool calls already pass §4. If Paseo did not create it (the agent is not found after the error), the record goes back to the previous `agentId`/`startedAt`/`previousAgentIds` and the error is returned.
- The model: a passed `provider` (`provider/model`, with the passed `modeId`) wins; otherwise the **Dispatcher model** setting (Settings → Models, stored as `dispatcherModel` in the host `models` settings: provider, model, optional reasoning and permission mode); when it is empty or unreadable, the server default `claude/claude-sonnet-5-5` (plan Q6). An unreadable setting is logged.
- The session: that model (`provider/model`, `modeId`, `thinkingOptionId` from the setting's reasoning), system prompt `dispatcherCharter` (§6), title "Flowly dispatcher", label `flowly-dispatcher=1`, MCP server `flowly-dispatcher` (§4), first message the board summary (§6).
- When a session opens (`agent.session_open`) and its id is the stored `agentId`, Flowly adds the `flowly-dispatcher` MCP server again (a resumed session keeps its tools). No other session gets it.

## 4. Credential and caller check

- The `flowly-dispatcher` server's bearer token is sealed with purpose `dispatcher` over `{ agentId, workspaceId }`. `authenticateAny` returns `kind: "dispatcher"` for it. A card (`session`) or board token is never accepted as a dispatcher token and vice versa.
- A dispatcher token gets the dispatcher tools (§5) only: none of the card-session tools, none of the board tools, and not the CLI endpoint (`/api` refuses it).
- Every call checks, in order: the token's `agentId` equals the stored `agentId` and its `workspaceId` the stored `workspaceId` (else `DISPATCHER_REPLACED`); Paseo returns that agent, not archived, in that workspace (else `SESSION_MISMATCH`).
- Every write (`flowly_create_card`, `flowly_update_card`, `flowly_start_card`, `flowly_link_cards`, `flowly_propose_idea`) is refused with `AGENT_CARDS_DISABLED` while the **Agents create and edit cards** setting is off; reads stay allowed.
- Every tool with a `projectId` then checks the project: unknown → `NOT_FOUND`; archived → `PROJECT_ARCHIVED`. A write also needs its root (`primaryPath`) to be a readable directory, else `ROOT_UNAVAILABLE`; reads (`flowly_list_cards`, `flowly_get_card`) of a project whose root is missing are allowed. A card id must belong to that project (`CARD_NOT_FOUND`). Refusals write nothing.
- A legacy multi-repo project (more than one stored `repos`, SINGLE-ROOT-SPEC) follows the same rules as the card agents' tools there: its cards can be created, edited, linked and started, and ideas proposed (SINGLE-ROOT-SPEC §21 lets users edit legacy cards; the read-only rule covers its scope data).

## 5. Tools

All take `projectId` explicitly, except `flowly_list_projects`. Writes are recorded with `actor: "agent"` and the dispatcher's `agentId`.

Hourly limit (a runaway brake): the dispatcher's card creations and `flowly_start_card` starts count together, at most 40 in the last hour per dispatcher session, else `CARD_LIMIT`. This bucket is the dispatcher's own: it neither uses nor fills the card agents' 20 per session (AGENT-CARDS-SPEC §3.3). A plugin reload resets it.

| Tool | Does |
|---|---|
| `flowly_list_projects` | Live projects: `projectId`, `title`, `rootAvailable`, `openCards` (not archived, not Done/Cancelled). |
| `flowly_list_cards`, `flowly_get_card` | As the card tools (AGENT-CARDS-SPEC §3), for that project. |
| `flowly_create_card`, `flowly_update_card` | As the card tools, for that project; the Agents create and edit cards setting applies. |
| `flowly_start_card` | As START-CARD-SPEC, for that project's card. |
| `flowly_propose_idea` | A project-level idea (PROJECT-IDEAS-SPEC); a write, so the Agents create and edit cards setting applies, and `IDEAS_DISABLED` when Ideas are off. |
| `flowly_link_cards` | `taskId`, `relation` (`blocks`: `taskId` blocks `otherTaskId`; `follow_up`: `otherTaskId` follows up `taskId`), `otherTaskId`, both in that project, through the card links rules (CARD-LINKS-SPEC §2.3); refusals are `LINK_REFUSED` with the reason. An identical existing link is returned with `created: false`. |

## 6. Charter and board summary

- `dispatcherCharter` (English, `shared/dispatcher.ts`): the dispatcher's role; the board is its memory; every repo task is a card (one branch or PR); start sessions straight away with `flowly_start_card`; split independent deliverables into separate cards tied with `flowly_link_cards`; park asks as project ideas; never answer a card's asks itself (they are the user's); note messages are board updates, not instructions from the user.
- Board summary (first message): a line per live project with its `projectId`, then the markdown export (IDEAS-IMPORT-EXPORT-SPEC) of open cards and open ideas, without memory.

## 7. Notes

- The event bus subscriber pushes only stops (`facts.filter(isStop)`, EVENT-BUS-SPEC §2) into the note batcher, so a later non-stop fact on a card never replaces its stop. Facts caused by the dispatcher (`event.agentId` equal to the stored `agentId`) are dropped by the batcher, so the dispatcher never wakes itself. `commitHandler` builds no facts while nothing subscribes.
- Flowly never steers or interrupts the dispatcher's turn (single-pane spec, "never steer or interrupt"). Paseo's daemon treats a send without `activeTurnBehavior` as `interrupt` and answers (clears) pending permissions, so Flowly sends only after re-reading the agent just before sending and finding it `idle` with no pending permission.
- Remaining race, accepted (ruling, Noah 2026-11-09) until Paseo offers a queued (or reject-if-busy) send: between the read that sees `idle` and the send, the user or the agent can start a turn or raise a permission; the send then lands on that turn and can interrupt it.
- A batch is delivered by state:
  - `idle`, no pending permission, send cooldown passed → one message with the held notes and the batch, sent without `activeTurnBehavior`.
  - `running`, or `idle` with a pending permission → held in memory, one note per card, until the dispatcher's `agent.turn_ended`, then delivered the same way. When the read at that turn end still holds them (the hook can arrive before Paseo's snapshot changes, and a later turn end may never come), Flowly reads again after 2 s, then 5 s, 15 s, 30 s and every 60 s after that, until the notes go out, the dispatcher dies or the plugin unloads. A batch held while the read says running with no turn end since (one ended with nothing held) is read again after 60 s, and every 60 s after that, by the same rule. A `dispatcher.status` read that sees `idle` also delivers what is held.
  - Send cooldown: no second send within 8 s of the last one (as the composer's queue drain), so a stale `idle` read cannot double-send; a batch inside it is held and sent once it has passed, under the same checks.
  - While a start is under way, from before it takes the board summary until Paseo has created the session (or the start fails) → held; then the held notes are delivered by the dispatcher's state (the new session's, or the one a refused start kept). Notes held when the start began are on the board the summary reads and are not sent again; notes that arrive while it is written are kept, so one may repeat the summary.
  - `none`, `ended` → dropped, held notes too (the next dispatcher's board summary covers them). A live dispatcher never loses notes to its state.
- Held notes for a card merge as the batcher's do (EVENT-BUS-SPEC §3): a question or blocker is kept over a later plain status change (shown as `; then <move>`), anything else is replaced by the newer note, and the count of facts not shown carries over across batches.
- A failed state read drops the held notes and is logged; a send that fails is logged and its notes are dropped, not replayed. Notes that reach Flowly before it has a Paseo connection are dropped and logged ("Flowly dispatcher notes dropped: no Paseo connection yet:"). All with `logFailure` under fixed labels; counts only, no note text.
- Message: `Flowly board update (N cards):` then one line per note: `- "<title>" [<taskId>] in project <projectId>: <kind> — <detail>[; then <later>][ (+N earlier)]`.
- On plugin unload the batcher and the dispatcher's delivery are disposed (timers and pending notes cleared, no later sends) and the subscription removed; held notes lost that way are logged ("Flowly dispatcher held notes dropped on unload:"). Held notes live in memory only.

## 8. RPCs

- `dispatcher.status` `{}` → `{ state, agentId }` (§3).
- `dispatcher.start` `{ provider?, modeId? }` → `{ agentId }` (no `provider`: the Dispatcher model setting, §3); errors `DISPATCHER_RUNNING`, `HOST_UNSUPPORTED`, `START_FAILED` (Paseo did not create the session; its reason in the message), returned as the RPC error.
- `dispatcher.items-changed` `{ etag? }` → `{ etag, value?: ChatItem[] }`: the stored items plus the change line (§9.1, §9.2).
- `dispatcher.tail`: the `sessions.tail` input without `taskId` and its output, for the stored dispatcher session only (§9.3).
- `dispatcher.mark-seen` `{ revision, ids? }` → `{ seenRevision }` (§9.2).
- `dispatcher.what-next` `{}` → `{ sent: true }` (§9.2).
- `asks.answer` `{ signal, answer: { optionIds?, text?, allow? } }` → `{ delivered, state }` (§9.4).
- `asks.dismiss` `{ signal }` → `{ taskId }` (§9.4).
- `tasks.start-again` `{ taskId, idempotencyKey }` → the `flowly_start_card` result (§9.4). A refusal's message is `CODE: message`.
- `asks.resolved` `{ etag? }` → `{ etag, value?: string[] }`: the signals the chat resolved, sorted (§9.4).

## 9. Chat panel

The dispatcher's chat sits next to the board (single-pane spec, "Design details"): the dispatcher's transcript with Flowly-rendered items interleaved by time.

### 9.1 Items

`<dataDir>/dispatcher-items.json` `{ version: 1, items: ChatItem[] }`, written atomically (temporary file + rename, mode 0600) and serialized; a file that does not parse or validate is renamed to `dispatcher-items.json.invalid-<epoch ms>` and read as empty. `ChatItem` (`shared/dispatcher.ts`) is `{ id, at, kind, … }`:

| kind | stored | holds |
|---|---|---|
| `note` | yes | one dispatcher note (§7), recorded when its batch was sent to the dispatcher; never when the batch was dropped, so the chat shows exactly what the dispatcher received |
| `ask` | answered and ended ones; open and dismissed ones are computed on read (§9.4) | a card's ask (`signal`, `taskId`, `projectId`, `title`, `state` open / answered / session_ended / dismissed, `resolvedAt`, and `askKind`, `agentId`, `detail`, `options`, `questions`, `elsewhere` (answered in the session)) |
| `answer` | yes | the user's answer to an ask, addressed to the card (`signal`, `taskId`, `projectId`, `text`, `choice` allow/deny for permissions, `delivered`) |
| `change` | no, computed on read | "Changed since you looked" (§9.2) |

On every write the list is pruned: asks answered or dismissed more than 7 days ago (`resolvedAt`, else `at`) are dropped, then only the 500 newest items (by `at`) are kept.

### 9.2 Changed since you looked

- An event's revision is its time in epoch milliseconds (`Date.parse(event.at)`). The user's mark is `seenRevision` with `seenIds` (the ids of the events at exactly that millisecond already seen) in `dispatcher.json` (§1; absent in older files). While it is absent the dispatcher's `startedAt` is the mark, with no ids; with neither there is no change line.
- The change line counts the cards with an event after the mark (a later millisecond, or the mark's own millisecond with an id not in `seenIds`), by an agent or the system, whose card is not archived and whose project is live. The user's own changes are not news to them, and the dispatcher's own actions (events whose `agentId` is the stored dispatcher session or one of its `previousAgentIds`, §1) are not news either: a dispatcher made them. Its `revision` is the newest such event's millisecond, `ids` the ids of the counted events at that millisecond, its `at` that time, and it lists each card (`taskId`, `projectId`, `title`, `status`, number of events), newest first.
- **Mark seen** (`dispatcher.mark-seen { revision, ids }`, the line's own values) first clamps `revision` to the daemon's clock (a clamped mark keeps no ids). A later millisecond replaces the mark, the same millisecond adds the ids, an earlier one changes nothing: a mark never moves back, and a change after the line was read, even in the same millisecond, shows again. A new dispatcher keeps the mark.
- The daemon scans the board for the line only when the board's revision or last event, the mark or the dispatcher session changed; an unchanged board costs no scan per poll.
- **What should I do?** (`dispatcher.what-next`) sends the dispatcher `What should I do?` followed by the changed cards (`- "<title>" [<taskId>] in project <projectId>: <status>`); it does not mark them seen. Refused with `DISPATCHER_DOWN` unless the dispatcher is running or idle; it is sent with `activeTurnBehavior: "steer"`, as the composer's messages are.

### 9.3 Panel

- Desktop: a panel beside the board, before an open card's sidebar, toggled from the toolbar. Phone: a full-screen page from the same toolbar button, hidden rather than unmounted when closed.
- The transcript is read with `dispatcher.tail` (the `sessions.tail` contract, only for the stored dispatcher session in the stored workspace; any other session is refused). Note-batch messages (`Flowly board update (`) are left out of the transcript (the note rows stand for them), and the first message (`Flowly board summary.`) shows as one line.
- Items are read with `dispatcher.items-changed` (etag), the status with `dispatcher.status`; both, the transcript and its stream run only while the panel is visible.
- States none and ended show **Start dispatcher** (`dispatcher.start` with the Dispatcher model setting); an error, such as `HOST_UNSUPPORTED`, shows as a notice under it. While running or idle the composer sends exactly the typed text with the host Paseo client, always with `activeTurnBehavior: "steer"`: Paseo starts a normal turn for a steer on an idle agent, while a send without it interrupts a turn and clears pending permissions, which a status read as idle a moment earlier cannot rule out. The Send button sends; Enter adds a line.
- A note row is one line (card title, kind, detail); pressing it opens the card. The change line is always the last row, whatever its newest event time; it is collapsed to its count; expanded it lists the cards (press opens one), with **Mark seen** and **What should I do?**.
- Known gap: images in the dispatcher's transcript show the image fallback (the session image read is per card, and the dispatcher has none).

### 9.4 Asks

One source (plan Q1): `asksFrom(board, agents, receipts, dismissals)` in `shared/attention.ts` turns every Attention signal (ATTENTION-DISMISS-SPEC §2.2) into one ask. The bell counts the open ones; the chat shows them. An ask is `{ signal, taskId, projectId, agentId, kind, title, detail, at, options, questions?, requestId?, state }`:

| kind | from signal | answered in the chat by |
|---|---|---|
| `question_report` | `q:<eventId>`, the session's open Flowly question | typed text, sent to that session |
| `blocker_report` | `b:<eventId>`, the session's open Flowly blocker (plan Q5: open until that session's next turn starts) | typed text, sent to that session |
| `ask_user` | `p:<agentId>:<requestId>` of a pending `question` request (AskUserQuestion) | its options and "Other" text, through Paseo's permission response |
| `permission` | `p:<agentId>:<requestId>` of any other pending request | its provider actions, or Allow / Deny when it has none |
| `error` | `e:…` | not answerable; Open card |
| `unread` | `u:…` | not answerable; Open card |

- `title` is the card's title; `detail` the question or blocker text, the request's title, or empty. `at` is the report's time, else the session's attention time. `options` are `{ id, label }`: for `ask_user` one per question option (`q<i>o<j>`, labelled `header: label` when the form has several questions) with `questions` describing each question (header, text, multi-select, whether it takes text); for `permission` one per provider action (`a<i>`), or `allow` / `deny`.
- A live ask's state is `open`, or `dismissed` when its signal is in the card's dismissal set. An ask the chat stored as answered, session ended or dismissed is *resolved*: it is not open even while the session still shows its request or report (Paseo drops a request on its next update; a report stays until the next turn). The open asks are the live open ones less the resolved ones (`openAsks`). The bell, the sidebar badge (`attention.count`, from the same `asksFrom` and the chat's stored items) and the chat's open rows are all that number. The board reads the resolved signals with `asks.resolved` (an etag read every 5 seconds while the board is shown), so the bell matches the badge with the chat closed and after a reload. After `asks.answer` or `asks.dismiss` resolves, the client also leaves that signal out of the bell until the board's live list drops it, covering the moments before that read catches up. `error` and `unread` signals are never resolved: their keys are reused (`e:<agentId>:status`, a new unread turn) and must count again when they come back.
- The agent list behind the asks and the badge is shared for 2 seconds per Paseo handle (one listing at a time; a failed one is not kept; an answer or a dismissal starts a fresh one), so the badge and the open chat's polls cost one listing. The plugin host gives every RPC the same handle until its daemon connection is re-created; a new handle never reads the old one's list.
- `dispatcher.items-changed` adds the live asks as `ask` items (id `ask-<signal>`). A stored `ask` item with the same signal (answered, session ended or dismissed) wins over the live one. Stored `ask` and `answer` items of a card that no longer exists are left out: a deleted card's asks disappear.
- **Answering** (`asks.answer`, one at a time on the daemon). The input is validated (signal up to 600 characters; up to 100 option ids; text up to 20,000 characters; up to 50 per-question texts). An `e:` or `u:` signal is refused first ("This ask has no answer; open the card."), before any stored or remembered state is read, as is a remembered ask of kind `error` or `unread`. Then, in order:
  1. A stored ask with that signal already answered or ended: `{ delivered: false, state }` with its stored state, no call. A stale or replayed answer never reaches the session again.
  2. The signal is not among the live asks. Unknown to this daemon run: `{ delivered: false, state: "answered" }`, no call. When the card no longer exists the RPC fails ("The card was deleted."). Otherwise its session is read again: archived, closed or gone, the ask is recorded as `session_ended` (it ended with its session, it was not answered); else the session resolved it, recorded as answered in the session.
  3. The session is read again from Paseo. Gone, archived or closed: `{ delivered: false, state: "session_ended" }`, recorded; Flowly never restores it. In another workspace than the card's: refused, nothing is sent.
  4. By kind: `ask_user` and `permission` need the request still pending in that session (else step 2's answer). `ask_user` builds the reply with the session pane's rules (`answerReply`); every question must be answered. Typed answers come one per question (`texts[i]`, a box under each question that takes text); a single `text` is accepted only when exactly one question takes text. Typed text is never dropped: text for a question that takes none, or text plus an option on a single-choice question, is refused. `allow: false` declines with `dismissReply`; the recorded `choice` is what that reply did (a form of free-text questions that accept empty answers submits empty, an allow, never shown as denied). `permission` takes exactly one option id, or `allow` when the request has no provider actions; an option's behavior comes from the request, never from the client, and nothing is allowed without the user's explicit choice. `question_report` and `blocker_report` need the report still open and send exactly the user's text (`activeTurnBehavior: "steer"`), no task header (product invariant). `error` and `unread` are refused.
  5. Only after the Paseo call resolves: the ask is stored as answered and an `answer` item (`text`, `choice` allow/deny for permissions and declines, `delivered: true`) is added, and `{ delivered: true, state: "answered" }` is returned. A failed call records nothing and fails the RPC.
  - Known limit: a delivered answer is remembered in memory for the daemon run and in the chat file. A report answer can be sent a second time after a daemon restart when recording it failed, or when its stored item was pruned (§9.1) while the report was still open; permissions and AskUserQuestion requests cannot, since Paseo no longer lists the answered request.
- **Dismissing** (`asks.dismiss`) adds that one signal to the card's dismissal set (ATTENTION-DISMISS-SPEC §5); the bell's count drops by one, and the card leaves the bell when all its signals are dismissed. Dismissing the card in the bell dismisses all its asks in the chat. An ask whose session ended can be dismissed too: it is stored as dismissed in the chat (and its signal added to the dismissal set when it is still live). Any other ask that is no longer live is refused ("This ask is no longer open.").
- **Start again** (`tasks.start-again { taskId, idempotencyKey }`): the `flowly_start_card` path (START-CARD-SPEC §3) started by the user: not gated by the agent-cards setting or its hourly limit; a `closed` session does not count as the card's session (a new one starts next to it; nothing is archived), while a running or idle one still refuses with `CARD_HAS_SESSION`; the session is labelled `flowly-started-by: user`; a workspace move is recorded as the user's. Refusals reach the chat as `CODE: message`; the chat shows `NEEDS_WORKTREE` ("This card's folder already had sessions, or Flowly didn't create it for the card. Switch the card to a worktree from its menu, then start again.", covering both causes) and `CARD_HAS_SESSION` ("The card already has a running session. Send it a message instead.") in the user's words and language, and any other refusal by its message.
- Panel: an open ask shows its card, kind and detail, its buttons (options, Allow / Deny, a text box with Send for reports, one text box per question that takes text), Dismiss, and Open card. While an answer is in flight it shows without a tick; the tick appears when the stored `answer` item has `delivered: true`. Answered asks show "Answered" (or "Answered in the session"), ended ones "Session ended" with **Start again** and Dismiss, dismissed ones one muted line.
- Bell: with the chat open, pressing a card's row scrolls the chat to that card's first open ask; when the chat is closed or has no such ask, it opens the card as before.

## 10. Acceptance

- A dispatcher token can write to any live project; an archived project is refused with `PROJECT_ARCHIVED` and nothing is written; a token from a replaced dispatcher is refused.
- Card and board tokens cannot call dispatcher tools; a dispatcher token cannot call card-session or board tools.
- Start creates a background directory workspace once on the dispatcher folder (outside the plugin data folder, its parent holding nothing else) and reuses it; Flowly never archives it. A stored workspace in the old `<dataDir>/dispatcher/` is not reused, and that folder is left as it is.
- Start is refused while the stored session is alive (running, idle, error, any context use); a dead one (archived, closed, missing) is replaced, and a closed one is archived first, only after a re-read still finds it dead.
- Notes wait for the turn to end and never steer; a pending permission holds them like a running turn; a turn end read as still running is re-checked with a growing delay until the notes go out; a second send waits for the cooldown; notes in the start window, from the board summary on, are held until the session exists; a batch held while running with no turn end is re-checked every 60 s; notes are dropped only while the dispatcher is dead or missing.
- A legacy multi-repo project takes the dispatcher's writes under the card agents' rules (no legacy refusal).
- With Agents create and edit cards off, every dispatcher write (links and ideas included) is refused with `AGENT_CARDS_DISABLED`; reads work.
- A project whose root is missing can be listed and read by the dispatcher; its writes are refused with `ROOT_UNAVAILABLE`.
- The dispatcher's 41st creation or start in an hour is refused with `CARD_LIMIT`; its count and a card agent's are independent.
- The dispatcher's folder, and the old one, are never offered or accepted as a Flowly project or bound to a card.
- Start without a provider uses the Dispatcher model setting, else `claude/claude-sonnet-5-5`.
- A corrupt `dispatcher.json` is preserved and treated as empty.
- Transcript entries and chat items interleave by time; note-batch messages appear only as note rows, one per note the dispatcher received.
- The change line counts the cards changed since the mark, without the user's or the dispatcher's own actions; Mark seen hides it until something new changes, including a later event in the same millisecond; a mark ahead of the daemon's clock is clamped; it is always the last row.
- The composer and What should I do? always steer.
- Items are capped at 500; answered or dismissed asks older than 7 days are dropped.
- `dispatcher.tail` refuses every session except the stored dispatcher; `sessions.tail` still refuses sessions outside the card's workspace.
- A host without background workspaces shows the `HOST_UNSUPPORTED` message in the panel.
- The bell's count equals the open asks from `asksFrom`; dismissing one ask in the chat lowers it by one.
- Answering an AskUserQuestion responds through Paseo's permission API; a question report's answer is exactly the user's text.
- An ask already resolved in the session, or answered before, is not answered again; a request of another session is never answered; a permission is never allowed without the user's choice.
- An ended session gives `session_ended` and no tick; a deleted card's asks disappear.
