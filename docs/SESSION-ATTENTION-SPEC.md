# Session counts and review state on task cards

Status: implementation authorized by the user's request to show session completion, running and unread counts on Kanban cards. This adds session review metadata to the current session UI; the single-root and Phase 2 business-status contracts remain in force.

## 1. Capability and scope

Installed SDK 0.11.2 exposes `requiresAttention`, `attentionReason` and `attentionTimestamp` on agent snapshots. The native app uses that flag for attention/read acknowledgement. Its low-level client has `clearAgentAttention`, but the public plugin `PaseoApi` / agent handle does not expose it. The plugin uses snapshot state and its own explicit read watermark; it never imports the private native client, opens another connection or pretends to clear native attention.

Native session reads (flag becomes false) take effect on the board's next agent refresh. A plugin **Mark as read** acknowledges only the exact attention generation presented to the user. This plugin acknowledgement is daemon-persisted and shared between plugin clients; it does not clear a badge in Paseo's native pane. No task, project, workspace, native ownership or tool credential migration.

## 2. Counts and attention semantics

- Count each non-archived session in the task's actual workspace once. Archived/deleted sessions and other workspaces do not contribute. Counts represent sessions, not unread messages or completed tasks.
- **Running**: current status running. **Starting**: initializing, shown separately when nonzero.
- **Finished**: idle session with a current finished attention signal or latest persisted turn-ended evidence not superseded by a newer prompt/turn start. This means a turn ended, not task completion or verified success. Error/closed/running/initializing are not finished.
- **Unread**: native `requiresAttention=true` without a matching plugin read watermark for its current attention reason/timestamp. Native `false` is authoritative read state. A native attention flag with missing/invalid timestamp stays unread and cannot be acknowledged by guessing a generation; use the native pane in that compatibility case. Absence of the native flag means unknown read state, not an invented unread generation.
- **Needs attention**: unique union of unread sessions, unresolved permission requests and actual error sessions. Reading an error or approval notice does not resolve it. Counts can overlap (for example running and waiting for approval); the attention count never double-counts a session.
- A new attention timestamp/reason after an acknowledgement becomes unread again. Starting another turn removes a prior finished appearance. Card business status remains independent; no automatic Done or In review transitions.

## 3. UI and refresh

- Task cards retain their existing title/priority/Actions and whole-card mouse drag. Add compact wrapping session summaries: total, running, finished, and starting when present. Unread and needs-attention counts form a prominent theme-aware row; affected cards are visually accented. Zero/unavailable/loading states must be distinguishable.
- Session fetch and review-store fetch failures show unavailable/stale state rather than zero unread or an all-clear appearance. Keep the last known counts only when both cached inputs exist, explicitly labelled stale. Normal polling refreshes within five seconds; marking read refreshes the shared metadata query immediately.
- Task sidebar session cards also show Unread / Needs attention so users can identify which session to open. Merely opening a task does not acknowledge all of its sessions.
- Session preview shows the selected session's read/attention state (*Unread* after the title while unread; read-state errors as notices, DRAWER-SPEC ruling 2026-11-09) and an explicit **Mark as read** action. Selecting/opening/background-rendering a preview alone does not clear anything. The action is disabled while current membership or the review store is unavailable, during an operation, and for archived/unavailable tasks or sessions. Errors preserve unread state and explain refresh/retry. Success acknowledges only that session; Back and native navigation keep existing semantics.
- Native pane reads are observed normally via snapshots. The fixed composer, Markdown rendering and follow-tail behavior remain intact.
- Read state syncs to Paseo (user-requested): after **Mark as read** commits its receipt, the daemon clears that session's native attention (`clear_agent_attention`, what reading it in Paseo does), so Paseo shows it read too. A failed clear keeps the receipt, logs the error and does not fail the action. On plugin start (one retry after 30 s if the daemon is unreachable) every receipt whose token is still the session's current native attention, for a live session in the receipt's workspace, is cleared in Paseo; this also fixes sessions read before the sync existed. **Mark as unread** stays plugin-local: Paseo has no unread write. Until the SDK exposes attention clearing, `server/session-reads.ts` uses the short-lived local connection in `server/local-daemon.ts` (shared with workspace restore).
- All card text remains non-selectable. No new card gesture target or bulk-read action; compact cards wrap vertically and do not gain horizontal scrolling.

## 4. Data and RPC

Daemon file `session-reads.json`, separate from unchanged v3 `board.json`:

```
{ version: 1, receipts: [{ taskId, workspaceId, agentId, token, readAt }] }
```

`token` is a deterministic JSON encoding of the agent ID, current native attention reason and valid attention timestamp. It is an event identity, not a credential. One latest watermark per task/workspace/session key; bounded to 10,000 records. Duplicate keys/invalid JSON/schema/version are errors and preserve the original file. Missing file is an empty valid state. Never silently reset, evict existing receipts or write client-side localStorage.

RPC `sessions.read-state` returns the validated receipt list. RPC `sessions.mark-read` accepts `{taskId, agentId, token}` and returns the committed receipt. Inside a serialized write, re-read the task, verify it/project are not archived, refresh the selected native agent and workspace, require actual workspace ID equality and an active workspace, and compare the expected token with current native attention. Errors: missing task/project/session/workspace, outside workspace, archived/inactive, unknown read generation, stale attention, capacity or invalid saved data. No acknowledgement on validation failure.

Workspace `status` describes aggregate execution (`running`, `attention`, `needs_input`, `failed`, `done`), not lifecycle activation. All these statuses can be acknowledged; the workspace must exist and must not have `archivingAt` set. A finalized archived workspace is unavailable through normal refresh.

An identical already-recorded token is idempotent and preserves bytes/readAt; still validate resource membership. Stale retries cannot overwrite a newer watermark. Concurrent calls serialize; acknowledge the supplied generation only, so a later completion can never be marked read by an older request. Atomic temporary-file replacement and backup protect writes. Reads wait for pending writes. No board/task/project revision or activity changes for a read acknowledgement.

## 5. Architecture

- `shared/session-attention.ts`: schemas, attention identity and pure workspace aggregation; no runtime-specific imports.
- `server/session-reads.ts`: serialized atomic watermark persistence and SDK membership validation.
- `shared/rpc.ts` / `index.server.ts`: validated RPC contracts and thin registration.
- `client/session-reads.ts`: shared host-scoped query and acknowledgement action using the supplied SDK/RPC connection.
- `client/board.tsx`, `card.tsx`, `drawer.tsx`, `session-card.tsx`, `session-preview.tsx`: summaries and targeted acknowledgement; no second native connection or private SDK import.

## 6. Acceptance and cleanup

Use one new Paseo `codex/gpt-6-luna` session, full-access at creation, in the existing development workspace. It owns tests/evidence, shares the codebase and must not edit implementation. No fixture native project/workspace/card or child is needed: use temporary stores and fake SDK actors for race/ownership checks, and synthetic RN components for UI callbacks. Delete the exact test session and all temporary dependencies/directories at closeout.

Focused cases: mixed session states and unique attention union; workspace isolation and archived exclusion; native false/read override; exact watermark/new attention/stale token; invalid/missing generation; finished vs newer prompt/start/error; unread fetch failure/loading; card badge/drag/text preservation; selected-session acknowledgement and errors; native reads reflected by refresh; serialized concurrent and idempotent writes; old retry/new generation; metadata persistence across store recreation; invalid-store preservation; no board bytes/revisions changed. Re-run typecheck before plugin reload and run one complete test suite after source stabilizes. Save PASS/FAIL/UNRUN and evidence under `docs/verification/session-attention.md` and its fixtures.

Actual wide/compact rendering, gestures and native focus/read flow require a safely identified non-fullscreen Paseo window. If CUA still cannot bind its ID/title/geometry, do not touch either window and record UI UNRUN. Runtime running does not establish UI acceptance. Stop for user review after delivery.

## Subagents and attention (user decision 2026-10-20)

A Paseo subagent (`paseo.parent-agent-id`) is managed by its main agent, so its unseen finished turn never counts as unread: it adds nothing to Needs attention, the bell, the sidebar badge or the card's unread signal (`sessionAttention` in `shared/session-attention.ts`). Its approvals, questions and errors still need the user, and a manual *Mark as unread* still counts. The side bar's subagent row and the Subagents chip still show `ready to review` as information.
