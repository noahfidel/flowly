# New-user onboarding

Status: **implemented, real-UI verification pending** (2026-10-16, card "增加new user onboarding"; user approved the design and its five calls). This adds a first-run welcome tour, a better empty state and a few one-time contextual tips. It changes no business contract in SINGLE-ROOT, Phase 2 or AUTO-STATUS specs.

## Why

A new user opens Ultra Kanban and sees "No projects yet". The ideas the product rests on are never stated in the UI: a board project is a Paseo project root, a card is one workspace, sessions live inside the card, and card status is not session status. The headline features (cards that move by themselves, Needs you, run summaries, Ideas, Insights) are only discoverable by accident. The goal is that a first-time user, within a minute and without reading docs, understands (1) how Kanban objects map onto Paseo objects, (2) the basic loop, (3) what is special here, and ends the tour one tap from creating a project.

Success: a new user can say what a project, a card and a session are, who decides Done, and where to look when an agent needs them. Anti-goals: a blocking tour for existing users, a tour that is long, a tour that creates Paseo resources, tips that nag.

## Observable behavior

### 1. When the welcome tour appears

- The board screen shows it once per host (settings `onboarding`, host scope, like the other preferences) when **all** hold: settings have loaded successfully, `welcomeSeen` is false, and the board has loaded with **zero projects**.
- **Existing users are never interrupted.** If the board already has at least one project (archived ones count) when the settings first read as unseen, the client silently stores `welcomeSeen=true` and marks every tip as seen, so veterans get neither the tour nor first-time tips. They can open the tour manually (§4) or use *Show tips again*.
- Settings loading, error or invalid never show the tour (fail quiet). The tour never opens over another modal, over an open card, or while a shortcut dialog is open.
- Closing it in any way (Skip, Esc, scrim, finishing) sets `welcomeSeen=true`. It is not shown again automatically.

### 2. The tour: a modal sheet, five pages, skippable

Redesigned 2026-10-22 (card "重设计onboarding流程"): the tour also sets the basics. Pages (in a window of its own, about 780 wide, with Enter / → / ← navigation): How Flowly works (interface language, the three objects in equal columns, and the board's real Attention button over a Needs attention list of four cards waiting on a question, an approval, an error and a review, which you can open or dismiss; the lane strip and loop steps are gone), Built in (one live case with Flowly's real components in a frame tall enough that the idea below the expanded Progress card stays in view: a finished turn with its Progress card and a suggested Run tests; sending it rewrites Progress, suggests Push / Open a PR and brings an idea, and Good idea turns the idea into a task; Start over replays it; *Always on* once; below them the AI output language, the progress model and the *Also in sessions outside Flowly* switches), Project memory (two real memory cards) and Insights (the heatmap across the frame's width with weekday labels, ending today; tap a day or page with the arrows to change the selected day's summary card with per-card bars, which slides in from the paging side; and a two-line skill draft row, as on the real page since 1.7.0; switches Insights, Daily digest and Skills, Skills on by default since INSIGHTS-REDESIGN-SPEC §5), each with its switches, Ready when you are. The full behavior, when settings are stored, the first-run outside-session defaults and the settings-button callout are in [ONBOARDING-SETUP-SPEC](ONBOARDING-SETUP-SPEC.md); the page 1 and Ready descriptions below still apply, the old *What makes it different* page is gone (its tiles moved to pages 1, 2 and 5).

Uses the plugin `Modal` (host-owned open/close; content has the shared rise from `client/modal.tsx`). Same component on desktop and phone: single column, max width ~480, scrolls if the viewport is short. Footer: step dots, **Skip** (text button, all pages except the last), **Back** (from page 2), **Next** / final primary button. Page changes use `MotionReveal` (short, interruptible, Reduce Motion honoured, no delay before the action). The modal title carries the Flowly mark as its icon (`FlowlyMark` in `client/brand-icons.tsx`): the small-size mark from `docs/brand/logo/` (a solid start dot and an open end ring joined by one S curve), inlined as 20, 40 and 60 px PNGs per theme (ink on light surfaces, paper on dark; about 3 KB of source together) that `docs/brand/export-logo.mjs` generates into `client/flowly-mark-data.ts`. The one matching the screen's pixel ratio is shown, so the 20 pt icon is never resampled. It is decorative: the title already reads "Welcome to Flowly". No tip announces it (a visual change, no new capability).

> 2026-10-22 (user feedback): *The loop* below was replaced by *When an agent needs you*, a drawn Attention list and one paragraph on Needs you, Reply and Dismiss; the boxes are now equal-width and the small headings are plain section headings. Current layout: ONBOARDING-SETUP-SPEC §3 and §3.1.

**Page 1: How Flowly works** — "Everything on the board is a real Paseo object, so you can always open it in Paseo." The former map and loop pages are merged (user decision 2026-10-21: three pages instead of four). Two parts, each under a small muted heading:

*Three things* — a horizontal chain of three equal bordered boxes joined by chevrons, drawn with React Native views and `Icon`s, no images. Each box: icon tile, name, one short line, the Paseo object in muted text.

| Kanban | Short line | Is a Paseo… |
| --- | --- | --- |
| **Project** | One folder | project |
| **Card** | One task | workspace |
| **Session** | A chat with an agent | agent session |

*The loop* — a lane strip `Todo › Design › Development › Test › In review › Done` (wraps when narrow): Todo and Done are tinted in the accent colour (yours), the middle lanes are neutral (the agent moves them). Below it three steps, each with a role badge:
1. **You** — Make a project from a folder, add a task and start an agent.
2. **Agent** — Moves the card through the lanes. When it needs you, the card says Needs you.
3. **You** — Review the result and move the card to Done.

The old footer "card status and session status are separate" is dropped; the strip's accent Done makes the same point with less text.

**Page 2 to 4**: see ONBOARDING-SETUP-SPEC §3. A new user-visible feature normally gets a line under **More features** on the Ready page (listed, not collapsed) (Workpad, Inputs and outputs, Tickets, docs and PRs as inputs, Linear board, Dispatcher, Search, Cards from your agents, Tags, Switch to a worktree, Saved with your project, Backups); a built-in or advanced AI feature with a switch gets its block on page 2, 3 or 4.

**Page 5: Ready when you are**

Title with detail "Your first three steps." (plus "Nothing is created until you confirm." when there is no project yet), then one bordered checklist of three rows (empty circle, text, small accent icon): *Pick a folder to make a project.* / *Add your first task and start an agent.* / *Reply when a card says Needs you.* The rows are static, not tracked progress. Under **More features**, the *Send anonymous usage data* switch (`UsageDataGroup`, the same row as Settings → General; [TELEMETRY-SPEC](TELEMETRY-SPEC.md) §7), on by default; off and locked in a build without a PostHog key, as in this fork (TELEMETRY-SPEC §5, §6). Then the reopen hint. Primary **Create project** (opens the existing project form after the tour closes) with secondary **Not now**, or **Done** when a project exists. No project, workspace, card or session is created by the tour itself (no sample data).


### 3. Better empty states (always visible, not one-time)

- **No projects**: the current empty view keeps its icon and **Create project** button, and gains a compact three-chip strip "Project → Card → Session" (same wording as page 1) plus a "Take the tour" link. Visible even after the tour was seen, so it is never a dead end.
- **Project with no cards**: columns stay, and a quiet centred hint over the empty board reads "Add your first task. It gets its own workspace and sessions." with the **New task** button. Disappears with the first card.

### 4. Re-entry

- There is no board overflow menu, so the entries are: a **Welcome tour** help icon in the board header (desktop/tablet layout), **Settings → Welcome tour → Show welcome tour** (every layout, including phones) and the empty-board **Take the tour** link. There is no Command Center item for it (QUICK-TASK-SPEC §7); the `welcome` board intent still works as a screen param. Opening it manually ignores `welcomeSeen` and does not change it. The tour only opens in the full board screen, not in the workspace panel.
- Settings → Welcome tour also has **Show tips again**: clears `tipsSeen` only (the tour itself is reopened by hand; clearing `welcomeSeen` would make the board silently mark existing users again). Opening the tour from Settings closes Settings first and opens the tour 450 ms later. Settings is a React Native `Modal` and the tour a host `Modal`; swapping two modals in one tick is the suspected cause of a reported whole-app freeze (not reproduced; unverified).

### 5. One-time contextual tips (small, non-modal)

A tip is a single dismissible banner row (icon, one sentence, **Got it**) under the overview bar; only **Got it** records it as seen. Priority when several apply: agent-question, needs-you, attention-dismiss, first-done, older-finished, next-move, first-workpad, subagents, first-idea, idea-discuss, first-memory-candidate, first-skill-draft, first-workflow-insight, ai-language, summary-models, first-artifact, first-ticket, first-tag, first-card, dispatcher, card-display, search, connectors, session-history, sidebar-order, project-menu, all-projects, jira-connect. The empty-project hint takes the same slot and wins at the top of the relevant surface, using theme colours. At most one tip is visible at a time; a tip appears at most once per host (`tipsSeen`); dismissing or acting on the feature records it. Tips never block input, never move a focused input, and are not shown while the welcome tour is open or the settings callout (`settings-entry`) shows.

| Tip id | Shown when | Text |
| --- | --- | --- |
| `settings-entry` | the welcome tour closed during this visit (first run or manual) and nothing else is open; not a banner: a callout above the bottom-left settings button, which is outlined meanwhile; **Got it** or opening Settings records it (ONBOARDING-SETUP-SPEC §5). It outranks every banner tip. | "Turn features on or off and change settings here." |
| `first-card` | the project has a card and none is open | "Your card moves by itself as the agent works. Open it any time to see its sessions, output and summary." |
| `agent-question` | the first time a session in the project waits on an agent question (SESSION-QUESTION-SPEC) | "An agent is asking you something. Open the card's session to answer it right there, no need to switch to Paseo." |
| `needs-you` | the first time any card in the project is Needs you | "A card is waiting for you. Reply goes straight to the session." |
| `attention-dismiss` | three or more cards are in Attention and none is dismissed yet (ATTENTION-DISMISS-SPEC §6) | "Not ready to decide? Dismiss a card from Attention. It comes back when something new happens." |
| `next-move` | a session of the project has suggested next steps for its current turn (NEXT-MOVES-SPEC) | "When an agent finishes a turn, its suggested next steps sit above the message box. Tap one to fill it in; nothing is sent until you press Send." |
| `first-workpad` | the project's Card workpad switch is on, a card of the project has a workpad and no card is open (WORKPAD-SPEC §8, §9) | "This card has a workpad: the agent's acceptance criteria and checks. The card shows how many checks passed; open it to see which ran on which commit, and tick items yourself." |
| `subagents` | a session of the project has a live Paseo child agent (SUBAGENTS-SPEC §7) | "When a session starts subagents, a Subagents chip appears above its message box. Click it to see their status and open one in Paseo." |
| `first-idea` | the first time Ideas has an open item | "An agent suggested follow-up work. Good idea starts a card or continues here; Dismiss removes it." |
| `idea-discuss` | the project has an open idea and the board can open the dispatcher chat; pressing Discuss marks it seen (DISPATCHER-SPEC §9.5; new id, so every existing user sees it once) | "Not sure about an idea? Discuss puts it in the dispatcher's message box to talk it through. Nothing is sent until you press Enter." |
| `first-memory-candidate` | the current project has a project-memory candidate waiting for review and no card is open (PROJECT-MEMORY-SPEC §11); read from `memory.counts` with the board | "An agent suggested something to remember. Confirm it in Memory and new sessions on this project will know it; you can edit or delete it any time." |
| `first-skill-draft` | Insights and Skills are on and the current project has an open skill draft; read once per project while unseen, no polling; opening Insights also marks it seen (INSIGHTS-REDESIGN-SPEC §5) | "Insights drafted a skill from your cards. Open Insights to add it to the project." |
| `first-workflow-insight` | Workflow insights is on and the current project has an open suggestion (WORKFLOW-INSIGHTS-SPEC §8); read once per project while unseen, no polling | "Workflow insights found repeated work worth keeping. Open Insights to turn a suggestion into a card." |
| `first-artifact` | a card of the project has an artifact and no card is open | "Cards now collect artifacts: the files and links a task worked from and delivered. Agents add them as they work; you can add your own in the card." |
| `first-tag` | a card of the project has a tag an agent added and no card is open | "Agents tag their cards by module and direction. Open a card and tap a tag to filter the board by it, or search #tag." |
| `first-done` | the user first moves a card to Done/Cancelled | "Done cards can be wrapped up: archive their sessions and workspace. Auto wrap up is in settings." |
| `older-finished` | the current project has old Done/Cancelled cards folded under "Show older" (and at least one of those lanes still folds them) | "Cards that finished a while ago fold under “Show older” at the bottom of Done and Cancelled. Settings → Workflow sets how long they stay." (FINISHED-CARDS-SPEC) |
| `first-ticket` | a card of the project has an external input (Jira, Confluence, GitHub, GitLab, Azure DevOps) and no card is open (EXTERNAL-TRACKER-SPEC, CONNECTORS-SPEC) | "A card has an item from a connected service as an input. Agents read it every turn and see when it changes. Flowly never changes it there, and its status doesn't move the card." |
| `card-display` | the current project has 6 or more active cards and no card is open (CARD-DISPLAY-SPEC §5) | "Cards too busy? Choose what they show in Settings → Cards, or from the Sort menu → Card display." |
| `dispatcher` | the project has a card, no card is open and the dispatcher chat is closed; opening the chat marks it seen (DISPATCHER-SPEC §9.3; new id, so every existing user sees it once) | "The dispatcher is one agent for all your projects. Open its chat from the toolbar, ask for work, and it makes the cards and starts them." |
| `search` | the current project has 10 or more cards that are not archived and no card is open (SEARCH-SPEC §8) | "Find past cards, notes, workpads and deliverables with the search button or S." |
| `quick-task` | the current project has a card; lowest priority, so it shows once no other tip is due (QUICK-TASK-SPEC) | "New task now opens Quick task: say what you want done and press Enter. More options opens the full form; Settings → Workflow turns it off." |
| `connectors` | a card is open, so its Artifacts + is in view (CONNECTORS-SPEC §8.5; new id, so every existing user sees it once) | "The Artifacts + now adds Confluence pages and GitHub or GitLab issues and pull requests too, besides files, links and Jira tickets. Connect services in Settings → Connections." |
| `session-history` | a card is open and it has a session (SESSION-PANE-SPEC §1) | "A session's output now starts at the beginning of its current turn. Press Load earlier at the top to read further back." |
| `ai-language` | a card of the current project has an AI progress summary (AI-LANGUAGE-SPEC §7) | "AI-written text follows Settings → AI features → AI output language. It starts as your interface language." |
| `summary-models` | the card has a summary; after `ai-language`; seen on visiting Summary models in Settings or the tour | "Choose summary models and their fallback order in Settings → Models. The default is Haiku, then Luna." |
| `sidebar-order` | a card is open and it has at least one artifact or idea (DRAWER-SPEC, Section order) | "Arrange an open card your way: reorder its sections and choose which start open in Settings → Cards → Card sidebar." |
| `project-menu` | desktop project tabs show two or more projects and no card is open (PROJECT-TABS-SPEC) | "Drag a project tab to reorder it. Right-click it for its settings, a new task, Insights, Ideas or Remove." |
| `all-projects` | the All projects tab or switcher entry is available (2+ live projects, setting on) and no card is open; shown on a project board (ALL-PROJECTS-SPEC) | "All projects shows every project's cards on one board. Settings → Workflow turns it off." |
| `jira-connect` | the project has a card, no card is open, and no connection is configured (announces the feature; lowest priority) | "Work from Jira, Confluence, GitHub, GitLab, Azure DevOps or Linear: connect them in Settings → Connections, then start a card with From… or add items with the Artifacts +. Flowly only reads them." |

Tips are the lowest-priority part of this feature and can ship after the tour (see Delivery).

### 6. What's new after an update

Existing users (tour seen) get a small *What's new* window once per release that has items in `client/whats-new.ts`: one sentence per change with an optional Open settings / Take the tour button. It opens on the newest release and pages back to older ones (from 1.5.0), and can be reopened from Settings → General. New users skip it: closing the first-run tour also stores the current release as seen. Full behavior: [WHATS-NEW-SPEC](WHATS-NEW-SPEC.md).

## Data contract

New host-scoped setting in `shared/settings.ts`, same pattern as `ideasSettings` (read through a `…Values()` helper that tolerates missing fields):

```
id: "onboarding", scope: "host", version: 1
schema: { welcomeSeen: boolean = false, tipsSeen: string[] (max 100, ids ≤ 40 chars; was 20 until 2026-10-21, when 20 tips made each new tip evict the oldest) = [], whatsNewSeen: string (max 20; the release whose What's new was last seen, WHATS-NEW-SPEC) = "" }
```

The daemon only registers the setting (`server.registerSettings(onboardingSettings)`). No board schema, RPC, tool or skill change; no migration; agent-facing text is untouched. Settings are per host, so a user on a second device sees the tour once there too; this is accepted.

Pure logic lives in `client/onboarding-logic.ts` (not `onboarding.ts`: it would shadow `onboarding.tsx` in module resolution) so it can be unit-tested without rendering: `shouldShowWelcome({ settingsStatus, welcomeSeen, boardLoaded, projectCount, blocked })`, `shouldAutoMarkSeen(…)` (existing users), `nextTip({ tipsSeen, facts })`, and page-index stepping. UI and the `useOnboarding` hook (optimistic overlay, revision-conflict merge and retry, like `board-view.ts`) in `client/onboarding.tsx`. The board only mounts the tour component and passes facts; it does not own onboarding state.

## Constraints from AGENTS.md

- React Native primitives, theme colours, `Icon`; no HTML/DOM/CSS strings. Plugin-owned open/close and page changes use the shared motion primitives; honour Reduce Motion; no listeners left after close.
- All strings via `t()`/`tn()` and added to every catalog in `shared/i18n/` (`shared/i18n.test.ts` enforces completeness; 9 non-English catalogs).
- Performance: the tour mounts only when due (no hidden subtree on phones); tips read facts the board already has (project count, attention items, ideas list) and add no polling or query.
- The tour must not use a bare controlled `TextInput` (it has none).
- Statuses/lanes in copy use the user's lane names where available, otherwise the defaults.

## Not in scope

Interactive coach-mark overlays that point at live UI (fragile across desktop/phone layouts), sample/demo projects (would create Paseo resources), video, per-user server-side onboarding state, onboarding for Paseo itself, changing agent prompts or the skill.

## Delivery and acceptance

Implemented: settings + logic + tests, tour modal and all entry points, empty states, tips, and 47 new strings in all 9 catalogs.

Run and passing: `npm run typecheck`, `npm test` (63 files / 395 tests, including `client/onboarding-logic.test.ts` and i18n completeness).

Covered by unit tests: the pure logic (fresh user shows; existing user silently marked; settings loading/error never shows; manual open leaves `welcomeSeen`; one tip at a time; tips once only), i18n completeness. Real-UI verification (desktop and compact, light and dark, Reduce Motion, tour on first run, empty states, re-entry, tips) in an explicitly full-access `codex/gpt-6-luna` session against the non-fullscreen Paseo window with a fresh settings state; record evidence in `docs/verification/onboarding.md`. Anything not exercised on a real window is recorded UNRUN. **Status: UNRUN.** The plugin has not been reloaded and no Luna session or window was used.

## Calls I made that you can overrule

1. Existing users are not shown the tour (silent mark), because an unexpected modal on a working board is worse than a missed intro.
2. Four pages, modal sheet, no spotlight overlays.
3. No sample project is created.
4. Tips are a separate, optional stage and can be dropped without affecting the tour.
5. Onboarding state is per host (setting), not per account.

2026-10-23：Progress models 与 Settings → Models 共用有序多模型列表，见 [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md)。
