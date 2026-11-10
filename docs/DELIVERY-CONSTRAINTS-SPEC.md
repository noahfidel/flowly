# 交付产物与先拒后确认（2026-10-22）

> 2026-10-28：本文部分内容被 [GUARDRAILS-SPEC](GUARDRAILS-SPEC.md) 取代（§12）。被取代：§2 的 `WORKPAD_OPEN` 部分；`SETUP_INCOMPLETE` 的先拒后放与 outputs 仍有效。

范围：接续“流程约束不足”卡片，实施调查报告建议 2。规则由插件提供，适用于所有项目、provider 和模型，不依赖项目 AGENTS.md。先完成本规范，再实现。

## 1. 交付调用的 outputs

`flowly_update_status(status=in_review)` 和 `flowly_report_progress(kind=result)` 接受可选字段：

```ts
outputs?: { target: string; title?: string; note?: string }[];
```

- 每次最多 20 项。各字段复用 artifact 的限制（target 2000、title 120、note 1000 字符）；对象严格校验。target 是 http(s) 链接（含 PR/MR），或卡片目录内存在的文件/目录。role 固定为 output。
- 省略表示本次没有声明产物：保持兼容，写入成功后在 reminders 提醒本回合登记产物，并在后续交付传 outputs；`[]` 明确表示本次没有产物，不删除旧产物，不提醒。该判断针对本次调用，先前单独登记不等于本次声明。
- 其他 status / kind 携带 outputs（包括 []）返回 INVALID_INPUT，不静默忽略。
- 非空 outputs 的目标在事务前校验。有效 http(s) URL 的 connector 元数据若因 ExternalError（权限、404、服务不可用等）无法读取，仍登记为普通 URL 并在 notice 说明没有外部详情；不猜外部状态/内容，不修改连接配置。裸 key 无法解析仍拒绝，非法 URL 和程序错误不降级。事务内调用现有 putArtifact，复用目标去重、更新 agent 条目、保护用户条目、外部 connector 识别和卡片上限。不自动创建 PR/MR，不向外部系统写入。
- 产物、交付事件、nextMoves 和回执同一事务提交。一项无效、容量不足、revision 冲突或交付被拒时，全部不提交。重复 target 的回执 ID 去重。
- 用户已添加的同目标 input 保持原样，返回带 target 的 notice，不能声称已改为 output。
- receipt 增加可选 artifactIds（数组；outputs=[] 时为空数组，省略时无字段），持久化 schema 和公开 schema 同步。精确重放返回原 ID，不再检查原文件是否仍存在或重新查询 connector；参数变更仍是 REQUEST_REUSED。回执证明当时提交，不保证产物现在未被用户删除。
- Agent artifacts 关闭：非空 outputs 返回 ARTIFACTS_DISABLED，整次不提交；省略或 [] 仍可交付且不提醒产物。独立 add_artifact 保留。
- 提醒为英文，仅成功写入时出现；顺序 next moves、ideas、outputs、setup。Done/Cancelled/归档后的回执重放不提醒。

CLI：status in_review / note --kind result 增加 `--outputs '<JSON array>'` 和 `--no-outputs`（等同 []），两者互斥；不合法 JSON、非数组、错误命令或非交付 status/kind 必须拒绝。帮助、MCP schema/描述及 skill 两份同步。

## 2. acknowledgeOpen 先拒后放

保留 WORKPAD-SPEC §5.3 / CARD-SETUP-SPEC §3.4 的触发范围：agent 状态实际变为 in_review；人拖动、result 和同状态汇报不新增门槛。

有 open workpad 项或 setup 缺项时，首次尝试总是返回 WORKPAD_OPEN 或 SETUP_INCOMPLETE，即使输入已经是 acknowledgeOpen=true。一次错误列出全部项，并要求先检查、补齐可补的项；仍需交付时解释每一项，再带 acknowledgeOpen=true 重试。没有问题照常提交。

拒绝不修改看板、事件、revision 或回执，但服务内为该 agent/card/workspace 保存最多 15 分钟的一次拒绝记录。确认只适用于同一 task/project revision、workpad revision、setup 缺项、HEAD sha/dirty/branch 。本 session 的 turn_started hook 主动清空记录，不读取截断事件判断回合。任一变化或服务重载，重新首次拒绝；缺项全部解决时直接提交。记录最多 1000 个绑定，过期/超限时移除最老项，移除后仅多一次拒绝，不会误放行。记录在成功交付后清除。

错误仍使用原有 code，不新增参数或 token。明确拒绝后可以用同一个 request 修改 note / acknowledgeOpen / outputs 重试，因为尚无回执；不确定是否提交的超时仍必须原参数重放。其他 session 的拒绝不能用来确认本 session 的交付。服务只保证反馈已经返回，不判断说明文字是否诚实或全面。

## 3. 验收与检查

- outputs 省略/[]/文件/普通 URL/PR/MR、角色保护、目标去重、无效路径/超限原子回滚、关闭开关、重放（含文件消失和服务重载）均有业务单测。
- 首次预带 acknowledgeOpen 仍拒绝；同状态确认通过；workpad/HEAD/task revision/turn/session/超时改变不复用；服务重载后拒绝；补齐后直接通过。
- MCP tools/list 暴露新契约，structuredContent 保留 receipt.artifactIds；CLI 覆盖 JSON 数组、--no-outputs、非法组合与一次成功交付、精确重放。
- 先聚焦：`npx vitest run server/agent-service.test.ts server/tool-server.test.ts`；再 `npm run typecheck`、`npm test`。仅输入变化或失败排查才重跑。
- 类型检查通过后 `paseo plugin reload flowly`，检查日志；running 只是重载证据。
- Tinylink 保留原项目和全部既有资源，只创建明确归属本测试的临时卡片/会话。分别使用 claude/claude-sonnet-5-5 与 codex/gpt-6-luna；创建时 full access（Claude 用发现的等价模式）。两轮：先产出文件并交付，再发送“创建 PR 并合入”，观察本回合是否主动通过 outputs 登记真实 PR 并再次交付。测试不强行补登，不把单测当模型行为证据。使用仅含测试文件的 PR，不改永久示例内容。
- Luna 测试 session 负责独立核对契约、错误、持久化与资源清理；记录 ID、实际 provider/model/mode、结果和限制。所有新卡片、session、分支和测试文件清理，已合入的 PR 保留为不可删除的历史证据，不能声称 PR 被删除。核对原生 registry 和看板；保留证据在 docs/verification/。

## 4. 用户文档

这是 agent 工具约束，无新 UI、设置或可发现入口。现有 Inputs and outputs 与 Workpad 引导已经覆盖用途，本次无需新 tour 文案、tip 或 What's new。更新相关 spec、SPEC-OUTLINE 与 PROGRESS，交付时明确模型行为验证是否通过。

## 5. 实施中补充

- 验证资料目录包含第三方 Angular 源码，原先全局 TS/Vitest 匹配误把它当产品代码。tsconfig 与 npm test/dev 排除 docs/verification，保留全部资料；产品源码及其测试仍完整覆盖。
- 用户 2026-10-22 明确要求 GitHub 私有测试仓库保留复用，覆盖 §3 的仓库清理要求。仓库 JasprW/flowly-delivery-fixture-20261022-036d 保留，测试 PR 历史保留；本轮卡片、session、workspace、临时分支/文件照常清理。Tinylink 不配置新 remote。

## 6. 本次交付状态

Sonnet/GPT 全新会话真实 PR 场景均通过；实现和本地检查完成。原生 fixture 与远端测试分支已清理，仓库按用户要求保留。仅 4 个本地 Tinylink 测试 refs 因沙箱拒绝写入、升级权限请求未完成而保留，workpad 明确记 unrun。交付到 In review 时必须先接收这项 open check 的拒绝，再带说明确认；不将卡片设 Done。
