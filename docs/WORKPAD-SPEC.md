# 卡片 Workpad：验收、验证与交付门槛（WORKPAD-SPEC）

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：§2.1 的 validation / confusions / env / head / delivery、§3 的输入、§4.2 环境戳、§5 全部、§6.1 卡面信号、§6.2 的 Checks / Confusions、§6.3 的验证操作、§7 skill；仍有效：§2.2 Plan、§2.4 两种 revision、§6.3 的 acceptance 勾选、§9 项目开关。

状态：2026-10-19 用户审阅定稿并要求实现。卡片任务 `78fb25af`。来源：[SYMPHONY-RESEARCH](SYMPHONY-RESEARCH.md) §2.3、§2.4、§3 P1/P2。用户已选“精简版”：Plan 从原生 todo 派生；agent 只写 Acceptance、Validation（三态 + sha）、Confusions；不做 Notes；workpad 用独立 revision；交付门槛与 sha 过期检测包含在内。定稿决定：没有 workpad 的卡交付不检查（§5.3）；有验收标准时隐藏 summary 的 Target（§6.2）；人可以把验证标为 pass，用当前 HEAD 盖章（§6.3）。

## 1. 目的

人审一张卡时，要一眼看到四件事：计划做什么、验收标准是什么、哪些验证跑了（过了/挂了/没跑）、这些验证是不是在当前代码上跑的。现在这些只能从追加式 progress note、事后 summary 和对话里拼出来；AGENTS.md 要求的“completed / failed / unrun 分开记录”全靠 agent 在文本里自觉写。

Workpad 是挂在卡片上、**就地更新**的结构化清单。它同时是后续自动化（Nudge 续跑、Merging 泳道动作、Rework 重开）判断“还剩什么”的数据来源，所以字段要能被程序读取，而不只是给人看。

原则：

- **agent 写系统推不出来的，系统推得出来的自己推。** Plan 来自 provider 原生 todo（零额外工具调用）；环境戳与 sha 由 daemon 用 git 读，不靠 agent 自报。
- **门槛是软的。** 有未完成项时不拒绝交付，但要求 agent 明确确认，并在卡片上留下可见标记。Done 仍只由人决定。
- **不改 task revision。** workpad 有自己的 revision，人勾一项不会让 agent 的其它写入报 `REVISION_CONFLICT`。

不做（v1）：层级 Plan；Notes 段（progress note 已覆盖）；人编辑条目文字或新增条目（人通过描述或消息告诉 agent）；Confusions 汇总进 Insights；多仓库（共同父目录下多个 repo）的逐仓 sha；自动续跑。

## 2. 数据

### 2.1 Workpad（agent 维护，每卡一份）

`board.json` 新增 `workpads` 数组（同 `artifacts`，缺失读作空数组，看板版本不变），随现有 etag 看板读取到达客户端，不新增轮询。

```
Workpad {
  taskId, projectId,
  revision: int ≥ 1,              // workpad 自己的 revision，见 §2.4
  acceptance: AcceptanceItem[],   // ≤ 20
  validation: ValidationItem[],   // ≤ 20
  confusions: ConfusionItem[],    // ≤ 10
  env: { host, path, head: GitHead | null } | null,   // 最近一次 agent 写入时 daemon 读取（§4.2）
  head: GitHead | null,                               // 最近一次刷新的当前 HEAD（§5.2）
  delivery?: { unchecked, failed, unrun, stale, total, revision, eventId, at },  // 最近一次 agent 交付（§5.3）
  updatedAt, updatedBy: "agent" | "human", agentId?
}

GitHead { sha?, branch?, dirty, at }

AcceptanceItem { id, text (1–300), done: boolean, by: "agent" | "human", at }

ValidationItem {
  id, text (1–300),                      // 要验证什么，人看的描述
  command?: string (≤ 300),              // 具体命令，如 "npm test"
  state: "pass" | "fail" | "unrun",
  sha?: string,                          // 运行时的 commit，12 位短 sha（§5.1）
  dirty?: boolean,                       // 运行时工作区有未提交改动
  ranAt?: timestamp,
  evidence?: string (≤ 600),             // 输出摘要、失败原因或产物引用
  by: "agent" | "human", at
}

ConfusionItem { id, text (1–600), at }
```

`shared/model.ts` 新增 `workpadSchema`、`workpadLimits = { text: 300, command: 300, evidence: 600, confusion: 600, acceptance: 20, validation: 20, confusions: 10, planItems: 50, planText: 300 }`。`id` 为 1–40 位 `[a-z0-9-]`，卡内同段唯一。纯逻辑（合并、新鲜度、未完成项、卡面信号、从 timeline 取 Plan）在 `shared/workpad.ts`；git 读取、人工编辑与 Plan 记录在 `server/workpad.ts`。

上限按工具请求体估算：满额的 workpad 含多字节文字时可能超过 64 KiB，工具服务的请求体上限因此从 64 KiB 提高到 256 KiB（MCP 与 CLI 的 `/api` 相同）。

### 2.2 Plan（从原生 todo 派生，每卡每 session 一份）

`board.json` 新增 `plans` 数组：

```
PlanSnapshot { taskId, agentId, items: { text (≤ 300), status: "pending" | "in_progress" | "completed" }[] (≤ 50), at }
```

- 来源：看板管理的 session（AUTO-STATUS-SPEC §1 的范围）收到 `agent.turn_ended` 时（任何 outcome），取 hook 自带 `timeline` 中**最后一个** `type: "todo"` 条目（`@getpaseo/protocol` 的 `AgentTaskItem[]`：Claude 的 TodoWrite、Codex 的 plan 工具）。`status` 缺失时由 `completed` 推出（`completed ? "completed" : "pending"`）。
- 本轮没有 todo 条目：保留上一份快照不变。todo 条目为空数组：清空该 session 的 Plan。
- 只在回合结束时更新，回合进行中看到的是上一轮结束时的计划（运行中的实时计划在 session 预览里已可见）。
- 不记事件、不改 task revision，只增加看板 revision；内容没变时不写入。由 `WorkpadService.recordTurn` 在 hook 返回后执行，失败只记日志，不阻塞 hook。
- Plan **不计入**交付门槛（原生 todo 经常没被 agent 收尾，计入会产生噪音），只展示。

### 2.3 事件

| action | actor | 何时 | note |
| --- | --- | --- | --- |
| `workpad_updated` | agent（带 agentId） | `flowly_update_workpad` 提交 | 计数摘要，如 `Acceptance 2/4 · Checks 3/5, 1 failed` |
| `workpad_checked` | human | 人勾选/改状态/移除 confusion（§6.3） | `<段名>: <条目文字前 80 字>` → 新状态 |

两者都**不**显示在卡片活动时间线（与 `next_moves_suggested` 相同，避免刷屏），flow log 照常记录。`status_changed` 事件新增可选字段 `workpad`（交付快照，§5.3）。

`silentTurn`（`shared/progress.ts`）把 `workpad_updated` 也算作本轮的汇报；`openQuestion` 不变（更新 workpad 不等于回答了问题）。规则 A1r 已把 next moves 以外的任何 agent 事件算作工作，无需修改。

### 2.4 两种 revision

- **task revision**：workpad 写入（agent 或人）都不改。现有工具的 `expectedRevision.task` 语义不变。
- **workpad revision**：每次写入（agent 整体替换、人改一项）+1。agent 写入必须带 `workpadRevision`（尚无 workpad 时为 0），不符则 `WORKPAD_CONFLICT`。这样人刚勾的项不会被 agent 用旧副本覆盖，而 agent 的状态/进度/产物写入不受人勾选影响。

## 3. Agent 工具 `flowly_update_workpad`

### 3.1 输入

```
{
  expectedRevision, request,          // 照抄 get_task，校验同其它写工具
  workpadRevision: int ≥ 0,           // get_task 里 workpad.revision；没有 workpad 时 0
  acceptance: { id?, text, done }[],
  validation: { id?, text, command?, state, sha?, dirty?, evidence? }[],
  confusions: { id?, text }[]
}
```

- **整体替换**三段：不在输入里的条目即删除。三段都必须给出（可为空数组）。
- 条目匹配（用于保留 `by`、`at`、`sha`）：先按 `id`，没有 `id` 时按去空白、大小写不敏感的 `text`；都匹配不上视为新条目，daemon 分配 `id`（由 text 生成 slug，冲突加序号）。
- `by` / `at`：内容（text、done、state、command、evidence、sha）与匹配到的旧条目相同则保留原值；否则 `by: "agent"`、`at` 为当前时间。
- `sha` 解析见 §5.1。

### 3.2 校验与结果

- 签名、`expectedRevision`、过期、归档、Done/Cancelled（`TASK_FINISHED`）、重放、`REQUEST_REUSED`：与其它写工具一致（`server/agent-service.ts` 的 `write`）。回执 action=`workpad`，新增 `workpadRevision`（提交后的值）。
- `WORKPAD_CONFLICT`：`workpadRevision` 不是当前值。消息带当前值：“Workpad changed (current revision=N), possibly by the user. Re-read get_task, keep their checks, then retry.” 不提交任何内容。
- `WORKPAD_INVALID`：超出数量或长度上限、`id` 格式不对或同段重复、`state` 不是三态之一、`sha` 无法解析为该仓库的 commit、工作区不是 git 仓库却给了 `sha`。
- 成功：写入 `workpad_updated` 事件，刷新 `env` 与 `head`（§4.2、§5.2）。结果的 `current` 中包含新的 workpad。
- CLI：`workpad --request-file <snapshot> --workpad-revision <n> (--workpad '<JSON>' | --workpad-file <path>)`，JSON 为 `{acceptance, validation, confusions}`。HTTP API action `workpad`。

### 3.3 工具描述（英文，进 description 与 skill）

> Replace this card's workpad: acceptance criteria (done or not), validation checks (pass, fail or unrun, with the command and the commit they ran on) and confusions (what in the card was unclear). The plan comes from your own todo list; do not repeat it here. Send all three lists every time; items you leave out are removed. Copy workpad.revision from get_task as workpadRevision (0 when there is none). On WORKPAD_CONFLICT the user changed it: re-read, keep their checks, retry. Does not change card status or task revision.

## 4. get_task 与环境戳

### 4.1 get_task 新增字段

```
workpad: {
  revision, acceptance, validation (每项附 fresh: "fresh" | "stale" | "unknown"，§5.2),
  confusions, env, head,
  open: { unchecked, failed, unrun, stale, total }   // §5.3 的计数
} | null,
plan: { agentId, own: boolean, items, at }[]         // 本卡各 session 的 Plan，本 session 在前
```

### 4.2 环境戳 `env`

每次 agent 写入 workpad 时，daemon 在事务外读取（参数数组子进程，5 秒超时，失败则对应字段为空，不阻止写入）：

- `host`：`os.hostname()`；`path`：卡片 workspace 目录（展示时把 home 缩写为 `~`）；
- `head.sha`：`git -C <dir> rev-parse --short=12 HEAD`；
- `head.branch`：`git -C <dir> rev-parse --abbrev-ref HEAD`（detached 时省略）；
- `head.dirty`：`git -C <dir> status --porcelain` 输出非空（包含未跟踪文件）。

展示为 `host:path@sha`（dirty 时追加 `*`）。工作区不是 git 仓库（例如多个子仓库的共同父目录）：`sha`、`branch` 为空，sha 相关检测全部为 `unknown`。

## 5. 验证新鲜度与交付门槛

### 5.1 验证条目的 sha

`state` 为 `pass` / `fail` 的条目必须有 sha，按以下顺序确定：

1. agent 给了 `sha`：`git rev-parse --verify --quiet <sha>^{commit}` 校验后存 12 位短 sha；解析失败为 `WORKPAD_INVALID`。`dirty` 照 agent 给的值（缺省 false）。
2. 未给，且匹配到的旧条目 `state` 相同、已有 sha：保留旧 sha、`dirty`、`ranAt`（agent 没重跑，只是整体重发）。
3. 否则 daemon 用写入时的 HEAD 盖章，`dirty` 取写入时工作区状态，`ranAt` 为当前时间。

`unrun` 条目清空 `sha`、`dirty`、`ranAt`。skill 要求：重跑一项验证后在该条目上给出运行时的 `sha`（`git rev-parse --short HEAD`），在未提交改动上跑的同时给 `dirty: true`。

### 5.2 新鲜度（sha 过期检测）

`validationFreshness(item, head)`（`shared/workpad.ts`，纯函数）：

| 条件 | 结果 |
| --- | --- |
| `state = unrun` | 不适用 |
| 条目或 `head` 没有 sha（非 git、git 失败） | `unknown` |
| `head.sha` 与条目 sha 相同 | `fresh` |
| 不同 | `stale`：之后有新 commit，验证需要重跑 |

已知局限：同一 HEAD 上验证后又改了未提交的代码，无法判断为过期。仍按 `fresh` 计，条目显示“on uncommitted changes”（`dirty` 时）。

`head` 的刷新时机（一次 `rev-parse` + 一次 `status`，不轮询）：

- agent 写入 workpad；
- agent 把卡移到 In review（门槛计算前）；
- 本卡看板管理的 session `agent.turn_ended`，且该卡 workpad 有 pass/fail 条目；
- 抽屉打开该卡的 Workpad 段时调用 RPC `workpads.refresh`（同一卡 30 秒内不重复执行 git，直接返回已存值）。

`head` 变化只增加看板 revision，不记事件。

### 5.3 交付门槛（软）

“未完成项” `openItems(workpad)`：

- `unchecked`：`done = false` 的验收标准；
- `failed`：`state = fail` 的验证；
- `unrun`：`state = unrun` 的验证；
- `stale`：`state = pass` 且新鲜度为 `stale` 的验证；
- `total` 为四者之和。Plan 与 Confusions 不计入。

agent 调 `flowly_update_status(status=in_review)` 时（只在 agent 路径；人拖到 In review 不检查）：

> 2026-10-29：`status=committed` 同样是交付，门槛、快照与卡面标记规则相同（[COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §3）。

1. 先刷新 `head`，计算 `openItems`。
2. `total = 0`：照常提交。没有 workpad（项目开启时）：2026-10-21 用户决定改为软卡，返回 `SETUP_INCOMPLETE`，见 [CARD-SETUP-SPEC](CARD-SETUP-SPEC.md) §3.4（已实现）；此前的“没有 workpad 照常提交”作废。
3. `total > 0` 且本 session 尚未收到对当前状态的拒绝，或输入没有 `acknowledgeOpen: true`：返回 `WORKPAD_OPEN`，不提交任何内容（不写回执，同一 request 可以带确认后重试）。消息列出未完成项：“{n} workpad items are still open: … Deliver anyway only if the note explains each one (failed, not run, or out of date), with acknowledgeOpen=true.”
4. `total > 0`、本 session 已收到当前状态的拒绝，且 `acknowledgeOpen: true`：提交；`status_changed` 事件带交付快照 `workpad: { unchecked, failed, unrun, stale, total, revision }`。

2026-10-22 修订：首次预带 `acknowledgeOpen=true` 也拒绝；确认只对同 session/card/workspace、同 card/project/workpad revision 和 HEAD 状态有效，最多 15 分钟。回合开始 hook 清空确认记录，不依赖每卡截断事件；服务重载后重新拒绝。详见 [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §2。

`flowly_update_status` 输入新增可选 `acknowledgeOpen: boolean`（默认 false），CLI 加 `--acknowledge-open`。门槛不检查 note 的内容（系统无法判断），只保证 agent 看过清单并主动确认。

卡片标记：每次 agent 交付都把快照同时写进 workpad 的 `delivery`（带该 `status_changed` 事件的 id）。卡片在 In review，且最近一条进入 In review 的 `status_changed` 就是这次交付（事件已被裁剪时也算），`total > 0` 时卡面显示“Delivered with {n} open items”（警告色）。卡片离开 In review、或之后被人重新拖进 In review，都不再显示。标记反映交付时的状态；之后人或 agent 再勾选，标记不变，抽屉里看实时状态。

## 6. 界面

### 6.1 卡面

在 `CardSignals`（`client/card.tsx`）加一个信号，有 workpad 时才显示，按优先级只显示一个：

| 条件 | 文案 | 颜色 |
| --- | --- | --- |
| In review 且交付快照 `total > 0` | Delivered with {n} open items | 警告 |
| 有 `fail` 验证 | Checks {pass}/{total} · {n} failed | 危险 |
| 有 `stale` 验证 | Checks {pass}/{total} · out of date | 警告 |
| 有验证条目 | Checks {pass}/{total} | 默认 |
| 只有验收标准 | Acceptance {done}/{total} | 默认 |

`pass` 只数新鲜度不是 `stale` 的通过项。图标 `ListChecks`。所有计数从已在客户端的看板数据算出，不新增请求。

完成的卡（Done、Cancelled 或已归档）不再判断过期（2026-10-20 用户决定）：之后的 commit 不会再让它显示 out of date，旧 commit 上的 pass 照常计入；失败仍显示。卡片内 Workpad 的每项仍标出 `@sha · out of date`，作为历史记录。

### 6.2 抽屉

在 `TaskProgress` 与 `TaskArtifacts` 之间新增 **Workpad** 段（`client/task-workpad.tsx`，`React.memo`，回调用 `useStableCallback`），默认展开，没有 workpad 也没有 Plan 时整段不显示：

- 整段可收起（2026-10-19）：点 `Workpad` 标题（带箭头）收起/展开；收起时标题右侧显示 `Acceptance n/m · Checks n/m`（通过数）；是否默认展开由 设置 → Cards → Card sidebar 决定（默认展开）。Acceptance、Checks、Confusions 各先显示 5 条，“Show N more” 每次追加 5 条；Checks 按 失败、过期、未运行、通过 排序；命令默认只显示一行，展开输出或点击命令后显示全部（[DRAWER-SPEC](DRAWER-SPEC.md#section-order-and-artifacts-paging)）。
- 头部：`Workpad` + 环境戳 `host:path@sha`（可选中复制）+ “Updated {time} by {session}”。
- **Acceptance**：复选框列表。人勾选的项旁标小字“by you”。
- **Checks**：每行状态图标（pass 绿勾 / 过期的 pass 警告三角 / fail 红叉 / unrun 灰色虚线圈），点图标按 unrun → pass → fail → unrun 切换（§6.3）；文字、等宽 `command`；第二行小字：`@sha`、“out of date”（stale，警告色）、“on uncommitted changes”（dirty）、相对 `ranAt`；有 `evidence` 时用 “Show output / Hide output” 展开。
- **Plan**：只读，来自原生 todo。一个 session 时直接列出；多个 session 时按 session 标题分组，最近更新的在前。行首状态图标（pending / in_progress / completed），标注“From the agent's todo list · updated at turn end”。
- **Confusions**：列表，每条可由人移除（“Resolved”）。
- 新鲜度：打开该段且有跑过的验证时调用 `workpads.refresh`（§5.2），完成前显示已存的值，不显示加载态；HEAD 变了才刷新看板。

与 summary 的分工（TASK-SUMMARY-SPEC）：workpad 有验收标准时，`TaskProgress` 不再显示 summary 的 `target`（Goal + 功能点），只显示 `state`、`recap`、`next`，避免同一件事写两遍。summarizer 的 prompt 和存储不变。

### 6.3 人工操作（RPC）

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `workpads.check` | `{ taskId, section: "acceptance" \| "validation", itemId, done? , state? }` | 改一项：验收标准切换 `done`；验证设为 pass / fail / unrun（人标的 pass 用当前 HEAD 盖章，`by: "human"`） |
| `workpads.resolve-confusion` | `{ taskId, itemId }` | 移除一条 confusion |
| `workpads.refresh` | `{ taskId }` | §5.2，只读 git 并更新 `head` |

- 按条目操作，作用于最新版本，不要求客户端带 revision；条目已不存在时报 “This item is no longer in the workpad.”，客户端刷新。每次成功 workpad revision +1，记 `workpad_checked` 事件，不改 task revision。
- 卡片或项目已归档时拒绝：“Archived cards can't be changed.” Done/Cancelled 卡片允许人勾选（复盘用）。
- 操作即时生效，乐观更新，失败时回滚并用现有错误提示；成功不弹 toast（勾选本身就是反馈）。
- 无障碍：复选框名为条目文字，状态读出“passed / failed / not run / out of date”。

### 6.4 生命周期

- 永久删除卡片：workpad 与 Plan 一并删除，进入 `removed/` 备份（TASK-DELETE-SPEC）。
- 归档、Wrap up、移出 Done 恢复：workpad 保留不动。
- Follow-up 新卡：不继承 workpad（新卡的 agent 从描述重建）。

## 7. Skill 文本

`server/skill-source.ts` 与 `skills/paseo-ultra-kanban/SKILL.md` 同步新增一条（英文）：

> - Keep the card's workpad current with flowly_update_workpad: acceptance criteria, validation checks and confusions. Your plan is read from your own todo list, so keep that list current instead of copying it. Before you start implementing, write the acceptance criteria and the checks you will run; when the card description has a Validation, Test plan or acceptance section, copy each item into the workpad word for word and never weaken or drop one. Each check names the exact command. Update the workpad after each milestone: mark a check pass or fail only after you actually ran it, with the commit it ran on (sha, plus dirty=true when it ran on uncommitted changes); leave it unrun otherwise. Add a confusion when something in the card was unclear and you had to guess. A check that turns out to be unnecessary is removed with a reason in your reply, not marked pass. Before delivering to in_review, rerun checks that are out of date. If items are still open, the status update returns WORKPAD_OPEN: deliver only with acknowledgeOpen=true and a note that explains every open item.

并在现有 “Deliver the overall result to in_review…” 一句后补：“…unrun checks and remaining issues; the workpad shows them on the card, so keep it and your note consistent.”

CLI 用法段加入 `workpad` 子命令和 `status in_review --acknowledge-open`。

## 8. 新手引导与文档

- 欢迎页特色列表新增一条 **Workpad**：“Agents keep a workpad on each card: acceptance criteria, checks marked passed, failed or not run on a named commit, and what confused them.”
- 一次性提示 `first-workpad`：当前项目任一卡片有 workpad 时出现，文案 “This card has a workpad: the agent's acceptance criteria and checks. The card shows how many checks passed; open it to see which ran on which commit, and tick items yourself.” 优先级排在 `next-move` 之后、`first-idea` 之前。`client/onboarding-logic.ts` 加 tip id 与事实 `workpads`，`client/board.tsx` 的 `tipText` 加文案，ONBOARDING-SPEC 提示表加一行。
- README / README.zh-CN Highlights 加一句，agent 工具列表加 `flowly_update_workpad`。
- 所有新文案（卡面信号、抽屉段落、状态读出、错误、tip、欢迎页）加入 `shared/i18n/` 全部目录；`tn` 用于计数。agent 面向文字和 daemon 错误保持英文。
- 实现时在 SPEC-OUTLINE 顶部加一条记录，PROGRESS.md 记录完成/失败/未运行的检查。

## 9. 项目开关

2026-10-19 用户追加：workpad 是可选功能，在项目设置里开关。

- 数据：`Project.workpad?: boolean`，缺省为开（老项目与新项目都开）；`projects.update` 接受 `workpad`，与其它项目编辑一样增加项目 revision。
- 设置：项目设置弹层在 “Auto-update status in this project” 之后新增开关 **Card workpad**，说明 “Agents keep acceptance criteria and checks on each card, and delivering with open items needs a note. Off hides it and stops these checks; what agents wrote is kept.” 只在编辑已有项目时显示。
- 关闭时：
  - `flowly_update_workpad` 返回 `WORKPAD_DISABLED`（不写入、不留回执）；`get_task` 返回 `workpadEnabled: false`、`workpad: null`、`plan: []`；skill 要求 agent 改在进度和交付说明里列出验收与验证，不重试；
  - 交付不检查（不返回 `WORKPAD_OPEN`，不记交付快照）；
  - 回合结束不记录 Plan、不刷新 HEAD；`workpads.check` / `workpads.resolve-confusion` 拒绝（“The workpad is turned off for this project.”），`workpads.refresh` 不执行 git；
  - 卡面不显示 workpad 信号（包括 “Delivered with N open items”），抽屉不显示 Workpad 段，Progress 重新显示 summary 的 Target，`first-workpad` 提示不出现。
- 已有的 workpad 与 Plan 数据保留不动；重新打开后照常显示，agent 读到的仍是关闭前的版本。

## 10. 验收

聚焦单测：

- `shared/workpad.test.ts`：`validationFreshness` 四种结果；`openItems` 计数（Plan、Confusions 不计入，stale pass 计入）；条目匹配（按 id、按 text、新条目 slug 去重）；`by`/`at` 在内容不变时保留；卡面信号优先级。
- `server/agent-service.test.ts`（workpad 部分）：
  - 首次写入 `workpadRevision=0` 成功，revision=1；不改 task revision；记 `workpad_updated`；
  - 旧 `workpadRevision` → `WORKPAD_CONFLICT` 且无写入；人 `workpads.check` 后 agent 用旧 revision 写入被拒；
  - sha 三种来源（给出并校验、沿用旧值、daemon 盖章）；非法 sha、非 git 目录给 sha → `WORKPAD_INVALID`；超限 → `WORKPAD_INVALID`；
  - 精确重放返回原回执；Done 卡 `TASK_FINISHED`；
  - 门槛：有未完成项无确认 → `WORKPAD_OPEN` 且状态未变、无回执；带 `acknowledgeOpen` → 提交且事件带快照；无 workpad 或全部完成 → 照常；HEAD 前进使 pass 变 stale 并计入门槛。
- `server/workpad-plan.test.ts`：从 timeline 取最后一个 todo；无 todo 保留旧快照；空数组清空；`status` 缺失时由 `completed` 推出；只处理看板管理的 session；条目与长度上限。
- `server/progress-rules.test.ts`：只更新了 workpad 的回合不算 silent turn；A1r 把 workpad 更新算作工作。
- `server/tool-server.test.ts`：工具列表含 `flowly_update_workpad`，`flowly_update_status` schema 含 `acknowledgeOpen`。
- `client/onboarding-logic.test.ts`：`first-workpad` 规则与优先级。
- 项目开关（§9）：关闭后写入返回 `WORKPAD_DISABLED`、交付不拦、`get_task` 不返回 workpad、回合结束不记 Plan、人工编辑被拒；重新打开后旧数据仍在；`projects.update` 保存开关。
- `npm test` 的 i18n 目录检查通过；`npm run typecheck` 通过。

人工 / Luna（按 AGENTS.md，用 Tinylink 项目新增的测试卡，结束后清理自己创建的卡和 session）：

- 真实 Codex 与 Claude session 各一：todo 列表在回合结束后出现在 Plan；agent 按 skill 写入 workpad；卡面显示 Checks n/m。
- 人在抽屉勾选后 agent 用旧 revision 写入收到冲突，重读后保留人的勾选。
- agent 提交新 commit 后，旧 pass 在抽屉与卡面显示 out of date。
- 有未完成项时交付：第一次 `WORKPAD_OPEN`，确认后进入 In review 且卡面显示 “Delivered with n open”。
- 手机紧凑布局：卡面信号不换行溢出，抽屉复选框可点。
