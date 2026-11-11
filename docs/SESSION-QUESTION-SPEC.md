# Answer agent questions and approvals in the session

Status: implemented 2026-10-18 (card "提问能力接入"). User request: when an agent asks through its ask-user-question tool, the card shows attention but the question is not visible in the Flowly session; the user has to jump to the native Paseo session. Show the question in the Flowly session and answer it there. This adds to SESSION-UX / SESSION-ATTENTION; no board, task, project or receipt contract changes.

## 1. Capability

- Paseo forwards a provider's ask-user tool (Claude `AskUserQuestion`, Codex async questions, OMP/Pi ask-user) as a pending permission request with `kind: "question"` and `input.questions: [{ question, header, options: [{ label, description? }], multiSelect?, allowOther?, allowEmpty?, placeholder?, dismissLabel? }]`. Tool, plan and mode approvals are pending requests of other kinds.
- The public SDK already exposes both halves: `PaseoAgent.pendingPermissions` on every agent snapshot (the streamed live agent list and `agent.refresh()`), and `PaseoAgentHandle.respondToPermission({ requestId, response })`. No private client, local daemon connection or new RPC is needed.
- Answer encoding is Paseo's own question form (read from the 0.11.2 app): `{ behavior: "allow", updatedInput: { ...request.input, answers } }`, `answers` keyed by question **header**; several chosen labels (and typed "Other" text in a multi-select) are joined with `", "`; typed text replaces the choice in a single-select. The provider maps headers back to the full question text. Dismiss sends `{ behavior: "deny", message: "Dismissed by user" }`, except when every question is free-text with `allowEmpty`, which submits empty answers.

## 2. Behavior

- Session preview: while the selected session has pending requests, the warning-tinted form sits in the transcript's own scroll, below the newest output and above the running indicator, instead of stuck above the composer, so a long question never takes the screen from the conversation; the transcript follows the tail as usual, so a tall form opens at its bottom and scrolls up (2026-10-28, replaces the 2026-10-27 bounded box).
  - `question` with several questions (2026-10-27, card "question UI微调"): one tab per question, titled by its header (its number when the header is empty), and only the selected question below it. An answered question's tab shows a check. Picking an option never switches questions (the user declined auto-advance on 2026-10-27). On web, ←/→ switch to the previous/next question (no wrap, no modifiers, not repeated) while focus is inside the form and not in a typed answer; focus then moves to the form so the next arrow still works. Listed in the shortcut help. The forms keep every question's draft while switching tabs. One question: no tabs, header shown above it as before.
  - `question`: header, question text, options as radio buttons (single) or checkboxes (multi, "Choose one or more"), an "Other…" text box when `allowOther` or there are no options (placeholder from the request when given). On web, Enter in that box submits the form when every question is answered, otherwise moves to the next unanswered question (Shift+Enter is a new line; IME composition and key repeat are ignored, as in the composer); on phones the return key stays a new line. **Submit answer** is enabled once every question is answered; **Dismiss** (or the request's `dismissLabel`).
  - Any other kind (2026-11-10, card "show the request details"): title (or tool name) and description, then the request's details from `request.input` (`approvalDetail`), then the provider's `actions` (e.g. plan implement/dismiss) or **Deny** / **Allow**. Details by kind: `Bash` shows its `command` in monospace; `Edit` and `MultiEdit` show the file path and each change as "−" old and "+" new text (malformed `MultiEdit` entries are skipped); `Write` shows the path and content; a `plan` request renders `input.plan` (the full plan markdown, as Claude's ExitPlanMode passes it) as markdown, or, when the provider gives no plan text, "The full plan isn't available here. Open it in Paseo."; any other request, and a known tool whose input is malformed, shows its `input` as JSON behind a quiet **Show details** / **Hide details** toggle (collapsed by default); no input shows nothing. Each block scrolls inside itself (max height 240, nested scroll, selectable text) so **Deny** / **Allow** stay in reach. An **Open in Paseo** link (ArrowUpRight, accent) opens the session through `navigation.openAgent` (`openNativeSession`); it is hidden when the host cannot, in the session view and in the card drawer.
- Responding counts as an interaction (reads the session), re-checks fresh membership (`workspaceSession(..., true)`: same workspace, not archived, provider available) and that the request is still pending; otherwise "This request was already answered or withdrawn." Then `respondToPermission`, toast **Answer sent** / **Response sent**, jump to the latest output, refetch the agent and tail. Errors appear in the composer's error notice; the form keeps what was chosen. Controls are disabled while any operation on the session runs or the session cannot be written.
- The form is keyed by request ID, so a new request starts empty and a request answered elsewhere (Paseo, another client) disappears on the next agent update.
- Sending a message while a request is pending keeps the existing behavior (a queue becomes interrupt, as in Paseo).

### 2.1 Card Needs-you area (2026-10-19, card "提问框接入need you")

- The card drawer's top area, where Kanban `kind=question` reports show as "{agent} needs you" with **Reply**, also lists every live session of the card with pending requests: a "{agent} needs you" heading with **Open** (opens that session) and the same `PendingRequests` form as the session view. The user answers a question or approval without opening the session.
- Same rules as the session view: fresh membership check (`workspaceSession(..., true)`), "This request was already answered or withdrawn." when it is gone, `respondToPermission`, toast **Answer sent** / **Response sent**, sessions refetched. The per-session operation lock is shared with the session view, so a send and an answer on the same session cannot overlap. Errors show in the drawer's error notice. Controls are disabled while the drawer is busy, the session is locked, its provider is unavailable or the card is archived.
- In the drawer the form scrolls with the drawer (2026-10-27).
- The forms are memoized on the pending requests' content, so board refreshes do not reset a half-filled answer. The open-in-Paseo callback is stable (`useStableCallback`, memoized per session), so it does not defeat that. Strings: see §2 (2026-11-10: Show details, Hide details, the plan-missing line; "Open in Paseo for the full details." removed).

### 2.2 Which way agents ask (2026-10-20, card "提问方式优化")

- Problem: the Flowly skill named `flowly_report_progress kind=question` as the only way to ask, so agents with AskUserQuestion asked four independent decisions as text and the user could not pick each one.
- Skill rule (`server/skill-source.ts` = `skills/flowly/SKILL.md`): ask through the provider's own question tool when there is one (options per question, independent decisions in one call, wait and continue in the same turn); it already shows **Needs you** and is answered on the card or in the session (§2, §2.1, §3). `kind=question` is the fallback: no such tool, an open-ended question that needs a written reply, or a decision the user may take long over (end the turn; the reply starts the next one).
- Ask each question one way only. An answer in the tool form starts no new turn, so a `kind=question` report for the same question would stay open (`openQuestion`, AUTO-STATUS-SPEC) until the agent's next report, showing a second **Needs you** for an answered question.
- A question asked through the tool needs no next moves (the form holds the choices); next moves and their reminder still apply to `kind=question` (NEXT-MOVES-SPEC).
- The `flowly_report_progress` description says the same. No server, client, data or string changes; no onboarding change (the tour and the `agent-question` tip already describe answering on the card).

## 3. Status and attention

- A session whose pending request is a question shows **Waiting for your answer** (MessageCircleQuestion) instead of **Waiting for approval**; both use the warning tone and suppress the "· Unread" suffix.
- `sessionAttention` gains `question` (pending request is a question). The workspace summary counts such sessions under `questions` and no longer under `permissions`; the card shows **Needs you** for them rather than "1 approval". Attention items count them as `questions` (plus `asks`), not `permissions`; Needs-you totals, ordering and badges are unchanged.

## 4. Onboarding

- New one-time tip `agent-question` (highest priority, before `needs-you`): shown the first time a session in the current project waits on an agent question — "An agent is asking you something. Open the card's session to answer it right there, no need to switch to Paseo." As a new tip id it is shown once to existing users too.
- Tour feature "Needs-you reminders" adds "Answer questions and approvals right on the card or in the session." (2026-10-19: "on the card" added with §2.1; the `agent-question` tip is kept as is, by the user's choice.)

## 5. Architecture

- `shared/permission-question.ts`: pure parsing, draft transitions (choose / type other), answered checks, answer and dismiss replies, `pendingRequests`, `asksQuestion`, `approvalDetail` (what an approval asks to do, §2). Unit tests in `shared/permission-question.test.ts`.
- `client/session-question.tsx`: `PendingRequests` (memoized; RN primitives, `TextBox` for typed answers, shortcut block while focused).
- `client/session-preview.tsx`: renders it above the composer and owns the respond action.
- `client/drawer.tsx`: `CardRequests` renders it per session in the Needs-you area (§2.1) with its own respond action.
- `client/session-state.ts`, `shared/session-attention.ts`, `client/attention.ts`, `client/card.tsx`: labels and counts above.

## 6. Verification

- PASS: typecheck; unit tests for parsing, single/multi selection, Other text, Paseo-compatible answers, dismiss rules, malformed host data; attention question-vs-approval counts; tip priority; i18n catalogs (19 new strings, 9 languages).
- PASS (live, user, 2026-10-18): single select "C", multi select "A, B, Z" (two options + Other), Other-only free text, and Dismiss (agent received "Dismissed by user"). User feedback: Enter in the Other box did not submit → fixed (above).
- PASS (live, user, 2026-10-18): tool approval (create and delete a file) shown and answered from the Flowly session after the user switched the session to an always-ask mode. A read-only command right after the switch ran without an approval request.
- PASS (live, user, 2026-10-19): a two-question AskUserQuestion, and tool approvals Allow/Deny, answered from the card drawer's Needs-you area (§2.1).
- PASS (live, 2026-10-20, §2.2): under the new skill a Sonnet 5.5 session on a fresh card asked two independent decisions in one AskUserQuestion call, made no kind=question report, and after the answer continued in the same turn to a kind=result. [Evidence](verification/native-question.md).
- PASS (2026-11-10, `npm run typecheck` exit 0; `npm test` exit 0, 194 files passed, 1971 tests passed, 7 skipped): `approvalDetail` unit tests (Bash, Edit, MultiEdit with malformed entries, Write, plan with and without `input.plan`, unknown tool as JSON, malformed Bash as JSON, empty input); i18n catalogs (3 new strings, 1 removed, 9 languages). UNRUN: the approval details and the Open in Paseo link live in the session view and drawer, long-content scrolling, a live plan approval.
- UNRUN: phone layout, a plan approval from the session, and the Luna 6 test session. See `docs/PROGRESS.md`.
