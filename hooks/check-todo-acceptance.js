#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后检查新任务段是否有达标标准
// 规则：有 ## YYYY- 日期头的段落，紧跟的非空行必须是 > 达标标准：
// 输出 stdout 软警告（不 deny）

const fs = require('fs');
const { runHook } = require('./_hook-runner');

runHook('check-todo-acceptance', 'PostToolUse', (ctx) => {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;

  let content;
  try {
    content = fs.readFileSync(ctx.filePath, 'utf8');
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
    ctx.warn(`${missingSections.length} sections missing acceptance`);
  }
});
