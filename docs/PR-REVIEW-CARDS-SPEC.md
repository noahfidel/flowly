# PR review cards

A pull request review run by an outside job (for example a scheduled `paseo run`) shows up on the board as a card, so the review can be opened, read and closed like any other piece of work.

## 1. Trigger

An agent whose labels include the key `pr-review-watch` is a PR review agent. Its value names the pull request, normally `<owner>/<repo>#<n>` (for example `Zenlytic/zenlytic#9164`).

Flowly looks at an agent when Paseo reports it created (`agent.created`) and, for an agent created while the plugin was reloading, at its first turn start (`agent.turn_started`). The hook events carry no labels, so Flowly reads the agent record once per plugin run.

## 2. Project

The card goes to the live Flowly project whose repository holds the agent's workspace directory (the same repository match the New card *Existing workspace* mode uses, so a worktree of the repository counts). When several projects match, the one linked to the workspace's Paseo project wins, then the deepest root. When none matches (for example a fallback workspace in a scratch folder), no card is made; Flowly logs this once per plugin run and nothing else.

## 3. When a card is made

All must hold:

- *Make cards for PR review agents* is on (§6).
- The label value is not empty.
- The agent has a workspace, is not archived, and was created at most 30 minutes ago. Older agents are never backfilled, so a first start or a reload does not flood the board with past reviews.
- No card is bound to that workspace yet, and no card has this agent's operation id.

The card is created through the New card path in *existing workspace* mode: no workspace is created, the existing-workspace checks apply (inside the project's repository, not bound to another card), and the card does not own the workspace. Its operation id is `pr-review:<agent id>`, so a retry, a second hook or a reload never makes a second card.

## 4. The card

- Title: the agent's title (for example `PR review: Zenlytic/zenlytic#9164 Fix the thing`), else `PR review: <label value>`; at most 200 characters.
- Description: `PR: <label value>` with the GitHub pull request URL when the value is `owner/repo#n`, then `Created automatically from a PR review agent.`
- Lane: *In review*; when the project has that lane turned off, *To do*; when that is off too, the project's first lane that is not Done or Cancelled.
- Tag: `pr-review`. Priority normal. The activity and tag are attributed to the review agent.
- Its session is the review agent (the session in the card's workspace), so opening the card opens the review chat.

Flowly never moves the card by itself because of this feature: when the review ends, the card stays where it is until the user moves or closes it. (Auto-status rules apply only to sessions Flowly manages; the review agent is not one.)

## 5. Linear ticket

A PR review card is never asked for a Linear ticket, even in a project with *Make sure there's a Linear ticket* on: the card's session context leaves the Linear ticket block out. A card is recognized by its `pr-review:` operation id, which never changes.

## 6. Setting

Settings → Workflow → Board → **Make cards for PR review agents**, host scope (`pr-review-cards`, `prReviewCards`), on by default. Off: Flowly does not read agents for this and makes no card. Turning it on does not backfill (§3).

## 7. Acceptance

- A new agent labelled `pr-review-watch=Zenlytic/zenlytic#9164` in a worktree of a project's repository gets one card in In review, tagged `pr-review`, bound to that workspace; opening it shows the review chat.
- A second hook, a second agent in the same workspace, or a plugin reload makes no second card.
- An agent in a folder outside every project makes no card and at most one log line per run.
- Setting off: no card.
- Archived agents, agents without the label and agents created more than 30 minutes earlier: no card.
- A project with the Linear ticket requirement on: the PR review card's context has no Linear block; other cards still do.
