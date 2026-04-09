# Claude Discipline

让 Claude Code 在项目中保持工作纪律的插件。

## 解决什么问题

Claude Code 在复杂任务中容易出现"任务焦虑"——前期执行认真，后期开始糊弄：凭想象宣称完成、跳过验证、批量标记、用同一条路径自证、伪造审计样本。本插件通过 **Hook 系统级强制 + 规则自动注入 + 三权审判** 三层机制，确保以下纪律被稳定执行：

1. **任务管理**：每次动手前必须先在 todo/current.md 写计划并明确达标标准，逐个完成逐个标记（需有工具调用证据），全部完成后必须验算（换路径验证），超量自动提醒归档
2. **方法论管理**：错误经验按语义分类存放，渐进式披露避免上下文爆炸，写入详情前必须先更新索引
3. **三权审判**：你写完 `> ✅ 验算通过：xxx` 后，hook 自动 spawn 两个独立 claude 进程（不继承当前 session）：复核者独立用工具拿一手证据判事实，审计者独立判方法是否科学。审计者要查的样本由 hook 用确定性算法预先挑好，审计者无自选权——防止它给自己出送分题
4. **系统级强制**：Hook 在系统层拦截，AI 绕不过去

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

## 插件结构

```
claude-discipline/
├── .claude-plugin/
│   └── plugin.json          # 插件清单
├── hooks/
│   ├── hooks.json           # Hook 注册
│   ├── check-todo-modified.js
│   ├── check-todo-acceptance.js
│   ├── check-todo-verification.js   # 写完验算行后调 run-tribunal.js
│   ├── check-methodology-index.js
│   ├── check-todo-line-count.js
│   ├── mark-todo-updated.js
│   ├── mark-methodology-index-updated.js
│   ├── run-tribunal.js              # 三权审判主调度（spawn verifier+auditor）
│   └── lib/
│       └── seeded-sample.js         # 确定性 seeded 抽样（sha256 + mulberry32）
├── prompts/
│   ├── verifier.md          # 复核者 system prompt
│   └── auditor.md           # 审计者 system prompt（三必查项 + 抽样占位符）
├── scripts/
│   └── init-project.js          # 会话初始化（创建目录 + 注入规则）
└── rules/
    └── discipline.md        # 纪律规则（SessionStart 自动注入）
```

## Hook 执行机制

| Hook | 触发时机 | 效果 |
|------|---------|------|
| check-todo-modified | Edit/Write 代码文件前 | 未更新 todo/current.md → **拒绝操作** |
| check-methodology-index | Edit/Write methodology 详情前 | 未更新 _index.md → **拒绝操作** |
| check-todo-line-count | Edit/Write todo/current.md 后 | 超 80 行 → **输出警告** |
| check-todo-acceptance | Edit/Write todo/current.md 后 | 新任务段缺少达标标准 → **输出警告** |
| check-todo-verification (Phase 1) | Edit/Write todo/current.md 后 | 全 [x] 但无验算记录 → **拒绝操作** |
| check-todo-verification (Phase 2) → run-tribunal.js | 同上，且段已有 `> ✅ 验算通过：` | spawn 复核者+审计者，**任一 FAIL → 拒绝**；连续 3 次 FAIL → **写"审判搁置"等用户裁决** |

拒绝操作 = Claude Code 系统级阻断，AI 必须先完成前置步骤才能继续。

所有 hook 顶部都检查 `CLAUDE_DISCIPLINE_BYPASS=1` 环境变量——run-tribunal spawn 出的子进程会带这个变量，避免被自家 hook 反向卡死（防递归）。

## 工作流程

插件强制执行的完整工作流：

```
1. 读 todo/current.md
2. 写入计划 + 达标标准 + 子任务拆解
3. 达标标准不清楚 → 先问用户
4. 执行子任务 → 有工具调用证据 → 标记 [x]
5. ...逐个完成...
6. 全部标记后，执行验算（换路径验证达标标准）
7. 写 > ✅ 验算通过：xxx
8. ── 三权审判自动触发 ──
   - hook spawn 独立复核者 → 用 Read/Bash/Grep 自取一手证据 → 判事实
   - hook spawn 独立审计者 → 验证 hook 预选的样本 → 判方法是否独立
   - 任一 FAIL → hook 阻断，把失败原因抛回主对话强制修复
   - 连续 3 次 FAIL → 段被自动搁置，必须告知用户人工裁决
9. 三权全 PASS → 向用户汇报
```

## 三权审判

**三权 = 执行者 + 复核者 + 审计者**。三方各有不同视角和职责，互相不可见，互相不可串通。

| 角色 | 是谁 | 看到什么 | 职责 |
|------|------|----------|------|
| **执行者** | 主对话里的 Claude | 全部对话历史、用户意图、自己做的全部事 | 做事 + 写 `> ✅ 验算通过：xxx` |
| **复核者** | hook spawn 独立 claude 进程 #1（cold start，不继承会话） | 达标标准 + 子任务清单 + 项目文件；**看不到执行者的对话历史和验算声明** | 自己用 Read/Bash/Grep 拿一手证据，独立判事实是否达标；至少 `max(2, ceil(子任务数/2))` 次工具调用，否则 verdict 自动作废 |
| **审计者** | hook spawn 独立 claude 进程 #2 | 达标标准 + 执行者验算声明 + 复核者报告 + 项目文件 | 判**方法是否科学**：路径独立性 / 达标标准忠实度 / 证据可追溯 |

### 抽样下沉到 hook（防审计者自选送分题）

证据可追溯这一项需要审计者抽查复核者的 evidence。但**抽样者不能是审计者本身**——否则它会下意识挑"看起来好验的"。所以：

- `hooks/lib/seeded-sample.js` 用 `sha256(段头) → mulberry32 PRNG → Fisher-Yates` 确定性挑出 N = `max(1, ceil(evidence数 / 3))` 条索引
- 同一段两次跑产生**完全相同**的样本（可事后追溯审计者历次行为是否一致）
- 抽中的证据通过 `{{SAMPLED_EVIDENCE}}` 占位符注入审计者 system prompt
- 审计者 prompt 明确禁止跳过预选样本，禁止额外挑样本

### 跳过审判

某些段确实琐碎到不值得开庭（如改个 typo），可以在段头写：
```
> 审计：跳过
```
hook 识别到这一行就不触发审判。**跳过声明本身留在 todo 里有迹可查**，未来审计 todo 时会被发现是否被滥用。

### 失败循环的逃生舱

| 失败次数 | hook 行为 |
|---------|----------|
| 1~2 次 | 写入 `> 审判失败次数：N`，deny 主 Claude 操作并把失败原因抛回去强制修复 |
| 3 次 | 写入 `> 🚨 审判搁置`，hook 后续不再触发，**必须告知用户由人类裁决** |

3 次连续失败通常意味着：达标标准本身有歧义、任务设计有问题、或 AI 之间无法达成共识——这是人类该介入的信号，不是再多跑一次 AI 能解决的。

### 配置项

通过环境变量调：

| 变量 | 默认 | 含义 |
|------|------|------|
| `TRIBUNAL_VERIFIER_MODEL` | `claude-opus-4-6` | 复核者用什么模型 |
| `TRIBUNAL_AUDITOR_MODEL` | `claude-opus-4-6` | 审计者用什么模型（可设为 sonnet 走异构降共谋） |
| `TRIBUNAL_TIMEOUT_SEC` | `600` | 单次 spawn 超时 |
| `TRIBUNAL_MAX_RETRIES` | `3` | 连续失败几次后搁置 |
| `TRIBUNAL_STUB_MODE` | （空） | 设 `PASS` / `FAIL` / `PASS_LOWCALLS` 走 stub，不真 spawn（用于自测） |
| `CLAUDE_DISCIPLINE_BYPASS` | （空） | 设 `1` 时所有 hook 直接 exit 0（spawned 子进程自动带这个） |

## 方法论分级存放

methodology/ 采用**渐进式披露**设计：

- `_index.md`（顶层索引）：每次任务开始时读取，几十行，很轻
- 分类目录：按"什么时候需要用"组织（如 `frontend-patterns/`、`testing/`）
- 详情文件：只在匹配当前任务场景时才读取

这样方法论可以无限积累，但每次任务只加载相关部分，不会撑爆上下文。

## 自定义

### 白名单

`hooks/check-todo-modified.js` 中定义了不受 todo 管控的目录白名单：

```javascript
const whiteList = [
  p => p.includes('/todo/current.md') || p.includes('\\todo\\current.md'),
  p => p.includes('/CLAUDE.md') || p.includes('\\CLAUDE.md'),
  p => p.includes('/methodology/') || p.includes('\\methodology\\'),
  p => p.includes('/research/') || p.includes('\\research\\'),
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
