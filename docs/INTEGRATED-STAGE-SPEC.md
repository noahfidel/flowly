# Integrated stage

Status: requested by the user on card "integrated stage" (2026-10-29): "a new stage after committed named integrated; when the commits were pushed to the main checkout this stage should be set". Implemented on top of the Committed stage ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md)).

User decisions (2026-10-29):
1. Build on top of Committed and implement after it lands; no parallel edits to the same status, lane and migration code.
2. The agent sets Integrated (`flowly_update_status`). The daemon does not detect it from git.
3. "Main checkout" means the local main branch of the project root checkout. Pushing to a remote is neither required nor implied.

## 1. Status

A new built-in status `integrated`, default name **Integrated**, placed right after Committed:

```
backlog → todo → design → development → test → in_review → committed → integrated → blocked → done → cancelled
```

- Meaning: every commit this card made is in the **main checkout**: the branch checked out in the repository's own directory under the project root (not a worktree), normally `main`. A card that worked in a worktree is integrated once its branch was merged, rebased, squashed or fast-forwarded into that branch; a card that committed directly on that branch in the main checkout is integrated with the commit. For a project root holding several repositories, this holds for every repository the card changed.
- It says nothing about a remote. The note of the move says whether it was pushed.
- It is not a work stage (`workStatuses` unchanged) and not finished (Done/Cancelled stay the only finished statuses; wrap-up, the finished-card filters and summaries are unchanged).
- `deliveryStatuses` (COMMITTED-STAGE-SPEC §1) gains it: `["in_review", "committed", "integrated"]`. Everything that uses `isDeliveryStatus` covers Integrated without its own case.
- Icon `GitMerge` (lucide, shipped by the host, WORKFLOW-STAGES-SPEC §5), colour `statusSuccess`, the pair of Committed's `GitCommitHorizontal`. Lane editor, board columns, phone status sheet, card status menu and the compact "first lane with cards" logic take it from `statuses`.
- No Overview bar chip.

## 2. Stored lane configurations

No code of its own: `completeLanes` (COMMITTED-STAGE-SPEC §2) inserts each missing status right after the nearest status that precedes it in the default order. A stored 9-lane configuration gets Committed after In review and Integrated after Committed; a 10-lane configuration (written after Committed landed) gets Integrated after Committed. Inserted lanes are `enabled: true`, without a custom name. No board version bump; the project row is rewritten with 11 lanes at its next write.

## 3. Agents

- `agentStatuses` gains `integrated`; `allowedStatuses` lists it only when its lane is on, else `STATUS_UNAVAILABLE`. CLI: `status integrated`, with `--outputs`/`--no-outputs`, `--moves`/`--no-moves` and `--acknowledge-open` like `status committed`.
- A move into Integrated is a delivery, same as Committed: `outputs`, `moveTo:"done"` (NEXT-MOVES-SPEC §8.2: "with a delivery to In review, Committed or Integrated"), the delivery reminders, and the soft delivery gate when the status changes. The workpad's delivery snapshot and the "Delivered with n open items" mark follow the latest move into any delivery status.
- Guidance (skill, `SKILL.md`, turn checklist, tool description):
  - Set `integrated` only after **all** of this card's commits are in the main checkout's branch. Check it in the main checkout, e.g. `git -C <repo> merge-base --is-ancestor <card's last commit> HEAD`; after a squash or rebase, confirm by content.
  - Agents integrate only on the user's request, like committing.
  - Set the furthest status that is true: committing and integrating in one turn, or committing directly on the main checkout's branch, goes straight to `integrated` without `committed` first. A partial merge stays in Committed.
  - A follow-up that only commits, merges or pushes ends with `committed` or `integrated`, whichever is true.
  - The note says whether the commits were also pushed.
- The daemon does not check git for this (user decision 2): a shared project-root checkout cannot attribute commits to one card, and the agent knows what it merged. Ruling, Noah 2026-11-16: one exception. The daemon checks a worktree card's own branch against the remote base branch to move landed work to Done (LANDED-DONE-SPEC R6). It never sets Integrated.

## 4. Status rules (AUTO-STATUS-SPEC)

- **A1**: a turn starting on an Integrated card resumes like one on Committed: → Development, or the Blocked fallback when Development is off.
- **A1r**: a turn that A1 resumed from Integrated and that ends without any Kanban report returns the card to Integrated.
- No rule moves a card into Integrated.

## 5. Insights and memory

- Review rounds (`shared/workflow-stats.ts`): moves between delivery statuses (In review → Committed/Integrated, Committed → Integrated) are steps forward, not rounds; leaving Integrated for a work stage is not a round either (as for Committed). In review → work stage stays a round.
- Agent habits count a move into any delivery status as a delivery; the memory clue for a message after any delivery status is "feedback".
- Telemetry `c_deliveries` stays "agent moves into In review" (TELEMETRY-SPEC §4 unchanged; telemetry is built off in this fork).

## 6. Onboarding

Same as Committed: the tour's lane strip shows the basic loop and stays as it is; no tip (the lane appears on every board by itself); no What's new entry here, the release that ships it decides.

## 7. Acceptance

- Default order and labels include Integrated right after Committed; `statusLabels.integrated` is translated in every catalog.
- 9- and 10-lane stored configurations load (SQLite, JSON, RPC input) with Integrated inserted right after Committed, enabled; other lanes' names and on/off kept; an 11-lane configuration is unchanged.
- Agent `status integrated`: allowed when enabled, `STATUS_UNAVAILABLE` when off; outputs and `moveTo:"done"` accepted; the gate refuses once with open items or missing setup; CLI accepts `status integrated --outputs ... --moves ...`.
- A1 from Integrated → Development; A1r restores Integrated.
- Review rounds ignore In review → Integrated and Committed → Integrated.
- Skill, `SKILL.md`, turn checklist and tool description carry the §3 guidance.
- `npm run typecheck`, `npm test`.

## 8. Rollback

Older Flowly versions cannot read a board with an Integrated card or an 11-lane configuration. To go back: move Integrated cards to Committed (or In review/Done when going back before Committed) and remove `integrated` from each project's lanes, or restore the daily backup from before the upgrade, then install the older version.
