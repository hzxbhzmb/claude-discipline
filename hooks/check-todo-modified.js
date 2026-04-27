#!/usr/bin/env node
// PreToolUse Hook: 强制先更新 todo/current.md 再修改代码

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runHook, isInProject, isWhitelisted, denyPre } = require('./_hook-runner');

runHook('check-todo-modified', 'PreToolUse', (ctx) => {
  if (!ctx.filePath) return;
  if (ctx.projectDir && !isInProject(ctx.filePath, ctx.projectDir)) return;
  if (isWhitelisted(ctx.filePath)) return;

  // 确保 todo/current.md 存在（全局安装时项目可能还没初始化）
  if (ctx.projectDir) {
    const todoDir = path.join(ctx.projectDir, 'todo');
    const todoFile = path.join(todoDir, 'current.md');
    if (!fs.existsSync(todoFile)) {
      fs.mkdirSync(path.join(todoDir, 'archive'), { recursive: true });
      fs.writeFileSync(todoFile, `# 任务计划\n\n## 归档说明\n\n已完成任务按月归档到 \`todo/archive/\` 目录。\n\n---\n\n`);
    }
  }

  // 检查 todo/current.md 是否在本会话中被修改过
  const markerFile = path.join(os.tmpdir(), `claude-todo-updated-${ctx.sessionId}`);

  if (!fs.existsSync(markerFile)) {
    process.stdout.write(denyPre('⚠️ 你还没有更新 todo/current.md！按照项目规则，必须先在 todo/current.md 中写入任务计划和子任务拆解，然后才能修改代码文件。请先读取并更新 todo/current.md。'));
    ctx.deny('todo not updated this session');
  }
});
