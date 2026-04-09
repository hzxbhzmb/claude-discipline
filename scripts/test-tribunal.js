#!/usr/bin/env node
// Self-test for hooks/run-tribunal.js
// 用法：node scripts/test-tribunal.js
// 退出码：0 = 全部通过；1 = 任一断言失败

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TRIBUNAL = path.resolve(__dirname, '..', 'hooks', 'run-tribunal.js');
const { sampleEvidenceIndices, defaultSampleCount, sampleIndices } = require(path.resolve(__dirname, '..', 'hooks', 'lib', 'seeded-sample'));
let testCount = 0;
let failCount = 0;

function makeTempTodo(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tribunal-test-'));
  const todoDir = path.join(dir, 'todo');
  fs.mkdirSync(todoDir, { recursive: true });
  const file = path.join(todoDir, 'current.md');
  fs.writeFileSync(file, content);
  return file;
}

function runTribunal(todoFile, env = {}) {
  const r = spawnSync('node', [TRIBUNAL, todoFile], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    code: r.status,
    json: r.stdout ? JSON.parse(r.stdout) : null,
    fileContent: fs.readFileSync(todoFile, 'utf8'),
  };
}

function assert(name, cond, detail = '') {
  testCount++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failCount++;
    process.stdout.write(`  ✗ ${name}${detail ? '\n      ' + detail : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// === Test 1: PASS path ===
section('Test 1: stub PASS path');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 测试段 PASS',
    '',
    '> 达标标准：fake',
    '',
    '- [x] 子任务1',
    '- [x] 子任务2',
    '',
    '> ✅ 验算通过：fake verification',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('exit code = 0', r.code === 0, `got ${r.code}, stderr: ${r.stderr}`);
  assert('verdict = PASS', r.json && r.json.verdict === 'PASS');
  assert('audited = 1', r.json && r.json.audited === 1);
  assert('passed = 1', r.json && r.json.passed === 1);
  assert('文件含 🔍 复核结论：PASS', r.fileContent.includes('🔍 复核结论：PASS'));
  assert('文件含 ⚖️ 审计结论：PASS', r.fileContent.includes('⚖️ 审计结论：PASS'));
  // 二次运行不应再触发
  const r2 = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('已 PASS 段不重复审判', r2.json && r2.json.audited === 0);
}

// === Test 2: FAIL → retry → SHELVE ===
section('Test 2: stub FAIL path 累加到搁置');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 测试段 FAIL',
    '',
    '> 达标标准：fake',
    '',
    '- [x] 子任务1',
    '- [x] 子任务2',
    '',
    '> ✅ 验算通过：fake verification',
    '',
  ].join('\n'));

  const r1 = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'FAIL' });
  assert('第1次 exit code = 2', r1.code === 2);
  assert('第1次 verdict = FAIL', r1.json && r1.json.verdict === 'FAIL');
  assert('文件含 审判失败次数：1', r1.fileContent.includes('审判失败次数：1'));
  assert('文件含 审判失败历史', r1.fileContent.includes('审判失败历史'));
  assert('未搁置（第1次）', !r1.fileContent.includes('🚨 审判搁置'));

  const r2 = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'FAIL' });
  assert('第2次 audited = 1（重试）', r2.json && r2.json.audited === 1);
  assert('文件含 审判失败次数：2', r2.fileContent.includes('审判失败次数：2'));
  assert('未搁置（第2次）', !r2.fileContent.includes('🚨 审判搁置'));

  const r3 = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'FAIL' });
  assert('第3次后被搁置', r3.fileContent.includes('🚨 审判搁置'));
  assert('搁置摘要含 3 次', (r3.fileContent.match(/^>\s*第\d+次：/gm) || []).length >= 3);
  assert('shelved = 1', r3.json && r3.json.shelved === 1);

  const r4 = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('已搁置段不再触发', r4.json && r4.json.audited === 0);
}

// === Test 3: 审计：跳过 不触发 ===
section('Test 3: 段头声明跳过');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 测试段 跳过',
    '',
    '> 达标标准：fake',
    '> 审计：跳过',
    '',
    '- [x] 子任务1',
    '',
    '> ✅ 验算通过：fake',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('audited = 0', r.json && r.json.audited === 0);
  assert('未写入复核标记', !r.fileContent.includes('🔍 复核结论'));
}

// === Test 4: INCOMPLETE 段不触发 ===
section('Test 4: 不完整段不触发');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 有未完成项',
    '',
    '> 达标标准：fake',
    '',
    '- [x] 子任务1',
    '- [ ] 子任务2',
    '',
    '> ✅ 验算通过：fake',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('有 [ ] 不触发', r.json && r.json.audited === 0);
}
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 缺验算行',
    '',
    '> 达标标准：fake',
    '',
    '- [x] 子任务1',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('缺 ✅ 不触发', r.json && r.json.audited === 0);
}

// === Test 5: 多段并存 ===
section('Test 5: 多段并存');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 段A 应通过',
    '> 达标标准：fake',
    '- [x] 任务',
    '> ✅ 验算通过：a',
    '',
    '## 2026-04-09 — 段B 跳过',
    '> 达标标准：fake',
    '> 审计：跳过',
    '- [x] 任务',
    '> ✅ 验算通过：b',
    '',
    '## 2026-04-09 — 段C 不完整',
    '> 达标标准：fake',
    '- [ ] 任务',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('只审 1 段', r.json && r.json.audited === 1);
  assert('段A 已通过', r.fileContent.split('段A')[1] && r.fileContent.split('段A')[1].includes('🔍 复核结论：PASS'));
  assert('段B 未被改', !r.fileContent.split('段B')[1].split('段C')[0].includes('🔍 复核结论'));
}

// === Test 5b: 复核者工具调用数不足 → INVALID ===
section('Test 5b: 复核者偷懒（PASS 但工具调用 0 次）→ 自动 FAIL');
{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 偷懒复核段',
    '> 达标标准：fake',
    '- [x] 任务1',
    '- [x] 任务2',
    '- [x] 任务3',
    '> ✅ 验算通过：fake',
    '',
  ].join('\n'));
  const r = runTribunal(todo, { TRIBUNAL_STUB_MODE: 'PASS_LOWCALLS' });
  assert('verdict = FAIL（INVALID 路径）', r.json && r.json.verdict === 'FAIL');
  assert('FAIL 阶段 = verifier', r.json && r.json.details[0]?.stage === 'verifier');
  assert('文件含 INVALID 标记', r.fileContent.includes('🔍 复核结论：INVALID'));
  assert('原因含工具调用不足', r.fileContent.includes('工具调用'));
}

// === Test 6: hook 集成 ===
section('Test 6: check-todo-verification.js → run-tribunal.js 集成');
const HOOK = path.resolve(__dirname, '..', 'hooks', 'check-todo-verification.js');

function runHook(todoFile, env = {}) {
  const input = JSON.stringify({ tool_input: { file_path: todoFile } });
  const r = spawnSync('node', [HOOK], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  let parsed = null;
  if (r.stdout) {
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* not JSON, ok */ }
  }
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    code: r.status,
    parsed,
    fileContent: fs.readFileSync(todoFile, 'utf8'),
  };
}

{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — hook 集成 PASS 段',
    '> 达标标准：fake',
    '- [x] 任务',
    '> ✅ 验算通过：fake',
    '',
  ].join('\n'));
  const r = runHook(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('hook 不输出 deny（PASS 路径）', !r.parsed || r.parsed.hookSpecificOutput?.permissionDecision !== 'deny');
  assert('文件含 🔍 复核结论：PASS（hook 触发了 tribunal）', r.fileContent.includes('🔍 复核结论：PASS'));
}

{
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — hook 集成 FAIL 段',
    '> 达标标准：fake',
    '- [x] 任务',
    '> ✅ 验算通过：fake',
    '',
  ].join('\n'));
  const r = runHook(todo, { TRIBUNAL_STUB_MODE: 'FAIL' });
  assert('hook 输出 deny（FAIL 路径）', r.parsed && r.parsed.hookSpecificOutput?.permissionDecision === 'deny');
  assert('deny reason 含"三权审判未通过"', r.parsed && r.parsed.hookSpecificOutput?.permissionDecisionReason?.includes('三权审判未通过'));
  assert('文件含 审判失败次数：1', r.fileContent.includes('审判失败次数：1'));
}

{
  // 缺验算行 → 仍走 phase 1 deny
  const todo = makeTempTodo([
    '# 任务计划',
    '',
    '## 2026-04-09 — 缺验算行',
    '> 达标标准：fake',
    '- [x] 任务',
    '',
  ].join('\n'));
  const r = runHook(todo, { TRIBUNAL_STUB_MODE: 'PASS' });
  assert('缺验算行 hook 仍 deny', r.parsed && r.parsed.hookSpecificOutput?.permissionDecision === 'deny');
  assert('deny reason 含"缺少验算记录"', r.parsed && r.parsed.hookSpecificOutput?.permissionDecisionReason?.includes('缺少验算记录'));
  assert('未触发 tribunal（无复核标记）', !r.fileContent.includes('🔍 复核结论'));
}

// === Test 7: seeded sampling 确定性 ===
section('Test 7: seeded-sample 库确定性 + 边界 case');
{
  const ev8 = ['e0','e1','e2','e3','e4','e5','e6','e7'];
  const a1 = sampleEvidenceIndices(ev8, 'header-A');
  const a2 = sampleEvidenceIndices(ev8, 'header-A');
  const b = sampleEvidenceIndices(ev8, 'header-B');
  assert('同一 seed 两次抽样完全相同', JSON.stringify(a1) === JSON.stringify(a2));
  assert('不同 seed 抽样不同', JSON.stringify(a1) !== JSON.stringify(b));
  assert('8 条 evidence → 抽 3 条 (ceil(8/3))', a1.length === 3);
  assert('每条都有 index 字段', a1.every(s => typeof s.index === 'number'));
  assert('每条都有 text 字段', a1.every(s => typeof s.text === 'string'));
  assert('索引在合法范围 [0,7]', a1.every(s => s.index >= 0 && s.index < 8));
  assert('索引按升序排列', a1.every((s, i) => i === 0 || s.index > a1[i-1].index));
}
{
  // 边界：evidence 比抽样数还少
  const ev2 = ['e0', 'e1'];
  const r = sampleEvidenceIndices(ev2, 'any');
  assert('2 条 evidence 全抽（因为 ceil(2/3)=1，但少时抽全部？）',
    r.length === 1 || r.length === 2);
  assert('1 条 evidence', sampleEvidenceIndices(['only'], 'x').length === 1);
  assert('0 条 evidence 不抽', sampleEvidenceIndices([], 'x').length === 0);
  assert('null evidence 不抽', sampleEvidenceIndices(null, 'x').length === 0);
  assert('undefined evidence 不抽', sampleEvidenceIndices(undefined, 'x').length === 0);
}
{
  // sampleIndices 直接调用
  assert('sampleIndices(0, _, _) = []', sampleIndices(0, 5, 'x').length === 0);
  assert('sampleIndices(_, 0, _) = []', sampleIndices(5, 0, 'x').length === 0);
  assert('n >= length 时返回全部', JSON.stringify(sampleIndices(5, 99, 'x')) === '[0,1,2,3,4]');
  assert('defaultSampleCount(0) = 1', defaultSampleCount(0) === 1);
  assert('defaultSampleCount(3) = 1', defaultSampleCount(3) === 1);
  assert('defaultSampleCount(4) = 2', defaultSampleCount(4) === 2);
  assert('defaultSampleCount(9) = 3', defaultSampleCount(9) === 3);
  assert('defaultSampleCount(10) = 4', defaultSampleCount(10) === 4);
}

// === Test 8: auditor.md 含 SAMPLED_EVIDENCE 占位符 ===
section('Test 8: auditor prompt 含抽样占位符');
{
  const auditorPrompt = fs.readFileSync(
    path.resolve(__dirname, '..', 'prompts', 'auditor.md'),
    'utf8'
  );
  assert('auditor.md 含 {{SAMPLED_EVIDENCE}} 占位符', auditorPrompt.includes('{{SAMPLED_EVIDENCE}}'));
  assert('auditor.md 写明禁止自选样本', auditorPrompt.includes('你不能自己挑样本'));
  assert('auditor.md 删除了"随机抽 1~2 条"措辞', !auditorPrompt.includes('随机抽 1~2 条'));
  assert('auditor.md 含 hook 预选说法', auditorPrompt.includes('hook 用确定性'));
}

// === 总结 ===
process.stdout.write(`\n${'='.repeat(40)}\n`);
process.stdout.write(`总计：${testCount} 项，失败：${failCount}\n`);
process.exit(failCount === 0 ? 0 : 1);
