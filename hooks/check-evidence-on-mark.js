#!/usr/bin/env node
// PostToolUse Hook: 检查标记 [x] 和写验算行时是否有工具调用证据
// 仅处理对 todo/current.md 的 Edit/Write 操作
//
// 检查 1：标记 [x] 时，自上次标记以来必须有非 todo 的工具调用
// 检查 2：写 ✅ 验算通过 时，自最后一个 [x] 以来必须有读取类工具调用
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { return; }

  const filePath = input?.tool_input?.file_path || '';
  const sessionId = input?.session_id || '';
  const toolName = input?.tool_name || '';

  // 只检查对 todo/current.md 的编辑
  if (!filePath.includes('/todo/current.md') && !filePath.includes('\\todo\\current.md')) return;
  if (!sessionId) return;

  // 读证据日志
  const logFile = path.join(os.tmpdir(), `claude-evidence-${sessionId}.jsonl`);
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

  // 检测本次编辑做了什么
  const oldStr = input?.tool_input?.old_string || '';
  const newStr = input?.tool_input?.new_string || '';

  const isMarkingComplete = oldStr.includes('- [ ]') && newStr.includes('- [x]');
  const isWritingVerification = /✅\s*验算通过/.test(newStr) && !/✅\s*验算通过/.test(oldStr);

  // === 检查 1：标记 [x] 时需要有工具调用证据 ===
  if (isMarkingComplete) {
    // 找上一次 [x] 标记事件的时间戳（如果有的话）
    // 使用对 todo/current.md 的 write 类操作作为分隔点
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 1 ? todoEdits[todoEdits.length - 2] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    const recentWork = workEntries.filter(e => e.ts > sinceTs);

    if (recentWork.length === 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            '🚫 标记 [x] 被拒绝：没有找到对应的工具调用证据。',
            '',
            '规则：标记子任务完成前，必须有实际的工具调用（Read/Edit/Write/Bash/Grep 等）来执行该子任务。',
            '纯文字推理不算完成——没有工具调用 = 没有执行 = 不能标记 [x]。',
            '',
            '请先执行该子任务（使用工具），然后再标记 [x]。',
          ].join('\n')
        }
      }));
      return;
    }
  }

  // === 检查 2：写验算通过时需要有读取类工具调用 ===
  if (isWritingVerification) {
    // 找最后一个 [x] 标记的时间（即全部完成之后的时间点）
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 0 ? todoEdits[todoEdits.length - 1] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    // 验算需要有读取类或执行类调用（Read/Grep/Glob/Bash/MCP）
    const verificationEvidence = workEntries.filter(e =>
      e.ts > sinceTs &&
      (e.type === 'read' || e.type === 'exec' || e.type === 'mcp')
    );

    if (verificationEvidence.length === 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            '🚫 写入验算通过被拒绝：没有找到验算的工具调用证据。',
            '',
            '规则：写 "> ✅ 验算通过" 前，必须有读取/执行类工具调用（Read/Grep/Bash 等）作为验算证据。',
            '验算 = 用工具去拿一手数据确认达标标准已满足，不能只凭记忆或推理声称通过。',
            '',
            '请先用工具执行验算，然后再写验算通过。',
          ].join('\n')
        }
      }));
      return;
    }
  }
});
