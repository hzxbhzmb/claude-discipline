#!/usr/bin/env node
// PreToolUse Hook: Bash 里的写/删/移操作也受三次握手保护
// 补 Edit|Write matcher 的漏洞——AI 不能用 mv/sed/cp/rm/重定向 绕过握手
//
// 拦截清单（保守）：
//   mv, cp, rm, rmdir, tee, dd, truncate, shred, install
//   sed -i, awk -i inplace, perl -i
//   git reset --hard, git clean -f*, git checkout --, git restore, git rm, git mv
//   重定向 > / >>（豁免 /dev/null 和 2>&1 这类 fd 复制）
//
// 不拦：
//   只读命令（ls/cat/grep/find/git status/git log 等）
//   git commit / push / fetch / pull（不改 working tree）
//   touch/mkdir/chmod/chown/ln（低风险边界，先不拦）
//
// 豁免：
//   CLAUDE_DISCIPLINE_BYPASS=1 环境变量
//   本会话最新任务段有 > ✅ 执行授权（含快车道）

const fs = require('fs');
const path = require('path');
const { runHook, denyPre } = require('./_hook-runner');
const { ownedSections, shortId } = require('./_session-util');

runHook('check-bash-mutation', 'PreToolUse', (ctx) => {
  if (ctx.toolName !== 'Bash') return;
  if (!ctx.command) return;
  if (!isMutation(ctx.command)) return;
  if (!ctx.projectDir) return;

  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    return; // todo 不存在时不阻断（init 还没跑）
  }

  const sid = shortId(ctx.sessionId);
  const mine = sid ? ownedSections(content, ctx.sessionId) : [];

  if (mine.length === 0) {
    const reason = [
      '🚫 Bash 写操作被拒绝：本会话还没有建任务段（或建的段没带 session 标注）。',
      '',
      `命令：${ctx.command.slice(0, 120)}${ctx.command.length > 120 ? '…' : ''}`,
      `你的会话 sessionId 短 ID：${sid || '(未知)'}`,
      '',
      '新规则（v2.1.0+）：Bash 里的 mv/cp/rm/sed -i/重定向/git reset --hard 等写操作',
      '与 Edit/Write 同等对待——同样受三次握手保护，不能再用 Bash 绕过。',
      '',
      '请在 todo/current.md 末尾新建任务段：',
      '```',
      `## YYYY-MM-DD — 任务简述 <!-- session: ${sid} -->`,
      '```',
      '按三次握手写 **AI 理解** → 向用户确认 → 写 `> ✅ 执行授权`。',
      '轻量任务可走快车道：单行 `> ✅ 执行授权：[快车道] {说明}`。',
    ].join('\n');
    process.stdout.write(denyPre(reason));
    ctx.deny('bash mutation, no session-tagged section');
    return;
  }

  const latest = mine[mine.length - 1];
  const sectionText = [latest.header, ...latest.bodyLines].join('\n');
  const hasAuthorization = /^>\s*✅\s*执行授权/m.test(sectionText);

  if (!hasAuthorization) {
    const reason = [
      '🚫 Bash 写操作被拒绝：任务三次握手未完成。',
      '',
      `命令：${ctx.command.slice(0, 120)}${ctx.command.length > 120 ? '…' : ''}`,
      `当前任务段：${latest.header}`,
      '',
      '新规则（v2.1.0+）：Bash 里的写/删/移操作与 Edit/Write 同等对待，',
      '必须握手完成才能执行——不能再用 Bash 绕过。',
      '',
      '请在当前任务段写 **AI 理解** → 向用户确认 → 写 `> ✅ 执行授权：...`。',
    ].join('\n');
    process.stdout.write(denyPre(reason));
    ctx.deny('bash mutation, no authorization');
  }
});

// === mutation 判定 ===

function isMutation(command) {
  if (!command) return false;

  // 按 ; && || | 切分（简单切分，不处理引号内的字面分隔符；误报优于漏报）
  const segments = command.split(/&&|\|\|?|;/);

  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    if (segmentIsMutation(seg)) return true;
  }
  return false;
}

function segmentIsMutation(seg) {
  // 重定向：> 或 >>（排除 2>&1 这类 fd 复制，排除 > /dev/null）
  const redirectRe = /(?<!&)>{1,2}(?!&)\s*(\S+)/g;
  let m;
  while ((m = redirectRe.exec(seg)) !== null) {
    const target = m[1];
    if (target === '/dev/null') continue;
    return true;
  }

  // 提取命令名（跳过 env VAR=xxx 前缀和 sudo 前缀）
  const cmdMatch = seg.match(/^(?:\w+=\S+\s+)*(?:sudo\s+)?(\S+)/);
  if (!cmdMatch) return false;
  const cmdName = cmdMatch[1];

  const MUTATION_CMDS = new Set([
    'mv', 'cp', 'rm', 'rmdir',
    'tee', 'dd', 'truncate', 'shred', 'install',
  ]);
  if (MUTATION_CMDS.has(cmdName)) return true;

  // sed / awk / perl 原地修改
  if (cmdName === 'sed' && /(?:^|\s)-i(?:$|\s|\.\S+)/.test(seg)) return true;
  if (cmdName === 'awk' && /\s-i\s+inplace\b/.test(seg)) return true;
  if (cmdName === 'perl' && /(?:^|\s)-p?i(?:$|\s|\.\S+)/.test(seg)) return true;

  // git 破坏性子命令（不拦 commit/push/fetch/pull/log/status/diff）
  if (cmdName === 'git') {
    if (/\bgit\s+reset\s+--hard\b/.test(seg)) return true;
    if (/\bgit\s+clean\s+-[a-zA-Z]*f/.test(seg)) return true;
    if (/\bgit\s+checkout\s+--(?:\s|$)/.test(seg)) return true;
    if (/\bgit\s+restore\b/.test(seg)) return true;
    if (/\bgit\s+rm\b/.test(seg)) return true;
    if (/\bgit\s+mv\b/.test(seg)) return true;
  }

  return false;
}

// 导出用于单测
module.exports = { isMutation, segmentIsMutation };
