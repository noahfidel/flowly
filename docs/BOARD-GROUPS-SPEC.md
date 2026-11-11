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
- Ruling (Noah, 2026-11-11): the board's bell (on phones too), its "N need you" and "N updated" counts and the **N** /
  **U** step-throughs cover the shown group (or the filtered project). Each other group with need-you asks shows its
  count on its tab and its switcher row (phones: a dot on the switcher title), so an ask in one group is seen from
  another. The Paseo sidebar badge stays global over every group.
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
  (Insights, Ideas, Memory, Guardrails, **I**, **B**, **M**) stay hidden unfiltered. (Insights, Ideas, Memory and
  **I**, **B**, **M** are amended by the group pages ruling below; Guardrails stays hidden.)
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
- Ruling (Noah, 2026-11-10): lanes are refused per project only while groups are ready. When the groups migration has
  failed (groups not ready) on a board that has no stored groups, `projects.update` still accepts `lanes` through the
  old per-project path (a lane holding a live card of the project can't be turned off) and Edit project still offers
  the lane editor; the migration later folds those lanes into the group's. When the board already has stored groups
  and this start's migration has not succeeded yet (a retry, a failed re-migration), the edit is refused with
  `GROUPS_UNAVAILABLE` (the more accurate code: Group settings is unavailable too), because the next migration would
  overwrite it from the group's lanes. This replaces the inherited "projects have no lane settings of their own"
  limit for the first state only.
- Ruling (Noah, 2026-11-10): a group never ends up with every lane off: when the migration's computation (live or
  archived members) leaves no lane on, the group gets every lane on with built-in names. The per-project path's rules
  are unchanged.
- Ruling (Noah, 2026-11-10): the migration gives a group whose members are all archived the lanes its archived members
  had (the same union, order and name-agreement rules as for live members) instead of every lane on with built-in
  names; only a group with no member at all gets every lane. Replaces "a group with no live member gets every lane".
- Ruling (Noah, 2026-11-10): when a write outside the migration turns a group's lane back on for a live card, the lane
  still comes back on, and the store logs one info line per write naming the group, the lane(s) and the reason (§1).
- Ruling (Noah, 2026-11-10): **Discard** in the group settings page's unsaved-changes question also resets the lane
  editor to the group's stored lanes and clears its unsaved mark (§5); before, only the leave ran and the draft and
  mark stayed.
- Ruling (Noah, 2026-11-10): the start migration bumps no group or project revision, including when it turns on a lane for a
  live card; only later writes bump the group's revision for that (§1, §7 step 7).
- Ruling (Noah, 2026-11-10): Manual sort on a group board is **one order per column across all the group's projects**,
  not grouped by project. The user drags a card up or down within its own column (or uses Move up / Move down) on a
  group board, filtered to one project or not; the filtered board shows the group order restricted to that project.
  The migration makes the first group order equal to what the unfiltered Manual sort showed before (projects in
  chooser order, each keeping its own order). This replaces the inherited ALL-PROJECTS-SPEC §4 limit ("cards grouped
  by project", "reordering within a column is disabled… each project keeps its own order") on group boards (§1, §2,
  §4, §7 step 8).

- Ruling (Noah, 2026-11-10): Insights, Ideas and Memory (and **I**, **B**, **M**) work on an unfiltered group board,
  over every live member of the group; filtered (or a group of one live project) they act on that project, as before.
  They cover live members only (an archived project is never a member of the board, §4). Ideas and Memory list every
  member's entries, each labelled with its project; an edit acts on the entry's own
  project, and an addition (Import ideas, Add memory) asks which project. Insights shows the group's numbers summed
  and splits by project where a part is per project (the day's summaries, skills, other suggestions). Storage stays per
  project. Guardrails stays per project and hidden unfiltered (§4).

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
  card restore safe; lane edits and card moves are refused before they could break it. A read applies the same
  invariants to its copy without changing any revision. Turning a lane on in a write outside the migration (for
  example an automation such as the PR review cards writing a card into a lane the group had turned off) keeps
  happening, and is logged as an info line (`console.log`, not `logFailure`) naming the group id and the lane(s)
  and saying a live card of one of its projects sits in it; reads log nothing.

- **Manual order** (ruling above): a card keeps its one `position`; within a group it is comparable across the
  group's projects, so a group column's Manual order is position order (then creation) over every member's cards,
  and one project's order (a project board, a filtered group board, agents and every other per-project reader) is
  that order restricted to the project, unchanged for those readers. `project.orderGroupId` (optional, server-kept)
  names the group whose order the project's card positions belong to. At the end of every write, in the same
  serialized operation as the other group invariants, every project whose `orderGroupId` differs from its `groupId`
  (a project that moved group by set-group, set_members, a group delete or the repair; a new or folder-restored
  project; every project before this change) joins its group's order: its cards, archived ones too, are renumbered
  per status to follow the group's last card in that column, in the project's own order, and `orderGroupId` is set.
  Several joining projects go live ones first, then archived ones, each in chooser order. Only the joining
  project's positions change; positions are presentation, so no card, project or group revision is bumped (the
  DRAG-REORDER-SPEC amendment). A read applies the same to its copy. A project with no group (groups not ready) keeps
  its own order. `orderGroupId` is not part of the project folder copy (§7 step 6).
- **Where cards land in the group order**, chosen to match how a project's order behaves: a new card (`tasks.create`,
  agent and dispatcher creates, quick task) and a card an automation moves into a lane (PR review cards) go after
  the last card of the group's column, so they are last in the group and in their project. A status change through
  the card form, an agent's or auto status keeps the card's `position`, as it did per project, so it lands at the
  matching place of the group's new column. A placement (`tasks.place`) goes exactly where it is dropped (§2). A
  card never changes project.

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
- `tasks.place` (DRAG-REORDER-SPEC §2) works on the group's column once groups are ready: the anchor (`beforeId` /
  `afterId`) may be a card of any project of the card's group (archived projects' cards included, as archived cards
  are); an anchor that is missing, the card itself, in another status or in a project of another group is refused
  with "Drop position changed. Reload and try again." and nothing is written. The card's revision is checked as
  before ("Revision conflict: this card changed. Reload before moving."), only that card's revision is bumped, and
  equal neighbours renumber the group column's positions without revision bumps. Before groups are ready the column
  is the card's project's, as before.
- `tasks.move { id, revision, direction, scope? }` (menu Move up / Move down): `scope: "group"` steps past the
  adjacent live card of the group's live projects in that column (the unfiltered group board); `project` (the
  default, a filtered group board or a project board) past the adjacent live card of the card's own project. It then
  places the card through `tasks.place`. Before groups are ready `group` acts as `project`.
- `projects.create` gains an optional `groupId` (default: the default group); the project form and
  `flowly_create_project` pass it. The new project gets its group's lanes.
- `projects.update` no longer takes lanes once groups are ready: a `lanes` field is refused with `LANES_IN_GROUP: Lanes
  belong to the project's group. Edit them in Group settings.` and nothing is written. While groups are not ready and the
  board has no stored group (the migration failed) it takes them as before: the lanes of a project turn off only when
  it holds no live card there; with stored groups and groups not ready it is refused with `GROUPS_UNAVAILABLE`.
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
  group last viewed as stored in the host's `board-view` settings (`lastGroupId`, so it survives a restart, when Paseo
  re-runs the client and module state is gone) → the default group. A chosen or stored group that no longer exists
  falls back to the default group once the board has loaded. The shown group is stored only once both the board and
  the settings have loaded, so a cold start never overwrites the stored group with the default one.
  Opening a card, a session chip, an idea link or a search result selects that card's project's group; the project
  filter is set to the card's project only when the card is not in the group already shown (otherwise the filter
  is left as it is).
- **No project at all:** the first-run "No projects yet / Create project" screen shows instead of a board.
- **Bell, badge, Search** (ruling above): the bell (desktop and phone), the "N need you" / "N updated" counts of a
  board and the `N`/`U` step-throughs use the shown board's scope (`boardScope`): the filtered project, else every
  live member of the shown group (§4); a step opens each card in the card sidebar whatever its project. Every other
  group's need-you count (its live members' open asks, as the bell counts them; `otherGroupNeeds`) shows as a count on
  its tab and its switcher row, and none when it has none; on compact layouts the switcher title carries a dot while
  any other group has one. The accessibility label adds "{n} need you". The sidebar badge (`attention.count`) stays
  global over every group. Search (button, **S**) keeps searching every project and shows each result's project and
  group.

## 4. The group board

- It is the All projects board (ALL-PROJECTS-SPEC §3, §5, §6, which remain the contract for cards, filters and tags)
  over the group's live member projects; its order is below. An archived project is never included, even with
  *Show archived* on.
- **Columns:** the group's enabled lanes in the group's order, with the group's lane names, filtered or not (this
  replaces ALL-PROJECTS-SPEC §2's union of statuses with default names). Every card action (Move to lists, "Moved to
  …" toasts) uses the same names, since every member has the group's lanes.
- **Drag:** dropping a card on another column changes its status (`tasks.place`: with the Manual sort at the
  slot it is dropped on, otherwise at the end of the group's column). Every column is a lane of every member, so the drop is always sent; the "{lane} is not a lane in
  {project}." refusal of ALL-PROJECTS-SPEC §4 no longer occurs on a group board (a board shown before its group is
  known keeps it).
- **Order:** with the Manual sort a column shows the group's one order (§1), unfiltered across every live member,
  filtered restricted to that project. The user reorders within a column by dragging (desktop) or with Move up /
  Move down (card menu and action sheet), filtered or not; the drop is anchored on the neighbouring visible cards,
  whatever their project (`tasks.place`, §2). Other sorts (Recent activity, Priority, Newest, Title) apply across
  the shown cards; ties fall back to the group order, then the project order; dragging within a column under them
  shows the existing "Sorted by {sort}…" toast. A board of several projects shown before its group is known (a cold
  link) keeps ALL-PROJECTS-SPEC §4: grouped by project, no reorder.
- **Project filter:** a Project chip in the filter bar (with the Type, Priority and Tags filters) lists the group's
  projects. A filtered board shows one project's cards and ideas, in the group's lanes and lane names. The
  filter is per board instance, kept while the app runs and in the host's `board-view` settings (`lastFilter`: the
  group and project it was set in), so a restart starts from it; a filter set or cleared in this run wins over the
  stored one. It is cleared (and the cleared value stored) when the project leaves the group or the group changes,
  checked only once the board and the settings have loaded, and counted in "{n} shown".
- **Overview bar:** shown on every group board with at least one live member, filtered or not. Its task count,
  running chip, "N need you" and "N updated" cover the filtered project, else every live member (the Done count
  sums the projects whose Done lane is on and is hidden when none has it). An empty group has no overview bar.
- **Insights, Ideas, Memory** (ruling above): with the filter on one project (or a group of exactly one live project)
  the overview bar's Insights, Ideas and Memory chips and **I**, **B**, **M** act on that project. Unfiltered they
  cover every live member of the group shown (`pageScope`); an empty group, and a board shown before its group is
  known (a cold link), has none and they are hidden. A page left open when the filter is cleared stays open and widens
  to the group.
  - **Ideas:** every member's ideas, one etag read per project (a change re-downloads only that project's ideas). Each
    project's own ideas form their own group, headed by the project's name; card groups and ungrouped rows name the
    project too. Every action (Good, Dismiss, Discuss, New task, Restore) uses the idea's own project. The Ideas chip
    counts the open ideas of every member. **Import** asks which project (a Project row on the paste step), starting
    with the project last added to from such a page (board-view `lastAddProjectId`, while it is still offered) else
    the first member. "All ideas" from a card keeps an unfiltered board unfiltered; a board filtered to another project is filtered
    to the card's.
  - **Memory:** every member's memories (the guardrail notes), one etag read per project, each labelled with its
    project. Edits, pins, archive and delete act on the entry's own project. A member with guardrails off is shown
    read-only, with one notice naming the projects whose guardrails are off. **Add memory**
    asks which project (members with guardrails on only), starting as Import does; it is hidden when no member can
    take one. The Memory chip sums the notes of the members with guardrails on and hides when none has them on.
  - **Insights:** read as the group (`insights.group`, `insights.group-day`, `insights.group-tokens`,
    `insights.group-guardrails`): the heatmap, the day's numbers and cards, workflow numbers, agent habits and the
    guardrail ledger cover every live member as one, and each of the day's cards names its project. The parts that
    are per project show once per member, each labelled with the project: the day's AI summary (one for each project
    with a card that day, with its own Generate / Refresh), Skills ("Skills · {project}") and Other suggestions; a
    suggestion's New task opens in its project. The ledger does not open Guardrails (it is per project).
- **Guardrails** stays per project: its chip shows only with the filter on one project (or a group of one), and a
  Guardrails page left open when the filter is cleared closes. Project settings are reached from the group settings
  page.
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
  server refuses the same, §2). Unsaved lane edits count as unsaved edits for the discard question, and Discard resets the lane editor to the stored lanes. They survive a
  change of the group that leaves its lanes as they were (rename, defaults, a project move); a lane change made
  elsewhere reloads an untouched editor, and refuses the first Save of an edited one with "Lanes changed elsewhere.
  Your edits were kept; review and save again." (a second Save overwrites). Edit project
  has no lane editor while groups are ready (a project whose group is not on the board yet, as on a cold link, has
  none either); while they are not ready and the overview lists no group it shows the project's own lane editor. The
  New project form has none.
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
   default group, or the project's group for a project id. The group and filter stored since (`lastGroupId`,
   `lastFilter`, §3, §4) are new fields with empty defaults, so an older install opens the default group once. `board-view.allProjectsTab`, `lastProjectId` and
   `boardGroups` are dropped on read (never written), keeping the settings parser's rule that one bad field never
   resets the others.
6. **Project folder copies:** `<root>/.flowly/project.json` (PROJECT-FOLDER-SPEC) does not carry `groupId`; a
   restored project is placed in the default group and takes its lanes (its copied lanes are overwritten, the group
   first turning on the statuses its restored live cards sit in).
7. **Group lanes:** part of the same start write as steps 1–2, and also of every later write and read-time repair,
   for each group that has no `lanes` (every group of a board stored before group lanes; groups made by steps 1–2):
   - a status is on when any live (not archived) member project has it on (a project with no stored lanes has every
     lane on, in the default order), or when a live card of a live member sits in it;
   - the order is the members' own when every live member's full lane list (all statuses, on or off) has the same
     order, so a group of one member keeps that member's order; otherwise it is the default status order;
   - a custom name is kept only when every live member that has the status on uses that same non-empty name;
     otherwise the built-in name applies (no name stored);
   - a result with no lane on becomes every lane on, built-in names;
   - a group with no live member takes its lanes from its archived members by the same three rules (the statuses
     holding live cards are none then); a group with no member at all gets every lane, on, with built-in names.
   The members' `lanes` are then set to the group's (§1). A group that already has `lanes` is never recomputed, so a
   second start writes nothing. Stored lanes that do not validate fail the board's parse as any invalid stored data
   does (the data is kept, not reset). The migration bumps no group or project revision.
8. **Group order:** part of the same start write (and of every later write and read-time repair, §1). Every project
   without an `orderGroupId` equal to its `groupId` joins its group's order; on a board where no project has joined
   yet this renumbers each group column to the order the unfiltered Manual sort showed before the change: the live
   members in chooser order, each with its own cards in its own order (archived cards included), then the archived
   members. Each project's own order is unchanged. No revision is bumped; a second start writes nothing. A downgrade
   drops `orderGroupId`; re-upgrading migrates the order again from the then-current positions.

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
  only when all agree, all lanes for a group with no member (an all-archived group takes its archived members' lanes), a second start writing nothing; after a group lane edit, a
  project move (set-group, set_members, group delete), a project create and the migration, every member's lanes equal
  its group's; a project's lanes as read by server paths (start status, `laneProblem` in task create and move) are
  the group's; turning off a group lane holding a live card of any live member is `LANE_NOT_EMPTY`; a `lanes` edit
  in `projects.update` is `LANES_IN_GROUP`; a moved project's live card statuses are turned on in the target group.
- Group board: columns and names are the group's, filtered or not; a drop on any column is allowed for every card of
  the group.
- Group order (`shared/group-order.test.ts`, `server/store-group-order.test.ts` on JSON and SQLite,
  `client/all-projects.test.ts`): the migration stores the former unfiltered Manual order (chooser order, each
  project's own order, archived members last) with no revision bump and a second start writes nothing; a drop
  anchored on another project's card of the group interleaves the projects and changes only the moved card's
  revision; the filtered order is the group order restricted to the project; an anchor in another group and a stale
  revision are refused without a write; a project moved by set-group or a group delete joins the end of the target's
  columns in its own order and no other card's position changes; a new card is last in the group's column; Move up /
  Move down step through the group (unfiltered) or the project (filtered), skipping archived cards and projects; the
  Manual sort of a group board is position order across projects; reorder is allowed with Manual on a group board,
  filtered or not, and never on a board of several projects with no group known.

- Group pages (`client/board-groups.test.ts`, `client/idea-rows.test.ts`, `client/overview-query.test.ts`,
  `server/insights.test.ts`): `pageScope` is the filtered project, else every live member read as the group, else none
  (empty group, group not known); the add project is the last added while offered, else the first; each project's own
  ideas form their own group; the Ideas count sums every member; the group Insights reads sum the members.

Upkeep (the plan's last task): welcome-tour copy and tips, a What's new entry (All and project tabs and the global
dispatcher go away for existing users), the telemetry decision, and every new string in all i18n catalogs.

Manual (Noah's click-through): group tabs (drag, menu, +), the switcher, a group board with its project filter and
counts, the entries I/B/M with and without a filter, New task picker order, an empty group, the group settings page
(defaults, a project section, moving a project), deleting a group with a dispatcher, the dock following the selected
group, an update from an old install (old groups, ungrouped projects, the running dispatcher).
