# Quick task

A one-sentence way to create a card and start its agent: type what you want done, press Enter. The full
Create task form stays one tap away.

## 1. Quick task dialog

- One multiline box, "What do you want done?". Enter submits, Shift+Enter is a new line (same keys as the
  full form). On phones the return key is a new line and the button submits.
- Under the box, a row of small pickers that can be changed in place:
  - **Project**: the live (not archived) projects. Default per §3.
  - **Agent**: provider · model. Pressing it opens the same agent choice as New task (provider, model,
    reasoning, speed, permissions) inline. Defaults are the same as the full form's: the project's default
    model, else the global one, else the latest session's settings (MODEL-DEFAULTS-SPEC). Choosing another
    project resets the agent to that project's defaults.
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
   wait for it.

## 3. Defaults

- **Project**: the last project used for a quick task, when it is still live; else the project the board
  shows; else the first live project. Entry points tied to one project (a lane's Add task, a project tab's
  New task, the empty-board hint) open with that project instead.
- **Workspace mode**: the *Workspace mode for quick tasks* setting (worktree by default); a project with
  links always uses directory.
- **Status**: the lane of the entry point (a lane's Add task), else Todo; resolved against the project's
  lanes as the full form does.

## 4. AI title, type and tags

RPC `tasks.quick-title` `{ taskId, text, provisionalTitle }` → `{ started: boolean }`. It returns at once;
the daemon runs the rest in the background.

- Model: the summary model list (Settings → AI features, SUMMARY-MODELS-SPEC), with its fallbacks.
- It runs as a temporary session in the project's Flowly background workspace
  (BACKGROUND-WORKSPACE-SPEC) and is hard-deleted when done, like the memory review.
- Prompt: the text (at most 4000 characters), the six task types and up to 50 of the project's existing
  tags; output JSON `{ title, type, tags }`: a title of at most 80 characters, one task type or none, at
  most 3 tags, preferring existing tags. Output language follows the AI output language
  (AI-LANGUAGE-SPEC).
- Applied in one board transaction, against the card as it is then:
  - **title** only while the card's title still equals the provisional title (a user edit wins), and only
    when the suggestion is not empty and differs;
  - **type** only while the card has no type;
  - **tags** are added as agent tags (`by: "agent"`, no agent id), skipping ones the card has, invalid ones
    and any beyond the card's tag limit. A tag the user removed in the meantime is not re-added only if it
    is still on the card; the AI never removes a tag.
  - Nothing is applied to an archived, deleted or finished card.
  - The card's revision increases once; one `edited` event (actor `system`, note "AI title") and, when tags
    were added, one `tags_changed` event.
- Errors (no model, timeout, invalid output, card gone) are logged with `logFailure` and leave the card
  as it is. The user sees nothing.

## 5. Entry points

- The board's **New task** button and **N**: Quick task when *Quick task for New task* is on (default),
  else the full form.
- A lane's **Add task**, the phone lane's Add task, a project tab's **New task** and the empty-board hint:
  the same choice, with that lane's status and project.
- **Q** on the board (desktop shortcut): always Quick task.
- Command Center **Flowly: Quick task**: opens the board and Quick task with its default project.
- Edit, follow-up, from-idea, from-suggestion and Linear Start card keep the full form.

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

Flowly registers exactly three Command Center items: **Open Flowly**, **Flowly: Needs attention** and
**Flowly: Quick task**. The other board intents (new task, projects, search, filters, shortcuts, welcome)
stay valid as screen params and keyboard shortcuts, but have no Command Center item.

## 8. Acceptance

- Typing one sentence and pressing Enter creates a card with the provisional title and starts a session
  with the full text as its first message, in a worktree by default.
- A user title edit made before the AI title arrives is kept; a type set meanwhile is kept; AI tags show
  as agent tags.
- With *AI titles for quick tasks* off, no `tasks.quick-title` call is made.
- More options… opens the full form prefilled and creates nothing by itself.
- A linked project gets a directory workspace.
- Pure logic covered by tests: provisional title, default project and mode resolution, the AI-result
  merge, output parsing; the daemon apply path with a fake model.
