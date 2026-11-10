# 卡片开工设置：type / tags / workpad 的提醒与软卡（CARD-SETUP-SPEC）

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：“workpad 缺失”改为“acceptance 缺失”；其余仍有效。

2026-10-22：Start of every turn 改为共享六项动作清单，实时 get_task 返回相同的 `turnChecklist`；仍先补 setup.missing，小卡不例外。现有缺项校验、提醒和权限不变。见 [TURN-CHECKLIST-SPEC](TURN-CHECKLIST-SPEC.md)。

状态：2026-10-21 用户审阅通过并要求实现；已实现，Luna 6 验证通过（[报告](verification/card-setup-2026-10-21.md)：Sonnet 5.5 medium 与 Luna 都在首次改文件前补齐了三项；真实 session 的 `SETUP_INCOMPLETE` 拒绝未触发，仅单测覆盖）。卡片 `ee717828`（“Flowly 流程约束强化”，“发布v1.5.0”的跟进）。
用户决定（2026-10-21）：
- 没有 workpad 的卡交付也要软卡（`acknowledgeOpen` 加说明放行）。这**推翻** [WORKPAD-SPEC](WORKPAD-SPEC.md) §5.3 第 2 步“没有 workpad 照常提交”的旧决定，理由见 §2 R4。
- 一次 Flowly 工具都不调的回合，靠首条任务上下文写明缺项覆盖（§3.2）；卡面给用户显示缺项另提 idea，不在本卡。
- 卡片第 5 项（daemon 摘要子 session 建议 type/tags）不做。

## 1. 现状数据

来源：`~/.paseo/plugin-data/flowly/board.json`（2026-10-21 13:05 快照，只读）与 `paseo agent ls -a -g --json`。统计 2026-10-19 07:00（workpad 上线）之后创建、有 agent 回合的卡。卡片事件按卡只保留最近 100 条，长卡的“首次”时间可能被裁剪，下表只列短卡。

| 卡片 | 描述 | 模型 / 思考 | type | tags | workpad | Flowly 写入 | 现象 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 表格渲染 | 空 | sonnet-5.5 / auto | 无 | 无 | 无 | 5 | todo→development→in_review 共 91 秒；两次交付都带了 next moves |
| session内文本链接渲染 | 空 | sonnet-5.5 / medium | 无 | 无 | 无 | 2 | todo 直接 → in_review，带了 next moves |
| 调整sidebar尽可能不同时移动看板 | 空 | sonnet-5.5 / medium | 人设 | 无 | 无 | **0** | 在独立 worktree 开 PR #7，整卡一次 Flowly 工具都没调 |
| 发布v1.5.0 | 空 | sonnet-5.5 / medium | 05:01 才设 | 05:01 才设 | dev 之后 | 7 | 用户追问后才补 type/tags |
| 手机端性能优化 | 空 | sonnet-5.5 / high | 无 | 无 | 交付那一刻才写 | 18 | 6 次交付，type/tags 始终没设 |
| README调整（10-19 03:51，workpad 上线前） | 空 | sonnet-5.5 / medium | 无 | 无 | — | **0** | 整卡零调用 |

对照：同期 Opus 5.5（auto/high）与 Codex（gpt-6.1-sol、gpt-6-astra）的 13 张卡全部设了 type、tags 并有 workpad；Sonnet 5.5 xhigh 的 4 张、以及描述较长的 Sonnet medium 卡（外部条目，1972 字）也都合规。即**违规集中在“标题式小卡（描述为空）+ Sonnet medium/auto”**。

workpad 时机：即使写了，也常在实现之后、甚至交付同一分钟才写（手机端性能优化、设计端到端测试方案、paseo project settings互通、发布v1.5.0），“验收标准先于实现”基本没落实。

## 2. 原因

- **R1 skill 里位置靠后、触发时机含糊。** 22 条职责中 tags、type、workpad 是第 11–13 条，前面是约 9 KB 的提问、ideas、next moves、artifacts、外部条目说明。措辞是“Once you understand the scope”“once you understand the work”，没有可检查的时刻；小卡上 agent 读完标题就“理解了”，直接写代码。
- **R2 缺项是静默的。** `sessionContext`（`shared/scope.ts`）在没有 type/tags 时**省略** `Task type:`、`Tags:` 两行；`flowly_get_task` 里 type 缺失只是没有这个键，tags 是 `[]`，workpad 是 `null`。没有任何一处写“缺”。
- **R3 工具反馈只覆盖收尾。** 现有提醒（NEXT-MOVES-SPEC §9）只在 in_review/blocked/question/result 上，只管 next moves 与 ideas。证据很直接：上表违规的 session 在每次交付都带了 next moves（`flowly_update_status` 的 schema 和结果都提到它），却没有一个设 type/tags——**agent 跟随工具 schema 与工具结果，而不是长 skill**。
- **R4 门槛反向激励。** `WORKPAD_OPEN` 只在“有 workpad 且有未完成项”时拦；不写 workpad 反而永远不会被拦。
- **R5 零调用回合。** “调整sidebar…”“README调整”整卡没有调用任何 Flowly 工具，结果里的提醒和门槛都碰不到，只有首条指令能影响它们（NEXT-MOVES-SPEC §9.1 已记录这类回合）。
- 模型与思考档位是放大器，不是根因：同一份 skill，强模型能从长文里捞出要求，弱档位只做 schema 里看得见的事。本规范不按模型分支，也不改默认模型（[MODEL-DEFAULTS-SPEC](MODEL-DEFAULTS-SPEC.md)）。

## 3. 设计

“开工设置”指三项：**type** 已设、**tags** 至少一个、**workpad** 有内容（至少一条验收标准或一条验证；项目关闭 workpad 时不算此项）。谁设的都算（人设的 type/tags 同样满足）。

缺项判断是纯函数 `setupMissing(task, workpad, workpadOn): ("type" | "tags" | "workpad")[]`，顺序固定，放 `shared/card-setup.ts`，服务端与测试共用。空 workpad（三个列表都空）视为缺失。

### 3.1 `flowly_get_task` 的 `setup` 字段

结果在 `identity` 之后、`task` 之前新增（键顺序固定，agent 先看到它）：

```ts
setup: {
  typeMissing: boolean,
  tagsMissing: boolean,
  workpadMissing: boolean,   // workpadEnabled=false 时恒为 false
  stage: TaskStatus,         // 卡片当前状态，同 task.status
  missing: ("type" | "tags" | "workpad")[],  // 上面三项为 true 的，顺序固定
}
```

`toolResultSchema` 的 `current` 同步带上（写入结果里的 `current` 也是 get_task 形状）。CLI `current` 原样输出。只读，不写事件。

### 3.2 首条任务上下文

`sessionContext` 在 `missing` 非空时，于 `Tags`/类型行的位置加一行（英文，agent 面向）：

`Card setup missing: type, tags, workpad. Before you change anything, set them (flowly_set_type, flowly_set_tags, flowly_update_workpad with acceptance criteria and the checks you will run); see "Start of every turn" in the Flowly skill.`

只列真正缺的项；项目关闭 workpad 时不列 workpad。三项齐全时不出现。它反映建卡/开 session/显式“工作说明”那一刻的状态；之后以 get_task 为准。普通跟进消息仍只发用户原文（AGENTS.md），不加此行。

### 3.3 写入结果里的设置提醒

所有 agent 写工具成功后（含重放），按写入后的看板计算 `missing`，非空时在 `reminders` 里加**一条**合并文字：

| 工具 | 设置提醒 |
| --- | --- |
| `flowly_update_status`（任意目标状态） | 是 |
| `flowly_report_progress`（任意 kind） | 是 |
| `flowly_update_workpad`、`flowly_suggest_next_moves`、`flowly_add_artifact`、`flowly_remove_artifact`、`flowly_propose_idea`、`flowly_set_tags`、`flowly_set_type` | 是 |
| `flowly_get_task`、`flowly_read_external`、`flowly_read_ticket`（只读） | 否（get_task 有 `setup`） |

- 计算在写入之后：`flowly_set_type` 自己的结果不再提 type，`flowly_update_workpad` 写入非空内容后不再提 workpad。
- 卡片已 Done/Cancelled 或已归档时不带（同 §9.5 现有规则）。写入失败不带。
- 与交付提醒同时出现时，交付提醒（next moves、ideas）在前，设置提醒在后。
- 文案（英文；`{items}` 按顺序只列缺的项，用“; ”连接）：
  `This card's setup is incomplete: {items}. Make these calls now, before more work; they take seconds. This write already succeeded.`
  - type：`no type (flowly_set_type: feature, bugfix, research, refactor, docs or chore)`
  - tags：`no tags (flowly_set_tags: 1-4 module or direction tags, reuse projectTags)`
  - workpad：`no workpad (flowly_update_workpad: the acceptance criteria and the checks you will run, before you implement)`
- 噪声取舍：只要缺就每次写入都提醒（一行字，补齐即消失）。不做“每轮只提一次”，因为缺项正是要在第一次写入时就补上。

### 3.4 交付软卡

agent 调 `flowly_update_status(status=in_review)` 且状态确实变化时（与现有 `WORKPAD_OPEN` 条件相同；人拖动不检查），一次性计算：

- `missing`（§3 定义，含“没有 workpad”）；
- 有 workpad 时的 `openItems`（WORKPAD-SPEC §5.3）。

任一非空且未在本 session 对当前状态拒绝过，或没有 `acknowledgeOpen: true`：返回错误，不提交、不写回执（同一 request 可带确认后重试）。一个错误列出全部问题，避免 agent 连撞两次：

- 有未完成的 workpad 项：错误码仍为 `WORKPAD_OPEN`（兼容现有 agent 与测试），消息在原清单前加设置缺项一行（若有）。
- 只有设置缺项：新错误码 `SETUP_INCOMPLETE`，消息：
  `Card setup is incomplete: {items}. Set them now and deliver again. Deliver anyway only with acknowledgeOpen=true and a note that explains why each one is missing.`

本 session 已收到当前状态的拒绝后，再带 `acknowledgeOpen: true`：照常提交；`status_changed` 事件新增可选 `setup: { missing }` 快照（与现有 `workpad` 快照并列），供以后的 Insights 统计。卡面“Delivered with {n} open items”的计数**不**含设置缺项（本卡不改 UI）。

2026-10-22 修订：预带 `acknowledgeOpen=true` 不再绕过首次拒绝。状态指纹、过期、回合切换和重载规则见 [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §2。

CLI 已有 `--acknowledge-open`，不变。`flowly_update_status` 的 `acknowledgeOpen` 描述改为“…still open workpad items or missing card setup (WORKPAD_OPEN, SETUP_INCOMPLETE)…”。

对 WORKPAD-SPEC §5.3 的修改：第 2 步“没有 workpad 照常提交”改为“没有 workpad（项目开启时）按 CARD-SETUP-SPEC §3.4 软卡”。

### 3.5 工具描述（`server/tool-server.ts`）

agent 跟随 schema（R3），所以描述里写明：

- `flowly_get_task`：末尾加 “Then check setup.missing and fix it (set_type, set_tags, update_workpad) before other work.”
- `flowly_update_status`：加 “Delivering with missing setup (no type, no tags or no workpad) returns SETUP_INCOMPLETE …”；写结果“any write’s result may carry a setup reminder”。
- `flowly_set_type`、`flowly_set_tags`、`flowly_update_workpad`：首句加时机 “Do this at the start of the work, before you change code.”

### 3.6 Skill（`server/skill-source.ts` 与 `skills/flowly/SKILL.md` 同步）

在 `# Flowly` 下、现有条目之前加一段，其余职责保持原顺序排在后面：

```
## Start of every turn

1. Read flowly_get_task. Handle unread inputs first.
2. Fix setup.missing before anything else, small cards included (a one-line fix still gets a type, one tag and a workpad with one acceptance criterion and the check you will run):
   - type: flowly_set_type (only when missing; never change a set type);
   - tags: flowly_set_tags, 1-4 tags, reuse projectTags;
   - workpad: flowly_update_workpad with acceptance criteria and the exact checks, before you change code.
3. Set the stage that matches the work you are about to do (design, development, test).
4. End the turn as below: workpad checks updated, next moves on deliveries, questions and results.

Any write's result may carry reminders about missing setup; make those calls before you continue.

## Details
```

同步修改原条目：tags 一条的“Once you understand the scope” → “At the start of the work (Start of every turn, step 2)”；type 一条的“once you understand the work” → 同上；reminders 一条补 “…and missing card setup (any write)”；workpad 一条补 “Delivering without a workpad, type or tags returns SETUP_INCOMPLETE; deliver only with acknowledgeOpen=true and a note that explains it.” skill `description` 不变。

### 3.7 不做

- 不改写入语义：设置缺项只提醒，唯一的拦截是 §3.4 的交付软卡，且可确认放行。
- 不在回合结束后由 daemon 替 agent 发消息或代调工具；不自动猜 type/tags（卡片第 5 项）。
- 不按模型或思考档位区别对待。
- 卡面/抽屉给用户显示“设置未完成”：另提 idea。

## 4. 新手引导与文档

- 用户看得到的变化只有 agent 行为（更早出现 type、tags、workpad；交付说明里解释缺项），没有新界面时刻，因此**不加一次性提示**。
- 欢迎页特色列表的 Workpad 一条改为：“Agents set the card's type and tags and write a workpad before they start: acceptance criteria, checks marked passed, failed or not run on a named commit, and what confused them. Delivering without them needs a note.” 改动的英文键在 `shared/i18n/` 全部目录更新。
- README / README.zh-CN Highlights 的 workpad 一句同步上述含义。
- agent 面向文字与 daemon 错误保持英文，不进 i18n。
- 实现时在 SPEC-OUTLINE 顶部加一条记录，PROGRESS.md 记录完成/失败/未运行的检查。

## 5. 验收

聚焦单测：

- `shared/card-setup.test.ts`：`setupMissing` 三项各自缺/不缺；人设的 type/tags 算已设；空 workpad 算缺；`workpadOn=false` 不列 workpad；顺序固定。
- `server/agent-service.test.ts`：
  - get_task 带 `setup`，type/tags/workpad 补齐后各项变 false；
  - 缺 type 时 `update_status(development)`、`update_workpad`、`report_progress(progress)` 都成功且 `reminders` 含设置提醒；**已设 type 不再提 type**；`set_type` 自身结果不提 type；三项齐全时没有 `reminders` 键；重放也带；Done 卡不带；
  - 与 next moves 提醒同时出现时顺序为交付提醒在前；
  - 交付：只缺 tags → `SETUP_INCOMPLETE`，状态未变、无回执；同一 request 带 `acknowledgeOpen` → 提交且事件带 `setup` 快照；无 workpad（项目开启）→ `SETUP_INCOMPLETE`；项目关闭 workpad 且 type/tags 齐全 → 照常提交；workpad 有未完成项且缺 type → `WORKPAD_OPEN`，消息含两者；
- `shared/scope.test.ts`：`sessionContext` 缺项时有 `Card setup missing:` 行且只列缺的项，齐全时没有。
- `server/tool-server.test.ts`：`flowly_update_status` 描述含 `SETUP_INCOMPLETE`；skill 文本以 “Start of every turn” 段开头。
- `npm test`（含 i18n 目录检查）与 `npm run typecheck` 通过。

Luna 6 验证（codex/gpt-6-luna，full-access；用 Tinylink 项目，结束后只清理自己建的卡和 session）：

- 建一张**只有标题、没有描述**的小卡（复现 §1 的失败人群），在卡上开 `claude/claude-sonnet-5-5`、思考 medium 的 session，发一条普通的改动请求。
- 期望：首条上下文含 `Card setup missing:`；agent 在第一次 `development` 之前设了 type、tags 并写了 workpad；若它没做，任一写入的结果里出现设置提醒，之后补齐；交付时没有缺项，或撞到 `SETUP_INCOMPLETE` 后补齐/带说明确认。
- 证据（session ID、事件时间线、写入结果片段）存 `docs/verification/card-setup-<date>.md`。

## 6. 实现落点

`shared/card-setup.ts`（新）、`shared/tools.ts`（`setup` schema、`acknowledgeOpen` 描述）、`server/tool-server.ts`（工具描述）、`server/agent-service.ts`（get_task、reminders 计算扩展到全部写工具、交付门槛合并）、`server/reminders.ts`（`setupReminder`）、`shared/scope.ts`（首条上下文）、`server/skill-source.ts` + `skills/flowly/SKILL.md`、`server/cli-source.ts`（`status` 用法文字）、`client/onboarding.tsx`、README、`shared/i18n/*`、WORKPAD-SPEC §5.3、NEXT-MOVES-SPEC §9.2 表格加一行指向本文。
