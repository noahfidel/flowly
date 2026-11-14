# Workflow insights: finding reusable scripts, tools and processes in an agent's commands

> 2026-10-28: parts of this document are superseded by [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) (§12). Superseded: nothing; the command log in §3.2 gains one more consumer (the weekly re-identification in GUARDRAILS-SPEC §4.5).

Status: **implemented, awaiting user acceptance** (2026-10-19, card `3df1723e` "Paseo project settings interoperability"; the user confirmed this spec and all the decisions in §11 the same day). The user confirmed the direction: "make this insights feature a switch, and also add a model setting and an analysis-period setting; if tokens are plentiful it can be set to run daily, and if not the period can be stretched". This spec extends [PROJECT-INSIGHTS-SPEC](PROJECT-INSIGHTS-SPEC.md) and does not change its existing behavior.

> 2026-10-25: the third version, [INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md), supersedes the following parts of this document: the default switch in §2 (now on by default) and the setting name (now Skills), the quiet period and the first-run timing in §4.1, the material in §4.2 (new: cards, the user's own words, memory, existing skills), the skill-type prompt in §4.3, the skill validation in §4.4, the section placement in §5.2 (skill drafts go into the Skills section, the rest into "Other suggestions"), the replacement in §5.3 (now per category), the tip in §8 and §11.1.


## 1. Purpose and basis

Agents repeatedly type the same commands by hand in cards, repeatedly write the same kind of inline script, and repeatedly work out the same process. Workflow insights periodically scans the shell commands that the sessions of this project's cards actually ran, finds what is worth keeping, and, once the user confirms, turns it into a card to put in place, so later tasks can reuse it directly.

Two read-only probes on the Flowly project on 2026-10-19 (recorded in the card's progress; the raw commands were not saved to disk):

| | 72 h rule-based statistics | 7 days + `claude/claude-sonnet-5` |
| --- | --- | --- |
| Scale | 18 sessions / 18 cards / 941 shell calls | 44 sessions / 33 cards / 4778 calls, 1364 distinct inline scripts |
| Conclusion | 76% are exploration commands; only 1–2 suggestions came out, already written in AGENTS.md (verify) | 6 findings, only 1 of which belongs in `paseo.json`: an i18n entry script, Playwright as a formal dependency + a shared browser module, a board data viewing script, verify/redeploy, a doc sync checklist, a fixture cleanup checklist |
| Cost | 0 | one run of 267 s, about $0.80 (168k context tokens, 22k output) |

The design trade-offs that follow from this:

- **Rules collect, count and filter; the LLM interprets** (especially the purpose of inline scripts), and the suggestion target is not limited to `paseo.json`.
- **The LLM must not run every turn or every time a page is opened**: it only makes sense on data spanning several cards, and a single run is not cheap. So it is a scheduled job, and the user picks the period to match their token budget.
- **Off by default**: it spends tokens and also collects a command log.

## 2. Settings

### 2.1 Global (host) setting `workflow-insights`

The new setting definition (`shared/workflow-insights.ts`), `scope: "host"`, `version: 1`:

| Field | Type / default | Meaning |
| --- | --- | --- |
| `enabled` | boolean, `false` | Master switch: collect the command log and analyze it periodically |
| `model` | string ≤200, `""` | `provider/model`; empty means Auto |
| `intervalDays` | `1 \| 3 \| 7 \| 14`, `7` | Analysis period: daily / every 3 days / weekly / every two weeks |
| `runHour` | 0–23, `9` | On the due day, run after this hour of local time |
| `timeZone` | string ≤64, `""` | The client writes the device's IANA time zone automatically when it saves the setting; when invalid or empty the daemon's local time zone is used |

- **Auto model**: take the first available of `claude/claude-sonnet-5-5` and `claude/claude-sonnet-5`, and when neither exists use what the Summary model resolves to (TASK-SUMMARY-SPEC §4). Reason: a cheap summary model is not enough to generalize patterns across cards, and the probe used Sonnet 5.
- When the configured model is unavailable, this run is recorded as the error "Workflow insights model … is not available." and no other model is substituted.
- When old data lacks a field it is read with the default (same as `summarySettingsValues`).

### 2.2 Project setting

`Project.workflowInsights?: boolean`, absent is treated as included (same as `Project.workpad`). The project settings show a switch **Workflow insights** with the description "Include this project when workflow insights run." When it is turned off:
- the project is no longer collected and no longer analyzed on schedule, and the Insights page section shows that it is turned off;
- existing records and suggestions are kept;
- a manual Run now is still available.

### 2.3 Settings UI

Settings → AI gets a new group **Workflow insights**, with the description text: "Every few days, a model reads the shell commands agents ran on this project's cards and suggests scripts, tools and rules worth keeping. Off by default: it spends tokens and keeps a log of commands."

1. The switch **Workflow insights**.
2. **Model**: a Provider / Model picker that behaves like the Summary model; Auto shows "Auto (Sonnet 5.5, then Sonnet 5)".
3. **How often**: the options Daily / Every 3 days / Weekly / Every 2 weeks, with the secondary text "Daily needs plenty of tokens; longer periods cost less and still catch repeated work."
4. **Run after**: an hour picker, for example 09:00.
5. Read-only rows:
   - "Looks at the last N days of commands." (N is in §4.1);
   - once there has been a run, "Last run: 168k in · 22k out · $0.80. About $X per month for N projects at this pace."
     - "in" is the number of tokens in the context at the end of the run. Claude's `inputTokens` counts only the uncached part and would read too small on its own.
     - Monthly estimate = the cost of one period × 30 / `intervalDays`. The cost of one period is the sum, over **every project that is still included**, of that project's most recent run with a cost record in the last 30 days (`cycleCostUsd` and `costProjects` of `workflow-insights.overview`). From 2026-10-21; before that only one run of one project was used, which undercounted by half when two projects ran daily.
     - When there is no cost data only tokens are shown.
6. A button **Delete collected commands…** which, after confirmation, clears the command log of all projects (§3.4); keeping the suggestions is recommended.

The prompt when the switch goes from off to on: "Collecting starts now; the last 7 days are read once from the sessions' history." (§3.3)

## 3. Command log (collection)

### 3.1 Source

- The `agent.turn_ended` hook provides this turn's timeline (`index.server.ts` already hands it to the workpad and the summary). Take the entries with `type: "tool_call"` and `detail.type === "shell"`; collection happens asynchronously after the hook returns and does not block the hook.
- Scope: all sessions in the workspaces of this project's cards (consistent with the probe). Summarizer sessions (label `flowly=summarizer` (kept for compatibility with the existing old label)) are not collected: the hook looks up the agent's labels once when needed and caches them.
- Time: the timeline entries the hook gives for this turn have no timestamp, so they are recorded with the time the turn ended; the backfill uses each entry's own timestamp.
- Granularity: one record per shell call, with id `<agentId>:<callId>`; the same call obtained from the hook and from the backfill is recorded only once.
- Lane: the record holds the lane the card was in **when the command happened**, that is the `task.status` at the time the hook runs; for the backfill, the lane at that time is taken by replaying the flow log.
- Known limitation: Claude's shell entries have only `command` and `output`, **no `cwd` and no `exitCode`**, so success is judged only by the entry's status (completed/failed). The format of Codex's shell entries has not yet been checked on real data; the code handles generic fields, and missing fields are recorded as empty.

### 3.2 Normalization and redaction (pure functions, `shared/workflow-insights.ts`)

Each command is split at top-level `&&`, `||`, `;`, `|` and newlines, respecting quotes, `$( )` and heredocs. Each segment is classified:

- **skip**: `cd`/`pushd`/`popd`; pure environment variable assignments; shell syntax fragments, including `{ } break continue esac case`, case branches ending in `)`, function definitions, and commands starting with a `$variable`. The first probe round produced 8 kinds of such fake commands; after the fix there were 0.
- **explore**: read-only or exploration commands (ls, cat, head, tail, sed, grep, rg, find, wc, jq, …) and `git status/diff/log/show/…`. They are only counted, and the most-read files are counted separately.
- **action**: all other commands, which produce a normalized key:
  - strip a leading `sudo`, `time`, `env`, `nohup`; drop the arguments of `git -c`/`-C`;
  - npm/pnpm/yarn/bun are normalized to `npm run <script>`, `npm test`, `npm install`; `npx tsc` → `npm run typecheck`, `npx vitest` → `npm test`, merged this way only when package.json has the corresponding script;
  - `node`/`python3` are normalized to `<runtime> <script relative path>`, inline code is recorded as `<runtime> <inline>`, and scripts under a temporary directory as `<tmp-script>`;
  - `paseo` keeps the first 3 positional arguments, with IDs replaced by `<id>`;
  - other commands keep the command name and at most 2 positional arguments.
- **inline excerpt**: for inline scripts such as `python3 - <<…` and `node -e`, an excerpt is saved separately, redacted and then truncated to 560 characters. This is the only command body that is saved, because the LLM needs to read it to judge the purpose.
- **Redaction** (applied to both the key and the excerpt, **redact first, then write to disk**):
  - the repository path is replaced with `.`, the home directory with `~`, and the temporary directory with `<tmp>`;
  - email addresses are replaced with `<email>`; credentials in URLs with `<cred>`;
  - `eyJ…`, `ghp_…`, `sk-…` and random strings of ≥40 characters are replaced with `<secret>`;
  - the assigned values of variables such as `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*AUTH*`, and the value after `Authorization: Bearer`, are replaced with `<v>`.
- Command output (`output`) is never saved.

### 3.3 Backfill

When the master switch goes from off to on, or a project's switch goes from off to on, the daemon uses the SDK (`agents.list` + `agents.ref(id).timeline.refetch`, read-only) to backfill the last 7 days of records for that project:
- concurrency of at most 2; deduplicated by id;
- a failure records only one warning;
- the Insights section shows "Reading recent sessions…" during the backfill.

### 3.4 Storage

- File: `commands/<projectId>.jsonl` (in the same directory as `board.json`), one shell call per line: `{ id, at, taskId, agentId, lane, provider, status, actions, explore, files?, inline?, failed? }`.
  - `status`: completed / failed / other.
  - `actions`: the normalized keys of each action segment, in order of appearance.
  - `explore`: the number of exploration segments; `files`: the files read by the exploration segments, at most 4.
  - `inline`: the inline script excerpt; `failed`: the redacted command of a failed call, at most 260 characters.
- Writes: appended serially per project; invalid lines in the file are skipped and the file is not reset.
- Retention: the last 30 days. Trimmed on the first write each day; trimming is done by writing a temporary file and replacing it atomically.
- Deletion:
  - permanently deleting a card: rewrite the log without that card's records, and write the removed lines to `removed/task-<id>-commands-<time>.jsonl` (same as TASK-DELETE-SPEC);
  - Remove project: the whole file moves to `removed/`;
  - **Delete collected commands…**: delete `commands/*.jsonl` for all projects with no backup, because this is a privacy operation the user explicitly asked for;
  - turning the switch off only stops collection and does not delete existing records.

## 4. Analysis run

### 4.1 Scheduling

- The daemon checks every 15 minutes. A project is due when all of the following hold:
  1. the master switch is on, the project switch is not false, and the project is not archived;
  2. the current local time is past `runHour`;
  3. the time since this project's last run (successful, skipped or failed all count) is ≥ `intervalDays` days. The comparison is by local date, so Daily runs at most once a day.
- A run missed while the daemon was down is made up once after startup, not several times.
- Only one analysis runs at a time across all projects, queued by last-run time ascending.
- Analysis window: `windowDays = max(7, intervalDays)`, at most 14 days.
- **Quiet-period skip**: in either of the following cases the model is not called, and this run is recorded as skipped with the reason "Not enough new activity", and still counts as a run (the period restarts):
  - fewer than 50 new actions since the last run;
  - fewer than 2 cards involved in the window and fewer than 200 new actions.

  From 2026-10-21; before that the threshold was 3 cards, which meant Agent SMITH (2 cards, 990 actions in two days) was never analyzed.
- **Run now** (Insights section):
  - Can be run manually at any time, including when the master switch is off, and is not subject to the quiet-period rule.
  - When the project has no command records yet (for example because the switch was never on), the last 7 days are backfilled first and then analyzed; if there are still no commands after the backfill, the run is recorded as skipped ("No commands collected yet.").
  - When a run is already in progress for the project, the button shows Analyzing….
- In the following two cases the scheduled check simply skips, does not record a run, and so does not use up the period:
  - the project has no command records at all;
  - the project is being backfilled (the check made before the backfill finishes, right after the switch is turned on).

### 4.2 Material (produced by rules, pure functions)

Concatenated in the following order, with a total length of no more than **150 000 characters**; when over, the number of inline excerpts and then the number of failed commands are reduced in turn:

1. Overview: the window, the number of sessions, cards and calls, and the explore/action/skip counts.
2. Card list: short ID (first 8 characters), title, type, labels, current lane.
3. Existing configuration: the `scripts` and `worktree` parts of `paseo.json` at the project root (read straight from the file, no internal API needed); the `scripts` of `package.json`; the Commands section of `AGENTS.md` or `CLAUDE.md` in the root (at most 4000 characters).
4. The action key table (top 60): number of runs, cards, sessions, failures, and the main lane.
5. Repeated sequences: consecutive, distinct action keys within one session form 2–4-tuples, counted by the number of distinct sessions they appear in; take the top 25 with ≥3.
6. The most-read files, top 30.
7. Failed commands, at most 60, each 260 characters.
8. Inline excerpts: deduplicated by their first 240 characters, then **sampled round-robin by card** (to avoid concentration in a few long sessions), at most 280.
9. Closed suggestions: this project's accepted suggestions, and the dismissed ones within 30 days, one line each: `status · target: title — first 160 characters of the proposal`, and the model is asked not to propose them again (§5.3). Open suggestions are not put into the material, because this run's result replaces them.

### 4.3 Model call

- Same as the daily summary (PROJECT-INSIGHTS-SPEC §7):
  - create a temporary session in the project's "Flowly background" workspace (restored/reused before use, archived after use, never the card's workspace; [BACKGROUND-WORKSPACE-SPEC](BACKGROUND-WORKSPACE-SPEC.md));
  - labels `flowly=summarizer` (kept for compatibility with the existing old label), `flowly-project=<id>`, `flowly-insight=workflow`;
  - `waitForFinish(900000)` (15 minutes); afterwards, in a `finally`, **hard-delete** the session (`daemonRemoveAgent`, per the AGENTS.md 2026-10-22 exception, extended on 2026-10-23 to this run; only the id just created is deleted, and when the delete fails it falls back to archiving and logs it).
- The prompt (English, agent-facing) in outline:
  - the five target categories to choose from: `paseo_script`, `worktree_setup`, `repo_tool`, `agents_md`, `skill`;
  - every conclusion must cite short card IDs and counts; do not recommend things that already exist, unless combining them saves effort; git write operations and one-off exploration are not turned into scripts; focus on interpreting the purpose of inline scripts; at most 8 findings; state confidence honestly;
  - the accepted or dismissed suggestions that are listed must not be proposed again, not even reworded or narrowed; this run's result replaces the open suggestions left by earlier runs, so list everything that is still worth doing, not only new discoveries;
  `{ findings: [{ target, title, evidence, proposal, benefit, confidence: "high"|"medium"|"low", cards: string[] }], noise, verdict }`.
  It is also passed in as an `outputSchema`, but **Claude does not enforce it**: the probe returned markdown.
- Parsing: take the JSON with `firstObject`, compatible with code blocks and string arrays. When none can be found, append a message "Reply again with only the JSON object described above." in the same session and retry once; if it still fails, this run is recorded as the error "The workflow insights model returned no JSON.".
- Record `lastUsage` (input, cache and output tokens, plus the cost the provider gives).

### 4.4 Validation (daemon; the model's counts and IDs are not trusted)

- A short ID in `cards` must map to a card of this project that has records in this window; those that do not match are dropped. A suggestion with fewer than 2 valid cards is dropped; when the window has only 1 card, citing that 1 card is enough.
- A suggestion that duplicates an accepted one or a dismissed one within 30 days is dropped: the fingerprint (target + normalized title) is the same, or the titles are similar (the same target with similarity ≥ 0.6, or any target with similarity ≥ 0.7; similarity is the Jaccard coefficient of the titles, counting English by word and Chinese, Japanese and Korean characters by adjacent pairs). Open suggestions do not take part in the comparison, because they will be replaced (§5.3).
- Suggestions within the same run are compared the same way, to avoid two identical ones.
- Each field has a length limit: title 120, evidence 1000, proposal 4000, benefit 500; a suggestion over the limit is dropped, not truncated.
- At most 8 are kept. When all are dropped, this run is recorded as ok with the result "No suggestions this time", and the earlier open suggestions are kept (§5.3).
- All of the above is computed within the same serialized write that writes `workflow-insights.json`, against the suggestion states at the moment of writing, so a suggestion the user has just dismissed during the run is not added back.

## 5. Suggestions and putting them in place

### 5.1 Data

The file `workflow-insights.json`, written serially, backed up before writing, replaced atomically; when the file is invalid the original is kept and an error is reported. Structure:

```
{ version: 1,
  runs: [{ id, projectId, at, from, to, model, status: "ok"|"skipped"|"error", reason?, usage?,
           findings, replaced, stats: { calls, actions, cards, sessions } }],
  findings: [{ id, projectId, runId, fingerprint, target, title, evidence, proposal, benefit, confidence, cards[],
               status: "open"|"accepted"|"dismissed", acceptedTaskId?, createdAt, updatedAt }],
  revision }
```

- The last 20 runs are kept per project. Accepted and dismissed suggestions are kept for 90 days, and open ones are kept indefinitely.
- Remove project backs up to `removed/` before deleting. When a card is permanently deleted, the `acceptedTaskId` pointing to it is cleared, and the suggestion itself is kept, still with status accepted.

### 5.2 Insights page section

After Summary and before Token use on the Insights page, a new section **Workflow insights** is added, shown in both the desktop and the compact layout:

- Header: "Last run · date · model · window N days", with tokens and cost; while a run is in progress it shows "Analyzing…"; during a backfill it shows "Reading recent sessions…"; there are also **Run now** and a gear button (opens Settings → AI).
- Off state: shows one line of explanation and a **Turn on** button that opens the settings group; no empty list is shown.
- Skipped or error: the reason is shown de-emphasized on one line, for example "Skipped: not enough new activity", or the error message.
- Suggestion cards, sorted by confidence and then createdAt. Each shows:
  - a target chip: paseo.json script / Worktree setup / Repo tool / AGENTS.md / Skill;
  - the title, the evidence (clickable card references that open the card sidebar), and the benefit;
  - the proposal is collapsed by default and shown in a monospace font when expanded;
  - the AI star mark (AI-MARK-SPEC).
- Actions:
  - **Create card**: opens the New task form prefilled with:
    - the title;
    - the description: the proposal, the benefit, the evidence, and the titles of the cited cards, plus the put-in-place note;
    - type `chore`;
    - label `agent-workflow`, and for the paseo.json and worktree setup categories also `paseo-json`.

    `tasks.create` gains an optional `insightFindingId`, handled in two steps:
    1. before the workspace is created, check that the suggestion is still open, otherwise the whole operation fails;
    2. after the card is written, mark the suggestion accepted and record `acceptedTaskId`.

    The suggestion lives in `workflow-insights.json`, not in `board.json`, so these two steps are not in the same write. When the second step fails, the card is still created as usual, the suggestion stays open, and it is logged. When the same operationId is replayed the check is not made again and only the accepted mark is added.
  - **Dismiss** / **Restore**.
  - An accepted suggestion shows "Card created", and clicking it opens that card.
- Put-in-place note: appended automatically to the end of the description according to the target, for the agent that takes over the card.
  - `paseo_script` / `worktree_setup`: "Add it to paseo.json at the project root, run it once with `paseo script start <name>` (or create a worktree to test setup), and commit: worktree setup only reads the committed paseo.json."
  - `repo_tool`: "Add the tool, mention it in AGENTS.md Commands, and replace one real use to prove it works."
  - `agents_md` / `skill`: "Write it, then check it against the cited cards."
- Data reads: queried only while the Insights page is open, with an etag. No polling after the page closes. While a run is in progress it is queried every 10 seconds.

### 5.3 Each run replaces the open suggestions

User decision (2026-10-21): suggestions do not accumulate; the result of the new run overwrites the old.

- **Replace**: as long as an ok run yields at least 1 valid suggestion, all open suggestions of this project are deleted and replaced with this run's result. `runs[].replaced` records how many were deleted.
- **Do not clear**: when there is not a single valid suggestion (the model gave none, or all were dropped by validation), the earlier open suggestions are kept, so that one failed reply does not empty the list. Skipped and error runs leave the suggestions alone.
- **Keep**: accepted (card created, with `acceptedTaskId`) and dismissed suggestions are not affected by replacement.
- **Cooldown**: a dismissed suggestion does not reappear for 30 days (§4.4) and after that can be proposed again as a new suggestion; an accepted one does not reappear. Both are written into the material as "status · target: title — proposal" so that the model does not propose them again.
- **Cost**: the model's result fluctuates from run to run. A suggestion that is still useful but is not mentioned this time disappears, and has to wait to be proposed again; to keep it, create a card while it is still there. The longer the period (for example weekly), the less this fluctuation.
- **Why**: earlier attempts had the model mark `updates`/`merges` to refresh existing suggestions, and required a new suggestion to state how it differs from the closest one (PR #8, #10). Duplicates did decrease, but the mechanism was complex and the model still treated a narrowed version as a new suggestion. Replacement is simple, and the list always reflects only the latest analysis.
- **Compatibility**: the `seen`, `lastSeenAt`, `refreshed` and `merged` fields in old data are ignored when read. The next run that has results replaces the old open suggestions, including the duplicates accumulated before.

### 5.4 Letting agents use existing scripts

The card session's context file (`tools.sessionContext`) and `flowly_get_task` gain a field `projectScripts`:
- Content: the names and types of the scripts in the project root's `paseo.json`, at most 20, **without the command body**;
- the skill (both copies) gains one sentence: "When projectScripts lists a script for what you are about to do, run it with `paseo script start <name>` instead of retyping the commands."
- This is independent of the master switch: it is provided whenever the project has a `paseo.json`. The field does not appear when there is no such file.

## 6. RPC

| Method | Input | Output |
| --- | --- | --- |
| `workflow-insights.get` | `{ projectId, etag? }` | `{ etag, value? }`; value = `{ enabled, projectEnabled, backfilling, running, nextRunAt \| null, windowDays, lastRun \| null, findings[], revision }` |
| `workflow-insights.run` | `{ projectId }` | `{ queued: true }`, or `{ queued: false }` when a run is already in progress |
| `workflow-insights.set-status` | `{ projectId, findingId, status: "open"\|"dismissed", expectedRevision }` | `{ revision }`; when the revision does not match the error is `REVISION_CONFLICT: …`; a suggestion that already has a card cannot be changed any more |
| `workflow-insights.overview` | `{}` | `{ lastRun \| null, collected }`, used for the cost row on the settings page and the number of collected projects |
| `workflow-insights.purge` | `{}` | `{ deletedProjects }` |
| `tasks.create` (existing) | gains an optional `insightFindingId` | unchanged; the whole write fails when the suggestion does not exist, does not belong to this project, or is not open |

All inputs are validated with zod; daemon error messages are in English.

## 7. Privacy and security

- Only shell commands are collected. Command output and the content of other tool calls (file reads and writes, edits) are not collected.
- Redaction happens before anything is written to disk (§3.2); tokens, credentials or full command bodies do not appear in logs.
- The material sent to the model is exactly these redacted records. The model is the user's own configured provider, in the same account system as the agent that wrote the commands.
- No new internal API: reading `paseo.json` is reading an ordinary file; reading the timeline and creating sessions use the plugin SDK (`PaseoApi`).
- A suggestion never executes anything automatically, nor creates a card or modifies a file automatically. Creating a card needs the user to click Create card.

## 8. Onboarding, copy and docs

- The welcome page's feature list gains a row *Workflow insights* after *Project insights*: "Optional: on a schedule you choose, a model reads the commands agents ran and suggests scripts, tools and rules worth keeping."
- New tip `first-workflow-insight`:
  - Shown when: the feature is on, the current project has open suggestions, and neither the Insights page nor the Ideas page is open. The board reads the suggestions once for the current project, only while this tip has not been seen yet, and does not poll;
  - Text: "Workflow insights found repeated work worth keeping. Open Insights to turn a suggestion into a card.";
  - Priority: after `first-idea` and before `first-artifact`.
  - The feature is off by default, so a new user sees it only after turning the feature on and getting suggestions, which is intentional; the feature itself is introduced by the settings group and the one line on the welcome page.
- The tip table in ONBOARDING-SPEC, the feature highlights in the README (both copies), SPEC-OUTLINE and PROGRESS are updated in sync.
- All new copy uses `t()` and is added to all language catalogs (about 35 entries). Agent-facing text (the prompt, the put-in-place notes, the skill) stays in English.

## 9. Out of scope

- Writing directly to `paseo.json`: this needs the internal API `writeProjectConfig`. The card's agent makes the change and commits it, and also completes the verification.
- Automatically creating cards or automatically applying suggestions; cross-project aggregation; per-person statistics.
- A setup status display on the card and a scripts panel (candidates from this card's first round of research, to be tracked separately).
- Pattern analysis of non-shell tool calls, such as the same kind of Read/Edit sequence or the order of MCP calls. Can be extended later.

## 10. Acceptance

Unit tests:
- Splitting and classification: cases built from the shapes that appeared in the probe, including heredocs, case branches, function definitions, `git -c`, `$VAR` commands, and separators inside quotes.
- Normalization, including the conditions for merging npx; each redaction rule, with cases that include the shape of real tokens.
- Record id deduplication, 30-day trimming, rewrite on card deletion, project removal.
- Scheduling: intervalDays × runHour × time zone; across days; only one catch-up run after downtime; only one run at a time.
- Quiet-period skip; material budget trimming and round-robin sampling by card.
- Parsing: plain JSON, a code block, JSON embedded in markdown, a retry when there is no JSON, the error when it still fails.
- Validation: invalid card IDs, fewer than 2 cards (except when the window has only 1 card), over-long fields, duplicate fingerprints, the dismissed cooldown.
- Replacement (2026-10-21): open suggestions do not block new suggestions; accepted suggestions and dismissed ones within the cooldown do not come back (a cross-language rewording is also caught, and generic words are not misjudged); deduplication within the same run; `replaceOpen` deletes only this project's open suggestions; in the daemon test the second run replaces open, keeps accepted/dismissed, and keeps the old list when there are no valid suggestions.
- The cost of one period is summed per project; a busy project with two cards is analyzed in a scheduled run.
- Atomic accept and error rollback when a card is created; default values when a setting lacks fields.
- Tip rules (`client/onboarding-logic.test.ts`); i18n completeness.

Checks and live runs:
- typecheck, the full `npm test`, reload this plugin.
- Run Run now manually on the Flowly project (`claude/claude-sonnet-5`) and compare with the 6 conclusions of the 2026-10-19 probe: at least the two high-confidence suggestions, i18n and Playwright, must be covered; confirm the temporary session was archived; record tokens and cost.
- With an explicit full-access `codex/gpt-6-luna` test session, check on a fixture project (or Tinylink, cleaning up only what the test itself created):
  - each item of the settings group and saving; the project switch;
  - the Insights section's off, skipped, error and suggestion-list states, Create card, Dismiss/Restore;
  - desktop and compact layouts;
  - backfill and Delete collected commands.
- Evidence is saved to `docs/verification/workflow-insights.md`. Anything not actually run is recorded as UNRUN.

## 11. Decisions I made (can be overturned)

1. **Off by default**, the period defaults to **Weekly**, and the hour defaults to 09:00.
2. **The Auto model uses Sonnet** (5.5 → 5), not the cheap model used for summaries; it falls back to the Summary model only when unavailable.
3. **The window is at least 7 days**, so Daily means "look at the last 7 days every day". Each run replaces the open suggestions (§5.3, user decision 2026-10-21), so identical suggestions do not accumulate every day.
4. **Quiet-period skip** (fewer than 50 new actions, or fewer than 2 cards and fewer than 200 new actions; relaxed on 2026-10-21 from "fewer than 3 cards", confirmed by the user), saving tokens when there is no new information. A manual Run now is not subject to this.
5. **Collect only when the switch is on**, with a 7-day backfill when it is turned on; turning it off does not delete data, and there is a separate delete button.
6. Suggestions go on the **Insights page**, not into the Ideas inbox. An idea hangs off a source card, while the suggestions here are project-level.
7. `projectScripts` is written into the session context, **independent of the switch**: once a suggestion has been put in place, the agent needs to know these scripts exist.

## 12. Agent habits: usage rates of next moves and ideas

Status: **implemented, awaiting user acceptance** (2026-10-20, card `5aaa5b01` "Insights: next-move and idea rates per session and model"; the user confirmed the adjustments below after the evaluation).

### 12.1 Purpose and basis

In the Flowly project's flow log on 2026-10-19 there were 57 `next_moves_suggested` (falling in 56 turns; 47 of them were delivery or result turns, of which there were 77 in total) and 7 `idea_proposed` (74 deliveries). By 10:50 on 2026-10-20, only 1 of 12 deliveries carried next moves (5 calls in the whole day) and there were 4 ideas. There was no UI hint; the user noticed only because the chip above the input box was gone. The same data also shows the rule binds different sessions differently: of the three sessions with ≥10 deliveries in the window, one had 0 next moves, one 2, and one 6. This section turns that into a number visible every day, so that changing the rules (the skill's wording, a reminder at delivery) has data to compare against.

**The data source must be the flow log, not `board.json`**: the board keeps only the latest 100 events per card (`BoardStore.event`), so counting events from `board.json` undercounts. The "65 next moves in total on 10-19" counted from `board.json` during the 2026-10-20 evaluation was low in exactly this way: the flow log (not trimmed) shows 79 across all four projects on 10-19, and 57 for the Flowly project alone.

### 12.2 Relation to the rest of this document (two deviations from the card's original text)

- **Not controlled by the Workflow insights switch**. This section is only rule-based statistics: it calls no model, spends no tokens, and collects no new content; what it reads is the existing flow log. To be "discovered within a day", it must be visible to everyone by default; inside the Workflow insights section, which is off by default, it would not be seen. So the code is in the new file `shared/agent-habits.ts` and not in `shared/workflow-insights.ts` (that is another feature not yet accepted, and mixing them would make the two impossible to commit separately). On the Insights page it is a section of its own and does not belong to Workflow insights.
- **The denominator excludes question**. The skill says questions go through `kind=question`, "not next moves", so counting questions in the denominator of next moves would structurally depress the ratio. Question turns are listed separately. Since 2026-10-20 agents prefer to ask through their own question tool (SESSION-QUESTION-SPEC §2.2), and such a question produces no `kind=question` event, so the number of question turns counts only questions asked the fallback way.

### 12.3 Definitions

The data source is the project's flow log (`flow/<projectId>.jsonl`, every board event, not trimmed, with usage kept after a card is deleted). Only events with `actor=agent` and the `system` turn boundaries are looked at; days are cut with the Insights time zone (`dayKey`).

- **turn**: for the same `agentId`, from `agent.turn_started` to the next `turn_started` or its own `agent.turn_ended`. A session's events are assigned to its most recent turn (in progress or just ended); events with no turn at all (the log starts in the middle of a turn) form a turn of their own, timed by that event. A turn's date is the date of its last event.
- **delivery type** (a turn counts only once, by priority):
  1. `delivery`: the agent moves the card with `status_changed` to `in_review`;
  2. `result`: no delivery, but there is a report with `reportKind=result`;
  3. `question`: none of the above, but there is a report with `reportKind=question`.
  - **Denominator `base` = delivery + result**.
- **next moves**: at least one `next_moves_suggested` within the turn (a later one in the same turn overrides an earlier one, so it counts once per turn, not per event).
  - ratio = turns in `base` that carry next moves / `base` (fields `moves` / `deliveries + results`);
  - `movesAny` is all turns that carry next moves (including those outside base), used only to check the event count, not in the ratio.
- **ideas**: the number of `idea_proposed` events; "ideas per delivery" = ideas / `deliveries` (only in_review deliveries count); no ratio is shown when there is no delivery. The idea count is taken from all of the agent's turns, not only delivery turns, because the skill says "usually at delivery".
- **explicit "no next step" (`none`)**: `next_moves_suggested` whose `moves` is an empty list (the `nextMoves: []` of NEXT-MOVES-SPEC §8). It is recorded as `offered: 0` in the flow log.
  - Within a turn the **last** next-moves call decides: a last call that is non-empty counts as `moves`, and an empty one counts as `none` (suggesting first and then changing to none, or the reverse, both go by the last call);
  - `none` counts only turns in base (delivery + result), is listed separately, does not enter `moves`, and does not change the denominator;
  - a `none` turn has no suggestion that can be adopted, so it does not enter picked's `offered`;
  - it counts as "used the tool": the flag below does not report "no next moves" just because the model keeps declaring none. The `none` total is shown on the model row so that "always saying there is none" is visible too.
- **picked (adopted by the user)**: the set of next moves not overridden when a turn ends is called a *set* (attached to the turn that proposed it; its date and model also belong to that turn). A set has an outcome when it is *answered*:
  - the next turn of the same session starts (the user sent a message): the outcome comes from the `pick` on that turn's `agent.turn_ended` (§12.4): `≥0` is which suggestion was adopted, `-1` is answered but nothing adopted, and missing is unknown (old data, or the hook did not get the message); **unknown does not enter the ratio**;
  - the card is moved to Done by a person and the set has a suggestion with `moveTo:"done"`: counts as adopted. **Limitation**: clicking "Move to Done" and dragging to Done by hand take the same path and produce identical events, so they cannot be told apart; the "adoption" here therefore includes manual dragging (the UI copy does not say "tapped");
  - a set that is not answered (nobody replies to the session afterwards, the card is wrapped up) does not enter the ratio.
  - ratio = `picked / offered`, where `offered` is the number of sets with a definite outcome.
- **Grouping**:
  - day: the last 7 days (up to the selected date, same as Last 7 days);
  - project total: all turns in the window;
  - model: the `model` on the turn (`provider/model`). When absent it is filled in per §12.5; if still unknown it goes into "Unknown model";
  - session: `agentId`, used only for the flags (§12.6) and shown with the card title and the model.
- **Flags**: a model or a session in the window is flagged if it meets any of the following.
  - `deliveries + results ≥ 10` and `moves = 0` and `none = 0`: "no next moves" (it neither suggested nor ever declared none, that is, it did not use the tool at all);
  - `deliveries ≥ 10` and `ideas = 0`: "no ideas".
  - The threshold is `FLAG_MIN = 10`. Ideas can legitimately be 0 (skill: do not propose when there is nothing worth proposing), so this one is only a hint, not an error.

### 12.4 Data changes (all optional fields; old data needs no migration)

- The `agent.turn_ended` event (`BoardEvent` and the flow log) gains:
  - `model`: the session's `provider/model` at the end of this turn, taken from `runtimeInfo.model` of `paseo.agents.ref(id).refresh()` (falling back to `model` when missing); not written when it cannot be obtained. In the hook, `PluginHookAgent` has only `provider` and no model; a session can switch models midway (the timeline has `model_changed`), so it is recorded per turn and not per session;
  - `pick`: an integer. **Written only when the session had unexpired next moves at the start of this turn** (`openNextMoves` takes the set from before the turn started). Take the `user_message` text from the turn's timeline and compare it with the `prompt` of each message-type suggestion in that set (`matchPick`): return the index of the adopted one, or `-1` when none matches; not written when there is no message text.
- `matchPick`: the texts are compared after removing extra whitespace. It counts as adopted when the message equals the prompt, or when the prompt is at least 12 characters long and the message contains it (after a click-to-fill the user appends to existing input, see NEXT-MOVES-SPEC §4); otherwise it takes the proportion of the prompt's character trigrams covered by the message, and ≥0.8 counts as adopted (the user changed a few words and sent it); when several match at once, take the highest coverage and then the smaller index. Action suggestions without a `prompt` do not take part.
- `next_moves_suggested` in the flow log gains `offered` (the number of suggestions, 0 for an empty list) and `offersDone` (contains `moveTo:"done"`): the flow log saves neither `moves` nor `note`, so an "explicit none" can only be told apart by `offered: 0`. Old entries lack these two fields, and the server fills them in from the event with the same id on the board when reading; the board keeps only the latest 100 events per card, so old entries that have been trimmed cannot be filled in and are treated as having suggestions and containing no Done suggestion (none did not exist then).
- Write points: `recordLifecycle` gains optional `model` / `pick`; the `agent.turn_ended` hook in `index.server.ts` obtains the model (asynchronously) before `store.mutate`, and computes `pick` synchronously inside the mutate. Failing to obtain the model or the message just means one field is missing and does not affect the hook's other work.

### 12.5 Model of historical turns

For turns without a `model` field (all history before this feature went live): the server calls `agents.list({ includeArchived: true })` once, only when such a turn exists in the window, and fills in the session's current `provider/model`; sessions not found in the list (already cleaned up) go into "Unknown model". **Known bias**: a historical session that changed model midway is counted under its current model. Seven days after launch there are no such turns left in the window, and this call goes away with them.

### 12.6 View and UI

- `ProjectInsights` (`insights.project`) gains `habits`, with no new RPC, reusing the existing etag read:
  `{ days: [{ day, ...counts }] (7 days), total: counts, models: [{ model, ...counts }] (descending by base), flags: [{ kind: "model"|"session", miss: "moves"|"ideas", model, n, agentId?, taskId? }] }`, where `counts = { deliveries, results, questions, moves, none, movesAny, ideas, offered, picked }`.
- The Insights page gains a section **Agent habits**, placed after Workflow insights and before Token use, shown in both the desktop and the compact layout:
  - On the right of the title row is the window total: "Next moves 54/69 · Ideas 13";
  - A row of 7 days: one column per day, showing the weekday, the next-moves ratio (`moves/base`, "–" when there is no delivery) and the ideas count, with a warning color when the ratio is below half of the window average;
  - One row per model: the model name, `moves/base`, ideas, `picked/offered`;
  - Flag rows: "{model} made no next moves in {n} deliveries (7 days)" / "… no ideas …", with "{card title} · {model}" for a session, and tapping opens the card;
  - When there is no delivery or report at all in the window, the whole block shows one line "No deliveries in these 7 days."
- No setting and no onboarding tip (this is a diagnostic row, not a feature to be advertised, and it should not pop up a tip once for every user); the README's Insights highlight gets half a sentence added. The new copy is added to all 9 language catalogs.

### 12.7 Out of scope

- An explicit "none" declaration and its count (see 12.3);
- A push or an Attention item when the ratio drops: look at the data and the flags in the rows first;
- Per-person statistics; cross-project aggregation;
- Changing the rules of next moves / ideas themselves (two related ideas on the card `Sidebar UI/UX adjustments`).

### 12.8 Acceptance

Unit tests (`shared/agent-habits.test.ts`):
- Turn boundaries: events within a turn belong to that turn; agent events after `turn_ended` and before the next `turn_started` belong to the turn that just ended; events without a `turn_started` form a turn of their own; two next moves in the same turn count only once; a turn that has both a delivery and a result counts only as delivery;
- Denominator: question does not enter base; it is counted separately; ideas per delivery;
- Dates and time zone: a turn spanning midnight goes by the last event; `tz` affects the day cut;
- Grouping: by model, using the fallback function when model is missing, and still-unknown ones go to Unknown;
- Explicit none: the last call decides; only base counts; it does not enter offered; it does not trigger the "no next moves" flag; an old entry without `offered` is treated as having suggestions;
- picked: the whole sentence, appended after existing input, a few words changed, a short prompt accepted only on exact equality, the closest of several, only action suggestions, unknown does not enter the ratio, Done adoption, unanswered does not count, an overridden set does not count; `turnPick` takes the set from before the turn started;
- Flags: exactly 10 with 0; 9 is not flagged; 1 is not flagged; likewise for ideas;
- Flow log: `flowEntry` keeps `model`, `pick` (including 0), `offered` and `offersDone`.

Server: `recordLifecycle` writes `model` / `pick`; `analyze` carries `habits`; old flow entries are completed from the board for `offersDone`.

Live check: freeze a copy of the flow log and `board.json`, count by hand by day and by session with an independent script (`docs/verification/fixtures/agent-habits/handcount.mjs`, which does not reference `shared/agent-habits.ts`), and compare item by item with the counter (`compare.test.ts`, which runs only when `HABITS_FROZEN_DIR` is set); several date and time zone combinations must all agree. The differences and their reasons go into `docs/verification/agent-habits.md`, including why the example numbers in the card (65 next moves / 11 ideas on 10-19, 1 / 0 on 10-20) do not match the current data: 65 is the number of next-moves events still left in `board.json` (after being trimmed by the cap of 100 per card), not the actual number for that day; the 11 ideas agree with the flow log (all projects); the 1 / 0 on 10-20 is the count from earlier that day, and there were more calls afterwards. The UI is checked visually on a running Paseo; when there is no desktop window control tool it is recorded as UNRUN.
