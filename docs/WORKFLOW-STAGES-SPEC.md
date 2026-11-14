# Workflow stage split: In progress → Design / Development / Test

Status: approved by the user on 2026-10-15 ("OK, let's try it, change it back if it doesn't work", translated), implemented. For rollback see §8.

> 2026-10-29: Committed was added after In review ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md)), making the status set 10 long; it is not a work stage.
>
> 2026-10-29: Integrated was added after Committed ([INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md)), making the status set 11 long; it is not a work stage either.

User decisions:
1. In progress is too broad, so split it into three stages, **Design → Development → Test**;
2. It applies to **all projects**: `in_progress` is retired and existing data is migrated (option B);
3. Whether to design first or develop directly is **decided by the agent from its instructions**: the system rules do not choose the starting stage for the agent.

## 1. Status set

Default order:

```
backlog → todo → design → development → test → in_review → blocked → done → cancelled
```

| status | Default name | Meaning |
| --- | --- | --- |
| `design` | Design | Plan, spec, research |
| `development` | Development | Implementation |
| `test` | Test | Verification, fixing problems found in verification |

- `in_progress` is no longer a valid status for a card or lane. An `in_progress` in `taskInput`, `taskEdit`, `tasks.place` or `projects.update` is rejected as a validation error.
- The three are together called "work stages" (`workStatuses = ["design", "development", "test"]`, exported from `shared/model.ts`); everywhere that used to check `status === "in_progress"` now checks "is a work stage".
- The lane configuration is still an ordered list of all built-in statuses (its length becomes 9), which can be reordered, switched on and off and renamed, with the same rules.

## 2. Data migration (v3 → v4)

`board.json` goes to version 4. When `BoardStore.load` reads v3 it migrates in memory and persists on the next write:

1. **Cards**: `status === "in_progress"` → `development`. No revision increase and no activity is written (migration is not a business change).
2. **Lanes**: when a project has `lanes`, the `in_progress` entry is replaced in place by the three entries `design`, `development`, `test`, with `enabled` carried over from the original; if the original `name` is non-empty, it goes to `development`. Projects without `lanes` keep using the defaults.
3. **History**: `events[].from/to` and `agentReceipts[].status` are **not rewritten**. They use `historyStatusSchema = statusSchema ∪ {"in_progress"}` instead, and the UI shows "In progress".
4. **Backup**: the first time data from before v4 is read, if `board.pre-v4.json` does not exist, the original file is copied to `board.pre-v4.json` (separate from the existing `.bak`, so later writes do not overwrite it).
5. v1/v2 first go up to the v3 shape by the existing path, then go through the steps above.
6. When the invariant check fails after migration, the original file is kept and `StoreInvalidError` is reported, per the existing rule; data is not reset.

## 3. Automatic status rules (amends AUTO-STATUS-SPEC)

| Rule | Behavior after the amendment |
| --- | --- |
| **A1 Start** | When the card is in Backlog/Todo, a session starting a turn **no longer changes the status**. The agent decides which stage to enter from its instructions and sets it by calling `flowly_update_status`; the agent guide requires it to set the stage as soon as it starts real work. |
| **A1 Continue** | (amended again 2026-10-15) When the card is in **In review**, a session starting a turn → **Development** (feedback after review is usually rework; for plan rework the agent changes it back to Design); when Development is not enabled, use the Blocked fallback below. When the card is in **Blocked** → back to **the work stage the card was last in**: derived from the most recent `status_changed` in the activity with `to ∈ work stages ∪ {in_progress}`, where `in_progress` counts as `development`; when none is found or that lane is not enabled, take the first enabled work stage; when all three are off, do nothing. |
| **A1r Recover** | The condition "task.status === in_progress" becomes "is a work stage"; the rest is unchanged. |
| **M2 Silent end** | The `silentTurn` condition becomes "the card is in any work stage". |
| Other | A2, M1, M3 are unchanged. The rules never advance automatically between the three work stages. |

Known trade-off: a Backlog/Todo card stays in its original column until the agent sets a status, and the session's running state is shown on the card as usual.

## 4. Agent tool, CLI, skill

- `agentStatuses = ["design", "development", "test", "blocked", "in_review"]`; `allowedStatuses` still lists only the lanes the project has enabled.
- **Compatibility with old calls**: a running session may still hold the old tool schema, or call `status in_progress` per the old skill. The tool input additionally accepts `in_progress` as an alias: when the card is already in a work stage it stays unchanged (only the note is recorded), otherwise it resolves to `development`. The receipt and the activity record the resolved real status. The alias does not appear in `allowedStatuses` or in docs.
- The CLI `status <state>` usage hint and validation are updated the same way, with the same alias rule.
- The skill and tool descriptions now say: set Design when starting plan/research, Development when starting implementation, Test when starting verification; decide by the task's needs which stage to start from, and stages may be skipped or stepped back; set In review on delivery; set Blocked when blocked. "A new turn automatically returns to in_progress" becomes "automatically returns to the previous work stage".
- 2026-10-15 amendment (user feedback: a card whose implementation was being reworked was pulled back to Design): the agent had finished implementation in Design and delivered directly without switching to Development, so A1 returned to a stale stage. The guide and tool descriptions now add: the stage must switch in real time with the work, set Development as soon as you start changing code, and never deliver an implementation straight from Design; at the start of each turn check the automatically restored stage and, if it does not match this turn's work, correct it first (the original text "do not set it yourself just to continue" was removed). The same day the user reported again that an old session was still pulled back to Design, so A1 was changed so that continuing from In review goes to Development (see §3).

## 5. UI

- Status icons/colors: they belong to the same lucide `Circle*` family as the other statuses to keep the visual size consistent (the host bundles full lucide, confirmed in the installed package): Design `CircleEllipsis` (foreground), Development `CircleDot` (warning), Test `CircleGauge` (accent).
- The lane editor, board columns, the phone status sheet, the card status dropdown and the compact layout's "first lane with cards" logic all cover them automatically through `statuses`, with no special cases.
- Copy updates: the Auto-update description in project settings (`client/forms.tsx`) and the tool description in the session preview (`client/session-preview.tsx`).
- A historical `in_progress` in the activity timeline is shown as "In progress".

## 6. Docs

- Update AUTO-STATUS-SPEC (A1/A1r/M2), add this entry at the top of SPEC-OUTLINE, and record the check results in PROGRESS.

## 7. Acceptance

Focused tests:
- Migration: v3 card `in_progress` → `development`; lanes expanded in place, enabled carried over, rename goes to Development; projects without `lanes` unchanged; historical events and receipts keep their original value and can be parsed; `board.pre-v4.json` is written only once; chained v1/v2 migration.
- Rules: Backlog/Todo start does not move; In review continue goes to Development (fallback when not enabled); Blocked continue returns to the previous work stage (including historical `in_progress` → development, the fallback when the lane is off, and no move when all are off); A1r recovers in all three stages; no move for `autoStatus=false`, finished or archived cards; `silentTurn` covers the three stages.
- Tool: `allowedStatuses` is filtered by lane; the three stages can be set; both cases of the `in_progress` alias; a lane that is not enabled is rejected.
- Input validation: a hand-written `in_progress` is rejected.

Other: `npm run typecheck`, `npm test`; after `paseo plugin reload paseo-ultra-kanban`, check the migration result on the real board data (record the number of in_progress cards in `board.json` before migrating); per the project requirement, use a full-access `codex/gpt-6-luna` session to verify the desktop and compact UI, the agent setting stages and the rules, and save the evidence to `docs/verification/workflow-stages.md`.

## 8. Rollback

If the split turns out wrong: before disabling the plugin or rolling back code, overwrite `board.json` with `board.pre-v4.json` (this loses board changes made after the migration), or keep the data and only map the design/development/test cards in v4 back to `in_progress` by hand and lower the version to v3. Old code cannot read v4 data (a version check failure keeps the file and reports an error; it does not reset).
