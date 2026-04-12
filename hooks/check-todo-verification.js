#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后
//   检查全 [x] 段是否有 ✅ 验算通过 → 没有 → deny
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');

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

  // === Phase 1: 检查"全 [x] 但缺验算行"的段 ===
  const lines = content.split('\n');
  const dateHeaderRe = /^## \d{4}-/;
  const uncheckedRe = /^\s*- \[ \]/;
  const checkedRe = /^\s*- \[x\]/;
  const verificationRe = /^>\s*✅\s*验算通过/;

  let currentHeader = '';
  let hasTasks = false;
  let allDone = true;
  let hasVerification = false;
  const missingSections = [];

  function checkSection() {
    if (currentHeader && hasTasks && allDone && !hasVerification) {
      missingSections.push(currentHeader);
    }
  }

  for (const line of lines) {
    if (dateHeaderRe.test(line)) {
      checkSection();
      if (line.includes('归档')) { currentHeader = ''; continue; }
      currentHeader = line;
      hasTasks = false;
      allDone = true;
      hasVerification = false;
      continue;
    }
    if (currentHeader) {
      if (uncheckedRe.test(line)) { hasTasks = true; allDone = false; }
      if (checkedRe.test(line)) { hasTasks = true; }
      if (verificationRe.test(line)) { hasVerification = true; }
    }
  }
  checkSection();

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    const reason = `🚫 以下任务段所有子任务已完成但缺少验算记录。请先执行验算（用与执行不同的路径验证达标标准），然后在该段添加 \`> ✅ 验算通过：{验算方法和结果}\`：\n${list}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    }));
    return;
  }

});
