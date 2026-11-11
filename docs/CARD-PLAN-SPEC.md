# A card's plan (CARD-PLAN-SPEC)

Status: requested 2026-11-10 (Noah, via a planning session); design approved 2026-11-10 with rulings: agents may replace or clear any plan (the old one stays an input); a Set plan action when a card has none; the Workpad's to-do group becomes Steps. Contract only; progress is in `docs/PROGRESS.md`.

An approved plan had no first-class place on a card. It could only be a generic input artifact, so Flowly could not tell "this card is planned and approved" from any other attachment. A session that planned in Claude plan mode and then made a card with `flowly_create_card` pasted the plan into the description; the plan file itself never reached the card. This spec gives a card one **Plan** slot, fills it automatically when a plan-mode request in the card's session is approved, lets agents and people set it, and uses it when a session starts (no re-planning of approved work).

## 1. Data

### 1.1 Where it lives: a marked artifact

A card has at most one plan. It is stored as an artifact (CARD-ARTIFACTS-SPEC §2.1) with a new optional `plan` field, not as a new collection:

```
Artifact.plan?: {
  approvedAt: string | null,          // ISO time; null = draft
  approvedBy?: { kind: "human" | "agent", agentId?: string },   // set with approvedAt
  source: "plan-mode" | "tool" | "manual",
  setAt: string,                      // when this artifact became the card's plan
}
```

The plan's target (absolute path, `./path` in the workspace, or http(s) URL), title, creator and `createdAt`/`updatedAt` are the artifact's own fields.

Why an artifact and not a new `plans` collection:

- A plan is a file or link, exactly what an artifact references. The artifact path rules (scope, extra folders, `./` storage, Missing), the preview and opener (`artifacts.preview`), `artifacts.status`, the per-card limit, permanent-delete cascade and its `removed/` backup, and project removal all apply unchanged. A separate collection would duplicate each of them.
- Replacing a plan keeps the old one as an ordinary input (§3.3): with an artifact that is dropping one field, with no copy.
- It follows the precedent of review ledgers' `origin` field (REVIEW-LEDGERS-SPEC §3): one artifact field marks a record Flowly treats specially.
- `board.plans` already exists and holds workpad plan snapshots (WORKPAD-SPEC §2.2); a second meaning for that name would be confusing.

Backward compatibility: the field is optional, so older boards read as "no plan" and the board version stays 5. An older plugin reading a newer board drops the field (zod strips unknown keys) and the plan becomes an ordinary artifact; nothing else is lost.

Invariants (checked in every write, `server/plans.ts`):

- At most one artifact per card has `plan`. Setting a plan clears the field on any other artifact of the card in the same transaction.
- A plan artifact is never `origin: "review-ledger"` and never `external` (a Jira or Linear item is not a plan file; refused with `An external item can't be the plan.`).
- `approvedBy` is present exactly when `approvedAt` is not null.
- A new plan artifact gets `role: "input"`. An existing artifact made the plan keeps its role (a design card's output can be its plan).

Helpers in `shared/plans.ts`: `planOf(artifacts, taskId)` (the card's plan artifact or null) and `planApproved(plan)`.

### 1.2 Plan copies

When Flowly has only the plan's text (§4), it writes it to `<plugin data>/plans/<taskId>/<UTC timestamp, colons replaced by "-">.md` (atomic write, created folders `0700`, file `0600`; a name already taken gets `-2`, `-3`, …) and the plan points at that absolute path. The card's own copy folder, `<plugin data>/plans/<taskId>`, is one of that card's artifact roots (passed to `artifactRoots` wherever card roots are built: `ArtifactService.where`, `AgentService`'s three call sites, `get_task`'s missing check), so its copies preview and never show as Missing; another card's copies stay outside that card's roots. Copies are not deleted when the plan is replaced or cleared (the old plan remains an input and still opens) nor when the card is deleted (its `removed/` backup still points at them).

### 1.3 Events

Plan changes increase the board revision only, never the task revision (same as artifacts). Activity events:

| Action | When | Note |
| --- | --- | --- |
| `plan_set` | an artifact becomes the card's plan (new or replacing), or the approved plan is approved again (§3.2) | `Approved: <title>` or `Draft: <title>` |
| `plan_approved` | a draft plan is marked approved | `<title>` |
| `plan_cleared` | the slot is emptied (Remove, `flowly_clear_plan`, or the plan artifact deleted) | `<title>` |

A newly created plan artifact also records the usual `artifact_added`. Actor: `human` for people and plan-mode approvals (the user approved it), `agent` with `agentId` for tools. Activity labels: *Set the plan*, *Approved the plan*, *Removed the plan*.

## 2. Card details

### 2.1 The Plan row

A **Plan** row at the top of the card details, under the description and above the first section; not one of the movable sections (DRAWER-SPEC), shown when the card has a plan; otherwise the Set plan action below. Implementation: `client/task-plan.tsx`.

- Icon (`FileText`, or `Link` for a URL), the title (one line, truncated), and below it, muted, *Approved <relative time>* or *Draft*; a Missing file shows *Missing* first, as artifact rows do.
- Press the row: opens the plan with the artifact opener (URL in the browser, file in the artifact preview).
- Overflow menu (`Ellipsis`, as other menus): **Mark approved** (drafts only; toast *Plan approved*), **Replace…**, **Edit…**, **Remove**. Replace opens the artifact form (§2.2) to add a new plan, offering only the Plan role (as Set plan does). Edit opens the form on the plan artifact itself (title, note, or Input/Output to empty the slot); the plan is not listed under Inputs or Outputs, so this is where it is edited. Remove empties the slot and keeps the file as an ordinary artifact (toast *Plan removed. It stays in Inputs.*, or *… in Outputs.* for an output); no confirm.
- The plan artifact is not listed again under Inputs or Outputs.
- No plan: the row's place holds a small **Set plan** action (`Plus` icon, muted text) that opens the artifact form (§2.2) with the Plan role chosen and the form titled *Set plan* (ruling, Noah 2026-11-10: discoverability). Hidden on archived cards and in archived projects.
- Archived card or project: the menu is disabled; the row still opens.
- A search hit on the plan artifact (`artifact:<id>`) rings the Plan row.
- The Workpad's to-do group (WORKPAD-SPEC §2.2) is renamed from *Plan* to *Steps* in every locale, so only the card's plan is called Plan (ruling, Noah 2026-11-10).
- Tour: the More features list gains *A card's plan*; a one-time tip `plan` on the first open of a card with an approved plan: *This card's approved plan. New sessions start from it instead of planning again.*

### 2.2 Setting a plan by hand

The artifact add/edit form's role choice gains a third option, **Plan**, next to Input and Output. Saving with Plan sets the card's plan (`plans.set`, §5.1) as approved by the user (`source: "manual"`): choosing it is the approval. Editing an existing artifact to Plan saves its title and note, then makes it the plan (`plans.set` with its target); choosing Input or Output on the plan artifact sets that role (`artifacts.update`, which never touches `plan`) and then clears the slot (`plans.clear`; in this order because the clear changes the artifact's `updatedAt`). A new plan with a note is set, then its note saved. A retry after a partly failed save starts from the artifact as saved. Plan is not offered for a review ledger or an external item (§1.1). Saving a new plan shows *Plan set*.

## 3. Rules shared by every writer

### 3.1 Target

The same rules as artifacts (CARD-ARTIFACTS-SPEC §2.2 and the extra-folders increment): http(s) URL, or an existing file inside the card's directories, the extra artifact folders, or the card's plan-copy folder. Errors reuse the artifact texts.

Stored form: a file inside the card's workspace is stored `./relative` only when that workspace is a worktree. In a directory workspace the plan is stored as an absolute path, because `flowly_start_card` moves a directory card to a worktree without rewriting artifact targets, and a `./` plan would then be Missing. This applies to every writer (`plans.set`, `flowly_set_plan`, `flowly_create_card`'s plan, plan mode). A `./x` file and its absolute form in the card's workspace name the same target, for the plan and for every artifact write (`artifacts.create`, `flowly_report_progress` artifacts and outputs): adding the other form updates the existing record (keeping its stored target) instead of adding a second one.

Known limit: a worktree card switched to local keeps its `./` plan, which then resolves against the main checkout (like every other `./` artifact of that card); it shows as Missing when the file was only in the worktree.

### 3.2 Setting

`setPlan(store, board, { taskId, kind, target, title?, approved, by, source })`:

1. The card is live (`Archived cards can't be changed.`).
2. An artifact with the same `(kind, target)` on the card becomes the plan; a `./` record of the same file counts as the same target and its target is made absolute by the rule above (its title changes only when the writer may edit it: a person, or an agent on an agent-added artifact; never a review ledger, which is refused: `A review ledger can't be the plan.`). Otherwise a new input artifact is added (`createdBy` per `by`; plan-mode copies `human`), subject to the 100-artifact limit.
3. Any other plan artifact of the card loses its `plan` field and stays as an ordinary artifact (§3.3).
4. `approved: true` sets `approvedAt` = now and `approvedBy` = `by`; `false` leaves it a draft. Setting the same target that is already the plan only updates approval: `approved: true` approves a draft (event `plan_approved`); `approved: true` on an approved plan approves it again (new `approvedAt`, `approvedBy` and `source`; event `plan_set`, `Approved: <title>`), as when plan mode rewrites the same file and the user accepts it again. A person or plan mode renews any approval; an agent renews only an agent's approval, and its `approved: true` over an approval by a person or plan mode changes nothing (no event, no board write); `approved: false` on an approved plan changes nothing (a plan is never un-approved; replace it instead).

### 3.3 Replacing and clearing

A later plan replaces the earlier one: the earlier artifact keeps everything but `plan`, so it stays under Inputs (or Outputs) and its file is untouched. Clearing drops the field the same way. Deleting the plan artifact itself (person: any; agent: refused, §6.1) empties the slot and records `plan_cleared` too.

## 4. From plan mode

Observed in the daemon, so it works whether the user answered in Flowly's question UI or in Paseo:

1. `agent.permission.before` with `request.kind === "plan"`: Flowly keeps `{ text, path }` by `request.id` in memory at once (at most 200 entries, dropped after 24 h), together with the pending lookup of whether the session is a Flowly-managed card session (its `agentId`, `taskId`); a session that is not one is forgotten when the lookup ends. Keeping it before the lookup ends means a fast approval still finds it. `text` is `input.plan`; `path` is the first string among `input.planFilePath`, `input.plan_file_path`, `input.filePath`, `input.file_path`, `metadata.planFilePath`, `metadata.filePath`.
2. `agent.permission.after` for a kept id with `resolution.behavior === "allow"` waits for that lookup (at most 10 s) and goes on only for a card session answering its own request. What the user edited at approval wins: when `resolution.updatedInput.plan` is a string that differs from the kept text, that text is what the user approved, so it is saved as a plan copy and becomes the plan even when the request named a file; otherwise a path among the same keys of `updatedInput` wins over the kept path, and the kept text and path are used. A lookup that does not answer within the 10 s is given up and logged. The card must be live (not archived, project live) before anything is written, so an archived card gets no plan copy. Then the card's plan is set, approved, `source: "plan-mode"`, `approvedBy: { kind: "human" }`, actor `human`. Target: `path` when it passes §3.1 as a file; otherwise the text saved as a plan copy (§1.2); neither (no usable path, empty text): nothing is set, logged. Title: the text's first Markdown heading, else the file name, else *Plan*, at most 120 characters. A `deny` (Keep planning) sets nothing. Either way the entry is dropped.
3. Failures are logged with `logFailure` and never affect the hook or the session. A request raised before a plugin reload is not known after it, so its approval is not captured (known limit).

Sessions outside cards are not captured: they have no card. An agent that planned there and then creates a card passes the plan with `flowly_create_card` (§5.2).

## 5. Interfaces

### 5.1 Human RPCs

| Method | Input | Behavior |
| --- | --- | --- |
| `plans.set` | `{ taskId, target, title? }` | §3 with `approved: true`, `by: human`, `source: "manual"`; target resolved as `artifacts.create` does (relative to the workspace) |
| `plans.approve` | `{ taskId }` | approves the draft plan (`approvedBy: human`); no plan: `This card has no plan.`; already approved: no change |
| `plans.clear` | `{ taskId }` | §3.3; no plan: no change |

Results return the plan artifact (or `null` for clear) and change the board revision like artifact RPCs.

### 5.2 Agent tools

Card tools (AGENT-CARDS-SPEC §2): on card sessions' `flowly` server and sessions outside cards' `flowly-board` server, scoped to the caller's project, no signed request; the dispatcher gets the `plan` and `mode` fields through the shared `flowly_create_card` / `flowly_start_card` schemas. Gated by **Agents create and edit cards** (`AGENT_CARDS_DISABLED`). Names match `^[a-z][a-z0-9._-]*$`.

- `flowly_set_plan` `{ taskId, target, title?, approved }`: §3 with `by: { kind: "agent", agentId }`, `source: "tool"`. Errors: `CARD_NOT_FOUND`, `ARCHIVED`, `PLAN_INVALID` (target refused; the artifact message). Result `{ plan }` (§5.3).
- `flowly_clear_plan` `{ taskId }`: §3.3. Result `{ cleared: boolean }`.
- `flowly_create_card` gains optional `plan: { target, title?, approved }`. The target is checked against the project's directories (a relative path is relative to the project root) and the extra folders before the card is created (`PLAN_INVALID`, nothing created), and set in the same create after the workspace exists (stored relative to it when inside it). If that last step fails, the card stays and the failure is logged. Replays return the card as created.
- CLI (card sessions, like the other card tools): `set-plan --input <JSON>` and `clear-plan --input <JSON>`.
- `flowly_start_card` gains optional `mode` (§6).
- Tool text: *approved=true only when the user approved this plan in your chat (for example by accepting it in plan mode); otherwise false, a draft.* `flowly_create_card`'s `plan` text: *If you planned this card (plan mode writes the plan to a file), pass that file here so the card keeps it.*

### 5.3 Reading it

- `flowly_get_task` gains `cardPlan: { artifactId, target, absolutePath?, title, approved, approvedAt, approvedBy?, source, missing } | null`; the plan artifact is left out of `artifacts`. (`plan` in `get_task` is already the sessions' todo lists, WORKPAD-SPEC §2.2.) `flowly_set_plan` returns the same shape as `{ plan }`.
- `flowly_get_card`'s card view gains `plan: { title, approved } | null`.
- Session context (`sessionContext`): before *Inputs:*, one line `Plan (approved): <title>: <target>` or `Plan (draft): …`.
- Skill: when `get_task.cardPlan.approved` is true, execute that plan; don't plan again unless the user asks or the plan is Missing.

## 6. Starting a session

`suggestPlanAwareMode({ resolved, explicit, approvedPlan, suggested })` in `shared/plans.ts` runs after the normal defaults are resolved, so it stays apart from how those defaults are chosen (MODEL-DEFAULTS-SPEC):

- An explicit mode always wins.
- Otherwise, with an approved plan and a resolved mode of `plan`, the mode becomes the provider's usual suggestion (`suggestedMode(providerBase(provider))`). No approved plan: the resolved mode stands.

### 6.1 `flowly_start_card`

- `mode` (optional, 1–80 characters): the permission mode id. When Paseo lists the provider's modes for the card's workspace directory as it is before the start (`providers.listModes`, checked before any worktree is made), a mode not among them is `MODE_UNAVAILABLE` (listing the ids); when the list cannot be read, the mode is passed as given.
- No `mode`: the New task defaults, then `suggestPlanAwareMode`.
- The default prompt (no `prompt`) is the title and description, then, with an approved plan, one paragraph: `Approved plan: <absolute path or URL>. Execute this plan; do not plan again.` A `./` target is made absolute against the card's workspace directory before the start (the file that exists now; a new worktree may not have an untracked plan file). A given `prompt` is sent as is.
- `flowly_remove_artifact` on the plan artifact is refused: `ARTIFACT_FORBIDDEN` *This is the card's plan; use flowly_clear_plan.*

### 6.2 Board forms

The drawer's Start session form (`client/session-create.tsx`) and New task form pass their resolved defaults through the same helper: a card with an approved plan does not default to Plan mode. The user can still pick it. A new card has no plan, so New task is unchanged until it can carry one.

## 7. Linear sync hook point

The agreed, not yet built Linear sync (LINEAR-TICKET-SPEC) posts "plan approved" when a card leaves Design with a plan. It keys off this slot: on `status_changed` from `design`, `planOf(board.artifacts, taskId)` with `approvedAt` set gives the title and link to post (a file target has no public link, so the sync posts the title and says it is attached on the card). Nothing in this spec posts to Linear.

## 8. Not in scope

- More than one plan per card, plan versions or diffs.
- Plan capture for sessions outside cards, or plan-mode approvals Flowly did not observe.
- Un-approving a plan.
- A plan field on New task (§6.2).

## 9. Acceptance

- `shared/plans.test.ts`: `planOf`, `suggestPlanAwareMode` (explicit wins, approved plan + `plan` → suggestion, draft or none → unchanged), plan request parsing (path keys, heading title).
- `server/plans.test.ts`: set new and existing targets, replace keeps the old as an input, clear, approve, no un-approve, one plan per card, review ledger refused, archived refused, events and actors, board revision only, artifact delete clears the slot, a `./` file added again by its other form reuses the record, an agent's approval never overrides one by a person or plan mode.
- Plan-mode capture: allow with a path inside the roots points at it; a path outside, or none, saves a copy under `plans/<taskId>/`; deny sets nothing; a non-card session sets nothing; a later approval replaces the plan; text edited at approval becomes a copy even when the request named a file; a lookup timeout is logged.
- `server/agent-cards.test.ts` / `server/tool-server.test.ts`: `flowly_set_plan` and `flowly_clear_plan` listed on card and board servers; `flowly_create_card` with a plan (valid, invalid → nothing created); `get_task.plan`; remove_artifact refused on the plan.
- `server/start-card.test.ts`: approved plan + default `plan` mode starts in the suggestion; explicit `mode` wins; unknown mode → `MODE_UNAVAILABLE`; default prompt carries the plan line.
- Client: role choice with Plan; the plan is not listed in Inputs; Start session defaults away from Plan mode with an approved plan.
- All new strings in every catalog; `npm run typecheck` and `npm test` pass.
