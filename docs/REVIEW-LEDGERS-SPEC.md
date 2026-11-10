# Review ledgers on cards

Status: implemented 2026-11-10 (branch `review-ledgers-on-cards`).

A review ledger is the per-PR markdown file the review skills keep outside every repository (one heading per review round, numbered findings with a status each). Agents were supposed to attach it to their card by hand and did not. Flowly now finds each card's ledger, attaches it as an output, keeps it current, and shows the newest round's status. It only reads the ledger folder: it never writes a ledger, and it makes no network call.

## 1. Matching a card to its ledger

Ledger folder layout: `<folder>/<owner>-<repo>/pr-<n>.md`, `pr-<n>-merged.md` after a merge, or `branch-<branch with / as ->.md` before a PR exists. The layout belongs to the review-ledger skill and is kept as is. It can collide: `a-b/c` and `a/b-c` share the folder `a-b-c`, and the branches `feat/x` and `feat-x` share `branch-feat-x.md`. Flowly does not try to tell them apart. The rules below keep a shared name from reaching the wrong card in the common cases.

- **A card with a `prRef`** (`owner/repo#n`) matches only `pr-<n>.md` / `pr-<n>-merged.md` in that repository's folder. It never falls back to a branch file and ignores its workspace's PR.
- **A card without a `prRef`** matches only when its workspace is a worktree it owns: Paseo's `workspaceKind` is `worktree`, the card's `ownsWorkspace` is true, and no other live card has the same workspace or workspace folder. Linked workspaces, directories, the main checkout and shared folders match nothing. In that worktree:
  - repository: the workspace's pull request (`githubRuntime.pullRequest.repoOwner/repoName`), else the worktree's origin remote (scp, `https://` or `ssh://` form; the last two path segments);
  - PR: the workspace's pull request number;
  - branch: the worktree's current branch, never the default branch (`main`, `master`, the origin HEAD's branch, or a detached `HEAD`).
- Paseo's workspace descriptor gives these facts. For an owned worktree, `git` in its folder fills the branch or remote when the descriptor lacks them and always gives the origin HEAD (`rev-parse --is-inside-work-tree`, `remote get-url origin`, `symbolic-ref --short -q HEAD`, `symbolic-ref --short -q refs/remotes/origin/HEAD`; argument arrays, never a shell). A folder that is not a git work tree, or has no origin, matches nothing.
- File choice, first that exists: `pr-<n>.md`, `pr-<n>-merged.md`, then the branch file. The `<owner>-<repo>` folder and the file names compare case-insensitively. Otherwise names must match exactly: no fuzzy matching, so `pr-4` never matches `pr-42`.
- **Several cards.** A PR ledger may go to several cards (a dev card and its review card share a PR). A branch ledger that more than one live card would match goes to none of them, as it is ambiguous. Card open works out every owned worktree card's branch for this check, just as the sweep does.
- **Facts.** "Read" means Flowly could tell what the card matches. A card with a `prRef` is always read. A card without one is unread when Paseo does not list its workspace and returns nothing for it (§3, kept records).

## 2. Summary

The newest round is the `## Round N:` heading with the highest N; its section runs to the next `#`/`##` heading. In it, each "Finding N" line (list item, numbered item, `###` heading, table row or bold label) is one finding, counted once by number. Its status is the text after `status:` on that line or on a following line before the next finding, else the last status word on the line: `open`, `fixed`, `deferred`, `not actioned`. Counting stops at a "Dismissed" line.

- Counts readable (at least one finding, every one with a status): `Review: round N · X open, Y fixed, Z deferred` ("raised, not actioned" is in none of the three).
- Otherwise: `Review: round N`. No round heading: no summary (empty note).
- A negated word states nothing: in "not fixed", "not yet deferred" or "never open" the word is skipped ("not actioned" is its own status). A finding whose only status is negated leaves the counts unreadable.
- Only the newest round's findings are counted, as the ledger format lists each finding under the round that raised it. A ledger over 1 MiB is not parsed (no summary).

## 3. The attachment

- An output file artifact (`role: "output"`, `kind: "file"`), target the ledger's absolute real path, title `Review ledger (<file name without .md>)`, note the summary, `createdBy: "human"` and `origin: "review-ledger"`. `origin` is a new optional field on `Artifact`; only Flowly sets it.
- `createdBy: "human"` (like Flowly's Handoff inputs) keeps agents from removing or editing it (CARD-ARTIFACTS-SPEC §4.1). People can edit or remove it like any artifact; the next sync sets the note back to the current summary, and a removed record comes back while the ledger exists (turn *Attach review ledgers* off to stop it).
- Flowly adds, updates and removes only records with `origin: "review-ledger"`. When an agent or a person already attached the same file (same target, or the same real path), Flowly adds none, and removes its own if it had one.
- Rename (`branch-…` → `pr-…` → `pr-…-merged`): the new file is added and the old record removed in the same sync.
- A card whose facts were read and that no longer matches a ledger (another branch, no longer an owned worktree, now ambiguous) loses its record at once, even when the file still exists.
- A record whose file is missing is removed only when it was also missing at the card's previous sync, so a ledger rewritten by delete-and-write is not churned. Until then it shows as Missing.
- A card whose facts could not be read this time keeps its record while the file exists.
- People's and agents' artifacts are read again inside the write, not from the sweep's earlier board read.
- A person who changes the record's role or title takes it over: `origin` is cleared and Flowly stops managing it. From then on it counts as the person's own, so Flowly adds no second record. A note edit does not take it over; the next sync resets the note to the summary. Targets cannot be edited (CARD-ARTIFACTS-SPEC §3).
- Adding and removing record `artifact_added` / `artifact_removed` events with actor `system`; note updates record none (CARD-ARTIFACTS-SPEC §2.3). Archived cards and cards in archived projects are never changed. A card at the 100-artifact limit gets none.
- Card details show it in Outputs with its note as the detail line, "Added by Flowly" as its source and a sync icon in place of the person/AI mark. `flowly_get_task` artifacts carry `origin: "review-ledger"` and the summary in `note`; session context lines label it `[flowly]`.

## 4. When it runs

- **Card open**: `artifacts.status` (called when a card's Artifacts section loads) syncs that card first.
- **`flowly_get_task`**: syncs the card before reading it (not for the context returned after a write).
- Both wait at most 1 second for the sync (`Promise.race`). A slower sync finishes in the background, and the record shows on the next read.
- **Sweep**: 30 seconds after the plugin starts (the backfill of existing ledgers), then every 5 minutes, over every non-archived card in a live project, with one paged workspace list and one listing of the ledger folder per sweep (card open lists the workspaces too, for the ambiguity check). A sweep still running is joined, never doubled; the timer is `unref`'d and stopped on unload.
- A card synced within the last 30 seconds (by any of these) is skipped on open and on `flowly_get_task`. Failures are logged with `logFailure` and never fail the RPC or tool.

## 5. Settings (host, `review-ledgers`)

| Setting | Default | Meaning |
| --- | --- | --- |
| *Attach review ledgers* (`attach`) | on | Off: nothing is added, updated or removed; existing records stay. |
| *Review ledger folder* (`folder`) | `~/.claude/reviews` | `~` expands to the home folder; empty reads as the default. |

The folder must exist and lie inside one of the extra artifact folders (CARD-ARTIFACTS-SPEC, 2026-11-08 增量), compared on real paths. Otherwise nothing attaches and Settings → AI features → Review ledgers says why under the folder field ("this folder doesn't exist" / "add this folder, or one that holds it, to Extra artifact folders"), from the `review-ledgers.check` RPC (`{ attach, usable, reason? }`).

## 6. Acceptance

- `pr-<n>.md`, `pr-<n>-merged.md` and branch ledgers attach to the matching cards; folder case ignored; near names and other repositories never match; non-git folders are skipped.
- A branch → PR → merged rename swaps the record. A deleted ledger's record goes after two syncs in a row with the file missing; one missing sync never churns it.
- No branch or workspace-PR match for shared, unowned, non-worktree or default-branch checkouts. A `prRef` card never matches a branch file. A branch ledger two cards would match goes to neither; a PR ledger goes to both.
- A card that no longer matches loses its record at once. An unreadable card keeps its record.
- A person's role or title edit hands the record over; a note edit does not.
- Card open and `flowly_get_task` wait at most a second.
- Agent- and person-added artifacts are never changed or removed, and the same file is never attached twice; agents cannot remove or edit Flowly's record.
- The summary reads the newest round, falls back to the round alone, and updates in place on a new round.
- Off, or a folder outside the extra folders: nothing attaches, and the settings screen says why.

Tests: `server/review-ledgers.test.ts` (made-up ledgers only).
