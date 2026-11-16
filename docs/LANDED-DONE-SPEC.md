# Move a card to Done when its work lands

Status: implemented 2026-11-16 (rulings by Noah, 2026-11-16, below).

When a card's own work has landed on its project's base branch on the remote, Flowly moves the card to Done. It does this in the same check that archives PR review cards (PR-REVIEW-CARDS-SPEC §10). There is no second timer.

## 1. Rulings (Noah, 2026-11-16)

- **R1: landed means Done.** Landed work moves the card to Done. It does not move it to Integrated, and it does not archive it.
- **R2: lanes** (ruling Noah 2026-11-16, later the same day; reverses the first R2, which checked only In review, Committed and Integrated and missed a card left in Development after its PR merged). A card in Design, Development, Test, Blocked, In review, Committed or Integrated is checked. Todo and Backlog cards have no work to land and are left alone; Done and Cancelled are finished.
- **R3: running sessions.** Only a session whose status is running or initializing (mid-turn, including one waiting on a permission prompt, which Paseo reports as running) makes the check skip the card; it is looked at again in a later check, as for review cards. An idle, closed or errored session does not block (ruling 2026-11-16, confirmed).
- **R4: a PR closed without merging.** The card gets one activity note, "PR closed without merging: `<owner/repo#n>`", once per PR. It is not moved and not archived.
- **R5: base branch.** "Base" means the card's base branch (`task.baseRef`, for example `refs/heads/dev`), not literally `main`. A merge into `dev` counts. A later `dev` → `main` release PR is not the card's work.
- **R6: git check.** This partly reverses INTEGRATED-STAGE-SPEC user decision 2 ("the daemon does not check git"). The daemon may check git for this purpose only, and only in a card's own worktree. The check is the card's own branch against the remote base branch, so the shared-checkout attribution problem behind decision 2 does not arise. Directory cards, linked cards and legacy cards get no git check (§3.3).
- **R7: squash merge without a PR.** It is not detected, because the card's commits are then not ancestors of the base branch. The user moves that card by hand.
- **R8: setting.** A new switch controls this, **Move cards to Done when their work lands**, on by default (§5).

## 2. Which cards

A check looks at each card that meets all of the following:

- not archived, in a live project;
- not a PR review card (`pr-review:` operation id; those keep PR-REVIEW-CARDS-SPEC §10);
- in *Design*, *Development*, *Test*, *Blocked*, *In review*, *Committed* or *Integrated*, not Todo or Backlog (R2);
- in a workspace with no running or starting session (R3; an idle session does not count);
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

A card that has not registered its PR as an output (common in Development) is still found through §3.2 when it is a worktree card; a directory card without a PR output is not checked.

The paseo-linked-prs workspace map is not used. Its `mentioned` list holds every PR mentioned in a workspace's chats, so it cannot name the card's own PR.

### 3.2 A PR whose head is the card's branch

This source applies only to a worktree card (the card's workspace directory is a git worktree and the card has a `baseRef`) that has no PR output. Its branch is the branch checked out in the workspace directory; a detached HEAD skips this source and §3.3. Flowly runs `gh pr list --head <branch> --state all --json number,state,url,mergedAt,headRefOid,isCrossRepository --limit 5` in that directory, as an argument array with no shell.

- If a listed PR is merged, is not cross-repository, and its `headRefOid` equals the worktree's `HEAD`, the card moves to Done. Branch names are reused (a follow-up card for the same ticket gets the same branch name), so a matching name alone does not count: the PR must carry exactly this card's head commit. If the card kept committing after its PR merged, this source does not move it.
- If none is merged, the card is not moved by this source, and §3.3 still runs. A closed PR found this way gets no R4 note, because the card never claimed it.
- If the lookup fails, Flowly goes on to §3.3.

### 3.3 The ancestor check

This source applies only to a worktree card with a `baseRef` (R6), when §3.2 found no merged PR. With `base` = `baseRef` minus `refs/heads/` (a `baseRef` that still starts with `refs/` after that, such as a tag, gets no check), all of the following must hold:

1. The workspace has no uncommitted changes (`git --no-optional-locks status --porcelain` is empty). Work that isn't committed hasn't landed.
2. The card made at least one commit of its own that `HEAD` still contains. The worktree's own `HEAD` reflog (`git reflog show --format=%H%x09%gs HEAD`) is used, because it starts when the worktree was created and so does not carry an earlier card's history on a reused branch name. At least one entry whose subject starts with `commit` (`commit:`, `commit (amend):`, `commit (merge):` and so on) must name a commit that is an ancestor of `HEAD` (`git merge-base --is-ancestor <sha> HEAD`). A worktree with no commits of its own is trivially an ancestor of its base, including after a fast-forward pull or a reset to the base, and so is one whose commits were dropped by a reset, so neither counts. A rebase rewrites those commits, so a rebased branch stays; that is a missed move, never a wrong one. With no reflog, the check is skipped and the card is left alone.
3. `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>` succeeds. The refspec is explicit, so a narrow fetch configuration still updates the tracking ref. It runs with auto-gc and maintenance off and with no prompts (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode only when neither `GIT_SSH_COMMAND` nor `core.sshCommand` is set, so a configured SSH command, for example a per-account key, is kept).
4. `git merge-base --is-ancestor HEAD origin/<base>` exits 0.

When all four hold, the card moves to Done. A non-zero exit at step 4 leaves the card unchanged. A git failure at any step also leaves it unchanged and counts as unknown.

## 4. Moving to Done

Just before writing, Flowly reads the running sessions of that card's workspace again (R3), because the check's earlier snapshot can be minutes old. Then, inside one store transaction, it reads the card again. It leaves the card alone if the card was archived, its status or revision changed since the check read it, it left the R2 lanes, moved to another workspace, or (for §3.1) its single PR changed since the check read it. Otherwise it moves the card to Done the way a person's move to Done does: the status, the revision and the `status_changed` event, with `actor: "system"` and the note "Moved to Done: PR merged (`owner/repo#n`)" or "Moved to Done: work landed on `<base>`". Everything the daemon runs after any move into Done runs here too (`afterStatus`: the project memory review, guardrails, and *Auto wrap up*, MULTITASK-SPEC). The wrap-up question is not asked: the client asks it only after its own move, so a daemon move has no client to ask it. The card's Wrap up action stays available. The card is not archived. The move's `status_changed` event (actor system, to done) is a dispatcher stop (EVENT-BUS-SPEC §2), so it reaches the card's group dispatcher as a batched note like any other status change.

The R4 note is a `note` event with `actor: "system"` on the card. Before writing one, Flowly looks through the card's activity for the same note and writes nothing if it is already there. A restart therefore never repeats it.

## 5. Setting

Settings → Workflow → Board → **Move cards to Done when their work lands**. It is stored in the same host settings record as the review-card switches (`pr-review-cards`, new field `doneOnLand`) and is on by default (R8). The loop runs when this switch or *Archive review cards when the PR closes* is on. Each switch gates only its own kind of card.

## 6. The shared loop

One check builds one list: the review-card candidates (PR-REVIEW-CARDS-SPEC §10) and the cards of §2. The list is sorted with the cards looked at least recently first, then by `updatedAt`, and at most 20 lookups run per check. Each card counts as one lookup, whatever sources §3 tries for it. The first-run delay, the 10-minute interval, joining a check that is already running, and the two "logged once" lines are unchanged. The unknown-state log line covers both kinds of card.

## 7. Compatibility

- **Integrated** keeps its meaning (INTEGRATED-STAGE-SPEC): the agent sets it once the card's commits are in the main checkout's branch. A card in Integrated whose work then reaches the remote base branch moves on to Done. The "Reconcile Flowly auto review / Ship to main with the user's Claude Code harness" card decides how Integrated fits a PR workflow. This check reads only remote state, so it works with either answer.
- Auto review never moves a card to Done (AGENTS.md). This check is a separate, user-approved path, and it only runs after the work is on the remote.

## 8. Acceptance

- With the switch on, a card in an R2 lane whose single PR output is merged moves to Done at the next check, with the note "Moved to Done: PR merged (…)". An open PR changes nothing.
- A closed PR adds one "PR closed without merging" note. A second check, or a check after a restart, adds no second note. The card stays in its lane.
- A worktree card with no PR output, no uncommitted changes, a commit of its own that `HEAD` still contains, and `HEAD` an ancestor of `origin/<base>` moves to Done with "Moved to Done: work landed on <base>". A fresh worktree with no commits of its own, a card with uncommitted changes, and a card whose head isn't on the remote base all stay.
- A worktree card whose branch is the head of a merged PR moves to Done. A merged PR on a branch of the same name whose head commit isn't the card's `HEAD`, or that comes from another repository, does not count.
- A worktree with no commits of its own stays, even after a fast-forward pull or `reset --hard` to the base, and so does one that committed and then reset to the base.
- A session that starts on the card's workspace during a check, or a change to the card's status or revision during a check, keeps the card where it is.
- A card in Design, Development, Test or Blocked whose single PR output merged, or whose worktree branch heads a merged PR or landed, moves to Done; an idle session on its workspace does not block.
- These cards stay: a card in Todo, Backlog, Done or Cancelled; a card whose workspace has a running session; a card with two distinct PR outputs; a directory card with no PR output; a card where neither source can read the state.
- With the switch off, no normal card moves, and review cards still archive (and the reverse when only the review switch is off).
- Review cards and normal cards share one check and one 20-lookup cap.

## 9. PR review cards: Done once the user approves

A PR review card (PR-REVIEW-CARDS-SPEC) is the user reviewing someone else's pull request. Its work is done when the user has approved that PR, not when the PR merges. The same check (§6) therefore also moves such a card to Done once the signed-in GitHub user's own review of the PR stands at *approved*.

### 9.1 Rulings (Noah, 2026-11-16)

- **R9: approval means Done.** An approved review card moves to Done, the same way as §4. It is not archived. The archive rule of PR-REVIEW-CARDS-SPEC §10 stays as it is for review cards still in In review, and a merged or closed PR keeps archiving them.
- **R10: no automatic reopen.** Once in Done the card stays there, even when new commits are pushed or the approval is dismissed or changed. A later review agent for the same PR still brings the card back (PR-REVIEW-CARDS-SPEC §8).
- **R11: lanes and sessions.** Only review cards in *In review* (the lane PR-REVIEW-CARDS-SPEC §10 already checks) are looked at, and a card whose workspace has a running or starting session is skipped and looked at again later, as R3.
- **R12: own PR.** When the signed-in user is the PR's author, the approval check is skipped; the card is left to the archive rule.
- **R13: setting.** The move is gated by **Move cards to Done when their work lands** (`doneOnLand`, §5); no new switch. *Archive review cards when the PR closes* still gates only the archive.

### 9.2 Which cards

A review card is in the check's list when it meets PR-REVIEW-CARDS-SPEC §10 (stored `prRef`, live, In review, no running session) and either switch is on. It costs one lookup of the shared 20 (§6), whatever sources it tries.

### 9.3 Evidence

First the PR's state is read as before (connector, then `gh pr view`). Merged or closed: the archive rule applies when its switch is on, and nothing else happens. Unknown: nothing happens and it counts as unknown. Open, with `doneOnLand` on: the user's review state is read, with the first source that can tell winning:

1. **The GitHub connector**, for a github.com PR, when a GitHub connection has a working token and a stored login (the `login` its token test read from `/user`): `GET /repos/<owner>/<repo>/pulls/<n>` for the author's login, and `GET /repos/<owner>/<repo>/pulls/<n>/reviews` (`per_page=100`) for the reviews.
2. **The GitHub CLI**: the signed-in login from `gh api user --jq .login` (with `--hostname <host>` for a non-github.com PR), kept for the rest of the plugin run once read, and `gh pr view <n> --repo <owner/repo> --json author,reviews`. Argument arrays, no shell.

From those, with logins compared without regard to case:

- the author is the signed-in user: **own**, skipped (R12);
- else, among the signed-in user's reviews whose state is `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` (a dismissed approval is shown by GitHub as `DISMISSED`), the latest by submission time (equal times: later in the list) decides. `APPROVED` means **approved**. `COMMENTED` and `PENDING` reviews are ignored, as GitHub keeps an approval through later comments;
- no such review: **not approved**, nothing happens;
- neither source can tell: unknown.

Any `APPROVED` review submitted under the signed-in account counts, including one an agent posted through the user's own `gh` login.

### 9.4 Moving to Done

As §4: the running sessions of that card's workspace are read again just before writing, and in one store transaction the card is read again. It is left alone if it was archived, its status or revision changed, it left In review, moved to another workspace, stopped being a review card or its `prRef` changed. Otherwise status, revision and a `status_changed` event with `actor: "system"` and the note "Moved to Done: PR approved (`owner/repo#n`)", then the same follow-up as any move into Done (`afterDone`). The card is not archived and the PR's later merge does not archive it (only In review cards are archived).

### 9.5 Acceptance

- With `doneOnLand` on, a review card in In review whose open PR's latest decisive review by the signed-in user is `APPROVED` moves to Done at the next check with "Moved to Done: PR approved (…)".
- It stays when that latest decisive review is `CHANGES_REQUESTED` or `DISMISSED`, when the user has no decisive review (only comments), when the user is the PR's author, when the card is in another lane or its workspace has a running session, or when neither source can read the reviews.
- A merged or closed PR still archives the card (with the archive switch on) and is never also moved to Done.
- With `doneOnLand` off nothing moves to Done; with only `doneOnLand` on, review cards are still looked at for approval but none is archived.
- A card in Done is not looked at again, so a dismissed approval or new commits never reopen it.
- Review cards and ordinary cards still share one check and one 20-lookup cap.
