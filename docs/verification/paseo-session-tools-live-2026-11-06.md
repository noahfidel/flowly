# PASEO-SESSION-TOOLS-SPEC §6 live check (2026-11-06)

Paseo 0.14.0 on the local daemon. Fixture: Tinylink project (`3db2ad5b-…`), one temporary card
`e0d18428-abb3-4702-affb-c7fe04e4c4ee` "[livetest] launch MCP 2026-11-06" (directory workspace `wks_eeaa11ca43273605`).

## Build under test

The main checkout is on `feat/guardrails` (with others' uncommitted work), and installing bare `main` would have
dropped guardrails, so the user chose a throwaway build: temporary worktree at `feat/guardrails` 0f542ae with
`git cherry-pick --no-commit 5ba57f8` (PR #88). The `server/tool-server.ts` conflict kept #88's `prepareExisting`
together with the guardrails `markUsed` line; for docs, ours was kept. One test-only line was added to `server/session-open.ts`: a label
`flowly-livetest-throw` throws inside the hook (for #5). None of this was committed. `tsc --noEmit` exit 0;
`vitest server/tool-server.test.ts server/session-open.test.ts` 15 passed.

Install switch: `paseo plugin install` refuses an existing id, and `paseo plugin remove` deletes
`~/.paseo/plugin-settings/flowly`, so each switch was backup settings → remove → restore → install. After the
test the plugin was reinstalled from the main checkout (running, settings identical to the pre-test backup by
`diff -r`), the worktree and backups were removed.

## Results

| § 6 | Case | Session | Result |
|---|---|---|---|
| 1 | Card session, Claude (claude-haiku-5-5) | `9fb47852-…` | PASS: `mcp__flowly__flowly_get_task` → `MCP_OK [livetest] …`; saved config mcpServers `[excalidraw]`, no `flowly`; methods `[launch-mcp, cli]` |
| 1 | Card session, Codex (gpt-6-luna, full-access) | `16af827b-…` | PASS: `flowly.flowly_get_task` → `MCP_OK`; saved config `[excalidraw]` |
| 2 | Native idle Claude session + `tools.prepare-existing` | `e47061ec-…` | PASS: methods `[cli, launch-mcp]`, reload kept history, then `MCP_OK` |
| 2 | Native running session + `tools.prepare-existing` | `1e2c61c0-…` | PASS: stayed running (not interrupted), the turn used the CLI (`current` → `CLI_OK`); after the turn + reload, `MCP_OK` |
| 2 | Provider without MCP (Pi) | — | UNRUN: Pi is not installed; Hermes (`e351897c-…`) and Aside (`afcb85dd-…`) both report `supportsMcpServers: true`, so no stand-in exists. Covered only by unit tests |
| 3 | Pre-0.14 Tinylink session, reload only (no message sent) | `402bf42e-…` (fixture) | PASS: closed → idle, no MCP error; saved config still `[excalidraw, ultra-kanban]`, methods `[mcp, cli]` unchanged, nothing injected |
| 3 | Old session whose saved config has `flowly` *and* gets `launch-mcp` | — | UNRUN: only the user's real cards have such sessions; the fixture's old server name is `ultra-kanban` |
| 4 | Delete card (archive false), reload its Claude session | `9fb47852-…` | PASS: reload ok, context file gone, model replies `NO_MCP` |
| 5 | Hook throws (test label) | `7debb073-…` | PASS: session opened and replied `OPENED`; log `Kanban session tools unavailable: 7debb073-… live test: simulated hook failure` |

Counts: 8 passed, 0 failed, 2 unrun.

## Cleanup

- Test card deleted (backup in plugin `removed/`); `tasks.context` for it returns "Task or project not found".
- All 7 test sessions archived, workspace `wks_eeaa11ca43273605` archived (`removedDirectory: false`); no context
  files left under `plugin-data/flowly/sessions/` for them.
- Tinylink: directory present, 6 cards unchanged. Fixture session `402bf42e-…` was only reloaded (now idle, no new
  messages).
- Removed: `/tmp/flowly-livetest` worktree, extracted app.asar, settings backups.
