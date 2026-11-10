# Board groups

Status: approved by Noah on 2026-11-10. Extends ALL-PROJECTS-SPEC (a group's board is the All projects board
scoped to the group's projects) and PROJECT-TABS-SPEC (which view opens).

A board group is a named set of projects (for example "Loadout" or "Zenlytic"). Each group opens as its own
board that behaves exactly like All projects, over the group's projects only. Groups are a view preference:
they add no board data, change no card or project, and every write still goes through the card's own project.

- Ruling (Noah, 2026-11-10): a group's board is the All projects board with a narrower scope, not a parallel
  view. Everything ALL-PROJECTS-SPEC §2–§7 says about All applies to a group's board, reading "included
  projects" as the group's live members.
- Ruling (Noah, 2026-11-10): All projects always shows every live project; there is no setting to hide projects
  that are in no group. All projects is the catch-all for ungrouped projects and its counts match the sidebar
  badge and the phone's bell totals.
- Ruling (Noah, 2026-11-10): with no live project at all, the first-run "No projects yet / Create project"
  screen wins over a remembered or chosen group (§6).
- Ruling (Noah, 2026-11-10): in the project switcher (**P**), groups come first, then the individual projects,
  then All projects last.

## 1. Entry

- **Project switcher (P, the chooser):** one row per group (icon *Layers*, the group's name), above the projects,
  in the order the groups were made; then the projects; then *All projects* (while All is available,
  ALL-PROJECTS-SPEC §1). The open group's row is selected. Picking a group opens its board and closes the
  switcher.
- **Desktop tabs:** after the **All** tab (unchanged) and before the project tabs, one tab per group with the
  group's name (accessibility label "Group {name}"). Group tabs are not draggable and have no context menu.
- **Compact/phone and the no-tab layouts:** the switcher's title is the group's name while a group is shown.
- A group is always available while it exists: it does not depend on *Show All projects tab* or on how many
  projects are live. A group with no name shows as *Untitled group*.

## 2. Settings

- Settings → Workflow → **Board groups** (the Flowly settings gear, not the switcher): one block per group with
  its name (a text field, saved after a short pause; an empty name is not saved) and a delete button, then one
  chip per live project, ticked when the project is a member; pressing a chip adds or removes it. **Add group**
  adds a group named "New group" with no projects. Deleting a group needs no confirmation (nothing but the
  group is lost).
- A project can be in several groups. Archived projects are not offered.
- **Storage:** `boardGroups` in the host-scoped `board-view` settings, like the other board view preferences:
  an array of `{ id, name, projectIds }`. `id` is a non-empty string made by the client; a non-string `name`
  falls back to "" and invalid `projectIds` to `[]`; a value that is not an array falls back to no groups without
  resetting the other settings. Edits are saved one at a time, each with the editor's latest list, so quick edits
  in a row are all kept.
- At most 50 groups (**Add group** is disabled at 50) and 80 characters per name: a longer name is cut on save
  and on read (the field also stops at 80). Reading drops only the invalid groups and keeps the first 50 of the
  rest; it never discards every group for one bad entry.
- Members are stored as project ids. A member whose project was deleted or archived is skipped silently on the
  board and in the editor; the stored id is kept (no cleanup write).

## 3. The group's board

- **Included projects:** the group's members that are live, in chooser order. They give the columns
  (ALL-PROJECTS-SPEC §2), the cards (§3), the Manual order's project grouping (§4), tag suggestions and "{n}
  shown" (§6).
- **An empty group** (no live members) still opens: a board with no columns and the hint "This group has no
  projects yet." with **Edit groups**, which opens Settings → Workflow. On phones there is no lane chooser or
  lane pager then; the lane last shown is kept for when the group gets lanes again.
- Opening a card of a project outside the group (Search result, related card, linked session) switches the
  board to that card's project, as All does for an excluded project (ALL-PROJECTS-SPEC §3).
- Hidden as in All (ALL-PROJECTS-SPEC §7): Project settings, the per-project overview entries, one-time tips,
  the switcher's Edit / Restore / Remove rows; **I**, **B**, **M** do nothing.

## 4. Step-throughs, counts and the dispatcher

- The **"N need you"** and **"N updated"** buttons, **N** and **U** (DISPATCHER-SPEC §9.4, SHORTCUTS-SPEC) count
  and walk only the cards of the group's live members. All of them use one scope predicate (`boardScope`): every
  project on All, the members on a group's board, the one project on a project board.
- The Dispatcher button, **D** and the left dock work as on All. The sidebar badge and the phone's bell keep
  their own all-project totals.
- Search (button, **S**) works as on All: it searches every project and each result shows its project.

## 5. New task

- New task, **T**, **Q**, a lane's Add task and the empty-board hint open Quick task as on All
  (ALL-PROJECTS-SPEC §5), with the **last quick-task project when it is a live member** of the group, else the
  group's first member. An empty group uses All's rule.
- The Project picker lists the group's projects first (chooser order), then the other projects.

## 6. Which view opens

- A group is one more choice in the ALL-PROJECTS-SPEC §8 rule: an explicit choice in this board instance → the
  view last viewed during this app run (a project, All or a group) → the first project.
- A chosen group that no longer exists (deleted) is replaced by the project shown, once the board and settings
  have loaded, exactly like an All choice that became unavailable.
- The view is remembered only once the board-view settings have loaded, so the fallback shown while they load
  never replaces a remembered group.
- With no live project, the first-run screen shows instead of a group's board (and no empty-group hint).

## 7. Acceptance

Unit (`client/board-groups.test.ts`):

- View ids: a group's view id is neither All's nor a project id and maps back to its group.
- Members: live members in chooser order; deleted and archived members dropped; an empty group has no columns.
- Scope predicate: All covers every project, a group its members, a project itself.
- Counts and queues: need-you and updated queues and counts per group cover only its members; an empty group
  counts 0.
- Which view opens: a remembered or chosen group is restored, also when All is unavailable; a deleted group
  falls back and its choice is stale only once loaded.
- New task: last quick-task project when a member, else the first member; empty group → All's rule; picker
  lists members first.
- Editing: add trims and refuses empty names; rename keeps members and refuses empty; delete removes one group;
  a project can be ticked in several groups and unticked again.
- Phone lane: kept when the board has no lanes; otherwise Todo, else the first lane.
- Caps: 51 stored groups keep the first 50; one invalid group is dropped and the others kept; long names are cut
  to 80 on add, rename and read; Add refuses past 50.
- Settings: `boardGroups` defaults to `[]`; valid groups round-trip; a non-array falls back to `[]` without
  resetting other settings; bad fields inside a group fall back per field (`shared/settings.test.ts` covers the
  full default document).

Manual (Noah's click-through): switcher order (groups, projects, All projects), desktop group tabs, a group's
board with its counts, N/U, filters, New task picker order, an empty group's hint and Edit groups, the Settings
editor (add, rename, tick, delete), the board falling back after deleting the open group, phone switcher.
