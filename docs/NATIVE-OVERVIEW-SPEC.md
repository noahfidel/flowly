# Native overview and standalone detail: two-phase implementation spec

2026-10-24 follow-up user decision: the [unified width policy](RESPONSIVE-PERFORMANCE-SPEC.md) extends this file's
native compact path to the compact path on all platforms, including narrow-window Web; wide screens keep the full board.
This file's old "web/tablet unchanged" wording and the existing real-device verification are historical scope, and the current layout is decided by width.
The types, keys, etags and fresh authorization boundaries of Overview/CardDetail/the full Board stay unchanged.

Status: 2026-10-23 the user authorized the full spec and the phase 1 implementation, with a comparison against the same fixed Samsung source; 2026-10-24 the user authorized the phase 2 implementation and a retest against the same fixed Samsung source. Basis: [Fable/Astra consensus](verification/frontend-loading-advisors-2026-10-23/README.md). This spec's clauses on the native compact overview take priority over the historical clauses in PERFORMANCE/NATIVE-SESSION/MOBILE-QUERY-MODAL that say "entering the board first reads the full board", and web/tablet keep their original behavior.

## 1. Goal, scope and cost

- Phase 1: the phone overview uses an explicit BoardOverview, and does not read the full board at first display or while idle; keeps description/tag search, filters, sorting, lane and project counts, card face signals, live Attention, prompts and navigation.
- Phase 1 baseline: when the user explicitly opens a card, a Task/Project form, LinkPicker, delete/remove/wrap-up, project Ideas/Insights/Memory, or an idea/workspace direct link, the old full Board may be used. The detail components keep their existing data and lifecycle, and do not block the current scoped-card navigation.
- Phase 1 baseline cost: **the first explicit card open may add several seconds of waiting**: the cost moves from entering the board to the first card open, and the old full path is still about 2.3 MB. The RPC/first display/detail availability of the first card open must be listed separately; it must not deliver only a nicer overview number.
- Phase 2: a standalone CardDetail and a project index remove the implicit whole-board dependency of detail; implemented per §5/§7.
- No storage migration/deletion/modification, no change to the at-most-100 events with body per card, no new Activity paging, no change to business write paths, session ownership, input keys, continuous reversible animation and the 450ms Modal handoff. The cache is for display only.

## 2. Data dependency list

"Overview" includes the project chooser, the status/filter/sort/Attention sheets and the card action sheet; merely opening these menus should not load the whole board. Settings/Welcome keep their original modules, and when not open must not secretly read the board through an internal observer.

| Current reader / derivation | Input | Phase 1 overview source | Boundary into the full path / phase 2 |
|---|---|---|---|
| project chooser/tabs, pickProject, lane config | projects, position, archived | overview.projects, full project records | Explicitly opening ProjectForm still uses the old path |
| tasks / search / type / priority / tag / counts | Task, including description, tags, position, status | overview.tasks, full Task (currently about 111KB) | No server-side search/paging introduced |
| projectTagStats / tagPrefixes | Tags of all unarchived Tasks of the project | overview.tasks, with the original rules | Detail tag suggestions use an explicit project context |
| statusChanges / flash / laneRows / sorts | Task identity/status, last turn end | Task + card facts; the original animation and row keys | The overview tree is not remounted |
| Recent activity | Each card's max turn end + which agents have ended; idle time of a session with no events | card.turnEndedAt / session.hadTurnEnd + the existing live agents / settledAgents | updatedAt does not replace the original turn rule |
| olderFinished | The time the current finished lane was most recently entered, otherwise updatedAt | card.finishedAt (the result of the original rule) | Date.now, days, keep are still decided in the UI |
| card wrapped | currentWrapup | card.wrapped boolean | Detail still has all stored events |
| card questions | cardQuestions | card.questions count | Question text is not passed to the overview |
| card workpad | workpadSignal | card.workpad's kind/done/total/count | Detail keeps the whole workpad |
| card ideas / project Ideas count | open ideas | card.openIdeas, aggregated by the Task's project | An explicit IdeasPage reads the old full Board |
| card external key/family | artifacts order + faceKey/familyOf | card.external (the old first key +n rule) | All artifacts are only for detail |
| Waiting on | waitingOn(tasks, links) | overview.links + the original rule (Task title reachable) | Do not pass only the target card's links and pass them off as the project's |
| Attention / session summary | event-derived facts + live agent + receipts | session latestTurn/action/at, questionEventId, silent, combined with the original stream/receipt engine | No fake events are generated; instant permission/error/unread stay |
| tips / welcome / whats-new boardLoaded | counts, whether artifacts/external/workpad/next moves exist | card.hasArtifacts/hasExternal/hasWorkpad/hasNextMoves + tasks/projects | Copy/priority unchanged, no new tip |
| workspace availability / outputSession | resources, managed sessions, live agents | The existing independent queries, enabled after the overview arrives | Output/tail starts only for visible cards |
| Progress summaries | summaries.latest | The existing summaries query | The full board is not read back for a summary |
| sidebar/chip | attention.count / chip projection / agent list | The existing independent sources and etags stay | Not merged into the overview, no new global store |
| drawerTarget, TaskDrawer and Progress/Workpad/Tags/Links/Ideas/Artifacts | Full target data | The old full Board is enabled only after an explicit open; the card header may first use Task metadata | Phase 2 moves all to CardDetail, not just removing prefetch |
| TaskForm / ProjectForm / LinkPicker / delete / wrapup | Full rule inputs and candidates | Components mount only when explicitly opened; read the full Board when needed | Phase 2 uses the project index/candidates |
| project Ideas / Insights / Memory | full ideas / tasks / revision etc. | The old full Board is enabled only when the page is explicitly opened; prevents passing off an empty page with empty ideas | Phase 2 uses matching standalone queries |
| chip direct-card | fresh scoped board + exact session refresh | The existing path unchanged, background full is kept, zero requests outside the overview | Phase 2 removes the background full |
| refresh / mutation invalidation | The matching visible data source | Refetch only the currently shown source; invalidating the overview does not refetch the disabled full observer | After a detail write, the overview is also invalidated |

Every current full-board property read must belong to a branch in the table; the common metadata of the union does not mean events/ideas/workpads exist. Mount detection of the full readers is acceptance; a source search is not sufficient proof.

## 3. Phase 1 RPC and DTO

A new schema-validated `board.overview-changed`, with strict input `{etag?: string}`, at most 200 characters. No since. The current scope is all of this daemon's projects/cards, keeping archive records for the existing filter; a future project scope must bump the contract/key, and is not added in this phase.

`BoardOverview = {version:1, revision:number, projects:Project[], tasks:Task[], links:Link[], attentionDismissals:AttentionDismissal[], cards:CardFacts[], projectIdeas:{projectId, open}[]}` (`projectIdeas`: one entry per project, `open` is the count of that project's own (cardless) unhandled ideas, see PROJECT-IDEAS-SPEC §5; keyed by projectId, and like the other collections it goes through patch).
It does not contain the events, ideas, artifacts, workpads or plans collections, and no full Board schema can accept this value.

`CardFacts = {taskId, wrapped:boolean, questions:number, openIdeas:number, external?:{text,family}, workpad:WorkpadSignal|null, finishedAt:string, turnEndedAt?:string, hasArtifacts:boolean, hasExternal:boolean, hasWorkpad:boolean, hasNextMoves:boolean, sessions:SessionFacts[]}`.

`SessionFacts = {agentId, latestTurn?:{action:'agent.turn_started'|'agent.turn_ended',at:string}, questionEventId:string|null, silent:boolean, hadTurnEnd:boolean}`. It contains only event-derived facts, and lists the agents that appear in this card's events; a live session that does not appear uses the default no-event facts. The turn takes the last one of the original array, and is not changed to time ordering; the max turn-end / finishedAt follow the existing sort/olderFinished rules respectively.

CardFacts are computed by the daemon on the same store.view snapshot, reusing the existing rules in shared/progress, wrapup-state, workpad, next-moves and so on, and another approximate algorithm must not be kept. Attention separates "scanning events" from "combining agent/receipt state" and reuses the same engine; no fake BoardEvent is passed to adapt the old API.

The response is one of three: `{etag,value:BoardOverview}`, `{etag}`, `{etag,patch:{baseEtag,revision,projects?,tasks?,links?,attentionDismissals?,cards?}}`. Each collection patch is `{set:Item[],remove:string[],order?:string[]}`; the first three are keyed by id and the last two by taskId. set updates/appends, remove deletes, and order explicitly gives the order of all kept ids when necessary. cards and tasks together reflect deletion/rebinding.

The server has a separate OverviewDeltas cache holding the collection fingerprints of the latest 32 etags, with lookup before eviction. The etag carries the overview-v1 domain, not mixed with full/chip. An unknown/lost etag returns the current full overview, and never falls back to the full Board. A patch has no events-tail assumption; a revision-only patch is legal. A patch update keeps the references of unchanged items.

## 4. Client cache, visibility and handoff

- Key `['flowly','overview',hostId,1]`; separate from `boardKey`, the native chip and the scoped cardLink. createChangedReader sends an etag only when the cache update count it holds still matches.
- A patch validates baseEtag against the request baseline; when there is no local baseline/the cache was replaced/it cannot be applied, re-read the current overview at most once. A full response without a value is an error; the full Board is not retried recursively.
- While the native compact overview is visible the overview polls every 3 seconds; when covered by detail/page/form, the overview's own interval stops. Shared requests of other consumers are not cancelled.
- The full board observer is always disabled in the ordinary overview, with no interval. It is enabled only when an explicit feature opens; a visible drawer still takes over the existing poll, to avoid a root/drawer double interval. The existing full inputs of a project page or form can still refresh.
- Metadata display can compare the revisions of the two data already obtained: only the common projects/tasks/links fields may use the newer version; full detail can only take the full source, and the overview never enters preferFullBoard, CardBoardContext or the full cache. A newer full deletion cannot be resurrected by an older overview.
- An overview refresh/error/empty value does not unmount the root tree. The detail toggle keeps the same motion presence; Back restores the overview, keeping project/lane/filter/scroll.
- Link/workspace/idea routes are explicit full-feature entry points, and do not belong to the ordinary overview zero-full-request window. The route/requestId guard, fresh scoped task + exact session refresh, and action fresh validation are all unchanged.
- The user's manual Refresh and the refresh when an action ends refresh the currently shown source and invalidate the other source, without forcing a fetch of invisible data. A refetch() must not bypass enabled to trigger a full Board in the overview.
- An error on the first overview read shows the original error/Retry, with no automatic fallback to a full read; a refresh failure keeps the old display and shows the error. When agents are not ready/failed it is still Loading sessions / Session state unavailable, and a read state failure only suppresses unread by the existing rules, without falsely reporting no Attention.
- No new visible setting/entry point/copy; no onboarding or whats-new notice is needed, and the original behavior and guidance are unchanged.

## 5. Phase 2 full spec (authorized for implementation 2026-10-24)

A standalone `cards.detail-changed {taskId,workspaceId,etag?}`: each call checks task/workspace/project against server.view, returns an unavailable error on a mismatch/deletion, and never takes authorization from the cache. The response is `{etag,value?:CardDetail}`; the first version is ifChanged only, with no paging/patch; the etag carries the detail-v1/task/workspace domain and covers all detail inputs, not just the task revision.

`CardDetail = {version:1,revision,task:Task,project:Project,events:BoardEvent[],ideas:Idea[],artifacts:Artifact[],workpad:Workpad|null,plans:PlanSnapshot[],links:Link[],relatedTasks:CardReference[],attentionDismissal:AttentionDismissal|null}`. events is all of the card's currently stored events, at most 100, with body; relatedTasks contains only the id/projectId/title/status/archivedAt needed by links/idea references. There are no project-wide Tasks or other cards' bodies.

The project context is a standalone `projects.card-index-changed {projectId,etag?}` → `{etag,value?:{version:1,projectId,revision,cards:CardReference[],tags:TagStat[]}}`; CardReference also contains position/type/priority/workspaceId, and satisfies the candidate rules with the project's full current undeleted cards (including archived). LinkPicker applies the original relation/archive/search/sort rules (title search), tags use the original projectTagStats result, and Ideas reference titles cover linked/source/accepted targets; when a cross-project reference is missing, the detail carries the necessary relatedTasks, and does not falsely claim complete candidates.

- The detail key contains host/1/taskId/workspaceId and the project index host/1/projectId; separate changed readers, and after Back a late result can enter that scope's cache but must not navigate.
- Every drawer section uses an explicit CardDetailContext/query; a full observer is not created and then proxied back. A cold link is still fresh CardDetail + exact session refresh; an ordinary card open shows the display cache first, and actions are validated fresh independently.
- Visible detail uses etag every 3 seconds, and unnecessary detail polling pauses during session preview; the status stream remains independent. The original full board polling and the direct-card background full are removed.
- Detail write operations refresh the detail and invalidate the overview/project index; the server write path still validates the current task/project revision and the real workspace/session, and cannot authorize through old detail.
- A deletion/rebinding refresh that fails is unavailable, and cannot fall back to old data and "resurrect"; a refresh network error may keep a stale display, and actions must reject a fresh failure. The input key/focus/draft/scroll are not reset by a response replacing them.
- Back only restores the overview, and a cold cache shows the existing loading/error; an old route result does not switch cards, reopen a modal or reset input.
- Activity does not split the request or paginate in the first version, and the full semantics are not trimmed to "show only 12".
- Project Ideas/Memory/Insights do not implicitly subscribe to the full Board; each uses an explicit page query. Web keeps the old contract, and the old RPCs are kept for compatibility/rollback.
- Acceptance: direct detail and staying there have 0 full requests; a check that all sections are mounted; tag candidates/related titles/old callbacks/deletion/fresh rejection; no loss of body or input. 128KiB is only a reference for the current 90KB test card, and unusually large content is listed separately and not trimmed.

## 6. Phase 1 verification plan and pass thresholds (historical baseline; see §7 for phase 2)

1. Before the code, save the source manifest/dirty HEAD and a frozen baseline copy; the candidate is frozen with the same config, and both phone groups use the same diagnostic granularity, confirmation of the actual bundle hash, and consistent server/read versions.
2. shared/server focused: rule results equivalent item by item; multiple sessions, out-of-order times, empty suggestions, failed turns, event eviction, wrap recovery, workpad delivery/invalidation, agents with no events, archived, unknown/lost etag, eviction, add/remove/reorder, revision-only, base mismatch, cache replacement.
3. client mounted: a cold QueryClient's native overview first display/idle, and light menus such as Filter/Sort/Status/Attention do not send full; only an explicit card/page/form is allowed; Back stops the full interval and restores the overview; web still uses the old query, and fresh navigation is never added to the overview in-flight. Keep the component keys, continuous motion and MODAL_CLOSE_MS=450; tests do not replace real-device IME/Reduce Motion.
4. Commands: `npm run typecheck`; `npx vitest run shared/overview.test.ts server/board-overview.test.ts client/overview-query.test.ts client/session-link-query.test.ts client/attention.test.ts`; the Luna full-access mounted runner; one `npm test` on the final fixed tree. No full rerun for unchanged inputs.
5. The same Samsung RFCW214ZCFA / SM-S911B, the original connection, Powered stay awake; three groups of scheduled interleaved A/B. Record the actual source and bundle hash, data scale, parent/session recovery and background load; if real data changes, mark it descriptive, and do not falsely claim fixed data.
6. Distinguish the app entry, the overview RPC/schema/apply/effect, the native first frame, idle/scrolling/Attention after first display, the first card header and full detail; the UIA selector of about 7 seconds cannot count as touch latency, and an entry failure is INVALID. List each sample, the median/max separately, and do not estimate P95/FPS from 6 samples.
7. Quantity thresholds: stage1 overview first display + 5s idle, with 0 full Board requests. At the current scale the overview target is ≤300KiB, the median first-screen RPC→effect target is ≤1.5s, not a promise made in advance; report the total bytes/counts of all attributable Flowly RPCs and the coverage limits of the host's native requests, and do not show only a small overview while hiding an equal amount of auxiliary load.
8. List the first explicit card open separately, reporting the time and body bytes that still go through the old full path; do not claim all navigation is fast. Any regression in fresh/deletion/errors, search counts, input or continuous animation rejects the candidate.
9. Product tests/Luna/phone evidence are independent; PASS/FAIL/INVALID/UNRUN are listed separately. Restore the official entry and logs, stop owned processes, precisely delete this round's owned test sessions/verify native+plugin, clean up the owned runtime/tools; keep the evidence archive and the shared cache. The UI is operated only on the Samsung, and this round does not touch the user's desktop window.
10. If a wait of several seconds remains after the small overview, continue to observe by segment the host receive/dispatch/decrypt/JSON/recovery/parse; do not infer from linear ms/KB, do not require "at least two times", and do not change crypto/protocol/storage without evidence.


## 7. Phase 2 implementation and acceptance checklist (2026-10-24)

The old full-path description of phase 1 is kept as a baseline and is not a permission for phase 2. An ordinary phone card open, chip direct link, staying in detail, LinkPicker, return and project pages no longer trigger full. Explicit Task/Project edit forms, delete/remove/wrap-up and the old idea/workspace entry points can still read full on demand; the old fresh read of a standalone native popover action is outside the scope of decoupling the display path this time. Web/tablet keep the full Board query, generating an explicit CardDetail adapter value for the drawer, and no partial value is put into boardKey.

| Consumer | Explicit data source | Loading, errors and refresh |
|---|---|---|
| Card header/Activity/session context | CardDetail.task/project/events, keeping all stored bodies | An ordinary card open shows the overview card header first; after the detail arrives it updates in place; a cold chip first does fresh detail and an exact session refresh, with background full forbidden |
| Progress | detail.project/workpad; standalone summaries | Does not subscribe to the board; a summary refresh does not pull data other than detail |
| Workpad/plans | detail.workpad/plans | After a write, invalidate detail/overview/index; the input key does not change |
| Tags | detail.task; projectIndex.tags | Until the index arrives it cannot pretend there are no suggestions; edit/save keeps the original native input state |
| Links/Origin | detail.links + relatedTasks | A missing related card shows the original deleted semantics; does not pretend to be the full project |
| LinkPicker | projectIndex.cards + the current detail.links | Keeps the rules by project, archive, title, lane/position; loading/failure does not show as a successful empty candidate list, and retry re-reads that scope |
| Ideas/Artifacts | detail.ideas/artifacts; relatedTasks provides accepted/source titles | Optimistic state and the editor are not remounted by a refetch; all updates invalidate the matching scopes |
| Project Ideas | standalone projects.ideas-changed + overview.tasks | The project's full ideas, not limited to open; loading/failure are distinguished explicitly, and an empty array cannot pass for an empty page |
| Memory/Insights | The original standalone page query + overview metadata | Remove the root full gate; no full Board needed |
| root refresh/Back | The current detail or overview | Back restores the overview; the detail interval pauses during session preview/when closed; a request already sent may only write its own standalone cache |

The project index's cards are the CardReference after taskSchema.pick (id/projectId/title/status/archivedAt/position/type/priority/workspaceId); tags reuse the suggestion limit and ordering of projectTagStats. CardDetail.relatedTasks contains this card, both ends of the links, the origin, and the still-existing cards among accepted idea targets. The project ideas contract is strict `{projectId,etag?}`, with output `{etag,value?:{version:1,projectId,revision,ideas}}`, an independent host/version/project key and etag domain. All three new reads validate the entity on the current store.view snapshot, and an unknown scope is rejected; a detail error cannot fall back to cache authorization. The etag is a content hash of the whole DTO, carrying the detail/index/project-ideas domain respectively, and does not look only at the task revision; a same with no baseline re-reads at most once, no value is an error, and it does not fall back to the board.

CardDetailContext is the explicit detail and project context; sub-sections do not call useBoardQuery, and cannot first create a full observer and then replace the data. The root detail observer is responsible only for data, and the only interval observer is managed by the visible drawer; closing or session preview stops the interval, without cancelling other readers' shared requests. The project index is likewise enabled only by the consuming UI. After a write, the displayed scopes are invalidated uniformly; fresh send/context and all server revision/workspace/session checks stay on the original path.

Verification: focused `npx vitest run shared/card-detail.test.ts server/card-detail.test.ts client/card-detail-query.test.ts client/session-link-query.test.ts`; the parent `npm run typecheck`; Luna full-access mounted covering ordinary/direct/each section/LinkPicker/pages, the same etag with a cold cache, deletion/rebinding/late route/input identity, detail vs full in-flight isolation; one `npm test` on the final stable tree. The same Samsung with 2 scheduled interleaved baseline/candidate pairs, recording the cold first card open, at least 6 seconds of staying in detail, session preview and Back + 5 seconds idle; request counts/response JSON bytes/the internal RPC→schema→effect are separate from UI ready. The baseline's first-card old full cost is listed separately, and the candidate's extra detail/index request total is also listed separately; 128KiB is a reference and content is not trimmed. The fixed source hash is checked before and after, real business data changes are listed separately, and no pure fixed data or FPS is promised. Any regression in continuous motion, fresh or 450ms rejects the candidate. Screenshots/IME/Reduce Motion are marked UNRUN when there is no real operation.

Phase 2 delivery (2026-10-24): a fixed snapshot of 367 files, Luna final full 1014/1014, focused 13/13, parent mounted 7/7 (v5 only adds web focus styling) and typecheck passed. The same Samsung had 2+2 valid samples, RPC→data effect median 7.839s→2.634s; the candidate card open/staying/session preview/Back/idle and another native chip route all had 0 full. The data and the UNVERIFIED/INVALID boundaries are in the [phase 2 report](verification/card-detail-2026-10-24/README.md). It does not claim touch first-frame/FPS or an improvement of the whole cold entry.
