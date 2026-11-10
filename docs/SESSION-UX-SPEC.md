# Session creation, cards and preview

Status: authorized by the user's 2026-10-14 session UI request. Validate native Agent pane embedding first; use the fallback below when the public host cannot embed it. Amends Phase 2 and UI/UX presentation, following the single-root model.

## 1. Capability gate and result

The installed plugin/client/protocol SDKs are 0.11.2. The public client UI exports Modal, Icon, ScrollView, FlatList, TextInput and UI helpers; no native AgentPane, AgentPanel or AgentCreatePane is exported. `PluginSurfaceProps.navigation` exposes `openAgent({agentId, serverId?})` and `openWorkspace({workspaceId, serverId?})`, but no native draft/create-pane entry point.

Before product edits, an in-memory TypeScript probe against the installed SDK rejected three native-pane imports (TS2305) and draft navigation (TS2339), while the two supported navigation calls compiled. Evidence: [capability probe](verification/fixtures/session-pane/native-pane-capability.json). The current public [plugin reference](https://paseo.sh/docs/plugins/reference) also restricts runtime imports and marks `/client/host` private. The local host's AgentPanel depends on app pane/focus providers, routes, stores, composer and timeline modules, not a standalone SDK component.

**Decision: native embedding is unsupported by this public SDK.** Implement a host Modal for creation and a plugin preview for viewing, with explicit navigation to the full native Agent pane. No private app import, second connection, DOM/iframe embedding, host fork change or SDK upgrade. This is an API boundary verification, not proof of live UI. A future host SDK can expose a supported component independently.

## 2. User flow

1. Open a task: task details, workspace and a vertical session-card list. No session output or creation form appears until requested.
2. New session opens a focused host Modal. Enter optional title and initial instruction; show the selected provider/model/mode summary. Advanced session settings expand when needed. Create uses the existing prepared-session flow with Kanban MCP/skill and explicit provider mode.
3. On success, close the modal and return to task overview; the new session appears at the top of the list with live execution status. Do not navigate away or send the first prompt again.
4. Click any session card to show its preview in the task sidebar. The preview header offers Back to task and Open in Paseo. Back restores the overview; opening native focuses exactly that agent on this host. Compact layouts use the same two levels at full width.
5. Preview recent output and send follow-up to that selected session. Full chat, attachments, permissions and native provider controls are available via Open in Paseo. The preview must not claim to be an embedded native Agent pane.

## 3. Session cards and state semantics

- One card per workspace session, including archived sessions already returned by the resource API. Sort newest created first; stable ID breaks ties. Show title, execution-state label/icon, provider/model, short ID and update time. Distinguish similarly named sessions.
- Execution state comes from public agent snapshots, with known lifecycle events as supplemental evidence. Priority: Archived; pending permissions / permission attention; Error; Initializing; Running; Closed; Finished turn; Turn ended; Idle/Ready.
- `attentionReason=finished` on an idle actor is a Finished turn signal. An idle actor's latest persisted `agent.turn_ended` can show Turn ended only when not superseded by a newer user message or turn-start event. Turn ended does not claim success. Without evidence, show Idle (or Ready if no prompt yet); do not infer successful completion from inactivity.
- Starting a new turn replaces the finished/ended appearance with Running. Pending permission and error remain visibly actionable. Business card status is independent and never changes because a session stops or finishes.
- Poll resource state while the sidebar is open. An error fetching sessions shows a retry affordance and stale-state notice when cached cards exist; it must not silently report zero sessions.

## 4. Creation modal and recovery

- Use the existing public workspace-scoped SDK creation, preparation RPC, preallocated ID, idempotency key, MCP config, system instructions and env. Preserve one-task/one-workspace ownership and current repo scope checks.
- Title and initial instruction are the primary fields. Provider/model/mode are grouped behind Session settings, with the chosen values visible when collapsed. Use actual availability; default model/mode semantics remain unchanged. New testing sessions are explicitly full-access Luna.
- Provider changes reset model and mode. Queries include provider and workspace directory, preventing cached capabilities from another directory. Surface transport exceptions and error strings returned in provider capability payloads. Show empty-provider/model states, hide non-selectable models, and disable submission during a request, model loading/error, unavailable workspace/scope or missing tool readiness. A synchronous lock prevents rapid duplicate clicks.
- If tools are unavailable, preserve the explicit Create ordinary session fallback. Do not silently create an ordinary session.
- Errors stay inside the modal with the draft and prepared operation intact. A retry first checks the prepared ID's actual workspace membership and archive state; recover a successful partial creation without repeating its initial instruction. Manual dismissal preserves the draft while this task drawer remains mounted. Do not dismiss during an active submission.
- Success clears the draft/attempt and refreshes session resources and task activity. The new session is highlighted in overview; no additional workspace, project or card is created.

## 5. Preview and navigation

- Selecting a card is explicit; resource refresh never automatically opens the first session. Overview and preview are separate sidebar modes. Switching actors does not send instructions.
- Header shows Back to task, session title/status, and Open in Paseo when navigation is available. Use the current host ID explicitly when opening native. Do not describe successful native focus until UI acceptance verifies it.
- Refresh the selected actor through the public SDK. Every newly opened preview uses a fresh, mount-scoped actor query (no reuse of an earlier preview's membership snapshot); release that query cache on unmount. Before timeline/tool access or message writes, require its workspace ID to equal this task's workspace. Missing, moved, archived or unavailable actors have an explanatory state; never fall through to another session.
- A preview has a fixed header, one bounded host ScrollView for recent output/tool details, and a separate bottom composer. Section 8 specifies formatting, sizing and tail following. Keep output/error/loading/empty states distinct. It is a recent-output preview, not full native history or a permission dialog.
- Fetch/subscribe to timeline only for the active preview; cancel observation on Back, actor change and unmount. Keep ordinary follow-up drafts per session during the current task drawer lifetime. Returning and choosing another session cannot transfer an unsent instruction.
- Show provider-unavailable warnings on cards/preview and disable writes until available. Native navigation can still open the session for diagnosis.
- Follow-up refreshes scope and actor membership before sending. It uses the latest running state to choose steer/interrupt; on failure retain that session's draft. A per-session lock owned by the task drawer survives Back/reopening the preview during a request, preventing duplicate sends and edits to the submitted text. Other sessions can still be previewed. On success clear only the submitted draft if it still matches, protecting any later text. Existing Send Kanban work instructions targets only this actor, preserves ordinary draft and does not hot-plug MCP.
- Native navigation is a client action and does not create a session, workspace or duplicate prompt. Hide unsupported navigation actions when the host does not provide them; retain Back to task.
- Explain read-only task/workspace failures inside preview. If the user leaves preview while a native-opening membership check is pending, do not navigate after that preview has unmounted; accepted message sends still complete normally.

## 6. Architecture and compatibility

- No storage, RPC, agent credential or native ownership migration. Root entries remain registration/composition only.
- `client/session-state.ts`: pure execution-state presentation, recent-output extraction and host navigation helpers.
- `client/session-card.tsx`: labelled session summary cards.
- `client/session-create.tsx`: focused host Modal and existing prepared-session creation/recovery logic.
- `client/session-preview.tsx`: selected-session SDK observation, output, targeted follow-up, tool access and Back/native navigation.
- `client/session-follow.ts`: follow-tail state, scroll callbacks and cancellable coalesced subscription refresh.
- `client/session-markdown.ts` and `client/session-content.tsx`: native Markdown subset parser and theme-aware preview rendering.
- `client/drawer.tsx`: task overview/workspace/activity, session list and local navigation. Uses the supplied SDK/context throughout.
- Theme and touch targets follow existing host primitives; choices wrap. Creation uses host Modal safe area, scroll and keyboard integration. The resize grip stays available while previewing. No HTML, CSS strings, localStorage or private host imports.

## 7. Verification and cleanup

Use one explicit full-access Paseo `codex/gpt-6-luna` verification session in the existing development workspace. It owns evidence, not implementation. No fixture project/workspace/card is necessary for compile/component checks; clean any temporary dependencies and test session at the end. Preserve all existing data. Reload only this plugin after typecheck.

Record PASS / FAIL / UNSUPPORTED / UNRUN separately in `docs/verification/session-pane.md`.

| Check                 | Expected                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Native API gate       | Unsupported embedding/draft entry confirmed; existing-agent native navigation accepted                                       |
| Session states        | Running/starting/permission/error/finished/ended/idle/archived remain distinct; never mutate task status                     |
| Overview/cards        | Newest first; status/title/model/ID visible; select opens only that actor                                                    |
| Create                | Modal, collapsed settings, draft-preserving errors, scope validation and one-submit lock                                     |
| Partial creation      | Reuse actual prepared actor; no duplicate creation or first-prompt replay                                                    |
| Preview navigation    | Back restores overview; supported native callback receives exact actor and current host                                      |
| Membership failure    | Missing/moved actor cannot expose timeline or receive follow-up                                                              |
| Draft isolation       | Back/actor changes retain per-actor text; failure retains; success clears only submitted text                                |
| Observation lifecycle | Overview has no timeline subscription; preview Back/change/unmount releases it                                               |
| Regression            | Typecheck, existing creation/recovery and invariant suites pass                                                              |
| Actual UI             | Wide/compact, light/dark, creation/preview/Back/native focus and message delivery checked only on a safely identified client |
| Cleanup               | Exact test session/temp paths absent; native project/workspace/card untouched                                                |

CUA must bind the user's non-fullscreen Paseo window by actual ID/title/geometry before any action. Current macOS inventory cannot do so; if still unavailable, actual UI/native focus/message delivery are UNRUN. Synthetic callbacks and compile probes cannot validate native rendering or routing. Stop for user review after delivery.

## 8. Preview layout and tail correction — 2026-10-14

The user's live feedback found plain-text formatting, a composer inside the output scroller and no follow-tail behavior. This amendment corrects the plugin fallback without changing resource, send or business-status contracts.

### Observable layout

- The preview fills the available sidebar height: header and composer do not shrink; only the conversation/tool-details body scrolls vertically. No page-wide horizontal scroller or gesture handler is added. Header title and provider/model wrap or truncate within the actual sidebar width.
- The bottom composer stays visible while reading output: bounded multiline input (72–120 pt), running-session steer/interrupt choices, send button, and operation feedback. Long drafts scroll inside the input rather than expanding the sidebar indefinitely. Sending, readonly, unavailable membership and draft/lock isolation follow section 5. Keyboard avoidance uses React Native on native platforms; the host owns the surrounding safe area.
- Summaries use compact, wrapping metadata with bounded titles, including long provider/model names and error text. Conversation rows distinguish You, Agent, Thinking and tool activity; message text never becomes a selectable task-card drag source.
- Agent text renders a deliberate Markdown subset using native primitives: paragraphs, headings, lists/task lists, quotes, fenced code, rules, inline emphasis/code and HTTP(S) links. Code wraps at sidebar width. A fenced block whose language is `ui` or `app` (inline UI that plugins such as genui render live in the host session view; timeline transformers never run inside flowly's preview) renders as a compact collapsed notice — "Inline UI — open in Paseo to view it live" — expandable to the still-selectable source; detection compares the fence's first language word, case-insensitively, matching genui's rule. Markdown tables become vertical labelled rows to retain all cells on phones and avoid horizontal gestures. Unsupported syntax and incomplete streamed Markdown remain readable text; no HTML rendering, private host renderer or new runtime dependency.
- ~~The preview remains limited to the newest 35 timeline entries / 18 displayed entries.~~ Superseded 2026-10-20 by [SESSION-PANE-SPEC](SESSION-PANE-SPEC.md): the preview opens on the current turn (≤ 300 entries) with Load earlier (≤ 1000). Use sequence-backed message keys when supplied. Full history beyond that, attachments and native permissions remain in Open in Paseo.

### Following new output

- Every newly opened preview follows the latest output initially. Scroll to the end on initial output, changed text/tool activity and content/viewport size changes while following. Streaming growth of an existing row counts as new output, not just an increased message count.
- A user scrolling more than 64 pt above the end suspends following immediately; subsequent updates do not pull them back down. Returning within 64 pt of the end resumes following. A visible Jump to latest action resumes and scrolls to the newest output. Programmatic scroll events must not accidentally disable follow mode.
- Running/starting sessions show an activity indicator at the conversation tail even before text arrives. Turn end removes it without changing the card's business status. Polling plus a coalesced subscription refresh delivers the last event in a burst; replacement/reconnect trigger a fresh projected read. Late timers are cancelled on Back, membership loss and unmount.
- A successful instruction returns to following the newest output. Failed instructions retain the draft and the user's scroll position. Membership/read failures still block writes and do not reveal another workspace's conversation.

### Acceptance and evidence

Use a new full-access Luna 6 test session in the existing development workspace. Evidence belongs in `docs/verification/session-layout.md` and its fixtures. No test project/workspace/card is needed; delete the exact test session and temporary renderer after verification.

Focused checks cover Markdown blocks/partial fences/table preservation, stable keys/tool summaries, composer outside the output scroller with bounded input, long metadata width constraints, initial follow, same-row streaming growth, scroll-away suspension, resume/Jump to latest, composer/viewport resize, successful-send resume, coalesced trailing refresh and subscription/timer cleanup. Run typecheck before reloading. Record actual desktop/phone scrolling, keyboard positioning and visual rendering as UNRUN when the non-fullscreen window cannot be identified safely. Synthetic callback evidence does not prove real gestures or pixels.

## 9. Compact phone composer — 2026-10-14

The phone capture showed the fixed input area taking too much of the session preview: a visible label, an 80 pt box, a keyboard hint, a separate running-action title/choice row, and a full-width send button. The available output viewport shrank further while the keyboard is present. Preserve the existing wide layout and send/permission semantics, but use the compact layout flag from the task drawer to render a smaller phone composer.

- Keep one bottom-fixed composer outside the output ScrollView. On compact layouts, the message box and a 48 pt send icon button share the first row. The box starts at 48 pt, grows with content up to 96 pt, then scrolls internally for longer drafts. The placeholder and accessible label/hint convey its purpose; omit the separate visible label and persistent keyboard hint on compact layouts. Web Enter/Shift+Enter and native keyboard Send retain the existing guarded path.
- During a running turn, show two equal-width, 48 pt touch targets labelled **Steer** and **Interrupt** in one row below the input. The selected mode remains visible through the theme accent border. The Send button uses that mode; the compact label is shorter because the send action is separate. Idle sessions omit the mode row. Pending/readonly state disables mode changes and sending without dropping the draft.
- When follow-tail is paused, a 48 pt Jump to latest icon sits in the input row instead of adding a separate full-width row. Errors and action feedback remain readable when present. Respect the host sheet safe area and keyboard behavior; no nested scroller or horizontal gesture is introduced.
- Acceptance: inspect phone portrait with and without keyboard, long draft, running/idle/readonly state, paused follow, light/dark theme, accessibility labels and 48 pt targets. Confirm latest output remains visible and that keyboard/button delivery still targets the chosen session exactly once. Use existing resources where possible; clean up any fixture created for testing. Desktop/compact app UI and Android real-device checks must be recorded separately from source/typecheck evidence.

## 10. Inline native composer — 2026-10-15

Supersedes the native bottom-sheet composer of §9 at the user's request (phone and tablet). Native iOS/Android render the same inline composer as web, fixed below the transcript: no tap-to-open bar and no composer Modal.

- Keyboard: `client/keyboard.ts` measures the session view in window coordinates and pads its bottom by the part the keyboard covers (`keyboardOverlap`). It re-measures on every keyboard frame event (iOS `keyboardWillChangeFrame`/`WillHide`, Android `keyboardDidShow`/`DidHide`, which also fire for IME candidate-bar and keyboard switches) and on the view's own layout, so it converges to zero when the host already resizes or pans the window. iOS animates with the keyboard curve unless Reduce Motion is on. Dragging the transcript dismisses the keyboard (interactive on iOS).
- Sync with the IME (user report, 2026-10-15: lift/drop lagged the keyboard): the composer is lifted with a native-driver `translateY` (UI thread, no per-frame layout), opaque so the transcript does not show through; the transcript gets a matching bottom padding once per change so its end stays reachable. The view's bottom is cached from its own `onLayout`, so a keyboard event computes the inset synchronously with no `measureInWindow` round trip or session re-render. iOS animates with the event's duration on a keyboard-like curve. Android's RN events arrive only after the IME finished animating. Paseo's own composer avoids that with react-native-keyboard-controller + Reanimated, which plugins cannot import; but the host mounts keyboard-controller's `KeyboardProvider`, which broadcasts `KeyboardController::keyboardWillShow/WillHide` on `DeviceEventEmitter` at the start of the IME animation with its height and duration (also on IME height changes). On Android the hook animates on those events (height minus a gap calibrated against RN's exact did-event, initially 0) and lets RN's did-event correct the final value. If those events never arrive (older host), it falls back to moving on input focus/blur with the last keyboard height. Reduce Motion jumps without animation.
- Android coordinates: RN reports the keyboard's `screenY` in screen coordinates while `measureInWindow` is relative to the visible window frame (below the status bar), so the keyboard top is shifted by `StatusBar.currentHeight` before comparing. Without it the composer stayed covered by the status-bar height (user's Android capture, 2026-10-15). On Android 11+ RN only emits keyboard events when the IME shows/hides, not when its height changes.
- Input: native keeps owning its text (§9 draft batching). Clearing after a send calls `clear()` so the keyboard stays up; other outside changes remount the input and refocus it if it was focused. Native return key sends; the send/stop button is unchanged.
- Dropped characters (user report, 2026-10-15): the native input passed `defaultValue={draft}`. RN's TextInput uses `defaultValue` as its `text` prop, so each debounced draft report (up to 300 ms stale) was pushed back into the native view and erased characters typed meanwhile. The native input now takes `defaultValue` from a seed that changes only with an outside change (restore, queued-message edit, clear), together with a remount. Daemon draft persistence was not the cause and stays: it only receives the batched text.
- Running behaviour: the "When running: …" chooser shows below the composer on every platform while the session is running or has queued messages; the Enter/Shift+Enter key hints stay web-desktop only. Chip menus float above the composer on native too.
- Acceptance: typecheck, `keyboardOverlap` unit test, full suite. Real-device keyboard behaviour (iOS/Android phone and tablet, Chinese IME candidate bar, split view) is UNRUN until checked on device.

## 11. Smooth text input everywhere — 2026-10-15

All plugin text fields use `TextBox` (`client/ui.tsx`) through `Field`, the picker search and lane-name inputs. Native: uncontrolled with a seed that changes (with a remount) only on outside changes, so typed text is never pushed back. Web: local state, so a keystroke re-renders only the input. The board filter search commits after 150 ms of quiet (and on blur) because filtering re-renders the whole board; its persistence was already debounced. Rule recorded in AGENTS.md ("Text input").

## Composer simplified (2026-10-23, user request)

The line under the message box (the "Enter to send · Shift+Enter for a new line" key hint and the "When running: Queue" chooser with its modal) is gone. The running-session send behaviour (Steer / Queue / Interrupt, `sendBehavior` in the board-view settings) is now chosen in Settings → General → Sending messages; the keys are unchanged (Enter sends, Shift+Enter a new line, ⌘/Ctrl+Enter the alternative). The send button's accessibility hint still describes what Enter does while running.

## Queued row without flicker (2026-10-25, user report)

Sending while the session runs showed the new queued row flash once. Cause: the row is shown at once under a temporary id (`pending-…`) and the daemon answers with its own id; the row was keyed by id, so React rebuilt it and replayed its entry, and the temporary row hid Steer and greyed Take back / Remove, so the row also jumped. A composer poll already in flight could also land without the new message and drop it for a moment. Now (`client/composer.ts`, `client/session-preview.tsx`): the confirmed message takes the temporary one's place and keeps its row key (`queuedRowKey`); an in-flight poll is cancelled before the row is shown, and until the daemon has confirmed every queued message no read lands (polling, focus/reconnect/mount refetches and refreshes wait; the last answer refreshes once); while temporary, the row looks and lays out exactly like a confirmed one and its buttons ignore presses.

## Sent message shows at once (2026-10-25, user report)

A message sent from the session view reached the transcript only after the send's checks (session status and card context, read in parallel), the send itself and the next transcript read, often a second on a phone over the relay. Now the transcript shows it as soon as Send is pressed (`echo` on the transcript handle, with the same `messageId` the send carries) and jumps to it (a jump cancels an older-output position restore still pending on web); when the timeline brings the session's own record of that message (matched by `messageId` / `clientMessageId`), the record takes the echo's place under the same row key (`<messageId>-user`), so the row is not rebuilt. A failed send removes the echo (the text goes back to the message box as before); an echo whose record never arrives is dropped after 60 s. Queued messages are unchanged: they show as queued rows until the turn ends.
