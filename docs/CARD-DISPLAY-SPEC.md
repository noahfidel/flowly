# Card display: calmer layout and user-chosen fields

Status: implemented 2026-10-19. Card: 任务卡片布局调整.

## 1. Problem

A board card grew one row or pill per feature: ticket key line, title, progress line, latest-output line, and a wrapping row of priority pill, type pill, tag chips, Needs you, waiting, workpad checks, workspace state, approvals, errors, running, unread, ideas, archived and legacy. In a 260 px column a busy card ran to 7–8 lines, and the things that need the user were mixed in with descriptive metadata.

## 2. Layout

Four tiers, top to bottom. Every tier is omitted when empty.

| Tier | Content | Style |
| --- | --- | --- |
| Meta | workspace (Worktree/Local, §8), priority (Urgent/High/Low only), type, ticket key, tags (first two, then `+n`) | one wrapping row of small muted text with icons, no pills or chips; Urgent/High keep their colour |
| Title | task title, up to 3 lines | unchanged |
| Activity | one line of what the agent did, with its relative time | AI mark when it is the progress summary |
| Status | what needs the user and what is happening | signals as before |

- Urgent/High keep the left stripe; it follows the Priority field.
- Status order: Needs you, waiting on cards, approvals, errors, workspace problems, running, unread, workpad checks, ideas, Archived, Legacy.
- The accessibility label of the card is unchanged and always lists every fact, whatever is hidden.

## 3. Options (Settings → Cards)

Host-scoped (`board-view` settings), so every board on this device uses them.

| Option | Values | Default |
| --- | --- | --- |
| Activity line (`cardActivity`) | `auto`: progress summary, else latest output · `progress` · `output` · `both` · `none` | `auto` |
| Workspace, Priority, Type, Ticket, Tags, Session activity, Workpad checks, Ideas | shown / hidden (`cardHidden`: list of hidden field ids) | all shown |

- Session activity covers running, starting, unread, session count, Loading… and Last known. Approvals and errors are always shown.
- Always shown, not configurable: Needs you, waiting on cards, approvals, errors, Workspace unavailable, Wrapped up, Archived, Legacy. They tell the user to act or explain why the card behaves differently.
- `both` restores the earlier two-line behaviour (progress line, then output line).
- The page shows a live preview card built from sample data with the current options, and a *Reset to defaults* row.
- The board's Sort menu ends with *Card display…*, which opens Settings on the Cards page.
- The same page has a **Card sidebar** group for the open card's section order and which sections start open (DRAWER-SPEC, Section order).

## 4. Data contract

- `cardActivity: "auto" | "progress" | "output" | "both" | "none"`, default `auto`.
- `cardHidden: string[]` (≤ 20, each ≤ 40 chars), default `[]`. Unknown ids are kept and ignored, so a newer client's value never invalidates the whole board-view document on an older one.
- Pure helpers in `shared/card-display.ts`: `cardDisplay(view)` → per-field visibility; `activityLines(mode, hasProgress, hasOutput)` → which lines show.

## 5. Onboarding

New one-time tip `card-display`, shown when the current project has 6 or more active cards: “Cards too busy? Choose what they show in Settings → Cards, or from the Sort menu → Card display.” Welcome tour copy is unchanged: this is a view preference, not a new concept.

## 6. Acceptance

1. Default card: meta row, title, at most one activity line, status row; no priority/type pills or tag chips.
2. Each switch hides its field on the board and in the preview immediately; settings persist across reload.
3. Activity modes behave as in §3; `auto` shows output only when there is no progress summary.
4. Always-shown signals stay when every switch is off.
5. Invalid stored values fall back to defaults; older stored documents get the defaults.
6. All new strings in every catalog; `npm test` passes.

## 7. Open workspace button

Status: implemented 2026-10-29. Card: button to open associated workspace.

Each board card can take the user straight to its workspace in Paseo (the native workspace view with its tabs, terminals and sessions).

- **Where**: an `ArrowUpRight` icon button (the plugin's "Open in Paseo" icon) in the card's top-right action column, directly under the `…` actions button. Same size as `…` (26 pt desktop, 40 pt touch) and the same visibility: always on touch and on non-draggable cards, on hover or while the card is selected on the draggable desktop board.
- **Layout**: the column sits in the right padding the card already reserves for `…`, so titles keep their width. A card that shows the button is at least `2 × button + 8` tall (60 pt desktop, 88 pt touch), so the column never hangs below a short card.
- **Action**: `navigation.openWorkspace({ workspaceId: task.workspaceId, serverId: host.id })` (`openNativeWorkspace` in `client/session-state.ts`). Pressing it does not open the card sidebar and does not start a drag.
- **When it shows**: only when the host offers `navigation.openWorkspace` (older hosts and surfaces without navigation get nothing) and the card's workspace is in Paseo's live workspace list, the same test as the *Workspace unavailable* signal. Missing, archived and wrapped-up workspaces get no button.
- **Menus**: the card's context menu (right-click / long-press) and the `…` action sheet list **Open workspace** right after *Open details*, under the same conditions.
- Not on the Settings → Cards preview or the tour's demo cards (they pass no handler). Not configurable: it is an action, not a field. The card sidebar has its own button in its header, left of Edit ([DRAWER-SPEC](DRAWER-SPEC.md#open-workspace)).
- No onboarding tip or tour copy: the button is on the card itself. No telemetry field.

Acceptance:

1. A card with an available workspace shows the button under `…`; pressing it opens that workspace on the card's host.
2. No button (and no menu entry) without `navigation.openWorkspace` or when the workspace is unavailable.
3. Short cards grow to fit the column; titles do not get narrower.
4. Both strings (`Open workspace`, `Open workspace for {title}`) are in every catalog; `npm test` passes.

## 8. Workspace kind

Status: implemented 2026-10-29. Card: badge for worktree vs local.

A card's meta row says where it works, so worktree cards and cards that share the project folder can be told apart on the board.

- **What**: `GitBranch` + *Worktree* when Paseo's `workspaceKind` is `worktree`; `Folder` + *Local* for every other kind (`local_checkout`, `checkout`, `directory`). Same quiet muted text with icon as the other meta items (§2), no pill. First in the row, before priority, type, ticket and tags, so it sits at the same place on every card (user request 2026-10-29).
- **Background workspaces** (hidden ones, such as PR-review workspaces) are in that list too, flagged `background`: a card bound to one is available and can be opened. The existing-workspace picker in New session leaves them out.
- **Source**: Paseo's live workspace list. `resources.list` (and `resources.read-changed`) carries each workspace's `kind` (optional, Paseo's raw value); the board maps it per card with `cardWorkspace(kind)` in `shared/card-display.ts`. No new request or poll; a card linked to an existing workspace shows that workspace's real kind. Nothing is stored on the task.
- **No kind, no badge**: a workspace that is not in the live list (missing, archived, wrapped up) shows nothing here; *Workspace unavailable* / *Wrapped up* still explain it.
- **Option**: field id `workspace` (*Workspace*, first in Settings → Cards → Details), shown by default. The preview card shows *Worktree*.
- **Accessibility**: the card's label always includes `Workspace: Worktree` / `Workspace: Local` when the kind is known, whatever is hidden.
- **Card sidebar**: the same badge, first in the header row with status, priority and type ([DRAWER-SPEC, Workspace kind](DRAWER-SPEC.md#workspace-kind); user request 2026-10-29). The *Workspace* switch here does not hide it there.
- Not shown on the tour's demo cards or in the Attention list. No onboarding tip or tour copy: the badge explains itself. No telemetry field.

Acceptance:

1. A worktree card shows *Worktree* with a branch icon; a card in the project folder or another local checkout shows *Local* with a folder icon. It is the first item of the meta row.
2. A card whose workspace is not in Paseo's live list shows neither.
3. Hiding *Workspace* in Settings → Cards removes it from the board and the preview; the accessibility label keeps it.
4. `cardWorkspace` maps only `worktree` to Worktree, every other kind to Local and a missing kind to nothing (`shared/card-display.test.ts`).
5. New strings in every catalog; `npm run typecheck` and `npm test` pass.
