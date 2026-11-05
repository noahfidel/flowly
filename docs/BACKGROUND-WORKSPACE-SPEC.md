# Background workspace for project-level temporary sessions

Status: user-requested 2026-10-23 (card "memory review session修复"). Their words: "用专用后台workspace，并在使用完成后自动archive，使用前检查有没有archived workspace，有就复用，没有新建". Supersedes the run location in PROJECT-INSIGHTS-SPEC §7, PROJECT-MEMORY-SPEC §4.2 and WORKFLOW-INSIGHTS-SPEC.

## Problem

The memory review, the Insights digest and workflow insights each create a temporary Paseo session that belongs to no card. They used to pick "the project root's workspace": the first workspace with the project's `projectId` and `workspaceDirectory === primaryPath`. Under single-root (SINGLE-ROOT-SPEC) every card's local workspace has that same directory, so the rule matched whichever card workspace Paseo listed first. Every review then opened in that card's workspace (seen: "Insights重设计"). Paseo auto-opens a tab for a session without a parent, so the review showed up as a tab in that card, and the tab stayed after the session was hard-deleted.

## Behavior

- **One per project**: these runs use a plugin-owned workspace titled `Flowly background`, created at the project root (`source: { kind: "directory", path: primaryPath, projectId: paseoProjectId }`). It is never bound to a card and never chosen from card workspaces.
- **Remembered**: its id is stored per project in `background-workspaces.json` in the plugin data directory (`{ version: 1, projects: { <projectId>: <workspaceId> } }`, atomic replace). Invalid data is preserved, and the run fails with an error instead of resetting it.
- **Before a run**: when an id is stored, Paseo is asked about it over the short-lived local daemon connection (the same COMPAT path as WORKSPACE-RESTORE-SPEC, `workspace.recovery.inspect/restore`):
  - archived and recoverable: restore it and reuse it;
  - not archived: reuse it as it is;
  - unavailable (removed), or the daemon cannot be reached: create a new one and store its id. The old one is left alone.
- **After a run**: when the last run in the project ends, successful or not, the workspace is archived (`paseo.workspaces.archive`). Archiving clears its sidebar entry and tabs. An archive failure is logged and does not fail the run.
- **Overlap**: runs in the same project share the open workspace. A per-project counter makes sure it is archived only after the last one ends; opening and closing are serialized per project.
- Each run hard-deletes its own session when done (`server/summarizer-remove.ts`; archived if the delete fails): the memory review, and since 2026-10-23 also the digest and workflow insights.
- The quick task title run (QUICK-TASK-SPEC §4, 2026-11-05) also runs here: its card's workspace may still be setting up, and the run belongs to the project rather than to the card's sessions. It hard-deletes its session like the others.
- The card summarizer and session insights are unchanged: they run as child sessions in the card's own workspace.

## Code

`server/background-workspace.ts` (`BackgroundWorkspaces.use(project, paseo, work)`, one shared instance per data directory) is used by `server/memory.ts`, `server/insights.ts` and `server/workflow-insights.ts`. Tests: `server/background-workspace.test.ts`.

## Not covered

- The tab was left open after a hard delete because of Paseo app behavior, which the plugin cannot change. This spec avoids it by archiving the whole workspace; the exact app rule was read from its bundle, not measured.
- Removing a project does not delete the stored id; a stale id is detected as unavailable and replaced.
