#!/usr/bin/env node
// PostToolUse Hook: 记录每次工具调用到会话证据日志
// 匹配所有工具（matcher: ".*"）
// 日志文件：/tmp/claude-evidence-${sessionId}.jsonl
// 用途：为 check-evidence-on-mark.js 提供"执行者是否真的做了事"的硬证据

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook } = require('./_hook-runner');

runHook('log-tool-call', 'PostToolUse', (ctx) => {
  if (!ctx.sessionId) return;
  if (!ctx.toolName) return;

  // 分类工具调用类型
  const toolInput = ctx.input?.tool_input || {};
  let target = '';
  let callType = 'other';

  if (['Read', 'Grep', 'Glob'].includes(ctx.toolName)) {
    callType = 'read';
    target = toolInput.file_path || toolInput.path || toolInput.pattern || '';
  } else if (['Edit', 'Write'].includes(ctx.toolName)) {
    callType = 'write';
    target = toolInput.file_path || '';
  } else if (ctx.toolName === 'Bash') {
    callType = 'exec';
    target = (toolInput.command || '').slice(0, 200);
  } else if (ctx.toolName.startsWith('mcp__')) {
    callType = 'mcp';
    target = ctx.toolName;
  } else {
    callType = 'other';
    target = ctx.toolName;
  }

  // 不记录对证据日志自身的操作（防递归）
  if (target.includes('claude-evidence-')) return;

  const entry = {
    ts: Date.now(),
    tool: ctx.toolName,
    target,
    type: callType,
  };

  const logFile = path.join(os.tmpdir(), `claude-evidence-${ctx.sessionId}.jsonl`);
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`⚠️ 证据日志写入失败: ${e.message}\n`);
  }
});
