# Research: what openai/symphony suggests for Flowly

2026-10-19 · card "Research Symphony for inspiration" · source: https://github.com/openai/symphony (shallow clone of `main`: README, `SPEC.md` of 2312 lines, `elixir/WORKFLOW.md`, `.codex/skills/*`, the structure of the Elixir reference implementation)

## 1. What Symphony is

In one sentence: **"manage the work, not supervise the agent"**. A resident daemon polls an issue tracker (Linear / Jira / GitHub / GitLab / Asana), creates a separate workspace for every issue in an active state, and runs Codex unattended inside it (app-server protocol); the agent changes the tracker status itself, opens the PR, handles review and finally merges. A person only drags cards on the tracker: `Todo` starts the work, `Human Review` reviews, `Merging` tells it to go merge, `Rework` sends it back.

In form, it is first a **language-independent specification** (the README's "Option 1" is "have your coding agent implement one according to SPEC.md"), and Elixir is only the reference implementation. Explicit non-goals: a rich Web UI, multi-tenancy, a general workflow engine.

| Dimension | Symphony | Flowly |
| --- | --- | --- |
| Positioning | Unattended scheduler + tracker reader | A human-agent collaboration board, where the person assigns, decides and reviews |
| Card source | External tracker (Linear and others) | The plugin's own board |
| Who starts work | The orchestrator polls and dispatches automatically, with a concurrency cap | A person clicks Start session |
| State-driven | **A person changing the lane = giving the agent an instruction**; the agent routes behavior by the current status | The agent reports the stage, the lane is a progress display; Done is decided by a person |
| Agent stuck / asking | Treated as a failure by default (no asking a person), with only a "missing permission" escape hatch | First-class: question → Needs you → Reply |
| Progress record | A single in-place-updated **Workpad comment** (plan / acceptance / validation checklist) | Append-only progress notes + Haiku auto summary |
| Workflow policy | `WORKFLOW.md` in the repo (YAML + Liquid template), hot-reloaded | The skill text is hard-coded in the plugin; no project-level policy file |
| Reliability | Concurrency slots, retry backoff, stall detection, reconciliation, continuation turns | Relies on Paseo session status and attention |
| Observability | token / rate limit / TPS, JSON API, terminal dashboard | Insights, per-card tokens, the Attention dropdown |
| Wrap-up | Automatic workspace cleanup in the terminal state (before_remove hook) | A user-confirmed Wrap up, with preflight |

Conclusion first: Symphony's **automatic dispatch and unattended operation** are the opposite of Flowly's product positioning (a person manages multiple tasks, automatic dispatch is outside v1) and should not be copied; but several of its designs for "**making the agent's work checkable, resumable and policy-driven**" fit exactly where Flowly is weak, and most already have a first form in `ROADMAP-V2.md` M4/M5.

## 2. Symphony's distinctive points (designs worth noting)

### 2.1 WORKFLOW.md: the workflow policy in the repo
- YAML front matter (tracker, polling, workspace root, hooks, concurrency, Codex parameters) + a Markdown body as the **prompt template for every card**, Liquid syntax, with the variables `issue.*` and `attempt`.
- Strict rendering: an unknown variable/filter fails outright instead of silently being left empty.
- **Must hot-reload**; when the new config is invalid, keep the last-known-good and show a visible error, without crashing. In-progress sessions are unaffected, and it applies only to later dispatches.
- Benefit: the policy is versioned with the code and goes through review; a team can customize per repo.

### 2.2 "Status as instruction": routing agent behavior by lane
Referring to the Status map of WORKFLOW.md: each status has a clear meaning for the agent: `Todo` immediately moves to `In Progress` and then starts work; `Human Review` changes no code and only polls for feedback; `Merging` runs the `land` skill until merged; `Rework` is **redoing the whole approach** (close the old PR, delete the old workpad, open a new branch from `origin/main`) rather than a small fix; `Backlog` is left alone; a terminal state just exits. The person's only operating surface is dragging cards.

### 2.3 Workpad: a single, in-place-updated progress carrier
Each issue has only one `## Codex Workpad` comment, which the agent edits repeatedly instead of appending endlessly:
- an environment stamp at the top `<host>:<abs-path>@<short-sha>`;
- `Plan` (hierarchical checkboxes), `Acceptance Criteria`, `Validation` (concrete commands), `Notes` (with times), `Confusions` (places that felt vague during execution, for a person to improve the requirement text).
- Rules: align the workpad first when starting; update it after every milestone; a `Validation/Test Plan` in the card description must be moved verbatim into the checklist and must not be downgraded; "no completed items left unchecked".

### 2.4 Completion bar
Before entering `Human Review` it must: have the checklist all checked, validation all green against the latest commit, all PR feedback handled (changed or given a reasoned pushback), CI green, and the PR attached to the issue. In effect it writes the DoD as a hard constraint on the agent.

### 2.5 Orchestration reliability
- **Claim + concurrency slots**: a global `max_concurrent_agents` and per-status caps; sorted by priority → creation time → identifier.
- **Continuation**: after a turn ends normally, if the issue is still in an active state, the same thread continues with the next turn (capped by `max_turns`), and a continuation sends only a "continue" guidance, not the full prompt again; after a worker exits, check again after 1 second.
- **Retry backoff**: a failure retries at `min(10s·2^(n-1), 5min)`; the prompt tells the agent through `attempt` "this is attempt n, continue from the current workspace state, do not repeat investigation already done".
- **Stall detection**: when more than `stall_timeout_ms` (5 minutes) has passed since the last agent event, kill it and start over.
- **Reconciliation**: every tick refreshes the status of running issues; when a person moves a card out of active → stop the agent; moves it to a terminal state → stop and clean up the workspace.
- **Restart recovery with no database**: the tracker + file system are the state, and after a restart it just polls again.

### 2.6 Workspace lifecycle hooks
`after_create` (such as clone + install dependencies, creation fails if it fails), `before_run` (this run fails if it fails), `after_run`, `before_remove` (a failure is only logged), with a unified timeout. The agent can run only inside that issue's workspace, the path must be under the root and the name sanitized.

### 2.7 Tracker writes go through host-side tools, and credentials do not enter the child process
The agent changes the tracker through provider-native tools such as `linear_graphql`; the tool runs inside the Symphony process with the host credentials, and the related environment variables are removed from the child process environment. The tool spec is bound to the session snapshot, so a hot reload does not make an in-progress session switch provider. Flowly's signed request + scoped MCP is already the same idea, and stricter (CAS revision, idempotent receipts).

### 2.8 Proof of work
In the demo the agent attaches CI status, PR review feedback, complexity analysis and a **screen recording of operations** at delivery; the `land` skill loops through resolving conflicts, waiting for CI, fixing failures, and replying to review comments one by one (accept / clarify / push back, reply first and then change code).

### 2.9 Others
- Out-of-scope findings are **created directly as a Backlog issue by the agent**, with acceptance criteria and `related`/`blockedBy` links (Flowly's Ideas inbox is gated by a person, which is safer, and stays unchanged).
- Token counting details: use only the absolute cumulative value (`total_token_usage`) and take differences, ignore incremental events to prevent double counting; record rate-limit snapshots.
- `dispatchable` + `required_labels`: only a card carrying a given label is dispatched (a safety filter).
- An optional SSH worker pool (across hosts).

## 3. Points worth taking (ranked by value to Flowly)

### P1 Card Workpad: a structured, in-place-updated plan / acceptance / validation checklist
**Current gap**: a progress note is an appended stream, and a Haiku summary is an after-the-fact recap; when a person reviews a card they cannot see "what was planned, what the acceptance criteria are, which validations ran and which did not". Records such as "UNRUN" in PROGRESS.md currently rely entirely on the agent writing them into text voluntarily.

**Approach**: the card gains an agent-writable `workpad` (Plan / Acceptance / Validation / Notes / Confusions, with stateful checkboxes), a `flowly_update_workpad` tool that replaces it as a whole (CAS protected), the card shows `Validation 3/5`, and it can be read and ticked in the drawer. If the card description has a "Validation/Test plan" section, the skill requires moving it in verbatim. The environment stamp `host:path@sha` lets a person see at a glance on which commit it was validated. `Confusions` is interesting: it is feedback on how the requirement is written, and can be rolled up into Insights.

### P2 Delivery gate (soft completion bar)
On top of P1, when `flowly_update_status(in_review)` still has unchecked acceptance/validation items, do not reject, but require a note to explain, and mark the card "2 items open at delivery". This is consistent with the AGENTS.md rule "record completed / failed / unrun separately", turned into a product capability.

### P3 Project Playbook (a WORKFLOW.md-style policy file)
**Current state**: the skill text is the same for all projects; project-specific rules (for example the onboarding upkeep and Luna test requirements in this repo's AGENTS.md) can only rely on the repo's own AGENTS.md.
**Approach** (matching ROADMAP M4 "project playbook"): an optional `.flowly/WORKFLOW.md` (or in project settings), containing:
- The initial prompt template for Start session, with the variables `card.title/description/type/tags/artifacts/links`;
- **Per-lane instructions** (what to do on entering Test, the delivery format of In review, the DoD, the validation commands), where `flowly_get_task` returns the section for the current lane, instead of a prefix on every message (keeping the constraint "an ordinary follow-up sends only the user's own text");
- The default provider/model/mode.
- Strict templates + hot reload + last-known-good + visible errors, copying Symphony's semantics.

### P4 Stall / silent-end detection
(Matching ROADMAP M5 watchdog, M3 "silent end")
- A running session with no event for more than N minutes → "may be stuck" appears in Attention;
- When a turn ends with the card still in Development/Test and this turn neither asked a question nor delivered → mark "silent end", with a **Nudge** button (one click sends a configurable continuation guidance: "continue from the current workspace state, do not repeat work already done").
- Whether to continue automatically (Symphony's continuation, capped by `max_turns`) is a project-level switch, off by default, because it is a message initiated by the plugin and needs the user's explicit authorization.

### P5 Two meanings of Rework
Symphony makes sending back explicitly "redo the whole approach". In Flowly, In review → the user replies → automatically back to Development, which is like an "incremental change". A **Rework from scratch** button could be added on an In review card: open a new session, carrying the original card context + the user's reason for sending it back + the Confusions of the last round's workpad, and keep the old session.

### P6 Delivery evidence (Proof of work)
Artifacts already has input/output. An `evidence` subtype (screenshots, screen recordings, test output, CI links) could be added, with thumbnails shown directly on In review cards; together with M4's Git delivery info (branch, diff stat, PR link, CI status).

### P7 Workspace hooks
After Flowly creates a worktree, the new worktree often needs preparation such as `npm install`. If Paseo's workspace scripts already cover it, only a reference in the playbook is needed; otherwise `after_create` / `before_remove` can be added to the playbook (argument-array subprocess, timeout, failure semantics the same as Symphony).

### Long term / not recommended now
- **An automatic dispatch queue** (Todo starts automatically by priority, global / per-lane concurrency caps, `required_labels` filtering): Symphony's core, but AGENTS.md explicitly says "automatic assignment is outside v1", and ROADMAP M5 has recorded it. If done in the future, its claim / ordering / backoff / reconciliation algorithms can be borrowed directly (SPEC §8, §16).
- **A person changing the lane automatically stops the session** (reconciliation): in Flowly a person may just be tidying the board, and an automatic stop would hurt; at most, "when moved to Cancelled, ask whether to stop the running session".
- An agent creating cards itself: keep Ideas gated by a person.
- An SSH worker pool, external tracker sync: these belong to M6.

## 3.1 Follow-up: "a person changes status → the agent automatically does the next step" (Merging → merge → Done)

### How Symphony does it
Taken apart it is four things stacked together, with no dedicated "trigger":
1. **Polling + reconciliation**: the orchestrator looks at card status every 5 seconds; `Merging` is in `active_states`, so a card dragged to Merging is dispatched (or the running worker sees the new status on its next round).
2. **State routing written in the prompt**: the Status map of WORKFLOW.md says "Merging → open and run the `land` skill". The agent's first step each round is to read the current status and then pick the flow, so the status itself is the instruction.
3. **The flow written as a skill**: `land` = full local checks → resolve conflicts → wait for CI → fix CI → reply to review comments one by one → squash merge; "do not yield before merging".
4. **The agent has the right to change a terminal state**: after a successful merge the agent itself changes the card to Done; Done is a terminal state, and the orchestrator then stops the worker and cleans up the workspace.

The person's drag = one authorization ("I have reviewed it, go merge"); everything after is the agent's job, with the result reported back by Done.

### Flowly's current state
- There is already a precedent: **a person moving a card to Done/Cancelled triggers wrap-up** (asking or automatic Wrap up, with preflight). The mechanism and user mental model "moving a card = triggering an action" already exist, only the action is done by the daemon, not the agent.
- Lanes are fixed built-in statuses (renamable / switchable / reorderable), with no Merging.
- Constraints: an ordinary follow-up sends only the user's own text; Done/Cancelled is decided by a person; PR automation is outside v1.

### A design to borrow: Lane actions
**Core**: a project can configure "entry actions" for some lanes. When a person moves a card into that lane, the daemon sends that lane's instructions to the card's session, and after the agent does it as instructed it moves the card to the agreed next column. The drag itself is the person's explicit instruction, in the same class as "Send Kanban work instructions", an explicit action and not an ordinary follow-up.

The most valuable chain: **In review → (person drags) Merging → the agent merges → Done → automatic Wrap up**. Most Flowly cards are worktrees, and Merging does not have to be a PR:
- Local mode (does not involve PR automation, the best one to do first): rebase/merge the worktree branch into the main branch, run the project's validation command (such as `npm run typecheck && npm test`), fast-forward the main branch, record the commit SHA as an output artifact, and then set Done. Done then triggers the existing Auto wrap up to archive the worktree, so both ends of the whole chain are ready-made.
- Remote mode (needs lifting "PR automation is outside v1"): push + `gh`/`glab` to open or merge the PR, wait for CI, handle review, similar to the `land` skill.

Other configurable lane actions (all optional, off by default):
| The person's move | The instructions the agent receives | After completing, the agent moves to |
| --- | --- | --- |
| In review → **Merging** (a new built-in lane, off by default) | Merge by the project's merge flow, fix it if validation fails, ask a question if it cannot be fixed | Done (needs authorization, see below) |
| In review → Development (sent back) | Read the user's latest feedback / card comments, and rework | In review |
| Development → **Test** | Run the full validation by the playbook's validation checklist, add tests | In review |
| Todo → Design/Development (when the card has no session) | Create a new session with the default provider/model and start work with the card context | Flows by the normal stages |
| Any → Cancelled (with a running session) | Not sent to the agent; ask whether to stop the running turn | — |

### Details to copy from Symphony
- **Put the instructions in the "lane instructions", and keep the trigger message short**: the trigger message says only "the user moved the card to Merging, please execute per that lane's instructions"; the detailed flow is returned by `flowly_get_task` as the current lane's instructions (from the project Playbook), or written as a skill (such as `land`). This way changing the flow needs no code change, and old sessions can read the latest version too.
- **Trigger only once per entry**: use the status-change event ID as the idempotency key, so a daemon restart, repeated rendering or dragging back and forth never sends twice; moving out and in again counts as a new one.
- **Queue when the session is busy**: when the session is running a turn, wait until it ends before sending; or tell the user "the current session is busy: send after it ends / send now / cancel".
- **Pick the target when there are several sessions**: send to the most recently active session by default, and when there is no session create one by the default settings; state the target in the toast, with a brief "undo".
- **Reconciliation**: when a person moves the card out of that lane while the action is running → ask whether to stop the running turn (Symphony just stops, Flowly should ask).
- **Do not yield until done**: the instructions require the agent to loop "merge → validate → fix" until it succeeds; only when truly stuck should it use a question to enter Needs you, instead of ending silently.

### Boundaries the user needs to decide (where this conflicts with existing constraints)
1. **Can the agent move a card to Done**: now Done can be decided only by a person. The suggestion is to make it a **restricted authorization**: only when the card was dragged into Merging by a person (a lane action that carries "may set Done when finished") may the agent set Done, and it must attach evidence (an output artifact of the merged commit SHA or the merged PR link); the activity notes "based on the Merging authorization". Otherwise the agent can only go back to In review and explain.
2. **Whether to add a built-in Merging lane** (off by default, appearing between In review and Done once turned on), or to allow renaming an existing lane and attaching the action to it.
3. **Local merge vs PR**: do the local merge first (not touching v1's PR automation boundary), and PR mode gets a separate card.
4. AGENTS.md needs a new "Exception, user-requested: lane actions" to describe this kind of plugin-initiated message.

## 4. What does not need learning (Flowly is already better)
- Human in the loop: Symphony treats "user input required" as a failure; Flowly's question → Needs you → Reply is a design better suited to personal multitasking.
- Write safety: Flowly's CAS revision, signed request, idempotent receipts and scope limits are more rigorous than Symphony's "the agent gets full GraphQL permission".
- Multi-platform UI, i18n, Insights: Symphony explicitly does not do a rich UI.

## 5. One-sentence summary
Symphony writes "how an agent should work" as a **versionable policy (WORKFLOW.md) + a checkable work sheet (Workpad) + a runtime with a safety net (continuation / stall / retry)**. Flowly already has a better human-agent interaction surface, and the next things most worth adding are the first two of these three: **Workpad + delivery gate** and **project Playbook**, followed by **stall / silent-end detection**.
