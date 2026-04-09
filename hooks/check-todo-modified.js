#!/usr/bin/env node
// PreToolUse Hook: 强制先更新 todo/current.md 再修改代码
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';
  const sessionId = input?.session_id || '';

  if (!filePath) process.exit(0);

  // 白名单：允许编辑的文件/目录
  const whiteList = [
    p => p.includes('/todo/current.md') || p.includes('\\todo\\current.md'),
    p => p.includes('/CLAUDE.md') || p.includes('\\CLAUDE.md'),
    p => p.includes('/MEMORY.md') || p.includes('\\MEMORY.md'),
    p => p.includes('/methodology/') || p.includes('\\methodology\\'),
    p => p.includes('/todo/archive/') || p.includes('\\todo\\archive\\'),
    p => p.includes('/research/') || p.includes('\\research\\'),
    p => p.includes('/.claude/') || p.includes('\\.claude\\'),
  ];

  if (whiteList.some(check => check(filePath))) process.exit(0);

  // 确保 todo/current.md 存在（全局安装时项目可能还没初始化）
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const todoDir = path.join(projectDir, 'todo');
    const todoFile = path.join(todoDir, 'current.md');
    if (!fs.existsSync(todoFile)) {
      fs.mkdirSync(path.join(todoDir, 'archive'), { recursive: true });
      fs.writeFileSync(todoFile, `# 任务计划\n\n## 归档说明\n\n已完成任务按月归档到 \`todo/archive/\` 目录。\n\n---\n\n`);
    }
  }

  // 检查 todo/current.md 是否在本会话中被修改过
  const os = require('os');
  const markerFile = path.join(os.tmpdir(), `claude-todo-updated-${sessionId}`);

  if (!fs.existsSync(markerFile)) {
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '⚠️ 你还没有更新 todo/current.md！按照项目规则，必须先在 todo/current.md 中写入任务计划和子任务拆解，然后才能修改代码文件。请先读取并更新 todo/current.md。'
      }
    };
    process.stdout.write(JSON.stringify(result));
  }
});
