# Move a card to Done when its work lands

Status: implemented 2026-11-16 (rulings by Noah, 2026-11-16, below).

When a card's own work has landed on its project's base branch on the remote, Flowly moves the card to Done. It does this in the same check that archives PR review cards (PR-REVIEW-CARDS-SPEC §10). There is no second timer.

## 1. Rulings (Noah, 2026-11-16)

- **R1: landed means Done.** Landed work moves the card to Done. It does not move it to Integrated, and it does not archive it.
- **R2: lanes.** Only cards in *In review*, *Committed* or *Integrated* are checked. A card in Todo, Design, Development, Test or Blocked is mid-work or in rework and is left alone.
- **R3: running sessions.** A card whose workspace has a running or starting session is skipped and looked at again in a later check, as for review cards.
- **R4: a PR closed without merging.** The card gets one activity note, "PR closed without merging: `<owner/repo#n>`", once per PR. It is not moved and not archived.
- **R5: base branch.** "Base" means the card's base branch (`task.baseRef`, for example `refs/heads/dev`), not literally `main`. A merge into `dev` counts. A later `dev` → `main` release PR is not the card's work.
- **R6: git check.** This partly reverses INTEGRATED-STAGE-SPEC user decision 2 ("the daemon does not check git"). The daemon may check git for this purpose only, and only in a card's own worktree. The check is the card's own branch against the remote base branch, so the shared-checkout attribution problem behind decision 2 does not arise. Directory cards, linked cards and legacy cards get no git check (§3.3).
- **R7: squash merge without a PR.** It is not detected, because the card's commits are then not ancestors of the base branch. The user moves that card by hand.
- **R8: setting.** A new switch controls this, **Move cards to Done when their work lands**, on by default (§5).

## 2. Which cards

A check looks at each card that meets all of the following:

- not archived, in a live project;
- not a PR review card (`pr-review:` operation id; those keep PR-REVIEW-CARDS-SPEC §10);
- in *In review*, *Committed* or *Integrated* (R2);
- in a workspace with no running or starting session (R3);
- with evidence to check (§3): exactly one PR in its outputs, or a worktree with a `baseRef`.

The delivery mode does not choose the check. The evidence does, so a card whose mode changed is still covered. In practice:

| Delivery mode | Usual evidence |
|---|---|
| Draft PR / Ready PR | the PR output (§3.1) |
| Branch, I bless | a PR whose head is the card's branch (§3.2), else the ancestor check (§3.3) |
| Ship to main | the ancestor check (§3.3) |

## 3. Evidence, in order

The first source that applies decides, and the later ones are not tried.

### 3.1 The card's PR output

These count as the card's PR: its output artifacts whose target is a GitHub pull request URL (`https://<host>/<owner>/<repo>/pull/<n>`), or that carry an `external` ref with `itemType: "pull"`. When they name exactly one distinct PR (`owner/repo#n`, compared in lower case), Flowly reads that PR's state with the same lookup as review cards: the GitHub connector first, then `gh pr view`.

- `merged`: the card moves to Done (§4).
- `closed`: the card gets the R4 note, at most once per PR.
- `open`: nothing happens.
- unknown: nothing happens, and the failure counts toward the "logged once" line.

When the outputs name two or more distinct PRs, the card is left alone. One card is at most one PR, so more than one PR means a person should look. No other source is tried for that card.

The paseo-linked-prs workspace map is not used. Its `mentioned` list holds every PR mentioned in a workspace's chats, so it cannot name the card's own PR.

### 3.2 A PR whose head is the card's branch

This source applies only to a worktree card (the card's workspace directory is a git worktree and the card has a `baseRef`) that has no PR output. Its branch is the branch checked out in the workspace directory; a detached HEAD skips this source and §3.3. Flowly runs `gh pr list --head <branch> --state all --json number,state,url,mergedAt --limit 5` in that directory, as an argument array with no shell.

- If any listed PR is merged, the card moves to Done.
- If none is merged, the card is not moved by this source, and §3.3 still runs. A closed PR found this way gets no R4 note, because the card never claimed it.
- If the lookup fails, Flowly goes on to §3.3.

### 3.3 The ancestor check

This source applies only to a worktree card with a `baseRef` (R6), when §3.2 found no merged PR. With `base` = `baseRef` minus `refs/heads/`, all of the following must hold:

1. The workspace has no uncommitted changes (`git status --porcelain` is empty). Work that isn't committed hasn't landed.
2. The branch has moved since the worktree was created: the oldest entry of `git reflog show <branch>` names a different commit than `HEAD`. A worktree with no commits of its own is trivially an ancestor of its base, so it must not count. With no reflog, the check is skipped and the card is left alone.
3. `git fetch origin <base>` succeeds.
4. `git merge-base --is-ancestor HEAD origin/<base>` exits 0.

When all four hold, the card moves to Done. A non-zero exit at step 4 leaves the card unchanged. A git failure at any step also leaves it unchanged and counts as unknown.

## 4. Moving to Done

Inside one store transaction, Flowly reads the card again. It leaves the card alone if the card was archived, left the R2 lanes, moved to another workspace, or (for §3.1) its single PR changed since the check read it. Otherwise it moves the card to Done the way a person's move to Done does: the status, the revision and the `status_changed` event, with `actor: "system"` and the note "Moved to Done: PR merged (`owner/repo#n`)" or "Moved to Done: work landed on `<base>`". Everything the daemon runs after any move into Done runs here too (`afterStatus`: the project memory review, guardrails, and *Auto wrap up*, MULTITASK-SPEC). The wrap-up question is not asked: the client asks it only after its own move, so a daemon move has no client to ask it. The card's Wrap up action stays available. The card is not archived.

The R4 note is a `note` event with `actor: "system"` on the card. Before writing one, Flowly looks through the card's activity for the same note and writes nothing if it is already there. A restart therefore never repeats it.

## 5. Setting

Settings → Workflow → Board → **Move cards to Done when their work lands**. It is stored in the same host settings record as the review-card switches (`pr-review-cards`, new field `doneOnLand`) and is on by default (R8). The loop runs when this switch or *Archive review cards when the PR closes* is on. Each switch gates only its own kind of card.

## 6. The shared loop

One check builds one list: the review-card candidates (PR-REVIEW-CARDS-SPEC §10) and the cards of §2. The list is sorted with the cards looked at least recently first, then by `updatedAt`, and at most 20 lookups run per check. Each card counts as one lookup, whatever sources §3 tries for it. The first-run delay, the 10-minute interval, joining a check that is already running, and the two "logged once" lines are unchanged. The unknown-state log line covers both kinds of card.

## 7. Compatibility

- **Integrated** keeps its meaning (INTEGRATED-STAGE-SPEC): the agent sets it once the card's commits are in the main checkout's branch. A card in Integrated whose work then reaches the remote base branch moves on to Done. The "Reconcile Flowly auto review / Ship to main with the user's Claude Code harness" card decides how Integrated fits a PR workflow. This check reads only remote state, so it works with either answer.
- Auto review never moves a card to Done (AGENTS.md). This check is a separate, user-approved path, and it only runs after the work is on the remote.

## 8. Acceptance

- With the switch on, a card in In review, Committed or Integrated whose single PR output is merged moves to Done at the next check, with the note "Moved to Done: PR merged (…)". An open PR changes nothing.
- A closed PR adds one "PR closed without merging" note. A second check, or a check after a restart, adds no second note. The card stays in its lane.
- A worktree card with no PR output, no uncommitted changes, a branch that has moved since creation, and `HEAD` an ancestor of `origin/<base>` moves to Done with "Moved to Done: work landed on <base>". A fresh worktree with no commits of its own, a card with uncommitted changes, and a card whose head isn't on the remote base all stay.
- A worktree card whose branch is the head of a merged PR moves to Done.
- These cards stay: a card in Todo, Design, Development, Test or Blocked; a card whose workspace has a running session; a card with two distinct PR outputs; a directory card with no PR output; a card where neither source can read the state.
- With the switch off, no normal card moves, and review cards still archive (and the reverse when only the review switch is off).
- Review cards and normal cards share one check and one 20-lookup cap.
