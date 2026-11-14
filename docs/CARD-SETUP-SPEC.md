# Card setup before work: reminders and a soft gate for type / tags / workpad (CARD-SETUP-SPEC)

> 2026-10-28: part of this document is superseded by [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) (§12). Superseded: "workpad missing" becomes "acceptance missing"; the rest is still valid.

2026-10-22: Start of every turn becomes a shared six-action checklist, and the live get_task returns the same `turnChecklist`; it still fills in setup.missing first, small cards included. The existing missing-item check, reminders and permissions are unchanged. See [TURN-CHECKLIST-SPEC](TURN-CHECKLIST-SPEC.md).

Status: reviewed and approved by the user on 2026-10-21, who asked for it to be implemented; implemented, Luna 6 verification passed ([report](verification/card-setup-2026-10-21.md): Sonnet 5.5 medium and Luna both filled in the three items before the first file change; the `SETUP_INCOMPLETE` rejection in a real session was not triggered and is covered by unit tests only). Card `ee717828` ("Strengthen the Flowly process constraints", a follow-up to "Release v1.5.0").
User decisions (2026-10-21):
- A card with no workpad also gets the soft gate on delivery (`acknowledgeOpen` with an explanation lets it through). This **overturns** the old decision in step 2 of [WORKPAD-SPEC](WORKPAD-SPEC.md) §5.3, "submit as usual with no workpad"; the reason is in §2 R4.
- A turn that calls no Flowly tool at all is covered by stating the missing items in the first task context (§3.2); showing the missing items to the user on the card face is a separate idea, not in this card.
- Card item 5 (the daemon summary child session suggesting type/tags) is not done.

## 1. Current data

Source: `~/.paseo/plugin-data/flowly/board.json` (snapshot of 2026-10-21 13:05, read-only) and `paseo agent ls -a -g --json`. It counts cards created after 2026-10-19 07:00 (when the workpad went live) that have agent turns. Card events keep only the latest 100 per card, so the "first" time of a long card may be cut; the table below lists only short cards.

| Card | Description | Model / thinking | type | tags | workpad | Flowly writes | Observation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Table rendering | empty | sonnet-5.5 / auto | none | none | none | 5 | todo→development→in_review took 91 seconds in total; both deliveries carried next moves |
| Text link rendering inside the session | empty | sonnet-5.5 / medium | none | none | none | 2 | todo went straight to in_review, with next moves |
| Make the sidebar move the board as little as possible | empty | sonnet-5.5 / medium | set by a person | none | none | **0** | Opened PR #7 in a separate worktree, with not one Flowly tool call in the whole card |
| Release v1.5.0 | empty | sonnet-5.5 / medium | set only at 05:01 | set only at 05:01 | after development | 7 | type/tags were added only after the user asked |
| Phone performance optimization | empty | sonnet-5.5 / high | none | none | written only at the moment of delivery | 18 | 6 deliveries, type/tags never set |
| README adjustments (10-19 03:51, before the workpad went live) | empty | sonnet-5.5 / medium | none | none | — | **0** | Zero calls in the whole card |

For comparison: in the same period, all 13 cards of Opus 5.5 (auto/high) and Codex (gpt-6.1-sol, gpt-6-astra) had type and tags set and a workpad; the 4 cards of Sonnet 5.5 xhigh, and the Sonnet medium card with a longer description (an external item, 1972 characters), were also compliant. That is, **the violations are concentrated in "title-only small cards (empty description) + Sonnet medium/auto"**.

Workpad timing: even when written, it is often written after the implementation, even in the same minute as delivery (Phone performance optimization, Design end-to-end test plan, paseo project settings interop, Release v1.5.0), so "acceptance criteria before implementation" is largely not followed.

## 2. Causes

- **R1 Its position in the skill is late and the trigger moment is vague.** Of the 22 duties, tags, type and workpad are items 11–13, preceded by about 9 KB of explanations of questions, ideas, next moves, artifacts and external items. The wording is "Once you understand the scope", "once you understand the work", with no checkable moment; on a small card the agent "understands" after reading the title and goes straight to writing code.
- **R2 A missing item is silent.** `sessionContext` (`shared/scope.ts`) **omits** the `Task type:` and `Tags:` lines when there is no type/tags; in `flowly_get_task` a missing type is just an absent key, tags is `[]`, and workpad is `null`. Nowhere does it say "missing".
- **R3 Tool feedback covers only the wrap-up.** The existing reminders (NEXT-MOVES-SPEC §9) are only on in_review/blocked/question/result and only cover next moves and ideas. The evidence is direct: the violating sessions in the table above carried next moves on every delivery (the schema and result of `flowly_update_status` mention it), yet not one set type/tags — **the agent follows the tool schema and tool results, not the long skill**.
- **R4 The gate rewards the wrong thing.** `WORKPAD_OPEN` blocks only when "there is a workpad with unfinished items"; not writing a workpad means never being blocked.
- **R5 Zero-call turns.** "Make the sidebar..." and "README adjustments" never called any Flowly tool, so neither the reminders in results nor the gate touch them; only the first instruction can affect them (NEXT-MOVES-SPEC §9.1 already records this kind of turn).
- Model and thinking level are amplifiers, not the root cause: with the same skill, a strong model can dig the requirement out of the long text, while a weaker level does only what is visible in the schema. This spec does not branch by model, and does not change the default model ([MODEL-DEFAULTS-SPEC](MODEL-DEFAULTS-SPEC.md)).

## 3. Design

"Card setup" means three items: **type** is set, **tags** has at least one, **workpad** has content (at least one acceptance criterion or one check; when the project has the workpad turned off, this item does not count). It counts whoever set it (a type/tags set by a person also satisfies it).

The missing-item decision is the pure function `setupMissing(task, workpad, workpadOn): ("type" | "tags" | "workpad")[]`, in a fixed order, in `shared/card-setup.ts`, shared by the server and tests. An empty workpad (all three lists empty) counts as missing.

### 3.1 The `setup` field of `flowly_get_task`

The result adds it after `identity` and before `task` (key order fixed, so the agent sees it first):

```ts
setup: {
  typeMissing: boolean,
  tagsMissing: boolean,
  workpadMissing: boolean,   // always false when workpadEnabled=false
  stage: TaskStatus,         // the card's current status, same as task.status
  missing: ("type" | "tags" | "workpad")[],  // those of the three above that are true, in fixed order
}
```

The `current` of `toolResultSchema` carries it too (the `current` in a write result is also in the get_task shape). The CLI `current` prints it as is. Read-only, writes no event.

### 3.2 First task context

When `missing` is non-empty, `sessionContext` adds one line in the place of the `Tags`/type line (English, agent-facing):

`Card setup missing: type, tags, workpad. Before you change anything, set them (flowly_set_type, flowly_set_tags, flowly_update_workpad with acceptance criteria and the checks you will run); see "Start of every turn" in the Flowly skill.`

It lists only the items that are really missing; when the project has the workpad turned off, workpad is not listed. It does not appear when all three are present. It reflects the state at the moment the card is created / a session is opened / the explicit "work instructions" are sent; after that, get_task is authoritative. An ordinary follow-up message still sends only the user's own text (AGENTS.md) and does not add this line.

### 3.3 Setup reminder in write results

After every successful agent write tool (including replays), compute `missing` from the board after the write, and when non-empty add **one** merged text to `reminders`:

| Tool | Setup reminder |
| --- | --- |
| `flowly_update_status` (any target status) | yes |
| `flowly_report_progress` (any kind) | yes |
| `flowly_update_workpad`, `flowly_suggest_next_moves`, `flowly_add_artifact`, `flowly_remove_artifact`, `flowly_propose_idea`, `flowly_set_tags`, `flowly_set_type` | yes |
| `flowly_get_task`, `flowly_read_external`, `flowly_read_ticket` (read-only) | no (get_task has `setup`) |

- The computation is after the write: the result of `flowly_set_type` itself no longer mentions type, and after `flowly_update_workpad` writes non-empty content it no longer mentions workpad.
- It is not carried when the card is already Done/Cancelled or archived (same as the existing §9.5 rule). It is not carried when the write fails.
- When it appears together with a delivery reminder, the delivery reminder (next moves, ideas) comes first and the setup reminder after.
- Text (English; `{items}` lists only the missing items in order, joined with "; "):
  `This card's setup is incomplete: {items}. Make these calls now, before more work; they take seconds. This write already succeeded.`
  - type: `no type (flowly_set_type: feature, bugfix, research, refactor, docs or chore)`
  - tags: `no tags (flowly_set_tags: 1-4 module or direction tags, reuse projectTags)`
  - workpad: `no workpad (flowly_update_workpad: the acceptance criteria and the checks you will run, before you implement)`
- Noise trade-off: as long as something is missing, remind on every write (one line of text, gone once filled in). No "once per turn", because a missing item is exactly what should be filled in at the first write.

### 3.4 Delivery soft gate

When the agent calls `flowly_update_status(status=in_review)` and the status really changes (the same condition as the existing `WORKPAD_OPEN`; a person dragging is not checked), compute once:

- `missing` (defined in §3, including "no workpad");
- when there is a workpad, the `openItems` (WORKPAD-SPEC §5.3).

If either is non-empty and has not been rejected in this session for the current status, or there is no `acknowledgeOpen: true`: return an error, do not submit, write no receipt (the same request can retry with confirmation). One error lists all the problems, so the agent does not hit it twice in a row:

- There are unfinished workpad items: the error code is still `WORKPAD_OPEN` (compatible with existing agents and tests), and the message puts one line about the missing setup items (if any) before the original list.
- Only setup items are missing: the new error code `SETUP_INCOMPLETE`, with the message:
  `Card setup is incomplete: {items}. Set them now and deliver again. Deliver anyway only with acknowledgeOpen=true and a note that explains why each one is missing.`

After this session has received the rejection for the current status, a retry with `acknowledgeOpen: true` submits as usual; the `status_changed` event gains an optional `setup: { missing }` snapshot (alongside the existing `workpad` snapshot), for later Insights statistics. The "Delivered with {n} open items" count on the card face does **not** include setup items (this card changes no UI).

2026-10-22 revision: passing `acknowledgeOpen=true` ahead of time no longer bypasses the first rejection. The state fingerprint, expiry, turn-switch and reload rules are in [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §2.

The CLI already has `--acknowledge-open`, unchanged. The description of `acknowledgeOpen` in `flowly_update_status` becomes "…still open workpad items or missing card setup (WORKPAD_OPEN, SETUP_INCOMPLETE)…".

Change to WORKPAD-SPEC §5.3: step 2, "submit as usual with no workpad", becomes "with no workpad (when the project has it on), soft-gate per CARD-SETUP-SPEC §3.4".

### 3.5 Tool descriptions (`server/tool-server.ts`)

The agent follows the schema (R3), so the descriptions say it explicitly:

- `flowly_get_task`: append "Then check setup.missing and fix it (set_type, set_tags, update_workpad) before other work."
- `flowly_update_status`: add "Delivering with missing setup (no type, no tags or no workpad) returns SETUP_INCOMPLETE …"; in the write result "any write’s result may carry a setup reminder".
- `flowly_set_type`, `flowly_set_tags`, `flowly_update_workpad`: add the timing to the first sentence "Do this at the start of the work, before you change code."

### 3.6 Skill (`server/skill-source.ts` synced with `skills/flowly/SKILL.md`)

Under `# Flowly`, before the existing entries, add a section, and the other duties keep their original order after it:

```
## Start of every turn

1. Read flowly_get_task. Handle unread inputs first.
2. Fix setup.missing before anything else, small cards included (a one-line fix still gets a type, one tag and a workpad with one acceptance criterion and the check you will run):
   - type: flowly_set_type (only when missing; never change a set type);
   - tags: flowly_set_tags, 1-4 tags, reuse projectTags;
   - workpad: flowly_update_workpad with acceptance criteria and the exact checks, before you change code.
3. Set the stage that matches the work you are about to do (design, development, test).
4. End the turn as below: workpad checks updated, next moves on deliveries, questions and results.

Any write's result may carry reminders about missing setup; make those calls before you continue.

## Details
```

Also change the original entries: in the tags entry "Once you understand the scope" → "At the start of the work (Start of every turn, step 2)"; in the type entry "once you understand the work" → the same; the reminders entry adds "…and missing card setup (any write)"; the workpad entry adds "Delivering without a workpad, type or tags returns SETUP_INCOMPLETE; deliver only with acknowledgeOpen=true and a note that explains it." The skill `description` is unchanged.

### 3.7 Not done

- No change to write semantics: missing setup items only remind, and the only block is the delivery soft gate in §3.4, which can be let through with confirmation.
- The daemon does not send messages or call tools on the agent's behalf after a turn ends; no automatic guessing of type/tags (card item 5).
- No different treatment by model or thinking level.
- Showing "setup incomplete" to the user on the card face/drawer: a separate idea.

## 4. Onboarding and docs

- The only change the user can see is agent behavior (type, tags and workpad appear earlier; the delivery note explains missing items), with no new UI moment, so **no one-time tip is added**.
- The Workpad entry in the welcome page's feature list becomes: "Agents set the card's type and tags and write a workpad before they start: acceptance criteria, checks marked passed, failed or not run on a named commit, and what confused them. Delivering without them needs a note." The changed English key is updated in all catalogs in `shared/i18n/`.
- The workpad sentence in the README / README.zh-CN Highlights is synced to the same meaning.
- Agent-facing text and daemon errors stay English, not in i18n.
- At implementation, add a record at the top of SPEC-OUTLINE, and PROGRESS.md records the completed / failed / unrun checks.

## 5. Acceptance

Focused unit tests:

- `shared/card-setup.test.ts`: `setupMissing` for each of the three items missing / not missing; a type/tags set by a person counts as set; an empty workpad counts as missing; `workpadOn=false` does not list workpad; fixed order.
- `server/agent-service.test.ts`:
  - get_task carries `setup`, and each item becomes false once type/tags/workpad are filled in;
  - with type missing, `update_status(development)`, `update_workpad` and `report_progress(progress)` all succeed and `reminders` contains the setup reminder; **a type that is already set is no longer mentioned**; the result of `set_type` itself does not mention type; with all three present there is no `reminders` key; a replay carries it too; a Done card does not carry it;
  - when it appears together with the next moves reminder, the delivery reminder comes first;
  - delivery: only tags missing → `SETUP_INCOMPLETE`, status unchanged, no receipt; the same request with `acknowledgeOpen` → submitted and the event carries the `setup` snapshot; no workpad (project has it on) → `SETUP_INCOMPLETE`; project has workpad off and type/tags present → submitted as usual; workpad has unfinished items and type missing → `WORKPAD_OPEN`, with the message containing both;
- `shared/scope.test.ts`: `sessionContext` has a `Card setup missing:` line listing only the missing items when something is missing, and none when all are present.
- `server/tool-server.test.ts`: the `flowly_update_status` description contains `SETUP_INCOMPLETE`; the skill text starts with the "Start of every turn" section.
- `npm test` (including the i18n catalog check) and `npm run typecheck` pass.

Luna 6 verification (codex/gpt-6-luna, full-access; with the Tinylink project, and afterwards clean up only the cards and sessions it created):

- Create a small card with **only a title and no description** (reproducing the failing population of §1), open a `claude/claude-sonnet-5-5` session on it with thinking medium, and send one ordinary change request.
- Expected: the first context contains `Card setup missing:`; the agent sets type and tags and writes a workpad before the first `development`; if it does not, a setup reminder appears in the result of any write, after which it fills them in; at delivery there are no missing items, or after hitting `SETUP_INCOMPLETE` it fills them in / confirms with an explanation.
- Evidence (session ID, event timeline, write result excerpts) is saved to `docs/verification/card-setup-<date>.md`.

## 6. Where the implementation lands

`shared/card-setup.ts` (new), `shared/tools.ts` (the `setup` schema, the `acknowledgeOpen` description), `server/tool-server.ts` (tool descriptions), `server/agent-service.ts` (get_task, extending the reminders computation to all write tools, the merged delivery gate), `server/reminders.ts` (`setupReminder`), `shared/scope.ts` (first context), `server/skill-source.ts` + `skills/flowly/SKILL.md`, `server/cli-source.ts` (`status` usage text), `client/onboarding.tsx`, README, `shared/i18n/*`, WORKPAD-SPEC §5.3, and a row in the NEXT-MOVES-SPEC §9.2 table pointing to this document.
