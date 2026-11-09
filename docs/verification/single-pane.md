# Flowly single pane: live checks

`docs/verification/single-pane-live.mjs` checks the single pane (dispatcher, `flowly_start_card`, asks, import and export) against the real daemon with the branch build installed. Noah runs it after backing up plugin data and installing; the implementing session wrote it and ran only `node --check` and `--help`.

```sh
FLOWLY_TELEMETRY=0 node docs/verification/single-pane-live.mjs [--only 1,2,…]
```

Run it from the repository root with Paseo's daemon up. It reads the daemon address and local credential from `~/.paseo` (as `background-workspace-2026-10-23-live.mjs` does). It drives no UI: RPC only. Telemetry stays off: the daemon should run with `FLOWLY_TELEMETRY=0`; the script says so when `telemetry.status` shows it does not.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every selected check passed and cleanup was verified. **With a dispatcher of your own, exit 0 needs `--use-existing-dispatcher`** (see below); without it checks 1, 3 and 4 skip and the run exits 2 |
| 1 | a check failed, cleanup left something behind, or `--cleanup` refused its record |
| 2 | no failure, but a check was skipped (a precondition this run must not create) |
| 64 | bad arguments |
| 130 / 143 | interrupted by Ctrl-C (SIGINT) / SIGTERM; cleanup ran first |

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
- A dispatcher, only when you have no dispatcher record at all (checks 1, 3, 4): started by the script, archived at the end (`--keep-dispatcher` keeps it). A dispatcher you already have is yours **in any state** (running, idle, ended, failed or archived) and is not touched: those checks skip, and the skip text names `--use-existing-dispatcher`. That flag sends the test prompts to your real dispatcher, and when yours is dead, the replacement the script starts archives that ended session (that archive is the assertion check 1 makes about replacement). The dispatcher workspace is never touched.
- A script-started dispatcher is a real dispatcher: besides the test prompts it receives the board summary and the notes from real board activity (other cards' stops) while it lives. Check 3 counts only notes about its own card, but a busy board adds noise to the transcript.
- Cleanup order: sessions of the run (cancel, archive), memory entry, cards (`tasks.delete` with archive: their sessions and own workspace go to Paseo's archive), fixture project, branches, dispatcher, temp directories. It then verifies: no card with the prefix on the board, no fixture project, none of the run's workspaces active in Paseo, none of its sessions live, the Tinylink project still there. Any leftover is printed as `CLEANUP PROBLEM` and exits 1.
- Left behind on purpose: the dispatcher chat keeps note rows for the deleted cards until its 500-item cap prunes them.

## Cleanup safety

The record file is untrusted input: `--cleanup` validates it before connecting to the daemon and refuses the whole cleanup (message on stderr, exit 1) when anything is off.

- `runId` is 6 lowercase hex characters, `marker` is `[single-pane-live <runId>]`, the file is named `single-pane-live-<runId>.json`, and every recorded card title carries the marker.
- Fixture directories are direct children of `os.tmpdir()` (never the temp directory itself) named `single-pane-live-fixture-*`. A fixture project is removed only when its title starts with the marker and its path is one of those directories.
- The live board decides, never the record: a card counts only when its current title carries the marker and it sits in Tinylink (re-resolved) or a verified fixture project. A real card id forged into the record with a marked title is ignored.
- Sessions are archived only when verified: labels `flowly-started-by=single-pane-live` and `single-pane-live-run=<runId>` (this run's id), or the `flowly-task` label of such a live marked card, or the dispatcher this run recorded starting.
- A memory entry is deleted only in a verified fixture project (the script creates memory nowhere else; Tinylink's memory is never touched), after reading it, and only when its title carries the marker.
- From `--cleanup`, a dispatcher the record says this run started is listed as `left in place` and not archived; add `--yes-archive-dispatcher` to archive it. A normal run (and the Ctrl-C cleanup of a normal run) archives it as before, unless `--keep-dispatcher`. A dispatcher session created before the record's `startedAt`, with no readable time, or whose read fails is never archived, with or without the flag; the signal notice mentions the flag.
- A temp directory is removed only when it is the directory of one of this run's fixture projects (verified, or already gone from the board), or when the run made it but never registered it as a project (its `.single-pane-live-run` file, written before the directory is recorded and excluded from Git, holds this runId, and no project sits in it); any other recorded directory is reported as `left in place`.
- The Tinylink project id and root are never taken from the record: they are re-resolved from `docs/promo/ids.json` or the project titled Tinylink, and the recorded id must match.
- Branches are deleted only when they match `kanban/single-pane-live-<runId>-*`, and only when no worktree that still exists on disk holds them (`git worktree prune` runs first). A recorded card's other branch is reported as `left in place: <branch>`.
- The first line of every run prints the exact retry command (`node docs/verification/single-pane-live.mjs --cleanup <record file>`, with `--home` when it is not the default). Ctrl-C or SIGTERM stops the running check at its next poll, runs cleanup once, then exits 130 or 143; a second signal exits at once and you run the retry command. The cleanup report prints once, and after any signal exit the retry command is printed again with a reminder that a check blocked in a long RPC may still have created things after cleanup started; the retry command covers them.
- Dispatcher states (`none`, `running`, `idle`, `ended`; `shared/dispatcher.ts`, derived in `server/dispatcher.ts` by `isDeadDispatcher`): `dispatcher.start` is refused unless the stored session is dead (archived, closed or missing). With `--use-existing-dispatcher`, an ended dispatcher is replaced and a running or idle one is messaged.
- Check 6 skips (not fails) when memory is off for the fixture project: `memory.read` returns `enabled: false` then, and it throws for an unknown project; the script skips on either.

## Fixtures and options

- Check 5 reads `zenlytic.md` from `$FLOWLY_BACKLOG_DIR` (default `~/.claude/backlogs`), or `--backlog <file>`; without either it falls back to the synthetic `shared/fixtures/backlogs/recipes.md` and says so. The real file is read at run time on Noah's machine and is never copied into the repository.
- The sessions the script starts itself (checks 2 and 7) use `claude/claude-haiku-5-5`. Check 2's permission needs a command Noah's permission rules do not already allow: it runs `touch SINGLE-PANE-LIVE-PERMISSION.txt` in the card's worktree; if that is pre-allowed, no ask appears and the check fails with a timeout naming the ask it waited for.
- Check 7 compares two numbers over the whole board, so another card's change or any real activity (a session asking, a card stopping) while it runs can disturb it; it reads until the two agree (45 s) and reports both numbers when they do not. Run it while the board is quiet and rerun it alone (`--only 7`) before treating a mismatch as a bug.
- Check 6 needs the memory feature on for the fixture project (its memory entry is part of the export). When it is off, the check skips cleanly with that reason instead of failing.
- Check 1 prints a note when there was no earlier directory workspace to archive: the archive assertion was then not exercised, and the run says so rather than passing silently.

## Last result

Not run live. Written and dry-checked at the commit that adds it: `node --check` exit 0; `--help` exit 0, prints checks 1–7; `--only 9` exit 64; `scripts/single-pane-live.test.ts` (argument parsing, check list, `--help`, record validation, fixture and branch guards, forged-record cleanup against a fake daemon, memory and dispatcher guards, signal reporting, retry command) 39 passed. Noah's live run of checks 1–7 is the remaining gate (plan "Done"); paste its output here when it exits 0.
