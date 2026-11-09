# Sidebar attention badge — 2026-10-15

Incremental spec for card F2. Extends the board Attention entry in [MULTITASK-SPEC](MULTITASK-SPEC.md) to the Paseo left sidebar row registered by `index.client.tsx`.

2026-10-22 amendment: both the Paseo sidebar notification pill and the board header's Attention count pill use the current theme accent background and paired accent foreground. Their count and click behavior stay unchanged.

## Host capability (0.11.2, confirmed)

- Public `SidebarRowProps` has `trailing?: ReactNode` ("Right slot. Renders beside the row's pressable, so a button here presses on its own.").
- Installed 0.11.2 app bundle: `SidebarRow` → `SidebarHeaderRow`. When `trailing` is `null`/`undefined` nothing is rendered. Otherwise it is wrapped in a host `Pressable` with the row's `onPress`, `accessible={false}`, so a plain view in `trailing` opens the board and a nested pressable handles its own press.
- The row's accessibility label is the registered title ("Ultra Kanban"); plugins cannot change it without changing the visible label. The badge therefore carries its own accessibility label.
- Sidebar items render inside the host plugin environment: `usePaseo`, `useRpc` and the host-shared `@tanstack/react-query` are available. `PluginSidebarItemProps` supplies `theme`, `host.id`, `currentScreen` and `openScreen(screenId, params)`; params are string-only and travel in the URL.

## Observable behavior

- The row keeps its icon, title and active state. Pressing the row (or empty trailing area) opens the board exactly as before.
- When the attention count is > 0, a small pill shows the count on the row's right (`99+` above 99), using the current host theme's accent background and paired accent foreground. It updates with the active Paseo theme. Count 0 renders no trailing content.
- The board header's Attention button keeps its existing count and click behavior; its visible count pill uses the same active theme accent background and paired accent foreground.
- Pressing the pill opens the board screen and opens its **Needs attention** modal (params `view=attention`, `open=<unique token>`). Each press uses a new token, so repeat presses reopen the modal even when the board is already showing. A board mounted with the same token applies it once; unrelated params (session links) are unaffected.
- Accessibility: the pill is a button labelled `Open needs attention, N items`.

## Data contract

- 2026-11-08 (plan Q1, ATTENTION-DISMISS-SPEC §7a): Count = the open asks, `openAskCount(attentionItems(...))` (each card's undismissed signals, the same asks `asksFrom` lists in the dispatcher chat), no longer the number of cards. It is computed by the shared pure function `attentionFromSources` that the board also uses. Identical inputs give identical board and sidebar counts: same board RPC (`readBoard`), same agent listing (`listAgents` over the plugin-provided `usePaseo` SDK), same read receipts RPC, same `readUnavailable = pending || error` rule (unread excluded, permissions/errors kept).
- No second Paseo connection; only plugin SDK/RPC.
- Polling: every 10 s while the sidebar item is mounted, `retry: 1`, not in background. Query keys are host-scoped (`["flowly","sidebar",hostId,…]`) so multiple hosts never share counts. Unmount removes the observers, which stops polling.
- Because the sidebar polls at 10 s and the board at 3–5 s, the two can briefly differ by one polling interval; they converge on the next poll.

## Errors

- If the board or agent read fails (or has not completed), the badge is hidden — no toast, no stale count. Failures retry on the next interval.
- Read-receipt failure is not an error for the badge: it matches the board, counting only approvals and errors.

## Acceptance

- Pure tests: board and sidebar counts derive from one function; unavailable board/agents → hidden; 0 → hidden; `99+` cap; read-unavailable keeps permissions only; attention-open params produce a unique token and the board recognises only `view=attention` tokens.
- Theme: the sidebar and board header pills both use `colors.accent` and `colors.accentForeground` from the active Paseo theme.
- `npm run typecheck`, `npm test` pass.
- Real UI for the original F2 card (compact drawer, pill press opening the modal, Reduce Motion) remains UNRUN. After the 2026-10-22 plugin reload, the user visually confirmed the sidebar and header count pills show the theme green. Compact rendering, a theme switch, and pill activation were not separately checked; see [verification](verification/sidebar-badge-theme-2026-10-22.md).
