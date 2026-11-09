# Delivery mode

How a card's work is handed over: left on its branch for the user to review, or pushed as a draft or ready PR by the card's own session. Contract only; progress is in `docs/PROGRESS.md`.

## 1. Modes

| Value | Label | What the card's session is told |
|---|---|---|
| `branch` (default) | Branch, I bless | Commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch. |
| `draft_pr` | Draft PR | Push the card's branch and open a draft PR; register its URL as an output. |
| `ready_pr` | Ready PR | Push the card's branch and open a PR ready for review; register its URL as an output. |

`deliveryModes = ["branch", "draft_pr", "ready_pr"]`. Labels are translated (`msg()`); the agent-facing lines are English.

## 2. Where the mode lives

- **Default:** Settings → Workflow → Delivery mode (`deliverySettings`, host scope, `defaultMode`, default `branch`). Unreadable settings keep `branch`.
- **Per card:** `Task.deliveryMode?` (a string; absent on every older card). New task has a "Delivery" choice seeded from the default and sends the shown value as `taskInput.deliveryMode`. Quick task and agent-created cards send none.
- **Effective mode** = the card's stored mode when it is one of the three, otherwise the host default at the moment the context is built. A card with no stored mode therefore follows later changes of the default.
- An unknown stored value (written by a newer version) is kept as it is and treated as the default. It is never rewritten or dropped.
- The mode is chosen when the card is created. Card edits (`taskEdit`) do not change it.

## 3. Context line

`sessionContext` adds one line for the effective mode as the last line, for the first instructions and every context read (`flowly_get_task`'s `deliveryMode` carries the same effective value).

- branch: `Delivery: commit on the card's branch; do not push or open a PR. The user reviews ("blesses") the branch.`
- draft_pr: `Delivery: push the card's branch and open a draft PR; register its URL as an output. Pushing and opening the PR still go through the user's permission prompt, which the user answers. Leave the PR a draft; never mark it ready.`
- ready_pr: `Delivery: push the card's branch and open a PR ready for review; register its URL as an output. Pushing and opening the PR still go through the user's permission prompt, which the user answers. Never mark a PR ready while review notes are open.`

## 4. Boundaries

- Flowly itself never pushes, opens a PR or marks one ready. The card's session does, with its own tools.
- Delivery mode never bypasses the user's permission rules for `git push` and `gh pr create`. In Draft PR and Ready PR the session still asks, and the user answers the prompt.
- Ready PR never marks a PR ready while review notes are open.
- `DELIVERY-CONSTRAINTS-SPEC` (outputs and `acknowledgeOpen`) is unchanged: the PR URL is registered through `outputs` of the delivery call.
- No heartbeat field (`docs/TELEMETRY-SPEC.md` §4).

## 5. Errors and data

- `taskInput.deliveryMode` accepts only the three values; anything else is refused with the usual input error. The stored field is a plain string (max 40 characters) so that a value this version does not know still loads.
- `get_task` returns `deliveryMode` (effective, always one of the three).

## 6. Acceptance

- The context of a card names its mode's line; each of the three lines appears for its mode.
- A card with no mode uses the default; changing the default changes the line.
- A stored unknown value is preserved in the board and treated as the default.
- `get_task` returns `deliveryMode`.
- The draft and ready lines carry the permission and review-notes rules.
