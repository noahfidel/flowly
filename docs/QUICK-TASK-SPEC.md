# Quick task

A one-sentence way to create a card and start its agent: type what you want done, press Enter. The full
Create task form stays one tap away.

## 1. Quick task dialog

- One multiline box, "What do you want done?". Enter submits, Shift+Enter is a new line (same keys as the
  full form). On phones the return key is a new line and the button submits.
- Under the box, a row of small pickers that can be changed in place:
  - **Group**: the board groups with at least one live project, in group position order (empty groups and groups
    whose projects are all archived are left out). Default per §3. Hidden when fewer than two groups are offered,
    and when Quick task is seeded from an idea (§10, its project is locked). Choosing another group sets the project
    to the last quick-task project when it is a live member of that group, else the group's first member (chooser
    order), and resets the agent to that project's defaults as choosing a project does; choosing the same group
    changes nothing.
  - **Project**: the selected group's live (not archived) projects only (all live projects when no group is known,
    or when the selected group has no live project left while the dialog is open).
    Default per §3.
  - **Agent**: provider · model · permission mode (its label, e.g. `claude · Opus 5.5 · Plan`; one line,
    truncated on narrow screens). Pressing it opens the same agent choice as New task (provider, model,
    reasoning, speed, permissions) inline. Defaults are the same as the full form's: the project's default
    model, else its group's, else the global one; with none, the picker starts empty (MODEL-DEFAULTS-SPEC §2). Choosing another
    project resets the agent to that project's defaults.
    **Permission mode**: `plan` whenever the chosen provider offers a `plan` mode (`quickTaskMode`,
    `shared/agent-defaults.ts`), instead of the remembered session mode; a provider without one (e.g. Codex)
    keeps the usual suggestion. Switching project or provider re-applies it; a mode picked in the agent
    picker wins for that task. Only Quick task: the full form, New session and the rest keep their defaults
    (More options… hands the quick task's mode over like the rest of the choice).
  - **Workspace**: *Worktree* (new isolated worktree) or *Directory* (new in directory). Default per §3.
    A project with links (multiple repositories) has no worktree option, as in the full form.
- Images can be pasted, dropped or added (web only), as in the full form's instruction.
- **More options…** closes Quick task and opens the full Create task form for the chosen project with
  Start an agent now on, the typed text as the Instruction, the provisional title (§2) as the Title, the
  chosen workspace mode and the attached images. Nothing is created until that form is submitted.
- **Create and start** is disabled while the text is empty, no project is chosen or the agent choice is not
  ready.

## 2. Submit

1. The card is created at once through the same `tasks.create` call as the full form: the chosen project,
   status (the requested lane when the project has it, else the first active lane), priority Normal, no
   type, no tags, the chosen workspace mode, an empty description and a **provisional title**:
   - the first non-empty line of the text, whitespace collapsed, leading Markdown markers (`#`, `-`, `*`,
     `>`, `1.`) removed;
   - at most 80 characters: longer lines are cut at the last word boundary within the limit (when that
     keeps at least half of it) and get "…"; text without spaces is cut at 80.
2. The project is remembered as the last quick-task project.
3. The first session starts through the same path as the full form (`launchKanbanSession`) with the chosen
   provider, model, mode, reasoning and speed, and the **full text** as its first message (plus images).
   If the session fails, the card stays and the same error toast as the full form shows.
4. When *AI titles for quick tasks* is on, the client asks the daemon for an AI title (§4) and does not
   wait for it. It sends at most the first 4000 characters of the text (what the run reads), so a longer paste
   cannot exceed the RPC's input limit.

## 3. Defaults

- **Project** (user ruling 2026-11-05): the board's New task button, **T**, the phone lane's Add task and the
  empty-board hint open with the project the board shows; a lane's Add task and a project tab's New task with
  their own project. Only **Q** and Command Center **Flowly: Quick task** open with the last project used for
  a quick task, when it is still live, else the board's project. Either way the first live project is the last
  fallback, and the Project picker can change it.
- **Group**: the group of the project the dialog opens with. That is the shown board's group (from the Command
  Center, the group the board opens on: the one last viewed, BOARD-GROUPS-SPEC §3), unless the entry
  point pins a project of another group (a lane's Add task, Linear's Start card) or the board's group is empty and
  the fallback picks another group's project; then it is that project's group. It applies to every entry point.
  Ruling (Noah 2026-11-13): the default group is the shown board's group, with no new setting (the last
  quick-task project stays the only stored quick-task value), and the Project picker lists only the selected group's
  projects.
- **All projects board** (ALL-PROJECTS-SPEC §5): there is no board project, so New task, **T**, a lane's Add
  task and the empty-board hint open Quick task (even with *Quick task for New task* off) with the last quick-task
  project, else the first live one.
- **Workspace mode**: the *Workspace mode for quick tasks* setting (worktree by default); a project with
  links always uses directory.
- **Status**: the lane of the entry point (a lane's Add task), else Todo; resolved against the project's
  lanes as the full form does.

## 4. AI title

RPC `tasks.quick-title` `{ taskId, text, provisionalTitle }` → `{ started: boolean }`. It returns at once;
the daemon runs the rest in the background. The AI sets the **title only** (user ruling 2026-11-05): type and
tags are left to the agent's own setup step (CARD-SETUP-SPEC).

- Model: the summary model list (Settings → AI features, SUMMARY-MODELS-SPEC), with its fallbacks.
- It runs as a temporary session in the project's Flowly background workspace
  (BACKGROUND-WORKSPACE-SPEC) and is hard-deleted when done, like the memory review.
- Prompt: the text (at most 4000 characters); output JSON `{ title }`, at most 80 characters. Output
  language follows the AI output language (AI-LANGUAGE-SPEC).
- Applied in one board transaction, against the card as it is then: the title changes only while it still
  equals the provisional title (a user edit wins), and only when the suggestion is not empty and differs.
  Nothing is applied to an archived, deleted or finished card. The card's revision increases once, with one
  `edited` event (actor `system`, rule `ai-title`, note "AI title") whose time is the card's new `updatedAt`.
- A draft opened before the AI title landed (the edit form, a drawer field) is still saved: when the card is
  exactly one revision ahead of the draft and that revision is the AI title (its event time equals the card's
  `updatedAt`), `tasks.update` applies the draft instead of reporting a revision conflict. The edit form sends
  the title only when the user changed it, so an untouched title keeps the AI title and a typed one wins. Any
  other change in between is still a conflict.
- Errors (no model, timeout, invalid output, card gone) are logged with `logFailure` and leave the card
  as it is. The user sees nothing.

## 5. Entry points

- The board's **New task** button and **T**: Quick task when *Quick task for New task* is on (default),
  else the full form.
- A lane's **Add task**, the phone lane's Add task, a project tab's **New task** and the empty-board hint:
  the same choice, with that lane's status and project.
- **Q** on the board (desktop shortcut): always Quick task.
- Command Center **Flowly: Quick task**: opens the board and Quick task with the last quick-task project (§3).
- Edit, follow-up and from-suggestion keep the full form. The Linear board's **Start card** opens Quick task (§9).
  From an idea: Quick task when *Quick task for New task* is on, else the full form (§10).

## 6. Settings

Settings → Workflow → **Quick task** (host-scoped board view settings):

| Setting | Field | Default |
| --- | --- | --- |
| Quick task for New task | `quickTaskDefault` | on |
| AI titles for quick tasks | `quickTaskAiTitle` | on |
| Workspace mode for quick tasks | `quickTaskMode` (`worktree` / `directory`) | worktree |
| (no UI) last quick-task project | `lastQuickProjectId` | "" |

The AI titles row shows the run's estimated cost (shared/ai-cost.ts).

## 7. Command Center

Flowly registers exactly two Command Center items, in this order: **Flowly: View board** (id `open-board`,
opens the board) and **Flowly: Quick task**. The host ranks a plugin's items in the order they are registered
(`client/command-items.ts`). The other board intents (attention, new task, projects, search, filters,
shortcuts, welcome) stay valid as screen params and keyboard shortcuts, but have no Command Center item.

## 8. Acceptance

- Typing one sentence and pressing Enter creates a card with the provisional title and starts a session
  with the full text as its first message, in a worktree by default.
- A user title edit made before the AI title arrives is kept; the AI changes no type or tags; an edit
  form opened before the AI title arrives still saves.
- With *AI titles for quick tasks* off, no `tasks.quick-title` call is made.
- More options… opens the full form prefilled and creates nothing by itself.
- A linked project gets a directory workspace.
- The Group picker opens on the shown board's group (or the pinned or fallback project's group), offers only groups
  with a live project, hides with fewer than two or from an idea, and the Project picker lists only the selected
  group's live projects; switching group picks the last quick-task project when a member, else the first member.
- Pure logic covered by tests: provisional title, default project and mode resolution, the default group, the
  offered groups, the project after a group switch and the narrowed project list (`client/board-groups.test.ts`),
  the AI-result merge, output parsing; the daemon apply path with a fake model.

## 9. Seeded from an external item (Linear Start card)

Quick task can open with an external item attached (LINEAR-BOARD-SPEC §5). Only the Linear board's Start card does so today; it opens Quick task whatever *Quick task for New task* says.

- The item shows under the box as a removable chip (the full form's chip). The card is created with it through `tasks.create` `externals`, so it becomes an input artifact, as in the full form.
- **Title**: the seed's title, `<KEY>: <issue title>`, replaces the provisional title, and **no `tasks.quick-title` call is made** (§4), since the issue already names the card. Removing the chip turns it back into an ordinary quick task: provisional title from the text, AI title per the setting.
- **Text** is optional while an item is attached: empty sends the same default first message as the full form (`firstMessage`, UI-REFRESH-SPEC §7s, which names the attached item); typed text is sent as typed. Enter submits either way. Without an attached item the text is required (§1).
- Agent, workspace, project and **More options…** work as in §1; More options… hands the item, the title and the typed text to the full form.
- Tests: `client/quick-task.test.ts` (`quickCard`, `quickPrompt`), `client/linear-start.test.ts` (`linearQuickSeed`).

## 10. Seeded from an idea (Good idea)

With *Quick task for New task* on, every way of making a new card from an idea opens Quick task instead of the full
form. With it off, each of them opens the full form prefilled as before (IDEAS-SPEC §6.1). The entry points:

- **Good idea** on a project idea (no card to continue in, PROJECT-IDEAS-SPEC §5): Quick task directly.
- **Good idea** on an idea whose card is Done, Cancelled, archived or gone (IDEAS-INBOX-SPEC §2.3): Quick task
  directly, since a new card is its only action; the line saying why it cannot continue in its card moves into
  **Other options…** (below).
- **Good idea** on an idea whose card can still continue:
  - `scope=new` (or no scope), with *Quick task for New task* on: Quick task directly, no menu. The card's own actions
    stay reachable through **Other options…** (below): Continue in <session>, Send to another session… (only with more
    than one live session), Do it in a new session, and the full form.
  - `scope=new` (or no scope) with it off: the menu, Start a new task (Suggested) first, since there is no Other
    options… to reach the card's actions.
  - `scope=here`: the menu (IDEAS-SPEC §6), Continue in <session> (Suggested), Send to another session…, Do it in a
    new session, then Start a new task; Start a new task opens Quick task (or the full form when it is off).
- An idea link (`ideaInput`, the deep link to one idea).

The dialog then opens with:

- **Project**: the idea's project, locked (the Project picker lists only that project). If it is not live the dialog
  has no project and Create and start stays disabled.
- **Text**: the idea's title, a blank line and its detail (`ideaQuickText`; only the title when the detail is
  blank). It is editable and is the first message as in §2.
- **Card** (`tasks.create`, as in §2 otherwise): title = the idea's title, and **no `tasks.quick-title` call**, since
  the idea already names the card (as §9); description = `ideaDescription()` (IDEAS-SPEC §6.1: detail, why,
  context, the source card and its progress); type, priority and tags = the idea's when it has them, else the §2
  defaults; and `ideaId`, so the daemon accepts the idea in the same write (IDEAS-SPEC §6.1 step 2) and refuses a
  closed one before anything is created.
- **More options…** hands all of that to the full form (the form reads "Create task from idea"), with the typed
  text as the Instruction as in §1.
- **Other options…** (only when seeded from an idea), next to More options…, expands a list in the dialog (as the
  Project picker does). Each choice closes Quick task and does the following instead:
  - **Open the full form**: the full form prefilled exactly as IDEAS-SPEC §6.1 (no instruction).
  - For an idea whose card can still continue (from the drawer, the Ideas page or an idea link): the Good idea menu's own
    card actions, with the same Suggested marks: Continue in <session>, Send to another session… (expands the
    live sessions in the list) and Do it in a new session (IDEAS-SPEC §6.2, §6.3).
  - For a finished, archived or gone card: the line saying why it cannot continue in it (no action).
  - An idea link whose source card is not in the board's overview yet lists only Open the full form (the card is not
    called gone, `ideaLinkOptions`).
- Pure logic and tests: `client/idea-choice.ts` (`goodIdeaPlan`, `ideaOtherOptions`, `ideaLinkOptions`, `newTaskFromIdea`) and
  `client/quick-task.ts` (`ideaQuickSeed`, `ideaQuickText`, `quickProjects`, `quickCard`, `quickCreateInput`,
  `quickMoreSeed`), tested in `client/idea-choice.test.ts` and `client/quick-task.test.ts`.
