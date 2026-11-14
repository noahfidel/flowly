# Task progress summary: automatic wrap-up every turn

Status: design confirmed by the user on 2026-10-15 ("go", translated). Card task `8c22cc02`.

## 1. Purpose

- See at a glance where the card is now: a one-line state, what has been done, the next step.
- After a card is Done, still be able to look up how far it got: every update is kept as a historical version.

A summary is descriptive text written by the system; it **does not change** the card's business status (lane) or the task revision.

## 2. Trigger and run (daemon)

- Trigger: any chat of the card (§2.1) receives `agent.turn_ended` with `outcome.kind === "completed"`. Failed and cancelled turns do not trigger. Archived cards and archived projects are not processed; Done/Cancelled cards can still be updated.
- Switch: with the setting `summaryEnabled=false` it does not trigger (manual Refresh still works).
- Single flight and merging: at most one summarizer per card at a time. When another turn ends during a run, that turn's text is added to the pending set; after the current run ends, all accumulated turns are merged into one more run. The pending text is kept in memory and is lost on a plugin reload; the next turn naturally fills it in.
- Input (stateless, passed in full every time): card title, description (≤2000 characters), current lane name, the previous summary (if any), the text of this turn or of the merged turns.
- Turn text: take the hook's own `timeline`; from Paseo 0.13 the `timeline` of `agent.turn_ended` is always an empty array (0.12 had content), so `server/turn-timeline.ts` reads the latest page of that session's timeline (`tail`, 200 entries, `projected`) and takes the last turn, the same way as manual Refresh; if the read fails it stays empty and no summary is generated this turn. `user_message` → `User:`, `assistant_message` → `Assistant:`, `tool_call` records only the name (consecutive calls are merged into one line `Tools: a, b ×3`), `error` records one line, and the rest (reasoning, todo, compaction, plugin, notification) is ignored. Total length ≤12000 characters; when exceeded, keep the first 3000 characters and the end, and mark the omission in the middle.
- Call: `paseo.workspaces.ref(<card workspace>).agents.create` (amended 2026-10-15, user chose B)
  - It runs as a **child session (`parent`) of the session whose turn just ended**, in the card's own workspace, and does not create a native project or workspace;
  - `config.provider`: the Summary model from the settings (§4); `config.modeId`: `readOnlyMode(provider)` (`shared/summary.ts`, 2026-10-30) — `claude/*` and `claude-*` custom providers (such as `claude-compass-smith-sqp`) use `plan` (Plan Mode: analysis only, no tool execution, no file changes, and it does not stop at a permission prompt); other providers set nothing (there is no read-only mode; never use full-access), and such a session that stops at a permission prompt is answered with deny by `finishRefusingPermissions` and then continues (AUTO-REVIEW-SPEC §4.4). The card summarizer, memory review, Insights daily report, workflow insights, guardrails catch-up learning, insights of outside sessions and review sessions are all created by this rule;
  - `title`: `Kanban summary · <card title>`; `labels`: `{"flowly": "summarizer", "flowly-task": <taskId>}`;
  - `prompt` and `outputSchema` (§3);
  - `waitForFinish(120000)`; whether it succeeds, fails or times out, the session is removed in `finally` (when the hard delete fails it falls back to archiving, see §10).
  - The board view hides summarizers by label: the card's session list, counts, latest output, Attention, sidebar badges and the sessions of `flowly_get_task`. The "running session" checks of project Remove and Wrap up do **not** hide it, so a running summarizer still blocks these destructive operations.
  - The first version put the cwd in the plugin data directory; measured ([verification](verification/task-summary.md)), Paseo registered a native project for that directory and created a new workspace every time, so it was changed to this design; the leftover project was deleted (`paseo project delete`, which does not delete the directory).
- The summarizer's own turn ending does not trigger recursively: it carries the `flowly: summarizer` label and does not belong to any card's chats (§2.1).

### 2.1 Chats of a card (user decision 2026-11-09)

Which sessions belong to a card does not depend on who started them. `server/card-chats.ts` is the only judgment, shared by manual Refresh, the no-chat hint and the automatic summary:

1. Board-managed sessions bound to this card (tool binding file, `managedSessions`), in whatever workspace;
2. plus the other non-archived sessions in the card's workspace (`task.workspaceId`) (for example a review session that an outside watcher started with the `pr-review-watch` label for a PR review card), read page by page through the plugin SDK `agents.list({ includeArchived: false })` and then filtered by `workspaceId` (the SDK has no workspace filter). Item 2 excludes:
   - when another non-archived card is bound to the same workspace (such as several cards sharing the project checkout in local mode), the whole of item 2 is skipped and only item 1 counts;
   - board-managed sessions bound to other cards;
   - archived sessions;
   - internal sessions: those with the `flowly: summarizer` label (including the old `ultra-kanban: summarizer`; the runs of summary, Insights, session insights, quick title, memory and workflow insights all carry it) or the `flowly-dispatcher` label, and those Paseo marks `internal`.

Flowly MCP tools are still given only to sessions Flowly started (injected at launch); this section only decides which chats Progress reads. In the automatic summary, when a turn of a non-managed session ends, the daemon reads that session only if its workspace has a non-archived card (the hook event carries no labels), then decides by the same rule whether it belongs to that one card; if so it enters the same queue and is also controlled by `summaryEnabled`. The session insights for that turn (NATIVE-SESSION-SPEC §12) work as before, independently of this.

## 3. Output

`outputSchema` (JSON Schema) matches the server-side zod validation:

```
{ update: boolean, state: string, target: string, recap: string, next: string }
```

- `update=false`: there was no real progress this turn (small talk, thanks, a read-only query with no new conclusion), and no new version is written. When there is no previous version, a summary must be given.
- `state`: a short phrase saying where things stand now (≤15 words or 30 Chinese characters), for example "Implementation done, waiting for tests".
- `target` (added by the user 2026-10-15): the task's goal and feature points. One line `Goal: ` plus at most 4 lines `- ` of feature points, based on the card description and the scope the user raised or approved; when the scope is unchanged it is kept as it is, and it changes only when features are added, removed or redefined. Old versions have no such field, and it reads as an empty string.
- `recap`: results so far that help judge progress (not only this turn), at most 4 lines `- ` of points, each line ≤15 words or 30 Chinese characters; when exceeded, merge or drop old points; write only decisions and results, not processes such as reading files or running commands.
- `next`: the single next step or who it is waiting on, one sentence (≤20 words or 40 Chinese characters).
- The language matches the conversation.
- Parsing `lastMessage`: tolerate a ```json code block wrapper and extra text before and after (take the first complete JSON object). No field is truncated; only when a single field exceeds 4000 characters (the storage safety limit) is it treated as an error and the old version kept. The Claude provider does not enforce `outputSchema`, and was observed to return a recap in array form: an array of strings is joined as `- ` lines; `update` accepts the strings "true"/"false"; when `update=false`, missing fields are allowed.

## 4. Settings

2026-10-23 increment: the user can add several models and adjust their priority, and the default is still Haiku→Luna. For the full compatibility, UI and shared call contract see [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md), which replaces the old single-model editing below; `summaryModel` is kept as a compatibility input.

A new host setting `task-summary` (v1), read by the daemon's `registerSettings`, edited by the client in the popover opened by the settings gear in the board's top toolbar (§7; Ruling (Noah, 2026-11-09): the settings button moved from the bottom left to the toolbar):

| Field | Default | Notes |
| --- | --- | --- |
| `summaryEnabled` | `true` | Update automatically every turn |
| `summaryModel` | `""` | Compatible with the old `provider/model`; empty is Auto |
| `summaryModels` | When not stored, compatible with the old value | An ordered, non-empty, de-duplicated list of `provider/model`, which takes priority over the old value; default Haiku→Luna |

Auto: try the available, selectable models in the order `claude/claude-haiku-5-5` → `codex/gpt-6-luna`. Being available in the model list does not mean quota is left: when creation fails, quota is exhausted or a run error occurs, a timeout occurs, a permission is requested, or the output does not match the schema, clean up this child session and try the next model, each candidate at most once. The first success (including `update=false`) stops it; the model that actually succeeded is saved. Each candidate uses the same input, parent session and card workspace, and does not create a new project or workspace. An old manual single model or single-item list tries only that model; a multi-item list falls back in the saved order and does not add unconfigured models. When none is available or all fail, an error is reported. The model options of the settings page come from `providers.listAvailable` + `listModels` (the selectable models of available providers).

## 5. Data

A separate file `summaries.json` (in the same directory as `board.json`), with serialized writes, backup and atomic replacement; when its content is invalid the file is kept and an error is reported, with no reset.

```
{ version: 1,
  entries: [{ id, taskId, at, model, agentIds: string[], state, target, recap, next }],
  errors:  [{ taskId, at, message }] }   // only the latest one per card is kept
```

- At most 50 versions are kept per card, and the latest version is the current summary.
- Writing a new version successfully, or `update=false`, clears that card's error.
- Archived cards keep their summaries. On project Remove, the summaries and errors of its cards are written to `removed/<project>-summaries-<time>.json` and then deleted from the file.

## 6. RPC

| Method | Input | Output |
| --- | --- | --- |
| `summaries.read` | `{}` | The latest version of each card, the running taskIds, each card's error |
| `summaries.history` | `{ taskId }` | All versions of the card (new → old) |
| `summaries.refresh` | `{ taskId }` | `{ queued: true }`; takes the last turn in the tail timeline (≤200 entries) of the card's most recently active chat (§2.1) as input; when there are no chats it reports the error "This card has no chats to summarize yet." |
| `summaries.chats` | `{ taskId }` | `{ count }`: the number of chats of the card (§2.1), 0 when the card does not exist |

## 7. UI

- Card: when there is a summary, `state` is shown under the title, at most one line (ending with an ellipsis when it overflows); the full text is viewed in the sidebar Progress (user feedback 2026-10-15).
- Sidebar: a **Progress** block after the description and before Sessions: State (emphasized), Recap, Next, with the footnote "Updated 5m ago · Haiku 5.5". Text is never truncated; brevity is enforced by the prompt. When the whole content (State, Target, Recap, Next together) exceeds about 12 lines (240 pt), the whole is collapsed to that height with a fade at the bottom (user feedback 2026-10-29: the earlier about 5 lines (104 pt) truncated almost every summary; at 240 pt State, a 4-line Recap and Next show completely at the default sidebar width of about 640 pt, and ones with a Target usually still collapse. That height goes through the `clampHeight` parameter of `ContentCard` and is used only for the sidebar Progress; Ideas and Memory stay at 104 pt; the Progress row in the Paseo timeline is expanded by default since 2026-10-29 and Show less collapses it to 104 pt, see NATIVE-SESSION-SPEC §5.3), and Show more / Show less at the bottom left (on the same row as the "Updated · model" footnote on the right; since 2026-10-19 the positions are swapped to match the Ideas card, sharing the generic card style `ContentCard` of `client/content-card.tsx`) expands or collapses it; the height transitions with an animation (expand 220 ms decelerating, collapse 160 ms accelerating, interruptible, honoring Reduce Motion; the first measurement positions directly without playing). When the content does not overflow it is shown completely and no button appears. The History list is not truncated either (user feedback 2026-10-15).
  - While running it shows "Updating…"; the latest failure shows one muted error line, with no popup.
  - The **Refresh** button triggers manually; when the card has no chats (`summaries.chats` is 0 and no summary is running) the button is not shown and a muted line "No chats on this card yet." is shown instead. The count is read only while the sidebar is open: it is re-read immediately when the workspace's live session list changes, otherwise every 30 s; when the count is unknown the button stays. **History** expands into a list of versions in reverse order, each showing the time and state, and opening one shows its Recap/Next.
  - When there is no summary, one hint line is shown: "Updates after each agent turn." (when automatic is off, the hint points to the settings to turn it on).
- Settings: the settings gear in the board's top toolbar (formerly the floating button at the bottom left, Ruling (Noah, 2026-11-09)) opens the plugin's self-drawn "Ultra Kanban settings" popover (the host's `addSettingsScreen` page is not shown in the current Paseo and is deprecated), with the Auto summary switch; a two-level choice Provider (Auto or an available provider) → Model (the selectable models of that provider), where the model is saved only once chosen, and choosing Auto saves immediately.

## 8. Errors

A failure of a single candidate in the model list first falls back per §4; only when all candidates fail (including a single-item list) is it recorded in `errors`, the old summary is kept, and there is no retry loop. The error carries, in the order tried, the model name and the failure reason (still bound by the 500-character storage limit). A run result counts as a failure even if it is `idle` when it carries `error`, and any JSON that may remain in it is not accepted. Fallback applies only to the model call and output parsing; a persistence failure does not call the model again. A successful write or a valid `update=false` clears the old error. The log does not print the prompt content.

## 9. Not doing (extensions)

- A structured todo list: later `next` can evolve into a checklist.
- Status changes driven by the summary.

## 10. Known risks

- The plugin SDK does not expose `internal`: the summarizer is briefly visible in the card workspace (in Paseo's native workspace view it is a child session of the parent session), and after it finishes it is **hard-deleted** (`server/summarizer-remove.ts`, local `DaemonClient.deleteAgent`, approved by the user 2026-10-22; on failure it falls back to archiving and logs), so it no longer stays in the archive. Paseo may send a finished notification for it once; not yet measured.
- A manual Refresh does not add a version if it judges there is no new progress (`update=false`).

## 11. Acceptance

- Unit: turn text conversion and truncation, output parsing tolerance, model Auto resolution, single flight and merging, `update=false` not written, the 50-version cap, error recording and clearing, project-removal backup, board/task revision unchanged.
- Fallback regression (fake SDK): run error/quota exhausted, idle with error, creation failure, wait throwing, timeout/permission/bad output all try the next available candidate; success or a valid `update=false` stops; when all fail the old summary is kept and each candidate model's reason is recorded; a manual model does not fall back; every child session that was created is cleaned up.
- Card chats (§2.1): only managed sessions; sessions in the workspace not started by Flowly (PR review cards) count; when the workspace is shared by another card only managed sessions count; sessions bound to other cards, archived and internal sessions do not count; no chats is empty; a manual Refresh can summarize a non-managed workspace session.
- Integration (fake SDK): triggered by the card chats (§2.1); the summarizer session is also removed on error/timeout (hard delete, falling back to archiving on failure); a failed turn does not trigger.
- Typecheck and the full tests; reload this plugin; a Luna 6 full-access test session runs against a fixture card and cleans up.
