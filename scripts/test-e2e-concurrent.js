#!/usr/bin/env node
// 端到端并发验证：起一个临时项目，模拟两个 Claude Code 会话并发走完整任务生命周期
//
// 用法：node scripts/test-e2e-concurrent.js
//
// 每个"模拟会话"做这些事（互相交错）：
//   1. SessionStart → 跑 init-project.js（并行）
//   2. 向 todo/current.md 追加带本会话 session 标注的任务段 + 执行授权（并发 Edit）
//   3. 改一个源文件（触发 PreToolUse check-handshake.js）
//   4. 勾掉自己的子任务 [x]
//   5. 写本会话的 `> ✅ 验算通过`
// 断言：两会话互不覆盖、各 hook 按会话过滤、Write 整覆盖被拒

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function rec(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

function runHook(rel, input, env = {}) {
  const res = cp.spawnSync('node', [path.join(ROOT, rel)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}
function runHookAsync(rel, input, env = {}) {
  return new Promise(resolve => {
    const child = cp.spawn('node', [path.join(ROOT, rel)], {
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify(input));
  });
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision || null; }
  catch { return null; }
}

// 模拟 Edit 工具：读文件，把 old 替换为 new，写回。old 未找到 → 失败。
function simulateEdit(filePath, oldStr, newStr) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(oldStr)) throw new Error('Edit failed: old_string not found');
  const nc = content.replace(oldStr, newStr);
  fs.writeFileSync(filePath, nc);
  return nc;
}

// 写证据日志条目（模拟 log-tool-call.js 的副作用）
function logEvidence(sandboxTmp, sessionId, entry) {
  const f = path.join(sandboxTmp, `claude-evidence-${sessionId}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

// ========================================================================
// 建沙箱：临时项目目录 + 临时 tmpdir
// ========================================================================
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-e2e-'));
const sandboxTmp = path.join(sandbox, 'tmp');
const sandboxProject = path.join(sandbox, 'project');
fs.mkdirSync(sandboxTmp, { recursive: true });
fs.mkdirSync(path.join(sandboxProject, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandboxProject, 'src', 'app.js'), '// original\n');
const ENV = { TMPDIR: sandboxTmp, CLAUDE_PROJECT_DIR: sandboxProject };

const SID_A = 'aaaaaaaa11111111';
const SID_B = 'bbbbbbbb22222222';
const SHORT_A = SID_A.slice(0, 8);
const SHORT_B = SID_B.slice(0, 8);
const todoPath = path.join(sandboxProject, 'todo', 'current.md');

console.log(`沙箱项目：${sandboxProject}`);
console.log(`A shortId=${SHORT_A}  B shortId=${SHORT_B}\n`);

(async () => {
  // ======== 1. 并发跑两个 SessionStart init ========
  console.log('=== 1. 并发 SessionStart（两个会话同时 init） ===');
  const [initA, initB] = await Promise.all([
    runHookAsync('scripts/init-project.js', { session_id: SID_A }, ENV),
    runHookAsync('scripts/init-project.js', { session_id: SID_B }, ENV),
  ]);
  rec('1a A 的 stdout 含自己短 ID', initA.stdout.includes(SHORT_A));
  rec('1b B 的 stdout 含自己短 ID', initB.stdout.includes(SHORT_B));
  rec('1c A 的 stdout 不包含 B 的短 ID（不串）', !initA.stdout.includes(SHORT_B));
  rec('1d B 的 stdout 不包含 A 的短 ID（不串）', !initB.stdout.includes(SHORT_A));
  rec('1e current.md 被 init 创建', fs.existsSync(todoPath));

  // 两会话都有若干工作证据（模拟已经干了些活）
  logEvidence(sandboxTmp, SID_A, { tool: 'Read', target: '/src/app.js', type: 'read' });
  logEvidence(sandboxTmp, SID_B, { tool: 'Read', target: '/src/app.js', type: 'read' });
  rec('1f A 证据日志存在', fs.existsSync(path.join(sandboxTmp, `claude-evidence-${SID_A}.jsonl`)));
  rec('1g B 证据日志存在', fs.existsSync(path.join(sandboxTmp, `claude-evidence-${SID_B}.jsonl`)));

  // 再跑一次 A 的 init，模拟 A 意外重启——B 的日志不应被清空
  await runHookAsync('scripts/init-project.js', { session_id: SID_A }, ENV);
  rec('1h A 重新 init 后 B 的日志仍在', fs.existsSync(path.join(sandboxTmp, `claude-evidence-${SID_B}.jsonl`)));
  rec('1i A 重新 init 后 A 的日志已清', !fs.existsSync(path.join(sandboxTmp, `claude-evidence-${SID_A}.jsonl`)));
  logEvidence(sandboxTmp, SID_A, { tool: 'Read', target: '/src/app.js', type: 'read' });

  // ======== 2. A 和 B 并发追加任务段（各自带 session 标注 + 授权） ========
  console.log('\n=== 2. 两会话并发 Edit current.md 各自追加任务段 ===');

  const tail = '---\n'; // init 写入的 current.md 末尾锚点
  const secA = `## 2026-04-18 — A 的任务 <!-- session: ${SHORT_A} -->\n\n**用户意图**：A 要做的事\n**AI 理解**：验算方案：读 src/app.js 确认改动\n\n> ✅ 执行授权：ok\n\n**达标标准**：app.js 含 A 改动\n\n- [ ] A 子任务 1\n\n`;
  const secB = `## 2026-04-18 — B 的任务 <!-- session: ${SHORT_B} -->\n\n**用户意图**：B 要做的事\n**AI 理解**：验算方案：读 src/app.js 确认改动\n\n> ✅ 执行授权：ok\n\n**达标标准**：app.js 含 B 改动\n\n- [ ] B 子任务 1\n\n`;

  // 并发调度：两个 Promise 同时发起 Edit；一个必然先赢，另一个会看到文件已变
  const editResults = await Promise.allSettled([
    new Promise(resolve => setImmediate(() => {
      try { simulateEdit(todoPath, tail, tail + secA); resolve('A ok'); }
      catch (e) { resolve('A fail:' + e.message); }
    })),
    new Promise(resolve => setImmediate(() => {
      try { simulateEdit(todoPath, tail, tail + secB); resolve('B ok'); }
      catch (e) { resolve('B fail:' + e.message); }
    })),
  ]);
  const [rA, rB] = editResults.map(r => r.value || r.reason);
  // 至少一个成功；另一个如果失败应是 old_string 不匹配（乐观锁效果）——这是期望行为
  console.log(`  A 的 Edit 结果: ${rA}`);
  console.log(`  B 的 Edit 结果: ${rB}`);

  // 如果一方 Edit 失败（这就是 Edit 的乐观锁保护），重试
  let curr = fs.readFileSync(todoPath, 'utf8');
  if (!curr.includes(`session: ${SHORT_A}`)) {
    simulateEdit(todoPath, tail, tail + secA);
  }
  if (!curr.includes(`session: ${SHORT_B}`)) {
    // 重试时的 old_string 要用新的末尾锚点（上一段末尾）
    const content = fs.readFileSync(todoPath, 'utf8');
    fs.writeFileSync(todoPath, content + secB);
  }

  curr = fs.readFileSync(todoPath, 'utf8');
  rec('2a 最终 current.md 含 A 的段', curr.includes(`session: ${SHORT_A}`));
  rec('2b 最终 current.md 含 B 的段', curr.includes(`session: ${SHORT_B}`));
  rec('2c 两段都不丢（双方内容完整）',
    curr.includes('A 子任务 1') && curr.includes('B 子任务 1'));

  // 把对 current.md 的 write 事件也记到各自证据日志（PostToolUse log-tool-call.js 行为）
  logEvidence(sandboxTmp, SID_A, { tool: 'Edit', target: todoPath, type: 'write' });
  logEvidence(sandboxTmp, SID_B, { tool: 'Edit', target: todoPath, type: 'write' });

  // ======== 3. 分别对非白名单文件做 Edit → 握手检查应分别放行 ========
  console.log('\n=== 3. 握手检查：两会话分别编辑源文件都应放行 ===');
  const srcPath = path.join(sandboxProject, 'src', 'app.js');
  const hA = runHook('hooks/check-handshake.js', {
    session_id: SID_A, tool_input: { file_path: srcPath }
  }, ENV);
  const hB = runHook('hooks/check-handshake.js', {
    session_id: SID_B, tool_input: { file_path: srcPath }
  }, ENV);
  rec('3a A 握手检查：放行（自己段已授权）', decision(hA.stdout) === null);
  rec('3b B 握手检查：放行（自己段已授权）', decision(hB.stdout) === null);

  // 模拟第三个会话 C 没建段 → 拒绝
  const SID_C = 'ccccccccccccccccc';
  const hC = runHook('hooks/check-handshake.js', {
    session_id: SID_C, tool_input: { file_path: srcPath }
  }, ENV);
  rec('3c C 没建段 → deny', decision(hC.stdout) === 'deny');
  rec('3d deny 文案提 C 短 ID', hC.stdout.includes(SID_C.slice(0, 8)));

  // ======== 4. A 和 B 各自干活（改 src/app.js），写入各自证据 ========
  console.log('\n=== 4. 并发改源文件 + 写证据日志 ===');
  // A 先追加一行
  fs.writeFileSync(srcPath, fs.readFileSync(srcPath, 'utf8') + '// A\n');
  logEvidence(sandboxTmp, SID_A, { tool: 'Edit', target: srcPath, type: 'write' });
  // B 再追加一行
  fs.writeFileSync(srcPath, fs.readFileSync(srcPath, 'utf8') + '// B\n');
  logEvidence(sandboxTmp, SID_B, { tool: 'Edit', target: srcPath, type: 'write' });
  const srcContent = fs.readFileSync(srcPath, 'utf8');
  rec('4a 源文件含 A 的改动', srcContent.includes('// A'));
  rec('4b 源文件含 B 的改动', srcContent.includes('// B'));

  // ======== 5. A 勾掉自己子任务 [x]，此时 B 还没勾 ========
  console.log('\n=== 5. A 勾 [x]：verification 检查不应被 B 未完成的段连坐 ===');
  simulateEdit(todoPath, '- [ ] A 子任务 1', '- [x] A 子任务 1');
  logEvidence(sandboxTmp, SID_A, { tool: 'Edit', target: todoPath, type: 'write' });

  // 对 A 的这次编辑跑 PostToolUse check-todo-verification.js
  const vA = runHook('hooks/check-todo-verification.js', {
    session_id: SID_A, tool_input: { file_path: todoPath }
  }, ENV);
  // A 段全 [x] 无验算 → A 自己应被 deny 提示写验算；B 段 [ ] 未做完，不应该提 B
  rec('5a A 的 verification deny（自己段全 [x] 缺验算）', decision(vA.stdout) === 'deny');
  rec('5b A 的 verification 文案提 A 段', vA.stdout.includes('A 的任务'));
  rec('5c A 的 verification 文案不提 B 段（不连坐）', !vA.stdout.includes('B 的任务'));

  // 对 B（尚未勾完）跑 → B 段还有 [ ]，应放行
  const vB = runHook('hooks/check-todo-verification.js', {
    session_id: SID_B, tool_input: { file_path: todoPath }
  }, ENV);
  rec('5d B 未勾完 → verification 放行', decision(vB.stdout) === null);

  // ======== 6. A 写验算行 → 应放行 ========
  console.log('\n=== 6. A 补验算行 → 放行 ===');
  simulateEdit(
    todoPath,
    '- [x] A 子任务 1\n\n',
    '- [x] A 子任务 1\n\n> ✅ 验算通过：读 src/app.js 看到 // A\n\n'
  );
  logEvidence(sandboxTmp, SID_A, { tool: 'Edit', target: todoPath, type: 'write' });
  const vA2 = runHook('hooks/check-todo-verification.js', {
    session_id: SID_A, tool_input: { file_path: todoPath }
  }, ENV);
  rec('6a A 补验算后 verification 放行', decision(vA2.stdout) === null);

  // ======== 7. B 勾 [x] + 补验算 ========
  console.log('\n=== 7. B 勾完并补验算 ===');
  simulateEdit(todoPath, '- [ ] B 子任务 1', '- [x] B 子任务 1');
  logEvidence(sandboxTmp, SID_B, { tool: 'Edit', target: todoPath, type: 'write' });
  simulateEdit(
    todoPath,
    '- [x] B 子任务 1\n\n',
    '- [x] B 子任务 1\n\n> ✅ 验算通过：读 src/app.js 看到 // B\n\n'
  );
  logEvidence(sandboxTmp, SID_B, { tool: 'Edit', target: todoPath, type: 'write' });
  const vBfinal = runHook('hooks/check-todo-verification.js', {
    session_id: SID_B, tool_input: { file_path: todoPath }
  }, ENV);
  rec('7a B 补验算后 verification 放行', decision(vBfinal.stdout) === null);

  // ======== 7.5 升级场景：祖传进行中段被 init 自动认领 ========
  console.log('\n=== 7.5 升级零摩擦：祖传进行中段 SessionStart 自动认领 ===');
  // 构造另一个独立沙箱（与并发主测试隔离）模拟"用户升级前已有任务"
  {
    const upg = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-upg-'));
    const upgTmp = path.join(upg, 'tmp');
    const upgProj = path.join(upg, 'project');
    fs.mkdirSync(upgTmp, { recursive: true });
    fs.mkdirSync(path.join(upgProj, 'todo'), { recursive: true });
    fs.mkdirSync(path.join(upgProj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(upgProj, 'src', 'app.js'), '// x\n');
    // 预先放一个祖传进行中段（含 ✅ 执行授权 模拟用户升级前已做到一半）
    const legacy = [
      '# 任务计划', '', '## 归档说明', '', '---', '',
      '## 2026-04-15 — 用户升级前的进行中任务',
      '',
      '**AI 理解**：目标 xxx',
      '',
      '> ✅ 执行授权：ok',
      '',
      '- [ ] 未勾子任务 1',
      '- [x] 已勾子任务 2',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(upgProj, 'todo', 'current.md'), legacy);

    const SID_UPG = 'upgradesess99999';
    const SHORT_UPG = SID_UPG.slice(0, 8);
    const UPG_ENV = { TMPDIR: upgTmp, CLAUDE_PROJECT_DIR: upgProj };

    const initRes = await runHookAsync('scripts/init-project.js', { session_id: SID_UPG }, UPG_ENV);
    const after = fs.readFileSync(path.join(upgProj, 'todo', 'current.md'), 'utf8');

    rec('7.5a 升级后祖传段被改写加 session 标注',
      after.includes(`用户升级前的进行中任务 <!-- session: ${SHORT_UPG} -->`));
    rec('7.5b init stdout 含"自动认领通知"', initRes.stdout.includes('自动认领通知'));
    rec('7.5c init stdout 提及被认领的原标题',
      initRes.stdout.includes('用户升级前的进行中任务'));

    // 用户升级后第一个动作：对 src/app.js 做 Edit —— handshake 应直接放行（不需任何手工补标注）
    const hs = runHook('hooks/check-handshake.js', {
      session_id: SID_UPG,
      tool_input: { file_path: path.join(upgProj, 'src', 'app.js') },
    }, UPG_ENV);
    rec('7.5d 升级后对源文件 Edit → handshake 零动作放行', decision(hs.stdout) === null);

    // 用户升级后的勾 [x] 应该也能正常工作（自己段已经是 owned）
    simulateEdit(path.join(upgProj, 'todo', 'current.md'),
      '- [ ] 未勾子任务 1', '- [x] 未勾子任务 1');
    logEvidence(upgTmp, SID_UPG, { tool: 'Read', target: '/src/app.js', type: 'read' });
    logEvidence(upgTmp, SID_UPG, { tool: 'Edit', target: path.join(upgProj, 'todo', 'current.md'), type: 'write' });
    const vres = runHook('hooks/check-todo-verification.js', {
      session_id: SID_UPG,
      tool_input: { file_path: path.join(upgProj, 'todo', 'current.md') },
    }, UPG_ENV);
    // 现在段全勾 [x]、无验算 → 应 deny 本会话的段
    rec('7.5e 升级后把子任务勾完 → verification deny（要求补验算）',
      decision(vres.stdout) === 'deny');
    rec('7.5e deny 文案提到被认领的段',
      vres.stdout.includes('用户升级前的进行中任务'));

    try { fs.rmSync(upg, { recursive: true, force: true }); } catch {}
  }

  // ======== 8. 任一会话试图 Write 整覆盖 → 拒绝 ========
  console.log('\n=== 8. Write 整覆盖 current.md 被拒 ===');
  const wA = runHook('hooks/check-todo-write-forbidden.js', {
    tool_name: 'Write', tool_input: { file_path: todoPath }
  });
  rec('8a Write current.md → deny', decision(wA.stdout) === 'deny');

  // ======== 9. 最终状态断言 ========
  console.log('\n=== 9. 最终状态断言 ===');
  const final = fs.readFileSync(todoPath, 'utf8');
  const mustHave = [
    `session: ${SHORT_A}`, `session: ${SHORT_B}`,
    '- [x] A 子任务 1', '- [x] B 子任务 1',
    '> ✅ 验算通过：读 src/app.js 看到 // A',
    '> ✅ 验算通过：读 src/app.js 看到 // B',
  ];
  for (const s of mustHave) {
    rec(`9  current.md 含 "${s}"`, final.includes(s));
  }
  // 两验算行独立，不串
  const aVerifCount = (final.match(/看到 \/\/ A/g) || []).length;
  const bVerifCount = (final.match(/看到 \/\/ B/g) || []).length;
  rec('9z A 验算行只出现一次', aVerifCount === 1);
  rec('9z B 验算行只出现一次', bVerifCount === 1);

  // 两证据日志独立
  const aLog = fs.readFileSync(path.join(sandboxTmp, `claude-evidence-${SID_A}.jsonl`), 'utf8');
  const bLog = fs.readFileSync(path.join(sandboxTmp, `claude-evidence-${SID_B}.jsonl`), 'utf8');
  rec('9log A 日志条目 >0', aLog.trim().split('\n').length > 0);
  rec('9log B 日志条目 >0', bLog.trim().split('\n').length > 0);
  rec('9log A 日志不含 B 的 sessionId', !aLog.includes(SID_B));
  rec('9log B 日志不含 A 的 sessionId', !bLog.includes(SID_A));

  // ======== 汇总 ========
  const failed = RESULTS.filter(r => !r.ok);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`共 ${RESULTS.length} 个断言，失败 ${failed.length} 个。`);

  if (failed.length === 0) {
    console.log('✅ 端到端并发验证全部通过');
    console.log(`\n最终 current.md 内容:\n${'─'.repeat(60)}\n${final}${'─'.repeat(60)}`);
  } else {
    console.log('\n失败项：');
    for (const r of failed) console.log(`  ❌ ${r.name}`);
    console.log(`\n沙箱保留：${sandbox}（以便调试）`);
    process.exit(1);
  }

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
})();
