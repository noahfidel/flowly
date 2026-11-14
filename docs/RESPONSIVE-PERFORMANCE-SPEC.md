# Unified performance policy by available width

2026-10-24 the user decided: do not verify a platform first and then turn things on platform by platform; the Paseo/Flowly performance policy is unified,
and only the screen/container width decides the form of presentation. This decision replaces the earlier Android-only,
native-only and web-bypass performance gates in the earlier optimization specs. This round runs no verification and does not install or reload the plugin.

## 1. The single layout decision

`isCompactLayout(width)` accepts only the available logical width: below 760 is the compact layout, 760 and above is wide.
When the container width has not been measured yet, use the window width; when both are unknown, use the compact layout.
The root layout, the menu and the direct-card route share the same container-width source, so that one screen never has two compact decisions.
The host's compact flag and the Android/iOS/Web identity no longer override a known width.
The layout follows the window/container width; no device tier, platform allowlist, setting, framework or cache is added.

## 2. Existing paths after unification

| Location | Unified rule |
|---|---|
| Board / direct card | All compact layouts use the existing separate Overview / CardDetail / lightweight project context; wide screens keep the full-board presentation path; DTO/key/etag stay isolated from each other |
| Covered Board | In the compact layout, pause the board's own query/stream while the detail, project page or form covers it; on wide screens the visible board stays active |
| Drawer | All compact layouts turn on the existing off-screen clipping; only a visible detail view that has not entered session preview takes over polling, to avoid duplicating the wide-screen root's polling |
| First-screen auxiliary queries | In the compact layout wait for the main data before starting; wide screens keep them parallel. No explicit fresh read is affected |
| Ideas / Memory | All compact layouts keep the first 2 items, +2 per batch near the bottom, and the Show more fallback; wide screens keep the existing list. The filter / sort / full count and the edit-row keep rules are unchanged |
| Sidebar Attention badge | All layouts uniformly read the existing lightweight attention.count; delete the branch that read the full Board/agents/receipts only for the Web badge |
| TaskForm | All platforms uniformly start the heavy content and requests after the existing enter transition has settled; the Title/Description nodes, cancel and Create gating are kept |
| Shared dot matrix / breathing dot | With a host window <760, height animation has priority; >=760 keeps the same clock playing continuously, with no restart on card open / height or resize notifications. Unified by window width, not by OS; see MOBILE-SMOOTHNESS-SPEC §7 |

Platform input methods, keyboard coordinates, file picking, shortcuts and the driver compatibility of React Native Animated still work through their own APIs;
these are capability adaptations and are not used to choose different performance policies. API call constraints must not be broken just to remove a platform name.

## 3. Invariants and visible behavior

Do not change storage, RPC/schema, fresh task/workspace/session ownership, send authorization, failure rejection or route-expiry protection.
Keep the Overview/CardDetail boundary, the existing history body and description search; the live Attention card face still combines live agents and receipts.
Keep the 220ms expand / 160ms collapse, interruptible / reversible, Reduce Motion, input/scroll identity and the 450ms modal handoff.
Narrow-window Web and iOS now use the same loading, progressive list and clipping policy as Android at the same width; wide screens are not forced to switch by the host's compact flag.
The Sidebar count keeps its lightweight read every 15 seconds on all platforms, an error/unknown is still null, and the entry point and badge actions are unchanged.
This round has no new feature entry, setting or copy, so no new tour/tip/What's new is needed.

## 4. Change boundary and delivery

Change the existing layout decision and its call sites, and the Board/Drawer/page/form/breathing-dot/Sidebar performance gates;
sync the contracts and naming of the existing geometry/query-activity tests, and add no test framework or temporary fixture.
The existing internal flag `CardDetailProvider.native` means using the separate detail context; it is now passed in by compact
and no longer decided by the OS; this round does not extend renaming that flag to all detail consumers.
Update the current decisions in the related specs; the old real-device records are kept as history and are not treated as new evidence for the unified version.

As the user explicitly asked, this round runs no typecheck, focused/full tests, real-device or Luna verification, and does not build, install or reload.
Delivery records only the source changes and the unrun items, and does not claim passing multi-platform tests or a new performance gain.

## 5. Follow-up authorization on 2026-10-24: reload, test and commit

The user then asked "reload and test. After confirming there is no problem, commit and push" (translated), lifting the earlier no-verify / no-reload limit.
First typecheck, then reload only flowly and not the daemon; on the same Samsung and on wide/narrow Web check the entry, card open,
Progress/Idea open/close, project page, session preview and Back, the 450ms modal handoff and the error log.
While real iOS is not connected, state UNRUN explicitly, and do not use Web/Samsung as a stand-in for an iOS test.
Reuse the existing contract tests, and an independent full-access Luna runs focused tests and one full run on the exact tree to be committed.
The shared working tree holds other work, so the commit is built as an isolated tree from the latest origin/main, taking in the necessary performance dependencies such as Overview/CardDetail,
and leaving out the unrelated Insights, version number and model settings; the whole dirty working tree is not committed.
After the exact tree passes typecheck/npm test, push the branch, create the PR, and finish the checks and squash merge by the repository rules.
Keep the non-target bytes, clean up the owned test sessions, temporary worktrees and browser contexts, and do not clear the shared caches.

A counting boundary found in verification: when the wide-screen cached full Board has the same revision as the overview, the metadata may keep selecting the full Board.
In that case the Ideas badge must count from that full source, and must not show 0 just because the compact layout's project Ideas query has not started yet.
The projection and the full source must follow the same project scope and open-state rule; a newer full deletion still takes priority, and no extra read or cache is added.
