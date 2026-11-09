# Flowly single pane: live checks

`docs/verification/single-pane-live.mjs` checks the single pane (dispatcher, `flowly_start_card`, asks, import and export) against the real daemon with the branch build installed. Noah runs it after backing up plugin data and installing; the implementing session wrote it and ran only `node --check` and `--help`.

```sh
FLOWLY_TELEMETRY=0 node docs/verification/single-pane-live.mjs [--only 1,2,…]
```

Run it from the repository root with Paseo's daemon up. It reads the daemon address and local credential from `~/.paseo` (as `background-workspace-2026-10-23-live.mjs` does). It drives no UI: RPC only. Telemetry stays off: the daemon should run with `FLOWLY_TELEMETRY=0`; the script says so when `telemetry.status` shows it does not.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every selected check passed and cleanup was verified |
| 1 | a check failed, or cleanup left something behind |
| 2 | no failure, but a check was skipped (a precondition this run must not create) |
| 64 | bad arguments |

## Checks

| # | Check | Needs |
|---|---|---|
| 1 | Dispatcher "make a card for X and start it": the card exists; its session (label `flowly-task=<card>`) runs in a new worktree workspace; the card's empty directory workspace is archived; a second `dispatcher.start` is refused while one runs. **Needs the final fix round:** after an ended dispatcher, the new one archives the dead one (checked only when an ended dispatcher existed). | Tinylink, dispatcher |
| 2 | Asks: a Flowly question, an AskUserQuestion and a permission request from card sessions appear in `dispatcher.items-changed`; `asks.answer` reaches each session (the permission's command runs, AskUserQuestion reports the chosen label, the question's text is in the transcript); the `delivered` tick appears only after success; a repeated answer is not delivered; answering an ended session returns `session_ended` with no tick | Tinylink |
| 3 | A status change on a card gives the dispatcher exactly one batched note (one note item, one user message mentioning the card); the dispatcher's own card create gives none | Tinylink, dispatcher |
| 4 | The dispatcher splits a two-deliverable plan into two cards and starts both: two worktrees, two sessions. Wrapping up one card removes its worktree workspace from Paseo's active list and leaves the other | Tinylink, dispatcher |
| 5 | A copy of the backlog through `ideas.import-preview` then `ideas.import` into a throwaway fixture project: ideas created = kept rows; open project ideas match; a replay returns the first result | fixture project |
| 6 | `board.export-markdown` lists the fixture project with its open card, idea and memory entry | fixture project |
| 7 | `attention.count` equals the open asks in the chat; dismissing in the chat lowers the bell by one; dismissing in the bell marks the chat ask dismissed | Tinylink |

Check 4 uses Wrap up, not archive: archiving a card never archives Paseo resources (plan "Spec issues" #4).

The Delivery mode ruling (editable until the card delivers) and the one-dispatcher ruling (no "context full → start fresh") need no check of their own here: nothing in checks 1–7 depends on delivery mode, and check 1 asserts the one-dispatcher behavior that exists today (a second start is refused while one runs) and the ruled replacement of a dead one.

## What it creates, and what it never touches

- A run id (random, 6 hex) and the title prefix `[single-pane-live <run>]` on every card, fixture project and session it makes. Every id is written to `$TMPDIR/single-pane-live-<run>.json` before it is used (the path is printed first). If the script dies, `node docs/verification/single-pane-live.mjs --cleanup <that file>` finishes the cleanup.
- Tinylink (`docs/promo/ids.json`, else the project titled "Tinylink"): cards with the prefix, in worktrees (checks 2 and 7) or directory workspaces (check 3), their sessions, and the worktree branches (`kanban/…`) this run made. The project, its directory and its other cards, sessions and branches are never touched: only recorded ids with the prefix are deleted, and only inside the Tinylink or fixture projects.
- A temporary git repository under `os.tmpdir()` registered as a fixture project (checks 5 and 6), with one card, one project idea, one memory entry and the imported ideas. It is removed with Remove project (also from Paseo) and the directory deleted.
- A dispatcher, when none is running (checks 1, 3, 4): started by the script, archived at the end (`--keep-dispatcher` keeps it). A running dispatcher the script did not start is **not messaged**: those checks skip, unless `--use-existing-dispatcher` says the real dispatcher may receive the test messages. The dispatcher workspace is never touched.
- Cleanup order: sessions of the run (cancel, archive), memory entry, cards (`tasks.delete` with archive: their sessions and own workspace go to Paseo's archive), fixture project, branches, dispatcher, temp directories. It then verifies: no card with the prefix on the board, no fixture project, none of the run's workspaces active in Paseo, none of its sessions live, the Tinylink project still there. Any leftover is printed as `CLEANUP PROBLEM` and exits 1.
- Left behind on purpose: the dispatcher chat keeps note rows for the deleted cards until its 500-item cap prunes them.

## Fixtures and options

- Check 5 reads `zenlytic.md` from `$FLOWLY_BACKLOG_DIR` (default `~/.claude/backlogs`), or `--backlog <file>`; without either it falls back to the synthetic `shared/fixtures/backlogs/recipes.md` and says so. The real file is read at run time on Noah's machine and is never copied into the repository.
- The sessions the script starts itself (checks 2 and 7) use `claude/claude-haiku-5-5`. Check 2's permission needs a command Noah's permission rules do not already allow: it runs `touch SINGLE-PANE-LIVE-PERMISSION.txt` in the card's worktree; if that is pre-allowed, no ask appears and the check fails with a timeout naming the ask it waited for.
- Check 7 compares two numbers over the whole board, so another card's change while it runs can disturb it; it reads until the two agree (45 s) and reports both numbers when they do not.

## Last result

Not run live. Written and dry-checked at the commit that adds it: `node --check` exit 0; `--help` exit 0, prints checks 1–7; `--only 9` exit 64; `scripts/single-pane-live.test.ts` (argument parsing, check list, `--help`) 7 passed. Noah's live run of checks 1–7 is the remaining gate (plan "Done"); paste its output here when it exits 0.
