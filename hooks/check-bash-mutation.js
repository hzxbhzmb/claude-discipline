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
//   v3.0.1+：所有 mutation 目标均为白名单文件（todo/current.md / archive/ 等）

const fs = require('fs');
const path = require('path');
const { runHook, denyPre, isWhitelisted } = require('./_hook-runner');
const { ownedSections, shortId } = require('./_session-util');

runHook('check-bash-mutation', 'PreToolUse', (ctx) => {
  if (ctx.toolName !== 'Bash') return;
  if (!ctx.command) return;
  if (!isMutation(ctx.command)) return;
  if (!ctx.projectDir) return;

  // v3.0.1+：所有 mutation 目标都在白名单 → 视同 Edit/Write 白名单文件，无需握手
  if (allTargetsWhitelisted(ctx.command)) return;

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
      '💡 **如果你想新建任务段，请改用 Edit 工具**直接编辑 todo/current.md（白名单文件，',
      '无需握手即可编辑）；不要用 Bash 重定向（tee / >> / cat <<EOF）写入它。',
      '',
      '建段模板：',
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
      '💡 想编辑 todo/current.md 的任务段？请改用 **Edit 工具**——current.md 在白名单内，',
      '可直接编辑无需握手。Bash 路径只针对项目源文件。',
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

// === v3.0.1+：白名单目标提取 ===
//
// 从 Bash 命令字符串里提取 mutation 操作的目标文件路径。
// 简单解析：cover 常见 90% 场景；不确定的 case 返回 null（保守 → 不放行 → 死锁回到 v3.0.0 行为）。
//
// 覆盖：
//   tee FILE / tee -a FILE
//   > FILE / >> FILE
//   sed -i ... FILE / awk -i inplace ... FILE / perl -i ... FILE
//   rm FILE / rm -rf FILE
//   mv ... FILE / cp ... FILE  （取最后一个非 flag 参数为目标）
//   truncate ... FILE / dd of=FILE / shred FILE
//   git rm FILE / git mv X FILE / git restore FILE
//
// 不覆盖：变量替换 / 命令替换 / 引号嵌套深 / heredoc 内容
function extractSegmentTargets(seg) {
  const targets = [];

  // 重定向：取所有 > FILE 和 >> FILE 目标（排除 /dev/null 和 fd 复制）
  const redirectRe = /(?<!&)>{1,2}(?!&)\s*(\S+)/g;
  let m;
  while ((m = redirectRe.exec(seg)) !== null) {
    const target = m[1];
    if (target === '/dev/null') continue;
    targets.push(stripQuotes(target));
  }

  const cmdMatch = seg.match(/^(?:\w+=\S+\s+)*(?:sudo\s+)?(\S+)/);
  if (!cmdMatch) return targets.length ? targets : null;
  const cmdName = cmdMatch[1];

  // 把命令切成 token（去 quotes 但不处理转义）；先去掉重定向部分
  const segNoRedirect = seg.replace(/(?<!&)>{1,2}(?!&)\s*\S+/g, '');
  const tokens = tokenize(segNoRedirect);
  const args = tokens.slice(1);

  if (cmdName === 'tee') {
    // tee [-a] [--append] [-i] FILE...  所有非 flag 是目标
    for (const a of args) {
      if (a === '-a' || a === '--append' || a === '-i' || a === '--ignore-interrupts') continue;
      if (a.startsWith('-')) continue;
      targets.push(stripQuotes(a));
    }
  } else if (cmdName === 'rm' || cmdName === 'rmdir' || cmdName === 'shred' || cmdName === 'truncate') {
    for (const a of args) {
      if (a.startsWith('-')) continue;
      targets.push(stripQuotes(a));
    }
  } else if (cmdName === 'mv' || cmdName === 'cp' || cmdName === 'install') {
    const nonFlag = args.filter(a => !a.startsWith('-'));
    if (nonFlag.length >= 2) targets.push(stripQuotes(nonFlag[nonFlag.length - 1]));
    else return null;
  } else if (cmdName === 'sed' || cmdName === 'awk' || cmdName === 'perl') {
    // 简化：最后一个非 flag、非 expression token 当作目标
    const candidate = args.filter(a => !a.startsWith('-'));
    if (candidate.length >= 1) targets.push(stripQuotes(candidate[candidate.length - 1]));
    else return null;
  } else if (cmdName === 'dd') {
    for (const a of args) {
      if (a.startsWith('of=')) targets.push(stripQuotes(a.slice(3)));
    }
  } else if (cmdName === 'git') {
    const sub = args[0];
    if (!sub) return null;
    if (sub === 'reset' || sub === 'clean' || sub === 'checkout') {
      // 这些 git 子命令的"目标"可能是整个工作树——保守不放行
      return null;
    }
    const fileArgs = args.slice(1).filter(a => !a.startsWith('-'));
    for (const a of fileArgs) targets.push(stripQuotes(a));
  }

  return targets.length ? targets : null;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function tokenize(seg) {
  const tokens = [];
  let i = 0, cur = '', inQuote = null;
  while (i < seg.length) {
    const c = seg[i];
    if (inQuote) {
      cur += c;
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      cur += c;
      inQuote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// 命令所有 mutation 目标都在白名单 → true
// 任一目标无法解析 / 不在白名单 → false（保守不放行）
function allTargetsWhitelisted(command) {
  if (!command) return false;
  const segments = command.split(/&&|\|\|?|;/);

  let hasAnyTarget = false;
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    if (!segmentIsMutation(seg)) continue;
    const targets = extractSegmentTargets(seg);
    if (!targets || targets.length === 0) return false;
    hasAnyTarget = true;
    for (const t of targets) {
      // 标准化：相对路径加前导斜杠才能匹配 isWhitelisted 的 "/todo/current.md" 子串
      const normalized = t.startsWith('/') || t.startsWith('\\') ? t : '/' + t;
      if (!isWhitelisted(normalized)) return false;
    }
  }
  return hasAnyTarget;
}

// 导出用于单测
module.exports = { isMutation, segmentIsMutation, extractSegmentTargets, allTargetsWhitelisted };
