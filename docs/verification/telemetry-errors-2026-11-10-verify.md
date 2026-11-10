# 独立验证：paseo.pid 读取与本地 daemon 连接失败（2026-11-10）

- 验证会话：`claude/claude-haiku-5-5`（独立验证，未参与编写）
- 验证提交：`eb62c81af12ad3dd344eb19fee88ca2b2c7e80ad`（detached，临时 worktree `/tmp/flowly-verify-eb62c81a`）
- 环境：`NODE_ENV=test FLOWLY_TELEMETRY=0`

## 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm ci` | 0 | 安装成功（仅 fsevents 安装脚本警告） |
| `npm run typecheck` | 0 | 通过 |
| `npm test` | 0 | 测试文件 153 通过、1 跳过（共 154）；用例 1342 通过、6 跳过（共 1348） |

全部通过，无失败输出。

## 代码审查发现

1. **Medium：连接失败包装会把认证失败也挡在遥测之外。** `server/local-daemon.ts:114`。关闭 reconnect 后，SDK 会以普通 `Error(reason)` 拒绝 `connect()`，其 reason 可能是 `Incorrect password` / `Password required`（来自 `DaemonAuthenticationError`，见 SDK `daemon-client.js:38-41, 650`）。现在它们统一包成 `LocalDaemonUnavailable`，不再上报。若 Paseo 协议或 Flowly 的 clientId/clientType 与 daemon 不匹配而导致系统性认证失败，这类问题会从 PostHog 消失，只剩控制台日志。建议：认证原因单独保留为可上报错误，或至少在包装前判断 reason。目前没有测试覆盖这一点。
2. **Low：首个重试测试依赖时序。** `server/local-daemon.test.ts:68-75`。写入发生在 25 ms，而读取只重试 9 次、每次 10 ms。在高负载下，理论上可能读完全部尝试后才写入，导致偶发失败。建议注入读取函数或延长窗口，改为由读取次数触发写入。
3. **Low：有效 JSON 但缺少 `listen` 时不重试。** `server/local-daemon.ts:68`。`{"pid":1}` 会立即返回 `undefined`，随后由 `daemonTarget` 抛出 `LocalDaemonUnavailable`。结果仍是不上报，行为正确，只是测试名 "retried until it is complete" 的覆盖面只到不可解析的状态。
4. **Low：非 ENOENT 的读取错误（如 EACCES）原样抛出，仍会被上报。** `server/local-daemon.ts:63`。这符合预期，但未在注释或测试中说明。
5. **Low：`unsupported` 分支未被测试覆盖。** `server/local-daemon.ts:116-117` 位于外层 try 内，包装只包 `connect()`，因此仍是普通 `Error`，上报行为与改动前一致（已读代码确认）。

## 调用方检查

- `server/paseo-version.ts`：catch 所有错误返回 `""`，不受影响。
- `server/summarizer-remove.ts`：经 `logFailure` 记录后归档兜底，不受影响；但连接失败不再上报，属预期。
- `server/session-reads.ts`、`server/workspace-restore.ts`：错误经 RPC 返回；`expectedRpcError` 对 `outsideError` 返回 true，因此不上报。改动仅影响返回给用户的错误文本（变为 "could not be reached: ..."）。
- `server/background-workspace.ts` 未直接使用 `openLocalDaemon`，不受影响。
- 重试参数（10 次 × 50 ms，最长约 450 ms）与 Paseo 自身读取器一致，`connectTimeoutMs` 为 5000 ms，无叠加风险。

## 总结结论

**通过，附注意事项（pass with notes）。** 类型检查与全部测试通过。修复逻辑正确：ENOENT 与其他读取错误分开处理，空文件、半写入和 `null` 均重试后返回 `LocalDaemonUnavailable`。建议在合并前或后续处理 Medium 第 1 项（认证失败不应被静默吞掉），并将第 2 项的时序测试改为确定性实现。

Worktree `/tmp/flowly-verify-eb62c81a` 保留，未删除（按要求由请求方清理）。

## 复验：提交 f6823b6（2026-11-10）

- 验证会话：`claude/claude-haiku-5-5`（独立验证，未参与编写）
- 验证提交：`f6823b6dbb0b2e861f43c36999eeba2888363f2e`（基于 `bad25d6`，临时 worktree `/tmp/flowly-verify-f6823b6d`）
- 环境：`NODE_ENV=test FLOWLY_TELEMETRY=0`

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm ci` | 0 | 安装成功（仅 fsevents 安装脚本警告） |
| `npm run typecheck` | 0 | 通过 |
| `npm test` | 0 | 测试文件 153 通过、1 跳过（共 154）；用例 1344 通过、6 跳过（共 1350） |

全部通过，无失败输出。

### 代码审查发现

1. **Low：RPC 错误的 `value` 在 `requestType` 不合格、`code` 合格时输出 `:code`。** `server/error-report.ts:118`。与“各部分为空”的字面规则一致，没有泄漏，但形态不是 `requestType:code`，前导冒号会进入指纹。测试 `server/error-report.test.ts:98` 把这一形态锁定了。建议：只有 `requestType` 合格时才加冒号，否则只输出 `code`，并同步 TELEMETRY-SPEC §11.3。
2. **Low：测试名与覆盖不符。** `server/local-daemon.test.ts:83` 的名字是“不应答”，实际覆盖的是连接被拒绝（refused，见第 88 行）。超时和中途关闭没有单独测试，但它们与拒绝走同一个 `catch`（`server/local-daemon.ts:115`），风险低。
3. **Info：信息泄漏路径核对。** `value` 只来自 `requestType` 和 `code`，并且必须整段匹配 `^[a-z][a-z0-9_.]{0,59}$`，错误消息 `error.message` 从不读取。消息里的空格、`/` 都无法通过匹配。理论上只有一种途径：daemon 把一个单词形式的文本放进 `code`。SDK 当前的 `code` 来自 payload 的错误码，不走消息文本，因此这一途径目前不可达。
4. **Info：上一轮的 Medium 发现已修复。** 认证失败现在原样抛出（`server/local-daemon.ts:116-117`），并有测试覆盖（`server/local-daemon.test.ts` 末尾的 `rejects the local credential` 用例，断言 `name === "DaemonAuthenticationError"`，且 `outsideError` 为 false）。
5. **Info：SDK 核对。** `DaemonRpcError` 定义在 `daemon-client.js:141`，字段为 `requestType`、`code`、`requestId`、`serverId`、`userMessage`。构造位置在第 1214 行（RPC 错误消息）和第 1533 行（`requestType` 为 `message.type`，无 `code`）。关闭 reconnect 后，SDK 在第 5103-5105 行以 `DaemonAuthenticationError` 拒绝（条件是 `authFailureReasonValue` 已设置，来源见第 644 和 4887 行）。否则以 `input.failure` 或普通 `Error` 拒绝。
6. **Info：提交内容。** `bad25d6..f6823b6` 的差异还包括 `OVERVIEW.md`、`README.md`、`docs/PROGRESS.md`、`docs/WORKSPACE-RESTORE-SPEC.md` 和两个 `docs/verification/telemetry-errors-2026-11-10*.md`，不只是卡片改动。这一点与请求描述不符，请求方需要确认。

### 对照文档

- `docs/TELEMETRY-SPEC.md` §11.3 的 `value` 例外条款与 `rpcValue` 一致（类型、小写、整段匹配、各部分为空、无错误码时只有请求类型）。唯一未写明的是第 1 条的 `:code` 形态。
- `docs/TELEMETRY-SPEC.md` §11.2 的 `LocalDaemonUnavailable` 列表（无 `paseo.pid`、重试后仍空或半写、连接超时/拒绝/关闭、无凭据）与代码一致。`DaemonAuthenticationError` 照常上报，与代码一致。
- `docs/WORKSPACE-RESTORE-SPEC.md` 第 1 步与 `readListen` 一致（10 次、每次间隔 50 ms；ENOENT 与仍不可读均为 `LocalDaemonUnavailable`；认证拒绝保持上报）。

### 结论

**通过，附注意事项（pass with notes）。** 类型检查和全部测试通过。`value` 不会带出错误消息，认证失败不再被静默吞掉。需要处理的是第 1 条（`:code` 形态）和第 6 条（提交范围与描述不符）。第 2 条是测试命名，可顺手修正。

验证 worktree `/tmp/flowly-verify-f6823b6d` 保留，未删除，由请求方清理。`npm ci` 生成的 `node_modules` 也在该 worktree 内。
