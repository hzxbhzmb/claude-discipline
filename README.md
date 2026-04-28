# Claude Discipline

让 Claude Code 在项目中保持工作纪律的插件。

## 解决什么问题

Claude Code 在复杂任务中容易出现"任务焦虑"——前期执行认真，后期开始糊弄：凭想象宣称完成、跳过验证、批量标记、收到任务直接开干不确认理解。本插件通过三层 Hook 机制从结构上杜绝这些问题：

1. **三次握手**：任务开始前，强制 AI 回传理解与计划，用户确认后才能执行——防止"解错题"
2. **证据链**：每次工具调用自动记录到会话日志，标记完成和验算时 Hook 检查是否有对应的工具调用证据——防止"凭想象完成"
3. **四次挥手**：任务结束时，AI 必须用工具验算、提交证据、等用户验收——防止"自己说 done 就结束"

所有检查都在系统层执行，AI 绕不过去。

## 安装

### 通过 Marketplace 安装（推荐）

```bash
# 添加 Marketplace
/plugin marketplace add hzxbhzmb/claude-discipline

# 安装插件
/plugin install claude-discipline
```

### 手动安装

```bash
git clone https://github.com/hzxbhzmb/claude-discipline.git
cd claude-discipline
# 将此目录作为本地插件加载
```

安装后，`todo/` 和 `methodology/` 目录会在每个项目首次会话时自动创建。

### 升级指南

#### 升级这件事本身

- **Marketplace 用户**：`/plugin update claude-discipline` 后重启会话
- **手动安装用户**：在插件目录 `git pull` 后重启会话

重启后即生效。**没有任何手工迁移动作**。

#### v2.x → v3.0.0 升级（最近一次版本）

**结论：零动作平滑升级。** 你不需要改任务段、不需要改 todo 文件、不需要清缓存。

**对你（用户）的可见变化**：
- 编辑 `methodology/` 详情前没更新 `_index.md` → 从 deny 改为 stdout 软警告（不再阻断工作流）
- `~/.claude-discipline/runtime-YYYY-MM-DD.jsonl` 开始累积 hook 触发日志（可用 `node scripts/hook-stats.js` 看）
- 跑 `node scripts/hook-stats.js` 能看到子检查级别的 deny 分布（`pre-edit-write:handshake` / `post-edit-write:verification` 等粒度）

**对你（用户）不可见的变化**（plugin 内部）：
- 9 个老 hook 文件被 git 自动删除（`/plugin update` = git pull 同步删）
- 新增公共框架 `_hook-runner.js` + 子检查模块 `_pre-checks.js` / `_post-checks.js` + 合并入口 `pre-edit-write.js` / `post-edit-write.js`
- `hooks.json` 注册项从 12 个串行 hook 缩到 6 个入口（每次 Edit/Write 启动 node 进程数 11→2，-82%）
- 规则文档拆分：`rules/discipline.md` 233→120 行（SessionStart 注入），新增 `concurrency.md` + `troubleshooting.md` 按需读

**不会丢任何状态**：现有任务段格式不变；带 session 标注的进行中段继续被新 hook 识别；祖传无标注段自动认领机制保留；`/tmp/claude-evidence-*.jsonl` 证据日志兼容；老 marker 文件残留无害（不再被读 = 系统垃圾，OS 重启清掉）；`methodology/` / `research/` / `todo/archive/` 完全不动；所有 env 变量保留。

#### v1.x → v2.x 升级（多会话支持）

如果你的 plugin 还停留在多会话之前的版本，重启后 SessionStart 会做三件事：
1. 告诉 AI 本会话的 **sessionId 短 ID**（8 位），AI 后续建任务段会自动在标题末尾加 `<!-- session: xxxxxxxx -->`
2. **自动认领**最近一个进行中的祖传段（如果有），把 session 标注贴上去
3. 只清自己会话或 >24h 陈旧证据日志，不碰其它活跃会话

**核心概念："祖传段"**：标题没带 `<!-- session: xxxxxxxx -->` 标注的任务段。新版本对祖传段一律**透明处理**——既不拦截，也不连坐任何会话。

**按情况升级**：

- **A 没有进行中任务**：直接升级。下次发新任务时 AI 会按新格式建段。
- **B 有进行中任务段**：零动作。`init-project.js` 自动认领最近一个非归档、无标注、含 `[ ]` 的段——AI 在注入规则里看到"自动认领通知"，无缝继续。
- **C 历史段很多**：不用管。祖传段对新版本透明。

**认领规则**（防误认领）：已归档段不认领；已带 session 标注不认领；纯空段不认领；全 `[x]` 已完成不认领。多候选时取文件中最后一个（最近建的）。

#### 升级失败逃生

任何步骤不顺，设 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量临时跳过全部 hook。

## 工作流程

```
┌─ 三次握手（建立任务连接）──────────────────┐
│ 1. 用户发任务（SYN）                        │
│ 2. AI 回传理解与计划（SYN-ACK）             │
│ 3. 用户确认执行授权（ACK）                  │
└─────────────────────────────────────────────┘
                    ↓
┌─ 执行阶段 ──────────────────────────────────┐
│ 4. 执行子任务 → 有工具调用 → 标记 [x]       │
│    （Hook 检查证据链：无工具调用 → 拒绝标记）│
│ 5. ...逐个完成...                           │
└─────────────────────────────────────────────┘
                    ↓
┌─ 四次挥手（关闭任务连接）──────────────────┐
│ 6. AI 按握手时规划的方案反向验算              │
│    （Hook 检查证据链：无验算调用 → 拒绝）   │
│ 7. AI 提交验算结果 + 向用户汇报             │
│ 8. 用户验收                                 │
│ 9. 任务正式关闭                             │
└─────────────────────────────────────────────┘
```

## 三次握手

类比 TCP 三次握手：单向发送不够，单向收到也不够，必须确认双方都准备好了。

**AI 不能"收到任务就开干"。** Hook 在 AI 编辑项目文件前检查：**本会话**最新的任务段（带 `<!-- session: xxxxxxxx -->` 标注的那些）是否有 `> ✅ 执行授权` 标记。没有 → 系统级阻断。本会话一个标注段都没建也直接拒绝。

| 握手 | 类比 | 做什么 |
|------|------|--------|
| 第一次 | SYN | 用户发起任务 |
| 第二次 | SYN-ACK | AI 在 todo 中写出理解（目标、边界、路径、风险、**验算方案**），向用户确认 |
| 第三次 | ACK | 用户确认后，AI 写入 `> ✅ 执行授权`，Hook 放行 |

### Todo 格式示例

```markdown
## 2026-04-10 — 任务简述 <!-- session: xxxxxxxx -->

**用户意图**：用户原始需求

**AI 理解**：
- 目标：我要做什么
- 边界：什么不做
- 路径：我准备怎么做
- 风险：可能出什么问题
- 验算方案：怎么用反向路径验证结果

> ✅ 执行授权：用户确认方向正确

**达标标准**：...

- [ ] 子任务 1
- [ ] 子任务 2
```

## 快车道模式（轻量任务豁免）

三次握手是为**会改动项目状态、有风险、多步骤**的任务设计的。对简单任务（跑个 skill、单条命令、只读探索、单文件小改），全程走握手太重。以下三层豁免让轻量任务不受约束：

### 1. 工具层天然豁免

以下工具/命令**不会触发握手检查**：

- **Read / Grep / Glob**：只读探索随便用
- **Bash（只读）**：`ls / cat / grep / find / git status / git log / git diff / git commit / git push` 等不改 working tree 的命令
- **Skill / WebFetch / WebSearch / MCP 工具**：Skill 本身不触发（但 Skill 内部的 Edit/Write 或 Bash 写操作仍受约束）

> ⚠️ **v2.1.0 起，Bash 的写/删/移操作与 Edit/Write 对等** —— `mv / cp / rm / sed -i / 重定向 / git reset --hard` 等命令也受三次握手保护。详见[Bash 写保护](#bash-写保护v210)。

### 2. 项目目录外的文件豁免

`Edit` / `Write` 的 `file_path` 若位于 `CLAUDE_PROJECT_DIR` 之外（如 `~/Downloads/*`、`/tmp/*`），两个 hook 直接放行——不在 discipline 作用域。

### 3. 关键词快车道（极简任务段）

任务需要 Edit/Write 项目文件但**规模很小**时，可把三次握手压缩成一步：

```markdown
## YYYY-MM-DD — 任务简述 <!-- session: xxxxxxxx -->

**用户意图**：{一句话复述}

> ✅ 执行授权：[快车道] {说明做什么、为什么简单}
```

跳过 AI 理解、验算方案、子任务列表。只要有 `> ✅ 执行授权` 行就能过 hook。

**触发条件**：用户措辞含`快速 / 直接 / 小改 / 不用握手 / 一句话 / 跑一下 / 简单`，或任务特征为单命令 / 单 skill / 只读探索 / 单文件 ≤10 行改动。

**必须走重档的场景**：多文件改、研究 / 调研、重构、配置 / 基础设施变更、删除 / 不可回滚操作、用户质疑 AI 理解——这些场景即使用户说"快速"也要完整握手。

## Bash 写保护（v2.1.0+）

旧版本 hook 的 matcher 只匹配 `Edit|Write`，AI 可以用 `mv / sed -i / cp / rm / 重定向 / git reset --hard` 等 Bash 命令绕过三次握手直接改项目文件。v2.1.0 新增 `check-bash-mutation.js` 堵住这个漏洞。

### 拦截清单

| 类别 | 命令 |
|------|------|
| 文件操作 | `mv` `cp` `rm` `rmdir` `tee` `dd` `truncate` `shred` `install` |
| 原地编辑 | `sed -i` `awk -i inplace` `perl -i` |
| 重定向 | `> file` `>> file`（豁免 `/dev/null` 和 `2>&1` fd 复制） |
| Git 破坏性 | `git reset --hard` `git clean -fd` `git checkout --` `git restore` `git rm` `git mv` |

**不拦**：只读命令（`ls / cat / grep / find / git status / git log / git diff`）、`git commit / push / fetch / pull`（不改 working tree）、`touch / mkdir / chmod / chown / ln`（低风险边界）。

**复合命令**：按 `; && || |` 切分后逐段检查——任一段命中 mutation 即触发。

### 豁免条件

1. **有授权段**：本会话最新任务段含 `> ✅ 执行授权`（含快车道）→ 放行
2. **Bypass env**：`CLAUDE_DISCIPLINE_BYPASS=1` → 放行
3. **todo 未初始化**：项目根没有 `todo/current.md`（init 未跑）→ 放行

### 升级影响（v2.0.x → v2.1.0）

**零动作升级**：无需改任何项目文件、任务段、配置。现有授权段格式不变。`/plugin update` 后新会话立即生效；正在跑的旧会话也即时生效（hook 每次工具调用由 Claude Code 现场 spawn node 进程）。

**行为变化**：升级后 AI 如果尝试用 Bash 改项目文件但无授权段，会收到 deny 消息，自带建段指引——不需要重启会话，AI 自救即可。

**逃生舱**：设 `CLAUDE_DISCIPLINE_BYPASS=1` 临时跳过。

## 验算失败处理（v2.2.0+）

验算不保证一次过。旧版规则只说"验算通过就收尾"，没说失败怎么办——AI 可能无限 silent 改到过为止，烧 token 且用户完全失去知情权。v2.2.0 新增**验算失败迭代上限** + 三种失败段类型结构化这个流程（v3.0.0 起逻辑搬到 `_post-checks.retryLimit` 子检查）。

### 三种段类型

| 段类型 | 用途 | 格式 |
|-------|------|------|
| 迭代中 | 每次验算失败后写 | `> ❌ 验算第 N 次失败：{原因} → 改进：{做了什么}` |
| 最终放弃 | 超上限 / AI 主动交棒 | `> ❌ 最终验算失败：{汇总} \| 尝试：... \| 建议：...` |
| 失败后成功 | 经 K 次迭代终于过 | `> ✅ 验算通过：{最终方案，经 K 次迭代}` |

### 迭代上限

**默认 3 次**。可通过 env 覆盖：

```bash
export DISCIPLINE_VERIFY_RETRY_LIMIT=5
```

超限后 hook 会 deny 对 todo 的下次编辑，强制 AI 把新失败改写为 `> ❌ 最终验算失败` 段，在对话中汇报并交棒给用户决定方向。

### 升级影响（v2.1.0 → v2.2.0）

**零动作升级**。现有失败处理习惯不受影响——AI 不写失败段 → hook 不介入（hook 只数写出来的行数，不监控测试红绿）。

## 证据链

插件通过 Hook 记录**每一次工具调用**（工具名、操作目标、时间戳）到会话证据日志（JSONL 格式）。这是硬数据，AI 无法伪造。

| 检查点 | 触发条件 | 检查内容 | 不通过时 |
|--------|---------|---------|---------|
| 标记 `[x]` | 编辑 todo 将 `[ ]` 改为 `[x]` | 自上次标记以来是否有非 todo 的工具调用 | **拒绝操作** |
| 研究类 `[x]` | 同上，且子任务文本含 `research/` | 证据日志中是否有对 `research/` 的写入 | **拒绝操作** |
| 写验算通过 | 编辑 todo 写入 `✅ 验算通过` | 自最后一个 `[x]` 以来是否有读取/执行类工具调用 | **拒绝操作** |

支持所有工具类型：Read、Edit、Write、Bash、Grep、Glob、MCP 工具等。

## 反向验证

验算不是"用同一条路径再检查一遍"，而是**用不同的路径反向验证结果**。类比：3+5=8 的验算是 8-3=5，不是再算一遍 3+5。

| 执行动作 | ❌ 不算验算 | ✅ 正确验算 |
|---------|-----------|-----------|
| 写了代码 | 重读代码看对不对 | 跑测试 / 走使用流程 |
| 创建了文件 | `cat` 看内容 | `wc -l` + `grep` 关键内容 |
| 修了 bug | 读改过的代码 | 构造原始触发条件验证 |
| 做了研究 | 重读自己的报告 | 拿结论回源文件交叉验证 |
| 重构了代码 | diff 看改了什么 | 跑测试验证行为不变 |

验算方案在**第二次握手（SYN-ACK）**时就规划好，经用户确认后才执行。

## Hook 一览（v3.1.0+）

`hooks.json` 注册 7 个入口：

| 入口 | 触发时机 | 内容 |
|------|---------|------|
| **init-project** | SessionStart | 初始化目录 + 注入规则 + 注入本会话 sessionId 短 ID + 自动认领祖传段 |
| **auto-archive** | SessionStart | 把 `todo/current.md` 已完成段搬到 `todo/archive/YYYY-MM/YYYY-MM-DD.md` |
| **user-prompt-submit** | UserPromptSubmit | 用户每次发新消息时主动 inject reminder（v3.1.0+，未建段/未握手/段已收尾时） |
| **pre-edit-write**（合并） | PreToolUse Edit/Write | 单 node 进程串行 4 子检查：`handshake` → `methodologyIndex`（软警告） → `writeForbidden` → `lineCount` |
| **check-bash-mutation** | PreToolUse Bash | Bash 里 mv/sed -i/rm/重定向/git reset --hard 等写操作，无握手授权 → **拒绝**（v2.1.0+；v3.0.1+ 白名单文件路径放行） |
| **log-tool-call** | PostToolUse（所有工具） | 记录工具调用到会话证据日志 `/tmp/claude-evidence-${sessionId}.jsonl` |
| **post-edit-write**（合并） | PostToolUse Edit/Write | 单 node 进程串行 5 子检查：`markMethodologyIndex` → `acceptance`（软警告） → `verification` → `evidenceOnMark` → `retryLimit` |

### 子检查（合并入口里串行跑的逻辑）

| 子检查 | 来自 | 行为 |
|--------|------|------|
| `handshake` | `_pre-checks.handshake` | 本会话没建带 session 标注的任务段 / 最新段无 `> ✅ 执行授权` → **拒绝** |
| `methodologyIndex` | `_pre-checks.methodologyIndex` | 编辑 methodology 详情前未更新 `_index.md` → stdout 软警告（v3.0.0 从 deny 降级） |
| `writeForbidden` | `_pre-checks.writeForbidden` | 用 Write 整覆盖 `todo/current.md` → **拒绝** |
| `lineCount` | `_pre-checks.lineCount` | `current.md` >200 行（默认）且目标非 current/非 archive → **拒绝**（避免归档死锁） |
| `markMethodologyIndex` | `_post-checks.markMethodologyIndex` | 编辑 `methodology/_index.md` 后写 marker（让 methodologyIndex pre-check 知道 _index 更新过） |
| `acceptance` | `_post-checks.acceptance` | 任务段缺达标标准 → stdout 软警告 |
| `verification` | `_post-checks.verification` | 本会话段全 `[x]` 无验算行 → **拒绝**（祖传段/他会话段不连坐） |
| `evidenceOnMark` | `_post-checks.evidenceOnMark` | 标 `[x]` 或写验算无工具证据 → **拒绝**；研究类子任务还需有 `research/` 写入 |
| `retryLimit` | `_post-checks.retryLimit` | 本会话最新段 `> ❌ 验算第 N 次失败` 累计 >3（默认）且无"最终失败"行 → **拒绝**（v2.2.0+）|

子检查按子检查名独立 record 到 runtime 日志（`pre-edit-write:handshake` / `post-edit-write:verification` 等粒度），`hook-stats.js` 仍能按子检查分桶。

所有 hook 检查 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量——设置后跳过所有检查。

## 多会话并发支持

同一项目起多个 Claude Code 会话共用 `todo/current.md`、`research/`、`methodology/` 时，插件通过四道机制防止互相踩踏：

1. **证据日志按会话隔离**：`/tmp/claude-evidence-${sessionId}.jsonl` 每会话独立；SessionStart 只清自己会话的日志或 >24h 陈旧文件，绝不无差别全删。
2. **任务段归属会话**：每个任务段标题必须带 session 标注 `<!-- session: xxxxxxxx -->`，SessionStart 时插件在规则尾部告诉 AI 本会话的短 ID。握手检查和验算检查都只看**本会话的任务段**——别的会话和无标注祖传段对你完全透明（不拦截、不连坐）。没带标注 = 没建任务段，对项目文件的编辑会被拒绝。
3. **禁止 Write 整覆盖 `todo/current.md`**：一刀切拒绝 Write，必须用 Edit 增量改动。Edit 的 old_string 精确匹配是天然的乐观锁——并发会话 append 新段时即使竞态，失败的一方只是 Edit 匹配不到，重试即可，绝不会静默丢段。
4. **升级零摩擦——自动认领祖传段**：老用户升级时，SessionStart 自动把"最近一个进行中的祖传段"（非归档、无 session 标注、含 `[ ]`）贴上本会话标注，用户无需手工编辑。AI 会在注入的规则里看到"自动认领通知"，然后无缝继续工作。详见[升级指南](#升级指南从旧版本--多会话版本)。

## 插件结构（v3.0.0+）

```
claude-discipline/
├── .claude-plugin/
│   └── plugin.json                      # 插件清单
├── hooks/                               # 11 个 .js 文件，零死代码
│   ├── hooks.json                       # 注册 7 个入口
│   ├── _hook-runner.js                  # 公共框架：BYPASS / stdin / projectDir / 单一白名单
│   ├── _runtime-log.js                  # 可观测性：按日分文件写 ~/.claude-discipline/runtime-*.jsonl
│   ├── _session-util.js                 # 多会话工具：按 session 过滤段 + 祖传段自动认领
│   ├── _pre-checks.js                   # 4 个 PreToolUse Edit/Write 子检查（纯函数）
│   ├── _post-checks.js                  # 5 个 PostToolUse Edit/Write 子检查（纯函数）
│   ├── pre-edit-write.js                # PreToolUse Edit/Write 合并入口（hooks.json 注册）
│   ├── post-edit-write.js               # PostToolUse Edit/Write 合并入口（hooks.json 注册）
│   ├── check-bash-mutation.js           # PreToolUse Bash 独立 hook（v2.1.0+，v3.0.1+ 白名单放行）
│   ├── user-prompt-submit.js            # UserPromptSubmit 主动 inject reminder（v3.1.0+）
│   ├── log-tool-call.js                 # PostToolUse 全工具证据日志（按 sessionId 分文件）
│   └── auto-archive.js                  # SessionStart 自动归档完成段
├── rules/                               # 主文件 SessionStart 注入；其它按需读
│   ├── discipline.md                    # 主规则（120 行，SessionStart 自动注入）
│   ├── concurrency.md                   # 多会话并发完整规则（46 行）
│   └── troubleshooting.md               # BYPASS / 失败处理 / 归档 / 可观测性 / Hook 一览（96 行）
└── scripts/
    ├── init-project.js                  # SessionStart：建目录 + 注入规则 + 注入 sessionId + 自动认领祖传段
    ├── hook-stats.js                    # 可观测性统计：过去 N 天 hook 触发/deny 分布（v2.5.0+）
    ├── migrate-archive-to-daily.js      # 一次性迁移：archive/YYYY-MM.md → archive/YYYY-MM/YYYY-MM-DD.md
    ├── test-multi-session.js            # 单元级反向验证（33 断言）
    ├── test-e2e-concurrent.js           # 端到端并发 + 升级场景 e2e（43 断言）
    ├── test-bash-mutation.js            # Bash 写保护反向验证（70 断言，v3.0.1+ 白名单）
    ├── test-verification-retry.js       # 验算失败上限反向验证（16 断言）
    ├── test-archive.js                  # 归档 + 行数硬阻断反向验证（40 断言）
    └── test-user-prompt-submit.js       # UserPromptSubmit 反向验证（17 断言，v3.1.0+）
```

**测试总计 219 断言**（6 套件全过）。
**核心收益**：每次 Edit/Write 启动 node 进程数 11 → 2（-82%）。

## 方法论分级存放

methodology/ 采用**渐进式披露**设计：

- `_index.md`（顶层索引）：每次任务开始时读取，几十行，很轻
- 分类目录：按"什么时候需要用"组织
- 详情文件：只在匹配当前任务场景时才读取

这样方法论可以无限积累，但每次任务只加载相关部分，不会撑爆上下文。

## 自定义

### 白名单（v3.0.0+ 单一来源）

`hooks/_hook-runner.js` 中 `WHITELIST_FRAGMENTS` 是**项目目录内**不受握手管控的路径片段（v2.x 时这份白名单在 `check-handshake` 和 `check-todo-modified` 各有一份逐字副本，v3.0.0 统一）：

```javascript
const WHITELIST_FRAGMENTS = [
  '/todo/current.md', '\\todo\\current.md',
  '/todo/archive/',   '\\todo\\archive\\',
  '/CLAUDE.md',       '\\CLAUDE.md',
  '/MEMORY.md',       '\\MEMORY.md',
  '/methodology/',    '\\methodology\\',
  '/research/',       '\\research\\',
  '/.claude/',        '\\.claude\\',
];
```

`isWhitelisted(filePath)` 在所有 PreToolUse Edit/Write 子检查里调用——改这一处即全局生效。

**项目目录外的路径**（`CLAUDE_PROJECT_DIR` 之外）无需加白名单，hook 默认豁免，详见[快车道模式](#快车道模式轻量任务豁免)。

### 环境变量

| Env | 默认 | 作用 |
|-----|------|------|
| `CLAUDE_DISCIPLINE_BYPASS=1` | 关 | 整个 hook 体系短路（紧急逃生） |
| `DISCIPLINE_TODO_HARD_LIMIT=N` | 200 | `current.md` 行数硬阻断阈值 |
| `DISCIPLINE_VERIFY_RETRY_LIMIT=N` | 3 | 验算失败迭代上限 |
| `CLAUDE_DISCIPLINE_NO_RUNTIME_LOG=1` | 关 | 关闭 `~/.claude-discipline/runtime-*.jsonl` 写入（v2.5.0+） |

## 可观测性（v2.5.0+）

每次 hook 跑都自动记录到 `~/.claude-discipline/runtime-YYYY-MM-DD.jsonl`（按日分文件，自然滚动）。统计：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js              # 过去 7 天
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js 30           # 过去 30 天
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js --by-reason  # 按 deny 原因分桶
```

输出每个 hook 的触发次数、deny 次数、deny%。**用途**：
- 哪些 hook 真在工作 / 哪些 deny 高频
- triggered = 0 的 hook 可能注册位置错了（参考 v2.4.0 line-count 事故：从 v2.3 起一个月没生效，没人察觉）
- deny% 极低且 triggered 大的 hook 可能是低价值候选删除

## 许可

MIT
