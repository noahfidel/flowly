# M2.5: manual multi-task management

Status: authorized by the user on 2026-10-14 (A, B and D chosen; C and E not for now; asked to get the basic board features right first). Upstream: [ROADMAP-V2 §0/§8](ROADMAP-V2.md).
This phase uses only manual actions and the session signals Paseo already has; it adds no agent tool and does not change the agent's status permissions. The storage structure is unchanged (board v3), and no new persistence file is introduced.

## A. "Needs attention" overview

- The board toolbar gets an Attention button (bell icon). When there are pending items it shows a count badge.
- The dialog lists all sessions that need attention, grouped by card:
  - Scope: non-archived cards in non-archived projects. It is not affected by the current project, search, priority or Finished filters.
  - The judgment reuses the existing `sessionAttention`: waiting for approval, error, turn ended unread. Running does not count.
  - When the read state is unavailable, unread is not judged; only approvals and errors are listed, with a note at the top of the dialog.
- Each row shows: card title, project name, card status, each reason (such as "1 approval · 2 unread"), and the latest session update time. Sorting rule:
  1. Cards with an approval or an error come first;
  2. Within the same tier, the most recently updated come first.
- Clicking a row: switch to that project and open the card sidebar.
  - If the card has only one session that needs attention, open its preview directly. It reuses the one-time entry mechanism of the session chip, and "Back" returns to the card detail.
  - With several sessions that need attention, stop at the card detail and let the user choose.
- Opening a session does not mark it as read automatically; reading is still done by the existing "Mark as read" action.
- The empty state shows "Nothing needs your attention.". The data refreshes with the board's existing polling (≤5s).

## B. One-click start session

- There are three entry points:
  - "Start session" (formerly "New session") next to the title of the sidebar Sessions section;
  - the primary button in the empty state when the card has no session;
  - "Start session" in the card action menu: opens the sidebar and pops up the create dialog directly.
- The create dialog prefills the following, all editable:
  - **Provider / model / mode**: follows the most recently created session, that is, the non-archived session with the latest `createdAt` across all card workspaces. If its provider is unavailable or its model is not selectable, fall back to the provider's default model; if the mode is not in the selectable list, fall back to the provider's default permission. With no history, stay as it is now (codex + default model).
  - **Initial instruction**: the card title plus the description (only the title when the description is empty).
  - **Title**: empty, meaning the card title is used.
- Creation logic, Kanban tool injection, idempotency and recovery behavior are unchanged.

## D. Manual wrap-up (Wrap up)

- When the card status is Done or Cancelled and it is not archived, the sidebar shows a "Wrap up" block and button in the "Needs" position. It is not shown for other statuses.
- Clicking first runs a check (RPC `tasks.wrapup-check`), then pops up a dialog with the result:

| Check | Level | Notes |
| --- | --- | --- |
| A session is running/starting | Block | Stop it or wait for it to finish first |
| The workspace is being archived or unavailable | Block (when unavailable, only archiving the board record is allowed) | — |
| Uncommitted changes (worktree only) | Warning | After archiving, Paseo may delete the worktree directory and the changes will be lost |
| Unpushed commits `git rev-list --count HEAD --not --remotes` (worktree only) | Warning | The branch is kept, but the commits exist only locally |
| Git state cannot be read (worktree only) | Warning | — |

- The wrap-up action differs by workspace type:
  - **worktree**: archive that workspace. Paseo archives its sessions and terminals at the same time; when it is the last active reference to that worktree, Paseo removes the worktree directory and keeps the branch.
  - **directory / checkout / local_checkout**: do not archive the workspace (it may be the project root or a directory the user uses often); only archive the non-archived sessions in that workspace one by one.
  - In both cases the card is finally marked archived, and the activity `wrapped_up` is recorded (with the number of archived sessions, whether the workspace was archived, and the warnings that were acknowledged).
- Confirmation:
  - When there are blocks, "Wrap up" cannot be clicked.
  - When there are warnings, the button has a danger style and the label is "Wrap up anyway"; the request carries `acknowledgeWarnings=true`.
  - The server re-checks before executing. If a new block appears, or the warnings changed and were not acknowledged, it refuses and returns the latest check result.
- The request carries the card `revision`, and a conflict is returned when the card was modified by someone else.
- Execution order: resource archiving first, card archiving after.
  - If any session or workspace archive fails: the card is not archived, and the details of what was done and what failed are returned; it can be retried (already archived resources are skipped).
- The card's existing Archive (archives only the board record) is unchanged. A successful wrap-up is announced with a native toast.
- This is an explicit user action and fits the constraint "archiving a board record does not implicitly archive Paseo resources"; AGENTS.md adds one line to state this explicit exception.

## Addendum: worktree branch name optional (2026-10-15)

When creating a card with New isolated worktree selected, New branch can be left empty, and the server generates `kanban/<English slug of the title>-<6-char hash>`:
- The slug takes the English letters and digits of the title, lowercases them, replaces everything that is not alphanumeric with `-`, up to 40 characters; when the title has no usable English, it uses `task`.
- The hash comes from the operationId of this creation; when the same creation is retried, the branch name and idempotency key stay the same, so no extra worktree is created.
- When the user fills in a branch name, it is used as given.

## Addendum: start the first agent together with a new task (2026-10-15)

- The New task form gets a switch "Start an agent now" that remembers the last choice (host setting `board-view.startAgentOnCreate`, on by default the first time):
  - **On**: shows the same Agent choice as New session (Provider / Model / Permissions, prefilled from the latest session's settings) and "First instruction". The First instruction follows the title and description, and is no longer overwritten once the user edits it. The button is "Create and start": it first creates the card and workspace, then starts a session with the same configuration as the sidebar Start session (MCP + skill + card context), then opens the card sidebar.
  - **Off**: only the task is created, and a session is started manually from the card later.
- Failure handling: when the card is created but the agent fails to start, the card is kept, an error message pops up, and it can be restarted in the sidebar. The start uses a fixed launch ID based on this creation's operationId, so a retry reuses the already prepared agent and does not create a duplicate.
- The agent choice logic is extracted to `useAgentChoice` / `AgentPicker`, shared by New session and New task; the start logic is `launchKanbanSession`.
- Settings are read uniformly through `boardViewValues`, which fills in defaults, because the host does not apply the defaults of new fields to old stored values.
- Measured: a new haiku session was created and started, the sidebar opened automatically and showed running, and A1 moved to In progress automatically; Wrap up then cleaned up ([screenshot](verification/create-and-start.png)).

## Addendum: wrap up when moved to Done/Cancelled (2026-10-15)

The user asked that moving a card to Done or Cancelled by default asks whether to wrap up, and on yes archives the workspace; a setting can switch it to automatic archiving.

- Setting: host setting `wrap-up.autoWrapup` (Ultra Kanban settings → Finishing cards → Auto wrap up), off by default.
- Trigger: a person on the board (menu Move to, drag and drop), in the sidebar status, or in the edit form changes a card from non-Done/Cancelled to Done or Cancelled. Moving between Done ↔ Cancelled does not trigger.
- **Off (default)**: that client pops up "Wrap up this card?" after the status write succeeds:
  - It first runs the Wrap up check and shows the blocks/warnings, with the same rules as manual Wrap up (with warnings the button is "Wrap up anyway").
  - After confirmation it archives the sessions/workspace, and the card is **kept** on the board (RPC `tasks.wrapup` with `keepCard=true`, records the activity `wrapped_up`, with a note that contains "card kept", and does not change the card revision).
  - "Not now" closes it and touches no resource; Wrap up in the sidebar can still be used later.
  - It does not pop up when the card has nothing left to archive (the workspace is unavailable, or the workspace does not belong to this card and has no session).
- **On**: the daemon runs it in the background after the status write, without blocking the write; only one run per card at a time. It archives the workspace (Paseo archives its sessions and terminals at the same time) only when there are no blocks, no warnings and the workspace belongs to this card; the card is kept and `workspace_auto_archived` is recorded; otherwise it touches no resource and records `workspace_auto_archive_skipped` (with the reason), and a manual Wrap up can be done later. Before executing it confirms again that the card is still Done/Cancelled and the revision is unchanged.
- Summary session: after a turn ends the plugin creates a short-lived "Kanban summary" child session in the card workspace (label `ultra-kanban=summarizer`), and archives it automatically when finished. It does not count as a "still running" session and is not counted in the archived number; both automatic and manual Wrap up first wait for this card's in-progress summary to finish (`SummaryService.settled`, bounded by the summary's own timeout) before checking and archiving, to avoid being wrongly judged as skipped or cutting the summary short when a card moves to Done right after a turn ends (fixed 2026-10-18).
- Ownership: a new card records `ownsWorkspace` (true for a newly created directory/worktree, false when linking an existing workspace). For an old card without the field, it counts as created by this card only when the Paseo workspace title equals the card title (the plugin names it with the card title when it creates it). A workspace owned by this card (including the directory kind) is archived as a whole, with the directory left on disk; the worktree directory may be removed by Paseo, and the branch is kept. A directory workspace not owned by this card (such as the project main) is never archived; only the sessions in it are archived.
- Wrapped-up state: when the card's latest `wrapped_up` / `workspace_auto_archived` has no `workspace_restored` after it, and the card was not moved back out of Done/Cancelled, it counts as wrapped up (`shared/wrapup-state.ts`). Then the sidebar "Finished" block becomes "Wrapped up" (showing what was archived, when, and that moving out of Done/Cancelled can restore it), no longer shows the Wrap up button and menu item, and no longer prompts "Workspace is unavailable or archived.".
- The sidebar manual Wrap up is unchanged (it still archives the card), except that it also archives the directory workspace owned by this card as a whole.

## Addendum: restore the workspace when moved out of Done/Cancelled (2026-10-15)

When a wrapped-up card is moved out of Done/Cancelled, the workspace archived at wrap-up is restored in the background: the same workspace ID is kept, and a deleted worktree is recreated on its original branch. The sessions archived by that wrap-up are restored too (those the user archived themselves are left alone). See [WORKSPACE-RESTORE-SPEC](WORKSPACE-RESTORE-SPEC.md) for details.

## Not doing

Agent auto-advance, stages, questions, auto-start (see the long-term items in ROADMAP-V2), card sort/filter enhancements (C), card notes (E), delayed wrap-up, automatically archiving the card itself.

## Acceptance

- Typecheck first, then the focused tests and the full `npm test`, then reload only this plugin.
- Focused tests:
  - Computation of the attention list: scope, sorting, read state unavailable;
  - Derivation of default session settings;
  - Wrap-up check and execution (temporary git repo + fake SDK): blocks, warning confirmation, worktree/directory branches, partial failure does not archive the card, revision conflict, repeated execution.
- Real rendering check: the Attention dialog and the sidebar Start/Wrap up at desktop and phone widths. Do not run wrap-up on the user's real cards.
- Per the user's earlier decision, Luna acceptance is not run for now and is recorded as UNRUN.
