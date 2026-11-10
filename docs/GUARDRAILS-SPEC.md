# 项目护栏：学、防、查、看的闭环（GUARDRAILS-SPEC）

状态：**设计，用户 2026-10-28 批准，待实现**。卡片 `2458cff4`（重新设计 memory、insights、auto review）。本文把项目记忆（PROJECT-MEMORY-SPEC）、卡片 Workpad（WORKPAD-SPEC）、交付自动验收（AUTO-REVIEW-SPEC）和 Insights 的建议部分（INSIGHTS-REDESIGN-SPEC、WORKFLOW-INSIGHTS-SPEC）改成一条线。被取代的小节见 §12。

前提：Auto Review 卡（`4286f00a`）的 `feat/auto-review`（`5cbb9bc`，P1–P3）是本文的基础；实现分支 `feat/guardrails` 从它分出，最终一个 PR 进 main 同时带上两者（§13）。P4 不再单独做。

## 0. 用户的决定（2026-10-28）

| # | 问题 | 决定 |
| --- | --- | --- |
| D1 | Auto review 对新项目默认开 | 开。老项目升级时不自动开，What's new 给按钮。推翻 AGENTS.md 里 2026-10-27 例外的 “Off by default” 与 AUTO-REVIEW-SPEC D14 |
| D2 | 记忆写入即生效，允许自动退休 | 是。推翻 PROJECT-MEMORY-SPEC “人确认才生效”“active 从不自动淘汰”（§1.2、§5.2、§6.5） |
| D3 | workpad 只留验收清单，agent 不再自报 pass/fail | 是。推翻 WORKPAD-SPEC §2.1 的验证项、§5 的新鲜度与软门槛、AUTO-REVIEW-SPEC §4.1 的 L1 |
| D4 | 纠正第一次只管本卡，第二张卡再出现才升项目准则 | 是 |
| D5 | 与 Auto Review 卡衔接 | 先合入 5cbb9bc，本卡在其上实现 |
| D6 | 准则范围 | 跟着证据走：范围等于它来自的卡的形状之并，只扩不缩（§4.3） |
| D7 | 淘汰 | 只用退卡、不退、移到 Done 三个信号自动做，没有“不算问题”按钮，删除永远不是必需的（§6.6） |
| D8 | 命令检查的更新 | 每周重识别加使用证据，新命令先观察 3 次评审（§4.5） |
| D9 | Insights 与 workpad | 一份账两个视图：workpad 是卡的账，Insights 是项目的账（§7） |
| D10（2026-10-29 试用后） | Memory 保留原名和独立入口，不并入 Guardrails 页 | 是。备忘和护栏关联不大，强行合并不合理；数据仍存在 guardrails.json（kind `note`），只是入口、页面和文案分开。Guardrails 页只剩 Commands、Guidelines |

已有的决定仍然有效：AUTO-REVIEW-SPEC D1–D6、D9、D12（评审的尺子是用户的话，不是 agent 的自报）、D17。

### 0.1 实现者检查后的补充决定（2026-10-28，本文作者的判断，可推翻）

一个没参与讨论的 session 以实现者身份读了本文，提出 7 个会影响实现的问题。都不需要用户拍板，这里记下答案，正文已按此改写：

| # | 问题 | 决定 |
| --- | --- | --- |
| B1 | `fail` 必须引用 diff 里的文件，那“漏做了”和“某个目录缺词条”永远判不出来 | 证据分三种，任一即可：diff 里的文件；仓库里存在的文件（缺漏发生的地方）；卡片或用户原话的引用（没做到的要求）。完全没有证据的 `fail` 才降为 `na`（§6.3） |
| B2 | 归纳输入只给范围内的 active 准则，范围扩大和复活没法发生 | 输入列出本项目全部未删除的准则（含范围外、暂停、归档），标状态与范围；60 行上限按优先级截断（§4.2） |
| B3 | 新项目默认开，命令在哪一步勾选；导览开关要存在哪 | 不再勾选：项目创建或开关打开时识别到的命令直接以 `observing` 加入，表单只显示识别结果，不满意去 Guardrails 页删。导览第 2 页不加开关，只有一句介绍和成本；不新增 host 设置（§4.5、§8、§10） |
| B4 | 项目级 Project.memory 开关去留；host 的 Guardrails 关闭后准则还参不参与评审 | 项目开关保留，改名 Guardrails；host 或项目任一关闭时：不学、不注入、不复盘，准则与专属项不参与评审，命令和内置检查照跑（§6.3、§8） |
| B5 | 迁移放 P1 还是 P2；各期之间会不会发版 | 三期合在 1.8.0 一起发，迁移只有一次；P1 不再声称可独立发布（§3.6、§13） |
| B6 | 返工回合只认 A1，关了自动状态的项目就不学 | 改为与记忆线索 `feedback` 同一事实：回合由用户自己的消息开始，且开始时卡片在 In review；不依赖 A1/A1r，归纳本身负责把“提交并推送”判为 `none`（§4.1） |
| B7 | 争议怎么跨轮保存 | 存在 `task.disputes`，随卡保留到 Done/Cancelled；之后各轮该项直接记 `disputed`，不再引用、不再判 fail（§6.1、§6.6） |

### 0.2 实现中记下的偏差（阶段 A，2026-10-28，已接受）

- `counts.usedBy` 存 `{ taskId, at }[]`（一小时节流和“被几张卡用过”都要时间）；另有 `lastMissedAt`、`misfireAt[]`（最近 10 条）、`unavailableRun`，§6.7 的三条规则靠它们计算。
- 备忘保留旧的 `source { taskId, agentId, eventId }`，`flowly_remember` 据此幂等；复盘的依据放在 `sources[0].quote`。
- `flowly_remember` 每卡最多 5 条（`MEMORY_LIMIT`），因为备忘现在写入即生效。
- pinned 备忘不被挤出、不因 90 天没用归档。
- 大小未知视为在范围内（同类型未知）；升级时范围取已知类型与大小之并，都未知为 `all`。
- 迁移的 LLM 规则：`text` 取 prompt 前 200 字，更长的全文进 `body`；`off` 的命令规则也迁为 paused。
- `guardrails.detect` 返回 `{ found, added }`，只加识别时默认勾选的脚本（build、e2e 不加）；`guardrails.counts` 返回 `{ observing, added }`，`added` 为近 7 天学到的准则数。
- 没有 memory.json 也没有任何 autoReview 时不写迁移文件，第一次写入时才出现。迁移失败（memory.json 读不出或不合 schema、看板读失败）时库只读：读返回空，写入抛错并记日志，不创建 guardrails.json，下次 daemon 启动再试；原 memory.json 留在磁盘上（2026-10-29 按 PR #75 的 CodeRabbit 意见改，之前是“按空运行、第一次写入创建文件、不再重试”，那样一次失败就把旧数据永久丢在一边）。

### 0.3 实现中记下的偏差（阶段 B、C 与合并，2026-10-28，已接受）

- 评审记录里没有 `tokens`：SDK 的评审结果不带用量，Workpad 的 Review 组只显示状态、轮次、模型（§6.4、§7.1 中的“tokens”不实现）。
- 被质疑的内置目标项与卡片专属项没有条目可记 misfire，`insights.guardrails.misfires` 只统计准则与命令的误判；§3.4 “发现新命令但已到上限”的 Insights 提示没有通道，不做。
- 旧 skill 的会话向 `flowly_update_workpad` 发 `validation`/`confusions` 时返回 `WORKPAD_INVALID` 并说明只收 `acceptance`；旧版 workpad 记录读取时丢掉这些字段，不迁移。
- `autoReviewRuns(project)` 只看项目开关；旧的 `reviewSetup` 卡片、`reviewDraft`、`memory.*` RPC、`reviews.detect-commands|analyze-history|analysis-status|apply-draft|discard-draft|setup-card`、`insights.add-review-check|pause-review-check|dismiss-review-nudge`、`workpads.resolve-confusion|refresh` 全部删除；存过的 `review_rule`/`review_pause` 建议读取时丢弃。
- 评审在第 2 轮起用 `git diff <上一轮 sha>` 做增量；上一轮通过且这一轮没给结论的项沿用通过。
- 新项目与“编辑项目”的 Auto review 只有开关、成本一句和 Max rework rounds；客户端不调用 `guardrails.detect`，由 daemon 在创建项目和保存开关时识别命令（取消表单不留副作用）。
- What's new 1.8.0 带“Turn on for this project”按钮，打开当前项目的 Auto review 设置；已有项目的 Auto review 保持关闭，新项目默认开、2 轮。

## 1. 目的

### 1.1 本机数据（Flowly 项目流转日志，2026-10-14 至 10-28）

| 事实 | 数字 |
| --- | --- |
| agent 交付次数 / 卡片 | 461 / 104 |
| 交付后用户回复的中位时间 | 2.3 分钟 |
| 交付后用户的回复是返工指令（排除被 A1r 还原的回合） | 310 次，67% |
| workpad 被 agent 更新 / 被人勾选 | 736 次 / 7 次；72 份里 1 份被人点过 |
| 最后一次交付带未完成项的 workpad | 45 / 71，多数是过期 pass 和 unrun |
| 验证项自报状态 | 321 pass · 39 unrun · 4 fail |
| workpad 里最常见的命令 | typecheck、npm test、vitest、plugin reload，每张卡都一样 |
| 记忆候选被确认 | agent 提的 12/18，Done 复盘提的 5/14，12 条积压 |
| 采集到的用户原话 | 380 条，只用作复盘输入 |
| Skills 运行 / 建议采纳 | 53 次运行 30 次跳过；13 条建议采纳 2 条 |

结论：In review 实际是“等你看一眼”，不是验收；workpad 是 agent 的独白，门槛靠它自己确认放行；记忆的瓶颈是收件箱；最值钱的材料是用户退卡时说的话，它现在最没被用上。

### 1.2 一句话

**你退卡时说的话变成这个项目的护栏；agent 交付时 Flowly 先按护栏查一遍；查过了才叫你；查出的新问题再长成护栏。** 学、防、查、看是同一份数据的四个面。

### 1.3 目标、不做、反目标

目标：
- 交付先过机器，再到人。人只在通过后、agent 提问、权限请求和到达返工上限时被叫。
- 护栏从真实的退卡长出来，不需要人写规则、确认候选或清理列表。
- 库有界：范围跟证据走，退出靠计数，上限靠挤出。

不做：
- 人拖进 In review 触发评审；评审 agent 改代码；多评审者投票；CI/PR 状态接入；临时 worktree 隔离（沿用 AUTO-REVIEW-SPEC §1.2）。
- agent 或模型给评审新增规则。能让评审退卡的准则只从用户的退卡原话长出来。
- 插件写仓库文件（skill 除外，沿用 INSIGHTS-REDESIGN-SPEC §4）。
- 向量检索、跨项目护栏。

反目标（做到了也算失败）：
- 用户需要专门去设置页配置什么才能用上。
- 列表越用越长、越用越旧，最后没人看。
- 第一天就因误判把卡退回去，让用户关掉开关。

## 2. 用户看到的三样东西

| 看到的 | 一句话 |
| --- | --- |
| 卡面 **Checked ✓ / Sent back ↩** | agent 交付后 Flowly 先查一遍。过了才进 Attention；没过直接退给 agent 改。 |
| **Guardrails** 页 | 这个项目查什么：项目自带的检查命令，加上你退卡时说过的话。每条写着抓到几次、误判几次、用在哪类改动上。 |
| **Done 还是你定** | 查过只说明没发现你以前抱怨过的问题，不代表做对了。 |

用户不需要知道：评审 session、模型回退链、硬删除；退回目标阶段、返工计数、指纹；形状、范围、观察期、三个计数怎么算；候选、草案、确认这几个状态（已经没有了）。

整条线里只剩一处要点一下：把 skill 写进仓库（它写进你的仓库）。其余都不需要你点，也不需要你删。

## 3. 护栏库（数据）

### 3.1 文件

`guardrails.json`，与 `board.json` 同目录，串行写、写前备份 `.bak`、原子替换，无效时保留文件并报错。取代 `memory.json`（迁移见 §3.6）。不放进 SQLite 看板库：看板按 etag 频繁读取，护栏正文不需要跟着走（同 PROJECT-MEMORY-SPEC §3.1 的理由）。

```
{ version: 1,
  entries: Entry[],                 // 项目护栏：命令、准则、备忘
  items:   CardItem[],              // 卡片专属项
  clues:   Clue[],                  // 用户原话，沿用 PROJECT-MEMORY-SPEC §4.0
  retros:  [{ taskId, at, summaryId?, clueAt? }],
  errors:  [{ projectId, taskId?, at, message }],
  recallStats: { [projectId]: { days: { [day]: { queries, empty } } } } }
```

### 3.2 Entry

```
Entry {
  id, projectId,
  kind: "command" | "guideline" | "note",
  text: string,                  // 命令：名称 ≤80；准则：一句可判断的话 ≤200；备忘：标题 ≤120
  body?: string ≤1000,           // 备忘正文；准则可选的补充说明
  // command
  argv?: string[] (≤30 项，每项 ≤500), timeoutSec?: 10–3600,
  observe?: { reviews: int, passed: int },      // 观察期计数（§4.5）
  // guideline
  scope?: { types: TaskType[] | "all", sizes: Size[] | "all" },   // Size = "s" | "m" | "l"（§6.2）
  // note
  noteKind?: "decision" | "pitfall" | "contact" | "convention",
  tags?: string[] ≤4, keywords?: string[] ≤12,
  pinned?: boolean,              // 备忘：始终注入，每项目 ≤5
  // 共同
  state: "active" | "observing" | "paused" | "archived",
  stateReason?: string ≤200, stateAt,
  counts: { reviews, passes, caught, missed, misfire, lastCaughtAt?, usedBy: string[] ≤20, usedAt? },
  sources: [{ taskId, at, quote ≤300 }] ≤10,   // 来源卡与原话；备忘的 source 同旧 MemoryEntry.source
  by: "user" | "agent" | "retro" | "detect" | "learned",
  supersedes?: id, supersededBy?: id,
  revision, createdAt, updatedAt }
```

- `state` 的含义：`active` 参与评审或注入；`observing` 只有命令有，跑但不退卡；`paused` 不参与，保留计数，可自动复活；`archived` 不参与，保留历史，可恢复。
- 准则的 `text` 是用户原话的归纳，`sources[].quote` 是原话本身。界面以原话为主显示。

### 3.3 CardItem（卡片专属项）

```
CardItem {
  id, projectId, taskId,
  text ≤200, quote ≤300,         // 归纳与原话
  shape: { type?: TaskType, size?: Size },
  count: int ≥1,                 // 本卡为同一件事退了几次
  state: "open" | "promoted" | "closed",
  promotedTo?: entryId,
  createdAt, updatedAt }
```

- 每卡最多 5 条 `open`，超过时关闭最早的（`closed`）。这是 `closed` 唯一的来源。
- 卡进 Done 或 Cancelled 时项**不关闭**：第一张卡多半在第二张卡遇到同一问题之前就已经 Done，关闭会让升级永远发生不了（实现时发现，2026-10-28）。完成的卡不再评审，所以它的 `open` 项只剩一个用途：§4.2 的“其他卡近 30 天的 open 项”。永久删除卡片时它的项随卡删除（§3.5）；`promoted` 的保留作来源。

### 3.4 上限

| 项 | 上限 | 满了 |
| --- | --- | --- |
| 每项目 `guideline` active | 20 | 新升上来的挤掉抓到率最低、相同时最久没抓到的一条（归档，`stateReason: "displaced"`），Insights 本周变化里记一行 |
| 每项目 `command` active + observing | 10 | 新识别到的不加入，Insights 记一行 |
| 每项目 `note` active | 100 | 挤掉最久没用过的一条（归档） |
| 每项目 pinned 备忘 | 5 | 拒绝 |
| 每卡 `open` CardItem | 5 | 关闭最早的 |
| 每项目 archived | 300 | 删除最早的，写 `removed/` 备份 |

### 3.5 删除、归档与移除

- 永久删除卡片：它的 `open` 和 `closed` 项与线索删除并备份；`promoted` 项保留；它作为 `sources` 的条目保留。
- Remove 项目：该项目全部条目、项、线索、复盘记录写入 `removed/<projectId>-guardrails-<time>.json` 后删除。
- 归档卡片或项目：不动；项目归档后页面只读。

### 3.6 迁移（一次，daemon 启动时）

`memory.json` 存在且 `guardrails.json` 不存在时：

| 旧 | 新 |
| --- | --- |
| `active` 条目 | `note` active，`noteKind` 取旧 `kind`，`usedBy`、`usedAt`、`pinned`、`source` 原样 |
| `candidate` 条目 | `note` active，`by` 照旧（agent / retro）。D2：不再有收件箱，积压的候选按新规则生效，并受 90 天没用归档约束 |
| `dismissed`、`archived` | `archived`，`stateReason` 取旧 `archivedReason` 或 `"dismissed"` |
| `clues`、`retros`、`recallStats`、`errors` | 原样搬入 |
| `project.autoReview.rules` 的命令检查 | `command` active（已经由用户确认过），`by: "user"` |
| `project.autoReview.rules` 的 LLM 检查 | `guideline` active，`scope` 取 `types`（没有则 `"all"`），`sizes: "all"`，`by: "user"`；`off` 的为 `paused` |
| `project.autoReview.goal`、`guidance`、`reviewDraft`、`task.reviewSetup` | 丢弃；设置卡片照普通卡保留 |

迁移成功后把 `memory.json` 改名为 `memory.json.migrated`；失败时两份都不动并记日志，功能按空库运行。

## 4. 学：护栏从哪里来

### 4.1 返工回合

与记忆线索 `feedback` 同一事实（PROJECT-MEMORY-SPEC §4.0，`server/memory.ts` 的 `messageClue`）：回合由用户自己写的消息开始（不是点选的 next move 或 idea，不含密钥），且回合开始时卡片在 In review。不依赖 A1/A1r，自动状态关闭的项目同样学习。“提交并推送”“谢谢”这类回合也会进入归纳，由 §4.2 判为 `none`，不另设规则。线索存储的 15 字符下限**不适用**于返工判定：“测试没跑”四个字就是一次纠正。

### 4.2 归纳：搭卡片总结的便车

卡片总结（TASK-SUMMARY-SPEC §2）每轮结束都跑，输入里本来就有用户这一轮的话。只在返工回合多给两样：

- 输入末尾加一节 `Guardrails`（≤60 行，每行 ≤120 字），每行带 `#短 ID`、种类、状态和文字。按这个顺序放，放不下的截掉：本卡范围内的 active 准则；本卡的 `open` 项；范围外的 active 准则（标 `out of scope`）；本项目其他卡近 30 天的 `open` 项；`paused` 与 90 天内 `archived` 的准则（标状态）。列出范围外和已退出的准则，是为了让 §4.3 的范围扩大和复活能发生，而不是再长一条重复的。
- 输出多一个可选字段：

  ```
  correction?: { kind: "none" | "new" | "same", text?: string ≤120, matches?: string }
  ```

  指令：这一轮用户是否在纠正已交付的工作（不是追加需求、不是闲聊）？是，用一句可判断的话归纳它（`new`）；它和列表里某一条是同一件事时给出那条 id（`same`），文字原样用那一条。不是纠正回 `none`。解析容错同 TASK-SUMMARY-SPEC §3；缺字段按 `none`。
  纠正的判定（2026-10-29 实机验证后补）：用户说交付的改动“也要”“还要”“漏了”“应该”做某件本可以在这次改动里一起做的事（“新接口也要写进 README”“新文案也要进所有语言”），就是纠正，不要求用户写“你做错了”；“追加需求”只指和这次改动无关的新工作（另一个功能、另一个页面）。短句、没有主语、没有否定词都不影响判定。

零额外模型调用。关闭了卡片总结的项目没有即时学习，只在每周运行里补（§7.3）。

### 4.3 记账与升级（daemon，确定性）

卡片总结写回后，按 `correction` 处理，同时写 `clues`（沿用）：

| `correction` | 处理 |
| --- | --- |
| `none` | 无 |
| `new` | 本卡新增 `open` 项：`text`、`quote`（本轮用户原话前 300 字）、`shape`（本卡最近一次交付的形状，§6.2），`count: 1` |
| `same`，匹配本卡 `open` 项 | `count + 1` |
| `same`，匹配**其他卡**的 `open` 项 | **升级**：新建 `guideline` active，`text` 用那条项的文字，`sources` 为两张卡及原话，`scope.types` = 两张卡类型之并，`scope.sizes` = 两张卡大小之并；两条项标 `promoted`。记事件 `guardrail_learned` |
| `same`，匹配 active 准则 | 本卡最近一次评审判过它 `passed` 或 `na` 时 `counts.missed + 1`（评审放过了，用户抓到了）；没评审过（例如 Auto review 关着）只记来源，不计漏掉。本卡形状不在范围内时把范围扩大到包含它 |
| `same`，匹配 `paused` 或 `archived` 准则 | 复活为 active（`stateReason: "revived"`），漏掉的计法同上，范围同上。不新建重复条目。被合并或取代的条目（有 `supersededBy`）沿链找到活着的那条，不复活旧的 |

范围只扩不缩。准则升级后，“本卡范围内”的判断见 §6.2。

### 4.4 备忘

- `flowly_remember`：输入不变（PROJECT-MEMORY-SPEC §4.1），写入即 active；`supersedes` 立即归档旧条目（`stateReason: "superseded"`）。校验不变：`MEMORY_DUPLICATE`、`MEMORY_LIMIT`（按 §3.4）、`MEMORY_SECRET`、`MEMORY_DISABLED`。回执与幂等不变。
- Done 复盘：触发、跳过、运行位置、输入、通用性检验、0–1 条，全部沿用 PROJECT-MEMORY-SPEC §4.2；结果直接 active，`by: "retro"`。
- 人手写：Guardrails 页 Add。

备忘只注入，不参与评审。agent 和复盘不能产生准则或命令。

### 4.5 命令检查

- **项目创建时和开关打开时**：`guardrails.detect` 从仓库识别（规则同 AUTO-REVIEW-SPEC §6.1：package.json scripts 按锁文件选包管理器、Cargo、go、pytest、Makefile；白名单名字 `test*`、`lint*`、`typecheck`、`type-check`、`tsc`、`check`、`vet`；跳过 `watch`；最多 6 条）。识别到的直接以 `state: "observing"`、`by: "detect"` 写入，不用勾选（B3）：观察期内只报结果不退卡，所以第一印象不会是误退；表单在开关下方只显示一行识别结果（“Checks found: typecheck, lint, test”），不满意去 Guardrails 页删或暂停。新建项目的识别在 `projects.create` 里按 `primaryPath` 做，开关从关到开时在 `projects.update` 里做；已有同名命令时不重复加。
- **每周**（§7.3 的运行开始前，不调用模型）重新识别。新命令同时满足两条才加入：在清单的白名单里；近 30 天 agent 在至少 3 张不同的卡上跑过它（命令记录 `commands/<projectId>.jsonl`，按规范化 key 匹配，WORKFLOW-INSIGHTS-SPEC §3.2）。加入时 `state: "observing"`，`observe: { reviews: 0, passed: 0 }`。
- **观察期**：观察中的命令在评审里照跑并显示结果，但不参与总判定。`reviews ≥ 3` 且 `passed ≥ 1` 时转 active；连续 3 次 `unavailable`（起不来、超时）转 paused（`"cannot run"`）。
- **退出**：清单里找不到对应脚本时 paused（`"script missing"`）；active 的命令连续 3 次 `unavailable` 时 paused。改名的脚本走新命令的路进来。
- 手动增删改保留在 Guardrails 页，不要求。
- 不从 workpad 或 agent 的提议学命令：daemon 执行的命令必须有用户授权的证据（勾选，或 agent 经 Paseo 权限在多张卡上跑过）。

### 4.6 密钥

沿用 `redact`（WORKFLOW-INSIGHTS-SPEC §3.2）与 `MEMORY_SECRET`：准则文字、原话、备忘命中密钥规则的整条不记，记一条 `errors`。

## 5. 防：开工注入与 get_task

### 5.1 初始指令

`sessionContext()` 的记忆段改为两段，新建 session 和显式 work instructions 时出现，普通 follow-up 不出现（不变）：

```
Project guardrails (checked when you deliver; <n> of them apply to this card's type):
- Every new UI string is in all language catalogs (caught 4 times)
- …
Project memory (<n> of <m> shown, flowly_recall finds the others):
- [Pitfall] …
```

- 准则：本卡类型范围内的 active 准则（开工时还不知道大小，只按类型筛），全部列出，≤20 行。
- 备忘：沿用 PROJECT-MEMORY-SPEC §6.2 的选择算法与预算（8 条、2400 字）。
- 命令不注入：agent 本来就会跑，交付时 daemon 再跑一遍。

### 5.2 `flowly_get_task`

- `memory` 字段保留，内容是备忘（按当前标签重选，同旧 §6.3），`candidates` 去掉。
- `reviewRules` 换成：

  ```
  guardrails: {
    enabled, maxRounds,
    commands:   [{ id, name, argv, state }],                 // active 与 observing
    guidelines: [{ id, text, scope }],                       // 本卡当前形状范围内的 active 准则
    items:      [{ id, text, count }],                       // 本卡 open 的专属项
    lastReview?: Review }                                    // 同 task.review
  ```

- 返工消息（§6.5）里逐条列出不通过的项，用用户原话。

### 5.3 `flowly_recall`

不变，查询范围是备忘和准则。

## 6. 查：交付评审

### 6.1 触发与流程

触发、排队、状态机（Reviewing / Passed / Rework / Failed / Unavailable / Cancelled）、退回目标阶段、返工计数、投递、指纹、硬删除，全部沿用 AUTO-REVIEW-SPEC §3 和 §5。改动：

- **去掉 L1**：`flowly_update_status(in_review)` 不再返回 `WORKPAD_OPEN` 或 `WORKPAD_FAILING`，`acknowledgeOpen` 只对 `SETUP_INCOMPLETE` 有效（CARD-SETUP-SPEC §3.4；“workpad 缺失”改为“验收清单缺失”）。
- 交付调用新增可选 `disputes?: [{ id, reason ≤300 }]`：id 必须是本卡最近一次评审里 `failed` 的项，或已在 `task.disputes` 里的项（重复提交幂等），否则 `INVALID_INPUT`。接受的争议写进 `task.disputes: [{ id, kind, name, reason, round, at }]`（≤10 条，随卡保留，不改 task revision 之外的语义；B7）。卡进入 Done / Cancelled 时按 §6.6 记账后清空；人把卡拖回工作阶段不清空（争议还在，等下一次评审）。
- 项目开启、卡片未归档即触发；没有任何命令和准则时也跑内置检查。

### 6.2 改动的形状

评审开始时 daemon 算一次并写进评审记录：

- 取本卡自己的改动（2026-10-29 实机验证后改，之前是“`git diff HEAD` 加最近 5 个提交”，在 worktree 卡上会把基线分支的历史算进来，每张卡都成了 `m`）：
  - worktree 卡（`task.baseRef` 非空且能解析；该字段从 a1ec736 起在建卡时保存 `resolveWorktreeBaseRef` 的结果，之前建的卡没有，走下面的旧取法）：`git merge-base <baseRef> HEAD` 为基点，`git diff <基点> --numstat` 覆盖分支以来已提交与未提交的改动；
  - 目录卡或基点解析失败：`git diff HEAD --numstat` 加最近 5 个提交（旧取法，共享目录里别的卡的改动会算进来，见 D6）；
  - 两种都加上未跟踪的新文件（`git ls-files --others --exclude-standard`）：文本文件按行数计，二进制（前 8 KiB 有 NUL）或超过 1 MiB 的计 0 行、不进评审 diff，不改索引（不做 `git add -N`）。
- `files`、`lines`：上述增删行之和；`size`：`s` ≤50 行，`m` ≤400 行，`l` >400 行。
- 评审 session 读的 diff 用同一基点（第 1 轮 `git diff <基点>`，目录卡为 `git diff HEAD` 加最近 5 个提交），未跟踪的新文件以 `git diff --no-index /dev/null <file>` 附在后面；第 2 轮起 `git diff <上一轮 sha>` 加当时仍未跟踪的新文件；总长仍截在 64 KiB。
- 本卡最近一次交付的形状也写进 `task.review.shape`，供 §4.3 新项使用。
- 共享工作区（非 worktree）里别的卡的改动会算进来，形状可能偏大；评审记录标 `shared`，不另做处理（D6）。
- **多仓根目录**（2026-11-07 加）：卡片 workspace 的目录本身不是 Git 仓库时（linked root，PROJECT-PICKER-SPEC；或用户注册的普通公共目录），评审读它下面的仓库：按名字排序的、非隐藏的子项（symlink 或目录）里含 `.git` 的，最多 20 个。对每个仓库按上面的规则取形状和 diff（基点同上，linked 卡没有 `baseRef`，走目录卡取法）；路径一律带仓库前缀 `<子项名>/<路径>`（diff 用 `--src-prefix` / `--dst-prefix`），所以评审引用的文件、证据核对（文件经 symlink 存在即可）和返工消息都指向具体仓库里的文件。形状为各仓库之和；diff 每个仓库一节，标题 `## Repository <名字> (its paths start with <名字>/)`，每个仓库的一节截在 64 KiB 的平均份额内（`[<名字>: diff truncated]`），一个仓库的大改动不会把其他仓库挤出去，总长仍截在 64 KiB。HEAD：各仓库的短 sha 记在 `fingerprint.repos: { <名字>: sha }`，`fingerprint.sha` 为它们的 12 位摘要（任一仓库有新提交即变），任一仓库 dirty 即 dirty；第 2 轮起每个仓库从自己上一轮的 sha 取增量，上一轮没有记录的仓库取全量。目录本身是 Git 仓库时行为不变；agent 在卡片 workspace 之外另开 worktree 做的改动仍看不到。

**范围内**：准则的 `scope.types` 为 `"all"` 或包含卡片类型（卡片没有类型时视为包含），且 `scope.sizes` 为 `"all"` 或包含本次大小。

### 6.3 顺序与判定

1. **命令**：active 与 observing 的命令全部跑完（执行方式同 AUTO-REVIEW-SPEC §4.3）。只有 active 的参与总判定。多仓根目录（§6.2）里每条命令只在本次交付改动过的仓库里跑（有未提交或未跟踪的改动，或者有卡片创建之后的提交；git 读不了的仓库算改动过；一个都没改动时退回全部仓库），在这些仓库里依次挑适用的跑，任一仓库失败即该项失败（失败输出前标 `[<仓库名>]`，耗时为各次之和），后面的仓库不再跑；该项的 `detail` 记下实际跑过的仓库（`Ran in agent-smith, search-admin.`，失败的仓库在最后），评审记录里展开命令即可看到，通过时也有（目录本身是 Git 仓库时不写）：`npm` / `pnpm` / `yarn` / `bun`（及 `npx` 等）的脚本要求该仓库 `package.json` 有这个脚本（`run <x>`、`test` 等别名；其余子命令只要求有 `package.json`）；`make <target>` 要求有 makefile 且写了该 target；`go` / `cargo` 要求有 `go.mod` / `Cargo.toml`；其他命令在每个仓库都跑。没有一个仓库适用时该项记 `skipped`（`No repository in this workspace has this command.`；只看改动过的仓库时为 `No repository this delivery changed has this command.`），不让评审变成 Unavailable。
2. **评审 session**：所有参与判定的命令都通过时才跑（D9）。一次判定全部：内置检查 `goal`（“Does what you asked”，尺子同 AUTO-REVIEW-SPEC §4.2：卡片、用户原话、验收清单只作上下文）、范围内的每条准则、本卡每条 `open` 项。输出：

   ```
   { items: [{ id, verdict: "pass" | "fail" | "na", detail ≤600, file?, line? }] }
   ```

   - `fail` 必须带证据，三种任一（B1）：`file` 出现在 diff 里（改错了）；`file` 在仓库里存在但缺东西（漏改了，例如 `shared/i18n/zh-TW.ts` 没有新词条，daemon 只核对文件存在）；`quote` 引用卡片描述或用户原话里没做到的要求（内置检查和专属项常见）；daemon 核对出处（2026-11-07 按 PR #75 评审意见补）：quote 与来源都压缩空白、去首尾、转小写后，quote 必须是卡片标题、卡片描述、评审拿到的过滤后对话里任一条消息、或该检查自己的用户原话的子串，否则不算证据（从 diff 或代码里引的文字要用 `file` 给证据）。三样都没有的 `fail` 由 daemon 改为 `na`，`reason: "no evidence"`。这是确定性的降噪，目的是丢掉凭空的意见，不是只许挑改过的代码的毛病。
   - 输出的每项于是为 `{ id, verdict, detail, file?, line?, quote? }`，`quote` ≤300 字。
   - `na` 按通过处理，不计抓到也不计误判。
   - 返工第 2 轮起：评审输入只给上一轮交付以来的增量 diff（`git diff <上一轮 sha>`）加上一轮的结果，指令写明只复查上一轮不通过的项和增量里的新问题，不重复已经通过的。
   - 争议：`task.disputes` 里的项（§6.1）不交给评审 session，直接记为 `disputed`，带 agent 的理由。
3. **总判定**：有任何参与判定的项 `failed` → 不通过（R1，或到上限 R2）；否则有 `unavailable` → Unavailable；否则 Passed。`disputed` 不算不通过。

参与判定的集合（B4）：命令与内置检查总是参与；准则和专属项只在 Guardrails 开着时参与（host `features.memory` 为开且 `Project.memory !== false`）。关闭时它们也不注入、不学、不显示在 `get_task.guardrails` 里。

评审 session 建在卡片 workspace 里，provider 原生加载仓库的 `AGENTS.md` / `CLAUDE.md`，不再单独喂 `guidance`。模型：Settings → Models 的 Review model，未设置时用 Summary models 列表（Haiku 优先），不回退到项目默认的 agent 模型；评审记录写 `model` 与 `tokens`，卡片的评审区块显示。

### 6.4 评审记录

`task.review` 在 AUTO-REVIEW-SPEC §8.2 基础上改：

```
Review {
  trigger, round, maxRounds, state, reason?, fingerprint, shared,
  shape: { files, lines, size },
  items: [{ id, kind: "command" | "goal" | "guideline" | "item", name,
            gating: boolean,                                  // observing 命令为 false
            state: "queued" | "running" | "passed" | "failed" | "na" | "disputed" | "skipped" | "unavailable",
            ms?, argv?, exitCode?, timedOut?, tail?, detail?, file?, line?, reason?, disputeReason? }],
  model?, tokens?: { in, out, costUsd? },
  startedAt, finishedAt? }
```

`rules` 改名 `items`。`review_finished` 事件的 `results` 带每项 `{ id, kind, state }`。

### 6.5 返工消息

格式沿用 AUTO-REVIEW-SPEC §5，准则和专属项用用户原话：

```
[Flowly auto review · rework 1/2]
Commands: 2/2 passed
✗ "新文案也要进所有语言" — zh-TW.ts has no entry for "Review passed" (shared/i18n/zh-TW.ts:412)
✗ Does what you asked — the card asked for a Rerun button; none was added
Fix these, rerun the checks, update the acceptance list and deliver to In review again. If a finding is wrong, deliver with disputes=[{id, reason}].
```

### 6.6 三个信号与计数

所有计数由 daemon 在事件上确定性地算，没有按钮：

| 信号 | 事实 | 计数 |
| --- | --- | --- |
| 抓到 | 一项在第 n 轮 `failed`，同一张卡之后的评审里它 `passed`（没有争议） | `caught + 1`，`lastCaughtAt` |
| 漏掉 | 范围内的 active 准则在最近一次评审 `passed` 或 `na`，之后的返工回合归纳匹配到它（§4.3） | `missed + 1` |
| 误判 | 一项在 `task.disputes` 里，这张卡进入 Done 或 Cancelled 时争议仍在（用户没有为这件事再退卡） | `misfire + 1`；争议随即清空 |
| 评审 | 每次参与评审 | `reviews + 1`；`passed`/`na` 时 `passes + 1` |

争议项被用户的返工归纳匹配到时（§4.3 `same`）：争议失败，从 `task.disputes` 移除，记 `caught + 1`，不记误判。

### 6.7 自动退出（在每次评审结束和每周运行时判断）

| 条件 | 动作 |
| --- | --- |
| 准则 30 天内 `misfire ≥ 2` | paused，`"misfired twice in 30 days"` |
| 准则 `reviews ≥ 20` 且 `caught = 0` 且 90 天内没有 `missed` | archived，`"never caught anything"` |
| 准则被 §4.3 匹配到 | 复活 |
| 命令：§4.5 | |
| 备忘 90 天没有 `usedAt`（从未用过的从创建算） | archived，`"unused for 90 days"` |
| 上限：§3.4 | 挤出 |

## 7. 看：workpad 与 Insights

### 7.1 Workpad（卡的账）

卡片抽屉的 Workpad 段改为四段，没有内容的段不显示：

1. **Acceptance**：agent 开工时写的验收清单（3–5 条，`done` 可由 agent 或人勾），仍是 agent 对“做到什么算完”的承诺，评审当上下文读，不当门槛。
2. **This card**：本卡的 `open` 专属项，每条显示原话和退了几次；`promoted` 的显示“已成为项目准则”。
3. **Review**：最近一次评审，按 失败、争议、通过/不适用 排序；命令行显示命令与耗时，判断类的行显示依据与文件位置；观察中的命令标 “observing”；共享工作区注明；头部显示轮次、模型、token。有 **Rerun**（条件同 AUTO-REVIEW-SPEC §9.2）。
4. **Plan**：来自原生 todo，不变（免费）。

去掉：Checks（自报验证）、Confusions（agent 改用提问工具）、环境戳、新鲜度、“Delivered with N open items”。卡面信号只剩 `Acceptance n/m` 和评审状态（Checked / Sent back / Review failed / Review unavailable）；评审进行中不占信号行，由下面的指示条表示。

#### 7.1.1 卡面指示条（用户 2026-10-28 要求）

评审运行时卡片底部展开一条指示条，结束时收起；一行，只做总览（用户 2026-10-28：“一个总览就好了，不用那么详细”）。沿用 P1 已有的 `ReviewStrip`（`client/card.tsx`，`Collapse` 展开收起，`RunningDots` 点阵扫光铺在底下，跟随 Reduce Motion 与扫光开关，web 走 CSS 动画不占 JS 线程），只改文字：

```
▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ← 点阵扫光（背景）
 ◌ Reviewing · 3/7 passed · running npm test
```

- 强调色一句话，三段用 `·` 分开：`Reviewing`；`{passed}/{total} passed`（通过含不适用；observing 命令不计入 total；有失败时改为 `{passed}/{total} passed · {n} failed`，失败数危险色）；现在在做什么，弱化色：命令阶段 `running {name}`，评审 session 阶段 `judging {n} checks`，还没有结果时 `starting…`。
- 数据来自 `task.review.items`（§6.4），随现有看板 etag 读取更新，不新增轮询。shared 的 `reviewProgress(review)`（`shared/auto-review.ts`，阶段 B 提供）返回 `{ passed, failed, total, phase: "starting" | "running" | "judging" | "done", current?: string, judging?: number }`：`total` 只数 gating 的项，`current` 是正在跑的命令名，`judging` 是评审 session 正在判的项数；客户端只渲染。
- 结束时保持最后一帧 600 ms（让人看到 `7/7 passed` 或 `1 failed`）再随 `Collapse` 收起，信号行同时切到 Checked / Sent back；Reduce Motion 时立即收起。
- 无障碍：label 读作 “Auto review running, 3 of 7 passed, running npm test”。
- 文案键（英文，进全部目录）：`Reviewing`、`{passed}/{total} passed`、`{n} failed`、`running {name}`、`judging {n} checks`、`starting…`。命令名是用户内容，不翻译。

工具 `flowly_update_workpad` 收窄为 `{ expectedRevision, request, workpadRevision, acceptance: [{ id?, text, done }] }`，返回与错误码不变（`WORKPAD_CONFLICT`、`WORKPAD_INVALID`、`WORKPAD_DISABLED`）。`Workpad` 数据去掉 `validation`、`confusions`、`env`、`head`、`delivery`；旧数据读取时丢弃这些字段。CLI `workpad` 的 JSON 只接受 `{acceptance}`。

### 7.2 Insights（项目的账）

页面从上到下：

1. **闭环的账**（替换“工作流”摘要行）：最近 14 天 `交付 N 次 · 首次通过 X% · 误判 Y%`。
   - 交付：agent 的 `status_changed → in_review`。
   - 首次通过：一次交付的第一轮评审 Passed 的比例（分母是被评审的交付）。
   - 误判：30 天内 `misfire` 之和除以判断类 `failed` 之和；没有失败时不显示。
   - 下面一行本周变化：`新增 2 条准则 · 1 条扩大范围 · 退休 1 条 · 1 条命令进入观察`，每项可点开到 Guardrails 页。
2. 活跃度热力图与当天总结：不变。
3. **Skills**：不变（INSIGHTS-REDESIGN-SPEC §2.3）。
4. 其它建议：不变，默认收起。
5. 工作流按模型的几行：不变，默认收起。

去掉 AUTO-REVIEW-SPEC §7 的返工提示、检查建议、暂停建议和 `review_rule` / `review_pause` 两类 finding。

### 7.3 每周整理（在现有 Insights 运行里）

与 Skills 同一次运行、同一次模型调用、同一开关与周期（INSIGHTS-REDESIGN-SPEC §3.1）。运行分三步：

1. **确定性，不调用模型**：§4.5 的命令重识别；§6.7 的退出判断。
   - 例外：关闭了卡片总结的项目，用近 7 天的 `feedback` 线索做一次补学。把这些线索当返工回合，走 §4.2 的归纳，用 Summary model 一次处理最多 30 条；这是本步唯一的模型调用，开着卡片总结的项目没有它。
2. **素材**：在 INSIGHTS-REDESIGN-SPEC §3.2 之外加一节 `Guardrails`：每条准则的文字、范围、计数、来源卡；近 30 天每张卡的评审结果摘要；`open` 的专属项。
3. **模型输出**新增两类，校验后由 daemon 执行：
   - `merges: [{ keep: id, drop: id, why ≤200 }]` ≤5：两条准则或两条备忘讲的是同一件事。daemon 把 `drop` 归档（`"merged"`，`supersededBy: keep`），计数相加，来源合并，范围取并。两个 id 都必须是本项目 active 条目，否则丢弃。
   - `agents_md` 建议（已有类别）可以引用准则：30 天 `caught ≥ 5` 的准则说明 agent 一直在犯，光靠评审拦不划算，运行起草一条 AGENTS.md 规则或一个 skill（已有类别）。用户采纳 AGENTS.md 建议（Create card 或复制）后，可以在 Guardrails 页把这条准则归档（`"promoted"`）；问题复发时 §4.3 会把它学回来。

   运行不能新建准则或命令；输出里出现这类内容时丢弃。

### 7.4 Guardrails 页与 Memory 页（D10）

**Guardrails 页**。入口：总览栏 **Guardrails** chip（有 `observing` 命令或本周新增时显示数量），快捷键 `G`；项目菜单同名。整页，对齐 Ideas / Insights。

- 顶部两个分段：**Commands**、**Guidelines**；每段内按 active（observing）、paused、archived 分组，archived 默认收起。
- 命令行：名称、命令原文、状态（observing 时显示 `observing 1/3`）、最近结果；菜单：Edit、Pause / Resume、Delete。段尾 **Add command**。
- 准则行：原话（引用样式）、归纳句、范围 chip（类型、大小；`all` 不显示）、`caught 4 · missed 1 · misfire 0`、来源卡（可点）；菜单：Edit、Pause / Resume、Archive、Delete。paused 和 archived 的显示 `stateReason`。不提供 Add：准则只从退卡长出来；用户想加规则就在卡里退回时说。
- 空状态：“Nothing learned yet. Send a card back with what is wrong; Flowly checks the next cards for it.”

**Memory 页**（保留旧名 Memory、旧入口；条目是 `kind: "note"` 的 entry）。入口：总览栏 **Memory** chip（本周新增数，没有时不显示数字），快捷键 `M`；项目菜单同名。

- 工具条一行：类型过滤 chips（All、Decision、Pitfall、Convention、Contact，单选）、排序（**Newest**、**Most used**、**Recently used**；pinned 始终在前）、宽屏时布局切换（**List** / **Grid**）。过滤、排序、布局每台机器记住（`board-view` 设置：`memoryKind`、`memorySort`、`memoryLayout`）。
- 布局（2026-10-31 重设计：第一版列太窄、内容截断、信息密集）：内容区最宽 1120，居中；List 单列、最宽 760；Grid 是瀑布流（Keep 式）：列宽至少 340，列数 `clamp(floor(宽度/340), 2, 3)`，列间距与卡间距 16，条目按估算高度放进当前最短的一列；紧凑布局只有 List，切换不显示。卡片高度随内容，不固定。
- 卡片（两种布局同一张）：内边距 16；第一行一个类型标记（主题色小圆点 + 类型名，小号）和右侧的 Pin 图标（只在 pinned 时显示）；标题 `font.md` 加粗、不截断；正文 `font.sm`、行高 1.5，默认最多 6 行，点卡片展开全文、再点收起（展开状态只在本页内保留）；标签和使用情况合成最后一行小号灰字（`#tag #tag · Used by 3 cards`，没用过不写“Not used yet”，都没有就不显示这一行）；来源卡一行在正文下方，可点。左侧色条 2 像素，颜色同类型；paused / archived 的状态原因接在类型标记后面。
- 操作：桌面上卡片右上角的 `…` 只在悬停或聚焦时显示（始终可聚焦），紧凑布局始终显示；菜单：Edit、Pin / Unpin、Copy as AGENTS.md rule（归档为 `promoted`）、Archive / Restore、Delete（confirm）。不再在卡片底部平铺一排按钮。archived 一组默认收起。工具条右侧 **Add memory**。
- 每条按类型 color code：四种类型各用一种主题色（不自定义颜色；主题没有足够区分度时退回到灰度）。
- 去掉：To review 区、Confirm / Dismiss、Clean up 筛选、Make room、容量提示、Find memories 按钮（复盘仍自动跑）。
- 卡片侧栏的 Memory 段去掉；本卡产生的备忘和专属项在 Workpad 段的 This card 里显示。
- 文案：用户可见处一律叫 Memory / memory（不叫 Notes）；agent 面（skill、get_task、工具说明）也用 memory。
- 空状态：“No memory yet. Agents remember decisions, pitfalls and conventions as they work; you can add one too.”
- 动效、输入、无障碍沿用 PROJECT-MEMORY-SPEC §8.1。

### 7.5 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `guardrails.read` | `{ projectId, etag? }` | `{ etag, value?: { entries, items, errors, running: taskId[] } }` |
| `guardrails.counts` | `{ etag? }` | 总览 chip 用：每项目 observing 命令数、本周新增准则数（`added`）与本周新建且未归档的备忘数（`notes`，Memory chip 用） |
| `guardrails.create` | `{ projectId, kind: "command" \| "note", … }` | 人手写命令或备忘，直接 active |
| `guardrails.update` | `{ id, revision, text?, body?, argv?, timeoutSec?, scope?, tags?, keywords?, pinned?, state?, stateReason? }` | 编辑、暂停、恢复、归档、复活。`revision` 不符 `GUARDRAIL_CONFLICT` |
| `guardrails.delete` | `{ id, revision }` | 永久删除，写 `removed/` 备份 |
| `guardrails.detect` | `{ projectId }` | §4.5 开启时的识别，不执行命令 |
| `guardrails.retro` | `{ taskId }` | 手动复盘（保留给开发者，不在界面上） |
| `reviews.rerun` | `{ taskId }` | 不变 |
| `insights.guardrails` | `{ projectId, tz }` | 近 14 天的闭环账（§7.2）：`{ deliveries, reviewed, firstPass, judged, misfires, changes: { learned, widened, revived, retired, observing } }`。`deliveries` 为 agent 的交付次数，`reviewed` 为其中被评审的，`firstPass` 为第一轮 Passed 的，`judged` 为判断类 `failed` 之和（30 天），`misfires` 为同期误判之和，`changes` 为本周 `guardrail_*` 事件的计数加当前 observing 命令数。daemon 从流转日志、`review_finished.results` 与 `guardrail_*` 事件算出；阶段 B 提供，客户端只渲染 |
| `insights.*`、`workflow-insights.*`、`summaries.*`、`workpads.*` | | 不变，`workpads.check` 只剩 acceptance |

去掉：`memory.*` 全部；`reviews.detect-commands`、`analyze-history`、`analysis-status`、`apply-draft`、`discard-draft`、`setup-card`；`insights.add-review-check`、`pause-review-check`、`dismiss-review-nudge`。

### 7.6 事件

| action | actor | 何时 | note |
| --- | --- | --- | --- |
| `guardrail_learned` | system | 新建专属项、升级为准则、复活、扩大范围 | 文字与种类 |
| `guardrail_retired` | system | 自动暂停、归档、挤出、合并 | 原因 |
| `memory_proposed` | agent / system | `flowly_remember`、复盘（现在直接生效） | 标题 |
| `review_started`、`review_finished`、`status_changed` R1/R2 | | 不变 | |
| `workpad_updated` | agent | | `Acceptance n/m` |

`guardrail_*` 不显示在卡片活动时间线，flow log 照常记录（Insights 本周变化从这里算）。去掉 `review_rules_proposed`。

## 8. 设置与默认

- **项目 Auto review**：`project.autoReview` 收窄为 `{ enabled, maxRounds }`。`projects.create` 写入 `{ enabled: true, maxRounds: 2 }`（D1）；已有项目保持存储值，字段缺失读作 false。New project 与 Edit project 里只有开关、成本一句（“Every delivery runs a review and uses tokens.”）、识别结果一行（§4.5）和 Max rework rounds；去掉检查列表、Use these、Adjust with AI、Suggest checks from past cards、Review guidance、草案块。
- **项目 Guardrails**：`Project.memory` 的键保留，项目设置里的 “Project memory” 行改名 **Guardrails**，说明 “Learn from what you send cards back for, and check the next cards for it.”。
- **host**：`features.memory` 的键保留，界面改名 **Guardrails**，说明 “Flowly remembers what you send cards back for and checks the next cards for it. Learning uses a few tokens per card.”。host 或项目任一关闭时（B4）：不学（§4.2、§4.3）、不注入、`flowly_remember` 返回 `MEMORY_DISABLED`、不复盘，准则和专属项不参与评审（§6.3），Guardrails 页只读。Auto review 的开关只管评审本身：关闭 Guardrails 后评审仍跑命令和内置检查。`task-summary.retroEnabled` 保留。
- **Review model**：不变；默认回退到 Summary models。
- **Workpad** 项目开关：保留，只管验收清单的显示与工具。

## 9. Agent 工具与 skill

| 工具 | 变化 |
| --- | --- |
| `flowly_get_task` | `reviewRules` → `guardrails`（§5.2）；`memory.candidates` 去掉；`workpad` 只剩 `acceptance`、`plan`、`revision`、`items` |
| `flowly_update_status(in_review)` | 新增 `disputes`；不再返回 `WORKPAD_OPEN` / `WORKPAD_FAILING`；`acknowledgeOpen` 只对 `SETUP_INCOMPLETE` |
| `flowly_update_workpad` | 只收 `acceptance` |
| `flowly_remember` | 写入即生效；描述改为 “Remember … It takes effect at once for new sessions on this project, so only propose what holds beyond this card.” |
| `flowly_recall` | 不变 |
| `flowly_propose_review_rules` | 删除（MCP、CLI `review-rules`、skill） |
| CLI | `workpad` 只接受 `{acceptance}`；`status in_review` 新增 `--disputes '<JSON>'`；删除 `review-rules` |

skill（`server/skill-source.ts` 与 `skills/flowly/SKILL.md`）：

- 删除验证项、sha、dirty、新鲜度、`WORKPAD_OPEN`、`WORKPAD_FAILING`、`acknowledgeOpen`（保留在 `SETUP_INCOMPLETE` 一句里）、`flowly_propose_review_rules`、“reviewRules lists the checks”。
- 新增一段（英文）：“`flowly_get_task.guardrails` lists what this delivery will be checked against: the project's commands, the guidelines learned from what the user sent earlier cards back for, and this card's own items. Read them before you start and before you deliver; the reviewer judges against them and against what the user asked in the card and this conversation. A rework message starting with `[Flowly auto review` lists what failed: fix it, update the acceptance list and deliver again. If a finding is wrong, deliver with `disputes=[{id, reason}]` instead of arguing in the note; the user decides.”
- Workpad 一段改为：“Before you start implementing, write 3–5 acceptance criteria with `flowly_update_workpad` and tick them as you meet them; the reviewer reads them as your own claim, not as proof.”
- 记忆一段：去掉 “check memory.candidates first”，加 “What you remember takes effect at once.”

## 10. 引导、What's new、遥测、i18n

- **导览**（ONBOARDING-SPEC）：第 2 页 Built in 加一句 **Auto review**（不加开关，B3）：“Deliveries are checked before they reach you and go back to the agent when they fall short. Each review uses tokens; turn it off per project.”；第 3 页 Project memory 改为 **Guardrails**（开关仍是 `features.memory`），示例换成“你退卡的一句话 → 下一张卡被查”的两行；More features 里的 Workpad 一句改为验收清单，Auto review 一句去掉“Flowly can suggest the checks”。
- **提示**：`first-memory-candidate` 删除；新增 `first-guardrail`：项目第一次出现升级为准则的 `guardrail_learned`（第一条准则）且没打开 Guardrails 页时，“Flowly learned a check from a card you sent back. Open Guardrails to see what it checks now.”，优先级在 `auto-review` 之后；`review-suggest` 删除；`first-workpad` 文案改为验收清单。`tipIds`、`tipText`、`nextTip`、`onboarding-logic.test.ts`、提示表同步。
- **What's new 1.8.0**（覆盖 P3 已写的那条）：
  - “Auto review checks every delivery before it reaches you and sends it back to the agent when it falls short. On for new projects.”
  - “Flowly learns from what you send cards back for: the second card with the same problem turns it into a project guideline, checked on every delivery it applies to.”
  - “Memory no longer needs confirming; what agents remember takes effect at once and retires by itself when unused.”
  - 按钮 **Turn on for this project**（打开当前项目的 Edit project，开关已打开，显示识别清单）。
- **遥测**：`f_auto_review` 不变；`f_auto_review_llm` 删除（内置检查总是开着，与前者相同）；新增 `c_guardrails`：未归档项目的 active 准则总数（计数，不含文字）。TELEMETRY-SPEC §4、`heartbeatProperties`、key-set 测试同步。
- **i18n**：新文案进全部目录，删除的文案从全部目录删除；原话、归纳句、命令名是用户或模型内容，不翻译；`Does what you asked` 渲染时翻译。
- README 两份：Highlights 的 Memory、Workpad、Auto review 三句改写。

## 11. 与产品约束的对照

| 约束 | 处理 |
| --- | --- |
| AGENTS.md 例外 “Off by default”（2026-10-27） | 改为 “On for new projects, off for existing ones until the user turns it on”（D1） |
| AGENTS.md 后台 workspace 与硬删除例外名单 | 去掉“auto review history analysis”；评审 session、复盘、Insights 运行不变 |
| 记忆 `8424d1ab`：否决服务端代为补救 | 返工消息是验收结果，不是补救（AUTO-REVIEW-SPEC D2）；学习不发消息 |
| 记忆 `184178fe`：用户偏好最简单的方案 | 本文去掉的东西多于加的：收件箱、草案、设置卡片、历史分析、规则编辑器、自报验证、软门槛 |
| “Use subprocess argument arrays” | 命令只接受 argv；自动加入的命令来自清单，`npm run <script>` 形式 |
| “Do not expose tokens in logs” | 命令输出只在评审记录里；原话经 `redact` |
| UI 文案规则 | 只留成本、状态和后果；列表由用户原话填充 |
| Onboarding / Telemetry upkeep | §10 |

## 12. 与现有 spec 的关系

| spec | 被本文取代的部分 | 保留 |
| --- | --- | --- |
| PROJECT-MEMORY-SPEC | §1.2 的“人确认才生效”、§3（文件与条目改为 §3）、§5（确认与 RPC）、§6.5（晋升与淘汰）、§8（UI）、§9 的说明文案、§12 的“不自动确认或删除” | §2（存什么、与 AGENTS.md 分工）、§4.0 线索采集、§4.1 工具校验、§4.2 复盘、§6.1–6.4 注入与召回算法 |
| WORKPAD-SPEC | §2.1 的 validation / confusions / env / head / delivery、§3 的输入、§4.2 环境戳、§5 全部、§6.1 卡面信号、§6.2 的 Checks / Confusions、§6.3 的验证操作、§7 skill | §2.2 Plan、§2.4 两种 revision、§6.3 的 acceptance 勾选、§9 项目开关 |
| AUTO-REVIEW-SPEC | §1.1 用户路径、§4.1 L1、§4.2 的规则种类与 `types`、§6 全部配置、§7 Insights、§8.1 的 rules / guidance / reviewDraft、§8.4、§8.5 的多数 RPC、§9.3、§9.6 的 What's new、§12 P3 的 2、4、5、D7、D8、D10、D11、D13–D16 | §2、§3、§4.3、§4.4 的 session 跑法、§4.5、§5、§8.2 骨架、§8.3、§9.1、§9.2 的 Rerun、§9.4、D1–D6、D9、D12、D17 |
| INSIGHTS-REDESIGN-SPEC | §2.5 工作流摘要行 | 其余 |
| WORKFLOW-INSIGHTS-SPEC | 无 | 全部；§3.2 的命令记录多了一个消费者（§4.5） |
| CARD-SETUP-SPEC | “workpad 缺失” 改为 “acceptance 缺失” | 其余 |
| DELIVERY-CONSTRAINTS-SPEC | §2 的 `WORKPAD_OPEN` 部分 | `SETUP_INCOMPLETE` 的先拒后放、outputs |

实现时在以上 spec 顶部加一行指向本文的注记；AUTO-REVIEW-SPEC 的注记在 5cbb9bc 合入后加。

## 13. 分期

- **P0**：Auto Review 卡合入 `5cbb9bc`。
- **P1 学与防**：`guardrails.json` 与迁移；卡片总结的 `correction`；记账、升级、复活、范围扩大；`flowly_remember` 即时生效；注入与 `get_task.guardrails`；Guardrails 页（三段、编辑、暂停、删除）；事件。
- **P2 查**：形状与范围；准则和专属项进评审；证据过滤；增量复查；`disputes`；三个信号与自动退出；命令观察期与每周重识别；去掉 L1、规则编辑器、草案、设置卡片、历史分析、`flowly_propose_review_rules`；项目设置与默认开。
- **P3 看**：workpad 收窄；Insights 顶部与本周变化；每周整理的 merges 与 AGENTS.md 建议；导览、提示、What's new、遥测、README、AGENTS.md、旧 spec 注记。

三期在一个实现分支 `feat/guardrails`（基于 `feat/auto-review` 5cbb9bc）上依次完成，合成一个 PR 进 main，随 1.8.0 一起发布（B5）：auto review 本身还没发布过（最新 tag v1.7.2），所以 §3.6 的迁移只需要一次，What's new 也只写一次。各期之间不发版。

## 14. 验收

单元（聚焦，不做快照）：

- 迁移：active / candidate / dismissed / archived 各自的去向；命令与 LLM 规则的转换；失败时两份文件不动。
- 归纳：返工回合判定（A1 拉回且未被 A1r 还原）；只在返工回合给 `Guardrails` 节；`correction` 缺失、`none`、`new`、`same` 四种解析；密钥整条丢弃。
- 记账：`new` 建项、同卡 `same` 加计数、跨卡 `same` 升级（范围为并、两项标 promoted、事件）、匹配 active 准则记 missed 并扩大范围、匹配 paused / archived 复活；每卡 5 条上限；准则 20 条挤出；备忘 100 条挤出。
- 范围：类型与大小的判断；卡片无类型；`"all"`。
- 评审：observing 命令不参与总判定；无文件证据的 `fail` 降为 `na`；第 2 轮只给增量；`disputes` 的 id 校验与 `disputed` 状态；总判定；`review_finished.results`。
- 信号：抓到、漏掉、误判各自的事实序列；争议被返工匹配时记抓到不记误判。
- 退出：误判 2 次暂停；20 次评审没抓到归档；复活；命令 3 次 unavailable 暂停、脚本消失暂停；观察期转 active；备忘 90 天归档。
- 每周运行：重识别加使用证据才加入；`merges` 校验与执行；运行输出里的新准则被丢弃；关闭卡片总结的项目补学。
- 注入与 `get_task`：准则按类型筛、备忘预算不变；`guardrails` 字段；`memory.candidates` 不存在。
- 工具：`flowly_update_status(in_review)` 不再 `WORKPAD_OPEN` / `WORKPAD_FAILING`；`disputes` 非法 → `INVALID_INPUT`；`flowly_update_workpad` 只收 acceptance，旧字段 → `WORKPAD_INVALID`；`flowly_remember` 即时 active、`supersedes` 即时归档；`flowly_propose_review_rules` 不在工具列表。
- RPC：`guardrails.*` 的 revision 冲突、删除备份、级联；去掉的 RPC 不存在。
- 客户端：提示规则 `first-guardrail`；What's new 1.8.0；i18n 目录完整；遥测 key-set。
- `npm run typecheck`、`npm test`。

实机（Tinylink，按 AGENTS.md，用新建的测试卡，结束后只清理自己建的）：

1. 卡 A 交付，一条命令失败 → 退回、返工消息带原话格式；修好再交付 → Checked。评审期间卡片底部的指示条显示 `Reviewing · n/N passed · running <命令>`，结束后保持一帧再收起（截图 running / finished 两张；Reduce Motion 下无扫光、无保持）。
2. 用户退卡 A 说“新文案也要进所有语言” → 卡 A 出现专属项；卡 B 交付后用户为同一件事退卡 → Guardrails 页出现一条准则，范围为两张卡的类型与大小；卡 C（同类型、同大小）交付时评审逐条判定它；卡 D（不同大小）不受它影响。
3. agent 带 `disputes` 交付 → 卡到达 In review，Review 段显示争议；移到 Done → 该准则 `misfire` 1。
4. 新加一个 `test:e2e` 脚本并让 agent 在 3 张卡上跑过 → 每周运行后它进入 observing；3 次评审后转 active。
5. 迁移：用本机 `memory.json` 的副本启动 → 条目数一致，候选变为 active 备忘。
6. 桌面与紧凑布局截图进 `docs/verification/`。
