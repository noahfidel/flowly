# Delivery mode

How a card's work is handed over: left on its branch for the user to review, or pushed as a draft or ready PR by the card's own session. Contract only; progress is in `docs/PROGRESS.md`.

## 1. Modes

| Value | Label | What the card's session is told |
|---|---|---|
| `branch` (default) | Branch, I bless | Commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch. |
| `draft_pr` | Draft PR | Push the card's branch and open a draft PR; register its URL as an output. |
| `ready_pr` | Ready PR | Push the card's branch and open a PR ready for review; register its URL as an output. |
| `ship_main` | Ship to main | After the checks pass and the review has no open findings: rebase the branch onto the latest main, rerun the checks, `flowly_integrate`, then `git push origin main`. |

`deliveryModes = ["branch", "draft_pr", "ready_pr", "ship_main"]`. Labels are translated (`msg()`); the agent-facing lines are English.

## 2. Where the mode lives

- **Default:** Settings → Workflow → Delivery mode (`deliverySettings`, host scope, `defaultMode`, default `branch`). Unreadable settings keep `branch`.
- **Per card:** `Task.deliveryMode?` (a string; absent on every older card). New task has a "Delivery" choice seeded from the default and sends the shown value as `taskInput.deliveryMode`. Quick task and agent-created cards send none.
- **Effective mode** = the card's stored mode when it is one of the three, otherwise the host default at the moment the context is built. A card with no stored mode therefore follows later changes of the default.
- An unknown stored value (written by a newer version) is kept as it is and treated as the default. It is never rewritten or dropped.
- **Editable until delivery** (rulings 2026-11-08 and 2026-11-09): the mode is chosen when the card is created and can be changed in Edit (`taskEdit.deliveryMode`, one of the three) until the card has delivered (`deliveryModeLocked`). A card has delivered once it has been In review, Committed or Integrated at any point: the store sets `Task.deliveredAt` (a timestamp) in the write that first puts the card in one of those lanes, whoever makes it (a drag, Edit, a status rule, an agent tool). It is never cleared, except by a board restore (a backup from before delivery rolls the mark back). A card stored without `deliveredAt` counts as delivered while it is in one of those lanes (no migration). Edit shows the card's effective mode and sends it only when the user changed it there, so a card with no stored mode keeps following the default until then. Once the card has delivered, Edit shows the mode read-only and the daemon refuses a different value ("The delivery mode can't be changed once the card has been in review, committed or integrated."); sending the stored value again is no change. The check reads the card before the edit. Moved back out of those lanes, the mode stays fixed.

## 3. Context line

`sessionContext` adds one line for the effective mode as the last line, for the first instructions and every context read (`flowly_get_task`'s `deliveryMode` carries the same effective value).

- branch: `Delivery: commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch.`
- draft_pr: `Delivery: push the card's branch and open a draft PR; register its URL as an output. Pushing and opening the PR still go through the user's permission prompt, which the user answers. Leave the PR a draft; never mark it ready.`
- ready_pr: `Delivery: push the card's branch and open a PR ready for review; register its URL as an output. Pushing and opening the PR still go through the user's permission prompt, which the user answers. Never mark a PR ready while review notes are open.`
- ship_main: `Delivery: ship to main only after the card's checks pass and its review has no open findings. Rebase the card's branch onto the latest main (fetch first), rerun the checks, call flowly_integrate, then git push origin main. Never force-push and never push any other branch. Pushing still goes through the user's permission prompt, which the user answers. Stop and report, leaving the card In review, when the rebase conflicts, checks fail after the rebase, flowly_integrate refuses, or a review finding is open; if the push is rejected, set integrated and report it. Do not update the installed plugin.`

## 4. Boundaries

- **Ship to main** (ruling, Noah, 2026-11-10): the ship step runs only on a card whose effective mode is `ship_main`, after the Auto review (AUTO-REVIEW-SPEC) has passed for the delivery. A pass sends the card's session a marked ship message, which starts the ship turn. Without Auto review on, the card is not shipped: it stays In review and the reason is reported. The card must be a worktree card (`flowly_integrate` refuses `NOT_WORKTREE` otherwise). The steps: `git fetch`; stop if the main checkout's branch is not at `origin/main` (never fast-forward or reset the main checkout); rebase the card's branch onto `origin/main`; rerun the checks; `flowly_integrate`; `git push origin main` from the main checkout. The push is an explicit `git push origin main`: no force, no `+` refspec, never another branch; it goes through the user's `ask` rule like Draft and Ready PR. The review applies to the head before the rebase; the rerun checks gate the rebased head.
- **Stop states:** rebase conflict, failed checks after the rebase, a refused `flowly_integrate`, main behind origin, or an open finding leave the card In review with a `kind=blocker` report. A rejected push, after a successful integrate, sets Integrated (the commits are in the main checkout's branch) and reports the push failure. Ship to main does not move a card to Blocked: these stops are fixable.

- Flowly itself never pushes, opens a PR or marks one ready. The card's session does, with its own tools.
- Delivery mode never bypasses the user's permission rules for `git push` and `gh pr create`. In Draft PR and Ready PR the session still asks, and the user answers the prompt.
- Ready PR never opens a PR as ready, and never marks one ready later, while review notes are open. Draft PR leaves the PR a draft.
- **The mode is the user's standing ask** (ruling 2026-11-08): `branch` commits at delivery; `draft_pr` and `ready_pr` commit, push and open the PR at delivery. Anything beyond that, such as merging, happens only when the user asks. "Delivered and committed" for a card therefore means committed in `branch`, and committed, pushed with the PR opened in `draft_pr` and `ready_pr`; the agent's example next moves and the Done move follow this and never assume a push.
- `DELIVERY-CONSTRAINTS-SPEC` (outputs and `acknowledgeOpen`) is unchanged: the PR URL is registered through `outputs` of the delivery call.
- No heartbeat field (`docs/TELEMETRY-SPEC.md` §4).

## 5. Errors and data

- `taskInput.deliveryMode` and `taskEdit.deliveryMode` accept only the three values; anything else is refused with the usual input error. The stored field is a plain string with no length limit, so that a value this version does not know still loads; an edit that does not change the mode keeps it as it is.
- `get_task` returns `deliveryMode` (effective, always one of the three).

## 6. Acceptance

- The context of a card names its mode's line; each of the three lines appears for its mode.
- A card with no mode uses the default; changing the default changes the line.
- A stored unknown value is preserved in the board and treated as the default.
- `get_task` returns `deliveryMode`.
- Edit changes the mode before delivery; once the card has been In review, Committed or Integrated the form shows it read-only and the daemon refuses a change, also after the card moves back to an earlier lane.
- The draft and ready lines carry the permission and review-notes rules.
- Ship to main: the pass sends the ship message only for a `ship_main` card; a failed or unavailable review sends nothing; the stop states above; the mode is listed in `get_task`'s `deliveryMode` enum and in every catalog.

## 7. Rulings

- Ruling: Noah, 2026-11-10. Ship to main (`ship_main`) is a fourth mode. It is available per card and as a default, and as a group default for the Tooling group. Updating the installed Paseo plugin is not part of the mode.
