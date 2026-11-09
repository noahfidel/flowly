# Ideas import and export (IDEAS-IMPORT-EXPORT-SPEC)

Status: user decisions 2026-11-08, Flowly single pane (plan Tasks 2 and 3). Builds on [PROJECT-IDEAS-SPEC](PROJECT-IDEAS-SPEC.md): imported items become project ideas.

## 1. Goal and non-goals

Bring a markdown backlog (a `- [ ] item` list with `(added …)` notes, as kept per repository in `~/.claude/backlogs/`) into a project's Ideas, after the user has reviewed every row. Export is specified in §7 (Task 3).

Non-goals:

- Reading files or directories from disk: the user pastes the text.
- Keeping the markdown in sync after the import, or writing back to it.
- Importing `[x]` items by default, or turning items into cards.
- Parsing the source note into a branch, date or ticket field: it is kept as one text.

## 2. Parse rules

`parseBacklog(markdown)` (`shared/ideas-import.ts`) returns rows. Lines are split on `\n` or `\r\n`.

- A row is a line at column 0 that starts with `- [ ] ` or `- [x] `. Everything else (headers such as `# repo backlog`, prose, blank lines, `- ` lines that are not checkbox items, indented lines under no item) is skipped.
- `done` is `true` for `[x]`; `keep` is `!done`.
- **Source note.** The last top-level parenthetical of the item text that starts with `added`, `started` or `pre-existing`, or contains `added `, is the `source` (without its parentheses), such as `added 2026-10-20, kanban/fix-x`, `started 2026-10-21; added 2026-10-20, a-branch`, `pre-existing, added 2026-10-29, a review`, `added 11/03/26, a-branch`. It is one opaque text, never read as a branch. Parentheses inside code spans (backticks) are ignored when scanning; a title's own parentheses stay in the title. No such parenthetical: `source` is `null`. An item that is only a note keeps that text as its title and has no source.
- **Title.** The item text with the source note taken out. Text after a mid-line note stays: `Task 3 follow-ups (added 2026-10-27, x): (a) … (b) …` gives the title `Task 3 follow-ups: (a) … (b) …` (no space is put before `:`, `;`, `,` or `.`). Titles may contain backticks, colons and prefixes such as `SECURITY:` or `URGENT:`; they are not altered.
- **Cap.** A title longer than 120 characters is cut at the last space that leaves at most 119 characters, trailing `,;:` and spaces removed, and `…` appended (a single word longer than 119 characters is cut hard). A cut title puts the full original item text (including its source note) first in `detail`.
- **Notes.** Lines directly after an item that start with two spaces and `- ` join `detail` as `- <text>` lines, in order. A blank line, a non-matching line or another item ends them; deeper-indented lines are not notes.
- `line` is the 1-based line number of the item in the pasted text. `detail` is cut to 4000 characters and `source` to 1000, each ending in `…` when cut, so no row fails the row schema on length.

## 3. Preview

RPC `ideas.import-preview` `{ projectId, markdown }` (markdown at most 500 000 characters) → `{ rows, duplicates }`: the rows of `parseBacklog`, and the indexes of rows whose title (trimmed, case-insensitive) equals an open project idea of the project, or repeats an earlier row of the same paste (the second and later occurrences are flagged). An unknown project is `NOT_FOUND`. Nothing is written.

## 4. Import

RPC `ideas.import` `{ projectId, rows, operationId }` (at most 1000 rows) → `{ created, skipped: [{ line, reason }] }`.

- Only rows with `keep: true` are considered; the client sends the rows the user left checked.
- One write for the whole import. Each kept row becomes an open project idea (PROJECT-IDEAS-SPEC §3) with `title`, `detail`, `source`, empty `rationale` and `context`, no agent and no board event.
- A row whose title equals an open project idea (existing, or an earlier row of the same import) is skipped with "Already an open idea in this project."; a row the idea limits refuse is skipped with the reason. Skipped rows do not stop the rest.
- An archived project fails with `PROJECT_ARCHIVED`, an unknown one with `NOT_FOUND`; nothing is written.
- **Replay.** The same `projectId` and `operationId` return the first result without writing. The daemon remembers the last 50 results; a retry after a restart finds the imported titles already open and skips them, so no idea is created twice; the client shows that result (nothing created, every row skipped as already open) as the neutral toast "Already imported.", not as an error.

## 5. UI

The Ideas page has an **Import** button (hidden for an archived project). It opens a modal:

1. A multiline text box to paste markdown; **Review** is enabled once there is text.
2. The review list: one checkbox row per item with its title. Rows that are `[x]` show **Done** and start unchecked; rows already open in the project show **Already open** and start unchecked. **Select all** (all except already-open rows) and **Select none**. **Back** returns to the text. **Import N ideas** is disabled at zero checked rows.

The result shows as a toast ("Imported N ideas", plus "N skipped" when some were skipped); the Ideas page then shows the new ideas. "Already imported." replaces it when nothing was created and every row was already open. A text with no items shows "No backlog items found."

## 6. Acceptance criteria

1. Synthetic fixtures (`shared/fixtures/backlogs/`) covering every line shape of the real backlogs parse to one row per checkbox line; the same test runs against `~/.claude/backlogs` (or `FLOWLY_BACKLOG_DIR`) and is skipped when the directory is absent.
2. Headers and prose are skipped; the added suffix becomes the source; a mid-line note keeps the prose in the title; titles over 120 characters are cut at a word with the full text first in `detail`; indented notes join `detail`; `[x]` items are rows with `keep: false`.
3. An import creates exactly the kept rows, skips duplicates with a reason, refuses an archived or unknown project, and returns the first result for a repeated `operationId`.
4. The preview flags rows whose title matches an open project idea or repeats an earlier row of the paste.
5. Long notes or a long original line are cut to fit with `…`; the same `operationId` in two projects imports into both.

## 7. Export

Written with Task 3.
