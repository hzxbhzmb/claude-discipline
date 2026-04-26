#!/usr/bin/env node
// SessionStart Hook: 自动把 todo/current.md 中已完成的任务段搬到 todo/archive/YYYY-MM.md
//
// 完成判定（保守，宁可不归档也别误归档进行中段）：
//   1. 不是"## 归档说明"段
//   2. 段内没有未勾的 `- [ ]`
//   3. 段内至少有一个完成标记：`> ✅ 验算通过` 或 `> ❌ 最终验算失败` 或 `> ✅ 完成`
//
// 跨会话宽容：不要求 sessionId 标注匹配——任何会话写完的段都可被任何会话归档
// 归档月份：从段标题 `## YYYY-MM-DD —` 取前 7 字符；解析失败回退到当月
//
// 输出：stderr 一行摘要；stdout 不输出（避免污染 SessionStart 注入流）
// 失败安全：任何异常都不阻塞会话启动，吞掉错误并继续

if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const { splitSections } = require('./_session-util.js');

const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (!projectDir) process.exit(0);

const todoFile = path.join(projectDir, 'todo', 'current.md');
const archiveDir = path.join(projectDir, 'todo', 'archive');

if (!fs.existsSync(todoFile)) process.exit(0);

function isDoneSection(section) {
  if (section.isArchive) return false;
  const body = section.bodyLines.join('\n');
  // 还有未勾的子任务 → 没完成
  if (/^\s*- \[ \]/m.test(body)) return false;
  // 必须命中至少一个完成标记
  const hasCompletionMarker =
    /^>\s*✅\s*验算通过/m.test(body) ||
    /^>\s*❌\s*最终验算失败/m.test(body) ||
    /^>\s*✅\s*完成/m.test(body);
  return hasCompletionMarker;
}

function archiveMonthFromHeader(header) {
  // ## YYYY-MM-DD — XXX  → "YYYY-MM"
  const m = header.match(/^##\s+(\d{4}-\d{2})-\d{2}/);
  if (m) return m[1];
  // 回退：当月
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sectionToText(section, allLines) {
  return allLines.slice(section.startLine, section.endLine + 1).join('\n');
}

function main() {
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    return;
  }

  const allLines = content.split('\n');
  const sections = splitSections(content);
  const doneSections = sections.filter(isDoneSection);
  if (doneSections.length === 0) return;

  // 按月分组
  const byMonth = new Map();
  for (const sec of doneSections) {
    const month = archiveMonthFromHeader(sec.header);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(sec);
  }

  // 写归档：每月一个文件，append 到末尾（保持时间顺序）
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const [month, secs] of byMonth) {
    const archiveFile = path.join(archiveDir, `${month}.md`);
    let archiveContent = '';
    if (fs.existsSync(archiveFile)) {
      archiveContent = fs.readFileSync(archiveFile, 'utf8');
      if (!archiveContent.endsWith('\n')) archiveContent += '\n';
    } else {
      archiveContent = `# ${month} 归档\n\n`;
    }
    const block = secs
      .map(s => sectionToText(s, allLines).replace(/\s+$/, ''))
      .join('\n\n');
    archiveContent += block + '\n';
    fs.writeFileSync(archiveFile, archiveContent);
  }

  // 重写 current.md：移除已归档段
  const doneLineSet = new Set();
  for (const sec of doneSections) {
    for (let i = sec.startLine; i <= sec.endLine; i++) doneLineSet.add(i);
  }
  const kept = allLines.filter((_, idx) => !doneLineSet.has(idx));
  // 收尾：合并连续 ≥3 个空行为 1 个空行，避免归档后留一堆空白
  const cleaned = [];
  let blankRun = 0;
  for (const line of kept) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 2) cleaned.push(line);
    } else {
      blankRun = 0;
      cleaned.push(line);
    }
  }
  // 末尾保留单个换行
  while (cleaned.length > 1 && cleaned[cleaned.length - 1] === '' && cleaned[cleaned.length - 2] === '') {
    cleaned.pop();
  }
  fs.writeFileSync(todoFile, cleaned.join('\n'));

  const summary = Array.from(byMonth.entries())
    .map(([m, s]) => `${s.length}段→archive/${m}.md`)
    .join(', ');
  process.stderr.write(`✓ auto-archive: ${doneSections.length} 个完成段已归档（${summary}）\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`⚠️ auto-archive 失败（不阻塞会话）: ${e.message}\n`);
}
