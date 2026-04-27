#!/usr/bin/env node
// PostToolUse Hook: 检查标记 [x] 和写验算行时是否有工具调用证据
// 仅处理对 todo/current.md 的 Edit/Write 操作
//
// 检查 1：标记 [x] 时，自上次标记以来必须有非 todo 的工具调用
// 检查 1b：标记 [x] 时，若子任务含 "research/" 则必须有对 research/ 的写入
// 检查 2：写 ✅ 验算通过 时，自最后一个 [x] 以来必须有读取类工具调用

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook, denyPost } = require('./_hook-runner');

runHook('check-evidence-on-mark', 'PostToolUse', (ctx) => {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;
  if (!ctx.sessionId) return;

  // 读证据日志
  const logFile = path.join(os.tmpdir(), `claude-evidence-${ctx.sessionId}.jsonl`);
  let entries = [];
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    entries = content.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    // 日志不存在 = 无证据
  }

  // 过滤掉对 todo/current.md 自身的操作（标记 [x] 本身不算工作证据）
  const workEntries = entries.filter(e =>
    !e.target.includes('/todo/') &&
    !e.target.includes('\\todo\\') &&
    !e.target.includes('/methodology/_index') &&
    !e.target.includes('\\methodology\\_index')
  );

  const oldStr = ctx.oldString;
  const newStr = ctx.newString;

  const isMarkingComplete = oldStr.includes('- [ ]') && newStr.includes('- [x]');
  const isWritingVerification = /✅\s*验算通过/.test(newStr) && !/✅\s*验算通过/.test(oldStr);

  // === 检查 1：标记 [x] 时需要有工具调用证据 ===
  if (isMarkingComplete) {
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 1 ? todoEdits[todoEdits.length - 2] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    const recentWork = workEntries.filter(e => e.ts > sinceTs);

    if (recentWork.length === 0) {
      const reason = [
        '🚫 标记 [x] 被拒绝：没有找到对应的工具调用证据。',
        '',
        '规则：标记子任务完成前，必须有实际的工具调用（Read/Edit/Write/Bash/Grep 等）来执行该子任务。',
        '纯文字推理不算完成——没有工具调用 = 没有执行 = 不能标记 [x]。',
        '',
        '请先执行该子任务（使用工具），然后再标记 [x]。',
      ].join('\n');
      process.stdout.write(denyPost(reason));
      ctx.deny('mark [x] without tool-call evidence');
      return;
    }

    // === 检查 1b：研究类子任务必须有对 research/ 的写入 ===
    if (newStr.includes('research/')) {
      const researchWrites = recentWork.filter(e =>
        e.type === 'write' &&
        (e.target.includes('/research/') || e.target.includes('\\research\\'))
      );
      if (researchWrites.length === 0) {
        const reason = [
          '🚫 标记 [x] 被拒绝：子任务要求写入 research/ 但未检测到对 research/ 目录的写入操作。',
          '',
          '规则：子任务中包含 "research/" 时，必须有对 research/ 目录的 Write/Edit 操作才能标记完成。',
          '研究产出必须落地为文件，不能只在对话中输出。',
          '',
          '请先将研究产出写入 research/ 目录下的 .md 文件，然后再标记 [x]。',
        ].join('\n');
        process.stdout.write(denyPost(reason));
        ctx.deny('research subtask without research/ write');
        return;
      }
    }
  }

  // === 检查 2：写验算通过时需要有读取类工具调用 ===
  if (isWritingVerification) {
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 0 ? todoEdits[todoEdits.length - 1] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    const verificationEvidence = workEntries.filter(e =>
      e.ts > sinceTs &&
      (e.type === 'read' || e.type === 'exec' || e.type === 'mcp')
    );

    if (verificationEvidence.length === 0) {
      const reason = [
        '🚫 写入验算通过被拒绝：没有找到验算的工具调用证据。',
        '',
        '规则：写 "> ✅ 验算通过" 前，必须有读取/执行类工具调用（Read/Grep/Bash 等）作为验算证据。',
        '验算 = 用工具去拿一手数据确认达标标准已满足，不能只凭记忆或推理声称通过。',
        '',
        '请先用工具执行验算，然后再写验算通过。',
      ].join('\n');
      process.stdout.write(denyPost(reason));
      ctx.deny('verification without read/exec evidence');
      return;
    }
  }
});
