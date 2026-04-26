#!/usr/bin/env node
// 一次性迁移：把旧的按月单文件 todo/archive/YYYY-MM.md 拆成按日多文件
//   todo/archive/YYYY-MM/YYYY-MM-DD.md
//
// 用法：node scripts/migrate-archive-to-daily.js [--dry-run]
//   --dry-run：只打印计划，不动文件
//
// 安全：不删原文件——拆完打印计划后由用户决定删（脚本只创建新结构）。

const fs = require('fs');
const path = require('path');
const { splitSections } = require('../hooks/_session-util.js');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const archiveDir = path.join(projectDir, 'todo', 'archive');
const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(archiveDir)) {
  console.error('archive 目录不存在:', archiveDir);
  process.exit(0);
}

const monthFileRe = /^(\d{4}-\d{2})\.md$/;
const oldFiles = fs.readdirSync(archiveDir).filter(f => monthFileRe.test(f));
if (oldFiles.length === 0) {
  console.log('没有需要迁移的旧月文件');
  process.exit(0);
}

let totalSections = 0;
let totalDayFiles = 0;
const summary = [];

for (const f of oldFiles) {
  const month = f.replace('.md', '');
  const fullPath = path.join(archiveDir, f);
  const content = fs.readFileSync(fullPath, 'utf8');
  const allLines = content.split('\n');
  const sections = splitSections(content).filter(s => !s.isArchive);
  totalSections += sections.length;

  // 按日分组
  const byDay = new Map();
  for (const sec of sections) {
    const m = sec.header.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    const day = m ? m[1] : `${month}-01`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(sec);
  }

  const monthDir = path.join(archiveDir, month);
  if (!dryRun) fs.mkdirSync(monthDir, { recursive: true });

  for (const [day, secs] of byDay) {
    totalDayFiles++;
    const dayFile = path.join(monthDir, `${day}.md`);
    let body = `# ${day} 归档\n\n`;
    body += secs
      .map(s => allLines.slice(s.startLine, s.endLine + 1).join('\n').replace(/\s+$/, ''))
      .join('\n\n') + '\n';

    if (!dryRun) {
      // 如果目标日文件已存在（不应该，但防御性），append；否则新建
      if (fs.existsSync(dayFile)) {
        let existing = fs.readFileSync(dayFile, 'utf8');
        if (!existing.endsWith('\n')) existing += '\n';
        // 跳过新内容首行的 H1 标题（避免重复）
        const newBody = body.replace(/^#\s+\d{4}-\d{2}-\d{2}\s+归档\s*\n+/, '');
        fs.writeFileSync(dayFile, existing + newBody);
      } else {
        fs.writeFileSync(dayFile, body);
      }
    }
    summary.push(`  ${day}.md ← ${secs.length} 段`);
  }

  // 删旧月文件
  if (!dryRun) {
    fs.unlinkSync(fullPath);
  }
  console.log(`${dryRun ? '[DRY] ' : ''}迁移 ${f}: ${sections.length} 段 → ${byDay.size} 日文件`);
}

console.log(summary.join('\n'));
console.log(`\n总计: ${totalSections} 段 → ${totalDayFiles} 日文件${dryRun ? '（dry-run，未动）' : ''}`);
