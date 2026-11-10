# Review ledgers on cards

Status: implemented 2026-11-10 (branch `review-ledgers-on-cards`).

A review ledger is the per-PR markdown file the review skills keep outside every repository (one heading per review round, numbered findings with a status each). Agents were supposed to attach it to their card by hand and did not. Flowly now finds each card's ledger, attaches it as an output, keeps it current, and shows the newest round's status. It only reads the ledger folder: it never writes a ledger, and it makes no network call.

## 1. Matching a card to its ledger

Ledger folder layout: `<folder>/<owner>-<repo>/pr-<n>.md`, `pr-<n>-merged.md` after a merge, or `branch-<branch with / as ->.md` before a PR exists.

- **Repository** (`owner/repo`): the card's `prRef` (`owner/repo#n`), else the workspace's pull request (Paseo workspace descriptor `githubRuntime.pullRequest.repoOwner/repoName`), else the workspace's origin remote (`gitRuntime.remoteUrl`), else the project folder's origin remote. Remote URLs in scp (`git@host:o/r.git`), `https://` and `ssh://` forms; the last two path segments are owner and repo.
- **PR number**: `prRef`, else the workspace's pull request number (ignored when it is for another repository than `prRef`'s).
- **Branch**: the workspace's current branch (`gitRuntime.currentBranch`).
- When the descriptor lacks the branch or remote (a workspace Paseo no longer lists, an older daemon), `git` fills them from the workspace folder (`rev-parse --is-inside-work-tree`, `remote get-url origin`, `symbolic-ref --short -q HEAD`; argument arrays, never a shell). A folder that is not a git work tree, or has no origin, gives no repository: the card is skipped.
- File choice, first that exists: `pr-<n>.md`, `pr-<n>-merged.md`, then the branch file. The `<owner>-<repo>` folder and the file names compare case-insensitively; otherwise names must match exactly (no fuzzy matching, `pr-4` never matches `pr-42`).
- Two cards on the same PR or branch both get the ledger.

## 2. Summary

The newest round is the `## Round N:` heading with the highest N; its section runs to the next `#`/`##` heading. In it, each "Finding N" line (list item, numbered item, `###` heading, table row or bold label) is one finding, counted once by number. Its status is the text after `status:` on that line or on a following line before the next finding, else the last status word on the line: `open`, `fixed`, `deferred`, `not actioned`. Counting stops at a "Dismissed" line.

- Counts readable (at least one finding, every one with a status): `Review: round N · X open, Y fixed, Z deferred` ("raised, not actioned" is in none of the three).
- Otherwise: `Review: round N`. No round heading: no summary (empty note).
- Only the newest round's findings are counted, as the ledger format lists each finding under the round that raised it. A ledger over 1 MiB is not parsed (no summary).

## 3. The attachment

- An output file artifact (`role: "output"`, `kind: "file"`), target the ledger's absolute real path, title `Review ledger (<file name without .md>)`, note the summary, `createdBy: "human"` and `origin: "review-ledger"`. `origin` is a new optional field on `Artifact`; only Flowly sets it.
- `createdBy: "human"` (like Flowly's Handoff inputs) keeps agents from removing or editing it (CARD-ARTIFACTS-SPEC §4.1). People can edit or remove it like any artifact; the next sync sets the note back to the current summary, and a removed record comes back while the ledger exists (turn *Attach review ledgers* off to stop it).
- Flowly adds, updates and removes only records with `origin: "review-ledger"`. When an agent or a person already attached the same file (same target, or the same real path), Flowly adds none, and removes its own if it had one.
- Rename (`branch-…` → `pr-…` → `pr-…-merged`): the new file is added and the old record removed. A record whose file is gone is removed. When the card's facts cannot be read this time (no repository known) or no ledger is found, an existing record whose file still exists is kept.
- Adding and removing record `artifact_added` / `artifact_removed` events with actor `system`; note updates record none (CARD-ARTIFACTS-SPEC §2.3). Archived cards and cards in archived projects are never changed. A card at the 100-artifact limit gets none.
- Card details show it in Outputs with its note as the detail line, "Added by Flowly" as its source and a sync icon in place of the person/AI mark. `flowly_get_task` artifacts carry `origin: "review-ledger"` and the summary in `note`; session context lines label it `[flowly]`.

## 4. When it runs

- **Card open**: `artifacts.status` (called when a card's Artifacts section loads) syncs that card first.
- **`flowly_get_task`**: syncs the card before reading it (not for the context returned after a write).
- **Sweep**: 30 seconds after the plugin starts (the backfill of existing ledgers), then every 5 minutes, over every non-archived card in a live project, with one paged workspace list and one listing of the ledger folder per sweep. A sweep still running is joined, never doubled; the timer is `unref`'d and stopped on unload.
- A card synced within the last 30 seconds (by any of these) is skipped on open and on `flowly_get_task`. Failures are logged with `logFailure` and never fail the RPC or tool.

## 5. Settings (host, `review-ledgers`)

| Setting | Default | Meaning |
| --- | --- | --- |
| *Attach review ledgers* (`attach`) | on | Off: nothing is added, updated or removed; existing records stay. |
| *Review ledger folder* (`folder`) | `~/.claude/reviews` | `~` expands to the home folder; empty reads as the default. |

The folder must exist and lie inside one of the extra artifact folders (CARD-ARTIFACTS-SPEC, 2026-11-08 增量), compared on real paths. Otherwise nothing attaches and Settings → AI features → Review ledgers says why under the folder field ("this folder doesn't exist" / "add this folder, or one that holds it, to Extra artifact folders"), from the `review-ledgers.check` RPC (`{ attach, usable, reason? }`).

## 6. Acceptance

- `pr-<n>.md`, `pr-<n>-merged.md` and branch ledgers attach to the matching cards; folder case ignored; near names and other repositories never match; non-git folders are skipped.
- A branch → PR → merged rename swaps the record; a deleted ledger's record goes on the next sweep.
- Agent- and person-added artifacts are never changed or removed, and the same file is never attached twice; agents cannot remove or edit Flowly's record.
- The summary reads the newest round, falls back to the round alone, and updates in place on a new round.
- Off, or a folder outside the extra folders: nothing attaches, and the settings screen says why.

Tests: `server/review-ledgers.test.ts` (made-up ledgers only).
