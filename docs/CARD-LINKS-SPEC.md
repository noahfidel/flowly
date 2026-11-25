# Card links

Status: on 2026-10-16 the user chose option A (Derived from + Related + Blocks, Blocks only hints and does not block, no parent-child), approved the review and asked for implementation. Card task `b80969de`.

## 1. Purpose

Between cards there is currently only one relation: `Task.origin` on a new card built from an idea ([IDEAS-SPEC §2.2](IDEAS-SPEC.md)). This relation can only be seen from the new card; the source card cannot see "which cards I spawned"; follow-up cards created by hand, cards that are related to each other, and cards that must wait for another card to finish cannot be expressed.

This feature gives cards three kinds of lateral links:

| kind | Direction | Meaning | Where it comes from |
| --- | --- | --- | --- |
| `derived` | `from` new card → `to` source card | The new card is follow-up/derived work of the source card | Creating a card from an idea (automatic); **New follow-up task** (manual entry); manual link |
| `related` | None | The two cards are related to each other | Manual link |
| `blocks` | `from` blocker → `to` blocked | `to` must wait for `from` to finish | Manual link |

Links are used only to **show and give context**: they change no card's business status, do not block dragging or status changes, and do not send messages to sessions automatically.

Research conclusion (Vibe Kanban, Multica, Linear/Jira/Plane, the agent-tasks MCP): parent-child hierarchy and lateral links are two separate mechanisms; a parent-child hierarchy generally does not link status either. With "one card, one workspace", a parent-child hierarchy involves branch merging, status rollup, cascading delete/wrap-up/restore and board nesting, and is not done in this phase (§9).

## 2. Data

### 2.1 Link

Stored in a new `links` array in `board.json` (the same file as cards, ideas and events), so that creating a card from an idea, marking it accepted and writing the link happen in the same atomic transaction; the client gets the links through the existing etag board read, with no new polling.

```
{ id, projectId,
  kind: "derived" | "related" | "blocks",
  from: taskId, to: taskId,
  ideaId?: string,        // when derived and produced by creating a card from an idea
  createdBy: "human" | "system",
  createdAt }
```

`shared/model.ts` adds `linkSchema`, `linkKinds` and `linkLimits = { perTask: 50 }`; `boardSchema` adds `links: z.array(linkSchema).optional()` (see §2.2: missing and an empty array mean different things). The board version stays v4.

### 2.2 Old data: `origin` backfill

- When the file has **no** `links` field (written before the upgrade), on read one `derived` link is generated for each card with an `origin` (`from` = that card, `to` = `origin.taskId`, `ideaId` = `origin.ideaId`, `createdBy: "system"`, `createdAt` = that card's `createdAt`). Those whose source card no longer exists are skipped. It is persisted together with the file on the next write.
- When the file **has** a `links` field, it is the only basis and is no longer derived from `origin`. This way a link produced by an idea does not come back after the user deletes it.
- The `Task.origin` field is kept untouched (history record, no change to the task revision); the UI and tools read only `links`.

### 2.3 Constraints (server validation, `server/links.ts`)

- Both cards exist, belong to the same project, and are not the same card; the project is not archived. When either card is archived, **creating** a link is refused (deleting is allowed).
- Only one link of the same kind per pair of cards; `related` has no direction, and (A,B) and (B,A) count as the same one.
- When a pair of cards already has any link, `related` cannot be added ("These cards are already linked."); when a new `derived` or `blocks` is added, the existing `related` between this pair is deleted in the same transaction (replaced by the more specific relation).
- `blocks` and `derived` each cannot form a cycle (including the two-card cycle of A→B and B→A): "This would make a cycle: A → B → … → A." listing the card titles on the path.
- At most 50 links per card (both ends count): "A card can have at most 50 links."
- When validation fails, no data is written.

### 2.4 Events

Links do not change the task revision, only the board revision. Each of the two cards records one human event:

- `linked`, with a note describing it from this card's point of view, such as `Blocks: <other title>`, `Blocked by: <other title>`, `Follow-up of: <other title>`, `Follow-up: <other title>`, `Related: <other title>`;
- `unlinked`, in the same format.

When a card is created from an idea there is already an `idea_accepted` event, and no extra `linked` is recorded.

### 2.5 Perspective and resolution

`shared/links.ts` provides pure functions shared by the server, tools and client:

- `linksOf(board, taskId)` → `{ link, other: Task | undefined, relation }[]`, with `relation` from this card's point of view:

  | kind | This card is from | This card is to |
  | --- | --- | --- |
  | `derived` | `follow_up_of` | `follow_up` |
  | `blocks` | `blocks` | `blocked_by` |
  | `related` | `related` | `related` |

- `isResolved(task)`: the blocker's status is Done/Cancelled, or it is archived, counts as resolved.
- `waitingOn(board, taskId)`: the unresolved `blocked_by` links.
- `wouldCycle(board, kind, from, to)`: returns the cycle path or `undefined`.

## 3. Human RPC

| Method | Input | Behavior |
| --- | --- | --- |
| `links.create` | `{ kind, from, to }` | Validates per §2.3 and writes; returns the new link. Submitting the same link again (an identical one already exists) returns the existing one without writing |
| `links.delete` | `{ id }` | Deletes; when it does not exist, reports "This link no longer exists." |
| `tasks.create` | New optional `followUpOf: taskId`, mutually exclusive with `ideaId` | Writes one `derived` in the same transaction as the new card (`from` = new card, `to` = followUpOf). **Before** creating the workspace it checks that the source card exists, is in the same project and is not archived, otherwise no workspace is left behind; it re-checks inside the transaction. Replaying the same `operationId` returns the card created the first time and does not write the link again |

Creating a card from an idea (`tasks.create` with `ideaId`) writes one extra `derived` in the existing transaction (with `ideaId`, `createdBy: "system"`). This link is not bound by the 50 cap, so that accepting an idea does not fail when the source card's links are full.

## 4. Agent side

- `flowly_get_task` gets a new read-only field:

  ```
  links: [{ relation: "follow_up_of"|"follow_up"|"related"|"blocks"|"blocked_by",
            taskId, title, status, laneName, archived, resolved? /* blocked_by only */ }]
  ```

  A deleted other card does not appear (the links are deleted along with it). The agent can see only the other card's title and status, not its chats or description.
- The task context injected when a session is created (`sessionContext` in `shared/scope.ts`) replaces the current `Derived from card:` line with a list of links, at most 10 per kind, with `…and N more` when exceeded:

  ```
  Follow-up of: <title> (<ID>) [<lane name>]
  Blocked by: <title> (<ID>) [<lane name>]      // unresolved only
  Blocks: …
  Related: …
  ```

  This is a snapshot at session creation; afterwards `flowly_get_task` is authoritative.
- The skill gets one new item: `links` lists the linked cards; when there is an unresolved `blocked_by`, say so in the reply before starting and follow the user's instruction on whether to continue (do not change the status to blocked yourself, unless the whole card really cannot move forward).
- In v1 the agent **cannot** create or delete links (no new write tool).

## 5. UI

### 5.1 Board card

When there is an unresolved `blocked_by`, the card's bottom signal row shows an `Hourglass` icon plus "Waiting on N" (a narrow card shows only the number); it disappears once all are resolved. Accessibility text "Waiting on N cards: <titles…>". Other links are not shown on the card face (to avoid noise).

### 5.2 Sidebar Links block

Position: after Ideas, before Details & workspace.

- Title `Links`, with the count being the total number of links; the `+` button on the right of the title opens a menu: **Link to a card…** (§5.4), **New follow-up task** (§5.5). When there are no links only the title row and `+` are shown, with no empty-state text.
- Links are grouped by relation, in this group order and with these titles: `Waiting on` (unresolved blocked_by), `Blocks`, `Follow-up of`, `Follow-ups`, `Related`, `Was waiting on` (resolved blocked_by). Empty groups are not shown.
- Each row: the other card's type icon, title (truncated to one line), lane name (small, muted); an archived other card's title is muted and carries "Archived"; a derived row produced by an idea gets a small `Lightbulb` icon after the lane name. Clicking a row opens the other card (the same jump as the existing `IdeaOrigin`). The `X` icon button at the end of the row deletes the link, without confirmation; the removal is optimistic (collapses in 160 ms), and on failure it is restored with an error toast. Accessibility name "Remove link: <relation> <title>".
- When the card or project is archived, `+` and the delete buttons are disabled, and the list is shown as usual.
- Add/remove motion uses the `client/motion.tsx` primitives, honors Reduce Motion and is interruptible; rows already there do not play an entrance when the drawer opens.

### 5.3 Source line above the description

`IdeaOrigin` now reads the `follow_up_of` links (no longer `task.origin`): with an `ideaId` it shows "From idea on <title>", otherwise "Follow-up of <title>"; with several it shows the first and adds "+N" (clicking scrolls to the Links block). When there is no such link it is not shown.

### 5.4 Link to a card…

A plugin Modal (a bottom sheet on phones):

1. A segmented choice of relation at the top: **Related** (default) / **Blocks** / **Blocked by** / **Follow-up of**. "Blocked by X" and "Follow-up of X" are converted on submit to a `blocks` / `derived` in the matching direction.
2. A `TextBox` search field (title contains match, case-insensitive, debounced with `commitDelay`), with the non-archived cards of this project listed below: type icon, title, lane name; sorted by lane order and then by board position. This card is excluded; cards that already have a link with this card under the chosen relation are shown disabled and marked "Linked".
3. Tapping a card submits `links.create`; on success the popover closes and a success toast "Linked" appears; on failure (cycle, cap, already linked, card no longer exists) the popover stays and the error is shown above the list.

Entry points: the `+` menu of the Links block; **Link to a card…** in the card sidebar ⋯ menu (after Start session). Ruling (Noah, 2026-11-10): the board card menu no longer has this item (UI-UX-SPEC §2).

### 5.5 New follow-up task

Opens the existing new-task form (the same component), titled "Create follow-up task", with one line "Follow-up of <source card title>" at the top of the form. Field defaults are the same as a normal new task, with type and priority inherited from the source card; the description is empty. On save `tasks.create` carries `followUpOf`. Entry points: the `+` menu of the Links block; **New follow-up task** in the card sidebar ⋯ menu (the board card menu no longer has it, Ruling Noah 2026-11-10).

## 6. Delete and archive

- Permanently deleting a card: all links that have it as either end are deleted with it and written to the existing `removed/task-…json` backup (a new `links` field); the other card records an `unlinked` event (the note uses the deleted card's title).
- Removing a project: that project's links are deleted and backed up too.
- Archiving a card, wrap-up, restore: links are kept and unaffected. An archived blocker counts as resolved (§2.5).
- Status changes (including a blocker becoming Done) trigger no automatic action.

## 7. Error messages

| Case | Message |
| --- | --- |
| Across projects | "Cards in different projects can't be linked." |
| Itself | "A card can't be linked to itself." |
| Already linked | "These cards are already linked." |
| Cycle | "This would make a cycle: A → B → … → A." |
| Cap | "A card can have at most 50 links." |
| Card archived | "Archived cards can't get new links." |
| Card/link does not exist | "Task not found" / "This link no longer exists." |

## 8. Performance

- Links are read with the board in one read, with no new RPC polling; `linksOf` filters by `taskId` on each render, at most 50 per card. The Waiting on count on the board card face is computed once in the derived data of `client/board-view.ts`, and only the number and the title string are passed (compared by content) to the already memoized card component.
- The card chooser popover computes its list only when opened; search is debounced.

## 9. Not doing

- Parent-child hierarchy, subtask progress rollup, status linking, cascading delete/wrap-up.
- Cross-project links; other relation types such as `duplicate`; a link graph view.

Amendment, ruling (Noah, 2026-11-25), `docs/UMBRELLA-SPEC.md` D13: umbrella *membership* is allowed as a shared context (one brief, contract and decisions feed) across the projects of one board group. It is not a parent-child hierarchy: no rollup, status linking or cascades, and card links themselves stay same-project.
- Hard blocking for Blocks; automatically notifying the blocked card's session when the blocker finishes.
- A tool for the agent to create/delete links.

## 10. Acceptance

- Unit (`shared/links.test.ts`, `server/links.test.ts`, `server/store.test.ts`):
  - Perspective mapping, `isResolved`, `waitingOn`, cycle detection (two-card cycle, long cycle, derived and blocks not affecting each other).
  - Each constraint and error of `links.create`; `related` replaced by a more specific relation; submitting again returns the existing link and does not write; only the board revision grows, not the task revision; the events on both ends.
  - `links.delete`; an error when it does not exist.
  - `tasks.create` with `ideaId` writes the link and accepted atomically; the pre-check with `followUpOf` (no workspace left behind), the re-check inside the transaction, replay not duplicating; giving `ideaId` and `followUpOf` together is rejected.
  - Old `board.json`: without `links`, backfilled from `origin` with missing source cards skipped; with `links` (including an empty array), not backfilled.
  - Link cascade and backup on card deletion and project removal.
  - The link lines and truncation of `sessionContext`; the `links` of `flowly_get_task`.
- Client (`client/board-view.test.ts` etc.): the Waiting on count; the group order; the exclusions and disabling in the chooser popover.
- Typecheck and the full tests; install and reload this plugin; use a Luna 6 (`codex/gpt-6-luna`, `full-access`) test session on a fixture project to walk through: manual Related/Blocks/Follow-up links and deleting them, errors for a cycle and across projects, creating a card from an idea producing a derived, New follow-up task, the Waiting on signal disappearing when the blocker finishes, cascade on card deletion, `flowly_get_task` returning links; for the desktop and compact layout UI, bind the non-fullscreen window per AGENTS.md, and mark UNRUN when it cannot be bound. Clean up the fixtures afterwards and save the evidence to `docs/verification/card-links.md`.
