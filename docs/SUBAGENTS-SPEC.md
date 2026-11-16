# Subagents chip in the session view

Card: "Link subagents to sessions in the sidebar" (2026-10-19). Scope chosen by the user: **option C**, Paseo-native child agents only.

## 1. Goal

When a session started subagents, the side bar's session view shows a **Subagents** chip above the message box, styled like the Paseo session pane's own Subagents pill. The chip shows the subagents' state at a glance; clicking it opens the list; clicking a row opens that agent in the side bar when it is one of this card's sessions, else in a Paseo agent pane.

## 2. What counts as a subagent

A **Paseo-native child agent**: a live, non-archived agent whose label `paseo.parent-agent-id` equals the session's agent id (Paseo's `PARENT_AGENT_ID_LABEL`, the same field as `PluginAgentSnapshot.parentAgentId`). Paseo sets the label when an agent creates another through Paseo (`create_agent`, delegation). The child may live in any workspace.

Also a **provider subagent** (Claude Code Agent/Task tool, Codex subagents): not a Paseo agent but a subagent the provider runs inside the session, which the daemon tracks per parent session. Added 2026-11-16 (user-approved local-daemon exception); see §9. Until then the 2026-10-19 decision was native children only.

## 3. Data

- Source: the shared live agent list (`useLiveAgents({ poll: false, select })`, PERFORMANCE-SPEC §3). No new polling, RPC or daemon call. Archived agents are not in that list, so archived children disappear.
- Children are sorted by `createdAt` (oldest first, as in Paseo).
- Each child gets a bucket (`shared/subagents.ts`, the same buckets Paseo uses for its pill):

| Bucket | Condition (first match) |
| --- | --- |
| `needs_input` | pending permissions, or attention reason `permission` |
| `failed` | status `error`, or attention reason `error` |
| `running` | status `running` or `initializing` |
| `attention` | requires attention with reason `finished` (ready to review) |
| `done` | anything else (idle, closed) |

## 4. Chip

- Placement: a row directly above the message box (inside the composer area, below next moves and pending requests, above queued messages). Hidden when the session has no live children; hidden for archived sessions.
- Style (aligned with Paseo's composer pill): min height 32, horizontal padding 12, vertical padding 4, radius 16, 1 px border (`border`), background `surface1`, `surface2` on hover/press/open; label `font.sm`, `foregroundMuted`, `foreground` while open.
- Content: one segment per non-empty bucket in the order running, needs_input, failed, attention. Running shows a pulsing dot (accent); needs input a 6 px warning dot; failed a danger dot; ready to review a success dot. Texts: `{n} working`, `1 needs input` / `{n} need input`, `{n} failed`, `{n} ready to review`. The total (`1 subagent` / `{n} subagents`) always leads, also while children run or wait (user request 2026-10-20), e.g. `3 subagents · 2 working, 1 ready to review`; when every child is `done` it is the only text. The side bar's subagent row uses the same text.
- Accessible name: `Subagents: {summary}`; it toggles the list.

## 5. List

- Opens upward from the chip (same popup surface and transition as the composer's model/reasoning chips, `ChipMenu`), title **Subagents**, min width 260, max width 360, max height 320 (scrolls).
- A row: 8 px status dot (pulsing while running; colors as the session list), the title (`Untitled agent` when none), and a muted subtitle: the state label (`Running`, `Waiting for approval`, `Error`, `Finished turn`, `Idle`, ...) and provider · model.
- Clicking a row closes the list and opens that agent in the side bar's session view when it is one of this card's sessions (same workspace; the drawer's `onOpenSession`, 2026-10-19 user request). Otherwise it opens in a Paseo agent pane (`navigation.openAgent`, same as **Open in Paseo**). Rows are pressable when either is possible; when neither is (no `openAgent`, and the drawer cannot show it), the list footer says `Open subagents from the Paseo session pane.`. The row's accessible name is `Open {title}`.
- Tapping outside closes it (the composer chips' dismiss layer).

## 6. Not changed

- The side bar's session list: a child agent in the card's own workspace is still listed there as one of the card's sessions (AGENTS.md: a card's sessions are the sessions in its workspace).
- No archive/detach actions in the list (Paseo's pane keeps them).

## 7. Onboarding

New one-time tip `subagents`: shown once when a session of the current project has a live child agent. Text: "When a session starts subagents, a Subagents chip appears above its message box. Click it to see their status and open one to read its work." (changed 2026-11-16, §9.5) Tour feature list unchanged (not a headline capability).

## 8. Acceptance

1. A session with live child agents shows the chip above its message box; a session without them shows nothing extra.
2. The chip summarises the buckets of §3 with the texts of §4; it updates as children start, finish, fail or ask for approval (live stream, no reopen).
3. Clicking the chip opens the list; each row shows status, title and subtitle; clicking a row opens that agent in the side bar (one of the card's sessions) or else in a Paseo agent pane, and closes the list.
4. Archived children disappear from the chip and list.
5. Every new string is in all catalogs; `npm test` and `npm run typecheck` pass.

## Subagents and attention (user decision 2026-10-20)

A Paseo subagent (`paseo.parent-agent-id`) is managed by its main agent, so its unseen finished turn never counts as unread: it adds nothing to Needs attention, the bell, the sidebar badge or the card's unread signal (`sessionAttention` in `shared/session-attention.ts`). Its approvals, questions and errors still need the user, and a manual *Mark as unread* still counts. The side bar's subagent row and the Subagents chip still show `ready to review` as information.

## 9. Provider subagents (user-approved 2026-11-16)

Card: "View a card session's subagent sessions from the card chat". The coders and reviewers a card session starts with Claude Code's Agent tool are provider subagents: they are not Paseo agents, so §2–§5 never showed them.

### 9.1 What Paseo provides (0.15.4, checked live)

- `agent.provider_subagents.list` (`DaemonClient.listProviderSubagents(parentAgentId)`): one descriptor per subagent of that session: `id` (the tool call id), `parentSubagentId` (nested subagents), `provider`, `title` (the agent type, e.g. `sonnet-coder`), `description` (the task's short description), `status` (`running`, `completed`, `failed`, `canceled`), `createdAt`, `updatedAt`, `subtitle` (provider-formatted, e.g. `sonnet-coder · Sonnet 5.5 · Medium · 29.8k tokens`; display only, never parsed).
- `agent.provider_subagents.timeline.get` (`DaemonClient.fetchProviderSubagentTimeline(parentAgentId, subagentId, { direction, cursor, limit })`): the subagent's projected timeline (user_message, assistant_message, reasoning, tool_call rows) with the same paging fields as a session timeline (`epoch`, `startCursor`, `endCursor`, `hasOlder`, `hasNewer`, `reset`, `staleCursor`).
- The plugin SDK (`PaseoApi`, client context) exposes neither, and host navigation has no target for a provider subagent. Hence the exception: the daemon side of Flowly reads both over the short-lived local connection (`server/local-daemon.ts`), read-only. Nothing is written, steered, cancelled or archived.

### 9.2 Daemon RPCs

- `subagents.provider-list` `{ taskId, agentId }` → `{ subagents: ProviderSubagent[], unavailable: boolean }`. `agentId` must be a session in the card's workspace (same check as `sessions.tail`); otherwise the call fails like `sessions.tail` does. Descriptors are passed through with only the fields above (strings capped), oldest first by `createdAt`.
- `subagents.provider-tail` `{ taskId, agentId, subagentId, limit (1–100), mode: "tail" | "before" | "after", cursor? }` → the same `TailPage` as `sessions.tail` (slimmed with `slimTimeline`, no tool payloads). Same session check. `before`/`after` need a cursor. A reset or stale cursor returns `{ entries: [], reset: true }` and the client reads the tail again.
- Connection: at most one local connection, opened on first use, reused while calls keep coming and closed after 30 s without a call and on plugin stop. The token is never logged.
- Failure: support is decided by the daemon's server-info features, `providerSubagents` for the list and `projectedSubagentTimeline` for the tail; missing server info counts as unsupported. An unsupported answer is remembered for 5 minutes per feature, so the daemon is not asked again meanwhile. When the daemon cannot be reached, is restarting or does not support the list, `provider-list` returns `{ subagents: [], unavailable: true }`, which the chip shows as native children only; the client treats `unavailable` as a failed read and keeps the last good list (and its polling) until a read succeeds. `provider-tail` fails with a plain message: the daemon's `userMessage` for a `DaemonRpcError`, "Update Paseo to view subagent conversations." when the timeline feature is missing, and "Paseo could not be reached to read this subagent. Try again shortly." when the daemon is unreachable. `LocalDaemonUnavailable`, `DaemonRpcError` and `DaemonConnectionError` are expected and not logged; other failures go through `logFailure` with a fixed label. A request timeout (10 s) keeps the shared connection; only a lost connection drops it, and the next call opens a new one.

### 9.3 Chip and list

- The chip's children are the native children (§2) plus the session's provider subagents. It is shown when either list is non-empty. Counts, segments and the summary text are computed over both.
- Provider buckets: `running` → running; `failed` → failed; `completed` and `canceled` → done. A provider subagent never needs input itself (its permission prompts show on the parent session).
- The list keeps one order: native children first (§3 order), then provider subagents oldest first. A nested provider subagent (`parentSubagentId`) is listed after its parent, indented one step.
- A provider row: the status dot (pulsing while running), the title = `description`, else `title`, else `Untitled agent`; the muted line = the state (`Running`, `Completed`, `Failed`, `Canceled`) · `subtitle`. Its accessible name is `Open {title}`. Pressing it closes the list and opens the subagent's transcript (§9.4). Native rows behave as §5.
- Data: `subagents.provider-list` is read when the session view is shown, then every 5 s while the parent session is running or any provider subagent is running, and not at all while the view is hidden (PERFORMANCE-SPEC: poll only what is on screen). It is not read for archived sessions.

### 9.4 Read-only transcript

- Opens inside the side bar's session view, in place of the transcript and message box, with a header: a Back button (`Back to session`), the title (§9.3) and, muted, the state and `subtitle`. There is no message box and no action on the subagent: it is read-only.
- Body: the subagent's timeline rendered with the session transcript's own blocks (messages, markdown, the folded activity block for tool calls), newest at the bottom. `Load earlier` pages back with `before` like the session transcript (same page size and cap). While the subagent is running the view reads newer rows every 3 s (`after` the last cursor, merged like the session transcript's refresh) and shows the running state; once it is no longer running, one last read and polling stops.
- Empty: `No output yet.`. A failed read shows the error as a notice with the Back button still working.
- Back (the button, Escape on web, Android Back through the existing step-back, §5 of UI-UX-SPEC) returns to the parent session view with its state as it was. Switching to another session or closing the side bar also closes it.
- Phones: the same view in the compact side bar; the body uses the transcript's phone list (virtualized when the host has `FlatList`).

### 9.5 Not changed

- Native children open as before (§5). Attention: provider subagents add nothing to unread, Needs attention or the bell (as §Subagents and attention).
- No new setting, no telemetry field (a read-only view of existing data), no tour change. The `subagents` tip text changes to say the chip opens each subagent's work (§7).

### 9.6 Acceptance

1. A card session that started Agent-tool subagents shows the Subagents chip; its counts include them, running and finished.
2. The list shows each provider subagent with its status and description; pressing one opens its transcript read-only inside Flowly, on desktop and on a phone.
3. A running subagent's transcript updates while open; `Load earlier` reaches older output; Back returns to the parent session.
4. With the daemon unreachable or an older Paseo, the chip still shows native children and nothing breaks.
5. `subagents.provider-list` and `subagents.provider-tail` refuse a session outside the card's workspace.
6. Every new string is in all catalogs; `npm run typecheck` and `npm test` pass.
