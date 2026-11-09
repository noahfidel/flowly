# 卡片产物（Artifacts）

状态：2026-10-17 用户审阅并要求实现（“开始”）：只存引用；agent 不能删除人添加的产物；卡面不显示；每条标明输入/输出与人/agent 添加；follow-up 继承暂不做（§11）。卡片任务 `82814710`。

## 1. 目的

一张卡现在能记录描述、活动、progress note、ideas 和关联，但没有地方集中放“这个任务用到和产出了哪些东西”：需求文档、设计稿、参考链接、生成的报告、截图、PR 链接、验证证据等。它们散落在 session 对话和 workspace 目录里，用户和后来接手的 session 都得翻对话去找。

本功能给卡片加一个 **Artifacts** 列表，每条是对一个文件或链接的**引用**，标明角色（输入 / 输出）和来源（人 / agent），带标题和简短说明。agent 根据自己的理解通过工具添加，用户也可以手工添加、编辑和移除。

命名：界面与工具统一用 **Artifacts**（agent 生态里的通用词，Claude/Codex 都这样称呼产出物）；中文目录译为“产物”。“Assets” 偏向静态资源，不采用。

原则：

- **只存引用，不复制文件**（v1）。文件仍在 workspace/项目目录里，由 git 管理；插件不成为第二个文件存储。
- 产物只用于**展示和提供上下文**：不改业务状态、不改 task revision、不触发自动动作。
- 不扫描目录、不自动从对话里抽取。agent 有明确意图时才登记，避免噪音。

## 2. 数据

### 2.1 Artifact

存在 `board.json` 新增的 `artifacts` 数组（同 `links`，CARD-LINKS-SPEC §2.1），随现有 etag 看板读取到达客户端，不新增轮询。

```
{ id, taskId, projectId,
  role: "input" | "output",
  kind: "file" | "url",
  target: string,          // file: 规范化路径（§2.2）；url: http(s) URL
  title: string,           // 1–120，默认取文件名或 URL 主机+路径
  note: string,            // 0–1000，用途/说明
  createdBy: "human" | "agent",
  agentId?: string,        // createdBy=agent 时
  createdAt, updatedAt }
```

`shared/model.ts` 新增 `artifactSchema`、`artifactRoles`、`artifactLimits = { title: 120, note: 1000, target: 2000, perTask: 100 }`；`boardSchema` 加 `artifacts: z.array(artifactSchema).optional()`，缺失读作空数组。看板版本不变。

角色含义：

| role | 含义 | 例子 |
| --- | --- | --- |
| `input` | 完成任务所依据或参考的材料 | 需求文档、设计稿、issue 链接、日志、相关资料 |
| `output` | 本任务的交付物 | 新写的 spec、报告、导出文件、PR、验证证据 |

外部条目（Jira、Confluence、GitHub/GitLab，CONNECTORS-SPEC §3.1）与其他条目一样可取任一角色：人粘贴或从选择器添加默认 input，agent 自己开的 PR/MR 登记为 output。role 不再因为是外部条目而被强制为 input。

### 2.2 文件路径

- 添加时服务端把路径解析为绝对路径（相对路径以卡片 workspace 目录为基准），`realpath` 后必须位于该卡的 scope 目录之内（`shared/scope.ts` 的有效目录：workspace 目录、项目根、legacy scope 目录；linked root 的符号链接按目标解析后也算在内）。目录外的路径拒绝：“Files outside this card's directories can't be added.”（设置里的额外目录也算在内，见文末 2026-11-08 增量。）
- 存储时，位于 workspace 目录内的保存为相对 workspace 的路径（前缀 `./`），其余保存绝对路径。这样 worktree 被收尾后重建（WORKSPACE-RESTORE-SPEC）路径仍然有效。
- 文件在添加时必须存在（文件或目录均可）；之后被删除、移动或 worktree 被移除时，记录保留，界面显示 “Missing”。
- URL 只接受 `http:`/`https:`，最长 2000。
- 同一卡片内 `(kind, target)` 唯一；重复添加返回已有那条，若提供了新的 role/title/note 则按 §3 更新规则处理。agent 重复添加人添加的条目时不改它；role 与已有的不同时，工具结果带 `notice`（见 §4.1）。

### 2.3 事件

产物变化只增加看板 revision，不改 task revision。卡片活动记一条事件：`artifact_added` / `artifact_removed`，note 为 `<Role>: <title>`；编辑（改 title/note/role）不记事件。agent 添加的事件 actor 为 agent，带 agentId。

## 3. 人工 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `artifacts.create` | `{ taskId, role, kind, target, title?, note? }` | 按 §2.2 校验并写入，返回新产物；重复 `(kind, target)` 返回已有那条并应用给出的字段 |
| `artifacts.update` | `{ id, updatedAt, role?, title?, note? }` | `updatedAt` 不符时报 “This artifact changed. Reload and try again.”（防覆盖）；target 不可改，换目标即删了再加 |
| `artifacts.delete` | `{ id }` | 删除；不存在报 “This artifact no longer exists.” |
| `artifacts.preview` | `{ id }` | 见 §6.1；只读，不写看板 |

人可以编辑和删除任何产物（包括 agent 添加的）。卡片或项目已归档时写操作拒绝：“Archived cards can't be changed.”

## 4. Agent 侧

### 4.1 工具

新增两个 MCP 工具（CLI 同步提供 `artifact` / `artifact-remove` 子命令），都遵循现有签名 request + expectedRevision 协议，幂等，不改 task revision：

- `flowly_add_artifact`：`{ expectedRevision, request, role, target, title?, note? }`。`kind` 由 target 推断（`http(s)://` 为 url，`file://` 与其余为 file）。重复 target 时更新该条的 role/title/note（仅当该条由 agent 添加，任一 session；人添加的保持不变，返回已有那条，回执 `eventId` 为空；此时若请求的 role 与已有的不同，结果带 `notice`：“Already added by the user as <role>; role not changed. …”，回执同样保存它，重放时原样返回）。结果带 `artifactId`。路径错误返回 `ARTIFACT_INVALID`。
- `flowly_remove_artifact`：`{ expectedRevision, request, id }`。只能移除 agent 添加的产物（任一 session 均可，因为同卡的 session 共享工作）；人添加的拒绝：`ARTIFACT_FORBIDDEN` “Only the user can remove artifacts they added.”

工具描述要点（写进 description 与 skill）：

> Register a file or link that is an input this card worked from, or an output it delivered, so the user and later sessions can find it. Add deliverables when you produce them (specs, reports, exported files, PRs, verification evidence), not every file you touched; source code changes are already visible through the workspace diff. Use a short title and a one-line note on what it is for. Check artifacts in get_task first.

### 4.2 读取

- `flowly_get_task` 新增 `artifacts: [{ id, role, kind, target, absolutePath?, title, note, createdBy, missing, unread }]`，最多返回 100 条。`absolutePath` 仅 file，按当前 workspace 目录解析。
- `unread`（2026-10-18 用户选 A+B）：该产物在本 session 上次调用 `flowly_get_task` 之后被添加或编辑（按 `updatedAt`），本 session 自己添加的永不算。本 session 从未读过时全部为 true。只有显式的 `flowly_get_task`（MCP 或 CLI `current`/`get`）会把读取时间推进到本次读取开始的时刻；写工具结果里附带的 `current` 只显示标记、不推进。读取时间按 session 存在插件数据目录的 `artifact-reads.json`（不写 board.json，不改看板 revision；原子替换；最多 2000 个 session，超出丢最旧的），重启后保留。
- 建 session 时注入的任务上下文（`sessionContext`）在描述后加一段，每种角色最多 10 条、超出写 `…and N more`，只列 input 与 output；用户添加的排在前面，每条带来源与说明（说明压成一行，最长 200 字）：

  ```
  Inputs:
  - [user] <title>: <target> — <note>
  - [agent] <title>: <target>
  Outputs so far:
  - [agent] <title>: <target> — <note>
  ```

- Skill 新增一条：用户添加的 inputs 属于任务本身，开工前全部读完（文件用 `absolutePath`，链接在有联网工具时打开），其说明视为如何使用它的指令；每轮开始先读 `flowly_get_task`，优先处理 `unread` 的 inputs；读不了（Missing、链接打不开或需登录、没有联网工具）时在回复里说明，不要猜内容；交付时写明用了哪些 inputs，并把交付物登记为 output；不要把每个改动的源文件都登记。`flowly_get_task` 的工具描述同样提示每轮开始读取与 `unread`。
- 不在用户发出的消息前自动附加“新增 input”提示（AGENTS.md：普通追问只发送用户原文）。

### 4.3 设置

设置 › AI features 新增 **Artifacts › Agent artifacts**（默认开；存于现有 `ideas` host 设置的 `artifacts` 字段）。关闭后两个写工具返回 `ARTIFACTS_DISABLED`（同 `IDEAS_DISABLED`），skill 要求 agent 改在回复里列出交付物且不重试；`get_task` 照常返回。

## 5. UI

### 5.1 看板卡片

卡面不显示产物（用户决定）。

### 5.2 侧栏 Artifacts 区块

位置：描述与运行摘要之后、Sessions 之前（产物是任务内容的一部分，比 Ideas/Links 更靠前）。实现：`client/task-artifacts.tsx`。

- 标题 `Artifacts`，计数为总数；右侧 `+` 打开 §5.3 表单。没有产物时只显示标题行和 `+`。
- 按角色分组，顺序 `Outputs`、`Inputs`，组内按 `createdAt` 倒序；空组不显示。每组先显示 5 条，其下 “Show N more” 每次再追加 5 条（同一列表、与已显示行左对齐，不缩进），没有收起；关闭侧栏再打开或换一张卡片才回到 5 条。有产物时标题可点击（计数后带箭头）整体收起/展开，是否默认展开与区块位置都在 设置 → Cards → Card sidebar 调整（[DRAWER-SPEC](DRAWER-SPEC.md#section-order-and-artifacts-paging)）。
- 每行：类型图标（`FileText` / 目录 `Folder` / 链接 `Link`）、标题（单行截断）、第二行弱化显示 note（单行截断，没有则显示短路径或主机名）；每行都标明来源：标题右侧显示 `User` 或 AI 标记（`Sparkles`，AI-MARK-SPEC）小图标（无障碍 “Added by you” / “Added by an agent”）；角色由分组标题标明，无障碍名称以 “Input:” / “Output:” 开头；文件不存在时标题弱化，第二行以 “Missing” 开头。
- 点击行：url 用 `Linking.openURL`；file 打开 §6.1 预览。行尾两个图标按钮：**Edit**（铅笔，打开 §5.3，可改角色、标题、说明）与 **Remove**（`X`，无确认，乐观移除 160 ms 收起，失败恢复并弹 error toast，成功弹 toast “Artifact removed. The file was not changed.”）。host toast 不支持操作按钮，所以不做 Undo；插件也没有剪贴板 API，不做 Copy path。
- 卡片或项目已归档时 `+`、编辑与移除禁用，列表照常显示与打开。
- 增删动效用 `client/motion.tsx` 原语，遵循 Reduce Motion，可打断；抽屉打开时已有行不播放进场。

### 5.3 添加/编辑表单

插件 Modal（手机为底部弹层），字段全部用 `TextBox`/`Field`：

1. 角色分段选择：**Input**（默认）/ **Output**。
2. **Path or link**：输入框（相对路径以卡片 workspace 为基准），编辑时只读。v1 不提供文件浏览按钮（现有目录选择器只选目录）。
3. **Title**：可空，留空按 §2.1 默认。
4. **Note**：可空，多行。

提交失败时表单保留并在顶部显示错误。

## 6. 打开与预览

### 6.1 预览 RPC

`artifacts.preview({ id })` 只读该产物登记的路径（不接受任意路径），在服务端重新解析并校验仍在 scope 内（防止登记后被换成指向外部的符号链接）：

| 文件类型 | 返回 |
| --- | --- |
| 图片（png/jpg/gif/webp，≤8 MB） | `dataUri`，客户端复用 session 图片查看器 |
| 文本（md/txt/json/yaml/log/源码等，按扩展名与无 NUL 字节判断，≤256 KB） | `text`；markdown 用现有会话 markdown 渲染，其余等宽显示 |
| 目录 | 前 200 个条目名（不递归） |
| 其他或超限 | `{ unsupported: true, size }`，界面显示大小与 **Copy path** |
| 不存在 | “This file no longer exists.” |

预览只在打开时请求一次，不轮询；关闭即丢弃内容。预览内容直接放在 host 弹层的可滚动正文里，不再嵌套 ScrollView（手机上嵌套的滚动区会抢走手势）。

## 7. 删除、归档与收尾

- 永久删除卡片：一并删除其产物，写入现有 `removed/task-…json` 备份（新增 `artifacts` 字段）。只删记录，不碰文件。
- 移除项目：一并删除并备份该项目的产物。
- 归档、收尾、恢复：记录保留。收尾移除 worktree 后 workspace 内的文件产物显示 Missing；恢复（重建 worktree）后自动恢复为可用。收尾预检不因产物增加提示（现有的未提交/仅本地提交警告已覆盖 worktree 里的文件）。

## 8. 错误文案

| 情况 | 文案 |
| --- | --- |
| 路径在 scope 外 | “Files outside this card's directories can't be added.” |
| 文件不存在 | “This file doesn't exist.” |
| URL 协议不支持 | “Only http and https links can be added.” |
| 上限 | “A card can have at most 100 artifacts.” |
| 已归档 | “Archived cards can't be changed.” |
| 并发编辑 | “This artifact changed. Reload and try again.” |
| 不存在 | “This artifact no longer exists.” |
| agent 删人添加的 | “Only the user can remove artifacts they added.” |
| 设置关闭 | `ARTIFACTS_DISABLED` |

## 9. 性能

- 产物随看板一次读取；单卡 ≤100 条，按 `taskId` 过滤。
- `missing` 不在看板读取时逐个 `stat`：只在 `get_task` 和抽屉打开时请求的 `artifacts.status({ taskId })`（一次批量 realpath，同一组目标缓存 15 s；客户端 30 s 内不重取）中计算。
- 预览按需加载，大小受限。

## 10. 不做（v1）

- 上传/复制文件到插件数据目录（附件存储）；文件版本、diff、哈希校验。
- 自动扫描 workspace 或从对话自动抽取产物。
- 跨卡共享产物、项目级产物库；新建 follow-up 时继承来源卡的 outputs 作为 inputs（用户暂不做）。
- 卡面显示产物数量或图标。
- 产物排序拖动、标签/分类以外的自定义字段。
- 在插件内编辑文件内容。
- 从 session 对话里一键收集链接/图片为产物、文件浏览选择、Reveal in workspace / Copy path、删除后 Undo（v1 实现时去掉：host 无剪贴板与 toast 操作 API，后续可加）。

## 11. 已定问题（2026-10-17 用户）

1. 只存引用，不上传副本。
2. agent 不能删除人添加的产物（可删 agent 添加的）。人能删任何产物。
3. 卡面不显示；侧栏每条标明输入/输出和人/agent 添加。角色只保留 input/output（原 reference 并入 input）。
4. follow-up 继承暂不做。

## 12. 验收

- 单元（`shared/artifacts.test.ts`、`server/artifacts.test.ts`、`server/store.test.ts`、`server/tool-server.test.ts`）：路径解析与 scope 校验（相对路径、`..`、符号链接逃逸、linked root）、相对 workspace 存储与 worktree 重建后解析；URL 校验；去重与更新规则；上限；归档拒绝；`updatedAt` 冲突；只增看板 revision；事件；agent 删除权限；`ARTIFACTS_DISABLED`；预览各类型与大小限制、登记后符号链接替换被拒；删卡/移除项目级联与备份；`sessionContext` 段落与截断；`get_task` 字段。
- 客户端：分组顺序与折叠、来源标记、表单默认值。
- i18n 所有新文案进全部 catalog；onboarding：新增 tip `artifacts`（首次打开有产物的卡片抽屉时提示 “Artifacts collect a card's inputs and deliverables. Agents add them as they work; you can add files or links too.”），README 与欢迎页功能列表加一行。
- typecheck、全量测试；安装并 reload；用 Luna 6（`codex/gpt-6-luna`，`full-access`）测试 session 在 fixture 项目上走通：人工添加 file/url/目录、scope 外拒绝、编辑与冲突、移除、agent 通过 MCP 与 CLI 添加/更新/移除、删人添加的被拒、设置关闭后的错误、预览图片/markdown/大文件、Missing 显示、删卡级联；桌面与紧凑布局按 AGENTS.md 绑定非全屏窗口，无法绑定时标 UNRUN。结束后清理 fixture，证据存 `docs/verification/card-artifacts.md`。

## 2026-10-22 增量：交付时原子登记产物

`flowly_update_status(in_review)` 与 `flowly_report_progress(result)` 的 `outputs?: {target,title?,note?}[]` 在同一事务登记 output；`[]` 表示本次无产物，省略则成功后提醒。复用本规范的路径边界、目标去重和用户条目保护。回执 `artifactIds` 持久化，精确重放不会再校验已消失文件或重新访问 connector。完整契约、开关行为和 CLI 参数见 [DELIVERY-CONSTRAINTS-SPEC](DELIVERY-CONSTRAINTS-SPEC.md) §1。

## 2026-11-08 增量：额外产物目录

用户要求（经 Loadout）：harness 会附加 `~/.claude/plans/<plan>/`、`~/.claude/reviews/`、`~/.claude/handoffs/` 下的文件，它们在卡片目录之外，会被 §2.2 拒绝。

- 设置：设置 > AI features > Artifacts 下的 “Extra artifact folders”（host 范围的 `artifacts` 设置，`extraFolders`，最多 20 条、每条最多 1000 字符），一组文件夹文本框，可增删；说明只写后果：agent 可以把这些文件夹下的任何文件附加到任何卡片。
- 读取：绝对路径或 `~/…`；`~` 展开为主目录，路径规范化（去掉末尾斜杠、`.`/`..`），重复项去掉。空字符串、相对路径、文件系统根 `/` 和主目录本身一律忽略（太宽，不会成为根）；格式不对的整体设置按空列表处理。
- 作用：这些目录追加到每张卡的 `roots`（`artifactRoots(task, project, workspaceDirectory?, extra)`）；`withinRoots`（两侧 `realpath`、按分隔符的前缀比较）和 `normalizeTarget` 不变，所以 `plans-old` 不算在 `plans` 内，目录内指向目录外的符号链接被拒绝。目录外的文件仍按绝对路径存储（§2.2）。
- 设置每次使用时读取：从设置里移除某个目录后，其中文件的产物在下一次状态检查（缓存键含这些目录）显示 “Missing”，记录保留；人工 RPC 和 agent 工具（`flowly_artifact`、交付时的 `outputs`、`flowly_get_task` 的 `missing`）都用同一份根。
- 验收（`server/artifacts.test.ts`）：额外目录内的文件被接受并存绝对路径；名字以其为前缀的同级目录被拒；目录内指向外部的符号链接被拒；`missingArtifacts` 在目录被移出设置后标记缺失；相对路径、空串、`/` 被忽略（含直接传给 `artifactRoots` 的情况）。
