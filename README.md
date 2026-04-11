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
│ 6. AI 用工具执行验算                        │
│    （Hook 检查证据链：无验算调用 → 拒绝）   │
│ 7. AI 提交验算结果 + 向用户汇报             │
│ 8. 用户验收                                 │
│ 9. 任务正式关闭                             │
└─────────────────────────────────────────────┘
```

## 三次握手

类比 TCP 三次握手：单向发送不够，单向收到也不够，必须确认双方都准备好了。

**AI 不能"收到任务就开干"。** Hook 在 AI 编辑项目文件前检查：当前任务段是否有 `> ✅ 执行授权` 标记。没有 → 系统级阻断。

| 握手 | 类比 | 做什么 |
|------|------|--------|
| 第一次 | SYN | 用户发起任务 |
| 第二次 | SYN-ACK | AI 在 todo 中写出理解（目标、边界、路径、风险、**验算方案**），向用户确认 |
| 第三次 | ACK | 用户确认后，AI 写入 `> ✅ 执行授权`，Hook 放行 |

### Todo 格式示例

```markdown
## 2026-04-10 — 任务简述

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

## 证据链

插件通过 Hook 记录**每一次工具调用**（工具名、操作目标、时间戳）到会话证据日志（JSONL 格式）。这是硬数据，AI 无法伪造。

| 检查点 | 触发条件 | 检查内容 | 不通过时 |
|--------|---------|---------|---------|
| 标记 `[x]` | 编辑 todo 将 `[ ]` 改为 `[x]` | 自上次标记以来是否有非 todo 的工具调用 | **拒绝操作** |
| 研究类 `[x]` | 同上，且子任务文本含 `research/` | 证据日志中是否有对 `research/` 的写入 | **拒绝操作** |
| 写验算通过 | 编辑 todo 写入 `✅ 验算通过` | 自最后一个 `[x]` 以来是否有读取/执行类工具调用 | **拒绝操作** |

支持所有工具类型：Read、Edit、Write、Bash、Grep、Glob、MCP 工具等。

## Hook 一览

| Hook | 触发时机 | 效果 |
|------|---------|------|
| **check-todo-modified** | PreToolUse Edit/Write | 未更新 todo → **拒绝** |
| **check-handshake** | PreToolUse Edit/Write | 当前任务段无 `> ✅ 执行授权` → **拒绝** |
| **check-methodology-index** | PreToolUse Edit/Write | 编辑 methodology 详情前未更新索引 → **拒绝** |
| **log-tool-call** | PostToolUse（所有工具） | 记录工具调用到证据日志 |
| **mark-todo-updated** | PostToolUse Edit/Write | 标记本会话已更新 todo |
| **check-todo-line-count** | PostToolUse Edit/Write | todo 超 80 行 → **警告归档** |
| **check-todo-acceptance** | PostToolUse Edit/Write | 任务段缺达标标准 → **警告** |
| **check-todo-verification** | PostToolUse Edit/Write | 全 `[x]` 无验算行 → **拒绝** |
| **check-evidence-on-mark** | PostToolUse Edit/Write | 标记 `[x]` 或写验算无工具证据 → **拒绝**；研究类子任务还需有 `research/` 写入 |

所有 hook 检查 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量——设置后跳过所有检查。

## 插件结构

```
claude-discipline/
├── .claude-plugin/
│   └── plugin.json              # 插件清单
├── hooks/
│   ├── hooks.json               # Hook 注册
│   ├── check-handshake.js       # 三次握手检查
│   ├── check-evidence-on-mark.js # 证据链检查
│   ├── log-tool-call.js         # 工具调用日志
│   ├── check-todo-modified.js   # todo 更新检查
│   ├── check-todo-acceptance.js # 达标标准检查
│   ├── check-todo-verification.js # 验算行检查
│   ├── check-todo-line-count.js # 归档提醒
│   ├── check-methodology-index.js # 方法论索引检查
│   ├── mark-todo-updated.js     # todo 更新标记
│   └── mark-methodology-index-updated.js
├── rules/
│   └── discipline.md            # 纪律规则（SessionStart 自动注入）
└── scripts/
    └── init-project.js          # 会话初始化（创建目录 + 清理证据日志 + 注入规则）
```

## 方法论分级存放

methodology/ 采用**渐进式披露**设计：

- `_index.md`（顶层索引）：每次任务开始时读取，几十行，很轻
- 分类目录：按"什么时候需要用"组织
- 详情文件：只在匹配当前任务场景时才读取

这样方法论可以无限积累，但每次任务只加载相关部分，不会撑爆上下文。

## 自定义

### 白名单

`hooks/check-todo-modified.js` 和 `hooks/check-handshake.js` 中定义了不受管控的目录白名单：

```javascript
const whiteList = [
  p => p.includes('/todo/current.md'),
  p => p.includes('/CLAUDE.md'),
  p => p.includes('/methodology/'),
  p => p.includes('/research/'),
  p => p.includes('/.claude/'),
  // 可按需增减
];
```

### 归档阈值

`hooks/check-todo-line-count.js` 中的 80 行阈值可调整：
```javascript
if (lineCount > 80) { ... }
```

## 许可

MIT
