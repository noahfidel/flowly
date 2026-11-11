# Delete a card permanently

Status: requested by the user on 2026-10-15 (card “增加彻底删除卡片”): permanently delete cards, and delete the old archived cards in the Ultra Kanban project that can no longer be meaningfully restored.

## Entry point

Any card in any lane (follow-up 2026-10-15: "允许任何lane里删除"): the board card menu and the drawer's task menu show **Delete permanently…** (danger, last item). Disabled while the project is archived (and, on the board, while a change is pending).

Ruling (Noah, 2026-11-10): the board card menu is one menu for the card's ⋯ button, right-click and long-press, and keeps only Open details, Start session, Move to ▸ (lanes), Archive card / Restore card and Delete permanently… (danger, last) (UI-UX-SPEC §2). It always fits on screen (opens upward or scrolls), so Delete is reachable from the board for a card at any position.

## Dialog

“Delete “<title>” permanently?” explains that the card, its activity and progress summaries leave Ultra Kanban and cannot be restored from the board, and that a backup is kept in the plugin data folder. On open it runs `tasks.delete-check({ id })`: the wrap-up preflight (MULTITASK-SPEC) without the Done/Cancelled and not-archived requirements.

- **Paseo sessions and workspace**: *Keep* / *Archive*. Archive covers its sessions, plus its workspace when the card owns it or it is a worktree (Paseo may then remove the worktree directory; the branch is kept). A linked/shared workspace is never archived, only its sessions.
  - Running/initializing sessions are blockers: *Archive* is disabled and the reason shown. Uncommitted/local-only work is shown as warnings when *Archive* is chosen; confirming with them shown is the acknowledgement (as in Wrap up).
  - Default *Keep*; with the setting below on, the default is *Archive* when allowed.
- When the workspace is already archived or gone, the choice is hidden (“nothing else to archive”).
- **Auto archive on delete** (Ultra Kanban settings → Finishing cards, `wrap-up.archiveOnDelete`, default off): when the preflight is clean (no blockers, no warnings) the question is not asked; the dialog states that the sessions/workspace will be archived. Otherwise the dialog asks as above.
- Buttons: *Cancel* / *Delete permanently* or *Archive and delete*. Errors keep the dialog open. On success the drawer closes if it showed the card and a toast states what was archived.

## Server

`tasks.delete({ id, revision, archive=false, acknowledgeWarnings=false })`:

1. With `archive`: the wrap-up run with `keepCard` (purpose delete) — rechecks revision, blockers and warnings, archives the workspace or sessions. A refusal or partial failure throws and leaves the card in place (“Archive incomplete; the card was not deleted.”).
2. CAS on task revision; unknown card rejected, nothing changed. One board write drops the card, its events and agent receipts; before writing, the removed records go to `<plugin data>/removed/task-<id>-<time>.json` (exclusive create, 0600).
3. Its progress summaries are removed after a backup `removed/task-<id>-summaries-<time>.json`; a failure there is logged and does not undo the deletion.

Output `{ id, backup, archived?: { sessions, workspace } }`. Without `archive`, Paseo resources are never touched. The freed workspace binding can be used by a new card. Composer data for the card is pruned by the existing dead-task cleanup; tool calls for it fail with “Task not found”.

## Acceptance

- Store tests: deletion scope (only that card's events/receipts), backup content, live and archived cards, CAS/not-found with nothing written, workspace binding reusable.
- Wrap-up tests: delete preflight ignores lane, still blocks on running sessions; run with purpose delete archives without touching the card; blocked run archives nothing.
- Live: the 11 archived cards of the Ultra Kanban project whose worktree workspaces were removed by the old wrap-up (F1–F4 and seven E2E fixtures) deleted through `tasks.delete`; the still-restorable archived card “竞品调研” kept. `tasks.delete-check` on real cards (clean / running session).
