#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后
//   检查"本会话"全 [x] 段是否有 ✅ 验算通过 → 没有 → deny
//
// 多会话：只扫带本会话 session 标注的段——
//   - 祖传无标注段：跳过（不连坐）
//   - 他会话段：跳过（不替别人负责）

const fs = require('fs');
const { runHook, denyPost } = require('./_hook-runner');
const { ownedSections } = require('./_session-util');

runHook('check-todo-verification', 'PostToolUse', (ctx) => {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;
  if (!ctx.sessionId) return;

  let content;
  try {
    content = fs.readFileSync(ctx.filePath, 'utf8');
  } catch (e) {
    return;
  }

  const uncheckedRe = /^\s*- \[ \]/m;
  const checkedRe = /^\s*- \[x\]/m;
  const verificationRe = /^>\s*✅\s*验算通过/m;

  const missingSections = [];
  for (const sec of ownedSections(content, ctx.sessionId)) {
    const body = sec.bodyLines.join('\n');
    const hasUnchecked = uncheckedRe.test(body);
    const hasChecked = checkedRe.test(body);
    const hasVerification = verificationRe.test(body);
    if (hasChecked && !hasUnchecked && !hasVerification) {
      missingSections.push(sec.header);
    }
  }

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    const reason = `🚫 以下任务段所有子任务已完成但缺少验算记录。请先执行验算（用与执行不同的路径验证达标标准），然后在该段添加 \`> ✅ 验算通过：{验算方法和结果}\`：\n${list}`;
    process.stdout.write(denyPost(reason));
    ctx.deny(`${missingSections.length} sections missing verification`);
  }
});
