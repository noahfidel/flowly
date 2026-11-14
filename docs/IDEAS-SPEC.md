# Ideas card: an agent proposes next tasks

Status: design confirmed by the user on 2026-10-15 (source A: agent tool; display A: source card sidebar + badge; card creation A: pre-filled new-card form), who asked to implement it directly with no further spec review. Card task `fa62fb3d`.

## 1. Purpose

While working, an agent often finds worthwhile follow-up work outside this card's scope (a bug found in passing, a refactor opportunity, a next-phase feature). Today these stay only in the conversation, and the user has to remember them and re-describe the context.

Ideas let the agent attach them to the source card as structured suggestions. When the user likes one there are two paths (2026-10-16, the user asked, their words translated: "Both paths must be supported"):

- **Continue in this card**: the idea is an extension of the current task, sent as an instruction back to this card's session, to continue in the original context;
- **Create a new card**: the idea is divergent work, which opens a pre-filled new-card form, creating a new card with the context.

If it is not good, ignore it.

An idea is not a task card: it does not enter a lane, does not take a workspace, and does not change the source card's status or task revision. Action happens only when the user clicks **Good idea** and picks a path; the agent never creates a card or assigns work on its own (v1 has no automatic assignment).

Amended 2026-10-29 (user decision, [AGENT-CARDS-SPEC](AGENT-CARDS-SPEC.md) D1): an agent may create or edit cards with `flowly_create_card` / `flowly_update_card` when the user asks it to in the session. Follow-up work the user did not ask for is still an idea, and an idea still becomes a card only through the user. No session is started on an agent-created card.

## 2. Data

### 2.1 Idea

Stored in the `ideas` array of `board.json` (the same file as cards, events and receipts), so that proposing an idea together with its receipt, and creating a card from an idea together with marking it accepted, both complete in one atomic transaction, and the client also gets ideas with the existing etag board read, with no new polling. An old file without the field reads as `[]`; the board version stays v4, with no migration.

```
{ id, taskId (source card), projectId, agentId, eventId (the Activity event when proposed),
  title    ≤120 characters, non-empty
  detail   ≤4000: what to do, acceptance criteria
  rationale ≤1000: why it is worth doing, what triggered it
  context  ≤4000: the files, branch and findings the new task needs (the agent of a new card cannot see the source card's conversation)
  type?: TaskType, priority?: Priority,
  scope?: "here" | "new",      // the agent's suggestion: continue in this card / create a new card; a default reads as "new"
  status: "open" | "accepted" | "dismissed",
  acceptedTaskId?: string,     // the card created after choosing "create a new card"
  acceptedAgentId?: string,    // the session it was sent to when choosing "continue in this card"
  createdAt, updatedAt }
```

- At most 10 `open` ideas per card; at most 50 ideas saved per card, and beyond that the earliest non-open idea is deleted.
- `accepted` is a final state and cannot be changed again.

### 2.2 Task.origin

A card gains an optional field `origin: { taskId, ideaId }`, meaning which idea of which card it was created from. Old cards do not have the field and are not migrated. When the source card or idea is later deleted, the field is kept, and the UI shows it as deleted.

Since 2026-10-16 the display is replaced by [CARD-LINKS-SPEC](CARD-LINKS-SPEC.md): creating the card also writes a `derived` link, the UI and tools read only links; `origin` is kept only as a historical record.

### 2.3 Receipts and events

- The receipt `action` gains `"idea"`; `status` records the card's status when proposed.
- Activity events:
  - `idea_proposed` (agent, source card, note=title)
  - `idea_accepted` (human, source card, note=`title → new card title`)
  - `idea_adopted` (human, source card, agentId=target session, note=title)
  - `idea_dismissed`, `idea_restored` (human, source card, note=title)
  - `idea_edited`, `idea_dismissed`, `idea_removed` (agent, source card, agentId=the calling session, note=title; §3.1)
- The receipt `action` also has `"idea_update"`, `"idea_remove"` (§3.1).
- 2026-10-22 Astra review fix: the receipts of a new idea proposal, update and delete also persist an optional `ideaId`, and a replay returns the ID saved in the receipt first; when an idea has been deleted or auto-pruned the original ID is still returned, with no revival of the entity and no duplicate event. An old receipt without the field is read compatibly from the request ID for update/delete, and a proposal is still looked up from the retained idea; the ID of an old deleted entity cannot be restored afterwards, and no data migration is done.
- The new `idea_edited`, `idea_removed` Activity actions use a localized mapping marked with `msg()` (English keys `Edited the idea`, `Removed the idea`) and all language catalogs, and switch with the UI language.

## 3. Agent tool `flowly_propose_idea`

Input (strict):

```
{ expectedRevision, request,             // same as the other write tools, from flowly_get_task
  title, detail, rationale,
  context?: string = "",
  type?: "feature"|"bugfix"|"research"|"refactor"|"docs"|"chore",
  priority?: "low"|"normal"|"high"|"urgent",
  scope?: "here"|"new" = "new" }   // here: an extension of this card's goal, which this card's session can continue with the existing context; new: divergent work
```

- The same identity, signature, expiry, revision, archived and finished checks as `flowly_report_progress`; it does not change the card status or revision.
- Replay: the same request with the same parameters returns the original receipt and the original `ideaId` (`replayed: true`); different parameters report `REQUEST_REUSED`.
- Errors:
  - `IDEA_DUPLICATE`: this card already has an open idea with the same title (trimmed, case-insensitive), and the message carries the existing idea ID.
  - `IDEA_LIMIT`: this card already has 10 open ideas.
- Output: `toolResultSchema`, with one extra `ideaId`.
- The context of `flowly_get_task` adds `ideas: [{ id, title, status, scope?, acceptedTaskId?, acceptedAgentId? }]` (all of this card's ideas), so the agent avoids duplicates.
- The CLI adds an `idea` subcommand: `idea --request-file <snapshot> --title … --detail … --rationale … [--context …] [--type …] [--priority …] [--scope here|new]` (no `--note` needed). The `action` of the HTTP `/api` adds `"idea"`.

### 3.1 Agent manages this card's ideas (2026-10-22, card "Extend the idea tools")

The user asked that an agent can manage ideas itself (close, edit, delete); for example when the user rejects a proposal in the conversation, the agent closes it directly instead of leaving it hanging on the card.

- `flowly_update_idea { expectedRevision, request, id, title?, detail?, rationale?, context?, type?, priority?, scope?, tags?, status?: "dismissed" }`: pass only the fields to change (`tags` replaces the suggested tags as a whole, `[]` clears them). `status: "dismissed"` closes the idea, with the same result as the user clicking Dismiss (it goes into the Closed group, and the user can Restore). Changing fields and closing can be done in one call, each recording one event (first `idea_edited`, then `idea_dismissed`).
- `flowly_remove_idea { expectedRevision, request, id }`: delete an idea, for ones proposed by mistake or duplicated. For one the user rejected, dismiss is recommended (kept visible and restorable); deleting leaves only an `idea_removed` event.
- Scope and constraints:
  - Only ideas on this card (the card the connection is bound to) can be handled, including ones proposed by any session on this card; an id of another card reports `IDEA_NOT_FOUND`.
  - `accepted` is a final state: edit, close and delete all report `IDEA_CLOSED`.
  - Only an `open` idea can have fields changed; a `dismissed` one can only be deleted, and Restore can still be done only by the user; an agent does not overturn the user's dismissal. Dismissing an already dismissed idea again changes no data and records no event.
  - When changing the title, the same duplicate-title check against this card's other open ideas applies (`IDEA_DUPLICATE`). Giving no field and no `status` reports `INVALID_INPUT`; a value equal to the current one changes no data and records no event (the receipt `eventId` is empty).
  - The rest is the same as `flowly_propose_idea`: identity, signature, expiry, revision, archived and finished card rejected (`ARCHIVED` / `TASK_FINISHED`), Ideas off reports `IDEAS_DISABLED`, a replay returns the original receipt, different parameters report `REQUEST_REUSED`; it does not change the card status or task revision. The `ideaId` of the result is the idea operated on.
- CLI: `idea-update --request-file … --id <idea id> [--title --detail --rationale --context --type --priority --scope --tags a,b] [--dismiss]`, `idea-remove --request-file … --id <idea id>`; the `action` of the HTTP `/api` adds `"idea_update"`, `"idea_remove"`.
- The UI is unchanged: the sidebar and the Ideas page refresh as usual through the etag read, and an idea closed by an agent appears in the Closed group.

## 4. Skill rules (one added)

- At each delivery (`in_review`), review what was noticed this turn that the user did not ask for but is worth doing (a bug found in passing, a refactor opportunity, a follow-up feature), propose at most 3, using `flowly_propose_idea`; if there is truly nothing worth proposing it can be 0, but it should be a conscious decision, not forgetting (§4.1 reminds when none has been proposed). An extension of this card's goal uses `scope=here` (the user may send it back to this session to continue); divergent work (a bug found in passing, a refactor, an independent feature) uses `scope=new`. Work this card was already asked to do is not an idea, just do it.
- At most 3 per delivery; look at `ideas` first to avoid duplicates.
- `context` states clearly the files, branch and conclusions the new task needs, because the agent of a new card cannot see this conversation.
- An idea is only a suggestion: do not start it and do not create a card.
- Keep this card's open ideas up to date (§3.1): when the user rejects one in the conversation, or this card has already done it / it has lost meaning, close it with `flowly_update_idea status=dismissed`; for wrong or outdated content change it with `flowly_update_idea`; for ones proposed by mistake (duplicates) delete them with `flowly_remove_idea`. An accepted one is final, and a dismissed one can be restored only by the user.

### 4.1 Delivery-time reminder (implemented, 2026-10-20)

2026-10-20 card "Delivery-time reminders for missing next moves and ideas". In the skill, "usually at delivery" is an optional second call, and the agent no longer thinks of it after finishing the work: of 145 turns on 2026-10-19, 7 proposed an idea, and on 2026-10-20, as of design time, 0 of 26 turns proposed an idea. The mechanism is the same as the next moves reminder; the details (trigger, result shape `reminders: string[]`, key order, replay, relationship with next moves) are in [NEXT-MOVES-SPEC](NEXT-MOVES-SPEC.md) §9; only the ideas part is written here.

- Trigger: after `flowly_update_status` → `in_review` succeeds. Other calls (`blocked`, `question`, `result`, switching the work stage) do not remind about ideas.
- Condition (all three at once): the Ideas setting is on; the write succeeded; this session (`agentId`) has **never** proposed an idea on this card. The last reads `board.ideas` (`taskId` + `agentId`, including dismissed/accepted ones) and not the `idea_proposed` events, because events keep only the latest 100 per card, and on a busy card old events get pruned and cause a false reminder.
- This is "card-level" and not "turn-level": once the session has proposed one on this card, later deliveries no longer remind (the skill still says "at each delivery"). Reason: there is no receipt for "I decided to propose 0", so a turn-level reminder would repeat the reminder at every delivery for a card where 0 was a conscious choice. To change it to turn-level, switch the source to the `idea_proposed` event and bound it by the most recent `agent.turn_started`.
- Silent when Ideas is off: no reminder, and ideas are not read. The behavior of `IDEAS_DISABLED` is unchanged.
- Text (English): `You have proposed no ideas on this card. Consider 0-3 ideas (flowly_propose_idea) for worthwhile follow-ups you noticed: bugs, refactors, next features. Zero is fine; decide on purpose.`
- It is only text: the write succeeds as usual, with no blocking (unlike `WORKPAD_OPEN`), no new error code, nothing written to the board, and no change to any `idea` validation or limit.

## 5. UI

### 5.1 Board card

When there is an open idea, the signal row at the bottom of the card shows a light bulb icon (`Lightbulb`) plus the count; at 0 it is not shown. The accessibility text includes "N ideas".

### 5.2 Sidebar Ideas block

Position: after Sessions, before Details (2026-10-15 user feedback: put it under Sessions). When the card has no idea at all the whole block is not rendered.

- The title `Ideas`, with the count being the number of open ones.
- One small card per open idea (2026-10-16 the user asked to improve the design, interaction and motion, and the accept button became Good idea):
  - The title (bold); a line of meta info: type, priority (only non-Normal; High/Urgent carry an arrow icon, Low is shown as "Low priority" with no icon), time proposed (relative time); the rationale; What to do (detail) and Context follow without truncation. The fonts are consistent with the Progress card: the title is base medium weight (same as State), the rationale and field bodies md, the field names and meta info xs in a dimmed color.
  - Truncation fade (2026-10-19 user feedback, consistent with the Progress card, sharing the generic card style `ContentCard` of `client/content-card.tsx`): when the whole content (title, meta info, rationale, What to do, Context) exceeds about 5 lines (104 pt), it collapses as a whole to that height with a fade at the bottom; on the same row at the bottom, the left is Show more / Show less to expand or collapse, and the right is the action buttons (height transition 220 ms decelerating / 160 ms accelerating, interruptible, follows Reduce Motion). When the content does not overflow it is shown in full and Show more does not appear. The icon and text of Show more sit flush against the left edge of the body (aligned with the text above when at rest), the hover highlight extends outward only 6 pt more, not touching the card border; the title and meta info form one group, and the spacing between the blocks after it (rationale, What to do, Context) is the same as Progress (8 pt). Clicking the card itself no longer expands it, and the text can be selected directly.
  - Bottom-right buttons (2026-10-19 user feedback: right-aligned, restored to standard size, no longer the compact size; on the same row as Show more to save space. The source row "From …" of the Ideas page sits below this row): **Dismiss** (a quiet button, ignore; renamed from Not now on 2026-10-19), **Good idea** (the primary action, `ThumbsUp` icon, opens the choice menu, see §6, at the far right). The accessibility names are "Dismiss …" and "Good idea: … Choose to do it in this task or start a new task." respectively. Restore in the Closed group still uses the compact size.
  - The very front of the meta info row shows the agent's suggestion: `CornerDownRight` "Continues this task" or `SquarePlus` "New task".
  - Dismiss is an optimistic update: the card leaves immediately and collapses in place (height, opacity and a slight scale transition together over 160 ms), the same on desktop and phone, the same as the Memory card (2026-10-22 user decision: Memory's collapse is better, replacing the desktop slide-out to the right of 2026-10-19). Under Reduce Motion it is removed directly. When saving fails it restores and shows an error toast. "Continue in this card" likewise collapses optimistically, and on success shows the success toast "Sent to <session>"; after an idea is turned into a card it likewise collapses and leaves the list.
  - Ideas that already exist when the drawer opens do not play an enter animation. An idea that newly arrives (proposed by an agent) or is Restored while it is open plays an insertion animation: first the height of its row expands (160 ms), then it fades in (220 ms decelerating); a Restored card, like a newly arrived one, floats up slightly (no longer sliding in from the right). Even if the idea existed when the drawer opened, Restore still plays the insertion animation (2026-10-19 user feedback). Under Reduce Motion it just appears.
  - All motion uses the `client/motion.tsx` primitives, follows Reduce Motion, and is interruptible; a card that is collapsing is not interactive and is hidden from screen readers.
- When there is no open idea but there are closed ideas, show "No open ideas. Agents add them when they see a worthwhile next step."
- Non-open ideas are kept in a default-collapsed `Closed · N` group:
  - accepted (`ThumbsUp` icon): when a card was created it shows "→ new card title", clicking opens that card, and when the new card has been deleted it shows "→ deleted card"; when continued in this card it shows "→ Sent to <session title>".
  - dismissed: shows a dimmed title and **Restore**.
- When the project is archived the buttons are disabled. When the card is Done/Cancelled or archived, the idea stays open, and can only be turned into a new card or ignored (since 2026-10-16, see [IDEAS-INBOX-SPEC](IDEAS-INBOX-SPEC.md) §2).
- A successful Dismiss / Restore shows no toast (the list itself is the feedback), and a failure uses an error toast.

### 5.3 New card sidebar

When there is an `origin`, one line "From idea on <source card title>" is shown before the description, and clicking opens the source card; when the source card has been deleted it shows "From idea on a deleted card", not clickable.

## 6. The two paths of Good idea

Clicking **Good idea** opens the plugin menu (an anchored dropdown on desktop, a bottom sheet on phones), titled "Good idea" (2026-10-16 the user confirmed adding "new session" and "choose session"):

- **Continue in <session>** (`CornerDownRight`) → §6.2, sent to the default session: the session that proposed the idea (still in this card's workspace and not archived) first, otherwise this card's latest unarchived session; when there is no usable session this item is not shown;
- **Send to another session…** (`MessagesSquare`, appears when this card has 2 or more unarchived sessions) → opens a second menu "Send to", listing all unarchived sessions (the default one carries a `Check`), and after one is selected it is sent per §6.2;
- **Do it in a new session** (`Plus`) → §6.3;
- a divider;
- **Start a new task** (`SquarePlus`) → §6.1.

(Since 2026-11-09) for an idea with `scope=new` (or no scope), when *Quick task for New task* is on and the source card can continue, Good idea does not pop up the menu but opens Quick task directly; this card's actions are reached through the dialog's **Other options…**: Continue in <session>, Send to another session… (when there are 2 or more unarchived sessions), Do it in a new session, and the full form. When *Quick task for New task* is off there is no Other options…, so the menu still pops up, with "Start a new task · Suggested" first and the rest after the divider. An idea with `scope=here` always pops up the menu, with this card's three items first, unaffected by that setting.

When `scope=here` is suggested, this card's three items come first, Continue carries "· Suggested" (when there is no usable session, "Do it in a new session" carries Suggested instead).

"Start a new task", when *Quick task for New task* is on, opens Quick task (locking the idea's project, pre-filling the idea, carrying `ideaId`; the dialog's **Other options…** lists the full form and this card's three items above), and when off opens the full form of §6.1; see QUICK-TASK-SPEC §10. A project idea, and an idea whose source card is finished/archived/non-existent, has only the create-new path, and Good idea opens the same Quick task (or the full form) directly, with no menu any more.

### 6.4 Discuss

Each open idea card has **Discuss** to the left of Dismiss (the sidebar Ideas and the project Ideas page, sharing `IdeaCard`), shown only when the board can open the dispatcher chat. It opens the dispatcher chat and puts a draft about that idea into the message box, without sending; see DISPATCHER-SPEC §9.5.

### 6.1 Create a new card

1. Open the existing new-task form (the same component), pre-filled:
   - Title, type, priority = the idea's values (the form defaults if not given); status = the project's first available start lane (the same default as an ordinary create).
   - Description = `ideaDescription()` (`shared/ideas.ts`):

     ```
     <detail>

     Why: <rationale>

     Context:
     <context>

     From card: <source card title> (<source card ID>)
     Source progress:            // only when the source card has a summary
     <target>
     <recap>
     ```

     When it exceeds the description limit of 20000 it is truncated and ends with `…`.
   - workspace and "Start agent" are optional as usual; the first instruction is not pre-filled (the existing rule).
   - The form title is "Create task from idea".
2. On save the input of `tasks.create` carries `ideaId`. Server:
   - **Before** creating the workspace, check that the idea exists, is open and belongs to the same project; otherwise report "This idea is no longer open.", leaving no workspace behind.
   - In the same transaction that writes the new card, check once more, write `origin`, change the idea to accepted and record `acceptedTaskId`, and record an `idea_accepted` event on the source card.
   - A repeated submission with the same `operationId` returns the card created the first time (existing behavior), and does not process the idea again.
3. The new card's agent session context adds one line after the task type, `Derived from card: <source card title> (<ID>)`.

### 6.2 Continue in this card

`ideas.adopt { id, agentId }` (`server/ideas.ts`):

1. Validate that the idea is open, and the target session belongs to this card's workspace, is not archived and is not a summarizer; otherwise report an error and change no data.
2. First, in one transaction, change the idea to accepted, record `acceptedAgentId`, and record an `idea_adopted` event on this card (rejected when the card or project is archived), so that a repeated click does not send twice.
3. Then send `ideaInstruction()` to that session through the composer queue: sent at once when idle, and when running it is queued after the current turn (consistent with the queuing behavior of sending a message in the sidebar, without interrupting). The message:

   ```
   Good idea — go ahead with it in this task: <title>

   <detail>

   Why: <rationale>

   Context:
   <context>
   ```

   This is a board action the user chose explicitly, so it is not subject to the limit "an ordinary follow-up sends only the user's own text".
4. When enqueuing fails, restore the idea to open, delete that event, and return the error to the UI.

It does not change the card status or task revision; after the session receives the message and starts a new turn, the existing automatic status rules take effect as usual.

### 6.3 Do it in a new session

Suited to when the original session is busy, its context is too long or one wants to switch models.

1. Open the existing "Start session" dialog (`SessionCreate`), pre-filling the session title = the idea title and the first instruction = `ideaInstruction()`; the model and mode are optional as usual, and the instruction can be edited. Because it is explicitly initiated by the user from an idea, pre-filling the instruction here is allowed (an ordinary Start session still does not pre-fill).
2. After the session is created successfully, call `ideas.adopt { id, agentId: <new session>, send: false }`: it only validates and records (accepted, `acceptedAgentId`, the `idea_adopted` event), and no longer sends through the composer, to avoid a duplicate.
3. When recording fails the session runs as usual, with the error toast "Session started, but the idea was not marked: …"; closing the dialog without creating a session leaves the idea open.

## 7. Human RPC

| Method | Input | Behavior |
| --- | --- | --- |
| `ideas.update` | `{ id, status: "open" \| "dismissed" }` | open ↔ dismissed; accepted reports an error; when restoring to open, if this card already has an open idea with the same title (trimmed, case-insensitive) it reports the error "This card already has an open idea with that title.", and it is subject to the limit of 10; no write when the status is unchanged |
| `ideas.adopt` | `{ id, agentId, send = true }` | Continue in this card (§6.2); `send: false` only records (§6.3); returns the updated idea |

The board revision increases accordingly, and the client refreshes through the existing etag read.

## 8. Deletion and archive

- Permanently deleting a card: the ideas that have it as source are deleted with it and written to the `removed/task-…json` backup. Cards created from those ideas keep `origin`.
- Removing a project: the project's ideas are deleted and backed up with it.
- Archiving a card: its ideas are kept and can still be handled (only a new card or ignore, IDEAS-INBOX-SPEC §2); an agent can no longer propose (consistent with the other write tools).

## 9. Not done

- The summarizer automatically generating ideas; a virtual Ideas lane. The project-level Ideas page was added on 2026-10-16, see [IDEAS-INBOX-SPEC](IDEAS-INBOX-SPEC.md).
- Automatically creating cards or automatically assigning an agent to a new card; idea sorting, voting; the user editing an idea in the UI (agent editing is in §3.1).

## 10. Acceptance

- Unit:
  - Proposing: receipt replay, `REQUEST_REUSED`, `IDEA_DUPLICATE`, `IDEA_LIMIT`, archived/finished rejection, no task revision change, pruning at the limit of 50.
  - Creating a card: the pre-check and the re-check inside the transaction, atomic write of `origin` and accepted, a non-open idea reports an error and creates no workspace, cross-project rejection.
  - `ideas.update` status constraints; the cascade and backup on card deletion and project removal; an old `board.json` (without `ideas`) is readable.
  - The output and truncation of `ideaDescription()`; the source line of `sessionContext`.
  - Management (§3.1): changing fields, closing and deleting this card's open idea; dismissed can only be deleted or closed again; accepted cannot be changed or deleted; cross-card rejection; a rename to a duplicate, an empty update, Ideas off; receipt replay and `REQUEST_REUSED`; events recorded correctly, the card revision stays unchanged.
  - Astra regression: propose → delete → reload the service → replay the proposal as is, still returning the original `ideaId` and receipt, keeping ideas empty and writing no file again; an old receipt without `ideaId` with the entity still present is looked up compatibly; the two new Activity keys are complete in all language catalogs.
- Tool service: register `flowly_propose_idea`, `flowly_update_idea`, `flowly_remove_idea`; the `idea` / `idea_update` / `idea_remove` actions of `/api`; `flowly_get_task` returns `ideas`; the CLI `idea-update` / `idea-remove` and invalid-parameter rejection.
- Real verification of the management tools (2026-10-22): on a reloaded plugin, with a temporary idea on this card, walk through "propose → edit → close → delete" via MCP and the Luna 6 full-access CLI, check receipt replay, error rejection, Activity, and that the card status and revision are unchanged, and at the end clean up the temporary idea and test session. This increment has no client change, and desktop/compact rendering is not evidence that the tool calls pass. For the report see [idea-tools verification](verification/idea-tools-2026-10-22.md).
- Delivery-time reminder (§4.1, `server/agent-service.test.ts`): `in_review` with this session having proposed no idea and Ideas on → the result carries the ideas reminder; Ideas off → none; this session has already proposed (including dismissed ones) → none; one proposed by another session does not count; after old `idea_proposed` events are pruned there is still no false reminder (judged by `board.ideas`); `blocked`/`question`/`result` carry no ideas reminder; a failed write (`WORKPAD_OPEN`) carries none.
- typecheck, full tests; install and reload this plugin; with a Luna 6 full-access test session on a fixture card, walk through "propose → sidebar display → create card → two-way link", and clean up afterwards.
