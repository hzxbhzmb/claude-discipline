#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后检查行数
//   - ≤80 行：静默
//   - 80 < n ≤ 200：stdout 软警告（不阻塞）
//   - > 200 行：返回 deny JSON，硬阻断下一次编辑——强制先归档再继续
//
// 200 行硬线可通过 env DISCIPLINE_TODO_HARD_LIMIT=N 覆盖
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');

const HARD_LIMIT = parseInt(process.env.DISCIPLINE_TODO_HARD_LIMIT, 10) || 200;
const SOFT_LIMIT = 80;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';

  if (!(filePath.includes('/todo/current.md') || filePath.includes('\\todo\\current.md'))) {
    return;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return;
  }
  const lineCount = content.split('\n').length;

  if (lineCount > HARD_LIMIT) {
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `🛑 todo/current.md 已 ${lineCount} 行，超硬线 ${HARD_LIMIT}。下次 Edit/Write 已被阻断——必须先归档。\n` +
          `\n` +
          `操作步骤：\n` +
          `1. 选出"已完成段"（所有 \`- [ ]\` 已勾、含 \`> ✅ 验算通过\` 或 \`> ❌ 最终验算失败\` 或 \`> ✅ 完成\`）\n` +
          `2. 将段整段（标题+正文）追加到 \`todo/archive/YYYY-MM.md\`（按段标题日期所属月份）\n` +
          `3. 从 current.md 删除该段\n` +
          `4. 重新尝试你刚才的编辑\n` +
          `\n` +
          `提示：下次会话启动时 auto-archive 钩子会自动搬走已完成段；本次是当前会话内累积过多触发。`,
      },
    };
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (lineCount > SOFT_LIMIT) {
    process.stdout.write(
      `⚠️ todo/current.md 已有 ${lineCount} 行（软警告：>${SOFT_LIMIT}；硬线：${HARD_LIMIT}）。` +
      `请尽快将已完成章节归档到 todo/archive/。`
    );
  }
});
