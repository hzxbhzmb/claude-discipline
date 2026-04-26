#!/usr/bin/env node
// PreToolUse Hook (Edit|Write): 当 todo/current.md 已超 200 行时，硬拦下一次
// 对"非 current/非 archive"项目文件的 Edit/Write，强制先归档再继续。
//
// 阈值可通过 env DISCIPLINE_TODO_HARD_LIMIT=N 覆盖（默认 200）
//
// 白名单（即使 current.md 超线也放行，避免归档死锁）：
//   - 目标就是 todo/current.md 本身（让 AI 删段缩文件）
//   - 目标在 todo/archive/ 下（让 AI 加日文件）
//   - 项目目录之外的路径（discipline 通用作用域之外）
//
// 历史背景：v2.3.0 / v2.4.0 把这个 hook 做成 PostToolUse + permissionDecision:deny，
// 但 Claude Code 不认 PostToolUse 的 permissionDecision——deny 被静默忽略，所以
// 实际并没有阻断。本次（v2.4.0 内）改为 PreToolUse + 正确 schema 真生效。

if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');
const path = require('path');

const HARD_LIMIT = parseInt(process.env.DISCIPLINE_TODO_HARD_LIMIT, 10) || 200;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  if (!filePath || !projectDir) process.exit(0);

  // 项目目录外 → 通用豁免
  try {
    const absFile = path.resolve(filePath);
    const absProject = path.resolve(projectDir);
    const rel = path.relative(absProject, absFile);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
  } catch (e) { /* fallthrough */ }

  // 编辑 current.md 自身 → 放行（AI 在做归档清理）
  if (filePath.includes('/todo/current.md') || filePath.includes('\\todo\\current.md')) {
    process.exit(0);
  }

  // 编辑 archive 下面 → 放行（AI 在写日文件）
  if (filePath.includes('/todo/archive/') || filePath.includes('\\todo\\archive\\')) {
    process.exit(0);
  }

  // 读 current.md 当前行数
  const todoFile = path.join(projectDir, 'todo', 'current.md');
  let lineCount = 0;
  try {
    const content = fs.readFileSync(todoFile, 'utf8');
    lineCount = content.split('\n').length;
  } catch (e) {
    process.exit(0);
  }

  if (lineCount <= HARD_LIMIT) process.exit(0);

  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `🛑 todo/current.md 已 ${lineCount} 行，超硬线 ${HARD_LIMIT}。本次 Edit/Write 已被阻断——必须先归档已完成段。\n` +
        `\n` +
        `操作步骤：\n` +
        `1. 选出"已完成段"（所有 \`- [ ]\` 已勾、含 \`> ✅ 验算通过\` 或 \`> ❌ 最终验算失败\` 或 \`> ✅ 完成\`）\n` +
        `2. 将段整段（标题+正文）追加到 \`todo/archive/YYYY-MM/YYYY-MM-DD.md\`（按段标题日期分日，月子目录）\n` +
        `3. 从 current.md 删除该段\n` +
        `4. 重新尝试你刚才的编辑\n` +
        `\n` +
        `白名单（即使超线也放行）：current.md 自身的 Edit、archive/ 下文件的 Edit、项目目录外路径。\n` +
        `提示：下次会话启动时 auto-archive 钩子会自动搬走已完成段；本次是当前会话内累积过多触发。`,
    },
  };
  process.stdout.write(JSON.stringify(result));
});
