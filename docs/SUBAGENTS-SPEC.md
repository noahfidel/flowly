# Subagents chip in the session view

Card: "Link subagents to sessions in the sidebar" (2026-10-19). Scope chosen by the user: **option C**, Paseo-native child agents only.

## 1. Goal

When a session started subagents, the side bar's session view shows a **Subagents** chip above the message box, styled like the Paseo session pane's own Subagents pill. The chip shows the subagents' state at a glance; clicking it opens the list; clicking a row opens that agent in the side bar when it is one of this card's sessions, else in a Paseo agent pane.

## 2. What counts as a subagent

A **Paseo-native child agent**: a live, non-archived agent whose label `paseo.parent-agent-id` equals the session's agent id (Paseo's `PARENT_AGENT_ID_LABEL`, the same field as `PluginAgentSnapshot.parentAgentId`). Paseo sets the label when an agent creates another through Paseo (`create_agent`, delegation). The child may live in any workspace.

Out of scope (user decision): **provider subagents** (Claude Code Task/Agent, Codex subagents). The daemon lists them (`listProviderSubagents`), but the plugin SDK (`PaseoApi`, 0.11.2 and 0.11.4) does not expose that call, and the host has no navigation target for them (`navigation.openAgent` opens real agents only). Supporting them would need a new local-daemon exception; not done.

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

New one-time tip `subagents`: shown once when a session of the current project has a live child agent. Text: "When a session starts subagents, a Subagents chip appears above its message box. Click it to see their status and open one in Paseo." Tour feature list unchanged (not a headline capability).

## 8. Acceptance

1. A session with live child agents shows the chip above its message box; a session without them shows nothing extra.
2. The chip summarises the buckets of §3 with the texts of §4; it updates as children start, finish, fail or ask for approval (live stream, no reopen).
3. Clicking the chip opens the list; each row shows status, title and subtitle; clicking a row opens that agent in the side bar (one of the card's sessions) or else in a Paseo agent pane, and closes the list.
4. Archived children disappear from the chip and list.
5. Every new string is in all catalogs; `npm test` and `npm run typecheck` pass.

## Subagents and attention (user decision 2026-10-20)

A Paseo subagent (`paseo.parent-agent-id`) is managed by its main agent, so its unseen finished turn never counts as unread: it adds nothing to Needs attention, the bell, the sidebar badge or the card's unread signal (`sessionAttention` in `shared/session-attention.ts`). Its approvals, questions and errors still need the user, and a manual *Mark as unread* still counts. The side bar's subagent row and the Subagents chip still show `ready to review` as information.
