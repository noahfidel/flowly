# Latest agent output on task cards

Status: implementation authorized by Kanban card **F1 Show a summary of the latest agent output on the card**. Client-only increment; no RPC, board data, read-store or native resource contract changes. Single-root, session-attention and business-status contracts remain in force.

## 1. Observable behavior

- A task card shows one muted line under its title with the latest agent output of its workspace's most recently active session, followed by a relative time (`just now`, `5m ago`, …). The text is single-line, ellipsized by the layout; the relative time stays visible and does not shrink.
- **Session choice**: non-archived sessions whose `workspaceId` equals the card's workspace; the one with the greatest valid `updatedAt` wins (ties: greatest `lastUserMessageAt`, then `createdAt`, then ID for determinism). Sessions from other workspaces never contribute.
- **Text choice**: the newest timeline entry of type `assistant_message` with non-empty plain text. User messages, reasoning/thinking, tool calls, todos, errors, notifications and compaction entries are skipped. The relative time is that entry's `timestamp`.
- **Markdown removal**: headings, list markers/checkboxes, quotes, emphasis, inline code ticks, links (label kept, URL dropped), table pipes and rules are removed; fenced code is omitted unless the message contains nothing else, in which case its code text is used. Whitespace collapses into single spaces; text is bounded to 240 characters (`…` appended when cut) before layout truncation.
- **Quiet states**: no session, workspace unavailable, first load, fetch failure, `timeline` response error, or no assistant text in the fetched tail → no output line is rendered (no spinner, warning or placeholder). After a successful load the last summary of the *same* session stays visible while a newer version loads or if that refresh fails. A different chosen session never shows the previous session's text.
- **Accessibility**: when a summary is shown, the card's button label appends `Latest agent output <time>: <text>.` Existing hint unchanged.
- **Unchanged card behavior**: whole-card mouse drag (8 pt threshold, suppressed click after drag), press to open, Actions button, hover accent, non-selectable text (`selectable={false}`), session signal row, priority/legacy/archived badges. Desktop columns and compact phone list render the same line; no new touch target or gesture.

## 2. Data fetching contract

- The agent snapshot (0.11.2 `AgentSnapshotPayload`) has no assistant-text field (`title`, `lastError` and attention fields are not agent output), so a bounded tail fetch is used: `agents.ref(id).timeline.refetch({ direction: "tail", limit: 20, projection: "projected" })`, via the supplied `usePaseo()` SDK only.
- Query key `["flowly", "cardOutput", agentId, updatedAt]`, `staleTime: Infinity`, no polling interval, no retry, no focus/reconnect refetch. A new fetch happens only when the chosen session or its `updatedAt` changes (observed through the board's existing 5 s agent list). Shared cache: duplicate card renders reuse one request.
- Only mounted cards fetch: the current project, filters, shown desktop columns and the current compact status lane. Hidden lanes/filtered cards issue no requests. Unmounting cancels queued work through the query abort signal.
- A module-level limiter allows at most **3** concurrent tail fetches; extra work queues FIFO. Aborted queued work never starts; slots are released on success, failure or abort.
- No daemon persistence, no localStorage, no second Paseo connection, no subscription per card.

## 3. Architecture

- `client/card-output.ts`: pure helpers (`pickOutputSession`, `plainOutputText`, `latestAgentOutput`, `createLimiter`) plus the `useCardOutput` query hook.
- `client/card.tsx`: presentational `TaskCard` renders the line and accessibility text from an `output` prop; `LiveTaskCard` runs `useCardOutput` while mounted (only when the workspace is available) and passes the result.
- `client/board.tsx`: renders `LiveTaskCard` with `pickOutputSession` over the existing 5 s agent list.

## 4. Acceptance

Focused unit tests: session choice (workspace isolation, archived exclusion, recency, ties, none); text choice skipping user/reasoning/tool entries and empty assistant text; markdown stripping (inline, links, lists, headings, tables, code-only fallback, length bound); limiter concurrency bound, FIFO, release on failure, aborted-queued skip. `npm run typecheck` and `npm test` pass.

UNRUN unless separately authorized: installed plugin reload, real desktop/compact rendering, screen-reader output and live drag/press feel (per card instructions: no install/reload, no new Paseo resources).
