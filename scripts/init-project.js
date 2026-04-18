#!/usr/bin/env node
// SessionStart Hook: 初始化项目目录 + 注入纪律规则 + 注入本会话 sessionId
//
// 多会话安全：
//   - 从 stdin 读 session_id，**只清自己** 的证据日志（其它会话的不碰）
//   - 无 session_id 时，按 mtime 清 >24h 的陈旧日志（绝不无差别全删）
//   - 把 sessionId 短 ID 注入 stdout，规则会告诉 AI 建任务段时带 `<!-- session: xxxxxxxx -->`
const fs = require('fs');
const path = require('path');
const os = require('os');
const { tryAdoptLegacySection } = require(path.join(__dirname, '..', 'hooks', '_session-util.js'));

const projectDir = process.env.CLAUDE_PROJECT_DIR;
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

if (!projectDir) process.exit(0);

function main(sessionId) {
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

  // 3. 清理证据日志——多会话安全策略
  //    - 有 sessionId：只清自己的（重新开始）
  //    - 无 sessionId：按 mtime 清 >24h 陈旧日志；别碰 <24h 的（它们可能属于活跃的并发会话）
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('claude-evidence-'));
    const now = Date.now();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    for (const f of files) {
      const full = path.join(tmpDir, f);
      try {
        if (sessionId && f === `claude-evidence-${sessionId}.jsonl`) {
          fs.unlinkSync(full);
        } else if (!sessionId) {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > MAX_AGE_MS) fs.unlinkSync(full);
        }
        // 有 sessionId 但不是自己 → 不动
      } catch (e) {}
    }
  } catch (e) {}

  // 4. 注入纪律规则 + 本会话 sessionId
  const rulesFile = path.join(pluginRoot, 'rules', 'discipline.md');
  try {
    const rules = fs.readFileSync(rulesFile, 'utf8');
    process.stdout.write(rules);
  } catch (e) {
    process.stderr.write(`⚠️ 无法读取纪律规则: ${rulesFile}\n`);
  }

  if (sessionId) {
    const shortId = sessionId.slice(0, 8);

    // 5. 升级零摩擦：尝试认领一个进行中的祖传段到本会话
    //    条件：非归档 + 无 session 标注 + 含至少一个 [ ]
    //    多候选取最近（文件中最后）那个
    let adoptedHeader = null;
    try {
      if (fs.existsSync(todoFile)) {
        const content = fs.readFileSync(todoFile, 'utf8');
        const result = tryAdoptLegacySection(content, sessionId);
        if (result.adoptedHeader) {
          fs.writeFileSync(todoFile, result.content);
          adoptedHeader = result.adoptedHeader;
        }
      }
    } catch (e) {
      process.stderr.write(`⚠️ 自动认领祖传段失败: ${e.message}\n`);
    }

    process.stdout.write([
      '',
      '---',
      '',
      '## 本会话身份',
      '',
      `**你当前会话的 sessionId 短 ID**：\`${shortId}\``,
      '',
      '**创建新任务段时，标题末尾必须带 session 标注**，否则 hook 会直接拒绝你后续的编辑：',
      '',
      '```markdown',
      `## YYYY-MM-DD — 任务简述 <!-- session: ${shortId} -->`,
      '```',
      '',
      'hook 只检查带本会话标注的任务段——你看不到别的会话，也不为它们负责。',
      '无标注的祖传任务段对所有会话都"透明"（既不拦截也不连坐）。',
      '',
    ].join('\n'));

    if (adoptedHeader) {
      process.stdout.write([
        '## 自动认领通知',
        '',
        '我（init-project.js）刚检测到一个正在进行的祖传段（无 session 标注、含未勾 `[ ]`），已自动把它认领给本会话：',
        '',
        '```',
        `${adoptedHeader}`,
        `↓`,
        `${adoptedHeader} <!-- session: ${shortId} -->`,
        '```',
        '',
        '你可以直接继续这个任务——不需要自己补标注。如果这不是你想继续的任务，用 Edit 把标注去掉或改到别的段上即可。',
        '',
      ].join('\n'));
    }
  }
}

// 读 stdin 拿 session_id。TTY 场景（手工 `node init-project.js` 调试）直接跑空
if (process.stdin.isTTY) {
  main('');
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', () => {
    let sessionId = '';
    try {
      const input = JSON.parse(raw);
      sessionId = input?.session_id || '';
    } catch (e) {}
    main(sessionId);
  });
}
