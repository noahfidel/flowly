# Auto progress v1: facts → rules → status

> 2026-10-29: Committed ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §4) is treated like In review in A1/A1r: a new turn moves the card from Committed into Development, and when the turn has no board report, A1r restores it to Committed.
>
> 2026-10-29: Integrated ([INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md) §4) is treated like Committed: a new turn moves the card from Integrated into Development, and when the turn has no board report, A1r restores it to Integrated. No rule moves a card into Integrated.
>
> 2026-10-15 revision (global setting): auto-flow is also offered as a plugin setting: Ultra Kanban settings → Moving cards → "Auto-update status from sessions", host-level setting `auto-status` (`{ autoStatus: boolean }`), **on by default**; an unsaved or invalid stored value counts as on. When off, neither A1 nor A1r runs (turn lifecycle facts are still recorded, and the M1/M2 marks are not affected). When on, a project's `autoStatus=false` can still turn it off for that project alone (the project form switch is renamed "Auto-update status in this project"). So a rule is in effect = globally on AND not turned off for the project. If reading the setting fails, the default (on) applies.
>
> 2026-10-15 revision: In progress is split into Design / Development / Test ([WORKFLOW-STAGES-SPEC](WORKFLOW-STAGES-SPEC.md)). A1 no longer handles Backlog/Todo (the agent chooses the starting stage); continuing from In review goes into Development, continuing from Blocked returns to the previous work stage; "In progress" in A1r and M2 means any work stage. The table below keeps the original text as history.

Status: authorized by the user on 2026-10-15 ("You decide, you drive it" (translated)). Design basis: [AGENT-PROGRESS-DESIGN](AGENT-PROGRESS-DESIGN.md); the three open items follow the recommended options:
1. System rules may change status; on by default, can be turned off per project;
2. When a turn ends with no report, only a mark is set;
3. Answering a question uses the session input box directly.

## 1. Scope

- Only **board-managed sessions** are handled: created from a card's Start session, or explicitly sent board work instructions (see the PHASE-02 revision), and whose credential's bound workspace matches the card.
- Other sessions never record turn/authorization activity and never trigger rules. Previously activity was recorded for every session in a card's workspace, so ordinary chats in the main workspace left 84 unrelated turns on one card.
- Cards that are done (Done/Cancelled) or archived, and archived projects, are never changed by rules.

## 2. Rules

| Rule | Trigger | Condition | Action |
| --- | --- | --- | --- |
| **A1 Start / continue** | A board-managed session starts a turn (`agent.turn_started`) | The card is in Backlog, Todo, In review, Blocked; the project's `autoStatus` is not off | Status → In progress, task revision +1, activity `status_changed`, actor=system, `rule="A1"`, the note says which session started work |
| **A1r Restore** | A board-managed session's turn ends | This turn was pulled back from In review/Blocked by A1, the session made no board report in this turn, the turn did not fail, and no other status change followed | Restore the original status (`rule="A1r"`), so a single "thanks" does not make a delivered card look in progress again |
| A2 Delivery | The agent calls `flowly_update_status(in_review)` | Already exists | Unchanged |
| **M1 Question** | The agent calls `flowly_report_progress(kind="question")` | — | Status unchanged; the card shows "needs your answer" until that session starts its next turn (meaning you replied) or the agent reports again |
| **M2 Silent end** | A board-managed session's turn ends | The card is In progress; the session made no board report in that turn | Status unchanged; that session's Attention item is marked "No report" |
| M3 Error / authorization | Already exists | — | Unchanged |

Notes:
- A turn can only be triggered by a prompt: your message, a board instruction, or a Paseo scheduled task. So "a session starts a new turn" can stand for starting work or rework. If the agent then judges it is still blocked, it can set Blocked again.
- A1 is based only on explicit facts. It never sets a card to Done and never changes status just because a turn ended.

M1 and M2 are derived from the activity records by shared pure functions, used by the client and the tests:

```
openQuestion(agentId) = that agent's latest kind=question report is later than its latest turn_started, and it has no other report after it
silentTurn(agentId)   = the card is In progress, that agent's latest turn_ended is later than its latest turn_started, and it has no report between the two
```

The top of the card sidebar shows a prompt block for each unanswered question (the asking session, the question text, a Reply button that goes straight to that session's preview).

## 3. Data and compatibility

- Storage does not bump its version (still v3); only optional fields are added:
  - `project.autoStatus?: boolean`: missing counts as on;
  - `event.rule?: string`;
  - report kind gets `question`.
- Old data reads as is.
- `projects.update` accepts `autoStatus`. The project edit form gets a switch "Auto-update status from sessions".
- Skill addition: when there is a question the user must answer, use `kind=question` to state the question clearly and end the turn; after the user replies a new turn starts. Since 2026-10-20 (SESSION-QUESTION-SPEC §2.2): when the provider has its own question tool (AskUserQuestion etc.), use that first, and `kind=question` is the fallback; ask a given question in one way only, because answering in the tool does not start a new turn, and a `kind=question` for the same question would keep counting as an openQuestion.

## 4. UI

- Card signal row: shows "Needs you" (warning) when there is an unanswered question.
- Attention:
  - A new "question" reason, listed first alongside authorization and error;
  - A silent end is marked "no report" in the reason.
- Activity timeline: changes made by rules show an "Auto" label and the trigger note.

## 5. Acceptance

- Rule pure-function tests: A1 from each starting status, done/archived cards untouched, `autoStatus=false` untouched, non-board-managed sessions untouched; M1/M2 derivation.
- Hook integration test (fake SDK): activity is recorded only for board-managed sessions.
- typecheck, full test run; reload only this plugin; read-only render check with the web client.
