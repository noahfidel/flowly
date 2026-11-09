# Ideas 卡片：agent 提议下一步任务

状态：用户 2026-10-15 确认设计（来源 A：agent 工具；显示 A：来源卡侧栏 + 角标；建卡 A：预填新建表单），并要求直接实现、不再审阅 spec。卡片任务 `fa62fb3d`。

## 1. 目的

agent 工作时常发现本卡范围之外、值得做的后续工作（顺带发现的 bug、重构机会、下一阶段功能）。现在这些只留在对话里，用户要自己记、自己重新描述上下文。

Ideas 让 agent 把它们作为结构化建议挂到来源卡上。用户觉得好时有两条路（2026-10-16 用户要求“两种路径都要支持”）：

- **在本卡继续**：idea 是当前任务的延伸，作为一条指令发回本卡的 session，在原上下文中接着做；
- **新建卡片**：idea 是发散性的工作，打开预填好的新建表单，带着上下文建出新卡。

不好就忽略。

idea 不是任务卡：不进泳道、不占 workspace、不改来源卡状态或 task revision。只有用户点 **Good idea** 并选择一条路才会发生动作；agent 永远不自行建卡或派活（v1 不做自动分配）。

Amended 2026-10-29 (user decision, [AGENT-CARDS-SPEC](AGENT-CARDS-SPEC.md) D1): an agent may create or edit cards with `flowly_create_card` / `flowly_update_card` when the user asks it to in the session. Follow-up work the user did not ask for is still an idea, and an idea still becomes a card only through the user. No session is started on an agent-created card.

## 2. 数据

### 2.1 Idea

存在 `board.json` 的 `ideas` 数组（与卡片、事件、回执同一个文件），使提出 idea 与回执、从 idea 建卡与标记 accepted 都在同一次原子事务中完成，客户端也随现有 etag 看板读取拿到 ideas，不新增轮询。旧文件没有该字段时读作 `[]`；看板版本仍为 v4，不迁移。

```
{ id, taskId（来源卡）, projectId, agentId, eventId（提出时的 Activity 事件）,
  title    ≤120 字符，非空
  detail   ≤4000：要做什么、验收标准
  rationale ≤1000：为什么值得做、由什么触发
  context  ≤4000：新任务需要的文件、分支、发现（新卡的 agent 看不到来源卡对话）
  type?: TaskType, priority?: Priority,
  scope?: "here" | "new",      // agent 的建议：在本卡继续 / 新建卡片；缺省读作 "new"
  status: "open" | "accepted" | "dismissed",
  acceptedTaskId?: string,     // 选择“新建卡片”后建出的卡
  acceptedAgentId?: string,    // 选择“在本卡继续”时发往的 session
  createdAt, updatedAt }
```

- 每张卡最多 10 个 `open` idea；每张卡最多保存 50 个 idea，超出时删除最早的非 open idea。
- `accepted` 是终态，不能再改。

### 2.2 Task.origin

卡片新增可选字段 `origin: { taskId, ideaId }`，表示由哪张卡的哪个 idea 建出。旧卡没有该字段，不迁移。来源卡或 idea 后来被删除时字段保留，界面显示为已删除。

2026-10-16 起由 [CARD-LINKS-SPEC](CARD-LINKS-SPEC.md) 取代展示：建卡时同时写一条 `derived` 关联，界面与工具只读关联；`origin` 仅作历史记录保留。

### 2.3 回执与事件

- 回执 `action` 新增 `"idea"`；`status` 记录提出时卡片的状态。
- Activity 事件：
  - `idea_proposed`（agent，来源卡，note=标题）
  - `idea_accepted`（human，来源卡，note=`标题 → 新卡标题`）
  - `idea_adopted`（human，来源卡，agentId=目标 session，note=标题）
  - `idea_dismissed`、`idea_restored`（human，来源卡，note=标题）
  - `idea_edited`、`idea_dismissed`、`idea_removed`（agent，来源卡，agentId=调用的 session，note=标题；§3.1）
- 回执 `action` 另有 `"idea_update"`、`"idea_remove"`（§3.1）。
- 2026-10-22 Astra 审查修复：新 idea 提出、更新和删除回执同时持久化可选 `ideaId`，重放优先返回回执保存的 ID；idea 被删除或自动裁剪后仍返回原 ID，不复活实体、不重复事件。旧回执无该字段时，更新/删除从请求 ID 兼容读取，提出仍从保留的 idea 反查；已删除的旧实体无法事后恢复 ID，不做数据迁移。
- 新增 `idea_edited`、`idea_removed` Activity 动作使用 `msg()` 标记的本地化映射（英文键 `Edited the idea`、`Removed the idea`）和全部语言目录，随界面语言切换。

## 3. Agent 工具 `flowly_propose_idea`

输入（strict）：

```
{ expectedRevision, request,             // 同其他写工具，来自 flowly_get_task
  title, detail, rationale,
  context?: string = "",
  type?: "feature"|"bugfix"|"research"|"refactor"|"docs"|"chore",
  priority?: "low"|"normal"|"high"|"urgent",
  scope?: "here"|"new" = "new" }   // here：本卡目标的延伸，本卡 session 带着现有上下文就能接着做；new：发散性工作
```

- 与 `flowly_report_progress` 相同的身份、签名、过期、revision、归档和已完成检查；不改卡片状态或 revision。
- 重放：同一 request 同一参数返回原回执与原 `ideaId`（`replayed: true`）；参数不同报 `REQUEST_REUSED`。
- 错误：
  - `IDEA_DUPLICATE`：本卡已有同标题的 open idea（去首尾空白、忽略大小写），消息中带已有 idea ID。
  - `IDEA_LIMIT`：本卡已有 10 个 open idea。
- 输出：`toolResultSchema`，多一个 `ideaId`。
- `flowly_get_task` 的上下文新增 `ideas: [{ id, title, status, scope?, acceptedTaskId?, acceptedAgentId? }]`（本卡全部 idea），供 agent 避免重复。
- CLI 新增 `idea` 子命令：`idea --request-file <snapshot> --title … --detail … --rationale … [--context …] [--type …] [--priority …] [--scope here|new]`（不需要 `--note`）。HTTP `/api` 的 `action` 新增 `"idea"`。

### 3.1 Agent 管理本卡的 idea（2026-10-22 卡片“扩展idea工具”）

用户要求 agent 能自行管理 ideas（关闭、修改、删除），例如用户在对话里驳回了某个提议，agent 直接把它关掉，而不是一直挂在卡上。

- `flowly_update_idea { expectedRevision, request, id, title?, detail?, rationale?, context?, type?, priority?, scope?, tags?, status?: "dismissed" }`：只传要改的字段（`tags` 整体替换建议标签，`[]` 清空）。`status: "dismissed"` 关闭 idea，与用户点 Dismiss 结果相同（进入 Closed 分组，用户可 Restore）。改字段与关闭可在同一次调用里完成，各记一条事件（先 `idea_edited`，后 `idea_dismissed`）。
- `flowly_remove_idea { expectedRevision, request, id }`：删除 idea，用于提错或重复的。用户驳回的推荐用 dismiss（保留可见、可恢复），删除只留下 `idea_removed` 事件。
- 范围与约束：
  - 只能操作本卡（连接所绑定的卡）上的 idea，本卡任何 session 提出的都可以；其他卡的 id 报 `IDEA_NOT_FOUND`。
  - `accepted` 是终态：改、关、删都报 `IDEA_CLOSED`。
  - 只有 `open` 的 idea 能改字段；`dismissed` 的只能删除，恢复（Restore）仍只有用户能做，agent 不推翻用户的忽略。再次 dismiss 已忽略的 idea 不改数据、不记事件。
  - 改标题时与本卡其他 open idea 做同样的重名检查（`IDEA_DUPLICATE`）。没给任何字段也没给 `status` 报 `INVALID_INPUT`；给的值与现值相同则不改数据、不记事件（回执 `eventId` 为空）。
  - 其余与 `flowly_propose_idea` 相同：身份、签名、过期、revision、归档与已完成卡拒绝（`ARCHIVED` / `TASK_FINISHED`）、Ideas 关闭报 `IDEAS_DISABLED`、重放返回原回执、参数不同报 `REQUEST_REUSED`；不改卡片状态或 task revision。结果的 `ideaId` 为所操作的 idea。
- CLI：`idea-update --request-file … --id <idea id> [--title --detail --rationale --context --type --priority --scope --tags a,b] [--dismiss]`，`idea-remove --request-file … --id <idea id>`；HTTP `/api` 的 `action` 新增 `"idea_update"`、`"idea_remove"`。
- 界面不变：侧栏与 Ideas 页照常经 etag 读取刷新，agent 关闭的 idea 出现在 Closed 分组。

## 4. Skill 规则（新增一条）

- 每次交付（`in_review`）时回顾本回合注意到的、用户没要求但值得做的东西（顺带发现的 bug、重构机会、后续功能），最多提 3 个，用 `flowly_propose_idea`；确实没有值得提的可以是 0 个，但要有意识地决定，不是忘了（§4.1 在没提过时提醒）。本卡目标的延伸用 `scope=here`（用户可能把它发回本 session 继续）；发散性工作（顺带发现的 bug、重构、独立功能）用 `scope=new`。本卡本来就要求的工作不是 idea，直接做。
- 每次交付最多 3 个；先看 `ideas` 避免重复。
- `context` 写清新任务需要的文件、分支和结论，因为新卡的 agent 看不到本对话。
- idea 只是建议：不要自行开始、不要建卡。
- 保持本卡 open idea 是最新的（§3.1）：用户在对话里驳回、或本卡已经做了/使它失去意义时用 `flowly_update_idea status=dismissed` 关闭；内容错误或过时用 `flowly_update_idea` 修改；提错（重复）的用 `flowly_remove_idea` 删除。已采纳的是终态，已忽略的只有用户能恢复。

### 4.1 交付时提醒（已实现，2026-10-20）

2026-10-20 卡片“Delivery-time reminders for missing next moves and ideas”。skill 里“通常在交付时”是可选的第二次调用，agent 做完活后不再想起：2026-10-19 当天 145 个回合里 7 个提了 idea，2026-10-20 截至设计时 26 个回合 0 个提了 idea。机制与 next moves 提醒相同，细节（触发、结果形状 `reminders: string[]`、键顺序、重放、与 next moves 的关系）见 [NEXT-MOVES-SPEC](NEXT-MOVES-SPEC.md) §9；这里只写 ideas 的部分。

- 触发：`flowly_update_status` → `in_review` 成功后。其它调用（`blocked`、`question`、`result`、切换工作阶段）不提醒 ideas。
- 条件（三者同时满足）：Ideas 设置为开；写入成功；该会话（`agentId`）在本卡**从未**提出过 idea。后者读 `board.ideas`（`taskId` + `agentId`，含已忽略/已采纳的），不读 `idea_proposed` 事件，因为事件按卡片只保留最近 100 条，忙碌的卡上旧事件会被修剪而误报。
- 这是“卡片级”而非“本轮级”：会话在本卡提过一次后，之后的交付不再提醒（skill 仍写“每次交付”）。理由：没有“我决定提 0 个”的回执，本轮级提醒会让有意识选 0 的卡每次交付都被重复提醒。想改成本轮级，把来源换成 `idea_proposed` 事件并以最近的 `agent.turn_started` 为界即可。
- Ideas 关闭时静默：不提醒，也不读取 ideas。`IDEAS_DISABLED` 的行为不变。
- 文案（英文）：`You have proposed no ideas on this card. Consider 0-3 ideas (flowly_propose_idea) for worthwhile follow-ups you noticed: bugs, refactors, next features. Zero is fine; decide on purpose.`
- 只是文字：写入照常成功，不拦截（不同于 `WORKPAD_OPEN`），不新增错误码，不写入看板，不改 `idea` 的任何校验与上限。

## 5. UI

### 5.1 看板卡片

有 open idea 时，在卡片底部信号行显示灯泡图标（`Lightbulb`）加数量；为 0 时不显示。无障碍文本包含 “N ideas”。

### 5.2 侧栏 Ideas 区块

位置：Sessions 之后、Details 之前（2026-10-15 用户反馈：放到 Sessions 下面）。卡片没有任何 idea 时整个区块不渲染。

- 标题 `Ideas`，计数为 open 数。
- 每个 open idea 一张小卡片（2026-10-16 用户要求优化设计、交互与动效，接受按钮改为 Good idea）：
  - 标题（加粗）；一行元信息：类型、优先级（仅非 Normal；High/Urgent 带箭头图标，Low 显示为不带图标的 “Low priority”）、提出时间（相对时间）；理由；What to do（detail）与 Context 不截断地排在其后。字体与 Progress 卡片一致：标题 base 中等字重（同 State），理由与字段正文 md，字段名与元信息 xs 弱化色。
  - 截断渐隐（2026-10-19 用户反馈，与 Progress 卡片一致，共用 `client/content-card.tsx` 的 `ContentCard` 通用卡片样式）：整块内容（标题、元信息、理由、What to do、Context）超过约 5 行（104 pt）时整体收起到该高度，底部渐隐；底部同一行左侧为 Show more / Show less 展开或收起，右侧为操作按钮（高度过渡 220 ms 减速 / 160 ms 加速，可打断，遵循 Reduce Motion）。内容未超出时完整显示且不出现 Show more。Show more 的图标与文字贴齐正文左边缘（静止时与上方文字对齐），悬停高亮向外只多出 6 pt，不贴卡片边框；标题与元信息一组，其后的块（理由、What to do、Context）之间间距与 Progress 一致（8 pt）。点击卡片本身不再展开，文字可直接选择。
  - 右下角按钮（2026-10-19 用户反馈：右对齐，恢复标准尺寸，不再使用紧凑尺寸；与 Show more 并排在同一行以节省空间。Ideas 页的来源行 “From …” 位于该行之下）：**Dismiss**（安静按钮，忽略；2026-10-19 由 Not now 改名）、**Good idea**（主操作，`ThumbsUp` 图标，打开选择菜单，见 §6，位于最右）。无障碍名称分别为 “Dismiss …”、“Good idea: … Choose to do it in this task or start a new task.”。Closed 分组的 Restore 仍使用紧凑尺寸。
  - 元信息行最前面显示 agent 的建议：`CornerDownRight` “Continues this task” 或 `SquarePlus` “New task”。
  - Dismiss 为乐观更新：卡片立即离开，在原位收起（高度、透明度与轻微缩放一起过渡 160 ms），桌面与手机一致，与 Memory 卡片相同（2026-10-22 用户决定：Memory 的收起更好，取代 2026-10-19 的桌面向右滑出）。Reduce Motion 下直接移除。保存失败时恢复并弹 error toast。“在本卡继续”同样乐观收起，成功后弹 success toast “Sent to <session>”；idea 被转成卡片后同样收起离开列表。
  - 抽屉打开时已有的 idea 不播放进场。打开期间新到达（agent 提出）或被 Restore 的 idea 播放插入动画：先展开所在行高度（160 ms），再进场淡入（220 ms 减速）；Restore 的卡片与新到达的一样轻微上浮（不再从右侧滑入）。即使该 idea 在抽屉打开时就存在，Restore 也会播放插入动画（2026-10-19 用户反馈）。Reduce Motion 下直接出现。
  - 所有动效使用 `client/motion.tsx` 原语，遵循 Reduce Motion、可打断；收起中的卡片不可交互、对读屏隐藏。
- 没有 open idea 但有已关闭的 idea 时显示 “No open ideas. Agents add them when they see a worthwhile next step.”
- 非 open 的 idea 收在默认折叠的 `Closed · N` 分组：
  - accepted（`ThumbsUp` 图标）：新建卡片时显示 “→ 新卡标题”，点击打开该卡，新卡已删除时显示 “→ deleted card”；在本卡继续时显示 “→ Sent to <session 标题>”。
  - dismissed：显示弱化标题与 **Restore**。
- 项目已归档时按钮禁用。卡片 Done/Cancelled 或已归档时 idea 保持 open，只能新建卡片或忽略（2026-10-16 起，见 [IDEAS-INBOX-SPEC](IDEAS-INBOX-SPEC.md) §2）。
- Dismiss / Restore 成功不弹 toast（列表本身即反馈），失败用 error toast。

### 5.3 新卡侧栏

有 `origin` 时，在描述之前显示一行 “From idea on <来源卡标题>”，点击打开来源卡；来源卡已删除时显示 “From idea on a deleted card”，不可点。

## 6. Good idea 的两条路

点 **Good idea** 打开插件菜单（桌面为锚定下拉、手机为底部弹层），标题 “Good idea”（2026-10-16 用户确认加入“新 session”与“选择 session”）：

- **Continue in <session>**（`CornerDownRight`）→ §6.2，发给默认 session：提出该 idea 的 session（仍在本卡 workspace 且未归档）优先，否则本卡最新的未归档 session；没有可用 session 时不显示此项；
- **Send to another session…**（`MessagesSquare`，本卡有 2 个及以上未归档 session 时出现）→ 打开第二个菜单 “Send to”，列出所有未归档 session（默认的那个带 `Check`），选中后按 §6.2 发送；
- **Do it in a new session**（`Plus`）→ §6.3；
- 分隔线；
- **Start a new task**（`SquarePlus`）→ §6.1。

（2026-11-09 起）`scope=new`（或没有 scope）的 idea 在 *Quick task for New task* 开启、来源卡可继续时，Good idea 不弹菜单，直接打开 Quick task；本卡的动作通过对话框的 **Other options…** 到达：Continue in <session>、Send to another session…（有 2 个及以上未归档 session 时）、Do it in a new session，以及完整表单。*Quick task for New task* 关闭时没有 Other options…，所以仍弹菜单，“Start a new task · Suggested” 排在最前、其余在分隔线后。`scope=here` 的 idea 始终弹菜单，本卡的三项在前，不受该设置影响。

建议 `scope=here` 时本卡的三项在前，Continue 带 “· Suggested”（没有可用 session 时改由 “Do it in a new session” 带 Suggested）。

“Start a new task” 在 *Quick task for New task* 开启时打开 Quick task（锁定 idea 的项目，预填 idea，带 `ideaId`；对话框里的 **Other options…** 列出完整表单和上面本卡的三项），关闭时打开 §6.1 的完整表单；见 QUICK-TASK-SPEC §10。项目 idea 与来源卡已结束/归档/不存在的 idea 只有新建一条路，Good idea 直接打开同一个 Quick task（或完整表单），不再弹菜单。

### 6.4 Discuss

每个 open idea 卡在 Dismiss 左侧有 **Discuss**（侧栏 Ideas 与项目 Ideas 页，共用 `IdeaCard`），仅当看板能打开 dispatcher 聊天时显示。它打开 dispatcher 聊天，把一段关于该 idea 的草稿放进消息框，不发送；见 DISPATCHER-SPEC §9.5。

### 6.1 新建卡片

1. 打开现有新建任务表单（同一组件），预填：
   - 标题、类型、优先级 = idea 的值（未给则为表单默认）；状态 = 该项目第一个可用的起始泳道（与普通新建相同的默认）。
   - 描述 = `ideaDescription()`（`shared/ideas.ts`）：

     ```
     <detail>

     Why: <rationale>

     Context:
     <context>

     From card: <来源卡标题> (<来源卡 ID>)
     Source progress:            // 仅当来源卡有 summary
     <target>
     <recap>
     ```

     超过描述上限 20000 时截断并以 `…` 结尾。
   - workspace 与 “Start agent” 照常可选；第一条指令不预填（现有规则）。
   - 表单标题为 “Create task from idea”。
2. 保存时 `tasks.create` 的输入带 `ideaId`。服务端：
   - 创建 workspace **之前**检查 idea 存在、为 open、属于同一项目，否则报 “This idea is no longer open.”，不留下 workspace。
   - 写入新卡的同一事务中再检查一次，写 `origin`，把 idea 改为 accepted 并记录 `acceptedTaskId`，在来源卡记 `idea_accepted` 事件。
   - 同一 `operationId` 的重复提交返回首次创建的卡（现有行为），不重复处理 idea。
3. 新卡的 agent 会话上下文在任务类型之后加一行 `Derived from card: <来源卡标题> (<ID>)`。

### 6.2 在本卡继续

`ideas.adopt { id, agentId }`（`server/ideas.ts`）：

1. 校验 idea 为 open，目标 session 属于本卡 workspace、未归档、不是 summarizer，否则报错且不改任何数据。
2. 先在一次事务中把 idea 改为 accepted、记录 `acceptedAgentId`、在本卡记 `idea_adopted` 事件（卡片或项目已归档时拒绝），这样重复点击不会发两次。
3. 再通过 composer 队列把 `ideaInstruction()` 发给该 session：空闲时立即发送，运行中则排在当前回合之后（与侧栏发消息的排队行为一致，不打断）。消息：

   ```
   Good idea — go ahead with it in this task: <title>

   <detail>

   Why: <rationale>

   Context:
   <context>
   ```

   这是用户显式选择的看板动作，因此不受“普通跟进只发送用户原文”的限制。
4. 入队失败时把 idea 恢复为 open、删除该事件，并把错误返回给界面。

不改卡片状态或 task revision；session 收到消息开始新回合后，现有自动状态规则照常生效。

### 6.3 用新 session 做

适合原 session 正忙、上下文过长或想换模型的情况。

1. 打开现有 “Start session” 弹窗（`SessionCreate`），预填 session 标题 = idea 标题、第一条指令 = `ideaInstruction()`；模型、模式照常可选，指令可修改。由于是用户从 idea 显式发起，这里预填指令是允许的（普通 Start session 仍不预填）。
2. session 创建成功后调用 `ideas.adopt { id, agentId: <新 session>, send: false }`：只校验并记录（accepted、`acceptedAgentId`、`idea_adopted` 事件），不再经 composer 发送，避免重复。
3. 记录失败时 session 照常运行，弹 error toast “Session started, but the idea was not marked: …”；关闭弹窗不创建 session 时 idea 保持 open。

## 7. 人工 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `ideas.update` | `{ id, status: "open" \| "dismissed" }` | open ↔ dismissed；accepted 报错；恢复为 open 时，若本卡已有同标题（去首尾空白、忽略大小写）的 open idea 则报错 “This card already has an open idea with that title.”，并受 10 个上限约束；状态不变时不写 |
| `ideas.adopt` | `{ id, agentId, send = true }` | 在本卡继续（§6.2）；`send: false` 只记录（§6.3）；返回更新后的 idea |

看板 revision 随之增加，客户端经现有 etag 读取刷新。

## 8. 删除与归档

- 永久删除卡片：一并删除以它为来源的 idea，写入 `removed/task-…json` 备份。由这些 idea 建出的卡保留 `origin`。
- 移除项目：一并删除并备份该项目的 idea。
- 归档卡片：idea 保留且仍可处理（只能新建卡片或忽略，IDEAS-INBOX-SPEC §2）；agent 不能再提出（与其他写工具一致）。

## 9. 不做

- summarizer 自动生成 idea；虚拟 Ideas 泳道。项目级 Ideas 页已于 2026-10-16 加入，见 [IDEAS-INBOX-SPEC](IDEAS-INBOX-SPEC.md)。
- 自动建卡或自动给新卡派 agent；idea 排序、投票；用户在界面上编辑 idea（agent 编辑见 §3.1）。

## 10. 验收

- 单元：
  - 提出：回执重放、`REQUEST_REUSED`、`IDEA_DUPLICATE`、`IDEA_LIMIT`、归档/已完成拒绝、不改 task revision、50 个上限修剪。
  - 建卡：预检与事务内复检、`origin` 与 accepted 原子写入、非 open idea 报错且不创建 workspace、跨项目拒绝。
  - `ideas.update` 状态约束；删除卡片与移除项目的级联与备份；旧 `board.json`（无 `ideas`）可读。
  - `ideaDescription()` 输出与截断；`sessionContext` 的来源行。
  - 管理（§3.1）：本卡 open idea 修改字段、关闭、删除；dismissed 只可删除或重复关闭；accepted 不可改删；跨卡拒绝；改名重名、空更新、Ideas 关闭；回执重放与 `REQUEST_REUSED`；事件记录正确，卡片 revision 保持不变。
  - Astra 回归：提出 → 删除 → 重载服务 → 原样重放提出，仍返回原 `ideaId` 和回执，保留空 ideas 且不再写文件；旧回执无 `ideaId` 且实体仍在时兼容反查；新增 Activity 两个键在全部语言目录中完整。
- 工具服务：注册 `flowly_propose_idea`、`flowly_update_idea`、`flowly_remove_idea`；`/api` 的 `idea` / `idea_update` / `idea_remove` 动作；`flowly_get_task` 返回 `ideas`；CLI `idea-update` / `idea-remove` 和无效参数拒绝。
- 管理工具的真实验证（2026-10-22）：已 reload 的插件上，以本卡临时 idea 走通 MCP 与 Luna 6 full-access CLI 的“提出 → 修改 → 关闭 → 删除”，检查回执重放、错误拒绝、Activity、卡片状态与 revision 不变，结束清理临时 idea 与测试 session。该增量没有客户端变更，桌面/compact 渲染不作为工具调用通过的证据。报告见 [idea-tools verification](verification/idea-tools-2026-10-22.md)。
- 交付时提醒（§4.1，`server/agent-service.test.ts`）：`in_review` 且该会话没提过 idea、Ideas 开 → 结果带 ideas 提醒；Ideas 关 → 没有；该会话已提过（含已忽略的）→ 没有；另一个会话提过的不算；旧的 `idea_proposed` 事件被修剪后仍不误报（按 `board.ideas` 判断）；`blocked`/`question`/`result` 不带 ideas 提醒；失败的写入（`WORKPAD_OPEN`）不带。
- typecheck、全量测试；安装并 reload 本插件；用 Luna 6 全权限测试 session 在 fixture 卡片上走通“提出 → 侧栏显示 → 建卡 → 双向链接”，结束后清理。
