# Phase 3 (M3): configurable workflow and the human-agent loop

Status: **deferred** (2026-10-14, the user adjusted priorities: the current focus is manual multi-task management, and agents adjusting status automatically is a long-term goal). This document is kept as a long-term design and must be reconfirmed before implementation.
Upstream: [ROADMAP-V2](ROADMAP-V2.md) M3, with the user-confirmed decisions D1–D6:
- D1: the workflow is configurable, with a built-in default that users may customize.
- D2: when a human must answer, the business status does not change; only a marker appears on the card.
- D3: the design gate is off by default and can be turned on per stage.
- D4: the wrap-up archive policy belongs to M4 and is not implemented in this phase.
- D5: work continues automatically after a reply or a send-back.
- D6: the inbox includes session signals.

All conventions of Phase 1/2, single-root and UI refresh are inherited unless this document amends them explicitly.

## 1. Goal

The agent advances through stages in the card workspace following the project workflow, and leaves a marker on the card when a human is needed. The human answers, approves or accepts on the card, in the inbox or on the native session's chip, and the reply is automatically sent back to the originating session so the agent keeps working. The card's business status changes only by agent tool calls or human actions; session events only produce hints.

Not in this phase: one-click start and the playbook default agent (M4), automatic attachment of sessions created from the native entry (M4), wrap-up and archiving after Done (M4), Git info (M4), auto-start and retries (M5), custom board columns (candidate).

## 2. Workflow model

### 2.1 Definition

A workflow is an ordered set of stages that advance only while the business status is In progress. The board's 7 business columns stay unchanged: agent permissions, the Finished filter and later wrap-up all depend on them. Custom columns are evaluated separately.

| Field | Constraint | Notes |
| --- | --- | --- |
| `id` | A stable slug generated at creation, 1–40 characters, unique within the project | Cards reference it; renaming does not change the id |
| `name` | 1–40 characters after trim, unique within the project (case-insensitive) | Shown on the card and in tools |
| `instructions` | ≤ 4000 characters | What to do in this stage; sent to the agent with `get_task` |
| `exitCriteria` | ≤ 2000 characters | Conditions to satisfy before moving to the next stage |
| `gate` | `none` or `human` | `human`: a human must approve before leaving this stage for the next one |

A workflow has 1–8 stages, plus `revision` (a positive integer) and `updatedAt`.

The built-in default workflow:

| id | name | gate | Key points |
| --- | --- | --- | --- |
| `design` | Design | none | Understand the requirement, read the relevant code, write the plan, trade-offs and verification plan, and report the plan with progress |
| `develop` | Develop | none | Implement per the plan, keep the change scope; report first when deviating from the plan |
| `verify` | Verify | none | Run verification (typecheck, tests, real use), and record passes, failures and items not run; on failure go back to Develop |

### 2.2 Scope and editing

- Each project has its own workflow. A project without a custom one uses the "new-project default workflow": initially the built-in default, and the user may set any project's workflow as the new-project default. Creating a project copies the current default.
- Entry: project picker dialog → "Workflow". The edit dialog supports adding, deleting, renaming, moving up/down, editing instructions/exitCriteria, switching the gate, plus "Restore built-in default" and "Set as new-project default".
- On save, CAS is applied to the project workflow `revision`; a conflict returns `REVISION_CONFLICT` and the draft is kept.
- Deleting a stage that is still referenced by non-archived, unfinished cards is rejected (`STAGE_IN_USE`) and those cards are listed. Renaming, reordering and changing a gate take effect immediately.
- Modifying the workflow increases the project workflow revision and **does not increase** `project.revision`, so an agent's ordinary writes do not conflict because of a workflow edit. The agent gets the new definition the next time it reads.
- An archived project is read-only. Legacy multi-repo cards also use the workflow.

### 2.3 Stage of a card

- `task.stage`: a stage id or null.
- When a card enters In progress and its stage is null, it is set to the first stage automatically, in the same commit and the same activity record.
- When a card leaves In progress (Review, Blocked, Done, etc.) the stage is kept, shown as "which stage it stopped at". When it returns to In progress it continues that stage.
- A human can change the stage at any time in the sidebar: any non-archived, unfinished card, not bound by gates (the human is the approver). This increases the task revision.
- If the stage points to a stage that no longer exists (for example an edit bypassed by concurrency, or imported old data), it is shown as "Unknown stage", and when the agent reads it `stageValid=false`. The agent or a human setting a valid stage recovers it.

### 2.4 The agent switches stages

`flowly_set_stage(stage, note)`:

- Available only when the status is In progress, otherwise it returns `STAGE_NOT_ACTIVE`. The target must be a stage of the current workflow, otherwise it returns `STAGE_UNKNOWN`.
- Moving backward or to the same stage (only an activity is recorded) is always allowed.
- Moving forward: if between the current stage and the target (including the current stage, excluding the target) there is a stage with `gate=human`, the stage is not moved and an `approval` request is created (section 3). It returns `{ pendingApproval: requestId }`, and the result is marked accepted-not-applied. When the card already has an open approval for the same from→to, that request is returned directly and not created again.
- A successful move increases the task revision and records a `stage_changed` activity (from/to stage id and name, note, agentId).

## 3. Requests ("Needs you" marker)

### 3.1 Kinds

| kind | Source | Human action | Result |
| --- | --- | --- | --- |
| `question` | agent `flowly_request_human` | Pick an option or write an answer | The answer goes back to the originating session |
| `approval` | Stage gate (2.4) | Approve or Reject (Reject needs a comment) | Approve: the stage advances and the session is notified; Reject: the stage stays and the comment goes back |

A request **does not change the business status and does not increase the task revision**, only the board revision, and records an activity. So a card can stay In progress while showing "Needs you". The agent may keep working on other parts or wait; the skill requires it to say in the note whether it will wait.

### 3.2 Data

`board.requests[]`:

| Field | Notes |
| --- | --- |
| `id` | `req_` plus a random string, shown with a short number |
| `taskId` / `agentId` | The owning card and the originating session (for an approval, the session that triggered the gate) |
| `kind` | `question` or `approval` |
| `question` | 1–4000 characters after trim; for an approval generated by the system, such as "Approve moving from Design to Develop" |
| `options` | 0–6, each 1–200 characters, no duplicates; used only by question |
| `stageFrom` / `stageTo` | Used only by approval |
| `createdAt` | Creation time |
| `state` | `open`, `answered`, `approved`, `rejected`, `withdrawn`, `dismissed` |
| `answer` / `closedAt` / `closedBy` | `closedBy` is `human` or an agentId |
| `delivery` | `{ state: pending/sent/failed/unknown, at, error, agentId }`; produced only when a human closes the request |

Constraints: at most 10 open requests per card, beyond which `REQUEST_LIMIT` is returned; a closed request cannot be closed again (`REQUEST_CLOSED`). Each card keeps all open requests and the latest 50 closed requests; closed requests that were cleaned up can still be traced from the activity records.

### 3.3 Ways to close

- **A human answers or approves**: RPC `requests.resolve({ id, action: answer/approve/reject/dismiss, answer?, operationId })`.
  - `answer`: must be the exact text of an option, or a free answer of 1–10000 characters.
  - `reject`: must carry a comment.
  - `dismiss`: means "no longer needed", not delivered.
  - Replaying the same `operationId` returns the first result.
- **The agent withdraws**: `flowly_withdraw_request(requestId, note)`, which can withdraw only an open question it raised itself. Approvals are handled by a human; an agent withdrawing an approval returns `INVALID_REQUEST`, not `REQUEST_CLOSED`.
- **The card is archived or enters Done/Cancelled**: the remaining open requests automatically become `dismissed` (closedBy=system), not delivered.

### 3.4 Delivery (D5 automatic continuation)

After closing, the daemon delivers, without depending on the client being online:

1. First commit the close result in the store, with `delivery.state=pending`.
2. Refresh the target session with the SDK; it must still belong to this card's workspace and not be archived. When the session is running, send with `activeTurnBehavior: "steer"`; when idle, send directly.
3. Write back `sent` or `failed` (with the error) by the result.

The delivered content is an explicit Kanban message with a marker, distinct from the rule "an ordinary follow-up is sent as it is":

```
[Ultra Kanban] Reply to request R-1a2b on "<card title>"
Question: <question>
Answer: <answer>
```

The approval message is `Stage gate approved: Design → Develop. Continue with Develop.` or `Stage gate rejected (stay in Design): <comment>`.

Failure and recovery:
- When delivery fails the request is still closed, the card shows "not delivered", and offers "Retry" or "Redirect to another session". Redirecting can only choose a session within the same card workspace.
- When the daemon restarts in the pending state, it marks the state `unknown` and does not resend automatically to avoid duplicates; a human decides whether to resend.
- Resending needs an explicit action and records a new delivery activity.

## 4. Review and acceptance

### 4.1 The agent submits

`flowly_submit_review(summary, verification, notRun?, links?)`:

| Field | Constraint |
| --- | --- |
| `summary` | 1–6000 characters |
| `verification` | 1–6000 characters |
| `notRun` | 0–4000 characters |
| `links` | ≤ 10, each 1–500 characters |

- Submittable only from In progress or Blocked, otherwise it returns `INVALID_STATUS`.
- Done in one submission: the status changes to In review, `task.review` is written (id, agentId, submittedAt, the fields above, verdict=null), the task revision increases, and a `review_submitted` activity is recorded.
- The old `flowly_update_status(in_review, note)` stays usable and is treated as a delivery with only a summary.

### 4.2 Human acceptance

RPC `tasks.review({ id, revision, verdict, comment?, operationId })`, requiring the card to be In review now:

- **Approve**: the status changes to Done, `review.verdict=approved`. M3 does no resource wrap-up.
- **Request changes**: must carry a comment. The status changes back to In progress, the stage is unchanged, `review.verdict=changes`, and the comment is delivered to `review.agentId` as in 3.4: `[Ultra Kanban] Changes requested on "<title>": <comment>`. When that session is unavailable, a list of sessions in the same card is shown for redirecting. After receiving it, the agent decides on its own which stage to return to.
- A human changing the status directly by drag or the status menu is still allowed. If the card has an undecided review, it is recorded as `verdict=bypassed` and not delivered.

## 5. Session signals (D6)

Signals come from hooks and the SDK, are hints only, and do not change the business status. On the card, in the inbox and in the sidebar they are shown grouped separately from requests.

| Signal | Judgment | Cleared |
| --- | --- | --- |
| Waiting for approval | The session has a pending permission, reusing the existing judgment | The approval is handled |
| Turn failed | The outcome of `agent.turn_ended` is failed (the outcome and error message are recorded, truncated to 500 characters) | That session's next turn starts, or a human marks that session as read |
| Silent ending | While the card is In progress, a session's turn ends and between the start and the end of that turn there is no board tool write from that session | That session writes with a tool afterwards, or a human marks it read |

The `agent.turn_ended` activity gets an optional field `outcome` (completed/failed/canceled). Signals are computed by shared pure functions from the activity, session snapshots and read receipts, so the client and daemon agree, and they are tested separately.

## 6. Agent tools and CLI

All new tools reuse Phase 2's identity binding, session/workspace validation, request ID and issuedAt, idempotent receipts and error format.

| Tool | Input | Status / revision |
| --- | --- | --- |
| `flowly_get_task` | Unchanged | New returned fields:<br>• `workflow`: the stage array and revision<br>• `stage` / `stageValid`, `nextStage`, `gateBeforeNext`<br>• `requests`: this card's open requests, plus the latest 10 closed requests and their answers<br>• `review` |
| `flowly_set_stage` | expectedRevision, request, `stage`, note | A move increases the task revision; at a gate it only creates a request |
| `flowly_request_human` | expectedRevision, request, `question`, `options?`, note | Does not change the status, does not increase the task revision |
| `flowly_withdraw_request` | expectedRevision, request, `requestId`, note | Does not change the status, does not increase the task revision |
| `flowly_submit_review` | expectedRevision, request, the fields in 4.1 | The status changes to In review, the task revision increases |
| `flowly_update_status` / `flowly_report_progress` | Unchanged | Unchanged; the first stage is filled in automatically on entering In progress (2.3) |

- `request_human` and `withdraw_request` also validate the task/project revision at read time (consistent with progress), to avoid asking a question from stale context.
- The CLI subcommands correspond one to one: `stage <id>`, `ask --question … [--option …]`, `withdraw <requestId>`, `review --summary … --verification … [--not-run …] [--link …]`, sharing the same service as MCP.
- New error codes: `STAGE_UNKNOWN`, `STAGE_NOT_ACTIVE`, `REQUEST_LIMIT`, `REQUEST_NOT_FOUND`, `REQUEST_CLOSED`, `INVALID_REQUEST`, `WORKFLOW_INVALID`, `STAGE_IN_USE`. The rest are reused.

Skill additions:
- Before each stage starts, read `get_task`, work according to the stage's instructions and exitCriteria, and after the conditions are met `set_stage` to the next stage.
- On pendingApproval, after reporting a summary of the plan, wait for the human's message.
- Cases where a human must be asked: irreversible or high-risk operations, design trade-offs, missing information or permissions, requirements beyond the card's scope. The question must be specific, give options where possible, and say whether it is waiting or continuing on other parts.
- Withdraw the request when the question has been solved on its own.
- Deliver with `submit_review`, stating the changes, the verification, the items not run and the remaining issues.
- When a message with the `[Ultra Kanban]` marker is received, continue working according to its content.

## 7. Human-side UI

| Place | Presentation |
| --- | --- |
| Card | The signal row adds:<br>• a stage label "Develop · 2/3" (In progress, and Review/Blocked cards that stopped at a stage)<br>• "Needs you n" (warning color, the number of open requests)<br>• "To verify" (accent) when In review with a pending delivery<br>• session signals reuse the existing color dots: approval, error, silent<br>Accessibility labels are synchronized. |
| Sidebar header | The properties row adds a Stage label, which opens a stage menu (showing the gate icon), alongside Status and Priority |
| Sidebar "Needs you" block | Fixed before the description, shown only when there is content:<br>• each open question: the question, option buttons, an answer input with Send, and Dismiss<br>• approval: from→to, Approve / Reject (needs a comment)<br>• a pending-acceptance delivery: summary, verification, notRun, links, and Approve / Request changes (needs a comment)<br>• delivery state: sent, failed (retry/redirect), unknown (resend)<br>• session signals: clicking opens the corresponding session preview |
| Inbox | The toolbar Inbox button has a total count badge. The dialog has four groups: Questions, Approvals, To verify, Session signals; each item shows the card title, project, summary and time. Clicking switches to that project and opens the card sidebar (a signal item opens the session preview directly). Across all non-archived projects, shared by desktop and phone |
| Native session chip | When that session has open requests it raised itself, the chip label becomes "Task · Needs you" and the behavior becomes a popover, with the content being that session's requests, which can be answered or approved directly. If the plugin RPC cannot be called inside the host popover, fall back to an action that opens the card sidebar and locates the Needs you block; do a capability check first when implementing |
| Workflow editing | See 2.2, using the existing Field, Choices and Row components; a full-screen modal on phones |
| Activity timeline | New texts: stage change, question, answer, approve/reject, withdraw, submit for acceptance, acceptance verdict, delivery result |

A successful operation uses a native toast, and a failure is shown inside the relevant block as an error with a recovery action. All new modals follow the Theme.Provider rule, and motion follows MOTION-SPEC.

## 8. Data migration and compatibility

- Storage v3 → v4:
  - `board.requests=[]`
  - `board.settings={ defaultWorkflow: built-in default }`
  - a missing `project.workflow` is treated as a copy of the current default and written on first edit
  - cards already In progress get the first stage filled in per 2.3 when first read or written (a read does not write to disk; it is filled in on the next write)
  - `task.stage=null`, `task.review=null`
- Invalid data keeps the strategy "keep the file, report an error, do not reset".
- New RPCs `workflow.update`, `workflow.setDefault`, `requests.resolve`, `requests.redeliver`, `tasks.review`, all using schema validation and CAS. `board.read` returns requests and settings.
- The tool `toolVersion` goes to 2. A v1 CLI context file in an old session is still usable for the original three operations, and calling a new operation prompts to resend the Kanban work instructions.

## 9. AGENTS.md constraints that need to change in sync

After implementation is approved, add to Product invariants:

- Replies, approve/reject and acceptance send-backs are explicit Kanban deliveries, carry the `[Ultra Kanban]` marker and are sent only to the relevant session; an ordinary follow-up is still sent as it is.
- Requests and session signals do not change the business status. The business status changes only by agent tools (In progress, Blocked, In review) and human actions.

"Automatic assignment…outside v1" is unchanged in M3. D4's archive amendment changes in M4.

## 10. Acceptance

After implementation: typecheck first, then the focused tests and the full `npm test`, then reload only this plugin; finally do an independent acceptance with a full-access `codex/gpt-6-luna` session. Test resources are registered beforehand and cleaned up at the end, and the evidence is saved to `docs/verification/phase-03.md`. PASS, FAIL and UNRUN are recorded separately.

| Scenario | Expected |
| --- | --- |
| Default workflow | A new project comes with Design/Develop/Verify; a card entering In progress is automatically in Design |
| Custom workflow | After add/delete/rename/reorder the cards and tools reflect it immediately; deleting a stage in use is rejected and the cards are listed; a CAS conflict keeps the draft; setting as the new-project default takes effect |
| Stage advance | The agent calls set_stage in turn; rejected when not In progress; an unknown stage is rejected; a human can change the stage freely |
| gate | With a gate on, an agent advance only produces an approval; repeated calls do not create duplicate requests; after Approve the stage advances and a message is received; after Reject with a comment the stage stays and a message is received |
| Question | Status and task revision unchanged, the card shows Needs you, the inbox has the item; an option or free answer is delivered to both a running (steer) and an idle session; repeated resolve is idempotent |
| Withdraw, dismiss, limit | The agent withdraws its own question; a human dismiss is not delivered; the 11th open request is rejected; after Done or archive the remaining requests are automatically dismissed |
| Delivery failure | After the session is archived the answer shows failed and can be redirected; a restart while pending becomes unknown and is not resent automatically |
| Review | submit_review enters In review and shows the deliverable; Approve → Done with no resource change; Request changes → In progress and the comment is delivered; a direct drag records bypassed |
| Signals | Approval, failed turn and silent ending appear and clear correctly and do not change the business status |
| Multi-session | Two sessions calling set_stage concurrently, only one succeeds and the other gets REVISION_CONFLICT; each one's questions are delivered back to its own session |
| Migration | After a v3 file is upgraded the existing cards, activities and receipts are kept; an invalid file stays as it is and an error is reported |
| UI | The card markers, sidebar Needs you, inbox and workflow editor work on desktop, phone and light/dark; the chip's popover or fallback behavior matches section 7 |
| Cleanup | The projects, workspaces, sessions, cards and temporary directories created by the test are all removed in both the native registry and the board |

UI actions may target only an identified non-fullscreen Paseo window. When it cannot be bound, record UNRUN; the web client and component-level evidence may supplement it, but it must be stated that this is not equivalent to native verification.
