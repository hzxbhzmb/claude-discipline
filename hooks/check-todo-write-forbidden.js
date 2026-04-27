#!/usr/bin/env node
// PreToolUse Hook: 禁止 Write 整覆盖 todo/current.md——多会话下会吞别的会话写入的段
// 必须用 Edit（增量编辑）。Edit 的 old_string 精确匹配是天然的乐观锁。

const { runHook, denyPre } = require('./_hook-runner');

runHook('check-todo-write-forbidden', 'PreToolUse', (ctx) => {
  if (ctx.toolName !== 'Write') return;
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;

  const reason = [
    '🚫 禁止用 Write 整覆盖 todo/current.md。',
    '',
    '原因：并发会话下 Write 会吞掉其它会话正在写入的任务段，丢失他人工作。',
    '请用 Edit 做增量改动（Edit 的 old_string 精确匹配是天然的并发保护）。',
    '',
    '如需"重写"，请：',
    '  1. 先用 Edit 清空你自己会话标注的段',
    '  2. 再用 Edit 追加新内容',
    '  3. 绝不要整文件 Write',
  ].join('\n');
  process.stdout.write(denyPre(reason));
  ctx.deny('Write to todo/current.md forbidden');
});
