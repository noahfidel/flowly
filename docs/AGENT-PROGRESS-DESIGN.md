# Agent-managed progress: research and v1 proposal

Status: design draft, 2026-10-15, to be confirmed by the user before an implementation spec is written. Replaces the "everything depends on the agent calling tools" idea in [PHASE-03-SPEC](PHASE-03-SPEC.md); that spec's workflow, stage and approval design is kept as a long-term extension of this proposal.

## 1. Current problem

Today a card's status changes only when the agent **actively calls** `flowly_update_status`. Measured:
- F1–F4, which were explicitly told to report, each went correctly through Todo → In progress → In review.
- A session with no tool connected or no instructions showed zero status change in 84 turns.

"Relying on the agent's discipline" is unstable. More importantly, the system already knows many facts: a session starts a turn, ends a turn, fails, waits for approval, or you send another message. None of this is used to advance the card.

## 2. How other products do it

| Product | Source of status | What the agent must do | Human step |
| --- | --- | --- | --- |
| **Vibe Kanban** | Mostly driven by the **execution lifecycle** (third-party sources): dragging a card to In Progress creates a worktree and starts the agent; when the agent finishes the card moves to In Review; asking for changes moves it back to In Progress. The newer version uses workspace status, including "Needs Attention: agent finished or needs input" | Almost nothing | Look at the diff, give feedback, open a PR, merge |
| **GitHub Copilot coding agent** | **PR status**: after an issue is assigned it opens a PR and asks you to review when done | Request review when done | Comment on the PR to make it iterate |
| **Linear agents** | Two layers: the **session status** (pending/active/awaitingInput/error/complete/stale) is **derived automatically** by Linear from the agent's last activity; the **issue status** is moved by the agent to the first started status at the start | Emit activities: thought / action / elicitation (needs input) / response (done) / error; an optional plan checklist (pending/inProgress/completed/canceled, replaced as a whole) | Reply to an elicitation; accept |
| **Multica** | The agent changes the issue status through a CLI; finishing a run does not change the status; on failure with no retry, in_progress falls back to todo; a merged PR can set Done automatically | Change the status and comment as instructed | A comment triggers a new round; a human sets Done |
| **Backlog.md** | A task is a Markdown file in the repo; the agent claims it and changes its status through the CLI/MCP | Follow the acceptance criteria and the Definition of Done | Three checkpoints: review the spec, the plan and the code |

Common patterns:
1. **Lifecycle facts are derived by the system** (Vibe Kanban, Linear's session status); they do not depend on the agent remembering to report.
2. **The agent reports only the meaning the system cannot derive**: I need input, I am done, what my plan is (Linear's elicitation/response/plan, Copilot's request review).
3. **A human message is itself a status signal**: asking for changes → back to in progress (Vibe Kanban, Copilot, Multica).
4. **Done is left to a human or an external fact** (a merged PR).

## 3. Proposal: facts → rules → status

```
Signal (fact)                    Rules (project-level, switchable)  Result
─────────────────               ──────────────────────────────     ─────────────
session lifecycle hook ──┐
  turn start/end/failure  │
  approval request/handled ├──▶  small rule table (in daemon) ──▶  card status change (with reason)
agent report (tool)       │      trigger + condition + action      card marker (needs you/silent/error)
  progress/question/result│                                        activity record (traceable)
human action              │
  message/drag/accept   ──┘
```

### 3.1 Signals

- **Session lifecycle**: the existing `agent.turn_started`, `agent.turn_ended` (with outcome), plus `agent.permission_requested/resolved` and `agent.archived`. Only **board-managed sessions** count (see the PHASE-02 amendment).
- **Agent report**: keep the existing tools; the `kind` of `flowly_report_progress` gains `question` (needs your answer). `result` means "I believe it is delivered". No new tool; the agent only needs to remember two words: report `question` when it has a question, `result` when done.
- **Human action**: sending a message to a board-managed session from a card or session, dragging, accepting.

### 3.2 v1 default rules

| # | Trigger | Condition | Action |
| --- | --- | --- | --- |
| R1 | A board-managed session starts a turn | Card is in Backlog/Todo | → **In progress** (matches Linear's "first started status" and Vibe's drag-to-start) |
| R2 | Agent reports `result` or sets in_review | Card is not finished | → **In review** (existing) |
| R3 | A board-managed session ends a turn | Card is In progress; no report this turn; no other running session on the same card | Mark the card **"Look at me"** and put it in Attention; **do not change the status** |
| R4 | Agent reports `question` | — | Mark the card **"Needs your answer"** and put it in Attention; do not change the status (D2) |
| R5 | Turn fails / waiting for approval | — | Mark the card as error / waiting for approval (existing) |
| R6 | A human sends a message to the card's board-managed session | Card is In review or Blocked | → **In progress** ("asking for changes returns to in progress"); clear the "Needs your answer" marker |
| R7 | Done / Cancelled | — | Set only by a human (a "PR merged" signal may be added later) |

How the rules relate to existing constraints:
- Business status changes come from **explicit facts**, not from "a turn ended = done". R3 only sets a marker and does not change the status, so a turn ending still never completes a card automatically.
- R1 and R6 change the status from the system, which requires amending the AGENTS.md item "business status and execution status are independent" to: "derived by project rules from explicit facts, switchable per project, with the trigger reason recorded on every change".

### 3.3 Why it is lighter and more effective

- **It gets most of it right even if the agent reports nothing**: starting work (R1), waiting for you (R3) and sending it back to continue (R6) are all derived by the system, which covers the "zero change in 84 turns" case.
- **The agent needs only a minimal protocol**: two kinds of report (question / result); the skill can shrink to a few lines.
- **Every status change carries a reason**: the activity shows "by R1: session X started working", so a person can understand it and undo it (just drag it back).
- **No new storage**: the rules run in the daemon's hooks and reuse the existing serialized writes, CAS and activity records.

### 3.4 Extension path (not in v1)

The trigger/condition/action of the rule table are enumerable types, so later extensions only add types:

| Extension | What to add |
| --- | --- |
| Configurable workflow / stages (PHASE-03 D1) | condition supports stage; action supports set_stage; project-level editing UI |
| Plan checklist (Linear plan) | New signal `plan_updated`, the card shows a progress bar |
| PR merged → Done | New signal `pr_merged` (poll gh/glab) |
| Turn end goes straight to Review (Vibe mode) | Change R3's action to → In review, as a project option |
| Auto-start queue | New trigger: card enters Todo → start a session |
| Failure retry / stuck detection | New triggers: timeout, failure count |

## 4. To confirm

1. Do you accept R1 and R6 changing the status from the system (requires amending AGENTS.md), on by default and switchable per project?
2. When a turn ends with no report (R3), should v1 only set the "Look at me" marker (recommended), or go straight to In review like Vibe Kanban?
3. How to answer the `question` marker: should v1 reuse the session input box directly (replying clears the marker, recommended), or build a dedicated answer area (the PHASE-03 proposal)?

## References

- Vibe Kanban (the status flow is from third-party sources; the official README is marked sunsetting): https://github.com/BloopAI/vibe-kanban , https://vibekanban.com/docs/core-features/monitoring-task-execution
- Linear agents: https://linear.app/developers/agent-interaction , https://linear.app/developers/agent-best-practices
- GitHub Copilot coding agent: https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-copilot-to-work-on-an-issue
- Backlog.md: https://cdn.jsdelivr.net/gh/MrLesk/Backlog.md@main/README.md
- Multica: local source research (commit 52b2690), see the conversation record
