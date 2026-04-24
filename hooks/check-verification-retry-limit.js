#!/usr/bin/env node
// PostToolUse Hook: 验算失败迭代计数上限
// 统计本会话最新任务段内 "> ❌ 验算第 N 次失败" 行数，超限（默认 >3）且无"最终失败"行 → deny
// 强制 AI 把失败汇总为 "> ❌ 最终验算失败" 段向用户汇报，由用户决定改方向 / 回滚 / 放弃
//
// 多会话：只看带本会话 session 标注的段；祖传段 / 他会话段不连坐
//
// 配置：
//   DISCIPLINE_VERIFY_RETRY_LIMIT=N  — 覆盖默认 3 次上限
//   CLAUDE_DISCIPLINE_BYPASS=1       — 整个 hook 短路
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const { ownedSections } = require('./_session-util');

const DEFAULT_LIMIT = 3;
const rawLimit = parseInt(process.env.DISCIPLINE_VERIFY_RETRY_LIMIT || '', 10);
const LIMIT = Number.isFinite(rawLimit) && rawLimit >= 1 ? rawLimit : DEFAULT_LIMIT;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch (e) { return; }

  const filePath = input?.tool_input?.file_path || '';
  const sessionId = input?.session_id || '';

  if (!filePath.includes('/todo/current.md') && !filePath.includes('\\todo\\current.md')) return;
  if (!sessionId) return;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return;
  }

  const mine = ownedSections(content, sessionId);
  if (mine.length === 0) return;

  const latest = mine[mine.length - 1];
  const body = latest.bodyLines.join('\n');

  // 统计 "> ❌ 验算第 N 次失败" 行数（N 是数字，宽容接受 "验算第 1 次失败" / "验算第1次失败"）
  const failureRe = /^>\s*❌\s*验算第\s*\d+\s*次失败/gm;
  const failures = body.match(failureRe) || [];
  const k = failures.length;

  if (k <= LIMIT) return;

  // 已写"最终验算失败"或"验算通过"→ 放行（AI 已交棒或终于成功）
  if (/^>\s*❌\s*最终验算失败/m.test(body)) return;
  if (/^>\s*✅\s*验算通过/m.test(body)) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `🚫 验算失败次数 ${k} 超过上限 ${LIMIT}，强制停下交棒给用户。`,
        '',
        `当前任务段：${latest.header}`,
        '',
        `规则（v2.2.0+）：验算失败可自修迭代，但累计超 ${LIMIT} 次仍未过 → 不能再硬改，`,
        '必须把失败汇总写成 `> ❌ 最终验算失败：{汇总原因、尝试过什么、建议方向}` 段，',
        '在对话中向用户汇报，由用户决定改方向 / 回滚 / 放弃。',
        '',
        '请把刚才那行"验算第 N 次失败"替换/追加为：',
        '```',
        '> ❌ 最终验算失败：{原因汇总} | 尝试：{K 次改进都试了什么} | 建议：{下一步建议方向}',
        '```',
        '',
        '若用户授权继续改进（换方向 / 拉长上限），可设 env `DISCIPLINE_VERIFY_RETRY_LIMIT=N` 覆盖上限。',
      ].join('\n')
    }
  }));
});
