# Remove a project (board, optionally Paseo)

Status: requested by the user on 2026-10-15 (card “Optimize the project system”): remove a project from Ultra Kanban while keeping the Paseo project; then a single removal entry where the user chooses board-only or also the Paseo project.

## Entry point

The project chooser (All projects / `G`) has one **Remove “<name>”…** row for the current project, next to Edit. The former **Archive** row is folded into it; projects archived earlier still show **Restore** (and can be removed).

## Dialog

- On open it runs `projects.remove-check({ id })` (read-only): card count, whether the native project still exists, its workspace count and running/initializing sessions in those workspaces.
- **Paseo project** choice:
  - **Keep in Paseo** (default) — only the board project goes. The Paseo project at its root, its workspaces, sessions and files stay; running sessions keep running but their Kanban tools stop working for the removed cards; the project can be added to the board again later as a new, empty board project.
  - **Also remove from Paseo** — additionally removes the native project. Paseo has no project archive; its project removal (`paseo project delete`, the same operation as removing a project in Paseo) drops the project and its workspace records but **deletes nothing on disk**: root folder, worktrees and branches stay (verified on a throwaway fixture). Disabled while any session in the project's workspaces is running/initializing (and while the check is loading); the server rechecks.
  - When the native project no longer exists, the choice is hidden and only the board record is removed.
- The confirm button names the scope: *Remove from board* / *Remove from board and Paseo*.

## Server

`projects.remove({ id, revision, alsoPaseo=false })`, serialized with other provisioning:

1. If `alsoPaseo`: recheck running sessions; refuse with nothing changed when any run.
2. Board removal (CAS on project revision, one write): project, its cards, their events and agent receipts. Before writing, the removed records go to `<plugin data>/removed/<projectId>-<time>.json` (exclusive create, 0600).
3. If `alsoPaseo` and the native project exists: `paseo project delete <id> --home <PASEO_HOME> --json` (argument array). Result `paseo: { removed, workspaces, error }`. A failure here leaves the board removal in place and is reported (error toast: Paseo kept the project).

Board-first ordering means a failed Paseo step never leaves cards pointing at a missing project. Freed bindings (native project ID, workspace IDs) can be linked again. A linked multi-repo root (PROJECT-PICKER-SPEC) stays on disk either way. Composer data for removed cards is pruned by the existing dead-task cleanup; tool calls for removed cards fail with “Task not found”.

After removal the board shows the first remaining project; a toast states what happened.

## Acceptance

- Store tests: removal scope, backup content, CAS/not-found, reusable bindings.
- Service tests: check counts only the project's workspaces/sessions; board-only never calls Paseo; Paseo option refused while running with nothing removed; native delete after board removal; Paseo failure reported with board removal kept.
- Live: two fixture projects removed through the UI in a headless web client — one kept in Paseo, one also removed from Paseo with its folder still on disk; fixtures, backups and folders cleaned up.
