#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后检查新任务段是否有达标标准
// 规则：有 ## YYYY- 日期头的段落，紧跟的非空行必须是 > 达标标准：
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';

  if (!filePath.includes('/todo/current.md') && !filePath.includes('\\todo\\current.md')) {
    return;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return;
  }

  const lines = content.split('\n');
  const dateHeaderRe = /^## \d{4}-/;
  const acceptanceRe = /^>\s*达标标准/;
  const verificationRe = /^>\s*✅/;

  let foundHeader = false;
  let currentHeader = '';
  const missingSections = [];

  for (const line of lines) {
    if (dateHeaderRe.test(line)) {
      if (line.includes('归档')) {
        foundHeader = false;
        continue;
      }
      foundHeader = true;
      currentHeader = line;
      continue;
    }

    if (foundHeader) {
      if (line.trim() === '') continue;
      if (acceptanceRe.test(line) || verificationRe.test(line)) {
        foundHeader = false;
      } else {
        missingSections.push(currentHeader);
        foundHeader = false;
      }
    }
  }

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    process.stdout.write(`⚠️ 以下任务段缺少达标标准，请在日期头下方添加 \`> 达标标准：...\`：\n${list}`);
  }
});
