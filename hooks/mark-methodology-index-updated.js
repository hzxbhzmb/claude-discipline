#!/usr/bin/env node
// PostToolUse Hook: 当 methodology/_index.md 被编辑后，标记本会话已更新索引

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook } = require('./_hook-runner');

runHook('mark-methodology-index-updated', 'PostToolUse', (ctx) => {
  if ((ctx.filePath.endsWith('/methodology/_index.md') || ctx.filePath.endsWith('\\methodology\\_index.md')) && ctx.sessionId) {
    const markerFile = path.join(os.tmpdir(), `claude-methodology-index-updated-${ctx.sessionId}`);
    fs.writeFileSync(markerFile, '');
  }
});
