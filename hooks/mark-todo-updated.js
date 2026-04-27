#!/usr/bin/env node
// PostToolUse Hook: 当 todo/current.md 被编辑后，标记本会话已更新 todo

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook } = require('./_hook-runner');

runHook('mark-todo-updated', 'PostToolUse', (ctx) => {
  if ((ctx.filePath.includes('/todo/current.md') || ctx.filePath.includes('\\todo\\current.md')) && ctx.sessionId) {
    const markerFile = path.join(os.tmpdir(), `claude-todo-updated-${ctx.sessionId}`);
    fs.writeFileSync(markerFile, '');
  }
});
