#!/usr/bin/env node
// 自动归档 + 行数硬阻断的反向验证测试
//
// 用法：node scripts/test-archive.js
// 退出码：0 = 全部通过；非 0 = 有用例失败

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];

function record(name, passed, detail = '') {
  RESULTS.push({ name, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function runHook(relPath, input, env = {}) {
  const full = path.join(ROOT, relPath);
  const res = cp.spawnSync('node', [full], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

function parseDecision(stdout) {
  if (!stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout);
    return obj?.hookSpecificOutput?.permissionDecision || null;
  } catch (e) { return null; }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
const sandboxTmp = path.join(sandbox, 'tmp');
const sandboxProject = path.join(sandbox, 'project');
fs.mkdirSync(sandboxTmp, { recursive: true });
fs.mkdirSync(path.join(sandboxProject, 'todo', 'archive'), { recursive: true });
const SANDBOX_ENV = { TMPDIR: sandboxTmp, CLAUDE_PROJECT_DIR: sandboxProject };

const todoFile = path.join(sandboxProject, 'todo', 'current.md');
const archiveDir = path.join(sandboxProject, 'todo', 'archive');

function writeTodo(content) { fs.writeFileSync(todoFile, content); }
function readTodo() { return fs.readFileSync(todoFile, 'utf8'); }
function readArchive(month) {
  const f = path.join(archiveDir, `${month}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
function resetArchives() {
  for (const f of fs.readdirSync(archiveDir)) {
    fs.unlinkSync(path.join(archiveDir, f));
  }
}

const HEADER = '# 任务计划\n\n## 归档说明\n\n已完成任务按月归档到 `todo/archive/` 目录。\n\n---\n\n';

// ============================================================================
// A：auto-archive.js 完成段判定
// ============================================================================
console.log('\n=== A：auto-archive 完成段判定 ===');

// A1：标准重档已完成段被归档
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 完成的任务 <!-- session: aaaaaaaa -->\n\n' +
    '- [x] 子任务1\n' +
    '- [x] 子任务2\n\n' +
    '> ✅ 验算通过：所有断言通过\n');
  runHook('hooks/auto-archive.js', { session_id: 'a'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  const arc = readArchive('2026-04');
  record('A1 完成段从 current 移除', !cur.includes('完成的任务'));
  record('A1 完成段进入 2026-04 archive', arc.includes('完成的任务') && arc.includes('✅ 验算通过'));
}

// A2：未完成段（有未勾 [ ]）保留
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 进行中任务 <!-- session: bbbbbbbb -->\n\n' +
    '- [x] 完成1\n' +
    '- [ ] 未完成\n\n' +
    '> ✅ 验算通过：但还有未勾\n');
  runHook('hooks/auto-archive.js', { session_id: 'b'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  record('A2 含未勾 [ ] 的段保留在 current', cur.includes('进行中任务'));
  record('A2 未完成段不进归档', readArchive('2026-04') === '');
}

// A3：无完成标记的段（全勾但没 ✅/❌）保留
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 全勾但无验算回执 <!-- session: cccccccc -->\n\n' +
    '- [x] 全勾了\n');
  runHook('hooks/auto-archive.js', { session_id: 'c'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  record('A3 全勾但无完成标记 → 保留', cur.includes('全勾但无验算回执'));
}

// A4：最终验算失败段也归档
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 失败任务 <!-- session: dddddddd -->\n\n' +
    '- [x] 试过\n\n' +
    '> ❌ 最终验算失败：试了 3 次都不行 | 建议：换路径\n');
  runHook('hooks/auto-archive.js', { session_id: 'd'.repeat(64) }, SANDBOX_ENV);
  const arc = readArchive('2026-04');
  record('A4 最终失败段归档', arc.includes('失败任务') && arc.includes('最终验算失败'));
}

// A5：快车道完成段（含 ✅ 完成）归档
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 快车道小改 <!-- session: eeeeeeee -->\n\n' +
    '**用户意图**：改个错别字\n\n' +
    '> ✅ 执行授权：[快车道] 单字符替换\n' +
    '> ✅ 完成：已替换\n');
  runHook('hooks/auto-archive.js', { session_id: 'e'.repeat(64) }, SANDBOX_ENV);
  const arc = readArchive('2026-04');
  record('A5 快车道含 ✅ 完成 段归档', arc.includes('快车道小改'));
}

// A6：快车道无 ✅ 完成 → 保留（保守）
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — 快车道无完成标记 <!-- session: ffffffff -->\n\n' +
    '> ✅ 执行授权：[快车道] 简单事\n');
  runHook('hooks/auto-archive.js', { session_id: 'f'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  record('A6 快车道无 ✅ 完成 → 保留', cur.includes('快车道无完成标记'));
}

// A7：跨月混合 → 按 header 日期分文件归档
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-03-15 — 三月任务 <!-- session: gggggggg -->\n\n' +
    '- [x] 完了\n\n' +
    '> ✅ 验算通过：3月\n\n' +
    '## 2026-04-18 — 四月任务 <!-- session: hhhhhhhh -->\n\n' +
    '- [x] 完了\n\n' +
    '> ✅ 验算通过：4月\n');
  runHook('hooks/auto-archive.js', { session_id: 'g'.repeat(64) }, SANDBOX_ENV);
  const arc3 = readArchive('2026-03');
  const arc4 = readArchive('2026-04');
  record('A7 三月段进 2026-03.md', arc3.includes('三月任务'));
  record('A7 四月段进 2026-04.md', arc4.includes('四月任务'));
  record('A7 不串档', !arc3.includes('四月任务') && !arc4.includes('三月任务'));
}

// A8：祖传段（无 session 标注）也能被归档（跨会话宽容）
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-10 — 祖传段无标注\n\n' +
    '- [x] 老任务\n\n' +
    '> ✅ 验算通过：远古时期完成的\n');
  runHook('hooks/auto-archive.js', { session_id: 'i'.repeat(64) }, SANDBOX_ENV);
  const arc = readArchive('2026-04');
  record('A8 祖传无标注段也归档', arc.includes('祖传段无标注'));
}

// A9：归档说明段不动
{
  resetArchives();
  writeTodo(HEADER);
  runHook('hooks/auto-archive.js', { session_id: 'j'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  record('A9 归档说明段保留', cur.includes('归档说明'));
  record('A9 无完成段时不创建 archive 文件', readArchive('2026-04') === '');
}

// A10：append 模式——多次运行不重复，且新归档段追加到末尾
{
  resetArchives();
  // 第一次
  writeTodo(HEADER +
    '## 2026-04-18 — 第一批 <!-- session: kkkkkkkk -->\n\n' +
    '- [x] 完成1\n\n' +
    '> ✅ 验算通过：批1\n');
  runHook('hooks/auto-archive.js', { session_id: 'k'.repeat(64) }, SANDBOX_ENV);
  const arc1 = readArchive('2026-04');
  // 第二次：current 又出新完成段
  writeTodo(readTodo() +
    '## 2026-04-19 — 第二批 <!-- session: llllllll -->\n\n' +
    '- [x] 完成2\n\n' +
    '> ✅ 验算通过：批2\n');
  runHook('hooks/auto-archive.js', { session_id: 'l'.repeat(64) }, SANDBOX_ENV);
  const arc2 = readArchive('2026-04');
  record('A10 第一批已归档', arc1.includes('第一批'));
  record('A10 第二批 append 到同一文件', arc2.includes('第一批') && arc2.includes('第二批'));
  // 第一批不应在 archive 重复出现
  const firstBatchCount = (arc2.match(/第一批/g) || []).length;
  record('A10 第一批不重复（计 1 次）', firstBatchCount === 1, `计数=${firstBatchCount}`);
}

// A11：BYPASS 短路
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — bypass测试 <!-- session: mmmmmmmm -->\n\n' +
    '- [x] 完成\n\n' +
    '> ✅ 验算通过：x\n');
  runHook('hooks/auto-archive.js', { session_id: 'm'.repeat(64) }, { ...SANDBOX_ENV, CLAUDE_DISCIPLINE_BYPASS: '1' });
  record('A11 BYPASS=1 时不归档', readTodo().includes('bypass测试'));
}

// ============================================================================
// B：check-todo-line-count.js 三档行为
// ============================================================================
console.log('\n=== B：行数 hook 三档（≤80 静默 / 80<n≤200 软警告 / >200 硬阻断）===');

function lines(n) {
  const out = ['# 任务计划', ''];
  for (let i = 2; i < n; i++) out.push(`line ${i}`);
  return out.join('\n');
}

// B1：≤80 行静默
{
  writeTodo(lines(50));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: todoFile },
  });
  record('B1 50 行静默无输出', res.stdout.trim() === '');
}

// B2：80 < n ≤ 200 软警告（无 deny）
{
  writeTodo(lines(150));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: todoFile },
  });
  const decision = parseDecision(res.stdout);
  record('B2 150 行无 deny', decision !== 'deny');
  record('B2 150 行 stdout 含警告关键字', res.stdout.includes('150') && res.stdout.includes('归档'));
}

// B3：>200 行硬 deny
{
  writeTodo(lines(250));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: todoFile },
  });
  const decision = parseDecision(res.stdout);
  record('B3 250 行 deny', decision === 'deny');
  record('B3 deny 消息含归档操作步骤', res.stdout.includes('归档') && res.stdout.includes('已完成段'));
}

// B4：自定义硬线 env 生效
{
  writeTodo(lines(120));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: todoFile },
  }, { DISCIPLINE_TODO_HARD_LIMIT: '100' });
  record('B4 自定义硬线 100，120 行触发 deny', parseDecision(res.stdout) === 'deny');
}

// B5：BYPASS=1 完全不介入
{
  writeTodo(lines(500));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: todoFile },
  }, { CLAUDE_DISCIPLINE_BYPASS: '1' });
  record('B5 BYPASS=1 时 500 行也不 deny', res.stdout.trim() === '');
}

// B6：非 todo/current.md 文件不介入
{
  const otherFile = path.join(sandboxProject, 'foo.md');
  fs.writeFileSync(otherFile, lines(500));
  const res = runHook('hooks/check-todo-line-count.js', {
    tool_input: { file_path: otherFile },
  });
  record('B6 其它文件即使 500 行也不介入', res.stdout.trim() === '');
}

// ============================================================================
// C：与 init-project.js 配合（SessionStart 真实路径）
// ============================================================================
console.log('\n=== C：SessionStart 实际触发链 ===');

// C1：init-project + auto-archive 串行无错
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — C串行任务 <!-- session: nnnnnnnn -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：c1\n');
  const sid = 'n'.repeat(64);
  const r1 = runHook('scripts/init-project.js', { session_id: sid }, SANDBOX_ENV);
  const r2 = runHook('hooks/auto-archive.js', { session_id: sid }, SANDBOX_ENV);
  record('C1 init-project 退出码 0', r1.code === 0);
  record('C1 auto-archive 退出码 0', r2.code === 0);
  record('C1 串行后段已归档', readArchive('2026-04').includes('C串行任务'));
}

// ============================================================================
// 汇总
// ============================================================================
const passed = RESULTS.filter(r => r.passed).length;
const total = RESULTS.length;
console.log(`\n=== ${passed}/${total} 通过 ===`);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}
process.exit(passed === total ? 0 : 1);
