# UI refresh — native-blend visual and information architecture

Status: authorized by the user's 2026-10-14 request to redesign the whole Kanban UI (project chooser, board, cards, card drawer, session cards, session detail). Direction chosen by the user: **native blend** (look like a first-party Paseo surface) with **visual + information-architecture** changes allowed. Presentation only: RPC contracts, storage, one-root scope, session/business-status independence, motion policy ([MOTION-SPEC.md](MOTION-SPEC.md)) and drawer rules ([DRAWER-SPEC.md](DRAWER-SPEC.md)) are unchanged unless amended below. Luna acceptance is deferred by the user; they review the reloaded plugin themselves first.

## 1. Design language

- Follow the host Paseo scale read from the installed 0.11.2 app: 4-point spacing grid; type 12 / 13 / 14 / 16 / 18; weights 400 / 500 / 600; radii 4 / 6 / 8 / 12; icons 12 / 14 / 16. Only `PluginTheme` colors are used; tints are derived from them with alpha, never new hues.
- Status color semantics match the host status dots: needs approval → `statusWarning`, error → `statusDanger`, running/starting → `accent`, unread finished turn → `statusSuccess`, idle/closed → muted. Business statuses get a Lucide status glyph (Backlog dashed circle, Todo circle, In progress dot/warning, In review dot-dashed/accent, Blocked slash/danger, Done check/success, Cancelled X/muted).
- Desktop controls are compact (32 pt high) with hover feedback on web; native/compact controls keep ≥ 44 pt hit targets. Ghost icon buttons replace text buttons for secondary actions, each with an accessibility label.
- Errors use a toned notice (icon + tinted border) rather than a plain bordered box. Long IDs, full timestamps and configuration explanations move to details or accessibility labels; visible times are relative ("3m ago") with the absolute time in details.

## 2. Board

- Toolbar: one 48 pt row. Project switcher (folder glyph, project name, chevrons), muted task count, search-aware Filters button (badge with active-filter count), primary "New task".
- Project chooser modal: host-style list rows (name, root path, check for current, archived badge). Current-project actions (Edit, Archive/Restore) and "New project" sit below a divider. Selecting a project closes the drawer exactly as before.
- Filters modal: search field, priority segmented control, two switch-style rows (Show archived, Show finished), footer with Reset / Refresh / Done.
- Desktop lanes: borderless `surface1` lanes (radius 12) without a header divider. Header = status glyph, label, muted count, ghost "+" (hover). Empty lane shows a quiet "No tasks"/"Drop here". Drag target feedback (accent overlay, ghost preview, subdued source) keeps the existing behavior.
- Compact status control is a full-width row showing status glyph, label and count; the status chooser modal is a list of rows with counts and a check.

## 3. Cards

- Title first (14/500, up to 3 lines). One signal row below: priority glyph only when not Normal (Urgent danger, High, Low muted), session signals as dot + short text in priority order — approvals, errors, running, unread — otherwise a muted session count when sessions exist. Archived/Legacy as small outline badges. Workspace unavailable / loading / unavailable / last-known states remain visible as one muted line.
- The actions "…" button is an absolutely positioned ghost icon in the top-right; on desktop web it appears on hover/selection and stays focusable; compact always shows it. Whole-card mouse drag, click suppression, non-selectable text and accessibility summary remain unchanged.
- Selected card: accent border; hover: stronger neutral border. Attention is carried by the colored signal dots, not by card borders or colored edges. Empty lanes render nothing; the dashed drop slot appears only during a drag.

## 4. Card drawer

- Header: project breadcrumb (muted) with Edit / Archive / Close (desktop) or Back (compact) icon buttons; title 18/600; property chips for Status (opens the status chooser modal on both layouts, replacing the desktop `SettingsSelect`) and Priority (opens Edit). Errors shown under the header.
- Body sections with small uppercase-free headers ("Description", "Sessions n", "Activity"): description as readable text; sessions list with "New session" ghost button in the section header; Details & workspace disclosure (unchanged content); Activity as a compact timeline (dot, humanized action, actor, relative time, note).

## 5. Session card (row)

- One bordered row group: status dot (semantic color, pulsing only through existing reduce-motion-aware motion if added), title (500), trailing relative time and chevron. Second line muted: state label · provider/model. Unread → success dot and bold title; needs-attention → tinted state text. Archived rows dimmed. Highlight after creation uses the accent border.

## 6. Session detail

- Compact header: back icon, title + status line (dot, state label, provider/model), trailing icon buttons: Mark read (only when unread), Refresh output, Kanban tools toggle, Open in Paseo. All existing enable/disable conditions are preserved.
- Transcript: user messages as right-aligned `surface2` bubbles; agent messages as plain markdown; tool activity as one-line muted mono rows with a wrench glyph; thinking as muted italic with a brain glyph. "Recent output · open in Paseo for the full conversation" becomes a muted caption at the top. Running tail keeps the spinner.
- Kanban tools panel: bordered card with explanation, configuration and last-call lines, and the "Send Kanban work instructions" button.
- Composer: a single bordered container with the multiline input and an integrated send icon button (both layouts); hint and jump-to-latest in a small row above; Steer/Interrupt as a segmented control shown only while running. Enter/Shift+Enter, draft buffering, steer/interrupt and authorization behavior are unchanged.

## 7. Forms

- Project/Task/New-session forms keep fields and validation; adopt the new field, segmented choice and notice styles; footer actions are right-aligned with Cancel before the primary action.

## 7a. Phone scrolling (2026-10-14 correction)

- User report: on the phone the board list drifted slightly left/right. All vertical lists (compact task list, lanes, drawer, session output) are vertical-only: `horizontal=false`, no horizontal bounce/indicator, directional lock, and a content container with `overflow: hidden` / `maxWidth: 100%`, so child overflow or transforms cannot widen the iOS (Fabric) content size.
- Switching the compact status is a filter change, not navigation: the list fades without a horizontal slide. Drawer/session navigation keeps its slide.

## 7b. Session composer keyboard and send button (2026-10-14 correction)

- User report: in the drawer session view the software keyboard covered the composer. The session view no longer relies on `KeyboardAvoidingView` (which was disabled on Android). On native it measures the view's bottom edge against the keyboard top on show/change and pads by the actual overlap (0 when the host window already resized; iOS follows keyboard timing). The inset is removed on hide/unmount and the transcript re-follows the tail when the inset appears. Web is unaffected.
- Send button: circular, centered on a single-line input in a pill composer; accent with accent foreground when sendable, muted tinted fill when empty/unwritable, press scale feedback, spinner while sending, and a return glyph when the running-session mode is Interrupt.

## 7c. Native composer in the host sheet (2026-10-14 correction, supersedes the keyboard-inset part of 7b)

- User report: on Android the IME still covered the composer. Cause (RN 0.81 `ReactRootView.checkForKeyboardEvents`): Android emits `keyboardDidShow` only when IME visibility flips, with `height = ime.bottom - systemBars.bottom`; later IME height changes (Chinese candidate bars, keyboard switches) emit nothing, so plugin-side measurement under-lifts.
- Fix: on native platforms the session view shows a one-line composer bar (draft preview or "Message this session…", running mode, edit affordance). Tapping it opens the host `Modal` (gorhom bottom sheet with Reanimated keyboard tracking) containing the same multiline input, Steer/Interrupt control and send button; the host keeps it above the real IME. Successful send closes the sheet; failure keeps it open with the error. Draft, Enter/keyboard-send, authorization and send semantics are unchanged. Web/desktop keep the inline composer. The plugin-side keyboard inset hook was removed.

## 7d. New-session agent picker (2026-10-15 correction)

- User report: provider/model chip walls (15 providers, 20+ models) were hard to scan. The New session form now shows an always-visible "Agent" group with three rows — Provider, Model, Permissions — each showing its current value. Tapping a row expands one inline vertical list at a time (label, description, Default tag, check for the selected item, scroll-bounded); lists longer than 8 get a search field. Provider labels/descriptions come from the provider snapshot, falling back to the id; unselectable models are hidden; model descriptions drop a repeated name prefix. Selection logic (remembered defaults, fallbacks, creation) is unchanged. Pure option builders/filter live in `client/options.ts` with tests.

## 7e. 2026-10-15 refinements

- **Remembered project**: the board reopens on the last project chosen through the project chooser or created there (host-scoped plugin setting `board-view.lastProjectId`); links, Attention and workspace panels still select their own target without overwriting it.
- **Status-change flash**: when a card's status differs from the previous board snapshot (often an automatic A1 move or another client), the card shows a 1.5pt accent border with a 6% accent wash that fades in quickly and out over ~0.9s, then clears after 1.6s. Never on first load; each flash owns its timer; reduce-motion snaps; timers cleared on unmount.
- **Activity**: routine turn start/end records are hidden from the timeline (they still drive rules and markers); failed turns, questions (shown as "asked", full text emphasized) and rule changes ("Auto" badge with reason) are shown.

## 7e-2. Running pulse and summary hygiene (2026-10-15)

- Running/starting state dots (card "n running" signal, drawer session rows, session detail header) breathe between full and 35% opacity over ~1.6s with the native driver. Static under Reduce Motion; the loop stops on unmount or when the session stops. Verified live by sampling the dot over time.
- Card output summaries drop markdown images entirely, so image-only agent messages ("Image" alt text) no longer become the summary; the previous text message is used instead.

## 7f. Session archive / restore in the drawer (2026-10-15, user request)

- The public SDK exposes `agent.archive()` but no unarchive; the daemon restores an archived agent when it receives a prompt (Paseo's own behaviour). The plugin follows that model.
- Session detail header: "Archive session" icon for live sessions. Running/starting sessions ask for confirmation first (archiving interrupts the turn). Success shows a toast and returns to the card details.
- Archived session detail: the notice says sending a message restores it; the composer stays enabled with the placeholder "Send a message to restore this session…". The ordinary send path accepts an archived target (`workspaceSession(..., "restore")`); Kanban work instructions still require a live session.
- Drawer Sessions list shows live sessions; archived ones move to a collapsed "Archived · n" group at the bottom. The Sessions count shows live sessions.
- Verified live with a fixture card (archive → grouped → restore by message), then wrapped up: [evidence](verification/session-archive-restore.png).

## 7g. Focus rings, composer stability, Paseo send parity (2026-10-15, user report)

- **Focus rings**: the board root (focusable for shortcuts) and every plugin pressable suppress the browser's square focus outline (`noFocusRing`); focus is shown with the component's own hover/selected styling, and cards show their rounded accent border while focused. Verified: focused card computes `outline: none`.
- **Composer stability**: the drawer's task-context query keeps its previous data across revision changes (automatic status moves no longer blank it and flash "unavailable"); the composer input stays editable whenever the session exists — only the send button follows availability — so typing is never dropped. No rows appear/disappear above the input: "Latest" is a floating pill, the Steer/Interrupt segmented row is removed. Verified live on a running session: 40 typed characters, constant input position/height, focus retained; New task dialog position constant while the drawer is open.
- **Send while running (Paseo parity)**: options Steer / Queue / Interrupt with Paseo's semantics — Enter uses the preference, Cmd/Ctrl+Enter the alternative (queue for steer/interrupt; send now for queue); a queued message waiting behind a permission prompt interrupts instead. Paseo's own setting is client-local and not readable by plugins, so the board keeps a host-scoped copy (`board-view.sendBehavior`, default Steer) changed from the composer footer ("When running: …") or the native sheet. Queued messages show above the input (removable) and are sent one per finished turn by the board even when the preview is closed; a failed send returns to the front of the queue with an error toast.

## 7i. Composer parity, persistence, context menus, motion (2026-10-15, user request)

- **Composer chips (Paseo layout)**: under the session input, chips for Model · Reasoning · Speed · Permissions open upward menus (desktop) or inline lists (native sheet).
  - Reasoning and permissions apply on selection; the model menu shows the model and its other provider features (e.g. Codex Plan) read-only with "Change in Paseo".
  - Speed (2026-10-30, card "show selected agent speed setting"): shown only when the session's model offers one (AGENT-SPEED-SPEC); the chip names the speed the session runs at, its menu lists normal and faster speeds read-only with "Change in Paseo".
  - A running session with an empty input shows Stop in place of Send.
  - The header "Session settings" button is removed (superseded).
- **Persistence**: unsent drafts and queued follow-ups live on the daemon (`composer.json`: serialized writes, atomic replace, invalid files preserved), so plugin reload and app refresh keep them.
  - Drafts save 0.5s after typing stops (immediately when a send clears them) and are restored when the drawer opens.
  - The daemon drains queued messages on turn end, after a push, and opportunistically on reads, one per turn. A failed send returns to the front of the queue and shows its error under the composer.
- **Send now**: each queued message has "Steer" (and a context menu: Send now · Edit · Remove), which steers the running turn and removes it from the queue.
- **Feedback**: transient confirmations ("Marked as read", "Kanban instructions sent", "Session archived") are native toasts that auto-dismiss; inline notices are only for errors.
- **Context menus**: right-click (desktop web) or long-press (touch) opens plugin menus.
  - Cards: Open · Start session · Move to … · Move up/down · Archive.
  - Session rows: Open · Open in Paseo · Archive.
  - Queued messages: Send now · Edit · Remove.
  - The browser's native menu is suppressed across the board except in editable fields (copy/paste stays native).
  - Desktop menus float at the pointer (fade + scale, clamped to the board); compact uses the host sheet.
- **Motion** (shared primitives, Reduce Motion aware, interruptible):
  - chip and context menus (fade/rise or scale);
  - picker lists (fade/slide on expand);
  - toggle thumb slide;
  - question callouts and queued rows (enter rise);
  - the floating "Latest" pill (fade).

## 7k. Side bar headers (2026-10-15, user request)

- Every level of the side bar can close it directly.
  - **Card details**: project crumb · Edit · "⋯" (Start session, Wrap up… when finished, Archive/Restore card) · Close.
  - **Session detail**: Back · title/status · Open in Paseo · "⋯" (Mark as read when unread, Kanban tools, Stop when running, Archive session) · Close.
  - Compact keeps Back on the card level (it is the close) and adds Close at the session level.
- The manual Refresh button is removed: output, status and sessions poll and subscribe automatically.
- The session row context menu adds Stop for running sessions. Archive from a row stays disabled while running; the detail view's archive confirms instead.
- Overflow menus reuse the plugin context menu: floating at the button on desktop, host sheet on compact.

## 7j. Images in the session transcript (2026-10-15, user report)

- Timeline text carries images as provider placeholders for pasted images (`[Image: source: /abs/path.png]`) and as markdown in agent replies (`![alt](src)`). `extractImages` removes them from the text and renders them under the message: user images right-aligned under the bubble, agent images under the markdown. Thumbnails keep their aspect ratio (bounded), fade in when loaded, and open larger in a sheet.
- http(s) images load directly. Local paths live on the daemon machine, so the plugin daemon serves them (`sessions.image`) as data URIs, with these limits:
  - the session must belong to the card;
  - the path must be an image (png/jpg/gif/webp, ≤ 8 MB) referenced in that session's recent timeline — never a general file reader.
- Failures show the alt text with the reason.
- Verified live: a pasted-image placeholder and an agent markdown image rendered in the drawer preview ([screenshot](verification/session-images.png)).
- Composer data of archived (wrapped-up) cards is pruned automatically.

## 7h. Session settings (2026-10-15, user request)

- Session detail header → "Session settings" (live sessions):
  - **Reasoning** (the current model's `thinkingOptions` from the SDK model catalog) and **Permissions** (the session's `availableModes`) apply on selection.
  - **Stop** interrupts a running session.
  - **Model** and provider **features** (e.g. Codex Fast mode) are shown read-only with "Change in Paseo".
- Why: the plugin SDK (`PaseoApi`) exposes no session-settings API. The daemon's `setAgentModel/Feature` live only on the private DaemonClient or the agent-facing `/mcp/agents` endpoint, which plugins must not impersonate. The official Paseo CLI supports `agent update --thinking`, `agent mode` and `agent stop`, so the plugin daemon runs the bundled CLI (resolved from `PASEO_CLI`, which the desktop app sets for its daemon, or the app bundle; argument arrays, `--home` = daemon home). On Windows that is `paseo.cmd`, which Node will not start without a shell (EINVAL), and a shell would re-parse the arguments (titles are user text): `server/paseo-cli.ts` runs what the shim runs instead, `Paseo.exe` with the bundled runner and CLI entry (Paseo's `packages/desktop/bin/paseo.cmd`), or Node with `@getpaseo/cli/bin/paseo` for npm's shim, and fails with a clear error for any other layout. Native project create/delete (`server/service.ts`) use the same resolution instead of a bare `paseo` from `PATH`.
- RPC `sessions.configure` validates:
  - the session belongs to the card's workspace, is not archived, and the mode is offered;
  - IDs must start with a letter or digit (no option injection).
- Verified live: reasoning Medium→High and permissions →Plan Mode on a fixture Haiku session, confirmed with `paseo agent inspect` (thinking=high, mode=plan); fixture wrapped up ([screenshot](verification/session-settings.png)).
- When the SDK gains model/feature setters, the read-only rows become pickers with no other change.

## 7l. Project order (2026-10-15, user request)

- Projects carry an optional `position`; the chooser and default selection use `projectOrder` (position, then creation time). Legacy records without a position keep their creation order.
- Desktop: drag a project row with the mouse (grip on the left signals it). The held row follows the pointer immediately; the rows it passes slide aside (short, Reduce-Motion aware); the release never selects the project. The dropped order shows at once and is kept until the refreshed board agrees (5 s fallback; cleared on error).
- Touch: up/down buttons per row (a drag would fight the host bottom sheet).
- `projects.move` accepts either `direction` (`up | down | top`) or `to` (target index); the client maps a drop in the visible list (archived may be hidden) onto the full order.
- `projects.move` renumbers all projects in one serialized write. Ordering is presentation metadata: it does not bump the board revision, so it never invalidates an open edit.
- Verified: button reorder and mouse drag (moved, persisted across reload, restored) on the live board; the chooser stays open after a drag.

## 7m. Collapsed agent activity (2026-10-15, user request)

- Consecutive thinking and tool-call entries in the session transcript merge into one activity block, collapsed by default to a summary ("Thought · 7 tool calls"). User and agent messages are never grouped.
- While the session is running, the trailing block reads "Working" with a pulse dot and the latest tool, replacing the separate "Agent is working…" row.
- Expanding shows each step as a short preview: tools on one line, thinking clipped to two lines. The full thinking stays in Paseo ("Open in Paseo").
- The block's key is its first entry, so expanded state survives streaming updates. Expand uses the shared Enter motion; the chevron rotates.
- Verified on a live running session: two blocks collapsed, expand works, no console errors (`docs/verification/activity-groups.png`).

## 7n. Attach images to session messages (2026-10-15, user report)

- Web/desktop: paste an image into the session composer, drop image files on it, or use the attach button (left of the input). Up to 4 PNG/JPEG/GIF/WebP images per message, 5 MB each; anything rejected is explained in a toast. Thumbnails sit above the input and can be removed. A message may be images only.
- Native (iOS/Android): no attach control. The plugin host exposes no image picker module (only react, react-native, plugin, react-query, zod), so mobile users attach in Paseo itself.
- Sending: immediate sends pass `images` (base64) to the SDK's `agent.send`. Queued messages keep their images as daemon files (`plugin-data/.../composer-images/<item>-<n>.<ext>`, 0600) referenced from `composer.json`. They are sent with the message on drain or "Send now", then deleted. Removing the message, or dropping a wrapped-up card's queue, deletes them too. A queued message with images can be removed but not edited back into the composer.
- Transcript: the daemon timeline records only a message's text, so the client passes its own message ID (queued: the item ID) and shows your images from an in-memory cache. After a reload the message shows its text only. Your images are compact (≤200 px, never upscaled); agent images keep up to 360 px.
- Exception to "no DOM": `client/web-images.ts` alone listens for paste/drop events on the composer's web node and opens the browser file chooser. It is feature-detected, renders no HTML, and is inert on native.
- Verified e2e with a disposable fixture card (Haiku session, worktree): pasted image sent immediately (agent answered "Red"), image queued while running then drained ("Blue"), image-only queued message ("Purple"), two images in one message ("Orange, Teal"); composer thumbnails and transcript images in `docs/verification/image-attach-*.png`. Fixture cleaned up: card wrapped up/archived, session archived, worktree removed, test branch deleted, `composer-images/` empty.

## 7o. Board sort mode (2026-10-15, user request)

- A Sort control sits in the board toolbar before Filter. Its menu offers: Manual (default, drag order), Recent activity (the card's latest finished session turn: the `agent.turn_ended` events Kanban-managed sessions record, and for other sessions in its workspace the time they last went idle, remembered while they run; a card with no finished turn counts from its creation. Streamed messages, mid-turn card writes and task edits do not reorder it, so cards move once per turn instead of jumping while sessions stream), Priority (urgent first), Newest (created), Title (A–Z, natural numbers). Every mode falls back to the manual order for ties. The same order applies to the compact single-column list.
- The choice is a host-scoped view setting (`boardSort` in `board-view`), so it survives reloads and doesn't touch board data. A non-manual mode shows its name on the button.
- In a non-manual mode, dragging a card to another column still changes its status; it is appended in manual order with no insertion line. A drop within the same column does nothing and a toast explains that Manual sort is needed.
- Sorting is `shared/sort.ts` (`sortTasks`), unit-tested for every mode and its fallback.
- Verified on the live board: menu entries, choosing Priority, the blocked in-column drag toast, persistence across reload, and switching back to Manual.

## 7p. Board basics polish (2026-10-15, audit at user request)

- **Collapsible columns (desktop).** A column header shows a collapse button on hover, and right-clicking the header offers Add task / Collapse column. A collapsed column is a 44 px strip with its icon, count and vertical title. Click the strip, or use its context menu, to expand. Strips stay drop targets: a dropped card is appended in manual order. Collapsed columns are remembered per host (`collapsedColumns` in `board-view`). The collapse button stays mounted and only fades in, because RN-web clears hover on press.
- **Keyboard.** J/K/H/L now follow the active sort and skip collapsed columns (bug fix). ⇧H / ⇧L move the open card to the adjacent shown column, and E edits it. Both are listed in the shortcuts sheet.
- **Create form.** New tasks offer only active statuses (Backlog to Blocked); Done or Cancelled appear only when the task is added from that column. The Status row no longer wraps. Editing still offers every status.
- Verified on the live board: collapse via the hover button, persistence across reload, expand via click and via the strip menu, E opening Edit, and the create form layout (`docs/verification/collapsed-columns.png`). ⇧H/⇧L is covered by unit tests plus the existing move path. It was not exercised on live cards, to avoid writing status history onto your real tasks.

## 7q. Read on open, mark as unread (2026-10-15, user request)

- Opening a session in the side bar marks it read automatically, matching Paseo. It acknowledges the native attention token it saw. A turn that ends while the session is open is read as well. With no native token there is nothing to acknowledge, so the call is a silent no-op.
- "Mark as unread" appears in the session header ⋯ menu and in the session row context menu; "Mark as read" appears there whenever the session is unread. A manual unread mark is stored as this session's read-state record with the token `manual-unread`. That keeps the one-record-per-session invariant, and the existing attention logic, cards, Attention list and badges pick it up unchanged. The session stays unread, even without native attention, until it is read again. While the view that marked it stays open, auto-read is held off; opening it again reads it.
- `sessions.mark-read` input `token` is now optional and output nullable. With no native attention it only clears a manual mark; with native attention it records the current token, and a stale provided token is still rejected. New `sessions.mark-unread`. Both go through the same live-task/session/workspace validation, serialized writes, backup and atomic replace.
- Verified live on an existing read session: mark unread from the row (card shows 1 unread), open it (auto-read, 0), mark unread from the header while viewing (stays 1), mark read (0, the original state). Unit tests cover the store transitions and the attention computation.

## 7r. Dialog open motion (2026-10-15, user request)

- Every plugin dialog (New task, Edit task, New session, Projects, Filters, Attention, Status, Wrap up, menus on touch, …) goes through `client/modal.tsx`. Its content now settles in on each open: opacity 0→1 and an 8 px rise over 220 ms. On close it eases out over 160 ms while the host fades the overlay.
- On desktop the host dialog card itself appears instantly; it is host-owned and keeps its own transitions. Only the plugin-owned content animates. On mobile the host bottom sheet keeps its slide.
- Fix: host dialogs render outside the plugin tree, where the Reduce Motion context fell back to "reduced", so all plugin motion inside dialogs (picker rows, toggles, callouts) was silently off. `MotionBridge` now passes the real preference in. Reduce Motion still disables all of it.
- The single wrapper view keeps the caller's `contentContainerStyle.gap` (host default 16) and fills the body for `scrollable={false}`, so layouts are unchanged.
- Verified on desktop: frame samples for New task (twice), Filters and New session show 0→1 opacity / 8→0 px over about 200 ms; screenshots match the previous layouts.

## 7s. Session instruction is required and starts empty (2026-10-15, user feedback)

- New session: the field is now "Instruction". It is required (Create is disabled until it has text) and starts empty each time the dialog opens; it is no longer prefilled with the task title and description. Session title stays optional.
- New task → Start an agent now: same rule. "Instruction" is empty and required for "Create and start". "Create task" without an agent is unaffected.
- Exception (user decision 2026-11-04): when New task has at least one item picked with **From …** (any service), "Instruction" is optional and its placeholder reads "Optional: the agent starts with the attached items". An empty (or whitespace-only) instruction then sends the agent-facing default `Start on this card: read its inputs, including <names>, then begin.`, where `<names>` are the attached items' keys joined with ", " (a Confluence page by its title, its key being an opaque id). Typed text is sent as typed (trimmed, as before), without the default. Nothing is prefilled; without an attached item the instruction stays required. Logic: `client/first-message.ts`.
- Why: the session's system prompt already carries the task title, description and scope (`sessionContext` in `shared/scope.ts`, wrapped by `workingInstructions`). A prefilled copy duplicated that context and sent it as if it were the user's own message. The hint now says this context is included automatically.
- Verified live: both fields start empty and the buttons are disabled until text is entered. Fixture tests were updated for the new label.

## 7t. Project lanes (workflow), finished lanes no longer a filter, lane motion (2026-10-15, user request)

**Lanes are a project setting** (Edit project → Lanes). The 7 built-in statuses can be reordered (drag the grip on desktop, arrows on touch), turned on/off, and renamed (blank = built-in name). Stored as optional `project.lanes` (`[{status, enabled, name?}]`, all 7, unique, at least one on). Absent means the default workflow, so existing projects and cards need no migration. The user chose this over fully custom lanes.

Lanes define the workflow everywhere:
- Board columns, compact lane tabs, card "Move to", drawer status chip/menu, the task form, toasts and activity text use the enabled lanes, in order, by name (`shared/lanes.ts`).
- Server: creating, editing or placing a card into a lane that is off is rejected ("X is not a lane in this project"). Turning a lane off is rejected while it holds live cards ("Move the cards out of …"). The editor also locks those switches and shows the card count.
- Auto-status: A1 only moves a card to In progress when that lane is on; A1r only restores a lane that is still on.
- Agents: `get_task` returns `allowedStatuses` (agent statuses that are lanes of the project) and `lanes` (status + display name). `update_status` to a lane that is off fails with `STATUS_UNAVAILABLE`. The session context lists the lanes, and the skill and tool descriptions tell the agent to stay within them.

**Done/Cancelled are no longer a filter.** "Show finished" was removed from Filters; they are ordinary lanes. Turn them off per project or collapse them per host.

**Lane collapse/expand animates.** The lane frame eases its width between 44 px and 280 px. Width is layout, so the animation is JS-driven (`useMotionValue(..., layout=true)`). The new content fades in, and the frame owns the measurement used for drop targeting. Reduce Motion makes it instant.

Verified live: collapse widths 280→141→89→48→44 and expand 44→111→182→248→269→280; Filters without "Show finished"; editor locks In progress and In review (1 card each); renaming Todo to "Ready" and turning Backlog off updated the board; both were reverted afterwards (`docs/verification/lane-editor.png`, `lanes-board.png`). Unit tests cover the lane helpers, the server guards, and the agent allowed/unavailable statuses.

## 7u. Board overview row (2026-10-15, user request)

- A row under the toolbar summarizes the current project: live cards (archived excluded, regardless of search/priority filters) and how many are in Done; how many cards have a session working (with the session count when higher), or "Idle" when none do; "N need you" (open agent questions or permission requests); "N unread" (finished results not yet read); errors; and the In review and Blocked lanes by their project names. Zero counts and lanes that are off are hidden.
- "Needs you", unread and errors open the Attention list. Lane chips jump to the lane: on compact they switch the lane tab, on desktop they expand the lane if it is collapsed. The running chip uses the pulse dot. Chips fade in when they appear, and the row scrolls horizontally on narrow screens.
- Ruling (Noah, 2026-11-09): the In review and Blocked lane chips (and the divider before them) are removed from the row as noise; the lanes themselves are unchanged. Everything else in the row stays (count, running, needs you / unread / errors, Ideas, Memory, Insights); the lane-chip parts of the two items above no longer apply.
- Ruling (Noah, 2026-11-09): needs you, unread and errors are one chip, **"N need you"**: every open ask on the board's cards (DISPATCHER-SPEC §9.4, the bell's count), shown only when N > 0; a press starts the need-you step-through in the card sidebar. Beside it, **"N updated"** (cards the dispatcher saw change since you looked, DISPATCHER-SPEC §9.2) shows only when N > 0, is never part of need-you, and starts the updated step-through. The running chip shows "N running" only while a card has a session working; with nothing running there is no chip ("Idle" is gone). A divider follows the count only when a chip or Ideas / Memory / Insights follows, and sits between the status chips and Ideas / Memory / Insights only when both show. The count, Ideas, Memory and Insights are unchanged.
- The toolbar's old "N tasks" label now only appears as "N shown" while filters are active.
- Counting is `client/overview.ts` (`boardOverview`), unit-tested, including hiding lanes that are off.
- Verified on desktop (`docs/verification/board-overview.png`).

## 7v. Composer height shrinks again (2026-10-15, user report)

- Bug: on web the session input grew with long text but never shrank, because a textarea's `scrollHeight` never drops below its current height. Short text then sat at the top of a tall box while the attach and send icons stayed at the bottom.
- Fix: on web the height comes from an invisible, non-accessible copy of the draft laid out at the input's width, font and padding (pure React Native layout, no DOM). Native keeps `onContentSizeChange`. Both clamp to 36 px up to 108/160 px.
- Verified: empty 36 px → 4 lines 96 px → one line 36 px; the text and the attach icon share the same vertical centre.

## 7w. Compact board opens on the first lane with cards (2026-10-15, user request)

- On compact layouts a project opens on its first enabled lane, in lane order, that has visible cards, instead of always Todo. With no cards it falls back to Todo, or else the first lane.
- This happens once per project selection. A linked or Attention-opened card keeps its own lane, and the user's later tab choices are kept until the project changes.
- Verified in the compact layout: Ultra Kanban (Backlog and Todo empty) opens on In progress.

## 7x. Composer layout: text on top, actions below (2026-10-15, user feedback)

- The session composer stacks its content: attachment thumbnails (when any), then the text area spanning the full width, then an action row with attach images on the left and send/stop on the right. Multi-line text no longer sits between bottom-aligned buttons, and the buttons stay put while the text grows.
- One line is 28 px (20 px line + 4 px padding), clamped up to 108/160 px. The web mirror and native content size use the same padding.
- Verified with an empty composer and a three-line CJK draft (`docs/verification/composer-multiline.png`).

## 7y. Persisted filters; safe view-setting writes (2026-10-15, user request)

- Filters are remembered with the other board view settings (host-scoped `board-view`): `filterSearch` (saved 500 ms after typing stops), `filterPriority` and `showArchived`. They are restored once when the board opens, and "Reset filters" clears the stored values too. Sort was already stored.
- Fix: the board, session view and task form each saved the whole `board-view` document against the revision they last saw, and ignored `save()` returning false on a conflict. So one write could silently undo another (e.g. the sort lost when the last project or send behavior was saved). All writes now go through `useBoardView().update(patch)`. It merges the patch into the latest stored values, reloads and retries on a revision conflict (up to 4 attempts), and shows the change immediately until the stored values agree, reverting if it cannot be stored. The merge/retry logic (`saveMerged`) is unit-tested.
- Verified live: setting sort Priority, search "kanban", priority High and Show archived all survived a reload (3 active filters, search field restored); the user's original sort (Recent activity, no filters) was then restored and confirmed after another reload.

## 7z. Reasoning effort when creating an agent (2026-10-15, user request)

- The shared agent picker (New session, and New task → Start an agent now) has a Reasoning row between Model and Permissions. It lists the chosen model's own `thinkingOptions`. The first entry, "Model default (…)", names the model's default. It is hidden for models without options and resets when the provider or model changes (an unknown choice falls back to the default).
- The choice is sent as `config.thinkingOptionId` when the session is created (both creation paths). The remembered defaults (the newest session in the project's card workspaces) now include its reasoning option.
- Verified e2e with a disposable worktree card: the picker offered Model default (Medium), Off, Low, Medium, High, Extra High, Max and Ultra Code for Haiku 5.5. Choosing Low created a session that `paseo agent inspect` reports as `Thinking low` (model claude-haiku-5-5, mode bypassPermissions). Fixture wrapped up: session and card archived, worktree removed, test branch deleted.
- Observed once: the first attempt failed to create the worktree with "Cannot determine the selected repository's current named branch" (`git symbolic-ref HEAD` failed in the daemon), although the repository was on `main`. An immediate retry succeeded, and nothing was left behind. Not reproduced.

## 7aa. Smoother menu exits (2026-10-15, user report)

- Exits accelerate away: retained-presence exits (menus, chip menus, picker lists, disclosures, the drawer) use ease-in (quad, 160 ms) instead of the entrance's ease-out. The old curve dropped quickly and then lingered nearly invisible before vanishing. Entrances are unchanged.
- The context-menu backdrop exists only while the menu is open, so a closing menu no longer swallows the next click.
- When an item is chosen, the action still runs immediately (it is not delayed). Its first frames of work now fall into the slow start of the exit, so they no longer read as a stall.
- Measured on the Sort menu: closing by clicking outside now fades 1.00 → 0.99 → 0.96 → … → 0.17 → gone in about 190 ms. Before, it went 1.00 → 0.59 within 50 ms and then lingered near 0 until 186 ms.

## 7ab. Read means the user looked (2026-10-15, user report)

- Bug: a card finished but showed no unread state, while Paseo itself showed the workspace unread. Cause: 7q's auto-read marked any new attention read while the session view was mounted in the side bar, even when the user was working elsewhere. The read records showed `17a4e470` marked read 0.13 s after it finished, and `3ab69f92` 3 s after.
- Now a session is marked read only on user intent: opening it, a pointer press anywhere inside the session view, focusing its composer, or sending. Each open or interaction reads what is unread at that moment, once. A turn that finishes while the view merely stays open stays unread until the user interacts or reopens it.
- "Mark as unread" holds through plain presses inside the view. Focusing the composer, sending, "Mark as read" or reopening clear it.
- Verified with two windows: A kept the Init session open and untouched while B marked it unread (standing in for a turn finishing unseen). After 9 s it was still unread; one press inside A read it. The session ended read, as it started.

## 7ac. Prominent card priority (2026-10-15, user request)

- Urgent and High cards have a 4 px stripe down the card's left edge (danger red / warning amber) and a tinted pill at the start of the card's signal row (icon + bold label in the same colour). Low shows a muted icon and the word "Low". Normal shows nothing.
- The High glyph is now an amber up arrow (`ArrowUp`, `statusWarning`) instead of a grey signal icon, everywhere `PriorityIcon` is used (card and drawer property chip). `priorityAccent()` in `client/status.tsx` defines which priorities are emphasized.
- Verified on the live board (`docs/verification/card-priority.png`).

## 7ad. Steady typing on phones (2026-10-15, user report)

- Symptom: on the phone (remote daemon), each committed group of IME characters made the screen jump and disturbed the next group.
- Cause: the composer was fully controlled from the drawer's state. Every IME commit re-rendered the whole drawer and session view (transcript, chips, host sheet), and the value was pushed back into the input while the keyboard might already be composing again. Remote latency made the round trip and the re-render slower.
- Fix (native only; web stays controlled): the input owns its text (`defaultValue`, remounted by key only on outside changes). Changes reach the drawer through `createDraftReporter`: after 300 ms of quiet, and at once when the box turns empty or non-empty so the send button stays correct. The parent's echo of our own report is not treated as an outside change. Outside changes (draft restore, clear after send, Edit of a queued message) replace the text and drop any pending report. On native the draft buffer follows the input (`set` only on outside changes), so a quick send never loses the last characters. A pending report is flushed before sending and on unmount.
- Verified: unit tests for the reporter (batching, immediate flips, echo vs outside change) and the buffer; the desktop composer smoke test (type CJK + Latin, send enabled, clear). Not verified on a physical phone in this pass; the native app isn't scriptable from this environment.

## 8. Acceptance

| Check | Expected |
| --- | --- |
| Typecheck and `npm test` | Pass before reload |
| Reload | Only `paseo-ultra-kanban` reloaded; no daemon restart; board data untouched |
| Behavior parity | Project select/CRUD, filters, drag, actions menu, drawer resize, status change, edit/archive, session create/preview/send/mark-read/tools/open in Paseo all reachable with unchanged rules |
| Modal theme | Every host `Modal.Content` body still installs `Theme.Provider` |
| Appearance | Light/dark use only theme tokens and alpha tints |
| UI acceptance | User review in the real app; Luna UI acceptance UNRUN by user decision |
