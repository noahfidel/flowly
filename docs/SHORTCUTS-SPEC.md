# F4 桌面快捷键 — 增量 spec（2026-10-15）

## 1. 调研结论（Paseo 0.11.2）

| 能力 | 结论 |
| --- | --- |
| 插件 SDK 快捷键注册 | **没有。** `@getpaseo/plugin@0.11.2` 的 `PluginClientContext` 只有 `addCommandCenterItem`、`addSlashCommand`、`addHeaderButton` 等；`PluginCommandCenterItemContribution` 只有 `id/title/icon/keywords/context/onSelect`，没有 key/chord 字段。 |
| 宿主快捷键系统 | 已安装的宿主 bundle 有完整的快捷键注册表（`resolveShortcutKeysForAction`、`useKeyboardShortcutsStore`、快捷键帮助对话框、用户覆盖），但 action ID 是内置固定集合，插件不能注册或出现在宿主快捷键帮助里。 |
| 全局监听 | 唯一的全局方式是 `window`/`document` 的 `keydown` 监听 —— AGENTS.md 禁止 DOM API，**不采用**。 |
| React Native Web | 宿主的 RN-Web `View` 会转发 `onKeyDown/onKeyDownCapture/onKeyUp` 这类 React 合成事件属性（宿主 bundle 的 `keyboardProps` 白名单），`focusable` 映射成可聚焦。这是 RN 原语上的 React 事件属性，不访问 `window/document/element`，不写 HTML/CSS。React Native 类型定义没有声明这些属性，所以只在 `Platform.OS === "web"` 时以带类型的 web-only 属性对象传入。 |

**取舍：** 没有合规的“全局”快捷键。实现两条互补路径：

1. **看板内快捷键（scoped）：** 看板根 `View` 在 web 上可聚焦，并接收冒泡上来的 `onKeyDown`。只有键盘焦点位于看板内部（点击过看板/卡片/按钮之后）才会生效；焦点在宿主侧栏、宿主输入框或其他 pane 时不生效。
2. **Command Center 条目（global）：** 在宿主 Command Center 里注册全局条目，从任何位置都能用键盘（宿主的 Command Center 快捷键 → 输入 → 回车）到达同样的动作。

## 2. 可观察行为

### 2.1 看板内快捷键（桌面 web、非紧凑布局）

| 按键 | 动作 | 前提 |
| --- | --- | --- |
| `N` | 打开“新建任务”：*Quick task for New task* 开启（默认）时为 Quick task，否则为完整表单（默认 Todo；QUICK-TASK-SPEC §5） | 存在当前项目且未归档 |
| `Q` | 打开 Quick task，项目默认为上次 Quick task 用的项目，否则当前项目（QUICK-TASK-SPEC §3） | 至少有一个未归档项目 |
| `P` | 打开项目切换弹层 | — |
| `/` 或 `F` | 打开筛选/搜索弹层 | 存在当前项目 |
| `S` | 打开 / 关闭 Search 页（SEARCH-SPEC §5） | 存在当前项目 |
| `A` | 打开 Needs attention 弹层 | — |
| `D` | 打开左侧 Dispatcher 聊天停靠栏并聚焦消息框；已打开时只聚焦消息框。`D` 从不关闭停靠栏，只有 `Esc` 关闭（Ruling, Noah 2026-11-09）；焦点在消息框内时输入 “d” | 看板有停靠栏（项目或 All projects） |
| `?` | 打开快捷键帮助弹层 | — |
| `Esc` | 作用于用户所在的区域（Ruling, Noah 2026-11-09）：先是打开的弹层；然后若停靠栏是活动区域（消息框获得焦点或在停靠栏内按下，之后未在看板别处按下）：消息框聚焦且有草稿 → 仅失焦（草稿保留，停靠栏仍为活动区域），否则关闭停靠栏并把焦点还给看板；再然后依次：侧栏在 session 预览中 → 返回卡片详情；侧栏在详情 → 关闭侧栏；在项目页 → 离开（停靠栏保持打开） | 见左 |
| `J` / `K` | 当前列下一张 / 上一张卡片（打开其侧栏）；没有选中卡片时选中第一列第一张 | 有可见卡片 |
| `H` / `L` | 左 / 右侧最近的非空列，同一行号（越界取最后一张） | 有可见卡片 |
| `←` / `→` | 智能体多问题提问：上一题 / 下一题（不循环；挂在问题表单自身，不走看板快捷键，见 SESSION-QUESTION-SPEC §2） | 焦点在问题表单内且不在输入框 |

- 大写字母（`CapsLock`）与小写等价；带 `Cmd/Ctrl/Alt` 的组合一律不处理，留给宿主快捷键。按住 `Shift` 的字母（如 `Shift+N`）不处理；`?` 这类本身需要 Shift 的字符照常处理。
- 自动重复（按住）和 IME 组合中（`isComposing`）的事件忽略。
- 处理了的按键调用 `preventDefault` + `stopPropagation`；未处理的原样冒泡给宿主。
- 卡片导航按桌面列显示顺序（`position`，再按 `createdAt`）且只在当前筛选结果中移动；导航选中即打开侧栏（与点击卡片一致），不会自动滚动列。

### 2.2 屏蔽条件（任一满足即不触发）

- 插件内任何文本输入框处于聚焦状态（`Field`、session 跟进输入框）。
- 插件拥有的任何宿主 `Modal` 处于打开状态（项目/筛选/Attention/状态/卡片操作/表单/新建 session/Wrap up/session 编辑器/快捷键帮助等）。这时 Esc 由宿主 Modal 自己处理。
- 紧凑布局、原生平台（iOS/Android）、正在执行写操作时的“新建任务”同样不生效。

屏蔽通过插件内的引用计数实现（`client/shortcuts.ts` 的 `useShortcutBlock`）：输入框在 `onFocus/onBlur`、所有插件 Modal 通过 `client/modal.tsx` 的包装在 `open` 时登记，组件卸载时注销。不读取 DOM 的 `activeElement` 或 `event.target`。

已知限制：宿主 Modal 关闭后焦点可能回到页面根，需要再点一下看板才能继续用快捷键；这是不使用全局监听的代价。

### 2.3 可发现性

- 桌面头部新增“Keyboard shortcuts”图标按钮（`Keyboard` 图标），点击或按 `?` 打开帮助弹层，列出所有按键和说明，并说明“焦点需在看板内”，以及在 Command Center 搜索 “Flowly” 可到达 §2.4 的条目。
- 桌面头部 Projects / Attention / Filter / New task / 帮助按钮的无障碍标签附带快捷键（如 `New task (N)`、`Task filters (/)`）。不使用 RN-Web 专有的 `accessibilityKeyShortcuts`，因为 React Native 类型未声明它。

### 2.4 Command Center 条目（全局）

| 条目 | 行为 |
| --- | --- |
| `Flowly: View board` | 打开看板（id `open-board`） |
| `Flowly: Quick task` | 打开看板并打开 Quick task（intent `quick-task`，QUICK-TASK-SPEC §5） |

Flowly 只注册这两个条目，按此顺序（QUICK-TASK-SPEC §7），不注册工作区上下文的条目。其余 intent（`attention`、`new-task`、`projects`、`filters`、`search`、`shortcuts`、`welcome`）没有 Command Center 条目，但作为 screen params 仍然有效，看板上的按钮和快捷键照旧。

数据契约：`openScreen({ screenId: "board", params: { intent, at } })`。

- `intent ∈ {"new-task","quick-task","projects","filters","attention","shortcuts","welcome","search"}`；`at` 为 `Date.now()` 的十进制字符串。
- 看板对每个 `(intent, at)` 只消费一次；`at` 距当前超过 30 秒（例如刷新页面后 URL 里残留）或格式无效、未知 intent 时忽略，不报错。
- 与 session chip 链接参数（`taskId/sessionId/workspaceId/requestId`）互不冲突；intent 参数不进入 `parseSessionLink`。
- `new-task` 在没有项目或项目已归档时不打开表单（与按钮的禁用状态一致）；其余 intent 在数据加载完成后执行。

## 3. 错误

- 快捷键与 Command Center intent 不产生新的错误路径，也不调用 RPC；被屏蔽或前提不满足时静默不响应（与禁用按钮一致）。

## 4. 验收

1. 纯逻辑单测：按键解析（大小写、修饰键、repeat、IME、屏蔽、紧凑）、卡片网格导航（空板、首次选中、列内上下、跨列/跳过空列/行号截断）、intent 参数解析（新鲜度、未知值、重复消费）。
2. `npm run typecheck`、`npm test` 通过。
3. UNRUN（需要真实宿主窗口）：桌面实际按键触发、焦点进入看板的方式、宿主 Command Center 条目显示与跳转、帮助弹层外观。
