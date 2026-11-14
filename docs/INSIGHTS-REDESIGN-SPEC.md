# Insights redesign, third version: project activity and Skills

> 2026-10-28: parts of this document are superseded by [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) (§12). Superseded: the workflow summary row in §2.5 (replaced by the closed-loop ledger at the top of the page, with the per-model rows collapsed by default); the rest remains valid.

Status: **third-version spec, reviewed and approved by the user on 2026-10-25, implementation in progress** (2026-10-25, card `ccefebbe` "Insights redesign"). This version replaces the page part of the second version (the decision record in §10 explains what was kept or dropped from the first two versions). The second version's implementation is on the local branch `feat/insights-redesign` (commit 8176912) and in the working tree, and **was never merged into main**. What the user uses now is the first-version page on main ([PROJECT-INSIGHTS-SPEC](PROJECT-INSIGHTS-SPEC.md) §9). The third version is implemented on top of the second version's code. In this text "second version §x" means the second-version spec; its full text is available with `git show feat/insights-redesign:docs/INSIGHTS-REDESIGN-SPEC.md`.

## 0. The user's own words and what is settled

After looking at the second version on 2026-10-25, the user said:

> Their words (translated): "The current implementation is still mediocre. We do need to keep the activity information for the whole project, shown graphically so that you can see which days are busy and which are idle, like a GitHub project.
>
> I also think insights could summarize some skills the project can reuse, and that may be the capability insights most needs to have."

The user's two example skills:

> Their words (translated): "This project has always had the convention of merging through PRs, but since we turned on CodeRabbit merging has always been troublesome, including when to wait for CodeRabbit's review result and how to merge, which differs from run to run. That kind of thing could be captured by insights and turned into a skill. Or when I am doing performance optimization, optimizing the performance of the Paseo plugin could also be a dedicated skill."

The user's assessment of the second version's sections:

> Their words (translated): "Attention per card is not very useful; where time goes as a pure table looks troublesome and is not very useful either; I don't know what agents habit is, it looks like which agents have not followed the rules, which is something I (as the Flowly developer) should care about, not something ordinary users need to pay attention to; the daily record has never produced a summary."

Already confirmed with the user:

| Question | The user's decision |
| --- | --- |
| Where the skill goes | Written into the project directory: the real files under `.agents/`, symlinks under `.claude/`, only one copy stored |
| Page layout | Per the mockup (`docs/verification/insights-redesign-v3/mockup-1-page-green.png`): activity at the very top, then Skills, other suggestions, workflow |
| Heatmap color | The theme green, with shade showing the amount (like GitHub) |
| The second version's workflow numbers | Kept; expanded by default from 2026-10-26 (§10.8) |
| Whether skill extraction is on by default | On by default, can be turned off in the welcome tour; the model, frequency etc. are adjusted in settings |

## 1. Positioning

Insights answers two questions:

1. **Whether the project has been active recently**: which days work was going on, and what was done that day.
2. **Which recurring practices are worth keeping as a skill**, so that future agents can follow them directly and the user does not have to re-explain or correct every time. This is Insights' **main capability**.

Goals:
- See at a glance the active days and the idle days; tap a day to see that day's summary.
- From the project's cards, the user's own words and the agents' commands, extract complete, usable skill drafts. After the user confirms, they are written into the project and loaded natively by Claude Code and Codex.
- A skill can be updated with new experience, with the new version overwriting the old.

Not doing:
- Cross-project aggregation, per-person statistics, rankings.
- Having Flowly inject skills into sessions itself: skills are left to the provider to load natively (§4.4).
- Automatically committing or pushing skill files.

Anti-goals (achieving them still counts as failure):
- **Creating anxiety or encouraging volume-chasing**: no streak counts, no big totals like "N times in the past year", no rankings. The heatmap only shows density.
- **Writing files without user confirmation**: until "Add to project" is clicked, a draft exists only in Flowly's data.
- **Changing skills the user wrote**: Flowly only updates the skills it added to the project itself (§4.5).
- **Storing the same skill twice**: only symlinks go under `.claude/skills/`, and when a link cannot be created nothing is copied (§4.3).

## 2. Page

A single column, content at most 760 wide, using only theme colors. From top to bottom:

1. Activity (heatmap, §2.1)
2. The day (daily summary, can be paged left and right, §2.2)
3. Skills (§2.3)
4. Other suggestions, collapsed by default (§2.4)
5. Workflow, expanded by default (§2.5)
6. Agent habits, shown only when the developer switch is on (§6)

The page header drops the second version's window switch (‹ date range ›); the whole page has only one "selected day" state.

### 2.1 Activity heatmap

- **The number in each cell**: the number of agent turns that ended that day, that is the number of `agent.turn_ended` entries in the flow log `flow/<projectId>.jsonl`, cut into days by the client's time zone. The flow log records only card sessions; Flowly's own background sessions (summary, digest, Workflow insights) are not in it. The flow log must be read, not the events in `board.json`: the latter keeps only 100 per card (the project memory pitfall).
- **Range**: 52 whole weeks plus the current week, 53 columns in all, one column per week, Monday at the top. Days of the current week that have not arrived yet get no cell. The month is labeled above the column containing that month's first Monday; if only less than two weeks of that month remain in the first column, it is not labeled, to avoid overlapping the next month's label. Row labels mark only Monday, Wednesday and Friday, using the weekday abbreviations of the current language.
- **Shade**: no activity is level 0. The other days are split into levels 1–4 by the 25%, 50% and 75% quantiles of the non-zero days in the range, like GitHub. This lets projects of different scale show differences. When there are fewer than 4 non-zero days, each non-zero day is assigned a different level by its actual order, with the algorithm left to the implementation.
- **Color**: level 0 uses `colors.surface2`; levels 1–4 use `colors.accent` with opacity 0.28, 0.5, 0.75 and 1 in turn. No other colors.
- **Cells**: on wide screens the cell size is measured from the width remaining to the right of the weekday labels (gap 3 px, cells 8–14 px), so the last week stops exactly at the panel's right edge; a fixed 11 px would overshoot the 760-wide column by about 9 px. The weekday labels have their own 16 px row height, centered in the cell row, and must not be clipped by the cell height. In the compact layout (content width below 760) cells are 10 px and the whole block sits in a horizontal ScrollView that scrolls to the far right (the most recent days) when opened.
- **Selection**: tapping a cell selects that day, with a 1.5 px `colors.foreground` border. Today is selected by default. A day without activity can also be selected.
- At the bottom right is the legend "Less □□□□□ More". Nothing else shows any total.
- Accessibility: each cell's label is written like "October 21, 119 turns" (localized).
- Performance: 371 Views are acceptable on both wide screens and phones. The cell rows are wrapped in `React.memo`, so when the selected date changes only the old and the new cell are redrawn, and callbacks use `useStableCallback`. No animation.

### 2.2 The day (daily summary, can be paged left and right)

Changed by the user on 2026-10-26 (§10.9): under the heatmap is a "daily summary" card that replaces the earlier day panel and the "Last 7 days" list.

- **Changing the day**: the card's title row has an arrow button on each side ("Previous day", "Next day") that jumps to the previous/next day **with activity**; "Previous day" is unavailable when there is no earlier active day, and "Next day" is unavailable once it is today. Tapping a heatmap cell also changes to that day (including a day without activity). The selection box on the heatmap follows. When the day changes the title row stays still and the content below slides in from the direction of the change (going back from the left, going forward from the right, 16 px with a fade-in, duration `motionDuration.forward`, using the shared `Enter`; on consecutive taps the old animation stops immediately; no motion when the system has "Reduce motion" on). No swipe gesture.
- **Title row**: the arrows, the date (today is written "Today"), and on the right the summary's "Refresh" button (when a summary exists).
- **Numbers row** (muted color, one line, wrapping if it does not fit): "119 turns · 17 cards · 15 done · agent 6h 12m · 48.2M tokens".
  - Turns: agent turns that ended that day (`agent.turn_ended`), consistent with the heatmap.
  - Cards: the cards that had a turn or a move that day.
  - Agent time: the sum of the parts that fall within the day of all sessions' running intervals (`turn_started` → `turn_ended`, `sessionIntervals`), with turns that cross midnight cut by time. A running turn counts only up to now.
  - Tokens: the usage of these cards' sessions that day in the local provider logs (in 15-minute buckets, the buckets that fall within the day are added up, same source as `insights.tokens`). Shown as "…" while reading, and this item is omitted when it cannot be read.
  - A day without activity shows only "No activity", and nothing below it.
- **Summary**: the AI summary (headline, issues, "updated · model") and the generation rules are unchanged (see below). The chip for completed cards is removed and replaced by the task list below.
- **Task list**: one row for each card that had action that day, ordered by that day's agent time from most to least (ties by turns):
  - Left: a check in front of a card that was completed that day, an empty circle for the others; then the card title (truncated to one line). Tapping a row opens the card.
  - Right: muted "12 turns · 1h 20m · 3.2M" (items without time or tokens are omitted).
  - **Complexity**: a thin horizontal bar under the title, its length being this card's time that day as a proportion of the card with the most time that day (by turns when there is no time data), in `colors.accent`, with the same 4 opacity levels as the heatmap (proportion ≤25%, ≤50%, ≤75%, more). With only one card the bar is full. No ranking or place is shown.
  - Over 8 cards, 8 are shown first, with "Show N more" below.
- **Data**: a new RPC `insights.day` (§7), with input `{ projectId, tz, day }`, returning that day's numbers and, for each card, the turns, time, tokens and whether it was completed that day. Reading tokens from the logs is slow, so `insights.day` first returns the part without tokens, and the tokens are read by the same RPC called again with `tokens: true` (two client queries, so the page does not wait for the logs).
- **Generation**: when a past day is selected, if that day had activity, has no summary yet, and the Daily digest switch is on, it is generated automatically and "Summarizing…" is shown. When today is selected nothing is generated automatically; a "Generate summary" button is shown and generation happens only on click (the same as refresh). Any day can be regenerated. The trigger rules follow `insights.digest` / `insights.digest-refresh`, with two changes:
  - **Only one is generated at a time per project** (PROJECT-INSIGHTS-SPEC §7 already said so, but the current code counts per day, so ten quick clicks open ten sessions at once). When another day is selected while a generation is in progress, the last selected day is remembered; after the current one finishes, if that day still has no summary, it is generated. Days clicked in between are not generated. Paging works the same: paging through several days generates only the day that is running and the day where the user finally stops.
  - **Retention days**: `DIGEST_DAYS` changes from 60 to 400, covering the whole range of the heatmap. Otherwise a day from a year ago would be trimmed right after being generated, and every opening would spend tokens again. Each summary is only about 1 KB.
- This fixes "the daily record has never produced a summary": the second version's "daily record" list only read existing headlines and never triggered generation; generation happened only after expanding and then tapping into a day, so the Flowly project had only one entry, October 16.

### 2.3 Skills

This is the main feature of the page, shown in both desktop and compact layouts.

**Title row**: "Skills", and on the right, in order, the time and model of the last analysis (for example "11 hours ago · claude-sonnet-5-5"), "Analyze now" and a gear (opens the Skills group of Settings → AI). While an analysis is in progress it shows "Analyzing…"; while the session history is being backfilled it shows "Reading recent sessions…" (as in WORKFLOW-INSIGHTS-SPEC §5.2).

**Row**: one row per skill, with an expand arrow on the left, then the `name` (monospace bold) · a one-sentence title (in the AI output language), and on the right the status and the basis:

| Status | Shown on the right | When expanded |
| --- | --- | --- |
| New draft | a "New" chip, "N cards" | a paragraph of basis (in the AI output language); the full SKILL.md preview (monospace font, at most about 360 px high, scrollable); buttons **Add to project**, **Dismiss**; next to them, muted, "Writes to .agents/skills/<name>/ and creates a symlink in .claude/skills/" |
| Update available | an "Update available" chip, "Already in project" | one sentence saying what changed; a line-level diff (current file → new version, `+`/`-` prefixes, monospace font); buttons **Update in project**, **Keep as is** |
| Already in project | muted "Already in project" | the current file content (read-only) and the path |

- Order: update available, new drafts, already in project; within the same status by confidence, then by time.
- "Already in project" lists only the skills Flowly added to the project (§4.5). Skills the user wrote themselves are not listed, but are used as analysis material (§3.2).
- Both **Dismiss** and **Keep as is** mark the draft as dismissed: a draft with the same or a similar name is not proposed again for 30 days, following the cooldown rule of WORKFLOW-INSIGHTS-SPEC §4.4. A dismissed draft is not shown and cannot be restored; if wanted, wait for the next analysis to propose it again, or analyze right away.
- Empty state: before any analysis it shows the line "Not analyzed yet." and "Analyze now"; when analyzed but there is no skill it shows "No practice worth turning into a skill this time."
- Off state (the switch is off): the line "Skills is off." plus a **Turn on** button that jumps to the settings group.

### 2.4 Other suggestions (collapsed by default)

Uses a Disclosure with the title "Other suggestions" and the summary "Scripts, repo tools, AGENTS.md · N items". The content is Workflow insights' existing suggestion list, just without the `skill` category: the target chip, title, basis, proposal, and the Create card / Dismiss / Restore actions, with behavior unchanged. When there are no suggestions the whole block is not shown.

The two collapsed rows, other suggestions and workflow, share one title column width (the `titleMinWidth` of `Disclosure`), and the summaries start from the same left edge instead of being pushed right by text length; on narrow screens the summary is truncated to one line.

Once expanded, the left edge of the three lists (other suggestions, dismissed, workflow) matches the Skills list and is not indented (the `flush` of `Disclosure`). A Skill row has two lines: the first line the skill name (monospace), the second line the title (muted color); on the right the status chip and the card count are stacked vertically; the chevron is aligned with the first line.

### 2.5 Workflow (expanded by default)

Uses a Disclosure with the title "Workflow". The summary row always covers the last 7 days:

> 48 cards finished in the last 7 days · median 2 rounds back and forth · 15% passed first time · 16.3M tokens per card

- The definitions follow the second version: back-and-forth rounds and the first-pass rate are in second version §3.2, tokens per card in §3.4, all counted up to the first Done (`cardStats` in `shared/workflow-stats.ts`). While tokens have not been read yet "…" is shown, and when the read fails this item is omitted.
- With fewer than 3 finished cards, the summary changes to "Too few cards finished in the last 7 days".
- Once expanded there are only the per-model rows (second version §3.5): the model name, muted "2 rounds · 20.1M tokens", and on the right "27 cards".
- No window switch, no comparison with the previous 4 weeks, no per-week table, no put-in-place annotation, no headline sentence.

### 2.6 What is removed from the page

Attention per card (number of interventions), where time goes and the sources of interruption, the cost and quality panel (tokens per card moves into the summary of §2.5), process anomalies (R2/R3/R6), the per-week table and the put-in-place annotation, the headline sentence, the window switch, the daily record list (replaced by §2.2), and Agent habits (moved behind the developer switch, §6).

The corresponding computation code is deleted too if nothing else uses it, for example the attention, time, weeks, baseline and anomalies parts of `workflowStats`. The two data fields `byUser` and `tool` (second version §7) continue to be recorded: project memory and Agent habits use them too, and the cost is negligible.

## 3. Skill extraction

### 3.1 Run

- **One run together with Workflow insights**: the same switch, period, hour and model, and the same model call returns the skill drafts and the other suggestions together. Scheduling, the quiet-period skip, Run now, backfill, the temporary session (background workspace, hard-deleted at the end), parsing and retry all follow [WORKFLOW-INSIGHTS-SPEC](WORKFLOW-INSIGHTS-SPEC.md) §4.
- **On by default** (user decision 2026-10-25): the default of `workflowInsightsSettings.enabled` changes from `false` to `true`; the period stays weekly at 09:00 by default, and the model is Auto (Sonnet 5.5, then Sonnet 5).
  - The setting is host-level, and a value is stored only if the user has saved it. A user who never touched this switch (including existing users) becomes switched on; a user who explicitly turned it off stays off.
  - Command recording is on by default accordingly. This overturns the "off by default" of WORKFLOW-INSIGHTS-SPEC §11.1, which is noted there too.
  - The first time it is on, the last 7 days are backfilled (WORKFLOW-INSIGHTS-SPEC §3.3), and so for existing users after the upgrade: when the daemon starts and finds the effective switch value on but the project has no command records at all, it backfills once.
  - **The first scheduled run waits for a full period**: for a project with no run record at all, counting from the start of collection (backfill), the scheduled run happens only after `intervalDays` days. This way, on the day of the upgrade, Sonnet is not run once for every project before the user has seen What's new. Before that, the Skills section shows "Next analysis: <date>" and "Analyze now". In the implementation the time collection started (`collectingSince`) is recorded per project in `workflow-insights.json`. "Analyze now" is not subject to this limit.
- **Quiet period**: the run is skipped (recorded as skipped) only when both of the following conditions hold; if either does not hold the analysis goes ahead as usual, so that projects with few commands (docs, design, research) also get skills:
  1. the old rule of WORKFLOW-INSIGHTS-SPEC §4.1 judges it quiet (fewer than 50 new actions, or fewer than 2 cards and fewer than 200 actions);
  2. fewer than 3 cards have had turns since the last run (counted from the flow log).
- When the project has no command records at all, "Analyze now" is no longer recorded as "No commands collected yet." but analyzes as usual with the remaining material; it is recorded as skipped ("No recent activity.") only when not a single card has activity in the last 30 days.
- When validating card IDs (WORKFLOW-INSIGHTS-SPEC §4.4), the set of cards with activity in the last 30 days is used, no longer only the cards in the command window.
- Each run has at most 8 results, of which skill drafts are at most 3 (new drafts and updates together). Reason: a few complete skills at a time are easier to review than a pile of half-finished ones.
- Each ok run with valid results replaces the open entries by category: when there are new skill drafts only the open skill drafts are replaced, and when there are other suggestions only the open other suggestions are replaced. This way a run that produced only script suggestions does not clear skill drafts that have not been handled yet. Accepted and dismissed ones are not affected (following WORKFLOW-INSIGHTS-SPEC §5.3, "the new overwrites the old").

### 3.2 Material

In addition to the material of WORKFLOW-INSIGHTS-SPEC §4.2 (command statistics, repeated sequences, inline scripts, failed commands, existing configuration, closed suggestions), the following are added. They are all data Flowly already has, with no new collection:

1. **Cards of the last 30 days**: the cards that had turns or moved into Done in the last 30 days, one paragraph each: short ID, title, type, labels, current lane; the `target` and `recap` of the latest card summary (TASK-SUMMARY-SPEC), at most 600 characters together; the workpad's acceptance items, at most 5, each at most 120 characters.
2. **The user's own words**: the clues that project memory collects at the end of each turn (PROJECT-MEMORY-SPEC §4.0, `answer` / `feedback` / `message`). At most 8 per card, newest first, each at most 400 characters, and kept by the priority `answer`, `feedback`, `message`. Corrections like "wait for the CodeRabbit review to finish before merging" are here. When project memory is off there are no clues, and this section reads "(memory off)".
3. **Confirmed project memory**: one line per item, the title plus the first 300 characters of the body.
4. **Label clusters**: labels used by ≥3 cards in the last 30 days, written as the label, the card count and the short card IDs. This is a clue for domain-type skills, for example the 9 performance cards.
5. **Skills already in the project**:
   - scan `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` under the project root, deduplicated by realpath, writing each one's name and description (first 300 characters);
   - the skills Flowly added to the project (§4.5) additionally get their current full text attached, at most 6000 characters, for the model to judge whether to update.
6. **Closed skill drafts**: the accepted ones, and those dismissed within 30 days, each written as name and title.

The budget is still 150 000 characters in total. When exceeded, they are reduced in this order: inline scripts, failed commands, the user's own words (entries per card), the character count of card summaries, and finally the number of cards (dropping the earliest cards first).

### 3.3 Prompt (agent-facing text, English)

Modified from `workflowPrompt`. The description of the `skill` category is rewritten as follows, and the other categories are unchanged:

- Skills are of two kinds:
  - **Process**: a multi-step practice that recurs in ≥2 cards and requires judgment, for example PR delivery and merging;
  - **Domain knowledge**: measurement methods, common causes, pitfalls and standards accumulated for the same kind of work across ≥3 cards, for example Paseo plugin performance optimization.
- When the material shows that agents do the same thing inconsistently, or the user has corrected it, the skill must settle on one way and spell out the decision points, for example when to wait for CodeRabbit and what signal counts as the review being complete. The basis must cite short card IDs, counts and the user's own words.
- Do not copy into a skill a rule that AGENTS.md already states verbatim; but rules scattered across AGENTS.md, project memory and several cards can be integrated into one coherent process.
- Do not propose one-off fixes, practices that appear in only one card, or content already covered by an existing skill.
- Returned fields: `target: "skill"`, with `title`, `evidence` and `benefit` written in the output language, plus:
  - `skill.name`: lowercase hyphenated, at most 64 characters, not the same as an existing skill;
  - `skill.description`: English, 1–1024 characters, the first sentence starting with "Use when …", saying when to use it;
  - `skill.body`: English Markdown, 200–8000 characters, without frontmatter. In order it includes When to use, Steps, Commands (only commands that appeared in the material or existing scripts), Pitfalls, Sources (short card IDs). Use repository-relative paths, no absolute home paths, no secrets;
  - when updating an existing skill add `skill.updates: true`, with `skill.name` the existing name, `skill.body` the complete new version, and `skill.change` one sentence (in the output language) saying what changed. Update only when the material brings substantive new content.
- The skill body is in English: it is for agents to read (AGENTS.md: agent-facing text stays English), and it is consistent with `skills/flowly`. Row titles and the basis use the user's AI output language. This is my decision and can be overturned.

### 3.4 Validation (daemon, the model is not trusted)

In addition to the rules of WORKFLOW-INSIGHTS-SPEC §4.4 (card IDs, ≥2 cards, field lengths, deduplication, cooldown), the `skill` category must also satisfy:

- `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is at most 64 characters; `description` is 1–1024 characters; `body` is 200–8000 characters and does not start with `---`. Those that fail are dropped, not truncated.
- **New draft**: `name` must not be the same as an existing skill in the project (`.agents/skills/<name>` or `.claude/skills/<name>` already exists), nor the same as another draft in this run.
- **Update**: `name` must be a skill Flowly added to the project (§4.5), and the file must still exist; an update whose new body is identical to the current file's body is dropped.
- `redact` (WORKFLOW-INSIGHTS-SPEC §3.2) is applied to `description` and `body`. A draft that still contains `<secret>` or `<cred>` after redaction is dropped entirely: better one fewer than writing a possible secret into the repository.
- At most 3 skill drafts are kept each time, chosen by confidence.

### 3.5 Data

Changes to `workflow-insights.json`. Everything added is an optional field, `version` is unchanged, and old data gets defaults when read:

- `Finding` gains the optional field `skill: { name, description, body, updates?: boolean, change?: string }`, present only when `target === "skill"`. Old skill suggestions lack this field and are shown in the Skills section in the old WORKFLOW-INSIGHTS-SPEC style (title + proposal + Create card) until the next run replaces them.
- A new `installed: [{ projectId, name, findingId, at }]` records the skills Flowly added to the project. This is the only basis for deciding what is "Flowly's skill"; no marker is added in the file.
- A new `collectingSince: { [projectId]: ISO time }`, used for §3.1's "the first scheduled run waits for a full period".
- After the user deletes the file, the corresponding record in `installed` is cleaned up on the next read.
- Remove project backs up and deletes together with `installed`, following WORKFLOW-INSIGHTS-SPEC §5.1. Deleting the record does not delete the file in the repository.

## 4. Add to project

### 4.1 RPC

`workflow-insights.install-skill`: input `{ projectId, findingId, expectedRevision }`, output `{ revision, path, linked: boolean, notice?: string }`. Executed inside that project's serialized write.

### 4.2 Writing the file

1. The suggestion must belong to that project, have status open, `target` of `skill`, and have a `skill` field; otherwise the error is `FINDING_NOT_OPEN: …`. When `expectedRevision` does not match, `REVISION_CONFLICT` is reported.
2. The root is the project's native root `project.primaryPath`; when the directory does not exist, `PROJECT_ROOT_MISSING` is reported. A linked root created by the plugin is written the same way under that directory (PROJECT-PICKER-SPEC), and sessions started from there can all read it.
3. The target file is `<root>/.agents/skills/<name>/SKILL.md`:
   - new draft: when `<root>/.agents/skills/<name>` already exists, `SKILL_EXISTS: A skill named <name> is already in the project.` is reported and nothing is written;
   - update: the file must exist and `name` must be in `installed`, otherwise `SKILL_MISSING` is reported.
4. The file content is the frontmatter (`name`, `description`, generated by the daemon with safe YAML escaping), a blank line, and `body`, ending with a newline. First `mkdir -p`, then write a temporary file and rename it, replacing atomically.
5. It does not run git, does not commit, and does not touch `.gitignore`.

### 4.3 Symlink

`<root>/.claude/skills/<name>` points to the relative path `../../.agents/skills/<name>`. Only this one skill's link is created, not a link of the whole directory, so as not to affect the user's existing `.claude/skills/`.

| Current state | Handling |
| --- | --- |
| Does not exist | First `mkdir -p <root>/.claude/skills`, then create the link; `linked: true` |
| Already a link pointing to the same directory | Leave it; `linked: true` |
| Something else (a directory, a file, a link pointing elsewhere) | Leave it; `linked: false`, notice: ".claude/skills/<name> already exists; Claude Code keeps using it." |
| Creating the link fails (permissions, unsupported filesystem) | Do not copy, because the user asked for only one copy; `linked: false`, notice: "Could not link .claude/skills/<name>; Claude Code will not see this skill." |

### 4.4 How agents come to use it

No Flowly involvement is needed: Claude Code reads `.claude/skills/` and Codex reads `.agents/skills/`; both put the skill's name and description into the context and read the full text when needed. There are two limits, explained in the toast after "Add to project" succeeds:

- Until the file is committed, cards that use a worktree cannot see this skill, because a new worktree contains only committed content.
- A session that is already running may need a new session to discover the new skill (provider behavior).

The toast: "Added to the project. Commit .agents/skills/<name> and .claude/skills/<name> so worktrees and teammates get it."

### 4.5 After adding

- The suggestion is marked accepted (recording `acceptedSkill: name`), and a record in `installed` is added or refreshed.
- Later runs put this skill's current full text into the material (§3.2 item 5), and the model can propose updates (§3.3). It does not matter if the user edited the file by hand: the diff is against the current file, and it is overwritten only after the user confirms.
- Skills the user wrote themselves are not in `installed`, and Flowly never changes them.

### 4.6 View

The value of `workflow-insights.get` gains:
- `installed: [{ name, path, content }]`: the current file content, and this entry is omitted when reading fails;
- for each update draft, `current`: the current file's body, which the client uses to compute the diff.

The diff is computed by the client: a simple line-level LCS (tens of lines in scale), with no new dependency.

## 5. Settings and onboarding

- **Settings**: the "Workflow insights" group in Settings → AI is renamed **Skills**. The description text becomes: "Every week a model reads this project's cards, your messages and the commands agents ran, and drafts skills and scripts worth keeping. Spends tokens and keeps a local log of commands." The switch, model, frequency, hour, cost row and "Delete collected commands…" are all kept, with behavior unchanged. The switch in the project settings is renamed **Skills** as well.
- **Welcome tour page 4 (Insights)**:
  - The page description changes to: "See which days were busy, and turn what agents keep redoing into skills."
  - The example box is replaced with a small heatmap (a few weeks) and one skill-draft example line, replacing the second version's attention example, and the corresponding Legend is replaced too.
  - Switches: Insights, Daily digest, **Skills** (on by default, can be turned off here). The Skills switch's description drops "Off by default" and becomes: "A model reads your cards and commands each week and drafts skills. Spends tokens; model and schedule are in Settings." followed by the cost estimate.
- **One-time tip**: a new `first-skill-draft`. Condition: Insights and Skills are both on, the current project has an open skill draft, and Insights is not open. Text: "Insights drafted a skill from your cards. Open Insights to add it to the project." Its priority is placed before `first-workflow-insight`. The `insights-redesign` tip added by the second version never shipped and is simply deleted. `first-workflow-insight` stays, used only for other suggestions.
- **What's new**: a version is added at the top of `client/whats-new.ts`, with the content:
  - "Insights shows a year of activity; tap a day for its summary." (when 1.7.0 is released this becomes one sentence summarizing the whole revamp, see WHATS-NEW-SPEC §6)
  - "Insights drafts skills from your cards and adds them to the project when you say so. On by default; turn it off in Settings."

  With an **Open settings** button. Reason: existing users get it on by default, which is a "change existing users will not run into themselves" (AGENTS.md).
- The Insights highlight in both READMEs, the ONBOARDING-SPEC tip table, PROGRESS and SPEC-OUTLINE are updated in sync. WORKFLOW-INSIGHTS-SPEC notes which parts of §5.2, §8 and §11.1 are superseded by this spec. All new copy is added to all language catalogs, and removed copy is removed from all catalogs.

## 6. Agent habits becomes a developer switch

- The user's judgment on 2026-10-25: Agent habits is something Flowly developers care about, and ordinary users do not need it.
- A new host setting `developer` (`shared/settings.ts`) with only one field `agentHabits: boolean`, default `false`. Like the timing log of `performance`, it has no settings page: to turn it on, write `{"version":1,"values":{"agentHabits":true}}` to `~/.paseo/plugin-settings/flowly/developer.json` and then reload the plugin.
- When on, the Agent habits section is shown at the very bottom of the page, with unchanged content (WORKFLOW-INSIGHTS-SPEC §12.6); when off, `insights.project` does not compute habits.
- Recording is not affected by the switch: fields such as `model`, `pick` and `offered` are written as usual, and after turning it on the full history is visible.
- This is my decision and can be overturned.

## 7. RPC and data

- `insights.project`: input `{ projectId, tz, etag? }`, with `end` and the window removed. It returns:
  ```
  { today,
    activity: { from, days: [{ day, turns, cards, done: string[] }], levels: [q1, q2, q3] },   // only days with activity are listed
    workflow: { finished, rounds: { median }, onePassShare, models: [{ model, cards, rounds }] }, // last 7 days
    habits?  // only present when the developer switch is on
  }
  ```
  `done` is the IDs of cards moved into Done that day, with the same card listed only once a day. The etag is determined by the length and mtime of the flow log, today's date and the developer switch.
- `insights.tokens`: keeps only the per-card tokens and per-model values of cards finished in the last 7 days, that is the part used by §2.5.
- `insights.day`: input `{ projectId, tz, day, tokens? }`. It returns `{ day, turns, agentMs, tokens?, list: [{ taskId, turns, agentMs, tokens?, done }] }` (the number of cards and completed cards are derived from `list`); `tokens` is given only when the input has `tokens: true`, after reading the local logs, and is empty when it cannot be read. The pure functions are in `shared/day-detail.ts`.
- `insights.digest`, `insights.digest-refresh`: unchanged. `insights.digests` (the headline list) is removed.
- `workflow-insights.get`: gains the fields of §4.6. `workflow-insights.install-skill`: new, see §4.1.
- Computation lives in pure functions: `shared/activity.ts` (heatmap aggregation and leveling), `shared/workflow-insights.ts` (the skill material, prompt, validation).

### 7.1 Relation to the SQLite storage migration (R1)

The user decided on 2026-10-25: **this version merges first**, implemented on the current JSON storage. Before SQLite R1 ([SQLITE-STORAGE-SPEC](SQLITE-STORAGE-SPEC.md)) switches over real data, it must add what this version adds to its schema and its write-method allowlist; otherwise `installed` would be treated as an unknown field and put into the read-only reserved area, and Flowly would never again recognize the skills it added to the project. What R1 needs to add:

- `workflow-insights.json`: the root-level `installed` and `collectingSince`; a finding's `skill` (`name`, `description`, `body`, `updates`, `change`) and `acceptedSkill`;
- the new write method `workflow-insights.install-skill`. It writes a file in the project directory, which is a write with an external side effect, and must be handled by R1's rules for such operations;
- `digests.json` keeps 400 days per project (was 60 days);
- the etag of `insights.project` depends on the flow log's length and mtime. After R1 moves the flow log into SQLite, it must be replaced with the corresponding revision number.

On delivery an idea will be raised to hand this list to the SQLite card.

## 8. Acceptance

**Unit tests**
- Heatmap: day cut by time zone (across midnight); 53 columns, starting on Monday, future days do not appear; quantile leveling (including all zeros, and only 1–3 non-zero days); `done` deduplication; only the flow log is used.
- Material: the selection of cards of the last 30 days; the count and priority of clues; the label-cluster threshold; the scan of existing skills and realpath deduplication; the trimming order when over budget.
- Validation: name format; length; the same name as an existing skill; an update target must be in `installed`; an update with an identical body is dropped; a draft that still contains a secret after redaction is dropped entirely; at most 3; cooldown.
- Replacement: a run with only other suggestions does not clear open skill drafts, and vice versa.
- Add to project: the written content and frontmatter escaping; atomic writes; nothing is written on `SKILL_EXISTS`; overwrite on update; the four symlink cases; accepted and the `installed` record; cleaning up the record after the file is deleted.
- Settings: on by default when never saved; kept off when `false` was saved.
- Scheduling: a project with no run record does not run on schedule before `collectingSince` has been a full period, and Run now is not limited; the quiet period skips only when both conditions hold; Run now still analyzes when there are no command records.
- Daily summary: selecting several days in a row for the same project generates only the one in progress and the last selected one; retention of 400 days.
- The rules of the tip `first-skill-draft` (`client/onboarding-logic.test.ts`); i18n completeness (`npm test`).

**Checks**: `npm run typecheck`, `npm test`. Run on an isolated worktree that contains only this card's changes.

**Live runs**
- After reloading the plugin, Run now on the Flowly project (Auto model). Expected: at least one of the user's two examples (PR delivery and CodeRabbit, Paseo plugin performance optimization) appears among the skill drafts, with a basis that cites real cards. Record tokens and cost. Skills in the Flowly repository are not added during the test; the user decides.
- Add a skill on Tinylink and check the file, the symlink and the toast; after the test, delete the files and links the test wrote (Tinylink is a permanent fixture, so only what the test itself wrote is cleaned up).
- Take screenshots with `docs/promo/shot-lib.mjs`: desktop light and dark, the compact layout (heatmap scrolling horizontally), and a day's summary before and after generation, saved under `docs/verification/`.
- Per AGENTS.md, test live with an explicit full-access `codex/gpt-6-luna` test session, including the phone's native layout.

## 9. Left for the implementer to decide

The component split, spacing, the specific layout of empty states, the details of the diff algorithm, the interpolation method of the quantiles, and whether the heatmap gets a hover hint on web (RN has no native tooltip, so it can be skipped).

## 10. Decision record

1. 2026-10-22 first version (output statistics, number blocks + charts): rejected by the user, who said (their words, translated): "it should not be a mechanism that makes users anxious and encourages them to grind". The first version was not committed.
2. 2026-10-22 second version (evaluating only the workflow: number of interventions, back-and-forth rounds, where time goes, cost per card, a per-week table; no charts): implemented on `feat/insights-redesign`, not merged. On 2026-10-25 the user's assessment was "mediocre" (their word, translated), see §0. Kept from the second version: back-and-forth rounds, first-pass rate, tokens per card, per model (all gathered into §2.5), and the two data fields `byUser` and `tool`.
3. 2026-10-25 third-version direction (user): add project activity back, as a GitHub-style heatmap; skills are Insights' main capability.
   - This overturns two principles of the second version: "do not look by day" and "no charts". What is kept is "do not create anxiety": no streak counts, no big totals, no rankings.
4. 2026-10-25 skills go in the project directory (user): `.agents/skills/<name>/` holds the real files and `.claude/skills/<name>` is a symlink, with only one copy stored. Creating the link per single skill is my decision.
5. 2026-10-25 the layout, the green heatmap, and the workflow numbers kept and collapsed by default (confirmed by the user after seeing the mockup). On 2026-10-26 changed to workflow expanded by default, see item 8.
6. 2026-10-25 skill extraction on by default (user), and it can be turned off in the welcome tour and in settings. This overturns the "off by default" of WORKFLOW-INSIGHTS-SPEC §11.1.
7. 2026-10-25 this version merges before SQLite R1 (user), and R1 is responsible for adding the list in §7.1.
8. Decisions I made (can be overturned):
   - activity is counted in turns;
   - merged with Workflow insights into one run;
   - the skill body is in English;
   - at most 3 skill drafts each time;
   - the user's own words reuse project memory's clues, with no new collection;
   - Flowly only updates the skills it added to the project itself;
   - Agent habits sits behind a developer setting with no UI;
   - past days generate a summary automatically when selected, and today's must be generated manually; only one is generated at a time per project; summaries are kept for 400 days;
   - the first scheduled run waits for a full period; the quiet period looks at both the command count and the number of cards with activity.

## 11. Implementation plan

Done on the branch `feat/insights-v3` (cut from `origin/main` b2e9c40, first cherry-picking the second-version commit 8176912), changed and tested in an independent worktree, without touching the main working tree.

1. **Activity and the day**
   - New file `shared/activity.ts`: aggregates turn counts, cards with action and completed cards by day from the flow log, computes the quantile levels, with unit tests.
   - `project()` in `server/insights.ts` changes to return `{ today, activity, workflow, habits? }`, dropping the git read, the running-session query and the `end` window.
   - `DIGEST_DAYS` in `shared/digest.ts` changes to 400; the digest changes to generate only one at a time per project, and remembers the last selected day.
2. **Slimming the workflow summary**: `shared/workflow-stats.ts` keeps only the last 7 days' finished count, back-and-forth rounds, first-pass rate, the grouping by model, and the card list needed for the token computation, and deletes attention, time, weeks, baseline, anomalies and landed. The corresponding tests change too.
3. **Developer switch**: add `developerSettings` in `shared/settings.ts`; `project()` computes habits only when the switch is on.
4. **Skill data and pure functions** (`shared/workflow-insights.ts`):
   - the setting defaults to on;
   - a finding gains the two fields `skill` and `acceptedSkill`, and the state gains `installed` and `collectingSince`;
   - the material gains five sections, cards, the user's own words, memory, label clusters and existing skills, with trimming;
   - change the prompt and the parsing;
   - skill validation, plus replacing open entries by category;
   - change the quiet-period rule, and add the rule that the first scheduled run waits for a full period;
   - generate the SKILL.md text, and compute the line-level diff for the client.
5. **Server** (`server/workflow-insights.ts`):
   - collect the new material: card summaries, memory clues and entries, the project's skill directories;
   - the scheduling changes; Run now still analyzes when there are no command records;
   - new `installSkill` (write the file, create the symlink, record installed), and the view gains `installed` and `current`;
   - wire these changes into the RPC and `index.server.ts`.
6. **Client**:
   - rewrite `client/insights.tsx`, with the heatmap, the day, Skills, other suggestions, workflow, and last habits, shown only when the developer switch is on;
   - `client/queries.ts` drops the headline query;
   - the settings group is renamed Skills;
   - welcome tour page 4;
   - add the tip `first-skill-draft` and delete `insights-redesign`;
   - add one What's new entry.
7. **Copy and docs**:
   - the new copy goes into all 9 language catalogs, and removed copy is cleaned out of the catalogs;
   - sync both READMEs, the ONBOARDING-SPEC tip table, PROGRESS and SPEC-OUTLINE, and note in WORKFLOW-INSIGHTS-SPEC which parts are superseded by this spec.
8. **Checks**: run `npm run typecheck` and `npm test` in the worktree. The live runs (reload, Run now, Tinylink, screenshots, Luna) need this branch's code installed on this machine, and the user's consent is asked first.
8. 2026-10-26 the page is too empty (user): the lower half of the page is blank, so "workflow expanded by default" was chosen, and a last-7-days list was added (§2.2); other suggestions stay collapsed by default. This overturns the "collapsed by default" of the workflow in item 5. The user also asked me to see what else could be added: the candidates (this week's finished cards by label distribution, this week's confirmed project memory, this week's busiest cards) are not done for now, see PROGRESS, until the user chooses.
9. 2026-10-26 daily summary (user): the day panel becomes a daily summary card that can be paged left and right, containing the summary, the task list, turns, tokens and time, with tasks visually distinguished by complexity (time, turns); tapping the heatmap can also change the day. This replaces the "last 7 days" list in item 8. Paging jumping only to days with activity, and using a horizontal bar for complexity, are my decisions.
