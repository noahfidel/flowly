# Dispatcher tool allowlist (DISPATCHER-SPEC §3), 2026-11-09

CLI-only probes, no Paseo daemon. Claude Code 2.1.319; Paseo 0.15.2's bundled Agent SDK 0.3.246. Each run starts Claude Code with stub MCP servers named `paseo` (respond_to_permission, send_agent_prompt, browser_click, create_agent), `flowly-dispatcher` (three Flowly tool names) and `chat_polish` (html_render, html_preview), `--strict-mcp-config`, no setting sources, and `--disallowedTools` = `dispatcherWithheldTools`. It prints the `system/init` tool list and is killed at init, before any model request.

## Results

| Run | `--tools` | Mode | Init tools |
|---|---|---|---|
| CLI, before the fix | (none) | bypassPermissions | CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, PublishPlugin, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, ShareOnboardingGuide, Skill, ToolSearch, WebFetch, WebSearch, Workflow, Write, + the 5 non-paseo MCP tools |
| CLI | Read,Glob,Grep,WebSearch,ToolSearch | default, bypassPermissions, plan, acceptEdits | Glob, Grep, Read, ToolSearch, WebSearch, mcp__chat_polish__html_preview, mcp__chat_polish__html_render, mcp__flowly-dispatcher__flowly_create_card, mcp__flowly-dispatcher__flowly_list_projects, mcp__flowly-dispatcher__flowly_start_card |
| Paseo's SDK, `extraArgs: { tools }` as Paseo spreads `providerOptions` | Read,Glob,Grep,WebSearch,ToolSearch | bypassPermissions | Glob, Grep, Read, ToolSearch, WebSearch, mcp__chat_polish__html_preview, mcp__chat_polish__html_render, mcp__flowly-dispatcher__flowly_create_card |

All `paseo` stub servers connected; none of their tools is listed. Exit 0 for every run.

## `--strict-mcp-config` (ruling, Noah 2026-11-09)

Same kind of probe, Claude Code 2.1.321, with Paseo's real setting sources (`user,project,local`) on the machine's own Claude configuration (one Claude Code plugin MCP server, datadog, and the account's claude.ai connectors). Stub servers passed as Paseo passes them (`--mcp-config`): `paseo` (5 tools), `flowly-dispatcher` (the 8 Flowly tools), `chat_polish` (html_render, html_preview) and `playwright` (standing for another Paseo plugin's server). `--tools` = Read,Glob,Grep,WebSearch,ToolSearch, `--disallowedTools` = `dispatcherWithheldTools`.

| Run | Strict | Mode | Built-in | Flowly | chat_polish | Servers loaded |
|---|---|---|---|---|---|---|
| CLI | no | default, bypassPermissions | Glob, Grep, Read, ToolSearch, WebSearch | 8 | html_preview, html_render | paseo, flowly-dispatcher, chat_polish, playwright, plugin:datadog:mcp, 37 claude.ai servers (354 MCP tools) |
| CLI | `--strict-mcp-config` | default, bypassPermissions | same | 8 | html_preview, html_render | paseo, flowly-dispatcher, chat_polish, playwright (12 MCP tools) |
| Paseo's SDK 0.3.246, create | `extraArgs: { tools, "strict-mcp-config": null }` | default | same | 8 | html_preview, html_render | paseo, flowly-dispatcher, chat_polish, playwright |
| Paseo's SDK, `resume` of that session id, same options | same | default | same | 8 | html_preview, html_render | paseo, flowly-dispatcher, chat_polish, playwright |
| Paseo's SDK, create and resume | no (`extraArgs: { tools }`) | default | same | 8 | html_preview, html_render | as the non-strict CLI run |

No `paseo` stub tool is listed in any run. Exit 0 for every run. Each run is killed at `system/init`, before a model reply; the two SDK create runs leave a session transcript in Claude Code's projects folder for `/tmp/rev-cwd`.

## Pass-through in Paseo 0.15.2 (read from its server build)

- Create: the Claude provider validates `providerOptions` with its strict schema (`extraArgs: record<string, string | null>`) and spreads it into the SDK options; the SDK turns each `extraArgs` entry into `--<key> <value>` and sends no `--tools` of its own when `tools` is unset.
- MCP servers: a plugin's `agent.open.before` servers are merged into the session's `mcpServers`, which the SDK sends as `--mcp-config`, so `--strict-mcp-config` keeps them; it drops only the servers Claude Code reads from its own configuration.
- Resume, refresh and restart: `buildConfigOverrides(record)` and `buildStoredAgentConfig(record)` restore `record.config.providerOptions` from the stored agent (the provider's persistence metadata leaves it out, the record keeps it). A host's own Claude `providerOptions` are deep-merged under the session's, which win.

## Scripts

`probe.mjs <tools|-> <disallowed,csv> <mode> ""` and `sdk-probe.mjs <tools>` with `stub.mjs` and `cfg.json`, kept in `/tmp/flowly-probe` for this run (not committed). Strict runs: `run.mjs <mode> <tools> <sources> [strict]` and `sdk-strict-probe.mjs [strict]` (create, then resume of the same session id) with `stub.mjs`, `cfg.json` and `withheld.txt`, in `/tmp/rev-mcp2` (not committed).
