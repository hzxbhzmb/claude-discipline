#!/usr/bin/env node
// PreToolUse Hook: 强制任务三次握手完成后才能编辑非白名单文件
// 类比 TCP 三次握手：用户发意图 → AI 回传理解与计划 → 用户确认执行授权
// 未完成握手（当前任务段无 "> ✅ 执行授权"）→ 系统级阻断
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { process.exit(0); }

  const filePath = input?.tool_input?.file_path || '';
  if (!filePath) process.exit(0);

  // 白名单：与 check-todo-modified.js 一致 + 允许编辑 todo/methodology 等
  const whiteList = [
    p => p.includes('/todo/current.md') || p.includes('\\todo\\current.md'),
    p => p.includes('/todo/archive/') || p.includes('\\todo\\archive\\'),
    p => p.includes('/CLAUDE.md') || p.includes('\\CLAUDE.md'),
    p => p.includes('/MEMORY.md') || p.includes('\\MEMORY.md'),
    p => p.includes('/methodology/') || p.includes('\\methodology\\'),
    p => p.includes('/research/') || p.includes('\\research\\'),
    p => p.includes('/.claude/') || p.includes('\\.claude\\'),
  ];

  if (whiteList.some(check => check(filePath))) process.exit(0);

  // 读 todo/current.md
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const todoFile = path.join(projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    process.exit(0); // todo 不存在时不阻断（init 还没跑）
  }

  // 找到最新的（最后一个）任务段
  const lines = content.split('\n');
  let lastSectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \d{4}-/.test(lines[i]) && !lines[i].includes('归档')) {
      lastSectionStart = i;
    }
  }

  if (lastSectionStart === -1) process.exit(0); // 无任务段

  // 检查该段是否有执行授权标记
  const sectionText = lines.slice(lastSectionStart).join('\n');
  const hasAuthorization = /^>\s*✅\s*执行授权/m.test(sectionText);

  if (!hasAuthorization) {
    const sectionHeader = lines[lastSectionStart];
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '🚫 任务三次握手未完成，不能开始执行。',
          '',
          `当前任务段：${sectionHeader}`,
          '',
          '三次握手协议：',
          '  1️⃣  用户发起任务（已完成）',
          '  2️⃣  AI 回传理解与计划 → 写入 todo 的 **AI 理解** 段',
          '  3️⃣  用户确认执行 → AI 记录 `> ✅ 执行授权：...`',
          '',
          '请先在 todo/current.md 当前任务段中：',
          '  1. 写出你的 **AI 理解**（目标、边界、路径、风险）',
          '  2. 向用户确认你的理解是否正确',
          '  3. 用户确认后，写入 `> ✅ 执行授权：{用户确认要点}`',
          '',
          '只有握手完成后才能编辑项目文件。',
        ].join('\n')
      }
    }));
  }
});
