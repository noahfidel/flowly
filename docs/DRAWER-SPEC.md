# Task sidebar hierarchy

Status: authorized by the user's 2026-10-14 sidebar redesign request. This replaces the earlier drawer width buttons, flat status choices and separate workspace block in UI-UX/session specs. Single-root, session ownership and business-state rules remain current.

2026-10-15 drawer dropdowns: Status, Type and Priority buttons open a dropdown anchored below the button (a sheet on phones/native) and save the chosen value directly. Supersedes the Status selector/modal described below. See [TASK-TYPE-SPEC](TASK-TYPE-SPEC.md#ui).

2026-10-14 compact status-label correction: the user-provided phone capture shows the selected value as `T...`. The installed Paseo 0.11.2 `SettingsSelect` uses a `SettingsRow` whose label has `flexBasis: 160`; the plugin constrained the entire selector to at most 240 pt, leaving too little space for the value and chevron. On compact layouts, replace that row with a full-width, themed Status button showing the complete selected label, and open a host Modal containing the seven status choices. Keep the chooser collapsed until tapped and in the same header action group as Edit and Archive. Use the existing guarded task-update/CAS/toast flow for a different value; the same value makes no write. Disabled/archive/inactive/pending behavior and card/session status independence remain unchanged. Bridge the plugin theme inside `Modal.Content` for Android. Wide layouts keep the host `SettingsSelect`. Acceptance requires source/typecheck and focused compact selected-label/action/disabled checks; actual phone text visibility and modal gestures remain a separate device check, deferred under the user's code-only acceptance choice.

2026-10-29 Open workspace in the header (user request, card "button to open associated workspace"): replaces §4's "No Open workspace action". See [Open workspace](#open-workspace).

2026-10-29 Worktree / Local in the header row (user request, card "badge for worktree vs local"). See [Workspace kind](#workspace-kind).

2026-10-19 sidebar tweaks (card "UI/UX 调整"): see [Section order and Artifacts paging](#section-order-and-artifacts-paging) below. Progress → History rows now start at the section's left edge (the `Disclosure` `flush` option) and an opened version's fields line up with its title.

2026-10-24 open card's lane beside the sidebar (user request, card "UI/UX常规修修补补"): on desktop, opening a card narrows the board, which could leave the card's lane under or past the sidebar's edge. When a card is opened (from the board, a link, Ideas, Memory or Insights), moves to another lane, or the board comes back from a page with a card open, the board scrolls (animated, after the sidebar has narrowed it) so that lane is centred in the board's visible part; a lane already fully visible stays put. The overview bar's In review / Blocked chips keep scrolling their lane to the left edge, and a chip pressed while a page closes keeps its lane. A request is not replayed when the board mounts again more than a second later. Phones are unchanged (the card covers the board). Then the card is scrolled (animated) into its lane's list with `cardRevealOffset`, unless already fully visible; the overview chips do not. Code: `laneRevealOffset` in `client/geometry.ts`, the `reveal` prop of `DesktopColumns`.

## Layout and behavior

1. Fixed header: task title and Close/Back icon; one wrapped action group contains the current Status selector, Edit and Archive/Restore. Remove Narrower/Wider/Reset buttons and the drawer `onWidthChange` prop. Desktop width uses the existing boundary grip and clamps; its adjustable accessibility actions expose the same operation and effective width bounds without extra buttons. Compact remains full width.
2. Status uses public host `SettingsSelect` (`@getpaseo/plugin/client/ui`) with a single current value and seven labelled options. It opens the host's dropdown/sheet on demand rather than rendering status chips in the task body. Same-value selection does nothing. A new selection writes once using task ID/current revision, is disabled for archived task/project, inactive drawer or pending mutation, and shows the native success toast only after success. Mutation errors stay near the action group; no optimistic status change or automatic revision retry. Edit/Archive share the pending lock; Archive/Restore retain their existing resource-preservation behavior.
3. Body prioritizes description (when present) and Sessions. Existing session cards, create, unread/attention, exact preview/native navigation and Back/draft/operation semantics remain available. Header/action rows wrap within minimum drawer width.
4. Basic task metadata and workspace diagnostics live in one **Details & workspace** disclosure, below Sessions and default collapsed for each newly opened card. Show Priority, project root, workspace name/ID/path/status/native owner, created/updated timestamps and preserved legacy scope directories as read-only data. No Open workspace action in this section; the header has one ([Open workspace](#open-workspace), 2026-10-29). Paths are selectable and wrap inside bounded width. Preserve disclosure state through preview/Back and polling; selecting another card starts collapsed. Closing/reopening a fully unmounted card starts collapsed.
5. Availability/query errors remain visible while metadata is collapsed, with Refresh details that only re-reads resource state. Summary indicates loading/unavailable/legacy state. Legacy scope remains preserved and its explanation is visible when expanded; there is no resource reparenting or scope edit.
6. Activity remains below metadata with its current chronological/history behavior. This request changes presentation only: no RPC/schema/store migration, provisioning, read acknowledgement or workspace navigation.
7. The sidebar fills the height left under the step-through bar on every layout (`drawerFrame`, `client/geometry.ts`); it is never sized to its content, so a session's message box stays at the bottom of the window however long the transcript is.
8. Ruling (Noah, 2026-11-09): a session's chat header in the sidebar is like Paseo's chats and the dispatcher's (DISPATCHER-SPEC §9.3): Back, the session title, and *Unread* only while the session is unread, then Open in Paseo, the overflow menu and Close. No state dot, state word, read-state wording or provider/model there: the transcript's working and activity rows show the state, and the model is the Model chip under the message box. The running sweep behind the header stays (MOTION-SPEC). Read-state errors and the unreadable-attention case show as notices above the transcript.

- Ruling (Noah, 2026-11-10): Esc on an open card closes the whole sidebar in one press, even with a session chat open inside it; there is no "back from session" step. The chat header's ← Back still returns to card details. Closing the card ends any step-through. Order is unchanged: modals, the dispatcher dock when it is the active area, then the card, then a project page (SHORTCUTS-SPEC §2.1).

## Motion and accessibility

Keep the shared sidebar/session transitions and host-owned selector transitions. Metadata disclosure uses a measured-height reveal/collapse and opacity/chevron progress, central forward/exit durations, Reduce Motion and stale-completion guards. This single bounded accordion may animate measured height with the JS driver on native and web; this is an explicit amendment to MOTION-SPEC's opacity/transform-only default. Resize and pointer coordinates remain immediate.

Disclosure uses a labelled Pressable, `accessibilityState.expanded`, minimum 44-point hit area and hidden/noninteractive exiting content. Stop animations on unmount and reversal. Host selector owns keyboard, dismissal and native compact presentation. Data polling must not replay navigation or reopen the disclosure. Long titles/paths and narrow widths remain bounded; use theme tokens, RN primitives and public host components only.

## Verification and delivery

Use one discovered Paseo `codex/gpt-6-luna` session with `modeId=full-access` at creation in the existing dev workspace. Its ownership is `docs/verification/drawer.md`, `docs/verification/fixtures/drawer/**` and minimal public-host selector/animation compatibility edits in existing test mocks. Preserve historical outputs, shared implementation and user resources. No fixture native project/workspace/card or child needed. Record and clean the exact session/derived context/temp renderer paths; preserve ordinary lifecycle history and live read-state.

Focused checks: removed width controls and workspace navigation; current selector beside Edit/Archive; no body status chips; same-value no-op, exact revision write once, pending/archived/inactive guards, success/failure toast behavior; collapsed default, complete metadata/legacy fields, error visible while closed, expand/collapse/reversal/measurement/reduced motion; preservation across Back/poll and reset on another card; 340-point/compact wrapping; existing session chip/draft/lock/attention/tail/resize regression. Final typecheck and one full suite after stabilization, then reload only this plugin and verify running. Record PASS/FAIL/UNRUN and stop for user review.

Actual desktop/compact appearance, dropdown placement, path wrapping and gesture/keyboard/animation feel require the exact non-fullscreen Paseo window ID/title/geometry. If unavailable, stop GUI actions and mark those UNRUN. Synthetic props/callbacks and plugin running are not visual acceptance.

## Section order and Artifacts paging

Status: implemented 2026-10-19. Card: UI/UX 调整. Title kept for links; covers the whole sidebar layout.

2026-10-28 Workpad and Auto review (GUARDRAILS-SPEC §7.1): the separate Auto review section and the Memory section are gone. The Workpad section holds four groups, each shown only with content: Acceptance, This card (what the card was sent back for, memory it left), Review (the latest review, failed items first, with Rerun) and Plan. It opens per the user's sidebar defaults; the old "Workpad collapsed while Auto review is on" rule is removed.

1. **One section pattern.** Every top-level section of the card sidebar (Progress, Sessions, Workpad, Artifacts, Ideas, Links, Details & workspace, Usage, Activity) is a `Section` (`client/disclosure.tsx`): a header whose title (and the chevron after its count) collapses or expands it, actions on the right, and the body revealed with the shared measured-height `Collapse`. While collapsed the header shows one muted line of what is inside: Progress the latest state (or *Updating…*), Workpad `Acceptance n/m`, Sessions `n running`, Details the workspace name, Usage the token summary. A section with nothing in it (Artifacts or Links at 0) shows a plain header with its actions and no chevron. Nested lists (Progress → History, archived sessions, closed ideas) keep the smaller `Disclosure` with a leading chevron.
2. **Layout settings (Settings → Cards → Card sidebar).** One list: the six movable sections in their order (drag the grip on desktop, up/down arrows on touch), a divider, then Details & workspace, Usage and Activity (pinned at the bottom: they mount after the open transition, so nothing above them moves). Every row has a *Starts open* switch. *Reset sidebar layout* restores both. Host-scoped `board-view` values: `drawerOrder: string[]` (≤ 20 ids, each ≤ 40 chars) and `drawerOpen: Record<string, boolean>` (only choices that differ from the default are stored). Defaults (user decision 2026-10-19): order Progress, Sessions, Workpad, Artifacts, Ideas, Links; Links, Details, Usage and Activity start closed, the rest open. `shared/drawer-sections.ts` resolves both: known ids in their stored order (duplicates dropped), a missing id goes after the section that precedes it by default, unknown ids are kept in storage and ignored. A section that is off (Workpad when the project turns it off, Ideas when Ideas is off or the card has none) is skipped in place.
3. **Open state per opening.** The drawer owns which sections are open. Each time the sidebar opens (or the defaults change) it starts from the user's defaults; toggles last until it closes.
4. **Long lists page by 5.** Artifacts (per role) and the Workpad's Acceptance list show 5 rows, then *Show N more* (N = the next batch, at most 5) adds 5 more to the same list at the rows' left edge. No *Show less*; closing and reopening the sidebar, or another card, starts over. Each added page opens like a section (measured height and fade, `PagedRows` in `client/disclosure.tsx`).
5. **Phones.** On compact layouts only the action row (Back, project, Edit, More) stays fixed; the title, Status/Priority/Type and tags scroll with the sections, so the content gets the screen.
6. A `Collapse` mounted open stays in normal layout until it is measured, so an expanded section does not flash at zero height. Progress → History rows start at the section's left edge (`Disclosure` `flush`) and an opened version's fields line up with its title. Each version shows a compact time (`shared/compact-time.ts`): today the time only, this year month, day and time, earlier years the date with its year; no seconds.

## Focus from search

Status: implemented 2026-10-27. Card: 搜索功能 (SEARCH-SPEC §5.3).

1. The board passes the drawer a focus request: a fresh key, a section (Progress, Workpad, Artifacts, Ideas or Activity) and an optional item target (`event:<id>`, `workpad:<item id>`, `idea:<id>`, `artifact:<id>`). Each new key is handled once.
2. The drawer opens that section in its own open state for this opening only (item 3 above); the stored *Starts open* choices are never written.
3. The section makes the target rendered: Activity widens its last-12 window back to the target event, Workpad and Artifacts raise their page limit to include it, Ideas opens *Closed* for an accepted or dismissed idea.
4. When the target is laid out the drawer scrolls it near the top of the sidebar's scroll area (`measureLayout` against the scroll content) and rings it with the accent `CueRing` for about 1.6 s. With Reduce Motion the scroll is not animated. If the target has not rendered 1.5 s after the request (removed item, section off), the section itself is the target.
5. Toggling any section, scrolling or closing the sidebar never re-applies an old request.
6. **Highlight.** The request also carries the hit's field and its matched words (the folded text under the snippet's ranges, `termsOfHit` in `shared/search-text.ts`; `#tag` filters are never highlighted). Only the target item marks those words: the words themselves get an accent highlight background and bold accent text (`matchRanges`, the same folding as the daemon). The marks stay until the sidebar closes, another card opens or a new hit is clicked. A target with marked words gets no ring around the item (the words are the cue); a target without words (a card-field or tag-only hit, or the section fallback) keeps the 1.6 s ring. A section-level target (a summary hit) marks the Progress card.
7. **What the target shows while marked.** So a match is never cut off: an Activity note drops its 4-line limit; the Progress card and an idea card open past *Show more*, and Progress shows the summary's Target even where the workpad normally replaces it (when the hit is in Target); an artifact row shows its title and note unclipped plus its full link or path; a closed idea shows the matched field under its title. Nothing else in the sidebar changes, and no stored setting is written.

## Type scale

Status: implemented 2026-10-19. Card: UI/UX 调整. One scale for every sidebar section (`font` in `client/ui.tsx`):

| Role | Size | Examples |
| --- | --- | --- |
| Card title | `xl` 18 bold | task title |
| Description, session titles, idea headlines | `base` 14 | |
| Section titles; body text of lists and cards | `md` 13 | Progress text, Workpad acceptance/review/plan, artifact and link titles, History versions, Details values, Usage values |
| Secondary lines | `sm` 12 | content-card footnotes (`Updated … · model`) and meta rows (Ideas), artifact notes, check commands and run info, `Updated … by …`, environment stamp, link lane, History dates, Details labels, empty states, Show more |
| Group labels and field titles | `xs` 11 bold/muted | Acceptance, Checks, Outputs, Inputs, Target, Recap |

## Main and sub sessions

Status: implemented 2026-10-19 (user choice: automatic by parent, option 1). Card: UI/UX 调整.

1. The Sessions list shows **main sessions** (no parent, or a parent that is not one of this card's sessions) newest first. A Paseo child agent (`paseo.parent-agent-id`, SUBAGENTS-SPEC) whose parent is on the card goes under its top-most ancestor on the card; grandchildren are flattened under that main session, oldest first. Parent loops and missing parents fall back to main sessions, so no session is hidden (`sessionTree` in `shared/subagents.ts`).
2. Under a main session with subagents, one row (`↳`, the Subagents chip's summary such as "2 working, 1 needs input", a chevron) shows or hides them. The rows reveal and hide with the shared measured-height `Collapse` and the chevron turns with the same progress (Motion: Reduce Motion honoured, interruptible). It is folded unless a subagent needs input or failed, or the selected session is one of them; the user's toggle wins until the sidebar closes.
3. Subagent rows are the normal session rows, indented and slightly shorter; opening, unread state, attention and the menu are unchanged. The section count is the number of main sessions; the collapsed summary (`n running`) still counts every session. Archived sessions use the same grouping.
4. No data or setting changes. The Subagents chip above the composer opens a subagent in the side bar when it is one of this card's sessions, and falls back to a Paseo agent pane otherwise (SUBAGENTS-SPEC).

## Open workspace

Status: implemented 2026-10-29. Card: button to open associated workspace. The user asked for it after the board card got its button ([CARD-DISPLAY-SPEC §7](CARD-DISPLAY-SPEC.md#7-open-workspace-button)); it replaces the 2026-10-14 decision to keep workspace navigation out of the sidebar.

1. The card view's header has an `ArrowUpRight` icon button labelled *Open workspace*, directly left of Edit (pencil), in the same row as `…` and Close. Same size as its neighbours, desktop and compact.
2. It calls `navigation.openWorkspace({ workspaceId: task.workspaceId, serverId: host.id })` (`openNativeWorkspace`). Nothing else changes in the sidebar.
3. It is there only when the host offers `navigation.openWorkspace`. It is disabled, not hidden, while the sidebar is inactive or the workspace is unavailable or still being checked (the sidebar's own *unavailable* state, the one that disables Start session), so the header icons do not shift when the check finishes.
4. The session view (a selected session) keeps its own header; its *Open in Paseo* still opens the session.
5. No new strings (*Open workspace* already exists), no onboarding tip, no telemetry field.

## Workspace kind

Status: implemented 2026-10-29. Card: badge for worktree vs local. The board card's badge ([CARD-DISPLAY-SPEC §8](CARD-DISPLAY-SPEC.md#8-workspace-kind)) also shows in the sidebar, at the user's request.

1. The header row with Status, Priority and Type starts with `GitBranch` + *Worktree* or `Folder` + *Local*, the same words, icons and mapping as on the card (`cardWorkspace`, `WorkspaceIcon`, `workspaceLabels` in `client/status.tsx`).
2. It is read-only: muted icon and text at the property buttons' height, no border or press state, so it does not read as a picker. Its accessibility label is *Workspace: Worktree* / *Workspace: Local*.
3. The kind comes from the sidebar's own workspace read (`workspaces.ref(id).refresh()`, every 10 s); no new request. While that read is pending, or when the workspace is gone, the row starts with Status as before.
4. Always shown when known: Settings → Cards → *Workspace* only affects board cards. Desktop and compact alike (the row wraps). No new strings.

## Workspace switch

Status: implemented 2026-10-29. Card: switch local and worktree. Contract in [WORKSPACE-SWITCH-SPEC](WORKSPACE-SWITCH-SPEC.md).

1. The ⋯ menu offers *Switch to worktree…* on a local card (not in a linked multi-repo project) and *Switch to local…* on a worktree card, never on a finished or archived card. The same action sits as a small button in the Workspace row of *Details & workspace*, whose value also names the kind; the board's card menu and ⋯ action sheet offer it too.
2. While the card's release is pending, a *Release pending* notice sits above the finished box with *Release from main…*; the ⋯ menu has the same entry. After a release, *Undo release* is in the ⋯ menu until `flowly_integrate` landed the branch.
3. The switch dialog shows the branch field (to worktree), base, the number of files copied, the handover and *Ask {session} for a handover* for idle sessions, what is archived, and the server's blockers and warnings. Switching to local shows both branches with their last 5 commits and the changes per folder, cut at two directory levels, side by side (files changed in the worktree, in the main checkout, conflicts); with uncommitted worktree changes it offers *Copy changes and switch* (disabled while files conflict), *Overwrite changes and switch*, *Discard changes and switch* and *Cancel*. Nothing starts after the switch; a toast says to start a session.
4. The release dialog lists the files with added/removed lines, the warnings and blockers, and runs only for the patch it showed.
5. Archived sessions of the card's earlier workspaces are listed under *Archived* and open read-only.

