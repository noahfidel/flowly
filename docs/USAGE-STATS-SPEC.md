# Card token usage stats (external logs) and Activity collapse

Status: requested by the user on 2026-10-15 ("try adding usage stats for codex/claude, count tokens only, not money, separating input, output, cache and so on"; "the activity in the side bar should be collapsible and collapsed by default") (translated).

## 1. Scope

- Count tokens only, compute no money amount.
- The data source is the session logs the provider writes on this machine (an external route, not a public Paseo interface). v1 supports Claude Code and Codex, including the `extends: claude` / `extends: codex` variants, which share the same CLI and log directory. dsh-web (since 2026-11-07) reads the per-turn usage lines the dsh-web provider writes to `<PASEO_HOME>/plugin-data/dsh-web-provider/usage/<sessionId>.jsonl` (negative tokens count as 0; the provider appends one line `{time, turnId, inputTokens, cachedInputTokens, outputTokens, startedAt?, endedAt?}` at the end of each turn). Other providers show "no local usage record".
- Counted: all sessions in the card's workspace (including archived ones). A card's sessions are the sessions in its workspace. The progress summarizer (label `ultra-kanban=summarizer`) gets its own subtotal.
- Read-only: do not modify or copy the logs; do not record log content; results are not written to disk.

## 2. Locating the logs

- Each session's provider session ID is taken from Paseo `agent.runtimeInfo.sessionId`. When there is none, show "not started".
- Look up by session ID, independent of the provider name:
  - Claude: `projects/*/<id>.jsonl` under `$CLAUDE_CONFIG_DIR` or `~/.claude`; sub-agent logs `projects/*/<id>/subagents/*.jsonl` count toward the same session.
  - Codex: `sessions/**/rollout-*-<id>.jsonl` or `archived_sessions/rollout-*-<id>.jsonl` under `$CODEX_HOME` or `~/.codex`. The file index is cached in memory, and on a miss it is rebuilt at most once every 30 seconds.
- Parse results are cached by (path, size, modification time).

## 3. Unified token types

| Field | Claude (summed after de-duplicating each assistant message by `message.id`) | Codex (the last `token_count.info.total_token_usage`) |
| --- | --- | --- |
| `input` input that missed the cache | `input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens` (≥0) |
| `cacheRead` cache read | `cache_read_input_tokens` | `cached_input_tokens` |
| `cacheWrite` cache write | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| `output` output (including reasoning) | `output_tokens` | `output_tokens` |
| `reasoning` of which reasoning | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens` |

`total = input + cacheRead + cacheWrite + output`.

Cache hit rate = `cacheRead / (input + cacheRead + cacheWrite)`, that is the share of all input tokens read directly from the cache; with no input it shows "—". It is shown for the total and for each session, and the title summary carries it too (added by the user on 2026-10-15).

Turn count and run time also come from the logs:
- Codex: `task_started` to `task_complete`.
- Claude: a message sent by the user starts a turn, running from that message to the last assistant message of the turn. Skip meta entries, tool results, and system-injected messages that start with `<task-notification`, `<system-reminder`, `<command-` or `<local-command`. This is an approximation.

## 4. RPC

`usage.task { taskId }` →

```
{ sessions: [{ agentId, title, provider, model, summarizer, source: "claude"|"codex"|"dsh-web"|null,
               tokens: {input, cacheRead, cacheWrite, output, reasoning} | null,
               turns, activeMs, note }],
  total, work, summarizer: TokenUsage   // total, work sessions, summarizer
  turns, activeMs }                     // work sessions only
```

A read failure of one session affects only that row (`note` gives the reason) and does not fail the whole request.

## 5. UI

In the sidebar, after Details and before Activity:

- **Usage**: collapsible, collapsed by default; the summary is shown to the right of the title, such as "3.1M tokens · 13 turns".
- When expanded:
  - the total by type: Input, Cache read, Cache write, Output (with "of which reasoning"), Total;
  - run time and turn count;
  - one row per session: title · provider · total;
  - one row for the summarizer subtotal;
  - a session whose logs are unsupported or not found shows the reason;
  - footnote: "From local Claude Code / Codex logs; tokens only."

**Activity**: becomes collapsible, collapsed by default, and the title shows the entry count.

## 6. Acceptance

- Unit: parsing of the two log kinds (de-duplication, sub-agents, meta filtering, reasoning, cache split, empty file, bad lines skipped), locating (environment-variable directories, archive directory), totals (summarizer kept separate).
- typecheck, the full test suite; reload the plugin; call `usage.task` on this card and compare against the numbers from a manual script.
- Not run: real app rendering (to be confirmed by the user).
