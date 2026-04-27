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

// 直接调子检查模块（v3.0.0+，不 spawn 进程）
function runCheck(checkFn, input, env = {}) {
  if (env.CLAUDE_DISCIPLINE_BYPASS === '1' || process.env.CLAUDE_DISCIPLINE_BYPASS === '1') {
    return { stdout: '', stderr: '', code: 0 };
  }
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const ctx = {
    input,
    filePath: input?.tool_input?.file_path || '',
    sessionId: input?.session_id || '',
    toolName: input?.tool_name || '',
    command: input?.tool_input?.command || '',
    oldString: input?.tool_input?.old_string || '',
    newString: input?.tool_input?.new_string || '',
    projectDir: process.env.CLAUDE_PROJECT_DIR || '',
  };
  let result;
  try { result = checkFn(ctx); } catch (e) { result = null; }
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  if (result?.denied) {
    return {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }),
      stderr: '', code: 0,
    };
  }
  if (result?.warn) return { stdout: result.reason, stderr: '', code: 0 };
  return { stdout: '', stderr: '', code: 0 };
}

const preChecks = require(path.join(ROOT, 'hooks', '_pre-checks'));

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
// 按日读：day = "YYYY-MM-DD"，文件位于 archive/YYYY-MM/YYYY-MM-DD.md
function readArchiveDay(day) {
  const month = day.slice(0, 7);
  const f = path.join(archiveDir, month, `${day}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
// 跨整月所有日文件聚合（用于"该月任意位置"语义的断言）
function readArchiveMonth(month) {
  const dir = path.join(archiveDir, month);
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}
function resetArchives() {
  fs.rmSync(archiveDir, { recursive: true, force: true });
  fs.mkdirSync(archiveDir, { recursive: true });
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
  const arc = readArchiveDay('2026-04-18');
  record('A1 完成段从 current 移除', !cur.includes('完成的任务'));
  record('A1 完成段进入 2026-04/2026-04-18.md', arc.includes('完成的任务') && arc.includes('✅ 验算通过'));
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
  record('A2 未完成段不进归档', readArchiveMonth('2026-04') === '');
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
  const arc = readArchiveDay('2026-04-18');
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
  const arc = readArchiveDay('2026-04-18');
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
  const arc3 = readArchiveDay('2026-03-15');
  const arc4 = readArchiveDay('2026-04-18');
  record('A7 三月段进 2026-03/2026-03-15.md', arc3.includes('三月任务'));
  record('A7 四月段进 2026-04/2026-04-18.md', arc4.includes('四月任务'));
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
  const arc = readArchiveDay('2026-04-10');
  record('A8 祖传无标注段也归档', arc.includes('祖传段无标注'));
}

// A9：归档说明段不动
{
  resetArchives();
  writeTodo(HEADER);
  runHook('hooks/auto-archive.js', { session_id: 'j'.repeat(64) }, SANDBOX_ENV);
  const cur = readTodo();
  record('A9 归档说明段保留', cur.includes('归档说明'));
  record('A9 无完成段时不创建 archive 文件', readArchiveMonth('2026-04') === '');
}

// A10：append 模式——同一天多次运行，新段追加到同一日文件、不重复
{
  resetArchives();
  // 第一次：2026-04-18 段
  writeTodo(HEADER +
    '## 2026-04-18 — 第一批 <!-- session: kkkkkkkk -->\n\n' +
    '- [x] 完成1\n\n' +
    '> ✅ 验算通过：批1\n');
  runHook('hooks/auto-archive.js', { session_id: 'k'.repeat(64) }, SANDBOX_ENV);
  const arc1 = readArchiveDay('2026-04-18');
  // 第二次：又来一个 2026-04-18 段
  writeTodo(readTodo() +
    '## 2026-04-18 — 第二批 <!-- session: llllllll -->\n\n' +
    '- [x] 完成2\n\n' +
    '> ✅ 验算通过：批2\n');
  runHook('hooks/auto-archive.js', { session_id: 'l'.repeat(64) }, SANDBOX_ENV);
  const arc2 = readArchiveDay('2026-04-18');
  record('A10 第一批已归档到日文件', arc1.includes('第一批'));
  record('A10 第二批 append 到同一日文件', arc2.includes('第一批') && arc2.includes('第二批'));
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
// B：check-todo-line-count.js 现在是 PreToolUse + 白名单
//   - ≤200 行：任何 target 都允许
//   - >200 行：编辑 current.md / archive/ / 项目外路径仍允许；编辑其它项目文件被 deny
// ============================================================================
console.log('\n=== B：行数 hook PreToolUse + 白名单 ===');

function lines(n) {
  const out = ['# 任务计划', ''];
  for (let i = 2; i < n; i++) out.push(`line ${i}`);
  return out.join('\n');
}

// 给 hook 喂 PreToolUse Edit 输入，目标文件是 target
function probeLineCount(target, currentLineCount, env = {}) {
  writeTodo(lines(currentLineCount));
  return runCheck(preChecks.lineCount, {
    tool_input: { file_path: target },
  }, { ...SANDBOX_ENV, ...env });
}

const otherFile = path.join(sandboxProject, 'src', 'foo.js');
fs.mkdirSync(path.dirname(otherFile), { recursive: true });
const archiveTarget = path.join(sandboxProject, 'todo', 'archive', '2026-04', '2026-04-26.md');

// B1：current.md ≤200 行 → 编辑其它项目文件放行
{
  const res = probeLineCount(otherFile, 50);
  record('B1 50 行 / 编辑 src/foo.js → 放行', res.stdout.trim() === '');
}

// B2：current.md 150 行（≤200）→ 编辑其它项目文件放行
{
  const res = probeLineCount(otherFile, 150);
  record('B2 150 行 / 编辑 src/foo.js → 放行', res.stdout.trim() === '');
}

// B3：current.md 250 行（>200）→ 编辑其它项目文件 deny
{
  const res = probeLineCount(otherFile, 250);
  record('B3 250 行 / 编辑 src/foo.js → deny', parseDecision(res.stdout) === 'deny');
  record('B3 deny 消息含归档操作步骤', res.stdout.includes('归档') && res.stdout.includes('已完成段'));
}

// B4：current.md 250 行 → 编辑 current.md 自身仍然放行（避免归档死锁）
{
  const res = probeLineCount(todoFile, 250);
  record('B4 250 行 / 编辑 current.md 自身 → 放行（清段）', res.stdout.trim() === '');
}

// B5：current.md 250 行 → 编辑 archive/ 下文件放行（加日文件）
{
  const res = probeLineCount(archiveTarget, 250);
  record('B5 250 行 / 编辑 archive/2026-04/2026-04-26.md → 放行（加日文件）', res.stdout.trim() === '');
}

// B6：自定义硬线 env 生效
{
  const res = probeLineCount(otherFile, 120, { DISCIPLINE_TODO_HARD_LIMIT: '100' });
  record('B6 自定义硬线 100 / 120 行 / 编辑 src/foo.js → deny', parseDecision(res.stdout) === 'deny');
}

// B7：BYPASS=1 完全不介入
{
  const res = probeLineCount(otherFile, 500, { CLAUDE_DISCIPLINE_BYPASS: '1' });
  record('B7 BYPASS=1 / 500 行 / 编辑 src/foo.js → 放行', res.stdout.trim() === '');
}

// B8：项目目录外路径放行（即使超线）
{
  writeTodo(lines(500));
  const outsideFile = '/tmp/outside-project.md';
  const res = runCheck(preChecks.lineCount, {
    tool_input: { file_path: outsideFile },
  }, SANDBOX_ENV);
  record('B8 500 行 / 编辑项目外路径 → 放行', res.stdout.trim() === '');
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
  record('C1 串行后段已归档', readArchiveDay('2026-04-18').includes('C串行任务'));
}

// ============================================================================
// D：v2.4.0 按日分文件 + 月子目录的新行为
// ============================================================================
console.log('\n=== D：按日分文件 + 月子目录 ===');

// D1：同一天多段聚到同一日文件
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — D1 上午任务 <!-- session: dddd1111 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：上午\n\n' +
    '## 2026-04-18 — D1 下午任务 <!-- session: dddd2222 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：下午\n');
  runHook('hooks/auto-archive.js', { session_id: 'd'.repeat(64) }, SANDBOX_ENV);
  const arc = readArchiveDay('2026-04-18');
  record('D1 同日多段在同一文件', arc.includes('D1 上午任务') && arc.includes('D1 下午任务'));
  // 不应误生成相邻日的文件
  record('D1 不串到 2026-04-17.md', readArchiveDay('2026-04-17') === '');
  record('D1 不串到 2026-04-19.md', readArchiveDay('2026-04-19') === '');
}

// D2：跨日多段分到各自日文件
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — D2 周三 <!-- session: ddee1111 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：3\n\n' +
    '## 2026-04-19 — D2 周四 <!-- session: ddee2222 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：4\n');
  runHook('hooks/auto-archive.js', { session_id: 'e'.repeat(64) }, SANDBOX_ENV);
  const arc18 = readArchiveDay('2026-04-18');
  const arc19 = readArchiveDay('2026-04-19');
  record('D2 周三段在 2026-04-18.md', arc18.includes('D2 周三') && !arc18.includes('D2 周四'));
  record('D2 周四段在 2026-04-19.md', arc19.includes('D2 周四') && !arc19.includes('D2 周三'));
}

// D3：跨月多段进各自月子目录
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-03-31 — D3 三月底 <!-- session: ddff1111 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：3末\n\n' +
    '## 2026-04-01 — D3 四月初 <!-- session: ddff2222 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：4初\n');
  runHook('hooks/auto-archive.js', { session_id: 'f'.repeat(64) }, SANDBOX_ENV);
  const dir3 = path.join(archiveDir, '2026-03');
  const dir4 = path.join(archiveDir, '2026-04');
  record('D3 2026-03 子目录存在', fs.existsSync(dir3));
  record('D3 2026-04 子目录存在', fs.existsSync(dir4));
  record('D3 三月底段在 2026-03/2026-03-31.md', readArchiveDay('2026-03-31').includes('D3 三月底'));
  record('D3 四月初段在 2026-04/2026-04-01.md', readArchiveDay('2026-04-01').includes('D3 四月初'));
}

// D4：日文件首行是 `# YYYY-MM-DD 归档` 标题
{
  resetArchives();
  writeTodo(HEADER +
    '## 2026-04-18 — D4 标题检查 <!-- session: ddgg1111 -->\n\n' +
    '- [x] 完\n\n' +
    '> ✅ 验算通过：x\n');
  runHook('hooks/auto-archive.js', { session_id: 'g'.repeat(64) }, SANDBOX_ENV);
  const arc = readArchiveDay('2026-04-18');
  record('D4 日文件首行有日期标题', arc.startsWith('# 2026-04-18 归档'));
}

// ============================================================================
// 汇总
// ============================================================================
const passed = RESULTS.filter(r => r.passed).length;
const total = RESULTS.length;
console.log(`\n=== ${passed}/${total} 通过 ===`);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}
process.exit(passed === total ? 0 : 1);
