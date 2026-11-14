# Next-step suggestions (NEXT-MOVES-SPEC)

## 1. Goal

After finishing a stretch of work, an agent often writes at the end of its reply "Next, do you want to ... or ..." (for example after development it suggests Luna verification, and after verification it suggests commit and merge). These suggestions are buried in text, and the user has to reorganize them into one message and send it again.

This feature gives the agent a tool to hand the candidate next steps after this turn ends to Flowly in structured form; above the session input box the suggestions of this turn are shown, and one click **pre-fills** the matching instruction into the input box, **without sending automatically**, for the user to edit or send directly.

The difference from Ideas: an idea is work outside this card's goal that is worth doing later (it goes to the Ideas inbox and can become a new card); a next move is a candidate for **this session's next message**, valid only between the end of this turn and the start of the next, and it does not go to the inbox or create a card.

## 2. Agent tool `flowly_suggest_next_moves`

- Input: `expectedRevision`, `request` (copied verbatim from get_task), `moves`: 1–3 items (from §9.4 it can also be an empty list, meaning "no next step needing the user this turn"), each with
  - `label`: the button text, 1–60 characters, a short verb phrase, in the language the user uses (for example, in the user's language, "Verify with Luna" or "Commit and push").
  - `prompt`: the complete instruction pre-filled into the input box on tap, 1–2000 characters, written as what the user would say to the agent, understandable on its own.
- Calling again within the same turn of the same session: the latest call wins (replaced as a whole group).
- Write: records an event `next_moves_suggested` (actor=agent, `agentId`, `note` is the labels joined with ` · `, and the new field `moves` stores the list as is). It **does not change** the task revision or card status, and does not go to Ideas.
- Validation is the same as the other write tools: signature, revision, expiry, archived, Done/Cancelled rejected (`TASK_FINISHED`), an exact replay returns the original receipt, `REQUEST_REUSED`. Receipt action=`next_moves`. A label/prompt that is empty after trimming, too long, or more than 3 items is `INVALID_INPUT` (an empty list is also `INVALID_INPUT` before §9.4).
- CLI: `next-moves --request-file <snapshot> --moves '<JSON array>'` (`[{"label":"…","prompt":"…"}]`). HTTP API action `next_moves`.
- When to call (written into the skill): at the end of a stretch of work, before handing control back to the user, if there is a clear next step (validation, commit/push, continuing to the next stage, fixing a problem just found), call once; put in only the 1–3 the user is most likely to pick, with the most recommended first. When no user action is needed, do not call. It should still briefly describe the options in the reply body (the user may not be looking in Flowly). Do not use it to ask questions (ask with the provider's own question tool, and when there is none use `kind=question`, SESSION-QUESTION-SPEC §2.2), and do not use it to replace an idea. §9 changes "if there is a clear next step" into a rule tied to the delivery moment.

## 3. Validity ("this turn's" suggestions)

`openNextMoves(events, agentId)` (`shared/next-moves.ts`): this session's latest `next_moves_suggested` event with no `agent.turn_started` of this session after it; otherwise empty. That is, after the user sends the next message and a new turn starts, the old suggestions disappear automatically.

The client adds two more: when the session's `lastUserMessageAt` is later than the event time (a fallback when lifecycle events are missing) it is not shown; a group that was closed (×) locally (by event id) is no longer shown until a new group appears.

The activity timeline does not show `next_moves_suggested` (it is a session-level hint, not a card change); the flow log records it as usual (without `moves`). Rule A1r (the "only replied thanks" fallback to In review) does not count this event as a work report.

## 4. UI

Position: right above the input box of the Flowly session view (the same position as the question/approval form, after it).

Display condition: there are valid suggestions, the session is not running (`running`/`initializing`), there is no pending question/approval, and the user can write to that session.

Style: one row, a small `Sparkles` icon on the left, followed by at most 3 capsule buttons (truncated to one line, horizontally scrollable, no wrapping, not pushing the input box taller), and a × to close at the end of the row. On appearing it uses the shared `Enter` transition (following reduced motion). The same component on phone and desktop, with touch height kept tappable on phones.

Tapping a suggestion:
- Input box empty: fill in its `prompt`.
- Input box already has text: append the `prompt` after the existing text with a blank line (without overwriting what the user has typed).
- Then focus the input box (on native, remount the input as an "external rewrite" and focus it, without breaking IME; on web, change the controlled value directly). **Not sent**. The suggestion row stays until the user sends (a new turn starts) or closes it.
- Accessibility: the button name "Suggested next step: {label}", the hint "Fills the message box. Nothing is sent until you send it."

## 5. Onboarding

- The welcome page feature list gains an item "Suggested next steps".
- A new one-time tip `next-move`: appears when some card in the current project has valid suggestions, with the copy "When an agent finishes a turn, its suggested next steps sit above the message box. Tap one to fill it in; nothing is sent until you press Send." Its priority is before first-idea (it waits on the user more directly than an idea).
- Add a sentence after "Needs-you reminders" in the README Highlights, and add the new tool to the agent tool list.

## 6. Acceptance

- `server/agent-service.test.ts`: the event is written with `moves`, no revision change; a second call in the same turn takes the latest; replay; empty/too long/more than 3 items rejected; a Done card rejected.
- `shared/next-moves.test.ts`: invalid after a new turn starts, takes the latest group, looks only at this session, the pre-fill concatenation rule.
- `server/progress-rules.test.ts`: a turn with only next moves still falls back per A1r.
- `server/tool-server.test.ts`: the tool list contains `flowly_suggest_next_moves`.
- `client/onboarding-logic.test.ts`: the `next-move` tip rule and priority.
- Skill text (`server/skill-source.ts` identical to `skills/flowly/SKILL.md`; `server/tool-server.test.ts` compares them verbatim).
- The acceptance of §9 (delivery-time reminder) is in §9.9.
- Manual/Luna: after a real session calls the tool, the suggestions appear above the input box; tapping only pre-fills and does not send, and can be edited; with existing text it appends; after sending the suggestions disappear; after closing they are no longer shown; the phone compact layout works.

## 7. "Move to Done" suggestion (design, pending implementation)

### 7.1 Goal and boundary

After a task is done, committed and pushed, the agent's most natural next step is "put the card in Done". But Done is the **user's decision** (`allowedStatuses` does not include done, and the agent cannot move it itself). So it is not a pre-filled message but an **action-type suggestion**: the agent only proposes, and the card moves only when the user taps; the tap itself is the user's decision.

Not done: the agent moving the card to Done directly; any automatic move apart from the tap; Flowly judging by itself that "it was pushed" (the git state is judged by the agent, see 7.5).

### 7.2 Data contract

`NextMove` gains an optional field `moveTo: "done"` (an enum reserved, and only `done` is allowed now).

- An ordinary suggestion: `{label, prompt}`, behavior unchanged.
- An action suggestion: `{label, moveTo:"done"}`, with `prompt` omittable (omitted means nothing is pre-filled; if given it is ignored).
- Validation (`nextMovesInputSchema` and `nextMoveSchema`, with `prompt` made optional, while a non-action suggestion must still have a non-empty `prompt`): at most 1 action suggestion in a group; action and ordinary suggestions can be mixed, with the total still 1–3; an unknown `moveTo` is `INVALID_INPUT`.
- The `moves` of the event `next_moves_suggested` stores the new field as is; the validity, replay, Done/Cancelled rejection and revision rules are unchanged. An old event has no such field and works as usual.
- CLI: `--moves '[{"label":"Move to Done","moveTo":"done"}]'`.

### 7.3 UI

- The capsule of an action suggestion gets a `Check` icon in front and a success-color border, to tell it apart from message capsules; it stays on the same row, keeping the limit of 3 and horizontal scrolling.
- The display condition adds to §4: the card is currently not in Done/Cancelled (once done the capsule is hidden), and the user has permission to move the card.
- Tap:
  1. Do not touch the input box content, send no message.
  2. Take the same move path as dragging to Done (`rpc.moveTask`), then enter `askWrapup`: when *Auto wrap up* is off it pops up "Wrap up (archive the sessions and the own workspace)?", and when on the daemon handles it, with the rules unchanged (`docs/MULTITASK-SPEC.md`).
  3. On success use the native toast "Moved to Done"; on failure (revision stale and so on) use the existing error hint, the suggestion row is kept, and the user can retry.
  4. After a successful move the card is already Done and that capsule disappears naturally; the other message suggestions are kept until the turn ends or they are closed.
- No extra confirmation dialog: tapping a button labeled "Move to Done" is already a clear intent; moving out of Done can be restored (`WORKSPACE-RESTORE-SPEC.md`).
- Accessibility: the button name "Suggested next step: {label}", the hint "Moves this card to Done." (a message-type one still uses the original hint).
- Implementation points: `session-preview.tsx` gains an `onMoveToDone` prop, provided by `board.tsx` (reusing `reorder` + `askWrapup`, with no new RPC); `NextMoves` renders by branching on `move.moveTo` and calls `onPick` / `onAction`; the passed callbacks use `useStableCallback`, keeping `React.memo`.

### 7.4 Effect on other rules

- Rule A1r (the "only replied thanks" fallback to In review), the activity timeline and the flow log: unchanged.
- "An agent cannot set Done" is unchanged: the tool only proposes a suggestion, the status change is triggered by the user's tap, and the event records actor=human.

### 7.5 Skill text (`server/skill-source.ts` synced with `skills/paseo-ultra-kanban/SKILL.md`)

After the next moves item add: when the whole card's work is done, it has been delivered to In review, the changes are committed and pushed (or confirmed to need no commit), and there are no remaining issues, a suggestion with `moveTo:"done"` may be added to moves (label in the user's language, such as "Move to Done"), usually placed in the next turn after "commit and push", or alongside other wrap-up items; when there are uncommitted/unpushed changes, unverified items or questions awaiting the user's decision, do not add it. At most one per group.

### 7.6 Onboarding

- The welcome page's "Suggested next steps" item gains half a sentence: "…including moving the card to Done once the work is pushed."
- The existing `next-move` tip copy gains a sentence "Some steps move the card, like Done.", and no new tip id is added (so it is not popped up again for everyone). The README Highlights are synced. All new copy goes into all language packs.

### 7.7 Acceptance

- `shared/next-moves.test.ts`: an action suggestion becomes invalid with the validity period; when the card is already Done the action suggestion is filtered out.
- `server/agent-service.test.ts`: `moveTo:"done"` with no prompt is accepted; two action suggestions in a group, an unknown `moveTo`, and a non-action suggestion missing prompt are all `INVALID_INPUT`; the event stores `moveTo`; no revision change.
- `server/tool-server.test.ts`: the tool schema contains `moveTo`.
- `client/onboarding-logic.test.ts`: no new tip, existing rules do not regress.
- Manual/Luna: after the agent commits and pushes, the suggestion "Move to Done" appears; tapping does not change the input box, the card goes into Done and pops up/automatically wraps up per the settings; on a revision conflict it reports an error and the suggestion is kept; an already-Done card does not show it; the phone compact layout is tappable.

## 8. Next-step suggestions submitted with the delivery call (implemented, verified in a real desktop session)

> Implemented on 2026-10-20: `shared/tools.ts` (the shared 0–3 suggestion schema, `nextMoves` added to status/progress, the standalone tool's lower bound also 0), `server/agent-service.ts` (the Done guard, the second event in the same transaction), `server/cli-source.ts` (`--moves` / `--no-moves`), `shared/next-moves.ts` (`isNoMoves`, `noMovesNote`), `client/drawer.tsx` ("Suggested no next moves" in the activity), the two texts of tool descriptions and skill, the two READMEs, 1 entry in each of the 9 language packs. On 2026-10-20 it was verified with two `codex/gpt-6-luna` full-access sessions on a Tinylink temporary card (MCP and pure CLI without MCP: with suggestions the capsule appears, `[]`/`--no-moves` gives no capsule and a line in the activity, and the Done guard was rejected in the real environment), see [verification/next-moves-delivery.md](verification/next-moves-delivery.md); phone/compact layout and the coverage after launch are not verified. §9 (delivery-time reminder) is not implemented yet, see §9.11.

### 8.1 Assessment

**The problem holds, the approach is feasible, implement it by card, with two further adjustments (8.2). The missing-hint is not in this section but is handled by §9 (8.9).**

Basis (`~/.paseo/plugin-data/flowly/board.json`, since 2026-10-19, counted per "one turn of a session", agent events, 171 turns in total):

| How this turn ended | Turns | Of which with next-step suggestions |
|---|---|---|
| Delivered to In review (`status in_review`) | 89 | 48 (54%) |
| `question` / `result` | 8 / 4 | 4 / 4 |
| Other status switches, `progress` only | 22 / 7 | 3 / 1 |
| No status/progress call at all | 41 | 2 |

- Only about half of the delivery turns carry suggestions, and unevenly: one session carried them in all 7 deliveries, while two other sessions had only 2 in 22 deliveries together. From this distribution, whether a suggestion appears looks more like whether the agent remembers the second call than whether there is a next step (this is inference, as the board data has no record of the agent's thoughts). The statistics basis of §9.1 is slightly wider (counting an in_review written by the system or a person too), and the conclusion is consistent: about half of the delivery turns have no suggestion.
- The three kinds of turn, delivery, question and result (101 turns, 59%), end by calling `flowly_update_status` / `flowly_report_progress` anyway. Putting the field on these two calls can cover these 101 turns; currently only 56 of these turns (48+4+4) have suggestions.
- **Be clear about what is not covered**: 41 turns (24%) called no Flowly write tool at all (pure conversation turns), and this approach is ineffective for them and not meant to handle them (such turns mostly need no suggestion, and have no call to attach to). Acceptance is measured by the "coverage of delivery/question/result turns", not by all turns.
- The scenario in the card where "after an MCP reconnect the wrap-up degraded into a single status command" shows that the CLI and MCP must be supported equally (8.4).

**Considered and not adopted:**
- Making `nextMoves` required on `in_review`: old sessions that are still running (old skill, old CLI snapshot) would fail to deliver, and it would force filler suggestions like "continue". An optional field + an explicit `[]` has the same visibility and does not make delivery fail.
- The daemon writing "no suggestion" on the agent's behalf when a turn ends: it cannot be distinguished from "not passed", wiping out the purpose of making "the agent's choice visible".
- A new merged "end turn" tool: one more tool to remember, with the same failure mode.
- Filling in suggestions with the summarizer's one-line `next`: it opens one more child session each turn, exists only when automatic summary is on, and one line is not an executable prompt.

### 8.2 Data contract

- `statusInputSchema` and `progressInputSchema` gain an optional field `nextMoves`, whose elements are exactly the same as the `moves` of `flowly_suggest_next_moves` (label 1–60, prompt 1–2000, `moveTo:"done"` with no prompt, at most 1 `moveTo` in a group, at most 3 items). **The lower bound is the same in all three places, 0**: the standalone tool also accepts `[]` (§9.4, §9.11 point 1: after a reminder the agent's only remedy is to call it). In implementation, extract a shared element schema and validation function, referenced from three places, not copied; the existing test "the standalone tool rejects `[]`" is changed accordingly to accept.
- Three kinds of value:
  - **Not passed**: nothing is recorded, behavior exactly the same as today (the suggestions from earlier in this turn are kept).
  - **`[]`**: an explicit "nothing for the user to do this turn".
  - **1–3 items**: the same suggestions as the standalone tool.
- `nextMoves` can be used on all `kind` values of `report_progress` (`progress` accepts it too). The tool description and skill only ask to pass it at delivery, question, block and result. **My decision**: do not reject on `kind=progress`, because the daemon cannot judge whether this turn is over, and rejecting would make the whole report fail; the cost is that a mid-way `progress` with `[]` clears the earlier suggestions of this turn, consistent with "a later one in the same turn replaces an earlier one", stated in the description.
- **Done guard** (the "same guard" the card mentions):
  - Kept: at most 1 `moveTo` in a group, a non-action suggestion must have a prompt, an unknown `moveTo` is `INVALID_INPUT`, a Done/Cancelled card is `TASK_FINISHED`.
  - **New, only for the merged call**: `nextMoves` carrying `moveTo:"done"` is accepted only when the card is in In review after this call (`status in_review`, or `report_progress` when the card is already in In review); otherwise `INVALID_INPUT` ("moveTo done is only offered with a delivery to In review"), and the whole call writes nothing. This turns "already delivered to In review" in the skill into a mechanical check. The standalone tool does not get this, to avoid changing the behavior of existing calls.
  - Not done: judging "committed and pushed" in the daemon (see 7.1, still the agent's judgment).
  - 2026-10-29: Committed is also a delivery status, and `moveTo:"done"` is likewise accepted with `status committed` ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §3).
  - 2026-10-29: Integrated is likewise a delivery status, and `moveTo:"done"` is accepted with `status integrated` ([INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md) §3).

### 8.3 Write semantics

- In the same transaction, after the main event (`status_changed` or `progress_reported`), write one more `next_moves_suggested` (actor=agent, the same `agentId`, `moves` as is, `note` is the labels joined with ` · `; for `[]` the `note` is `No next steps needed`, the same as §9.4). The main event comes first, so in the activity one first sees "changed status / reported", then "no next steps".
- One receipt per call: `action` is still `status` / `progress`, and `eventId` points to the main event. A receipt replay returns the original receipt and does not write a second suggestion event; `payloadHash` includes `nextMoves`, and the same request ID with a different `nextMoves` is `REQUEST_REUSED`.
- Any rejection writes no suggestion: `WORKPAD_OPEN`, `REVISION_CONFLICT`, the Done guard and so on. An error thrown inside the transaction does not persist as a whole (`store.transaction` reloads the board each time, and an error discards it), so there is no "the status changed but the suggestion was not written". The skill says explicitly: after a rejection, resend with the same `nextMoves`.
- Validity is unchanged and `openNextMoves` needs no change: it already treats the latest event with empty `moves` as "none" (`shared/next-moves.ts`), so `[]` naturally replaces the earlier suggestions of this turn and no capsule appears. When the standalone tool and the merged call are mixed, the last one in the same turn wins.
- No task revision change (the revision change of the status switch itself is as before).

### 8.4 CLI

- `status <state> --note … [--moves '<JSON array>' | --no-moves]`, `note [--kind …] --note … [--moves '<JSON array>' | --no-moves]`.
- `--no-moves` is equivalent to `nextMoves: []`; `--moves` must be a JSON array (it can be `[]`); giving `--moves` and `--no-moves` together, or using `--no-moves` on `next-moves`/other commands, both report an error on the client. The `next-moves` command is unchanged (`--moves '[]'` is now accepted too, §9.4).
- `cli-source.ts`: `allowed` adds `no-moves`, `booleanFlags` adds it; the existing check "`--moves` can only be used with next-moves" changes to allow `status`/`note`/`next-moves`. The command description at the end of the skill and the CLI usage string are synced.
- MCP and CLI go through the same `write(identity, "status"|"progress", input)`, with no second set of logic.

### 8.5 UI

- The capsule row is unchanged: shown when the session is idle after delivery.
- **Activity timeline**: `next_moves_suggested` is still not shown for non-empty suggestions, with the **exception** of the one whose `moves` is empty (explicitly no suggestion), shown as "{agent} suggested no next moves" (time as usual; this line no longer shows `note`, to avoid repeating the text). This **replaces** the sentence in §9.4 "the activity timeline (does not show this event)": the card requires the agent's "none" choice to be visible in the activity. The judgment function is in `shared/next-moves.ts` (`isNoMoves(event)`), shared by the timeline filter and the text, and the unit test tests it directly. The new string "Suggested no next moves" is added to all language packs.
- The flow log records as usual; a `next_moves_suggested` with empty `moves` (`note` is `No next steps needed`) is an explicit no-suggestion, from which the coverage statistics can tell "suggestion / none / not passed".
- The same row on phone and desktop, with no new layout.

### 8.6 Copy

Tool descriptions (`server/tool-server.ts`):
- `flowly_update_status` appends: "When you deliver (in_review), pass nextMoves: the 1-3 messages the user is most likely to send you next (same items as flowly_suggest_next_moves; a moveTo=\"done\" move is only accepted together with in_review), or [] when nothing needs the user. Leave it out on mid-work stage changes. A refused call records nothing: resend it with the same nextMoves."
- `flowly_report_progress` appends: "When you ask (kind=question; the moves are the likely answers), report a blocker or give a result, pass nextMoves (or [] when nothing needs the user)."
- `flowly_suggest_next_moves` prepends: "For updates in the middle of a turn, or when your delivery call had none; when you deliver or ask, pass nextMoves on flowly_update_status / flowly_report_progress instead."

Skill (`server/skill-source.ts` and `skills/flowly/SKILL.md` verbatim identical, `tool-server.test.ts` already compares the two): the skill is changed only once, merged with §9 (§9.11 point 3). The target semantics of this half of §8, replacing the item that begins with "When you end a turn and there are clear next steps": in a turn of delivery (in_review), question (kind=question) or reporting a result (kind=result), carry next moves in the call that ends the turn — pass them to `flowly_update_status` for delivery, and to `flowly_report_progress` for a question or a result report; the content is the 1–3 messages the user is most likely to send you next (when asking, the likely answers), with the most recommended first, the label in the user's language and the prompt written as the user's instruction to you; when nothing needs the user pass `nextMoves: []` (CLI `--no-moves`), and do not just skip it; `flowly_suggest_next_moves` is for updates in the middle of a turn, or as a remedy when the delivery call did not carry them; a rejected call is not recorded, so when resending carry the same `nextMoves`. The validity, "still briefly describe the options in the reply", the condition for `moveTo:"done"` (and noting that it is accepted only with a delivery to `in_review`), and "ask with `kind=question`, divergent work with `flowly_propose_idea`" are all kept. The two sentences about `reminders` and ideas in §9 are added separately. The last command description of the skill adds `--moves`/`--no-moves`. The `description` preamble is unchanged.

### 8.7 Effect on other rules

- A1r (the "only replied thanks" fallback): the main event of a merged call is the agent's work report and will not be rolled back; a turn with only a suggestion event still falls back per A1r. The logic is not changed, and a two-event case is added.
- "Needs you", attention, session read: unchanged (the suggestion event is the same action as today).
- Onboarding: no tour entry or new tip is added (the only visible change is a line "suggested no next moves" in the activity, and the user already learned about suggestions through the `next-move` tip). The two READMEs add a sentence on the agent tool line, "`flowly_update_status` / `flowly_report_progress` can carry `nextMoves`". The delivery note states this judgment.
- Tool list size: each of the two tools gets one more suggestion element schema, estimated at a few hundred more tokens; at implementation measure with `tools/list`, and if it is clearly too large shorten the field descriptions (put the description on the shared schema, not repeated).

### 8.8 Compatibility and rollout

- Purely additive: old skills, old CLI snapshots and still-running sessions work as usual; the new field takes effect only when passed. An old version reading an event with `moves: []` is also legal (the schema already allowed 0–3).
- On plugin reload `ToolServer.initialize()` rewrites the runtime `flowly.mjs` and `SKILL.md`; an already connected MCP session usually has to reconnect to see the new tool schema, and until then can pass only through the CLI, so the CLI must be fully supported (8.4). The landing order is in §9.11: first §8, then §9, preferably in the same session.
- At implementation the workspace's `client/drawer.tsx`, `server/agent-service.ts`, `server/skill-source.ts`, `shared/tools.ts` and `skills/flowly/SKILL.md` already had uncommitted changes from other cards; when committing stage only this card's hunks (`git add -p`).

### 8.9 Missing-hint

The field is optional, and not passing it is still silent; what plugs this hole is §9's `reminders` (after delivery, question and result, if this turn has no next moves event yet, the result carries a reminder sentence), not this section. This section only needs to guarantee two things: (1) the merged call writes the suggestion event in the same transaction, so a delivery that carries `nextMoves` (including `[]`) will not receive the "no suggestion" reminder (§9.3); (2) the "call flowly_suggest_next_moves" in the reminder text of §9.6 still holds after this section lands (the standalone tool is kept), and needs no change.

### 8.10 Acceptance

- `server/agent-service.test.ts`:
  1. `status in_review` + `nextMoves`: one `status_changed`, one `next_moves_suggested` (order, `agentId`, `moves`, `note`), task revision increases only once, receipt `action=status`, `openNextMoves` returns that group.
  2. `nextMoves: []`: writes `moves: []`, `note` is `No next steps needed`; `openNextMoves` is `null`; the earlier non-empty suggestions of this turn are replaced with none.
  3. Not passed: no suggestion event written, the earlier suggestions are kept.
  4. All of `question`/`blocker`/`result`/`progress` of `report_progress` can carry it; illegal elements (empty label, too long, 4 items, missing prompt, unknown `moveTo`) are `INVALID_INPUT` and write no status.
  5. Done guard: `in_review` + `moveTo:"done"` passes; `development` + `moveTo:"done"` is `INVALID_INPUT`, with status unchanged, no event, no receipt; two `moveTo` in a group rejected; a Done/Cancelled card is `TASK_FINISHED`.
  6. A replay returns the original receipt and there is only one suggestion event; the same request with a different `nextMoves` is `REQUEST_REUSED`.
  7. On a `WORKPAD_OPEN` rejection no suggestion is written; after resending with `acknowledgeOpen` it is written.
  8. The standalone `next_moves` cases keep passing, with the only change being that "`[]` is rejected" becomes accepted and recorded (§9.4); standalone and merged mixed use takes the last one.
- `shared/next-moves.test.ts`: `[]` after a non-empty one replaces it with none; `isNoMoves`; a delivery carrying `nextMoves` (including `[]`) does not trigger the reminder of §9 (`needsNextMoves`, after both cards have landed).
- `server/progress-rules.test.ts`: a turn with a main event + a suggestion event is not rolled back; a turn with only a suggestion event is still rolled back.
- `server/tool-server.test.ts`: the schemas of both tools contain `nextMoves` (can be an empty array); CLI: `status --moves`, `status --no-moves`, `note --kind question --moves`; `--moves` and `--no-moves` used together, a non-array `--moves`, and `--no-moves` used on `next-moves` all fail; the two skill files are identical.
- Client: the timeline filter lets through only the explicit no-suggestion one; the new string is in all language packs (the i18n check of `npm test`).
- The reminder cases of §9 are handled by §9.9; after the two cards merge add one: when the delivery call carries `nextMoves` (including `[]`) the result has no `reminders`.
- Manual/Luna: a real session's `status in_review` with suggestions shows the capsule; after `[]` there is no capsule and one line "suggested no next moves" in the activity; the CLI path likewise; sessions with the old skill are unaffected.
- After launch recompute with the same script: among delivery/question/result turns, the share carrying suggestions (including an explicit `[]`), target ≥ 90%. Baseline 56/101 (about 55%).
- First `npm run typecheck`, then `npm test`, then `paseo plugin install "$PWD" --id flowly` / `paseo plugin reload flowly`.

## 9. Delivery-time reminder (implemented, 2026-10-20)

Card: "Delivery-time reminders for missing next moves and ideas, plus firmer skill wording" (2026-10-20, a follow-up to the Sidebar UI/UX adjustment). The same mechanism also reminds about Ideas, see [IDEAS-SPEC](IDEAS-SPEC.md) §4.1.

### 9.1 Goal and boundary

In the skill, "call once when there is a clear next step" is an **optional second call**, which the agent often ignores after finishing the work. Board data (`board.json` events, counted by "the same session, the same card, one turn starting from `agent.turn_started`"):

| Date | Turns | Turns with next moves | Turns containing a delivery-type write (→ in_review, `question`, `result`) | Of which with no next moves |
| --- | --- | --- | --- | --- |
| 2026-10-19 | 145 | 60 | 102 | 47 |
| 2026-10-20 (as of design time) | 26 | 2 | 11 | 9 |

Approach: after a delivery-type write tool that the agent **was going to call anyway** succeeds, attach a plain-text reminder to the result. At that moment the agent is still inside the turn and can still call tools, and the cost is just one line in the result.

Not done:
- No blocking, no error, no new error code, no change to write semantics (unlike `WORKPAD_OPEN`); the reminder is only text, and the write succeeds as usual.
- Turns with no delivery-type call at all are not covered (in the table above: 43 on 10-19 and 15 on 10-20). Only skill text can influence those turns; whether a coverage metric is worth adding is in §9.10.
- After a turn ends, the daemon does not send messages or call tools on the agent's behalf (AGENTS.md: an ordinary follow-up sends only the user's text).

### 9.2 Trigger

Judged after a write succeeds (including the replay of §9.5), and when the card is still writable (not archived, not in Done/Cancelled):

| Call | next moves reminder | ideas reminder |
| --- | --- | --- |
| `flowly_update_status` → `in_review` | yes | yes |
| `flowly_update_status` → `blocked` (when the project has that lane enabled) | yes | no |
| `flowly_report_progress` `kind=question` | yes (with the "likely answers" wording) | no |
| `flowly_report_progress` `kind=result` | yes | no |
| Others: switching to design/development/test, `kind=progress`/`blocker`, other tools | no | no |

2026-10-21: when a card lacks type, tags or workpad, the result of **every** write tool also carries a setup reminder (placed after the two reminders of this table), see [CARD-SETUP-SPEC](CARD-SETUP-SPEC.md) §3.3.

`in_review` does not require the status to actually change: when the card is already in In review, calling again is judged the same way (it is still a delivery call). A failed write (including `WORKPAD_OPEN`, `REVISION_CONFLICT`) carries no reminder, because nothing was written.

### 9.3 Conditions

- **next moves**: this session on this card has no `next_moves_suggested` event after the most recent `agent.turn_started`. **An empty-list event (§9.4) counts too**, since it means the agent has decided this turn needs no user action. If this session has no `agent.turn_started` on this card (lifecycle events missing), all retained events are treated as the same turn; this only under-reminds, never over-reminds. The judgment is the pure function `needsNextMoves(events, taskId, agentId)` (in `shared/next-moves.ts`, alongside `openNextMoves`). Note that `board.events` contains all cards and must be filtered by `taskId`, which differs from the client that receives only this card's events.
- **ideas**: the reminder is only on `in_review`; it requires the Ideas setting to be on, and this session to have **never** proposed an idea on this card. The source is `board.ideas` (matching `taskId` + `agentId`, including dismissed/accepted ones), **not** the `idea_proposed` events: events keep only the latest 100 per card (`BoardStore.event`), and on a busy card old `idea_proposed` events get pruned, and the reminder would be falsely raised. The trade-off: this is a "card-level" judgment, not "turn-level" — once the session has proposed one on this card, later deliveries (a delivery after rework) no longer receive the ideas reminder (the skill still says "at each delivery"). It is chosen so that a card where "a conscious decision to propose 0" was made is not reminded repeatedly every turn; to change it to turn-level, just switch the source to the `idea_proposed` event plus an `agent.turn_started` boundary.
- **Quiet path**: when Ideas is off (`ideasOn()` is false) ideas are not mentioned, and no other data is read for it; the behavior of paths such as the workpad off, `IDEAS_DISABLED`, `ARTIFACTS_DISABLED` is unchanged, and the reminder text does not mention them.
- The computation happens **inside the write transaction, after the events are written**, reading the same `board`. This way when §8 (`update_status`/`report_progress` carrying `nextMoves` itself) writes the moves event in the same transaction, this condition needs no change: a delivery call that passed `nextMoves` (including `[]`) has no reminder, and the reminder appears only when neither was done.
- A sub-agent (a Paseo native child session, carrying the `paseo.parent-agent-id` label) is managed by the main agent, and its next moves have no user to tap them (the same as the attention decision of SUBAGENTS-SPEC). Verified result: a session holds a Flowly tool identity only after the plugin has prepared it (card launch or explicit join) (`ToolSecrets.managedIdentity`; `tool-server.test.ts` "session_open injection is limited to Kanban-managed sessions"), and a child session by default has none and cannot call these tools, so no special handling is needed; a child session that has been prepared is treated like any other session.

### 9.4 Empty list: an explicit "not needed this turn"

The reminder text in the card says "…or [] if nothing needs them", but currently `moves` has at least 1 item and an empty list is `INVALID_INPUT`. Without opening it up there is no exit for "a conscious choice not to suggest", and every delivery with nothing to suggest would be reminded repeatedly. Therefore:

- `moves` allows 0–3 items (the `.min(1)` of `nextMovesInputSchema` becomes `.min(0)`; the description becomes "0-3 next steps … pass [] when nothing needs the user this turn").
- An empty list records the `next_moves_suggested` event as usual (`moves: []`, `note` is `No next steps needed`); no task revision or status change, and it does not go to Ideas. The receipt action is still `next_moves`; replay, signature, expiry and `TASK_FINISHED` rules are unchanged.
- A later call in the same turn replaces the earlier one as a whole group: an empty list clears the earlier suggestions of this turn, and giving a non-empty list afterwards makes them appear again.
- The session view needs no change: `openNextMoves` returns `null` for an empty `moves`, which the session view's `moves.length > 0` check already covers; `hasOpenNextMoves` (the `next-move` tip) and rule A1r (`next_moves_suggested` does not count as a work report) are both unaffected; the activity timeline still does not show non-empty suggestions, and only additionally shows the empty-list one (§8.5). The existing test "`bad([])` is rejected" is to be changed to "accepted and recorded".
- CLI: `next-moves --moves '[]'` can already pass (a non-empty string); only the usage text is updated to "0-3".

### 9.5 Result shape and position

- `toolResultSchema` gains an optional `reminders: string[]` (English, agent-facing). When there is no reminder the key does not appear, and the results of other calls are completely unchanged.
- The key order is fixed as `receipt, replayed, reminders, …, current`: `current` is the context of the whole card (several KB), and the reminder must come before it so the agent does not miss it. The MCP text content and `structuredContent` come from the same source; the CLI already formats and prints the whole result, so the reminder naturally follows the receipt, and **no** separate stderr output is needed (stdout stays parseable JSON).
- A replay (`replayed: true`) also carries the reminder, judged against the **current** board: a replay is usually because the first response was lost, and the agent happened never to have seen the reminder. When the card is already Done/Cancelled or archived (a replay still returns the receipt) no reminder is carried.

### 9.6 Copy (English, agent-facing)

- next moves (in_review / blocked / result): `No next moves suggested this turn. Before you end the turn, call flowly_suggest_next_moves with the 1-3 messages the user is most likely to send you next (recommended first), or with moves=[] if nothing needs the user. This write already succeeded.`
- next moves (question): `No answers suggested for your question. If the user is likely to reply with one of a few options, call flowly_suggest_next_moves with those replies (1-3, recommended first) before you end the turn, or with moves=[] if the reply is free-form. This write already succeeded.`
- ideas (in_review): `You have proposed no ideas on this card. Consider 0-3 ideas (flowly_propose_idea) for worthwhile follow-ups you noticed: bugs, refactors, next features. Zero is fine; decide on purpose.`

When both appear at once, next moves comes first.

### 9.7 The relationship between `question` and next moves (a wording decision)

The skill currently has a sentence "Questions go through kind=question … not next moves". The card asks that a question turn also end with next moves. The two do not contradict, but the wording needs to be made clear: **the question itself still goes through `kind=question`**; next moves hold the **answers the user may send back** (such as "go with option A"), and tapping pre-fills the input box. The session view shows suggestions when there is no pending native question/approval, so an answer capsule coexisting with "Needs you" is no conflict. This is a wording choice of this design, and does not change the UI of §4.

2026-10-20 addition (SESSION-QUESTION-SPEC §2.2): when the provider has its own question tool the question goes through that tool, the options are right in the form, and next moves are not needed; the above rule applies only to the fallback question with `kind=question`.

### 9.8 Skill text (`server/skill-source.ts` synced with `skills/flowly/SKILL.md`)

- The next moves item (replacing "When you end a turn and there are clear next steps … call once"): every turn of **delivery (in_review), question (kind=question) or reporting a result (kind=result)** ends with `flowly_suggest_next_moves`: 1–3 messages the user is most likely to send you next (when asking, the likely answers; the question itself still goes through kind=question), with the most recommended first. Pass an empty list `[]` only when the user is truly not needed, and do not just skip it — the results of these writes will remind you. The rest of the original is kept (the label/prompt requirements, the expiry rule, still briefly describing in the body, the condition for `moveTo="done"`). The last sentence becomes: "The question itself goes through kind=question and divergent work through flowly_propose_idea; next moves are only messages for this session."
- Right after it add an item: if a write result carries `reminders`, that is a call missed in this turn; make it before ending the turn (or consciously do not). The write itself has already succeeded.
- The ideas item (see IDEAS-SPEC §4): change "usually when you deliver" to "at each delivery review what you noticed, propose at most 3; having nothing worth proposing can be 0, but decide consciously".
- The skill `description` in the first item is unchanged.

### 9.9 Acceptance

- `server/agent-service.test.ts`:
  - `in_review` with no moves and no ideas: `reminders` has both, with the key order before `current`.
  - Moves already sent this turn: only the ideas reminder remains; Ideas off: only the moves reminder remains; this session has already proposed an idea: only the moves reminder remains; both satisfied: the result has no `reminders` key.
  - Turn boundary: moves in the previous turn, reminded again after a new `agent.turn_started`; no reminder after sending moves within the new turn; another session's moves do not count.
  - Empty list: accepted and recorded, clears earlier suggestions, suppresses the reminder; after giving a non-empty list in the same turn it takes effect again.
  - Trigger matrix: `question`/`result` have a moves reminder (`question` with the answer wording); `progress`/`blocker`, design/development/test have none; `blocked` (in a project with that lane enabled) has only the moves reminder and no ideas.
  - A failure carries no reminder (`WORKPAD_OPEN`); a replay carries the reminder, and a replay after Done does not.
  - The existing "`bad([])` is rejected" becomes accepted.
- `shared/next-moves.test.ts`: the turn boundary of `needsNextMoves`, filtering by `taskId`/`agentId`, an empty-list event counting as decided, the degradation with no `turn_started`.
- `server/tool-server.test.ts`: the schema of `flowly_suggest_next_moves` allows an empty array; the result schema contains `reminders`; SKILL.md and `skillText` are verbatim identical (already exists).
- `typecheck`, full `npm test`.
- Manual (can be done together with Luna): when a real session delivers to In review the result has the reminder; after calling `moves=[]`, delivering again in the same turn no longer reminds.

### 9.10 Impact and follow-up

- Onboarding: unchanged. This is an agent-facing change, and all the user sees is more suggestion capsules and Ideas, which the existing `next-move` / `first-idea` tips already cover; the README needs no new selling point. The delivery note states this.
- All reminder text is agent-facing English and does not go into the language packs.
- The effect cannot be guaranteed: a reminder can only influence turns that have a delivery-type call. After launch, review the "share of delivery turns with moves" by the same basis; to make it routine, a coverage rule can be added later in Workflow Insights (already proposed as an idea).

### 9.11 Relationship with §8 (next moves submitted with the delivery call)

Status: §8 landed first (commit 96ac586): the `moves` lower bound is unified at 0 in three places, §8.9 has been changed to point to this section, and `isNoMoves` and `noMovesNote` already exist. Points 1 and 2 below are therefore already satisfied; point 3 (change the skill only once) is completed by the implementation of this section.

§8 is a design written in parallel by another card (the same spec, the same set of files), and so far has only the spec and no code. The two have the same goal and complementary mechanisms: §8 lets the agent **write it all at once** in the delivery call, and §9 reminds when it **did not**. Points to align:

1. **The standalone tool must accept `[]`.** §8.2 says "the standalone tool is still 1–3 items". The reminder of §9 happens **after** the delivery call, and the only way the agent can remedy is to call the standalone tool, and the reminder text says so, so `flowly_suggest_next_moves` must also allow `[]` (§9.4). At landing, that sentence of §8.2 becomes "the lower bound is the same in all three places, 0", and the shared element schema and array validation function remain only one copy.
2. **The `notice` of §8.9 is replaced by §9** (§8.9 was waiting for the user's confirmation anyway): the same mechanism, but using `reminders: string[]`, because it must also carry the ideas reminder; the trigger scope follows this card (in_review/blocked, question/result, not including `blocker`); a replay also carries the reminder (§9.5). The condition of §8.9 "`nextMoves` not passed and no suggestion this turn" is, in §9.3, "still no moves event after the events inside the transaction are written", which covers it automatically. §8.9 has been changed to a note pointing to this section, with no pending decision left.
3. **Change the skill only once.** Both places need to change the item "When you end a turn and there are clear next steps…". The merged semantics: a turn of delivery/question/reporting a result ends with next moves, preferably written in the `nextMoves` of the delivery call (§8), second with the standalone tool; when nothing needs the user pass `[]`; when a write result carries `reminders`, fill in. The wording is fixed once at implementation, and `skill-source.ts` and `SKILL.md` are synced.
4. **Landing order**: first §8, then §9; preferably in the same session, to avoid repeated conflicts in `server/agent-service.ts`, `shared/tools.ts`, `server/skill-source.ts`, `skills/flowly/SKILL.md`, `server/tool-server.ts`. These files in the workspace already had uncommitted changes from other cards, and when committing stage only this card's hunks.
5. **Shared success metric** with the basis of §8.10: among delivery/question/result turns, the share carrying suggestions (including an explicit `[]`), baseline about 55%, target ≥ 90%.

### 9.12 Implementation and checks (2026-10-20)

- Code: `shared/next-moves.ts` `needsNextMoves` (turn boundary, a pure function); `server/reminders.ts` (the three texts and `deliveryReminders`, the trigger matrix); `server/agent-service.ts` `write()` (computed inside the transaction after the events are written, and also computed on replay; the Ideas switch is read only on an `in_review` delivery; `remindersField` controls the key order); `shared/tools.ts` `toolResultSchema.reminders`; `server/skill-source.ts` and `skills/flowly/SKILL.md` (two rules plus one `reminders` note); `server/tool-server.ts` one sentence added to each of the two tools' descriptions. The CLI needs no change: it prints the whole result, and `reminders` follows the receipt right away.
- Passed: `npm run typecheck`; `npm test` (93 files passed, 711 cases passed, 13 files / 65 cases skipped as before); the new cases are in `server/agent-service.test.ts` (five: the default two, the various "already done" cases, the turn boundary, the trigger matrix, failure and finished cards), `shared/next-moves.test.ts` (`needsNextMoves`), `server/tool-server.test.ts` (MCP's `structuredContent.reminders` and the JSON text key order, the CLI output key order, the skill and tool description texts).
- Real machine (2026-10-20, `docs/verification/delivery-reminders.md`): 5 `codex/gpt-6-luna` full-access sessions delivered on Tinylink temporary cards. The results of both MCP and CLI carry `reminders` (key order `receipt, replayed, reminders, current`); when the session was allowed to respond (S3 passing `[]` via MCP, S4 via CLI `next-moves`) the second delivery no longer carried the next moves reminder; the sessions whose delivery call carried `[]` itself (S1, S5) also had no such reminder; the ideas reminder appeared in all 9 in_review deliveries, and no session proposed an idea. **What was not proven**: when a session was told "do not pass next moves and end the turn" (S2) it does not respond to the reminder (the user's instruction takes priority), so this round only proves the reminder is delivered and actionable, and is not a compliance rate; the compliance rate is seen in the Agent habits of Insights. The phone layout, non-English, and the real-machine runs of `question`/`result` and replay were not done.
- The effect metric after launch: the Agent habits of Insights (WORKFLOW-INSIGHTS-SPEC §12) already count by the flow log the share of next moves and ideas in delivery/result turns, and mark the models/sessions that still have no next moves after 10 or more deliveries; use it for the review, and no separate coverage rule is needed. Note that `board.json` keeps only the latest 100 events per card, so the statistics at the start of this section can serve only as an order-of-magnitude reference, and the flow log is authoritative.
