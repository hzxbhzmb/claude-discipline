#!/usr/bin/env node
// PostToolUse Hook: 当 todo/current.md 被编辑后，标记本会话已更新 todo
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';
  const sessionId = input?.session_id || '';

  if ((filePath.includes('/todo/current.md') || filePath.includes('\\todo\\current.md')) && sessionId) {
    const markerFile = path.join(os.tmpdir(), `claude-todo-updated-${sessionId}`);
    fs.writeFileSync(markerFile, '');
  }
});
