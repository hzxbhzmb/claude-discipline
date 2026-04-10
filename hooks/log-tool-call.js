#!/usr/bin/env node
// PostToolUse Hook: 记录每次工具调用到会话证据日志
// 匹配所有工具（matcher: ".*"）
// 日志文件：/tmp/claude-evidence-${sessionId}.jsonl
// 用途：为 check-evidence-on-mark.js 提供"执行者是否真的做了事"的硬证据
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { process.exit(0); }

  const sessionId = input?.session_id || '';
  if (!sessionId) process.exit(0);

  const toolName = input?.tool_name || '';
  if (!toolName) process.exit(0);

  // 分类工具调用类型
  const toolInput = input?.tool_input || {};
  let target = '';
  let callType = 'other';

  if (['Read', 'Grep', 'Glob'].includes(toolName)) {
    callType = 'read';
    target = toolInput.file_path || toolInput.path || toolInput.pattern || '';
  } else if (['Edit', 'Write'].includes(toolName)) {
    callType = 'write';
    target = toolInput.file_path || '';
  } else if (toolName === 'Bash') {
    callType = 'exec';
    target = (toolInput.command || '').slice(0, 200);
  } else if (toolName.startsWith('mcp__')) {
    callType = 'mcp';
    // MCP 工具：记录完整 tool name 作为 target
    target = toolName;
  } else {
    // Agent, WebFetch, WebSearch, 等
    callType = 'other';
    target = toolName;
  }

  // 不记录对证据日志自身的操作（防递归）
  if (target.includes('claude-evidence-')) process.exit(0);

  const entry = {
    ts: Date.now(),
    tool: toolName,
    target,
    type: callType,
  };

  const logFile = path.join(os.tmpdir(), `claude-evidence-${sessionId}.jsonl`);
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (e) {
    // 写失败不阻断工作流
    process.stderr.write(`⚠️ 证据日志写入失败: ${e.message}\n`);
  }
});
