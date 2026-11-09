# Event bus and dispatcher notes (EVENT-BUS-SPEC)

The daemon-side source of "something happened on a card" for the dispatcher (DISPATCHER-SPEC, Tasks 9–11). Contract only; progress is in `docs/PROGRESS.md`. Nothing here is user-visible by itself: it changes no board data and sends nothing until the dispatcher subscribes.

Status: user decision 2026-11-08 (single-pane spec: the dispatcher hears every card's stops).

## 1. Facts

`BusFact` is one of:

| Kind | Source | Fields |
|---|---|---|
| `board` | a committed board write: one fact per `BoardEvent` it created | `event`, `projectId`, `title` (the card's title at commit) |
| `permission` | the `agent.permission_requested` hook, for every session | `agentId`, `taskId` (the managed card, else `null`), `request` |
| `permission_resolved` | the `agent.permission_resolved` hook | `agentId`, `requestId` |

A commit publishes its events once, after the write is saved and before storage's post-commit work. An event whose card is gone by the end of the commit (deleted in the same write) is skipped. A commit that created no event, and the storage restore and export paths (which pass no events), publish nothing. While the bus has no subscriber (`hasSubscribers()` false), a commit builds no facts at all. Facts carry no card text beyond the event's own fields; tool input of a permission request is not logged anywhere by the bus.

`BoardStore.onCommit` receives `(events, board)`; the board is `null` on the restore and export paths. The project-folder snapshot schedule still runs on every call.

`EventBus.publish` calls each subscriber synchronously in subscription order. A subscriber that throws is logged (`logFailure`) and the others still run; a publish never fails a board write.

## 2. Stops

`isStop(fact)` is true for:

- `board`: `status_changed` into `blocked`, `in_review`, `committed`, `integrated`, `done` or `cancelled`; any `status_changed` or `progress_reported` event whose `reportKind` is `question`, `blocker` or `result`; `agent.turn_ended` with outcome `failed`.
- `permission`.

False for: turn starts, status changes into `design`, `development`, `test` (including the automatic ones), `progress` reports, permission resolutions, every other action (edits, tags, ideas, `agent.permission_requested`). A turn that ends `canceled` is not a stop.

## 3. Note batching

`NoteBatcher` turns board facts into `DispatcherNote`s (`taskId`, `projectId`, `title`, `kind`, `detail`, `at`) and flushes them in batches:

- A fact whose `event.agentId` equals `exclude()` (the dispatcher's own session, read at push time) is dropped. `permission` and `permission_resolved` facts are not notes: asks reach the chat through DISPATCHER-SPEC, not through the dispatcher's input.
- The batcher does not filter by `isStop`; the subscriber decides which facts to push (the dispatcher's pushes only stops, DISPATCHER-SPEC §7).
- Per card, the last fact wins; the earlier facts' count is appended to its `detail` as ` (+N earlier)`.
- The batch flushes when no fact has arrived for `windowMs` (10 s) after the latest, or `maxWaitMs` (60 s) after the first fact of the batch, whichever comes first; the 60 s are counted from the batch's first fact even when its time reads as 0. A flush with no notes does nothing. A flush callback that throws is logged (`logFailure`) and the batch is dropped.
- `dispose()` clears the timer and the pending notes (plugin unload); a later push starts a new batch.

`kind`: the report kind (`question`, `blocker`, `result`) when the event has one other than `progress`; `status_changed` for a status move; `turn_failed` for a failed turn; else the event's `action`. `detail`: the status move (`<from> → <to>`) and the event's note, when any.

## 4. Acceptance

- One commit publishes each of its events once; a deleted card's events are skipped.
- Stop and non-stop classification as in §2.
- The dispatcher's own facts produce no note.
- Facts within the window become one batch; a steady stream flushes by `maxWaitMs`.
- `onCommit` still schedules the folder snapshot.
