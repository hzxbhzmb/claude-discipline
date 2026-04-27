#!/usr/bin/env node
// Hook 可观测性统计工具
//
// 用法：
//   node scripts/hook-stats.js              # 过去 7 天
//   node scripts/hook-stats.js 30           # 过去 30 天
//   node scripts/hook-stats.js --by-reason  # 按 deny 原因分桶
//
// 数据源：~/.claude-discipline/runtime-YYYY-MM-DD.jsonl

const path = require('path');
const { readRecent } = require(path.join(__dirname, '..', 'hooks', '_runtime-log.js'));

const args = process.argv.slice(2);
const byReason = args.includes('--by-reason');
const daysArg = args.find(a => /^\d+$/.test(a));
const days = daysArg ? parseInt(daysArg, 10) : 7;

const entries = readRecent(days);

if (entries.length === 0) {
  console.log(`(过去 ${days} 天无 runtime 日志条目；可能 hook 未跑过、或 ~/.claude-discipline/ 不存在)`);
  process.exit(0);
}

console.log(`Claude Discipline — Hook Runtime Stats (过去 ${days} 天)`);
console.log(`日志总条目：${entries.length}\n`);

// 按 hook 分桶
const byHook = new Map();
for (const e of entries) {
  if (!byHook.has(e.hook)) byHook.set(e.hook, { triggered: 0, denied: 0, reasons: new Map() });
  const b = byHook.get(e.hook);
  b.triggered += 1;
  if (e.denied) {
    b.denied += 1;
    if (e.reason) b.reasons.set(e.reason, (b.reasons.get(e.reason) || 0) + 1);
  }
}

// 排序：按触发次数倒序
const sorted = Array.from(byHook.entries()).sort((a, b) => b[1].triggered - a[1].triggered);

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('hook', 32)} ${pad('triggered', 11)} ${pad('denied', 8)} ${'deny%'}`);
console.log('─'.repeat(70));
for (const [hook, b] of sorted) {
  const denyPct = b.triggered ? ((b.denied / b.triggered) * 100).toFixed(1) + '%' : '0.0%';
  console.log(`${pad(hook, 32)} ${pad(b.triggered, 11)} ${pad(b.denied, 8)} ${denyPct}`);
}

if (byReason) {
  console.log('\n=== 按 deny 原因分桶 ===');
  for (const [hook, b] of sorted) {
    if (b.reasons.size === 0) continue;
    console.log(`\n[${hook}]`);
    const reasonsSorted = Array.from(b.reasons.entries()).sort((a, b) => b[1] - a[1]);
    for (const [r, n] of reasonsSorted) {
      console.log(`  ${n}× ${r}`);
    }
  }
}

console.log('\n提示：');
console.log('  triggered = 0 的 hook 可能注册位置错了（参考 v2.4.0 line-count 事故）');
console.log('  deny% 极低且 triggered 大的 hook 可能是低价值候选删除');
