# 搜索

状态：**2026-10-27 用户审阅通过，已实现**。卡片“搜索功能”。用户 2026-10-27 确认的方向：v1 在 daemon 内存里扫描；搜卡片、摘要、agent 笔记、workpad、ideas、交付物和项目记忆；默认当前项目；同时提供 agent 工具 `flowly_search`。

## 1. 决定

| 问题 | 决定 | 理由 |
|---|---|---|
| 在哪里搜 | daemon 里。客户端只发查询、只收结果。 | 加载优化 R2 之后客户端不再持有完整看板（LOADING-R2-SPEC），手机也不该下载历史（PERFORMANCE-SPEC）。 |
| 用什么搜 | 扫描 daemon 内存里的数据，不建磁盘索引、不改表。 | daemon 本来就缓存整板（SQLITE-STORAGE-SPEC §5）；`summaries.json` 和 `memory.json` 由搜索按文件修改时间和大小缓存，变了才重读。内存里的检索文本按看板 revision 和两个文件的戳重建。2026-10-26 在用户真实数据上实测：约 5.6k 条记录，全量扫描一次约 1 ms。 |
| 不用 FTS5 | 留到第二期（§10）。 | 摘要和记忆不在 SQLite 里；trigram 分词要求关键词至少 3 个字，中文常见的两字词（“搜索”“迁移”）用不上索引，照样要退回逐条比对。FTS5 已在 Paseo Helper（Node 24.20 / SQLite 3.53.4）验证可用。 |
| 默认范围 | 当前项目；可切到全部项目。 | |
| agent 能搜什么 | 只搜自己所在的项目，不含自己这张卡，不含项目记忆（记忆用 `flowly_recall`）。 | 两个工具各管一件事，不重复返回。 |

## 2. 搜索来源

每个来源产生若干“文档”。一条命中属于一张卡（项目记忆除外）。

| 来源 `source` | 取自 | 搜的字段 | 权重 |
|---|---|---|---|
| `card` | `tasks` | 标题、描述、标签、类型 | 标题 6，标签 5，描述 3，类型 1 |
| `summary` | `summaries.json`，每张卡只取**最新一版** | state、target、recap、next | 4 |
| `note` | `events` 里 `status_changed` 和 `progress_reported` 且 `note` 非空的记录（人和 agent 都算） | note | 2 |
| `workpad` | `workpads` | 验收条目、检查的说明/命令/证据、疑问 | 2 |
| `idea` | `ideas`，所有状态（open / accepted / dismissed） | 标题、detail、rationale、context | 标题 4，其余 2 |
| `artifact` | `artifacts` | 标题、备注、target（链接或路径）、外部条目的 key（外部条目的标题就是交付物标题） | 3 |
| `memory` | `memory.json`，只取 `active` | 标题、正文、关键词、标签 | 4 |

Ideas 和交付物分别跟随 Settings 里的 Ideas、Artifacts 开关，关掉时不搜；项目记忆在全局关闭或该项目关闭时不搜。

不搜：会话记录（属于 Paseo，没有搜索接口）、`agentReceipts`、系统事件（`workspace_auto_archived` 等）、旧版本摘要、候选/驳回/归档的记忆、`removed/` 里的备份、已归档项目。

卡片范围：项目里所有卡，包括 Done、Cancelled 和已归档的卡（排序靠后，§3.3）。

## 3. 查询与结果

### 3.1 查询语法

- 去掉首尾空白后为空：返回空结果，不报错。最长 200 字符。
- `#tag` 按看板现有规则过滤（复用 `shared/tags.ts` 的 `parseTagSearch`/`tagMatches`，前缀 `module/` 也算）：只保留带这些标签的卡；记忆按自己的标签过滤。
- 其余部分按空白切成词；`"带 空格 的短语"` 算一个词。
- 一张卡入选的条件：**每个词**都出现在这张卡的某个文档里（可以分散在不同来源）。记忆条目按单条判断。
- 比较不分大小写，全角和半角的 ASCII 字符视为相同。纯子串匹配，不分词、不做同义词。

### 3.2 命中片段

- 每个包含至少一个词的字段算一条命中。每张卡最多返回 3 条命中，按权重、再按时间（新的在前）选。
- 片段取原文，以第一个命中词为中心，前后各约 40 个字符，总长不超过 160 字符；被截断的一端加 `…`。换行压成空格。
- `ranges` 给出片段里每个命中词的位置（`[start, end)`，按 UTF-16 下标），客户端据此加粗。

### 3.3 排序

卡片按以下顺序比较：

1. 最高命中权重（大的在前）。
2. 卡片状态：未结束（非 Done/Cancelled 且未归档）在前，然后 Done/Cancelled，最后已归档。
3. 最近一次活动时间（卡片 `updatedAt` 与其命中文档时间中最新的，新的在前）。

记忆条目单独一组，排在卡片之后，按权重、再按 `confirmedAt` 排序。

### 3.4 数量

- 卡片默认最多 30 张，上限 50；记忆最多 10 条。超过时 `truncated: true`。
- 第一版不分页：结果多了就让用户加词。

## 4. RPC：`search.query`

普通请求-响应，只读，不轮询。

```ts
input = {
  query: string,                 // ≤200
  projectId: string | null,      // null = 全部未归档项目
  sources?: Source[],            // 省略或空 = 全部；Source = "card"|"summary"|"note"|"workpad"|"idea"|"artifact"|"memory"
  limit?: number,                // 1–50，默认 30
}
output = {
  cards: Array<{
    taskId, projectId, projectTitle, workspaceId,
    title, status, type?, archived: boolean, updatedAt,
    hits: Array<{ source, refId?, field, snippet, ranges: [number, number][], at?, status? }>,  // ≤3；status 只用于 idea
  }>,
  memory: Array<{ id, projectId, kind, title, snippet, ranges }>,                    // ≤10
  truncated: boolean,
  partial: Array<"summaries" | "memory">,   // 这些文件这次读不出来，结果里没有它们
}
```

- `refId`：idea、artifact、event 的 id；`field`：命中的字段名（如 `title`、`recap`、`evidence`），给客户端标注来源。
- `projectId` 指向不存在或已归档的项目：报错 `Project not found.`（与其他看板 RPC 相同的普通错误）。
- 输入不符合上面的结构（查询超过 200 字符、`limit` 越界、未知 `source`）：RPC 输入校验失败。
- 看板读不出来（`STORAGE_BUSY` 等）时原样报错，与其他看板 RPC 一致。
- `summaries.json` 或 `memory.json` 读不出来时**不报错**：其余来源照常返回，`partial` 里写明缺了哪个。

## 5. 界面

### 5.1 入口

- **Search 页**：和 Ideas、Insights、Memory 一样，打开后替换看板区域（`page = "search"`），桌面和手机相同。
- 打开方式：
  - 桌面头部新增搜索图标按钮（`Search` 图标，无障碍标签 `Search (S)`），放在筛选按钮旁边。
  - 快捷键 `S`（SHORTCUTS-SPEC §2.1 的屏蔽条件照旧）。不用 `⌘K`：带 Cmd/Ctrl 的组合按约定留给宿主。
  - 没有 Command Center 条目（QUICK-TASK-SPEC §7）；intent `search` 作为 screen param 仍然有效（SHORTCUTS-SPEC §2.4 的契约）。
  - 手机：同一个头部搜索图标（紧凑布局的头部本来就有筛选按钮，放在它旁边）。
  - 看板筛选弹层里输入了文字时，多一行 **Search everywhere**，点了打开 Search 页并带上这段文字。
- 再按一次图标或 `Esc` 关闭，回到看板。

### 5.2 页面

- 顶部：搜索框（`TextBox`，打开时自动聚焦，`commitDelay` 250 ms），右边一个范围切换 **This project / All projects**。
- 下面一行来源筛选：Cards、Summaries、Notes、Workpads、Ideas、Deliverables、Memory，可多选；都不选等于全选。
- 结果列表：
  - 卡片行：标题、泳道名、类型；全部项目时加项目名；已归档的卡标 Archived。
  - 卡片行下面是命中行（卡片标题本身的命中不再单列一行，标题已在卡片行上）：来源名（Summary / Note / Workpad / Idea / Deliverable）+ 片段，命中词用粗体和主题强调色。Idea 命中带上它的状态（Dismissed 等）。
  - 记忆单独一组，组标题 Memory。
- 状态：查询为空时什么都不显示；没有结果显示 **No results**；卡片达到上限且 `truncated` 时列表末尾一行 **Showing the first 30 cards**（只有记忆被截断时不显示）；`partial` 时顶部一行 **Summaries could not be read** / **Memory could not be read**。不加说明文字。
- 范围和来源筛选只在本次打开期间记住；查询文字不持久化。
- 动画：请求进行中旧结果保留并淡到半透明（约 120 ms）；每次新结果到达，整个结果列表淡入并轻微上移（共享 `Enter`，约 220 ms）。筛选项的选中状态即时变化。系统开了 Reduce Motion 时都不做动画。

### 5.3 点击

- 卡片行：打开这张卡的侧栏。卡在别的项目时先切到那个项目（复用卡片链接的打开路径，`client/session-link.ts`）。
- 命中行：同样打开侧栏，再定位到命中的那一条（DRAWER-SPEC“Focus from search”）：

  | 命中来源 | 分区 | 定位到 |
  |---|---|---|
  | `summary` | Progress | 分区本身（只有一份最新摘要） |
  | `note` | Activity | 那条事件 |
  | `workpad` | Workpad | 那条验收、检查或疑问（`refId` 是条目 id） |
  | `idea` | Ideas | 那条想法；已关闭的想法先展开“Closed” |
  | `artifact` | Artifacts | 那条交付物 |
  | `card` | 无 | 只打开侧栏（描述就在顶部） |

  定位到的那一条里，命中的词本身加强调色底色并用粗体强调色标出（不再给整条描边），一直保持到侧栏关闭；命中在被截断或折叠的部分时，那一条展开显示（笔记不限行数、检查显示完整命令和输出、摘要和想法打开 Show more、交付物显示完整链接或路径，DRAWER-SPEC“Focus from search”第 6、7 条）。

  分区只在这次打开时展开，不改用户保存的展开偏好。目标不在当前显示范围（Activity 只列最近 12 条、Workpad/Artifacts 分页）时先把范围扩到它；1.5 秒内还没渲染出来就退回到分区本身。滚到目标后，没有可标的词时（卡片字段命中、退回分区）给它约 1.6 秒的强调色描边；系统开了 Reduce Motion 时直接跳过去，不做滚动动画。
- 记忆行：打开 Memory 页。
- Search 页保持打开，关掉侧栏后结果还在。

### 5.4 请求与性能

- 每次停止输入 250 ms 后发一次请求；新请求发出时丢弃旧请求的结果（react-query 以 `[projectId, query, sources]` 为 key，保留上一页结果直到新结果到达）。
- 不轮询、不在后台刷新；重新打开 Search 页时重新查询一次。
- 一次响应最多 50 张卡 × 3 条片段 × 160 字符，约几十 KB 以内。
- Search 页组件和结果行 `React.memo`；页面关闭即卸载，不留订阅。

## 6. agent 工具：`flowly_search`

只读，只要身份，不需要 `request`，不改卡片状态和 revision。

```ts
input = {
  query: string,           // 1–200，语法同 §3.1
  sources?: Source[],      // 不含 "memory"
  limit?: number,          // 1–20，默认 10
}
output = {
  cards: Array<{
    taskId, title, status, type?, tags: string[], archived: boolean, updatedAt,
    summary?: string,      // 最新摘要的 state + recap，最多 400 字符
    hits: Array<{ source, snippet }>,   // ≤3，同 §3.2
  }>,
  truncated: boolean,
}
```

- 范围：调用者所在卡的项目；排除调用者自己的卡。
- 带上最新摘要，因为 agent 没有读别的卡的工具，片段加摘要通常就够判断要不要参考那张卡。
- 工具描述（英文）：
  > Search earlier cards in this project: their titles, descriptions, summaries, progress notes, workpads, ideas and deliverables (PR links, Jira keys, file paths). Use it when you start on an area to find related or duplicate work and how it was verified. Project memory is not included; use flowly_recall for it. Read-only; no request needed.
- CLI：`search --query <words> [--sources a,b] [--limit n]`（不需要 request 文件）；HTTP `/api` 新增 `"search"` 读动作。
- 技能文本（`server/skill-source.ts` 生成的 SKILL.md）在 Details 里 `flowly_recall` 那条后面加一句：
  > Use flowly_search to find earlier cards in this project (summaries, notes, workpads, ideas, deliverables) when you start on an area or before proposing an idea that may already exist.
- 不加进 turnChecklist，不在 get_task 里提示。

## 7. 隐私

- 搜索完全在本机 daemon 里进行。日志只记耗时和结果数，不记查询内容。
- 不新增任何使用数据字段。
- agent 能通过 `flowly_search` 读到同一项目其他卡的笔记和片段；这和它今天在 get_task 里看到的 links、ideas 属同一项目范围，不跨项目。

## 8. 新用户引导与文案

- 一次性提示 `search`：当前项目有 10 张以上未归档卡片、且没打开卡片时出现一次，排在 card-display 之后。文案：*Find past cards, notes, workpads and deliverables with the search button or S.*
- 欢迎导览最后一页的 More features 列表加一条：*Search past cards, summaries, notes and deliverables.*
- What's new 新版本条目：*Search past cards, summaries, notes, workpads, ideas and deliverables. Agents can search them too.*
- README 亮点加一行。所有新文案加进全部语言目录（I18N-SPEC）；agent 侧文本保持英文。

## 9. 错误

| 情况 | 结果 |
|---|---|
| 查询为空 | 空结果，不报错 |
| 查询超过 200 字符、`limit` 越界、未知 `source` | RPC 输入校验失败；agent 工具返回 `INVALID_INPUT` |
| `projectId` 不存在或已归档 | `Project not found.` |
| 看板存储不可用 | 原样返回存储错误（`STORAGE_BUSY` 等） |
| 摘要或记忆文件读不出来 | 不报错，`partial` 标出 |
| agent 工具：身份无效 | 与其他 `flowly_*` 读工具相同的错误 |

## 10. 不在 v1

- FTS5 索引。在以下任一情况出现时另开卡：daemon 不再缓存整板；或单次搜索在真实数据上超过 50 ms。届时用同一个库，建 trigram FTS5 表，在写入事务里随变化的行一起更新，1–2 个字的词走逐条比对。
- 搜索会话记录、分页、高级语法（`type:`、`status:`、日期）、保存的搜索。

## 11. 验收

**实现者自测**（交付前）：`npm run typecheck`、`npm test`，以及下列聚焦测试：

1. 每个来源都能命中各自的字段；不搜的内容（回执、系统事件、旧版摘要、非 active 记忆、已归档项目）不出现。
2. 多个词分散在同一张卡的不同来源时能命中；任一词缺失时不命中；引号短语按整体匹配；`#tag` 与前缀过滤和看板一致。
3. 大小写、全角/半角 ASCII 视为相同；中文一个字、两个字的词都能命中。
4. 片段不超过 160 字符，`ranges` 指向片段里的命中词；每张卡最多 3 条命中。
5. 排序：权重 → 未结束/结束/归档 → 时间；记忆在卡片之后。
6. `limit` 与 `truncated`；`projectId: null` 跨项目且不含已归档项目；未知或已归档项目报 `Project not found.`；非法输入被拒。
7. 摘要或记忆文件损坏时其余结果照常返回，`partial` 正确。
8. `flowly_search`：只搜本项目、排除自己的卡、不含记忆、带最新摘要且不超过 400 字符；CLI `search` 与 HTTP `"search"` 返回同样结果。
9. 性能：在把用户数据规模放大 10 倍的合成数据上（约 5 万条事件），daemon 单次搜索不超过 50 ms。
10. 新提示的规则在 `client/onboarding-logic.test.ts` 中覆盖；i18n 测试通过。

**UI 实测**（按 AGENTS.md 用 `docs/promo/shot-lib.mjs`，在 Tinylink 演示项目上）：桌面和紧凑布局打开 Search 页、输入、切范围、筛来源、点开卡片（含跨项目）、`S` 快捷键、Esc 关闭。证据写入 `docs/verification/search-<日期>/`。

**里程碑独立验收**（合并前，由未写代码的 `claude/claude-haiku-5-5` 会话执行）：在实现提交上复跑以上检查。
