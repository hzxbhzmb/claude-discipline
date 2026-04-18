#!/usr/bin/env node
// PreToolUse Hook: 禁止 Write 整覆盖 todo/current.md——多会话下会吞别的会话写入的段
// 必须用 Edit（增量编辑）。Edit 的 old_string 精确匹配是天然的乐观锁。
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { process.exit(0); }

  const toolName = input?.tool_name || '';
  const filePath = input?.tool_input?.file_path || '';

  if (toolName !== 'Write') process.exit(0);
  if (!filePath.includes('/todo/current.md') && !filePath.includes('\\todo\\current.md')) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        '🚫 禁止用 Write 整覆盖 todo/current.md。',
        '',
        '原因：并发会话下 Write 会吞掉其它会话正在写入的任务段，丢失他人工作。',
        '请用 Edit 做增量改动（Edit 的 old_string 精确匹配是天然的并发保护）。',
        '',
        '如需"重写"，请：',
        '  1. 先用 Edit 清空你自己会话标注的段',
        '  2. 再用 Edit 追加新内容',
        '  3. 绝不要整文件 Write',
      ].join('\n')
    }
  }));
});
