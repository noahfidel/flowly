# Project guardrails: the learn, prevent, check, view loop (GUARDRAILS-SPEC)

Status: **design, approved by the user on 2026-10-28, awaiting implementation**. Card `2458cff4` (redesign memory, insights, auto review). This document turns project memory (PROJECT-MEMORY-SPEC), the card Workpad (WORKPAD-SPEC), automatic delivery acceptance (AUTO-REVIEW-SPEC) and the suggestion part of Insights (INSIGHTS-REDESIGN-SPEC, WORKFLOW-INSIGHTS-SPEC) into one line. The sections that are superseded are in §12.

Prerequisite: the Auto Review card's (`4286f00a`) `feat/auto-review` (`5cbb9bc`, P1–P3) is the foundation of this document; the implementation branch `feat/guardrails` is split off from it, and in the end one PR into main carries both (§13). P4 is no longer done separately.

## 0. The user's decisions (2026-10-28)

| # | Question | Decision |
| --- | --- | --- |
| D1 | Auto review on by default for new projects | Superseded by the ruling of 2026-11-18 (Noah): Auto review is a board-group default that projects inherit and may override; a new project stores no value and follows its group, and a group that never set one is off (BOARD-GROUPS-SPEC §5, AUTO-REVIEW-SPEC D19). Before that: on for new projects, existing ones not turned on at upgrade, with a What's new button |
| D2 | Memory takes effect when written, and may retire automatically | Yes. This overturns PROJECT-MEMORY-SPEC's "takes effect only when a person confirms" and "active is never retired automatically" (§1.2, §5.2, §6.5) |
| D3 | The workpad keeps only the acceptance list, and the agent no longer self-reports pass/fail | Yes. This overturns the verification items of WORKPAD-SPEC §2.1, the freshness and soft gate of §5, and L1 of AUTO-REVIEW-SPEC §4.1 |
| D4 | A correction first concerns only this card, and is promoted to a project guideline only when it appears again on a second card | Yes |
| D5 | How it connects to the Auto Review card | Merge 5cbb9bc first, and this card is implemented on top of it |
| D6 | Scope of a guideline | Follows the evidence: the scope equals the union of the shapes of the cards it came from, only widening and never narrowing (§4.3) |
| D7 | Retirement | Done automatically using only three signals: sent back, not sent back, moved to Done. There is no "not a problem" button, and deletion is never required (§6.6) |
| D8 | Updating the command checks | Weekly re-detection plus usage evidence, and a new command is first observed for 3 reviews (§4.5) |
| D9 | Insights and the workpad | One ledger, two views: the workpad is the card's ledger, and Insights is the project's ledger (§7) |
| D10 (2026-10-29, after trial use) | Memory keeps its original name and its own entry point, and is not merged into the Guardrails page | Yes. Notes have little to do with guardrails, and merging them by force makes no sense; the data is still stored in guardrails.json (kind `note`), only the entry point, the page and the copy are separate. The Guardrails page keeps only Commands and Guidelines |

Earlier decisions remain valid: AUTO-REVIEW-SPEC D1–D6, D9, D12 (the yardstick of a review is the user's words, not the agent's self-report), D17.

### 0.1 Added decisions after the implementer's check (2026-10-28, the judgment of this document's author, can be overturned)

A session that had not taken part in the discussion read this document as an implementer and raised 7 questions that would affect the implementation. None needs the user's ruling; the answers are recorded here, and the body has been rewritten accordingly:

| # | Question | Decision |
| --- | --- | --- |
| B1 | A `fail` must cite a file in the diff, so "left something out" and "some directory is missing an entry" could never be judged | Evidence comes in three kinds, any one suffices: a file in the diff; a file that exists in the repository (where the omission happened); a quote from the card or the user's own words (a requirement that was not met). Only a `fail` with no evidence at all is downgraded to `na` (§6.3) |
| B2 | The induction input gives only the active guidelines in scope, so widening the scope and revival could not happen | The input lists all of the project's non-deleted guidelines (including out-of-scope, paused and archived ones), marked with state and scope; the 60-line cap is truncated by priority (§4.2) |
| B3 | With new projects on by default, at which step are commands ticked; where is the tour switch stored | No more ticking: the commands detected when the project is created or the switch is turned on are added directly as `observing`, the form only shows the detection result, and if the user is not happy they delete them on the Guardrails page. Tour page 2 gets no switch, only one introductory sentence and the cost; no new host setting (§4.5, §8, §10) |
| B4 | What happens to the project-level Project.memory switch; whether guidelines still take part in review after the host's Guardrails is turned off | The project switch stays, renamed Guardrails; when either the host or the project is off: nothing is learned, injected or retrospected, guidelines and card-specific items do not take part in review, and commands and built-in checks still run (§6.3, §8) |
| B5 | Whether migration goes in P1 or P2; whether there is a release between phases | The three phases are released together in 1.8.0, so the migration happens only once; P1 no longer claims to be independently releasable (§3.6, §13) |
| B6 | A rework turn recognizes only A1, so projects with automatic status turned off would not learn | Changed to the same fact as the memory clue `feedback`: the turn starts with the user's own message and the card is In review at that moment; it does not depend on A1/A1r, and the induction itself is responsible for judging "commit and push" as `none` (§4.1) |
| B7 | How a dispute is kept across rounds | Stored in `task.disputes` and kept with the card until Done/Cancelled; in later rounds that item is directly recorded as `disputed`, no longer cited and no longer judged as fail (§6.1, §6.6) |

### 0.2 Deviations recorded during implementation (phase A, 2026-10-28, accepted)

- `counts.usedBy` stores `{ taskId, at }[]` (the one-hour throttle and "used by how many cards" both need the time); there are also `lastMissedAt`, `misfireAt[]` (the latest 10) and `unavailableRun`, from which the three rules of §6.7 are computed.
- A note keeps the old `source { taskId, agentId, eventId }`, which `flowly_remember` uses to be idempotent; the basis of a retrospective goes in `sources[0].quote`.
- `flowly_remember` allows at most 5 per card (`MEMORY_LIMIT`), because a note now takes effect when written.
- A pinned note is not pushed out and is not archived for 90 days of non-use.
- An unknown size counts as in scope (same as an unknown type); at upgrade the scope takes the union of the known types and sizes, and `all` when both are unknown.
- LLM rules in the migration: `text` takes the first 200 characters of the prompt, and the full longer text goes into `body`; command rules that are `off` are also migrated as paused.
- `guardrails.detect` returns `{ found, added }` and adds only the scripts ticked by default at detection (build and e2e are not added); `guardrails.counts` returns `{ observing, added }`, where `added` is the number of guidelines learned in the last 7 days.
- When there is neither a memory.json nor any autoReview, no migration file is written, and it appears only on the first write. When the migration fails (memory.json cannot be read or does not match the schema, or the board read fails), the library is read-only: reads return empty, writes throw and log, guardrails.json is not created, and the next daemon start tries again; the original memory.json stays on disk (changed on 2026-10-29 per CodeRabbit's comment on PR #75; before it was "run as empty, create the file on the first write, no retry", under which one failure would leave the old data aside permanently).

### 0.3 Deviations recorded during implementation (phases B, C and the merge, 2026-10-28, accepted)

- Review records have no `tokens`: the SDK's review result carries no usage, and the Review group of the Workpad shows only state, round and model ("tokens" in §6.4 and §7.1 is not implemented).
- A challenged built-in goal item and a card-specific item have no entry to record a misfire on, so `insights.guardrails.misfires` counts only the misfires of guidelines and commands; the Insights hint "new command found but the cap was reached" of §3.4 has no channel and is not done.
- When an old skill's session sends `validation`/`confusions` to `flowly_update_workpad`, it returns `WORKPAD_INVALID` and says only `acceptance` is accepted; old workpad records drop these fields when read, with no migration.
- `autoReviewRuns(project)` looks only at the project switch; the old `reviewSetup` card, `reviewDraft`, the `memory.*` RPCs, `reviews.detect-commands|analyze-history|analysis-status|apply-draft|discard-draft|setup-card`, `insights.add-review-check|pause-review-check|dismiss-review-nudge`, and `workpads.resolve-confusion|refresh` are all deleted; stored `review_rule`/`review_pause` suggestions are dropped when read.
- From round 2 the review takes an incremental `git diff <previous round's sha>`; an item that passed in the previous round and got no conclusion this round keeps its pass.
- The Auto review of a new project and of "Edit project" has only the switch, one cost sentence and Max rework rounds; the client does not call `guardrails.detect`, and the daemon detects the commands when the project is created and when the switch is saved (cancelling the form leaves no side effect).
- What's new 1.8.0 carries a "Turn on for this project" button that opens the current project's Auto review settings; existing projects' Auto review stays off, and new projects default to on with 2 rounds.

## 1. Purpose

### 1.1 Data from this machine (Flowly project flow log, 2026-10-14 to 10-28)

| Fact | Number |
| --- | --- |
| Agent deliveries / cards | 461 / 104 |
| Median time for the user to reply after a delivery | 2.3 minutes |
| Replies after a delivery that are rework instructions (excluding turns reverted by A1r) | 310 times, 67% |
| Workpad updated by the agent / ticked by a person | 736 times / 7 times; 1 of 72 was ever clicked by a person |
| Last delivery with a workpad that has unfinished items | 45 / 71, mostly stale pass and unrun |
| Self-reported state of verification items | 321 pass · 39 unrun · 4 fail |
| Most common commands in workpads | typecheck, npm test, vitest, plugin reload, the same on every card |
| Memory candidates confirmed | 12/18 proposed by agents, 5/14 proposed by the Done retrospective, 12 backlogged |
| User words collected | 380 entries, used only as retrospective input |
| Skills runs / suggestions adopted | 53 runs of which 30 skipped; 13 suggestions of which 2 adopted |

Conclusion: In review is in practice "waiting for you to take a look", not acceptance; the workpad is the agent's monologue and the gate is released by its own confirmation; the bottleneck of memory is the inbox; and the most valuable material is what the user says when sending a card back, which is currently the least used.

### 1.2 In one sentence

**What you say when you send a card back becomes the project's guardrail; when an agent delivers, Flowly first checks it against the guardrails; only a delivery that passes calls you; and the new problems found grow into guardrails.** Learn, prevent, check and view are four faces of the same data.

### 1.3 Goals, non-goals, anti-goals

Goals:
- A delivery goes through the machine first and then to the person. The person is called only after a pass, an agent question, a permission request, or reaching the rework limit.
- Guardrails grow out of real send-backs, and no one needs to write rules, confirm candidates or clean up lists.
- The library is bounded: scope follows the evidence, retirement works by counting, and the cap works by pushing out.

Non-goals:
- A person dragging a card into In review to trigger a review; the review agent changing code; multi-reviewer voting; CI/PR status integration; temporary worktree isolation (following AUTO-REVIEW-SPEC §1.2).
- An agent or model adding rules to the review. A guideline that can send a card back from review grows only out of the user's own send-back words.
- The plugin writing repository files (except skills, following INSIGHTS-REDESIGN-SPEC §4).
- Vector retrieval, cross-project guardrails.

Anti-goals (achieving them still counts as failure):
- The user having to go to a settings page and configure something specially in order to use it.
- A list that grows longer and staler with use until nobody looks at it.
- A false positive on day one that sends a card back and makes the user turn the switch off.

## 2. The three things the user sees

| What is seen | In one sentence |
| --- | --- |
| The card face **Checked ✓ / Sent back ↩** | After an agent delivers, Flowly checks first. Only after passing does it enter Attention; if it does not pass, it is sent straight back to the agent to fix. |
| The **Guardrails** page | What this project checks: the project's own check commands, plus the things you said when sending cards back. Each line says how many times it caught something, how many times it misfired, and what kind of change it applies to. |
| **Done is still your call** | A pass only means nothing you have complained about before was found; it does not mean it was done right. |

The user does not need to know: the review session, the model fallback chain, the hard delete; the send-back target stage, the rework count, the fingerprint; the shape, scope, observation period, and how the three counts are computed; the states candidate, draft and confirm (which no longer exist).

Only one thing in the whole line still needs a click: writing a skill into the repository (it writes into your repository). Everything else needs neither your click nor your deletion.

## 3. The guardrail library (data)

### 3.1 File

`guardrails.json`, in the same directory as `board.json`, written serially, backed up as `.bak` before writing, replaced atomically, kept and reported as an error when invalid. It replaces `memory.json` (migration in §3.6). It is not put into the SQLite board store: the board is read frequently by etag, and the guardrail text does not need to travel with it (the same reason as PROJECT-MEMORY-SPEC §3.1).

```
{ version: 1,
  entries: Entry[],                 // project guardrails: commands, guidelines, notes
  items:   CardItem[],              // card-specific items
  clues:   Clue[],                  // the user's own words, as in PROJECT-MEMORY-SPEC §4.0
  retros:  [{ taskId, at, summaryId?, clueAt? }],
  errors:  [{ projectId, taskId?, at, message }],
  recallStats: { [projectId]: { days: { [day]: { queries, empty } } } } }
```

### 3.2 Entry

```
Entry {
  id, projectId,
  kind: "command" | "guideline" | "note",
  text: string,                  // command: name ≤80; guideline: one judgeable sentence ≤200; note: title ≤120
  body?: string ≤1000,           // note body; optional extra explanation of a guideline
  // command
  argv?: string[] (≤30 items, each ≤500), timeoutSec?: 10–3600,
  observe?: { reviews: int, passed: int },      // observation-period counts (§4.5)
  // guideline
  scope?: { types: TaskType[] | "all", sizes: Size[] | "all" },   // Size = "s" | "m" | "l" (§6.2)
  // note
  noteKind?: "decision" | "pitfall" | "contact" | "convention",
  tags?: string[] ≤4, keywords?: string[] ≤12,
  pinned?: boolean,              // note: always injected, ≤5 per project
  // shared
  state: "active" | "observing" | "paused" | "archived",
  stateReason?: string ≤200, stateAt,
  counts: { reviews, passes, caught, missed, misfire, lastCaughtAt?, usedBy: string[] ≤20, usedAt? },
  sources: [{ taskId, at, quote ≤300 }] ≤10,   // source cards and the user's own words; a note's source is the same as the old MemoryEntry.source
  by: "user" | "agent" | "retro" | "detect" | "learned",
  supersedes?: id, supersededBy?: id,
  revision, createdAt, updatedAt }
```

- Meaning of `state`: `active` takes part in review or injection; `observing` exists only for commands, runs but does not send a card back; `paused` does not take part, keeps its counts, and can be revived automatically; `archived` does not take part, keeps its history, and can be restored.
- A guideline's `text` is a summary of the user's words, and `sources[].quote` is the words themselves. The UI shows the words themselves first.

### 3.3 CardItem (card-specific item)

```
CardItem {
  id, projectId, taskId,
  text ≤200, quote ≤300,         // the summary and the words themselves
  shape: { type?: TaskType, size?: Size },
  count: int ≥1,                 // how many times this card was sent back for the same thing
  state: "open" | "promoted" | "closed",
  promotedTo?: entryId,
  createdAt, updatedAt }
```

- At most 5 `open` per card; beyond that the earliest is closed (`closed`). This is the only source of `closed`.
- When a card enters Done or Cancelled its items are **not closed**: the first card has mostly reached Done before a second card meets the same problem, and closing would make promotion never happen (found during implementation, 2026-10-28). A completed card is no longer reviewed, so its `open` items have only one use left: §4.2's "other cards' open items of the last 30 days". When a card is permanently deleted its items are deleted with it (§3.5); `promoted` ones are kept as sources.

### 3.4 Limits

| Item | Limit | When full |
| --- | --- | --- |
| `guideline` active per project | 20 | The newly promoted one pushes out the one with the lowest catch rate, or when equal the one longest without a catch (archived, `stateReason: "displaced"`), and a line is recorded in this week's changes in Insights |
| `command` active + observing per project | 10 | A newly detected one is not added, and a line is recorded in Insights |
| `note` active per project | 100 | Pushes out the one unused the longest (archived) |
| Pinned notes per project | 5 | Rejected |
| `open` CardItem per card | 5 | The earliest is closed |
| Archived per project | 300 | The earliest is deleted, with a backup written to `removed/` |

### 3.5 Deletion, archiving and removal

- Permanently deleting a card: its `open` and `closed` items and clues are deleted and backed up; `promoted` items are kept; entries that have it as a `sources` entry are kept.
- Remove project: all of that project's entries, items, clues and retrospective records are written to `removed/<projectId>-guardrails-<time>.json` and then deleted.
- Archiving a card or project: nothing is touched; after a project is archived the page is read-only.

### 3.6 Migration (once, at daemon start)

When `memory.json` exists and `guardrails.json` does not:

| Old | New |
| --- | --- |
| `active` entry | `note` active, `noteKind` taken from the old `kind`, with `usedBy`, `usedAt`, `pinned`, `source` as they were |
| `candidate` entry | `note` active, `by` as before (agent / retro). D2: there is no inbox any more, so the backlogged candidates take effect under the new rules and are subject to the 90-day archive for non-use |
| `dismissed`, `archived` | `archived`, `stateReason` taken from the old `archivedReason` or `"dismissed"` |
| `clues`, `retros`, `recallStats`, `errors` | Moved in as they were |
| Command checks in `project.autoReview.rules` | `command` active (already confirmed by the user), `by: "user"` |
| LLM checks in `project.autoReview.rules` | `guideline` active, `scope` taken from `types` (`"all"` when absent), `sizes: "all"`, `by: "user"`; those that are `off` become `paused` |
| `project.autoReview.goal`, `guidance`, `reviewDraft`, `task.reviewSetup` | Discarded; setup cards are kept like ordinary cards |

After a successful migration `memory.json` is renamed `memory.json.migrated`; on failure neither file is touched and it is logged, and the feature runs with an empty library.

## 4. Learn: where guardrails come from

### 4.1 Rework turns

The same fact as the memory clue `feedback` (PROJECT-MEMORY-SPEC §4.0, `messageClue` in `server/memory.ts`): the turn starts with a message the user wrote themselves (not a clicked next move or idea, and containing no secret), and the card is In review when the turn starts. It does not depend on A1/A1r, and projects with automatic status turned off learn the same way. Turns such as "commit and push" and "thanks" also enter the induction and are judged `none` by §4.2, with no separate rule. The 15-character lower bound for clue storage does **not apply** to the rework judgment: the four characters of "tests not run" are already a correction.

### 4.2 Induction: riding on the card summary

The card summary (TASK-SUMMARY-SPEC §2) runs at the end of every turn, and its input already contains the user's words of this turn. Only in a rework turn are two more things given:

- A section `Guardrails` is added to the end of the input (≤60 lines, each ≤120 characters), each line carrying the `#short ID`, the kind, the state and the text. Put in this order, with what does not fit cut off: the active guidelines in scope for this card; this card's `open` items; active guidelines out of scope (marked `out of scope`); other cards' `open` items of this project in the last 30 days; `paused` guidelines and those `archived` within 90 days (marked with the state). Out-of-scope and retired guidelines are listed so that the widening and revival of §4.3 can happen, rather than a duplicate growing again.
- One more optional field in the output:

  ```
  correction?: { kind: "none" | "new" | "same", text?: string ≤120, matches?: string }
  ```

  Instruction: is the user, in this turn, correcting work already delivered (not adding a requirement, not chatting)? If so, summarize it in one judgeable sentence (`new`); when it is the same thing as an entry in the list, give that entry's id (`same`), and use that entry's text as is. If it is not a correction, reply `none`. Parsing tolerance as in TASK-SUMMARY-SPEC §3; a missing field is treated as `none`.
  How a correction is judged (added after live verification on 2026-10-29): when the user says the delivered change "also" must, "still" must, "missed", or "should have" done something that could have been done as part of this change ("the new interface must also go into the README", "the new copy must also go into all languages", in the Chinese originals), that is a correction, and the user is not required to write "you got it wrong"; "adding a requirement" means only new work unrelated to this change (another feature, another page). A short sentence, a missing subject, or a missing negation word does not affect the judgment.

Zero extra model calls. A project with the card summary turned off has no immediate learning, and catches up only in the weekly run (§7.3).

### 4.3 Bookkeeping and promotion (daemon, deterministic)

After the card summary is written back, `correction` is handled, and `clues` are written too (as before):

| `correction` | Handling |
| --- | --- |
| `none` | Nothing |
| `new` | A new `open` item on this card: `text`, `quote` (the first 300 characters of the user's words this turn), `shape` (the shape of this card's latest delivery, §6.2), `count: 1` |
| `same`, matching an `open` item of this card | `count + 1` |
| `same`, matching an `open` item of **another card** | **Promote**: create a new `guideline` active, with `text` taken from that item's text, `sources` being the two cards and the words, `scope.types` = the union of the two cards' types, `scope.sizes` = the union of the two cards' sizes; both items are marked `promoted`. Record the event `guardrail_learned` |
| `same`, matching an active guideline | When this card's latest review judged it `passed` or `na`, `counts.missed + 1` (the review let it through and the user caught it); if there was no review (for example Auto review is off), only the source is recorded and no miss is counted. When this card's shape is not in the scope, the scope is widened to include it |
| `same`, matching a `paused` or `archived` guideline | Revive it as active (`stateReason: "revived"`), with misses counted as above and the scope handled as above. No duplicate entry is created. For a merged or superseded entry (one with `supersededBy`), follow the chain to the live one and do not revive the old one |

The scope only widens, never narrows. After a guideline is promoted, the "within this card's scope" judgment is in §6.2.

### 4.4 Notes

- `flowly_remember`: the input is unchanged (PROJECT-MEMORY-SPEC §4.1), and what is written is active at once; `supersedes` archives the old entry immediately (`stateReason: "superseded"`). Validation is unchanged: `MEMORY_DUPLICATE`, `MEMORY_LIMIT` (per §3.4), `MEMORY_SECRET`, `MEMORY_DISABLED`. The receipt and idempotency are unchanged.
- Done retrospective: the trigger, skipping, where it runs, the input, the generality test and the 0–1 entries all follow PROJECT-MEMORY-SPEC §4.2; the result is directly active, `by: "retro"`.
- Written by hand: Add on the Guardrails page.

A note is only injected and does not take part in review. Agents and the retrospective cannot produce guidelines or commands.

### 4.5 Command checks

- **When a project is created and when the switch is turned on**: `guardrails.detect` detects from the repository (rules as in AUTO-REVIEW-SPEC §6.1: package.json scripts with the package manager chosen by lockfile, Cargo, go, pytest, Makefile; the whitelisted names `test*`, `lint*`, `typecheck`, `type-check`, `tsc`, `check`, `vet`; `watch` skipped; at most 6). What is detected is written directly with `state: "observing"`, `by: "detect"`, with no ticking (B3): during observation it only reports results and does not send a card back, so the first impression is never a false send-back; the form shows only one line of detection result under the switch ("Checks found: typecheck, lint, test"), and if the user is not happy they delete or pause on the Guardrails page. Detection runs whenever a live project's effective Auto review (its override, else its group's value) turns on: on `projects.create` when the new project's group has it on, and after any write that turns it on (the project's override, its group's value, a move into another group; BOARD-GROUPS-SPEC §5); a command with the same name is not added twice.
- **Weekly** (before the run of §7.3 starts, with no model call) it is re-detected. A new command is added only when both of the following hold: it is in the list's whitelist; and in the last 30 days the agent ran it on at least 3 different cards (command records `commands/<projectId>.jsonl`, matched by normalized key, WORKFLOW-INSIGHTS-SPEC §3.2). When added, `state: "observing"`, `observe: { reviews: 0, passed: 0 }`.
- **Observation period**: a command under observation runs in the review and shows its result as usual, but does not take part in the overall verdict. When `reviews ≥ 3` and `passed ≥ 1` it turns active; 3 consecutive `unavailable` (cannot start, timeout) turn it paused (`"cannot run"`).
- **Exit**: when the corresponding script cannot be found in the list it is paused (`"script missing"`); an active command is paused after 3 consecutive `unavailable`. A renamed script comes in by the path of a new command.
- Manual add, delete and edit remain on the Guardrails page, and are not required.
- Commands are not learned from the workpad or from an agent's proposals: a command the daemon executes must have evidence of the user's authorization (ticking, or the agent having run it on several cards through Paseo permissions).

### 4.6 Secrets

Following `redact` (WORKFLOW-INSIGHTS-SPEC §3.2) and `MEMORY_SECRET`: a guideline text, quote or note that hits a secret rule is not recorded at all, and one entry in `errors` is recorded.

## 5. Prevent: injection at start and get_task

### 5.1 Initial instructions

The memory part of `sessionContext()` becomes two parts, appearing when a new session is created and in explicit work instructions, and not in ordinary follow-ups (unchanged):

```
Project guardrails (checked when you deliver; <n> of them apply to this card's type):
- Every new UI string is in all language catalogs (caught 4 times)
- …
Project memory (<n> of <m> shown, flowly_recall finds the others):
- [Pitfall] …
```

- Guidelines: the active guidelines within this card's type scope (the size is not yet known at the start, so only the type is used to filter), all listed, ≤20 lines.
- Notes: the selection algorithm and budget of PROJECT-MEMORY-SPEC §6.2 (8 entries, 2400 characters).
- Commands are not injected: the agent will run them anyway, and the daemon runs them again at delivery.

### 5.2 `flowly_get_task`

- The `memory` field is kept, with notes as its content (reselected by the current tags, as in the old §6.3), and `candidates` is removed.
- `reviewRules` is replaced with:

  ```
  guardrails: {
    enabled, maxRounds,
    commands:   [{ id, name, argv, state }],                 // active and observing
    guidelines: [{ id, text, scope }],                       // active guidelines within this card's current shape scope
    items:      [{ id, text, count }],                       // this card's open specific items
    lastReview?: Review }                                    // same as task.review
  ```

- The rework message (§6.5) lists the failed items one by one, using the user's own words.

### 5.3 `flowly_recall`

Unchanged; its query scope is notes and guidelines.

## 6. Check: delivery review

### 6.1 Trigger and flow

The trigger, queueing, the state machine (Reviewing / Passed / Rework / Failed / Unavailable / Cancelled), the send-back target stage, the rework count, delivery, the fingerprint and the hard delete all follow AUTO-REVIEW-SPEC §3 and §5. Changes:

- **L1 is removed**: `flowly_update_status(in_review)` no longer returns `WORKPAD_OPEN` or `WORKPAD_FAILING`, and `acknowledgeOpen` is valid only for `SETUP_INCOMPLETE` (CARD-SETUP-SPEC §3.4; "workpad missing" becomes "acceptance list missing").
- The delivery call gains an optional `disputes?: [{ id, reason ≤300 }]`: the id must be an item that `failed` in this card's latest review, or an item already in `task.disputes` (a repeated submission is idempotent), otherwise `INVALID_INPUT`. Accepted disputes are written into `task.disputes: [{ id, kind, name, reason, round, at }]` (≤10, kept with the card, with no semantics changed beyond the task revision; B7). When the card enters Done / Cancelled it is booked per §6.6 and then cleared; when a person drags the card back to a work stage it is not cleared (the dispute is still there, waiting for the next review).
- It is triggered as soon as the project is on and the card is not archived; the built-in checks also run when there are no commands or guidelines at all.

### 6.2 Shape of the change

At the start of a review the daemon computes it once and writes it into the review record:

- Take this card's own changes (changed after live verification on 2026-10-29; before it was "`git diff HEAD` plus the latest 5 commits", which on a worktree card counted the base branch's history, making every card `m`):
  - a worktree card (`task.baseRef` is non-empty and resolvable; this field has been saved at card creation since a1ec736 as the result of `resolveWorktreeBaseRef`, and cards created before that do not have it and take the old way below): `git merge-base <baseRef> HEAD` is the base point, and `git diff <base point> --numstat` covers the committed and uncommitted changes since the branch;
  - a directory card, or the base point cannot be resolved: `git diff HEAD --numstat` plus the latest 5 commits (the old way; in a shared directory other cards' changes are counted in, see D6);
  - both add the untracked new files (`git ls-files --others --exclude-standard`): text files are counted by lines, and binaries (a NUL in the first 8 KiB) or files over 1 MiB count as 0 lines and do not enter the review diff, and the index is not changed (no `git add -N`).
- `files`, `lines`: the sum of added and removed lines above; `size`: `s` ≤50 lines, `m` ≤400 lines, `l` >400 lines.
- The diff the review session reads uses the same base point (round 1 `git diff <base point>`; for a directory card `git diff HEAD` plus the latest 5 commits), with untracked new files appended after it as `git diff --no-index /dev/null <file>`; from round 2, `git diff <previous round's sha>` plus the new files still untracked at that time; the total length is still cut at 64 KiB.
- The shape of this card's latest delivery is also written into `task.review.shape`, for the new items of §4.3.
- In a shared workspace (not a worktree) other cards' changes are counted in, and the shape may be too large; the review record is marked `shared`, with no other handling (D6).
- **Multi-repository root directory** (added 2026-11-07): when the card workspace's directory is not itself a Git repository (a linked root, PROJECT-PICKER-SPEC; or an ordinary common directory the user registered), the review reads the repositories under it: among the non-hidden children (symlinks or directories) sorted by name, those containing `.git`, at most 20. For each repository the shape and the diff are taken by the rules above (the base point as above; a linked card has no `baseRef` and takes the directory-card way); paths always carry the repository prefix `<child name>/<path>` (the diff uses `--src-prefix` / `--dst-prefix`), so the files the review cites, the evidence check (it is enough that the file exists through the symlink) and the rework message all point to files in a specific repository. The shape is the sum over the repositories; the diff has one section per repository with the title `## Repository <name> (its paths start with <name>/)`, and each repository's section is cut within an equal share of 64 KiB (`[<name>: diff truncated]`), so one repository's big change does not push the others out, and the total length is still cut at 64 KiB. HEAD: each repository's short sha is recorded in `fingerprint.repos: { <name>: sha }`, `fingerprint.sha` is a 12-character digest of them (it changes when any repository has a new commit), and it is dirty when any repository is dirty; from round 2 each repository takes its increment from its own previous round's sha, and a repository with no record from the previous round takes the full diff. When the directory is itself a Git repository the behavior is unchanged; changes the agent makes in a worktree opened outside the card workspace still cannot be seen.

**In scope**: a guideline's `scope.types` is `"all"` or contains the card's type (a card without a type is treated as included), and `scope.sizes` is `"all"` or contains this size.

### 6.3 Order and verdict

1. **Commands**: all active and observing commands are run (execution as in AUTO-REVIEW-SPEC §4.3). Only active ones take part in the overall verdict. In a multi-repository root directory (§6.2) each command runs only in the repositories this delivery changed (having uncommitted or untracked changes, or commits made after the card was created; a repository git cannot read counts as changed; when none changed, it falls back to all repositories), picking the applicable ones in those repositories in turn, and a failure in any repository fails the item (the failure output is marked `[<repository name>]` at the front and the duration is the sum of the runs), with later repositories no longer run; the item's `detail` records the repositories actually run (`Ran in agent-smith, search-admin.`, with the failing repository last), visible by expanding the command in the review record, also when it passes (not written when the directory is itself a Git repository): a script of `npm` / `pnpm` / `yarn` / `bun` (and `npx` etc.) requires that repository's `package.json` to have that script (`run <x>`, aliases such as `test`; other subcommands only require a `package.json`); `make <target>` requires a makefile that has the target; `go` / `cargo` require `go.mod` / `Cargo.toml`; other commands run in every repository. When no repository is applicable the item is recorded as `skipped` (`No repository in this workspace has this command.`; when only the changed repositories are considered, `No repository this delivery changed has this command.`), and it does not make the review Unavailable.
2. **Review session**: it runs only when all the commands that take part in the verdict pass (D9). One pass judges everything: the built-in check `goal` ("Does what you asked", with the yardstick as in AUTO-REVIEW-SPEC §4.2: the card, the user's words and the acceptance list are only context), every in-scope guideline, and every `open` item of this card. Output:

   ```
   { items: [{ id, verdict: "pass" | "fail" | "na", detail ≤600, file?, line? }] }
   ```

   - A `fail` must carry evidence, any of three kinds (B1): a `file` that appears in the diff (changed wrongly); a `file` that exists in the repository but lacks something (left unchanged, for example `shared/i18n/zh-TW.ts` has no new entry, where the daemon only checks that the file exists); a `quote` citing a requirement in the card description or the user's words that was not met (common for built-in checks and specific items); the daemon checks the source (added 2026-11-07 per the PR #75 review comment): with whitespace collapsed, trimmed at both ends and lowercased on both the quote and the sources, the quote must be a substring of the card title, the card description, any one message of the filtered conversation the review received, or that check's own user words, otherwise it does not count as evidence (text quoted from the diff or the code needs a `file` as evidence). A `fail` with none of the three is changed by the daemon to `na`, `reason: "no evidence"`. This is deterministic noise reduction, meant to drop baseless opinions, not to permit faulting only the changed code.
   - Each output item is then `{ id, verdict, detail, file?, line?, quote? }`, with `quote` ≤300 characters.
   - `na` is treated as a pass, and counts neither as a catch nor as a misfire.
   - From rework round 2: the review input gives only the incremental diff since the previous delivery (`git diff <previous round's sha>`) plus the previous round's result, and the instruction says to recheck only the items that failed in the previous round and new problems in the increment, not repeating what already passed.
   - Disputes: items in `task.disputes` (§6.1) are not given to the review session and are directly recorded as `disputed`, with the agent's reason.
3. **Overall verdict**: any `failed` item that takes part → not passed (R1, or R2 at the limit); otherwise any `unavailable` → Unavailable; otherwise Passed. `disputed` does not count as not passed.

The set that takes part (B4): commands and built-in checks always take part; guidelines and specific items take part only when Guardrails is on (host `features.memory` is on and `Project.memory !== false`). When off they are also not injected, not learned and not shown in `get_task.guardrails`.

The review session is created in the card workspace, with the provider natively loading the repository's `AGENTS.md` / `CLAUDE.md`, and `guidance` is no longer fed separately. Model: the Review model in Settings → Models, and when unset the Summary models list is used (Haiku first), without falling back to the project's default agent model; the review record writes `model` and `tokens`, shown in the card's review section.

### 6.4 Review record

`task.review` changed from AUTO-REVIEW-SPEC §8.2:

```
Review {
  trigger, round, maxRounds, state, reason?, fingerprint, shared,
  shape: { files, lines, size },
  items: [{ id, kind: "command" | "goal" | "guideline" | "item", name,
            gating: boolean,                                  // false for an observing command
            state: "queued" | "running" | "passed" | "failed" | "na" | "disputed" | "skipped" | "unavailable",
            ms?, argv?, exitCode?, timedOut?, tail?, detail?, file?, line?, reason?, disputeReason? }],
  model?, tokens?: { in, out, costUsd? },
  startedAt, finishedAt? }
```

`rules` is renamed `items`. The `results` of the `review_finished` event carries `{ id, kind, state }` for each item.

### 6.5 Rework message

The format follows AUTO-REVIEW-SPEC §5, and guidelines and specific items use the user's own words:

```
[Flowly auto review · rework 1/2]
Commands: 2/2 passed
✗ "The new copy must also go into all languages" — zh-TW.ts has no entry for "Review passed" (shared/i18n/zh-TW.ts:412)
✗ Does what you asked — the card asked for a Rerun button; none was added
Fix these, rerun the checks, update the acceptance list and deliver to In review again. If a finding is wrong, deliver with disputes=[{id, reason}].
```

(The quoted words in the first ✗ line are the user's own words, translated; in the original example they were Chinese.)

### 6.6 Three signals and counts

All counts are computed deterministically by the daemon from events, with no buttons:

| Signal | Fact | Count |
| --- | --- | --- |
| Caught | An item `failed` in round n, and in a later review of the same card it `passed` (with no dispute) | `caught + 1`, `lastCaughtAt` |
| Missed | An in-scope active guideline `passed` or `na` in the latest review, and a later rework-turn induction matches it (§4.3) | `missed + 1` |
| Misfire | An item is in `task.disputes` and the dispute is still there when this card enters Done or Cancelled (the user did not send the card back again for this) | `misfire + 1`; the dispute is then cleared |
| Review | Each time it takes part in a review | `reviews + 1`; on `passed`/`na`, `passes + 1` |

When a disputed item is matched by the user's rework induction (§4.3 `same`): the dispute fails, it is removed from `task.disputes`, `caught + 1` is recorded, and no misfire is recorded.

### 6.7 Automatic exit (judged at the end of each review and in the weekly run)

| Condition | Action |
| --- | --- |
| A guideline's `misfire ≥ 2` within 30 days | paused, `"misfired twice in 30 days"` |
| A guideline's `reviews ≥ 20` and `caught = 0` and no `missed` within 90 days | archived, `"never caught anything"` |
| A guideline is matched by §4.3 | Revived |
| Command: §4.5 | |
| A note has no `usedAt` for 90 days (one never used counts from creation) | archived, `"unused for 90 days"` |
| Cap: §3.4 | Pushed out |

## 7. View: the workpad and Insights

### 7.1 Workpad (the card's ledger)

The Workpad section of the card drawer becomes four parts, and a part without content is not shown:

1. **Acceptance**: the acceptance list the agent writes when starting (3–5 items, `done` can be ticked by the agent or a person), still the agent's commitment to "what counts as done", read by the review as context and not as a gate.
2. **This card**: this card's `open` specific items, each showing the user's words and how many times it was sent back; a `promoted` one shows "Already a project guideline".
3. **Review**: the latest review, sorted by failed, disputed, passed/not applicable; a command row shows the command and its duration, and a judging row shows the basis and file location; an observing command is marked "observing"; a shared workspace is noted; the header shows the round, the model and tokens. There is a **Rerun** (conditions as in AUTO-REVIEW-SPEC §9.2).
4. **Steps** (formerly Plan, renamed on 2026-11-10, see CARD-PLAN-SPEC): comes from the native todo, unchanged (free).

Removed: Checks (self-reported verification), Confusions (the agent now uses the question tool), the environment stamp, freshness, "Delivered with N open items". The card face signal keeps only `Acceptance n/m` and the review state (Checked / Sent back / Review failed / Review unavailable); while a review is in progress it does not occupy the signal row and is shown by the indicator strip below.

#### 7.1.1 Card face indicator strip (requested by the user on 2026-10-28)

While a review runs, a strip unfolds at the bottom of the card, and folds away when it ends; one line, giving only an overview (user, 2026-10-28, translated: "an overview is enough, no need for that much detail"). It follows the `ReviewStrip` that P1 already has (`client/card.tsx`, `Collapse` to unfold and fold, `RunningDots` dot-matrix sweep laid underneath, following Reduce Motion and the sweep switch, and on web using a CSS animation that does not take the JS thread), changing only the text:

```
▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ← dot-matrix sweep (background)
 ◌ Reviewing · 3/7 passed · running npm test
```

- One sentence in the accent color, with three parts separated by `·`: `Reviewing`; `{passed}/{total} passed` (passed includes not applicable; observing commands are not counted in total; when there are failures it becomes `{passed}/{total} passed · {n} failed`, with the failure count in the danger color); what it is doing now, in the muted color: in the command phase `running {name}`, in the review session phase `judging {n} checks`, and `starting…` when there are no results yet.
- The data comes from `task.review.items` (§6.4) and is refreshed with the existing board etag read, with no new polling. The shared `reviewProgress(review)` (`shared/auto-review.ts`, provided by phase B) returns `{ passed, failed, total, phase: "starting" | "running" | "judging" | "done", current?: string, judging?: number }`: `total` counts only gating items, `current` is the name of the command being run, and `judging` is the number of items the review session is judging; the client only renders.
- At the end the last frame is held for 600 ms (so a person can see `7/7 passed` or `1 failed`) and then folded away with `Collapse`, while the signal row switches to Checked / Sent back; with Reduce Motion it folds immediately.
- Accessibility: the label reads "Auto review running, 3 of 7 passed, running npm test".
- Copy keys (English, in all catalogs): `Reviewing`, `{passed}/{total} passed`, `{n} failed`, `running {name}`, `judging {n} checks`, `starting…`. A command name is user content and is not translated.

The tool `flowly_update_workpad` is narrowed to `{ expectedRevision, request, workpadRevision, acceptance: [{ id?, text, done }] }`, with the return and error codes unchanged (`WORKPAD_CONFLICT`, `WORKPAD_INVALID`, `WORKPAD_DISABLED`). The `Workpad` data drops `validation`, `confusions`, `env`, `head`, `delivery`; old data drops these fields when read. The JSON of the CLI `workpad` accepts only `{acceptance}`.

### 7.2 Insights (the project's ledger)

The page from top to bottom:

1. **The closed-loop ledger** (replacing the "workflow" summary row): the last 14 days `N deliveries · X% passed first time · Y% misfires`.
   - Deliveries: an agent's `status_changed → in_review`.
   - Passed first time: the proportion of deliveries whose first-round review was Passed (the denominator is the deliveries that were reviewed).
   - Misfires: the sum of `misfire` over 30 days divided by the sum of judging-type `failed`; not shown when there are no failures.
   - The line below is this week's changes: `2 guidelines added · 1 scope widened · 1 retired · 1 command entered observation`, and each item can be opened to the Guardrails page.
2. The activity heatmap and the day's summary: unchanged.
3. **Skills**: unchanged (INSIGHTS-REDESIGN-SPEC §2.3).
4. Other suggestions: unchanged, collapsed by default.
5. The per-model rows of the workflow: unchanged, collapsed by default.

Removed: the rework hint, the check suggestions, the pause suggestions and the two finding kinds `review_rule` / `review_pause` of AUTO-REVIEW-SPEC §7.

### 7.3 Weekly tidy-up (inside the existing Insights run)

The same run, the same model call, the same switch and period as Skills (INSIGHTS-REDESIGN-SPEC §3.1). The run has three steps:

1. **Deterministic, no model call**: the command re-detection of §4.5; the exit judgments of §6.7.
   - Exception: for a project with the card summary turned off, a catch-up learning is done with the last 7 days' `feedback` clues. Treat these clues as rework turns, go through the induction of §4.2, and process at most 30 at once with the Summary model; this is the only model call in this step, and a project with the card summary on does not have it.
2. **Material**: in addition to INSIGHTS-REDESIGN-SPEC §3.2, add a section `Guardrails`: each guideline's text, scope, counts and source cards; a summary of each card's review results over the last 30 days; the `open` specific items.
3. **The model output** gains two kinds, executed by the daemon after validation:
   - `merges: [{ keep: id, drop: id, why ≤200 }]` ≤5: two guidelines or two notes that are about the same thing. The daemon archives `drop` (`"merged"`, `supersededBy: keep`), adds the counts, merges the sources and takes the union of the scope. Both ids must be active entries of this project, otherwise it is dropped.
   - An `agents_md` suggestion (an existing category) may reference guidelines: a guideline with `caught ≥ 5` in 30 days shows the agent keeps making that mistake, and stopping it with review alone is not worthwhile, so the run drafts an AGENTS.md rule or a skill (an existing category). After the user adopts the AGENTS.md suggestion (Create card or copy), they can archive that guideline on the Guardrails page (`"promoted"`); when the problem recurs, §4.3 will learn it back.

   The run cannot create guidelines or commands; such content in the output is dropped.

### 7.4 The Guardrails page and the Memory page (D10)

**The Guardrails page**. Entry point: the **Guardrails** chip in the overview bar (showing a count when there are `observing` commands or new ones this week), shortcut `G`; the project menu has the same name. A whole page, aligned with Ideas / Insights.

- Two segments at the top: **Commands**, **Guidelines**; within each segment grouped by active (observing), paused, archived, with archived collapsed by default.
- A command row: the name, the command text, the state (showing `observing 1/3` while observing), the latest result; menu: Edit, Pause / Resume, Delete. **Add command** at the end of the segment.
- A guideline row: the user's words (quote style), the summary sentence, scope chips (type, size; `all` is not shown), `caught 4 · missed 1 · misfire 0`, the source cards (tappable); menu: Edit, Pause / Resume, Archive, Delete. Paused and archived ones show `stateReason`. There is no Add: guidelines grow only out of send-backs; if the user wants to add a rule they say it when sending a card back.
- Empty state: "Nothing learned yet. Send a card back with what is wrong; Flowly checks the next cards for it."

**The Memory page** (keeps the old name Memory and the old entry point; its entries are entries with `kind: "note"`). Entry point: the **Memory** chip in the overview bar (this week's new count, with no number when there is none), shortcut `M`; the project menu has the same name.

- One toolbar line: type filter chips (All, Decision, Pitfall, Convention, Contact, single-select), sort (**Newest**, **Most used**, **Recently used**; pinned always first), and on wide screens a layout switch (**List** / **Grid**). The filter, sort and layout are remembered per machine (the `board-view` settings: `memoryKind`, `memorySort`, `memoryLayout`).
- Layout (redesigned 2026-10-31: in the first version the column was too narrow, content truncated, and information too dense): the content area is at most 1120 wide, centered; List is a single column at most 760 wide; Grid is a masonry layout (Keep style): column width at least 340, column count `clamp(floor(width/340), 2, 3)`, column gap and card gap 16, entries placed into the currently shortest column by estimated height; the compact layout has only List, and the switch is not shown. Card height follows the content and is not fixed.
- The card (the same card in both layouts): padding 16; the first row has a type marker (a small theme-colored dot + the type name, small) and, on the right, a Pin icon (shown only when pinned); the title in `font.md` bold, not truncated; the body in `font.sm` with line height 1.5, at most 6 lines by default, tapping the card expands the full text and tapping again collapses it (the expanded state is kept only within this page); the tags and usage are combined into one last small gray line (`#tag #tag · Used by 3 cards`, without writing "Not used yet" when unused, and not showing this line when there is neither); the source card is one line below the body, tappable. A 2-pixel color bar on the left, with the color of the type; a paused / archived state reason follows the type marker.
- Actions: on desktop the `…` at the top right of the card is shown only on hover or focus (always focusable), and always shown in the compact layout; menu: Edit, Pin / Unpin, Copy as AGENTS.md rule (archived as `promoted`), Archive / Restore, Delete (confirm). A row of buttons is no longer laid out flat at the bottom of the card. The archived group is collapsed by default. **Add memory** on the right of the toolbar.
- Each entry is color-coded by type: each of the four types uses one theme color (no custom colors; when the theme does not have enough distinction, it falls back to grayscale).
- Removed: the To review area, Confirm / Dismiss, the Clean up filter, Make room, the capacity hint, the Find memories button (the retrospective still runs automatically).
- The Memory section of the card sidebar is removed; the notes and specific items produced by this card are shown in This card in the Workpad section.
- Copy: wherever the user sees it, it is called Memory / memory (not Notes); on the agent side (skill, get_task, tool descriptions) it is also memory.
- Empty state: "No memory yet. Agents remember decisions, pitfalls and conventions as they work; you can add one too."
- Motion, input and accessibility follow PROJECT-MEMORY-SPEC §8.1.

### 7.5 RPC

| Method | Input | Behavior |
| --- | --- | --- |
| `guardrails.read` | `{ projectId, etag? }` | `{ etag, value?: { entries, items, errors, running: taskId[] } }` |
| `guardrails.counts` | `{ etag? }` | For the overview chips: per project, the number of observing commands, this week's number of new guidelines (`added`) and this week's number of newly created, unarchived notes (`notes`, for the Memory chip) |
| `guardrails.create` | `{ projectId, kind: "command" \| "note", … }` | A command or note written by hand, directly active |
| `guardrails.update` | `{ id, revision, text?, body?, argv?, timeoutSec?, scope?, tags?, keywords?, pinned?, state?, stateReason? }` | Edit, pause, resume, archive, revive. A `revision` mismatch gives `GUARDRAIL_CONFLICT` |
| `guardrails.delete` | `{ id, revision }` | Permanent deletion, with a backup written to `removed/` |
| `guardrails.detect` | `{ projectId }` | The detection of §4.5 when turned on, without executing commands |
| `guardrails.retro` | `{ taskId }` | Manual retrospective (kept for developers, not in the UI) |
| `reviews.rerun` | `{ taskId }` | Unchanged |
| `insights.guardrails` | `{ projectId, tz }` | The closed-loop ledger of the last 14 days (§7.2): `{ deliveries, reviewed, firstPass, judged, misfires, changes: { learned, widened, revived, retired, observing } }`. `deliveries` is the number of agent deliveries, `reviewed` those among them that were reviewed, `firstPass` those that were Passed in round one, `judged` the sum of judging-type `failed` (30 days), `misfires` the sum of misfires over the same period, and `changes` the counts of this week's `guardrail_*` events plus the current number of observing commands. The daemon computes them from the flow log, `review_finished.results` and the `guardrail_*` events; provided by phase B, and the client only renders |
| `insights.*`, `workflow-insights.*`, `summaries.*`, `workpads.*` | | Unchanged, with `workpads.check` left with only acceptance |

Removed: all of `memory.*`; `reviews.detect-commands`, `analyze-history`, `analysis-status`, `apply-draft`, `discard-draft`, `setup-card`; `insights.add-review-check`, `pause-review-check`, `dismiss-review-nudge`.

### 7.6 Events

| action | actor | When | note |
| --- | --- | --- | --- |
| `guardrail_learned` | system | A new specific item, promotion to a guideline, revival, widening of scope | The text and the kind |
| `guardrail_retired` | system | Automatic pause, archive, push-out, merge | The reason |
| `memory_proposed` | agent / system | `flowly_remember`, the retrospective (now takes effect directly) | The title |
| `review_started`, `review_finished`, `status_changed` R1/R2 | | Unchanged | |
| `workpad_updated` | agent | | `Acceptance n/m` |

`guardrail_*` is not shown in the card activity timeline, and the flow log records it as usual (this week's changes in Insights are computed from it). `review_rules_proposed` is removed.

## 8. Settings and defaults

- **Project Auto review**: `project.autoReview` is narrowed to `{ enabled, maxRounds }` and is the project's override (ruling, Noah 2026-11-18): absent, the project follows its group's `defaults.autoReview`, and a group without one means off with 2 rounds (`effectiveAutoReview`, BOARD-GROUPS-SPEC §5). `projects.create` writes none; `projects.update` with `autoReview: null` removes the override. New project and Edit project first offer *Override group Auto review* (off: one line with the inherited value), then only the switch, one cost sentence ("Every delivery runs a review and uses tokens."), one line of detection result (§4.5) and Max rework rounds; the check list, Use these, Adjust with AI, Suggest checks from past cards, Review guidance and the draft block are removed.
- **Project Guardrails**: the key `Project.memory` is kept, and the "Project memory" row in the project settings is renamed **Guardrails**, with the description "Learn from what you send cards back for, and check the next cards for it."
- **Host**: the key `features.memory` is kept, and the UI is renamed **Guardrails**, with the description "Flowly remembers what you send cards back for and checks the next cards for it. Learning uses a few tokens per card." When either the host or the project is off (B4): nothing is learned (§4.2, §4.3), nothing injected, `flowly_remember` returns `MEMORY_DISABLED`, no retrospective, guidelines and specific items do not take part in review (§6.3), and the Guardrails page is read-only. The Auto review switch governs only the review itself: after Guardrails is turned off the review still runs commands and the built-in checks. `task-summary.retroEnabled` is kept.
- **Review model**: unchanged; the default falls back to the Summary models.
- **Workpad** project switch: kept, governing only the display of the acceptance list and the tool.

## 9. Agent tools and skill

| Tool | Change |
| --- | --- |
| `flowly_get_task` | `reviewRules` → `guardrails` (§5.2); `memory.candidates` removed; `workpad` keeps only `acceptance`, `plan`, `revision`, `items` |
| `flowly_update_status(in_review)` | Gains `disputes`; no longer returns `WORKPAD_OPEN` / `WORKPAD_FAILING`; `acknowledgeOpen` only for `SETUP_INCOMPLETE` |
| `flowly_update_workpad` | Accepts only `acceptance` |
| `flowly_remember` | Takes effect when written; the description becomes "Remember … It takes effect at once for new sessions on this project, so only propose what holds beyond this card." |
| `flowly_recall` | Unchanged |
| `flowly_propose_review_rules` | Deleted (MCP, CLI `review-rules`, skill) |
| CLI | `workpad` accepts only `{acceptance}`; `status in_review` gains `--disputes '<JSON>'`; `review-rules` deleted |

The skill (`server/skill-source.ts` and `skills/flowly/SKILL.md`):

- Delete the verification items, sha, dirty, freshness, `WORKPAD_OPEN`, `WORKPAD_FAILING`, `acknowledgeOpen` (kept in the one sentence about `SETUP_INCOMPLETE`), `flowly_propose_review_rules`, and "reviewRules lists the checks".
- Add a paragraph (English): "`flowly_get_task.guardrails` lists what this delivery will be checked against: the project's commands, the guidelines learned from what the user sent earlier cards back for, and this card's own items. Read them before you start and before you deliver; the reviewer judges against them and against what the user asked in the card and this conversation. A rework message starting with `[Flowly auto review` lists what failed: fix it, update the acceptance list and deliver again. If a finding is wrong, deliver with `disputes=[{id, reason}]` instead of arguing in the note; the user decides."
- The Workpad paragraph becomes: "Before you start implementing, write 3–5 acceptance criteria with `flowly_update_workpad` and tick them as you meet them; the reviewer reads them as your own claim, not as proof."
- The memory paragraph: remove "check memory.candidates first" and add "What you remember takes effect at once."

## 10. Onboarding, What's new, telemetry, i18n

- **Tour** (ONBOARDING-SPEC): page 2, Built in, gains one sentence, **Auto review** (no switch, B3): "Deliveries are checked before they reach you and go back to the agent when they fall short. Each review uses tokens; set it per group, and a project can override it." (wording changed with the group-level ruling, Noah 2026-11-18); page 3, Project memory, becomes **Guardrails** (the switch is still `features.memory`), with the example replaced by two lines, "a sentence you said when sending a card back → the next card is checked"; in More features the Workpad sentence is changed to the acceptance list, and the Auto review sentence drops "Flowly can suggest the checks".
- **Tips**: `first-memory-candidate` is deleted; a new `first-guardrail`: when the first `guardrail_learned` that is a promotion to a guideline appears in the project (the first guideline) and the Guardrails page has not been opened, "Flowly learned a check from a card you sent back. Open Guardrails to see what it checks now.", with priority after `auto-review`; `review-suggest` is deleted; the `first-workpad` copy is changed to the acceptance list. `tipIds`, `tipText`, `nextTip`, `onboarding-logic.test.ts` and the tip table are kept in sync.
- **What's new 1.8.0** (covering the entry P3 already wrote):
  - "Auto review checks every delivery before it reaches you and sends it back to the agent when it falls short. On for new projects."
  - "Flowly learns from what you send cards back for: the second card with the same problem turns it into a project guideline, checked on every delivery it applies to."
  - "Memory no longer needs confirming; what agents remember takes effect at once and retires by itself when unused."
  - A button **Turn on for this project** (opens the current project's Edit project, with the switch already on, showing the detected list).
- **Telemetry**: `f_auto_review` is unchanged; `f_auto_review_llm` is deleted (the built-in check is always on, the same as the former); a new `c_guardrails`: the total number of active guidelines across unarchived projects (a count, no text). TELEMETRY-SPEC §4, `heartbeatProperties` and the key-set test are kept in sync.
- **i18n**: new copy goes into all catalogs, and deleted copy is deleted from all catalogs; the user's words, the summary sentences and command names are user or model content and are not translated; `Does what you asked` is translated when rendered.
- Both READMEs: the three Highlights sentences for Memory, Workpad and Auto review are rewritten.

## 11. Comparison with product constraints

| Constraint | Handling |
| --- | --- |
| The AGENTS.md exception "Off by default" (2026-10-27) | Changed to "On for new projects, off for existing ones until the user turns it on" (D1) |
| The AGENTS.md list of exceptions for the background workspace and hard delete | Remove "auto review history analysis"; the review session, the retrospective and the Insights run are unchanged |
| Memory `8424d1ab`: rejecting server-side remediation on the user's behalf | A rework message is an acceptance result, not remediation (AUTO-REVIEW-SPEC D2); learning sends no message |
| Memory `184178fe`: the user prefers the simplest approach | This document removes more than it adds: the inbox, drafts, setup cards, history analysis, the rule editor, self-reported verification, the soft gate |
| "Use subprocess argument arrays" | Commands accept only argv; automatically added commands come from the list, in the `npm run <script>` form |
| "Do not expose tokens in logs" | Command output exists only in the review record; the user's words go through `redact` |
| UI copy rule | Keep only cost, state and consequences; the list is filled by the user's own words |
| Onboarding / Telemetry upkeep | §10 |

## 12. Relation to existing specs

| spec | What this document supersedes | Kept |
| --- | --- | --- |
| PROJECT-MEMORY-SPEC | §1.2's "takes effect only when a person confirms", §3 (files and entries, changed to §3), §5 (confirmation and RPC), §6.5 (promotion and retirement), §8 (UI), the explanatory copy of §9, the "no automatic confirm or delete" of §12 | §2 (what is stored, and the division of labor with AGENTS.md), §4.0 clue collection, §4.1 tool validation, §4.2 retrospective, §6.1–6.4 the injection and recall algorithms |
| WORKPAD-SPEC | validation / confusions / env / head / delivery of §2.1, the input of §3, the environment stamp of §4.2, all of §5, the card face signal of §6.1, the Checks / Confusions of §6.2, the verification actions of §6.3, the skill of §7 | §2.2 Plan, the two revisions of §2.4, the acceptance ticking of §6.3, the project switch of §9 |
| AUTO-REVIEW-SPEC | the user path of §1.1, L1 of §4.1, the rule kinds and `types` of §4.2, all the configuration of §6, Insights of §7, the rules / guidance / reviewDraft of §8.1, §8.4, most RPCs of §8.5, §9.3, the What's new of §9.6, items 2, 4, 5 of §12 P3, D7, D8, D10, D11, D13–D16 | §2, §3, §4.3, the session running of §4.4, §4.5, §5, the skeleton of §8.2, §8.3, §9.1, the Rerun of §9.2, §9.4, D1–D6, D9, D12, D17 |
| INSIGHTS-REDESIGN-SPEC | the workflow summary row of §2.5 | The rest |
| WORKFLOW-INSIGHTS-SPEC | None | All; the command record of §3.2 gains one more consumer (§4.5) |
| CARD-SETUP-SPEC | "workpad missing" becomes "acceptance missing" | The rest |
| DELIVERY-CONSTRAINTS-SPEC | the `WORKPAD_OPEN` part of §2 | `SETUP_INCOMPLETE`'s reject-first-then-allow, outputs |

At implementation time a line pointing to this document is added at the top of the specs above; the note on AUTO-REVIEW-SPEC is added after 5cbb9bc is merged.

## 13. Phases

- **P0**: the Auto Review card is merged at `5cbb9bc`.
- **P1 Learn and prevent**: `guardrails.json` and migration; the card summary's `correction`; bookkeeping, promotion, revival, scope widening; `flowly_remember` taking effect at once; injection and `get_task.guardrails`; the Guardrails page (three segments, edit, pause, delete); events.
- **P2 Check**: shape and scope; guidelines and specific items entering the review; the evidence filter; incremental recheck; `disputes`; the three signals and automatic exit; the command observation period and weekly re-detection; removing L1, the rule editor, drafts, setup cards, history analysis and `flowly_propose_review_rules`; project settings and default on.
- **P3 View**: narrowing the workpad; the top of Insights and this week's changes; the weekly tidy-up's merges and AGENTS.md suggestions; the tour, tips, What's new, telemetry, README, AGENTS.md, and notes on the old specs.

The three phases are completed in turn on one implementation branch `feat/guardrails` (based on `feat/auto-review` 5cbb9bc), merged into one PR into main, and released together with 1.8.0 (B5): auto review itself has never been released (the latest tag is v1.7.2), so the migration of §3.6 is needed only once, and What's new is written only once. There is no release between phases.

## 14. Acceptance

Unit (focused, no snapshots):

- Migration: where active / candidate / dismissed / archived each go; the conversion of commands and LLM rules; both files untouched on failure.
- Induction: rework turn judgment (A1 pulled back and not reverted by A1r); the `Guardrails` section given only in a rework turn; the four parses of `correction` missing, `none`, `new`, `same`; a secret drops the whole entry.
- Bookkeeping: `new` creates an item, a same-card `same` adds to the count, a cross-card `same` promotes (scope as a union, both items marked promoted, event), matching an active guideline records missed and widens the scope, matching paused / archived revives; the cap of 5 per card; the push-out at 20 guidelines; the push-out at 100 notes.
- Scope: the judgment of type and size; a card with no type; `"all"`.
- Review: an observing command does not take part in the overall verdict; a `fail` without file evidence is downgraded to `na`; round 2 gives only the increment; the id validation of `disputes` and the `disputed` state; the overall verdict; `review_finished.results`.
- Signals: the fact sequences of caught, missed and misfire; when a dispute is matched by rework, caught is recorded and misfire is not.
- Exit: pause on 2 misfires; archive after 20 reviews with no catch; revival; a command paused after 3 unavailable, paused when the script disappears; the observation period turning active; a note archived after 90 days.
- Weekly run: re-detection plus usage evidence before adding; `merges` validation and execution; new guidelines in the run output are dropped; catch-up learning for a project with the card summary off.
- Injection and `get_task`: guidelines filtered by type, the note budget unchanged; the `guardrails` field; `memory.candidates` does not exist.
- Tools: `flowly_update_status(in_review)` no longer returns `WORKPAD_OPEN` / `WORKPAD_FAILING`; an illegal `disputes` → `INVALID_INPUT`; `flowly_update_workpad` accepts only acceptance, with old fields → `WORKPAD_INVALID`; `flowly_remember` is active at once and `supersedes` archives at once; `flowly_propose_review_rules` is not in the tool list.
- RPC: the revision conflict, delete backup and cascade of `guardrails.*`; the removed RPCs do not exist.
- Client: the tip rule `first-guardrail`; What's new 1.8.0; i18n catalogs complete; the telemetry key-set.
- `npm run typecheck`, `npm test`.

Live (Tinylink, per AGENTS.md, using newly created test cards and cleaning up only what was created afterwards):

1. Card A delivers and one command fails → it is sent back, and the rework message carries the words format; after fixing and delivering again → Checked. During the review the indicator strip at the bottom of the card shows `Reviewing · n/N passed · running <command>`, and after it ends it holds one frame and then folds away (screenshots of running / finished; under Reduce Motion there is no sweep and no hold).
2. The user sends card A back saying "the new copy must also go into all languages" → card A gets a specific item; after card B is delivered the user sends it back for the same thing → the Guardrails page shows one guideline, with the scope being the types and sizes of the two cards; when card C (same type, same size) is delivered the review judges it item by item; card D (a different size) is not affected by it.
3. An agent delivers with `disputes` → the card reaches In review, and the Review section shows the dispute; moved to Done → that guideline gets `misfire` 1.
4. Add a new `test:e2e` script and have the agent run it on 3 cards → after the weekly run it enters observing; after 3 reviews it turns active.
5. Migration: start with a copy of this machine's `memory.json` → the entry counts match, and candidates become active notes.
6. Desktop and compact layout screenshots go into `docs/verification/`.
