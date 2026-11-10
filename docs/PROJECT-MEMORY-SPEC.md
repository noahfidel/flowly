# 项目记忆：可审阅的跨卡共享记忆 + 完成卡复盘

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：§1.2 的“人确认才生效”、§3（文件与条目）、§5（确认与 RPC）、§6.5（晋升与淘汰）、§8（UI）、§9 的说明文案、§12 的“不自动确认或删除”；仍有效：§2、§4.0 线索采集、§4.1 工具校验、§4.2 复盘、§6.1–6.4 注入与召回算法。

状态：**已实现，待验收**（2026-10-22，卡片 `ce7f6007`，来自调研卡 `aa24ec64` 的 idea）。用户 2026-10-22 确认本 spec（“spec 确认，按 docs/PROJECT-MEMORY-SPEC.md 开始实现”）；§14 记录已做的决定，与设计稿不同的实现细节已在对应小节改写。

与卡片描述的两处出入（按现状修正，不是改需求）：

- 工具名：卡片写的 `kanban_remember` / `kanban_get_task` 是改名前的叫法，现在是 `flowly_*`（FLOWLY-NAMING-SPEC）。本文用 `flowly_remember`、`flowly_recall`、`flowly_get_task`。
- 注入通道：卡片说“依赖 Playbook idea 的注入通道”。该 idea（“项目 Playbook + 卡片验收标准”）已被驳回，验收部分由 Workpad 覆盖（WORKPAD-SPEC）。所以本功能不等 Playbook，直接用现有的任务上下文通道：`shared/scope.ts` 的 `sessionContext()`，它由 `BoardService.context()` 生成，在新建 session（`prepareSession`）和显式“Send Kanban work instructions”（`prepareExisting`）时进入初始指令。普通 follow-up 仍然只发用户原文。

## 1. 目的，以及值不值得做

### 1.1 问题

每张卡的 session 都从零开始。卡里做出的决策、踩过的坑，只留在那张卡的对话和 summary 里。要让下一张卡知道，现在唯一的办法是用户（或用户让 agent）手工写进 `AGENTS.md` 或某份 spec。

本仓库就是这么做的：`AGENTS.md` 已有 17.7 KB（约 5k token），里面有 9 处带日期或“user-approved / declined”的决策，每个 session 都要全量加载一遍。另有 70 多份 spec，其中散落着只和特定主题相关的坑，例如“Claude provider 不强制 `outputSchema`，recap 可能返回数组”（TASK-SUMMARY-SPEC §3）、“插件数据目录会被 Paseo 注册成原生 project”（TASK-SUMMARY-SPEC §2）。后来的卡碰到同一主题时，只有 agent 碰巧读到那份 spec 才会知道。

### 1.2 判断：知识累积有没有必要

有必要，但要做的是**整理**，不是**累积**：

- 必要的部分是**采集**和**按主题召回**：
  - 采集：对话里定下的事，现在要靠人记得去写，经常就丢了。
  - 召回：只和部分任务相关的知识，不该占每个 session 的上下文，也不该埋在 spec 里等人碰运气读到。
- 不必要、还有害的部分是**无限增长的知识库**。记忆越多，过时和互相矛盾的条目越多，会误导 agent。评论者对 Claude Projects 的批评正是记忆看不到、改不了。所以本设计：
  - 每条记忆都由人确认后才生效；
  - 条目有上限（§3.3）；
  - 新条目可以取代旧条目；
  - 显示每条最近一次被使用的时间，方便清理；
  - 应该人人遵守的条目可以一键转进 `AGENTS.md` 并退出注入（§5.4）。
- 对本仓库，收益中等：用户已经习惯把规矩写进 `AGENTS.md` 和 spec。收益主要在三处：采集不再靠人记；按主题的坑能到达对的卡；`AGENTS.md` 不必继续变长。对没有维护 `AGENTS.md` 习惯的项目，收益更大。

结论：做，但 v1 收窄成“人确认的决策和坑的清单 + 按主题注入”，不做语义检索，也不自动生效。

## 2. 什么放项目记忆，什么放 AGENTS.md

### 2.1 存什么：四个问题（2026-10-22 用户问“跨卡共享记忆到底要存什么”）

一句话：**存另一张卡的 agent 不知道就会重新问你、重新试一遍、或者重新踩一遍的东西**，而且这些东西还没写进代码、spec 或 AGENTS.md。

判断时问四个问题，每个问题对应一种类型：

| 问题 | 类型 | 存的是 |
| --- | --- | --- |
| 以后别的卡还会再问用户同一个问题吗？ | `decision` 决策 | 用户定下的取舍和理由，**包括否决的方案**（“不做 X，因为 Y”） |
| 有没有试过、查过但走不通的路？有没有修掉的 bug 背后的通用教训？ | `pitfall` 坑 | 现象、原因、怎么避开；以及“查过了，没有更好的办法，别再查” |
| 用户在这个项目里希望事情怎么做，但仓库里没写？ | `convention` 约定 | 用户的工作偏好和流程，例如 MR 描述按模板写、不用一直盯 CI、提交只带本卡的改动 |
| 有没有项目之外的人、系统、环境信息？ | `contact` 联系人与外部系统 | 找谁 review、哪个 Jira 项目、哪套测试环境、内部服务的地址（不含密钥） |

**不存的**：
- 本卡进度（summary）；
- 待办和以后再说的事：这类应该提成 idea 或建一张卡，否则会变成一条永远不会被处理的“记忆”；
- 代码、git 历史或文档里能直接读到的；
- 每个任务都必须遵守的规则：这类放 AGENTS.md（§2.3）。

**来自本机看板的实际数据**（2026-10-22，只读扫描，共 5 个项目、75 张卡、474 版 summary）。35 张卡的最新 summary 里有决策或发现类的要点，分类后：

| 要点（摘自 summary） | 卡片 | 归类 | 已经在别处了吗 |
| --- | --- | --- | --- |
| 设置页卡死，原因是两个 Modal 在同一帧切换，改为延迟 450 ms 再打开 | 增加 new user onboarding | `pitfall`：以后任何同时开关两个 Modal 的卡都会踩 | 只有代码里的修复，通用教训没写下来 → **该记** |
| 按钮放在标题栏里，悬停时标题栏误以为鼠标离开，把透明度设成 0 | 修复 lane 收起展开按钮 | `pitfall` | 同上 → **该记** |
| 最新 Paseo 源码里没有更跟手的输入方案，用户同意保持现状 | pad 版本支持桌面版布局 | `pitfall`（查过，别再查） | 没写下来 → **该记**，否则下张碰输入框的卡会再查一遍 |
| 用户要求不再盯 CI；MR 描述按模板补全 | 调整 service middleware 顺序（Search System） | `convention` | Search System 根目录没有 AGENTS.md → **该记** |
| 倾向在 mix 链路之后用稳定 hash 做替换，待产品与算法确认 | Video 供给竞争力分析（Search System） | 还没定，**不记**；确认后再记 `decision` | — |
| 工单只读，不同步状态、不推评论 | jira 工单接入 | `decision` | 已写进 EXTERNAL-TRACKER-SPEC 和 skill → **不记** |
| 手机端不做附图 | sidebar session 优化 | `decision` | 已写进 AGENTS.md → **不记** |
| npm Trusted Publisher 按你的决定稍后配置 | GitHub CI/CD 搭建 | 待办 | **不记**，应该是一张卡或一条 idea |
| 返工误回 Design，改为进 Development | 工作流拆分 | 产品行为 | 已写进 spec → **不记** |

由此得出：
- 在 **Flowly 项目**里，用户要求“决定要写进对应的 spec”，所以多数**决策**已经有归处，记忆的价值主要在**坑**，尤其是“修掉了但通用教训没写下来”和“查过、走不通”这两类。
- 在 **Search System** 这类公共根目录、根下没有 AGENTS.md 的项目里，**约定**和**联系人与外部系统**没有别的地方可放，记忆的价值更大。
- 这也说明复盘不该常常出结果：35 张卡里值得记的大约 5–8 条，平均每张 Done 卡 0–1 条。§4.2 的“宁缺毋滥”是按这个比例定的。


### 2.2 各存储的定位

| 存储 | 放什么 | 谁读到 | 生命周期 |
| --- | --- | --- | --- |
| 仓库指令文件（`AGENTS.md` / `CLAUDE.md`） | **每个任务都必须遵守**、和代码一起演化的规则：构建与测试命令、架构约束、产品不变量、编码规范 | 每个 session 原生全量加载，包括 Flowly 之外的 session、CI、队友 | 进 git，走 PR 审阅，跨机器共享 |
| spec / docs | 一个功能完整的行为、契约、验收 | 需要时去读 | 进 git |
| **项目记忆**（本功能） | **只和部分任务有关**、需要来源和日期、或**不适合进仓库**的知识：带理由的决策、踩过的坑、约定、联系人与外部系统 | 新卡 session 的初始指令里只注入相关条目（§6），其余按需用 `flowly_recall` 查 | 存在本机 daemon，按 Flowly 项目划分，人确认、可编辑，不进 git |
| 卡片 summary / workpad | 本卡的进度、验收标准与检查 | 本卡 | 跟着卡 |
| provider 自带记忆（如 Claude Code auto-memory） | 单个 provider 自己的记忆 | 只有该 provider 的 session | Flowly 不读也不写 |

和 `AGENTS.md` 相比，项目记忆的差异体现在五处：

1. **按需注入**：每条有类型和标签，只注入和新卡相关的几条，有字数上限。`AGENTS.md` 是全量注入。
2. **可溯源**：每条记着来源卡、提出者（agent、复盘或人）、确认时间，能点回来源卡。`AGENTS.md` 的一行规则看不出来由哪张卡、为什么定下。
3. **人确认的收件箱**：agent 和复盘只能提候选，人在 Flowly 里确认、修改或忽略。改 `AGENTS.md` 则要 agent 直接改仓库文件，再由人审 diff。
4. **不进仓库**：联系人、内部链接、个人偏好、和某台机器有关的坑，不会被推到远端。
5. **跨仓库**：一个 Flowly 项目可以是放了多个仓库的公共目录，或 linked root（PROJECT-PICKER-SPEC）。记忆按项目存，不属于任何一个仓库的 `AGENTS.md`。

provider 中立：同一份记忆对 Claude、Codex、Pi 的 session 都生效。provider 自带的记忆做不到这一点。

### 2.3 判定规则

agent 提候选前、复盘提炼时、人审阅时，都用同一组规则，按顺序判断：

1. 包含密钥、token、密码 → **哪里都不放**（daemon 拒绝，§4.1）。
2. 只关于本卡的进度或验收 → 卡片 summary 或 workpad，**不是记忆**。
3. 能从代码、git 历史或现有文档直接读出来 → 不记（可以在记忆里写一句“见 docs/X §n”作指针，但不要复制内容）。
4. 本仓库的每个任务都必须遵守，且适合公开进仓库 → **`AGENTS.md`**（记忆里出现这类候选时，审阅界面提供“转进 AGENTS.md”，§5.4）。
5. 其余会改变**之后另一张卡**怎么做的知识 → **项目记忆**。

例子：

| 内容 | 放哪里 | 理由 |
| --- | --- | --- |
| “改 client 代码后跑 typecheck 再 reload 插件” | AGENTS.md | 每个任务都适用 |
| “Claude provider 不强制 outputSchema，recap 可能是数组，解析要容错” | 记忆（坑，标签 `ai-features`） | 只有写子 session 输出解析的卡需要 |
| “手机端不接 expo-image-picker：用户 2026-10-21 拒绝” | 记忆（决策）；本仓库已写进 AGENTS.md，就不再重复记 | 规则 3：已有文档 |
| “Paseo registry 的提交走 issue form + submission 标签，联系 X” | 记忆（联系人） | 只和发版卡有关；含人名 |
| “本卡把 summary 改成每 5 轮一次” | 不记 | 规则 2：本卡进度；而且一旦实现，代码里就能读到 |

### 2.4 演练：Flowly 项目能总结出什么（2026-10-22）

用户问“以当前项目来说，能总结出什么记忆”，于是按本 spec 的规则手工演练了一遍，全程只读。

- **材料**：Flowly 项目 63 张卡，共 1312 条要点（所有版本 summary 的 recap 行去重、workpad 困惑点、失败过的检查、blocker 和 question 报告），另有用户在 Claude 会话里自己写的 364 条消息。Codex 会话的记录没有读。
- **筛选**：用 §2.1 的四个问题过一遍，再逐条对照 AGENTS.md、各 spec 和 docs，看是否已经写在别处。

**结果：留下 9 条，另有 1 条需要用户决定。** 其中 3 条更适合放进 AGENTS.md（§5.4 的转入流程）：

| # | 类型 | 内容 | 依据 | 现状 | 去向 |
| --- | --- | --- | --- | --- | --- |
| 1 | pitfall | 两个 Modal 在同一帧切换会让整个 Paseo 卡死。应先关一个、延迟再开，或在页内原地切换 | 两张卡各自踩过一次：“Show onboarding again 卡死”、“Add Jira connection 卡死” | 散在 ONBOARDING-SPEC §73 和 EXTERNAL-TRACKER-SPEC §2，第二次踩时没人读到第一处 | 记忆，建议转进 AGENTS.md（客户端规则） |
| 2 | pitfall | 宿主不提供 SVG，图表只能用 RN `View` 画柱状、堆叠和横条；Modal 标题只接受字符串和 icon，图标用内联 PNG | Insights 重设计卡、logo 卡 | 分别写在 INSIGHTS-REDESIGN-SPEC 和 ONBOARDING-SPEC | 记忆，建议转进 AGENTS.md 的客户端约束 |
| 3 | pitfall | 插件 SDK 不能打开文件，原生的打开动作依赖宿主内部的 `openTab`，本地路径链接只能做成复制 | 文本链接卡 recap | 没有写进任何 spec | **记忆** |
| 4 | pitfall | `board.json` 每卡只保留最近 100 条事件，统计和判断不要读事件，改读 `flow/<project>.jsonl` 或看板里的实体 | 至少 3 张卡的困惑点各自重新发现（ideas 提醒、Agent habits、整板读取根因） | 写在多份 spec 里，但每次都被重新发现 | **记忆**（附 spec 指针） |
| 5 | contact | 对话框关闭时闪两次之类的问题，先排除用户自己装的 `paseo-native-polish` 插件（JasprW/paseo-native-polish），曾查实根因在它 | 设置关闭重复动画卡 | 只在 PROGRESS 里 | **记忆** |
| 6 | contact | 手机测试经 AndroMeld 连接；`phone_connect` 报 “Android Use is turned off” 时，需要用户在 AndroMeld 设置里打开，agent 自己修不了 | 手机性能评测卡的 blocker | 只在 PROGRESS 里 | **记忆** |
| 7 | contact | connector 实测用的令牌在主目录 `~/.env`，项目 `.env` 只有发布用的令牌（已 gitignore）。只记位置，不记值 | connectors 卡的困惑点 | 没写下来 | **记忆** |
| 8 | convention | 提交身份用 Bofan Wang（GitHub JasprW），提交不带 Codex 或 Claude 的 co-author | 用户原话：“改全部 git 身份，用 JasprW”“为什么会带 codex coauthor” | git 配置里有身份，co-author 没写 | 记忆，建议转进 AGENTS.md（每次提交都适用） |
| 9 | decision | manifest 和 README 只写 Paseo 的版本下限，不设上限：没有真实的上限约束 | 用户原话：“为什么设置 paseo 版本上限？…去掉版本上限约束” | README 里已经去掉上限，但 AGENTS.md 的“pin to the host version”容易让人再加回去 | **记忆** |
| 10 | convention（待定） | 用户偏好最简单的方案：能覆盖就不累积，能人工就先人工，先用起来再说 | 用户原话：“我想要尽可能简单”“先不设限…我先用用看”“我不想搞那么复杂，新的覆盖老的” | 没写下来 | 由用户决定：这是偏好还是只在那几张卡里成立 |

**没有留下的**，以及原因：
- **已经写在别处**：Hermes 循环闭包、本机 daemon 例外、原生输入框、截图要裁掉宿主侧栏、Tinylink、PR 流程、registry 标签、onboarding 维护、手机端不做图片选择（以上在 AGENTS.md）；工单只读、洞察替换制、`maintainVisibleContentPosition`、Claude 不强制 `outputSchema`（以上在各自的 spec）。
- **本卡进度或 UI 微调**：占绝大多数，比如按钮对齐、动画、字号。
- **还没定或是待办**：手机输入被打断的根因未查明；Trusted Publisher 稍后配置（已于 10-21 完成）。
- **密钥**：有一条消息直接贴了 npm 令牌。§4.1 的 `MEMORY_SECRET` 和线索过滤必须挡住这类内容。

**结论**：
1. 平均每张卡约 0.15 条，和 §2.1 估计的 5–8 条同一量级。所以复盘“多数卡返回 0 条”是对的，审阅负担很小。
2. 10 条里有 3 条只出现在用户的普通消息里，不在 summary 里。因此 §4.0 的线索采集改为记录用户自己写的每条消息，不只记回答和反馈。
3. 3 条更适合放进 AGENTS.md。说明在 Flowly 里，记忆还有一个用途：先暂存，等被证明常用了再转进 AGENTS.md。
4. 和召回相关的数字：这 9 条全部注入约 1500 字，在 §6.2 的预算（2400 字）内。所以 Flowly 在相当长一段时间内会走“放得下就全部注入”这条路，按词召回的粗糙之处暂时不会暴露。

## 3. 数据与存储

### 3.1 文件

独立文件 `memory.json`，与 `board.json` 同目录，做法同 `summaries.json` 和 `digests.json`：串行写、写前备份 `.bak`、原子替换；内容无效时保留文件并报错，不重置。

不放进 `board.json` 的理由：客户端经常按 etag 读看板，手机在 JS 线程里解码（PERFORMANCE-SPEC）。200 条、每条 1000 字的记忆会让每次读看板都变重，而看板本身并不需要记忆正文。

```
{ version: 1,
  entries: MemoryEntry[],
  errors:  [{ taskId, at, message }],      // 复盘失败，每卡只保留最近一条
  retros:  [{ taskId, at, summaryId?, clueAt? }],   // 每卡最近一次复盘用到的 summary 版本和最新线索时间（§4.2 去重）
  recallStats: { [projectId]: { queries, empty } },  // 近 30 天 recall 次数与空结果次数（§6.4）
  clues:   [{ id, taskId, at, kind: "answer" | "feedback" | "message", ask?, text }] }  // 工作中采集的线索（§4.0）
```

### 3.2 MemoryEntry

```
{ id, projectId,
  kind: "decision" | "convention" | "pitfall" | "contact",
  title     非空，≤120 字符
  body      ≤1000：内容；决策写“定了什么 + 为什么”，坑写“现象 + 怎么避开”
  tags      ≤4，规则同卡片标签（CARD-TAGS-SPEC），尽量复用 projectTags
  keywords  ≤12 个检索词，每个 ≤40 字符：同义词、英文和中文两种说法、涉及的文件名或模块名，只用于召回（§6.2）
  pinned    boolean：始终注入（§6.2），每个项目最多 5 条
  status: "candidate" | "active" | "dismissed" | "archived",
  archivedReason?: "retired" | "promoted" | "superseded",
  supersedes?: id            // 候选要取代的 active 条目
  source: { by: "agent" | "retro" | "human",
            taskId?, agentId?,          // 来源卡与提出的 session
            eventId? }                  // agent 提出时写下的卡片事件，用于幂等（§4.1）
  revision: number           // 每条独立递增，人工编辑据此拒绝过期写入
  createdAt, updatedAt, confirmedAt?,
  usedAt?, usedBy?: string[] }   // 最近一次使用时间；最近 20 张用过它的不同卡片
```

- 状态转移：`candidate → active`（确认）、`candidate ↔ dismissed`、`active ↔ archived`、任意状态 → 永久删除。人新建的条目直接是 `active`。
- `usedAt` / `usedBy`：条目被注入新 session 或被 `flowly_recall` 返回时，记下时间和所在卡片（去重，最多保留 20 张）。尽力而为，每条最多一小时写一次；插件 reload 时丢失未写入的值。只用于 §6.5 的晋升和清理提示，从不自动删除或归档 active 条目。
- 来源卡被永久删除后，`source.taskId` 保留，界面显示“From a deleted card”。

### 3.3 上限

这些上限是给人审阅和注入预算定的，不是文件存不下：200 条 active 记忆，一个人还能逐条看一遍并维护，2000 条就做不到了。文件本身的容量见 §3.4。


| 项 | 上限 | 超出时 |
| --- | --- | --- |
| 每项目 active | 200 | 不自动淘汰；确认或新建时，界面让用户先从推荐的不常用条目里归档一条（§6.5） |
| 每项目 candidate | 50 | agent 收到 `MEMORY_LIMIT`；复盘丢弃多出的候选，记一条错误 |
| 每卡未处理的 candidate | 5 | `MEMORY_LIMIT` |
| 每项目 dismissed + archived | 200 | 删除最早的，写入 `removed/` 备份 |
| 每项目 pinned | 5 | 拒绝 |

### 3.4 为什么用文件存，不接外部记忆系统（2026-10-21 用户问：只靠文件存会不会太低效、有上限，要不要接 mem0 之类）

**效率不是问题。**
- 本机实测：`board.json` 有 2.7 MB（75 张卡、2880 条事件），Python 解析一次约 15 ms；`summaries.json` 有 0.5 MB。
- 记忆满额时是 200 条 × ≤1000 字，最坏约 0.6 MB（中文按 3 字节算），实际多半在 100 KB 以内。
- 读的时机很少：只在建 session、`get_task`、`recall` 和打开 Memory 页时读。daemon 把文件缓存在内存里，在 200 条上跑一遍打分是亚毫秒级。
- 写只在人确认或编辑、agent 提候选、复盘时发生，每次整文件原子替换只要几毫秒。
- 即使放开到上万条，线性扫描也只是毫秒级。§3.3 的上限是产品选择，不是存储的限制。

**文件存储真正的短板是召回质量，不是存储**：按词匹配对不上同义词，也对不上中英文混用（例如“摘要”和 summary）。这正是 mem0 一类系统的长处，它们靠向量相似度做语义召回。但在本插件里接它们，代价大于收益：

| | mem0 / OpenMemory 一类 | 本设计的要求 |
| --- | --- | --- |
| 写入 | 核心卖点是 LLM 从对话里自动抽取事实，自动新增、合并、删除 | 人确认后才生效；agent 只能提候选、不能改。这一点正是本卡要解决的问题（Claude Projects 被批评“记忆看不到、改不了”），接入后要把它的核心功能关掉 |
| 依赖 | 需要 embedding 模型和 LLM 的 API key（默认 OpenAI，或本机 Ollama），以及向量库（Qdrant 等，OpenMemory 还要 Docker + Postgres） | 插件现在只通过 Paseo 的 agent provider 调用模型，没有自己的 API key，也不要求用户额外装服务 |
| 数据去向 | 云端版把内容发到第三方；本地版也要把文本发给 embedding 服务 | 记忆里有联系人和内部信息，应当留在本机 |
| 一致性 | 外部库没有本插件的 revision 校验、`removed/` 备份、删卡和移除项目时的级联删除 | AGENTS.md：持久化在 daemon，串行写、原子替换、拒绝过期编辑、无效数据保留不重置 |
| 规模 | 适合几万到几百万条、无人审阅的记忆 | 每个项目几十到两百条、人逐条审过 |

**结论**：v1 用 `memory.json` 作为唯一的数据源，不接外部系统。召回质量分两步补：

1. **v1：检索词**。每条记忆带 `keywords`（§3.2），由 agent 或复盘在提候选时写，人可以改。打分时命中检索词加权（§6.2），一条记忆写清楚“摘要 / summary / summarizer”这类不同说法，就能解决大部分同义词和中英文对不上的问题，不需要 embedding。
2. **以后：可替换的召回层**。`shared/memory.ts` 的 `memoryForTask` / `recall` 写成一个排序接口，输入是条目和查询文本，输出是排好序的 ID。语义索引如果以后要做，只作为**派生数据**挂在这个接口后面：从 `memory.json` 重建，坏了就删掉重建，不存任何只有它才有的数据。可选的实现有本机 embedding 模型、用户配置的 embedding provider，或者 mem0 只当向量库用（关掉它的自动抽取）。

**什么时候再考虑**：任一项目的 active 记忆超过 150 条，或者 `flowly_recall` 有超过 30% 的查询返回 0 条（daemon 只统计次数，不记录查询内容）。到时另开一张卡评估，不在本卡做。

**和用户自己装的记忆 MCP 不冲突**：用户可以给 Claude 或 Codex 另外装 mem0 / OpenMemory 之类的 MCP，Flowly 不读也不写它们，和 provider 自带的记忆一样（§2.2）。

## 4. 来源

### 4.0 什么时候总结、多久一次、怎么总结（2026-10-22 用户问）

**先看数据**（本机流转日志，2026-10-15 至 10-21，只读）：每天移入 Done 10–22 次（含移出后再移入），agent 提问 7–18 次，从 In review 打回返工 35–88 次。

由此定三条原则：
- **用户的原话最值钱，但不在看板上**。决策和纠正发生在两个时刻：agent 提问后用户的回答，以及交付后用户的反馈。这些文字只在 session 的对话里，summary 只留下压缩后的几行，“为什么”和走不通的路往往被压掉了。所以要在工作中**把原话记下来**。
- **记原话不花 token，提炼才花**。采集按规则做，不调用模型；提炼每张卡只做一次。
- **不按时间定期总结**。记忆是按卡片产生的，卡片完成时材料最全；按天或按周总结会把多张卡的材料混在一起，也会在没有新材料时空跑。

于是分三层：

| 时机 | 频率 | 做什么 | 成本 |
| --- | --- | --- | --- |
| **工作中，agent 自己** | 每次交付时，由 agent 判断 | agent 在完整上下文里，按 §2.1 的四个问题用 `flowly_remember` 提候选（§4.1） | 0（agent 本来就在跑） |
| **工作中，daemon 采集线索** | 每轮结束（`agent.turn_ended` hook，不阻塞） | 按规则记下原话，不调用模型（见下文“线索采集”） | 0 |
| **卡片移入 Done** | 每卡一次；移出后再移入时，只有出现新线索或新 summary 才重跑 | 复盘：把线索、summary 历史和 workpad 交给 Summary model，提炼 0–1 条候选（§4.2） | 每卡一次 Haiku 调用，输入约 3–4k token |
| 定期 | **不做** | 过时和常用只按规则提示（§6.5），不调用模型合并或改写 | 0 |

按上面的数据，Flowly 每天约 10–20 次复盘调用。考虑过但不采用的做法：
- 每轮都提炼：每天上百次调用，大部分轮次（“继续”“提交”）没有可记的东西；
- 按周批量提炼：材料要等一周，而且卡片可能已经收尾，session 被归档；
- 只在 Done 时读 summary：summary 是压缩后的结果，会丢掉“为什么”。

**线索采集**（规则，`server/memory.ts`）。在 `agent.turn_ended` 时，取本轮 timeline 开头的 `user_message`，经过下面的过滤后记一条线索。用户自己写的每条消息都记，并按场景标出类型，复盘时据此给权重：

- `answer`：本轮开始前，这个 session 在本卡最后一次报告是 `kind=question`，且之后没有新的报告 → 同时记下问题（`ask`，取自该报告的 note）；
- `answer`：本轮 timeline 里有用户通过原生提问工具给出的回答 → 每个问题记一条，`ask` 是问题，`text` 是回答。回答很短也记（有问题作上下文），只过滤空回答和密钥。格式于 2026-10-22 用本机真实 timeline 和 Paseo 源码核对（`shared/memory.ts` 的 `questionAnswers`）：
  - **Claude `AskUserQuestion`**：同一轮里一条已完成的 `tool_call`。问题在 `detail.input.questions[].question`，回答在 `detail.output.output` 里，形如 `"问题"="回答"`。外层句子随 Claude Code 版本不同（实测有 `Your questions have been answered: …` 和 `The user answered: …` 两种），所以只解析引号对。
  - **Codex `request_user_input`（同步）**：同一轮里一条已完成的 `tool_call`，`metadata.questions[]`（`id`、`question`）加 `metadata.answers`（按问题 id 的回答数组，多选用 “, ” 连接）。
  - **Codex `request_user_input_async`（异步）**：本轮只发出问题，回答之后作为一条用户消息送回给 Codex，开头是 `Answers to your questions:`，每个问题一段“问题行 + 回答行”。从这条消息解析回答；如果它是一轮的第一条消息，不再另记成 `message`。异步工具调用本身不读：已答和未答时渲染出的文本结构相同，被关闭时末尾是 `Dismissed`。
  - 被关闭、失败或中断的提问不记。同一个问题的线索 id 由 session 和调用 id 组成，同一轮被重复送进 hook 也只记一次。
  - Pi 的提问工具本机没有可核对的记录，暂不处理。
- `feedback`：本轮开始时卡片在 In review，也就是交付后的回复；
- `message`：其余用户自己写的消息，包括卡片的第一条指令。

2026-10-22 起，用户自己写的消息都记录，不再只记回答和反馈。演练（§2.4）中 10 条该记的内容有 3 条只出现在用户的普通消息里（提交身份、版本上限、偏好简单方案），只记回答和反馈会漏掉它们。

过滤：
- 少于 15 个字符的不记，例如“继续”“好”“commit and push”；
- 文本与某条 next move 或 idea 指令完全相同的不记：那是用户点选的建议，不是用户自己写的话；
- 命中密钥规则（§4.1 `MEMORY_SECRET`）的整条不记。演练中就有一条消息里贴了 npm 令牌；
- 每条最多 600 字符；每卡最多 30 条，超过时保留第一条（卡片的原始要求），去掉其余最早的。

保存：
- 线索只用作复盘的输入，不注入，也不显示在 Memory 页；
- 复盘成功后保留 30 天（便于手动重跑），之后删除；
- 删卡、移除项目时一并删除，并写入备份；
- 记忆关闭（§9）时不采集。


### 4.1 Agent 工具 `flowly_remember`

输入（strict）：

```
{ expectedRevision, request,              // 同其他写工具，来自 flowly_get_task
  kind: "decision"|"convention"|"pitfall"|"contact",
  title, body,
  tags?: string[] = [],
  keywords?: string[] = [],              // 召回用的检索词（§3.2）
  supersedes?: string }                   // 要取代的 active 条目 ID
```

- 身份、签名、过期、revision、归档与已完成的检查，都和 `flowly_propose_idea` 相同；不改卡片状态，也不改 task revision。
- 写入顺序（2026-10-22 实现时定）：
  1. 先在看板外做记忆校验（关闭、重复、超限、密钥、supersedes），被拒绝的调用不留回执；
  2. 再走与其他写工具相同的看板事务：回执放在 `board.agentReceipts`，卡片记 `memory_proposed` 事件；
  3. 最后写 `memory.json`，按该事件的 id（`source.eventId`）幂等。

  看板事务的回调是同步的，不能在里面等 `memory.json` 写完，所以顺序和设计稿相反。第 3 步丢失（例如 daemon 正好重启）时，用同一请求重放会拿到原回执，并按 eventId 补写那条候选，不会多出一条。重放时参数相同返回原回执和原 `memoryId`，参数不同报 `REQUEST_REUSED`。
- 事件：来源卡记 `memory_proposed`（agent，note=标题）。
- 错误：
  - `MEMORY_DISABLED`：项目关闭了记忆（§9）。
  - `MEMORY_DUPLICATE`：本项目已有同标题的 candidate 或 active 条目（去首尾空白、忽略大小写），消息里带已有 ID，并提示可以用 `supersedes` 取代它。
  - `MEMORY_LIMIT`：§3.3。
  - `MEMORY_SECRET`：标题或正文命中密钥规则。复用 Workflow insights 的脱敏规则（`shared/workflow-insights.ts`），命中就拒绝，不做替换后保存。
  - `INVALID_INPUT`：`supersedes` 不是本项目的 active 条目。
- 输出：`toolResultSchema`，多一个 `memoryId`。
- CLI 新增 `remember --request-file … --kind … --title … --body … [--tags a,b] [--supersedes <id>]`；HTTP `/api` 的 `action` 新增 `"remember"`。

### 4.2 完成卡复盘（Done 时提炼候选）

复用 summarizer 子 session 的跑法（TASK-SUMMARY-SPEC §2，PROJECT-INSIGHTS-SPEC §7）。

- **触发**：卡片进入 Done（任何人移入都算），项目记忆开启（§9），且复盘设置开启。Cancelled 不触发：取消的卡多半没有结论可沉淀，需要时可以手动触发。
- **等待**：进入 Done 后等 30 秒，让最后一轮的 summary 写完；该卡的 summarizer 还在运行时，最多再等 120 秒。
- **跳过**：
  - 卡片既没有 summary，也没有 workpad 困惑点或进展记录 → 没有素材，跳过；
  - 上次复盘之后既没有新 summary（`retros[].summaryId`），也没有新线索（`retros[].clueAt`）→ 跳过，避免卡片在 Done 和其他列之间来回移动时重复跑。
- **运行位置**：项目的「Flowly background」workspace（[BACKGROUND-WORKSPACE-SPEC](BACKGROUND-WORKSPACE-SPEC.md)：用前恢复已归档的那个复用，没有才新建，最后一个后台 run 结束后归档）。不用卡片自己的 workspace，因为自动收尾可能紧接着就把它归档掉（MULTITASK-SPEC），也不能按目录找“项目根 workspace”：single-root 下每张卡的 workspace 目录都是项目根，旧规则曾让所有 review 落进同一张卡（2026-10-23 修复）。标签：`flowly=summarizer`、`flowly-project=<id>`、`flowly-task=<taskId>`；模型用 Summary model（Auto 同解析）；`waitForFinish(120000)`，`finally` 中**硬删除**（`server/summarizer-remove.ts` 的 `daemonRemoveAgent`，本地 `DaemonClient.deleteAgent`，与 card summarizer 同一条 AGENTS.md 例外，用户 2026-10-22 批准；只删本次刚创建的 id），删除失败则回退归档并记日志。运行的几十秒内它在后台 workspace 里短暂可见，结束后 session 与 workspace 都不留在侧栏。每个项目同时最多跑一个，其余排队。
- **输入**（≤10000 字）：
  - 项目名；卡片标题、类型、标签、描述（≤2000）；
  - 本卡的线索（§4.0），按时间排列，总长不超过 5000 字，超出时优先保留 `answer`；
  - summary：最新一版的 target / recap / next，加上**所有历史版本里出现过的 recap 行**（去重）。早期的发现常在后面的版本里被挤掉；
  - workpad 的困惑点，以及失败过的检查（含后来通过的，“先失败后通过”往往就是一个坑）；
  - 本卡最近 10 条 blocker / question / result 进展（每条 ≤500）；
  - 本项目 active 记忆的 ID、类型、标题（≤100 条），用来避免重复，必要时提出取代；
  - 本项目还在等审阅的候选（类型、标题），不要重复；
  - 本项目被用户忽略过的候选（最近 30 条，类型、标题），告诉模型这个项目不要什么；
  - 项目根目录的 `AGENTS.md` 和 `CLAUDE.md`（内容相同只算一次，缺失跳过），排在卡片材料之后，单独限 20000 字，不挤占卡片材料的 10000 字。读的是复盘时磁盘上的文件，所以本卡自己刚写进指令文件的规则也不会再被提成记忆。
- **输出 schema**：`{ candidates: [{ kind, title, body, tags, keywords, evidence, reuse, supersedes? }] }`，**0–1 条**（`RETRO_MAX_CANDIDATES`）。`reuse` 写出一张做**别的功能**、会因为不知道这条而出错的后续卡（如“任何从一个弹窗里再打开弹窗的卡”）；`reuse` 为空的候选在截取上限之前就丢弃，不存储。`evidence`（≤300 字）引用依据的原话或 recap 行，审阅界面在候选下方以弱化引用的形式显示，方便人快速判断真假；agent 用 `flowly_remember` 提的候选没有这个字段。prompt 要点：
  - 默认是空；最多提一条，而且必须通过通用性检验：能举出一张做**别的功能或模块**的后续卡需要它。举得出的只有同一功能、同一文件、同一个 bug 或同一设计的卡，就不提，那些知识留在本卡的代码和 summary 里。本卡功能本身怎么设计、怎么实现的，即使是用户拍板的，也不算项目记忆；
  - 按 §2.1 的四个问题判断类型；
  - 不提与已忽略候选同类的，也不提已在等审阅的；已有条目讲的是同一个问题，即使换了说法或多了细节，也算已有；
  - 不使用工具；
  - 修掉的 bug 只在有通用教训时才提，写教训，不写修复本身；查过、走不通的结论要提；
  - 还没定的、以后再说的不提（那是 idea 或卡片）；
  - 不提本卡进度，不提仓库指令文件里已经写了的；
  - 按 §2.3 判定；
  - 宁缺毋滥，没有就返回空数组；
  - 语言用 outputLanguage（AI-LANGUAGE-SPEC）。

  解析容错同 TASK-SUMMARY-SPEC §3。
- **结果**：
  - 每条候选的 `source.by` 记为 `"retro"`，并记来源卡；没有通过 §4.1 校验的丢弃：重复的静默丢弃（模型看到了已有标题，重复不算失败），超限和命中密钥的记一条错误；
  - 来源卡记 `memory_proposed` 事件（actor system）；
  - 失败、超时时记到 `errors`，不自动重试。
- **手动**：Done 或 Cancelled 卡的侧栏有 **Find memories** 按钮，忽略“跳过”条件立即跑一次。

## 5. 人工确认与编辑

### 5.1 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `memory.read` | `{ projectId, etag? }` | `{ etag, value?: { entries, errors, running: taskId[] } }`；只在 Memory 页或卡片侧栏的记忆段可见时读 |
| `memory.counts` | `{ etag? }` | `{ etag, value?: { [projectId]: candidateCount } }`：总览栏 chip 用，与其他 `*.read-changed` 读取同频 |
| `memory.create` | `{ projectId, kind, title, body, tags, pinned }` | 人新建，直接生效 |
| `memory.update` | `{ id, revision, kind?, title?, body?, tags?, pinned? }` | 编辑 candidate 或 active |
| `memory.confirm` | `{ id, revision, edits? }` | candidate → active；可以同时带上修改；有 `supersedes` 时，在同一次写入里把旧条目归档（`superseded`） |
| `memory.dismiss` / `memory.restore` | `{ id, revision }` | candidate ↔ dismissed；archived → active |
| `memory.archive` | `{ id, revision, reason: "retired" \| "promoted" }` | active → archived |
| `memory.delete` | `{ id, revision }` | 永久删除，写入 `removed/memory-<id>-<time>.json` |
| `memory.retro` | `{ taskId }` | 手动复盘（§4.2），返回 `{ queued: true }` |

- 所有写入都校验 `revision`。不一致时报 `MEMORY_CONFLICT`：“This memory changed elsewhere. Reload to see the latest.”，什么都不改。这就是“拒绝过期编辑”：人和 agent、两个窗口同时改时，后到的那次被拒绝，不会被静默覆盖。
- 项目已归档时只读。

### 5.2 确认的语义

确认是一个人的动作：从此这条进入注入。agent 写的候选可能不准确，所以确认前可以先改（Edit → Save and confirm）。确认之后，agent 不能修改或删除任何条目，只能提出新的候选来取代旧条目。

### 5.3 记忆与来源卡的关系

记忆属于项目，不属于卡：

- 卡片 Done、收尾、归档，都不影响它的记忆和候选（同 IDEAS-INBOX-SPEC §2）；
- 卡片被永久删除时，删除它的 **candidate / dismissed** 条目（写入卡片的 `removed/` 备份），**active / archived** 条目保留，因为它们已经是人确认过的项目知识。

### 5.4 转进 AGENTS.md（promote）

对符合 §2.3 规则 4 的条目，在条目菜单里提供 **Copy as AGENTS.md rule**：

1. 把条目格式化成一条规则（`- <title>: <body>`）复制到剪贴板，并提示用户粘贴到哪个仓库的指令文件；
2. 用户点 **Done, stop injecting** 后，条目归档（`promoted`），不再注入，避免同一条规则在 `AGENTS.md` 和记忆里重复出现。

插件**不写**仓库文件：写哪个仓库、写在哪一节、要不要进 PR，都由用户决定。工作区是多个 session 共享的，插件改文件会和它们的改动混在一起（见 §14 Q1）。

## 6. 使用：注入、get_task、recall

### 6.1 初始指令

`sessionContext()` 新增参数 `memoryLines`，放在 artifacts 行之后、`Project:` 之前：

```
Project memory (confirmed by the user; 4 of 37 shown, flowly_recall finds the others):    ← 全部放得下时为 “all N entries”
- [Decision] Summarizer runs in the project root workspace: auto wrap-up may archive the card's own workspace (memory m_3f2a, from "Task summary")
- [Pitfall] Claude ignores outputSchema: accept arrays for recap and "true"/"false" for booleans (memory m_91c0)
…
```

- 只有项目记忆开启、且至少选中一条时才出现。
- 每条一行：`- [类型] 标题: 正文前 200 字…（memory <短 ID>[, from "<来源卡标题>"]）`。
- 新建 session 和显式 work instructions 时出现；普通 follow-up 不出现（AGENTS.md 的约束）。

### 6.2 选择算法（纯函数 `shared/memory.ts` 的 `memoryForTask`）

预算：最多 8 条，渲染后合计最多 2400 字符（约 600–800 token）。

1. 候选池：本项目的 active 条目。
2. **小项目全给**：全部条目渲染后放得进预算时，全部注入。排序：pinned 在前，然后按类型（decision、convention、pitfall、contact），同类按确认时间从新到旧。
3. 否则：
   - pinned 条目先放入；
   - 其余按相关度打分，分数 ≥2 的从高到低放入，同分按确认时间从新到旧，直到预算用完：
     - 每有一个和卡片相同的标签 +3；
     - 卡片文本（标题 + 描述前 2000 字）与条目文本（标题 + 标签 + keywords + 正文前 300 字）的共同词，每个 +1，最多 +4。命中 keywords 的词每个 +2，这样“摘要 / summary / summarizer”之类不同说法也能对上。英文按 `[a-z0-9_-]{3,}` 切词并去掉小停用词表；中日韩文字取连续汉字的二字组；
   - 分数不够的不硬塞：宁可少注入，也不注入无关条目。
4. 标题行写明“N of M shown”，提示 agent 用 `flowly_recall` 查其余条目。

已知限制：新卡在 session 创建时往往还没有标签，标签通常是 agent 开工后才打的，所以初始指令主要靠词重叠。`flowly_get_task` 每次按当前标签重新计算（§6.3），可以补上这一点。

### 6.3 `flowly_get_task`

上下文新增：

```
memory: {
  enabled,
  total,                         // active 条目数
  entries: [{ id, kind, title, body, tags, pinned, sourceTaskId?, confirmedAt }],  // 按当前标签重新选，正文完整
  candidates: [{ id, title, status }] }   // 本卡提出的候选（最近 20 条），用来避免重复
```

记忆关闭时为 `{ enabled: false, total: 0, entries: [], candidates: [] }`。

### 6.4 `flowly_recall`（只读）

`{ query: string ≤200, kind?, limit = 5 (≤10) }` → `{ entries, total }`。

- 用 §6.2 的打分，把卡片文本换成 `query`；`query` 为空时返回最近确认的条目。
- 只要求身份，不需要 `request`。CLI 新增 `recall --query … [--kind …]`；HTTP `/api` 新增 `"recall"` 读动作。
- `memory.json` 按项目记 `recallStats: { [projectId]: { queries, empty } }`（近 30 天，只记次数，不记查询内容），用来判断 §3.4 的“什么时候再考虑”。Memory 页底部显示一行弱化的 “Recall: 42 searches, 5 found nothing (30 days)”。

### 6.5 生命周期：晋升与淘汰（2026-10-21 用户追问“记忆满了怎么办、怎么淘汰、怎么晋升”）

“满”有两种，处理方式不同：

| | 什么满了 | 结果 |
| --- | --- | --- |
| **注入满** | 一个新 session 的预算（8 条 / 2400 字）放不下所有相关条目 | 不淘汰任何条目。只注入 pinned 和分数最高的，其余条目照样在库里，agent 用 `flowly_recall` 查得到 |
| **存储满** | 本项目 active 条目到 200 条 | 不自动淘汰，由人决定归档哪条（见下文“淘汰”） |

条目分成四层，越往上覆盖面越广。晋升是往上走，淘汰是退出注入：

```
                晋升 ▲
  AGENTS.md     每个 session 原生全量加载（离开记忆：archived · promoted）
      ▲  Copy as AGENTS.md rule
  pinned        每个新 session 都注入，≤5 条
      ▲  Pin
  active        相关时注入，或被 recall 查到
      ▲  Confirm
  candidate     不注入，等人处理
                淘汰 ▼
  archived      不注入，也查不到，保留历史，可以 Restore
      ▼  archived + dismissed 超过 200 条时最早的
  永久删除      写入 removed/ 备份
```

**晋升**由使用数据给出建议，由人点按钮执行：

- **常用**：一条 active 非 pinned 条目最近 30 天被 ≥5 张不同的卡用过（`usedBy`），条目上显示 “Used by 6 cards”，并给出 **Pin** 和 **Copy as AGENTS.md rule** 两个按钮。
- **pinned 条目**：条目下方常驻一行提示：“Pinned memories reach every new session, like AGENTS.md. If this is a rule for the code, move it there.”。pinned 已满 5 条时，必须先取消一条才能再 Pin。
- **转进 AGENTS.md**：见 §5.4。转进之后条目归档（`promoted`），不再注入，同一条规则不会出现两次。

**淘汰**分三条路，其中只有第一条是自动的：

1. **被取代**（自动）：确认一条带 `supersedes` 的候选时，旧条目在同一次写入里归档（`superseded`）。这是 agent 纠正记忆的唯一途径。
2. **过时**（只提示）：active、非 pinned、60 天没被用过（从未用过的，从确认时间起算）的条目标为 “Stale”。Memory 页有 **Clean up · N** 筛选，可以逐条归档，也可以点 **Archive all stale**（二次确认）一次全部归档。
3. **存储满**（人选）：
   - active 达到 180 条时，Memory 页顶部出现提示：“180 of 200 memories. Archive stale ones to keep room.”，链接到 Clean up；
   - 达到 200 条时，确认候选或新建条目会弹出 **Make room**：列出 5 条最久没用的非 pinned 条目，选一条归档后，原来的操作继续执行；也可以取消，候选保持不变。agent 仍然可以提候选，候选有自己的上限，不会因为 active 满了而被拒绝。

**为什么 active 条目不自动淘汰**：它们是人确认过的知识，“很久没用”可能只是最近没碰那个模块。自动删掉，就等于让系统替人判断哪些知识过时了，这正是 Claude Projects 被批评的地方。唯一的自动删除只针对**已经退出使用**的条目：archived 和 dismissed 合计超过 200 条时，删除最早的，并写入备份。

## 7. Skill 规则（`server/skill-source.ts` 与 `skills/flowly/SKILL.md`，英文）

新增一条：

- Project memory in your instructions and in `flowly_get_task` `memory` holds decisions, conventions, pitfalls and contacts that the user confirmed on earlier cards. Follow them. If one conflicts with the repository's instruction files or the user's current request, say so and ask; do not pick silently. Use `flowly_recall` when you start on an area that the shown entries do not cover.
- When something would make a different, later card's agent re-ask the user, retry a dead end or hit the same problem, propose it: a decision the user made, including a rejected option and why (decision); a dead end or a general lesson behind a bug you fixed, not the fix itself (pitfall); how the user wants work done in this project that the repository does not say (convention); people, external systems and environments (contact). Propose it with `flowly_remember`. Only what holds beyond this card: if every later card that would need it works on the same feature, file or bug, leave it to the code and the summary. At most 3 per delivery, usually none. Do not propose this card's progress (that is the summary), open or deferred decisions (those are ideas or cards), what the code, git history or docs already say, or rules the repository's instruction files already contain. If a rule belongs in `AGENTS.md` for every task, still propose it here; the user can move it there. Never include secrets. To correct an entry, propose a new one with `supersedes`; you cannot edit or delete entries.

交付时的提醒（NEXT-MOVES-SPEC §9）不加记忆提醒：多数卡没有值得记的东西，提醒只会诱发凑数，而复盘已经兜底。

## 8. UI

### 8.1 项目 Memory 页

- 入口：总览栏的 **Memory** chip，有待审候选时显示数量，例如 `Memory 3`。快捷键 `M`（SHORTCUTS-SPEC 里未占用）。项目标签的右键菜单也有 Memory。页面整页打开，对齐 Ideas / Insights 页，顶部 `‹ Board` 返回，Esc 同样返回。
- **To review · N**（有候选时）：每条候选是一张 `ContentCard`，内容为：
  - 类型、标题、正文、标签；
  - 来源行 “From <卡片> · suggested by agent / by the finished-card review · 2h ago”，点击打开来源卡；
  - 复盘提出的候选在下方以弱化引用显示 `evidence`（依据的原话或 recap 行）；
  - 有 `supersedes` 时多一行 “Replaces: <旧标题>”，旧正文以弱化色显示，便于对比；
  - 按钮：**Dismiss**、**Edit**、**Confirm**（主操作）。Edit 原地展开表单（类型、标题、正文、标签、Pin），保存按钮为 **Save and confirm**。
- **Memory · N**：
  - 类型筛选 chip（All / Decisions / Conventions / Pitfalls / Contacts / Clean up · N）和搜索框；
  - 每条显示标题、正文、标签、Pin 图标、来源，以及 “Used 3d ago · 4 cards” / “Not used yet”；常用条目显示 “Used by N cards” 和晋升按钮，过时条目显示 “Stale”（§6.5）；
  - 达到 180 条时显示容量提示；达到 200 条时，确认或新建会先弹出 Make room（§6.5）；
  - 条目菜单：Edit、Pin / Unpin、Copy as AGENTS.md rule（§5.4）、Archive、Delete…（确认对话框：“Delete this memory? New sessions will no longer see it.”）；
  - 顶部 **Add memory**。
- 页面顶部一组分段（与 Ideas 页一致，2026-10-23 用户要求）：**Memory N**（上面的 To review 与 Memory 区）、**Archived N**、**Dismissed N**。后两段列出对应条目，提供 Restore 和 Delete；Dismissed 的 Restore 回到待审阅（candidate），Archived 的回到 active。取代原来默认折叠的 “Archived & dismissed · N”。
- 空状态：“Nothing remembered yet. Agents suggest decisions and pitfalls as they work, and finished cards are reviewed for them. You confirm what stays.”
- 动效、文本输入、无障碍遵守 AGENTS.md 的通用规则：确认、忽略、归档、恢复、删除的收起动效与 Ideas 一致（Memory 页与卡片侧栏的卡片行都复用 `useExitList` + `IdeaRow`，新到达的行上浮淡入；搜索框输入时整个列表重建，不逐行收起）；Archived & dismissed 区和 Add memory 编辑器用 `Collapse` 展开收起，箭头随之旋转；编辑卡片时编辑器与卡片互换带淡入（`client/motion.tsx`），输入框用 `TextBox` / `Field`，所有字符串走 `t()`。成功的瞬时操作用原生 toast。

### 8.2 卡片侧栏

在 Ideas 之后放 **Memory** 段。它和 Ideas 共用侧栏的同一个位置（Settings → Cards 的排序里不单列一项），只在以下情况渲染：

- 本卡有候选或由本卡产生的条目：候选的操作与 Memory 页相同（同一组件）；已确认的条目只显示 “Remembered from this card: N”，链接到 Memory 页；
- Done / Cancelled 卡：显示 **Find memories** 按钮，复盘运行中显示 “Reviewing…”，失败时显示一行弱化错误。

### 8.3 冲突与错误

收到 `MEMORY_CONFLICT` 时弹 error toast，立即重读该项目的记忆，编辑表单保留用户输入的文字，让用户重新提交。

## 9. 设置

- 2026-10-22（ONBOARDING-SETUP-SPEC §6）：新增 host 设置 `features.memory`（默认开），在 Settings → AI features → **Project memory** 和欢迎导览第 3 页。关闭时所有项目都按 `Project.memory === false` 处理（`server/memory.ts` 的 `memoryOn` 由插件的设置订阅保持最新）；项目菜单、概览栏的 Memory 入口和卡片侧栏的 Memory 区隐藏。开启时仍由每个项目自己的开关决定。

- 项目设置新增 `Project.memory?: boolean`，缺省视为开（同 `Project.workpad`）。开关文案 **Project memory**，说明 “Share confirmed decisions and pitfalls with new sessions on this project.”。关闭后：
  - 不再注入；
  - `flowly_remember` 返回 `MEMORY_DISABLED`；
  - 不再复盘；
  - 已有数据保留，Memory 页只读显示。
- 全局 `task-summary` 设置新增 `retroEnabled`（默认 `true`，见 §14 Q2），在 Settings → AI features 中显示为 **Find memories in finished cards**，说明 “When a card moves to Done, the summary model suggests up to 3 things worth remembering. Uses a few tokens per card.”。

## 10. 删除、归档与移除

- 永久删除卡片：见 §5.3。
- Remove 项目：该项目全部条目、错误、复盘记录写入 `removed/<projectId>-memory-<time>.json` 后删除。
- 归档卡片或项目：不动记忆；项目归档后 Memory 页只读。
- 本功能新增 `memory.json`，不改 `board.json` 的版本，也不迁移。

## 11. 引导（ONBOARDING-SPEC）

- 欢迎导览的功能列表加一行：“Project memory: decisions and pitfalls you confirm carry over to new cards' sessions.” README highlights 同步。
- 新的一次性提示 `first-memory-candidate`：第一次出现候选时提示 “An agent suggested something to remember. Confirm it and new sessions on this project will know it.”，指向 Memory chip。提示规则补进 `client/onboarding-logic.test.ts`，spec 的提示表同步。
- 新字符串加入全部语言目录。

## 12. 不做（v1）

- 向量或语义检索、外接记忆系统（理由与以后什么时候再考虑，见 §3.4）；跨项目记忆；记忆的版本历史（只保留当前版本和取代链）。
- 自动确认或自动删除；按“很久没用”自动归档。
- 插件写仓库文件（包括镜像到仓库或写 `AGENTS.md`，见 §5.4、§14 Q1）；读写 provider 自带的记忆。
- 在普通 follow-up 里附带记忆；每轮回合结束后提炼候选。
- 显示“这条记忆被注入过哪些 session”的明细；v1 只记 `usedAt`。

## 13. 风险

- **过时的记忆误导 agent**：靠人确认、取代链、“Not used / Used Nd ago”提示和 skill 的“冲突就问”来缓解，但无法根除，需要人定期看一眼。
- **审阅负担**：多了一个收件箱。缓解：复盘最多 1 条且须通过通用性检验、被忽略过的候选会作为反例交给下一次复盘、prompt 默认返回 0 条、每卡最多 5 条未处理候选、不加交付提醒。
- **按词重叠召回粗糙**：中文二字组会误配，新卡没有标签时漏配。缓解：小项目全给、`flowly_recall`、get_task 按当前标签重新选。
- **上下文开销**：每个新 session 最多约 800 token；对比 `AGENTS.md` 的 5k 很小。条目转进 AGENTS.md 后停止注入，不会重复计算。

## 14. 决定记录（2026-10-21）

- **Q2 复盘默认开**：用户已确认。用 Summary model（Haiku），每张 Done 卡一次（§4.2、§9）。
- **复盘收紧（2026-10-22）**：用户反馈候选太多、很多是任务专有的。Flowly 上前 5 次复盘产生 9 条候选，用户处理的 7 条里只留了 1 条（被忽略的都是本卡设计细节，或仓库指令里已有的规则）。改为：每卡最多 1 条；必须写出 `reuse`（一张做别的功能的后续卡），写不出就丢弃；把等审阅的和被忽略过的候选交给模型做反例；把项目根目录的 `AGENTS.md` / `CLAUDE.md` 交给模型，已写成规则的不再提。已有条目“换个说法、多些细节”也算重复。用旧材料重放这 5 张卡（只读，Haiku，隐藏每张卡自己产生的条目）：9 条降到 0 条。用户留下的那条（`msg()` 标记）也不再提，因为 `AGENTS.md` 的 i18n 规则已经写了它（见 `docs/verification/project-memory.md`）。代价：更严的门槛也可能漏掉真正通用的条目，需要用一段时间再看。agent 用 `flowly_remember` 提候选时也加上同样的通用性检验（§7）。
- **Q1 怎么转进 AGENTS.md**：用户回答“不知道”。采用推荐方案：复制成规则，用户贴进去后点 Done，条目停止注入（§5.4）。理由：插件不写共享工作区里的仓库文件；多仓库项目要由人决定写进哪个仓库。备选方案（插件直接追加到文件、建一张卡让 agent 去改）在验收时仍可改。
- **§2.4 第 10 条（偏好最简单的方案）**：用户 2026-10-22 确认算长期偏好；实现后与其余 9 条一起作为候选导入 Flowly 项目，由用户审阅。
- **Q3 记忆少时是否全部注入**：用户回答“不知道”，并追问记忆满了以后怎么办。采用推荐方案：放得下就全部注入，放不下才按相关度选；“满了”的处理、晋升和淘汰写在 §6.5。

## 15. 验收

卡片原文（不弱化）：

- 在卡 A 中确认的一条决策，在之后新建的卡 B 的 session 初始指令中出现；
- 记忆可在 UI 中修改和删除。

具体检查：

- 单元：
  - `memoryForTask`：小项目全给、预算截断、pinned 优先、标签与词重叠打分、keywords 加权（中英文两种说法都能命中）、阈值、中文二字组、排序稳定；`recallStats` 只计数；
  - `flowly_remember`：回执重放与 `REQUEST_REUSED`、看板提交失败后重试不重复、`MEMORY_DUPLICATE`、`MEMORY_LIMIT`、`MEMORY_SECRET`、`MEMORY_DISABLED`、不改 task revision；
  - RPC：`revision` 冲突返回 `MEMORY_CONFLICT` 且不写、确认时取代旧条目原子完成、上限与修剪、删除写备份；删卡与移除项目的级联；`memory.json` 无效时保留文件并报错；
  - 生命周期（§6.5）：`usedBy` 去重与 20 张上限；常用（30 天内 ≥5 张卡）与过时（60 天）的判断；pinned 上限；active 满 200 条时确认被要求先腾位置，且从不自动归档 active；archived + dismissed 超过 200 条时修剪最早的并写备份；
  - 线索采集（§4.0）：提问后的回答、原生提问工具的回答、In review 后的反馈各记一条；短消息和点选 next move 的不记；600 字截断、每卡 30 条上限；记忆关闭时不采集；复盘后 30 天清理；删卡时级联删除；
  - 复盘：触发与跳过条件、去重（没有新 summary 也没有新线索时不再跑）、`evidence` 字段、输入构造与截断、输出解析容错、失败记错误、子 session 成功和失败都会被移除（硬删除，删除失败回退归档）；
  - `sessionContext` 的记忆段，以及关闭时不出现；get_task 的 `memory` 字段；
  - 提示规则 `first-memory-candidate`；i18n 目录完整。
- `npm run typecheck`、`npm test`；安装并 reload 插件。
- Luna 6 全权限测试 session，在 Tinylink 上新建的测试卡里完成：
  1. 卡 A 的 agent 用 `flowly_remember` 提一条决策 → Memory 页出现候选 → 人编辑后确认；
  2. 新建卡 B 并 Start session → 读取该 session 的初始指令，确认包含这条决策；
  3. 在 UI 修改该条 → 再开一个 session，看到的是修改后的内容；在 UI 删除 → 新 session 不再出现；
  4. 卡 A 移入 Done → 复盘产生 0–1 条候选，并能被忽略；
  5. 桌面与紧凑布局截图，证据写入 `docs/verification/`；测试只清理自己建的卡与 session。
