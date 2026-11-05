# All projects board

Status: requested by Noah on 2026-11-05. Extends PROJECT-TABS-SPEC (tabs, which project opens) and
QUICK-TASK-SPEC §3 (which project a new task starts in).

One board that shows the cards of every live project. It is a view only: it adds no storage for cards,
order or projects, and every write still goes through the card's own project.

## 1. Entry and availability

- **Available** when the setting *Show All projects tab* is on (Settings → Workflow → Board, on by default;
  `board-view.allProjectsTab`) and there are **two or more live (not archived) projects**. Otherwise the
  entries are hidden, and a board that was showing All falls back as in §8.
- **Desktop tabs:** a first tab **All** before the project tabs. It is not part of the drag order, has no
  context menu, and is never archived-styled. The chooser button after the tabs (opens the chooser) is now
  labelled *Manage projects* so it is not confused with the All tab.
- **Compact/phone and the no-tab layouts:** the project switcher shows *All projects* as its title while All
  is shown, and the chooser lists an **All projects** row at the top (above the projects).
- **Onboarding:** the one-time tip `all-projects` (ONBOARDING-SPEC tip table) announces it on a project board
  while it is available and no card is open, after `project-menu`.

## 2. Columns

- The built-in statuses in their built-in order, each with its **default name** (no project's custom lane
  name). A status is a column when it is enabled in at least one included project.
- Collapsed columns, the phone's status picker and the "Show older" fold of Done/Cancelled work as on a
  project board (FINISHED-CARDS-SPEC), over all included cards.

## 3. Cards

- **Included projects:** the live projects. Archived projects are never included, even with *Show archived*
  on; that switch still shows archived cards of the included projects.
- Each card shows a small muted project label (the project name, one line, truncated) first in its meta row,
  only in All. It is part of the card's accessibility label.
- Everything a card does uses **the card's own project**, never a board-wide one: the drawer and its sessions,
  links, the session defaults (MODEL-DEFAULTS-SPEC), legacy scope, workpad, Switch local/worktree, the card
  menu's and action sheet's *Move to* list (that project's enabled lanes and lane names), the "Moved to …"
  toast, Edit, follow-up and idea forms, Link to a card.
- Opening a card (click, keyboard, Attention, a Search result, a related card) keeps the board on All when the
  card's project is included; a card of an excluded project switches the board to that project first.
- The drawer's *Memory* button and a card's *All ideas* first switch the board to the card's project, then
  open that page.

## 4. Order and drag

- **Order within a column:** with the *Manual* sort, cards are grouped by project in chooser order
  (`projectOrder`) and keep each project's own manual order inside its group. With any other sort
  (Recent activity, Priority, Newest, Title) the sort applies across all included cards as it does on a
  project board; ties fall back to the manual order, then the project order.
- **Dragging to another column** changes the card's status as today (`tasks.place`, appended to the end of
  that project's lane). A column whose status is disabled in the card's own project refuses the drop with
  the toast "{lane} is not a lane in {project}." and nothing is sent.
- **Reordering within a column is disabled:** a drop in the card's own column does nothing and shows
  "Each project keeps its own order. Open the project to reorder its cards."; the card menu and action sheet
  have no *Move up* / *Move down*. No cross-project order is stored.

## 5. New task

- The New task button, **N**, a lane's *Add task* (desktop and phone) and the empty-board hint open **Quick
  task** (even when *Quick task for New task* is off; More options… still reaches the full form) with the
  **last quick-task project** when it is live, else the first live project in chooser order
  (`quickProject` with no pinned or current project). The Project picker can change it. A lane's Add task
  passes that lane's status (resolved against the chosen project's lanes by `startStatus`).
- **Q**, the Command Center and Linear's *Start card* behave the same in All (they never need a board
  project). More options… opens the full form for the picked project and keeps the board on All; an open
  drawer for a card of another project closes first.
- The empty-board hint shows in All when no included project has a card.

## 6. Filters, tags and search

- The filter search, Type, Priority and Tags filters apply to all included cards. Tag suggestions are the
  union of the included projects' tags. "{n} shown" counts the filtered cards.
- The Search page (button, **S**, *Search everywhere*) searches all projects in All; its This project / All
  projects choice is hidden there and each result shows its project.

## 7. Hidden in All

- The Project settings button, the overview bar (its counts, Insights, Ideas and Memory entries are per
  project), one-time tips, and the chooser's Edit / Restore / Remove rows for "the current project".
- Shortcuts **I** (Insights), **B** (Ideas) and **M** (Memory) do nothing in All. **P** opens the chooser as
  before.

## 8. Which view opens

- The PROJECT-TABS-SPEC rule with All as one more choice: an explicit choice in this board instance → the
  choice last viewed during this app run (a project or All) → the first project. All only counts while it is
  available (§1); otherwise the next rule applies. When the board falls back from an explicit All choice
  because All is no longer available, that choice is replaced by the project shown, so the board does not
  jump back to All when it becomes available again (decided once the full board and settings have loaded).
- Opening the board from a linked workspace or session, a session chip, Linear's *Open card*, an idea link or
  a memory search hit still selects that card's project.

## 9. Acceptance

Unit (`client/all-projects.test.ts`, `client/project-memory.test.ts`):

- Availability: setting off or fewer than two live projects → not available.
- Columns: the union of enabled statuses over the included projects, in built-in order; archived projects
  do not add columns.
- Card list: cards of archived projects excluded (also with Show archived on); archived cards only with
  Show archived on; filters (search, priority, type, tags) applied.
- Order: Manual groups by project order then position; another sort applies across projects.
- Reorder: disabled in All for every sort; on a project board only with Manual.
- Drop guard: a status disabled in the card's project is refused.
- Last viewed: All restored when available; falls back to the first project when it is not; an explicit
  project choice wins; an All choice the board fell back from is dropped (`client/project-memory.test.ts`).
- New task in All: Quick task with the last quick-task project, else the first live one; lane status kept.
- Tip `all-projects` follows `project-menu` and needs All to be available (`client/onboarding-logic.test.ts`).
- Setting `allProjectsTab` defaults to on and a bad stored value falls back to on (`shared/settings.test.ts`).

Manual (Noah's click-through): desktop All tab, drag between columns, refused drop, no within-column
reorder, card label, drawer on a card of another project, New task in All, filters/tags, setting off; phone
switcher entry and lane list.
