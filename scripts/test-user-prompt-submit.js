#!/usr/bin/env node
// UserPromptSubmit hook 反向验证（v3.1.0+）
//
// 用法：node scripts/test-user-prompt-submit.js
// 退出码：0 = 全部通过；非 0 = 有用例失败

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'user-prompt-submit.js');
const RESULTS = [];

function record(name, passed, detail = '') {
  RESULTS.push({ name, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ups-test-'));
const sandboxProject = path.join(sandbox, 'project');
fs.mkdirSync(path.join(sandboxProject, 'todo'), { recursive: true });
const ENV_BASE = { CLAUDE_PROJECT_DIR: sandboxProject };
const todoFile = path.join(sandboxProject, 'todo', 'current.md');

function writeTodo(content) { fs.writeFileSync(todoFile, content); }

function runHook(input, env = {}) {
  const res = cp.spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env, CLAUDE_DISCIPLINE_NO_RUNTIME_LOG: '1' },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

function parseInject(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext || null;
  } catch { return null; }
}

const SID_FULL = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const SHORT_ID = SID_FULL.slice(0, 8);

const TODO_HEADER = '# 任务计划\n\n## 归档说明\n\n已完成任务按月归档。\n\n---\n\n';

// =============================================================
// 分组 A：未建本会话段 → inject 强 reminder
// =============================================================
console.log('\n=== 分组 A：未建本会话段 → inject ===');

{
  // A1：完全没有任何任务段
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '帮我重构这段代码' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('A1 无任何段 → inject 含 BLOCKING', ctx && ctx.includes('BLOCKING') && ctx.includes(`session: ${SHORT_ID}`));
}

{
  // A2：只有祖传段（无标注），不算本会话段
  const todo = TODO_HEADER + '## 2026-04-15 — 祖传任务\n\n- [ ] 子任务\n\n';
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '继续' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('A2 只有祖传段（无标注）→ 视为未建段，inject', ctx && ctx.includes('BLOCKING'));
}

{
  // A3：只有他会话段
  const todo = TODO_HEADER + '## 2026-04-28 — 他会话任务 <!-- session: ffffffff -->\n\n> ✅ 执行授权：x\n\n- [ ] 子任务\n\n';
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '帮我加一个 hook' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('A3 只有他会话段 → 视为未建段，inject', ctx && ctx.includes('BLOCKING'));
}

// =============================================================
// 分组 B：建段但无授权 → inject "等待握手"
// =============================================================
console.log('\n=== 分组 B：建段但无授权 → inject ===');

{
  const todo = TODO_HEADER + `## 2026-04-28 — 我的任务 <!-- session: ${SHORT_ID} -->\n\n**用户意图**：x\n\n- [ ] 子任务\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '继续' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('B1 建段无授权 → inject 含"执行授权"提示', ctx && ctx.includes('执行授权'));
}

// =============================================================
// 分组 C：段已授权未收尾 → 不 inject
// =============================================================
console.log('\n=== 分组 C：段已授权且未收尾 → 不打扰 ===');

{
  const todo = TODO_HEADER + `## 2026-04-28 — 我的任务 <!-- session: ${SHORT_ID} -->\n\n> ✅ 执行授权：ok\n\n- [ ] 子任务 1\n- [x] 子任务 2\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '继续干' }, ENV_BASE);
  record('C1 已授权未收尾（含 [ ]） → 不 inject', !stdout.trim(), `stdout=${JSON.stringify(stdout).slice(0, 60)}`);
}

{
  // C2：段已授权全 [x] 但还没写 ✅ 验算通过 → 视为执行中（验算阶段）
  const todo = TODO_HEADER + `## 2026-04-28 — 我的任务 <!-- session: ${SHORT_ID} -->\n\n> ✅ 执行授权：ok\n\n- [x] 子任务 1\n- [x] 子任务 2\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '继续' }, ENV_BASE);
  record('C2 已授权全 [x] 无验算 → 不 inject（执行中验算阶段）', !stdout.trim());
}

// =============================================================
// 分组 D：段已收尾 → inject "新任务请追加新段"
// =============================================================
console.log('\n=== 分组 D：段已收尾 → inject 提示新建段 ===');

{
  // D1：✅ 验算通过 收尾
  const todo = TODO_HEADER + `## 2026-04-28 — 旧任务 <!-- session: ${SHORT_ID} -->\n\n> ✅ 执行授权：ok\n\n- [x] x\n\n> ✅ 验算通过：done\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '帮我做新任务 X' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('D1 ✅ 验算通过 → inject 提示追加新段', ctx && ctx.includes('追加新任务段'));
}

{
  // D2：❌ 最终验算失败 收尾
  const todo = TODO_HEADER + `## 2026-04-28 — 失败任务 <!-- session: ${SHORT_ID} -->\n\n> ✅ 执行授权：ok\n\n- [x] x\n\n> ❌ 最终验算失败：原因\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '换方向' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('D2 ❌ 最终验算失败 → inject 提示追加新段', ctx && ctx.includes('追加新任务段'));
}

{
  // D3：快车道 ✅ 完成 收尾
  const todo = TODO_HEADER + `## 2026-04-28 — 快车道 <!-- session: ${SHORT_ID} -->\n\n> ✅ 执行授权：[快车道] x\n\n> ✅ 完成：done\n\n`;
  writeTodo(todo);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '下一个' }, ENV_BASE);
  const ctx = parseInject(stdout);
  record('D3 ✅ 完成 → inject 提示追加新段', ctx && ctx.includes('追加新任务段'));
}

// =============================================================
// 分组 E：用户消息含 BYPASS 措辞 → 不 inject
// =============================================================
console.log('\n=== 分组 E：用户 bypass 措辞 → 不打扰 ===');

{
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: 'bypass discipline 直接帮我改' }, ENV_BASE);
  record('E1 用户消息含 "bypass" → 不 inject', !stdout.trim());
}

{
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: '紧急情况，立即修' }, ENV_BASE);
  record('E2 用户消息含 "紧急" → 不 inject', !stdout.trim());
}

// =============================================================
// 分组 F：边界 / 异常 → 不 inject
// =============================================================
console.log('\n=== 分组 F：边界 / 异常 → 不 inject ===');

{
  // F1：todo 不存在
  const noTodoSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ups-notodo-'));
  const { stdout } = runHook({ session_id: SID_FULL, prompt: 'x' }, { CLAUDE_PROJECT_DIR: noTodoSandbox });
  record('F1 todo 不存在 → 不 inject', !stdout.trim());
}

{
  // F2：CLAUDE_DISCIPLINE_BYPASS=1 → runHook 短路
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: 'x' }, { ...ENV_BASE, CLAUDE_DISCIPLINE_BYPASS: '1' });
  record('F2 BYPASS=1 → 不 inject', !stdout.trim());
}

{
  // F3：sessionId 缺失 → 不 inject
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ prompt: 'x' }, ENV_BASE);
  record('F3 无 sessionId → 不 inject', !stdout.trim());
}

// =============================================================
// 分组 G：additionalContext schema
// =============================================================
console.log('\n=== 分组 G：JSON schema 正确 ===');

{
  writeTodo(TODO_HEADER);
  const { stdout } = runHook({ session_id: SID_FULL, prompt: 'x' }, ENV_BASE);
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  record('G1 stdout 是合法 JSON', parsed !== null);
  record('G2 hookSpecificOutput.hookEventName === UserPromptSubmit', parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit');
  record('G3 hookSpecificOutput.additionalContext 是非空字符串', typeof parsed?.hookSpecificOutput?.additionalContext === 'string' && parsed.hookSpecificOutput.additionalContext.length > 0);
}

// =============================================================
// 汇总
// =============================================================
const passed = RESULTS.filter(r => r.passed).length;
const failed = RESULTS.filter(r => !r.passed).length;
console.log(`\n=== 结果：${passed}/${RESULTS.length} 通过，${failed} 失败 ===`);

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
