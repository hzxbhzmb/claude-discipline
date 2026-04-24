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

### 升级指南（从旧版本 → 多会话版本）

如果你之前装过本插件的老版本（不支持多会话并发），新版本带来一个**硬规则变化**和一个**新拦截点**，可能影响你正在进行的任务。

#### 升级这件事本身

- **Marketplace 用户**：`/plugin update claude-discipline` 后重启会话
- **手动安装用户**：在插件目录 `git pull` 后重启会话

重启后，SessionStart 会做三件事：
1. 告诉 AI 本会话的 **sessionId 短 ID**（8 位），AI 后续建任务段时会自动在标题末尾加 `<!-- session: xxxxxxxx -->`
2. **自动认领**一个正在进行中的祖传段（如果有），把 session 标注贴上去——B 类用户升级零动作
3. 只清理自己会话或 >24h 陈旧的证据日志，不碰其它活跃会话

#### 行为变更清单

| 项 | 旧版本 | 新版本 |
|---|---|---|
| **任务段标题格式** | `## YYYY-MM-DD — 任务简述` | `## YYYY-MM-DD — 任务简述 <!-- session: xxxxxxxx -->`（AI 建段时自动加） |
| **握手检查** | 看 todo 最后一个任务段是否有 `✅ 执行授权` | 只看**本会话**标注的任务段；没建 = deny |
| **验算检查** | 扫整个 todo，任一段全 [x] 无验算 → deny（会**连坐**别的会话） | 只扫本会话段；祖传段 / 他会话段**不连坐** |
| **Write `todo/current.md`** | 允许 | **拒绝**（必须用 Edit 增量改，防并发吞段） |
| **证据日志清理** | SessionStart 无差别清空所有 `/tmp/claude-evidence-*` | 只清自己会话或 >24h 陈旧文件，不动其它活跃会话 |

**核心概念："祖传段"**：标题没带 `<!-- session: xxxxxxxx -->` 标注的任务段。新版本对祖传段一律**透明处理**——既不拦截，也不连坐任何会话。所以升级时你**不需要**回头改历史段。

#### 按情况升级

**A. 没有进行中任务（手上没活在干）**

直接升级。下次发新任务时，AI 会按新格式建段。✅ 结束。

**B. 有一个正在进行的任务段（还没验算通过）**

**零动作升级**。重启会话时 `init-project.js` 会自动扫描 `todo/current.md`，找到**最近一个进行中的祖传段**（非归档、无 session 标注、含至少一个 `- [ ]` 未勾子任务），把本会话 `<!-- session: xxxxxxxx -->` 标注贴到段标题末尾。AI 会在 SessionStart 注入的规则里看到一条"自动认领通知"，然后可以无缝继续你原来的任务。

```markdown
## 2026-04-15 — 你正在做的任务                                ← 升级前
↓ SessionStart 自动改写
## 2026-04-15 — 你正在做的任务 <!-- session: abcd1234 -->     ← 升级后
```

**认领规则**（防误认领）：
- 已归档（`## 归档说明` 段）：不认领
- 已带任何 session 标注：不认领（可能是别的会话正用着）
- 纯空段（无 `- [ ]` 也无 `- [x]`）：不认领
- 全部 `- [x]` 已完成：不认领（已完工的不是你"在做"的任务）

**多个候选段时**：取文件里**最后**一个（最近建的）。如果真的有多个同时在做但都没标注，剩下的仍是祖传段——对新 hook 透明不碍事，让 AI 在做到那个任务时顺手 Edit 加标注即可。

**C. todo 里有很多历史已归档或已验算段**

完全不用管。祖传段对新版本透明。只关心 B 里那个**当前在做的段**即可。

#### 验证升级成功（3 步自测）

1. **Hook 已生效**：重启会话后查看 SessionStart 注入的规则，末尾应有"## 本会话身份"段 + 你的 8 位短 ID
2. **握手过滤对了**：让 AI 新建一个带标注的任务段 → 写授权 → 编辑任一源文件，应通过
3. **拦截 Write**：让 AI 用 Write 工具整覆盖 `todo/current.md` → 应被 `check-todo-write-forbidden.js` 拒绝

跑不通或有疑惑，在任何一步前设 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量可临时跳过全部检查。

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

验算不保证一次过。旧版规则只说"验算通过就收尾"，没说失败怎么办——AI 可能无限 silent 改到过为止，烧 token 且用户完全失去知情权。v2.2.0 新增 `check-verification-retry-limit.js` + 三种失败段类型结构化这个流程。

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

## Hook 一览

| Hook | 触发时机 | 效果 |
|------|---------|------|
| **check-todo-modified** | PreToolUse Edit/Write | 未更新 todo → **拒绝** |
| **check-handshake** | PreToolUse Edit/Write | 本会话没建带 session 标注的任务段 / 最新段无 `> ✅ 执行授权` → **拒绝** |
| **check-bash-mutation** | PreToolUse Bash | Bash 里 mv/sed -i/rm/重定向/git reset --hard 等写操作，无握手授权 → **拒绝**（v2.1.0+） |
| **check-methodology-index** | PreToolUse Edit/Write | 编辑 methodology 详情前未更新索引 → **拒绝** |
| **check-todo-write-forbidden** | PreToolUse Write | 用 Write 整覆盖 `todo/current.md` → **拒绝**（必须用 Edit，防并发吞段） |
| **log-tool-call** | PostToolUse（所有工具） | 记录工具调用到会话证据日志 `/tmp/claude-evidence-${sessionId}.jsonl` |
| **mark-todo-updated** | PostToolUse Edit/Write | 标记本会话已更新 todo |
| **mark-methodology-index-updated** | PostToolUse Edit/Write | 标记本会话已更新 methodology 索引 |
| **check-todo-line-count** | PostToolUse Edit/Write | todo 超 80 行 → **警告归档** |
| **check-todo-acceptance** | PostToolUse Edit/Write | 任务段缺达标标准 → **警告** |
| **check-todo-verification** | PostToolUse Edit/Write | 本会话段全 `[x]` 无验算行 → **拒绝**（祖传段/他会话段不连坐） |
| **check-evidence-on-mark** | PostToolUse Edit/Write | 标记 `[x]` 或写验算无工具证据 → **拒绝**；研究类子任务还需有 `research/` 写入 |
| **check-verification-retry-limit** | PostToolUse Edit/Write | 本会话最新段 `> ❌ 验算第 N 次失败` 累计 > 3（默认）且无"最终失败"行 → **拒绝**（v2.2.0+）|

所有 hook 检查 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量——设置后跳过所有检查。

## 多会话并发支持

同一项目起多个 Claude Code 会话共用 `todo/current.md`、`research/`、`methodology/` 时，插件通过四道机制防止互相踩踏：

1. **证据日志按会话隔离**：`/tmp/claude-evidence-${sessionId}.jsonl` 每会话独立；SessionStart 只清自己会话的日志或 >24h 陈旧文件，绝不无差别全删。
2. **任务段归属会话**：每个任务段标题必须带 session 标注 `<!-- session: xxxxxxxx -->`，SessionStart 时插件在规则尾部告诉 AI 本会话的短 ID。握手检查和验算检查都只看**本会话的任务段**——别的会话和无标注祖传段对你完全透明（不拦截、不连坐）。没带标注 = 没建任务段，对项目文件的编辑会被拒绝。
3. **禁止 Write 整覆盖 `todo/current.md`**：一刀切拒绝 Write，必须用 Edit 增量改动。Edit 的 old_string 精确匹配是天然的乐观锁——并发会话 append 新段时即使竞态，失败的一方只是 Edit 匹配不到，重试即可，绝不会静默丢段。
4. **升级零摩擦——自动认领祖传段**：老用户升级时，SessionStart 自动把"最近一个进行中的祖传段"（非归档、无 session 标注、含 `[ ]`）贴上本会话标注，用户无需手工编辑。AI 会在注入的规则里看到"自动认领通知"，然后无缝继续工作。详见[升级指南](#升级指南从旧版本--多会话版本)。

## 插件结构

```
claude-discipline/
├── .claude-plugin/
│   └── plugin.json                      # 插件清单
├── hooks/
│   ├── hooks.json                       # Hook 注册
│   ├── _session-util.js                 # 共用工具：按 session 过滤任务段 + 祖传段自动认领
│   ├── check-handshake.js               # 三次握手检查（按本会话过滤）
│   ├── check-bash-mutation.js           # Bash 写操作握手保护（v2.1.0+）
│   ├── check-verification-retry-limit.js # 验算失败迭代上限（v2.2.0+）
│   ├── check-evidence-on-mark.js        # 证据链检查
│   ├── check-methodology-index.js       # 方法论索引检查
│   ├── check-todo-acceptance.js         # 达标标准检查
│   ├── check-todo-line-count.js         # 归档提醒
│   ├── check-todo-modified.js           # todo 更新检查
│   ├── check-todo-verification.js       # 验算行检查（按本会话过滤，不连坐祖传段）
│   ├── check-todo-write-forbidden.js    # 禁止 Write 整覆盖 todo/current.md
│   ├── log-tool-call.js                 # 工具调用日志（按 sessionId 分文件）
│   ├── mark-methodology-index-updated.js
│   └── mark-todo-updated.js
├── rules/
│   └── discipline.md                    # 纪律规则（SessionStart 自动注入）
└── scripts/
    ├── init-project.js                  # 会话初始化：建目录 + 安全清理证据日志 + 注入规则 + 自动认领祖传段 + 注入本会话短 ID
    ├── test-multi-session.js            # 单元级反向验证（33 断言：A/B/C/D 四组）
    ├── test-e2e-concurrent.js           # 端到端并发 + 升级场景 e2e 验证（43 断言）
    ├── test-bash-mutation.js            # Bash 写保护反向验证（59 断言：8 分组）
    └── test-verification-retry.js       # 验算失败上限反向验证（16 断言：8 分组）
```

## 方法论分级存放

methodology/ 采用**渐进式披露**设计：

- `_index.md`（顶层索引）：每次任务开始时读取，几十行，很轻
- 分类目录：按"什么时候需要用"组织
- 详情文件：只在匹配当前任务场景时才读取

这样方法论可以无限积累，但每次任务只加载相关部分，不会撑爆上下文。

## 自定义

### 白名单

`hooks/check-todo-modified.js` 和 `hooks/check-handshake.js` 中定义了**项目目录内**不受管控的目录白名单：

```javascript
const whiteList = [
  p => p.includes('/todo/current.md'),
  p => p.includes('/todo/archive/'),
  p => p.includes('/CLAUDE.md'),
  p => p.includes('/MEMORY.md'),
  p => p.includes('/methodology/'),
  p => p.includes('/research/'),
  p => p.includes('/.claude/'),
  // 可按需增减
];
```

**项目目录外的路径**（`CLAUDE_PROJECT_DIR` 之外）无需加白名单，两个 hook 默认豁免，详见[快车道模式](#快车道模式轻量任务豁免)。

### 归档阈值

`hooks/check-todo-line-count.js` 中的 80 行阈值可调整：
```javascript
if (lineCount > 80) { ... }
```

## 许可

MIT
