# 更新后的 What's new 窗口

Status: **已实现，1.6.0 随发布**（2026-10-22 设计确认，2026-10-24 按 W4 加历史翻页，2026-10-26 按 W5 改为左右翻页，随 1.7.0 发布；§13）（卡片“插件更新后弹出‘新功能’提示”，follow-up of “重设计onboarding流程”）。

## 1. 目的

ONBOARDING-SETUP-SPEC D7 决定老用户不自动弹新导览，所以老用户看不到导览里新增的设置：Memory / Insights 的全局开关，以及外部 session 的 Progress / Next moves / Ideas（D3：对没走过新导览的人保持关闭）。一次性 tip（ONBOARDING-SPEC §5）只能在某个场景出现时说一句，不适合一次说清一个版本的变化。

本功能：插件升级后，老用户第一次打开看板时弹一个简短窗口，列出这次版本里**老用户自己发现不了**的变化，每条一句话，可带一个按钮（打开设置 / 重看导览），一键关闭，每个版本只弹一次。

反目标：changelog 全文（README / release notes 的事）；每个版本都弹；打断新用户；为它加轮询或服务端状态。

## 2. 什么时候弹

看板全屏页（不在工作区面板里）满足**全部**条件时弹出：

1. onboarding 设置已加载（`ready`），看板已加载；
2. `welcomeSeen = true`（老用户。`welcomeSeen = false` 的人要么马上看到首次导览，要么马上被静默标记为老用户，下一次渲染再判断）；
3. 条目表里有版本号**大于** `whatsNewSeen` 的条目（没有条目的版本 → 不弹）；
4. 没有挡着的东西：其他对话框、打开的卡片、导览、设置按钮旁的提示气泡都不在。被挡住时等待，挡着的东西关掉后再弹。

设置加载失败、无效时不弹（静默失败，与导览一致）。

**新用户不弹**：首次导览（自动弹出的那次）以任何方式关闭时，`welcomeSeen = true` 与 `whatsNewSeen = 最新条目的版本号` **在同一次写入里**存下。导览已经讲过这些设置，所以新用户不会在导览后紧接着又看到一遍。手动打开导览不写 `whatsNewSeen`。

**静默标记的老用户**（ONBOARDING-SPEC §1，有项目但 `welcomeSeen = false`，即装了没有导览的旧版本）：标记后 `welcomeSeen = true`、`whatsNewSeen` 仍空，会看到 What's new。这是对的：他们正是要被告知的人。

## 3. 只弹一次

- 新 host 设置字段 `onboarding.whatsNewSeen: string`（默认 `""`，最长 20），存上次看过的版本号。
- 窗口**以任何方式关闭**（Got it、Esc、点遮罩、点条目按钮）时写 `whatsNewSeen = 窗口里最新条目的版本号`。与 `useOnboarding` 其他写入一样：乐观显示，版本冲突时合并重试。写失败时下次打开看板会再弹（可接受）。
- 版本比较按 `major.minor.patch` 数字比较（`1.10.0 > 1.9.0`）；`""` 小于一切。
- 设置按 host 存，第二台设备也会弹一次（与导览一致，已接受）。

## 4. 历史版本：默认最新，可往回翻到 1.5.0（用户决定 2026-10-24，取代 W2）

条目表是一个**版本列表，新的在前**，最早到 **1.5.0**，更早的不收（W4）。

- 自动弹出只看**最新一个有条目的版本**（`latestRelease`）：它比 `whatsNewSeen` 新才弹；关闭时记下它的版本号。旧版本的页不会让窗口再弹。
- 窗口总是打开在最新版本那一页。版本号两侧各一个箭头：‹ 翻到更老的版本，› 翻到更新的版本，到头时对应箭头变灰（W5）。翻页不改变 `whatsNewSeen`。
- 跳版本升级（1.5 → 1.8）：自动打开在 1.8 那页，用户可往回翻看 1.7、1.6……。
- 发布 minor 或 major 版本（x.Y.0、X.0.0）时在列表最前面加一项；patch 版本（x.y.Z）不加（用户决定 2026-10-27）；旧版本条目保留（不再“新的覆盖老的”）。每版最多 7 条（`WHATS_NEW_MAX_ITEMS`），保证一页不太长。

## 5. 窗口

- 插件 `Modal`（与导览同一组件、同一入场动效），标题 “What's new”，标题图标 `FlowlyMark`，桌面与手机同一组件，最大宽度 ~440。
- 每条一行：图标（`Icon`）+ 一句话（md），右侧可选一个按钮（`Chip` 风格的次要按钮），窄屏时按钮换到文字下方。
- 标题下一行是 “‹ Flowly {version} ›”（条目表的版本号去掉末尾的 `.0`；只有一个版本时没有箭头）。
- 页脚只有一个主按钮 **Got it**。
- 条目按钮：先关闭窗口（记为已看），等约 450 ms（`useAfterModalClose`，两个 Modal 不在同一帧切换）再执行动作：
  - `settings`：打开 Settings 的指定页（`openSettingsAt(section)`）；
  - `tour`：手动打开欢迎导览（非首次模式，不写外部 session 草稿）。
- 打开期间不显示 tip 横幅；关闭后 tip 照常按优先级出现。

### 5.0 翻页（§4，W5）

版本行：`[‹] Flowly 1.7 [›]`，与 Insights 日总结的日期翻页同一形式（`IconButton` ChevronLeft / ChevronRight，无障碍标签 “Older release” / “Newer release”）。左箭头翻到更老的版本，右箭头翻到更新的版本；在最老 / 最新一页时对应箭头禁用。翻页时条目从翻页方向滑入（`Enter`，水平 16 pt：往老翻从左侧进，往新翻从右侧进；Reduce Motion 下无位移）；打开窗口时的第一页不滑动。每次打开都回到最新一页。页脚只有 **Got it**。

### 5.1 再次打开（用户决定 2026-10-22）

Settings → General → Welcome tour 组里加一行 **What's new**（有条目时才显示）：与 “Show welcome tour” 一样先关闭设置、约 450 ms 后打开同一个窗口；手动打开时 `whatsNewSeen` 已是最新则不变，否则同样记为已看。

## 6. 条目表

纯数据放 `client/whats-new.ts`（不含 React），文案用 `msg()` 标记、渲染时 `t()`，进全部 9 个语言目录：

```ts
export interface WhatsNewItem { icon: string; text: string; action?: { label: string; to: "settings"; section: SettingsSection } | { label: string; to: "tour" } | { label: string; to: "auto-review" } }
export const whatsNew: { version: string; items: WhatsNewItem[] }[] = [ /* 新的在前，最早 1.5.0 */ ];
```

版本号写**带上这些变化发布的那个版本**。条目写这个版本里用户可见的新功能和变化，每条一句话；能在设置里开关或调整的给 **Open settings**（落在对应设置页），导览相关的给 **Take the tour**。

### 1.8.0

| 图标 | 文案 | 按钮 |
| --- | --- | --- |
| `Search` | 搜索过去的卡片、总结、笔记、Workpad、想法和交付物；agent 也能搜（[SEARCH-SPEC](SEARCH-SPEC.md) §8） | — |
| `ShieldCheck` | Auto review checks every delivery before it reaches you and sends it back to the agent when it falls short. On for new projects.（[GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) §10） | **Turn on for this project**（`to: "auto-review"`：当前项目的 Edit project，Auto review 区块置顶、开关已打开；保存后由 daemon 识别命令；取代 AUTO-REVIEW-SPEC 的 `review-analysis`） |
| `Undo2` | Flowly learns from what you send cards back for: the second card with the same problem turns it into a project guideline, checked on every delivery it applies to. | — |
| `BookMarked` | Memory no longer needs confirming; what agents remember takes effect at once and retires by itself when unused. | — |

### 1.7.0（v1.6.0..v1.7.0，全部更新见 [release-notes/v1.7.0](release-notes/v1.7.0.md)）

| 图标 | 文案 | 按钮 |
| --- | --- | --- |
| `CalendarDays` | Insights 改版：一年的活跃度、可逐日翻看的每日总结、每张完成卡片的过程（评审轮次、等待、token）（[INSIGHTS-REDESIGN-SPEC](INSIGHTS-REDESIGN-SPEC.md)） | — |
| `Sparkles` | Insights 从卡片里起草 skill，你同意才加进项目；默认开，可在设置里关 | Open settings → AI features |
| `Gauge` | 看板打开和刷新更快，手机上尤其明显：只读概览和打开的卡片（[LOADING-R2-SPEC](LOADING-R2-SPEC.md)） | — |
| `MonitorSmartphone` | 手机上设置改为全屏；Settings → Cards 可关闭扫光动画 | Open settings → Cards |
| `Database` | Paseo 支持时，看板改存本地 SQLite 数据库并每天备份；Settings → Storage 可恢复备份或导出为 JSON（[SQLITE-STORAGE-SPEC](SQLITE-STORAGE-SPEC.md)） | Open settings → Storage |
| `Activity` | 匿名使用数据：每天一次版本、开启的功能和使用次数；出错时只报 Flowly 代码里的位置；可在设置里关（[TELEMETRY-SPEC](TELEMETRY-SPEC.md)） | Open settings → General |

### 1.6.0（2026-10-24 用户确认发布 1.6.0；v1.5.0..main 已合入的部分）

| 图标 | 文案 | 按钮 |
| --- | --- | --- |
| `Brain` | Project memory：在一张卡上确认的决定和坑会带进之后卡片的 session，完成的卡也能提议新的 | — |
| `SlidersHorizontal` | Project memory 和 Insights 各有一个对所有项目生效的开关 | Open settings → AI features |
| `MessagesSquare` | Progress / 建议的下一步 / Ideas 也能用于非 Flowly session；对老用户是关的，开了每轮跑一次摘要模型 | Open settings → AI features |
| `ListOrdered` | 可选多个摘要模型并设回退优先级 | Open settings → Models |
| `ShieldCheck` | 新 session 可用默认权限模式启动（全局或按项目） | Open settings → Models |
| `PlugZap` | Azure DevOps 工作项可作为卡片输入 | Open settings → Connections |
| `CircleHelp` | 欢迎导览可一处设置语言和 AI 功能 | Take the tour |

### 1.5.0（v1.4.0..v1.5.0）

| 图标 | 文案 | 按钮 |
| --- | --- | --- |
| `Activity` | Workflow insights（需开启）：从 agent 跑过的命令里建议值得保留的脚本、准备步骤和规则 | Open settings → AI features |
| `Sparkles` | 一个 AI 输出语言决定 AI 写的所有内容的语言 | Open settings → AI features |
| `ListChecks` | agent 开工前先设好卡片的类型、标签和 workpad | — |
| `GitPullRequest` | agent 可把自己的 PR 加进卡片输出，新评审意见标未读 | — |
| `FileText` | 卡片描述按 Markdown 显示 | — |

## 7. 判定逻辑（纯函数，`client/onboarding-logic.ts` 或 `client/whats-new.ts`）

- `compareVersions(a, b)`。
- `whatsNewDecision({ settingsStatus, boardLoaded, welcomeSeen, whatsNewSeen, release, blocked })` → `"wait" | "show" | "none"`：未就绪 → wait；`!welcomeSeen` → none；无条目或 `release.version ≤ whatsNewSeen` → none；blocked → wait；否则 show。
- `whatsNewVersion(release)`：首次导览关闭和窗口关闭时写入的版本号；无条目时为 `""`。
- `latestRelease`：列表里第一个有条目的版本，传给上面两个函数；`stepRelease(index, ±1, count)`：翻页，停在两端。

## 8. 数据契约

- `shared/settings.ts` 的 `onboardingSettings` 增加 `whatsNewSeen: z.string().max(20).default("")`；schema version 不变（`onboardingSettingsValues()` 本来就补默认值，旧数据读出为 `""`）。
- 无 board、RPC、工具、skill 或 daemon 改动；agent 面文案不变。

## 9. 上手维护规则（AGENTS.md “Onboarding upkeep” 补一条）

发布含用户可见变化、且**老用户在使用中不会自己遇到**的 minor 或 major 版本（新设置、对老用户默认不同的开关、换了位置的入口）时，在 `client/whats-new.ts` 加一个该版本的条目（≤ 7 条，每条一句话），加在列表最前面（旧版本保留，最早到 1.5.0）。在某个场景里能自然遇到的功能仍用一次性 tip，不进 What's new。patch 版本（x.y.Z）从不加条目（用户决定 2026-10-27）。都不需要时在交付说明里写明。

## 10. 验收

- 单元（`client/onboarding-logic.test.ts` 或 `client/whats-new.test.ts`）：
  - **只弹一次**：`whatsNewSeen` 等于最新版本 → none；关闭写入的版本号 = 最新条目。
  - **无条目不弹**：条目表为空、或最新条目 ≤ `whatsNewSeen` → none。
  - **新用户不弹**：`welcomeSeen = false` → none；首次导览关闭的补丁同时含 `welcomeSeen` 与最新版本。
  - 版本比较 `1.10.0 > 1.9.0`；被挡 → wait；设置未就绪 → wait。
  - 条目表本身：版本号格式合法、新的在前且严格递减、最老的是 1.5.0、每版 1–7 条、每条文案非空。
  - 只有最新版本决定自动弹出；翻页停在两端。
- i18n 完整性（`npm test`）。
- `npm run typecheck`、`npm test` 通过。
- 真实界面（重载插件，`docs/promo/shot-lib.mjs` 截图，桌面 + 窄屏）：本机 `whatsNewSeen` 为 `""` → 弹一次；Got it 后重进看板不再弹；Settings → General → What's new 能再打开；“Open settings” 落在 AI features；“Take the tour” 打开导览且无卡死。证据存 `docs/verification/`。

## 11. 文档同步

ONBOARDING-SPEC（新增一节，指向本 spec；数据契约加字段）、ONBOARDING-SETUP-SPEC D7（“另提 idea” → 指向本 spec）、AGENTS.md Onboarding upkeep、PROGRESS.md、SPEC-OUTLINE.md。

## 12. 我做的决定（可推翻）

1. **用条目表的版本号，不读运行中的插件版本**。条目随代码发布，表里的就是已发布的；不需要把 `package.json` 打进客户端，也不会因为 patch 版本没条目而误弹。代价：条目的版本号必须写对发布号：它决定是否自动弹出，并在关闭时存进 `whatsNewSeen`。写得比实际发布号高，之后那些版本的条目就不会再自动弹出，所以发布前要核对。还没发布就在本机重载开发版的主机，会提前记下这个版本，只影响开发机（可从设置重新打开）。
2. ~~跨版本时列出所有未看版本~~ → 用户改为只显示最新一个版本（§4）。
3. 条目按钮只打开设置或导览，不在窗口里直接开关功能。
4. 静默标记的旧版老用户也会看到 What's new。
5. 新用户在首次导览关闭时一并记为已看最新版本。

## 13. 用户决定（2026-10-22）

| # | 决定 |
| --- | --- |
| W1 | 关闭后可再次打开：Settings → General 加一行 What's new（§5.1）。 |
| W2 | 跳版本升级只显示最新一个版本，新的覆盖老的（§4）。我提示过中间版本的设置变化会被错过，用户仍选此项。 |
| W3 | 首个条目先按 1.5.0 做 demo 看效果（§6）；条目内容按 §6 的 3 条。2026-10-24 起作废：正式发布 1.6.0，条目见 §6。 |
| W4 | 2026-10-24：What's new 可查看历史版本，默认展示最新版本，可翻页看老版本，从 v1.5.0 开始，更早的不管（§4，取代 W2）。 |
| W5 | 2026-10-26（卡片“v1.7.0发布”）：导航改为直接左右翻页查看各版本 changelog：版本号两侧的 ‹ › 取代页脚的版本按钮（§5.0）。 |
