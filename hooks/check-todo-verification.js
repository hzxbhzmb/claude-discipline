#!/usr/bin/env node
// PostToolUse Hook: 编辑 todo/current.md 后
//   1. 检查全 [x] 段是否有 ✅ 验算通过 → 没有 → deny
//   2. 有验算行的段 → 触发三权审判（run-tribunal.js）
//      - 审判 PASS：放行（标记已写入 todo）
//      - 审判 FAIL：deny，把 doubts 抛回 Claude
//      - 审判 SHELVED：deny，告知用户裁决
if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const filePath = input?.tool_input?.file_path || '';

  if (!filePath.includes('/todo/current.md') && !filePath.includes('\\todo\\current.md')) {
    return;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return;
  }

  // === Phase 1: 检查"全 [x] 但缺验算行"的段 ===
  const lines = content.split('\n');
  const dateHeaderRe = /^## \d{4}-/;
  const uncheckedRe = /^\s*- \[ \]/;
  const checkedRe = /^\s*- \[x\]/;
  const verificationRe = /^>\s*✅\s*验算通过/;

  let currentHeader = '';
  let hasTasks = false;
  let allDone = true;
  let hasVerification = false;
  const missingSections = [];

  function checkSection() {
    if (currentHeader && hasTasks && allDone && !hasVerification) {
      missingSections.push(currentHeader);
    }
  }

  for (const line of lines) {
    if (dateHeaderRe.test(line)) {
      checkSection();
      if (line.includes('归档')) { currentHeader = ''; continue; }
      currentHeader = line;
      hasTasks = false;
      allDone = true;
      hasVerification = false;
      continue;
    }
    if (currentHeader) {
      if (uncheckedRe.test(line)) { hasTasks = true; allDone = false; }
      if (checkedRe.test(line)) { hasTasks = true; }
      if (verificationRe.test(line)) { hasVerification = true; }
    }
  }
  checkSection();

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    const reason = `🚫 以下任务段所有子任务已完成但缺少验算记录。请先执行验算（用与执行不同的路径验证达标标准），然后在该段添加 \`> ✅ 验算通过：{验算方法和结果}\`：\n${list}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    }));
    return;
  }

  // === Phase 2: 触发三权审判 ===
  const tribunalScript = path.join(__dirname, 'run-tribunal.js');
  if (!fs.existsSync(tribunalScript)) return;

  const r = spawnSync('node', [tribunalScript, filePath], {
    encoding: 'utf8',
    env: { ...process.env },
    // 注意：这里**不**设 CLAUDE_DISCIPLINE_BYPASS=1，因为 run-tribunal 本身需要走其逻辑；
    // 但 run-tribunal 内部 spawn claude -p 时会自己设 bypass。
  });

  let tribunalResult;
  try {
    tribunalResult = JSON.parse(r.stdout);
  } catch (e) {
    process.stderr.write(`⚠️ run-tribunal.js 输出无法解析：${r.stdout}\n${r.stderr}\n`);
    return;
  }

  if (tribunalResult.audited === 0) return; // 没有需要审的段

  if (tribunalResult.verdict === 'PASS') {
    // 不输出 deny，但通过 stderr 给一个友好提示让主 Claude 知道审判通过了
    process.stderr.write(`✅ 三权审判通过：${tribunalResult.passed} 段\n`);
    return;
  }

  // FAIL 或 SHELVED → deny
  const failedDetails = tribunalResult.details.filter(d => d.verdict !== 'PASS');
  const shelved = failedDetails.filter(d => d.verdict === 'SHELVED');
  const failed = failedDetails.filter(d => d.verdict === 'FAIL');

  let reason = '🚫 三权审判未通过：\n';
  if (failed.length > 0) {
    reason += '\n以下段被复核者/审计者判 FAIL，请阅读 todo 中的失败原因并修复后重新写入验算行：\n';
    failed.forEach(d => { reason += `  - ${d.section}（${d.stage} 阶段失败）\n`; });
  }
  if (shelved.length > 0) {
    reason += `\n以下段已连续失败 ${tribunalResult.shelved} 次被搁置，需要用户裁决：\n`;
    shelved.forEach(d => { reason += `  - ${d.section}\n`; });
    reason += '请告知用户审判结果，等待用户决定如何处理。\n';
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
});
