# Project Insights: daily stats, waiting on you, suggestions and change summary

Status: design confirmed by the user on 2026-10-16 (their words, translated: "Design it for use A. Agreed to add the flow log file"; "Implement it this way first and see"). Card task `9f52beff`.

## 1. Purpose and scope

Use A: review each day and plan the day. The project-level Insights page answers three questions:

1. What happened yesterday/today (numbers + change summary);
2. What is waiting on me now;
3. What to do first today (rule-based suggestions).

The trend covers only the last 7 days. Not done (later ideas): week/month views, an outward-facing daily report export, cross-project roll-ups. Per-day tokens were added by an idea on 2026-10-16 (§11).

Insights is read-only and does not change card status, revision or Paseo resources (except the temporary summarizer session of the change summary, see §7).

## 2. Flow log

`board.json` keeps only the latest 100 events per card, and each turn start/end takes one entry each, so the early flow of an active card gets squeezed out. Add a flow log that is not truncated.

- File: `flow/<projectId>.jsonl` (in the same directory as `board.json`), one event per line:
  `{ id, at, taskId, actor, action, from?, to?, reportKind?, outcome?, rule?, agentId? }`. The note body is not stored.
- Write: `BoardStore.event()` records the events this transaction produced; after `board.json` has been atomically replaced successfully, they are appended per project in the same serial queue. An append failure only records a warning and does not affect the board write.
- Reconcile: after the daemon starts and before each Insights read, events (by id) that exist in `board.json` but not in the log are written in. The first run backfills the existing events.
- Incomplete history: when a card's `created` event is in neither the board nor the log (early events were already truncated), it counts as "incomplete history", the initial column is inferred from the earliest known event; the page explains it with a one-line footnote.
- Deletion:
  - Permanently deleting a card: rewrite the log of its project and drop that card's records; the dropped lines are written to `removed/task-<id>-flow-<time>.jsonl`.
  - Remove project: the whole log file moves to `removed/<projectId>-flow-<time>.jsonl`.
  - Archiving a card does not delete the log.
- An invalid log line is skipped (the file is not reset).

## 3. Daily computation

Pure functions (`shared/insights.ts`), called by the daemon.

- Day boundary: the client passes an IANA time zone (`tz`); when invalid, use the daemon's local time zone. Date format `YYYY-MM-DD`.
- Replay: for each card, apply the `to` of `status_changed` in time order to get the time spans of each column. Initial column: at `created` it is the `from` of the first flow entry; with no flow entry it is the current column.
- Daily metrics `DayStats`:
  - `created`, `done`, `cancelled`: the number of cards created, entering Done, entering Cancelled that day (the same card entering several times in one day counts once);
  - `reopened`: the number of times leaving Done/Cancelled; `rework`: the number of times In review → a work column (design/development/test);
  - `turns`: `{ completed, failed, canceled }`, from `agent.turn_ended`;
  - `agentMs`: the sum of the parts of all session run intervals (turn_started→turn_ended, unfinished ones cut at now) that intersect that day; `peakSessions`: the most sessions running at the same time that day;
  - `questions` (reportKind=question), `permissions` (`agent.permission_requested`), `ideas` (`idea_proposed`), `ideasAccepted` (`idea_accepted`);
  - `lanes`: the number of cards in each column at the end of that day (now for today), not counting archived cards;
  - `commits`, `added`, `deleted` (§6).
- 7-day trend: for each of the last 7 days, `created`, `done` and the number of cards in work columns; the median dwell time (by column) of the time spans that left a column in the last 7 days.
- Comparison: next to that day's numbers show the daily average of the previous 7 days (not including that day).

## 4. Waiting on you

Shown only in the "today" view. In the following order, the longest-waiting first within each group, each item showing how long it has waited:

1. `permission`: the card's session is waiting for authorization (Paseo pending permission);
2. `question`: the card's agent has asked a question that has not been answered (using attention's open-question judgment);
3. `error`: the session is in an error state;
4. `review`: the card is in In review, with the duration counted from the most recent entry into In review;
5. `blocked`: the card is in Blocked.

Permission, question and error come from the existing attention data on the client; In review / Blocked and their wait durations come from the log in the daemon (`review[]` and `blocked[]`, with `since`). Clicking opens the card.

## 5. Today's suggestions (rules)

Computed by the daemon, at most 5, by severity (warning > info) and then by rule order. Thresholds are constants. Each is `{ rule, severity, text, taskIds }`:

| Rule | Condition |
| --- | --- |
| R1 Review backlog | In review ≥3 cards, or the oldest one ≥24 h. Attach the number of entries into and exits from In review in the last 7 days |
| R2 Stalled | A card in a work column has had no turn or status change for ≥48 h, and has no running session |
| R3 Repeated rework | A card has accumulated rework ≥2 times (still not finished) |
| R4 Priority inversion | An Urgent/High card in Backlog/Todo for ≥3 days, while during that time lower-priority cards entered a work column |
| R5 Too much in parallel | Work column cards ≥5 and > 2 × the daily average completions over the last 7 days |
| R6 Repeated failure | A card has ≥2 failed turns within 24 h |
| R7 Can start work | The project has no running session and Todo is not empty: recommend the first 3 cards by priority and then by time in Todo |

The text is a short English sentence (consistent with the UI language). Whether a session is running is passed in by the RPC (the daemon uses the SDK to list the workspaces of running agents in the project).

## 6. Git changes

- Repositories: the project root directory (`primaryPath`) if it is a Git repository; plus the subdirectories one level under the root that are Git repositories (including symlinks of a linked root). At most 20.
- Command (argument array): `git -C <repo> log --all --no-merges --since=<8 days ago> --format=%x1e%H%x1f%aI%x1f%s --numstat`. De-duplicate by commit hash, split into days by author time.
- Per day: number of commits, lines added and deleted (binary files do not count lines), the 5 most-changed files, commit titles (at most 50, for §7).
- Cache: cached for 60 seconds by the repository `HEAD` and refs fingerprint; when git is unavailable or fails, return `gitError` and the rest works as usual.

## 7. Daily change summary (LLM)

- Input (≤12000 characters): the project name; the cards completed, cancelled and created that day; each card's flow that day (time, from→to, actor); each card's last summary version of that day (state/recap/next) and the state of the last version before it; that day's commit titles; that day's questions and failed turn counts.
- Output `{ headline, done[], progressed[], issues[], next[] }`: `headline` is one sentence; each group has at most 5 items `{ text, taskId? }`. The language matches the card content. Parse tolerance is the same as TASK-SUMMARY-SPEC §3 (code block, first JSON object, string array).
- Trigger:
  - When Insights is opened to view "yesterday" or an earlier day, if that day has no summary and the switch is on, one is generated automatically;
  - "Today" is generated only on a manual Refresh; any day can be regenerated with Refresh;
  - When that day has no activity at all, none is generated and "No activity" is shown.
- At most one generation task per project at a time.
- Run: `agents.create`, `config.provider` is the Summary model (TASK-SUMMARY-SPEC §4, Auto resolves the same way), labels `flowly=summarizer`, `flowly-project=<id>`, `waitForFinish(120000)`, and in `finally` **hard-delete** that session (`daemonRemoveAgent` in `server/summarizer-remove.ts`, the same AGENTS.md exception as the card summarizer, adopted by the user on 2026-10-23; only the id just created this time is deleted, and when the delete fails it falls back to archiving and logs it). Workspace: the project's "Flowly background" workspace, restored/reused before use and archived after the last background run ends, never a card workspace ([BACKGROUND-WORKSPACE-SPEC](BACKGROUND-WORKSPACE-SPEC.md), which on 2026-10-23 replaced the earlier rule "match the project root workspace by directory, otherwise use the most recent card's workspace": under single-root all card workspaces have the same directory, so the old rule would pick some card's workspace).
- Switch: the setting `task-summary` gains `digestEnabled` (default true), which controls only automatic generation; a manual Refresh is always available.
- Storage: `digests.json`, serial writes, backup, atomic replacement; when invalid, keep the file and report an error. `{ version: 1, entries: [{ projectId, day, tz, at, model, headline, done, progressed, issues, next }], errors: [{ projectId, day, at, message }] }`. Each project keeps the last 60 days; when a project is removed it is backed up to `removed/` and then deleted.

## 8. RPC

| Method | Input | Output |
| --- | --- | --- |
| `insights.project` | `{ projectId, tz, day?, etag? }` | `{ etag, value? }`; value is described below |
| `insights.digest` | `{ projectId, tz, day }` | `{ entry \| null, running, error \| null, enabled }` |
| `insights.digest-refresh` | `{ projectId, tz, day }` | `{ queued: true }` |

The value of `insights.project`: `{ day, today, stats, average, trend[], dwell, review[], blocked[], insights[], git: { repos, error, topFiles }, incomplete }`.

## 9. UI

> Since 2026-10-22, the page layout, time ranges and project work stats follow [INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md); what follows is the original version, kept as a record.

- Entry: the "Insights" button at the end of the board overview bar, and the shortcut `i`. After opening, the board area is replaced by the Insights page, with "‹ Board" at the top to go back (Esc also goes back).
- Page (vertical scroll, centered at width ≤760):
  1. Date switch: ‹ date ›, "Today"/"Yesterday" are shown as text; no later than today;
  2. Number row: Done, New, Rework, Turns, Agent time, Commits, each with the 7-day average shown dimmed below;
  3. Waiting on you (today only);
  4. Suggestions;
  5. Summary (change summary): Refresh, "Updated · model", "Generating…" while running, an error as one dimmed line;
  6. Last 7 days: created/done bar comparison and work column card counts; median dwell per column; most-changed files.
- Clicking a card reference opens the card sidebar.
- Data: queried only while the page is open, `insights.project` uses the etag, and it is re-read when the board etag changes; no polling after closing.

## 10. Acceptance

- Unit: log append/reconcile/de-duplicate/rewrite on card deletion/project removal; replay and day splitting (across days, time zones); each DayStats item; wait durations; R1–R7 firing and not firing; git output parsing; summary output parsing and input construction.
- typecheck, full tests; reload this plugin; call `insights.project` on this project and check the numbers.
- A Luna 6 full-access test session tests desktop and compact layouts for real with a fixture project and cleans up.

## 11. Per-day tokens (2026-10-16, idea "Insights: per-day token usage stats" (translated), the user chose to continue it on this card)

- Data source and basis are the same as USAGE-STATS-SPEC: local Claude Code / Codex logs, read-only, no content written to disk, tokens only.
- Bucketing: when parsing the logs, accumulate by 15-minute time slices (all time zone offsets are multiples of 15 minutes), then split into days by the client time zone.
  - Claude: each assistant message (de-duplicated by `message.id`, including sub-agent logs) counts into the time slice of its `timestamp`.
  - Codex: `token_count` is a cumulative value, and the difference between two adjacent ones counts into the later one's time slice; any field becoming smaller is treated as a counter reset, counting from zero.
- Scope: sessions in all card workspaces in the project, including archived ones and the progress summarizer (distinguished by label, no longer split further). Digest sessions in the background workspace belong to no card and are not counted.
- RPC `insights.tokens { projectId, tz, day?, etag? }` → `{ day, today, tokens, average, trend[7]: {day,total}, tasks[≤5]: {taskId,tokens}, sessions, missing }`. Separate from `insights.project`, so the page does not wait for log parsing.
- UI: the number row adds Tokens (total, cache hit rate, 7-day average); the **Token use** block after Summary: totals by type, cache hit rate, the 5 cards that used the most tokens that day (click to open), the number of sessions with no logs and a source footnote; Last 7 days adds a "Tokens per day" bar.
- Acceptance: unit tests for parse bucketing (de-duplication, across days, counter reset) and per-day aggregation; on real Claude and Codex logs, the plugin's per-day totals match a manual count from an independent script.
