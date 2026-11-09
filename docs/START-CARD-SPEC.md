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
6. It has no live (non-archived) session (`CARD_HAS_SESSION`: send that session instructions instead). For the user's **Start again** from the dispatcher chat (DISPATCHER-SPEC §9.4; a human caller, which also skips check 1 and the limit in check 8), a session whose status is `closed` does not count: a card may have several sessions, so the new one starts next to it and nothing is archived (ruling 2026-11-08). A running or idle session still refuses.
7. Where the session runs (§4): may refuse with `NEEDS_WORKTREE`.
8. At most 20 creations per session per hour, shared with `flowly_create_card` (`CARD_LIMIT`). The slot is taken before any further work, so concurrent creates and starts cannot pass the limit together, and given back when the start or create fails.
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
- **Linear branch exists only on the remote** (`refs/remotes/origin/<name>`, as last fetched; Flowly does not fetch): Flowly creates a local branch tracking it (`git branch --track <name> origin/<name>`) and checks it out as above. If that fails, the generated name with `branch-off`.

The whole `workspaces.create` request (title, key, source) is written to the plugin's tool data per `operationId` before it is sent, and a retry with the same key sends exactly that request, also after a plugin reload or a card rename (Paseo rejects a reused key with a different request). An unreadable kept request refuses with `START_FAILED` (use a new key).

### 4.2 Moving the card

When the create fails, the error is logged and `START_FAILED` asks for a retry with the same key (Paseo may have made the worktree; the retry gets the same one). After the create, the old directory workspace's sessions are read again: when a session started there meanwhile (the drawer's Start session), the card is not moved, the just-created worktree (no work in it) is archived, the event is logged, and the call refuses with `CARD_HAS_SESSION`. When they cannot be read, `START_FAILED` and the card stays.

Otherwise, in one board write, only if the card still points at the old workspace and is still live and unfinished: the old workspace is appended to `previousWorkspaces` (read-only history, as a switch does), `workspaceId` becomes the worktree, `ownsWorkspace: true`, `revision` +1, event `workspace_switched` (`actor: "agent"`, `agentId`, note `directory → worktree <branch>`). `switch` is not set (there is nothing to release). The worktree is new, so no other card is bound to it; the write refuses if one is. When the write fails, the error names the worktree, which stays available, and the failure is logged.

### 4.3 Archiving the empty directory workspace

After the move, the old directory workspace is archived with `paseo.workspaces.archive` (a directory workspace: Paseo deletes no files) only when no other card, live or archived, refers to it as its current or an earlier workspace, and it still has no session at all. Another card's reference or a session that appeared meanwhile keeps it, with a warning; sessions that cannot be read or a failed archive are a warning and are logged. Besides this workspace, `flowly_start_card` archives only the unused worktree of §4.2.

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

- `server/start-card.test.ts` with a fake Paseo: a worktree card starts a labelled session (`flowly-task`, `flowly-started-by`, `mcpServers.flowly`, model defaults, default prompt); a retried key returns the same session (`replayed: true`, one create); an owned, session-less directory card gets a worktree, moves to it and its directory workspace is archived; an unowned or used directory card is `NEEDS_WORKTREE`; a linked-root card starts in its directory workspace; Done is `CARD_FINISHED`; a live session is `CARD_HAS_SESSION`; start and create share the hourly limit, also when called concurrently, and a failed start gives its slot back; the Linear branch is used, an existing free one is checked out, one only on the remote becomes a tracking branch and is checked out, a taken one, a failed fetch or an invalid name falls back to the generated name; a lost create response converges on retry after a reload and a rename; a session that appears during the create keeps the card and archives the unused worktree; a card changed during the create is not moved; a directory workspace another card refers to, or one Paseo will not archive, is kept with a warning; two concurrent starts of one card make one worktree and one session.
- `server/agent-cards.test.ts`: `workspace: "worktree"` branches off the project's base; a linked-root project refuses it.
- `server/connectors/linear.test.ts`: the issue summary carries `branchName`.
- `server/tool-server.test.ts`: card and board tool lists include `flowly_start_card`.
- `npm run typecheck` and `npm test` exit 0.
