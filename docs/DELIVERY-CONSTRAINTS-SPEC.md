# Delivery artifacts and reject-then-confirm (2026-10-22)

> 2026-10-28: Part of this file is superseded by [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) (§12). Superseded: the `WORKPAD_OPEN` part of §2; the reject-then-allow of `SETUP_INCOMPLETE` and outputs remain in effect.

Scope: follows the "Insufficient process constraints" card and implements recommendation 2 of the investigation report. The rules are provided by the plugin and apply to all projects, providers and models, without depending on a project's AGENTS.md. Finish this spec first, then implement.

## 1. Outputs of a delivery call

`flowly_update_status(status=in_review)` and `flowly_report_progress(kind=result)` accept an optional field:

```ts
outputs?: { target: string; title?: string; note?: string }[];
```

- At most 20 items per call. Each field reuses the artifact limits (target 2000, title 120, note 1000 characters); objects are strictly validated. A target is an http(s) link (including PR/MR), or a file/directory that exists inside the card directory. The role is fixed to output.
- Omitting it means this call declares no artifacts: for compatibility, after a successful write, reminders remind the agent to register artifacts for this turn and to pass outputs in later deliveries; `[]` explicitly means this call has no artifacts, does not delete old artifacts, and gives no reminder. This judgment is about this call: an earlier separate registration does not count as this call's declaration.
- Any other status / kind carrying outputs (including []) returns INVALID_INPUT; it is not silently ignored.
- Targets of non-empty outputs are validated before the transaction. If the connector metadata of a valid http(s) URL cannot be read because of an ExternalError (permission, 404, service unavailable, etc.), it is still registered as a plain URL and the notice says there are no external details; external status/content is not guessed, and connection config is not modified. A bare key that cannot be resolved is still rejected; invalid URLs and program errors do not degrade. Inside the transaction the existing putArtifact is called, reusing target de-duplication, updating agent entries, protecting user entries, external connector recognition and the per-card limit. No PR/MR is created automatically, and nothing is written to external systems.
- Artifacts, the delivery event, nextMoves and the receipt are committed in one transaction. If one item is invalid, capacity is insufficient, a revision conflicts, or the delivery is rejected, none of it is committed. Receipt IDs of duplicate targets are de-duplicated.
- A user-added input with the same target is left as is, and a notice with the target is returned; it must not claim it was changed to output.
- The receipt gets optional artifactIds (an array; an empty array when outputs=[], no field when omitted), with the persisted schema and public schema in sync. An exact replay returns the original IDs, without checking whether the original files still exist or querying the connector again; changed parameters are still REQUEST_REUSED. The receipt proves what was committed at the time; it does not guarantee that the user has not deleted the artifacts since.
- Agent artifacts off: non-empty outputs returns ARTIFACTS_DISABLED and the whole call is not committed; omitted or [] can still deliver and gives no artifact reminder. The standalone add_artifact is kept.
- Reminders are in English and appear only on a successful write; the order is next moves, ideas, outputs, setup. A receipt replay after Done/Cancelled/archived gives no reminder.

CLI: status in_review / note --kind result get `--outputs '<JSON array>'` and `--no-outputs` (same as []), which are mutually exclusive; invalid JSON, a non-array, a wrong command, or a non-delivery status/kind must be rejected. Help, MCP schema/description and the skill (both copies) are kept in sync.

## 2. acknowledgeOpen: reject first, then allow

Keep the trigger scope of WORKPAD-SPEC §5.3 / CARD-SETUP-SPEC §3.4: the agent's status actually changes to in_review; a human drag, result, and a same-status report add no new gate.

When there are open workpad items or missing setup items, the first attempt always returns WORKPAD_OPEN or SETUP_INCOMPLETE, even if the input is already acknowledgeOpen=true. One error lists all items and asks the agent to check and fill in what can be filled in first; if it still needs to deliver, it explains each item, then retries with acknowledgeOpen=true. With no problems it commits as usual.

The rejection does not change the board, events, revision or receipt, but the service keeps, for that agent/card/workspace, one rejection record for at most 15 minutes. A confirmation applies only to the same task/project revision, workpad revision, missing setup items, and HEAD sha/dirty/branch. This session's turn_started hook clears the record actively, and does not read truncated events to judge a turn. Any change or a service reload makes the first attempt rejected again; when all missing items are resolved it commits directly. The record holds at most 1000 bindings; when expired/over the limit, the oldest item is removed, and after removal there is only one extra rejection, never a wrongful pass. The record is cleared after a successful delivery.

Errors still use the original codes, with no new parameter or token. After an explicit rejection, the same request can be retried with a changed note / acknowledgeOpen / outputs, because there is no receipt yet; a timeout where it is unclear whether it was committed must still be replayed with the original parameters. Another session's rejection cannot be used to confirm this session's delivery. The service only guarantees that the feedback was returned; it does not judge whether the explanation is honest or complete.

## 3. Acceptance and checks

- outputs omitted/[]/file/plain URL/PR/MR, role protection, target de-duplication, atomic rollback for an invalid path/over the limit, the off switch, and replay (including a vanished file and a service reload) all have business unit tests.
- A first attempt with acknowledgeOpen already set is still rejected; a same-status confirmation passes; a change of workpad/HEAD/task revision/turn/session/timeout does not reuse; rejected after a service reload; passes directly once everything is filled in.
- MCP tools/list exposes the new contract, and structuredContent keeps receipt.artifactIds; the CLI covers a JSON array, --no-outputs, invalid combinations, and one successful delivery and exact replay.
- Focused first: `npx vitest run server/agent-service.test.ts server/tool-server.test.ts`; then `npm run typecheck`, `npm test`. Rerun only when inputs change or to investigate a failure.
- After typecheck passes, `paseo plugin reload flowly` and check the log; running is only reload evidence.
- Tinylink keeps the original project and all existing resources; only temporary cards/sessions clearly owned by this test are created. Use claude/claude-sonnet-5-5 and codex/gpt-6-luna separately; full access at creation (for Claude, the discovered equivalent mode). Two rounds: first produce a file and deliver, then send a message like "create a PR and merge it" and observe whether, in this turn, the agent registers the real PR through outputs on its own and delivers again. The test does not force a registration, and does not treat unit tests as evidence of model behavior. Use a PR that contains only test files, and do not change the permanent example content.
- The Luna test session independently checks the contract, errors, persistence and resource cleanup; record the ID, the actual provider/model/mode, the result and the limits. All new cards, sessions, branches and test files are cleaned up; a merged PR stays as undeletable historical evidence, and it must not be claimed that the PR was deleted. Check the native registry and the board; keep the evidence in docs/verification/.

## 4. User documentation

This is an agent tool constraint, with no new UI, setting or discoverable entry point. The existing Inputs and outputs and Workpad onboarding already cover the purpose, so no new tour copy, tip or What's new is needed. Update the related specs, SPEC-OUTLINE and PROGRESS, and on delivery state clearly whether the model behavior verification passed.

## 5. Added during implementation

- The verification materials directory contains third-party Angular source, which the global TS/Vitest matching wrongly treated as product code. tsconfig and npm test/dev exclude docs/verification, keeping all the materials; product source and its tests are still fully covered.
- The user explicitly required on 2026-10-22 that the private GitHub test repository be kept for reuse, which overrides the repository cleanup requirement of §3. The repository JasprW/flowly-delivery-fixture-20261022-036d is kept, and the test PR history is kept; this round's cards, sessions, workspaces and temporary branches/files are cleaned up as usual. Tinylink does not get a new remote.

## 6. Delivery status of this change

Both the Sonnet and GPT fresh-session real PR scenarios passed; the implementation and local checks are complete. The native fixtures and remote test branches are cleaned up, and the repository is kept as the user required. Only 4 local Tinylink test refs were kept, because the sandbox refused the write and the escalated permission request was not completed; the workpad explicitly records them as unrun. When delivering to In review, the rejection of this open check must be received first, then confirmed with an explanation; the card is not set to Done.
