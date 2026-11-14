# Loading optimization R2: the usual path no longer reads the full board (minimal plan)

Status: **implemented** (PR #67), (plan confirmed by the user on 2026-10-26, no switch back). Prerequisite: [SQLite storage](SQLITE-STORAGE-SPEC.md) is already running on the maintainer's machine; this plan changes reads only, not the write path or the storage format.

## 1. Where it is slow now (measured on real data)

Data: the maintainer's board, 107 cards, 4552 events. Measured in Paseo Helper: the size of the first response of each read endpoint:

| Endpoint | Size | Who uses it |
|---|---|---|
| `board.read-changed` (full board) | **2,648 KB**, of which events 1,788 KB, workpad 347 KB, artifacts 246 KB | The wide-screen board (polled by etag every 3 seconds); in the compact layout, when opening New card, the project form, delete card, remove project, the wrap-up prompt, idea links, and the in-session embedded card; the new-card form; the connection editor |
| `board.overview-changed` (overview) | 179 KB | The board in the compact layout |
| `cards.detail-changed` (single card) | median 18 KB, p90 62 KB, max 111 KB | Card detail in the compact layout |
| `projects.card-index-changed` | max 26 KB | Linked-card picker in the compact layout |

It was measured earlier on a phone that the first read of the full board takes about 2.5 seconds just to decode ([PERFORMANCE-SPEC](PERFORMANCE-SPEC.md)). Everyday browsing in the compact layout already uses the overview and single-card detail ([NATIVE-OVERVIEW-SPEC](NATIVE-OVERVIEW-SPEC.md), [CARD-QUERY-SLIM-SPEC](CARD-QUERY-SLIM-SPEC.md)). What still reads the full board is the **wide screen** and **a few features opened by buttons**.

The server builds the overview from the SQLite cache in only about 11 ms ([read-bench](verification/sqlite-min-2026-10-26/read-bench-result.json)), so this plan **adds no SQL queries**: what is slow is the amount of data sent and the client decoding, not the server.

## 2. Changes

**A. The wide screen uses the overview plus single-card detail.** In `client/board.tsx` almost every derived value already has two implementations: one uses the overview's facts (the compact layout already uses it on phones), the other computes from the full board's events. The wide screen switches to the overview one:
- Board data source: every layout uses the overview; the client no longer calls `board.read-changed`. Before the overview arrives (cold start straight to a card), the card face shows only the metadata the single-card detail gives, and does not compute facts.
- Drawer: events, artifacts, workpad and sidebar come from the single-card detail (on the wide screen they are now filtered out of the full board).
- Project Ideas list: switches to `projects.ideas-changed`. Attention, filters and badges switch to the overview facts.
- Polling: the wide screen polls the overview by etag every 3 seconds, and no longer polls the full board.

**B. Features opened by buttons no longer read the full board.**
- New/edit card form: card titles, tags and bound workspaces are read from the project card index instead; which card already references an external item is given by the index's new `externals: [{ provider, key, taskId }]` (only a field is added, no existing field changes).
- The connection editor's "how many cards use this connection": the return of `connectors.connections` gets a new `linkedCards: { [connectionId]: card count }`, which the server computes with the original client's rule (the same connection id, or the connection can recognize its URL; a card counts once). Connections are global, so this is not put in the project index.
- Delete card, remove project, wrap-up prompt: use the existing `*-check` RPCs and single-card detail.
- Idea link ("New card" on the Next moves card) gets an optional `projectId`, and the board reads only that project's ideas; an old link without `projectId` looks up each project in turn, and if it is not found it shows that the idea is closed.
- "Move to Done" on the Next moves card reads only that card's detail; Continue/Ignore in the Ideas dialog read only the owning project's ideas.
- In-session embedded card: uses the existing single-card RPC (`sessions.card-board`).

**C. No fallback switch.** The code in the client that computes facts from the full board is deleted. The server's `board.read-changed` stays (older clients may still call it), and the old algorithms used by the consistency check (`olderFinished`, `latestTurnEnds`, `sessionAttentionSummary`, `allAttentionFromSources`) are also kept for now and removed in the next version.

**Not done**: no change to writes, no change to the storage format, no new SQL queries, no paging or trimming of events (it would change what is shown), no change to how the client bundle loads. The bundle is the biggest part of phone cold start and is a separate piece of work, see [CLIENT-PAYLOAD-POC-SPEC](CLIENT-PAYLOAD-POC-SPEC.md).

## 3. Expected effect (to be measured at acceptance)

| Scenario | Now | After |
|---|---|---|
| First open of the board on a wide screen | 2,648 KB | about 180 KB, plus about 18 KB when a card is opened |
| Tablet or phone in landscape (wide screen) | decoding takes about 2.5 seconds (estimated from the earlier phone measurement) | about 0.2–0.3 seconds (estimated in proportion to the data size) |
| Tapping "New card", delete card, wrap-up on a phone | reads 2,648 KB first | the index at most 26 KB, plus single-card detail |
| Everyday browsing on a phone in portrait | already uses the overview | **basically unchanged**, the remaining time is mostly rendering and bundle loading |
| Desktop | the first read decodes about 2.6 MB | to be measured; this machine is fast, and the gain may be only one or two hundred milliseconds |

## 4. Acceptance

1. **Consistency**: using a copy of the maintainer's real data (local, deleted after the run), for each card compare the facts the two algorithms give (question count, workpad signal, whether wrapped up, Attention, whether it has artifacts/external items, Next moves); the results must be exactly the same.
2. **Zero full reads**: for ordinary wide-screen operations (open the board, switch projects, open and close a card, wait for 3 polls, drag a card), and on a phone opening New card, delete card, and the wrap-up prompt, the number of `board.read-changed` calls is 0.
3. **Timing**: measure once before and once after the change. For the first open of the board on a desktop wide screen, use shot-lib page timing; for the first open of the board in phone landscape and tapping "New card" in portrait, use the plugin `[perf]` log. Record the data size and the time for all three.
4. **UI**: desktop and compact layout screenshots; all existing tests for the drawer, filters, dragging, Ideas and Attention pass; `npm run typecheck` and `npm test` pass.
5. **Independent verification**: before merging, `claude/claude-haiku-5-5` reruns the checks above on the implementation commit (AGENTS.md).

## 5. Decisions

- **No switch back to the full board, and no option for users** (the user, 2026-10-26): the maintainer uses it first for a while, and problems are exposed and fixed directly. The worst case is only a wrong wide-screen display; writes and storage are not changed.
- **How to release**: whether to ship it in two versions with the SQLite migration or in one combined version is decided by the user before release (risk analysis in the card record).
