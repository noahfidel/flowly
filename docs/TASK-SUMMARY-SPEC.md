# 任务进展 summary：每轮自动 wrap up

状态：用户 2026-10-15 确认设计（“开干”）。卡片任务 `8c22cc02`。

## 1. 目的

- 一眼看到卡片现在到哪一步：状态一句话、已做了什么、下一步。
- 卡片 Done 之后仍能回查当时做到什么程度：保留每次更新的历史版本。

summary 是系统写的描述文字，**不改**卡片业务状态（lane），也不改 task revision。

## 2. 触发与运行（daemon）

- 触发：卡片的任一对话（§2.1）收到 `agent.turn_ended` 且 `outcome.kind === "completed"`。失败、取消的回合不触发。已归档卡片、已归档项目不处理；Done/Cancelled 的卡片仍可更新。
- 开关：设置 `summaryEnabled=false` 时不触发（手动 Refresh 仍可用）。
- 单飞与合并：每张卡同时最多一个 summarizer。运行中又有回合结束时，把该回合的文本加入待处理；当前运行结束后，把累积的所有回合合并为一次再运行。待处理文本保存在内存中，插件 reload 会丢失，下一轮自然补上。
- 输入（无状态，每次完整传入）：卡片标题、描述（≤2000 字）、当前 lane 名、上一版 summary（若有）、本轮或合并轮次的文本。
- 回合文本：取 hook 自带的 `timeline`；Paseo 0.13 起 `agent.turn_ended` 的 `timeline` 恒为空数组（0.12 有内容），此时由 `server/turn-timeline.ts` 读该 session timeline 最新一页（`tail`、200 条、`projected`）并取最后一轮，与手动 Refresh 同一做法；读取失败保持空，本轮不生成。`user_message` → `User:`，`assistant_message` → `Assistant:`，`tool_call` 只记名字（连续调用合并为一行 `Tools: a, b ×3`），`error` 记一行，其余（reasoning、todo、compaction、plugin、notification）忽略。总长 ≤12000 字，超出时保留开头 3000 字与结尾，中间标注省略。
- 调用：`paseo.workspaces.ref(<卡片 workspace>).agents.create`（2026-10-15 修订，用户选 B）
  - 作为**刚结束回合的 session 的子 session**（`parent`）运行在卡片自己的 workspace 中，不新建原生 project 或 workspace；
  - `config.provider`：设置中的 Summary model（§4）；
  - `title`：`Kanban summary · <卡片标题>`；`labels`：`{"flowly": "summarizer", "flowly-task": <taskId>}`；
  - `prompt` 与 `outputSchema`（§3）；
  - `waitForFinish(120000)`；无论成功、失败、超时，都在 `finally` 中移除该 session（硬删除失败时回退归档，见 §10）。
  - 看板视图按标签隐藏 summarizer：卡片 session 列表、计数、最近输出、Attention、侧栏角标、`flowly_get_task` 的 sessions。项目 Remove 与 Wrap up 的“运行中 session”检查**不**隐藏它，运行中的 summarizer 仍会阻止这些破坏性操作。
  - 初版把 cwd 放在插件数据目录，实测（[验证](verification/task-summary.md)）Paseo 为该目录注册了原生 project 并每次新建 workspace，因此改为本方案；遗留的 project 已删除（`paseo project delete`，不删目录）。
- summarizer 自己的回合结束不会递归触发：它带 `flowly: summarizer` 标签，不属于任何卡片的对话（§2.1）。

### 2.1 卡片的对话（2026-11-09 用户决定）

哪些 session 属于一张卡片，不取决于是谁启动的。`server/card-chats.ts` 是唯一的判定，手动 Refresh、无对话提示与自动 summary 共用：

1. 绑定到该卡的看板管理 session（工具绑定文件，`managedSessions`），无论在哪个 workspace；
2. 加上卡片 workspace（`task.workspaceId`）里未归档的其他 session（例如 PR review 卡片由外部 watcher 以 `pr-review-watch` 标签启动的 review session），经插件 SDK `agents.list({ includeArchived: false })` 分页读取后按 `workspaceId` 过滤（SDK 无 workspace 过滤）。第 2 项排除：
   - 另一张未归档卡片绑定同一 workspace 时（如 local 模式多张卡共用项目 checkout），整个第 2 项跳过，只算第 1 项；
   - 绑定到其他卡片的看板管理 session；
   - 已归档的 session；
   - 内部 session：带 `flowly: summarizer`（含旧 `ultra-kanban: summarizer`；summary、Insights、session insights、quick title、memory、workflow insights 的运行都带它）或 `flowly-dispatcher` 标签的，以及 Paseo 标记 `internal` 的。

Flowly MCP 工具仍只给 Flowly 启动的 session（启动时注入）；本节只决定 Progress 读哪些对话。自动 summary 中，非管理 session 的回合结束时，daemon 只在其 workspace 上有未归档卡片时读取该 session（hook 事件不带标签），再按同一规则判定是否属于唯一那张卡；属于则进入同一队列，同样受 `summaryEnabled` 控制。该回合的 session insights（NATIVE-SESSION-SPEC §12）照旧，互不影响。

## 3. 输出

`outputSchema`（JSON Schema）与服务端 zod 校验一致：

```
{ update: boolean, state: string, target: string, recap: string, next: string }
```

- `update=false`：本轮没有实质进展（寒暄、致谢、只读查询无新结论），不写入新版本。没有上一版时必须给出 summary。
- `state`：一句短语说明现在到哪一步（≤15 词或 30 个汉字），例如“实现完成，等待测试”。
- `target`（2026-10-15 用户追加）：任务的目标与功能点。一行 `Goal: ` 加最多 4 行 `- ` 功能点，依据卡片描述和用户提出或认可的范围；范围不变时原样保留，只有增删或重定义功能时才改。旧版本没有该字段，读作空串。
- `recap`：截至目前对判断进度有用的结果（不只本轮），最多 4 行 `- ` 要点，每行 ≤15 词或 30 个汉字；超出时合并或丢弃旧要点；只写决策和结果，不写读文件、跑命令等过程。
- `next`：唯一的下一步或在等谁，一句话（≤20 词或 40 个汉字）。
- 语言与对话一致。
- 解析 `lastMessage`：容忍 ```json 代码块包裹与前后多余文字（取第一个完整 JSON 对象）。不截断任何字段；仅当单个字段超过 4000 字符（存储安全上限）时视为错误，保留旧版本。Claude provider 不强制 `outputSchema`，实测会返回数组形式的 recap：字符串数组按 `- ` 行拼接；`update` 接受字符串 "true"/"false"；`update=false` 时允许缺字段。

## 4. 设置

2026-10-23 增量：用户可添加多个模型并调整优先级，默认仍 Haiku→Luna。完整兼容、UI 与共享调用合约见 [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md)，取代下文旧的单模型编辑方式；`summaryModel` 保留作兼容输入。

新增 host 设置 `task-summary`（v1），daemon `registerSettings` 读取，客户端在看板顶部工具栏设置齿轮打开的弹层中编辑（§7；Ruling (Noah, 2026-11-09)：设置按钮从左下角移到工具栏）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `summaryEnabled` | `true` | 每轮自动更新 |
| `summaryModel` | `""` | 兼容旧 `provider/model`；空为 Auto |
| `summaryModels` | 未存储时兼容旧值 | 有序、非空、去重的 `provider/model` 列表，优先于旧值；默认 Haiku→Luna |

Auto：按 `claude/claude-haiku-5-5` → `codex/gpt-6-luna` 顺序尝试可用、可选的模型。模型列表中的可用不代表仍有额度：创建失败、额度耗尽/运行错误、超时、请求权限或输出不合 schema 时，清理本次子 session 后尝试下一个模型，每个候选最多一次。首个成功（包括 `update=false`）即停止；保存实际成功的模型。每次候选使用相同输入、父 session 和卡片 workspace，不新建项目或 workspace。旧的手动单模型或单项列表只尝试该模型；多项列表按保存顺序回退，不添加未配置的模型。都不可用或全部失败时报错。设置页的模型选项来自 `providers.listAvailable` + `listModels`（可用 provider 的可选模型）。

## 5. 数据

独立文件 `summaries.json`（与 `board.json` 同目录），串行写、备份、原子替换；内容无效时保留文件并报错，不重置。

```
{ version: 1,
  entries: [{ id, taskId, at, model, agentIds: string[], state, target, recap, next }],
  errors:  [{ taskId, at, message }] }   // 每卡仅保留最近一条
```

- 每张卡最多保留 50 个版本，最新一版为当前 summary。
- 成功写入新版本或 `update=false` 时清除该卡的错误。
- 归档卡片保留 summaries。项目 Remove 时，其卡片的 summaries 与错误写入 `removed/<project>-summaries-<time>.json` 后从文件中删除。

## 6. RPC

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `summaries.read` | `{}` | 每卡最新一版、运行中的 taskId、每卡错误 |
| `summaries.history` | `{ taskId }` | 该卡全部版本（新→旧） |
| `summaries.refresh` | `{ taskId }` | `{ queued: true }`；取该卡最近活跃的对话（§2.1）的 tail timeline（≤200 条）中最后一轮作为输入；没有对话时报错 “This card has no chats to summarize yet.” |
| `summaries.chats` | `{ taskId }` | `{ count }`：该卡对话（§2.1）的数量，卡片不存在为 0 |

## 7. UI

- 卡片：有 summary 时，标题下显示 `state`，最多一行（超出以省略号结尾）；全文在侧栏 Progress 查看（2026-10-15 用户反馈）。
- 侧栏：描述之后、Sessions 之前的 **Progress** 区块：State（强调）、Recap、Next，脚注“Updated 5m ago · Haiku 5.5”。文字从不截断，简短由 prompt 约束。整块内容（State、Target、Recap、Next 一起）超过约 12 行（240 pt）时整体收起到该高度，底部渐隐（2026-10-29 用户反馈：原先约 5 行（104 pt）几乎每条 summary 都被截断；240 pt 下 State、4 行 Recap 与 Next 在默认侧栏宽度约 640 pt 时可完整显示，带 Target 的通常仍收起。该高度经 `ContentCard` 的 `clampHeight` 参数只用于侧栏 Progress，Ideas、Memory 仍为 104 pt；Paseo 时间线中的 Progress 行自 2026-10-29 起默认展开，Show less 收起到 104 pt，见 NATIVE-SESSION-SPEC §5.3），左下角（与右侧“Updated · 模型”脚注同一行，2026-10-19 起位置对调，与 Ideas 卡片一致，共用 `client/content-card.tsx` 的 `ContentCard` 通用卡片样式）的 Show more / Show less 展开或收起；高度用动画过渡（展开 220 ms 减速、收起 160 ms 加速，可打断，遵循 Reduce Motion；首次测量直接定位不播放）。内容未超出时完整显示且不出现按钮。History 列表同样不截断（2026-10-15 用户反馈）。
  - 运行中显示 “Updating…”；最近一次失败显示一行弱化错误，不弹窗。
  - **Refresh** 按钮手动触发；该卡没有对话（`summaries.chats` 为 0，且没有运行中的 summary）时不显示按钮，改为一行弱化文字 “No chats on this card yet.”。计数仅在侧栏打开时读取：workspace 的实时 session 列表变化时立即重读，否则每 30 s 一次；数量未知时保留按钮。**History** 展开为倒序版本列表，每条显示时间与 state，点开看 Recap/Next。
  - 无 summary 时显示一行提示：“Updates after each agent turn.”（自动关闭时提示去设置开启）。
- 设置：看板顶部工具栏的设置齿轮（原左下角悬浮按钮，Ruling (Noah, 2026-11-09)）打开插件自绘的 “Ultra Kanban settings” 弹层（host 的 `addSettingsScreen` 页在当前 Paseo 中不显示，已弃用），Auto summary 开关；Provider（Auto 或可用 provider）→ Model（该 provider 的可选模型）两级选择，选定模型才保存，选 Auto 立即保存。

## 8. 错误

模型列表的单个候选失败先按 §4 回退；全部候选失败（包括单项列表）才记录到 `errors`，保留旧 summary，不循环重试。错误按尝试顺序带模型名与失败原因（仍受 500 字符存储上限约束）。运行结果即使是 `idle`，若带 `error` 也视为失败，不接受其中可能残留的 JSON。只对模型调用与输出解析回退，持久化失败不再次调用模型。成功写入或有效 `update=false` 清除旧错误。日志不打印 prompt 内容。

## 9. 不做（扩展）

- 结构化 todo list：以后可让 `next` 演变为清单。
- summary 驱动状态变更。

## 10. 已知风险

- 插件 SDK 未开放 `internal`：summarizer 在卡片 workspace 中短暂可见（Paseo 原生 workspace 视图里是父 session 的子 session），完成后**硬删除**（`server/summarizer-remove.ts`，本地 `DaemonClient.deleteAgent`，用户 2026-10-22 批准；失败回退归档并记日志），不再留在归档。Paseo 可能为它发一次 finished 通知，尚未实测。
- 手动 Refresh 若判断无新进展（`update=false`）不会新增版本。

## 11. 验收

- 单元：回合文本转换与截断、输出解析容错、模型 Auto 解析、单飞与合并、`update=false` 不写、50 版本上限、错误记录与清除、项目移除备份、不改 board/task revision。
- 回退回归（fake SDK）：运行错误/额度耗尽、idle 带 error、创建失败、wait 抛错、超时/权限/坏输出均尝试下一可用候选；成功或有效 `update=false` 停止；全部失败保留旧摘要、记录各候选模型原因；手动模型不回退；每次已创建的子 session 都清理。
- 卡片对话（§2.1）：只有管理 session；workspace 中非 Flowly 启动的 session（PR review 卡片）计入；workspace 被另一张卡共用时只算管理 session；绑定到其他卡的、归档的、内部 session 不计入；无对话为空；手动 Refresh 能总结非管理的 workspace session。
- 集成（fake SDK）：卡片对话（§2.1）触发；出错/超时也移除（硬删除，失败回退归档）summarizer session；失败回合不触发。
- typecheck、全量测试；reload 本插件；Luna 6 全权限测试 session 用 fixture 卡片实测并清理。
