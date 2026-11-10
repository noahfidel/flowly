# 护栏实机验证（GUARDRAILS-SPEC §14 实机 1–3）

- 提交：`53951db`（分支 `feat/guardrails`，未合并）。插件由 daemon 从该检出加载；本次未安装、未重载。
- 验证方式：Tinylink 固定演示项目；通过插件 RPC（`projects.update`、`guardrails.update`、`tasks.create/delete`、`tools.prepare-session`）和 Paseo 客户端操作；用户消息经 Paseo 网页输入框发送（无头 Chromium，`docs/promo/shot-lib.mjs`，未触碰用户的两个窗口）。
- 评审与流程证据：`~/.paseo/plugin-data/flowly/flow/3db2ad5b-…jsonl`；护栏数据只读查看 `guardrails.json`。
- 脚本在本目录（`lib.mjs`、`start.mjs`、`ui-send.mjs` 等）。

## 结论

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 1 审查、返工、剥离 | **通过**（Reduce Motion 未测） | 见下，截图两张 |
| 2 学习与升级 | **部分通过，偏离原文** | 原句 `新文案也要进所有语言` 未产生卡片项；改用可检查的 README 句。升级、准则范围、C 列出、D 不列出（修正后）均已验证 |
| 3 争议与误判 | **通过**（Workpad 评审区块的界面未核） | misfire 1 已验证 |

## 项 1：审查、返工、剥离

步骤：卡 A 的 session（`claude/claude-haiku-5-5`，`bypassPermissions`，经 Flowly 启动）第一次交付前把 `test/health.test.js` 的期望改为 201，`flowly_update_status(in_review)`。

证据（flow 日志）：
- 第一次评审：`Tests`（`npm run test`）`failed`，卡回到 `test`（R1）。返工消息以 `[Flowly auto review · rework 1/2]` 开头，写明 `Tests (npm run test) exited 1 [id: ec4340c2-…]`。
- 修复后第二次交付：`Tests` `passed`，`goal` `passed`，卡片显示 **Checked**。
- 第二次评审的 `goal` 还判了我让 agent 先故意失败的那条指令，使卡片再返工一次（agent 自行争议，见项 3 相关说明）。这是测试设计的副作用，不是功能问题。

截图（`docs/verification/guardrails-live-2026-10-29/`）：
- `item1-card-a-running.png`：评审中，卡面指示条 `Reviewing · 1/2 pass… · judging 1 ch…`（判断阶段）。
- `item1-card-a-finished.png`：评审结束，卡面 Checked。

偏离与未做：
- `Tests` 由 `detect` 加入时是 `observing`（不参与判定）。为让失败能退卡，我用 `guardrails.update` 设为 `active`（相当于 Guardrails 页操作）。
- 指示条的 `running <命令>` 阶段未单独截图；截图只有判断阶段。
- `600 ms` 保持最后一帧未验证。
- Reduce Motion 未测。

## 项 2：学习与升级

事实链：
1. 卡 A 第一次交付通过 Auto review 并已 Checked；用户消息先发到卡 A（卡在 In review，A1 在回合开始时拉回、A1r 结束时还原，符合 §4.1）。
2. `新文案也要进所有语言`：**未产生卡片项**。原因不明。该消息经 `paseo send` 发出时回合没有 `byUser`，摘要未运行；经网页输入框发出时摘要运行，`summaries.json` 有记录，但无 `correction`，也无错误记录。Tinylink 没有界面文案或语言目录，这句话对本仓库无可交付内容，模型的解读可能是“询问位置”而非纠正。
3. 换成可检查的 `新接口也要写进 README`：前两次仍未产生项（其中一次落在评审返工回合内）。第四次写成明确的纠正 `你这次交付不对：新接口没写进 README，以后新接口都必须写进 README` 后产生卡片项 `open`（`shape: feature, m`）。
4. 卡 B：交付 `GET /version`（未改 README），评审通过；用户以相同的句子退卡 → 项 A 与项 B 均 `promoted`，产生准则 `新增接口必须在同一次改动中写进 README 的接口列表`，scope `types: [feature]`，`sizes: [m]`，`learned`，来源两张卡。Guardrails 页显示 `Feature · Medium changes`、`caught 0 · missed 0 · misfire 1`（misfire 为项 3 的结果）。
5. 卡 C（`GET /ping`，同类型同大小，未改 README）：评审列出该准则并 `failed`（证据 README.md），返工消息逐条列出 `[id: 09e1edb5-…]`。agent 因“不要改 README”的卡片指令与准则冲突而自行争议（`disputed`）。C 未移到 Done，因此不计误判。
6. 卡 D（450 行夹具，不同大小）：**第一次评审仍列出该准则（`na`）**。原因：夹具是未跟踪文件，`git diff HEAD --numstat` 看不到，D 被判为 `m`（在范围内）。我让 agent 对夹具执行 `git add -N` 后重新交付：`git diff` 为 458 行（`l`），第二次评审不再列出准则。

偏离与发现：
- 原句未学到项（见 2.2）；用了替代句。改用替代句后，学习、升级、范围、C 列出的路径均按规范工作。
- 卡面大小统计：`shape` 按 `git diff HEAD --numstat` 加最近 5 个提交计算。本分支的最近 5 个提交是 Tinylink 的主分支历史，所以 Tinylink 上每张卡都会被判为 `m`，与自身改动无关。这一点值得你确认是否符合设计意图。
- 未跟踪的新文件不计入形状（见 2.6）。

## 项 3：争议与误判

证据：
- 卡 E（`GET /echo/:word`，指令：不改 README，若收到 README 发现则以争议理由重新交付）。第一次评审：准则 `failed`（README.md），进入返工。
- 第二次交付带 `disputes=[{id: 09e1edb5-…, reason}]`，卡到达 In review，评审记录 `disputed`。
- 移到 Done（`tasks.update` status done）后，准则 `misfire: 1`，`misfireAt` 有记录（`guardrails.json`，Guardrails 页显示 `misfire 1`）。

未做：Workpad 的 Review 分组界面未核。我的截图误取了 Paseo 会话视图，不是 Flowly 卡片抽屉。

## 其他记录

- 没有其他 Auto review 或命令误判的卡片被移到 Done（卡 C 的争议保持未决）。
- 发现的 agent 指令冲突：卡 C、E 的“不要改 README”与准则相悖，因此出现 agent 争议。这是我的测试设计所致。

## 创建与清理清单

| 类型 | id / 路径 | 状态 |
| --- | --- | --- |
| 卡 A | `7f6077d9-c067-47ad-b2b7-cbbbf46d085a` | 已删除（归档），备份在 `removed/` |
| 卡 B | `60718c69-8c08-4551-b7c0-182d333e72a8` | 同上 |
| 卡 C | `2dd527dd-4228-4b09-8369-f19ed1e53750` | 同上 |
| 卡 D | `40587c44-25b7-4e99-878d-22fe598a0e97` | 同上 |
| 卡 E | `05e20e75-3ae3-4057-9c61-6b0a8dfc6d59` | 同上 |
| session（A–E） | `023f99c0-…`、`728f3678-…`、`ca9eb07d-…`、`b6a5d88d-…`、`1550c50d-…` | 全部 closed（归档） |
| workspace（worktree） | `wks_e1038abb97192171`、`wks_21e598b7a3887d8c`、`wks_9371ec88057ca865`、`wks_8e732e27daa333dd`、`wks_d09420d5f8b451ad` | 已删除，worktree 目录已不在磁盘上 |
| 分支 | `kanban/guardrails-live-{a,b,c,d,e}-…` | 已 `git branch -D`（Tinylink 仓库只剩 `main`） |
| 护栏条目 | `ec4340c2-…`（Tests 命令）、`09e1edb5-…`（README 准则） | 已删除 |
| 项目设置 | Tinylink 的 Auto review | 之前无此字段（关）；现为 `enabled:false, maxRounds:2` |

保留：两条 `promoted` 项（`7f6077d9`、`60718c69`）按规范作为来源保留，指向已删除的准则 id；`flow` 日志、`summaries.json` 中本次的记录、`removed/` 备份。

Tinylink 看板现有 6 张原始卡，仓库只剩 `main`（`47899f7`），工作区无本次残留。
