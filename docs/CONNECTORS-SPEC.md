# 更多 connector：Confluence / GitHub / GitLab 作为只读输入

状态：用户 2026-10-20 确认（§11），已实现；Luna 6 验收通过，真实 GitLab（git.garena.com）与 Confluence（confluence.shopee.io）联调通过（[证据](verification/connectors.md)）；GitHub 真实联调待令牌。2026-10-20 · 卡片“更多connector接入”。

前置：[EXTERNAL-TRACKER-SPEC](EXTERNAL-TRACKER-SPEC.md)（Jira 工单作为只读 input，已实现）。本 spec 把那套机制推广为通用的 **connector**，并接入 Confluence、GitHub、GitLab。凡本文没有改写的规则，沿用 EXTERNAL-TRACKER-SPEC。

## 0. 用户要求与结论

用户要求（2026-10-20）：设计接入更多 external connector，包括 Confluence、GitHub、GitLab 等；Artifacts 的 **+** 按钮统一把这些 connector 收拢到一起；然后分别为每个 connector 做接入。

结论：

1. **沿用 Jira 的四条原则**：单向只读；外部状态不驱动卡片；外部条目是一种 artifact，默认 input（agent 自己开的 PR/MR 可以登记为 output，§3.1）；凭据只在 daemon。GitHub/GitLab 的 PR/MR 也一样：Flowly 不评论、不 approve、不合并、不改标签，PR 自动化仍在 v1 范围外（AGENTS.md）。
2. **一个 connector 框架，四个 provider 族**：Jira（已有）、Confluence、GitHub、GitLab。识别链接、选择器、快照缓存、unread、agent 读取、设置页全部走同一套接口，provider 只实现“怎么认链接、怎么搜、怎么读、怎么转 Markdown”。
3. **Artifacts 只有一个 +**：点开是添加菜单，“文件或链接”加上每个已连接的 connector；侧栏不再单独放 Jira 图标按钮。粘贴任何已连接服务的链接，照样自动识别。
4. **改用通用名**（用户 2026-10-20 决定，§3.3）：artifact 字段 `ticket` → `external`，工具 `flowly_read_ticket` → `flowly_read_external`，CLI `ticket` → `external`，RPC `tickets.*` → `connectors.*`。旧工具名与 CLI 命令保留为别名，看板升到 v5 并迁移数据。

## 1. 范围

| 做 | 不做 |
| --- | --- |
| 通用 connector 框架；把 Jira 迁到框架上，行为不变 | 任何写操作：评论、review、approve、merge、改状态/标签、建分支 |
| Confluence 页面（DC + Cloud） | Confluence 附件内容、空间/页面树批量导入、blog post（P2） |
| GitHub issue 与 pull request（github.com + Enterprise Server） | PR diff 正文（agent 用 git 自己看）、Actions/CI 状态（P2）、Discussions |
| GitLab issue 与 merge request（gitlab.com + 自建，如 git.garena.com） | MR diff 正文、pipeline 状态（P2）、epic、wiki、snippet |
| Artifacts 统一 + 菜单；New task 的 From Jira 泛化为 From…；设置 Connections 页四个分组 | 后台轮询、webhook、OAuth、读取 `gh`/`glab`/sra 等其他工具的凭据 |
| agent 通过 `flowly_read_external` 读任意 connector 条目；内容变化标 unread | agent 访问卡片未引用的条目，或执行任意搜索 |

Linear 当时是 EXTERNAL-TRACKER-SPEC 的 P2，本卡不做；后来作为第六个 provider 族接入，见 §14。

## 2. 条目类型

| provider 族 | provider id | 条目类型 `itemType` | key（显示与 agent 使用） | 卡片面徽标 |
| --- | --- | --- | --- | --- |
| Jira | `jira-dc` / `jira-cloud` | `issue` | `SHOPSR-123` | `SHOPSR-123` |
| Confluence | `confluence-dc` / `confluence-cloud` | `page` | 页面 id（`123456`），显示用页面标题 | 不显示（文档不是工作项） |
| GitHub | `github`（github.com 与 GHES 共用） | `issue` / `pull` | `owner/repo#12`（issue 与 PR 同一编号空间） | `repo#12` |
| GitLab | `gitlab`（gitlab.com 与自建共用） | `issue` / `merge_request` | `group/sub/proj#12`、`group/sub/proj!34` | `proj#12`、`proj!34` |

卡片面按 EXTERNAL-TRACKER-SPEC §6：只显示第一个可显示条目的 key，多个时 `KEY +2`；不显示外部状态。Confluence 页面只在侧栏 Artifacts 里显示。

## 3. 数据

### 3.1 artifact

`artifactSchema.ticket` 改名为 `external`，并扩展取值；board.json 升到 **v5**（§3.3）：

```ts
// shared/connectors.ts
export const connectorProviders = ["jira-dc", "jira-cloud", "confluence-dc", "confluence-cloud", "github", "gitlab"] as const;

// shared/model.ts，artifactSchema
external: z.object({
  connectionId: z.string(),
  provider: connectorProviderSchema,
  key: z.string().max(300),          // 旧 64 上限放宽：GitLab 路径可以很长
  remoteId: z.string().max(64),      // Jira issue id / Confluence page id / GitHub node id / GitLab 全局 id
  itemType: z.enum(["issue", "pull", "merge_request", "page"]).optional(), // 缺省 = issue（旧 Jira 数据）
}).optional(),
```

**role（2026-10-21 修订）**：外部条目的 `role` 与普通条目一样由调用方决定，服务端不再强制为 input。默认仍是 input：人在 + 菜单的选择器和“文件或链接”里粘贴都默认 input（表单有 Role 选择器，可选 output）。典型的 output 是 agent 自己开的 PR/MR，它保留实时状态（Open / Merged）。output 外部条目不是任务需求，skill 不按需求对待它（§9）；人可以在编辑里改 role，agent 重复登记自己添加的条目时也可改 role。**agent 不能改人添加的条目**：重复登记时 role 不同，工具结果带 `notice`（“Already added by the user as input; role not changed.”），不再静默。旧数据里被强制为 input 的条目不迁移。

旧数据全部是 Jira，`itemType` 缺省即 `issue`。v4 → v5 迁移只做一件事：把每个 artifact 的 `ticket` 改名为 `external`，其余原样保留；第一次写入前留一份 `board.pre-v5.json`（与 v4 迁移的做法相同）。旧版本 plugin 读到 v5 文件会校验失败并保留文件，不会重置数据，也不会悄悄丢掉 `external` 字段。

### 3.2 连接与缓存

- 数据目录 `<plugin-data>/tickets/` 改为 `<plugin-data>/connectors/`：启动时若只有旧目录，就整体 rename 过去（权限随文件保留）；`ticket-reads.json` 改名为 `external-reads.json`。`connections.json` 的 provider 枚举扩展，`version` 仍为 1，旧文件原样可读。连接仍是 host 级。
- 快照缓存 `cache.json` 升为 version 2，key 改为 `connectionId:itemType:key`，每条记录带 provider。旧的 version 1 缓存（只有 Jira）直接作废、按需重新拉取：它只是缓存，unread 用的指纹另存在 `external-reads.json`，不受影响。
- `TicketSummary` 增加 `itemType`、`container`（仓库路径 / Confluence 空间名 / Jira 项目，可空）；Confluence 的 `status` 为空串，`statusCategory` 为空。
- 内容指纹（unread）：

| provider | 指纹来源（状态、指派人、标签变化不算） |
| --- | --- |
| Jira | 不变：summary、描述、评论 id+更新时间、子任务 |
| Confluence | 页面 `version.number`、标题、评论 id+version |
| GitHub | 标题、正文、评论 id+`updated_at`；PR 另加 review id+状态、head sha |
| GitLab | 标题、描述、非系统 note id+`updated_at`；MR 另加 head sha |

PR/MR 的 head sha 计入指纹：新的 push 意味着要 review 的内容变了，应提示 agent 重读。

**output 条目的 unread（2026-10-21）**：agent 自己 push 不应让自己开的 PR 变成 unread。指纹因此写成 `<全部内容>~<讨论部分>`（`server/connectors/fingerprint.ts`）：前半就是原来的指纹（旧值照常比较，不会误报），后半只含评论和 review（GitHub：评论、review；GitLab：非系统 note）。input 条目比较前半（任何内容变化都算）；role 为 output 且指纹带讨论部分时只比较后半，所以新提交、描述修改不算，新评论或 review 才算 unread。Jira/Confluence 没有讨论部分，output 仍比较全部内容。已读记录只有旧格式（无讨论部分）时没有基线，不报 unread，下一次读取后建立。

### 3.3 命名（用户 2026-10-20 决定：改为通用名）

设计稿原本建议保留旧名，理由是兼容。用户听过代价后决定改名，按下表执行：

| 旧 | 新 | 兼容 |
| --- | --- | --- |
| artifact 字段 `ticket` | `external` | board v4 → v5 迁移（§3.1） |
| 工具 `flowly_read_ticket` | `flowly_read_external` | 旧名保留为别名，行为相同，描述标为 deprecated，留给已加载旧 skill 的 session |
| CLI `ticket --id` | `external --id` | 旧命令保留为别名 |
| RPC `tickets.*` | `connectors.*` | 不保留（客户端与 daemon 随插件一起发布） |
| 错误码 `TICKET_*` / `TICKETS_DISABLED` | `EXTERNAL_AUTH` / `EXTERNAL_NOT_FOUND` / `EXTERNAL_UNAVAILABLE` / `CONNECTORS_DISABLED` | 别名工具也返回新错误码 |
| `get_task.artifacts[].ticket` | `external` | Jira 条目同时输出一份 `ticket`（deprecated），供旧 skill 的 session 识别；后续版本删除 |
| 设置 `lastTicketConnection` | `lastConnections`（按族） | 旧值读作 jira 的记忆 |
| 卡片显示字段 `ticket` | `external` | 存储的 `cardHidden` 中的 `ticket` 读作 `external` |
| 代码模块 `shared/tickets.ts`、`server/tickets.ts`、`client/tickets.tsx` | `shared/connectors.ts`、`server/connectors/*`、`client/connectors.tsx` | — |

一次性 tip 的 id（`first-ticket`、`jira-connect`）**不改**：它们记录在用户已存的 `tipsSeen` 里，改 id 会让已经看过的用户再看一次。只更新文案。

## 4. 框架

### 4.1 shared（纯函数，客户端可用）

`shared/connectors.ts`（取代 `shared/tickets.ts`）：

- provider 注册表：族、显示名、条目类型、鉴权字段（是否需要邮箱）、默认地址（`https://github.com`、`https://gitlab.com`）、令牌提示与所需最小权限。
- `recognize(url, connection)` → `{ itemType, key }`：每个 provider 一个识别函数（§5–§7）。
- `parseKey(text, connections)`：裸 key（`SHOPSR-1`、`owner/repo#12`、`group/proj!34`）。只有一个同族连接时直接使用，多个时让用户选连接，与 Jira 规则一致。
- `classifyQuery(provider, text)`：选择器搜索框的分类（recent / key / number / text），各族扩展自己的形式。
- 查询字面量转义：JQL/CQL 共用 `quotedText`；GitHub search 只拼 `in:title` 与已校验的 `repo:owner/name` 限定词；GitLab 用 `search` 参数，不拼查询语言。

### 4.2 daemon

```
server/connectors/
  http.ts        // ReadOnlyHttp：只发 GET，路径必须命中 provider 白名单，redirect:"error"，15 s 超时，非 JSON 视为登录页
  jira.ts        // 现有 JiraClient 与 Markdown 渲染迁入，行为不变
  confluence.ts
  github.ts
  gitlab.ts
  index.ts       // adapterFor(provider)
  service.ts     // ConnectorService（原 TicketService）：连接、缓存、退避、locate、summaries、detail；不含 provider 细节
```

adapter 接口：

```ts
interface ConnectorAdapter {
  verify(c: StoredConnection): Promise<{ account: string; login?: string }>;
  search(c, q: ConnectorQuery, scope: { repos: string[] }): Promise<RawItem[]>;
  get(c, ref: { itemType; key }, full: boolean): Promise<RawItem>;
  getMany?(c, refs): Promise<RawItem[]>;        // 有批量接口的 provider 用（Jira key in、Confluence id in、GitHub GraphQL 不用，见 §6）
  summary(c, item: RawItem): TicketSummary;
  fingerprint(item: RawItem): string;
  markdown(summary, item: RawItem, limit: number): { markdown: string; truncated: boolean };
}
```

错误统一为 `EXTERNAL_AUTH` / `EXTERNAL_NOT_FOUND` / `EXTERNAL_UNAVAILABLE` / `EXTERNAL_INVALID`，退避、凭据失效标记、缓存兜底、`locate`（连接删除后按地址自动恢复）全部在 `ConnectorService` 里对所有 provider 生效。

### 4.3 项目仓库范围（GitHub / GitLab）

GitHub 和 GitLab 上的“全站搜索”结果太杂。daemon 从卡片所在项目根读取 git remote，得到“项目仓库”，用来：

- 解析裸编号：`#12` / `!34` 在只有一个匹配仓库时直接解析；
- 文字搜索：默认只搜项目仓库，选择器里可切换到“所有我参与的”（GitHub `involves:@me`；GitLab `scope=all`）；
- 我的最近条目：不受仓库限制（与 Jira 一致）。

项目仓库 = 项目根本身（若是 git 仓库）以及其一级子目录中的 git 仓库（覆盖 linked root 的 symlink）。用 `git remote get-url` 读取所有 remote（参数数组，不经 shell），只保留 host 与连接地址一致的。结果按项目缓存 5 分钟。RPC `connectors.search` 增加可选 `projectId`。

## 5. GitLab

- **连接**：地址（默认 `https://gitlab.com`，自建如 `https://git.garena.com`）；Personal Access Token，权限 `read_api`（只读）；请求头 `PRIVATE-TOKEN`。校验 `GET /api/v4/user`，账户显示 `name (@username)`。
- **识别**：`<base>/<path>/-/issues/<iid>`、`<base>/<path>/-/merge_requests/<iid>`（含其后的 `/diffs`、`/commits` 等子页面与锚点）、`<base>/<path>/-/work_items/<iid>`（新版 issue 链接）。`<path>` 可以有多级 group。裸 key `<path>#<iid>` / `<path>!<iid>`。
- **我的最近**：`GET /api/v4/issues?scope=assigned_to_me&state=opened` 与 `GET /api/v4/merge_requests?scope=assigned_to_me&state=opened`、`…?reviewer_username=<me>&state=opened`，按 `updated_at` 合并取前 10。
- **搜索**：key/链接直接取；`#12` / `!34` 在项目仓库中解析；文字用 `GET /api/v4/projects/:id/issues|merge_requests?search=…&in=title`（项目仓库），切换“所有”时用 `GET /api/v4/issues|merge_requests?scope=all&search=…`。
- **读取**：
  - issue：`GET /api/v4/projects/:path/issues/:iid` 与 `/notes?sort=desc&per_page=20`（跳过 `system: true` 的 note）；
  - MR：`GET /api/v4/projects/:path/merge_requests/:iid`（状态含 draft/merged/closed、源/目标分支、head sha、`changes_count`、reviewers）与 notes；
  - Markdown：标题、元数据（状态、作者、指派、reviewer、标签、里程碑、分支）、描述（GitLab 本身就是 Markdown）、最近 20 条评论（作者、时间，diff 评论标出文件和行）、关联 issue 不展开。
- **批量摘要**：GitLab 没有跨项目按 iid 批量查询，逐个 GET，并发 ≤4。一张卡上的条目通常 ≤5 个，在可接受范围内。
- **错误**：401 → AUTH；403 且 token 正常 → NOT_FOUND（没有权限按看不到处理）；429 读 `RateLimit-Reset` / `Retry-After`。
- **白名单**：`/api/v4/user`、`/api/v4/issues`、`/api/v4/merge_requests`、`/api/v4/projects/:id`、`/api/v4/projects/:id/(issues|merge_requests)(/:iid(/notes)?)?`。

## 6. GitHub

- **连接**：类型 github.com 或 GitHub Enterprise Server（地址如 `https://github.example.com`）。API 根：github.com 用 `https://api.github.com`，GHES 用 `<base>/api/v3`。令牌：fine-grained PAT（只读：Issues、Pull requests、Metadata）或 classic PAT（私有库需 `repo`）；`Authorization: Bearer`，带 `X-GitHub-Api-Version: 2022-11-28`。校验 `GET /user`，账户显示 `name (@login)`。
- **识别**：`<base>/<owner>/<repo>/issues/<n>`、`/pull/<n>`（含 `/files`、`/commits` 等子页面与锚点）。裸 key `owner/repo#n`。issue 与 PR 共用编号：链接里是 `/issues/` 但实际是 PR 时，读取后以 API 返回的 `pull_request` 字段为准修正 `itemType`。
- **我的最近**：`GET /search/issues?q=is:open involves:@me archived:false&sort=updated&per_page=10`。GitHub 现在要求每个 issue 搜索都带 `is:issue` 或 `is:pull-request`（否则 HTTP 422），所以所有搜索都拆成两种各查一次，按更新时间合并（2026-10-20 用户联调发现）。
- **搜索**：key/链接直接取；`#12` 在项目仓库中解析；文字用 `q=<文字> in:title repo:<o/r> …`（项目仓库），切换“所有”时为 `q=<文字> in:title involves:<login>`。搜索接口 30 次/分钟，选择器已有 300 ms 防抖与 2 字符门槛。
- **读取**：
  - `GET /repos/:o/:r/issues/:n`（PR 也可，正文与评论数）与 `/issues/:n/comments?per_page=20&page=<最后一页>`；
  - PR 另读 `GET /repos/:o/:r/pulls/:n`（draft、merged、head/base 分支、head sha、增删行数、改动文件数）、`/pulls/:n/reviews`（review 状态与正文）、`/pulls/:n/files?per_page=100`（只取文件名和增删行数，不取 patch）；
  - Markdown：标题、元数据（状态、作者、指派、reviewer、标签、里程碑、分支）、正文、改动文件列表（PR，最多 100 个）、review 摘要、最近 20 条评论。
- **批量摘要**：逐个 `GET /repos/:o/:r/issues/:n`，并发 ≤4（REST 5000 次/小时足够）。
- **错误**：401 → AUTH；403/429 且 `x-ratelimit-remaining: 0` → UNAVAILABLE（按 `x-ratelimit-reset` 退避），**不**标记凭据失效；其他 403 与 404 → NOT_FOUND（GitHub 对无权限的私有库返回 404）。
- **白名单**：`/user`、`/search/issues`、`/repos/:o/:r/issues/:n(/comments)?`、`/repos/:o/:r/pulls/:n(/reviews|/files)?`。

## 7. Confluence

- **连接**：类型 Confluence（自建，Data Center/Server）或 Confluence Cloud。自建用 PAT（`Bearer`）；Cloud 用邮箱 + API token（Basic），地址为 `https://<site>.atlassian.net/wiki`。校验 `GET /rest/api/user/current`。同一 Atlassian Cloud 站点的 Jira 与 Confluence 是两个连接，各填一次令牌（不在连接之间共享凭据，避免删一个连接影响另一个）。
- **识别**：
  - `…/pages/viewpage.action?pageId=<id>`；
  - `…/spaces/<SPACE>/pages/<id>(/<title>)?`（Cloud 与新版 DC）；
  - `…/display/<SPACE>/<Title>`：需要一次 `GET /rest/api/content?spaceKey=&title=` 换成 id；
  - 短链 `…/x/<code>`：tiny link 是页面 id 的 base64 编码，本地解码，不发请求；
  - 裸页面 id（纯数字）：只有一个 Confluence 连接时接受。
- **我的最近**（用户 2026-10-20 要求：看过的和编辑过的）：看过的取自 DC 的 `/rest/recentlyviewed/1.0/recent`（带查看时间）；Cloud 没有该接口，改用 CQL `id in recentlyViewedContent(n)`，DC 接口不可用时同样回退。编辑过的用 CQL `type = page AND contributor = currentUser() ORDER BY lastmodified DESC`。两者合并去重，按 max(查看时间, 最后修改时间) 倒序取 10 个。白名单增加 `/rest/recentlyviewed/1.0/recent`（只对 confluence-dc 调用）。
- **搜索**：链接/id 直接取；文字用 CQL `type = page AND title ~ "<文字>" ORDER BY lastmodified DESC`，没有结果时退回 `text ~ "<文字>"`；字面量转义同 JQL。选择器行显示空间名、最后修改人、相对时间。
- **读取**：`GET /rest/api/content/:id?expand=body.storage,version,space,ancestors` 与 `GET /rest/api/content/:id/child/comment?expand=body.storage,version&limit=20`。storage 格式（XHTML + `ac:` 宏）转 Markdown：标题、段落、列表、表格、代码宏、info/note/warning 宏（转引用块）、页面链接（`ac:link` → 页面标题）、图片（`[image: 文件名]`）、Jira 宏（`[Jira: KEY]`）；其他宏保留其纯文本。Markdown 头部：标题、空间、祖先路径、版本与最后修改人。
- **批量摘要**：CQL `id in (…≤50)`，只取 `version,space`。
- **错误与白名单**：同 Jira 规则；白名单 `/rest/api/user/current`、`/rest/api/content/search`、`/rest/api/content`（仅 `spaceKey`+`title` 查询）、`/rest/api/content/:id`、`/rest/api/content/:id/child/comment`。Cloud 的 v1 content API 仍可用，若被下线再切 v2，接口在 adapter 内部。
- 页面通常比工单长：读取上限从 32 KB 提到 64 KB（只对 Confluence），超出截断并附链接。

## 8. 界面

### 8.1 Artifacts 的 + 菜单（用户要求）

侧栏 Artifacts 标题行只保留一个 **+**（去掉现在单独的 Jira 图标按钮）。点开为菜单（桌面锚定弹出，手机为底部列表，沿用 `client/context-menu.tsx` 的 MenuEntry）：

```
文件或链接…
────────────
Jira 工单…              （有 Jira 连接时）
Confluence 页面…        （有 Confluence 连接时）
GitHub issue 或 PR…     （有 GitHub 连接时）
GitLab issue 或 MR…     （有 GitLab 连接时）
────────────
连接其他服务…           （还有未连接的族时；打开 设置 → Connections）
```

- 选 connector 项打开对应的选择器（现 `LinkTicket` 泛化为 `LinkExternal`），我的最近 + 搜索，选中即添加为 input，toast “Linked <key>”。多个同族连接时选择器顶部切换连接（`lastTicketConnection` 改为按族记忆：`lastConnections: Record<family, id>`，旧值迁入 jira）。
- “文件或链接…”即现在的表单；粘贴的链接属于任一已连接服务时自动识别为该条目（role 取表单所选，默认 input；2026-10-21 起不再固定为 input，agent 自己开的 PR/MR 可登记为 output）。
- 一个连接都没有时，+ 直接打开“文件或链接”表单，表单下方一行淡色提示“也可以连接 Jira、Confluence、GitHub、GitLab”。

### 8.2 New task 表单

`From Jira` 按钮改为 **From…**：每个已连接的服务一个按钮（“From Jira”、“From GitLab” 等，换行排列）。实现时没有用菜单：New task 表单本身在 Modal 里，看板的上下文菜单画在 Modal 下层，按钮行更可靠，也少一次点击。条目条（chip）显示族图标。标题预填规则不变（标题为空才预填，换选只替换未改过的预填值）：issue/PR/MR 用标题，Confluence 页用页面标题。每张卡建卡时最多 5 个条目，与现在一致。

### 8.3 侧栏行与预览

- 品牌图标（用户要求，2026-10-20）：每个服务用自己的 logo（`client/brand-icons.tsx` 的 `BrandIcon`），出现在 Artifacts 行与 + 菜单、卡片正面的条目 key、New task 的 From 按钮、选择器与预览标题、设置 Connections 的分组行与编辑页标题。宿主 `Icon` 只认 Lucide 名、插件不能引 SVG 模块，所以 logo 是 Simple Icons（CC0）的路径预渲染成 48px PNG、以 data URI 交给 RN `Image`（每个约 0.6–0.8 KB，冷启动影响可忽略）。颜色：Jira #0052CC、Confluence #1868DB（Simple Icons 的 #172B4D 在深色主题下看不清）、GitLab #FC6D26；GitHub 黑色 logo 在深色主题下换浅色版本，按 `colors.surface0` 的亮度选择。
- 选择器里的条目行仍按类型用 Lucide 图标：Confluence `BookOpen`、issue `CircleDot`、PR/MR `GitPullRequest`，用来区分同一服务内的类型。
- 第二行：`GitLab merge request · Merged · <note>`；Confluence：`Confluence page · <空间>`。
- 预览按钮文案：“Open in Jira / Confluence / GitHub / GitLab”。

### 8.4 设置 → Connections

同一页四个分组（Jira、Confluence、GitHub、GitLab），每组列出连接并有“Add a … connection”。编辑表单（仍在页内原地切换，不叠 Modal，原因见 EXTERNAL-TRACKER-SPEC §2）由注册表驱动：类型（自建/Cloud，github.com/Enterprise，gitlab.com/自建）、地址（github.com/gitlab.com 预填且不可改）、Cloud 需要邮箱、令牌及权限说明。Test connection、删除确认（显示受影响卡片数）对所有族一致。

### 8.5 onboarding、文案

- 欢迎页功能行 “Jira tickets as inputs” 改为 “Tickets, docs and PRs as inputs”（Jira、Confluence、GitHub、GitLab）；README 中英文同步。
- 新一次性 tip `connectors`：打开一张卡片（侧栏 Artifacts 可见）时提示“+ 现在也能添加 Confluence 页面和 GitHub/GitLab 的 issue、PR”，排在 `sidebar-order` 之前。新 tip id 会对所有现有用户显示一次（ONBOARDING-SPEC 规则）；`first-ticket`、`jira-connect` 保留 id，文案扩展为所有服务。
- 所有新文案 `t()` 并加入 9 个语言目录。

## 9. Agent 侧

- `get_task.artifacts[].external`：`provider`、`itemType`、`key`、`summary`、`status`、`statusCategory`、`type`、`priority`、`assignee`、`container`、`updated`、`stale`、`connection`（`removed` 时）。Confluence 的 `status` 为空。Jira 条目额外带 deprecated 的 `ticket`（§3.3）。
- 新工具 `flowly_read_external`（CLI `external --id`）：读取本卡的外部条目 input，包括 Jira 工单、Confluence 页面、GitHub/GitLab issue 或 PR/MR。PR/MR 返回改动文件名但不含 diff：要看代码改动，agent 应在本地 `git fetch` 对应分支（返回的 Markdown 头部写明分支和 head sha）。旧名 `flowly_read_ticket` / CLI `ticket` 为别名。
- session 上下文 Inputs 行：`- [user] group/proj!34 Fix login (GitLab merge request; read it with flowly_read_external artifactId=…): <url>`。
- skill：把“An artifact with a ticket field is a Jira ticket…”改写为 external 条目的通用说明，其余规则不变（是需求输入；状态只供参考；不要尝试修改外部系统；冲突时以用户为准；交付时写明依据的条目）。追加一句：PR/MR 输入要 review 或续做时，用 git 获取其分支，不要通过 Flowly 写回。（2026-10-21）“是需求输入”限定为 role=input；agent 自己开的 PR/MR 用 role=output 登记，显示实时状态，unread（新评论/review）时读它看评审意见；工具结果带 `notice` 时按它处理。
- 错误码见 §3.3。

## 10. 实施顺序与测试

本卡按以下顺序交付，每步可独立验证，Jira 行为在每一步都保持不变：

1. **框架重构与改名**：`server/connectors/*`、`ConnectorService`、shared 注册表、v5 迁移、别名；Jira 迁入，现有 Jira 测试只改名字，不改行为期望。
2. **统一 + 菜单与设置页**：§8.1、§8.4、§8.2 的通用部分。
3. **Confluence**（§7）。
4. **GitLab**（§5）。
5. **GitHub**（§6）。
6. onboarding / i18n / README / skill；整体验证。

测试：

- 每个 adapter 用 mock fetch：链接识别（含多级 group、子页面、锚点、tiny link、`/display/`）、裸 key、白名单之外的路径直接抛错、只发 GET、错误映射（GitHub 限流 403 不算凭据失效、GitLab 403、Confluence 登录页）、Markdown 渲染与截断、指纹（状态/标签变化不算，新 commit 算）。
- storage → Markdown 转换器单测（代码宏、表格、info 宏、ac:link、图片）。
- 项目仓库范围：remote 解析（ssh/https 两种写法、多 remote、symlink 子仓库）、host 不匹配时忽略。
- 凭据：RPC 返回、日志、工具输出不含令牌。
- 联调：按用户提供的令牌在 git.garena.com 与公司 Confluence 做只读验证（令牌由用户在设置页填写，agent 不接触），GitHub 用公共仓库与用户私有仓库各一个条目。
- 按项目要求，用 full-access 的 `codex/gpt-6-luna` session 做 UI 验收（桌面与手机布局、+ 菜单、选择器、预览、删除连接后恢复），证据存 `docs/verification/connectors.md`。

## 11. 用户决定（2026-10-20）

1. 命名：**改为通用名**（设计稿建议保留旧名；用户听过别名与迁移的代价后决定改名），见 §3.3。
2. 条目范围按 §2；PR/MR **只给文件名**，不给 diff。
3. New task 的 From Jira **一起泛化**为 From…（§8.2）。
4. 实施顺序：**Confluence → GitLab → GitHub**（框架与 + 菜单/设置页在最前），见 §10。

## 12. 实现记录（2026-10-20）

- 共享：`shared/connectors.ts`（provider 注册表、四族链接与 key 识别、tiny link 解码、git remote 解析、查询分类、JQL/CQL 字面量、卡片面 key），取代 `shared/tickets.ts`。
- daemon：`server/connectors/`
  - `http.ts`：`ReadOnlyHttp`（只发 GET、路径白名单、`redirect: "error"`、15 秒超时、登录页视为凭据失效）、`ExternalError`、`StoredConnection`（新增 `login`，旧记录默认空）；
  - `jira.ts`（原 `JiraClient`、Markdown、wiki 转换迁入，行为不变）、`confluence.ts`、`gitlab.ts`、`github.ts`，`index.ts` 按族分派；
  - `storage-markdown.ts`：Confluence storage 格式转 Markdown；
  - `service.ts`：`ConnectorService`（原 `TicketService`）、`ConnectionStore`、`ExternalReadStore`、`migrateTicketDirectory`（插件启动时同步 rename `tickets/` → `connectors/`）；
  - `repos.ts`：从项目根和一级子仓库的 git remote 得到项目仓库，缓存 5 分钟（复用 `findRepos`）。
- 看板 v5：`server/migrate.ts` 的 `renameTicketField`，`server/store.ts` 在第一次写入前留 `board.pre-v5.json`。
- RPC `connectors.*`；`tasks.create` 的 `tickets` 改为 `externals`（可带 `itemType`）。
- agent：`flowly_read_external` 与别名 `flowly_read_ticket`；HTTP action `external`（`ticket` 兼容）；CLI `external --id`（`ticket` 兼容）；`get_task.artifacts[].external`，Jira 条目另带 deprecated `ticket`；skill 段落改写。
- 客户端：`client/connectors.tsx`（取代 `client/tickets.tsx`：设置页四个分组、`ExternalPicker`、`LinkExternal`、`ExternalPreview`、`ExternalChip`）；侧栏 Artifacts 单一 + 菜单（`client/task-artifacts.tsx`，“连接其他服务…”经 `client/settings-opener.ts` 打开 设置 → Connections）；New task 的 From… 按钮行（`client/forms.tsx`）；卡片面 key 与图标（`client/board.tsx`、`client/card.tsx`）；设置 `lastConnections`、卡片显示字段 `external`（读旧 `ticket`）；tip `connectors`；欢迎页功能行；README；9 个语言目录各 +68 / −32 条。
- 测试：`shared/connectors.test.ts`、`server/connectors/{jira,confluence,gitlab,github}.test.ts`（mock fetch，覆盖只读白名单、错误映射、Markdown、指纹、仓库范围）、store v4 → v5 迁移、card-display 旧 id、onboarding tip 规则。

### 12.1 评审后的修正（2026-10-20，独立代码评审）

- **令牌只回到原地址**：编辑连接时，令牌留空只在 provider 和地址都不变时沿用已存令牌；改了地址或类型必须重新输入（原 Jira 实现也有此漏洞：Test connection 可把已存令牌发到新地址）。
- **只用 https**：连接地址必须是 https；http 只允许本机（`localhost`、`127.0.0.1`、`[::1]`，用于本地镜像和测试），令牌不明文传输。
- **不跟随重定向**：`redirect: "manual"`，3xx（如 GitHub 改名仓库的 301）报 `EXTERNAL_NOT_FOUND`“已移动，请添加新链接”，不再被当作服务不可用，也不会让整个连接退避。
- **超时覆盖响应体**：15 秒计时到读完正文为止；声明超过 16 MB 的响应直接拒绝。
- **移动过的 Jira 工单**：以新 key 返回时也挂在卡片记录的旧 key 下，不再报“找不到”。
- **Confluence 评论计入 unread**：页面版本不随评论变化，因此 Confluence 的摘要刷新不沿用旧指纹（adapter 标志 `updatedCoversContent: false`），每次 get_task（60 秒缓存外）重新取全文算指纹。
- **裸 key 不劫持文件路径**：`docs/spec.md#3`、`2024` 这类不是链接的目标，远端找不到时回落为文件路径；链接找不到仍报错。
- **选择器带上连接**：`artifacts.create` 新增可选 `external: { connectionId, key, itemType }`，选择器添加时按所选连接解析，不再按 URL 重新识别（同一主机多个连接、或 web 地址与连接地址不同时都正确）。
- **已选判断按服务区分**：`pickKey = family:key`，GitHub 与 GitLab 同名的 `team/app#12` 不再互相标为已选。
- **GitLab 14.x 的改动文件**（真实联调发现，git.garena.com 为 14.10）：`/diffs` 自 15.7 起才有；返回 404 时回退 `/changes`，只取文件名，不取 patch。
- **删除连接同时清理磁盘缓存**（Luna 验收第 9 项发现）：删除后立即写回 `cache.json`；缓存加载时丢弃已不存在的连接的条目。
- 未改：`external-reads.json` 读坏时从空开始（与原 `ticket-reads.json` 相同，只是已读标记，不是用户数据）。

## 13. Azure DevOps（2026-10-24，卡片“增加 Azure DevOps connector”）

第五个 provider 族 `azure`（provider id `azure-devops`），沿用本 spec 的全部规则：只读、外部状态不驱动卡片、默认 input、令牌只在 daemon。范围只有 **work item**（Boards）；Azure Repos 的 PR、Pipelines、Wiki、Test Plans 不做。目标是“从 ADO 工单创建任务”：New task 的 **From Azure DevOps** 与 Artifacts 的 + 菜单都会出现这个服务。

- **连接**：一个连接 = 一个组织（Services：`https://dev.azure.com/<org>`、旧式 `https://<org>.visualstudio.com`；Server：`https://host/tfs/<collection>`）。个人访问令牌（Work Items: Read），请求头 `Authorization: Basic base64(":"+PAT)`。校验 `GET /_apis/connectionData`，账户显示 `名字 (登录名)`。没有默认地址，设置页要求填写组织地址。
- **key**：`AB#123`（Azure Boards 自带的写法）。工作项 id 在组织内唯一，所以不需要项目路径。裸 key 只认 `AB#123`；选择器里 `123` / `#123` 也直接当 key，文字用标题搜索。`itemType` 仍是 `issue`，卡片面显示 `AB#123`，agent 上下文写 “Azure DevOps work item”。
- **识别**：连接地址之下的 `…/_workitems/edit/<id>`（带或不带项目段、末尾斜杠均可），以及任何带 `?workitem=<id>` 的看板/Backlog 页面。其他组织的链接、PR 链接不识别。
- **我的最近**：WIQL `[System.AssignedTo] = @Me` 且状态不在 Closed/Done/Removed/Completed/Resolved，按 `ChangedDate` 倒序取 10 个。**文字搜索**：WIQL `[System.Title] CONTAINS '<文字>'`，单引号加倍转义。WIQL 要求 POST，是本框架第一个 POST：`ReadOnlyHttp` 新增 `query()`，只允许 `queryEndpoints`（目前仅 `/_apis/wit/wiql`）；其余路径仍只能 GET，写操作依旧不存在。
- **读取**：`GET /_apis/wit/workitems/:id`（全部字段）与 `GET /<项目>/_apis/wit/workItems/:id/comments`（最近 20 条）。Markdown：标题、状态、类型、指派、创建人、优先级、项目/区域/迭代、标签、父项，然后 Description / Repro steps / Acceptance criteria（HTML 经 `storageToMarkdown` 转换）和评论。
- **指纹**：标题、Description、Repro steps、Acceptance criteria、评论 id+修改时间；状态、指派、优先级变化不算。评论是否推进 `ChangedDate` 不确定，所以 `updatedCoversContent: false`（与 Confluence 相同），每次重新读取全文。
- **API 版本**：Services 用 `7.1`（评论 `7.1-preview.4`），Server 用 `5.0`（评论 `5.1-preview.3`）；Server 路径尚未用真实实例验证。
- **错误**：401/203 登录页 → AUTH；403（connectionData 以外）与 404 → NOT_FOUND；429/5xx → UNAVAILABLE。
- **界面**：品牌图标按 §8.3 的做法，用 Simple Icons 的 Azure DevOps 路径（CC0）渲染成 48 px PNG，颜色 #0078D4，以 data URI 打包（约 0.8 KB）。设置 → Connections 增加第五个分组。
- **测试**：`server/connectors/azure.test.ts`（mock fetch：Basic 头、登录页、链接/AB# 识别、WIQL 与引号转义、Markdown、指纹、403、只有 WIQL 一个 POST）、`shared/connectors.test.ts`（链接、Server/旧域名、key、查询分类）。**未做**：真实组织联调（需要用户的组织地址和 PAT）。
- onboarding：更新欢迎页功能行、`jira-connect` tip 文案和 README；不新增 tip id（连接与使用方式没有变化，已有 tip 覆盖）。

## 14. Linear（2026-11-03，分支 `feat/linear-connector`）

第六个 provider 族 `linear`（provider id `linear`），实现 EXTERNAL-TRACKER-SPEC 的 P2，沿用本 spec 的全部规则：只读、外部状态不驱动卡片、默认 input、令牌只在 daemon。范围只有 **issue**；project、cycle、document、initiative、子 issue 批量导入不做。New task 的 **From Linear** 与 Artifacts 的 + 菜单都会出现这个服务。

- **连接**：Linear 只有云端，API 地址固定为 `https://api.linear.app/graphql`，由 adapter 以常量持有。设置页**没有地址字段**（注册表 `noAddress: true`）：用户只填名称和 personal API key。请求头 `Authorization: <key>`，不加 `Bearer`。校验查询 `viewer { name displayName email organization { name urlKey } }`：账户显示 `名字 (email)`，login 取 email。校验成功后连接的 `baseUrl` 取 **workspace 地址** `https://linear.app/<urlKey>`（adapter 的 `verify` 可以返回 `baseUrl`，只有 `noAddress` 的 provider 才采用）；它只用来识别链接和拼条目链接，令牌永远只发往固定的 API 地址。所以编辑连接时 `baseUrl` 变化不算“地址改了”，留空令牌照样沿用已存的令牌。名称留空时默认 `linear.app/<urlKey>`。
- **条目类型与 key**：`itemType` 为 `issue`，key 是 Linear 的 identifier `ENG-123`（团队 key + 编号，大写），卡片面显示 `ENG-123`，agent 上下文写 “Linear issue”。`remoteId` 是 issue 的 UUID。issue 换团队后 identifier 会变，Linear 仍接受旧 identifier；读取返回新 key 时按 §4.2 的规则缓存在卡片存的 key 之下。
- **裸 key**：`ENG-123` 与 Jira key 写法相同。只有一个连接接受它时直接使用（EXTERNAL-TRACKER-SPEC §3.1）；同时有 Jira 和 Linear 连接时，裸 key 有歧义，Artifacts 表单不自动识别，用户粘贴链接或用选择器。选择器只搜当前连接，没有歧义。
- **识别**：workspace 地址之下的 `/issue/<KEY>`，带不带标题 slug、子路径、查询或锚点（`#comment-…`）都可以。其他 workspace 的链接不匹配（`urlKey` 是 `baseUrl` 的一部分）。project、view、cycle 链接不识别。条目链接为 `<baseUrl>/issue/<KEY>`，读取时优先用 API 返回的 `url`。
- **我的最近**：`issues(filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }, orderBy: updatedAt, first: 10)`，在 daemon 再按 `updatedAt` 倒序排一次。
- **搜索**：选择器里 `ENG-123` 或链接按 key 读取（找不到时结果为空）；裸数字按编号查所有团队（`number: { eq }`，可能多条，按更新时间倒序，最多 20 条）；其他文字按标题词搜索：每个词一个 `title: { containsIgnoreCase }`，用 `and` 连接（最多 8 个词），按 `updatedAt` 倒序取 20 条。用户文字只经 GraphQL 变量传入，查询文本是代码里的常量，不拼接任何用户输入。
- **读取**：`issue(id: "<KEY>")`，一次请求读全部内容：标题、描述（本身就是 Markdown，不做转换）、状态、优先级、负责人、创建人、标签、团队、项目、父 issue（key 与标题）、链接、最近 20 条评论（`comments(first: 20, orderBy: createdAt)`，按创建时间正序显示）。
- **Markdown**：`# KEY 标题`、链接，然后元数据（State、Priority、Assignee、Created by、Team、Project、Labels、Parent、Updated），然后 `## Description`（空时 `(empty)`），然后 `## Comments (latest N)`，每条 `### 名字 · 时间`。
- **批量摘要**：`getMany` 用 GraphQL 别名把多个 `issue(id:)` 合成一个请求（每请求最多 25 个）。`issue(id:)` 的类型是非空的 `Issue!`，所以只要有一个 issue 不存在或看不到，整个 `data` 就是 null：这时如果所有错误都是“找不到”，就逐个重新读取这一批（并发 4），只略过找不到的；限流或令牌被拒仍让整批失败。若 Linear 改为只把该别名置 null，也直接略过它。一个被删除的 issue 不会让同一连接的其他条目停止刷新。
- **summary 映射**：`status` = 状态名；`statusCategory` 由状态 `type` 得到：triage/backlog/unstarted → new，started → indeterminate，completed/canceled → done；`priority` = `priorityLabel`（“No priority” 记为空）；`type` 为空（Linear 没有 issue 类型）；`container` = 团队名；`assignee` = 负责人显示名。
- **指纹**：标题、描述、每条评论的 id 加 `updatedAt`；状态、负责人、优先级、标签不算（§3.2）。新评论是否推进 issue 的 `updatedAt` 不确定，所以 `updatedCoversContent: false`（与 Confluence、Azure DevOps 相同）。
- **只读保证**：GraphQL 只有 POST，所以 `/graphql` 是 `queryEndpoints` 里唯一的路径（与 Azure DevOps 的 WIQL 同理），GET 白名单为空。adapter 发出的每个文档都必须以 `query` 开头，否则在发送前拒绝；代码里不存在 mutation。
- **错误**：HTTP 401 或 GraphQL 错误码 `AUTHENTICATION_ERROR` → AUTH（连接标记 `authFailed`）；`FORBIDDEN` 与“Entity not found”类错误 → NOT_FOUND（看不到的 issue 不让整个连接失效）；限流（HTTP 400 或 429，错误码 `RATELIMITED`）→ UNAVAILABLE，等待时间取 `Retry-After`，没有时取 `X-RateLimit-Requests-Reset`（UTC 毫秒时间戳）；5xx → UNAVAILABLE，不论响应体里是什么错误码或信息（所以读取失败时缓存照常兜底）；其他 GraphQL 错误 → INVALID，带第一条错误信息。错误信息里不出现令牌或请求头。
- **界面**：品牌图标按 §8.3 的做法，用 Simple Icons 的 Linear 路径（CC0）渲染成 48 px PNG，颜色 #5E6AD2，以 data URI 打包（约 2 KB）。设置 → Connections 增加第六个分组；编辑页没有类型和地址选择，令牌字段名为 “API key”，提示在 Linear → Settings → Security & access → Personal API keys 创建，Read 权限即可。
- **验收**：Test connection 显示账户；保存后连接地址是 workspace 地址；粘贴 issue 链接（带 slug 或锚点）和在选择器里输入 `ENG-123`、编号、标题词都能找到；**From Linear** 列出分配给自己的未完成 issue；agent 用 `flowly_read_external` 读到上面列出的字段与评论；改描述或加评论会让指纹变化，只改状态不会；令牌被拒时连接标记 `authFailed`，限流时退避且不丢缓存；所有请求都是发往 `https://api.linear.app/graphql` 的 POST，文档都以 `query` 开头。
- **测试**：`server/connectors/linear.test.ts`（mock fetch，录制形状的 GraphQL 响应：Authorization 头不带 Bearer、workspace 地址、编辑时沿用令牌、链接与 key 识别、最近/编号/文字查询的变量、Markdown、指纹、AUTH/NOT_FOUND/限流、批量别名、只有 `query` 文档）、`shared/connectors.test.ts`（链接、key、查询分类、条目链接、卡片面 key）。没有真实 API 联调。
- onboarding：更新欢迎页功能行、`jira-connect` tip 文案和 README；不新增 tip id（连接与使用方式没有变化，已有 tip 覆盖）。不加 What's new（1.8.0 尚未定稿，由发布时决定）。
- 遥测：不加心跳字段（与 Shortcut 的理由相同：TELEMETRY-SPEC §4.6 不发送 connector 类型）。
