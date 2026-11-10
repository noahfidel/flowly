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
- Description: `PR: [<label value>](<GitHub pull request URL>)` when the value is `owner/repo#n`, so the PR is a link in the card's description; any other value stays `PR: <label value>`. Then `Created automatically from a PR review agent.` Cards made before this wrote `PR: <label value> (<URL>)`; they are still recognized (§8).
- Lane: *In review*; when the project has that lane turned off, *To do*; when that is off too, the project's first lane that is not Done or Cancelled.
- Tag: `pr-review`. Priority normal. The activity and tag are attributed to the review agent.
- Its session is the review agent (the session in the card's workspace), so opening the card opens the review chat.

Flowly never moves the card by itself because of this feature, except when a later review reuses it (§8) or archives it once its PR closes (§10): when the review ends, the card stays where it is until the user moves or closes it. (Auto-status rules apply only to sessions Flowly manages; the review agent is not one.)

## 5. Linear ticket

A PR review card is never asked for a Linear ticket, even in a project with *Make sure there's a Linear ticket* on: the card's session context leaves the Linear ticket block out. A card is recognized by its `pr-review:` operation id, which never changes.

## 6. Setting

Settings → Workflow → Board → **Make cards for PR review agents**, host scope (`pr-review-cards`, `prReviewCards`), on by default. Off: Flowly does not read agents for this and makes no card. Turning it on does not backfill (§3).

Settings → Workflow → Board → **Archive review cards when the PR closes**, same settings record (`archiveOnClose`), on by default. Off: the check of §10 does nothing.

## 8. A new review of the same PR reuses its card

When an agent that passes §3 has a label of the form `<owner>/<repo>#<n>` and the chosen project already has an unarchived PR review card (operation id `pr-review:…`) for the same owner, repo and number (the card stores it as `prRef`, `owner/repo#n` in lower case; owner and repo match without regard to case. A card without `prRef` falls back to a whole `PR: <label>` line of its description, searched line by line, with nothing else on the line but the GitHub link, either `[label](url)` or `label (url)`, or no link at all), no new card is made. The newest such card (by creation time) is reused:

- Rebound to the new agent's workspace, as the *Existing workspace* path binds a card (the card does not own it). A card has one current workspace, so the earlier one moves to the card's read-only workspace history (`previousWorkspaces`, same as a workspace switch, newest 10 kept) and is not archived. Its sessions stay in that history; the card opens the new review chat.
- Moved to the lane of §4 (In review, else To do, else the first open lane) when it is elsewhere, including Done or Cancelled. This is the one exception to "never moved by itself": a new review means the card needs looking at again.
- Retitled from the new agent's title (§4) when it differs; the description is kept.
- The card's operation id and tag stay. The activity (workspace switched, status changed, edited) is attributed to the new agent.
- A re-run for an agent whose workspace the card already holds, or held as history, makes nothing. History blocks only for a PR review card of the same PR; an ordinary card's history, or a card of another PR, never blocks. Every skip because a card exists is logged.
- Agents for the same project and PR are handled one at a time, so two arriving together make one card.
- The history entry records the old workspace's real kind and directory.
- A card that owns its workspace (`ownsWorkspace`) or has a workspace switch is not reused: a new card is made and a line is logged.
- Archived cards are never reused; a new card is made. A label without `owner/repo#n` is never matched: one card per agent as in §3. Cards in other projects are never reused.

The outcome is `reused` (with the card) instead of `created`.

## 9. Open PR button

The card drawer's header shows an **Open PR** button (icon `GitPullRequest`) on a PR review card (§5) whose PR can be named: the stored `prRef`, else the `PR:` line of the description (§8). It opens `https://github.com/<owner>/<repo>/pull/<n>` in the browser; a failure shows the toast "Could not open the link." The URL in the description (original case) is used when it names the same PR; otherwise it is built from the key, which is lower case (GitHub ignores case). A loose label, or any other card, has no button.

## 10. Archive when the PR closes

With *Archive review cards when the PR closes* on (§6), Flowly checks about a minute after the plugin starts, then every 10 minutes. A check looks at each card that is all of:

- a PR review card (operation id `pr-review:…`) with a stored `prRef` (`owner/repo#n`); a card that only has the `PR:` line of an older description is left alone;
- not archived, in a live project, and in *In review* (a card the user moved to any other lane is left alone);
- in a workspace with no running or starting session.

It reads the PR's state: through the user's GitHub connector for github.com when one has a working token (CONNECTORS-SPEC), else with the GitHub CLI, `gh pr view <n> --repo <owner/repo> --json state,mergedAt` (an argument array, no shell). One check makes at most 20 lookups; cards looked at least recently go first, so a longer list is covered over the following checks. When neither source can tell (no token, `gh` missing or not signed in, PR not found, offline), nothing changes and one line is logged, again only after a check in which some lookup worked.

A merged or closed PR archives the card as the board's Archive does (`archivedAt`, revision, event `archive_changed`), with the activity note "Archived: PR merged" or "Archived: PR closed", attributed to Flowly (`system`). The card is checked again in the same write and left alone if it was archived, moved out of In review, or rebound to another workspace or PR meanwhile. An open PR changes nothing. Only the card is archived: its workspace and sessions are kept, because a PR review card never owns its workspace (§3). A later review of the same PR makes a new card, since archived cards are never reused (§8). The user can unarchive the card as any other.

## 7. Acceptance

- A new agent labelled `pr-review-watch=Zenlytic/zenlytic#9164` in a worktree of a project's repository gets one card in In review, tagged `pr-review`, bound to that workspace; opening it shows the review chat.
- A second hook, a second agent in the same workspace, or a plugin reload makes no second card.
- An agent in a folder outside every project makes no card and at most one log line per run.
- Setting off: no card.
- Archived agents, agents without the label and agents created more than 30 minutes earlier: no card.
- A project with the Linear ticket requirement on: the PR review card's context has no Linear block; other cards still do.
- A second review agent for the same PR in a new workspace: no second card; the card is bound to the new workspace, the old one is in its history, it is in In review and has the new title. A re-run of the first agent changes nothing. An archived card is not reused.
- A PR review card for `owner/repo#n` shows Open PR in the drawer header, opening that pull request; a loose-label card and an ordinary card show none. The description's PR line is a markdown link.
- Setting on: a PR review card in In review whose PR is merged is archived at the next check with the activity "Archived: PR merged" (closed: "Archived: PR closed"); an open PR, a card in another lane, a card without `prRef` and a card whose workspace has a running session stay. Setting off, or no way to read the PR: nothing is archived, and the failure is logged once.
