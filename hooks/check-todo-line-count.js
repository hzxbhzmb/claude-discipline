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

const fs = require('fs');
const path = require('path');
const { runHook, isInProject, denyPre } = require('./_hook-runner');

const HARD_LIMIT = parseInt(process.env.DISCIPLINE_TODO_HARD_LIMIT, 10) || 200;

runHook('check-todo-line-count', 'PreToolUse', (ctx) => {
  if (!ctx.filePath || !ctx.projectDir) return;

  // 项目目录外 → 通用豁免
  if (!isInProject(ctx.filePath, ctx.projectDir)) return;

  // 编辑 current.md 自身 → 放行（AI 在做归档清理）
  if (ctx.filePath.includes('/todo/current.md') || ctx.filePath.includes('\\todo\\current.md')) return;

  // 编辑 archive 下面 → 放行（AI 在写日文件）
  if (ctx.filePath.includes('/todo/archive/') || ctx.filePath.includes('\\todo\\archive\\')) return;

  // 读 current.md 当前行数
  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let lineCount = 0;
  try {
    const content = fs.readFileSync(todoFile, 'utf8');
    lineCount = content.split('\n').length;
  } catch (e) {
    return;
  }

  if (lineCount <= HARD_LIMIT) return;

  const reason =
    `🛑 todo/current.md 已 ${lineCount} 行，超硬线 ${HARD_LIMIT}。本次 Edit/Write 已被阻断——必须先归档已完成段。\n` +
    `\n` +
    `操作步骤：\n` +
    `1. 选出"已完成段"（所有 \`- [ ]\` 已勾、含 \`> ✅ 验算通过\` 或 \`> ❌ 最终验算失败\` 或 \`> ✅ 完成\`）\n` +
    `2. 将段整段（标题+正文）追加到 \`todo/archive/YYYY-MM/YYYY-MM-DD.md\`（按段标题日期分日，月子目录）\n` +
    `3. 从 current.md 删除该段\n` +
    `4. 重新尝试你刚才的编辑\n` +
    `\n` +
    `白名单（即使超线也放行）：current.md 自身的 Edit、archive/ 下文件的 Edit、项目目录外路径。\n` +
    `提示：下次会话启动时 auto-archive 钩子会自动搬走已完成段；本次是当前会话内累积过多触发。`;

  process.stdout.write(denyPre(reason));
  ctx.deny(`current.md ${lineCount} lines > ${HARD_LIMIT}`);
});
