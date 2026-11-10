# Insights 重设计第三版：项目活跃度与 Skills

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：§2.5 的工作流摘要行（换成页面顶部的闭环账，按模型的几行默认收起）；其余仍有效。

状态：**第三版 spec，用户 2026-10-25 审阅通过，实现中**（2026-10-25，卡片 `ccefebbe` “Insights重设计”）。本版取代第二版的页面部分（§10 决定记录说明了前两版的去留）。第二版的实现在本地分支 `feat/insights-redesign`（提交 8176912）和工作区里，**从未合入 main**。用户现在用的是 main 上的第一版页面（[PROJECT-INSIGHTS-SPEC](PROJECT-INSIGHTS-SPEC.md) §9）。第三版在第二版代码的基础上实现。文中“第二版 §x”指第二版 spec，全文见 `git show feat/insights-redesign:docs/INSIGHTS-REDESIGN-SPEC.md`。

## 0. 用户的原话与已定的事

用户 2026-10-25 看完第二版后说：

> 现在的实现还是一般，确实还是需要保留整个项目的活跃信息，用图示的方式能看得出来哪些天比较活跃哪些不活跃，像是 github 项目一样。
>
> 另外我还觉得可以通过 insight 来总结一些项目可以复用的 skills，这可能更是 insights 需要有的能力。

用户举的两个 skill 例子：

> 之前这个项目一直约定要走 PR 的方式合入，但因为开了 coderabbit，合入一直很麻烦，包括什么时候等 coderabbit 的 review 结果、怎么合入每次都执行的不太一样。这种就可以被 insights 捕获变成一个 skill。再或者我在做性能优化，针对 paseo 的 plugin 性能优化也可以是一个专门的 skill。

用户对第二版各区块的评价：

> attention per card 没什么用；where time goes 纯表格看起来也很麻烦而且用处不太大；agents habit 不知道是个啥，看起来就是哪些 agent 没有遵守规范，这应该是我（作为 Flowly 开发者）需要关心的，而不是普通用户需要关注的；daily record 一直没有产生 summary。

已经和用户确认的事：

| 问题 | 用户的决定 |
| --- | --- |
| skill 放在哪 | 写进项目目录：真实文件放 `.agents/` 下，`.claude/` 下用软链接，只存一份 |
| 页面布局 | 按样图（`docs/verification/insights-redesign-v3/mockup-1-page-green.png`）：活跃度在最上，然后是 Skills、其它建议、工作流 |
| 热力图颜色 | 主题绿色，用深浅表示多少（像 GitHub） |
| 第二版的工作流数字 | 保留；2026-10-26 起默认展开（§10.8） |
| skill 提炼默认开不开 | 默认打开，可以在欢迎导览里关掉，模型、频率等在设置里调 |

## 1. 定位

Insights 回答两个问题：

1. **项目最近活不活跃**：哪些天在干活，那天干了什么。
2. **哪些反复出现的做法值得沉淀成 skill**，让以后的 agent 直接照着做，用户不必每次重新交代或纠正。这是 Insights 的**主要能力**。

目标：
- 一眼看出活跃的日子和空闲的日子；点某一天，看那天的总结。
- 从项目的卡片、用户的原话和 agent 的命令里，提炼出完整可用的 skill 草稿。用户确认后写进项目，Claude Code 和 Codex 原生加载。
- skill 能随新经验更新，新版本覆盖旧版本。

不做：
- 跨项目汇总、按人统计、排名。
- 让 Flowly 自己把 skill 注入 session：skill 交给 provider 原生加载（§4.4）。
- 自动提交或推送 skill 文件。

反目标（做到了也算失败）：
- **制造焦虑或鼓励刷量**：不显示连续天数，不显示“过去一年 N 次”这类总数大字，不做排名。热力图只表示疏密。
- **未经用户确认写文件**：草稿在点“加入项目”之前只存在 Flowly 数据里。
- **改动用户自己写的 skill**：Flowly 只会更新它自己加进项目的 skill（§4.5）。
- **同一个 skill 存两份**：`.claude/skills/` 下只放软链接，链接建不成时不复制（§4.3）。

## 2. 页面

单列，内容最大宽度 760，只用主题色。从上到下：

1. 活跃度（热力图，§2.1）
2. 当天（天级总结，可左右翻页，§2.2）
3. Skills（§2.3）
4. 其它建议，默认收起（§2.4）
5. 工作流，默认展开（§2.5）
6. Agent habits，只在开发者开关打开时显示（§6）

页头去掉第二版的窗口切换（‹ 日期范围 ›），整页只有一个“选中的日子”状态。

### 2.1 活跃度热力图

- **每格的数字**：那天结束的 agent 轮次数，即流转日志 `flow/<projectId>.jsonl` 里 `agent.turn_ended` 的条数，按客户端时区切天。流转日志只记卡片 session，Flowly 自己的后台 session（摘要、digest、Workflow insights）不在里面。必须读流转日志，不读 `board.json` 的事件：后者每卡只保留 100 条（项目记忆 pitfall）。
- **范围**：52 个整周再加本周，共 53 列，每列一周，周一在最上。本周还没到的日子不画格子。月份标在该月第一个周一所在的列上方；如果第一列的那个月只剩不到两周，就不标，免得和下个月的标签重叠。行标签只标周一、周三、周五，用当前语言的星期简称。
- **深浅**：没有活动是第 0 级。其余日子按范围内非零天数的 25%、50%、75% 分位数分成 1–4 级，和 GitHub 一样。这样不同规模的项目都能看出差别。非零天数少于 4 天时，每个非零日按实际排序分到不同级别，算法由实现决定。
- **颜色**：第 0 级用 `colors.surface2`；第 1–4 级用 `colors.accent`，不透明度依次为 0.28、0.5、0.75、1。不用其他颜色。
- **格子**：宽屏按星期标签右边的剩余宽度量出格子大小（间距 3 px，格子 8–14 px），最后一周正好停在面板右边缘；固定 11 px 会比 760 宽的列多出约 9 px。星期标签有自己的 16 px 行高，在格子行中居中，不能被格子高度裁掉。紧凑布局（内容宽度小于 760）格子 10 px，整块放进横向 ScrollView，打开时滚到最右边（最近的日子）。
- **选中**：点一个格子就选中那一天，边框为 1.5 px 的 `colors.foreground`。默认选中今天。点没有活动的日子也可以选中。
- 右下角是图例“少 □□□□□ 多”。除此之外不显示任何总数。
- 无障碍：每个格子的 label 写成“10月21日，119 轮”（本地化）。
- 性能：371 个 View 在宽屏和手机上都可以接受。格子行用 `React.memo` 包起来，换选中日期时只重画旧的和新的那两格，回调用 `useStableCallback`。没有动画。

### 2.2 当天（天级总结，可左右翻页）

2026-10-26 用户改的（§10.9）：热力图下面是一张“天级总结”卡，取代原来的当天面板和“最近 7 天”列表。

- **换天**：卡片标题行左右各一个箭头按钮（“前一天”“后一天”），跳到前/后一个**有活动**的日子；没有更早的活动日时“前一天”不可用，到了今天“后一天”不可用。点热力图的格子也会换到那一天（包括没有活动的日子）。热力图上的选中框跟着变。换天时标题行不动，下面的内容从换天的方向滑入（往前从左、往后从右，16 px 并淡入，时长 `motionDuration.forward`，用共享的 `Enter`；连续点击时旧的动画立即停止；系统打开“减少动态效果”时不动）。不做手势滑动。
- **标题行**：箭头、日期（今天写“今天”）、右边是总结的“刷新”按钮（已有总结时）。
- **数字行**（弱化色，一行，放不下就换行）：“119 轮 · 17 张卡 · 完成 15 张 · agent 6h 12m · 48.2M token”。
  - 轮数：那天结束的 agent 轮次（`agent.turn_ended`），与热力图一致。
  - 卡片：那天有轮次或移卡的卡。
  - agent 用时：那天里所有 session 运行区间（`turn_started` → `turn_ended`，`sessionIntervals`）落在当天的部分之和，跨午夜的轮次按时间切开。正在运行的轮次只算到现在。
  - token：那天这些卡的 session 在本地 provider 日志里的用量（按 15 分钟桶，落在当天的桶相加，同 `insights.tokens` 的来源）。读的时候显示“…”，读不到就省略这一项。
  - 没有活动的日子只显示“没有活动”，下面什么都没有。
- **总结**：AI 总结（headline、issues、“更新于 · 模型”）和生成规则不变（见下）。原来完成卡片的 chip 去掉，由下面的任务列表代替。
- **任务列表**：那天有动作的每张卡一行，按那天的 agent 用时从多到少排（相同时按轮数）：
  - 左边：那天完成的卡前面一个勾，其余一个空心圆；然后是卡片标题（一行截断）。点一行打开卡片。
  - 右边：弱化色“12 轮 · 1h 20m · 3.2M”（没有用时或 token 的项省略）。
  - **复杂度**：标题下面一条细横条，长度是这张卡当天用时占当天最多那张卡的比例（没有用时数据时按轮数），颜色用 `colors.accent`，按热力图同样的 4 档不透明度（占比 ≤25%、≤50%、≤75%、更多）。只有一张卡时横条满格。不显示排名或名次。
  - 超过 8 张卡时先显示 8 张，下面“再显示 N 张”。
- **数据**：新 RPC `insights.day`（§7），输入 `{ projectId, tz, day }`，返回那天的数字和每张卡的轮数、用时、token、是否当天完成。token 读日志较慢，所以 `insights.day` 先返回不含 token 的部分，token 由同一个 RPC 带 `tokens: true` 再读一次（客户端两个查询，页面不等日志）。
- **生成**：选中过去某一天时，如果那天有活动、还没有总结、并且 Daily digest 开关是开的，就自动生成，这时显示“正在总结…”。选中今天时不自动生成，显示“生成总结”按钮，点了才生成（等同于 refresh）。任何一天都可以重新生成。触发规则沿用 `insights.digest` / `insights.digest-refresh`，另外改两处：
  - **每个项目同时只生成一份**（PROJECT-INSIGHTS-SPEC §7 本来就这样规定，但现有代码按天计，连点十天会同时开十个 session）。生成进行中又选了别的日子时，记下最后选中的那一天；当前这份结束后，如果那一天仍然没有总结，再生成它。中间点过的日子不生成。翻页也一样：连翻几天只生成正在跑的那天和最后停下的那天。
  - **保留天数**：`DIGEST_DAYS` 由 60 改为 400，覆盖热力图的整个范围。否则一年前的日子生成后立刻被裁掉，每次点开都要重新花一次 token。每条总结只有约 1 KB。
- 这样就修好了“每日记录一直不产生 summary”：第二版的“每日记录”列表只读已有的 headline，从不触发生成，只有展开再点进某一天才会生成，所以 Flowly 项目只有 10 月 16 日一条。

### 2.3 Skills

这是本页的主角，桌面和紧凑布局都显示。

**标题行**：“Skills”，右侧依次是上次分析的时间和模型（例如“11 小时前 · claude-sonnet-5-5”）、“立即分析”和齿轮（打开 Settings → AI 的 Skills 分组）。分析进行中显示“正在分析…”；回填 session 历史时显示“正在读取最近的 session…”（沿用 WORKFLOW-INSIGHTS-SPEC §5.2）。

**行**：每个 skill 一行，左边是展开箭头，然后是 `name`（等宽加粗）· 一句标题（AI 输出语言），右边是状态和依据：

| 状态 | 右侧显示 | 展开后 |
| --- | --- | --- |
| 新草稿 | “新” chip、“N 张卡” | 依据一段（AI 输出语言）；完整的 SKILL.md 预览（等宽字体，最高约 360 px，可以滚动）；按钮 **加入项目**、**忽略**；旁边弱化显示“写入 .agents/skills/<name>/，并在 .claude/skills/ 里建软链接” |
| 有更新 | “有更新” chip、“已在项目中” | 一句话说明改了什么；行级 diff（当前文件 → 新版本，`+`/`-` 前缀，等宽字体）；按钮 **更新到项目**、**保持原样** |
| 已在项目中 | 弱化显示“已在项目中” | 当前文件内容（只读）和路径 |

- 排序：有更新、新草稿、已在项目中；同一状态内按置信度，再按时间。
- “已在项目中”只列 Flowly 加进项目的 skill（§4.5）。用户自己写的 skill 不列，但会作为分析素材（§3.2）。
- **忽略**和**保持原样**都把这条草稿标为 dismissed：30 天内不再提出同名或相似的草稿，沿用 WORKFLOW-INSIGHTS-SPEC §4.4 的冷却规则。被忽略的草稿不显示，不提供恢复；想要的话等下次分析再提，或者立即分析。
- 空状态：还没分析过时显示一行“还没有分析过。”和“立即分析”；分析过但没有 skill 时显示“这次没有值得做成 skill 的做法。”
- 关闭状态（开关关了）：一行“Skills 已关闭。”加 **打开** 按钮，跳到设置分组。

### 2.4 其它建议（默认收起）

用 Disclosure，标题“其它建议”，摘要写“脚本、仓库工具、AGENTS.md · N 条”。内容就是 Workflow insights 现有的建议列表，只是去掉了 `skill` 这一类：目标 chip、标题、依据、proposal，以及 Create card / Dismiss / Restore 操作，行为不变。没有建议时整块不显示。

其它建议和工作流两个收起行共用一个标题列宽（`Disclosure` 的 `titleMinWidth`），摘要从同一个左边缘开始，不再按文字长度靠右排；窄屏摘要单行截断。

展开后三处列表（其它建议、已忽略、工作流）的左边缘与 Skills 列表一致，不缩进（`Disclosure` 的 `flush`）。Skill 行分两行：第一行 skill 名（等宽），第二行标题（弱化色）；右侧上下排列状态 chip 和卡片数；chevron 与第一行对齐。

### 2.5 工作流（默认展开）

用 Disclosure，标题“工作流”。摘要行固定统计最近 7 天：

> 最近 7 天完成 48 张卡 · 中位来回 2 轮 · 一次通过 15% · 每卡 16.3M token

- 口径沿用第二版：来回轮数和一次通过率见第二版 §3.2，每卡 token 见 §3.4，都按到第一次 Done 为止算（`shared/workflow-stats.ts` 的 `cardStats`）。token 还没读到时显示“…”，读失败时这一项省略。
- 完成卡少于 3 张时，摘要改为“最近 7 天完成的卡太少”。
- 展开后只有按模型的几行（第二版 §3.5）：模型名，弱化显示“2 轮 · 20.1M token”，右边是“27 张”。
- 不做窗口切换、和前 4 周的对比、按周表格、建议落地标注、标题句。

### 2.6 从页面上去掉的

attention per card（介入次数）、时间去向及打断来源、成本与质量 Panel（每卡 token 移到 §2.5 的摘要里）、流程异常（R2/R3/R6）、按周表格与建议落地标注、标题句、窗口切换、每日记录列表（由 §2.2 取代）、Agent habits（移到开发者开关后面，§6）。

对应的计算代码如果没有别处使用，一并删除，例如 `workflowStats` 里的 attention、time、weeks、baseline、anomalies 部分。`byUser` 和 `tool` 两个数据字段（第二版 §7）继续记录：项目记忆和 Agent habits 也在用，代价可以忽略。

## 3. Skill 提炼

### 3.1 运行

- **和 Workflow insights 合成一次运行**：同一个开关、周期、整点和模型，同一次模型调用同时返回 skill 草稿和其它建议。调度、安静期跳过、Run now、回填、临时 session（后台 workspace，结束后硬删除）、解析和重试，都沿用 [WORKFLOW-INSIGHTS-SPEC](WORKFLOW-INSIGHTS-SPEC.md) §4。
- **默认打开**（用户 2026-10-25 决定）：`workflowInsightsSettings.enabled` 的默认值由 `false` 改为 `true`，周期默认仍是每周、09:00，模型默认 Auto（Sonnet 5.5，然后 Sonnet 5）。
  - 设置是 host 级的，只有用户保存过才会存下值。从没动过这个开关的用户（包括老用户）会变成开启；明确关过的用户保持关闭。
  - 命令记录随之默认开启。这推翻了 WORKFLOW-INSIGHTS-SPEC §11.1 的“默认关闭”，在那里同步注明。
  - 第一次开启时回填最近 7 天（WORKFLOW-INSIGHTS-SPEC §3.3），升级后的老用户也一样：daemon 启动时发现开关有效值为开、但这个项目还没有任何命令记录，就回填一次。
  - **第一次定时运行要等满一个周期**：对还没有任何运行记录的项目，从开始采集（回填）算起，满 `intervalDays` 天之后才会定时运行。这样升级当天不会在用户看到 What's new 之前，就对每个项目各跑一次 Sonnet。之前 Skills 区块显示“下次分析：<日期>”和“立即分析”。实现时在 `workflow-insights.json` 里按项目记下开始采集的时间（`collectingSince`）。“立即分析”不受这个限制。
- **安静期**：以下两个条件都满足时才跳过（记为 skipped），即任一条件不满足就照常分析，这样命令很少的项目（文档、设计、调研）也能得到 skill：
  1. WORKFLOW-INSIGHTS-SPEC §4.1 的旧规则判为安静（新增 action 少于 50 条，或少于 2 张卡且少于 200 条）；
  2. 自上次运行以来有轮次的卡片少于 3 张（按流转日志统计）。
- 项目没有任何命令记录时，“立即分析”不再记为 “No commands collected yet.”，而是用其余素材照常分析；只有近 30 天里一张有活动的卡都没有时，才记为 skipped（“No recent activity.”）。
- 校验卡片 ID 时（WORKFLOW-INSIGHTS-SPEC §4.4），用近 30 天有活动的卡片集合，不再只用命令窗口里的卡片。
- 每次运行最多 8 条结果，其中 skill 草稿最多 3 条（新草稿和更新合计）。理由：一次给少量但完整的 skill，比一堆半成品好审。
- 每次 ok 并且有有效结果的运行，按类别替换 open 的条目：有新 skill 草稿时只替换 open 的 skill 草稿，有其它建议时只替换 open 的其它建议。这样只出了脚本建议的一次运行，不会把还没处理的 skill 草稿清掉。accepted 和 dismissed 的不受影响（沿用 WORKFLOW-INSIGHTS-SPEC §5.3，“新的覆盖老的”）。

### 3.2 素材

在 WORKFLOW-INSIGHTS-SPEC §4.2 的素材（命令统计、重复序列、内联脚本、失败命令、已有配置、已关闭的建议）之外，新增下面几样。它们都是 Flowly 已有的数据，不新增采集：

1. **近 30 天的卡片**：最近 30 天里有轮次或移入 Done 的卡片，每张一段：短 ID、标题、类型、标签、当前列；最新一版卡片总结（TASK-SUMMARY-SPEC）的 `target` 和 `recap`，合计不超过 600 字；workpad 的验收条目，最多 5 条，每条不超过 120 字。
2. **用户的原话**：项目记忆在每轮结束时采集的线索（PROJECT-MEMORY-SPEC §4.0，`answer` / `feedback` / `message`）。每卡最多 8 条，按时间倒序，每条不超过 400 字，并按 `answer`、`feedback`、`message` 的优先级保留。像“要等 CodeRabbit 评审完再合”这样的纠正就在这里。项目记忆关闭时没有线索，这一节写“(memory off)”。
3. **确认过的项目记忆**：每条一行，标题加正文前 300 字。
4. **标签聚类**：近 30 天里被 ≥3 张卡用过的标签，写出标签、卡数和卡片短 ID。这是领域类 skill 的线索，例如 performance 的 9 张卡。
5. **项目里已有的 skill**：
   - 扫描项目根目录下的 `.agents/skills/*/SKILL.md` 和 `.claude/skills/*/SKILL.md`，按 realpath 去重，每个写出 name 和 description（前 300 字）；
   - Flowly 加进项目的 skill（§4.5）另外附上当前全文，最多 6000 字，供模型判断要不要更新。
6. **已关闭的 skill 草稿**：accepted 的，以及 30 天内 dismissed 的，每条写出 name 和标题。

预算仍然是总长 150 000 字。超出时依次缩减：内联脚本、失败命令、用户原话（每卡条数）、卡片总结的字数，最后是卡片数（先丢最早的卡）。

### 3.3 Prompt（agent 面向的文本，英文）

在 `workflowPrompt` 的基础上修改。`skill` 这一类的说明改写如下，其余类别不变：

- skill 分两种：
  - **流程**：在 ≥2 张卡里反复出现、需要判断的多步做法，例如 PR 交付与合入；
  - **领域知识**：同一类工作在 ≥3 张卡里积累下来的测量方法、常见原因、坑和标准，例如 Paseo 插件性能优化。
- 当素材显示 agent 们对同一件事做法不一致，或者用户纠正过，skill 必须定下一种做法，并写清判断点，例如什么时候等 CodeRabbit、等到什么信号算评审完成。依据要引用卡片短 ID、次数和用户原话。
- 不要把 AGENTS.md 已经原样写着的规则抄成 skill；但可以把分散在 AGENTS.md、项目记忆和多张卡里的规则整合成一个连贯的流程。
- 不提一次性的修复、只出现在一张卡里的做法，也不提已有 skill 已经覆盖的内容。
- 返回字段：`target: "skill"`，`title`、`evidence`、`benefit` 用输出语言写，另外加：
  - `skill.name`：小写短横线命名，不超过 64 字符，不与已有 skill 重名；
  - `skill.description`：英文，1–1024 字，第一句以 “Use when …” 开头，说明什么时候用；
  - `skill.body`：英文 Markdown，200–8000 字，不带 frontmatter。依次包括 When to use、Steps、Commands（只写素材里出现过的命令或已有脚本）、Pitfalls、Sources（卡片短 ID）。用仓库相对路径，不写 home 绝对路径，不写密钥；
  - 更新已有 skill 时加 `skill.updates: true`，`skill.name` 用已有的名字，`skill.body` 给完整新版本，`skill.change` 用一句话（输出语言）说明改了什么。只在素材带来实质的新内容时才更新。
- skill 正文用英文：它是给 agent 读的（AGENTS.md：agent-facing text stays English），也和 `skills/flowly` 保持一致。行标题和依据用用户的 AI 输出语言。这是我的决定，可以推翻。

### 3.4 校验（daemon，不信任模型）

在 WORKFLOW-INSIGHTS-SPEC §4.4 的规则（卡片 ID、≥2 张卡、字段长度、去重、冷却）之外，`skill` 这一类还要满足：

- `name` 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，不超过 64 字符；`description` 1–1024 字；`body` 200–8000 字，并且不以 `---` 开头。不满足的丢弃，不截断。
- **新草稿**：`name` 不能和项目里已有的 skill 同名（`.agents/skills/<name>` 或 `.claude/skills/<name>` 已经存在），也不能和本次的其它草稿同名。
- **更新**：`name` 必须是 Flowly 加进项目的 skill（§4.5），而且文件还在；新正文和当前文件的正文完全相同时丢弃。
- 对 `description` 和 `body` 套用 `redact`（WORKFLOW-INSIGHTS-SPEC §3.2）。脱敏后仍含 `<secret>`、`<cred>` 的草稿整条丢弃，宁可少一条，也不把可能的密钥写进仓库。
- 每次最多保留 3 条 skill 草稿，按置信度取。

### 3.5 数据

`workflow-insights.json` 的变化。新增的都是可选字段，`version` 不变，旧数据读取时补默认值：

- `Finding` 新增可选字段 `skill: { name, description, body, updates?: boolean, change?: string }`，只在 `target === "skill"` 时出现。旧的 skill 建议没有这个字段，在 Skills 区块里按 WORKFLOW-INSIGHTS-SPEC 的旧样式显示（标题 + proposal + Create card），直到下一次运行把它们替换掉。
- 新增 `installed: [{ projectId, name, findingId, at }]`，记录 Flowly 加进项目的 skill。这是判断“Flowly 的 skill”的唯一依据，不在文件里加标记。
- 新增 `collectingSince: { [projectId]: ISO 时间 }`，用于 §3.1 的“第一次定时运行要等满一个周期”。
- 文件被用户删掉以后，`installed` 里对应的记录在下次读取时清理掉。
- Remove 项目时连同 `installed` 一起备份、删除，沿用 WORKFLOW-INSIGHTS-SPEC §5.1。删除记录不会删除仓库里的文件。

## 4. 加入项目

### 4.1 RPC

`workflow-insights.install-skill`：输入 `{ projectId, findingId, expectedRevision }`，输出 `{ revision, path, linked: boolean, notice?: string }`。在该项目的串行写入里执行。

### 4.2 写文件

1. 这条建议必须属于该项目，状态是 open，`target` 为 `skill`，并且有 `skill` 字段；否则报错 `FINDING_NOT_OPEN: …`。`expectedRevision` 不符时报 `REVISION_CONFLICT`。
2. 根目录取项目的原生根目录 `project.primaryPath`；目录不存在时报 `PROJECT_ROOT_MISSING`。插件建立的 linked root 也一样写在那个目录下（PROJECT-PICKER-SPEC），从那里启动的 session 都能读到。
3. 目标文件是 `<root>/.agents/skills/<name>/SKILL.md`：
   - 新草稿：`<root>/.agents/skills/<name>` 已经存在时报 `SKILL_EXISTS: A skill named <name> is already in the project.`，什么都不写；
   - 更新：这个文件必须存在，并且 `name` 在 `installed` 里，否则报 `SKILL_MISSING`。
4. 文件内容是 frontmatter（`name`、`description`，由 daemon 用 YAML 安全地转义生成）、一个空行、`body`，结尾带换行。先 `mkdir -p`，再写临时文件后 rename，原子替换。
5. 不运行 git，不提交，也不改 `.gitignore`。

### 4.3 软链接

`<root>/.claude/skills/<name>` 指向相对路径 `../../.agents/skills/<name>`，只建这一个 skill 的链接，不链接整个目录，免得影响用户已有的 `.claude/skills/`。

| 现状 | 处理 |
| --- | --- |
| 不存在 | 先 `mkdir -p <root>/.claude/skills`，再建链接；`linked: true` |
| 已经是指向同一目录的链接 | 不动；`linked: true` |
| 是别的东西（目录、文件、指向别处的链接） | 不动；`linked: false`，notice：“.claude/skills/<name> already exists; Claude Code keeps using it.” |
| 建链接失败（权限、文件系统不支持） | 不复制，因为用户要求只存一份；`linked: false`，notice：“Could not link .claude/skills/<name>; Claude Code will not see this skill.” |

### 4.4 agent 怎么用上

不需要 Flowly 参与：Claude Code 读 `.claude/skills/`，Codex 读 `.agents/skills/`，它们都会把 skill 的 name 和 description 放进上下文，需要时再读全文。限制有两条，在“加入项目”成功后的 toast 里说明：

- 文件提交之前，用 worktree 的卡片看不到这个 skill，因为新 worktree 只包含已提交的内容。
- 已经在跑的 session 可能要新开一个 session 才能发现新 skill（provider 的行为）。

toast：“Added to the project. Commit .agents/skills/<name> and .claude/skills/<name> so worktrees and teammates get it.”

### 4.5 加入之后

- 这条建议标为 accepted（记下 `acceptedSkill: name`），并在 `installed` 里添加或刷新一条记录。
- 以后的运行会把这个 skill 的当前全文放进素材（§3.2 第 5 项），模型可以提出更新（§3.3）。用户手动改过文件也没关系：diff 以当前文件为准，用户确认后才覆盖。
- 用户自己写的 skill 不在 `installed` 里，Flowly 永远不会改它们。

### 4.6 视图

`workflow-insights.get` 的 value 增加：
- `installed: [{ name, path, content }]`：当前文件内容，读取失败时省略这一条；
- 对每条更新草稿附 `current`：当前文件的正文，客户端用来算 diff。

diff 由客户端计算：用一个简单的按行 LCS（几十行规模），不引入新依赖。

## 5. 设置与引导

- **设置**：Settings → AI 里的 “Workflow insights” 分组改名为 **Skills**。说明文字改成：“Every week a model reads this project's cards, your messages and the commands agents ran, and drafts skills and scripts worth keeping. Spends tokens and keeps a local log of commands.” 开关、模型、频率、整点、费用行和 “Delete collected commands…” 都保留，行为不变。项目设置里的开关同样改名为 **Skills**。
- **欢迎导览第 4 页（Insights）**：
  - 页面说明改为：“See which days were busy, and turn what agents keep redoing into skills.”
  - 示例框换成一小块热力图（几周）和一行 skill 草稿示例，替换第二版的 attention 示例，对应的 Legend 也一起换。
  - 开关：Insights、Daily digest、**Skills**（默认开，可以在这里关掉）。Skills 开关的说明去掉 “Off by default”，改为：“A model reads your cards and commands each week and drafts skills. Spends tokens; model and schedule are in Settings.” 后面接费用估算。
- **一次性提示**：新增 `first-skill-draft`。条件：Insights 和 Skills 都开着，当前项目有 open 的 skill 草稿，而且没有打开 Insights。文案：“Insights drafted a skill from your cards. Open Insights to add it to the project.” 优先级放在 `first-workflow-insight` 前面。第二版加的 `insights-redesign` 提示从没上线，直接删掉。`first-workflow-insight` 保留，只用于其它建议。
- **What's new**：在 `client/whats-new.ts` 顶部加一个版本，内容：
  - “Insights shows a year of activity; tap a day for its summary.”（发布 1.7.0 时改为一句总述整个改版，见 WHATS-NEW-SPEC §6）
  - “Insights drafts skills from your cards and adds them to the project when you say so. On by default; turn it off in Settings.”

  附 **Open settings** 按钮。理由：老用户会被默认打开，属于“现有用户自己碰不到的变化”（AGENTS.md）。
- README 两份的 Insights 亮点、ONBOARDING-SPEC 提示表、PROGRESS、SPEC-OUTLINE 同步更新。WORKFLOW-INSIGHTS-SPEC 注明 §5.2、§8、§11.1 被本 spec 取代的部分。所有新文案加入全部语言目录，删掉的文案从所有目录删除。

## 6. Agent habits 改为开发者开关

- 用户 2026-10-25 的判断：Agent habits 是 Flowly 开发者关心的东西，普通用户不需要。
- 新增 host 设置 `developer`（`shared/settings.ts`），只有一个字段 `agentHabits: boolean`，默认 `false`。和 `performance` 的计时日志一样，没有设置页面：要打开时，在 `~/.paseo/plugin-settings/flowly/developer.json` 写入 `{"version":1,"values":{"agentHabits":true}}`，然后 reload 插件。
- 打开时，Agent habits 区块显示在页面最底部，内容不变（WORKFLOW-INSIGHTS-SPEC §12.6）；关闭时 `insights.project` 不计算 habits。
- 记录不受开关影响：`model`、`pick`、`offered` 等字段照常写入，打开后能看到完整的历史。
- 这是我的决定，可以推翻。

## 7. RPC 与数据

- `insights.project`：输入 `{ projectId, tz, etag? }`，去掉 `end` 和窗口。返回：
  ```
  { today,
    activity: { from, days: [{ day, turns, cards, done: string[] }], levels: [q1, q2, q3] },   // 只列有活动的日子
    workflow: { finished, rounds: { median }, onePassShare, models: [{ model, cards, rounds }] }, // 最近 7 天
    habits?  // 只在开发者开关打开时出现
  }
  ```
  `done` 是那天移入 Done 的卡片 ID，同一张卡一天只列一次。etag 由流转日志的长度和 mtime、今天的日期、开发者开关决定。
- `insights.tokens`：只保留最近 7 天完成卡的每卡 token 和按模型的值，即 §2.5 用到的部分。
- `insights.day`：输入 `{ projectId, tz, day, tokens? }`。返回 `{ day, turns, agentMs, tokens?, list: [{ taskId, turns, agentMs, tokens?, done }] }`（卡片数和完成数由 `list` 得出）；`tokens` 只在输入 `tokens: true` 时读本地日志后给出，读不到时为空。纯函数在 `shared/day-detail.ts`。
- `insights.digest`、`insights.digest-refresh`：不变。`insights.digests`（headline 列表）删除。
- `workflow-insights.get`：增加 §4.6 的字段。`workflow-insights.install-skill`：新增，见 §4.1。
- 计算放在纯函数里：`shared/activity.ts`（热力图聚合与分级），`shared/workflow-insights.ts`（skill 的素材、prompt、校验）。

### 7.1 与 SQLite 存储迁移（R1）的关系

用户 2026-10-25 决定：**本版先合入**，基于现在的 JSON 存储实现。SQLite R1（[SQLITE-STORAGE-SPEC](SQLITE-STORAGE-SPEC.md)）在切换真实数据之前，要把本版新增的内容加进它的 schema 和写方法白名单，否则 `installed` 会被当成未知字段放进只读保留区，Flowly 就再也认不出自己加进项目的 skill。需要 R1 补上的有：

- `workflow-insights.json`：根级 `installed`、`collectingSince`；finding 的 `skill`（`name`、`description`、`body`、`updates`、`change`）和 `acceptedSkill`；
- 新的写方法 `workflow-insights.install-skill`。它会写项目目录里的文件，属于有外部副作用的写操作，要按 R1 对这类操作的规则处理；
- `digests.json` 每个项目保留 400 天（原来是 60 天）；
- `insights.project` 的 etag 依赖流转日志的长度和 mtime。R1 把流转日志搬进 SQLite 之后，要换成相应的修订号。

交付时会提一个 idea，把这份清单交给 SQLite 那张卡。

## 8. 验收

**单元测试**
- 热力图：按时区切天（跨午夜）；53 列、周一开始、未来的日子不出现；分位数分级（含全为 0、只有 1–3 个非零日）；`done` 去重；只用流转日志。
- 素材：近 30 天卡片的选择；线索的条数和优先级；标签聚类阈值；已有 skill 的扫描和 realpath 去重；超出预算时的裁剪顺序。
- 校验：name 格式；长度；与已有 skill 重名；更新目标必须在 `installed` 里；正文相同的更新被丢弃；脱敏后仍含密钥的整条丢弃；最多 3 条；冷却。
- 替换：只有其它建议的运行不清掉 open 的 skill 草稿，反过来也一样。
- 加入项目：写入内容和 frontmatter 转义；原子写入；`SKILL_EXISTS` 时什么都不写；更新时覆盖；软链接的四种情况；accepted 和 `installed` 记录；文件被删后清理记录。
- 设置：从未保存过时默认开启；保存过 `false` 的保持关闭。
- 调度：没有运行记录的项目在 `collectingSince` 满一个周期前不定时运行，Run now 不受限；安静期两个条件都满足才跳过；没有命令记录时 Run now 仍然分析。
- 每日总结：同一项目连选多天只生成正在进行的一份和最后选中的一份；保留 400 天。
- 提示 `first-skill-draft` 的规则（`client/onboarding-logic.test.ts`）；i18n 完整性（`npm test`）。

**检查**：`npm run typecheck`、`npm test`。在只含本卡改动的隔离 worktree 上运行。

**实测**
- reload 插件后，在 Flowly 项目上 Run now（Auto 模型）。期望：用户举的两个例子（PR 交付与 CodeRabbit、Paseo 插件性能优化）至少有一个出现在 skill 草稿里，依据引用了真实卡片。记录 token 和费用。Flowly 仓库里的 skill 不在测试里加入，由用户决定。
- 在 Tinylink 上加入一个 skill，检查文件、软链接和 toast；测试结束后删除测试写入的文件和链接（Tinylink 是永久 fixture，只清理测试自己写的东西）。
- 用 `docs/promo/shot-lib.mjs` 截图：桌面浅色和深色、紧凑布局（热力图横向滚动）、某一天总结生成前后，存入 `docs/verification/`。
- 按 AGENTS.md，用显式 full-access 的 `codex/gpt-6-luna` 测试 session 实测，包括手机原生布局。

## 9. 留给实现者决定的

组件拆分、间距、空状态的具体排版、diff 算法细节、分位数的插值方式、热力图在 web 上是否加 hover 提示（RN 没有原生 tooltip，可以不做）。

## 10. 决定记录

1. 2026-10-22 第一版（产量统计，数字块 + 图表）：被用户否定，“不应该是用来让用户焦虑、鼓励用户卷的机制”。第一版没有提交。
2. 2026-10-22 第二版（只评估工作流：介入次数、来回轮数、时间去向、每卡成本、按周表格；不用图表）：实现在 `feat/insights-redesign`，未合入。2026-10-25 用户评价“一般”，见 §0。第二版保留下来的：来回轮数、一次通过率、每卡 token、按模型（都收进 §2.5），以及 `byUser`、`tool` 两个数据字段。
3. 2026-10-25 第三版方向（用户）：加回项目活跃度，做成 GitHub 式热力图；skills 是 Insights 的主要能力。
   - 这推翻了第二版的两条原则：“不按天看”和“不用图表”。保留的是“不制造焦虑”：不显示连续天数，不显示总数大字，不排名。
4. 2026-10-25 skill 放在项目目录里（用户）：`.agents/skills/<name>/` 放真实文件，`.claude/skills/<name>` 是软链接，只存一份。按单个 skill 建链接，是我的决定。
5. 2026-10-25 布局、绿色热力图、工作流数字保留并默认收起（用户看样图后确认）。2026-10-26 改为工作流默认展开，见第 8 条。
6. 2026-10-25 skill 提炼默认打开（用户），可以在欢迎导览和设置里关闭。这推翻了 WORKFLOW-INSIGHTS-SPEC §11.1 的“默认关闭”。
7. 2026-10-25 本版先于 SQLite R1 合入（用户），R1 负责补上 §7.1 的清单。
8. 我做的决定（可以推翻）：
   - 活跃度以轮次数计；
   - 和 Workflow insights 合并成一次运行；
   - skill 正文用英文；
   - 每次最多 3 条 skill 草稿；
   - 用户的原话复用项目记忆的线索，不新增采集；
   - Flowly 只更新自己加进项目的 skill；
   - Agent habits 放到无界面的开发者设置后面；
   - 过去的日子在选中时自动生成总结，今天的要手动生成；每个项目同时只生成一份；总结保留 400 天；
   - 第一次定时运行等满一个周期；安静期同时看命令数和有活动的卡片数。

## 11. 实现计划

在分支 `feat/insights-v3` 上做（从 `origin/main` b2e9c40 开出，先摘入第二版提交 8176912），在独立 worktree 里改和测，不碰主工作区。

1. **活跃度与当天**
   - 新文件 `shared/activity.ts`：从流转日志按天聚合轮次数、有动作的卡、完成的卡，算分位数分级，配单元测试。
   - `server/insights.ts` 的 `project()` 改为返回 `{ today, activity, workflow, habits? }`，去掉 git 读取、运行中 session 查询和 `end` 窗口。
   - `shared/digest.ts` 的 `DIGEST_DAYS` 改为 400；digest 改成每个项目同时只生成一份，并记下最后选中的那一天。
2. **工作流摘要瘦身**：`shared/workflow-stats.ts` 只保留最近 7 天的完成数、来回轮数、一次通过率、按模型的分组，以及 token 计算需要的卡片列表，删掉 attention、time、weeks、baseline、anomalies 和 landed。相应的测试也一起改。
3. **开发者开关**：在 `shared/settings.ts` 新增 `developerSettings`；`project()` 只在开关打开时计算 habits。
4. **skill 数据与纯函数**（`shared/workflow-insights.ts`）：
   - 设置默认打开；
   - finding 加 `skill` 和 `acceptedSkill` 两个字段，state 加 `installed` 和 `collectingSince`；
   - 素材增加卡片、原话、记忆、标签聚类和已有 skill 五节，并带裁剪；
   - 修改 prompt 和解析；
   - skill 校验，加上按类别替换 open 条目；
   - 修改安静期规则，加上首次定时运行要等满一个周期的规则；
   - 生成 SKILL.md 文本，计算行级 diff 供客户端使用。
5. **服务端**（`server/workflow-insights.ts`）：
   - 收集新素材：卡片总结、记忆线索和条目、项目里的 skill 目录；
   - 调度的修改；没有命令记录时，Run now 照样分析；
   - 新增 `installSkill`（写文件、建软链接、记录 installed），view 里补上 `installed` 和 `current`；
   - 在 RPC 和 `index.server.ts` 里接上这些改动。
6. **客户端**：
   - 重写 `client/insights.tsx`，内容是热力图、当天、Skills、其它建议、工作流，最后是开发者开关打开时才显示的 habits；
   - `client/queries.ts` 去掉 headline 查询；
   - 设置分组改名为 Skills；
   - 欢迎导览第 4 页；
   - 新增提示 `first-skill-draft`，删掉 `insights-redesign`；
   - 加一条 What's new。
7. **文案与文档**：
   - 新文案进全部 9 个语言目录，删掉的文案从目录里清理掉；
   - 同步 README 两份、ONBOARDING-SPEC 的提示表、PROGRESS、SPEC-OUTLINE，并在 WORKFLOW-INSIGHTS-SPEC 里注明被本 spec 取代的部分。
8. **检查**：在 worktree 里运行 `npm run typecheck` 和 `npm test`。实测（reload、Run now、Tinylink、截图、Luna）要在本机安装这个分支的代码才能做，先征得用户同意。
8. 2026-10-26 页面太空（用户）：页面下半截是空白，选择“工作流默认展开”，并加最近 7 天列表（§2.2）；其它建议仍默认收起。这推翻第 5 条里工作流的“默认收起”。用户另让我看看还有什么可补进来：候选（本周完成的卡按标签分布、本周确认的项目记忆、本周最忙的卡）先不做，见 PROGRESS，等用户选。
9. 2026-10-26 天级总结（用户）：当天面板改成可左右翻页的天级总结卡，包含总结、任务列表、轮数、token、用时，任务按复杂度（用时、轮数）做视觉区分；点热力图也能换天。取代第 8 条里的“最近 7 天”列表。翻页只跳有活动的日子、复杂度用横条，是我的决定。
