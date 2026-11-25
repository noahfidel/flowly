# Event bus and dispatcher notes (EVENT-BUS-SPEC)

The daemon-side source of "something happened on a card" for the dispatcher (DISPATCHER-SPEC, Tasks 9–11). Contract only; progress is in `docs/PROGRESS.md`. Nothing here is user-visible by itself: it changes no board data and sends nothing until the dispatcher subscribes.

Status: user decision 2026-11-08 (single-pane spec: the dispatcher hears every card's stops).

## 1. Facts

`BusFact` is one of:

| Kind | Source | Fields |
|---|---|---|
| `board` | a committed board write: one fact per `BoardEvent` it created | `event`, `projectId`, `title` (the card's title at commit); for `umbrella_contract_proposed`, `proposal` `{ umbrellaId, conflict, mentions }` from the card's newest contract change as the commit left it (`conflict`: Flowly's flag, `markConflicts`; `mentions`: the member cards whose role, case-insensitive and as a whole word, appears in the reason or in a line only one of the before and after texts has, `rolesMentioned`) |
| `permission` | the `agent.permission_requested` hook, for every session | `agentId`, `taskId` (the managed card, else `null`), `request` |
| `permission_resolved` | the `agent.permission_resolved` hook | `agentId`, `requestId` |

A commit publishes its events once, after the write is saved and before storage's post-commit work. An event whose card is gone by the end of the commit (deleted in the same write) is skipped. A commit that created no event, and the storage restore and export paths (which pass no events), publish nothing. While the bus has no subscriber (`hasSubscribers()` false), a commit builds no facts at all. Facts carry no card text beyond the event's own fields; tool input of a permission request is not logged anywhere by the bus.

`BoardStore.onCommit` receives `(events, board)`; the board is `null` on the restore and export paths. The project-folder snapshot schedule still runs on every call.

`EventBus.publish` calls each subscriber synchronously in subscription order. A subscriber that throws is logged (`logFailure`) and the others still run; a publish never fails a board write.

## 2. Stops

`isStop(fact)` is true for:

- `board`: `status_changed` into `blocked`, `in_review`, `committed`, `integrated`, `done` or `cancelled`; any `status_changed` or `progress_reported` event whose `reportKind` is `question`, `blocker` or `result`; `agent.turn_ended` with outcome `failed`; an agent's `progress` report whose note starts with the contract marker (`[contract]`, DISPATCHER-SPEC §5.8); an agent's `umbrella_contract_proposed` (a member's `flowly_propose_contract_change`, UMBRELLA-SPEC §5), whose note kind is `contract_proposed`; umbrella news, matched by action (`umbrella_contract_accepted`, `umbrella_ruling_added`; UMBRELLA-SPEC §8, D12), whatever the actor: checked before the human-actor rule, so the user's accept in the panel is a stop, with note kind `umbrella_news` and `umbrellaNews: { eventId, text }` (`text` the event's note). It is relay only (DISPATCHER-SPEC §5.8): the charter never puts it to the user as a question.
- `permission`.

False for: events by the user (`actor` human: their own moves are not news to them; umbrella news excepted), A1r restores (`rule` A1r, "No work was reported in that turn; restored"), turn starts, status changes into `design`, `development`, `test` (including the automatic ones), `progress` reports without the contract marker, permission resolutions, every other action (edits, tags, ideas, `agent.permission_requested`). A turn that ends `canceled` is not a stop.

## 3. Note batching

`NoteBatcher` turns board facts into `DispatcherNote`s (`taskId`, `projectId`, `title`, `kind`, `detail`, `at`) and flushes them in batches:

- A fact whose `event.agentId` equals `exclude()` (the dispatcher's own session, read at push time) is dropped, except umbrella news: the dispatcher's own accept is still relayed to the siblings (UMBRELLA-SPEC §5 step 4). `permission` and `permission_resolved` facts are not notes: asks reach the chat through DISPATCHER-SPEC, not through the dispatcher's input.
- The batcher does not filter by `isStop`; the subscriber decides which facts to push (the dispatcher's pushes only stops, DISPATCHER-SPEC §7).
- Per card, notes merge with `mergeNotes`: the newer note wins, except that a `question`, `blocker` or `contract_proposed` is kept over a later plain `status_changed`, whose detail it keeps as `later`. `earlier` counts the merged facts not shown (carried across batches by the dispatcher's held notes); the message renders it as ` (+N earlier)`.
- The batch flushes when no fact has arrived for `windowMs` (10 s) after the latest, or `maxWaitMs` (60 s) after the first fact of the batch, whichever comes first; the 60 s are counted from the batch's first fact even when its time reads as 0. A flush with no notes does nothing. A flush callback that throws is logged (`logFailure`) and the batch is dropped.
- `dispose()` clears the timer and the pending notes (plugin unload); a later push starts a new batch.

`kind`: the report kind (`question`, `blocker`, `result`) when the event has one other than `progress`; `status_changed` for a status move; `turn_failed` for a failed turn; `contract_proposed` for a contract proposal; `umbrella_news` for umbrella news; else the event's `action`. `detail`: the status move (`<from> → <to>`) and the event's note, when any. `later` and `earlier` are set only by merging. A contract proposal's note carries `proposal: { eventId, umbrellaId, conflict, mentions }`, kept across merges like `contract` and `umbrellaNews` (the newer one wins); the dispatcher's message renders it on its own line under the note's line (`  Contract change waiting for the user's answer (umbrella <id>): conflicts with another pending proposal or an older contract; roles mentioned: [<taskId>], …`, each flag only when it holds), so a later question or status change on the same card never hides it.

### 3.1 Restores

A1r restores are not stops (§2), so the dispatcher never hears them. The earlier per-card repeat filter (`RestoreRepeats`) was removed.

## 4. Acceptance

- One commit publishes each of its events once; a deleted card's events are skipped.
- Stop and non-stop classification as in §2.
- The dispatcher's own facts produce no note.
- The user's own events and A1r restores are not stops; an agent or system move into a stop status, with another rule or none, still is (§2, §3.1).
- Facts within the window become one batch; a steady stream flushes by `maxWaitMs`.
- `onCommit` still schedules the folder snapshot.
