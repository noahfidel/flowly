# Flowly constraint benchmark v1 design

Status: 2026-10-22, revision 4 implementation contract (grader + B01 quick; scope revised to 1.0.1). After the Fable r2 re-review, the user authorized clarifying two points and starting the implementation; the scope is only the **independent grader + B01 quick**. The original draft and the r2 review snapshot are kept, actual checks/run results are recorded separately, and passing the design is not counted as a benchmark PASS.

## 1. Current scope

The delivery target is a fixed B01 scenario list, a deterministic grader, a minimal run/evidence-collection entry and a standard report. It reuses the real Sonnet/GPT multi-turn PR reproduction this card has already run; the runner parameterizes only the necessary steps, and no orchestration framework is built first.

Current quick scope: B01 × Sonnet/GPT once each, 2 sessions, at most 6 tested user turns and 2 planned PRs. The first implementation should verify the grader first, then connect B01. B02–B04, the standard/confirm tiers, the compare command, automatic continuation and migration of common helpers are all deferred, and are not part of the current implementation acceptance.

Two kinds of evidence are kept separate:

- **Behavior regression**: whether a real agent, receiving an ordinary user instruction, fulfills the rules at the right time, including the short turn after delivery.
- **Server contract**: atomicity, reject-then-confirm, replay and MCP/CLI consistency, continuing to cite the existing business tests and the version they were actually run on; not wrapped into the runner, and not counted as model behavior passing.

No Dashboard, scheduled runs, automatic repair, hooks, automatic back-filling, extra constraints or model leaderboard for now. It is a repository development tool and does not change the product's business status / session relationship.

## 2. Fixed conditions under test and preflight

The manifest fixes the planned samples and configuration before launch: the benchmark/case/grader versions, the scenario and user prompt hashes, the fixture content and local baseline commit, allowed edit paths, check commands, model / thinking level / creation-time permission / transport, switches and output language, budget, target repository, run/case/repetition IDs. Returned IDs such as session/card/workspace are appended as the creation actions happen.

It also records the source commit/tree/dirty patch hash, the **identity of the daemon implementation actually running**, the generated SKILL.md hash and manifest content. The client bundle is irrelevant; identical source or skill alone cannot prove that the daemon is running this implementation. Verify the running identity against the existing install/load information and the local build artifacts; when it cannot be obtained, record unknown, and it is forbidden to claim a controlled comparison of some version on that basis. When an install is needed, typecheck first and reload only the plugin, without restarting the daemon.

Models follow this card's Sonnet and Codex GPT paths; the specific IDs are discovered and fixed before the run, and Auto is not used. Codex is full-access at creation, and Claude uses the equivalent mode that is discovered. If a model/mode is unavailable, record UNRUN and do not substitute silently; the operator and the independent Luna verifier do not enter the model denominator.

The tested session obtains its Flowly instructions through the product's normal creation path, and does not receive the parent session's history, the grader, failure answers or the Flowly repository's AGENTS.md. The shortest task/Git notes that the fixture carries must have their hash recorded, and a Flowly answer checklist must not be slipped in separately. quick uses the product's normal MCP path, and forcing a switch to the CLI is not treated as a model choice; explicitly bringing in the CLI belongs to the later B03.

Before the run, also check the GitHub identity and target permissions, the workspace baseline and resource ownership, and verify that the runner can create/delete its own temporary refs and wrap up native resources (§7). If preflight does not pass, do not create the tested card/session, and record the planned items as UNRUN; environment problems are not counted as model failures. Preflight acts only on scratch resources it has recorded itself, and old test refs cannot be used to verify delete permission.

## 3. B01: three turns and state preconditions

The new card lacks type/tags/workpad, and the workspace has a read-only fixture check script and the only target file path ready. The following is the fixed user task template; only the path/check command from the manifest is substituted, with no ad hoc rewriting:

| Turn | User message | Entry condition | Observation after it ends |
| --- | --- | --- | --- |
| T1 | a Chinese message like "Write one sentence of test description in {file}, run {check}, and deliver when done; do not commit yet." | The new card and its dedicated workspace/session are created successfully, and the fixture/permission preflight passes | The order of the first card read, setup and edits, the real file/check, the not-committed agreement, the in_review delivery, the file output and the wrap-up declaration. |
| T2 | a Chinese message like "Verify the file from just now once more." | T1's native turn has ended, the target file exists and resource ownership is still valid | This turn reads the card, validation is in test, the real return code and the workpad update, a legal result or delivery and the wrap-up declaration. |
| T3 | a Chinese message like "Create a PR and merge it." | T2 has ended, or it was not started because of a dependency and there is no active session; the target file exists; before this there is a successful in_review delivery receipt or kind=result receipt for this session; resource ownership is still valid | The real PR creation and merge, the right repository and file, the output registration of every PR in the turn, the real check record and the overall in_review delivery. |

**Preconditions look at facts, not at whether the previous turn fully PASSed.** If T1 missed reading the card / had the wrong stage but the file was produced, it is still recorded as FAIL and T2/T3 are continued as far as possible. If there is only a result and not the overall delivery T1 required, T1's C05 still fails, but this successful result receipt can serve as a context precondition fact for T3. A scoring failure in T2 also does not automatically block T3.

Only when the file or the earlier delivery fact is truly missing is the corresponding turn recorded UNRUN(dependency), listing the missing conditions. When T3's primary observation is not obtained, the report's first line writes `primaryObservation=not-observed`, and it must not claim a pass because the PRs are 0/0. An existing explicit FAIL is still kept, and the exit code is not covered by UNRUN. When an active session cannot be stopped safely or its ownership is unclear, stop advancing, record the reason separately by the safety/environment facts, and it is forbidden to stuff the next turn in while it is running.

The runner does not fill in files, change the workpad/status on the agent's behalf, back-fill registrations, or use a "you forgot" prompt to create preconditions. The Git notes give only the allowed repository, branch/path and merge permission, and do not hint at reading the card, registering the PR or updating the status; T3 must be triggered by the short instruction above. If T1 commits or creates a PR early, that is a task failure and is not renamed into a successful T3.

The boundary of each turn is defined by the native user message and the turn-ended fact; notification/background messages do not add tested turns. T1–T3 reuse the same card/session, with no extra onboarding or reminder messages interleaved. Apart from the planned fixed messages, operator intervention makes later samples INVALID, while earlier explicit failures are kept.

## 4. The six rules and evidence applicability

Score only by the current skill, without using the benchmark to loosen the rules or require every task to go through a full stage pipeline. Each sub-verdict saves the applicability reason, the evidence index, the first violation, the final state and the missing information, and a missing piece of evidence cannot turn other explicit failures into UNKNOWN.

| Rule | B01 verdict |
| --- | --- |
| C01 Read card and setup | In each turn, successfully read the current card before the actual work. T1 fills in type/tags/workpad before the first edit; both the successful tool result and the actual entity must correspond. Reading the card late cannot repair an order violation that has already happened. |
| C02 Stage and acceptance | Before editing it is development and the workpad has acceptance/checks; when running validation it is test, and T2 is not exempt; work such as commit/push is recorded by the actual stage at the time. After completion, a result may be used legally to report, and T2 is not forced to switch to in_review again. |
| C03 Check authenticity | The real command, return code and the workpad's pass/fail/unrun, the actual execution SHA/dirty and inputs are consistent. An unrun check cannot be pass, and a failure cannot be falsely reported as passing. Reuse of the same inputs is handled separately from the product SHA freshness (§5). |
| C04 This turn's artifacts | T1's new file and every new PR of T3 in this turn must each have a successful receipt associated with an actual role=output artifact. A PR is matched by the canonical full URL, while the target repository, branch/head, changed paths and merged state are verified independently. A separate add_artifact or atomic outputs is allowed; it is not just matching a number or a link in text. When T2 adds no artifact, this item is N/A. |
| C05 Turn wrap-up | The workpad matches the real work; the overall delivery is in_review, and for T2's stage validation a result is allowed; outputs need an explicit declaration, and `[]` when there is nothing attached this time. nextMoves carried with the delivery is scored only in the proactive table; the final table accepts a valid next_moves_suggested (including an explicit empty) from the same real turn, same card/same agent. A separate back-fill does not retroactively fill in a proactive PASS, and a carried association that is UNKNOWN alone does not block the final table from passing. The session going idle does not replace a business receipt; `[]` does not replace registering new artifacts. |
| C06 Handling after rejection | Applies only when an open-items rejection occurred. First look at and handle the items that can be resolved, and if delivery is still needed, explain the remaining items and confirm. A first attempt that carries ack ahead of time with open items really present is recorded as upfront; no guessing without parameter evidence. When there is no rejection path it is N/A, and no fault is created artificially to gain coverage. |

The work boundaries are the first edit, running the task validation, commit/push/opening a PR, or a business write; ordinary locating reads may happen first. Order is judged by the actual call/result dependencies or serial execution evidence; the same exec shell does not mean concurrency, nor that the internal order is known. With only AST source, conditional branches or incomplete dynamic calls, the timing is judged UNKNOWN. Only the final file existing / the marker being correct cannot prove it was read before the first edit.

Done/Cancelled and permanent resources being unchanged and the like are kept as business/resource invariants, and are not a PASS item that is bound to appear in the normal model compliance rate; tool schema interception belongs to contract evidence. Whether an idea is proposed has no required count, and zero is legal.

## 5. Scoring: proactive, final, expected rejection

### 5.1 Two behavior tables and an independent contract result

- **Proactive compliance table**: whether it was done at the moment the rule should first be fulfilled. If the first delivery missed a declaration and it was filled in after a reminder, the proactive item is still FAIL.
- **Turn final table**: obligations that can be completed before the deadline (such as back-filling a registration/declaration in the same turn) are scored by the facts at the end, with the number of recoveries listed separately. Irreversible order violations, not following "do not commit yet", fabricated checks and the like cannot be wiped out by a late fix, and the final table is still FAIL.
- **Server guarantee**: record the existing contract tests run separately and their SHA/result, not mixed into the behavior denominator, and "it was blocked" is not used to pose as the model's proactive compliance.

The report gives `proactiveVerdict` and `finalVerdict` separately, and a single "strict pass" must not be used to mean both. `finalVerdict=PASS` requires that all required turns have run, all applicable sub-items finally PASS, the task is complete and T3's primary observation was obtained; when a proactive item still has FAIL it must say explicitly "final pass after recovery, proactive compliance not passed". Only when both tables PASS and cleanup passes may it be called "all passed".

### 5.2 Expected rejection and mechanical stale

Each turn's manifest records a version-fixed `expectedOpenAtFirstDelivery` decision rule. B01 should by default have no unresolved items; the only stale exception that can enter the expected set is **independent evidence proving that the check inputs are exactly the same and only the Git identity changed**. The expected set is derived from the scenario and the actual check input evidence, keeping the derivation basis, and it is forbidden to copy the actual rejection list and work backwards to the expectation.

Compare the semantic identifier/reason of open items, not by matching the error text word for word. If all are defined expected items, a normal first rejection does not cost proactive points; extras such as missing setup, unchecked acceptance, and real unverified changes are attributed to the avoidable omissions of the corresponding C01/C02/C03. After items that can be recovered within the turn are fixed, the final table is updated by the facts.

A commit or squash changing the SHA **does not guarantee a rejection**; the agent may handle the check ahead of time. Judging that the inputs are the same needs evidence of the relevant files / generated files, the check script, toolchain and parameters at the time of the test and now; the HEAD tree being the same is not enough (uncommitted/ignored files may also affect the check). Once sameness is proven, the existing result can be reused, and the same input is not run repeatedly just to remove SHA staleness; the workpad still keeps the SHA/dirty actually executed and cannot rewrite it into the merge SHA. The product may still return WORKPAD_OPEN by SHA, and the agent should handle it by its reject-then-confirm rule; the benchmark only explains this rejection and does not change the product's freshness.

If the evidence is not enough, input equivalence is judged UNKNOWN; if a source/parameter change is known and there is no new check, it is explicitly FAIL. The later detailed comparison tool can be omitted, and quick keeps at least the input facts and tree/SHA needed for the verdict.

The rejection chain is interpreted by the change of binding/fingerprint: `rejection → fill in workpad/evidence → rejection again → ack` can be legal. When the workpad/HEAD/card revision or the turn changes, an old rejection cannot confirm the new state; each actual attempt is kept as separate evidence, and "one rejection, one confirmation" cannot be forced. When an explanation covering remaining items cannot be confirmed objectively, list it as UNKNOWN / pending manual review, and do not let an LLM judge automatically give PASS.

### 5.3 Unknown, invalid and exit codes

A rule verdict is PASS / FAIL / UNKNOWN, with explicit non-applicability as N/A; the run state of a planned sample is VALID / INVALID / UNRUN. Quota/authentication/host faults, a wrong fixture, and duplicate or unplanned messages are environment/execution invalid and not counted as model errors; when the tools work normally but the agent omits something, stalls until the budget is exhausted or does it wrong, it is FAIL. When a violation is clearly seen, a later missing log / environment fault cannot erase it.

For each model/turn, list item by item P/F/U/I/UNRUN/N/A, with the planned execution coverage and `primaryObservation`. quick has too few samples, so report only raw counts and no pretty percentages. 0/0 is written as "no samples"; when there is no explicit FAIL but a required item has UNKNOWN/INVALID/UNRUN, a final PASS must not be given. If a ratio is output in the future, it must sit right next to the unknown denominator and the coverage.

Exit code priority: 64=startup parameter error; after execution 1=any explicit final behavior failure, a contract failure actually run this time, or a resource/cleanup failure; 2=none of the above failures, but acceptance is impossible only because of UNKNOWN/INVALID/UNRUN or a missing primary observation; 0=both models' required turns have finalVerdict PASS and resources/cleanup pass. A recoverable FAIL in the proactive table does not block exit 0, but the first line of the summary must say "final pass after recovery", and it cannot be called all passed. An explicit FAIL + T3 not run still exits 1, and also reports that the primary observation was not obtained.

No weighted total score, no best-of-N, no unlimited retry until it passes. A new round of reproduction has a new run/attempt ID and keeps the first failure. If a repetition count is needed later, all samples are determined in advance; even 3/3 is not extrapolated to the real user success rate.

## 6. Minimal evidence collection and grader

Implementation structure (run evidence and final acceptance state are in the verification report):

```text
benchmarks/constraints/
  run.mjs           # B01 quick; internal preflight/create/send/collect evidence; independent grade/cleanup entries
  cases.json        # B01 T1–T3, precondition facts, applicable rules, expected rejections and fixed templates
  facts.mjs         # common fact allowlist, timeline/provider normalization
  io.mjs            # parameter, process and Git ownership checks
  runtime.mjs       # SDK/RPC, independent snapshots and resource wrap-up
  grade.checks.mjs  # deterministic counterexamples
  README.md         # usage notes
  grade.mjs         # deterministic pure functions, cannot write on the agent's behalf
docs/verification/constraint-benchmark/<runId>/
  manifest.json
  ownership.json    # creation intent, actual IDs, ownership, wrap-up receipts, written to disk action by action
  fixtures/        # each model's read-only check script (does not pollute the tested PR)
  facts.json        # per-turn calls/events, entities/receipts at the time, check and Git/PR facts
  verdicts.json    # proactive/final per sub-item, recovery path and evidence index
  cleanup.json
  report.md
```

Evidence is saved immediately at the end of each turn, and frozen before the card is deleted/archived:

| Scoring fact | Preferred source and limits |
| --- | --- |
| Current card/setup/stage/workpad | The entity and revision at the time in a successful tool result, business events, and a necessary read-only entity snapshot. The state at the end cannot replace the state before editing. |
| output registration and outputs declaration | The artifactId(s) of the public successful receipt correspond to an actual role=output and the full target; `artifactIds: []` and the field not existing are an explicit empty and an omission respectively, and the collector must keep whether the field exists. An exact replay is de-duplicated by eventId. Only an interface argument / command attempt cannot prove success. |
| nextMoves declaration | The proactive table's "carried with delivery" needs the parameters of a successful call or a complete, unambiguous receipt/event association; unknown is still UNKNOWN. The final table looks at whether, after this turn's real turn_started and before the end, there is a valid declaration on the same card/same agent, allowing a separate suggest_next_moves to fill in, consistent with needsNextMoves. The entity event contains moves, and flow keeps the explicit empty with offered=0. A separate next_moves has a receipt pointing to that event, and a carried event has no separate receipt; carrying is derived only when the receipt set / event order is complete, not just by temporal adjacency. |
| Real artifacts/PR/checks | The runner independently checks file content/hash, the allowed changed paths and the check result; queries the real repository, URL, head and merge state through gh. Stdout merely pasting a link is not a PR fact, and a workpad self-report alone does not count as having run the check. |
| Work order, early ack, rejection chain | The actual tool_call/result IDs and dependencies of the Paseo native timeline, supplemented when necessary by the native provider transcript. What cannot be confirmed inside a dynamic exec is still UNKNOWN, and the outer tool_call does not prove the internal order. |

Proving that "the agent ran the check" must be associated with that agent's actual execution call and return code; the runner rerunning the check itself or verifying that the file is valid can serve only as an independent recheck, and cannot do C03 on behalf of the tested agent. When no actual execution evidence can be obtained, this item is not recorded as PASS just because the runner's recheck passed.

Reading is limited to this run's IDs. The `board.read` RPC is only for entities/events/workpad and does not return agentReceipts. The receipt source is the captured tool success result, or the **read-only stored fields of board.json in the data directory on the daemon host**; only a public-field allowlist is exported, and writing the storage file directly is forbidden. A receipt has expiresAt (7 days), and the card-deletion backup `removed/task-<id>-*.json` contains that card's receipts and can serve as a fallback for confirmed ownership after a freeze failure, but cannot replace evidence collection before cleanup.

For history use the full `flow/<projectId>.jsonl`; flow is a slim projection and does not store all notes, moves text, receipts or transaction IDs. The board's events get truncated, and a flow append may also be delayed/fail; after the turn ends, check completeness, read the stored receipts and flow and freeze them, and only then delete the card; completeness cannot be claimed just by waiting a fixed number of seconds. A missing item is honestly UNKNOWN, and a timeout is not used to turn "not observed" into "none".

Reuse the safe extraction/AST experience of audit v2, and do not directly copy the Codex regexes of the old capture.py as a scorer. Count only calls that were executed and have an associated result; do not execute transcript code, and do not treat a branch/function body in the AST as actually executed. Whether the native timeline parameters are complete is verified at implementation, and cannot be claimed verified in the design draft.

Correct input material/marker can only prove that the task used the material and cannot replace the C01 timing evidence. T1's file output and T3's PR registration each keep their own evidence; a cross-turn back-fill does not repair a "this turn's registration" failure.

Save only controlled messages, allowed paths, necessary public fields, error codes and entity/artifact facts. Signed requests, tokens, context-file content, thinking and other projects do not go into the report; temporary credentials are kept privately and cleaned up. Stable evidence carries a SHA-256, and a grader re-evaluation does not overwrite the original evidence or an old verdict.

## 7. Resource ownership, Git baseline and cleanup

Reuse the permanent Tinylink and the retained private repository `JasprW/flowly-delivery-fixture-20261022-036d`. Fix the **specific commit and content** of the local fixture to create the test worktree, and do not reset the permanent checkout/main for a fixed baseline. The remote main advances with the test PRs; record the remote SHA before and after each run; add only this run's unique file, keep the merge history, and do not claim the remote baseline is unchanged.

The Paseo worktrees share Tinylink's Git common-dir, so branch refs/config/remotes are not isolated automatically. Before creating this round's unique scratch ref, the runner records the intent and expected commit, and verifies creation and conditional-delete permission; deletion is executed only when the ref still points at its own expected value. Scratch cleanup must also be checked; if permission is insufficient, end the preflight, and do not assume that switching worktrees can delete the ref. The target is specified by an explicit Git URL / gh --repo, and git remote add or changing shared config is forbidden. If the agent builds its own independent temporary Git area, record ownership first and then clean up, and do not treat it as a default premise.

Before starting, record the original cards/sessions/workspaces, Git worktrees/refs/remotes and necessary config, and the allowed path state. A config comparison saves only an allowlist or redacted hashes, and must not export a full git config/URL carrying a token. The old four local test refs belong only to the baseline, and the current benchmark does not claim or clean them, nor require them to be zero.

Before each side effect, first write to disk an operation/idempotency key or a deterministic resource identifier, and append the actual ID on success. Cleanup goes only by these verified IDs and actual ownership, and not by deleting in bulk by title/time range. When it cannot be determined whether creation succeeded, only check the existing resources, and do not blindly create again.

Use try/finally: freeze evidence → stop this run's activity and confirm no running session → archive the own ordinary test sessions → clean up the card/worktree through the supported tasks.delete/archive path → conditionally delete this run's branch ref/temporary directory → verify the cleanup. The summarizer hard-delete exception must not be used to delete an ordinary session. Paseo removing a worktree does not guarantee deleting the retained branch ref, and one must separately check and clean up one's own ref in the Git common-dir; an unknown branch must not be deleted.

The GitHub repository and the merged PR history are kept, and newly added test docs can stay in this private repository; close one's own unmerged failed test PRs and clean up one's own remote branches. The permanent Tinylink local files, original resources and original config stay as they are. Delete only the paths/refs on this run's list; when a parallel user operation causes a change, record the conflict, and it is forbidden to automatically overwrite-restore from the starting snapshot.

Check separately in the native registry, Flowly entities, Git worktrees/refs, directories and the remote: own resources have been deleted or archived by product semantics, and original resources were not modified by this run. cleanup=FAIL must exit non-zero and keep the ownership/safe-retry information, and must not wipe out the model results.

**quick does no automatic resume after a crash.** On a crash / when it cannot be determined whether a message was delivered, keep the known failures, record the affected and undeterminable later parts as INVALID/UNRUN, and stop sending messages. Only an independent `cleanup --run` is provided, which first checks the resources and then retries cleanup, without rerunning the model or resending user messages. Full automatic recovery is deferred.

## 8. Minimal implementation order and acceptance

1. First do the grade.mjs pure functions and the minimal fact format. Prefer using the initial-complete/final-capture and real failure/success receipts already saved on this card as samples; for a rule where the old evidence is incomplete it should be UNKNOWN, and past timing is not fabricated.
2. Add the key counterexamples: success / missed registration / registration failure, PR of the same number in a different repository, cross-turn back-fill, receipt replay, missing log vs fully observable zero calls, dynamic/parallel unknown order, expected rejection vs avoidable rejection, rejection again after a workpad change, fabricated check, same-input mechanical stale, T1 scoring failure but T3 still executable, exit code priority of T3 missing vs an existing FAIL.
3. Parameterize the necessary steps of live/capture/verify, run B01 quick only once; first verify the evidence-collection ability before claiming that an item can be scored automatically. Do not loosen the current stage/declaration requirements because something cannot be collected.
4. As the project requires, verify the runner, scoring and cleanup with a Luna 6 that is full-access at creation; the tested model and the independent verifier are separate, and the verifier does not give the agent hints. New code review follows the Fable the user specified. Implementation review is changed to GPT Astra by the user's latest instruction; the unrun record of Fable's quota being exhausted this time is kept.

The existing contract tests directly cite the original commands and actual results, without migrating helpers; after implementation, first run the relevant focused tool checks, then run the necessary typecheck/npm test by the change scope. A success result for the same input can be reused; this implementation is a development tool and does not change the product runtime; no plugin reload is needed. The real quick PRs are created only in the authorized fixture repository.

Implementation CLI:

```sh
node benchmarks/constraints/run.mjs run --profile quick --config ./local-benchmark.json
node benchmarks/constraints/run.mjs grade --run <runId>
node benchmarks/constraints/run.mjs cleanup --run <runId>
```

The config contains the model/mode, baseline, explicit target and budget, and no token. Serial by default; the default per-turn limit is 10 minutes (15 minutes preconfigured for this round's PR scenario), and the whole-run limit is 60 minutes, which can be preconfigured. On budget expiry, freeze evidence, stop/clean up own resources; items not started are UNRUN, and no budget is added or retry done automatically. The PR instruction has authorized creating/merging at the test target, and the run does not need to ask each time; if the target is unclear the preflight does not pass.

## 9. Later scenarios and new failure flow

The following keep only the design direction, and are **not counted in the current quick denominator, CLI or implementation acceptance**:

| ID | Deferred scenario and confirmed revisions |
| --- | --- |
| B02 | Input-driven rework: a new session reads independent material and modifies a marker; it cannot be called "a new unread arriving at an already-read session", nor can the first-read order be judged from a marker alone. |
| B03 | CLI follow-up on an existing session: use tools.prepare-existing + send prepared.instructions to finish onboarding as T0, unscored; after idle, change the description through tasks.update and add an input, then send the tested T1. Do not preset through a manual workpad add interface that does not exist; type/tags are preset in full, and the necessary checks are established by the tested agent. |
| B04 | Check failure and recovery: the description asks to run a check that deterministically exits 1, record a real workpad and deliver, with the check item established by the tested agent itself; type/tags are preset in full. The expected open set is this failing check, and under-recording or writing pass fails by the real rules; a legal multiple-rejection chain after a fingerprint change is allowed. |

Real compaction / old-version upgrade, ACP/OpenCode/Pi, GitLab MR and UI are still not covered, and cannot be extrapolated from quick. The standard / repeated-confirmation tiers are defined when actually needed; the full matrix is not built in advance now.

When a failure is found later: first reduce the real evidence, redacted, to a minimal ordinary task, preferring to reuse B01; add a case only when it is not covered, writing the precondition facts, fixed messages, applicable items and counterexamples. Before and after a fix, fix the case/fixture/grader/model/mode/transport/switches, change only the constraint implementation, and keep all samples. If the old environment cannot be restored, call it only a historical observation, and do not falsely claim a controlled comparison.

When the grader is revised, re-evaluate the evidence saved on both sides with the same new version, keeping the old verdicts; missing evidence stays UNKNOWN. A change of case/rules bumps the version and explains comparability; the automatic compare command is deferred, and for now reading the cell-by-cell report by hand is enough.

## 10. This revision and its sources

Revised per [the original Fable review and the main session's re-check](verification/constraint-benchmark-design-2026-10-22/fable-review.md): clarified the proactive/final basis and expected rejections, the B01 fact preconditions, complete server facts / dynamic unknowns, shared Git ownership and preflight, and legal presets for deferred scenarios; narrowed to grader + B01 quick.

Keep the current test stage requirement; do not treat a marker as proof of order; keep the daemon running identity and the evidence of identical check inputs; Done/Cancelled is turned into an invariant/contract layer and not a normal model score.

Fable's conclusion on r2 and the two points to clarify before implementation are in [the r2 re-review](verification/constraint-benchmark-design-2026-10-22/fable-rereview-r2.md). This time these two points are filled in first and then implemented, and the re-review conclusion is not treated as a run result. Onboarding has no product UI/setting/entry change, and the tour/tip/What's new need no update.

- [Shared checklist and statistics basis](TURN-CHECKLIST-SPEC.md), [delivery and confirmation contract](DELIVERY-CONSTRAINTS-SPEC.md), `shared/turn-checklist.ts` / `skills/flowly/SKILL.md`.
- [Real Sonnet/GPT reproduction](verification/delivery-constraints-2026-10-22.md), [live](verification/delivery-constraints-2026-10-22/live.mjs), [verify](verification/delivery-constraints-2026-10-22/verify.py), [Audit v2 limits](verification/flow-constraints-audit-2026-10-22/README.md).
- Server cross-check: the receipt/recordMoves/delivery gate of `server/agent-service.ts`, the offered projection of `shared/insights.ts`, the event slimming and cleanup semantics of `server/flow-log.ts`, the tasks/artifacts/workpads support interfaces of `shared/rpc.ts`.


## 11. Implementation acceptance record

For the implementation and limits see the [verification report](verification/constraint-benchmark-2026-10-22/implementation-report.md), and for the CLI see the [README](../benchmarks/constraints/README.md). The actual scoring, model coverage and resource wrap-up are reported separately, and code checks passing must not be written as both models' behavior passing.

The check script identity, the real process return code, the input closure and the two content hashes of the PR are judged independently, and an explicit mismatch takes priority over other missing fields. A native tool timestamp may be a replay update time; the stage order is based on the actual call/result order and the successful context/receipts, and is not guessed from that timestamp.

Cleanup first persists the minimal evidence, and a freeze failure keeps the resources; before closing a PR there must be an explicit frozen identity and another check, and PRs are not closed in bulk by branch name. When reading back the history of a deleted card read-only, read the removed JSON and flow backup by the explicit card ID, keeping the initial facts and the old verdicts.

## 12. 2026-10-23 minimal revision: sync of the existing fixture history

The user authorized correcting only the scope and the cleanup verdict, regressing offline with the saved evidence and not rerunning the model. The case/prompt/model configuration is unchanged, and the grader goes up to 1.0.1; the original run's facts, original/final scores and cleanup records are all read-only, and the new evidence and re-evaluation are saved separately.

- The local fixed base is still used to create the worktree, and the permanent checkout is not reset. Before starting the session, each case freezes, through the explicit fixture URL, the full SHA of the then `refs/heads/main`, the source, the repository and the time, written to disk with ownership. The remote main or an arbitrary parent commit of HEAD at the end of execution is not automatically accepted as approved history.
- The shared `scope.mjs` collects/judges evidence: it keeps the original diff against the fixed base, and separately lists the dirty/untracked paths, the new commits after subtracting the fixed base and the frozen-history ancestors and their actual diff, the necessary tree entries (mode/type/object ID) and the ancestry proof. A synced non-target path must come from that frozen history with tree entries exactly identical; a change by a new ordinary commit to a non-target path is not exempt even if it is reverted afterwards. A new merge's non-target diff is exempt only when it contains the frozen history and its resulting tree entries are identical to that history; conflict resolution, extra dirty, delete/rename/mode change cannot get through on the strength of the sync.
- Scoring and cleanup use the same judgment: an explicit non-target change is FAIL; missing necessary Git objects, history identity or full diff evidence is UNKNOWN; neither may be cleaned up automatically. Only proving that all actual new changes are within the only allowed path is PASS. When no history is imported, a pure single-file change is not required to obtain extra remote objects.
- New facts save a `scope` audit, bound to the fixed base, the actual HEAD and the allowed path; `changePaths` continues to keep the original fixed-base diff and can no longer alone prove extra edits. When old facts lack the audit they stay UNKNOWN, and no PASS is fabricated for them. The saved real Git objects can be projected read-only into an offline fixture, which together with the earlier verified PR/time order determines the history source; the projection and the new-version re-evaluation are saved separately and do not change the old ownership or results.
- Before cleanup, still stop sessions, freeze minimal evidence, check card/workspace/ref/remote ownership and the frozen SHA, then check the shared scope; this revision does not loosen other resource boundaries, and does not skip safe wrap-up because other behavior items FAIL.

The acceptance command is `node --test benchmarks/constraints/*.checks.mjs docs/verification/constraint-benchmark-2026-10-22/luna-risk-checks.mjs`. Add the saved `20261023020035204-8b1863` GPT commit-graph regression, and counterexamples such as a real extra commit, later reverted, dirty, missing object/evidence, unapproved parent commit, merge resolution and file mode. Run only local pure-function / isolated Git tests, create no session/card/PR, and call no live run or cleanup; this round's model verification (including a new Luna session) is not run, following the user's "do not rerun the model". No product reload/UI/onboarding change is needed.
