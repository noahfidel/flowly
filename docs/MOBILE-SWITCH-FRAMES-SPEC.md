# Mobile task/session switch long frames — 2026-10-23

## 2026-10-24 User decision: unify by width

The user explicitly asked: "No need to verify, optimize uniformly, no special cases, differ only by screen size" (translated).
The current [unified width policy](RESPONSIVE-PERFORMANCE-SPEC.md) replaces this file's old Android-only gate:
every compact Drawer sets removeClippedSubviews, and wide screens turn it off. It no longer waits for separate iOS verification before being enabled.
The Samsung measurements below are kept only as historical basis. They do not prove the new unified version is verified; this round runs no tests or device operations.

## Scope and attribution gate

Continue MOBILE-QUERY-MODAL-SPEC on the same Samsung SM-S911B. First add finite opt-in segment timers to drawer, session preview/transcript, progress and workpad. Measure pre-return synchronous preparation work separately from render-to-effect spans (the latter include descendants, scheduling, commit and effects, and are not CPU profiles). Existing 10-second aggregate logs contain no task/session/message identifiers. No new dependency, API, cache or background poll.

Capture the same current task "Mobile automated testing" and its root session before/after, using warm navigation in the original connection. Android gfxinfo framestats include a bounded 2-second window without hierarchy polling, then read hierarchy for correctness. Record first-ready observation separately: its upper bound includes UIAutomator overhead. Keep invalid/reconnect windows. Do not label p99 a precise individual stall or imply JS/GPU cause from gfxinfo alone. Finite spans plus Android per-frame durations can narrow attribution; claim only what they support.

## Minimal implementation gate

Only after evidence identifies a hot segment, change that segment. Prefer reducing/removing repeated mount work or delaying nonessential offscreen work, without changing visible data freshness. Do not change fresh task/workspace/exact-session authorization, route generation checks, full-board background fresh read, shared etag/cache, or 450ms modal handoff. Native inputs keep ownership; scrolling/section state must remain usable. No unbounded retained session trees. Keep ordinary desktop behavior.

## Verification and errors

Run npm run typecheck before each necessary plugin reload. Focused switch/stream/authorization tests; add a behavior test only for the actual fix. One final independent full-access codex/gpt-6-luna test session runs focused/full suite on stable source and records limitations; root performs device checks. Run comparable task open, preview open, preview back and board back, plus existing modal handoff smoke, on the same phone/card/session. Check failures fail closed, stale async completions do not act as authorization. Mounted race/IME/desktop remain UNRUN unless actually exercised.

Restore performance.log to its prior value, remove only this phase's test session and phone trace files, preserve existing resources and phone stay-awake=15. Record hashes, inputs, commands, observations and limitations in docs/verification/mobile-switch-frames-2026-10-23. No new user-facing capability or guidance change is needed.

## Attributed trial: native detail clipping

Baseline return-2 first 0.7s has FrameCompleted durations 139.3/154.4ms. Its 139.3ms frame spends 84.4ms from DrawStart to SyncQueued; issue-to-completion is 3.7ms. Own drawer function max4.1ms vs subtree/effect max200.9ms. This narrows the repeated task-remount cost to the native view/display-list path, not an RPC wait or expensive own-function calculation. It does not identify a particular leaf or prove GPU saturation.

Minimal trial: set removeClippedSubviews only for Android compact TaskDrawer ScrollView; desktop unchanged. Keep the React tree/state mounted and every query/auth/timer unchanged. Compare same early0.7s snapshots before hierarchy polling. Earlier2s snapshots can overwrite the first frames in Android's120-frame ring, so use their aggregate histogram only. Scroll down and back through lower sections and collapse/reopen to check for missing content during transforms. Revert the trial if comparable frames do not improve or content disappears.

Final gate is Android compact only, matching the attributed device; iOS/web/noncompact explicitly pass false. No React child remount, data fetch, authorization or modal timer is added by clipping. The `switch.*.own` diagnostics end before returned JSX construction; they are preparation spans, not complete own-component CPU samples. First0.7s snapshots are the comparison; the later hierarchy read tests expected controls but is not a visual pixel correctness proof.
