#!/usr/bin/env node
// SessionStart Hook: 初始化项目目录 + 注入纪律规则
const fs = require('fs');
const path = require('path');
const os = require('os');

const projectDir = process.env.CLAUDE_PROJECT_DIR;
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

if (!projectDir) process.exit(0);

// 1. 初始化 todo/ 目录
const todoDir = path.join(projectDir, 'todo');
const todoFile = path.join(todoDir, 'current.md');
if (!fs.existsSync(todoFile)) {
  fs.mkdirSync(path.join(todoDir, 'archive'), { recursive: true });
  fs.writeFileSync(todoFile, [
    '# 任务计划',
    '',
    '## 归档说明',
    '',
    '已完成任务按月归档到 `todo/archive/` 目录。',
    '',
    '---',
    '',
  ].join('\n'));
  process.stderr.write('✓ 已创建 todo/current.md\n');
}

// 2. 初始化 methodology/ 目录
const methodologyDir = path.join(projectDir, 'methodology');
const indexFile = path.join(methodologyDir, '_index.md');
if (!fs.existsSync(indexFile)) {
  fs.mkdirSync(methodologyDir, { recursive: true });
  fs.writeFileSync(indexFile, [
    '# 方法论',
    '',
    '任务开始前按场景查阅相关分类，按需深入详情文件。',
    '',
    '<!-- 按项目实际积累的经验添加分类，以下为示例 -->',
    '<!-- 每个分类一个子目录，详情文件放在子目录中 -->',
    '<!-- 当某分类超过 5 个文件时，为该分类添加 _index.md 二级索引 -->',
    '',
  ].join('\n'));
  process.stderr.write('✓ 已创建 methodology/_index.md\n');
}

// 3. 清空上一次会话的证据日志（如果有 session_id 的话）
//    证据日志在 /tmp/claude-evidence-${sessionId}.jsonl
//    SessionStart 时 session_id 可能还不可用，所以这里用 glob 清理旧文件
try {
  const tmpDir = os.tmpdir();
  const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('claude-evidence-'));
  for (const f of files) {
    try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) {}
  }
} catch (e) {}

// 4. 注入纪律规则到会话上下文
const rulesFile = path.join(pluginRoot, 'rules', 'discipline.md');
try {
  const rules = fs.readFileSync(rulesFile, 'utf8');
  process.stdout.write(rules);
} catch (e) {
  process.stderr.write(`⚠️ 无法读取纪律规则: ${rulesFile}\n`);
}
