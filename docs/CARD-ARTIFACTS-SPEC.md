# Card artifacts (Artifacts)

Status: reviewed by the user on 2026-10-17, who asked for it to be implemented (their word, translated: "Start"): store references only; an agent cannot delete artifacts a person added; not shown on the card face; each entry says input/output and added by person/agent; follow-up inheritance is not done for now (§11). Card task `82814710`.

## 1. Purpose

A card can now record a description, activity, progress notes, ideas and links, but has no place to gather "what this task used and produced": requirement docs, design drafts, reference links, generated reports, screenshots, PR links, verification evidence and so on. They are scattered across session conversations and workspace directories, and both the user and a session that takes over later have to dig through conversations to find them.

This feature gives the card an **Artifacts** list, where each entry is a **reference** to a file or link, marked with a role (input / output) and a source (person / agent), with a title and a short note. An agent adds them through a tool by its own understanding, and the user can also add, edit and remove them by hand.

Naming: the UI and the tools use **Artifacts** throughout (a common word in the agent ecosystem; Claude/Codex both call outputs this); the Chinese catalog translates it with a word meaning "products". "Assets" leans toward static resources and is not adopted.

Principles:

- **Store references only, do not copy files** (v1). The file stays in the workspace/project directory, managed by git; the plugin does not become a second file store.
- Artifacts are used only to **display and provide context**: they change no business status, no task revision and trigger no automatic action.
- No directory scanning and no automatic extraction from conversations. The agent registers one only with a clear intent, to avoid noise.

## 2. Data

### 2.1 Artifact

Stored in the new `artifacts` array of `board.json` (like `links`, CARD-LINKS-SPEC §2.1), reaching the client with the existing etag board read, with no new polling.

```
{ id, taskId, projectId,
  role: "input" | "output",
  kind: "file" | "url",
  target: string,          // file: the normalized path (§2.2); url: an http(s) URL
  title: string,           // 1–120, defaults to the file name or the URL host + path
  note: string,            // 0–1000, purpose/description
  createdBy: "human" | "agent",
  agentId?: string,        // when createdBy=agent
  createdAt, updatedAt }
```

`shared/model.ts` adds `artifactSchema`, `artifactRoles`, `artifactLimits = { title: 120, note: 1000, target: 2000, perTask: 100 }`; `boardSchema` adds `artifacts: z.array(artifactSchema).optional()`, and a missing value reads as an empty array. The board version is unchanged.

Meaning of the roles:

| role | Meaning | Examples |
| --- | --- | --- |
| `input` | Material the task is based on or refers to | Requirement docs, design drafts, issue links, logs, related material |
| `output` | This task's deliverable | A newly written spec, report, exported file, PR, verification evidence |

External items (Jira, Confluence, GitHub/GitLab, CONNECTORS-SPEC §3.1) can take either role like any other entry: a person pasting or adding from the picker defaults to input, and a PR/MR the agent opens itself is registered as output. The role is no longer forced to input just because it is an external item.

### 2.2 File paths

- On adding, the server resolves the path to an absolute path (a relative path is based on the card's workspace directory), and after `realpath` it must lie inside the card's scope directories (the effective directories of `shared/scope.ts`: the workspace directory, the project root, the legacy scope directories; a symlink of a linked root counts as inside once resolved to its target). A path outside the directories is rejected: "Files outside this card's directories can't be added." (The extra directories in Settings count too, see the 2026-11-08 addition at the end.)
- When stored, a path inside the workspace directory is saved as a path relative to the workspace (prefix `./`), and the others are saved as absolute paths. This way the path stays valid after a worktree is wrapped up and rebuilt (WORKSPACE-RESTORE-SPEC).
- The file must exist at the time of adding (a file or a directory both work); if it is later deleted, moved or its worktree is removed, the record is kept and the UI shows "Missing".
- A URL accepts only `http:`/`https:`, at most 2000.
- `(kind, target)` is unique within one card; adding a duplicate returns the existing entry, and if a new role/title/note is given it is handled by the update rule in §3. When an agent adds again an entry a person added, it does not change it; when the role differs from the existing one, the tool result carries a `notice` (see §4.1).

### 2.3 Events

An artifact change increases only the board revision, not the task revision. The card activity records one event: `artifact_added` / `artifact_removed`, with the note `<Role>: <title>`; an edit (changing title/note/role) records no event. The event for an agent add has the actor agent, with agentId.

## 3. Human RPC

| Method | Input | Behavior |
| --- | --- | --- |
| `artifacts.create` | `{ taskId, role, kind, target, title?, note? }` | Validate per §2.2 and write, returning the new artifact; a duplicate `(kind, target)` returns the existing entry and applies the given fields |
| `artifacts.update` | `{ id, updatedAt, role?, title?, note? }` | A mismatching `updatedAt` reports "This artifact changed. Reload and try again." (overwrite protection); target cannot change, to change the target delete and add again |
| `artifacts.delete` | `{ id }` | Delete; one that does not exist reports "This artifact no longer exists." |
| `artifacts.preview` | `{ id }` | See §6.1; read-only, does not write the board |

A person can edit and delete any artifact (including agent-added ones). When the card or project is archived a write is rejected: "Archived cards can't be changed."

## 4. Agent side

### 4.1 Tools

Add two MCP tools (the CLI provides matching `artifact` / `artifact-remove` subcommands), both following the existing signature request + expectedRevision protocol, idempotent, without changing the task revision:

- `flowly_add_artifact`: `{ expectedRevision, request, role, target, title?, note? }`. `kind` is inferred from target (`http(s)://` is url, `file://` and the rest are file). With a duplicate target it updates that entry's role/title/note (only when that entry was added by an agent, any session; one added by a person stays unchanged, the existing entry is returned, and the receipt `eventId` is empty; in that case if the requested role differs from the existing one, the result carries a `notice`: "Already added by the user as <role>; role not changed. …", the receipt saves it too, and a replay returns it as is). The result carries `artifactId`. A path error returns `ARTIFACT_INVALID`.
- `flowly_remove_artifact`: `{ expectedRevision, request, id }`. It can remove only agent-added artifacts (any session can, because sessions on the same card share work); one a person added is rejected: `ARTIFACT_FORBIDDEN` "Only the user can remove artifacts they added."

Key points of the tool description (written into the description and the skill):

> Register a file or link that is an input this card worked from, or an output it delivered, so the user and later sessions can find it. Add deliverables when you produce them (specs, reports, exported files, PRs, verification evidence), not every file you touched; source code changes are already visible through the workspace diff. Use a short title and a one-line note on what it is for. Check artifacts in get_task first.

### 4.2 Reading

- `flowly_get_task` adds `artifacts: [{ id, role, kind, target, absolutePath?, title, note, createdBy, missing, unread }]`, returning at most 100. `absolutePath` is for file only, resolved against the current workspace directory.
- `unread` (2026-10-18, the user chose A+B): the artifact was added or edited (by `updatedAt`) after this session's last call to `flowly_get_task`; one this session added itself never counts. When this session has never read, all are true. Only an explicit `flowly_get_task` (MCP or CLI `current`/`get`) advances the read time to the moment this read started; the `current` attached to a write tool result only shows the marks and does not advance. The read time is stored per session in `artifact-reads.json` in the plugin data directory (not written to board.json, no board revision change; atomic replacement; at most 2000 sessions, dropping the oldest beyond that), and is kept across restarts.
- The task context injected when a session is created (`sessionContext`) adds a paragraph after the description, with at most 10 entries per role, writing `…and N more` beyond that, listing only input and output; user-added ones come first, each with its source and note (the note squeezed into one line, at most 200 characters):

  ```
  Inputs:
  - [user] <title>: <target> — <note>
  - [agent] <title>: <target>
  Outputs so far:
  - [agent] <title>: <target> — <note>
  ```

- The skill adds one item: the inputs a user added belong to the task itself and are all read before starting work (for files use `absolutePath`, open links when a network tool is available), and their note counts as instructions on how to use them; at the start of each turn read `flowly_get_task` first, and handle `unread` inputs first; when one cannot be read (Missing, the link cannot be opened or needs login, no network tool) say so in the reply and do not guess the content; at delivery state which inputs were used and register the deliverables as output; do not register every source file changed. The tool description of `flowly_get_task` likewise hints at reading at the start of each turn and at `unread`.
- No automatic "new input" hint is attached before a message the user sends (AGENTS.md: an ordinary follow-up sends only the user's own text).

### 4.3 Settings

Settings › AI features gains **Artifacts › Agent artifacts** (on by default; stored in the `artifacts` field of the existing `ideas` host setting). When switched off, the two write tools return `ARTIFACTS_DISABLED` (same as `IDEAS_DISABLED`), the skill requires the agent to list deliverables in its reply instead and not retry; `get_task` returns as usual.

## 5. UI

### 5.1 Board card

The card face does not show artifacts (user decision).

### 5.2 Sidebar Artifacts block

Position: after the description and the run summary, before Sessions (artifacts are part of the task content, so placed ahead of Ideas/Links). Implementation: `client/task-artifacts.tsx`.

- The title `Artifacts`, with the count being the total; the `+` on the right opens the §5.3 form. With no artifacts only the title row and `+` are shown.
- Grouped by role, in the order `Outputs`, `Inputs`, within a group by `createdAt` descending; an empty group is not shown. Each group first shows 5 entries, below which "Show N more" appends another 5 each time (the same list, left-aligned with the rows already shown, not indented), with no collapse; it returns to 5 only after closing and reopening the sidebar or switching card. When there are artifacts the title is clickable (an arrow after the count) to collapse/expand the whole block, and whether it is expanded by default and the block position are both adjusted in Settings → Cards → Card sidebar ([DRAWER-SPEC](DRAWER-SPEC.md#section-order-and-artifacts-paging)).
- Each row: a type icon (`FileText` / directory `Folder` / link `Link`), the title (truncated to one line), and a second row dimly showing the note (truncated to one line; when there is none, the short path or host name); each row states its source: to the right of the title a small `User` or AI mark (`Sparkles`, AI-MARK-SPEC) icon is shown (accessibility "Added by you" / "Added by an agent"); the role is stated by the group title, and the accessibility name starts with "Input:" / "Output:"; when the file does not exist the title is dimmed and the second row starts with "Missing".
- Clicking a row: url uses `Linking.openURL`; file opens the §6.1 preview. Two icon buttons at the end of the row: **Edit** (pencil, opens §5.3, where the role, title and note can be changed) and **Remove** (`X`, no confirmation, optimistic removal collapsing over 160 ms, on failure it restores and shows an error toast, on success it shows the toast "Artifact removed. The file was not changed."). The host toast does not support action buttons, so there is no Undo; the plugin also has no clipboard API, so there is no Copy path.
- When the card or project is archived `+`, edit and remove are disabled, and the list is shown and opened as usual.
- The add/remove motion uses the `client/motion.tsx` primitives, follows Reduce Motion and is interruptible; rows that already exist do not play an enter animation when the drawer opens.

### 5.3 Add/edit form

A plugin Modal (a bottom sheet on phones), with all fields using `TextBox`/`Field`:

1. A role segmented choice: **Input** (default) / **Output**.
2. **Path or link**: an input (a relative path is based on the card's workspace), read-only when editing. v1 provides no file-browse button (the existing directory picker picks only directories).
3. **Title**: may be empty, and when left empty the default of §2.1 applies.
4. **Note**: may be empty, multi-line.

When submit fails the form is kept and the error is shown at the top.

## 6. Opening and preview

### 6.1 Preview RPC

`artifacts.preview({ id })` reads only the path registered for that artifact (it does not accept an arbitrary path), re-resolves on the server and checks that it is still within scope (to prevent it from being swapped after registration for a symlink pointing outside):

| File type | Returns |
| --- | --- |
| Image (png/jpg/gif/webp, ≤8 MB) | `dataUri`, and the client reuses the session image viewer |
| Text (md/txt/json/yaml/log/source code and so on, judged by extension and no NUL bytes, ≤256 KB) | `text`; markdown uses the existing conversation markdown rendering, the rest is shown monospaced |
| Directory | the first 200 entry names (not recursive) |
| Other or over the limit | `{ unsupported: true, size }`, and the UI shows the size and **Copy path** |
| Does not exist | "This file no longer exists." |

The preview is requested only once when opened, with no polling; the content is discarded on close. The preview content is placed directly in the scrollable body of the host popup, with no nested ScrollView (a nested scroll area on a phone steals the gesture).

## 7. Deletion, archive and wrap-up

- Permanently deleting a card: its artifacts are deleted with it, and written to the existing `removed/task-…json` backup (new `artifacts` field). Only the records are deleted, and files are not touched.
- Removing a project: the project's artifacts are deleted and backed up with it.
- Archive, wrap-up, restore: the records are kept. After wrap-up removes the worktree, file artifacts inside the workspace show Missing; after restore (rebuilding the worktree) they automatically become usable again. The wrap-up preflight adds no prompt because of artifacts (the existing warnings about uncommitted / local-only commits already cover the files in the worktree).

## 8. Error copy

| Case | Copy |
| --- | --- |
| Path outside scope | "Files outside this card's directories can't be added." |
| File does not exist | "This file doesn't exist." |
| URL scheme not supported | "Only http and https links can be added." |
| Limit | "A card can have at most 100 artifacts." |
| Archived | "Archived cards can't be changed." |
| Concurrent edit | "This artifact changed. Reload and try again." |
| Does not exist | "This artifact no longer exists." |
| Agent deleting one a person added | "Only the user can remove artifacts they added." |
| Setting off | `ARTIFACTS_DISABLED` |

## 9. Performance

- Artifacts are read once with the board; at most 100 per card, filtered by `taskId`.
- `missing` is not computed with a `stat` per item during the board read: it is computed only in `get_task` and in the `artifacts.status({ taskId })` requested when the drawer opens (one batched realpath, with the same set of targets cached for 15 s; the client does not refetch within 30 s).
- The preview loads on demand and its size is limited.

## 10. Not done (v1)

- Uploading/copying files into the plugin data directory (attachment storage); file versions, diff, hash verification.
- Automatically scanning the workspace or automatically extracting artifacts from conversations.
- Cross-card shared artifacts, a project-level artifact library; inheriting the source card's outputs as inputs when creating a follow-up (the user does not want it for now).
- Showing the artifact count or icon on the card face.
- Drag sorting of artifacts, custom fields beyond tags/categories.
- Editing file content inside the plugin.
- One-click collecting links/images from a session conversation as artifacts, file-browse picking, Reveal in workspace / Copy path, Undo after deletion (removed when v1 was implemented: the host has no clipboard or toast action API, can be added later).

## 11. Decided questions (2026-10-17, the user)

1. Store references only, do not upload copies.
2. An agent cannot delete artifacts a person added (it can delete agent-added ones). A person can delete any artifact.
3. Not shown on the card face; in the sidebar each entry says input/output and added by person/agent. Roles are kept only as input/output (the original reference merged into input).
4. Follow-up inheritance is not done for now.

## 12. Acceptance

- Unit (`shared/artifacts.test.ts`, `server/artifacts.test.ts`, `server/store.test.ts`, `server/tool-server.test.ts`): path resolution and scope checks (relative path, `..`, symlink escape, linked root), storage relative to the workspace and resolution after a worktree rebuild; URL validation; de-duplication and update rules; the limit; archived rejection; `updatedAt` conflict; only the board revision increases; events; agent delete permission; `ARTIFACTS_DISABLED`; preview of each type and size limit, a symlink swap after registration rejected; cascade and backup on card deletion / project removal; the `sessionContext` paragraph and truncation; the `get_task` fields.
- Client: group order and collapse, source marks, form defaults.
- i18n: all new copy goes into all catalogs; onboarding: a new tip `artifacts` (shown the first time a card drawer with artifacts is opened, "Artifacts collect a card's inputs and deliverables. Agents add them as they work; you can add files or links too."), and one line added to the README and the welcome page feature list.
- typecheck, full tests; install and reload; with a Luna 6 (`codex/gpt-6-luna`, `full-access`) test session on a fixture project, walk through: a person adding file/url/directory, rejection outside scope, edit and conflict, removal, the agent adding/updating/removing through MCP and CLI, deleting one a person added being rejected, the error after the setting is switched off, preview of image/markdown/large file, Missing display, card deletion cascade; desktop and compact layouts bind the non-fullscreen window per AGENTS.md, marked UNRUN when it cannot be bound. After finishing clean up the fixture, and save the evidence in `docs/verification/card-artifacts.md`.

## 2026-10-22 addition: register artifacts atomically at delivery

The `outputs?: {target,title?,note?}[]` of `flowly_update_status(in_review)` and `flowly_report_progress(result)` registers outputs in the same transaction; `[]` means no artifacts this time, and omitting it makes a reminder after success. It reuses this spec's path boundary, target de-duplication and user-entry protection. The receipt's `artifactIds` is persisted, and an exact replay neither re-validates files that have since vanished nor visits the connector again. The full contract, the switch behavior and the CLI parameters are in [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §1.

## 2026-11-08 addition: extra artifact folders

User request (via Loadout): the harness attaches files under `~/.claude/plans/<plan>/`, `~/.claude/reviews/` and `~/.claude/handoffs/`, which are outside the card directories and would be rejected by §2.2.

- Setting: "Extra artifact folders" under Settings > AI features > Artifacts (the host-scoped `artifacts` setting, `extraFolders`, at most 20 entries, each at most 1000 characters), a set of folder text boxes that can be added and removed; the description states only the consequence: an agent can attach any file under these folders to any card.
- Reading: an absolute path or `~/…`; `~` expands to the home directory, and the path is normalized (trailing slash, `.`/`..` removed), with duplicates dropped. An empty string, a relative path (including `~user`), the file system root `/`, the home directory itself and any of its ancestor directories are all ignored (too broad, and never become a root); a malformed whole setting is treated as an empty list. The text-level decision (`extraFolderIgnored`, a `~`/`/` path that after `.`/`..` normalization lands on the root, the home directory or an ancestor) is shared by the client and the server: a row ignored in Settings shows a line "Not used: …" below it.
- Real path: `withinRoots` compares realpaths, so the extra directories are also decided by real path (`resolveExtraRoots`, async): each directory is first realpath'ed (ones that cannot be resolved are dropped), and one whose real path is `/`, equals the home directory's real path or is its ancestor is dropped — a symlink pointing to `/` or the home directory, a case variant of the home directory on macOS, `/Users`, `~/..` can never become a root. `ArtifactService.where`/`status` and the agent's three `artifactRoots` calls all pass the result of `resolveExtraRoots`. When no extra directory is set, no realpath is done.
- Effect: these directories act as the `resolved` roots of every card (`artifactRoots(task, project, workspaceDirectory?, extra)`, separate from the card's own `roots`); they were already resolved to real paths when the setting was read, and the check compares them as they are without another realpath, so even if a directory is swapped after the setting was read for a symlink pointing elsewhere, the scope does not widen. The card's own `roots` are realpath'ed at each check (`missingArtifacts` resolves them once for the whole batch). The rules of `withinRoots` (target `realpath`, prefix comparison by separator) and `normalizeTarget` are unchanged, so `plans-old` does not count as inside `plans`, and a symlink inside a directory pointing outside it is rejected. A file outside the directories is still stored as an absolute path (§2.2).
- The setting is read at each use: after a directory is removed from the settings, the artifacts of files in it show "Missing" at the next status check (the cache key includes these directories), with the record kept; the human RPC and the agent tools (`flowly_artifact`, `outputs` at delivery, the `missing` of `flowly_get_task`) all use the same roots.
- Acceptance (`server/artifacts.test.ts`): a file inside an extra directory is accepted and stored with an absolute path; a sibling directory whose name has it as a prefix is rejected; a symlink inside the directory pointing outside is rejected; `missingArtifacts` marks missing after the directory is removed from the settings; a relative path, an empty string and `/` are ignored (including when passed directly to `artifactRoots`); a symlink to `/` or the home directory, a case variant of the home directory, the home directory and its ancestors are dropped, while a subdirectory under the home directory is kept; the hint in Settings is consistent with the server's text-level decision.

## 2026-11-10 addition: the card's plan

A card's plan is an artifact with the optional `plan` field (approval, source, `setAt`); at most one per card. It is shown in its own Plan row and left out of the Inputs/Outputs lists and of `get_task.artifacts` (returned as `get_task.plan`); the add/edit form's role choice gains **Plan**. An agent can't remove the plan artifact with `flowly_remove_artifact` (`ARTIFACT_FORBIDDEN`); deleting it as a person empties the slot. Each card's plan-copy folder (`<plugin data>/plans/<taskId>`) is one of its artifact roots. See [CARD-PLAN-SPEC](CARD-PLAN-SPEC.md).
