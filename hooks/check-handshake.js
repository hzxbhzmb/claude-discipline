#!/usr/bin/env node
// PreToolUse Hook: 强制任务三次握手完成后才能编辑非白名单文件
// 类比 TCP 三次握手：用户发意图 → AI 回传理解与计划 → 用户确认执行授权
// 未完成握手（本会话最新任务段无 "> ✅ 执行授权"）→ 系统级阻断
//
// 多会话：只检查带本会话 session 标注的任务段
//   - 本会话还没建任何标注段 → 拒绝，提示 AI 建段时标 session
//   - 祖传段（无标注）完全不看

const fs = require('fs');
const path = require('path');
const { runHook, isInProject, isWhitelisted, denyPre } = require('./_hook-runner');
const { ownedSections, shortId } = require('./_session-util');

runHook('check-handshake', 'PreToolUse', (ctx) => {
  if (!ctx.filePath) return;
  if (!ctx.projectDir) return;
  if (!isInProject(ctx.filePath, ctx.projectDir)) return;
  if (isWhitelisted(ctx.filePath)) return;

  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    return; // todo 不存在时不阻断（init 还没跑）
  }

  const sid = shortId(ctx.sessionId);
  const mine = sid ? ownedSections(content, ctx.sessionId) : [];

  if (mine.length === 0) {
    const reason = [
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
    ].join('\n');
    process.stdout.write(denyPre(reason));
    ctx.deny('no session-tagged section');
    return;
  }

  const latest = mine[mine.length - 1];
  const sectionText = [latest.header, ...latest.bodyLines].join('\n');
  const hasAuthorization = /^>\s*✅\s*执行授权/m.test(sectionText);

  if (!hasAuthorization) {
    const reason = [
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
    ].join('\n');
    process.stdout.write(denyPre(reason));
    ctx.deny('no execution authorization');
  }
});
