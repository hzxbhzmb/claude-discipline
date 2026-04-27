# Hook 行为细节、BYPASS、失败处理、归档、升级指引

> 主规则在 `discipline.md`。本文件是参考资料——hook deny 消息里会链接到这里相关章节。

## BYPASS 紧急逃生

```bash
export CLAUDE_DISCIPLINE_BYPASS=1
```

设置后**所有 hook 短路**，工作流退化为纯 Claude Code 默认行为。用于：
- 紧急情况下绕过 hook
- 测试场景
- 调试 hook 自身

**默认开启的关闭开关**（更细粒度）：

```bash
export CLAUDE_DISCIPLINE_NO_RUNTIME_LOG=1   # 关闭 ~/.claude-discipline/runtime-*.jsonl 写入
export DISCIPLINE_TODO_HARD_LIMIT=N          # 自定义 current.md 行数硬阻断阈值（默认 200）
export DISCIPLINE_VERIFY_RETRY_LIMIT=N       # 自定义验算失败迭代上限（默认 3）
```

## 验算失败处理

验算不保证一次过。AI 可以**有限次自修迭代**，但不能无限 silent 改到过为止。

### 三种失败段类型

| 段类型 | 何时写 | 格式 |
|-------|-------|------|
| 迭代中 | 每次验算不通过后、下一轮改进前 | `> ❌ 验算第 N 次失败：{原因} → 改进：{做了什么}` |
| 最终放弃 | 累计失败超上限 / AI 主动交棒 | `> ❌ 最终验算失败：{汇总原因} \| 尝试：{K 次都试了什么} \| 建议：{下一步方向}` |
| 失败后成功 | 经 K 次迭代终于过了 | `> ✅ 验算通过：{最终方案，经 K 次迭代}` |

### 迭代上限

**默认 3 次**（可通过 `DISCIPLINE_VERIFY_RETRY_LIMIT=N` 覆盖）。超限后 hook 会 deny 对 todo 的下次编辑，强制 AI 改写为 `> ❌ 最终验算失败` 段交棒。

由用户决定：改方向（重走握手）/ 回滚 / 拉长上限 / 放弃。

## 归档机制

### 自动归档（每次 SessionStart）

`auto-archive.js` 扫 `todo/current.md`，把"已完成段"整段搬到 `todo/archive/YYYY-MM/YYYY-MM-DD.md`（按段标题日期分日，月份做子目录）。

**完成判定**（保守）：
- 段标题不是 `## 归档说明`
- 段内无未勾的 `- [ ]`
- 段内至少含一个完成标记：`> ✅ 验算通过` 或 `> ❌ 最终验算失败` 或 `> ✅ 完成`

**跨会话宽容**：不要求 sessionId 匹配，任何会话写完的段都可被任何会话归档。

### 行数硬阻断（兜底）

`current.md` 超 200 行（可通过 env 调）时，下次 Edit/Write 被 deny。**白名单允许**：编辑 current.md 自身（让 AI 删段缩文件）、编辑 archive/ 下文件（让 AI 加日文件）、项目目录外路径。

避免归档死锁：白名单保证你能手工归档让 current.md 缩短。

## 可观测性

每次 hook 跑都自动 record 到 `~/.claude-discipline/runtime-YYYY-MM-DD.jsonl`（按日分文件）。统计：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js          # 过去 7 天
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js 30       # 过去 30 天
node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-stats.js --by-reason   # 按 deny 原因分桶
```

用途：哪些 hook 真在工作、哪些 deny 高频、哪些可能形同虚设。

## Hook 一览（v3.0.0+ 合并后）

| Hook | 触发 | 效果 |
|------|------|------|
| **pre-edit-write**（合并入口） | PreToolUse Edit/Write | 串行 4 子检查：handshake / methodology-index / write-forbidden / line-count |
| **check-bash-mutation** | PreToolUse Bash | Bash 写操作受三次握手保护 |
| **post-edit-write**（合并入口） | PostToolUse Edit/Write | 串行 5 子检查：mark-methodology-index / acceptance / verification / evidence-on-mark / retry-limit |
| **log-tool-call** | PostToolUse `.*` | 所有工具调用写证据日志 |
| **auto-archive** | SessionStart | 完成段自动搬到 archive/ |
| **init-project** | SessionStart | 初始化目录 + 注入规则 + 注入 sessionId 短 ID + 自动认领祖传段 |

子检查可观测性：每个子检查在 runtime-log 里记为 `pre-edit-write:handshake` / `post-edit-write:verification` 等，hook-stats 仍按子检查分桶。

## v3.0.0 升级影响

详见 `CHANGELOG.md` v3.0.0 章节。摘要：
- **零动作平滑升级**：现有任务段格式不变，老段继续有效
- **删除**：`check-todo-modified` + `mark-todo-updated`（语义被 handshake 隐含）
- **降级**：`check-methodology-index` 从 deny → stdout 软警告
- **合并**：5+6 个 PreToolUse/PostToolUse Edit/Write hook → 2 个合并入口
- **新增**：`pre-edit-write.js` / `post-edit-write.js` / `_pre-checks.js` / `_post-checks.js`
- **保留**：所有老 hook 文件作为薄包装（< 15 行/个），仍可独立 spawn（测试 + 兼容性）
- **行为兼容**：4 个测试套件 148 断言全过；deny 消息文本 / 阈值 / 判定规则全保留
- **老 marker 文件残留无害**：`/tmp/claude-todo-updated-*` 不再被读，下次 OS 重启清掉
