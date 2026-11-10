# Board groups

Status: **approved by Noah on 2026-11-10** (v2; rulings recorded below). Supersedes the v1 spec
(groups as a per-host view preference), PROJECT-TABS-SPEC (project tabs) and ALL-PROJECTS-SPEC (the All projects
board); those two stay as history and each carries a "superseded" note. Amends DISPATCHER-SPEC (one dispatcher per
group, §6 of this document) and AGENTS.md. Implementation is planned in
`~/.claude/plans/2026-11-10-board-groups-main-unit/plan.md` and runs as follow-up cards; no code ships with this
spec.

A **board group** is a named set of projects (for example "Loadout" or "Zenlytic") and the main unit of the board:
it has its own tab, its own board, its own dispatcher and its own preference defaults. Every project belongs to
exactly one group. Individual projects are no longer top-level navigation.

## 0. Rulings

- Ruling (Noah, 2026-11-10): one dispatcher per board group. Its tools and its starting board summary cover only
  that group's projects. Board updates go to the dispatcher of the card's project's group. Each group's dispatcher
  has its own start/stop, `DISPATCHER_RUNNING` check and hourly limits. The dock's dispatcher chat follows the
  selected group.
- Ruling (Noah, 2026-11-10): each project belongs to exactly one group. A new project is placed in a group when it
  is created, or in the default group when none is chosen.
- Ruling (Noah, 2026-11-10): group tabs replace project tabs, in the tab bar and in the project switcher (**P**).
  Individual projects are no longer listed as top-level navigation.
- Ruling (Noah, 2026-11-10): the group board has a project filter that narrows it to one project's cards and ideas.
- Ruling (Noah, 2026-11-10): repo-bound settings stay per project (check commands, auto review and its rework
  limit, base branch and worktree setup, project memory). Preferences become group defaults that projects inherit
  and can override (new-card model, mode and thinking level, delivery mode, the group's dispatcher model). A group
  settings page shows the group defaults plus a section per project. Lanes are not per project: see the lanes
  ruling below.
- Ruling (Noah, 2026-11-10): the bell and the Paseo sidebar badge keep counting across all groups.
- Ruling (Noah, 2026-11-10): board groups move out of the per-host `board-view` settings into the board's own data,
  so the server can write them. A dispatcher tool for board groups (create, rename, set member projects, delete) is
  confirmed by the user on every call, like `flowly_create_project` (DISPATCHER-SPEC §5.2: allowed modes only, not
  preapproved). This avoids a local-daemon exception for writing settings.
- Ruling (Noah, 2026-11-10): the migration covers projects in no group or in several groups, the current global
  dispatcher session and its chat history, and stored view preferences that point at All or at project tabs (§7).
- Ruling (Noah, 2026-11-10): the All projects board is retired completely: no tab, no switcher row, no hidden
  entry. Search keeps its "all projects" scope.
- Ruling (Noah, 2026-11-10): a project that is in several groups today goes to the first of them in stored order; a
  project in none goes to the default group **Projects**, created only when needed. When every project is already
  grouped, the first group becomes the default.
- Ruling (Noah, 2026-11-10): exactly one group is the default (`isDefault`). It can be renamed and the flag can be
  moved to another group, but the default group cannot be deleted. Deleting any other group (after a confirm) moves
  its projects to the default group.
- Ruling (Noah, 2026-11-10): a dispatcher's tool may delete another group only when that group has no live
  dispatcher session (`GROUP_BUSY` otherwise); such a group is deleted in the UI, where the confirm says its
  dispatcher is archived. Every Flowly archive of a dispatcher is thus an explicit user click.
- Ruling (Noah, 2026-11-10): a dispatcher may create, rename, set the members of, set the default of and delete
  **any** group, each call confirmed by the user. Its card, idea and project tools stay limited to its own group,
  and it cannot delete its own group.
- Ruling (Noah, 2026-11-10): the current dispatcher session becomes the dispatcher of the group with the most open
  cards (ties: the first group in order). It keeps its session, transcript and seen mark. Other groups start
  without one.
- Ruling (Noah, 2026-11-10): all group dispatchers are sessions in the one existing `Flowly dispatcher` workspace
  and folder (DISPATCHER-SPEC §2, unchanged path), titled `Flowly dispatcher · <group name>`. The sealed credential
  carries the group id.
- Ruling (Noah, 2026-11-10): preference defaults resolve host → group → project (→ card for delivery mode); the
  dispatcher model resolves host → group. Today's host settings stay as the base, so migration changes nothing a
  user sees.
- Ruling (Noah, 2026-11-10): on a group board, with the project filter on one project (or a group of one project),
  the overview bar, Insights, Ideas, Memory and **I**, **B**, **M** act on that project. Unfiltered they stay
  hidden. Project settings live in the group settings page's per-project sections. (The overview bar's counts are
  amended by the next ruling.)
- Ruling (Noah, 2026-11-10): every aggregate count of a group board shows unfiltered too, summed over the group's
  live member projects (filtered: that project): the overview bar's task and Done counts, running, "N need you" and
  "N updated" (with the **N** / **U** step-throughs), and the column counts. Only the genuinely per-project parts
  (Insights, Ideas, Memory, Guardrails, **I**, **B**, **M**) stay hidden unfiltered.
- Ruling (Noah, 2026-11-10): deleting a group archives its dispatcher session. The delete confirm says so. This is a
  new user-confirmed archive exception (AGENTS.md), like Replace dispatcher. A dispatcher cannot delete its own
  group.
- Ruling (Noah, 2026-11-10): group tabs carry over the project tab features: drag to reorder (the order is stored in
  board data and shared with the switcher), a context menu (Group settings, New task, Move left, Move right, Delete
  group…), and a **+** that opens New project preset to the current group.
- Ruling (Noah, 2026-11-10): a group's dispatcher starts only from **Start dispatcher**. Creating a group and the
  migration start none.
- Ruling (Noah, 2026-11-10): when projects need a default home in the migration and a stored group is already named
  "Projects" (ignoring case), that group is reused: it becomes the default and takes the ungrouped projects and those
  of dropped groups. No second "Projects" group is made.
- Ruling (Noah, 2026-11-10): a newly made default **Projects** counts toward the cap of 50: with exactly 50 stored
  groups kept, the 50th gives way and its projects join **Projects**. This applies only when no stored "Projects" is
  reused.
- Ruling (Noah, 2026-11-10): a stored group with a blank name is dropped by the migration, and its projects are
  treated as in no group.
- Ruling (Noah, 2026-11-10): `isDefault: false` in `groups.update` is a no-op on a group that is not the default; it
  is refused with `DEFAULT_REQUIRED` only on the default group.
- Ruling (Noah, 2026-11-10): lanes are group-level. A group owns its lanes (which built-in statuses are on, their
  order, custom names) and every project in the group uses them; projects have no lane settings of their own and
  lanes are edited once, on the group settings page. The group board, filtered or not, shows the group's lanes with
  the group's names, and a drop onto any column is valid for every card of the group. A lane that holds a live card
  of any live member can't be turned off. A project that moves to another group adopts that group's lanes, the group
  first turning on every status the project's live cards sit in. The migration is §7 step 7.

## 1. Model

`board.groups: Group[]`, a new top-level array with `.default([])` (the pattern of `attentionDismissals`, no board
version bump; stored as a `groups` collection of the SQLite store), and `project.groupId`.

```
Group { id, name, position, isDefault?: true, defaults?: GroupDefaults, lanes?: Lane[], revision, createdAt, updatedAt }
GroupDefaults { agentModel?: AgentModel, deliveryMode?: DeliveryMode, dispatcherModel?: DispatcherModel }
Lane { status, enabled, name? }   (the existing lane shape: every built-in status once, at least one enabled)
```

- `lanes` is the group's workflow and the **only source of truth** for lanes: the built-in statuses in display
  order, each on or off, optionally renamed (1–40 characters, trimmed; empty means the built-in name). It is
  validated like a project's lanes were (`lanesSchema`: every status once, statuses a stored list predates filled in
  by `completeLanes`, at least one on). It is absent only in data stored before group lanes; the read-time repair
  and the next write fill it in (§7 step 7). A new group gets every lane, on, in the default order and names.
- `project.lanes` is a **mirror** the server keeps equal to its group's `lanes` (a copy, same order and names) on
  every write, so every reader of a project's lanes (Move to lists, start status, auto status, agent tools,
  workpad, auto review, insights, summaries, PR review cards, quick task) resolves through the group without
  knowing about it. Nothing else writes it; a stored value that differs is overwritten by the next write.
- Lane invariants kept by the server at the end of every write, in the same serialized operation as the group
  invariants: (1) each group has `lanes`; (2) every status a live (not archived) card of a live member project sits in
  is on in that group's lanes, turning it on when needed and bumping that group's revision; (3) every member project,
  archived ones too, has `lanes` equal to its group's. (2) is what makes a project move, a project restore and a
  card restore safe; lane edits and card moves are refused before they could break it.

- `name`: 1–80 characters after trimming, unique ignoring case (a duplicate is refused). `position` orders tabs and
  the switcher. At most 50 groups.
- Invariants kept by the server on every write, in one serialized operation: every live project has a `groupId` that
  names an existing group; exactly one group has `isDefault`; a missing or dangling `groupId` found on read is
  repaired to the default group (logged with `logFailure`). Archived projects keep their `groupId`. A broken stored
  list is repaired the same way: a repeated group id keeps its first group, a repeated name (ignoring case) is
  renamed with " 2", " 3", …. A storage restore moves group revisions past the live ones, as it does for projects.
- `GroupDefaults` fields are all optional: absent means "inherit" (§5).

## 2. RPCs

All writes are serialized with the board, check `revision` and refuse stale edits like `projects.update`.
Refusals carry a code as a `CODE: message` prefix: `REVISION_CONFLICT`, `NAME_TAKEN`, `GROUPS_FULL`,
`DEFAULT_REQUIRED`, `GROUP_NOT_FOUND`, `GROUP_BUSY`, and `GROUPS_UNAVAILABLE` until the migration (§7) has run in
this daemon (a failed migration keeps group writes refused, and other writes add no groups, until it succeeds: a
storage-busy failure is retried with backoff during the run, any other failure at the next start). A group delete
whose dispatcher record cannot be read is refused with `DISPATCHER_UNAVAILABLE`.

- `groups.create { name, defaults? }` → group (appended; no members). The first group of an empty board is its
  default.
- `groups.update { id, revision, name?, defaults?, isDefault?, lanes? }`: setting `isDefault: true` moves the flag;
  clearing it on the default group is refused (`DEFAULT_REQUIRED`; ruling above for other groups). In `defaults`, a
  value sets a default and `null` clears it. `lanes` replaces the group's whole lane list (validated as in §1; names
  trimmed, an empty name dropped) and is mirrored to every member in the same write. Turning off a lane that holds
  live cards of live member projects is refused with `LANE_NOT_EMPTY: Move the cards out of {lane} ({n}) before
  turning it off.` (several lanes: "{lane} ({n}), {lane} ({n}) … turning them off."; `{lane}` is the group's lane
  name, `{n}` the count over all live members). An edit that changes nothing writes nothing and bumps no revision.
- `groups.move { id, direction }` → renumbers `position` without bumping revisions (as `projects.move`).
- `groups.delete { id, revision }` → refused with `DEFAULT_REQUIRED` for the default group; otherwise moves the
  group's projects to the default group, archives the group's dispatcher session when it has a live one (§6) and
  removes the group. Each moved project's revision is bumped; the result names the default group and the moved
  projects. The order is DISPATCHER-SPEC §3 (refuse while that dispatcher is running, `DISPATCHER_RUNNING`; archive;
  then the dispatcher record; then the board; a failed archive refuses with `DELETE_FAILED`).
- `projects.set-group { projectId, revision, groupId }`: archived projects too; bumps the project's revision. The
  project adopts the target group's lanes; when the project is live, the target group first turns on every status its
  live cards sit in (its revision is bumped, as for any membership change). The same holds for every project moved
  by `groups.delete`, `set_members` and the repair of §1.
- `projects.create` gains an optional `groupId` (default: the default group); the project form and
  `flowly_create_project` pass it. The new project gets its group's lanes.
- `projects.update` no longer takes lanes: a `lanes` field is refused with `LANES_IN_GROUP: Lanes belong to the
  project's group. Edit them in Group settings.` and nothing is written.
- The old `boardGroups` value in `board-view` is no longer read after migration (§7) and no longer written.

## 3. Navigation

- **Tabs (desktop):** one tab per group in `position` order, labelled with the group's name (accessibility label
  "Group {name}"). Drag to reorder (the shared `SortableList`, `groups.move`), right-click or long-press menu
  (Group settings, New task, Move left, Move right, Delete group…). **+** opens New project preset to the current
  group; **⇕ Manage groups** opens the switcher. There is no All tab and no project tab.
- **Switcher (P):** group rows only, in `position` order; the open group is selected; picking one opens its board.
  Rows for Edit / Restore / Remove of a project move to the group settings page (§5). **Add group** lives here and
  in group settings. On compact layouts the switcher's title is the group's name.
- **View ids:** a group's view id is `*group:<id>`. `*all` and bare project ids are no longer view ids (§7 maps
  stored ones).
- **Which view opens:** an explicit choice in this board instance → the group last viewed during this app run → the
  default group. A chosen group that no longer exists falls back to the default group once the board has loaded.
  Opening a card, a session chip, an idea link or a search result selects that card's project's group; the project
  filter is set to the card's project only when the card is not in the group already shown (otherwise the filter
  is left as it is).
- **No project at all:** the first-run "No projects yet / Create project" screen shows instead of a board.
- **Bell, badge, Search:** the bell, the "N need you" / "N updated" counts of a board and the `N`/`U` step-throughs
  use the shown board's scope (`boardScope`): the filtered project, else every live member of the shown group (§4);
  a step opens each card in the card sidebar whatever its project; the sidebar badge (`attention.count`) and the phone's bell stay
  global over every group (ruling above). Search (button, **S**) keeps searching every project and shows each
  result's project and group.

## 4. The group board

- It is the All projects board (ALL-PROJECTS-SPEC §3–§6, which remain the contract for cards, Manual order by
  project, filters and tags) over the group's live member projects. An archived project is never included, even with
  *Show archived* on.
- **Columns:** the group's enabled lanes in the group's order, with the group's lane names, filtered or not (this
  replaces ALL-PROJECTS-SPEC §2's union of statuses with default names). Every card action (Move to lists, "Moved to
  …" toasts) uses the same names, since every member has the group's lanes.
- **Drag:** dropping a card on another column changes its status (`tasks.place`, appended to the end of that
  project's lane). Every column is a lane of every member, so the drop is always sent; the "{lane} is not a lane in
  {project}." refusal of ALL-PROJECTS-SPEC §4 no longer occurs on a group board (a board shown before its group is
  known keeps it). Reordering within a column follows ALL-PROJECTS-SPEC §4 unfiltered and the project rules filtered.
- **Project filter:** a Project chip in the filter bar (with the Type, Priority and Tags filters) lists the group's
  projects. A filtered board shows one project's cards and ideas, in the group's lanes and lane names. The
  filter is per board instance, kept while the app runs, cleared when the project leaves the group or the group
  changes, and counted in "{n} shown".
- **Overview bar:** shown on every group board with at least one live member, filtered or not. Its task count,
  running chip, "N need you" and "N updated" cover the filtered project, else every live member (the Done count
  sums the projects whose Done lane is on and is hidden when none has it). An empty group has no overview bar.
- **Per-project entries:** with the filter on one project (or a group of exactly one live project) the overview
  bar's Insights, Ideas, Guardrails and Memory chips and **I**, **B**, **M** act on that project. Unfiltered they do
  nothing and are hidden. Project settings are reached from the group settings page.
- **New task:** **T**, **Q**, a lane's Add task and the empty-board hint open Quick task with the filtered project,
  else the last quick-task project when it is a live member, else the group's first member. The Project picker lists
  the group's projects first, then the others (a card can be created in any project; it then belongs to that
  project's group).
- **An empty group** (no live member) opens a board with no columns and "This group has no projects yet." with **New
  project** (preset to the group) and **Group settings**.
- Everything a card does uses the card's own project (ALL-PROJECTS-SPEC §3), including the session defaults chain
  of §5.

## 5. Settings

- **Group settings page** (from the tab menu's **Group settings**, the switcher's **Group settings** row for the
  shown group and the empty-group hint; replaces Settings → Workflow → Board groups): the group's name, the Default flag, **Defaults** (new-card model, mode and thinking level;
  delivery mode; dispatcher model), **Lanes** (below), the member projects (move a project to another group; archived ones shown
  muted), then **one section per project** holding that project's settings as the project form has them today
  (name, root, auto status, workpad, Linear, guardrail commands, auto review and its rework limit, memory,
  its own model default; no lanes). Name, root and the repo-bound settings stay per project; there is no base branch
  or worktree setup stored per project today (the base ref is per card, worktree versus directory is a host
  setting, setup is the repo's `paseo.json`) and none is added here. Each project's section also has **Restore
  {project}** (archived projects only; `projects.update` with `archived: false`) and **Remove “{project}”…**, which
  closes the page and opens the Remove project dialog (PROJECT-REMOVE-SPEC); they replace the switcher's former
  project rows. Unsaved edits in another section ask to be discarded first.
- **Lanes** on the group settings page: the lane editor the project form had (order by drag, or arrows on touch;
  on/off; an optional name), editing the group's lanes, with **Cancel** and **Save** (one `groups.update` with
  `lanes`). A lane that holds live cards of any live member, or the last lane on, can't be switched off there (the
  server refuses the same, §2). Unsaved lane edits count as unsaved edits for the discard question. Edit project
  (a project whose group is not on the board yet) and the New project form have no lane editor.
- **Entry:** every entry opens the page through one board entry point, `onGroupSettings(groupId, focus?)`: `focus`
  opens one project's section. The tab menu and the switcher row open their group with the filtered project's
  section open when the board is filtered to a project of that group (§4); What's new's *Turn on for this project*
  opens the project's section with Auto review switched on. A project whose group is not on the board yet (a cold
  link's board, before the overview) keeps the Edit project dialog.
- **Defaults chain:** `effectiveAgentModel` (`shared/agent-defaults.ts`) extends to host → group → project: the
  project's `agentModel` wins, then the group's `defaults.agentModel`, then the host's `models.default*`. Delivery
  mode: the card's, then the project's (new optional override), then the group's, then the host's
  `delivery.defaultMode`. Dispatcher model: the group's, then the host's `models.dispatcherModel`, then the built-in default
  (`effectiveDispatcherModel`, §6). A default left empty reads "Inherit: {value}" with the inherited value shown.
- Host Settings → Models and Delivery stay as the base and are labelled so; Settings → Workflow loses Board groups
  and *Show All projects tab*.
- **New task delivery mode:** the New task form shows the mode the chain gives (card, project, group, host) and
  stores it as the card's own mode (the unchanged DELIVERY-MODE-SPEC §2 rule). Only cards without a stored mode
  (agent-created) resolve lazily, following later changes to their project's, group's and host's default.
- **Add and delete groups** (ruling, Noah 2026-11-10): **Add group** is on the group settings page and in the
  switcher, and **Delete group…** on the group settings page and in the tab menu (not for the default group; the
  confirm says its projects move to the default group and its dispatcher, if it has one, is archived). `GROUP_BUSY`
  and `DISPATCHER_UNAVAILABLE` refusals show on the page. Renaming a group is the page's name field.

## 6. Dispatcher per group

Contract changes are in DISPATCHER-SPEC (§1, §3, §4, §5, §5.2, §6, §7, §9), marked "per group". Summary:

- One dispatcher session per group in the shared workspace, record v2 keyed by group id; start, replace and status
  take a `groupId`; `DISPATCHER_RUNNING`, limits (40 cards and starts, 5 projects, and the new group-tool bucket)
  and the note batcher are per group.
- The credential adds `groupId`. A tool with a `projectId` outside the caller's group is refused with
  `PROJECT_OUT_OF_GROUP`; `flowly_list_projects` lists the group's members; `flowly_create_project` places the new
  project in the caller's group.
- Notes go to the dispatcher of the card's project's group, resolved when the stop is pushed; a project that moves
  groups sends later notes to the new group's dispatcher. Held notes of a card follow the card.
- New confirmed tool `flowly_manage_groups` (§5.2 rules: not preapproved, prompting modes only, own hourly bucket).
- The dock's chat shows the selected group's dispatcher (Start dispatcher when it has none); the chat items file
  stays one file; a note is stamped with the group and session that received it and a chat shows only its own
  session's notes (ruling, Noah 2026-11-10).
- Deleting a group archives that group's dispatcher session (the confirm says so); Flowly never archives the
  workspace.

## 7. Migration

Runs once on the daemon at start, serialized with the board, **before** the read-time repair of §1 (which would otherwise
fill `groups` and make the migration skip the stored groups), when `board.groups` is empty and the board has
projects (a board with no projects gets the default group lazily on its first project). Idempotent; a failure
writes nothing to the board, keeps the old data and is logged with `logFailure`. The dispatcher record (step 4)
migrates in its own step, independent of the projects, and a v1 `dispatcher.json` on a board with no projects
still becomes v2 with no session entry moved (no group to hold it: it waits until the first group exists).
The two files are written in this order: the board, then the record; a crash between them is repaired by the
next start (the record's session is still v1, the board has groups, so step 4 runs alone).

1. **Groups:** read the host `board-view.boardGroups` through a raw, legacy parse of the stored `board-view` value (the
   typed schema drops `boardGroups` once it is no longer a setting). Each valid stored group
   becomes a `Group` in stored order (invalid entries dropped as the v1 reader did, names cut to 80, duplicates
   renamed with " 2", " 3", …; more than 50 keeps the first 50). The stored value is left in place and ignored
   afterwards. A blank name drops the group (ruling above). A missing file or bad JSON
   reads as no groups, as the v1 reader did; a file that exists but cannot be read fails the migration (retried at the
   next start) rather than placing every project in **Projects**.
2. **Membership:** a project listed in several groups goes to the first of them; a project in none, and a project
   whose group was dropped, goes to the default group **Projects**, created at the end when needed (the name is the English text "Projects", stored as text: the daemon has no translation). When no project needs it and no group is marked, the first group becomes the default. A
   board with no stored groups gets one group, **Projects**, holding every project. A stored "Projects" is reused and
   a new one counts toward the cap (rulings above). Restoring a storage backup from before groups (Settings >
   Storage) migrates it again.
3. **Settings per host:** `boardGroups` is a per-host setting, and the board is the daemon's. Only the daemon's own
   host value is migrated; the board data is the single source from then on. **Downgrade is not supported**: an
   older build strips `groups` and `groupId` from the board; re-upgrading migrates again from the old settings.
4. **Dispatcher:** `dispatcher.json` v1 becomes v2: the one stored session moves to the group with the most open
   cards (not archived, not Done/Cancelled; ties: the first group), keeping `agentId`, `startedAt`, seen mark,
   `previousAgentIds`, `savedTools` and `guard`; the workspace is unchanged. A migrated session's token has no `groupId`
   (DISPATCHER-SPEC §4: the group is found from the record). The session keeps its title and its charter text
   ("all projects") until the next replace: its tools already refuse other groups' projects, and the first board
   note it gets after migration states its group and member projects. The chat items file is not rewritten: an
   unstamped v1 note is read as belonging to the migrated dispatcher's group (the record's `legacyGroupId`), the
   notes stamped from then on belong to the session that received them (ruling, Noah 2026-11-10), and asks and
   answers are not shown in the chat. The change-line mark stays with the migrated dispatcher; other groups start
   with no mark.
5. **View preferences:** a remembered `*all` or project view id (client module state, not persisted) opens the
   default group, or the project's group for a project id. `board-view.allProjectsTab`, `lastProjectId` and
   `boardGroups` are dropped on read (never written), keeping the settings parser's rule that one bad field never
   resets the others.
6. **Project folder copies:** `<root>/.flowly/project.json` (PROJECT-FOLDER-SPEC) does not carry `groupId`; a
   restored project is placed in the default group and takes its lanes (its copied lanes are overwritten, the group
   first turning on the statuses its restored live cards sit in).
7. **Group lanes:** part of the same start write as steps 1–2, and also of every later write and read-time repair,
   for each group that has no `lanes` (every group of a board stored before group lanes; groups made by steps 1–2):
   - a status is on when any live (not archived) member project has it on (a project with no stored lanes has every
     lane on), or when a live card of a live member sits in it; the list is in the default status order;
   - a custom name is kept only when every live member that has the status on uses that same non-empty name;
     otherwise the built-in name applies (no name stored);
   - a group with no live member gets every lane, on, with built-in names.
   The members' `lanes` are then set to the group's (§1). A group that already has `lanes` is never recomputed, so a
   second start writes nothing. Stored lanes that do not validate fail the board's parse as any invalid stored data
   does (the data is kept, not reset). The migration bumps no group or project revision.

## 8. Acceptance

Unit (server/shared, written with the follow-up cards):

- Invariants: every live project has a group; exactly one default; delete moves projects to the default; deleting
  or clearing the default is refused; duplicate and over-long names refused; stale revisions refused.
- Migration fixtures: no groups and several projects; one group with some projects; a project in two groups (first
  wins); a project in no group; archived and deleted members; invalid, duplicate-named and 51 stored groups; corrupt
  `boardGroups`; every project already grouped (first group becomes default); empty board; running twice changes
  nothing; a failed write leaves the old data.
- Dispatcher migration: the old session lands on the group with most open cards (and the tie rule), its record
  fields survive, other groups report `none`; chat notes filter by the session that received them (unstamped v1 notes
  by the migrated group).
- Defaults chain: project over group over host for model, mode, thinking and delivery mode; dispatcher model group
  over host; an empty value inherits and shows the inherited value.
- Per-group dispatcher: start, replace, status and `DISPATCHER_RUNNING` per group; credentials of group A refused on
  group B's projects (`PROJECT_OUT_OF_GROUP`); hourly buckets independent; notes routed by the project's group and
  re-routed after a project moves; a dead group's dispatcher is not replaced by another group's.
- `flowly_manage_groups`: not preapproved, refused in non-prompting modes, refuses deleting the caller's own group
  and the default group.
- Group delete archives only that group's dispatcher session, never the workspace; it is refused while that
  dispatcher is running, and when the archive fails; a start that finishes after its group was deleted writes nothing
  back; a tool delete of a group with a live dispatcher is `GROUP_BUSY`.
- Delivery mode: moving a project or editing a group default changes the default of cards without their own
  delivery mode, i.e. agent-created ones (resolution stays lazy, as `effectiveDeliveryMode` does today); a card's own mode never changes.
- Group lanes: the §7 step 7 union (statuses on in any live member, plus statuses holding live cards), names kept
  only when all agree, all lanes for an empty group, a second start writing nothing; after a group lane edit, a
  project move (set-group, set_members, group delete), a project create and the migration, every member's lanes equal
  its group's; a project's lanes as read by server paths (start status, `laneProblem` in task create and move) are
  the group's; turning off a group lane holding a live card of any live member is `LANE_NOT_EMPTY`; a `lanes` edit
  in `projects.update` is `LANES_IN_GROUP`; a moved project's live card statuses are turned on in the target group.
- Group board: columns and names are the group's, filtered or not; a drop on any column is allowed for every card of
  the group.

Upkeep (the plan's last task): welcome-tour copy and tips, a What's new entry (All and project tabs and the global
dispatcher go away for existing users), the telemetry decision, and every new string in all i18n catalogs.

Manual (Noah's click-through): group tabs (drag, menu, +), the switcher, a group board with its project filter and
counts, the entries I/B/M with and without a filter, New task picker order, an empty group, the group settings page
(defaults, a project section, moving a project), deleting a group with a dispatcher, the dock following the selected
group, an update from an old install (old groups, ungrouped projects, the running dispatcher).
