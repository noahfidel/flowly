# 卡片关联关系

状态：2026-10-16 用户选择方案 A（Derived from + Related + Blocks，Blocks 只提示不拦截，不做父子），审阅通过并要求实现。卡片任务 `b80969de`。

## 1. 目的

卡片之间现在只有一种关系：从 idea 建出的新卡上的 `Task.origin`（[IDEAS-SPEC §2.2](IDEAS-SPEC.md)）。这个关系只能从新卡看到，来源卡看不到“我派生出了哪些卡”；手动建的后续卡、互相有关的卡、要等别的卡先完成的卡，都无法表达。

本功能给卡片加三种横向关联：

| kind | 方向 | 含义 | 从哪产生 |
| --- | --- | --- | --- |
| `derived` | `from` 新卡 → `to` 来源卡 | 新卡是来源卡的后续/派生工作 | 从 idea 新建卡片（自动）；**New follow-up task**（手动入口）；手动关联 |
| `related` | 无方向 | 两张卡互相有关 | 手动关联 |
| `blocks` | `from` 阻塞方 → `to` 被阻塞方 | `to` 要等 `from` 完成 | 手动关联 |

关联只用来**展示和提供上下文**：不改任何卡的业务状态，不拦截拖动或状态修改，不自动给 session 发消息。

调研结论（Vibe Kanban、Multica、Linear/Jira/Plane、agent-tasks MCP）：父子层级与横向关联是两套机制；父子层级一般也不联动状态。父子层级在“一卡一 workspace”下牵涉分支合并、状态汇总、级联删除/收尾/恢复、看板嵌套，本期不做（§9）。

## 2. 数据

### 2.1 Link

存在 `board.json` 新增的 `links` 数组（与卡片、ideas、事件同一个文件），使从 idea 建卡、标记 accepted 与写入关联在同一次原子事务中完成；客户端随现有 etag 看板读取拿到 links，不新增轮询。

```
{ id, projectId,
  kind: "derived" | "related" | "blocks",
  from: taskId, to: taskId,
  ideaId?: string,        // derived 且由 idea 建卡产生时
  createdBy: "human" | "system",
  createdAt }
```

`shared/model.ts` 新增 `linkSchema`、`linkKinds`、`linkLimits = { perTask: 50 }`；`boardSchema` 加 `links: z.array(linkSchema).optional()`（见 §2.2，缺失与空数组含义不同）。看板版本仍为 v4。

### 2.2 旧数据：`origin` 回填

- 文件中**没有** `links` 字段时（升级前写入），读取时为每张带 `origin` 的卡生成一条 `derived` 关联（`from`=该卡，`to`=`origin.taskId`，`ideaId`=`origin.ideaId`，`createdBy: "system"`，`createdAt`=该卡的 `createdAt`）。来源卡已不存在的跳过。下一次写入时随文件一起落盘。
- 文件中**有** `links` 字段时，它是唯一依据，不再从 `origin` 推导。这样用户删掉一条由 idea 产生的关联后不会复活。
- `Task.origin` 字段保留不动（历史记录，不改 task revision）；界面与工具都只读 `links`。

### 2.3 约束（服务端校验，`server/links.ts`）

- 两张卡存在、属于同一项目、不是同一张卡；项目未归档。任意一张卡已归档时拒绝**新建**关联（删除允许）。
- 同一对卡、同一种 kind 只能有一条；`related` 无方向，(A,B) 与 (B,A) 视为同一条。
- 一对卡之间已有任何关联时，不能再加 `related`（“These cards are already linked.”）；新加 `derived` 或 `blocks` 时，同一事务中删除这对卡之间已有的 `related`（被更具体的关系取代）。
- `blocks` 与 `derived` 分别不能成环（含 A→B 与 B→A 的二元环）：“This would make a cycle: A → B → … → A.” 列出路径中卡片标题。
- 每张卡最多 50 条关联（两端都算）：“A card can have at most 50 links.”
- 校验失败不写任何数据。

### 2.4 事件

关联不改 task revision，只增加看板 revision。两端卡片各记一条 human 事件：

- `linked`，note 为从本卡视角的描述，如 `Blocks: <对方标题>`、`Blocked by: <对方标题>`、`Follow-up of: <对方标题>`、`Follow-up: <对方标题>`、`Related: <对方标题>`；
- `unlinked`，同样格式。

从 idea 建卡时已有 `idea_accepted` 事件，不再额外记 `linked`。

### 2.5 视角与解析

`shared/links.ts` 提供纯函数，供服务端、工具与客户端共用：

- `linksOf(board, taskId)` → `{ link, other: Task | undefined, relation }[]`，`relation` 从本卡视角：

  | kind | 本卡是 from | 本卡是 to |
  | --- | --- | --- |
  | `derived` | `follow_up_of` | `follow_up` |
  | `blocks` | `blocks` | `blocked_by` |
  | `related` | `related` | `related` |

- `isResolved(task)`：阻塞方状态为 Done/Cancelled，或已归档，视为已解除。
- `waitingOn(board, taskId)`：未解除的 `blocked_by` 关联。
- `wouldCycle(board, kind, from, to)`：返回环路路径或 `undefined`。

## 3. 人工 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `links.create` | `{ kind, from, to }` | 按 §2.3 校验并写入；返回新 link。重复提交同一关联（已存在完全相同的一条）直接返回已有的那条，不写 |
| `links.delete` | `{ id }` | 删除；不存在时报 “This link no longer exists.” |
| `tasks.create` | 新增可选 `followUpOf: taskId`，与 `ideaId` 互斥 | 与新卡同一事务写一条 `derived`（`from`=新卡，`to`=followUpOf）。创建 workspace **之前**检查来源卡存在、同项目、未归档，否则不留下 workspace；事务内复检。重放同一 `operationId` 返回首次创建的卡，不重复写关联 |

从 idea 建卡（`tasks.create` 带 `ideaId`）在现有事务中额外写一条 `derived`（带 `ideaId`，`createdBy: "system"`）。这条关联不受 50 条上限约束，以免来源卡关联满时接受 idea 失败。

## 4. Agent 侧

- `flowly_get_task` 新增只读字段：

  ```
  links: [{ relation: "follow_up_of"|"follow_up"|"related"|"blocks"|"blocked_by",
            taskId, title, status, laneName, archived, resolved? /* 仅 blocked_by */ }]
  ```

  已删除的对方卡不会出现（删除时关联一并删除）。agent 只能看到对方卡的标题与状态，看不到其对话或描述。
- 建 session 时注入的任务上下文（`shared/scope.ts` `sessionContext`）把现在的 `Derived from card:` 一行换成关联列表，每种最多列 10 条、超出写 `…and N more`：

  ```
  Follow-up of: <标题> (<ID>) [<泳道名>]
  Blocked by: <标题> (<ID>) [<泳道名>]      // 仅未解除的
  Blocks: …
  Related: …
  ```

  这是建 session 时的快照；之后以 `flowly_get_task` 为准。
- Skill 新增一条：`links` 列出关联卡；有未解除的 `blocked_by` 时，开始前在回复里说明并按用户指示决定是否继续（不要自行改状态为 blocked，除非整张卡确实无法推进）。
- v1 agent **不能**创建或删除关联（不新增写工具）。

## 5. UI

### 5.1 看板卡片

有未解除的 `blocked_by` 时，在卡片底部信号行显示 `Hourglass` 图标加 “Waiting on N”（窄卡只显示数字）；全部解除后消失。无障碍文本 “Waiting on N cards: <标题…>”。其他关联不在卡面显示（避免噪音）。

### 5.2 侧栏 Links 区块

位置：Ideas 之后、Details & workspace 之前。

- 标题 `Links`，计数为关联总数；标题右侧 `+` 按钮打开菜单：**Link to a card…**（§5.4）、**New follow-up task**（§5.5）。没有关联时只显示标题行和 `+`，不渲染空状态文字。
- 关联按 relation 分组，组顺序与标题：`Waiting on`（未解除的 blocked_by）、`Blocks`、`Follow-up of`、`Follow-ups`、`Related`、`Was waiting on`（已解除的 blocked_by）。空组不显示。
- 每行：对方卡的类型图标、标题（单行截断）、泳道名（小号弱化）；已归档的对方卡标题弱化并带 “Archived”；由 idea 产生的 derived 行在泳道名后加 `Lightbulb` 小图标。点击行打开对方卡（同 `IdeaOrigin` 现有跳转）。行尾 `X` 图标按钮删除该关联，无确认；乐观移除（160 ms 收起），失败恢复并弹 error toast。无障碍名称 “Remove link: <relation> <标题>”。
- 卡片或项目已归档时 `+` 与删除按钮禁用，列表照常显示。
- 新增/删除动效使用 `client/motion.tsx` 原语，遵循 Reduce Motion，可打断；抽屉打开时已有行不播放进场。

### 5.3 描述上方的来源行

`IdeaOrigin` 改为读 `follow_up_of` 关联（不再读 `task.origin`）：有 `ideaId` 时显示 “From idea on <标题>”，否则 “Follow-up of <标题>”；多条时显示第一条并加 “+N”（点击滚到 Links 区块）。没有该关联时不显示。

### 5.4 Link to a card…

插件 Modal（手机为底部弹层）：

1. 顶部分段选择关系：**Related**（默认）/ **Blocks** / **Blocked by** / **Follow-up of**。“Blocked by X”与“Follow-up of X”在提交时转换为对应方向的 `blocks` / `derived`。
2. `TextBox` 搜索框（标题包含匹配，忽略大小写，`commitDelay` 防抖），下面列出本项目未归档的卡片：类型图标、标题、泳道名；按泳道顺序再按看板位置排序。排除本卡；与本卡在所选关系下已有关联的卡显示为禁用并标注 “Linked”。
3. 点一张卡即提交 `links.create`；成功关闭弹层并弹 success toast “Linked”；失败（环、上限、已关联、卡已不存在）弹层保留并在列表上方显示错误。

入口：Links 区块 `+` 菜单；卡片侧栏 ⋯ 菜单的 **Link to a card…**（位于 Start session 之后）。Ruling（Noah，2026-11-10）：看板卡片菜单不再有此项（UI-UX-SPEC §2）。

### 5.5 New follow-up task

打开现有新建任务表单（同一组件），标题 “Create follow-up task”，表单顶部显示一行 “Follow-up of <来源卡标题>”。字段默认值同普通新建，类型与优先级继承来源卡；描述为空。保存时 `tasks.create` 带 `followUpOf`。入口：Links 区块 `+` 菜单；卡片侧栏 ⋯ 菜单的 **New follow-up task**（看板卡片菜单不再有，Ruling Noah 2026-11-10）。

## 6. 删除与归档

- 永久删除卡片：一并删除所有以它为任一端的关联，写入现有 `removed/task-…json` 备份（新增 `links` 字段）；对方卡记 `unlinked` 事件（note 用被删卡标题）。
- 移除项目：一并删除并备份该项目的关联。
- 归档卡片、收尾（wrap-up）、恢复：关联保留，不受影响。阻塞方归档视为已解除（§2.5）。
- 状态变化（包括阻塞方变 Done）不触发任何自动动作。

## 7. 错误文案

| 情况 | 文案 |
| --- | --- |
| 跨项目 | “Cards in different projects can't be linked.” |
| 自己 | “A card can't be linked to itself.” |
| 已有关联 | “These cards are already linked.” |
| 成环 | “This would make a cycle: A → B → … → A.” |
| 上限 | “A card can have at most 50 links.” |
| 卡已归档 | “Archived cards can't get new links.” |
| 卡/关联不存在 | “Task not found” / “This link no longer exists.” |

## 8. 性能

- 关联随看板一次读取，不新增 RPC 轮询；`linksOf` 每次渲染按 `taskId` 过滤，单卡 ≤50 条。看板卡面的 Waiting on 计数在 `client/board-view.ts` 的派生数据里一次算出，传入已 memo 的卡片组件时只传数字与标题串（内容比较）。
- 选择卡片弹层只在打开时计算列表；搜索防抖。

## 9. 不做

- 父子层级、子任务进度汇总、状态联动、级联删除/收尾。
- 跨项目关联；`duplicate` 等其他关系类型；关联图视图。
- Blocks 的强制拦截；阻塞方完成后自动通知被阻塞卡的 session。
- agent 创建/删除关联的工具。

## 10. 验收

- 单元（`shared/links.test.ts`、`server/links.test.ts`、`server/store.test.ts`）：
  - 视角映射、`isResolved`、`waitingOn`、环检测（二元环、长环、derived 与 blocks 互不影响）。
  - `links.create` 各约束与错误；`related` 被更具体关系取代；重复提交返回已有关联且不写；只增加看板 revision，不改 task revision；两端事件。
  - `links.delete`；不存在报错。
  - `tasks.create` 带 `ideaId` 时关联与 accepted 原子写入；带 `followUpOf` 的预检（不留 workspace）、事务内复检、重放不重复；`ideaId` 与 `followUpOf` 同时给出被拒。
  - 旧 `board.json`：无 `links` 时由 `origin` 回填、来源卡缺失跳过；有 `links`（含空数组）时不回填。
  - 删除卡片与移除项目的关联级联和备份。
  - `sessionContext` 的关联行与截断；`flowly_get_task` 的 `links`。
- 客户端（`client/board-view.test.ts` 等）：Waiting on 计数；分组顺序；选择弹层的排除与禁用。
- typecheck、全量测试；安装并 reload 本插件；用 Luna 6（`codex/gpt-6-luna`，`full-access`）测试 session 在 fixture 项目上走通：手动 Related/Blocks/Follow-up 关联与删除、环与跨项目报错、从 idea 建卡产生 derived、New follow-up task、Waiting on 信号随阻塞方完成消失、删除卡片级联、`flowly_get_task` 返回 links；桌面与紧凑布局 UI 按 AGENTS.md 绑定非全屏窗口，无法绑定时标 UNRUN。结束后清理 fixture，证据存 `docs/verification/card-links.md`。
