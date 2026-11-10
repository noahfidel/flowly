# Attention Snooze

Internal names keep "dismiss" (`attentionDismissals`, `attention.dismiss`, `attention.restore`, `asks.dismiss`, the ask state `dismissed`, this file's name). The user-facing name is **Snooze**.

## 1. Purpose

Snooze hides things from the Attention counts until something new happens. Some asks the user cannot or does not want to decide yet; while they stay open, their number keeps showing and buries what is new. A snoozed signal leaves the counts and queues, the card keeps showing its signals, and a new signal brings the list back.

What Snooze is not:

- It is not Mark as read: no read receipt, native Paseo attention untouched, the session's unread marker stays.
- It does not answer a question, approve or deny a permission, or resolve an error. A waiting agent keeps waiting.
- It changes no card status, task revision or Activity. Agents are unaffected (agent tools and the skill do not change).
- There is no timed snooze. The only trigger back is something new; there is no background timer.

## 2. Model

### 2.1 Two lists

Attention signals fall into two lists:

- **Needs you** ("N need you"): question, blocker, permission, error and automatic-review signals (`q:`, `b:`, `p:`, `e:` and `review:`).
- **Updates** ("N updated"): unread turns (`u:`).

`signalList(key)` returns `updated` for a `u:` key and `needs` for every other key. Snooze acts only on the list where it was pressed: snoozing in Needs you leaves the card's unread turn in Updates, and snoozing in Updates leaves its need-you signals.

### 2.2 Signal keys

`sessionSignalParts` (`shared/attention-dismiss.ts`) gives each signal a stable key for this one thing, not for the session.

| Signal | Key | List | Becomes new when |
| --- | --- | --- | --- |
| Question report (`kind=question`) | `q:<eventId>` | needs | the agent asks again (new event) |
| Blocker report (`kind=blocker`) | `b:<eventId>` | needs | a new blocker; it stays open until the session's next turn |
| Permission request / AskUserQuestion | `p:<agentId>:<requestId>`, one per pending request; without an id `p:<agentId>:<attentionTimestamp>` | needs | a new request |
| Error | `e:<agentId>:<attentionTimestamp or "status">` | needs | a new error timestamp |
| Automatic review waiting for a person (failed or unavailable, `reviewSignal` in `shared/auto-review.ts`) | `review:<state>:<startedAt>` | needs | a new review run |
| Unread result | `u:<nativeAttentionToken>`; manual unread `u:<agentId>:manual`; without a token `u:<agentId>:<lastUserMessageAt>` | updated | another turn ends |

### 2.3 Rule

Per list, independently:

- Snoozing a list stores that list's current keys.
- A signal is snoozed when its key is in its list's stored set.
- A list of a card is snoozed while the card has at least one current key of that list and all of them are stored. Any new key in that list brings that list back, and the other list is untouched. Asks whose own key was snoozed stay out of the counts and queues; only the new ones count.
- Signals that disappear naturally (question answered, permission handled, session read) leave the rule unchanged.
- A later snooze of the same list replaces that list's set. Unsnooze removes the card's record (both lists).
- With read state unavailable, unread signals are not counted and the rule is unchanged.

## 3. Surfaces

### 3.1 Needs you rows

In the dock's Attention tab and the need-you step-through in the card sidebar (DISPATCHER-SPEC §9.3 and §9.4), each open ask has a Snooze icon button (`BellOff`, accessibility label `Snooze {title}`), outside the row's tap area and always visible. It snoozes that one signal through `asks.dismiss { signal }`: the key is added to its list's set and every key already stored stays. Snoozing a need-you ask never touches `u:`.

- Toast: `Snoozed. It comes back when something new happens.`
- There is no Snoozed group or restore list in either place. Asks leave Needs you and return on a new key.
- The step-through's Updates side has no Snooze button; stepping onto a card there reads its turn.

### 3.2 Card menu

The board card's long-press or right-click menu, the sidebar's actions menu and the phone Actions sheet offer:

- **Snooze in Needs you**, only while the card has an open (not yet snoozed) need-you signal.
- **Snooze in Updates**, only while the card has an open unread turn.
- **Unsnooze**, while any list is snoozed; it clears both lists. Toast: `Unsnoozed.`

Snooze in a list calls `attention.dismiss { taskId, list, signals }` with the card's current keys of that list.

### 3.3 Card and sidebar

- The card keeps all its signals unchanged. A snoozed list adds a small `BellOff` marker with the text `Snoozed`; the card's accessibility label includes `Snoozed`.
- While any list is snoozed, the card sidebar shows at the top `Snoozed. It comes back when something new happens.` and an **Unsnooze** button.
- Session cards, session preview and Mark as read behave as usual.

### 3.4 Counts

The "N need you" chip, the dock's Needs you queue, the `N` shortcut, the phone bell and the Paseo sidebar badge (`attention.count`, SIDEBAR-BADGE-SPEC) count only open, un-snoozed need-you signals. "N updated" and its queue count the cards the dispatcher saw change plus the cards with an un-snoozed open unread turn. All of them come from the same `asksFrom` / `attentionItems` rule, so board and sidebar match.

### 3.5 Tip

The tip `attention-dismiss` (id unchanged) appears when three or more cards have an open need-you signal and none is snoozed. Text: `Not ready to decide? Snooze it. It comes back when something new happens.` (ONBOARDING-SPEC tip table).

## 4. Data

`board.json` field `attentionDismissals`, delivered with the board's etag reads; no extra polling or RPC read. One record per card at most:

```
attentionDismissals: [{
  taskId,
  needs?:   { signals: string[1..100], snoozedAt },
  updated?: { signals: string[1..100], snoozedAt },
}]
```

- At least one list is present. Every key in a list belongs to that list (`signalList`). Keys are unique and at most 600 characters.
- Global limit 10,000 records; beyond it an error, nothing is evicted.
- Records are deleted with the card (permanent delete, project Remove) and kept on archive.
- No board, task or project revision change and no Activity event, but the board etag changes so other clients sync on their next read.
- Files without the field read as `[]`. Board version unchanged.
- **Migration:** a legacy record `{ taskId, signals, dismissedAt }` (one flat set) is read as snoozed in both lists: its non-`u:` keys become `needs`, its `u:` keys become `updated`, each list with `snoozedAt = dismissedAt` and omitted when empty. Nothing a card had hidden reappears or vanishes. The new shape is written on the next write of the board. The migration is one-way: an older Flowly cannot read the new record shape and refuses the board, so before going back to an older version, Unsnooze every card or restore a backup of the board from before the upgrade.

## 5. RPC

- `attention.dismiss { taskId, list: "needs" | "updated", signals }`: serialized write. The card and its project must exist and not be archived; `signals` must be non-empty, valid and all belong to `list`. It replaces only that list's set. The same set again is a no-op (keeps `snoozedAt`). The server does not check that the keys are still current; a stale set only brings the card back sooner.
- `attention.restore { taskId }`: deletes the record. Idempotent when there is none; `Task not found.` for an unknown card.
- `asks.dismiss { signal }` (DISPATCHER-SPEC §9.4): adds that one key to its list's set (creating the record if needed), keeping every stored key. When the list's set is full (100) it first drops its oldest stored keys that are no longer current, else errors.
- Errors: card or project missing or archived, invalid input, capacity, invalid stored data (the file is preserved). Daemon errors stay English.

## 6. Implementation structure

- `shared/attention-dismiss.ts`: schema and legacy migration, `signalList`, per-list `isDismissed` and add helpers, `sessionSignalParts`.
- `shared/attention.ts`: `attentionItems` with per-part `dismissed` and per-list `snoozed`; `asksFrom`.
- `server/store.ts`: the RPC writes.
- UI: `client/board.tsx`, `client/card.tsx`, `client/drawer.tsx`, `client/dispatcher-asks.tsx`.

## 7. Acceptance

- Pure functions: keys are stable; a per-list snooze does not hide the other list; a new key returns only its own list; vanished signals keep the rule; migrating a legacy record equals both lists snoozed; counts (N need you, N updated, bell, sidebar badge) respect per-list snooze.
- Server: dismiss and restore are idempotent; keys of the wrong list are rejected; archived, unknown, invalid and capacity errors; no revision or Activity change; delete cascades; a legacy file reads.
- `npm run typecheck` and `npm test` pass.
- UI in a non-fullscreen window: Snooze on a Needs you row lowers the count and shows the toast; the card menu offers each list's Snooze and Unsnooze; the card and sidebar show the marker; a new key brings its list back. UNRUN if the window cannot be bound.

## Rulings

- Ruling (Noah, 2026-11-10): the user-facing name is Snooze (buttons, accessibility labels, toasts, the card's signal, Unsnooze, the tour demo, every catalog); the meaning is unchanged, it comes back when something new happens. The idea Dismiss and the question-form Dismiss are different features and keep their name.
- Ruling (Noah, 2026-11-10): Snooze acts only on the list it was pressed in; keys are stored per list; existing dismissal records are read as snoozed in both lists.
- Ruling (Noah, 2026-11-10): the spec describes the current design only; history lives in docs/PROGRESS.md.
- Ruling (Noah, 2026-11-10): the card menu, sidebar and phone Actions offer Snooze in Needs you and Snooze in Updates separately, each only while that list has an open signal, and one Unsnooze for both; the Updates step-through has no Snooze button.
- Ruling (Noah, 2026-11-10): internal names stay (`attentionDismissals`, `attention.dismiss`, `attention.restore`, `asks.dismiss`, ask state `dismissed`, this file's name).
