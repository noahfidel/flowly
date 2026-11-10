# Paseo 0.14 插件工具接入：调研与设计

2026-11-06，卡片「paseo tools接入」。状态：用户已确认 §5（D1 升到 0.14.0，D2 走路线 B），已实施。

## 1. 0.14 给插件新增了什么

出处：`@getpaseo/plugin@0.14.0` 的 `dist/server/agent-tools.d.ts`、`dist/server/lifecycle.d.ts`；Paseo 0.14.0 daemon（`@getpaseo/server` 的 `agent/agent-manager.js`、`agent/tools/plugin-tools.js`、`plugins/runtime.js`、`plugins/agent-tools.js`）；上游示例 `getpaseo/paseo/plugin-examples/agent-tools`。

`before("agent.session_open")` 的请求从 0.11.2 的 `{agentId, workspaceId, provider, cwd, reason, purpose, env}` 扩成：

| 新字段 | 含义 |
| --- | --- |
| `title`、`labels` | 只读，session 的标题和 labels |
| `tools: AgentToolDefinition[]` | 插件用 `defineAgentTool({name, title?, description, input: zod, execute})` 定义、挂到这一个 agent 上的工具 |
| `mcpServers` | 插件给这一次启动加的 MCP server，**只在启动时生效，不写进 agent 保存的配置** |

daemon 行为（逐条读代码确认）：

1. 每次打开 session（create / resume / refresh / import）都调用这个 hook，`tools` 和 `mcpServers` 每个插件从空开始；只有 `purpose: "interactive"` 才挂工具和 MCP。
2. **插件工具不是单独的 MCP server**：它们并进 Paseo 自己的 agent MCP（`paseo`，`/mcp/agents?callerAgentId=…`），模型看到的名字是 `mcp__paseo__<name>`。`execute` 在插件进程里跑，`context.agent` 由 daemon 给出（id、workspaceId、provider、cwd、title），不需要插件自己发凭据。
3. 插件工具受 Paseo tools 开关约束：daemon 关闭 Paseo tools、该 provider 的 `paseoTools.enabled === false`、或工具名在 `disabledTools` 里时，**插件工具静默消失**。插件在 hook 里看不到这个策略。
4. 名字规则 `^[a-z][a-z0-9_]*$`、≤64；和 Paseo 内置工具同名或和别的插件同名时 daemon 抛错。`AgentToolDefinition` 没有 `outputSchema`、`annotations`（`readOnlyHint` 等）。
5. 插件 `mcpServers` 与 agent **保存的配置**里同名 server 冲突时，daemon 抛错，**这次 session 打开失败**；provider 不支持 MCP（`capabilities.supportsMcpServers` 为 false）时也失败。
6. 插件启动、停止、reload 会把已打开的 session 标为过期，下一次空闲 prompt 前重新打开（不打断正在跑的回合）；`paseo.agents.ref(id).reload()` 立即生效但会打断回合。
7. 0.15 把 hook 改名为 `addHook("agent.open.before")`，旧名 `before("agent.session_open")` 保留到 2027-04-30。Flowly 已迁移（§5 D3）。

## 2. Flowly 现在怎么接工具

- 自建 loopback HTTP 服务（`server/tool-server.ts`）：`/mcp`（官方 MCP SDK）+ `/api`（CLI），Bearer 凭据绑定 `agentId + taskId + workspaceId`（`PHASE-02-SPEC` §8）。
- 从卡片新建 session：客户端把 `mcpServers: { flowly: { type: "http", url, headers: { Authorization } } }` 写进 **agent 创建配置**（`client/session.ts:129`、`client/session-create.tsx:160`），因此 URL 和凭据随 agent 永久保存在 Paseo 的 agent 记录里。
- 已有 session 经 “Send Kanban work instructions” 加入：只有 CLI（`prepareExisting` → `prepare(..., "cli")`），因为 0.11 不能给已有 session 加 MCP（`PHASE-02-SPEC` §3.2、PROGRESS 第 146 行的原始限制）。
- `addHook("agent.open.before")`（迁移前是 `before("agent.session_open")`）现在只给已绑定的 interactive session 续写 `FLOWLY_CONTEXT_FILE` 等环境变量（`index.server.ts:783`）。
- 调研时依赖 pin 在 `@getpaseo/plugin` 0.11.2，`requirements.paseo >=0.11.2`；本机宿主已是 0.14.0，npm 上已有 0.15.2。

**结论一：0.14 的插件工具能力 Flowly 完全没用上。**

## 3. 有没有必要接

现有做法的真实缺口：

| # | 缺口 | 影响 |
| --- | --- | --- |
| G1 | 后加入的 session 只有 CLI | agent 要读 skill 才知道用 shell 调 CLI，命令长、易错；工具参数（nextMoves、outputs）没有 schema 引导，`DELIVERY-CONSTRAINTS` 依赖的“参数兜底”在 CLI 上弱 |
| G2 | MCP URL 与凭据写死在 agent 保存配置里 | 凭据进了 Paseo 的 agent 记录；插件卸载或端口变了，旧 agent 每次启动都连一个死的 server；无法按开关增减 |
| G3 | 自建 MCP 服务 + 两个 MCP SDK 依赖 | 维护成本，和 Paseo 的工具体系平行 |

两条可选路线：

| | A. `defineAgentTool`（插件工具） | B. 启动时注入 `mcpServers`（同一个 0.14 hook） |
| --- | --- | --- |
| 解决 G1 | 是 | 是 |
| 解决 G2 | 是（无凭据） | 是（凭据不再保存，只在启动时下发） |
| 解决 G3 | 只去掉 MCP 部分；CLI 仍要 HTTP 服务和凭据 | 否 |
| 用户关掉 Paseo tools 或某 provider 的 Paseo tools | **Flowly 工具静默消失**，插件无法判断，只能再保留 B 兜底 → 两套同名工具 | 不受影响 |
| 工具名 | 变成 `mcp__paseo__flowly_*`；用户已有的 `mcp__flowly__*` 权限白名单失效 | 不变 |
| `outputSchema` / `readOnlyHint` | 丢失 | 保留 |
| 风险 | 低 | 同名冲突或 provider 不支持 MCP 会让 session **打不开**，必须在 hook 里避开（§4.3） |

**结论二：有必要接，但接 B，不接 A。** A 的收益（不用凭据）抵不过“Paseo tools 一关就没工具”且插件无从察觉；为它兜底又得保留 B，模型会同时看到两套工具。B 用同一个 0.14 hook 解决 G1、G2，工具名、schema、注解都不变。A 留作以后：Paseo 若让插件读到 Paseo tools 策略，或支持把插件工具放进插件自己的 MCP 命名空间，再评估（§7）。

## 4. 设计（路线 B）

### 4.1 行为

1. `before("agent.session_open")`（`server/session-open.ts`）：对已绑定（有 context 文件）、未归档卡片、`purpose: "interactive"` 的 session，除现有环境变量外，返回 `mcpServers: { ...request.mcpServers, flowly: <url + Bearer> }`（`ToolServer.sessionLaunch` 决定给不给）。
2. 新建 session 不再把 `flowly` 写进创建配置；身份仍在创建前预分配（`tools.prepare-session` 不变），MCP 由第一次打开时的 hook 加上。
3. “Send Kanban work instructions” 加入的 session（`tools.prepare-existing`），在确认 provider 接受 MCP server 之后才记 `launch-mcp`（见 §4.3 第 2 条）：
   - 已记 `mcp` 或 `launch-mcp`：不再处理。
   - `idle`：先记 `launch-mcp`，再 `reload()` 让 hook 加上 MCP。reload 后的快照（此时 agent 已加载）报告 `supportsMcpServers: true` 才保留；reload 失败或不支持就去掉 `launch-mcp`，失败记 `logFailure`，照常返回。
   - `running`：不打断。快照报告 `supportsMcpServers: true`（运行中的 agent 一定已加载，能力可信）就记 `launch-mcp`，本回合用 CLI，下次打开起有 MCP；否则只用 CLI。
   - 其他状态（`initializing`、`error`、`closed`）：只用 CLI。
   - 然后客户端发指令。指令文本不变：skill 本来就写“有 MCP 用 MCP，否则用 CLI”。
4. 卡片删除、归档或解绑后，下次打开不再注入，旧 session 自然失去 Flowly 工具（G2）。
5. CLI 和 `/api` 保留不变，是 MCP 不可用时的兜底。

### 4.2 数据契约

- context 文件 `methods` 取 `"cli" | "mcp" | "launch-mcp"`；`"mcp"` 只表示 **agent 保存配置里带 `flowly`**（本版本前从卡片新建的 session）。`"launch-mcp"` 表示由 hook 注入：`tools.prepare-session` 写入它（建不成就说明 provider 不支持，与原来一样）；`tools.prepare-existing` 按 §4.1 第 3 条确认后写入。hook 只读不写它。未知值按原样保留（不重置、不报错）。
- `ToolPreparation`（`tools.prepare-session` / `tools.prepare-existing` 的返回）去掉 `mcp` 字段：凭据不再交给客户端。
- `tools.access-state` 把 `launch-mcp` 显示为 `mcp`（侧栏 “Configuration provided: CLI + MCP”）。

### 4.3 必须避开的打开失败

hook 抛错或返回冲突会让 session 打不开，这是最高风险：

1. 旧 session（`methods` 含 `"mcp"`）**不注入**，否则与保存配置里的 `flowly` 冲突。拿不准时不注入。
2. provider 不接受 MCP server（如 Pi、部分自定义 ACP provider）时注入会让打开失败。hook 里拿不到可靠的能力：未加载的 agent（daemon 重启后的 resume）快照用默认能力，`supportsMcpServers` 恒为 `false`；provider 快照不带能力。所以 hook 只在 context 记了 `launch-mcp` 时注入，`launch-mcp` 只在能力被确认后写入（§4.1 第 3 条）。从卡片新建的 session 由创建本身确认：provider 不支持时创建失败，与原来写进创建配置时一样，不新增风险。Paseo 在 reload 时先检查能力、再替换 session，所以确认失败不会弄坏已有 session。
3. hook 内任何异常都记 `logFailure` 并原样放行请求（不加环境变量和 MCP），绝不向 daemon 抛出。

### 4.4 兼容

- 用户决定（2026-11-06，§5 D1）：`requirements.paseo` 升到 `>=0.14.0`，`@getpaseo/plugin`、`@getpaseo/protocol`、`@getpaseo/client` pin 到 0.14.0。0.11–0.13 的用户不再能装新版本。被否决：保留 `>=0.11.2` 加特性检测（多一条分支和测试）。
- 客户端与 daemon 同版本发布、同时 reload，所以客户端不再把 `flowly` 写进创建配置不需要过渡期。
- 仓库内自己建 session 的脚本（`benchmarks/constraints/runtime.mjs`、`docs/promo/*.mjs`）同步去掉 `mcpServers`。`docs/verification/` 下的旧脚本是历史证据，不改；重跑前要先去掉其中的 `mcpServers`，否则与注入冲突。
- 0.15 的 hook 改名不在本卡范围；旧名可用到 2027-04-30（§7）。

### 4.5 不做

- 不改工具集合、参数、返回值和 skill 内容（工具名不变）。
- 不迁移旧 session 的保存配置（删掉它需要改 agent 配置，SDK 没有对应接口；旧 session 继续工作）。
- 不给未绑定的 session 注入（`PHASE-02-SPEC` 2026-10-15 修订的规则不变）。

## 5. 用户决定（2026-11-06）

- **D1** 最低 Paseo 版本升到 0.14.0（不做旧版本特性检测）。
- **D2** 走路线 B，不接 `defineAgentTool`。
- **D3**（2026-11-07，迁移卡）最低 Paseo 版本升到 0.15.0，`@getpaseo/plugin`、`protocol`、`client` pin 到 0.15.0；hook 全部改用 `server.addHook`：`agent.session_open`→`agent.open.before`、`agent.turn_started`→`agent.turn.before`、`agent.turn_ended`→`agent.turn.after`、`agent.permission_requested`→`agent.permission.before`。0.14 的用户不再能装新版本。被否决：用 `typeof server.addHook` 特性检测同时保留旧名（旧名 2027-04-30 后失效，还要多一条分支和测试）。回合内容不再读 hook 的 `timeline`（恒为空），一律用 `server/turn-timeline.ts` 读 session 最新一页（`limit: 200`，不是 20：回合工具调用多时 20 条够不到用户消息）。看板事件名 `agent.turn_started`/`agent.turn_ended` 是已存数据，不改。

## 6. 验收标准

1. 从卡片新建的 session：agent 保存配置里没有 `flowly`（SDK 快照的 config），模型能调用 `mcp__flowly__flowly_get_task` 并成功。
2. 原生入口新建、再用 “Send Kanban work instructions” 加入的空闲 session：重开后能用 MCP 调 `flowly_get_task`；运行中的 session 不被打断，本回合用 CLI 成功；不支持 MCP 的 provider（如 Pi）的 session 照常打开，只用 CLI。
3. 0.13 前创建、配置里带 `flowly` 的旧 session：照常打开，不报 MCP 冲突，工具可用。
4. 删除卡片后，该卡 session 下次打开时没有 `flowly` MCP，打开本身不失败。
5. hook 内注入失败（模拟抛错）时 session 仍能打开，日志有 `logFailure`。
6. `npm run typecheck`、`npm test` 通过；`server/tool-server.test.ts` 与 `server/session-open.test.ts` 覆盖 §4.3 三条。

## 7. 后续

- 重新评估路线 A 的条件：Paseo 向插件暴露 Paseo tools 策略，或插件工具可有自己的命名空间、`outputSchema` 与注解。
