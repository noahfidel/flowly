# App performance: smooth animation, fast session cards, typing that keeps up

2026-10-24 用户决策更新：[按可用宽度统一性能策略](RESPONSIVE-PERFORMANCE-SPEC.md)
取代下文历史优化中的平台门控。紧凑/宽屏只按可用宽度判断；裁剪、轻量读模型、
隐藏查询暂停、渐进列表与转场门控不再按Android/iOS/Web选择。底层API适配保持。
本轮按用户要求不运行验证，旧测量仅代表其当时的快照。

Status: card “性能优化” (2026-10-15). User report: in the app, animations stutter, session cards load slowly, and the input lags, drops characters and sometimes closes the keyboard. Goal: close to native smoothness. This amends the motion, session UX and session input specs; business contracts (single root, card/workspace/session ownership, CAS writes, exact follow-up text) are unchanged.

## 1. Diagnosis

The animations already run on the native driver, and the composer already owns its text on native. The stutter comes from a JS thread that is busy most of the time:

- **Polling volume.** With the board open, the client fetched the full board every 3 s (about 180 KB: every task's every event), resources every 5 s, every live agent every 5 s, summaries every 5 s and managed sessions every 10 s. With a session open, it also fetched every agent on the host including archived ones every 3 s (the drawer list), the session's agent every 2 s, a 35-entry projected timeline with full tool payloads (diffs, file contents, sub-agent logs) every 3 s plus on every stream event, tool health every 5 s and access state every 3 s. Off the LAN, every response is decrypted, base64-decoded and parsed on the JS thread (relay E2EE), then deep-compared by react-query.
- **No render containment.** No component used `React.memo`. Each poll that changed anything (an agent's `updatedAt` changes constantly while it runs) re-rendered the board, every card, the open drawer, the whole transcript and the composer. The host's theme object could also change identity on unrelated host renders, which invalidates every `useTheme` consumer.
- **Mount work during transitions.** On a phone, opening a card unmounted the whole board and Back remounted it (every card, query and animated value) in the same commit that starts the exit animation. Opening a session mounted the transcript only after two sequential round trips with no cache.
- **JS-driven loops.** The running pulse used `Animated.loop(sequence)`, which cannot loop on the native driver, so every running dot needed a JS callback every 800 ms and froze whenever the JS thread was busy.
- **Input.** The composer re-rendered the session view on every wrapped line (JS height round trip, applied a frame late) and on keyboard events. Text typed while a send was in flight could be erased when the send cleared the box. A daemon draft restore that arrived after the user focused an empty composer remounted the input, which closes the keyboard.
- **Unstable transcript keys.** Entries without a message ID were keyed by their position in the sliding 35-entry window, so blocks remounted (and collapsed) as output arrived. The key used `entry.seq`, which projected entries do not have.

## 2. Behavior

Nothing the user sees changes, except that it is faster:

- Board, drawer and sessions show the same data. Freshness is at least as good as before: live agent changes arrive through a Paseo subscription within about half a second (updates are batched per 500 ms), and polling only reconciles.
- Opening a card shows its sessions at once (from the board's live agent list). Archived sessions follow from a slower read.
- Opening a session shows the cached transcript at once when it was seen recently. Otherwise the agent and transcript load in parallel.
- Sending clears the composer at once. If the send fails, the text returns: into the empty box, or before anything typed since. The error is shown as before. Text typed while a send is in flight is never erased.
- The keyboard never closes because of background data. An outside change that would replace the text (restore, queued-message edit) never remounts a focused input that the user has typed in.
- On a phone, Back from a card returns to the board with its scroll position, without rebuilding it.

## 3. Changes

### Daemon (no storage migration)

- `board.read-changed` `{ etag? } → { etag, board? }`: the board view with a content hash; the board is omitted when the hash matches. `summaries.read-changed` and `resources.read-changed` do the same. The original RPCs stay for other callers.
- `sessions.tail` `{ taskId, agentId, limit } → { entries }`: a session's projected timeline tail, reduced to what the UI shows (`seqStart`, item type, text, tool name/status, message/call IDs). Text is clipped (agent and user messages at 12 000 characters, reasoning at 2 000). The session must belong to the card's workspace, like `sessions.image`.

### Client data

- One shared query definition per key (`client/queries.ts`). Board, summaries and resources poll with their etag: an unchanged response is tiny and leaves the cached object as it was, so nothing re-renders. The cache holds plain values; the etag is only sent when the cache still holds the value this reader stored (any `setQueryData` forces a full read).
- Live agents (`["ultra","activity"]`): `paseo.agents.list({ subscribe: {} })` with a one-entry page establishes a filter-scoped update stream. Upserts and removals patch the cache, batched per 500 ms. Archived agents and progress summarizers leave the list; an update never replaces a newer snapshot. The full list still reconciles every 20 s, or every 5 s until the stream is ready or after it fails. The subscription is released on unmount.
- Drawer sessions: live sessions come from the shared live agent list, filtered by workspace (`select`, so other workspaces' updates do not re-render the drawer). Archived sessions are read every 30 s, after any session action, and as soon as a session leaves the live list. Workspace availability and task context poll every 10 s instead of 3 s/5 s.
- Session preview: the agent query is keyed by session (shared with other views, normal cache time) and seeded from the live agent list. The transcript query starts in parallel and uses `sessions.tail`. Stream events refresh only the transcript, coalesced at 400 ms. Polling falls back to 15 s while the stream is ready. Tool health and access state are read only while the Kanban tools section is open.
- Card output: the latest-output line uses `sessions.tail` with a short limit, and cached outputs live for 5 minutes.
- Session images: native skips `Image.getSize` (a second decode of the same data URI); `onLoad` reports the size.

### Client rendering

- Memoized components with stable callbacks: task cards, task drawer, transcript (and each entry, markdown block, inline run and activity block). The native composer does not re-render the session per keystroke (it owns its text), so focus, keyboard and draft-report renders now skip the memoized transcript. Board-wide derivations (events by task, agents by workspace, available workspaces) are computed once per data change, and cards read them by lookup.
- The board root receives a theme object whose identity changes only when a color changes. The context-menu opener is stable, so opening a menu does not re-render the board.
- Phone: the board stays mounted under an open card (`display: none`, so it is not focusable or reachable by accessibility). A lane switch still starts its list at the top.
- Transcript keys use `seqStart`, else the message or call ID. The extra scroll-to-end effect before layout is gone; the transcript follows its tail from its own content-size/layout events, so it lands on the new end in one step.
- Native composer grows by itself between its minimum and maximum height (no JS height round trip). Web keeps the measuring mirror. The keyboard hook applies the transcript padding when the keyboard animation finishes, not at its start.

### Motion

- The running pulse is one native-driver timing looped natively (`Animated.loop(timing)`, opacity interpolated 1 → 0.35 → 1), so it never needs the JS thread.
- Cards no longer fade in on every mount; the list's own reveal covers navigation. The status-change flash overlay is mounted only while it is visible.

### Follow-up: open transitions (user report: opening a card or a session still stutters)

The transitions run on the native driver, but they started in the same frame that mounted the whole drawer or session view and fired its reads. One of those reads paged every agent on the host to find archived sessions. On a phone, the UI thread was busy creating views and the JS thread was busy decoding during the slide.

- `useSettled(key)` (`client/motion.tsx`) turns true one frame after the forward transition (220 ms), and at once under Reduce Motion.
- Opening a card shows its header, questions, description, progress and sessions (from the cache) at once. Details, Usage and Activity, and the workspace, context, archived-session, composer and usage reads, start once it has settled. The late sections sit below the sessions and fade in, so nothing above them moves.
- Opening a session shows its header, notices and composer at once. The transcript, its tail read, the model list and the composer state start once it has settled; the transcript fades in.
- `sessions.archived { taskId }`: the daemon returns the card workspace's archived, non-summarizer sessions. The client no longer pages every agent (hundreds of KB) on each open.
- Phone: the open card is an opaque overlay above the board, which stays laid out (covered, not focusable, hidden from accessibility). Opening and Back change no layout underneath. The board no longer replays its own reveal when a card opens or closes.

### Follow-up: sideways drift while scrolling (user report with an Android capture)

The open card's content (its header included) sat offset to the left while the host header did not, i.e. the details view's own reveal transform (it slides from the left) stayed at a stale start value. Two weaknesses in the shared primitives made that possible on Android's new architecture: every render built new interpolation nodes (re-attaching the native graph and committing the JS-side value mid-animation), and nothing forced the end value into the committed props.

- `lerp(value, outputRange)` (`client/motion.tsx`) returns one cached interpolation node per value and range; every plugin animation uses it.
- Shared transitions set their final value from JS when the native animation finishes, and an interrupted reveal resets to its rest value.
- `MotionReveal` no longer animates on first mount (the surrounding card or board already brings it in); only identity changes animate.

### Follow-up: Back from a session left the card half revealed (user report, phone)

Occasionally, after Back from a session, the card details stayed faded and offset while still accepting touches. Two remaining paths could leave a stale value on screen:

- The reveal range was keyed by direction (`[direction * distance, 0]`), and forward/Back flip the direction, so every Back swapped the view's animated props node in the same frame the reverse transition started. On Android's new architecture the old node's detach restores and disconnects values asynchronously, racing the new animation.
- A stopped native animation reports its end asynchronously, and React Native then syncs the JS value to where the native animation stood and commits it, after the reveal had already reset to rest.

`MotionReveal` now animates one signed offset (±1 → 0) through fixed interpolation nodes for both directions, and after every native end, unless a newer reveal is moving, sets the rest value again on both sides and commits it.

### Follow-up: typing on a phone interrupted when a card changes lane (user report, 2026-10-18)

Report: while typing in a card's session on a phone, an agent's stage update (or the status rule after a send) interrupts input. Not reproduced on a device (no phone mirror available); two load sources were found and removed:

- **Session view re-render.** Every board change re-rendered the drawer and, through inline callbacks, the whole `SessionPreview` (transcript, Markdown, composer): a long JS frame mid-typing. `SessionPreview` is now `memo`ized. It compares only the card fields it reads (`samePreviewTask`: id, workspace, archived, title) and this session's latest turn event (`turnEventKey`). The drawer passes stable callbacks (`useStableCallback`). A lane/revision change alone no longer re-renders it. A new turn, a rename or an archive still does.
- **Native session chip poll** (`registerSessionChips`, runs on every client while Paseo's own composer is in use). Every 5 s it re-downloaded the full board, paged every agent on the host including archived ones, and pushed `chip.update` into the host composer even when nothing changed. Now the board is read by etag (`board.read-changed`), only live sessions are listed each round, archived ones are rescanned only when the board changed, a chipped session vanished, or once a minute, and a pill is updated only when its text changed.

Unit: `client/session-chips.test.ts`, `client/session-state.test.ts` (memo keys); session-chip fixture updated to the new reads. Device check: UNRUN.

### Follow-up: phone sluggish again (user report, 2026-10-19: scrolling, animations and taps feel slow; desktop is fine)

Not reproduced on a device (no phone mirror). Three load sources were found by reading the data and the render paths, and removed:

- **The board payload had grown 6×.** `board.read-changed` returns the whole board, and events are append-only: 1 663 events were 684 KB of a 877 KB view (it was 147 KB when the etag read was introduced). Every board change (any agent turn start/end, progress report, status move) re-sent, decrypted and parsed all of it on the phone, then diffed it. `board.read-changed` now accepts `since: { count, lastId }` (the events the caller holds). When the daemon finds that event at exactly that position it returns the board with only the newer events and `delta: true`; any mismatch (a deleted card's events, a trimmed log) falls back to the full board. `readBoardDelta` (`client/queries.ts`) appends them to the cached events, reusing the cached event objects, so react-query's structural sharing is cheap. Measured on this daemon's data: 877 KB → 216 KB for a change of two events. The rest of that was sent whole by this first step; the next paragraph removes it.
- **Item-level patches for the rest of the board** (same day, second step). The daemon (`server/board-delta.ts`, `BoardDeltas`) remembers a fingerprint of each of the last 32 boards it served, keyed by etag: one short hash per item of projects, tasks, ideas, links, artifacts, workpads and attention dismissals (matched by `id`, workpads and dismissals by `taskId`), the plans as a whole, and the event count with the last event ID. A caller that names an etag it holds (the client only sends one while its cache still holds exactly what it stored under it) gets `patch` instead of `value`: the revision, the events after the ones the fingerprint counted, per collection the items that are new or differ (`set`) and the IDs that vanished (`remove`), and an `order` (all IDs) only when appending the new items after the kept ones would not give the real order, plus `plans` when they changed. `applyBoardPatch` (`client/queries.ts`) rebuilds the board; untouched items keep their objects, so structural sharing and memoized cards see no change. Fallbacks, in order: the events-only `since` delta when the etag was never served or was forgotten (restart, eviction, another client's etag), then the full board; also when the events no longer continue the fingerprint's (a deleted card's events). A patch for a board the client no longer holds triggers a full read. Typical size now: the changed items plus new events (a workpad update ≈ 7 KB, a status move ≈ 1–2 KB) instead of 877 KB.
- **Agent churn re-rendered the board twice a second.** A running agent rewrites `updatedAt` (and its turn handle and usage) on every stream event, and the shared live agent list is replaced on each batch. With any agent running on the host, even in another project, every consumer of the whole list (the board root, hence every card derivation) re-rendered about every 500 ms. `applyAgentUpdates` now drops an update of a running agent that differs from the cached one only in `updatedAt`, `activeTurn`, `lastUsage` or `runtimeInfo` (none is read live); any other change, and every settled agent's update, still applies, and the 20 s reconcile brings the dropped fields current.
- **Per-card derivations ran on every board render.** `renderCard` scanned each card's events and sessions (attention summary, questions, wrap-up, workpad signal, output session) on every Board render, so opening a card, a menu or a filter redid it for the whole lane in the frame that starts the transition. The derived props are now cached per task object (`cardDerived`, a `WeakMap` that is replaced when any source changes). `selected`, `flash`, `drag` and `disabled` stay outside it.
- Smaller: the transcript's `onScroll` now fires every 100 ms instead of every frame (it only decides whether to follow the tail); `useSessionReads` returns a stable empty list while loading.

Unit: `client/queries.test.ts` (churn-only updates keep the cached list and anything else applies; delta append and full fallback; a daemon patch applied to the cached board gives exactly the new board, unchanged items keep their objects), `server/etag.test.ts` (events delta, stale prefix, deleted events, unchanged), `server/board-delta.test.ts` (changed/added/removed/reordered items, plans, workpads by task, events that stop continuing, remembered/forgotten etags). The patch was also round-tripped on a copy of this daemon's real board through the RPC output schema. Device check: UNRUN.

### Follow-up: virtualized lane list and a timing log (user: "much better", asked for more)

- **Virtualized lane list (phone).** The compact board rendered every card of the open lane in one `ScrollView`, so a long lane (Done) mounted hundreds of views, animated values and card reads at once, and every later render walked all of them. The list is now the host's `FlatList` (`client/lane-list.tsx`): `initialNumToRender` 8, `maxToRenderPerBatch` 6, `windowSize` 7, cards separated by a spacer (not `gap`, which would also space the virtualization spacers). Only cards near the screen are mounted, so only they run their latest-output read (`sessions.tail`); an unmounted card's cached output stays for 5 minutes, so scrolling back shows it at once. The rows (cards, the "No recent tasks"/empty placeholder with its Add task button, the Show older toggle, the older cards) are one list built by `laneRows` (`client/lane-rows.ts`); `sameRows` hands the list the previous array when no row changed, so a board render that changes nothing here does not touch the list. Switching lane still remounts the list (`key={mobileStatus}`), so it starts at the top (2026-10-31: on iOS/Android the lanes are pages of a native pager; the selected lane mounts at once and its two neighbours 400 ms later, so a swipe shows a ready lane at the cost of up to two more lists; a lane chosen from the status chooser that was not mounted starts at the top); Back from a card keeps the position because the board stays mounted under the card (unchanged). A host without `FlatList` falls back to the previous plain scroll of every row. Desktop columns are unchanged.
- **Timing log (developer switch).** To measure on a device without a profiler: set `{"version":1,"values":{"log":true}}` in `~/.paseo/plugin-settings/flowly/performance.json` on the host (the settings envelope; a bare `{ "log": true }` is ignored) and reload the plugin (no settings page, so no UI text). The board reads that setting; when on, `client/perf.ts` aggregates timings per name and sends them every 10 s through `perf.report`, and the daemon prints one line per report: read them with `paseo plugin logs flowly` while using the phone (`[perf] ios board.render n=12 avg=3.1ms max=9.0ms | …`). When off (default) each call is one boolean check and the daemon ignores reports. Names:
  - `board.render`: from the start of a board render to its commit (the board component plus its subtree's render and commit), one sample per render.
  - `board.read.same|patch|events|full`: the board poll's round trip as the phone sees it (network, relay decryption, parsing), by what came back; `board.apply`: applying a patch or events to the cached board.
  - `drawer.open.mount`: tap on a card to the drawer's first commit; `drawer.open.settled`: tap to the heavy sections starting (after the open transition).
- Unit: `client/lane-rows.test.ts` (row order, placeholder, unique keys, row identity), `client/perf.test.ts` (off means nothing kept, per-name aggregation and 10 s flush, marks and laps, off drops data, report schema and log line), `shared/settings.test.ts` (switch defaults off). Device check of the list (scroll position on Back, no blank cards while scrolling fast, lane switch to top) and the numbers: UNRUN.

### Follow-up: cold start (user: the app reloads the plugin at every launch; start-up speed is how soon the plugin is visible)

How the host loads a plugin by default (read from its `compiler.js` and renderer): the daemon bundles `index.client.tsx` with esbuild into **one unminified CommonJS file** (no code splitting, `async/await` lowered), sends the text to the app inside the plugin catalog (through the relay's E2EE on a phone), and the app runs `globalThis.eval` on it at every launch and connection. There is no lazy chunk: every byte is transferred, parsed and executed before `contribute()` can register the sidebar item and screens. The cost of a start is therefore bundle size plus whatever the plugin does when it registers.

- **Bundle 2.12 MB → 0.95 MB (−55%).** Measured by compiling `index.client.tsx` with the daemon's own esbuild options. 1.18 MB were the nine UI-language catalogs; every client carried all of them although it shows one (and English needs none). The client bundle now has none: the daemon serves the current language's catalog on demand (`i18n.catalog`), see I18N-SPEC "Delivery". English users download nothing extra; others fetch 78–127 KB after start instead of 1.18 MB inside the bundle. Surfaces wait at most 400 ms for the catalog (`LocaleRoot`), so the plugin is visible as soon as the board can render, English at worst; Command Center titles are rebuilt when the device language's catalog arrives. On V8 the compile step of the bundle fell from 11.5 ms to 7.4 ms; Hermes parses from source and is much slower, so the real gain is larger.
- **Start-up work moved off the first paint.** The Composer-pill (session chip) poll ran its first round at plugin load: a board read plus a list of every live agent plus a scan of every archived agent on the host (hundreds of KB, decoded on the JS thread) while the app was still painting. Its first round now waits 2.5 s (`CHIPS_START_DELAY_MS`); chips appear that much later and are unchanged afterwards.
- **Regression fixed on the way.** The chip poll sends an etag to `board.read-changed`; since the board patches, the daemon answers a remembered etag with a `patch` and no `value`, which the poll ignored, so its board stayed at the first read (new cards or sessions would not get chips until the plugin reloaded). It now reads through `readBoardDelta` like the board screen (`client/board-read.ts`, split out of `queries.ts` so the entry does not import React Query).
- **Timing log.** `plugin.load` (from the first import of the bundle, `client/boot.ts`, to the end of `contribute`: the evaluation cost of the plugin on that device) and `catalog.load` (the catalog request) are measured before the log's setting can be read and reported once when it turns on, with the other names.
- **Not done / ideas:** module-level work in the remaining 0.95 MB (zod schemas, tables) is unmeasured on a device (`plugin.load` will show it); rarely used pages (Insights, Tickets, Settings, onboarding) cannot be split out because the host has no lazy chunks; a minified bundle or UTF-8 output would be a host change (`compiler.js`: no `minify`, esbuild's default ASCII escaping inflates non-Latin text).
- Unit: `client/catalog.test.ts` (language requested once and never for English, retry after failure, every catalog fits the RPC reply, nothing reachable from the entry imports the catalogs), `client/session-chips.test.ts` (patch answers update the chips; first round waits for the start delay), `shared/i18n.test.ts` (catalogs still complete, through `i18n-all`). Device check of start-up time: UNRUN.

### Follow-up: why a board read is full (phone evaluation, 2026-10-21)

The phone evaluation ([report](verification/performance-phone-2026-10-21.md)) saw `board.read.full` about 2.6 s each, 5 times in 4 minutes, although the etag/patch path exists. With the timing log on, a full read now says why:

- Daemon (`BoardDeltas`, `onFull`): one line `[perf] board.read.full reason=<r> events=<n> remembered=<k> [held=<n> heldLastAt=<i>]`. `no-etag` (the caller sent none), `etag-unknown` (never served or forgotten), `events-discontinuous` (a new event is not at the end of the list, so it cannot be appended: should not happen), `no-since`, `since-mismatch`.
- Client (`readBoardDelta`): `board.read.full.<why>` next to `board.read.full`, with `first-read`, `cache-replaced` (another writer touched the cached board), `cache-changed-in-flight`, `patch-without-cache`, `chips-first-read` or `server` (an etag was sent and the daemon still answered in full).

Findings:

- **Root cause: the per-card event cap.** `store.event()` keeps at most 100 events per card; appending one to a card at the cap removes that card's oldest event from the middle of the global list. The list keeps its length (2840 here) but the caller's last event is no longer at its old position, so `diffBoard` returned null and `boardIfChanged`'s `since` check failed: the whole board (all events, about 2.4–3.0 s on the phone) was sent to every client that polled with an older etag. 8 of this board's cards are at the cap (`harness2研究` is in review); one event on any of them triggered it. Logged: `reason=events-discontinuous held=2840 heldLastAt=2837`.
- **Fix: events are matched by id.** The fingerprint remembers the event ids; `diffBoard` sends the events that are new (they are always at the end; if not, no patch) and `removeEvents`, the ids that left; `applyBoardPatch` drops those, then appends. A real-board round trip (a capped card's oldest event dropped, one appended) gives a patch of a few hundred bytes against 880 KB, and the patched board equals the new board. Tests: `server/board-delta.test.ts`, `client/queries.test.ts`.
- **Bug fixed on the way: eviction order.** `BoardDeltas.read` remembered the new board (evicting the oldest, 32 kept) before looking up the caller's etag, so a caller whose etag was the oldest got a full board although it held a valid one. It now looks up first.
- After a plugin reload every client's first read is `no-etag` (the daemon forgot its boards): expected. The first read of an app launch is still a full board (2840 events, about 2.5 s to decode on the phone). Trimming what the first read carries (older events per card) would change what the drawer's Activity shows, so it is a decision, not done here.

### Follow-up: the Task chip's archived scan (phone evaluation, 2026-10-21)

`chips.archived` took 7.3–13.3 s on the phone (avg 8 s, n=4): the scan paged every agent on the host, archived included, and decoded all of it on the JS thread (a round trip of megabytes, after the plugin's first board read). Now `sessions.archived-refs {} → [{ id, workspaceId }]` does the paging on the daemon (locally, cheap) and returns bare ids of archived, non-summarizer sessions in a card's workspace, which is all the chip needs. Measured on the same phone and host: `chips.archived` 0.31–0.46 s (n=4). Unit: `server/archived-sessions.test.ts` (refs), `client/session-chips.test.ts` (fixtures answer the new RPC).

Checked and left as is: `board.read.same` (200–700 ms on the phone, mostly the relay round trip; the response is tiny, so it does not load the JS thread) and `board.render` (about 80 ms per board change, also for a two-card lane). A per-card derivation cache keyed by each card's own events and sessions was tried and reverted: no measurable change, so the cost is elsewhere (candidates: the O(events) passes over the 2840 events per board change, the header counts); it needs a profiler run, not a guess.

### Follow-up: Task chip navigation shares the fresh board query (2026-10-23)

The native workspace chip entered Flowly quickly but waited on `Opening linked card…`: first target observations were 8.934/7.342 s on Samsung SM-S911B. `resolvedLink` always called `board.read {}` (2.1 MB), then cancelled the shared board poll and overwrote its query data, invalidating that reader's etag; the next poll downloaded another full board (`board.read.full.cache-replaced`, 3844.2 ms). Ordinary same-card opening mounted in 152.6 ms.

The route now calls `useFreshBoard`, sharing `boardQueryOptions`/boardKey/readBoardDelta with the board. `staleTime:0` forces a fresh round trip even with a warm/Infinity-default cache, and concurrent callers join the existing fetch. The exact actor still refreshes in parallel; missing/moved resources and read/lookup failures still reject. Applying the current link changes only local navigation state; no cancel or setQueryData, so the etag survives. Cold QueryClient needs one full read, coalesced across route and board.

After reload on the same phone, same-card first observations were 2.611/2.550 s; first chip after reopening the phone client was 2.135 s (this is a client restart measurement, not proof the board cache was empty at click). Hierarchy reads take ~1 s, so these are sampled upper bounds, not frame timings. Android reports no navigation-induced cache-replaced full read. Regression tests cover coalescing, fresh warm reads/patches, next-poll etag and fail-closed membership checks. [Diagnosis](verification/chip-latency-2026-10-23/README.md), [fix verification](verification/chip-latency-2026-10-23/fix/README.md). No new user feature or guidance change.

### Follow-up: native Task chip opens a scoped card first (2026-10-23)

Native card links now use fresh `sessions.card-board` plus the exact session refresh, then display the drawer before the complete board query. This scoped view includes the target card's details/history and attached entities; it never overwrites `boardKey` or its etag. Drawer sections may use it while the background board loads; a full board with at least its revision takes over, including removals. Back drops the scoped view so an unfinished full board shows its existing loading state. Desktop keeps the shared fresh board path. See [native contract](NATIVE-SESSION-SPEC.md) and [verification](verification/direct-card-2026-10-23/README.md).

### Follow-up: slim native chip cold read (2026-10-23)

The global native chip poll still fetched the complete board on app start, even while the board was not open: 2.11 MB here, plus a 330 KB live session directory. `sessions.chip-board-changed` now serves a read-only projection with its own delta/etag cache: card/project identity and status, open ideas, and each actor's last suggestion/turn-start boundary; no descriptions/history/workpads/artifacts. This response is 144 KB here (93% smaller). Only the native poll uses it; full-board navigation and latest membership checks remain unchanged. Native Next steps freshness rules are unchanged.

Same Samsung cold-start first-chip observations: 17.94/18.548 s before → 15.810/15.409 s after on the original path. A temporary USB direct-path test with the same code was 5.416 s, and was cleaned up: the remaining startup delay is materially tied to the host connection/transport, not something the Flowly query change solved. In the last original-path run Progress was visible at 6.438 s and current Next steps with the chip at 15.409 s; earlier rows were not in that viewport, so no comparable before timing for those rows is claimed. [Contract](NATIVE-SESSION-SPEC.md), [evidence](verification/native-cold-start-2026-10-23/README.md).

## 4. Constraints kept

- No second Paseo connection: the subscription uses the supplied SDK. No new dependency, no DOM, no private host import.
- Fresh authorization before every send is unchanged (`sendCardInstruction` still refreshes the actor and the scoped context first). Ordinary follow-ups send exactly the user's text.
- Reduce Motion, interruptible transitions and cleanup rules from `MOTION-SPEC.md` hold. An inactive drawer or preview still stops its subscriptions and polling.
- `AGENTS.md` records the performance rules for future work (§5).

## 5. Rules for future work (also in AGENTS.md)

- Poll only what is on screen, and only as often as it changes; prefer the SDK subscription, an etag/unchanged response, or a daemon-side slim RPC to re-downloading a large payload.
- List items and panes that receive frequently changing parents are `React.memo` components with stable callbacks (`useStableCallback`) and primitive or identity-stable props.
- Loops and transitions run on the native driver. Do not loop a `sequence`; do not animate layout properties in hot paths.
- Do not unmount and remount large trees for navigation on phones; hide them.

## 6. Acceptance

Results: [verification](verification/performance.md).


- PASS needed: typecheck; focused unit tests for the etag reader (unchanged keeps the cached object, a foreign `setQueryData` forces a full read), live-agent patching (upsert/insert/archive/remove/summarizer filtering), the tail reducer (fields, clipping, key stability) and the send-clear/restore helper; full suite; plugin reload; live RPC check of `board.read-changed` and `sessions.tail` against this daemon.
- UNRUN unless done on a device: perceived smoothness, frame rate, IME and keyboard behavior on real iOS/Android phones and tablets over LAN and relay. Synthetic tests do not prove frame rate.

### Mobile covered-board queries and first TaskForm (2026-10-23)

Native SidebarEntry uses daemon `attention.count {}` → `{count:number|null}` instead of board/agent payloads, with the same shared Attention rule and a 3s refresh (was 15s: the badge lagged the board's live Attention button; the response is a few bytes, the decoding stays on the daemon). Retained native compact boards disable their own query/stream observers and card-output reads while covered; direct links still start a fresh full board in the background. TaskForm keeps its Title/Description mounted and defers optional controls/queries until `useSettled`, preserving Create guards, native input ownership, fresh authorization and 450ms modal handoff. [Complete contract and checks](MOBILE-QUERY-MODAL-SPEC.md).

## Android task/session switch frames (2026-10-23)

Android compact task detail uses native ScrollView offscreen clipping to reduce display-list recording during detail remounts. React child state and fresh ownership rules are unchanged. Opt-in switch preparation/commit spans and early gfxinfo capture distinguish native recording from data waits; see [finite switch-frame specification](MOBILE-SWITCH-FRAMES-SPEC.md). Clipping must be checked by scrolling lower sections back into view and by reversal.

## Native disclosure update — 2026-10-23

[Mobile disclosure specification](MOBILE-DISCLOSURE-SPEC.md) supersedes native measured-height wording: section bodies use one layout change plus native fade/translate; Progress/Idea Show more/less uses numeric height plus native body fade. Native chevrons rotate on native driver. Web keeps measured-height animation.104pt clamp, footer/actions, content identity, Reduce Motion, rapid reversal/cleanup and all business guards are unchanged.

2026-10-23 user review correction: phones restore continuous local measured-height disclosure; the native one-layout/fade amendment is superseded by [MOBILE-DISCLOSURE-SPEC](MOBILE-DISCLOSURE-SPEC.md#user-review-correction-visible-height-animation). Height uses interruptible JS Animated (native driver cannot animate height); native chevrons, Reduce Motion, fresh checks and450ms handoff remain. No global LayoutAnimation.

2026-10-23 disclosure follow-up: keep scoped query results lazily tracked (withCardBoard); never spread tracked query results inside wrappers. Poll-only observers explicitly use notifyOnChangeProps:[] while independent data observers receive changes/deletions. Native decorative PulseDot loops yield while JS height motion owns a lease, then resume after all leases release. Continuous height/fresh authorization remain; see MOBILE-DISCLOSURE-SPEC and mobile-disclosure-perf-2026-10-23 evidence.

## Mobile project Ideas/Memory initial mounting — 2026-10-23

Bounded Samsung traces show bulk React/native card mounting on project-page entry, not evidence for rewriting disclosure height motion. Native compact Ideas/Memory initially mount two cards across each page, then add two when scrolling within half a viewport of the loaded bottom. Existing Show more (remaining count) is also available for short content/accessibility. Already mounted rows stay mounted, preserving input/disclosure/exit animation state; no timers or background pre-mount of the complete list. Counts, search, filters and sorting use the complete dataset. Changing project/tab/filter/search resets the mount budget; ordinary data changes do not. Memory allocates the shared budget to candidates before active entries. Web/tablet behavior is unchanged (including Ideas closed-list50-row pagination). Render spans project.ideas.render/project.memory.render use existing opt-in timing logs only; no new network work.

Validation: exact frozen source manifests before/after baseline/control/candidate reload and sampling; same Samsung, same project/lane, three opens per page with isolated gfxinfo, synchronized finite Perfetto and idle control; content/vertical scrolling/Show more/filter/Back checks. Hook mounted tests must cover native batching, key resets, stale callback, web bypass, retained row identities and short-content fallback; focused invariants and typecheck before reload. Independent full-access codex/gpt-6-luna tests/audit. No FPS claim or exact JS function attribution from scheduling alone. Continuous220/160ms disclosure, fresh ownership and450ms modal handoff remain unchanged.

Project page row-budget boundary: ignore queued callbacks from another key or prior dataset total; check again inside the updater. Within one key, revealed budget never decreases when data shrinks or a stale callback runs. Visible length is still capped by current total; growing data restores the retained prefix.

Memory 编辑过且仍在当前筛选结果的行额外保留挂载，避免后台新候选挤出前缀后卸载原生输入；计数按实际窗口，初始两条预算不变。

## Native first-board query priority — 2026-10-23

On native, BoardContent starts its ordinary full-board query first. Its six auxiliary readers (session read receipts, resources, live agents, summaries, managed sessions and connections) are enabled only while the root is active and a board value is available. A cached board is sufficient for this scheduling decision: it never authorizes an action. Web keeps the existing parallel reads. Once enabled, query keys, etags, intervals and stream behavior are unchanged; hiding the native compact root still pauses its observers. A failed initial board read does not start these auxiliary readers. Explicit fresh reads, direct-card/session ownership refresh and the direct-card background full read remain independent of this gate.

The board can now appear before session state arrives. Attention must show the existing Loading sessions… state while its agent list is unavailable, or Session state unavailable on initial agent failure; it must not show the empty Attention result or claim that approvals/errors are present without agent data. Its read-state warning is shown only once agent data is available. Complete history and workpads remain in the full-board response. No data projection, timeout, authorization, disclosure animation, input ownership or 450ms modal handoff changes.

Acceptance/checks: retain fixed baseline/candidate source manifests; typecheck before reload; focused query/cache/fresh-link/visibility checks and one independent full-access codex/gpt-6-luna full suite on the final tree; two Samsung cold starts plus Attention loading/result, task/Back and modal navigation smoke. Compare plugin-internal RPC/schema/data-effect intervals separately from UIAutomator selector delays. Report the combined wire/E2EE/host JSON/JS-queue interval honestly: scheduler CPU alone cannot separate those functions, a React effect is not native paint, and first-query priority does not prove FPS or whole-app startup improvement. Evidence: verification/mobile-cold-segments-2026-10-23.


## Native overview read model — 2026-10-23

Native compact ordinary overview now uses a separate BoardOverview DTO/query key/etag. The daemon reuses event rules to produce named facts; live agents/receipts remain immediate. Description search, counts and input/motion semantics remain. Complete Board is activated only by an explicit full-data feature; stage 1 still pays its first-card full-read cost. The prior native first-full-query priority section remains historical; this amendment supersedes it for native compact overview. Web retains complete Board. [Two-stage contract and dependency inventory](NATIVE-OVERVIEW-SPEC.md). Verified on three interleaved Samsung pairs: RPC→React effect median 5978.5→1287.4ms, JSON main response 2330221→166938B, overview/idle full-board calls 0. First explicit card still reads 2330221B and takes 6.16–7.23s to its full-data effect. These are internal stages, not native paint or whole-app startup; live Attention switching is unverified because both versions showed unavailable session state. [Evidence](verification/native-overview-2026-10-23/README.md).


## Isolated client payload loading PoC — 2026-10-24

The default product entry remains unchanged. [CLIENT-PAYLOAD-POC-SPEC](CLIENT-PAYLOAD-POC-SPEC.md) defines a separately reviewable loader, minified client payload RPC and one process-local version/code cache. Contribute starts no network: demand or a 2500ms earliest grace deadline loads code; cached setup RPC waits outside contribute. A visible shell keeps entry/Error/Retry, exact hash version mismatch refuses execution, and cleanup isolates late results. Cache stores no business/authorization results; fresh ownership, continuous disclosure motion and the 450ms handoff remain.

Actual instrumented daemon catalog code was 1,262,031B versus 17,168B loader; executable minified payload 636,177B and its JSON response 650,879B. Every new JS process adds one payload RPC; same-context reconnects observed cache.hit and zero extra payload requests. Two fixed-source Samsung pairs showed earlier contribute (control-to-entry medians 8.112s→4.648s), but later actual Sidebar implementation commit (8.345s→12.218s). Warm network-restore-command to actual Sidebar medians 14.293s→10.268s are combined host/reconnect intervals, not isolated transfer/native paint. Payload RPC began 4.705–6.294s after entry despite a 2.5s earliest deadline; existing markers do not separate timer delivery, loading-state render and microtask queueing, so do not assign the delay to a function without profiling. The PoC is not promoted. First explicit card still used the old full path (candidate RPC→effect 7.086–8.297s); CardDetail stage2 was not implemented in that PoC sample; the independent stage-2 delivery is recorded below. [Results, tests, raw boundaries and restoration](verification/client-payload-poc-2026-10-24/README.md).


原生详情第二阶段（2026-10-24）：普通开卡/chip 直达不再启动完整 board；CardDetail 与 projects.card-index 使用独立类型/key/etag。抽屉子区段通过显式 context 读取，唯一可见 detail interval 为 3 秒；session preview/关闭时暂停。项目 Ideas 使用独立 project query，Memory/Insights 不再以 full board 为前置。完整单卡正文、fresh 写/导航校验、连续动画和 450ms 交接不变。具体边界见 NATIVE-OVERVIEW-SPEC §5/§7。

阶段2固定源三星对照见 [CardDetail报告](verification/card-detail-2026-10-24/README.md)：RPC→schema前区段中位数约5.660s→0.789s，schema约389ms→27ms，但schema→effect仍约1.8s；这些是有限壁钟分段，尚不能区分传输/解密/JSON或函数级挂载成本。原生入口/宿主bundle加载没有在本阶段优化。

## CardDetail interval owner notifications — 2026-10-24

A hook that owns only the visible drawer's3s interval must not subscribe the whole drawer to fetching/result flags. TaskDrawer passes `pollOnly=true` to useCardDetailQuery/detailQueryOptions, which sets `notifyOnChangeProps: []` for that observer only. Separate display/context observers still track data/error/pending, and cache changes, failures, etag reads and fresh authorization are unchanged. No shared/global notification scheduler is changed. Real QueryObserver demonstrates the prior same-etag read's two callbacks; the correction silences the interval owner while display still receives changed data/errors.

Bounded Samsung attribution found sub-millisecond schema→query-cache work, with most residual wall time between cache, render and layout commit. Production React Profiler did not invoke callbacks; component-body/timer markers cannot assign all remaining work to Flowly or host functions. The auxiliary-query gate control showed no supported benefit and was rejected. See [attribution spec](CARD-DETAIL-APPLY-SPEC.md) and [results](verification/card-detail-apply-2026-10-24/README.md); no first-card/FPS gain is implied by fixing repeat notifications.
