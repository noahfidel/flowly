# Workflow insights：从 agent 的命令里找出可复用的脚本、工具与流程

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：无被取代的部分；§3.2 的命令记录多了一个消费者（GUARDRAILS-SPEC §4.5 的每周重识别）。

状态：**已实现，待用户验收**（2026-10-19，卡片 `3df1723e` “paseo project settings互通”；用户当天确认本 spec 及 §11 的全部决定）。用户确认方向：“这个洞见功能做成开关，也增加模型配置和洞察周期设置，token 充裕可以设置为每天定时，不充足可以拉长周期”。本 spec 是 [PROJECT-INSIGHTS-SPEC](PROJECT-INSIGHTS-SPEC.md) 的扩展，不改变其已有行为。

> 2026-10-25：[INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md) 第三版取代本文的以下部分：§2 的默认开关（改为默认开启）与设置名称（改为 Skills）、§4.1 的安静期与首次运行时机、§4.2 的素材（新增卡片、用户原话、记忆、已有 skill）、§4.3 中 skill 一类的 prompt、§4.4 的 skill 校验、§5.2 的区块摆放（skill 草稿进 Skills 区块，其余进“其它建议”）、§5.3 的替换（按类别）、§8 的提示和 §11.1。


## 1. 目的与依据

agent 在卡片里反复手敲同样的命令、反复写同一类内联脚本、反复摸索同一套流程。Workflow insights 定期扫描本项目各卡片 session 实际执行过的 shell 命令，找出值得沉淀的东西，用户确认后变成一张卡片去落地，让以后的任务直接复用。

2026-10-19 在 Flowly 项目上的两次只读探针（记录在卡片进展中，未落盘原始命令）：

| | 72 h 规则统计 | 7 天 + `claude/claude-sonnet-5` |
| --- | --- | --- |
| 规模 | 18 session / 18 卡 / 941 次 shell 调用 | 44 session / 33 卡 / 4778 次调用，1364 段不同内联脚本 |
| 结论 | 76% 是探索命令；只得出 1–2 条已写在 AGENTS.md 的建议（verify） | 6 条，只有 1 条属于 `paseo.json`：i18n 词条脚本、Playwright 正式依赖 + 共享浏览器模块、看板数据查看脚本、verify/redeploy、文档同步清单、fixture 清理清单 |
| 代价 | 0 | 一次 267 s、约 $0.80（16.8 万上下文 token、2.2 万输出） |

由此得到的设计取舍：

- **规则负责采集、计数和筛选，LLM 负责解读**（尤其内联脚本的用途），并且建议目标不限于 `paseo.json`。
- **LLM 不能每轮或每次打开页面跑**：需要跨多张卡的数据才有意义，单次代价不低。所以做成定时任务，用户按自己的 token 预算选周期。
- **默认关闭**：要花 token，也会收集命令记录。

## 2. 设置

### 2.1 全局（host）设置 `workflow-insights`

新设置定义（`shared/workflow-insights.ts`），`scope: "host"`，`version: 1`：

| 字段 | 类型 / 默认 | 含义 |
| --- | --- | --- |
| `enabled` | boolean，`false` | 总开关：采集命令记录并按周期分析 |
| `model` | string ≤200，`""` | `provider/model`；空为 Auto |
| `intervalDays` | `1 \| 3 \| 7 \| 14`，`7` | 分析周期：每天 / 每 3 天 / 每周 / 每两周 |
| `runHour` | 0–23，`9` | 到期当天在本地时间这个整点之后运行 |
| `timeZone` | string ≤64，`""` | 客户端保存设置时自动写入设备的 IANA 时区；无效或空时用 daemon 本地时区 |

- **Auto 模型**：依次取第一个可用的 `claude/claude-sonnet-5-5`、`claude/claude-sonnet-5`，都没有时用 Summary model 的解析结果（TASK-SUMMARY-SPEC §4）。理由：便宜的摘要模型不足以归纳跨卡片的模式，探针用的是 Sonnet 5。
- 配置的模型不可用时，本次运行记为错误 “Workflow insights model … is not available.”，不改用其它模型。
- 旧数据缺字段时按默认值读取（同 `summarySettingsValues`）。

### 2.2 项目设置

`Project.workflowInsights?: boolean`，缺省视为包含（同 `Project.workpad`）。在项目设置中显示开关 **Workflow insights**，说明 “Include this project when workflow insights run.”。关闭后：
- 该项目不再采集、不再定时分析，Insights 页的区块显示已关闭；
- 已有记录与建议保留；
- 手动 Run now 仍可用。

### 2.3 设置界面

在 Settings → AI 分区新增分组 **Workflow insights**，说明文字：“Every few days, a model reads the shell commands agents ran on this project's cards and suggests scripts, tools and rules worth keeping. Off by default: it spends tokens and keeps a log of commands.”

1. 开关 **Workflow insights**。
2. **Model**：Provider / Model 选择，交互与 Summary model 一致；Auto 显示 “Auto (Sonnet 5.5, then Sonnet 5)”。
3. **How often**：选项 Daily / Every 3 days / Weekly / Every 2 weeks，副文案 “Daily needs plenty of tokens; longer periods cost less and still catch repeated work.”
4. **Run after**：整点选择，例如 09:00。
5. 只读行：
   - “Looks at the last N days of commands.”（N 见 §4.1）；
   - 有过运行时显示 “Last run: 168k in · 22k out · $0.80. About $X per month for N projects at this pace.”
     - “in” 取运行结束时上下文里的 token 数。Claude 的 `inputTokens` 只计未缓存的部分，单看会偏小。
     - 每月估算 = 一个周期的费用 × 30 / `intervalDays`。一个周期的费用是**每个仍被包含的项目**最近 30 天内最近一次有费用记录的运行之和（`workflow-insights.overview` 的 `cycleCostUsd` 与 `costProjects`）。2026-10-21 起；之前只用一个项目的一次运行，两个项目每天运行时会少算一半。
     - 没有费用数据时只显示 token。
6. 按钮 **Delete collected commands…**，确认后清空所有项目的命令记录（§3.4），建议保留。

开关从关到开时的提示：“Collecting starts now; the last 7 days are read once from the sessions' history.”（§3.3）

## 3. 命令记录（采集）

### 3.1 来源

- `agent.turn_ended` hook 提供本轮 timeline（`index.server.ts` 已把它交给 workpad 与 summary）。取其中 `type: "tool_call"` 且 `detail.type === "shell"` 的条目，采集在 hook 返回后异步进行，不阻塞 hook。
- 范围：本项目卡片 workspace 中的所有 session（与探针一致）。summarizer session（`flowly=summarizer`（兼容既有旧标签） 标签）不采集：hook 里按需查一次 agent 的标签并缓存。
- 时间：hook 给出的本轮 timeline 条目没有时间戳，记为本轮结束的时间；回填用条目自带的 timestamp。
- 粒度：每次 shell 调用一条记录，id 为 `<agentId>:<callId>`，hook 与回填得到的同一次调用只记一次。
- 列：记录**命令发生时**卡片所在的列，即 hook 执行时的 `task.status`；回填时按流转日志回放取当时的列。
- 已知限制：Claude 的 shell 条目只有 `command` 和 `output`，**没有 `cwd` 与 `exitCode`**，成功与否只看条目 status（completed/failed）。Codex 的 shell 条目格式尚未在真实数据上核对，代码按通用字段处理，缺失字段记为空。

### 3.2 规范化与脱敏（纯函数，`shared/workflow-insights.ts`）

每条命令按顶层的 `&&`、`||`、`;`、`|` 和换行拆分，尊重引号、`$( )` 和 heredoc。每段分类：

- **skip**：`cd`/`pushd`/`popd`；纯环境变量赋值；shell 语法残片，包括 `{ } break continue esac case`、以 `)` 结尾的 case 分支、函数定义、以 `$变量` 开头的命令。探针第一轮出现过 8 种这类假命令，修正后为 0。
- **explore**：只读或探索类命令（ls、cat、head、tail、sed、grep、rg、find、wc、jq……）以及 `git status/diff/log/show/…`。只计数，另外统计被读得最多的文件。
- **action**：其余命令，生成规范化 key：
  - 去掉前置的 `sudo`、`time`、`env`、`nohup`；`git -c`/`-C` 的参数去掉；
  - npm/pnpm/yarn/bun 规范为 `npm run <script>`、`npm test`、`npm install`；`npx tsc` → `npm run typecheck`，`npx vitest` → `npm test`，仅当 package.json 中有对应脚本时才这样合并；
  - `node`/`python3` 规范为 `<runtime> <script 相对路径>`，内联代码记为 `<runtime> <inline>`，临时目录下的脚本记为 `<tmp-script>`；
  - `paseo` 保留前 3 个位置参数，ID 换成 `<id>`；
  - 其它命令保留命令名和最多 2 个位置参数。
- **inline 摘录**：`python3 - <<…`、`node -e` 等内联脚本另外保存一段摘录，经脱敏后截断到 560 字符。这是唯一保存的命令正文，因为 LLM 需要读它才能判断用途。
- **脱敏**（对 key 和摘录都执行，**先脱敏再落盘**）：
  - 仓库路径换成 `.`，home 目录换成 `~`，临时目录换成 `<tmp>`；
  - 邮箱换成 `<email>`；URL 中的凭据换成 `<cred>`；
  - `eyJ…`、`ghp_…`、`sk-…` 以及 ≥40 位的随机串换成 `<secret>`；
  - `*TOKEN*`、`*KEY*`、`*SECRET*`、`*PASSWORD*`、`*AUTH*` 这类变量的赋值，以及 `Authorization: Bearer` 后面的值，换成 `<v>`。
- 命令输出（`output`）一律不保存。

### 3.3 回填

总开关从关到开，或某项目的开关从关到开时，daemon 用 SDK（`agents.list` + `agents.ref(id).timeline.refetch`，只读）回填该项目最近 7 天的记录：
- 并发不超过 2；按 id 去重；
- 失败只记一条警告；
- Insights 区块在回填期间显示 “Reading recent sessions…”。

### 3.4 存储

- 文件：`commands/<projectId>.jsonl`（与 `board.json` 同目录），每行一次 shell 调用：`{ id, at, taskId, agentId, lane, provider, status, actions, explore, files?, inline?, failed? }`。
  - `status`：completed / failed / other。
  - `actions`：各 action 段的规范化 key，按出现顺序。
  - `explore`：探索段的个数；`files`：探索段读过的文件，最多 4 个。
  - `inline`：内联脚本摘录；`failed`：失败调用的脱敏命令，最多 260 字。
- 写入：按项目串行追加；文件无效的行跳过，不重置文件。
- 保留：最近 30 天。每天第一次写入时裁剪，裁剪通过写临时文件后原子替换完成。
- 删除：
  - 永久删除卡片：重写日志，去掉该卡记录，被去掉的行写入 `removed/task-<id>-commands-<time>.jsonl`（同 TASK-DELETE-SPEC）；
  - Remove 项目：整个文件移到 `removed/`；
  - **Delete collected commands…**：删除所有项目的 `commands/*.jsonl`，不留备份，因为这是用户明确要求的隐私操作；
  - 关闭开关只停止采集，不删除已有记录。

## 4. 分析运行

### 4.1 调度

- daemon 每 15 分钟检查一次。项目到期的条件，以下全部满足：
  1. 总开关打开，项目开关不为 false，项目未归档；
  2. 当前本地时间已过 `runHour`；
  3. 距该项目上次运行（成功、跳过或失败都算）的时间 ≥ `intervalDays` 天。比较按本地日期，所以 Daily 每天最多运行一次。
- daemon 停机期间错过的运行，启动后只补跑一次，不补跑多次。
- 全部项目一次只运行一个分析，排队顺序按上次运行时间升序。
- 分析窗口：`windowDays = max(7, intervalDays)`，最多 14 天。
- **安静期跳过**：以下任一情况不调用模型，本次运行记为 skipped，原因 “Not enough new activity”，同样算一次运行（重新计周期）：
  - 自上次运行以来新增的 action 少于 50 条；
  - 窗口内涉及的卡片少于 2 张，且新增 action 少于 200 条。

  2026-10-21 起；之前的门槛是 3 张卡，导致 Agent SMITH（2 张卡、两天 990 条 action）一直没有被分析。
- **Run now**（Insights 区块）：
  - 任何时候都可以手动运行，总开关关闭时也可以，也不受安静期规则限制。
  - 项目还没有命令记录时（比如开关一直没开），先回填最近 7 天再分析；回填后仍然没有命令，记为 skipped（“No commands collected yet.”）。
  - 项目已有运行进行中时，按钮显示 Analyzing…。
- 定时检查遇到下面两种情况时直接跳过，不记录本次运行，也就不会把周期用掉：
  - 项目还没有任何命令记录；
  - 项目正在回填（开关刚打开时，回填完成前的那次检查）。

### 4.2 素材（规则产出，纯函数）

按以下顺序拼接，总长不超过 **150 000 字符**，超出时依次减少 inline 摘录数量和失败命令数量：

1. 概况：窗口、session 数、卡片数、调用数、explore/action/skip 计数。
2. 卡片清单：短 ID（前 8 位）、标题、类型、标签、当前列。
3. 已有配置：项目根 `paseo.json` 的 `scripts`、`worktree` 部分（直接读文件，不需要内部 API）；`package.json` 的 `scripts`；根目录 `AGENTS.md` 或 `CLAUDE.md` 中的 Commands 一节（最多 4000 字）。
4. action key 表（前 60）：运行次数、卡片数、session 数、失败次数、主要所在列。
5. 重复序列：同一 session 内连续且不同的 action key 组成 2–4 元组，按出现的不同 session 数计，取 ≥3 的前 25 个。
6. 被读得最多的文件，前 30。
7. 失败的命令，最多 60 条，每条 260 字符。
8. inline 摘录：按开头 240 字符去重后，**按卡片轮流抽样**（避免集中在少数长 session），最多 280 条。
9. 已关闭的建议：本项目 accepted 的建议，以及 30 天内 dismissed 的建议，每条一行：`状态 · target: 标题 — proposal 前 160 字`，并要求模型不要再提（§5.3）。open 的建议不放进素材，因为本次结果会替换它们。

### 4.3 模型调用

- 与天级总结相同（PROJECT-INSIGHTS-SPEC §7）：
  - 在项目的「Flowly background」workspace 创建临时 session（用前恢复/复用，用完归档，从不用卡片 workspace；[BACKGROUND-WORKSPACE-SPEC](BACKGROUND-WORKSPACE-SPEC.md)）；
  - 标签 `flowly=summarizer`（兼容既有旧标签）、`flowly-project=<id>`、`flowly-insight=workflow`；
  - `waitForFinish(900000)`（15 分钟）；结束后在 `finally` 中**硬删除**该 session（`daemonRemoveAgent`，同 AGENTS.md 2026-10-22 例外，2026-10-23 扩大到本 run；只删本次刚创建的 id，删除失败回退归档并记日志）。
- prompt（英文，agent-facing）要点：
  - 可选的五类目标：`paseo_script`、`worktree_setup`、`repo_tool`、`agents_md`、`skill`；
  - 每条结论都要引用卡片短 ID 和次数；不推荐已存在的东西，除非组合起来能省事；git 写操作和一次性探索不做成脚本；重点解读内联脚本的用途；最多 8 条；如实标注置信度；
  - 列出的已 accepted 或 dismissed 的建议不要再提，换说法或收窄范围也不行；本次结果会替换之前运行留下的 open 建议，所以要列出所有仍值得做的事，而不只是新发现；
  `{ findings: [{ target, title, evidence, proposal, benefit, confidence: "high"|"medium"|"low", cards: string[] }], noise, verdict }`。
  同时以 `outputSchema` 传入，但 **Claude 不强制执行它**：探针返回的是 markdown。
- 解析：用 `firstObject` 取 JSON，兼容代码块和字符串数组。取不到时在同一 session 追加一条消息 “Reply again with only the JSON object described above.”，重试一次；仍失败则本次运行记为错误 “The workflow insights model returned no JSON.”。
- 记录 `lastUsage`（输入、缓存、输出 token，以及 provider 给出的费用）。

### 4.4 校验（daemon，不信任模型的计数与 ID）

- `cards` 中的短 ID 必须能对应到本项目、本窗口内有记录的卡片，对不上的丢弃。有效卡片少于 2 张的建议丢弃；窗口里只有 1 张卡时，引用这 1 张即可。
- 与 accepted 或 30 天内 dismissed 的建议重复的丢弃：指纹（target + 规范化标题）相同，或标题相似（同一 target 且相似度 ≥ 0.6，或任意 target 且相似度 ≥ 0.7；相似度是标题的 Jaccard 系数，英文按词计，中日韩文字按相邻两字计）。open 建议不参与比较，它们会被替换（§5.3）。
- 同一次运行内的建议之间也做同样的比较，避免出现两条相同的。
- 每个字段限长：title 120，evidence 1000，proposal 4000，benefit 500；超长的建议丢弃，不截断。
- 最多保留 8 条。全部被丢弃时本次运行记为 ok，结果为 “No suggestions this time”，之前的 open 建议保留（§5.3）。
- 以上在写入 `workflow-insights.json` 的同一次串行写里，按写入那一刻的建议状态计算，所以运行期间用户刚忽略的建议不会被重新加回来。

## 5. 建议与落地

### 5.1 数据

文件 `workflow-insights.json`，串行写，写前备份，原子替换；文件无效时保留原文件并报错。结构：

```
{ version: 1,
  runs: [{ id, projectId, at, from, to, model, status: "ok"|"skipped"|"error", reason?, usage?,
           findings, replaced, stats: { calls, actions, cards, sessions } }],
  findings: [{ id, projectId, runId, fingerprint, target, title, evidence, proposal, benefit, confidence, cards[],
               status: "open"|"accepted"|"dismissed", acceptedTaskId?, createdAt, updatedAt }],
  revision }
```

- 每个项目保留最近 20 次运行。accepted 和 dismissed 的建议保留 90 天，open 的一直保留。
- Remove 项目时先备份到 `removed/` 再删除。永久删除卡片时，指向该卡的 `acceptedTaskId` 清空，建议本身保留，状态仍为 accepted。

### 5.2 Insights 页区块

在 Insights 页 Summary 之后、Token use 之前，新增区块 **Workflow insights**，桌面与紧凑布局都显示：

- 页头：“Last run · 日期 · 模型 · 窗口 N days”，附 token 和费用；有运行进行中时显示 “Analyzing…”；回填中显示 “Reading recent sessions…”；还有 **Run now** 和齿轮按钮（打开 Settings → AI）。
- 关闭状态：显示一行说明和 **Turn on** 按钮，打开设置分组；不显示空列表。
- 跳过或出错：弱化显示原因一行，例如 “Skipped: not enough new activity”，或错误信息。
- 建议卡片，按 confidence 再按 createdAt 排序。每张显示：
  - target chip：paseo.json script / Worktree setup / Repo tool / AGENTS.md / Skill；
  - 标题、依据（可点击的卡片引用，打开卡片侧栏）、收益；
  - proposal 默认收起，展开后以等宽字体显示；
  - AI 星星标记（AI-MARK-SPEC）。
- 操作：
  - **Create card**：打开 New task 表单并预填：
    - 标题；
    - 描述：proposal、收益、依据、引用卡片的标题，加上落地说明；
    - 类型 `chore`；
    - 标签 `agent-workflow`，paseo.json 与 worktree setup 两类再加 `paseo-json`。

    `tasks.create` 新增可选的 `insightFindingId`，分两步处理：
    1. 建 workspace 之前，先检查这条建议仍是 open，否则整笔失败；
    2. 卡片写入之后，把建议标为 accepted，并记下 `acceptedTaskId`。

    建议存在 `workflow-insights.json`，不在 `board.json` 里，所以这两步不在同一次写入中。第二步失败时，卡片照常建好，建议保持 open，并记录日志。同一 operationId 重放时不再检查，只补标 accepted。
  - **Dismiss** / **Restore**。
  - 已 accepted 的建议显示 “Card created”，点击打开那张卡片。
- 落地说明：随 target 自动附在描述末尾，给接手卡片的 agent 看。
  - `paseo_script` / `worktree_setup`：“Add it to paseo.json at the project root, run it once with `paseo script start <name>` (or create a worktree to test setup), and commit: worktree setup only reads the committed paseo.json.”
  - `repo_tool`：“Add the tool, mention it in AGENTS.md Commands, and replace one real use to prove it works.”
  - `agents_md` / `skill`：“Write it, then check it against the cited cards.”
- 数据读取：只在 Insights 页打开时查询，带 etag。页面关闭后不轮询。运行进行中时每 10 秒查询一次。

### 5.3 每次运行替换 open 建议

用户决定（2026-10-21）：建议不累积，新一次运行的结果覆盖旧的。

- **替换**：一次 ok 的运行只要得到至少 1 条有效建议，就删除本项目所有 open 建议，换成这次的结果。`runs[].replaced` 记录删除了多少条。
- **不清空**：一条有效建议都没有时（模型没给出，或全部被校验丢弃），之前的 open 建议保留，避免一次失败的回复把列表清空。skipped 和 error 的运行不动建议。
- **保留**：accepted（已建卡，带 `acceptedTaskId`）和 dismissed 的建议不受替换影响。
- **冷却**：dismissed 的建议 30 天内不会再出现（§4.4），之后可以作为新建议再提；accepted 的不会再出现。二者以“状态 · target: 标题 — proposal”写进素材，让模型不要再提。
- **代价**：模型每次的结果有波动。某条仍然有用、但这次没被提到的建议会消失，要等它下次再被提出来；想留住它就趁它还在时建卡。周期越长（例如每周），这个波动越少。
- **为什么**：之前试过让模型标注 `updates`/`merges` 刷新已有建议，以及要求新建议写出与最接近建议的不同（PR #8、#10）。重复确实减少了，但机制复杂，模型仍会把收窄版当新建议。替换的做法简单，而且列表永远只反映最近一次分析。
- **兼容**：旧数据里的 `seen`、`lastSeenAt`、`refreshed`、`merged` 字段读取时忽略。下一次有结果的运行会替换掉旧的 open 建议，包括之前累积的重复。

### 5.4 让 agent 用上已有脚本

卡片 session 的上下文文件（`tools.sessionContext`）和 `flowly_get_task` 新增字段 `projectScripts`：
- 内容：项目根 `paseo.json` 中 scripts 的名字和 type，最多 20 个，**不含 command 正文**；
- skill（两份副本）补一句：“When projectScripts lists a script for what you are about to do, run it with `paseo script start <name>` instead of retyping the commands.”
- 此项与总开关无关：只要项目有 `paseo.json` 就提供。没有该文件时不出现这个字段。

## 6. RPC

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `workflow-insights.get` | `{ projectId, etag? }` | `{ etag, value? }`；value = `{ enabled, projectEnabled, backfilling, running, nextRunAt \| null, windowDays, lastRun \| null, findings[], revision }` |
| `workflow-insights.run` | `{ projectId }` | `{ queued: true }`，已在运行时返回 `{ queued: false }` |
| `workflow-insights.set-status` | `{ projectId, findingId, status: "open"\|"dismissed", expectedRevision }` | `{ revision }`；revision 不匹配时报错 `REVISION_CONFLICT: …`；已建卡的建议不能再改 |
| `workflow-insights.overview` | `{}` | `{ lastRun \| null, collected }`，用于设置页的费用行和已收集的项目数 |
| `workflow-insights.purge` | `{}` | `{ deletedProjects }` |
| `tasks.create`（既有） | 新增可选 `insightFindingId` | 不变；建议不存在、不属于本项目或不是 open 状态时整笔写入失败 |

所有输入用 zod 校验；daemon 错误信息用英文。

## 7. 隐私与安全

- 只采集 shell 命令。命令输出和其它工具调用的内容（文件读写、编辑）不采集。
- 落盘之前先脱敏（§3.2）；日志中不出现 token、凭据或完整命令正文。
- 发给模型的素材就是这些脱敏后的记录。模型用的是用户自己配置的 provider，与写这些命令的 agent 同属一套账户体系。
- 没有新增内部 API：读 `paseo.json` 是读普通文件；timeline 的读取与 session 的创建用插件 SDK（`PaseoApi`）。
- 建议不会自动执行任何东西，也不会自动建卡或修改文件。建卡需要用户点 Create card。

## 8. Onboarding、文案与文档

- 欢迎页特色列表在 *Project insights* 之后新增一行 *Workflow insights*：“Optional: on a schedule you choose, a model reads the commands agents ran and suggests scripts, tools and rules worth keeping.”
- 新提示 `first-workflow-insight`：
  - 显示条件：功能已打开，当前项目有 open 的建议，且没有打开 Insights 或 Ideas 页。看板只在这条提示还没看过时，为当前项目读一次建议，不轮询；
  - 文案：“Workflow insights found repeated work worth keeping. Open Insights to turn a suggestion into a card.”；
  - 优先级排在 `first-idea` 之后、`first-artifact` 之前。
  - 功能默认关闭，新用户要等打开功能、产生了建议才会看到，这是有意的；功能本身由设置分组和欢迎页那一句介绍。
- ONBOARDING-SPEC 的提示表、README（两份）的功能亮点、SPEC-OUTLINE、PROGRESS 同步更新。
- 所有新文案用 `t()` 并加入全部语言目录（约 35 条）。agent 面向的文本（prompt、落地说明、skill）保持英文。

## 9. 不在范围内

- 直接写入 `paseo.json`：需要 `writeProjectConfig` 这个内部 API。由卡片的 agent 修改并提交，验证也一并完成。
- 自动建卡或自动应用建议；跨项目汇总；按人统计。
- 卡片上的 setup 状态显示、scripts 面板（本卡第一轮调研中的候选，另行立项）。
- 非 shell 工具调用的模式分析，比如同一类 Read/Edit 序列、MCP 调用顺序。可以以后再扩展。

## 10. 验收

单元测试：
- 拆分与分类：用探针中出现过的形态做用例，包括 heredoc、case 分支、函数定义、`git -c`、`$VAR` 命令、引号内的分隔符。
- 规范化，包括 npx 合并的条件；脱敏的各条规则，用例中要包含真实 token 的形态。
- 记录的 id 去重、30 天裁剪、删卡重写、项目移除。
- 调度：intervalDays × runHour × 时区；跨天；停机后只补跑一次；同一时刻只有一个运行。
- 安静期跳过；素材预算裁剪与按卡片轮流抽样。
- 解析：纯 JSON、代码块、markdown 中夹带 JSON、无 JSON 时的重试、仍失败的错误。
- 校验：无效卡片 ID、少于 2 张卡（窗口只有 1 张卡时除外）、超长字段、重复指纹、dismissed 冷却。
- 替换（2026-10-21）：open 建议不阻止新建议；accepted 与冷却期内 dismissed 的建议不会回来（跨语言改写也拦住，通用词不误判）；同一次运行内去重；`replaceOpen` 只删本项目 open 建议；daemon 测试里第二次运行替换 open、保留 accepted/dismissed，没有有效建议时保留旧列表。
- 一个周期的费用按项目求和；两张卡的忙碌项目在定时运行中会被分析。
- 建卡时原子 accept 与错误回滚；设置缺字段时的默认值。
- 提示规则（`client/onboarding-logic.test.ts`）；i18n 完整性。

检查与实测：
- typecheck，全量 `npm test`，reload 本插件。
- 在 Flowly 项目上手动 Run now（`claude/claude-sonnet-5`），与 2026-10-19 探针的 6 条结论对照：至少覆盖 i18n 和 Playwright 两条高置信度建议；确认临时 session 已归档；记录 token 和费用。
- 用显式 full-access 的 `codex/gpt-6-luna` 测试 session，在 fixture 项目（或 Tinylink，只清理测试自己创建的东西）上检查：
  - 设置分组的各项与保存；项目开关；
  - Insights 区块的关闭、跳过、错误、建议列表、Create card、Dismiss/Restore；
  - 桌面与紧凑布局；
  - 回填与 Delete collected commands。
- 证据保存到 `docs/verification/workflow-insights.md`。未实际运行的项一律记为 UNRUN。

## 11. 我做的决定（可以推翻）

1. **默认关闭**，周期默认 **Weekly**，整点默认 09:00。
2. **Auto 模型用 Sonnet**（5.5 → 5），而不是摘要用的便宜模型；不可用时才退回 Summary model。
3. **窗口至少 7 天**，所以 Daily 是“每天看最近 7 天”。每次运行替换 open 建议（§5.3，2026-10-21 用户决定），不会每天累积相同的建议。
4. **安静期跳过**（新增 action 少于 50 条，或少于 2 张卡且新增 action 少于 200 条；2026-10-21 由“少于 3 张卡”放宽，用户确认），省下没有新信息时的 token。手动 Run now 不受此限制。
5. **只有开关打开才采集**，打开时回填 7 天；关闭不删数据，另设删除按钮。
6. 建议放在 **Insights 页**，不进 Ideas 收件箱。Ideas 挂在某张来源卡上，而这里的建议是项目级的。
7. `projectScripts` 写进 session 上下文，**与开关无关**：建议落地之后，agent 要能知道有这些脚本。

## 12. Agent habits：next moves 与 ideas 的使用率

状态：**已实现，待用户验收**（2026-10-20，卡片 `5aaa5b01` “Insights: next-move and idea rates per session and model”；用户在评估后确认下面的调整）。

### 12.1 目的与依据

2026-10-19 在 Flowly 项目的 flow log 里有 57 次 `next_moves_suggested`（落在 56 个 turn；其中 47 个是交付或结果的 turn，这类 turn 共 77 个）和 7 条 `idea_proposed`（74 次交付）。2026-10-20 到 10:50 为止，12 次交付里只有 1 次带 next moves（全天共 5 次调用），ideas 4 条。没有任何界面提示，是用户发现输入框上方的 chip 不见了才注意到。同一块数据还显示规则对不同会话的约束力不同：窗口内交付 ≥10 次的三个 session，一个 0 次 next moves，一个 2 次，一个 6 次。本节把这件事变成每天可见的数字，让改规则（skill 措辞、交付时提醒）有数据可比。

**数据源必须是 flow log，不是 `board.json`**：看板每张卡只保留最近 100 条事件（`BoardStore.event`），所以从 `board.json` 数事件会少数。2026-10-20 评估时用 `board.json` 数出的 “10-19 共 65 次 next moves” 就是这样偏低的：flow log（不裁剪）里 10-19 全部四个项目共 79 次，Flowly 一个项目 57 次。

### 12.2 与本文其余部分的关系（偏离卡片原文的两处）

- **不受 Workflow insights 开关控制**。本节只是规则统计：不调用模型、不花 token、不采集新的内容，读取的就是已有的 flow log。要做到“一天内发现”，它必须对所有人默认可见；放进默认关闭的 Workflow insights 区块就看不到。所以代码在新文件 `shared/agent-habits.ts`，不放进 `shared/workflow-insights.ts`（那是另一个尚未验收的功能，混在一起会让两件事无法分开提交）。Insights 页上它是独立的区块，不属于 Workflow insights。
- **分母不含 question**。skill 规定提问走 `kind=question`，“not next moves”，所以把提问算进 next moves 的分母会把比率结构性压低。question 的 turn 单独列出。2026-10-20 起 agent 优先用自带提问工具提问（SESSION-QUESTION-SPEC §2.2），这种提问不产生 `kind=question` 事件，所以 question turn 数只统计回退方式的提问。

### 12.3 口径

数据源是项目的 flow log（`flow/<projectId>.jsonl`，每个看板事件，不裁剪，卡片被删除后用量仍保留）。只看 `actor=agent` 的事件和 `system` 的 turn 边界；时间切天用 Insights 的时区（`dayKey`）。

- **turn**：同一 `agentId` 从 `agent.turn_started` 到下一次 `turn_started` 或它自己的 `agent.turn_ended`。session 的事件归入它最近的一个 turn（进行中或刚结束的）；没有任何 turn 的事件（日志从 turn 中间开始）自成一个以该事件时间为准的 turn。turn 的日期取它最后一个事件的日期。
- **交付类型**（一个 turn 只算一次，按优先级）：
  1. `delivery`：agent 把卡片 `status_changed` 到 `in_review`；
  2. `result`：没有交付，但有 `reportKind=result` 的汇报；
  3. `question`：以上都没有，但有 `reportKind=question` 的汇报。
  - **分母 `base` = delivery + result**。
- **next moves**：turn 内至少一次 `next_moves_suggested`（同一 turn 的后一次覆盖前一次，所以按 turn 计一次，不按事件计）。
  - 比率 = `base` 中带 next moves 的 turn / `base`（字段 `moves` / `deliveries + results`）；
  - `movesAny` 是全部带 next moves 的 turn（含 base 之外的），只用于核对事件数，不进比率。
- **ideas**：`idea_proposed` 事件数；“每次交付的 ideas” = ideas / `deliveries`（只算 in_review 交付）；没有交付时不显示比率。idea 的数量取自 agent 所有 turn，不只交付 turn，因为 skill 说的是“通常在交付时”。
- **显式“没有下一步”（`none`）**：`next_moves_suggested` 的 `moves` 为空列表（NEXT-MOVES-SPEC §8 的 `nextMoves: []`）。flow log 里记为 `offered: 0`。
  - turn 里以**最后一次** next-moves 调用为准：最后一次非空算 `moves`，为空算 `none`（先建议后改成 none，或反之，都按最后一次）；
  - `none` 只统计 base（交付 + 结果）里的 turn，单列，不进 `moves`，也不改分母；
  - 一个 `none` 的 turn 没有可采纳的建议，不进 picked 的 `offered`；
  - 它算“用了这个工具”：下面的标记不会因为模型一直声明 none 而报“没有 next moves”。`none` 的汇总数显示在模型行里，让“一直说没有”也看得见。
- **picked（用户采纳）**：每次 turn 结束时没被覆盖的那一组 next moves 叫一个 *set*（挂在提出它的 turn 上，日期和模型也归那个 turn）。set 被 *回答* 时有结果：
  - 同一 session 的下一个 turn 开始（用户发了消息）：结果取自那个 turn 的 `agent.turn_ended` 上的 `pick`（§12.4）：`≥0` 是采纳了第几条，`-1` 是回答了但没采纳，缺失是未知（旧数据，或钩子没拿到消息），**未知不进比率**；
  - 该卡片被人移到 Done，且 set 里有 `moveTo:"done"` 的建议：算采纳。**局限**：点“移至 Done”和手动拖到 Done 走同一条路径、事件完全相同，无法区分，所以这里的“采纳”包含手动拖动（界面文案不写“点按”）；
  - 没有被回答的 set（会话从此无人回复、卡片被收尾）不进比率。
  - 比率 = `picked / offered`，`offered` 是有明确结果的 set 数。
- **分组**：
  - 日：最近 7 天（到所选日期止，同 Last 7 days）；
  - 项目合计：窗口内所有 turn；
  - 模型：turn 上的 `model`（`provider/model`）。没有时按 §12.5 补；仍然未知归入 “Unknown model”；
  - session：`agentId`，只用于标记（§12.6），用卡片标题和模型显示。
- **标记**：窗口内一个模型或 session，满足下列任一条就标出来。
  - `deliveries + results ≥ 10` 且 `moves = 0` 且 `none = 0`：“没有 next moves”（既没建议、也没声明过 none，也就是根本没用这个工具）；
  - `deliveries ≥ 10` 且 `ideas = 0`：“没有 ideas”。
  - 阈值 `FLAG_MIN = 10`。ideas 本来就可以为 0（skill：没有值得提的就不提），所以这一条只是提示，不是错误。

### 12.4 数据变化（都是可选字段，旧数据不用迁移）

- `agent.turn_ended` 事件（`BoardEvent` 与 flow log）新增：
  - `model`：session 在这个 turn 结束时的 `provider/model`，取自 `paseo.agents.ref(id).refresh()` 的 `runtimeInfo.model`（缺失用 `model`）；拿不到就不写。钩子里 `PluginHookAgent` 只有 `provider`，没有 model；session 中途可以换模型（timeline 有 `model_changed`），所以按 turn 记，而不是按 session 记；
  - `pick`：整数。**只在这个 turn 开始时该 session 有未过期的 next moves 时写**（`openNextMoves` 取 turn 开始之前的那一组）。取 turn timeline 里的 `user_message` 文本，与这一组每条消息型建议的 `prompt` 比较（`matchPick`）：返回采纳的下标，没有匹配返回 `-1`；没有消息文本时不写。
- `matchPick`：文本去掉多余空白后比较。消息等于 prompt，或 prompt 不少于 12 个字符且消息包含它（点选后在已有输入后追加，见 NEXT-MOVES-SPEC §4），算采纳；否则取 prompt 的字符三元组被消息覆盖的比例，≥0.8 算采纳（用户改了几个字再发送）；多条同时匹配取覆盖比例最高、再取下标小的。没有 `prompt` 的动作建议不参与。
- `next_moves_suggested` 在 flow log 里新增 `offered`（建议条数，空列表为 0）与 `offersDone`（含 `moveTo:"done"`）：flow log 不保存 `moves`，也不保存 `note`，所以“显式 none”只能靠 `offered: 0` 区分。旧条目没有这两个字段，服务端读取时用 board 上同 id 事件补上；board 每张卡只保留最近 100 条事件，被裁掉的旧条目补不上，视为有建议、不含 Done 建议（那时还不存在 none）。
- 写入点：`recordLifecycle` 增加可选的 `model` / `pick`；`index.server.ts` 的 `agent.turn_ended` 钩子在 `store.mutate` 之前取 model（异步），在 mutate 内同步算 `pick`。取不到 model 或消息只是少一个字段，不影响钩子的其他工作。

### 12.5 历史 turn 的模型

没有 `model` 字段的 turn（本功能上线前的全部历史）：服务端在窗口内存在这样的 turn 时才调用一次 `agents.list({ includeArchived: true })`，用 session 当前的 `provider/model` 补上；列表里找不到的（已被清理）归入 “Unknown model”。**已知偏差**：中途换过模型的历史 session 会被算到它当前的模型上。上线 7 天后窗口内不再有这样的 turn，这个调用也随之消失。

### 12.6 视图与界面

- `ProjectInsights`（`insights.project`）新增 `habits`，不新增 RPC，沿用现有的 etag 读取：
  `{ days: [{ day, ...counts }] (7 天), total: counts, models: [{ model, ...counts }] (按 base 降序), flags: [{ kind: "model"|"session", miss: "moves"|"ideas", model, n, agentId?, taskId? }] }`，其中 `counts = { deliveries, results, questions, moves, none, movesAny, ideas, offered, picked }`。
- Insights 页新增区块 **Agent habits**，放在 Workflow insights 之后、Token use 之前，桌面与紧凑布局都显示：
  - 标题行右侧是窗口合计：“Next moves 54/69 · Ideas 13”；
  - 一排 7 天：每天一列，显示星期、next moves 比率（`moves/base`，无交付显示 “–”）和 ideas 数，比率低于该窗口平均的一半用警示色；
  - 每个模型一行：模型名、`moves/base`、ideas、`picked/offered`；
  - 标记行：“{model} made no next moves in {n} deliveries (7 days)” / “… no ideas …”，session 用 “{card title} · {model}”，点按打开卡片；
  - 窗口内没有任何交付或汇报时整块显示一行 “No deliveries in these 7 days.”。
- 无设置项，无新手引导提示（这是诊断行，不是需要宣传的功能，也不应对所有用户弹一次提示）；README 的 Insights 亮点补半句。新文案加入全部 9 个语言目录。

### 12.7 不在范围内

- 明确的 “none” 声明与它的计数（见 12.3）；
- 比率下降时的推送或 Attention 项：先看数据和行里的标记；
- 按人统计；跨项目汇总；
- 修改 next moves / ideas 的规则本身（卡片 `Sidebar UI/UX 调整` 上的两个相关 idea）。

### 12.8 验收

单元测试（`shared/agent-habits.test.ts`）：
- turn 边界：turn 内的事件归该 turn；`turn_ended` 之后到下一次 `turn_started` 之前的 agent 事件归刚结束的 turn；没有 `turn_started` 的事件自成一个 turn；同一 turn 两次 next moves 只计一次；一个 turn 同时有交付和 result 只算 delivery；
- 分母：question 不进 base；单独计数；ideas 每次交付；
- 日期与时区：turn 跨午夜按最后一个事件；`tz` 影响切天；
- 分组：按模型、缺失 model 时用回退函数、仍未知的归 Unknown；
- 显式 none：最后一次调用决定；只算 base；不进 offered；不触发 “没有 next moves” 标记；旧条目没有 `offered` 时按有建议处理；
- picked：整句、追加在已有输入后、改了几个字、短 prompt 只认全等、多条取最接近、只有动作建议、未知不进比率、Done 采纳、未回答不计、覆盖的 set 不计；`turnPick` 取 turn 开始前的那一组；
- 标记：恰好 10 次且 0；9 次不标；有 1 次不标；ideas 同理；
- flow log：`flowEntry` 保留 `model`、`pick`（含 0）、`offered`、`offersDone`。

服务端：`recordLifecycle` 写入 `model` / `pick`；`analyze` 带 `habits`；旧 flow 条目用 board 补 `offersDone`。

实测：冻结 flow log 与 `board.json` 的一份副本，用独立脚本（`docs/verification/fixtures/agent-habits/handcount.mjs`，不引用 `shared/agent-habits.ts`）按日、按 session 手工计数，与计数器逐项对照（`compare.test.ts`，设 `HABITS_FROZEN_DIR` 才运行）；多组日期与时区都要一致。差异与原因写进 `docs/verification/agent-habits.md`，其中包括卡片里示例数字（10-19 为 65 次 next moves / 11 条 ideas，10-20 为 1 / 0）与当前数据不符的原因：65 是 `board.json` 里还留着的 next moves 事件数（被每卡 100 条的上限裁过），不是当天的实际数；11 条 ideas 与 flow log（全部项目）一致；10-20 的 1 / 0 是当天早些时候的数，之后又有调用。UI 在运行中的 Paseo 上目视检查；没有桌面窗口控制工具时记为 UNRUN。
