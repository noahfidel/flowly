# Project-level ideas (PROJECT-IDEAS-SPEC)

Status: user decisions 2026-11-08, Flowly single pane (plan Task 1). Amends [IDEAS-SPEC](IDEAS-SPEC.md) §1 and §2.1 by reference: an idea no longer has to hang on a card.

## 1. Goal and non-goals

A backlog item that belongs to a project, not to any card, is an idea with no `taskId`. Agents in sessions outside cards, the user, and the import ([IDEAS-IMPORT-EXPORT-SPEC](IDEAS-IMPORT-EXPORT-SPEC.md)) all create them. The Ideas page lists them next to card ideas; the user turns one into a card with **New card**.

Non-goals:

- Continuing a project idea in a session ("Continue in card"): there is no source card, so the action is hidden.
- The user editing an idea's text (title, detail, rationale, context) after it is proposed; only Dismiss and Restore, as for card ideas. The dispatcher's `flowly_update_idea` can (DISPATCHER-SPEC §5.1).
- A board event, receipt or Activity entry for a project idea: events require a card.
- A card or board session updating or removing a project idea (their `flowly_update_idea` / `flowly_remove_idea` stay card tools). Only the dispatcher edits and dismisses project ideas (DISPATCHER-SPEC §5.1); no agent removes one.

## 2. Data

`Idea` (IDEAS-SPEC §2.1) changes:

- `taskId`, `agentId` and `eventId` are optional. A project idea has none of `taskId` and `eventId`; `agentId` is set when an agent proposed it.
- New optional `source?: string` (at most 1000 characters): free-text provenance, such as the backlog file and line an imported idea came from.
- `Task.origin.taskId` becomes optional: a card created from a project idea has `origin: { ideaId }`.

No board version bump: the fields default on read (IDEAS-SPEC §2.1), and files written before keep loading unchanged.

## 3. Rules

- **No open cap.** The 10 open ideas per card limit does not apply, and project ideas are not pruned (a backlog import can bring dozens).
- **Unique title.** A title (trimmed, case-insensitive) that equals the title of an open project-level idea of the same project is refused with `DUPLICATE_IDEA`. Card ideas are not compared.
- **Archived project.** Proposing into an archived project fails with `PROJECT_ARCHIVED`; so does dismissing or restoring one of its ideas. An unknown project is `NOT_FOUND`.
- **No event.** Proposing, editing, dismissing and restoring write no `BoardEvent`.
- **Restoring** a dismissed project idea reapplies the unique-title rule among open project ideas; no per-card limit.
- **Accepting** is New card only: `service.createTask({ ideaId })` marks the idea `accepted`, sets `acceptedTaskId`, and records `origin: { ideaId }` on the new card. It adds no `derived` link and no `idea_accepted` event (there is no source card).
- **Continue in card** (IDEAS-SPEC §6.2, `ideas.adopt`) is not offered; the daemon refuses it with "A project idea has no card to continue in."
- **Deleting a project or a card.** A project's delete removes all its ideas (they carry `projectId`). Deleting a card removes only the ideas whose `taskId` is that card; project ideas that the card was created from stay, with `acceptedTaskId` pointing at a deleted card, as for card ideas.

## 4. Interfaces

- `ProjectIdeas` (`server/project-ideas.ts`): `propose(projectId, input, by)` → `Idea`; `list(projectId)` → `Idea[]` (all statuses, project-level only, oldest first). `by` is `{ actor: "human" | "agent", agentId?: string }`.
- `projectIdeaInputSchema` = the card tool's idea input without `scope`, `expectedRevision` and `request`, plus `source`. Fields: `title`, `detail`, `rationale`, `context`, `type`, `priority`, `tags`, `source`.
- RPC `ideas.create-project` `{ projectId, idea }` → `Idea` (a human proposing from the Ideas page or an import).
- Agent tool `flowly_propose_idea` is registered for board credentials (sessions outside cards) with the project input and no `expectedRevision`/`request`: it calls `propose(caller.projectId, …, { actor: "agent", agentId })`. It follows the Ideas switch (`IDEAS_DISABLED`) and the same session checks as the other board tools. A card session's `flowly_propose_idea` is unchanged.
- The dispatcher's `flowly_list_ideas`, `flowly_update_idea` and `flowly_create_card { ideaId }` read, edit, dismiss and accept a project's ideas, project ideas included (DISPATCHER-SPEC §5.1). An edit keeps the unique-title rule (`DUPLICATE_IDEA`).
- Search finds project ideas (`idea` source) and labels them with the project: `projectIdeas: [{ ideaId, projectId, projectTitle, title, status, updatedAt, hits }]` in `search.query` results, only when there are hits.

## 5. UI

- The Ideas page groups by card; project ideas form a **Project** group sorted first. It shows New card, Dismiss and Restore only (no Continue in card).
- A card's own Ideas section lists only its card's ideas.
- A project idea has no "From …" source line. In the grouped view its group header reads **Project** and does not link anywhere.
- **Good idea** on a project idea opens New card directly (prefilled from the idea; no source card context).
- The Ideas count on the board's overview bar counts the project's open ideas, card ideas and project ideas together. The overview carries `projectIdeas: [{ projectId, open }]` (one entry per project; `open` = open ideas without a card) next to the per-card `openIdeas`.

## 6. Acceptance criteria

1. A project idea is stored without a card and `list(projectId)` returns it.
2. 60 proposals to one project all succeed.
3. A duplicate open title is refused with `DUPLICATE_IDEA`; a closed one does not block it.
4. An archived project refuses with `PROJECT_ARCHIVED`.
5. `store.updateIdea` dismisses and restores a project idea without a card or event.
6. `service.createTask({ ideaId })` accepts a project idea, sets `origin.ideaId`, leaves `board.links` unchanged.
7. Board credentials list `flowly_propose_idea` and a call creates a project idea with the session's `agentId`.
8. Search returns project ideas labelled with their project.
9. The Ideas page's grouping puts the project group first, and sorting by card lists project ideas before card ideas.
10. `boardOverview` reports each project's open project ideas in `projectIdeas`, and `projectOpenIdeaCount` adds them to the card ideas.
11. `ideas.adopt` on a project idea fails with "A project idea has no card to continue in." and leaves it open.
12. The dispatcher's `flowly_update_idea` edits and dismisses a project idea without an event; a title equal to another open project idea's is refused with `DUPLICATE_IDEA`.
