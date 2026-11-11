# 原生 session pane 上的 Summary、Next moves、Ideas

状态：设计待评审，未实现。2026-10-20 与用户确认范围与两项取舍（§3）。卡片任务 `731e66bf`。

## 1. 目的

用户在 Flowly 里打开 session，能看到 Progress summary、输入框上方的下一步建议和本卡 Ideas；同一个 session 在 Paseo 原生 session pane 里打开时，这些都看不到，只有一个 **Task · 标题** chip（SESSION-CHIP-SPEC）。

目标是**体验一致**：同一个 project 下的 session，在 Flowly 内和原生 pane 里都能看到并使用这三项特色功能。

## 2. 范围与分期

本 spec 只做 **P1**（用户 2026-10-20 决定）。后续各期只作评估记录，不在本次实现。

| 期 | 覆盖的 session | 需要做的 | 难度 |
| --- | --- | --- | --- |
| **P1（本 spec）** | Flowly 管理的 session：从卡片启动，或通过 “Send Kanban work instructions” 加入（有工具凭据，`sessions.managed` 列出） | 数据都已存在，只缺原生 pane 上的展示与操作 | 中；客户端为主，服务端加一处 timeline 追加 |
| P2 | 卡片 workspace 里、未加入卡片的原生 session | 原生 pane 上一键“加入此卡”（复用 `tools.prepare-existing`），之后同 P1 | 低–中 |
| P3 | Flowly project 内、不属于任何卡片的 session（如项目主 workspace） | 无卡可挂：summary/ideas/next moves 改为按 session 存；agent 需要会话级凭据与说明 | 中–高 |
| P4 | 不在任何 Flowly project 的 session | 同 P3，且 ideas 没有项目收件箱可落 | 高 |

P3/P4 的建议方向（未决，供以后评估）：不依赖 agent 调用工具，而是让每轮结束后的 summarizer 在同一次调用里顺带抽取 next moves 与 ideas，与 provider 无关、无需注入工具；代价是每个 session 每轮多一次模型调用，必须有开关。

不做：

- 改变 summary / next moves / ideas 的产生方式、数据格式或 agent 工具。
- Flowly 内现有展示（侧栏 Progress、Ideas 区块、Ideas 页、输入框上方建议行）不删除、不改行为。
- 给 P1 之外的 session 显示新 chip（Task chip 维持现状，仍对卡片 workspace 内所有 session 显示）。

## 3. 用户决定

- Next moves 与 Ideas 在原生 pane 上分成**两个独立的 composer chip**。
- Summary 通过**原生 timeline** 展示。
- 只覆盖 P1。
- Flowly 内 session 视图不加 Progress 卡片，只在原生 timeline 显示（§5.4，2026-10-20 实现后追加）。
- **本功能完全不影响 Flowly 内部的行为与样式，只针对原生 session**（2026-10-20 实现后追加）。因此：Flowly 内建议行的 × 不与原生 chip 共享（§6.3）；不加 Flowly 内的一次性提示，欢迎页文案不变（§9）；summary 的写入与 Flowly 内展示不受原生行追加影响（§5.1）。唯一新增的 Flowly 入口是原生 Ideas chip 的 “Start a new task” 打开的 `ideaId` 看板链接（§7.3），不带该参数时看板行为不变。
- Summary 的原生 timeline 行是**尽力显示**：daemon 重启后旧行消失可以接受，不做补回（§5.2）。
- ~~原生 pane 上点 next move：弹层内显示可编辑文字，按 Send 才发送~~（2026-10-20 修订：点建议默认预填 Paseo 输入框，可在设置中改为复制，§6.4）。

## 4. 平台能力与限制（SDK 0.11.2；0.12.0 客户端契约相同）

| 能力 | 用途 |
| --- | --- |
| `client.addComposerPill({id, workspaceId, agentId, button})`，`behavior.kind: "popover"` | Ideas chip（弹层宽屏锚定在 chip 上，紧凑布局由 host 决定呈现方式） |
| `paseo.agents.ref(id).timeline.append({type:"plugin", kind, version, data})`（daemon 侧） | 把 summary 作为插件条目追加到该 session 的原生 timeline |
| `client.addTimelineRenderer({kind, version, schema, Component})` | 渲染 Progress 行与 Next moves 卡片 |

限制：

- **SDK 没有往原生输入框预填文字的接口。** 预填只能像 prompt-suggestions 那样在 web/桌面通过 DOM 找到输入框（`textarea[data-composer-input]`，经 React fiber 的 `agentId` 属性确定所属 session）后设置值；这依赖 Paseo 的内部结构，不是插件 API，因此必须做特性检测并在失败时退回复制（§6.4）。
- Paseo 要求 timeline kind 与行 id 匹配 `^[a-z][a-z0-9-]*$`，否则注册时抛错并使整个客户端插件加载失败。

## 5. Summary：原生 timeline 条目

### 5.1 何时追加（daemon，`server/summaries.ts`）

- summarizer 写入**新版本**（`update=true` 且解析成功）后，向**触发这次运行的看板管理 session**（单飞合并时取最后一个回合的 session）追加一个插件条目。
- `update=false`、失败、超时、出错：不追加。
- 手动 Refresh 产生新版本时，追加到 Refresh 所选的 session（TASK-SUMMARY-SPEC §6）。
- 追加前检查：该 session 未归档；且从触发回合结束到现在没有该 session 新的 `agent.turn_started`。若已开始新一轮，**跳过追加**（否则条目会出现在用户新消息之后，读起来像是对新消息的总结）；新版本仍正常写入 `summaries.json`，侧栏照常显示。（本条为设计者的决定。）
- 追加在后台进行（每步 10 s 超时），从不阻塞该卡后续的 summary 运行；失败只记日志（不打印内容），不影响 summary 写入，不重试。
- 卡片有多个 session 时，只追加到产生这次进展的那个 session；其它 session 的 timeline 不重复出现。

### 5.2 数据契约

`id: "flowly-summary-<entryId>"`（每个版本一行；同 id 再次追加会替换该行），`kind: "flowly-summary"`，`version: 1`，`data`：

```
{ taskId, workspaceId,        // 用于 “Open card” 的链接校验
  entryId,                    // summaries.json 中该版本的 id
  state, target, recap, next, // 与该版本完全相同，不截断
  model, at }                 // 生成模型与时间（ISO）
```

条目自带全部内容，渲染不需要 RPC。`data` 上限 64 KiB（Paseo 拒绝更大的），四个字段各 ≤4000 字符（TASK-SUMMARY-SPEC §3），远低于上限。

**生命周期（Paseo 文档，已确认）：** 追加的行存在 daemon 内存中的 timeline，滚动、refetch、重连后仍在，**daemon 重启后丢失**（实测：session 进程重载后同样丢失，§5.5）；插件缺失时显示 “unavailable” 占位。`summaries.json` 仍是 summary 的唯一持久来源，侧栏 Progress 与 History 不受影响。

### 5.3 渲染（`addTimelineRenderer`）

- 外观与侧栏 Progress 一致（共用 `ContentCard` 的框与正文）：卡片**外面**上方一行小标题（`AiMark` + “Progress”，灰色、中等字重、`font.sm`），卡片里是 `state`（强调）、Target / Recap / Next，脚注一行：左边 Show more / Show less，右边 “Updated 5m ago”（不显示模型，2026-10-23 用户决定；侧栏 Progress 仍显示）和 “Open card” 小按钮。**两张原生卡片的小标题相同**（2026-10-21 用户决定：保持 Progress 原来的样子，Next steps 向它对齐；曾试过把标题和 Open card 放进卡片头部，用户更喜欢原来的）：小标题在外（`client/native-card.tsx` 的 `NativeCardHeading`）。Next steps 之后又去掉了灰色卡片底（见 §6.3）。已知代价：手机宽度下 Progress 的脚注较挤，时间戳可能折成两行、按钮被截成 “Open ca…”（原版就如此，用户知情后仍选择保留原样）。
- **默认收起为一行**（2026-11-11 用户决定，设置 *Start progress rows collapsed*，host 设置 `native-session.progressCollapsed`，默认开）：一行内依次是 `AiMark` + “Progress” 小标题、一句 recap（`client/summary-line.ts` 的 `recapLine`：recap 第一个非空行去掉开头的列表符号/编号/标题符号与 `**`、`__`、`*`、`_`、反引号，空白合并，取第一句：`. ! ?` 后跟空白或结尾，或中日文 `。！？`；超过 160 字符截断加 “…”；屏幕上再按一行省略），recap 为空时用 state 的第一句，然后是 “Updated 5m ago” 和右端的 Show more。收起行不是被截断的卡片（2026-10-29 的问题），没有卡片框、没有 Open card。Show more 换成下方的完整卡片（不截断），脚注左边是 Show less，回到这一行。展开/收起只记在这一个已挂载的行上，不保存；重新挂载（refetch、重新打开）时又是收起。设置在行挂载后才读到时，行跟随设置，直到用户在这一行按过 Show more / Show less。
  - 设置关闭时与之前相同：**默认展开**，完整显示 State、Target、Recap、Next（2026-10-29 用户反馈：原先超过约 5 行即收起，几乎每条都被截断）。Show less 收起到约 5 行（104 pt）并渐隐，Show more 再展开，规则同 TASK-SUMMARY-SPEC §7（动画、Reduce Motion、首次测量不播放）；内容不超过约 5 行时不出现按钮。展开的卡片在首次测量前不先按 104 pt 截断，行挂载时不会先矮后跳高。
  - 设置如何到达这一行：Paseo 在 Flowly 的树外渲染 timeline 行，行只能读客户端模块状态。与 `nextMoveTap` 相同，chip 刷新（`client/session-link.ts`）从 `sessions.native-chips` 读 `progressCollapsed`（看板变化时或至多每分钟一次），存进 `client/native-chips.ts`；首次读到之前、或旧 daemon 不返回该字段时按开处理。因此改设置后已打开的会话至多约一分钟后生效。
  - Paseo 在 Flowly 的组件树之外渲染 timeline 行，没有 `MotionProvider` 时动画钩子默认按“减少动态效果”处理、直接跳变（2026-10-20 用户反馈）。原生 timeline 行、Next moves 卡片与 Ideas 弹层都包在 `SharedMotionProvider` 里：所有行共用一个系统 Reduce Motion 查询与监听（`client/reduce-motion.ts`），系统回答前按减少动态效果处理。
- 头部右侧的 “Open card” 小按钮，打开 Flowly 并定位到该卡概览（复用 Task chip 的 `openScreen("board", …)` 路径与校验）。
- schema 校验不通过时由 host 处理（不渲染）；渲染器不抛错。

### 5.4 Flowly 内 session 视图不显示（2026-10-20 用户决定）

最初设计让 Flowly 自己的 session 视图在相同位置显示同一条目。用户 2026-10-20 决定：**Flowly 内 session 下不加 Progress 卡片**。Flowly 内已有侧栏 Progress 区块（卡片级、含 History），session 对话里不再重复。因此：

- `shared/session-tail.ts` 的 `slimTimeline` 维持原样，把所有插件条目（包括 `flowly-summary`）精简为只剩 `{type:"plugin"}`，Flowly 的对话视图不显示它们。
- Summary 行只在 Paseo 原生 timeline 显示；侧栏 Progress 区块不变。

### 5.5 风险实测结果（2026-10-20）

用临时插件 `flowly-probe` 在 Tinylink 卡片 workspace 中各建一个 `claude/claude-haiku-5-5` 与 `codex/gpt-6-luna` session 实测；测试后两个 session 已硬删除、插件已移除、临时目录已删除。

| # | 风险 | 结果 |
| --- | --- | --- |
| 1 | 插件行是否进入 agent 上下文 | **不会**。行内暗号（PINEAPPLE-42 / MANGO-77）两个 agent 在下一轮都完全没看到。 |
| 2 | 追加是否触发 attention / 未读 | **不会**。先清除 attention 再追加，`requiresAttention` 仍为 false，`attentionReason` 为 null；只有 `updatedAt` 更新。推送通知无法直接观测，但它依赖 attention，判断不会触发。 |
| 3 | 插件 daemon 侧 SDK 能否读到插件行 | **能**。`timeline.refetch` 的 `projected` 与 `canonical` 都返回该行（含 `id`、`kind`、`pluginId`、`data`），所以 `sessions.tail` 本可以带出它（§5.4 后来决定不在 Flowly 内显示）。 |
| 4 | Claude / Codex 是否都接受追加 | **都接受**，返回 `{seq, epoch}`。 |
| 5 | session 进程重载后是否保留 | **不保留**。`paseo agent reload` 之后，timeline 从 provider 历史重建，之前追加的行消失，之后追加的行正常。即除 daemon 重启外，session 重载（以及任何从 provider 历史重建 timeline 的情况）也会丢掉旧的 summary 行；仍按用户“尽力显示”的决定处理，不补回。 |
| 6 | summarizer 是否会把自己的输出再总结 | `agent.turn_ended` 钩子的 `timeline` **会包含**插件行（实测出现 `plugin:probe`）。`turnText` 只取 user/assistant/tool/error，忽略 `plugin`，所以不会；加单元测试锁定。 |

## 6. Next moves：原生 timeline 卡片（2026-10-20 修订）

最初设计是 composer 上的 **Next** chip + 弹层。用户参考 [prompt-suggestions](https://github.com/961853266hyt/paseo-plugins/tree/HEAD/plugins%2Fprompt-suggestions) 插件后决定（2026-10-20）：Next moves 改为原生 timeline 里、agent 最后一条回复下方的卡片；**移除 Next chip**；点建议的行为可配置，默认**预填 Paseo 输入框**，可改为**复制**；Ideas 保留为 chip（§7）。

### 6.1 何时写入与撤下（daemon，`server/next-move-rows.ts`）

- **回合结束**（看板管理 session 的 `agent.turn_ended`，`outcome=completed`）：该 session 有当前建议（`openNextMoves`，去掉卡片已 Done/Cancelled 时的动作建议后非空）时，追加一行 `kind: "flowly-next-moves"`、`version: 1`、`id: "flowly-next-moves-<eventId>"`，`data = { status: "ready", taskId, workspaceId, eventId, moves }`。在回合结束而不是在 agent 记录建议时写入，是为了让卡片排在 agent 最后一条回复之后。显式“没有下一步”（空列表）不写。
- **下一轮开始**（该 session 的 `agent.turn_started`）：把该 session 上一张卡片以同一 id 改写为 `{ status: "past", eventId, moves }`（Paseo 按 id 原位替换）：建议仍然显示，但胶囊禁用、不再强调第一条、没有 ×。2026-10-21 用户决定：宿主给每个插件行套一个带 16px 下边距的外层容器，行无法删除，渲染为空（旧做法 `{ status: "dismissed" }`）也会留下这 16px 空白，插件 API 去不掉，所以改为保留上一轮的建议但不可点。daemon 重启前已写成 `dismissed` 的行仍渲染为空。
- 写入在后台进行（10 s 超时），失败只记日志，不影响 Flowly 的事件与状态。与 Progress 行相同：行只在 daemon 内存，daemon 重启或 session 重载后消失（§5.5）。插件 reload 后不记得上一张卡片的 id，旧卡片由客户端的当前性检查隐藏（§6.2）。

### 6.2 显示条件（客户端）

`status: "past"` 的行显示冻结的建议（禁用），除非用户已在本机关闭这一组（`movesHidden`），此时渲染为空。其余行卡片只在以下都成立时显示，否则渲染为空：行 `status: "ready"`；该行的 `eventId` 等于 chip 刷新为该 session 算出的当前建议（`chipMoves`：session 空闲、没有待答问题、用户之后没有发过消息、本机没有关闭这一组）。非看板管理 session 没有卡片。Flowly 自己的 session 视图不显示插件行（§5.4），Flowly 内建议行不变。

### 6.3 外观

```
  Agent: …typecheck 与测试都通过了。
  ✦ Progress                                                ← 小标题在卡外
 ┌──────────────────────────────────────────────────────┐
 │ 实现完成，等待验证                                     │
 │ ⌄ Show more      Updated 1m ago · Haiku 5.5 [Open card] │
 └──────────────────────────────────────────────────────┘
  ✦ Suggested next steps                                 ×  ← 同样的小标题，× 在标题行右端
  [ Verify with Luna ] [ Commit and push ] [✓ Move to Done]   ← 建议胶囊直接放在标题下，没有卡片底
```

Next steps 没有边框、底色和内边距：小标题（与 Progress 的小标题相同）下面直接是建议胶囊（2026-10-21 用户决定，去掉灰色卡片底）。Move to Done 之后的收尾询问同样直接放在小标题下。胶囊样式与 Flowly 内建议行一致（第一条强调；动作建议带 `Check` 与成功色边框）；手机上换行而不是横向滚动。

### 6.4 交互

- **消息型建议**，按设置 `nextMoveTap`（host 设置 `native-session`，默认 `fill`）：
  - `fill`（默认）：把 `prompt` 填进**这个 session 的** Paseo 输入框；输入框已有文字时在其后空一行追加（与 Flowly 的 `nextMoveDraft` 相同），光标移到末尾并聚焦。**不发送**，由用户在 Paseo 里发送。仅 web 与桌面可用（`client/web-composer.ts`，见 AGENTS.md 例外）；找不到该 session 的输入框（iOS/Android app、Paseo 改了输入框结构）时退回 `copy`。（退回复制是设计者的决定。）
    - 认定归属（2026-10-22 修正）：只看屏幕上的输入框（不在 `aria-hidden` 子树、有布局）；fiber 的两份副本里**任一**沿 `return` 链找到的 `agentId` 等于本 session 即算属于它。DOM 节点保存的是创建时的 fiber，React 每次更新在两份副本间切换，所以任一副本都可能停在旧的 props 上：在新 session 草稿里创建的输入框会一直带着草稿 id，直到刷新页面。原先“两份副本不一致就不认”的规则因此在长时间不刷新的桌面 app 里一直退回复制。仍有两个可见输入框属于同一 session（分屏）时不猜，退回复制。
  - `copy`：复制 `prompt`，toast “Copied. Paste it into the message box.”。
  - 卡片保留到下一轮开始或用户关闭。
- **Move to Done**：同前（重新校验建议仍当前、卡片未完成 → 移到 Done；未开 *Auto wrap up* 且有东西可收尾时在卡片内询问 Wrap up / Open in Flowly / Not now，有阻塞或警告时只给 Open in Flowly）。
- **×**：本机隐藏这一组（`client/hidden-moves.ts`），不影响 Flowly 内建议行。
- 设置位置：Flowly 设置 → AI features → “Paseo's session view”，选项 “Fill the message box”/“Copy”。这是 Flowly 内唯一新增的界面（用户要求可配置）。同一组里还有 *Start progress rows collapsed* 开关（§5.3）。

## 7. Ideas chip

### 7.1 显示条件

在看板管理的 session 上，当本卡有 `open` idea（IDEAS-SPEC §2.1）时显示；为 0 时移除。同一卡的多个管理 session 各自显示，数量相同。

### 7.2 外观

图标 `Lightbulb`，标签 “Ideas · 3”，title “Ideas for this card”，id `flowly-ideas`。

### 7.3 弹层

- 列出本卡 open ideas（新→旧），每条：标题、`AiMark`、scope 提示（“Continue here” / “New card”，按 agent 建议），点开看 detail 与 rationale。
- 每条三个操作：
  - **Continue here**：发往**当前这个 session**，原样复用 `ideas.adopt`（IDEAS-SPEC §6.2：daemon 生成指令文字、走发送队列、记录 `idea_adopted`、发送失败回滚）。与 Flowly 内一致，**不提供编辑**；按钮旁说明“Sends this idea to this session.”，点后需在弹层内再确认一次。（设计者的决定：保持 RPC 契约不变。）
  - **New card**：打开 Flowly，进入该 idea 预填的新建卡表单（与侧栏 Create task 同一表单）。新增 board screen 参数 `{ ideaId, requestId }`，按 SESSION-CHIP-SPEC 的方式一次性消费、严格校验，idea 不存在或不再 open 时报错，不替换成别的卡。
  - **Dismiss**：`ideas.update` 置为 dismissed（可在 Flowly 内 Restore）。
- 卡片在 Done/Cancelled 或已归档时，与 IDEAS-INBOX-SPEC 一致只提供 New card 与 Dismiss。
- 弹层任何时候只有一层在滚（2026-10-26）：宽屏锚定弹层里标题行固定在顶部，只有下面的 ideas 列表滚动；Flowly 内容的总高度不超过 host 弹层的可滚高度（`min(440, 窗口高 − 16)` 减去 host 上下共 32 的内边距：menu page 各 4、插件内容各 12），所以 host 外层从不溢出。手机底部 sheet（`layout.compact`）由 sheet 整体滚动，Flowly 不再嵌套 `ScrollView`。两层同时可滚会抢鼠标滚轮：内层到底后外层才动，看起来像滚不动或乱跳。
- 弹层只有 host 一层（2026-10-28）：底色、外框和内边距都由 host 画，Flowly 的内容不再自带底色和内边距（否则宽屏看得出“外框里再套一个框”）。标题行（`AiMark` + 标题）只在宽屏弹层出现；手机 sheet 的头部已经显示按钮标题，Flowly 不再重复。

## 8. 注册、数据与性能

- Ideas chip 与 Next moves 卡片的当前性由 `client/session-link.ts` 现有的客户端级刷新统一计算（同一 5 s etag 轮询，不新增轮询或订阅）：看板 `board.read-changed` 已含 `events` 与 `ideas`；管理 session 名单、Ideas 开关、Auto wrap up 与 `nextMoveTap` 取 `sessions.native-chips`，看板变化时或至多每分钟重读。卡片在回合结束后至多一个刷新周期内出现。
- session 运行状态、待答问题用刷新中已有的 live agent 列表判断。
- chip 只在标签、可见性或内容签名变化时 `update`，避免在用户打字时重渲染 host 输入区。
- 弹层与卡片用最新一次刷新的数据渲染；执行操作前重新读取并校验（建议仍有效、idea 仍 open、session 仍属于该卡），失效时提示并刷新，不执行。
- 回调不得捕获 `for` 循环变量（Hermes），chip 按钮在独立函数中构造（同 `chipButton`）。
- 清理：插件卸载或 session 不再满足条件时移除全部自有 chip；卸载后迟到的读取或操作结果不注册、不导航。
- timeline 渲染器 bundle 小、无网络；不引入新依赖。

### 8.1 手机上的 Next moves 卡片延迟（2026-10-21 性能修订）

用户反馈：手机上 Progress 卡片很快，Next moves 卡片要等很久。原因（实测，本机 1251 个 agent 的 host）：Progress 行自带全部数据，一到就渲染；Next moves 卡片要等客户端 chip 刷新算出“当前建议”，而旧的一轮刷新是 **board 读取 → 全量列出 live agent（233 KB）→ 全量扫描含归档的所有 agent（3.1 MB，其中 386 个是 summarizer 残留）→ native-chips → 才算 Next/Ideas 状态**。每次 board 变化都触发一次 3 MB 扫描，而回合开始/结束、建议事件都是 board 变化；手机在 JS 线程上解码每个字节。再叠加最长 5 s 的轮询间隔，以及 daemon 侧卡片写入排在设置读取、模型查询（最长 2 s）和 board 写入之后。修订：

- **先算后扫**：一轮刷新先读 board（etag/增量）、必要时读 native-chips 与 insights，立刻算出 Next/Ideas 状态并同步 chip；归档扫描移到这一轮**之后**在后台进行，从不阻塞，也不再因 board 变化而触发，只在“有 chip 的 session 离开了 live 列表”或每分钟一次时进行（取代 SESSION-CHIP-SPEC 2026-10-18 的“board 变化时重扫”；已缓存的归档 session 仍会随 board 变化更新标题，只有“新归档的 session”最多晚一分钟拿到 chip）。归档缓存只保存 `{id, workspaceId}`。
- **live 列表走推送**：与看板相同，用 agent 流（`agents.subscribe`）维护 live agent，开流后再完整列一次，之后每分钟对账；无流时（旧 host）退回每轮列出。
- **推送触发刷新**：session 的状态、`lastUserMessageAt`、待答权限、attention 或 workspace 变化（`relevantChange`，标题、用量等不算）在约 150 ms 内触发一轮刷新（合并），所以回合结束（running → idle）后卡片几乎立刻就绪，不再等下一个 5 s 周期。
- **行到即拉**：Next moves 行先于状态到达客户端时，渲染器请求一轮刷新（每行一次，`requestRowRefresh`）。
- **daemon 侧**：管理 session 的卡片写入提前到 `turn_ended` 钩子最前面（建议事件已在 board 中，不依赖后面的设置读取、模型查询与 board 写入）。
- **不做无谓的重渲染**：每轮重算的 chip 状态内容未变时不通知订阅者。
- 开发者计时日志增加 `chips.round`、`chips.archived`。

## 9. 文案、引导与文档

- 所有界面文字 `t()`/`tn()`，新文案加入全部语言目录。
- 不加 Flowly 内的一次性提示，欢迎页文案不变（用户决定本功能不改 Flowly 内部的行为与样式；AGENTS.md “Onboarding upkeep” 允许在交付说明中说明不加）。最初设计的 `native-session` 提示已移除。
- README Highlights 补一句（文档，不是 Flowly 界面）。
- SPEC-OUTLINE 与 PROGRESS 记录本功能。

## 10. 验收

单元（focused）：

- summary 追加：新版本追加、`update=false`/失败不追加、新一轮已开始时跳过、归档 session 跳过、追加失败不影响写入；data 与版本字段一致。
- Next moves 卡片：回合结束写 ready 行（空列表、非 completed、卡片已完成只剩动作建议时不写）、下一轮开始改写为 past（保留建议、禁用）、插件内存中的行 id 与建议按 session 记录；当前性规则（`chipMoves`）；预填拼接与退回复制。
- Ideas chip：计数、Ideas 开关、只对管理 session 注册、绑定变化时移除重建、卸载后不再注册；不再注册 Next chip。
- 新 board 参数 `ideaId` 的校验与一次性消费。

人工 / Luna（全权限 `codex/gpt-6-luna` 测试 session，按 AGENTS.md 规则在 Tinylink 或临时 fixture 上进行并清理）：

- 管理 session 结束一轮后，原生 timeline 出现 Progress 条目，展开收起正常；Flowly 内同一 session 的对话里**不**出现（§5.4）。
- 回合结束后原生 timeline 在最后一条回复下出现 Next moves 卡片；默认点建议把文字填进该 session 的 Paseo 输入框（已有文字时追加）、不发送；设置改为 Copy 后点建议复制；下一轮开始后卡片消失；× 只隐藏卡片，Flowly 内建议行不受影响；composer 上没有 Next chip。
- Move to Done 建议：移动、收尾询问、各分支行为。
- Ideas chip：Continue here、New card（打开预填表单）、Dismiss，Flowly 内状态同步。
- 非管理 session 不出现两个新 chip，Task chip 照旧。
- 桌面宽屏与手机紧凑布局都可用（含弹层中的输入框与键盘）。
- 在真实实现上复核 §5.5 的 #1、#2（summary 行不进入 agent 上下文、不触发 attention）。

## 11. 留给实现者的选择

- 渲染组件、弹层组件的拆分与文件名。
- chip 标签在不同语言下的具体缩写。
- 若 host 的 popover 在手机上放不下输入框，可改为弹层内“Edit”跳到一个 Flowly 屏幕完成编辑；需在本 spec 记录。

## 12. 非 Flowly 管理的 session（P2–P4，2026-10-21）

用户 2026-10-21 要求：所有非 Flowly 管理的 session 也直接获得 Progress 与 Next moves，**不纳入任何 project 管理**；Ideas 也按 session 支持（在当前 session 继续、开新 session、开新 workspace），但不进入任何 project 的 Ideas。用户决定：用 **Paseo 子 session** 生成（与卡片 summary 相同的机制）；**默认关闭**；Progress / Next steps / Ideas **三项分别可开关**（与 paseo-recap 重复时可只关 Progress）。本节以新 commit 交付，不改动前面 P1 的 commit。

### 12.1 范围

- “外部 session”：未被 Flowly 管理（不在 `sessions.managed` 里）、未归档、有 workspace、不是子 agent（`parentAgentId` 为空）、不是 Flowly 自己的辅助 session（summarizer，按 `flowly=summarizer` 标签判断；memory review、digest、workflow insights 都带这个标签。2026-10-23 前代码漏了这条判断，会给这些用完即删的 session 跑洞察，留下报错记录）的 session。包括：卡片 workspace 里未加入卡片的 session（P2）、Flowly 项目里不属于卡片的 session（P3）、不在任何 Flowly 项目里的 session（P4）。
- 管理 session 维持 §5–§7 的卡片路径，不变。
- Flowly 内部的行为与样式不变（§3），唯一新增是设置项（§12.6）。

### 12.2 生成（daemon，`server/session-insights.ts`）

- 触发：外部 session 的 `agent.turn_ended`，`outcome=completed`，且设置总开关开、三项中至少一项开。回合文本同 TASK-SUMMARY-SPEC §2（`turnText`，忽略插件行），为空则跳过。
- 单飞与合并：每个 session 同时最多一个生成；运行中又结束的回合合并为下一次（同卡片 summary）。
- 运行：在该 session 的 workspace 里创建它的**子 session**（`parent` = 该 session），模型 = Summary model 设置（Auto 同卡片），标题 `Flowly insights · <session 标题>`，标签 `{flowly: "summarizer", "flowly-session": <agentId>}`，`outputSchema`，`waitForFinish(120 s)`，`finally` 中**硬删除**（`server/summarizer-remove.ts`，本地 `DaemonClient.deleteAgent`，用户 2026-10-22 批准，见 AGENTS.md 例外；只删本次刚创建的 id）；删除失败则回退归档并记日志。运行的几十秒内子 session 仍短暂可见，结束后列表与归档都不留痕。
- 一次调用同时产出三项（关掉的项不在提示里要求、输出被忽略）：
  - `update/state/target/recap/next`：同卡片 summary，但以 session 标题与工作目录代替卡片标题/描述/泳道；上一版作为输入。
  - `moves`：0–3 条“用户最可能发的下一条消息”（`label` ≤60 字、`prompt` ≤2000 字，与对话同语言）；没有明确下一步时为空。外部 session 没有 Move to Done。
  - `ideas`：0–2 条与当前目标**不同**、值得单独做的后续工作（`title/detail/rationale/scope`），已开放的 idea 标题作为输入以免重复；本 session 已有 5 条 open idea 时不再要求。
- 失败（模型不可用、超时、权限、输出不合 schema）只记到该 session 的 `error` 并记日志，不重试。

### 12.3 数据（`session-insights.json`，与 `board.json` 同目录）

串行写、备份、原子替换；无效内容保留文件并报错，不重置。

```
{ version: 1,
  sessions: [{ agentId, workspaceId, title, updatedAt,
               summary: { id, at, model, state, target, recap, next } | null,
               suggestion: { id, at, moves: [{label, prompt}], current: boolean } | null,
               ideas: [{ id, title, detail, rationale, scope, status: "open" | "dismissed" | "adopted",
                         adopted?: { target: "here" | "session" | "workspace", agentId?, workspaceId? },
                         createdAt, updatedAt }],
               error: { at, message } | null }] }
```

- 每个 session 最多 20 条 idea（超出删最早的非 open）、最多 5 条 open；最多保存 300 个 session，超出删最久未更新的。
- `suggestion.current` 在该 session 下一轮开始时置为 false。

### 12.4 原生 timeline 行

- Progress：`flowly-summary` 行（§5.2），`taskId`/`workspaceId` 变为可选；外部 session 的行不带 `taskId`，卡片上不显示 “Open card”。追加规则同 §5.1（新一轮已开始或已归档则跳过）。
- Next moves：`flowly-next-moves` 行（§6.1），`taskId`/`workspaceId` 可选，`eventId` 为 `suggestion.id`；回合结束写 ready、下一轮开始原位改写 past（同一 `NextMoveRows`；`dismissed` 仅是旧行的形态）。
- 客户端当前性：行的 `eventId` 等于该 session 最新且 `current` 的 suggestion，且 session 空闲、无待答问题、用户之后没发过消息、本机未关闭这一组（与 `chipMoves` 相同的规则）。点建议的行为同 §6.4（默认填入，可设为复制）。

### 12.5 Ideas chip（外部 session）

- 有 open idea 时显示 `Ideas · N` chip（与 §7 同 id、同外观）；弹层列出该 session 的 open ideas（标题、scope 提示，点开看 detail/rationale）。
- 操作（重新读取并校验 idea 仍 open 后执行，执行后立即刷新 chip）：
  - **Continue here**：确认后把 idea 指令发到当前 session（与 `ideas.adopt` 相同的指令文字），记为 adopted(here)。
  - **New session**：在同一 workspace 新建 session（与当前 session 同 provider/model），首条消息为 idea 指令，记为 adopted(session)。
  - **New workspace**：从当前 session 的 workspace 目录 branch-off 一个 worktree workspace（与卡片新建 worktree 相同的方式），在其中新建 session 并发送 idea 指令，记为 adopted(workspace)。目录不是 git 仓库时报错并提示用 New session。
  - **Dismiss**。
- 不出现在任何 project 的 Ideas 页；没有 “Start a new task”。

### 12.6 设置

> 2026-10-22 用户决定（ONBOARDING-SETUP-SPEC D2/D3）：改为“默认开”，但由欢迎导览写入：新用户首次导览以任何方式关闭时，按导览里三个 “Also in sessions outside Flowly” 开关（默认全开）写入 `outside` 与三项；schema 默认值仍为 `outside=false`，所以没完成导览的已安装用户保持关。导览写入时总是同时写四个字段（`outside` = 三项任一为开），避免开一项时把只因总开关关着而“看起来关”的其他项一并打开。

host 设置 `native-session` 增加字段（默认值保证旧存储可读）：`outside`（默认 **false**）、`outsideProgress` / `outsideNextMoves` / `outsideIdeas`（默认 true，仅在 `outside` 开时生效）。Flowly 设置 → AI features → “Paseo's session view” 新增总开关与三个子开关，并说明：开启后，每个外部 session 每完成一轮会用 Summary 模型跑一次（读取最近对话，发送给该模型的 provider），并留下一个已归档的子 session。

### 12.7 客户端注册与性能

- `sessions.native-chips` 增加 `outside` 设置；开启时，chip 刷新每轮用 etag 读 `sessions.insights`（未变时极小），只取有 live 外部 session 的数据：每个 session 的当前 suggestion 与 open ideas。关闭时不读。
- 外部 session 的 Next moves 当前性与 Ideas chip 都在同一刷新里计算，不新增轮询或订阅。

### 12.8 验收

- 单元：外部 session 判定（管理 / 子 agent / summarizer / 无 workspace / 归档）、设置门控（总开关、三项）、单飞合并、输出解析（moves/ideas 上限与容错）、存储上限、suggestion 在下一轮失效、行追加与跳过、idea 操作三种目标与重新校验、chip 当前性。
- Luna 6（全权限）：开启设置后，一个普通（非 Flowly）session 完成一轮 → 原生 timeline 出现 Progress 与 Next moves 卡片、Ideas chip（若有 idea）；三项开关分别生效；Continue here / New session / New workspace / Dismiss；关闭总开关后不再生成；管理 session 行为不变；测试结束恢复设置为原值并清理全部 fixture。

## 管理绑定的清理

`sessions.managed` 与 `sessions.native-chips` 只列出卡片仍存在的绑定。删除卡片或项目后，插件会删除对应的 `sessions/<agentId>.json`（即工具凭据），插件启动时也会清一次旧的孤儿绑定（看板没有任何卡片时跳过，不信任空看板）。已归档 session 的绑定保留：卡片重开时 wrap-up 归档的 session 会被恢复，需要原绑定；数量受现存卡片限制，不会无限增长。无法解析的文件原样保留。
