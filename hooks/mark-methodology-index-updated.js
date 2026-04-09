#!/usr/bin/env node
// PostToolUse Hook: 当 methodology/_index.md 被编辑后，标记本会话已更新索引
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

  if ((filePath.endsWith('/methodology/_index.md') || filePath.endsWith('\\methodology\\_index.md')) && sessionId) {
    const markerFile = path.join(os.tmpdir(), `claude-methodology-index-updated-${sessionId}`);
    fs.writeFileSync(markerFile, '');
  }
});
