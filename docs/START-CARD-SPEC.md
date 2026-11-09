# Start a card's session from a tool (START-CARD-SPEC)

`flowly_start_card` lets an agent start a card's session, in the card's own worktree, without the user pressing Start. Contract only; progress is in `docs/PROGRESS.md`.

Status: user decisions 2026-11-08 (single-pane plan Q2(b), Q3, Q6, Q8). It amends AGENT-CARDS-SPEC D1 and D3 (agents may create and start cards without being asked: "No workspace without a card") and adds one automatic archive (§4.3), both recorded as dated exceptions in `AGENTS.md`.

## 1. Callers and access

The same callers as the card tools (AGENT-CARDS-SPEC §2): card sessions on their `flowly` MCP server and sessions outside cards on `flowly-board`. The call is scoped by the caller's project (`CardCaller.projectId`); the dispatcher (DISPATCHER-SPEC, later) passes a caller whose project it picks per call. MCP only; no CLI command.

The **Agents create and edit cards** setting gates it (`AGENT_CARDS_DISABLED` when off).

## 2. Input and output

Input (`startCardInputSchema`):

| Field | Rule |
|---|---|
| `taskId` | the card to start |
| `prompt` | optional, up to 20000 characters: the session's first message. Absent or blank: the card's title and description (its work instructions) |
| `idempotencyKey` | 1–200 characters, chosen by the agent; the same key retries the same start |

Output (`startCardResultSchema`): `{ taskId, workspaceId, agentId, replayed, warnings? }`. `workspaceId` is the card's workspace after the call; `agentId` the session's id; `warnings` lists what could not be cleaned up (§4.3).

`operationId` = `start-card:<sha256([taskId, caller agentId, idempotencyKey])>`.

## 3. Checks (in order; nothing is created when one fails)

1. Setting on (`AGENT_CARDS_DISABLED`).
2. The caller's project exists (`NOT_FOUND`) and is live (`PROJECT_ARCHIVED`).
3. The card exists in that project and is not archived (`NOT_FOUND`); it is not Done or Cancelled (`CARD_FINISHED`).
4. **Replay:** a session this `operationId` prepared earlier that still exists in the card's workspace is returned with `replayed: true`. Nothing else happens and nothing is counted.
5. The card's workspace exists and is not being archived (`RESOURCE_UNAVAILABLE`).
6. It has no live (non-archived) session (`CARD_HAS_SESSION`: send that session instructions instead).
7. Where the session runs (§4): may refuse with `NEEDS_WORKTREE`.
8. At most 20 creations per session per hour, shared with `flowly_create_card` (`CARD_LIMIT`). A start counts once its session is created.
9. A starting model (§5) exists (`MODEL_UNAVAILABLE`).

## 4. Where the session runs

| The card's workspace | Result |
|---|---|
| a worktree | starts there |
| a directory workspace of a linked-root project (`project.links`; no worktree option) | starts there |
| a directory workspace Flowly created for this card (New task or `flowly_create_card`) that never had a session | a new worktree (§4.1), the card moves to it (§4.2), the empty directory workspace is archived (§4.3), the session starts in the worktree |
| any other directory workspace (it had sessions, or the card does not own it) | `NEEDS_WORKTREE`: ask the user to switch the card to a worktree (WORKSPACE-SWITCH-SPEC) |

"Flowly created it for this card" is `Task.ownsWorkspace === true` on a card that never switched workspaces (no `previousWorkspaces`, no `switch`). Cards created before `ownsWorkspace` existed have no marker and are treated as not owned. "Never had a session" counts archived sessions too (Flowly's own short-lived sessions excluded).

A project root that is not a Git repository on a named branch also refuses with `NEEDS_WORKTREE`.

### 4.1 The worktree

`paseo.workspaces.create` with `idempotencyKey: flowly-start:<operationId>` and `source: { kind: "worktree", cwd: <project root>, projectId: <native project>, … }`; Paseo runs the project's setup.

- **Branch name:** the card's Linear branch (§6) when there is one, otherwise `generatedBranchName(card title, operationId)` (`kanban/<slug>-<6 hex>`).
- **New branch:** `action: "branch-off"`, `refName` = the main checkout's current branch (`resolveWorktreeBaseRef`), `branchName` = the name.
- **Linear branch already exists locally:** `action: "checkout"`, `refName` = that branch, when no worktree of the repository has it checked out (the main checkout or another card's workspace). Otherwise the generated name with `branch-off`.

The decision is kept in memory per `operationId`, so a retry after a lost response sends the same request (Paseo rejects a reused key with a different request).

### 4.2 Moving the card

In one board write, only if the card still points at the old workspace and is still live and unfinished: the old workspace is appended to `previousWorkspaces` (read-only history, as a switch does), `workspaceId` becomes the worktree, `ownsWorkspace: true`, `revision` +1, event `workspace_switched` (`actor: "agent"`, `agentId`, note `directory → worktree <branch>`). `switch` is not set (there is nothing to release). The worktree is new, so no other card is bound to it; the write refuses if one is. When the write fails, the error names the worktree, which stays available.

### 4.3 Archiving the empty directory workspace

After the move, the old directory workspace is checked again; when it still has no session at all, `paseo.workspaces.archive` archives it (a directory workspace: Paseo deletes no files). A session that appeared meanwhile keeps it, with a warning; a failed archive is a warning too. This is the only Paseo resource `flowly_start_card` archives.

## 5. The session

Created like the drawer's Start session (`launchKanbanSession`), from the daemon:

- prepared through `ToolServer.prepareSession(taskId, operationId)` (card context, MCP credential, context file, CLI and skill paths);
- `workspaces.ref(<card workspace>).agents.create({ agentId, idempotencyKey: ultra-kanban-session:<agentId>, config: { provider: "<provider>/<model>", systemPrompt, mcpServers: { flowly }, modeId, thinkingOptionId? }, env: { FLOWLY_CONTEXT_FILE, FLOWLY_CLI, FLOWLY_SKILL }, title: <card title>, labels: { "flowly-task": <taskId>, "flowly-started-by": <caller agentId> }, prompt })`. A transport failure is checked against the prepared id, so a created session is never created twice.
- **Model (Q6):** the New task form's defaults: the project's default model, else the global one (Settings → Models), else the latest session of the project's cards (`startingAgent(lastSessionSettings(…), effectiveAgentModel(…))`). Permission mode: the chosen one, else the provider's suggestion (`suggestedMode`). Reasoning: the chosen one, else the provider default. Speed is not set. None of them: `MODEL_UNAVAILABLE`.

## 6. Linear branch name

`linearBranchFor(task, board, connectors)`: the first input artifact of the card whose `external.provider` is `linear` and item type is issue, fetched fresh through its configured connection; its `branchName` (Linear's GraphQL field, added to the connector's summary fields and to `ExternalSummary` as optional `branchName`). `null`, and the generated name is used, when: there is no such input, no connector service, the fetch fails (logged with `logFailure`), the value is empty, or `git check-ref-format --branch` rejects it. A bare Linear URL without a configured connection gives no branch.

`flowly_create_card` has no Linear input (AGENT-CARDS-SPEC non-goal "External inputs on create" stands), so cards it creates with `workspace: "worktree"` get the generated name.

## 7. `flowly_create_card` gains `workspace`

`workspace: "directory" | "worktree"` (default `directory`). `worktree` creates the card in a new worktree branched off the main checkout's current branch with the generated name (`BoardService.createTask`, `mode: "worktree"`). A linked-root project refuses it with `WORKTREE_UNAVAILABLE` before any workspace exists.

## 8. Errors

New codes: `NOT_FOUND`, `PROJECT_ARCHIVED`, `CARD_FINISHED`, `CARD_HAS_SESSION`, `NEEDS_WORKTREE`, `MODEL_UNAVAILABLE`, `WORKTREE_UNAVAILABLE`, `START_FAILED` (Paseo refused the worktree or the session; the message says why and names a worktree that was already created). Reused: `AGENT_CARDS_DISABLED`, `CARD_LIMIT`, `RESOURCE_UNAVAILABLE`, `SESSION_MISMATCH`.

## 9. Acceptance

- `server/start-card.test.ts` with a fake Paseo: a worktree card starts a labelled session (`flowly-task`, `flowly-started-by`, `mcpServers.flowly`, model defaults, default prompt); a retried key returns the same session (`replayed: true`, one create); an owned, session-less directory card gets a worktree, moves to it and its directory workspace is archived; an unowned or used directory card is `NEEDS_WORKTREE`; a linked-root card starts in its directory workspace; Done is `CARD_FINISHED`; a live session is `CARD_HAS_SESSION`; start and create share the hourly limit; the Linear branch is used, an existing free one is checked out, a taken one, a failed fetch or an invalid name falls back to the generated name.
- `server/agent-cards.test.ts`: `workspace: "worktree"` branches off the project's base; a linked-root project refuses it.
- `server/connectors/linear.test.ts`: the issue summary carries `branchName`.
- `server/tool-server.test.ts`: card and board tool lists include `flowly_start_card`.
- `npm run typecheck` and `npm test` exit 0.
