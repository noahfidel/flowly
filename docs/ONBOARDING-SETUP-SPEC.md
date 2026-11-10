# 欢迎导览重设计：介绍 + 基础设置

Status: **已实现，用户 2026-10-22 确认设计**（卡片“重设计onboarding流程”）。ONBOARDING-SPEC §2/§5、NATIVE-SESSION-SPEC §12.6、PROJECT-MEMORY-SPEC §9、INSIGHTS-REDESIGN-SPEC §9.1、README 已同步。验证见 §11。

## 1. 目的

现有导览（ONBOARDING-SPEC）只介绍概念和功能，所有开关都要事后去 Settings 里找。用户希望新用户第一次进来时，在同一个流程里：

1. 看懂 Flowly 是什么（保留现有概念页）；
2. 选好界面语言和 AI 输出语言；
3. 知道基础 AI 能力（Progress、Next moves、Ideas）在做什么，并做子项设置；
4. 逐个了解高级功能（Project memory、Insights），决定开不开；
5. 关掉导览后知道以后去哪改。

反目标：打断老用户；导览变成必须填完的表单（随时可 Skip，Skip 即默认配置）；为讲解而加大启动包（图用代码画）。

## 2. 用户决定（2026-10-22）

| # | 决定 |
| --- | --- |
| D1 | Progress、Next moves、Ideas 是基础能力：导览里**不提供关闭**，只能做子项设置（Progress 模型、是否也对非 Flowly session 生效）。 |
| D2 | “也对非 Flowly session 生效”**默认开**，导览里写明成本（每个外部 session 每完成一轮跑一次 Summary 模型，读最近对话并发给该模型的提供方）。这推翻 NATIVE-SESSION-SPEC §12 当时“默认关”的决定；用户已知成本。 |
| D3 | **没完成导览的已安装用户，外部 session 功能全部不生效**：不改它们现有的存储值（默认关）。只有完成或 Skip 首次导览时才写入“开”。 |
| D4 | Memory、Insights 是高级功能，各占一页，**代码画的示意图 + 文字**（不用截图），默认开，可在导览里关闭并做子项设置。 |
| D5 | 仍可 Skip；Skip 按默认配置开启功能。 |
| D6 | 导览关闭后，高亮设置入口，提示可以在设置里开关功能、改配置。 |
| D7 | **老用户维持现有逻辑**：只对空看板的新用户自动弹出；老用户不弹（ONBOARDING-SPEC §1 不变）。“更新后弹新功能提示”另提 idea，不在本卡做（已实现：[WHATS-NEW-SPEC](WHATS-NEW-SPEC.md)）。 |
| D8 | Settings 里现有的 Ideas 总开关和 Auto summary 开关**保留**；“不允许关闭”只针对导览。 |

## 3. 页面结构（5 页）

同一个 `Modal`、同一套页脚（步骤点、Skip、Back、Next/最终按钮）和翻页动效，桌面与手机同一组件，内容超高时滚动。页数从 3 变 5。

### 第 1 页：How Flowly works

- 顶部一行 **Interface language** 下拉（默认“Device (…)”）：选完立刻存（`language` 设置），导览当场换语言。放在最上面，是为了用户先能读懂后面的内容。
- Project / Card / Session 三张等宽卡片（图标、名称、一句话、对应的 Paseo 对象），中间是固定宽度的箭头。
- **Attention**（2026-10-22 用户反馈：第一页不讲 loop，改讲 Attention 机制；再次反馈：模拟通知入口和多条需要人决策的信息）：放在和第 2、3 页同样的框里（2026-10-22 统一版式）：上方提示 “Try it: open or dismiss a card.” 和 **Start over**；框内左上 “Board”、右上是看板真实的 **Attention 按钮**（`client/attention-button.tsx`，从 `board.tsx` 拆出共用）和它下面的 **Needs attention** 下拉（同 Popover 的标题行与行样式），列出四种要人决定的情况：提问（Add rate limiting · Design · 1 question）、授权（Migrate users table · Development · 1 approval）、出错（Fix flaky CI · Test · 1 error）、做完待审（Update README · In review · 1 unread）。可以操作：点一行（打开处理）或它的铃铛关闭按钮（Dismiss），这一行淡出收起、计数随之减少；点铃铛开合下拉；全部处理完显示真实的空状态。框下三列：Needs you “When an agent asks, waits for approval or fails, its card says so.”、The bell “Counts every card that needs you.”、Open or dismiss “Open a card to answer it, or dismiss it from the list.” 原来的泳道条与 You/Agent 三步说明删除。

> 我的理解：用户说的“progress、next move、ideas 在第一页”指**功能设置部分的第一页**，概念页仍放最前（用户确认 spec 时接受）。

### 3.1 统一的版式与真实组件（2026-10-22 用户反馈：对齐、大小、字体不一致；demo 要用 Flowly 里真实元素的样式，少用说明文字和二级标题）

- 导览是自己的窗口（React Native `Modal`，宽 `min(780, 窗口宽 − 32)`，高 `min(760, 窗口高 − 48)`），和 Settings 一样不用宿主 Modal（宿主 Modal 宽度固定约 520，放不下真实组件）。结构：标题栏（Flowly 标志、标题、关闭）、可滚动内容、固定页脚（步骤点、Skip、Back、主按钮）。点遮罩或 Esc 关闭，等同 Skip。打开时屏蔽看板快捷键（`useShortcutBlock`）。
- 第 1、2、3 页是可交互的演示（`client/tour-demos.tsx`，2026-10-22 用户反馈“最好做成动态展示或可交互体验”）：用 Flowly 的真实组件，只改本地状态，不读写看板、会话或设置；计时器在翻页或关闭导览时全部清掉。第 2、3 页共用同一套框（`DemoFrame` / `DemoSide`）和控制行（`DemoControls`：提示、Pause / Play、Start over）。第 4 页仍是不可点的示例（`pointerEvents="none"`，对读屏隐藏）。Insights 的指标行在别的卡未提交的改版里才是独立组件，这里按其样式（`StatRow`）照画，提交那张卡后可换成引用。
- 文字只有：页标题 lg 粗体 · 一行导语 md 弱化色 · 列名 base 粗体 · 列下一句 sm 弱化色。去掉了小节标题和大段说明；导览里的设置行用 `brief`，不显示详细说明（Workflow insights 的花费说明保留）。
- 每页同一个版式（2026-10-22 用户反馈“确保全部几页的样式一致性”）：页标题与一行导语 → 设置组（第 1、3、4 页在最上面；第 2 页按用户要求放在演示下面）→ 演示：上方一行提示（左）和按钮（右，Pause / Play、Start over，按需）+ 同一种框（`DemoControls` / `DemoFrame`，框内小标题用 `SideTitle`）→ 框下一行三列名称 + 一句话（`Legend`）。第 1 页的 Attention 演示和第 4 页的 Insights 示例也放进同样的框；第 4 页的三列解释三项指标。
- 页面在折叠线下还有内容时，内容区底部浮出一个 “More below ⌄” 胶囊（第 2 页写 “Settings below”），按下滚到底；滚到接近底部就淡出（`MoreBelow`）。
- 并排内容用 `Columns`：每列严格等宽，分隔箭头是固定宽度的独立元素；窗口宽度 < 600 时上下堆叠。

### 3.2 键盘

- 回车：下一页；最后一页等同主按钮（Create project 或 Done）。只在焦点在导览本身时生效，焦点在开关或按钮上时回车保持它们自己的作用。
- → / ←：下一页 / 上一页（到头不动），焦点在导览内任何位置都可用。
- 带修饰键、按住重复、输入法组字时不响应；Esc 由窗口自己关闭。
- 打开时和每次翻页后，焦点回到导览，所以一打开就能按回车。主按钮在桌面端带回车图标作为提示。
- 纯逻辑 `tourKey`（`client/onboarding-logic.ts`），有单测。

### 3.3 AI 功能的成本预估（2026-10-22 用户反馈：给用户作为参考）

每个会花 token 的开关旁写一行预估，导览和 Settings 用同一组件，所以两处一致：Progress model（每轮 agent）、Sessions outside Flowly（每轮）、Find memories in finished cards（每张完成的卡片）、Daily digest（每份）、Workflow insights（每次运行）。

- 数字是实测：每次运行是一个短的 Claude Code 子 session，大部分 token 是它的系统提示写入缓存。取本机日志里 2026-10 的中位数（`shared/ai-cost.ts`）：Progress 约 55K token（419 次，Haiku 5.5）、完成卡复盘约 61K（30 次）、日报约 48K（4 次）、Workflow insights 约 125K（11 次，Sonnet 5.5）。外部 session 的运行和 Progress 同形，用同一组数字。
- 价格是 Anthropic API 标价（缓存写入 1.25×、读取 0.1× 输入价），按当前选的模型算（Auto 按其第一个模型：Summary 为 Haiku 5.5，Workflow 为 Sonnet 5.5）。例：Progress 每轮约 $0.006，100 轮约 $0.56；Workflow insights 每次约 $0.32。没有标价的模型（如 Codex）只写 token 数。
- 文案：“About {tokens} tokens per agent turn: {cost} with {model} at API prices, {hundred} for 100 turns.” 等，写明是“API 价”，订阅用户据此理解为用量参考。原来 “Uses a few tokens per card.” 换成实际数字。
- 顺带：`modelLabel` 把 `claude-<family>-<a>-<b>` 一律显示成 “Sonnet 5.5” 这样的名字（原来只认识 Haiku 5.5）。

### 第 2 页：Built in（基础能力，始终开启）

标题 “Built in”，说明 “These run on every card. You can tune them here, not turn them off.”

（2026-10-22 用户反馈后改版：先是三列各自的演示，后改为**一个完整案例**串起三个功能，见下。）

- 标题旁一个 “Always on” 胶囊（三项都始终开启，只标一次）。
- **一个完整案例**（`LoopDemo`，`client/tour-demos.tsx`）：一个框，左边 **Session**，右边 **Card**（真实 Progress 卡片，之后是 Ideas）。窄窗口上下堆叠。上方一行提示和 **Start over**（重置整个案例）。
  - Session 是一段看起来真实的对话（2026-10-22 用户反馈），用 Flowly 会话视图自己的 `TranscriptEntry`（你的消息为气泡，agent 回复按 markdown 渲染）和 `ActivityBlock`（“Thought · n tool calls”，可展开；运行中显示 Working 和最新一步）。数据按 Paseo 时间线条目的形状构造，经 `recentSessionOutput` / `groupTranscript` 分组。开场：你的请求 “After signing in, people land on /home instead of the page they came from. Fix it.”、一段思考与 3 次工具调用、agent 回复。下面是真实建议条 `NextMoves` 和消息框。对话区可滚动，新内容和建议条出现时滚到底。
  1. 开始时上一轮已结束：回复 “Fixed the login redirect: the sign-in callback now keeps `next` …”，Progress 为 State “Login redirect fixed; not tested yet.”、Target “People return to the page they came from after signing in.”、Recap “The sign-in callback dropped the next parameter; it now keeps it.”、Next “Run the tests.”，脚注 “Updated 2m ago · Haiku 5.5”，建议 **Run tests**。提示 “Try it: pick the suggested step, then send it.”
  2. 点 Run tests 只把内容填进消息框；点发送后出现你的消息，活动行显示 Working 并逐步加入思考和工具调用（每步约 0.35 秒），之后回复 “Ran `npm test`: **all 132 tests pass**. … so I proposed an idea.”；Progress 标题旁显示 Updating…，约 0.9 秒后变成 “Tests pass; ready to commit.” / “Commit and push the fix.”，同时出现新建议 **Push**、**Open a PR** 和真实想法卡片 “Retry failed uploads”。提示变为 “Try it: Good idea turns the idea into a task.”
  3. **Good idea**：想法变成落在 Todo 的新任务（真实 `TaskCard`）；**Dismiss** 收成一行可 Restore。再发 Push 或 Open a PR 会进入第三轮（“Committed and pushed to `fix/login-redirect`.”，Progress “Ready for review.”）。
- **自动演示**（2026-10-22 用户反馈：保留人工交互的形式，默认自动点击展示整个流程）：打开这一页就自动播放，按真人操作的顺序按下同样的控件，每次先在要按的那个控件上画一圈强调色描边约 0.7 秒再按（具体到 Run tests 这一个建议、发送按钮、Good idea 按钮；`NextMoves` 的 `cue` 与 `IdeaCard` 的 `cueGood` 可选属性，共用 `CueRing`，别处不传则无变化）：约 1.5 秒后选 Run tests → 约 0.8 秒后点发送 → 想法出现约 1.5 秒后点 Good idea → 任务出现 4 秒后重新开始，循环。提示行为 “Playing it for you. Press anything to try it yourself.”，旁边 **Pause / Play** 切换。你自己按任何一个控件（建议、发送、关闭建议、Good idea、Dismiss、Restore）就停止自动播放、接着手动；Start over 保留当前的播放状态。系统开了 Reduce Motion 时默认暂停。下一步的判断是纯函数 `loopAutoStep`（`client/onboarding-logic.ts`，有单测）。
- 演示框高 360（原 520，2026-10-22 用户反馈“稍微减少 demo 高度，让下面的内容能被看到，引导用户滚动并进行设置”）：桌面窗口里第一屏就能看到下方设置的第一行，加上 “Settings below” 胶囊。
- 框下面一行三列说明（名称 + 一句话）：Progress “Rewritten after every agent turn.”、Next steps “Your likely next message, one tap away.”、Ideas “Follow-ups the agent found, yours to decide.”
- 三列下面是设置：
  - 一个设置组（不带说明）：**Progress model**（Summary model：Provider，默认 Auto；选了 Provider 后出现 Model；与 Settings → Models 同一设置、同一组件）和 **AI output language**（`ai-language`，默认 “Same as interface language”）；
  - Progress model 一行的说明是成本预估（§3.3）。
  - 分组 **Also in sessions outside Flowly**，组说明即成本（D2）：“For sessions Flowly doesn't manage, the summary model runs once after each of their turns and reads the recent conversation (sent to that model's provider).”，后接成本预估（§3.3），三行开关 Progress / Next steps / Ideas（默认开），对应 `outsideProgress` / `outsideNextMoves` / `outsideIdeas`。

### 第 3 页：Project memory（高级）

- 导语 “Later cards start knowing what earlier ones learned.”
- （2026-10-22 用户反馈“memory 这边样式乱七八糟，重设计”：原来两张高矮不一的卡片并排，状态混在一起。）改为和第 2 页同样的**一个完整案例**（`MemoryDemo`）：左边 **Project memory**，右边 **A later card's session**，同一套框和控制行。
  1. 开始时左边是完成卡片复盘建议的一条坑（真实 `MemoryCard`，“Suggested by the finished-card review”）：“Never open a dialog in the frame another one closes.” / “It freezes Paseo. Open the next one after the first has finished closing.”，下面是来源行 “From ✓ Fix Settings freeze · Done”（真实 `SourceLine`）。右边空着：“A later card starts once you confirm.” 提示 “Try it: Confirm shares it with the project's later cards.”
  2. **Confirm**：卡片变成已确认（“Not used yet”）；约 0.9 秒后右边一张后来的卡片开始：一行 “Started with 1 project memory”、你的请求 “Add a Jira connection dialog to Settings.”、思考与工具调用逐步出现、回复说明因为项目记忆而等设置关完再开对话框。左边卡片变成 “Used 1m ago · 1 card”。
  3. **Dismiss**：左边 “Dismissed. No later card will see it.”，右边 “Later cards start without it.”
  - 自动演示同第 2 页：约 1.5 秒后在 **Confirm** 按钮上描边 0.7 秒再按（`MemoryCard` 的可选 `cueConfirm`），后面的会话自己跑完，4 秒后重新开始；自己按 Confirm / Dismiss 就接管；Reduce Motion 默认暂停。判断是纯函数 `memoryAutoStep`（有单测）。
- 框下面一行三列说明：Agents suggest “Agents, and a review of each finished card, propose what is worth keeping.”、You confirm “Nothing reaches a session until you confirm it.”、Later cards use it “New sessions on the project start with what you confirmed.”
- 开关组放在导语下面、演示上面（2026-10-22 用户反馈“三四页两个功能开关放在最上面”）。开关 **Project memory**（默认开）。子项 **Find memories in finished cards**（`retroEnabled`，默认开；Memory 关时禁用），说明是成本预估（§3.3）。导览里不显示其他详细说明，Settings 里照旧。

### 第 4 页：Insights（高级）

- 导语 “See where your attention and time go.”
- 开关组放在导语下面（2026-10-22 用户反馈）。开关 **Insights**（默认开）。子项：
  - **Daily digest**（`digestEnabled`，默认开；Insights 关时禁用）；
  - **Workflow insights**（默认**关**，保持 WORKFLOW-INSIGHTS-SPEC 的决定：花 token 且记录命令日志）；打开后模型和频率仍在 Settings 里调，这里只给开关和一句说明。
- 下面是同样的框：提示 “Sample numbers from a project's Insights page.”，框内 “Attention per card” 三行指标（Interventions、Review rounds、Questions from the agent，带示例数字和备注）；框下三列逐项解释这三个指标。

### 第 5 页：Ready when you are

保留现有清单和 **Create project** / **Not now**（或 **Done**）。原第 2 页 “What makes it different” 的内容拆开：Needs you 在第 1 页讲；Run summaries、Next steps 移到第 2 页；其余（Workpad、Inputs and outputs、Tickets…、Tags、Saved with your project）放进本页的 **More features**（2026-10-22 用户反馈：不折叠，直接列出）。底部提示改为 “Change any of this later in Settings, the gear at the top of the board. You can reopen this tour there.”（Ruling (Noah, 2026-11-09)：设置按钮移到看板顶部工具栏铃铛旁边）

## 4. 设置何时写入

- **语言、Summary model、Memory、Insights 及其子项**：在导览里改了就立刻存（与 Settings 页相同的读写方式），首次和手动打开都一样。它们的默认值本来就是“开”，所以没碰过就等于默认。
- **外部 session 三个子开关**（D3）：
  - 首次导览（自动弹出的那次）：显示为本地草稿，初始全开；导览**以任何方式关闭**（Skip、Esc、点遮罩、Done、Create project）时，与 `welcomeSeen=true` 一起写入：`outsideProgress/NextMoves/Ideas = 草稿`，`outside = 三者任一为开`。关闭前任何时刻都未写入，所以中途退出 app 不会生效，下次空看板时导览会再弹。
  - 手动打开（Settings、帮助图标、空看板链接）：显示存储值（`outside && outsideX`），改了立刻存，`outside` 同样取三者之一。手动打开的 Skip 不写任何东西。
- Skip 只是关闭；用户在 Skip 前改过的项保留其选择（D5 的“默认配置”指没改过的项）。

## 5. 设置入口高亮（D6）

- 新的一次性提示 id `settings-entry`。导览关闭后（首次或手动），若未看过，看板顶部工具栏里铃铛旁的设置齿轮加主题强调色描边，并在它下方（右对齐）显示一个小气泡（Ruling (Noah, 2026-11-09)：原左下角浮动按钮 `SettingsFab` 已移除，停靠栏会盖住那个角落）：“Turn features on or off and change settings here.” + **Got it**。
- 点 Got it 或点设置按钮都记为看过，高亮消失。不和其他 tip 横幅同时出现（它优先），不挡输入，Reduce Motion 下无动画；开启时一次轻微的放大提示，不循环。
- 位置固定在 FAB 旁（FAB 是插件自己画的、位置固定），不测量宿主 UI，因此不是 ONBOARDING-SPEC “Not in scope” 里排除的那种脆弱的 coach mark。
- 气泡打开设置时遵守“两个 Modal 不同帧切换”：导览关闭后等约 450 ms 再显示气泡（它不是 Modal，但避免与关闭动画重叠）。

## 6. 数据与行为契约

- 新 host 设置 `features`（`shared/settings.ts`）：`{ memory: boolean = true, insights: boolean = true }`，经 `featureSettingsValues()` 读取。
  - **memory=false**：所有项目视同 `Project.memory === false`（PROJECT-MEMORY-SPEC §9）：不注入、`flowly_remember` 返回 `MEMORY_DISABLED`、不复盘、Memory 页只读；项目自己的开关保留。daemon 的 `memoryOn(project)` 增加 host 条件。
  - **insights=false**：隐藏 Insights 入口（项目菜单、概览栏），不生成 daily digest，不跑 Workflow insights，相关 tip（`insights-redesign`、`first-workflow-insight`）不出。flow 事件照常记录（便宜，且重新打开时历史还在）。
- `native-session` 设置结构不变；默认值仍是 `outside=false`（D3：未完成导览的人保持关），由首次导览写入开。
- `onboarding` 设置结构不变；`settings-entry` 进 `tipIds`。
- Settings → AI features：新增 **Project memory** 开关组（把 “Find memories in finished cards” 移到其下）和 **Insights** 开关组（把 “Daily digest” 和 Workflow insights 组移到其下）。其余开关不动（D8）。
- 纯逻辑放 `client/onboarding-logic.ts`：页数、`outsidePatch(draft)`（草稿 → native-session 补丁）、`settingsHint` 判定；`client/onboarding-logic.test.ts` 补测试。daemon 侧 `memoryOn`、digest 门控补单测。

## 7. 约束

- 只用 RN 组件、主题色、`Icon`；示意图是普通 View，不引入图片、不加大启动包。
- 所有新文案 `t()`，模块级表用 `msg()`，加进全部 9 个语言目录。
- 下拉复用 `SettingSelect` / `SettingSwitch`（`client/settings-ui.tsx`）和 Summary model 组件，不写裸 `TextInput`。
- 导览只在要显示时挂载；Summary model 的 provider/model 列表只在第 2 页显示时查询。
- AGENTS.md “Onboarding upkeep” 中对导览结构的描述（concept map, loop, feature list）同步为新页面结构。

## 8. 文档同步

ONBOARDING-SPEC §2/§4/§5（页面、入口、tip 表）、NATIVE-SESSION-SPEC §12.6（默认由导览写入）、PROJECT-MEMORY-SPEC §9 与 INSIGHTS-REDESIGN-SPEC（全局开关）、README / README.zh-CN highlights、AGENTS.md Onboarding upkeep、PROGRESS.md。

## 9. 验收

- 单元：`outsidePatch`（全开、全关、部分）、首次关闭才写入、手动打开 Skip 不写；`settings-entry` 只出一次且优先；`memoryOn` 受 host 开关；digest 在 insights 关时不生成；i18n 完整。
- `npm run typecheck`、`npm test` 通过。
- 真实界面（重载插件，非全屏窗口，`docs/promo/shot-lib.mjs` 截图，桌面 + 窄屏，深浅色）：清空 onboarding 设置后，空看板弹出 5 页导览；切换界面语言当场生效；Skip 后外部 session 三项为开；改动 Memory/Insights 开关后 Settings 里同步；关闭后设置按钮高亮、Got it 后消失；有项目的老用户不弹。测试结束恢复原设置。证据存 `docs/verification/`。

## 10. 我做的决定（可推翻）

1. 概念页仍在最前，基础能力在第 2 页（见 §3 第 1 页说明）。
2. Memory 用新的全局开关实现（导览时还没有项目），项目开关保留。
3. Insights 关闭 = 隐藏入口 + 不跑 digest / Workflow insights，但继续记录 flow 事件。
4. Workflow insights 在导览里仍默认关。
5. 外部 session 用三个子开关（每个基础能力一个），而不是一个总开关。
6. 原 “What makes it different” 页取消，内容分到第 1、2、5 页。

## 11. 实现与验证（2026-10-22）

- 代码：`shared/settings.ts`（`features`）、`server/memory.ts`（`setMemoryEverywhere`）、`index.server.ts`（设置订阅、digest 与 Workflow insights 门控）、`client/onboarding.tsx`（5 页、草稿与关闭时写入）、`client/onboarding-logic.ts`（`outsidePatch` / `outsideShown` / `settingsHintDue`）、`client/onboarding-state.ts`（原 `useOnboarding`，拆出以免与设置页循环引用）、`client/stored-settings.ts`（原 `useStored`，加 `saveSure`）、`client/settings-pages.tsx`（共享行与 Memory / Insights 组）、`client/summary-settings.tsx`（设置按钮的提示气泡）、`client/board.tsx`、`client/overview-bar.tsx`，9 个语言目录（新增 26 条，删去 15 条旧导览文案）。
- 通过：`npm run typecheck`；`npm test`（含 `client/onboarding-logic.test.ts` 新增 9 条、`server/memory.test.ts` 新增 1 条、i18n 完整性）。
- 真实界面（`docs/promo/shot-lib.mjs`，无头 Chromium 连本机 daemon，Tinylink 项目，未操作用户窗口）：手动打开导览的 5 页，浅色与深色；关闭后设置按钮描边与气泡（修正了 “Got it” 被截断）。截图在 `docs/verification/onboarding-setup-2026-10-22/`。只看不改：没有拨动任何开关、没有点 Got it，用户设置未变。
- 顺手修正：最后一页 **Create project** 原来在导览关闭的同一帧打开项目表单（另一个 Modal，项目记忆里记录过的卡死模式），现在延迟约 450 ms 再打开，设置提示气泡与表单同一次更新、等表单关掉后才出现。
- 2026-10-22 13:09：按用户要求把当前工作树（HEAD 4a332b7 + 未提交改动，typecheck 与 932 个测试通过）装到 Coder 主机 `coder.Bofan.main`（Paseo 0.12.0，`/root/flowly-test/flowly`，`paseo plugin install … --id flowly`，运行中）。该主机此前没有 Flowly 设置和看板，是真正的首次状态，由用户手动做首次导览测试。
- 2026-10-22 15:14：用户在 coder.Bofan.main 上做完第一次首次导览后，那台主机的设置是：`native-session` = `{outside: true, outsideProgress: true, outsideNextMoves: true, outsideIdeas: true}`，`onboarding` = `{welcomeSeen: true, tipsSeen: ["settings-entry"]}`，即首次导览关闭时按默认把外部 session 三项写成开、设置入口提示已看过，符合 §4/§5。随后按用户要求备份并清空：设置与插件数据移到 `/root/flowly-test/backup-20261022-151401/`（`plugin-settings-flowly`、`plugin-data-flowly`、旧源码 `source-flowly`），装入当前工作树（版式统一与 Attention 改版后的版本），插件运行中，主机回到首次状态。
- 2026-10-22 15:40：按用户反馈换成真实组件、精简文字、加键盘导航（§3.1、§3.2）。typecheck 与 936 个测试通过（`tourKey` 新增 4 条单测）；本机重载后用 shot-lib 以回车逐页翻完 5 页，浅色、深色、中文三套截图在 `docs/verification/onboarding-setup-2026-10-22/`；← / → 实测可来回翻页。
- 2026-10-22 15:43：第二轮首次导览测试后那台主机的设置同样是 `native-session` 三项与 `outside` 全开、`onboarding.welcomeSeen=true`、`tipsSeen=["settings-entry"]`。备份到 `/root/flowly-test/backup-20261022-154339/` 后清空，装入真实组件 + 键盘导航版（工作树 HEAD fa9dede，含另一张卡未完成的 What's new 改动），插件运行中，主机回到首次状态。
- 2026-10-22 16:05：按用户反馈把 Attention 改成可操作的通知入口 + 下拉，Progress 改用 Progress 卡片，三个核心能力改成可交互演示（§3 第 1、2 页、§3.1）。typecheck 与 944 个测试通过（新增 19 条文案进 9 个目录，删 3 条旧文案）。本机重载后用 shot-lib 实际点击：Attention 打开/忽略两行后计数 4→2、全部处理后空状态与 Start over 复原；End turn 后 “Updating…” 再换成第二版进展；点 Run tests 填入消息框、发送后进入下一轮（All 132 tests pass，新建议 Push / Open a PR）；Good idea 后出现 Todo 里的跟进卡片。浅色、深色、中文截图（`light-p1/p2`、`dark-p1/p2`、`zh-p1/p2` 已替换，交互过程为 `live-light-p1-*`、`live-light-p2-step*`），无页面错误。
- 2026-10-22 16:10：第三轮首次导览测试后那台主机的设置：`native-session` 的 `outside` 与三项仍全开；`onboarding` 为 `welcomeSeen=true`、`tipsSeen=["settings-entry"]`、`whatsNewSeen="1.5.0"`（What's new 卡给新用户直接记为已看，符合 WHATS-NEW-SPEC）。备份到 `/root/flowly-test/backup-20261022-160949/` 后清空，装入可交互演示版（工作树 HEAD fa9dede + 未提交改动，typecheck 通过），插件运行中、日志无错误，主机回到首次状态。
- 2026-10-22 16:25：按用户反馈把第 2 页三列演示合成一个完整案例（上文）。typecheck 与 946 个测试通过（新增 7 条文案、删 7 条）。本机重载后用 shot-lib 实际走完：Run tests 填入 → 发送 → 回复与 Updating… → 新进展、新建议和想法 → Good idea 生成 Todo 任务 → Start over 回到开始；浅色、深色、中文无页面错误。截图 `light/dark/zh-p2.png` 与 `loop-light-*`、`loop-zh-*`。
- 2026-10-22 16:50：第四轮首次导览测试后那台主机的设置：`native-session` 的 `outside` 与三项仍全开；`onboarding` 为 `welcomeSeen=true`、`whatsNewSeen="1.5.0"`，`tipsSeen=[]`（这次设置按钮提示没有被记为已看：只有点 Got it 或点设置按钮才会记，用户这轮可能没点）。备份到 `/root/flowly-test/backup-20261022-165006/` 后清空，装入完整案例版（HEAD 05de169 + 未提交改动，typecheck 通过），插件运行中，主机回到首次状态。
- 2026-10-22 17:08：按用户反馈把 Session 一侧做成真实的会话对话（上文）：`client/session-transcript.tsx` 导出 `TranscriptEntry`、`ActivityBlock` 供导览使用（行为不变）。typecheck 与 946 个测试通过（新增 6 条文案、删 3 条）；本机重载后用 shot-lib 走完整个案例，浅色、深色、中文无页面错误，截图已更新（`*-p2.png`、`loop-*`）。
- 2026-10-22 17:22：加自动演示（上文）。typecheck 与 949 个测试通过（`loopAutoStep` 新增 3 条单测，新增 3 条文案）。本机重载后用 shot-lib 不操作、按时间截图：选 Run tests 的描边 → 填入 → 发送的描边 → Working → 想法 → Good idea 的描边 → Todo 任务 → 约 13.5 秒时已重新开始；之后自己点 Run tests，2.5 秒后仍停在已填入状态、按钮变为 Play；模拟 Reduce Motion 打开该页 3.5 秒仍未自动操作。截图 `auto-*`。
- 2026-10-22 19:45：第 5 页 More features 改为直接展开；第 3 页记忆示例去掉正文、左栏加宽到 400、框高 290，左栏可滚动（Edit 打开编辑器时能滚到 Save and confirm），按 Edit 停止自动演示；修正手动 Save and confirm 后编辑器不关闭（包装函数丢了 confirm 的返回值）。954 个测试通过；shot-lib 重跑第 3 页编辑与保存、记忆页三语言、翻页，均无页面错误。
- 2026-10-22 18:25：统一 5 页版式（§3.1）：第 2 页演示高 520 → 360 并加 “Settings below” 胶囊；第 3、4 页开关组移到最上面；第 1 页 Attention、第 4 页 Insights 示例放进和第 2、3 页同样的框，下面各有三列说明；记忆演示框高 300。typecheck 与 954 个测试通过（新增 11 条文案、删 1 条）。重载后 shot-lib：5 页顶部与滚到底各一张（`layout-*`），第 2 页自动演示 / 接管 / Reduce Motion、记忆页三种语言与手动路径、回车与 ←/→ 翻页，均无页面错误。
- 2026-10-22 17:58：按用户反馈重设计第 3 页（Project memory 的完整案例与自动演示，见上）并给 AI 功能加成本预估（§3.3）。typecheck 与 954 个测试通过（`ai-cost` 3 条、`memoryAutoStep` 1 条、`modelLabel` 1 条新单测；新增 26 条文案、删 2 条）。本机重载后 shot-lib：浅色、深色、中文自动演示（Confirm 描边 → 已确认 → 后来的卡片会话 → “Used 1m ago · 1 card”），手动 Dismiss 与手动 Confirm，均无页面错误；第 2 页 Progress model 与外部 session、第 3 页复盘开关、第 4 页日报与 Workflow insights 都显示预估。截图 `memory-*`。
- 2026-10-22 17:33：按用户反馈让 Progress 卡片和真实一致：补上 Target（整张卡不变的目标）和每版的 Recap，脚注带模型名（“Updated … · Haiku 5.5”，同 `task-progress.tsx`）。真实卡片超过约 5 行会收起，导览里用 `ContentCard` 新的可选 `defaultOpen` 一开始就展开（别处不传，行为不变）；Card 一栏加宽到 340 并可滚动，想法出现时滚到底，Good idea 不被挤出视野。typecheck 与 949 个测试通过（新增 4 条文案）；重跑自动演示与中文手动截图，无页面错误。
- 2026-10-22 17:29：按用户反馈把描边从整条建议、整张想法卡片收窄到具体的 Run tests 建议和 Good idea 按钮。typecheck 与 949 个测试通过；本机重载后重跑自动演示截图（`auto-b-cue-move`、`auto-g2-cue-idea`），接管与 Reduce Motion 行为不变。
- **未运行**：首次导览（空看板新用户）的真实界面路径与 Skip 后的写入——需要清空设置和看板的 fixture 宿主，本机看板有项目会被静默标记为老用户；由单元测试覆盖写入逻辑。窄屏截图被宿主 Modal 跨侧栏居中裁切，未作为证据。手机未测。Luna 测试 session 未运行。
