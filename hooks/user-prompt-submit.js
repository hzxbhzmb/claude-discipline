#!/usr/bin/env node
// UserPromptSubmit Hook（v3.1.0+）
//
// 每次用户提交新消息时触发，主动 inject 一段 reminder 到 AI 的 system prompt。
// 用于强化遵守——v3.0.x 暴露的问题：hook 是被动反应式，AI 用只读工具+对话输出可以
// 完全绕过 discipline。v3.1.0 通过 UserPromptSubmit 在每条用户消息进入 AI 视野前
// 主动注入"你必须先建段 + 握手"提示，让 AI 第一眼就看到强制约束。
//
// 智能跳过（不打扰执行中的 AI）：
//   - 已建带 session 标注的段 + 段含 ✅ 执行授权 + 段未收尾（含 [ ] 或无 ✅ 验算通过）
//     → 不 inject（AI 在执行中，规则它已遵守）
//   - 用户消息含 BYPASS 关键字（"bypass" / "紧急" / "忽略 discipline"）→ 不 inject
//   - todo/current.md 不存在 → 不 inject（init 还没跑）
//   - CLAUDE_DISCIPLINE_BYPASS=1 env → runHook 框架自动短路
//
// 输出格式：
//   stdout JSON: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
//                                         additionalContext: '...' } }
//   或 fallback：直接 stdout 文本（Claude Code 也会把 stdout 当 context 注入）

const fs = require('fs');
const path = require('path');
const { runHook } = require('./_hook-runner');
const { ownedSections, shortId } = require('./_session-util');

runHook('user-prompt-submit', 'UserPromptSubmit', (ctx) => {
  if (!ctx.projectDir) return;

  // UserPromptSubmit 的 input 字段不同：用户消息在 input.prompt
  const userMsg = String(ctx.input?.prompt || '');

  // 用户显式 bypass 措辞 → 不打扰
  if (/\bbypass\b/i.test(userMsg) ||
      /忽略\s*(discipline|纪律)/i.test(userMsg) ||
      userMsg.includes('紧急')) {
    return;
  }

  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    return; // todo 不存在不 inject
  }

  const sid = shortId(ctx.sessionId);
  if (!sid) return;

  const mine = ownedSections(content, ctx.sessionId);

  // 状态判定 + reminder 文本
  const reminder = computeReminder(mine, sid);
  if (!reminder) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
    },
  }));
  ctx.warn(reminder.slice(0, 60));
});

function computeReminder(mine, sid) {
  // 1. 未建本会话段
  if (mine.length === 0) {
    return [
      '🚨 [claude-discipline] BLOCKING：你必须先用 Edit 工具编辑 todo/current.md 末尾',
      `追加任务段（带本会话标注 \`<!-- session: ${sid} -->\`），完成三次握手后才能执行任何写操作。`,
      '',
      '建段模板：',
      '```',
      `## YYYY-MM-DD — 任务简述 <!-- session: ${sid} -->`,
      '',
      '**用户意图**：（忠实记录用户原话）',
      '',
      '**AI 理解**：目标 / 边界 / 路径 / 风险 / **验算方案**（反向路径，与执行不同）',
      '',
      '> 🤝 待用户确认',
      '```',
      '',
      'todo/current.md 在白名单内，可直接 Edit。**不要**先做 Read/Grep/Glob 研究——',
      '那是事后补账。**不要**在对话里输出研究结论——研究产出必须写入 research/ 目录。',
      '',
      '极轻量任务（单条命令、单文件 ≤10 行）可走快车道：单行 `> ✅ 执行授权：[快车道] {说明}`。',
    ].join('\n');
  }

  const latest = mine[mine.length - 1];
  const body = latest.bodyLines.join('\n');
  const hasAuth = /^>\s*✅\s*执行授权/m.test(body);
  const hasUnchecked = /^\s*- \[ \]/m.test(body);
  const hasChecked = /^\s*- \[x\]/m.test(body);
  const hasVerification = /^>\s*✅\s*验算通过/m.test(body);
  const hasFinalFail = /^>\s*❌\s*最终验算失败/m.test(body);
  const hasFastlaneDone = /^>\s*✅\s*完成/m.test(body);

  // 2. 建段但无授权 → 等握手完成
  if (!hasAuth) {
    return [
      '🚨 [claude-discipline] BLOCKING：当前任务段已建但还没拿到 `> ✅ 执行授权`。',
      `当前段：${latest.header}`,
      '',
      '请在对话中向用户回声你的 **AI 理解**（目标/边界/路径/风险/验算方案），',
      '等用户确认后再 Edit todo/current.md 写入 `> ✅ 执行授权：{用户确认要点}`。',
      '握手完成前不要执行任何写操作（hook 会硬拦）。',
    ].join('\n');
  }

  // 3. 段已收尾（验算通过 / 最终失败 / 快车道完成）→ 新任务建新段
  const sealed = hasVerification || hasFinalFail || hasFastlaneDone;
  if (sealed) {
    return [
      '🚨 [claude-discipline] 提醒：你最近的任务段已收尾（含 ✅ 验算通过 / ❌ 最终验算失败 / ✅ 完成 标记）。',
      `已收尾段：${latest.header}`,
      '',
      '如果这条用户消息是新任务，请用 Edit 在 todo/current.md 末尾**追加新任务段**，',
      `标题带本会话标注 \`<!-- session: ${sid} -->\`，走完整三次握手再开干。`,
      '不要在已收尾段里继续追加子任务——那会让段状态不一致。',
    ].join('\n');
  }

  // 4. 段已授权且未收尾 → AI 在执行中，不打扰
  return null;
}

module.exports = { computeReminder };
