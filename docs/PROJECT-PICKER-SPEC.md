# Project directory picker and linked multi-repo projects

Status: requested by the user on 2026-10-15 (card “优化project系统”). Amends [SINGLE-ROOT-SPEC](SINGLE-ROOT-SPEC.md) for project creation only; the one-project-one-root contract is unchanged.

## 1. Choosing a directory

The plugin SDK has no host file/folder picker, and plugin client code cannot read absolute paths from a browser file chooser. Both choosers therefore run through the daemon, which owns the file system:

- **Browse (in-app).** `fs.list-directories({ path? })` returns the canonical directory, its parent, the daemon user's home and up to 500 non-hidden child directories (symlinks to directories included), each flagged `git` when it contains `.git`. Default is the home directory. Read-only. The project form shows an inline browser (Up, Home, child rows; Git repos marked) with **Use this folder** (single root) or **Add** (linked repositories). Works on every client, including phones.
- **System dialog.** `fs.pick-native({ multiple })` opens the platform folder dialog **on the computer running the Paseo daemon**: macOS Finder (`osascript choose folder`, multiple selection), Windows Explorer (`FolderBrowserDialog`, single), Linux `zenity`/`kdialog`. Cancel returns `{ paths: [] }`. One dialog at a time; a second request fails with “A folder dialog is already open.” 10-minute timeout. `fs.list-directories` reports `native` (`finder`/`explorer`/`zenity`/`kdialog`/null) so the client hides the button when unavailable. The button's detail says it opens on the Paseo computer, so a remote/phone user is not surprised.
- Typing a path remains possible. The server still canonicalizes with `realpath` and rejects non-directories.

## 2. Linked multi-repo project

The project form has a **Source** choice: *Single directory* (existing behavior) or *Multiple repositories*.

Multiple repositories:

1. The user names the project and adds two or more directories (browser, system dialog or typed path). Duplicates (after `realpath`) are rejected.
2. `projects.create-linked({ title, description, links })` creates `<plugin data>/projects/<slug>` — the fixed parent is `~/.paseo/plugin-data/flowly/projects` (override: `FLOWLY_LINKED_DIR`). `<slug>` comes from the title (letters/digits/`-`, max 60; `project` when empty), suffixed `-2`, `-3`… when the directory already exists. The directory is new and empty; the plugin never reuses or writes into an existing user directory.
3. One symlink per target, named after the target's basename (suffixed `-2`… on collision), pointing at the canonical target. Targets must be existing directories outside the linked parent.
4. The directory is registered as a native Paseo project and bound like a single-root project. `project.links = [{ name, target }]` records the links. `repos` stays `[root]`.
5. Failure before the native project exists removes only what this call created (its symlinks and the new directory). After native registration the directory is preserved.

Editing a linked project (`projects.set-links({ id, revision, links })`, CAS on project revision) adds new symlinks and removes dropped ones. A link is removed only when the entry is still a symlink pointing at its recorded target; targets themselves are never touched. At least one link must remain. The root, native binding and existing cards/workspaces are unchanged; directory workspaces see the change immediately.

Cards in a linked project use directory workspaces (the root is not a Git repository, so worktree mode is unavailable, as for any common directory). The task context lists the links (`name -> target`) so the agent knows which real repositories it is working in. Provider sandboxes may treat the symlink targets as outside the workspace; full-access sessions are unaffected, other modes report denied access as before. Auto review reads each linked repository's diff, HEAD and new files and runs the project's commands in the repositories that have them (GUARDRAILS-SPEC §6.2, §6.3).

Archiving a project never deletes the linked directory or targets.

## 3. Acceptance

- Unit: linked create (directory, symlinks, name collision, native bind, cleanup on failure, duplicate/invalid targets), setLinks add/remove/CAS/foreign-entry protection, listDirectories (hidden filter, git flag, parent), native picker unavailable path.
- Typecheck and full tests; reload `flowly`; live RPC: list home directories; create a linked fixture project from two temp directories, verify native project root and symlinks, then clean up the fixture project, board record and directories.
- UI: desktop/compact form rendering in the non-fullscreen window only when it can be targeted; otherwise recorded UNRUN.
