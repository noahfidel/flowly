# Summary, Next moves and Ideas on the native session pane

Status: design awaiting review, not implemented. 2026-10-20 scope and two trade-offs (§3) confirmed with the user. Card task `731e66bf`.

## 1. Purpose

When the user opens a session in Flowly, they can see the Progress summary, the next-step suggestions above the input box, and this card's Ideas; when the same session is opened in Paseo's native session pane, none of these is visible, only a **Task · title** chip (SESSION-CHIP-SPEC).

The goal is a **consistent experience**: for a session under the same project, these three distinctive features can be seen and used both inside Flowly and in the native pane.

## 2. Scope and phases

This spec does only **P1** (user decision 2026-10-20). Later phases are evaluation notes only and are not implemented now.

| Phase | Sessions covered | What to do | Difficulty |
| --- | --- | --- | --- |
| **P1 (this spec)** | Flowly-managed sessions: started from a card, or joined through "Send Kanban work instructions" (they have tool credentials, listed by `sessions.managed`) | The data all exists already; only the display and actions on the native pane are missing | Medium; mostly client, with one timeline append on the server |
| P2 | Native sessions in a card's workspace that have not joined the card | A one-click "Add to this card" on the native pane (reusing `tools.prepare-existing`), then the same as P1 | Low–medium |
| P3 | Sessions inside a Flowly project that belong to no card (such as the project's main workspace) | No card to attach to: summary/ideas/next moves are stored per session instead; the agent needs session-level credentials and instructions | Medium–high |
| P4 | Sessions in no Flowly project | The same as P3, and ideas have no project inbox to land in | High |

Suggested direction for P3/P4 (undecided, for later evaluation): do not depend on the agent calling tools; instead have the summarizer that runs after each turn also extract next moves and ideas in the same call, independent of the provider and with no tool injection; the cost is one more model call per session per turn, so there must be a switch.

Not done:

- Changing how summary / next moves / ideas are produced, their data format or the agent tools.
- The existing displays inside Flowly (the sidebar Progress, the Ideas block, the Ideas page, the suggestion row above the input box) are not removed and their behavior is not changed.
- Showing the new chips for sessions beyond P1 (the Task chip stays as it is, still shown for all sessions in a card's workspace).

## 3. User decisions

- Next moves and Ideas are **two separate composer chips** on the native pane.
- Summary is shown through the **native timeline**.
- Only P1 is covered.
- The Flowly session view gets no Progress card, and shows it only in the native timeline (§5.4, added after the 2026-10-20 implementation).
- **This feature does not affect Flowly's own behavior and styling at all, and targets only native sessions** (added after the 2026-10-20 implementation). Therefore: the × of the suggestion row inside Flowly is not shared with the native chip (§6.3); no one-time tip inside Flowly is added, and the welcome page copy is unchanged (§9); the writing of the summary and the display inside Flowly are not affected by the native row append (§5.1). The only new Flowly entry point is the `ideaId` board link opened by "Start a new task" of the native Ideas chip (§7.3), and without that parameter the board behavior is unchanged.
- The native timeline row of Summary is **best-effort display**: it is acceptable for old rows to disappear after a daemon restart, and they are not restored (§5.2).
- ~~On the native pane, clicking a next move: an editable text is shown in a popover and is sent only on Send~~ (2026-10-20 revision: clicking a suggestion prefills the Paseo input box by default, which can be changed to copy in settings, §6.4).

## 4. Platform capabilities and limits (SDK 0.11.2; the 0.12.0 client contract is the same)

| Capability | Use |
| --- | --- |
| `client.addComposerPill({id, workspaceId, agentId, button})`, `behavior.kind: "popover"` | The Ideas chip (the popover is anchored on the chip on wide screens; on compact layouts the host decides how it is presented) |
| `paseo.agents.ref(id).timeline.append({type:"plugin", kind, version, data})` (daemon side) | Append the summary as a plugin entry to that session's native timeline |
| `client.addTimelineRenderer({kind, version, schema, Component})` | Render the Progress row and the Next moves card |

Limits:

- **The SDK has no interface for prefilling text into the native input box.** Prefilling can only be done, like prompt-suggestions, by finding the input box through the DOM on web/desktop (`textarea[data-composer-input]`, with its session identified through the `agentId` prop of the React fiber) and then setting the value; this depends on Paseo's internal structure and is not a plugin API, so feature detection is required, and on failure it falls back to copy (§6.4).
- Paseo requires the timeline kind and row id to match `^[a-z][a-z0-9-]*$`, otherwise registration throws and the whole client plugin fails to load.

## 5. Summary: a native timeline entry

### 5.1 When to append (daemon, `server/summaries.ts`)

- After the summarizer writes a **new version** (`update=true` and parsing succeeded), append a plugin entry to the **board-managed session that triggered this run** (when single-flight coalescing, the session of the last turn).
- `update=false`, failure, timeout, error: do not append.
- When a manual Refresh produces a new version, append to the session Refresh selected (TASK-SUMMARY-SPEC §6).
- Checks before appending: the session is not archived; and since the end of the triggering turn there has been no new `agent.turn_started` for that session. If a new turn has started, **skip the append** (otherwise the entry would appear after the user's new message and read like a summary of the new message); the new version is still written to `summaries.json` as usual, and the sidebar shows it as usual. (This item is the designer's decision.)
- The append runs in the background (10 s timeout per step), and never blocks that card's later summary runs; a failure is only logged (without printing content), does not affect the summary write, and is not retried.
- When a card has several sessions, append only to the session that produced this progress; the other sessions' timelines do not repeat it.

### 5.2 Data contract

`id: "flowly-summary-<entryId>"` (one row per version; appending again with the same id replaces that row), `kind: "flowly-summary"`, `version: 1`, `data`:

```
{ taskId, workspaceId,        // for validating the "Open card" link
  entryId,                    // the id of this version in summaries.json
  state, target, recap, next, // exactly the same as that version, not truncated
  model, at }                 // generating model and time (ISO)
```

The entry carries all its content, and rendering needs no RPC. The `data` limit is 64 KiB (Paseo rejects larger), and the four fields are each ≤4000 characters (TASK-SUMMARY-SPEC §3), far below the limit.

**Lifecycle (Paseo docs, confirmed):** appended rows live in the daemon's in-memory timeline, and remain after scrolling, refetch and reconnect, but are **lost after a daemon restart** (measured: they are likewise lost after a session process reload, §5.5); when the plugin is missing, an "unavailable" placeholder is shown. `summaries.json` is still the only persistent source of the summary, and the sidebar Progress and History are not affected.

### 5.3 Rendering (`addTimelineRenderer`)

- The look is consistent with the sidebar Progress (sharing the box and body text of `ContentCard`): a small title row **above** the card, outside it (`AiMark` + "Progress", gray, medium weight, `font.sm`), and inside the card the `state` (emphasized), Target / Recap / Next, with a footer line: Show more / Show less on the left, and on the right "Updated 5m ago" (the model is not shown, user decision 2026-10-23; the sidebar Progress still shows it) and a small "Open card" button. **The two native cards have the same small title** (user decision 2026-10-21: keep Progress as it was, and align Next steps to it; putting the title and Open card in the card header was tried, and the user preferred the original): the small title is outside (`NativeCardHeading` in `client/native-card.tsx`). Next steps later also dropped the gray card background (see §6.3). Known cost: at phone width Progress's footer is crowded, the timestamp may wrap onto two lines, and the button may be cut to "Open ca…" (it was like this originally, and the user, once informed, still chose to keep it as is).
- **Collapsed to one line by default** (user decision 2026-11-11, the setting *Start progress rows collapsed*, host setting `native-session.progressCollapsed`, default on): in one line, in order, the `AiMark` + "Progress" small title, one sentence of the recap (`recapLine` in `client/summary-line.ts`: the first non-empty line of the recap with the leading list marker/number/heading marker and `**`, `__`, `*`, `_`, backticks removed, whitespace merged, taking the first sentence: `. ! ?` followed by whitespace or the end, or CJK `。！？`; truncated with "…" beyond 160 characters; then ellipsized to one line on screen), using the first sentence of the state when the recap is empty, then "Updated 5m ago" and Show more at the right end. The collapsed row is not a truncated card (the problem of 2026-10-29): it has no card box and no Open card. Show more swaps to the full card below (not truncated), and the footer's left side is Show less, which returns to this line. Expanding/collapsing is remembered only on this one mounted row and is not saved; on remount (refetch, reopen) it is collapsed again. When the setting is read only after the row mounted, the row follows the setting until the user has pressed Show more / Show less on this row.
  - When the setting is off it is the same as before: **expanded by default**, showing State, Target, Recap, Next in full (2026-10-29 user feedback: it used to collapse beyond about 5 lines, and almost every entry was truncated). Show less collapses to about 5 lines (104 pt) with a fade, and Show more expands again, with the rules of TASK-SUMMARY-SPEC §7 (animation, Reduce Motion, no playback on first measurement); when the content does not exceed about 5 lines no button appears. An expanded card is not first cut to 104 pt before the first measurement, so on row mount it does not first go short and then jump tall.
  - How the setting reaches this row: Paseo renders timeline rows outside Flowly's tree, and a row can only read client module state. As with `nextMoveTap`, the chip refresh (`client/session-link.ts`) reads `progressCollapsed` from `sessions.native-chips` (when the board changes or at most once a minute) and stores it in `client/native-chips.ts`; before the first read, or when an old daemon does not return the field, it is treated as on. So after the setting is changed, an already open session takes effect after at most about a minute.
  - Paseo renders timeline rows outside Flowly's component tree, and without a `MotionProvider` the animation hooks default to "reduce motion" and jump directly (2026-10-20 user feedback). The native timeline row, the Next moves card and the Ideas popover are all wrapped in `SharedMotionProvider`: all rows share one system Reduce Motion query and listener (`client/reduce-motion.ts`), and before the system answers they are treated as reduced motion.
- The small "Open card" button on the right of the header opens Flowly and locates that card's overview (reusing the Task chip's `openScreen("board", …)` path and validation).
- When schema validation fails the host handles it (it is not rendered); the renderer does not throw.

### 5.4 Not shown in the Flowly session view (user decision 2026-10-20)

The initial design had Flowly's own session view show the same entry at the same position. The user decided on 2026-10-20: **no Progress card under a session inside Flowly**. Flowly already has the sidebar Progress block (card-level, with History), and the session conversation does not repeat it. Therefore:

- `slimTimeline` in `shared/session-tail.ts` stays as is, and slims all plugin entries (including `flowly-summary`) down to just `{type:"plugin"}`, so Flowly's conversation view does not show them.
- The Summary row is shown only in Paseo's native timeline; the sidebar Progress block is unchanged.

### 5.5 Measured risk results (2026-10-20)

Measured with the temporary plugin `flowly-probe` by creating one `claude/claude-haiku-5-5` and one `codex/gpt-6-luna` session each in the Tinylink card workspace; after the test both sessions were hard-deleted, the plugin removed, and the temporary directory deleted.

| # | Risk | Result |
| --- | --- | --- |
| 1 | Whether plugin rows enter the agent's context | **No.** Neither agent saw the code words inside the row (PINEAPPLE-42 / MANGO-77) at all in the next turn. |
| 2 | Whether an append triggers attention / unread | **No.** After clearing attention first and then appending, `requiresAttention` is still false and `attentionReason` is null; only `updatedAt` is updated. Push notifications cannot be observed directly, but they depend on attention, so it is judged that they are not triggered. |
| 3 | Whether the plugin's daemon-side SDK can read plugin rows | **Yes.** Both `projected` and `canonical` of `timeline.refetch` return the row (with `id`, `kind`, `pluginId`, `data`), so `sessions.tail` could have carried it (§5.4 later decided not to show it inside Flowly). |
| 4 | Whether Claude / Codex both accept the append | **Both accept**, returning `{seq, epoch}`. |
| 5 | Whether it is kept after a session process reload | **Not kept.** After `paseo agent reload`, the timeline is rebuilt from provider history, rows appended before disappear, and rows appended after are normal. That is, besides a daemon restart, a session reload (and any case where the timeline is rebuilt from provider history) also loses old summary rows; it is still handled by the user's "best-effort display" decision, and not restored. |
| 6 | Whether the summarizer summarizes its own output again | The `timeline` of the `agent.turn_ended` hook **does contain** plugin rows (`plugin:probe` was observed). `turnText` takes only user/assistant/tool/error and ignores `plugin`, so it does not; a unit test locks this in. |

## 6. Next moves: a native timeline card (2026-10-20 revision)

The initial design was a **Next** chip on the composer + a popover. After looking at the [prompt-suggestions](https://github.com/961853266hyt/paseo-plugins/tree/HEAD/plugins%2Fprompt-suggestions) plugin, the user decided (2026-10-20): Next moves becomes a card in the native timeline below the agent's last reply; **the Next chip is removed**; the behavior of clicking a suggestion is configurable, by default **prefilling the Paseo input box**, and can be changed to **copy**; Ideas stays as a chip (§7).

### 6.1 When to write and withdraw (daemon, `server/next-move-rows.ts`)

- **Turn end** (`agent.turn_ended` of a board-managed session, `outcome=completed`): when the session has current suggestions (`openNextMoves`, non-empty after removing the action suggestions when the card is already Done/Cancelled), append a row `kind: "flowly-next-moves"`, `version: 1`, `id: "flowly-next-moves-<eventId>"`, `data = { status: "ready", taskId, workspaceId, eventId, moves }`. It is written at turn end rather than when the agent records the suggestion, so that the card is placed after the agent's last reply. An explicit "no next step" (an empty list) is not written.
- **Next turn starts** (`agent.turn_started` of that session): rewrite that session's previous card, with the same id, to `{ status: "past", eventId, moves }` (Paseo replaces in place by id): the suggestions are still shown, but the pills are disabled, the first one is no longer emphasized, and there is no ×. User decision 2026-10-21: the host wraps every plugin row in an outer container with a 16px bottom margin, a row cannot be deleted, and rendering it empty (the old approach `{ status: "dismissed" }`) also leaves that 16px of blank space, which the plugin API cannot remove, so the previous turn's suggestions are kept but not clickable. Rows already written as `dismissed` before a daemon restart still render empty.
- The write runs in the background (10 s timeout), and a failure is only logged and does not affect Flowly's events and status. Like the Progress row: rows live only in daemon memory, and disappear after a daemon restart or a session reload (§5.5). After a plugin reload it does not remember the previous card's id, and the old card is hidden by the client's currency check (§6.2).

### 6.2 Display conditions (client)

A row with `status: "past"` shows the frozen suggestions (disabled), unless the user has closed this group on this machine (`movesHidden`), in which case it renders empty. Other rows' cards are shown only when all of the following hold, otherwise they render empty: the row `status: "ready"`; the row's `eventId` equals the current suggestion that the chip refresh computed for that session (`chipMoves`: the session is idle, there is no pending question, the user has not sent a message afterwards, and this group has not been closed on this machine). A non-board-managed session has no card. Flowly's own session view does not show plugin rows (§5.4), and the suggestion row inside Flowly is unchanged.

### 6.3 Look

```
  Agent: …typecheck and tests both pass.
  ✦ Progress                                                ← small title outside the card
 ┌──────────────────────────────────────────────────────┐
 │ Implementation done, awaiting verification            │
 │ ⌄ Show more      Updated 1m ago · Haiku 5.5 [Open card] │
 └──────────────────────────────────────────────────────┘
  ✦ Suggested next steps                                 ×  ← the same small title, × at the right end of the title row
  [ Verify with Luna ] [ Commit and push ] [✓ Move to Done]   ← suggestion pills sit directly under the title, no card background
```

Next steps has no border, background or padding: directly under the small title (the same as Progress's small title) are the suggestion pills (user decision 2026-10-21, the gray card background was removed). The wrap-up question after Move to Done likewise sits directly under the small title. The pill style is consistent with the suggestion row inside Flowly (the first one emphasized; action suggestions carry `Check` and a success-colored border); on phones they wrap rather than scroll horizontally.

### 6.4 Interaction

- **Message-type suggestions**, according to the setting `nextMoveTap` (host setting `native-session`, default `fill`):
  - `fill` (default): fill the `prompt` into **this session's** Paseo input box; when the input box already has text, append after it with a blank line (the same as Flowly's `nextMoveDraft`), move the cursor to the end and focus. **Not sent**, and the user sends it in Paseo. Available only on web and desktop (`client/web-composer.ts`, see the AGENTS.md exception); when that session's input box cannot be found (the iOS/Android app, Paseo changed the input box structure) it falls back to `copy`. (Falling back to copy is the designer's decision.)
    - Establishing ownership (2026-10-22 fix): only look at input boxes on screen (not in an `aria-hidden` subtree, having layout); if **either** of the fiber's two copies, following the `return` chain, finds an `agentId` equal to this session, it counts as belonging to it. The DOM node holds the fiber from creation time, and React switches between the two copies on every update, so either copy may sit on old props: an input box created in a new session draft keeps carrying the draft id until the page is refreshed. The old rule "if the two copies disagree, do not accept" therefore kept falling back to copy in a desktop app that had not been refreshed for a long time. When two visible input boxes still belong to the same session (split screen), it does not guess and falls back to copy.
  - `copy`: copy the `prompt`, toast "Copied. Paste it into the message box.".
  - The card stays until the next turn starts or the user closes it.
- **Move to Done**: as before (re-validate that the suggestion is still current and the card is not finished → move to Done; when *Auto wrap up* is off and there is something to wrap up, ask inside the card Wrap up / Open in Flowly / Not now, and with blockers or warnings give only Open in Flowly).
- **×**: hides this group on this machine (`client/hidden-moves.ts`), without affecting the suggestion row inside Flowly.
- Settings location: Flowly settings → AI features → "Paseo's session view", with options "Fill the message box"/"Copy". This is the only new UI inside Flowly (the user asked for it to be configurable). The same group also has the *Start progress rows collapsed* switch (§5.3).

## 7. Ideas chip

### 7.1 Display conditions

On a board-managed session, shown when this card has an `open` idea (IDEAS-SPEC §2.1); removed when 0. Each of the same card's several managed sessions shows its own, with the same count.

### 7.2 Look

Icon `Lightbulb`, label "Ideas · 3", title "Ideas for this card", id `flowly-ideas`.

### 7.3 Popover

- Lists this card's open ideas (newest to oldest), each with: the title, `AiMark`, a scope hint ("Continue here" / "New card", per the agent's suggestion), and clicking opens the detail and rationale.
- Three actions per item:
  - **Continue here**: sent to **this current session**, reusing `ideas.adopt` as is (IDEAS-SPEC §6.2: the daemon generates the instruction text, goes through the send queue, records `idea_adopted`, and rolls back on send failure). As inside Flowly, **no editing is offered**; next to the button is the note "Sends this idea to this session.", and after clicking it must be confirmed once more inside the popover. (The designer's decision: keep the RPC contract unchanged.)
  - **New card**: opens Flowly, into the new-card form prefilled with that idea (the same form as the sidebar Create task). A new board screen parameter `{ ideaId, requestId }`, consumed once and strictly validated in the way of SESSION-CHIP-SPEC; when the idea does not exist or is no longer open it errors, and is not replaced with another card.
  - **Dismiss**: `ideas.update` sets it to dismissed (can be Restored inside Flowly).
- When the card is Done/Cancelled or archived, as in IDEAS-INBOX-SPEC only New card and Dismiss are offered.
- Only one layer scrolls in the popover at any time (2026-10-26): in the wide-screen anchored popover the title row is fixed at the top and only the ideas list below scrolls; the total height of Flowly's content does not exceed the host popover's scrollable height (`min(440, window height − 16)` minus the host's total 32 of vertical padding: 4 each for the menu page and 12 each for the plugin content), so the host's outer layer never overflows. The phone bottom sheet (`layout.compact`) scrolls as a whole by the sheet, and Flowly no longer nests a `ScrollView`. With both layers scrollable they fight over the mouse wheel: the outer one moves only after the inner one reaches the bottom, which looks like it cannot scroll or jumps around.
- The popover has only the host layer (2026-10-28): the background, outer frame and padding are all drawn by the host, and Flowly's content no longer brings its own background and padding (otherwise on wide screens one can see "a frame inside a frame"). The title row (`AiMark` + title) appears only in the wide-screen popover; the phone sheet's header already shows the button title, and Flowly does not repeat it.

## 8. Registration, data and performance

- The currency of the Ideas chip and the Next moves card is computed uniformly by the existing client-level refresh in `client/session-link.ts` (the same 5 s etag polling, with no new polling or subscription): the board's `board.read-changed` already contains `events` and `ideas`; the managed session list, the Ideas switch, Auto wrap up and `nextMoveTap` come from `sessions.native-chips`, re-read when the board changes or at most once a minute. A card appears within at most one refresh cycle after a turn ends.
- Session running state and pending questions are judged from the live agent list already present in the refresh.
- A chip does `update` only when its label, visibility or content signature changes, to avoid re-rendering the host input area while the user types.
- The popover and the card render with the data of the latest refresh; before performing an action, re-read and validate (the suggestion is still valid, the idea is still open, the session still belongs to the card), and when invalid, prompt and refresh without executing.
- Callbacks must not capture `for` loop variables (Hermes), and chip buttons are built in a separate function (same as `chipButton`).
- Cleanup: when the plugin unloads or a session no longer meets the conditions, remove all of its own chips; read or action results that arrive after unloading do not register or navigate.
- The timeline renderer bundle is small, with no network; no new dependency is introduced.

### 8.1 Next moves card latency on phones (2026-10-21 performance revision)

User feedback: on phones the Progress card is fast, and the Next moves card takes a long time. The cause (measured, this machine's host with 1251 agents): the Progress row carries all its data and renders as soon as it arrives; the Next moves card waits for the client chip refresh to compute the "current suggestion", and the old refresh round was **board read → full listing of live agents (233 KB) → full scan of all agents including archived (3.1 MB, of which 386 are summarizer leftovers) → native-chips → only then computing the Next/Ideas state**. Every board change triggers a 3 MB scan, and turn start/end and suggestion events are all board changes; the phone decodes every byte on the JS thread. On top of that, a polling interval of up to 5 s, and the daemon-side card write queued behind the settings read, the model query (up to 2 s) and the board write. Revision:

- **Compute first, scan later**: a refresh round first reads the board (etag/delta), reads native-chips and insights when needed, immediately computes the Next/Ideas state and syncs the chips; the archive scan moves to run in the background **after** this round, never blocks, and is no longer triggered by board changes, running only when "a session that has chips left the live list" or once a minute (replacing SESSION-CHIP-SPEC 2026-10-18's "rescan when the board changes"; already cached archived sessions still update their titles with board changes, and only "newly archived sessions" get their chip up to one minute later). The archive cache stores only `{id, workspaceId}`.
- **The live list goes by push**: as with the board, maintain live agents with the agent stream (`agents.subscribe`), do one full listing after the stream opens, and reconcile every minute thereafter; without a stream (an old host) it falls back to listing every round.
- **Push triggers a refresh**: a change in a session's status, `lastUserMessageAt`, pending permission, attention or workspace (`relevantChange`, title, usage etc. do not count) triggers a refresh round within about 150 ms (coalesced), so after a turn ends (running → idle) the card is ready almost immediately, with no wait for the next 5 s cycle.
- **Pull on row arrival**: when a Next moves row reaches the client before the state, the renderer requests a refresh round (once per row, `requestRowRefresh`).
- **Daemon side**: the managed session's card write is moved to the very front of the `turn_ended` hook (the suggestion event is already in the board, and does not depend on the later settings read, model query and board write).
- **No pointless re-render**: when the chip state recomputed each round has unchanged content, subscribers are not notified.
- The developer timing log adds `chips.round` and `chips.archived`.

## 9. Copy, onboarding and docs

- All UI text uses `t()`/`tn()`, and new copy goes into all language catalogs.
- No one-time tip inside Flowly is added, and the welcome page copy is unchanged (the user decided this feature does not change Flowly's internal behavior and styling; AGENTS.md "Onboarding upkeep" allows saying in the delivery note that it is not added). The `native-session` tip of the initial design has been removed.
- One sentence is added to the README Highlights (documentation, not the Flowly UI).
- SPEC-OUTLINE and PROGRESS record this feature.

## 10. Acceptance

Unit (focused):

- Summary append: a new version appends, `update=false`/failure does not append, skipped when a new turn has already started, an archived session is skipped, an append failure does not affect the write; data and the version field are consistent.
- Next moves card: a ready row is written at turn end (not written for an empty list, non-completed, or a finished card with only action suggestions left), rewritten to past when the next turn starts (suggestions kept, disabled), the in-plugin-memory row id and suggestions are recorded per session; the currency rule (`chipMoves`); prefill concatenation and fallback to copy.
- Ideas chip: count, the Ideas switch, registered only for managed sessions, removed and rebuilt on binding change, no longer registered after unload; the Next chip is no longer registered.
- Validation and one-time consumption of the new board parameter `ideaId`.

Manual / Luna (a full-permission `codex/gpt-6-luna` test session, on Tinylink or a temporary fixture per the AGENTS.md rules, cleaned up afterwards):

- After a managed session finishes a turn, a Progress entry appears in the native timeline, and expand/collapse work; it does **not** appear in the conversation of the same session inside Flowly (§5.4).
- After a turn ends, a Next moves card appears in the native timeline under the last reply; by default clicking a suggestion fills the text into that session's Paseo input box (appending when there is existing text) and does not send; after the setting is changed to Copy, clicking a suggestion copies; after the next turn starts the card disappears; × only hides the card, and the suggestion row inside Flowly is not affected; there is no Next chip on the composer.
- Move to Done suggestion: moving, the wrap-up question, the behavior of each branch.
- Ideas chip: Continue here, New card (opens the prefilled form), Dismiss, with the state inside Flowly synced.
- A non-managed session does not show the two new chips, and the Task chip is as before.
- Works on both the desktop wide screen and the phone compact layout (including the input box and keyboard in the popover).
- On the real implementation re-check #1 and #2 of §5.5 (the summary row does not enter the agent context and does not trigger attention).

## 11. Choices left to the implementer

- The split and file names of the render component and the popover component.
- The specific abbreviation of chip labels in different languages.
- If the host's popover on phones cannot fit the input box, it may be changed so that an "Edit" inside the popover jumps to a Flowly screen to finish editing; this must be recorded in this spec.

## 12. Sessions not managed by Flowly (P2–P4, 2026-10-21)

The user asked on 2026-10-21: all sessions not managed by Flowly also directly get Progress and Next moves, **without being brought under any project's management**; Ideas are also supported per session (continue in the current session, open a new session, open a new workspace), but do not enter any project's Ideas. The user decided: generate with a **Paseo child session** (the same mechanism as the card summary); **off by default**; Progress / Next steps / Ideas **can each be switched separately** (when duplicating paseo-recap, only Progress can be turned off). This section is delivered in a new commit, and does not change the earlier P1 commits.

### 12.1 Scope

- "External session": a session not managed by Flowly (not in `sessions.managed`), not archived, having a workspace, not a child agent (`parentAgentId` is empty), and not one of Flowly's own helper sessions (the summarizer, judged by the label `flowly=summarizer`; the memory review, digest and workflow insights all carry this label. Before 2026-10-23 the code missed this check and ran insights for these use-and-delete sessions, leaving error records). This includes: sessions in a card's workspace that have not joined the card (P2), sessions in a Flowly project that belong to no card (P3), and sessions in no Flowly project (P4).
- Managed sessions keep the card path of §5–§7, unchanged.
- Flowly's own behavior and styling are unchanged (§3), and the only addition is the settings items (§12.6).

### 12.2 Generation (daemon, `server/session-insights.ts`)

- Trigger: an external session's `agent.turn_ended`, `outcome=completed`, with the master setting on and at least one of the three on. The turn text is as in TASK-SUMMARY-SPEC §2 (`turnText`, ignoring plugin rows), and it is skipped when empty.
- Single flight and coalescing: at most one generation per session at a time; a turn that ends while one is running is coalesced into the next (the same as the card summary).
- Run: create its **child session** in that session's workspace (`parent` = that session), model = the Summary model setting (Auto as for cards), title `Flowly insights · <session title>`, labels `{flowly: "summarizer", "flowly-session": <agentId>}`, `outputSchema`, `waitForFinish(120 s)`, and in `finally` **hard-delete** it (`server/summarizer-remove.ts`, local `DaemonClient.deleteAgent`, approved by the user on 2026-10-22, see the AGENTS.md exception; only the id just created this time is deleted); if deletion fails, fall back to archiving and log it. During the tens of seconds of the run the child session is still briefly visible, and after it ends neither the list nor the archive keeps a trace.
- One call produces all three at once (items that are turned off are not required in the prompt, and their output is ignored):
  - `update/state/target/recap/next`: the same as the card summary, but with the session title and working directory in place of the card title/description/lane; the previous version is an input.
  - `moves`: 0–3 "the next message the user is most likely to send" (`label` ≤60 characters, `prompt` ≤2000 characters, in the conversation's language); empty when there is no clear next step. An external session has no Move to Done.
  - `ideas`: 0–2 follow-up works that are **different** from the current goal and worth doing separately (`title/detail/rationale/scope`), with the titles of already open ideas as input to avoid duplicates; not requested when this session already has 5 open ideas.
- A failure (model unavailable, timeout, permission, output not matching the schema) is only recorded in that session's `error` and logged, and is not retried.

### 12.3 Data (`session-insights.json`, in the same directory as `board.json`)

Serial writes, backup, atomic replacement; invalid content keeps the file and reports an error, and is not reset.

```
{ version: 1,
  sessions: [{ agentId, workspaceId, title, updatedAt,
               summary: { id, at, model, state, target, recap, next } | null,
               suggestion: { id, at, moves: [{label, prompt}], current: boolean } | null,
               ideas: [{ id, title, detail, rationale, scope, status: "open" | "dismissed" | "adopted",
                         adopted?: { target: "here" | "session" | "workspace", agentId?, workspaceId? },
                         createdAt, updatedAt }],
               error: { at, message } | null }] }
```

- At most 20 ideas per session (beyond that the earliest non-open one is deleted) and at most 5 open; at most 300 sessions are stored, beyond that the longest-unupdated one is deleted.
- `suggestion.current` is set to false when that session's next turn starts.

### 12.4 Native timeline rows

- Progress: the `flowly-summary` row (§5.2), with `taskId`/`workspaceId` becoming optional; an external session's row carries no `taskId`, and "Open card" is not shown on the card. Append rules are as in §5.1 (skipped if a new turn has started or it is archived).
- Next moves: the `flowly-next-moves` row (§6.1), with `taskId`/`workspaceId` optional and `eventId` being `suggestion.id`; ready is written at turn end and rewritten in place to past when the next turn starts (the same `NextMoveRows`; `dismissed` is only the shape of old rows).
- Client currency: the row's `eventId` equals that session's latest and `current` suggestion, and the session is idle, has no pending question, the user has not sent a message afterwards, and this group is not closed on this machine (the same rule as `chipMoves`). The behavior of clicking a suggestion is as in §6.4 (fill by default, can be set to copy).

### 12.5 Ideas chip (external session)

- When there is an open idea, show an `Ideas · N` chip (the same id and look as §7); the popover lists that session's open ideas (title, scope hint, click to open the detail/rationale).
- Actions (executed after re-reading and validating that the idea is still open, and the chip is refreshed immediately after execution):
  - **Continue here**: after confirmation, send the idea instruction to the current session (the same instruction text as `ideas.adopt`), recorded as adopted(here).
  - **New session**: create a new session in the same workspace (the same provider/model as the current session), with the idea instruction as the first message, recorded as adopted(session).
  - **New workspace**: branch off a worktree workspace from the current session's workspace directory (the same way as a card creates a new worktree), create a new session in it and send the idea instruction, recorded as adopted(workspace). When the directory is not a git repository it errors and suggests using New session.
  - **Dismiss**.
- It does not appear on any project's Ideas page; there is no "Start a new task".

### 12.6 Settings

> 2026-10-22 user decision (ONBOARDING-SETUP-SPEC D2/D3): changed to "on by default", but written by the welcome tour: when a new user's first tour is closed in any way, `outside` and the three items are written according to the three "Also in sessions outside Flowly" switches in the tour (all on by default); the schema default is still `outside=false`, so installed users who did not finish the tour stay off. When the tour writes, it always writes all four fields together (`outside` = any of the three on), to avoid turning on the other items, which only "look off" because the master switch is off, when one item is turned on.

The host setting `native-session` gains fields (defaults keep old storage readable): `outside` (default **false**), `outsideProgress` / `outsideNextMoves` / `outsideIdeas` (default true, effective only when `outside` is on). Flowly settings → AI features → "Paseo's session view" gets a new master switch and three sub-switches, with the note: once on, each external session, for every turn it completes, runs the Summary model once (reading the recent conversation and sending it to that model's provider), and leaves an archived child session.

### 12.7 Client registration and performance

- `sessions.native-chips` gains the `outside` setting; when on, the chip refresh reads `sessions.insights` with an etag every round (tiny when unchanged), taking only the data of live external sessions: each session's current suggestion and open ideas. Not read when off.
- External sessions' Next moves currency and Ideas chips are both computed in the same refresh, with no new polling or subscription.

### 12.8 Acceptance

- Unit: external session determination (managed / child agent / summarizer / no workspace / archived), settings gating (master switch, the three items), single-flight coalescing, output parsing (limits and tolerance of moves/ideas), storage limits, suggestion invalidated at the next turn, row append and skipping, the three idea action targets and re-validation, chip currency.
- Luna 6 (full permission): after turning the settings on, an ordinary (non-Flowly) session completes a turn → the Progress and Next moves cards appear in the native timeline, plus the Ideas chip (if there are ideas); the three switches take effect separately; Continue here / New session / New workspace / Dismiss; after turning off the master switch nothing is generated; managed session behavior is unchanged; after the test the settings are restored to their original values and all fixtures cleaned up.

## Cleanup of managed bindings

`sessions.managed` and `sessions.native-chips` list only bindings whose card still exists. After a card or project is deleted, the plugin deletes the matching `sessions/<agentId>.json` (the tool credentials), and at plugin startup it also clears old orphan bindings once (skipped when the board has no cards at all, not trusting an empty board). Bindings of archived sessions are kept: when a card is reopened, the sessions archived by wrap-up are restored and need their original bindings; the count is bounded by the existing cards, and does not grow without limit. Files that cannot be parsed are kept as is.
