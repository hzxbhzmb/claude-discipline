#!/usr/bin/env node
// PreToolUse Hook: 写入 methodology 详情文件时，检查 _index.md 是否已在本会话中更新

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook, denyPre } = require('./_hook-runner');

runHook('check-methodology-index', 'PreToolUse', (ctx) => {
  if (!ctx.filePath) return;

  // 确保 methodology/_index.md 存在（全局安装时项目可能还没初始化）
  if (ctx.projectDir) {
    const methodologyDir = path.join(ctx.projectDir, 'methodology');
    const indexFile = path.join(methodologyDir, '_index.md');
    if (!fs.existsSync(indexFile)) {
      fs.mkdirSync(methodologyDir, { recursive: true });
      fs.writeFileSync(indexFile, `# 方法论\n\n任务开始前按场景查阅相关分类，按需深入详情文件。\n\n<!-- 按项目实际积累的经验添加分类，以下为示例 -->\n<!-- 每个分类一个子目录，详情文件放在子目录中 -->\n<!-- 当某分类超过 5 个文件时，为该分类添加 _index.md 二级索引 -->\n`);
    }
  }

  // 只拦截 methodology/ 下的详情文件（非 _index.md 本身）
  const inMethodologySubdir = (ctx.filePath.includes('/methodology/') || ctx.filePath.includes('\\methodology\\'))
    && ctx.filePath.split(/[/\\]methodology[/\\]/)[1]?.includes(path.sep === '\\' ? '\\' : '/');
  const isIndex = ctx.filePath.endsWith('_index.md');

  if (inMethodologySubdir && !isIndex) {
    const markerFile = path.join(os.tmpdir(), `claude-methodology-index-updated-${ctx.sessionId}`);
    if (!fs.existsSync(markerFile)) {
      process.stdout.write(denyPre('⚠️ 你还没有更新 methodology/_index.md！写入方法论详情文件前，必须先更新索引文件 methodology/_index.md，确保新条目被索引。'));
      ctx.deny('methodology _index not updated');
    }
  }
});
