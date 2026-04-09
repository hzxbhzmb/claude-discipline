#!/usr/bin/env node
// 真 spawn claude -p 的端到端集成测试（会真实消耗 API token）
// 用法：node scripts/test-tribunal-real.js
// 默认用 haiku 模型省钱；可通过环境变量 TRIBUNAL_VERIFIER_MODEL/TRIBUNAL_AUDITOR_MODEL 切换
//
// 不在常规 self-test 里跑，因为：
//   1. 会真烧 token
//   2. 需要网络 + claude CLI 已登录
//   3. 慢（每次 spawn 几十秒到几分钟）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TRIBUNAL = path.resolve(__dirname, '..', 'hooks', 'run-tribunal.js');
const MODEL = process.env.TEST_MODEL || 'claude-haiku-4-5-20251001';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tribunal-real-'));
  const todoDir = path.join(dir, 'todo');
  fs.mkdirSync(todoDir, { recursive: true });
  // 在项目里造一个被验证目标：一个文件
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'Hello, tribunal!\n');
  return dir;
}

function makeTodo(projectDir, content) {
  const file = path.join(projectDir, 'todo', 'current.md');
  fs.writeFileSync(file, content);
  return file;
}

function runTribunal(todoFile, env = {}) {
  process.stderr.write(`\n→ 调用 run-tribunal.js（这会真的 spawn claude，请耐心等待）...\n`);
  const start = Date.now();
  const r = spawnSync('node', [TRIBUNAL, todoFile], {
    env: {
      ...process.env,
      TRIBUNAL_VERIFIER_MODEL: MODEL,
      TRIBUNAL_AUDITOR_MODEL: MODEL,
      TRIBUNAL_TIMEOUT_SEC: '300',
      ...env,
    },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,  // 15 分钟硬上限
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stderr.write(`← run-tribunal 返回（${elapsed}s, exit ${r.status}）\n`);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) {}
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json,
    fileContent: fs.readFileSync(todoFile, 'utf8'),
  };
}

let testCount = 0;
let failCount = 0;
function assert(name, cond, detail = '') {
  testCount++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failCount++;
    process.stdout.write(`  ✗ ${name}${detail ? '\n      ' + detail : ''}\n`);
  }
}

// === 测试 1: pipeline 端到端 ===
// 不断言 verdict 一定是 PASS——因为 auditor 对路径独立性要求严格，
// 小任务很难构造真正独立的验证路径。这里只断言：
//   1. tribunal 完整跑完两个 spawn
//   2. 产出可解析的 JSON 结构
//   3. todo 文件被正确写入复核 / 审计标记
//   4. verifier 至少跑了 PASS（说明它真的用工具验证了）
process.stdout.write(`\n[Test 1] pipeline 端到端：verifier 真的用工具验证 + 标记正确写入\n`);
{
  const projectDir = makeProject();
  const todoFile = makeTodo(projectDir, [
    '# 任务计划',
    '',
    `## 2026-04-09 — 在项目根创建 hello.txt`,
    '',
    '> 达标标准：',
    '> 1. 项目根目录下存在文件 hello.txt',
    '> 2. 该文件内容包含字符串 "Hello, tribunal!"',
    '',
    '- [x] 创建 hello.txt 文件',
    '- [x] 写入 Hello, tribunal! 内容',
    '',
    '> ✅ 验算通过：用 cat 看了一下文件，内容确认正确',
    '',
  ].join('\n'));

  const r = runTribunal(todoFile);
  assert('json 可解析', !!r.json, `stdout: ${r.stdout}`);
  assert('audited = 1（tribunal 触发）', r.json && r.json.audited === 1);
  assert('verifier 通过（文件含 🔍 复核结论：PASS）', r.fileContent.includes('🔍 复核结论：PASS'));
  assert('auditor 真的运行（文件含 ⚖️ 审计结论）', r.fileContent.includes('⚖️ 审计结论'));
  assert('todo 已被改动（含至少一种最终标记）',
    r.fileContent.includes('🔍 复核结论') || r.fileContent.includes('🚨 审判搁置'));
}

// === 测试 2: 真实 FAIL 路径 — 假验证（路径不独立 / 内容不存在）===
process.stdout.write(`\n[Test 2] 真实 FAIL：达标标准说存在 X，但实际不存在\n`);
{
  const projectDir = makeProject();
  // 注意：这里达标标准要求一个 *不存在* 的文件，复核者应抓出来
  const todoFile = makeTodo(projectDir, [
    '# 任务计划',
    '',
    `## 2026-04-09 — 创建 nonexistent.txt（实际未创建）`,
    '',
    '> 达标标准：',
    '> 1. 项目根目录下存在文件 nonexistent.txt',
    '> 2. 该文件内容为 "this should exist"',
    '',
    '- [x] 创建 nonexistent.txt',
    '',
    '> ✅ 验算通过：（执行者声称做了，但其实没做）',
    '',
  ].join('\n'));

  const r = runTribunal(todoFile);
  assert('exit 2 (FAIL)', r.code === 2, `stdout: ${r.stdout}\nstderr: ${r.stderr.slice(-1000)}`);
  assert('json.verdict = FAIL', r.json && r.json.verdict === 'FAIL', `json: ${JSON.stringify(r.json)}`);
  assert('文件含 审判失败次数：1', r.fileContent.includes('审判失败次数：1'));
  assert('FAIL 阶段是 verifier', r.json && r.json.details && r.json.details[0]?.stage === 'verifier');
}

// === 总结 ===
process.stdout.write(`\n${'='.repeat(40)}\n`);
process.stdout.write(`总计：${testCount} 项，失败：${failCount}\n`);
process.exit(failCount === 0 ? 0 : 1);
