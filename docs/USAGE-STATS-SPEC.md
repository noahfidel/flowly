# 卡片 token 用量统计（外部日志）与 Activity 折叠

状态：用户 2026-10-15 要求（“尝试增加 codex/claude 的用量统计，只算 token，不算钱，区分输入输出、缓存等”；“side bar 里 activity 允许收起并默认收起”）。

## 1. 范围

- 只统计 token，不计算金额。
- 数据源是 provider 写在本机的会话日志（外部方式，不是 Paseo 公开接口）。v1 支持 Claude Code 与 Codex，包括 `extends: claude` / `extends: codex` 的变体，它们共用同一个 CLI 和日志目录。dsh-web（2026-11-07 起）读取 dsh-web provider 写在 `<PASEO_HOME>/plugin-data/dsh-web-provider/usage/<sessionId>.jsonl` 的每回合用量行（负数 token 按 0 计；provider 在每个回合结束时追加一行 `{time, turnId, inputTokens, cachedInputTokens, outputTokens, startedAt?, endedAt?}`）。其他 provider 显示“无本地用量记录”。
- 统计对象：卡片 workspace 中的全部 session（含已归档）。卡片的 session 就是其 workspace 中的 session。progress summarizer（标签 `ultra-kanban=summarizer`）单独小计。
- 只读：不修改、不复制日志；不记录日志内容；结果不落盘。

## 2. 定位日志

- 每个 session 的 provider 会话 ID 取自 Paseo `agent.runtimeInfo.sessionId`。没有时显示“未开始”。
- 按会话 ID 查找，与 provider 名无关：
  - Claude：`$CLAUDE_CONFIG_DIR` 或 `~/.claude` 下 `projects/*/<id>.jsonl`；子 agent 日志 `projects/*/<id>/subagents/*.jsonl` 计入同一 session。
  - Codex：`$CODEX_HOME` 或 `~/.codex` 下 `sessions/**/rollout-*-<id>.jsonl` 或 `archived_sessions/rollout-*-<id>.jsonl`。文件索引缓存在内存，未命中时最多每 30 秒重建一次。
- 解析结果按（路径、大小、修改时间）缓存。

## 3. 统一的 token 类型

| 字段 | Claude（每条 assistant 消息按 `message.id` 去重后累加） | Codex（最后一条 `token_count.info.total_token_usage`） |
| --- | --- | --- |
| `input` 未命中缓存的输入 | `input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens`（≥0） |
| `cacheRead` 缓存读 | `cache_read_input_tokens` | `cached_input_tokens` |
| `cacheWrite` 缓存写 | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| `output` 输出（含推理） | `output_tokens` | `output_tokens` |
| `reasoning` 其中推理 | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens` |

`total = input + cacheRead + cacheWrite + output`。

缓存命中率 = `cacheRead / (input + cacheRead + cacheWrite)`，即全部输入 token 中直接读自缓存的比例；没有输入时显示 “—”。合计、每个 session 都显示，标题摘要也附带（2026-10-15 用户追加）。

轮数与运行时长同样来自日志：
- Codex：`task_started` 到 `task_complete`。
- Claude：以用户发出的消息为一轮，从该消息到本轮最后一条 assistant 消息。跳过 meta 条目、工具结果，以及以 `<task-notification`、`<system-reminder`、`<command-`、`<local-command` 开头的系统注入消息。这是近似值。

## 4. RPC

`usage.task { taskId }` →

```
{ sessions: [{ agentId, title, provider, model, summarizer, source: "claude"|"codex"|"dsh-web"|null,
               tokens: {input, cacheRead, cacheWrite, output, reasoning} | null,
               turns, activeMs, note }],
  total, work, summarizer: TokenUsage   // 合计、工作 session、summarizer
  turns, activeMs }                     // 仅工作 session
```

单个 session 读取失败只影响该行（`note` 说明原因），不让整个请求失败。

## 5. UI

侧栏中，Details 之后、Activity 之前：

- **Usage**：可折叠，默认收起；标题右侧显示摘要，如“3.1M tokens · 13 turns”。
- 展开后：
  - 按类型列出合计：Input、Cache read、Cache write、Output（附“其中 reasoning”）、Total；
  - 运行时长与轮数；
  - 每个 session 一行：标题 · provider · 总量；
  - summarizer 小计一行；
  - 不支持或找不到日志的 session 显示原因；
  - 脚注：“From local Claude Code / Codex logs; tokens only.”

**Activity**：改为可折叠，默认收起，标题显示条目数。

## 6. 验收

- 单元：两种日志的解析（去重、子 agent、meta 过滤、推理、缓存拆分、空文件、坏行跳过）、定位（环境变量目录、归档目录）、合计（summarizer 分开）。
- typecheck、全量测试；reload 插件；对本卡片调用 `usage.task`，与手工脚本统计的数字对照。
- 未运行：真实 app 渲染（由用户确认）。
