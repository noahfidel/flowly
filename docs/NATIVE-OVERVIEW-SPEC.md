# Native overview 与独立详情：两阶段实施规范

2026-10-24 后续用户决定：[统一宽度策略](RESPONSIVE-PERFORMANCE-SPEC.md)将本文
native compact 路径推广为所有平台的compact路径，含窄窗口Web；宽屏沿用完整看板。
本文旧“web/tablet保持”表述及既有真机验证是历史范围，当前布局由宽度决定。
Overview/CardDetail/完整Board的类型、key、etag和fresh授权边界继续保持。

状态：2026-10-23 用户授权完整规范及阶段 1 实现、同三星固定源码对照；2026-10-24 用户授权阶段 2 实现与同三星固定源码复测。依据 [Fable/Astra 共识](verification/frontend-loading-advisors-2026-10-23/README.md)。本规范对 native compact 总览的条款优先于 PERFORMANCE/NATIVE-SESSION/MOBILE-QUERY-MODAL 中“进入看板先读完整 board”的历史条款，web/tablet 保持原行为。

## 1. 目标、范围与代价

- 阶段 1：手机总览使用明确的 BoardOverview，初显及空闲不读完整 board；保留描述/标签搜索、筛选、排序、列与项目计数、卡面信号、实时 Attention、提示与导航。
- 阶段 1 基线：用户显式打开卡片、Task/Project 表单、LinkPicker、删除/移除/wrap-up、项目 Ideas/Insights/Memory 或 idea/workspace 直达时，可沿用旧完整 Board。详情组件保持现有数据与生命周期，不卡住当前 scoped-card 导航。
- 阶段 1 基线代价：**首次显式开卡可能新增数秒等待**：成本从进入看板移到首次打开卡片，旧全量路径仍约 2.3 MB。必须单列首次开卡的 RPC/首显/详情可用；不得只交付更好看的总览数字。
- 阶段 2：独立 CardDetail 和项目索引消除详情隐式整板依赖；按 §5/§7 实施。
- 不迁移/删改存储、不改变每卡最多 100 条含正文事件、不新增 Activity 分页、不改变业务写路径、session 所有权、input key、连续可反转动画和 450ms Modal 交接。缓存只展示。

## 2. 数据依赖清单

“总览”包含项目 chooser、status/filter/sort/Attention sheet 和卡片 action sheet；只打开这些菜单不应加载整板。Settings/Welcome 保持原模块，未打开时不能因内部 observer 偷读 board。

| 当前 reader / 派生 | 输入 | 阶段 1 总览来源 | 进入完整路径的边界 / 阶段 2 |
|---|---|---|---|
| project chooser/tabs、pickProject、lane config | projects、position、archived | overview.projects 完整项目记录 | ProjectForm 显式打开仍旧路径 |
| tasks / search / type / priority / tag / counts | Task，含 description、tags、position、status | overview.tasks 完整 Task（当前约 111KB） | 不引入服务端搜索/分页 |
| projectTagStats / tagPrefixes | 项目全部未归档 Task tags | overview.tasks，沿用原规则 | 详情标签建议用显式项目 context |
| statusChanges / flash / laneRows / sorts | Task 身份/status、最后 turn end | Task + card facts；原动画和行 key | 不重挂载总览树 |
| Recent activity | 每卡 max turn end + 哪些 agent 曾结束；无事件 session idle 时间 | card.turnEndedAt / session.hadTurnEnd + 现有 live agents / settledAgents | 不由 updatedAt 替代原 turn 规则 |
| olderFinished | 当前 finished lane 最近进入时间，否则 updatedAt | card.finishedAt（原规则结果） | Date.now、days、keep 仍在 UI 决定 |
| card wrapped | currentWrapup | card.wrapped boolean | 详情仍全部 stored events |
| card questions | cardQuestions | card.questions 数量 | 不传问题正文到总览 |
| card workpad | workpadSignal | card.workpad 的 kind/done/total/count | 详情保留全部 workpad |
| card ideas / project Ideas count | open ideas | card.openIdeas，按 Task project 聚合 | 显式 IdeasPage 读旧完整 Board |
| card external key/family | artifacts 顺序 + faceKey/familyOf | card.external（旧首个 key +n 规则） | 全部 artifacts 只供详情 |
| Waiting on | waitingOn(tasks, links) | overview.links + 原规则（Task title 可达） | 不只传目标卡 links 冒充项目 |
| Attention / session summary | event-derived facts + live agent + receipts | session latestTurn/action/at、questionEventId、silent，结合原 stream/receipt 引擎 | 不生成假 events；instant permission/error/unread 保持 |
| tips / welcome / whats-new boardLoaded | counts，artifact/external/workpad/next moves 是否存在 | card.hasArtifacts/hasExternal/hasWorkpad/hasNextMoves + tasks/projects | 文案/优先级不变，不新增 tip |
| workspace availability / outputSession | resources、managed sessions、live agents | 现有独立查询，overview 到达后启用 | 只对可见卡片启动 output/tail |
| Progress summaries | summaries.latest | 现有 summaries query | 不为 summary 回读完整 board |
| sidebar/chip | attention.count / chip projection / agent list | 保持既有独立来源和 etag | 不合并到 overview，不新建全局 store |
| drawerTarget、TaskDrawer 及 Progress/Workpad/Tags/Links/Ideas/Artifacts | 完整目标数据 | 只在显式打开后启用旧 full Board；卡头可先用 Task 元数据 | 阶段 2 全部改 CardDetail，不能只删预取 |
| TaskForm / ProjectForm / LinkPicker / delete / wrapup | 完整规则输入与候选 | 组件只在显式打开时挂载；需要时读 full Board | 阶段 2 用项目索引/候选 |
| project Ideas / Insights / Memory | full ideas / tasks / revision 等 | page 显式打开才启用旧 full Board；防止用空 ideas 假称空页 | 阶段 2 对应独立 query |
| chip direct-card | fresh scoped board + exact session refresh | 现有路径不改，后台 full 仍保留，非总览零请求范围 | 阶段 2 删除后台 full |
| refresh / mutation invalidation | 对应可见数据源 | 只 refetch 当前展示源；invalidate overview 不 refetch disabled full observer | 详情写入后也 invalidate overview |

所有当前完整 board 属性读取必须归入表内分支；union 的公共 metadata 不意味着 events/ideas/workpads 存在。完整 reader 的挂载检测是验收，源码搜索不是充分证明。

## 3. 阶段 1 RPC 与 DTO

新增 schema-validated `board.overview-changed`，输入 strict `{etag?: string}`，最大 200 字符。不带 since。当前 scope 为此 daemon 的全部项目/卡片，保留 archive 记录用于既有 filter；未来 project scope 须升契约/key，不在此阶段增加。

`BoardOverview = {version:1, revision:number, projects:Project[], tasks:Task[], links:Link[], attentionDismissals:AttentionDismissal[], cards:CardFacts[], projectIdeas:{projectId, open}[]}`（`projectIdeas`：每个项目一条，`open` 为该项目自身（无卡片）的未处理 idea 数，见 PROJECT-IDEAS-SPEC §5；键为 projectId，与其他集合一样走 patch）。
不含 events、ideas、artifacts、workpads、plans 集合，任何完整 Board schema 均不能接受该值。

`CardFacts = {taskId, wrapped:boolean, questions:number, openIdeas:number, external?:{text,family}, workpad:WorkpadSignal|null, finishedAt:string, turnEndedAt?:string, hasArtifacts:boolean, hasExternal:boolean, hasWorkpad:boolean, hasNextMoves:boolean, sessions:SessionFacts[]}`。

`SessionFacts = {agentId, latestTurn?:{action:'agent.turn_started'|'agent.turn_ended',at:string}, questionEventId:string|null, silent:boolean, hadTurnEnd:boolean}`。只含事件派生事实，列出此卡事件中出现的 agent；未出现的 live session 使用无事件默认事实。turn 取原数组最后一次，不改为时间排序；max turn-end / finishedAt 分别沿用现有 sort/olderFinished 规则。

CardFacts 由 daemon 对同一 store.view 快照复用 shared/progress、wrapup-state、workpad、next-moves 等现有规则计算，不能维护另一个近似算法。Attention 将“扫描事件”与“组合 agent/receipt 状态”分开复用同一引擎；不传假 BoardEvent 来适配旧 API。

响应三选一：`{etag,value:BoardOverview}`、`{etag}`、`{etag,patch:{baseEtag,revision,projects?,tasks?,links?,attentionDismissals?,cards?}}`。每项 collection patch 为 `{set:Item[],remove:string[],order?:string[]}`；前三个以 id、后两种以 taskId 关联。set 更新/追加，remove 删除，order 在必要时明确所有保留 id 的顺序。cards 与 tasks 一同反映删除/重绑。

server 独立 OverviewDeltas 缓存最近 32 个 etag 的 collection 指纹，lookup 先于 eviction。etag 带 overview-v1 域，与 full/chip 不混用。未知/遗失 etag 返回当前完整 overview，绝不回退到完整 Board。patch 没有 events-tail 假设；revision-only patch 合法。patch 更新保持未变 item 引用。

## 4. 客户端缓存、可见性与交接

- key `['flowly','overview',hostId,1]`；与 `boardKey`、native chip、scoped cardLink 分离。createChangedReader 只在自己持有的 cache update count 仍匹配时发送 etag。
- patch 校验 baseEtag 与请求基线；本地无基线/缓存被替换/无法应用时最多重读一次当前 overview。无 value 的 full 响应报错；不递归重试完整 Board。
- native compact 总览可见时 overview 每 3 秒轮询；被详情/page/form 覆盖时停止 overview 自有 interval。没有取消其他消费者共享请求。
- 完整 board observer 在普通总览始终 disabled、无 interval。显式功能打开时才 enabled；可见 drawer 仍接手既有 poll，避免 root/drawer 双 interval。项目 page 或 form 的既有完整输入仍可刷新。
- metadata 展示可比较两种已取得数据的 revision：只有共同 projects/tasks/links 字段可使用较新版本；完整详情只能取完整来源，overview 永不进入 preferFullBoard、CardBoardContext 或完整 cache。较新完整删除不能被旧 overview 复活。
- Overview 刷新/错误/空值不卸载根树。详情开关沿用同一 motion presence；Back 恢复 overview，保留项目/lane/filter/scroll。
- Link/workspace/idea 路由是显式完整功能入口，不属于普通总览零 full 请求窗口。route/requestId guard、fresh scoped task + exact session refresh、动作 fresh 校验一律不改。
- 用户手动 Refresh 和动作结束刷新当前展示源，并使另一源失效但不强制拉取不可见数据。不可因 refetch() 绕过 enabled 在总览触发 full Board。
- 初读 overview 错误显示原错误/Retry，不回退自动 full read；刷新失败保留旧展示并显示错误。agents 未就绪/失败仍 Loading sessions / Session state unavailable，read state 失败只按既有规则抑制 unread，不误报无 Attention。
- 不新增可见设置/入口/文案；不需 onboarding 或 whats-new 通知，原行为与指导不变。

## 5. 阶段 2 完整规范（2026-10-24 已授权实施）

独立 `cards.detail-changed {taskId,workspaceId,etag?}`：每次 server.view 核对 task/workspace/project，不匹配/删除返回 unavailable 错误，绝不取缓存授权。响应 `{etag,value?:CardDetail}`，第一版仅 ifChanged，不带分页/patch；etag 带 detail-v1/task/workspace 域，覆盖全部详情输入而非仅 task revision。

`CardDetail = {version:1,revision,task:Task,project:Project,events:BoardEvent[],ideas:Idea[],artifacts:Artifact[],workpad:Workpad|null,plans:PlanSnapshot[],links:Link[],relatedTasks:CardReference[],attentionDismissal:AttentionDismissal|null}`。events 为该卡全部现存最多 100 条含正文；relatedTasks 只含 links/idea references 所需 id/projectId/title/status/archivedAt。没有全项目 Task 或其他卡正文。

项目上下文独立 `projects.card-index-changed {projectId,etag?}` → `{etag,value?:{version:1,projectId,revision,cards:CardReference[],tags:TagStat[]}}`；CardReference 还包含 position/type/priority/workspaceId，以完整当前项目未删除卡（含 archived）满足候选规则。LinkPicker 沿原关系/归档/搜索/排序规则应用（title 搜索），tags 用原 projectTagStats 结果，Ideas 引用标题覆盖 linked/source/accepted targets；缺少跨项目引用时详情带必要 relatedTasks，不假称完整候选。

- key 详情含 host/1/taskId/workspaceId，项目索引含 host/1/projectId；独立 changed readers，Back 后晚到结果可入该 scope cache但不得导航。
- 所有 drawer section 显式 CardDetailContext/query；不创建 full observer 再 proxy 返回。冷 link 仍 fresh CardDetail + exact session refresh；普通开卡用展示 cache先显，动作独立 fresh 校验。
- 可见详情每 3 秒 etag，session preview 时暂停不必要详情轮询；状态 stream仍独立。原完整 board轮询、direct-card后台 full删掉。
- 详情写操作刷新详情并 invalidate overview/project index；服务端写路径仍校验当前 task/project revision、真实 workspace/session，不能通过旧详情授权。
- 删除/重绑刷新失败为不可用，不能回退旧数据“复活”；刷新网络错误可保留过期展示，动作必须拒绝fresh失败。input key/focus/草稿/scroll不由响应替换而重置。
- Back 只恢复 overview，冷 cache显示既有加载/错误；旧 route结果不切卡、不重开 modal、不重置输入。
- Activity 第一版不拆请求、不分页，完整语义不以“仅显示12条”裁减。
- 项目 Ideas/Memory/Insights 不隐含订阅完整 Board；各用显式页面 query。web 仍旧契约，保留旧RPC便于兼容/回退。
- 验收：直达详情及停留 full请求0；全部section mounted检查；标签候选/相关标题/旧回调/删除/fresh拒绝；不丢正文或输入。128KiB仅当前90KB测试卡参考，异常大内容单列不裁。

## 6. 阶段 1 验证计划与通过门槛（历史基线；阶段 2 见 §7）

1. before-code 保存源 manifest/dirty HEAD 和 baseline冻结副本；candidate 同配置冻结，手机两组均使用相同诊断粒度、实际 bundle hash确认、server/read版本一致。
2. shared/server focused：规则结果逐项等价；多session、乱序时间、空建议、失败turn、事件淘汰、wrap恢复、workpad交付/失效、无事件agent、archived、未知/遗失etag、eviction、add/remove/reorder、revision-only、base mismatch、cache replacement。
3. client mounted：冷 QueryClient 的 native总览首显/idle、Filter/Sort/Status/Attention等轻菜单不发 full；显式卡片/page/form才允许；Back停full interval并恢复overview；web仍旧查询，fresh导航从不加入overview in-flight。保留组件key、连续动效与MODAL_CLOSE_MS=450，测试不替代真机IME/Reduce Motion。
4. 命令：`npm run typecheck`；`npx vitest run shared/overview.test.ts server/board-overview.test.ts client/overview-query.test.ts client/session-link-query.test.ts client/attention.test.ts`；Luna full-access mounted runner；最终固定树一次 `npm test`。不为无变化输入重复全量。
5. 同一三星 RFCW214ZCFA / SM-S911B、原连接、Powered stay awake；三组预定交错 A/B。记录实际源码和bundle hash、数据规模、parent/session恢复与background负载；真实数据变化则标描述性，不能假称固定数据。
6. 区分 app入口、总览RPC/schema/apply/effect、原生首帧、首显后idle/滚动/Attention、首次卡头和完整详情；UIA selector约7秒不能算触摸延迟，入口失败INVALID。单列每个样本、中位数/最大，不用6样本估计P95/FPS。
7. 数量门槛：stage1总览首显+5s空闲，完整Board请求0。当前规模overview目标≤300KiB，首屏RPC→effect中位数目标≤1.5s，非预先承诺；报告全部可归属Flowly RPC总字节/次数和宿主native请求的覆盖限制，不能只展示小overview而隐藏等量辅助负载。
8. 单列首次显式开卡，报告仍沿旧全量路径的耗时及body bytes；不称全导航已快。fresh/删除/错误、搜索计数、输入或连续动画任一回归拒绝候选。
9. 产品测试/Luna/phone证据独立；PASS/FAIL/INVALID/UNRUN分列。恢复正式入口与日志、停止owned进程、精确删除本轮owned测试session/native+plugin核验，清理ownedruntime/tools；保留证据归档与共享缓存。UI只操作三星，本轮不碰桌面用户窗口。
10. 若小overview后仍等待数秒，继续依区段做宿主receive/dispatch/decrypt/JSON/恢复/parse观测；不按线性ms/KB推断，不要求“至少两倍”，不无证据改crypto/协议/存储。


## 7. 阶段 2 实施与验收清单（2026-10-24）

阶段 1 的旧 full 路径说明保留为 baseline，不是阶段 2 的许可。普通手机开卡、chip 直达、详情停留、LinkPicker、返回及项目页面不再触发 full。显式 Task/Project 编辑表单、删除/移除/wrap-up 与旧 idea/workspace 入口仍可按需读 full；独立 native popover 动作的旧 fresh read 不在本次展示路径去耦范围。web/tablet 维持完整 Board 查询，给 drawer 生成明确的 CardDetail 适配值，不将任何局部值放入 boardKey。

| 消费者 | 明确数据源 | 加载、错误与刷新 |
|---|---|---|
| 卡头/Activity/会话上下文 | CardDetail.task/project/events，保留全部已存正文 | 普通开卡先展示 overview 卡头；详情到达后原位更新；冷 chip 先 fresh detail 与精确 session refresh，禁止后台 full |
| Progress | detail.project/workpad；独立 summaries | 不订阅 board；summary 刷新不拉详情以外的数据 |
| Workpad/plans | detail.workpad/plans | 写后使 detail/overview/index 失效；不改变输入 key |
| Tags | detail.task；projectIndex.tags | index 未到不可假装没有建议；编辑/保存保留原 native input 状态 |
| Links/Origin | detail.links + relatedTasks | 相关卡缺失显示原已删除语义；不假装完整项目 |
| LinkPicker | projectIndex.cards + 当前 detail.links | 按项目、归档、标题、lane/position 保留规则；加载/失败不显示成功空候选，重试重新读该 scope |
| Ideas/Artifacts | detail.ideas/artifacts；relatedTasks 提供 accepted/source 标题 | 乐观状态与 editor 不因 refetch 重挂载；所有更新失效对应 scopes |
| 项目 Ideas | 独立 projects.ideas-changed + overview.tasks | 完整项目 ideas，不限 open；加载/失败显式区分，不能空数组冒充空页 |
| Memory/Insights | 原独立页面 query + overview metadata | 移除根 full 门控；无需完整 Board |
| root refresh/Back | 当前 detail 或 overview | Back 恢复 overview；详情 interval 在 session preview/关闭时暂停；已发请求可只写其独立 cache |

project index 的 cards 为 taskSchema.pick 后的 CardReference（id/projectId/title/status/archivedAt/position/type/priority/workspaceId）；tags 复用 projectTagStats 的建议上限与排序。CardDetail.relatedTasks 含本卡、链接两端、origin 与已接受 idea 目标中仍存在的卡。project ideas 契约 strict `{projectId,etag?}`，输出 `{etag,value?:{version:1,projectId,revision,ideas}}`，独立 host/version/project key 和 etag 域。三个新 read 都在 store.view 当前快照上校验实体，未知 scope 拒绝；详情错误不能退回缓存授权。etag 对完整 DTO 内容哈希，分别带 detail/index/project-ideas 域，不只看 task revision；无基线 same 最多重读一次，无值报错，不退回 board。

CardDetailContext 是显式详情及项目上下文；子区段不调用 useBoardQuery，不能先建立 full observer 再替换 data。根详情 observer 只负责数据，唯一 interval observer 由可见 drawer 管理；关闭或 session preview 停 interval，不取消其他读者共享请求。项目 index 同样只在消费界面启用。写后统一 invalidate 展示 scopes；fresh send/context 与所有服务端 revision/workspace/session 检查保持原路径。

验证：focused `npx vitest run shared/card-detail.test.ts server/card-detail.test.ts client/card-detail-query.test.ts client/session-link-query.test.ts`；父方 `npm run typecheck`；Luna full-access mounted 覆盖普通/直达/各区段/LinkPicker/页面、冷 cache 同 etag、删除/重绑/晚 route/输入 identity、详情与 full in-flight 隔离；最终稳定树一次 `npm test`。同三星预定 2 对交错 baseline/candidate，记录冷首次开卡、至少 6 秒详情停留、session preview 及 Back + 5 秒空闲；请求计数/响应 JSON bytes/内部 RPC→schema→effect 与 UI ready 分开。baseline 首卡旧 full 成本单列，candidate 额外 detail/index 请求总量也单列；128KiB 是参考，不裁内容。固定源 hash 前后校验，真实业务数据变化单列，不承诺纯净固定数据或 FPS。连续 motion、fresh 与 450ms 任一回归拒绝候选。截图/IME/Reduce Motion 无真实操作时标 UNRUN。

阶段 2 交付（2026-10-24）：367 文件固定快照，Luna最终 full 1014/1014、focused13/13、父 mounted7/7（v5仅补web focus样式）及typecheck通过。同三星有效2+2样本，RPC→data effect中位数7.839s→2.634s；candidate开卡/停留/session preview/Back/idle及另一次native chip路由均0 full。数据与UNVERIFIED/INVALID边界见 [阶段2报告](verification/card-detail-2026-10-24/README.md)。不据此宣称触摸首帧/FPS或整条cold entry改善。
