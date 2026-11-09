# 项目 Ideas 入口：收拢全部卡片的 ideas

状态：用户 2026-10-16 确认并要求实现（“1. 可以先只允许新卡片去做；2. 全屏，和 insight 对齐”）。原始需求（2026-10-16 用户要求：“再增加一个 ideas 入口，收拢所有任务卡片的 ideas 延伸。ideas 的生命周期管理一致，和任务生命周期不完全绑定。任务即使 done，ideas 仍然可以保留活跃，任务删除对应 ideas 也删除。”）。卡片任务 `fa62fb3d`。本文在 [IDEAS-SPEC](IDEAS-SPEC.md) 基础上增改，未提到的行为不变。

## 1. 目的

现在 idea 只挂在来源卡的侧栏里，看 idea 必须先找到卡、再打开侧栏：

- 一个项目里各卡的 ideas 分散，无法一眼看到“还有哪些值得做的下一步”；
- 来源卡 Done 后通常会被收尾（sessions、workspace、卡片归档），归档卡不在看板上，它的 open idea 就再也看不到；现在归档卡的 idea 按钮还是禁用的；
- 不同卡提出的 idea 可能相同或相关，分散时看不出来。

本功能增加项目级 **Ideas** 页，并把 idea 的生命周期从卡片状态中解开：idea 一直保持自己的状态，直到用户在任一入口处理它，或来源卡被永久删除。

## 2. 生命周期

### 2.1 状态（不变）

`open → accepted`（终态）、`open ↔ dismissed`，含义与 IDEAS-SPEC §2.1 相同。两个入口（卡片侧栏、Ideas 页）使用同一组 RPC 与同一组件，规则、文案、动效一致。

### 2.2 与来源卡的关系（本次修改）

| 来源卡的情况 | idea 状态 | 可做的操作 |
| --- | --- | --- |
| 工作中（Backlog … In review） | 保持 | 全部（IDEAS-SPEC §6） |
| Done / Cancelled | **保持**，仍计入 open 数 | Start a new task、Dismiss、Restore；“在本卡继续”的三项不提供（§2.3） |
| 已归档（含收尾后归档） | **保持** | 同 Done / Cancelled（以前全部禁用，本次放开） |
| 从 Done / Cancelled 移回、或取消归档 | 保持 | 回到“工作中”的规则 |
| 永久删除 | 删除，写入 `removed/` 备份（已有行为） | — |
| 项目归档 | 保持，只读 | 无（按钮禁用） |
| 项目 Remove | 删除并备份（已有行为） | — |

- 卡片状态变化、收尾、归档、恢复都不改 idea，不写 idea 相关事件。
- agent 仍只能在工作中的卡上提出 idea（finished/归档卡的写工具照旧拒绝）。
- 由 idea 建出的卡与来源卡相互独立：来源卡删除后新卡保留 `derived` 关联已失效的显示（CARD-LINKS-SPEC），新卡删除后 idea 显示 “→ deleted card”（已有）。

### 2.3 Finished / 归档卡上的 “在本卡继续”

Done/Cancelled 是人的决定；把 idea 发回这类卡的 session，agent 会开始工作，但它的写工具会以 `TASK_FINISHED` 拒绝，卡片状态也不会自动离开 Done。所以：

- Good idea 菜单只显示 **Start a new task**（带 Suggested，不论 agent 建议的 scope）；菜单底部一行说明 “<卡片标题> is Done. Move it back to a work lane to continue in it.”（Cancelled、归档同理）。
  （2026-11-09 起）只有这一条路，所以 Good idea 不再弹菜单，直接新建：*Quick task for New task* 开启时打开 Quick task，这行说明移到它的 **Other options…** 里；关闭时打开完整表单（QUICK-TASK-SPEC §10）。
- 服务端 `ideas.adopt` 对 Done/Cancelled 或已归档的卡报错 “This card is finished. Start a new task, or move the card back to continue in it.”，不改数据（防止旧界面或并发状态变化）。

（用户确认先不做 “Reopen and continue”。）

## 3. 入口

### 3.1 总览栏

在总览栏 **Insights** 之前加一个 `Lightbulb` chip：`Ideas N`（N 为本项目 open idea 数，含 finished/归档卡上的）；N 为 0 时显示 `Ideas`。点击切换 Ideas 页。无障碍名称 “Project ideas: N open (B)”。

### 3.2 快捷键

`B`（light**b**ulb；`I` 已给 Insights）切换 Ideas 页；加入快捷键帮助表。`Esc` 顺序：session → 侧栏 → 离开 Ideas/Insights 页。

### 3.3 页面位置

与 Insights 相同的项目级整页，替换泳道区域（`MotionReveal`，transitionKey `ideas`），带返回。Ideas 与 Insights 互斥：打开一个即关闭另一个。切换项目时保持打开状态但内容换为新项目。卡片侧栏可以叠在 Ideas 页上（点击来源卡打开侧栏，与看板上一致），关闭侧栏回到 Ideas 页。

手机：整页，顶部返回；底部弹层菜单与侧栏中一致。按性能规范，切到 Ideas 页时泳道树隐藏而不卸载。

## 4. Ideas 页

### 4.1 布局

```
‹ Back   Ideas                                     [Search…]
[Open 7] [Accepted 12] [Dismissed 3]     Sort: Newest ▾   Group by card ◻
───────────────────────────────────────────────────────────
 ● Restore 已忽略的 idea 时拒绝…   ↳ Continues this task · Bugfix · 2h
   Why: …(2 行)
   From  ✓ ideas卡片 · Done                              ›
   [👍 Good idea]  [Dismiss]
 ● …
```

- 顶部分段：**Open**（默认）/ **Accepted** / **Dismissed**，各带数量。
- 搜索：匹配标题、detail、rationale、来源卡标题（不区分大小写，输入防抖 200 ms，使用 `TextBox`）。
- 排序：Newest（默认，`createdAt` 降序）/ Priority（Urgent→Low，未设视为 Normal，同级按 Newest）/ Card（按来源卡在看板上的列与位置，归档卡在最后）。
- **Group by card**（开关，页面打开期间保持）：按来源卡分组，组头为来源卡状态图标 + 标题 + 该组数量，点组头打开卡片；关闭时为平铺列表。
- 筛选（一行小 chip，可多选，默认全不选即全部）：`Continues a task`（scope=here）、`New task`（scope=new）、`From finished cards`（来源卡 Done/Cancelled/归档）。
- 空状态：
  - 项目没有任何 idea：“No ideas yet. Agents propose next steps here as they work.”
  - 当前分段/筛选无结果：“No matching ideas.” 加 **Clear filters**。

### 4.2 Idea 行

复用侧栏的 `IdeaCard`（从 `client/task-ideas.tsx` 提出为共享组件），在理由与按钮之间多一行 **From**：来源卡状态图标、标题、列名（归档卡显示 “Archived”），点击打开来源卡侧栏；来源卡不可见（例如归档且看板未显示归档）时同样能打开（侧栏以归档只读方式显示卡片）。

- Open 分段：Discuss / Dismiss / Good idea，与侧栏相同（Discuss 见 DISPATCHER-SPEC §9.5）；Good idea 菜单按 §2.3 和 IDEAS-SPEC §6 生成，session 列表来自共享的实时 agent 列表（`useLiveAgents`，按来源卡 workspace 过滤，不新增轮询）。
- Accepted 分段：显示 “→ 新卡标题”（点击打开新卡）或 “→ Sent to <session>”，与侧栏 Closed 分组相同。
- Dismissed 分段：**Restore**，规则同 IDEAS-SPEC §7（同卡同标题、10 个上限）。
- “Do it in a new session”：打开来源卡的侧栏（叠在 Ideas 页上）并直接弹出同一个预填的 Start session 弹窗，成功后 `ideas.adopt … send:false`，与侧栏相同。
- “Start a new task”：打开同一个预填的新建入口（`createFromIdea`：Quick task 或完整表单，QUICK-TASK-SPEC §10），建卡后的新卡出现在看板上；Ideas 页保持打开，该行收起离开 Open。
- 动效与乐观更新与侧栏相同（收起 160 ms、新到达上浮淡入、Reduce Motion）。分段切换只交叉淡入列表，不播放每行进场。Accepted / Dismissed 分段里的行同样会在被 Restore 后收起离开（不做进场，避免“Show more”一次动画几十行）；改变搜索或筛选时整个列表重建，不逐行收起。

### 4.3 数据

- 全部来自现有 etag 看板读取（`board.ideas`、`board.tasks`）；Ideas 页不新增 RPC 读取与轮询。
- 计数、筛选、分组、排序在 `client/idea-rows.ts` 中写成纯函数（已有文件，扩展），供总览 chip 与页面共用并做单测。
- 列表在页面的 ScrollView 中渲染（每卡最多 10 个 open idea），行 `React.memo`；Accepted/Dismissed 每次显示 50 条，底部 “Show more (N)” 再加 50。

## 5. 卡片侧栏与看板卡片（调整）

- 侧栏 Ideas 区块：按钮禁用条件由 “卡片或项目已归档” 改为 “项目已归档”；finished/归档卡按 §2.3 只提供 Start a new task。
- 看板卡片的灯泡数量：Done/Cancelled 列中的卡片同样显示（现在已显示，确认保留）。
- 侧栏 Ideas 区块标题旁加一个次要按钮 “All ideas”（所有卡片都有），打开 Ideas 页并只看该卡的 idea（筛选行最前面显示可清除的 “Card: <标题>” chip，不占用搜索框）。

## 6. 服务端修改

| 位置 | 修改 |
| --- | --- |
| `BoardStore.updateIdea` | 只在项目归档时拒绝（“The project is archived.”）；卡片归档不再拒绝 |
| `adoptIdea`（`server/ideas.ts`） | 预检与事务内复检都拒绝 Done/Cancelled 或已归档卡（§2.3 文案） |
| `tasks.create` + `ideaId` | 来源卡状态与归档不影响从 idea 建卡；项目须同一个且未归档。系统写的 `derived` 关联允许来源卡已归档（`addLink` 的 `archived` 选项；人工新建关联仍拒绝归档卡） |
| 删除卡片 / Remove 项目 | 不变（已级联删除并备份） |
| 收尾、归档、状态变化、恢复 | 不改 ideas（确认，补测试） |

数据结构不变，看板版本不变，无迁移。

## 7. 不做

- 跨项目 Ideas 汇总；idea 编辑、合并、投票；批量操作（批量 Dismiss 可后续作为 idea）。
- 让 agent 读取本项目其他卡的 ideas 以避免跨卡重复（后续 idea：`flowly_get_task` 增加项目级 open idea 标题）。
- idea 自动过期。
- “Reopen and continue”（见 §8）。

## 8. 已确认

1. Finished/归档卡上的 idea 只能新建卡片，先不做 “Reopen and continue”。
2. 入口为总览栏 chip + 整页，与 Insights 对齐。

## 9. 验收

- 单元：
  - `idea-rows`：项目计数（含 finished/归档卡）、分段计数、搜索、三种排序、分组、筛选组合、来源卡已删除不出现（删除即级联）。
  - `updateIdea`：归档卡可 dismiss/restore；项目归档拒绝。
  - `adoptIdea`：Done/Cancelled/归档卡拒绝且不改数据、不发送。
  - 从归档或 Done 卡的 idea 建卡成功，写 `derived` 关联与 `idea_accepted`。
  - 卡片 Done、收尾归档、移回、恢复前后 idea 状态不变；删除卡片后 idea 删除并进入备份。
  - 快捷键 `B` 映射与 Esc 顺序。
  - 开关关闭时提出 idea 返回 `IDEAS_DISABLED` 且不写数据，已提交请求仍可重放。
- typecheck、全量测试；安装并 reload。
- Luna 6 全权限测试 session，在 fixture 项目上：两张卡提出 ideas → 总览 chip 计数 → Ideas 页三段、搜索、分组 → 来源卡移到 Done 并收尾后 idea 仍在且可 Start a new task、“在本卡继续”不出现 → 永久删除来源卡后 idea 消失 → 手机布局。结束后清理全部 fixture 资源，证据存 `docs/verification/`。
- 实现时同步 IDEAS-SPEC：§5.2 禁用条件、§8 归档、§9 “项目级 Ideas 收件箱”移出不做，并链接本文。

## 10. Ideas 开关

2026-10-16 用户要求：“为 ideas 功能设置开关，关闭时 ideas 入口也关闭。默认打开。”

- 设置 `ideas`（host 范围，`shared/settings.ts` 的 `ideasSettings`，默认 `true`），在 Ultra Kanban 设置弹窗的 **Ideas** 区块切换。读不到设置时按打开处理。
- 关闭时：
  - 总览栏 Ideas chip 隐藏，快捷键 `B` 不响应，已打开的 Ideas 页回到看板；
  - 看板卡片的灯泡计数与卡片侧栏 Ideas 区块隐藏；
  - `flowly_propose_idea`（及 CLI/HTTP `idea`）返回 `IDEAS_DISABLED`（“Ideas are turned off in Ultra Kanban settings. Mention follow-up suggestions in your reply instead.”），不写数据；关闭前已提交的同一请求仍按回执重放。Skill 提示 agent 收到该错误时在回复里说明后续建议、不要重试。
- 关闭不删除、不修改任何 idea；重新打开后一切照旧。删除卡片/移除项目时的级联删除不受开关影响。
