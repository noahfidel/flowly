# A card's Linear link on the card tools (LINEAR-LINK-SPEC)

Status: requested 2026-11-12 (Noah, via the Flowly bot). Contract only; progress is in `docs/PROGRESS.md`.

A card's Linear issue is already a Linear **input** artifact (`external = { provider: "linear", connectionId, key, itemType: "issue" }`, CONNECTORS-SPEC §3). `flowly_start_card` names the worktree branch from it (START-CARD-SPEC §6) and *Make sure there's a Linear ticket* counts it (LINEAR-TICKET-SPEC §2). Only a card's own session could write it (`flowly_add_artifact`), so the dispatcher and board sessions could neither set nor show it. This gives them the same tools the plan has (CARD-PLAN-SPEC §5.2), over the same record.

## 1. Data

No new field. The Linear input artifact is the single source. `shared/linear-ticket.ts` `linearIssuesOf` / `linearIssueOf` name it once for the branch, the card tools and the ticket check: the card's **first** Linear issue input is its issue. A further Linear input stays a plain reference (it never names a branch and is not shown as `linear`). `links` (blocks, follow_up) stay card-to-card; Linear is never put in them.

## 2. Reading the issue

A key (`ZEN-9132`) or a linear.app issue URL is read through a configured Linear connection (`ConnectorService.recognizeLinear`): only Linear connections are considered, so a bare key is never taken for a Jira key. The issue must exist and be visible. Nothing is ever saved as text.

| Code | When |
|---|---|
| `LINEAR_INVALID` | no Linear connection, the text is not an issue key or link, or Linear can't see it (not found, no access) |
| `LINEAR_UNAVAILABLE` | Linear can't be reached right now (retryable), or this process has no connectors |
| `LINEAR_ALREADY_SET` | `flowly_set_linear` over a different issue the user linked |
| `LINEAR_REFUSED` | the artifact rules refused it (artifact limit; the issue is on the card as the user's output) |

## 3. Tools

Same callers as the plan tools (card sessions, board sessions, the dispatcher with `projectId`), the *Agents create and edit cards* switch, and the card's project scope (`CARD_NOT_FOUND`, `ARCHIVED`, `AGENT_CARDS_DISABLED`).

- `flowly_create_card` takes optional `linear` (key or URL). It is read **before** anything is made: a refusal creates no card, no workspace and takes no hourly slot. After the card exists the input artifact is written (`createdBy: "agent"`); a failure then is logged and the card stays, as for `plan`. A replay returns the card without a second link.
- `flowly_set_linear { taskId, issue }` (dispatcher: plus `projectId`) → `{ linear }`. Writes the input artifact (`artifact_added`). The same issue again changes nothing. A different issue an agent linked earlier is removed first (`artifact_removed`), so the card keeps one. A different issue the user linked is kept and refuses the call (`LINEAR_ALREADY_SET`): agents never change what a person added.
- `flowly_clear_linear { taskId }` → `{ cleared, notice? }`. Removes the Linear issue inputs agents added; one the user added stays (`cleared: false` and a `notice` when nothing else was removed).
- `flowly_update_card` is unchanged (the plan isn't on it either). `flowly_start_card` is unchanged.
- The tools change no task revision. The dispatcher's tool list (§ DISPATCHER-SPEC 5) gains both; a running dispatcher keeps its old tool set until Replace dispatcher.

## 4. Showing it

`flowly_get_card` and `flowly_create_card` return `linear: { key, url, title, state } | null`; `flowly_list_cards` returns it on a card that has one. `title` and `state` are Linear's last known summary and status (`""` when never read). `flowly_list_cards` `query` also matches the Linear key, case-insensitively. No request is made to show it.

## 5. Branch naming

The branch is chosen when `flowly_start_card` makes the card's worktree. A card created with `linear` before it starts gets the Linear branch name. Linking **after** the card started changes nothing about its workspace or branch; the link applies to a worktree made later (a Start again after a switch). No tool renames a branch.

## 6. Not in scope

A migration (cards that already have the input need none). A backfill that links cards whose description or branch name holds exactly one readable key (dry run first, never renaming branches) is a separate, low-priority card. No CLI command; no writes to Linear.

## 7. Acceptance

- A card is created with `linear`, linked and cleared afterwards, and get/list show it; list finds it by key.
- An unreadable key is refused with nothing created or saved.
- A card created with `linear` before start gets the Linear branch name; linking after start renames nothing.
- Clear leaves a user-added link; set doesn't replace it.
- The ticket check counts a link these tools made (same artifact).
