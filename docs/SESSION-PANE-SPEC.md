# Session pane: history, keyboard, scroll performance (design)

Status: **implemented (2026-10-20), phone verification pending**. Card: "sidebar session 优化" (`004da2f8`).
Supersedes the "35 timeline entries / 18 displayed entries" limit in `SESSION-UX-SPEC.md` §95, and on phones the "padding when the keyboard animation finishes" rule in `PERFORMANCE-SPEC.md` §3 (Client rendering).

**Decisions (user, 2026-10-20):** §5.1 and §5.2 as recommended (open on the current turn capped at 300 entries; an explicit Load earlier row). §5.3: go straight to `FlatList` virtualization instead of a render window first. Implementation follows Paseo's own session view (found in its bundle): phones use an **inverted** virtualized `FlatList` with `maintainVisibleContentPosition`; web keeps a plain scroll view (Paseo's web session view is not virtualized either, and `maintainVisibleContentPosition` does not exist on react-native-web). The inverted list also changes the keyboard design: see §2.2 (as built).

User reports:

1. The session pane only shows the last few messages; the current turn cannot be read in full.
2. Phone: while typing, the transcript does not move up with the keyboard, so the composer covers the last lines.
3. Phone: scrolling the session pane stutters.

## 1. History

### 1.1 Cause

- `client/session-preview.tsx:271` reads `sessions.tail` with `limit: 35`, and `recentSessionOutput` (`client/session-state.ts:120`) keeps only the last **18** displayed entries.
- A running turn is mostly tool calls. Measured on this host (read-only spike against the local daemon, 2026-10-20): in a 15-entry tail of a running Codex session, 13 entries were tool calls. Whole turns contain 4 to 1000+ projected entries (e.g. 80 entries: 1 user message, 23 agent messages, 48 tool calls, 6 reasoning). 18 entries are therefore often only the last few seconds of tool calls plus one or two agent messages, while the turn's earlier explanations are cut off.
- The tail is a fixed window: there is no way to page back from the plugin.

### 1.2 Feasibility (verified)

The SDK's `agent.timeline.refetch` (`@getpaseo/client` 0.11.x, protocol `fetch_agent_timeline_request`) supports `direction: "tail" | "before" | "after"` with a `cursor: { epoch, seq }`, and the response carries `epoch`, `startCursor`, `endCursor`, `hasOlder`, `hasNewer`, `reset`, `gap`. Spike results:

- `tail 15` + `before(startCursor) 15` equals `tail 30` exactly (same `seqStart`s, no duplicate or split entry at the page boundary).
- `after(cursor)` returns only entries whose range ends after the cursor, so an incremental refresh is possible. A streaming agent message grows its `seqEnd` (e.g. `1000-1017`), so the refresh must start before the last entry's `seqStart` to re-read it whole.
- Size: slimming (`shared/session-tail.ts`) reduces whole turns dramatically: 1000 entries = 3.5 MB raw → ~69 KB slim; 80 entries = 443 KB raw → 8 KB slim. Paging happens on the daemon (local), so the phone only receives the slim result.
- `listAgentTimelinePrompts` returned no prompts for these sessions; it cannot be used to find turn starts.
- Some long sessions had no `user_message` within 1000 projected entries (long autonomous turns, compactions), so "load the whole turn" must be capped.

### 1.3 Proposed behavior

- **Open**: the pane loads the **current turn**: from the latest user message to now, capped at 300 entries (whichever comes first). The daemon does the paging in one RPC call, so the phone makes one request.
- **Load earlier**: a "Load earlier" row at the top of the transcript reads one older page (100 entries) per press. It disappears when `hasOlder` is false. Loaded history is capped at 1000 entries per open session; beyond that the row says "Open in Paseo for the full conversation".
- The prepend keeps the reading position: native uses `maintainVisibleContentPosition` (`{ minIndexForVisible: 0 }`, supported on iOS and Android in RN 0.81); web compensates the content-height difference with one `scrollTo` after layout.
- The 18-entry display cap is removed; consecutive thinking/tool entries still collapse into one activity block, so rendered blocks ≈ agent/user messages.
- The header line "Recent output · open in Paseo for the full conversation" becomes "Current turn" plus the Load earlier row.
- Older pages are immutable and not polled. Only the live end refreshes (see §3).
- An `epoch` change, `reset` or `gap` drops the loaded pages and reloads the current turn (the timeline was rewritten, e.g. by compaction or a reload).

### 1.4 Data contract

`sessions.tail` gains optional fields (existing callers, e.g. card output, keep working):

```
input:  { taskId, agentId, limit (1..100),
          mode?: "tail" | "turn" | "before" | "after",   // default "tail"
          cursor?: { epoch, seq },                        // before/after
          maxEntries?: number (≤ 300) }                   // turn
output: { entries: TailEntry[] (+ seqEnd),
          epoch?: string, startCursor?: {epoch,seq} | null,
          hasOlder?: boolean, reset?: boolean }
```

- `turn`: the daemon pages `before` in steps of 100 until it finds a `user_message`, `hasOlder` is false or `maxEntries` is reached, and returns the slim entries from that user message on.
- A slim entry may carry `from { id, title?, event }` with the sent text: a prompt another agent sent to the session (Paseo's `agent_message` tool call). The transcript shows it as its own `From <agent title>` row (the id when untitled), outside activity blocks: one muted line with the first line of the text, press to expand the full text.
- Membership check unchanged (session must be in the card's workspace).
- Errors stay English daemon errors. A stale cursor (`staleCursor`) returns `reset: true` and the client reloads.

### 1.5 Alternatives considered

- Raise `limit` to 100 and drop the 18 cap: one-line change, but still misses long turns and makes every live refresh up to 3× larger (worse for §3). Rejected as the full fix; acceptable only as a stop-gap.
- Auto-load older pages when the user scrolls to the top: smoother, but on phones a fling to the top would load pages repeatedly and shift layout during momentum. Proposed as a later option; the explicit row comes first.

## 2. Keyboard covers the last lines (phone)

### 2.1 Cause

`useKeyboardInset` (`client/keyboard.ts`) lifts the composer with a native-driver `translateY`, but the transcript `ScrollView` keeps its full height underneath. The transcript only gets `paddingBottom: inset` **after** the keyboard animation finishes (a deliberate PERFORMANCE-SPEC choice to avoid layout mid-animation), and its scroll offset only changes through `scrollToEnd` when the tail follower is in "following" mode (`client/session-follow.ts`, within 64 px of the end). Consequences:

- Following: the composer slides over the last lines, then ~250 ms later the transcript jumps to the end (not synchronous).
- Not following (the user scrolled up even slightly to read the last reply, which is typical when starting to type): nothing moves at all; the bottom `keyboard height` of the visible transcript stays covered until the keyboard closes.
- Android with a host resize (`adjustResize`): the pane's viewport shrinks from the bottom and the content is not shifted either, unless following.
- The same happens, at a smaller scale, whenever the composer grows (multi-line input, attachments, next-move chips, an error notice).

### 2.2 Proposed behavior: bottom anchoring

Whatever the user was looking at the bottom of the transcript stays visible when the space below it changes.

- On the keyboard's **start** event (iOS `keyboardWillChangeFrame`, Android keyboard-controller `keyboardWillShow`), the hook reports the new lift Δ at once. The transcript applies the bottom padding immediately (one layout, not per frame) and scrolls by Δ with a native animated `scrollTo({ y: y + Δ, animated: true })`, so the content moves with the keyboard (iOS and Android both animate the scroll natively, ~250–300 ms, matching the keyboard curve closely).
- On hide, the padding is removed when the animation ends (as today); the offset clamps naturally, so the reading position does not jump.
- The same Δ rule applies when the transcript viewport shrinks for any other reason (host resize, composer growth): `onLayout` of the transcript compares heights and scrolls by the difference.
- Not while the user is dragging or flinging (the follower already tracks this).
- Reduce Motion: non-animated scroll.

### 2.2a As built (phones, with the inverted list)

An inverted list counts its offset from the newest output, so shrinking it from the bottom keeps the newest output in place by itself. The transcript is wrapped in a clipping view and moved with the **same native-driver value** as the composer (`translateY: keyboard.translate`), so it rises exactly with the keyboard, whether the reader is at the end or scrolled up. While the keyboard is up, the top end of the list gets a spacer of the settled lift (added when the keyboard animation finishes; in an inverted list that changes nothing on screen unless the reader is at the very oldest output), so the oldest loaded output stays reachable. A host that resizes the view (Android `adjustResize`) or a growing composer shrinks the list, and the inverted list again keeps the newest output in place. The design's scroll-by-Δ approach (§2.2) is therefore not needed on phones. Web has no on-screen keyboard handling (unchanged).

### 2.3 Alternatives considered

- Translate the transcript with the same `Animated` value as the composer: rejected for a normal list (the top Δ becomes unreachable, and swapping the transform for layout jumps), but **chosen for the inverted list** (§2.2a): its top-end spacer restores reach without moving anything on screen, so no swap is needed.
- iOS `automaticallyAdjustKeyboardInsets`: iOS only and does not know our translated composer. Rejected.
- Reanimated / keyboard-controller `KeyboardAwareScrollView` (what Paseo itself uses): plugins cannot import them (AGENTS.md). Not available.

### 2.4 Feasibility / risk

Medium-low. The keyboard hook already receives the start events with the final height and duration; the change is one immediate padding update and one scroll per keyboard change. Risk: the native scroll animation's curve differs slightly from the keyboard's; acceptable. Must be verified on a real iPhone and Android phone (simulators do not reproduce the Android IME timing).

## 3. Scroll performance (phone)

### 3.1 What the code does today while a session pane is open

- Every timeline stream event (coalesced to one per 400 ms while the agent runs) refetches the **whole** 35-entry tail, decodes it on the JS thread (relay E2EE), validates it, and builds a new transcript array.
- That result lives in the 1500-line `SessionPreviewView` component, so each refresh re-renders the whole pane (header, notices, composer, chips, queue), not just the transcript. The transcript and its entries are memoized, but the root work still runs every 400 ms.
- The transcript is a plain `ScrollView`: every block is mounted and laid out, including long markdown messages and horizontal table scroll views. Today this is bounded by the 18-entry cap; §1 removes the cap, so §3 must land together with §1.
- While following, every content-size change calls `scrollToEnd` (non-animated), which can fight a finger that is already moving (the follower only stops following after an upward move).
- On phones, the board stays mounted under the open card/session (by design, for a fast Back) and keeps applying board patches from its polls.

### 3.2 Hypotheses, ranked (to confirm with measurements before and after)

| # | Hypothesis | Evidence | Fix |
|---|---|---|---|
| P1 | JS thread busy with the 400 ms full-tail refresh + whole-pane re-render while a session runs, so scroll events, the follower and touches lag | Code path above; jank reported mainly on phones (relay decode in JS) | Incremental refresh (`after` cursor from the last entry's `seqStart`), merged by `seqStart`; periodic full tail reconciliation stays at 15 s |
| P2 | The pane re-renders as a whole for transcript data | `timeline` query lives in `SessionPreviewView` | Move the timeline query, follower and transcript into their own memoized `Transcript` component; the header/composer no longer re-render on output |
| P3 | `scrollToEnd` fights the user's finger | `onContentSizeChange={scrollToTail}` without a drag check | Do not auto-scroll while dragging or during momentum; coalesce to one scroll per frame |
| P4 | Layout of all mounted blocks (grows with §1) | Plain `ScrollView`, no virtualization | Render window: render the last 60 blocks; "Load earlier" first reveals already-loaded blocks before fetching. Switch to `FlatList` only if measurements show layout still dominates |
| P5 | The hidden board keeps re-rendering under the session | Board stays mounted on phones | While a session is shown full-screen on a phone, pause the board's polling interval (keep the cache) |

### 3.3 Measurement plan

- Enable the plugin timing log (`performance.log`, `client/perf.ts`) and add spans: tail fetch + decode, transcript render, pane render count per 10 s.
- Android: RN perf monitor (UI/JS FPS) while scrolling a running Tinylink session (the long-lived fixture; add a temporary session and remove it after) and an idle long session, before and after each fix.
- Acceptance target: no dropped JS frames during scroll with an idle session; JS FPS ≥ 50 while scrolling a running session; pane re-renders only on transcript changes.

### 3.4 Alternatives considered

- `FlatList` (optionally `inverted`) from the start: gives virtualization and natural bottom anchoring, but variable-height markdown causes blank areas and position jumps on fast scroll-back, `inverted` has web wheel/selection quirks, and `maintainVisibleContentPosition` is not implemented on react-native-web. Kept as step 2 only if P4 measurements require it.

### 3.5 As built

- P1: `sessions.tail` modes `turn` / `before` / `after` (`server/session-tail.ts`). The client (`client/session-timeline.ts`) reads the current turn once, then each stream event (coalesced 400 ms) reads only `after` the 8th-newest entry (`REFRESH_OVERLAP`, so late tool-call status changes are picked up) and merges by `seqStart` (`shared/session-tail.ts`). A new epoch, reset or more than one page of new entries reads the current turn again. Load earlier and refreshes merge into the latest cached window, so neither undoes the other.
- P2: `client/session-transcript.tsx` owns the transcript query, stream subscription, follower and list. The session view passes primitive props and a content-compared notice list; output refreshes no longer re-render the header and composer.
- P3: the follower never scrolls while the user drags (`client/session-follow.ts`). On phones the inverted list needs no follow scrolling at all; `maintainVisibleContentPosition` (`autoscrollToTopThreshold` 64) keeps the reading position when scrolled up and follows at the end.
- P4: phones render 6 blocks first, batches of 6, window 9 screens. Web renders every loaded block in a scroll view and keeps the reading position when older output is added (content-height difference).
- P5: not done; measure first (board work under an open session).
- Display cap removed (`recentSessionOutput`); "Load earlier" stops at `HISTORY_MAX` (1000 entries) with "Open in Paseo for the full conversation".
- Onboarding: one-time tip `session-history` in an open card that has a session (`docs/ONBOARDING-SPEC.md`). Tour unchanged.

## 4. Delivery order and estimate

1. §3 P1–P3 (refresh + component split + follower): independent, lowers risk for the rest. ~1 day.
2. §1 history (daemon `turn`/`before`/`after` modes, Load earlier, render window P4). ~1.5 days.
3. §2 bottom anchoring. ~0.5–1 day, plus device verification.
4. P5 if measurements still show board work during session scroll.

Each step: focused tests (`shared/session-tail` merge/paging, follower anchoring math, daemon `turn` paging with a fake timeline), `npm run typecheck`, `npm test`, plugin reload, and verification on desktop web + compact + a real phone (Luna test session per AGENTS.md). New strings ("Load earlier", "Current turn", …) go into all catalogs. Onboarding: a one-time tip for "Load earlier" is warranted (headline change to what the pane shows); tour copy unchanged.

## 5. Open decisions for the user

1. Default content on open: **current turn, capped at 300 entries** (recommended) vs. a fixed number of entries.
2. Older history: **explicit "Load earlier" row** (recommended) vs. auto-load when scrolled to the top.
3. Whether to start with the render window (recommended) or go straight to `FlatList` virtualization.

## 6. Images in first messages (user request, 2026-10-21)

Request: phones cannot attach images to a session message; New task (with its first agent) and the sidebar's New session cannot attach images at all.

- **Web / desktop (done):** New task's agent instruction and New session's instruction take images like the session composer: paste or drop on the field, or **Add images** (browser file chooser), at most 4 per message, PNG/JPEG/GIF/WebP up to 5 MB each, thumbnails with remove. They are sent with the session's first message (`agents.create({ images, clientMessageId })`), and the transcript shows them beside that message (`rememberSentImages`). Shared code: `client/image-attach.tsx` (`useImageAttachments`, `ImageAttachments`, `AttachmentThumb`), reading files through `client/web-images.ts`.
- **Phones (not done, user decision 2026-10-21):** a plugin's client code may import only `react`, `react-native`, `@getpaseo/plugin*`, `@tanstack/react-query` and `zod` (host module loader); the SDK has no image picker. The only route would be the host's own `expo-image-picker` native module (`globalThis.expo.modules.ExponentImagePicker`, which Paseo's composer uses), a reliance on Paseo internals. The user declined that exception: phones keep no image button until the SDK offers a picker.

## 7. Phone fell back to the plain scroll view (2026-10-23, user report; confirmed fixed on device)

Symptom: on a phone the transcript did not rise with the keyboard. Cause: `virtualized` tested `typeof FlatList === "function"`; the host's FlatList is not necessarily a plain function (memo/forwardRef objects fail the test), so phones silently used the non-inverted `ScrollView`, which has no keyboard lift. The test is now `!!FlatList`. Together with Android `keyboardDismissMode: "none"` (scrolling no longer closes the IME), the transcript rises with the composer when the reader is at the newest output, and can be scrolled while typing.
