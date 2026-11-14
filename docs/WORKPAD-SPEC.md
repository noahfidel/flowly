# Card Workpad: acceptance, validation and delivery gate (WORKPAD-SPEC)

> 2026-10-28: parts of this document are superseded by [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) (§12). Superseded: validation / confusions / env / head / delivery in §2.1, the inputs in §3, the environment stamp in §4.2, all of §5, the card-face signal in §6.1, Checks / Confusions in §6.2, the validation actions in §6.3, the skill in §7. Still valid: Plan in §2.2, the two revisions in §2.4, the acceptance ticking in §6.3, the project switch in §9.

Status: reviewed and finalized by the user on 2026-10-19, who asked for implementation. Card task `78fb25af`. Source: [SYMPHONY-RESEARCH](SYMPHONY-RESEARCH.md) §2.3, §2.4, §3 P1/P2. The user chose the "lean version": Plan is derived from the native todo; the agent writes only Acceptance, Validation (three states + sha) and Confusions; no Notes; the workpad has its own revision; the delivery gate and sha staleness detection are included. Final decisions: a card without a workpad is not checked on delivery (§5.3); when there are acceptance criteria the summary's Target is hidden (§6.2); a human can mark a validation as pass, stamped with the current HEAD (§6.3).

## 1. Purpose

When a human reviews a card, they should see four things at a glance: what is planned, what the acceptance criteria are, which validations were run (passed / failed / not run), and whether those validations were run on the current code. Today these can only be pieced together from append-only progress notes, after-the-fact summaries and the conversation; the "completed / failed / unrun recorded separately" that AGENTS.md requires depends entirely on the agent writing it in text by discipline.

A Workpad is a structured checklist attached to the card and **updated in place**. It is also the data source later automation (Nudge continuation, Merging lane actions, Rework reopen) uses to judge "what is left", so the fields must be machine-readable and not only for humans.

Principles:

- **The agent writes what the system cannot infer; the system infers what it can.** Plan comes from the provider's native todo (zero extra tool calls); the environment stamp and sha are read by the daemon with git, not self-reported by the agent.
- **The gate is soft.** With open items, delivery is not refused, but the agent must confirm explicitly and a visible marker is left on the card. Done is still decided only by a human.
- **It does not change the task revision.** The workpad has its own revision, so a human ticking one item does not make the agent's other writes fail with `REVISION_CONFLICT`.

Not in v1: hierarchical Plan; a Notes section (progress notes already cover it); humans editing the text of items or adding items (a human tells the agent through the description or a message); aggregating Confusions into Insights; per-repo sha for multiple repos (several repos under a common parent directory); automatic continuation.

## 2. Data

### 2.1 Workpad (maintained by the agent, one per card)

`board.json` gets a new `workpads` array (like `artifacts`; missing reads as an empty array, and the board version is unchanged), and reaches the client with the existing etag board read, with no new polling.

```
Workpad {
  taskId, projectId,
  revision: int ≥ 1,              // the workpad's own revision, see §2.4
  acceptance: AcceptanceItem[],   // ≤ 20
  validation: ValidationItem[],   // ≤ 20
  confusions: ConfusionItem[],    // ≤ 10
  env: { host, path, head: GitHead | null } | null,   // read by the daemon at the latest agent write (§4.2)
  head: GitHead | null,                               // the current HEAD at the latest refresh (§5.2)
  delivery?: { unchecked, failed, unrun, stale, total, revision, eventId, at },  // the latest agent delivery (§5.3)
  updatedAt, updatedBy: "agent" | "human", agentId?
}

GitHead { sha?, branch?, dirty, at }

AcceptanceItem { id, text (1–300), done: boolean, by: "agent" | "human", at }

ValidationItem {
  id, text (1–300),                      // what to verify, a description for humans
  command?: string (≤ 300),              // the concrete command, such as "npm test"
  state: "pass" | "fail" | "unrun",
  sha?: string,                          // the commit at run time, 12-character short sha (§5.1)
  dirty?: boolean,                       // the working tree had uncommitted changes at run time
  ranAt?: timestamp,
  evidence?: string (≤ 600),             // output summary, failure reason or artifact reference
  by: "agent" | "human", at
}

ConfusionItem { id, text (1–600), at }
```

`shared/model.ts` adds `workpadSchema` and `workpadLimits = { text: 300, command: 300, evidence: 600, confusion: 600, acceptance: 20, validation: 20, confusions: 10, planItems: 50, planText: 300 }`. `id` is 1–40 characters of `[a-z0-9-]`, unique within a section of a card. The pure logic (merging, freshness, open items, card-face signal, taking Plan from the timeline) is in `shared/workpad.ts`; git reading, human editing and Plan recording are in `server/workpad.ts`.

The limits are estimated against the tool request body: a full workpad with multi-byte text can exceed 64 KiB, so the request body limit of the tool service is raised from 64 KiB to 256 KiB (the same for MCP and the CLI's `/api`).

### 2.2 Plan (derived from the native todo, one per card per session)

`board.json` gets a new `plans` array:

```
PlanSnapshot { taskId, agentId, items: { text (≤ 300), status: "pending" | "in_progress" | "completed" }[] (≤ 50), at }
```

- Source: when a board-managed session (the scope of AUTO-STATUS-SPEC §1) receives `agent.turn_ended` (any outcome), take the **last** `type: "todo"` entry in the hook's own `timeline` (`AgentTaskItem[]` of `@getpaseo/protocol`: Claude's TodoWrite, Codex's plan tool). When `status` is missing it is derived from `completed` (`completed ? "completed" : "pending"`).
- No todo entry this turn: keep the previous snapshot unchanged. An empty todo array: clear that session's Plan.
- Updated only at turn end; during a turn what is seen is the plan from the end of the previous turn (the live plan of a running session is already visible in the session preview).
- No event is recorded and the task revision is not changed; only the board revision increases; nothing is written when the content did not change. `WorkpadService.recordTurn` runs it after the hook returns, and a failure is only logged and does not block the hook.
- Plan is **not counted** in the delivery gate (native todos are often not wrapped up by the agent, and counting them would create noise); it is only shown.

### 2.3 Events

| action | actor | When | note |
| --- | --- | --- | --- |
| `workpad_updated` | agent (with agentId) | `flowly_update_workpad` submitted | A count summary, such as `Acceptance 2/4 · Checks 3/5, 1 failed` |
| `workpad_checked` | human | A human ticks / changes the state / removes a confusion (§6.3) | `<section name>: <first 80 characters of the item text>` → new state |

Neither is shown in the card activity timeline (same as `next_moves_suggested`, to avoid flooding); the flow log records them as usual. The `status_changed` event gets an optional field `workpad` (the delivery snapshot, §5.3).

`silentTurn` (`shared/progress.ts`) also counts `workpad_updated` as a report in this turn; `openQuestion` is unchanged (updating the workpad is not answering the question). Rule A1r already counts any agent event other than next moves as work and needs no change.

### 2.4 Two revisions

- **task revision**: a workpad write (by the agent or a human) never changes it. The `expectedRevision.task` semantics of the existing tools are unchanged.
- **workpad revision**: every write (the agent replacing it as a whole, a human changing one item) adds 1. An agent write must carry `workpadRevision` (0 when there is no workpad yet), and a mismatch gives `WORKPAD_CONFLICT`. This way an item a human just ticked is not overwritten by the agent with a stale copy, while the agent's status/progress/artifact writes are not affected by human ticks.

## 3. Agent tool `flowly_update_workpad`

### 3.1 Input

```
{
  expectedRevision, request,          // copied from get_task, validated like the other write tools
  workpadRevision: int ≥ 0,           // workpad.revision from get_task; 0 when there is no workpad
  acceptance: { id?, text, done }[],
  validation: { id?, text, command?, state, sha?, dirty?, evidence? }[],
  confusions: { id?, text }[]
}
```

- The three sections are **replaced as a whole**: an item not in the input is deleted. All three sections must be given (they may be empty arrays).
- Item matching (used to keep `by`, `at`, `sha`): first by `id`; with no `id`, by `text` with whitespace stripped and case-insensitive; if neither matches it is a new item, and the daemon assigns an `id` (a slug generated from the text, with a number added on conflict).
- `by` / `at`: when the content (text, done, state, command, evidence, sha) equals the matched old item, the original values are kept; otherwise `by: "agent"` and `at` is the current time.
- `sha` resolution: see §5.1.

### 3.2 Validation and results

- Signature, `expectedRevision`, expiry, archived, Done/Cancelled (`TASK_FINISHED`), replay and `REQUEST_REUSED`: the same as the other write tools (`write` in `server/agent-service.ts`). The receipt has action=`workpad`, with a new `workpadRevision` (the value after the commit).
- `WORKPAD_CONFLICT`: `workpadRevision` is not the current value. The message carries the current value: "Workpad changed (current revision=N), possibly by the user. Re-read get_task, keep their checks, then retry." Nothing is committed.
- `WORKPAD_INVALID`: exceeding a count or length limit, a wrong `id` format or a duplicate within a section, a `state` that is not one of the three, a `sha` that cannot be resolved to a commit of that repo, a workspace that is not a git repo but was given a `sha`.
- Success: a `workpad_updated` event is written, and `env` and `head` are refreshed (§4.2, §5.2). The `current` in the result contains the new workpad.
- CLI: `workpad --request-file <snapshot> --workpad-revision <n> (--workpad '<JSON>' | --workpad-file <path>)`, where the JSON is `{acceptance, validation, confusions}`. HTTP API action `workpad`.

### 3.3 Tool description (English, goes into the description and the skill)

> Replace this card's workpad: acceptance criteria (done or not), validation checks (pass, fail or unrun, with the command and the commit they ran on) and confusions (what in the card was unclear). The plan comes from your own todo list; do not repeat it here. Send all three lists every time; items you leave out are removed. Copy workpad.revision from get_task as workpadRevision (0 when there is none). On WORKPAD_CONFLICT the user changed it: re-read, keep their checks, retry. Does not change card status or task revision.

## 4. get_task and the environment stamp

### 4.1 New get_task fields

```
workpad: {
  revision, acceptance, validation (each with fresh: "fresh" | "stale" | "unknown", §5.2),
  confusions, env, head,
  open: { unchecked, failed, unrun, stale, total }   // the counts of §5.3
} | null,
plan: { agentId, own: boolean, items, at }[]         // the Plan of each session of this card, this session first
```

### 4.2 Environment stamp `env`

On every agent workpad write, the daemon reads the following outside the transaction (argument-array subprocesses, 5-second timeout; on failure the corresponding field is empty and the write is not blocked):

- `host`: `os.hostname()`; `path`: the card workspace directory (home abbreviated to `~` when displayed);
- `head.sha`: `git -C <dir> rev-parse --short=12 HEAD`;
- `head.branch`: `git -C <dir> rev-parse --abbrev-ref HEAD` (omitted when detached);
- `head.dirty`: the output of `git -C <dir> status --porcelain` is non-empty (including untracked files).

Shown as `host:path@sha` (with `*` appended when dirty). When the workspace is not a git repo (for example a common parent directory of several sub-repos): `sha` and `branch` are empty and all sha-related checks are `unknown`.

## 5. Validation freshness and the delivery gate

### 5.1 The sha of a validation item

An item with `state` `pass` / `fail` must have a sha, determined in this order:

1. The agent gave `sha`: after validating with `git rev-parse --verify --quiet <sha>^{commit}` the 12-character short sha is stored; a resolution failure is `WORKPAD_INVALID`. `dirty` takes the value the agent gave (default false).
2. Not given, and the matched old item has the same `state` and already a sha: keep the old sha, `dirty` and `ranAt` (the agent did not rerun, it only resent the whole thing).
3. Otherwise the daemon stamps it with the HEAD at write time, `dirty` takes the working tree state at write time, and `ranAt` is the current time.

An `unrun` item clears `sha`, `dirty` and `ranAt`. The skill requires: after rerunning a validation, give the `sha` at run time on that item (`git rev-parse --short HEAD`), and also `dirty: true` when it ran on uncommitted changes.

### 5.2 Freshness (sha staleness detection)

`validationFreshness(item, head)` (`shared/workpad.ts`, a pure function):

| Condition | Result |
| --- | --- |
| `state = unrun` | Not applicable |
| The item or `head` has no sha (non-git, git failure) | `unknown` |
| `head.sha` equals the item's sha | `fresh` |
| Different | `stale`: there are new commits since, and the validation needs a rerun |

Known limitation: when uncommitted code was changed after validating on the same HEAD, it cannot be judged stale. It still counts as `fresh`, and the item shows "on uncommitted changes" (when `dirty`).

When `head` is refreshed (one `rev-parse` + one `status`, no polling):

- the agent writes the workpad;
- the agent moves the card to In review (before the gate is computed);
- a board-managed session of this card gets `agent.turn_ended`, and the card's workpad has pass/fail items;
- when the drawer opens this card's Workpad section it calls the RPC `workpads.refresh` (git is not run again within 30 seconds for the same card, and the stored value is returned directly).

A `head` change only increases the board revision and records no event.

### 5.3 Delivery gate (soft)

"Open items" `openItems(workpad)`:

- `unchecked`: acceptance criteria with `done = false`;
- `failed`: validations with `state = fail`;
- `unrun`: validations with `state = unrun`;
- `stale`: validations with `state = pass` and freshness `stale`;
- `total` is the sum of the four. Plan and Confusions are not counted.

When the agent calls `flowly_update_status(status=in_review)` (agent path only; a human dragging to In review is not checked):

> 2026-10-29: `status=committed` is also a delivery, with the same gate, snapshot and card-face marker rules ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §3).

1. First refresh `head` and compute `openItems`.
2. `total = 0`: submit as usual. No workpad (when the project has it on): on 2026-10-21 the user decided on a soft card, returning `SETUP_INCOMPLETE`, see [CARD-SETUP-SPEC](CARD-SETUP-SPEC.md) §3.4 (implemented); the earlier "submit as usual when there is no workpad" is void.
3. `total > 0` and this session has not yet received a rejection for the current state, or the input has no `acknowledgeOpen: true`: return `WORKPAD_OPEN` and commit nothing (no receipt is written, and the same request can be retried with the confirmation). The message lists the open items: "{n} workpad items are still open: … Deliver anyway only if the note explains each one (failed, not run, or out of date), with acknowledgeOpen=true."
4. `total > 0`, this session has received a rejection for the current state, and `acknowledgeOpen: true`: submit; the `status_changed` event carries the delivery snapshot `workpad: { unchecked, failed, unrun, stale, total, revision }`.

2026-10-22 amendment: a first call that already carries `acknowledgeOpen=true` is also rejected; the confirmation is valid only for the same session/card/workspace, the same card/project/workpad revision and HEAD state, for at most 15 minutes. The turn-start hook clears the confirmation records, without depending on the per-card truncated events; after a service reload it is rejected again. See [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §2.

The `flowly_update_status` input gets an optional `acknowledgeOpen: boolean` (default false), and the CLI adds `--acknowledge-open`. The gate does not check the content of the note (the system cannot judge it); it only ensures the agent has seen the list and confirmed on its own.

Card marker: every agent delivery also writes the snapshot into the workpad's `delivery` (with the id of that `status_changed` event). When the card is In review, the latest `status_changed` that entered In review is this delivery (also when the event has been trimmed), and `total > 0`, the card face shows "Delivered with {n} open items" (warning color). It is no longer shown once the card leaves In review, or is dragged into In review again by a human afterwards. The marker reflects the state at delivery time; if a human or the agent ticks more afterwards the marker does not change, and the drawer shows the live state.

## 6. UI

### 6.1 Card face

Add one signal to `CardSignals` (`client/card.tsx`), shown only when there is a workpad, and only one by priority:

| Condition | Text | Color |
| --- | --- | --- |
| In review and the delivery snapshot `total > 0` | Delivered with {n} open items | Warning |
| There is a `fail` validation | Checks {pass}/{total} · {n} failed | Danger |
| There is a `stale` validation | Checks {pass}/{total} · out of date | Warning |
| There are validation items | Checks {pass}/{total} | Default |
| Only acceptance criteria | Acceptance {done}/{total} | Default |

`pass` counts only passed items whose freshness is not `stale`. Icon `ListChecks`. All counts are computed from the board data already on the client, with no new request.

Finished cards (Done, Cancelled or archived) no longer judge staleness (user decision 2026-10-20): later commits no longer make it show out of date, a pass on an old commit counts as usual, and failures are still shown. In the card's Workpad each item is still marked `@sha · out of date` as a historical record.

### 6.2 Drawer

A new **Workpad** section between `TaskProgress` and `TaskArtifacts` (`client/task-workpad.tsx`, `React.memo`, callbacks via `useStableCallback`), expanded by default, and the whole section is not shown when there is no workpad and no Plan:

- The whole section is collapsible (2026-10-19): click the `Workpad` title (with an arrow) to collapse/expand; when collapsed, `Acceptance n/m · Checks n/m` (passed count) is shown on the right of the title; whether it is expanded by default is decided by Settings → Cards → Card sidebar (expanded by default). Acceptance, Checks and Confusions each first show 5 items, and "Show N more" adds 5 each time; Checks are sorted failed, out of date, not run, passed; a command by default shows only one line, and after expanding the output or clicking the command it shows all ([DRAWER-SPEC](DRAWER-SPEC.md#section-order-and-artifacts-paging)).
- Header: `Workpad` + the environment stamp `host:path@sha` (selectable and copyable) + "Updated {time} by {session}".
- **Acceptance**: a list of checkboxes. Items ticked by a human get a small "by you" next to them.
- **Checks**: each row has a status icon (pass green tick / an out-of-date pass warning triangle / fail red cross / unrun gray dashed circle), and clicking the icon cycles unrun → pass → fail → unrun (§6.3); the text, and the monospace `command`; a second small line: `@sha`, "out of date" (stale, warning color), "on uncommitted changes" (dirty), relative `ranAt`; with `evidence`, expand it with "Show output / Hide output".
- **Steps** (renamed from Plan on 2026-11-10 to avoid confusion with the card's plan [CARD-PLAN-SPEC](CARD-PLAN-SPEC.md); the data names `PlanSnapshot`/`plans` are unchanged): read-only, from the native todo. With one session it is listed directly; with several sessions it is grouped by session title, most recently updated first. The status icon at the start of each row (pending / in_progress / completed), labeled "From the agent's todo list · updated at turn end".
- **Confusions**: a list, where each can be removed by a human ("Resolved").
- Freshness: when the section is opened and there are validations that have been run, `workpads.refresh` is called (§5.2); until it finishes the stored value is shown, with no loading state; the board is refreshed only when HEAD changed.

Division of labor with the summary (TASK-SUMMARY-SPEC): when the workpad has acceptance criteria, `TaskProgress` no longer shows the summary's `target` (Goal + feature points) and shows only `state`, `recap`, `next`, to avoid writing the same thing twice. The summarizer's prompt and storage are unchanged.

### 6.3 Human actions (RPC)

| Method | Input | Behavior |
| --- | --- | --- |
| `workpads.check` | `{ taskId, section: "acceptance" \| "validation", itemId, done? , state? }` | Change one item: for acceptance toggle `done`; for validation set pass / fail / unrun (a pass marked by a human is stamped with the current HEAD, `by: "human"`) |
| `workpads.resolve-confusion` | `{ taskId, itemId }` | Remove one confusion |
| `workpads.refresh` | `{ taskId }` | §5.2, only reads git and updates `head` |

- Operates per item, on the latest version, and does not require the client to carry a revision; when the item no longer exists it reports "This item is no longer in the workpad." and the client refreshes. Each success adds 1 to the workpad revision, records a `workpad_checked` event, and does not change the task revision.
- Refused when the card or project is archived: "Archived cards can't be changed." Done/Cancelled cards allow human ticking (for retrospectives).
- Operations take effect immediately, update optimistically, and on failure roll back and use the existing error hint; no toast on success (the tick itself is the feedback).
- Accessibility: the checkbox is named by the item text, and the state is read out as "passed / failed / not run / out of date".

### 6.4 Lifecycle

- Permanently deleting a card: the workpad and Plan are deleted with it and go into the `removed/` backup (TASK-DELETE-SPEC).
- Archive, Wrap up, restore from moving out of Done: the workpad is kept untouched.
- A follow-up new card: does not inherit the workpad (the new card's agent rebuilds it from the description).

## 7. Skill text

`server/skill-source.ts` and `skills/paseo-ultra-kanban/SKILL.md` add one item in sync (English):

> - Keep the card's workpad current with flowly_update_workpad: acceptance criteria, validation checks and confusions. Your plan is read from your own todo list, so keep that list current instead of copying it. Before you start implementing, write the acceptance criteria and the checks you will run; when the card description has a Validation, Test plan or acceptance section, copy each item into the workpad word for word and never weaken or drop one. Each check names the exact command. Update the workpad after each milestone: mark a check pass or fail only after you actually ran it, with the commit it ran on (sha, plus dirty=true when it ran on uncommitted changes); leave it unrun otherwise. Add a confusion when something in the card was unclear and you had to guess. A check that turns out to be unnecessary is removed with a reason in your reply, not marked pass. Before delivering to in_review, rerun checks that are out of date. If items are still open, the status update returns WORKPAD_OPEN: deliver only with acknowledgeOpen=true and a note that explains every open item.

And after the existing sentence "Deliver the overall result to in_review…" add: "…unrun checks and remaining issues; the workpad shows them on the card, so keep it and your note consistent."

The CLI usage section adds the `workpad` subcommand and `status in_review --acknowledge-open`.

## 8. Onboarding and docs

- The welcome page feature list adds one item, **Workpad**: "Agents keep a workpad on each card: acceptance criteria, checks marked passed, failed or not run on a named commit, and what confused them."
- A one-time tip `first-workpad`: appears when any card of the current project has a workpad, with the text "This card has a workpad: the agent's acceptance criteria and checks. The card shows how many checks passed; open it to see which ran on which commit, and tick items yourself." Its priority is after `next-move` and before `first-idea`. `client/onboarding-logic.ts` adds the tip id and the fact `workpads`, `tipText` in `client/board.tsx` adds the text, and the ONBOARDING-SPEC tip table adds one row.
- README / README.zh-CN Highlights add one sentence, and the agent tool list adds `flowly_update_workpad`.
- All new texts (card-face signal, drawer section, state read-outs, errors, tip, welcome page) are added to all catalogs in `shared/i18n/`; `tn` is used for counts. Agent-facing text and daemon errors stay English.
- On implementation add one record at the top of SPEC-OUTLINE, and PROGRESS.md records the completed/failed/unrun checks.

## 9. Project switch

2026-10-19 added by the user: the workpad is an optional feature, switched on and off in the project settings.

- Data: `Project.workpad?: boolean`, on by default when missing (both old and new projects are on); `projects.update` accepts `workpad`, and like other project edits it increases the project revision.
- Settings: the project settings popover adds a switch **Card workpad** after "Auto-update status in this project", with the description "Agents keep acceptance criteria and checks on each card, and delivering with open items needs a note. Off hides it and stops these checks; what agents wrote is kept." Shown only when editing an existing project.
- When off:
  - `flowly_update_workpad` returns `WORKPAD_DISABLED` (nothing written, no receipt left); `get_task` returns `workpadEnabled: false`, `workpad: null`, `plan: []`; the skill requires the agent to list acceptance and validation in progress and delivery notes instead, and not to retry;
  - delivery is not checked (no `WORKPAD_OPEN`, no delivery snapshot recorded);
  - turn end records no Plan and refreshes no HEAD; `workpads.check` / `workpads.resolve-confusion` are refused ("The workpad is turned off for this project."), and `workpads.refresh` runs no git;
  - the card face shows no workpad signal (including "Delivered with N open items"), the drawer shows no Workpad section, Progress shows the summary's Target again, and the `first-workpad` tip does not appear.
- Existing workpad and Plan data are kept untouched; after turning it back on they are shown as usual, and what the agent reads is still the version from before it was turned off.

## 10. Acceptance

Focused unit tests:

- `shared/workpad.test.ts`: the four results of `validationFreshness`; `openItems` counts (Plan and Confusions not counted, stale pass counted); item matching (by id, by text, new-item slug de-duplication); `by`/`at` kept when the content is unchanged; card-face signal priority.
- `server/agent-service.test.ts` (workpad part):
  - the first write with `workpadRevision=0` succeeds with revision=1; the task revision is unchanged; `workpad_updated` is recorded;
  - an old `workpadRevision` → `WORKPAD_CONFLICT` with no write; after a human `workpads.check` the agent's write with the old revision is rejected;
  - the three sources of sha (given and validated, kept from the old value, stamped by the daemon); an illegal sha, a sha given for a non-git directory → `WORKPAD_INVALID`; over the limit → `WORKPAD_INVALID`;
  - an exact replay returns the original receipt; a Done card gives `TASK_FINISHED`;
  - gate: open items without confirmation → `WORKPAD_OPEN` with the status unchanged and no receipt; with `acknowledgeOpen` → submitted and the event carries the snapshot; no workpad or all complete → as usual; HEAD advancing turns a pass into stale and counts it in the gate.
- `server/workpad-plan.test.ts`: take the last todo from the timeline; no todo keeps the old snapshot; an empty array clears it; a missing `status` is derived from `completed`; only board-managed sessions are processed; item and length limits.
- `server/progress-rules.test.ts`: a turn that only updated the workpad does not count as a silent turn; A1r counts a workpad update as work.
- `server/tool-server.test.ts`: the tool list contains `flowly_update_workpad`, and the `flowly_update_status` schema contains `acknowledgeOpen`.
- `client/onboarding-logic.test.ts`: the `first-workpad` rule and priority.
- Project switch (§9): when off, a write returns `WORKPAD_DISABLED`, delivery is not blocked, `get_task` returns no workpad, turn end records no Plan, and human edits are refused; after turning it back on the old data is still there; `projects.update` saves the switch.
- The i18n catalog check of `npm test` passes; `npm run typecheck` passes.

Manual / Luna (per AGENTS.md, using a test card newly added in the Tinylink project, and cleaning up the cards and sessions it created at the end):

- One real Codex and one real Claude session each: the todo list appears in Plan after turn end; the agent writes the workpad per the skill; the card face shows Checks n/m.
- After a human ticks in the drawer, the agent's write with the old revision gets a conflict and, after re-reading, keeps the human's ticks.
- After the agent submits a new commit, the old pass shows out of date in the drawer and on the card face.
- Delivering with open items: the first time `WORKPAD_OPEN`, after confirmation it enters In review and the card face shows "Delivered with n open".
- Phone compact layout: the card-face signal does not wrap or overflow, and the drawer checkboxes are tappable.
