# Changelog

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
