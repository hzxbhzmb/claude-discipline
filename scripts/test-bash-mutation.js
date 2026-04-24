#!/usr/bin/env node
// check-bash-mutation.js 的单元测试（反向路径）
//
// 用法：node scripts/test-bash-mutation.js
// 退出码：0 = 全部通过；非 0 = 有用例失败
//
// 测试策略：spawn hook 子进程 + stdin 喂 JSON + 断言退出码和 permissionDecision

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
const HOOK = path.join(ROOT, 'hooks', 'check-bash-mutation.js');

function record(name, passed, detail = '') {
  RESULTS.push({ name, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function runHook(input, env = {}) {
  const res = cp.spawnSync('node', [HOOK], {
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
  } catch (e) {
    return null;
  }
}

// 沙箱：临时 project dir
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-mutation-test-'));
fs.mkdirSync(path.join(sandbox, 'todo'), { recursive: true });
const ENV_BASE = { CLAUDE_PROJECT_DIR: sandbox };

const SID_FULL = '586ed928abcdefghijklmnop';
const SID_SHORT = '586ed928';

function writeTodo(content) {
  fs.writeFileSync(path.join(sandbox, 'todo', 'current.md'), content);
}

// 有授权段的 todo 模板
const TODO_WITH_AUTH = `# 任务计划

---

## 2026-04-24 — 测试任务 <!-- session: ${SID_SHORT} -->

**用户意图**：测试

> ✅ 执行授权：测试通过

- [ ] 子任务
`;

// 无授权段（只建了段、没授权）
const TODO_NO_AUTH = `# 任务计划

---

## 2026-04-24 — 测试任务 <!-- session: ${SID_SHORT} -->

**用户意图**：测试

**AI 理解**：...

> 🤝 待用户确认

- [ ] 子任务
`;

// 本会话没建段（只有祖传段）
const TODO_NO_MY_SECTION = `# 任务计划

---

## 2026-04-20 — 别人的任务 <!-- session: otherses -->

> ✅ 执行授权：别人的任务

## 2026-04-21 — 祖传段

没有标注。
`;

function bashInput(command, { withSession = true } = {}) {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    session_id: withSession ? SID_FULL : '',
  };
}

// ============================================================
// 分组 1：mutation 命令 + 无授权 → deny
// ============================================================
console.log('\n=== 分组 1：mutation 命令 + 无授权段 → deny ===');

writeTodo(TODO_NO_AUTH);

[
  ['A: mv a b', 'mv a b'],
  ['B: cp src dst', 'cp src dst'],
  ['C: rm -rf foo', 'rm -rf foo'],
  ['D: sed -i inplace', `sed -i 's/x/y/' file`],
  ['E: sed -i.bak', `sed -i.bak 's/x/y/' file`],
  ['F: awk -i inplace', `awk -i inplace '{print}' file`],
  ['G: perl -i', `perl -i -pe 's/x/y/' file`],
  ['H: redirect >', `echo hello > file.txt`],
  ['I: redirect >>', `echo hello >> file.txt`],
  ['J: tee', `echo x | tee file.txt`],
  ['K: git reset --hard', `git reset --hard HEAD`],
  ['L: git clean -fd', `git clean -fd`],
  ['M: git checkout --', `git checkout -- file.txt`],
  ['N: git restore', `git restore file.txt`],
  ['O: git rm', `git rm file.txt`],
  ['P: git mv', `git mv a b`],
  ['Q: 复合命令 ls && mv', `ls && mv a b`],
  ['R: 复合命令 echo; rm', `echo x; rm foo`],
  ['S: sudo rm', `sudo rm foo`],
].forEach(([name, command]) => {
  const { stdout, code } = runHook(bashInput(command), ENV_BASE);
  const decision = parseDecision(stdout);
  record(name, decision === 'deny', `exit=${code} decision=${decision}`);
});

// ============================================================
// 分组 2：mutation 命令 + 有授权段 → 放行
// ============================================================
console.log('\n=== 分组 2：mutation 命令 + 授权段存在 → 放行 ===');

writeTodo(TODO_WITH_AUTH);

[
  ['T: mv a b（已授权）', 'mv a b'],
  ['U: rm foo（已授权）', 'rm foo'],
  ['V: sed -i（已授权）', `sed -i 's/x/y/' file`],
  ['W: redirect >（已授权）', `echo hello > file.txt`],
  ['X: git reset --hard（已授权）', `git reset --hard HEAD`],
].forEach(([name, command]) => {
  const { stdout, code } = runHook(bashInput(command), ENV_BASE);
  record(name, code === 0 && !stdout.trim(), `exit=${code} stdout=${JSON.stringify(stdout)}`);
});

// ============================================================
// 分组 3：只读命令 / 边界命令 / 不拦命令 → 放行（即使无授权）
// ============================================================
console.log('\n=== 分组 3：只读/边界/不拦命令 → 无授权也放行 ===');

writeTodo(TODO_NO_AUTH);

[
  ['Y: ls -la', 'ls -la'],
  ['Z: cat file', 'cat file'],
  ['AA: grep pattern file', 'grep pattern file'],
  ['AB: find . -name x', 'find . -name x'],
  ['AC: git status', 'git status'],
  ['AD: git log', 'git log'],
  ['AE: git diff', 'git diff'],
  ['AF: git commit', `git commit -m 'x'`],
  ['AG: git push', 'git push origin main'],
  ['AH: git fetch', 'git fetch'],
  ['AI: touch file', 'touch file'],
  ['AJ: mkdir dir', 'mkdir dir'],
  ['AK: chmod +x file', 'chmod +x file'],
  ['AL: ln -s a b', 'ln -s a b'],
  ['AM: redirect to /dev/null', 'cat file > /dev/null'],
  ['AN: fd 复制 2>&1', 'cmd 2>&1'],
  ['AO: 管道纯读', 'cat file | grep x | head'],
].forEach(([name, command]) => {
  const { stdout, code } = runHook(bashInput(command), ENV_BASE);
  record(name, code === 0 && !stdout.trim(), `exit=${code} stdout=${JSON.stringify(stdout)}`);
});

// ============================================================
// 分组 4：本会话没建段 → deny
// ============================================================
console.log('\n=== 分组 4：本会话没建段 → deny ===');

writeTodo(TODO_NO_MY_SECTION);

{
  const { stdout, code } = runHook(bashInput('mv a b'), ENV_BASE);
  const decision = parseDecision(stdout);
  record('AP: mv（本会话无段）', decision === 'deny', `exit=${code} decision=${decision}`);
}

// ============================================================
// 分组 5：bypass env → 放行（无论命令、无论有无授权）
// ============================================================
console.log('\n=== 分组 5：CLAUDE_DISCIPLINE_BYPASS=1 → 放行 ===');

writeTodo(TODO_NO_AUTH);

{
  const { stdout, code } = runHook(bashInput('rm -rf /'), { ...ENV_BASE, CLAUDE_DISCIPLINE_BYPASS: '1' });
  record('AQ: rm + BYPASS=1', code === 0 && !stdout.trim(), `exit=${code} stdout=${JSON.stringify(stdout)}`);
}

// ============================================================
// 分组 6：非 Bash 工具（虽然 hooks.json 只挂 Bash，但防御性跳过）
// ============================================================
console.log('\n=== 分组 6：非 Bash 工具 → 不处理 ===');

writeTodo(TODO_NO_AUTH);

{
  const input = { tool_name: 'Edit', tool_input: { file_path: '/foo', old_string: 'a', new_string: 'b' }, session_id: SID_FULL };
  const { stdout, code } = runHook(input, ENV_BASE);
  record('AR: Edit 工具不处理', code === 0 && !stdout.trim(), `exit=${code} stdout=${JSON.stringify(stdout)}`);
}

// ============================================================
// 分组 7：todo 不存在 → 放行（init 未跑的项目不阻断）
// ============================================================
console.log('\n=== 分组 7：todo/current.md 不存在 → 放行 ===');

{
  const noTodoSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-mutation-notodo-'));
  const env = { CLAUDE_PROJECT_DIR: noTodoSandbox };
  const { stdout, code } = runHook(bashInput('mv a b'), env);
  record('AS: todo 不存在', code === 0 && !stdout.trim(), `exit=${code} stdout=${JSON.stringify(stdout)}`);
}

// ============================================================
// 分组 8：单元级 isMutation 导出函数
// ============================================================
console.log('\n=== 分组 8：isMutation 判定函数直测 ===');

const { isMutation } = require('../hooks/check-bash-mutation.js');

[
  ['AT: mv → true', 'mv a b', true],
  ['AU: ls → false', 'ls -la', false],
  ['AV: echo > f → true', 'echo x > f', true],
  ['AW: cat > /dev/null → false', 'cat a > /dev/null', false],
  ['AX: 2>&1 → false', 'cmd 2>&1', false],
  ['AY: ls && mv → true', 'ls && mv a b', true],
  ['AZ: ls || rm → true', 'ls || rm foo', true],
  ['BA: git commit → false', `git commit -m 'x'`, false],
  ['BB: git reset --hard → true', 'git reset --hard', true],
  ['BC: git reset --soft → false', 'git reset --soft HEAD~1', false],
  ['BD: sed 无 -i → false', `sed 's/x/y/' file`, false],
  ['BE: echo "mv x" 段首是 echo → false（不误报）', `echo "mv x"`, false],
  ['BF: 分号在引号内仍切分 → 误报 true（文档化限制：简易 split 不识别引号）', `echo "; mv a b"`, true],
  ['BG: tee -a 追加模式 → true', `cmd | tee -a file`, true],
].forEach(([name, command, expected]) => {
  const actual = isMutation(command);
  record(name, actual === expected, `isMutation(${JSON.stringify(command)})=${actual}, expected=${expected}`);
});

// ============================================================
// 汇总
// ============================================================
const passed = RESULTS.filter(r => r.passed).length;
const failed = RESULTS.filter(r => !r.passed).length;
console.log(`\n=== 结果：${passed}/${RESULTS.length} 通过，${failed} 失败 ===`);

// 清理沙箱
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}

process.exit(failed === 0 ? 0 : 1);
