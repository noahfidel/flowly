# Project Ideas entry: gathering the ideas of all cards

Status: confirmed by the user on 2026-10-16, who asked for it to be implemented ("1. For now, only let new cards do it; 2. Full screen, aligned with Insights" (translated)). Original request (2026-10-16, the user asked: "Add another ideas entry that gathers the ideas that extend from all task cards. The ideas' lifecycle management is consistent, and not fully tied to the task lifecycle. Even if a task is done, its ideas can stay active, and when a task is deleted its ideas are deleted too." (translated)). Card task `fa62fb3d`. This file adds to and changes [IDEAS-SPEC](IDEAS-SPEC.md); behavior not mentioned is unchanged.

## 1. Purpose

Today an idea hangs only in its source card's sidebar, so to see an idea you must first find the card, then open its sidebar:

- A project's ideas are scattered across cards, so you cannot see at a glance "which next steps are still worth doing";
- When the source card is Done it is usually wrapped up (sessions, workspace, card archived), an archived card is not on the board, and its open ideas can never be seen again; today the idea buttons of an archived card are still disabled;
- Different cards may propose the same or related ideas, which is invisible when they are scattered.

This feature adds a project-level **Ideas** page and untangles an idea's lifecycle from the card status: an idea keeps its own status until the user handles it from either entry, or the source card is permanently deleted.

## 2. Lifecycle

### 2.1 Status (unchanged)

`open → accepted` (terminal), `open ↔ dismissed`, with the same meaning as IDEAS-SPEC §2.1. Both entries (the card sidebar and the Ideas page) use the same RPCs and the same component, with the same rules, copy and motion.

### 2.2 Relation to the source card (changed here)

| Source card situation | Idea status | Available actions |
| --- | --- | --- |
| Active (Backlog … In review) | Kept | All (IDEAS-SPEC §6) |
| Done / Cancelled | **Kept**, still counted in the open count | Start a new task, Dismiss, Restore; the three "continue in this card" items are not offered (§2.3) |
| Archived (including archived after wrap-up) | **Kept** | Same as Done / Cancelled (all were disabled before, now opened up) |
| Moved back from Done / Cancelled, or unarchived | Kept | Back to the "active" rules |
| Permanently deleted | Deleted, a backup is written to `removed/` (existing behavior) | — |
| Project archived | Kept, read-only | None (buttons disabled) |
| Project Remove | Deleted and backed up (existing behavior) | — |

- Card status changes, wrap-up, archiving and restoring do not change ideas and write no idea-related events.
- An agent can still propose an idea only on an active card (the write tools on finished/archived cards still reject, as before).
- A card created from an idea and the source card are independent: after the source card is deleted, the new card keeps showing that its `derived` link is no longer valid (CARD-LINKS-SPEC); after the new card is deleted, the idea shows "→ deleted card" (existing).

### 2.3 "Continue in this card" on a Finished / archived card

Done/Cancelled is a human decision. If an idea is sent to a session of such a card, the agent starts working, but its write tools are rejected with `TASK_FINISHED`, and the card status does not leave Done automatically. So:

- The Good idea menu shows only **Start a new task** (with Suggested, regardless of the scope the agent suggested); one line at the bottom of the menu explains "<card title> is Done. Move it back to a work lane to continue in it." (the same for Cancelled and archived).
  (Since 2026-11-09) With only this one path, Good idea no longer pops up a menu and creates directly: when *Quick task for New task* is on it opens Quick task, and this line moves into its **Other options…**; when off it opens the full form (QUICK-TASK-SPEC §10).
- The server's `ideas.adopt` returns the error "This card is finished. Start a new task, or move the card back to continue in it." for a Done/Cancelled or archived card, and changes no data (to guard against an old UI or concurrent state changes).

(The user confirmed not to build "Reopen and continue" for now.)

## 3. Entry points

### 3.1 Overview bar

Add a `Lightbulb` chip before **Insights** in the overview bar: `Ideas N` (N is this project's open idea count, including those on finished/archived cards); when N is 0 it shows `Ideas`. Clicking toggles the Ideas page. Accessibility name "Project ideas: N open (B)".

### 3.2 Shortcut

`B` (light**b**ulb; `I` is already given to Insights) toggles the Ideas page; it is added to the shortcut help table. `Esc` order: session → sidebar → leave the Ideas/Insights page.

### 3.3 Page position

The same project-level full page as Insights, replacing the lane area (`MotionReveal`, transitionKey `ideas`), with a back control. Ideas and Insights are mutually exclusive: opening one closes the other. When switching projects it stays open but the content changes to the new project. The card sidebar can overlay the Ideas page (clicking the source card opens the sidebar, as on the board), and closing the sidebar returns to the Ideas page.

Phone: a full page, back at the top; the bottom popover menu is the same as in the sidebar. Per the performance spec, when switching to the Ideas page the lane tree is hidden, not unmounted.

## 4. Ideas page

### 4.1 Layout

```
‹ Back   Ideas                                     [Search…]
[Open 7] [Accepted 12] [Dismissed 3]     Sort: Newest ▾   Group by card ◻
───────────────────────────────────────────────────────────
 ● Reject when restoring a dismissed idea…   ↳ Continues this task · Bugfix · 2h
   Why: …(2 lines)
   From  ✓ ideas card · Done                              ›
   [👍 Good idea]  [Dismiss]
 ● …
```

- Segments at the top: **Open** (default) / **Accepted** / **Dismissed**, each with its count.
- Search: matches the title, detail, rationale and source card title (case-insensitive, input debounced 200 ms, using `TextBox`).
- Sort: Newest (default, `createdAt` descending) / Priority (Urgent→Low, unset counts as Normal, ties by Newest) / Card (by the source card's column and position on the board, archived cards last).
- **Group by card** (a switch, kept while the page is open): groups by source card; the group header is the source card's status icon + title + the group's count, and clicking the header opens the card; when off it is a flat list.
- Filters (a row of small chips, multi-select, none selected by default meaning all): `Continues a task` (scope=here), `New task` (scope=new), `From finished cards` (source card Done/Cancelled/archived).
- Empty states:
  - The project has no ideas at all: "No ideas yet. Agents propose next steps here as they work."
  - The current segment/filter has no result: "No matching ideas." plus **Clear filters**.

### 4.2 Idea row

Reuses the sidebar's `IdeaCard` (extracted from `client/task-ideas.tsx` into a shared component), with an extra **From** line between the rationale and the buttons: the source card's status icon, title and column name (an archived card shows "Archived"); clicking opens the source card's sidebar; it can be opened even when the source card is not visible (for example archived while the board does not show archived cards; the sidebar shows the card read-only as archived).

- Open segment: Discuss / Dismiss / Good idea, the same as the sidebar (Discuss: see DISPATCHER-SPEC §9.5); the Good idea menu is generated per §2.3 and IDEAS-SPEC §6, and the session list comes from the shared live agent list (`useLiveAgents`, filtered by the source card's workspace, with no new polling).
- Accepted segment: shows "→ new card title" (clicking opens the new card) or "→ Sent to <session>", the same as the sidebar's Closed group.
- Dismissed segment: **Restore**, with the rules of IDEAS-SPEC §7 (same card same title, the limit of 10).
- "Do it in a new session": opens the source card's sidebar (over the Ideas page) and directly pops up the same prefilled Start session dialog; on success `ideas.adopt … send:false`, the same as the sidebar.
- "Start a new task": opens the same prefilled new-card entry (`createFromIdea`: Quick task or the full form, QUICK-TASK-SPEC §10); after the card is created, the new card appears on the board; the Ideas page stays open, and the row collapses out of Open.
- Motion and optimistic updates are the same as the sidebar (collapse 160 ms, new arrivals float up and fade in, Reduce Motion). Switching segments only cross-fades the list, and plays no per-row entrance. Rows in the Accepted / Dismissed segments likewise collapse away after being Restored (no entrance, to avoid animating dozens of rows at once on "Show more"); changing the search or filters rebuilds the whole list, with no row-by-row collapse.

### 4.3 Data

- Everything comes from the existing etag board read (`board.ideas`, `board.tasks`); the Ideas page adds no RPC read or polling.
- Counting, filtering, grouping and sorting are written as pure functions in `client/idea-rows.ts` (an existing file, extended), shared by the overview chip and the page and unit-tested.
- The list renders inside the page's ScrollView (at most 10 open ideas per card), rows are `React.memo`; Accepted/Dismissed show 50 at a time, and "Show more (N)" at the bottom adds 50 more.

## 5. Card sidebar and board cards (adjusted)

- Sidebar Ideas block: the button-disabled condition changes from "card or project archived" to "project archived"; finished/archived cards offer only Start a new task per §2.3.
- The bulb count on board cards: cards in the Done/Cancelled columns show it too (it already does, confirmed to stay).
- Next to the sidebar Ideas block title, add a secondary button "All ideas" (every card has it), which opens the Ideas page showing only that card's ideas (the filter row shows a clearable "Card: <title>" chip at the very front, not using the search box).

## 6. Server changes

| Place | Change |
| --- | --- |
| `BoardStore.updateIdea` | Rejects only when the project is archived ("The project is archived."); a card being archived no longer rejects |
| `adoptIdea` (`server/ideas.ts`) | The precheck and the in-transaction recheck both reject Done/Cancelled or archived cards (the §2.3 text) |
| `tasks.create` + `ideaId` | The source card's status and archival do not affect creating a card from an idea; the project must be the same one and not archived. The system-written `derived` link allows an archived source card (the `archived` option of `addLink`; a manually created link still rejects archived cards) |
| Delete card / Remove project | Unchanged (already cascade-deletes and backs up) |
| Wrap-up, archive, status change, restore | Do not change ideas (confirmed, tests added) |

The data structure is unchanged, the board version is unchanged, no migration.

## 7. Not doing

- Cross-project Ideas summary; idea editing, merging, voting; batch operations (batch Dismiss can be an idea later).
- Letting the agent read other cards' ideas in this project to avoid cross-card duplicates (a later idea: `flowly_get_task` adds the project-level open idea titles).
- Automatic idea expiry.
- "Reopen and continue" (see §8).

## 8. Confirmed

1. Ideas on Finished/archived cards can only create a new card; "Reopen and continue" is not built for now.
2. The entry is an overview bar chip + a full page, aligned with Insights.

## 9. Acceptance

- Unit:
  - `idea-rows`: project count (including finished/archived cards), segment counts, search, the three sorts, grouping, filter combinations, a deleted source card does not appear (deleting cascades).
  - `updateIdea`: an archived card can dismiss/restore; a project archive rejects.
  - `adoptIdea`: Done/Cancelled/archived cards are rejected, with no data change and nothing sent.
  - Creating a card from an idea of an archived or Done card succeeds, writing a `derived` link and `idea_accepted`.
  - The idea status is unchanged before and after a card goes Done, is archived after wrap-up, is moved back, or is restored; after a card is deleted its ideas are deleted and go into the backup.
  - The `B` shortcut mapping and the Esc order.
  - With the switch off, proposing an idea returns `IDEAS_DISABLED` and writes no data, and an already submitted request can still be replayed.
- typecheck, full tests; install and reload.
- A Luna 6 full-permission test session, on a fixture project: two cards propose ideas → overview chip count → the Ideas page's three segments, search, grouping → move the source card to Done and wrap it up, and the idea is still there and can Start a new task, with "continue in this card" not appearing → permanently delete the source card and the idea disappears → phone layout. After it ends, clean up all fixture resources, and keep evidence in `docs/verification/`.
- At implementation, sync IDEAS-SPEC: §5.2 disabled condition, §8 archive, and §9 "project-level Ideas inbox" moved out of not-doing, with a link to this file.

## 10. Ideas switch

2026-10-16 the user asked: "Add a switch for the ideas feature; when off, the ideas entry points are off too. On by default." (translated)

- Setting `ideas` (host scope, `ideasSettings` in `shared/settings.ts`, default `true`), toggled in the **Ideas** block of the Ultra Kanban settings dialog. When the setting cannot be read, it counts as on.
- When off:
  - The overview bar Ideas chip is hidden, the `B` shortcut does not respond, and an already open Ideas page returns to the board;
  - The bulb count on board cards and the card sidebar Ideas block are hidden;
  - `flowly_propose_idea` (and CLI/HTTP `idea`) returns `IDEAS_DISABLED` ("Ideas are turned off in Ultra Kanban settings. Mention follow-up suggestions in your reply instead."), writing no data; the same request submitted before turning off is still replayed from its receipt. The skill tells the agent, on receiving this error, to state the follow-up suggestions in its reply and not retry.
- Turning off deletes and changes no idea; after turning on again everything is as before. Cascade deletion when deleting a card/removing a project is not affected by the switch.
