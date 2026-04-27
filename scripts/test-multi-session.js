#!/usr/bin/env node
// 多会话并发纪律的自动化验算脚本（反向路径）
//
// 用法：node scripts/test-multi-session.js
// 退出码：0 = 全部通过；非 0 = 有用例失败
//
// 测试策略：spawn hook 子进程 + stdin 喂 JSON + 断言 stdout 的 permissionDecision
// 为避免污染真实项目，用独立的临时项目目录 + 临时 tmpdir

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

// 跑 hook 脚本（spawn 子进程），返回 { stdout, stderr, code }
// 用于 init-project / auto-archive / check-bash-mutation 等 hooks.json 注册的入口
function runHook(relPath, input, env = {}) {
  const full = path.join(ROOT, relPath);
  const res = cp.spawnSync('node', [full], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

// 直接调子检查模块（无 spawn，更快）。模拟 spawn 风格的返回方便复用断言。
// v3.0.0 起，原本 spawn `hooks/check-*.js` 的测试改用此 helper 直接调子检查函数。
function runCheck(checkFn, input, env = {}) {
  // 模拟 _hook-runner 的 BYPASS 短路
  if (env.CLAUDE_DISCIPLINE_BYPASS === '1' || process.env.CLAUDE_DISCIPLINE_BYPASS === '1') {
    return { stdout: '', stderr: '', code: 0 };
  }
  // 设 env（含 CLAUDE_PROJECT_DIR），跑完还原
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
  // 模拟 spawn 风格的 stdout：deny → 输出 PreToolUse JSON；warn → 文本；通过 → 空
  if (result?.denied) {
    return {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }),
      stderr: '', code: 0,
    };
  }
  if (result?.warn) return { stdout: result.reason, stderr: '', code: 0 };
  return { stdout: '', stderr: '', code: 0 };
}

// 子检查模块（v3.0.0 合并入口的子检查）
const preChecks = require(path.join(ROOT, 'hooks', '_pre-checks'));
const postChecks = require(path.join(ROOT, 'hooks', '_post-checks'));

function parseDecision(stdout) {
  if (!stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout);
    return obj?.hookSpecificOutput?.permissionDecision || null;
  } catch (e) {
    return null;
  }
}

// ========================================================================
// 建独立沙箱：临时项目目录 + 临时 tmpdir 让 /tmp/claude-evidence-* 不污染真机
// ========================================================================
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-test-'));
const sandboxTmp = path.join(sandbox, 'tmp');
const sandboxProject = path.join(sandbox, 'project');
fs.mkdirSync(sandboxTmp, { recursive: true });
fs.mkdirSync(path.join(sandboxProject, 'todo'), { recursive: true });
// Node 子进程用 TMPDIR 控制 os.tmpdir() 返回值
const SANDBOX_ENV = { TMPDIR: sandboxTmp, CLAUDE_PROJECT_DIR: sandboxProject };

function resetSandboxTmp() {
  for (const f of fs.readdirSync(sandboxTmp)) {
    try { fs.unlinkSync(path.join(sandboxTmp, f)); } catch (e) {}
  }
}

function writeTodo(content) {
  fs.writeFileSync(path.join(sandboxProject, 'todo', 'current.md'), content);
}

// ========================================================================
// A：init-project.js 不应互相清空其它会话的证据日志
// ========================================================================
console.log('\n=== A：SessionStart 不互相清空证据日志 ===');

// A1：有 sessionId → 只清自己
{
  resetSandboxTmp();
  const sA = 'session-aaaaaaaa';
  const sB = 'session-bbbbbbbb';
  fs.writeFileSync(path.join(sandboxTmp, `claude-evidence-${sA}.jsonl`), '{"a":1}\n');
  fs.writeFileSync(path.join(sandboxTmp, `claude-evidence-${sB}.jsonl`), '{"b":1}\n');

  runHook('scripts/init-project.js', { session_id: sB }, SANDBOX_ENV);

  const aExists = fs.existsSync(path.join(sandboxTmp, `claude-evidence-${sA}.jsonl`));
  const bExists = fs.existsSync(path.join(sandboxTmp, `claude-evidence-${sB}.jsonl`));
  record('A1 sB 启动后 sA 日志仍在', aExists);
  record('A1 sB 启动后 sB 自己的日志被清', !bExists);
}

// A2：无 sessionId → 按 mtime 清 >24h 陈旧日志，<24h 保留
{
  resetSandboxTmp();
  const oldF = path.join(sandboxTmp, 'claude-evidence-old-session.jsonl');
  const newF = path.join(sandboxTmp, 'claude-evidence-new-session.jsonl');
  fs.writeFileSync(oldF, 'old\n');
  fs.writeFileSync(newF, 'new\n');
  // 把 old 的 mtime 改到 2 天前
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldF, twoDaysAgo, twoDaysAgo);

  runHook('scripts/init-project.js', {}, SANDBOX_ENV);

  record('A2 无 sessionId 时 >24h 日志被清', !fs.existsSync(oldF));
  record('A2 无 sessionId 时 <24h 日志保留', fs.existsSync(newF));
}

// A3：有 sessionId，但注入的 stdout 含本会话短 ID
{
  resetSandboxTmp();
  const sid = 'deadbeef12345678';
  const res = runHook('scripts/init-project.js', { session_id: sid }, SANDBOX_ENV);
  const short = sid.slice(0, 8);
  const hasShort = res.stdout.includes(short);
  const hasMarker = res.stdout.includes(`<!-- session: ${short} -->`);
  record('A3 stdout 注入本会话短 ID', hasShort);
  record('A3 stdout 含任务段标注示例', hasMarker);
}

// ========================================================================
// B：check-handshake.js / check-todo-verification.js 按会话过滤
// ========================================================================
console.log('\n=== B：Hook 按会话过滤任务段 ===');

const SID_X = 'xxxxxxxx11111111';
const SID_Y = 'yyyyyyyy22222222';
const SID_Z = 'zzzzzzzz33333333'; // 用来测试"无任何本会话段"
const SHORT_X = SID_X.slice(0, 8);
const SHORT_Y = SID_Y.slice(0, 8);

const TODO_MIXED = [
  '# 任务计划',
  '',
  '## 归档说明',
  '',
  '已完成任务按月归档。',
  '',
  '---',
  '',
  `## 2026-04-18 — X 的任务 未授权 <!-- session: ${SHORT_X} -->`,
  '',
  '**AI 理解**：...',
  '',
  '- [ ] 子任务',
  '',
  `## 2026-04-18 — Y 的任务 已授权 <!-- session: ${SHORT_Y} -->`,
  '',
  '**AI 理解**：...',
  '',
  '> ✅ 执行授权：用户确认',
  '',
  '- [ ] 子任务',
  '',
  '## 2026-04-17 — 祖传无标注段',
  '',
  '- [ ] 子任务',
  '',
].join('\n');

// B1：handshake—X 会话，X 段未授权 → 拒绝
{
  writeTodo(TODO_MIXED);
  const res = runCheck(preChecks.handshake, {
    session_id: SID_X,
    tool_input: { file_path: path.join(sandboxProject, 'src', 'app.js') },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  record('B1 X 未授权 → deny', decision === 'deny');
}

// B2：handshake—Y 会话，Y 段已授权 → 放行
{
  writeTodo(TODO_MIXED);
  const res = runCheck(preChecks.handshake, {
    session_id: SID_Y,
    tool_input: { file_path: path.join(sandboxProject, 'src', 'app.js') },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  record('B2 Y 已授权 → 放行', decision === null);
}

// B3：handshake—Z 会话没建任何段 → 拒绝并提示建段
{
  writeTodo(TODO_MIXED);
  const res = runCheck(preChecks.handshake, {
    session_id: SID_Z,
    tool_input: { file_path: path.join(sandboxProject, 'src', 'app.js') },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  const shortZ = SID_Z.slice(0, 8);
  const containsHint = res.stdout.includes(shortZ);
  record('B3 Z 无本会话段 → deny', decision === 'deny');
  record('B3 deny 文案提示 Z 短 ID', containsHint);
}

// B4：handshake—X 编辑白名单文件（比如 research/）→ 放行（白名单优先）
{
  writeTodo(TODO_MIXED);
  const res = runCheck(preChecks.handshake, {
    session_id: SID_X,
    tool_input: { file_path: path.join(sandboxProject, 'research', 'foo.md') },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  record('B4 白名单 research/ 不走握手检查', decision === null);
}

// ======== verification 验证 ========
const TODO_ALL_DONE_MIXED = [
  '# 任务计划',
  '',
  '## 归档说明',
  '',
  '---',
  '',
  `## 2026-04-18 — X 的段 全 [x] 无验算 <!-- session: ${SHORT_X} -->`,
  '',
  '> ✅ 执行授权：ok',
  '',
  '- [x] 子任务 1',
  '- [x] 子任务 2',
  '',
  `## 2026-04-18 — Y 的段 全 [x] 无验算 <!-- session: ${SHORT_Y} -->`,
  '',
  '> ✅ 执行授权：ok',
  '',
  '- [x] 子任务 1',
  '',
  '## 2026-04-17 — 祖传段 全 [x] 无验算',
  '',
  '- [x] 子任务 1',
  '',
].join('\n');

// B5：verification—X 会话 → 只提示 X 段，不提 Y 和祖传段
{
  const todoPath = path.join(sandboxProject, 'todo', 'current.md');
  writeTodo(TODO_ALL_DONE_MIXED);
  const res = runCheck(postChecks.verification, {
    session_id: SID_X,
    tool_input: { file_path: todoPath },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  const mentionsX = res.stdout.includes('X 的段');
  const mentionsY = res.stdout.includes('Y 的段');
  const mentionsLegacy = res.stdout.includes('祖传段');
  record('B5 verification X 会话 → deny', decision === 'deny');
  record('B5 deny 文案提 X 段', mentionsX);
  record('B5 deny 文案不提 Y 段（不连坐）', !mentionsY);
  record('B5 deny 文案不提祖传段（不连坐）', !mentionsLegacy);
}

// B6：verification—Z 会话（没自己的段）→ 不 deny
{
  const todoPath = path.join(sandboxProject, 'todo', 'current.md');
  writeTodo(TODO_ALL_DONE_MIXED);
  const res = runCheck(postChecks.verification, {
    session_id: SID_Z,
    tool_input: { file_path: todoPath },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  record('B6 verification Z 会话无自己段 → 放行', decision === null);
}

// B7：verification—X 段加上验算行后，应放行
{
  const todoPath = path.join(sandboxProject, 'todo', 'current.md');
  const todoWithXVerif = TODO_ALL_DONE_MIXED.replace(
    `## 2026-04-18 — X 的段 全 [x] 无验算 <!-- session: ${SHORT_X} -->\n\n> ✅ 执行授权：ok\n\n- [x] 子任务 1\n- [x] 子任务 2\n`,
    `## 2026-04-18 — X 的段 全 [x] 无验算 <!-- session: ${SHORT_X} -->\n\n> ✅ 执行授权：ok\n\n- [x] 子任务 1\n- [x] 子任务 2\n\n> ✅ 验算通过：done\n`
  );
  writeTodo(todoWithXVerif);
  const res = runCheck(postChecks.verification, {
    session_id: SID_X,
    tool_input: { file_path: todoPath },
  }, SANDBOX_ENV);
  const decision = parseDecision(res.stdout);
  record('B7 X 补验算行 → 放行', decision === null);
}

// ========================================================================
// C：禁止 Write 整覆盖 todo/current.md
// ========================================================================
console.log('\n=== C：禁止 Write 整覆盖 todo/current.md ===');

// C1：Write todo/current.md → deny
{
  const res = runCheck(preChecks.writeForbidden, {
    tool_name: 'Write',
    tool_input: { file_path: '/some/project/todo/current.md' },
  });
  record('C1 Write todo/current.md → deny', parseDecision(res.stdout) === 'deny');
}

// C2：Edit todo/current.md → 不拦
{
  const res = runCheck(preChecks.writeForbidden, {
    tool_name: 'Edit',
    tool_input: { file_path: '/some/project/todo/current.md' },
  });
  record('C2 Edit todo/current.md → 放行', parseDecision(res.stdout) === null);
}

// C3：Write 其它文件 → 不拦
{
  const res = runCheck(preChecks.writeForbidden, {
    tool_name: 'Write',
    tool_input: { file_path: '/some/project/src/app.js' },
  });
  record('C3 Write 其它路径 → 放行', parseDecision(res.stdout) === null);
}

// C4：Windows 路径 /todo/current.md 的反斜杠变体
{
  const res = runCheck(preChecks.writeForbidden, {
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\proj\\todo\\current.md' },
  });
  record('C4 Write Windows 路径也 deny', parseDecision(res.stdout) === 'deny');
}

// ========================================================================
// D：升级零摩擦——SessionStart 自动认领祖传段
// ========================================================================
console.log('\n=== D：SessionStart 自动认领祖传进行中段（升级零摩擦） ===');

const SID_ADOPT = 'adoptaaaadoptaaaa';
const SHORT_ADOPT = SID_ADOPT.slice(0, 8);

function runInitWithTodo(todoContent, sessionId) {
  resetSandboxTmp();
  writeTodo(todoContent);
  const res = runHook('scripts/init-project.js', { session_id: sessionId }, SANDBOX_ENV);
  return { res, finalTodo: fs.readFileSync(path.join(sandboxProject, 'todo', 'current.md'), 'utf8') };
}

// D1：唯一进行中祖传段 → 被认领
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-10 — 祖传进行中段',
    '', '- [ ] 祖传子任务', '',
  ].join('\n');
  const { res, finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D1 祖传段标题被加 session 标注',
    finalTodo.includes(`祖传进行中段 <!-- session: ${SHORT_ADOPT} -->`));
  record('D1 stdout 含"自动认领通知"', res.stdout.includes('自动认领通知'));
  record('D1 stdout 里引用了被认领的原标题', res.stdout.includes('2026-04-10 — 祖传进行中段'));
}

// D2：全 [x] 已完成祖传段 → 不认领
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-09 — 已完工段',
    '', '- [x] 已勾子任务', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D2 已完工段不被认领',
    !finalTodo.includes('已完工段 <!-- session:'));
}

// D3：纯空段（无 [ ] 也无 [x]）→ 不认领
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-11 — 空白段（刚起的标题）', '', '还没写子任务', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D3 无子任务的段不被认领',
    !finalTodo.includes('空白段（刚起的标题） <!-- session:'));
}

// D4：已有 session 标注的段（即使含 [ ]）→ 不认领
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-12 — 他会话的段 <!-- session: otherses -->',
    '', '- [ ] 他会话的子任务', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D4 他会话标注段不被抢夺', finalTodo.includes('<!-- session: otherses -->'));
  record('D4 本会话短 ID 不出现在该段', !finalTodo.includes(`他会话的段 <!-- session: otherses --> <!-- session: ${SHORT_ADOPT} -->`));
}

// D5：多个进行中祖传段 → 认领最后那个
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-10 — 早的进行中段', '', '- [ ] a', '',
    '## 2026-04-12 — 晚的进行中段', '', '- [ ] b', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D5 晚的段被认领', finalTodo.includes(`晚的进行中段 <!-- session: ${SHORT_ADOPT} -->`));
  record('D5 早的段保持祖传态', !finalTodo.includes(`早的进行中段 <!-- session:`));
}

// D6：归档说明段即便含 [ ] 也不被认领
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '- [ ] 某归档条目', '', '---', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  record('D6 归档段不被认领', !finalTodo.includes('归档说明 <!-- session:'));
}

// D7：认领后 handshake 应立即放行（该段含"✅ 执行授权"的话）
{
  const todo = [
    '# 任务计划', '', '## 归档说明', '', '---', '',
    '## 2026-04-10 — 进行中已授权段',
    '',
    '> ✅ 执行授权：ok',
    '',
    '- [ ] 子任务', '',
  ].join('\n');
  const { finalTodo } = runInitWithTodo(todo, SID_ADOPT);
  // 现在对非白名单文件做 handshake 检查
  const hs = runCheck(preChecks.handshake, {
    session_id: SID_ADOPT,
    tool_input: { file_path: path.join(sandboxProject, 'src', 'app.js') },
  }, SANDBOX_ENV);
  record('D7 认领后 handshake 放行', parseDecision(hs.stdout) === null);
  record('D7 final todo 确实加了本会话标注',
    finalTodo.includes(`进行中已授权段 <!-- session: ${SHORT_ADOPT} -->`));
}

// ========================================================================
// 汇总
// ========================================================================
const failed = RESULTS.filter(r => !r.passed);
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`共 ${RESULTS.length} 个断言，失败 ${failed.length} 个。`);

// 清理沙箱
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (e) {}

if (failed.length > 0) {
  console.log('\n失败项：');
  for (const r of failed) console.log(`  ❌ ${r.name}`);
  process.exit(1);
} else {
  console.log('✅ 全部通过');
  process.exit(0);
}
