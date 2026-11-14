# Animation smoothness: limited comparison and minimal fix

On 2026-10-24 the user asked for a new round of optimization based on actual smoothness. This continues
[width unification](RESPONSIVE-PERFORMANCE-SPEC.md) and [continuous height](MOBILE-DISCLOSURE-SPEC.md).
Opening sooner, finishing a feature or passing unit tests does not replace animation acceptance.

## 1. Scope and invariants

The same Samsung SM-S911B, official Paseo 0.12.0, the original connection, plugged in and kept awake, system animation scale unchanged.
Use this card's existing Progress content and section open/close, non-empty Idea content, plus opening a card, session preview and Back.
Create no business resources, send no messages, change no task body; the fixture remains this card / Tinylink.
Keep fresh task/workspace/exact session authorization, separate Overview/CardDetail, description search, live Attention,
the reversible 220/160ms continuous height, input/scroll identity, Reduce Motion and the 450ms modal handoff.
All performance behavior stays unified by available width, with no platform branch, dependency, cache, setting or framework added.

## 2. Attribute first

The current HEAD e0c693d added the running-state dot-matrix sweep (RunningDots/useMarquee). The existing height-animation lease
pauses only PulseDot; the new loop did not use this lease, and when the compact board is covered by the detail view the tree is still kept.
This is a source-code fact, not a confirmed on-device cause. First, in a frozen copy, turn off only the dot-matrix loop/layer as a counter-control,
and compare open/close and idle. If there is no consistent gain, then compare only drawer clipping or the added mount timing; never change both at once.
The existing shared-thread boundary between decryption, React and native painting stays; do not infer JS function causes from gfxinfo or whole-window thread CPU.

## 3. Sampling and versions

First save the root source hash/HEAD/dirty state, the original bytes of the entry, and the device state; copy the entry, client/server/shared and build config
as this round's baseline, reuse the root node_modules, and do not copy dependencies or create caches. A source change gets a separate candidate.
The host module allowlist requires the running copy to sit under client/server: use this round's owned `.perf-smooth-f4e2dd52`
subdirectory, with files matching the frozen manifest item by item; an evidence copy in docs cannot be used directly as a host import path.
Bridge the frozen copy temporarily only while the original entry still matches the bytes this round holds; if another session changes the entry, disable the bridge and never overwrite it.
At the end restore the entry's original bytes; the final product applies only the accepted minimal hunk, and other dirty files are preserved with a per-file hash.
typecheck passes before each reload of a changed install input. Reload only flowly; do not restart the daemon or replace the app.

Diagnostics only in the frozen copy: register a bounded read-only runtime receipt; contribute schedules the receipt once after 4s and
does not go to the network immediately; cleanup cancels the timer, failures are ignored and do not affect business results. The receipt holds variant/build/run/platform
and no body text or credentials; the catalog hash is correlated with the runtime receipt, confirmed and quiet before warm sampling; no per-frame network or logging.

Reuse Artemis's uiautomator2 environment. Each time, find the visible target fresh, record the allowlist labels/bounds and the result predicate,
and never save the raw hierarchy body or the host's private sidebar. Before measuring read the screen, then go quiet, then reset gfxinfo, perform the input action,
wait about 550ms, read framestats first, and only last do the final-state screen read; the actual control window duration must be kept.
Frames with Flags=0 and FrameCompleted>IntendedVsync are used for the distribution; empty frames, ring overflow, target off screen / wrong start point,
and an unconfirmed final state are marked INVALID/UNVERIFIED, and zero frames are not counted as a speedup. The UIA completion upper bound is not used as touch/paint time.

At most 3 groups of Progress content, 3 groups of Progress section, 2 groups of Idea content, each open/close; baseline and candidate take the same path.
2 idle windows per condition; a necessary reverse control picks only the most obvious path, and the first round targets no more than 42 windows.
When needed, take a 3s Perfetto sched/gfx/view trace only for idle or the problem path, with clear tool ownership, so forensics do not cover the whole set of actions.
The report gives per path the samples/valid frames, p50/p95/max and the long-frame count, and keeps the raw samples; idle share or a few max values are not FPS.
Look at the actual action segment first, then the tail work; bounded video only when the user / screenshot rules allow it and privacy is controlled.

## 4. Admission of the minimal candidate

If the dot-matrix control supports paint contention, only reuse the existing height lease or the existing visibility context, pause the decorative loop,
and resume the original dot-matrix/breathing effect once the geometry is stable. Avoid unmounting/rebuilding all the dots because of the pause; do not remove continuous height,
shorten the duration to hide stutter, or use a global LayoutAnimation. If the gain comes from fewer invisible dots, limit it to when truly covered.
A path where no dots appear cannot be explained by this control; the clipping/mount hypotheses each need their own comparison, and the list must not be rewritten along the way.
The candidate must improve the located path with no content loss, remount long frames or navigation regression; if mixed or insufficient, keep the conclusion and withdraw the candidate.

## 5. Acceptance, failure and cleanup

First the necessary focused checks, then a stable full-access codex/gpt-6-luna independent acceptance. Luna writes only the luna-* evidence in this directory,
does not operate the device / implement / touch the daemon, and no new verification session may join the running list during phone sampling; the parent does the exact cleanup.
The existing renderer may be reused, the temporary prefix is limited to this evidence directory, the shared npm cache is kept, and the temporary renderer is cleaned up in finally.
If a lease is used, mounted tests cover overlap/reversal/stale callbacks/end/cancel/unmount, Reduce Motion, and wide and narrow consistency,
the pause does not change body identity, the dot nodes are not rebuilt by the pause; resuming starts a new sweep lap, keeping the original look/period.
When the last user of the shared loop truly exits it is zeroed, and the height lease subscription is cleaned up.

Independent mounted v1 counterexample: within one synchronous reversal, the gap between the old lease's release and the new lease's hold extra-starts and then stops the sweep.
v2 moves the resume only to the end of one microtask, then rechecks the existing users/busy/loop; the pause still takes effect immediately, and no new timer or state is added.
Keep that failing assertion and the log. After Luna finishes the v2 acceptance and cleans up the session, add at most 4 frozen v2 phone windows, so that extra session grids do not mix in.
If the raw independent Luna audit of those 4 windows is not done, state UNRUN explicitly; the parent's recomputation does not pose as an independent audit.

Check commands: `npm run typecheck`; `node docs/verification/mobile-smoothness-2026-10-24/luna-run-mounted.mjs`
(if the candidate touches the lifecycle); `npx vitest run --exclude 'docs/verification/**' client/running-geometry.test.ts client/query-activity.test.ts client/card-detail-query.test.ts client/session-link-query.test.ts`;
one `npm test` for a stable candidate; `python3 docs/verification/mobile-smoothness-2026-10-24/analyze.py`;
phone sampling entry `docs/verification/artemis-2026-10-22/runtime/artemis/.venv/bin/python docs/verification/mobile-smoothness-2026-10-24/phone.py`.

Keep failures, tool errors, unrun checks and passes separate. Real iOS, IME, system Reduce Motion and function-level profiles stay
UNRUN when untested; a synthetic renderer does not stand in for visual continuity. Keep the boundaries and existing features; no new tour/tip/What's new.
Output the README, source/runtime identity, raw gfx / optional trace, comparison analysis and cleanup receipt; clean up all owned temporary copies/tools/
verification agents, and keep persistent evidence in the local docs/verification. The user later authorized committing only this fix and its spec,
accepting it in an isolated tree on the latest origin/main and then going through PR review and merge; no other session's resources or changes are brought in.

## 6. Execution results and bounds

2026-10-24, Samsung, fixed source, 41 windows in total: 37 have valid start/end state and window, 1 is a layout-drift observation, 2 are unconfirmed,
and 1 is invalid because the window was too long. Valid does not mean the performance target is met; windows include the idle tail and do not represent exact touch latency or per-animation FPS.

| Body open/close | Original baseline longest frame, two runs | Final v2 longest frame, two runs |
|---|---|---|
| Expand | 42.43 / 31.87ms | 59.07 / 25.15ms |
| Collapse | 39.28 / 39.62ms | 26.13 / 28.21ms |

The reverse baseline collapse was 34.80/26.33ms, which overlaps the candidate, so it supports only a local reduction of paint contention.
Expand showed no stable improvement, the section collapse still has about 40-48ms, and the Idea 125ms window's start/end state is unconfirmed, so it does not count as a successful comparison.
In the v1 synchronous trace, the RenderThread on-CPU in the 500ms after the first captured vsync was baseline 323.41ms, still dot matrix 253.09ms,
candidate 274.29ms; JS still has long runs. Non-JS function / React subtree / exclusive GPU attribution: do not rewrite height or lists on this basis.

The earlier round's independent full-access Luna acceptance on the shared dirty tree: v2 mounted 8 items, root focused 22 items, full 1024 items PASS,
374 source hashes stable; the zero-extra-loop-start assertion on reversal is kept. The old 140 captures / 37 windows independent audit passed, the final 161 captures /
41 windows were recomputed by the parent, and the independent audit of the 4 added windows is UNRUN. Real iOS/IME, system Reduce Motion, pixel continuity, FPS and function attribution are UNRUN.
This shipment runs typecheck and the full suite separately in an isolated tree on the latest main, and does not use the test count of the shared dirty tree as shipping verification.

The device runner, renderer, trace and analysis commands above in this spec record a one-off local acceptance method; the scripts and raw device data
are kept in the local forensics directory, and are not tools shipped with the repository or downloadable attachments. The repository's regular checks are `npm run typecheck` and `npm test`.

## 7. User feedback fix: wide screens keep shared animation continuity

When the user opened several cards in a row on a real device, the running-state dot matrix replayed from the start again and again. The cause: any height lease stops the global shared loop,
and an explicit phase 0 is allowed after resuming; this is a visible cost of the current policy, not an exact pause-and-continue. The existing limited Samsung samples support only a local
body-collapse longest frame of about 39ms to 26-28ms, with expand unstable; there is no wide-screen A/B or overall FPS gain evidence, so wide-screen continuity must not be sacrificed for it.
This section replaces the earlier "all widths always yield" and keeps the historical device data and its bounds.

The shared decorative clock is a resource at the level of the current host window: by the window logical width that React Native Dimensions provides, reuse
the 760 breakpoint of isCompactLayout, not the width of a single card / narrow drawer. An unknown window width counts as 0, that is compact;
the existing container-layout decisions of the board / menu / direct detail are unchanged. Do not fork by Android/iOS/Web or desktop identity.

- Window width >= 760: height motion does not pause the dot matrix or the breathing dot. Keep the same running loop and phase; opening cards in a row, closing,
  reversal and height lease notifications do not stop/start or zero it; a newly added dot-matrix consumer shares the existing clock. The last consumer truly exiting still cleans up / zeroes.
- Window width < 760: keep the current height priority, the overlap/reversal microtask check, a pause that does not unmount the grid, and a new lap from phase 0 after the end.
  This round introduces no native phase read-back, remaining-time replay or second clock.
- Reuse the existing height state listener, keep one window-size subscription only while there are consumers, and remove it when the last subscriber exits.
  A change of window width recomputes busy at once; a wide-to-wide resize or a resize with no height animation must not restart the loop; narrow-to-wide resumes from pause only once,
  and a later release of an old lease must not restart it. A resize does not interrupt the height animation itself.
- Reduce Motion, the 220/160ms continuous height, fresh ownership, the 450ms handoff, and body/input/scroll identity are unchanged.
  No new RPC, network, dependency, cache, setting, timer, per-frame callback or animation framework; no tour/tip/What's new.

The implementation changes only motion.tsx and syncs the existing specs. First typecheck, then a full-access codex/gpt-6-luna mounted run covering
the 760 boundary, zero extra start/stop/zeroing across repeated wide-screen navigation / height actions, leases during resize, compact reversal, Reduce Motion and subscription cleanup;
the necessary focused checks include geometry/running-geometry/query-activity/card-detail-query/session-link-query.
The commands and the before/after source hashes are recorded in verification/marquee-width-2026-10-24.
Reload only flowly, do not restart the daemon, create no business resources; if the non-fullscreen window cannot be bound unambiguously, the real UI stays UNRUN.
A mock loop count does not prove pixel continuity or FPS. There is no new phone performance budget, and no repeating an unrelated full / platform matrix. The user then explicitly asked to stop adding tests and merge: keep the completed results, stop adding local verification, and ship only this fix and spec selectively through the repository PR flow, bringing in no other session's changes.
