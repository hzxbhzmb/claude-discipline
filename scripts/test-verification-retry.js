#!/usr/bin/env node
// check-verification-retry-limit.js 的单元测试（反向路径）
//
// 用法：node scripts/test-verification-retry.js
// 退出码：0 = 全部通过；非 0 = 有用例失败

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
const HOOK = path.join(ROOT, 'hooks', 'check-verification-retry-limit.js');

function record(name, passed, detail = '') {
  RESULTS.push({ name, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function runHook(todoContent, { sessionId = '586ed928abcdefghijklmnop', filePath, env = {} } = {}) {
  // 写沙箱 todo
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-test-'));
  const todoDir = path.join(sandbox, 'todo');
  fs.mkdirSync(todoDir, { recursive: true });
  const todoFile = filePath || path.join(todoDir, 'current.md');
  if (todoContent !== null) fs.writeFileSync(todoFile, todoContent);

  const input = {
    tool_name: 'Edit',
    tool_input: { file_path: todoFile, old_string: 'x', new_string: 'y' },
    session_id: sessionId,
  };

  const res = cp.spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}

  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

function parseDecision(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision || null;
  } catch (e) { return null; }
}

const SID_SHORT = '586ed928';

function makeSection(failureCount, { withFinal = false, withPass = false, sessionId = SID_SHORT } = {}) {
  const lines = [
    `## 2026-04-24 — 测试任务 <!-- session: ${sessionId} -->`,
    '',
    '**用户意图**：test',
    '',
    '> ✅ 执行授权：test',
    '',
  ];
  for (let i = 1; i <= failureCount; i++) {
    lines.push(`> ❌ 验算第 ${i} 次失败：原因 ${i} → 改进：做了 ${i}`);
  }
  if (withFinal) lines.push('> ❌ 最终验算失败：汇总 | 尝试 | 建议');
  if (withPass) lines.push('> ✅ 验算通过：final');
  return lines.join('\n');
}

function todoWith(section) {
  return `# 任务计划\n\n---\n\n${section}\n`;
}

// ============================================================
// A：失败次数 ≤ 上限 → allow
// ============================================================
console.log('\n=== 分组 A：失败 ≤ 上限（默认 3） → allow ===');

[
  ['A1: 0 次失败', 0],
  ['A2: 1 次失败', 1],
  ['A3: 2 次失败', 2],
  ['A4: 3 次失败（等于上限不越）', 3],
].forEach(([name, n]) => {
  const { stdout, code } = runHook(todoWith(makeSection(n)));
  record(name, code === 0 && !stdout.trim(), `exit=${code} stdout=${stdout.slice(0, 60)}`);
});

// ============================================================
// B：失败次数 > 上限 且无终局行 → deny
// ============================================================
console.log('\n=== 分组 B：失败 > 上限 且无终局行 → deny ===');

[
  ['B1: 4 次失败', 4],
  ['B2: 5 次失败', 5],
  ['B3: 10 次失败', 10],
].forEach(([name, n]) => {
  const { stdout, code } = runHook(todoWith(makeSection(n)));
  const decision = parseDecision(stdout);
  record(name, decision === 'deny', `exit=${code} decision=${decision}`);
});

// ============================================================
// C：失败次数 > 上限 但已写终局行 → allow（已交棒 / 已成功）
// ============================================================
console.log('\n=== 分组 C：超限但已有终局行 → allow ===');

{
  const { stdout } = runHook(todoWith(makeSection(5, { withFinal: true })));
  record('C1: 5 次失败 + 最终失败段', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}
{
  const { stdout } = runHook(todoWith(makeSection(10, { withPass: true })));
  record('C2: 10 次失败 + ✅ 验算通过', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}

// ============================================================
// D：祖传段 / 他会话段 不连坐
// ============================================================
console.log('\n=== 分组 D：不连坐祖传段 / 他会话段 ===');

{
  // 祖传段（无 session 标注）含 5 次失败
  const todo = `# 任务计划\n\n---\n\n## 2026-04-20 — 祖传任务\n\n${
    Array.from({ length: 5 }, (_, i) => `> ❌ 验算第 ${i+1} 次失败：x`).join('\n')
  }\n`;
  const { stdout } = runHook(todo);
  record('D1: 祖传段超限（不连坐）', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}
{
  // 他会话段含 5 次失败
  const todo = `# 任务计划\n\n---\n\n## 2026-04-20 — 别人的任务 <!-- session: otherses -->\n\n${
    Array.from({ length: 5 }, (_, i) => `> ❌ 验算第 ${i+1} 次失败：x`).join('\n')
  }\n`;
  const { stdout } = runHook(todo);
  record('D2: 他会话段超限（不连坐）', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}

// ============================================================
// E：非 todo 文件 Edit → 不处理
// ============================================================
console.log('\n=== 分组 E：非 todo 文件 → 不处理 ===');

{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-test-'));
  const otherFile = path.join(sandbox, 'other.md');
  fs.writeFileSync(otherFile, todoWith(makeSection(5)));
  const { stdout } = runHook(null, { filePath: otherFile });
  record('E1: 非 todo/current.md 文件', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}
}

// ============================================================
// F：BYPASS=1 → allow（无论多少失败）
// ============================================================
console.log('\n=== 分组 F：BYPASS=1 → allow ===');

{
  const { stdout } = runHook(todoWith(makeSection(100)), { env: { CLAUDE_DISCIPLINE_BYPASS: '1' } });
  record('F1: 100 次失败 + BYPASS=1', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}

// ============================================================
// G：自定义上限 env
// ============================================================
console.log('\n=== 分组 G：DISCIPLINE_VERIFY_RETRY_LIMIT 覆盖默认 ===');

{
  const { stdout } = runHook(todoWith(makeSection(2)), { env: { DISCIPLINE_VERIFY_RETRY_LIMIT: '1' } });
  const decision = parseDecision(stdout);
  record('G1: LIMIT=1 + 2 次失败 → deny', decision === 'deny', `decision=${decision}`);
}
{
  const { stdout } = runHook(todoWith(makeSection(5)), { env: { DISCIPLINE_VERIFY_RETRY_LIMIT: '10' } });
  record('G2: LIMIT=10 + 5 次失败 → allow', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}

// ============================================================
// H：格式宽容——非标准格式失败行不计数
// ============================================================
console.log('\n=== 分组 H：非标准格式不计数（宽容处理）===');

{
  // 5 行 "> ❌ 验算失败：xxx"（没有"第 N 次"）→ 不计数 → allow
  const lines = [
    `## 2026-04-24 — 测试 <!-- session: ${SID_SHORT} -->`,
    '',
    '> ✅ 执行授权：test',
    '',
    ...Array.from({ length: 5 }, () => '> ❌ 验算失败：原因 x'),
  ];
  const todo = `# 任务计划\n\n---\n\n${lines.join('\n')}\n`;
  const { stdout } = runHook(todo);
  record('H1: 5 行 "验算失败"（无"第 N 次"）不计数', !stdout.trim(), `stdout=${stdout.slice(0, 60)}`);
}

// ============================================================
// 汇总
// ============================================================
const passed = RESULTS.filter(r => r.passed).length;
const failed = RESULTS.filter(r => !r.passed).length;
console.log(`\n=== 结果：${passed}/${RESULTS.length} 通过，${failed} 失败 ===`);

process.exit(failed === 0 ? 0 : 1);
