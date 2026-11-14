# Native session pane: Summary, Next moves, Ideas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flowly-managed sessions show their card's progress summary as a row in Paseo's own timeline, and get a **Next** chip and an **Ideas** chip next to Paseo's composer, so the native session pane matches Flowly's session view (P1 only).

**Architecture:** The daemon appends a `flowly-summary` plugin row to the session whose turn produced a new summary version (`paseo.agents.ref(id).timeline.append`). One client renderer draws it in Paseo's timeline, and Flowly's own session view draws the same component from `sessions.tail`. The two chips are added to the existing 5 s chip refresh in `client/session-link.ts`. Their popover contents read a module-level store that the refresh fills, and run their actions through the captured `PluginClientContext`.

**Tech Stack:** TypeScript, React Native (host-provided), zod, vitest, `@getpaseo/plugin` 0.11.2 (`addComposerPill` popover, `addTimelineRenderer`), `@getpaseo/client` (`timeline.append`).

**Spec:** `docs/NATIVE-SESSION-SPEC.md` (read it with this plan; section refs below are to it).

> **Amended 2026-10-20 after implementation:** the user decided Flowly's own session view shows no Progress card (spec §5.4). The tail passthrough (Task 1) and the Flowly-view rendering (Task 3) were removed; the timeline renderer stays. Also, the row kind is `flowly-summary`: Paseo only accepts `^[a-z][a-z0-9-]*$`.
> Then the user scoped the feature to the native session only (no change to Flowly's own behavior or look): the `native-session` tip and tour change (Task 7) and the shared × with Flowly's suggestion row (Task 4) were removed, and the row append runs in the background.
> Finally (after the prompt-suggestions reference) the Next chip and its popover (Tasks 4–5) were replaced by a `flowly-next-moves` timeline card (`server/next-move-rows.ts`, `client/next-move-card.tsx`, `client/web-composer.ts`, setting `native-session`); spec §6.

## Global Constraints

- Root code only in `index.client.tsx` / `index.server.ts`; other code in `client/`, `server/`, `shared/`. No DOM, no `localStorage`, no server imports in client code.
- Every user-visible string goes through `t()`/`tn()` and is added to all 9 catalogs in `shared/i18n/*.ts`. Agent-facing text and daemon errors stay English.
- Hermes: closures that run later must not capture `for` loop variables. Build buttons and press handlers in their own function call (as `chipButton` does).
- Chip `update()` only when the label, visibility or content signature changed (spec §8). No new polling or subscriptions.
- Plugin row: `id: "flowly-summary-<entryId>"`, `kind: "flowly-summary"`, `version: 1`, data `{taskId, workspaceId, entryId, state, target, recap, next, model, at}` (spec §5.2).
- Chip ids: `flowly-next`, `flowly-ideas`. Icons: `Sparkles`, `Lightbulb`. Labels: `Next · {n}` (or the single move's label when n=1), `Ideas · {n}`. Titles: `Suggested next steps`, `Ideas for this card`.
- Chips only on managed sessions (`sessions.managed`); the Task chip keeps its current behavior.
- Next moves are sent only after the user presses **Send** in the popover (user decision). Idea "Continue here" reuses `ideas.adopt` unchanged, with no editing (spec §7.3).
- Typecheck before install/reload; reload the plugin, never restart the daemon.

## Review Focus

1. The user sends a message in Paseo while the summarizer is still running. The row must not be appended after the new message (the newer `agent.turn_started` skips it). Tested in Task 2.
2. A move is picked after the suggestion went stale (a new turn started, or the card moved). The popover must refuse and refresh, never send. Tested in Task 5 (`sendMove` revalidation).
3. A session that is in a card's workspace but not managed must get no Next or Ideas chip. Tested in Task 4.
4. Plugin teardown during an in-flight chip refresh or popover action must leave no pill registered and no navigation afterwards. Tested in Task 4.
5. A malformed or foreign plugin row in the tail (another plugin's kind, a bad `data` shape) must render nothing and not throw. Tested in Tasks 1 and 3.

---

### Task 1: Summary row contract and tail passthrough

**Files:**
- Create: `shared/native-session.ts`
- Modify: `shared/session-tail.ts` (`tailItemSchema`, `slimTimeline`)
- Test: `shared/session-tail.test.ts`, `shared/summary.test.ts`

**Interfaces:**
- Produces:
  - `summaryRowKind = "flowly-summary"`, `summaryRowVersion = 1`
  - `summaryRowSchema` (zod: `taskId, workspaceId, entryId, state, target, recap, next, model, at`, all strings)
  - `type SummaryRowData`
  - `summaryRowId(entryId: string): string`, which returns `` `flowly-summary-${entryId}` ``
  - `summaryRow(entry: SummaryEntry, workspaceId: string): { type: "plugin"; id: string; kind: string; version: number; data: SummaryRowData }`
  - `tailItemSchema` gains optional `kind?: string`, `id?: string`, `data?: unknown`

- [ ] **Step 1: Write failing tests**
  - `session-tail.test.ts › keeps flowly-summary rows with kind, id and data`: input `{item:{type:"plugin", id:"flowly-summary-e1", kind:"flowly-summary", pluginId:"flowly", data:{state:"S"}}}` gives `item` equal to `{type:"plugin", id:"flowly-summary-e1", kind:"flowly-summary", data:{state:"S"}}`.
  - `› strips other plugin rows to their type`: kind `"probe"` gives `{type:"plugin"}`.
  - `summary.test.ts › turnText ignores plugin rows`: `turnText([{type:"assistant_message",text:"A"},{type:"plugin",kind:"flowly-summary",data:{}}])` gives `"Assistant: A"`.
- [ ] **Step 2: Run** `npx vitest run shared/session-tail.test.ts shared/summary.test.ts`. Expected: the two `session-tail` tests FAIL; `turnText` PASSES already (it locks current behavior).
- [ ] **Step 3: Implement** `shared/native-session.ts` and the `slimTimeline` branch (copy `kind`, `id` and `data` only when `type === "plugin" && kind === summaryRowKind`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Summary row contract; tail keeps flowly-summary rows"`.

### Task 2: Daemon appends the summary row

**Files:**
- Modify: `server/summaries.ts` (`Batch`, `enqueue`, `drain`, `run`, `refresh`)
- Modify: `index.server.ts:389-390` (pass the turn end time)
- Test: `server/summaries.test.ts`

**Interfaces:**
- Consumes: `summaryRow`, `summaryRowId` (Task 1).
- Produces: `SummaryService.enqueue(taskId, agentId, timeline, paseo, endedAt?: string)`, where `endedAt` defaults to `new Date().toISOString()`. `Batch` becomes `{ text; agentIds; endedAt }`; a merged batch takes the last batch's `endedAt`.

- [ ] **Step 1: Write failing tests** (extend the fake `paseo` with `agents.ref(id) → { refresh: async () => ({ agent: { id, archivedAt } }), timeline: { append: vi.fn() } }`):
  - `appends one flowly-summary row to the last session of the batch after a new version`: after enqueue plus a reply with `update:true`, `append` is called once on agent `"a1"` with `summaryRow(entry, "w")`.
  - `does not append on update=false, a failed run, or a parse error`.
  - `skips the row when that session started a newer turn`: push board event `{action:"agent.turn_started", agentId:"a1", at: later than endedAt}` before the run ends. Expect no `append`, and the entry is still stored.
  - `skips the row for an archived session`: `refresh` returns `archivedAt` set.
  - `an append failure keeps the stored version and records no summary error`.
  - `manual refresh appends to the chosen session`, using `endedAt` = the last tail entry's timestamp.
- [ ] **Step 2: Run** `npx vitest run server/summaries.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `run` returns the created entry (or `null`).
  - `drain` then calls a private `appendRow(taskId, batch, entry, paseo)`, which:
    1. reads the board;
    2. skips if any event has `agentId === last && action === "agent.turn_started" && at > batch.endedAt`;
    3. skips if `refresh()` shows the session missing or archived;
    4. calls `timeline.append(summaryRow(entry, task.workspaceId))`.
  - On error it logs `console.error("Flowly summary row not added:", message)`, without the content.
  - In `index.server.ts`, pass `new Date().toISOString()` captured at the top of the `turn_ended` handler.
- [ ] **Step 4: Run** the tests. Expected: PASS. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `git commit -m "Summary versions appear as a row in the session's native timeline"`.

### Task 3: Summary row component, native renderer, Flowly session view

**Files:**
- Create: `client/summary-row.tsx`
- Modify: `client/task-progress.tsx` (move `SummaryBody` out and import it from `summary-row.tsx`)
- Modify: `client/session-state.ts` (`recentSessionOutput`: emit summary entries)
- Modify: `client/session-preview.tsx:1280-1292` (render them)
- Modify: `index.client.tsx` (`client.addTimelineRenderer`)
- Test: `client/session-state.test.ts`

**Interfaces:**
- Consumes: `summaryRowSchema`, `SummaryRowData` (Task 1); `ContentCard`, `CardFootnote` (`client/content-card.tsx`); `modelLabel` (`shared/summary.ts`); `Theme` (`client/ui.tsx`).
- Produces:
  - `SummaryBody({entry})`, exported from `client/summary-row.tsx`
  - `SummaryRow({ data, onOpenCard }: { data: SummaryRowData; onOpenCard?: () => void })`
  - `NativeSummaryItem(props: PluginTimelineItemProps<SummaryRowData>)`, which wraps `Theme.Provider` with `props.theme` and wires "Open card" through `openCardFromRow(data, agentId)` (Task 4)
  - `OutputEntry` gains `summary?: SummaryRowData`; such an entry has `kind: "flowly-summary"`, `author: "Agent"` and `text: ""`

- [ ] **Step 1: Write failing tests** in `session-state.test.ts`:
  - `recentSessionOutput turns a flowly-summary tail row into a summary entry`: the result has `kind: "flowly-summary"` and `summary.state === "S"`.
  - `drops a flowly-summary row whose data fails the schema`.
  - `groupTranscript keeps a summary entry as its own block between activity blocks`.
- [ ] **Step 2: Run** `npx vitest run client/session-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `recentSessionOutput`, before the text filter, handle `item.type === "plugin" && item.kind === summaryRowKind` with `summaryRowSchema.safeParse(item.data)`. `SummaryRow` copies the spec §5.3 look:
  - `ContentCard` with header label `t("Progress")`;
  - `SummaryBody`;
  - footer `Updated {time} · {model}`;
  - quiet button `t("Open card")` when `onOpenCard` is given.
  
  `TranscriptEntry`'s parent renders `<SummaryRow data={entry.summary} />` for that kind. Register the renderer in `index.client.tsx`: `client.addTimelineRenderer({ kind: summaryRowKind, version: summaryRowVersion, schema: summaryRowSchema, Component: NativeSummaryItem })`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `git commit -m "Render the summary row in Paseo's timeline and in Flowly's session view"`.

### Task 4: Chip rules, store and registration

**Files:**
- Modify: `shared/next-moves.ts` (add `chipMoves`)
- Create: `client/hidden-moves.ts`
- Create: `client/native-chips.ts`
- Modify: `client/session-link.ts` (`registerSessionChips`)
- Modify: `client/session-preview.tsx:539-565` (use `hidden-moves` instead of `useState`)
- Test: `shared/next-moves.test.ts`, `client/session-chips.test.ts`

**Interfaces:**
- Produces:
  - `chipMoves(input: { events: readonly BoardEvent[]; agent: Pick<PaseoAgent,"id"|"status"|"pendingPermissions"|"attentionReason"|"lastUserMessageAt"|"archivedAt">; cardFinished: boolean; hidden: (eventId: string) => boolean }): { eventId: string; moves: NextMove[] } | null`. It applies spec §6.1: `openNextMoves`, then not running/initializing, no pending permission (`pendingPermissions?.length` or `attentionReason === "permission"`), `lastUserMessageAt` not after the event, not hidden, then `shownMoves`. It returns null when the result is empty.
  - `client/hidden-moves.ts`: `hideMoves(eventId)`, `movesHidden(eventId): boolean`, `useMovesHidden(eventId): boolean` (via `useSyncExternalStore`). In-memory and shared.
  - `client/native-chips.ts`:
    - `type ChipState = { task: Task; project: Project; agentId: string; moves: { eventId: string; moves: NextMove[] } | null; ideas: Idea[] }`
    - `setChipState(agentId, state | null)`, `useChipState(agentId): ChipState | null`
    - `setChipClient(client | null)`, `chipClient(): PluginClientContext | null`
    - `openCardFromRow(data: SummaryRowData, agentId: string): void`, which calls `chipClient()?.openScreen({screenId:"board", params:{taskId, workspaceId, sessionId: agentId, requestId}})`
  - `registerSessionChips` also:
    - reads `managedSessions` when the board changed (keeping the last list otherwise);
    - for each managed, live (not archived) actor of a non-archived card: computes `chipMoves` and the open ideas (`board.ideas.filter(i => i.taskId === task.id && i.status === "open")`, newest first);
    - stores them with `setChipState`;
    - adds, updates or removes the `flowly-next` and `flowly-ideas` pills (`behavior: {kind:"popover", Content}` from Task 5);
    - on cleanup, removes all of them and calls `setChipState(…, null)` and `setChipClient(null)`.

- [ ] **Step 1: Write failing tests.**
  - `next-moves.test.ts › chipMoves`: hidden while running, initializing, with a pending permission, after a newer `lastUserMessageAt`, when hidden, on an explicit empty list, and after a newer turn; drops `moveTo` moves on a finished card.
  - `session-chips.test.ts`: the fake `client.rpc` dispatches on `def.name` (`board.read-changed` and `sessions.managed`).
    - `managed session with open moves gets a Next pill labeled "Next · 2"; unmanaged session in the same workspace gets none`.
    - `Ideas pill shows the open idea count and goes away at 0`.
    - `pills update only when label or content signature changes`.
    - `stop() during an in-flight refresh registers nothing afterwards`.
    - Existing tests keep passing, with the same Task chip counts.
- [ ] **Step 2: Run** `npx vitest run shared/next-moves.test.ts client/session-chips.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above. Build each pill's button in its own function (`nextButton(agentId, state)`, `ideasButton(agentId, state)`). The content signature is `eventId` plus the move labels for Next, and the sorted idea ids plus `updatedAt` for Ideas.
- [ ] **Step 4: Run** the tests. Expected: PASS. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `git commit -m "Next and Ideas chips on Flowly-managed sessions in Paseo's session view"`.

### Task 5: Popovers and their actions

**Files:**
- Create: `client/native-popovers.tsx`
- Create: `client/native-actions.ts`
- Test: `client/native-actions.test.ts`

**Interfaces:**
- Consumes: `useChipState`, `chipClient`, `hideMoves` (Task 4); `sendCardInstruction` (`client/session.ts:60`); `rpc.taskContext`, `rpc.updateTask`, `rpc.wrapupCheck`, `rpc.wrapup`, `rpc.adoptIdea`, `rpc.updateIdea`, `rpc.readBoard`; `wrapupSettings` (host settings).
- Produces:
  - `NextMovesPopover(props: PluginButtonContentProps)` and `IdeasPopover(props: PluginButtonContentProps)`, both wrapped in `Theme.Provider`.
  - In `client/native-actions.ts` (pure over an injected `client`, so they can be tested):
    - `sendMove(client, { taskId, agentId, eventId, text }): Promise<void>`. It re-reads the board (`rpc.readBoard`) and throws `t("This suggestion is no longer current.")` unless `openNextMoves(board.events, agentId)?.id === eventId`. Then it calls `sendCardInstruction(...)` with exactly `text`.
    - `moveToDone(client, { taskId }): Promise<{ askWrapup: boolean }>`. It uses `updateTask({id, revision, status:"done"})` with the fresh revision, and returns `askWrapup = !autoWrapup`.
    - `wrapupNow(client, { taskId }): Promise<"done" | "needs-flowly">`. It returns `"needs-flowly"` when `wrapupCheck` reports blockers or warnings; otherwise it calls `wrapup({id, revision, acknowledgeWarnings:false, keepCard:true})`.
    - `continueIdea(client, { ideaId, agentId })`: `adoptIdea({id, agentId})` after checking that the idea is still `open`.
    - `dismissIdea(client, { ideaId })`: `updateIdea({id, status:"dismissed"})`.
    - `newCardFromIdea(client, { ideaId })`: `openScreen({screenId:"board", params:{ideaId, requestId}})`.
- Popover copy:
  - Next: per move, a row with its label. Picking a message move expands a `TextBox` seeded with `prompt` (remounted per move, never fed back through `value`), plus **Send** and **Cancel**, and the hint `t("Sends this text as your next message.")`. An action move shows `Check` and moves the card, then shows the wrap-up question `t("Wrap up this card?")` with **Wrap up** / **Open in Flowly** / **Not now** per `wrapupNow`. At the bottom, **Dismiss** calls `hideMoves(eventId)` and `close()`.
  - Ideas: per idea, title, `AiMark` and the scope hint; tapping expands detail and rationale. Actions: **Continue here** (with confirmation `t("Sends this idea to this session.")`), **New card** and **Dismiss**. A finished or archived card offers only New card and Dismiss.
  - Success uses native toasts: `Sent`, `Moved to Done`, `Idea sent`, `Idea dismissed`. Errors show inline in the popover, keeping the input.

- [ ] **Step 1: Write failing tests** in `native-actions.test.ts`, with a fake client whose `rpc` dispatches on `def.name` and a fake `paseo.agents.ref().send`:
  - `sendMove refuses a stale suggestion and sends nothing`;
  - `sendMove sends exactly the edited text`;
  - `moveToDone uses the fresh revision`;
  - `wrapupNow returns needs-flowly on warnings`;
  - `continueIdea refuses a dismissed idea`.
- [ ] **Step 2: Run** `npx vitest run client/native-actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `native-actions.ts`, then the two popover components.
- [ ] **Step 4: Run** the tests. Expected: PASS. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `git commit -m "Next and Ideas popovers: edit-then-send moves, move to Done, idea actions"`.

### Task 6: Board opens the new-card form from an idea link

**Files:**
- Modify: `client/session-link.ts` (add `parseIdeaLink`)
- Modify: `client/board.tsx:209-235` and near `createFromIdea` (`:843`)
- Test: `client/session-chips.test.ts` (parser cases)

**Interfaces:**
- Produces: `parseIdeaLink(params?: PluginScreenParams): { ideaId: string; requestId: string } | null`. It returns null when neither key is present, and throws `t("Invalid idea link. Open it again from the Ideas chip.")` when the params are partial or malformed.

- [ ] **Step 1: Write failing tests**: absent gives null; valid gives the object; only `ideaId` throws.
- [ ] **Step 2: Run** `npx vitest run client/session-chips.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `BoardScreen`, once the board has loaded, apply each `requestId` once (`appliedIdea` ref): find the idea and require `status === "open"`, else `setError(t("This idea is no longer open."))`; then `setProject(card.projectId)` and `createFromIdea(idea)`. Never substitute another idea.
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS and no errors.
- [ ] **Step 5: Commit** `git commit -m "Ideas chip New card opens Flowly's prefilled form"`.

### Task 7: Copy, onboarding, docs

**Files:**
- Modify: `shared/i18n/*.ts` (every new string)
- Modify: `client/onboarding-logic.ts` (`tipIds` adds `"native-session"`, a new fact `nativeChips` = `nextMove || openIdea` on a managed session, order right after `"next-move"`)
- Modify: `client/board.tsx` (`tipText["native-session"]`, the fact)
- Modify: `client/onboarding.tsx` (the "Suggested next steps" feature line adds "also in Paseo's session view")
- Modify: `README.md`, `docs/ONBOARDING-SPEC.md` (tip table), `docs/SPEC-OUTLINE.md`, `docs/PROGRESS.md`
- Test: `client/onboarding-logic.test.ts`

- [ ] **Step 1: Write a failing test**: `native-session tip follows next-move and shows once`.
- [ ] **Step 2: Run** `npx vitest run client/onboarding-logic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tip text (spec §9): `"Next steps, ideas and progress now also appear in Paseo's own session view."`. Translate it and every string from Tasks 3, 5 and 6 into all catalogs.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the i18n catalog check.
- [ ] **Step 5: Commit** `git commit -m "Native session: copy, tip, onboarding and docs"`.

### Task 8: Verify and install

- [ ] **Step 1:** `npm run typecheck && npm test`. Expected: both pass. Record the counts in the workpad.
- [ ] **Step 2:** `paseo plugin reload flowly` (the installed `flowly` points at the main checkout; to test this branch, ask the user before re-pointing it with `paseo plugin install "$PWD" --id flowly`). Expected: `paseo plugin logs flowly` shows "Plugin ready" and no errors.
- [ ] **Step 3:** Run a full-access `codex/gpt-6-luna` test session against the Tinylink fixture (AGENTS.md rules: record IDs first, clean up only what it created). It checks every item in spec §10 "Manual / Luna", plus §5.5 #1/#2 on the real implementation. Evidence goes in `docs/verification/native-session.md`.
- [ ] **Step 4: Commit** the evidence: `git commit -m "Native session: verification evidence"`.
