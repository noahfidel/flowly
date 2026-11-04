# 外部工单接入（Jira / Linear）：只读输入

状态：用户 2026-10-19 确认（§10），P1 已实现。2026-10-19 · 卡片“jira工单接入”。

> 2026-10-20 起由 [CONNECTORS-SPEC](CONNECTORS-SPEC.md) 推广到 Confluence、GitHub、GitLab，并按用户决定改用通用名：artifact 字段 `ticket` → `external`（看板 v5），工具 `flowly_read_ticket` → `flowly_read_external`（旧名为别名），CLI `ticket` → `external`，RPC `tickets.*` → `connectors.*`，错误码 `TICKET_*` → `EXTERNAL_*`，数据目录 `tickets/` → `connectors/`。下文保留 Jira 当时的命名；行为规则仍然有效。

## 0. 用户决定与结论

用户问题：接入 Jira、Linear 这类工单系统，但用 Flowly 管理工作，应该怎么做？以 Jira 为例，status 应该隔离还是合并？

用户决定（2026-10-19）：**工单系统只作为输入和引用。Flowly 的状态流转完全不影响外部工单系统，只把工单内容作为输入。**

用户描述的典型场景（2026-10-19）：

1. 绑定 Jira 之后，在 New task 表单里点 **From Jira**，自动列出最近 5–10 个指派给我的工单，也可以按标题文字或工单号搜索。
2. 选中工单后，若卡片标题还没填，就预填为工单标题；已经填写的不覆盖。之后的流程与现在一样。
3. 已有卡片也能用同样的流程关联 Jira 工单。
4. 之后每一轮，agent 都能像感知 artifacts 一样，知道卡片关联了工单，并读到工单里的内容。

由此得出四条：

1. **完全隔离，单向只读**。Flowly 从不写工单系统：不 transition、不评论、不加 remote link、不改字段。数据只从工单流向 Flowly。
2. **工单状态不驱动卡片**。工单状态只作为参考信息显示，不移动卡片、不触发提示、不计入 Attention。卡片状态仍由人和 agent 按现有规则决定。
3. **工单是一种 input artifact**。卡片的 Artifacts 已经有“输入/输出、人/agent 添加、unread”这套语义（CARD-ARTIFACTS-SPEC），工单链接直接作为 input 加入，daemon 识别后补上工单内容。不新增“卡片关联工单”这类一对一绑定，一张卡可以引用多个工单，一个工单也可以被多张卡引用。
4. **凭据只在 daemon**。Jira 需要登录，agent 打不开链接，所以由 daemon 读取工单，再通过工具交给 agent。agent 拿不到 token，也只能读自己卡片上引用的工单。

为什么不合并状态（上一版的分析，仍然成立）：Flowly 是固定的 9 个状态，Jira 的工作流按项目、按 issue type 任意定义，只能走 transition，还带条件和必填字段；Flowly 的阶段随 agent 每轮工作变化，Done 还会触发收尾和归档。只读方案不需要处理映射、冲突和失败重试，所以更简单。

## 1. 范围

| 做 | 不做 |
| --- | --- |
| 配置工单系统连接（Jira DC / Jira Cloud；Linear 放在 P2） | 任何写操作：状态、评论、字段、worklog、remote link |
| 把工单链接或 key 加为卡片 input，自动识别并显示 key、标题、状态 | 根据工单状态移动卡片、提示偏离、自动收尾 |
| agent 通过工具读取工单正文、评论、子任务和关联工单列表 | agent 访问卡片未引用的工单，或执行任意 JQL |
| New task 中的 **From Jira** 选择器（我的最近工单 + 搜索），以及已有卡片的 **Link Jira ticket** | 自动按 JQL 建卡；后台定时轮询；批量导入（P2） |
| 工单内容变化后，对 agent 标为 unread | 下载附件内容（Jira DC 的 PAT 无法下载附件，JRASERVER-72019） |

worktree 分支名、commit message 带工单 key 会让 Jira 的 GitLab 开发面板显示关联，这属于间接影响，**默认不做**，skill 里也不要求。用户自己在分支名里写 key 不受限制。

## 2. 连接（Connections）

- 设置新增 **Connections** 分区（与 General / Models / Workflow / AI features 并列）。新增连接：provider（`jira-dc` / `jira-cloud`，P2 加 `linear`），base URL，凭据，显示名。
- 新增或编辑连接时，在 Connections 页内原地切换为编辑表单（带返回按钮），**不另开弹窗**：设置窗口本身是 React Native Modal，在它上面再打开宿主 Modal，两层焦点陷阱会互相抢焦点，导致整个 Paseo 卡死（2026-10-19 用户报告）。
- **Test connection** 按钮（RPC `tickets.connection-test`）调用 `GET /rest/api/2/myself`，只校验地址和令牌、不保存，在表单内显示“连接正常，已连接为 X”或错误原因；编辑已有连接时，令牌留空即用已保存的令牌测试。结果只对应测试时的地址、类型、邮箱和令牌，任一改动后结果隐藏。**Save** 同样先校验，失败不保存。
- 鉴权：
  - Jira Data Center（如 jira.shopee.io）：Personal Access Token，`Authorization: Bearer`；
  - Jira Cloud：邮箱 + API token，Basic。用 API token 的请求不计入 2026-03 起执行的按点数小时配额，只受突发限制；
  - Linear：personal API key，`Authorization: <key>`，不加 Bearer。
  - 不做 OAuth：Cloud 3LO 要注册应用，DC 要管理员建应用链接，对本机个人工具不划算。
- 凭据通过 RPC 交给 daemon，存 `<plugin-data>/tickets/credentials.json`（目录 0700、文件 0600），**永远不返回客户端**。界面只显示“已配置 · 用户名 · 上次验证时间”，可以替换或删除，不能查看。日志、错误、活动、agent 输出里只出现 key，不出现凭据或请求头。
- 不读取其他工具的凭据文件（例如 `~/.config/sra/credentials.json`）。
- 连接是 host 级，所有项目共用。
- **删除连接**（2026-10-19 用户问及，已实现）：
  - 确认时显示有多少张卡片带有这个 Jira 的工单，并说明后果；
  - 卡片上的工单 input 原样保留（链接、key、标题、`ticket` 字段都不改），卡片面的 key 照常显示；该连接的缓存会清掉；
  - 侧栏工单行显示“连接已移除”，预览提示重新添加连接，“在 Jira 中打开”仍然可用；
  - agent 看到 `get_task.artifacts[].ticket.connection = "removed"`，没有 unread；`flowly_read_ticket` 返回 `TICKET_UNAVAILABLE`，并提示 agent 告诉用户、不要猜内容；新 session 的上下文里，这一行写“连接已移除，无法读取，问用户”，不再提示调用 `flowly_read_ticket`；
  - **重新添加同一个 Jira 后自动恢复**：工单 input 先找自己记录的连接；找不到时，改用当前任一 base URL 能识别其链接的连接（`TicketService.locate`），所以新连接 id 不同也能用，不需要改动看板数据。

## 3. 工单 input

### 3.1 识别

- 人或 agent 添加 url 类型的 artifact 时，daemon 用已配置连接的 base URL 匹配：
  - Jira：`<base>/browse/KEY-123`，以及带 `selectedIssue=KEY-123` 参数的看板链接；
  - Linear：`linear.app/<workspace>/issue/ENG-42/...`（已实现，规则见 [CONNECTORS-SPEC §14](CONNECTORS-SPEC.md)）。
- 主要入口是 §5 的工单选择器。Artifacts 添加表单里也可以直接粘贴链接或只填 key（`SHOPSR-123`）：只有一个 Jira 连接时直接拼成 URL，有多个时选择连接。
- 匹配成功即为**工单 input**：`role` 固定为 input（工单不能作为 output），`title` 默认用 `KEY summary`。匹配失败仍是普通链接，与现在一样。

### 3.2 数据

artifact 只新增一个可选字段，board.json 不升版本：

```ts
// shared/model.ts，artifactSchema
ticket: z.object({
  connectionId: z.string(),
  provider: z.enum(["jira-dc", "jira-cloud", "linear"]),
  key: z.string().max(64),       // SHOPSR-123；工单移到其他项目后 key 会变，以 remoteId 为准
  remoteId: z.string(),
}).optional(),
```

工单内容存在 board.json 之外的快照缓存 `<plugin-data>/tickets/cache.json`，按 `connectionId:remoteId` 存。快照内容：summary、状态（名称和类别）、类型、优先级、指派人、报告人、远端 `updated`、内容指纹、拉取时间。正文与评论也在这里，读时转换为 Markdown。缓存不改看板 revision，也不改变看板 etag（PERFORMANCE-SPEC）。

内容指纹是 summary、描述、评论 ID 及其更新时间、子任务列表的哈希。只有状态、指派人这类字段变化时，指纹不变。

### 3.3 刷新：按需，不做后台轮询

daemon 只在有人需要时拉取，同一工单 60 秒内复用缓存：

| 时机 | 拉取内容 |
| --- | --- |
| 选择器列表与搜索、添加工单 input | 摘要字段（选择器结果也写入缓存） |
| agent 调 `flowly_get_task` | 本卡所有工单的摘要字段，用来计算 unread。按连接批量查询 `key in (…≤50)`，只取 `summary,status,updated,…` |
| agent 调 `flowly_read_ticket` | 完整内容：正文、评论、子任务、关联工单列表、附件名 |
| 侧栏打开卡片 / 工单预览 | 摘要字段；展开时拉完整内容 |
| 看板上的卡片面徽标 | 不拉取：卡片面只显示 key（§10），key 存在 artifact 上 |
| 侧栏 Artifacts 的状态标签 | `tickets.card`，缓存 30 分钟内直接返回；不为徽标计算内容指纹 |

接口：
- Jira DC：`GET /rest/api/2/search`、`GET /rest/api/2/issue/{key}?fields=…&expand=renderedFields` 和 `/comment`；
- Jira Cloud：旧 `/search` 已下线，用 `/rest/api/3/search/jql`（`nextPageToken` 分页）。正文读 v2 接口，拿到 wiki markup，与 DC 统一，不处理 ADF；
- 所有请求都在 daemon 里用 `fetch`，有超时，并显式传 `fields`。

错误：
- 429/5xx 时，等待不少于 `Retry-After`，退避上限 5 分钟，期间继续用旧缓存并标注“可能过期”；
- 401/403 时，连接标为“凭据失效”，不重试，设置页和相关卡片都显示；
- 404 时，工单 input 标为 Missing，与文件 artifact 的 Missing 一致。
- 远端出错时，看板和 agent 读取都照常工作，只是少了新内容。

## 4. Agent 侧

### 4.1 `flowly_get_task`

`artifacts[]` 里工单 input 多出：

```json
"ticket": { "key": "SHOPSR-123", "summary": "…", "status": "In Progress", "statusCategory": "started",
            "type": "Bug", "priority": "P1", "assignee": "…", "updated": "…", "stale": false }
```

`unread` 规则扩展为：artifact 本身在本 session 上次读取后被添加或编辑，**或**工单内容指纹在上次读取后变化。只有状态或指派人变化时不算 unread，这些不是需求变化。读取时间沿用 `artifact-reads.json`，另存每个 session 最后看到的指纹。

### 4.2 新工具 `flowly_read_ticket`（+ CLI `ticket <artifactId>`）

- 入参：`artifactId`，只能是**本卡**的工单 input。agent 想看关联工单时，先用 `flowly_add_artifact` 把它的链接加为 input，再读取，这样人能在卡片上看到 agent 引用了什么。
- 返回 Markdown：标题、元数据（状态、类型、优先级、指派人、报告人、组件、版本、标签）、描述、最近 20 条评论（作者、时间）、子任务和关联工单（key、标题、状态、关系）、附件名列表。超过 32 KB 时截断，并附工单 URL。
- 只读，不写回执，也不改看板 revision。返回结果把内容推进为“已读”，与 `flowly_get_task` 推进 artifact 已读的规则一致。
- 错误码：`TICKET_NOT_FOUND`、`TICKET_AUTH`（连接凭据失效，请用户在设置中更新）、`TICKET_UNAVAILABLE`（远端不可用，附缓存时间和缓存内容）、`TICKETS_DISABLED`。

### 4.3 skill 与 session 上下文

- 建 session 时注入的 Inputs 段中，工单行写成 `- [user] SHOPSR-123 <summary> (Jira, In Progress): <url>`，并提示用 `flowly_read_ticket` 读取全文。
- skill 增补：
  - 工单 input 是任务需求，开工前用 `flowly_read_ticket` 读完；unread 时先重读；
  - 工单状态只是参考，不要据此设置卡片阶段，也不要尝试修改工单；
  - 工单描述与用户指令冲突时，以用户指令为准；拿不准就用 `kind=question` 问用户；
  - 交付时写明依据了哪些工单。
- 普通 follow-up 仍只发用户原文，不附加工单内容。

## 5. 选择工单：From Jira 与 Link Jira ticket

新建卡片和关联已有卡片共用一个**工单选择器**，只在至少配置了一个 Jira 连接时出现。

### 5.1 入口

| 入口 | 位置 | 选中后 |
| --- | --- | --- |
| **From Jira** | New task 表单顶部，标题字段上方的按钮 | 表单顶部出现工单条（key、标题、状态、✕ 取消）；标题为空时预填（见 §5.3）；提交时卡片与工单 input **一起创建** |
| **Link Jira ticket** | 卡片详情菜单，以及侧栏 Artifacts 区块的 Add 菜单 | 立即给该卡添加工单 input，toast “Linked SHOPSR-123”。**不改**卡片标题和其他字段 |

两处都可以多次使用，因为一张卡可以引用多个工单。已经在本卡上的工单在列表中显示为已关联，不能重复选择。

### 5.2 选择器内容

- 打开时显示**我的最近工单**：最近更新的 10 个指派给我的未完成工单。
  - 查询：`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`，`maxResults=10`，只取 `summary,status,issuetype,priority,updated`。
  - 每行显示类型图标、key、标题、状态（中性色）、相对更新时间。若该工单已被本项目的其他卡片引用，加一行灰字 “On card ‹title›”，仍然可以选择。
- 顶部搜索框，可以输入：
  - **工单号**：`SHOPSR-123`，大小写不敏感，直接按 key 取这一张；
  - **工单链接**：粘贴 browse 链接，解析出 key 后同上；
  - **纯数字**：`123`，在最近工单出现过的项目 key 中组合候选（如 `SHOPSR-123`），找到几个就列几个；
  - **文字**：用 Jira 的 issue picker 接口 `GET /rest/api/2/issue/picker?query=…`（Jira 自己的输入框就用它，DC 和 Cloud 都有，按 key 和标题做模糊匹配）。拿不到结果时退回 JQL `summary ~ "<文字>*" ORDER BY updated DESC`。
  - 文字搜索**不限**指派人，可以选任何你有权限看的工单。
- 输入按 300 ms 防抖（`TextBox` 的 `commitDelay`），至少 2 个字符才搜，新结果到达时丢弃旧请求的结果。
- 用户输入只作为 JQL 字符串字面量拼入：转义 `\` 和 `"`，并去掉 Jira 文本搜索的保留字符，不拼接任何 JQL 关键字。
- 空状态与错误：
  - 无结果：“No matching tickets”；
  - 凭据失效：“Jira connection needs a new token”，并提供 Open settings；
  - 网络错误：“Jira is unreachable” 和 Retry。
  - 这些都不会阻塞表单，用户可以关掉选择器，照常手动建卡。
- 多个 Jira 连接时，选择器顶部可以切换连接，默认用上次使用的连接（host 级设置 `lastTicketConnection`）。

### 5.3 新建卡片时的预填

- 选中工单时，**只有标题为空才预填**为工单 summary（不带 key，key 以徽标显示）。用户已经输入了标题就保持不变。
- 用户换选另一个工单时，如果标题仍是上一个工单预填的原文、没有被改过，就替换为新工单的 summary；改过就保留。取消选择（✕）不清空标题。
- 其他字段（描述、状态、优先级、类型、标签、workspace、首条消息）**都不预填**，流程照旧。
- 实现注意：按 AGENTS.md 文本输入规则，原生端标题输入框自己持有文字。预填属于外部变化，做法是更换种子值并重挂载标题字段，只在标题为空或仍等于上次预填值时这样做。不通过 `value` 回写用户输入。

### 5.4 创建与关联的数据写入

- `taskInput` 新增可选字段 `tickets?: [{ connectionId, key }]`（最多 5 个）。`tasks.create` 在**同一次提交**里建卡和对应的工单 input artifact（`createdBy: human`，事件 `artifact_added`），这样“建卡时启动 agent”生成的首个 session 上下文里已经有工单。
- 写入前，daemon 用该连接再读一次工单，确认存在且有权限，同时得到 `remoteId` 和快照。读取失败时整次创建失败，并显示原因；表单保留内容，用户可以去掉工单后再提交。
- Link Jira ticket 走现有的 `artifacts.create`，target 是工单 URL，由 §3.1 的规则识别为工单 input，校验方式相同。
- 两条路径都只读 Jira。

## 6. 界面

- **卡片面**：有工单 input 时，标题行前显示第一个工单的 key 徽标，多个时显示 `KEY +2`。状态只在 tooltip 和侧栏显示，卡片面不放工单状态，避免与卡片 lane 混淆。
- **侧栏**：
  - Artifacts 区块里，工单行显示 provider 图标、key、summary、状态小标签（中性色，不用 lane 的颜色）、“更新于”。点开为工单预览：元数据、正文、评论、子任务，带 Open in Jira 和 Refresh；
  - Add 菜单增加 Link Jira ticket。
- **New task 表单**：From Jira 按钮和工单条见 §5。没有 Jira 连接时不显示按钮；第一次打开表单时，可以通过 tip 引导到设置里绑定。
- **设置 Connections 页**：见 §2。
- 按项目约束：
  - 文案走 `t()`，并加入全部 9 个语言目录；
  - 新增两个一次性 tip：`jira-connect`（有项目但没有连接时，在 New task 表单里提示可以绑定 Jira）和 `first-ticket`（第一次关联工单后说明“工单只作为输入，Flowly 不会修改它，agent 每轮都能读到”）；
  - 欢迎页功能列表加一行，README 同步更新；
  - 选择器列表项和徽标用 memo，打开和关闭用统一的短动画。

## 7. 删除与收尾

- 删除工单 input、删除卡片、移除项目时，只删除 Flowly 的记录。没有被任何卡片引用的快照在下次启动时清理。远端工单不受影响。
- 收尾和归档不涉及工单。

## 8. 分期

| 期 | 内容 |
| --- | --- |
| **P1** | Jira DC + Cloud 连接；工单选择器（我的最近工单、key/链接/数字/文字搜索）；New task → From Jira（标题预填、原子创建）；Link Jira ticket；工单 input 识别与快照；`get_task.ticket` 与 unread；`flowly_read_ticket` / CLI；侧栏工单预览；卡片 key 徽标；skill、tip、i18n |
| **P2** | ~~Linear provider~~（已实现：GraphQL，按 `updatedAt` 排序；限流现在以 HTTP 429、错误码 `RATELIMITED` 返回，旧形式是 HTTP 400，两者都按限流处理；见 [CONNECTORS-SPEC §14](CONNECTORS-SPEC.md)）；按 JQL 批量导入；新工单收件箱（与 Ideas 收件箱同一模式）；从工单的关联工单中一键加为 input |

## 8.1 实现记录（P1，2026-10-19）

- 共享：`shared/tickets.ts`（连接与快照 schema、key/链接识别、搜索分类、JQL 字面量转义、wiki → Markdown）。
- daemon：`server/tickets.ts`
  - `ConnectionStore`：`<plugin-data>/tickets/connections.json`，0600，`.bak` 同样 0600；
  - `JiraClient`：只发 GET，路径限定在白名单内，`redirect: "error"`，15 秒超时，返回非 JSON 视为凭据失效；
  - `TicketService`：搜索、识别、快照缓存 `cache.json`、详情 60 秒缓存、退避；
  - `TicketReadStore`：`ticket-reads.json`，记录每个 session 看到的内容指纹。
- RPC：`tickets.connections`、`tickets.connection-test`、`tickets.connection-save`、`tickets.connection-delete`、`tickets.search`、`tickets.card`、`tickets.read`。
- 已有接口的改动：
  - `artifacts.create` 与 agent 的 `flowly_add_artifact` 都会先识别工单链接或 key；
  - `tasks.create` 接受 `tickets`；
  - 设置 `board-view.lastTicketConnection`；
  - `Field` 增加 `secure`，令牌输入不显示明文。
- agent：
  - `get_task.artifacts[].ticket`；
  - `flowly_read_ticket`，CLI 为 `ticket --id`；
  - skill 增加工单段落，`skills/paseo-ultra-kanban/SKILL.md` 同步。
- 客户端：
  - `client/tickets.tsx`：Connections 页、TicketPicker、TicketChip、LinkTicket、TicketPreview；
  - New task 的 From Jira（`client/forms.tsx`）；
  - 侧栏 Artifacts 的工单行、Link Jira ticket 与预览（`client/task-artifacts.tsx`）；
  - 卡片 key 行（`client/card.tsx`，`client/board.tsx` 计算）；
  - tip `first-ticket` / `jira-connect`、欢迎页功能行、README；
  - 9 个语言目录各 49 条新文案。
- Linear 当时尚未加入 provider 枚举；2026-11-03 作为 connector 族 `linear` 加入（CONNECTORS-SPEC §14）。

## 9. 测试要点

- 选择器：
  - 最近工单的查询和字段；
  - 搜索输入的分类：key、链接、纯数字、文字；
  - JQL 字面量转义（引号、反斜杠、保留字符）；
  - 防抖与过期结果丢弃；
  - 401、网络错误时表单仍可提交；
  - 已在本卡上的工单不可重复选择；其他卡片引用的显示提示。
- 预填：
  - 标题为空时预填；已填写时不覆盖；
  - 换选工单时只替换未改过的预填标题；
  - 取消选择不清空标题。
- 创建：
  - 卡片和工单 input 在同一次提交里创建；
  - 首个 session 上下文里有工单行；
  - 工单读取失败时不建卡；
  - Link 不改卡片标题。
- 识别：DC、Cloud 的 browse 链接、看板 selectedIssue 链接、只填 key、多连接选择；非工单链接保持普通链接。
- 只读保证：用 mock HTTP 服务断言 Flowly 只发 GET，以及 DC search 的只读 POST。provider 层用方法加路径白名单，白名单之外直接抛错。
- unread：内容指纹变化算 unread，只有状态或指派人变化不算；session 自己添加的工单 input 不算。
- 错误：401 标记连接失效，404 标 Missing，429 遵守 `Retry-After`，远端不可用时返回缓存。
- 凭据：RPC 返回值、日志、工具输出中都没有 token。
- 工具作用域：`flowly_read_ticket` 拒绝其他卡片的 artifact 和普通链接。

联调：mock Jira 覆盖 DC 和 Cloud 两种响应；真实 jira.shopee.io 只读验证，用用户指定的工单。按项目要求，用 full-access 的 `codex/gpt-6-luna` session 做 UI 验收，覆盖桌面和手机布局，证据存 `docs/verification/external-tracker.md`。

## 10. 已定问题（2026-10-19 用户）

1. P1 同时支持私有部署的 Jira（Data Center/Server，如 jira.shopee.io）和公共的 Jira Cloud。
2. “我的最近工单”排除已完成的工单，取 10 个。
3. 卡片面只显示工单 key，不显示工单状态。

## 参考

- 现有设计：CARD-ARTIFACTS-SPEC（input/unread/预览）、IDEAS-INBOX-SPEC（收件箱模式）、PERFORMANCE-SPEC（etag、按需读取）、AUTO-STATUS-SPEC / WORKFLOW-STAGES-SPEC（卡片状态规则，本设计不改）
- 同类做法：Devin、Cursor、Codex 接入 Jira/Linear 时，都以工单为任务输入，回写的只有评论和 PR 链接。本设计连这两项也不回写。
- 外部资料（2026-10-19 查阅）：
  - Jira DC PAT：https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html ；附件限制 https://jira.atlassian.com/browse/JRASERVER-72019
  - Jira 搜索：Cloud https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API ；DC https://developer.atlassian.com/server/jira/platform/jira-rest-api-example-query-issues-6291606/
  - JQL 时区：https://jira.atlassian.com/browse/JRACLOUD-81174
  - Jira 限流与 webhook：https://developer.atlassian.com/cloud/jira/platform/rate-limiting ；https://developer.atlassian.com/cloud/jira/platform/webhooks/
  - ADF：https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
  - Linear API、过滤、限流：https://linear.app/developers/graphql ；https://linear.app/developers/filtering ；https://linear.app/developers/rate-limiting
  - Devin for Jira：https://docs.devin.ai/integrations/jira.md ；Cursor + Linear：https://cursor.com/docs/integrations/linear ；Codex + Linear：https://developers.openai.com/codex/integrations/linear
