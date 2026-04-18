#!/usr/bin/env node
// PreToolUse Hook: 强制任务三次握手完成后才能编辑非白名单文件
// 类比 TCP 三次握手：用户发意图 → AI 回传理解与计划 → 用户确认执行授权
// 未完成握手（本会话最新任务段无 "> ✅ 执行授权"）→ 系统级阻断
//
// 多会话：只检查带本会话 session 标注的任务段
//   - 本会话还没建任何标注段 → 拒绝，提示 AI 建段时标 session
//   - 祖传段（无标注）完全不看
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const { ownedSections, shortId } = require('./_session-util');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { process.exit(0); }

  const filePath = input?.tool_input?.file_path || '';
  const sessionId = input?.session_id || '';
  if (!filePath) process.exit(0);

  // 项目目录外的路径 → discipline 作用域之外，直接豁免
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) process.exit(0);
  try {
    const absFile = path.resolve(filePath);
    const absProject = path.resolve(projectDir);
    const rel = path.relative(absProject, absFile);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
  } catch (e) { /* fallthrough */ }

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

  const todoFile = path.join(projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    process.exit(0); // todo 不存在时不阻断（init 还没跑）
  }

  const sid = shortId(sessionId);
  const mine = sid ? ownedSections(content, sessionId) : [];

  // 本会话一个标注段都没有 → 拒绝，提示必须建带 session 标注的段
  if (mine.length === 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '🚫 本会话还没有建任务段（或你建的任务段没带 session 标注）。',
          '',
          `你的会话 sessionId 短 ID：${sid || '(未知)'}`,
          '',
          '请在 todo/current.md 末尾新建任务段，标题必须带 session 标注：',
          '',
          '```',
          `## YYYY-MM-DD — 任务简述 <!-- session: ${sid} -->`,
          '```',
          '',
          '然后按三次握手写 **AI 理解** → 向用户确认 → 写 `> ✅ 执行授权`。',
          'hook 只检查带你这个 session 标注的任务段，祖传段不算。',
        ].join('\n')
      }
    }));
    return;
  }

  // 本会话最新任务段是否有执行授权？
  const latest = mine[mine.length - 1];
  const sectionText = [latest.header, ...latest.bodyLines].join('\n');
  const hasAuthorization = /^>\s*✅\s*执行授权/m.test(sectionText);

  if (!hasAuthorization) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '🚫 任务三次握手未完成，不能开始执行。',
          '',
          `当前任务段：${latest.header}`,
          '',
          '三次握手协议：',
          '  1️⃣  用户发起任务（已完成）',
          '  2️⃣  AI 回传理解与计划 → 写入 todo 的 **AI 理解** 段',
          '  3️⃣  用户确认执行 → AI 记录 `> ✅ 执行授权：...`',
          '',
          '请先在 todo/current.md 当前任务段中：',
          '  1. 写出你的 **AI 理解**（目标、边界、路径、风险、验算方案）',
          '  2. 向用户确认你的理解是否正确',
          '  3. 用户确认后，写入 `> ✅ 执行授权：{用户确认要点}`',
          '',
          '只有握手完成后才能编辑项目文件。',
        ].join('\n')
      }
    }));
  }
});
