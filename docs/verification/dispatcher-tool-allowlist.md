# Dispatcher tool allowlist (DISPATCHER-SPEC §3), 2026-11-09

CLI-only probes, no Paseo daemon. Claude Code 2.1.319; Paseo 0.15.2's bundled Agent SDK 0.3.246. Each run starts Claude Code with stub MCP servers named `paseo` (respond_to_permission, send_agent_prompt, browser_click, create_agent), `flowly-dispatcher` (three Flowly tool names) and `chat_polish` (html_render, html_preview), `--strict-mcp-config`, no setting sources, and `--disallowedTools` = `dispatcherWithheldTools`. It prints the `system/init` tool list and is killed at init, before any model request.

## Results

| Run | `--tools` | Mode | Init tools |
|---|---|---|---|
| CLI, before the fix | (none) | bypassPermissions | CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, PublishPlugin, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, ShareOnboardingGuide, Skill, ToolSearch, WebFetch, WebSearch, Workflow, Write, + the 5 non-paseo MCP tools |
| CLI | Read,Glob,Grep,WebSearch,ToolSearch | default, bypassPermissions, plan, acceptEdits | Glob, Grep, Read, ToolSearch, WebSearch, mcp__chat_polish__html_preview, mcp__chat_polish__html_render, mcp__flowly-dispatcher__flowly_create_card, mcp__flowly-dispatcher__flowly_list_projects, mcp__flowly-dispatcher__flowly_start_card |
| Paseo's SDK, `extraArgs: { tools }` as Paseo spreads `providerOptions` | Read,Glob,Grep,WebSearch,ToolSearch | bypassPermissions | Glob, Grep, Read, ToolSearch, WebSearch, mcp__chat_polish__html_preview, mcp__chat_polish__html_render, mcp__flowly-dispatcher__flowly_create_card |

All `paseo` stub servers connected; none of their tools is listed. Exit 0 for every run.

## Pass-through in Paseo 0.15.2 (read from its server build)

- Create: the Claude provider validates `providerOptions` with its strict schema (`extraArgs: record<string, string | null>`) and spreads it into the SDK options; the SDK turns each `extraArgs` entry into `--<key> <value>` and sends no `--tools` of its own when `tools` is unset.
- Resume, refresh and restart: `buildConfigOverrides(record)` and `buildStoredAgentConfig(record)` restore `record.config.providerOptions` from the stored agent (the provider's persistence metadata leaves it out, the record keeps it). A host's own Claude `providerOptions` are deep-merged under the session's, which win.

## Scripts

`probe.mjs <tools|-> <disallowed,csv> <mode> ""` and `sdk-probe.mjs <tools>` with `stub.mjs` and `cfg.json`, kept in `/tmp/flowly-probe` for this run (not committed).
