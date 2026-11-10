# Flowly 交付自动验收（Auto review）：从零设计，再与现有方案对比

日期：2026-10-28。只读任务，未改仓库。第 1–5 节在读现有方案之前写完；第 6 节读完 `docs/AUTO-REVIEW-SPEC.md` 与相关代码后补。

---

## 0. 一句话

**你每次把卡退回去说的话，Flowly 记下来；下一张卡交付时，先替你按这些话查一遍，没问题才到你手上。**

设计围绕一个观察：用户已经在做"验收"这件事，而且做得很具体，就是退卡时说的那句"测试没跑""文案没进所有语言""README 没更新"。问题不是用户不会写规则，而是规则只存在于那一句话、那一张卡里。所以这个功能的本体不是"配置评审规则"，而是**把退卡这一下变成可复用的护栏**。所有设置负担都从这个点上长出来，而不是另起一个设置页。

---

## 1. 核心心智模型

用户需要理解的只有三件事：

| 用户看到的 | 一句话 |
| --- | --- |
| **Checked ✓ / Sent back ↩** | agent 交付后，Flowly 先查一遍。过了才进 Attention；没过直接退给 agent 改，你不用管。 |
| **Checks**（这个项目查什么） | 就是你以前退卡时说过的话，加上项目自己的测试命令。每条写着"抓到过几次"。 |
| **Done 还是你定** | 查过只是说"没发现你以前抱怨过的问题"，不代表做对了。 |

用户**不需要知道**（完全不可见）：

- 评审是哪种检查（读 timeline 的证据检查 / daemon 跑命令 / 临时评审 session）。用户只看到一条检查的结果和依据。
- 临时评审 session 的存在、用哪个模型、回退链、用完硬删除。
- "退回的目标阶段""返工计数器""触发事件 id""交付快照"等状态机细节。
- diff 怎么按卡归属、共享目录下怎么裁剪范围。
- 退卡反馈怎么被归类、怎么与已有检查匹配、候选/建议/确认这几个状态。
- "误判计数""连续通过次数"等用来淘汰检查的内部计数（只在到阈值时冒出一个问题）。
- 评审结果的历史存储、与 flow log 的关系。

两个刻意不引入的概念：**"规则"**（用户看到的是自己的原话，不是规则语法）和**"评审模型设置"**（直接复用 Settings → Models 里已有的 Summary models 列表）。

---

## 2. 完整用户路径

约定：`[ ]` 按钮，`·` 分隔，`~` 弱化文字。所有文案最终走 `t()`，这里用中文示意。

### 2.1 新用户第一天

**用户做了什么**：走完欢迎导览（第 2 页 Built in 多了一个开关，默认开），建项目，建第一张卡，agent 开工。什么都没设。

**导览第 2 页**（在 Progress / Next steps 下面加一个开关，和现有 Skills 开关同样式）：

```
┌─ Built in ─────────────────────────────────────────────┐
│ …（现有 Progress / Next moves / Ideas 的演示）          │
│                                                        │
│ (●) Auto review                                        │
│     交付的卡先由 Flowly 查一遍再到你手上，             │
│     并记住你退卡时说的话。每次交付约花                 │
│     3–5 次进度摘要的 token。                           │
└────────────────────────────────────────────────────────┘
```

只保留成本一句（符合"只留成本/隐私/副作用"的文案规则）。不出现"规则""命令"之类的词。

**第一次交付时看到的**（agent 调 `flowly_update_status(in_review)`）：

```
In review
┌──────────────────────────────┐
│ Add rate limit to /shorten   │
│ 实现完成，等待验收           │
│ ◌ Checking…                  │   ← 不进 Attention，铃铛不计数
└──────────────────────────────┘
```

约 1–2 分钟后：

```
┌──────────────────────────────┐
│ Add rate limit to /shorten   │
│ 实现完成，等待验收           │
│ ✓ Checked · 2 checks         │   ← 这时才进 Attention
└──────────────────────────────┘
```

打开卡片，Review 段（放在 Workpad 段之前）：

```
Review                                   ~Haiku 5.5 · 18k tokens · 2 分钟前
 ✓ 做了卡片和会话里要求的事
     ~限流、429 响应与测试都在；用户在会话里要求的"按 IP"已实现
 ✓ npm test 在交付的提交上跑过
     ~session 在 9b77e0 上执行，26 passed
 ─────────────────────────────────────────
 ~Flowly 以后也替你跑 npm test？  [跑]  [不用]      ← 一次性，一行，不是弹窗
```

一次性提示（banner，`auto-review`）：
> Flowly 在这张卡到你手上前先查了一遍。以后你退卡时说的话，它会记住并在下一张卡上先查。

**系统在背后做了什么**：
1. 把卡标成 `checking`，暂不进 Attention。
2. 证据检查（免费，不用确认）：读该卡 session 的 timeline，核对 workpad 里标 pass 的命令是否真的在最后一次改文件之后跑过、结果是 completed；对照 HEAD。
3. 评审 session（Summary model 里第一个可用的，默认 Haiku）在卡片 workspace 里作为子 session 跑一次：输入卡片标题/描述/验收段、用户在会话里的原话（项目记忆已经采集的 `message/answer/feedback` 线索）、按本卡归属裁剪的 diff、workpad、项目的 Checks。输出每条检查 pass/fail/unsure + 依据。跑完硬删除。
4. 发现 agent 自己跑过 `npm test`，且它是 `package.json` 的脚本 → 在 Review 段放一行询问是否以后由 Flowly 跑。这是**唯一需要人同意的地方**（daemon 执行绕过 agent 权限）。不问就永远只做证据检查。

第一天到此为止，没有任何设置页出现。

### 2.2 用了几周后：退卡、学习、再交付

**场景**：agent 交付了"新增导出按钮"，Flowly 查过（Checked ✓）。用户打开卡看，发现日文文案没加。用户像往常一样在 session 里写：

> 新文案没有加到所有语言，ja 和 ko 都没有。

然后把卡拖回 Development（或者不拖，agent 自己会动）。

**系统在背后**：
- 这条消息是"卡在 In review 时用户写的" → 已有的 `feedback` 线索。
- 自动变成**本卡**的一条检查（不问用户）：下次这张卡再交付，评审 session 会专门核对"用户上次说的这句话解决了没有"。
- 同时用 Haiku 做一次很小的归类（几百 token）：把这句话和项目已有 Checks、以及最近 30 天其他卡的退卡原话比较。发现 10 天前"修复登录页"那张卡也退过一次说"翻译没加全" → 命中"同一件事出现在第 2 张卡"。

**agent 再交付**：

```
┌──────────────────────────────┐
│ 新增导出按钮                 │
│ 补齐 ja/ko 文案，等待验收    │
│ ✓ Checked · 3 checks         │
└──────────────────────────────┘
```

打开卡片：

```
Review                                   ~Haiku 5.5 · 21k tokens · 刚刚
 ✓ 做了卡片和会话里要求的事
 ✓ 你上次说的："新文案没有加到所有语言，ja 和 ko 都没有"
     ~9 个目录都有 export.title / export.hint
 ✓ npm test 在交付的提交上跑过
 ─────────────────────────────────────────
 ~这件事在 2 张卡上退过（本卡、修复登录页）。
 ~以后每张卡都查？            [每张卡都查]  [不用]
```

点"每张卡都查" → toast "已加入 Checks"。这就是**学习的唯一确认动作**：一行、一下、在用户正看着证据的地方。不点就留着，下次还在同一位置，不会弹别处。

**再过几天**，另一张卡"设置页加开关"交付。agent 没加 ko 文案。用户什么都没看到。卡在 Development 列：

```
Development
┌──────────────────────────────┐
│ 设置页加开关                 │
│ 补齐 ko 文案                 │   ← summary 已经在说它在修了
│ ↩ Sent back by review · 1    │
└──────────────────────────────┘
```

agent 收到的返工消息（英文，服务端生成）：

```
[Flowly review] Delivery sent back (1 of 2). Not yet right:
- Check "新文案没有加到所有语言" (caught on 2 cards before): shared/i18n/ko.ts has no settings.autoSave.* keys.
Fix it, rerun your checks, then deliver again. If a finding is wrong, deliver with disputes:["c_41"] and say why in the note.
```

第二次交付通过 → 进 Attention。用户打开看到：

```
Review                                   ~2 轮 · 共 37k tokens
 ✓ 做了卡片和会话里要求的事
 ✓ 新文案加到所有语言                 ~第 1 轮没过：ko 缺 3 个 key；现已补齐
 ✓ npm test 在交付的提交上跑过
```

**这是 wow 时刻**：用户没说话，问题就被按他以前说过的话抓住并修好了。

### 2.3 老用户升级

升级到带本功能的 minor 版本，第一次打开看板，What's new（现有窗口，一条）：

```
┌─ What's new · Flowly 1.8 ─────────────────────────────┐
│ ◎ Auto review：agent 交付的卡先由 Flowly 查一遍，      │
│   没过直接退给 agent 改；它从你退卡时说的话里学。       │
│   对现有项目已打开；每次交付约花 3–5 次摘要的 token。   │
│                                       [Open settings]  │
│ …                                                      │
│                                              [Got it]  │
└────────────────────────────────────────────────────────┘
```

**系统在升级后的第一次 daemon 启动时**（每个项目一次，后台，Haiku）：读最近 30 天的 flow log（人把卡从 In review 退回工作阶段的记录）和已采集的 `feedback` 线索，归类出出现 ≥2 次的退卡原因，最多 3 条，写成**建议的 Checks**（带原话与来源卡数）。没有素材的项目什么都不生成。

一次性提示（`review-suggest`，只在有建议时）：
> Flowly 从你退过的卡里找到 3 件常退的事。打开 Checks 看一眼。

Checks 列表（见 §2.8 位置说明）：

```
Checks · 建议 3
 ┌ "测试没跑就交付了"                       ~5 张卡 · 最近 3 天前
 │  [每张卡都查]  [不用]
 ├ "新文案要进所有语言目录"                 ~3 张卡
 │  [每张卡都查]  [不用]
 └ "README 的 Highlights 没更新"             ~2 张卡
    [每张卡都查]  [不用]
```

三下点完，升级日的工作结束。不点也没事：建议留在那里，每张卡的"做了要求的事"检查照常跑。

### 2.4 一张复杂或高风险的卡

**不新增"高风险"概念**。用户已经会在卡片描述里写验收要求，评审 session 本来就读描述；只是把描述里的验收段逐条当成检查，逐条报结果。

用户建卡时在描述里写：

```
## 验收
- v4 的 board.json 必须能原样读出来，不迁移
- 写失败时保留原文件，不重置
- 迁移脚本要在 Tinylink 上跑一遍
```

交付后 Review 段：

```
Review                                   ~Haiku 5.5 · 44k tokens
 ✓ v4 的 board.json 必须能原样读出来，不迁移      ~sqlite.test.ts 有 v4 夹具
 ✗ 写失败时保留原文件，不重置                      ~store.ts:212 失败分支调用了 reset()
 ? 迁移脚本要在 Tinylink 上跑一遍                  ~timeline 里没有对 Tinylink 目录的命令
 ✓ npm test 在交付的提交上跑过
 ~改动较大（38 个文件），建议自己再过一遍 diff。
```

`✗` 会退回；`?`（评审拿不准）**不退回**，但在通过时仍然显示给用户，让人补看。大改动只加一行诚实的提醒，不做"深度评审"档位（想要更强模型的人改 Summary models 的顺序即可）。

如果用户想对这一张卡格外严，可以在卡片里直接加一条检查（Review 段底部 "+ 加一条只对这张卡的检查"，一个文本框）。这和在描述里写验收段是同一条路，只是晚一点写。

### 2.5 评审误判、用户不同意

三条路，都不需要进设置：

**a. 用户在卡上否决一条**。卡被退回后用户打开它（卡上有 ↩ 标记），看到：

```
Review · 第 1 轮 · 已退回
 ✗ "README 的 Highlights 没更新"
     ~README 没有改动，但卡片新增了设置项
     [不算问题]                          ← 只对这张卡
```

点"不算问题"：这条检查在本卡后续评审里跳过；检查本身记一次"误判"。**不替用户给 agent 发消息**（agent 已在返工，它下一次交付时这条不再查即可）。如果用户想立刻结束返工，直接把卡拖到 In review 或 Done：人移动的卡从不评审。

**b. agent 不同意**。返工消息里写明可以 `disputes:["id"]` 交付。带争议的交付：被争议的那条**不再自动退回**，而是通过时显示为"有争议"并进入 Attention 由人裁决：

```
 ⚑ "README 的 Highlights 没更新"
     ~agent：这是内部设置，README 的 Highlights 不列内部设置。
     [agent 说得对]  [还是要改]
```

"agent 说得对" = 检查记一次误判；"还是要改" = 用户照常写反馈。这样评审和 agent 之间不会死循环。

**c. 检查自己退场**。同一条检查 30 天内被判"误判"2 次（a 或 b），下次打开 Checks 时它上面出现一行：

```
 ┌ "README 的 Highlights 没更新"           ~抓到 1 次 · 误判 2 次
 │  ~它错了两次。                 [保留]  [删除]
```

不自动删，但也不再反复问：没选之前这条检查**暂停**（不参与评审）。

### 2.6 成本控制

原则：**成本在它发生的地方看得见，在它来源的地方可控，上限由结构保证。**

看得见：
- 每次评审在卡片 Review 段标 `模型 · N tokens`，多轮时标 `N 轮 · 共 M tokens`；计入卡片现有 Usage 小计。
- Insights 的工作流一行加一段：`评审 23 次 · 410k token · 退回 6 次`（最近 7 天，和现有口径并排）。

可控（只有两个旋钮，都是已有的）：
- 项目设置里的 **Auto review** 开关。
- 模型 = Settings → Models 的 **Summary models** 列表（已有）。想便宜就把 Haiku 放第一；想严就把 Sonnet 放第一。不加第三个模型设置。

结构上限：
- 每张卡最多退回 2 次 → 最多 3 次评审（限额不做成常用设置；放在项目设置 Auto review 组里一个数字，默认 2）。
- diff 按卡归属裁剪并截断（约 60k 字符），超出时 Review 段注明"只看了一部分"。
- 人移动的卡不评审；同一提交 + 同一 workpad 版本不重复评审（agent 重复交付同样内容直接复用上次结果）。
- 归类用的 Haiku 调用只在退卡时发生，几百 token。

一个主动的省钱机制：**交付前先给 agent 看 Checks**（§5.2），让它在交付前自查。检查在交付前通过，就不会产生返工轮次（返工轮次既花评审 token，也花 agent token）。

### 2.7 共享工作区（多张卡共用项目根目录，非 worktree）

原则：**只用能归到这张卡头上的证据做闸门，其余只展示不判定。**

卡 A 和卡 B 都在 Development，同一个目录。A 交付：

```
Review                                   ~Haiku 5.5 · 20k tokens
 ✓ 做了卡片和会话里要求的事              ~只看了本卡 session 改过的 6 个文件
 ✓ npm test 在交付的提交上跑过           ~A 的 session 在最后一次改动后跑过
 ! Flowly 跑 npm test：失败              ~目录里还有"卡 B"在改；失败不计入
     ~client/settings.test.ts 2 failed
 ~共享目录：只按本卡改过的文件判定。
```

- "做了要求的事"：diff 只取**本卡 session 的 edit/write 工具调用碰过的文件**；其他变更列为"同目录里还有别的改动，未审"。
- 证据检查（agent 自己跑没跑）：按 session 归属，天然是本卡的，照常判定。
- daemon 跑的命令：结果展示，**不作为退回理由**（它测的是合并状态，可能是别人弄坏的，退回会让 agent 去修别人的代码）。
- 一次性提示（`shared-root-review`，只在这种情况第一次出现时）：
  > 共用一个目录的卡没法分开测。新任务可以选"New isolated worktree"。

不做：为共享目录自动改成 worktree、跨卡合并判定。

### 2.8 Checks 放在哪里（为什么不是新页面）

Checks 的本质是"用户确认过的、关于这个项目怎么交付的约定"，而项目记忆已经有 `convention` 类型、候选 → 确认的收件箱、使用计数、过期清理、转进 AGENTS.md。所以：

**一条 Check = 一条项目记忆条目 + "交付时核对"标记**。

- Memory 页加一个筛选 chip **Checks · N**；条目卡右上多一个小标记 "交付时核对"；条目行显示 `抓到 4 次 · 误判 0 次`。
- 退卡原话归类出来的建议，就是一条带标记的候选（走现有 To review 区，按钮文案换成"每张卡都查 / 不用"）。
- 命令类检查是一条写着 `npm test` 的 convention，带一个开关"Flowly 也替你跑"（默认关；打开 = 同意 daemon 执行；这就是消费那次"跑 / 不用"的地方）。
- 项目设置 → Auto review 组只有：开关、`退回最多 2 次`、一行 `Checks 5 · 管理 ›`（跳到 Memory 页的 Checks 筛选）。

好处：不加第二个收件箱、不加第二套确认/编辑/删除 UI、不加第二套 i18n；agent 在 session 初始指令里也能看到这些约定（注入），交付时再核对（执行）——**预防和拦截用同一条数据**。

代价：项目记忆关掉的项目只有内置检查 + 本卡检查，项目设置里说明一句"学到的 Checks 需要 Project memory"。记忆默认开，这是边缘情况。

### 2.9 状态一览（卡面只显示一个信号，沿用 Workpad 的优先级做法）

| 卡在哪 | 信号 | 进 Attention？ |
| --- | --- | --- |
| In review，评审中 | `◌ Checking…` | 否 |
| In review，通过 | `✓ Checked · N checks`（有 `?` 或争议时 `✓ Checked · 1 to look at`） | 是（普通 review） |
| 工作阶段，被退回 | `↩ Sent back by review · n` | 否 |
| Blocked，超限 | `✗ Review failed 3×` | 是（带原因） |
| In review，评审没跑成（模型不可用/超时） | 无信号，Review 段一行弱化说明 | 是（**fail-open**：工具坏了不该挡住人） |

人把卡拖进 In review：没有评审，也没有信号。

---

## 3. 护栏怎么自己越变越好

### 3.1 学什么、从哪学

| 信号 | 来源（都已存在） | 用来做什么 | 要不要人确认 |
| --- | --- | --- | --- |
| 退卡原话 | 卡在 In review 时用户写的 session 消息（记忆的 `feedback` 线索）；人把卡从 In review 拖回工作阶段（flow log `byUser`） | 立刻成为**本卡**下次交付的检查 | 不用（它本来就是用户对这张卡的要求） |
| 同一件事第二次出现 | 退卡时一次小归类：原话 vs 项目 Checks vs 近 30 天其他卡的退卡原话 | 建议升级为项目 Check | 一下（"每张卡都查"） |
| agent 跑过的命令 | timeline 的 shell 调用 ∩ `package.json` / `paseo.json` scripts | 建议由 Flowly 也跑 | 一下（这是权限同意，必须要） |
| 用户否决 / 站 agent | 卡上"不算问题"、争议裁决 | 给检查记误判 | 不用 |
| 人直接把退回/Blocked 的卡拖到 Done | flow log | 等同一次"不算问题"（对本轮所有失败项） | 不用 |
| 检查命中 | 评审结果 | `抓到 N 次`，给用户看价值 | 不用 |

### 3.2 什么时候打扰人

只在三种时刻，且都在用户已经在看的地方（卡片 Review 段、Memory 页），从不弹窗：
1. 第二次出现同一件事 → 一行建议（每个项目同时最多 1 条建议可见，其余排队，和 tip 一样）。
2. 第一次看到可跑的命令 → 一行询问。
3. 一条检查误判 2 次 → 一行"保留 / 删除"。

### 3.3 怎么避免规则越积越多

- **归类先对已有**：建议前先问模型"和哪条已有 Check 是同一件事"；是同一件事就给那条 +1，**不生成新条目**。这是去重的主路径。
- **原话即规则**：检查的正文就是用户的话（确认时可编辑）。不让模型"改写成规则"，避免越写越泛、越写越多。
- **上限**：每个项目活跃的 LLM 类检查最多 12 条（证据/命令类不计），到上限时建议里给出"合并到 ×"或"替换最久没抓到的"。
- **每条有账**：`抓到 N 次 · 误判 M 次 · 最近抓到 X 天前`，Memory 页 Checks 筛选一眼能看出哪条没用。

### 3.4 怎么淘汰没用的检查

- **误判淘汰**（自动暂停 + 人定）：30 天内误判 2 次 → 暂停并问一次。
- **过期提示**（只提示）：沿用记忆的"Stale"规则——90 天没抓到过的检查标 Stale，Clean up 里可一键归档。**不自动归档**：一直没抓到可能正是因为 agent 在交付前看到了它（§5.2 的预防作用）。
- **升级到 AGENTS.md**：抓到 ≥3 次的检查显示"Copy as AGENTS.md rule"（记忆已有）。但**检查本身不退场**：项目记忆 699cf5ce 说明只写在 skill/文档里的规则在短回合里会被跳过，检查是 AGENTS.md 做不到的强制层。

---

## 4. 用户需要注意的次数

以"一张卡被退一次"为典型（用户说这是常态）：

| | 不用 auto review | 用 auto review（稳态） |
| --- | --- | --- |
| 原生"回合结束"推送（拦不住） | 2 次 | 2–3 次（可忽略：卡面写着 Checking/Sent back） |
| 人打开卡看 diff/输出 | 2 次 | **1 次**（且带着检查结果当导读） |
| 人写反馈 | 1 次 | 0 次 |
| **需要动脑的触点** | **3** | **1** |

偶发触点（不按卡计）：一下确认新检查（每隔若干次退卡一次，随时间递减）、每个命令一次同意、误判 2 次时一问、超限 Blocked（罕见）。

**wow 时刻**：
1. 第一次发现卡回来时"↩ Sent back by review · 1"已经发生过、问题已修——自己一个字没说。
2. 打开 Checks 看到的是自己的原话，后面跟着"抓到 4 次"。
3. 升级当天 Flowly 已经列出"你常退的三件事"。

---

## 5. 需要的机制与可行性

### 5.1 交付闸门与状态

- 复用 `flowly_update_status(in_review)` 的 agent 路径。进入 In review 时记 `review: { state: "checking", from: <交付前阶段>, round, triggerEventId }`。人拖动不触发。
- 评审前的硬拒绝（服务端）：workpad 有 `fail` 或 `stale` 的检查 → 直接返回错误让 agent 先处理；这比评审后再退省一轮。
- 同一 HEAD + 同一 workpad revision + 同一 Checks 版本的重复交付复用上一次结果。
- 风险：Done/Cancelled/归档中途变化；评审中卡被人移动 → 取消本次评审，结果丢弃。

### 5.2 让 agent 在交付前就知道（约束落在工具返回值，不只在 skill）

- `flowly_get_task` 新增 `review: { enabled, checks: [{ id, text, command? }], round, limit }`。
- 交付工具的成功回执带 `reviewChecks`（同一列表）作为 reminder；被退回后的 `get_task` 带 `lastReview: { failed: [...] }`。
- skill 加一句"Before delivering, go through review.checks"。依据项目记忆 8424d1ab。

### 5.3 证据检查（免费、不用同意）

- 用 SDK 读本卡各 session 的 timeline（现有 `tail` + `before` 分页）；取 `tool_call`：`detail.type === "shell"`（命令、status、output）与 edit/write 类（filePath）。
- 对每条带命令的 Check / workpad 验证项：最后一次执行是否在最后一次文件改动之后、status 是否 completed、输出尾部是否有失败特征（启发式，拿不准交给评审 session 判断）。
- 难点：Claude 的 shell 条目没有 cwd 和 exitCode（WORKFLOW-INSIGHTS-SPEC §3.1 已知）；长 session 的分页读取要有上限（例如最近 600 条）。Pi 等 provider 的条目格式未核对。

### 5.4 命令检查（需要一次同意）

- 只接受来自 `package.json` scripts / `paseo.json` scripts / 用户手填的命令；执行用参数数组（`["npm","run","test"]`、paseo script），不走 shell 字符串。超时（默认 10 分钟）、输出只留尾部 4k、同一时间每卡一个。
- 同意存在 Check 条目上（"Flowly 也替你跑"开关）。关掉即撤销。
- 共享目录下结果只展示不判定（§2.7）。

### 5.5 评审 session（花 token）

- 和 card summarizer 同一跑法：卡片 workspace 里的子 session、标签 `flowly=reviewer`、`waitForFinish(120 s 起，按 diff 大小放宽到 300 s)`、`finally` 硬删除、模型按 Summary models 回退。看板视图按标签隐藏它。
- prompt 只读：不改文件、不跑会改状态的命令；可以读文件、`grep`、看 git。权限请求出现 → 视为本次评审失败 → fail-open。
- 输出 schema：`{ items: [{ id, result: "pass"|"fail"|"unsure", evidence }], summary }`。解析容错同 TASK-SUMMARY-SPEC §3。
- 输入预算：卡片 + 用户原话线索（≤5000 字）+ 裁剪 diff（≤60k 字符）+ workpad + Checks。
- 风险：Haiku 对大 diff 的判断力有限 → `unsure` 不退回只展示；模型不可用 → fail-open 并在 Review 段说明。

### 5.6 退回与返工

- 退回：`status_changed` 到 `review.from`（actor system，note 记原因），round +1；给交付的 session 发返工消息（approved exception）。`disputes` 参数进交付工具 schema，服务端校验 id 属于本轮失败项。
- 超限：移到 Blocked，Attention 条目带原因和 `[Accept anyway]`（= 对所有失败项记"不算问题"并移回 In review）。
- 风险：返工消息发到已归档/已结束的 session → 记录失败并直接进 Attention（fail-open）。

### 5.7 学习

- 退卡检测：`feedback` 线索（已有）+ flow log 人把卡从 In review 移回工作阶段。
- 本卡检查：直接把 `feedback` 原话附进下一轮评审输入，无新存储，只需在 review 状态里记"上轮反馈的线索 id"。
- 归类：退卡时一次 Haiku 调用，输入 = 这句话 + 项目 Checks 标题 + 近 30 天其他卡的 `feedback` 原话（每卡 ≤3 条）；输出 `{ sameAs?: checkId | clueId, title? }`。命中其他卡的线索 → 生成候选（memory candidate + check 标记，evidence = 两句原话）。
- 升级种子：daemon 启动时每项目一次，素材 = 近 30 天 `feedback` 线索 + flow log 退卡记录；输出最多 3 条候选。线索只保留 30 天（PROJECT-MEMORY-SPEC §4.0），更早的退卡只能数次数、没有原话——这是已知局限，接受。
- 计数：Check 条目上 `caught / wrong / lastCaughtAt`，复用记忆的 `usedAt` 写入节流。

### 5.8 UI

- 卡面信号：`CardSignals` 加一项，优先级在 workpad 信号之前。
- 卡片 Review 段：新组件，`React.memo`；行 = 图标 + 文字 + 弱化依据（可展开），底部最多一行询问/建议。桌面和手机同一组件。
- Memory 页：Checks 筛选 chip、条目标记、计数行、命令行的"也替你跑"开关。
- 项目设置：Auto review 组三行。
- 导览第 2 页一个开关；What's new 一条；tips：`auto-review`、`review-suggest`、`shared-root-review`。
- 全部文案进 9 个目录；agent 面文字和返工消息英文。

### 5.9 遥测

- 心跳加 `f_auto_review`（项目开启数分桶）、`c_reviews`、`c_review_sent_back`、`c_checks_confirmed`。

---

## 6. 与现有设计对比

读了：`docs/AUTO-REVIEW-SPEC.md`（P1–P3）、`shared/auto-review.ts`、`shared/review-history.ts`、`server/auto-review.ts`、`server/review-session.ts`、`server/review-history.ts`、`client/task-review.tsx`、`client/review-settings.tsx`、`client/review-rules.tsx`、`docs/verification/auto-review-2026-10-28/report.md`。

先说结论：**现有方案的执行环节（闸门、退回、返工、取消、fail-open）是对的，而且实测过；差距在"怎么长出来"和"怎么被看见"**——学习是批处理的、入口藏在设置和 Insights 里、第一号抱怨（测试没跑）仍然靠 agent 自报。下面分四部分。

### 6.1 做得好、应该保留的

| # | 现有做法 | 为什么好 |
| --- | --- | --- |
| K1 | 只由 agent 交付触发，等该 session 这一轮结束再开始；指纹（task/workpad revision、HEAD、dirty）变了就作废；人拖进 In review 不评审 | 边界干净，避免评审中途被 agent 自己的提交打断，也不会评审人移动的卡 |
| K2 | L1：workpad 有 `fail`/`stale` 时 `WORKPAD_FAILING` 当场拒绝，`acknowledgeOpen` 无效（D3） | 约束落在工具返回值上，正是项目记忆 8424d1ab 要求的；比交付后再退省一轮 |
| K3 | 内置检查 "Does what you asked" 的尺子是卡片 + 用户在会话里的原话，"后说的覆盖先说的，说过先不做的不算缺"，workpad 只作参考（D12） | 这就是我 §2.2 的"本卡检查"：用户退卡时写的话是 user_message，天然进入下一轮评审。实测 P3 "CHANGELOG 先不做"判对了 |
| K4 | 命令只接受 argv、独立进程组、`CI=1`；只执行用户勾选/确认过的命令，workpad 里的命令不执行（限制 4） | 权限边界说得清楚，没有 shell 拼接 |
| K5 | R1 退回交付前的阶段、R2 到 Blocked、Unavailable 不计轮次、评审期间压住未读、通过不是单独的 Attention 原因 | 与"Done 只由人定"和 Attention 口径一致；工具坏了不挡人 |
| K6 | 历史分析的数字由 daemon 确定性统计（A1 from in_review 且未被 A1r 还原），模型只归类；草案 `at`/`baseHash` 防止应用没看过的内容 | 不信模型报数；并发安全 |
| K7 | Insights 的返工提示带用户原话、Not now 30 天；"20 次全过"的暂停建议 | 用证据说话，而且在意 token |
| K8 | 评审 session 只读、逐条独立判定、`na`、硬删除、模型回退复用 `runSummaryModels` | 复用摘要器的全部基础设施 |
| K9 | Rerun、评审中卡面扫光条、`review_finished.results` 供统计 | 可观察、可重来 |

### 6.2 值得吸收的（按优先级）

**R1 · 在退卡当下学，而不是等批处理。** 工作量 M。
- 改什么：每次检测到"交付后返工"（已有定义：A1 from in_review 且未被 A1r 还原）时，用 Haiku 做一次小归类：这句反馈 vs 项目现有规则 vs 近 30 天其他卡的返工原话（记忆 `feedback` 线索，已有）。命中已有规则 → 给那条规则 +1；命中另一张卡的原话 → 生成**一条**建议，显示在**这张卡的 Auto review 段底部**和项目设置的规则列表顶部："这件事在 2 张卡上退过（本卡、×××）。每张卡都查？[每张卡都查] [不用]"。每项目同时只显示一条建议。复用 `review_rule` finding 和 `insights.add-review-check`，只是生成时机和展示位置变了。
- 为什么：现在增量建议只走 Insights 的定期运行（§7.2），要求 Auto review 已开、Insights/Skills 开，新项目还要等满一个周期（INSIGHTS-REDESIGN §3.1）；新用户的第一条建议最早一周后到。而退卡的那一刻用户正看着证据，一下就能确认。
- 效果：wow 时刻从"几周后"提前到"第二次发生时"；确认动作从打开 Insights/设置变成原地一下。

**R2 · 规则显示为用户原话 + 账目。** 工作量 S/M。
- 改什么：历史分析和 R1 生成的 LLM 规则，`name` 直接用用户的原话（≤80 字，确认时可改），`prompt` 由模型写；规则行显示 `抓到 N 次 · 误判 M 次 · 最近 X 天前`（从 `review_finished.results` 聚合，Insights 已在读）。
- 为什么：现在规则是模型写的 `name`+`prompt`，没有账。用户认得自己的话才信；有账才会自己修剪，不需要"规则越积越多"的治理。

**R3 · 免费的证据检查：对照 timeline 核实 workpad 的 pass。** 工作量 M。
- 改什么：新增内置检查（像 `goal` 一样固定 id，如 `evidence`，不花 token、不需同意）：对 workpad 里带命令且标 `pass` 的验证项，读本卡 session 的 timeline（`readConversation` 已经在读同一份数据；取 `detail.type === "shell"` 的 tool_call，`shellRecord` 已有解析），核实：最后一次执行在最后一次文件改动之后、status 是 completed、输出尾部没有失败特征。不满足 → `failed`，理由写"npm test 最后在 a3f1c2 上跑过，之后改了 4 个文件"。
- 为什么：用户的第一号抱怨是"测试没跑"。现在 L1 只拦 agent **自己承认**的 fail/stale；pass 的真伪没人查；评审 session 被明确告知 workpad "只作参考"。除非用户勾了命令检查（需要同意、需要 daemon 跑、共享目录下不可靠），这个问题仍靠自报。证据检查零成本、零同意、按 session 归属，共享目录下也成立。
- 风险：Claude 的 shell 条目没有 cwd/exitCode（已知）；长 session 分页上限；Pi 格式未核对。拿不准时判 `na` 不判 fail。

**R4 · 默认打开（至少对新项目），导览里给开关。** 工作量 S，但**需要用户决定**：它推翻 2026-10-27 "Off by default" 的决定。
- 改什么：`defaultAutoReview.enabled` 对新建项目为 true（老项目保持 false，由 What's new 引导）；导览第 2 页 Built in 加开关和成本一句；只有内置检查时不需要任何配置。
- 为什么：用户目标是"不怎么需要手动设置就非常好用"，而现有路径是：关着 → 等 14 天内 3 次返工 → Insights 提示 → 打开设置 → 分析（还要 ≥5 次交付）→ Apply。内置检查本身零配置，没理由不让新用户第一天就体验到"卡回来时已经被查过"。
- 效果：新用户第一次交付就看到 Checked ✓ 和提示；成本在导览里说清。
- 代价：每次交付一次 Haiku 调用。

**R5 · 误判的出路：争议、不算问题、自动暂停。** 工作量 M。
- 改什么：(a) 交付工具加 `disputes: [ruleId]`（服务端校验是上一轮失败项）；被争议的规则再失败不触发 R1，卡通过进 Attention 并显示双方理由，用户点 [agent 说得对] / [还是要改]。(b) 抽屉失败行加 [不算问题]：本卡后续评审跳过该规则，规则记一次误判。(c) 30 天内误判 2 次 → 规则自动暂停并在列表上问一次 [保留] [删除]。
- 为什么：现在一条错的 LLM 规则会让 agent 返工两次然后进 Blocked，用户只能去设置里删规则或手动拖卡；没有任何误判信号被记录。实测里 Haiku fixture 把别的卡的改动判成本卡的错（report §P3 Finding），正是需要出路的场景。

**R6 · 共享目录：命令结果只展示不判定，diff 按本卡 session 改过的文件裁剪。** 工作量 M。
- 改什么：`shared` 且同目录有 ≥2 张活跃卡时，命令 `failed` 显示但不计入总判定（新状态或 `na`+理由"共享目录，可能是别的卡的改动"），LLM 检查照常跑（D9 在这种情况下不跳过）；diff 只取本卡 session 的 edit/write 工具调用碰过的文件，其余列为"同目录里还有别的改动，未审"。
- 为什么：现在 D6 只靠 prompt 里一句"不要为无关改动判 fail"，实测仍然判错了；命令失败若是别人造成的，返工消息会让 agent 去修别人的代码。

**R7 · 评审模型默认走 Summary models，不回退到项目默认 agent 模型；每次评审在卡上标 token。** 工作量 S。
- 改什么：`server/review-session.ts` 的顺序改为 Review model（若设）→ Summary models；去掉"项目默认模型"这一级。抽屉 Auto review 段头部显示 `模型 · N tokens`，Insights 工作流行加 `评审 N 次 · M token`。
- 为什么：一个默认模型是 Opus 的项目，现在每次交付都用 Opus 评审，而设置里只写了一句"uses tokens"，用户感知不到。成本要在发生的地方看得见。

**R8 · 抽屉一张列表，按 失败 → 待看 → 通过 排序，不按 Commands / LLM review 分组。** 工作量 S。
- 为什么：分组暴露的是实现（谁判的），用户关心的是"哪条没过、要不要看"。`na` 和"争议"归到"待看"。

**R9 · 把生效的规则注入新 session 的初始指令（和项目记忆同一段）。** 工作量 S。
- 为什么：`get_task.reviewRules` 已有，但第一条指令里没有；预防和拦截应该用同一份数据。agent 交付前自查通过，就省下一轮返工（agent token + 评审 token）。

**R10 · Checks 与项目记忆合并（§2.8）。** 工作量 L，**建议 v2 再考虑**：P2/P3 已把规则建在 `project.autoReview.rules` 上，现在合并是重做。先做 R2（原话 + 账目）和 R9（注入），就拿到了合并的大部分好处。

### 6.3 应该删掉或简化的

| 项 | 建议 | 理由 |
| --- | --- | --- |
| **Adjust with AI**：设置卡片、`flowly_propose_review_rules`、agent 草案的 diff 展示 | 从 v1 去掉或隐藏（保留历史分析用的草案路径） | 一整套子系统（卡片类型、工具、草案状态机、stale/confirm）服务一个"次要入口"（D7 原话）。有了 R1 的原地建议 + 历史分析 + 普通 Add check，它没有独有的价值；而它是用户最难理解的部分（实测里 Set up with AI 只在开关打开后才出现，用户要先翻开关再找按钮） |
| `guidance`（项目级 prompt 文本） | 删除 | 没有证据用户会写；已有的确认记忆（conventions）可以代替它喂给评审 session |
| 评审模型回退到项目默认 agent 模型 | 删除（R7） | 成本意外 |
| D9 "命令失败则跳过 LLM" | 共享目录下不跳过（R6） | 否则共享目录里几乎永远跑不到内置检查 |
| 返工提示阈值（14 天 3 张）+ 分析门槛（90 天 5 次交付） | 保留分析门槛；返工提示由 R1 的原地建议取代 | 两个阈值叠加让新用户等太久 |
| `types` 过滤器的编辑 chips | 保留数据，编辑器里默认收起（只在已设置时显示） | 多数规则不需要 |
| 规则编辑器的 Kind 选择（Command / LLM） | 用一个输入框：以已知脚本或可执行文件开头就是命令，否则是判断 | 少一个概念 |
| 导览只有 More features 一句被动介绍 | 改为 Built in 页开关（R4） | 见 R4 |

### 6.4 有没有根本走错的地方

**机制没有走错；采用路径走反了。** 证据：

1. **spec §1.1 的新用户行：用户做的"无"，看到的"不推"。** 要到 §7.1（14 天内 ≥3 张返工）才有提示，再到 §6.2（90 天 ≥5 次交付）才有分析，再到 Insights 定期运行（新项目等满一个周期）才有增量建议。用户的目标是"不怎么需要手动设置就非常好用"，而现有路径里**第一次价值体验**最早在几周之后，且每一步都要用户去设置或 Insights 页找。
2. **第一号抱怨仍是自报。** `goalRule.prompt` 写明 "Do not judge against the workpad: it is the agent's own report"，L1 只拦 agent 自己承认的问题，没有任何环节独立核实"测试跑过"。用户要想堵住它，必须打开设置、勾命令、同意 daemon 执行，而共享目录下这条又不可靠（实测 D6 finding）。R3 的证据检查是零成本的补法。
3. **误判没有出路、没有信号。** 规则一旦错了，唯一的学习机制是 Insights 每周一次的"20 次全过就暂停"（只针对从不失败的规则），对"经常误判"的规则没有任何记录。R5 补上。
4. **配置面比价值面大。** 代码量上：`review-settings.tsx`（205 行）+ `review-rules.tsx`（200 行）+ `task-review.tsx` 里的草案块（约 220 行）≈ 600 行客户端，全部是设置；卡片上的评审结果展示（`TaskReview` + `RuleGroup` + `RuleRow`）约 170 行，可操作的只有 Rerun。用户第一次看到价值的地方（卡片 Review 段）没有别的可操作的东西，所有操作都在设置里。R1、R5 把操作搬到卡片上。

这些都不需要推翻 P1–P3 的服务端骨架；R1–R9 是在现有数据（`review_finished.results`、`feedback` 线索、`readConversation`、`review_rule` finding、draft 路径）上加的。R4 是唯一需要用户重新拍板的决定。
