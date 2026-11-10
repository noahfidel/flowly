<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/flowly-lockup-dark.svg">
    <img src="docs/brand/logo/flowly-lockup-light.svg" alt="Flowly" height="56">
  </picture>
</h1>

**Flowly** — the agent-native workflow for Paseo.

**English** · [简体中文](README.zh-CN.md)

**A Paseo plugin that turns agent sessions into a workflow that runs itself, with a kanban board as its face.** You hand out work, make the calls, and review. Progress, reminders, summaries, follow-up ideas and daily stats are kept up to date by the board.

> Plugin ID `flowly` · requires Paseo `>=0.11.2` · runs on desktop, tablet and phone clients.

![Board: cards move across Design, Development, Test and In review as agents work](docs/promo/screenshots/01-board-auto-status.png)

<details>
<summary>Dark theme</summary>

![Board, dark theme](docs/promo/screenshots/01-board-auto-status-dark.png)

</details>

## Install

```sh
paseo plugin add jasprw/flowly
```

This installs the version reviewed in the [Paseo plugin registry](https://paseo.sh/plugins). The package is also on npm as [`paseo-flowly`](https://www.npmjs.com/package/paseo-flowly) (`paseo plugin add npm:paseo-flowly`). To install the latest `main` straight from Git instead, use `paseo plugin add git:JasprW/flowly`.

Open **Flowly** from Paseo's sidebar. The daemon needs the `paseo` CLI on its path to register a new native project.

## Highlights

### 1. Automatic status flow

Start a session from a card and the card follows the work: **Design → Development → Test → In review → Committed → Integrated**. The agent sets its stage through scoped Kanban tools, moves the card to Committed once it has committed the card's changes at your request, and to Integrated once those commits are in the main checkout's branch; the daemon also moves cards when a session starts or resumes a turn. A finished turn never marks a card Done. Done and Cancelled stay your decision. Cards show running, finished, unread and needs-attention session counts, and the latest agent output. Cards that finished more than 14 days ago (configurable in *Settings → Workflow*) fold under **Show older** at the bottom of Done and Cancelled, so the board stays about current work.

Turn it off globally (*Settings → Workflow → Moving cards*) or per project.

### 2. Needs-you reminders

When an agent needs a decision it asks one clear question and stops. The card lights up **Needs you**, the **Attention** dropdown and the sidebar badge count it, and **Reply** jumps straight to that session. Approvals and errors are surfaced the same way. Not ready to decide? **Dismiss** a card from Attention: the count drops, the card keeps its signals, and it comes back as soon as something new happens. Questions an agent asks with its ask-user tool, and approvals, can be answered right on the card's detail page or in the Flowly session.

When a turn ends, the agent can leave its **suggested next steps** ("Verify with Luna", "Commit and push") above the session's message box. Tapping one only fills the box; you edit it or send it yourself. Once the work is committed and pushed, an agent can also offer **Move to Done**: that one doesn't fill the box, tapping it moves the card (Done stays your decision). They disappear once your next message starts a new turn.

The same features follow a Flowly session into **Paseo's own session view**: each progress summary appears as a **Progress** row in the conversation, the suggested next steps appear as a card under the agent's last reply: tapping one fills in Paseo's message box on web and desktop (or copies it; you choose in Settings → AI features), and nothing is sent until you send it. An **Ideas** chip next to Paseo's message box lets you continue an idea in this session, start a new task from it, or dismiss it. Optionally (off by default; Settings → AI features), sessions Flowly does not manage get the same progress row, next steps and ideas, kept with the session rather than in a project; their ideas can continue there or start in a new session or workspace.

![Suggested next steps above the message box: Verify with Luna, Commit and push, Add 429 tests](docs/promo/screenshots/06-next-moves.png)

![An agent's question on a card, with a Reply button](docs/promo/screenshots/02-needs-you-drawer.png)

### 3. Run summaries

After every completed turn a cheap model (Haiku 5.5 by default, configurable) updates the card's **state / target / recap / next**. Past versions are kept, so you can still see how far a card got after it is Done. Summaries never change the card's status.

![Card summary: state, target, recap and next step](docs/promo/screenshots/03-card-summary.png)

Agents also keep a **Workpad** on the card: acceptance criteria, the checks they run (passed, failed or not run, each on a named commit, with the exact command) and what in the card confused them. Their plan comes from their own todo list. The card shows **Checks 3/5**; a check that ran on an older commit than the workspace's HEAD reads *out of date*. You can tick criteria and set a check's state yourself. Before they start, agents set the card's type and tags and write the workpad; until they do, every Flowly tool result reminds them. An agent delivering to In review with open items, or without a type, tags or workpad, has to acknowledge that with a note, and with open items the card then says **Delivered with N open items**. Turn it off per project with *Card workpad* in the project settings.

### 4. Follow-up ideas

Work an agent discovers along the way (a bug it tripped over, a limitation, the next step) lands in the project's **Ideas** inbox instead of being lost in a chat. **Good idea** gives you two paths: continue in the same session, or start a new card or new session with the context pre-filled. **Discuss** puts it in the dispatcher chat to talk it through first. **Dismiss** removes it. Agents never create cards or start work on their own.

![Ideas inbox with source cards](docs/promo/screenshots/04-ideas-inbox.png)
![Good idea: start a new task, continue in the session, or use a new session](docs/promo/screenshots/04b-good-idea-two-paths.png)

What should outlive a card goes to **project memory**: decisions you made (including the options you turned down), pitfalls and dead ends, how you want work done, and the people and systems involved. Agents suggest entries with `flowly_remember`, and a cheap model reviews each card you move to Done and suggests at most one more, only when it holds beyond that card; nothing counts until you confirm it on the project's **Memory** page (`M`). Confirmed entries go into the first instructions of the project's new sessions (all of them while they fit, otherwise the pinned and most relevant ones; agents look up the rest with `flowly_recall`). You can edit, pin, archive or delete any entry, copy one as an `AGENTS.md` rule, and turn memory off per project. It is stored on your machine, never in the repository.

**Search** (`S`, or the search button) looks through past cards: titles, summaries, progress notes, workpads, ideas and deliverables, so pasting a PR link or a Jira key finds the card behind it. It covers the current project or all of them, and runs on your machine. Agents search the same history with `flowly_search` when they start on an area.

### 5. Inputs and outputs

Each card has an **Artifacts** list: the documents, links and deliverables it worked from (inputs) and produced (outputs). Agents register them through the board tools as they work; you add, edit or remove your own from the card. Only references are stored; files stay where they are and open in a read-only preview. Every entry shows whether you or an agent added it, and agents can't remove the ones you added.

**Tickets, docs and pull requests** can be inputs too: Jira tickets, Confluence pages, GitHub or GitLab issues, pull requests and merge requests, Azure DevOps work items, and Linear issues. Connect a service in Settings → Connections (self-hosted or cloud, with a personal access token, API token or API key), then start a card with **From Jira / From GitLab / From Linear / …** or add an item from the one **+** in a card's Artifacts. The picker lists your recent items (assigned to you, awaiting your review, or pages you edited) and searches by key, link, number or title words; GitHub and GitLab search the project's own repositories first, found from its git remotes. Agents read the item with `flowly_read_external` (description or page content, comments, and for pull/merge requests the branches, head commit and changed file names) and see when it changes. Flowly only reads: it never comments, approves, merges or changes anything, and an item's status never moves a card. Tokens stay on the daemon machine.

With a Linear connection, **Linear** appears in Paseo's sidebar: a board of your Linear issues (assigned to you, or any team) in columns by state, or as one list. Open an issue to read it; **Start card** opens Quick task with the issue attached, so Enter starts the agent. An issue that already has a card offers **Open card**. The board only reads Linear.

Once an agent understands the work it fills in the card's metadata itself. It sets the **task type** (feature, bugfix, research, refactor, docs, chore) when the card has none, never overriding one you chose. It also adds **tags** for the modules and directions the card touches (`drawer`, `performance`, `a11y`), separate from the fixed task type. Agents reuse the project's existing tags rather than inventing synonyms; you add or remove tags in the card or the form. Filter the board by tag, or search `#tag` (`#module/` matches a prefix). Agents can't remove tags you added.

### 6. Project insights

Insights shows a year of the project's activity, GitHub style: one square per day, darker for more agent turns, with no totals or streaks. Tap a day, or page through days with the arrows, to see its AI summary (written the first time you open a past day), its turns, agent time and tokens, and its cards, each with a bar for how much of the day it took. Below it, **Skills** turns what agents keep redoing into project skills (see below); other suggestions (scripts, repo tools, AGENTS.md rules) are folded underneath, followed by the last 7 days' review rounds, one-pass share and tokens per card by model.

![Project insights: a year of activity, the selected day's summary and Skills](docs/promo/screenshots/05-insights.png)

<details>
<summary>Dark theme</summary>

![Project insights, dark theme](docs/promo/screenshots/05-insights-dark.png)

</details>


**Skills** (on by default, turn it off in the welcome tour or Settings → AI features): every week a model you choose reads the project's cards (summaries, acceptance criteria, your own corrections kept by project memory), confirmed memory and the redacted shell commands agents ran, and drafts complete skills, a procedure agents did differently each time (shipping through a pull request and waiting for review) or what several cards of one kind taught (plugin performance). **Add to project** writes `.agents/skills/<name>/SKILL.md` (read by Codex) and links it from `.claude/skills/<name>` (read by Claude Code); nothing is committed for you. Later runs propose updates to the skills Flowly added, shown as a diff. The same run still suggests `paseo.json` scripts, worktree setup, repo tools and AGENTS.md rules; each becomes a card with one click. Each run replaces the drafts nobody acted on; quiet weeks are skipped without calling the model, and the first scheduled run waits one full period. Agents see the project's `paseo.json` scripts in their task context.

## Languages

The interface follows your device language, or pick one in **Flowly settings → Language**: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português (Brasil) and Русский. Agent instructions, daemon error details and the text agents and summaries write are not translated. AI-written text (summaries, the daily digest, Workflow insights, suggested next steps and ideas) has its own language, **Flowly settings → AI features → AI output language**; it follows the interface language until you pick one.

| 日本語 | Deutsch |
| --- | --- |
| ![Board in Japanese](docs/promo/screenshots/i18n/ja-JP-board.png) | ![Board in German](docs/promo/screenshots/i18n/de-DE-board.png) |

## Quick start

The first time you open Flowly, a short welcome tour explains projects, cards and sessions and sets the basics: interface and AI output language, the progress model, whether progress, next steps and ideas also apply to sessions outside Flowly (on by default; each of their turns then runs the summary model once), and whether Project memory and Insights are on. Skip keeps the defaults. Change any of it later from the gear at the top of the board.

1. **New project**: pick a directory (or several repositories) to register as a native Paseo project.
2. **New task** (or **Q**): say what you want done and press Enter. Quick task creates the card, starts its agent in a new worktree and lets the summary model name it; **More options…** opens the full form (status, priority, type, tags, workspace, inputs).
3. Watch the card move. Answer **Needs you** cards, review **In review** cards, accept or dismiss **Ideas**, and open **Insights** at the end of the day.

## How it works

- **One board project = one native Paseo project root.** To work across repositories, put them under one directory and register it, or let the plugin create a linked root with one symlink per repository (removing a link never touches the target).
- **One card = one workspace**, with any number of sessions in it. You choose which session receives an instruction; ordinary follow-ups send exactly what you type.
- **Agent tools.** Sessions created from a card get scoped MCP tools: `flowly_get_task`, `flowly_update_status`, `flowly_report_progress`, `flowly_propose_idea`, `flowly_suggest_next_moves`, `flowly_set_tags`, `flowly_set_type`, `flowly_add_artifact`, `flowly_remove_artifact`, `flowly_update_workpad`, `flowly_handover`, `flowly_integrate`, `flowly_search` and `flowly_read_external` (`flowly_read_ticket` remains as an alias for older sessions), plus the `flowly` skill that explains them. An agent can move its card between the work stages and In review; a person decides Done and Cancelled. The call that delivers or asks (`flowly_update_status`, `flowly_report_progress`) can also carry `nextMoves`, the suggested next steps shown above the message box, or `[]` when nothing needs the user. A CLI fallback is provided for sessions without MCP.
- **Card status and session status are independent.** A turn ending never completes a card.
- **Also included:** drag and drop (including within a column), card links (follow-up, blocks, related), task types and priorities, wrap-up of Done cards (archive their sessions and own workspace, after a preflight), switching a card between the main checkout and its own worktree (copy everything, trim, release from main, integrate), keyboard shortcuts (`?`), per-card token usage, a compact phone layout, and *Settings → Cards* to choose what board cards show (with a live preview).

### Models

Pick the model new sessions start with under **Settings → Models**. A project can set its own default in its settings, which wins over the global one; with neither, new sessions start from the latest session's settings.

Summary models are an ordered fallback list in Settings → Models: add models and move them up or down to set priority; the default is Haiku → Luna.

![Settings → Models: default model and summary model](docs/promo/screenshots/settings/models.png)

### Data and safety

Board data is stored on the daemon machine in `~/.paseo/plugin-data/flowly/` (`PASEO_HOME` selects the daemon home): in a local SQLite database, `flowly.sqlite`, where Paseo supports it, otherwise in `board.json`. *Settings → Storage* shows where it is, keeps a daily backup (the last 7), restores one, and exports the board to JSON. Writes are serialized and atomic, stale edits are rejected, and invalid files are preserved rather than reset. Removing or permanently deleting a project or card writes a backup to `removed/` first. Archiving plugin records never deletes Paseo resources or directories. The tool service listens on loopback with private per-session credentials.

### Telemetry

Once a day the daemon sends anonymous usage data to PostHog (US): the Flowly version, OS and Node version, the interface language, which features are switched on, rough project and card counts, and how many cards, agent turns, deliveries, next moves, ideas and memories there were since the last one, with the models used. When Flowly's daemon hits an error it also sends the error's type and code and where in Flowly's own code it happened (file and line), at most once a day per kind. It never sends error messages, titles, descriptions, chat messages, your paths (only file paths inside Flowly), repository names or IDs of your projects, cards or sessions, and no IP-based location. Turn it off in Settings → General → *Send anonymous usage data*, or set `DO_NOT_TRACK=1` (or `FLOWLY_TELEMETRY=0`) for the Paseo daemon. Exactly what is sent: [`server/telemetry.ts`](server/telemetry.ts) and [docs/TELEMETRY-SPEC.md](docs/TELEMETRY-SPEC.md).

## Development

To run from a checkout (for development):

```sh
git clone https://github.com/JasprW/flowly.git && cd flowly
npm install
paseo plugin install "$PWD" --id flowly
paseo plugin reload flowly   # after later changes
paseo plugin logs flowly
```

```sh
npm run typecheck
npm test
```

GitHub Actions checks every PR and main push (Node 22/24, types, tests and a real package install). `make release VERSION=x.y.z` checks an already merged version and pushes an annotated tag; the tag workflow publishes the tested tarball to npm using OIDC and creates a GitHub Release. `DRY_RUN=1` previews local release steps. See [CI/CD setup and recovery](docs/CI-CD.md).

To add or change text, wrap it in `t()` / `tn()` and add the translation to every file in [`shared/i18n/`](shared/i18n/); `npm test` lists what is missing. See [`docs/I18N-SPEC.md`](docs/I18N-SPEC.md).

Root code is limited to `index.client.tsx` and `index.server.ts`; everything else lives in `client/`, `server/` and runtime-neutral `shared/`. Design decisions, specs and acceptance evidence are in [`docs/`](docs/): start with [`SPEC-OUTLINE.md`](docs/SPEC-OUTLINE.md), [`SINGLE-ROOT-SPEC.md`](docs/SINGLE-ROOT-SPEC.md) and [`PROGRESS.md`](docs/PROGRESS.md). Project rules for contributors and agents are in [`AGENTS.md`](AGENTS.md). Release and promo material (copy, demo project script, screenshot script) lives in [`docs/promo/`](docs/promo/README.md).

## License

[MIT](LICENSE) © 2026 Bofan Wang

The separately installed `paseo-kanban` plugin is a different plugin and is never overwritten.
