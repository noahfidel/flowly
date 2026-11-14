# Paseo 0.14 plugin tool integration: research and design

2026-11-06, card "paseo tools integration". Status: the user confirmed §5 (D1 raise to 0.14.0, D2 take route B), implemented.

## 1. What 0.14 adds for plugins

Sources: `dist/server/agent-tools.d.ts` and `dist/server/lifecycle.d.ts` of `@getpaseo/plugin@0.14.0`; the Paseo 0.14.0 daemon (`agent/agent-manager.js`, `agent/tools/plugin-tools.js`, `plugins/runtime.js` and `plugins/agent-tools.js` of `@getpaseo/server`); the upstream example `getpaseo/paseo/plugin-examples/agent-tools`.

The request of `before("agent.session_open")` grows from 0.11.2's `{agentId, workspaceId, provider, cwd, reason, purpose, env}` to:

| New field | Meaning |
| --- | --- |
| `title`, `labels` | Read-only, the session's title and labels |
| `tools: AgentToolDefinition[]` | Tools the plugin defines with `defineAgentTool({name, title?, description, input: zod, execute})` and attaches to this one agent |
| `mcpServers` | MCP servers the plugin adds for this one launch, **effective only at launch and not written into the agent's saved config** |

Daemon behavior (confirmed line by line from the code):

1. Every session open (create / resume / refresh / import) calls this hook, and `tools` and `mcpServers` start empty for each plugin; tools and MCP are attached only for `purpose: "interactive"`.
2. **Plugin tools are not a separate MCP server**: they are merged into Paseo's own agent MCP (`paseo`, `/mcp/agents?callerAgentId=…`), and the model sees the name `mcp__paseo__<name>`. `execute` runs in the plugin process, and `context.agent` is supplied by the daemon (id, workspaceId, provider, cwd, title), so the plugin does not need to send credentials itself.
3. Plugin tools are bound by the Paseo tools switch: when the daemon turns Paseo tools off, the provider's `paseoTools.enabled === false`, or the tool name is in `disabledTools`, **the plugin tools silently disappear**. The plugin cannot see this policy in the hook.
4. Name rule `^[a-z][a-z0-9_]*$`, ≤64; the daemon throws when a name equals a built-in Paseo tool or another plugin's tool. `AgentToolDefinition` has no `outputSchema` or `annotations` (`readOnlyHint` etc.).
5. When a plugin's `mcpServers` conflicts with a same-named server in the agent's **saved config**, the daemon throws and **this session open fails**; it also fails when the provider does not support MCP (`capabilities.supportsMcpServers` is false).
6. Plugin start, stop and reload mark already-open sessions stale, and they are reopened before the next idle prompt (the running turn is not interrupted); `paseo.agents.ref(id).reload()` takes effect immediately but interrupts the turn.
7. 0.15 renames the hook to `addHook("agent.open.before")`, and the old name `before("agent.session_open")` is kept until 2027-04-30. Flowly has migrated (§5 D3).

## 2. How Flowly attaches tools today

- A self-built loopback HTTP service (`server/tool-server.ts`): `/mcp` (the official MCP SDK) + `/api` (CLI), with a Bearer credential bound to `agentId + taskId + workspaceId` (`PHASE-02-SPEC` §8).
- Creating a session from a card: the client writes `mcpServers: { flowly: { type: "http", url, headers: { Authorization } } }` into the **agent creation config** (`client/session.ts:129`, `client/session-create.tsx:160`), so the URL and credential are saved permanently in Paseo's agent record along with the agent.
- An existing session joins through "Send Kanban work instructions": CLI only (`prepareExisting` → `prepare(..., "cli")`), because 0.11 cannot add MCP to an existing session (`PHASE-02-SPEC` §3.2, the original limitation at line 146 of PROGRESS).
- `addHook("agent.open.before")` (before the migration it was `before("agent.session_open")`) now only continues writing environment variables such as `FLOWLY_CONTEXT_FILE` for already-bound interactive sessions (`index.server.ts:783`).
- At research time the dependency was pinned at `@getpaseo/plugin` 0.11.2, with `requirements.paseo >=0.11.2`; the local host is already 0.14.0, and npm already has 0.15.2.

**Conclusion one: Flowly makes no use at all of the plugin tool capability of 0.14.**

## 3. Is it worth attaching

Real gaps in the current approach:

| # | Gap | Impact |
| --- | --- | --- |
| G1 | A session that joins later has only the CLI | The agent must read the skill to know it should call the CLI through the shell; the commands are long and error-prone; tool parameters (nextMoves, outputs) have no schema guidance, and the "parameter backstop" that `DELIVERY-CONSTRAINTS` relies on is weak on the CLI |
| G2 | The MCP URL and credential are fixed in the agent's saved config | The credential ends up in Paseo's agent record; when the plugin is uninstalled or the port changes, an old agent connects to a dead server on every launch; it cannot be added or removed by a switch |
| G3 | A self-built MCP service + two MCP SDK dependencies | Maintenance cost, and it runs parallel to Paseo's tool system |

Two possible routes:

| | A. `defineAgentTool` (plugin tools) | B. Inject `mcpServers` at launch (the same 0.14 hook) |
| --- | --- | --- |
| Solves G1 | Yes | Yes |
| Solves G2 | Yes (no credential) | Yes (the credential is no longer saved, only handed out at launch) |
| Solves G3 | Removes only the MCP part; the CLI still needs the HTTP service and credential | No |
| The user turns off Paseo tools, or Paseo tools for one provider | **Flowly tools silently disappear**, the plugin cannot tell, and can only keep B as a backstop → two sets of same-named tools | Not affected |
| Tool name | Becomes `mcp__paseo__flowly_*`; the user's existing `mcp__flowly__*` permission allowlist stops working | Unchanged |
| `outputSchema` / `readOnlyHint` | Lost | Kept |
| Risk | Low | A name conflict or a provider without MCP support makes the session **fail to open**, which must be avoided in the hook (§4.3) |

**Conclusion two: it is worth attaching, but take B, not A.** A's benefit (no credential) does not outweigh "Paseo tools off means no tools" with the plugin unable to notice; backstopping it means keeping B anyway, and the model would see two sets of tools. B solves G1 and G2 with the same 0.14 hook, and the tool names, schemas and annotations all stay the same. A is left for later: if Paseo lets plugins read the Paseo tools policy, or supports putting plugin tools in the plugin's own MCP namespace, reassess then (§7).

## 4. Design (route B)

### 4.1 Behavior

1. `before("agent.session_open")` (`server/session-open.ts`): for a session that is bound (has a context file), whose card is not archived, with `purpose: "interactive"`, return `mcpServers: { ...request.mcpServers, flowly: <url + Bearer> }` in addition to the existing environment variables (`ToolServer.sessionLaunch` decides whether to give it).
2. A new session no longer writes `flowly` into the creation config; the identity is still pre-allocated before creation (`tools.prepare-session` is unchanged), and the hook adds the MCP at the first open.
3. For a session that joins through "Send Kanban work instructions" (`tools.prepare-existing`), `launch-mcp` is recorded only after confirming the provider accepts MCP servers (see §4.3 item 2):
   - Already recorded `mcp` or `launch-mcp`: no further handling.
   - `idle`: first record `launch-mcp`, then `reload()` so the hook adds the MCP. The snapshot after the reload (the agent is loaded by then) must report `supportsMcpServers: true` for it to stay; if the reload fails or it is not supported, remove `launch-mcp`, record a failure with `logFailure`, and return as usual.
   - `running`: do not interrupt. If the snapshot reports `supportsMcpServers: true` (a running agent is certainly loaded, so the capability can be trusted), record `launch-mcp`; this turn uses the CLI and the MCP is there from the next open; otherwise use only the CLI.
   - Other states (`initializing`, `error`, `closed`): use only the CLI.
   - Then the client sends the instruction. The instruction text is unchanged: the skill already says "use MCP if available, otherwise the CLI".
4. After the card is deleted, archived or unbound, the next open no longer injects, and the old session naturally loses the Flowly tools (G2).
5. The CLI and `/api` stay unchanged, as the backstop when MCP is unavailable.

### 4.2 Data contract

- The context file's `methods` takes `"cli" | "mcp" | "launch-mcp"`; `"mcp"` only means **the agent's saved config carries `flowly`** (sessions created from a card before this version). `"launch-mcp"` means injected by the hook: `tools.prepare-session` writes it (if it cannot be created, the provider does not support it, same as before); `tools.prepare-existing` writes it after the confirmation in §4.1 item 3. The hook only reads it and never writes it. Unknown values are kept as they are (no reset, no error).
- `ToolPreparation` (the return of `tools.prepare-session` / `tools.prepare-existing`) drops the `mcp` field: the credential is no longer handed to the client.
- `tools.access-state` shows `launch-mcp` as `mcp` (sidebar "Configuration provided: CLI + MCP").

### 4.3 Open failures that must be avoided

A hook that throws or returns a conflict makes the session fail to open, which is the highest risk:

1. An old session (`methods` contains `"mcp"`) is **not injected**, otherwise it conflicts with the `flowly` in the saved config. When unsure, do not inject.
2. Injecting makes the open fail when the provider does not accept MCP servers (such as Pi, some custom ACP providers). The hook cannot get a reliable capability: for an agent that is not loaded (a resume after a daemon restart) the snapshot uses the default capability, so `supportsMcpServers` is always `false`; the provider snapshot carries no capability. So the hook injects only when the context records `launch-mcp`, and `launch-mcp` is written only after the capability is confirmed (§4.1 item 3). A session created from a card is confirmed by the creation itself: when the provider does not support it, creation fails, same as when it was written into the creation config, so no new risk. Paseo checks the capability first and then replaces the session on reload, so a failed confirmation does not break an existing session.
3. Any exception inside the hook is recorded with `logFailure` and the request is let through as it is (no environment variables and no MCP); it never throws to the daemon.

### 4.4 Compatibility

- User decision (2026-11-06, §5 D1): `requirements.paseo` is raised to `>=0.14.0`, and `@getpaseo/plugin`, `@getpaseo/protocol`, `@getpaseo/client` are pinned to 0.14.0. Users on 0.11–0.13 can no longer install the new version. Rejected: keep `>=0.11.2` with feature detection (one more branch and tests).
- The client and daemon are released together and reloaded together, so the client no longer writing `flowly` into the creation config needs no transition period.
- Scripts in the repo that create sessions themselves (`benchmarks/constraints/runtime.mjs`, `docs/promo/*.mjs`) drop `mcpServers` too. The old scripts under `docs/verification/` are historical evidence and are not changed; before rerunning, remove their `mcpServers`, otherwise they conflict with the injection.
- The 0.15 hook rename is outside this card; the old name works until 2027-04-30 (§7).

### 4.5 Not doing

- No change to the tool set, parameters, return values or skill content (tool names stay).
- No migration of the saved config of old sessions (deleting it needs an agent config change, and the SDK has no matching interface; old sessions keep working).
- No injection into unbound sessions (the rule amended on 2026-10-15 in `PHASE-02-SPEC` is unchanged).

## 5. User decisions (2026-11-06)

- **D1** Raise the minimum Paseo version to 0.14.0 (no old-version feature detection).
- **D2** Take route B, do not attach `defineAgentTool`.
- **D3** (2026-11-07, migration card) Raise the minimum Paseo version to 0.15.0, and pin `@getpaseo/plugin`, `protocol`, `client` to 0.15.0; all hooks now use `server.addHook`: `agent.session_open`→`agent.open.before`, `agent.turn_started`→`agent.turn.before`, `agent.turn_ended`→`agent.turn.after`, `agent.permission_requested`→`agent.permission.before`. Users on 0.14 can no longer install the new version. Rejected: feature detection with `typeof server.addHook` that keeps the old names too (the old names stop working after 2027-04-30, and it needs one more branch and tests). Turn content is no longer read from the hook's `timeline` (always empty); everything uses `server/turn-timeline.ts` to read the session's latest page (`limit: 200`, not 20: with many tool calls in a turn, 20 entries do not reach the user message). The board event names `agent.turn_started`/`agent.turn_ended` are stored data and are not changed.

## 6. Acceptance criteria

1. A session created from a card: the agent's saved config has no `flowly` (config in the SDK snapshot), and the model can call `mcp__flowly__flowly_get_task` successfully.
2. An idle session created from the native entry and then joined through "Send Kanban work instructions": after reopening it can call `flowly_get_task` through MCP; a running session is not interrupted and this turn succeeds with the CLI; a session of a provider without MCP support (such as Pi) opens as usual and uses only the CLI.
3. An old session created before 0.13 with `flowly` in its config: opens as usual, no MCP conflict is reported, and the tools work.
4. After a card is deleted, that card's session has no `flowly` MCP at its next open, and the open itself does not fail.
5. When the injection inside the hook fails (simulated throw), the session still opens, and the log has a `logFailure`.
6. `npm run typecheck` and `npm test` pass; `server/tool-server.test.ts` and `server/session-open.test.ts` cover the three items in §4.3.

## 7. Follow-up

- Conditions to reassess route A: Paseo exposes the Paseo tools policy to plugins, or plugin tools can have their own namespace, `outputSchema` and annotations.
