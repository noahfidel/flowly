# Attention 暂不处理（Dismiss）

状态：用户 2026-10-19 批准，已实现。卡片任务 `626d9a6d`。

## 1. 问题与目标

Needs attention 把“等你回答的问题、待批准的权限、出错的 session、有未读结果的 session”统一计数，显示在看板铃铛、侧边栏 Flowly 行角标、总览栏 chip 和项目 tab 的红点上。有些项用户暂时判断不了、拿不定主意，或者打算晚点再看，但只要它没解决，数字就一直挂着，让人焦虑，也让真正新来的事情淹没在旧数字里。

目标：用户可以把某张卡片当前的 attention **暂不处理（Dismiss）**，让它退出所有计数和 Attention 列表；卡片本身的信号保持可见，随时可恢复；之后**一旦有新情况**（新的问题、新的批准请求、新的错误、又一轮新结果），这张卡自动回到 Attention。

不做的事（与“处理”区分开）：

- Dismiss **不是** Mark as read：不写已读回执，不清除 Paseo 原生 attention，session 的 Unread 标记照旧。
- Dismiss **不回答**问题、**不批准/拒绝**权限、**不解决**错误。等待批准的 agent 仍然停着等。
- 不改卡片业务状态、task revision 或 Activity；agent 看不到、也不受影响（agent 工具和 skill 不变）。

## 2. 粒度与“新情况”的判定

### 2.1 以卡片为单位

Attention 列表一行一张卡，Dismiss 也按卡片：隐藏这张卡**当前**的全部 attention 信号。不做按 session 或按信号类型的 dismiss（列表里看不到那么细，粒度太细反而增加决策负担）。

### 2.2 信号身份（signal key）

`attentionItems` 为每张卡算出参与计数的 session 信号。新增纯函数 `attentionSignals(...)`，给每个信号一个稳定的身份字符串，代表“这一次具体的事”，而不是“这个 session”：

| 信号 | key | 何时变成新的 |
| --- | --- | --- |
| Kanban 提问（`kind=question`） | `q:<eventId>` | agent 再次提问（新事件） |
| 权限请求 / AskUserQuestion | `p:<agentId>:<requestId>`（每个 pending request 一条；无 id 时用 `attentionTimestamp`） | 新的请求 |
| 错误 | `e:<agentId>:<attentionTimestamp 或 "status">` | 新的错误时间戳 |
| 未读结果 | `u:<nativeAttentionToken>`；手动未读为 `u:<agentId>:manual`；无 token 时 `u:<agentId>:<lastUserMessageAt>` | 又一轮结束（新 attention 时间戳） |

### 2.3 规则

- Dismiss 时记录该卡当前信号 key 的集合。
- 之后每次计算：卡片的当前信号 **全部** 包含在已记录集合内 → 视为已 dismiss，不计数、不进主列表；**出现任何一个新 key** → 卡片回到 Attention（整行恢复，显示全部当前信号）。dismiss 记录在用户下一次 dismiss 时被覆盖，或在恢复时删除。
- 信号自然消失（问题被回答、权限被处理、session 被读）不影响规则：剩余信号仍是旧集合的子集，卡片继续隐藏；全部消失时卡片本来就不在 Attention 里。
- 读状态不可用（`readUnavailable`）时未读信号本来就不参与计数，规则不变。

不采用定时 snooze（“1 小时后提醒”）：用户的诉求是“暂时不想管”，而不是“到点再来烦我”；以“有新情况才回来”作为唯一触发更不焦虑，也不需要后台计时。若之后需要定时，可作为扩展（见 §8）。

## 3. 界面

### 3.1 Attention 列表（左侧停靠栏的 Attention 标签页）

- Ruling (Noah, 2026-11-09)：桌面不再有铃铛下拉。铃铛打开左侧停靠栏（DISPATCHER-SPEC §9.3）的 **Attention** 标签页（手机为全屏页的同名标签页），再按一次回到之前的标签页或最小化状态。该标签页按 ask 列出 **Needs you**（每个 open ask 可就地回答、Dismiss、Open card，DISPATCHER-SPEC §9.4），其下是不计入铃铛计数的 **Updates**（DISPATCHER-SPEC §9.2）。看板没有停靠栏时（既非项目看板也非 All projects），铃铛仍打开下文的 Needs attention 弹层（按卡片列出，规则如下）。

- Ruling (Noah, 2026-11-09)：Attention 标签页和 Needs attention 弹层都不再有 **Dismissed · N** 分组和 Restore 列表。Dismiss 只是暂不处理：卡片离开 Needs you，出现新信号时按 §2.3 自动回来；服务端与 dismiss RPC 不变。卡片自身的菜单和侧栏仍可 **Restore to Attention**（§3.3）。下面两条中关于 Dismissed 分组的部分已作废。
- 每行右侧新增 **Dismiss** 图标按钮（`BellOff`，无障碍标签 `Dismiss {title} from Attention`），放在行的可点区域之外，常显（桌面与触控一致，便于发现）。点行本身仍是打开卡片。
- Dismiss 后行用现有的列表移除动画淡出，原生 toast：`Dismissed. It comes back when something new happens.`。宿主 toast 不支持操作按钮（插件内无先例），撤销通过卡片菜单或侧栏的 Restore 完成。
- 全部卡片都被 dismiss 时，主区空状态显示 `Nothing new needs your attention.`。

### 3.2 计数入口

以下全部只算未 dismiss 的卡片，口径仍由同一个 `attentionFromSources` 产出：

- 看板铃铛角标、侧边栏 Flowly 行角标（`SIDEBAR-BADGE-SPEC`）；
- 总览栏 “waiting on you / unread / errors” chip；
- 项目 tab 的 needs-you 指示与 `needs-you` / `agent-question` 提示触发条件。

### 3.3 卡片与侧栏（“仍然可以在任务卡片中看到”）

- 卡片保留原有的全部信号（Needs you、批准、错误、未读计数），文字和图标不变。
- 额外在 attention 信号之后显示一个小 `BellOff` 标记（文字 `Dismissed`，卡片无障碍标签含 `Dismissed from Attention`），表示“这张卡的提醒已被你暂时收起”，避免用户以为提醒丢了。卡片本身没有 attention 专属强调色，其余样式不变。
- 侧栏（drawer）内容区顶部在 dismissed 时显示 `Dismissed from Attention. It comes back when something new happens.` 和 **Restore** 按钮；侧栏的卡片操作菜单、看板卡片右键/长按菜单和手机 Actions 弹层在卡片有 attention 时提供 **Dismiss from Attention** 或 **Restore to Attention**（与列表同一动作）。
- session 卡片、session 预览、Mark as read 行为不变。

## 4. 数据

存在 `board.json` 新字段 `attentionDismissals`（参照 Ideas：同文件、随现有 etag 看板读取到达客户端，看板和侧边栏角标都不新增轮询或 RPC 读取）。旧文件没有该字段时读作 `[]`；看板版本仍为 v4，不迁移。

```
attentionDismissals: [{
  taskId,            // 每卡至多一条
  signals: string[], // 1..100 个 key，每个 ≤600 字符，去重
  dismissedAt,       // ISO 时间
}]
```

- 全局上限 10,000 条；超限返回错误，不淘汰旧记录。
- 卡片永久删除、项目 Remove 时随卡片删除（与 Ideas 同路径；备份照旧）。卡片归档/收尾时保留（卡片恢复后仍有效）。
- 不改 board / task / project revision，不写 Activity 事件；但更新看板 etag，使其他客户端（手机、侧边栏）在下次读取时同步。

## 5. RPC

- `attention.dismiss` `{ taskId, signals }`：串行写入内；校验卡片存在、卡片与项目未归档、`signals` 非空且合法；替换该卡已有记录。相同集合重复提交幂等（保留原 `dismissedAt`）。服务端不核对信号是否仍为当前（这是纯显示偏好，客户端集合即真相；过期集合只会让卡片更早回来）。
- `attention.restore` `{ taskId }`：删除该卡记录；没有记录时幂等成功（卡片不存在时报 `Task not found.`）。
- 错误：卡片/项目不存在或已归档、输入非法、容量超限、已保存数据非法（保留原文件）。daemon 错误保持英文。

## 6. 实现结构

- `shared/attention-dismiss.ts`：schema、`attentionSignals` 与 `isDismissed(signals, record)` 纯函数。
- `client/attention.ts`：`attentionItems` 增加 `signals` 和 `dismissed` 字段；`attentionFromSources` 接收 `dismissals`，主列表与计数排除 dismissed，另返回 dismissed 列表。看板与侧边栏共用。
- `server/service.ts` + `shared/rpc.ts` + `index.server.ts`：两个 RPC，沿用看板串行写和原子替换。
- `client/board.tsx`：列表按钮、toast；`card.tsx` / `drawer.tsx`：标记与 Dismiss/Restore 动作。
- i18n：新字符串加入全部 catalog。
- Onboarding：新提示 `attention-dismiss`，在 Attention（全部项目）有 ≥3 张未 dismiss 的卡、且还没有任何 dismissed 卡时出现，优先级紧跟 `needs-you`：`Not ready to decide? Dismiss a card from Attention. It comes back when something new happens.`；`ONBOARDING-SPEC` 提示表与 `onboarding-logic.test.ts` 同步。欢迎页特色列表不改（不是主流程能力）。

## 7. 验收

- 纯函数：各类信号 key 稳定；子集 → dismissed；新 key（新问题 / 新请求 / 新错误 / 新一轮未读 / 手动未读）→ 回到 Attention；信号减少仍隐藏；`readUnavailable` 下规则正确；看板与侧边栏计数来自同一函数且排除 dismissed。
- 服务端：dismiss / restore 幂等；归档卡、未知卡、非法输入、容量上限报错；不改 revision 与 Activity；删卡/移除项目时一并删除；缺字段的旧 `board.json` 读作空。
- `npm run typecheck`、`npm test` 通过。
- UI（安装 reload 后在非全屏窗口）：列表 Dismiss → 计数立即减少、toast 出现；卡片菜单与侧栏可 Restore；卡片与侧栏仍显示信号和 Dismissed 标记；新的一轮结果让卡片回到列表；手机弹层同样可用。无法安全绑定窗口时记 UNRUN。

## 7a. 按 ask 计数与单条 dismiss（2026-11-08，单窗格计划 Q1、Q5）

本节修改上文 §2.1、§2.2、§3.2、§5；其余规则不变。

- **Blocker 进入 Attention（Q5）**：session 最新的 Kanban 报告是 `blocker` 且之后没有新的一轮开始时，记为信号 `b:<eventId>`，和提问一样直到该 session 的下一轮开始才消失。列表行详情显示 `{n} blocker(s)`，行的圆点与提问同色。
- **一个信号就是一个 ask**：`asksFrom(board, agents, receipts, dismissals)`（`shared/attention.ts`）把每个信号变成一个 ask，状态为 `open`，或该信号在这张卡的 dismissal 集合里时为 `dismissed`。铃铛角标、侧边栏角标（`attention.count`）都改为统计 **open 的 ask 数**，不再统计卡片数；Dispatcher 聊天里的 ask 来自同一个函数（DISPATCHER-SPEC §9.4）。列表仍按卡片分组，每卡一行。
- **单条 dismiss**：`asks.dismiss { signal }` 只把这一个 key 加入该卡已有的 dismissal 集合（没有记录时新建），已有的 key 全部保留；超过 100 个时先丢掉已不再是当前信号的最旧 key，仍超限则报错。卡片级 Dismiss（`attention.dismiss`）照旧用该卡当前全部信号替换集合，所以聊天里这张卡的全部 ask 也变成 dismissed。
- **计数口径**：卡片的当前信号全部在集合里时整行隐藏（规则同 §2.3）；有新 key 时整行回来、显示全部当前信号，但计数只算不在集合里的那些 ask。
- 存储格式不变：旧的 `attentionDismissals` 记录照常读取；旧集合里没有 `b:` key，所以已 dismiss 的卡若有未解决的 blocker 会回到 Attention 一次。

## 8. 可能的扩展（不在本次范围）

- 定时 snooze（1 小时 / 明天上午），到点后即使没有新情况也回到 Attention。
- 按信号类型的全局静音（例如“未读结果不计入角标，只计问题和批准”），作为设置项。
