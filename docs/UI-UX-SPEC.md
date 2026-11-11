# Board interaction and layout refinement

Status: implementation authorized by the user's 2026-10-14 UI/UX request. This amends Phase 1/2 presentation only and follows `SINGLE-ROOT-SPEC.md`.

2026-10-14 amendment: [MOTION-SPEC.md](MOTION-SPEC.md) supersedes inline success feedback with native toasts, extends non-selection to lane text, and defines shared navigation/drag motion plus reduced-motion and interruption behavior.

2026-10-14 drawer amendment: [DRAWER-SPEC.md](DRAWER-SPEC.md) removes width buttons and workspace navigation, groups Status/Edit/Archive and collapses metadata/workspace. Its measured accordion height animation is the bounded exception to the default motion policy.

2026-10-14 Android modal theme correction: the compact project chooser exposed `Error: Theme missing` from the plugin's own `useTheme` in a modal `Button`. Paseo's host Modal may render its body across a native context boundary. Every plugin-owned host `Modal.Content` that contains plugin `Button`, `Label`, `Field`, `Choices`, or `Notice` must install a fresh provider for the current `PluginTheme` **inside** the modal body. The board passes its screen theme; project/task/session forms capture their theme before entering the host Modal and bridge it into its content. Changing theme while a modal is open updates that provider. This is a client-only correction: project selection, forms, filters, status and task actions keep their existing behavior, RPC contracts and board data. Acceptance requires typecheck before reload, source inspection of every host modal body, and an Android open/dismiss interaction for the project chooser plus other affected forms when a safe device target is available. A running plugin or desktop-only render does not prove the Android crash fixed.

## 1. Goal and scope

Make the task board the primary surface. Reduce persistent project-management chrome, support desktop mouse drag between status columns, resize the desktop task drawer, and give phones a reliable vertical task list without a horizontal board gesture competing with Paseo navigation.

Keep project CRUD, task search/priority/archive/finished filters, task creation/edit/archive/reorder, workspace ownership, selected-session follow-up, tool access and activity available. Resource contracts, one-root scope, storage v3 and agent completion rules remain as currently specified.

## 2. Board toolbar and secondary controls

- One compact toolbar contains the selected project (opens a project chooser), task count, Filters, and the primary Add task action. Paseo already supplies the screen title; remove the duplicated large plugin title and tagline.
- Project chooser is a host Modal with a vertical project list, the current root/description, Create project, Edit project and Archive/Restore project. Archived records are discoverable through the filter control. An empty board offers project creation directly.
- Filters are collapsed by default and open in a host Modal: search, priority, show archived, show finished and refresh. Active filters have a concise toolbar indication and a clear reset action. Changing the project closes its card drawer and cancels any drag.
- The board body fills the remaining bounded height (`flex: 1`, `minHeight: 0` throughout its parent chain). Error/feedback are concise and actionable. Secondary controls do not form permanent extra header rows.
- Cards show priority, title, session activity/workspace availability and archive/legacy indicators. Remove the repeated project-root label from every ordinary card. A card action menu contains explicit status selection, so dragging is optional.
- **Board card menu** (2026-11-10): the card's ⋯ button, right-click and long-press open the same menu (anchored popover on wide layouts, bottom sheet on phones): *Open details*, *Start session*, *Move to* (one row that opens a submenu of the project's lanes, current one checked, *Back* returns), *Archive card* / *Restore card* and *Delete permanently…* (danger, last). Conditions and disabled states are unchanged: *Start session* and the lanes are disabled while a change is pending, for an archived card or an archived project; *Archive/Restore* and *Delete* while pending or the project is archived. *Switch to worktree/local…*, *Link to a card…*, *New follow-up task*, *Open workspace* (the card's ↗ button) and *Dismiss from / Restore to Attention* are in the card sidebar's ⋯ menu, not here. *Move up* / *Move down* are only in the phone sheet (phones have no card drag, §5), never on the All board.
- Ruling (Noah, 2026-11-10): the board card menu keeps only Open details, Start session, a single Move to row that opens a submenu of lanes, Archive card / Restore card and Delete permanently… (danger, last). Move up / Move down are removed from it (drag covers reordering; the phone sheet keeps them because it has no drag), and Switch to worktree/local, Link to a card… and New follow-up task move to the card sidebar's ⋯ menu only.
- Ruling (Noah, 2026-11-10): a card menu always fits on screen: it opens below the press point, else above it, else pinned to the top and scrolls, so no row is cut off on desktop or phones. Cause of the report that Delete did not show from the board (reproduced, `docs/verification/board-menu-repro.md`): the ⋯ button opened a separate action sheet with no Archive or Delete, and the right-click popover (which had both) was cut off at the bottom and could not scroll in a window about 600 points tall.
- Automation names: every board card's accessible name starts with `Open task {title}` and names the card's lane (lanes are statuses; the lane name covers both), so Playwright `getByRole("button", { name })` and Android `uiautomator` can find and open a card by its title alone. Stable `testID`s are contract for verification scripts and must stay literal: `card-{taskId}` on the card, `lane-{status}` on a desktop lane frame, `lane-tab-{status}` on each status-chooser row, `lane-chooser` on the compact status control, `lane-page-{status}` on each phone pager page, `task-drawer-motion` on the open card's sidebar. Never style by them. `docs/promo/shot-lib.mjs` (`openCard`/`closeCard`) is the reference consumer.

## 3. Desktop drag to change status

2026-10-15 amendment: drops now also choose a position (same-column reorder or cross-column slot) through `tasks.place`; see [DRAG-REORDER-SPEC.md](DRAG-REORDER-SPEC.md).

- Updated per the user's whole-card request: enable drag from the entire card on expanded web/desktop layouts. Record a primary mouse pointer press through React Native pointer events; moving at least 8 points while it is held starts a drag. Touch/pen, right-button presses and presses originating on Actions are ineligible, preserving touch scrolling and button operation. A normal body click opens details; a drag suppresses that click.
- All card text, including priority, title and session metadata, is explicitly non-selectable in both desktop and compact layouts. Use React Native `Text.selectable=false` and its `userSelect: none` style; the floating drag preview is also non-selectable. Text selection in task details and inputs keeps its existing behavior.
- Use host React Native `PanResponder` and measured layout, with no HTML drag events, DOM APIs, global browser listeners or new runtime dependencies. Mobile/touch layouts do not install the board drag responder.
- Drag carries a snapshot of task ID, project ID, status and task revision. Show a floating task label and accent the currently eligible target column. Source card becomes subdued. Header/filters/drawer are never drop targets.
- A drop inside a visible status column different from the source calls the existing schema-validated `tasks.update` once with `{id, revision, status}`. It changes business status only; no workspace/session is created, moved or instructed. Existing position semantics are retained. Same-column, outside-board, cancelled/terminated gestures do not write.
- Horizontal desktop edge scrolling makes offscreen columns reachable during a drag. Scroll offsets participate in hit testing; targets outside the board viewport are rejected. Regular wheel/trackpad scrolling remains available when not dragging.
- Archived tasks/projects and an in-flight mutation cannot start a drag. During a pending drop disable further drag/reorder writes; refresh after success. Report the destination status on success. On failure, refresh and show the error without optimistic status changes or retrying against a newer revision. Concurrent changes return the existing stale-revision error.
- Leaving the surface, a dragged card disappearing, changing project/filter/layout or losing the responder cancels drag and stops edge-scroll timers. Releasing after cancellation cannot submit an old drag.
- 2026-11-10 board pan (user request, desktop/web only): a primary mouse press on empty board space (board background, gaps between cards, lane headers, empty lane area, collapsed lanes) that moves at least 8 points (`dragThreshold`, shared with the card drag) pans the board horizontally with the pointer, clamped to the scrollable range and applied immediately (no animation). Below the threshold the press is a plain click, so header buttons and a collapsed lane's expand still work; once panning starts the press does not fire its click. A press that begins on a card never pans (card drag wins, also for cards that cannot be dragged); a card drag in progress never pans. Touch, pen and right-button presses never pan, and the responder is not installed on touch platforms. Over pannable space the cursor is `grab`, `grabbing` while panning, and text selection is off while panning. Same for project, group and All projects boards (one `DesktopColumns`). Uses only React Native `PanResponder` and pointer props with the existing `cursor`/`userSelect` style props: no web-only exception. Phones (§5, lane pager, host sideways-swipe) are unchanged. Decisions are the pure `boardPanDecision` and `panOffset` in `client/geometry.ts`. The press is recorded by the board viewport's bubble-phase `onPointerDown` (`boardPress`), with a card's slot marking the same native event on its way up; RN-web's `View` does not forward `onPointerDownCapture`, so a capture handler never runs on web.

## 4. Resizable task drawer

- Expanded layout has a visible vertical resize grip between board and right drawer. Mouse drag changes width immediately; accessible Narrower/Wider/Reset controls provide the same operation without dragging.
- The width is a share of the Flowly area (the surface holding board, grip and drawer). A drawer that was never dragged opens at 50% (user decision 2026-10-29, formerly 440 points). Clamp to a minimum of 340 and enough remaining board width (at least 300 points plus grip); there is no fixed maximum (user decision 2026-10-29, formerly 720), so the window alone limits how wide it gets. On window resize the same share applies again, then the clamp. The dragged width is remembered (user decisions 2026-10-27 and 2026-10-29) as that share, not in points, so it scales between screens: saved once on release as host-scoped `board-view` `drawerShare` (0 = never dragged, then 50%), restored when the board opens. The earlier point value `drawerWidth` is ignored, so a drawer dragged before opens at 50% once. No localStorage.
- If host layout is compact, platform is iOS/Android, or measured surface width is below 760, show task detail at full width with Back to board; hide the resize grip. Preserve the selected card and session when crossing the breakpoint.
- Drawer content has a bounded vertical host ScrollView. Status/session/model/mode choices wrap instead of requiring horizontal swipe; headers/action rows wrap on narrow widths. The latest output remains bounded and vertically scrollable.

## 5. Phone and narrow layouts

- One full-width vertical task list for the selected status. A tappable status control opens a vertical status chooser showing counts. No card drag responder, so the card's action sheet keeps *Move up* / *Move down* (§2).
- 2026-10-31 lane swipe (user request, modelled on better-paseo; supersedes the earlier "no horizontal pager, no swipe-to-change-status" rule): on iOS/Android the lanes are the pages of a native horizontal paging `ScrollView` (`client/lane-pager.tsx`), in the shown status order. A horizontal drag follows the finger; release settles on the nearest lane, which becomes the selected status (header title and count update). Only the selected lane and, once the board has been idle for a moment, its two neighbours are mounted; other pages are empty placeholders of the same width. Choosing a lane in the status chooser jumps there without scrolling through the others and keeps the existing fade. Web (any width) keeps the single list; the status chooser is its only switch.
  - **Sidebar swipe.** Paseo opens its agent list on a rightward swipe from anywhere on a phone. While the board is not on the first shown lane, the pager reports itself as scrolled sideways to Paseo's horizontal-scroll registry, so that swipe goes to the pager (previous lane) instead; on the first lane, a rightward swipe opens the agent list as everywhere else. A leftward swipe never conflicts. The registration is dropped while a card, a page or no project covers the board, on unmount and when the registry cannot be found (then a rightward swipe past the first lane may open the agent list, and the pager still works leftward and from the chooser). It never throws.
- 2026-11-01 Android Back (user request: Back closed Flowly from anywhere): while the Flowly screen is focused, the Android Back button takes the same steps as Esc, one level per press: a session view returns to its card, a card closes back to the page or board under it, a page (Ideas, Search, Memory, Insights, Guardrails) closes back to the board, and only the bare board lets Back reach Paseo, which closes Flowly as before. An open host modal or sheet takes Back first. Back is not taken while a Paseo screen pushed over Flowly (an agent or workspace) is focused; `client/android-back.ts` finds the screen's navigation object through the React fiber of the board root and asks it at each press. When it cannot be found, Back keeps Paseo's behaviour. iOS and web have no Back button and are unchanged.
- Default selected status is Todo. Backlog/In progress/In review/Blocked and optionally Done/Cancelled remain reachable. If finished statuses become hidden while selected, return to Todo. Status selection is view state, not a task update.
- A single host ScrollView owns task-list vertical scrolling. It has explicit flex bounds, keyboard tap handling and nested scrolling support; on iOS/Android its only horizontal parent is the lane pager. Header stays small and fixed. Cards/actions are reachable at the end of a long list.
- 2026-10-31 compact header (user request: the project name had too little room): the compact board header holds only the project switcher (it takes all remaining width and ellipsizes only when the title is longer than that), Attention, Search and Filters, in that order. Desktop is unchanged.
  - **New task** is a floating action button at the bottom-right (accent fill, Plus icon, label `New task` for screen readers; the bottom-left Settings button keeps its place). It shows only on the lane list: hidden while a card, a page (Search, Ideas, Insights, Guardrails, Memory) or no project is open, and for an archived project. It creates in Todo, like the desktop header button. The lane list's bottom padding clears it so the last card stays reachable.
  - **Sort** moves into the Filters dialog on compact (`Sort cards` choices below Priority, plus **Card display…**, which closes the dialog and opens Settings → Cards once it has closed). The Filters icon is lit while filters are active or the sort is not Manual; the badge still counts filters only.
  - **Group settings** is not in the compact header: the group switcher's **Group settings** row opens the shown group's page (BOARD-GROUPS-SPEC §5).
- Host Modal handles safe areas, keyboard, back/dismiss and its own sheet gestures. Use host ScrollView/TextInput in modal/forms and wrap choices rather than horizontal scroll strips. Preserve Paseo's navigation and edge gestures; the lane pager above is the only plugin surface that takes native horizontal touches, and it yields the sidebar swipe on the first lane.

## 6. Compatibility, errors and architecture

- No RPC/schema/storage migration. Use existing CAS mutation semantics and public SDK. Current one-root and legacy read-only scope rules remain intact.
- New client-only geometry helpers contain pure drag hit testing, edge scroll and drawer clamping. Components stay under `client/`; root entry registration stays small. All surfaces use host theme colors in both appearances.
- Surface width measurements are local layout state. Until measured, use host compact/platform hint and safe drawer limits; do not guess native device identity.
- Project/form/agent service failures retain current draft/error handling. A mutation rejection never reports successful movement. Invalid/outside drop simply returns the card to its current column.

## 7. Implementation order

1. Write this complete contract; inspect pinned host modules and existing UI.
2. Build compact toolbar/chooser/filter and adaptive board/card components.
3. Implement measured desktop drag and width control; adapt drawer/forms scrolling.
4. Typecheck, focused geometry/interaction tests, full existing regression suite, then reload only `paseo-ultra-kanban`.
5. Explicit full-access Paseo `codex/gpt-6-luna` independent verification and user review. Test resources must be recorded and removed at the end; prefer synthetic client fixtures when native resources are unnecessary.

## 8. Acceptance and evidence

Record PASS / FAIL / UNRUN separately in `docs/verification/ui-ux.md`.

| Check | Expected result |
| --- | --- |
| Expanded toolbar | One small row; project CRUD/filter/refresh remain reachable; tasks fill remaining space |
| Drag vs click | Click opens; threshold drag does not open; target feedback matches column |
| Whole-card pointer origin | Primary mouse drag can start at title/priority/metadata/background; touch, pen, right button and Actions do not start drag |
| Card text selection | Every card text node and drag preview explicitly disallows selection |
| Drop rules | Cross-status writes once with captured revision; same/outside/cancel/archived does not write |
| CAS failure | Original server status remains authoritative; error shown, no automatic retry |
| Edge scrolling | Offscreen columns reachable; viewport/offset hit test correct; timers stop |
| Board pan | Mouse drag on empty space/headers pans after 8 points and clamps; a press on a card, touch, pen or right button never pans; click under the threshold still works; cursor grab/grabbing; no selection while panning |
| Drawer | Grip and buttons resize within bounds; resize window clamps; compact details full-width |
| Mobile list | Long list scrolls to last task; no horizontal board/choice scroll strips; status chooser works |
| Mobile detail/forms | Vertical content and keyboard usable; status/session selection/follow-up reachable |
| Appearance/accessibility | Light/dark text and drop/grip contrast; labelled alternatives; touch targets |
| Regression | Existing invariants/tools/session/resource tests and typecheck pass |
| Native resource cleanup | No new test project/workspace/card/session/directory remains after verification |

Actual Paseo UI tests may operate only on the identified non-fullscreen window (actual ID/title/geometry). If computer-use cannot bind it unambiguously, stop UI actions and record UNRUN. A synthetic render/interaction harness is useful component evidence, not proof of real Paseo gestures or a phone. Do not count old screenshots as verification of this revision. No daemon restart.

## 9. References

Implementation checked against installed Paseo SDK 0.11.2 contracts and the current [plugin reference](https://paseo.sh/docs/plugins/reference), including host scroll integration. Gesture and bounded-height behavior follow primary [React Native PanResponder](https://reactnative.dev/docs/0.81/panresponder) and [ScrollView](https://reactnative.dev/docs/0.81/scrollview) documentation. Installed host version remains the compatibility authority.
