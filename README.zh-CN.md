<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/flowly-lockup-dark.svg">
    <img src="docs/brand/logo/flowly-lockup-light.svg" alt="Flowly" height="56">
  </picture>
</h1>

**Flowly**——给 Paseo 的 agent 原生工作流。

[English](README.md) · **简体中文**

**Flowly 是一个 Paseo 插件：把 agent session 变成会自己运转的工作流，看板是它的界面。** 你只管派活、拍板、验收；进度、提醒、总结、后续想法和数据复盘由看板自动维护。

> 插件 ID `flowly` · 需要 Paseo `>=0.11.2` · 支持桌面、平板和手机客户端。

![看板：卡片随 agent 工作在 Design、Development、Test、In review 之间流转](docs/promo/screenshots/01-board-auto-status.png)

<details>
<summary>深色主题</summary>

![看板（深色）](docs/promo/screenshots/01-board-auto-status-dark.png)

</details>

## 安装

```sh
paseo plugin add jasprw/flowly
```

这会安装 [Paseo 插件库](https://paseo.sh/plugins) 里审核通过的版本。也发布到了 npm，包名 [`paseo-flowly`](https://www.npmjs.com/package/paseo-flowly)（`paseo plugin add npm:paseo-flowly`）。想直接从 Git 安装最新的 `main`，用 `paseo plugin add git:JasprW/flowly`。

在 Paseo 侧边栏打开 **Flowly**。daemon 所在机器的 PATH 里需要有 `paseo` CLI，用于注册新的原生 project。

## 主要功能

### 1. 自动状态流转

从卡片启动 session 后，卡片会跟着工作走：**Design → Development → Test → In review → Committed → Integrated**。agent 通过受限的 Kanban 工具设置自己所处的阶段，按你的要求提交卡片的改动后把卡片移到 Committed，这些提交进入主 checkout 的分支后移到 Integrated；session 开始或恢复一轮时，daemon 也会移动卡片。回合结束**不会**把卡片设为 Done，Done 和 Cancelled 永远由你决定。卡片上显示运行中、已结束回合、未读、需关注的 session 数量，以及最近一条 agent 输出。

可在 *Settings → Workflow → Moving cards* 全局关闭，也可以按项目关闭。

### 2. 人工介入提醒

agent 需要你拍板时，会提出一个明确的问题并停下。卡片亮起 **Needs you**，顶部 **Attention** 菜单和侧边栏角标都会计数，点 **Reply** 直达对应 session。授权请求和报错也以同样方式提示。一时拿不定主意时，可以把卡片从 Attention 中 **Dismiss**：计数随之减少，卡片上的提示照常显示，一有新情况就会自动回来。

回合结束时，agent 可以在 session 输入框上方留下**建议的下一步**（如“用 Luna 验证”“提交并推送”）。点一下只会把内容填进输入框，由你修改或自行发送。工作提交并推送后，agent 还可以给出 **Move to Done**：它不填输入框，点击即移动卡片（Done 仍由你决定）。你发出下一条消息、开始新一轮后，这些建议就会消失。

![会话输入框上方的下一步建议：Verify with Luna、Commit and push、Add 429 tests](docs/promo/screenshots/06-next-moves.png)

![卡片上 agent 的提问与 Reply 按钮](docs/promo/screenshots/02-needs-you-drawer.png)

### 3. 任务运行 summary

每轮成功结束后，一个低成本模型（默认 Haiku 5.5，可配置）会更新卡片的 **状态 / 目标 / 已完成 / 下一步**。历史版本全部保留，卡片 Done 之后仍能回看当时做到哪一步。summary 不会改变卡片状态。

![卡片 summary：状态、目标、已完成、下一步](docs/promo/screenshots/03-card-summary.png)

agent 还会在卡片上维护一份 **Workpad**：验收标准、它跑的验证项（通过、失败或未运行，各自标明在哪个 commit 上跑、用的什么命令），以及卡片里让它困惑的地方。计划直接取自 agent 自己的待办列表。卡片上显示 **验证 3/5**；在比当前 HEAD 更旧的 commit 上跑的验证会标为*已过期*。你也可以自己勾选验收标准、改验证状态。agent 开工前会先设好卡片的类型和标签并写好 Workpad；没设好之前，每次调用 Flowly 工具的结果都会提醒它。带着未完成项、或缺类型/标签/Workpad 交付到 In review 时，agent 必须明确确认并附上说明；有未完成项时卡片随后标出 **交付时 N 项未完成**。可在项目设置的 *Card workpad* 里按项目关闭。

### 4. 任务延伸 ideas

agent 工作时发现的后续事项（顺带发现的 bug、现有方案的局限、下一步）会进入项目的 **Ideas** 收件箱，而不是淹没在对话里。点 **Good idea** 有两条路：在原 session 里继续，或者带着预填好的上下文新建卡片 / 新开 session；**Dismiss** 则忽略。agent 不会自己建卡或开工。

![Ideas 收件箱，标明来源卡片](docs/promo/screenshots/04-ideas-inbox.png)
![Good idea：新建任务、在原 session 继续，或开新 session](docs/promo/screenshots/04b-good-idea-two-paths.png)

需要比卡片活得更久的东西进入**项目记忆**：你做的决策（包括否决的方案）、踩过的坑和走不通的路、你希望怎么做事，以及相关的人和系统。agent 用 `flowly_remember` 提出候选；卡片移入 Done 时，一个便宜的模型还会复盘它，最多再提 1 条，而且只提跨卡通用的。所有条目都要你在项目的 **Memory** 页（快捷键 `M`）确认后才生效。确认过的条目会进入这个项目新 session 的初始指令（放得下就全部给，放不下就给置顶的和最相关的，其余由 agent 用 `flowly_recall` 查）。每条都可以修改、置顶、归档或删除，也可以复制成 `AGENTS.md` 规则；可以按项目关闭。记忆只存在本机，不进仓库。

**搜索**（快捷键 `S` 或搜索按钮）查找过去的卡片：标题、摘要、进度说明、Workpad、想法和交付物，粘贴 PR 链接或 Jira 编号就能找到对应的卡。可以搜当前项目或全部项目，完全在本机进行。agent 开始做某个方向时也能用 `flowly_search` 查同样的历史。

### 5. 输入与产出

每张卡有一个 **Artifacts** 列表：它依据的文档、链接（输入）和产出的交付物（输出）。agent 工作时通过看板工具登记，你也可以在卡片上添加、编辑或删除自己的条目。只保存引用，文件留在原处，以只读预览打开。每条都标明是你还是 agent 添加的，agent 不能删除你添加的条目。

**工单、文档和 PR** 也可以作为输入：Jira 工单、Confluence 页面，GitHub、GitLab 的 issue、pull request 和 merge request，以及 Azure DevOps 工作项。在 Settings → Connections 连接服务（自建或云服务，使用个人访问令牌或 API token），然后用 **From Jira / From GitLab / …** 新建卡片，或用卡片 Artifacts 里唯一的 **+** 添加条目。选择器列出你最近的条目（指派给你的、等你审查的、你编辑过的页面），可按编号、链接、数字或标题关键词搜索；GitHub 和 GitLab 会先搜索项目自己的仓库（从 git remote 识别）。agent 用 `flowly_read_external` 读取条目（描述或页面内容、评论，PR/MR 还有分支、head commit 和改动文件名），并能发现条目的变化。Flowly 只读：不评论、不 approve、不合并、不修改任何内容，条目状态也不会移动卡片。令牌只保存在 daemon 所在机器上。

agent 理解任务后会自己补全卡片元数据：卡片没有**任务类型**时设置类型（feature、bugfix、research、refactor、docs、chore），不会覆盖你已选的类型；同时添加描述所涉模块和方向的**标签**（`drawer`、`performance`、`a11y`），与固定的任务类型分开。agent 会复用项目已有标签而不是另造同义词；你可在卡片或表单里添加、删除标签。可按标签筛选看板，或搜索 `#tag`（`#module/` 匹配前缀）。agent 不能删除你添加的标签。

### 6. Project insights

Insights 用 GitHub 式的热力图显示项目一年的活跃度：每天一格，agent 轮次越多颜色越深，不显示总数和连续天数。点某一天或用箭头左右翻页，可以看那天的 AI 总结（过去的日子第一次打开时生成）、轮次、agent 用时和 token，以及那天的卡片，每张卡下面一条横条表示它占了当天多少。下面是 **Skills**，把 agent 反复在做的事沉淀成项目 skill（见下文）；其它建议（脚本、仓库工具、AGENTS.md 规则）默认收起，再下面是最近 7 天的来回轮数、一次通过率、每卡 token（按模型）。

![Project insights：一年活跃度、选中那一天的总结和 Skills](docs/promo/screenshots/05-insights.png)

<details>
<summary>深色主题</summary>

![Project insights（深色）](docs/promo/screenshots/05-insights-dark.png)

</details>


**Skills**（默认开启，可在欢迎导览或 设置 → AI 功能 里关闭）：每周由你选的模型阅读项目的卡片（总结、验收条目、项目记忆记下的你的纠正）、确认过的记忆和 agent 执行过的 shell 命令（已脱敏），写出完整的 skill 草稿：agent 每次做法都不一样的流程（例如走 PR 合入、等评审），或同一类卡积累下来的经验（例如插件性能优化）。点 **加入项目** 会写入 `.agents/skills/<name>/SKILL.md`（Codex 读取），并在 `.claude/skills/<name>` 建软链接（Claude Code 读取），不会替你提交。之后的运行会对 Flowly 加入的 skill 提出更新，以 diff 显示。同一次运行仍会建议 `paseo.json` 脚本、worktree setup、仓库工具和 AGENTS.md 规则，每条一键生成卡片。每次运行替换没人处理的草稿；没有新活动的周期直接跳过，不调用模型；第一次定时运行要等满一个周期。agent 的任务上下文会列出项目 `paseo.json` 中的脚本。

## 界面语言

界面默认跟随设备语言，也可以在 **Flowly 设置 → 语言** 中手动选择：English、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português (Brasil)、Русский。智能体指令、守护进程的错误详情，以及智能体和摘要所写的内容不会被翻译。

| 日本語 | Deutsch |
| --- | --- |
| ![日语界面的看板](docs/promo/screenshots/i18n/ja-JP-board.png) | ![德语界面的看板](docs/promo/screenshots/i18n/de-DE-board.png) |

## 快速上手

第一次打开 Flowly 时，一个简短的欢迎导览会讲清 project、卡片和 session，并完成基础设置：界面语言和 AI 输出语言、进展模型、进展 / 下一步 / 想法是否也用于 Flowly 之外的 session（默认开；这些 session 每完成一轮会运行一次摘要模型），以及项目记忆和 Insights 是否开启。Skip 即保留默认值。之后可以在左下角的齿轮里随时修改。

1. **New project**：选择一个目录（或多个仓库），把它注册为原生 Paseo project。
2. **New task**（或 **Q**）：说出要做的事并按 Enter。快速任务会创建卡片、在新的 worktree 中启动 agent，并由摘要模型命名；**More options…** 打开完整表单（状态、优先级、类型、标签、workspace、输入）。
3. 看卡片自己移动。回答 **Needs you** 的问题，验收 **In review** 的卡片，处理 **Ideas**，一天结束时打开 **Insights**。

## 工作方式

- **一个看板 project 对应一个原生 Paseo project 根目录。** 要跨多个仓库工作，可以把它们放进同一个父目录并注册该目录；也可以让插件建一个“链接根目录”，里面为每个仓库放一个软链接（移除链接不会动目标目录）。
- **一张卡对应一个 workspace**，workspace 里可以有多个 session。由你选择哪个 session 接收指令；普通追问只发送你输入的原文。
- **Agent 工具。** 从卡片创建的 session 会获得受限 MCP 工具：`flowly_get_task`、`flowly_update_status`、`flowly_report_progress`、`flowly_propose_idea`、`flowly_suggest_next_moves`、`flowly_set_tags`、`flowly_set_type`、`flowly_add_artifact`、`flowly_remove_artifact`、`flowly_update_workpad`、`flowly_handover`、`flowly_integrate`、`flowly_search` 和 `flowly_read_external`（`flowly_read_ticket` 作为旧 session 的别名保留），以及说明它们用法的 `flowly` skill。agent 可以在工作阶段之间和 In review 之间移动自己的卡片；Done 与 Cancelled 由人决定。交付或提问的那次调用（`flowly_update_status`、`flowly_report_progress`）还可以带上 `nextMoves`，即显示在输入框上方的建议下一步；没有需要用户做的事就传 `[]`。没有 MCP 的 session 可使用 CLI 兜底。
- **卡片业务状态与 session 执行状态相互独立。** 一轮结束不代表卡片完成。
- **其他能力：** 拖拽（含列内排序）、卡片关联（follow-up、blocks、related）、任务类型与优先级、Done 卡片收尾（预检后归档其 session 和自有 workspace）、卡片在主检出目录与独立 worktree 之间切换（全部复制、精简、从主检出移出、集成）、键盘快捷键（`?`）、按卡片统计 token、手机紧凑布局，以及在 *设置 → 卡片* 中自选看板卡片显示哪些信息（带实时预览）。

### 模型

在 **设置 → Models** 里选择新会话默认使用的模型。每个 project 可以在自己的设置里单独指定，优先于全局；两者都没设时，新会话沿用最近一个会话的设置。

设置 → 模型可选择多个摘要模型，通过上移/下移调整自动回退优先级，默认仍是 Haiku → Luna。

![设置 → Models：默认模型和摘要模型](docs/promo/screenshots/settings/models.png)

### 数据与安全

看板数据存放在 daemon 所在机器的 `~/.paseo/plugin-data/flowly/`（`PASEO_HOME` 可指定 daemon 主目录）：Paseo 支持时存在本地 SQLite 数据库 `flowly.sqlite` 里，否则存在 `board.json`。*Settings → Storage* 显示存放位置，每天备份一次（保留最近 7 份），可恢复备份或把看板导出为 JSON。写入串行化并原子替换，过期编辑会被拒绝，无效文件会被保留而不是重置。移除或永久删除 project / 卡片前会先备份到 `removed/`。归档插件记录不会删除 Paseo 资源或磁盘目录。工具服务只监听本机回环地址，每个 session 使用独立的私有凭据。

### 遥测

daemon 每天向 PostHog（US 区）发送一次匿名使用数据：Flowly 版本、操作系统和 Node 版本、界面语言、开启了哪些功能、大致的项目数和卡片数，以及自上次以来新建的卡片、agent 回合、交付、下一步建议、ideas 和 memory 的次数和用到的模型。Flowly 的 daemon 出错时，还会发送错误的类型、错误码，以及出错位置在 Flowly 自身代码的哪个文件哪一行，同一种错误每天最多一次。不会发送错误消息、标题、描述、消息、你的路径（只发 Flowly 自身代码里的文件路径）、仓库名，也不会发送项目、卡片或 session 的 ID，不做基于 IP 的定位。可以在 设置 → General → *Send anonymous usage data* 关闭，或给 Paseo daemon 设置 `DO_NOT_TRACK=1`（或 `FLOWLY_TELEMETRY=0`）。具体发送哪些字段见 [`server/telemetry.ts`](server/telemetry.ts) 和 [docs/TELEMETRY-SPEC.md](docs/TELEMETRY-SPEC.md)。

## 开发

从本地仓库运行（开发用）：

```sh
git clone https://github.com/JasprW/flowly.git && cd flowly
npm install
paseo plugin install "$PWD" --id flowly
paseo plugin reload flowly   # 之后有改动时重载
paseo plugin logs flowly
```

```sh
npm run typecheck
npm test
```

GitHub Actions 对 PR 和 main 运行 Node 22/24 的类型检查、测试和真实安装包验证。`make release VERSION=x.y.z` 检查已合入的版本并推送 annotated tag，tag 流水线通过 OIDC 发布已验证的 tarball 到 npm，并创建 GitHub Release；`DRY_RUN=1` 预览本地步骤。配置和恢复见 [CI/CD 文档](docs/CI-CD.md)。

新增或修改文案时，用 `t()` / `tn()` 包起来，并在 [`shared/i18n/`](shared/i18n/) 的每个语言文件里补上译文；`npm test` 会列出缺失项。详见 [`docs/I18N-SPEC.md`](docs/I18N-SPEC.md)。

根目录代码只有 `index.client.tsx` 和 `index.server.ts`；其余在 `client/`、`server/` 和与运行环境无关的 `shared/` 中。设计、spec 与验收记录都在 [`docs/`](docs/)：建议先读 [`SPEC-OUTLINE.md`](docs/SPEC-OUTLINE.md)、[`SINGLE-ROOT-SPEC.md`](docs/SINGLE-ROOT-SPEC.md) 和 [`PROGRESS.md`](docs/PROGRESS.md)。给贡献者和 agent 的项目规则见 [`AGENTS.md`](AGENTS.md)。发布与宣传材料（文案、演示项目脚本、截图脚本）在 [`docs/promo/`](docs/promo/README.md)。

## 许可证

[MIT](LICENSE) © 2026 Bofan Wang

另一个单独安装的 `paseo-kanban` 插件是不同的插件，本插件不会覆盖它。
