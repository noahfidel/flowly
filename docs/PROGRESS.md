# Implementation progress

## Dispatcher chat panel (branch `feat/single-pane`, Task 10) — 2026-11-08

- Spec: DISPATCHER-SPEC §9 (items, the change line, the panel), §8 RPCs, §10 acceptance; record gains `seenRevision`.
- `server/dispatcher-items.ts`: `DispatcherItems` (`<dataDir>/dispatcher-items.json`, atomic, mode 0600, corrupt file kept as `.invalid-<ms>`; replace by id; drops answered/dismissed asks after 7 days, then keeps the newest 500), `noteItems`, `seenMark`, `changeLine`, `whatNextMessage`. `server/dispatcher.ts`: `save` takes an updater so `seenRevision` survives restarts; `onSent` after a delivered note batch; `markSeen` (keeps the max); `whatNext` (refused with `DISPATCHER_DOWN` unless running or idle; steers a running turn). `server/session-tail.ts`: `dispatcherTail` reads only the stored dispatcher agent. `shared/rpc.ts`, `index.server.ts`: `dispatcher.items-changed` (etag), `dispatcher.tail`, `dispatcher.mark-seen`, `dispatcher.what-next`.
- Client: `client/dispatcher-panel.tsx` (memoized rows; transcript entries reused from the session pane; note rows open their card; the change line is collapsed; Start dispatcher with the HOST_UNSUPPORTED/other error shown as a notice; composer is `TextBox`, sends with the host `paseo.agents.ref(id).send`), `client/dispatcher-panel-logic.ts` (merge and grouping, note-batch user messages hidden, the board summary as one row). `client/board.tsx`: toolbar Dispatcher button; desktop panel left of the card sidebar, phone full-screen page under it; hidden with `display: none`, not unmounted, once opened; polling (status 5 s, items 4 s, timeline stream) only while visible. `client/session-timeline.ts`: `dispatcher` flag; `client/queries.ts`: `useDispatcherItemsQuery`.
- Calls I made: an event's revision is its time in ms (events have no revision number); events by a human are left out of the change line; What should I do? does not mark seen; the composer and What should I do? steer a running turn.
- Strings: 15 new, in all 9 catalogs. Onboarding: new tip `dispatcher` (after first-card, before card-display; opening the chat marks it seen) and a Dispatcher line under More features on the tour's last page; ONBOARDING-SPEC updated. Telemetry: no heartbeat field. What's new: none (part of the release that ships the dispatcher).
- Checks: `npx vitest run server/dispatcher-items.test.ts server/dispatcher.test.ts server/session-tail.test.ts client/dispatcher-panel-logic.test.ts client/onboarding-logic.test.ts` exit 0 (5 files, 84 passed); `npm run typecheck` exit 0; `npm test` exit 0 (169 files, 1531 passed, 1 skipped). Not run: the panel against a live host (plugin not installed in this task): desktop and phone layout, Start dispatcher, the composer send, the HOST_UNSUPPORTED notice, transcript streaming — Task 12's live checks.
- Review fix round 1:
  - The composer and What should I do? always send with `activeTurnBehavior: "steer"` (`userSendOptions`). Paseo's daemon (`agent-prompt.js`, `agent-manager.js` `steerOrReplaceActiveTurn`) returns `inactive` for a steer on an agent with no turn and starts a normal run, so steer is safe when idle; a send without it interrupts and clears pending permissions.
  - The change line is cached on the daemon (`ChangeLineCache`, keyed on board revision, event count and last event id, mark and dispatcher session): an unchanged board costs no scan per 4 s poll. The client overview carries no events, so computing the line on the client would have meant adding events to the overview.
  - Ruling applied: the dispatcher's own actions (events with its `agentId`; its tools tag every create, update, link and start that way) are left out of the change line.
  - Mark seen clamps to the daemon's clock and keeps `seenIds` (ids at the mark's millisecond), so a later event in the same millisecond still shows.
  - `DispatcherItems` first read is shared (one in-flight load), so a corrupt file is moved aside once.
  - Composer: the dead `onSubmitEditing` is gone (Send button sends; Enter adds a line). The change row is pinned to the end of the timeline.
  - Spec: the dispatcher transcript's image fallback is listed as a known gap.
  - Checks: 7 new or changed tests failed first (RED), then `npx vitest run client/dispatcher-panel-logic.test.ts server/dispatcher-items.test.ts server/dispatcher.test.ts server/session-tail.test.ts` exit 0 (39 passed); `npm run typecheck` exit 0; `npm test` exit 0 (169 files, 1535 passed, 1 skipped). Not run: live host.

## Dispatcher agent, charter and cross-project scope (branch `feat/single-pane`, Task 9) — 2026-11-08

- `server/dispatcher.ts`: `Dispatcher` (record `<dataDir>/dispatcher.json`, atomic, corrupt file kept as `.invalid-<ms>`; workspace `<dataDir>/dispatcher/` created with `background: true` and no Paseo project id, reused, never archived; `status`, `start`, `deliver`, `turnEnded`, `owns`), `dispatcherState`, `dispatcherSummary`, `noteMessage`, `wireDispatcher` (bus → `facts.filter(isStop)` → batcher → deliver; returns the unload cleanup). `server/dispatcher-tools.ts`: the eight dispatcher tools and the caller check (`DISPATCHER_REPLACED`, `SESSION_MISMATCH`, then `NOT_FOUND` / `PROJECT_ARCHIVED` / `ROOT_UNAVAILABLE` via `AgentCards.dispatcherCaller`). `server/tool-context.ts`: sealed purpose `dispatcher` over `{ agentId, workspaceId }`; `authenticateAny` returns `kind: "dispatcher"`. `server/tool-server.ts`: a dispatcher credential's MCP server registers only the dispatcher tools; `/api` still refuses non-card credentials; `dispatcherSession` for `agent.session_open`. `server/background-workspace.ts`: `createDirectoryWorkspace` (shared; maps the host's "Update the host to use background workspaces." to `HOST_UNSUPPORTED`, no retry). `server/service.ts`: `reservedWorkspace` refuses binding the dispatcher workspace to a card (New task "existing", PR review cards), so no archive/wrap-up/switch path can reach it. `shared/dispatcher.ts`: status/start schemas, `dispatcherCharter`, `dispatcherContextLimit`. `shared/rpc.ts`: `dispatcher.status`, `dispatcher.start`. `index.server.ts`: RPCs, `agent.turn_ended` → `turnEnded`, session_open adds `flowly-dispatcher` only for the stored agent id, unload unwires (batcher disposed, subscription removed). The MCP result helper moved to `toolResult` in `server/tool-error.ts` (shared by both servers).
- Task 8 review items: `NoteBatcher.dispose()`; `firstAt` sentinel `null` (with 0 a batch whose first fact read time 0 flushed at 65 s instead of 60 s); `commitHandler` builds no facts without subscribers (`EventBus.hasSubscribers`); the dispatcher subscriber pushes only stops. Each has a test.
- Code-shape notes: `start` is refused while the dispatcher is `running` or `idle` (`DISPATCHER_RUNNING`), and writes the record before Paseo creates the session so first-turn tool calls pass; it goes back to the previous record when Paseo did not create the agent. The replaced session is left in Paseo as it is. Dispatcher writes count against the same 20-per-hour card/start limit, keyed by the dispatcher session. Links made by the dispatcher are stored with `createdBy: "system"` (the link schema has no agent value) and logged as `linked` events with `actor: "agent"` and its agent id.
- Strings: none (the charter and tool texts are agent-facing English). Onboarding: no tour change or tip yet — nothing user-visible until the chat panel (Task 10), which adds the `dispatcher` tip. Telemetry: no heartbeat field. AGENTS.md: dated user-requested exception for the always-on dispatcher and its background workspace.
- Checks: new `server/dispatcher.test.ts`, `server/dispatcher-tools.test.ts`, three new tests in `server/event-bus.test.ts`; `npx vitest run server/dispatcher.test.ts server/dispatcher-tools.test.ts server/event-bus.test.ts server/tool-server.test.ts` exit 0 (42 passed); `npm run typecheck` exit 0; `npm test` exit 0 (167 files, 1507 passed, 1 skipped). Not run: a live dispatcher against the host (creation without a project id, `background: true`, session_open re-injection, a real queued delivery) — Task 12's live checks 1 and 3.
- Review fix round 1:
  - Delivery: a pending permission holds notes like a running turn. Paseo's daemon sends without `activeTurnBehavior` as `interrupt` with `clearPendingPermissions` (read in its `session.js`), so both would steer. An 8 s send cooldown (as the composer's drain). One re-check 2 s after a turn end that still reads `running`. Held notes merge with `mergeNotes` (shared with the batcher): a question or blocker is kept over a later plain status change, and the hidden count carries across batches as `earlier`.
  - Dispatcher model setting: `dispatcherModel` in the host `models` settings, Settings → Models, server default `claude/claude-sonnet-5-5`. `dispatcher.start` uses it when no provider is passed.
  - The dispatcher's Paseo project and workspace are left out of `resources()`; Add project and restore refuse its folder (`reservedRoot`, compared after resolving symlinks).
  - A rejected record load is no longer cached.
  - Logged drops: notes before a Paseo connection, and held notes at unload (the wiring's cleanup now disposes the dispatcher too).
  - Rulings: legacy multi-repo projects are read-only to the dispatcher (`LEGACY_PROJECT` on create, update, start and link); start stays refused while the dispatcher is up; links stay `createdBy: "system"`.
  - String: "Dispatcher model" in all 9 catalogs. Onboarding and tip still come with the panel (Task 10).
  - Checks: `npm run typecheck` exit 0; `npm test` exit 0 (167 files, 1521 passed, 1 skipped).

## Event bus and dispatcher notes (branch `feat/single-pane`, Task 8) — 2026-11-08

- `server/event-bus.ts`: `EventBus` (sync fan-out, a throwing subscriber is logged and skipped), `factsFromCommit`, `commitHandler`, `isStop`, `NoteBatcher`; `shared/dispatcher.ts`: `DispatcherNote` schema and `noteBatching`. `BoardStore.onCommit` now receives `(events, board)` (`null` board and no events on the storage restore and export paths); `index.server.ts` installs `commitHandler` (folder snapshots still scheduled) and publishes `agent.permission_requested` (every session, card id when managed) and the new `agent.permission_resolved` hook. Nothing subscribes yet: Task 9 wires the batcher to the dispatcher.
- Code-shape notes: "turn ended with error outcome" is `agent.turn_ended` with `outcome: "failed"` (a `canceled` turn is not a stop); `reportKind` question/blocker/result counts on `status_changed` events too, since a report that moves the card is recorded as one. `BusFact`'s board variant has an optional `title` (the batcher has no board access, and `DispatcherNote.title` needs it). The batcher ignores permission facts: asks reach the chat in Task 11, not the dispatcher's input.
- Strings: none. Onboarding: no tour change or tip (no user-visible change). Telemetry: no heartbeat field. AGENTS.md: no new exception line in this task (nothing acts yet; Task 9 adds the dispatcher's).
- Checks: new `server/event-bus.test.ts`; `npx vitest run server/event-bus.test.ts server/store.test.ts` and `npm run typecheck` exit 0; full `npm run typecheck` exit 0, `npm test` exit 0 (165 files, 1488 passed, 1 skipped). Not run: any live Paseo permission event (the plan's live check 2, Task 12).

## Flowly skill text (branch `feat/single-pane`, Task 6) — 2026-11-08

- `server/skill-source.ts` and `skills/flowly/SKILL.md` (byte-identical): the card-creation rule is now "No workspace without a card" (attach to a card or `flowly_create_card` with `workspace="worktree"` before changing files, then continue there or `flowly_start_card`; one card = one branch or PR; parallel deliverables are separate cards linked with `blocks`/`follow_up`; parking an ask is `flowly_propose_idea`, project-level from a session outside any card). A new Delivery mode bullet: follow `deliveryMode` from `flowly_get_task`; never bypass the permission prompts for `git push` / `gh pr create` (the user answers them); in `ready_pr` never mark a PR ready while review notes are open. `turnChecklist` unchanged (6 items, under 1800 characters).
- The board MCP server has no `instructions` field in the host's MCP config, so the tool descriptions (Task 5) carry the board-session rule.
- Strings: none (agent-facing). Onboarding: no tour change or tip. Telemetry: no heartbeat field.
- Checks: `server/tool-server.test.ts` (new `toContain` assertions), `server/skill-source.test.ts` (SKILL.md equals `skillText`); `npm run typecheck` exit 0, `npm test` exit 0 (164 files, 1476 passed, 1 skipped).

## Start a card from a tool (branch `feat/single-pane`, Task 5) — 2026-11-08

- `flowly_start_card` (`server/start-card.ts`, `CardStarter`) on the card and board MCP servers: checks setting, project (`NOT_FOUND`/`PROJECT_ARCHIVED`), card (`NOT_FOUND`/`CARD_FINISHED`), replays a session this `operationId` already prepared (`ToolSecrets.preparedFor`, no new resources), refuses a card with a live session (`CARD_HAS_SESSION`), then per Q2(b): worktree → start there; linked-root directory → start there; directory workspace with `ownsWorkspace`, no `previousWorkspaces`/`switch` and no session ever → new worktree (`flowly-start:<operationId>` key, request kept on disk per operation for retries), card moved in one write (`previousWorkspaces`, `workspace_switched` by the agent), the empty directory workspace re-checked and archived; anything else `NEEDS_WORKTREE`. Cards older than `ownsWorkspace` count as not owned.
- Session: `ToolServer.prepareSession` + `workspaces.ref().agents.create` mirroring `launchKanbanSession`, labels `flowly-task` and `flowly-started-by`, default prompt = title + description. Model per Q6: project default, else global (Settings → Models, wired in `index.server.ts`), else the project's latest session (`startingAgent`/`lastSessionSettings`); mode falls back to `suggestedMode`; reasoning to the provider default; speed not set (`MODEL_UNAVAILABLE` when there is nothing).
- Branch (Q8): Linear `branchName` added to the connector's summary fields and `ExternalSummary`; `linearBranchFor` reads the card's first Linear issue input fresh; failures are logged (`logFailure`) and fall back to `generatedBranchName`. An existing local branch is checked out (`action: "checkout"`) when no worktree has it checked out (`git worktree list`), else the generated name.
- `flowly_create_card` gains `workspace: "directory" | "worktree"` (`WORKTREE_UNAVAILABLE` for linked-root projects); creations and starts share the 20-per-hour counter (`AgentCards.checkLimit`/`countCreation`). It has no Linear input, so its worktrees get the generated name.
- AGENTS.md: two dated exceptions (agents create and start cards unasked; start_card archives the empty directory workspace). AGENT-CARDS-SPEC D1/D3 and the non-goal amended.
- Strings: none (agent-facing text and errors stay English). Onboarding: no tour change or tip — agent-facing; the skill text (Task 6) and the dispatcher chat (Tasks 9–10) are where users meet it. Telemetry: no heartbeat field.
- Review fix round 1 (opus-reviewer): sessions re-read after the worktree create (a drawer start meanwhile keeps the card, archives the unused worktree, `CARD_HAS_SESSION`); the create request persisted per operation (`ToolSecrets.keptStart`/`keepStart`) so retries converge after a reload; the directory workspace is not archived while another card refers to it; leftovers logged with `logFailure`; the hourly limit reserved before the async work (`AgentCards.reserve`) and released on failure; ruling for Q8: a Linear branch only on `origin` becomes a local tracking branch and is checked out. Seven tests added (17 in `server/start-card.test.ts`).
- Checks: new `server/start-card.test.ts` (10), additions to `server/agent-cards.test.ts`, `server/tool-server.test.ts`, `server/connectors/linear.test.ts`. Not run: a live Paseo start (the plan's live check 1, Task 12).

## Delivery mode (branch `feat/single-pane`, Task 4) — 2026-11-08

- A card has a delivery mode: `branch` ("Branch, I bless", default per Q4), `draft_pr` or `ready_pr`. Host setting `delivery` (`deliverySettings`, `defaultMode`) under Settings > Workflow > Finishing cards > Delivery mode; New task has a **Delivery** choice seeded from it and sends the shown value as `taskInput.deliveryMode`. Quick task and agent-created cards send none, so they follow the default when the context is built. `Task.deliveryMode` is a plain string (max 40) so an unknown stored value loads, is kept, and is treated as the default. `shared/delivery-mode.ts` holds the modes, labels, `effectiveDeliveryMode` and `deliveryLine` (English).
- The session context (`sessionContext`, `BoardService.context` with a `deliveryDefault` option) ends with the mode's line; `flowly_get_task` returns the effective `deliveryMode` (`AgentService.deliveryDefault`, set in `index.server.ts`). The line goes last because existing context tests pin the order of the blocks before it. Draft and ready lines state that pushing and opening the PR still go through the user's permission prompt, and Ready PR never marks a PR ready while review notes are open. Flowly never pushes. AGENTS.md has the dated 2026-11-08 exception.
- Not done (outside the brief): the mode cannot be changed after the card is created (`taskEdit` unchanged).
- Strings: 6 new, in all 9 catalogs. Onboarding: a "Delivery mode" row in More features; no tip (a setting with a safe default). Telemetry: no heartbeat field.
- Checks: new `shared/delivery-mode.test.ts` (6), additions to `shared/scope.test.ts`, `server/service.test.ts`, `server/agent-service.test.ts`; `npm run typecheck` exit 0, `npm test` exit 0 (163 files, 1457 passed, 1 skipped). The New task row and the Settings select were typechecked only (plugin not installed per the plan's constraints).

## Extra artifact folders (branch `feat/single-pane`, Task 3b) — 2026-11-08

- New host setting `artifacts` (`artifactSettings`, `extraFolders`: at most 20 strings) edited under Settings > AI features > Artifacts (a field per folder, add and remove). `artifactRoots(task, project, workspaceDirectory?, extra)` appends `extraFolderRoots(extra)` (`~` expanded, normalized, deduplicated; empty, relative, `/` and the home directory dropped, so even a raw `""` or `/` handed to `artifactRoots` never becomes a root). `withinRoots` and `normalizeTarget` are unchanged. `ArtifactService` takes the getter in its constructor; `AgentService.extraArtifactFolders` is set by `index.server.ts`; both read the setting at each use, and `artifacts.status` caches on the folders too. Spec: CARD-ARTIFACTS-SPEC (2026-11-08 增量).
- Beyond the brief: the home directory and its ancestors are refused as roots (an agent could otherwise attach `~/.ssh` or `~/.aws` files); say so if it should be allowed. Fix round 1: the refusal is decided on real paths (`resolveExtraRoots`: realpath each folder, drop `/`, home and ancestors, unresolvable ones), so a link to `/` or home, a case variant of home and `/Users` no longer pass; the Settings row shows "Not used: …" for entries the server ignores by text (`extraFolderIgnored`, 1 more string).
- Strings: 4 new ("Folder" already existed), in all 9 catalogs. Onboarding: no tour row or tip (a setting for an existing feature). Telemetry: no heartbeat field.
- Checks: see the Task 3 report. The Settings group was not exercised in the installed plugin (not installed per the plan's constraints), only typechecked.

## Markdown export (branch `feat/single-pane`, Task 3) — 2026-11-08

- Settings > Storage > **Export as Markdown** copies every live project's open cards, open ideas and active memory to the clipboard. `exportMarkdown` (`shared/board-export.ts`, pure); RPC `board.export-markdown` `{ projectId? }` (`index.server.ts`, reads the board and `MemoryService.view`). The ideas section re-imports through `parseBacklog`: a note the parser would not read as a source note is written as `added <date>, <note>`; unbalanced parentheses in a note are dropped. `isSourceNote` is now exported from `shared/ideas-import.ts`. Open cards are written without a checkbox so only ideas re-import; a note-less idea whose title ends in an added-style parenthetical gets `(added <date>)`. Spec: IDEAS-IMPORT-EXPORT-SPEC §7.
- Strings: 2 new, in all 9 catalogs. Onboarding: no tour row or tip (a utility row in Settings). Telemetry: no heartbeat field.
- Checks: see the Task 3 report; the button was not exercised in the installed plugin (not installed per the plan's constraints), only typechecked.

## Ideas import (branch `feat/single-pane`, Task 2) — 2026-11-08

- Paste a markdown backlog on the Ideas page (**Import**), review the rows, import the checked ones as project ideas. `parseBacklog` (`shared/ideas-import.ts`); `ProjectIdeas.preview/import` (`server/project-ideas.ts`: one write, duplicates and bad rows skipped with a reason, replay by `operationId` from a 50-entry in-memory cache); RPCs `ideas.import-preview` / `ideas.import`; `client/ideas-import.tsx`. [IDEAS-IMPORT-EXPORT-SPEC](IDEAS-IMPORT-EXPORT-SPEC.md)
- Fixtures are synthetic (`shared/fixtures/backlogs/`, the repo is public): they reproduce each real line shape without copying text. A second test parses the real files from `FLOWLY_BACKLOG_DIR` or `~/.claude/backlogs` and is skipped when absent.
- Task 1 follow-ups: `adoptIdea` on a project idea fails with "A project idea has no card to continue in."; the overview carries `projectIdeas: [{ projectId, open }]` (a new overview collection) and the overview bar's Ideas count includes project ideas (`projectOpenIdeaCount`). PROJECT-IDEAS-SPEC §5/§6 and NATIVE-OVERVIEW-SPEC updated.
- Strings: 13 new, in all 9 catalogs. Onboarding: no tour row or tip: Import is a one-off action on a page the user already opened; revisit if a later task makes the Ideas page a headline feature. Telemetry: no heartbeat field.
- Checks: new `shared/ideas-import.test.ts` (15, incl. the real-files test), extended `server/project-ideas.test.ts` (import, replay, preview, adopt, overview count), `client/overview-query.test.ts`; `npm run typecheck` exit 0, `npm test` exit 0 (161 files, 1427 passed, 1 skipped). Not run: the Import modal in the installed plugin (not installed per the plan's constraints); the client is covered by typecheck and the shared/server tests only.

## Project-level ideas (branch `feat/single-pane`, Task 1) — 2026-11-08

- An idea can belong to a project instead of a card: `Idea.taskId`/`agentId`/`eventId` optional, new `source` (≤ 1000), `Task.origin.taskId` optional. No board version bump. `ProjectIdeas.propose/list` (`server/project-ideas.ts`): no open cap, unique open title per project (`DUPLICATE_IDEA`), `PROJECT_ARCHIVED` / `NOT_FOUND`, no board event. RPC `ideas.create-project`; `flowly_propose_idea` on board credentials (sessions outside cards; follows the Ideas switch, not the Cards switch). [PROJECT-IDEAS-SPEC](PROJECT-IDEAS-SPEC.md)
- Relaxed for ideas without a card: `store.updateIdea` (no per-card limit, no event), project remove/restore and the project folder snapshot (ideas by `projectId`), New card from an idea (`origin { ideaId }`, no derived link, no `idea_accepted` event), search (`projectIdeas` in `search.query` results, labelled with the project), Ideas page (a **Project** group first, no Continue in card), `groupByCard`/`visibleIdeas`.
- `projectIdeaInputSchema` omits `expectedRevision` and `request` as well as `scope` (a project idea has no card revision or signed request to carry).
- No new strings (**Project** exists in every catalog). Onboarding: no tour row or tip yet (the import in Task 2 is the user-visible entry). Telemetry: no heartbeat field.
- Checks: new `server/project-ideas.test.ts`, extended `server/tool-server.test.ts`, `server/search.test.ts`, `client/idea-rows.test.ts`; `npm run typecheck`, `npm test` exit 0. Not run: the Ideas page UI in the installed plugin (not installed here). Known gap: the Ideas count on the overview bar counts card ideas only.

## PR review cards (branch `feat/pr-review-cards`) — 2026-11-05

- New agents labelled `pr-review-watch` (from Noah's launchd `paseo run` job) become cards bound to their existing workspace through the New card *existing* mode (`server/pr-review-cards.ts`, `shared/pr-review.ts`): In review (else To do, else the first open lane), tag `pr-review`, operation id `pr-review:<agent id>`.
- Mechanism: the `agent.created` hook, plus `agent.turn_started` for agents created during a reload; the agent record is read once per run for its labels (the hook event has none). No backfill: agents over 30 minutes old or archived are skipped.
- Linear ticket block left out of a PR review card's context. New host setting *Make cards for PR review agents* (on), 1 new string in all catalogs.
- Onboarding: no tour row or tip (an opt-out automation for a personal job, nothing to point at in the UI). Telemetry: no field (off in this fork). Product note: v1 lists PR automation as out of scope; this is a user-requested exception that only mirrors an outside agent as a card.
- Checks: `server/pr-review-cards.test.ts`. Unrun: live check with a real labelled agent in a hidden worktree.

## All projects board (branch `feat/all-projects-tab`) — 2026-11-05

- **All** tab before the project tabs (desktop) and an **All projects** row at the top of the chooser (compact/phone; the switcher title reads *All projects*), shown while *Show All projects tab* is on (Settings → Workflow → Board, `board-view.allProjectsTab`, default on) and 2+ projects are live. The chooser button is now *Manage projects*. [ALL-PROJECTS-SPEC](ALL-PROJECTS-SPEC.md)
- Board: built-in statuses enabled in any live project, default lane names; cards of every live project with a project label; every card action uses the card's own project (`projectOf`). Drag between columns changes status; a lane the card's project lacks refuses the drop with a toast; within-column reorder and Move up/down are off. Manual sort groups by project in chooser order; other sorts apply across projects (`client/all-projects.ts`).
- New task, N, lane Add task and the empty hint open Quick task in the last quick-task project (else the first live one), even with *Quick task for New task* off. Filters, tags (union) and Search work across projects; Search hides its scope choice. Hidden in All: project settings, overview bar, tips, chooser Edit/Restore/Remove; I/B/M do nothing. Last-viewed can be All (`pickView`).
- 5 new strings in all 9 catalogs. Onboarding: new tip `all-projects` after `project-menu`; no tour row (the tab explains itself), no What's new (no release). Telemetry: no field (off in this fork).
- Review follow-ups: Search results show their project in All; More options… on All closes a drawer for another project's card; an All choice the board fell back from is replaced by the project shown (`staleAllChoice`).
- Command Center (Noah's request): exactly **Flowly: View board** (renamed from *Open Flowly*, id `open-board`) then **Flowly: Quick task**; *Flowly: Needs attention* left ⌘K (the attention intent, `A` and the button stay) and its string left every catalog. The list lives in `client/command-items.ts`; Paseo 0.15.0's host ranks a plugin's items by registration order (read from the installed app bundle, not the SDK types).
- Checks: `client/all-projects.test.ts`, `client/command-items.test.ts`, extended `client/project-memory.test.ts`, `client/onboarding-logic.test.ts` and `shared/settings.test.ts`; `npm run typecheck`, `npm test`. Not run: the installed plugin UI (desktop and phone) and the ⌘K list in the host.

## Linear Start card opens Quick task (branch `feat/linear-start-quick-task`) — 2026-11-05

- **Start card** on the Linear board now opens Quick task (not the full New task form) in the board's current project, with the issue attached as a removable chip and an external input (so the project's Linear ticket block never applies). Card title `KEY: issue title`; no AI title run for it; an empty text sends the full form's default first message, typed text is sent as typed. Removing the chip makes it an ordinary quick task. Open card is unchanged. Specs: LINEAR-BOARD-SPEC §5, QUICK-TASK-SPEC §9.
- Start card opens Quick task even when *Quick task for New task* is off (a design call: the setting is about the New task button).
- Strings: new placeholder and the onboarding Linear-board row reworded, in all catalogs. Onboarding: row updated; no new tip, no What's new entry. Telemetry: none.

## Quick task plan mode (branch `feat/quick-task-plan-mode`) — 2026-11-05

- Quick task defaults to the **plan** permission mode when the provider offers it (`quickTaskMode`, `useAgentChoice({ planFirst })`); no plan mode keeps the usual suggestion; a picked mode wins; project/provider switches re-apply it. The Agent chip now reads `provider · model · mode label`, one line. Other forms unchanged. [QUICK-TASK-SPEC](QUICK-TASK-SPEC.md)
- No new strings. Onboarding, What's new, telemetry: none (small default change).
- Checks: `quickTaskMode` cases in `shared/agent-defaults.test.ts`. Not run: the installed plugin UI.

## Linear ticket per card (branch `feat/quick-task`) — 2026-11-05

- Project form: **Make sure there's a Linear ticket** switch (`project.linearTicket`, absent = off) and, while on, a **Linear team** field (`project.linearTeam`, trimmed to one line, ≤ 80 characters, empty removes it). Both go through `projects.update` (`projectEdit`). [LINEAR-TICKET-SPEC](LINEAR-TICKET-SPEC.md)
- `linearTicketLines` (`shared/linear-ticket.ts`) adds a block to the session context (`sessionContext`, after inputs/outputs) when the switch is on and no artifact is a Linear item (connector provider `linear` or a `linear.app` link). It covers every session started from a card (Quick task, the full form, New session) and Send Kanban work instructions (`tools.prepare-session` / `tools.prepare-existing`), plus `tasks.context`; `flowly_get_task` does not return the context text, so the block reaches the agent at session start only. With agent artifacts turned off it does not ask for `flowly_add_artifact`: the search starts with the card's title and reuses a match, so a later session does not create a second ticket. The user's first message is unchanged. No Linear write code in the daemon.
- 4 new strings in all catalogs; the agent text stays English. Onboarding: no tour line or tip (an opt-in per-project switch, off by default, with no moment worth a tip). No What's new entry (no release). Telemetry: no field (off in this fork).
- Checks: `shared/linear-ticket.test.ts` (decision off / on with a ticket / on without, artifacts off, the generated text, its place in the context), `server/linear-ticket.test.ts` (store save, team clear, context follows the setting, artifacts off and a linked issue). Not run: the installed plugin and a real agent session with Linear tools.

## Quick task (branch `feat/quick-task`) — 2026-11-05

- **Quick task** dialog (`client/quick-task-form.tsx`): one box, Enter submits; Project / Agent / Workspace chips and More options…. Creates the card through `tasks.create` and starts the session through `launchKanbanSession`, like the full form, with a provisional title (`shared/quick-task.ts`) and the full text as the first message. [QUICK-TASK-SPEC](QUICK-TASK-SPEC.md)
- AI title: new RPC `tasks.quick-title` (`server/quick-title.ts`) returns at once; the summary models run in the project's background workspace and the result is merged in one transaction: the title only, and only while it is still the provisional one (ruling 2026-11-05: no type or tags; the agent's setup sets those). An edit draft opened before the AI title lands still saves (`onlyAiTitleSince` in `server/store.ts`), and the edit form sends the title only when changed. The client sends at most the 4000 characters the run reads (`quickTitleText`), so a long paste no longer fails the RPC's 20,000-character limit. Its session is hard-deleted like the memory review's (AGENTS.md exceptions extended).
- Entry points: New task button, `N`, lane Add task, phone Add task, project tab New task and the empty-board hint follow *Quick task for New task*; `Q` and Command Center **Flowly: Quick task** always open it. Project (ruling 2026-11-05): New task and `N` use the board's project; only `Q` and the Command Center start from the last quick-task project. The full form accepts the hand-off (instruction, workspace mode, images, agent).
- Settings (board view, host-scoped): `quickTaskDefault`, `quickTaskAiTitle`, `quickTaskMode`, `lastQuickProjectId`; Settings → Workflow → Quick task, with the run's estimated cost (`quickTitle` in `shared/ai-cost.ts`, an estimate, not measured).
- 12 new strings in all catalogs. Onboarding: a **Quick task** row first under More features and a new tip `quick-task` (lowest priority). No What's new entry (no release in this change). Telemetry: no heartbeat field (telemetry is off in this fork).
- Command Center trimmed to three items: **Open Flowly**, **Flowly: Needs attention**, **Flowly: Quick task** (QUICK-TASK-SPEC §7). New task, Switch project, Search, Search and filter tasks, Keyboard shortcuts, Welcome tour and the workspace-context Open workspace card are gone from ⌘K; their intents, buttons, shortcuts and the workspace panel are unchanged. The seven titles left every catalog, and the tour's last-page hint no longer points to the Command Center.
- Checks: `shared/quick-task.test.ts`, `client/quick-task.test.ts`, `server/quick-title.test.ts`, extended `shared/settings.test.ts`, `client/shortcuts.test.ts`, `client/onboarding-logic.test.ts`, `shared/ai-cost.test.ts`. Not run: the installed plugin, a real model run, the phone.

## Linear board in the main bar (branch `feat/linear-board`) — 2026-11-04

- A **Linear** row in Paseo's sidebar (only with a Linear connection) opens a board of Linear issues: Assigned to me or any team the key sees, columns by state type (Backlog, Todo, In progress, Done, Canceled; custom states by type), finished issues limited to the last `hideFinishedAfterDays` days, a remembered Board/List toggle (list on compact layouts by default) and a connection switch with several Linear connections. Pressing an issue opens the existing item preview; **Start card** opens Quick task in the board's current project with the issue attached, the card titled `KEY: title` and the text optional; an issue already on a card shows a Card marker and **Open card**. Read-only: two new `query` documents (`Scope`, paged by cursor, at most 4 × 50; `Teams`). [LINEAR-BOARD-SPEC](LINEAR-BOARD-SPEC.md)
- Status filter (user request): a chip per column hides or shows it in both layouts, remembered as `linearHidden`; client-side only. Tests in `shared/linear-board.test.ts` and `shared/settings.test.ts`; no new strings (chips reuse the column titles).
- New RPCs `connectors.linear-board`, `connectors.linear-teams`, `connectors.read-item`; board-view settings gain `linearLayout` and `linearScope` (no board data change). `ExternalPreview` now wraps a shared `ItemPreview`.
- 17 new strings in all catalogs. Onboarding: a **Linear board** row under More features; no new tip id; no What's new entry. Telemetry: no heartbeat field.
- Checks: `server/connectors/linear-scope.test.ts` (5), `shared/linear-board.test.ts` (3), `client/linear-start.test.ts` (4), `shared/settings.test.ts` (extended). Not run: the live Linear API, the installed plugin, the phone.

## Optional first instruction when New task has attached items (user decision) — 2026-11-04

- New task → Start an agent now: with at least one item picked with **From …** (any service), an empty Instruction no longer blocks Create and start. The placeholder reads "Optional: the agent starts with the attached items", and the agent gets `Start on this card: read its inputs, including <keys>, then begin.` (agent-facing, English). Typed text is sent as before, without the default; without an attached item the instruction stays required. [UI-REFRESH-SPEC §7s](UI-REFRESH-SPEC.md), [CONNECTORS-SPEC §8.2](CONNECTORS-SPEC.md)
- `client/first-message.ts` (pure) decides the message and whether Create can proceed; `client/first-message.test.ts` (4). One new string in all catalogs. Onboarding: no tip or tour change (the placeholder says it). Telemetry: none.

## Linear connector (branch `feat/linear-connector`) — 2026-11-03

- Sixth connector family `linear` (provider `linear`): Linear issues as read-only card inputs, with **From Linear** in New task, a Linear entry in the Artifacts +, and a Linear group in Settings → Connections. [CONNECTORS-SPEC §14](CONNECTORS-SPEC.md)
- Connection: a name and a personal API key, no address field. The key goes as `Authorization: <key>` to the fixed `https://api.linear.app/graphql`; the account check (`viewer`) reports the workspace, and the connection's address becomes `https://linear.app/<urlKey>`, used only to recognize and build links. New registry flag `noAddress`, and `verify` may return `baseUrl`; editing keeps the stored key.
- `server/connectors/linear.ts`: GraphQL through `ReadOnlyHttp.query` with `/graphql` as the only endpoint; every document must start with `query`. Recent = assigned to me and not completed/canceled, by `updatedAt`; search by key or link, by number across teams, or by title words (one `containsIgnoreCase` per word, all as variables). Read: description (Markdown as is), state, priority, assignee, creator, team, project, labels, parent, latest 20 comments. Batch summaries in one aliased request. Fingerprint: title, description, comment ids and update times; `updatedCoversContent: false`. Errors: AUTHENTICATION_ERROR/401 → AUTH, FORBIDDEN/not found → NOT_FOUND, RATELIMITED (429 or 400) → UNAVAILABLE with `Retry-After` or the reset header.
- Brand icon from the Simple Icons Linear path (#5E6AD2) as a 48 px PNG. 7 new strings and 2 changed (tour line, `jira-connect` tip) in all catalogs. README, skill text and ONBOARDING-SPEC tip table list Linear. Onboarding: no new tip id (the existing `jira-connect` and `connectors` tips cover it); no What's new entry. Telemetry: no heartbeat field.
- Checks: `server/connectors/linear.test.ts` (9, recorded-shape GraphQL fake) and Linear cases in `shared/connectors.test.ts` (3); `npm run typecheck` exit 0, `npm test` exit 0 (147 files, 1287 passed, 1 skipped). Not run: the live Linear API and the installed plugin UI.

## Switch a card between local and worktree (card "switch local and worktree") — 2026-10-29

- New card action *Switch to worktree…*: Flowly snapshots the main checkout (HEAD, `git diff --binary HEAD`, untracked files), creates a worktree at that commit, copies everything in, writes a handoff folder (`.flowly/handoff/<id>/`: `handoff.md` as a user input, old sessions' transcripts, `snapshot.patch`), moves the card (`previousWorkspaces`, `switch`), and archives the old workspace and sessions. Nothing starts. *Switch to local…* goes back; its dialog shows both branches with their last 5 commits and the changes per folder (first two directory levels) side by side; with uncommitted worktree changes the user picks *Copy* (applied as unstaged changes, checked per file in a few batch runs: already there is skipped, a conflict disables it), *Overwrite* (Copy plus the worktree's version of each conflicting file, the main checkout's saved to `main-before/`) or *Discard*; either way they are first saved as `worktree-uncommitted.patch` in the handoff folder and the plugin data folder. [WORKSPACE-SWITCH-SPEC](WORKSPACE-SWITCH-SPEC.md)
- Agent tool `flowly_handover` (CLI `handover`) stores the card's own files and notes; *Ask {session} for a handover* sends a fixed prompt to an idle session. After a switch the new session trims the worktree, then the user presses *Release from main…*: Flowly removes exactly the worktree's diff from the main checkout's working tree (and index where staged), after `git apply --check` both ways; backup patch, *Undo release*.
- Agent tool `flowly_integrate` (CLI `integrate`): fast-forward only, applied as a patch to the main checkout's index and working tree, compare-and-swap `update-ref`; refuses `RELEASE_PENDING`, `REBASE_NEEDED`, `CONFLICT`. The agent then sets Integrated. Skill text and `AGENTS.md` updated (new exception; the `git reset origin/main` recipe points switched cards to `flowly_integrate`).
- History follows the card: archived sessions, usage, insights and workflow insights also read the earlier workspaces; their archived sessions open read-only.
- 58 new strings in all catalogs. Onboarding: a *Switch to a worktree* line in the tour's More features; no tip (the release notice explains the only non-obvious step). Telemetry: none.
- Checks: `server/workspace-git.test.ts` (15), `server/workspace-switch.test.ts` (12), `shared/workspace-switch.test.ts` (3), handover write in `server/agent-service.test.ts`, CLI refusals in `server/tool-server.test.ts`; `npm run typecheck` and `npm test` on HEAD plus this card's changes in a temporary worktree. Live check (§15) not run yet.

## Worktree / Local on the card (card "badge for worktree vs local") — 2026-10-29

- Board cards show where they work, first in the meta row: *Worktree* (`GitBranch`) for a Paseo worktree workspace, *Local* (`Folder`) for every other kind. `resources.list` now carries Paseo's `workspaceKind` as `kind`; the board maps it with `cardWorkspace` (`shared/card-display.ts`), no new request. No badge when the workspace is not live. New hideable field *Workspace* in Settings → Cards (default on); the accessibility label always names it. [CARD-DISPLAY-SPEC §8](CARD-DISPLAY-SPEC.md#8-workspace-kind)
- The card sidebar shows the same badge first in its Status / Priority / Type row, read-only, from its own workspace read; not affected by the Cards switch. Label and icon shared in `client/status.tsx` (`workspaceLabels`, `WorkspaceIcon`, `workspaceLabel`). [DRAWER-SPEC, Workspace kind](DRAWER-SPEC.md#workspace-kind)
- Four new strings in all catalogs. Onboarding: no tip or tour copy, the badge explains itself. Telemetry: no heartbeat field.

## Agent speed (card "speed settings for agents") — 2026-10-29

- The agent picker (New session, New task → Start an agent now) has a **Speed** row when the chosen model offers one: Paseo's provider features `service_tier` (Codex select) and `fast_mode` (Claude toggle, Opus), read with `providers.listFeatures` and sent as `featureValues` at creation; normal speed sends nothing. The latest session's speed is the starting point for the same provider. [AGENT-SPEED-SPEC](AGENT-SPEED-SPEC.md)
- Not covered: changing a running session's speed (no SDK or CLI call) and a speed in default models.
- Two new strings (*Speed*, *Standard*) in all catalogs. Onboarding: no tour copy or tip; the row explains itself where it appears and only for models that offer it. Telemetry: no heartbeat field.

## Agent card tools (card "create cards via ai agent") — 2026-10-29

- New MCP tools `flowly_list_cards`, `flowly_get_card`, `flowly_create_card`, `flowly_update_card` (`server/agent-cards.ts`), also as CLI commands `cards`, `card`, `create-card`, `update-card` and HTTP API actions. User decisions D1–D4: create or edit only when the user asks (amends IDEAS-SPEC §1); edit any live card of the project; a new card gets a directory workspace in Backlog/Todo and no session; any Paseo session in a Flowly project's workspaces may call them. [AGENT-CARDS-SPEC](AGENT-CARDS-SPEC.md)
- Creation goes through `BoardService.createTask` with `by: { agentId }`: `created` event and tags are attributed to the agent; from a card session the new card follows up the source card (`derived`, `createdBy: system`) and the source card gets `card_created`. Idempotent per `idempotencyKey`; at most 20 creations per session per hour (in memory).
- Sessions outside cards: `agent.session_open` adds a `flowly-board` MCP server with an HMAC-sealed board credential (`{ agentId, workspaceId, projectId }`, purpose `board`) when the host's request has `mcpServers` (Paseo 0.14; the pinned 0.11.2 SDK types lack it, so it is feature-detected). Each call re-checks the session, workspace and project. The CLI stays card-only.
- Settings → AI features → Cards: *Agents create and edit cards* (`ideas.agentCards`, default on). Five new strings in all catalogs (switch title and detail, *Created a card*, the More features entry). Onboarding: one More features line, no tip. Telemetry: no heartbeat field (telemetry is off in this fork). Skill text (server and `skills/flowly/SKILL.md`) says when to create cards vs. propose ideas.
- Checks: `npm run typecheck` and `npm test` passed on the shared working tree (uncommitted). Live on Paseo 0.14 in the paseo-playground project: a session outside cards got the `flowly-board` server and created, replayed and edited a card with full agent attribution; a stale revision was refused. Not run live: the `STATUS_FORBIDDEN` refusal (unit-tested). Fixture removed afterwards. [verification](verification/agent-cards.md)

## Integrated stage (card "integrated stage") — 2026-10-29

- New built-in status `integrated` (*Integrated*, `GitMerge`, success colour) right after Committed; it joins `deliveryStatuses`, so outputs, Move to Done, the workpad/setup gate, the delivery snapshot, the reminders and the memory clue treat it like Committed without new cases. Spec: [INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md).
- Meaning (user decision): all of the card's commits are in the branch checked out in the main checkout (normally `main`); no remote push needed; the agent sets it, the daemon does not read git. Committing directly on that branch goes straight to Integrated.
- Stored lanes: no new code; `completeLanes` inserts Integrated right after Committed in 9- and 10-lane configurations (tests for lanes, `board.json` v5 and SQLite rows).
- Agents: `agentStatuses`, tool description, CLI (`status integrated` with outputs/moves/acknowledge-open), skill + `SKILL.md` and turn checklist. A1/A1r resume and restore it like Committed. Review rounds ignore moves between delivery statuses (`isDeliveryStatus`).
- Strings: *Integrated* and the agent-tools note (*…to Blocked, In review, Committed or Integrated…*) in all catalogs. README (en, zh-CN) loop sentence ends in Integrated. Onboarding: no tour copy or tip (same reasoning as Committed); telemetry unchanged.
- Checks on the shared working tree (uncommitted, HEAD 9d1d9cf + other sessions' work): `npm run typecheck` exit 0; focused `npx vitest run shared/lanes server/migrate server/agent-service server/progress-rules shared/workflow-stats server/skill-source server/cli` 81/81; `npm test` 1234 passed, 1 skipped. `paseo plugin reload flowly` at 23:55: store ready, no load errors; live `flowly_get_task` lists Integrated in lanes and allowedStatuses; runtime SKILL.md carries the guidance. Not run: visual board/phone check; a live project with a stored lane config (none of the local projects has one).

## Committed stage (card "commited stage") — 2026-10-29

- New built-in status `committed` (*Committed*, `GitCommitHorizontal`, success colour) after In review. `deliveryStatuses`/`isDeliveryStatus` in `shared/model.ts` replace the `=== "in_review"` delivery checks in the agent write path (outputs, Move to Done, workpad/setup gate, HEAD stamp), reminders, the workpad delivery mark, agent habits and the memory feedback clue. Rules A1/A1r treat Committed like In review. Review rounds skip In review → Committed. [COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md)
- Stored lanes: `completeLanes` runs inside `lanesSchema`, so SQLite rows, `board.json`, project-folder imports and RPC input with 9 lanes get Committed after In review, enabled; `projectLanes` inserts instead of appending. No board version bump.
- Agents: `agentStatuses`, tool description, CLI (`status committed` with outputs/moves/acknowledge-open), skill + `SKILL.md` and turn checklist say to set it only once all of the card's changes are committed.
- Strings: *Committed* and the reworded agent-tools note in the session settings (*…to Blocked, In review or Committed…*) in all catalogs. README (en, zh-CN): the loop sentence ends in Committed. Onboarding: no tour copy or tip; the tour's lane strip shows the basic loop and the lane shows on every board. Telemetry: no heartbeat field; `c_deliveries` stays In review only.
- Checks in a temporary worktree of `7495a7c` with only this change: `npm run typecheck` exit 0; focused tests 134/134; `npm test` 1207 passed, 1 skipped, 0 failed. On the shared working tree (other sessions' uncommitted work included): typecheck exit 0; `npm test` 1215 passed, 1 failed, 1 skipped; the failure is `server/tool-server.test.ts` "MCP initialize/list…", which lists four new `flowly_*_card` tools from the uncommitted agent-cards work, not this change. Not run: plugin reload, UI check.

## Open workspace from a card (card "button to open associated workspace") — 2026-10-29

- Board cards get an **Open workspace** button (`ArrowUpRight`) under `…` in their top-right action column, same size and visibility as `…`; it calls the host's `navigation.openWorkspace` for the card's workspace on its host (`openNativeWorkspace`, `client/session-state.ts`). Shown only when the host offers it and the workspace is live (the *Workspace unavailable* test). The card's context menu and the `…` action sheet list *Open workspace* after *Open details*. Short cards grow to fit the two-button column; titles keep their width. [CARD-DISPLAY-SPEC §7](CARD-DISPLAY-SPEC.md#7-open-workspace-button)
- The card sidebar's header gets the same button left of the pencil (Edit), at the user's request, disabled while the workspace is checked or unavailable. This replaces the 2026-10-14 "No Open workspace action" ([DRAWER-SPEC](DRAWER-SPEC.md#open-workspace)).
- Two new strings (*Open workspace*, *Open workspace for {title}*) in all catalogs. Onboarding: no tour copy or tip; the button is on the card itself. Telemetry: no heartbeat field.

## Card sidebar without a fixed maximum width (card "unlock the sidebar max width") — 2026-10-29

- The desktop card sidebar no longer stops at 720 points: `drawerWidth` keeps the 340-point minimum and the 300 points of board plus grip, nothing else. The grip's accessibility maximum follows the window. [UI-UX-SPEC §4](UI-UX-SPEC.md)
- The width is a share of the Flowly area (user decision 2026-10-29): a sidebar never dragged opens at 50% (was 440 points), and a dragged width is saved as `board-view` `drawerShare`, so it scales between screens. The point value `drawerWidth` is gone; a sidebar dragged before opens at 50% once.
- No new strings. Onboarding: no tour copy or tip; dragging wider is self-explanatory. Telemetry: no heartbeat field.
- Checked in the app ([evidence](verification/sidebar-max-width-2026-10-29/report.md)).

## Telemetry hard-off (card "hard disable telementry") — 2026-10-29

- `POSTHOG_KEY` is empty, so the heartbeat and `$exception` reports send nothing and no `telemetry.json` is created, whatever the setting or environment says. `TelemetryService.builtOff()` reports it, and `telemetry.status` now returns `builtOff`. Settings → General and the tour's last page show *Send anonymous usage data* off and locked with *Turned off in this build.* (new string in all catalogs). [TELEMETRY-SPEC §5, §6](TELEMETRY-SPEC.md)
- Guard: a test in `server/telemetry.test.ts` fails when the key is not empty, for example after an upstream merge.
- README, OVERVIEW and What's new 1.7.0 are unchanged (user's choice). Onboarding: no new tip; the tour's switch shows the locked state on its own.

## Search (card "搜索功能") — 2026-10-27

- Focus from search: a hit row opens the card at its section and item (Progress, Activity, Workpad, Ideas, Artifacts), widening Activity's last-12 window, Workpad/Artifacts pages and Ideas → Closed to reach it, then a short accent ring; the stored section choices are untouched ([DRAWER-SPEC](DRAWER-SPEC.md#focus-from-search), `client/drawer-focus.tsx`).
- [SEARCH-SPEC](SEARCH-SPEC.md): `search.query` scans the cached board, the latest summary per card and active project memory in the daemon (`server/search.ts`); summaries/memory are re-read only when their file changes and the text index is rebuilt per board revision.
- Search page (`client/search-page.tsx`): header icon, `S`, Command Center `Flowly: Search`, Search everywhere in the filter dialog; This project / All projects, source chips, results open their card (switching project).
- `flowly_search` MCP tool, CLI `search`, HTTP `/api` action `search`; skill text points agents to it. Ideas, deliverables and memory follow their switches.
- Onboarding: tip `search`, tour More features entry, What's new 1.8.0, README highlight; 19 new strings in all catalogs.
- Self-test results: see the card's workpad; UI verification on Tinylink and the independent haiku run are recorded separately.

## v1.7.1 release (card "遥测错误分析") — 2026-10-27

- Version 1.7.1 (`make bump`). Release notes: [release-notes/v1.7.1.md](release-notes/v1.7.1.md), covering v1.7.0..main (#69, db1d734, 4476b43).
- No What's new entry and no tour or tip change: the release fixes existing behavior; the tabbed questions are found where questions already appear.

## Telemetry error fixes (card "遥测错误分析") — 2026-10-27

- First two days of `$exception` reports (34 events, 35 installs) grouped and mapped to source with `scripts/map-bundle-lines.mjs`: [verification/telemetry-errors-2026-10-27.md](verification/telemetry-errors-2026-10-27.md).
- Local daemon connection (`server/local-daemon.ts`, 13 events): `paseo.pid` addresses are resolved like the `paseo` CLI, including Unix sockets and Windows named pipes (through the bundled `ws`, now a pinned dependency; typed by `server/ws.d.ts` because `@types/ws` breaks the daemon's timer types). An empty address (Paseo restarting the daemon) is `LocalDaemonUnavailable`. Fixes read-state sync, workspace restore, background-workspace reuse, attention clearing, summarizer delete and `paseo_version` on those installs. [WORKSPACE-RESTORE-SPEC](WORKSPACE-RESTORE-SPEC.md)
- Windows CLI (`server/paseo-cli.ts`, 3 events): `paseo.cmd` is started as the command it wraps (`Paseo.exe` + runner + CLI entry, or Node + npm's `bin/paseo`), never through cmd.exe; session settings and native project create/delete share it. [UI-REFRESH-SPEC](UI-REFRESH-SPEC.md)
- Not reported any more (logged as before): `DaemonConnectionError`, `LocalDaemonUnavailable`, `SummaryModelError`. A missing folder or session image is answered with a plain message instead of `ENOENT`. [TELEMETRY-SPEC §11.2](TELEMETRY-SPEC.md)
- Not verified on Linux or Windows hardware; see the report.
- Onboarding: no tour, tip or What's new change; these are fixes to existing behavior.

## v1.7.0 release preparation (card "v1.7.0发布") — 2026-10-26

- Version 1.7.0 (`make bump` now also sets `shared/version.ts`, which `server/telemetry.test.ts` keeps equal to package.json). Release notes: [release-notes/v1.7.0.md](release-notes/v1.7.0.md), covering v1.6.0..main (#57–#67 and the Insights redesign).
- What's new 1.7.0: six items (Insights redesign, skill drafts, faster loading, phone settings and the running sweep switch, SQLite with backups, usage data); the old Insights one-liner is replaced in all catalogs. [WHATS-NEW-SPEC](WHATS-NEW-SPEC.md) §6.
- What's new navigation (W5): ‹ Flowly x.y › beside the version pages left to older and right to newer releases, items slide in from that side; the footer keeps only Got it. §5.0.
- Welcome tour: the Insights page sample now shows weekday labels, a selected day, the day summary card with per-card bars and a two-line skill row, matching the 1.7 Insights page.
- README / README.zh-CN and the registry media (`assets/screenshots/`) reshot with `docs/promo/shots.mjs` (it now parks the mouse before each shot and selects the latest active day in Insights); Settings path for Moving cards and the storage paragraph corrected. `06-next-moves.png` not reshot (its fixture script still uses `board.read`); it still shows the composer hint row removed in 1.6.
- Live check on the installed build: `docs/verification/release-v1.7.0-2026-10-26/`.

## Loading R2: no whole-board reads — 2026-10-26

- User decision 2026-10-26: every layout reads the overview plus card detail; no switch back to the whole board and no user option. The maintainer uses it first and fixes what shows up. [Spec](LOADING-R2-SPEC.md)
- Client no longer calls `board.read-changed`: the wide board polls the overview, the drawer reads card detail, Ideas read the project's ideas, the task form reads the project card index (new `externals`), the connection editor reads `linkedCards` from `connectors.connections`, the Next moves and Ideas actions read only their card or project, idea links carry `projectId`. Server handler kept for older clients.
- Parity on a copy of the maintainer's data (107 cards, 4552 events, 118 sessions in 5 attention states each, finished-card cutoffs from 6 h to 30 days): overview facts equal the old whole-board derivations (`docs/verification/loading-r2-2026-10-26/parity.test.ts`). It catches 3 of 4 injected server bugs; the 4th (`hadTurnEnd`) is invisible on this data because every session has a turn end.
- Timing, wide 1700×1000, Flowly project, 3 runs each: first card 577/605/605 ms before, 503/968/463 ms after; first 10 s received 5.3–5.5 MB before, 2.3–2.9 MB after (the rest is Paseo's and Flowly's other reads). `timing-before.json`, `timing-after.json`.
- Live check after installing 5d8cb95 (merged with main after Insights v3): no `board.read`/`board.read-changed` sent while opening the board, a card, a session preview and the New task form; the overview polls every 3 s; a wide session preview keeps polling its card (4 detail reads in 12 s). Screenshots in `ui/` (desktop board, card, session preview, New task; compact board). Phone timing (§4.3) not run.
- `docs/promo/shot-lib.mjs` `hidePrivate` hid the whole compact board (the walk up from the project label reached the column holding the board); it now hides only siblings on the tab's own row.
- Independent verification (Haiku 5.5): first round on 16a117d found the wide preview polling stop, the lost idea-link retry and swallowed read errors (fixed in 24e417c) and parity gaps (closed in 24e417c and 96b4620); re-verification on 24e417c confirmed the fixes. Report: `docs/verification/loading-r2-2026-10-26/README.md`.
- Onboarding: no tour, tip or What's new change; nothing new to point at, the board only loads less.

## Anonymous usage data (telemetry) — 2026-10-26

- User decisions 2026-10-26: PostHog Cloud EU over its capture HTTP API (no SDK), one daily heartbeat, whitelisted fields, on by default and sent before the user has seen the notice, off stops everything, no preview or reset ID, `ui_locale` instead of GeoIP. [Spec](TELEMETRY-SPEC.md).
- Implemented: `server/telemetry.ts` (heartbeat, `telemetry.json`, forced-off env), `telemetry` host setting and `telemetry.status` RPC, Settings → General *Usage data* and the tour's last page, What's new 1.7.0 item, README sections, catalogs in all 9 languages. `server/telemetry.test.ts` covers spec §9 items 1–8.
- 2026-10-26 error reports (user decision: separate `$exception` event with a cleaned stack, daemon only; spec §11): `server/error-report.ts` cleans stacks (type, safe code, Flowly's own frames relative to the plugin folder, no message), `reportRpcErrors` wraps every `server.handle` (expected errors skipped), `logFailure` replaces the background `console.error` sites, `uncaughtExceptionMonitor` for errors through Flowly code; each kind once per UTC day, 20 a day. Setting detail and What's new 1.7.0 text mention errors (9 catalogs). `server/error-report.test.ts` covers §11.5.
- 2026-10-26: `POSTHOG_KEY` filled in. The maintainer's PostHog project is in the US region (the EU endpoint rejected the token, `us.i.posthog.com/flags` accepted it), so per the user's decision the endpoint moved to `https://us.i.posthog.com/i/v0/e/`.

## Board data in SQLite (minimal) — 2026-10-26

- User decision 2026-10-26: finish the SQLite move first, loading later; keep rollback and no data loss, otherwise as simple as possible. Replaces the 10-25 full design (D1–D4); the old fixture kernel, specs and evidence are on the local branch `archive/sqlite-r1-v1`. [Spec](SQLITE-STORAGE-SPEC.md).
- `BoardStore` keeps every business rule; only load/save moved behind a persistence seam (`server/board-file.ts` JSON, `server/sqlite-storage.ts` SQLite). One generic `items` table keyed by collection and element key, row-level diff written in one `BEGIN IMMEDIATE`; cached board, owner lock (`storage-owner.sqlite`).
- First start: snapshot to `migrations/`, build `flowly.sqlite.tmp`, integrity check and value-for-value comparison with the existing reader, one rename, then `board.json` becomes a marker older versions refuse. Any failure before the rename stays on JSON and retries at the next start. Daily backups (7), restore with a revision offset, export back to v5 JSON (`storage-mode.json`), Settings → Storage with five RPCs. Attached JSON files, composer, flow logs and read paths unchanged.
- Self-checks: typecheck PASS; `npm test` 129 files / 1056 tests PASS (1 skipped: the crash child); `server/sqlite-store.test.ts` 31, `server/sqlite-parity.test.ts` 1 (the same operations on JSON and SQLite give the same board after every step, project create/remove included), `server/sqlite-crash.test.ts` 3 (real SIGKILL before/after the rename and inside a write). Five deliberate bugs in the row diff and restore were each caught. The agent suites with the fixture on SQLite pass 119/125; the six others build a second JSON store on the same folder or corrupt board.json directly.
- First independent verification (Haiku 5.5, on 2334d58): checks PASS; a real-runtime rehearsal on a copy of the maintainer's data (106 cards, 4515 events, 2730 receipts; 4.9 MB board.json → 7.0 MB database) passed 23/23: move + first read 376 ms, later reads 7 ms, an edit 22 ms. It found an export stopped between its two file writes blocking the next start (fixed: mode file first, a marker means the export did not happen), a failed rename after export leaving every read busy (fixed), same-second backups pruned in the wrong order, a restore that reported success while the database could not open, the migration rename outside its fallback, and 0644 backups/snapshots (all fixed, with tests). Re-verification on 62ec9e9: all PASS, rehearsal 23/23 again (move + first read 488 ms, reads 7 ms); its one Low (a restore that cannot open the backup now says the backup is in place) is fixed with a test. UNRUN: a kill inside the Helper runtime, and the Settings → Storage UI, which needs the plugin installed on real data (the switch).
- Switched the maintainer's data after the merge (user's go-ahead): 365 ms for 107 cards / 4552 events, the backup taken at the move equals the original board.json field for field, reads and writes work, Settings → Storage checked on desktop (compact only partly capturable with shot-lib). See `docs/verification/sqlite-min-2026-10-26/switch.md`.
- Onboarding: tour More features gets Backups; What's new 1.7.0 gets one item with Open settings → Storage. No tip: nothing to point at during normal use.
- Independent milestone verification (claude/claude-haiku-5-5) and the real-data copy rehearsal: see `docs/verification/sqlite-min-2026-10-26/`.
## Insights third version: activity and Skills (card "Insights重设计") — 2026-10-25

Spec: [INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md) (third version, accepted 2026-10-25; plan in §11). The user found the second version "一般": attention per card, the time table and Agent habits were not useful to ordinary users and the daily record never produced a summary. They asked for a GitHub-style activity heatmap and for Insights to turn repeated work into reusable skills.

- [x] `shared/activity.ts`: 53-week heatmap data from the flow log (turns, active cards, cards done), quartile levels; `insights.project` returns `{ today, activity, workflow, habits? }` without git or running-session reads.
- [x] Digest: one generation per project with the last picked day waiting; `DIGEST_DAYS` 400; a past day is summarized when selected (fixes the empty daily record).
- [x] `shared/workflow-stats.ts` slimmed to the last 7 days' rounds, one-pass share, models and tokens per card; second-version attention, time, weeks, baseline and anomalies removed.
- [x] Agent habits behind the host setting `developer.agentHabits` (no settings page).
- [x] Skills in the workflow-insights run: on by default, first scheduled run one interval after collecting starts, new quiet rule, material from cards, the owner's words (memory clues), memory and project skills, skill prompt and validation (max 3, names, lengths, redaction, updates only of Flowly's skills), per-kind replacement.
- [x] `workflow-insights.install-skill`: `.agents/skills/<name>/SKILL.md` plus a relative `.claude/skills/<name>` link; foreign entries and failed links reported, never copied; no git.
- [x] Client: heatmap, day panel, Skills (new / update with diff / in the project), Other suggestions and Workflow folded; settings renamed Skills; tour page 4; tip `first-skill-draft` (replaces the unreleased `insights-redesign`); What's new 1.7.0; nine catalogs.
- [x] `npm run typecheck`, `npm test` in the isolated worktree (`feat/insights-v3`).
- [ ] Live checks need this branch installed: Run now on Flowly, Add to project on Tinylink, screenshots, Luna 6 full-access (not run).
- [ ] README screenshots `05-insights*.png` still show the first version.
- 2026-10-26 after the live check (user notes): Other suggestions, Dismissed and Workflow lists start at the page's left edge and skill rows are two lines; the heatmap's weekday labels are no longer cut off and its columns fit the page; the Back bar of Insights, Ideas and Memory is as high as the task card's icon row (`pageBarHeight`); the page felt empty, so Workflow opens by default and a "Last 7 days" list sits under the day panel (spec §2.2, §10.8). Candidates not built, from the data the page already has: areas the last 7 days' finished cards belong to (tags), memory entries confirmed this week, the busiest cards of the week.
- 2026-10-26 day summary card (user): the day panel and the Last 7 days list became one card that pages to the previous/next day with activity (or a heatmap pick): the day's numbers (turns, cards, done, agent time, tokens), its AI summary and its cards, the busiest first, each with a bar for its share of the busiest card's agent time (heatmap opacity scale). New `insights.day` RPC; pure `shared/day-detail.ts` (+4 tests): agent time is session run time clipped to the day, tokens are the day's 15-minute buckets of the cards' sessions, read in a second call so the card never waits on logs. Spec §2.2, §7, §10.9.


## Insights redesign (card "Insights重设计") — 2026-10-22

Spec: [INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md) (second version). The user rejected an output-statistics page ("it should not make people anxious or push them to grind") in favour of evaluating the workflow itself.

- [x] Spec v2 reviewed and accepted; decisions in §13.
- [x] Data: `agent.turn_ended.byUser` (`startedByUser`, injections filtered) and `agent.permission_requested.tool` (name only), in board events and the flow log.
- [x] `shared/workflow-stats.ts`: per-card stats to the first Done (interventions, review rounds, three-way time split, model), window and 4-window baseline, models with "other", 8 Monday weeks with landed suggestions, R2/R3/R6 anomalies (R3 now 3 rounds), tokens per card over its active span. First version's `shared/work-stats.ts` and `client/charts.tsx` removed.
- [x] RPC: `insights.project` and `insights.tokens` take `end`; `insights.digests` for the daily record.
- [x] Client: single column, theme colors, no chart, no tabs; daily record collapsed.
- [x] Onboarding: tour line and tip `insights-redesign` text; README (en, zh-CN); nine catalogs.
- [x] `npm run typecheck`, `npm test`.
- [ ] Luna 6 full-access UI verification (not run).
- [ ] README screenshots `05-insights*.png` still show the old page.

## Configurable summary models — 2026-10-23

- User-requested ordered model list in Settings → Models and the welcome tour: add, move up/down, remove, reset to Haiku→Luna; preserve legacy Auto/single-model choices. Additive v1 `summaryModels`, no write-on-read migration.
- Shared runtime fallback now covers Progress, outside-session insights, digest and finished-card memory review; unavailable candidates skipped, valid output stops, cleanup precedes retry, persistence stays outside retry. Existing workspace ownership preserved.
- PASS independent full-access Luna: focused 167, typecheck, full 111 files / 958 tests. Reloaded. Real UI add/remove/reorder/duplicate/final-item/persistence and 820px compact desktop passed; real custom order skipped an unavailable candidate and ran Luna first. Original settings/onboarding restored exactly; test child and independent session deleted.
- UNRUN full phone/native layout: at 580px the host navigated back to Community. Dark theme not separately exercised. Existing theme primitives reused.
- Onboarding, READMEs, one-time tip and all catalogs updated. The optional What's new announcement remains with its separate uncommitted feature. [Spec](SUMMARY-MODELS-SPEC.md), [verification](verification/summary-models-2026-10-23.md).

## Summary runtime fallback — 2026-10-22

- Fixed card Progress Auto summaries: available candidates are tried once in order (Haiku → Luna), including quota/runtime/create/wait/timeout/permission/schema failures. Explicit model selections stay fixed. Successful output or valid `update=false` stops; only a successful model is saved, all failures keep the previous summary, and storage errors never trigger another model call.
- Spec: [TASK-SUMMARY-SPEC §4/§8](TASK-SUMMARY-SPEC.md). Focused 41 tests PASS; independent Luna full-access typecheck PASS. Live reload + this card's Refresh observed Haiku then Luna, saved a Luna summary, and confirmed both created children were deleted. No settings changed or fixture projects created. Independent full suite PASS (110 files / 948 tests), plus a separate persistence-failure boundary PASS; details are in the verification report.
- Onboarding: bug fix to existing Auto behavior, no new UI, setting, entry point, tour, tip or What's new item.
- Evidence: [summary fallback](verification/summary-fallback-2026-10-22.md). Uncommitted; no commit/push requested. Adjacent digest, outside-session insights and memory review fallback is recorded as a follow-up idea.

## Agent idea management (card "扩展idea工具") — 2026-10-22

Spec: [IDEAS-SPEC §3.1](IDEAS-SPEC.md). User request: agents manage their card's ideas themselves (dismiss, edit, delete), e.g. close an idea the user rejected.

- [x] `flowly_update_idea` (edit fields of an open idea and/or `status: "dismissed"`) and `flowly_remove_idea`; receipt actions `idea_update` / `idea_remove`; agent events `idea_edited` / `idea_dismissed` / `idea_removed`. Card-scoped, accepted is final, only the user restores, duplicate-title check on rename, Ideas off → `IDEAS_DISABLED`.
- [x] CLI `idea-update` / `idea-remove`, HTTP `/api` actions, skill text (`server/skill-source.ts`, `skills/flowly/SKILL.md`).
- [x] Tests: `server/agent-service.test.ts` (edit, dismiss, replay, refusals, remove), `server/tool-server.test.ts` (MCP list/call, CLI).
- [x] Onboarding not changed: agent-facing tools only, no new UI, setting or user action.
- [x] Continuation verification: installed MCP propose → multi-field edit → dismiss → remove; exact dismiss/remove replay, `REQUEST_REUSED` and `IDEA_CLOSED` refusals, Activity and unchanged card status/revision. Temporary idea removed. [Evidence](verification/idea-tools-2026-10-22.md).
- [x] Independent `codex/gpt-6-luna`, explicitly full-access at creation (`d34eee81-94d1-4d32-a918-bd07392ee19b`): `npm run typecheck`; `npm test` (110 files / 936 tests passed), on `fab80456ead8` + dirty changes. [Luna report](verification/idea-tools-2026-10-22-luna.md). First live CLI attempt had no session context; the parent then used the existing `tools.prepare-existing` RPC to bind that session for the remaining checks.
- [x] Luna live CLI supplement: propose → multi-field edit → dismiss → refused dismissed edit → remove, exact replay / `REQUEST_REUSED`, and unchanged status/revision all passed. Temporary ideas/snapshots and the owned test session were removed; fresh native lookup and card session list confirm cleanup. Visual desktop/compact checks unrun (no client change); no commit/push requested.
- [x] Astra review (user-requested replacement after Fable quota/balance failures) found P2 proposal replay losing `ideaId` after removal and P3 Activity localization omissions. Both fixed: persist optional receipt `ideaId` with legacy fallback; map `idea_edited` / `idea_removed` through `msg()` and all nine catalogs. Pre-fix regression failed as expected; post-fix focused 97 PASS, independent Luna typecheck/full suite 110 files / 938 PASS and 18 runtime translations PASS. Reloaded plugin's real MCP propose → remove → replay returns the original ID/receipt without resurrecting the idea or changing task state/revision. Test idea/session cleaned up. [Original review](verification/idea-tools-2026-10-22-astra.md), [fix evidence](verification/idea-tools-2026-10-22-fixes.md). Desktop/compact rendering unrun; no new tour/tip/What's new (bug fixes only).

## Constraint benchmark — design checkpoint, 2026-10-22

- [x] [CONSTRAINT-BENCHMARK-SPEC](CONSTRAINT-BENCHMARK-SPEC.md), draft revision 2: after [Fable review and primary-agent verification](verification/constraint-benchmark-design-2026-10-22/fable-review.md), current scope is an independent grader + B01 quick (three file/verification/PR turns, Sonnet and GPT). B02–B04, compare and automatic resume are deferred.
- [x] Separate proactive and final verdicts; define expected refusal, equivalent-input SHA staleness, state-based turn prerequisites and exit-code precedence. Preserve test-stage requirements and all known failures; earlier scoring failures do not automatically suppress T3.
- [x] Define server receipt/artifact facts, nextMoves offered=0 versus omission and uncertain call correlation, actual execution evidence, shared Git common-dir ownership, cleanup permission preflight and independent cleanup retry. Audit v2 alone cannot score all six obligations.
- [x] Historical design checkpoint: implementation and model runs had not started at this revision. Fable r2 rereview and the later implementation/live results are recorded below and in the linked verification reports; this checkpoint alone is not execution evidence. No product UI/onboarding change.


## Turn checklist and audit calibration — 2026-10-22

Spec first: [TURN-CHECKLIST-SPEC](TURN-CHECKLIST-SPEC.md). User authorized the minimal combined recommendations 1+3 after calibrating the audit; no hooks.

- [x] Shared six-action checklist in `shared/turn-checklist.ts`, rendered at the start of the generated skill and returned by live `get_task` / CLI current; additive optional schema for old-server compatibility, no new write gate.
- [x] Both audit entrypoints share turn-time filtering, full-URL matching against successful receipt artifact IDs, failure/unknown evidence and explicit real/test/unclassified + old/new groups. Codex source is inspected with TypeScript AST, never executed.
- [x] Focused checklist checks: 3 files / 57 tests; audit fixtures finally 25 tests. Luna found 4 boundaries, fixed and rechecked; user-designated Fable `058cab0b` found 5 issues plus dynamic-command R1, all fixed and independently rechecked PASS.
- [x] Typecheck, full suite (110 files / 933 tests after Fable fixes), reload and live old-session CLI read (six rules exactly match source, runtime skill matches generated file, board hash unchanged). Final R1 only changed offline audit, checked with 25 Node regressions. [Report](verification/turn-checklist-2026-10-22.md).
- [x] Onboarding not changed: no new UI, setting or user action; these are agent instruction/API and offline audit changes.


## What's new after an update (card "插件更新后弹出“新功能”提示") — 2026-10-22

Spec: [WHATS-NEW-SPEC](WHATS-NEW-SPEC.md) (design confirmed by the user: reopen from Settings; 2026-10-24 the window opens on the newest release and pages back to 1.5.0).

- [x] `onboarding.whatsNewSeen` host setting; `client/whats-new.ts` (entry + `whatsNewDecision` / `seenAfter`), `client/whats-new-window.tsx`, board wiring (blocks tips; buttons open Settings → AI features or the tour 450 ms after closing), Settings → General → What's new; first-run tour close also stores the release as seen.
- [x] 6 new strings in all 9 catalogs.
- [x] `npm run typecheck`, `npm test` (`client/whats-new.test.ts`: only once, no items, new user, waits, version order).
- [x] Real UI after reload (2026-10-22): opened once by itself, reopen from Settings, Open settings → AI features.
- [x] 2026-10-24 (W4): releases list newest first back to 1.5.0; the window opens on the newest and pages to older ones; 1.6.0 (7 items) and 1.5.0 (5 items) entries, 9 more strings in all catalogs; typecheck, `npm test` 1034 PASS, reload + headless paging and Take the tour PASS. Release notes draft: [v1.6.0](release-notes/v1.6.0.md).
- [ ] Narrow/phone layout and the real first-run path: not run.

## Welcome tour redesign: explain and set the basics (card "重设计onboarding流程") — 2026-10-22

Spec: [ONBOARDING-SETUP-SPEC](ONBOARDING-SETUP-SPEC.md) (design confirmed by the user before implementation). The tour now also sets the interface and AI output language, the progress model, outside-session progress / next steps / ideas, and Project memory / Insights.

- [x] Five pages: How Flowly works (+ interface language), Built in (Always on; progress model; *Also in sessions outside Flowly* ×3; cost note), Project memory and Insights (drawn sketches, switches and sub-switches), Ready (+ More features).
- [x] First run: the outside-session switches are a draft stored only when the tour closes (any way), all on by default; installed users who never finished it keep their stored values (off). Manual opens show and store the real values.
- [x] New host setting `features` (`memory`, `insights`): memory off everywhere (`memoryOn`), Insights hidden with no digest or Workflow insights; Settings → AI features gained both groups. Existing switches kept (user decision).
- [x] Settings-button callout `settings-entry` after the tour closes.
- [x] Old users are not shown the tour (unchanged); "What's new after an update" proposed as an idea instead.
- [x] `npm run typecheck`, `npm test`; desktop light/dark screenshots in `docs/verification/onboarding-setup-2026-10-22/`.
- [ ] UNRUN: first-run path on a real empty board (needs a fixture host), phone, Luna session.
- [x] Onboarding: this is the tour; new tip `settings-entry`; README (both) quick start; ONBOARDING-SPEC §2/§5.


## Registry listing art (card "发布v1.5.0") — 2026-10-21

- [x] Researched the Paseo registry (getpaseo/plugins README, PROTOCOL, REVIEW, publishing guide): icon and screenshots come from `icon`/`media` in `paseo-plugin.json` (package-relative PNG icon; PNG/JPG/WebP/GIF/MP4/WebM media; first image is the thumbnail; SVG rejected), or from `listing.*` overrides a reviewer adds. The two screenshots in the previous listing were reviewer-added overrides.
- [x] `assets/icon.png` (light 512 app icon) and six screenshots (board, Needs you, summary, ideas, insights, next moves, resized from `docs/promo/screenshots`) declared in the manifest and added to `files`; `ci:package` fails when a declared asset is not in the tarball.
- [ ] UNRUN: the Insights screenshot predates Workflow insights and the welcome tour pages; retake with `docs/promo/shots.mjs` for a later release. Onboarding: no tour or tip change (packaging only).
## Project memory (card "项目记忆：可审阅的跨卡共享记忆 + 完成卡复盘") — 2026-10-22

Spec: [PROJECT-MEMORY-SPEC](PROJECT-MEMORY-SPEC.md). Every card started from zero; what was decided on one card only reached the next one if someone wrote it into AGENTS.md or a spec.

- [x] Spec written and confirmed first (boundaries with AGENTS.md §2, what to store §2.1, dry run on the Flowly board §2.4, file storage vs mem0 §3.4, when to summarize §4.0, lifecycle §6.5).
- [x] `memory.json` store (serialized writes, backup, atomic replacement, invalid data preserved), per-entry revision with `MEMORY_CONFLICT`, limits and Make room, backups on delete, cascades on card delete and project Remove (`server/memory.ts`, `shared/memory.ts`).
- [x] Agent tools `flowly_remember` (candidate; receipt + `memory_proposed` event, idempotent by event) and `flowly_recall` (read-only); `flowly_get_task` `memory`; CLI `remember` / `recall`; skill rule.
- [x] First instructions carry the project memory block (`sessionContext`, all entries while they fit 8 / 2400 characters, else pinned + relevant); injected entries count as used by the card.
- [x] Clues: the user's own messages of each managed turn (answer / feedback / message), filtered (short, picked suggestion, secret). Native question-tool answers (Claude `AskUserQuestion`, Codex `request_user_input` and the async variant's `Answers to your questions:` follow-up) become `answer` clues, one per question; formats checked on real timelines and Paseo's source on 2026-10-22 (spec §4.0). Live: a Claude session's AskUserQuestion answered like the drawer left two `answer` clues with `ask` ([report](verification/project-memory.md), last section).
- [x] Finished-card review on entering Done (default on, Summary model, project background workspace (BACKGROUND-WORKSPACE-SPEC, 2026-10-23), labels `flowly=summarizer`, `flowly-memory=retro`, hard-deleted in `finally` via `server/summarizer-remove.ts`, archive fallback); manual **Find memories**; skip without new material.
- [x] Review tightened after user feedback (too many card-specific candidates; 1 of 7 kept): at most one candidate per card, a required `reuse` (a later card on a different feature) or it is dropped, waiting and dismissed suggestions passed as counter-examples; the same generality rule added for `flowly_remember`.
- [x] UI: Memory page (`M`, overview chip, project tab menu), candidate review with edit/confirm/dismiss, edit/pin/archive/delete/restore, Copy as AGENTS.md rule, Clean up / Archive all stale, Make room; drawer Memory section; project switch *Project memory*; Settings → AI features *Find memories in finished cards*; nine catalogs.
- [x] Onboarding: tour line *Project memory* (More features), tip `first-memory-candidate`, README highlights in both languages, ONBOARDING-SPEC tip table.
- [x] `shared/memory.test.ts` (16), `server/memory.test.ts` (13, incl. card A's confirmed decision in card B's first instructions), tool list, settings defaults, tip order.
- [x] Luna 6 end-to-end on Tinylink, session `014fabc7` ([report](verification/project-memory.md)): card A's confirmed decision in card B's first instructions, `flowly_get_task` and `flowly_recall`; UI edit and delete reach new session contexts; MEMORY_SECRET / MEMORY_DUPLICATE; automatic and manual review with archived review sessions (before the switch to hard delete); counts; cleanup verified. UNRUN: a screenshot of the drawer's Memory section (below the captured viewport); phones.


## AI output language (card "AI output language setting for all AI features") — 2026-10-21

Spec: [AI-LANGUAGE-SPEC](AI-LANGUAGE-SPEC.md). A Workflow insights Run now wrote all suggestions in German because each prompt guessed the language from its material; one setting now decides and every prompt states it.

- [x] Spec written first (setting, resolution chain, auto-mode decision, prompt line, `outputLanguage`).
- [x] Settings `ai-language` (`aiLanguage`: `interface` | language code) and `device-language` (reported by the client while the interface language is `auto`); `resolveAiLanguage` in `shared/ai-language.ts`.
- [x] Settings → AI features → Output language; nine catalogs.
- [x] Summary, digest, session-insights and workflow prompts take a required `language` and carry `outputLanguageRule`; old wording removed; services get `language()` from `index.server.ts`.
- [x] `flowly_get_task` returns `outputLanguage`; tool descriptions, `server/skill-source.ts` and `skills/flowly/SKILL.md` use it for next moves and ideas.
- [x] Onboarding: tip `ai-language` (fact `hasSummary`); README Languages sentence; no welcome-tour change (no change to the Project/Card/Session map or a headline capability).
- [x] `shared/ai-language.test.ts` (resolution, settings, one test per prompt builder), `server/agent-service.test.ts` (outputLanguage), `client/onboarding-logic.test.ts` (tip).
- [x] Live: Workflow insights Run now on Flowly in English and in Simplified Chinese, both as configured; device-language report seen from the real window ([verification/ai-language.md](verification/ai-language.md)). Settings page screenshot not taken.

## Card setup reminders and soft gate (card "Flowly 流程约束强化") — 2026-10-21

Spec: [CARD-SETUP-SPEC](CARD-SETUP-SPEC.md). Analysis of the board showed the misses concentrated on title-only cards run by Sonnet 5.5 at medium/auto thinking; the causes were the skill's late, vague wording, silent gaps, feedback only at wrap-up, and a workpad gate that only fired when a workpad existed.

- [x] `flowly_get_task` returns `setup` (`typeMissing`, `tagsMissing`, `workpadMissing`, `stage`, `missing`) right after `identity` (`shared/card-setup.ts`).
- [x] The first task context names missing setup (`Card setup missing: …`), for sessions that never call a Flowly tool.
- [x] Every agent write carries one setup reminder while something is missing, after the delivery reminders; also on replays, never on finished cards.
- [x] Delivery to In review with missing type, tags or workpad (project workpad on) returns `SETUP_INCOMPLETE`; `acknowledgeOpen` delivers and the event records `setup.missing`. With open workpad items too, one `WORKPAD_OPEN` names both. Supersedes WORKPAD-SPEC §5.3 "no workpad delivers" (user decision 2026-10-21).
- [x] Skill starts with "Start of every turn"; tool descriptions name the timing and `SETUP_INCOMPLETE`; CLI usage updated.
- [x] Onboarding: welcome-tour Workpad line and README highlights revised in all catalogs; no new tip (agent behavior, no new screen moment).
- [x] `npm run typecheck`, `npm test` (106 files, 804 tests on the committed tree).
- [x] Luna 6 (`2574a944`, full access) on Tinylink, two title-only cards: Sonnet 5.5 medium (`13a87fc6`) and Luna (`b8070701`) both saw the first-context line, followed the reminders and set type, tags and workpad before their first file change. [Report](verification/card-setup-2026-10-21.md). Fixtures cleaned up and verified.
- [ ] UNRUN live: a `SETUP_INCOMPLETE` refusal from a real session (no subject delivered with setup missing; unit tests only). UI and phone not checked (no UI change).
- Observed: Sonnet went Todo → In review without a Development stage (setup itself was done first).

## Flowly logo and brand assets (card "plugin logo设计") — 2026-10-21

- [x] Design, with the user choosing at each step: line-art drafts (`docs/brand/logo-drafts/v1-filled`, `v2-line`), direction H "status path", refined from the original (`v4-h-refined`, R1; an obvious f shape `v3-h-as-f` was rejected), check one step lighter (`v10-check`, K2: 3 units, 12% larger); wordmark "Flowly" in Inter Medium (SIL OFL 1.1) outlined to paths with l and y cut at 52° and a dot in the o (`v5-wordmark`, `v6-wordmark-details`, `v8-y-slant`, `v9-y-angle`); monochrome only, ink `#1E2120` on light and paper `#F3F1EC` on dark (`v7-colors`).
- [x] Assets in `docs/brand/logo/` (mark, small mark, wordmark, lockup, app icons, 26 PNGs, favicon, overview, usage notes), all from `docs/brand/export-logo.mjs`; wordmark outline in `docs/brand/wordmark.json` from `docs/brand/outline-wordmark.py`.
- [x] README.md and README.zh-CN.md open with the lockup in a `<picture>` that follows the reader's light/dark scheme. The welcome tour title shows the small mark (`FlowlyMark`, theme PNGs at 1x/2x/3x generated into `client/flowly-mark-data.ts`, about 3 KB, picked by pixel ratio so they are not resampled). ONBOARDING-SPEC §2 updated; no tip (a visual change, no new capability). Paseo's sidebar icon stays the Lucide `PanelsTopLeft` (the host accepts only Lucide names).
- [x] PASS: `npm run typecheck`; `npm test`; `xmllint` on every SVG; README `<picture>` picks the light/dark lockup in Chromium (`colorScheme` light/dark); the title PNGs keep their colour (`#1E2120` / `#F3F1EC`).
- [x] PASS (7c440b7, dirty): after `npm run typecheck` and `paseo plugin reload flowly`, the welcome tour in the Paseo web client (headless Chromium, light and dark) shows the mark at 20×20 px, 8 px before the 14 px title and centred on it, #1E2120 on the light surface and #F3F1EC on the dark one; no page errors (`docs/verification/flowly-logo-welcome-tour.md`).
- [ ] UNRUN: the desktop app window and the phone apps (no desktop-control tool in the session).
- [x] Small mark redrawn after the user found it blurred into a clump with uneven lines: a 20 grid at stroke 1.5, only the two ends (a solid start dot drawn 13% smaller so it looks as large as the open end ring) joined by one S curve; rounds in `docs/brand/logo-drafts/v11-small/` and `v12-two-ends/` (T5 chosen), compared at true pixel sizes by `docs/brand/render-small.mjs`. Used for the 16–48 px app icons, the favicon and the welcome tour title.

## Session pane: history, keyboard, scroll performance (card "sidebar session 优化") — 2026-10-20

- [x] Design and feasibility: [SESSION-PANE-SPEC](SESSION-PANE-SPEC.md). Read-only SDK spike on the local daemon: `before`/`after` cursors page cleanly (tail 15 + before 15 = tail 30), whole turns of 1000 entries are ~69 KB slim.
- [x] Decisions (user): open on the current turn (≤ 300), Load earlier row, FlatList directly (phones: inverted, as Paseo's own view; web: plain scroll view).
- [x] Implemented: `sessions.tail` modes turn/before/after; `client/session-timeline.ts` (incremental refresh, Load earlier ≤ 1000); `client/session-transcript.tsx` (own component, inverted virtualized list on phones, lifted with the composer by the keyboard's native-driver value); follower never scrolls during a drag; display cap removed; tip `session-history`; strings in all catalogs.
- [x] PASS: `npm run typecheck`; `npm test`; new tests for daemon paging (turn stop at user message, cap, before/after, stale cursor), window merges, follower (normal and inverted), tip order.
- [x] PASS (Luna 6 `0870a92e`, web desktop 1700×1000 + compact 430×900): current turn on open, Load earlier keeps position (Δ < 1 px), follow tail / Latest, no console or plugin errors. [Report](verification/session-pane-history.md). The tip did not show because it was already recorded as seen.
- [x] Fixed: `tipsSeen` was capped at 20 with 20 tips, so the next tip would have pushed out `first-card`; cap now 100 (`TIPS_SEEN_MAX`).
- [x] Images in first messages (user request 2026-10-21): New task's agent instruction and New session take images on web (paste, drop, Add images). Phones: declined by the user (no plugin picker; host internals not used). Spec §6.
- [ ] UNRUN: phone verification (iPhone + Android: keyboard lift with reader at end and scrolled up, Load earlier position, scroll FPS before/after with RN perf monitor); AndroMeld Android Use was off.

## Native session pane: faster Next moves card, one card style — 2026-10-21

- [x] Requests: (1) on phones the Progress card is quick but the Next moves card is slow; (2) the two timeline cards look different. Spec: NATIVE-SESSION-SPEC §8.1, §5.3, §6.3; SESSION-CHIP-SPEC 2026-10-21 amendment.
- [x] Cause measured on this host (1251 agents, 386 summarizer leftovers): a chip refresh round listed all live agents (233 KB), then every agent including archived (3.1 MB) after any board change, before it computed the Next moves state; rounds ran every 5 s; the daemon wrote the card behind the model lookup (up to 2 s) and a board write. Luna's partial baseline (round 5, CPU rate 4 and 1, raw data in `docs/verification/fixtures/native-session/perf/`, not committed or reported): Progress card visible 13-64 ms after its row, Next moves card 0.4-5.9 s after its row.
- [x] Fix (commit "Next moves card no longer waits for the archived scan"): state first, archived scan after and not on board changes; live sessions from the agent stream; pushed status / user-message / permission changes trigger a round within ~150 ms; a row that arrives first asks for a round; managed card written first in the hook; unchanged chip state wakes no subscriber; timing log entries `chips.round`, `chips.archived`. Unit tests: `client/live-agents.test.ts`, `client/session-chips.test.ts`.
- [x] Style: first tried one frame and header for both cards (commit "Progress and Next steps cards share one frame and header": title and Open card inside the card). The user preferred the original Progress layout (2026-10-21), so it was restored and Next steps aligned to it (commit "Progress card back to its original layout; Next steps aligned to it"): small heading above on both, Open card back in the Progress footer, Next steps' hide button at the right end of its heading; then the user also dropped Next steps' grey card, so its chips sit directly under the heading (`client/native-card.tsx`; `ContentCard` unchanged apart from exporting its frame style). Known and accepted by the user: on a phone the Progress footer is crowded (the timestamp can wrap, the button can be cut to "Open ca…"), as before. Screenshots: `docs/verification/native-session/style/`.
- [x] PASS: `npm run typecheck`; `npm test` 786 passed / 65 skipped (branch), 821 passed on the combined main tree; plugin reloaded, headless load has no page errors; Progress card checked on desktop and a 430 px phone layout.
- [ ] UNRUN (user cancelled the Luna measurement, 2026-10-21: "if there is a performance problem I will come back"): the after-fix Next moves latency, live on a phone or CPU-throttled; the Next moves card with the new style was not screenshotted (no ready card existed at deploy time).

- [x] Request (2026-10-21): after a new turn starts, the previous turn's Next steps disappeared but its space stayed. Measured on the live host: the empty row keeps the host's stream-item wrapper (`marginBottom` 16 px = `SPACING[4]`, `getGapBetweenStreamItems`); a plugin row cannot be removed, a renderer cannot change its wrapper, and a negative child margin is clamped (checked in Chromium). User decision: keep the previous suggestions visible but not pressable. The row is rewritten as `{status:"past", eventId, moves}` (chips disabled, none emphasized, no ×); the user's × still hides a set for good; rows written `dismissed` before this stay empty until the daemon restarts. Cost to know: every earlier turn now leaves its chips in the history. Spec §6.1–6.2; tests in `server/next-move-rows.test.ts`, `server/session-insights.test.ts`, `shared/native-session.test.ts`, `client/session-chips.test.ts`. Onboarding: no tour or tip change (a refinement of an existing card).

## Native session pane P2–P4: sessions outside Flowly — 2026-10-21

- [x] Request: give every session Flowly does not manage the same Progress / Next moves / Ideas without joining a project; ideas may continue in the session, a new session or a new workspace. User decisions: Paseo child sessions (like card summaries), off by default, three switches. [Spec §12](NATIVE-SESSION-SPEC.md).
- [x] Daemon: `server/session-insights.ts` (store `session-insights.json`, capped; one child insight session per completed turn, merged while one runs; progress / moves / ideas from one JSON answer; rows appended in the background; suggestion ends at the next turn; idea actions here / session / workspace), `shared/session-insights.ts` (schemas, prompt, lenient parser), `NextMoveRows.writeSession`, hooks for unmanaged sessions, RPCs `sessions.insights` (etag), `sessions.idea-run`, `sessions.idea-dismiss`.
- [x] Client: chip refresh reads insights only when switched on; `sessionChipMoves`; card-less Next moves card and Progress row (no Open card); `OutsideIdeasPopover`; settings switches. Flowly's own screens unchanged apart from the settings.
- [x] PASS: `npm run typecheck`; `npm test` 102 files / 765 passed, 65 skipped (rebased on main).
- [x] Luna 6 round 4 (session `e63b5616-a0db-47cd-9b11-4c3691dcde10`; fixtures: a plain session in a temporary Tinylink card's workspace and one in a temporary git repo outside any Flowly project, all cleaned up; settings restored): 10 PASS, 0 FAIL. Off does nothing; on gives both sessions a Progress row without Open card and a Next moves card under the reply (rows verified by SDK); Ideas chip "Ideas · 2" with Continue here and New session working; Progress and Next steps switches each gate their part; the next turn dismisses the card in place; a managed session keeps its card path (Open card, no outside run); Flowly's own screens unchanged. [Evidence](verification/native-session.md#round-4).
- [ ] UNRUN (no idea was generated for the repo session): Ideas Dismiss, New workspace, the non-Git error, and the Ideas switch suppressing an open idea live. Covered by unit tests (`server/session-insights.test.ts`, `client/session-chips.test.ts`) only.

## Native session pane: Summary, Next moves, Ideas (P1) — 2026-10-20

- [x] Card request "summary、next move、ideas上原生session": the same features in Paseo's own session view for Flowly-managed sessions; user decisions: Summary through the native timeline, P1 only, timeline rows best effort; later (after the prompt-suggestions reference) Next moves as a timeline card instead of a chip, tapping fills Paseo's message box by default (setting: or copy), Ideas stays a chip. [Spec](NATIVE-SESSION-SPEC.md), [plan](superpowers/plans/2026-10-20-native-session.md).
- [x] Risk probe (temporary `flowly-probe` plugin, Claude Haiku + Codex Luna sessions in Tinylink, all cleaned up): appended rows never reach the agent, raise no attention, are visible to the plugin's SDK refetch, are accepted by both providers, and are lost on session reload. Spec §5.5.
- [x] Daemon: a new summary version appends a `flowly-summary` row to the session whose turn produced it; skipped after a newer turn of that session or for an archived session; failures only logged (`server/summaries.ts`, `shared/native-session.ts`).
- [x] Client: `SummaryRow` for Paseo's timeline renderer (`client/summary-row.tsx`; per the user, not shown in Flowly's own session view, which has the sidebar's Progress); Next moves card (`server/next-move-rows.ts` writes `flowly-next-moves` rows at turn end and dismisses them at the next turn start; `client/next-move-card.tsx` renders it while `chipMoves` says the set is current; `client/web-composer.ts` fills the session's message box on web/desktop under the new AGENTS.md exception, else copies; setting `native-session.nextMoveTap`); Ideas pill on managed sessions in the existing chip refresh (`client/session-link.ts`, `client/native-chips.ts`); Ideas popover and revalidating actions (`client/native-popovers.tsx`, `client/native-actions.ts`); hidden suggestion sets for the card (`client/hidden-moves.ts`); board opens the prefilled new-card form from an idea link (`parseIdeaLink`); RPC `sessions.native-chips`.
- [x] Scope (user, 2026-10-20): the feature must not change Flowly's own behavior or look. No Flowly tip, tour unchanged, Flowly's suggestion-row × stays local (not shared with the card's ×), no Progress card in Flowly's session view, summary queue never waits on the row append. New in Flowly only: the `ideaId` board link opened by the native Ideas chip, and the user-requested setting on Settings → AI features. README; strings in all 9 catalogs used only by the native card/chip/popover and that setting.
- [x] Fixes from live use: the timeline kind/id must match Paseo's `^[a-z][a-z0-9-]*$` (a dot broke the whole client plugin; host-id test added); after Move to Done the wrap-up question outlives the suggestion set and reads Auto wrap up fresh; Ideas actions refresh the chips at once; rows in Paseo's view get a shared Reduce Motion provider, so Show more / Show less animate (headless: 193→377 px over ~210 ms, back over ~175 ms).
- [x] PASS on the combined main tree (this commit + other uncommitted work): `npm run typecheck`; `npm test` 103 files / 793 passed, 65 skipped. Plugin reloaded from the main checkout; headless app load has no page errors.
- [x] Luna 6 full-access verification, session `e63b5616-a0db-47cd-9b11-4c3691dcde10`, Tinylink fixtures cleaned up ([evidence](verification/native-session.md)): round 1 (chip version, superseded) data 3 PASS, UI 10 PASS / 2 FAIL (chip refresh lag, fixed) / 3 UNRUN; round 2 (timeline card) 8 PASS / 1 FAIL (D7, fixed); round 3 (D7) 3 PASS. Covered: Progress row desktop + compact, Next moves card fill / copy / dismissed rewrite / × / no Next chip, Ideas chip immediate refresh, Move to Done with Not now / Wrap up / Auto wrap up, unmanaged sessions get nothing, Flowly's own board/drawer/session view unchanged.
- [ ] UNRUN: the iOS/Android apps (filling falls back to copying there; not checked on a device); "Open card" on the Progress row and the welcome-tour check from round 1 were not re-run.

## Connectors: Confluence, GitHub, GitLab (card "更多connector接入") — 2026-10-20

- [x] Request: bring in more external connectors (Confluence, GitHub, GitLab …), gather them under the Artifacts +, then wire up each one. [Spec](CONNECTORS-SPEC.md).
- [x] Decisions (2026-10-20, §11): generic names instead of the ticket ones (the design recommended keeping them; the user chose renaming after hearing the alias/migration cost): artifact `ticket` → `external` (board v5), `flowly_read_ticket` → `flowly_read_external` (old name kept as an alias), CLI `ticket` → `external`, RPC `tickets.*` → `connectors.*`; PR/MR give file names, not diffs; New task From Jira becomes one From <service> button per connected service; order Confluence → GitLab → GitHub.
- [x] Implemented: `shared/connectors.ts`; `server/connectors/` (read-only HTTP with per-service GET whitelists, Jira moved in unchanged, Confluence DC/Cloud pages with storage → Markdown, GitLab issues/MRs, GitHub issues/PRs incl. Enterprise, project repositories from git remotes, `ConnectorService`); v4 → v5 migration with `board.pre-v5.json`; `tickets/` → `connectors/` data move at start; unified + menu in the drawer, Settings → Connections with four groups, picker/preview/chip generalized, card-face key and icon; tip `connectors`, tour row, README; 9 catalogs +68 / −32.
- [x] PASS: `npm run typecheck`; `npm test` 101 files / 780 passed, 65 skipped (with other cards' new tests) (new connector adapter tests with mock fetch, store migration, card-display old id, tip rule).
- [x] Independent code review: fixed token reuse on an edited address, https-only (loopback excepted), redirects reported as moved, body timeout, moved Jira keys, Confluence comments and unread, bare keys falling back to file paths, picker passing its connection, per-service picked keys (CONNECTORS-SPEC §12.1); regression tests added.
- [x] PASS (live): `paseo plugin reload flowly` migrated the real data (one Jira connection, one ticket input; board v5, `board.pre-v5.json`, `connectors/`); on this card a bare `SHOPSR-69689` was recognized against jira.shopee.io, `get_task` returned `external` plus the deprecated `ticket`, `flowly_read_external` returned the ticket Markdown; the temporary input was removed.
- [x] PASS (real services, tokens from the user's `~/.env` entered through the Settings page): GitLab git.garena.com and Confluence confluence.shopee.io connected, links recognized (nested groups, `/diffs` subpage, viewpage), `flowly_read_external` read an MR, an issue and a page, + menu and pickers (recent and text search) work. Found and fixed: GitLab 14.10 has no `/diffs`, so MR changed files now fall back to `/changes` (names only). Temporary inputs removed; connections kept.
- [x] User feedback (2026-10-20): GitHub search now needs `is:issue` or `is:pull-request` (HTTP 422 from New task → From GitHub) → every search runs both kinds and merges them; Confluence recent list now shows pages I viewed (DC recently-viewed endpoint, Cloud CQL `recentlyViewedContent`) and edited, newest activity first. PASS live on github.com (@JasprW) and confluence.shopee.io; `npm test` 795 passed / 65 skipped.
- [x] Luna 6 full-access UI acceptance against local mock GitLab / GitHub Enterprise / Confluence servers (session `d4e02830-acc3-4634-b8d1-74ceb1d869c4`, card session `01a158d9…`): cases 1–7, 10, 11 PASS (Settings groups, single + menu, picker/preview per service, PR via /issues/ link, card-face key, From buttons, agent read and unread, compact layout, no tokens in logs). Case 9 FAIL: removing a connection left its summaries in `cache.json` → fixed (persist on remove, drop entries of missing connections on load, regression test; live cache cleaned after reload). Jira `ticket` compatibility field: UNRUN there (no real tickets on test cards), PASS here on this card after the reload. [Evidence](verification/connectors.md).
- [x] PASS: Luna re-check on the reloaded plugin (A cache cleanup on remove and restore, B same key across GitHub/GitLab not shown as linked, C changed address without a token refused and no request to the new port, D non-loopback http refused, E PR via /issues/ link). Cleanup verified: only the original Jira connection, 0 loopback cache entries, Tinylink back to its 6 cards, test sessions archived.
- [x] User request (2026-10-21): each connector shows its own brand logo (`client/brand-icons.tsx`, Simple Icons CC0 paths prerendered as 48px PNG data URIs for RN `Image`; Confluence #1868DB, GitHub light variant on dark themes) in Settings → Connections, the Artifacts + menu and rows, the card face key, New task From buttons, picker and preview titles. PASS: typecheck, `npm test`, headless screenshots in light and dark; onboarding unchanged (visual only).

## Next moves in the delivery call — 2026-10-20

- [x] Card request: let the calls an agent already makes at the end of a turn carry the next moves, so suggesting them is part of delivering and not a second call that gets dropped. [Spec](NEXT-MOVES-SPEC.md) §8 (reconciled with the concurrent delivery-reminders design §9, which lands on its own card).
- [x] Implemented: `flowly_update_status` and `flowly_report_progress` (all kinds) take an optional `nextMoves` with the `flowly_suggest_next_moves` items; absent records nothing, `[]` records an explicit none (`next_moves_suggested`, `moves: []`, note "No next steps needed"), 1–3 record the suggestion. One transaction writes the status/report event, then the suggestion; one receipt; a refused call (WORKPAD_OPEN, REVISION_CONFLICT, guard) writes nothing; replay does not add a second suggestion. The standalone tool now accepts `[]` too. A `moveTo:"done"` move is only accepted on a call that leaves the card in In review (INVALID_INPUT otherwise; the standalone tool is unchanged). CLI `status` / `note` take `--moves '<JSON>'` or `--no-moves`. Activity shows only the explicit none, as "<agent> suggested no next moves". Tool descriptions and both skill copies say to pass `nextMoves` when delivering, asking or reporting, and keep `flowly_suggest_next_moves` for mid-turn updates. README (both), 1 string in all 9 catalogs. No tour entry or tip: the only visible change is one Activity line.
- [x] PASS: `npm run typecheck`; full `npm test` 93 files / 705 passed, 65 skipped, three runs in a row. New tests: agent-service (delivery with moves in order, every report kind, `[]` replaces and absent keeps, invalid moves write nothing, Done guard incl. finished cards, replay/reuse, WORKPAD_OPEN refusal then resend), next-moves (`isNoMoves`, empty after non-empty), progress-rules (a report with its suggestion still counts as work), tool-server (schemas allow `[]`, descriptions and skill text, CLI `--moves`/`--no-moves` and bad flag combinations, MCP calls). The CLI flow test got a 30 s timeout: it runs a long sequence of real CLI processes and passed 3.2 s alone but timed out at 5 s in one parallel full run after this card added calls to it.
- [x] Checked: Agent habits (`shared/agent-habits.ts`, `shared/insights.ts`) already reads `moves: []` as an explicit none, so the new events count there without a change.
- [x] PASS (live, desktop): after `paseo plugin reload flowly`, two `codex/gpt-6-luna` full-access sessions on a temporary card in the Tinylink fixture (one with the MCP server, one CLI only). `update_status in_review` with `nextMoves` wrote the status change and the suggestion in the same millisecond and showed the chips (3 over MCP, 2 over the CLI); `report_progress` with `[]` and `note --no-moves` wrote `moves: []`, removed the chips and added the "suggested no next moves" Activity row (2 rows); the Done guard refused `moveTo: done` on a non-delivery call with `INVALID_INPUT` and wrote nothing. The card, its 2 sessions and its workspace were deleted and archived afterwards; Tinylink's own cards, workspaces and sessions are unchanged. Evidence: [verification/next-moves-delivery.md](verification/next-moves-delivery.md).
- [ ] UNRUN: the chip row and the Activity row on a phone / compact layout; the standalone `flowly_suggest_next_moves` with `[]` live (unit tests only); coverage recompute after rollout (baseline 56 of 101 delivery, question and result turns, about 55%; target 90% or more).

## Card sidebar tweaks (card "UI/UX 调整") — 2026-10-19

- [x] Request: History alignment, Artifacts paging (+5 per press, no collapse, reset on reopen), Artifacts collapsible as a whole, user-ordered sidebar sections. [Spec](DRAWER-SPEC.md#section-order-and-artifacts-paging); CARD-ARTIFACTS-SPEC §5.2 and CARD-DISPLAY-SPEC §3 updated. No inputs or tickets on the card.
- [x] `client/disclosure.tsx`: shared `Collapse` (measured height, stays in layout until measured when mounted open) and `Chevron`; `Disclosure` gains `flush`. Progress → History uses it; an opened version's fields line up with its title.
- [x] `client/task-artifacts.tsx`: per-group limit (5, +5 per *Show N more*, aligned with rows), whole-section collapse through `SectionHeader` `open`/`onToggle`; both reset when the sidebar opens.
- [x] `shared/drawer-sections.ts` (+ test), `board-view.drawerOrder`, drawer renders the six movable sections in that order; Settings → Cards → Card sidebar (drag / arrows, reset).
- [x] Onboarding: tip `sidebar-order` (after `card-display`), ONBOARDING-SPEC table; tour unchanged (view preference, not a new concept). 8 strings in all 9 catalogs.
- [x] PASS on `7a4562d` + dirty: `npm run typecheck`; `npm test` 583 passed / 63 skipped; `paseo plugin reload flowly` running.
- [x] PASS (headless web, real card with 37 artifacts): paging, whole-section collapse, reset on reopen, History alignment, drag reorder + drawer order + reset. [Verification](verification/sidebar-tweaks.md).
- [x] Follow-up: Workpad collapses as a whole like Artifacts (title + chevron, resets on reopen); collapsed header shows `Acceptance n/m · Checks n/m` (existing strings, no new catalog entries).
- [x] Follow-up "整体调整 UI": every sidebar section is a shared `Section` (title + trailing chevron, actions, collapsed summary, empty sections without chevron); Details/Usage/Activity converted from `Disclosure`. Settings → Cards → Card sidebar: order plus a *Starts open* switch per section (`drawerOpen`), pinned bottom three, *Reset sidebar layout*. Workpad lists page by 5, checks sorted by what needs a look, commands one line. Phones: title/properties/tags scroll with the content. 7 strings added and 4 removed in all 9 catalogs; tip text updated.
- [x] PASS on `7a4562d` + dirty: typecheck; `npm test` 587 passed / 63 skipped; plugin reload. Headless web (desktop 1700×1100 and phone 430×900): before/after screenshots, defaults round trip (Workpad off/Activity on → drawer opens that way → toggle → Reset), paging/collapse regression. [Verification](verification/sidebar-tweaks.md).
- [x] Follow-up: default layout set to the user's current one: order Progress, Sessions, Workpad, Artifacts, Ideas, Links; Links (and the bottom three) start closed, Artifacts open.
- [x] Follow-up: Progress → History times are compact (today `21:57`, this year `Oct 19, 21:57`, older `Dec 31, 2025`) via `shared/compact-time.ts` (+ test).
- [x] Follow-up: main and sub sessions (user chose option 1, automatic): Paseo child agents nest under their main session behind a folded `↳ 2 working` row (open when one needs you); `sessionTree` in `shared/subagents.ts` (+ tests). No new strings, tip or tour change (reuses the Subagents chip text; the existing `subagents` tip already introduces child agents).
- [x] Follow-up: session rows keep the last-activity time ("just now") on one line at full width; long titles and model names truncate instead (`client/session-card.tsx`). PASS: typecheck, `npm test` 615 / 63 skipped, reload; headless web at 360 px phone and 1400 px desktop: every time label one line, not clipped.
- [x] Follow-up: subagent rows open and close with the shared `Collapse` (height + fade) and a rotating chevron. PASS: typecheck, `npm test` 615 / 63 skipped, reload; headless web on Tinylink with 2 temporary child agents: group height eases 93→193 px on open and 197→93 px on close; fixtures `c0749534`, `44013a5b` deleted.
- [x] Follow-up: one type scale across the sidebar (DRAWER-SPEC, Type scale): list body text 13 (was 12 in Workpad, Artifacts, Links, History), secondary lines 12 (was 11), group labels stay 11.
- [x] Follow-up: the session view's Subagents chip opens a subagent in the side bar when it is one of the card's sessions (drawer `onOpenSession`), else in a Paseo agent pane; row label `Open {title}` (stale `Open {title} in Paseo` removed from 9 catalogs).
- [x] Follow-up: list rows (`Row` in `client/ui.tsx`, e.g. the Needs attention list) keep their trailing value ("just now", counts) at full width; titles and details truncate instead. PASS: typecheck, `npm test` 615 / 63 skipped, reload; headless web Needs attention at 1400 px and 360 px: times one line, not clipped.
- [x] Follow-up: on phones the trailing "just now" still lost its last word (native Android measures a line narrower than it draws). `Label` single-line text uses `textBreakStrategy="simple"`, `relativeTime` joins its words with non-breaking spaces, and the Needs attention time is single-line. PASS: typecheck, `npm test`, reload, web check. UNRUN: native phone (AndroMeld not running).
- [x] Follow-up: Back from a session could leave the card details shifted ~18 pt on Android (native-driven transform outliving the animation, invisible to React). `MotionReveal`, `Enter` and the drawer container now carry animated opacity/transform only while moving (MOTION-SPEC, Rest state). PASS: typecheck, `npm test`, motion renderer test (new case), reload; headless web Back at 0–400 ms and rapid open/back: title at its rest x, no transform. UNRUN: Android device (AndroMeld not running).
- [x] Follow-up: Show more in Artifacts and Workpad opens the added rows with a height/fade reveal (`PagedRows`); the session view re-checks the tail at drag end and momentum end, so "Jump to latest" hides after a fling to the bottom on phones (the throttled last onScroll could stop short). PASS: typecheck, `npm test` (one flaky `tool-server` timing test passed on rerun), reload; headless web: Outputs 238→428 px and Acceptance 354→498 px animate over ~200 ms. UNRUN: phone check of the latest button (AndroMeld not running).
- [x] Follow-up: a stray coloured line under a session row while scrolling the board was a browser focus outline clipped by the rounded list. 23 `Pressable`s without `noFocusRing` fixed (the new subagent row also shows focus as its background); `client/focus-ring.test.ts` fails on any `Pressable` without it (probe-checked). Subagent chip and row always lead with the total (`2 subagents · 1 working`). PASS: typecheck, `npm test` 623 / 64 skipped, reload; headless web: focused rows after a sideways board scroll have `outline: none`.
- [x] Follow-up: a subagent's unread turn no longer counts toward attention (user decision; approvals, errors and manual unread still do). PASS: typecheck, `npm test` 624 / 64 skipped (new case), reload; live on Tinylink with a temporary finished child: card 0 unread / 0 need attention, not in Needs attention; fixture deleted.
- [ ] UNRUN: native apps, compact web, Luna 6 test session.


## Attention dismiss — 2026-10-19

- [x] Card request "attention dismiss": Attention counts kept showing items the user could not or did not want to decide yet. [Spec](ATTENTION-DISMISS-SPEC.md) approved by the user as written (per card, back on any new signal, no timed snooze).
- [x] `shared/attention-dismiss.ts`: schema, signal keys (`q:` question event, `p:` request, `e:` error, `u:` unread generation), `isDismissed`. `board.json` gains `attentionDismissals` (default `[]`, no migration); card delete and project remove drop it.
- [x] RPC `attention.dismiss` / `attention.restore` (`BoardStore.dismissAttention` / `restoreAttention`): serialized, idempotent, no task/project revision or Activity.
- [x] `client/attention.ts`: items carry `signals` and `dismissed`; `attentionFromSources` (bell, sidebar badge, overview chips, tabs, tips) excludes dismissed; `allAttentionFromSources` for the list.
- [x] UI: Dismiss button per Attention row, collapsed *Dismissed · N* section with Restore, card `Dismissed` signal, drawer notice + Restore and menu entry, board context menu and phone Actions sheet entries, toasts.
- [x] Onboarding: tip `attention-dismiss` (after `needs-you`), ONBOARDING-SPEC table, README (both). Tour unchanged: not a new concept. 14 strings in all 9 catalogs.
- [x] PASS: `npm run typecheck`; `npm test` 577 passed / 63 skipped (new `client/attention-dismiss.test.ts`, `server/attention-dismiss.test.ts`, tip order).
- [x] PASS (headless web, Tinylink): Restore → Dismiss round trip, counts/chip/badge, Dismissed section, card marker, drawer notice, compact sheet. [Verification](verification/attention-dismiss.md).
- [ ] UNRUN: live re-surface on a real new agent turn (unit tests only), native apps, Luna 6 test session.

## Flowly tool and skill naming — 2026-10-19

- [x] User request and [complete incremental spec](FLOWLY-NAMING-SPEC.md) before implementation. Input: this card and the user's rename instruction; no ticket inputs.
- [x] MCP server/config key `flowly`, all 11 `flowly_*` tools; bundled skill moved to `skills/flowly`, runtime skill matches, generated instructions and ticket-read hints updated.
- [x] CLI `flowly.mjs`, new `FLOWLY_*` session/config environment, helper labels and query prefixes. Preserve private legacy environment/CLI reads, helper recognition, non-destructive data/settings migration and existing provisioning idempotency keys.
- [x] README/overview and current tool references synchronized. No new tour row/tip: naming changes no concept, capability or user interaction.
- [x] PASS on `50965f996861` + dirty changes: focused 75/75 (8 files), `npm run typecheck`, full `npm test` 579 passed / 63 skipped (84 passed / 12 skipped files). Only `flowly` reloaded, no daemon restart.
- [x] PASS: independent `codex/gpt-6-luna` `bc10675f-1b10-49dd-8cba-6ebbf2f18fd0`, explicitly full-access at creation; real installed MCP read/progress write, environment/skill checks, 22/22 focused tests. Test session archived then deleted; native missing and fresh card session list confirmed. [Evidence](verification/flowly-naming.md).
- [x] Review/publish validation: constructed a rename-only index from HEAD, excluding unrelated Workflow insights/Attention dismiss code. Isolated typecheck PASS; full tests with `--maxWorkers=2`: 534 passed / 63 skipped; candidate diff check PASS. Working-tree byte hashes preserved. [Review evidence](verification/flowly-naming-review.md).
- UNRUN: desktop/compact visual checks, not required for this naming-only change; no UI actions taken. Existing unrelated work preserved; commit/push completion is recorded on the card.

## Workflow insights — 2026-10-19

- [x] Card request "paseo project settings互通". Researched the SDK first: plugin `PaseoApi` has no project-settings or setup API; the internal `DaemonClient` has `readProjectConfig`/`writeProjectConfig`, setup status/run and workspace scripts. The daemon already runs `worktree.setup` for worktree cards and teardown on archive.
- [x] Read-only probes over the Flowly card sessions; no raw commands were persisted, and the temporary scripts and session were deleted. Rules over 72 h found only verify-type suggestions that AGENTS.md already has. Over 7 days, `claude/claude-sonnet-5` found 6 suggestions, 5 of them outside paseo.json (i18n tool, Playwright dependency, board inspector, doc-sync and fixture-cleanup checklists). One run took 267 s and cost about $0.80, and `outputSchema` was not honored.
- [x] User decision: an opt-in feature with a switch, model choice and cadence (daily when tokens allow, longer otherwise). [Spec](WORKFLOW-INSIGHTS-SPEC.md) written.
- [x] User approved the spec with all §11 decisions kept. Implemented:
  - `shared/workflow-insights.ts`: settings, normalization, redaction, scheduling, material, prompt, parsing, validation.
  - `server/command-log.ts`, `server/workflow-insights.ts`: store, service, backfill, 15-min scheduler.
  - RPC `workflow-insights.*`; `Project.workflowInsights`; `tasks.create` `insightFindingId`; get_task `projectScripts`, plus the skill line in both copies.
  - Insights section, the settings group under AI features, the project switch, the task seed.
  - Card delete, project remove and restore paths.
- [x] Onboarding: tour row *Workflow insights*, tip `first-workflow-insight` (after `first-idea`), ONBOARDING-SPEC table, README (both). 56 strings in all 9 catalogs.
- [x] PASS: typecheck; `npm test` 567 passed / 63 skipped; plugin reloaded. Live Run now on Flowly with `claude/claude-sonnet-5`: 240 s, $0.63, 7 suggestions, 4 of them matching the probe; the Playwright one did not come back. Details in [verification/workflow-insights.md](verification/workflow-insights.md).
- [ ] UNRUN: real-window UI (desktop and compact), a scheduled run and an enable-time backfill in the live daemon, Codex shell items, Luna 6 test session.
- [x] 2026-10-21 review of two days of scheduled runs. 25 open suggestions, about half of them repeats of earlier ones (verify/check, board inspector and DaemonClient helper, each 3 times). Agent SMITH was never analyzed: 990 actions but only 2 cards, under the 3-card quiet rule. The monthly cost estimate used one project's run.
- [x] Fix on PR #8 (user request), spec §4.1, §4.3–§4.4, §5.1–§5.3, §2.3 and §11 updated:
  - The model sees existing suggestions with a short id. It marks a repeat with `updates`, which refreshes the existing suggestion (evidence, cards, `seen` + 1) instead of adding one. It lists duplicates among open suggestions in `merges`.
  - A daemon fallback treats a matching fingerprint, or a similar title (word and CJK-bigram Jaccard: ≥ 0.6 with the same target, ≥ 0.7 with any target), as a repeat.
  - Quiet rule: under 50 new actions, or under 2 cards unless there are at least 200 new actions.
  - The monthly estimate sums the latest run cost of each included project.
  - Insights shows "Seen in N runs".
  - The existing repeats are merged by the next model run. The data file is not edited directly.
- [x] PASS: typecheck; `npm test` 839 passed / 65 skipped (the PR branch tree). UNRUN: the merge on real data (the next scheduled run or Run now after the PR is installed), the UI line in a real window.
- [x] PR #8 merged (`e9dd8f1`), plugin reloaded. Run now on Flowly: $0.49, 2 added / 5 refreshed / 13 merged, open 22 → 11. The merges were all correct, but both new suggestions repeat open ones the model did not mark (title similarity 0.00 and 0.40, below the fallback). [Details](verification/workflow-insights.md).
- [x] Fix (user request): when existing suggestions are listed, a new finding must give `nearest` and `difference`. `nearest` alone refreshes it; a finding with neither is dropped. Spec §4.3, §4.4 and §5.3 updated; the two missed pairs are in the tests. UNRUN: a live run with the change.
- [x] PR #10 merged (`06acf6f`). Run now: $0.48, 1 added / 6 refreshed / 1 merged. The new one was a narrower version of an open suggestion.
- [x] User decision: no accumulation. Each run with valid suggestions replaces the project's open ones; accepted and dismissed ones stay, and dismissed ones still cool down for 30 days. The updates/merges/nearest/seen machinery was removed. Spec §5.3 rewritten.

## Card display: calmer layout and user-chosen fields — 2026-10-19

- [x] Card request "任务卡片布局调整": cards had too many kinds of information. [Spec](CARD-DISPLAY-SPEC.md).
- [x] Layout (`client/card.tsx`): meta row above the title (priority Urgent/High/Low, type, ticket key, first two tags as plain `#tag`), no pills or chips; one activity line by default (progress summary, else latest output, now with its time); status row ordered asks-first (Needs you, waiting, approvals, errors, workspace, sessions, workpad, ideas, Archived, Legacy). The output tail is not fetched when the activity line cannot show it.
- [x] Options: host-scoped `cardActivity` (auto/progress/output/both/none) and `cardHidden` (priority, type, ticket, tags, sessions, workpad, ideas) in `board-view`; each falls back on its own (`.catch`) so a bad value never resets other board preferences, unknown hidden ids are kept. Pure helpers `shared/card-display.ts`. Settings → Cards (`client/card-settings.tsx`) with a live preview drawn by the real `TaskCard` and Reset to defaults; Sort menu → *Card display…* opens it.
- [x] Onboarding: tip `card-display` (≥6 active cards, after `first-card`, before `project-menu`), ONBOARDING-SPEC table, README (both) "Also included". Tour unchanged: a view preference, not a new concept. 33 strings in all 9 catalogs.
- [x] PASS: `npm run typecheck`; `npm test` 526 passed / 63 skipped (new `shared/card-display.test.ts`, settings and tip-order tests). One run hit a 5 s timeout in `server/tool-server.test.ts` (CLI flow, unrelated); it passes alone and on the next full run.
- [x] PASS (headless web, Tinylink, user setting restored): layout, Sort menu → Card display…, live toggles on preview and board, Reset. [Verification](verification/card-display.md).
- [ ] UNRUN: compact phone/native rendering; Luna 6 test session.


## Card workpad and soft delivery gate — 2026-10-19

- [x] Card request "卡片 Workpad：结构化计划/验收/验证清单 + 交付门槛" (from the Symphony research). Evaluated first; the user chose the slim version and settled the three open points (no gate without a workpad, hide summary Target when acceptance exists, people may mark a check pass). [Spec](WORKPAD-SPEC.md).
- [x] Implemented: `workpads`/`plans` on the board (`shared/model.ts`), pure logic `shared/workpad.ts` (merge with ids, by/at and sha rules, freshness, open items, card signal, plan from timeline), `server/workpad.ts` (git HEAD/commit reads, human check/resolve/refresh, plan + HEAD at turn end), `flowly_update_workpad` + `acknowledgeOpen`/`WORKPAD_OPEN` gate in `server/agent-service.ts`, CLI `workpad` and `--acknowledge-open`, tool body limit 256 KiB, skill (both copies); card signal, drawer Workpad section (`client/task-workpad.tsx`), Activity hides workpad events, Progress hides Target; workpads/plans follow card delete, project remove/restore and project-folder snapshots.
- [x] Onboarding: tour feature row *Workpad*, tip `first-workpad` (after `next-move`, before `first-idea`), ONBOARDING-SPEC tip table, README (both) highlight + tool list; 26 strings in all 9 catalogs.
- [x] PASS: typecheck; full `npm test` 519 passed / 63 skipped; live MCP/CLI and headless desktop/compact UI checks — details in [verification/workpad.md](verification/workpad.md).
- [ ] UNRUN: Plan from a real session's todo list; cycling check state / resolving confusions / out-of-date display in the real UI; Luna 6 test session.
- [x] User follow-up "workpad作为一个可选功能，允许在project设置中开关": `Project.workpad` (absent = on), *Card workpad* switch in project settings. Off: `WORKPAD_DISABLED`, no delivery gate, `get_task` `workpadEnabled:false` with no workpad/plan, no Plan or HEAD recording, people's edits refused, card signal / drawer section / tip hidden, summary Target shown again; stored data kept. Skill (both copies), spec §9, ONBOARDING tip row, README; 2 strings × 9 catalogs; tests in `server/agent-service.test.ts` and `server/workpad.test.ts`.

## Project tab context menu — 2026-10-19

- [x] Card request "project tab增加contextual menu、进行编辑、设置等": right-click (long-press on touch) a desktop project tab for Project settings, New task, Insights, Ideas, Move left/right, Restore (archived) and Remove…. Reuses the board's `ContextMenuProvider`; `ProjectTabs` takes `menuFor`, entries built in `client/board.tsx` (`projectTabMenu`). [Spec](PROJECT-TABS-SPEC.md) updated.
- [x] Onboarding: tip `project-menu` (desktop tabs with ≥2 projects, after `first-card`), ONBOARDING-SPEC tip table; no tour change (project/card/session mapping unchanged). 3 strings in all 9 catalogs.
- [x] PASS: typecheck; full `npm test` (new tip-order test in `client/onboarding-logic.test.ts`).
- [x] User follow-up "增加project tab drag n drop调整顺序": tabs reorder by mouse drag. `SortableList` gains `horizontal` (row layout, x axis, `translateX`) and `onItemLayout` (tabs keep auto-reveal offsets); chooser and tabs share `dropProject` in `client/board.tsx`. Tip text now mentions dragging (all 9 catalogs).
- [x] PASS: typecheck; `npm test` 495 passed / 63 skipped; plugin reloaded.
- [x] PASS (headless app.paseo.sh web client on the local daemon, own profile, 1440×900; the user's windows untouched): right-click on the 2nd tab lists Project settings, New task, Insights, Ideas, Move left, Move right, Remove… without switching project; outside click closes it. Dragging `Flowly` past `Search System` → order `Search System, Flowly, Tinylink`, Flowly still active; dragged back → original order restored (user's real project order, verified restored). No page errors.
- [ ] UNRUN: picking each menu item in the UI; Electron desktop app; touch long-press; Luna 6 test session.


## Recent activity sorts by turn ends — 2026-10-19

- [x] Card request "recent activity排序优化": the Recent activity sort used every session update (each streamed message) and the card's own `updatedAt`, so cards jumped while sessions ran. It now uses only finished turns: `latestTurnEnds`/`turnEndActivity` in `shared/sort.ts` (recorded `agent.turn_ended` events; for sessions that record none, the time they last went idle, remembered client-side while they run); a card without a turn end counts from its creation. Menu detail now "Latest finished session turn first" (all catalogs). [Spec](UI-REFRESH-SPEC.md) Sort bullet updated.
- [x] PASS: typecheck; full `npm test` 494 passed / 63 skipped (`shared/sort.test.ts`: turn-start and task edits do not move a card, settled non-Kanban sessions count).
- [ ] UNRUN: watching the live board reorder during a running turn; Luna 6 test session.
- Onboarding: no tour or tip change, the sort option and its place are unchanged; only its ordering rule.

## Jira tickets as card inputs — 2026-10-19

- [x] Card request "jira工单接入": research and design how to bring Jira/Linear tickets into Flowly, and whether to isolate or merge statuses. First draft (milestone push to Jira) replaced by the user's decision: tickets are **read-only inputs and references**; Flowly status never affects the tracker. User's flow: New task → From Jira (my recent tickets, search by name or number, title prefilled only when empty), link on existing cards, agents perceive the ticket every turn like artifacts. Decisions: self-hosted and Cloud Jira both in P1; recent list = 10 unresolved; card face shows the key only. [Spec](EXTERNAL-TRACKER-SPEC.md).
- [x] Implemented P1 (spec §8.1): `shared/tickets.ts`, `server/tickets.ts` (0600 connections, GET-only allowlisted client, cache, backoff, fingerprints), ticket artifacts and `tasks.create` `tickets` in one commit, `get_task.artifacts[].ticket` + unread on content change, `flowly_read_ticket` / CLI `ticket --id`, skill (both copies); Settings → Connections, From Jira picker with title prefill, Link Jira ticket + ticket preview in the drawer, key line on cards; tips `first-ticket` / `jira-connect`, tour line, README, ONBOARDING-SPEC tip table, 49 strings in all 9 catalogs.
- [x] PASS: typecheck; full `npm test` 490 passed / 63 skipped (new `shared/tickets.test.ts` 10, `server/tickets.test.ts` 18: private credentials, GET-only allowlist, Cloud/DC auth and search endpoints, 401/429/login page/offline cache, fingerprint ignores status, Markdown + truncation, card + tickets in one write, link by URL/key, agent unread and read scope).
- [x] PASS (live, installed plugin reloaded): this card's session saw `flowly_read_ticket` over MCP; reading a non-ticket artifact returns `TICKET_NOT_FOUND`.
- [x] Fixed (user report): "Add a Jira connection" froze all of Paseo. The connection form was a host Modal opened on top of the settings window (itself an RN Modal); the editor now replaces the list inside the Connections page. Typecheck + `npm test` 490 passed; plugin reloaded. UI re-check UNRUN.
- [x] User request: Test connection in the connection editor (`tickets.connection-test`, checks `/myself`, saves nothing; editing tests with the stored token; result hidden once address/type/email/token change). 3 strings × 9 catalogs. Test added; `npm test` 491 passed on 8 runs (one earlier run had 1 failure that did not reproduce and was not captured). Plugin reloaded. UI UNRUN.
- [x] User question: deleting a connection that cards still use. Ticket inputs stay as links (data untouched); drawer shows "Connection removed", preview explains, agent gets `ticket.connection: "removed"` + `TICKET_UNAVAILABLE` (ask the user), new-session context drops the tool hint; removal confirmation counts the affected cards; adding the same Jira again restores them (lookup by own connection, else by link host/path). 4 strings × 9 catalogs; lifecycle test added; `npm test` 492 passed ×3; plugin reloaded. UI UNRUN.
- [x] User report: closing Flowly settings animated twice. Cause outside Flowly: paseo-native-polish ghosts every removed `role="dialog"` unless the host exit is a CSS transition; RN Modal (web) fades out with a keyframe animation, so the window faded a second time. Fixed there per the user: released 0.4.14 (commit 31fa09a on `main`, tag `v0.4.14`, pushed to JasprW/paseo-native-polish; installed plugin updated to it): an `animationstart` on a tracked overlay or its wrapper whose last keyframe is transparent marks the exit host-owned. Typecheck PASS. Flowly code unchanged. UI UNRUN.
- [ ] UNRUN: against a real Jira (jira.shopee.io needs the user's token entered in Settings → Connections; Jira Cloud); desktop/phone UI of the picker, settings page and drawer; Luna 6 test session.

## AI mark — 2026-10-19

- [x] Card request "所有AI feature增加星星标记": mark existing AI features with the star like next moves. [Spec](AI-MARK-SPEC.md).
- [x] Implemented: `AiMark` + `SectionHeader ai` in `client/ui.tsx`; card progress line (Flag → mark), drawer Progress and Ideas headers, Ideas page title, Insights daily Summary, agent-added artifacts and tags (Bot → mark). Card type `feature` icon Sparkles → Puzzle so Sparkles only means AI. Tour page 3 line; 2 strings in all 9 catalogs. No tip (nothing to do).
- [ ] UNRUN: desktop/phone UI check in the installed plugin, Luna 6 test session.

## Suggested next moves — 2026-10-19

- [x] Card request "建议next move": agents end turns with "要不要……或者……"; give them a tool to suggest the next move, show this turn's hints above the composer, tap pre-fills (never sends). [Spec](NEXT-MOVES-SPEC.md).
- [x] Implemented: `flowly_suggest_next_moves` (+ CLI `next-moves --moves <JSON>`, HTTP action `next_moves`, receipts/replay, `TASK_FINISHED` on Done/Cancelled) records `next_moves_suggested` with `moves` on the event, no task revision change. `shared/next-moves.ts` (`openNextMoves`: latest set until the session's next turn starts; `nextMoveDraft`: fill or append). Session view `client/next-moves.tsx` chips above the composer, hidden while running, while a question/approval is pending, after a newer user message, or after ×; native input remounts with the text and focus (no IME breakage), web focuses the controlled input. Hidden from the activity timeline; A1r ignores it. Skill text (both copies), tool description, tip `next-move`, tour feature line, README, 6 strings in all 9 catalogs.
- [x] PASS: typecheck; full `npm test` 73 files / 461 tests (new `shared/next-moves.test.ts`; agent-service write/replay/limits/finished; CLI flow + bad `--moves`; A1r with only next moves; tool list; tip order).
- [ ] UNRUN: desktop/phone UI check of the chips in the installed plugin, Luna 6 test session.

## Answer agent questions in the session — 2026-10-18

- [x] Card request "提问能力接入": an agent's ask-user-question lit up the card but the question was only visible in the native Paseo session. [Spec](SESSION-QUESTION-SPEC.md).
- [x] Card request "提问方式优化" (2026-10-20): the skill and `flowly_report_progress` description now tell agents to ask through their own question tool (AskUserQuestion etc.) and use `kind=question` only as the fallback, never both for one question. Text-only change. [Spec](SESSION-QUESTION-SPEC.md) §2.2.
- [x] Capability check: the public SDK already carries `pendingPermissions` on agent snapshots and `agent.respondToPermission`; the answer encoding was read from the installed Paseo 0.11.2 app (answers keyed by header, `", "` joins, dismiss = deny "Dismissed by user") and the Claude provider (maps headers back to question text).
- [x] Implemented: `shared/permission-question.ts` (pure form logic), `client/session-question.tsx` (question form; Allow/Deny or provider actions for other requests) above the session composer; respond re-checks membership and that the request is still pending. "Waiting for your answer" session label; agent questions count as Needs you / questions, not approvals. Tip `agent-question`, tour feature line, 19 strings in all 9 catalogs.
- [x] PASS: typecheck; full `npm test` (a `server/tool-server.test.ts` failure seen mid-way came from a parallel session's in-progress edit and passed once it settled). The session-attention verification fixture now expects the new `questions` count.
- [x] PASS (live, user, desktop): single select, multi select + Other, Other-only text, Dismiss, tool approval (always-ask mode, file create/delete). User feedback "输入框回车不能直接提交" fixed: web Enter submits the form, Shift+Enter new line.
- [ ] UNRUN: phone layout, plan approval, Luna 6 test session.

## Project folder copy — 2026-10-17

- [x] Card request "Flowly project保存在原始project目录". User chose A: each project's board is also saved in `<root>/.flowly/project.json`, restorable after the project is removed from Flowly, git-ignored by default. [Spec](PROJECT-FOLDER-SPEC.md).
- [x] Daemon: `server/project-folder.ts` (snapshot writer debounced after each board commit, only changed projects; `.flowly/.gitignore` = `*` created with the folder only; foreign/invalid file kept as a dated copy; failures logged and never fail the board). `projects.restore-check`, `projects.restore` (native project found/created, same IDs, revisions + 1, `restored` event, bound workspaces cleared, summaries merged, flow log re-enabled), `projects.folder-state`. Snapshot includes card artifacts.
- [x] Client: restore notice with Restore it / Start empty in Create project; *Saved in project folder* row in project settings; line in the Remove dialog; restore toast; tour feature line. Strings in all 9 catalogs.
- [x] PASS: typecheck; `server/project-folder.test.ts` 7 tests (scope of records, gitignore, change detection, write failure isolation, remove → restore round trip, conflicts write nothing, unbound workspace, invalid/foreign file kept).
- [x] User follow-up "老项目升级插件后自动迁移": explicit upgrade migration on each start (spec §1.1): every project (archived included) gets its folder copy, already-current copies untouched, failures retried; result in `folder-migration.json`. PASS: 2 more tests (9 total): pre-version board → all written, second start all current with no rewrite, board unchanged; unwritable folder failed then written on the next start.
- [x] PASS: full `npm test` 417 passed / 63 skipped (after the parallel card-artifacts work settled).
- [x] Installed the local checkout as `flowly` (user request "安装 我来测试"): the published plugins.paseo.sh install had to be removed first (`plugin install` refuses a configured ID); plugin data and settings were backed up to `~/.paseo/flowly-backup-20261018-001006/` beforehand. On start the migration logged `1 written, 0 current, 0 failed`; `/Users/claw/Dev/flowly/.flowly/project.json` holds the Flowly project (4 cards, 39 events); `git check-ignore` confirms `.flowly/.gitignore` ignores it. User checked the installed plugin: the project works normally.
- [ ] UNRUN: Luna UI acceptance and the remove → restore flow on a fixture project through the UI. Luna session `1c921648-071b-4634-9efc-7f3d52ad3c31` (codex/gpt-6-luna, full-access) could not run commands: its shell tool failed twice, even on `pwd` ("timed out negotiating with the code-mode host"); no fixtures created, nothing changed.

## Card artifacts — 2026-10-17

- [x] Card request "设计一下任务卡片增加assets或者artifacts，用于记录和收集这个任务输入输出的文档、交付物等。由agent根据理解自行添加也可以由人手工添加". Drafted the [card artifacts spec](CARD-ARTIFACTS-SPEC.md): references (file in card scope / http(s) link) with role input/output/reference in `board.artifacts`; human RPCs; `flowly_add_artifact` / `flowly_remove_artifact` tools; drawer section, preview, cascade on delete.
- [x] User decisions: references only; agents cannot remove human-added artifacts; nothing on the card face; each row shows input/output and human/agent; follow-up inheritance deferred. Roles reduced to input/output.
- [x] Implemented (user: "开始"): `board.artifacts` + `shared/artifacts.ts`; `server/artifacts.ts` (scope check with realpath so symlinks can't escape, `./` workspace-relative storage, dedupe by target, `updatedAt` edit conflict, board revision only, `artifact_added`/`artifact_removed` events, batched missing check, preview re-checked on read: image ≤8 MB, text ≤256 KB, folder ≤200 entries). RPCs `artifacts.create/update/delete/status/preview`. Tools `flowly_add_artifact` / `flowly_remove_artifact` (+ CLI `artifact` / `artifact-remove`, receipts, `ARTIFACT_INVALID` / `ARTIFACT_FORBIDDEN` / `ARTIFACTS_DISABLED`), `get_task.artifacts`, inputs/outputs in session context, skill text. Drawer section with add/edit form and preview; setting Agent artifacts; tip `first-artifact`, tour feature, README; 9 catalogs. Card delete / project remove back up and drop artifacts. Dropped from v1 (spec §10): collect from session, file browse, Copy path, Undo.
- [x] PASS: typecheck; `npm test` 66 files / 415 tests (new `server/artifacts.test.ts`, tip order, tool list, i18n).
- [x] PASS (installed local build, this card's own session over MCP): `flowly_add_artifact` registered `docs/CARD-ARTIFACTS-SPEC.md` as output → stored `./docs/CARD-ARTIFACTS-SPEC.md`, `createdBy: agent`, `missing: false`, `artifact_added` event, task revision unchanged; `/etc/hosts` refused with `ARTIFACT_INVALID`.
- [x] User report: the artifact preview did not scroll on phones. Cause: a nested ScrollView (maxHeight 520) inside the host modal's scrollable body took the pan. Fix: the text/markdown preview renders directly in the modal body, which scrolls. Typecheck and tests pass; plugin reloaded.
- [ ] UNRUN: phone re-check of the fix; drawer UI (desktop/compact), human edit/remove, and the Luna 6 test session.
- [x] User question "用户自己添加的 artifacts，Agent 如何有效使用"; chose A+B. A: session context lists the user's inputs first with `[user]/[agent]` and the note; skill makes user inputs required reading (notes are instructions, say so when one can't be read, name the inputs used), `flowly_get_task` description asks for a read each turn. B: `get_task.artifacts[].unread` (added/edited since this session's last explicit get_task, never its own), per-session read times in `artifact-reads.json`, not the board.
- [x] PASS: typecheck; `server/artifacts.test.ts` 6 tests (unread first read / own additions / write context does not mark / other session / edit re-flags / survives a new service). Full `npm test`: 445 passed; 2 failed outside this change (`tool-server` CLI flow timed out at 5 s under load, passes alone in ~4 s, same as HEAD; `session-attention` fixture fails on another session's uncommitted `shared/session-attention.ts`).
- [x] PASS (reloaded local plugin, this session over MCP): `get_task` returns `unread: false` on this session's own artifact; `artifact-reads.json` written with this session's read time (mode 600).
- [x] PASS (live): the user added an input link in the drawer; this session's next `get_task` showed it `createdBy: human, unread: true`, the following read `unread: false`; the agent opened the link as the skill asks. The context lines built from the live board put it first as `- [user] 我的个人博客: https://bofan.wang — <note>`.
- [ ] UNRUN: a newly created session actually receiving those context lines.

## Composer focus during a running session — 2026-10-16

- [x] Card report "PC 上 session 运行中打字会被打断，内容更新时出现，打断后完全无法输入". Cause: the transcript ScrollView had `keyboardDismissMode="on-drag"` on web; RN Web's `_handleScroll` then blurs the focused input on every scroll event, and follow-tail scrolls on each output update. Web now uses `none` ([spec](SESSION-INPUT-SPEC.md)).
- [x] PASS: typecheck; headless app.paseo.sh against the local daemon, typing into this card's running session with forced transcript scrolls: with the fix the textarea kept focus (0 blurs); control run with the old value lost focus to `<body>`, blur stack `_handleScroll → blurTextInput`.
- [ ] UNRUN: the Electron desktop window.

## Card links — 2026-10-16

- [x] Card request "设计任务卡片关联关系…父子任务可能有点麻烦，在其他agent kanban项目里怎么设计的". Researched Vibe Kanban (attempt-scoped subtasks, independent status), Multica, Linear/Jira/Plane, agent-tasks MCP. User chose option A: Follow-up of (derived) + Related + Blocks (hint only), no parent/child; approved the [card links spec](CARD-LINKS-SPEC.md), then "OK 做吧".
- [x] Data: `board.links` (`derived`/`related`/`blocks`, same project, board stays v4); files without `links` derive them once from `Task.origin`. `shared/links.ts` (relations, resolution, cycle detection, context lines). `links.create` / `links.delete` (CAS-free, board revision only; events on both cards; Related replaced by a more specific link; cycle, duplicate, cross-project, archived and 50-per-card checks). `tasks.create` with `followUpOf` (checked before the workspace and in the write) and with `ideaId` writes a derived link. Card delete / project remove back up and drop links; the other card records `unlinked`.
- [x] Agents: `flowly_get_task.links` (relation, title, lane, archived, resolved), session context lists links instead of `Derived from card`, skill rule (read-only; unresolved blocked_by is a hint).
- [x] Client: "Waiting on N" card signal; drawer Links section below Ideas (groups, open, optimistic remove, `+` menu); "From idea on / Follow-up of" line; Link to a card… picker; New follow-up task form; card menu and phone action sheet entries.
- [x] PASS: typecheck; `npm test` 331 passed / 63 skipped (new `shared/links.test.ts`, `server/links.test.ts`, `client/link-rows.test.ts`; idea tests updated).
- [x] Luna (`codex/gpt-6-luna`, full access) acceptance, session `a2d45f82`, headless app.paseo.sh, two runs with fresh fixtures (cleaned): PASS link modal/search/toast, both-side groups, Waiting on → Was waiting on after Done, cycle and already-linked errors in the modal, remove + Activity, New follow-up task, linked-card delete backup (RPC), agent `flowly_get_task.links` and context lines, dark desktop, no console errors. FAIL fixed afterwards: the picker offered a card already linked by Blocks as a Related candidate. [Verification](verification/card-links.md).
- [ ] UNRUN: compact 390×844 UI (automation could not reach the board in the mobile context); Delete permanently from the UI (checked via RPC); browser re-check of the picker fix; Electron window and a physical phone.

## Project insights — 2026-10-16

- [x] Card request "项目整体天级统计、变更总结" / "为项目增加一个project级别的统计、总结、insight的功能". User chose purpose A (daily review and planning the day) and approved an untrimmed flow log; then "先这么实现看看". Wrote [insights spec](PROJECT-INSIGHTS-SPEC.md).
- [x] Daemon: `flow/<projectId>.jsonl` appended after each board commit (notes not stored), reconciled from the board at startup and before each read (first run backfilled 533 events); card delete rewrites it with a `removed/` backup, project remove moves it to `removed/`. Rule A1 resumes undone by A1r are ignored (not rework, no new review wait).
- [x] `insights.project` (etag): day stats in the client's time zone, 7-day averages and trend, lane dwell medians, In review / Blocked waits, rules R1–R7, git commits (root + first-level child repos, `git log --all --numstat`). `insights.digest` / `insights.digest-refresh`: LLM daily digest in `digests.json` (60 days per project), auto for past days when *Daily digest* is on, run in the project root's workspace (else the latest card workspace) and archived in `finally`.
- [x] Client: *Insights* chip in the overview bar and shortcut I; page with day navigation, number tiles, Waiting on you, Suggestions, Summary, Last 7 days; Esc / ‹ Board returns. *Daily digest* toggle in settings.
- [x] PASS: typecheck; `npm test` 308 passed / 63 skipped (new insights, flow-log, git-stats, digest and service tests); plugin reloaded; analysis checked against this board's real data.
- [x] Luna UI acceptance (session `bceb36e5`, worker `03d2ee59`) in a headless app.paseo.sh client, 1440×900 and 390×844 light/dark: 9 PASS, 1 FAIL (Commits tile hid its average behind the line delta), fixed afterwards (hint and average share the line). Digest generated with Haiku 5.5 and its sessions archived; fixtures cleaned. [Verification](verification/project-insights.md).
- [ ] UNRUN: digest model-error paths; Electron window and a physical phone; re-screenshot after the tile fix.
- [x] Idea "Insights：按天统计 token 用量" (continued in this card): log parsers keep 15-minute token slots (Claude per deduped message, Codex count differences with reset handling); `insights.tokens` sums them into the client's days for all sessions of the project's cards; Tokens tile, Token use section (types, cache rate, top 5 cards) and Tokens per day bars. Spec §11.
- [x] PASS: typecheck; `npm test` 320 passed / 63 skipped (bucket and day-sum tests); real logs: plugin per-day sums equal an independent script (Claude 23,843,196 on 2026-10-16; Codex 5,683,345 on 2026-10-14).

## Ideas cards — 2026-10-15

- [x] Card request "agent执行过程中根据现状提供下一步计划，在任务中提议下一步可以做的任务，用户觉得好可以点击idea卡片创建新的任务卡片并把上下文带进去". User chose: ideas come from the working agent via a tool (A), show on the source card's drawer plus a card badge (A), and Create task opens the prefilled new-task form (A); then "直接实现，不审阅方案". Wrote [ideas spec](IDEAS-SPEC.md). Baseline commit of the prior working tree first (the repository already existed, so no re-init).
- [x] Data: `board.ideas` (absent reads as `[]`, board stays v4), optional `task.origin`, receipt action `idea`. Agent tool `flowly_propose_idea` (signed request, replay, `IDEA_DUPLICATE`, `IDEA_LIMIT` 10 open, 50 kept per card), `flowly_get_task` lists the card's ideas, CLI `idea` subcommand, skill rule. `ideas.update` (dismiss/restore). `tasks.create` with `ideaId` checks before the workspace and again in the write, linking both ways atomically. Card delete / project remove back up and drop ideas.
- [x] Client: lightbulb count on cards, drawer Ideas section (open cards with Create task / Dismiss, closed group with links and Restore), "From idea on …" line, new-task form prefilled from the idea and source progress ("Create task from idea"); session context line `Derived from card: …`.
- [x] PASS: typecheck; `npm test` 279 passed / 63 skipped (new `server/ideas.test.ts`, tool-server MCP/CLI idea checks). Plugin reloaded.
- [x] Luna (`codex/gpt-6-luna`, full access) live acceptance, test session `c8e2e1b0`: MCP and CLI proposals, duplicate refusal, dismiss/restore, create-from-idea links and `Derived from card` context, reuse refused without a new workspace, delete backup; fixtures cleaned to the baseline counts. [Verification](verification/ideas.md).
- [x] Follow-up "ideas放到sessions下面": the drawer's Ideas section sits below Sessions.
- [x] Follow-up "优化idea卡片的设计、交互、motion。接受按钮改成good idea": cards show title, a meta line (type, non-Normal priority, age) and the rationale; details (What to do, Context) expand with animated height and a rotating chevron; actions are **Not now** and **Good idea**. Not now is optimistic and collapses the card in place (rolled back with a toast on failure); accepted ideas collapse out too; ideas arriving while the drawer is open rise in. Slot-keeping merge in `client/idea-rows.ts` (3 tests). PASS: typecheck; `npm test` 282 passed / 63 skipped; reloaded.
- [x] Follow-up "按钮左对齐还更好看点": idea actions left-aligned with the title, primary Good idea first, then Not now.
- [x] Follow-up "按钮有点太大了 移动端看有点不协调": shared `Button` gains `small` (32 pt on touch / 28 px desktop, 12 pt label, 13 pt icon, hitSlop keeps the 44 pt target); idea actions and Restore use it. Low priority shows as text without its single-bar glyph (read as a stray comma). Checked read-only on this card at 390×844 in a separate headless app.paseo.sh client; the phone lane picker was put back to Design.
- [x] Follow-up "good idea有些是当前任务的延伸…两种路径都要支持。重新设计这个链路": ideas carry the agent's `scope` (here / new; tool, CLI `--scope`, skill rule). Good idea opens a menu: **Do it in this task** (`ideas.adopt`: marks the idea for the proposing or newest live session, then queues the instruction through the composer; reverted if the hand-off fails) or **Start a new task** (prefilled form). The suggested path comes first; the meta line shows it; Closed shows "→ Sent to <session>". PASS: typecheck; `npm test` 311 passed / 63 skipped (new adopt tests).
- [x] Idea adopted in this card via "Do it in this task" (first live end-to-end use of the path): Restore refuses a dismissed idea whose title matches an open idea on the card (`ideaTitleKey` moved to `shared/ideas.ts`; new store test). PASS: typecheck; `npm test` 312 passed / 63 skipped; reloaded.
- [x] Follow-up "多个session会在哪个继续？能不能再加一个使用新session做的选项" (user: 可以): Good idea menu now offers Continue in <proposer or newest session>, Send to another session… (2+ live sessions; second menu), Do it in a new session (Start session prefilled with the idea; recorded with `ideas.adopt send:false` once created), and Start a new task. PASS: typecheck; `npm test` 313 passed / 63 skipped.
- [x] Luna UI acceptance (test session `59dbe335`, worker `515d644c`) in a separate headless app.paseo.sh client at 1440×900 and 390×844, light and dark: badge, drawer order, card layout, expand/collapse, Not now → Closed → Restore, Good idea prefilled form, two-way links; no console errors; fixtures cleaned. [Verification](verification/ideas-ui.md).
- [ ] UNRUN: frame-by-frame motion and Reduce Motion; the Electron window and a physical phone.

## App performance — 2026-10-15

- [x] Card request "app端存在一些性能问题，例如动画卡顿、session卡片加载慢等，输入框不跟手、丢字、自动关闭输入法等情况". Audit, then [performance spec](PERFORMANCE-SPEC.md) before code. Cause: the phone's JS thread was busy decoding large polls (relay E2EE in JS) and re-rendering the whole tree on every poll.
- [x] Daemon: `board.read-changed`, `summaries.read-changed`, `resources.read-changed` (etag; unchanged = 38 B), `sessions.tail` (slim projected tail, card-scoped).
- [x] Client: shared queries (`client/queries.ts`), streamed live agent list, drawer sessions from the stream, preview loads agent/transcript in parallel from cache, tools/access only while shown, memoized cards/drawer/transcript with stable callbacks and a stable theme/menu context, phone board hidden instead of unmounted, native-looped pulse, no card mount fade, native composer self-sizing, keyboard padding after the animation, send clears at once (restores on failure), late draft restore never remounts a focused input.
- [x] PASS: typecheck; `npm test` 266 passed / 63 skipped; plugin reloaded; live RPC sizes and agent stream checked. [Verification](verification/performance.md).
- [x] Follow-up "session card右边的最后活跃时间垂直居中": the time moved out of the title row, beside the chevron, centered on the row.
- [x] Follow-up "打开任务卡内容、打开session，动画都很卡": heavy sections and reads wait for the open transition (`useSettled`); archived sessions from the daemon (`sessions.archived`) instead of paging every agent on each open; phone card is an overlay above the still laid-out board. PASS: typecheck; `npm test` 267 passed / 63 skipped; reloaded; live RPC check.
- [x] Follow-up "上下滚动的时候会出现这种水平漂移问题": cached interpolation nodes (`lerp`), final-value sync after native transitions, no reveal on first mount. PASS: app typecheck; tests (one failure from the concurrent Ideas work); reloaded.
- [ ] UNRUN: real-device smoothness/IME on iOS/Android over LAN and relay; Luna UI acceptance; stale renderer fixtures (pre-existing).

## Automatic status as a setting — 2026-10-15

- [x] Card request "自动流转作为设置项提供，默认打开". New host setting `auto-status.autoStatus` (default on; unset/invalid stored values read as on), shown in Ultra Kanban settings → *Moving cards* → *Auto-update status from sessions*. Off: the daemon still records turn facts but skips rules A1/A1r. The per-project switch stays as an opt-out, renamed *Auto-update status in this project*. [AUTO-STATUS-SPEC](AUTO-STATUS-SPEC.md) amended.
- [x] PASS: typecheck; `npm test` 254 passed / 63 skipped (new: setting defaults). Plugin reloaded.
- [ ] UNRUN: Luna UI acceptance of the settings toggle; a live turn with the setting off.

## Delete a card permanently — 2026-10-15

- [x] Card request "增加彻底删除卡片的能力，并把现在当前project下无法unarchive的那些老的卡片删了". Wrote [task delete spec](TASK-DELETE-SPEC.md): archived cards get *Delete permanently…* in the board card menu and drawer task menu, with a confirm dialog; `tasks.delete` (CAS, archived only) drops the card, its events, receipts and summaries after a `removed/` backup; Paseo resources untouched. AGENTS.md exception added.
- [x] PASS: typecheck; `npm test` 251 passed / 63 skipped (2 new store tests). Plugin reloaded.
- [x] Deleted the 11 archived Ultra Kanban cards whose worktrees the old wrap-up removed, through the plugin RPC; kept the restorable “竞品调研”. [Verification](verification/task-delete.md).
- [x] Follow-up "手机端lane列表的选中标记导致数字不在一列": `Row` puts the selected check before the trailing value (user preferred this over a reserved empty slot), so the phone lane picker counts stay flush right in one column. PASS: typecheck; `npm test` 251 passed / 63 skipped. Plugin reloaded.
- [x] Follow-up "菜单没有删除任务的选项，允许任何lane里删除，删除时询问是否同时archive，增加选项自动archive": *Delete permanently…* on every card; the dialog runs `tasks.delete-check` (wrap-up preflight without the lane rule) and asks Keep / Archive for its sessions and own workspace (running sessions disable Archive, warnings shown); new setting *Auto archive on delete* (`wrap-up.archiveOnDelete`) skips the question when the preflight is clean. `tasks.delete` archives first (wrap-up run, keepCard) and deletes only if that succeeds. PASS: typecheck; `npm test` 253 passed / 63 skipped (new: live-card delete, delete preflight/run). Plugin reloaded; live `tasks.delete-check` on 竞品调研 (clean) and this card (running session → blocker).
- [ ] UNRUN: Luna UI acceptance of the menu entries, dialog and setting; a live delete with Archive on a fixture card; phone lane picker alignment on a real phone.

## Task type — 2026-10-15

- [x] Card request "任务卡片增加任务类型，比如research、bugfix、feature等". Wrote [task type spec](TASK-TYPE-SPEC.md): optional `task.type` (Feature / Bug fix / Research / Refactor / Docs / Chore); absent on existing cards, so no board migration.
- [x] Create/edit form Type choice (default None), card meta chip, drawer Type property, Details row, board Type filter (`filterType`, remembered, reset and cleared by session links); session context line `Task type: …` when set.
- [x] PASS: typecheck; `npm test` 248 passed / 63 skipped (new: store set/clear/keep, context line, settings default).
- [x] Follow-up "side bar里改状态和tag直接在按钮旁边出下拉菜单": drawer Status / Type / Priority open a dropdown anchored below the button (context menu gained `leading` icons; the button measures itself), values save directly with CAS + toast; the drawer Status modal is gone. PASS: typecheck; `npm test` 249 passed / 63 skipped. Plugin reloaded.
- [ ] UNRUN: Luna (`codex/gpt-6-luna`) UI acceptance on desktop/compact, including dropdown placement near the right edge.

## Restore the workspace and sessions when a wrapped-up card leaves Done/Cancelled — 2026-10-15

- [x] User chose option A: a temporary direct daemon connection, because the plugin SDK has no workspace restore. Wrote [workspace restore spec](WORKSPACE-RESTORE-SPEC.md), which records the SDK migration path (`COMPAT(sdk-workspace-restore)` in `server/workspace-restore.ts`).
- [x] Moving a card out of Done/Cancelled restores its workspace in the background, under the same workspace ID: unarchive in place, or recreate a removed worktree on its kept branch. This applies only when the plugin's wrap-up archived it or the card owns it. Records `workspace_restored` / `workspace_restore_skipped`. Sessions stay archived until messaged.
- [x] PASS: typecheck; `npm test` 243 passed / 63 skipped (5 new). Reloaded the plugin. End-to-end through the real plugin RPC, worktree and directory cards: [verification](verification/workspace-restore.md); fixtures cleaned up.
- [x] User follow-up "把session也复活": the sessions the wrap-up archived are revived too, by daemon agent refresh on the same connection. Selection: `archivedAt` within a wrap-up event, so user-archived sessions and summarizers are excluded. An already-active workspace still gets its sessions back (`sessions_restored`). PASS: `npm test` 246 passed / 63 skipped; e2e with sessions that ran a turn, both restored.
- [ ] UNRUN: Luna UI acceptance; end-to-end with Auto wrap up off; real unavailable-path cases (covered by focused tests).
- [ ] Follow-up: switch to the SDK once `PaseoApi.workspaces` exposes restore.

## Workflow stages: In progress → Design / Development / Test — 2026-10-15

- [x] User decisions: split In progress into Design → Development → Test for every project (option B); the agent decides whether to start with Design or Development. Wrote [workflow stages spec](WORKFLOW-STAGES-SPEC.md) and the user approved it ("可以 试试看吧，不行再改回去").
- [x] Board v4 (`server/migrate.ts`): In progress cards → Development; a configured In progress lane expands in place (on/off kept, custom name → Development); events/receipts keep the retired status (`historyStatusSchema`), shown as "In progress"; one-time `board.pre-v4.json` copy.
- [x] Rules: A1 no longer moves Backlog/Todo; resuming from In review/Blocked returns to the latest enabled work stage (else the first enabled one, else no move). A1r and the silent-turn marker cover all three stages.
- [x] Agents: `allowedStatuses` uses design/development/test/blocked/in_review; `in_progress` is accepted as a deprecated alias (keeps the current stage, else Development) so sessions with the old tool schema still work. Skill, tool description, CLI usage and UI copy updated; status icons CircleEllipsis / CircleDot / CircleGauge (same Circle family as the other statuses; Pencil/ShieldCheck looked a different size).
- [x] PASS: typecheck; `npm test` 231 passed / 63 skipped (new: v3→v4 migration, rejected v4 in_progress, A1 resume/skip/disabled lanes, silent turn per stage, alias). Reloaded the plugin. Live board migrated to v4: 2 In progress cards → Development, Ultra Kanban lanes expanded, 37 history events still read `in_progress`, `board.pre-v4.json` holds the v3 data. A live `flowly_update_status(in_progress)` call from this session (old schema) kept the card in Development.
- [x] Fix (user report): dragging a card to another lane under a non-Manual sort showed "Sorted by priority…" instead of moving it. Cause: web `onLayout` uses ResizeObserver and only reports size changes, so lanes shifted by a sibling collapsing/expanding (or lanes added/hidden) kept a stale x and the drop resolved to the card's own lane. Lanes are now re-measured with `measureInWindow` at drag start; the toast now says lane moves still work. Cross-lane drops under priority/other sorts land by the sort rule.
- [x] Fix (user report, session `fdfe6286`): a rework-of-implementation follow-up resumed the card in Design. The agent had set Design, implemented, and delivered without ever setting Development, so A1 returned to that stale stage. Skill and tool description now require keeping the stage current (Development as soon as code changes; never deliver implementation from Design) and checking the auto-resumed stage at the start of every turn. A1 itself unchanged.
- [x] Follow-up (user: the same card went back to Design again; its session still had the old guidance): A1 now resumes a card **in review in Development** (review feedback is rework; falls back like Blocked when Development is off); Blocked still returns to the previous stage. Skill, settings copy and specs updated; tests cover both paths and the fallback.
- [ ] UNRUN: Luna (`codex/gpt-6-luna`) UI acceptance of the new lanes on desktop/compact, lane editor and activity rendering; drag between the three stages in the real app.

## Card token usage from local logs; Activity collapsible — 2026-10-15

- [x] Wrote [usage stats spec](USAGE-STATS-SPEC.md) before code. Tokens only, no money. Source: Claude Code (`~/.claude/projects/*/<id>.jsonl` + `subagents/`) and Codex (`~/.codex/sessions/**`, `archived_sessions/`) logs, located by Paseo `runtimeInfo.sessionId`. Read-only, cached by size/mtime.
- [x] Unified types: input (uncached), cache read, cache write, output (incl. reasoning), reasoning; turns and running time from the logs. Drawer **Usage** section (collapsed, header shows total and turns; per-session lines; progress summarizers as one subtotal). **Activity** is now collapsible and collapsed by default.
- [x] PASS: typecheck; `npm test` 225 passed / 63 skipped (5 new in `server/usage.test.ts`). Live `usage.task` on card `8c22cc02` (226 ms cold, 28 ms cached): Codex session `dddf746d` matches its rollout exactly (input 130,862 = 3,068,206 − 2,937,344 cached; output 17,098; reasoning 6,393); Claude session `17975bba` matches an independent recount within the turn that ran in between; 12/12 summarizer runs found.
- [ ] UNRUN: real-app rendering of Usage/Activity; Claude variants whose wrapper sets a different `CLAUDE_CONFIG_DIR` (the daemon's own environment is used).

## Task progress summary — 2026-10-15

- [x] Wrote [task summary spec](TASK-SUMMARY-SPEC.md) after the user approved the design (cheap model via a Paseo session; Summary model setting, default Haiku 5.5 → GPT-6-Luna; one short-lived session per run).
- [x] Daemon: after a completed turn of a Kanban-managed session, a summarizer child session in the card's workspace returns `{update, state, recap, next}`. It runs one at a time per card and merges turns that end meanwhile. It is archived in `finally`. Results go to `summaries.json` (50 versions per card, last error per card), never changing board or task revisions. Project Remove backs the summaries up to `removed/`. RPCs: `summaries.read/history/refresh`.
- [x] UI: one-line state on cards; drawer Progress section (State/Recap/Next, Refresh, History); Settings → Ultra Kanban (Auto summary, Summary model). Summarizer sessions are hidden from board session views by label.
- [x] PASS: typecheck; `npm test` 220 passed / 63 skipped (20 new). Luna live acceptance `dddf746d` plus a follow-up live re-check: [verification](verification/task-summary.md).
- [x] Fixed from live testing: summarizer directory registered a native project (moved to the card workspace as a child session, user choice B; leftover project deleted); Haiku's array-valued recap failed the schema (lenient parsing).
- [x] User feedback: host settings page never appeared → floating settings button at the board's bottom-left opens a plugin-drawn modal (Auto summary; Provider → Model). Progress collapsed by default (state, 3 recap lines, 1 next line; Show more). Output tightened (state ≤15 words/30 汉字, recap ≤4 short lines, next one sentence; hard caps 80/400/160). Live refresh after the change: 15 s, state 33 chars, 4 recap lines.
- [x] Added `target` (goal + up to 4 feature points; kept stable unless scope changes; old versions read as ""). Progress shows it between State and Recap (1 line collapsed). Live refresh on card `8c22cc02`: 12 s, target "Goal: 为每个任务提供快速确认进度的摘要" + 4 feature lines. Tests 235 passed.
- [x] Usage: cache hit rate = cache read ÷ all input (header, totals, per session).
- [ ] UNRUN: real-app rendering of the card line, Progress section, settings button and modal; finished-notification behavior for child summarizers.

## Sidebar attention badge (F2) — 2026-10-15

- [x] Wrote [sidebar badge spec](SIDEBAR-BADGE-SPEC.md) before code. Confirmed from the 0.11.2 public types and installed app bundle that `SidebarRow.trailing` renders nothing when null and otherwise sits in a non-accessible host Pressable sharing the row press; nested pressables press on their own.
- [x] Sidebar row shows a warning count pill (`99+` cap) only when the count is > 0; pressing the row still opens the board, pressing the pill opens the board with the Needs attention modal (unique `view=attention&open=<token>` per press). Board and sidebar both count through the shared pure `attentionFromSources`; badge pill extracted to `CountPill` and reused by the board button.
- [x] Sidebar polls board/agents/read receipts every 10 s with host-scoped query keys through plugin `useRpc`/`usePaseo` only; observers end on unmount. Board/agent failure hides the badge.
- [x] PASS: `npm run typecheck`; `npm test` 95 passed / 56 renderer-only skipped (2 new focused tests in `client/attention.test.ts`).
- [ ] UNRUN: plugin install/reload, real desktop/compact sidebar rendering, pill press and modal opening in the app, screen-reader focus of the pill. Not permitted in this card (no install/reload, no UI driving).

### Paseo theme color — 2026-10-22

- [x] Sidebar and board header Attention pills share `CountPill`, now using the active Paseo theme's `accent` background and `accentForeground` text. Updated [sidebar badge spec](SIDEBAR-BADGE-SPEC.md). No onboarding tip or tour change is warranted for this visual-only adjustment.
- [x] The old runtime bundle was identified from plugin logs and refreshed with `paseo plugin reload flowly`; no daemon restart. The user confirmed both desktop markers display green after reload.
- [x] Prior Luna run: `npm run typecheck` and `npm test` 114 files passed / 13 skipped, 921 passed / 65 skipped; `git diff --check`. Exact commit verification is recorded on the Flowly workpad before PR creation.
- [ ] UNRUN: compact rendering, a theme switch and pill activation were not separately checked.
## Card latest agent output (F1) — 2026-10-15

- [x] Wrote [card output spec](CARD-OUTPUT-SPEC.md) before code. Agent snapshot has no assistant-text field, so cards use a bounded 20-entry projected tail fetch keyed by session ID + `updatedAt`, only for mounted cards, at most 3 concurrent, no polling/retry.
- [x] Card shows one muted, non-selectable, single-line plain-text summary of the newest assistant message plus relative time; quiet for no session/loading/failure/no text; accessibility label includes it. Drag/press/Actions unchanged.
- [x] PASS: typecheck; full `npm test` 99 passed / 59 renderer-only skipped; focused helpers 6/6; synthetic renderer card 3/3; legacy card responder 8/8 after fixing its stale mock. [Verification](verification/card-output.md).
- [ ] FAIL (pre-existing, unchanged): session-attention renderer fixture 4 failures from stale mock, same on baseline.
- [ ] UNRUN: plugin install/reload, real desktop/phone UI, screen reader, live request rate.
## F3 drag reorder within/between columns — 2026-10-15

- [x] Wrote [drag reorder spec](DRAG-REORDER-SPEC.md) before implementation: insertion line, midline hit testing, `tasks.place` contract (CAS, single serialized atomic write, position/status only, no-op without write).
- [x] Implemented `tasks.place` (`BoardStore.placeTask`, fractional neighbor midpoint, normalization only when neighbors tie), pure `dropSlot`/`placementUpdate`, column insertion line and drop wiring; new cards append after the column's max position. Menu up/down and phone/touch paths unchanged.
- [x] PASS: typecheck; `npm test` 110 passed / 60 renderer-only skipped; focused store 10/10, geometry 12/12, service append 1/1, columns renderer 4/4 (temp `react-test-renderer`). [Evidence](verification/drag-reorder.md).
- [ ] FAIL (pre-existing, unchanged): 45 legacy renderer fixtures fail identically on the base commit due to stale `client/ui` mocks.
- [ ] UNRUN: actual desktop UI/drag feel and live conflict error — no plugin install/reload by instruction.
## F4 desktop keyboard shortcuts — 2026-10-15

- [x] Researched Paseo 0.11.2 before implementation. The plugin SDK has no shortcut API, and Command Center items have no key field. The host shortcut registry is internal, and a global DOM listener is forbidden. The trade-off is recorded in the [shortcuts spec](SHORTCUTS-SPEC.md), written before code.
- [x] Board-scoped keys on desktop web: N new task, P projects, / or F filters, A attention, ? help, Esc (session Back, then close the sidebar), and J/K/H/L card navigation. The root `View` is focusable and receives the RN-Web `onKeyDown`. Plugin text inputs and all plugin modals block shortcuts through a ref-counted guard (`useShortcutBlock`, `client/modal.tsx`). Modifier chords, repeats and IME input pass through.
- [x] Discoverability: a desktop header Keyboard button opens a help modal; header button labels include their key. Five global Command Center items open the board with a once-only, 30-second `intent` param.
- [x] PASS: `npm run typecheck`. PASS: focused `client/shortcuts.test.ts` 10/10. PASS: full `npm test` (103 passed / 56 renderer-only skipped). An initial run failed 3 renderer fixtures because `Modal.Content` was read at import time and their host mocks omit `Modal`; it is now read lazily, and the re-run passed.
- [ ] UNRUN: real desktop key handling, how focus enters the board, focus after a host modal closes, Command Center item display and navigation with params on an already-open board, and help modal appearance. Per card instructions, the plugin was not installed or reloaded and no Luna test session was created. [Verification](verification/shortcuts.md).

## Compact task status label — 2026-10-14

- [x] Updated [drawer spec](DRAWER-SPEC.md) before implementation. The [user capture](verification/fixtures/status-label/before.png) showed `T...`: installed host `SettingsSelect` reserves a 160 pt label while the plugin capped its wrapper at 240 pt.
- [x] Compact detail header now shows the full selected status in a full-width button; the seven options appear only after opening a themed host Modal. Same-value no-op, stale/inactive/archived/pending guards, exact task revision and success toast are preserved. Wide host selector has a larger width budget.
- [x] Focused 9/9, legacy renderer 43/43 and immediate-close 2/2 passed after updating stale test mocks; full suite 84 passed / 56 renderer-only skipped, final typecheck PASS, detector no findings. Reloaded only `paseo-ultra-kanban`, which reports running. Temporary renderers removed; no native resources created. [Evidence](verification/status-label.md).
- [ ] Android pixel visibility and sheet interaction remain UNRUN under the user's current code-only acceptance choice. Synthetic checks prove the selected label and actions passed to components, not the phone's pixels.

## Phone session composer — 2026-10-14

- [x] Updated [session UX spec](SESSION-UX-SPEC.md) before implementation from the user's Android [before screenshot](verification/fixtures/mobile-composer/before.png). Compact preview now uses a 48–96 pt growing input with a 48 pt Send target on the same row, one 48 pt Steer/Interrupt row only while running, and an inline Jump to latest target. Wide composer and send authorization remain intact.
- [x] Final typecheck PASS; focused real-component callback fixture 18/18 PASS (including compact growth, mode/send, paused follow and readonly); one full `npm test` 84 passed / 55 renderer-only skipped. Impeccable detector returned no findings. Reloaded only `paseo-ultra-kanban`; it reports running. No native resource was created.
- [ ] App E2E is UNRUN and deferred by the user's code-only acceptance choice. Paseo desktop CUA `getApp` timed out; AndroMeld `devices.list` returned `[]`, so no Android Phone Screen session existed. No desktop window or phone UI was operated. AI mirror control was disabled after the attempt. [Verification detail](verification/mobile-composer.md).

## Android project chooser theme crash — 2026-10-14

- [x] Amended [UI/UX spec](UI-UX-SPEC.md) before implementation. The user screenshot shows `Error: Theme missing` in the plugin `Button` when the compact project chooser opens. Source inspection found the custom theme provider outside the host Modal body.
- [x] Reprovided the current theme inside all seven host modal bodies: board project/filter/status/task-action choosers, project/task forms and session creation. No RPC, board data or resource contract changed.
- [x] `npm run typecheck` passed. Source inspection found a provider immediately inside every `Modal.Content`. Reloaded only `paseo-ultra-kanban`; plugin inventory reports enabled and running. No tests or new Paseo resources were created.
- [ ] Android opening/dismissing those modals is UNRUN: no safely addressable Android UI target was available; the ADB device inventory did not return and was interrupted. The plugin's `running` state is not proof of the mobile fix. [Verification and user screenshot](verification/android-modal-theme.md).

## Follow-up composer Enter submission — 2026-10-14

- Complete [input spec](SESSION-INPUT-SPEC.md) before code: desktop Enter/Shift/IME, native Send, shared lock/draft semantics, plain tool-purpose copy and exact user-message delivery without the repeated task preamble.
- [x] Shared button/key submission, native Send behavior, latest-draft buffer/writable guard, Shift/IME/repeat protection and purpose/hint copy implemented; parent typecheck PASS, detector no findings.
- [x] User correction applied: ordinary card follow-ups now send only the typed text after fresh actor/scope checks. Initial session context and explicit Kanban work instructions remain separate. Updated the existing wire-payload unit assertion and passed parent typecheck.
- [x] Independent full-access Luna passed 17 focused composer checks, 46 renderer regressions, final typecheck and one full suite (83 passed / 54 renderer-only skipped) before the wire-payload correction. The bounded post-correction wire check passed 4/4 and final typecheck passed; the broad suite was not repeated. [Chronology and evidence](verification/session-input.md).
- [x] Reloaded only `paseo-ultra-kanban`, confirmed running, deleted exact test session `6cbf1980-bcac-4b6b-9693-2731c7b611c4` and confirmed `AGENT_NOT_FOUND`. Its derived CLI context and all seven recorded renderer directories are absent. Two projects/two cards remain; six normal session lifecycle events are preserved. [Cleanup evidence](verification/fixtures/session-input/parent-closeout.json).
- [ ] Actual desktop/compact UI, hardware Shift/IME, focus and message delivery remain UNRUN: fresh CUA could not identify the required non-fullscreen window by ID/title/geometry. No GUI action was attempted. Delivered for user review.

## Task sidebar hierarchy — 2026-10-14

- Complete [drawer spec](DRAWER-SPEC.md) before implementation: grouped native Status/Edit/Archive, grip-only resizing and collapsed metadata/workspace.
- [x] Grouped public host Status selector/Edit/Archive, removed width controls and workspace action, primary Sessions and collapsed read-only metadata implemented. Shared measured-height motion and adjustable boundary grip retained; parent typecheck passed and detector returned no findings.
- [x] Full-access Luna: focused 8/8, corrected legacy 43/43, reduced-motion immediate-close 2/2, final typecheck PASS; the single full suite passed 72 / 48 renderer-only skipped before the bounded follow-up. Exact stale accordion completion and archived-project guard are covered; [chronology and limits](verification/drawer.md).
- [x] Reload/inventory enabled and running. Exact test session `5a68229e-51a2-4b3c-8d66-d20a373d5374` deleted (AGENT_NOT_FOUND); derived CLI context removed; all six recorded renderer paths and current scoped temp inventory absent. Source hashes match verifier evidence. Project/card counts remain 2/2; six normal test-session lifecycle events preserved, live read-state hash unchanged with no test-agent receipt.
- [ ] Actual desktop/compact appearance, host dropdown/keyboard/path wrapping and gesture/motion feel remain UNRUN: fresh CUA lacks window ID/title/geometry; no GUI interaction. Delivered for user review.

## Board feedback and navigation motion — 2026-10-14

- Complete [motion spec](MOTION-SPEC.md) written before code; AGENTS.md requires shared, interruptible motion and native toast feedback.
- [x] Native success toast, non-selectable lane text, shared motion/preference primitives, inert drawer exit, forward/Back session transition and direct-coordinate drag feedback implemented; parent typecheck passed and design detector returned no findings.
- [x] Independent full-access Luna: motion 8/8, legacy renderer 42/42, retained-preview exit fixture 10/10 and final typecheck PASS. One full suite passed 72 tests / 39 renderer-only skipped before the final exit case; chronology and unexercised criteria are in [verification](verification/motion.md).
- [x] Final plugin reload/inventory running. Exact testing session `363ff97e-8a55-491a-bdfe-34d9e73c934b` deleted, inspection AGENT_NOT_FOUND; derived CLI context removed and renderer paths absent. No project/workspace/card created; existing board remains two projects/two cards. Eight normal test-session lifecycle history entries preserved; live read-store hash unchanged with zero test-agent receipts.
- [ ] Actual desktop/compact motion, toast/selection/gesture feel and additional listed criteria remain UNRUN. Fresh CUA lacks native window ID/title/geometry; no GUI interaction. Delivered for user review.

## Native session chip — current request

- [x] Public 0.11.2 composer pill/screen params gate; complete [SESSION-CHIP-SPEC.md](SESSION-CHIP-SPEC.md) before implementation
- [x] Host-scoped paginated chip discovery/cleanup and fresh navigation validation; cold route validation, stale board-fetch cancellation and one-time card/sidebar/session entry. First typecheck passed
- [x] Full-access Luna 6: helper 7/7, new synthetic navigation 3/3, old regressions 30/30; complete suite 72 passed / 30 skipped and final typecheck passed
- [x] Final reload running; exact test session deleted, native inspection AGENT_NOT_FOUND; both renderer directories/current scoped temporary directories absent. Live read-store hash unchanged; standard test-session lifecycle history retained on the user card
- [ ] Real native chip/wide/compact focus: requires safely bound non-fullscreen Paseo window

Testing session `d380e718-8a0a-42a6-bc1e-cabe0ef8f483`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No test project/workspace/card or child was created. [Verification and limits](verification/session-chip.md). The development workspace is now linked to a user card; its four normal test-session lifecycle entries are retained as history. The board hash changed and is not reported as unchanged. Two existing user projects/cards and the read-store file were preserved. Delivered for user review; actual native chip/focus/wide/compact UI remain UNRUN.

## Task-card session attention — current request

- [x] Complete [SESSION-ATTENTION-SPEC.md](SESSION-ATTENTION-SPEC.md) before implementation: snapshot capability gate, counts/read semantics, separate daemon watermark store, validated RPC and failure/race/cleanup criteria
- [x] Implemented workspace-scoped session totals, run/finished/unread/attention counts, sidebar read state, explicit generation acknowledgement, and separate serialized daemon store; corrected workspace lifecycle check against the SDK and passed typecheck
- [x] Full-access Luna 6: focused 30/30 (10 logic/store/service, 4 new UI, 16 legacy UI), full suite 65 passed / 27 skipped, typecheck passed; additional error-read shared assertion rerun 5/5
- [x] Final reload running; exact testing session deleted and inspection returns AGENT_NOT_FOUND. Both renderer directories and all current-prefix test-store directories absent; board bytes/source hashes unchanged
- [ ] Actual wide/compact UI/native read flow: requires unambiguous non-fullscreen window targeting

Testing session `9ba46f22-fa8e-4925-95c0-5bcb1ea908d8`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No fixture native project/workspace/card or child was created. [Verification and UI limits](verification/session-attention.md). Delivered for user review; real desktop/compact rendering and native read/focus flow remain UNRUN.

## Session preview layout and tail — current correction

- [x] Updated [SESSION-UX-SPEC.md](SESSION-UX-SPEC.md) section 8 before implementation: native Markdown subset, fixed bottom composer, responsive metadata and follow-tail pause/resume
- [x] Implemented native Markdown rendering, fixed composer, wrapping metadata, follow-tail pause/resume and cancellable trailing subscription refresh; first typecheck passed and initial plugin reload running
- [x] Independent full-access Luna 6: combined focused checks 20/20; final full suite 55 passed / 23 renderer-only skipped; final typecheck passed. Timeline error/empty-state defect corrected; prior fixture collection failure fixed with test-only mock compatibility changes
- [x] Final reload running; exact test agent deleted and native inspection returns AGENT_NOT_FOUND. Both temporary renderer directories removed; board bytes and verified implementation hashes unchanged at closeout
- [ ] Actual desktop/phone rendering and keyboard/gesture checks: current CUA inventory has no window ID/title/geometry for the required non-fullscreen window

Testing session `1ea62ff1-6a08-4e88-bd17-1873cd76e53b`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No test project/workspace/card or child was created. [Verification and remaining UI limits](verification/session-layout.md). Delivered for user review; real rendering, keyboard positioning and gestures remain UNRUN.

## Session creation and preview — latest UI request

- [x] Native pane API gate first: installed 0.11.2 SDK has no embeddable Agent pane or draft/create navigation; public existing-session native navigation supported
- [x] Complete fallback contract: [SESSION-UX-SPEC.md](SESSION-UX-SPEC.md)
- [x] Creation host Modal with collapsed settings and existing MCP/skill/recovery flow; overview session cards with execution state; explicit preview Back/native actions
- [x] Per-session draft and in-flight operation isolation; live membership checks; preview-only observation and cleanup
- [x] First typecheck and 55 passed / 7 renderer-only skipped regression checks; plugin reload running
- [x] Full-access Luna 6: final focused component checks 7/7 and typecheck passed; temporary renderer removed and exact test agent deleted
- [x] Broad suite before the final mounted-ref StrictMode fix: 55 passed / 13 skipped. No broad rerun after that fix; the final focused suite covers StrictMode navigation and cancellation after Back
- [x] Final plugin reload/runtime running; cleanup inspection returns AGENT_NOT_FOUND and no test lifecycle events remain in the board
- [ ] Real Paseo UI/native focus/message delivery remain UNRUN: no unambiguous non-fullscreen window target

Testing session `18121ba1-252f-4a1c-93d7-2253918805ba`, `codex/gpt-6-luna`, created full-access in the existing development workspace and deleted at closeout. No fixture native project/workspace/card or child session was created. The existing board project/card and native resources were preserved. [API gate and verification](verification/session-pane.md). Delivered for user review; native focus and actual message delivery remain UNRUN.

## Whole-card drag amendment — latest UI request

- [x] Updated UI/UX spec: whole-card primary-mouse drag, independent Actions, card/preview text non-selectable
- [x] Implementation, typecheck and plugin reload running; native/compact vertical task list unchanged
- [x] Full-access Luna 6: focused checks 8/8, typecheck passed, full suite 50 passed / 7 renderer-only skipped. Temporary renderer removed; exact test agent deleted and native inspection confirms AGENT_NOT_FOUND

This supersedes the handle-only presentation below. Verification session `2fdbb024-4ddb-4793-bad5-d281470910ae`, `codex/gpt-6-luna`, created with `modeId=full-access` in the existing development workspace and deleted at closeout; no fixture native project/workspace/card created. Plugin is running; real desktop/phone gestures remain UNRUN. [Whole-card drag verification](verification/whole-card-drag.md). Delivered for user review.

## UI/UX refinement — 2026-10-14

- [x] Complete incremental contract: [UI-UX-SPEC.md](UI-UX-SPEC.md)
- [x] One-row toolbar with project management/filter menus; desktop columns and phone status chooser/vertical list
- [x] Status drag from a dedicated card handle, captured-revision writes, target feedback and horizontal edge scroll
- [x] Adjustable drawer grip and accessible width controls; bounded scrolling and wrapping choices/forms
- [x] First implementation typecheck, 49/49 regression checks, plugin reload running
- [x] Independent full-access Luna 6: 4/4 synthetic component checks; final normal suite 49 passed / 4 renderer-only skipped; final typecheck passed. Whole-card responder finding fixed by dedicated handle
- [ ] Live desktop/phone UI: current CUA inventory has no window identities/geometry, so the required non-fullscreen Paseo window cannot be bound. No Paseo UI action attempted

Testing session: `c8bfb6b3-40c8-40ec-8a0c-82a1909abe04`, `codex/gpt-6-luna`, created with `modeId=full-access` in the existing development workspace. Deleted after verification; exact native inspection now returns `AGENT_NOT_FOUND`. No fixture native project/workspace/card created. Renderer and current-run migration temporary directories removed; migration test now cleans each run automatically. Plugin remains running. [Verification and limits](verification/ui-ux.md). Implementation is delivered for user review; actual desktop/mobile gestures and live UI CAS rejection remain UNRUN.

2026-10-14 清理：此前验收留下的 11 个测试看板 project、22 张卡片、7 个托管 worktree、4 个验收 session 和隔离临时目录均已移除；对应原生 fixture project 在清理开始前已不在 Paseo 列表。插件恢复 running/ready，当前看板为空。今后的测试必须在结束时清理自身 fixture。[清理记录](verification/cleanup-20261014.md)。

## 2026-10-15 合并、自动进度 v1 与体验迭代

- [x] F1–F4 由 4 个只读 code-reviewer 审查，结论均为 MERGE WITH FIXES，已合入 main 并修复：F1 运行中 session 输出刷新节流（15s 窗口）与无障碍文案截断；F2 侧边栏复用看板查询缓存（15s）、attention token 模块级去重、单复数与热区；F3 菜单上/下移统一走 placeTask 单一排序路径；F4 intent 模块级去重且有效期 5s、picker 搜索框阻止快捷键
- [x] F1–F4 卡片经 Wrap up 真实收尾：worktree 已由 Paseo 移除，分支保留后已合并删除；收尾检查改为只报告“仅存在于该分支”的提交
- [x] 自动进度 v1（[AUTO-STATUS-SPEC](AUTO-STATUS-SPEC.md)）：只为看板管理 session 记录生命周期；规则 A1；question/静默标记；活动 Auto 标签；项目开关
- [x] 记住上次项目（host settings）、状态变化高亮、活动时间线降噪
- [x] Typecheck；`npm test` 142 passed / 63 skipped；只 reload 本插件；web 客户端：桌面/深色/420pt 手机渲染、收尾流程、项目记忆
- [ ] UNRUN：A1/question 在真实 agent 回合中的端到端触发；状态变化高亮的实际观感；原生 iOS/Android；Luna 验收
- [ ] 已知：绑定到仓库主 workspace 的卡片，其输出摘要会显示该 workspace 中普通对话的内容（摘要尚未区分看板管理 session）

## M2.5 多任务人工管理 — 2026-10-14

- [x] Spec: [MULTITASK-SPEC.md](MULTITASK-SPEC.md)（A 需要关注总览、B 一键开 session、D 手动收尾；C/E 不做）
- [x] AGENTS.md 增补显式 Wrap up 例外
- [x] 实现：`client/attention.ts`、`client/wrapup.tsx`、`server/wrapup.ts`、board/drawer/session-create 接入
- [x] Typecheck；`npm test` 96 passed / 56 skipped（新增 attention 3 项、wrapup 6 项，含真实 git 临时仓库）；只 reload 本插件
- [x] Web 客户端只读渲染：桌面与 420pt 手机的工具栏 Attention、空状态弹窗、卡片菜单 Start session、预填创建框（取消，未创建）
- [ ] UNRUN：Attention 有内容时的跳转（当前无待处理 session）；Wrap up 弹窗与真实归档（当前无 Done 卡片，未对用户资源执行）；原生 iOS/Android；Luna 验收（用户暂缓）

## UI refresh — 2026-10-14

- [x] Spec: [UI-REFRESH-SPEC.md](UI-REFRESH-SPEC.md) (native-blend direction, visual + IA changes, behavior parity)
- [x] Implementation: shared primitives/tokens (`client/ui.tsx`), status/priority glyphs (`client/status.tsx`), board toolbar and pickers, lanes, cards, drawer, session rows, session detail, forms
- [x] Typecheck; `npm test` 84 passed / 56 skipped; reloaded only `paseo-ultra-kanban`
- [x] Rendered check through a separate headless app.paseo.sh client connected to the local daemon (not the user's windows), read-only navigation only: desktop light/dark board, drawer, session detail, project/filter/action modals, card hover; 420 pt phone status chooser, list, drawer, session. No writes performed; no fixtures created.
- [x] Phone horizontal drift fix (spec §7a): vertical-only lists with clipped content width; compact status switch fades instead of sliding. Web 390 pt touch-emulated probe finds no horizontally overflowing scroller; not reproduced or verified on a native device (none connected)
- [x] Session composer keyboard inset and send button restyle (spec §7b); `keyboardOverlap` unit-tested (87 passed); web composer rendered empty/with draft. Native keyboard behavior not verified on a device
- [x] Android chip toast `Cannot read property 'id' of undefined`: chip action now only navigates; board validates (SESSION-CHIP-SPEC 2026-10-14 amendment). Step-prefixed errors. Chip fixture test updated to the new contract; 87 passed. Web compact chip flow re-run OK. Root cause on Android not confirmed (no device)
- [ ] Luna UI acceptance: deferred by the user's choice; user reviews in the real app first
- [ ] Not exercised live: drag/drop, resize grip drag, create/edit forms submission, session send/steer/interrupt, mark read, native iOS/Android

## Card write scope — research only, deferred — 2026-10-15

- [x] Research/design: [TASK-SCOPE-DESIGN.md](TASK-SCOPE-DESIGN.md) (Codex/Claude only; other providers unresearched)
- [ ] Implementation: deferred by the user; linked projects stay unrestricted for now

## Wrap up on Done/Cancelled — 2026-10-15

- [x] Spec: [MULTITASK-SPEC.md](MULTITASK-SPEC.md) supplement: moving a card into Done/Cancelled prompts "Wrap up this card?" (archives sessions/own workspace, keeps the card); setting *Auto wrap up* (default off) makes the daemon do it when the preflight is clean, recording skips
- [x] Typecheck, 238 tests (auto/keepCard/ownership cases in `server/wrapup.test.ts`), plugin reload
- [ ] Live move with a fixture card, prompt and settings UI check: unrun

## Remove project (board, optionally Paseo) — 2026-10-15

- [x] Spec: [PROJECT-REMOVE-SPEC.md](PROJECT-REMOVE-SPEC.md): one Remove entry (replaces Archive); the dialog chooses Keep in Paseo or Also remove from Paseo (native removal keeps all files; blocked while sessions run); board records backed up
- [x] Typecheck, 197 tests, reload, live UI removal of both kinds with fixture cleanup. [Verification](verification/project-remove.md)

## Desktop project tabs — 2026-10-15

- [x] Spec: [PROJECT-TABS-SPEC.md](PROJECT-TABS-SPEC.md): desktop header tabs for one-click project switching; returning to the board reopens the project last viewed in this app run, a cold start opens the first
- [x] Typecheck, tests, reload, headless web-client check of switch/leave/return/reload. [Verification](verification/project-tabs.md)

## Project directory picker and linked multi-repo projects — 2026-10-15

- [x] Spec: [PROJECT-PICKER-SPEC.md](PROJECT-PICKER-SPEC.md)
- [x] In-app folder browser (daemon-side listing) and system folder dialog (Finder/Explorer/zenity/kdialog on the Paseo computer)
- [x] "Multiple repositories" project source: new root under `plugin-data/.../projects/<name>` with one symlink per directory, registered as the native project; links editable on the project form
- [x] Typecheck, 187 tests, plugin reload, live RPC 12/12 with full fixture cleanup. [Verification](verification/project-picker.md)
- [ ] UI acceptance in the Paseo window and native-dialog end-to-end selection: unrun

## Single-root amendment — latest user decision

- [x] Complete amended contract: [SINGLE-ROOT-SPEC.md](SINGLE-ROOT-SPEC.md)
- [x] New project and card flows use one native Paseo project root; common parent directories are managed as native projects
- [x] Existing multi-repo cards keep their saved scope and workspace links as read-only legacy data; v3 board storage is preserved
- [x] Typecheck, 43/43 tests across 7 files, and skill validator pass
- [x] Reloaded only `paseo-ultra-kanban`; `board.json` SHA-256 stayed identical across reload
- [x] Full-access Luna 6 isolated non-UI acceptance: 13/13 resource checks in both corrected runs; native binding immutability; real `flowly_get_task` root scope and identity. [Verification report](verification/single-root.md)
- [ ] UI acceptance: CUA cannot distinguish the user's non-fullscreen Paseo window; no UI action was attempted

The prior Phase 1/2 multi-repo scope below is historical. UI acceptance remains constrained to the non-fullscreen Paseo window; CUA currently cannot enumerate macOS windows, so no UI action is allowed without unambiguous targeting.

## Phase 1 — Kanban and Paseo resources

Current scope: revised on 2026-10-13. Cards default to all project repos or explicitly select one/multiple repos; existing workspaces are linked by actual repo membership, preserving their native owners. Phase 1 delivery stops for user acceptance.

- [x] Accepted outline and project invariants
- [x] AGENTS.md constraints
- [x] Complete Phase 1 spec
- [x] Implementation (first pass)
- [x] Final Luna typecheck and 21/21 checks across 4 test files (20 implementation tests plus isolated migration verification)
- [x] Installed Paseo plugin; Luna 6 acceptance session launched
- [x] Actual wide UI, ownership, persistence and selected-session message acceptance
- [x] Revised repo-scope implementation, migration and existing cross-project workspace eligibility
- [x] Luna 6 revised core acceptance, controlled retry/negative cases, stale UI draft, move/reorder/filter and project repo edit guards
- [ ] Revised compact light/dark UI: externally blocked by CUA `cgWindowNotFound`/window-coordinate errors; System Events also denied assistive access. Old compact captures do not validate the revised UI.
- [x] Stopped for user acceptance; subsequent instructions authorized Phase 2 design, implementation and testing

Delivery: implementation is ready for the user's review in Paseo → Ultra Kanban. [Verification report](verification/phase-01.md) distinguishes the passing revised core from the unresolved compact capture boundary and the historical unattributed duplicate workspace observation. No daemon restart or resource deletion was performed.

## Phase 2 — Agent tools and skill

- [x] Revised complete Phase 2 design, aligned with optional multi-repo scope and preserved existing workspace ownership
- [x] User authorization: implement Phase 2 and perform complete testing
- [x] S0 preallocated agent identity, explicit full access and real provider MCP probe (Luna)
- [x] Tool/CLI/MCP and skill implementation; installed under the existing plugin ID
- [x] Typecheck, complete `npm test` (7 files/42 tests), skill validator; daemon RPC health and board v3 view
- [x] Luna 6 full-access, real MCP and existing-session CLI behavioral acceptance; scope, identity, concurrency, replay, reload and core negative cases
- [ ] Phase 2 UI acceptance: CUA on macOS cannot identify/bind the user's non-fullscreen Paseo window; no Paseo UI action was attempted
- [ ] Full live expiry/capacity/port-collision/v2-service migration scenarios; focused service/store tests pass, limits are recorded in the verification report

Phase 2 spec: [PHASE-02-SPEC.md](PHASE-02-SPEC.md). Three current-card tools; automatic MCP/skill for drawer-created sessions; explicit CLI/skill instructions for existing sessions; Agent delivers In review and human confirms Done. Task/project revisions protect live scope, progress notes preserve task revision, and persistent receipts prevent duplicate retry writes. Testing used full-access `codex/gpt-6-luna` sessions. The complete non-UI acceptance and remaining boundaries are in [verification report](verification/phase-02.md). Work stops for user review after this phase.

## Environment

- Plugin ID: `paseo-ultra-kanban`; existing `paseo-kanban` is a separate installation.
- Daemon/client compatibility target: Paseo 0.11.2.
- Global plugins are already enabled.
- Testing model discovered: `codex/gpt-6-luna`. No configured launch profiles.
- Phase 1 test session: `8c65c2a2-960b-4d0b-b9b8-782a8bc29029`, workspace `wks_1b4e2fc48dd38d30`.
- Luna integration finding: Paseo rejects literal `HEAD` as a worktree base. Default now resolves the selected source repo's named branch; blank-default and non-default branch live retests passed.
- Revised card session: `6c18d210-afa6-4b36-9550-60301a87767c`, `codex/gpt-6-luna`; actual writes in both repos under default scope and only repo-two after a scope edit were verified.
- Duplicate directory workspaces observed after stale CUA element actions are not yet attributed to product provisioning; preserve evidence and test controlled same-operation retries separately.
- Project-local npm registry is public npm; SDK 0.11.2 was missing from the mirror used by the first install attempt.

## 2026-10-19 Needs-you inline answers (card "提问框接入need you")

- Done: the card drawer's Needs-you area renders each live session's pending agent questions/approvals with the session view's form (`CardRequests`, SESSION-QUESTION-SPEC §2.1). Tour feature copy and README updated; the `agent-question` tip kept as is (user's choice). Board Attention menu and the board card itself stay unchanged (user's choice).
- PASS: typecheck, `npm test` (493 passed), plugin reloaded.
- PASS (live, user, 2026-10-19): a two-question AskUserQuestion (single select + multi select) answered by the user; the agent received both answers.
- PASS (live, user, 2026-10-19): tool approvals answered from the card drawer's Needs-you area with the session in Always Ask mode: Allow (create `/tmp/flowly-approval-test.txt`, ran) and Deny (delete it, agent received "Denied by user"); session switched back to bypassPermissions.
- UNRUN: phone layout, plan approval from the drawer, Luna 6 test session.

## 2026-10-19 Ideas card UI (card "ideas UI优化")

- Done: Ideas card actions are right-aligned at the standard button size (Not now, then Good idea at the far right). The card body is clamped with the same fade as Progress via the shared `client/clamped.tsx`: Show more / Show less in the bottom-left, the timestamp on the right. Progress swapped its toggle and timestamp to match. The tap-to-expand chevron is gone; three strings only it used were removed from all catalogs. Specs updated (IDEAS-SPEC §5.2, TASK-SUMMARY-SPEC §7). Onboarding: layout change only, no new tour copy or tip.
- PASS: typecheck, `npm test` (494 passed).
- PASS: `paseo plugin reload flowly` (status running, store ready, no errors in logs; 2026-10-19).
- UNRUN: visual check of the Ideas and Progress cards on desktop and compact (this session has no desktop-window control tool; the daemon serves no web client and react-native-web is not installed, so no screenshot was possible); Luna 6 session. Restore in the Closed group keeps the compact size.
- Follow-up (2026-10-19): the Ideas card's Show more and its two action buttons share one footer row (Show more left, Not now / Good idea right); the timestamp is back in the meta row; the Ideas page source line moved below that row. PASS: typecheck, `npm test`, plugin reload. UNRUN: visual check (no window-control tool).
- Follow-up (2026-10-19): the Progress card's style is now a shared resource, `client/content-card.tsx` (`ContentCard` surface + clamp + footer row, `CardBody`, `CardHeadline`, `CardText`, `CardField`, `CardMetaRow`/`CardMeta`, `CardFootnote`); Progress and Ideas both render through it (`client/clamped.tsx` removed). PASS: typecheck (also clean under --noUnusedLocals for the touched files), `npm test` (494), plugin reload. UNRUN: visual check.
- Follow-up (2026-10-19): Not now renamed Dismiss (button, accessible name `Dismiss {title}`, first-idea tip, tour line, README, specs; 3 strings re-keyed in all 9 catalogs). Desktop dismiss swipes the card out to the right with a fade (180 ms), then closes its slot (160 ms); phones keep the in-place collapse; Reduce Motion removes at once; restore mid-exit cancels it. PASS: typecheck, `npm test` (494), plugin reload. UNRUN: visual check of the swipe.
- Follow-up (2026-10-19): insert animation for Restore and newly arriving ideas: the slot opens (160 ms), then the card comes in (220 ms); on desktop a restored card slides in from the right, mirroring Dismiss; restored ideas animate even if they were listed at first render. PASS: typecheck, `npm test` (495), plugin reload. UNRUN: visual check.

## 2026-10-19 Subagents chip (card "side bar session关联subagent")

- Research: Paseo-native child agents (label `paseo.parent-agent-id`) are in the plugin SDK's agent list and open with `navigation.openAgent`. Provider subagents (Claude Task / Codex) are daemon-only (`listProviderSubagents`, not in `PaseoApi` 0.11.2/0.11.4) and plugins have no navigation target for them. The user chose native child agents only (option C).
- Done: a Subagents chip above the session view's message box (`client/subagents.tsx`, logic in `shared/subagents.ts`), styled like Paseo's composer pill: per-bucket segments (working / need input / failed / ready to review, else N subagents), an upward list, rows open the child in a Paseo agent pane. Reads the shared live agent list only. New one-time tip `subagents`; tour unchanged (not a headline capability). Spec: [SUBAGENTS-SPEC.md](SUBAGENTS-SPEC.md).
- PASS: typecheck, `npm test` (532 passed), `paseo plugin reload flowly` (running, store ready).
- PASS (data, live): a child created from this card's session (`6b58d4ff-1936-4302-83ed-5888480904ea`, claude haiku) carries the parent label; the daemon list returns it as idle / finished / requiresAttention, so the chip shows "1 ready to review".
- PASS (live, user, 2026-10-19): the user checked the Subagents chip in the side bar; the test child `6b58d4ff-…` was archived afterwards.
- UNRUN: compact (phone) layout; Luna 6 session.

## 2026-10-19 Phone performance (card "手机端性能优化")

- Done: board reads send only the events the phone does not hold yet (`board.read-changed` `since`/`delta`; 877 KB → 216 KB on this board's data); running agents' clock/usage ticks no longer replace the shared agent list (the board re-rendered ~2×/s whenever any agent on the host ran); per-card derived props are cached across board renders; the transcript's scroll callback is throttled to 100 ms. Details: [PERFORMANCE-SPEC](PERFORMANCE-SPEC.md) "Follow-up: phone sluggish again". Onboarding: no user-visible feature, so no tour copy or tip.
- PASS: typecheck, `npm test` (591 passed, 63 skipped), `paseo plugin reload flowly` (running, store ready).
- UNRUN: device smoothness on a phone (LAN and relay); live RPC byte count of the delta read; Luna 6 session.
- Follow-up (2026-10-19): the rest of the board (tasks, ideas, artifacts, workpads, projects, links, dismissals, plans) is patched too: the daemon remembers per-item hashes of the last 32 boards by etag and answers a held etag with only the changed items, removed IDs and new events (`server/board-delta.ts`, `applyBoardPatch`); events-only delta and the full board remain the fallbacks. PASS: typecheck, `npm test`, plugin reload. UNRUN: phone check; live byte count on the running daemon.
- Follow-up (2026-10-19): the phone's lane list is virtualized (host `FlatList`, `client/lane-list.tsx`, `client/lane-rows.ts`; off-screen cards mount nothing and read nothing) and a developer timing log was added (`performance.log` host setting; `board.render`, `board.read.*`, `board.apply`, `drawer.open.*`, printed by the daemon in the plugin log). PASS: typecheck, `npm test` (615 passed), plugin reload. UNRUN: device check of the list and real numbers. Onboarding: no user-visible feature.
- Cold start (2026-10-20): client bundle 2.12 MB -> 0.95 MB (UI-language catalogs are served by the daemon on demand, `i18n.catalog`; `LocaleRoot` waits up to 400 ms for the catalog); the session-chip poll's first round waits 2.5 s (was at plugin load); `plugin.load` / `catalog.load` added to the timing log; fixed the chip poll ignoring board patches (new `client/board-read.ts`). Details: [PERFORMANCE-SPEC](PERFORMANCE-SPEC.md) "cold start". Onboarding: no user-visible feature. UNRUN: device start-up time.

## 2026-10-20 Agent habits (card "Insights: next-move and idea rates per session and model")

- Done: Insights has an **Agent habits** block (`client/agent-habits.tsx`, counters in `shared/agent-habits.ts`, WORKFLOW-INSIGHTS-SPEC §12): per day for the last 7 days, per model and in total, the share of deliveries (in_review + result; questions listed apart) that came with next moves, ideas, explicit "none", and how many suggestions the user picked; a model or session with 0 next moves (or 0 ideas) over at least 10 deliveries is flagged. Pure rules over the flow log, so it works with Workflow insights off and costs no tokens. `agent.turn_ended` events now carry `model` and `pick` (written by the hook from the session snapshot and the turn's user message); flow entries carry `offered` / `offersDone`. `insights.project` returns `habits`.
- PASS: `npm run typecheck`; `npm test` (705 passed, 65 skipped); `paseo plugin reload flowly` (running, no errors); counters equal an independent hand count of a frozen flow log for five day/zone combinations (`docs/verification/agent-habits.md`).
- Correction to the card: its example numbers (10-19: 65 / 11, 10-20: 1 / 0) came from `board.json`, which keeps only the last 100 events per card. Flow log: 10-19 has 79 next-move events across all projects (57 in Flowly, rate 61% of delivery/result turns), 10-20 had 5 by 10:48 (8%).
- Onboarding upkeep: no welcome-tour change and no new tip. It is a diagnostics block, not a headline capability, and a new tip id would be shown once to every user. README (both languages) got one highlight paragraph.
- UNRUN: the block in a real desktop or compact window; a live `pick` and a live explicit `none` (NEXT-MOVES-SPEC §8 is another session's unfinished work); Luna 6 session.

## 2026-10-20 Delivery-time reminders (card "Delivery-time reminders for missing next moves and ideas, plus firmer skill wording")

- Done: a successful `flowly_update_status` (in_review, blocked) or `flowly_report_progress` (question, result) that leaves the session without next moves (an explicit `[]` counts) since its latest `agent.turn_started` on the card adds a `reminders` array right after the receipt; an in_review delivery also reminds when the session proposed no idea on the card and Ideas are on. Text only, the write already succeeded; failed writes, finished cards and Ideas-off stay quiet; a replay is judged on the board as it is now (NEXT-MOVES-SPEC §9, IDEAS-SPEC §4.1). The skill (both copies) now says every delivery, ask or result ends with next moves and every delivery reviews ideas, and explains `reminders`.
- Calls on the card: the ideas check reads `board.ideas`, not `idea_proposed` events (events keep only the last 100 per card); `moves: []` on the standalone tool, which the reminder text offers, came with the sibling next-moves card (96ac586).
- PASS: `npm run typecheck`; `npm test` (711 passed, 65 skipped), including MCP `structuredContent.reminders` through the output schema and the CLI's key order.
- PASS (live, 2026-10-20): five `codex/gpt-6-luna` full-access sessions on a temporary Tinylink card (`docs/verification/delivery-reminders.md`): `reminders` arrive over MCP and over the CLI; sessions allowed to act made the named call (`moves: []` over MCP, `next-moves` over CLI) and the second delivery no longer carried the next-moves reminder; an explicit `[]` on the delivery call also avoids it. Card, sessions and workspace cleaned up and checked in the board and the native registry.
- NOT SHOWN: that Luna acts on the reminder unprompted (S2, told to end its turn, did not; the ideas reminder led to no idea in 5 sessions); phone layout; non-English; `question`/`result` and replay live.
- Onboarding upkeep: no welcome-tour change and no new tip. Agent-facing change; users only see more suggestion chips and ideas, which the existing `next-move` and `first-idea` tips already introduce.

## GitHub CI/CD — 2026-10-21

- Implemented in an isolated branch from origin/main (5e53249), preserving the
  active checkout's unrelated changes. Contract: [CI-CD-SPEC](CI-CD-SPEC.md).
- CI on Node 22/24; stable CI gate; exact npm tarball install; generated shipped
  shrinkwrap, OIDC tag release, prerelease channel, retry integrity, release
  assets/checksums, weekly action updates, Makefile and [operations](CI-CD.md).
- PASS local: npm ci; typecheck; npm test (678 passed, 65 skipped); focused
  release guard tests (4); package extraction + declared install; actionlint.
- Remote runs, repository settings and independent Luna evidence are recorded
  in [verification/ci-cd.md](verification/ci-cd.md) when completed. No new npm
  version or actual publish is part of this setup's verification.
- Onboarding: contributor tooling only; no welcome-tour or one-time tip change.

## 2026-10-21 External items can be registered as outputs (card "外部条目（PR/MR 等）也能登记为 output")

- An agent's own pull/merge request can now be registered with `role=output`
  ([CONNECTORS-SPEC](CONNECTORS-SPEC.md) §3.1, [CARD-ARTIFACTS-SPEC](CARD-ARTIFACTS-SPEC.md) §2): the server no longer
  forces external items to `input`, and editing can change their role. Paste and the + menu picker still default to
  input.
- An agent re-adding an entry the user added with another role gets a `notice` in the tool result (kept in the receipt,
  so a replay returns it) instead of a silent no-op.
- Output items keep their live status; their unread follows new comments and reviews only (fingerprint
  `<content>~<discussion>`), so the agent's own pushes do not mark its PR unread. Inputs compare as before.
- Skill (both copies): "part of the task's requirements" is limited to inputs; own PR/MR goes in as output.
- Existing artifacts forced to input before this change are not migrated.
- Onboarding: bug fix of an agent-facing rule; no welcome-tour or one-time tip change.

## 2026-10-22 Memory / Ideas page motion (card "memory、ideas汇总区微调")
- Memory page and the drawer's Memory section: cards now collapse away when confirmed, dismissed, archived, restored or deleted and rise in where they arrive (same `useExitList` + `IdeaRow` as Ideas). The "Archived & dismissed" section and the Add memory editor open/close with `Collapse` (chevron turns); the edit form and the card fade in when swapped.
- Ideas page: Accepted / Dismissed rows collapse out on Restore; search and filter changes rebuild the closed list instead of animating each row.
- Checked: `npm run typecheck`, `npm test`. Not run: on-screen check in Paseo (desktop/compact, Reduce Motion), because this change reuses existing motion primitives and has no new logic to unit test.
- Onboarding: no new feature or tip; the change only adds motion to existing actions.
- Follow-up (same day, user feedback): the exit looked like a stall before sliding away because `useExitList` dropped the row for one commit and re-added it as leaving (list jumped, card remounted). The leaving rows are now added in the same render and every row keeps one wrapper (`RowOut`), so nothing remounts. The user preferred Memory's fade-and-collapse, so Ideas (page and drawer) and Memory share it: no desktop swipe-out, no slide-in on restore. Dismissing a memory candidate also leaves at once, before the save returns.
- Scan (same day): Links and Artifacts lists already shared `IdeaRow`, so they follow the new exit automatically. The Needs attention sheet (dismiss / restore a card) had no motion; its rows now use the same fade-and-collapse (`AttentionRows` in `client/board.tsx`). The Dismissed chevron in that sheet now turns like the other disclosures (`Chevron`), and the drawer's Closed ideas rows collapse out on Restore (and rise in when an idea is closed).
- Second scan (same day): disclosures that still opened and closed instantly now use `Collapse` and a turning chevron (`TurnChevron` in `client/ui.tsx`): the Progress card's earlier versions, the workpad check "Show output", the idea detail in the native chip popover, the agent activity block in the session transcript, and the chevron in `SectionHeader`. Not changed on purpose: the subagents chip (its tray already has its own presence) and the Show more / Show less toggle on content cards (its height already animates).

## 2026-10-22 Delivery constraints (card “流程约束不足”)

- Implemented [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md): `outputs` on In review/result atomically registers artifacts with the delivery, moves and receipt; omitted outputs remind, `[]` explicitly declares none. Persisted receipt IDs survive exact replay without revalidating missing files or private metadata. MCP, CLI and both skill copies agree.
- `acknowledgeOpen` now requires a prior refusal for the same session/card/workpad/HEAD. The first pre-acknowledged attempt still refuses; new turns clear the bounded ephemeral record through the lifecycle hook, independently of truncated board history.
- A real Sonnet run exposed private GitHub metadata lookup blocking an otherwise valid output URL. Fixed: ExternalError on an explicit valid http(s) output saves a plain URL with a notice; bare keys and programmer errors still refuse. No connection credentials or settings changed.
- PASS: focused checks (3 files / 59 tests), `npm run typecheck`, `npm test` (109 files / 932 tests), plugin reload. Verification directories are excluded from product TS/Vitest discovery so third-party research fixtures are preserved without entering product checks.
- Live PASS after the fix: fresh Sonnet and GPT sessions received only “创建 PR 并合入”, merged PR #3/#4, atomically registered the PR via outputs and delivered again. First-round private-metadata failures are retained. Evidence: [verification/delivery-constraints-2026-10-22.md](verification/delivery-constraints-2026-10-22.md). Four cards/worktrees and five test sessions are cleaned; remote fixture branches removed. UNRUN: deleting four local Tinylink test refs requires filesystem access outside the task root; sandbox refused and escalation did not complete. The user asked to retain the private GitHub repository and PR history for reuse.
- Onboarding: no new UI, setting or entry point; existing Inputs and outputs and Workpad guidance covers the behavior. No tour, tip or What's new change.

## 2026-10-22 Constraint benchmark（卡片“流程约束不足”）

- 实现 `benchmarks/constraints/` 的独立 grader 与 B01 quick `run / grade / cleanup`；补清只读 receipt 来源、nextMoves 主动/最终归属，保留 test 阶段与事实前置条件，不加 hooks。来源缺失/冲突不猜；独立 FAIL 不被 UNKNOWN 覆盖。
- 最终聚焦检查 PASS：54 主项 + 3 Luna 风险项 = 57。独立 Luna 验证了前一版本 56/56；GPT Astra 按用户指定完成实现审查并关闭阻塞。类型检查 PASS。工具/文档变更，无产品 reload/UI/onboarding 变更。
- 真实 quick：GPT 三回合、fixture PR #5 合入与 output 登记已观测；Sonnet weekly quota INVALID，双模型最终 UNKNOWN/exit 2，不能称全部通过。原始失败、补采及版本化重评保留；不重跑模型改成绩。
- 两次 quick 的专属资源与一次无模型 dirty-worktree 清理 smoke 均收尾通过，原有 Tinylink/旧 refs/私有仓库历史保留；审查/验证会话已归档。详见 [实现与验证报告](verification/constraint-benchmark-2026-10-22/implementation-report.md)。

## 2026-10-23 Benchmark scope 历史同步修正

- grader 1.0.1：每case启动会话前冻结fixture main，评分和清理共用scope图/路径/tree审计。已批准历史的原样导入可通过，额外新提交、dirty、模式变化、改后还原和merge resolution仍拒绝；缺证据UNKNOWN，不按任意最终父提交放行。
- 保存证据离线回归：77/77 PASS。独立重评只将GPT T3的scope误FAIL改为PASS，其他五回合成绩不变，整体仍FAIL/exit1。旧run 56个文件hash保持，未跑模型、未创建原生fixture、未改旧成绩；临时Git测试目录已清理。
- 未重跑新Luna/模型会话，遵循本次“不重跑模型”；复用保存的Luna风险用例。无产品API/UI改动，无需reload或onboarding更新。证据见 [scope修正报告](verification/constraint-benchmark-scope-2026-10-23/report.md)。


## 2026-10-23 Shared checklist wording — Fable整体复核后

- Spec先行：TURN-CHECKLIST-SPEC §2/§2.1明确现行阶段和整体交付/阶段汇报边界；只收紧shared/turn-checklist.ts第2/5项，并由既有skill-source生成仓库SKILL.md。另四项与详细规则逐字不变，6项/1583字符。
- PASS：离线3 files / 62 tests（skill-source、agent-service、tool-server）；规范/生成一致性与旧证据hash核对。保留旧benchmark原始/独立重评，不改评分。
- 未运行：B01、被测模型/审查会话、fixture/grader、全量测试、安装/reload、Git发布；未加hooks/改服务端行为/API/UI。仓库skill已生成，不宣称运行中的服务已加载新规则或模型遵守改善。无onboarding/tip/What's new改动。
- [本轮归属、检查与保留证据](verification/turn-checklist-wording-2026-10-23/report.md)。

2026-10-24：统一紧凑布局性能路径，保留独立Overview/CardDetail、fresh授权、连续动画与450ms交接；按可用宽度760分界，移除性能门控的平台特化，清理旧CardBoardContext/Proxy。见[统一规范](RESPONSIVE-PERFORMANCE-SPEC.md)、[两阶段读模型](NATIVE-OVERVIEW-SPEC.md)和[瘦身规范](CARD-QUERY-SLIM-SPEC.md)。验证结果见[交付记录](verification/responsive-ship-2026-10-24/README.md)。

## 2026-10-24 动画流畅度有限优化

先写[MOBILE-SMOOTHNESS-SPEC](MOBILE-SMOOTHNESS-SPEC.md)，同三星冻结源码对照点阵静止、共享lease候选及反向baseline。只让新点阵时钟复用高度lease，保留网格；独立mounted又复现反转中一次额外启停，v2仅用microtask复查既有guard消除，无新timer/状态/框架。连续220/160ms、fresh、450ms及宽度统一保持。最终收起26.13/28.21ms（原39.28/39.62），展开仍59.07/25.15ms，区段40–48ms、Idea125ms起终态未证实均保留，非整体FPS收益。41窗37有效/4排除，旧140capture/37窗Luna独立审计PASS，最终161capture/41窗父复算PASS；新增4窗独立审计UNRUN。此前共享dirty树V2 typecheck、Luna mounted8/root focused22/full125文件1024项PASS，374源hash稳定。正常插件重载与三星ready、owned入口/runtime/工具/会话清理PASS，17MiB压缩证据保留，其他会话工作/共享缓存保留；用户后续授权发运仅限本修复及规范，隔离树另行验收。详见[本轮记录](MOBILE-SMOOTHNESS-SPEC.md#6-执行结果与边界)。

## 2026-10-24 宽屏点阵连续性修正

连续开卡反复重放是全局高度让路后phase0恢复的可见代价。按MOBILE-SMOOTHNESS-SPEC §7仅在宿主窗口<760让装饰时钟让路；宽屏保留同一loop/phase，lease和resize通知不重启。只改motion.tsx，无新增缓存、timer、框架或RPC；fresh归属、连续220/160ms与450ms交接保持。既有三星局部收起约39→26–28ms，展开不稳定，无桌面/FPS收益结论。已有typecheck、Luna mounted11/11、focused5文件37项通过，首次旧文档断言失败留存；本地Flowly重载running，真实UI/FPS未运行。用户要求停止后续测试直接合入，未再跑候选全量或设备矩阵；仅选择本修复和规范按PR流程发运。无需tour/tip/What's new。证据保留于verification/marquee-width-2026-10-24。

## 2026-10-27 summary 不再生成：Paseo 0.13 的 turn_ended 不带 timeline

- 现象：Agent SMITH 的多张卡片没有 progress。数据：daemon 0.13.0 于 10-26 02:04Z 启动，之后全项目已完成回合里只有手动 Refresh 的 summary 写入（Flowly 10-26 为 1/77，10-27 为 0/18；SMITH 10-27 为 2/27）。
- 根因：Paseo 0.13 的 `publishAgentStream` 对 turn_completed/failed/canceled 一律发 `timeline: []`（SDK 类型仍声明该字段，所以编译无报错）。`SummaryService.enqueue` 对空文本直接返回，无错误记录。同一个空数组还影响 `byUser`/`pick`（Agent habits）、记忆线索、workpad 计划、外部会话 insights。
- 修复：`server/turn-timeline.ts` 在空时读 timeline 最新一页的最后一轮，`agent.turn_ended` 入口统一使用；`agent.turn_ended` 的 `byUser` 在 10-26 起的事件里被记成 false，未回填。



## Codex suggested speed — 2026-10-29

- Codex card-session suggestions now use Fast when no speed is remembered, including provider switches. Explicit Normal and other remembered tiers remain intact; unavailable tiers retain the existing normal fallback.
- No tour/tip or telemetry change: this adjusts the existing Speed control default, adding no capability, switch or counted action.

- Claude defaults to `auto` and Codex to `auto-review` when no permission mode is set; explicit and remembered modes win.

## Suggestions for custom Claude/Codex providers (card "improve model defaults in create task dialog") — 2026-10-30

- Bug: the Auto/Auto-review and Fast suggestions matched only the provider ids `claude` and `codex`, so switching the New task / New session picker to a custom provider (`claude-connected`, `claude-glm-fast`, `codex-connected`) left Permissions on Provider default and Speed on normal.
- Fix: `providerBase` (`shared/agent-defaults.ts`) recognises the base provider from the permission modes; `client/agent-choice.tsx` keeps an unchosen mode/speed as `undefined` and applies the base's suggestion once the modes are listed (submit waits for them). `startingAgent` no longer bakes suggestions in, so a model default on a custom provider gets them too. Explicit picks and remembered session settings still win.
- Live check after the plugin reload found a second bug: Codex's Fast tier is `priority` in the daemon (options default/priority/ultrafast), not `fast`, so the Fast suggestion never matched and every Codex provider, the built-in one too, opened at Normal. `suggestedSpeed` now picks `priority`, else `fast`, from the model's offered tiers.
- Follow-up request: reasoning now defaults to `xhigh` (Extra High) when the model offers it, for every provider (`suggestedThinking`; the picker keeps an unchosen reasoning as `undefined` like mode and speed). Models without it (GLM 5.3) keep their own default; explicit picks and remembered reasoning win. MODEL-DEFAULTS-SPEC "Reasoning default".
- No tour/tip, What's new or telemetry change: same Permissions/Speed/Reasoning rows with different starting values, now also for custom providers. No new strings.
- Checks on HEAD 4c077a0 plus the shared tree's uncommitted work: `npm run typecheck` exit 0; `npm test` 147 files, 1286 passed, 1 skipped. Live after `paseo plugin reload flowly`: `docs/verification/model-defaults-custom-providers.mjs` (headless, form cancelled) switched New task to Codex, Connected / Claude Code, Connected / Claude Code, GLM 5.3 / Codex / Claude and read Auto-review + Fast + xhigh, Auto mode + Extra High, Auto mode + Model default (High), Auto-review + Fast + xhigh, Auto mode + Extra High; no page errors. Evidence in `docs/verification/model-defaults-custom-providers/`.
