# Auto review P1: live check on Tinylink (2026-10-28)

Card `4286f00a` (Auto Review), session `1380a902`. Working tree on `ff3b83e` + uncommitted P1 changes, plugin loaded from this checkout, Paseo daemon 0.14.0-beta.1. Driver: `drive.mjs`; screenshots: `shots.mjs` (shot-lib, system Chrome via `PLAYWRIGHT_CHROMIUM_PATH`).

## First attempt (04:32Z): blocked by the host

Daemon was still 0.13.2 while the app was 0.14.0-beta.1; after the plugin reload no session could be created (`before agent.session_open` validation). Card `d7d43c06` removed, no session created. The user restarted the daemon on 0.14; sessions work again.

## Run (04:41–04:47Z): pass

Fixture: temp card `563bc6ef-03f5-4892-9633-c4eeec2b51f9` (workspace `wks_c9018540022e133a`), Haiku 5.5 session `e0cd33f2-1218-4536-8662-d1e25ff2c207`; Tinylink Auto review with one failing check (`node -e "…process.exit(1)"`), max rounds 1.

| Step | Expected | Seen |
| --- | --- | --- |
| Agent delivers from Development (04:42:12) | review waits for the turn to end | turn ended 04:42:15, `review_started` 04:42:16 |
| Check exits 1 | R1 back to Development, then the marked message | `status_changed [R1] in_review→development`, new turn 04:42:16 with `[Flowly auto review · rework 1/1]` + output (`failed-session.png`) |
| Agent redelivers in the rework turn | same round continues; past the limit → Blocked, no message | round 2, `[R2] in_review→blocked`, "Auto review failed after 1 rework round", no further message |
| Card face | Review failed | `failed-board.png`, `failed-drawer.png` (card moved to In review by a person to show it; Blocked lane is collapsed in the user's view, left as is) |
| Card panel | Auto review block, failed check with output, shared-workspace note, Rerun | `failed-drawer.png` |
| Attention | failed review listed | "Tinylink · In review · Review failed" (`failed-attention.png`) |
| Project settings | switch, command lines (quotes kept), max rounds | `failed-settings.png` |
| Person moves card into In review | no review starts | none started |
| Check switched to `node --test`, Rerun pressed in the panel | round 1, real Tinylink tests pass, card stays in In review | `review_finished` "Auto review passed (1 check)", "Review passed" on the card (`passed-drawer.png`) |
| Attention after a pass | no review signal | "Nothing new needs your attention" (`passed-attention.png`) |
| One-time tip | `auto-review` shown | banner on the board (`failed-board.png`); not dismissed, so the user's tip state is unchanged |

Page errors during the screenshot runs: none.

## Finding (cosmetic, not fixed)

The rework message wraps the check output in ``` fences; Paseo shows user messages as plain text, so the fences appear literally in the session view. Agents read it fine.

## Cleanup

- Card `563bc6ef…` deleted with archive: session `e0cd33f2…` archived, workspace archived and not in `paseo workspace ls`; backups in `~/.paseo/plugin-data/flowly/removed/`.
- Tinylink Auto review back to `{ enabled: false, checks: [], maxRounds: 2 }` (it had none before; same behaviour).
- Tinylink repo: `git status` clean, HEAD `47899f7` unchanged. Its git-ignored `.flowly/project.json` snapshot was rewritten by the project edits, as for any project edit.

## Running-review strip (04:53–04:56Z)

User request: while a review runs, a strip opens under the card with the dot sweep. Fixture card `680e927f-47ee-4189-ae67-1b45f13d493e`, Haiku session `27d4c09f-e8ed-4239-ade5-358d7aa45598`, one 45 s check (`node -e "setTimeout(…, 45000)"`).

- During the review the card shows the strip: spinner icon, "Reviewing", dot sweep behind it (`running-board.png`, close-up `running-strip.png`); no "Reviewing" in the signal row.
- After it the strip is gone and the signal row says "Review passed" (`finished-strip.png`).
- One open page across a Rerun (`live.mjs`): no strip before, strip appears after Rerun, gone when the review ends; no page errors (`live-0-before.png`, `live-1-running.png`, `live-2-after.png`).
- Cleanup: card deleted, session and workspace archived, Tinylink Auto review off, repo clean at `47899f7`.

## P2: rules, setup card and per-rule results (05:40–05:52Z)

Working tree on `ec464ea` + uncommitted P1/P2 changes, plugin reloaded from this checkout, daemon 0.14.0-beta.1. Driver `drive.mjs` (now takes rules), screenshots `shots-p2.mjs` (shot-lib, system Chrome).

Fixtures: setup card `f5fe3311-f0a6-46af-b619-94c746db4876` (workspace `wks_3c5633e4acf2bf47`, session `53e73598-ae02-4cdc-b156-94da84db257d`, Opus 5.5 = global default model); fixture card `e5dd428e-9740-473a-a1c3-be8e5b474c11` (workspace `wks_6fee66086d9ad874`, Haiku session `296775e4-b63c-42db-bb66-3597b3eed172`).

| Step | Expected (§12.8) | Seen |
| --- | --- | --- |
| Project settings, Auto review switched on (unsaved), **Set up with AI** | "Auto review setup" card and session, first message = setup instructions | card in Design, session running with the 8-step instructions (`p2-settings-before.png`, `p2-setup-card.png`) |
| Setup agent | reads repo, asks, runs commands, `flowly_propose_review_rules` | read package.json/README, ran `npm test` (13/13, 0.36 s), asked, proposed 5 rules (1 command, 4 LLM, card types set), delivered to In review |
| Draft shown | project settings and the setup card's drawer, project revision unchanged | both show note + Added list (`p2-draft-settings.png`, `p2-setup-drawer.png`); revision stayed 8 |
| **Apply and turn on** in settings | rules replaced, revision +1, draft cleared, Auto review on, settings close | revision 8→9, `enabled: true`, 5 rules, `reviewDraft` gone (`p2-applied-settings.png`) |
| Setup card delivered to In review | no review | none (Auto review was off at its delivery; the "setup card not reviewed" case is covered by `server/auto-review.test.ts`) |
| 3 command rules, 2nd fails, + 1 LLM rule | all 3 run: passed/failed/passed; LLM skipped; R1; rework message lists the failure | exactly that; message `Commands: 2/3 passed` / `✗ Unit tests (…) exited 1.` + tail / `LLM review: skipped (command rules failed)`; redelivery → round 2 → R2 Blocked (`p2-commands-drawer.png`) |
| Commands pass, 2 LLM rules (one fail, one N/A), Rerun from the drawer | LLM group 1 failed + 1 Not applicable, reason in rework message | Haiku review: `note-ticket` failed with detail, `limiter` na; R1 to Development (`p2-llm-drawer.png`) |
| While running | drawer per-rule state, card "Reviewing n/N" | strip showed "Reviewing 2/4" with commands done and LLM rules running (`p2-running.png`) |
| Review session | hard-deleted | no "Flowly review" session in `list_agents` even with archived included |

Page errors in every screenshot run: none.

### Found and fixed during the run

A rule row that turned failed while the drawer was open stayed collapsed (its open state was set only at mount). `client/task-review.tsx` now keeps the toggle unset until the user presses it; rerun confirmed the failed LLM row opens with its detail. typecheck and the full suite were rerun after the fix.

### Notes

- Set up with AI shows only after the Auto review switch is on (the switch can stay unsaved; Apply turns it on). A user with Auto review off has to flip the switch first to find the button.
- The setup session uses the project/global default model (here Opus 5.5).
- My first answer to the setup agent's question tool through the Paseo MCP `respond_to_permission` used a wrong payload shape, so the agent fell back to `kind=question`; answered with a message. Not a Flowly problem.

### Cleanup

Both cards deleted with archive (sessions archived, workspaces gone from `paseo workspace ls`, backups in `~/.paseo/plugin-data/flowly/removed/`); the idea the setup agent proposed went with its card. Tinylink Auto review back to off with no rules (`{ enabled: false, maxRounds: 2, rules: [] }`), no draft, 6 cards; repo clean at `47899f7`.

## Review fixes (session f30823c6), 06:03Z

Driver `live-stale.mjs` (one temp card `dad77e78-979e-423a-a7c0-5935c377ef46`, Haiku session `ab566cb0-8859-4184-8cdb-516816ef1c67`; drafts proposed through that session's own Flowly CLI context so the timing is exact). An earlier attempt left card `3d6cb5be…` when the CLI lacked `PASEO_AGENT_ID`; it was deleted the same way.

| Step | Expected | Seen |
| --- | --- | --- |
| Settings open with draft A, Auto review off | draft A shown; Set up with AI shown with the switch off | both (`fix1-draft-a.png`) |
| Agent proposes B, Apply pressed on the page still showing A | refused as stale, nothing written; page shows B with a notice | `stale`, revision 12 unchanged, Auto review still off, page shows "Draft B" and "The agent proposed a new draft. Review it before applying." (`fix1-stale-notice.png`) |
| Discard on B (now shown) | allowed | draft cleared, revision 12 |

Page errors: none. Cleanup: card deleted with archive (session archived, workspace gone), no draft left, Tinylink Auto review off with no rules.

## P3 (08:14–08:22Z)

Working tree on `064727e` + uncommitted P1–P3 changes, plugin reloaded from this checkout. Drivers: `live-p3.mjs` (steps insufficient, cards, rework, state, goal, cleanup) and `shots-p3.mjs` (shot-lib, system Chrome). Fixtures: cards `a5851ec4…`, `1566a213…`, `349dccf3…` (P3 fixture 1–3) and `1afcb462…` (goal fixture), each with one Haiku session.

| Step | Expected (§13.2) | Seen |
| --- | --- | --- |
| `reviews.analyze-history` with Tinylink's 3 past deliveries | insufficient, no model | `{ status: "insufficient" }`, status `eligible: false`, no session created |
| Edit project, switch on (unsaved), 6 deliveries now | built-in check first, detected commands ticked, Use these | "Does what you asked" + `Tests · npm run test` (ticked); Use these added it to Checks (`p3-detect-before.png`, `p3-detect-after.png`); Suggest checks from past cards shown (eligible); nothing ran |
| Each fixture delivered, then a person's "REWORK: …" message; the session did work and delivered again | rework counted, not restored | three A1 in_review→development, no A1r |
| Insights, Auto review off | nudge with daemon counts | "Of the 5 cards delivered in the last 14 days, you sent 4 back…" (one of the 5 is Tinylink's own card with an earlier rework), the three fixtures, Set up auto review / Not now (`p3-insights.png`) |
| Set up auto review | Edit project, Auto review first, analysis running, then the draft | "Analyzing past cards… uses tokens" (`p3-setup-running.png`), then "Checks from past cards": 5 delivered / 4 sent back (same as the daemon), reason "README not updated…" with links #a585 #349d, one new LLM check on 2 cards, ticked, Use these and turn on (`p3-setup-draft.png`); draft `by: { analysis: true }`, project revision unchanged |
| Analysis session and background workspace | hard-deleted; workspace archived | no "Flowly auto review analysis" session in `list_agents` (archived included); no active Flowly background workspace |
| Auto review on with only the built-in check; the goal card's first message asks for a CHANGELOG entry, then says to skip it for now | the check does not fail for the skipped entry | detail: "the CHANGELOG entry was deferred, so its absence is correct" |
| Drawer of the goal card | Auto review above a closed Workpad | yes (`p3-goal-drawer.png`) |

Page errors in every screenshot run: none.

### Finding during the run (D6, shared workspace)

The goal check failed the goal card anyway, for a real change: fixture 2's Haiku session, told not to edit files, added an expired-link test to `test/stats.test.js` in its rework turn. Every fixture card shares Tinylink's root directory, so the goal card's diff held that edit, and the reviewer cited it with file and line. This is the known shared-workspace limitation (§2.3, D6), not a P3 defect. The stray edit was the test's own; it was restored with `git checkout -- test/stats.test.js` and the repo is clean again.

### Not verified live

- The "fewer than 5 deliveries hides Suggest checks from past cards" branch in the UI: Tinylink already had 3 deliveries and the fixtures made 6; the RPC branch was verified before the fixtures existed, the UI by unit test.
- Unticking a check before Apply (`exclude`), Not now, Add check, pause suggestions and the What's new button: unit tests only.

### Cleanup

All 4 cards deleted with archive (sessions archived, workspaces gone from `paseo workspace ls`); analysis draft discarded; Tinylink Auto review back to `{ enabled: false, maxRounds: 2, rules: [] }`; 6 cards; analysis status back to not eligible (the deleted cards' deliveries left the count); repo clean at `47899f7`.

## P3 review fixes (session f30823c6 round), 2026-10-28

Uncommitted tree on 064727e. `npm run typecheck` exit 0; `NODE_ENV=test FLOWLY_TELEMETRY=0 npm test` exit 0: 146 files, 1251 passed, 1 skipped.

Live on Tinylink (`live-p3.mjs cards` / `rework`, `shots-p3.mjs insights insights-quotes`, `shots-p3.mjs setup merged`):
- Memory clues for the three rework messages were written 08:47:11–08:47:43, after turn_ended. The Insights rework nudge now quotes all three (`p3-insights-quotes.png`, `.txt`). Before the fix it showed none.
- The switch stays off; Set up auto review → the analysis draft shows one list: Does what you asked, the detected `npm run test` (checkbox), and the analysis check "README documents API changes" (2 cards). One button, Use these and turn on (`p3-merged-draft.png`). The reason row carries the user's words.
- Cleanup: the 3 cards were deleted (sessions/workspaces archived), the draft discarded, and autoReview set back to `{enabled:false, maxRounds:2, rules:[]}`. The Haiku fixtures again edited README.md and test/stats.test.js despite the prompt; both were reverted with `git checkout`. Tinylink is clean at 47899f7.
- Not run live: Apply with a detected command unticked (covered by `server/auto-review.test.ts` "apply-draft add"), and the 10-per-kind refusal (unit tests).
