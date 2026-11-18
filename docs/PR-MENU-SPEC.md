# Pull requests menu

Status: implemented 2026-11-18 (card "PR menu: a clear list of PRs across cards"; D1–D8 built, D9–D10 open). Decisions D1–D8 below were taken on the card as small and reversible.

Today a pull request shows only as a chip in its card's Quick links (DRAWER-SPEC "Quick links"), as the drawer's *Open PR* button on a PR review card (PR-REVIEW-CARDS-SPEC §5), and through the `R` shortcut on an open card (SHORTCUTS-SPEC). Nothing lists the PRs of many cards at once. This menu does: which PRs are open, which are merged or closed, and which card owns each, without opening cards one by one.

Vocabulary is the Quick links': a card's **PR** is an output artifact that is a pull or merge request (`prNumberOf` in `client/quick-links.ts`: a connector ref of item type pull / merge_request, else a github.com `…/pull/<n>` or gitlab.com `…/-/merge_requests/<n>` URL). A **PR review card** is a card with a stored `prRef` (`owner/repo#n`, PR-REVIEW-CARDS-SPEC §4); its PR is someone else's that the card reviews. The paseo-linked-prs workspace map is not used, for the reason in LANDED-DONE-SPEC §3.1 (it holds every PR mentioned in a chat, not the card's own).

## 1. Decisions

- **D1: scope = what the board shows.** The menu lists the PRs of the cards in the projects the board shows now: the current project, or every project of the current board group when the board shows the group. Switching project or group changes the list. Not a board filter (a filter hides cards; this is a list of PRs, several per card) and not every project of every group.
- **D2: which cards.** Live (not archived) cards in every lane except Done and Cancelled (an exclusion, so new lanes are covered). Done cards are left out because their PRs are merged history and would make the list grow forever.
- **D3: where.** An *N PRs* chip in the board's overview bar (the row with *N running*, Ideas, Insights), opening a list in the same `Modal` the *Running now* list uses. Shown only when N > 0. No toolbar button and no sidebar entry.
- **D4: row press opens the card**, as a *Running now* row does (`openTaskById`). A separate *Open pull request* button at the end of the row opens the PR in the browser through `openQuickLink` (the Quick links chip's action, with its error toast). Both close the menu.
- **D5: grouping and order.** Three sections, each shown only when it has rows: **Open** (state Open, Draft or not known), **Reviewing** (PR review cards), **Merged or closed**. Within a section: the card's lane in board lane order, furthest along first (Integrated, Committed, In review, Test, Development, Design, Blocked, Todo), then newest PR first. So PRs waiting in *In review* sit near the top of Open.
- **D6: "waits on review" is the card's lane.** Flowly reads no review decision today (§4), so a row shows its card's lane name; *In review* answers "which wait on review" for the user's own PRs. The Reviewing section answers it for PRs the user reviews.
- **D7: no shortcut.** `R` is taken (the open card's newest PR); free keys exist (SHORTCUTS-SPEC) but a new key is left until the menu proves useful.
- **D8: data on open only.** No new timer and no new interval: the list is fetched when the menu opens (§3).

## 2. The menu

1. **Chip.** In the overview bar after *N running* and the need-you chips: a `GitPullRequest` icon and *{n} PRs* (`tn`: *1 PR* / *{n} PRs*), where n is the number of distinct PRs (§3.1) on the cards of D1/D2, merged and closed included. Hidden when n is 0. Accessibility label *Show pull requests* (`tn` with the count: *Show 1 pull request* / *Show {n} pull requests*). Pressing it opens the menu.
2. **Title.** *Pull requests*.
3. **Row.**
   - Title: `#n` (GitHub) or `!n` (GitLab), then the artifact title when it is set and is not just the number; a PR review card's row uses the card title. A title that is the PR's URL counts as not set, and a leading repeat of the number (`#42`, `PR #42`, `#42:`) is dropped, so the number never shows twice.
   - Detail (one line, wraps on phones): `owner/repo` when known · card title · lane name; with more than one project shown, the project title first. A PR review card's row omits the card title (it is the row title).
   - Trailing: the state word *Draft*, *Open*, *Merged* or *Closed* when known (nothing when not known), coloured as the Quick links chip colours them (open: running colour, merged: success colour, others muted); then an icon button `ArrowUpRight` labelled *Open pull request*.
   - The row's accessibility label: *Open card {card}: pull request {number} · {state}*.
4. **Several PRs on one card** give one row each. The same PR URL on two cards gives two rows (each card owns its link).
5. **Empty and errors.** The chip is hidden when there are no PRs, so the menu normally opens with rows. When the fetch finds none (the last PR was removed meanwhile) it shows *No pull requests on this board*. While loading: the shared loading row. A failed fetch shows *Could not load pull requests.* with a *Retry* button; the board is unaffected. A failing connector read is not a failed fetch: the rows still list, with no state word (logged on the daemon).
6. **Compact and phones.** The chip sits in the overview bar on every width (the bar scrolls sideways). `Modal` is full width on compact. The *Open pull request* button is 36 pt on touch, as the Quick links chips are; the row press target stays the rest of the row. The detail line wraps to up to three lines on touch and truncates at one on the web. No double tap (project memory: touch gestures).

## 3. Data

### 3.1 Which PRs

Computed on the daemon from the stored board (artifacts are not in the board overview):

- For each card of D1/D2: every output artifact (not a plan) that `prNumberOf` recognises, one per URL per card, plus, for a PR review card, its `prRef` (URL from `prReviewCardUrl`) unless one of its outputs already names the same PR.
- `repo`: from the connector key or the URL (`owner/repo`, or the GitLab path); empty when it cannot be read.
- The chip's count comes from the board overview: each card's facts gain `prs` (the number of PR rows that card contributes, by the rule above). The overview is already read every 3 s through its etag read; the new field adds no request.

### 3.2 State and freshness

- RPC `prs.list { projectIds: string[] }` → `{ rows: [{ taskId, projectId, artifactId?, kind: "pr" | "review", url, number, repo, title, createdAt, state: "draft" | "open" | "merged" | "closed" | "" }] }`. Unknown or archived projects are skipped; at most 20 project ids. The client sends the first 20 of the projects shown (a group of more than 20 live projects lists only those; the chip still counts all).
- State comes from the connector badge cache (`connectors.badges`, cached up to 30 minutes, then fetched once per connection in one batch), as the Artifacts section and Quick links already use it:
  - a connector-linked artifact: its own ref (`connectors.locate`);
  - a plain github.com URL or a `prRef`: the ref the PR-review archive check builds (`connectorPrState`'s rule: the user's working github.com GitHub connection, key `owner/repo#n`);
  - anything else (no connection, GitLab plain URL, self-hosted host): state "", shown as no word.
  - A stale cache entry (service unreachable) still gives its word; it is the last known one.
- The client query (`["flowly", "prs", ...projectIds]`) runs only while the menu is open: fetched on open, `staleTime` 60 s, no `refetchInterval`, no `refetchOnWindowFocus`. Reopening within a minute reuses the result. No `gh` calls: the list never shells out.
- The open list keeps its rows while the overview changes underneath (as *Running now* does); a press on a row whose card has gone shows the existing *This card no longer exists.* toast.

## 4. Not in this version

- **Review decision** (approved, changes requested, review requested). The connector summary has no such field; GitHub's `reviewDecision` needs a new connector read per PR. See D9.
- Checks/CI state, authors, the PR's own title when the artifact title is empty (would need the connector's full item).
- Filtering, search or sorting controls inside the menu.

## 5. Open decisions

- **D9: review status.** Options: (a) leave it to the card's lane (D6; built); (b) add GitHub's review decision to the connector summary and show *Approved* / *Changes requested* / *Review requested* on open rows, at one extra GraphQL field per batch. Recommendation: (b) as a follow-up card once the menu is in use; it changes the connector contract, so it is not done here.
- **D10: a keyboard shortcut** to open the menu. Recommendation: none until asked for (D7); `W` or `X` are free if wanted.

## 6. Onboarding, What's new, telemetry

- One-time tip `pr-menu` ("Every pull request on this board, and the card that owns it, is one click away under N PRs."), shown when the chip is visible (a project board, or a desktop group board, which shows the group tips); discovery priority (after `card-double-click`). Opening the menu records it as seen. Tip table in ONBOARDING-SPEC updated; `client/onboarding-logic.test.ts` covers the rule.
- Welcome tour: one line in the More features list on the last page (*Pull requests*: "Every PR on the board in one list, under N PRs above the board; each row opens its card or the PR."; icon `GitMerge`, because the list is keyed by icon and Delivery mode already has `GitPullRequest`).
- What's new: none here (not a release; the chip is on the board itself, so existing users run into it).
- Telemetry: no heartbeat field.
- Every new string in all catalogs in `shared/i18n/`.

## 7. Tests

- Shared/daemon: the PR rows rule (outputs only, plans skipped, one per URL per card, GitHub and GitLab numbers, `prRef` rows and their dedupe against outputs, archived cards and Done/Cancelled lanes excluded, other lanes included, projects filter) and the overview `prs` count matching it.
- Server: `prs.list` states from a fake connector service (connector ref, plain github URL through the GitHub connection, no connection → "", stale entry keeps its word), unknown project ids skipped.
- Client (pure): section and order rule (lane order, newest first, unknown state in Open), row text (title without a duplicated number, detail with and without the project title).
- Real UI: desktop and compact board with a fixture project carrying a PR output and a PR review card; chip count, list sections, row → card, *Open pull request* → browser.
