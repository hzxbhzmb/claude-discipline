# Changelog

## 3.0.1 — 修死锁：Bash 写白名单文件 + deny 消息明确"用 Edit"（2026-04-28）

### 背景

v3.0.0 上线后真实用户场景暴露**自举死锁**：

1. AI 想编辑非白名单源文件（如 `apps/web/src/foo.ts`）→ `pre-edit-write:handshake` deny，提示"先建任务段"
2. AI 习惯用 Bash 重定向写文件（`tee -a` / `>>` / `cat <<EOF`）→ `check-bash-mutation` deny，提示"先建段+握手"
3. AI 困惑："建段需要握手，握手需要建段" → 卡死

实际有出路（用 Edit 工具直接编 `todo/current.md`，白名单允许），但 v3.0.0 的 deny 消息没明确指引，且 `check-bash-mutation` 的白名单逻辑跟 Edit/Write 链不对称。

### 修复

**A 修：deny 消息明确"用 Edit 工具"指引**

- `_pre-checks.handshake` 无段 deny 消息加："💡 **请用 Edit 工具直接编辑 `todo/current.md`** 来新建任务段——current.md 在白名单内，可直接编辑无需先握手"
- `check-bash-mutation` 两处 deny 消息（无段 / 有段无授权）都加同款提示

**B 修：check-bash-mutation 对白名单 mutation 目标放行**

新增 `extractSegmentTargets(seg)` 和 `allTargetsWhitelisted(command)` —— 解析 Bash 命令的 mutation 操作目标，若全部在白名单（`todo/current.md` / `archive/` / `methodology/` / `research/` / `CLAUDE.md` / `MEMORY.md` / `.claude/`）则放行，与 `pre-edit-write` 的白名单语义对等。

**支持的命令模式**：
- 重定向：`> FILE` / `>> FILE`（豁免 `/dev/null` / fd 复制）
- `tee FILE` / `tee -a FILE`
- `rm` / `rmdir` / `shred` / `truncate FILE`
- `mv ... DST` / `cp ... DST` / `install ... DST`（取最后非 flag 参数）
- `sed -i` / `awk -i inplace` / `perl -i FILE`
- `dd of=FILE`
- `git rm/mv/restore FILE`

**保守原则**：解析失败（heredoc / 变量替换 / 复杂引号嵌套）→ 不放行（落到 v3.0.0 deny 行为，不会更糟）；混合命令（白名单 + 非白名单目标）→ 任一非白名单 → 整体 deny。

`git reset / clean / checkout` 子命令的"目标"可能是整个工作树，保守不放行。

### 测试

`scripts/test-bash-mutation.js` 新增分组 I（11 断言）：

- I1-I7：白名单命令放行（pipe tee / 重定向 / mv / sed -i / rm archive / >> CLAUDE.md / sed methodology）
- I8：混合命令仍 deny（白名单 + 非白名单）
- I9：mv 普通源文件仍 deny
- I10：解析失败保守 deny
- I11：deny 消息含"用 Edit 工具"指引

### 升级影响（v3.0.0 → v3.0.1）

**零动作平滑升级**。纯 bug 修复，无行为破坏：

- 老用户 Bash 改源文件被拦的行为完全不变
- 老用户被拦时 deny 消息变得更有指引（多了"用 Edit"提示）
- 新放行：Bash 改 `todo/current.md` / `archive/` / `methodology/` / `research/` / `CLAUDE.md` / `MEMORY.md` / `.claude/` 不再需要握手——这些文件本来就是白名单（Edit/Write 链已经放行）

### 回归验证

- `test-bash-mutation.js` **70/70**（基线 59 + 新增 11）
- 其它 4 测试套件零回归：33 + 16 + 40 + 43 = 132/132
- 真机端到端 3 死锁场景：tee -a todo/current.md → allow ✓ / echo >> 非白名单 → deny ✓ / handshake deny 消息含"用 Edit" ✓

---

## 3.0.0 — Hook 合并 + 删/降权低价值检查 + 规则文档去补丁化（2026-04-27）

### 背景

诊断报告（`research/2026-04-27-discipline-refactor-diagnosis.md`）方案 B + C + D 一次性落地。延续 v2.5.0 的方案 A + E（公共框架 + 可观测性），本版本进一步：(B) 把 5+6 个独立 hook 合并到 2 个合并入口，每次 Edit/Write 启动 11 个 node 进程减为 2 个；(C) 删除被握手隐含语义的冗余 hook + 把不重要的 hook 降级为软警告；(D) 重写规则文档，把 SessionStart 注入的主文档从 233 行砍到 120 行。

### B 阶段：Hook 合并（启动开销 11 进程 → 2 进程）

新增**子检查模块**（纯逻辑，可被多入口 require）：

- **`hooks/_pre-checks.js`**：4 个 PreToolUse Edit/Write 子检查（handshake / methodologyIndex / writeForbidden / lineCount）
- **`hooks/_post-checks.js`**：5 个 PostToolUse Edit/Write 子检查（markMethodologyIndex / acceptance / verification / evidenceOnMark / retryLimit）

新增**合并入口**（hooks.json 注册）：

- **`hooks/pre-edit-write.js`**：单 node 进程串行跑 4 个 pre-check。任一 deny 立即返回，warn 走 stdout 但继续。
- **`hooks/post-edit-write.js`**：单 node 进程串行跑 5 个 post-check。同样语义。

**hooks.json** 从 95 行 → 41 行。PreToolUse Edit/Write 串行链 5 hook → 1 个；PostToolUse Edit/Write 串行链 6 hook → 1 个。

**子检查可观测性**：每个子检查独立 record 到 `~/.claude-discipline/runtime-*.jsonl`，hook 名 `pre-edit-write:<sub>` / `post-edit-write:<sub>`。`hook-stats.js` 仍按子检查分桶。

### C 阶段：删/降权低价值 hook（基于诊断 § 2.6 + § 2.7）

**删除**：

- **`hooks/check-todo-modified.js`**：语义被 handshake 隐含——handshake 要求本会话已建任务段，建段必然 Edit 了 todo，因此独立的"todo 是否被本会话编辑过"检查冗余。
- **`hooks/mark-todo-updated.js`**：上面那个 hook 的 marker 来源，一并删除。

**降级（deny → 软警告）**：

- **`check-methodology-index`**：从 PreToolUse deny 改为 stdout 软警告。methodology 写入频率极低、强制成本/收益比差。降级后老用户工作流不被打断，AI 仍能看到提示。

### D 阶段：规则文档去补丁化（AI 心智负担减半）

**`rules/discipline.md`** 233 行 → **120 行**（SessionStart 注入只读这一份）：

- 删除所有 `v2.x+` 版本号引用（AI 不需要知道历史，只需要知道当前规则）
- 反模式清单 10 条 → 5 条（合并语义相近的）
- 验算反向表 4 例 → 2 例
- 任务段格式示例 5 行 AI 理解 → 1 行
- 多会话并发段从 8 行 → 1 行 + 链到 `concurrency.md`
- 工具层豁免段紧凑化

**新增**：
- **`rules/concurrency.md`** 46 行：完整多会话规则（任务段归属 / Write 禁止 / 证据日志隔离 / 自动认领 / 祖传段）
- **`rules/troubleshooting.md`** 96 行：BYPASS env / 验算失败处理 / 归档机制 / 可观测性 / Hook 一览 / v3.0.0 升级影响

**注入策略**：仅 `discipline.md` SessionStart 注入。`concurrency.md` 和 `troubleshooting.md` 按需读——hook deny 消息可指向，AI 在涉及多会话/边界 case 时主动 Read。

### 删除测试不再依赖的老 hook 文件（X 方案彻底清理）

`hooks.json` 注册的入口已经只剩 6 个，老 14 个 hook 薄包装文件 Claude Code 也不会触发——纯粹是死代码。本版本测试改用 `runCheck(checkFn, ctx)` 直接调子检查模块（不 spawn 进程，更快），从而彻底删除 9 个老 hook 文件：

**删除**：`check-handshake.js` / `check-todo-verification.js` / `check-todo-write-forbidden.js` / `check-todo-line-count.js` / `check-verification-retry-limit.js` / `check-evidence-on-mark.js` / `check-methodology-index.js` / `check-todo-acceptance.js` / `mark-methodology-index-updated.js`

**保留**（hooks.json 仍注册的独立 hook）：`check-bash-mutation.js` / `auto-archive.js` / `log-tool-call.js`

**保留**（公共库/模块）：`_hook-runner.js` / `_runtime-log.js` / `_session-util.js` / `_pre-checks.js` / `_post-checks.js`

**保留**（hooks.json 注册的合并入口）：`pre-edit-write.js` / `post-edit-write.js`

**最终 `hooks/*.js` 文件清单：10 个，零死代码**。

测试套件改动：5 个 `test-*.js` 文件加了 `runCheck()` helper（直接调子检查函数，模拟 spawn 风格的返回供原有断言复用），原 `runHook('hooks/check-X.js', ...)` 调用改为 `runCheck(preChecks.X, ...)` 或 `runCheck(postChecks.X, ...)`。**断言文本零修改**。

### 平滑升级承诺（marketplace 用户）

**`/plugin update claude-discipline` 后零动作生效**：

- ✓ 现有任务段格式不变；带 session 标注的进行中段继续被新 hook 识别
- ✓ 祖传无标注段 SessionStart 自动认领机制保留
- ✓ 握手段格式（`> ✅ 执行授权` / `> ❌ 验算第 N 次失败` / `> ✅ 验算通过` / `> ✅ 完成` / `> ❌ 最终验算失败`）关键字保留
- ✓ `/tmp/claude-evidence-*.jsonl` 证据日志格式不变
- ✓ 老 marker 文件 `/tmp/claude-todo-updated-*` / `claude-methodology-index-updated-*` 残留无害（不再被读 = 系统垃圾，OS 重启清掉）
- ✓ `methodology/` / `research/` / `todo/archive/` 内容完全不动
- ✓ 老的 `> ✅ 验算通过` / `> ✅ 完成` 标记继续被 auto-archive 识别
- ✓ `CLAUDE_DISCIPLINE_BYPASS=1` env 行为不变
- ✓ v2.4.0 的"current.md >200 行硬阻断 + 白名单 + 归档死锁规避"行为完全保留
- ✓ 用户**只通过 hooks.json 间接调 hook**——文件名变化对 marketplace 升级无影响

**新行为**：

- AI 编辑 `methodology/` 详情前未更新 `_index.md` → 从 deny 变为 stdout 软警告（不阻断工作流）
- 编辑非白名单文件前没建 todo 任务段不再被 `check-todo-modified` 单独拦——但仍被 `pre-edit-write:handshake` 拦（语义等价）

### 行数对账

| 项 | 基线（v2.4.0） | v3.0.0 | 变化 |
|---|---|---|---|
| `hooks/*.js` 总行数 | 1191 | ~1180 | 持平（子检查模块新增；删 11 个老 hook 抵消） |
| `hooks/hooks.json` | 95 | 41 | **-57%** |
| `rules/discipline.md`（SessionStart 注入） | 233 | **120** | **-49%** |
| `rules/` 总（含 concurrency + troubleshooting） | 233 | 262 | +12%（按需读） |
| **Hook .js 文件数** | 15 | **10** | **-33%**（无死代码） |
| **每次 Edit/Write 启动 node 进程数** | **11** | **2** | **-82%**（核心收益） |
| **每次 Edit/Write 主流程读 `current.md` 次数** | 多次（每个 hook 各自读） | 子检查最多读 2 次 | 文件 IO 显著降低 |

### 回归验证

- `test-multi-session.js` 33/33 通过
- `test-bash-mutation.js` 59/59 通过
- `test-verification-retry.js` 16/16 通过
- `test-archive.js` 40/40 通过
- 端到端 5 场景干跑：无握手 deny ✓ / 有握手 allow ✓ / Bash mv 无握手 deny ✓ / 200 行硬阻断 deny ✓ / 全 [x] 无验算 deny ✓

---

## 2.5.0 — 公共 hook 框架 + 可观测性日志（2026-04-27）

### 背景

诊断报告（`research/2026-04-27-discipline-refactor-diagnosis.md`）指出两个结构性问题：(a) 14 个 hook 头部各自重复 BYPASS / stdin / JSON.parse / projectDir 边界 / 白名单样板（14 份独立副本，2 处白名单逐字重复）；(b) 没有可观测性——v2.4.0 才发现 `check-todo-line-count.js` 因注册位置错从 v2.3 起一个月没生效，没人察觉。

### 新增

- **`hooks/_hook-runner.js`**（新）：公共 hook 运行框架。封装 BYPASS env 短路、stdin 读取 + JSON.parse、projectDir 边界、单一 `WHITELIST_FRAGMENTS` 来源。每个 hook 用 `runHook(name, event, handler)` 即可，不再各自写样板。导出 `denyPre / denyPost / isInProject / isWhitelisted` 工具函数。
- **`hooks/_runtime-log.js`**（新）：可观测性日志。每次 hook 跑到末尾自动 `record({ hook, event, tool, denied, warned, reason })` 到 `~/.claude-discipline/runtime-YYYY-MM-DD.jsonl`（按日分文件，自然滚动，无需 prune）。失败安全（写不进去吞掉）。`CLAUDE_DISCIPLINE_NO_RUNTIME_LOG=1` 可关闭。
- **`scripts/hook-stats.js`**（新）：runtime 日志统计工具。`node scripts/hook-stats.js [天数] [--by-reason]` 输出过去 N 天每个 hook 的触发次数、deny 次数、deny%、按 deny 原因分桶。

### 重构

14 个 hook 全部改写为使用 `_hook-runner` + `_runtime-log`，**判定逻辑零改动**：

- `check-handshake.js` / `check-bash-mutation.js` / `check-todo-modified.js` / `check-todo-line-count.js` / `check-todo-write-forbidden.js` / `check-methodology-index.js`
- `check-todo-verification.js` / `check-evidence-on-mark.js` / `check-todo-acceptance.js` / `check-verification-retry-limit.js`
- `mark-todo-updated.js` / `mark-methodology-index-updated.js` / `log-tool-call.js` / `auto-archive.js`

副作用：白名单从原来散落在 `check-handshake` + `check-todo-modified` 的两份逐字副本，统一为 `_hook-runner.js` 的单一 `WHITELIST_FRAGMENTS`——之后调整白名单只改一处。

### 行为变化

**对终端用户：零行为变化**。所有 deny 消息文本、阈值、判定规则、白名单都与 v2.4.0 完全一致。148 个测试断言全过证明行为不变。

**新增可观测能力**（可选）：

- 跑过任意 hook 后，`~/.claude-discipline/runtime-YYYY-MM-DD.jsonl` 会有日志条目
- 用 `node scripts/hook-stats.js` 看 hook 触发分布——哪些 hook 真在工作、哪些可能形同虚设
- 此前 v2.4.0 那种"一个月没人发现 hook 没生效"的事故，现在可以一行命令检测

### 升级影响（v2.4.0 → v2.5.0）

**零动作平滑升级**：

- 现有任务段格式不变，老段继续有效
- hooks.json 注册项不变（hook 文件名、matcher、event 全一致）
- 老用户的 `/tmp/claude-evidence-*.jsonl` 和 `claude-todo-updated-*` marker 文件**继续被新版读写**，行为完全保留
- 老的 `methodology/` / `research/` / `todo/archive/` 内容完全不动
- `CLAUDE_DISCIPLINE_BYPASS=1` env 行为不变
- v2.4 的"current.md >200 行硬阻断 + 白名单 + 归档死锁规避"行为完全保留

**新增可选 env**：`CLAUDE_DISCIPLINE_NO_RUNTIME_LOG=1` 关闭可观测性日志（默认开启，写入 `~/.claude-discipline/`）。

### 回归验证

- `test-multi-session.js` 33/33 通过
- `test-bash-mutation.js` 59/59 通过
- `test-verification-retry.js` 16/16 通过
- `test-archive.js` 40/40 通过
- E2E 真实触发：手工喂 hook PreToolUse Edit 输入 → runtime-log 写入 deny 记录正确 → hook-stats.js 156 条统计结果合理

---

## 2.4.0 — 归档按日分文件 + 月子目录 + 追加位置规则（2026-04-26）

### 背景

v2.3.0 把 archive 按月归到单文件 `archive/YYYY-MM.md`，但一个月就能写满 900+ 行（本仓库 2026-04 月文件就是 921 行 / 28 段），找历史段还是要在大文件里翻。同时发现 AI 创建新任务段的位置不一致——有时插在 current.md 顶部、有时附在末尾，乱。

### 新增 / 变更

- **行数 hook 真生效（PostToolUse → PreToolUse）**：之前 `check-todo-line-count.js` 注册在 PostToolUse + 输出 `permissionDecision:deny`——但 Claude Code 的 PostToolUse 不认这个 schema，deny 被静默忽略，硬阻断从未实际生效（v2.3.0/v2.4.0 早期版本均有此 bug）。现改为 PreToolUse + 白名单：current.md >200 行时，编辑非 current/非 archive 的项目文件被 deny；编辑 current.md 自身或 archive/ 下文件继续放行（避免归档死锁）。
- **删除 80 行软警告档**：`check-todo-line-count.js` 现在只有两档——≤200 完全静默 / >200 硬 deny。理由：软警告 AI 可无视，把心智模型简化到只剩硬阻断。`rules/discipline.md` 同步移除"软警告"条目。
- **`hooks/auto-archive.js`**：归档路径从 `archive/YYYY-MM.md` 改为 `archive/YYYY-MM/YYYY-MM-DD.md`（按日分文件，月份作子目录）。同一日多段聚到同一日文件；跨日多段分到各自日文件；跨月多段分到各自月子目录。日文件首行是 `# YYYY-MM-DD 归档`。
- **`rules/discipline.md` 追加位置规则**：明文规定"创建新任务段必须追加到 `todo/current.md` 末尾"——靠规则文本约束，未加 hook 强制。
- **`hooks/check-todo-line-count.js`**：deny 消息里的归档路径示例同步更新到新格式。
- **`scripts/migrate-archive-to-daily.js`**（新）：一次性迁移工具，把旧的 `archive/YYYY-MM.md` 拆成 `archive/YYYY-MM/YYYY-MM-DD.md` 多文件。支持 `--dry-run` 预览。
- **`scripts/test-archive.js`**：测试断言全部更新到新路径，新增 D 组（按日分文件 + 月子目录）10 个断言。共 39/39 通过。

### 升级影响（v2.3.0 → v2.4.0）

**对仍在用 v2.3.0 月文件结构的项目**：

1. 备份：`cp -r todo/archive /tmp/archive.bak.$(date +%s)`
2. 跑迁移：`CLAUDE_PROJECT_DIR=$(pwd) node {plugin}/scripts/migrate-archive-to-daily.js --dry-run`（先预览）
3. 实跑：去掉 `--dry-run`
4. 对账：`find todo/archive -name '*.md' -exec grep -c "^## " {} +` 段总数应等于备份里的段数

**新建项目**：开箱即用，没有迁移负担。

**对 AI 行为的影响**：

- 创建新任务段时**必须追加到文件末尾**（在最后一个 `---` 后），不再插顶部或中间。
- 归档路径更新到 `archive/YYYY-MM/YYYY-MM-DD.md`。
- 现有 hook 行为完全保留（含完成判定 / 行数三档 / 跨会话宽容）。

### 回归验证

- `test-archive.js` 39/39 通过（新增 10 个 D 组按日测试）
- `test-multi-session.js` 33/33 通过
- `test-bash-mutation.js` 59/59 通过
- `test-verification-retry.js` 16/16 通过
- 真机迁移：本仓库 `archive/2026-04.md`（921 行 / 28 段）→ 5 日文件（71+105+31+288+435 行 / 5+9+1+7+6=28 段），grep 反向对账无丢失。

## 2.3.0 — 自动归档 + 行数硬阻断（2026-04-26）

### 背景

旧规则只把"超 80 行归档"写在文档里，hook 仅 stdout 一行软警告（不 deny），AI 完全可以无视——导致 `todo/current.md` 在长期项目里普遍累积到几百上千行，挤占上下文窗口、读起来也累。

### 新增

- **`hooks/auto-archive.js`**：SessionStart 钩子（与 `init-project.js` 并列），扫描 `todo/current.md`，把"已完成段"整段搬到 `todo/archive/YYYY-MM.md`（按段标题日期分月归档）。
  - 完成判定（保守）：段内**所有** `- [ ]` 已勾 + 至少含一个完成标记（`> ✅ 验算通过` / `> ❌ 最终验算失败` / `> ✅ 完成`）。
  - 跨会话宽容：不要求 sessionId 匹配；任何会话写完的段都可被任何会话归档；祖传无标注段同样适用。
  - 失败安全：异常吞掉不阻塞会话启动。
- **`hooks/check-todo-line-count.js` 升级**：原本只 stdout 一行警告，现在分三档：
  - ≤80 静默；
  - 80 < n ≤ 200 软警告（保留旧行为）；
  - **> 200 行 deny 下次 Edit/Write**，消息附归档操作步骤。
  - 硬线可通过 env `DISCIPLINE_TODO_HARD_LIMIT=N` 覆盖。
- **`scripts/test-archive.js`**：29 断言，覆盖 3 大组（auto-archive 11 个判定场景 / 行数 hook 三档 / SessionStart 串行链）。

### 规则更新

- `rules/discipline.md`：归档段从单行说明扩成"自动 / 软警告 / 硬阻断"三轨。
- 快车道完成新增**可选** `> ✅ 完成：{一句话}` 标记，让快车道段也能被自动归档。

### 升级影响（v2.2.0 → v2.3.0）

**零动作升级**：

- 现有任务段格式不变；老段如有 `> ✅ 验算通过` 会在下次 SessionStart 自动归档（一次性清理积压）。
- 老的 `check-todo-line-count.js` 行为在 ≤200 行内完全保留。
- 不影响现有任何 hook、不需要改 settings、不需要重启。

**行为变化**：

- 第一次 SessionStart 后会看到 stderr 一行 `✓ auto-archive: N 个完成段已归档（...）`——这是正常清理。
- current.md 超 200 行后下次 Edit/Write 会被 deny，必须先归档再继续。

### 回归验证

- 新 `test-archive.js` 29/29 通过
- `test-multi-session.js` 33/33 通过
- `test-bash-mutation.js` 59/59 通过
- `test-verification-retry.js` 16/16 通过

## 2.2.0 — 验算失败迭代上限（2026-04-24）

### 背景

旧规则只说"验算通过就收尾"，没约定"验算不通过怎么办"。AI 可能 silent 改到过为止（无限循环烧 token），也可能立刻汇报小问题（打断真小修）。两种都不违反旧规则，但用户体验差别很大。

### 新增

- **`hooks/check-verification-retry-limit.js`**：PostToolUse Edit/Write on todo/current.md，统计本会话最新段内 `> ❌ 验算第 N 次失败` 行数；>3（默认）且无"最终失败"行 → deny。
- **`scripts/test-verification-retry.js`**：16 断言，覆盖 8 分组（≤上限 allow、>上限 deny、终局行放行、祖传/他会话不连坐、非 todo 文件不介入、BYPASS、自定义上限 env、格式宽容）。

### 三种失败段类型

| 段类型 | 用途 | 格式 |
|-------|------|------|
| 迭代中 | 每次验算失败后写 | `> ❌ 验算第 N 次失败：{原因} → 改进：{做了什么}` |
| 最终放弃 | 超上限 / AI 主动交棒 | `> ❌ 最终验算失败：{汇总} \| 尝试：... \| 建议：...` |
| 失败后成功 | 经 K 次迭代终于过 | `> ✅ 验算通过：{最终方案，经 K 次迭代}` |

### 配置

- `DISCIPLINE_VERIFY_RETRY_LIMIT=N` env 覆盖默认 3
- `CLAUDE_DISCIPLINE_BYPASS=1` 整个 hook 短路（与家族一致）

### 升级影响（v2.1.0 → v2.2.0）

**零动作升级**：

- 现有任务段格式不变，历史段继续有效
- AI 不写失败段 → hook 不介入（hook 只数写出来的行，不监控测试红绿）
- 只有当 AI 开始写"第 N 次失败"段、且累计 > 3 时才会触发

**行为变化**：AI 写到第 4 次失败段时被 deny，deny 消息带"改写为最终失败 + 对话汇报"的指引，AI 收到后自救转向交棒。

### 回归验证

- 新 `test-verification-retry.js` 16/16 通过
- 现有 `test-multi-session.js` 33/33 通过
- 现有 `test-e2e-concurrent.js` 43/43 通过
- 现有 `test-bash-mutation.js` 59/59 通过

### 文档更新

- `rules/discipline.md`：新增"验算失败处理"章节 + 四次挥手表格细分过/不过 + 反模式清单增补两条（无限 silent 改、非标准格式失败行）
- `README.md`：新增"验算失败处理（v2.2.0+）"章节 + Hook 一览表增行 + 插件结构补新文件

---

## 2.1.0 — Bash 写操作握手保护（2026-04-24）

### 漏洞背景

v2.0.x 的 hook matcher 只匹配 `Edit|Write`，AI 可以用 Bash 的 `mv / sed -i / cp / rm / 重定向 / git reset --hard` 等命令**绕过三次握手直接改项目文件**。曾有真实案例：AI 用 `mv` 批量改名 1500 个文件，超出了用户的授权范围。

### 新增

- **`hooks/check-bash-mutation.js`**：PreToolUse（matcher `Bash`），识别写/删/移操作 → 走与 `check-handshake.js` 同款"本会话最新段必须有 `> ✅ 执行授权`" 检查。
- **`scripts/test-bash-mutation.js`**：59 个反向验证断言，覆盖 8 大分组（mutation/deny、authorized/allow、只读放行、无段、bypass env、非 Bash 工具、todo 缺失、判定函数直测）。

### 拦截清单

| 类别 | 命令 |
|------|------|
| 文件操作 | `mv` `cp` `rm` `rmdir` `tee` `dd` `truncate` `shred` `install` |
| 原地编辑 | `sed -i` `awk -i inplace` `perl -i` |
| 重定向 | `> file` `>> file`（豁免 `/dev/null` 和 `2>&1` fd 复制） |
| Git 破坏性 | `git reset --hard` `git clean -fd` `git checkout --` `git restore` `git rm` `git mv` |

**不拦**（低风险或只读）：`ls / cat / grep / find`, `git status / log / diff / commit / push / fetch / pull`, `touch / mkdir / chmod / chown / ln`。

**复合命令**：按 `; && || |` 切分后逐段检查——任一段命中 mutation 即触发。

### 豁免

1. 本会话最新任务段含 `> ✅ 执行授权`（含快车道）→ 放行
2. `CLAUDE_DISCIPLINE_BYPASS=1` env → 放行
3. `todo/current.md` 不存在（init 未跑）→ 放行

### 升级影响（v2.0.x → v2.1.0）

**零动作升级**——无需改任何项目文件、任务段、配置：

- 现有授权段格式不变，历史段继续有效
- `/plugin update` 后新会话立即生效
- 正在跑的旧会话也即时生效（hook 每次工具调用由 Claude Code 现场 spawn node 进程）
- 旧会话 AI 认知的规则文本是"Bash 随便用"，但 hook 会拦——deny 消息自带"建段 + 授权"自救指引，AI 收到后无缝自救，不需重启会话

**行为变化**：升级后 AI 尝试用 Bash 改项目文件但无授权段 → 被 `check-bash-mutation` 拦截。deny 消息明确标注"v2.1.0+ 规则变化"+ 建段模板。

**逃生舱**：任何情况下设 `CLAUDE_DISCIPLINE_BYPASS=1` env 都可临时绕过全部检查。

### 文档更新

- `rules/discipline.md`：
  - "工具层天然豁免"章节纠正——明确"Bash 只读随便用，写操作受保护"
  - 新增"⚠️ Bash 写操作同样受握手保护（v2.1.0+）"节
  - 反模式清单增补"用 Bash 绕开握手"
- `README.md`：新增"Bash 写保护"章节 + Hook 一览增行 + 插件结构补 check-bash-mutation / test-bash-mutation

### 回归验证

- 现有 `test-multi-session.js` 33/33 通过（无回归）
- 现有 `test-e2e-concurrent.js` 43/43 通过（无回归）
- 新增 `test-bash-mutation.js` 59/59 通过

---

## 2.0.0 — 多会话并发支持

详见 README 的["升级指南"](./README.md#升级指南从旧版本--多会话版本)章节。
