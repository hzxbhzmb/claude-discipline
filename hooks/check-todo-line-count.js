#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后检查行数，超 80 行时提醒归档
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';

  if (filePath.includes('/todo/current.md') || filePath.includes('\\todo\\current.md')) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lineCount = content.split('\n').length;
      if (lineCount > 80) {
        process.stdout.write(`⚠️ todo/current.md 已有 ${lineCount} 行（超过 80 行上限）。请将已完成章节归档到 todo/archive/ 后再继续。`);
      }
    } catch (e) {
      // 文件不存在则忽略
    }
  }
});
