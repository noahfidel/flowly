# Paseo Kanban Plugin：Spec 大纲与路线图

2026-11-08 Dispatcher agent (implemented; chat panel and asks added): one Flowly-owned session for all projects in a never-archived `background: true` workspace on `<Paseo home>/flowly-dispatcher/dispatcher`, outside the plugin data folder, started by `dispatcher.start` with a charter and a board summary; a sealed `dispatcher` credential gives it only cross-project card tools (list projects, list/get/create/update/start cards, project ideas, link cards), refusing archived projects and unavailable roots; card stops reach it as batched notes held until its turn ends and dropped while it is down. A chat panel next to the board (full-screen page on phones, toolbar Dispatcher button) shows its transcript with the notes it received as card rows, a collapsed "cards changed since you looked" line with Mark seen and What should I do?, Start dispatcher, and a composer that steers a running turn. Asks (§9.4) come from the same source as the bell (`asksFrom`): agent questions, permissions (including delivery mode's `git push` / `gh pr create`), question and blocker reports, errors and unread turns, each answered (`asks.answer`, after re-checking the request is still pending in that card's session; never auto-allowed), dismissed one at a time (`asks.dismiss`) or, when the session ended, started again (`tasks.start-again`); a bell row jumps to its ask in the open chat. [spec](DISPATCHER-SPEC.md).
2026-11-08 Event bus and dispatcher notes (implemented, no user-visible change yet): board commits and agent permission requests become typed facts on a daemon-side bus; `isStop` marks the moments a dispatcher should hear about, and `NoteBatcher` batches them into one note per card (10 s window, 60 s cap, the dispatcher's own events dropped). [spec](EVENT-BUS-SPEC.md).
2026-11-08 Start a card from a tool (implemented): `flowly_start_card` starts a card's session (labelled `flowly-task` and `flowly-started-by`, New task model defaults) in its worktree; a session-less directory card Flowly created moves to a new worktree first (Linear branch name when the card has a Linear input) and its empty directory workspace is archived; other directory cards refuse with `NEEDS_WORKTREE`. `flowly_create_card` gains `workspace: "worktree"`; both share the 20-per-hour limit. Amends AGENT-CARDS D1/D3. [spec](START-CARD-SPEC.md).
2026-11-08 Delivery mode (implemented): a per-card choice, default from Settings > Workflow > Delivery mode, of "Branch, I bless" (commit only), "Draft PR" or "Ready PR", editable in Edit until the card is in review, committed or integrated; the card session's context carries one delivery line and `get_task` returns `deliveryMode`. The session still asks the user for `git push` / `gh pr create`; Flowly never pushes. [spec](DELIVERY-MODE-SPEC.md).
2026-11-08 Extra artifact folders (implemented): Settings > AI features > Artifacts lists folders outside a card's directories whose files agents and people may attach; they join each card's allowed roots, the realpath guard is unchanged, and `/`, the home directory, empty and relative entries are ignored. [spec](CARD-ARTIFACTS-SPEC.md) (2026-11-08 增量).
2026-11-08 Markdown export (implemented): Settings > Storage > Export as Markdown copies the live projects' open cards, open ideas (re-importable through the backlog parser) and active memory to the clipboard; RPC `board.export-markdown`. [spec](IDEAS-IMPORT-EXPORT-SPEC.md) §7.
2026-11-08 Ideas import (implemented): paste a markdown backlog on the Ideas page, review the rows (`[x]` and already-open ones start unchecked), import the checked ones as project ideas with the `(added …)` note kept as `source`; titles cut at 120 characters on a word with the full line in the detail; RPCs `ideas.import-preview` and `ideas.import` (replay by `operationId`). The overview's Ideas count now includes project ideas (`projectIdeas`). Export is written with Task 3. [spec](IDEAS-IMPORT-EXPORT-SPEC.md).
2026-11-08 Project-level ideas (implemented): an idea can belong to a project instead of a card (no `taskId`): agents in sessions outside cards propose them with `flowly_propose_idea` on the board credential, the user with the `ideas.create-project` RPC; no open cap, unique open title per project (`DUPLICATE_IDEA`), no board event; New card accepts one with `origin { ideaId }` and no derived link; the Ideas page shows a Project group and no Continue in card. Amends IDEAS-SPEC §1. [spec](PROJECT-IDEAS-SPEC.md).

2026-11-05 PR review cards (implemented): a new agent labelled `pr-review-watch=<owner>/<repo>#<n>` gets a card in its own existing workspace (In review, tag `pr-review`), in the project whose repository holds that workspace; no backfill (agents over 30 minutes old are skipped), one card per agent, never moved automatically, no Linear ticket asked. Settings → Workflow → *Make cards for PR review agents*, on by default. [spec](PR-REVIEW-CARDS-SPEC.md).

2026-11-05 All projects board (implemented): a first **All** tab (phone: *All projects* at the top of the switcher) shows every live project's cards on one board, columns being the built-in statuses enabled in any project with their default names. Cards show their project; every card action uses the card's own project. Dragging between columns changes status (refused where the card's project has no such lane); reordering within a column is off (Manual groups by project). New task opens Quick task in the last quick-task project. Settings → Workflow → *Show All projects tab*, on by default. [spec](ALL-PROJECTS-SPEC.md).

2026-11-05 Linear ticket per card (implemented): project setting **Make sure there's a Linear ticket** (off by default) with an optional **Linear team**. When on and the card has no Linear item linked, the card's session context asks the agent to search Linear with its own tools, create a ticket if none fits, link it with `flowly_add_artifact` and name it in its first report; without Linear tools it says so and carries on. Flowly itself still never writes to Linear. [spec](LINEAR-TICKET-SPEC.md).

2026-11-05 Quick task (implemented): New task and **Q** open a one-box dialog: type what you want done, Enter creates the card with a provisional title and starts its agent (new worktree by default) with the text as the first message; small pickers change project, agent and workspace in place, More options… opens the full form prefilled. The summary model then names the card (title only) in the project's background workspace, never overwriting a user edit. Command Center **Flowly: Quick task**; Settings → Workflow → Quick task. [spec](QUICK-TASK-SPEC.md).

2026-10-29 Switch local and worktree (implemented): a local card moves to its own worktree with every uncommitted change of the main checkout copied in and a handoff (handover list, old transcripts); its session trims the worktree, *Release from main* removes exactly that diff from the main checkout (checked, backup, undo), and `flowly_integrate` lands the branch into the still-dirty main checkout before the agent sets Integrated. *Switch to local* goes back. New agent tools `flowly_handover`, `flowly_integrate`. [spec](WORKSPACE-SWITCH-SPEC.md).

2026-10-29 Workspace 类型标记（已实现）：看板卡片元信息行最前面显示卡片工作位置——Paseo worktree 显示 `GitBranch` + Worktree，其余类型（local_checkout、checkout、directory）显示 `Folder` + Local；来源是 Paseo 实时 workspace 列表（`resources.list` 新增 `kind`），workspace 不可用时不显示。设置 → Cards 新增可隐藏的 Workspace 字段，默认显示。卡片侧栏的状态/优先级/类型一行最前面也显示同一标记（只读，不受该开关影响）。[spec §8](CARD-DISPLAY-SPEC.md#8-workspace-kind)、[DRAWER-SPEC](DRAWER-SPEC.md#workspace-kind)。

2026-10-29 Agent card tools (implemented): `flowly_list_cards`, `flowly_get_card`, `flowly_create_card`, `flowly_update_card`. Agents create or edit cards only when the user asks; a new card gets its own directory workspace in Backlog/Todo and no session, from a card session it follows up that card. Edits cover any live card of the project (title, description, priority, type, tags, Backlog↔Todo) under the card's revision. Card sessions get them on their MCP server and CLI; other sessions in a Flowly project's workspaces get a `flowly-board` MCP server from `agent.session_open` on hosts that accept `mcpServers` (Paseo 0.14). Settings → AI features → Cards switch, on by default. Amends IDEAS-SPEC §1. [spec](AGENT-CARDS-SPEC.md).

2026-10-29 Committed stage (implemented): new built-in status `committed` right after In review, meaning all of the card's changes are committed (pushed or not is in the note). People move cards there like any lane; agents set it with `flowly_update_status(committed)` / CLI `status committed` after committing on the user's request. It is a delivery like In review (outputs, Move to Done, soft workpad/setup gate, reminders). A new message resumes the card in Development; A1r restores Committed. Stored 9-lane configurations get it after In review, enabled, when read; no board version bump. [spec](COMMITTED-STAGE-SPEC.md).

2026-10-29 打开 workspace（已实现）：看板卡片右上角 `…` 下方新增 ↗ 按钮（与 `…` 同尺寸、同显示规则），用宿主 `navigation.openWorkspace` 打开该卡在 Paseo 中的 workspace；仅在宿主支持且 workspace 可用时显示，卡片右键菜单与 `…` 操作表同样新增 Open workspace。卡片侧栏标题栏铅笔（Edit）左侧同样新增该按钮（用户 2026-10-29 决定，取代 2026-10-14 的“侧栏不提供 Open workspace”）；[DRAWER-SPEC](DRAWER-SPEC.md#open-workspace)。[spec §7](CARD-DISPLAY-SPEC.md#7-open-workspace-button)。

2026-10-29 Integrated stage (implemented): new built-in status `integrated` right after Committed. The agent sets it once all of the card's commits are in the local main branch of the main checkout (no remote push required, no daemon git check). It is a delivery status like Committed; stored lanes get it through `completeLanes`; A1/A1r treat it like Committed. [spec](INTEGRATED-STAGE-SPEC.md).

2026-10-29 Agent 速度（已实现）：New session 与 New task → Start an agent now 的 agent 选择新增 Speed 行，仅在所选模型提供速度时显示（Paseo provider feature：Codex `service_tier` 选择、Claude `fast_mode` 开关），创建时以 `featureValues` 传入；默认正常速度不传值；沿用同 provider 最近会话的速度。[spec](AGENT-SPEED-SPEC.md)。

2026-10-27 搜索（已实现）：daemon 内存扫描卡片、最新摘要、agent 笔记、workpad、ideas、交付物和项目记忆；`search.query` RPC + 看板 Search 页（默认当前项目，可切全部）；agent 工具 `flowly_search`（本项目、不含自己的卡和记忆）。FTS5 留第二期。[SEARCH-SPEC](SEARCH-SPEC.md)。

2026-10-26 匿名使用数据（已实现，待随 1.7.0 发布）：daemon 每天最多向 PostHog Cloud US 发一条 `flowly_heartbeat`（不用 SDK），字段按白名单：版本、平台、界面实际语言（`ui_locale`，替代 GeoIP）、功能开关、窗口内计数、模型计数表；数量分桶，不发任何内容、路径或 ID。默认开启，Settings → General 与导览最后一页可关闭；`DO_NOT_TRACK` / `FLOWLY_TELEMETRY=0` 强制关闭；告知前也发送，关闭后不再发送。[spec](TELEMETRY-SPEC.md)。

2026-10-26 加载优化 R2（已实现，PR #67）：所有布局都读总览加单卡详情，客户端不再读完整看板；表单、连接编辑器、Next moves 和 Ideas 的动作只读自己的卡或项目；不留切回开关。[LOADING-R2-SPEC](LOADING-R2-SPEC.md)。

2026-10-26 看板数据迁入 SQLite（最小方案）：board.json 首次启动自动迁入 `flowly.sqlite`（源快照、逐值核对、单次 rename、退休标记），失败继续用 JSON；BoardStore 业务逻辑不变，按行增量单事务写入；每日备份 7 份、从备份恢复（revision 偏移）、导出回 v5 JSON 后可装回旧版；Settings → Storage。附属文件与读取行为不变，加载优化另做。取代 10-25 的完整设计与 D1–D4。[spec](SQLITE-STORAGE-SPEC.md)。

2026-10-25 Insights 第三版（已实现，待验收）：页面改为 GitHub 式的一年活跃度热力图（每天的 agent 轮次，主题绿色深浅，不显示总数和连续天数），点某一天看当天的轮次、完成的卡和 AI 总结（过去的日子选中时生成，每个项目同时一份，保留 400 天）。Skills 成为主要能力：和 Workflow insights 合成一次运行（默认开启，首次定时运行等满一个周期），从卡片总结、workpad、项目记忆的线索、确认的记忆、命令记录和已有 skill 中提炼完整的 SKILL.md 草稿，点“加入项目”写入 `.agents/skills/<name>/` 并在 `.claude/skills/` 建软链接，不提交；Flowly 加入的 skill 可收到更新（diff）。其它建议与最近 7 天工作流数字默认收起；介入次数、时间去向、按周表格去掉；Agent habits 移到开发者设置。先于 SQLite R1 合入，R1 需补上 §7.1 的字段与写方法。[spec](INSIGHTS-REDESIGN-SPEC.md)。
2026-10-22 Insights 重设计第二版（已被第三版取代，未合入）：Insights 不再统计产量，改为评估工作流本身，按周看、只和自己的过去比：每张完成卡需要的介入（消息、权限请求、移卡）、审阅来回轮数与一次通过率、时间去向（agent 在做 / 等待审阅或回复 / 空闲）、每卡 token 与 agent 时长、按模型对比、8 周趋势表（标注 Workflow insights 建议落地的周）。风险规则只保留 R2/R3/R6。新记录 `turn_ended.byUser` 与 `permission_requested.tool`。单列、主题色、不用图表。第一版（产量统计与柱图）已撤回。[spec](INSIGHTS-REDESIGN-SPEC.md)。
2026-10-23 后台 workspace：memory review、Insights digest、workflow insights 改在每个项目专用的「Flowly background」workspace 里运行，用前恢复已归档的那个复用、没有才新建，用完归档；修复 single-root 下按目录匹配“项目根 workspace”会选中某张卡的 workspace、review tab 留在卡片里的问题。[spec](BACKGROUND-WORKSPACE-SPEC.md)。

2026-10-23 Summary 模型列表：用户可添加多个模型、上移/下移设置回退优先级、移除或恢复默认 Haiku→Luna；兼容旧 Auto/单模型设置，同步所有使用 summary 设置的入口。[spec](SUMMARY-MODELS-SPEC.md)。

2026-10-22 约束 benchmark（grader + B01 quick 实现）：按 Fable 审查与主会话复核收敛为独立 grader + B01 quick（三回合文件/验证/PR，两模型）。明确主动/最终评分、预期拒绝与同输入机械 stale、事实前置条件、服务端回执/产物/nextMoves 证据、共享 Git 管理区的归属与清理；保留现行 test 阶段要求。B02–B04、compare 和自动续跑后置，不加 hooks。[spec](CONSTRAINT-BENCHMARK-SPEC.md)。

2026-10-22 回合清单与统计校准：最小版建议 1+3，共用六项动作清单生成 skill 和 get_task.turnChecklist；旧会话读卡即可取得最新规则。审计脚本改为回合时间窗口、成功回执与实际 output 匹配、确认重试分类和显式样本分组；不加 hooks。[spec](TURN-CHECKLIST-SPEC.md)。

2026-10-22 交付约束（已实现，Sonnet/GPT 真实验证通过；4 个本地测试分支待权限清理）：交付与结果调用支持 `outputs`（文件/PR/MR）原子登记，省略提醒、`[]` 显式无产物；`acknowledgeOpen` 先拒后放，绑定 session 与当前 card/workpad/HEAD，回合切换和服务重载后重新拒绝。MCP、CLI、skill 同步。[spec](DELIVERY-CONSTRAINTS-SPEC.md)。

2026-10-22 项目记忆（已实现，待验收）：人确认后生效的跨卡记忆（决策、约定、坑、联系人），存在 daemon 的 `memory.json`。来源有两个：agent 用 `flowly_remember` 提候选，卡片 Done 时复盘提炼（默认开）。新 session 的初始指令里按相关度注入（8 条 / 2400 字），`flowly_recall` 按需查询。与 AGENTS.md 分工：每个任务都要遵守的规则放 AGENTS.md，只和部分任务有关或不适合进仓库的知识放记忆；常用条目可以晋升为 pinned 或转进 AGENTS.md，active 条目从不自动淘汰。[PROJECT-MEMORY-SPEC](PROJECT-MEMORY-SPEC.md)。
2026-10-21 卡片开工设置（已实现）：近期违规集中在无描述小卡 + Sonnet medium/auto，原因是 skill 里 type/tags/workpad 靠后且时机含糊、缺项静默、反馈只在收尾、无 workpad 反而不被拦。现在 `flowly_get_task` 带 `setup`，首条任务上下文写明缺项，所有写入结果带设置提醒，交付缺项返回 `SETUP_INCOMPLETE`（含无 workpad，推翻 WORKPAD-SPEC §5.3 旧决定，`acknowledgeOpen` 放行），skill 以“Start of every turn”清单开头。[CARD-SETUP-SPEC](CARD-SETUP-SPEC.md)。
2026-10-20 侧栏 session 区优化（已实现，待手机验证；用户决定 1、2 按推荐，3 直接上 FlatList）：① 历史只显示 35 条 tail 中的最后 18 条，长 turn 被工具调用挤满——改为打开即加载当前 turn（上限 300 条，daemon 用 SDK 的 `before` 游标一次分页完成）并提供 Load earlier；② 手机键盘弹起时 transcript 只在动画结束后加 padding、且只有贴底时才滚动——改为在键盘开始事件时按位移量原生滚动（底部锚定）；③ 手机滚动卡顿——增量刷新（`after` 游标）、transcript 独立组件、手机改用与 Paseo 原生一致的倒置虚拟化 FlatList（web 仍为普通滚动）；倒置列表与输入框用同一个原生驱动位移，键盘弹起时内容同步上移。[设计 spec](SESSION-PANE-SPEC.md)。

2026-10-21 AI 输出语言（已实现，Run now 已验证）：设置 → AI 功能 → **AI output language**（host 级，默认“与界面语言相同”，可单独指定十种语言之一）。daemon 解析出一种语言，并在每个 AI prompt 里写同一句“Write every title and text in X, whatever language the material is in”，替换原先各 prompt 里“按卡片/对话语言”的猜测：卡片摘要、每日摘要、session insights、Workflow insights；agent 写的 next moves 与 ideas 通过 `flowly_get_task.outputLanguage` 和 skill 指定语言。界面语言为 `auto` 时由客户端把设备语言写入 host 设置 `device-language`（最后打开的设备为准），daemon 无法得知时退回宿主机语言，再退回英文；不按卡片标题多数语言猜（正是出错的做法）。新增一次性提示 `ai-language`。[spec](AI-LANGUAGE-SPEC.md)。
2026-10-21 原生 session pane P2–P4（已实现，待 Luna 验证）：不受 Flowly 管理的 session（卡片 workspace 里未加入的、项目里无卡的、Flowly 之外的）也能获得 Progress 行、Next moves 卡片与 Ideas chip，不纳入任何 project。每完成一轮用一个随即归档的子 session 生成（同卡片 summary 机制），按 session 存在 `session-insights.json`；Ideas 可在当前 session 继续、开新 session 或从当前仓库 branch-off 新 worktree workspace，不进入任何项目 Ideas 页。默认关闭，设置 → AI features → Paseo's session view 有总开关与 Progress / Next steps / Ideas 三个开关。[spec §12](NATIVE-SESSION-SPEC.md)。
2026-10-20 原生 session pane（P1，已实现，待验证）：Flowly 管理的 session 在 Paseo 原生 session 视图里也能用三项特色功能。Summary 新版本由 daemon 追加为原生 timeline 的 `flowly-summary` 插件行（尽力显示：daemon 重启或 session 重载后消失），只在原生 timeline 显示（用户决定 Flowly 内 session 下不加 Progress 卡片）；Next moves 参考 prompt-suggestions 改为 agent 最后一条回复下的 timeline 卡片（回合结束写入、下一轮开始原位撤下；点建议默认填入该 session 的 Paseo 输入框（web/桌面，DOM 例外），可在设置改为复制；Move to Done 后询问收尾），输入框旁只保留 **Ideas** chip（Continue here / Start a new task / Dismiss），复用现有 5 s etag 轮询。非管理 session 没有卡片与 chip。本功能不改 Flowly 内部的行为与样式（无 Flowly 内提示、欢迎页不变）。P2–P4（未加入卡片的 session、无卡 session、Flowly 之外的 session）仅作评估。[spec](NATIVE-SESSION-SPEC.md)。
2026-10-20 更多 connector（已实现，Luna 验收通过，待真实令牌联调）：在 Jira 只读输入的基础上做成通用 connector 框架，接入 Confluence 页面（自建/Cloud）、GitHub issue/PR（含 Enterprise）、GitLab issue/MR（含自建）。卡片 Artifacts 只有一个 **+**，菜单收拢“文件或链接”和每个已连接的服务；New task 的 From Jira 变为每个服务一个 From 按钮；GitHub/GitLab 搜索默认限定项目自己的仓库（git remote）。仍然单向只读，PR/MR 只给文件名不给 diff。按用户决定改用通用名：artifact `external`（看板 v5）、`flowly_read_external`（`flowly_read_ticket` 为别名）、RPC `connectors.*`。[设计 spec](CONNECTORS-SPEC.md)。
2026-10-20 下一步建议随交付调用提交（已实现，桌面真实会话已验证）：`flowly_update_status` / `flowly_report_progress` 增加可选 `nextMoves`（与 `flowly_suggest_next_moves` 同一组 0–3 条；没传不记录，`[]` 为显式“本轮没有要用户做的事”并在活动里显示一行），与状态变更或汇报在同一事务里写成第二条 `next_moves_suggested`，一份回执；`moveTo:"done"` 只随交付到 In review 被接受；CLI `status` / `note` 增加 `--moves` / `--no-moves`；独立工具保留给一轮中途的更新。交付时提醒（遗漏时在工具结果里提示）是另一张卡，见 §9。[spec](NEXT-MOVES-SPEC.md) §8。
2026-10-20 Agent 使用习惯（已实现，待验收）：Insights 页新增 **Agent habits** 区块，按天（最近 7 天）、按模型统计 agent 的交付（in_review 交付 + result，question 单列）里带 next moves 的比例、每次交付的 ideas、显式“没有下一步”（`nextMoves: []`）的次数，以及用户采纳建议的比例；某模型或 session 在 ≥10 次交付里 0 次 next moves（或 0 个 ideas）时标出。纯规则统计，读 flow log，不调用模型、不受 Workflow insights 开关控制；`agent.turn_ended` 事件新增 `model` 与 `pick`，在钩子里写入。[设计 spec §12](WORKFLOW-INSIGHTS-SPEC.md)。
2026-10-19 Attention 暂不处理（已实现）：Attention 列表、卡片菜单和侧栏可按卡片 Dismiss，退出铃铛、侧边栏角标、总览 chip 与 tab 计数；记录当时的信号 key（问题事件、权限请求、错误、未读轮次），出现任何新 key 即自动回来；卡片和侧栏仍显示信号并加 Dismissed 标记，列表底部 Dismissed 分组可 Restore。不是已读、不回答/批准、不改 revision 或 Activity；存 `board.json` 的 `attentionDismissals`。新提示 `attention-dismiss`。2026-11-08（§7a）：未解决的 blocker 报告也是信号（`b:`）；铃铛、侧栏角标按未处理的 ask（各卡片未 dismiss 的信号）计数，与调度聊天同源（`asksFrom`）；聊天里可单条 dismiss（`asks.dismiss`，保留已有 key）。[spec](ATTENTION-DISMISS-SPEC.md)。
2026-10-19 内置工具与 skill 命名：MCP 服务/config key 为 `flowly`，11 个工具统一 `flowly_*`，skill 为 `skills/flowly`，CLI 为 `flowly.mjs`，新环境变量统一 `FLOWLY_*`；仅保留历史数据与既有会话所需的私有兼容入口。[spec](FLOWLY-NAMING-SPEC.md)。
2026-10-19 Workflow insights（已实现，待验收）：Insights 的可选扩展，默认关闭。开关打开后，daemon 在每轮结束时记录 shell 命令（先规范化、脱敏，再写入 `commands/<projectId>.jsonl`，保留 30 天），并按用户设置的周期（每天 / 3 天 / 每周 / 两周、整点、模型，Auto 为 Sonnet）调用 LLM 分析最近 ≥7 天的命令。结论可以是 paseo.json 脚本、worktree setup、仓库工具、AGENTS.md 条目或 skill，显示在 Insights 页，点 Create card 落地；新增活动太少时跳过，不消耗 token；session 上下文列出项目已有的 paseo.json scripts。[设计 spec](WORKFLOW-INSIGHTS-SPEC.md)。
2026-10-19 卡片显示（已实现）：卡片改为四层——标题上方一行淡色元信息（优先级/类型/工单/标签，去掉 pill 和标签框）、标题、单行活动（默认“摘要，否则输出”）、状态信号行；新增 设置 → Cards 页（host 级 `cardActivity` / `cardHidden`，带实时预览与恢复默认），Sort 菜单末尾“Card display…”直达；需要用户处理的信号始终显示。新提示 `card-display`。[spec](CARD-DISPLAY-SPEC.md)。
2026-10-19 卡片 Workpad（已实现）：agent 用 `flowly_update_workpad`（CLI `workpad`）整体替换卡片的验收标准、验证项（pass/fail/unrun + 运行时 commit）和困惑点，workpad 有独立 revision（人勾选不改 task revision）；Plan 取自 agent 原生 todo；daemon 用 git 记录环境戳并判断验证是否过期；agent 交付 In review 时有未完成项返回 `WORKPAD_OPEN`，需 `acknowledgeOpen` 确认，卡片标“Delivered with N open items”。卡面 Checks n/m，抽屉 Workpad 段可勾选。新提示 `first-workpad`。[spec](WORKPAD-SPEC.md)。
2026-10-19 AI 标记（已实现）：AI 写的或建议的内容统一用 `Sparkles` 星星标记（共享 `AiMark`）：卡片进度行、侧栏 Progress 与 Ideas、Ideas 页、Insights 每日摘要、agent 添加的产物和标签，与下一步建议一致；卡片类型 feature 改用 `Puzzle`。[spec](AI-MARK-SPEC.md)。
2026-10-19 下一步建议（已实现）：agent 在一轮结束时用 `flowly_suggest_next_moves`（CLI `next-moves`）给出 1–3 条候选下一条消息（label + 完整 prompt），记为本会话事件 `next_moves_suggested`，不改 revision；Flowly 会话输入框上方显示本轮建议，点按只预填（已有文字则追加），不发送；用户下一条消息开始新一轮后失效，可 × 隐藏。活动时间线不显示，A1r 不把它当作工作汇报。新提示 `next-move` 与欢迎页特色条目。[spec](NEXT-MOVES-SPEC.md)。
2026-10-19 外部工单接入（Jira / Linear，已确认，P1 实现中）：用户决定工单系统**只作为输入和引用**，Flowly 从不写工单系统，工单状态也不驱动卡片。工单链接或 key 作为卡片的 input artifact，由 daemon 识别并读取（凭据只在 daemon）；agent 用新工具 `flowly_read_ticket` 读正文和评论，内容变化时标为 unread。New task → From Jira 列出我的最近工单，也可以按工单号或文字搜索，标题为空时预填；已有卡片可用 Link Jira ticket 关联。按需刷新，没有后台轮询。[设计 spec](EXTERNAL-TRACKER-SPEC.md)。
2026-10-18 卡片类型由 agent 补全（已实现）：`flowly_set_type` / CLI `set-type` 仅在卡片没有 type 时写入（+task revision，事件 `type_set`），已有 type 一律保留（`TYPE_ALREADY_SET`）。[spec](CARD-TYPE-SPEC.md)。
2026-10-18 卡片自定义标签（已实现）：与固定的 type 不同，标签是自由文本、按项目词表复用，标记功能模块与优化方向；agent 用 `flowly_set_tags` 给本卡打标签（只增看板 revision，不能删人打的标签），表单/卡片/侧栏显示，筛选与搜索支持 `#tag`，字段按将来的搜索设计。[增量 spec](CARD-TAGS-SPEC.md)和[验证](verification/card-tags.md)。
2026-10-16 新用户 onboarding（设计待评审，未实现）：首次打开时的四页欢迎引导（project / 卡片 / session 与 Paseo 的对应关系、基本流程、特色功能、开始使用），空状态增强，可重看入口，以及可选的一次性情境提示；仅新增 host 级 `onboarding` 设置，不改看板数据、RPC 或 agent 工具。[设计 spec](ONBOARDING-SPEC.md)。

2026-10-22 欢迎导览重设计：5 页，导览内完成语言、进展模型、外部 session 的进展/下一步/想法（首次导览关闭时写入，默认开）、项目记忆与 Insights 总开关（新 host 设置 `features`）；关闭后提示设置入口。[设计 spec](ONBOARDING-SETUP-SPEC.md)。
2026-10-22 更新后的 What's new：老用户每个有条目的版本弹一次（默认最新版本，可往回翻到 1.5.0，设置里可再次打开），新用户随首次导览记为已看。[设计 spec](WHATS-NEW-SPEC.md)。
2026-10-16 改名：展示名由 Ultra Kanban 改为 **Flowly**（不设中文名；定位为 agent 原生工作流，看板是界面）。插件 ID 同日改为 `flowly`（数据目录与设置由 `migrateLegacyPluginData` 复制迁移）；工具与 skill 命名由 2026-10-19 的 [Flowly 命名修订](FLOWLY-NAMING-SPEC.md)继续统一；历史验证证据中的旧名保持原样。

2026-10-16 默认模型：设置新增 Models 页（新会话默认模型、摘要模型），项目设置可单独指定默认模型并优先于全局；都未设置时沿用最近一个会话。设置界面同时重做为卡片式分组。[增量 spec](MODEL-DEFAULTS-SPEC.md)和[验证](verification/model-defaults.md)。

2026-10-16 设置菜单改为左右两列：左列按功能分为 General / Workflow / AI summaries / Ideas，右列显示所选分区的设置；窄屏改为顶部分区条。[增量 spec](SETTINGS-LAYOUT-SPEC.md)和[验证](verification/settings-layout.md)。

2026-10-16 界面多语言：UI 文案按设备语言（或设置中手选）显示，首批 zh-CN / zh-TW / ja / ko / es / fr / de / pt-BR / ru；英文原文即 key，缺译回退英文；agent 面向文本、daemon 错误与模型写的摘要不翻译。[增量 spec](I18N-SPEC.md)和[验证](verification/i18n.md)。

2026-10-15 Ideas 卡片：agent 用 `flowly_propose_idea` 把本卡范围外的后续工作作为 idea 挂到来源卡（理由、上下文、类型/优先级），看板卡片显示灯泡计数，侧栏 Ideas 区块可 Create task（打开预填 idea 内容与来源卡进展的新建表单，建卡时原子标记 accepted 并记录 `origin`，两卡互链）或 Dismiss/Restore；数据存 `board.json` 的 `ideas`，无需迁移。[增量 spec](IDEAS-SPEC.md)。

2026-10-16 项目 Ideas 页：总览栏 “Ideas N” chip（快捷键 B）打开与 Insights 对齐的整页，收拢本项目所有卡片的 ideas（Open/Accepted/Dismissed、搜索、排序、按卡分组、筛选）；idea 不随卡片 Done/收尾/归档改变，删卡或移除项目时删除；finished/归档卡上的 idea 只能新建卡片或忽略。[增量 spec](IDEAS-INBOX-SPEC.md)。
2026-10-15 app 性能优化：主因是手机 JS 线程被大体量轮询（relay 下 JS 解密）和无 memo 的整树重渲染占满。看板/summary/resources 改为 etag 读取（未变时 147 KB → 38 B），session 输出改用 daemon 精简 tail（68 KB → 9 KB），agent 列表改为 Paseo 订阅流（替代 5 s 全量轮询与侧栏每 3 s 扫描全部含归档 agent），卡片/侧栏/对话 memo 化，手机打开卡片不再卸载看板，运行脉冲改为原生循环；输入框原生自增高、发送即清空（失败恢复）、晚到的草稿恢复不再重挂载输入框。[增量 spec](PERFORMANCE-SPEC.md)和[验证](verification/performance.md)。
2026-10-15 彻底删除卡片：任意 lane 的卡片在看板菜单与详情菜单中可“Delete permanently…”，确认后从看板删除卡片及其活动、回执和进展 summary（先备份到 `removed/`）；删除时可选择同时归档其 session 与自有 workspace，设置“Auto archive on delete”在预检干净时不再询问；并清理了 Ultra Kanban 下 worktree 已被旧收尾删除、无法恢复的 11 张归档卡。[增量 spec](TASK-DELETE-SPEC.md)。
2026-10-15 任务类型：卡片可选 Feature / Bug fix / Research / Refactor / Docs / Chore 类型（可留空，旧卡无类型、无需迁移），在新建/编辑表单、卡片、侧栏、详情和筛选中显示；agent 会话上下文带上类型。[增量 spec](TASK-TYPE-SPEC.md)。
2026-10-15 移出 Done 时恢复 workspace 与 session：已收尾的卡片移出 Done/Cancelled 时，后台恢复收尾时归档的本卡 workspace（同一 ID，被删除的 worktree 在原分支上重建），并恢复该次收尾归档的 session。插件 SDK 暂无 restore，临时用本机凭据直连 daemon，SDK 支持后替换。[增量 spec](WORKSPACE-RESTORE-SPEC.md)和[验证](verification/workspace-restore.md)。
2026-10-15 工作流阶段拆分：In progress 拆为 Design → Development → Test，所有项目生效；看板数据升到 v4，进行中的卡片迁到 Development，泳道原位展开，历史保持原样并留 `board.pre-v4.json`；开工阶段由 agent 自行决定，从 In review 继续时进 Development、从 Blocked 继续时回到上一阶段；旧的 `in_progress` 工具调用作为别名兼容。[增量 spec](WORKFLOW-STAGES-SPEC.md)。
2026-10-15 卡片 token 用量：读取本机 Claude Code / Codex 会话日志，按输入、缓存读写、输出（含推理）统计卡片各 session 用量，summarizer 单独小计，不计金额；侧栏 Usage 与 Activity 默认收起。[增量 spec](USAGE-STATS-SPEC.md)。
2026-10-15 任务进展 summary：看板管理的 session 每轮完成后，daemon 用便宜模型（默认 Haiku 5.5，不可用时 GPT-6-Luna，可在设置中更改）开一个临时 session 更新卡片的 state / recap / next，保留每卡 50 个历史版本供 Done 后回查；不改卡片状态或 revision。[增量 spec](TASK-SUMMARY-SPEC.md)和[验证](verification/task-summary.md)。
2026-10-15 移除 project：统一的 Remove 入口（取代 Archive），确认时选择仅从看板移除，或同时从 Paseo 移除原生 project（Paseo 无 project 归档；其移除不删除磁盘上的目录、worktree 与分支，有运行中 session 时不可选）；看板记录先备份。[增量 spec](PROJECT-REMOVE-SPEC.md)和[验证](verification/project-remove.md)。
2026-10-15 桌面 project tab：看板顶栏以 tab 一键切换 project；回到 Ultra Kanban 时打开本次运行中最后查看的 project，冷启动打开第一个。[增量 spec](PROJECT-TABS-SPEC.md)和[验证](verification/project-tabs.md)。
2026-10-15 project 目录选择与多 repo：新建 project 时可在应用内浏览目录或打开 Paseo 所在电脑的 Finder/Explorer 选择；新增“Multiple repositories”来源，插件在固定目录下新建空目录，以软链接加入所选 repo/目录，并以该目录注册原生 Paseo project。[增量 spec](PROJECT-PICKER-SPEC.md)和[验证](verification/project-picker.md)。
2026-10-15 侧边栏入口待处理数：Ultra Kanban 侧边栏行显示与看板 Attention 同口径的数量角标（0 不显示），点角标直接打开 Needs attention；10 秒轮询。2026-10-22 起侧栏和 header 的 Attention 数字标记都使用 Paseo 当前主题强调色。[增量 spec](SIDEBAR-BADGE-SPEC.md)。
2026-10-15 卡片最近 agent 输出：卡片标题下单行显示所在 workspace 最近活跃 session 的最新 assistant 文本摘要与相对时间；仅可见卡片按 session updatedAt 限量 tail 拉取，并发 ≤3，异常时安静。[增量 spec](CARD-OUTPUT-SPEC.md)和[验证](verification/card-output.md)。
2026-10-15 F3 列内拖拽排序：桌面拖拽显示插入线，同列重排或跨列定点放置，经 `tasks.place` 单次 CAS 写入；手机仍用菜单。[增量 spec](DRAG-REORDER-SPEC.md)。
2026-10-15 手机/平板内联输入框：去掉点击后弹窗输入，原生端与 web 同样在 session 底部内联输入，按键盘实际遮挡高度上推；运行中显示发送方式选择。[增量 spec](SESSION-UX-SPEC.md#10-inline-native-composer--2026-10-15)。

2026-10-15 平板桌面布局：原生端（iOS/Android）不再一律使用紧凑布局；宿主未标记 compact 且看板宽度 ≥ 760 时使用桌面多列看板和侧栏，宽度未测得前保持紧凑以免手机闪烁。平板上的上下文菜单改为长按位置锚定的浮层；卡片 Actions 按钮和列折叠按钮在触控端常显（无 hover）；侧栏调宽把手触控端加宽到 16pt。卡片拖拽仍仅限鼠标（触控滑动保留给滚动），触控端通过长按菜单移动卡片；键盘快捷键仍仅 web。验收：geometry 单测、typecheck、全量测试；真机 iPad/Android 平板外观与手势未运行（UNRUN）。

2026-10-15 F4 桌面快捷键：插件 SDK 没有快捷键注册能力，也不能使用全局 DOM 监听，因此采用看板内快捷键（RN-Web `View` 的 `onKeyDown`，焦点在看板内时生效）和全局 Command Center 条目两条路径。[增量 spec](SHORTCUTS-SPEC.md)和[验证](verification/shortcuts.md)。

2026-10-14 v2 路线图（规划草案，未实施）：对标 Multica 的人机协作工作流——agent 自行切换阶段、需要人时在卡片提醒并进入 Review、人确认后自动收尾。[ROADMAP-V2](ROADMAP-V2.md)。

2026-10-14 手机卡片 Status 文案截断：紧凑布局改为完整状态按钮和按需打开的状态弹层，沿用 CAS/Toast；宽布局扩大原生 selector 的可用宽度。[增量 spec](DRAWER-SPEC.md)和[代码验收](verification/status-label.md)。

2026-10-14 手机 session 输入区压缩：输入与发送同排，运行模式一行展示，长文本有界展开，保留底部固定和发送保护。[完整增量约定](SESSION-UX-SPEC.md#9-compact-phone-composer--2026-10-14)。

2026-10-14 Android project chooser crash: host Modal content must carry the plugin theme provider at the modal-body boundary. The correction covers all seven plugin-owned modal bodies; scope and acceptance limits are in [UI/UX spec](UI-UX-SPEC.md) and [verification](verification/android-modal-theme.md).

2026-10-14 session 指示输入：桌面 Enter 发送、Shift+Enter 换行，IME/重复/过期输入事件保护；Kanban tools 补充用途说明。[完整 spec](SESSION-INPUT-SPEC.md)。

2026-10-14 侧栏重排：状态下拉与 Edit/Archive 同组，移除调宽按钮；metadata/workspace 合并为默认收起的详情区，移除 workspace 跳转。[完整 spec](DRAWER-SPEC.md)。

2026-10-14 看板反馈和动画：状态流转使用原生 toast、lane 文字禁止选中，侧栏/session/拖放采用统一可打断动画并支持减少动态效果。[完整 spec](MOTION-SPEC.md)。

2026-10-14 session 原生 chip：从 session 页跳回关联看板卡片，打开侧栏的同一 session 预览；Back 仍回卡片详情。[完整 spec](SESSION-CHIP-SPEC.md)。

2026-10-18 会话内回答提问：agent 的 AskUserQuestion 等提问与其它权限请求显示在 Flowly session 输入框上方，可直接作答/允许/拒绝，编码与 Paseo 原生一致。2026-10-20 skill 改为优先用自带提问工具提问，`kind=question` 作回退，同题不双问（§2.2）。[完整 spec](SESSION-QUESTION-SPEC.md)。

2026-10-14 卡片 session 状态：展示运行、回合结束、未读和待关注数量；原生已读状态优先，插件逐 session 标记当前轮已阅，业务状态保持独立。[完整 spec](SESSION-ATTENTION-SPEC.md)。

2026-10-14 session UI：原生 Agent pane 嵌入能力验证不支持；采用创建弹层、侧栏 session 卡片与独立预览，提供返回和原生跳转。后续修订补充消息格式适配、底部固定输入区与运行中的 follow tail。[完整 spec](SESSION-UX-SPEC.md)。

2026-10-14 UI/UX 改版：压缩项目管理区、桌面整卡鼠标拖拽状态与卡片文本禁止选中、可调侧栏、手机纵向列表与状态切换。完整增量约定见 [UI/UX spec](UI-UX-SPEC.md)。

2026-10-13 后续决策：新的看板 project 只使用一个原生 Paseo project root；多 repo 由用户放到共同父目录，通过原生 project 管理。下文早期多 repo/卡片 repo 选择方案已由 [single-root amendment](SINGLE-ROOT-SPEC.md) 取代，仅作历史规划记录。

状态：初版计划已确认；本文作为后续具体设计的范围基线。  
2026-10-13 修订：任务卡片默认不指定 repo，工作范围为项目全部 repo；可显式选择一个或多个 repo。workspace 启动/来源 repo 与任务范围分别管理。可关联项目 repo 中的已有 Paseo workspace，包括归属其他原生 project 的 workspace，保留原归属。第一阶段实现和 Luna 验证完成后暂停，交由用户验收再决定第二阶段。
调研日期：2026-10-13。  
本文记录初版约定、可行性依据、spec 章节大纲与实施路线图。后续扩展单独评估。

## 1. 初步结论

**Paseo 的现有 plugin API 足以支撑核心目标：在 Paseo 内显示看板，将任务关联到 workspace 和 agent session，并在 daemon 上运行自动流转逻辑。** 看板任务、执行记录、依赖和流转规则需要由插件维护。这个结论来自官方文档及源码对照，实际运行验证放在后续原型阶段。

本机 CLI 与正在运行的 daemon 均为 `0.11.2`；已对照该版本的 release 源码确认页面、面板、导航、SDK 和生命周期 hook。具体设计时再确定插件的最低兼容版本及客户端兼容范围。依据：[Plugin reference](https://paseo.sh/docs/plugins/reference)、[0.11.2 plugin 合约](https://github.com/getpaseo/paseo/tree/75953250959979b8f088bbca8dbd6ee61d0151b1/packages/plugin/src)。

首版聚焦：**项目内管理一个或多个 repo + 一卡一 workspace + workspace 内多个 agent session + agent 看板 tool 与 skill + 卡片右侧栏查看状态和发送后续指示**。自动领取任务、跨阶段交接和自动拆解项目列入后续候选范围。

### 用户指定的首版范围

| 能力 | 首版要求与边界 |
| --- | --- |
| 项目与 repo | 一个看板 project 对应一个 Paseo project；看板项目管理一个或多个 repo/dir；插件可创建或关联对应的 Paseo project |
| 卡片与 workspace | 一个卡片对应一个 workspace；可关联项目 repo 内已有 workspace 并保留原归属，也可新建到对应 Paseo project；任务范围默认所有 repo，也可指定一个或多个，与 workspace 启动目录分别管理 |
| 卡片内多个 session | 卡片展示其 workspace 下的多个 agent session，用户可创建或选择 session 工作；首版由用户分别指示各 session |
| 看板 tool + skill | tool 提供真实的任务查询和状态更新，skill 指导 agent 何时及如何调用；需要覆盖插件新建及用户关联的已有 session |
| 卡片右侧栏 | 展示该卡片唯一 workspace 及其各个 session 的状态，允许选择目标 session 并直接发送后续指示；侧栏由插件绘制 |

项目、卡片与执行资源的对应关系约定为：

| 关系 | 初版约定 |
| --- | --- |
| 看板 project ↔ Paseo project | 一对一 |
| 看板 project → repo/dir | 一个或多个，目录列表由插件维护 |
| 看板 project → 卡片 | 多张卡片 |
| 卡片 ↔ workspace | 一对一 |
| workspace → agent session | 零个或多个；多个 session 均在该 workspace 中工作 |

Paseo 原生 project 保留一个 `rootPath`，插件保存项目的多个 repo/dir。创建 workspace 时显式指定同一个 Paseo project ID 和选中的目录；新建 workspace 因而归属该项目；关联 repo 内已有 workspace 时保留其原生 project 归属。源码支持目录 workspace 挂载到指定 project。创建 worktree 时也需要明确源 repo，单独传 project ID 会使用其主目录。依据：[0.11.2 workspace 归属逻辑](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.ts#L218)、[源目录解析](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/packages/server/src/server/workspace-source.ts)。

一个 workspace 有自己的执行目录。项目包含多个 repo，并不自动让每张卡片的 workspace 同时包含所有 repo 的 checkout；单卡涉及跨 repo 工作时的目录访问方式在具体设计中说明，并保持一卡一 workspace 的约定。

初版支持多个 session 在同一卡片内工作；多 agent 自动交接、角色编排、评审/返工链和自动派工列入后续范围。卡片业务状态通过看板 tool 更新，各 session 的执行状态分别显示。

tool 接入需区分：新建 session 可通过创建配置注入 MCP；已有运行中的 session 不能假定支持 MCP 热插入，首版可提供 CLI 工具入口供已有 shell 工具调用。skill 的分发与发现方式在具体设计中确定。依据：[MCP 注入与 before hook 边界](https://paseo.sh/docs/plugins/reference#before-hooks)。

右侧栏的状态读取和后续消息由 SDK 支撑；当前公开 plugin UI 合约未提供可直接嵌入的完整原生聊天组件。首版包含自绘状态、必要的执行输出和指示输入；完整聊天历史、附件等体验另行取舍。运行中发送遵循 Paseo/provider 的插话或中断能力。依据：[Agent SDK](https://paseo.sh/docs/sdk/agents)、[0.11.2 plugin UI 合约](https://github.com/getpaseo/paseo/tree/75953250959979b8f088bbca8dbd6ee61d0151b1/packages/plugin/src/client)。

## 2. Paseo 能力与边界

| 需求 | 已有能力 | 插件承担的部分 |
| --- | --- | --- |
| 看板入口 | 独立 screen、侧栏入口、workspace/agent panel | 卡片、任务详情、筛选、排序、列与交互 |
| 创建和选择项目 | CLI 可注册原生 project，SDK 可列出 project、workspace、agent 并订阅更新 | 看板 project 与原生 project 的一对一关系、repo/dir 列表与卡片关联 |
| 打开关联资源 | `navigation.openWorkspace`、`openAgent` | 从卡片跳转及资源不可用时的展示 |
| 创建执行环境 | 创建普通 workspace 或 git worktree workspace | 复用还是新建、任务与环境如何对应 |
| 启动或继续执行 | 在 workspace 中创建 agent，向已有 agent 发送后续 prompt | 卡片内 session 列表、任务上下文、目标 session 选择和执行记录 |
| 跟踪执行状态 | turn 开始/结束、权限请求/响应、agent/workspace 归档等 hook | 解释事件如何影响任务，处理暂停、失败和恢复 |
| 后台状态观察 | 服务端 plugin 随 daemon 运行；客户端关闭时 hook 仍运行 | 观察各 session 状态、保存卡片流转记录及恢复后核对 |
| 数据持久化 | host 级 settings；服务端可使用 Node、文件与依赖 | 任务及运行历史的持久化与迁移，形式待设计 |
| agent 更新任务 | 创建配置可注入 prompt、MCP；session 打开时可注入环境变量 | 看板 tool + skill，供各 session 读取卡片、更新业务状态和汇报结果 |

SDK 操作依据：[SDK reference](https://paseo.sh/docs/sdk/reference)、[Agents](https://paseo.sh/docs/sdk/agents)、[Workspaces](https://paseo.sh/docs/sdk/workspaces)。
原生 project 注册依据：[Paseo CLI projects](https://paseo.sh/docs/cli#projects)。

需要进入后续 spec 的边界：

- 生命周期 hook 为实时、尽力交付：没有事件重放、持久化或自动重试，不同事件可能并发。因此可靠自动流转需要持久化执行记录，并在插件恢复时核对 Paseo 当前状态；无法核实的结果需要保留待确认状态。
- 一次 turn 正常结束只证明该次执行结束。多个 session 的运行状态分别展示；任务完成、验收通过和项目完成需要各自定义判据。
- plugin UI 使用 React Native；桌面拖拽、窄屏和手机交互需要分别确认，Multica 的网页拖拽组件不能直接当作 Paseo 的通用组件使用。
- 插件安装和 settings 按 daemon 隔离。跨 host 展示已有 SDK 能力；客户端跨 host 调用与 daemon 后台跨 host 调度需要分别设计。

hook 交付边界依据：[0.11.2 生命周期文档](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#context-and-cleanup)。

## 3. Multica 如何工作，哪些值得参考

本次查看的是官方仓库 `multica-ai/multica`，源码快照为 `b115ec80f1748d8d2766481706b0ecb830389286`（2026-10-12）。

| 环节 | Multica 的实现 | 对本插件的启发 |
| --- | --- | --- |
| 工作记录 | Issue 长期保存目标、讨论、负责人和任务状态；一次执行有独立 Run 记录 | 任务可以跨 session 存续，每次执行保留历史 |
| 工作入口 | 分配 agent、评论提及、聊天、自动化等入口生成 Run；Backlog 可暂存工作 | 任务入板、关联 session、开始执行应是可区分的操作 |
| 执行 | 服务端入队，runtime 领取并调用 agent CLI；记录 session、目录、分支与结果 | 使用 Paseo 的 workspace/session 执行能力，插件保存卡片关联与执行记录 |
| 进度更新 | agent 通过 CLI 明确更新 Issue 状态；Run 的开始/完成接口不直接修改 Issue 状态 | 需要明确的进度/交付信号，保留执行状态与任务状态的区别 |
| 阶段推进 | 子任务阶段关闭后唤醒父任务负责人，由其判断依赖、取消项及下一阶段 | 作为后续扩展的参考，初版支持用户分别指示多个 session |
| 项目管理 | 项目提供目标和资源，聚合任务进度；项目状态与任务状态独立 | 需要单独选择项目完成判据及自动完成范围 |

执行源码依据：[任务触发判定](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/server/internal/service/issue_trigger.go)、[Run 开始与完成](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/server/internal/service/task.go#L4204)、[agent 状态汇报指令](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/server/internal/daemon/execenv/runtime_config_sections.go#L770)。

阶段与项目依据：[阶段完成唤醒](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/server/internal/service/issue_wakeup_system.go)、[项目文档](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/apps/docs/content/docs/projects.mdx)。

Multica 的 Board 是 Issue 的一种视图，支持按状态等属性分组与拖拽更新。可参考其“看板卡片 → 任务详情 → 执行历史”的组织方式。依据：[Board 实现](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/packages/views/issues/components/board-view.tsx)。

### 概念对应，供范围讨论

| 概念 | 在本插件中的含义 |
| --- | --- |
| 看板项目 | 管理目标、卡片及一个或多个 repo/dir，与一个 Paseo project 一对一对应 |
| Paseo project | 看板项目对应的原生项目，新建卡片 workspace 归属于它；关联已有 workspace 保留原归属，多个 repo/dir 列表由插件保存 |
| Paseo workspace | 与一张卡片一对一对应的执行环境，包含该卡片的多个 agent session、终端等 |
| 看板任务/卡片 | 用户想完成的一项工作，对应一个 workspace，可以经历多轮执行 |
| Paseo agent session | 卡片 workspace 内的具体会话，使用 Paseo agent ID 识别和打开；用户可分别向多个 session 发指示 |
| 执行记录 | 插件记录的一次任务执行或阶段尝试，关联其 workspace 和 session |
| 多 agent 交接 | 后续可选扩展；初版允许多个 session 工作，交接与角色编排留待后续 |

Multica 的 workspace 是团队与数据隔离边界，与 Paseo 的执行 workspace 含义不同。依据：[Multica workspaces](https://github.com/multica-ai/multica/blob/b115ec80f1748d8d2766481706b0ecb830389286/apps/docs/content/docs/workspaces.mdx)。

## 4. 初版功能范围与后续候选

首版模块按已确认的约定实施；后续候选的优先级另行评估。

| 编号 | 模块 | 范围概要 | 计划 |
| --- | --- | --- | --- |
| F01 | 基础看板 | 创建/编辑/归档任务、状态列、排序、筛选、任务详情 | 首版 |
| F02 | 项目组织 | 创建/关联一个原生 Paseo project，管理一个或多个 repo/dir，按项目组织卡片 | 首版 |
| F03 | 卡片与 workspace 关联 | 一卡一 workspace；关联已有 workspace，展示其多个 agent session | 首版 |
| F04 | 多 session 与执行记录 | 在同一卡片 workspace 中创建/选择多个 session，保留基本执行记录和状态 | 首版 |
| F05 | 从卡片创建 workspace | 选择项目内的目标 repo/dir，创建普通或 worktree workspace，归属项目对应的 Paseo project | 首版 |
| F06 | 状态流转与执行观察 | 展示各 session 的运行/等待/失败状态；通过看板 tool 明确更新卡片业务状态 | 首版 |
| F07 | 自动领取任务 | 就绪任务排队，空闲执行容量自动启动下一项，可暂停和恢复 | 后续候选 |
| F08 | 项目阶段与依赖 | 子任务、依赖、阶段完成条件及自动推进下一阶段 | 后续 |
| F09 | 多 agent 交接与角色编排 | 自动分配、规划 → 开发 → 评审 → 返工、跨 session 交接 | 后续候选 |
| F10 | 自动拆解项目 | 协调 agent 根据项目目标生成、调整和分配任务 | 暂缓 |
| F11 | Git 交付联动 | 分支、PR/MR、CI、合并状态与任务关联及流转 | 后续，独立选择 |
| F12 | 跨 host / 外部集成 | 多 daemon 调度、外部 issue 同步、通知 | 暂缓，拆项选择 |
| F13 | 看板 tool + skill | 让新建及已有 agent session 查询任务、更新状态和汇报结果 | 首版 |
| F14 | 卡片右侧栏 | 查看卡片唯一 workspace、各 session 状态和执行输出，选择目标 session 并发送后续指示 | 首版 |

跨轮次关联与可靠自动流转需要同步考虑：持久化、重复启动防护、重启恢复、手动接管，以及 workspace/session 被归档后的关联展示。这些内容进入所选模块的设计与验收。

## 5. “自动流转”的四种范围

| 编号 | 自动化范围 | 典型效果 | 建议 |
| --- | --- | --- | --- |
| A1 | 卡片状态流转与执行观察 | agent 通过 tool + skill 更新卡片状态，各 session 执行状态自动展示；完成判据在具体设计中细化 | 首版 |
| A2 | 自动调度 | 项目启用后，按优先级和容量领取就绪任务，完成当前工作后继续下一项 | 后续候选 |
| A3 | 阶段编排 | 依赖满足后启动下一阶段，交接给评审，评审退回后启动返工 | 后续 |
| A4 | 项目自主推进 | 协调 agent 拆解目标、分配工作、调整计划并汇总项目结果 | 暂缓 |

首版通过 tool + skill 支持 agent 推进任务卡状态（A1），并允许用户在同一卡片内指示多个 session。最初提出的项目自主流转保留在后续路线图中，A2–A4 的范围另行评估。

## 6. 总体 Spec 文档大纲

后续具体设计以本初版计划为基线，按下面章节展开。

| 章节 | 要回答的问题 |
| --- | --- |
| 1. 产品目标与使用场景 | 谁使用、管理哪类工作、首版完整工作路径是什么？ |
| 2. 范围与术语 | 一对一的 project/workspace 关系、多个 repo 与多个 session 分别表示什么，首版包含哪些模块？ |
| 3. 项目与任务管理 | 如何创建/关联对应的 Paseo project、维护 repo/dir 列表，以及表达卡片、看板列和项目进度？ |
| 4. 资源关联 | 如何保证一卡一 workspace、原生 project 归属正确，创建时如何选择 repo/dir，以及处理更换或归档？ |
| 5. 执行入口与上下文 | 如何在卡片 workspace 中创建/选择多个 session、继续会话并传递卡片上下文？ |
| 6. 状态与完成判据 | 各 session 执行状态与卡片业务状态如何分别展示，多个 session 更新同一卡片及人工修改如何处理？ |
| 7. 多 session 工作边界 | 用户如何分别指示多个 session，共享目录工作的行为如何说明，以及后续自动交接的范围边界是什么？ |
| 8. 人工接管与异常处理 | 等待输入、取消、失败、重试、重新分配及恢复时应发生什么？ |
| 9. Paseo 扩展点及 agent 工具 | 哪些页面、SDK 操作及 hook 支撑流程，tool + skill 如何接入新建和已有 session？ |
| 10. 数据与恢复 | 如何保存关联和执行历史，多客户端如何同步，重启后怎样核实和续接？ |
| 11. 交互与可观察性 | 右侧栏如何展示卡片的唯一 workspace 及多个 session，如何选择会话并发送指示，如何解释状态流转？ |
| 12. 验收与交付 | 各阶段的完整场景、异常场景、桌面/窄屏覆盖及发布方式是什么？ |

## 7. 大致路线图

| 阶段 | 目标 | 主要产出 | 完成标志 |
| --- | --- | --- | --- |
| R0：具体设计 | 按已确认的初版计划展开 | 首版 spec：项目目录组织、一卡一 workspace、多 session 操作、tool + skill 与右侧栏 | 设计可支持已确认关系和完整使用路径 |
| R1：看板与资源关联 | F01–F04 | 看板 project 与一个 Paseo project 对应，项目 repo/dir 列表，卡片与 workspace 一对一，workspace 内多个 session | 一卡一 workspace 的约束成立，新建 workspace 使用对应 project，已有 workspace 原归属保留，任务可覆盖所有或多个 repo，重启后关联仍可用 |
| R2：workspace 创建与右侧栏 | F05、F14 | 卡片内选 repo 创建 workspace；右侧栏展示各 session，可创建/选择 session 并发送指示 | 新建 workspace 的 repo 来源与 project 归属正确；能分别跟进卡片内多个 session |
| R3：agent 工具与首版闭环 | F06、F13、A1 | 看板 tool、skill、新建及已有 session 接入、卡片状态流转、各 session 状态观察和恢复 | 多个 session 可在同一卡片工作并汇报状态，用户可从侧栏跟进，首版完整可用 |
| R4：可选自动化扩展 | 按选择加入 F07–F12、A2–A4 | 自动领取、阶段交接、自动规划、Git 联动、跨 host 或外部平台集成 | 每项扩展各自满足完整场景和恢复要求 |

R2、R3 均建立在 R1 的关联及持久化能力上；R4 按模块分别评估。工作量和时间估算在具体设计时补充。

## 8. 已确认约定与后续细化项

| 项目 | 初版基线 | 具体设计时细化 |
| --- | --- | --- |
| 功能范围 | 首版 F01–F06、F13–F14 | 每项模块的交互、异常行为和验收场景 |
| 自动化深度 | A1：tool + skill 流转卡片状态，自动观察各 session 状态 | 状态更新规则、冲突处理和恢复；A2–A4 留到后续 |
| 项目关系 | 一个看板 project 对应一个 Paseo project，包含一个或多个 repo/dir | 主目录、repo/dir 管理与 workspace 创建时的目录选择 |
| 卡片关系 | 一个卡片对应一个 workspace | 关联已有 workspace、更换、归档及资源失效的行为 |
| session 关系 | 一卡的 workspace 中可有多个 agent session | 创建、选择、状态展示及后续指示；自动交接与角色编排留到后续 |
| 完成判据 | 卡片业务状态与 session 执行状态分别管理 | agent 交付与人工验收规则 |
| 平台范围 | 以单 daemon、桌面看板及窄屏基本操作为初版设计基线 | 桌面右侧栏与窄屏呈现方式 |
| 规则灵活性 | 先定义默认卡片流程和必要配置 | 列与状态的具体范围；复杂规则编辑留到后续评估 |

后续具体设计沿用本文件的已确认约定。本文保持计划和大纲层级，具体数据结构、接口和交互细节在下一阶段展开。

2026-10-21 GitHub CI/CD: PR/main CI, installed-package smoke and OIDC npm/GitHub
releases from validated version tags. [Spec](CI-CD-SPEC.md),
[operations](CI-CD.md). No product UI or task automation change.

2026-10-24：统一紧凑布局性能路径，保留独立Overview/CardDetail、fresh授权、连续动画与450ms交接；按可用宽度760分界，移除性能门控的平台特化，清理旧CardBoardContext/Proxy。见[统一规范](RESPONSIVE-PERFORMANCE-SPEC.md)、[两阶段读模型](NATIVE-OVERVIEW-SPEC.md)和[瘦身规范](CARD-QUERY-SLIM-SPEC.md)。验证结果见[交付记录](verification/responsive-ship-2026-10-24/README.md)。

- [Motion smoothness](MOBILE-SMOOTHNESS-SPEC.md): fixed Samsung baseline/static-dot/candidate/reverse windows; shared sweep clock yields to existing height lease, no visual geometry/fresh/modal rewrite. Scoped frame observations and remaining long frames are reported separately.

2026-11-03 Linear connector：第六个只读 provider 族，issue 用 `ENG-123` key，GraphQL 只发 query；连接不填地址，workspace 地址由账户校验得到。见 [spec](CONNECTORS-SPEC.md) §14。

2026-11-04 Linear board：主栏 Linear 入口，按状态类型分列的 issue 看板与列表，Start card 打开 Quick task 并附上该 issue。见 [spec](LINEAR-BOARD-SPEC.md)。
