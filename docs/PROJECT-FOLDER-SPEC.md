# Project data in the project folder

Status: 2026-10-17, card “Flowly project saved in the original project directory”. User chose option A: each project's board data is also saved in its own root under `.flowly/`; after the project is removed from Flowly it can be restored from that folder; not tracked by git by default.

## 1. Model

- `board.json` in the plugin data folder stays the source of truth: one serialized, atomic store for all projects (cross-project invariants such as unique workspace and native-project bindings live there). Nothing in the read/write path depends on the project folder being present or writable.
- After every board commit that changed a project's data, the daemon writes a **snapshot** of that project to `<primaryPath>/.flowly/project.json`. It is a copy for carrying the board with the folder and for restore; it is never read while the project is on the board.
- Restore reads a snapshot back into the board when the folder's project is not on the board.

## 1.1 Upgrade migration (user decision 2026-10-18: “migrate old projects automatically after the plugin upgrade”)

On every daemon start (`ProjectFolders.migrate`, before any debounced write), every project on the board, archived included, gets its folder copy:

- A folder whose `project.json` already holds this project's current records (same content key as §2 change detection) is left untouched: `current`.
- Otherwise the snapshot is written as in §2 (`written`); a foreign or invalid file is first kept as a dated copy.
- A write failure is `failed` with its reason; the project is retried on its next commit and at every start.
- The result goes to `<plugin data>/folder-migration.json` (`{ version, at, projects: { id: { path, result, error? } } }`, atomic, 0600) and one log line with the counts.

The migration only copies. `board.json` stays the source of truth in the plugin data folder; no board record, workspace or directory is changed or moved, so a downgrade keeps working.

## 2. Snapshot file

`<primaryPath>/.flowly/project.json`, 0600, atomic replace (temp file + rename), pretty JSON:

```
{ format: "flowly-project", version: 1, savedAt, boardVersion: 4,
  project,                 // projectSchema record
  tasks, events, ideas,    // all cards of the project (archived included), their events and ideas
  links,                   // links whose both ends are in this project
  artifacts,               // the cards' artifacts (CARD-ARTIFACTS-SPEC), when present
  summaries }              // task summary entries of these cards (summaries.json), when any
```

Not included: agent receipts (session-bound, expire), tool credentials, settings, composer drafts, the flow log (rebuilt from events by its startup reconcile), digests.

Ignore by default: when the daemon creates `.flowly/` it also writes `.flowly/.gitignore` containing `*`, so git ignores the folder (including the ignore file itself). If the user deletes or edits that file to track the folder, it is never recreated or changed while `.flowly/` exists.

Writing:

- Debounced per project (1 s after the last commit, coalesced), serialized per project, from the committed board. A project whose data did not change is not rewritten. Order of projects in the chooser (`position`) is presentation and is excluded from the change check but included in the file.
- The daemon writes all current projects once at startup (only those whose file content differs).
- Failures (read-only folder, missing root, disk full) never fail the board write. They are logged once per project and reason (`paseo plugin logs flowly`) and shown as a warning in Project settings (§5). Symlinked roots (linked projects) are written inside the plugin-owned root directory, not into the linked repositories.
- Archived projects keep their snapshot updated. Removing a project (§4) leaves the snapshot on disk; deleting a card rewrites the snapshot without it.

## 3. Restore

`projects.restore-check({ path })` (read-only), called by the Add project form when the chosen folder changes (debounced):

- Resolves the folder; reads `.flowly/project.json` when present. Returns `{ found: false }` or `{ found: true, title, cards, savedAt, conflict }`.
- `conflict`: `""`, `"on-board"` (the snapshot's project ID is already on the board) or `"invalid"` (unreadable file; restore blocked, a new empty project is still possible). `unbound`: cards whose workspace is bound by another board card; a warning, they are restored without a workspace. The client translates these.

`projects.restore({ path, paseoProjectId? })`, serialized with other provisioning:

1. Reads and validates the snapshot (`flowly-project` v1; records parsed with the current schemas, board version upgrades applied as for `board.json`).
2. Finds or creates the native Paseo project for the folder exactly as Add project does. If another board project already uses that native project, refuse: “Paseo project is already linked; open or restore its board project.”
3. One board transaction: insert the project (same ID, `primaryPath` = the resolved folder, `paseoProjectId` = the current native ID, `revision` + 1, `archivedAt` kept), its tasks, events, ideas and links. Refuse if the project ID exists. Cards whose workspace ID is bound by another card keep their record but get the placeholder `workspaceId: "unbound-<taskId>"` (unique, resolves to no workspace) and lose `ownsWorkspace`; a clashing `operationId` becomes `restored-<taskId>`; their drawers show the existing *Workspace unavailable* state. Every restored card gets one event `restored` (actor human, note “Restored from project folder”) and its `revision` + 1, so agent tools holding old revisions must re-read. Receipts start empty.
4. Summaries in the snapshot are merged into `summaries.json` for those task IDs (existing entries win).
5. Writes the snapshot again from the restored board.

Linked projects (`links`): the root directory with its symlinks is restored as it is on disk; recorded links whose symlink no longer exists are dropped from the record.

Workspaces and sessions are not recreated or unarchived. A card whose Paseo workspace still exists works again immediately; otherwise it shows the unavailable state and can be wrapped up or deleted as usual.

## 4. Remove

Project Remove keeps its behavior and `removed/` backup (PROJECT-REMOVE-SPEC) and does not touch `.flowly/`. The dialog adds one line: “Its board stays saved in {path}/.flowly; add the folder again to restore it.” (only when the last snapshot write succeeded).

## 5. UI

- Add project form: after a folder is chosen and `restore-check` finds a snapshot, a notice under the folder field: “This folder has a saved Flowly project: {title}, {n} cards, saved {time}.” with two choices, **Restore it** (default) and **Start empty**. Restore submits `projects.restore`; the title and description fields are hidden for Restore. A blocking conflict shows the reason and only Start empty. Start empty creates a new project as today; its first snapshot write replaces the old file after moving it to `.flowly/project.<savedAt>.json` (no data is lost silently).
- Project settings: a read-only row **Saved in project folder** with `{primaryPath}/.flowly` or the last write error.
- Toasts: “Restored {title} with {n} cards.”

## 6. Onboarding

Feature list in the welcome tour gains *Saved with your project*: “Each project's board is also kept in its folder (.flowly, ignored by git). Add the folder again to restore it.” No one-time tip: tips are driven by board facts, and the restore notice in the Add project form already explains itself when it matters.

## 7. Errors

| Case | Result |
| --- | --- |
| Snapshot write fails | Board unaffected; log + settings warning |
| Restore: invalid snapshot | Refused, file left unchanged |
| Restore: project ID already on board | Refused |
| Restore: native project already linked | Refused |
| Restore: workspace already bound | Card restored without workspace (warning shown before) |

## 8. Acceptance

- Snapshot: written after a commit with exactly the project's records; other projects not rewritten; `.gitignore` created only with the folder; failure does not fail the commit; card delete removes the card from the snapshot; project remove keeps the file.
- Restore: round trip remove → restore gives the same cards/events/ideas/links/summaries; ID conflict and native conflict refused with nothing written; workspace conflict clears only that binding; revisions bumped; invalid snapshot refused and unchanged.
- Start empty keeps the old snapshot as a dated copy.
- Live: fixture folder added, cards created, file contents checked, project removed (Keep in Paseo), restored through RPC and the form; fixtures cleaned.
