# 匿名使用数据（遥测）

Status: **已实现，待随 1.7.0 发布**（2026-10-26，卡片“遥测建设”；实现：`server/telemetry.ts`）。`POSTHOG_KEY` 已于 2026-10-26 填入 PostHog US 项目的 project token；常量为空时不发送。**本 fork（hevengo/flowly）2026-10-29 起永久关闭遥测：`POSTHOG_KEY` 为空（第 6 节）。** 用户决定：使用 PostHog Cloud（最初定为 EU 区；2026-10-26 维护者的项目建在 US 区，用户决定改用 US 入口）；由 daemon 直接调用 capture HTTP API，不引入 SDK；每天发送一次心跳；字段按白名单；默认开启、可以关闭；遵守 `DO_NOT_TRACK`。2026-10-26 补充决定：

- 用户被告知之前就可以发送，关闭之后不再发送；
- 设置里只放简要说明，不提供逐字段预览，具体内容以开源代码和本 spec 为准；
- 不提供重置 ID；
- 不做 IP 地理解析，i18n 需要的语言分布由 `ui_locale` 提供。
- 2026-11-10 追加（卡片“Posthog遥测补全”）：§4.3 新增 `c_user_actions`（区分“daemon 在跑”和“有人在用”）与 `c_reviews` / `c_reviews_failed`。不加 `$pageview`：PostHog Web analytics 的 Installation Health 检查按网站设计，Flowly 不在界面埋点（§1、§2），该检查的告警忽略即可。客户端平台仍按 §10 推迟。
- 2026-10-26 追加：上报 daemon 端遇到的错误，用单独的 `$exception` 事件，只带错误类型、安全的错误码、来源标签和 Flowly 自身代码的堆栈帧，不带错误消息和用户路径，每种错误每天最多一次（第 11 节）。客户端（界面）错误不上报。

## 1. 目的与反目标

Paseo 的插件注册表不提供安装或更新统计，npm 的下载量又混有 CI 和镜像，所以现在无法回答下面三个问题：

1. 有多少个安装还在用 Flowly，它们分别在哪个版本（新版本发布后，多快有人升级）；
2. 哪些功能被打开、被关掉；
3. 核心循环（建卡、agent 交付、Next moves、Ideas、Memory）实际用得多频繁。

本功能只回答这三个问题。

反目标：

- 逐个事件上报；
- 错误消息，以及 Flowly 自身代码以外的堆栈帧和路径（第 11 节只发类型、错误码和 Flowly 自身的帧）；
- 客户端（界面）埋点、session replay、feature flags；
- 任何能还原用户在做什么的内容（标题、描述、路径、仓库、对话、命令）；
- 按用户或团队识别身份；
- 用遥测数据驱动产品内的任何行为。

## 2. 总体形态

- **只有 daemon 发送**。客户端不发起任何网络请求，也不加任何依赖，所以冷启动约束不受影响（AGENTS.md 的 Cold start 一条）。
- **每天最多一个心跳事件** `flowly_heartbeat`，内容是第 4 节的白名单字段；另外只有第 11 节的 `$exception` 错误事件。不发送其他事件。
- **接收方**：PostHog Cloud US 区的一个项目，由维护者持有。项目设置里打开 *Discard client IP data*。
- **不用 SDK**：一次 `fetch` POST，超时 10 s，不重试队列，失败就等下一次检查（第 3 节）。
- 遥测失败**不影响任何功能**：不抛错，不弹提示，不写入看板数据。

## 3. 发送时机

### 3.1 前提条件（全部满足才发送）

1. 遥测开关为开（第 5 节），并且没有被环境变量强制关闭（第 6 节）；
2. 距离上次**成功**发送已超过 20 小时（`lastSentAt`）。用 20 小时而不是 24 小时，是为了在每天固定时间开机的情况下，不会被推迟到第二天。

发送不以用户是否已被告知为前提（用户决定 2026-10-26）。插件升级、或新用户第一次加载插件后，只要满足以上两条就开始发送。告知通过 What's new、导览和 README 完成（第 7 节）。

### 3.2 检查节奏

- daemon 启动（插件加载）后先等 **5 分钟**再做第一次检查，之后**每小时**检查一次。计时器要 `unref`，插件卸载或重载时清除。
- 一次检查最多尝试发送一次。HTTP 2xx 算成功，写入 `lastSentAt` 和计数窗口的终点（§4.4）。其他结果（网络错误、超时、非 2xx）只记一行 debug 日志，下一小时再试。
- 机器休眠、daemon 停止期间不会补发。恢复后第一次检查满足条件就发一条，覆盖整个空档（§4.4）。

### 3.3 本地状态

存放在 plugin-data 下的 `telemetry.json`（daemon 侧，原子写入，无效时保留原文件并当作首次处理）：

```json
{ "installId": "uuid-v4", "lastSentAt": "ISO 时间或空", "windowStart": "ISO 时间" }
```

- `installId` 在第一次需要发送时生成（`crypto.randomUUID()`），**不从机器信息派生**，之后不再更换。不提供重置入口（用户决定 2026-10-26）；删除 `telemetry.json` 会得到一个新 ID。
- 关掉遥测**不删除** `installId`。重新打开后沿用同一个 ID，避免重复计数。

## 4. 发送内容（白名单）

### 4.1 请求

```
POST https://us.i.posthog.com/i/v0/e/
Content-Type: application/json

{
  "api_key": "<PostHog 项目 key，phc_ 开头，只写不读，写在源码常量里>",
  "event": "flowly_heartbeat",
  "distinct_id": "<installId>",
  "timestamp": "<发送时间 ISO>",
  "properties": {
    "$process_person_profile": false,
    "$geoip_disable": true,
    ... 4.2 与 4.3 的字段
  }
}
```

- `$process_person_profile: false`：作为匿名事件处理，PostHog 不建 person profile。
- `$geoip_disable: true`：不做 IP 地理解析（用户决定 2026-10-26：做 i18n 时看界面实际使用的语言，即 §4.2 的 `ui_locale`，比按 IP 推断国家更准，也不会留下城市级位置）。
- 入口地址与项目所在区域必须一致：US 项目用 `us.i.posthog.com`，EU 项目用 `eu.i.posthog.com`。capture 接口对任何 token 都返回 200，区域或 token 是否正确，可以用 `POST https://<区域>.i.posthog.com/flags/?v=2` 检查：token 不对或区域不对时返回 `authentication_failed`。

### 4.2 环境与设置（每次都发）

| 字段 | 取值 | 说明 |
|---|---|---|
| `flowly_version` | `shared/version.ts` 的常量，测试保证它等于 `package.json` 的 version | |
| `paseo_version` | 心跳不发送；只随 `$exception` 发（11.3 节） | |
| `node_major` | `process.versions.node` 的主版本号，如 `24` | |
| `os` | `process.platform`：`darwin` / `linux` / `win32` / 其他原值 | |
| `arch` | `process.arch` | |
| `ui_language` | `language` 设置值（`auto` 或语言代码） | 用户是否手动选过语言 |
| `ui_locale` | 界面实际使用的语言代码：`language` 不是 `auto` 时取它；是 `auto` 时取 `device-language.locale`（最后打开的设备的语言）；两者都没有时发 `""` | 只取 `localeCodes` 中的值，其他值一律发 `""` |
| `ai_language` | `ai-language` 设置值 | |
| `f_memory` / `f_insights` | `features` 设置 | 布尔值 |
| `f_ideas` / `f_artifacts` | `ideas` 设置 | 布尔值 |
| `f_outside_sessions` | `native-session.outside` | 布尔值 |
| `f_auto_status` | `auto-status.autoStatus` | 布尔值 |
| `f_auto_wrapup` / `f_archive_on_delete` | `wrap-up` 设置 | 布尔值 |
| `f_workflow_insights` | `workflow-insights.enabled`，且 Insights 开着（Workflow insights 是 host 级开关，不是按项目） | 布尔值 |
| `f_summary` | `task-summary.summaryEnabled` | 布尔值 |
| `f_auto_review` | 是否有未归档项目开启了 Auto review（`project.autoReview.enabled`，AUTO-REVIEW-SPEC） | 布尔值 |
| `projects` | 未归档项目数，按 §4.5 分桶 | |
| `c_guardrails` | 未归档项目的 active 准则总数（`guardrails.json` 中 `kind: "guideline"`、`state: "active"`，GUARDRAILS-SPEC §10），按 §4.5 分桶；只有数字，不含文字 | 发送时的快照，不是窗口计数 |
| `cards_open` | 所有项目中未归档、且不在 Done/Cancelled 的卡片数，按 §4.5 分桶 | |

新增设置**不会**自动进入心跳。要加字段，必须先修改本节表格。

### 4.3 计数（窗口内）

窗口是 `[windowStart, 发送时刻)`。数据来自 `flow/<projectId>.jsonl`，不读 `board.json` 的事件（每卡只保留 100 条，见项目记忆里的这条坑），以及 `guardrails.json` 的备忘。所有项目的数字加在一起：

| 字段 | 统计的是 |
|---|---|
| `c_cards_created` | `created` 事件 |
| `c_turns` | `agent.turn_ended` 事件 |
| `c_deliveries` | 由 agent 发起、`to = in_review` 的 `status_changed` |
| `c_next_moves` | `next_moves_suggested` 中 moves 非空的次数 |
| `c_next_moves_picked` | 带 `pick` 的 `agent.turn_ended` |
| `c_ideas_proposed` / `c_ideas_accepted` / `c_ideas_dismissed` | `idea_proposed` / `idea_accepted` 与 `idea_adopted` / `idea_dismissed` |
| `c_memory_proposed` / `c_memory_confirmed` | `memory_proposed` 事件 / `guardrails.json` 中状态为 active、且在窗口内变为 active 的备忘（`stateAt`）。备忘写入即生效（GUARDRAILS-SPEC D2），所以它现在是窗口内新生效的备忘数，键名保留 |
| `c_wrapups` | `wrapped_up` |
| `c_reviews` / `c_reviews_failed` | 带 `results` 的 `review_finished` / 其中有 gating 项（`gating` 不为 `false`）`state = failed` 的次数（AUTO-REVIEW-SPEC） |
| `c_user_actions` | `actor = human` 的事件，加上 `byUser` 的 `agent.turn_ended`（用户发的消息）。`> 0` 表示这个安装在窗口内有人实际使用，是 DAU 的依据（§8） |
| `models` | `agent.turn_ended.model` 的计数表，例如 `{"claude/claude-sonnet-5-5": 12}` |

`models` 的限制：

- 键必须匹配 `^[a-z0-9._-]+/[a-zA-Z0-9._:-]+$`，不匹配的归入 `"other"`；
- 最多保留 10 个键，其余合并进 `"other"`。

### 4.4 窗口

- 第一次发送时，`windowStart` 取 `max(遥测开启时刻, 发送时刻 − 24 h)`。
- 成功发送后，`windowStart` 更新为这次的发送时刻。
- 空档超过 7 天时，只统计最近 7 天，并加字段 `window_days`（向上取整的天数）。没有空档的普通心跳不带这个字段。

### 4.5 分桶

数量一律按桶发送，不发精确值：`"0"`、`"1"`、`"2-5"`、`"6-20"`、`"21-100"`、`"100+"`。

窗口计数（§4.3）发送精确整数。单个计数上限为 10 000，超过的按 10 000 发送。

### 4.6 绝不发送

以下内容一律不发：

- 项目、卡片、session 的 ID、标题、描述、标签；
- 任何路径、仓库名或 remote、分支名；
- 消息、prompt、summary、命令、artifact；
- connector 的类型或地址；
- 主机名、用户名、邮箱、IP（客户端不发 IP；PostHog 项目设置丢弃 IP）、时区；
- 环境变量、token。

## 5. 设置

- 新增 host 设置 `telemetry`（`shared/settings.ts`）：`{ enabled: boolean, default true }`。
- 放在 **Settings → General**，单独一组 **Usage data**，只有一个开关 **Send anonymous usage data**。说明行（涉及隐私，所以按 UI 文案规则保留）只做简要说明，不逐项列字段：*Once a day: versions, which features are on and usage counts. On errors: where in Flowly's code. Never your content, paths or code.* 不提供逐字段预览（用户决定 2026-10-26：项目开源，发送内容以 `server/telemetry.ts` 和本 spec 为准，README 的 Telemetry 一节链接到这两处）。
- 被环境变量强制关闭时（第 6 节），开关显示为关、不可操作，说明行改为 *Turned off by DO_NOT_TRACK on this computer.* 客户端通过 RPC `telemetry.status`（返回 `{ forcedOff: boolean, builtOff: boolean }`，有 schema 校验）得知这个状态。
- 构建里没有 key（`builtOff`，第 6 节）时同样显示为关、不可操作，说明行是 *Turned off in this build.*，优先于上一条。
- 关闭后**立即生效**，从下一次检查开始不再发送任何东西，包括关闭这个动作本身。重新打开后照常发送。
- daemon 读设置时使用 `*Values()` 解析函数（存储的值可能缺字段）。

## 6. 环境变量

只在 **daemon 进程**的环境里生效（Paseo 启动 daemon 时继承的环境），任一条满足就强制关闭，并且优先于设置：

- `DO_NOT_TRACK` 非空且不等于 `0`（https://consoledonottrack.com 约定）；
- `FLOWLY_TELEMETRY=0`（或 `off` / `false`）。

**总开关**：`server/telemetry.ts` 的 `POSTHOG_KEY` 为空时，心跳和 `$exception` 都不发送，也不生成 `telemetry.json`，与设置和环境变量无关。本 fork（hevengo/flowly）2026-10-29 起保持为空（用户决定：永久关闭遥测，设置页显示为关、不可操作；README、OVERVIEW 和 What's new 1.7.0 的文字不改）。`server/telemetry.test.ts` 在 key 不为空时失败，从 upstream 合并时如果 key 回来了，要把它重新清空。

另外两种情况也一律不发，以免开发和测试的数据混进统计：

- `NODE_ENV=test`；
- 插件从本地路径安装（`paseo plugin install "$PWD"`）。插件服务端拿不到自己的安装来源，所以不做自动判断；AGENTS.md 的本地安装说明要求维护者给 daemon 设置 `FLOWLY_TELEMETRY=0`。

## 7. 告知

| 位置 | 内容 |
|---|---|
| What's new（引入遥测的那个版本，`client/whats-new.ts`） | 一条：*Flowly now sends anonymous usage data: once a day, versions, which features are on and usage counts; on errors, where in Flowly's code. Never your content, paths or code. You can turn it off in Settings.*，带 **Open settings** 按钮，打开 General |
| 首次导览最后一页 Ready when you are（`client/onboarding.tsx`） | 在 More features 下面放同一个开关（`UsageDataGroup`），文案同第 5 节，默认开。Built in 页讲的是每张卡都在跑的功能，遥测放在那里不合适 |
| README（英文、中文） | 新增 **Telemetry** 一节：几句话概括发送什么、不发送什么，关闭方法（设置或 `DO_NOT_TRACK=1`），数据存放地（PostHog US），并链接到本 spec 和 `server/telemetry.ts` |
| ONBOARDING-SPEC | 记录最后一页新增的这一行。不加一次性 tip：What's new 已经覆盖老用户，导览覆盖新用户 |

所有新文案进入 `shared/i18n/` 的全部目录（I18N-SPEC）。

## 8. 维护者侧（不在插件代码里）

- PostHog 项目（US 区），打开 *Discard client IP data*，数据保留期用免费档的默认值。
- Key 的维护：
  - `server/telemetry.ts` 的 `POSTHOG_KEY` 是项目的 project token（`phc_…`），只能写入事件，不能读取数据，本来就设计成公开，随 npm 包发布，用户不用配置。
  - 不要提交 personal API key（`phx_…`），插件也用不到它。
  - 在 PostHog 里设置用量上限（billing limit），防止有人刷事件耗尽额度或产生费用。
  - 只有在 key 被滥用时才更换：先在 PostHog 项目设置里重置 project token，再改 `POSTHOG_KEY` 并发布新版本。代价是旧版本的安装会停止上报，直到用户升级。
  - capture 接口对任何 key 都返回 200，key 是否正确要在 PostHog 的 Activity 页面看事件有没有到。
- 建议的看板，全部基于 `flowly_heartbeat`，统计每天的独立 `distinct_id`：
  - 版本分布：按 `flowly_version` 分组；
  - 升级曲线：新版本发布后各版本的占比；
  - 功能开启率：各 `f_*` 的占比；
  - 使用频率：各 `c_*` 的中位数和 P90，以及 DAU/WAU。
  - 活跃：在运行的安装 = 每天 `flowly_heartbeat` 的独立 `distinct_id`；**活跃用户（DAU）** = 其中 `c_user_actions > 0` 的独立 `distinct_id`。心跳每 20 h 以上发一次，所以一个安装偶尔一天有两条，按独立 `distinct_id` 统计即可；功能的使用规模用对应 `c_*` 按天求和，以及 `c_* > 0` 的独立 `distinct_id`。
- PostHog 的 **Web analytics**（`$pageview`、Installation Health）不适用：Flowly 没有网页埋点，所有图表用 Product analytics（Trends / SQL）基于 `flowly_heartbeat` 做。
- 看板：PostHog 项目 688543 的 **Flowly** 看板（2026-10-26 建）。2026-11-10 加了：运行安装 vs 活跃用户、核心行为次数、核心行为人数、Ideas 接受率 / Next moves 点击率、Auto review 失败率（趋势图开测试账户过滤，SQL 图在 WHERE 里排除测试 ID）。
- 排除测试安装：在项目设置的 test account filters 里加 HogQL 过滤 `distinct_id != '<installId>'`，并默认勾选；趋势类图打开 *Filter out internal and test users*，SQL 图在 WHERE 里写同样的条件。事件不建 person profile（`$process_person_profile: false`），所以 cohort 和 person 属性过滤无效；`type: event` 的 `distinct_id` 过滤匹配的是事件属性，也无效。已排除：Coder 测试机 `0d645af4-…`（它的 Usage data 开关也已关闭）。
- 还原错误帧的 bundle 行号：`node scripts/map-bundle-lines.mjs --flowly <版本或 --ref 提交> --paseo <Paseo 版本> <行号>...`（行号可写 `104683`、`:104683:10` 或 `flowly-bundle.js:104683`）。脚本按 Paseo 0.13 `compiler.js` 的 `compileTarget` 选项（bundle、cjs、platform node、target node20、treeShaking，外部模块同 `SERVER_HOST_MODULES`）加 `wrapCommonJsBundle` 的 3 行头重建服务端 bundle，esbuild 用 Paseo 依赖的版本（`--esbuild` 可指定），再用同一次构建的 source map 查出 `server/*.ts` 的文件和行，并和 bundle 里的 `// server/xxx.ts` 模块注释核对；不带 source map 的构建与带 source map 的输出必须逐字相同，否则报错。`--paseo` 用事件的 `paseo_version`。源码取自 `v<版本>` 标签（或 `--ref`、`--dir`）并 `npm ci`。行号只在版本、依赖和 Paseo 的 esbuild 都一致时有效：事件里的 `flowly_version` 只是版本号，开发中的提交可能也叫同一个版本，对不上时用 `--ref` 试对应的提交，`--grep <文本>` 可列出 bundle 里含该文本的行来核对函数名。2026-10-26 的示例事件（`:104683 listDirectories`、`:102566 directory`）在 `13f9905` + Paseo 0.13.0 + esbuild 0.25.12 下对应 `server/directories.ts:16` 和 `server/service.ts:142`。
- 查某个 Paseo 版本的错误：HogQL `select properties.paseo_version, count() from events where event = '$exception' group by 1`（旧事件没有这个键，为空）。
- 项目 key 只能写入，不能读取，放在源码里没有问题。可能有人伪造数据，这一点已接受：数据只用于参考。

## 9. 验收标准

1. 开关为开、距上次成功发送超过 20 h 时，daemon 启动 5 分钟后发出**恰好一个**请求：发往 `https://us.i.posthog.com/i/v0/e/`，`event = flowly_heartbeat`，`properties` 的键集合与第 4 节完全一致。用 fetch 桩加单元测试断言键集合，任何多出来的键都判失败。
2. 用户还没看过导览或 What's new 时，只要开关为开，照常发送。
3. 关闭开关后，之后的每次检查都没有任何请求；重新打开后恢复发送，并沿用原来的 `installId`。
4. `DO_NOT_TRACK=1`、`FLOWLY_TELEMETRY=0`、`NODE_ENV=test` 三种情况各自都没有任何请求，设置页显示强制关闭的状态。
5. 网络失败、超时、返回 500 时：不抛错、不改动 `lastSentAt`，一小时后重试；连续失败不会多发。
6. `ui_locale`：`language` 为固定语言时发该语言；为 `auto` 时发 `device-language.locale`；两者都没有时发 `""`。
7. 计数测试：构造一个包含窗口外事件的 flow 日志，只统计窗口内的事件；`models` 中的非法键归入 `other`，最多 10 个键。
8. `telemetry.json` 损坏时保留原文件、重新生成状态，不崩溃。
9. 客户端 bundle 不新增依赖；`npm run typecheck`、`npm test` 通过，包括 i18n 目录检查。
10. README、What's new、导览、ONBOARDING-SPEC 同步更新（AGENTS.md Onboarding upkeep）。

## 10. 以后可能加（本版不做）

- 客户端（界面）错误；
- 客户端平台（web / 桌面 / iOS / Android）：需要客户端经现有 RPC 告诉 daemon，等证明需要再加；
- 主动反馈入口；

每一项加进来之前都要先修改第 4 节和告知文案。

## 11. 错误上报

2026-10-26 用户决定：单独事件 + 清洗过的堆栈，只在 daemon 端。实现：`server/error-report.ts`（清洗、采集点）和 `TelemetryService.reportError`（`server/telemetry.ts`）。

### 11.1 前提

和心跳相同：开关为开、没有被环境变量强制关闭（第 6 节）、`POSTHOG_KEY` 非空。不要求距上次心跳多久，也不要求用户看过告知（同第 3 节）。

### 11.2 采集点

| 来源 | `source` | 说明 |
|---|---|---|
| RPC handler 抛出的错误 | `rpc <rpc 名>`，如 `rpc task.update` | 包在 `server.handle` 外层，上报后原样抛出，调用方看到的结果不变。**不报**预期错误，也就是 handler 故意返回给调用方的答复：`ToolError`、`MemoryError`、`StoreInvalidError`、`ExternalError`、`ZodError`，以及没有系统错误码的普通 `Error`（如 "Task not found."、版本冲突），和下面的“Flowly 之外的失败”。`TypeError` 等程序错误、带系统错误码的错误（`ENOENT`、`SQLITE_BUSY`）照常上报；用户给的路径不存在（文件夹浏览、新建项目）或会话里的图片文件已被删除，handler 改为抛出普通 `Error`（"Expected an existing directory."、"The image file no longer exists."），不再带 `ENOENT` |
| 后台任务失败 | 日志标签去掉末尾冒号，如 `Kanban auto wrap-up failed` | 原来的 `console.error(label, message)` 统一改用 `logFailure(label, error, context?)`：日志输出不变，再上报一次。标签是固定字符串；id、路径等只写进日志的内容放在 `context` 参数里，不上报。存储层的失败状态（`fail()`）没有错误对象，上报为 `StorageError`，`value` 为存储错误码。daemon 代码里不再有裸 `console.error`，由 `server/error-report.test.ts` 检查 |
| 未捕获异常 | `uncaught` | `process.on("uncaughtExceptionMonitor")`，不改变崩溃行为；插件卸载时移除。整个 daemon 进程共用这个事件，所以只有堆栈里有 Flowly 自身帧时才上报。进程随后退出时请求可能来不及发出，属尽力而为 |

插件启动完成（遥测服务建立）之前的错误不上报。

**Flowly 之外的失败**（`outsideError`，`server/error-report.ts`）在 RPC 和 `logFailure` 两处都只记日志、不上报（2026-10-27，卡片“遥测错误分析”：前两天 34 条事件里约一半属于这类，代码修不了）：

- `DaemonConnectionError`：到 Paseo daemon 的连接断开（daemon 重启时进行中的请求）。宿主的 client 是另一份代码，所以按 `name` 判断；
- `LocalDaemonUnavailable`：本地连接（`server/local-daemon.ts`）没有地址（Paseo 的 supervisor 正在重启 daemon，`paseo.pid` 的 `listen` 为 `null`）、没有 `paseo.pid`（daemon 没在运行）、`paseo.pid` 重试后仍是空的或写了一半（Paseo 原地改写这个文件，见 WORKSPACE-RESTORE-SPEC 第 1 步）、daemon 不应答连接（超时、拒绝、连接关闭；关了自动重连的 client 这时抛普通 `Error`），或没有本地凭据。daemon 拒绝本地凭据（`DaemonAuthenticationError`）和连上之后 Paseo 版本缺少所需方法的错误照常上报（2026-11-10，卡片“近期error排查”）；
- `SummaryModelError`：所有摘要模型都失败或没有可用模型（provider 的问题，卡片或洞察里会显示错误）。

### 11.3 事件内容（白名单）

`event = "$exception"`，`distinct_id` 与心跳相同（`telemetry.json` 的 `installId`；文件还不存在时按第 3.3 节新建；心跳和多个同时到来的错误共用同一次新建，所以一个安装只有一个 `installId`）。`properties` 的键集合固定为：

| 键 | 内容 |
|---|---|
| `$process_person_profile` | `false` |
| `$geoip_disable` | `true` |
| `$exception_list` | 一项：`{ type, value, mechanism: { handled, synthetic: false }, stacktrace: { type: "raw", frames } }` |
| `$exception_fingerprint` | 由 `type`、`value`、`source` 和各帧的文件、函数名、行号算出的 SHA-256 前 32 位十六进制 |
| `source` | 11.2 节的来源；不符合 `^[\w .,;:'/-]{1,80}$` 时为 `other` |
| `flowly_version`、`node_major`、`os`、`arch` | 同第 4 节 |
| `paseo_version` | Paseo daemon 的版本号（如 `0.13.0`），取不到时为 `""` |

- `paseo_version`：插件 SDK 不提供宿主版本（`COMPAT(sdk-paseo-version)`），所以用 `server/paseo-version.ts` 开一次短连接（同 `server/local-daemon.ts`，AGENTS.md 的本地连接例外），读 daemon 在连接时发来的 `server_info.version`，只保留符合 `^\d+\.\d+\.\d+(?:[-+.][\w.-]{1,20})?$` 的值。成功后在内存里缓存到 daemon 重启；取不到（连不上、没有凭据、格式不符）时发 `""`，下一条错误再试，不影响上报。bundle 行号取决于 Paseo 的版本（它自带的 esbuild 和包装头），所以还原行号时用这个值作 `--paseo`。
- `type`：`error.name`，符合标识符格式（`^[A-Za-z_$][\w$]{0,60}$`）才用，否则为 `Error`；抛出的不是 `Error` 时为 `NonError`。
- `value`：`error.code` 符合 `^[A-Z][A-Z0-9_]{1,40}$`（如 `ENOENT`、`SQLITE_BUSY`）时为它，否则为 `""`。**从不发送错误消息**：消息里常有路径、标题或命令。
  - 例外：`DaemonRpcError`（Paseo RPC 返回错误，`@getpaseo/client`；宿主的 client 是另一份拷贝，所以按 `name` 识别）时为 `请求类型:错误码`（如 `fetch_agent_timeline_request:agent_refresh_failed`），取自它的 `requestType` 和 `code` 字段，转成小写后整段符合 `^[a-z][a-z0-9_.]{0,59}$` 才保留，否则该部分为空（不截取、不删字符拼成标识符）；没有错误码时只有请求类型。它的消息含服务端的错误文本，同样不发送（2026-11-10，卡片“近期error排查”）。
- `handled`：未捕获异常为 `false`，其余为 `true`。
- `frames`：只保留 Flowly 自身文件的帧，最多 20 个，按最早的调用在前排列。"自身文件"指在插件目录下、且不在 `node_modules` 里的文件；插件目录在运行时从 `server/error-report.ts` 自己的堆栈帧推出（从源码加载时是 `server/` 的上一级，打包加载时是包文件所在目录），所以不依赖 Paseo 的加载方式。Paseo 0.13 把插件服务端编成一个 esbuild bundle，再用 `eval` 执行（`bundle-evaluator.js`，没有文件名和 source map），这时帧的形式是 `eval at evaluateBundle (…), <anonymous>:行:列`：插件目录记为 bundle 模式，这类帧的 `filename` 固定为 `flowly-bundle.js`，`lineno`/`colno` 是 bundle 内的位置，函数名照常保留（2026-10-26 Coder 端到端测试发现）。其他插件的 eval 帧形式相同、无法区分，只可能出现在未捕获异常里，接受这一点。每帧只有 `filename`（相对插件目录的路径，如 `server/service.ts`）、`function`（符合 `^[\w$.<> ]{1,80}$` 才保留，否则为 `""`）、`lineno`、`colno`、`in_app: true`、`platform: "node:javascript"`。插件目录本身和插件以外的任何路径都不发送。

### 11.4 频率

- 同一个指纹每个 UTC 日最多发一次，每个 UTC 日最多发 20 条（`MAX_ERRORS_PER_DAY`）。计数只在内存里，daemon 重启后重新计（用户偏好最简单的方案）。
- 发送失败不重试。请求超时 10 s；失败不影响调用方，也不写看板数据。

### 11.5 验收

1. 清洗（bundle 模式）：`eval at evaluateBundle (…), <anonymous>` 帧记为 `flowly-bundle.js`，保留函数名和位置，不含任何路径。
1. 清洗：构造含插件内文件（源码路径和 `file://` URL）、插件内 `node_modules`、`node:internal` 和插件外用户路径的堆栈，只留下插件内两帧，路径相对，顺序反转；整个事件里没有用户路径和错误消息（`server/error-report.test.ts`）。
2. `type`、`value`、`source` 的规则如 11.3 节；非 `Error` 为 `NonError`。
3. 同一错误同一天只发一次；30 种不同错误只发 20 条；第二天重新开始。
4. 开关关闭、`DO_NOT_TRACK=1` 时不发；没有 Flowly 自身帧的未捕获异常不发。
7. `paseo_version`：取到时随事件发出并缓存；第一次取不到时发 `""`，之后再取到就用新值；取值抛错不影响上报（`server/error-report.test.ts`）。
5. RPC 包装：同步和异步 handler 的程序错误被上报并原样抛出；`ToolError` 只抛出不上报；正常返回值不变。
6. `properties` 的键集合与 11.3 节完全一致，`distinct_id` 与 `telemetry.json` 的 `installId` 相同；全新安装时同时上报的多个错误使用同一个 `installId`。
8. Flowly 之外的失败（`DaemonConnectionError`、`LocalDaemonUnavailable`、`SummaryModelError`）经 RPC 包装和 `logFailure` 都不上报，日志照常；其他后台失败照常上报（`server/error-report.test.ts`）。
