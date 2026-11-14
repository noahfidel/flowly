# Mobile query visibility and first task form — 2026-10-23

2026-10-24 For the current decision see [unified width policy](RESPONSIVE-PERFORMANCE-SPEC.md): every compact layout
pauses covered root queries, the Sidebar always reads lightweight counts, and TaskForm always waits for the transition to settle before starting heavy content.
This replaces this file's historical native-only/Web parallel branches; the fresh check, the stable input node and the 450ms handoff are unchanged.

Scope: follow the [phone assessment](verification/mobile-perf-2026-10-23/README.md). Reduce plugin-owned invisible work and first TaskForm work; no host/transport changes, global cache, dependency, or authorization shortcuts.

## Behavior

- On native compact layout, the retained board is inactive while a task drawer, project page or TaskForm covers it. Its resource, managed-session, summary, receipt, memory and agent-stream observers are disabled; per-card output observers are disabled through context. The tree and scroll position remain mounted. Visible drawer/page observers continue independently using shared keys. In particular, only a native compact drawer overview polls the shared board every 3s while active and no session preview is selected (desktop/tablet roots already poll, so their drawers never add an interval), so external edits/deletion still update its props; this is visible-data work, not a promise of zero full-board RPCs while a card is open. Desktop remains active.
- The complete board starts/joins one explicit fresh read after each direct card link resolves, even while covered and even if an older full board is cached; the board root observer is disabled while covered. Visible detail observers and explicit refresh/invalidation remain responsible for current detail data. Returning enables normal reads immediately. Never cancel shared in-flight work or replace board cache/etag when hiding.
- Sidebar visibility is not supplied by the host. Instead of guessing, native SidebarEntry requests `attention.count {}` every 15s. Response `{count: integer >= 0 | null}` contains no board/session payload. The daemon pages active SDK agents locally and uses the exact same pure attention rule as the board, including archived projects/tasks, dismissed signals, questions, permissions, errors and read receipts. Board/agent failure rejects the call; receipt failure omits only unread-only signals, matching current behavior. Error/unavailable hides the badge; no stale count is presented as current. No TTL cache is introduced. Web keeps shared board/agent observers.
- Native TaskForm initially renders the stable Title and Description fields and a loading indicator. After the existing `useSettled` transition boundary (220ms + 32ms; immediate under Reduce Motion), it mounts optional controls and enables board/connector/provider discovery. Workspace resources are requested only for Link existing. Title/Description retain their element position and identity across this change; native TextBox continues owning typed text. Desktop retains immediate content.
- Save/Create is disabled before form readiness and, when starting an agent, until discovery and required instruction are ready. Cancel remains available immediately. Unmount cancels the settle timer. No change to form payload, server validation, permission mode, fresh task/workspace/session authorization or stale-route rejection.
- Existing opt-in perf log adds `task-form.open.mount` and `task-form.open.settled` (tap/open dispatch to first commit and deferred content start). They are plugin spans, not proof of all data ready.
- Keep `MODAL_CLOSE_MS=450` and the existing modal-to-modal handoff. No new setting, feature or navigation entry, so tour/tip/What's new are not warranted; existing guidance remains accurate.

## Validation

1. Focused count/rule tests cover paging, dismissed/archived/read/error/permission/question signals, read failure and SDK failure. Query observer tests cover disabled polling/stream and re-enable; guard current fresh route tests.
2. Typecheck before reload. Independent full-access `codex/gpt-6-luna` reviews source and runs focused then one full suite on stable inputs; preserve actual commit/dirty and hashes.
3. Same Samsung SM-S911B, original connection path, powered stay-awake: cold shell → sidebar → Flowly → first TaskForm, warm reopen, same card/Back, session preview/Back, Sort → Cards settings handoff. Use proven sidebar bounds selection and reject ambiguous targets. Record sampled bounds, app spans and tool reconnects separately. Compare prior cold modal 2.476/2.500s and cold entry 7.835/7.161s without claiming precision or improvement unsupported by intervals.
4. Verify count payload and count-rule parity over live data, hidden-query policy, fresh card guard. Cancel all forms; no user message or resource creation for phone navigation. Restore log=false/original session and preserve stay-awake=15. Delete only this phase's test session and check native/plugin absence.

Unrun device/IME/component-race gaps from the assessment remain explicit unless actually covered. This change does not claim to solve the host connection's cold-start delay.


## Native overview amendment — 2026-10-23

For ordinary native compact overview, replace the first complete-board dependency with BoardOverview. Explicit detail/forms/pages retain the complete Board path; disable its root observer/interval otherwise. Overview does not enter complete cache or fresh authorization. All child consumers must be absent or disabled through the first-display/idle window; mounted and phone verification are required. Existing query visibility, retained tree, native input and 450ms handoff constraints remain. [Two-stage spec](NATIVE-OVERVIEW-SPEC.md).


2026-10-24 CardDetail: the drawer's Progress/Workpad/Tags/Links/Ideas/Artifacts no longer create a full-board observer; a separate detail/project index supports each section, LinkPicker indexes on demand and does not borrow the full cache. Session preview pauses the detail interval. Continuous reversible animation and MODAL_CLOSE_MS=450 are kept; the input seed/key, focus and drafts are not reset by background refreshes. See NATIVE-OVERVIEW-SPEC §7.
